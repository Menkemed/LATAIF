// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — Stammdaten, Schnellanlagen und Inventur, zwei echte Anwendungen.
// Run: node test/e2e/r6c-masterdata-inventory.e2e.mjs
//
//   QUICK   „+ New Supplier" an allen drei Stellen (Lieferantenliste, Einkauf, Werkstatt) → suppliers.create,
//           sofort in der Auswahl; Primary == PC2
//   MASTER  Lieferant ändern + deaktivieren → suppliers.update · Agent ändern → agents.update ·
//           Partner anlegen/ändern → partners.* · Mitarbeiter anlegen/Status/ändern → employees.*
//   INV     beginnen → zählen → speichern (verlorene Antwort: dieselbe Kennung, genau eine Wirkung) →
//           wieder öffnen → fremde Änderung am Primary → alte Fassung auf PC2 abgewiesen → abschließen;
//           Zwilling Primary == PC2; Einzel-Check am Artikel
//   SAFETY  PC2 mit einer ALTEN lataif.db im Datenordner: unberührt, kein Aufruf des eigenen Kerns,
//           keine lokale Datenbank, keine neue Datei
//
// PROZESS-ISOLATION (dauerhafte Regel): gestartet wird nur über `spawnTracked`, beendet wird nur, was
// dieser Lauf gestartet hat (PID mit Pfadprüfung) oder was am EXAKTEN Test-Pfad läuft. Die installierte
// Produktions-App wird nie beendet, nie benutzt.
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
const OWNER_PW = 'r6c-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r6c', 'run-' + Date.now());
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
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  aufraeumen();
  process.exit(1);
}, 40 * 60 * 1000);

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
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
/** Den Knopf `knopf` in der Karte, die `karte` zeigt (nicht den ersten gleichnamigen der Seite). */
// Die KLEINSTE Umgebung des Knopfs, die den Kartennamen zeigt, darf nur diesen einen Knopf enthalten —
// sonst wäre es das Raster mit allen Karten, und der erste „Edit" der Seite gehörte einer anderen Karte.
const clickInCard = (c, karte, knopf) => c.ev(`const kandidaten=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(knopf)}); for (const x of kandidaten) { let p=x; for(let i=0;i<10&&p;i++){ p=p.parentElement; if(!p) break; if ((p.innerText||'').includes(${S(karte)})) { const eigene=[...p.querySelectorAll('button')].filter(y=>y.textContent.trim()===${S(knopf)}); if (eigene.length===1) { x.click(); return 'OK'; } break; } } } return 'NO';`);
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

// Der Beobachter: Fernaufträge, Datenbankgriffe, Kern-Aufrufe, Dialoge — und EINE verlorene Antwort auf Wunsch.
const BEOBACHTER = `
  if (window.__r6cInstalliert) { /* schon da */ } else {
  window.__r6cInstalliert = true;
  window.__cmds = []; window.__dbHits = []; window.__invokes = []; window.__alerts = []; window.__dropNext = null;
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
    if (t && t.invoke && !t.__r6c) {
      const oi = t.invoke.bind(t);
      t.invoke = (cmd, args, opts) => { window.__invokes.push(String(cmd)); return oi(cmd, args, opts); };
      t.__r6c = true;
    } else if (!t || !t.__r6c) setTimeout(haken, 30);
  })();
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload }); } catch (e) { /* kein lesbarer Rumpf */ }
    }
    if (body && window.__dropNext && body.op === window.__dropNext) {
      // Die Anfrage GEHT hinaus und wird am Primary ausgeführt — nur die Antwort kommt nie an.
      window.__dropNext = null;
      const r = await of(...a);
      try { await r.text(); } catch (e) { /* egal */ }
      throw new TypeError('R6C: simulated lost response');
    }
    return of(...a);
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
async function lade(c, route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
const gehZu = async (p, route, merkmal) => { await geh(p, route); await warteBis(p, 'document.body.innerText.includes(' + S(merkmal) + ')', 20000); await sleep(700); };
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)) && !/^store\.|^page\.|^domain\.|^session\./.test(String(x.op)));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const aufrufe = (c) => c.ev('return JSON.stringify(window.__invokes || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const fehlerAnzeige = (c) => c.ev("return [...document.querySelectorAll('[data-save-error]')].map(e=>e.textContent).join(' | ');");
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
const norm = (r, ohne) => S(Object.fromEntries(Object.entries(r || {}).filter(([k]) => !ohne.test(k)).sort(([a], [b]) => a.localeCompare(b))));
const ZEIT = /^(id|name|created_at|updated_at|created_by)$/;
const lieferant = (name) => dbQ(BIZ_DB, 'SELECT * FROM suppliers WHERE name = ?', [name])[0];
const lieferantId = (id) => dbQ(BIZ_DB, 'SELECT * FROM suppliers WHERE id = ?', [id])[0] || {};
const agent = (id) => dbQ(BIZ_DB, 'SELECT * FROM agents WHERE id = ?', [id])[0] || {};
const partner = (name) => dbQ(BIZ_DB, 'SELECT * FROM partners WHERE name = ?', [name])[0];
const mitarbeiter = (name) => dbQ(BIZ_DB, 'SELECT * FROM employees WHERE name = ?', [name])[0];
const offeneLaeufe = () => dbQ(BIZ_DB, "SELECT session_id, revision, status FROM inventory_sessions WHERE status = 'open'");
const lauf = (sid) => dbQ(BIZ_DB, 'SELECT session_id, revision, status FROM inventory_sessions WHERE session_id = ?', [sid])[0] || {};
const blatt = (sid) => dbQ(BIZ_DB, 'SELECT product_id, status, notes, applied_check_id FROM inventory_session_items WHERE session_id = ? ORDER BY product_id', [sid]);
const checks = () => dbQ(SERVER_DB, 'SELECT check_id, product_id, status, notes, checked_by, source, request_id, created_at FROM stock_checks ORDER BY created_at, check_id');
const INV = ['r6c-inv-1', 'r6c-inv-2', 'r6c-inv-3', 'r6c-inv-4'];

// ── Die Welt des Laufs ──
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'r6c-cat', branch_id, name: 'R6C Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    for (const id of INV) {
      insert(db, 'products', { id, branch_id, category_id: 'r6c-cat', brand: 'Tudor', name: 'R6C ' + id, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: 220, tax_scheme: 'VAT_10', stock_status: 'in_stock', quantity: 1, days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', revision: 1, created_at: now, updated_at: now });
    }
    for (const t of ['P', 'C']) {
      insert(db, 'suppliers', { id: `r6c-sup-${t}`, branch_id, name: `R6C Stamm ${t}`, phone: '+973 1700 0000', email: 'alt@r6c.bh', address: 'Manama', active: 1, created_at: now, updated_at: now });
      insert(db, 'agents', { id: `r6c-agent-${t}`, branch_id, name: `R6C Agent ${t}`, commission_rate: 10, active: 1, total_sales: 500, total_commission: 50, created_at: now, updated_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

async function neuerLieferantListe(c, name) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Supplier')", 30000))) return 'KEIN-KNOPF';
  const r = [await clickText(c, 'New Supplier')];
  if (!(await warteBis(c, "document.querySelector('[data-supplier-create-save]')", 15000))) return 'KEINE-MASKE';
  r.push(await setByLabel(c, 'NAME', name));
  r.push(await setByLabel(c, 'EMAIL', 'kontakt@r6c.bh'));
  r.push(await setByLabel(c, 'ADDRESS', 'Riffa'));
  r.push(await setByLabel(c, 'CPR / ID NUMBER', '900111222'));
  await sleep(250);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R6C Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R6C Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R6C Admin');
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
  ok(true, 'CONNECT frischer Rechner ohne Datenbank, Anmeldung — dann die normale Anwendung');
  await beobachterLegen();

  // Die ALTE Geschäftsdatei im Datenordner von PC2 — sie darf in keinem Schritt angefasst werden.
  await spuelen(primary);
  mkdirSync(CLIENT_DATA_DIR, { recursive: true });
  const STALE = join(CLIENT_DATA_DIR, 'lataif.db');
  copyFileSync(BIZ_DB, STALE);
  const staleVorher = sha(STALE);
  const dateienVorher = readdirSync(CLIENT_DATA_DIR).sort();

  // ══════════════════════════════════════════════════════════════════════
  // QUICK 1 — „New Supplier" in der Lieferantenliste → suppliers.create
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/suppliers');
    const vorher = (await buchungen(client)).length;
    { const m = await neuerLieferantListe(client, '  R6C Liste C  '); ok(m === 'OK', `QUICK-LIST die Maske am zweiten Rechner (${m})`); }
    await click(client, '[data-supplier-create-save]');
    ok(await warteAuf(() => !!lieferant('R6C Liste C')), `QUICK-LIST der Lieferant steht am Primary — getrimmt (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    const c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'suppliers.create' && S(Object.keys(c[0].payload).sort()) === S(['address', 'cpr', 'email', 'name']) && c[0].payload.name === 'R6C Liste C',
      `QUICK-LIST genau EIN Auftrag suppliers.create — nur die Eingaben, getrimmt (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    ok(await warteBis(client, "!document.querySelector('[data-supplier-create-save]') && document.body.innerText.includes('R6C Liste C')", 15000),
      'QUICK-LIST die Maske schließt, der neue Lieferant steht sofort in der Liste');
    await gehZu(primary, '/suppliers', 'Suppliers');
    await primary.ev(DIALOGE_PRIMARY);
    { const m = await neuerLieferantListe(primary, '  R6C Liste P  '); ok(m === 'OK', `QUICK-LIST-PARITAET dieselbe Maske am Primary (${m})`); }
    await click(primary, '[data-supplier-create-save]');
    ok(await warteAuf(() => !!lieferant('R6C Liste P')), 'QUICK-LIST-PARITAET der Primary legt an');
    ok(norm(lieferant('R6C Liste P'), ZEIT) === norm(lieferant('R6C Liste C'), ZEIT), `QUICK-LIST-PARITAET Lieferant: Primary == PC2 (${norm(lieferant('R6C Liste C'), ZEIT)})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // QUICK 2 — „+ New Supplier" im Einkauf → dieselbe Buchung, danach gewählt
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/purchases/new');
    ok(await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('New Supplier'))", 45000), 'QUICK-PURCHASE der Knopf im Einkauf');
    const vorher = (await buchungen(client)).length;
    await clickIncludes(client, 'New Supplier');
    await waitFor(client, '[data-purchase-new-supplier-save]', 15000);
    ok(await setVal(client, 'input[placeholder="e.g. Gold Dealer LLC"]', ' R6C Einkauf C ') === 'OK', 'QUICK-PURCHASE Name eingetragen');
    await click(client, '[data-purchase-new-supplier-save]');
    ok(await warteAuf(() => !!lieferant('R6C Einkauf C')), `QUICK-PURCHASE der Lieferant steht am Primary (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    const c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'suppliers.create' && c[0].payload.name === 'R6C Einkauf C', `QUICK-PURCHASE dieselbe Buchung suppliers.create, genau einmal (${c.map((x) => x.op).join(',')})`);
    ok(await warteBis(client, "!document.querySelector('[data-purchase-new-supplier-save]') && document.body.innerText.includes('R6C Einkauf C')", 15000),
      'QUICK-PURCHASE sofort in der Auswahl und gewählt — ohne Neuladen');
    await gehZu(primary, '/purchases/new', 'SUPPLIER');
    await clickIncludes(primary, 'New Supplier');
    await waitFor(primary, '[data-purchase-new-supplier-save]', 15000);
    await setVal(primary, 'input[placeholder="e.g. Gold Dealer LLC"]', ' R6C Einkauf P ');
    await click(primary, '[data-purchase-new-supplier-save]');
    ok(await warteAuf(() => !!lieferant('R6C Einkauf P')), 'QUICK-PURCHASE-PARITAET der Primary legt an');
    ok(await warteBis(primary, "!document.querySelector('[data-purchase-new-supplier-save]') && document.body.innerText.includes('R6C Einkauf P')", 15000), 'QUICK-PURCHASE-PARITAET und wählt ihn');
    ok(norm(lieferant('R6C Einkauf P'), ZEIT) === norm(lieferant('R6C Einkauf C'), ZEIT), 'QUICK-PURCHASE-PARITAET Lieferant: Primary == PC2');
  }

  // ══════════════════════════════════════════════════════════════════════
  // QUICK 3 — „+ New Supplier" in der Werkstatt → dieselbe Buchung, danach gewählt
  // ══════════════════════════════════════════════════════════════════════
  {
    const werkstatt = async (c, name) => {
      if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Repair')", 45000))) return 'KEIN-KNOPF';
      await clickText(c, 'New Repair');
      if (!(await warteBis(c, "document.body.innerText.includes('REPAIR TYPE')", 15000))) return 'KEINE-MASKE';
      const r = [await clickText(c, 'External')];
      if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='+ New Supplier')", 15000))) return 'KEIN-SCHNELLKNOPF';
      r.push(await clickText(c, '+ New Supplier'));
      if (!(await warteBis(c, "document.querySelector('[data-repair-quick-supplier-save]')", 15000))) return 'KEINE-SCHNELLMASKE';
      r.push(await setVal(c, 'input[placeholder="e.g. Goldsmith Ali"]', name));
      await sleep(200);
      r.push(await c.ev("const b=document.querySelector('[data-repair-quick-supplier-save]'); if(!b||b.disabled) return 'DISABLED'; b.click(); return 'OK';"));
      const schlecht = r.filter((x) => x !== 'OK');
      return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
    };
    client = await lade(client, '/repairs');
    const vorher = (await buchungen(client)).length;
    { const m = await werkstatt(client, ' R6C Werkstatt C '); ok(m === 'OK', `QUICK-REPAIR die Schnellmaske der Werkstatt am zweiten Rechner (${m})`); }
    ok(await warteAuf(() => !!lieferant('R6C Werkstatt C')), `QUICK-REPAIR der Lieferant steht am Primary (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    const c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'suppliers.create' && S(c[0].payload) === S({ name: 'R6C Werkstatt C' }), `QUICK-REPAIR dieselbe Buchung, genau einmal (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    ok(await warteBis(client, "!document.querySelector('[data-repair-quick-supplier-save]') && document.body.innerText.includes('R6C Werkstatt C')", 15000),
      'QUICK-REPAIR sofort gewählt — ohne Neuladen');
    await gehZu(primary, '/repairs', 'New Repair');
    { const m = await werkstatt(primary, ' R6C Werkstatt P '); ok(m === 'OK', `QUICK-REPAIR-PARITAET dieselbe Schnellmaske am Primary (${m})`); }
    ok(await warteAuf(() => !!lieferant('R6C Werkstatt P')), 'QUICK-REPAIR-PARITAET der Primary legt an');
    ok(norm(lieferant('R6C Werkstatt P'), ZEIT) === norm(lieferant('R6C Werkstatt C'), ZEIT), 'QUICK-REPAIR-PARITAET Lieferant: Primary == PC2');
    ok(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM suppliers WHERE name LIKE 'R6C %'")[0]?.n === 8, 'QUICK drei Einstiege je Rechner, je genau EIN Lieferant (+ zwei Stammsätze)');
  }
  console.log('CENTRAL_UI_R6C_QUICK_CREATE_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // MASTER — Lieferant ändern und deaktivieren → suppliers.update
  // ══════════════════════════════════════════════════════════════════════
  {
    const aendern = async (c) => {
      if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Edit')", 30000))) return 'KEIN-EDIT';
      const r = [await clickText(c, 'Edit')];
      await waitFor(c, '[data-supplier-save]', 15000);
      r.push(await setByLabel(c, 'EMAIL', 'neu@r6c.bh'));
      await sleep(200);
      const schlecht = r.filter((x) => x !== 'OK');
      return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
    };
    client = await lade(client, '/suppliers/r6c-sup-C');
    let vorher = (await buchungen(client)).length;
    { const m = await aendern(client); ok(m === 'OK', `SUPPLIER-EDIT die Maske am zweiten Rechner (${m})`); }
    await click(client, '[data-supplier-save]');
    ok(await warteAuf(() => lieferantId('r6c-sup-C').email === 'neu@r6c.bh'), 'SUPPLIER-EDIT die Änderung steht am Primary');
    let c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'suppliers.update' && S(c[0].payload) === S({ id: 'r6c-sup-C', email: 'neu@r6c.bh' }),
      `SUPPLIER-EDIT genau EIN Auftrag — NUR das Geänderte (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    vorher = (await buchungen(client)).length;
    await clickText(client, 'Edit');
    await waitFor(client, '[data-supplier-toggle-active]', 15000);
    await click(client, '[data-supplier-toggle-active]');
    ok(await warteAuf(() => Number(lieferantId('r6c-sup-C').active) === 0), 'SUPPLIER-ACTIVE „Deactivate" steht am Primary');
    c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'suppliers.update' && S(c[0].payload) === S({ id: 'r6c-sup-C', active: false }), `SUPPLIER-ACTIVE der Zielwert, kein Umschalter (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    await gehZu(primary, '/suppliers/r6c-sup-P', 'R6C Stamm P');
    { const m = await aendern(primary); ok(m === 'OK', `SUPPLIER-EDIT-PARITAET dieselbe Maske am Primary (${m})`); }
    await click(primary, '[data-supplier-save]');
    ok(await warteAuf(() => lieferantId('r6c-sup-P').email === 'neu@r6c.bh'), 'SUPPLIER-EDIT-PARITAET der Primary ändert');
    await clickText(primary, 'Edit');
    await waitFor(primary, '[data-supplier-toggle-active]', 15000);
    await click(primary, '[data-supplier-toggle-active]');
    ok(await warteAuf(() => Number(lieferantId('r6c-sup-P').active) === 0), 'SUPPLIER-ACTIVE-PARITAET der Primary deaktiviert');
    ok(norm(lieferantId('r6c-sup-P'), ZEIT) === norm(lieferantId('r6c-sup-C'), ZEIT), `SUPPLIER-PARITAET Lieferant: Primary == PC2 (${norm(lieferantId('r6c-sup-C'), ZEIT)})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // MASTER — Agent ändern → agents.update (Umsatzsummen unberührt)
  // ══════════════════════════════════════════════════════════════════════
  {
    const aendern = async (c, name) => {
      if (!(await warteBis(c, `document.body.innerText.includes(${S(name)})`, 30000))) return 'KEINE-KARTE';
      const r = [await clickInCard(c, name, 'Edit')];
      if (!(await warteBis(c, "document.querySelector('[data-agent-save]')", 15000))) return 'KEINE-MASKE';
      r.push(await setByLabel(c, 'COMPANY', 'R6C Handelshaus'));
      await sleep(200);
      const schlecht = r.filter((x) => x !== 'OK');
      return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
    };
    client = await lade(client, '/agents');
    const vorher = (await buchungen(client)).length;
    { const m = await aendern(client, 'R6C Agent C'); ok(m === 'OK', `AGENT die Maske am zweiten Rechner (${m})`); }
    await click(client, '[data-agent-save]');
    ok(await warteAuf(() => agent('r6c-agent-C').company === 'R6C Handelshaus'), `AGENT die Änderung steht am Primary (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    const c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'agents.update' && S(c[0].payload) === S({ id: 'r6c-agent-C', company: 'R6C Handelshaus' }),
      `AGENT genau EIN Auftrag — nur das Geänderte, keine Summen (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    ok(Number(agent('r6c-agent-C').total_sales) === 500 && Number(agent('r6c-agent-C').total_commission) === 50, 'AGENT die Umsatzsummen führt das Haus — unberührt');
    await gehZu(primary, '/agents', 'R6C Agent P');
    { const m = await aendern(primary, 'R6C Agent P'); ok(m === 'OK', `AGENT-PARITAET dieselbe Maske am Primary (${m})`); }
    await click(primary, '[data-agent-save]');
    ok(await warteAuf(() => agent('r6c-agent-P').company === 'R6C Handelshaus'), 'AGENT-PARITAET der Primary ändert');
    ok(norm(agent('r6c-agent-P'), ZEIT) === norm(agent('r6c-agent-C'), ZEIT), `AGENT-PARITAET Agent: Primary == PC2 (${norm(agent('r6c-agent-C'), ZEIT)})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // MASTER — Partner anlegen und ändern → partners.create / partners.update
  // ══════════════════════════════════════════════════════════════════════
  {
    const anlegen = async (c, name) => {
      if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Partner')", 30000))) return 'KEIN-KNOPF';
      const r = [await clickText(c, 'New Partner')];
      await waitFor(c, '[data-partner-create-save]', 15000);
      r.push(await setByLabel(c, 'NAME', name));
      r.push(await setByLabel(c, 'PROFIT SHARE (%)', '12.5'));
      await sleep(200);
      const schlecht = r.filter((x) => x !== 'OK');
      return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
    };
    const aendern = async (c, name) => {
      const r = [await clickInCard(c, name, 'Edit')];
      if (!(await warteBis(c, "document.querySelector('[data-partner-save]')", 15000))) return 'KEINE-MASKE';
      r.push(await setByLabel(c, 'SHARE %', '30'));
      await sleep(200);
      const schlecht = r.filter((x) => x !== 'OK');
      return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
    };
    client = await lade(client, '/partners');
    let vorher = (await buchungen(client)).length;
    { const m = await anlegen(client, 'R6C Partner C'); ok(m === 'OK', `PARTNER die Maske am zweiten Rechner (${m})`); }
    await click(client, '[data-partner-create-save]');
    ok(await warteAuf(() => !!partner('R6C Partner C')), `PARTNER angelegt am Primary (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    let c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'partners.create' && S(c[0].payload) === S({ name: 'R6C Partner C', sharePercentage: 12.5 }), `PARTNER genau EIN Auftrag partners.create (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    ok(await warteBis(client, "document.body.innerText.includes('R6C Partner C')", 15000), 'PARTNER sofort in der Liste');
    vorher = (await buchungen(client)).length;
    { const m = await aendern(client, 'R6C Partner C'); ok(m === 'OK', `PARTNER-EDIT die Maske am zweiten Rechner (${m})`); }
    await click(client, '[data-partner-save]');
    ok(await warteAuf(() => Number(partner('R6C Partner C')?.share_percentage) === 30), 'PARTNER-EDIT der Anteil steht am Primary');
    c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'partners.update' && S(c[0].payload) === S({ id: partner('R6C Partner C')?.id, sharePercentage: 30 }), `PARTNER-EDIT nur das Geänderte (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    await gehZu(primary, '/partners', 'Partners');
    { const m = await anlegen(primary, 'R6C Partner P'); ok(m === 'OK', `PARTNER-PARITAET dieselbe Maske am Primary (${m})`); }
    await click(primary, '[data-partner-create-save]');
    ok(await warteAuf(() => !!partner('R6C Partner P')), 'PARTNER-PARITAET der Primary legt an');
    await warteBis(primary, "document.body.innerText.includes('R6C Partner P')", 15000);
    { const m = await aendern(primary, 'R6C Partner P'); ok(m === 'OK', `PARTNER-EDIT-PARITAET dieselbe Maske am Primary (${m})`); }
    await click(primary, '[data-partner-save]');
    ok(await warteAuf(() => Number(partner('R6C Partner P')?.share_percentage) === 30), 'PARTNER-EDIT-PARITAET der Primary ändert');
    ok(norm(partner('R6C Partner P'), ZEIT) === norm(partner('R6C Partner C'), ZEIT), `PARTNER-PARITAET Partner: Primary == PC2 (${norm(partner('R6C Partner C'), ZEIT)})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // MASTER — Mitarbeiter anlegen, Status (Liste + Detail), ändern → employees.*
  // ══════════════════════════════════════════════════════════════════════
  {
    const anlegen = async (c, name) => {
      if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Employee')", 30000))) return 'KEIN-KNOPF';
      const r = [await clickText(c, 'New Employee')];
      await waitFor(c, '[data-employee-create-save]', 15000);
      r.push(await setByLabel(c, 'NAME', name));
      r.push(await setByLabel(c, 'ROLE', 'Sales'));
      await sleep(200);
      const schlecht = r.filter((x) => x !== 'OK');
      return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
    };
    const ablauf = async (c, name, istPrimary) => {
      const vorher = istPrimary ? 0 : (await buchungen(c)).length;
      { const m = await anlegen(c, name); ok(m === 'OK', `EMPLOYEE die Maske (${istPrimary ? 'Primary' : 'PC2'}) (${m})`); }
      await click(c, '[data-employee-create-save]');
      ok(await warteAuf(() => !!mitarbeiter(name)), `EMPLOYEE angelegt (${istPrimary ? 'Primary' : 'PC2'}) (Hinweis: ${String(await fehlerAnzeige(c)).slice(0, 160) || 'keiner'})`);
      const id = mitarbeiter(name)?.id;
      if (!istPrimary) {
        const cc = (await buchungen(c)).slice(vorher);
        ok(cc.length === 1 && cc[0].op === 'employees.create' && S(cc[0].payload) === S({ name, employmentStatus: 'active', role: 'Sales' }), `EMPLOYEE genau EIN Auftrag employees.create (${cc.map((x) => x.op + S(x.payload)).join(',')})`);
      }
      ok(await warteBis(c, `document.querySelector('[data-employee-status="${id}"]')`, 15000), `EMPLOYEE sofort in der Liste (${istPrimary ? 'Primary' : 'PC2'})`);
      const v2 = istPrimary ? 0 : (await buchungen(c)).length;
      await click(c, `[data-employee-status="${id}"]`);
      ok(await warteAuf(() => mitarbeiter(name)?.employment_status === 'on_leave'), `EMPLOYEE „On Leave" aus der Liste (${istPrimary ? 'Primary' : 'PC2'})`);
      if (!istPrimary) {
        const cc = (await buchungen(c)).slice(v2);
        ok(cc.length === 1 && cc[0].op === 'employees.update' && S(cc[0].payload) === S({ id, employmentStatus: 'on_leave' }), `EMPLOYEE-STATUS der Zielstatus (${cc.map((x) => x.op + S(x.payload)).join(',')})`);
      }
      return id;
    };
    client = await lade(client, '/employees');
    const idC = await ablauf(client, 'R6C Emp C', false);
    client = await lade(client, `/employees/${idC}`);
    await waitFor(client, '[data-employee-status-detail]', 30000);
    let vorher = (await buchungen(client)).length;
    await click(client, '[data-employee-status-detail]');
    ok(await warteAuf(() => mitarbeiter('R6C Emp C')?.employment_status === 'active'), 'EMPLOYEE-DETAIL „Reactivate" am zweiten Rechner');
    await sleep(800);
    await clickText(client, 'Edit');
    await waitFor(client, '[data-employee-save]', 15000);
    await setByLabel(client, 'ROLE', 'Senior Sales');
    await sleep(200);
    await click(client, '[data-employee-save]');
    ok(await warteAuf(() => mitarbeiter('R6C Emp C')?.role === 'Senior Sales'), 'EMPLOYEE-DETAIL „Save Changes" am zweiten Rechner');
    const c = (await buchungen(client)).slice(vorher);
    ok(c.length === 2 && c.every((x) => x.op === 'employees.update') && S(c[0].payload) === S({ id: idC, employmentStatus: 'active' }) && S(c[1].payload) === S({ id: idC, role: 'Senior Sales' }),
      `EMPLOYEE-DETAIL zwei Absichten, zwei Aufträge — je nur das Geänderte (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    await gehZu(primary, '/employees', 'Employees');
    const idP = await ablauf(primary, 'R6C Emp P', true);
    await gehZu(primary, `/employees/${idP}`, 'R6C Emp P');
    await waitFor(primary, '[data-employee-status-detail]', 30000);
    await click(primary, '[data-employee-status-detail]');
    ok(await warteAuf(() => mitarbeiter('R6C Emp P')?.employment_status === 'active'), 'EMPLOYEE-DETAIL-PARITAET „Reactivate" am Primary');
    await sleep(800);
    await clickText(primary, 'Edit');
    await waitFor(primary, '[data-employee-save]', 15000);
    await setByLabel(primary, 'ROLE', 'Senior Sales');
    await sleep(200);
    await click(primary, '[data-employee-save]');
    ok(await warteAuf(() => mitarbeiter('R6C Emp P')?.role === 'Senior Sales'), 'EMPLOYEE-DETAIL-PARITAET „Save Changes" am Primary');
    ok(norm(mitarbeiter('R6C Emp P'), ZEIT) === norm(mitarbeiter('R6C Emp C'), ZEIT), `EMPLOYEE-PARITAET Mitarbeiter: Primary == PC2 (${norm(mitarbeiter('R6C Emp C'), ZEIT)})`);
    vorher = 0;
  }
  console.log('CENTRAL_UI_R6C_MASTERDATA_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // INV — beginnen → zählen → speichern (verlorene Antwort) → wieder öffnen → fremde Änderung →
  //       alte Fassung abgewiesen → abschließen
  // ══════════════════════════════════════════════════════════════════════
  let ownerCheckedBy = '';
  {
    const oeffnen = async (c) => {
      await waitFor(c, '[data-testid="open-inventory"]', 30000);
      await warteBis(c, "!document.querySelector('[data-testid=\"open-inventory\"]').disabled", 30000);
      await click(c, '[data-testid="open-inventory"]');
      await waitFor(c, '[data-inv-col="pending"]', 20000);
      return warteBis(c, "(document.querySelector('[data-inv-merged]')?.getAttribute('data-inv-merged') || '') !== ''", 30000);
    };
    client = await lade(client, '/collection');
    let vorher = (await buchungen(client)).length;
    ok(await oeffnen(client), 'INV-START die Inventur öffnet am zweiten Rechner — kein R6B-Riegel mehr');
    ok(await client.ev("return document.querySelector('[data-inv-merged]').getAttribute('data-inv-merged');") === '0', 'INV-START nichts einzufalten');
    let c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'inventory.start' && S(Object.keys(c[0].payload)) === S(['productIds']) && INV.every((p) => c[0].payload.productIds.includes(p)),
      `INV-START genau EIN Auftrag inventory.start — nur die Artikel dieser Ansicht (${c.map((x) => x.op + ':' + Object.keys(x.payload)).join(',')})`);
    ok(await warteAuf(() => offeneLaeufe().length === 1), 'INV-START am Primary steht genau EIN offener Lauf');
    const sid = offeneLaeufe()[0]?.session_id;
    const rev0 = Number(lauf(sid).revision);

    await click(client, '[data-inv-yes="r6c-inv-1"]');
    await click(client, '[data-inv-no="r6c-inv-2"]');
    await sleep(200);
    ok(await setVal(client, '[data-inv-note="r6c-inv-1"]', ' shelf A ') === 'OK', 'INV-COUNT zwei Karten entschieden, eine Notiz');
    const checksVorher = checks().length;
    vorher = (await buchungen(client)).length;
    await client.ev("window.__dropNext = 'inventory.save'; return 1;");
    await click(client, '[data-testid="inv-save"]');
    ok(await warteBis(client, "document.querySelector('[data-inv-pending]')", 20000), 'LOST die Antwort geht verloren: die Maske sagt „offen" statt „gespeichert"');
    ok(await exists(client, '[data-inv-col="pending"]'), 'LOST die Maske bleibt offen (kein Schein-Erfolg)');
    ok(await warteAuf(() => blatt(sid).some((r) => r.product_id === 'r6c-inv-1' && r.status === 'available')), 'LOST der Primary HAT gespeichert');
    ok(await client.ev("return document.querySelector('[data-inv-yes],[data-inv-flip]')?.disabled === true;"), 'LOST solange der Ausgang offen ist, bleibt das Arbeitsblatt gesperrt');
    await click(client, '[data-testid="inv-save"]');
    ok(await warteBis(client, "!document.querySelector('[data-inv-col=\"pending\"]')", 30000), `LOST der zweite Klick schließt die Maske (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    c = (await buchungen(client)).slice(vorher);
    ok(c.length === 2 && c.every((x) => x.op === 'inventory.save') && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `LOST zweimal DERSELBE Auftrag — dieselbe Kennung, derselbe Rumpf (${c.map((x) => x.op + ':' + x.commandId).join(',')})`);
    const p = c[0]?.payload || {};
    ok(S(Object.keys(p).sort()) === S(['expectedRevision', 'items', 'sessionId', 'visibleProductIds']) && p.sessionId === sid && p.expectedRevision === rev0
      && p.items.every((i) => S(Object.keys(i).sort()) === S(['notes', 'productId', 'status'])),
    `INV-SAVE der Rumpf nennt Lauf, gesehene Fassung und Urteile — keinen Bestand, keine Differenz, keine Zeit (${S(p).slice(0, 220)})`);
    const neu = checks().slice(checksVorher);
    ok(neu.length === 2 && neu.every((r) => r.request_id === `${c[0].commandId}:${r.product_id}` && r.source === 'desktop' && !!r.checked_by),
      `INV-SAVE genau zwei Beobachtungen im Kern des Primary — nicht vier (${neu.length}: ${S(neu.map((r) => [r.product_id, r.status, r.notes]))})`);
    ownerCheckedBy = String(neu[0]?.checked_by || '');
    ok(Number(lauf(sid).revision) === rev0 + 1, `INV-SAVE die Fassung stieg genau einmal (${rev0} → ${lauf(sid).revision})`);
    const b = blatt(sid);
    ok(b.find((r) => r.product_id === 'r6c-inv-1')?.notes === 'shelf A' && b.find((r) => r.product_id === 'r6c-inv-2')?.status === 'not_available',
      `INV-SAVE das Arbeitsblatt am Primary (Notiz getrimmt) (${S(b)})`);

    // Wieder öffnen: dieselben Spalten, derselbe Lauf.
    vorher = (await buchungen(client)).length;
    ok(await oeffnen(client), 'INV-REOPEN die Maske öffnet wieder');
    ok(await exists(client, '[data-inv-col="available"] [data-inv-row="r6c-inv-1"]') && await exists(client, '[data-inv-col="not_available"] [data-inv-row="r6c-inv-2"]'),
      'INV-REOPEN die Spalten stehen wie gespeichert — gelesen vom Primary');
    ok(offeneLaeufe().length === 1 && offeneLaeufe()[0].session_id === sid, 'INV-REOPEN derselbe Lauf, kein zweiter');
    const revSeen = Number(await client.ev("return Number(document.querySelector('[data-inv-revision]').getAttribute('data-inv-revision'));"));
    ok(revSeen === rev0 + 1, `INV-REOPEN PC2 sieht die Fassung des Primary (${revSeen})`);

    // Fremde Änderung am Primary, während PC2 den alten Stand offen hat.
    await gehZu(primary, '/collection', 'Collection');
    await primary.ev(DIALOGE_PRIMARY);
    ok(await oeffnen(primary), 'STALE der Primary öffnet dieselbe Inventur');
    await click(primary, '[data-inv-yes="r6c-inv-3"]');
    await sleep(200);
    await click(primary, '[data-testid="inv-save"]');
    ok(await warteBis(primary, "!document.querySelector('[data-inv-col=\"pending\"]')", 30000), 'STALE der Primary speichert (Fassung +1)');
    ok(await warteAuf(() => Number(lauf(sid).revision) === rev0 + 2), `STALE die Fassung am Primary (${lauf(sid).revision})`);
    const checksVorStale = checks().length;
    vorher = (await buchungen(client)).length;
    await click(client, '[data-inv-yes="r6c-inv-4"]');
    await sleep(200);
    await click(client, '[data-testid="inv-save"]');
    ok(await warteBis(client, "[...document.querySelectorAll('[data-save-error]')].some(e => /changed elsewhere/.test(e.textContent))", 20000),
      `STALE PC2 mit der alten Fassung: klares Nein, gesagt — nicht blind überschrieben (${String(await fehlerAnzeige(client)).slice(0, 200)})`);
    c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'inventory.save' && c[0].payload.expectedRevision === rev0 + 1, 'STALE der Auftrag nannte die gesehene (alte) Fassung');
    await sleep(800);
    ok(!blatt(sid).some((r) => r.product_id === 'r6c-inv-4' && r.status !== 'to_check') && checks().length === checksVorStale,
      'STALE nichts geschrieben — keine Beobachtung, kein Arbeitsblatt');
    ok(blatt(sid).find((r) => r.product_id === 'r6c-inv-3')?.status === 'available', 'STALE die Änderung des Primary steht unversehrt');
    await clickText(client, 'Cancel');
    if (await warteBis(client, "document.querySelector('[data-testid=\"inv-discard\"]')", 5000)) await click(client, '[data-testid="inv-discard"]');
    await sleep(600);

    // Abschließen — von PC2, nach dem Neuladen.
    ok(await oeffnen(client), 'INV-FINISH wieder öffnen (frische Fassung)');
    ok(await exists(client, '[data-inv-col="available"] [data-inv-row="r6c-inv-3"]'), 'INV-FINISH PC2 sieht jetzt auch die Änderung des Primary');
    vorher = (await buchungen(client)).length;
    const checksVorFinish = checks().length;
    await click(client, '[data-testid="inv-finish"]');
    await waitFor(client, '[data-testid="inv-finish-confirm"]', 10000);
    await click(client, '[data-testid="inv-finish-confirm"]');
    ok(await warteAuf(() => lauf(sid).status === 'closed'), `INV-FINISH der Lauf ist am Primary geschlossen (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'inventory.finish' && S(c[0].payload) === S({ sessionId: sid, expectedRevision: rev0 + 2 }), `INV-FINISH genau EIN Auftrag mit der gesehenen Fassung (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    ok(blatt(sid).length === 0 && checks().length === checksVorFinish && offeneLaeufe().length === 0, 'INV-FINISH Arbeitsblatt weggelegt, Verlauf unberührt, kein offener Lauf');
    ok(INV.every((pid) => (dbQ(BIZ_DB, 'SELECT stock_status, quantity FROM products WHERE id = ?', [pid])[0] || {}).stock_status === 'in_stock'),
      'INV die Inventur hat keinen Bestand verändert (das tut sie in diesem Haus nicht)');
    ok(!!ownerCheckedBy, `INV die Beobachtungen von PC2 tragen den GEPRÜFTEN Benutzer (${ownerCheckedBy})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // INV-PARITAET — derselbe saubere Lauf auf beiden Rechnern
  // ══════════════════════════════════════════════════════════════════════
  {
    const lauf1 = async (c) => {
      await waitFor(c, '[data-testid="open-inventory"]', 30000);
      await click(c, '[data-testid="open-inventory"]');
      await waitFor(c, '[data-inv-col="pending"]', 20000);
      await warteBis(c, "(document.querySelector('[data-inv-merged]')?.getAttribute('data-inv-merged') || '') !== ''", 30000);
      const sidL = offeneLaeufe()[0]?.session_id;
      await click(c, '[data-inv-yes="r6c-inv-1"]');
      await click(c, '[data-inv-no="r6c-inv-2"]');
      await sleep(200);
      await setVal(c, '[data-inv-note="r6c-inv-1"]', 'twin');
      await sleep(200);
      const vor = checks().length;
      await click(c, '[data-testid="inv-save"]');
      await warteBis(c, "!document.querySelector('[data-inv-col=\"pending\"]')", 30000);
      await warteAuf(() => checks().length === vor + 2);
      await click(c, '[data-testid="open-inventory"]');
      await warteBis(c, "(document.querySelector('[data-inv-merged]')?.getAttribute('data-inv-merged') || '') !== ''", 30000);
      await click(c, '[data-testid="inv-finish"]');
      await waitFor(c, '[data-testid="inv-finish-confirm"]', 10000);
      await click(c, '[data-testid="inv-finish-confirm"]');
      await warteAuf(() => lauf(sidL).status === 'closed');
      await sleep(600);
      await clickText(c, 'Cancel');
      await sleep(400);
      return { sid: sidL, rows: checks().slice(vor).map((r) => [r.product_id, r.status, r.notes, r.source]), sess: lauf(sidL) };
    };
    client = await lade(client, '/collection');
    const pc2 = await lauf1(client);
    await gehZu(primary, '/collection', 'Collection');
    const prim = await lauf1(primary);
    ok(pc2.sid && prim.sid && pc2.sid !== prim.sid, 'INV-PARITAET zwei eigene Läufe nacheinander');
    ok(S(pc2.rows) === S(prim.rows) && pc2.rows.length === 2, `INV-PARITAET Beobachtungen: Primary == PC2 (${S(pc2.rows)} / ${S(prim.rows)})`);
    ok(S([pc2.sess.status, pc2.sess.revision]) === S([prim.sess.status, prim.sess.revision]), `INV-PARITAET Lauf (Status, Fassung): Primary == PC2 (${S(pc2.sess)} / ${S(prim.sess)})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // CHECK — Einzel-Check am Artikel → inventory.record_check
  // ══════════════════════════════════════════════════════════════════════
  {
    const pruefen = async (c, notiz) => {
      if (!(await warteBis(c, "document.querySelector('[data-stock-check=\"available\"]')", 30000))) return 'KEIN-KNOPF';
      const r = [await setVal(c, 'input[placeholder^="Notes (optional)"]', notiz)];
      await sleep(200);
      r.push(await c.ev("document.querySelector('[data-stock-check=\"available\"]').click(); return 'OK';"));
      const schlecht = r.filter((x) => x !== 'OK');
      return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
    };
    client = await lade(client, '/collection/r6c-inv-3');
    ok(!(await exists(client, '[data-primary-only="stock-check"]')), 'CHECK der Einzel-Check steht auf dem Client (kein R6B-Satz mehr)');
    const vorher = (await buchungen(client)).length;
    const vor = checks().length;
    { const m = await pruefen(client, ' im Tresor '); ok(m === 'OK', `CHECK am zweiten Rechner (${m})`); }
    ok(await warteAuf(() => checks().length === vor + 1), 'CHECK die Beobachtung steht im Kern des Primary');
    const c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'inventory.record_check' && S(c[0].payload) === S({ productId: 'r6c-inv-3', status: 'available', notes: 'im Tresor' }),
      `CHECK genau EIN Auftrag inventory.record_check (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    const row = checks().at(-1) || {};
    ok(row.product_id === 'r6c-inv-3' && row.notes === 'im Tresor' && row.request_id === c[0]?.commandId, 'CHECK Notiz getrimmt, Anfragekennung = Auftragskennung');
    ok(await warteBis(client, "document.querySelector('[data-stock-check-panel]')?.innerText.includes('im Tresor')", 15000), 'CHECK der Verlauf auf PC2 zeigt sie — gelesen vom Primary');
    await gehZu(primary, '/collection/r6c-inv-4', 'R6C r6c-inv-4');
    const vorP = checks().length;
    { const m = await pruefen(primary, ' im Tresor '); ok(m === 'OK', `CHECK-PARITAET derselbe Knopf am Primary (${m})`); }
    ok(await warteAuf(() => checks().length === vorP + 1), 'CHECK-PARITAET der Primary beobachtet');
    const rowP = checks().at(-1) || {};
    ok(S([rowP.status, rowP.notes, rowP.source]) === S([row.status, row.notes, row.source]), `CHECK-PARITAET Beobachtung: Primary == PC2 (${S([row.status, row.notes, row.source])})`);
  }
  console.log('CENTRAL_UI_R6C_INVENTORY_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // SAFETY — kein Griff zur lokalen Datenbank, die alte Datei unberührt
  // ══════════════════════════════════════════════════════════════════════
  {
    ok((await treffer(client)).length === 0, `LOKAL kein Griff zur lokalen Datenbank (${S(await treffer(client)).slice(0, 200)})`);
    const alle = await aufrufe(client);
    ok(!alle.some((x) => /stock_check|flush_database|backup|import|save_database/i.test(x)), `LOKAL kein Aufruf des eigenen Kerns für Inventur oder Speichern (${[...new Set(alle)].join(',').slice(0, 300)})`);
    ok(sha(STALE) === staleVorher, 'LOKAL die alte Geschäftsdatei auf PC2 ist unberührt');
    const dateien = readdirSync(CLIENT_DATA_DIR).sort();
    const neu = dateien.filter((f) => !dateienVorher.includes(f));
    ok(neu.length === 0 && !dateien.some((f) => /lataif_sync_server\.db|outbox|data-location/i.test(f)), `LOKAL keine neue Datei, keine Konfig-DB, keine Warteschlange (${dateien.join(', ')})`);
    const schluessel = await client.ev('return JSON.stringify(Object.keys(localStorage));');
    ok(!/outbox|pending|queue/i.test(schluessel), `LOKAL keine lokale Warteschlange im Speicher (${schluessel})`);
  }

  // Die Produktion (fremde lataif.exe) ist durch diesen Lauf nicht berührt worden.
  const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid);
  ok(fremdVorher.every((pid) => fremdNachher.includes(pid)), `ISOLATION jede fremde lataif.exe von vorher läuft noch (${fremdVorher.length} geprüft)`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
  try { console.log('      (Primary-Konsole) ' + (primary?.events || []).slice(-15).join('\n      (Primary-Konsole) ')); } catch { /* egal */ }
  try { console.log('      (PC2-Konsole) ' + (client?.events || []).slice(-15).join('\n      (PC2-Konsole) ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r6c: masterdata + quick creates + inventory, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6C_QUICK_CREATE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R6C_MASTERDATA_RUNTIME_PROVED');
console.log('CENTRAL_UI_R6C_INVENTORY_RUNTIME_PROVED');
console.log('CENTRAL_UI_R6C_TWO_APP_RUNTIME_PROVED');
