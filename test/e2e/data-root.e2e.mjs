// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B1 — the locator contract, proved against the REAL desktop app.
//
// The unit tests prove the resolver's logic against temp directories. They cannot prove the thing
// that actually matters to a person who installs an update: that the app still opens THE SAME
// database file, with the same bytes, and that when the locator is gone it refuses to start rather
// than opening something older and letting someone work in it.
//
// So this drives the genuine packaged app (isolated identifier `com.lataif.app.e2e`, isolated sync
// port) through five states no unit test can reach:
//
//   §1 a real install with real data, bootstrapped in place
//   §2 the UPGRADE case — locator and marker removed, i.e. exactly what a pre-0.8.43 install looks
//      like — must adopt the folder and reopen the identical database
//   §3 restarts must change nothing at all
//   §4 the P1 case — locator lost AFTER registration — must REFUSE to start, and must leave the
//      data untouched so the refusal is recoverable
//   §5 a root-id mismatch and a corrupt locator must refuse the same way
//
// Throughout, production (`com.lataif.app`) is asserted untouched: no locator is written there and
// no production database is modified. The isolation is structural — the locator lives inside the
// identifier's own AppData — and this suite is what proves the structure holds in a real process.
//
// Run (from desktop/): node test/e2e/data-root.e2e.mjs
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const IDENT = 'com.lataif.app.e2e';
const PROD_IDENT = 'com.lataif.app';
const CDP_PORT = 9223;
const PORT = 3011;

const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const PROD_DIR = join(REAL_APPDATA, PROD_IDENT);

const LOCATOR = join(APP_DATA_DIR, 'data-location.json');
const MARKER = join(APP_DATA_DIR, '.lataif-data-root.json');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');

const RUN = join(os.tmpdir(), 'lataif-dataroot-e2e', 'run-' + process.pid);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; } else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

let appProc = null;
function killApp() {
  if (!appProc) return;
  try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch {}
  appProc = null;
}

/** Start the app and wait for its CDP page. Throws if it never comes up. */
async function startApp(timeoutMs = 60000) {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: isoEnv() });
  appProc = spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  const deadline = Date.now() + timeoutMs;
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

/**
 * Start the app EXPECTING it to refuse. Returns true when no window ever appeared.
 * A refusal that merely takes a long time is not a refusal, so the window is generous but finite.
 */
async function startExpectingRefusal(waitMs = 22000) {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: isoEnv() });
  appProc = spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  let exited = false;
  appProc.on('exit', () => { exited = true; });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      if (list.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url))) return { started: true, exited };
    } catch { /* nothing listening — that is the expected shape */ }
    await sleep(500);
  }
  return { started: false, exited };
}

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
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const S = (v) => JSON.stringify(v);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function waitFor(c, sel, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error('waitFor timeout: ' + sel);
}

/** Walk a virgin install through onboarding so a REAL business database exists. */
async function onboard(c) {
  await waitFor(c, 'input, a[href="/settings"]', 60000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'DataRoot E2E');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'Root Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E User');
    await setVal(c, 'input[placeholder="you@company.com"]', 'e2e@user.local');
    await setVal(c, 'input[placeholder="Choose a password"]', 'e2epass123');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click();`);
  }
  await waitFor(c, 'a[href="/settings"], input[type="email"]', 40000);
}

// `ev` wraps the expression in a plain arrow function, so the promise is RETURNED and the CDP call
// awaits it (`awaitPromise: true`) — no `await` keyword inside.
const invokePaths = (c) => c.ev(`return window.__TAURI_INTERNALS__.invoke('get_runtime_paths', {});`);

async function main() {
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });

  // Production must be provably untouched by everything below.
  const prodBefore = {
    biz: existsSync(join(PROD_DIR, 'lataif.db')) ? statSync(join(PROD_DIR, 'lataif.db')).mtimeMs : 0,
    srv: existsSync(join(PROD_DIR, 'lataif_sync_server.db')) ? statSync(join(PROD_DIR, 'lataif_sync_server.db')).mtimeMs : 0,
    locator: existsSync(join(PROD_DIR, 'data-location.json')),
  };

  // ── §1 first start: bootstrap in place, then real data ────────────────────
  let ws = await startApp();
  let c = new CDP(ws);
  await onboard(c);

  ok(existsSync(LOCATOR), '1.1 locator written into the identifier AppData');
  ok(existsSync(MARKER), '1.2 marker written into the data root');
  let loc = readJson(LOCATOR); let mk = readJson(MARKER);
  ok(loc.schemaVersion === 1 && mk.schemaVersion === 1, '1.3 both files carry schema version 1');
  ok(loc.rootId && loc.rootId === mk.rootId, '1.4 locator and marker share one rootId');
  ok(mk.bootstrapPending === false, '1.5 the completed bootstrap left no pending flag');
  ok(loc.dataRoot.replace(/\\+$/, '') === APP_DATA_DIR, '1.6 the data root IS the legacy AppData folder');
  // NB: the production directory name is a PREFIX of the e2e one, so `includes` would always be
  // true here. The only honest check is an exact comparison against the production root.
  ok(loc.dataRoot.replace(/\+$/, '') !== PROD_DIR && loc.dataRoot.includes(IDENT),
    '1.7 the e2e locator points inside the e2e identifier, never at production');

  // The native resolver and the renderer agree, and every path is the legacy one.
  const paths = await invokePaths(c);
  ok(paths.dataRoot === APP_DATA_DIR, '1.8 get_runtime_paths reports the legacy root');
  ok(paths.businessDb === BIZ_DB, '1.9 business DB path is <root>\\lataif.db — unchanged');
  ok(paths.syncServerDb === SERVER_DB, '1.10 server DB path is <root>\\lataif_sync_server.db — unchanged');
  ok(paths.mediaRoot === join(APP_DATA_DIR, 'media'), '1.11 media root unchanged');
  ok(paths.mobileStagingRoot === join(APP_DATA_DIR, 'mobile-upload-staging'), '1.12 mobile staging unchanged');
  ok(paths.rootId === loc.rootId, '1.13 the renderer sees the same rootId as the files');
  ok(paths.backupsRoot === join(APP_DATA_DIR, 'backups'), '1.14 backups default to <root>\\backups, resolved separately');
  ok(existsSync(BIZ_DB) && statSync(BIZ_DB).size > 0, '1.15 a real business database exists');

  c.close(); killApp(); await sleep(1500);
  const dbAfterFirst = sha(BIZ_DB);
  const idFirst = loc.rootId;

  // ── §2 the UPGRADE case: no locator, no marker, real data present ─────────
  // This is byte-for-byte what a pre-0.8.43 installation looks like on disk.
  rmSync(LOCATOR, { force: true });
  rmSync(MARKER, { force: true });

  ws = await startApp(); c = new CDP(ws);
  await waitFor(c, 'a[href="/settings"], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 60000);
  ok(!(await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')),
    '2.1 the app did NOT fall back to an empty database (no onboarding wizard)');
  ok(existsSync(LOCATOR) && existsSync(MARKER), '2.2 the upgrade bootstrapped the pair in place');
  const loc2 = readJson(LOCATOR);
  ok(loc2.dataRoot.replace(/\\+$/, '') === APP_DATA_DIR, '2.3 it adopted the existing folder, it did not pick a new one');
  ok(loc2.rootId !== idFirst, '2.4 a fresh registration gets a fresh id (nothing is reused blindly)');
  ok(readJson(MARKER).rootId === loc2.rootId, '2.5 the new marker matches the new locator');
  ok(readJson(MARKER).businessDbExpected === true, '2.6 the marker records that a database was adopted');
  ok(sha(BIZ_DB) === dbAfterFirst, '2.7 THE SAME database file, byte for byte — nothing was moved or replaced');
  const p2 = await invokePaths(c);
  ok(p2.businessDb === BIZ_DB, '2.8 and the renderer opens exactly that file');

  c.close(); killApp(); await sleep(1500);

  // ── §3 idempotency ────────────────────────────────────────────────────────
  const locBytes = readFileSync(LOCATOR);
  const mkBytes = readFileSync(MARKER);
  ws = await startApp(); c = new CDP(ws);
  await waitFor(c, 'a[href="/settings"], input[type="email"]', 60000);
  ok(Buffer.compare(readFileSync(LOCATOR), locBytes) === 0, '3.1 restart rewrote nothing in the locator');
  ok(Buffer.compare(readFileSync(MARKER), mkBytes) === 0, '3.2 restart rewrote nothing in the marker');
  ok((await invokePaths(c)).rootId === loc2.rootId, '3.3 the rootId is stable across restarts');
  c.close(); killApp(); await sleep(1500);

  // ── §4 P1: the locator disappears AFTER registration ──────────────────────
  const savedLocator = join(RUN, 'saved-locator.json');
  copyFileSync(LOCATOR, savedLocator);
  rmSync(LOCATOR, { force: true });

  let r = await startExpectingRefusal();
  ok(!r.started, '4.1 a lost locator does NOT open the old data set — the app refuses to start');
  ok(r.exited, '4.1b the process exited rather than hanging on a dialog');
  ok(!existsSync(LOCATOR), '4.2 and it does not quietly re-register the folder');
  ok(sha(BIZ_DB) === dbAfterFirst, '4.3 the database is untouched by the refusal');
  killApp(); await sleep(1200);

  // A refusal has to be recoverable, or it is just a brick.
  copyFileSync(savedLocator, LOCATOR);
  ws = await startApp(); c = new CDP(ws);
  await waitFor(c, 'a[href="/settings"], input[type="email"]', 60000);
  ok((await invokePaths(c)).rootId === loc2.rootId, '4.4 restoring the locator brings the same root back');
  ok(sha(BIZ_DB) === dbAfterFirst, '4.5 with the same database');
  c.close(); killApp(); await sleep(1500);

  // ── §5 mismatch and corruption ────────────────────────────────────────────
  const goodMarker = readFileSync(MARKER);
  writeFileSync(MARKER, JSON.stringify({ ...readJson(MARKER), rootId: 'a-different-data-set' }, null, 2));
  r = await startExpectingRefusal();
  ok(!r.started, '5.1 a rootId that disagrees with the locator refuses to start');
  ok(r.exited, '5.1b and the process exits');
  ok(sha(BIZ_DB) === dbAfterFirst, '5.2 and touches nothing');
  killApp(); await sleep(1200);
  writeFileSync(MARKER, goodMarker);

  writeFileSync(LOCATOR, '{ this is not json');
  r = await startExpectingRefusal();
  ok(!r.started, '5.3 a corrupt locator refuses to start — no AppData fallback');
  ok(r.exited, '5.3b and the process exits');
  ok(sha(BIZ_DB) === dbAfterFirst, '5.4 and touches nothing');
  killApp(); await sleep(1200);
  copyFileSync(savedLocator, LOCATOR);

  // Positive control. "The app did not come up" is only evidence of a refusal if the app DOES come
  // up when the pair is intact — otherwise every one of the checks above would also pass on a
  // binary that cannot start at all.
  ws = await startApp(); c = new CDP(ws);
  await waitFor(c, 'a[href="/settings"], input[type="email"]', 60000);
  ok((await invokePaths(c)).rootId === loc2.rootId, '5.5 control: with the pair intact the app starts normally');
  ok(sha(BIZ_DB) === dbAfterFirst, '5.6 control: and the database is still the same one');
  c.close(); killApp(); await sleep(1200);

  // ── §6 production isolation, measured after everything above ──────────────
  const prodAfter = {
    biz: existsSync(join(PROD_DIR, 'lataif.db')) ? statSync(join(PROD_DIR, 'lataif.db')).mtimeMs : 0,
    srv: existsSync(join(PROD_DIR, 'lataif_sync_server.db')) ? statSync(join(PROD_DIR, 'lataif_sync_server.db')).mtimeMs : 0,
    locator: existsSync(join(PROD_DIR, 'data-location.json')),
  };
  ok(prodAfter.biz === prodBefore.biz, '6.1 the production business DB was never modified');
  ok(prodAfter.srv === prodBefore.srv, '6.2 the production server DB was never modified');
  ok(prodAfter.locator === prodBefore.locator, '6.3 no locator was written into the production identifier');
  ok(readJson(LOCATOR).dataRoot.replace(/\\+$/, '') !== PROD_DIR,
    '6.4 the e2e locator names no production path');

  console.log(`\nDATA-ROOT-I1 B1 e2e: ${PASS} passed, ${FAIL} failed`);
}

main()
  .catch((e) => { console.error('E2E ERROR:', e?.message || e); FAIL++; })
  .finally(() => {
    killApp();
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
    try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
    if (fails.length) { console.log('\nfailed:'); for (const f of fails) console.log('  - ' + f); }
    process.exit(FAIL > 0 ? 1 : 0);
  });
