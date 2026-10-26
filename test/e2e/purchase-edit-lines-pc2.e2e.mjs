// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT Teil 2/3 (v0.8.91) — Zwei-App-E2E mit zwei echten, isolierten Anwendungen (Primary + PC2 ohne
// Datenbank): eine Position am PC2 ENTFERNEN und einen NEUEN Artikel MIT FOTO nachtragen — der echte Medienweg
// (Foto in der Maske „New Item" → Ablage des Primary → in der Klammer gelesen → am Artikel → Ablage geräumt).
// Run: node test/e2e/purchase-edit-lines-pc2.e2e.mjs
//
//   A  Einkauf mit zwei neuen Artikeln über den echten PC2-Befehl (purchases.create).
//   B  PC2-Maske „Edit purchase": Zeile 2 entfernen, „Add new item" mit Foto (dieselbe New-Item-Maske, SKU-Vorschau),
//      Menge/Preis, speichern → EIN Fernauftrag purchases.correct mit Ablagekennung, keine Bildbytes im Rumpf.
//   C  Primary: Zeile/Los/Artikel 2 weg (Protokoll), neuer Artikel mit SKU aus dem Zähler, Foto, Los, Summe, AP, Lager == Lose,
//      die Ablage ist geräumt.
//   D  PC2-Collections zeigen den neuen Artikel, den entfernten nicht; ein verkaufter Artikel ist am PC2 nicht entfernbar.
//   E  PC2 hat keine Datenbank angefasst; fremde LATAIF-Prozesse unberührt.
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
const OWNER_PW = 'pel-owner-' + Math.random().toString(36).slice(2);
const MGR_ID = 'pe-manager', MGR_EMAIL = 'manager.pe@lataif.com', MGR_NAME = 'PE Manager';

const RUN = join(os.tmpdir(), 'lataif-purchase-edit-lines', 'run-' + Date.now());
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

  // ── Helfer dieses Laufs ─────────────────────────────────────────────────────────────────────────
  const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
  const setByLabelPrefix = (c, prefix, v) => c.ev(
    `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().startsWith(${S(prefix)})).pop();`
    + `if(!l) return 'NO-LABEL:'+${S(prefix)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
    + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)});`
    + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
  const JPEGS = "[...document.querySelectorAll('img')].filter(i=>/^data:image\\/jpeg/.test(i.src)).length";
  const TROTZDEM = "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Create anyway')";
  /** Wie viele Dateien liegen in der Ablage des Primary (Fernaufträge mit Fotos)? */
  const ablage = () => {
    const d = join(APP_DATA_DIR, 'command-staging');
    if (!existsSync(d)) return 0;
    let anzahl = 0;
    const lauf = (p) => { for (const e of readdirSync(p, { withFileTypes: true })) { if (e.isDirectory()) lauf(join(p, e.name)); else anzahl++; } };
    lauf(d);
    return anzahl;
  };
  // Der Rumpf jedes purchases.correct, wie PC2 ihn wirklich schickt (zusätzlich zum Beobachter des Gerüsts).
  const KOERPER = `
    if (!window.__pelInstalliert) {
      window.__pelInstalliert = true; window.__correctBodies = [];
      const of2 = window.fetch;
      window.fetch = async (...a) => {
        try { const url = String(a[0] && a[0].url ? a[0].url : a[0]); if (/\\/api\\/command$/.test(url)) { const b = JSON.parse((a[1] && a[1].body) || '{}'); if (b.op === 'purchases.correct') window.__correctBodies.push(JSON.stringify(b.payload)); } } catch (e) { /* kein Rumpf */ }
        return of2(...a);
      };
    }`;
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: KOERPER });

  // ── A Einkauf mit zwei neuen Artikeln über den echten PC2-Befehl ─────────────────────────────────
  const neuZeile = (name, preis) => ({
    mode: 'new', brand: 'PEL', name, sku: '', categoryId: 'pe-cat', quantity: 1, unitPrice: preis,
    newProduct: { categoryId: 'pe-cat', brand: 'PEL', name, sku: '', condition: 'New', attributes: {} },
  });
  const r0 = await sende(client, 'purchases.create', {
    supplierId: 'pe-sup-a', purchaseDate: '2026-10-20', taxScheme: 'ZERO', notes: '', staffId: '', paymentAmount: 0, paymentMethod: 'cash',
    lines: [neuZeile('Alpha PEL', 500), neuZeile('Beta PEL', 300)],
  });
  await spuelen(primary);
  const P = String(r0.body?.value?.purchaseId || '');
  const [L1, L2] = lineOf(P);
  ok(r0.status === 200 && P && L1 && L2, `A Einkauf mit zwei neuen Artikeln über purchases.create (${r0.status} ${S(r0.body).slice(0, 120)})`);
  const prodA = String(L1?.product_id || ''), prodB = String(L2?.product_id || '');

  // ── B PC2-Maske: Zeile 2 entfernen, neuen Artikel MIT FOTO nachtragen ───────────────────────────
  const r = [];
  if (!(await editSeite(P))) r.push('MASKE-NICHT-BEREIT');
  r.push(await setVal(client, '[data-purchase-edit-reason]', 'e2e: zweite Position nie geliefert, dritte vergessen'));
  r.push(await klick(client, `[data-purchase-edit-remove="${L2.id}"]`));
  if (!(await warteBis(client, q(`[data-purchase-edit-line="${L2.id}"][data-purchase-edit-removed="true"]`), 5000))) r.push('NICHT-VORGEMERKT');
  r.push(await klick(client, '[data-purchase-edit-add-new]'));
  if (!(await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='PE Watch')", 15000))) r.push('KEINE-ARTIKELMASKE');
  r.push(await clickText(client, 'PE Watch')); await sleep(400);
  r.push(await setByLabelPrefix(client, 'BRAND', 'PEL'));
  r.push(await setByLabelPrefix(client, 'NAME / MODEL', 'Gamma PEL'));
  const bilderVor = await client.ev(`return ${JPEGS};`);
  r.push(await dateien(client, FOTO_FELD, ['#2e86c1']));
  if (!(await warteBis(client, `${JPEGS} > ${bilderVor}`, 15000))) r.push('KEIN-VORSCHAUBILD');
  // v0.8.91 — die SKU-Vorschau der Maske kommt am PC2 aus dem Zähler des Primary.
  await warteBis(client, q('[data-sku-preview]'), 10000);
  const vorschauSku = String(await client.ev("return document.querySelector('[data-sku-preview]')?.getAttribute('data-sku-preview') || '';"));
  r.push(await clickIncludes(client, 'Use this Item'));
  if (await warteBis(client, TROTZDEM, 2500)) await clickText(client, 'Create anyway');
  if (!(await warteBis(client, "![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='PE Watch')", 15000))) r.push('ARTIKELMASKE-BLEIBT');
  r.push(await setVal(client, '[data-purchase-edit-add-price="1"]', '250'));
  r.push(await setVal(client, '[data-purchase-edit-add-qty="1"]', '2'));
  const vorschau = (await warteBis(client, q('[data-purchase-edit-preview]'), 10000))
    ? String(await client.ev("return document.querySelector('[data-purchase-edit-preview]').innerText;")) : '';
  ok(/1,?000\.000/.test(vorschau) && /Beta PEL/.test(vorschau) && /item itself are removed|item itself/.test(vorschau),
    `B die Vorschau zeigt die neue Summe 1000 und dass Artikel B mitgeht (${vorschau.replace(/\s+/g, ' ').slice(0, 220)})`);
  const ablageVor = ablage();
  r.push(await speichernUndWarten(client));
  await merke(client);
  const koerper = JSON.parse(await client.ev('return JSON.stringify(window.__correctBodies || []);') || '[]');
  const rumpf = koerper.length ? JSON.parse(koerper[koerper.length - 1]) : {};
  ok(alleOk(r) === 'OK' && kmd('purchases.correct').length === 1 && antw('purchases.correct').some((a) => a.ok),
    `B PC2 speichert mit EINEM Fernauftrag purchases.correct (${alleOk(r)} ${S(antw('purchases.correct'))})`);
  ok(S(rumpf.removeLineIds) === S([L2.id]) && rumpf.addLines?.length === 1 && rumpf.addLines[0].newProduct?.stagingIds?.length === 1
    && !/data:image/.test(koerper.join('')) && !('sku' in (rumpf.addLines[0].newProduct || {}) && rumpf.addLines[0].newProduct.sku),
  `B der Rumpf nennt die entfernte Zeile und den neuen Artikel mit EINER Ablagekennung — keine Bildbytes, keine Nummer (${S(rumpf).slice(0, 260)})`);

  // ── C Primary: was wirklich gespeichert ist ─────────────────────────────────────────────────────
  const zeilen = lineOf(P);
  const neu = zeilen.find((l) => l.id !== L1.id);
  ok(zeilen.length === 2 && !zeilen.some((l) => l.id === L2.id) && neu && Number(neu.quantity) === 2 && Number(neu.unit_price) === 250 && Number(neu.created_product) === 1,
    `C zwei Zeilen: Alpha und die nachgetragene (2 × 250, legt ihren Artikel an) (${S(zeilen.map((l) => [l.quantity, l.unit_price, l.created_product]))})`);
  ok(zahl('SELECT COUNT(*) AS n FROM products WHERE id = ?', [prodB]) === 0
    && zahl("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'products' AND entity_id = ? AND action_type = 'DELETE'", [prodB]) === 1
    && zahl("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'purchase_lines' AND entity_id = ? AND action_type = 'DELETE'", [L2.id]) === 1,
  'C Artikel B samt Zeile entfernt — beides im Protokoll');
  const pN = zeile('products', String(neu?.product_id || ''));
  ok(/^[A-Z]{3}-[A-Z]{3}-\d{3,}$/.test(String(pN.sku || '')) && String(pN.sku) === vorschauSku,
    `C die SKU vergibt der Primary aus seinem Zähler — dieselbe, die die Maske am PC2 angekündigt hat (${pN.sku} / ${vorschauSku})`);
  ok(/^\["data:image\/jpeg;base64,/.test(String(pN.images || '')) && pN.name === 'Gamma PEL' && pN.stock_status === 'in_stock' && Number(pN.quantity) === 2,
    `C der neue Artikel in Collections: Name, Foto aus der Ablage, im Lager, 2 Stück (${String(pN.images || '').slice(0, 40)})`);
  ok(ablage() === 0 && ablageVor >= 0, `C die Ablage des Primary ist nach dem Erfolg geräumt (${ablageVor} → ${ablage()})`);
  ok(Number(zeile('purchases', P).total_amount) === 1000 && r3(-saldo('ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', ['pe-sup-a'])) === 1000,
    `C Summe 1000, AP 1000 (${zeile('purchases', P).total_amount} / ${-saldo('ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', ['pe-sup-a'])})`);
  const lagerwert = r3(zahl("SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS n FROM stock_lots WHERE status != 'CANCELLED' AND qty_remaining > 0"));
  ok(r3(saldo('INVENTORY')) === lagerwert && lagerwert === 1000, `C Lager im Hauptbuch == Restwert der Lose == 1000 (${saldo('INVENTORY')} / ${lagerwert})`);
  ok(r3(zahl("SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) AS n FROM ledger_entries")) === 0, 'C Hauptbuch ausgeglichen');
  const e = editsOf(P);
  ok(e.length === 1 && e[0].kinds === 'REMOVE_LINE,ADD_LINE' && /zweite Position/.test(String(e[0].reason)),
    `C EIN Bearbeitungsbeleg mit Grund (${S(e)})`);

  // ── D PC2: Collections zeigen den Stand; ein verkaufter Artikel ist nicht entfernbar ─────────────
  await syncRuhe();
  client = await lade(client, '/collection');
  const gamma = await warteBis(client, "/Gamma PEL/.test(document.body.innerText)", 30000);
  const beta = await client.ev("return /Beta PEL/.test(document.body.innerText);");
  ok(gamma && !beta, `D PC2-Collections: der neue Artikel ist da, der entfernte nicht (${S([gamma, beta])})`);
  const inv = await sende(client, 'invoices.create', { customerId: 'pe-kunde', lines: [{ productId: prodA, quantity: 1, unitPrice: 700, scheme: 'auto' }], payment: { amount: 700, method: 'cash' } });
  await spuelen(primary);
  ok(inv.status === 200 && inv.body?.ok, `D Alpha über invoices.create verkauft (${inv.status})`);
  if (!(await editSeite(P))) ok(false, 'D Maske nicht bereit');
  const gesperrt = await warteBis(client, `document.querySelector('[data-purchase-edit-remove="${L1.id}"]') && document.querySelector('[data-purchase-edit-remove="${L1.id}"]').disabled`, 15000);
  const warum = String(await client.ev(`return document.querySelector('[data-purchase-edit-remove-locked="${L1.id}"]')?.innerText || '';`));
  ok(gesperrt && /untouched in stock/.test(warum), `D PC2: die verkaufte Position ist nicht entfernbar — die Maske sagt warum (${warum.slice(0, 90)})`);
  const fern = await sende(client, 'purchases.correct', { purchaseId: P, expectedRevision: Number(zeile('purchases', P).revision), reason: 'e2e: trotzdem', removeLineIds: [L1.id] });
  ok(fern.status !== 200 || fern.body?.ok !== true, `D …und auch der direkte Fernauftrag wird am Primary abgewiesen (${S(fern.body).slice(0, 120)})`);
  ok(String(S(fern.body)).includes('PURCHASE_EDIT_REMOVE_STOCK_USED') && lineOf(P).length === 2, 'D …mit der Sperre, nichts geändert');

  // ── E PC2 ohne Datenbank, Prozess-Isolation ─────────────────────────────────────────────────────
  await merke(client);
  ok(ALLE_TREFFER.length === 0, `E PC2 hat nie eine Geschäftsdatenbank angefasst (${S(ALLE_TREFFER).slice(0, 120)})`);
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
console.log(`\npurchase-edit-lines-pc2 e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PURCHASE_EDIT_LINES_PC2_E2E_PROVED');
process.exit(0);
