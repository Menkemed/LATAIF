// ════════════════════════════════════════════════════════════════════════════
// PRE-RELEASE PRIMARY / PC2 GATE — Zwei-App-E2E mit zwei echten, isolierten Anwendungen (Primary + PC2 ohne Datenbank).
// Run: node test/e2e/release-stock-opening-pc2.e2e.mjs
//
//   Release-Umfang über die Masken des PC2: Correct Initial Qty (5 → 3 → 4), Add Old Stock und Remove from Stock,
//   Eröffnungsposten am Kunden, B1-Eröffnungsbilanz (Kasse gezählt; Übersicht auf beiden Rechnern gleich),
//   Receive Payment und Pay Supplier (Doppelklick, verlorene Antwort mit derselben Kennung), Eröffnungsposten nicht
//   bezahlbar; Hauptbuch ausgeglichen, keine Eröffnungs- oder Bestandsbuchung, PC2 ohne Datenbank.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat oder was am EXAKTEN
// Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
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
const OWNER_PW = 'rl-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-release', 'run-' + Date.now());
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
// ══════════════════════════════════════════════════════════════════════════════
// RELEASE GATE — die Welt des Laufs
// ══════════════════════════════════════════════════════════════════════════════
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    let cat = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id;
    if (!cat) { insert(db, 'categories', { id: 'rl-cat', branch_id, name: 'Watch', icon: 'w', color: '#000', created_at: now, updated_at: now }); cat = 'rl-cat'; }
    insert(db, 'suppliers', { id: 'rl-sup', branch_id, name: 'RL Lieferant', phone: '+973 1700 0999', active: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'rl-kunde', branch_id, first_name: 'RL', last_name: 'Kunde', phone: '+973 3600 0999', created_at: now, updated_at: now });
    const ware = (id, name, qty, price) => insert(db, 'products', {
      id, branch_id, category_id: cat, brand: 'RL', name, sku: 'RL-' + id.toUpperCase(), quantity: qty, condition: 'New', scope_of_delivery: '[]',
      purchase_price: price, purchase_currency: 'BHD', planned_sale_price: price * 2, stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0,
      images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now,
    });
    ware('rl-iq', 'Initial Qty', 5, 100);
    ware('rl-old', 'Old Stock', 2, 50);
    ware('rl-s1', 'Sale One', 1, 100);
    ware('rl-s2', 'Sale Two', 1, 80);
    ware('rl-buy', 'Bought New', 0, 0);
  } finally { db.close(); }
}
const qtyOf = (id) => zahl('SELECT quantity AS n FROM products WHERE id = ?', [id]);
const adjDocs = (id) => dbQ(BIZ_DB, 'SELECT direction, qty_before, qty_after, accounting, status, created_by FROM stock_adjustments WHERE product_id = ? ORDER BY adjustment_number', [id]);
async function bestaetige(c) {
  if (!(await warteBis(c, q('[data-app-confirm-ok]'), 15000))) return 'KEIN-DIALOG';
  await c.ev("document.querySelector('[data-app-confirm-ok]').click(); return 1;");
  return 'OK';
}
const ALLE_CMDS = [];
async function merke(c) { try { ALLE_CMDS.push(...(await kommandos(c))); } catch { /* Seite weg */ } }
const cmdsOf = (op) => ALLE_CMDS.filter((x) => x.op === op);
/** Ein Fernauftrag von PC2, mit DESSEN Anmeldung, genau so, wie die Maske ihn schickt. */
async function sende(c, op, payload) {
  const auth = ALLE_CMDS.map((x) => x.auth).find(Boolean) || (await kommandos(c)).map((x) => x.auth).find(Boolean);
  const url = ALLE_CMDS.map((x) => x.url).find(Boolean) || `http://127.0.0.1:${PORT}/api/command`;
  return JSON.parse(await c.ev(`const r = await fetch(${S(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ${S(auth || '')} }, body: JSON.stringify({ op: ${S(op)}, commandId: crypto.randomUUID(), payload: ${S(payload)} }) }); let b = null; try { b = await r.json(); } catch (e) { b = null; } return JSON.stringify({ status: r.status, body: b });`));
}
const zeilenText = (c) => c.ev("return JSON.stringify([...document.querySelectorAll('[data-opening-row]')].map(r => r.getAttribute('data-opening-row') + '|' + [...r.querySelectorAll('td')].slice(1).map(x => x.textContent.trim()).join('|')));");

try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'RL Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'RL Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'RL Admin');
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
  const wechsle = async (route) => { await merke(client); client = await lade(client, route); };

  // ── 1 Correct Initial Qty auf PC2: 5 → 3 → 4 (Beleg je Schritt, keine Buchung) ──────────────
  await syncRuhe();
  {
    const l0 = ledgerMax();
    const r = [];
    for (const ziel of ['3', '4']) {
      await wechsle('/collection/rl-iq');
      if (!(await warteBis(client, q('[data-initial-qty-open]'), 45000))) { r.push('KEIN-KNOPF'); break; }
      r.push(await klick(client, '[data-initial-qty-open]'));
      await warteBis(client, q('[data-initial-qty-dialog]'), 10000);
      r.push(await setVal(client, '[data-initial-qty-qty]', ziel));
      r.push(await setVal(client, '[data-initial-qty-reason]', 'e2e: first entry was wrong'));
      if (!(await warteBis(client, q('[data-initial-qty-preview]'), 20000))) r.push('KEINE-VORSCHAU:' + (await client.ev("return document.querySelector('[data-initial-qty-refused]')?.textContent || '';")));
      r.push(await klick(client, '[data-initial-qty-submit]'));
      r.push(await bestaetige(client));
      if (!(await warteBis(client, "!document.querySelector('[data-initial-qty-dialog]')", 30000))) r.push('DIALOG-BLEIBT:' + (await fehlerText(client, '[data-stock-dialog-error]')));
      await spuelen(primary);
    }
    await merke(client);
    const docs = adjDocs('rl-iq');
    const c = cmdsOf('stock_adjustments.correct_initial');
    ok(alleOk(r) === 'OK' && qtyOf('rl-iq') === 4 && docs.length === 2 && docs.every((d) => d.direction === 'CORRECTION' && d.accounting === 'ACCOUNTING_RECONCILIATION_PENDING' && d.status === 'POSTED')
      && Number(docs[0].qty_before) === 5 && Number(docs[0].qty_after) === 3 && Number(docs[1].qty_before) === 3 && Number(docs[1].qty_after) === 4
      && c.length === 2 && c[0].commandId !== c[1].commandId && ledgerMax() === l0,
    `QTY PC2: 5 → 3 → 4 am Primary, zwei Belege CORRECTION, keine Buchung (${alleOk(r)} ${qtyOf('rl-iq')} ${docs.length})`);
  }

  // ── 2 Add Old Stock und Remove from Stock auf PC2; danach ist die erste Eingabe keine mehr ─────────
  await syncRuhe();
  {
    const l0 = ledgerMax();
    const r = [];
    await wechsle('/collection/rl-old');
    if (!(await warteBis(client, q('[data-old-stock-open]'), 45000))) r.push('KEIN-KNOPF');
    r.push(await klick(client, '[data-old-stock-open]'));
    await warteBis(client, q('[data-old-stock-dialog]'), 10000);
    r.push(await setVal(client, '[data-old-stock-qty]', '2'));
    r.push(await setVal(client, '[data-old-stock-cost]', '50'));
    r.push(await setVal(client, '[data-old-stock-reason]', 'e2e: found in the back office'));
    if (!(await warteBis(client, q('[data-old-stock-preview]'), 20000))) r.push('KEINE-VORSCHAU:' + (await client.ev("return document.querySelector('[data-old-stock-refused]')?.textContent || '';")));
    r.push(await klick(client, '[data-old-stock-submit]'));
    r.push(await bestaetige(client));
    if (!(await warteBis(client, "!document.querySelector('[data-old-stock-dialog]')", 30000))) r.push('ZUGANG-BLEIBT:' + (await fehlerText(client, '[data-stock-dialog-error]')));
    await spuelen(primary);
    await warteBis(client, q('[data-stock-issue-open]'), 20000);
    r.push(await klick(client, '[data-stock-issue-open]'));
    await warteBis(client, q('[data-stock-issue-dialog]'), 10000);
    r.push(await setVal(client, '[data-stock-issue-qty]', '1'));
    r.push(await setVal(client, '[data-stock-issue-reason]', 'e2e: not found at the count'));
    if (!(await warteBis(client, q('[data-stock-issue-preview]'), 20000))) r.push('KEINE-ABGANGS-VORSCHAU:' + (await client.ev("return document.querySelector('[data-stock-issue-refused]')?.textContent || '';")));
    r.push(await klick(client, '[data-stock-issue-submit]'));
    r.push(await bestaetige(client));
    if (!(await warteBis(client, "!document.querySelector('[data-stock-issue-dialog]')", 30000))) r.push('ABGANG-BLEIBT:' + (await fehlerText(client, '[data-stock-dialog-error]')));
    await spuelen(primary);
    const docs = adjDocs('rl-old');
    ok(alleOk(r) === 'OK' && qtyOf('rl-old') === 3 && docs.length === 2 && docs[0].direction === 'RECEIPT' && Number(docs[0].qty_after) === 4
      && docs[1].direction === 'ISSUE' && Number(docs[1].qty_after) === 3 && docs.every((d) => d.accounting === 'ACCOUNTING_RECONCILIATION_PENDING') && ledgerMax() === l0,
    `STOCK PC2: Altbestand +2, Abgang −1 (2 → 4 → 3), beide ohne Buchung (Abgang ohne Los: Abstimmung offen) (${alleOk(r)} ${qtyOf('rl-old')})`);
    await wechsle('/collection/rl-old');
    await warteBis(client, q('[data-initial-qty-open]'), 30000);
    await klick(client, '[data-initial-qty-open]');
    await warteBis(client, q('[data-initial-qty-dialog]'), 10000);
    await setVal(client, '[data-initial-qty-qty]', '9');
    await setVal(client, '[data-initial-qty-reason]', 'e2e');
    const gesperrt = await warteBis(client, "/already has documents/.test(document.querySelector('[data-initial-qty-refused]')?.textContent || '')", 20000);
    const knopf = await client.ev("return document.querySelector('[data-initial-qty-submit]')?.disabled === true;");
    ok(gesperrt && knopf && qtyOf('rl-old') === 3, 'STOCK PC2: nach Zugang/Abgang ist „Correct initial qty" gesperrt (Vorgeschichte), der Knopf bleibt aus');
  }

  // ── 3 Eröffnungsposten am Kunden auf PC2 (Beleg, keine Buchung, synchronisiert) ──────────────
  await syncRuhe();
  {
    const l0 = ledgerMax();
    const r = [];
    await wechsle('/clients/rl-kunde');
    if (!(await warteBis(client, "[...document.querySelectorAll('button')].some(b => b.textContent.includes('Edit Client'))", 45000))) r.push('KEIN-EDIT');
    r.push(await clickIncludes(client, 'Edit Client'));
    if (!(await warteBis(client, q('[data-opening-form]'), 30000))) r.push('KEIN-FORMULAR');
    r.push(await setVal(client, '[data-opening-kind]', 'CUSTOMER_RECEIVABLE'));
    r.push(await setVal(client, '[data-opening-scope]', 'REMAINDER')); await sleep(300);
    r.push(await setVal(client, '[data-opening-amount]', '300'));
    r.push(await klick(client, '[data-opening-confirm-not-in-lataif]'));
    if (!(await warteBis(client, q('[data-opening-preview]'), 20000))) r.push('KEINE-VORSCHAU:' + (await client.ev("return document.querySelector('[data-opening-refused]')?.textContent || '';")));
    await warteBis(client, "document.querySelector('[data-opening-submit]') && !document.querySelector('[data-opening-submit]').disabled", 15000);
    r.push(await klick(client, '[data-opening-submit]'));
    r.push(await bestaetige(client));
    await warteBis(client, "/recorded/.test(document.querySelector('[data-opening-msg]')?.textContent || '')", 30000);
    await spuelen(primary);
    const ob = dbQ(BIZ_DB, "SELECT * FROM opening_balance_items WHERE party_id = 'rl-kunde'");
    await syncRuhe();
    const imServer = Number(dbQ(SERVER_DB, "SELECT COUNT(*) AS n FROM sync_changelog WHERE table_name = 'opening_balance_items'")[0]?.n || 0);
    ok(alleOk(r) === 'OK' && ob.length === 1 && ob[0].status === 'RECORDED' && ob[0].accounting === 'PENDING' && Number(ob[0].amount) === 300 && ob[0].kind === 'CUSTOMER_RECEIVABLE'
      && ledgerMax() === l0 && imServer >= 1,
    `OB PC2: Eröffnungsforderung 300 am Primary erfasst (PENDING, keine Buchung) und über den Sync-Server gereist (${alleOk(r)} ${ob.length} ${imServer})`);
  }

  // ── 4 B1 auf PC2: Eröffnungsbilanz (Seite „Opening balances") — Kasse gezählt, Übersicht gleich auf beiden ──
  await syncRuhe();
  {
    const l0 = ledgerMax();
    const r = [];
    await wechsle('/opening-balances');
    if (!(await warteBis(client, q('[data-opening-doc-form]'), 45000))) r.push('KEIN-B1:' + String(await client.ev('return document.body.innerText.slice(0, 200);')).replace(/\s+/g, ' '));
    r.push(await setVal(client, '[data-opening-doc-amount]', '1000.5'));
    r.push(await setVal(client, '[data-opening-doc-reference]', 'Cash count e2e'));
    r.push(await setVal(client, '[data-opening-doc-reason]', 'counted at the opening'));
    if (!(await warteBis(client, q('[data-opening-doc-preview]'), 20000))) r.push('KEINE-VORSCHAU:' + (await client.ev("return document.querySelector('[data-opening-doc-refused]')?.textContent || '';")));
    r.push(await klick(client, '[data-opening-doc-submit]'));
    r.push(await bestaetige(client));
    await warteBis(client, "/recorded/.test(document.querySelector('[data-opening-doc-msg]')?.textContent || '')", 30000);
    await spuelen(primary);
    const oa = dbQ(BIZ_DB, "SELECT * FROM opening_account_items WHERE kind = 'CASH_BALANCE'");
    ok(alleOk(r) === 'OK' && oa.length === 1 && Number(oa[0].amount) === 1000.5 && oa[0].accounting === 'PENDING' && oa[0].status === 'RECORDED' && ledgerMax() === l0,
      `B1 PC2: gezählter Kassenstand 1000,500 am Primary erfasst (PENDING, keine Buchung) (${alleOk(r)} ${oa.length})`);
    await syncRuhe();
    await wechsle('/opening-balances');
    await warteBis(client, q('[data-opening-row="CASH_BALANCE"]'), 45000);
    await gehFrisch(primary, '/opening-balances');
    await warteBis(primary, q('[data-opening-row="CASH_BALANCE"]'), 45000);
    const zc = await zeilenText(client); const zp = await zeilenText(primary);
    const status = (c) => c.ev("return document.querySelector('[data-opening-status]')?.textContent || '';");
    const imb = (c) => c.ev("return document.querySelector('[data-trial-imbalance]')?.textContent || '';");
    const rows = JSON.parse(zc);
    ok(zc === zp && rows.length === 15 && rows.some((x) => /^CASH_BALANCE\|0\.000\|1000\.500 \(counted\)\|1000\.500\|PROVISIONAL$/.test(x))
      && rows.some((x) => /^CUSTOMER_RECEIVABLES\|0\.000\|300\.000\|300\.000\|PROVISIONAL$/.test(x)) && rows.some((x) => /^CARD_CLEARING\|.*NOT_VERIFIED$/.test(x)),
    `B1 Übersicht auf Primary und PC2 gleich: Kasse gezählt 1000,500 (Differenz offen), Forderung 300 als Entwurf, Card Clearing offen (${rows.length})`);
    ok(/PROVISIONAL/.test(await status(client)) && /PROVISIONAL/.test(await status(primary)) && (await imb(client)) === '0.000' && (await imb(primary)) === '0.000',
      'B1 Status PROVISIONAL und Saldenliste ausgeglichen auf beiden Rechnern');
  }

  // ── 5 Offene Belege für die Zahlungen (Fernaufträge des PC2, wie die Masken sie schicken) ─────────
  await syncRuhe();
  let INV = [], PUR = null;
  {
    await merke(client);
    const i1 = await sende(client, 'invoices.create', { customerId: 'rl-kunde', lines: [{ productId: 'rl-s1', quantity: 1, unitPrice: 200 }] });
    const i2 = await sende(client, 'invoices.create', { customerId: 'rl-kunde', lines: [{ productId: 'rl-s2', quantity: 1, unitPrice: 150 }] });
    // Ein offener Einkauf (ohne Anzahlung) — die Lieferantenseite bietet „Pay Supplier — Bulk" bei offenen Einkäufen an.
    const e1 = await sende(client, 'purchases.create', { supplierId: 'rl-sup', lines: [{ mode: 'existing', productId: 'rl-buy', quantity: 1, unitPrice: 300 }] });
    await spuelen(primary);
    INV = dbQ(BIZ_DB, "SELECT id, invoice_number, gross_amount, paid_amount, status FROM invoices WHERE customer_id = 'rl-kunde' ORDER BY created_at");
    PUR = dbQ(BIZ_DB, "SELECT id, total_amount, paid_amount, status FROM purchases WHERE supplier_id = 'rl-sup'")[0] || null;
    ok(i1.status === 200 && i2.status === 200 && e1.status === 200 && INV.length === 2 && Number(INV[0].gross_amount) === 200 && Number(INV[1].gross_amount) === 150 && PUR && Number(PUR.total_amount) === 300 && Number(PUR.paid_amount) === 0,
      `SETUP zwei offene Rechnungen (200, 150) und ein offener Einkauf (300) über PC2 (${i1.status}/${i2.status}/${e1.status})`);
  }

  // ── 6 Receive Payment auf PC2: Doppelklick, verlorene Antwort, Eröffnungsposten nicht bezahlbar ────
  await syncRuhe();
  {
    const zahlungen = () => dbQ(BIZ_DB, `SELECT p.id, p.amount, p.invoice_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.customer_id = 'rl-kunde' ORDER BY p.created_at`);
    const r = [];
    await wechsle('/clients/rl-kunde');
    if (!(await warteBis(client, q('[data-settlement-open]'), 45000))) r.push('KEIN-KNOPF');
    r.push(await klick(client, '[data-settlement-open]'));
    await warteBis(client, "document.querySelectorAll('[data-settlement-invoice]').length === 2", 30000);
    const liste = await client.ev("return [...document.querySelectorAll('[data-settlement-invoice]')].map(e => e.getAttribute('data-settlement-invoice')).join(',');");
    const obHinweis = await exists(client, '[data-settlement-opening]');
    r.push(await setVal(client, '[data-settlement-amount]', '150'));
    await warteBis(client, "document.querySelector('[data-settlement-submit]') && !document.querySelector('[data-settlement-submit]').disabled", 20000);
    r.push(await client.ev("const b = document.querySelector('[data-settlement-submit]'); if (!b) return 'KEIN-SUBMIT'; b.click(); b.click(); return 'OK';"));
    r.push(await bestaetige(client));
    await sleep(800);
    if (await exists(client, '[data-app-confirm-ok]')) r.push('ZWEITER-DIALOG');
    await warteBis(client, "!document.querySelector('[data-settlement-dialog]')", 30000);
    await spuelen(primary);
    const z1 = zahlungen();
    ok(alleOk(r) === 'OK' && liste.split(',').length === 2 && obHinweis && z1.length === 1 && Number(z1[0].amount) === 150 && z1[0].invoice_id === INV[0].id,
      `PAY PC2 Receive Payment: Doppelklick zahlt genau einmal 150 (FIFO auf die ältere Rechnung); der Eröffnungsposten steht nicht in der Liste (${alleOk(r)} ${z1.length})`);
    // Verlorene Antwort: der Auftrag läuft am Primary, die Antwort geht verloren — dieselbe Kennung noch einmal.
    const r2 = [];
    await syncRuhe();
    await wechsle('/clients/rl-kunde');
    await warteBis(client, q('[data-settlement-open]'), 45000);
    r2.push(await klick(client, '[data-settlement-open]'));
    await warteBis(client, "document.querySelectorAll('[data-settlement-invoice]').length === 2", 30000);
    r2.push(await setVal(client, '[data-settlement-amount]', '50'));
    await warteBis(client, "document.querySelector('[data-settlement-submit]') && !document.querySelector('[data-settlement-submit]').disabled", 20000);
    await client.ev("window.__dropNext = 'customers.settle'; return 1;");
    r2.push(await klick(client, '[data-settlement-submit]'));
    r2.push(await bestaetige(client));
    const offen = await warteBis(client, q('[data-settlement-error]'), 30000);
    await spuelen(primary);
    const nachVerlust = zahlungen().length;
    r2.push(await klick(client, '[data-settlement-submit]'));
    if (await warteBis(client, q('[data-app-confirm-ok]'), 5000)) r2.push(await bestaetige(client));
    await warteBis(client, "!document.querySelector('[data-settlement-dialog]')", 30000);
    await spuelen(primary);
    await merke(client);
    const z2 = zahlungen();
    const sc = cmdsOf('customers.settle');
    const letzte = sc.slice(-2);
    ok(offen && nachVerlust === 2 && z2.length === 2 && Math.round(z2.reduce((s, x) => s + Number(x.amount), 0) * 1000) === 200000
      && letzte.length === 2 && letzte[0].commandId === letzte[1].commandId,
    `PAY PC2 verlorene Antwort: der Primary zahlte 50 genau einmal; die Wiederholung mit derselben Kennung zahlt nichts doppelt (${alleOk(r2)} ${z2.length})`);
  }

  // ── 7 Pay Supplier auf PC2: Doppelklick zahlt einmal; Eröffnungsposten gesperrt ───────────────
  await syncRuhe();
  {
    const r = [];
    await wechsle('/suppliers/rl-sup');
    if (!(await warteBis(client, q('[data-supplier-pay-open]'), 45000))) r.push('KEIN-KNOPF');
    r.push(await klick(client, '[data-supplier-pay-open]'));
    if (!(await warteBis(client, q('[data-supplier-pay-amount]'), 30000))) r.push('KEINE-MASKE');
    const gesperrt = await exists(client, '[data-supplier-pay-locked]');
    r.push(await setVal(client, '[data-supplier-pay-amount]', '120'));
    await warteBis(client, "document.querySelector('[data-supplier-pay-save]') && !document.querySelector('[data-supplier-pay-save]').disabled", 20000);
    r.push(await client.ev("const b = document.querySelector('[data-supplier-pay-save]'); if (!b) return 'KEIN-SPEICHERN:' + (document.querySelector('[role=dialog]')?.innerText || document.body.innerText).slice(0, 160); b.click(); b.click(); return 'OK';"));
    if (await warteBis(client, q('[data-app-confirm-ok]'), 5000)) r.push(await bestaetige(client));
    await warteBis(client, "!document.querySelector('[data-supplier-pay-save]')", 30000);
    await spuelen(primary);
    const ep = dbQ(BIZ_DB, 'SELECT amount, method FROM purchase_payments WHERE purchase_id = ?', [PUR?.id || '']);
    const ex = dbQ(BIZ_DB, 'SELECT paid_amount, status FROM purchases WHERE id = ?', [PUR?.id || ''])[0] || {};
    ok(alleOk(r) === 'OK' && gesperrt && ep.length === 1 && Number(ep[0].amount) === 120 && Number(ex.paid_amount) === 120,
      `PAY PC2 Pay Supplier: Doppelklick zahlt genau einmal 120; Eröffnungsposten sichtbar gesperrt (${alleOk(r)} ${ep.length})`);
  }

  // ── 8 Befehlsliste, Hauptbuch, Belege, PC2 ohne Datenbank, Prozesse ──────────────────────────────
  {
    await merke(client);
    const fremd = await sende(client, 'opening_accounts.post', { itemId: 'x' });
    ok(fremd.status >= 400 && fremd.status < 500, `REGISTRY ein nicht freigegebener Befehl wird vom Primary abgewiesen (${fremd.status})`);
    await spuelen(primary);
    const tx = dbQ(BIZ_DB, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d
                              FROM ledger_entries WHERE rowid > ? GROUP BY transaction_id`, [LEDGER_BASIS]);
    const module = [...new Set(dbQ(BIZ_DB, 'SELECT DISTINCT source_module AS m FROM ledger_entries WHERE rowid > ?', [LEDGER_BASIS]).map((x) => x.m))].sort();
    ok(tx.length > 0 && tx.every((t) => Number(t.d) === 0), `LEDGER jede Buchung dieses Laufs ausgeglichen (${tx.length} Transaktionen)`);
    ok(module.every((m) => ['INVOICE', 'PAYMENT', 'PURCHASE', 'PURCHASE_PAYMENT'].includes(m)) && !module.includes('OPENING_BALANCE') && !module.includes('STOCK_ADJUST'),
      `LEDGER nur Rechnungen und Zahlungen haben gebucht — keine Eröffnung, keine Bestandskorrektur (${module.join(',')})`);
    ok(zahl("SELECT COUNT(*) AS n FROM opening_balance_items WHERE accounting != 'PENDING'") === 0 && zahl("SELECT COUNT(*) AS n FROM opening_account_items WHERE accounting != 'PENDING'") === 0
      && zahl("SELECT COUNT(*) AS n FROM ledger_entries WHERE source_module = 'OPENING_BALANCE'") === 0,
    'LEDGER alle Eröffnungsbelege PENDING, keine Eröffnungsbuchung');
    const reg = await primary.ev('return 1;').catch(() => 0);
    ok(reg === 1 && !existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SAFETY PC2 hat keine eigene Geschäftsdatenbank angelegt');
    ok((await treffer(client)).length === 0 && ALLE_TREFFER.length === 0, 'SAFETY PC2 hat nie eine lokale Datenbank angefragt');
    const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
    ok(S(fremdVorher) === S(fremdNachher), 'ISOLATION fremde LATAIF-Prozesse (die Produktions-App) unberührt');
  }
} catch (e) {
  ok(false, 'ABBRUCH: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
} finally {
  clearTimeout(WACHHUND);
  try { steuer?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { primary?.close(); } catch { /* zu */ }
  aufraeumen();
}
console.log(`\nrelease-stock-opening-pc2 e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('RELEASE_STOCK_OPENING_PC2_E2E_PROVED');
process.exit(0);
