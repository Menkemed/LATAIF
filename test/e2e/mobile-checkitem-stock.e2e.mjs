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
import { join, dirname, sep } from 'node:path';
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
const MOCK_PORT = 3013;
const EDGE_CDP = 9226;
const EDGE_PROFILE = join(RUN, 'edge-profile');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
// MOBILE-I1F - the upstream override exists ONLY in the e2e build (cfg(feature="e2e")); a production
// binary compiles the branch out entirely, so this variable is inert there. It is read from THIS
// process's environment, never from a request.
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT),
  LATAIF_E2E_AI_UPSTREAM: 'http://127.0.0.1:' + MOCK_PORT + '/v1/chat/completions',
  TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();

// ── minimal CDP client ──────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method) { for (const h of this.handlers) h(m); }
    });
  }
  on(fn) { this.handlers.push(fn); }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  close() { try { this.ws.close(); } catch {} }
}


// == MOBILE-I1F - deterministic upstream mock =================================
//
// This stands in for OpenAI and NOTHING else. The request still travels the whole real path:
// browser -> /api/ai/identify -> the real Rust handler -> the shared contract -> the real HTTP
// client -> here -> the real response parser and allow-list filter -> the real form merge. Only the
// model is fake, and it is deliberately hostile: it answers with prices, a quantity, an id and
// unknown keys alongside the legitimate fields, so the allow-list has something to actually strip.
let mockMode = 'success';
const mockRequests = [];
let mockServer;
const MOCK_ANSWER = {
  brand: 'Rolex', name: "Datejust 41 'Wimbledon'", condition: 'Pre-Owned',
  description: 'Slate dial with Roman numerals', storageLocation: 'Safe A',
  notes: 'DD trail: chose 126334.', scopeOfDelivery: ['Box', 'Papers'],
  estimatedValue: 4200, purchasePriceEstimate: 3100, minSalePrice: 3900, maxSalePrice: 4600,
  purchasePrice: 3100, plannedSalePrice: 4200, quantity: 7, sku: 'RLX-AI-FAKE', taxScheme: 'MARGIN',
  id: 'some-other-product', stockStatus: 'sold', syncStatus: 'pending',
  attributes: {
    reference_number: '126334', dial: 'Slate Roman', material: 'Two-Tone Steel/Gold',
    quantity: 7, purchase_price: 3100, not_a_real_key: 'nonsense',
  },
};
async function startMock() {
  const http = await import('node:http');
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      mockRequests.push({ url: req.url, auth: req.headers.authorization || '', body });
      if (mockMode === 'timeout') return;                     // never answers -> client timeout
      if (mockMode === 'error') { res.writeHead(500); return res.end('{"error":"upstream boom"}'); }
      if (mockMode === 'malformed') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: 'I think it is a watch.' } }] }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(MOCK_ANSWER) + '\n```' } }] }));
    });
  });
  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
}
function stopMock() { try { mockServer && mockServer.close(); } catch (e) {} }

// A placeholder so the route gets past "not configured". It is not an OpenAI key and never reaches
// a real endpoint - the upstream is the local mock. Written the way the desktop client writes it.
function writeFakeKey() {
  const SEED_OBF = Buffer.from('lataif-2026-key-obf');
  const plain = Buffer.from('e2e-placeholder-not-a-real-key');
  const obf = Buffer.from(plain.map((b, i) => b ^ SEED_OBF[i % SEED_OBF.length]));
  writeFileSync(join(APP_DATA_DIR, 'openai.key'), obf.toString('base64'));
}

// == real browser (Edge) helpers =============================================
let edgeProc;
async function startEdge(url) {
  edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + EDGE_PROFILE, '--remote-debugging-port=' + EDGE_CDP, 'about:blank'], { stdio: 'ignore' });
  const end = Date.now() + 40000; let ws = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + EDGE_CDP + '/json/list')).json();
      const pg = l.find((t) => t.type === 'page');
      if (pg) { ws = pg.webSocketDebuggerUrl; break; }
    } catch (e) {}
    await sleep(300);
  }
  if (!ws) throw new Error('edge CDP did not come up');
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('Network.enable');
  const uploads = []; const responses = [];
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (r && /\/api\/mobile\/upload$/.test(r.url) && r.method === 'POST' && r.postData) {
        try { uploads.push(JSON.parse(r.postData)); } catch (e) {}
      }
    } else if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r && /\/api\/mobile\/upload$/.test(r.url)) responses.push(r.status);
    }
  });
  await c.send('Page.navigate', { url });
  await sleep(2500);
  return { c, uploads, responses };
}
function killEdge() {
  try { execFileSync('taskkill', ['/F', '/PID', String(edgeProc.pid), '/T'], { stdio: 'ignore' }); } catch (e) {}
}
const existsE = (c, sel) => c.ev('return !!document.querySelector(' + S(sel) + ');');
const visibleE = (c, sel) => c.ev('const e=document.querySelector(' + S(sel) + '); if(!e||e.classList.contains("hidden")) return false; const r=e.getBoundingClientRect(); return (e.offsetParent!==null) || r.height>0 || r.width>0;');
async function waitE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsE(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitUnhidden(c, sel, t = 20000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    const r = await c.ev('const e=document.querySelector(' + S(sel) + '); return !!e && !e.classList.contains("hidden");');
    if (r) return true;
    await sleep(200);
  }
  throw new Error('waitUnhidden ' + sel);
}
async function waitVisE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await visibleE(c, sel)) return true; await sleep(200); } throw new Error('waitVisE ' + sel); }
const setValE = (c, sel, v) => c.ev('const e=document.querySelector(' + S(sel) + '); if(!e) return "NO"; const p=e.tagName==="SELECT"?HTMLSelectElement.prototype:(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,"value").set.call(e, ' + S(v) + '); e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return "OK";');
const clickE = (c, sel) => c.ev('const e=document.querySelector(' + S(sel) + '); if(!e) return "NO"; e.click(); return "OK";');
const valE = (c, sel) => c.ev('const e=document.querySelector(' + S(sel) + '); return e ? e.value : null;');
const textE = (c, sel) => c.ev('const e=document.querySelector(' + S(sel) + '); return e ? e.textContent : null;');
async function setFile(c, sel, path) {
  const r = await c.send('Runtime.evaluate', { expression: 'document.querySelector(' + S(sel) + ')', returnByValue: false });
  await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [path] });
}
async function mobileLogin(c) {
  await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW);
  await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker');
  // The page stores its token as part of the login handler; a request issued before that lands is
  // answered 401. Wait for the token rather than racing it.
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const t = await c.ev('return localStorage.getItem("lataif_mobile_token");');
    if (t && t.length > 20) return;
    await sleep(200);
  }
  throw new Error('mobile login produced no token');
}
// MOBILE-I1H - the AI button is derived from the photo state, not polled, so it is already correct
// when the capture handler returns. No sleep and no poll-cycle tolerance: read it directly.
const aiBtnHidden = (c) => c.ev('const b=document.querySelector("#cAiBtn"); return b ? b.classList.contains("hidden") : null;');

// Type into the REAL search box and let the page's own debounce run the search.
async function uiSearch(c, term, expect) {
  // Clear first so a stale list can never be mistaken for this term's answer, then poll until the
  // page's own debounce has run and rendered - a fixed sleep made this flaky on a loaded machine.
  await c.ev('const b=document.querySelector("#searchResults"); if(b) b.innerHTML=""; return "OK";');
  await setValE(c, '#searchInput', term);
  const read = () => c.ev('const b=document.querySelector("#searchResults"); if(!b) return -1; if(b.querySelectorAll("[data-hit]").length) return b.querySelectorAll("[data-hit]").length; if (/No matching item/i.test(b.innerText||"")) return 0; if (/Search failed|Search unavailable/i.test(b.innerText||"")) return -3; return -1;');
  const end = Date.now() + 15000;
  let n = -1;
  while (Date.now() < end) {
    n = await read();
    if (n >= 0 && (expect === undefined || n === expect || (typeof expect === 'object' && n >= expect.min))) break;
    if (n === -3) { await setValE(c, '#searchInput', ''); await sleep(200); await setValE(c, '#searchInput', term); }
    await sleep(250);
  }
  return n;
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
async function waitPortFree(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-NetTCPConnection -State Listen -LocalPort ' + port + ' -EA SilentlyContinue).Count'], { encoding: 'utf8' }).trim() || '0', 10); } catch (e) { n = 0; }
    if (!n) return true;
    await sleep(500);
  }
  return false;
}
async function waitHealthy() { const end = Date.now() + 40000; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); } throw new Error('server never healthy on ' + PORT); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
async function invoke(c, cmd, args) { return c.ev(`return (async()=>{ try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; } })();`); }
const setValApp = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const existsApp = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
async function waitApp(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsApp(c, sel)) return true; await sleep(300); } throw new Error('waitApp ' + sel); }
async function frontendLogin(c, pw) {
  const PW = pw || ONBOARD_PW;
  await waitApp(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 60000);
  if (await existsApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setValApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setValApp(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitApp(c, 'input[placeholder="Full name"]');
    await setValApp(c, 'input[placeholder="Full name"]', 'E2E Admin');
    await setValApp(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setValApp(c, 'input[placeholder="Choose a password"]', PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitApp(c, 'input[placeholder="10"]');
    await setValApp(c, 'input[placeholder="10"]', '10');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click();`);
  } else {
    await setValApp(c, 'input[type="email"]', OWNER_EMAIL);
    await setValApp(c, 'input[type="password"]', PW);
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

  // MOBILE-I1E §4 — the order the PRODUCTION coordinator uses, and the only order the schema
  // permits: the generation is inserted 'available' FIRST, and only then may a blob point at it.
  // `trg_mb_pointer_available_ins` refuses a pointer to a generation that does not yet exist as
  // available (MEDIA_POINTER_NOT_AVAILABLE) — the invariant that caught the first draft of this
  // fixture. Nothing here weakens it; the fixture was simply wrong.
  db.prepare(`INSERT OR REPLACE INTO media_blob_generations (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash,
                byte_size, content_kind, mime_type, extension, is_encrypted, dek_version, gen_status, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(TENANT, 'blob-e2e', 1, key, hash, JPEG.length, 'raster_image', 'image/jpeg', 'jpg', 0, null, 'available', now);
  db.prepare(`INSERT OR REPLACE INTO media_blobs (tenant_id, blob_id, dedup_token, current_generation_no, blob_status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?)`).run(TENANT, 'blob-e2e', hash, 1, 'present', now, now);
  db.prepare(`INSERT OR REPLACE INTO media_objects (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind,
                source_type, security_class, retention_class, ingest_status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(TENANT, 'media-e2e', branchId, 'blob-e2e', 'normalized', 'upload_desktop', 'internal', 'standard', 'ready', now, now);
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
  // Bound parameter, not a bare placeholder: the first draft called .all() with no argument, which
  // threw into the catch and silently reported "no rows" for a table that had them.
  try { return db.prepare(`SELECT check_id, status, notes, checked_at, source, checked_by_name FROM stock_checks WHERE product_id=? ORDER BY checked_at DESC, check_id DESC`).all(PRODUCT_ID); }
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
  killAllApp(); killEdge(); await sleep(1200);
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' is free before start (no zombie server)');
  ok(await waitPortFree(MOCK_PORT), 'mock port ' + MOCK_PORT + ' is free before start');
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

  // ══ §5 — prove the fixture is a REAL gallery-only product before trusting any assertion ══
  {
    const db = new DatabaseSync(BIZ_DB);
    const one = (sql) => db.prepare(sql).get();
    const blob = one(`SELECT blob_status, current_generation_no FROM media_blobs WHERE blob_id='blob-e2e'`);
    const gen = one(`SELECT gen_status, storage_key FROM media_blob_generations WHERE blob_id='blob-e2e' AND generation_no=1`);
    const obj = one(`SELECT ingest_status, master_blob_id FROM media_objects WHERE media_id='media-e2e'`);
    const link = one(`SELECT is_primary, deleted_at FROM media_links WHERE link_id='link-e2e'`);
    const prod = one(`SELECT images, quantity FROM products WHERE id='${PRODUCT_ID}'`);
    const integrity = one(`PRAGMA integrity_check`);
    const fk = db.prepare(`PRAGMA foreign_key_check`).all();
    db.close();
    ok(blob?.blob_status === 'present' && Number(blob?.current_generation_no) === 1, 'fixture: blob present and pointing at gen 1');
    ok(gen?.gen_status === 'available', 'fixture: generation is available');
    ok(gen?.storage_key === fixture.key, 'fixture: generation carries the storage key of the written file');
    ok(obj?.ingest_status === 'ready' && obj?.master_blob_id === 'blob-e2e', 'fixture: media object is ready and linkable');
    ok(Number(link?.is_primary) === 1 && link?.deleted_at == null, 'fixture: an ACTIVE primary link exists');
    ok(prod?.images === '[]', 'fixture: the product is gallery-only (images is empty)');
    ok(Number(prod?.quantity) === 3, 'fixture: quantity is 3');
    ok(Object.values(integrity)[0] === 'ok', 'fixture: business DB integrity_check=ok');
    ok(fk.length === 0, 'fixture: no foreign-key violations');
  }

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

  // ════════════════════════════════════════════════════════════════════════
  // MOBILE-I1F - the two proofs that need a REAL browser driving the real page
  // ════════════════════════════════════════════════════════════════════════
  writeFakeKey();
  await startMock();
  const jpgPath = join(RUN, 'capture.jpg');
  writeFileSync(jpgPath, JPEG);
  const { c: edge, uploads, responses } = await startEdge(BASE + '/mobile');
  await waitE(edge, '#loginBtn', 20000);
  ok(await existsE(edge, '#email') && await existsE(edge, '#cSaveBtn'),
    'real /mobile page served by the isolated LAN server (no mock page)');
  await mobileLogin(edge);

  // ── MOBILE-I1H - the AI button follows the photo state, with no timer ────
  //
  // Each assertion reads the button immediately after the transition that should have changed it.
  // Nothing here sleeps or tolerates a poll cycle; with the old 400 ms timer these would be racy.
  // Removing a photo has exactly one path in this UI - the form reset after a successful upload -
  // so cases C and F are the same transition and are asserted together at the upload, below.
  await clickE(edge, '.mode-btn[data-mode="collection"]');
  await waitVisE(edge, '#formCollection', 10000);
  ok(await aiBtnHidden(edge) === true, 'ai-button A: with no photo the button is not offered');

  const shotA = join(RUN, 'btn-a.jpg');
  writeFileSync(shotA, JPEG);
  await setFile(edge, '#cPhotoInput', shotA);
  // The capture handler decodes and resizes asynchronously; wait for THAT, not for a timer.
  await waitUnhidden(edge, '#cPhotoStatus', 15000);
  ok(await aiBtnHidden(edge) === false,
    'ai-button B: available as soon as the capture handler completes, with no poll wait');

  const shotB = join(RUN, 'btn-b.jpg');
  writeFileSync(shotB, Buffer.concat([JPEG, Buffer.from([0x01])]));
  await setFile(edge, '#cPhotoInput', shotB);
  await waitUnhidden(edge, '#cPhotoStatus', 15000);
  ok(await aiBtnHidden(edge) === false, 'ai-button D/E: replacing the photo keeps it available');

  // Prove it is not a timer at all: the state is right on the very next event-loop turn.
  const immediate = await edge.ev(
    'return (async () => { const b=document.querySelector("#cAiBtn");' +
    ' const before = b.classList.contains("hidden");' +
    ' await Promise.resolve();' +
    ' return JSON.stringify({ before, after: b.classList.contains("hidden") }); })();');
  ok(immediate === '{"before":false,"after":false}',
    'ai-button: the state is stable across a microtask, not reconciled by a timer (' + immediate + ')');
  const timers = await edge.ev('return typeof window.__aiBtnPoll;');
  ok(timers === 'undefined', 'ai-button: no polling handle is exposed');

  // ── ui-search: the REAL search box, not the route ────────────────────────
  await clickE(edge, '.mode-btn[data-mode="scan"]');
  await waitVisE(edge, '#scanScreen', 15000);
  await clickE(edge, '#tabSearch');
  await waitVisE(edge, '#searchPane', 10000);
  ok(await existsE(edge, '#searchInput'), 'ui-search: the Check Item screen offers a search box');

  ok(await uiSearch(edge, SKU, 1) === 1, 'ui-search exact SKU: one hit rendered in the real list');
  ok(await uiSearch(edge, '1267', { min: 1 }) >= 1, 'ui-search partial model/reference: at least one hit');
  ok(await uiSearch(edge, SERIAL, 1) === 1, 'ui-search serial: one hit');
  ok(await uiSearch(edge, REFERENCE, 1) === 1, 'ui-search reference: one hit');
  ok(await uiSearch(edge, 'Embroidered', 1) === 1, 'ui-search description: one hit');
  const brandHits = await uiSearch(edge, 'Rolex', { min: 2 });
  ok(brandHits >= 2, 'ui-search brand: multiple hits');
  ok(await uiSearch(edge, 'Patek Philippe', 0) === 0, 'ui-search no result: the list renders empty');
  ok(/No matching item/i.test(await textE(edge, '#searchResults') || ''),
    'ui-search no result: the page says so instead of showing a stale list');

  // pick a hit and prove the SAME full detail view opens
  await uiSearch(edge, SKU, 1);
  await clickE(edge, '[data-hit="0"]');
  // The detail view is 'open' when the page has un-hidden it AND rendered the product into it.
  // offsetParent/rect are unreliable inside this headless layout, so assert what the app actually did.
  const openEnd = Date.now() + 15000;
  let opened = false;
  while (Date.now() < openEnd) {
    opened = await edge.ev('const r=document.querySelector("#scanResult"); const d=document.querySelector("#scanDetails"); return !!r && !r.classList.contains("hidden") && !!d && d.innerHTML.length > 500;');
    if (opened) break;
    await sleep(300);
  }
  ok(opened, 'ui-search: clicking a hit opens the existing full product detail view');
  await sleep(1200);   // let the authenticated image fetch paint
  const uiDetail = await edge.ev('const d=document.querySelector("#scanDetails"); return d ? d.innerText : "";');
  ok(/rolex/i.test(uiDetail), 'ui-search detail: brand rendered');
  ok(/datejust 41 wimbledon/i.test(uiDetail), 'ui-search detail: name rendered');
  ok(uiDetail.indexOf(SKU) >= 0, 'ui-search detail: SKU rendered');
  ok(uiDetail.indexOf(REFERENCE) >= 0, 'ui-search detail: reference rendered');
  ok(uiDetail.indexOf(SERIAL) >= 0, 'ui-search detail: serial rendered');
  ok(/slate roman/i.test(uiDetail), 'ui-search detail: category attributes rendered');
  const photoPainted = await edge.ev('const i=document.querySelector("#pdPhoto"); return !!i && i.style.display!=="none" && i.naturalWidth>0;');
  ok(photoPainted, 'ui-search detail: the gallery photo is actually painted (naturalWidth > 0)');
  const stockBlock = await edge.ev('return !!document.querySelector("#scAvail") && !!document.querySelector("#scMissing");');
  ok(stockBlock, 'ui-search detail: the stock-check block is part of the SAME detail view');

  // ── ai-success: real photo -> AI Identify -> real route -> mock -> merge ──
  mockMode = 'success';
  mockRequests.length = 0;
  await clickE(edge, '[data-back]');
  await waitVisE(edge, '#modePicker', 10000);
  await clickE(edge, '.mode-btn[data-mode="collection"]');
  await waitVisE(edge, '#formCollection', 10000);
  await setFile(edge, '#cPhotoInput', jpgPath);
  await waitVisE(edge, '#cPhotoStatus', 15000);

  // deliberate operator input BEFORE the AI runs
  await setValE(edge, '#cName', 'My own model name');
  await setValE(edge, '#cQuantity', '3');
  await setValE(edge, '#cPurchasePrice', '');
  const photoBefore = await edge.ev('return !!(window.__photoProbe || document.querySelector("#cPhotoStatus")) && !document.querySelector("#cPhotoStatus").classList.contains("hidden");');
  ok(photoBefore, 'ai-success: a photo is captured before identifying');

  await waitUnhidden(edge, '#cAiBtn', 15000);
  await clickE(edge, '#cAiBtn');
  const aiEnd = Date.now() + 30000;
  while (Date.now() < aiEnd && mockRequests.length === 0) await sleep(200);
  await sleep(1500);

  if (mockRequests.length !== 1) console.log('  [diag] cAiMsg=' + JSON.stringify(await textE(edge, '#cAiMsg')) + ' btn=' + JSON.stringify(await textE(edge, '#cAiBtn')));
  ok(mockRequests.length === 1, 'ai-success: the request reached the upstream exactly once');
  if (mockRequests.length === 0) { console.log('  [diag] no upstream request captured; aborting AI block'); throw new Error('AI_DIAG_STOP'); }
  ok(/\/v1\/chat\/completions$/.test(mockRequests[0].url), 'ai-success: it went to the injected endpoint');
  ok(/^Bearer /.test(mockRequests[0].auth), 'ai-success: the server attached its own credential');
  ok(mockRequests[0].body.indexOf('world-class luxury goods appraiser') >= 0,
    'ai-success: the prompt is the SHARED contract text, assembled server-side');
  ok(mockRequests[0].body.indexOf('data:image/jpeg;base64') >= 0, 'ai-success: the photo bytes travelled');

  ok(await valE(edge, '#cBrand') === 'Rolex', 'ai-success: an empty field is filled from the answer');
  ok(await valE(edge, '#cName') === 'My own model name', 'ai-success: the operator value is NOT overwritten');
  ok(await valE(edge, '#cQuantity') === '3', 'ai-success: quantity stays exactly 3');
  ok((await valE(edge, '#cPurchasePrice') || '') === '', 'ai-success: no purchase price is set');
  ok((await valE(edge, '#cSalePrice') || '') === '', 'ai-success: no sale price is set');
  ok((await valE(edge, '#cMinSalePrice') || '') === '', 'ai-success: no minimum price is set');
  ok(!(await edge.ev('const e=document.querySelector("#cPhotoStatus"); return e.classList.contains("hidden");')),
    'ai-success: the photo survived the merge');
  ok(await valE(edge, '#attr_reference_number') === '126334', 'ai-success: a category attribute is filled');
  ok(await valE(edge, '#attr_dial') === 'Slate Roman', 'ai-success: dial is filled');
  const strayKeys = await edge.ev('return ["not_a_real_key","quantity","purchase_price","sku","id","stockStatus"].filter(k=>!!document.querySelector("#attr_"+k)).join(",");');
  ok(strayKeys === '', 'ai-success: no forbidden or unknown key became a form field (' + strayKeys + ')');
  const formText = await edge.ev('return document.querySelector("#formCollection").innerText;');
  ok(formText.indexOf('4200') < 0 && formText.indexOf('3100') < 0 && formText.indexOf('RLX-AI-FAKE') < 0,
    'ai-success: no price and no invented SKU appears anywhere in the form');
  ok(!/sk-|openai|Bearer|placeholder-not-a-real-key/i.test(formText + (await textE(edge, '#cAiMsg') || '')),
    'ai-success: nothing about the credential is shown in the UI');

  // ── ai upload -> receipt/inbox -> drain -> exactly one product ────────────
  const prodCountBefore = (() => { const d = new DatabaseSync(BIZ_DB); try { return d.prepare('SELECT COUNT(*) c FROM products').get().c; } finally { d.close(); } })();
  await setValE(edge, '#attr_material', 'Steel');
  await setValE(edge, '#attr_case_diameter_mm', '41');
  const beforeUpload = { brand: await valE(edge, '#cBrand'), name: await valE(edge, '#cName'), qty: await valE(edge, '#cQuantity') };
  await clickE(edge, '#cSaveBtn');
  const upEnd = Date.now() + 30000;
  while (Date.now() < upEnd && (uploads.length < 1 || !responses.some((x) => x === 200 || x === 201))) await sleep(250);
  await sleep(1200);
  ok(uploads.length === 1, 'ai-upload: exactly one POST /api/mobile/upload was issued');
  ok(responses.some((x) => x === 200 || x === 201), 'ai-upload: the server accepted it (' + JSON.stringify(responses) + ')');
  const up = uploads[0] || {};
  ok(String(up.metadata && up.metadata.quantity) === '3', 'ai-upload: the payload carries quantity 3');
  ok((up.metadata && up.metadata.brand) === 'Rolex', 'ai-upload: the AI-filled brand travelled');
  ok((up.metadata && up.metadata.name) === beforeUpload.name, 'ai-upload: the operator name travelled unchanged');
  const upJson = JSON.stringify(up.metadata || {});
  ok(upJson.indexOf('4200') < 0 && upJson.indexOf('3100') < 0 && upJson.indexOf('RLX-AI-FAKE') < 0,
    'ai-upload: no AI price or invented SKU is in the payload');
  const evId = up.upload_event_id;
  ok(!!evId, 'ai-upload: the page minted an upload event id');
  const inbox = () => { const d = new DatabaseSync(SERVER_DB); try { return d.prepare('SELECT state FROM mobile_upload_inbox WHERE upload_event_id=?').all(evId); } catch (e) { return []; } finally { d.close(); } };
  ok(inbox().length === 1, 'ai-upload: exactly one inbox receipt exists');

  // MOBILE-I1H C/F - the successful upload runs clearCollectionForm -> clearPhoto, the one removal
  // path this UI has. The button must be gone again without any timer having to notice.
  ok(await aiBtnHidden(edge) === true,
    'ai-button C/F: the post-upload form reset hides the button again, immediately');

  // a replay of the SAME upload must not create a second event
  await clickE(edge, '#cRetryPending').catch(() => {});
  await sleep(2500);
  ok(inbox().length === 1, 'ai-upload retry: still exactly one inbox receipt (exactly-once holds)');

  // ── the REAL drain: the app's own post-auth handoff worker ───────────────
  //
  // The worker is not a timer - it runs when the frontend authenticates, and only when the runtime
  // binding already exists (MOBILE-04B2A3 gates every wrapper on it). The earlier version of this
  // block waited 91s next to an app that had logged in long before the binding was configured, so
  // nothing could ever fire. The fix is the canonical trigger the ingress-worker suite uses:
  // configure the binding, then make the app authenticate again.
  const inboxState = () => {
    const d = new DatabaseSync(SERVER_DB);
    try { const r = d.prepare('SELECT state FROM mobile_upload_inbox WHERE upload_event_id=?').get(evId); return r ? r.state : null; }
    catch (e) { return null; } finally { d.close(); }
  };
  const stateBefore = inboxState();
  ok(stateBefore === 'accepted',
    'ai-drain: before the worker runs the receipt sits at ACCEPTED (got ' + stateBefore + ')');

  const scopeCfg = await invoke(app, 'mobile_runtime_scope_configure',
    { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: 'branch-main' });
  ok(scopeCfg.ok && scopeCfg.value && scopeCfg.value.configured === true,
    'ai-drain: owner configured the runtime binding (' + (scopeCfg.error || '') + ')');

  // Wait for a BUSINESS terminal state, never for a duration.
  async function pollInbox(want, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (inboxState() === want) return true; await sleep(1000); }
    return false;
  }
  async function reloadAndAuth() {
    await app.ev('window.location.reload();').catch(() => {});
    await sleep(3000);
    try { app.close(); } catch (e) {}
    const list = await (await fetch('http://127.0.0.1:' + APP_CDP + '/json/list')).json();
    const pg = list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url));
    if (!pg) throw new Error('app page vanished after reload');
    app = new CDP(pg.webSocketDebuggerUrl);
    await app.send('Runtime.enable');
    await waitInvoke(app);
    await frontendLogin(app, OWNER_PW).catch(() => {});
  }

  await reloadAndAuth();
  let drained = await pollInbox('ready', 60000);
  if (!drained) { await reloadAndAuth(); drained = await pollInbox('ready', 60000); }
  ok(drained, 'ai-drain: the real post-auth worker drained the receipt to READY (state=' + inboxState() + ')');

  // ── §6 — the product the AI-filled upload produced ───────────────────────
  const newProducts = () => {
    const d = new DatabaseSync(BIZ_DB);
    try {
      return d.prepare('SELECT id, brand, name, quantity, purchase_price, planned_sale_price, min_sale_price, sku, images, attributes FROM products WHERE id NOT IN (?,?)')
        .all(PRODUCT_ID, 'p-e2e-sub');
    } catch (e) { return []; } finally { d.close(); }
  };
  let made = newProducts();
  ok(made.length === 1, 'ai-drain: exactly ONE new product exists (' + made.length + ')');
  if (made.length === 1) {
    const row = made[0];
    ok(Number(row.quantity) === 3, 'ai-drain: quantity is 3, the number the operator typed');
    ok(row.brand === 'Rolex', 'ai-drain: the AI-filled brand survived the drain');
    ok(row.name === beforeUpload.name, 'ai-drain: the operator name survived unchanged');
    ok(!Number(row.purchase_price), 'ai-drain: no AI purchase price landed on the product');
    ok(!Number(row.planned_sale_price), 'ai-drain: no AI sale price landed on the product');
    ok(!Number(row.min_sale_price), 'ai-drain: no AI minimum price landed on the product');
    ok((row.sku || '') !== 'RLX-AI-FAKE', 'ai-drain: the invented SKU never became the product SKU');
    ok(row.images === '[]', 'ai-drain: the photo is gallery-backed, not inline (current media contract)');
    const attrs = JSON.parse(row.attributes || '{}');
    ok(attrs.reference_number === '126334', 'ai-drain: the AI attribute survived the drain');
    ok(attrs.dial === 'Slate Roman', 'ai-drain: the AI dial survived the drain');
    ok(attrs.quantity === undefined && attrs.purchase_price === undefined && attrs.not_a_real_key === undefined,
      'ai-drain: no forbidden or unknown key leaked into attributes');

    // the whole media chain, not just a link row
    const d = new DatabaseSync(BIZ_DB);
    let chain, filePath;
    try {
      chain = d.prepare(
        "SELECT l.link_id, o.ingest_status, b.blob_status, g.gen_status, g.storage_key" +
        "  FROM media_links l" +
        "  JOIN media_objects o ON o.tenant_id=l.tenant_id AND o.media_id=l.media_id" +
        "  JOIN media_blobs b ON b.tenant_id=o.tenant_id AND b.blob_id=o.master_blob_id" +
        "  JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id AND g.generation_no=b.current_generation_no" +
        " WHERE l.entity_id=? AND l.deleted_at IS NULL").all(row.id);
    } finally { d.close(); }
    ok(chain.length === 1, 'ai-drain: exactly one active gallery link (' + chain.length + ')');
    if (chain.length === 1) {
      ok(chain[0].ingest_status === 'ready', 'ai-drain: the media object is ready');
      ok(chain[0].blob_status === 'present', 'ai-drain: the blob is present');
      ok(chain[0].gen_status === 'available', 'ai-drain: the generation is available');
      filePath = join(MEDIA_ROOT, chain[0].storage_key.replace(/\//g, sep));
      ok(existsSync(filePath), 'ai-drain: the image file exists on disk');
    }

    // ── §7 — replay the SAME receipt and drain again ───────────────────────
    const replay = await api('/api/mobile/upload', {
      method: 'POST', body: JSON.stringify(up),
    }, await (async () => { const t = await edge.ev('return localStorage.getItem("lataif_mobile_token");'); return t; })());
    ok(replay.status === 200 || replay.status === 201 || replay.status === 409,
      'ai-replay: re-sending the same upload is answered without creating a new event (' + replay.status + ')');
    const receipts = (() => { const d2 = new DatabaseSync(SERVER_DB); try { return d2.prepare('SELECT COUNT(*) c FROM mobile_upload_inbox WHERE upload_event_id=?').get(evId).c; } catch (e) { return -1; } finally { d2.close(); } })();
    ok(receipts === 1, 'ai-replay: still exactly one inbox receipt (' + receipts + ')');

    await reloadAndAuth();
    await sleep(6000);   // give a second worker pass every chance to double-create
    made = newProducts();
    ok(made.length === 1, 'ai-replay: still exactly ONE product after a second drain pass (' + made.length + ')');
    ok(Number(made[0] && made[0].quantity) === 3, 'ai-replay: quantity is still 3, never doubled');
    const d3 = new DatabaseSync(BIZ_DB);
    let links2;
    try { links2 = d3.prepare('SELECT COUNT(*) c FROM media_links WHERE entity_id=? AND deleted_at IS NULL').get(row.id).c; } finally { d3.close(); }
    ok(links2 === 1, 'ai-replay: still exactly one active media link, no second attachment (' + links2 + ')');
  }

  // ── ai-failure: timeout and malformed must preserve everything ────────────
  await clickE(edge, '.mode-btn[data-mode="collection"]').catch(() => {});
  await waitVisE(edge, '#formCollection', 10000);
  const jpgPath2 = join(RUN, 'capture2.jpg');
  writeFileSync(jpgPath2, Buffer.concat([JPEG, Buffer.from([0x00])]));
  await setFile(edge, '#cPhotoInput', jpgPath2);
  await waitUnhidden(edge, '#cPhotoStatus', 20000);
  await setValE(edge, '#cBrand', 'Operator Brand');
  await setValE(edge, '#cName', 'Operator Name');
  await setValE(edge, '#cQuantity', '5');

  for (const [label, mode, waitMs] of [['timeout', 'timeout', 95000], ['malformed', 'malformed', 30000]]) {
    mockMode = mode;
    mockRequests.length = 0;
    await waitUnhidden(edge, '#cAiBtn', 15000);
    await clickE(edge, '#cAiBtn');
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      const busy = await edge.ev('const b=document.querySelector("#cAiBtn"); return b && /Identifying/.test(b.textContent);');
      if (!busy) break;
      await sleep(1000);
    }
    const msg = (await textE(edge, '#cAiMsg')) || '';
    ok(msg.trim().length > 0, 'ai-' + label + ': the page shows an understandable error state');
    ok(!/sk-|openai|Bearer|placeholder-not-a-real-key/i.test(msg), 'ai-' + label + ': the error mentions nothing about the credential');
    ok(await valE(edge, '#cBrand') === 'Operator Brand', 'ai-' + label + ': the operator brand is preserved');
    ok(await valE(edge, '#cName') === 'Operator Name', 'ai-' + label + ': the operator name is preserved');
    ok(await valE(edge, '#cQuantity') === '5', 'ai-' + label + ': quantity is preserved');
    ok(!(await edge.ev('return document.querySelector("#cPhotoStatus").classList.contains("hidden");')),
      'ai-' + label + ': the photo is preserved');
    ok(await visibleE(edge, '#formCollection'), 'ai-' + label + ': the form is still there, not reset');
  }

  // after a failure the operator can still upload by hand
  mockMode = 'success';
  const beforeManual = (() => { const d = new DatabaseSync(SERVER_DB); try { return d.prepare('SELECT COUNT(*) c FROM mobile_upload_inbox').get().c; } catch (e) { return 0; } finally { d.close(); } })();
  await setValE(edge, '#attr_dial', 'Black');
  await setValE(edge, '#attr_material', 'Steel');
  await setValE(edge, '#attr_case_diameter_mm', '40');
  await clickE(edge, '#cSaveBtn');
  const manEnd = Date.now() + 30000;
  let afterManual = beforeManual;
  while (Date.now() < manEnd) {
    const d = new DatabaseSync(SERVER_DB);
    try { afterManual = d.prepare('SELECT COUNT(*) c FROM mobile_upload_inbox').get().c; } catch (e) {} finally { d.close(); }
    if (afterManual > beforeManual) break;
    await sleep(1000);
  }
  ok(afterManual === beforeManual + 1, 'ai-failure: a manual upload still works afterwards (' + beforeManual + ' -> ' + afterManual + ')');

  killEdge();
  stopMock();

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
  try { killEdge(); } catch {}
  try { stopMock(); } catch {}
  try { killAllApp(); } catch {}
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
  if (fails.length) { console.log('\nfailures:'); for (const f of fails) console.log('  - ' + f); }
  process.exit(FAIL > 0 ? 1 : 0);
});
