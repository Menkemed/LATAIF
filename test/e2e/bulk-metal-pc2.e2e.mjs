// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — Zwei-App-E2E (Spec 17, Z1) mit zwei echten, isolierten Anwendungen.
// Run: node test/e2e/bulk-metal-pc2.e2e.mjs
//
//   PC2 (ohne Geschäftsdatenbank) kauft Bulk-Silber (BM-0001), der Primary kauft Bulk-Gold (BM-0002),
//   PC2 verkauft einen Ring (Menge 1, 7 g, COGS vom Primary), der Primary nimmt ihn zurück (exakt ins
//   Lot), PC2 schließt das Lot mit VERLORENER Antwort (dieselbe Kennung + action_id, genau eine
//   Bewegung), beide Rechner zeigen dieselbe Seite; Hauptbuch ausgeglichen, INVENTORY = Σ Restwert.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat
// oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
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
const OWNER_PW = 'bm-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-bulk', 'run-' + Date.now());
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
// BULK METAL V1 — die Welt des Laufs und die Nachweise (Spec 17, Z1)
// ══════════════════════════════════════════════════════════════════════════════
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'suppliers', { id: 'bm-sup', branch_id, name: 'BM Lieferant', phone: '+973 1700 0888', active: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'bm-kunde', branch_id, first_name: 'BM', last_name: 'Kunde', phone: '+973 3600 0888', created_at: now, updated_at: now });
  } finally { db.close(); }
}
const lotRow = (no) => dbQ(BIZ_DB, "SELECT * FROM stock_lots WHERE unit = 'mg' AND lot_no = ?", [no])[0] || {};
const movesOf = (lotId) => dbQ(BIZ_DB, 'SELECT * FROM bulk_lot_movements WHERE lot_id = ? ORDER BY seq', [lotId]);
const konto = (acc) => zahl("SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0),3) AS n FROM ledger_entries WHERE account = ?", [acc]);
const bulkRest = () => zahl("SELECT COALESCE(SUM(remaining_value_fils),0) AS n FROM stock_lots WHERE unit = 'mg'");
const selectSetByOption = (c, optionValue, nth, value) => c.ev(`const l=[...document.querySelectorAll('select')].filter(s=>[...s.options].some(o=>o.value===${S(optionValue)})); const e=l[${nth}]; if(!e) return 'NO-SELECT:'+${S(optionValue)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e, ${S(value)}); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
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

  // ── 1 Bulk-Einkauf auf PC2 → BM-0001 ─────────────────────────────────────
  await syncRuhe();
  client = await lade(client, '/purchases/new');
  const e1 = await bulkEinkauf(client, 'silver', '925', '500', '1000');
  await spuelen(primary);
  const L1 = lotRow('BM-0001');
  ok(e1 === 'OK' && Number(L1.remaining_weight_mg) === 500000 && Number(L1.remaining_value_fils) === 1000000 && L1.sale_tax_scheme === 'MARGIN',
    `PC2-PURCHASE Bulk-Einkauf auf PC2: BM-0001 500 g / 1000 BHD (${e1} ${S([L1.lot_no, L1.remaining_weight_mg, L1.remaining_value_fils])})`);
  const pcmd = (await kommandos(client)).filter((x) => x.op === 'purchases.create');
  ok(pcmd.length === 1 && pcmd[0].payload?.lines?.[0]?.mode === 'bulk' && pcmd[0].payload.lines[0].bulk?.weightMg === 500000
    && !('lotNo' in (pcmd[0].payload.lines[0].bulk || {})), 'PC2-PURCHASE …als Absicht über purchases.create (mg/Fils, kein Lot-Wert vom Client)');
  ok(konto('INVENTORY') === 1000 && bulkRest() === 1000000, 'PC2-PURCHASE INVENTORY 1000 = Σ Restwert');

  // ── 2 Bulk-Einkauf am Primary → BM-0002 ──────────────────────────────────
  await gehFrisch(primary, '/purchases/new');
  const e2 = await bulkEinkauf(primary, 'gold', '18K', '20', '600');
  await spuelen(primary);
  const L2 = lotRow('BM-0002');
  ok(e2 === 'OK' && Number(L2.remaining_weight_mg) === 20000 && L2.metal_type === 'gold' && L2.fineness === '18K',
    `PRIMARY-PURCHASE Einkauf am Primary: BM-0002 Gold 18K 20 g (${e2})`);

  // ── 3 Verkauf auf PC2 (Ring 7 g, 25 BHD) ─────────────────────────────────
  await syncRuhe();
  client = await lade(client, '/invoices/new');
  {
    const r = [];
    if (!(await warteBis(client, "document.querySelector('[data-invoice-save]')", 45000))) r.push('KEINE-MASKE');
    r.push(await ssPick(client, 'Search clients...', 'bm-kunde'));
    r.push(await klick(client, '[data-bulk-add-invoice-line]')); await sleep(400);
    r.push(await client.ev("const b=[...document.querySelectorAll('button[title=\"Diese Zeile entfernen\"]')][0]; if(!b) return 'NO-REMOVE'; b.click(); return 'OK';")); await sleep(300);
    if (!(await warteBis(client, `document.querySelector('[data-bulk-lot-select] option[value=${S(L1.id)}]')`, 20000))) r.push('KEIN-LOT-IN-AUSWAHL');
    r.push(await setVal(client, '[data-bulk-lot-select]', L1.id)); await sleep(200);
    r.push(await setVal(client, '[data-bulk-sale-weight]', '7')); await sleep(200);
    r.push(await setVal(client, '[data-bulk-type]', 'RING'));
    r.push(await setVal(client, '[data-bulk-gross]', '25'));
    await warteBis(client, "/COGS 14\\.000/.test(document.querySelector('[data-bulk-invoice-line]')?.innerText || '')", 15000);
    const vorschau = await client.ev("return document.querySelector('[data-bulk-invoice-line]')?.innerText || '';");
    ok(/COGS 14\.000/.test(String(vorschau)), 'PC2-SALE COGS-Vorschau vom Primary: 14.000');
    r.push(await klick(client, '[data-invoice-save]'));
    if (!(await warteBis(client, "!document.querySelector('[data-invoice-save]')", 45000))) r.push('NICHT-GESPEICHERT:' + (await fehlerText(client)));
    await spuelen(primary);
    const line = dbQ(BIZ_DB, 'SELECT * FROM invoice_lines WHERE bulk_weight_mg IS NOT NULL')[0] || {};
    ok(alleOk(r) === 'OK' && Number(line.quantity) === 1 && Number(line.bulk_weight_mg) === 7000 && Number(line.bulk_cogs_fils) === 14000
      && Number(line.purchase_price_snapshot) === 14 && line.tax_scheme === 'MARGIN' && Number(line.line_total) === 25 && line.description === 'Ring · Silver 925 · 7.000 g',
    `PC2-SALE Rechnung auf PC2: Menge 1, 7 g, COGS 14, MARGIN, 25 BHD (${alleOk(r)} ${S([line.quantity, line.bulk_weight_mg, line.bulk_cogs_fils, line.line_total])})`);
    const icmd = (await kommandos(client)).filter((x) => x.op === 'invoices.create');
    const bl = icmd[0]?.payload?.lines?.[0] || {};
    ok(icmd.length === 1 && bl.kind === 'bulk' && bl.weightMg === 7000 && !('taxScheme' in bl) && !('purchasePrice' in bl) && !('bulkCogsFils' in bl),
      'PC2-SALE …als Absicht (kind bulk, mg) — kein COGS, keine Steuerart vom Client');
    const L1b = lotRow('BM-0001');
    ok(Number(L1b.remaining_weight_mg) === 493000 && Number(L1b.remaining_value_fils) === 986000, 'PC2-SALE Lot 493 g / 986 BHD');
  }
  const INV = dbQ(BIZ_DB, 'SELECT invoice_id FROM invoice_lines WHERE bulk_weight_mg IS NOT NULL')[0]?.invoice_id;

  // ── 4 Retoure am Primary (ganze Zeile, zurück ins Lot) ───────────────────
  {
    await gehFrisch(primary, `/invoices/${INV}`);
    const r = [];
    if (!(await warteBis(primary, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Create Return'))", 30000))) r.push('KEIN-RETOURE-KNOPF');
    r.push(await clickIncludes(primary, 'Create Return')); await sleep(600);
    r.push(await primary.ev("const c=[...document.querySelectorAll('input[type=checkbox]')].find(x=>!x.disabled); if(!c) return 'NO-CHECK'; c.click(); return 'OK';")); await sleep(300);
    r.push(await klick(primary, '[data-return-save]'));
    if (!(await warteBis(primary, "!document.querySelector('[data-return-save]')", 30000))) r.push('NICHT-GESPEICHERT:' + (await fehlerText(primary)));
    await spuelen(primary);
    const L1c = lotRow('BM-0001');
    const m = movesOf(L1.id).map((x) => x.kind);
    ok(alleOk(r) === 'OK' && Number(L1c.remaining_weight_mg) === 500000 && Number(L1c.remaining_value_fils) === 1000000 && m.at(-1) === 'RETURN',
      `PRIMARY-RETURN Retoure am Primary: exakt 7 g / 14 BHD zurück (${alleOk(r)} ${S(m)})`);
  }

  // ── 5 Close Lot auf PC2 — mit verlorener Antwort (gleiche action_id) ─────
  {
    await syncRuhe();
    client = await lade(client, '/bulk-metals');
    await waitFor(client, '[data-bulk-open="BM-0001"]', 45000);
    const r = [await klick(client, '[data-bulk-open="BM-0001"]')];
    await warteBis(client, "document.querySelector('[data-bulk-action=close]')", 20000);
    r.push(await klick(client, '[data-bulk-action="close"]'));
    await warteBis(client, "document.querySelector('[data-bulk-dialog=close]')", 10000);
    r.push(await setVal(client, '[data-bulk-reason]', 'Rest Abrieb')); await sleep(200);
    await client.ev("window.__dropNext = 'bulk_metals.close_lot'; return 1;");
    r.push(await klick(client, '[data-bulk-submit]'));
    const verloren = await warteBis(client, "document.querySelector('[data-save-error]') || /lost|offen|unknown|not confirmed/i.test(document.querySelector('[data-bulk-dialog]')?.innerText || '')", 30000);
    await spuelen(primary);
    const nachErstem = movesOf(L1.id).filter((x) => x.kind === 'CLOSE').length;
    ok(nachErstem === 1, `PC2-CLOSE verlorene Antwort: der Primary hat genau einmal geschlossen (${nachErstem}, Meldung ${verloren})`);
    r.push(await klick(client, '[data-bulk-submit]'));
    await warteBis(client, "!document.querySelector('[data-bulk-dialog]')", 30000);
    await spuelen(primary);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'bulk_metals.close_lot');
    const L1d = lotRow('BM-0001');
    ok(movesOf(L1.id).filter((x) => x.kind === 'CLOSE').length === 1 && cmds.length === 2 && cmds[0].commandId === cmds[1].commandId
      && cmds[0].payload?.actionId && cmds[0].payload.actionId === cmds[1].payload?.actionId,
    `PC2-CLOSE Wiederholung: dieselbe command_id und action_id, genau EINE Bewegung (${cmds.length})`);
    ok(L1d.status === 'CLOSED' && Number(L1d.remaining_weight_mg) === 0 && Number(L1d.remaining_value_fils) === 0 && konto('INVENTORY_LOSS') === 1000,
      `PC2-CLOSE Lot CLOSED, 0/0, Bestandsverlust 1000 (${alleOk(r)} ${konto('INVENTORY_LOSS')})`);
  }

  // ── 6 Seite auf beiden Rechnern gleich ───────────────────────────────────
  {
    client = await lade(client, '/bulk-metals');
    await waitFor(client, '[data-bulk-lot="BM-0002"]', 45000);
    await gehFrisch(primary, '/bulk-metals');
    await waitFor(primary, '[data-bulk-lot="BM-0002"]', 30000);
    const zeilen = (c) => c.ev("return JSON.stringify([...document.querySelectorAll('[data-bulk-lot]')].map(e=>[e.getAttribute('data-bulk-lot'), e.querySelector('[data-bulk-remaining-mg]')?.getAttribute('data-bulk-remaining-mg'), e.querySelector('[data-bulk-remaining-fils]')?.getAttribute('data-bulk-remaining-fils'), e.querySelector('[data-bulk-status]')?.getAttribute('data-bulk-status')]));");
    const zp = await zeilen(primary); const zc = await zeilen(client);
    ok(zp === zc && JSON.parse(zp).length === 2, `PAGE Bulk Metals zeigt auf Primary und PC2 dasselbe (${zc})`);
    const check = (c) => c.ev("return [...document.querySelectorAll('*')].some(e=>e.childElementCount===0 && e.textContent.trim()==='OK');");
    ok(await check(client), 'PAGE Hauptbuch-Abgleich auf PC2: OK');
  }

  // ── 7 Hauptbuch, Abstimmung, PC2 ohne Datenbank, Prozesse ────────────────
  {
    await spuelen(primary);
    const tx = dbQ(BIZ_DB, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d
                              FROM ledger_entries WHERE rowid > ? GROUP BY transaction_id`, [LEDGER_BASIS]);
    ok(tx.length > 0 && tx.every((t) => Number(t.d) === 0), `LEDGER jede Buchung dieses Laufs ausgeglichen (${tx.length} Transaktionen)`);
    ok(Math.abs(konto('INVENTORY') - bulkRest() / 1000) < 0.0005, `LEDGER INVENTORY (${konto('INVENTORY')}) = Σ Restwert (${bulkRest() / 1000})`);
    ok(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM stock_lots WHERE product_id LIKE 'bulk-%' AND unit = 'pcs'")[0]?.n === 0, 'LEDGER kein Phantom-Stück-Los');
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
console.log(`\nbulk-metal-pc2 e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('BULK_METAL_PC2_E2E_PROVED');
process.exit(0);
