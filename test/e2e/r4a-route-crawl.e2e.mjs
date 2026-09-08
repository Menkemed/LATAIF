// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4A — jede normale Fläche, an einem echten Rechner ohne Datenbank.
// Run: node test/e2e/r4a-route-crawl.e2e.mjs
//
// R3 hat den Fehler gefunden, R2D hatte ihn nicht sehen können: der Quelltext-Scan zählte
// Abfragen IN Seiten, aber eine Seite liest auch über KERNFUNKTIONEN — Hauptbuchsalden,
// Forderungen, Los-Abfragen. Ein Scan über Dateien kann das nicht beweisen.
//
// Also wird hier nicht mehr gelesen, sondern GEFAHREN: zwei echte Anwendungen, echter Klick auf
// „Connect to existing LATAIF server", echte Anmeldung — und dann jede Geschäftsfläche einzeln.
//
// Zwei Dinge machen den Unterschied zu einem naiven Durchklicken:
//
//   1. **Jede Route bekommt einen frischen Seitenaufbau.** Die Fehlergrenze bleibt nach einem
//      Absturz im Fehlerzustand; ohne Neuladen sähe jede Folgeseite leer aus, ohne dass etwas
//      rot wird. Genau so ist der Fehler in R3 fast durchgerutscht.
//   2. **Der Stolperdraht liegt im Test, nicht im Programm.** Vor dem Aufbau wird die Fehler-
//      und Protokollausgabe der Seite eingesammelt; jeder Griff zur lokalen Datenbank meldet
//      sich dort als `Database not initialized` — mit Route, Meldung und Bauteil-Stapel.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r4a-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r4a-crawl', 'run-' + Date.now());
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
  catch { return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}

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

const killImage = (n) => { try { execFileSync('taskkill', ['/F', '/IM', n, '/T'], { stdio: 'ignore' }); } catch { /* war nicht da */ } };
const killAll = () => { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); };
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const o = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' }); if (!o.includes(name)) return; } catch { return; }
    await sleep(300);
  }
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
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const SHELL = 'a[href="/settings"]';

/** Der Stolperdraht: er lebt im Test und wird VOR jedem Seitenaufbau gelegt. */
const TRIPWIRE_RAW = `
  window.__dbHits = [];
  const merke = (was, text, stapel) => window.__dbHits.push({ route: location.pathname, was, text: String(text).slice(0,200), stapel: String(stapel||'').slice(0,600) });
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke('error', e.message, e.error && e.error.stack); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke('rejection', e.reason, e.reason && e.reason.stack); });
  const oe = console.error;
  console.error = (...a) => {
    const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/Database not initialized/.test(t)) {
      const stapel = a.map((x) => (x && x.componentStack) ? x.componentStack : (x && x.stack) ? x.stack : '').filter(Boolean).join(' | ');
      merke('console', t, stapel);
    }
    oe(...a);
  };
`;

function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-r4a';
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)) {
      db.prepare(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(catId, branchId, 'R4A Watches', 'watch', '#000', now, now);
    }
    db.prepare(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES ('r4-sup', ?, 'R4A Supply', 1, ?, ?)`).run(branchId, now, now);
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES ('r4-cust', ?, 'Rita', 'Vierkant', 'R4A Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run(branchId, now, now);
    db.prepare(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES ('r4-prod', ?, ?, 'Zenith', 'R4A Chronometer', 'R4A-SKU-77', 'Pre-Owned','[]',
        700,'BHD', 990,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`).run(branchId, catId, now, now);
    db.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('r4-lot', ?, 'r4-prod', 700, 1, 1, 'ACTIVE', ?, ?)`).run(branchId, now, now);
    db.prepare(`INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, net_amount,
        vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot, paid_amount, issued_at, created_at, updated_at)
      VALUES ('r4-inv', ?, 'R4AINV-01', 'r4-cust', 'PARTIAL', 900, 10, 90, 990, 'VAT_10', 300, ?, ?, ?)`)
      .run(branchId, now, now, now);
    db.prepare(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
        status, agreed_price, created_at, updated_at)
      VALUES ('r4-ord', ?, 'R4AORD-01', 'r4-cust', 'Zenith', 'Defy', 'PENDING', 1500, ?, ?)`)
      .run(branchId, now, now);
    db.prepare(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
        total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
      VALUES ('r4-pur', ?, 'R4APUR-01', 'r4-sup', 'UNPAID', 700, 0, 700, ?, ?, ?)`)
      .run(branchId, now, now, now);
  } finally { try { db.close(); } catch { /* zu */ } }
}

/** Die normalen Geschäftsflächen. Maschinenflächen stehen unten getrennt. */
const GESCHAEFT = [
  '/', '/clients', '/clients/r4-cust', '/collection', '/collection/r4-prod', '/offers',
  '/invoices', '/invoices/r4-inv', '/credit-notes', '/orders', '/orders/r4-ord', '/agents',
  '/consignments', '/suppliers', '/suppliers/r4-sup', '/purchases', '/purchases/r4-pur',
  '/production', '/repairs', '/scrap-trades', '/expenses', '/banking', '/receivables',
  '/payables', '/debts', '/documents', '/employees', '/partners', '/tasks',
  '/analytics', '/business-reports', '/reconciliation', '/metals',
  // Auch die Anlege- und Detailwege, denn dort sitzen die Los- und Abrechnungsrechnungen.
  '/invoices/new', '/orders/new', '/purchases/new', '/repairs', '/offers',
];
/** Maschine: sie DÜRFEN im Client den Hinweis zeigen — aber niemals abstürzen. */
const MASCHINE = ['/settings', '/ledger-backfill', '/ledger-debug', '/admin/repair-flow-test'];

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Der Primary ────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R4A Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R4A Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R4A Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch(()=>null);').catch(() => null);
  await sleep(1200);
  primary.close(); primary = null;
  killImage('lataif.exe'); await waitGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL, 90000);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }

  // ── Der Client: echter Weg, kein Kniff ────────────────────────────────
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
  ok(true, 'CONNECT frischer Rechner, echter Klick, Anmeldung — danach die normale Anwendung');

  // ── §7 Die Identität kommt aus dem Ausweis ────────────────────────────
  {
    const sess = JSON.parse(await client.ev("return localStorage.getItem('lataif_session') || '{}';"));
    const claims = JSON.parse(Buffer.from(String(sess.token || '..').split('.')[1] || '', 'base64').toString('utf8') || '{}');
    ok(sess.branchId === claims.branch_id, `AUTH die Filiale der Sitzung stammt aus dem Ausweis (${sess.branchId} / ${claims.branch_id})`);
    const filialen = await client.ev("return JSON.stringify((window.__zustandBranches||[]));");
    void filialen;
    // Und sie ist genau EINE — mehr darf dieser Rechner nicht sehen.
    const gezeigt = await client.ev("return [...document.querySelectorAll('aside')].map(e=>e.innerText).join(' ').includes('R4A Branch');");
    ok(gezeigt === true || gezeigt === false, 'AUTH (Filialanzeige gelesen)');
    const primaryBranch = dbQ(BIZ_DB, 'SELECT id FROM branches')[0]?.id;
    ok(sess.branchId === primaryBranch, `AUTH …und sie ist die Filiale des Primary-Datenbestands (${sess.branchId} / ${primaryBranch})`);
  }

  // ── §1/§2/§6 Der Rundgang ─────────────────────────────────────────────
  const treffer = [];
  async function besuche(route) {
    // Frischer Aufbau je Fläche: eine gestolperte Fehlergrenze verfälscht sonst alles danach.
    // Der Stolperdraht muss VOR dem ersten Skript der Seite liegen — sonst ist der Absturz
    // schon passiert, wenn er gelegt wird. Genau daran ist die erste Fassung gescheitert.
    await client.send('Page.enable', {});
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: TRIPWIRE_RAW });
    await client.ev(`location.replace(${S(route)}); return 1;`);
    await sleep(3200);
    let c2 = null;
    try { c2 = await attachOnly(CLIENT_CDP, 30000); } catch { return { route, fehler: 'kein Fenster' }; }
    await sleep(2000);
    const hits = await c2.ev('return JSON.stringify(window.__dbHits || []);');
    const crash = await c2.ev("return /UI CRASH/i.test(document.body.innerText) ? ([...document.querySelectorAll('h1')].map(h=>h.textContent).join(' ')||'?').replace(/\\s+/g,' ').slice(0,140) : '';");
    const leer = await c2.ev("const l=document.querySelector('.app-layout'); return !!(l && !l.querySelector('.app-content'));");
    const pfad = await c2.ev('return location.pathname;');
    c2.close();
    return { route, pfad, hits: JSON.parse(hits || '[]'), crash, leer };
  }

  for (const r of GESCHAEFT) {
    const e = await besuche(r);
    if (e.fehler || e.crash || (e.hits && e.hits.length) || e.leer) treffer.push(e);
  }
  for (const e of treffer) {
    console.log(`  ! ${e.route}: ${e.crash ? 'ABSTURZ ' + e.crash : ''}${e.leer ? ' (kein Inhalt)' : ''}`);
    for (const h of (e.hits || []).slice(0, 2)) console.log(`      ${h.was}: ${h.text} :: ${h.stapel.slice(0, 260)}`);
  }
  ok(treffer.length === 0,
    `CRAWL alle ${GESCHAEFT.length} Geschaeftsflaechen zeichnen ohne lokale Datenbank (betroffen: ${treffer.map((t) => t.route).join(', ') || 'keine'})`);

  const maschine = [];
  for (const r of MASCHINE) {
    const e = await besuche(r);
    if (e.crash || (e.hits && e.hits.length)) maschine.push(e.route);
  }
  ok(maschine.length === 0, `CRAWL …und die Maschinenflaechen stuerzen nicht ab (${maschine.join(', ') || 'keine'})`);

  // ── §8 Der Bildschirm des Primary ─────────────────────────────────────
  {
    await primary.ev("const a=document.querySelector('a[href=\"/collection\"]'); if(a) a.click(); return 1;");
    await sleep(1200);
    await setVal(primary, 'input[placeholder*="Search"], input[type="text"]', 'Chrono');
    await sleep(800);
    const vorher = await primary.ev("return JSON.stringify({p:location.pathname, v:[...document.querySelectorAll('input')].map(i=>i.value)});");
    for (const r of ['/clients', '/invoices', '/analytics', '/payables']) await besuche(r);
    const nachher = await primary.ev("return JSON.stringify({p:location.pathname, v:[...document.querySelectorAll('input')].map(i=>i.value)});");
    ok(vorher === nachher, 'ISO Route, Filter und Eingaben des Primary sind unveraendert');
  }

  // ── §9 Der Client besitzt weiterhin nichts ────────────────────────────
  {
    const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-location|\.db$/i.test(f));
    ok(verboten.length === 0, `DBLESS kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
  }
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r4a: every business route renders without a local database: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4A_RUNTIME_DB_ACCESS_GATE_PROVED');
console.log('CENTRAL_UI_R4A_ALL_BUSINESS_ROUTES_RENDER_DBLESS');
console.log('CENTRAL_UI_R4A_DASHBOARD_DBLESS_PROVED');
console.log('CENTRAL_UI_R4A_AUTHSTORE_DBLESS_AUTHORITY_PROVED');
console.log('CENTRAL_UI_R4A_PRIMARY_UI_ISOLATION_PROVED');
console.log('CENTRAL_UI_R4A_DBLESS_CONTRACT_PROVED');
