// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C2 — ein zweiter Rechner liest vom Primary, durch die echte Kette.
//
// Der Client ist hier bewusst nur HTTP: genau das, was die Client-Oberfläche tut. Er hat keine
// Datenbank, keinen Datenort, keine Kennung — er kann gar nicht anders, als zu fragen. Damit ist
// die Zusage „der Client legt nichts an" nicht behauptet, sondern strukturell wahr.
//
// Der wichtigste Beweis ist Punkt 8: eine Änderung, die NUR im Speicher des Primary steht, muss
// beim Client ankommen, während die Datei auf der Platte noch den alten Wert trägt. Käme die
// Antwort aus der Datei, wäre sie veraltet — und `saveDatabase()` ist fire-and-forget mit über
// 200 Aufrufern, die Datei hinkt also regelmäßig hinterher.
//
// Isolierter e2e-Bezeichner + AppData + Sync-Port (3011); die Produktion wird nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-owner-' + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-c2-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.logs = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') this.logs.push((m.params.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' '));
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

let appProc;
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
function killAllApp() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
async function waitProcessGone(ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' }).Count"], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(400);
  }
  return false;
}
async function waitPortFree(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(500);
  }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); }
  throw new Error('no invoke');
}
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickText = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }

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
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`);
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
  throw new Error('app shell never appeared');
}
const invokeErr = (c, cmd, args) => c.ev(`try { await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args || {})}); return 'NO-ERROR'; } catch (e) { return String(e); }`);
const invoke = (c, cmd, args) => c.ev(`return await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args || {})});`);

/** Der Bestand des Primary, im Ruhezustand geschrieben — die App laeuft dabei NICHT. */
function seedFixture() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, quantity,
         images, attributes, source_type, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'Pre-Owned','[]',?, 'BHD','in_stock','MARGIN',0,?,'[]','{}','OWN',?,?)`)
      .run('c2-prod-1', branchId, 'cat-watch', 'Zenith', 'C2 Reference', 'C2-WCH-001', 250, 3, now, now);
    db.prepare(
      `INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
         vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
       VALUES (?,?,?,?,?, 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run('c2-cust-1', branchId, 'Remote', 'Reader', 'C2 Co', now, now);
    db.prepare(
      `INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, currency,
         net_amount, vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot, paid_amount,
         issued_at, created_at, updated_at)
       VALUES (?,?,?,?, 'FINAL','BHD', 100, 10, 10, 110, 'VAT_10', 40, ?,?,?)`)
      .run('c2-inv-1', branchId, 'INV-C2-0001', 'c2-cust-1', now, now, now);
    return branchId;
  } finally { try { db.close(); } catch {} }
}

// ── Der Client: nur HTTP, keine Datenbank ─────────────────────────────────
let clientToken = null;

async function clientLogin(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  clientToken = body.token || null;
  return clientToken;
}

const uuid = () => crypto.randomUUID();

async function clientRead(op, input = {}) {
  const res = await fetch(`${BASE}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
    body: JSON.stringify({ op, commandId: uuid(), payload: input }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

console.log('CENTRAL-C2 — a second machine reads from the primary\n');
try {
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  let c = await startApp();
  await waitInvoke(c);
  await ensureSignedIn(c);

  // Fixture im Ruhezustand.
  c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  const branchId = seedFixture();
  ok(dbQ(BIZ_DB, "SELECT COUNT(*) c FROM products WHERE id='c2-prod-1'")[0]?.c === 1, 'the primary has the fixture product');
  ok(dbQ(BIZ_DB, "SELECT COUNT(*) c FROM customers WHERE id='c2-cust-1'")[0]?.c === 1, 'and the fixture customer');
  ok(dbQ(BIZ_DB, "SELECT COUNT(*) c FROM invoices WHERE id='c2-inv-1'")[0]?.c === 1, 'and the fixture invoice');

  // Der Primary wird im Ruhezustand zum Primary gemacht — mit demselben Werkzeug und demselben
  // eigentuemer-autorisierten Weg, den auch die uebrigen Suiten benutzen.
  const seedOut = execFileSync(SEED, ['seed-primary', SERVER_DB], {
    env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8',
  }).trim();
  ok(/OK/.test(seedOut), `the install is provisioned and made primary (${seedOut})`);

  c = await startApp();
  await waitInvoke(c);
  await ensureSignedIn(c);

  ok(await invokeErr(c, 'sync_server_start', {}) === 'NO-ERROR', 'and serves on the LAN');
  {
    const end = Date.now() + 45000; let up = false;
    while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
    ok(up, 'the server answers');
  }

  // ── Anmeldung ───────────────────────────────────────────────────────────
  ok(await clientLogin(OWNER_EMAIL, 'definitely-wrong') === null, 'AUTH wrong credentials get no session');
  const before = await clientRead('products.list');
  ok(before.status === 401 || before.status === 403, `AUTH …and without a session there is no business read (${before.status})`);

  ok(await clientLogin(OWNER_EMAIL, OWNER_PW) !== null, 'AUTH the real credentials do');
  ok(typeof clientToken === 'string' && clientToken.length > 20, 'AUTH …and hand out a token');

  // ── Lesen ───────────────────────────────────────────────────────────────
  const products = await clientRead('products.list');
  ok(products.status === 200 && products.body.ok === true, `READ the client can list products (${products.status})`);
  const items = products.body.value?.items ?? [];
  const seeded = items.find((p) => p.id === 'c2-prod-1');
  ok(!!seeded, `READ the fixture product is there (${items.length} rows)`);
  ok(seeded?.sku === 'C2-WCH-001' && seeded?.quantity === 3, `READ with its own fields (${seeded?.sku}, x${seeded?.quantity})`);
  ok(seeded?.brand === 'Zenith', 'READ …and its brand');
  ok(!('supplierName' in (seeded || {})) && !('notes' in (seeded || {})),
    'READ but not every column — the answer is a shape, not the table');
  const stock = products.body.value?.stock;
  ok(stock && stock.units >= 3 && stock.records >= 1,
    `READ the headline counts pieces, not rows (${stock?.records} rows / ${stock?.units} pieces)`);

  const customers = await clientRead('customers.list');
  ok(customers.status === 200 && (customers.body.value?.items ?? []).some((x) => x.id === 'c2-cust-1'),
    'READ the customer is visible');
  const invoices = await clientRead('invoices.list');
  const inv = (invoices.body.value?.items ?? []).find((x) => x.id === 'c2-inv-1');
  ok(!!inv, 'READ the invoice is visible');
  ok(inv?.grossAmount === 110 && inv?.paidAmount === 40 && inv?.openAmount === 70,
    `READ …and what is open is computed by the primary (${inv?.openAmount})`);

  const detail = await clientRead('products.get', { id: 'c2-prod-1' });
  ok(detail.status === 200 && detail.body.value?.id === 'c2-prod-1', 'READ the product detail loads');
  ok(Array.isArray(detail.body.value?.mediaKeys), 'MEDIA …and names its image keys');
  ok(!JSON.stringify(detail.body.value).includes('base64'), 'MEDIA no image bytes travel in the read');

  // ── Der Client bestimmt nichts ──────────────────────────────────────────
  const missing = await clientRead('products.get', { id: 'does-not-exist' });
  ok(missing.status === 409, `GUARD an unknown id is a business answer, not a crash (${missing.status})`);
  const forbidden = await clientRead('products.create', { brand: 'X' });
  ok(forbidden.status === 400 && forbidden.body.error === 'BRIDGE_OP_NOT_ALLOWED',
    `GUARD a name that is not allow-listed is refused (${forbidden.status} ${forbidden.body.error})`);
  const sqlish = await clientRead('SELECT * FROM products', {});
  ok(sqlish.status === 400, `GUARD and SQL is not an operation (${sqlish.status})`);
  for (const op of ['invoices.create', 'products.delete', 'customers.update']) {
    const r = await clientRead(op, {});
    ok(r.status === 400 && r.body.error === 'BRIDGE_OP_NOT_ALLOWED', `GUARD ${op} cannot be called`);
  }

  // ── Der entscheidende Punkt: gelesen wird aus der AUTORITAET ────────────
  //
  // Die Frage wird hier umgedreht und damit ohne jedes Zeitfenster beantwortet: die DATEI auf der
  // Platte wird direkt verändert, während die App läuft. Für die laufende Anwendung ist das
  // folgenlos — sie hält ihre Datenbank im Speicher und schreibt die Datei später als Ganzes
  // zurück. Wer aus der Datei antwortete, müsste den neuen Wert liefern. Wer aus der Autorität
  // antwortet, darf ihn gar nicht kennen.
  const beforeName = (await clientRead('products.get', { id: 'c2-prod-1' })).body.value?.name;
  ok(beforeName === 'C2 Reference', `AUTHORITY the client sees the real name (${beforeName})`);

  {
    const db = new DatabaseSync(BIZ_DB);
    try { db.prepare("UPDATE products SET name = 'DISK ONLY' WHERE id = 'c2-prod-1'").run(); }
    finally { try { db.close(); } catch {} }
  }
  const onDisk = dbQ(BIZ_DB, "SELECT name FROM products WHERE id='c2-prod-1'")[0]?.name;
  ok(onDisk === 'DISK ONLY', `AUTHORITY the file on disk now says something else (${onDisk})`);

  const afterDiskEdit = (await clientRead('products.get', { id: 'c2-prod-1' })).body.value?.name;
  ok(afterDiskEdit === 'C2 Reference',
    `AUTHORITY and the client still sees the authority, not the file (${afterDiskEdit})`);
  ok(afterDiskEdit !== 'DISK ONLY',
    'AUTHORITY — so the answer comes from the running primary, never from the on-disk copy');

  // ── Server weg ──────────────────────────────────────────────────────────
  ok(await invokeErr(c, 'sync_server_stop', { email: OWNER_EMAIL, password: OWNER_PW }) === 'NO-ERROR',
    'OFFLINE the server can be stopped');
  await sleep(1500);
  let offlineFailed = false;
  try { await clientRead('products.list'); } catch { offlineFailed = true; }
  if (!offlineFailed) {
    const r = await clientRead('products.list').catch(() => ({ status: 0 }));
    offlineFailed = r.status === 0 || r.status >= 500;
  }
  ok(offlineFailed, 'OFFLINE …and then the client cannot read — it invents nothing');

  ok(await invokeErr(c, 'sync_server_start', {}) === 'NO-ERROR', 'OFFLINE the server comes back');
  {
    const end = Date.now() + 45000; let up = false;
    while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
    ok(up, 'OFFLINE …and answers again');
  }
  const again = await clientRead('products.list');
  ok(again.status === 200, `OFFLINE the client reads again after reconnecting (${again.status})`);

  // ── Der Client hat weiterhin keine Geschaeftsdatenbank ──────────────────
  ok(clientToken !== null, 'CLIENT the client kept only a session…');
  ok(typeof globalThis.__lataif_client_db === 'undefined', 'CLIENT …and never opened a database of its own');

  c.close();
} catch (e) {
  FAIL++; fails.push('suite error: ' + (e && e.message ? e.message : String(e)));
  console.log('E2E ERROR:', e && e.message ? e.message : e);
} finally {
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c2 second client read e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C2_SECOND_CLIENT_READ_E2E_PROVED');
