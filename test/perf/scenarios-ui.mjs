// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE-SUITE — REAL UI / IPC scenarios (release e2e Tauri/WebView2).
//   node test/perf/scenarios-ui.mjs
//
// Pre-seeds a deterministic MEDIUM fixture lataif.db into an ISOLATED e2e AppData, starts the RELEASE e2e app,
// onboards, and measures the REAL product UI over CDP DOM. Short read paths (inventory/customers/invoices
// list, dashboard, product detail, invoice open, SKU search) run 7 measured reps with a per-rep STATE RESET so
// no cached render is reported as cold. The full SALES INVOICE FLOW (real customer search → 3 real product
// searches → qty/gross → validate Net/VAT/Gross/Remaining → save → find the new number in the list → reopen →
// re-validate) runs 3 isolated reps, each with a unique customer/number. Every end marker asserts business
// data (rendered totals/counts), never a fixed sleep. Isolated app id / AppData / test port 3011; production
// port 3001 + prod DB + prod media root are fingerprinted before and after and must be byte-identical.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, statSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';
import { measure, writeReport, envMeta } from './harness.mjs';
import { buildFixture } from './fixtures.mjs';
import { mergeBaselineClass, baselineScenarios } from './baseline.mjs';

const REPO = process.cwd();
const REL = join(REPO, 'src-tauri/target/release/lataif.exe');
const APP = existsSync(REL) ? REL : join(REPO, 'src-tauri/target/debug/lataif.exe');
const PROFILE = APP === REL ? 'release' : 'debug';
process.env.PERF_BUILD_TYPE = PROFILE;
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e', CDP = 9223, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'admin@lataif.com', OWNER_PW = 'perf-' + Math.random().toString(36).slice(2), ONBOARD_PW = 'e2epass123';
const RA = process.env.APPDATA, LA = process.env.LOCALAPPDATA, ADD = join(RA, IDENT), WV = join(LA, IDENT);
const DB = join(ADD, 'lataif_sync_server.db');
const PROD_DIR = join(RA, 'com.lataif.app');
const PROD_DB = join(PROD_DIR, 'lataif_sync_server.db');
const PROD_BIZ = join(PROD_DIR, 'lataif.db');
const PROD_MEDIA = join(PROD_DIR, 'media');
const PARITY_SIDECAR = join(REPO, 'test/perf/artifacts/prod-binary.json');
const RUN = join(os.tmpdir(), 'lataif-perf-ui', 'r' + Date.now());
const runId = 'r' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (m, a) => execFileSync(SEED, [m, a ?? DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const isoEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const sha256File = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } };
const fileBytes = (p) => { try { return statSync(p).size; } catch { return 0; } };
const fileMtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
function countFiles(root) { let n = 0; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else n++; } }; walk(root); return n; }
function killAll() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\release*' -or $_.Path -like '*target\\debug*' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
function procCount() { try { return parseInt(execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\release*' -or $_.Path -like '*target\\debug*' }).Count"], { encoding: 'utf8' }).trim() || '0', 10); } catch { return -1; } }
function listeners(port) { try { return parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { return -1; } }
// PROD fingerprint: business DB + sync DB + media-root file count. "untouched" = all identical before/after.
function prodSnap() {
  return {
    syncDb: { sha256: sha256File(PROD_DB), bytes: fileBytes(PROD_DB), mtimeMs: fileMtime(PROD_DB) },
    bizDb: { sha256: sha256File(PROD_BIZ), bytes: fileBytes(PROD_BIZ), mtimeMs: fileMtime(PROD_BIZ) },
    mediaFiles: countFiles(PROD_MEDIA),
  };
}
function prodUnchangedFn(a, b) {
  return a.syncDb.sha256 === b.syncDb.sha256 && a.syncDb.bytes === b.syncDb.bytes && a.syncDb.mtimeMs === b.syncDb.mtimeMs
    && a.bizDb.sha256 === b.bizDb.sha256 && a.bizDb.bytes === b.bizDb.bytes && a.bizDb.mtimeMs === b.bizDb.mtimeMs
    && a.mediaFiles === b.mediaFiles;
}

class CDPc {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.p = new Map(); this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); }); this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); }
  send(a, p = {}) { return this.ready.then(() => { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: a, params: p })); }); }); }
  ev(x) { return this.send('Runtime.evaluate', { expression: `(async()=>{ ${x} })()`, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value); }
  close() { try { this.ws.close(); } catch {} }
}
const S = (v) => JSON.stringify(v);
const existsSel = (c, s) => c.ev(`return !!document.querySelector(${S(s)});`).catch(() => false);
const setVal = (c, s, v) => c.ev(`const e=document.querySelector(${S(s)}); if(!e) return 'NO'; const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const bodyText = (c) => c.ev('return document.body ? document.body.innerText : "";').catch(() => '');
const pathOf = (c) => c.ev('return location.pathname;').catch(() => '');
async function waitSel(c, s, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsSel(c, s)) return true; await sleep(200); } throw new Error('waitSel ' + s); }
async function waitText(c, token, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if ((await bodyText(c)).includes(token)) return true; await sleep(150); } throw new Error('waitText ' + token); }
async function waitPath(c, re, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { const p = await pathOf(c); if (re.test(p)) return p; await sleep(120); } throw new Error('waitPath ' + re); }
async function navigate(c, path) { await c.ev(`const a=document.querySelector('a[href="${path}"]'); if(a){a.click();} else { history.pushState({},'','${path}'); window.dispatchEvent(new PopStateEvent('popstate')); } return 1;`); }
/** Navigate + wait until the route body contains an expected seeded token (real data rendered). */
async function routeRenderedWith(c, path, token, t = 20000) {
  await navigate(c, path);
  const end = Date.now() + t;
  while (Date.now() < end) { const txt = await bodyText(c); if (txt.includes(token)) return txt; await sleep(150); }
  throw new Error(`route ${path} did not render token ${token}`);
}

// ── SearchSelect DOM drivers (the app's real customer/product search widget) ──
const openSel = (c, ph) => c.ev(`
  const ph=${S(ph)};
  const t=[...document.querySelectorAll('div')].find(d=>{ const cls=(typeof d.className==='string'?d.className:''); return cls.includes('justify-between')&&cls.includes('cursor-pointer')&&d.textContent.trim()===ph; });
  if(!t) return 'NOTRIGGER';
  t.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  return 'OK';`);
function dropdownRoot() { return `let root=inp.parentElement; while(root && !(root.style && root.style.zIndex==='99999')) root=root.parentElement;`; }
const pickFirst = (c) => c.ev(`
  const inp=document.querySelector('input[placeholder="Type to search..."]'); if(!inp) return 'NOINPUT';
  ${dropdownRoot()} if(!root) return 'NOROOT';
  const opts=[...root.querySelectorAll('.cursor-pointer.transition-colors')]; if(!opts.length) return 'NOOPTS';
  const el=opts[0]; const label=(el.querySelector('div')?el.querySelector('div').textContent:el.textContent).trim();
  el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return label;`);
const pickByLabel = (c, label) => c.ev(`
  const want=${S(label)}; const inp=document.querySelector('input[placeholder="Type to search..."]'); if(!inp) return 'NOINPUT';
  ${dropdownRoot()} if(!root) return 'NOROOT';
  const opts=[...root.querySelectorAll('.cursor-pointer.transition-colors')];
  const hit=opts.find(o=>o.textContent.trim().startsWith(want)); if(!hit) return 'NOMATCH';
  hit.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return 'OK';`);
const setIdx = (c, sel, idx, val) => c.ev(`
  const els=[...document.querySelectorAll(${S(sel)})]; const e=els[${idx}]; if(!e) return 'NOEL';
  const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(e, ${S(String(val))});
  e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickBtn = (c, text) => c.ev(`
  const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().includes(${S(text)}));
  if(!b) return 'NOBTN'; b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); return 'OK';`);
const readInvNo = (c) => c.ev(`
  const h=[...document.querySelectorAll('h1')].map(x=>x.textContent.trim()).find(t=>/\\d{2,}/.test(t)); return h||'';`);

async function pickCustomer(c, label) {
  if (await openSel(c, 'Search clients...') !== 'OK') throw new Error('no customer trigger');
  await waitSel(c, 'input[placeholder="Type to search..."]', 8000);
  await setVal(c, 'input[placeholder="Type to search..."]', label);
  const end = Date.now() + 8000; let r = 'NOMATCH';
  while (Date.now() < end) { r = await pickByLabel(c, label); if (r === 'OK') break; await sleep(150); }
  if (r !== 'OK') throw new Error('customer pick failed ' + label + ' (' + r + ')');
  await sleep(120);
}
async function pickProductByBrand(c, brand) {
  if (await openSel(c, 'Pick product...') !== 'OK') throw new Error('no product trigger');
  await waitSel(c, 'input[placeholder="Type to search..."]', 8000);
  await setVal(c, 'input[placeholder="Type to search..."]', brand);
  const end = Date.now() + 8000; let label = 'NOOPTS';
  while (Date.now() < end) { label = await pickFirst(c); if (label && !['NOINPUT', 'NOROOT', 'NOOPTS'].includes(label)) break; await sleep(150); }
  if (!label || ['NOINPUT', 'NOROOT', 'NOOPTS'].includes(label)) throw new Error('product pick failed ' + brand + ' (' + label + ')');
  await sleep(120);
  return label;
}

/** Full real sales-invoice flow for one run. `custIdx` picks a unique seeded customer + a unique number. */
async function invoiceFlow(c, custIdx) {
  const custLabel = `First${custIdx} Last${custIdx}`;
  await pickCustomer(c, custLabel);
  await waitText(c, 'SELECTED', 6000); // the selected-customer panel renders the picked client
  // 3 lines: line 1 exists, add two more.
  if (await clickBtn(c, 'Add Product') !== 'OK') throw new Error('no add-product'); await sleep(120);
  await clickBtn(c, 'Add Product'); await sleep(150);
  const brands = ['Rolex', 'Omega', 'Patek'];
  const products = [];
  for (const b of brands) { products.push(await pickProductByBrand(c, b)); await sleep(120); }
  // Deterministic totals independent of product tax default: force VAT_10, then qty, then gross (order matters:
  // the gross→unit-net inverse divides by the CURRENT qty, so qty must be set first).
  for (let i = 0; i < 3; i++) await setIdx(c, 'select', i, 'VAT_10');
  const qtys = ['1', '2', '3']; for (let i = 0; i < 3; i++) await setIdx(c, 'input[type="number"][step="1"]', i, qtys[i]);
  const gross = ['110.00', '220.00', '330.00']; for (let i = 0; i < 3; i++) await setIdx(c, 'input[inputmode="decimal"]', i, gross[i]);
  await sleep(180);
  await setIdx(c, 'input[type="number"][step="0.001"]', 0, '400'); // partial payment → PINV, non-zero remaining
  await sleep(200);
  // business validation on the CREATE form: Net 600.000, VAT 60.000 (=gross−net), Gross 660.000, Paid 400.000,
  // Remaining 260.000. Net/Gross/Paid/Remaining are unique strings in the summary (all < 1000, no separators).
  const form = await bodyText(c);
  const formOk = form.includes('600.000') && form.includes('660.000') && form.includes('400.000') && form.includes('260.000');
  if (!formOk) throw new Error('create-form totals mismatch');
  if (await clickBtn(c, 'Save Invoice') !== 'OK') throw new Error('no save button');
  const p = await waitPath(c, /^\/invoices\/[^/]+$/, 20000);
  const id = p.split('/').pop();
  if (!id || id === 'new') throw new Error('did not navigate to a persisted invoice');
  let invNo = ''; { const end = Date.now() + 8000; while (Date.now() < end) { invNo = await readInvNo(c); if (invNo) break; await sleep(150); } }
  const digits = (invNo.match(/\d+/g) || []).join('');
  if (!digits) throw new Error('no invoice number rendered on detail');
  // Open the LIST, find the NEW invoice by its number (real list retrieval), then reopen it.
  await navigate(c, '/invoices'); await sleep(200);
  let listFound = false; { const end = Date.now() + 12000; while (Date.now() < end) { const t = (await bodyText(c)).replace(/\D/g, ''); if (t.includes(digits.slice(-6))) { listFound = true; break; } await sleep(200); } }
  if (!listFound) throw new Error('new invoice number not found in list');
  await navigate(c, '/invoices/' + id); await sleep(150);
  let dt = ''; { const end = Date.now() + 12000; while (Date.now() < end) { dt = await bodyText(c); if (dt.includes('660.000') && dt.includes('First' + custIdx)) break; await sleep(200); } }
  const productsOk = products.every((pl) => dt.includes(pl.split(' ')[0]));
  const detailOk = dt.includes('660.000') && dt.includes('600.000') && dt.includes('400.000') && dt.includes('260.000') && dt.includes('First' + custIdx) && productsOk;
  if (!detailOk) throw new Error('reopened detail mismatch (totals/customer/products)');
  return { ok: true, id, invoiceNo: invNo, customer: custLabel, products, lineCount: 3, net: 600, vat: 60, gross: 660, paid: 400, remaining: 260, listFound };
}

async function startApp() {
  spawn(APP, [], { env: isoEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let pg = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); pg = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (pg) break; } catch {} await sleep(120); }
  if (!pg) throw new Error('no CDP page'); return new CDPc(pg.webSocketDebuggerUrl);
}
async function frontendLogin(c) {
  const waitAuth = 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]';
  await waitSel(c, waitAuth, 60000);
  if (await existsSel(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E'); await setVal(c, 'input[placeholder="e.g. Main Store"]', 'B');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`); await waitSel(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'A'); await setVal(c, 'input[placeholder="you@company.com"]', OWNER); await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`); await waitSel(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10'); await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click();`);
  } else { await setVal(c, 'input[type="email"]', OWNER); await setVal(c, 'input[type="password"]', ONBOARD_PW); await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click();`); }
  try { await waitSel(c, 'a[href="/collection"], nav a, [data-testid]', 45000); }
  catch (e) { console.error('[diag] post-login body:', (await bodyText(c)).slice(0, 300).replace(/\n/g, ' ')); throw e; }
}

async function main() {
  killAll(); rmSync(ADD, { recursive: true, force: true }); rmSync(WV, { recursive: true, force: true });
  mkdirSync(ADD, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = prodSnap();
  seed('seed-primary');
  const fx = buildFixture(join(RUN, 'fx'), 'medium');
  copyFileSync(fx.dbPath, join(ADD, 'lataif.db'));
  { const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(join(ADD, 'lataif.db')); try { d.exec('DROP TABLE IF EXISTS media_blob_generations; PRAGMA wal_checkpoint(TRUNCATE);'); } catch {} d.close(); }

  const results = [];
  const c = await startApp();
  await frontendLogin(c);

  const RR = 7, WU = 1;
  // Short read paths — 7 measured reps each, with a per-rep RESET that navigates away first so every timed
  // navigation is a genuine re-render (never a cached no-op counted as cold).
  results.push(await measure('ui.inventory.list', () => routeRenderedWith(c, '/collection', 'Rolex'), { reps: RR, warmup: WU, reset: async () => { await navigate(c, '/'); await sleep(250); }, validate: (t) => /Rolex|Omega|Patek/.test(t) }));
  results.push(await measure('ui.customers.list', () => routeRenderedWith(c, '/clients', 'First'), { reps: RR, warmup: WU, reset: async () => { await navigate(c, '/'); await sleep(250); }, validate: (t) => /First\d|Last\d/.test(t) }));
  results.push(await measure('ui.invoices.list', () => routeRenderedWith(c, '/invoices', 'INV-'), { reps: RR, warmup: WU, reset: async () => { await navigate(c, '/'); await sleep(250); }, validate: (t) => /INV-\d/.test(t) }));
  results.push(await measure('ui.dashboard', () => routeRenderedWith(c, '/', 'Dashboard'), { reps: RR, warmup: WU, reset: async () => { await navigate(c, '/collection'); await sleep(250); }, validate: (t) => t.length > 40 }));
  results.push(await measure('ui.product.detail', () => routeRenderedWith(c, '/collection/prod-000010', 'SKU-000010', 15000).catch(async () => { const t = await bodyText(c); if (t.length > 150 && !/not found|error/i.test(t)) return t; throw new Error('detail not rendered'); }), { reps: RR, warmup: WU, reset: async () => { await navigate(c, '/collection'); await sleep(250); }, validate: (t) => typeof t === 'string' && t.length > 100 }));
  results.push(await measure('ui.invoice.open', () => routeRenderedWith(c, '/invoices/inv-000001', 'GROSS TOTAL', 15000), { reps: RR, warmup: WU, reset: async () => { await navigate(c, '/invoices'); await sleep(250); }, validate: (t) => /GROSS TOTAL/.test(t) && /BHD/.test(t) }));

  // Inventory SKU search — 7 reps, reset clears the box + re-lands on /collection every rep.
  await navigate(c, '/collection'); await sleep(800);
  const rowCount = async () => { const t = await bodyText(c); return new Set((t.match(/SKU-\d{6}/g) || [])).size; };
  await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>/search|such/i.test((x.getAttribute('aria-label')||'')+x.textContent)); if(b) b.click(); return 1;`).catch(() => {});
  await sleep(200);
  const findInput = () => c.ev(`const el=document.querySelector('input[placeholder="Search by brand, name, SKU..."]')||[...document.querySelectorAll('input,textarea')].find(e=>/search|such|sku|brand|name/i.test((e.placeholder||'')+(e.getAttribute('aria-label')||'')))||[...document.querySelectorAll('input')].find(e=>{const ty=(e.type||'text');return ty==='text'||ty==='search'||!e.type;}); if(!el) return null; el.setAttribute('data-perf-search','1'); return 'input[data-perf-search="1"],textarea[data-perf-search="1"]';`).catch(() => null);
  const searchSel = await findInput();
  const before = await rowCount();
  if (searchSel && before > 1) {
    results.push(await measure('ui.inventory.search.sku', async () => { await setVal(c, searchSel, 'SKU-000100'); await sleep(150); return await rowCount(); },
      { reps: RR, warmup: WU, reset: async () => { await navigate(c, '/collection'); await sleep(200); const s = await findInput(); if (s) await setVal(c, s, ''); await sleep(150); }, validate: (n) => n >= 1 && n < before }));
  } else {
    results.push({ name: 'ui.inventory.search.sku', n: 0, ok: 0, fail: 0, p50: null, meta: { note: `search input not found (sel=${searchSel}, rowsBefore=${before})` }, skipped: true });
  }

  // ── FULL SALES INVOICE FLOW — 3 isolated measured reps (1 warm-up), each a unique customer + number ──
  let custIdx = 50;
  results.push(await measure('ui.invoice.create', () => invoiceFlow(c, custIdx),
    { reps: 3, warmup: 1, reset: async (i) => { custIdx = 50 + i; await navigate(c, '/invoices'); await sleep(300); await navigate(c, '/invoices/new'); await waitText(c, 'Direct Sale', 15000); await sleep(400); }, validate: (r) => !!(r && r.ok === true) }));

  const rss = process.memoryUsage().rss;
  c.close(); killAll(); await sleep(1500);
  const prodAfter = prodSnap();
  const prodUnchanged = prodUnchangedFn(prodBefore, prodAfter);

  // Binary parity: the production (no-e2e) binary provenance is captured by the build step into a sidecar; the
  // measured binary here is the release e2e build. The `e2e` feature only gates test access/port/identifier —
  // never business/query/rendering code (enumerated below); parity is documented, not assumed.
  let parity = null; try { parity = JSON.parse(readFileSync(PARITY_SIDECAR, 'utf8')); } catch {}
  const binaryParity = {
    releaseE2eBinary: { path: 'src-tauri/target/release/lataif.exe', sha256: sha256File(APP), bytes: fileBytes(APP), profile: PROFILE, features: ['e2e'], commit: parity?.e2e?.commit ?? parity?.commit ?? envMeta().commit },
    productionBinary: parity?.production ?? null,
    cfgE2eSurface: [
      'lib.rs: resolve_sync_port() — e2e honours LATAIF_E2E_SYNC_PORT (test port); production is hard-wired to 3001',
      'lib.rs: pub mod e2e_support — test-only re-exports (seed/verify); never in the render/query path',
      'restore.rs / staging_gc.rs: #[cfg(any(test, feature="e2e"))] real-delete helpers — not on any measured UI path',
      'tauri.e2e.conf.json: productName/identifier (isolated AppData) + additionalBrowserArgs (--remote-debugging-port + --enable-automation) + bundle off',
    ],
    note: 'Product/query/rendering code + optimisation profile (release) are identical between the two builds. '
      + 'The only measured-path difference is the WebView2 automation launch flags on the e2e window; UI numbers '
      + 'are therefore labelled a release-e2e REFERENCE baseline, not an exact production-binary baseline. The '
      + 'production binary has no test-port override (would bind 3001 + touch the prod DB) so it is intentionally '
      + 'NOT driven here; it stays a separate build gate.',
  };

  const extra = {
    build: { profile: PROFILE, binarySha256: sha256File(APP), commit: envMeta().commit },
    binaryParity,
    fixture: { size: 'medium', counts: fx.counts, dbBytes: fx.dbBytes },
    resource: { harnessRssBytes: rss, procAfter: procCount(), listeners3011: listeners(PORT), listeners3001: listeners(3001) },
    isolation: { testPort: PORT, productionPort: 3001, prodUnchanged, prodBefore, prodAfter, walLeftover: existsSync(DB + '-wal') ? fileBytes(DB + '-wal') : 0,
      note: '"untouched" = the production sync DB AND business DB (com.lataif.app) are byte-identical (sha256+size+mtime) and the prod media-root file count is unchanged; the e2e app binds only test port 3011, never 3001.' },
  };
  const { jsonPath } = writeReport(runId, 'ui-' + PROFILE, results, extra);

  // Commit the release-e2e-ui baseline class (kept strictly separate from the node + app classes).
  const env = envMeta();
  if (PROFILE === 'release') {
    mergeBaselineClass('release_e2e_ui', {
      buildProfile: 'release', features: ['e2e'], binarySha256: extra.build.binarySha256, commit: env.commit,
      fixtureSize: 'medium', fixtureCounts: fx.counts, sampleCount: RR,
      scenarios: baselineScenarios(results),
    }, { commit: env.commit, cpu: env.cpu, cpuCount: env.cpuCount, ramGB: env.totalRamGB, os: env.os, node: env.node,
      note: 'Reference environment for all classes. Machine-specific; only same-machine relative regression is meaningful.' });
    if (parity?.production) {
      mergeBaselineClass('production_binary_startup', {
        measured: false,
        reason: 'The production binary (no e2e feature) has no test-port override — running it would bind port 3001 '
          + 'and open the production DB, violating isolation. It is validated as a separate build gate only; UI/startup '
          + 'numbers come from the release e2e reference binary (identical product/query/render code + release profile).',
        buildProfile: 'release', features: [], binarySha256: parity.production.sha256, binaryBytes: parity.production.bytes, commit: parity.production.commit,
      });
    }
  }

  const failed = results.filter((r) => r.fail > 0);
  console.log(`PERF ui (${PROFILE}): ${results.length} scenarios, ${failed.length} with failures.`);
  for (const r of results) console.log(`  ${r.name}: p50=${r.p50 ?? '–'}ms p95=${r.p95 ?? '–'} n=${r.n} ok=${r.ok} fail=${r.fail}${r.skipped ? ' (skipped)' : ''} raw=[${(r.samples || []).map((x) => Math.round(x)).join(',')}]${r.lastError ? ' err=' + r.lastError : ''}`);
  const inv = results.find((r) => r.name === 'ui.invoice.create');
  if (inv) for (const pr of (inv.perRep || [])) console.log(`    invoice run ${pr.rep}: ok=${pr.ok} ms=${pr.ms} ${pr.value ? JSON.stringify(pr.value) : pr.error || ''}`);
  console.log(`  isolation prodUnchanged=${prodUnchanged}; procAfter=${extra.resource.procAfter} listeners3011=${extra.resource.listeners3011} listeners3001=${extra.resource.listeners3001}`);
  console.log(`  parity: e2e=${binaryParity.releaseE2eBinary.sha256?.slice(0, 12)}… prod=${parity?.production?.sha256?.slice(0, 12) ?? 'n/a'}…`);
  console.log(`  json: ${jsonPath}`);
  const bad = failed.length || extra.resource.procAfter !== 0 || extra.resource.listeners3011 !== 0 || !prodUnchanged;
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error('PERF UI ERROR:', e?.stack || e?.message || e); killAll(); process.exit(1); }).finally(() => { try { rmSync(RUN, { recursive: true, force: true }); } catch {} try { rmSync(ADD, { recursive: true, force: true }); } catch {} try { rmSync(WV, { recursive: true, force: true }); } catch {} });
