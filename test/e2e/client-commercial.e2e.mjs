// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3E — der ECHTE Client legt Einkauf, Kommission und Auftrag an und aendert sie.
//
// Zwei wirkliche Anwendungen auf einer Maschine, zwei Kennungen, echte Klicks:
//   • der PRIMARY (`lataif.exe`, `com.lataif.app.e2e`, CDP 9223) — Datenbank, Buchhaltung, LAN;
//   • der CLIENT (`lataif-e2e-client.exe`, `com.lataif.app.e2e.client`, CDP 9224) — leeres
//     Kontrollverzeichnis, keine Datenbank, nie eine.
//
// Der Single-Instance-Riegel der Produktion wird nicht umgangen, sondern nicht getroffen: zwei
// Kennungen sind zwei Anwendungen.
//
// Was hier bewiesen wird und kein Node-Test beweisen kann:
//   1. Ein Mensch legt am zweiten Rechner einen Einkauf an — Ware, Verbindlichkeit und Buchung
//      stehen danach am Primary.
//   2. Eine verschluckte Antwort erzeugt KEINE zweite Ware und keinen zweiten Beleg.
//   3. Kommission und Auftrag entstehen und lassen sich aendern; ein ALTER Stand wird abgewiesen.
//   4. Zwei gleichzeitige Anlagen desselben Belegtyps bekommen ZWEI Nummern.
//   5. Der Client bleibt dabei ohne Datenbank.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eBinary, assertE2eClientBinary, assertE2eScope, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const CLIENT_APP = join(REPO, 'src-tauri/target/debug/lataif-e2e-client.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011, PROXY = 3012;
const BASE = `http://127.0.0.1:${PORT}`;
const PROXY_BASE = `http://127.0.0.1:${PROXY}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-owner-' + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-c3e-ui', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
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
  APPDATA: CLIENT_APPDATA,
  LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'),
  TMP: join(CLIENT_HOME, 'tmp'),
  LATAIF_E2E_SYNC_PORT: String(PORT),
});

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const count = (sql, params = []) => Number(dbQ(BIZ_DB, sql, params)[0]?.c ?? -1);
const one = (sql, params = []) => dbQ(BIZ_DB, sql, params)[0];

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const killImage = (name) => { try { execFileSync('taskkill', ['/F', '/IM', name, '/T'], { stdio: 'ignore' }); } catch {} };
function killAll() { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); }
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' }); if (!out.includes(name)) return; } catch { return; }
    await sleep(300);
  }
}
async function waitPortFree(port) {
  for (let i = 0; i < 60; i++) {
    try { const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }); if (!out.split('\n').some((l) => l.includes(`:${port} `) && /LISTENING/.test(l))) return; } catch { return; }
    await sleep(300);
  }
}
async function attach(cdpPort, exe, env) {
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  const end = Date.now() + 120000; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(500);
  }
  if (!page) throw new Error(`no CDP page on ${cdpPort} for ${exe}`);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function attachOnly(cdpPort) {
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const text = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.textContent.trim() : null;`);
// Ein Klick, der nichts trifft, ist kein Klick: er wird laut, statt still weiterzulaufen. Ein
// stiller Fehlklick sieht spaeter aus wie ein Fehler der Anwendung.
const click = async (c, sel) => {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') {
    const around = await c.ev("return [...document.querySelectorAll('[data-client-area],button')].slice(0,40).map(e=>(e.getAttribute('data-client-area')||e.textContent.trim().slice(0,24))+(e.disabled?'(disabled)':'')).join(' | ');");
    throw new Error(`click ${sel} → ${r}; on screen: ${around}`);
  }
  return r;
};
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seenTxt = '(no screen)';
  try { seenTxt = String(await c.ev('return document.body.innerText.slice(0,400);')).replace(/\s+/g, ' '); } catch {}
  throw new Error(`waitFor ${sel} — screen says: ${seenTxt}`);
}

async function frontendLogin(c) {
  await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin');
    await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev("[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;");
  }
  await waitFor(c, 'a[href="/settings"], nav a, [data-testid]', 30000);
}
async function ensureSignedIn(c) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    if (await exists(c, 'a[href="/settings"], nav a, [data-testid]')) return true;
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) {
      try { await frontendLogin(c); return true; } catch { await sleep(1000); }
    }
    await sleep(400);
  }
  throw new Error('primary shell never appeared');
}
const invokeErr = (c, cmd, args) => c.ev(`try { await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args || {})}); return 'NO-ERROR'; } catch (e) { return String(e); }`);

/** Ein Lieferant, eine Kategorie, zwei Artikel, ein Kunde — mehr brauchen die drei Belege nicht. */
function seedFixture() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-c3e';
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)) {
      db.prepare(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(catId, branchId, 'C3E Watches', 'watch', '#000', now, now);
    }
    db.prepare(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES ('c3e-sup', ?, 'C3E Geneva Trading', 1, ?, ?)`).run(branchId, now, now);
    const product = (id, sku, qty) => {
      db.prepare(
        `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
           purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
           quantity, images, attributes, source_type, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'Pre-Owned','[]', 100,'BHD', 150,'in_stock','VAT_10',0,?, '[]','{}','OWN',?,?)`)
        .run(id, branchId, catId, 'Zenith', 'C3E ' + sku, sku, qty, now, now);
    };
    product('c3e-a', 'C3E-A', 0);
    product('c3e-b', 'C3E-B', 2);
    db.prepare(
      `INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
         vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
       VALUES ('c3e-cust', ?, 'Commercial', 'Client', 'C3E Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run(branchId, now, now);
    return { branchId, catId };
  } finally { try { db.close(); } catch {} }
}

// ── Der Vermittler: leitet weiter und kann EINE Antwort verschlucken ───────
const seen = [];
let swallowOp = null;
let swallowed = 0;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const proxy = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    let parsed = null;
    try { parsed = JSON.parse(body.toString('utf8')); } catch {}
    if (parsed?.op) seen.push({ op: parsed.op, commandId: parsed.commandId, payload: parsed.payload });
    let upstream;
    try {
      upstream = await fetch(BASE + req.url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
        body: req.method === 'GET' ? undefined : body,
      });
    } catch {
      res.writeHead(502, CORS); res.end(S({ ok: false, error: 'PROXY_UPSTREAM' })); return;
    }
    const outBody = Buffer.from(await upstream.arrayBuffer());
    if (swallowOp && parsed?.op === swallowOp) {
      // Der Primary IST fertig — er hat committet und gespeichert. Der Client erfaehrt es nicht.
      swallowOp = null; swallowed += 1;
      res.writeHead(504, { 'Content-Type': 'application/json', ...CORS });
      res.end(S({ ok: false, error: 'BRIDGE_TIMEOUT' }));
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...CORS });
    res.end(outBody);
  });
});

console.log('CENTRAL-C3E — the real client creates purchases, consignments and orders\n');
let primary = null, client = null;
try {
  if (!APP_DATA_DIR.includes(IDENT)) throw new Error('refusing to touch a non-e2e AppData');
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe'); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(CLIENT_HOME, { recursive: true, force: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  mkdirSync(join(CLIENT_HOME, 'tmp'), { recursive: true });
  mkdirSync(CLIENT_APPDATA, { recursive: true });

  const pMarks = assertE2eBinary(APP);
  const cMarks = assertE2eClientBinary(CLIENT_APP);
  ok(pMarks.verified.length === 4, `INSTANCE the primary artefact is the isolated e2e build (${pMarks.verified.length} markers)`);
  ok(cMarks.verified.length === 4, `INSTANCE the client artefact is a SEPARATE isolated build (${cMarks.verified.length} markers)`);
  assertE2eScope({ appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  const libRs = readFileSync(join(REPO, 'src-tauri/src/lib.rs'), 'utf8');
  ok(/\.plugin\(tauri_plugin_single_instance::init\(/.test(libRs),
    'INSTANCE the single-instance guard is untouched — two windows here are two IDENTITIES, not a bypass');
  ok(!/LATAIF_E2E_SECOND_INSTANCE|allow_second_instance/.test(libRs),
    'INSTANCE …and no test switch was built into the shipped binary');

  // ── Der Primary ─────────────────────────────────────────────────────────
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await ensureSignedIn(primary);

  primary.close(); killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  const fixture = seedFixture();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await ensureSignedIn(primary);
  ok(await invokeErr(primary, 'sync_server_start', {}) === 'NO-ERROR', 'the primary serves on the LAN');
  {
    const end = Date.now() + 45000; let up = false;
    while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
    ok(up, 'the server answers');
  }
  await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));

  // ── Der Client ──────────────────────────────────────────────────────────
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev(`localStorage.setItem('lataif_runtime_mode','client'); localStorage.setItem('lataif_client_server_url', ${S(PROXY_BASE)}); return 1;`);
  await client.ev('location.reload(); return 1;');
  await sleep(3000);
  client.close();
  client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"], [data-client-mode]', 60000);
  if (await exists(client, 'input[type="password"]')) {
    await setVal(client, 'input[type="email"]', OWNER_EMAIL);
    await setVal(client, 'input[type="password"]', OWNER_PW);
    await click(client, '[data-client-signin]');
  }
  await waitFor(client, '[data-client-mode]', 45000);
  ok(true, 'UI the client signs in against the primary');

  // ── Die neuen Lesevorgaenge tragen wirklich ─────────────────────────────
  await click(client, '[data-client-area="new-purchase"]');
  await waitFor(client, '[data-client-purchase-form]', 30000);
  await waitFor(client, '[data-client-field="purchase.supplierId"] option[value="c3e-sup"]', 30000);
  ok(true, 'READS suppliers.list reaches the client');
  await waitFor(client, '[data-client-line-product="0"] option[value="c3e-a"]', 30000);
  ok(true, 'READS …and products.list feeds the line editor');

  // ── 1) Einkauf anlegen ──────────────────────────────────────────────────
  await setVal(client, '[data-client-field="purchase.supplierId"]', 'c3e-sup');
  await setVal(client, '[data-client-field="purchase.taxScheme"]', 'VAT_10');
  await setVal(client, '[data-client-line-product="0"]', 'c3e-a');
  await setVal(client, '[data-client-line-qty="0"]', '2');
  await setVal(client, '[data-client-line-price="0"]', '100');
  await setVal(client, '[data-client-field="purchase.paymentAmount"]', '50');
  await setVal(client, '[data-client-field="purchase.paymentMethod"]', 'bank');
  await click(client, '[data-client-purchase-save]');
  await waitFor(client, '[data-client-purchase-done]', 60000);
  await sleep(1500);

  const pur = one('SELECT id, purchase_number, total_amount, paid_amount FROM purchases ORDER BY created_at DESC LIMIT 1');
  ok(!!pur, 'PURCHASE the purchase exists on the primary');
  ok(String(await text(client, '[data-client-purchase-number]')) === String(pur.purchase_number),
    `PURCHASE the client shows the primary's number (${pur.purchase_number})`);
  ok(Number(pur.total_amount) === 200 && Number(pur.paid_amount) === 50,
    `PURCHASE the primary calculated the total (${pur.total_amount} / ${pur.paid_amount})`);
  ok(count('SELECT COUNT(*) c FROM stock_lots WHERE purchase_id = ?', [pur.id]) === 1,
    'PURCHASE one lot came in');
  ok(Number(one("SELECT quantity c FROM products WHERE id = 'c3e-a'")?.c) === 2,
    'PURCHASE and the item now has stock');
  ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='PURCHASE' AND source_id = ?", [pur.id]) > 0,
    'PURCHASE the goods receipt is booked');
  ok(count('SELECT COUNT(*) c FROM purchase_payments WHERE purchase_id = ?', [pur.id]) === 1,
    'PURCHASE the payment is a payment, not just a number in the header');

  // ── 2) Verlorene Antwort beim Einkauf ───────────────────────────────────
  await click(client, '[data-client-purchase-again]');
  await waitFor(client, '[data-client-purchase-form]', 30000);
  await waitFor(client, '[data-client-field="purchase.supplierId"] option[value="c3e-sup"]', 30000);
  await setVal(client, '[data-client-field="purchase.supplierId"]', 'c3e-sup');
  await setVal(client, '[data-client-line-product="0"]', 'c3e-a');
  await setVal(client, '[data-client-line-qty="0"]', '1');
  await setVal(client, '[data-client-line-price="0"]', '70');
  const purBefore = seen.filter((s) => s.op === 'purchases.create').length;
  swallowOp = 'purchases.create';
  await click(client, '[data-client-purchase-save]');
  await waitFor(client, '[data-client-pending="purchase"]', 60000);
  ok(swallowed === 1, 'UNKNOWN the answer was swallowed after the primary had committed');
  await sleep(1500);
  ok(count('SELECT COUNT(*) c FROM purchases') === 2, 'UNKNOWN the purchase DID happen on the primary…');
  ok(String(await text(client, '[data-client-pending="purchase"]')).includes('not known'),
    'UNKNOWN …and the client says the outcome is not known');

  await click(client, '[data-client-purchase-save]');
  await waitFor(client, '[data-client-purchase-done]', 60000);
  await sleep(1500);
  const purCalls = seen.filter((s) => s.op === 'purchases.create');
  ok(purCalls.length === purBefore + 2, `UNKNOWN two requests were sent (${purCalls.length - purBefore})`);
  ok(purCalls[purBefore].commandId === purCalls[purBefore + 1].commandId, 'UNKNOWN …with the SAME command id');
  ok(count('SELECT COUNT(*) c FROM purchases') === 2, 'UNKNOWN no second purchase');
  ok(count('SELECT COUNT(*) c FROM stock_lots') === 2, 'UNKNOWN no second lot');
  ok(Number(one("SELECT quantity c FROM products WHERE id = 'c3e-a'")?.c) === 3,
    'UNKNOWN the stock moved once, not twice');
  ok(count("SELECT COUNT(DISTINCT source_id) c FROM ledger_entries WHERE source_module='PURCHASE'") === 2,
    'UNKNOWN and exactly two goods receipts are booked, not three');
  ok(String(await text(client, '[data-client-purchase-replayed]')).includes('already run'),
    'UNKNOWN the client is told it was the replay');

  // ── 3) Kommission anlegen ───────────────────────────────────────────────
  await click(client, '[data-client-area="new-consignment"]');
  await waitFor(client, '[data-client-consignment-form]', 30000);
  await waitFor(client, `[data-client-field="consignment.categoryId"] option[value="${fixture.catId}"]`, 30000);
  ok(true, 'READS categories.list reaches the client');
  await waitFor(client, '[data-client-field="consignment.consignorId"] option[value="c3e-cust"]', 30000);
  await setVal(client, '[data-client-field="consignment.consignorId"]', 'c3e-cust');
  await setVal(client, `[data-client-field="consignment.categoryId"]`, fixture.catId);
  await setVal(client, '[data-client-field="consignment.brand"]', 'Patek');
  await setVal(client, '[data-client-field="consignment.name"]', 'Nautilus 5711');
  await setVal(client, '[data-client-field="consignment.agreedPrice"]', '1000');
  await setVal(client, '[data-client-field="consignment.payoutModel"]', 'percent');
  await setVal(client, '[data-client-field="consignment.commissionRate"]', '20');
  await click(client, '[data-client-consignment-save]');
  await waitFor(client, '[data-client-consignment-done]', 60000);
  await sleep(1500);

  const con = one('SELECT id, consignment_number, product_id, commission_type, commission_rate, agreed_price, revision FROM consignments ORDER BY created_at DESC LIMIT 1');
  ok(!!con, 'CONSIGN the consignment exists on the primary');
  ok(String(con.commission_type) === 'percent' && Number(con.commission_rate) === 20,
    `CONSIGN the payout model is what the human chose (${con.commission_type}/${con.commission_rate})`);
  const conProduct = one('SELECT sku, stock_status, source_type, purchase_price FROM products WHERE id = ?', [con.product_id]);
  ok(String(conProduct.stock_status) === 'consignment' && String(conProduct.source_type) === 'CONSIGNMENT',
    'CONSIGN the item is consigned stock, not ours');
  ok(String(conProduct.sku || '').length > 0, `CONSIGN the SKU came from the primary (${conProduct.sku})`);
  ok(Math.abs(Number(conProduct.purchase_price) - 800) < 0.01,
    `CONSIGN the expected cost comes from the model (${conProduct.purchase_price})`);

  // ── 4) Kommission aendern, und ein ALTER Stand wird abgewiesen ──────────
  await click(client, '[data-client-area="consignments"]');
  await waitFor(client, '[data-client-list]', 30000);
  await click(client, `[data-client-row="${con.id}"]`);
  await waitFor(client, '[data-client-edit-consignment]', 30000);
  await click(client, '[data-client-edit-consignment]');
  await waitFor(client, '[data-client-consignment-form]', 30000);
  await setVal(client, '[data-client-field="consignment.agreedPrice"]', '1200');
  await setVal(client, '[data-client-field="consignment.notes"]', 'renegotiated from the second machine');
  await click(client, '[data-client-consignment-save]');
  await waitFor(client, '[data-client-consignment-done]', 60000);
  await sleep(1500);
  const conAfter = one('SELECT agreed_price, notes, revision FROM consignments WHERE id = ?', [con.id]);
  ok(Number(conAfter.agreed_price) === 1200, `CONSIGN-EDIT the primary applied the change (${conAfter.agreed_price})`);
  ok(String(conAfter.notes) === 'renegotiated from the second machine', 'CONSIGN-EDIT …with the words the human typed');
  ok(Number(conAfter.revision) > Number(con.revision),
    `CONSIGN-EDIT the revision moved (${con.revision} → ${conAfter.revision})`);

  // Zurueck zur Liste und die Kommission NEU oeffnen — der Client haelt danach die Fassung,
  // die er jetzt liest.
  await click(client, '[data-client-consignment-back]');
  await waitFor(client, '[data-client-list]', 30000);

  // Der Client haelt jetzt eine ALTE Fassung — der Primary aendert dazwischen.
  const token = await (async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: S({ email: OWNER_EMAIL, password: OWNER_PW }),
    });
    return (await r.json()).token;
  })();
  const post = (op, payload) => fetch(`${BASE}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: S({ op, commandId: crypto.randomUUID(), payload }),
  });

  await click(client, `[data-client-row="${con.id}"]`);
  await waitFor(client, '[data-client-edit-consignment]', 30000);
  await click(client, '[data-client-edit-consignment]');
  await waitFor(client, '[data-client-consignment-form]', 30000);
  const staleRev = Number(one('SELECT revision c FROM consignments WHERE id = ?', [con.id])?.c);
  const moved = await post('consignments.update', { id: con.id, expectedRevision: staleRev, notes: 'primary moved it' });
  ok(moved.ok, `STALE the primary moved the consignment in between (${moved.status})`);
  await sleep(1200);
  await setVal(client, '[data-client-field="consignment.agreedPrice"]', '1500');
  await click(client, '[data-client-consignment-save]');
  await waitFor(client, '[data-client-rejected="consignment"]', 60000);
  ok(/RECORD_CHANGED/.test(String(await text(client, '[data-client-rejected="consignment"]'))),
    'STALE the client is told the record changed');
  await sleep(1200);
  ok(Number(one('SELECT agreed_price c FROM consignments WHERE id = ?', [con.id])?.c) === 1200,
    'STALE nothing was overwritten');
  ok(String(one('SELECT notes c FROM consignments WHERE id = ?', [con.id])?.c) === 'primary moved it',
    "STALE …and the primary's change stands");

  // ── 5) Auftrag anlegen ──────────────────────────────────────────────────
  await click(client, '[data-client-area="new-order"]');
  await waitFor(client, '[data-client-order-form]', 30000);
  await waitFor(client, '[data-client-field="order.customerId"] option[value="c3e-cust"]', 30000);
  await setVal(client, '[data-client-field="order.customerId"]', 'c3e-cust');
  await setVal(client, '[data-client-line-product="0"]', 'c3e-b');
  await setVal(client, '[data-client-line-qty="0"]', '2');
  await setVal(client, '[data-client-line-price="0"]', '300');
  await setVal(client, '[data-client-field="order.depositAmount"]', '200');
  await setVal(client, '[data-client-field="order.paymentMethod"]', 'cash');
  await click(client, '[data-client-order-save]');
  await waitFor(client, '[data-client-order-done]', 60000);
  await sleep(1500);

  const ord = one('SELECT id, order_number, type, agreed_price, deposit_amount, remaining_amount, revision FROM orders ORDER BY created_at DESC LIMIT 1');
  ok(!!ord, 'ORDER the order exists on the primary');
  ok(String(ord.type) === 'normal', `ORDER it is a normal order (${ord.type})`);
  ok(Number(ord.agreed_price) === 600, `ORDER the primary summed the lines (${ord.agreed_price})`);
  ok(Number(ord.remaining_amount) === 400, `ORDER …and derived the remainder (${ord.remaining_amount})`);
  ok(count('SELECT COUNT(*) c FROM order_payments WHERE order_id = ?', [ord.id]) === 1,
    'ORDER the deposit is a payment, not just a header number');
  ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='ORDER_PAYMENT'") > 0,
    'ORDER and it is booked');
  ok(Number(one("SELECT quantity c FROM products WHERE id = 'c3e-b'")?.c) === 2,
    'ORDER an order takes no stock — it is a promise, not a shipment');

  // ── 6) Auftrag aendern ──────────────────────────────────────────────────
  await click(client, '[data-client-area="orders"]');
  await waitFor(client, '[data-client-list]', 30000);
  await click(client, `[data-client-row="${ord.id}"]`);
  await waitFor(client, '[data-client-edit-order]', 30000);
  await click(client, '[data-client-edit-order]');
  await waitFor(client, '[data-client-order-form]', 30000);
  await setVal(client, '[data-client-field="order.agreedPrice"]', '700');
  await setVal(client, '[data-client-field="order.supplierPrice"]', '400');
  await click(client, '[data-client-order-save]');
  await waitFor(client, '[data-client-order-done]', 60000);
  await sleep(1500);
  const ordAfter = one('SELECT agreed_price, remaining_amount, expected_margin, revision FROM orders WHERE id = ?', [ord.id]);
  ok(Number(ordAfter.agreed_price) === 700, `ORDER-EDIT the new price stands (${ordAfter.agreed_price})`);
  ok(Number(ordAfter.remaining_amount) === 500,
    `ORDER-EDIT the primary re-derived the remainder (700 − 200 = ${ordAfter.remaining_amount})`);
  ok(Number(ordAfter.expected_margin) === 300,
    `ORDER-EDIT …and the margin (700 − 400 = ${ordAfter.expected_margin})`);
  ok(Number(ordAfter.revision) > Number(ord.revision), 'ORDER-EDIT the revision moved');

  await click(client, '[data-client-order-back]');
  await waitFor(client, '[data-client-list]', 30000);

  // Und der alte Stand traegt nicht mehr.
  const oldRev = Number(ord.revision);
  const staleOrder = await post('orders.update', { id: ord.id, expectedRevision: oldRev, agreedPrice: 1 });
  const staleBody = await staleOrder.json();
  ok(staleBody.error === 'RECORD_CHANGED', `ORDER-STALE an old revision is refused (${S(staleBody)})`);
  ok(Number(one('SELECT agreed_price c FROM orders WHERE id = ?', [ord.id])?.c) === 700,
    'ORDER-STALE and nothing was overwritten');

  // ── 7) Nummernvergabe unter gleichzeitiger Last, je Belegtyp ────────────
  const before = {
    pur: count('SELECT COUNT(*) c FROM purchases'),
    con: count('SELECT COUNT(*) c FROM consignments'),
    ord: count('SELECT COUNT(*) c FROM orders'),
  };
  const purBody = { supplierId: 'c3e-sup', lines: [{ productId: 'c3e-a', quantity: 1, unitPrice: 10 }] };
  const conBody = {
    consignorId: 'c3e-cust', product: { brand: 'Rolex', name: 'Submariner ' + Date.now(), categoryId: fixture.catId },
    agreedPrice: 500, payout: { model: 'percent', commissionRate: 10 }, acknowledgeDuplicate: true,
  };
  const ordBody = { customerId: 'c3e-cust', lines: [{ productId: 'c3e-b', quantity: 1, unitPrice: 20 }] };
  const [p1, p2] = await Promise.all([post('purchases.create', purBody), post('purchases.create', purBody)]);
  const [c1, c2] = await Promise.all([post('consignments.create', conBody), post('consignments.create', { ...conBody, product: { ...conBody.product, name: conBody.product.name + ' II' } })]);
  const [o1, o2] = await Promise.all([post('orders.create', ordBody), post('orders.create', ordBody)]);
  ok(p1.ok && p2.ok && c1.ok && c2.ok && o1.ok && o2.ok,
    `NUMBERING all six were answered (${[p1, p2, c1, c2, o1, o2].map((r) => r.status).join('/')})`);
  await sleep(1500);
  const distinct = (t, col) => Number(dbQ(BIZ_DB, `SELECT COUNT(DISTINCT ${col}) c FROM ${t}`)[0]?.c ?? -1);
  ok(count('SELECT COUNT(*) c FROM purchases') === before.pur + 2
    && distinct('purchases', 'purchase_number') === before.pur + 2,
  `NUMBERING two purchases, two numbers (${distinct('purchases', 'purchase_number')})`);
  ok(count('SELECT COUNT(*) c FROM consignments') === before.con + 2
    && distinct('consignments', 'consignment_number') === before.con + 2,
  `NUMBERING two consignments, two numbers (${distinct('consignments', 'consignment_number')})`);
  ok(count('SELECT COUNT(*) c FROM orders') === before.ord + 2
    && distinct('orders', 'order_number') === before.ord + 2,
  `NUMBERING two orders, two numbers (${distinct('orders', 'order_number')})`);
  ok(distinct('products', 'sku') === count('SELECT COUNT(*) c FROM products'),
    'NUMBERING and every item still has its own SKU');

  // ── 8) Was NICHT freigegeben ist, erreicht nichts ───────────────────────
  for (const op of ['purchases.update', 'orders.delete', 'consignments.record_sale']) {
    const r = await post(op, {});
    const b = await r.json().catch(() => ({}));
    ok(!r.ok || b.ok === false, `CLOSED ${op} is refused (${r.status} ${S(b).slice(0, 80)})`);
  }

  // ── 9) Der Client hat immer noch nichts angelegt ────────────────────────
  const after = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  ok(!after.includes('lataif.db') && !after.includes('lataif_sync_server.db') && !after.includes('data-location.json'),
    `DBLESS after three documents the client still owns nothing (${after.join(', ') || 'empty'})`);
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message || String(e)));
  console.log('  x harness: ' + (e?.message || String(e)));
} finally {
  try { primary?.close(); } catch {}
  try { client?.close(); } catch {}
  try { proxy.close(); } catch {}
  killAll();
  await waitGone('lataif.exe');
  await waitGone('lataif-e2e-client.exe');
  rmSync(CLIENT_HOME, { recursive: true, force: true });
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c3e client commercial documents: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3E_REAL_CLIENT_COMMERCIAL_E2E_PROVED');
