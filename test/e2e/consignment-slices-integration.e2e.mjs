// CONSIGNMENT — der gemeinsame Beweis der beiden Slices, in einem Durchgang durch die echte UI.
//
// Beide Aenderungen fassen dieselbe Kommissionsware an, nur an verschiedenen Enden: die eine legt
// sie an (ein bewusster Klick, genau ein Artikel), die andere aendert spaeter ihr Auszahlungsmodell.
// Getrennt sind beide bewiesen. Was hier gefragt wird, ist das Dazwischen: ein Artikel, der ueber
// den Duplikats-Weg entstanden ist, muss sich danach ganz normal wie jeder bestehende Artikel
// bearbeiten lassen — sonst waere die Einfachausfuehrung mit einem halb angelegten Datensatz
// erkauft, den der Bearbeiten-Weg nicht mehr annimmt.
//
// Deshalb wird der Artikel NICHT gesetzt, sondern erzeugt: die Kennung kommt aus der Datenbank,
// nachdem die Oberflaeche ihn angelegt hat.
//
// Isolierte e2e-Kennung + AppData + Sync-Port (3011); die Produktion (3001) wird nie angefasst.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-consignment-integration-e2e', 'run-' + Date.now());
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
const productsNamed = (name) => dbQ('SELECT id, sku, brand, name FROM products WHERE name = ?', [name]);
const consignmentsFor = (ids) => ids.length === 0 ? []
  : dbQ(`SELECT * FROM consignments WHERE product_id IN (${ids.map(() => '?').join(',')})`, ids);
/** Die Anlage laeuft in einem eigenen Tick — auf die Zeile warten, statt eine Zeit zu raten. */
const waitRows = async (name, n, ms = 15000) => {
  const end = Date.now() + ms;
  let rows = productsNamed(name);
  while (Date.now() < end && rows.length < n) { await sleep(400); rows = productsNamed(name); }
  return rows;
};

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

const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickSel = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
const attr = (c, sel, name) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.getAttribute(${S(name)}) : null;`);
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }
const dupOpen = (c) => c.ev(`return (document.body.textContent||'').includes('Possible duplicate') || !!document.querySelector('[data-dup-modal]');`);
const captureAlerts = (c) => c.ev("window.__alerts = []; if (!window.__alertPatched) { window.__alertPatched = true; window.alert = (m) => { window.__alerts.push(String(m)); }; } return 1;");
const takenAlerts = (c) => c.ev("const a = window.__alerts || []; window.__alerts = []; return a.join(' // ');");

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

/** Ein Consignor und ein vorhandener Artikel, damit der Duplikatshinweis ueberhaupt kommt. */
function seedFixtures() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, phone, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?)`).run('int-cust', branchId, 'Integration', 'Owner', '+973-2222', now, now);
    db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, quantity,
         images, attributes, source_type, created_at, updated_at)
       VALUES (?,?, 'cat-watch', 'Intbrand', 'Joint Model', 'INT-WCH-001', 'Pre-Owned','[]',100,'BHD','in_stock','MARGIN',0,1,'[]',?, 'OWN',?,?)`
    ).run('int-existing', branchId, JSON.stringify({ reference_number: 'JOINT-1', dial: 'Blue' }), now, now);
  } finally { try { db.close(); } catch {} }
}

async function openNewConsignment(c) {
  await c.ev(`window.history.pushState({}, '', '/consignments'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
  await sleep(900);
  await clickText(c, 'New Consignment');
  await waitFor(c, '[data-cn-cat="cat-watch"]', 15000);
}
/** Den Dialog ausfuellen wie ein Mensch: Consignor, Kategorie, dann tippen. */
async function fillForm(c, { brand, name }) {
  await clickSel(c, '[data-ss-trigger="Search clients..."]');
  await sleep(400);
  await waitFor(c, '[data-ss-option="int-cust"]', 10000);
  await clickSel(c, '[data-ss-option="int-cust"]');
  await sleep(300);
  await clickSel(c, '[data-cn-cat="cat-watch"]');
  await sleep(400);
  await setVal(c, 'input[placeholder="e.g. Rolex, Hermes, Cartier"]', brand);
  await setVal(c, 'input[placeholder="e.g. Submariner, Birkin 30"]', name);
  await setVal(c, 'input[placeholder="Optional — set at sale"]', '1000');
  await c.ev("const set=(el,v)=>{const p=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};" +
    "let n=0; for (const el of document.querySelectorAll('input, select')) {" +
    "  if (el.value) continue;" +
    "  const ph = el.getAttribute('placeholder') || '';" +
    "  if (/search|optional|e\.g\.|internal reference/i.test(ph)) continue;" +
    "  if (el.tagName === 'SELECT') { const o = [...el.options].find(x => x.value); if (o) { set(el, o.value); n++; } }" +
    "  else if (el.type === 'number') { set(el, '1'); n++; }" +
    "  else if (el.type === 'text' || !el.type) { set(el, 'E2E ' + " + S(brand) + "); n++; }" +
    "} return n;");
  await sleep(400);
  await c.ev("let n=0; for (const lab of document.querySelectorAll('span.text-overline')) {" +
    "  const star = lab.querySelector('span'); if (!star || star.textContent.trim() !== '*') continue;" +
    "  const box = lab.parentElement; if (!box) continue;" +
    "  const btns = [...box.querySelectorAll('button')]; if (btns.length === 0) continue;" +
    "  const chosen = btns.find(b => b.style.background && b.style.background !== 'transparent');" +
    "  if (!chosen) { btns[0].click(); n++; }" +
    "} return n;");
  await sleep(400);
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const d = await c.ev("const b=document.querySelector('[data-cn-create]'); return b ? (b.disabled ? 'DISABLED' : 'READY') : 'MISSING';");
    if (d === 'READY') return;
    await sleep(250);
  }
  throw new Error('create button never became clickable — the form was not filled');
}

/** Den echten Router benutzen — dieselbe Adresse, auf die die Liste zeigt. */
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

// ══════════════════════════════════════════════════════════════════════════════
console.log('CONSIGNMENT — created through the duplicate path, then edited like any other');
killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
rmSync(APP_DATA_DIR, { recursive: true, force: true });
rmSync(WV2_DIR, { recursive: true, force: true });
mkdirSync(join(RUN, 'tmp'), { recursive: true });

let c = await startApp();
await ensureSignedIn(c);
await sleep(2500);
c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
ok(existsSync(BIZ_DB), 'the isolated business database exists');
seedFixtures();
ok(productsNamed('Joint Model').length === 1, 'the existing item that makes the entry look like a duplicate is staged');

c = await startApp();
await ensureSignedIn(c);

// ── 1) Anlegen ueber den Duplikats-Weg: ein Wille, ein Artikel ───────────────
await openNewConsignment(c);
await fillForm(c, { brand: 'Intbrand', name: 'Joint Model' });
await captureAlerts(c);
await clickSel(c, '[data-cn-create]');
await sleep(600); { const al = await takenAlerts(c); if (al) console.log('   alert:', al); }
await sleep(1200);
ok(await dupOpen(c) === true, 'the duplicate hint appears on the matching entry');
await clickText(c, 'Create anyway');
await sleep(2500);

const made = (await waitRows('Joint Model', 2)).filter((p) => p.id !== 'int-existing');
ok(made.length === 1, `one deliberate decision created exactly ONE product (${made.length})`);
const cons = consignmentsFor(made.map((p) => p.id));
ok(cons.length === 1, `…and exactly ONE consignment for it (${cons.length})`);
const conId = cons[0]?.id;
ok(!!conId, 'the new consignment carries an id — the edit path gets a real record, not a fixture');
ok(cons[0]?.commission_type === 'percent', `…and the model the dialog created it with (${cons[0]?.commission_type})`);

// ── 2) Genau dieses Item spaeter bearbeiten ──────────────────────────────────
await openConsignment(c, conId);
await openEdit(c);
ok(await attr(c, '[data-payout-model="percent"]', 'data-payout-selected') === '1',
  'the edit screen opens with the model this item was created with');
ok(await attr(c, '[data-payout-lock]', 'data-payout-lock') === '0',
  '…and a fresh item is not locked — nothing has been booked on it');

await clickSel(c, '[data-payout-model="cost_split"]');
await sleep(400);
ok(await attr(c, '[data-payout-model="cost_split"]', 'data-payout-selected') === '1', 'the choice follows the click');
ok(await exists(c, '[data-testid="pe-split"]') && !(await exists(c, '[data-testid="pe-rate"]')),
  '…and the dependent field follows the model');
await setVal(c, '[data-testid="pe-split"]', '60');
await sleep(300);
// Die Vorschau kommt aus der Oekonomie-SSOT: zum Kost ist `cost_split` Breakeven, der Consignor
// bekommt seinen Kost zurueck. Dass hier 1000 steht, zeigt zugleich, dass der Prozentsatz des
// verlassenen Modells nicht mehr mitrechnet.
ok(await attr(c, '[data-payout-preview]', 'data-payout-preview') === '1000',
  `the preview follows the new model, not the abandoned rate (${await attr(c, '[data-payout-preview]', 'data-payout-preview')})`);
await clickText(c, 'Save');
await sleep(1800);

// ── 3) Wieder oeffnen: was die Zeile traegt, und was der Bildschirm zeigt ────
{
  const r = consignmentsFor(made.map((p) => p.id))[0];
  ok(r.commission_type === 'cost_split', `the changed model persisted (${r.commission_type})`);
  ok(Number(r.excess_split_pct) === 60, `…with its own parameter (${r.excess_split_pct})`);
  // `commission_rate` darf NICHT leer werden: die Spalte ist NOT NULL, und fuer dieses Modell
  // rechnet sie ohnehin nicht mit (die Vorschau oben hat es gezeigt). Was ein fremdes Modell
  // verraten koennte, ist der Anteil — und der wird beim Wechsel weg von `cost_split` geleert;
  // das haelt das Payout-Gate fest. Hier zaehlt nur, dass die Spalte gueltig bleibt.
  ok(r.commission_rate !== null && Number.isFinite(Number(r.commission_rate)),
    `…and the NOT NULL rate column stayed a valid number (${r.commission_rate})`);
  // Und nichts von dem, was Geld bedeutet, ist dabei entstanden.
  ok(r.sale_price === null && r.commission_amount === null && r.payout_amount === null && r.invoice_id === null,
    'neither the create nor the model change booked anything — no sale, commission, payout or invoice');
  ok(Number(r.payout_paid_amount || 0) === 0, '…and nothing was paid out');
}
// Weg von der Seite und zurueck — der Bildschirm liest neu, nicht aus dem, was er noch hielt.
await c.ev(`window.history.pushState({}, '', '/consignments'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
await sleep(900);
await openConsignment(c, conId);
await openEdit(c);
ok(await attr(c, '[data-payout-model="cost_split"]', 'data-payout-selected') === '1',
  'reopened, the screen shows the model that was saved');
ok(await c.ev(`const e=document.querySelector('[data-testid="pe-split"]'); return e ? e.value : null;`) === '60',
  '…and its parameter with it');
ok(consignmentsFor(made.map((p) => p.id)).length === 1, 'and there is still exactly one consignment for that product');

c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — consignment slices integration e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('V0851_CONSIGNMENT_SLICES_INTEGRATION_PROVED');
