// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3C — der ECHTE Client legt einen Kunden und einen ARTIKEL MIT FOTO an.
//
// Derselbe Aufbau wie beim Rechnungs-E2E, und aus denselben Gruenden: zwei wirkliche Anwendungen
// auf einer Maschine, zwei Kennungen, echte Klicks.
//
//   • der PRIMARY (`lataif.exe`, `com.lataif.app.e2e`, CDP 9223) — Datenbank, Medienspeicher, LAN;
//   • der CLIENT (`lataif-e2e-client.exe`, `com.lataif.app.e2e.client`, CDP 9224) — leeres
//     Kontrollverzeichnis, keine Datenbank, nie eine.
//
// Der Single-Instance-Riegel der Produktion wird nicht umgangen, sondern nicht getroffen: zwei
// Kennungen sind zwei Anwendungen. Ein Produktionsbinary erzwingt weiterhin eine Instanz.
//
// Was dieses Stueck beweist und kein Node-Test beweisen kann:
//   1. Das Foto geht wirklich ueber HTTP an die neutrale Ablage — und der Primary macht daraus
//      einen Artikel mit einer Galerie, ueber seinen eigenen Medienweg.
//   2. Die Artikelnummer entsteht auf dem Primary. Der Client hat kein Feld dafuer.
//   3. Eine verschluckte Antwort erzeugt keinen zweiten Kunden.
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

const RUN = join(os.tmpdir(), 'lataif-c3c-ui', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const STAGING_DIR = join(APP_DATA_DIR, 'command-staging');
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
const click = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(no screen)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,400);')).replace(/\s+/g, ' '); } catch {}
  throw new Error(`waitFor ${sel} — screen says: ${seen}`);
}

/**
 * Ein ECHTES Foto, in der Oberflaeche selbst erzeugt: die WebView hat einen richtigen
 * JPEG-Kodierer. Eine von Hand gebastelte Bytefolge waere kein Beweis — der Primary prueft mit
 * einem echten Dekodierer, und genau das soll hier durchlaufen.
 */
const attachPhoto = (c, seed) => c.ev(`
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgb(${seed},${(seed * 3) % 255},${(seed * 7) % 255})'; g.fillRect(0, 0, 64, 48);
  g.fillStyle = '#fff'; g.fillText('L' + ${seed}, 8, 24);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
  const input = document.querySelector('[data-client-product-images]');
  if (!input) return 'NO-INPUT';
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'photo-' + ${seed} + '.jpg', { type: 'image/jpeg' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return blob.size;
`);

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

/** Ein Artikel, damit der Client eine Kategorie sieht — mehr braucht das Formular nicht. */
function seedFixture() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
         quantity, images, attributes, source_type, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'Pre-Owned','[]', 100,'BHD', 150,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`)
      .run('seed-watch', branchId, 'cat-watch', 'Zenith', 'Seed Watch', 'SEED-1', now, now);
  } finally { try { db.close(); } catch {} }
}

// ── Der Vermittler ────────────────────────────────────────────────────────
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
    if (parsed?.op) seen.push({ op: parsed.op, commandId: parsed.commandId });
    if (req.url.startsWith('/api/staging/media')) seen.push({ op: 'staging', bytes: body.length });
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
      // Der Primary IST fertig. Der Client erfaehrt es nicht — genau der Fall, fuer den es die
      // Kennung gibt.
      swallowOp = null; swallowed += 1;
      res.writeHead(504, { 'Content-Type': 'application/json', ...CORS });
      res.end(S({ ok: false, error: 'BRIDGE_TIMEOUT' }));
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...CORS });
    res.end(outBody);
  });
});

console.log('CENTRAL-C3C — the real client UI writes a client and an item with a photo\n');
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
  ok(CLIENT_DATA_DIR.includes(CLIENT_IDENT), `INSTANCE and it lives in its own control directory (${CLIENT_DATA_DIR})`);
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
  seedFixture();
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

  const clientFiles = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  ok(!clientFiles.includes('lataif.db'), `DBLESS the running client has no business database (${clientFiles.join(', ') || 'empty'})`);
  ok(!clientFiles.includes('data-location.json'), 'DBLESS …and no data root locator');

  if (await exists(client, 'input[type="password"]')) {
    await setVal(client, 'input[type="email"]', OWNER_EMAIL);
    await setVal(client, 'input[type="password"]', OWNER_PW);
    await click(client, '[data-client-signin]');
  }
  await waitFor(client, '[data-client-mode]', 45000);
  ok(true, 'UI the client signs in against the primary');

  // ── Ein Kunde, echte Klicks ─────────────────────────────────────────────
  await click(client, '[data-client-area="new-customer"]');
  await waitFor(client, '[data-client-customer-form]', 30000);
  await setVal(client, '[data-client-customer-field="firstName"]', 'Remote');
  await setVal(client, '[data-client-customer-field="lastName"]', 'Buyer');
  await setVal(client, '[data-client-customer-field="phone"]', '+973 3333 4444');
  const customersBefore = count('SELECT COUNT(*) c FROM customers');
  await click(client, '[data-client-customer-save]');
  await waitFor(client, '[data-client-customer-done]', 60000);
  await sleep(1200);

  ok(count('SELECT COUNT(*) c FROM customers') === customersBefore + 1, 'CUSTOMER exactly one client more');
  const cust = one("SELECT id, first_name, last_name, phone, branch_id, total_revenue, purchase_count FROM customers WHERE last_name = 'Buyer'");
  ok(!!cust && cust.first_name === 'Remote' && cust.phone === '+973 3333 4444',
    `CUSTOMER …with exactly what was typed (${S(cust)})`);
  ok(Number(cust?.total_revenue ?? -1) === 0 && Number(cust?.purchase_count ?? -1) === 0,
    'CUSTOMER and the totals are the house’s, not the client’s');
  ok(!!cust?.branch_id, 'CUSTOMER the branch comes from the session');
  ok(count('SELECT COUNT(*) c FROM remote_command_ledger') >= 1, 'CUSTOMER the durable record exists');

  // ── Aendern: nur der Unterschied, und eine verschluckte Antwort ─────────
  await click(client, '[data-client-area="customers"]');
  await waitFor(client, '[data-client-list]', 30000);
  await click(client, `[data-client-row="${cust.id}"]`);
  await waitFor(client, '[data-client-edit-customer]', 30000);
  await click(client, '[data-client-edit-customer]');
  await waitFor(client, '[data-client-customer-form]', 30000);
  await setVal(client, '[data-client-customer-field="company"]', 'Remote Co');
  const sentBefore = seen.filter((s) => s.op === 'customers.update').length;
  swallowOp = 'customers.update';
  await click(client, '[data-client-customer-save]');
  await waitFor(client, '[data-client-customer-pending]', 60000);
  ok(swallowed === 1, 'UNKNOWN the answer was swallowed after the primary had committed');
  await sleep(1200);
  ok(String(one('SELECT company c FROM customers WHERE id = ?', [cust.id])?.c) === 'Remote Co',
    'UNKNOWN the change DID happen on the primary…');
  ok(String(await text(client, '[data-client-customer-pending]')).includes('not known'),
    'UNKNOWN …and the client says the outcome is not known');

  await click(client, '[data-client-customer-save]');
  await waitFor(client, '[data-client-customer-done]', 60000);
  const updates = seen.filter((s) => s.op === 'customers.update');
  ok(updates.length === sentBefore + 2, `UNKNOWN two requests were sent (${updates.length - sentBefore})`);
  ok(updates[sentBefore].commandId === updates[sentBefore + 1].commandId,
    'UNKNOWN …with the SAME command id');
  await sleep(1000);
  ok(count('SELECT COUNT(*) c FROM customers') === customersBefore + 1, 'UNKNOWN still exactly one client');
  ok(String(one('SELECT first_name c FROM customers WHERE id = ?', [cust.id])?.c) === 'Remote',
    'UNKNOWN and the fields nobody touched are untouched');

  // ── Ein ARTIKEL mit Foto ────────────────────────────────────────────────
  await click(client, '[data-client-area="new-product"]');
  await waitFor(client, '[data-client-product-form]', 30000);
  ok(!(await exists(client, '[data-client-product-field="sku"]')),
    'SKU the client form has no field for the item number at all');
  await setVal(client, '[data-client-product-field="brand"]', 'Omega');
  await setVal(client, '[data-client-product-field="name"]', 'Seamaster');
  await setVal(client, '[data-client-product-field="purchasePrice"]', '400');
  await setVal(client, '[data-client-product-field="plannedSalePrice"]', '650');

  const photoSize = await attachPhoto(client, 40);
  ok(Number(photoSize) > 100, `MEDIA the client encoded a real photo (${photoSize} bytes)`);
  await waitFor(client, '[data-client-product-staged] li', 45000);
  const stagedLabel = await text(client, '[data-client-product-staged] li');
  ok(/64.?48/.test(String(stagedLabel).replace(/\s/g, '')) || /photo-40/.test(String(stagedLabel)),
    `MEDIA the primary accepted it and answered with its own facts (${stagedLabel})`);
  ok(seen.some((s) => s.op === 'staging'), 'MEDIA the bytes went to the neutral shelf, not to a command');
  const stagedFiles = existsSync(STAGING_DIR) ? readdirSync(STAGING_DIR) : [];
  ok(stagedFiles.length === 1 && /^[0-9a-f]{64}\.bin$/.test(stagedFiles[0]),
    `MEDIA and it lies there under its own content hash (${stagedFiles.join(', ') || 'empty'})`);

  const productsBefore = count('SELECT COUNT(*) c FROM products');
  await click(client, '[data-client-product-save]');
  await waitFor(client, '[data-client-product-done]', 90000);
  await sleep(1500);

  const shownSku = await text(client, '[data-client-product-sku]');
  ok(count('SELECT COUNT(*) c FROM products') === productsBefore + 1, 'PRODUCT exactly one item more');
  const prod = one("SELECT id, sku, brand, name, images, branch_id, purchase_price FROM products WHERE name = 'Seamaster'");
  ok(!!prod, 'PRODUCT …and it is the one that was typed');
  ok(String(prod?.sku) === String(shownSku) && String(shownSku).length > 0,
    `SKU the number on the screen is the number in the database (${shownSku})`);
  ok(String(prod?.sku) !== 'SEED-1', 'SKU …and it is a NEW one, not the seed');
  ok(String(prod?.images) === '[]', 'MEDIA the product row carries no image bytes');
  ok(count('SELECT COUNT(*) c FROM media_links WHERE entity_id = ? AND deleted_at IS NULL', [prod?.id]) === 1,
    'MEDIA the photo hangs in the gallery, through the primary’s own media path');
  const afterStaging = existsSync(STAGING_DIR) ? readdirSync(STAGING_DIR).filter((f) => f.endsWith('.bin')) : [];
  ok(afterStaging.length === 0, `MEDIA and the shelf was cleared afterwards (${afterStaging.join(', ') || 'empty'})`);
  ok(count('SELECT COUNT(*) c FROM remote_command_ledger') >= 2, 'PRODUCT the durable record exists');

  // ── Denselben Artikel ändern ────────────────────────────────────────────
  await click(client, '[data-client-area="products"]');
  await waitFor(client, '[data-client-list]', 30000);
  await click(client, `[data-client-row="${prod.id}"]`);
  await waitFor(client, '[data-client-edit-product]', 30000);
  await click(client, '[data-client-edit-product]');
  await waitFor(client, '[data-client-product-form]', 30000);
  await setVal(client, '[data-client-product-field="name"]', 'Seamaster 300');
  await click(client, '[data-client-product-save]');
  await waitFor(client, '[data-client-product-done]', 60000);
  await sleep(1200);
  const edited = one('SELECT sku, name, purchase_price FROM products WHERE id = ?', [prod.id]);
  ok(String(edited?.name) === 'Seamaster 300', 'EDIT the name changed');
  ok(String(edited?.sku) === String(prod.sku), 'EDIT …and the number did not');
  ok(Number(edited?.purchase_price) === Number(prod.purchase_price), 'EDIT nor did the price nobody touched');
  ok(count('SELECT COUNT(*) c FROM products') === productsBefore + 1, 'EDIT and there is still one item');
  ok(count('SELECT COUNT(*) c FROM media_links WHERE entity_id = ? AND deleted_at IS NULL', [prod?.id]) === 1,
    'EDIT the gallery is untouched — the client never edits photos');

  // ── Der Client hat immer noch nichts angelegt ───────────────────────────
  const after = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  ok(!after.includes('lataif.db') && !after.includes('lataif_sync_server.db') && !after.includes('data-location.json'),
    `DBLESS after a client, an item and two edits the client still owns nothing (${after.join(', ') || 'empty'})`);
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

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c3c client masterdata ui: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3C_CLIENT_UI_CUSTOMER_PROVED');
console.log('CENTRAL_C3C_CLIENT_UI_PRODUCT_WITH_PHOTO_PROVED');
console.log('CENTRAL_C3C_CLIENT_UI_SKU_IS_PRIMARY_PROVED');
