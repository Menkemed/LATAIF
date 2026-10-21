// v0.8.85 RELEASE GATE — Backup/Restore with the PRODUCT-LEFTOVERS cleanup, end to end, fully isolated.
//
// The real chain, no shortcut:
//   A1  four items arrive as REAL phone uploads over the REAL socket (POST /api/mobile/upload) and the app's OWN
//       drain creates them (receipt + gallery + ready job). Two of them carry the SAME photo bytes, so they share
//       one stored file.
//   A2  two items are deleted the way v0.8.84 deleted (row gone, delete logged, receipt + photo links LEFT), and
//       one job is put back to `accepted` — the state a crash between "item created" and "ready" leaves behind.
//       Then the REAL app starts: the startup cleanup runs, the drain claims the stuck job — and must refuse it.
//   A3  a second start changes nothing (idempotent).
//   A4  a backup with the REAL snapshot host (the same `collect_selection_from_db` + `snapshot` the app's boot
//       backup runs): the orphaned photo is NOT in it, the shared photo IS, both databases are.
//   B   a FRESH isolated data folder (only the install identity carried over, as on the same machine), restored
//       with the REAL restore host (the same `restore()` the app's boot restore runs). Then the real app again:
//       the phone re-sends the deleted item (same event = replay; new event for the same item = refused), a new
//       item still goes through, and a second start changes nothing.
//
// Isolated: e2e identifier `com.lataif.app.e2e`, isolated AppData, sync port 3011, ephemeral owner secret
// (never printed). Only processes this suite started are stopped. The production install, its data folder and
// its backups are never opened. Pure Node CDP + fetch + node:sqlite.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killTestImage, waitTestImageGone } from './_e2e-process.mjs';
import { mkdirSync, rmSync, existsSync, statSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223;
const PORT = 3011;
const HTTP = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';
const TENANT = 'tenant-1';
const BRANCH = 'branch-main';
const CAT = 'cat-watch';

const RUN = join(os.tmpdir(), 'lataif-0885-gate', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
// Production — only its modification time is read, it is never opened.
const PROD_APPDATA_SERVER = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (...args) => execFileSync(SEED, args, { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ── REQUIRED (what a backup carries), read from the Rust SSOT, not copied ─────────────────────────────────────
const RUST = readFileSync(join(REPO, 'src-tauri', 'src', 'media', 'reachability.rs'), 'utf8');
function rustConst(name) {
  const m = new RegExp(`pub const ${name}: &str = "((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(RUST);
  if (!m) throw new Error(`${name} not found in reachability.rs`);
  return m[1].replace(/\\\r?\n\s*/g, '');
}
const REQUIRED_SQL = [rustConst('REQUIRED_MASTER_SQL'), rustConst('REQUIRED_VARIANT_SQL')];

// ── isolated DB access (the app is stopped whenever these run) ───────────────────────────────────────────────
function withDb(path, fn, readOnly = true) { const db = new DatabaseSync(path, { readOnly }); try { return fn(db); } finally { db.close(); } }
const biz = (sql, p = []) => withDb(BIZ_DB, (db) => db.prepare(sql).all(...p));
const srv = (sql, p = []) => withDb(SERVER_DB, (db) => db.prepare(sql).all(...p));
const n = (rows) => Number(Object.values(rows[0] ?? { x: -1 })[0]);
const required = () => new Set(withDb(BIZ_DB, (db) => REQUIRED_SQL.flatMap((s) => db.prepare(s).all().map((r) => String(r.stored_blob_hash)))));
/** The stored file hashes (master + variants) of an item's photos, active or removed links alike. */
const photoHashes = (id) => biz(`SELECT DISTINCT g.stored_blob_hash h FROM media_links l
    JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
    JOIN media_blobs b ON b.tenant_id = o.tenant_id AND (b.blob_id = o.master_blob_id OR b.blob_id IN (SELECT v.blob_id FROM media_variants v WHERE v.tenant_id = o.tenant_id AND v.media_id = o.media_id))
    JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
   WHERE l.entity_type = 'product' AND l.entity_id = ?`, [id]).map((r) => String(r.h));
const masterBlob = (id) => biz(`SELECT o.master_blob_id b FROM media_links l JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
   WHERE l.entity_type = 'product' AND l.entity_id = ? ORDER BY l.sort_order LIMIT 1`, [id])[0]?.b ?? null;
const exists = (id) => n(biz(`SELECT COUNT(*) c FROM products WHERE id = ?`, [id])) === 1;
const receipts = (id) => n(biz(`SELECT COUNT(*) c FROM mobile_upload_receipts WHERE product_id = ?`, [id]));
const activeLinks = (id) => n(biz(`SELECT COUNT(*) c FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NULL`, [id]));
const allLinks = (id) => n(biz(`SELECT COUNT(*) c FROM media_links WHERE entity_type = 'product' AND entity_id = ?`, [id]));
const job = (entity) => srv(`SELECT upload_event_id ev, state, error_code err, product_id FROM mobile_upload_inbox WHERE entity_id = ? ORDER BY created_at, upload_event_id`, [entity]);
const fileOnDisk = (h) => { for (const ext of ['jpg', 'jpeg', 'png', 'webp']) if (existsSync(join(MEDIA_ROOT, TENANT, h.slice(0, 2), `${h}.${ext}`))) return true; return false; };
/** Everything the cleanup may touch, plus the items and jobs — must not move on a second start. */
function digest() {
  const rows = [
    biz(`SELECT id FROM products ORDER BY id`),
    biz(`SELECT link_id, entity_id, deleted_at, is_primary FROM media_links ORDER BY link_id`),
    biz(`SELECT upload_event_id, product_id FROM mobile_upload_receipts ORDER BY upload_event_id`),
    biz(`SELECT media_id, master_blob_id, deleted_at FROM media_objects ORDER BY media_id`),
    biz(`SELECT blob_id, generation_no, gen_status FROM media_blob_generations ORDER BY blob_id, generation_no`),
    biz(`SELECT record_id, action FROM sync_changelog WHERE table_name = 'products' ORDER BY id`),
    biz(`SELECT entity_id FROM audit_log WHERE entity_type = 'products' AND action_type = 'DELETE' ORDER BY entity_id`),
    srv(`SELECT upload_event_id, state, error_code, product_id FROM mobile_upload_inbox ORDER BY upload_event_id`),
  ];
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

// ── app process + CDP ─────────────────────────────────────────────────────────────────────────────────────────
async function attach(notId = null, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl && t.id !== notId);
      if (page) { const c = new CDP(page.webSocketDebuggerUrl); c.pageId = page.id; await waitInvoke(c); return c; }
    } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error('app CDP page did not come up');
}
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: isoEnv() });
  spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  return attach();
}
// Only processes at the exact path of the test build — also the one the app relaunched itself into.
async function stopApp(c) { try { c?.close(); } catch {} killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe'); await sleep(1500); }
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
const has = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function waitFor(c, sel, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await has(c, sel)) return true; await sleep(300); } throw new Error('waitFor timeout: ' + sel); }
async function invoke(c, cmd, args) { return c.ev(`return (async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return { ok:true, value: v===undefined?null:v }; } catch (e) { return { ok:false, error: String((e && e.message) || e) }; } })();`); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
async function waitHttpHealthy() {
  const end = Date.now() + 40000;
  while (Date.now() < end) { try { const r = await fetch(`${HTTP}/api/health`, { signal: AbortSignal.timeout(2500) }); if (r.ok) return; } catch { /* not up */ } await sleep(500); }
  throw new Error(`embedded HTTP server never became healthy on ${PORT}`);
}
// First run → the first-run gate ("Set up new installation", the app relaunches) → onboarding; afterwards
// (onboarding persisted, also in a restored DB) → the login screen. Returns the live CDP connection.
async function frontendLogin(c) {
  const START = '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"], a[href="/settings"]';
  try { await waitFor(c, START, 90000); }
  catch (e) { console.log('SCREEN: ' + JSON.stringify(await c.ev('return document.body ? document.body.innerText.slice(0, 300) : null').catch(() => null))); throw e; }
  // The session survives a restart (WebView storage) — already signed in.
  if (!(await has(c, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]'))) return c;
  if (await has(c, '[data-first-run-new]')) {
    await c.ev(`document.querySelector('[data-first-run-new]').click();`);
    const old = c.pageId; c.close();
    await sleep(2500);
    c = await attach(old);
    await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  }
  if (await has(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
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
  return c;
}
async function serverToken() {
  const r = await fetch(`${HTTP}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) });
  if (!r.ok) throw new Error('server login failed: ' + r.status);
  return (await r.json()).token;
}
async function upload(token, event, entity, imgB64, meta) {
  const body = { protocol_version: 1, upload_event_id: event, entity_id: entity, mode: 'collection', metadata: meta, images: [{ mime: 'image/jpeg', data_base64: imgB64 }] };
  const r = await fetch(`${HTTP}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
/** Polls the server inbox (read-only, WAL) until every listed entity's newest job is in a final state. */
async function waitJobs(entities, timeoutMs = 90000, kick = null) {
  const end = Date.now() + timeoutMs; let kicked = !kick;
  while (Date.now() < end) {
    if (!kicked && Date.now() > end - timeoutMs / 2) { kicked = true; await kick(); }
    const states = entities.map((e) => job(e).at(-1)?.state);
    if (states.every((s) => s === 'ready' || s === 'quarantined' || s === 'conflict')) return states;
    await sleep(1000);
  }
  return entities.map((e) => job(e).at(-1)?.state);
}
// A reload re-fires the post-auth drain (the poller would get there too; this only shortens the wait).
async function relogin(c) { await c.ev('window.location.reload();').catch(() => {}); await sleep(3000); const old = c.pageId; c.close(); const n = await attach(); return frontendLogin(n).catch(() => n); }
const prodSnapshot = () => ({ server: existsSync(PROD_APPDATA_SERVER) ? statSync(PROD_APPDATA_SERVER).mtimeMs : 0 });

async function main() {
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true }); mkdirSync(join(RUN, 'backups'), { recursive: true });
  ok(APP_DATA_DIR.endsWith(IDENT) && APP_DATA_DIR.startsWith(REAL_APPDATA), `the suite's data folder is the isolated one (${IDENT})`);
  const prodBefore = prodSnapshot();

  // ── A1 · four items as real phone uploads ─────────────────────────────────────────────────────────────────
  ok(seed('seed-primary', SERVER_DB) === 'SEED_PRIMARY_OK', 'A1: isolated server seeded as Primary (owner)');
  const imgShared = seed('jpeg', '1'), imgKeep = seed('jpeg', '2'), imgOrphan = seed('jpeg', '3'), imgNew = seed('jpeg', '4');
  let c = await startApp();
  c = await frontendLogin(c);
  await waitHttpHealthy();
  const token = await serverToken();
  const items = [
    { id: 'p-del-1', ev: 'ev-del-1', img: imgOrphan, brand: 'Orphan' },  // deleted; its photo is its own
    { id: 'p-del-2', ev: 'ev-del-2', img: imgShared, brand: 'Twin' },    // deleted; its photo is ALSO p-share's
    { id: 'p-share', ev: 'ev-share', img: imgShared, brand: 'Share' },   // stays; same bytes as p-del-2
    { id: 'p-keep', ev: 'ev-keep', img: imgKeep, brand: 'Keep' },        // stays
  ];
  for (const it of items) {
    const r = await upload(token, it.ev, it.id, it.img, { brand: it.brand, name: `${it.brand} Model`, categoryId: CAT });
    ok(r.status === 201 && r.body?.state === 'accepted', `A1: upload ${it.id} accepted (${r.status} ${r.body?.state})`);
  }
  const cfg = await invoke(c, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'A1: owner configured the runtime binding');
  const st1 = await waitJobs(items.map((i) => i.id), 120000, async () => { c = await relogin(c); });
  ok(st1.every((s) => s === 'ready'), `A1: the app's own drain created all four (${st1.join(',')})`);
  await sleep(3000);
  await stopApp(c);
  ok(items.every((i) => exists(i.id) && receipts(i.id) === 1 && activeLinks(i.id) === 1), 'A1: each item has its receipt and one active photo link');
  const sharedBlob = masterBlob('p-share');
  ok(sharedBlob && sharedBlob === masterBlob('p-del-2') && masterBlob('p-del-1') !== sharedBlob, 'A1: p-del-2 and p-share share one stored file; p-del-1 has its own');
  const orphanHashes = photoHashes('p-del-1').filter((h) => !photoHashes('p-share').includes(h) && !photoHashes('p-keep').includes(h));
  const sharedHashes = photoHashes('p-share');
  const keepHashes = photoHashes('p-keep');
  ok(orphanHashes.length >= 1 && sharedHashes.length >= 1 && keepHashes.length >= 1, `A1: photo files known (orphan ${orphanHashes.length}, shared ${sharedHashes.length}, keep ${keepHashes.length})`);

  // ── A2 · delete as v0.8.84 did; one job stuck before `ready`; then the real start ───────────────────────────
  const now = new Date().toISOString();
  withDb(BIZ_DB, (db) => {
    for (const id of ['p-del-1', 'p-del-2']) {
      db.prepare(`DELETE FROM products WHERE id = ?`).run(id);
      db.prepare(`INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES ('products', ?, ?, 'delete', '{}', 0, ?)`).run(id, BRANCH, now);
      db.prepare(`INSERT INTO audit_log (id, branch_id, module, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by, changed_at) VALUES (?, ?, 'Product', 'products', ?, 'DELETE', NULL, NULL, NULL, 'user-owner', ?)`).run(randomUUID(), BRANCH, id, now);
    }
  }, false);
  withDb(SERVER_DB, (db) => {
    db.prepare(`UPDATE mobile_upload_inbox SET state = 'accepted', product_id = NULL, error_code = NULL, updated_at = ? WHERE entity_id = 'p-del-1'`).run(now);
    db.prepare(`DELETE FROM mobile_upload_claim WHERE upload_event_id = 'ev-del-1'`).run();
  }, false);
  ok(!exists('p-del-1') && !exists('p-del-2') && receipts('p-del-1') === 1 && receipts('p-del-2') === 1 && activeLinks('p-del-1') === 1 && activeLinks('p-del-2') === 1,
    'A2: state as v0.8.84 left it — items gone, receipts and active photo links still there');
  const reqBefore = required();
  ok(orphanHashes.every((h) => reqBefore.has(h)), 'A2 negative control: BEFORE the cleanup the deleted item\'s own photo counts as required (would go into every backup)');
  ok(job('p-del-1')[0]?.state === 'accepted', 'A2: the deleted item\'s job is claimable again (crash before ready)');

  c = await startApp();
  c = await frontendLogin(c);
  const st2 = await waitJobs(['p-del-1']);
  await sleep(4000);
  await stopApp(c);
  const j1 = job('p-del-1');
  ok(j1.length === 1 && st2[0] === 'quarantined' && j1[0].err === 'MOBILE_UPLOAD_TARGET_DELETED',
    `A2: the drain refused the stuck job of the deleted item (${j1.map((j) => `${j.state}/${j.err}`).join(',')})`);
  ok(!exists('p-del-1') && !exists('p-del-2'), 'A2: neither deleted item was created again');
  ok(receipts('p-del-1') === 0 && receipts('p-del-2') === 0 && activeLinks('p-del-1') === 0 && activeLinks('p-del-2') === 0
    && allLinks('p-del-1') === 1 && allLinks('p-del-2') === 1, 'A2: startup cleanup removed both receipts and marked their photo links removed (not deleted)');
  ok(receipts('p-share') === 1 && receipts('p-keep') === 1 && activeLinks('p-share') === 1 && activeLinks('p-keep') === 1, 'A2: the kept items keep receipt and active photo');
  const reqAfter = required();
  ok(orphanHashes.every((h) => !reqAfter.has(h)), 'A2: the deleted item\'s own photo no longer counts as required');
  ok(sharedHashes.every((h) => reqAfter.has(h)) && keepHashes.every((h) => reqAfter.has(h)), 'A2: the shared photo (still used by p-share) and p-keep\'s photo stay required');
  ok(orphanHashes.every(fileOnDisk) && sharedHashes.every(fileOnDisk), 'A2: no photo file was deleted from disk');
  ok(['p-share', 'p-keep'].every((e) => job(e)[0]?.state === 'ready') && job('p-del-2')[0]?.state === 'ready', 'A2: the other jobs are untouched (ready)');

  // ── A3 · a second start changes nothing ────────────────────────────────────────────────────────────────────
  const dA = digest();
  c = await startApp(); c = await frontendLogin(c); await sleep(8000); await stopApp(c);
  ok(digest() === dA, 'A3: second start — items, photo links, receipts, media rows, delete records and jobs unchanged (idempotent)');

  // ── A4 · backup with the real snapshot host ───────────────────────────────────────────────────────────────
  const snap = join(RUN, 'backups', 'snap-gate');
  const out = seed('backup', APP_DATA_DIR, snap, new Date().toISOString());
  ok(/^BACKUP_OK files=\d+ additional=1 status=complete$/.test(out), `A4: real backup published, both databases (${out})`);
  const manifest = JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8'));
  const inBackup = new Set(manifest.files.map((f) => String(f.hash)));
  ok(orphanHashes.every((h) => !inBackup.has(h)), 'A4: the orphaned photo of the deleted item is NOT in the backup');
  ok(sharedHashes.every((h) => inBackup.has(h)) && keepHashes.every((h) => inBackup.has(h)), 'A4: the shared photo and p-keep\'s photo ARE in the backup');
  ok(manifest.db.fileName === 'lataif.db' && manifest.additionalDbFiles.length === 1 && manifest.additionalDbFiles[0].fileName === 'lataif_sync_server.db',
    'A4: the backup holds the main and the server database');
  ok(manifest.files.every((f) => existsSync(join(snap, f.relPath)) && sha256(join(snap, f.relPath)) === f.hash), 'A4: every backed-up photo file matches its hash');

  // ── B · fresh isolated data folder, real restore, real app ────────────────────────────────────────────────
  const identity = join(RUN, 'identity'); mkdirSync(identity, { recursive: true });
  // The installation's identity and location files (top-level files that are not a database) — never a database,
  // never media: everything that is data comes from the backup.
  const carried = readdirSync(APP_DATA_DIR, { withFileTypes: true }).filter((e) => e.isFile() && !/^lataif(_sync_server)?\.db/.test(e.name)).map((e) => e.name);
  for (const f of carried) copyFileSync(join(APP_DATA_DIR, f), join(identity, f));
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  for (const f of carried) copyFileSync(join(identity, f), join(APP_DATA_DIR, f));
  ok(!existsSync(BIZ_DB) && !existsSync(SERVER_DB) && !existsSync(MEDIA_ROOT), `B: fresh data folder — no database, no media (identity carried: ${carried.join(', ') || 'none'})`);
  const rout = seed('restore', APP_DATA_DIR, snap);
  ok(/^RESTORE_OK files=\d+ status=complete$/.test(rout), `B: real restore completed (${rout})`);
  ok(sha256(BIZ_DB) === manifest.db.sha256 && sha256(SERVER_DB) === manifest.additionalDbFiles[0].sha256, 'B: main and server database restored byte for byte, as one snapshot');
  ok(orphanHashes.every((h) => !fileOnDisk(h)) && sharedHashes.every(fileOnDisk) && keepHashes.every(fileOnDisk), 'B: the restored media holds the shared and kept photos, not the orphan');
  ok(!exists('p-del-1') && !exists('p-del-2') && exists('p-share') && exists('p-keep'), 'B: restored items — the deleted two absent, the kept two present');
  ok(job('p-del-1')[0]?.err === 'MOBILE_UPLOAD_TARGET_DELETED' && job('p-keep')[0]?.state === 'ready', 'B: restored jobs consistent with the main database (refused one stays refused, kept one ready)');

  c = await startApp();
  c = await frontendLogin(c);
  await waitHttpHealthy();
  const token2 = await serverToken();
  // the phone retries the deleted item with the same event: a replay, no new job
  const re = await upload(token2, 'ev-del-1', 'p-del-1', imgOrphan, { brand: 'Orphan', name: 'Orphan Model', categoryId: CAT });
  ok(re.status === 200 && re.body?.state === 'replay' && job('p-del-1').length === 1, `B: same upload again → replay, no new job (${re.status} ${re.body?.state})`);
  // the phone sends the deleted item as a NEW upload: accepted by the server, refused by the drain
  const again = await upload(token2, 'ev-del-1-again', 'p-del-1', imgOrphan, { brand: 'Orphan', name: 'Orphan Model', categoryId: CAT });
  ok(again.status === 201, `B: a new upload for the deleted item is accepted by the server (${again.status})`);
  // a genuinely new item still goes through
  const fresh = await upload(token2, 'ev-new', 'p-new', imgNew, { brand: 'Fresh', name: 'Fresh Model', categoryId: CAT });
  ok(fresh.status === 201, 'B: a new item is accepted');
  const st3 = await waitJobs(['p-del-1', 'p-new']);
  await sleep(4000);
  await stopApp(c);
  const jd = job('p-del-1');
  ok(st3[0] === 'quarantined' && jd.at(-1)?.ev === 'ev-del-1-again' && jd.at(-1)?.err === 'MOBILE_UPLOAD_TARGET_DELETED',
    `B: after the restore the drain refuses the deleted item (${jd.map((j) => `${j.ev}:${j.state}/${j.err}`).join(',')})`);
  ok(!exists('p-del-1') && !exists('p-del-2'), 'B: the deleted items were NOT created again');
  ok(st3[1] === 'ready' && exists('p-new') && activeLinks('p-new') === 1, `B: the new item was created with its photo (${st3[1]})`);
  ok(exists('p-share') && exists('p-keep') && activeLinks('p-share') === 1 && activeLinks('p-keep') === 1, 'B: kept items and their photos intact');

  const dB = digest();
  c = await startApp(); c = await frontendLogin(c); await sleep(8000); await stopApp(c);
  ok(digest() === dB, 'B: second start after the restore changes nothing (idempotent)');

  // ── production isolation ──────────────────────────────────────────────────────────────────────────────────
  const prodAfter = prodSnapshot();
  ok(prodAfter.server === prodBefore.server, 'production AppData server DB untouched');
  let leaked = 0;
  const scan = (dir) => { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { try { scan(p); } catch {} } else { try { if (readFileSync(p, 'latin1').includes(OWNER_PW)) leaked++; } catch {} } } };
  try { scan(RUN); scan(APP_DATA_DIR); } catch {}
  ok(leaked === 0, 'owner secret not persisted anywhere in the isolated tree');

  console.log(`\nv0.8.85 backup/restore gate: ${PASS} passed, ${FAIL} failed`);
}
main().catch((e) => { console.error('E2E ERROR:', e?.message || e); FAIL++; }).finally(async () => {
  try { killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe'); } catch {}
  await sleep(1500);
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
  if (FAIL > 0) for (const f of fails) console.log('  - ' + f);
  process.exit(FAIL > 0 ? 1 : 0);
});
