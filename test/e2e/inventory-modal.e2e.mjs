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

async function openModal(c) {
  await waitFor(c, '[data-testid="open-inventory"]', 20000);
  await clickSel(c, '[data-testid="open-inventory"]');
  await waitFor(c, '[data-inv-col="pending"]', 20000);
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

  // Restart with the fixtures staged at rest.
  app.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  seedProducts(FIXTURES);
  app = await startApp();
  await waitInvoke(app);
  await ensureSignedIn(app);

  ok(checks().length === 0, 'start state: no stock checks exist yet (' + checks().length + ')');

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
  await app.ev(`const r=document.querySelector('[data-inv-row="inv-a"]'); if(!r) return 'NO'; const b=r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true,clientX:b.x+5,clientY:b.y+5})); return 'OK';`);
  await sleep(500);
  const hoverText = await app.ev(`const els=[...document.querySelectorAll('div')].filter(e=>/ZenTest Alpha/.test(e.innerText||'')); const top=els[els.length-1]; return top?top.innerText.replace(/\\s+/g,' ').trim().slice(0,300):null;`);
  ok(!!hoverText && /Zenith/.test(hoverText), '§G3.2 the hover preview shows the product (' + String(hoverText).slice(0, 60) + ')');

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

  ok(checks().length === 0, '§G3.3 after six moves the database still has ZERO checks (' + checks().length + ')');

  // ── §G3.4 — the close guard ───────────────────────────────────────────────
  await app.ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return 1;`);
  await sleep(500);
  const guardShown = await app.ev(`return /unsaved stock-check/i.test(document.body.innerText||'');`);
  ok(guardShown === true, '§G3.4 Escape with a draft raises the unsaved warning instead of closing');
  await clickText(app, 'Continue editing');
  await sleep(400);
  ok((await colIds(app, 'not_available') || []).includes('inv-a'), '§G3.4 Continue editing keeps the draft intact');
  ok(checks().length === 0, '§G3.4 and still nothing is written');

  // ── §G3.5 — Save writes the FINAL decisions only ──────────────────────────
  await setVal(app, '[data-inv-note="inv-b"]', 'shelf 2');
  await sleep(200);
  await clickSel(app, '[data-testid="inv-save"]');
  const savedEnd = Date.now() + 20000;
  while (Date.now() < savedEnd && checks().length < 2) await sleep(400);
  const afterSave = checks();
  ok(afterSave.length === 2, '§G3.5 exactly two checks were written — one per final decision (' + afterSave.length + ')');
  const byProduct = Object.fromEntries(afterSave.map(r => [r.product_id, r]));
  ok(byProduct['inv-a'] && byProduct['inv-a'].status === 'not_available', '§G3.5 A stored its FINAL status, not the first click');
  ok(byProduct['inv-b'] && byProduct['inv-b'].status === 'available', '§G3.5 B stored available');
  ok(byProduct['inv-a'] && byProduct['inv-a'].notes === 'in safe', '§G3.5 A kept its note');
  ok(byProduct['inv-b'] && byProduct['inv-b'].notes === 'shelf 2', '§G3.5 B kept the note it was edited to');
  ok(afterSave.every(r => r.source === 'desktop'), '§G3.5 both were recorded as desktop checks');
  ok(afterSave.every(r => !!r.checked_by_name), '§G3.5 both carry an actor');
  ok(!afterSave.some(r => r.product_id === 'inv-c'), '§G3.5 the product left unassigned got NO check');
  ok(!afterSave.some(r => r.product_id === 'inv-d'), '§G3.5 the filtered-out product got no check either');
  ok(new Set(afterSave.map(r => r.request_id)).size === 2, '§G3.5 each check carries its own request id');

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
  ok(checks().length === 2, '§G3.6 a second Save produced no further events (' + checks().length + ')');

  // ── §G3.7 — a refused note is not a silent success ────────────────────────
  await openModal(app);
  await clickAttr(app, 'yes', 'inv-c');
  await sleep(300);
  await setVal(app, '[data-inv-note="inv-c"]', 'x'.repeat(501));
  await sleep(200);
  await clickSel(app, '[data-testid="inv-save"]');
  await sleep(1200);
  ok(checks().length === 2, '§G3.7 an over-long note saved NOTHING at all — no partial batch');
  const stayedOpen = await exists(app, '[data-inv-col="pending"]');
  ok(stayedOpen === true, '§G3.7 and the modal stayed open instead of reporting success');
  const complained = await app.ev(`return /longer than 500/i.test(document.body.innerText||'');`);
  ok(complained === true, '§G3.7 with the reason shown to the operator');
  // fix it and save for real
  await setVal(app, '[data-inv-note="inv-c"]', 'ok now');
  await sleep(200);
  await clickSel(app, '[data-testid="inv-save"]');
  const end3 = Date.now() + 20000;
  while (Date.now() < end3 && checks().length < 3) await sleep(400);
  ok(checks().length === 3, '§G3.7 after the fix exactly one more check was written (' + checks().length + ')');

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

    // and the other direction: a mobile check appears in the desktop history
    const post = await fetch(`${BASE}/api/stock-checks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ product_id: 'inv-a', status: 'available', notes: 'seen on the phone', request_id: 'e2e-mobile-' + Date.now() }),
    });
    ok(post.ok, '§G3.9 the phone can record a check on the same product (' + post.status + ')');
    const both = checks().filter(r => r.product_id === 'inv-a');
    ok(both.length === 2, '§G3.9 one shared history holds both surfaces (' + both.length + ')');
    ok(new Set(both.map(r => r.source)).size === 2, '§G3.9 and the two rows name different sources');
  }

  // ── production untouched ──────────────────────────────────────────────────
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
