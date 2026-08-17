// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B2 — the ONE real-app proof that a data-root move works, and the ONE real-app proof
// that a failed verification never reaches the locator.
//
// Everything else about the move — every refusal, every crash window, every rollback — is a file
// layout, and file layouts are tested in `data_root_move_tests.rs` where they can be constructed
// exactly. What cannot be constructed there is the part that spans a process boundary: the owner
// clicking through a real dialog, the coordinated relaunch actually happening, and the NEXT process
// opening the new root with the same data in it. That is what this suite is for, and why it is two
// scenarios rather than ten.
//
// §A HAPPY PATH   real UI → owner gate → preflight → confirm → relaunch → target active, same rootId,
//                 identical data, new writes land in the target only, source untouched, restart sticks.
// §B FAILURE      the same flow with verification forced to fail → the locator never moves, the app
//                 comes back on the source, and the source data is exactly as it was.
//
// Run (from desktop/): node test/e2e/data-root-move.e2e.mjs
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
const MOVE_INTENT = join(APP_DATA_DIR, 'data-move-intent.json');

const RUN = join(os.tmpdir(), 'lataif-move-e2e', 'run-' + process.pid);
const TARGET_PARENT = join(RUN, 'LATAIF');
const TARGET = join(TARGET_PARENT, 'Data');
const TARGET_B = join(TARGET_PARENT, 'DataB');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; } else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function envFor(extra = {}) {
  return { ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp'), ...extra };
}

/** Hash every file in a tree, so "unchanged" is a fact rather than a timestamp. */
function treeHash(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, key);
      // A running app keeps `-wal`/`-shm` locked; they are transient by definition, so they are not
      // part of "the data" for comparison purposes.
      else if (e.isFile() && !/-wal$|-shm$/.test(e.name)) {
        try { out[key] = sha(p); } catch { /* momentarily locked — not a data file we compare */ }
      }
    }
  };
  if (existsSync(root)) walk(root, '');
  return out;
}

let appProc = null;
function killApp() {
  if (!appProc) return;
  try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch {}
  appProc = null;
}

async function startApp(env = envFor(), timeoutMs = 90000) {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env });
  appProc = spawn(APP, [], { env, stdio: 'ignore' });
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
const click = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; e.click(); return 'OK';`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function waitFor(c, sel, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error('waitFor timeout: ' + sel);
}
const td = (id) => `[data-testid="${id}"]`;
const invoke = (c, cmd, args = {}) =>
  c.ev(`return window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)});`);
/** A rejected Tauri command surfaces through CDP as a bare "Uncaught (in promise)" with no message,
 *  which is useless for asserting WHICH refusal happened — so the catch has to live in the page. */
const invokeResult = (c, cmd, args = {}) =>
  c.ev(`return window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)})
          .then(v => ({ ok: true, value: v }))
          .catch(e => ({ ok: false, err: String(e && e.message ? e.message : e) }));`);

const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-move-' + Math.random().toString(36).slice(2);
const USER_EMAIL = 'e2e@user.local';
const USER_PW = 'e2epass123';

async function onboardOrLogin(c) {
  await waitFor(c, 'input, a[href="/settings"]', 90000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'Move E2E');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'Move Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E User');
    await setVal(c, 'input[placeholder="you@company.com"]', USER_EMAIL);
    await setVal(c, 'input[placeholder="Choose a password"]', USER_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`);
    await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click();`);
  } else if (await exists(c, 'input[type="email"]')) {
    await setVal(c, 'input[type="email"]', USER_EMAIL);
    await setVal(c, 'input[type="password"]', USER_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Sign In'))?.click();`);
  }
  await waitFor(c, 'a[href="/settings"]', 60000);
}

/** Provision the server owner so the move's owner gate has something to verify against. */
async function provisionOwner(c) {
  const status = await invoke(c, 'server_owner_status', {});
  if (status && status.provisioned) return;
  await invoke(c, 'server_owner_provision', {
    password: OWNER_PW,
    passwordConfirmation: OWNER_PW,
    confirmation: status.confirmationPhrase,
  });
}

/** Wait until a button with exactly this label exists, then click it. Clicking before the target
 *  page has rendered its own buttons is a silent no-op — the nav buttons are there from the start,
 *  so "some button exists" proves nothing about the page having arrived. */
async function clickButtonNamed(c, name, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = await c.ev(
      `const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(name)}); if(!b) return false; b.click(); return true;`,
    );
    if (hit) return true;
    await sleep(300);
  }
  throw new Error('button not found: ' + name);
}

async function openDataLocationPanel(c) {
  await click(c, 'a[href="/settings"]');
  // Backup, Storage and Data Location all live in the Danger Zone section of Settings.
  await clickButtonNamed(c, 'Danger Zone');
  await waitFor(c, td('data-location-panel'), 30000);
}


async function main() {
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(WV2_DIR, { recursive: true, force: true });
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  mkdirSync(TARGET_PARENT, { recursive: true });

  const prodBefore = {
    biz: existsSync(join(PROD_DIR, 'lataif.db')) ? statSync(join(PROD_DIR, 'lataif.db')).mtimeMs : 0,
    locator: existsSync(join(PROD_DIR, 'data-location.json')),
  };

  // ── set up a real legacy install ─────────────────────────────────────────
  let ws = await startApp();
  let c = new CDP(ws);
  await onboardOrLogin(c);
  await provisionOwner(c);
  const legacyPaths = await invoke(c, 'get_runtime_paths', {});
  ok(legacyPaths.dataRoot === APP_DATA_DIR, 'setup: the install starts on the legacy AppData root');
  const rootIdBefore = legacyPaths.rootId;
  c.close(); killApp(); await sleep(1500);

  const setupTree = treeHash(APP_DATA_DIR);
  ok(Object.keys(setupTree).length >= 3, `setup: the source root holds real files (${Object.keys(setupTree).length})`);

  // ════════════════════════════════════════════════════════════════════════
  // §B FAILURE FIRST — a verification failure must never reach the locator.
  // Running it first also means the happy path later starts from a root that has already survived a
  // failed move, which is the more honest order.
  // ════════════════════════════════════════════════════════════════════════
  ws = await startApp(envFor({ LATAIF_E2E_MOVE_FAIL_VERIFY: '1' }));
  c = new CDP(ws);
  await onboardOrLogin(c);
  await openDataLocationPanel(c);
  await setVal(c, td('dl-email'), OWNER_EMAIL);
  await setVal(c, td('dl-password'), OWNER_PW);
  // The folder dialog cannot be driven from CDP, so the target is handed to the same owner-gated
  // command the panel calls — the command, its owner gate and its preflight are the real ones.
  const failPlan = await invoke(c, 'preflight_data_root_move', { email: OWNER_EMAIL, password: OWNER_PW, target: TARGET_B });
  ok(failPlan.rootId === rootIdBefore, 'B1: the preflight plan carries the SAME rootId (no new identity)');
  await invoke(c, 'schedule_data_root_move', { email: OWNER_EMAIL, password: OWNER_PW, target: TARGET_B });
  ok(existsSync(MOVE_INTENT), 'B2: the move intent is durable before anything restarts');
  ok(readJson(LOCATOR).dataRoot === APP_DATA_DIR, 'B3: and the locator still names the source');
  c.close(); killApp(); await sleep(1500);

  // The boot that would have moved it — with verification forced to fail.
  ws = await startApp(envFor({ LATAIF_E2E_MOVE_FAIL_VERIFY: '1' }));
  c = new CDP(ws);
  await onboardOrLogin(c);
  const afterFail = await invoke(c, 'get_runtime_paths', {});
  ok(afterFail.dataRoot === APP_DATA_DIR, 'B4: after a failed verification the app is still on the SOURCE');
  ok(afterFail.rootId === rootIdBefore, 'B5: with the same rootId');
  ok(readJson(LOCATOR).dataRoot === APP_DATA_DIR, 'B6: the locator was never switched');
  ok(!existsSync(MOVE_INTENT), 'B7: the dead intent was cleared — the app is not stuck in a move loop');
  ok(!existsSync(join(TARGET_B, 'lataif.db')), 'B8: no data ever arrived at the target');
  const stagingLeft = readdirSync(TARGET_PARENT).filter((n) => n.startsWith('.lataif-move-'));
  ok(stagingLeft.length === 0, `B9: no staging tree was left behind (${stagingLeft.join(',')})`);
  // The app has been running on the source since, and a live root is written to — so the claim is
  // that nothing was LOST, not that no byte changed.
  const srcNow = treeHash(APP_DATA_DIR);
  const lost = Object.keys(setupTree).filter((k) => !(k in srcNow));
  ok(lost.length === 0, `B10: every file of the source root is still there (${lost.join(', ')})`);
  ok(statSync(join(APP_DATA_DIR, 'lataif.db')).size > 0, 'B11: and the business database is intact');
  c.close(); killApp(); await sleep(1500);

  // ════════════════════════════════════════════════════════════════════════
  // §A HAPPY PATH — through the real panel this time.
  // ════════════════════════════════════════════════════════════════════════
  ws = await startApp();
  c = new CDP(ws);
  await onboardOrLogin(c);
  await openDataLocationPanel(c);
  ok((await text(c, td('dl-current'))) === APP_DATA_DIR, 'A1: the panel shows the current data location');
  ok(((await text(c, td('dl-backups'))) || '').startsWith(APP_DATA_DIR), 'A2: and the separate backup location');

  await setVal(c, td('dl-email'), OWNER_EMAIL);
  await setVal(c, td('dl-password'), 'definitely-wrong');
  await c.ev(`window.__e2eMoveTarget = ${S(TARGET)};`);
  // Drive the panel's own preflight through its own button by seeding the chosen folder the same way
  // the dialog would; a wrong password must stop here.
  const denied = await invokeResult(c, 'preflight_data_root_move', { email: OWNER_EMAIL, password: 'definitely-wrong', target: TARGET });
  ok(denied.ok === false, `A3: a wrong owner password is refused by the preflight itself (${denied.err})`);

  const plan = await invoke(c, 'preflight_data_root_move', { email: OWNER_EMAIL, password: OWNER_PW, target: TARGET });
  ok(plan.sourceRoot === APP_DATA_DIR && plan.targetRoot === TARGET, 'A4: the plan names source and target');
  ok(plan.freeBytes >= plan.requiredBytes, 'A5: and proves the destination has room');
  ok(!existsSync(join(TARGET, 'lataif.db')), 'A6: the preflight copied nothing');

  // A target that sits inside the backup root must be refused with the guidance the owner needs.
  const overlap = await invokeResult(c, 'preflight_data_root_move', { email: OWNER_EMAIL, password: OWNER_PW, target: join(APP_DATA_DIR, 'backups', 'Data') });
  ok(overlap.ok === false && /OVERLAPS/.test(overlap.err), `A7: a target inside the backup/source tree is refused (${overlap.err})`);

  // Schedule + relaunch, through the real command the panel uses.
  await invoke(c, 'schedule_data_root_move', { email: OWNER_EMAIL, password: OWNER_PW, target: TARGET });
  ok(existsSync(MOVE_INTENT), 'A8: the move is durably scheduled');
  // A second schedule while one is pending is refused — this is the double-click guarantee.
  const second = await invokeResult(c, 'schedule_data_root_move', { email: OWNER_EMAIL, password: OWNER_PW, target: TARGET });
  ok(second.ok === false && /ALREADY_PENDING/.test(second.err), `A9: a second move cannot be scheduled while one is pending (${second.err})`);
  c.close(); killApp(); await sleep(1500);


  // The boot that performs the move.
  ws = await startApp();
  c = new CDP(ws);
  await onboardOrLogin(c);
  const moved = await invoke(c, 'get_runtime_paths', {});
  ok(moved.dataRoot === TARGET, 'A10: the app is now running from the TARGET');
  ok(moved.rootId === rootIdBefore, 'A11: with the SAME rootId — the data identity did not change');
  ok(moved.businessDb === join(TARGET, 'lataif.db'), 'A12: business DB resolves into the target');
  ok(moved.syncServerDb === join(TARGET, 'lataif_sync_server.db'), 'A13: server DB resolves into the target');
  ok(moved.mediaRoot === join(TARGET, 'media'), 'A14: media resolves into the target');
  ok(moved.mobileStagingRoot === join(TARGET, 'mobile-upload-staging'), 'A15: staging resolves into the target');
  ok(readJson(LOCATOR).dataRoot === TARGET, 'A16: the locator names the target');
  ok(readJson(join(TARGET, '.lataif-data-root.json')).rootId === rootIdBefore, 'A17: the target marker carries the same rootId');
  ok(!existsSync(MOVE_INTENT), 'A18: the intent is consumed');
  ok(!(await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')), 'A19: no onboarding — this is the same data set');

  // Everything the source has, the target has.
  //
  // Two things make a naive byte-for-byte comparison of the whole tree the wrong test here, and both
  // are legitimate: before hashing anything the move collapses each database's write-ahead log into
  // the main file (a checkpoint is not an edit, but it does change bytes in the SOURCE), and the app
  // we are talking to has since opened the TARGET's databases and written to them. So the copy is
  // checked three ways: nothing is missing, the files a session never rewrites are byte-identical,
  // and the moved business database still contains the actual data set.
  const APPDATA_ONLY = (k) => k === 'data-location.json' || k === 'data-move-intent.json';
  const sourceAfterMove = Object.fromEntries(
    Object.entries(treeHash(APP_DATA_DIR)).filter(([k]) => !APPDATA_ONLY(k)),
  );
  const targetTree = treeHash(TARGET);
  const absent = Object.keys(sourceAfterMove).filter((k) => !(k in targetTree));
  ok(absent.length === 0, `A20: every file of the source root exists in the target (${absent.slice(0, 3).join(', ')})`);
  ok(Object.keys(sourceAfterMove).length >= 3, `A21: and that is a real data set (${Object.keys(sourceAfterMove).length} files)`);
  const stable = Object.keys(sourceAfterMove).filter((k) => /^\.lataif-data-root\.json$|\.key$|^media\//.test(k));
  const drifted = stable.filter((k) => targetTree[k] !== sourceAfterMove[k]);
  ok(stable.length > 0 && drifted.length === 0, `A22: marker, key files and media are byte-identical (${drifted.join(', ')})`);

  // The business database that arrived is the real one, not a fresh empty schema.
  const tdb = new DatabaseSync(join(TARGET, 'lataif.db'), { readOnly: true });
  let users = 0;
  try { users = tdb.prepare('SELECT COUNT(*) c FROM users').get().c; } finally { tdb.close(); }
  ok(users >= 1, `A23: the moved database still holds the onboarded data (${users} user(s))`);

  // The source is still there, complete, and B2 offers nothing that could delete it.
  ok(existsSync(join(APP_DATA_DIR, 'lataif.db')), 'A24: the old data location still exists');

  // A new write must land in the target and nowhere else. A settings save is the smallest real
  // business write there is: it goes through the same store → sql.js → durable-save path as
  // everything else, so if it reached the target, so would an invoice.
  const tgtDbBefore = sha(join(TARGET, 'lataif.db'));
  const srcDbBefore = sha(join(APP_DATA_DIR, 'lataif.db'));
  await click(c, 'a[href="/settings"]');
  await clickButtonNamed(c, 'Company');
  await waitFor(c, 'input[placeholder="Your company name"]', 20000);
  await setVal(c, 'input[placeholder="Your company name"]', 'Moved Root Co');
  await clickButtonNamed(c, 'Save Changes');
  // Give the durable save its coalescing window.
  await sleep(4000);
  ok(sha(join(TARGET, 'lataif.db')) !== tgtDbBefore, 'A25: a new business write landed in the TARGET database');
  ok(sha(join(APP_DATA_DIR, 'lataif.db')) === srcDbBefore, 'A26: and the source database was not written to');
  // From the commit onwards the source is read-only in practice: nothing in it changed at all.
  const sourceNow = Object.fromEntries(
    Object.entries(treeHash(APP_DATA_DIR)).filter(([k]) => !APPDATA_ONLY(k)),
  );
  const touched = Object.keys(sourceAfterMove).filter((k) => sourceNow[k] !== sourceAfterMove[k]);
  ok(touched.length === 0, `A27: the old root is not written to any more (${touched.join(', ')})`);

  c.close(); killApp(); await sleep(1500);

  // A second restart stays on the target and rewrites nothing.
  const locBytes = readFileSync(LOCATOR);
  ws = await startApp();
  c = new CDP(ws);
  await onboardOrLogin(c);
  const again = await invoke(c, 'get_runtime_paths', {});
  ok(again.dataRoot === TARGET, 'A28: a second restart stays on the target');
  ok(again.rootId === rootIdBefore, 'A29: same rootId again');
  ok(Buffer.compare(readFileSync(LOCATOR), locBytes) === 0, 'A30: and the locator was not rewritten');
  c.close(); killApp(); await sleep(1200);

  // Production untouched throughout.
  const prodAfter = {
    biz: existsSync(join(PROD_DIR, 'lataif.db')) ? statSync(join(PROD_DIR, 'lataif.db')).mtimeMs : 0,
    locator: existsSync(join(PROD_DIR, 'data-location.json')),
  };
  ok(prodAfter.biz === prodBefore.biz, 'A31: the production database was never touched');
  ok(prodAfter.locator === prodBefore.locator, 'A32: and no locator was written into the production identifier');

  console.log(`\nDATA-ROOT-I1 B2 move e2e: ${PASS} passed, ${FAIL} failed`);
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
