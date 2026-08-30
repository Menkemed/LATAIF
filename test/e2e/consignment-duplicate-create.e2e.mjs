// CONSIGNMENT DUPLICATE — one deliberate decision, one created item, through the real UI.
//
// The reported path: fill in a new consignment, the duplicate hint appears, press "Create anyway"
// or "Copy details" — and the hint came back, or two items were created from one decision.
//
// Everything here goes through the rendered New Consignment dialog in the real app against an
// isolated database. What is counted afterwards is what the database holds: products and
// consignment rows, not what the screen claims.
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
const APP_CDP = 9223, PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-consignment-dup-e2e', 'run-' + Date.now());
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
/** Die Anlage laeuft in einem eigenen Tick, und die Datei wird danach geschrieben — also warten,
 *  bis die Zeile wirklich da ist, statt eine feste Zeit zu raten. */
const waitRows = async (name, n, ms = 15000) => {
  const end = Date.now() + ms;
  // Und die gelesenen Zeilen zurueckgeben: ein zweiter Lesevorgang koennte genau in einen
  // Schreibvorgang der Anwendung fallen und leer zurueckkommen.
  let rows = productsNamed(name);
  while (Date.now() < end && rows.length < n) { await sleep(400); rows = productsNamed(name); }
  return rows;
};
const consignmentsFor = (ids) => ids.length === 0 ? []
  : dbQ(`SELECT id, product_id, consignment_number FROM consignments WHERE product_id IN (${ids.map(() => '?').join(',')})`, ids);

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
  // Fehler der Seite mitschreiben — ein stiller Abbruch im Create waere sonst unsichtbar.
  c.logs = [];
  c.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      c.logs.push((m.params.args || []).map((a2) => String(a2.value ?? a2.description ?? '')).join(' '));
    }
  });
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
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }
// Ein verschluckter Hinweis ist unsichtbar: die Seite meldet Pflichtfeld-Fehler ueber ,
// und unter der Fernsteuerung wird der Dialog nicht angezeigt. Also wird er mitgeschrieben.
const captureAlerts = (c) => c.ev("window.__alerts = []; if (!window.__alertPatched) { window.__alertPatched = true; window.alert = (m) => { window.__alerts.push(String(m)); }; } return 1;");
const takenAlerts = (c) => c.ev("const a = window.__alerts || []; window.__alerts = []; return a.join(' // ');");
const dupOpen = (c) => c.ev(`return (document.body.textContent||'').includes('Possible duplicate') || !!document.querySelector('[data-dup-modal]');`);

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

/** A consignor and an item that a new entry can look like — staged while the app is not running. */
function seedFixtures() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, phone, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?)`).run('dup-cust', branchId, 'Dupe', 'Owner', '+973-1111', now, now);
    db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, quantity,
         images, attributes, source_type, created_at, updated_at)
       VALUES (?,?, 'cat-watch', 'Dupebrand', 'Twin Model', 'DUP-WCH-001', 'Pre-Owned','[]',100,'BHD','in_stock','MARGIN',0,1,'[]',?, 'OWN',?,?)`
    ).run('dup-existing', branchId, JSON.stringify({ reference_number: 'TWIN-1', dial: 'Blue' }), now, now);
    // Ein EIGENER vorhandener Artikel fuer den Kopier-Fall. Sonst ist der naechste Treffer der
    // Artikel, den Fall A gerade selbst angelegt hat — dessen Merkmale sind mit der Eingabe
    // identisch, und nach dem Kopieren waere nichts zu sehen, obwohl kopiert wurde.
    db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, quantity,
         images, attributes, source_type, created_at, updated_at)
       VALUES (?,?, 'cat-watch', 'Copybrand', 'Copy Model', 'CPY-WCH-001', 'Pre-Owned','[]',100,'BHD','in_stock','MARGIN',0,1,'[]',?, 'OWN',?,?)`
    ).run('dup-copy-src', branchId, JSON.stringify({ reference_number: 'COPY-1', dial: 'Green', material: 'Steel' }), now, now);
    return branchId;
  } finally { try { db.close(); } catch {} }
}

async function openNewConsignment(c) {
  await c.ev(`window.history.pushState({}, '', '/consignments'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
  await sleep(900);
  await clickText(c, 'New Consignment');
  await waitFor(c, '[data-cn-cat="cat-watch"]', 15000);
}
/** Fill the dialog the way a person does: pick the consignor, the category, then type. */
async function fillForm(c, { brand, name }) {
  await clickSel(c, '[data-ss-trigger="Search clients..."]');
  await sleep(400);
  await waitFor(c, '[data-ss-option="dup-cust"]', 10000);
  await clickSel(c, '[data-ss-option="dup-cust"]');
  await sleep(300);
  await clickSel(c, '[data-cn-cat="cat-watch"]');
  await sleep(400);
  await setVal(c, 'input[placeholder="e.g. Rolex, Hermes, Cartier"]', brand);
  await setVal(c, 'input[placeholder="e.g. Submariner, Birkin 30"]', name);
  await setVal(c, 'input[placeholder="Optional — set at sale"]', '1000');
  // Die Kategorie verlangt eigene Pflichtmerkmale (Dial, Material, …). Ohne sie bricht das
  // Anlegen mit einer Meldung ab — und die Meldung ist unter der Fernsteuerung unsichtbar.
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
  await sleep(200);
  // Auswahl-Merkmale sind Knopfreihen, keine Auswahlfelder: unter einer Ueberschrift mit
  // Pflicht-Stern die erste Wahl anklicken, solange dort noch nichts gewaehlt ist.
  await c.ev("let n=0; for (const lab of document.querySelectorAll('span.text-overline')) {" +
    "  const star = lab.querySelector('span'); if (!star || star.textContent.trim() !== '*') continue;" +
    "  const box = lab.parentElement; if (!box) continue;" +
    "  const btns = [...box.querySelectorAll('button')]; if (btns.length === 0) continue;" +
    "  const chosen = btns.find(b => b.style.background && b.style.background !== 'transparent');" +
    "  if (!chosen) { btns[0].click(); n++; }" +
    "} return n;");
  await sleep(400);
  // Ein deaktivierter Knopf schluckt den Klick lautlos — das waere ein falsches Gruen.
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const d = await c.ev("const b=document.querySelector('[data-cn-create]'); return b ? (b.disabled ? 'DISABLED' : 'READY') : 'MISSING';");
    if (d === 'READY') return;
    await sleep(250);
  }
  throw new Error('create button never became clickable — the form was not filled');
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('CONSIGNMENT duplicate — one decision, one item');
killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
rmSync(APP_DATA_DIR, { recursive: true, force: true });
rmSync(WV2_DIR, { recursive: true, force: true });
mkdirSync(join(RUN, 'tmp'), { recursive: true });

let c = await startApp();
await ensureSignedIn(c);
await sleep(2500);
c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
seedFixtures();
ok(productsNamed('Twin Model').length === 1, 'the existing item is staged');
ok(productsNamed('Copy Model').length === 1, 'and so is the one the copy case works on');

c = await startApp();
await ensureSignedIn(c);

// ── A) Create anyway: der Hinweis erscheint einmal, eine Anlage entsteht ─────
await openNewConsignment(c);
await fillForm(c, { brand: 'Dupebrand', name: 'Twin Model' });
await captureAlerts(c);
await clickSel(c, '[data-cn-create]');
await sleep(600); { const al = await takenAlerts(c); if (al) console.log('   alert:', al); }
await sleep(1200);
ok(await dupOpen(c) === true, 'A the duplicate hint appears on a matching entry');
ok(productsNamed('Twin Model').length === 1, 'A …and nothing was created while it is open');
await clickText(c, 'Create anyway');
await sleep(2500);
{
  const made = (await waitRows('Copy Model', 2)).filter((p) => p.id !== 'dup-copy-src');
  ok(made.length === 1, `A one deliberate "Create anyway" creates exactly ONE item (${made.length})`);
  const cons = consignmentsFor(made.map((p) => p.id));
  ok(cons.length === 1, `A …and exactly one consignment for it (${cons.length})`);
  ok(await dupOpen(c) === false, 'A …and the hint does not come back');
  ok(await exists(c, '[data-cn-create]') === false, 'A …the dialog closed');
}

// ── B) Copy details: uebernimmt, legt NICHTS an, und springt nicht wieder auf ─
await openNewConsignment(c);
await fillForm(c, { brand: 'Copybrand', name: 'Copy Model' });
await captureAlerts(c);
await clickSel(c, '[data-cn-create]');
await sleep(600); { const al = await takenAlerts(c); if (al) console.log('   alert:', al); }
await sleep(1200);
ok(await dupOpen(c) === true, 'B the hint appears for an entry that resembles an existing item');
const beforeCopy = productsNamed('Copy Model').length;
ok(await clickText(c, 'Copy details') === 'OK', 'B the copy control is there and is clicked');
{
  // Erst beweisen, dass die Uebernahme ueberhaupt stattgefunden hat — sonst waere alles danach
  // ein leeres Gruen.
  await sleep(800);
  const vals = String(await c.ev("return [...document.querySelectorAll('input')].map(e=>e.value).join('|');"));
  ok(vals.includes('COPY-1'), `B the details of the found item really landed in the visible form (${vals.slice(0, 200)})`);
  ok(vals.includes('Copybrand') && vals.includes('Copy Model'), 'B …its brand and name among them');
  ok(!vals.includes('CPY-WCH-001'), 'B …but never its SKU — every piece keeps its own number');
}
// Deutlich laenger als der Entprellwert der Live-Pruefung (800 ms) — genau darin sprang der
// Hinweis vorher ein zweites Mal auf.
await sleep(3000);
ok(await dupOpen(c) === false, 'B "Copy details" does not bring the hint straight back');
ok(productsNamed('Copy Model').length === beforeCopy, 'B …and it creates nothing by itself');
ok(await exists(c, '[data-cn-create]') === true, 'B …the dialog stays open for the deliberate save');
// Der bewusste Save danach legt genau einmal an.
await captureAlerts(c);
await clickSel(c, '[data-cn-create]');
await sleep(600); { const al = await takenAlerts(c); if (al) console.log('   alert:', al); }
await sleep(1500);
if (await dupOpen(c)) { await clickText(c, 'Create anyway'); await sleep(2500); }
{
  const made = (await waitRows('Twin Model', 2)).filter((p) => p.id !== 'dup-existing');
  ok(made.length === 1, `B the deliberate save after a copy adds exactly one item (${made.length})`);
  ok(consignmentsFor(made.map((p) => p.id)).length === 1, 'B …with exactly one consignment');
}

// ── C) Ohne Duplikat: ein Klick, eine Anlage ────────────────────────────────
await openNewConsignment(c);
await fillForm(c, { brand: 'Uniquebrand', name: 'Solo Model' });
await captureAlerts(c);
await clickSel(c, '[data-cn-create]');
await sleep(600); { const al = await takenAlerts(c); if (al) console.log('   alert:', al); }
await sleep(2500);
ok(await dupOpen(c) === false, 'C an entry that resembles nothing shows no hint');
{
  const made = await waitRows('Solo Model', 1);
  ok(made.length === 1, `C …and creates exactly one item (${made.length})`);
  ok(consignmentsFor(made.map((p) => p.id)).length === 1, 'C …with exactly one consignment');
}

// ── D) Zwei Klicks in einem Wimpernschlag bleiben EINE Anlage ───────────────
//
// Das ist der eigentliche Doppelanlage-Fall: die Schreibvorgaenge laufen in einem eigenen Tick,
// und zwei Klicks davor reihten frueher zwei Auftraege ein. Hier werden sie im selben Tick
// ausgeloest, ohne Rendern dazwischen.
await openNewConsignment(c);
await fillForm(c, { brand: 'Rapidbrand', name: 'Fast Model' });
await captureAlerts(c);
await c.ev(`const b=document.querySelector('[data-cn-create]'); if(!b) return 'NO'; b.click(); b.click(); b.click(); return 'OK';`);
await sleep(600); { const al = await takenAlerts(c); if (al) console.log('   alert:', al); }
await sleep(2500);
if (await dupOpen(c)) { await clickText(c, 'Create anyway'); await sleep(2500); }
{
  const made = await waitRows('Fast Model', 1);
  ok(made.length === 1, `D three clicks in one tick still create exactly ONE item (${made.length})`);
  ok(consignmentsFor(made.map((p) => p.id)).length === 1, 'D …and exactly one consignment');
}
// …und danach ist der Bildschirm nicht gesperrt: der naechste Vorgang geht wieder.
await openNewConsignment(c);
await fillForm(c, { brand: 'Afterbrand', name: 'Next Model' });
await captureAlerts(c);
await clickSel(c, '[data-cn-create]');
await sleep(600); { const al = await takenAlerts(c); if (al) console.log('   alert:', al); }
await sleep(2500);
if (await dupOpen(c)) { await clickText(c, 'Create anyway'); await sleep(2500); }
ok((await waitRows('Next Model', 1)).length === 1, 'D a later, separate create still works — the guard is not a one-way door');

c.close(); killAllApp(); await waitProcessGone();
rmSync(RUN, { recursive: true, force: true });

if (c.logs && c.logs.length) console.log('page errors:', c.logs.slice(0, 8).join(' | '));
console.log(`\nCONSIGNMENT duplicate create e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CONSIGNMENT_DUPLICATE_SINGLE_CREATE_PROVED');
