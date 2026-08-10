// MOBILE-04B2A5-H1 — isolated REAL Tauri desktop E2E smoke for owner runtime-scope provisioning.
//
// Drives the ACTUAL packaged app (distinct e2e identifier `com.lataif.app.e2e`, built with a fixed
// WebView2 remote-debugging port) through its REAL WebView2 DevTools/CDP endpoint: the genuine React
// dialog → Tauri invoke → authorize_owner → configure → binding + append-only audit → real restart
// persistence. Fully isolated: distinct identifier + redirected APPDATA/LOCALAPPDATA/TEMP under a
// per-run temp dir, so no production DB/config is touched. The owner secret is generated per run,
// passed via env, and never printed.
//
// We drive via CDP directly (Node's global WebSocket): msedgedriver's debuggerAddress attach lands on
// an about:blank target instead of the app page (a known WebView2 quirk), whereas the CDP page target
// is the genuine app DOM. This is still the real desktop app + real WebView2 + real IPC.
//
// Run (from desktop/): MSEDGEDRIVER unused; node test/e2e/runtime-scope-provisioning.e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const REPO = process.cwd();
const APP = 'E:/software/lataif/desktop/src-tauri/target/debug/lataif.exe';
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); // ephemeral, never printed
const TENANT = 'tenant-acme';
const BRANCH_A = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const BRANCH_B = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';

const RUN = join(os.tmpdir(), 'lataif-a5-e2e', 'run-' + Date.now());
// Tauri resolves app_data_dir via SHGetKnownFolderPath (ignores the APPDATA env var), so isolation is
// achieved by the DISTINCT e2e identifier — its data lives under the real roaming/local AppData but in
// a com.lataif.app.e2e subtree that NEVER overlaps production (com.lataif.app) and is fully removed on
// cleanup. Everything else (TEMP) stays under RUN.
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const PROD_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; } else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode) => execFileSync(SEED, [mode, SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const verify = () => Object.fromEntries(seed('verify').replace('VERIFY ', '').split(' ').map((kv) => kv.split('=')));
// SINGLE-PC-STORAGE-I2 §19/§20 — the isolated sync port belongs here too. This suite drives the app
// purely over CDP and never speaks HTTP itself, which is exactly why the omission was invisible: the
// app it launches still starts its embedded server, and without this it BOUND the production port
// 3001 — colliding with a running production instance, or occupying that port when none was running.
const PORT = 3011;
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

let appProc;
async function startApp() {
  // SINGLE-PC-STORAGE-I2A §4/§5 — HARD STOP before the process exists. Proves the artefact at
  // `APP` really is the isolated E2E build (a plain `cargo build` silently overwrites it with a
  // production-identity binary) and that this suite's AppData root and sync port are the isolated
  // ones. Never a warning: a suite that cannot prove what it is launching does not launch it.
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: isoEnv() });
  appProc = spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error('app CDP page did not come up');
}
function killApp() { try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }

// minimal CDP client over the page target's websocket
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
    const r = await this.send('Runtime.evaluate', { expression: `(()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const S = (v) => JSON.stringify(v);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const text = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e?e.innerText:null;`);
const val = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e?e.value:null;`);
const click = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; e.click(); return 'OK';`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function waitFor(c, sel, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error('waitFor timeout: ' + sel);
}
const td = (id) => `[data-testid="${id}"]`;

async function reachSyncServerTab(c) {
  // wait for the app to render past the loading screen
  await waitFor(c, 'input, a[href="/settings"]', 60000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E User');
    await setVal(c, 'input[placeholder="you@company.com"]', 'e2e@user.local');
    await setVal(c, 'input[placeholder="Choose a password"]', 'e2epass123');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click();`);
  } else if (await exists(c, 'input[type="email"]')) {
    await setVal(c, 'input[type="email"]', 'e2e@user.local');
    await setVal(c, 'input[type="password"]', 'e2epass123');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Sign In'))?.click();`);
  }
  await waitFor(c, 'a[href="/settings"]', 30000);
  await click(c, 'a[href="/settings"]');
  await waitFor(c, 'button', 10000);
  await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sync / Server')?.click();`);
  await waitFor(c, td('open-scope-dialog'), 20000);
}
async function openDialog(c) { await click(c, td('open-scope-dialog')); await waitFor(c, td('rs-phase-auth'), 10000); }
async function auth(c, pw) { await setVal(c, td('rs-email'), OWNER_EMAIL); await setVal(c, td('rs-password'), pw); await click(c, td('rs-load')); }

async function main() {
  // clean slate: remove any leftover e2e-identifier data from a prior run (NEVER touches production)
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;

  ok(seed('seed') === 'SEED_OK', 'server DB seeded (owner + tenant-acme + branches A/B)');
  let v = verify();
  ok(v.active_rev === '0' && v.audit_events === '0', 'pre-state: unconfigured, no audit');

  let ws = await startApp();
  let c = new CDP(ws);
  await reachSyncServerTab(c);

  // (3) DENY — wrong owner secret
  await openDialog(c);
  await auth(c, 'definitely-wrong');
  await waitFor(c, td('rs-error'), 15000);
  ok(((await text(c, td('rs-error'))) || '').length > 0, 'wrong owner → sanitized error shown');
  ok(await exists(c, td('rs-phase-auth')), 'still in auth phase after denial');
  ok((await val(c, td('rs-password'))) === '', 'secret cleared after failed auth');

  // (4) ALLOW — options from the real server DB (non-default tenant + UUID branches)
  await auth(c, OWNER_PW);
  await waitFor(c, td('rs-phase-configure'), 15000);
  ok(await exists(c, td('rs-tenant') + ` option[value="${TENANT}"]`), 'non-default tenant offered');
  await setVal(c, td('rs-tenant'), TENANT);
  ok(await exists(c, td('rs-branch') + ` option[value="${BRANCH_A}"]`), 'UUID branch A offered');
  ok(await exists(c, td('rs-branch') + ` option[value="${BRANCH_B}"]`), 'UUID branch B offered');

  // (5) CANCEL — no binding, no audit
  await click(c, td('rs-cancel'));
  v = verify();
  ok(v.active_rev === '0' && v.audit_events === '0', 'cancel → no binding, no audit');

  // (6) CONFIGURE branch A → revision 1 + one audit
  await openDialog(c); await auth(c, OWNER_PW); await waitFor(c, td('rs-phase-configure'), 15000);
  await setVal(c, td('rs-tenant'), TENANT); await setVal(c, td('rs-branch'), BRANCH_A);
  await click(c, td('rs-submit'));
  await waitFor(c, td('rs-phase-done'), 15000);
  ok(((await text(c, td('rs-done'))) || '').includes('revision 1'), 'first configure → revision 1');
  await click(c, td('rs-close'));
  v = verify();
  ok(v.active_tenant === TENANT && v.active_branch === BRANCH_A && v.active_rev === '1' && v.audit_events === '1', 'DB: branch A active rev1, one audit');

  // (7) IDEMPOTENT — same config, no bump, no new audit
  await openDialog(c); await auth(c, OWNER_PW); await waitFor(c, td('rs-phase-configure'), 15000);
  await setVal(c, td('rs-tenant'), TENANT); await setVal(c, td('rs-branch'), BRANCH_A);
  await click(c, td('rs-submit'));
  await waitFor(c, td('rs-phase-done'), 15000);
  await click(c, td('rs-close'));
  v = verify();
  ok(v.active_rev === '1' && v.audit_events === '1', 'idempotent → no revision bump, no new audit');

  // (8) REBIND branch B → warning + revision 2 + one new audit
  await openDialog(c); await auth(c, OWNER_PW); await waitFor(c, td('rs-phase-configure'), 15000);
  await setVal(c, td('rs-tenant'), TENANT); await setVal(c, td('rs-branch'), BRANCH_B);
  await waitFor(c, td('rs-rebind-warning'), 8000);
  ok(((await text(c, td('rs-rebind-warning'))) || '').includes('revision will increase to 2'), 'rebind warning shows revision bump');
  await click(c, td('rs-submit'));
  await waitFor(c, td('rs-phase-done'), 15000);
  ok(((await text(c, td('rs-done'))) || '').includes('revision 2'), 'rebind → revision 2');
  await click(c, td('rs-close'));
  v = verify();
  ok(v.active_branch === BRANCH_B && v.active_rev === '2' && v.audit_events === '2' && v.superseded === '1', 'DB: branch B active rev2, two audits, one superseded');

  // (9) RESTART — full app relaunch (kill + fresh process); persisted binding shown
  c.close(); killApp(); await sleep(1500);
  ws = await startApp(); c = new CDP(ws);
  await reachSyncServerTab(c);
  await openDialog(c); await auth(c, OWNER_PW); await waitFor(c, td('rs-phase-configure'), 15000);
  const cur = (await text(c, td('rs-phase-configure'))) || '';
  ok(cur.includes(BRANCH_B) && cur.includes('revision 2'), 'after restart: dialog shows persisted binding (branch B, rev 2)');
  await click(c, td('rs-cancel'));
  c.close();

  // (10) inactivity + secret non-persistence + no production file touched
  v = verify();
  ok(v.inbox_rows === '0', 'inactivity: 0 mobile inbox rows (no processing triggered)');
  ok(v.secret_leaks === '0', 'audit sink carries no secret');
  let leaked = 0;
  const scan = (dir) => { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { try { scan(p); } catch {} } else { try { if (readFileSync(p, 'latin1').includes(OWNER_PW)) leaked++; } catch {} } } };
  try { scan(RUN); scan(APP_DATA_DIR); scan(WV2_DIR); } catch {}
  ok(leaked === 0, 'owner secret not found anywhere in isolated logs/config/DB/webview data');
  const prodAfter = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;
  ok(prodAfter === prodBefore, 'no production server DB was modified');

  console.log(`\nMOBILE-04B2A5-H1 e2e: ${PASS} passed, ${FAIL} failed`);
}

main()
  .catch((e) => { console.error('E2E ERROR:', e?.message || e); FAIL++; })
  .finally(() => {
    try { killApp(); } catch {}
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
    try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
    process.exit(FAIL > 0 ? 1 : 0);
  });
