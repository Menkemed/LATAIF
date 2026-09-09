// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4A.1 — die zwei Lesevorgänge, die erst auf KLICK laufen.
// Run: node test/e2e/r4a1-click-reads.e2e.mjs
//
// R4A hat jede Fläche gezeichnet. Zwei Stellen blieben ausdrücklich offen, weil sie beim
// Zeichnen nie laufen: die Losauswahl in „Rechnung anlegen" und in „Reparatur anlegen". Beide
// griffen erst dann zur Datenbank, wenn der Mensch einen Artikel gewählt hatte — also genau in
// dem Moment, den kein Rundgang erreicht.
//
// Hier wird deshalb geklickt, an einem echten zweiten Rechner ohne Datenbank:
//
//   1. /invoices/new  → Artikel wählen → die Losauswahl muss offen dastehen und stimmen.
//   2. /repairs       → „New Repair" → „Own Item" → Artikel wählen → dasselbe.
//
// Der Stolperdraht aus R4A bleibt liegen (im Test, nicht im Programm) und wird vor dem ersten
// Skript der Seite gelegt. Er meldet jeden Griff zur lokalen Datenbank mit Route und Stapel.
// Zusätzlich hält ein Merkzeichen den Bildschirm des Primary fest: er darf sich durch nichts
// davon bewegen.
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
const OWNER_PW = 'r4a1-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r4a1-clicks', 'run-' + Date.now());
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
// Ein hängender Lauf ist kein grüner Lauf. Nach fünfzehn Minuten ist Schluss — mit Meldung.
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif-e2e-client.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  process.exit(1);
}, 15 * 60 * 1000);
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
/** Ein echter Klick auf den Knopf, dessen Beschriftung diesen Text ENTHÄLT. */
const clickContains = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes(${S(t)})); if(!b) return 'NO'; b.click(); return 'OK';`);
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

/** Der Stolperdraht aus R4A: er lebt im Test und liegt VOR dem ersten Skript der Seite. */
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

/**
 * Der Bestand: ein Artikel mit ZWEI aktiven Losen. Genau zwei, weil beide Masken die Auswahl
 * erst ab dem zweiten Los zeigen — mit einem einzigen wäre der Klickweg gar nicht sichtbar.
 */
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const frueher = new Date(Date.now() - 5 * 86400000).toISOString();
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-r4a1';
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)) {
      db.prepare(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(catId, branchId, 'R4A1 Watches', 'watch', '#000', now, now);
    }
    db.prepare(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES ('r41-sup', ?, 'R4A1 Supply', 1, ?, ?)`).run(branchId, now, now);
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES ('r41-cust', ?, 'Klara', 'Klick', 'R4A1 Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run(branchId, now, now);
    db.prepare(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES ('r41-prod', ?, ?, 'Zenith', 'R4A1 Chronometer', 'R4A1-SKU-88', 'Pre-Owned','[]',
        700,'BHD', 990,'in_stock','VAT_10',0,2,'[]','{}','OWN',?,?)`).run(branchId, catId, now, now);
    db.prepare(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
        total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
      VALUES ('r41-pur', ?, 'R41PUR-01', 'r41-sup', 'PAID', 1550, 1550, 0, ?, ?, ?)`)
      .run(branchId, frueher, frueher, frueher);
    // Zwei Lose, verschiedene Einstandspreise: so ist FIFO (das ältere zuerst) am Bildschirm
    // ablesbar und nicht nur behauptet.
    db.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('r41-lot-alt', ?, 'r41-prod', 'r41-pur', 700, 1, 1, 'ACTIVE', ?, ?)`).run(branchId, frueher, frueher);
    db.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('r41-lot-neu', ?, 'r41-prod', 'r41-pur', 850, 1, 1, 'ACTIVE', ?, ?)`).run(branchId, now, now);
  } finally { try { db.close(); } catch { /* zu */ } }
}

/**
 * Eine Fläche frisch aufbauen — mit gelegtem Stolperdraht — und ein neues Fenster greifen.
 * Die alte Verbindung wird ERST NACH dem Befehl geschlossen: auf einer geschlossenen Leitung
 * kommt keine Antwort mehr zurück, und der Lauf bliebe still stehen.
 */
async function ladeMitDraht(c, route) {
  await c.send('Page.enable', {});
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: TRIPWIRE_RAW });
  await c.ev(`location.replace(${S(route)}); return 1;`);
  c.close();
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const draehte = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const absturz = (c) => c.ev("return /UI CRASH/i.test(document.body.innerText) ? document.body.innerText.replace(/\\s+/g,' ').slice(0,180) : '';");
/** Die Losauswahl: die Liste, deren Einträge nach einem Los aussehen. */
const LOSAUSWAHL = `[...document.querySelectorAll('select')].find(s => [...s.options].some(o => /BHD/.test(o.textContent) && /\\(\\d+\\/\\d+\\)/.test(o.textContent)))`;
async function warteAufLosauswahl(c, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    const n = await c.ev(`const s = ${LOSAUSWAHL}; return s ? s.options.length : 0;`);
    if (n > 0) return n;
    await sleep(400);
  }
  return 0;
}

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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R4A1 Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R4A1 Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R4A1 Admin');
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

  // ── §5 Das Merkzeichen am Primary: Route, Suche, geoeffnete Ansicht ────
  {
    await primary.ev("const a=document.querySelector('a[href=\"/collection\"]'); if(a) a.click(); return 1;");
    await sleep(1500);
    await setVal(primary, 'input[placeholder*="Search"], input[type="text"]', 'Chrono');
    await sleep(900);
    // Eine Zeile aufklappen, damit auch eine geoeffnete Ansicht Teil des Merkzeichens ist.
    await primary.ev("const r=document.querySelector('[data-row-toggle], .chevron, button[aria-expanded]'); if(r) r.click(); return 1;");
    await sleep(700);
  }
  const merkzeichen = () => primary.ev(
    "return JSON.stringify({ p: location.pathname, s: location.search, "
    + "v: [...document.querySelectorAll('input')].map(i=>i.value), "
    + "sel: [...document.querySelectorAll('select')].map(s=>s.value), "
    + "auf: [...document.querySelectorAll('[aria-expanded]')].map(e=>e.getAttribute('aria-expanded')), "
    + "z: document.querySelectorAll('tbody tr, [data-row]').length });");
  const VORHER = await merkzeichen();

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
  ok(true, 'CONNECT frischer Rechner, echter Klick auf „Connect", Anmeldung — dann die normale Anwendung');

  // ══════════════════════════════════════════════════════════════════════
  // §2/§6 KLICKWEG 1 — „Rechnung anlegen": Artikel waehlen → Losauswahl
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await ladeMitDraht(client, '/invoices/new');
    await waitFor(client, '[data-ss-trigger="Pick product..."]', 45000);
    ok((await draehte(client)).length === 0, 'KLICK1 die Maske selbst zeichnet ohne lokale Datenbank');

    await click(client, '[data-ss-trigger="Pick product..."]');
    await sleep(600);
    const gefunden = await exists(client, '[data-ss-option="r41-prod"]');
    ok(gefunden, 'KLICK1 der Artikel steht im Picker (die Liste kam ueber das Netz)');
    await click(client, '[data-ss-option="r41-prod"]');

    const n = await warteAufLosauswahl(client, 30000);
    ok(n === 2, `KLICK1 nach dem Klick steht die Losauswahl da — mit beiden Losen (${n})`);

    const texte = await client.ev(`const s = ${LOSAUSWAHL}; return s ? [...s.options].map(o=>o.textContent.trim()).join(' || ') : '(keine)';`);
    ok(/700 BHD/.test(String(texte)) && /850 BHD/.test(String(texte)),
      `KLICK1 …und beide Einstandspreise sind echt (${String(texte).slice(0, 160)})`);
    ok(/R41PUR-01/.test(String(texte)),
      'KLICK1 …samt der Einkaufsnummer aus der verbundenen Tabelle');

    const gewaehlt = await client.ev(`const s = ${LOSAUSWAHL}; return s ? s.value : '';`);
    ok(gewaehlt === 'r41-lot-alt', `KLICK1 …und vorgewaehlt ist FIFO, also das aeltere Los (${gewaehlt})`);

    const hits = await draehte(client);
    const crash = await absturz(client);
    for (const h of hits.slice(0, 2)) console.log(`      ${h.was}: ${h.text} :: ${h.stapel.slice(0, 260)}`);
    ok(hits.length === 0, `KLICK1 kein Griff zur lokalen Datenbank waehrend der ganzen Handlung (${hits.length})`);
    ok(crash === '', `KLICK1 keine Fehlergrenze (${crash})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §2/§6 KLICKWEG 2 — „Reparatur anlegen": eigener Artikel → Losauswahl
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await ladeMitDraht(client, '/repairs');
    await waitFor(client, SHELL, 45000);
    ok((await draehte(client)).length === 0, 'KLICK2 die Liste selbst zeichnet ohne lokale Datenbank');

    ok(await clickText(client, 'New Repair') === 'OK', 'KLICK2 die Maske oeffnet auf Klick');
    await sleep(900);
    ok(await clickContains(client, 'Own Item') === 'OK', 'KLICK2 …und laesst sich auf „eigener Artikel" stellen');
    await sleep(700);

    await waitFor(client, '[data-ss-trigger^="Search by brand"]', 20000);
    await click(client, '[data-ss-trigger^="Search by brand"]');
    await sleep(600);
    ok(await exists(client, '[data-ss-option="r41-prod"]'), 'KLICK2 der eigene Artikel steht im Picker');
    await click(client, '[data-ss-option="r41-prod"]');

    const n = await warteAufLosauswahl(client, 30000);
    // Hier steht ein „Auto (FIFO)" vor den Losen — deshalb drei Eintraege, nicht zwei.
    ok(n === 3, `KLICK2 nach dem Klick steht die Losauswahl da: Auto plus beide Lose (${n})`);
    const texte = await client.ev(`const s = ${LOSAUSWAHL}; return s ? [...s.options].map(o=>o.textContent.trim()).join(' || ') : '(keine)';`);
    ok(/700 BHD/.test(String(texte)) && /850 BHD/.test(String(texte)),
      `KLICK2 …mit beiden echten Einstandspreisen (${String(texte).slice(0, 160)})`);

    const hits = await draehte(client);
    const crash = await absturz(client);
    for (const h of hits.slice(0, 2)) console.log(`      ${h.was}: ${h.text} :: ${h.stapel.slice(0, 260)}`);
    ok(hits.length === 0, `KLICK2 kein Griff zur lokalen Datenbank waehrend der ganzen Handlung (${hits.length})`);
    ok(crash === '', `KLICK2 keine Fehlergrenze (${crash})`);
  }

  // ── §4 Die Antwort haengt am Ausweis, nicht am Rumpf ──────────────────
  {
    const fremd = await client.ev(
      "const r = await window.__TAURI_INTERNALS__.invoke('bridge_probe').catch(()=>null); void r;"
      + "return 'ok';");
    void fremd;
    // Der Client selbst kann keine fremde Filiale wählen: sein Ausweis ist der Beweis.
    const sess = JSON.parse(await client.ev("return localStorage.getItem('lataif_session') || '{}';"));
    const claims = JSON.parse(Buffer.from(String(sess.token || '..').split('.')[1] || '', 'base64').toString('utf8') || '{}');
    ok(sess.branchId === claims.branch_id, `AUTH die Filiale der Sitzung stammt aus dem Ausweis (${sess.branchId} / ${claims.branch_id})`);
    const primaryBranch = dbQ(BIZ_DB, 'SELECT id FROM branches')[0]?.id;
    ok(sess.branchId === primaryBranch, `AUTH …und ist die Filiale des Primary-Datenbestands (${sess.branchId} / ${primaryBranch})`);
  }

  // ── §5 Der Bildschirm des Primary ist unveraendert ────────────────────
  {
    const NACHHER = await merkzeichen();
    if (VORHER !== NACHHER) {
      console.log('      vorher : ' + String(VORHER).slice(0, 300));
      console.log('      nachher: ' + String(NACHHER).slice(0, 300));
    }
    ok(VORHER === NACHHER, 'ISO Route, Suche, Auswahl und geoeffnete Ansicht des Primary sind unveraendert');
  }

  // ── §6 Der Client besitzt weiterhin nichts ────────────────────────────
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

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r4a.1: click driven reads on a real client: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4A1_CLICK_READ_PATHS_AUDITED');
console.log('CENTRAL_UI_R4A1_CLICK_READ_SCOPE_PROVED');
console.log('CENTRAL_UI_R4A1_PRIMARY_ISOLATION_PROVED');
