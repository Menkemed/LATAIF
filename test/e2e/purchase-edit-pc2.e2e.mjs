// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT PRE-RELEASE GATE — Zwei-App-E2E mit zwei echten, isolierten Anwendungen (Primary + PC2 ohne
// Datenbank), danach Sicherung und Wiederherstellung mit dem neuen Schema.
// Run: node test/e2e/purchase-edit-pc2.e2e.mjs
//
//   A  Einkäufe über den echten PC2-Befehl (purchases.create), Verkauf über invoices.create.
//   B  PC2-Maske „Edit purchase": Datum + Lieferant + Notiz; Preis/Menge; Lieferantenwechsel mit Zahlung (Bestätigung);
//      Einstandskorrektur eines verkauften Stücks (Rechnung bleibt, Artikelpreis folgt, Guthaben aus Überzahlung).
//   C  Gleichzeitige Bearbeitung (Primary speichert dazwischen → PC2 RECORD_CHANGED), verlorene Antwort (dieselbe
//      Kennung wiederholt, eine Wirkung), Zahlungsstorno, Ausweisfoto zweimal (das alte verborgen).
//   D  „Edit item": Modell und Beschreibung eines verkauften Artikels (Grund, Rechnungszeile eingefroren),
//      Fotos hinzufügen und an Platz 0 ersetzen — derselbe Artikel in Collections.
//   E  Rechte: ein Manager am PC2 — Geld gesperrt (Maske UND Primary), Notiz erlaubt.
//   F  Konsistenz: Hauptbuch ausgeglichen, Lager == Lose, AP je Lieferant == offene Beträge, Guthaben, PC2 ohne DB.
//   G  Sicherung (echter Snapshot-Host) → frischer Datenordner → echte Wiederherstellung → echte App: Bearbeitungen,
//      Korrekturbelege, aktuelle UND verborgene Ausweisfotos, Artikelfotos; ersetzte Verknüpfungen bleiben entfernt.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat oder was am EXAKTEN
// Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, ihr Datenordner und ihre Ports werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'pe-owner-' + Math.random().toString(36).slice(2);
const MGR_ID = 'pe-manager', MGR_EMAIL = 'manager.pe@lataif.com', MGR_NAME = 'PE Manager';

const RUN = join(os.tmpdir(), 'lataif-purchase-edit', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCAL = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCAL, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  aufraeumen();
  process.exit(1);
}, 100 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env,
  APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'),
  LATAIF_E2E_SYNC_PORT: String(PORT),
});
const seedCmd = (...args) => execFileSync(SEED, args, { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

async function attachOnly(cdpPort, budget = 60000, notId = null) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl && t.id !== notId);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  c.pageId = page.id;
  await c.send('Runtime.enable');
  return c;
}
async function attach(cdpPort, exe, env) {
  spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { try { if (await c.ev(`return !!(${ausdruck});`)) return true; } catch { /* Seite wechselt */ } await sleep(350); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const SHELL = 'a[href="/settings"]';
const alleOk = (r) => { const schlecht = r.filter((x) => x !== 'OK'); return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK'; };
const q = (sel) => `document.querySelector(${S(sel)})`;

// Der Beobachter am PC2: Fernaufträge und ihre Antworten, Datenbankgriffe — und EINE verlorene Antwort auf Wunsch.
const BEOBACHTER = `
  if (!window.__peInstalliert) {
  window.__peInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__dropNext = null;
  window.alert = () => {}; window.confirm = () => true;
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); let auth = ''; try { const h = (a[1] && a[1].headers) || {}; auth = h.Authorization || h.authorization || ''; } catch (e) { auth = ''; } window.__cmds.push({ op: body.op, commandId: body.commandId, url, auth }); } catch (e) { /* kein Rumpf */ }
    }
    if (body && window.__dropNext && body.op === window.__dropNext) {
      // Die Anfrage GEHT hinaus und wird am Primary ausgeführt — nur die Antwort kommt nie an.
      window.__dropNext = null;
      const r0 = await of(...a);
      try { await r0.text(); } catch (e) { /* egal */ }
      window.__answers.push({ op: body.op, commandId: body.commandId, dropped: true });
      throw new TypeError('PE: simulated lost response');
    }
    const r = await of(...a);
    if (body && body.op && !/\\.(get|list)$/.test(String(body.op))) {
      try { const j = await r.clone().json(); window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, ok: !!(j && j.ok === true), error: (j && j.error) || null, replayed: !!(j && j.value && j.value.replayed) }); }
      catch (e) { window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, unreadable: true }); }
    }
    return r;
  };
  }
`;
let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
const ALLE_CMDS = [], ALLE_ANTWORTEN = [], ALLE_TREFFER = [];
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const antworten = (c) => c.ev('return JSON.stringify(window.__answers || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
async function merke(c) {
  try { ALLE_CMDS.push(...(await kommandos(c))); ALLE_ANTWORTEN.push(...(await antworten(c))); ALLE_TREFFER.push(...(await treffer(c))); } catch { /* Seite weg */ }
  try { await c.ev('window.__cmds = []; window.__answers = []; window.__dbHits = []; return 1;'); } catch { /* Seite weg */ }
}
async function lade(c, route) {
  await merke(c);
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(p, route) { await geh(p, '/tasks'); await sleep(700); await geh(p, route); await sleep(900); }
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const fehlerText = (c) => c.ev("return [...document.querySelectorAll('[data-save-error]')].map(e=>e.textContent).join(' | ');").catch(() => '');
let primary = null, client = null;

async function syncRuhe(t = 75000) {
  const end = Date.now() + t;
  let angestossen = false;
  while (Date.now() < end) {
    await spuelen(primary);
    const offen = zahl('SELECT COUNT(*) AS n FROM sync_changelog WHERE synced = 0');
    const stand = zahl('SELECT COALESCE(MAX(last_sync_id), 0) AS m FROM sync_cursor');
    const kopf = Number(dbQ(SERVER_DB, 'SELECT COALESCE(MAX(id), 0) AS m FROM sync_changelog')[0]?.m || 0);
    if (offen === 0 && stand >= kopf) return true;
    if (!angestossen) {
      angestossen = true;
      await geh(primary, '/settings?tab=sync');
      if (await warteBis(primary, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sync Now')", 8000)) await clickText(primary, 'Sync Now');
    }
    await sleep(700);
  }
  console.log('      (sync) der Echo-Lauf des Primary kam nicht zur Ruhe');
  return false;
}

// ── Datenbank-Blick ──────────────────────────────────────────────────────────
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);
const zeile = (t, id) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE id = ?`, [id])[0] || {};
const saldo = (account, extra = '', p = []) => Math.round(zahl(`SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) AS n FROM ledger_entries WHERE account = ? ${extra}`, [account, ...p]) * 1000) / 1000;
const r3 = (x) => Math.round(Number(x) * 1000) / 1000;
const lineOf = (pid) => dbQ(BIZ_DB, 'SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid]);
const lotsOf = (pid) => dbQ(BIZ_DB, "SELECT unit_cost, qty_total, qty_remaining, acquired_at FROM stock_lots WHERE purchase_id = ? AND status != 'CANCELLED' ORDER BY id", [pid]);
const editsOf = (pid) => dbQ(BIZ_DB, 'SELECT edit_no, reason, kinds, correction_kind, edited_by FROM purchase_edits WHERE purchase_id = ? ORDER BY edit_no', [pid]);
const snapOf = (pid) => { try { return JSON.parse(String(zeile('purchases', pid).supplier_snapshot || 'null')); } catch { return null; } };
const activeLinks = (productId) => dbQ(BIZ_DB, "SELECT media_id FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order", [productId]).map((r) => String(r.media_id));
const retiredLinks = (productId) => zahl("SELECT COUNT(*) AS n FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NOT NULL", [productId]);
const masterHash = (mediaId) => String(dbQ(BIZ_DB, `SELECT g.stored_blob_hash h FROM media_objects o JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
    JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no WHERE o.media_id = ?`, [mediaId])[0]?.h || '');
const fileOnDisk = (h) => { for (const ext of ['jpg', 'jpeg', 'png', 'webp']) if (existsSync(join(MEDIA_ROOT, 'tenant-1', h.slice(0, 2), `${h}.${ext}`))) return true; return false; };

function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk) continue;
    if (daten[sp.name] !== undefined) continue;
    const t = String(sp.type || '').toUpperCase();
    daten[sp.name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k]));
}
/** Die Welt des Laufs: eine Kategorie ohne Pflichtmerkmale, zwei Lieferanten, ein Kunde. */
function seedBusiness() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'pe-cat', branch_id, name: 'PE Watch', icon: 'w', color: '#000', attributes: '[]', created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'pe-sup-a', branch_id, name: 'PE Lieferant A', phone: '+973 1700 0101', active: 1, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'pe-sup-b', branch_id, name: 'PE Lieferant B', phone: '+973 1700 0202', active: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'pe-kunde', branch_id, first_name: 'PE', last_name: 'Kunde', phone: '+973 3600 0101', created_at: now, updated_at: now });
    // Der Manager auch in der Geschäftsdatenbank (wie der Owner: users + user_branches), Rolle MANAGER.
    const a = db.prepare('SELECT u.tenant_id, u.password_hash FROM users u LIMIT 1').get() || {};
    insert(db, 'users', { id: MGR_ID, tenant_id: a.tenant_id || 'tenant-1', email: MGR_EMAIL, password_hash: a.password_hash || '!', name: MGR_NAME, active: 1, created_at: now, updated_at: now });
    insert(db, 'user_branches', { user_id: MGR_ID, branch_id, role: 'MANAGER', is_default: 1, created_at: now });
  } finally { db.close(); }
}
/** Ein Manager im Server-Konto (dieselben drei Zeilen wie der Owner, Rolle manager) — gleiches Passwort. */
function seedServerManager() {
  const db = new DatabaseSync(SERVER_DB);
  try {
    const now = new Date().toISOString();
    const o = db.prepare('SELECT u.tenant_id, u.password_hash FROM users u WHERE u.email = ?').get(OWNER_EMAIL) || {};
    insert(db, 'users', { id: MGR_ID, tenant_id: o.tenant_id || 'tenant-1', email: MGR_EMAIL, password_hash: o.password_hash, name: MGR_NAME, active: 1, created_at: now, updated_at: now });
    insert(db, 'user_branches', { user_id: MGR_ID, branch_id: 'branch-main', role: 'manager', is_default: 1, created_at: now });
    insert(db, 'server_credentials', { user_id: MGR_ID, credential_state: 'active', password_changed_at: now, provisioned_at: now, provisioned_by: 'pe-e2e-seed', classified_reason: 'pe-manager', created_at: now, updated_at: now });
  } finally { db.close(); }
}
/** Ein Fernauftrag von PC2 mit DESSEN Anmeldung, genau wie die Maske ihn schickt. */
async function sende(c, op, payload) {
  const auth = [...ALLE_CMDS, ...(await kommandos(c))].map((x) => x.auth).find(Boolean) || '';
  const url = `http://127.0.0.1:${PORT}/api/command`;
  return JSON.parse(await c.ev(`const r = await fetch(${S(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ${S(auth)} }, body: JSON.stringify({ op: ${S(op)}, commandId: crypto.randomUUID(), payload: ${S(payload)} }) }); let b = null; try { b = await r.json(); } catch (e) { b = null; } return JSON.stringify({ status: r.status, body: b });`));
}
/** Dateien (einfarbige JPEGs) in ein Datei-Feld legen — wie eine Auswahl im Dialog. `finde` liefert das Feld. */
const dateien = (c, finde, farben) => c.ev(`
  const inp = (${finde})(); if (!inp) return 'KEIN-FELD';
  const mk = async (f) => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const g = cv.getContext('2d'); g.fillStyle = f; g.fillRect(0, 0, 64, 64); g.fillStyle = '#fff'; g.fillRect(8, 8, 12, 12);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92)); return new File([b], f.replace('#', 'c') + '.jpg', { type: 'image/jpeg' }); };
  const dt = new DataTransfer(); for (const f of ${S(farben)}) dt.items.add(await mk(f));
  inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); return 'OK';`);
const ID_FELD = "() => [...document.querySelectorAll('[data-purchase-edit-page] input[type=file]')].find((i) => !i.multiple && /New ID photo/.test(i.parentElement?.parentElement?.innerText || ''))";
const FOTO_FELD = "() => [...document.querySelectorAll('input[type=file][multiple]')].find((i) => /Add Photo/.test(i.parentElement?.innerText || ''))";
const kmd = (op) => ALLE_CMDS.filter((x) => x.op === op);
const antw = (op) => ALLE_ANTWORTEN.filter((x) => x.op === op);

/** PC2: die Maske öffnen und warten, bis Sperren und Werte da sind. */
async function editSeite(pid) {
  await syncRuhe();
  client = await lade(client, `/purchases/${pid}/edit`);
  await waitFor(client, '[data-purchase-edit-page]', 45000);
  return warteBis(client, "document.querySelector('[data-purchase-edit-price]') && document.querySelector('[data-purchase-edit-price]').value !== '' && !/Checking what can be edited/.test(document.body.innerText)", 30000);
}
/** PC2: speichern und warten, bis die Detailseite steht (oder ein Fehler). */
async function speichernUndWarten(c) {
  const r = await klick(c, '[data-purchase-edit-save]');
  if (r !== 'OK') return r + ' ' + (await c.ev("return document.querySelector('[data-purchase-edit-blocker]')?.textContent || '';"));
  const fertig = await warteBis(c, "!document.querySelector('[data-purchase-edit-page]') && document.querySelector('[data-purchase-edit]')", 30000);
  if (!fertig) return 'BLEIBT:' + (await fehlerText(c));
  await spuelen(primary);
  return 'OK';
}

try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp'), join(RUN, 'backups')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  if (existsSync(WV2_DIR)) rmSync(WV2_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Setup: Primary einrichten, Welt säen, als Primary konfigurieren, PC2 verbinden ──────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) {
    await click(primary, '[data-first-run-new]');
    const alt = primary.pageId; primary.close(); await sleep(2500);
    primary = await attachOnly(APP_CDP, 90000, alt);
  }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PE Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'PE Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'PE Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
  primary.close(); primary = null;
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  seedBusiness();
  seedCmd('seed-primary', SERVER_DB);
  seedServerManager();

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 90000);
  await primary.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ } await sleep(500); }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await click(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await click(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await click(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  ok(true, 'CONNECT frischer PC2 ohne Datenbank, Anmeldung als Owner');
  await beobachterLegen();
  client = await lade(client, '/purchases');
  await waitFor(client, SHELL, 30000);

  // ── A Einkäufe über den echten PC2-Befehl, Verkauf über invoices.create ──────────────────────────
  const kauf = async (sup, datum, name, qty, preis, bezahlt) => {
    const r = await sende(client, 'purchases.create', {
      supplierId: sup, purchaseDate: datum, taxScheme: 'ZERO', notes: '', staffId: '',
      paymentAmount: bezahlt, paymentMethod: 'cash',
      lines: [{ mode: 'new', brand: 'PE', name, sku: '', categoryId: 'pe-cat', quantity: qty, unitPrice: preis,
        newProduct: { categoryId: 'pe-cat', brand: 'PE', name, sku: '', condition: 'New', attributes: {} } }],
    });
    return { id: r.status === 200 && r.body?.ok ? String(r.body.value?.purchaseId || '') || null : null, r };
  };
  const k1 = await kauf('pe-sup-a', '2026-10-20', 'Datejust PE', 1, 550, 550);
  const k2 = await kauf('pe-sup-a', '2026-10-20', 'Submariner PE', 2, 300, 0);
  const k3 = await kauf('pe-sup-a', '2026-10-21', 'Omega PE', 1, 400, 400);
  await spuelen(primary);
  const P1 = k1.id, P2 = k2.id, P3 = k3.id;
  ok(P1 && P2 && P3, `A drei Einkäufe über purchases.create (${S([k1.r.status, k2.r.status, k3.r.status])} ${S(k1.r.body).slice(0, 160)})`);
  const prod1 = String(lineOf(P1)[0]?.product_id || ''), prod2 = String(lineOf(P2)[0]?.product_id || '');
  ok(Number(lineOf(P1)[0]?.created_product) === 1 && zahl('SELECT purchase_price AS n FROM products WHERE id = ?', [prod1]) === 550,
    'A der Einkauf hat seinen Artikel angelegt (created_product=1, Einkaufspreis 550)');
  const inv = await sende(client, 'invoices.create', { customerId: 'pe-kunde', lines: [{ productId: prod1, quantity: 1, unitPrice: 700, scheme: 'auto' }], payment: { amount: 700, method: 'cash' } });
  await spuelen(primary);
  const INV = String(inv.body?.value?.invoiceId || '');
  const il1 = dbQ(BIZ_DB, 'SELECT id, purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [INV])[0] || {};
  ok(inv.status === 200 && INV && Number(il1.purchase_price_snapshot) === 550, `A Verkauf für 700 über invoices.create, Einstand 550 (${inv.status} ${S(inv.body).slice(0, 120)})`);

  // ── B1 PC2: Datum + Lieferant + Notiz an P2 (unbezahlt) ─────────────────────────────────────────
  {
    const r = [];
    if (!(await editSeite(P2))) r.push('MASKE-NICHT-BEREIT');
    r.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: falsches Datum und falscher Lieferant'));
    r.push(await setVal(client, '[data-purchase-edit-date]', '2026-10-22'));
    r.push(await setVal(client, '[data-purchase-edit-notes]', 'Lieferschein 4711'));
    r.push(await klick(client, '[data-ss-trigger="Search suppliers..."]'));
    if (!(await warteBis(client, q('[data-ss-option="pe-sup-b"]'), 10000))) r.push('KEINE-OPTION');
    r.push(await klick(client, '[data-ss-option="pe-sup-b"]'));
    await warteBis(client, q('[data-purchase-edit-preview]'), 10000);
    r.push(await speichernUndWarten(client));
    const p = zeile('purchases', P2);
    const e = editsOf(P2);
    const ap = (s) => -saldo('ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', [s]);
    ok(alleOk(r) === 'OK' && p.supplier_id === 'pe-sup-b' && String(p.purchase_date).slice(0, 10) === '2026-10-22' && p.notes === 'Lieferschein 4711'
      && lotsOf(P2).every((l) => String(l.acquired_at).slice(0, 10) === '2026-10-22')
      && e.length === 1 && /DATE/.test(e[0].kinds) && /SUPPLIER/.test(e[0].kinds) && /NOTES/.test(e[0].kinds),
    `B1 PC2: Datum 22.10., Lieferant B, Notiz; Lose datiert mit, ein Protokolleintrag (${alleOk(r)} ${S(e)})`);
    ok(r3(ap('pe-sup-a')) === 0 && r3(ap('pe-sup-b')) === 600 && snapOf(P2)?.name === 'PE Lieferant B' && (snapOf(P2)?.previousSuppliers || []).length === 1,
      `B1 Verbindlichkeit 600 von A nach B; Beleg zeigt B, A verborgen behalten (A ${ap('pe-sup-a')} / B ${ap('pe-sup-b')})`);
    await merke(client);
    ok(kmd('purchases.correct').length === 1 && antw('purchases.correct').some((a) => a.ok), 'B1 genau ein Fernauftrag purchases.correct, beantwortet');
  }

  // ── B2 PC2: Menge 2 → 3 und Preis 300 → 280 an P2 (nichts verkauft, Erfassungsfehler) ─────────────
  {
    const r = [];
    if (!(await editSeite(P2))) r.push('MASKE-NICHT-BEREIT');
    const lid = String(lineOf(P2)[0]?.id || '');
    r.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: Menge und Preis falsch erfasst'));
    r.push(await setVal(client, `[data-purchase-edit-qty="${lid}"]`, '3'));
    r.push(await setVal(client, `[data-purchase-edit-price="${lid}"]`, '280'));
    r.push(await speichernUndWarten(client));
    const l = lotsOf(P2);
    ok(alleOk(r) === 'OK' && Number(zeile('purchases', P2).total_amount) === 840 && l.length === 1 && Number(l[0].unit_cost) === 280 && Number(l[0].qty_remaining) === 3
      && zahl('SELECT quantity AS n FROM products WHERE id = ?', [prod2]) === 3 && zahl('SELECT purchase_price AS n FROM products WHERE id = ?', [prod2]) === 280,
    `B2 PC2: Summe 840, Los 3 × 280, Artikel in Collections 3 Stück zu 280 (${alleOk(r)} ${S(l)})`);
  }

  // ── B3 PC2: Lieferantenwechsel an P3 (bezahlt 400) — nur mit Bestätigung ─────────────────────────
  {
    const r = [];
    if (!(await editSeite(P3))) r.push('MASKE-NICHT-BEREIT');
    r.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: Ware kam von B'));
    r.push(await klick(client, '[data-ss-trigger="Search suppliers..."]'));
    await warteBis(client, q('[data-ss-option="pe-sup-b"]'), 10000);
    r.push(await klick(client, '[data-ss-option="pe-sup-b"]'));
    await warteBis(client, q('[data-purchase-edit-confirm-pay]'), 10000);
    const gesperrt = await client.ev("return !!document.querySelector('[data-purchase-edit-save]')?.disabled;");
    r.push(await klick(client, '[data-purchase-edit-confirm-pay]'));
    r.push(await speichernUndWarten(client));
    const pay = dbQ(BIZ_DB, "SELECT counterparty_id AS cp, ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3) AS d FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND account = 'ACCOUNTS_PAYABLE' GROUP BY counterparty_id");
    ok(alleOk(r) === 'OK' && gesperrt && zeile('purchases', P3).supplier_id === 'pe-sup-b'
      && r3(pay.find((x) => x.cp === 'pe-sup-b')?.d ?? 0) === 400 && r3(-saldo('ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', ['pe-sup-b'])) === 840,
    `B3 PC2: ohne Häkchen gesperrt; danach Lieferant B, Zahlung 400 bei B gebucht, AP B = 840 (nur P2) (${alleOk(r)} ${S(pay)})`);
  }

  // ── B4 PC2: Einstandskorrektur — P1 verkauft, Preis 550 → 500 ───────────────────────────────────
  {
    const r = [];
    if (!(await editSeite(P1))) r.push('MASKE-NICHT-BEREIT');
    const lid = String(lineOf(P1)[0]?.id || '');
    const qtyZu = await client.ev(`return !!document.querySelector('[data-purchase-edit-qty="${lid}"]')?.disabled;`);
    r.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: Einkaufspreis falsch erfasst'));
    r.push(await setVal(client, `[data-purchase-edit-price="${lid}"]`, '500'));
    await warteBis(client, q('[data-purchase-edit-preview]'), 10000);
    const vorschau = await client.ev("return document.querySelector('[data-purchase-edit-preview]')?.innerText || '';");
    const rabattZu = await client.ev("return !!document.querySelector('[data-purchase-edit-kind=\"SUPPLIER_DISCOUNT\"]')?.disabled;");
    r.push(await speichernUndWarten(client));
    const cc = dbQ(BIZ_DB, 'SELECT amount, invoice_id, economic_date, booking_date, vat_status, status FROM cost_corrections WHERE purchase_id = ?', [P1]);
    ok(alleOk(r) === 'OK' && qtyZu && rabattZu && /cost correction/.test(vorschau) && cc.length === 1 && r3(cc[0].amount) === -50 && cc[0].invoice_id === INV
      && cc[0].vat_status === 'REVIEW' && cc[0].status === 'ACTIVE',
    `B4 PC2: Menge gesperrt, Rabatt gesperrt, Vorschau nennt die Korrektur; Beleg −50 zur Rechnung, VAT zur Prüfung (${alleOk(r)} ${S(cc)})`);
    ok(Number(il1.purchase_price_snapshot) === Number(dbQ(BIZ_DB, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE id = ?', [il1.id])[0]?.purchase_price_snapshot)
      && zahl('SELECT gross_amount AS n FROM invoices WHERE id = ?', [INV]) === 700,
    'B4 die Rechnung bleibt unverändert (Einstand 550, Betrag 700)');
    ok(zahl('SELECT purchase_price AS n FROM products WHERE id = ?', [prod1]) === 500 && Number(lotsOf(P1)[0]?.unit_cost) === 500,
      'B4 Collections: der Artikel zeigt 500 (D13), das Los auch');
    ok(r3(saldo('COGS')) === 500 && r3(saldo('SUPPLIER_CREDIT')) === 50 && zahl("SELECT COALESCE(SUM(amount - used_amount), 0) AS n FROM supplier_credits WHERE status = 'OPEN'") === 50,
      `B4 Wareneinsatz 500 (550 − 50); Überzahlung 50 als Lieferantenguthaben (${saldo('COGS')} / ${saldo('SUPPLIER_CREDIT')})`);
  }

  // ── C1 Gleichzeitig: PC2 hat P2 offen, der Primary speichert dazwischen → PC2 RECORD_CHANGED ───────
  {
    const r = [];
    if (!(await editSeite(P2))) r.push('MASKE-NICHT-BEREIT');
    r.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: PC2 später'));
    r.push(await setVal(client, '[data-purchase-edit-notes]', 'PC2-Notiz'));
    // Der Primary öffnet dieselbe Maske und speichert zuerst (lokaler Weg, runOnPrimary).
    await gehFrisch(primary, `/purchases/${P2}/edit`);
    await waitFor(primary, '[data-purchase-edit-notes]', 30000);
    await warteBis(primary, "document.querySelector('[data-purchase-edit-notes]')?.value === 'Lieferschein 4711'", 15000);
    r.push(await setVal(primary, '[data-purchase-edit-reason]', 'e2e: Primary zuerst'));
    r.push(await setVal(primary, '[data-purchase-edit-notes]', 'Primary-Notiz'));
    r.push(await klick(primary, '[data-purchase-edit-save]'));
    const primDone = await warteBis(primary, "!document.querySelector('[data-purchase-edit-page]')", 30000);
    await spuelen(primary);
    const revNachPrimary = Number(zeile('purchases', P2).revision);
    r.push(await klick(client, '[data-purchase-edit-save]'));
    const nein = await warteBis(client, q('[data-save-error]'), 20000);
    const text = await fehlerText(client);
    await spuelen(primary);
    ok(alleOk(r) === 'OK' && primDone && nein && /changed since you opened it|RECORD_CHANGED/.test(text) && zeile('purchases', P2).notes === 'Primary-Notiz'
      && Number(zeile('purchases', P2).revision) === revNachPrimary && editsOf(P2).length === 3,
    `C1 Primary speichert zuerst, PC2 bekommt RECORD_CHANGED, nichts überschrieben (${alleOk(r)} „${text.slice(0, 90)}")`);
    // Neu laden und noch einmal: jetzt gegen die neue Fassung — geht durch.
    const r2 = [];
    if (!(await editSeite(P2))) r2.push('MASKE-NICHT-BEREIT');
    r2.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: PC2 nach dem Neuladen'));
    r2.push(await setVal(client, '[data-purchase-edit-notes]', 'PC2-Notiz'));
    r2.push(await speichernUndWarten(client));
    ok(alleOk(r2) === 'OK' && zeile('purchases', P2).notes === 'PC2-Notiz' && editsOf(P2).length === 4
      && editsOf(P2).map((e) => e.edited_by).includes('user-owner'),
    `C1 nach dem Neuladen speichert PC2 (${alleOk(r2)} ${editsOf(P2).length} Einträge)`);
  }

  // ── C2 Verlorene Antwort: purchases.update an P3, die Antwort geht verloren — der zweite Klick wiederholt ──
  {
    const r = [];
    if (!(await editSeite(P3))) r.push('MASKE-NICHT-BEREIT');
    const vor = editsOf(P3).length;
    r.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: Notiz'));
    r.push(await setVal(client, '[data-purchase-edit-notes]', 'nach verlorener Antwort'));
    await client.ev("window.__dropNext = 'purchases.update'; return 1;");
    r.push(await klick(client, '[data-purchase-edit-save]'));
    const offen = await warteBis(client, q('[data-save-error]'), 20000);
    await spuelen(primary);
    const nachVerlust = editsOf(P3).length;
    r.push(await speichernUndWarten(client));
    await merke(client);
    const upd = kmd('purchases.update');
    const letzte = upd.slice(-2);
    const wdh = antw('purchases.update').slice(-1)[0] || {};
    ok(alleOk(r) === 'OK' && offen && nachVerlust === vor + 1 && editsOf(P3).length === vor + 1 && zeile('purchases', P3).notes === 'nach verlorener Antwort'
      && letzte.length === 2 && letzte[0].commandId === letzte[1].commandId && wdh.replayed === true,
    `C2 der Primary speicherte einmal; die Wiederholung mit DERSELBEN Kennung ist eine Wiederholung, keine zweite Wirkung (${alleOk(r)} ${vor}→${editsOf(P3).length} replayed=${wdh.replayed})`);
  }

  // ── C3 Zahlung stornieren an P1 (PC2, Owner) ─────────────────────────────────────────────────────
  {
    const r = [];
    await syncRuhe();
    client = await lade(client, `/purchases/${P1}`);
    const payId = String(dbQ(BIZ_DB, 'SELECT id FROM purchase_payments WHERE purchase_id = ?', [P1])[0]?.id || '');
    if (!(await warteBis(client, q(`[data-purchase-payment-void="${payId}"]`), 30000))) r.push('KEIN-VOID');
    r.push(await klick(client, `[data-purchase-payment-void="${payId}"]`));
    await warteBis(client, q('[data-purchase-void-reason]'), 10000);
    r.push(await setVal(client, '[data-purchase-void-reason]', 'e2e: Betrag falsch erfasst'));
    r.push(await klick(client, '[data-purchase-void-confirm]'));
    const zu = await warteBis(client, "!document.querySelector('[data-purchase-void-reason]')", 20000);
    await spuelen(primary);
    const pay = zeile('purchase_payments', payId);
    const p = zeile('purchases', P1);
    ok(alleOk(r) === 'OK' && zu && pay.voided_at && pay.void_reason === 'e2e: Betrag falsch erfasst' && Number(p.paid_amount) === 0 && Number(p.remaining_amount) === 500 && p.status === 'UNPAID'
      && r3(saldo('SUPPLIER_CREDIT')) === 0 && r3(saldo('CASH', "AND source_module = 'PURCHASE_PAYMENT'")) === -400,
    `C3 Zahlung 550 storniert (Zeile bleibt), Einkauf offen 500, Guthaben aufgelöst, Kasse nur noch P3 (${alleOk(r)} ${p.status})`);
  }

  // ── C3b v0.8.94 Zahlungsdatum berichtigen (PC2, Owner): dieselbe Zahlung, der richtige Tag, keine Doppelbuchung ──
  {
    const r = [];
    const k4 = await kauf('pe-sup-a', '2026-10-22', 'Rolex PE4', 1, 600, 200);
    await spuelen(primary);
    const P4 = k4.id;
    const payId = String(dbQ(BIZ_DB, 'SELECT id FROM purchase_payments WHERE purchase_id = ?', [P4])[0]?.id || '');
    const vorPay = zeile('purchase_payments', payId);
    const vorKopf = zeile('purchases', P4);
    const quelle = (id) => dbQ(BIZ_DB, "SELECT account, direction, ROUND(amount, 3) AS a, substr(occurred_at, 1, 10) AS d, reverses_entry_id FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND source_id = ? ORDER BY rowid", [id]);
    const lebend = (id) => dbQ(BIZ_DB, `SELECT e1.account, e1.direction, ROUND(e1.amount, 3) AS a, substr(e1.occurred_at, 1, 10) AS d FROM ledger_entries e1
      WHERE e1.source_module = 'PURCHASE_PAYMENT' AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) ORDER BY e1.account`, [id]);
    const vorAp = saldo('ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', ['pe-sup-a']);
    const vorKasse = saldo('CASH');
    ok(P4 && vorPay.paid_at === '2026-10-22' && S(lebend(payId).map((x) => x.d)) === S(['2026-10-22', '2026-10-22']),
      `C3b SETUP Einkauf P4 mit Zahlung 200 bar am 22.10. (${S(lebend(payId))})`);
    await syncRuhe();
    client = await lade(client, `/purchases/${P4}`);
    if (!(await warteBis(client, q(`[data-purchase-payment-date="${payId}"]`), 30000))) r.push('KEIN-EDIT-DATE');
    r.push(await klick(client, `[data-purchase-payment-date="${payId}"]`));
    await warteBis(client, q('[data-purchase-payment-date-input]'), 10000);
    r.push(await setVal(client, '[data-purchase-payment-date-input]', '2026-10-24'));
    r.push(await setVal(client, '[data-purchase-payment-date-reason]', 'e2e: Kontoauszug sagt 24.10.'));
    await sleep(300);
    r.push(await klick(client, '[data-purchase-payment-date-confirm]'));
    const zu = await warteBis(client, "!document.querySelector('[data-purchase-payment-date-input]')", 20000);
    await spuelen(primary);
    const pay = zeile('purchase_payments', payId);
    const kopf = zeile('purchases', P4);
    await merke(client);
    const auftraege = kmd('purchases.correct_payment_date');
    ok(alleOk(r) === 'OK' && zu && auftraege.length === 1,
      `C3b PC2: „Edit date" schickt EINEN Auftrag purchases.correct_payment_date (${alleOk(r)} ${auftraege.length})`);
    ok(pay.paid_at === '2026-10-24' && pay.id === vorPay.id && Number(pay.amount) === 200 && pay.method === 'cash' && pay.created_at === vorPay.created_at && !pay.voided_at,
      `C3b dieselbe Zahlung (Kennung, 200, bar, Erfassung), Tag jetzt 24.10. (${S(pay)})`);
    ok(kopf.paid_amount === vorKopf.paid_amount && kopf.remaining_amount === vorKopf.remaining_amount && kopf.status === vorKopf.status,
      `C3b Einkauf: bezahlt ${kopf.paid_amount}, offen ${kopf.remaining_amount}, ${kopf.status} — unverändert`);
    const alle = quelle(payId);
    const heute = new Date().toISOString().slice(0, 10);
    ok(S(lebend(payId)) === S([{ account: 'ACCOUNTS_PAYABLE', direction: 'DEBIT', a: 200, d: '2026-10-24' }, { account: 'CASH', direction: 'CREDIT', a: 200, d: '2026-10-24' }])
      && alle.length === 6 && alle.filter((x) => x.reverses_entry_id).length === 2 && alle.filter((x) => x.reverses_entry_id).every((x) => x.d === heute),
      `C3b Hauptbuch: EINE lebende Buchung am 24.10., die alte heute gegengebucht — keine Doppelbuchung (${alle.length} Zeilen)`);
    ok(saldo('ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', ['pe-sup-a']) === vorAp && saldo('CASH') === vorKasse,
      `C3b Salden Lieferant (AP) und Kasse unverändert (${vorAp} / ${vorKasse})`);
    ok(zahl("SELECT COUNT(*) AS n FROM purchase_payments WHERE purchase_id = ? AND paid_at = '2026-10-24'", [P4]) === 1
      && zahl("SELECT COUNT(*) AS n FROM purchase_payments WHERE purchase_id = ?", [P4]) === 1,
      'C3b Banking (liest purchase_payments.paid_at): genau eine Bewegung, jetzt am 24.10.');
    ok(zahl("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND field_name = 'paid_at' AND changed_by = 'user-owner'", [payId]) === 1
      && zahl("SELECT COUNT(*) AS n FROM purchase_edits WHERE purchase_id = ? AND kinds = 'PAYMENT_DATE' AND reason = 'e2e: Kontoauszug sagt 24.10.'", [P4]) === 1,
      'C3b protokolliert: Audit (paid_at, Benutzer von PC2) und Verlauf des Einkaufs mit Grund');
    await geh(primary, `/purchases/${P4}`);
    const anzeige = await warteBis(primary, `(document.querySelector('[data-purchase-payment="${payId}"]')?.textContent || '').includes('2026-10-24')`, 30000);
    ok(anzeige, 'C3b der Primary zeigt die Zahlung am 24.10.');
  }

  // ── C4 Ausweisfoto an P1 zweimal (PC2): das erste wird verborgen aufbewahrt ─────────────────────────
  const idMedien = [];
  for (const [i, farbe] of [[1, '#aa2222'], [2, '#2222aa']]) {
    const r = [];
    if (!(await editSeite(P1))) r.push('MASKE-NICHT-BEREIT');
    r.push(await setVal(client, '[data-purchase-edit-reason]', `e2e: Ausweis ${i}`));
    r.push(await dateien(client, ID_FELD, [farbe]));
    await warteBis(client, "!document.querySelector('[data-purchase-edit-save]')?.disabled", 15000);
    r.push(await speichernUndWarten(client));
    const s = snapOf(P1) || {};
    idMedien.push(String(s.identity?.mediaId || ''));
    ok(alleOk(r) === 'OK' && !!s.identity?.mediaId && (s.identityRetired || []).length === i - 1,
      `C4 Ausweisfoto ${i}: aktuell ${s.identity?.mediaId?.slice(0, 8)}, verborgen ${(s.identityRetired || []).length} (${alleOk(r)})`);
  }
  {
    const s = snapOf(P1) || {};
    ok(s.identityRetired?.[0]?.mediaId === idMedien[0] && s.identity?.mediaId === idMedien[1] && idMedien[0] !== idMedien[1]
      && fileOnDisk(String(s.identityRetired[0].blobHash)) && fileOnDisk(String(s.identity.blobHash)),
    'C4 das alte Ausweisfoto ist verborgen aufbewahrt (Fassung + Hash, Datei da), das neue gilt');
    await syncRuhe();
    client = await lade(client, `/purchases/${P1}/edit`);
    await waitFor(client, '[data-purchase-edit-page]', 30000);
    const bilder = await warteBis(client, "document.querySelector('img[alt=\"Current ID photo\"]')", 20000);
    const zahlBilder = await client.ev("return [...document.querySelectorAll('[data-purchase-edit-page] img')].filter((i) => /ID photo/.test(i.alt)).length;");
    ok(bilder && zahlBilder === 1, `C4 die Maske zeigt am PC2 nur das aktuelle Ausweisfoto, keinen Verlauf (${zahlBilder})`);
  }

  // ── D „Edit item" (PC2): Modell, Beschreibung, Fotos am verkauften Artikel ──────────────────────────
  {
    const r = [];
    await syncRuhe();
    client = await lade(client, `/collection/${prod1}?edit=1&fromPurchase=${P1}`);
    await waitFor(client, '[data-save-product]', 45000);
    const zurueck = await exists(client, '[data-testid="back-to-purchase-edit"]');
    const preisGesperrt = await exists(client, '[data-testid="purchase-bound-price"]');
    await warteBis(client, `(${FOTO_FELD})()`, 30000);
    r.push(await setVal(client, '#field-name input', 'Datejust 41 PE'));
    r.push(await setVal(client, '[data-testid="product-edit-reason"] input', 'e2e: Modell genauer'));
    r.push(await dateien(client, FOTO_FELD, ['#cc0000', '#00aa00']));
    await warteBis(client, "document.querySelectorAll('[data-image-upload-replace]').length === 2", 15000);
    r.push(await klick(client, '[data-save-product]'));
    const fertig = await warteBis(client, "!document.querySelector('[data-save-product]')", 45000);
    if (!fertig) r.push('BLEIBT:' + (await fehlerText(client)));
    await spuelen(primary);
    const links1 = activeLinks(prod1);
    const snap = (() => { try { return JSON.parse(String(dbQ(BIZ_DB, 'SELECT product_snapshot FROM invoice_lines WHERE id = ?', [il1.id])[0]?.product_snapshot || 'null')); } catch { return null; } })();
    ok(alleOk(r) === 'OK' && zurueck && preisGesperrt && String(zeile('products', prod1).name) === 'Datejust 41 PE' && links1.length === 2 && snap?.name === 'Datejust PE',
      `D PC2: Modell geändert, 2 Fotos; die Rechnungszeile behält „Datejust PE"; EK-Preis gesperrt, Rückweg da (${alleOk(r)} ${links1.length} ${snap?.name})`);
    // Ersetzen an Platz 0: dasselbe zweite Foto bleibt, das erste wird zurückgezogen.
    const r2 = [];
    await syncRuhe();
    client = await lade(client, `/collection/${prod1}?edit=1&fromPurchase=${P1}`);
    await waitFor(client, '[data-save-product]', 45000);
    await warteBis(client, "document.querySelectorAll('[data-image-upload-replace]').length === 2", 30000);
    r2.push(await setVal(client, '[data-testid="product-edit-reason"] input', 'e2e: besseres Titelbild'));
    r2.push(await client.ev(`const b = document.querySelector('[data-image-upload-replace="0"]'); if (!b) return 'KEIN-ERSETZEN';
      const root = b.closest('.relative').parentElement.parentElement; const inp = [...root.querySelectorAll('input[type=file]')].find((i) => !i.multiple);
      if (!inp) return 'KEIN-FELD'; inp.click = () => {}; b.click(); window.__ersetzFeld = inp; return 'OK';`));
    r2.push(await dateien(client, '() => window.__ersetzFeld', ['#0000cc']));
    await sleep(800);
    r2.push(await klick(client, '[data-save-product]'));
    const fertig2 = await warteBis(client, "!document.querySelector('[data-save-product]')", 45000);
    if (!fertig2) r2.push('BLEIBT:' + (await fehlerText(client)));
    await spuelen(primary);
    const links2 = activeLinks(prod1);
    ok(alleOk(r2) === 'OK' && links2.length === 2 && links2[1] === links1[1] && links2[0] !== links1[0] && !links2.includes(links1[0]) && retiredLinks(prod1) === 1,
      `D PC2 Ersetzen an Platz 0: neues Titelbild, zweites Foto DASSELBE, das ersetzte zurückgezogen (${alleOk(r2)} ${S(links2.map((x) => x.slice(0, 6)))})`);
    await syncRuhe();
    client = await lade(client, `/collection/${prod1}`);
    const sichtbar = await warteBis(client, "/Datejust 41 PE/.test(document.body.innerText)", 30000);
    ok(sichtbar, 'D Collections am PC2 zeigt den Artikel mit dem neuen Modell');
  }

  // ── E Rechte: Manager am PC2 ──────────────────────────────────────────────────────────────────────
  {
    await merke(client);
    await client.ev("[...document.querySelectorAll('button')].find((b) => /Sign Out/.test(b.textContent))?.click(); return 1;");
    await sleep(2500);
    try { client.close(); } catch { /* zu */ }
    client = await attachOnly(CLIENT_CDP);
    await waitFor(client, 'input[type="password"]', 60000);
    await setVal(client, 'input[type="email"]', MGR_EMAIL);
    await setVal(client, 'input[type="password"]', OWNER_PW);
    await click(client, '[data-client-signin]');
    await waitFor(client, SHELL, 90000);
    ALLE_CMDS.length = 0;
    const r = [];
    if (!(await editSeite(P2))) r.push('MASKE-NICHT-BEREIT');
    const lid = String(lineOf(P2)[0]?.id || '');
    const preisZu = await client.ev(`return !!document.querySelector('[data-purchase-edit-price="${lid}"]')?.disabled;`);
    const datumZu = await client.ev("return !!document.querySelector('[data-purchase-edit-date]')?.disabled;");
    const grund = await exists(client, '[data-purchase-edit-locked="PURCHASE_EDIT_OWNER_ONLY"]');
    r.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: Manager-Notiz'));
    r.push(await setVal(client, '[data-purchase-edit-notes]', 'vom Manager'));
    r.push(await speichernUndWarten(client));
    const e = editsOf(P2).slice(-1)[0] || {};
    ok(alleOk(r) === 'OK' && preisZu && datumZu && grund && zeile('purchases', P2).notes === 'vom Manager' && e.edited_by === MGR_ID && e.kinds === 'NOTES',
      `E Manager: Preis und Datum gesperrt (mit Grund), Notiz gespeichert als ${e.edited_by} (${alleOk(r)})`);
    const vorher = { total: zeile('purchases', P2).total_amount, n: editsOf(P2).length };
    const fremd = await sende(client, 'purchases.correct', { purchaseId: P2, expectedRevision: Number(zeile('purchases', P2).revision), reason: 'Manager will Geld', lines: [{ lineId: lid, unitPrice: 1 }], correctionKind: 'ENTRY_ERROR' });
    const fremdVoid = await sende(client, 'purchases.void_payment', { purchaseId: P3, paymentId: String(dbQ(BIZ_DB, 'SELECT id FROM purchase_payments WHERE purchase_id = ?', [P3])[0]?.id || ''), expectedRevision: Number(zeile('purchases', P3).revision), reason: 'x' });
    await spuelen(primary);
    ok(fremd.status === 409 && fremd.body?.error === 'PERMISSION_DENIED' && fremdVoid.status === 409 && fremdVoid.body?.error === 'PERMISSION_DENIED'
      && zeile('purchases', P2).total_amount === vorher.total && editsOf(P2).length === vorher.n,
      `E der Primary weist purchases.correct und purchases.void_payment vom Manager ab, nichts geändert (${fremd.status} ${fremd.body?.error} / ${fremdVoid.status})`);
  }

  // ── F Konsistenz ──────────────────────────────────────────────────────────────────────────────────
  {
    await merke(client);
    await spuelen(primary);
    const tx = dbQ(BIZ_DB, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d FROM ledger_entries GROUP BY transaction_id`);
    ok(tx.length > 0 && tx.every((t) => Number(t.d) === 0), `F jede Buchung ausgeglichen (${tx.length} Transaktionen)`);
    const lose = r3(zahl("SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS n FROM stock_lots WHERE status != 'CANCELLED' AND qty_remaining > 0"));
    ok(r3(saldo('INVENTORY')) === lose, `F Lager im Hauptbuch == Restwert der Lose (${saldo('INVENTORY')} / ${lose})`);
    for (const sup of ['pe-sup-a', 'pe-sup-b']) {
      const offen = r3(zahl("SELECT COALESCE(SUM(remaining_amount), 0) AS n FROM purchases WHERE supplier_id = ? AND status != 'CANCELLED'", [sup]));
      ok(r3(-saldo('ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', [sup])) === offen, `F AP ${sup} im Hauptbuch == offene Beträge der Einkäufe (${-saldo('ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', [sup])} / ${offen})`);
    }
    ok(r3(saldo('SUPPLIER_CREDIT')) === r3(zahl("SELECT COALESCE(SUM(amount - used_amount), 0) AS n FROM supplier_credits WHERE status = 'OPEN'")), 'F Lieferantenguthaben im Hauptbuch == offene Guthaben');
    ok(r3(saldo('COGS')) === 500 && zahl("SELECT COUNT(*) AS n FROM ledger_entries WHERE source_module = 'COST_CORRECTION' AND account LIKE 'VAT%'") === 0,
      'F Wareneinsatz 500, die Korrektur berührt kein VAT-Konto');
    ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')) && ALLE_TREFFER.length === 0, 'F PC2 hat keine eigene Datenbank angelegt oder angefragt');
  }

  // ── G Sicherung → frischer Ordner → Wiederherstellung → echte App ──────────────────────────────────
  {
    await spuelen(primary);
    try { steuer?.close(); } catch { /* zu */ }
    try { client?.close(); } catch { /* zu */ }
    killTestImage('lataif-e2e-client.exe'); await waitTestImageGone('lataif-e2e-client.exe');
    try { primary?.close(); } catch { /* zu */ }
    primary = null;
    killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe'); await sleep(1500);
    const tabellen = ['purchase_edits', 'cost_corrections', 'purchases', 'purchase_lines', 'purchase_payments', 'stock_lots', 'supplier_credits', 'invoice_lines', 'ledger_entries', 'products'];
    // `products.days_in_stock` rechnet die bestehende Startroutine (updateDaysInStock) bei jedem Start aus dem
    // Einkaufsdatum neu — das ist kein Restore-Effekt und wird unten getrennt geprüft.
    const ohneLagerdauer = (rows) => rows.map(({ days_in_stock: _d, ...r }) => r);
    const teile = () => ({
      ...Object.fromEntries(tabellen.map((t) => [t, t === 'products' ? ohneLagerdauer(dbQ(BIZ_DB, 'SELECT * FROM products ORDER BY 1')) : dbQ(BIZ_DB, `SELECT * FROM ${t} ORDER BY 1`)])),
      media_links: dbQ(BIZ_DB, 'SELECT link_id, entity_id, media_id, sort_order, is_primary, deleted_at FROM media_links ORDER BY link_id'),
    });
    const bild = () => S(teile());
    /** Wo zwei Stände sich unterscheiden: Tabelle → Spalte → Anzahl Zeilen (für die Auskunft im Fehlerfall). */
    const unterschied = (a, b) => {
      const out = {};
      for (const t of Object.keys(a)) {
        const ra = a[t], rb = b[t] || [];
        if (ra.length !== rb.length) { out[t] = `Zeilen ${ra.length}→${rb.length}`; continue; }
        for (let i = 0; i < ra.length; i++) for (const k of Object.keys(ra[i])) if (S(ra[i][k]) !== S(rb[i][k])) { out[t] = out[t] || {}; out[t][k] = (out[t][k] || 0) + 1; }
      }
      return out;
    };
    const vorTeile = teile();
    const vorProdukteVoll = dbQ(BIZ_DB, 'SELECT * FROM products ORDER BY 1');
    const vor = bild();
    const s1 = snapOf(P1) || {};
    const idAkt = String(s1.identity?.blobHash || ''), idAlt = String(s1.identityRetired?.[0]?.blobHash || '');
    const fotoHashes = activeLinks(prod1).map(masterHash);
    const snapDir = join(RUN, 'backups', 'snap-pe');
    const out = seedCmd('backup', APP_DATA_DIR, snapDir, new Date().toISOString());
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    const imBackup = new Set(manifest.files.map((f) => String(f.hash)));
    ok(/^BACKUP_OK files=\d+ additional=1 status=complete$/.test(out) && manifest.additionalDbFiles?.[0]?.fileName === 'lataif_sync_server.db',
      `G Sicherung mit dem echten Snapshot-Host, beide Datenbanken (${out})`);
    ok(imBackup.has(idAkt) && imBackup.has(idAlt) && fotoHashes.every((h) => imBackup.has(h)),
      'G die Sicherung trägt das aktuelle UND das verborgene Ausweisfoto sowie beide Artikelfotos');
    ok(manifest.files.every((f) => existsSync(join(snapDir, f.relPath)) && sha256(join(snapDir, f.relPath)) === f.hash), 'G jede gesicherte Datei passt zu ihrem Hash');

    const identity = join(RUN, 'identity'); mkdirSync(identity, { recursive: true });
    const carried = readdirSync(APP_DATA_DIR, { withFileTypes: true }).filter((e) => e.isFile() && !/^lataif(_sync_server)?\.db/.test(e.name)).map((e) => e.name);
    for (const f of carried) copyFileSync(join(APP_DATA_DIR, f), join(identity, f));
    rmSync(APP_DATA_DIR, { recursive: true, force: true });
    mkdirSync(APP_DATA_DIR, { recursive: true });
    for (const f of carried) copyFileSync(join(identity, f), join(APP_DATA_DIR, f));
    ok(!existsSync(BIZ_DB) && !existsSync(SERVER_DB) && !existsSync(MEDIA_ROOT), `G frischer Datenordner — keine DB, keine Medien (Kennung übernommen: ${carried.join(', ') || 'keine'})`);
    const rout = seedCmd('restore', APP_DATA_DIR, snapDir);
    ok(/^RESTORE_OK files=\d+ status=complete$/.test(rout) && sha256(BIZ_DB) === manifest.db.sha256 && sha256(SERVER_DB) === manifest.additionalDbFiles[0].sha256,
      `G echte Wiederherstellung, beide Datenbanken byte-gleich (${rout})`);
    ok(bild() === vor, 'G Bearbeitungen, Korrekturbelege, Einkäufe, Lose, Zahlungen, Guthaben, Rechnungszeilen, Hauptbuch, Artikel und Foto-Verknüpfungen unverändert');
    ok(fileOnDisk(idAkt) && fileOnDisk(idAlt) && fotoHashes.every(fileOnDisk), 'G aktuelles und verborgenes Ausweisfoto und beide Artikelfotos liegen wieder auf der Platte');
    ok(retiredLinks(prod1) === 1 && activeLinks(prod1).length === 2, 'G das ersetzte Artikelfoto bleibt zurückgezogen — keine Reaktivierung');

    // Die echte App auf dem wiederhergestellten Stand.
    primary = await attach(APP_CDP, APP, appEnv());
    await waitInvoke(primary);
    await waitFor(primary, SHELL + ', input[type="password"], [data-first-run-gate]', 90000);
    if (await exists(primary, '[data-first-run-gate]')) ok(false, 'G nach der Wiederherstellung fragt die App erneut nach der Einrichtung');
    if (!(await exists(primary, SHELL))) {
      await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
      await setVal(primary, 'input[type="password"]', ONBOARD_PW);
      await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
    }
    await waitFor(primary, SHELL, 90000);
    await gehFrisch(primary, `/purchases/${P1}`);
    const karte = await warteBis(primary, q('[data-purchase-cost-corrections]'), 30000);
    const voided = await warteBis(primary, q('[data-purchase-payment-voided]'), 10000);
    await gehFrisch(primary, `/purchases/${P1}/edit`);
    const ausweis = await warteBis(primary, "document.querySelector('img[alt=\"Current ID photo\"]') && document.querySelector('img[alt=\"Current ID photo\"]').naturalWidth > 0", 30000);
    await gehFrisch(primary, '/reconciliation');
    const abgleich = await warteBis(primary, "document.querySelector('[data-cost-bridge-total]') && /0\\.000/.test(document.querySelector('[data-cost-bridge-total]').textContent)", 30000);
    ok(karte && voided && ausweis && abgleich, `G die wiederhergestellte App zeigt Korrekturbeleg, stornierte Zahlung, das Ausweisfoto (geprüft geladen) und den Abgleich mit Summe 0 (${S([karte, voided, ausweis, abgleich])})`);
    await spuelen(primary);
    const nachStart = bild();
    if (nachStart !== vor) console.log('      (G) nach dem Start verschieden: ' + S(unterschied(vorTeile, teile())));
    try { primary.close(); } catch { /* zu */ }
    primary = null;
    killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe'); await sleep(1500);
    ok(nachStart === vor, 'G der Start auf dem wiederhergestellten Stand ändert an Einkäufen, Belegen, Hauptbuch und Fotos nichts (außer der täglichen Lagerdauer)');
    const vollNach = dbQ(BIZ_DB, 'SELECT * FROM products ORDER BY 1');
    const nurLagerdauer = vollNach.length === vorProdukteVoll.length && vollNach.every((r, i) => Object.keys(r).every((k) => k === 'days_in_stock' || S(r[k]) === S(vorProdukteVoll[i][k])));
    ok(nurLagerdauer, `G an den Artikeln änderte der Start höchstens die Lagerdauer (days_in_stock ${S(vorProdukteVoll.map((r) => r.days_in_stock))} → ${S(vollNach.map((r) => r.days_in_stock))})`);
  }

  const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  ok(S(fremdVorher) === S(fremdNachher), 'ISOLATION fremde LATAIF-Prozesse (die Produktions-App) unberührt');
} catch (e) {
  ok(false, 'ABBRUCH: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
} finally {
  clearTimeout(WACHHUND);
  try { steuer?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { primary?.close(); } catch { /* zu */ }
  aufraeumen();
}
console.log(`\npurchase-edit-pc2 e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PURCHASE_EDIT_PC2_E2E_PROVED');
process.exit(0);
