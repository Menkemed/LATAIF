// ════════════════════════════════════════════════════════════════════════════
// PC2-SPEICHERN + PREISE — ein Lauf über Primary, PC2 (lataif-e2e-client.exe) und Handy (/mobile in Edge).
// Run: node test/e2e/pc2-save-reliability.e2e.mjs
//
//   PREIS    Artikel aus einem Einkauf: Verkaufs- und Mindestpreis über PC2, Primary und Handy, sichtbar in
//            der Collection. Einkaufspreis, Einkauf, Los und Hauptbuch bleiben unberührt (TUD-WCH-003).
//   NEIN     Eine echte Sperre zeigt ihren Grund: kein „No answer", kein offener Eintrag.
//   LOST     Verlorene Antwort: „No answer", Eintrag, „Clarify now" sagt „WAS saved" und sendet nichts.
//   NIE      Der Auftrag kam nie an: „Clarify now" sendet nichts von selbst; „Save it now" überschreibt keine
//            neueren Daten.
//   REMOVE   Unklarer Vorgang: nur nach ausdrücklicher Frage, und nie als erledigt.
//   STATUS   Verlorene Antwort beim Statuswechsel: Der nächste Schritt läuft nicht blind, der Status geht je
//            genau einmal weiter.
//   FARBE    Ausgewählte Repair-Knöpfe sind violett (Bildschirmfoto im Laufordner).
//
// PROZESS-ISOLATION wie in allen Läufen: nur `spawnTracked`, Test-Kennung, Port 3011, nie die Produktion.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import {
  killStarted, killTestImage, killTestPid, killOwnChild, spawnTracked, waitTestImageGone,
  foreignProcesses, startedPids, waitPidGone,
} from './_e2e-process.mjs';
import { edgeBrowserEndpoint, closeEdge, waitEdgeProfileGone } from './_e2e-browser.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
// Eigener Debug-Port je Lauf: ein liegengebliebener Test-Browser eines frueheren Laufs darf NIE die
// Seite sein, die hier gemessen wird — genau das hat einmal eine alte Seite als „aktuell" gezeigt.
const EDGE_CDP = 9700 + Math.floor(Math.random() * 280);
const BASE = `http://127.0.0.1:${PORT}`;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';

const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'pc2-save-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-pc2-save', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
// PC2 legt seinen Fenster-Speicher (EBWebView: Server, Ausweis, Sitzung) und seine offenen Speichervorgaenge
// (`pending-saves`) unter dem ECHTEN LocalAppData seiner Test-Kennung ab — die Umleitung ueber die Umgebung
// greift dort nicht. Ohne Neuanfang startet PC2 mit dem Ausweis eines frueheren Laufs fuer einen Server, den
// es nicht mehr gibt: keine Erststart-Maske, keine Anmeldemaske, jede Anfrage 401. Dieser Ordner gehoert nur
// der Test-Kennung (nie der Produktion) und wird deshalb zu Beginn geleert — wie APP_DATA_DIR des Primary.
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const CLIENT_LOCAL_STATE = join(REAL_LOCALAPPDATA, CLIENT_IDENT);
const STAGING_ROOT = join(APP_DATA_DIR, 'command-staging');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();

let edgeProc = null;
let edgeBrowserWs = '';
/** Den Test-Browser ueber seine EIGENE Debug-Verbindung schliessen — warum, steht in `_e2e-browser.mjs`. */
async function edgeSchliessen() {
  if (await closeEdge(edgeBrowserWs, EDGE_CDP)) edgeBrowserWs = '';
  return !edgeBrowserWs;
}
const aufraeumen = () => {
  try { killOwnChild(edgeProc); } catch { /* schon weg */ }
  // Nur der EIGENE Test-Browser (PID + Startpfad geprüft, samt Prozessbaum) — nie nach Name oder
  // Befehlszeile: jeder Lauf hat ein eigenes Profil unter RUN, ein Rest eines früheren Laufs stört nicht.
  killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe');
};
const WACHHUND = setTimeout(async () => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  await edgeSchliessen();
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  const rest = await waitEdgeProfileGone(EDGE_PROFILE);
  console.log('  ABBRUCH-AUFRAEUMEN ' + JSON.stringify({ edgeGestartet: !!edgeProc, browserZu: !edgeBrowserWs, reste: rest }));
  process.exit(1);
}, 30 * 60 * 1000);

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

// ── CDP ─────────────────────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.events = []; this.requests = []; this.antworten = []; this.paused = null;
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Network.requestWillBeSent') this.requests.push(String(m.params?.request?.url || ''));
      if (m.method === 'Network.responseReceived') {
        const u = String(m.params?.response?.url || '');
        if (/\/api\//.test(u)) this.antworten.push(u.replace(/^https?:\/\/[^/]+/, '') + ' → ' + m.params?.response?.status);
      }
      if (m.method === 'Fetch.requestPaused' && this.paused) this.paused(m.params);
      if (m.method === 'Runtime.consoleAPICalled') {
        this.events.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.events.push(`exception: ${m.params?.exceptionDetails?.exception?.description || ''}`.slice(0, 300));
      }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  async send(method, params = {}, ms = 180000) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method}: keine Antwort in ${ms / 1000} s`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

async function attachOnly(cdpPort, match, budget = 120000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && match.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(400);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function attachApp(cdpPort, exe, env) {
  spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, /tauri\.localhost/);
}

const q = (sel) => `document.querySelector(${S(sel)})`;
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; b.click(); return 'OK';`);
const text = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.textContent.trim() : '';`);
async function warteBis(c, expr, budget = 60000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    try { if (await c.ev(`return !!(${expr});`)) return true; } catch { /* Seite baut noch */ }
    await sleep(400);
  }
  return false;
}
const waitFor = (c, sel, budget = 60000) => warteBis(c, q(sel), budget);
async function warteAuf(pruef, sekunden = 30) {
  for (let i = 0; i < sekunden * 2; i++) { if (pruef()) return true; await sleep(500); }
  return false;
}
const waitInvoke = (c) => warteBis(c, 'window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke', 120000);

// ── Telefon (echte /mobile-Seite in Edge) ───────────────────────────────────
async function startEdge(url) {
  mkdirSync(EDGE_PROFILE, { recursive: true });
  edgeProc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, url,
  ], { stdio: 'ignore' });
  // Genau DIESE Seite, nicht irgendeine: der Vergleich geht gegen die volle Adresse dieses Laufs.
  const c = await attachOnly(EDGE_CDP, new RegExp('^' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 60000);
  await c.send('Network.enable', {}, 15000);
  // Die Browser-Verbindung DIESES Browsers — damit wird er am Ende geschlossen (siehe `edgeSchliessen`).
  edgeBrowserWs = await edgeBrowserEndpoint(EDGE_CDP);
  return c;
}

const TENANT = 'tenant-1', BRANCH = 'branch-main';
const P = { kauf: 'e2e-kauf', kom: 'e2e-kom', lost: 'e2e-lost', nie: 'e2e-nie', rem: 'e2e-rem', handy: 'e2e-handy' };
const REP = 'e2e-rep';
const KATEGORIE = 'e2e-cat';

function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk || daten[sp.name] !== undefined) continue;
    daten[sp.name] = /INT|REAL|NUM/.test(String(sp.type).toUpperCase()) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k]));
}

/** Der Bestand vor dem zweiten Start: Artikel, die wirklich an einem Einkauf hängen, und eine Kundenreparatur. */
function seedDaten() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const branch_id = db.prepare('SELECT id FROM branches LIMIT 1').get().id;
    const now = new Date().toISOString();
    insert(db, 'categories', { id: KATEGORIE, branch_id, name: 'E2E Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '["Pre-Owned"]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'e2e-sup', branch_id, name: 'E2E Lieferant', active: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'e2e-kunde', branch_id, first_name: 'E2E', last_name: 'Kunde', phone: '+97338100000', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'purchases', { id: 'e2e-pur', branch_id, purchase_number: 'PUR-E2E-1', supplier_id: 'e2e-sup', status: 'PAID', purchase_date: '2026-10-29', total_amount: 500, paid_amount: 500, created_at: now, updated_at: now });
    let pos = 0;
    for (const [k, id] of Object.entries(P)) {
      // Das Handy kennt nur die echten Kategorien des Hauses.
      insert(db, 'products', { id, branch_id, category_id: k === 'handy' ? 'cat-watch' : KATEGORIE, brand: 'Tudor', name: 'Black Bay ' + k, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_date: '2026-10-29', purchase_price: 500, purchase_currency: 'BHD', quantity: 1, stock_status: 'in_stock', source_type: k === 'kom' ? 'CONSIGNMENT' : 'OWN', tax_scheme: 'MARGIN', images: '[]', attributes: k === 'handy' ? JSON.stringify({ dial: 'Black', material: 'Steel' }) : '{}', created_at: now, updated_at: now });
      if (k === 'kom') continue;
      pos += 1;
      insert(db, 'purchase_lines', { id: 'pl-' + id, purchase_id: 'e2e-pur', product_id: id, quantity: 1, unit_price: 500, line_total: 500, position: pos, tax_scheme: 'ZERO', vat_rate: 0, vat_amount: 0, created_product: 1 });
      insert(db, 'stock_lots', { id: 'lot-' + id, branch_id, product_id: id, purchase_id: 'e2e-pur', purchase_line_id: 'pl-' + id, unit_cost: 500, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: '2026-10-29', created_at: now });
    }
    insert(db, 'repairs', { id: REP, branch_id, repair_number: 'REP-E2E-1', voucher_code: 'E2E-1', issue_description: 'E2E Service', status: 'diagnosed', received_at: now, diagnosed_at: now, images: '[]', item_attributes: '{}', revision: 1, repair_scope: 'CUSTOMER', customer_id: 'e2e-kunde', repair_type: 'internal', charge_to_customer: 100, tax_scheme: 'ZERO', item_brand: 'Omega', item_model: 'E2E', created_at: now, updated_at: now });
  } finally { db.close(); }
}

const artikel = (id) => dbQ(BIZ_DB, 'SELECT planned_sale_price vk, min_sale_price mind, purchase_price ek, expected_margin marge, updated_at stand FROM products WHERE id = ?', [id])[0] || {};
/** Was eine Preisänderung nie berühren darf. */
const belege = () => S(['purchases', 'purchase_lines', 'stock_lots', 'ledger_entries', 'expenses'].map((t) => dbQ(BIZ_DB, `SELECT * FROM ${t} ORDER BY rowid`)));
const status = () => String(dbQ(BIZ_DB, 'SELECT status FROM repairs WHERE id = ?', [REP])[0]?.status);
const statusWechsel = () => Number(dbQ(BIZ_DB, "SELECT COUNT(*) n FROM audit_log WHERE entity_id = ? AND action_type = 'STATUS_CHANGE'", [REP])[0]?.n || 0);
const audits = (id) => Number(dbQ(BIZ_DB, "SELECT COUNT(*) n FROM audit_log WHERE entity_id = ? AND action_type = 'UPDATE'", [id])[0]?.n || 0);
const offeneDateien = () => { const d = join(CLIENT_LOCAL_STATE, 'pending-saves'); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).length : 0; };

// Auf PC2: Aufträge mitschreiben; `__dropNext`: die Antwort geht verloren; `__blockNext`: die Anfrage geht nie hinaus.
const BEOBACHTER = `
  if (!window.__pc2Save) {
    window.__pc2Save = true;
    window.__cmds = []; window.__dropNext = null; window.__blockNext = null;
    window.alert = () => {}; window.confirm = () => true;
    const of = window.fetch;
    window.fetch = async (...a) => {
      let body = null;
      try { if (/\\/api\\/command$/.test(String(a[0] && a[0].url ? a[0].url : a[0]))) { body = JSON.parse((a[1] && a[1].body) || '{}'); if (!/\\.(get|list)$/.test(String(body.op))) window.__cmds.push(body.op); } } catch (e) { body = null; }
      if (body && window.__blockNext === body.op) { window.__blockNext = null; throw new TypeError('never sent'); }
      if (body && window.__dropNext === body.op) {
        window.__dropNext = null;
        const r0 = await of(...a);
        try { await r0.text(); } catch (e) { /* egal */ }
        throw new TypeError('lost answer');
      }
      return of(...a);
    };
  }
`;
let steuer = null;
async function lade(route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { client.close(); } catch { /* zu */ }
  await sleep(3200);
  client = await attachOnly(CLIENT_CDP, /tauri\.localhost/, 30000);
  await waitFor(client, 'a[href="/settings"]', 45000);
  return client;
}
const FEHLER = "document.querySelector('[data-save-error]')";
const fehlerText = (c) => c.ev(`return (${FEHLER}?.textContent || '').trim();`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input'); if(!e) return 'NO-INPUT';`
  + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(String(v))});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);

/** Die normale Maske der Collection: öffnen, Preise setzen. Gespeichert wird danach. */
async function maske(c, id, vk, mind) {
  const r = [];
  await warteBis(c, `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Edit')`, 45000);
  r.push(await clickText(c, 'Edit'));
  await warteBis(c, `[...document.querySelectorAll('label')].some((l) => l.textContent.trim() === 'SALE PRICE (BHD)')`, 20000);
  r.push(await setByLabel(c, 'SALE PRICE (BHD)', vk));
  if (mind !== undefined) r.push(await setByLabel(c, 'MIN SALE PRICE (BHD)', mind));
  return r.every((x) => x === 'OK') ? 'OK' : r.join(',');
}
const speichern = (c) => clickText(c, 'Save');
const zeilen = (c) => c.ev(`return document.querySelectorAll('[data-testid="pending-save-row"]').length;`);
const notiz = (c) => c.ev(`return [...document.querySelectorAll('[data-testid="pending-save-note"]')].map((n) => n.textContent).join(' | ');`);
const notizenWeg = (c) => c.ev(`[...document.querySelectorAll('[data-testid="pending-save-note"] button')].forEach((b) => b.click()); return 1;`);
const auftraege = (c, op) => c.ev(`return window.__cmds.filter((x) => x === ${S(op)}).length;`);

let primary = null, phone = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  if (!existsSync(SEED)) throw new Error('e2e_scope_seed.exe fehlt: ' + SEED);
  if (!existsSync(EDGE)) throw new Error('Edge nicht gefunden: ' + EDGE);
    const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  if (existsSync(CLIENT_LOCAL_STATE)) rmSync(CLIENT_LOCAL_STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ══ SETUP — Primary einrichten, Server-Zugang setzen, Server starten ═══════════════════════════
  primary = await attachApp(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PC2 Save Repair Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'PC2 Save Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'PC2 Save Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  const SHELL = 'a[href="/settings"]';
  await waitFor(primary, SHELL, 90000);
  // Regulaer schliessen, den Server-Zugang setzen, neu starten.
    const pid1 = startedPids().pop();
  primary.close(); primary = null;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid1} -ErrorAction Stop).CloseMainWindow()`], { encoding: 'utf8', windowsHide: true });
  if (!await waitPidGone(pid1, 120000)) killTestPid(pid1, APP);
  seedDaten();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attachApp(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL, 120000);
  await primary.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  let gesund = false;
  for (let i = 0; i < 120 && !gesund; i++) { try { gesund = (await fetch(`${BASE}/api/health`)).ok; } catch { /* noch nicht */ } if (!gesund) await sleep(500); }
  ok(gesund, 'SETUP der Primary antwortet auf dem Netz');
  const cfg = await primary.ev(`try { const v = await window.__TAURI_INTERNALS__.invoke('mobile_runtime_scope_configure', ${S({ email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH })}); return v; } catch (e) { return { fehler: String(e) }; }`);
  ok(cfg?.configured === true, `SETUP die Handy-Annahme ist eingerichtet (${S(cfg)})`);

  // PC2: frischer Rechner, normale Verbindung und Anmeldung.
  client = await attachApp(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP, /tauri\.localhost/);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await klick(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await klick(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP, /tauri\.localhost/);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await klick(client, '[data-client-signin]');
  ok(await waitFor(client, 'a[href="/settings"]', 90000), 'SETUP PC2 ist angemeldet');
  steuer = await attachOnly(CLIENT_CDP, /tauri\.localhost/, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });

  const anmeldung = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) })).json();
  const befehl = async (op, payload) => {
    const r = await fetch(`${BASE}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + anmeldung.token }, body: JSON.stringify({ op, commandId: crypto.randomUUID(), payload }) });
    return { status: r.status, body: await r.json() };
  };
  const belegeVorher = belege();

  // ══ PREIS — PC2, der gemeldete Fehler ══
  {
    await lade(`/collection/${P.kauf}`);
    ok(await maske(client, P.kauf, 850, 700) === 'OK', 'PREIS PC2 die Maske der Collection nimmt die Preise');
    await speichern(client);
    const da = await warteAuf(() => artikel(P.kauf).vk === 850);
    const a = artikel(P.kauf);
    ok(da && a.mind === 700, `PREIS PC2 Verkaufs- und Mindestpreis eines Einkaufsartikels sind gespeichert (${S(a)}; Hinweis: ${await fehlerText(client)})`);
    ok(a.ek === 500 && a.marge === 350, `PREIS PC2 Einkaufspreis bleibt, erwartete Marge folgt (${S(a)})`);
    ok(await warteBis(client, `!${FEHLER}`, 15000) && await zeilen(client) === 0, 'PREIS PC2 kein Fehler, kein offener Eintrag');
    ok(await warteBis(client, `document.body.innerText.includes('850')`, 15000), 'PREIS PC2 die Detailseite zeigt den neuen Preis');
    await lade('/collection');
    ok(await warteBis(client, `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Asking')`, 30000), 'COLLECTION PC2 die Liste ist da');
    await client.ev(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Asking').forEach((b) => b.click()); return 1;`);
    ok(await warteBis(client, `document.body.innerText.includes('850') && document.body.innerText.includes(${S(P.kauf.toUpperCase())})`, 15000), 'COLLECTION PC2 die Liste zeigt den neuen Preis');
    ok(belege() === belegeVorher, 'PREIS PC2 Einkauf, Los, Hauptbuch und Ausgaben bleiben unverändert');
  }
  // ══ PREIS — Primary, und er sieht auch, was PC2 gespeichert hat ══
  {
    await primary.ev(`location.replace('/collection/${P.kauf}'); return 1;`);
    primary.close(); await sleep(3500);
    primary = await attachOnly(APP_CDP, /tauri\.localhost/, 30000);
    await waitFor(primary, 'a[href="/settings"]', 45000);
    await primary.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
    ok(await warteBis(primary, `document.body.innerText.includes('850')`, 30000), 'COLLECTION Primary zeigt den Preis von PC2');
    ok(await maske(primary, P.kauf, 860, 710) === 'OK', 'PREIS Primary die Maske nimmt die Preise');
    await speichern(primary);
    ok(await warteAuf(() => artikel(P.kauf).vk === 860 && artikel(P.kauf).mind === 710), `PREIS Primary gespeichert (${S(artikel(P.kauf))})`);
    ok(artikel(P.kauf).ek === 500 && belege() === belegeVorher, 'PREIS Primary Einkaufspreis und Belege bleiben');
  }
  // ══ PREIS — Handy ══
  {
    phone = await startEdge(`${BASE}/mobile`);
    await waitFor(phone, '#login', 60000);
    await setVal(phone, '#email', OWNER_EMAIL);
    await setVal(phone, '#password', OWNER_PW);
    await klick(phone, '#loginBtn');
    await warteBis(phone, `document.getElementById('modePicker') && !document.getElementById('modePicker').classList.contains('hidden')`, 60000);
    await klick(phone, '.mode-btn[data-mode="scan"]');
    await waitFor(phone, '#tabSearch', 20000);
    await klick(phone, '#tabSearch');
    await setVal(phone, '#searchInput', P.handy.toUpperCase());
    await warteBis(phone, `[...document.querySelectorAll('#searchResults .hit')].some((x) => x.textContent.includes(${S(P.handy.toUpperCase())}))`, 25000);
    await phone.ev(`[...document.querySelectorAll('#searchResults .hit')].find((x) => x.textContent.includes(${S(P.handy.toUpperCase())})).click(); return 1;`);
    await waitFor(phone, '#pdEditBtn', 15000);
    await klick(phone, '#pdEditBtn');
    await warteBis(phone, `!document.getElementById('pdEditForm').classList.contains('hidden')`, 10000);
    const feld = await phone.ev(`return { ek: document.getElementById('pePurchasePrice').disabled, vk: document.getElementById('peSalePrice').disabled, mind: document.getElementById('peMinSalePrice').disabled, hinweis: document.getElementById('pePriceLock').textContent };`);
    ok(feld.ek === true && feld.vk === false && feld.mind === false && /Purchase price locked/.test(feld.hinweis), `PREIS Handy Einkaufspreis gesperrt, die beiden anderen frei (${S(feld)})`);
    await setVal(phone, '#peSalePrice', '777');
    await setVal(phone, '#peMinSalePrice', '600');
    await klick(phone, '#peSave');
    ok(await warteAuf(() => artikel(P.handy).vk === 777 && artikel(P.handy).mind === 600, 120), `PREIS Handy gespeichert (${S(artikel(P.handy))}; ${await text(phone, '#peMsg')}; Eingang: ${S(dbQ(SERVER_DB, 'SELECT state, error_code FROM mobile_upload_inbox'))}; Bindung: ${S(dbQ(SERVER_DB, 'SELECT * FROM mobile_runtime_scope'))})`);
    ok(artikel(P.handy).ek === 500 && artikel(P.handy).marge === 277 && belege() === belegeVorher, `PREIS Handy Einkaufspreis und Belege bleiben, Marge folgt (${S(artikel(P.handy))})`);
    await lade('/collection');
    await warteBis(client, `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Asking')`, 30000);
    await client.ev(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Asking').forEach((b) => b.click()); return 1;`);
    ok(await warteBis(client, `document.body.innerText.includes('777')`, 15000), 'COLLECTION PC2 zeigt den Preis vom Handy');
  }
  // ══ NEIN — eine echte Ablehnung ist eine klare Antwort ══
  {
    const r = await befehl('products.update', { id: P.kauf, purchasePrice: 999 });
    ok(r.status === 409 && r.body.error === 'PRODUCT_PURCHASE_BOUND' && !r.body.outcome && artikel(P.kauf).ek === 500, `NEIN der Einkaufspreis bleibt beim Einkauf (${S(r)})`);
    await lade(`/collection/${P.kom}`);
    ok(await maske(client, P.kom, 123) === 'OK', 'NEIN die Maske des gesperrten Artikels öffnet');
    await speichern(client);
    ok(await warteBis(client, FEHLER, 30000), 'NEIN die Maske meldet etwas');
    const t = await fehlerText(client);
    ok(/cannot be changed here/.test(t) && !/No answer/.test(t), `NEIN der echte Grund steht da, nicht „No answer" (${t})`);
    ok(await zeilen(client) === 0 && offeneDateien() === 0, `NEIN kein offener Eintrag (${offeneDateien()} Dateien)`);
    ok(artikel(P.kom).vk === null, 'NEIN nichts wurde gespeichert');
  }
  // ══ LOST — die Antwort geht verloren, gespeichert wurde ══
  {
    await lade(`/collection/${P.lost}`);
    ok(await maske(client, P.lost, 901, 801) === 'OK', 'LOST die Maske ist bereit');
    await client.ev(`window.__dropNext = 'products.update'; return 1;`);
    await speichern(client);
    ok(await warteBis(client, `/No answer from the primary/.test(${FEHLER}?.textContent || '')`, 45000), `LOST unbekanntes Ergebnis heißt „No answer" (${await fehlerText(client)})`);
    ok(await warteBis(client, `document.querySelector('[data-testid="pending-save-row"]')`, 10000) && offeneDateien() === 1, 'LOST der Vorgang steht als offen da');
    ok(await warteAuf(() => artikel(P.lost).vk === 901), 'LOST am Primary ist er angekommen');
    const vor = audits(P.lost), gesendet = await auftraege(client, 'products.update');
    ok(await klick(client, '[data-testid="pending-save-clarify"]') === 'OK', 'LOST „Clarify now"');
    ok(await warteBis(client, `/WAS saved/.test([...document.querySelectorAll('[data-testid="pending-save-note"]')].map((n) => n.textContent).join(' '))`, 20000), `LOST die Klärung sagt: war gespeichert (${await notiz(client)})`);
    ok(await zeilen(client) === 0 && offeneDateien() === 0, 'LOST danach ist nichts mehr offen');
    ok(await auftraege(client, 'products.update') === gesendet && audits(P.lost) === vor && artikel(P.lost).vk === 901, 'LOST die Klärung hat nichts gesendet und nichts geschrieben');
    await notizenWeg(client);
  }
  // ══ NIE — der Auftrag kam nie an, inzwischen hat sich der Artikel geändert ══
  {
    await lade(`/collection/${P.nie}`);
    ok(await maske(client, P.nie, 500, 400) === 'OK', 'NIE die Maske ist bereit');
    await client.ev(`window.__blockNext = 'products.update'; return 1;`);
    await speichern(client);
    ok(await warteBis(client, `/No answer from the primary/.test(${FEHLER}?.textContent || '')`, 30000) && offeneDateien() === 1, 'NIE keine Antwort: offener Eintrag');
    ok(artikel(P.nie).vk === null, 'NIE am Primary ist nichts angekommen');
    const neu = await befehl('products.update', { id: P.nie, plannedSalePrice: 910 });
    ok(neu.status === 200 && artikel(P.nie).vk === 910, `NIE inzwischen gibt es einen neueren Preis (${S(neu.body).slice(0, 120)})`);
    await klick(client, '[data-testid="pending-save-clarify"]');
    ok(await warteBis(client, `/Still no clear answer/.test([...document.querySelectorAll('[data-testid="pending-save-note"]')].map((n) => n.textContent).join(' '))`, 20000) && await zeilen(client) === 1, `NIE direkt danach bleibt es offen (${await notiz(client)})`);
    await notizenWeg(client);
    await sleep(62000);
    await klick(client, '[data-testid="pending-save-clarify"]');
    ok(await warteBis(client, `document.querySelector('[data-testid="pending-save-not-saved"]')`, 20000), 'NIE „Clarify now" sagt: nicht angekommen');
    ok(artikel(P.nie).vk === 910 && await zeilen(client) === 1, 'NIE und von selbst passiert nichts');
    await klick(client, '[data-testid="pending-save-send"]');
    ok(await warteBis(client, `/changed after this form was opened/.test([...document.querySelectorAll('[data-testid="pending-save-note"]')].map((n) => n.textContent).join(' '))`, 30000), `NIE „Save it now" überschreibt nichts Neueres (${await notiz(client)})`);
    ok(artikel(P.nie).vk === 910 && artikel(P.nie).mind === null && await zeilen(client) === 0 && offeneDateien() === 0, `NIE der neuere Preis steht, nichts ist mehr offen (${S(artikel(P.nie))})`);
    await notizenWeg(client);
  }
  // ══ REMOVE — unklar bleibt unklar ══
  {
    await lade(`/collection/${P.rem}`);
    await maske(client, P.rem, 300);
    await client.ev(`window.__blockNext = 'products.update'; return 1;`);
    await speichern(client);
    await warteBis(client, `document.querySelector('[data-testid="pending-save-row"]')`, 30000);
    await klick(client, '[data-testid="pending-save-remove"]');
    ok(await warteBis(client, `/result is still unknown/.test(document.querySelector('[data-testid="pending-save-row"]')?.textContent || '')`, 20000), 'REMOVE fragt zuerst und nennt das Ergebnis unbekannt');
    ok(await zeilen(client) === 1 && offeneDateien() === 1, 'REMOVE noch ist nichts entfernt');
    await klick(client, '[data-testid="pending-save-remove-confirm"]');
    ok(await warteBis(client, `/still NOT known/.test([...document.querySelectorAll('[data-testid="pending-save-note"]')].map((n) => n.textContent).join(' '))`, 15000), `REMOVE es heißt nicht „erledigt" (${await notiz(client)})`);
    ok(await zeilen(client) === 0 && offeneDateien() === 0 && artikel(P.rem).vk === null, 'REMOVE die Erinnerung ist weg, der Artikel unverändert');
    await notizenWeg(client);
  }
  // ══ STATUS — verlorene Antwort: kein blinder zweiter Schritt, kein doppelter Wechsel ══
  {
    await lade(`/repairs/${REP}`);
    ok(await warteBis(client, q('[data-repair-advance]'), 30000), 'STATUS der Knopf ist da');
    await client.ev(`window.__dropNext = 'repairs.update_status'; return 1;`);
    await klick(client, '[data-repair-advance]');
    ok(await warteAuf(() => status() === 'in_progress'), `STATUS am Primary ist er angekommen (${status()})`);
    ok(await warteBis(client, `document.querySelector('[data-testid="pending-save-row"]')`, 20000), 'STATUS der Vorgang ist offen und über die Leiste erreichbar');
    await sleep(1500);
    const n1 = await auftraege(client, 'repairs.update_status');
    if (await exists(client, '[data-repair-advance]')) await klick(client, '[data-repair-advance]');
    await sleep(2500);
    ok(status() === 'in_progress' && await auftraege(client, 'repairs.update_status') === n1 && statusWechsel() === 1, `STATUS der nächste Klick läuft nicht blind weiter (${status()}, ${statusWechsel()} Wechsel)`);
    await klick(client, '[data-testid="pending-save-clarify"]');
    ok(await warteBis(client, `/WAS saved/.test([...document.querySelectorAll('[data-testid="pending-save-note"]')].map((n) => n.textContent).join(' '))`, 20000), `STATUS „Clarify now" ersetzt den fehlenden Knopf (${await notiz(client)})`);
    ok(await zeilen(client) === 0 && statusWechsel() === 1, 'STATUS genau ein Wechsel');
    await notizenWeg(client);
    await lade(`/repairs/${REP}`);
    await waitFor(client, '[data-repair-advance]', 30000);
    await klick(client, '[data-repair-advance]');
    ok(await warteAuf(() => status() === 'ready'), `STATUS danach geht es normal weiter (${status()}; ${await text(client, '[data-save-error]')})`);
    ok(statusWechsel() === 2, `STATUS je Schritt genau ein Wechsel (${statusWechsel()})`);
  }
  // ══ FARBE — ausgewählte Repair-Knöpfe ══
  {
    await lade('/repairs');
    await waitFor(client, '[data-repair-filter-invoice="all"]', 30000);
    const farbe = await client.ev(`return getComputedStyle(document.querySelector('[data-repair-filter-invoice="all"]')).backgroundColor;`);
    ok(farbe === 'rgb(113, 93, 227)', `FARBE der ausgewählte Filter ist violett (${farbe})`);
    const png = await client.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(RUN, 'repair-liste.png'), Buffer.from(png.data, 'base64'));
    await lade(`/repairs/${REP}`);
    await sleep(1500);
    const png2 = await client.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(RUN, 'repair-detail.png'), Buffer.from(png2.data, 'base64'));
    console.log('  Bildschirmfotos: ' + RUN);
  }
  ok(offeneDateien() === 0, 'ENDE an PC2 ist nichts mehr offen');
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { phone?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  await edgeSchliessen();
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
}
await waitEdgeProfileGone(EDGE_PROFILE);
clearTimeout(WACHHUND);
const ZEILE = `pc2 save reliability: prices on purchased items, clear refusals, lost answers, safe clarify (${Math.round((Date.now() - T0) / 1000)}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) {
  console.log(`\nFAIL — ${ZEILE}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`\nPASS — ${ZEILE}`);
console.log('PC2_SAVE_RELIABILITY_E2E_PROVED');
