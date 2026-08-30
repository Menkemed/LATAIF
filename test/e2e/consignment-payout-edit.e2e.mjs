// CONSIGNMENT PAYOUT EDIT — the payout model of an EXISTING item, through the real desktop UI.
//
// The unit gate proves the rule and the guarded UPDATE. It says nothing about whether the screen
// a person actually uses is wired to them. So everything here goes through the rendered dialog:
// the stored model must come up preselected, the choice must be clickable, the dependent field
// must follow it, and what the row carries afterwards must be what was chosen — with the parameter
// of the abandoned model gone.
//
// The second half is the bound case: a sold and paid consignment must show its model, refuse to
// change it, say why, and still let the harmless fields through. And the margin line of that
// booked sale must keep naming the amount it was booked on, even after the agreed price is edited
// afterwards.
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
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-consignment-payout-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(sql, params = []) {
  let db;
  try { db = new DatabaseSync(BIZ_DB, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const row = (id) => dbQ('SELECT * FROM consignments WHERE id = ?', [id])[0] || null;

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

async function attach() {
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
let appProc;
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  return attach();
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
async function serverHealthy(ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); }
  return false;
}

const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickSel = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
const attr = (c, sel, name) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.getAttribute(${S(name)}) : null;`);
const text = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? (e.textContent||'').trim() : null;`);
const disabled = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? !!e.disabled : null;`);
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

/** Navigate the real router — the same URL the list links to. */
async function openConsignment(c, id) {
  await c.ev(`window.history.pushState({}, '', '/consignments/${id}'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
  await waitFor(c, 'button', 20000);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const t = await c.ev(`return (document.body.textContent||'').includes('Consignment not found') ? 'MISSING' : ((document.body.textContent||'').includes('CON-') ? 'OK' : 'WAIT');`);
    if (t === 'OK') return true;
    if (t === 'MISSING') throw new Error('consignment page says not found: ' + id);
    await sleep(300);
  }
  throw new Error('consignment page did not render: ' + id);
}
const openEdit = async (c) => { await clickText(c, 'Edit'); await waitFor(c, '[data-payout-model="percent"]', 15000); };

/** Two consignments AT REST — the app is not running while this writes. */
function seedFixtures() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, phone, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?)`).run('cpe-cust', branchId, 'Payout', 'Owner', '+973-0000', now, now);
    const prod = db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, quantity,
         images, attributes, source_type, created_at, updated_at)
       VALUES (?,?, 'cat-watch', 'Payoutbrand', ?, ?, 'Pre-Owned','[]',0,'BHD','consignment','MARGIN',0,1,'[]','{}','CONSIGNMENT',?,?)`);
    prod.run('cpe-prod-free', branchId, 'Free Item', 'CPE-WCH-001', now, now);
    prod.run('cpe-prod-bound', branchId, 'Bound Item', 'CPE-WCH-002', now, now);
    const ins = db.prepare(
      `INSERT INTO consignments (id, branch_id, consignment_number, consignor_id, product_id,
         agreed_price, commission_rate, commission_type, excess_split_pct,
         commission_amount, payout_amount, payout_paid_amount, payout_status,
         sale_price, invoice_id, status, agreement_date, notes, created_at, updated_at)
       VALUES (?,?,?, 'cpe-cust', ?, ?,?,?,?, ?,?,?,?, ?,?,?, ?, ?, ?, ?)`);
    // 1) frei: nichts gebucht, percent 15
    ins.run('cpe-free', branchId, 'CON-E2E-001', 'cpe-prod-free', 1000, 15, 'percent', null,
      null, null, 0, 'pending', null, null, 'active', '2026-01-01', null, now, now);
    // 2) gebunden: verkauft und ausgezahlt, consignor_fixed mit Agreed 1000 (= eingefrorener Payout)
    ins.run('cpe-bound', branchId, 'CON-E2E-002', 'cpe-prod-bound', 1000, 15, 'consignor_fixed', null,
      200, 1000, 1000, 'paid', 1200, null, 'sold', '2026-01-01', 'booked', now, now);
    return branchId;
  } finally { try { db.close(); } catch {} }
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('CONSIGNMENT payout model edit — real UI');
killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
rmSync(APP_DATA_DIR, { recursive: true, force: true });
rmSync(WV2_DIR, { recursive: true, force: true });
mkdirSync(join(RUN, 'tmp'), { recursive: true });

let c = await startApp();
await ensureSignedIn(c);
ok(true, 'the isolated app came up and signed in');
// Der Onboarding-Stand muss auf der Platte liegen, bevor daneben geschrieben wird.
await sleep(2500);
c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
ok(existsSync(BIZ_DB), 'the isolated business database exists');
seedFixtures();
ok(!!row('cpe-free') && !!row('cpe-bound'), 'both fixtures are staged at rest');

c = await startApp();
await ensureSignedIn(c);

// ── 1) Freies Item: percent → cost_split, durch den echten Dialog ────────────
await openConsignment(c, 'cpe-free');
await openEdit(c);
ok(await attr(c, '[data-payout-model="percent"]', 'data-payout-selected') === '1',
  'UI the stored model comes up preselected');
ok(await attr(c, '[data-payout-lock]', 'data-payout-lock') === '0', 'UI …and it is not locked');
ok(await exists(c, '[data-testid="pe-rate"]') && !(await exists(c, '[data-testid="pe-split"]')),
  'UI percent shows its rate and no split');

await clickSel(c, '[data-payout-model="cost_split"]');
await sleep(400);
ok(await attr(c, '[data-payout-model="cost_split"]', 'data-payout-selected') === '1', 'UI the choice follows the click');
ok(await exists(c, '[data-testid="pe-split"]') && !(await exists(c, '[data-testid="pe-rate"]')),
  'UI …and the dependent field follows the model');
await setVal(c, '[data-testid="pe-split"]', '60');
await sleep(300);
// Die Vorschau kommt aus der Oekonomie-SSOT: cost_split zum Kost ist Breakeven, der Consignor
// bekommt seinen Kost zurueck.
ok(await attr(c, '[data-payout-preview]', 'data-payout-preview') === '1000',
  `UI the preview follows the model (${await attr(c, '[data-payout-preview]', 'data-payout-preview')})`);
await clickText(c, 'Save');
await sleep(1500);
{
  const r = row('cpe-free');
  ok(r.commission_type === 'cost_split', `DB the model persisted (${r.commission_type})`);
  ok(r.excess_split_pct === 60, `DB …with its own parameter (${r.excess_split_pct})`);
}
await openEdit(c);
ok(await attr(c, '[data-payout-model="cost_split"]', 'data-payout-selected') === '1',
  'UI reopening shows the newly stored model');
ok(await c.ev(`const e=document.querySelector('[data-testid="pe-split"]'); return e ? e.value : null;`) === '60',
  'UI …and its stored parameter');

// ── 2) …und weiter zu consignor_fixed ────────────────────────────────────────
await clickSel(c, '[data-payout-model="consignor_fixed"]');
await sleep(400);
ok(!(await exists(c, '[data-testid="pe-split"]')) && !(await exists(c, '[data-testid="pe-rate"]')),
  'UI consignor_fixed needs no parameter of its own');
await clickText(c, 'Save');
await sleep(1500);
{
  const r = row('cpe-free');
  ok(r.commission_type === 'consignor_fixed', `DB the second change persisted (${r.commission_type})`);
  ok(r.excess_split_pct === null, 'DB …and the parameter of the abandoned model is gone, not left behind');
}

// ── 3) Der gebundene Fall ────────────────────────────────────────────────────
await openConsignment(c, 'cpe-bound');
const bookedBefore = row('cpe-bound');
const labelBefore = await text(c, '[data-booked-margin-label]');
ok(/1,000\.000/.test(labelBefore || ''), `UI the booked margin names the amount it was booked on (${labelBefore})`);

await openEdit(c);
ok(await attr(c, '[data-payout-model="consignor_fixed"]', 'data-payout-selected') === '1',
  'UI a bound consignment still SHOWS its model');
ok(await disabled(c, '[data-payout-model="percent"]') === true
  && await disabled(c, '[data-payout-model="cost_split"]') === true,
  'UI …but the choice is disabled');
ok(await attr(c, '[data-payout-lock]', 'data-payout-lock') === '1', 'UI …and it is marked as locked');
{
  const reason = await text(c, '[data-payout-lock]');
  ok(/no longer be changed/i.test(reason || '') && /sale|sold|invoiced|payout/i.test(reason || ''),
    `UI …with a reason a person can read ("${reason}")`);
}
// Die ungefaehrlichen Felder bleiben benutzbar — und der Agreed Price ist einer davon.
ok(await disabled(c, '[data-testid="pe-notes"]') === false, 'UI an unrelated field stays editable while the payout is locked');
await setVal(c, '[data-testid="pe-notes"]', 'note added after the sale');
await setVal(c, '[data-testid="pe-agreed"]', '7777');
await clickText(c, 'Save');
await sleep(1500);
{
  const r = row('cpe-bound');
  ok(r.notes === 'note added after the sale', 'DB the harmless edit went through');
  ok(r.commission_type === 'consignor_fixed' && r.excess_split_pct === null,
    'DB …while the payout model stayed exactly as booked');
  ok(r.commission_amount === bookedBefore.commission_amount && r.payout_amount === bookedBefore.payout_amount
    && r.sale_price === bookedBefore.sale_price && r.payout_paid_amount === bookedBefore.payout_paid_amount
    && r.invoice_id === bookedBefore.invoice_id && r.payout_status === bookedBefore.payout_status,
    'DB …and every booked amount is untouched');
  ok(r.agreed_price === 7777, 'DB the agreed price itself is editable — it is only a note after the sale');
}
// Und genau deshalb darf die Beschriftung ihm nicht folgen.
{
  const labelAfter = await text(c, '[data-booked-margin-label]');
  ok(/1,000\.000/.test(labelAfter || ''), `UI the booked margin still names the historical basis (${labelAfter})`);
  ok(!/7,777/.test(labelAfter || ''), 'UI …and never the price that was edited afterwards');
}

c.close(); killAllApp(); await waitProcessGone();
rmSync(RUN, { recursive: true, force: true });

console.log(`\nCONSIGNMENT payout edit e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CONSIGNMENT_PAYOUT_EDIT_UI_E2E_PROVED');
