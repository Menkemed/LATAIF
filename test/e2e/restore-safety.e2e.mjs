// RESTORE-SAFETY — the REAL restore, end to end, through the owner's own panel, fully isolated.
//
//   R1  two items arrive as real phone uploads (p-keep, p-old); p-old's photo is then REMOVED from its gallery
//       (link soft-removed, file stays) and a backup is taken with the real snapshot host into the app's own
//       backups folder — p-old's photo is NOT in it.
//   R2  after the backup: a new item p-new arrives with its photo, and p-keep's photo is removed from its gallery.
//   R3  Settings → Danger Zone → Backup & Restore: load snapshots, choose it, re-enter the owner password — the
//       confirm button stays disabled until "Show what changes" ran; the preview names exactly what the restore
//       changes (1 item gone, 1 photo back, 1 photo leaving, 1 file taken over) and that everything is kept.
//   R4  Confirm → the app schedules, relaunches and restores at boot (the real production path).
//   R5  on disk: the restored data is the backup's (p-new gone, p-keep's photo active again, p-old's photo still
//       removed — never re-linked), p-old's photo FILE is back (proven), p-new's photo is not in the live media
//       but in the ARCHIVE, which holds the complete prior state; the history records scheduled → started →
//       committed; nothing transient is left; production untouched.
//
// Isolated: e2e identifier `com.lataif.app.e2e`, isolated AppData, sync port 3011, ephemeral owner secret
// (never printed). Only processes at the exact test-build path are stopped. Pure Node CDP + fetch + node:sqlite.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killTestImage, waitTestImageGone } from './_e2e-process.mjs';
import { mkdirSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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
const SNAP = 'snap-restore-safety';

const RUN = join(os.tmpdir(), 'lataif-restore-safety', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
const PROD_APPDATA_SERVER = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (...args) => execFileSync(SEED, args, { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const S = (v) => JSON.stringify(v);

function withDb(path, fn, readOnly = true) { const db = new DatabaseSync(path, { readOnly }); try { return fn(db); } finally { db.close(); } }
const biz = (sql, p = []) => withDb(BIZ_DB, (db) => db.prepare(sql).all(...p));
const srv = (sql, p = []) => withDb(SERVER_DB, (db) => db.prepare(sql).all(...p));
const n = (rows) => Number(Object.values(rows[0] ?? { x: -1 })[0]);
const exists = (id) => n(biz(`SELECT COUNT(*) c FROM products WHERE id = ?`, [id])) === 1;
const activeLinks = (id) => n(biz(`SELECT COUNT(*) c FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NULL`, [id]));
const allLinks = (id) => n(biz(`SELECT COUNT(*) c FROM media_links WHERE entity_type = 'product' AND entity_id = ?`, [id]));
/** The master file hash of an item's photo (active or removed link). */
const masterHash = (id) => biz(`SELECT g.stored_blob_hash h FROM media_links l JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
    JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
    JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
   WHERE l.entity_type = 'product' AND l.entity_id = ? LIMIT 1`, [id])[0]?.h ?? null;
const fileIn = (root, h) => ['jpg', 'jpeg', 'png', 'webp'].some((ext) => existsSync(join(root, TENANT, h.slice(0, 2), `${h}.${ext}`)));
const job = (entity) => srv(`SELECT state FROM mobile_upload_inbox WHERE entity_id = ? ORDER BY created_at`, [entity]);
const removeGalleryPhoto = (id) => withDb(BIZ_DB, (db) => {
  // exactly what the gallery's "remove photo" does (MediaLinks.unlink): the link gets deleted_at, the file stays
  db.prepare(`UPDATE media_links SET deleted_at = ?, is_primary = 0 WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NULL`).run(new Date().toISOString(), id);
}, false);

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
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`).catch(() => false)) return; await sleep(400); } throw new Error('no invoke'); }
async function attach(notId = null, timeoutMs = 120000) {
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
async function stopApp(c) { try { c?.close(); } catch {} killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe'); await sleep(1500); }
const has = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const click = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO_EL'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
async function waitFor(c, sel, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await has(c, sel).catch(() => false)) return true; await sleep(300); } throw new Error('waitFor timeout: ' + sel); }
async function invoke(c, cmd, args) { return c.ev(`return (async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return { ok:true, value: v===undefined?null:v }; } catch (e) { return { ok:false, error: String((e && e.message) || e) }; } })();`); }
async function waitHttpHealthy() {
  const end = Date.now() + 40000;
  while (Date.now() < end) { try { const r = await fetch(`${HTTP}/api/health`, { signal: AbortSignal.timeout(2500) }); if (r.ok) return; } catch { /* not up */ } await sleep(500); }
  throw new Error(`embedded HTTP server never became healthy on ${PORT}`);
}
async function frontendLogin(c) {
  const START = '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"], a[href="/settings"]';
  await waitFor(c, START, 90000);
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
  await waitFor(c, 'a[href="/settings"]', 45000);
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
async function relogin(c) { await c.ev('window.location.reload();').catch(() => {}); await sleep(3000); c.close(); const nc = await attach(); return frontendLogin(nc).catch(() => nc); }
async function waitReady(entities, c, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs; let kicked = false;
  while (Date.now() < end) {
    if (!kicked && Date.now() > end - timeoutMs / 2) { kicked = true; c = await relogin(c); }
    if (entities.every((e) => job(e).at(-1)?.state === 'ready')) return { ok: true, c };
    await sleep(1000);
  }
  return { ok: false, c };
}
/** Data set of a tree: DBs + media (relative path → sha256). */
function dataSet(root) {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[p.slice(root.length + 1).replace(/\\/g, '/')] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
  for (const f of ['lataif.db', 'lataif_sync_server.db']) if (existsSync(join(root, f))) out[f] = createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
  if (existsSync(join(root, 'media'))) walk(join(root, 'media'));
  return out;
}

async function main() {
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(APP_DATA_DIR.endsWith(IDENT) && APP_DATA_DIR.startsWith(REAL_APPDATA), `the suite's data folder is the isolated one (${IDENT})`);
  const prodBefore = existsSync(PROD_APPDATA_SERVER) ? statSync(PROD_APPDATA_SERVER).mtimeMs : 0;

  // ── R1 · two items, p-old's photo removed from its gallery, then the backup ─────────────────────────────────
  ok(seed('seed-primary', SERVER_DB) === 'SEED_PRIMARY_OK', 'R1: isolated server seeded as Primary (owner)');
  const imgKeep = seed('jpeg', '11'), imgOld = seed('jpeg', '12'), imgNew = seed('jpeg', '13');
  let c = await startApp();
  c = await frontendLogin(c);
  await waitHttpHealthy();
  let token = await serverToken();
  for (const [id, ev, img] of [['p-keep', 'ev-keep', imgKeep], ['p-old', 'ev-old', imgOld]]) {
    const r = await upload(token, ev, id, img, { brand: id, name: `${id} Model`, categoryId: CAT });
    ok(r.status === 201, `R1: upload ${id} accepted (${r.status})`);
  }
  const cfg = await invoke(c, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok, 'R1: runtime binding configured');
  let w = await waitReady(['p-keep', 'p-old'], c); c = w.c;
  ok(w.ok, 'R1: both items created by the app\'s own drain');
  await sleep(3000);
  await stopApp(c);
  const hKeep = masterHash('p-keep'), hOld = masterHash('p-old');
  removeGalleryPhoto('p-old');
  ok(activeLinks('p-old') === 0 && allLinks('p-old') === 1 && fileIn(MEDIA_ROOT, hOld), 'R1: p-old\'s photo removed from its gallery, its file stays');
  const out = seed('backup', APP_DATA_DIR, join(APP_DATA_DIR, 'backups', SNAP), new Date().toISOString());
  ok(/^BACKUP_OK /.test(out), `R1: backup published into the app's backups folder (${out})`);
  const manifest = JSON.parse(readFileSync(join(APP_DATA_DIR, 'backups', SNAP, 'manifest.json'), 'utf8'));
  ok(manifest.files.some((f) => f.hash === hKeep) && !manifest.files.some((f) => f.hash === hOld), 'R1: the backup carries p-keep\'s photo, not the removed one');

  // ── R2 · after the backup: a new item with photo; p-keep's photo removed ───────────────────────────────────────
  c = await startApp();
  c = await frontendLogin(c);
  await waitHttpHealthy();
  token = await serverToken();
  const rn = await upload(token, 'ev-new', 'p-new', imgNew, { brand: 'p-new', name: 'p-new Model', categoryId: CAT });
  ok(rn.status === 201, 'R2: new item uploaded after the backup');
  w = await waitReady(['p-new'], c); c = w.c;
  ok(w.ok, 'R2: p-new created');
  await sleep(3000);
  await stopApp(c);
  const hNew = masterHash('p-new');
  removeGalleryPhoto('p-keep');
  ok(exists('p-new') && activeLinks('p-new') === 1 && activeLinks('p-keep') === 0 && fileIn(MEDIA_ROOT, hNew), 'R2: state before the restore set up');
  const prior = dataSet(APP_DATA_DIR);

  // ── R3 · the owner's panel: preview before confirm ─────────────────────────────────────────────────────────────
  c = await startApp();
  c = await frontendLogin(c);
  await c.ev(`history.pushState({}, '', '/settings?tab=danger'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
  await waitFor(c, '[data-testid="brp-root"]', 30000);
  await setVal(c, '[data-testid="brp-owner-pw"]', OWNER_PW);
  await click(c, '[data-testid="brp-load"]');
  await waitFor(c, `[data-testid="brp-restore"][data-snapshot-id="${SNAP}"]`, 30000);
  await click(c, `[data-testid="brp-restore"][data-snapshot-id="${SNAP}"]`);
  await waitFor(c, '[data-testid="brp-confirm-modal"]');
  await setVal(c, '[data-testid="brp-confirm-pw"]', OWNER_PW);
  ok(await c.ev(`return document.querySelector('[data-testid="brp-confirm"]').disabled;`), 'R3: confirm is disabled before the preview');
  // The emergency path first: a preview that FAILS (here: a wrong owner password) shows the unknown-effects
  // warning, and the restore stays disabled until the owner ticks it deliberately.
  await setVal(c, '[data-testid="brp-confirm-pw"]', OWNER_PW + '-wrong');
  await click(c, '[data-testid="brp-preview"]');
  await waitFor(c, '[data-testid="brp-unknown-box"]', 30000);
  const em1 = await c.ev(`const b = document.querySelector('[data-testid="brp-confirm"]'); return { disabled: b.disabled, label: b.textContent, text: document.querySelector('[data-testid="brp-unknown-box"]').textContent };`);
  ok(em1.disabled && /could not be determined/.test(em1.text), `R3: failed preview → warning, restore still disabled (${S(em1.label)})`);
  await click(c, '[data-testid="brp-ack-unknown"]');
  const em2 = await c.ev(`const b = document.querySelector('[data-testid="brp-confirm"]'); return { disabled: b.disabled, label: b.textContent.trim() };`);
  ok(!em2.disabled && em2.label === 'Restore without preview', `R3: only the deliberate tick enables the emergency restore (${S(em2)})`);
  await setVal(c, '[data-testid="brp-confirm-pw"]', OWNER_PW);
  const em3 = await c.ev(`return { disabled: document.querySelector('[data-testid="brp-confirm"]').disabled, box: !!document.querySelector('[data-testid="brp-unknown-box"]') };`);
  ok(em3.disabled && !em3.box, 'R3: a new password resets the preview and the tick');
  await click(c, '[data-testid="brp-preview"]');
  await waitFor(c, '[data-testid="brp-preview-box"]', 30000);
  const lines = await c.ev(`return [...document.querySelectorAll('[data-testid="brp-preview-line"]')].map(l => ({ tone: l.dataset.tone, text: l.textContent }));`);
  const all = lines.map((l) => l.text).join('\n');
  ok(/1 item added since the backup will be gone/.test(all), `R3: preview — 1 item gone (${all.slice(0, 400)})`);
  ok(/1 gallery photo\(s\) removed since the backup become visible again/.test(all), 'R3: preview — p-keep\'s photo comes back');
  ok(/1 gallery photo\(s\) added since the backup leave/.test(all), 'R3: preview — p-new\'s photo leaves');
  ok(/[12] photo file\(s\) the backup lacks are taken over/.test(all), 'R3: preview — p-old\'s files (photo + thumbnail) are taken over');
  ok(/kept as a pre-restore archive/.test(all) && /Nothing is deleted/.test(all), 'R3: preview — everything kept');
  ok(lines.some((l) => l.tone === 'unknown' && /not compared/.test(l.text)), 'R3: preview — field changes said to be not compared');
  ok(!(await c.ev(`return document.querySelector('[data-testid="brp-confirm"]').disabled;`)), 'R3: confirm enabled after the preview');

  // ── R4 · confirm → schedule → relaunch → boot restore ─────────────────────────────────────────────────────────
  const oldPage = c.pageId;
  await click(c, '[data-testid="brp-confirm"]');
  c.close();
  await sleep(4000);
  c = await attach(oldPage, 180000);
  c = await frontendLogin(c);
  ok(true, 'R4: the app came back after the boot restore');
  await sleep(4000);
  await stopApp(c);

  // ── R5 · on disk ───────────────────────────────────────────────────────────────────────────────────────────────
  ok(!exists('p-new') && exists('p-keep') && exists('p-old'), 'R5: the restored items are the backup\'s (p-new gone)');
  ok(activeLinks('p-keep') === 1, 'R5: p-keep\'s photo is active again (it was in the backup)');
  ok(activeLinks('p-old') === 0 && allLinks('p-old') === 1, 'R5: p-old\'s photo stays removed — never re-linked');
  ok(fileIn(MEDIA_ROOT, hOld), 'R5: p-old\'s photo FILE is back (the restored DB lists it; proven by content)');
  ok(!fileIn(MEDIA_ROOT, hNew), 'R5: p-new\'s photo is not in the live media');
  const arcRoot = join(APP_DATA_DIR, 'restore-archive');
  const arcs = existsSync(arcRoot) ? readdirSync(arcRoot) : [];
  ok(arcs.length === 1, `R5: exactly one archive (${arcs.join(',')})`);
  const arc = join(arcRoot, arcs[0] ?? 'none');
  // The app writes its databases on every start, so the archived DBs are the state right before the restore
  // (checked by content); the media are compared byte for byte with the state set up in R2.
  const arcData = existsSync(arc) ? dataSet(arc) : {};
  const media = (d) => JSON.stringify(Object.entries(d).filter(([k]) => k.startsWith('media/') || !k.includes('/')).filter(([k]) => k.startsWith('media/')));
  ok(media(arcData) === media(prior), 'R5: the archive holds every prior media file, byte for byte');
  const arcProducts = existsSync(join(arc, 'lataif.db')) ? withDb(join(arc, 'lataif.db'), (db) => db.prepare('SELECT id FROM products ORDER BY id').all().map((r) => r.id)) : [];
  ok(existsSync(join(arc, 'lataif_sync_server.db')) && arcProducts.includes('p-new') && arcProducts.includes('p-keep'), `R5: the archived databases are the prior state (${arcProducts.join(',')})`);
  ok(existsSync(arc) && fileIn(join(arc, 'media'), hNew), 'R5: p-new\'s photo is kept in the archive');
  const meta = existsSync(join(arc, 'archive.json')) ? JSON.parse(readFileSync(join(arc, 'archive.json'), 'utf8')) : {};
  ok(meta.replacedBySnapshotId === SNAP, 'R5: archive.json names the snapshot that replaced it');
  const hist = existsSync(join(APP_DATA_DIR, 'restore-history.jsonl'))
    ? readFileSync(join(APP_DATA_DIR, 'restore-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const evs = hist.map((h) => h.event);
  ok(evs.join(',') === 'scheduled,started,committed', `R5: history scheduled → started → committed (${evs.join(',')})`);
  const committed = hist.find((h) => h.event === 'committed') ?? {};
  ok(committed.snapshotId === SNAP && committed.archiveId === arcs[0] && committed.counts?.fill?.filled >= 1, 'R5: the committed entry names snapshot, archive and the fill-in');
  ok(!/[A-Za-z]:\\\\|\/Users\//.test(readFileSync(join(APP_DATA_DIR, 'restore-history.jsonl'), 'utf8')), 'R5: the history holds no path');
  ok(['.restore-staging', '.restore-rollback', '.restore-journal', '.restore-intent', '.restore-context.json'].every((f) => !existsSync(join(APP_DATA_DIR, f))), 'R5: nothing transient left');

  const prodAfter = existsSync(PROD_APPDATA_SERVER) ? statSync(PROD_APPDATA_SERVER).mtimeMs : 0;
  ok(prodAfter === prodBefore, 'production AppData untouched');
}

try {
  await main();
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  ✗ ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
}
console.log(`\nrestore safety e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('RESTORE_SAFETY_E2E_PROVED');
