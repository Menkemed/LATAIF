// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P3 — Zwei-App-E2E: gemischte Rechnung (eigene Lagerware + Kommission) in der echten Test-App.
// Run: node test/e2e/mixed-invoice-p3.e2e.mjs
//
//   A  Welt über echte PC2-Befehle: eigener Einkauf (2 Artikel), vier Kommissionen zweier Einlieferer.
//   B  PC2 „Direct Sale": 2 eigene Artikel + 3 Kommissionen (2 Einlieferer), Einkaufs-VAT je Einlieferer (Pflicht),
//      E7-Hinweis und -Bestätigung (Maus), Preis per Tastatur, Teilzahlung → EIN Fernauftrag consignments.record_sale
//      mit ownLines; Primary: EINE Rechnung, je Einlieferer EIN Einkauf, Lager je Artikel −1, Audit.
//   C  Primary „Direct Sale": 1 eigener Artikel + 1 Kommission, Vollzahlung mit Nummerndialog (FINAL, sold).
//   D  PC2 zeigt die gemischte Rechnung.   E  Hauptbuch/Lager/AP/AR, PC2 ohne Datenbank, Prozess-Isolation.
//
// PROZESS-ISOLATION (aus dem Gerüst bulk-metal-pc2): gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf
// gestartet hat oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
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

const RUN = join(os.tmpdir(), 'lataif-mixed-p3', 'run-' + Date.now());
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

  // ══ MIXED-INVOICE P3 — Hilfen dieses Laufs ═══════════════════════════════════════════════════════
  /** Sichtabnahme: ein Bild der sichtbaren Maske, nur wenn LATAIF_SHOTS gesetzt ist (ändert nichts am Lauf). */
  async function foto(c, name, sel) {
    const dir = process.env.LATAIF_SHOTS || '';
    if (!dir) return;
    try {
      const fsx = await import('node:fs');
      fsx.mkdirSync(dir, { recursive: true });
      if (sel) { await c.ev(`document.querySelector(${S(sel)})?.scrollIntoView({ block: 'center' }); return 1;`); await sleep(250); }
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      fsx.writeFileSync(join(dir, name + '.png'), Buffer.from(r.data, 'base64'));
    } catch (e) { console.log('  (Foto ' + name + ' nicht möglich: ' + String(e).slice(0, 80) + ')'); }
  }
  /** Ein Fernauftrag von PC2 mit DESSEN Anmeldung, genau wie die Maske ihn schickt (Aufbau der Welt). */
  async function sende(c, op, payload) {
    const auth = (await kommandos(c)).map((x) => x.auth).find(Boolean) || '';
    const url = `http://127.0.0.1:${PORT}/api/command`;
    return JSON.parse(await c.ev(`const r = await fetch(${S(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ${S(auth)} }, body: JSON.stringify({ op: ${S(op)}, commandId: crypto.randomUUID(), payload: ${S(payload)} }) }); let b = null; try { b = await r.json(); } catch (e) { b = null; } return JSON.stringify({ status: r.status, body: b });`));
  }
  async function kommission(consignorId, name, payout) {
    const r = await sende(client, 'consignments.create', {
      consignorId, product: { brand: 'P3', name, categoryId: 'p3-cat', condition: 'Pre-Owned' }, agreedPrice: 1000, payout,
    });
    await spuelen(primary);
    return String(r.body?.value?.consignmentId || '');
  }
  const kon = (id) => zeile('consignments', id);
  const nummerWaehlen = async (c) => {
    if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Normal Final'))", 15000))) return 'KEIN-DIALOG';
    const r = [await clickIncludes(c, 'Normal Final')];
    await sleep(200);
    r.push(await clickText(c, 'Confirm'));
    return alleOk(r);
  };
  /** Der Fehlerkasten der Maske „Direct Sale". */
  const maskenFehler = async (c) => { try { const t = await c.ev("const e = document.querySelector('[data-save-error]'); return e ? 'FEHLER: ' + e.textContent : 'KEIN-FEHLERKASTEN @ ' + location.pathname;"); return String(t); } catch (e) { return 'EV-FEHLER: ' + String(e).slice(0, 200); } };
  /** Einen Kommissionsartikel in die Maske holen und Preis + Steuerart setzen (Tastatur für den Preis). */
  async function kommissionsZeile(c, id, preis, scheme) {
    const r = [await ssPick(c, 'Add a consignment item…', id)];
    if (!(await warteBis(c, `document.querySelector('[data-mixed-con-price=${S(id)}]')`, 10000))) return 'KEINE-ZEILE:' + id;
    r.push(await setVal(c, `[data-mixed-con-scheme=${S(id)}]`, scheme)); await sleep(200);
    r.push(await tippe(c, `[data-mixed-con-price=${S(id)}]`, String(preis))); await sleep(300);
    return alleOk(r);
  }
  const rechnungVon = (cid) => kon(cid).invoice_id;
  const zeilenDB = (inv) => dbQ(BIZ_DB, `SELECT il.product_id, il.quantity, ROUND(il.unit_price,3) AS u, ROUND(il.purchase_price_snapshot,3) AS c, il.tax_scheme AS t,
      ROUND(il.vat_amount,3) AS v, ROUND(il.line_total,3) AS g FROM invoice_lines il WHERE il.invoice_id = ? ORDER BY il.position, il.rowid`, [inv]);
  const einkaeufeVon = (supplierLike) => dbQ(BIZ_DB, `SELECT p.id, ROUND(p.total_amount,3) AS total, ROUND(p.remaining_amount,3) AS rest, p.status FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id WHERE s.name LIKE ? ORDER BY p.rowid`, [supplierLike]);

  // ── A Die Welt: zwei eigene Artikel mit Einkauf, vier Kommissionen von zwei Einlieferern (echte PC2-Befehle) ──
  client = await lade(client, '/purchases');
  await waitFor(client, SHELL, 30000);
  const ek = await sende(client, 'purchases.create', {
    supplierId: 'p3-sup', taxScheme: 'ZERO',
    lines: [{ mode: 'existing', productId: 'p3-own-1', quantity: 1, unitPrice: 2000 }, { mode: 'existing', productId: 'p3-own-2', quantity: 3, unitPrice: 550 }],
  });
  await spuelen(primary);
  ok(ek.body?.ok === true && zahl("SELECT SUM(qty_remaining) AS n FROM stock_lots WHERE product_id IN ('p3-own-1','p3-own-2')") === 4,
    `A eigener Einkauf über PC2: Datejust 1 Stück, Goldkette 3 Stück auf Lager (${S(ek.body?.error || 'ok')})`);
  const K1 = await kommission('p3-con-a', 'Nautilus P3', { model: 'percent', commissionRate: 20 });
  const K2 = await kommission('p3-con-a', 'Aquanaut P3', { model: 'percent', commissionRate: 20 });
  const K3 = await kommission('p3-con-b', 'Calatrava P3', { model: 'consignor_fixed' });
  const K4 = await kommission('p3-con-a', 'Ellipse P3', { model: 'percent', commissionRate: 20 });
  ok([K1, K2, K3, K4].every((k) => k && kon(k).status === 'active'), `A vier aktive Kommissionen, zwei Einlieferer (${S([K1, K2, K3, K4].map((k) => kon(k).status))})`);

  // ── B PC2: „Direct Sale" mit 2 eigenen Artikeln + 3 Kommissionen (2 Einlieferer), E7, Teilzahlung ──────────
  let INV_PC2 = '';
  {
    await syncRuhe();
    client = await lade(client, '/invoices/new');
    const r = [];
    if (!(await warteBis(client, "document.querySelector('[data-invoice-save]') && document.querySelector('[data-mixed-consignment-section]')", 45000))) r.push('KEINE-MASKE-ODER-KEIN-KOMMISSIONSTEIL');
    r.push(await ssPick(client, 'Search clients...', 'p3-kunde'));
    r.push(await ssPick(client, 'Pick product...', 'p3-own-1'));
    r.push(await clickIncludes(client, 'Add Product')); await sleep(300);
    r.push(await ssPick(client, 'Pick product...', 'p3-own-2'));
    r.push(await kommissionsZeile(client, K1, 1200, 'MARGIN'));
    r.push(await kommissionsZeile(client, K2, 1100, 'VAT_10'));
    r.push(await kommissionsZeile(client, K3, 1050, 'VAT_10'));
    // E7: Calatrava (Agreed 1.000) für 1.050 mit VAT 10 % ⇒ Provision 50, VAT 95,455 ⇒ LATAIF −45,455.
    const e7 = await warteBis(client, `/45\\.455/.test(document.querySelector('[data-mixed-con-e7=${S(K3)}]')?.innerText || '')`, 10000);
    const keinE7 = !(await exists(client, `[data-mixed-con-e7=${S(K1)}]`)) && !(await exists(client, `[data-mixed-con-e7=${S(K2)}]`));
    ok(e7 && keinE7, `B E7-Hinweis nur an der Calatrava-Zeile (−45,455), nicht an Margin/VAT-10-mit-Provision (${e7}/${keinE7})`);
    await foto(client, 'p3-b1-pc2-direktverkauf-2b-e7', `[data-mixed-con-e7=${S(K3)}]`);
    const anzeige = await client.ev(`return JSON.stringify(['${K1}','${K2}','${K3}'].map((id)=>[document.querySelector('[data-mixed-con-payout="'+id+'"]')?.innerText, document.querySelector('[data-mixed-con-share="'+id+'"]')?.innerText, document.querySelector('[data-mixed-con-vat="'+id+'"]')?.innerText]));`);
    // VAT-CONSISTENCY (v0.8.99): Margen-VAT der Nautilus-Zeile aus der Auszahlung 960 = 21,818 (nicht aus der Aufnahme-Schätzung 800 = 36,364).
    ok(/960\.000.*240\.000.*21\.818/.test(anzeige) && !/36\.364/.test(anzeige) && /880\.000.*220\.000.*100\.000/.test(anzeige) && /1,000\.000.*50\.000.*95\.455/.test(anzeige),
      `B je Zeile Auszahlung, LATAIF-Anteil, VAT wie die Buchung — Margen-VAT 21,818 aus der Auszahlung (${anzeige})`);
    // Die Einkaufs-VAT je Einlieferer ist Pflicht und nicht vorbelegt.
    const vorbelegt = await client.ev("return [...document.querySelectorAll('[data-mixed-consignor-vat]')].filter(b=>getComputedStyle(b).backgroundColor==='rgb(15, 15, 16)').length;");
    ok(Number(vorbelegt) === 0 && (await client.ev("return document.querySelectorAll('[data-mixed-consignor]').length;")) === 2,
      `B Einlieferer-Abrechnung: 2 Einlieferer, Einkaufs-VAT nicht vorbelegt (${vorbelegt})`);
    r.push(await mausKlick(client, `[data-mixed-consignor-vat="p3-con-a:ZERO"]`));
    r.push(await mausKlick(client, `[data-mixed-consignor-vat="p3-con-b:VAT_10"]`));
    r.push(await tippe(client, '[data-invoice-pay-row] [data-invoice-pay-amount]', '1000'));
    // Erster Versuch ohne E7-Bestätigung ⇒ die Maske sagt Nein, nichts geht hinaus.
    const vorEins = (await kommandos(client)).filter((x) => x.op === 'consignments.record_sale').length;
    r.push(await mausKlick(client, '[data-invoice-save]')); await sleep(900);
    const fehler1 = await maskenFehler(client);
    const nein = /with VAT 10 % the LATAIF result is negative/.test(fehler1);
    const nachEins = (await kommandos(client)).filter((x) => x.op === 'consignments.record_sale').length;
    ok(nein && nachEins === vorEins && zahl('SELECT COUNT(*) AS n FROM invoices') === 0, `B ohne E7-Bestätigung: Nein in der Maske, kein Auftrag, keine Rechnung (${fehler1.slice(0, 220)} / ${nachEins - vorEins})`);
    r.push(await mausKlick(client, `[data-mixed-con-vatack=${S(K3)}]`)); await sleep(200);
    const summe = await client.ev("return document.body.innerText.match(/\\nTOTAL\\n([0-9,]+\\.[0-9]{3})/)?.[1] || '';");
    ok(String(summe) === '6,510.000', `B Summe der Maske: 2.500 + 660 + 1.200 + 1.100 + 1.050 = 6.510 (${summe})`);
    await foto(client, 'p3-b2-pc2-einlieferer-abrechnung', '[data-mixed-consignor-settlement]');
    r.push(await mausKlick(client, '[data-invoice-save]'));
    if (!(await warteBis(client, "!document.querySelector('[data-invoice-save]')", 45000))) r.push('NICHT-GESPEICHERT:' + (await maskenFehler(client)));
    await spuelen(primary);
    INV_PC2 = rechnungVon(K1);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'consignments.record_sale');
    const body = cmds.at(-1)?.payload || {};
    ok(alleOk(r) === 'OK' && cmds.length === vorEins + 1 && Array.isArray(body.ownLines) && body.ownLines.length === 2 && body.items?.length === 3
      && body.items.find((x) => x.consignmentId === K3)?.acknowledgeVatShortfall === true
      && body.ownLines.every((l) => !('purchasePrice' in l) && !('taxScheme' in l) && !('lineTotal' in l)),
    `B EIN Fernauftrag consignments.record_sale mit 2 eigenen Zeilen als Absicht (ohne Einstand/Steuer vom Client) + 3 Kommissionen (${alleOk(r)} ${S(body.ownLines)})`);
    const z = zeilenDB(INV_PC2);
    const inv = zeile('invoices', INV_PC2);
    ok(z.length === 5 && Number(inv.gross_amount) === 6510 && inv.status === 'PARTIAL' && Number(inv.paid_amount) === 1000 && /^PINV/.test(String(inv.invoice_number)) && inv.tax_scheme_snapshot === 'mixed',
      `B Primary: EINE Rechnung, 5 Zeilen, 6.510, PINV, Teilzahlung 1.000 (${z.length} ${inv.gross_amount} ${inv.status} ${inv.invoice_number})`);
    ok(S(z.map((x) => [x.t, x.g, x.c])) === S([['MARGIN', 2500, 2000], ['VAT_10', 660, 550], ['MARGIN', 1200, 960], ['VAT_10', 1100, 880], ['VAT_10', 1050, 909.091]]),
      `B Zeilen: eigene mit Los-Einstand, Kommission mit Auszahlung als Einstand, Steuer je Zeile (${S(z.map((x) => [x.t, x.g, x.c]))})`);
    ok(Number(z[0].v) === 45.455 && Number(z[2].v) === 21.818,
      `B Margen-VAT gebucht wie angezeigt: eigene Ware 45,455, Nautilus 21,818 aus dem Einstand 960 (${S(z.map((x) => x.v))})`);
    const ea = einkaeufeVon('%Alpha%'); const eb = einkaeufeVon('%Beta%');
    ok(ea.length === 1 && Number(ea[0].total) === 1840 && Number(ea[0].rest) === 1840 && eb.length === 1 && Number(eb[0].total) === 1000,
      `B je Einlieferer EIN Einkauf: Alpha 1.840 (960 + 880), Beta 1.000 (VAT 10 %), unbezahlt (${S(ea)} ${S(eb)})`);
    ok([K1, K2, K3].every((k) => kon(k).status === 'sold' && kon(k).invoice_id === INV_PC2 && kon(k).buyer_id === 'p3-kunde') && kon(K4).status === 'active',
      'B Kommissionen 1–3 sold an den Käufer, auf DIESER Rechnung; Kommission 4 bleibt aktiv');
    ok(zahl("SELECT SUM(qty_remaining) AS n FROM stock_lots WHERE product_id = 'p3-own-1'") === 0 && zahl("SELECT SUM(qty_remaining) AS n FROM stock_lots WHERE product_id = 'p3-own-2'") === 2,
      'B Lager: Datejust 1 → 0, Goldkette 3 → 2 (je genau −1)');
    const audit = dbQ(BIZ_DB, "SELECT new_value, changed_by FROM audit_log WHERE field_name = 'mixed_invoice' AND entity_id = ?", [INV_PC2])[0] || {};
    ok(/"ownLines":2/.test(String(audit.new_value)) && String(audit.changed_by) !== '', `B Audit der gemischten Rechnung mit Handelndem (${audit.changed_by})`);
  }

  // ── C Primary: „Direct Sale" mit 1 eigenem Artikel + 1 Kommission, Vollzahlung (Nummerndialog) ───────────────
  {
    await gehFrisch(primary, '/invoices/new');
    const r = [];
    if (!(await warteBis(primary, "document.querySelector('[data-invoice-save]') && document.querySelector('[data-mixed-consignment-section]')", 45000))) r.push('KEINE-MASKE');
    r.push(await ssPick(primary, 'Search clients...', 'p3-kunde'));
    r.push(await ssPick(primary, 'Pick product...', 'p3-own-2'));
    r.push(await kommissionsZeile(primary, K4, 1500, 'ZERO'));
    r.push(await mausKlick(primary, `[data-mixed-consignor-vat="p3-con-a:ZERO"]`));
    r.push(await klick(primary, '[data-invoice-pay-full]')); await sleep(300);
    r.push(await mausKlick(primary, '[data-invoice-save]'));
    r.push(await nummerWaehlen(primary));
    if (!(await warteBis(primary, "!document.querySelector('[data-invoice-save]')", 45000))) r.push('NICHT-GESPEICHERT:' + (await maskenFehler(primary)));
    await spuelen(primary);
    const inv = zeile('invoices', rechnungVon(K4));
    const z = zeilenDB(inv.id);
    ok(alleOk(r) === 'OK' && inv.status === 'FINAL' && Number(inv.gross_amount) === 2160 && Number(inv.paid_amount) === 2160 && !/^PINV/.test(String(inv.invoice_number)) && z.length === 2,
      `C Primary: gemischte Rechnung voll bezahlt, Endnummer, 660 + 1.500 = 2.160 (${alleOk(r)} ${inv.status} ${inv.invoice_number} ${inv.gross_amount})`);
    ok(S(z.map((x) => [x.t, x.g])) === S([['VAT_10', 660], ['ZERO', 1500]]) && kon(K4).status === 'sold', `C Zeilen VAT 10 % (eigen) + Zero (Kommission) (${S(z.map((x) => [x.t, x.g]))})`);
    const st = dbQ(BIZ_DB, `SELECT stock_status FROM products WHERE id = (SELECT product_id FROM consignments WHERE id = ?)`, [K4])[0]?.stock_status;
    ok(st === 'sold', `C nach Vollzahlung ist der Kommissionsartikel verkauft (${st})`);
    const ea = einkaeufeVon('%Alpha%');
    ok(ea.length === 2 && Number(ea[1].total) === 1200, `C neuer Einkauf beim Einlieferer Alpha (1.200 = 1.500 − 20 %), der erste bleibt (${S(ea)})`);
  }

  // ── D PC2: die Rechnungsseite zeigt die gemischte Rechnung ─────────────────────────────────────────────────
  {
    await syncRuhe();
    client = await lade(client, `/invoices/${INV_PC2}`);
    const sicht = await warteBis(client, "/Nautilus P3/.test(document.body.innerText) && /Datejust P3/.test(document.body.innerText)", 30000);
    ok(sicht, 'D PC2 Rechnungsseite zeigt eigene und Kommissionsartikel der gemischten Rechnung');
  }

  // ── E Hauptbuch: jede Buchung ausgeglichen, Lager = Lose, AP = offene Einkäufe, AR = offene Rechnungen ─────
  {
    await spuelen(primary);
    const tx = dbQ(BIZ_DB, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d
                              FROM ledger_entries WHERE rowid > ? GROUP BY transaction_id`, [LEDGER_BASIS]);
    ok(tx.length > 0 && tx.every((t) => Number(t.d) === 0), `LEDGER jede Buchung dieses Laufs ausgeglichen (${tx.length} Transaktionen)`);
    const lose = zahl("SELECT COALESCE(ROUND(SUM(qty_remaining * unit_cost), 3), 0) AS n FROM stock_lots WHERE status = 'ACTIVE'");
    ok(Math.abs(konto('INVENTORY') - lose) < 0.005, `LEDGER INVENTORY ${konto('INVENTORY')} = Σ Lose ${lose}`);
    const ap = zahl(`SELECT ROUND(COALESCE((SELECT SUM(remaining_amount) FROM purchases WHERE status NOT IN ('CANCELLED','DRAFT')), 0)
      + COALESCE((SELECT SUM(amount - paid_amount) FROM expenses WHERE status != 'CANCELLED' AND supplier_id IS NOT NULL), 0), 3) AS n`);
    ok(Math.abs(-konto('ACCOUNTS_PAYABLE') - ap) < 0.005, `LEDGER AP ${-konto('ACCOUNTS_PAYABLE')} = offene Einkäufe/Ausgaben ${ap}`);
    const ar = zahl("SELECT COALESCE(ROUND(SUM(gross_amount - paid_amount), 3), 0) AS n FROM invoices WHERE status != 'CANCELLED'");
    ok(Math.abs(konto('ACCOUNTS_RECEIVABLE') - ar) < 0.005 && ar === 5510, `LEDGER AR ${konto('ACCOUNTS_RECEIVABLE')} = offene Rechnungen ${ar} (6.510 − 1.000)`);
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
console.log(`\nmixed-invoice-p3 e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('MIXED_INVOICE_P3_E2E_PROVED');
process.exit(0);
