// SINGLE-PC-STORAGE-I2 §2–§12 — Settings → Danger Zone → Storage Maintenance, through the REAL UI.
//
// The legacy-media migration and the VACUUM are the two operations in this product that rewrite how
// every photo and every page is stored. Unit gates prove the rules; only this proves the thing the
// operator actually touches: the panel, its owner gate, its backup gate, its dry run, its apply, and
// the separate compaction — driven by clicking the real buttons in the real desktop app.
//
// Isolated: e2e identifier `com.lataif.app.e2e`, isolated AppData, isolated sync port 3011, ephemeral
// owner secret (never printed). The production install is never opened — not for reading, not for
// writing. Pure Node CDP + node:sqlite; no npm deps.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223;
const PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com';
// The SERVER owner secret (bcrypt-verified by list_restore_snapshots / schedule_backup_snapshot).
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
// The FRONTEND session password seedCleanDatabase creates. Deliberately different from the server
// secret: proving the panel needs the OWNER credentials, not merely a logged-in session.
const FE_PW = 'admin';

const RUN = join(os.tmpdir(), 'lataif-storage-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
const BACKUPS = join(APP_DATA_DIR, 'backups');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

// ── isolated business-DB access (the app is stopped whenever these run) ──
function bizRows(sql, params = []) {
  let db; try { db = new DatabaseSync(BIZ_DB); return db.prepare(sql).all(...params); } catch { return []; } finally { try { db?.close(); } catch {} }
}
function bizExec(fn) { const db = new DatabaseSync(BIZ_DB); try { return fn(db); } finally { db.close(); } }
const bizNum = (sql, p = []) => { const r = bizRows(sql, p); return r.length ? Number(Object.values(r[0])[0]) : -1; };
const productRow = (id) => bizRows('SELECT * FROM products WHERE id = ?', [id])[0] ?? null;
const activeLinks = (id) => bizRows("SELECT media_id, sort_order, is_primary FROM media_links WHERE entity_id = ? AND deleted_at IS NULL ORDER BY sort_order", [id]);
function mediaFiles() {
  const out = []; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const q = join(p, e.name); if (e.isDirectory()) walk(q); else out.push(q); } }; walk(MEDIA_ROOT); return out;
}
function bizPragma(name) { let db; try { db = new DatabaseSync(BIZ_DB); return Object.values(db.prepare(`PRAGMA ${name}`).get())[0]; } catch { return null; } finally { try { db?.close(); } catch {} } }

// ── app process ──
let appProc;
async function startApp() {
  // SINGLE-PC-STORAGE-I2A §4/§5 — HARD STOP before the process exists. Proves the artefact at
  // `APP` really is the isolated E2E build (a plain `cargo build` silently overwrites it with a
  // production-identity binary) and that this suite's AppData root and sync port are the isolated
  // ones. Never a warning: a suite that cannot prove what it is launching does not launch it.
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: isoEnv() });
  appProc = spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  const end = Date.now() + 90000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* not up */ }
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  return page.webSocketDebuggerUrl;
}
function killApp() { try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch { /* gone */ } }
function killAllApp() {
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch { /* none */ }
}
async function waitPortFree(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true; await sleep(500);
  }
  return false;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}
const S = (v) => JSON.stringify(v);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const click = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if(e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
const text = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.innerText : '';`);
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }
async function invoke(c, cmd, args) { return c.ev(`try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; }`); }
async function waitInvoke(c) { const end = Date.now() + 90000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }

async function frontendLogin(c) {
  // WebView2 keeps its profile across restarts, so a relaunched app often comes back already
  // authenticated. Waiting for a login form that will never render would fail the harness, not the
  // product — so settle on whichever of the two states the app actually reached.
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) break;
    // The SAME shell selector the post-login wait uses — an already-authenticated app must be
    // recognised by exactly what "logged in" means everywhere else in this suite.
    if (await exists(c, 'nav a, a[href="/settings"], [data-testid]')) return;
    await sleep(300);
  }
  await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 20000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co'); await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click(); return 1;`); await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin'); await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL); await setVal(c, 'input[placeholder="Choose a password"]', FE_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click(); return 1;`); await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10'); await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL); await setVal(c, 'input[type="password"]', FE_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`);
  }
  await waitFor(c, 'nav a, a[href="/settings"], [data-testid]', 60000);
}

/** Settings → Danger Zone, then wait for the Storage Maintenance panel to be on screen. */
async function openStoragePanel(c) {
  await c.ev(`history.pushState({},'','/settings'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
  await sleep(1200);
  await c.ev(`const b=[...document.querySelectorAll('button,div,span')].find(x=>x.textContent.trim()==='Danger Zone'); if(b) b.click(); return 1;`);
  await waitFor(c, '[data-testid="storage-dry-run"]', 30000);
}

/** Everything a mutation would change, in one comparable snapshot. */
function stateSnapshot() {
  return {
    products: bizRows('SELECT id, images, attributes, notes, purchase_price, planned_sale_price, min_sale_price, sku, updated_at FROM products ORDER BY id'),
    links: bizNum('SELECT COUNT(*) n FROM media_links'),
    objects: bizNum('SELECT COUNT(*) n FROM media_objects'),
    blobs: bizNum('SELECT COUNT(*) n FROM media_blobs'),
    gens: bizNum('SELECT COUNT(*) n FROM media_blob_generations'),
    files: mediaFiles().length,
    audit: bizNum('SELECT COUNT(*) n FROM audit_log'),
  };
}
const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── fixture: the legacy products this slice exists for ──
const JPEG_A = seed('jpeg', '1');    // valid JPEG, base64
const JPEG_B = seed('jpeg', '7');    // a different valid JPEG
const dataUrl = (b64) => `data:image/jpeg;base64,${b64}`;
const ATTRS_P1 = JSON.stringify({ movement: 'Automatic', diamonds: 'yes', box_papers: 'Full Set', some_unknown_legacy_key: 'keep-me-verbatim' });

function seedLegacyProducts() {
  const now = new Date().toISOString();
  bizExec((db) => {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const cat = db.prepare('SELECT id FROM categories LIMIT 1').get();
    if (!branch || !cat) throw new Error('fixture: the app did not seed a branch/category');
    const ins = db.prepare(`INSERT INTO products
      (id, branch_id, category_id, brand, name, sku, condition, purchase_price, purchase_currency,
       planned_sale_price, min_sale_price, notes, images, attributes, created_at, updated_at, version, sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BHD', ?, ?, ?, ?, ?, ?, ?, 1, 'synced')`);
    // P1 — one valid inline photo, and a full set of historical fields that must survive untouched.
    ins.run('sp-one', branch.id, cat.id, 'Rolex', 'Datejust 41', 'SKU-ONE', 'used', 1234.5, 2500, 1800,
      'historical note — must survive', JSON.stringify([dataUrl(JPEG_A)]), ATTRS_P1, now, now);
    // P2 — three inline photos: two IDENTICAL bytes and one different, so dedup and ordering are both visible.
    ins.run('sp-multi', branch.id, cat.id, 'Omega', 'Speedmaster', 'SKU-MULTI', 'new', 900, 1500, 1100,
      null, JSON.stringify([dataUrl(JPEG_A), dataUrl(JPEG_B), dataUrl(JPEG_A)]), '{}', now, now);
    // P3 — a corrupt inline entry: valid data-URL shape, bytes that are not an image.
    ins.run('sp-corrupt', branch.id, cat.id, 'Cartier', 'Tank', 'SKU-BAD', 'used', 500, 800, 600,
      null, JSON.stringify(['data:image/jpeg;base64,####not-base64####']), '{}', now, now);
    // P4 — already gallery-shaped: the control that must not be counted or touched.
    ins.run('sp-clean', branch.id, cat.id, 'Seiko', 'Presage', 'SKU-CLEAN', 'new', 100, 200, 150,
      null, '[]', '{}', now, now);
  });
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  killAllApp();
  await waitPortFree(PORT);
  for (const p of [APP_DATA_DIR, WV2_DIR, RUN]) { try { rmSync(p, { recursive: true, force: true }); } catch { /* fresh */ } }
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  // The seeder opens the server DB directly, so its directory must exist first — the app has not
  // run yet and therefore has not created it.
  mkdirSync(APP_DATA_DIR, { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server DB seeded as an owner-provisioned Primary');

  // ── boot 1: let the app create its business DB, then stop it and plant the legacy fixture ──
  let ws = await startApp();
  let c = new CDP(ws);
  await waitInvoke(c);
  await frontendLogin(c);
  await sleep(2500);
  c.close(); killApp(); await sleep(1500);

  ok(existsSync(BIZ_DB), 'the app created its business database');
  seedLegacyProducts();
  ok(bizNum("SELECT COUNT(*) n FROM products WHERE images LIKE 'data:%' OR images LIKE '[\"data:%'") === 3,
    'fixture: three legacy products with inline images');
  const before = stateSnapshot();
  const p1Before = productRow('sp-one');

  // ── boot 2: the real session the operator works in ──
  ws = await startApp(); c = new CDP(ws);
  await waitInvoke(c); await frontendLogin(c); await sleep(2000);
  await openStoragePanel(c);
  ok(true, '§2 Settings → Danger Zone → Storage Maintenance is reachable in the real UI');

  // ════════════════════════════════════════════════════════════════════════
  // §4 — DRY RUN is read-only
  // ════════════════════════════════════════════════════════════════════════
  ok(await click(c, '[data-testid="storage-dry-run"]') === 'OK', '§4 the dry-run button is enabled and clicks');
  await waitFor(c, '[data-testid="storage-plan"]', 20000);
  const planText = await text(c, '[data-testid="storage-plan"]');
  const msg1 = await text(c, '[data-testid="storage-msg"]');
  // The fixture is 4 products: two migratable (1 + 3 images), one corrupt, one already gallery-shaped.
  const stat = (title) => { const m = new RegExp(title + '\\s*\\n\\s*(\\d+)', 'i').exec(planText); return m ? Number(m[1]) : -1; };
  ok(stat('PRODUCTS') === 4, `§4 the dry run counts every product in the branch (${stat('PRODUCTS')})`);
  ok(stat('TO MIGRATE') === 2, `§4 …and exactly the migratable candidates (${stat('TO MIGRATE')})`);
  ok(/4 image\(s\)/.test(planText), `§4 …and the legacy image count across them (${planText.replace(/\n/g, ' | ').slice(0, 150)})`);
  ok(stat('NOT MIGRATABLE') === 1, `§4 …and the corrupt one, counted separately (${stat('NOT MIGRATABLE')})`);
  ok(stat('NO PHOTO') === 1, `§4 …and the product without a photo (${stat('NO PHOTO')})`);
  ok(/\d+(\.\d+)?\s*(B|KB|MB)/i.test(planText), '§4 …and the bytes that would leave the product rows');
  ok(/can be migrated/i.test(msg1), `§4 the panel states what would happen ("${msg1.slice(0, 90)}")`);

  // The decisive property: a dry run changes NOTHING.
  killApp(); await sleep(1200);
  ok(sameState(stateSnapshot(), before), '§4 the dry run mutated nothing — products, media rows and audit are identical');
  ok(mediaFiles().length === before.files, '§4 …and not one media file was created');
  ws = await startApp(); c = new CDP(ws); await waitInvoke(c); await frontendLogin(c); await sleep(2000); await openStoragePanel(c);

  // ════════════════════════════════════════════════════════════════════════
  // §3 — a non-owner cannot mutate anything
  // ════════════════════════════════════════════════════════════════════════
  await click(c, '[data-testid="storage-dry-run"]'); await waitFor(c, '[data-testid="storage-plan"]');
  ok(await click(c, '[data-testid="storage-apply-open"]') === 'OK', '§3 the apply step opens its credential box');
  await waitFor(c, '[data-testid="storage-apply"]');
  await setVal(c, '[data-testid="storage-apply-pw"]', 'definitely-not-the-owner-secret');
  await setVal(c, '[data-testid="storage-apply-email"]', OWNER_EMAIL);
  ok(await click(c, '[data-testid="storage-apply"]') === 'OK', '§3 apply with non-owner credentials is attempted');
  await sleep(6000);
  const denied = await text(c, '[data-testid="storage-msg"]');
  ok(/could not verify|not valid owner|no recent complete backup/i.test(denied), `§3 …and is refused ("${denied.slice(0, 90)}")`);

  // Compaction, the one action that rewrites the whole file, is owner-gated too.
  ok(await exists(c, '[data-testid="storage-compact-open"]'), '§11 compaction is offered as a SEPARATE action');
  await click(c, '[data-testid="storage-compact-open"]'); await waitFor(c, '[data-testid="storage-compact"]');
  await setVal(c, '[data-testid="storage-compact-pw"]', 'definitely-not-the-owner-secret');
  await setVal(c, '[data-testid="storage-compact-email"]', OWNER_EMAIL);
  await click(c, '[data-testid="storage-compact"]'); await sleep(5000);
  const compDenied = await text(c, '[data-testid="storage-msg"]');
  ok(/not valid owner|could not verify/i.test(compDenied), `§3/§11 a non-owner cannot compact ("${compDenied.slice(0, 80)}")`);

  // Even bypassing the UI entirely: the backend refuses, so a re-enabled button changes nothing.
  const direct = await invoke(c, 'list_restore_snapshots', { email: OWNER_EMAIL, password: 'wrong-secret' });
  ok(direct.ok === false, '§3 the owner-gated backend command refuses wrong credentials directly — the gate is not in the UI');

  killApp(); await sleep(1200);
  ok(sameState(stateSnapshot(), before), '§3 after every non-owner attempt the database is byte-for-byte unchanged');
  ws = await startApp(); c = new CDP(ws); await waitInvoke(c); await frontendLogin(c); await sleep(2000); await openStoragePanel(c);

  // ════════════════════════════════════════════════════════════════════════
  // §5 — the backup gate: correct owner, but no snapshot yet
  // ════════════════════════════════════════════════════════════════════════
  const snapsBefore = await invoke(c, 'list_restore_snapshots', { email: OWNER_EMAIL, password: OWNER_PW });
  ok(snapsBefore.ok === true && Array.isArray(snapsBefore.value) && snapsBefore.value.length === 0,
    '§5 the owner is valid and there is genuinely no backup yet');

  await click(c, '[data-testid="storage-dry-run"]'); await waitFor(c, '[data-testid="storage-plan"]');
  await click(c, '[data-testid="storage-apply-open"]'); await waitFor(c, '[data-testid="storage-apply"]');
  await setVal(c, '[data-testid="storage-apply-pw"]', OWNER_PW);
  await setVal(c, '[data-testid="storage-apply-email"]', OWNER_EMAIL);
  await click(c, '[data-testid="storage-apply"]'); await sleep(8000);
  const gated = await text(c, '[data-testid="storage-msg"]');
  ok(/backup/i.test(gated), `§5 the apply is refused for want of a backup ("${gated.slice(0, 100)}")`);

  killApp(); await sleep(1200);
  ok(sameState(stateSnapshot(), before), '§5 the refused apply left NO media row, NO blob file and NO cleared product');

  // ── create a real backup the way production does: durable intent → relaunch → boot publishes ──
  ws = await startApp(); c = new CDP(ws); await waitInvoke(c); await frontendLogin(c); await sleep(2000);
  const sched = await invoke(c, 'schedule_backup_snapshot', { email: OWNER_EMAIL, password: OWNER_PW });
  ok(sched.ok === true, '§5 the owner schedules a backup snapshot');
  killApp(); await sleep(1500);
  ws = await startApp(); c = new CDP(ws); await waitInvoke(c); await frontendLogin(c); await sleep(3000);
  const snapsAfter = await invoke(c, 'list_restore_snapshots', { email: OWNER_EMAIL, password: OWNER_PW });
  ok(snapsAfter.ok === true && snapsAfter.value.length === 1, `§5 the boot published exactly one complete snapshot (${snapsAfter.value?.length})`);
  ok(existsSync(BACKUPS), '§5 …and it is on disk under the app data root');

  // ════════════════════════════════════════════════════════════════════════
  // §6/§7/§8 — the real apply
  // ════════════════════════════════════════════════════════════════════════
  await openStoragePanel(c);
  await click(c, '[data-testid="storage-dry-run"]'); await waitFor(c, '[data-testid="storage-plan"]');
  await click(c, '[data-testid="storage-apply-open"]'); await waitFor(c, '[data-testid="storage-apply"]');
  await setVal(c, '[data-testid="storage-apply-pw"]', OWNER_PW);
  await setVal(c, '[data-testid="storage-apply-email"]', OWNER_EMAIL);
  ok(await click(c, '[data-testid="storage-apply"]') === 'OK', '§6 the owner starts the migration from the real UI');
  await waitFor(c, '[data-testid="storage-report"]', 180000);
  const reportText = await text(c, '[data-testid="storage-report"]');
  const applyMsg = await text(c, '[data-testid="storage-msg"]');
  ok(/2/.test(reportText), `§6 the report shows the migrated products (${reportText.replace(/\n/g, ' | ').slice(0, 150)})`);
  ok(/untouched|left/i.test(applyMsg) || /1/.test(reportText), '§7 …and reports the corrupt candidate as left untouched, not as a success');
  const problemsShown = await c.ev(`return document.body.innerText.includes('left untouched') || document.body.innerText.includes('not valid image');`);
  ok(problemsShown, '§7 the UI shows the partial result honestly instead of claiming a clean run');

  // Reopen the product detail: the migrated photo must RENDER from the gallery, not merely be linked.
  await c.ev(`history.pushState({},'','/collection/sp-one'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
  await sleep(6000);
  const rendered = await c.ev(`return [...document.querySelectorAll('img')].filter(i=>String(i.currentSrc||i.src).startsWith('blob:')).length;`);
  ok(rendered >= 1, `§6 reopening the product renders the migrated image from the durable gallery (${rendered} blob image(s))`);

  killApp(); await sleep(1500);

  // ── independent verification, straight against the files ──
  const p1After = productRow('sp-one');
  ok(p1After.images === '[]', '§6 the legacy base64 is gone from the product row — and only now');
  ok(activeLinks('sp-one').length === 1, '§6 exactly one active link for the single-image product');
  ok(bizNum("SELECT COUNT(*) n FROM media_objects WHERE ingest_status='ready'") >= 3, '§6 every migrated object is ready');
  ok(bizNum("SELECT COUNT(*) n FROM media_blobs WHERE blob_status='present'") >= 2, '§6 the blobs are present');
  ok(bizNum("SELECT COUNT(*) n FROM media_blob_generations WHERE gen_status='available'") >= 2, '§6 their generations are available');
  ok(mediaFiles().length >= 2, `§6 the physical files exist under the media root (${mediaFiles().length})`);

  // §8 — multi-image: order, primary, and content dedup
  const multi = activeLinks('sp-multi');
  ok(multi.length === 3, `§8 all three legacy images became links (${multi.length})`);
  ok(multi.map((l) => Number(l.sort_order)).join(',') === '0,1,2', '§8 the order is deterministic and follows the legacy array');
  ok(multi.filter((l) => Number(l.is_primary) === 1).length === 1 && Number(multi[0].is_primary) === 1,
    '§8 exactly one primary, and it is the first image');
  const distinctBlobs = bizNum(`SELECT COUNT(DISTINCT o.master_blob_id) n FROM media_links l JOIN media_objects o ON o.media_id = l.media_id WHERE l.entity_id = 'sp-multi' AND l.deleted_at IS NULL`);
  ok(distinctBlobs === 2, `§8 identical bytes share ONE blob, different bytes get their own (${distinctBlobs} distinct blobs for 3 images)`);

  // §7 — the corrupt product kept its payload and grew no gallery
  const corrupt = productRow('sp-corrupt');
  ok(corrupt.images.includes('data:image/jpeg;base64,####'), '§7 the corrupt product still holds its original legacy payload');
  ok(activeLinks('sp-corrupt').length === 0, '§7 …and no half-built gallery was created for it');

  // §4 control — the already-clean product was not counted and not touched
  const clean = productRow('sp-clean');
  ok(clean.images === '[]' && activeLinks('sp-clean').length === 0, '§4 the already-gallery product was left alone');

  // ════════════════════════════════════════════════════════════════════════
  // §9 — nothing but the media representation changed
  // ════════════════════════════════════════════════════════════════════════
  const FIELDS = ['brand', 'name', 'sku', 'condition', 'purchase_price', 'purchase_currency', 'planned_sale_price',
    'min_sale_price', 'max_sale_price', 'stock_status', 'tax_scheme', 'notes', 'attributes', 'category_id', 'branch_id', 'created_at'];
  const changed = FIELDS.filter((f) => String(p1Before[f] ?? '') !== String(p1After[f] ?? ''));
  ok(changed.length === 0, `§9 every historical product field is byte-identical after the migration (changed: ${changed.join(', ') || 'none'})`);
  ok(JSON.parse(p1After.attributes).some_unknown_legacy_key === 'keep-me-verbatim',
    '§9 an attribute key the app does not know is preserved verbatim');
  ok(JSON.parse(p1After.attributes).movement === 'Automatic' && JSON.parse(p1After.attributes).diamonds === 'yes',
    '§9 the category attributes are untouched');
  ok(p1After.notes === 'historical note — must survive', '§9 the notes are untouched');

  // ════════════════════════════════════════════════════════════════════════
  // §10 — a second run changes nothing
  // ════════════════════════════════════════════════════════════════════════
  const afterFirst = stateSnapshot();
  ws = await startApp(); c = new CDP(ws); await waitInvoke(c); await frontendLogin(c); await sleep(2000); await openStoragePanel(c);
  await click(c, '[data-testid="storage-dry-run"]'); await waitFor(c, '[data-testid="storage-plan"]');
  const secondPlanMsg = await text(c, '[data-testid="storage-msg"]');
  ok(/1 product/i.test(secondPlanMsg) || /nothing to migrate/i.test(secondPlanMsg),
    `§10 the second dry run sees only the corrupt leftover ("${secondPlanMsg.slice(0, 90)}")`);
  if (await exists(c, '[data-testid="storage-apply-open"]')) {
    await click(c, '[data-testid="storage-apply-open"]'); await waitFor(c, '[data-testid="storage-apply"]');
    await setVal(c, '[data-testid="storage-apply-pw"]', OWNER_PW);
    await setVal(c, '[data-testid="storage-apply-email"]', OWNER_EMAIL);
    await click(c, '[data-testid="storage-apply"]');
    await sleep(25000);
  }
  killApp(); await sleep(1500);
  const afterSecond = stateSnapshot();
  ok(afterSecond.links === afterFirst.links, `§10 no new links (${afterFirst.links} → ${afterSecond.links})`);
  ok(afterSecond.objects === afterFirst.objects, `§10 no new objects (${afterFirst.objects} → ${afterSecond.objects})`);
  ok(afterSecond.blobs === afterFirst.blobs, `§10 no new blobs (${afterFirst.blobs} → ${afterSecond.blobs})`);
  ok(afterSecond.files === afterFirst.files, `§10 no new media files (${afterFirst.files} → ${afterSecond.files})`);
  ok(JSON.stringify(afterSecond.products) === JSON.stringify(afterFirst.products), '§10 no product row moved');
  ok(afterSecond.audit - afterFirst.audit < 50, `§10 no audit explosion (${afterSecond.audit - afterFirst.audit} new rows)`);

  // ════════════════════════════════════════════════════════════════════════
  // §11/§12 — compaction is a separate, explicit, owner-verified action
  // ════════════════════════════════════════════════════════════════════════
  const bytesBefore = statSync(BIZ_DB).size;
  const freelistBefore = Number(bizPragma('freelist_count'));
  ok(freelistBefore > 0, `§11 the migration freed pages but did NOT shrink the file — no automatic VACUUM (${freelistBefore} free pages)`);

  ws = await startApp(); c = new CDP(ws); await waitInvoke(c); await frontendLogin(c); await sleep(2000); await openStoragePanel(c);
  await click(c, '[data-testid="storage-dry-run"]'); await waitFor(c, '[data-testid="storage-plan"]');
  const reclaimHint = await c.ev(`return document.body.innerText;`);
  ok(/reusable free space/i.test(reclaimHint), '§11 the panel states how much space is reclaimable before anything runs');
  await click(c, '[data-testid="storage-compact-open"]'); await waitFor(c, '[data-testid="storage-compact"]');
  await setVal(c, '[data-testid="storage-compact-pw"]', OWNER_PW);
  await setVal(c, '[data-testid="storage-compact-email"]', OWNER_EMAIL);
  ok(await click(c, '[data-testid="storage-compact"]') === 'OK', '§12 the owner starts compaction explicitly');
  const end = Date.now() + 120000; let compMsg = '';
  while (Date.now() < end) { compMsg = await text(c, '[data-testid="storage-msg"]'); if (/compacted|reclaim/i.test(compMsg)) break; await sleep(1000); }
  ok(/compacted/i.test(compMsg), `§12 the UI reports the final result ("${compMsg.slice(0, 110)}")`);
  killApp(); await sleep(1500);

  const bytesAfter = statSync(BIZ_DB).size;
  ok(bytesAfter < bytesBefore, `§12 the database FILE shrank (${bytesBefore} → ${bytesAfter} bytes)`);
  ok(Number(bizPragma('freelist_count')) === 0, '§12 freelist_count is zero afterwards');
  ok(String(bizPragma('integrity_check')) === 'ok', '§12 integrity_check = ok');
  ok(bizRows('PRAGMA foreign_key_check').length === 0, '§12 foreign_key_check reports nothing');

  const postCompact = stateSnapshot();
  ok(JSON.stringify(postCompact.products) === JSON.stringify(afterSecond.products), '§12 every product row is identical after the VACUUM');
  ok(postCompact.links === afterSecond.links && postCompact.blobs === afterSecond.blobs, '§12 …and so is the whole media graph');
  ok(mediaFiles().length === afterSecond.files, '§12 …and no media file was touched');

  // ── the app reopens on the compacted file and still shows the product ──
  ws = await startApp(); c = new CDP(ws); await waitInvoke(c); await frontendLogin(c); await sleep(2500);
  await c.ev(`history.pushState({},'','/collection/sp-one'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
  await sleep(6000);
  const reopened = await c.ev(`return document.body.innerText.includes('Datejust 41');`);
  ok(reopened, '§12 the app reopens on the compacted database and still shows the product');
  const reopenedImg = await c.ev(`return [...document.querySelectorAll('img')].filter(i=>String(i.currentSrc||i.src).startsWith('blob:')).length;`);
  ok(reopenedImg >= 1, '§12 …with its migrated photo still rendering');
  c.close(); killApp();
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\nSINGLE-PC storage-maintenance: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
