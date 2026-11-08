// ════════════════════════════════════════════════════════════════════════════
// ORDER ↔ INVOICE (v0.8.99) — Zwei-App-E2E: nach „Create Invoice" zeigt die Order Betrag und Zahlstand ihrer Rechnung.
// Run: node test/e2e/order-invoice-billing.e2e.mjs
//
//   A  PC2 „Add Payment" 300 auf OIORD-02 (echte Maske).
//   B  PC2 „Create Invoice" für OIORD-01 (unbezahlt) ⇒ Order-Seite und Liste „Unpaid", Betrag 1.000, „Pay invoice".
//   C  „Pay invoice" aus der Liste öffnet genau die Rechnung; Teilzahlung 400 ⇒ Partially Paid, offen 600.
//   D  Rest 600 ⇒ Paid, kein Zahlknopf mehr.
//   E  OIORD-02 umwandeln ⇒ Anzahlung 300 genau einmal angerechnet, Partially Paid, offen 700.
//   F  PC2 „Edit Invoice": Preis 1.000 → 1.100 (Tastatur) ⇒ Order 1.100, ursprünglich 1.000, offen 800.
//   G  Primary-Liste (eigener Lesepfad) zeigt denselben Stand.   H  Neustart des Primary: PC2 und Primary unverändert.
//   I  Datenbank: Auftragspreise unverändert, keine neue Anzahlung, Hauptbuch ausgeglichen, AR, Isolation.
//
// PROZESS-ISOLATION (Gerüst P3): gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf
// gestartet hat oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// Den Datenort prüfen `e2ePreflight` (Zeiger) und die Laufzeitsperre der Test-App (lib.rs).
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
const OWNER_PW = 'oi-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-order-invoice', 'run-' + Date.now());
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
    // ORDER ↔ INVOICE — zwei fertige normale Aufträge über je 1.000 (Zero), Artikel ohne Los, noch ohne Zahlung.
    for (const [n, nr] of [[1, 'OIORD-01'], [2, 'OIORD-02']]) {
      insert(db, 'products', { id: `oi-prod-${n}`, branch_id, category_id: 'p3-cat', brand: 'OI', name: `Order Uhr ${n}`, sku: `OI-SKU-0${n}`, quantity: 1,
        condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD', planned_sale_price: 1000, stock_status: 'in_stock',
        tax_scheme: 'ZERO', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'orders', { id: `oi-ord-${n}`, branch_id, order_number: nr, customer_id: 'p3-kunde', requested_brand: 'OI', requested_model: `Uhr ${n}`,
        status: 'completed', agreed_price: 1000, type: 'normal', created_at: now, updated_at: now });
      insert(db, 'order_lines', { id: `oi-line-${n}`, order_id: `oi-ord-${n}`, product_id: `oi-prod-${n}`, description: `Order Uhr ${n}`, quantity: 1,
        unit_price: 1000, line_total: 1000, position: 0, tax_scheme: 'ZERO', vat_rate: 0, is_customer_facing: 1, status: 'ARRIVED', created_at: now });
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

  // ══ ORDER ↔ INVOICE — Hilfen dieses Laufs ═══════════════════════════════════════════════════════════
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
  const O1 = 'oi-ord-1', O2 = 'oi-ord-2';
  /** Zahl aus einer Anzeige wie „1,100.000 BHD". */
  const betrag = (t) => (t == null ? NaN : Number(String(t).replace(/[^0-9.]/g, '')));
  /** Die Zeile der Auftragsliste: Status-Plakette, Betrag, ganze Zeile. */
  const listeZeile = async (c, oid) => JSON.parse(await c.ev(`const s=document.querySelector('[data-order-pay-status="${oid}"]'); const t=document.querySelector('[data-order-total="${oid}"]');
    let row=s; for(let i=0;i<6&&row&&!(row.innerText||'').includes('OIORD');i++) row=row.parentElement;
    return JSON.stringify({ status: s ? s.textContent.trim() : null, total: t ? t.innerText.replace(/\\s+/g,' ').trim() : null, row: row ? row.innerText.replace(/\\s+/g,' ').trim() : null, pay: (document.querySelector('[data-pay-order="${oid}"]')||{}).textContent || null });`));
  /** Die Preisübersicht der Order-Seite. */
  const detail = async (c) => JSON.parse(await c.ev(`const g=(s)=>{const e=document.querySelector(s); return e ? e.innerText.replace(/\\s+/g,' ').trim() : null;};
    return JSON.stringify({ total: g('[data-order-invoice-total]'), agreed: g('[data-order-agreed]'), paid: g('[data-order-paid]'), remaining: g('[data-order-remaining]'), status: g('[data-order-pay-status]'), payBtn: !!document.querySelector('[data-order-pay-invoice]') });`));
  /** Das Zahlfeld im offenen Dialog (letztes Zahlenfeld der Seite) markieren und per Tastatur füllen. */
  async function dialogBetrag(c, wert) {
    const m = await c.ev("const l=[...document.querySelectorAll('input[type=number]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.setAttribute('data-e2e-betrag','1'); return 'OK';");
    if (m !== 'OK') return 'KEIN-BETRAGSFELD';
    return tippe(c, '[data-e2e-betrag]', String(wert));
  }
  const DIALOG_OK = "const m=[...document.querySelectorAll('[role=\"dialog\"], .fixed')].find((d)=>d.querySelector('[data-testid=\"order-invoice-date\"]'));"
    + "const b=m&&[...m.querySelectorAll('button')].filter((x)=>x.textContent.trim()==='Create Invoice').pop(); if(!b) return 'NO'; if(b.disabled) return 'DISABLED'; b.click(); return 'OK';";
  /** PC2: Order öffnen, „Create Invoice", im Dialog bestätigen (Standardnummer). Rückgabe: die neue Rechnung. */
  async function umwandeln(oid, nr) {
    await syncRuhe();
    client = await lade(client, `/orders/${oid}`);
    if (!(await warteBis(client, `document.body.innerText.includes(${S(nr)})`, 40000))) return { r: 'KEINE-ORDER' };
    const r = [await clickText(client, 'Create Invoice')];
    if (!(await warteBis(client, "!!document.querySelector('[data-testid=\"order-invoice-date\"]')", 15000))) r.push('KEIN-DIALOG');
    r.push(await client.ev(DIALOG_OK));
    const da = await warteAuf(() => !!zeile('orders', oid).invoice_id, 60);
    return { r: da ? alleOk(r) : 'NICHT-UMGEWANDELT:' + alleOk(r), inv: String(zeile('orders', oid).invoice_id || '') };
  }
  /** PC2: auf der Rechnungsseite „Record Payment" mit Betrag per Tastatur, bar, bestätigen. */
  async function rechnungZahlen(inv, wert) {
    const vorher = Number(zeile('invoices', inv).paid_amount || 0);
    const r = [];
    if (!(await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Record Payment'))", 30000))) r.push('KEIN-KNOPF');
    r.push(await clickIncludes(client, 'Record Payment'));
    if (!(await warteBis(client, "!!document.querySelector('[data-record-payment]')", 10000))) r.push('KEIN-DIALOG');
    r.push(await dialogBetrag(client, wert));
    await clickText(client, 'Cash');
    r.push(await mausKlick(client, '[data-record-payment]'));
    // Macht die Zahlung die Rechnung voll bezahlt, fragt die App vorher die Nummernart (Normal / Special Final).
    if (await warteBis(client, "!!document.querySelector('[data-final-number-confirm]')", 4000)) {
      r.push(await clickIncludes(client, 'Normal Final'));
      await sleep(200);
      r.push(await mausKlick(client, '[data-final-number-confirm]'));
    }
    const da = await warteAuf(() => Math.abs(Number(zeile('invoices', inv).paid_amount || 0) - vorher - wert) < 0.005, 60);
    return da ? alleOk(r) : 'NICHT-GEBUCHT:' + alleOk(r) + ' ' + (await client.ev("return (document.querySelector('[data-record-payment-error]')||{}).textContent||'';"));
  }
  const liste = async () => { client = await lade(client, '/orders'); await warteBis(client, `!!document.querySelector('[data-order-pay-status="${O1}"]')`, 40000); await sleep(800); };
  const orderSeite = async (oid) => { client = await lade(client, `/orders/${oid}`); await warteBis(client, "!!document.querySelector('[data-order-paid]')", 40000); await sleep(1200); };

  // ── A PC2: Anzahlung 300 auf Order 2 über „Add Payment" (echte Maske) ─────────────────────────────────────
  {
    await syncRuhe();
    client = await lade(client, `/orders/${O2}`);
    const r = [];
    if (!(await warteBis(client, "document.body.innerText.includes('OIORD-02')", 40000))) r.push('KEINE-ORDER');
    r.push(await clickIncludes(client, 'Add Payment'));
    if (!(await warteBis(client, "!!document.querySelector('[data-save-order-payment]')", 10000))) r.push('KEIN-DIALOG');
    r.push(await dialogBetrag(client, 300));
    await clickText(client, 'Cash');
    r.push(await mausKlick(client, '[data-save-order-payment]'));
    const da = await warteAuf(() => dbQ(BIZ_DB, 'SELECT id FROM order_payments WHERE order_id = ?', [O2]).length === 1, 60);
    const op = dbQ(BIZ_DB, 'SELECT amount, method FROM order_payments WHERE order_id = ?', [O2]);
    ok(da && alleOk(r) === 'OK' && op.length === 1 && Number(op[0].amount) === 300, `A PC2 Anzahlung 300 auf OIORD-02 über die Maske (${alleOk(r)} ${S(op)})`);
  }

  // ── B PC2: Order 1 (unbezahlt) umwandeln ⇒ Order zeigt „Unpaid" mit dem Rechnungsbetrag ─────────────────────
  let INV1 = '';
  {
    const u = await umwandeln(O1, 'OIORD-01');
    INV1 = u.inv;
    const inv = zeile('invoices', INV1);
    ok(u.r === 'OK' && Number(inv.gross_amount) === 1000 && Number(inv.paid_amount) === 0,
      `B PC2 „Create Invoice": Rechnung 1.000, unbezahlt (${u.r} ${inv.invoice_number} ${inv.status} ${inv.paid_amount})`);
    await orderSeite(O1);
    const d = await detail(client);
    ok(/^Unpaid/.test(d.status || '') && betrag(d.total) === 1000 && betrag(d.paid) === 0 && betrag(d.remaining) === 1000 && d.payBtn,
      `B Order-Seite: Unpaid, Rechnungsbetrag 1.000, offen 1.000, „Pay on invoice" (${S(d)})`);
    await foto(client, 'oi-b-order-unpaid', '[data-order-paid]');
    await liste();
    const z = await listeZeile(client, O1);
    ok(z.status === 'Unpaid' && /Pay invoice/.test(z.pay || '') && /1,000\.000/.test(z.row || ''), `B Auftragsliste: Unpaid, „Pay invoice" (${S(z)})`);
  }

  // ── C „Pay invoice" aus der Liste ⇒ die richtige Rechnung; Teilzahlung 400 ⇒ Partially Paid, offen 600 ──────
  {
    const k = await mausKlick(client, `[data-pay-order="${O1}"]`);
    const ziel = await warteBis(client, `location.pathname === ${S('/invoices/' + INV1)}`, 15000);
    ok(k === 'OK' && ziel, `C „Pay invoice" öffnet genau die Rechnung der Order (${k} ${await client.ev('return location.pathname;')})`);
    const z1 = await rechnungZahlen(INV1, 400);
    ok(z1 === 'OK' && Number(zeile('invoices', INV1).paid_amount) === 400, `C Teilzahlung 400 auf der Rechnung (${z1})`);
    await liste();
    const z = await listeZeile(client, O1);
    ok(z.status === 'Partially Paid' && /400\.000/.test(z.row || '') && /600\.000/.test(z.row || ''), `C Liste: Partially Paid, bezahlt 400, offen 600 (${S(z)})`);
    await orderSeite(O1);
    const d = await detail(client);
    ok(/^Partially Paid/.test(d.status || '') && betrag(d.paid) === 400 && betrag(d.remaining) === 600, `C Order-Seite: Partially Paid, 400 / offen 600 (${S(d)})`);
    await foto(client, 'oi-c-order-partially-paid', '[data-order-paid]');
  }

  // ── D Rest 600 ⇒ Paid ─────────────────────────────────────────────────────────────────────────────────
  {
    await clickIncludes(client, 'Pay on invoice');
    await warteBis(client, `location.pathname === ${S('/invoices/' + INV1)}`, 15000);
    const z1 = await rechnungZahlen(INV1, 600);
    ok(z1 === 'OK' && zeile('invoices', INV1).status === 'FINAL', `D Rest 600 bezahlt, Rechnung FINAL (${z1} ${zeile('invoices', INV1).status})`);
    await orderSeite(O1);
    const d = await detail(client);
    ok(/^Paid/.test(d.status || '') && betrag(d.paid) === 1000 && betrag(d.remaining) === 0 && !d.payBtn, `D Order-Seite: Paid, offen 0, kein Zahlknopf mehr (${S(d)})`);
    await liste();
    const z = await listeZeile(client, O1);
    ok(z.status === 'Paid' && !z.pay, `D Liste: Paid, kein „Pay" (${S(z)})`);
  }

  // ── E Order 2 mit Anzahlung 300 umwandeln ⇒ einmal angerechnet, Partially Paid, offen 700 ───────────────────
  let INV2 = '';
  {
    const u = await umwandeln(O2, 'OIORD-02');
    INV2 = u.inv;
    const inv = zeile('invoices', INV2);
    const pays = dbQ(BIZ_DB, 'SELECT method, amount FROM payments WHERE invoice_id = ?', [INV2]);
    ok(u.r === 'OK' && Number(inv.gross_amount) === 1000 && Number(inv.paid_amount) === 300 && pays.length === 1 && pays[0].method === 'order_deposit'
      && dbQ(BIZ_DB, 'SELECT id FROM order_payments WHERE order_id = ?', [O2]).length === 1,
    `E Rechnung 1.000, Anzahlung 300 genau einmal angerechnet (${u.r} ${S(pays)})`);
    await orderSeite(O2);
    const d = await detail(client);
    ok(/^Partially Paid/.test(d.status || '') && betrag(d.paid) === 300 && betrag(d.remaining) === 700, `E Order-Seite: Partially Paid, 300 / offen 700 — nicht doppelt (${S(d)})`);
  }

  // ── F PC2 „Edit Invoice": Preis 1.000 → 1.100 (Tastatur) ⇒ Order zeigt 1.100, ursprünglich 1.000 ───────────────
  {
    await syncRuhe();
    client = await lade(client, `/invoices/${INV2}/edit`);
    const r = [];
    if (!(await warteBis(client, "!!document.querySelector('[data-invoice-line-gross=\"0\"]')", 40000))) r.push('KEINE-MASKE');
    await sleep(1200);
    r.push(await tippe(client, '[data-invoice-line-gross="0"]', '1100'));
    r.push(await tippe(client, 'textarea[placeholder^="Explain why this invoice"]', 'E2E: Preis mit dem Kunden neu vereinbart'));
    await sleep(400);
    r.push(await mausKlick(client, '[data-invoice-save]'));
    const da = await warteAuf(() => Number(zeile('invoices', INV2).gross_amount) === 1100, 60);
    ok(da && alleOk(r) === 'OK', `F Rechnungspreis 1.000 → 1.100 über die Maske gespeichert (${alleOk(r)} ${zeile('invoices', INV2).gross_amount} ${await fehlerText(client)})`);
    await orderSeite(O2);
    const d = await detail(client);
    ok(betrag(d.total) === 1100 && betrag(d.agreed) === 1000 && betrag(d.paid) === 300 && betrag(d.remaining) === 800 && /^Partially Paid/.test(d.status || ''),
      `F Order-Seite: Rechnungsbetrag 1.100, ursprünglich 1.000, bezahlt 300, offen 800 (${S(d)})`);
    await foto(client, 'oi-f-order-price-changed', '[data-order-invoice-total]');
    await liste();
    const z = await listeZeile(client, O2);
    ok(/1,100\.000/.test(z.total || '') && /agreed 1,000\.000/.test(z.total || '') && z.status === 'Partially Paid', `F Liste: Betrag 1.100 mit „agreed 1.000" (${S(z)})`);
    await foto(client, 'oi-f-order-list', `[data-order-total="${O2}"]`);
  }

  // ── G Primary (eigener Lesepfad) zeigt denselben Stand ──────────────────────────────────────────────────
  const primaryStand = async () => {
    await gehFrisch(primary, '/orders');
    await warteBis(primary, `!!document.querySelector('[data-order-pay-status="${O2}"]')`, 30000);
    await sleep(800);
    return [await listeZeile(primary, O1), await listeZeile(primary, O2)];
  };
  {
    const [a, b] = await primaryStand();
    ok(a.status === 'Paid' && b.status === 'Partially Paid' && /1,100\.000/.test(b.total || ''), `G Primary-Liste: OIORD-01 Paid, OIORD-02 Partially Paid 1.100 (${a.status} / ${b.status} ${b.total})`);
  }

  // ── H Neustart des Primary; danach PC2 und Primary: derselbe Stand ─────────────────────────────────────────
  {
    await spuelen(primary);
    primary.close(); primary = null;
    // Nur die eigene Primary-Test-App: closeTestWindow schließt eine PID nur, wenn sie JETZT am exakten Test-Pfad läuft.
    let zu = false;
    for (const p of startedPids().reverse()) { if (await closeTestWindow(p, APP)) { zu = true; break; } }
    ok(zu, 'H die Primary-Test-App regulär geschlossen (eigene PID, exakter Test-Pfad)');
    await waitTestImageGone('lataif.exe');
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
    let oben = false; const end = Date.now() + 60000;
    while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ } await sleep(500); }
    ok(oben, 'H Primary neu gestartet und wieder im Netz');
    await liste();
    const a = await listeZeile(client, O1), b = await listeZeile(client, O2);
    ok(a.status === 'Paid' && b.status === 'Partially Paid' && /1,100\.000/.test(b.total || '') && /800\.000/.test(b.row || ''),
      `H PC2 nach Neustart: OIORD-01 Paid, OIORD-02 Partially Paid 1.100 / offen 800 (${S([a.status, b.status, b.total])})`);
    const [pa, pb] = await primaryStand();
    ok(pa.status === 'Paid' && pb.status === 'Partially Paid', `H Primary nach Neustart: derselbe Stand (${pa.status} / ${pb.status})`);
  }

  // ── I Datenbank: Auftragspreise unverändert, keine zusätzliche Anzahlung, Hauptbuch, Isolation ───────────────
  {
    await spuelen(primary);
    ok(Number(zeile('orders', O1).agreed_price) === 1000 && Number(zeile('orders', O2).agreed_price) === 1000,
      'I Auftragspreise bleiben 1.000 (nichts an der Order geschrieben)');
    ok(dbQ(BIZ_DB, 'SELECT id FROM order_payments WHERE order_id = ?', [O1]).length === 0 && dbQ(BIZ_DB, 'SELECT id FROM order_payments WHERE order_id = ?', [O2]).length === 1,
      'I keine neue Order-Anzahlung durch das Bezahlen der Rechnungen');
    ok(zeile('invoices', INV1).status === 'FINAL' && Number(zeile('invoices', INV2).paid_amount) === 300 && Number(zeile('invoices', INV2).gross_amount) === 1100,
      `I Rechnungen: ${zeile('invoices', INV1).invoice_number} FINAL 1.000; ${zeile('invoices', INV2).invoice_number} 1.100, bezahlt 300`);
    const tx = dbQ(BIZ_DB, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d
                              FROM ledger_entries WHERE rowid > ? GROUP BY transaction_id`, [LEDGER_BASIS]);
    ok(tx.length > 0 && tx.every((t) => Number(t.d) === 0), `LEDGER jede Buchung dieses Laufs ausgeglichen (${tx.length} Transaktionen)`);
    const ar = zahl("SELECT COALESCE(ROUND(SUM(gross_amount - paid_amount), 3), 0) AS n FROM invoices WHERE status != 'CANCELLED'");
    ok(Math.abs(konto('ACCOUNTS_RECEIVABLE') - ar) < 0.005 && ar === 800, `LEDGER AR ${konto('ACCOUNTS_RECEIVABLE')} = offene Rechnungen ${ar}`);
    ok(Math.abs(konto('CUSTOMER_DEPOSITS')) < 0.005, `LEDGER Kundenanzahlungen 0 (angerechnet) (${konto('CUSTOMER_DEPOSITS')})`);
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
console.log(`\norder-invoice-billing e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('ORDER_INVOICE_BILLING_E2E_PROVED');
process.exit(0);
