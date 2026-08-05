// MEDIA-ROOT-GC-I1 — REAL app → owner-gated unused-media cleanup E2E (dry-run → apply → verify).
//
// Seeds a Primary, ingests one real product image (mobile upload → drain) so the media root has a REFERENCED
// file, plants one orphan directly in the media root, creates a real backup snapshot (the apply precondition),
// then drives the actual owner-gated commands the Settings UI calls: a wrong owner is rejected, a dry-run
// finds exactly the orphan and mutates nothing, and apply removes ONLY the orphan while every referenced file
// survives. A restart shows no boot/GC error and the product is still visible; a further mobile upload is
// still exactly-once. Isolated app id/AppData/port; production 3001 + its DB untouched; no leftover processes.
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
const setValE = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
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
  // a rapid double-click must enqueue only ONE event: the handler disables the button synchronously.
  if (doubleClick) await c.ev(`const b=document.querySelector('#cSaveBtn'); b.click(); b.click(); return 'OK';`);
  else await clickE(c, '#cSaveBtn');
}

function pids() {
  try { const o = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Select-Object -Expand Id) -join ','"], { encoding: 'utf8' }).trim(); return o ? o.split(',').map(Number) : []; } catch { return []; }
}
async function findPage() {
  try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); return l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl) || null; } catch { return null; }
}
// Create a real complete backup snapshot (the GC apply precondition) via the app's own scheduled-backup +
// relaunch path, then reattach to the relaunched instance.
async function backupRelaunch(c) {
  const p1 = pids();
  await c.ev(`try{window.__lataifRestore.scheduleBackupSnapshot({email:${S(OWNER_EMAIL)},password:${S(OWNER_PW)}});}catch(e){}return 'x';`).catch(() => {});
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const pp = pids();
    const gone = !p1.some((x) => pp.includes(x));
    if (gone && pp.length === 1) { const pg = await findPage(); if (pg) return pg.webSocketDebuggerUrl; }
  }
  return null;
}

async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' is free before start (no zombie server)');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;
  const MEDIA = join(APP_DATA_DIR, 'media');
  // count only content blobs — dot-prefixed entries (.ingest-journal, .gc-quarantine) are control state.
  const mediaFiles = (root) => { const out = []; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const q = join(p, e.name); if (e.isDirectory()) walk(q); else out.push(q); } }; walk(root); return out; };

  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');
  const jpg1 = join(RUN, 'a.jpg'); writeFileSync(jpg1, Buffer.from(seed('jpeg', '1'), 'base64'));

  let app = new CDP(await startApp()); await waitInvoke(app); await waitHealthy();
  ok(true, 'e2e embedded server healthy on isolated port ' + PORT + ' (production 3001 untouched)');
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');

  // ── a REAL referenced product image: one mobile upload → drain → ingested into the media root ──
  const { c: edge, uploads, responses } = await startEdge(`${BASE}/mobile`, false);
  await waitE(edge, '#loginBtn', 20000);
  await mobileLogin(edge);
  await submitCollection(edge, jpg1, 'Rolex');
  const upEnd = Date.now() + 20000; while (Date.now() < upEnd && (uploads.length < 1 || !responses.some((s) => s === 201 || s === 200))) await sleep(200);
  ok(responses.some((s) => s === 201 || s === 200), 'referenced upload accepted (2xx)');
  const ent1 = uploads[0]?.entity_id;
  await edge.close(); killEdge(); await sleep(1500);
  await frontendLogin(app);
  let ready = await pollInbox('ready', 45000);
  if (!ready) { await app.ev(`window.location.reload();`).catch(() => {}); await sleep(3000); ready = await pollInbox('ready', 30000); }
  ok(ready, 'the post-auth drain ingested the upload into a product (referenced media in the media root)');
  const referencedBefore = mediaFiles(MEDIA);
  ok(referencedBefore.length >= 1, 'at least one referenced media file exists in the media root');

  // ── plant a REAL orphan directly in the media root (never referenced by any record) ──
  const orphanRel = join('tenant-1', 'de', 'de' + '0'.repeat(62) + '.jpg');
  const orphanAbs = join(MEDIA, orphanRel);
  mkdirSync(join(MEDIA, 'tenant-1', 'de'), { recursive: true });
  writeFileSync(orphanAbs, Buffer.from('THIS-IS-AN-ORPHANED-OLD-IMAGE-NEVER-REFERENCED'));
  ok(existsSync(orphanAbs), 'planted one orphaned file in the media root');

  // ── the GC apply precondition: a complete backup snapshot must exist → create one (relaunch) ──
  const ws2 = await backupRelaunch(app);
  ok(!!ws2, 'a backup snapshot was created (scheduled backup + relaunch)');
  app.close(); app = new CDP(ws2); await waitInvoke(app); await waitHealthy();
  ok(verify().primary_mode === 'primary', 'after relaunch: still Primary, server healthy');

  // ── real Settings flow: wrong owner rejected, then an owner dry-run scan ──
  const bad = await invoke(app, 'scan_unused_media', { email: OWNER_EMAIL, password: 'definitely-wrong' });
  ok(!bad.ok, 'wrong owner password is rejected for the scan');
  const scanR = await invoke(app, 'scan_unused_media', { email: OWNER_EMAIL, password: OWNER_PW });
  ok(scanR.ok && scanR.value?.orphanCount >= 1, `dry-run finds the orphan (orphanCount=${scanR.ok ? scanR.value.orphanCount : scanR.error})`);
  ok(scanR.ok && scanR.value.referencedCount >= 1, 'dry-run reports the referenced media as kept');
  ok(existsSync(orphanAbs), 'dry-run changed NOTHING on disk (orphan still present)');
  ok(mediaFiles(MEDIA).length === referencedBefore.length + 1, 'media root still holds referenced + the orphan');

  // ── SCHEDULE (owner): the move runs at BOOT (write barrier), nothing is deleted live ──
  const wrongSched = await invoke(app, 'schedule_media_gc', { email: OWNER_EMAIL, password: 'definitely-wrong' });
  ok(!wrongSched.ok, 'wrong owner password is rejected for schedule');
  const sched = await invoke(app, 'schedule_media_gc', { email: OWNER_EMAIL, password: OWNER_PW });
  ok(sched.ok, 'owner scheduled the cleanup (durable intent)');
  ok(existsSync(orphanAbs), 'schedule deleted NOTHING live (orphan still in place)');

  // ── restart → the boot write barrier moves the orphan into a RETAINED quarantine (never purged at boot) ──
  // (kill ALL e2e instances: a prior scheduled backup relaunched the app, so appProc.pid is stale.)
  app.close(); killAllApp(); await sleep(2000); await waitPortFree(PORT);
  app = new CDP(await startApp()); await waitInvoke(app); await waitHealthy();
  ok(!existsSync(orphanAbs), 'after restart: orphan moved out of the media path (boot barrier)');
  ok(existsSync(join(MEDIA, '.gc-quarantine')), 'orphan sits in a RETAINED quarantine (not purged at boot)');
  const scan2 = await invoke(app, 'scan_unused_media', { email: OWNER_EMAIL, password: OWNER_PW });
  ok(scan2.ok && scan2.value.quarantinedCount === 1 && scan2.value.orphanCount === 0, `scan shows 1 quarantined, 0 new orphans (${scan2.ok ? JSON.stringify({ q: scan2.value.quarantinedCount, o: scan2.value.orphanCount }) : scan2.error})`);
  ok(referencedBefore.every((f) => existsSync(f)), 'every referenced media file survived the scheduled move');

  // ── FINALIZE (owner): the ONLY permanent deletion ──
  const wrongFin = await invoke(app, 'finalize_media_gc', { email: OWNER_EMAIL, password: 'nope' });
  ok(!wrongFin.ok, 'wrong owner password is rejected for finalize');
  const fin = await invoke(app, 'finalize_media_gc', { email: OWNER_EMAIL, password: OWNER_PW });
  ok(fin.ok && fin.value?.purged >= 1, `finalize purged the orphan (purged=${fin.ok ? fin.value.purged : fin.error})`);
  ok(!existsSync(join(MEDIA, '.gc-quarantine')), 'quarantine removed after finalize');
  ok(referencedBefore.every((f) => existsSync(f)), 'every referenced media file survived finalize');
  // audit: the REAL run_id threaded schedule→boot→finalize to a terminal `completed`; no synthetic id.
  ok(dbQuery(`SELECT COUNT(*) FROM media_gc_runs WHERE state='completed'`)[0][0] >= 1, 'audit: a run reached completed');
  ok(dbQuery(`SELECT COUNT(*) FROM media_gc_runs WHERE run_id LIKE 'finalize-%'`)[0][0] === 0, 'audit: no synthetic finalize-<now> run id');
  ok(dbQuery(`SELECT COUNT(*) FROM media_gc_runs WHERE state NOT IN ('planned','quarantined','completed','partial','failed')`)[0][0] === 0, 'audit: only valid run states');

  // ── restart: no boot GC error, the product is still visible ──
  app.close(); killAllApp(); await sleep(2000); await waitPortFree(PORT);
  const app2 = new CDP(await startApp()); await waitInvoke(app2); await waitHealthy();
  ok(await productVisible(app2, ent1), 'after restart: the product + its referenced image are still visible');

  // ── mobile upload is still exactly-once after the GC ──
  const inboxBefore = dbQuery(`SELECT COUNT(*) FROM mobile_upload_inbox`)[0][0];
  const jpg2 = join(RUN, 'c.jpg'); writeFileSync(jpg2, Buffer.from(seed('jpeg', '9'), 'base64'));
  const { c: edge3, responses: r3 } = await startEdge(`${BASE}/mobile`, false, join(RUN, 'edge-profile3'));
  await mobileLogin(edge3);
  await submitCollection(edge3, jpg2, 'Omega', true); // rapid double-click
  const e3 = Date.now() + 20000; while (Date.now() < e3 && !r3.some((s) => s === 201 || s === 200)) await sleep(200);
  await sleep(800);
  ok(dbQuery(`SELECT COUNT(*) FROM mobile_upload_inbox`)[0][0] === inboxBefore + 1, 'post-GC mobile upload is exactly-once (one new inbox event, no duplicate)');
  await edge3.close(); killEdge();

  // ── security / isolation ──
  ok(verify().secret_leaks === '0', 'no owner secret in the audit sink');
  let leaked = 0; const scan = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { try { scan(p); } catch {} } else { try { if (readFileSync(p, 'latin1').includes(OWNER_PW)) leaked++; } catch {} } } };
  try { scan(RUN); scan(APP_DATA_DIR); } catch {}
  ok(leaked === 0, 'owner secret not persisted anywhere in the isolated tree');
  ok((existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0) === prodBefore, 'production DB (port 3001 install) untouched');
  app2.close();

  console.log(`\nMEDIA-ROOT-GC real-app e2e: ${PASS} passed, ${FAIL} failed`);
}
main().catch((e) => { console.error('E2E ERROR:', e?.stack || e?.message || e); FAIL++; }).finally(() => {
  try { killEdge(); } catch {}
  try { killAllApp(); } catch {}
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
  process.exit(FAIL > 0 ? 1 : 0);
});
