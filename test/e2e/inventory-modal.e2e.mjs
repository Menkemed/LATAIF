// POST-V0838 §G3 — the desktop inventory modal through the REAL Tauri/WebView2 UI.
//
// What this has to prove is mostly NEGATIVE, and none of it is visible from a unit test:
//   • the modal offers exactly the Collection's filtered working set, not the whole stock,
//   • moving cards around writes NOTHING — the operator's nine accidental checks in the live
//     database are the reason this exists,
//   • Save writes exactly one event per FINAL decision, never one per intermediate click,
//   • a second Save (double click, retry) adds nothing, because the request id per product is
//     stable,
//   • and after all of it every product row is byte-identical, column by column.
//
// Products are staged at rest (app stopped, rows written into the isolated e2e DB, app restarted)
// — the house fixture pattern. Stock checks are NEVER written by this file: every one of them has
// to come out of the real UI through the real core, or the proof is worthless.
//
// Isolated e2e identifier + AppData + sync port (3011); production (3001) is never touched.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-inventory-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const PROD_BIZ_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif.db');
const PROD_SRV_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const checks = () => dbQ(SERVER_DB, 'SELECT check_id, product_id, status, notes, checked_at, checked_by, checked_by_name, source, request_id FROM stock_checks ORDER BY checked_at');
/** INVENTORY-SESSION — the worksheet lives in the BUSINESS db, next to the products it describes. */
const bootstrap = () => { const r = dbQ(BIZ_DB, 'SELECT at FROM inventory_bootstrap WHERE id = 1'); return r.length ? r[0].at : null; };
const sessions = () => dbQ(BIZ_DB, 'SELECT session_id, branch_id, status, started_at, closed_at FROM inventory_sessions ORDER BY started_at');
const sessionItems = () => dbQ(BIZ_DB, 'SELECT session_id, product_id, status, notes, updated_at, applied_check_id FROM inventory_session_items ORDER BY product_id');
/** Mutate the business db while the app is NOT running — the house fixture pattern. */
function atRest(fn) {
  const db = new DatabaseSync(BIZ_DB);
  try { return fn(db); } finally { try { db.close(); } catch {} }
}
/** Every column of every product — the only honest way to claim "nothing was mutated". */
function productRows() {
  const cols = dbQ(BIZ_DB, "SELECT name FROM pragma_table_info('products')").map(r => r.name);
  const rows = dbQ(BIZ_DB, 'SELECT * FROM products ORDER BY id');
  return { cols, byId: new Map(rows.map(r => [r.id, r])) };
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

let appProc;
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
function killAllApp() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
async function waitProcessGone(ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' }).Count"], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(400);
  }
  return false;
}
async function waitPortFree(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(500);
  }
  return false;
}
/** Bounded, NON-fatal: only the cross-surface section needs HTTP, and it says so itself if the
 *  server never came up rather than failing the whole suite at startup. */
async function serverHealthy(ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); }
  throw new Error('no invoke');
}

const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickSel = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }

async function frontendLogin(c) {
  await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin');
    await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`);
  }
  await waitFor(c, 'a[href="/settings"], nav a, [data-testid]', 30000);
}
async function ensureSignedIn(c) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    if (await exists(c, 'a[href="/settings"], nav a, [data-testid]')) return true;
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) {
      try { await frontendLogin(c); return true; } catch { await sleep(1000); }
    }
    await sleep(400);
  }
  throw new Error('app shell never appeared');
}

/** Stage products AT REST — the app is not running while this writes. */
function seedProducts(items) {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, quantity,
         notes, images, attributes, source_type, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'[]',?,'BHD','in_stock','MARGIN',0,?,?,'[]',?,'OWN',?,?)`);
    for (const it of items) {
      ins.run(it.id, branchId, it.categoryId, it.brand, it.name, it.sku, it.condition || 'Pre-Owned',
        it.purchasePrice ?? 100, it.quantity ?? 1, it.notes ?? null, JSON.stringify(it.attributes || {}), now, now);
    }
    return branchId;
  } finally { try { db.close(); } catch {} }
}

/** Write stock checks the way an older version of the app would have left them: at rest, with
 *  their own timestamps, straight into the shared history. */
function seedHistoricalChecks(items) {
  const db = new DatabaseSync(SERVER_DB);
  try {
    const ins = db.prepare(
      `INSERT INTO stock_checks (check_id, tenant_id, branch_id, product_id, status, notes,
         checked_at, checked_by, checked_by_name, source, request_id, created_at)
       VALUES (?, 'tenant-1', 'branch-main', ?, ?, ?, ?, NULL, 'Old Staff', 'desktop', NULL, ?)`);
    for (const it of items) ins.run(it.id, it.productId, it.status, it.notes, it.at, it.at);
  } finally { try { db.close(); } catch {} }
}

const FIXTURES = [
  { id: 'inv-a', categoryId: 'cat-watch', brand: 'Zenith', name: 'ZenTest Alpha', sku: 'ZEN-WCH-001', attributes: { reference_number: 'ZA-1', serial_number: 'SN-A' } },
  { id: 'inv-b', categoryId: 'cat-watch', brand: 'Zenith', name: 'ZenTest Beta', sku: 'ZEN-WCH-002', attributes: { reference_number: 'ZB-2', serial_number: 'SN-B' } },
  { id: 'inv-c', categoryId: 'cat-watch', brand: 'Zenith', name: 'ZenTest Gamma', sku: 'ZEN-WCH-003', attributes: { reference_number: 'ZC-3' } },
  { id: 'inv-d', categoryId: 'cat-accessory', brand: 'Otherbrand', name: 'Unrelated Strap', sku: 'OTH-ACC-001', attributes: {} },
];

// ── modal helpers: everything goes through the rendered DOM ──────────────────
const colIds = (c, kind) => c.ev(`const col=document.querySelector('[data-inv-col=${S(kind)}]'); if(!col) return null; return [...col.querySelectorAll('[data-inv-row]')].map(e=>e.getAttribute('data-inv-row'));`);
const clickAttr = (c, attr, id) => c.ev(`const e=document.querySelector('[data-inv-${attr}=${S(id)}]'); if(!e) return 'NO'; e.click(); return 'OK';`);
const progressText = (c) => c.ev(`const e=document.querySelector('[data-inv-progress]'); return e ? e.innerText.replace(/\\s+/g,' ').trim() : null;`);
const noteVal = (c, id) => c.ev(`const e=document.querySelector('[data-inv-note=${S(id)}]'); return e ? e.value : null;`);
/**
 * Hover a card the way a mouse does.
 *
 * React does NOT listen for `mouseenter`: it derives onMouseEnter from `mouseover`, so a dispatched
 * `mouseenter` reaches the DOM node and no React handler at all. `relatedTarget: null` reads as the
 * pointer entering the window, which makes React fire enter along the whole path to the row.
 */
const hoverRow = (c, id) => c.ev(`
  const r=document.querySelector('[data-inv-row=${S(id)}]'); if(!r) return 'NO';
  const b=r.getBoundingClientRect();
  const at={bubbles:true, cancelable:true, clientX:Math.round(b.x+8), clientY:Math.round(b.y+8), relatedTarget:null};
  r.dispatchEvent(new MouseEvent('mouseover', at));
  r.dispatchEvent(new MouseEvent('mousemove', at));
  return 'OK';`);
/**
 * The preview's own layer. Both the dialog and the preview are portalled to <body>, so they share the
 * root stacking context and comparing their z-indexes is the real comparison the browser makes. On a
 * miss the probe reports every body child it saw, so a failure says WHY rather than just "not found".
 */
const hoverProbe = (c, needle) => c.ev(`
  const kids=[...document.body.children];
  const fixed=(e)=>getComputedStyle(e).position==='fixed';
  const dialog=kids.find(e=>e.querySelector('[data-inv-col]'));
  const host=kids.find(e=>e!==dialog && fixed(e) && new RegExp(${S(needle)}).test(e.innerText||''));
  const z=(e)=>parseInt(getComputedStyle(e).zIndex||'0',10)||0;
  if(!host||!dialog) return { host: !!host, dialog: !!dialog,
    seen: kids.map(e=>e.tagName+'/'+(fixed(e)?'fixed':'static')+'/'+String(e.innerText||'').replace(/\\s+/g,' ').slice(0,40)) };
  return { host:true, dialog:true,
    text:String(host.innerText||'').replace(/\\s+/g,' ').trim().slice(0,90),
    direct: host.parentElement===document.body, hostZ:z(host), dialogZ:z(dialog),
    blurred: !!host.closest('[style*="backdrop-filter"]'), inDialog: dialog.contains(host) };`);
const sortedCol = async (c, kind) => ((await colIds(c, kind)) || []).slice().sort().join();

async function openModal(c) {
  await waitFor(c, '[data-testid="open-inventory"]', 20000);
  await clickSel(c, '[data-testid="open-inventory"]');
  await waitFor(c, '[data-inv-col="pending"]', 20000);
  // The columns paint from the worksheet immediately; checks made on another surface are folded in
  // when the history read comes back. Reading the columns before that is reading a half-open dialog.
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const tag = await c.ev(`const e=document.querySelector('[data-inv-merged]'); return e ? e.getAttribute('data-inv-merged') : null;`);
    if (tag) return;
    await sleep(200);
  }
}
async function waitModalClosed(c, t = 20000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (!(await exists(c, '[data-inv-col="pending"]'))) return true; await sleep(300); }
  return false;
}

async function main() {
  console.log('POST-V0838 §G3 — desktop inventory modal e2e');

  // ── isolation, then a clean slate ─────────────────────────────────────────
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });

  const prodBizBefore = existsSync(PROD_BIZ_DB) ? dbQ(PROD_BIZ_DB, 'SELECT COUNT(*) c FROM products') : [];
  const prodSrvBefore = existsSync(PROD_SRV_DB) ? dbQ(PROD_SRV_DB, 'SELECT COUNT(*) c FROM stock_checks') : [];

  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded on the isolated instance');

  let app = await startApp();
  await waitInvoke(app);
  await ensureSignedIn(app);

  // BOOTSTRAP — the install has already been recording stock checks for months before this feature
  // existed. Staged at rest with real June/July timestamps, so they sit below the line the first
  // boot wrote and can only ever be history.
  const bootAt = bootstrap();
  ok(!!bootAt, 'the first boot wrote a bootstrap line (' + bootAt + ')');

  // Restart with the fixtures staged at rest.
  app.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  seedProducts(FIXTURES);
  seedHistoricalChecks([
    { id: 'old-june', productId: 'inv-a', status: 'available', notes: 'seen in June', at: '2026-06-11T09:15:00.000000+00:00' },
    { id: 'old-july', productId: 'inv-b', status: 'not_available', notes: 'gone in July', at: '2026-07-04T14:40:00.000000+00:00' },
  ]);
  app = await startApp();
  await waitInvoke(app);
  await ensureSignedIn(app);

  ok(checks().length === 2, 'start state: only the two historical checks exist (' + checks().length + ')');
  const H0 = checks().length;          // the pre-existing history every count below is relative to
  ok(bootstrap() === bootAt, 'and a second boot did NOT move the bootstrap line (' + bootstrap() + ')');

  // ── §G3.1 — the modal takes the FILTERED working set ──────────────────────
  // Navigate the way the operator does: the sidebar. The INVENTORY group is collapsed until it is
  // opened, so the link only exists after that click - hence expand first, then follow the link.
  // No location.href anywhere: a hard navigation would reload the app and drop the session.
  const gotoCollection = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const direct = await app.ev(`const a=document.querySelector('a[href="/collection"]'); if(!a) return 'NONE'; a.click(); return 'OK';`);
      if (direct === 'OK') return 'OK';
      await app.ev(`const g=[...document.querySelectorAll('div,button,span')].find(e=>e.children.length===0 && /^\s*INVENTORY\s*$/i.test(e.textContent||'')); if(g){ (g.closest('button')||g).click(); return 'EXPANDED'; } return 'NOGROUP';`);
      await sleep(600);
    }
    return 'FAILED';
  };
  const navigated = await gotoCollection();
  ok(navigated === 'OK', 'the Collection page is reachable from the sidebar (' + navigated + ')');
  await sleep(1500);
  await waitFor(app, '[data-testid="open-inventory"]', 30000);

  // unfiltered first, so the filtered number afterwards means something
  await openModal(app);
  const allPending = await colIds(app, 'pending');
  ok(Array.isArray(allPending) && allPending.length === FIXTURES.length,
    '§G3.1 unfiltered: the modal offers every product (' + (allPending || []).length + ' of ' + FIXTURES.length + ')');
  // BOOTSTRAP — the two historical verdicts are in the history and NOT in the columns.
  ok((await colIds(app, 'available') || []).length === 0, '§G3.1 the June check did not fill a column');
  ok((await colIds(app, 'not_available') || []).length === 0, '§G3.1 nor did the July one');
  ok(checks().length === 2, '§G3.1 while both are still in the history (' + checks().length + ')');
  ok(bootstrap() === bootAt, '§G3.1 and opening the dialog did not move the bootstrap line');
  await clickText(app, 'Cancel');
  await sleep(400);

  // now narrow the Collection down with its own search box
  const searchSel = 'input[placeholder="Search by brand, name, SKU..."]';
  await waitFor(app, searchSel, 15000);
  await setVal(app, searchSel, 'ZenTest');
  await sleep(900);
  await openModal(app);
  const filtered = await colIds(app, 'pending');
  ok(filtered && filtered.length === 3, '§G3.1 filtered: exactly the 3 matching products are offered (' + (filtered || []).length + ')');
  ok(filtered && !filtered.includes('inv-d'), '§G3.1 the filtered-out product is NOT hidden in the modal');
  ok((await progressText(app) || '').startsWith('0 / 3'), '§G3.1 progress counts the working set, not the whole stock');

  // ── §G3.2 — the shared hover card ─────────────────────────────────────────
  await hoverRow(app, 'inv-a');
  await sleep(500);
  const hov = await hoverProbe(app, 'ZenTest Alpha');
  ok(hov && hov.host === true, '§G3.2 the hover preview really renders, in its own layer (' + S(hov) + ')');
  ok(hov && /Zenith/.test(hov.text || ''), '§G3.2 and it shows the product it belongs to (' + (hov || {}).text + ')');

  // ── §G3.3 — every move is a draft; nothing is written ─────────────────────
  const before = productRows();
  await clickAttr(app, 'yes', 'inv-a');
  await clickAttr(app, 'no', 'inv-b');
  await sleep(300);
  await setVal(app, '[data-inv-note="inv-a"]', 'in safe');
  await setVal(app, '[data-inv-note="inv-b"]', 'with customer');
  await sleep(200);
  ok((await colIds(app, 'available') || []).join() === 'inv-a', '§G3.3 A sits in Available');
  ok((await colIds(app, 'not_available') || []).join() === 'inv-b', '§G3.3 B sits in Not available');

  await clickAttr(app, 'flip', 'inv-a');          // A: available → not available
  await sleep(250);
  ok((await colIds(app, 'not_available') || []).sort().join() === 'inv-a,inv-b', '§G3.3 A was reclassified without a write');
  await clickAttr(app, 'undo', 'inv-b');          // B: back to unchecked
  await sleep(250);
  ok((await colIds(app, 'pending') || []).includes('inv-b'), '§G3.3 B went back to "to check"');
  await clickAttr(app, 'yes', 'inv-b');           // B: → available
  await sleep(250);
  ok((await colIds(app, 'available') || []).join() === 'inv-b', '§G3.3 B is available again');

  ok(checks().length === H0, '§G3.3 after six moves NOTHING new was written (' + (checks().length - H0) + ')');

  // ── §G3.4 — the close guard ───────────────────────────────────────────────
  await app.ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return 1;`);
  await sleep(500);
  const guardShown = await app.ev(`return /unsaved stock-check/i.test(document.body.innerText||'');`);
  ok(guardShown === true, '§G3.4 Escape with a draft raises the unsaved warning instead of closing');
  await clickText(app, 'Continue editing');
  await sleep(400);
  ok((await colIds(app, 'not_available') || []).includes('inv-a'), '§G3.4 Continue editing keeps the draft intact');
  ok(checks().length === H0, '§G3.4 and still nothing is written');

  // ── §G3.5 — Save writes the FINAL decisions only ──────────────────────────
  await setVal(app, '[data-inv-note="inv-b"]', 'shelf 2');
  await sleep(200);
  await clickSel(app, '[data-testid="inv-save"]');
  const savedEnd = Date.now() + 20000;
  while (Date.now() < savedEnd && checks().length < H0 + 2) await sleep(400);
  const afterSave = checks();
  ok(afterSave.length === H0 + 2, '§G3.5 exactly two checks were written — one per final decision (' + (afterSave.length - H0) + ')');
  const mine = afterSave.filter(r => r.source === 'desktop' && r.checked_by_name !== 'Old Staff');
  const byProduct = Object.fromEntries(mine.map(r => [r.product_id, r]));
  ok(byProduct['inv-a'] && byProduct['inv-a'].status === 'not_available', '§G3.5 A stored its FINAL status, not the first click');
  ok(byProduct['inv-b'] && byProduct['inv-b'].status === 'available', '§G3.5 B stored available');
  ok(byProduct['inv-a'] && byProduct['inv-a'].notes === 'in safe', '§G3.5 A kept its note');
  ok(byProduct['inv-b'] && byProduct['inv-b'].notes === 'shelf 2', '§G3.5 B kept the note it was edited to');
  ok(mine.every(r => r.source === 'desktop'), '§G3.5 both were recorded as desktop checks');
  ok(mine.every(r => !!r.checked_by_name), '§G3.5 both carry an actor');
  ok(!mine.some(r => r.product_id === 'inv-c'), '§G3.5 the product left unassigned got NO check');
  ok(!mine.some(r => r.product_id === 'inv-d'), '§G3.5 the filtered-out product got no check either');
  ok(new Set(mine.map(r => r.request_id)).size === 2, '§G3.5 each check carries its own request id');

  // ── §G3.6 — a second Save adds nothing ────────────────────────────────────
  await sleep(600);
  const stillOpen = await exists(app, '[data-inv-col="pending"]');
  if (stillOpen) { await clickSel(app, '[data-testid="inv-save"]'); await sleep(1500); }
  // reopen and save an empty draft — the realistic "pressed it twice" shape
  if (!stillOpen) {
    await openModal(app);
    await clickSel(app, '[data-testid="inv-save"]');
    await sleep(1200);
    await clickText(app, 'Cancel');
    await sleep(300);
  }
  ok(checks().length === H0 + 2, '§G3.6 a second Save produced no further events (' + (checks().length - H0) + ')');

  // ── §G3.7 — a refused note is not a silent success ────────────────────────
  await openModal(app);
  await clickAttr(app, 'yes', 'inv-c');
  await sleep(300);
  await setVal(app, '[data-inv-note="inv-c"]', 'x'.repeat(501));
  await sleep(200);
  await clickSel(app, '[data-testid="inv-save"]');
  await sleep(1200);
  ok(checks().length === H0 + 2, '§G3.7 an over-long note saved NOTHING at all — no partial batch');
  const stayedOpen = await exists(app, '[data-inv-col="pending"]');
  ok(stayedOpen === true, '§G3.7 and the modal stayed open instead of reporting success');
  const complained = await app.ev(`return /longer than 500/i.test(document.body.innerText||'');`);
  ok(complained === true, '§G3.7 with the reason shown to the operator');
  // fix it and save for real
  await setVal(app, '[data-inv-note="inv-c"]', 'ok now');
  await sleep(200);
  await clickSel(app, '[data-testid="inv-save"]');
  const end3 = Date.now() + 20000;
  while (Date.now() < end3 && checks().length < H0 + 3) await sleep(400);
  ok(checks().length === H0 + 3, '§G3.7 after the fix exactly one more check was written (' + (checks().length - H0) + ')');

  // ── §G3.8 — not one product column moved ──────────────────────────────────
  const after = productRows();
  ok(after.byId.size === before.byId.size, '§G3.8 the product count is unchanged (' + before.byId.size + ' → ' + after.byId.size + ')');
  let diffs = [];
  for (const [id, row] of before.byId) {
    const now = after.byId.get(id);
    if (!now) { diffs.push(id + ':missing'); continue; }
    for (const col of before.cols) {
      if (String(row[col] ?? '') !== String(now[col] ?? '')) diffs.push(id + '.' + col);
    }
  }
  ok(diffs.length === 0, '§G3.8 every product column is identical after the checks (' + diffs.slice(0, 6).join(', ') + ')');
  ok(before.cols.length > 15, '§G3.8 and the comparison really covered the whole row (' + before.cols.length + ' columns)');

  // ── §G3.9 — the same history over the mobile API ──────────────────────────
  const healthy = await serverHealthy();
  ok(healthy, '§G3.9 the isolated sync server is reachable for the cross-surface read');
  const token = !healthy ? null : await (async () => {
    // The SAME endpoint and payload the mobile page itself posts. The sync server authenticates
    // against its OWN seeded owner credential, not the desktop onboarding password.
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
    }).catch(() => null);
    if (!r || !r.ok) { console.log('  (login http ' + (r ? r.status : 'no response') + ')'); return null; }
    const j = await r.json().catch(() => null);
    return j && j.token ? j.token : null;
  })();
  if (!token) {
    ok(false, '§G3.9 could not obtain a mobile token — cross-surface read not proven');
  } else {
    const res = await fetch(`${BASE}/api/stock-checks?product_id=inv-a&limit=20`, { headers: { Authorization: 'Bearer ' + token } });
    const body = res.ok ? await res.json() : null;
    const list = body && Array.isArray(body.checks) ? body.checks : [];
    const mine = list.find(x => x.product_id === 'inv-a');
    ok(res.ok, '§G3.9 the mobile surface can read the history (' + res.status + ')');
    ok(!!mine, '§G3.9 the desktop batch check is visible from mobile');
    if (mine) {
      ok(mine.status === 'not_available', '§G3.9 with the same status');
      ok(mine.notes === 'in safe', '§G3.9 the same note');
      ok(mine.source === 'desktop', '§G3.9 and it is labelled as a desktop check');
      ok(!!mine.checked_at && !!mine.checked_by_name, '§G3.9 timestamp and actor came across too');
    }

    // The other direction — a phone check landing in the same history — is proven in the
    // cross-surface section below, where it also has to move the card, not just add a row.
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INVENTORY-SESSION — an inventory is a RUN, not a document that dies with the dialog.
  //
  // Everything below is about the worksheet: the three columns as the operator left them. It has to
  // survive Save, closing the dialog, and killing the process; only an explicit finish clears it; and
  // it must never be confused with the stock-check HISTORY, which is append-only and is not touched
  // by any of this. Counts are relative to whatever the sections above produced, so a skipped
  // cross-surface block cannot silently turn these into false passes.
  // ══════════════════════════════════════════════════════════════════════════
  const base = checks().length;
  const setFilter = async (term) => {
    await waitFor(app, searchSel, 15000);
    await setVal(app, searchSel, term);
    await sleep(900);
  };
  /** Kill the app, optionally change the world while it is down, bring it back to the Collection. */
  const reopenApp = async (mutate) => {
    try { app.close(); } catch {}
    killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
    if (mutate) atRest(mutate);
    app = await startApp();
    await waitInvoke(app);
    await ensureSignedIn(app);
    const nav = await gotoCollection();
    await sleep(1500);
    await waitFor(app, '[data-testid="open-inventory"]', 30000);
    return nav;
  };

  // ── §G3.10 — reopening after Save restores the columns, not a blank sheet ──
  // The whole reason this exists: the operator saved yesterday and came back to three empty columns.
  await openModal(app);
  ok(await sortedCol(app, 'available') === 'inv-b,inv-c', '§G3.10 both saved "available" items came back (' + (await colIds(app, 'available') || []).join() + ')');
  ok(await sortedCol(app, 'not_available') === 'inv-a', '§G3.10 the saved "not available" item came back too');
  ok((await colIds(app, 'pending') || []).length === 0, '§G3.10 nothing fell back into "to check"');
  ok((await progressText(app) || '').startsWith('3 / 3'), '§G3.10 progress reflects the restored run (' + await progressText(app) + ')');
  ok(await noteVal(app, 'inv-a') === 'in safe', '§G3.10 the note came back with the card');
  ok(await noteVal(app, 'inv-c') === 'ok now', '§G3.10 and so did the note that was corrected before saving');
  ok(sessions().filter(s => s.status === 'open').length === 1, '§G3.10 exactly one open worksheet exists (' + sessions().length + ' total)');
  ok(sessionItems().length === 3, '§G3.10 the worksheet holds one row per decided product (' + sessionItems().length + ')');

  // ── §G3.11 — Save with nothing changed writes NOTHING ──────────────────────
  // Restoring a run must not re-report it: the columns are already-observed facts, not new sightings.
  await clickSel(app, '[data-testid="inv-save"]');
  await sleep(1500);
  ok(checks().length === base, '§G3.11 a Save with no change added no history at all (' + (checks().length - base) + ' new)');
  ok(await waitModalClosed(app), '§G3.11 and the dialog closed rather than pretending to work');
  ok(sessionItems().length === 3, '§G3.11 the worksheet is unchanged as well');

  // ── §G3.12 — a corrected verdict writes exactly ONE new observation ────────
  // The history is append-only: re-deciding is a NEW sighting, and the old one must stay readable.
  await openModal(app);
  await clickAttr(app, 'flip', 'inv-c');                 // available → not available
  await sleep(300);
  await clickSel(app, '[data-testid="inv-save"]');
  const e12 = Date.now() + 20000;
  while (Date.now() < e12 && checks().length < base + 1) await sleep(400);
  ok(checks().length === base + 1, '§G3.12 the changed status wrote exactly one new event (' + (checks().length - base) + ')');
  const cRows = checks().filter(r => r.product_id === 'inv-c');
  ok(cRows.length === 2, '§G3.12 the product now has two observations, not an overwritten one (' + cRows.length + ')');
  ok(cRows.some(r => r.status === 'not_available'), '§G3.12 the corrected verdict is on record');
  ok(cRows.some(r => r.status === 'available'), '§G3.12 and the earlier one still says what was seen then');
  ok(new Set(cRows.map(r => r.request_id)).size === 2, '§G3.12 under a fresh request id, so it is not deduped away');

  // ── §G3.13 — a changed NOTE alone is also exactly one new observation ──────
  await openModal(app);
  await setVal(app, '[data-inv-note="inv-b"]', 'shelf 9');
  await sleep(300);
  await clickSel(app, '[data-testid="inv-save"]');
  const e13 = Date.now() + 20000;
  while (Date.now() < e13 && checks().length < base + 2) await sleep(400);
  ok(checks().length === base + 2, '§G3.13 editing only the note wrote exactly one new event (' + (checks().length - base - 1) + ')');
  // The install's own July verdict is in this list too; the claims below are about what THIS
  // run recorded, so the pre-existing row is left out of them.
  const bRows = checks().filter(r => r.product_id === 'inv-b' && r.checked_by_name !== 'Old Staff');
  ok(bRows.some(r => r.notes === 'shelf 9'), '§G3.13 with the new note');
  ok(bRows.some(r => r.notes === 'shelf 2'), '§G3.13 and the previous note is still on record');
  ok(bRows.every(r => r.status === 'available'), '§G3.13 the verdict itself was not touched');

  // ── §G3.14 — narrowing the filter must not delete what it hides ────────────
  // The worksheet mirrors the screen, so "decided but no longer shown" would be indistinguishable
  // from "put back to to-check" unless removal is restricted to rows the operator could actually see.
  await setFilter('ZenTest Alpha');
  await openModal(app);
  const narrowAll = [...(await colIds(app, 'pending') || []), ...(await colIds(app, 'available') || []), ...(await colIds(app, 'not_available') || [])];
  ok(narrowAll.length === 1 && narrowAll[0] === 'inv-a', '§G3.14 the narrowed modal shows only the matching product (' + narrowAll.join() + ')');
  await clickAttr(app, 'undo', 'inv-a');                 // the only VISIBLE decision is taken back
  await sleep(300);
  await clickSel(app, '[data-testid="inv-save"]');
  ok(await waitModalClosed(app), '§G3.14 taking a decision back saves and closes');
  ok(checks().length === base + 2, '§G3.14 un-deciding wrote no history — it was never an observation');
  const afterNarrow = sessionItems().filter(r => r.status !== 'to_check').map(r => r.product_id).sort().join();
  ok(afterNarrow === 'inv-b,inv-c', '§G3.14 the hidden items survived while the visible one was removed (' + afterNarrow + ')');

  await setFilter('ZenTest');
  await openModal(app);
  ok(await sortedCol(app, 'available') === 'inv-b', '§G3.14 widening the filter brings the hidden decision back (' + (await colIds(app, 'available') || []).join() + ')');
  ok(await sortedCol(app, 'not_available') === 'inv-c', '§G3.14 with its corrected verdict intact');
  ok((await colIds(app, 'pending') || []).join() === 'inv-a', '§G3.14 and the un-decided product is back in "to check"');
  await clickText(app, 'Cancel');
  await sleep(400);

  // ── §G3.15 — the worksheet survives the process being KILLED ───────────────
  // Not a graceful shutdown: the run has to be on disk the moment it was saved, not at exit.
  await reopenApp(null);
  await setFilter('ZenTest');
  await openModal(app);
  ok(await sortedCol(app, 'available') === 'inv-b', '§G3.15 after a restart the available column is restored (' + (await colIds(app, 'available') || []).join() + ')');
  ok(await sortedCol(app, 'not_available') === 'inv-c', '§G3.15 and the not-available column too');
  ok((await colIds(app, 'pending') || []).join() === 'inv-a', '§G3.15 with the undecided product still undecided');
  ok(await noteVal(app, 'inv-b') === 'shelf 9', '§G3.15 notes survived the restart as well');
  ok(checks().length === base + 2, '§G3.15 and the restart itself wrote no history');

  // ── §G3.16 / §G3.17 — a sold product, and another branch's run ─────────────
  // Staged at rest: inv-c leaves the stock entirely, and a SECOND branch gets an open worksheet whose
  // newer timestamp would win any query that forgot to filter by branch.
  const ourBranch = String((sessions().find(s => s.status === 'open') || {}).branch_id || '');
  ok(!!ourBranch, '§G3.17 the open worksheet is bound to a branch (' + ourBranch + ')');
  await reopenApp((db) => {
    db.prepare('DELETE FROM products WHERE id = ?').run('inv-c');
    const t = new Date(Date.now() + 60000).toISOString();
    db.prepare(`INSERT INTO inventory_sessions (session_id, branch_id, status, started_at, closed_at, updated_at)
                VALUES (?,?,'open',?,NULL,?)`).run('sess-foreign', 'branch-e2e-other', t, t);
    db.prepare(`INSERT INTO inventory_session_items (session_id, product_id, status, notes, updated_at)
                VALUES (?,?,?,?,?)`).run('sess-foreign', 'inv-a', 'available', 'foreign branch', t);
  });
  await setFilter('ZenTest');
  await openModal(app);
  ok(await sortedCol(app, 'available') === 'inv-b', '§G3.16 the sold product is simply gone from the columns (' + (await colIds(app, 'available') || []).join() + ')');
  ok(await sortedCol(app, 'not_available') === '', '§G3.16 its column is empty rather than showing a dangling card');
  ok((await progressText(app) || '').startsWith('1 / 2'), '§G3.16 progress counts what exists, not what the worksheet remembers (' + await progressText(app) + ')');
  ok(checks().filter(r => r.product_id === 'inv-c').length === 2, '§G3.16 and deleting the product left its history untouched');

  ok((await colIds(app, 'pending') || []).join() === 'inv-a', '§G3.17 the other branch\'s decision did NOT leak into this run');
  ok(await sortedCol(app, 'available') !== 'inv-a,inv-b', '§G3.17 inv-a stayed undecided despite the newer foreign worksheet');

  // ── §G3.18 — the hover preview sits above the dialog's blurred backdrop ────
  // Both the dialog and the preview are children of <body>, so they share the root stacking context
  // and the z-index comparison is the real one. A preview rendered inside the page tree instead would
  // be trapped below the backdrop no matter what z-index it carried.
  await hoverRow(app, 'inv-b');
  await sleep(500);
  const layer = await hoverProbe(app, 'ZenTest Beta');
  ok(layer && layer.host === true, '§G3.18 the hover preview is rendered (' + S(layer) + ')');
  ok(layer && layer.direct === true, '§G3.18 as a direct child of <body>, in the dialog\'s own layer');
  ok(layer && layer.inDialog === false, '§G3.18 and not nested inside the dialog panel');
  ok(layer && layer.hostZ > layer.dialogZ, '§G3.18 above the dialog (' + (layer || {}).hostZ + ' > ' + (layer || {}).dialogZ + ')');
  ok(layer && layer.blurred === false, '§G3.18 and outside anything that paints the backdrop blur');

  // ── §G3.19 — Finish puts the WORKSHEET away and nothing else ───────────────
  const beforeFinish = checks().length;
  await clickSel(app, '[data-testid="inv-finish"]');
  await waitFor(app, '[data-testid="inv-finish-confirm"]', 10000);
  ok(sessionItems().some(r => r.session_id !== 'sess-foreign'), '§G3.19 the worksheet is still there while the question is open');
  await clickSel(app, '[data-testid="inv-finish-confirm"]');
  const e19 = Date.now() + 20000;
  while (Date.now() < e19 && sessions().some(s => s.session_id !== 'sess-foreign' && s.status === 'open')) await sleep(400);

  ok((await colIds(app, 'available') || []).length === 0, '§G3.19 the columns are empty immediately after finishing');
  ok((await colIds(app, 'not_available') || []).length === 0, '§G3.19 both of them');
  ok((await colIds(app, 'pending') || []).sort().join() === 'inv-a,inv-b', '§G3.19 everything is back in "to check"');

  const ours = sessions().filter(s => s.session_id !== 'sess-foreign');
  ok(ours.length > 0 && ours.every(s => s.status === 'closed'), '§G3.19 this branch\'s worksheet is closed (' + ours.map(s => s.status).join() + ')');
  ok(ours.every(s => !!s.closed_at), '§G3.19 with the moment it was put away recorded');
  ok(sessionItems().every(r => r.session_id === 'sess-foreign'), '§G3.19 and its item rows are gone');

  ok(checks().length === beforeFinish, '§G3.19 finishing deleted NOTHING from the history (' + beforeFinish + ' → ' + checks().length + ')');
  ok(checks().filter(r => r.product_id === 'inv-c').length === 2, '§G3.19 including the history of a product that no longer exists');
  ok(checks().filter(r => r.product_id === 'inv-b').length >= 2, '§G3.19 and every observation of the finished run');

  const foreign = sessions().find(s => s.session_id === 'sess-foreign');
  ok(!!foreign && foreign.status === 'open', '§G3.19 the other branch\'s run was NOT closed along with it');
  ok(sessionItems().filter(r => r.session_id === 'sess-foreign').length === 1, '§G3.19 and its worksheet still holds its item');

  // and it stays finished — reopening starts a clean sheet
  await clickText(app, 'Cancel');
  await sleep(500);
  await openModal(app);
  ok((await colIds(app, 'pending') || []).sort().join() === 'inv-a,inv-b', '§G3.19 reopening starts empty — the run does not come back');
  ok((await progressText(app) || '').startsWith('0 / 2'), '§G3.19 with the progress reset (' + await progressText(app) + ')');
  await clickText(app, 'Cancel');
  await sleep(400);

  // ══════════════════════════════════════════════════════════════════════════
  // CROSS-SURFACE — a phone check has to move the card, not just add a line to the history.
  //
  // The operator walks the shelf with the phone while the desktop inventory is open. What they
  // record there is an observation of the same run, so when the desktop comes back it must find
  // those items already in the right column, with their notes, and everything else still waiting.
  // ══════════════════════════════════════════════════════════════════════════
  const beforeCross = productRows();
  const ourSession = () => sessions().find(s => s.session_id !== 'sess-foreign' && s.status === 'open');
  const itemOf = (pid) => sessionItems().find(r => r.product_id === pid && r.session_id !== 'sess-foreign');
  /** The SAME endpoint the phone posts to — no shortcut through the desktop core. */
  async function phoneCheck(productId, status, notes) {
    const rid = 'e2e-phone-' + productId + '-' + Date.now();
    const res = await fetch(`${BASE}/api/stock-checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ product_id: productId, status, notes, request_id: rid }),
    });
    return { ok: res.ok, status: res.status, rid };
  }

  if (!token) {
    ok(false, 'CROSS-SURFACE: no mobile token — the merge could not be proven');
  } else {
    ok(!!ourSession(), 'G3.20 opening the dialog started a run (' + S(ourSession() || null) + ')');
    const runStart = ourSession().started_at;
    const histBefore = checks().length;

    // -- G3.20 — the phone fills a column ------------------------------------
    const p1 = await phoneCheck('inv-a', 'available', 'phone shelf');
    ok(p1.ok, 'G3.20 the phone recorded a check (' + p1.status + ')');
    ok(checks().length === histBefore + 1, 'G3.20 which is one history event (' + (checks().length - histBefore) + ')');

    await openModal(app);
    ok(await sortedCol(app, 'available') === 'inv-a', 'G3.20 the desktop opens with it already in Available (' + (await colIds(app, 'available') || []).join() + ')');
    ok(await noteVal(app, 'inv-a') === 'phone shelf', 'G3.20 carrying the note the phone wrote (' + await noteVal(app, 'inv-a') + ')');
    ok((await colIds(app, 'pending') || []).join() === 'inv-b', 'G3.20 and everything unchecked is still waiting');
    ok((await progressText(app) || '').startsWith('1 / 2'), 'G3.20 progress counts it (' + await progressText(app) + ')');
    ok(checks().length === histBefore + 1, 'G3.20 folding it in wrote NO second observation');
    const mergedRow = itemOf('inv-a');
    ok(!!mergedRow && mergedRow.status === 'available', 'G3.20 the worksheet holds it (' + S(mergedRow) + ')');
    ok(!!mergedRow && !!mergedRow.applied_check_id, 'G3.20 tagged with the observation it came from');
    const foldTag = await app.ev(`const e=document.querySelector('[data-inv-merged]'); return e ? (e.getAttribute('data-inv-merged') + '|hist=' + e.getAttribute('data-inv-history') + '|run=' + e.getAttribute('data-inv-run')) : null;`);
    ok(String(foldTag).startsWith('1|'), 'G3.20 the fold-in reports exactly one card taken from the phone (' + foldTag + ' vs db start ' + runStart + ', check at ' + (checks().find(c => c.product_id === 'inv-a') || {}).checked_at + ')');

    // a Save with nothing else changed must stay silent — the item is already on record
    await clickSel(app, '[data-testid="inv-save"]');
    await sleep(1500);
    ok(checks().length === histBefore + 1, 'G3.20 and pressing Save does not re-report it (' + (checks().length - histBefore) + ')');
    await waitModalClosed(app);

    // -- G3.21 — the newer observation wins, both stay on record --------------
    // Counted as a delta: this product was already checked in the earlier sections, so an absolute
    // number here would only be asserting how long the suite is.
    const bBefore = checks().filter(r => r.product_id === 'inv-b').length;
    await openModal(app);
    await clickAttr(app, 'yes', 'inv-b');
    await sleep(300);
    await setVal(app, '[data-inv-note="inv-b"]', 'desk says here');
    await sleep(300);
    await clickSel(app, '[data-testid="inv-save"]');
    const e21 = Date.now() + 20000;
    while (Date.now() < e21 && checks().length < histBefore + 2) await sleep(400);
    ok(checks().length === histBefore + 2, 'G3.21 the desktop recorded its own verdict (' + (checks().length - histBefore) + ')');
    await waitModalClosed(app);

    await sleep(1100);                       // the phone disagrees, a moment later
    const p2 = await phoneCheck('inv-b', 'not_available', 'not on the shelf');
    ok(p2.ok, 'G3.21 the phone overrules it (' + p2.status + ')');

    await openModal(app);
    ok(await sortedCol(app, 'not_available') === 'inv-b', 'G3.21 the desktop reopens with the phone verdict (' + (await colIds(app, 'not_available') || []).join() + ')');
    ok(await noteVal(app, 'inv-b') === 'not on the shelf', 'G3.21 and the phone note replaced the desktop one');
    const bHist = checks().filter(r => r.product_id === 'inv-b');
    ok(bHist.some(r => r.status === 'available' && r.notes === 'desk says here'), 'G3.21 the desktop observation is still on record');
    ok(bHist.some(r => r.status === 'not_available'), 'G3.21 next to the phone one — nothing was overwritten');
    ok(new Set(bHist.map(r => r.source)).size === 2, 'G3.21 one shared history holds both surfaces (' + bHist.map(r => r.source).join(',') + ')');

    // the operator corrects it back: a NEW event, not an edit of an old row
    const histBeforeFix = checks().length;
    await clickAttr(app, 'flip', 'inv-b');
    await sleep(300);
    await clickSel(app, '[data-testid="inv-save"]');
    const e21b = Date.now() + 20000;
    while (Date.now() < e21b && checks().length < histBeforeFix + 1) await sleep(400);
    ok(checks().length === histBeforeFix + 1, 'G3.21 correcting it writes exactly one more event');
    ok(checks().filter(r => r.product_id === 'inv-b').length === bBefore + 3, 'G3.21 so all three new sightings survive next to the older ones (' + bBefore + ' -> ' + checks().filter(r => r.product_id === 'inv-b').length + ')');
    await waitModalClosed(app);

    // -- G3.22 — a card taken back stays back --------------------------------
    // The phone check for inv-a is still the newest observation for it. Taking the card back must
    // not be quietly undone by folding that same observation in again on the next open.
    await openModal(app);
    await clickAttr(app, 'undo', 'inv-a');
    await sleep(300);
    const histBeforeUndo = checks().length;
    await clickSel(app, '[data-testid="inv-save"]');
    await waitModalClosed(app);
    ok(checks().length === histBeforeUndo, 'G3.22 taking a card back writes no history');
    await openModal(app);
    ok((await colIds(app, 'pending') || []).includes('inv-a'), 'G3.22 and it is still in To check after reopening (' + (await colIds(app, 'pending') || []).join() + ')');
    ok(itemOf('inv-a') && itemOf('inv-a').status === 'to_check', 'G3.22 recorded as taken back rather than deleted (' + S(itemOf('inv-a')) + ')');
    await clickText(app, 'Cancel');
    await sleep(500);

    // -- G3.23 — Finish is a real boundary -----------------------------------
    const histAtFinish = checks().length;
    await openModal(app);
    await clickSel(app, '[data-testid="inv-finish"]');
    await waitFor(app, '[data-testid="inv-finish-confirm"]', 10000);
    await clickSel(app, '[data-testid="inv-finish-confirm"]');
    await sleep(1500);
    await clickText(app, 'Cancel');
    await sleep(600);

    await openModal(app);
    ok((await colIds(app, 'pending') || []).sort().join() === 'inv-a,inv-b', 'G3.23 a new run starts with everything in To check (' + (await colIds(app, 'pending') || []).join() + ')');
    ok((await colIds(app, 'available') || []).length === 0, 'G3.23 no column inherited the old verdicts');
    ok((await colIds(app, 'not_available') || []).length === 0, 'G3.23 neither of them');
    ok(checks().length === histAtFinish, 'G3.23 and every historical observation is still there (' + histAtFinish + ' -> ' + checks().length + ')');
    const freshRun = ourSession();
    ok(!!freshRun && freshRun.started_at > runStart, 'G3.23 under a genuinely new run (' + (freshRun || {}).started_at + ' > ' + runStart + ')');

    // a phone check AFTER the new run started does count again
    await clickText(app, 'Cancel');
    await sleep(500);
    const p3 = await phoneCheck('inv-b', 'available', 'new run');
    ok(p3.ok, 'G3.23 the phone records into the new run (' + p3.status + ')');
    await openModal(app);
    ok(await sortedCol(app, 'available') === 'inv-b', 'G3.23 and that one DOES fill a column (' + (await colIds(app, 'available') || []).join() + ')');
    ok((await colIds(app, 'pending') || []).join() === 'inv-a', 'G3.23 while the old verdicts stay history');
    await clickText(app, 'Cancel');
    await sleep(500);

    // -- G3.26 — the phone starts the run, the desktop joins it later -------
    // The workflow this whole thing is for: nobody has opened an inventory, the shelf is walked with
    // the phone, and the desktop is opened afterwards. Those checks have to be waiting in the right
    // columns — a run that started when the dialog opened would show every card untouched.
    await openModal(app);
    await clickSel(app, '[data-testid="inv-finish"]');
    await waitFor(app, '[data-testid="inv-finish-confirm"]', 10000);
    await clickSel(app, '[data-testid="inv-finish-confirm"]');
    await sleep(1500);
    await clickText(app, 'Cancel');
    await sleep(800);
    ok(!ourSession(), 'G3.26 no inventory is running (' + S(sessions().filter(x => x.status === 'open').map(x => x.branch_id)) + ')');
    const closedAt = sessions().filter(x => x.session_id !== 'sess-foreign' && x.closed_at).map(x => x.closed_at).sort().pop();
    const histBeforePhoneFirst = checks().length;

    const f1 = await phoneCheck('inv-a', 'available', 'phone first A');
    await sleep(1100);
    const f2 = await phoneCheck('inv-b', 'not_available', 'phone first B');
    ok(f1.ok && f2.ok, 'G3.26 the phone recorded both checks with nothing open (' + f1.status + '/' + f2.status + ')');
    ok(!ourSession(), 'G3.26 and recording them did not need a desktop at all');

    await openModal(app);
    ok(await sortedCol(app, 'available') === 'inv-a', 'G3.26 opening the desktop finds A already in Available (' + (await colIds(app, 'available') || []).join() + ')');
    ok(await sortedCol(app, 'not_available') === 'inv-b', 'G3.26 and B in Not available (' + (await colIds(app, 'not_available') || []).join() + ')');
    ok(await noteVal(app, 'inv-a') === 'phone first A', 'G3.26 with A\'s note (' + await noteVal(app, 'inv-a') + ')');
    ok(await noteVal(app, 'inv-b') === 'phone first B', 'G3.26 and B\'s note (' + await noteVal(app, 'inv-b') + ')');
    ok((await colIds(app, 'pending') || []).length === 0, 'G3.26 nothing that was checked is still waiting');
    ok(checks().length === histBeforePhoneFirst + 2, 'G3.26 and opening wrote no history of its own (' + (checks().length - histBeforePhoneFirst) + ')');

    // The run was opened BY the phone check, so it begins at that observation, not at this moment —
    // and still after the finish, so none of the older verdicts came back with it.
    const joined = ourSession();
    const firstCheckAt = checks().filter(r => r.notes === 'phone first A').map(r => r.checked_at)[0];
    ok(!!joined, 'G3.26 a run is now open (' + S(joined || null) + ')');
    ok(!!joined && joined.started_at === firstCheckAt, 'G3.26 starting at the phone\'s first observation (' + (joined || {}).started_at + ' vs ' + firstCheckAt + ')');
    ok(!!joined && !!closedAt && joined.started_at > closedAt, 'G3.26 and after the run that was finished (' + (joined || {}).started_at + ' > ' + closedAt + ')');
    ok(sessions().filter(x => x.branch_id !== 'branch-e2e-other' && x.status === 'open').length === 1,
      'G3.26 still exactly one open run for this branch (' + sessions().filter(x => x.status === 'open').length + ' overall)');

    // Save must not re-report what the phone already recorded.
    await clickSel(app, '[data-testid="inv-save"]');
    await sleep(1500);
    ok(checks().length === histBeforePhoneFirst + 2, 'G3.26 pressing Save adds nothing — both are already on record');
    await waitModalClosed(app);

    const foreignAfter = sessionItems().filter(r => r.session_id === 'sess-foreign');
    ok(foreignAfter.length === 1 && foreignAfter[0].notes === 'foreign branch', 'G3.26 the other branch is still untouched');

    // -- G3.24 — the other branch was never touched --------------------------
    const foreignItems = sessionItems().filter(r => r.session_id === 'sess-foreign');
    ok(foreignItems.length === 1, 'G3.24 the other branch still holds exactly its own item (' + foreignItems.length + ')');
    ok(foreignItems[0] && foreignItems[0].notes === 'foreign branch', 'G3.24 unchanged by any of this');
    const foreignSess = sessions().find(s => s.session_id === 'sess-foreign');
    ok(!!foreignSess && foreignSess.status === 'open', 'G3.24 and its run is still open');
    ok(!sessionItems().some(r => r.session_id === 'sess-foreign' && r.product_id === 'inv-b'), 'G3.24 no phone check leaked into it');

    // -- G3.25 — none of it touched a product --------------------------------
    const afterCross = productRows();
    const moved = [];
    for (const [id, row] of beforeCross.byId) {
      const now = afterCross.byId.get(id);
      if (!now) { moved.push(id + ':missing'); continue; }
      for (const col of beforeCross.cols) {
        if (String(row[col] ?? '') !== String(now[col] ?? '')) moved.push(id + '.' + col);
      }
    }
    ok(moved.length === 0, 'G3.25 not one product column moved through the whole cross-surface run (' + moved.slice(0, 6).join(', ') + ')');
    ok(afterCross.byId.size === beforeCross.byId.size, 'G3.25 and no product appeared or vanished');
  }

  // -- production untouched ---------------------------------------------------
  const prodBizAfter = existsSync(PROD_BIZ_DB) ? dbQ(PROD_BIZ_DB, 'SELECT COUNT(*) c FROM products') : [];
  const prodSrvAfter = existsSync(PROD_SRV_DB) ? dbQ(PROD_SRV_DB, 'SELECT COUNT(*) c FROM stock_checks') : [];
  ok(JSON.stringify(prodBizBefore) === JSON.stringify(prodBizAfter), 'isolation: the production business DB is untouched');
  ok(JSON.stringify(prodSrvBefore) === JSON.stringify(prodSrvAfter), 'isolation: the production server DB is untouched');

  try { app.close(); } catch {}
  killAllApp();
  await waitProcessGone();
  rmSync(RUN, { recursive: true, force: true });

  console.log(`\nPOST-V0838 inventory-modal e2e: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}

main().catch((e) => { console.error(e); killAllApp(); process.exit(1); });
