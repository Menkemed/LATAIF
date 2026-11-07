// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P5 (E12) — Zwei-App-E2E: Kommissionsgruppe aus Einzelstücken, in der echten Test-App.
// Run: node test/e2e/consignment-quantities-p5.e2e.mjs
//
//   A  Welt: eigener Artikel mit Einkauf über PC2.
//   B  PC2 „New Consignment" mit Quantity 4 per Tastatur (Preis je Stück) → EIN Auftrag consignments.create; Primary: 4 Stücke.
//   C  PC2 Liste „Items": Gruppe als Kopfzeile, „Select 1", Record Sale, im Dialog „Pieces to sell" 2, Preis je Stück.
//   D  Primary-Detail: Abschnitt „Group" mit allen Stücken und dem Rest.
//   E  PC2 „Direct Sale": eigener Artikel + Gruppe über 2b („group × 2 available", 2 Stücke).
//   F  Primary „Edit Invoice" (P4): ein Stück entfernen ⇒ nur dieses Stück wieder verfügbar.
//   G  Hauptbuch/Lager/AP/AR, PC2 ohne Datenbank, Prozess-Isolation.
//
// PROZESS-ISOLATION (Gerüst bulk-metal-pc2/P3): gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat
// oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client). Die installierte
// Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses, closeTestWindow, startedPids, clearTestClientPendingSaves } from './_e2e-process.mjs';
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
const OWNER_PW = 'p3-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-mixed-p5', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
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
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.events = [];
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params?.type || '')) {
        this.events.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.events.push(`exception: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || ''}`.slice(0, 400));
      }
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

async function attachOnly(cdpPort, budget = 60000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
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
/** Klick ohne Abbruch: 'OK' oder der Grund. */
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
/** Den Knopf `sel` in der Karte, die `karte` zeigt — die kleinste Umgebung mit genau diesem einen Knopf. */
const klickInKarte = (c, karte, sel) => c.ev(`const kand=[...document.querySelectorAll(${S(sel)})]; for (const x of kand) { let p=x; for(let i=0;i<12&&p;i++){ p=p.parentElement; if(!p) break; if ((p.innerText||'').includes(${S(karte)})) { if (p.querySelectorAll(${S(sel)}).length===1) { if (x.disabled) return 'DISABLED'; x.click(); return 'OK'; } break; } } } return 'NO-KARTE:'+${S(karte)};`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); }
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

// Der Beobachter: Fernaufträge, ihre Antworten, Datenbankgriffe, Kern-Aufrufe, Dialoge — und EINE
// verlorene Antwort auf Wunsch.
const BEOBACHTER = `
  if (window.__r6dInstalliert) { /* schon da */ } else {
  window.__r6dInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__invokes = []; window.__alerts = []; window.__dropNext = null;
  window.alert = (m) => { window.__alerts.push(String(m)); };
  window.confirm = () => true;
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); oe(...a); };
  const ow = console.warn;
  console.warn = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); ow(...a); };
  (function haken() {
    const t = window.__TAURI_INTERNALS__;
    if (t && t.invoke && !t.__r6d) {
      const oi = t.invoke.bind(t);
      t.invoke = (cmd, args, opts) => { window.__invokes.push(String(cmd)); return oi(cmd, args, opts); };
      t.__r6d = true;
    } else if (!t || !t.__r6d) setTimeout(haken, 30);
  })();
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); let auth = ''; try { const h = (a[1] && a[1].headers) || {}; auth = h.Authorization || h.authorization || ''; } catch (e) { auth = ''; } window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload, url, auth }); } catch (e) { /* kein lesbarer Rumpf */ }
    }
    if (body && window.__dropNext && body.op === window.__dropNext) {
      // Die Anfrage GEHT hinaus und wird am Primary ausgeführt — nur die Antwort kommt nie an.
      window.__dropNext = null;
      const r0 = await of(...a);
      try { await r0.text(); } catch (e) { /* egal */ }
      window.__answers.push({ op: body.op, commandId: body.commandId, dropped: true });
      throw new TypeError('R6D: simulated lost response');
    }
    const r = await of(...a);
    if (body && body.op && !/\\.(get|list)$/.test(String(body.op))) {
      try {
        const j = await r.clone().json();
        window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, ok: !!(j && j.ok === true), error: (j && j.error) || null, replayed: !!(j && j.value && j.value.replayed) });
      } catch (e) { window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, unreadable: true }); }
    }
    return r;
  };
  }
`;
const DIALOGE_PRIMARY = 'window.__alerts = window.__alerts || []; window.alert = (m) => { window.__alerts.push(String(m)); }; window.confirm = () => true; return 1;';

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

let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
// Datenbankgriffe und Kern-Aufrufe über ALLE Seiten des Laufs (ein Neuladen leert die Fensterlisten).
const ALLE_TREFFER = [], ALLE_AUFRUFE = [];
async function ernte(c) {
  try { ALLE_TREFFER.push(...(await treffer(c))); ALLE_AUFRUFE.push(...(await aufrufe(c))); } catch { /* Seite schon weg */ }
}
async function lade(c, route) {
  await ernte(c);
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
/** Am Primary frisch einsteigen: über eine andere Seite, damit die Zielseite neu lädt (frische Fassung). */
async function gehFrisch(p, route) {
  await geh(p, '/tasks');
  await sleep(700);
  await geh(p, route);
  await sleep(900);
}
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)) && !/^store\.|^page\.|^domain\.|^session\./.test(String(x.op)));
const antworten = (c) => c.ev('return JSON.stringify(window.__answers || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const aufrufe = (c) => c.ev('return JSON.stringify(window.__invokes || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const FEHLER_SEL = '[data-save-error],[data-gold-settle-error],[data-material-error],[data-gold-usage-error],[data-scrap-form-error]';
const fehlerText = (c, sel = FEHLER_SEL) => c.ev(`return [...document.querySelectorAll(${S(sel)})].map(e=>e.textContent).join(' | ');`).catch(() => '');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
let primary = null, client = null;

async function warteAuf(pruefe, runden = 40) {
  for (let i = 0; i < runden; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}

/**
 * Der Primary synchronisiert (Auto-LAN) mit seinem EIGENEN Sync-Server: alle 30 s schiebt er seine
 * Änderungen hoch und spielt sie als Echo wieder ein (applyUpsert → UPDATE → der Fassungs-Trigger
 * zählt +1). Das ist ein Hintergrundlauf, der mit der geprüften Buchung nichts zu tun hat — gemessen
 * im ersten Lauf: ohne Warten traf er zwischen „Seite geladen" und „Speichern" und machte die
 * gesehene Fassung alt (RECORD_CHANGED ohne fremde Änderung). Deshalb wird vor jedem Laden und vor
 * jedem Vergleich gewartet, bis der Primary nichts mehr zu schieben hat und sein Echo eingespielt ist.
 */
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
      // Nicht 30 s auf den Zeitgeber warten: derselbe Lauf über den Knopf „Sync Now" des Primary
      // (Einstellungen → Sync / Server). Nur dieser Knopf — nie „Disconnect".
      angestossen = true;
      await geh(primary, '/settings?tab=sync');
      if (await warteBis(primary, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sync Now')", 8000)) {
        await clickText(primary, 'Sync Now');
      }
    }
    await sleep(700);
  }
  console.log('      (sync) der Echo-Lauf des Primary kam nicht zur Ruhe');
  return false;
}

// ── Datenbank-Blick ──────────────────────────────────────────────────────────
const idSet = (t) => new Set(dbQ(BIZ_DB, `SELECT id FROM ${t}`).map((r) => r.id));
const neueZeilen = (t, vorher, where = '1=1', params = []) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE ${where}`, params).filter((r) => !vorher.has(r.id));
const zeile = (t, id) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE id = ?`, [id])[0] || {};
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);
const ledgerMax = () => zahl('SELECT COALESCE(MAX(rowid), 0) AS m FROM ledger_entries');
const buchungenSeit = (row) => dbQ(BIZ_DB, 'SELECT account, direction, amount, source_module, transaction_id, reverses_entry_id FROM ledger_entries WHERE rowid > ? ORDER BY rowid', [row]);
const ledgerNorm = (rows) => S(rows.map((r) => [r.account, r.direction, Math.round(Number(r.amount) * 1000), r.source_module, r.reverses_entry_id ? 'R' : '']).map((x) => S(x)).sort());
const bestand21 = () => zahl("SELECT COALESCE(SUM(weight_grams), 0) AS g FROM precious_metals WHERE metal_type = 'gold' AND status = 'in_stock' AND karat = '21K'");
const spotSilber = () => Number(dbQ(BIZ_DB, "SELECT value FROM settings WHERE key = 'spot_price.silver'")[0]?.value ?? NaN);

const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);

// ══════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P3 — die Welt des Laufs: Kategorie, Lieferant, zwei Einlieferer, Käufer, zwei eigene Artikel
// ══════════════════════════════════════════════════════════════════════════════
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'p3-cat', branch_id, name: 'P3 Watch', icon: 'w', color: '#000', attributes: '[]', created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'p3-sup', branch_id, name: 'P3 Lieferant', phone: '+973 1700 0333', active: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'p3-con-a', branch_id, first_name: 'Con', last_name: 'Alpha', phone: '+973 3600 0301', created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'p3-con-b', branch_id, first_name: 'Con', last_name: 'Beta', phone: '+973 3600 0302', created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'p3-kunde', branch_id, first_name: 'P3', last_name: 'Kunde', phone: '+973 3600 0303', created_at: now, updated_at: now });
    // Zwei eigene Artikel (Lagerware): Datejust (Margin, Plan 2.500) und Goldkette (VAT 10 %, Plan 600 netto).
    for (const [id, name, scheme, plan] of [['p3-own-1', 'Datejust P3', 'MARGIN', 2500], ['p3-own-2', 'Goldkette P3', 'VAT_10', 600]]) {
      insert(db, 'products', { id, branch_id, category_id: 'p3-cat', brand: 'P3', name, sku: 'P3-' + id, quantity: 0, condition: 'Pre-Owned',
        scope_of_delivery: '[]', purchase_price: 0, purchase_currency: 'BHD', planned_sale_price: plan, stock_status: 'in_stock', tax_scheme: scheme,
        days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
    }
  } finally { db.close(); }
}
const lotRow = (no) => dbQ(BIZ_DB, "SELECT * FROM stock_lots WHERE unit = 'mg' AND lot_no = ?", [no])[0] || {};
const movesOf = (lotId) => dbQ(BIZ_DB, 'SELECT * FROM bulk_lot_movements WHERE lot_id = ? ORDER BY seq', [lotId]);
const konto = (acc) => zahl("SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0),3) AS n FROM ledger_entries WHERE account = ?", [acc]);
const bulkRest = () => zahl("SELECT COALESCE(SUM(remaining_value_fils),0) AS n FROM stock_lots WHERE unit = 'mg'");
const selectSetByOption = (c, optionValue, nth, value) => c.ev(`const l=[...document.querySelectorAll('select')].filter(s=>[...s.options].some(o=>o.value===${S(optionValue)})); const e=l[${nth}]; if(!e) return 'NO-SELECT:'+${S(optionValue)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e, ${S(value)}); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
// v0.8.98 — echte Eingabe über CDP Input (Tastatur/Maus), keine Wert-Setter: Steuerauswahl, Betrag, Speichern.
const TASTE = { ArrowDown: 40, ArrowUp: 38 };
const fokus = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.scrollIntoView({block:'center'}); e.focus(); if (e.select) e.select(); return document.activeElement===e ? 'OK' : 'NO-FOCUS:'+${S(sel)};`);
async function taste(c, sel, key, n = 1) {
  const f = await fokus(c, sel); if (f !== 'OK') return f;
  for (let i = 0; i < n; i++) {
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: TASTE[key], nativeVirtualKeyCode: TASTE[key] });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: TASTE[key], nativeVirtualKeyCode: TASTE[key] });
    await sleep(300);
  }
  return 'OK';
}
async function tippe(c, sel, text) {
  const f = await fokus(c, sel); if (f !== 'OK') return f;
  await c.send('Input.insertText', { text });
  await sleep(300);
  return 'OK';
}
async function mausKlick(c, sel) {
  const p = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return null; if (e.disabled) return 'DISABLED'; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2, y:r.top+r.height/2});`);
  if (!p || p === 'DISABLED') return 'NO-MAUS:' + sel + (p ? ':DISABLED' : '');
  const { x, y } = JSON.parse(p);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return 'OK';
}
/** Fußzeile der Bulk-Zeile: Netto / VAT / Summe, wie angezeigt. */
const fuss = (c) => c.ev("const q=(s)=>(document.querySelector(s)?.innerText||'').replace(/[^0-9.]/g,''); return [q('[data-bulk-net]'), q('[data-bulk-vat]'), q('[data-bulk-total]')].join('/');");
const wahl = (c) => c.ev("const e=document.querySelector('[data-bulk-tax-scheme]'); return e ? e.value + '|' + (e.options[e.selectedIndex]?.text||'') + '|' + (document.querySelector('[data-bulk-gross]')?.value||'') : 'NO';");
const zeileDB = (id) => { const l = dbQ(BIZ_DB, 'SELECT tax_scheme, unit_price, vat_amount, line_total, vat_rate FROM invoice_lines WHERE id = ?', [id])[0] || {};
  return `${l.tax_scheme} ${Number(l.unit_price).toFixed(3)}/${Number(l.vat_amount).toFixed(3)}/${Number(l.line_total).toFixed(3)} r${l.vat_rate}`; };

async function ssPick(c, placeholder, optionId) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}
/** „New Purchase" mit EINER Bulk-Zeile (die vorgegebene Zeile wird auf „Bulk metal" umgestellt). */
async function bulkEinkauf(c, metal, fineness, weight, cost) {
  if (!(await warteBis(c, "document.querySelector('[data-purchase-save]')", 45000))) return 'KEINE-MASKE';
  const r = [];
  r.push(await ssPick(c, 'Search suppliers...', 'bm-sup'));
  r.push(await selectSetByOption(c, 'bulk', 0, 'bulk')); await sleep(400);
  r.push(await setVal(c, '[data-bulk-metal]', metal)); await sleep(200);
  r.push(await setVal(c, '[data-bulk-fineness]', fineness)); await sleep(150);
  r.push(await setVal(c, '[data-bulk-weight]', weight));
  r.push(await setVal(c, '[data-bulk-cost]', cost)); await sleep(300);
  r.push(await klick(c, '[data-purchase-save]'));
  if (!(await warteBis(c, "!document.querySelector('[data-purchase-save]')", 45000))) r.push('NICHT-GESPEICHERT:' + (await fehlerText(c)));
  return alleOk(r);
}

try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  clearTestClientPendingSaves();
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'BM Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'BM Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'BM Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
  // Regulär schließen (`closeTestWindow`): ein hartes Beenden direkt nach dem Onboarding verliert die neueste Sitzung,
  // wenn sie noch nicht in der Datei steht („not-issued-here") — der Neustart stünde dann an der Anmeldemaske.
  const onboardingPid = startedPids().pop();
  primary.close(); primary = null;
  await closeTestWindow(onboardingPid, APP); await waitTestImageGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 90000);
  await primary.ev(DIALOGE_PRIMARY);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
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
  ok(true, 'CONNECT frischer PC2 ohne Datenbank, Anmeldung');
  await beobachterLegen();
  const LEDGER_BASIS = ledgerMax();

  // ══ MIXED-INVOICE P5 — Hilfen dieses Laufs ═══════════════════════════════════════════════════════
  /** Ein Fernauftrag von PC2 mit DESSEN Anmeldung, genau wie die Maske ihn schickt (Aufbau der Welt). */
  async function sende(c, op, payload) {
    const auth = (await kommandos(c)).map((x) => x.auth).find(Boolean) || '';
    const url = `http://127.0.0.1:${PORT}/api/command`;
    return JSON.parse(await c.ev(`const r = await fetch(${S(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ${S(auth)} }, body: JSON.stringify({ op: ${S(op)}, commandId: crypto.randomUUID(), payload: ${S(payload)} }) }); let b = null; try { b = await r.json(); } catch (e) { b = null; } return JSON.stringify({ status: r.status, body: b });`));
  }
  const kon = (id) => zeile('consignments', id);
  const nummerWaehlen = async (c) => {
    if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Normal Final'))", 15000))) return 'KEIN-DIALOG';
    const r = [await clickIncludes(c, 'Normal Final')];
    await sleep(200);
    r.push(await clickText(c, 'Confirm'));
    return alleOk(r);
  };
  const maskenFehler = async (c) => { try { const t = await c.ev("const e = document.querySelector('[data-save-error]'); return e ? 'FEHLER: ' + e.textContent : 'KEIN-FEHLERKASTEN @ ' + location.pathname;"); return String(t); } catch (e) { return 'EV-FEHLER: ' + String(e).slice(0, 200); } };
  const setByLabel = (c, label, v) => c.ev(
    `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
    + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
    + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
    + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
  const labelDa = (c, label) => c.ev(`return [...document.querySelectorAll('label')].some(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)});`);
  const zeilenDB = (inv) => dbQ(BIZ_DB, `SELECT il.product_id, ROUND(il.purchase_price_snapshot,3) AS c, il.tax_scheme AS t, ROUND(il.line_total,3) AS g
      FROM invoice_lines il WHERE il.invoice_id = ? ORDER BY il.position, il.rowid`, [inv]);
  const einkaufVon = (cid) => dbQ(BIZ_DB, `SELECT p.* FROM purchases p WHERE p.status != 'CANCELLED'
    AND (p.source_consignment_id = ? OR EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id = ?))
    ORDER BY p.rowid DESC`, [cid, cid])[0] || {};
  const GRUND = 'textarea[placeholder^="Explain why this invoice"]';
  const gruppe = (gid) => dbQ(BIZ_DB, 'SELECT id, group_seq AS seq, group_quantity AS menge, status, invoice_id AS inv, product_id AS pid, agreed_price AS preis, minimum_price AS mini FROM consignments WHERE group_id = ? ORDER BY group_seq', [gid]);
  const stand = (gid) => S(gruppe(gid).map((x) => [x.seq, x.status, x.inv ? 1 : 0]));
  const vielleichtNummer = async (c) => {
    if (await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Normal Final')) || !document.querySelector('[data-invoice-save]')", 15000)) {
      if (await c.ev("return [...document.querySelectorAll('button')].some(b=>b.textContent.includes('Normal Final'));")) return nummerWaehlen(c);
    }
    return 'OK';
  };

  // ── A Die Welt: eigene Ware mit Einkauf (echter PC2-Befehl) ─────────────────────────────────────────────
  client = await lade(client, '/purchases');
  await waitFor(client, SHELL, 30000);
  const ek = await sende(client, 'purchases.create', {
    supplierId: 'p3-sup', taxScheme: 'ZERO',
    lines: [{ mode: 'existing', productId: 'p3-own-1', quantity: 1, unitPrice: 2000 }],
  });
  await spuelen(primary);
  ok(ek.body?.ok === true, `A eigener Einkauf über PC2 (${S(ek.body?.error || 'ok')})`);

  // ── B PC2 „New Consignment" mit Quantity 4: EIN Auftrag, vier Stücke als Gruppe ─────────────────────────
  let GID = '';
  {
    await syncRuhe();
    client = await lade(client, '/consignments');
    const r = [];
    if (!(await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Consignment')", 40000))) r.push('KEIN-KNOPF');
    r.push(await clickText(client, 'New Consignment'));
    if (!(await warteBis(client, "document.querySelector('[data-cn-create]')", 15000))) r.push('KEINE-MASKE');
    r.push(await ssPick(client, 'Search clients...', 'p3-con-a'));
    r.push(await klick(client, '[data-cn-cat="p3-cat"]')); await sleep(400);
    r.push(await setByLabel(client, 'BRAND', 'P5'));
    r.push(await setByLabel(client, 'NAME / MODEL', 'Perlenstecker P5'));
    r.push(await setByLabel(client, 'AGREED PRICE (BHD)', '400'));
    r.push(await setByLabel(client, 'MINIMUM PRICE (BHD)', '380'));
    r.push(await tippe(client, '[data-consignment-quantity] input', '4')); await sleep(300);
    const hinweis = String(await client.ev("return document.querySelector('[data-consignment-group-note]')?.innerText || '';"));
    const jeStueck = (await labelDa(client, 'AGREED PRICE PER PIECE (BHD)')) && (await labelDa(client, 'MINIMUM PRICE PER PIECE (BHD)'));
    ok(/Creates 4 pieces/.test(hinweis) && /per piece/.test(hinweis) && jeStueck,
      `B PC2-Maske: Menge 4 per Tastatur — „Agreed/Minimum price per piece" und der Hinweis auf die Gruppe (${hinweis.slice(0, 160)})`);
    const vor = (await kommandos(client)).filter((x) => x.op === 'consignments.create').length;
    r.push(await mausKlick(client, '[data-cn-create]'));
    if (!(await warteBis(client, "!document.querySelector('[data-cn-create]')", 45000))) r.push('NICHT-ZU:' + String(await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';")).slice(0, 160));
    await spuelen(primary);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'consignments.create');
    const body = cmds.at(-1)?.payload || {};
    ok(alleOk(r) === 'OK' && cmds.length === vor + 1 && body.quantity === 4 && body.agreedPrice === 400 && body.minimumPrice === 380 && !('quantity' in (body.product || {})),
      `B EIN Fernauftrag consignments.create mit quantity 4 (Preis je Stück) (${alleOk(r)} ${S({ q: body.quantity, a: body.agreedPrice })})`);
    GID = String(dbQ(BIZ_DB, "SELECT group_id AS g FROM consignments WHERE group_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")[0]?.g || '');
    const g = gruppe(GID);
    ok(GID && g.length === 4 && S(g.map((x) => [x.seq, x.menge, x.status, x.preis, x.mini])) === S([1, 2, 3, 4].map((sq) => [sq, 4, 'active', 400, 380])),
      `B Primary: vier Kommissionen einer Gruppe, Stück 1–4, Menge 4, Preis und Minimum je Stück (${S(g.map((x) => [x.seq, x.status]))})`);
    const art = dbQ(BIZ_DB, `SELECT p.sku, p.quantity, p.stock_status FROM consignments c JOIN products p ON p.id = c.product_id WHERE c.group_id = ? ORDER BY c.group_seq`, [GID]);
    ok(art.length === 4 && new Set(art.map((x) => x.sku)).size === 4 && art.every((x) => Number(x.quantity) === 1 && x.stock_status === 'consignment'),
      `B je Stück ein eigener Artikel mit eigener SKU, Menge 1, im Kommissionsbestand (${S(art.map((x) => x.sku))})`);
    const audit = dbQ(BIZ_DB, "SELECT new_value FROM audit_log WHERE field_name = 'consignment_group_created'")[0]?.new_value || '';
    ok(/"quantity":4/.test(String(audit)), `B Protokoll der Gruppe (${String(audit).slice(0, 100)})`);
  }
  const [S1, S2, S3, S4] = gruppe(GID).map((x) => x.id);

  // ── C PC2 Liste „Items": die Gruppe als Kopfzeile, „Select 1", Record Sale, im Dialog auf 2 Stück ──────────
  {
    await syncRuhe();
    client = await lade(client, '/consignments');
    await waitFor(client, SHELL, 30000);
    const r = [];
    if (!(await warteBis(client, "[...document.querySelectorAll('button')].some(b=>/^Items \\(/.test(b.textContent.trim()))", 30000))) r.push('KEIN-REITER');
    await client.ev("[...document.querySelectorAll('button')].find(b=>/^Items \\(/.test(b.textContent.trim())).click(); return 1;");
    if (!(await warteBis(client, `document.querySelector('[data-consignment-group="${GID}"]')`, 20000))) r.push('KEINE-GRUPPE');
    const kopf = String(await client.ev(`return document.querySelector('[data-consignment-group="${GID}"]')?.innerText || '';`));
    const zuStuecke = Number(await client.ev(`return document.querySelectorAll('[data-consignment-piece]').length;`));
    ok(/Group × 4/.test(kopf) && /4 available/.test(kopf) && /BHD \/ piece/.test(kopf) && zuStuecke === 0,
      `C PC2-Liste: EINE Kopfzeile „Group × 4 · 4 available · / piece", zugeklappt (${kopf.replace(/\s+/g, ' ').slice(0, 160)})`);
    r.push(await mausKlick(client, `[data-consignment-group-toggle="${GID}"]`)); await sleep(300);
    const aufStuecke = await client.ev(`return [...document.querySelectorAll('[data-consignment-piece]')].map(e=>e.textContent).join('|');`);
    ok(String(aufStuecke) === 'piece 1 of 4|piece 2 of 4|piece 3 of 4|piece 4 of 4', `C aufgeklappt: die vier Stücke mit Nummer (${aufStuecke})`);
    r.push(await tippe(client, `[data-consignment-group-select="${GID}"]`, '1')); await sleep(300);
    const gewaehlt = await client.ev(`return [...document.querySelectorAll('[data-consignment-select]')].filter(e=>e.checked).map(e=>e.getAttribute('data-consignment-select'));`);
    ok(S(gewaehlt) === S([S1]), `C „Select 1": das Stück mit der kleinsten Nummer ist gewählt (${S(gewaehlt)})`);
    r.push(await klick(client, '[data-consignment-record-sale-selected]'));
    if (!(await warteBis(client, "document.querySelector('[data-consignment-sale-dialog]')", 15000))) r.push('KEIN-DIALOG');
    const vorK = String(await client.ev(`return document.querySelector('[data-consignment-sale-group-qty="${GID}"]')?.value || '';`));
    r.push(await tippe(client, `[data-consignment-sale-group-qty="${GID}"]`, '2')); await sleep(400);
    const zeilen = await client.ev("return [...document.querySelectorAll('[data-consignment-sale-row]')].map(e=>e.getAttribute('data-consignment-sale-row'));");
    ok(vorK === '1' && S(zeilen) === S([S1, S2]), `C Dialog: „Pieces to sell" 1 → 2, die Zeilen sind Stück 1 und 2 (${vorK} ${S(zeilen)})`);
    r.push(await ssPick(client, 'Search clients...', 'p3-kunde'));
    r.push(await tippe(client, `[data-consignment-sale-group-price="${GID}"]`, '450')); await sleep(300);
    const preise = await client.ev(`return ['${S1}','${S2}'].map((id)=>document.querySelector('[data-consignment-sale-price="'+id+'"]')?.value);`);
    ok(S(preise) === S(['450', '450']), `C „Price per piece" gilt für beide Zeilen (${S(preise)})`);
    r.push(await mausKlick(client, `[data-consignor-purchase-vat="p3-con-a"][data-vat="ZERO"]`)); await sleep(200);
    const vor = (await kommandos(client)).filter((x) => x.op === 'consignments.record_sale').length;
    r.push(await klick(client, '[data-consignment-sale]'));
    r.push(await nummerWaehlen(client));
    if (!(await warteBis(client, "!document.querySelector('[data-consignment-sale-dialog]')", 30000))) r.push('BLEIBT:' + (await maskenFehler(client)));
    await spuelen(primary);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'consignments.record_sale');
    const body = cmds.at(-1)?.payload || {};
    ok(alleOk(r) === 'OK' && cmds.length === vor + 1 && S((body.items || []).map((x) => [x.consignmentId, x.salePrice, x.consignorTaxScheme])) === S([[S1, 450, 'ZERO'], [S2, 450, 'ZERO']]),
      `C EIN Fernauftrag consignments.record_sale mit 2 Stücken (items[]) (${alleOk(r)} ${S(body.items || []).slice(0, 200)})`);
    const inv = kon(S1).invoice_id;
    ok(stand(GID) === S([[1, 'sold', 1], [2, 'sold', 1], [3, 'active', 0], [4, 'active', 0]]) && kon(S2).invoice_id === inv && zeilenDB(inv).length === 2,
      `C Primary: Stück 1+2 verkauft auf EINER Rechnung mit 2 Zeilen, 3+4 verfügbar (${stand(GID)})`);
    const ein = einkaufVon(S1);
    ok(Number(ein.total_amount) === 765 && dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM purchase_lines WHERE purchase_id = ?', [ein.id])[0]?.n === 2,
      `C EIN Einkauf beim Einlieferer mit 2 Zeilen (2 × 382,5 bei 15 %) (${ein.total_amount})`);
  }

  // ── D Primary Detail: der Abschnitt „Group" mit allen Stücken ───────────────────────────────────────────
  {
    await gehFrisch(primary, `/consignments/${S3}`);
    const da = await warteBis(primary, `document.querySelector('[data-consignment-detail-group="${GID}"]')`, 30000);
    const status = String(await primary.ev("return document.querySelector('[data-consignment-detail-group-status]')?.innerText || '';"));
    const stuecke = await primary.ev("return [...document.querySelectorAll('[data-consignment-detail-piece]')].map(e=>e.innerText.replace(/\\s+/g,' ').trim());");
    ok(da && status === 'Group of 4 · 2 available · 2 sold' && stuecke.length === 4 && /^1 /.test(stuecke[0]) && /^3 /.test(stuecke[2]),
      `D Primary-Detail: „Group · piece 3 of 4", Status „Group of 4 · 2 available · 2 sold", vier Stücke (${status} ${S(stuecke).slice(0, 200)})`);
  }

  // ── E PC2 „Direct Sale": eigener Artikel + Gruppe über 2b („group × 2 available"), 2 Stücke ─────────────────
  let INV2 = '';
  {
    await syncRuhe();
    client = await lade(client, '/invoices/new');
    const r = [];
    if (!(await warteBis(client, "document.querySelector('[data-invoice-save]') && document.querySelector('[data-mixed-consignment-section]')", 45000))) r.push('KEINE-MASKE');
    r.push(await ssPick(client, 'Search clients...', 'p3-kunde'));
    r.push(await ssPick(client, 'Pick product...', 'p3-own-1'));
    const option = String(await client.ev(`const t=[...document.querySelectorAll('[data-ss-trigger="Add a consignment item…"]')].pop(); t && t.click(); await new Promise((x)=>setTimeout(x,400)); return document.querySelector('[data-ss-option="group:${GID}"]')?.innerText || '';`));
    ok(/group × 2 available/.test(option) && /per piece/.test(option), `E PC2 2b: die Gruppe steht EINMAL in der Auswahl („group × 2 available") (${option.replace(/\s+/g, ' ').slice(0, 140)})`);
    await client.ev(`document.querySelector('[data-ss-option="group:${GID}"]').click(); return 1;`); await sleep(400);
    if (!(await warteBis(client, `document.querySelector('[data-mixed-con-group="${GID}"]')`, 10000))) r.push('KEIN-GRUPPENBLOCK');
    r.push(await tippe(client, `[data-mixed-con-group-qty="${GID}"]`, '2')); await sleep(400);
    r.push(await tippe(client, `[data-mixed-con-group-price="${GID}"]`, '470')); await sleep(300);
    const zeilen = await client.ev("return [...document.querySelectorAll('[data-mixed-con-row]')].map(e=>e.getAttribute('data-mixed-con-row'));");
    const stueckEtiketten = await client.ev("return [...document.querySelectorAll('[data-mixed-con-piece]')].map(e=>e.textContent.trim());");
    ok(S(zeilen) === S([S3, S4]) && S(stueckEtiketten) === S(['· piece 3 of 4', '· piece 4 of 4']), `E „Pieces on this invoice" 2: Zeilen für Stück 3 und 4 (${S(zeilen)} ${S(stueckEtiketten)})`);
    r.push(await mausKlick(client, '[data-mixed-consignor-vat="p3-con-a:ZERO"]'));
    const vor = (await kommandos(client)).filter((x) => x.op === 'consignments.record_sale').length;
    r.push(await mausKlick(client, '[data-invoice-save]'));
    r.push(await vielleichtNummer(client));
    if (!(await warteBis(client, "!document.querySelector('[data-invoice-save]')", 45000))) r.push('NICHT-GESPEICHERT:' + (await maskenFehler(client)));
    await spuelen(primary);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'consignments.record_sale');
    const body = cmds.at(-1)?.payload || {};
    INV2 = kon(S3).invoice_id;
    ok(alleOk(r) === 'OK' && cmds.length === vor + 1 && body.ownLines?.length === 1 && S((body.items || []).map((x) => [x.consignmentId, x.salePrice])) === S([[S3, 470], [S4, 470]]),
      `E EIN Fernauftrag mit 1 eigener Zeile + 2 Stücken zu je 470 (${alleOk(r)} ${S(body.items || []).slice(0, 160)})`);
    ok(INV2 && zeilenDB(INV2).length === 3 && stand(GID) === S([[1, 'sold', 1], [2, 'sold', 1], [3, 'sold', 1], [4, 'sold', 1]]),
      `E Primary: gemischte Rechnung mit 3 Zeilen, alle vier Stücke verkauft (${stand(GID)})`);
  }

  // ── F Primary „Edit Invoice" (P4): EIN Stück entfernen ⇒ nur dieses Stück wieder verfügbar ───────────────
  {
    await gehFrisch(primary, `/invoices/${INV2}/edit`);
    const r = [];
    if (!(await warteBis(primary, "document.querySelectorAll('[data-mixed-con-kept=\"1\"]').length === 2", 45000))) r.push('KEINE-KOMMISSIONSZEILEN');
    const block = String(await primary.ev(`return document.querySelector('[data-mixed-con-group="${GID}"]')?.innerText || '';`));
    ok(/group of 4/.test(block) && /PRICE PER NEW PIECE/.test(block), `F Primary-Korrektur: Gruppenblock mit den gespeicherten Stücken (${block.replace(/\s+/g, ' ').slice(0, 160)})`);
    r.push(await mausKlick(primary, `[data-mixed-con-remove=${S(S4)}]`)); await sleep(400);
    if (!(await warteBis(primary, `document.querySelector('[data-mixed-con-removed=${S(S4)}]')`, 5000))) r.push('NICHT-ENTFERNT');
    r.push(await tippe(primary, GRUND, 'Stück 4 irrtümlich berechnet'));
    r.push(await mausKlick(primary, '[data-invoice-save]'));
    if (!(await warteBis(primary, "!document.querySelector('[data-invoice-save]')", 45000))) r.push('NICHT-GESPEICHERT:' + (await maskenFehler(primary)));
    await spuelen(primary);
    ok(alleOk(r) === 'OK' && stand(GID) === S([[1, 'sold', 1], [2, 'sold', 1], [3, 'sold', 1], [4, 'active', 0]]) && zeilenDB(INV2).length === 2,
      `F gespeichert: nur Stück 4 wieder verfügbar, die Rechnung hat 2 Zeilen (${alleOk(r)} ${stand(GID)})`);
    const lines = dbQ(BIZ_DB, 'SELECT source_consignment_id AS c FROM purchase_lines WHERE purchase_id = ?', [einkaufVon(S3).id]).map((x) => x.c);
    ok(lines.includes(S3) && !lines.includes(S4), `F der Einkauf beim Einlieferer verliert nur die Zeile von Stück 4 (${S(lines)})`);
  }

  // ── G Hauptbuch, Lager, AP, AR — und die Isolation ─────────────────────────────────────────────────────
  {
    await spuelen(primary);
    const tx = dbQ(BIZ_DB, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d
                              FROM ledger_entries WHERE rowid > ? GROUP BY transaction_id`, [LEDGER_BASIS]);
    ok(tx.length > 0 && tx.every((t) => Number(t.d) === 0), `LEDGER jede Buchung dieses Laufs ausgeglichen (${tx.length} Transaktionen)`);
    const lose = zahl("SELECT COALESCE(ROUND(SUM(qty_remaining * unit_cost), 3), 0) AS n FROM stock_lots WHERE status = 'ACTIVE'");
    ok(Math.abs(konto('INVENTORY') - lose) < 0.005, `LEDGER INVENTORY ${konto('INVENTORY')} = Σ Lose ${lose}`);
    const ap = zahl(`SELECT ROUND(COALESCE((SELECT SUM(remaining_amount) FROM purchases WHERE status NOT IN ('CANCELLED','DRAFT')), 0)
      + COALESCE((SELECT SUM(MAX(0, amount - paid_amount)) FROM expenses WHERE status != 'CANCELLED' AND supplier_id IS NOT NULL), 0), 3) AS n`);
    ok(Math.abs(-konto('ACCOUNTS_PAYABLE') - ap) < 0.005, `LEDGER AP ${-konto('ACCOUNTS_PAYABLE')} = offene Einkäufe/Ausgaben ${ap}`);
    const ar = zahl("SELECT COALESCE(ROUND(SUM(gross_amount - paid_amount), 3), 0) AS n FROM invoices WHERE status != 'CANCELLED'");
    ok(Math.abs(konto('ACCOUNTS_RECEIVABLE') - ar) < 0.005, `LEDGER AR ${konto('ACCOUNTS_RECEIVABLE')} = offene Rechnungen ${ar}`);
    ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SAFETY PC2 hat keine eigene Geschäftsdatenbank angelegt');
    ok((await treffer(client)).length === 0, 'SAFETY PC2 hat nie eine lokale Datenbank angefragt');
    const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
    ok(S(fremdVorher) === S(fremdNachher), 'ISOLATION fremde LATAIF-Prozesse unberührt');
  }

} catch (e) {
  ok(false, 'ABBRUCH: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
} finally {
  clearTimeout(WACHHUND);
  try { client?.close(); } catch { /* zu */ }
  try { primary?.close(); } catch { /* zu */ }
  aufraeumen();
}
console.log(`\nconsignment-quantities-p5 e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('CONSIGNMENT_QUANTITIES_P5_E2E_PROVED');
process.exit(0);
