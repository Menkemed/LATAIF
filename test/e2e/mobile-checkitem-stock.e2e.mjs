// MOBILE-I1D — REAL runtime E2E for Check Item search, the gallery media route and cross-surface
// stock checking, against the isolated e2e app with a real business database.
//
// What makes this a proof rather than a re-run of the unit tests: the product is seeded as a
// GALLERY-ONLY item (`products.images = '[]'` plus a real link → object → blob → generation → file
// on disk), which is exactly the shape the v0.8.37 media migration left behind and exactly the
// shape that broke the QR path in production. Every assertion below goes over the wire to the
// running server, or through the app's own Tauri bridge, never against a fixture in memory.
//
// Isolation: the e2e identifier + AppData, an ISOLATED sync port (LATAIF_E2E_SYNC_PORT), the
// runtime identity guard before the process is spawned, and a production-untouched check at the end.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223;
const PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';
const TENANT = 'tenant-1';

const RUN = join(os.tmpdir(), 'lataif-checkitem-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
const PROD_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');
const PROD_BIZ = join(REAL_APPDATA, 'com.lataif.app', 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  \u2717 ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();

// ── minimal CDP client ──────────────────────────────────────────────────────
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
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  close() { try { this.ws.close(); } catch {} }
}

let appProc;
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  return page.webSocketDebuggerUrl;
}
function killApp() { try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
function killAllApp() {
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {}
}
async function waitHealthy() { const end = Date.now() + 40000; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); } throw new Error('server never healthy on ' + PORT); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
async function invoke(c, cmd, args) { return c.ev(`return (async()=>{ try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; } })();`); }
const setValApp = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const existsApp = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
async function waitApp(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsApp(c, sel)) return true; await sleep(300); } throw new Error('waitApp ' + sel); }
async function frontendLogin(c) {
  await waitApp(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 60000);
  if (await existsApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setValApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setValApp(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitApp(c, 'input[placeholder="Full name"]');
    await setValApp(c, 'input[placeholder="Full name"]', 'E2E Admin');
    await setValApp(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setValApp(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitApp(c, 'input[placeholder="10"]');
    await setValApp(c, 'input[placeholder="10"]', '10');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click();`);
  } else {
    await setValApp(c, 'input[type="email"]', OWNER_EMAIL);
    await setValApp(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click();`);
  }
  await waitApp(c, 'a[href="/settings"], nav a, [data-testid]', 45000);
}

// ── fixture: a GALLERY-ONLY product, exactly the post-migration shape ────────
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

const PRODUCT_ID = 'p-e2e-dj41';
const SKU = 'RLX-DJ41-E2E';
const SERIAL = '785757575';
const REFERENCE = '126333';
const MODEL_NO = 'MOD-1267';

function seedBusinessDb() {
  const hash = createHash('sha256').update(JPEG).digest('hex');
  const key = `${TENANT}/${hash.slice(0, 2)}/${hash}.jpg`;
  const file = join(MEDIA_ROOT, TENANT, hash.slice(0, 2), `${hash}.jpg`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JPEG);

  const db = new DatabaseSync(BIZ_DB);
  const branchId = db.prepare(`SELECT id FROM branches LIMIT 1`).get()?.id;
  if (!branchId) throw new Error('no branch in the seeded business DB');
  const now = '2026-08-12T09:00:00.000Z';
  const attrs = JSON.stringify({
    serial_number: SERIAL, reference_number: REFERENCE, model_number: MODEL_NO,
    dial: 'Slate Roman', material: 'Two-Tone Steel/Gold', description: 'Embroidered presentation box',
  });
  db.exec('BEGIN');
  db.prepare(
    `INSERT OR REPLACE INTO products (id, branch_id, category_id, brand, name, sku, condition,
       storage_location, purchase_price, planned_sale_price, min_sale_price, stock_status,
       images, attributes, quantity, notes, created_at, updated_at, version, sync_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(PRODUCT_ID, branchId, 'cat-watch', 'Rolex', 'Datejust 41 Wimbledon', SKU, 'Pre-Owned',
        'Safe A', 9000, 12000, 10000, 'in_stock', '[]', attrs, 3, 'top drawer', now, now, 1, 'synced');
  // A second product so "multiple results" and "no result" mean something.
  db.prepare(
    `INSERT OR REPLACE INTO products (id, branch_id, category_id, brand, name, sku, condition,
       storage_location, purchase_price, planned_sale_price, min_sale_price, stock_status,
       images, attributes, quantity, notes, created_at, updated_at, version, sync_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('p-e2e-sub', branchId, 'cat-watch', 'Rolex', 'Submariner Date', 'RLX-SUB-E2E', 'Pre-Owned',
        'Safe B', 5000, 7000, 6000, 'in_stock', '[]', JSON.stringify({ dial: 'Black' }), 1, null, now, now, 1, 'synced');

  const linkCols = db.prepare(`SELECT COUNT(*) c FROM pragma_table_info('media_links')`).get().c;
  if (!linkCols) throw new Error('media tables missing from the business DB');
  db.prepare(`INSERT OR REPLACE INTO media_blobs (tenant_id, blob_id, dedup_token, current_generation_no, blob_status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?)`).run(TENANT, 'blob-e2e', hash, 1, 'present', now, now);
  db.prepare(`INSERT OR REPLACE INTO media_blob_generations (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash,
                byte_size, content_kind, mime_type, extension, gen_status, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(TENANT, 'blob-e2e', 1, key, hash, JPEG.length, 'raster_image', 'image/jpeg', 'jpg', 'available', now);
  db.prepare(`INSERT OR REPLACE INTO media_objects (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind,
                source_type, ingest_status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(TENANT, 'media-e2e', branchId, 'blob-e2e', 'normalized', 'upload_desktop', 'ready', now, now);
  db.prepare(`INSERT OR REPLACE INTO media_links (tenant_id, link_id, scope_kind, branch_id, entity_type, entity_id,
                media_id, media_role, sort_order, is_primary, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(TENANT, 'link-e2e', 'branch', branchId, 'product', PRODUCT_ID, 'media-e2e', 'stock_image', 0, 1, now);
  db.exec('COMMIT');
  db.close();
  return { key, hash, file, branchId };
}

function productSnapshot() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('products')`).all().map((r) => r.name);
    const row = db.prepare(`SELECT * FROM products WHERE id = ?`).get(PRODUCT_ID);
    return cols.map((c) => `${c}=${row?.[c] ?? '\u2205'}`).join('|');
  } finally { try { db.close(); } catch {} }
}
function stockCheckRows() {
  const db = new DatabaseSync(SERVER_DB);
  try { return db.prepare(`SELECT check_id, status, notes, checked_at, source, checked_by_name FROM stock_checks WHERE product_id=? ORDER BY checked_at DESC, check_id DESC`).all(); }
  catch { return []; } finally { try { db.close(); } catch {} }
}

async function api(path, opts = {}, token) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { ...opts, headers });
  let body = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) { try { body = await res.json(); } catch {} }
  else { try { body = Buffer.from(await res.arrayBuffer()); } catch {} }
  return { status: res.status, body, contentType: ct };
}

async function main() {
  killAllApp(); await sleep(800);
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(WV2_DIR, { recursive: true, force: true });
  const prodSrvBefore = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;
  const prodBizBefore = existsSync(PROD_BIZ) ? statSync(PROD_BIZ).mtimeMs : 0;

  // The embedded server only starts once this install is a provisioned Primary; seeding it is what
  // the other real-app suites do, and it keeps the owner secret out of the UI entirely.
  mkdirSync(APP_DATA_DIR, { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'isolated server seeded as Primary');

  // ── boot once so the app creates its own real business database ───────────
  let ws = await startApp();
  let app = new CDP(ws);
  await app.send('Runtime.enable'); await app.send('DOM.enable');
  await waitInvoke(app); await waitHealthy();
  ok(true, 'embedded server healthy on isolated port ' + PORT);
  await sleep(6000);   // let the renderer create and durably save its business database
  app.close(); killApp(); await sleep(2500);

  ok(existsSync(BIZ_DB), 'the isolated app created its own business database');
  const fixture = seedBusinessDb();
  ok(existsSync(fixture.file), 'gallery blob written to the isolated media root');

  // ── restart against the seeded data ───────────────────────────────────────
  ws = await startApp();
  app = new CDP(ws);
  await app.send('Runtime.enable'); await app.send('DOM.enable');
  await waitInvoke(app); await waitHealthy();

  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) });
  ok(login.status === 200 && !!login.body?.token, 'mobile login against the isolated server');
  const token = login.body?.token;

  const snapBefore = productSnapshot();

  // ══ §2 — QR lookup returns the FULL product incl. the gallery image ═══════
  const scanned = await api(`/api/products/by-sku/${encodeURIComponent(SKU)}`, {}, token);
  ok(scanned.status === 200, 'QR lookup by SKU succeeds');
  const p = scanned.body || {};
  ok(p.images === '[]', 'the fixture really is gallery-only (products.images is empty)');
  ok(!!p.image_key, 'a gallery-only product still resolves an image_key (the v0.8.37 regression)');
  ok(p.brand === 'Rolex' && p.name === 'Datejust 41 Wimbledon', 'brand and name come through');
  ok(p.sku === SKU, 'SKU comes through');
  ok(p.category_name === 'Watches' || !!p.category_id, 'category resolves');
  ok(String(p.quantity) === '3', 'quantity comes through');
  const attrs = JSON.parse(p.attributes || '{}');
  ok(attrs.serial_number === SERIAL && attrs.reference_number === REFERENCE, 'serial and reference come through');
  ok(attrs.dial === 'Slate Roman', 'category attributes come through');

  const img = await api(`/api/media?key=${encodeURIComponent(p.image_key)}`, {}, token);
  ok(img.status === 200, 'the gallery image is served');
  ok(Buffer.isBuffer(img.body) && img.body.length === JPEG.length, 'the served bytes are the stored blob');
  ok(createHash('sha256').update(img.body).digest('hex') === fixture.hash, 'served bytes hash to the stored blob hash');
  ok(/image\/jpeg/.test(img.contentType), 'served with an image content type');

  // ══ §3 — /api/media security ══════════════════════════════════════════════
  const unauth = await fetch(`${BASE}/api/media?key=${encodeURIComponent(fixture.key)}`);
  ok(unauth.status === 401 || unauth.status === 403, `unauthenticated media request is refused (${unauth.status})`);
  const badToken = await api(`/api/media?key=${encodeURIComponent(fixture.key)}`, {}, 'not-a-real-token');
  ok(badToken.status === 401 || badToken.status === 403, `an invalid token is refused (${badToken.status})`);

  for (const [label, key] of [
    ['plain traversal', '../../../../Windows/win.ini'],
    ['scoped traversal', `${TENANT}/../../lataif.db`],
    ['deep traversal', `${TENANT}/53/../../../../openai.key`],
    ['encoded traversal', `${TENANT}%2F..%2F..%2Flataif.db`],
    ['absolute path', 'C:/Windows/win.ini'],
    ['unc path', '//server/share/x.jpg'],
    ['unknown key', `${TENANT}/aa/${'b'.repeat(64)}.jpg`],
    ['wrong extension', `${TENANT}/${fixture.hash.slice(0, 2)}/${fixture.hash}.exe`],
    ['empty key', ''],
  ]) {
    const r = await api(`/api/media?key=${encodeURIComponent(key)}`, {}, token);
    ok(r.status >= 400, `${label} is refused (${r.status})`);
    ok(!(Buffer.isBuffer(r.body) && r.body.length > 512), `${label} leaks no file bytes`);
  }
  // A key the DB knows but whose file is gone must 404, not serve something else.
  const gone = `${TENANT}/cc/${'c'.repeat(64)}.jpg`;
  {
    const db = new DatabaseSync(BIZ_DB);
    db.prepare(`INSERT OR REPLACE INTO media_blob_generations (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash, byte_size, content_kind, mime_type, extension, gen_status, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(TENANT, 'blob-missing', 1, gone, 'c'.repeat(64), 10, 'raster_image', 'image/jpeg', 'jpg', 'available', '2026-08-12T09:00:00.000Z');
    db.close();
  }
  const missing = await api(`/api/media?key=${encodeURIComponent(gone)}`, {}, token);
  ok(missing.status === 404, `a known key whose file is missing answers 404 (${missing.status})`);

  // ══ §4 — Smart Search over the real server ════════════════════════════════
  const search = async (q) => (await api(`/api/products/search?q=${encodeURIComponent(q)}&limit=20`, {}, token)).body || {};
  const idsOf = (r) => (r.results || []).map((x) => x.id);

  ok(idsOf(await search(SKU))[0] === PRODUCT_ID, 'exact SKU ranks first');
  ok(idsOf(await search('DJ41')).includes(PRODUCT_ID), 'partial SKU finds the item');
  ok(idsOf(await search(SERIAL))[0] === PRODUCT_ID, 'exact serial ranks first');
  ok(idsOf(await search('7857')).includes(PRODUCT_ID), 'partial serial finds the item');
  ok(idsOf(await search(REFERENCE)).includes(PRODUCT_ID), 'reference finds the item');
  ok(idsOf(await search(MODEL_NO)).includes(PRODUCT_ID), 'model number finds the item');
  ok(idsOf(await search('Embroidered')).includes(PRODUCT_ID), 'description finds the item');
  ok(idsOf(await search('Wimbledon')).includes(PRODUCT_ID), 'name finds the item');
  ok(idsOf(await search('rlx-dj41-e2e')).includes(PRODUCT_ID), 'search is case-insensitive');
  ok(idsOf(await search('rolex')).length >= 2, 'a brand match returns multiple hits');
  ok(idsOf(await search('Patek Philippe')).length === 0, 'a term nothing matches returns nothing');
  ok(idsOf(await search('%')).length === 0, 'a bare wildcard matches nothing');

  // §4 — the hit a user would pick renders through the SAME product JSON as the scan.
  const hit = (await search(SKU)).results[0];
  ok(JSON.stringify(hit) === JSON.stringify(scanned.body), 'a search hit is byte-identical to the scanned product');
  ok(hit.image_key === p.image_key, 'the search hit carries the same gallery image');
  const byId = await api(`/api/products/by-id/${encodeURIComponent(PRODUCT_ID)}`, {}, token);
  ok(JSON.stringify(byId.body) === JSON.stringify(scanned.body), 'reopening by id yields the same product JSON');

  // ══ §5 — Mobile stock check → visible on the desktop ══════════════════════
  const mobileCheck = await api('/api/stock-checks', {
    method: 'POST',
    body: JSON.stringify({ product_id: PRODUCT_ID, status: 'not_available', notes: 'Could not find', request_id: 'req-e2e-1' }),
  }, token);
  ok(mobileCheck.status === 200 && !!mobileCheck.body?.check, 'mobile records a stock check');
  const mobileId = mobileCheck.body?.check?.check_id;
  ok(mobileCheck.body?.check?.source === 'mobile', 'the check is attributed to the mobile surface');

  // §16 — the same request id is the same observation, not a second one.
  const retry = await api('/api/stock-checks', {
    method: 'POST',
    body: JSON.stringify({ product_id: PRODUCT_ID, status: 'available', notes: 'different', request_id: 'req-e2e-1' }),
  }, token);
  ok(retry.body?.check?.check_id === mobileId, 'a retry of the same request returns the first check');
  ok(retry.body?.check?.status === 'not_available', 'a retry never rewrites the recorded verdict');
  ok(stockCheckRows().length === 1, 'a retry created no second row');

  const desktopSees = await invoke(app, 'list_stock_checks', { productId: PRODUCT_ID, limit: 20 });
  ok(desktopSees.ok && Array.isArray(desktopSees.value), 'the desktop can read the history');
  const d0 = desktopSees.value?.[0];
  ok(d0?.check_id === mobileId, 'the desktop sees the SAME check the phone wrote');
  ok(d0?.status === 'not_available', 'status matches on the desktop');
  ok(d0?.notes === 'Could not find', 'note matches on the desktop');
  ok(d0?.checked_at === mobileCheck.body.check.checked_at, 'timestamp matches on the desktop');
  ok(d0?.source === 'mobile', 'the desktop can tell which surface recorded it');

  // ══ §6 — Desktop stock check → visible on mobile ══════════════════════════
  const desktopCheck = await invoke(app, 'create_stock_check', {
    productId: PRODUCT_ID, status: 'available', notes: 'Found in safe', userId: null, requestId: 'req-e2e-desktop-1',
  });
  ok(desktopCheck.ok, 'the desktop records a stock check: ' + (desktopCheck.error || ''));
  ok(desktopCheck.value?.source === 'desktop', 'the desktop check is attributed to the desktop');

  const mobileAfter = await api(`/api/stock-checks?product_id=${encodeURIComponent(PRODUCT_ID)}&limit=20`, {}, token);
  const checks = mobileAfter.body?.checks || [];
  ok(mobileAfter.body?.latest?.status === 'available', 'mobile sees the desktop verdict as latest');
  ok(mobileAfter.body?.latest?.notes === 'Found in safe', 'mobile sees the desktop note');
  ok(checks.length === 2, 'mobile sees BOTH observations');
  ok(checks.some((c) => c.check_id === mobileId && c.status === 'not_available'),
    'the earlier not-available check is still in the history');
  ok(checks[0].source === 'desktop' && checks[1].source === 'mobile', 'history is ordered newest first across surfaces');

  // a deliberate new check with a new id is a new row
  const third = await api('/api/stock-checks', {
    method: 'POST', body: JSON.stringify({ product_id: PRODUCT_ID, status: 'available', notes: 'second pass', request_id: 'req-e2e-2' }),
  }, token);
  ok(third.status === 200 && stockCheckRows().length === 3, 'a deliberate new check adds a row');

  // ══ §7 — no inventory mutation ════════════════════════════════════════════
  const snapAfter = productSnapshot();
  ok(snapAfter === snapBefore, 'every product column is unchanged after mobile AND desktop checks');
  const dbq = new DatabaseSync(BIZ_DB);
  const qty = dbq.prepare(`SELECT quantity, stock_status, purchase_price, planned_sale_price, sku, attributes, images FROM products WHERE id=?`).get(PRODUCT_ID);
  dbq.close();
  ok(Number(qty.quantity) === 3, 'quantity is still 3');
  ok(qty.stock_status === 'in_stock', 'stock status unchanged');
  ok(Number(qty.purchase_price) === 9000 && Number(qty.planned_sale_price) === 12000, 'prices unchanged');
  ok(qty.sku === SKU, 'SKU unchanged');
  ok(JSON.parse(qty.attributes).serial_number === SERIAL, 'attributes unchanged');
  ok(qty.images === '[]', 'media state unchanged');
  ok(existsSync(fixture.file), 'the media file is still on disk');

  // ══ §8 — the AI route refuses hostile input BEFORE any upstream call ══════
  for (const [label, body, expect] of [
    ['no image', { category_id: 'cat-watch', image: '' }, 'AI_IMAGE_REQUIRED'],
    ['a remote URL', { category_id: 'cat-watch', image: 'https://evil.example/x.jpg' }, 'AI_IMAGE_UNSUPPORTED_TYPE'],
    ['a local path', { category_id: 'cat-watch', image: 'file:///C:/Windows/win.ini' }, 'AI_IMAGE_UNSUPPORTED_TYPE'],
    ['an svg', { category_id: 'cat-watch', image: 'data:image/svg+xml;base64,PHN2Zy8+' }, 'AI_IMAGE_UNSUPPORTED_TYPE'],
    ['an unknown category', { category_id: 'cat-nonsense', image: 'data:image/jpeg;base64,' + JPEG.toString('base64') }, 'AI_UNKNOWN_CATEGORY'],
  ]) {
    const r = await api('/api/ai/identify', { method: 'POST', body: JSON.stringify(body) }, token);
    ok(r.status >= 400 && r.body?.error === expect, `${label} is refused with ${expect} (got ${r.status} ${r.body?.error})`);
    const raw = JSON.stringify(r.body || {});
    ok(!/sk-|openai|Bearer/i.test(raw), `${label} leaks nothing about the key`);
  }
  const unauthAi = await fetch(`${BASE}/api/ai/identify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(unauthAi.status === 401 || unauthAi.status === 403, `unauthenticated AI request is refused (${unauthAi.status})`);
  const malformed = await api('/api/ai/identify', { method: 'POST', body: '{not json' }, token);
  ok(malformed.status === 400, `malformed JSON is refused (${malformed.status})`);
  // With no key configured in the isolated install, a VALID request must fail closed at 503 and
  // still say nothing about the key.
  const noKey = await api('/api/ai/identify', {
    method: 'POST', body: JSON.stringify({ category_id: 'cat-watch', image: 'data:image/jpeg;base64,' + JPEG.toString('base64') }),
  }, token);
  ok(noKey.status === 503 && noKey.body?.error === 'AI_NOT_CONFIGURED',
    `an unconfigured key fails closed (${noKey.status} ${noKey.body?.error})`);

  // ══ durability: a restart keeps every check ══════════════════════════════
  app.close(); killApp(); await sleep(2000);
  ws = await startApp(); app = new CDP(ws);
  await app.send('Runtime.enable'); await waitInvoke(app); await waitHealthy();
  const afterRestart = await invoke(app, 'list_stock_checks', { productId: PRODUCT_ID, limit: 20 });
  ok(afterRestart.value?.length === 3, 'all three checks survive a real restart');
  ok(afterRestart.value?.[0]?.notes === 'second pass', 'the latest check survives a restart');
  app.close();

  // ══ §9 — production untouched ════════════════════════════════════════════
  ok((existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0) === prodSrvBefore, 'production server DB untouched');
  ok((existsSync(PROD_BIZ) ? statSync(PROD_BIZ).mtimeMs : 0) === prodBizBefore, 'production business DB untouched');

  console.log(`\nMOBILE-I1D check-item/stock e2e: ${PASS} passed, ${FAIL} failed`);
}

main().catch((e) => { console.error('E2E ERROR:', e?.stack || e?.message || e); FAIL++; }).finally(() => {
  try { killAllApp(); } catch {}
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
  if (fails.length) { console.log('\nfailures:'); for (const f of fails) console.log('  - ' + f); }
  process.exit(FAIL > 0 ? 1 : 0);
});
