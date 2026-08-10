// MOBILE-04B2A8-I3 — live HTTP ingress → worker → visible product E2E, fully isolated + test-only.
//
// The whole chain over a REAL bound socket + the REAL app: a test-only seeder makes the e2e install a
// real Primary (via the production owner-authorized transition), so its embedded HTTP server actually
// serves. Then: authenticated POST /api/mobile/upload → accepted inbox + staged bytes; retry → same job;
// different content @ same event → 409; configure the runtime binding; the app's OWN post-auth drain
// (fired by a real frontend login) claims → prepares → creates the product → marks ready; the product is
// visible; a real restart persists it. Every scope aligns on tenant-1/branch-main (the server init seeds
// it AND the frontend seedCleanDatabase seeds admin@lataif.com/admin there), so no scope hacks are needed.
//
// Isolated: distinct e2e identifier, ephemeral owner secret (never printed), full cleanup, and the
// production install is never touched — isolated identifier, isolated AppData AND isolated sync
// port 3011. Pure Node CDP + fetch; no npm deps.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223;
// STORAGE-PERF-I1 §25 — prod isolation. This suite used to hardcode 3001 and never set
// LATAIF_E2E_SYNC_PORT, so its app bound the PRODUCTION port: with production running the
// harness logged in against the real server (401 with the ephemeral e2e owner password), and
// with production stopped it occupied 3001 itself. Same isolated port as every sibling suite.
const PORT = 3011;
const HTTP = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); // server owner secret, ephemeral
const FE_PW = 'admin'; // the frontend seedCleanDatabase password for admin@lataif.com (local session)
const TENANT = 'tenant-1';
const BRANCH = 'branch-main';
const CAT = 'cat-watch';
const ENTITY = 'prod-live-1';

const RUN = join(os.tmpdir(), 'lataif-a8i3-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const STAGING = join(APP_DATA_DIR, 'mobile-upload-staging');
const PROD_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const verify = () => Object.fromEntries(seed('verify').replace('VERIFY ', '').split(' ').map((kv) => kv.split('=')));
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const stagedFiles = (root) => { let n = 0; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else if (!e.name.endsWith('.tmp')) n++; } }; walk(root); return n; };

let appProc;
async function startApp() {
  // SINGLE-PC-STORAGE-I2A §4/§5 — HARD STOP before the process exists. Proves the artefact at
  // `APP` really is the isolated E2E build (a plain `cargo build` silently overwrites it with a
  // production-identity binary) and that this suite's AppData root and sync port are the isolated
  // ones. Never a warning: a suite that cannot prove what it is launching does not launch it.
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: isoEnv() });
  appProc = spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  const deadline = Date.now() + 60000;
  let page = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* not up */ }
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  return page.webSocketDebuggerUrl;
}
function killApp() { try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
async function waitHttpHealthy() {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    try { const r = await fetch(`${HTTP}/api/health`, { signal: AbortSignal.timeout(2500) }); if (r.ok) return true; } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error(`embedded HTTP server never became healthy on ${PORT}`);
}
async function login() {
  const r = await fetch(`${HTTP}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) });
  if (!r.ok) throw new Error('server login failed: ' + r.status);
  return (await r.json()).token;
}
async function upload(token, event, imgB64, meta) {
  const body = { protocol_version: 1, upload_event_id: event, entity_id: ENTITY, mode: 'collection', metadata: meta, images: [{ mime: 'image/jpeg', data_base64: imgB64 }] };
  const r = await fetch(`${HTTP}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  close() { try { this.ws.close(); } catch {} }
}
const S = (v) => JSON.stringify(v);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function waitFor(c, sel, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor timeout: ' + sel); }
async function invoke(c, cmd, args) { return c.ev(`return (async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return { ok:true, value: v===undefined?null:v }; } catch (e) { return { ok:false, error: String((e && e.message) || e) }; } })();`); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }

const ONBOARD_PW = 'e2epass123';
// Onboarding UPDATES the existing tenant-1/branch-main/user-owner (never a new tenant) and auto-signs-in,
// so currentScope stays tenant-1/branch-main. First run → onboarding; after a restart (`onboarding.done`
// persisted) → the login screen with the password onboarding set.
async function frontendLogin(c) {
  await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 60000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin');
    await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click();`);
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click();`);
  }
  await waitFor(c, 'a[href="/settings"], nav a, [data-testid]', 45000);
}
async function pollInboxState(want, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (verify().inbox_state === want) return true; await sleep(1000); }
  return false;
}
async function productVisible(c) {
  // the collection (watch) list lives at /collection; navigate via the in-app router (no reload → keep
  // the session) and look for the created product's brand. Then open its detail and confirm a gallery img.
  const end = Date.now() + 25000;
  let listed = false;
  while (Date.now() < end && !listed) {
    await c.ev(`const a=document.querySelector('a[href="/collection"]'); if(a){a.click();} else { history.pushState({},'', '/collection'); window.dispatchEvent(new PopStateEvent('popstate')); }`).catch(() => {});
    await sleep(1500);
    listed = await c.ev(`return document.body ? /Rolex/i.test(document.body.innerText) : false;`);
  }
  if (!listed) return { listed: false, gallery: false };
  // open the product detail and check for a rendered gallery image (hero/thumbnail <img> with a src).
  let gallery = false;
  await c.ev(`history.pushState({},'', ${S('/collection/' + ENTITY)}); window.dispatchEvent(new PopStateEvent('popstate'));`).catch(() => {});
  const gend = Date.now() + 15000;
  while (Date.now() < gend && !gallery) {
    await sleep(1200);
    gallery = await c.ev(`return [...document.querySelectorAll('img')].some(i => i.src && (i.src.startsWith('blob:') || i.src.startsWith('data:') || /staging|media/i.test(i.src)));`);
  }
  return { listed, gallery };
}

async function main() {
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;

  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary (owner + primary_host_config)');
  ok(verify().primary_mode === 'primary', 'resolved primary mode');
  const imgA = seed('jpeg', '1');
  const imgB = seed('jpeg', '9');

  let ws = await startApp();
  let c = new CDP(ws);
  await waitInvoke(c);
  await waitHttpHealthy();
  ok(true, `embedded HTTP server is live on ${PORT} (Primary serves a real socket)`);

  // ── live authenticated ingress over the real socket ──
  const token = await login();
  ok(!!token, 'server owner login → JWT');
  const meta = { brand: 'Rolex', name: 'Live Submariner', categoryId: CAT };
  const up1 = await upload(token, 'ev-live-1', imgA, meta);
  ok(up1.status === 201 && up1.body?.state === 'accepted', 'POST /api/mobile/upload → 201 accepted');
  let v = verify();
  ok(v.inbox_rows === '1' && v.inbox_state === 'accepted', 'accepted inbox row present');
  ok(stagedFiles(STAGING) === 1, 'exactly one staged file (manifest + bytes on disk)');

  // exactly-once over the live socket
  const up2 = await upload(token, 'ev-live-1', imgA, meta);
  ok(up2.status === 200 && up2.body?.state === 'replay', 'retry (same event+content) → 200 replay');
  ok(verify().inbox_rows === '1', 'retry created no second job');
  const up3 = await upload(token, 'ev-live-1', imgB, { brand: 'Omega', name: 'X', categoryId: CAT });
  ok(up3.status === 409, 'same event id + different content → 409 conflict');
  ok(verify().inbox_rows === '1', 'conflict is a no-op');

  // ── configure the runtime binding (owner) BEFORE any frontend login → no worker has run yet ──
  const cfg = await invoke(c, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.bindingRevision === 1 && cfg.value?.configured === true, 'owner configured runtime binding tenant-1/branch-main');
  ok(verify().inbox_state === 'accepted', 'no processing before the worker is triggered (job still accepted)');

  // ── the app's OWN post-auth drain: a real frontend login fires it WITH the binding present ──
  await frontendLogin(c);
  let ready = await pollInboxState('ready', 45000);
  if (!ready) { // fallback: an explicit reload re-fires the post-auth/lifecycle drain
    await c.ev(`window.location.reload();`).catch(() => {}); await sleep(3000);
    try { c.close(); } catch {}
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pg = list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url));
    if (pg) { c = new CDP(pg.webSocketDebuggerUrl); await waitInvoke(c); await frontendLogin(c).catch(() => {}); }
    ready = await pollInboxState('ready', 45000);
  }
  ok(ready, 'worker drained the ingested job to READY (claim → prepare → create → mark_ready)');
  const pv = await productVisible(c);
  ok(pv.listed, 'the created product is visible in the app (collection list shows brand Rolex)');
  ok(pv.gallery, 'the product detail shows a rendered gallery image');

  // ── real restart + persistence ──
  c.close(); killApp(); await sleep(1500);
  ws = await startApp(); c = new CDP(ws); await waitInvoke(c);
  ok(verify().inbox_state === 'ready', 'after restart: the job is still READY (durable)');
  await frontendLogin(c).catch(() => {});
  ok((await productVisible(c)).listed, 'after restart: the product is still visible (persisted)');

  // ── isolation ──
  c.close();
  v = verify();
  ok(v.secret_leaks === '0', 'no owner secret in the audit sink');
  let leaked = 0;
  const scan = (dir) => { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { try { scan(p); } catch {} } else { try { if (readFileSync(p, 'latin1').includes(OWNER_PW)) leaked++; } catch {} } } };
  try { scan(RUN); scan(APP_DATA_DIR); scan(WV2_DIR); } catch {}
  ok(leaked === 0, 'owner secret not persisted anywhere in the isolated tree');
  ok((existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0) === prodBefore, 'production server DB untouched');

  console.log(`\nMOBILE-04B2A8-I3 live ingress-worker e2e: ${PASS} passed, ${FAIL} failed`);
}
main().catch((e) => { console.error('E2E ERROR:', e?.message || e); FAIL++; }).finally(() => {
  try { killApp(); } catch {}
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
  process.exit(FAIL > 0 ? 1 : 0);
});
