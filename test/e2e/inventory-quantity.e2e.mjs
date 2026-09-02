// ════════════════════════════════════════════════════════════════════════════
// INVENTORY QUANTITY — what the Collection page says about a shelf, through the REAL app.
//
// The observation: a product row can carry `quantity = 10`, and the page counted rows. Ten bracelets
// read as one item, and their purchase value was counted once instead of ten times. This suite puts
// a shelf with known contents in front of the real UI and reads the real headline back:
//
//   A  qty 1 x 100 BHD      →  3 product records
//   B  qty 5 x 200 BHD      →  8 physical items
//   C  qty 2 x  50 BHD      →  1200 BHD stock value
//
// Two more rows are there to protect the existing valuation rule: one sitting at consignment status
// and one whose SOURCE is consignment. Neither is own stock, so neither may add a single fils —
// their quantities (7 and 3) would be very visible if the rule slipped.
//
// Products are staged at rest (app stopped, rows written, app restarted) — the house fixture
// pattern. Isolated e2e identifier + AppData + sync port (3011); production is never touched.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-invqty-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
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
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); }
  throw new Error('no invoke');
}
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
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

/** Stage the shelf AT REST — the app is not running while this writes. */
function seedProducts(items) {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
         quantity, images, attributes, source_type, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'Pre-Owned','[]',?,'BHD',?,?,'MARGIN',0,?,'[]','{}',?,?,?)`);
    for (const it of items) {
      ins.run(it.id, branchId, it.categoryId, it.brand, it.name, it.sku,
        it.purchasePrice, it.plannedSalePrice ?? null, it.stockStatus ?? 'in_stock',
        it.quantity, it.sourceType ?? 'OWN', now, now);
    }
    return branchId;
  } finally { try { db.close(); } catch {} }
}

// A/B/C are the shelf. D and E must never add value: one is at consignment status, the other has a
// consignment SOURCE — by the rule that already governs stock value, neither is an own asset.
const FIXTURES = [
  { id: 'qty-a', categoryId: 'cat-watch',     brand: 'Zenith', name: 'QtyTest Alpha', sku: 'QTY-WCH-001', purchasePrice: 100, quantity: 1 },
  { id: 'qty-b', categoryId: 'cat-watch',     brand: 'Zenith', name: 'QtyTest Beta',  sku: 'QTY-WCH-002', purchasePrice: 200, quantity: 5 },
  { id: 'qty-c', categoryId: 'cat-accessory', brand: 'Zenith', name: 'QtyTest Gamma', sku: 'QTY-ACC-001', purchasePrice: 50,  quantity: 2 },
  { id: 'qty-d', categoryId: 'cat-watch',     brand: 'Zenith', name: 'QtyTest Delta', sku: 'QTY-WCH-003', purchasePrice: 999, quantity: 7, stockStatus: 'consignment' },
  { id: 'qty-e', categoryId: 'cat-watch',     brand: 'Zenith', name: 'QtyTest Echo',  sku: 'QTY-WCH-004', purchasePrice: 500, quantity: 3, sourceType: 'CONSIGNMENT' },
];

/** The page headline, exactly as a person reads it. */
const subtitle = (c) => c.ev(`const h=[...document.querySelectorAll('p')].find(p=>/product/i.test(p.textContent||'') && /item/i.test(p.textContent||'')); return h ? h.textContent.trim() : 'NONE';`);
const cardCount = (c) => c.ev(`return [...document.querySelectorAll('span')].filter(e=>/^QTY-[A-Z]{3}-\d{3}$/.test((e.textContent||'').trim())).length;`);

async function gotoCollection(c) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const direct = await c.ev(`const a=document.querySelector('a[href="/collection"]'); if(!a) return 'NONE'; a.click(); return 'OK';`);
    if (direct === 'OK') return true;
    await c.ev(`const g=[...document.querySelectorAll('div,button,span')].find(e=>e.children.length===0 && /^\\s*INVENTORY\\s*$/i.test(e.textContent||'')); if(g){ (g.closest('button')||g).click(); } return 1;`);
    await sleep(700);
  }
  throw new Error('collection link never appeared');
}

console.log('INVENTORY quantity — a row with five pieces is five pieces\n');
try {
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  let c = await startApp();
  await waitInvoke(c);
  await ensureSignedIn(c);

  // Restart with the shelf staged at rest.
  c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  seedProducts(FIXTURES);
  ok(dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM products')[0]?.c >= 5, 'the fixture is in the database');
  ok(Number(dbQ(BIZ_DB, "SELECT SUM(quantity) u FROM products WHERE id IN ('qty-a','qty-b','qty-c')")[0]?.u) === 8,
    'and the three own rows really carry eight pieces');
  c = await startApp();
  await waitInvoke(c);
  await ensureSignedIn(c);

  // ── 1) The headline of the real page ──────────────────────────────────────
  await gotoCollection(c);
  { const end = Date.now() + 60000; while (Date.now() < end) { if (/product/.test(await subtitle(c))) break; await sleep(500); } }
  await sleep(1200);
  const head = await subtitle(c);
  // Die Standardansicht zeigt eigene Ware: A, B, C und D (D steht auf Kommissions-STATUS, ist aber
  // eine eigene Zeile und liegt im Regal). Vier Datensaetze, 1+5+2+7 = 15 Stueck.
  ok(/\b4 products\b/.test(head), `RECORDS four product records are four (${head})`);
  ok(/\b15 items\b/.test(head), `UNITS …and the pieces behind them are fifteen, not four (${head})`);
  ok(/1,200\.000 BHD/.test(head), `VALUE …worth 1200 BHD — 100 + 5x200 + 2x50 (${head})`);
  ok(!/\b4 items\b/.test(head), 'REGRESSION a row is no longer printed as an item');
  ok(!/\b350\b/.test(head), 'REGRESSION …and the value is not the sum of the unit prices');
  // Der Bewertungs-Scope haelt: D liegt sichtbar im Regal, ist aber kein eigenes Bestandsvermoegen.
  ok(!/8,193|7,193|6,993/.test(head), `SCOPE the consignment-status row adds none of its 6993 BHD (${head})`);
  ok(!/1,700|2,700/.test(head), 'SCOPE …and neither does the consignment-source row');

  // ── 2) A filter changes the totals, clearing it restores them ─────────────
  const clickBtn = (text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
  const catName = await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>/ccessor/i.test((x.textContent||'').trim())); return b ? b.textContent.trim() : 'NO';`);
  ok(catName !== 'NO', `FILTER the category filter offers accessories (${catName})`);
  ok(await clickBtn(catName) === 'OK', 'FILTER …and it can be clicked');
  await sleep(1200);
  const narrowed = await subtitle(c);
  ok(/\b1 product\b/.test(narrowed), `FILTER narrowing to accessories leaves one record (${narrowed})`);
  ok(/\b2 items\b/.test(narrowed), `FILTER …carrying two pieces (${narrowed})`);
  ok(/100\.000 BHD/.test(narrowed) && !/1,200/.test(narrowed),
    `FILTER …and 100 BHD, not the whole shelf (${narrowed})`);

  ok(await clickBtn('Clear filters') === 'OK', 'FILTER the clear button is there');
  await sleep(1200);
  const restored = await subtitle(c);
  ok(restored === head, `FILTER clearing brings the whole shelf back unchanged (${restored})`);

  // ── 3) The other two ownership views say the same thing in their own words ─
  ok(await clickBtn('All') !== 'NO', 'VIEWS the "All" ownership view can be opened');
  await sleep(1200);
  const all = await subtitle(c);
  ok(/\b5 products\b/.test(all) && /\b18 items\b/.test(all),
    `VIEWS all ownership shows five records and eighteen pieces (${all})`);
  ok(/1,200\.000 BHD own stock/.test(all), `VIEWS …while the own stock is still worth 1200 (${all})`);

  ok(await clickBtn('Consignment') === 'OK', 'VIEWS the consignment view can be opened');
  await sleep(1200);
  const cons = await subtitle(c);
  ok(/\b1 consignment product\b/.test(cons) && /\b3 items\b/.test(cons),
    `VIEWS one consignment record, three pieces (${cons})`);
  ok(!/BHD/.test(cons), `VIEWS …and no own-stock value is claimed for it (${cons})`);

  // ── 4) The same number on the other surfaces ──────────────────────────────
  //
  // Stock VALUE is one number and must be one number everywhere. The piece counts are allowed to
  // differ, because they answer different questions and say so: the Collection headline describes
  // WHAT IS LISTED (including the consignment-status row that is physically on the shelf), the
  // Dashboard describes OWN STOCK. What must never happen again is 1200 here and 350 there.
  await c.ev(`const a=document.querySelector('a[href="/"]') || [...document.querySelectorAll('a')].find(x=>/dashboard/i.test(x.getAttribute('href')||'')); if(a){a.click(); return 'OK';} return 'NO';`);
  await sleep(2500);
  const dash = await c.ev(`return document.body.innerText;`);
  ok(/STOCK VALUE/i.test(dash), 'CROSS the dashboard shows a stock value');
  // Das Dashboard rundet auf ganze BHD — dieselbe Zahl, andere Darstellung.
  ok(/\b1,200\b/.test(dash), 'CROSS …and it is the same 1200 BHD the Collection printed');
  ok(!/\b350\b/.test(dash), 'CROSS …never the quantity-blind 350');
  ok(/8 items/.test(dash), 'CROSS the dashboard counts the eight pieces of own stock, not four rows');

  // ── 5) Nothing was written by looking ─────────────────────────────────────
  const after = dbQ(BIZ_DB, "SELECT id, quantity, purchase_price, stock_status, source_type FROM products WHERE id LIKE 'qty-%' ORDER BY id");
  ok(after.length === 5, 'the five fixture rows are all still there');
  ok(after.every(r => r.quantity === FIXTURES.find(f => f.id === r.id).quantity),
    'and no quantity was changed by reading the page');

  c.close();
} catch (e) {
  FAIL++; fails.push('suite error: ' + (e && e.message ? e.message : String(e)));
  console.log('E2E ERROR:', e && e.message ? e.message : e);
} finally {
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — inventory quantity e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('COLLECTIONS_QUANTITY_STOCK_VALUE_PROVED');
