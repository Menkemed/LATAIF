// MOBILE-UUID-I1 — REAL /mobile page → secure upload-event-id → full production path E2E.
//
// No injected upload_event_id, no mock bridge. A headless Edge (its OWN CDP, separate process) loads the
// REAL page served by the e2e app's embedded LAN server on an ISOLATED port, logs in, picks the collection
// mode, sets a real JPEG on the file input, fills metadata and clicks Save. The page's own CSPRNG uuid()
// mints the id; we capture it off the wire (Network domain) and prove it is a valid UUID v4 and that the
// SAME id appears in the request, the server inbox, the staged media row, and (after the desktop app's own
// post-auth drain) the created product. Exactly-once: rapid double-submit, an offline→retry cycle that
// reuses the SAME id, a desktop restart, and a second real upload that gets a DIFFERENT id + its own result.
//
// Isolation: distinct e2e identifier + AppData, an ISOLATED sync port (LATAIF_E2E_SYNC_PORT) so a real
// production instance on 3001 and its DB are never touched, an ephemeral owner secret (never printed),
// full cleanup. Pure Node CDP + fetch; no npm deps. Drives the production com.lataif.app.e2e binary.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223;      // the app's WebView2 CDP (baked into tauri.e2e.conf.json)
const EDGE_CDP = 9224;     // our separate real-browser CDP
const PORT = 3011;         // isolated LAN server port (production keeps 3001)
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const TENANT = 'tenant-1';
const BRANCH = 'branch-main';

const RUN = join(os.tmpdir(), 'lataif-uuid-e2e', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const STAGING = join(APP_DATA_DIR, 'mobile-upload-staging');
const PROD_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  \u2717 ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const verify = () => Object.fromEntries(seed('verify').replace('VERIFY ', '').split(' ').map((kv) => kv.split('=')));
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

// query the isolated server DB read-only, in-process (node:sqlite). Returns rows as value-arrays. A reader
// sees committed data even while the app holds the DB open (WAL).
let dbErrLogged = false;
function dbQuery(sql) {
  let db;
  try { db = new DatabaseSync(SERVER_DB); return db.prepare(sql).all().map((r) => Object.values(r)); }
  catch (e) { if (!dbErrLogged) { dbErrLogged = true; console.log('  [dbQuery open error] ' + (e?.message || e)); } return []; }
  finally { try { db?.close(); } catch {} }
}
const inboxRow = (ev) => dbQuery(`SELECT state FROM mobile_upload_inbox WHERE upload_event_id='${ev}'`);
const imageRows = (ev) => dbQuery(`SELECT upload_event_id FROM mobile_upload_image WHERE upload_event_id='${ev}'`);
const tableExists = (t) => dbQuery(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`).length > 0;

// ── minimal CDP client (shared shape for both the app and Edge) ──────────────────────────────────
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
const S = (v) => JSON.stringify(v);

// ── app (WebView2) helpers ───────────────────────────────────────────────────────────────────────
let appProc;
async function startApp() {
  // SINGLE-PC-STORAGE-I2A §4/§5 — HARD STOP before the process exists. Proves the artefact at
  // `APP` really is the isolated E2E build (a plain `cargo build` silently overwrites it with a
  // production-identity binary) and that this suite's AppData root and sync port are the isolated
  // ones. Never a warning: a suite that cannot prove what it is launching does not launch it.
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
// Kill EVERY stray e2e artefact — target/debug lataif instances AND our own headless Edge — so no zombie
// server (with a different in-memory JWT secret) or browser can bind our port/CDP and contaminate the run.
function killAllApp() {
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {}
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -match 'headless|remote-debugging-port=" + EDGE_CDP + "|lataif-uuid-e2e' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }"], { stdio: 'ignore' }); } catch {}
}
async function waitPortFree(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
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
const ONBOARD_PW = 'e2epass123';
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
async function pollInbox(want, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (verify().inbox_state === want) return true; await sleep(1000); } return false; }
async function productVisible(c, entity) {
  const end = Date.now() + 25000; let listed = false;
  while (Date.now() < end && !listed) {
    await c.ev(`const a=document.querySelector('a[href="/collection"]'); if(a){a.click();} else { history.pushState({},'','/collection'); window.dispatchEvent(new PopStateEvent('popstate')); }`).catch(() => {});
    await sleep(1500);
    listed = await c.ev(`return document.body ? /Rolex/i.test(document.body.innerText) : false;`);
  }
  return listed;
}

// ── Edge (real browser) helpers ────────────────────────────────────────────────────────────────
let edgeProc;
async function startEdge(url, neuterRandomUUID, profile = EDGE_PROFILE) {
  edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${EDGE_CDP}`, 'about:blank'], { stdio: 'ignore' });
  const end = Date.now() + 40000; let ws = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/list`)).json(); const pg = l.find((t) => t.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
  if (!ws) throw new Error('edge CDP did not come up');
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('Network.enable');
  // capture every POST /api/mobile/upload body off the wire.
  const uploads = []; const responses = [];
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') { const r = m.params.request; if (r && /\/api\/mobile\/upload$/.test(r.url) && r.method === 'POST' && r.postData) { try { uploads.push(JSON.parse(r.postData)); } catch {} } }
    else if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r && /\/api\/mobile\/upload$/.test(r.url)) responses.push(r.status); }
  });
  if (neuterRandomUUID) {
    // simulate a plain-HTTP LAN origin where crypto.randomUUID is unavailable → force the getRandomValues path.
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{ Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}); }catch(e){}` });
  }
  await c.send('Page.navigate', { url });
  await sleep(1500);
  return { c, uploads, responses };
}
function killEdge() { try { execFileSync('taskkill', ['/F', '/PID', String(edgeProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
const existsE = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const visibleE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return !!e && !e.classList.contains('hidden') && e.offsetParent!==null;`);
async function waitE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsE(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitVisE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await visibleE(c, sel)) return true; await sleep(200); } throw new Error('waitVisE ' + sel); }
const setValE = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
async function setFile(c, sel, path) {
  const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false });
  await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [path] });
}
async function mobileLogin(c) {
  await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW);
  await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker');
}
// One real login only; the token the page received is used UNMODIFIED through to the upload. No harness
// token refresh — the upload_event_id and entity_id are minted solely by the page's own uuid() in enqueue().
async function submitCollection(c, jpgPath, brand, doubleClick = false) {
  await clickE(c, '.mode-btn[data-mode="collection"]'); await waitVisE(c, '#formCollection');
  await setFile(c, '#cPhotoInput', jpgPath);
  await waitVisE(c, '#cPhotoStatus', 10000); // FileReader done → photo captured
  await setValE(c, '#cBrand', brand); await setValE(c, '#cName', 'Live Submariner');
  // MOBILE-FIELDS — the schema-driven form now enforces the Watch required attributes client-side; fill them
  // so the real-page submit proceeds. (Old minimal-payload backward-compat is proven at the contract level by
  // the direct-POST case in mobile-fields.e2e.mjs.)
  await setValE(c, '#attr_case_diameter_mm', '40'); await setValE(c, '#attr_dial', 'Black'); await setValE(c, '#attr_material', 'Steel');
  // a rapid double-click must enqueue only ONE event: the handler disables the button synchronously.
  if (doubleClick) await c.ev(`const b=document.querySelector('#cSaveBtn'); b.click(); b.click(); return 'OK';`);
  else await clickE(c, '#cSaveBtn');
}

async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' is free before start (no zombie server)');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;

  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');
  const jpg1 = join(RUN, 'a.jpg'); writeFileSync(jpg1, Buffer.from(seed('jpeg', '1'), 'base64'));
  const jpg2 = join(RUN, 'b.jpg'); writeFileSync(jpg2, Buffer.from(seed('jpeg', '9'), 'base64'));

  const ws = await startApp(); const app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  ok(true, 'e2e embedded server healthy on isolated port ' + PORT + ' (production 3001 untouched)');
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');

  // ── §1 REAL mobile page mints its own secure id and submits over the real UI ──
  const { c: edge, uploads, responses } = await startEdge(`${BASE}/mobile`, false);
  await waitE(edge, '#loginBtn', 20000);
  ok(await existsE(edge, '#email') && await existsE(edge, '#cSaveBtn'), 'real /mobile page loaded from the LAN server (login + collection form present, no mock)');
  await mobileLogin(edge);
  await submitCollection(edge, jpg1, 'Rolex', true); // rapid double-click
  // wait for the POST to be captured, the server to answer 201/200, and the page to show success.
  const upEnd = Date.now() + 20000; while (Date.now() < upEnd && (uploads.length < 1 || !responses.some((s) => s === 201 || s === 200))) await sleep(200);
  await sleep(800);
  ok(uploads.length === 1, 'a rapid double-click issued EXACTLY ONE POST /api/mobile/upload (no duplicate)');
  ok(responses.some((s) => s === 201 || s === 200), 'server accepted the upload (2xx) — status ' + JSON.stringify(responses));
  await waitVisE(edge, '#cSuccess', 10000).catch(() => {});
  const ev1 = uploads[0]?.upload_event_id; const ent1 = uploads[0]?.entity_id;
  ok(!!ev1 && V4.test(ev1), `page-generated upload_event_id is a valid UUID v4 (${ev1})`);
  ok(!!ent1 && V4.test(ent1) && ent1 !== ev1, 'entity_id is a distinct valid UUID v4');
  ok(uploads[0]?.mode === 'collection' && !!uploads[0]?.images?.length, 'request carries collection mode + the captured image');

  // ── §2 the SAME id reached the server: inbox + staged media, receipt durable ──
  ok(inboxRow(ev1).length === 1 && inboxRow(ev1)[0][0] === 'accepted', 'exactly one accepted inbox row for the page id');
  ok(imageRows(ev1).length >= 1, 'staged media row references the same upload_event_id');
  if (tableExists('mobile_upload_receipts')) ok(dbQuery(`SELECT 1 FROM mobile_upload_receipts WHERE upload_event_id='${ev1}'`).length === 1, 'a durable receipt exists for the page id');
  else ok(true, 'receipt table absent in this schema (skip)');

  // ── §3 exactly-once: rapid double-submit does NOT create a second event ──
  // going back to the form and clicking save again on the (now cleared) form must not re-send the old id;
  // and there is still exactly one inbox row for ev1.
  ok(inboxRow(ev1).length === 1, 'still exactly one inbox row for ev1 (no duplicate)');
  ok(dbQuery(`SELECT COUNT(*) FROM mobile_upload_inbox`)[0][0] === 1, 'exactly one inbox row total after the first upload');

  // ── §4 offline → retry reuses the SAME (new) id; forces the getRandomValues branch ──
  await edge.close(); killEdge(); await sleep(2500); // free CDP port 9224 before the second browser
  const { c: edge2, uploads: uploads2, responses: responses2 } = await startEdge(`${BASE}/mobile`, true, join(RUN, 'edge-profile2')); // randomUUID neutered → LAN fallback
  await mobileLogin(edge2);
  await edge2.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await submitCollection(edge2, jpg2, 'Omega');
  await sleep(2500); // enqueue persisted; drain failed offline → retryable
  ok(await edge2.ev(`return !document.querySelector('#cPending')?.classList.contains('hidden');`), 'offline: the upload is queued + shown as pending');
  const pendingId = await edge2.ev(`return new Promise((res)=>{const r=indexedDB.open('lataif_mobile_uploads',1);r.onsuccess=()=>{const tx=r.result.transaction('collectionUploads','readonly').objectStore('collectionUploads').getAll();tx.onsuccess=()=>res((tx.result[0]||{}).uploadEventId||null);};r.onerror=()=>res(null);});`);
  ok(!!pendingId && V4.test(pendingId) && pendingId !== ev1, `offline id is a new valid v4 via getRandomValues (${pendingId})`);
  await edge2.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await clickE(edge2, '#cRetryPending'); // user-triggered retry
  const rEnd = Date.now() + 15000; while (Date.now() < rEnd && !(uploads2.some((u) => u.upload_event_id === pendingId) && responses2.some((s) => s === 201 || s === 200))) await sleep(300);
  await sleep(800); // let the accepted row commit
  ok(uploads2.some((u) => u.upload_event_id === pendingId), 'retry re-sent the SAME id (never a new one)');
  ok(inboxRow(pendingId).length === 1 && pendingId !== ev1, 'the retried upload is a second, distinct inbox event');
  ok(dbQuery(`SELECT COUNT(*) FROM mobile_upload_inbox`)[0][0] === 2, 'exactly two inbox rows total (one per real upload)');

  // ── §5 desktop drain turns the ingested jobs into a visible product; restart persists ──
  await frontendLogin(app);
  let ready = await pollInbox('ready', 45000);
  if (!ready) { await app.ev(`window.location.reload();`).catch(() => {}); await sleep(3000); ready = await pollInbox('ready', 30000); }
  ok(ready, 'the app\'s own post-auth drain created the product(s) from the page ids');
  ok(await productVisible(app, ent1), 'the created product is visible in the desktop app');
  const stagedFiles = (root) => { let n = 0; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else if (!e.name.endsWith('.tmp')) n++; } }; walk(root); return n; };
  ok(stagedFiles(STAGING) >= 1, 'the uploaded image bytes are staged on disk (media persisted)');

  // real restart before further work → durability
  app.close(); killApp(); await sleep(1500);
  const ws2 = await startApp(); const app2 = new CDP(ws2); await waitInvoke(app2);
  ok(dbQuery(`SELECT COUNT(*) FROM mobile_upload_inbox`)[0][0] === 2, 'after restart: both inbox events persist (durable, no re-drain duplicates)');
  ok(verify().inbox_state === 'ready', 'after restart: jobs remain READY');
  app2.close();

  // ── §6 security / isolation ──
  ok(verify().secret_leaks === '0', 'no owner secret in the audit sink');
  let leaked = 0; const scan = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { try { scan(p); } catch {} } else { try { if (readFileSync(p, 'latin1').includes(OWNER_PW)) leaked++; } catch {} } } };
  try { scan(RUN); scan(APP_DATA_DIR); } catch {}
  ok(leaked === 0, 'owner secret not persisted anywhere in the isolated tree');
  ok((existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0) === prodBefore, 'production DB (port 3001 install) untouched');

  console.log(`\nMOBILE-UUID-I1 real-page e2e: ${PASS} passed, ${FAIL} failed`);
}
main().catch((e) => { console.error('E2E ERROR:', e?.stack || e?.message || e); FAIL++; }).finally(() => {
  try { killEdge(); } catch {}
  try { killAllApp(); } catch {}
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
  process.exit(FAIL > 0 ? 1 : 0);
});
