// STOCK-LOT-INTEGRITY — gezielter UI-Lauf durch die ECHTE isolierte E2E-App (com.lataif.app.e2e, Port 3011).
// Run: node test/e2e/stock-lot-ui.e2e.mjs   (aus dem Repo-Verzeichnis)
// Wiederverwendet: _e2e-preflight (Artefakt-/Scope-Beweis), _e2e-process (nur eigene Prozesse), Klick-Muster aus r5d/r6e/r7a.
// Produktion (com.lataif.app, E:\LATAIF\Data, 3001/3443) wird weder benutzt noch beendet.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killTestImage, spawnTracked } from './_e2e-process.mjs';

const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223, PORT = 3011, HTTP = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com', ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const RUN = join(os.tmpdir(), 'lataif-stocklot-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const PROD_APPDATA = join(REAL_APPDATA, 'com.lataif.app');
const PROD_LOCATOR = join(PROD_APPDATA, 'data-location.json');
/** Der Datenort der Produktion, wie ihr eigener Zeiger ihn nennt — nur gelesen, nie geschrieben. */
function prodDataDb() {
  try { const r = JSON.parse(readFileSync(PROD_LOCATOR, 'utf8')); return r.path || r.root || r.dataRoot ? join(String(r.path || r.root || r.dataRoot), 'lataif.db') : null; }
  catch { return null; }
}

let PASS = 0, FAIL = 0; const fails = []; const UI = []; const MSG = [];
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const seedTool = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();

function dbQ(sql, params = [], file = BIZ_DB) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const one = (sql, p = []) => dbQ(sql, p)[0] || {};
const qty = (id) => Number(one('SELECT quantity FROM products WHERE id = ?', [id]).quantity);
const st = (id) => String(one('SELECT stock_status FROM products WHERE id = ?', [id]).stock_status);
const lineOf = (pid) => one('SELECT il.*, i.status AS inv_status, i.invoice_number FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.product_id = ? ORDER BY i.created_at DESC, il.rowid DESC LIMIT 1', [pid]);
const invCount = (pid) => Number(one('SELECT COUNT(*) n FROM invoice_lines WHERE product_id = ?', [pid]).n);

// ── CDP ─────────────────────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      // Native Dialoge (alert/confirm) — Text festhalten, bestätigen wie ein Mensch mit „OK".
      if (m.method === 'Page.javascriptDialogOpening') {
        MSG.push(`${m.params.type}: ${m.params.message}`);
        this.ws.send(JSON.stringify({ id: ++this.id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      }
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  spawnTracked(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* noch nicht */ }
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  return c;
}
function stopApp() { try { killTestImage('lataif.exe'); } catch { /* weg */ } }
async function waitGoneAndFree() {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    let n = 0;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${PORT} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(500);
  }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}

// ── Klick-Helfer (wie r5d/r6e/r7a) ──────────────────────────────────────────
const q = (sel) => `document.querySelector(${S(sel)})`;
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes(${S(t)})).pop(); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabelPrefix = (c, prefix, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().startsWith(${S(prefix)})).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(prefix)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const waehleIn = (c, eintrag, wert) => c.ev(
  `const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.textContent.includes(${S(eintrag)})));`
  + `if(!s) return 'NO-SELECT:'+${S(eintrag)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${S(wert)});`
  + `s.dispatchEvent(new Event('change',{bubbles:true})); return s.value===${S(wert)} ? 'OK' : 'NO-OPTION:'+${S(wert)};`);
const alleOk = (r) => { const b = r.filter((x) => x !== 'OK'); return b.length ? 'FELD:' + b.join(',') : 'OK'; };
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); }
  return false;
}
async function warteAuf(pruefe, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (pruefe()) return true; await sleep(400); } return pruefe(); }
const text = (c) => c.ev('return document.body.innerText;');
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1200); }
async function ssPick(c, placeholder, optionId) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}
async function mehrfachWahl(c, placeholder, labels) {
  const a = await c.ev(`const s=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()===${S(placeholder)}); if(!s) return 'NO'; s.parentElement.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  const r = [];
  for (const label of labels) {
    const suche = `[...document.querySelectorAll('div.cursor-pointer')].find(d=>{ const t=d.querySelector(':scope > div.flex-1 > div'); return t && t.textContent.trim()===${S(label)}; })`;
    if (!(await warteBis(c, suche, 10000))) { r.push('KEIN-EINTRAG:' + label); continue; }
    r.push(await c.ev(`const d=${suche}; d.click(); return 'OK';`));
    await sleep(250);
  }
  await c.ev("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1;");
  await sleep(250);
  return alleOk(r);
}
async function nummerWahl(c) {
  if (!(await warteBis(c, q('[data-final-number-confirm]'), 15000))) return 'KEIN-NUMMERNDIALOG';
  const r = [await klick(c, '[data-final-number-normal]')]; await sleep(250);
  r.push(await klick(c, '[data-final-number-confirm]'));
  return alleOk(r);
}
async function fotoWaehlen(c, file) {
  await c.send('DOM.enable', {});
  const { root } = await c.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][accept="image/*"]' });
  if (!nodeIds || nodeIds.length === 0) return 'KEIN-FELD';
  await c.send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[nodeIds.length - 1] });
  return 'OK';
}
/** Sichtbare Fehlermeldung einer Maske/eines Dialogs (roter Kasten), sonst ''. */
const fehlerText = (c) => c.ev(`const e=[...document.querySelectorAll('[data-save-error],[role=alert]')].map(x=>x.textContent.trim()).filter(Boolean); const red=[...document.querySelectorAll('div')].filter(d=>d.children.length<=2 && /rgb\\(220, 38, 38\\)|#DC2626/i.test(getComputedStyle(d).color) && (d.textContent||'').length>20).map(d=>d.textContent.trim()); return [...e, ...red].join(' | ').slice(0, 400);`);

// ── Rechnung über die Maske ─────────────────────────────────────────────────
async function rechnungMaske(c, kunde, pid, menge, zahlung) {
  await gehFrisch(c, '/invoices/new');
  if (!(await warteBis(c, q('[data-ss-trigger="Search clients..."]'), 20000))) return 'KEINE-MASKE';
  const r = [await ssPick(c, 'Search clients...', kunde), await ssPick(c, 'Pick product...', pid)];
  await sleep(500);
  if (menge !== 1) r.push(await setVal(c, 'input[type=number][min="1"][step="1"]', String(menge)));
  if (zahlung === 'later') r.push(await klick(c, '[data-invoice-pay-later]'));
  else { r.push(await klick(c, '[data-invoice-pay-method="cash"]')); r.push(await klick(c, '[data-invoice-pay-full]')); }
  await sleep(400);
  r.push(await klick(c, '[data-invoice-save]'));
  if (zahlung === 'full' && r.every((x) => x === 'OK')) {
    await sleep(600);
    if (await exists(c, '[data-final-number-confirm]')) r.push(await nummerWahl(c));
  }
  return alleOk(r);
}
async function listeVollZahlen(c, invId) {
  await gehFrisch(c, '/invoices');
  if (!(await warteBis(c, q(`[data-pay-invoice="${invId}"]`), 20000))) return 'KEIN-ZAHLKNOPF';
  const r = [await klick(c, `[data-pay-invoice="${invId}"]`)];
  await warteBis(c, q('[data-invoice-list-pay]'), 8000);
  r.push(await klick(c, '[data-invoice-list-pay-method="cash"]'));
  await sleep(200);
  r.push(await klick(c, '[data-invoice-list-pay]'));
  await sleep(700);
  if (await exists(c, '[data-final-number-confirm]')) r.push(await nummerWahl(c));
  return alleOk(r);
}
async function stornoMaske(c, invId) {
  await gehFrisch(c, `/invoices/${invId}`);
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Cancel')", 20000))) return 'KEIN-STORNOKNOPF';
  const r = [await clickText(c, 'Cancel')];
  if (!(await warteBis(c, q('[data-invoice-cancel]'), 8000))) return 'KEIN-DIALOG';
  await sleep(300);
  r.push(await klick(c, '[data-invoice-cancel]'));
  await sleep(1500);
  return alleOk(r);
}
async function aendernMaske(c, invId) {
  await gehFrisch(c, `/invoices/${invId}/edit`);
  if (!(await warteBis(c, q('[data-invoice-save]'), 20000))) return 'KEINE-MASKE';
  await sleep(1200);
  const r = [await setVal(c, 'textarea[placeholder^="Explain why this invoice"]', 'E2E Änderungsversuch')];
  r.push(await klick(c, '[data-invoice-save]'));
  await sleep(1500);
  return alleOk(r);
}

// ── Testdaten (isoliert, bei gestoppter App) ────────────────────────────────
function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk) continue;
    if (daten[sp.name] !== undefined) continue;
    const t = String(sp.type || '').toUpperCase();
    daten[sp.name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k] === undefined ? null : daten[k]));
}
const PRODUKTE = [
  ['nl-a', 'Nolot Alpha', 2], ['ag-a', 'Agent Alpha', 1], ['pr-1', 'Prod In1', 1], ['pr-2', 'Prod In2', 1],
  ['rt-a', 'Return Alpha', 1], ['lg-a', 'Legacy Alpha', 3],
];
function seedBusiness() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    insert(db, 'categories', { id: 'e2e-cat', branch_id, name: 'E2E Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    for (const [id, first, last] of [['e2e-kunde', 'Nadia', 'Kunde'], ['e2e-agkunde', 'Karim', 'Agent']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    insert(db, 'employees', { id: 'e2e-emp', branch_id, name: 'E2E Uebergabe', employment_status: 'active', created_at: now, updated_at: now });
    // Artikel OHNE Los (kein stock_lots-Eintrag) — wie ein manuell angelegter Artikel.
    for (const [id, name, menge] of PRODUKTE) {
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Omega', name, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: id.startsWith('pr-') ? 300 : 400, purchase_currency: 'BHD', planned_sale_price: 1000, stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: menge, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
    }
    // Altrechnung von VOR dem Bestandsvertrag: unbezahlt, Menge 2, stock_taken NULL → beim Start 'pending'.
    insert(db, 'invoices', { id: 'leg-inv', branch_id, invoice_number: 'PINV-LEG-0001', customer_id: 'e2e-kunde', status: 'PARTIAL', net_amount: 1000, vat_rate_snapshot: 0, vat_amount: 0, gross_amount: 1000, paid_amount: 0, tax_scheme_snapshot: 'MARGIN', issued_at: now, created_at: now, updated_at: now });
    insert(db, 'invoice_lines', { id: 'leg-line', invoice_id: 'leg-inv', product_id: 'lg-a', quantity: 2, unit_price: 500, vat_rate: 0, tax_scheme: 'MARGIN', vat_amount: 0, line_total: 1000, stock_taken: null, legacy_stock: null, created_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}
function seedServerAccountant() {
  const db = new DatabaseSync(SERVER_DB);
  try {
    const owner = db.prepare("SELECT id, tenant_id, password_hash FROM users WHERE email = ?").get(OWNER_EMAIL);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, name, active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)')
      .run('user-e2e-acc', owner.tenant_id, 'acc.e2e@lataif.com', owner.password_hash, 'E2E Accountant', now, now);
    db.prepare("INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at) VALUES ('user-e2e-acc','branch-main','ACCOUNTANT',1,?)").run(now);
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Anmelden (wie inventory-quantity) ───────────────────────────────────────
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
    await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev("[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;");
  }
  await waitFor(c, 'a[href="/settings"]', 30000);
}
async function ensureSignedIn(c) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    if (await exists(c, 'a[href="/settings"]')) return true;
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) { try { await frontendLogin(c); return true; } catch { await sleep(1000); } }
    await sleep(400);
  }
  throw new Error('app shell never appeared');
}

// ── JPEG für die Produktions-Ausgabe (vom Seed-Werkzeug) ────────────────────
function jpegFile() {
  const b64 = seedTool('jpeg', '3');
  const f = join(RUN, 'out.jpg'); writeFileSync(f, Buffer.from(b64, 'base64')); return f;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('STOCK-LOT-INTEGRITY — UI-Lauf in der isolierten E2E-App\n');
const prodMtime = (f) => (f && existsSync(f) ? statSync(f).mtimeMs : 0);
const PROD_DB_FILE = prodDataDb();
const PROD_BEFORE = { data: prodMtime(PROD_DB_FILE), appdata: prodMtime(PROD_LOCATOR) };
let c;
try {
  stopApp(); await waitGoneAndFree();
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(seedTool('seed-primary') === 'SEED_PRIMARY_OK', 'SETUP isolierter Server als Primary (Owner)');

  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c);
  ok(true, 'SETUP erste Anmeldung/Onboarding in der E2E-App');
  c.close(); stopApp(); await waitGoneAndFree();
  seedBusiness(); seedServerAccountant();
  const JPG = jpegFile();

  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c);
  await sleep(1500);

  // ══ 0 — Startmigration auf der Altrechnung ═══════════════════════════════
  ok(one("SELECT legacy_stock FROM invoice_lines WHERE id = 'leg-line'").legacy_stock === 'pending',
    `0 Start ordnet die Altzeile ein: legacy_stock = pending (${S(one("SELECT legacy_stock FROM invoice_lines WHERE id = 'leg-line'").legacy_stock)})`);

  // ══ 1 — Artikel ohne Los: Verkauf, Zahlung, Storno ═══════════════════════
  UI.push('1 Rechnung anlegen/bezahlen/stornieren über /invoices/new, Liste, Detail');
  {
    let m = await rechnungMaske(c, 'e2e-kunde', 'nl-a', 3, 'later');
    const err = await fehlerText(c);
    ok(m === 'OK' && invCount('nl-a') === 0 && qty('nl-a') === 2, `1a Menge 3 bei Bestand 2: abgewiesen, nichts angelegt, Menge 2 (${m}; ${qty('nl-a')})`);
    ok(/no longer available|stock/i.test(err), `1a …Meldung in der Maske: „${err.slice(0, 160)}"`);
    MSG.push('1a Maske: ' + err.slice(0, 200));

    m = await rechnungMaske(c, 'e2e-kunde', 'nl-a', 1, 'later');
    ok(await warteAuf(() => invCount('nl-a') === 1), `1b Rechnung Menge 1, später zahlen: angelegt (${m})`);
    let l = lineOf('nl-a');
    ok(qty('nl-a') === 1 && Number(l.stock_taken) === 1, `1b …Bestand sofort 2→1, stock_taken = 1 (${qty('nl-a')}/${l.stock_taken}, ${l.inv_status})`);
    const inv1 = l.invoice_id;

    m = await listeVollZahlen(c, inv1);
    ok(await warteAuf(() => one('SELECT status FROM invoices WHERE id = ?', [inv1]).status === 'FINAL'), `1c Vollzahlung in der Liste → FINAL (${m})`);
    await sleep(1500);
    ok(qty('nl-a') === 1, `1c …kein zweiter Abzug beim Bezahlen, Menge bleibt 1 (${qty('nl-a')})`);

    m = await rechnungMaske(c, 'e2e-kunde', 'nl-a', 1, 'later');
    ok(await warteAuf(() => invCount('nl-a') === 2) && qty('nl-a') === 0, `1d zweite Rechnung Menge 1: Bestand 1→0 (${m}; ${qty('nl-a')})`);
    const inv2 = lineOf('nl-a').invoice_id;
    m = await stornoMaske(c, inv2);
    ok(await warteAuf(() => one('SELECT status FROM invoices WHERE id = ?', [inv2]).status === 'CANCELLED'), `1e Storno über Detail → CANCELLED (${m}; ${await fehlerText(c)})`);
    ok(qty('nl-a') === 1 && st('nl-a') === 'in_stock', `1e …genau 1 zurück 0→1, in_stock (${qty('nl-a')}/${st('nl-a')})`);
    ok(Number(one('SELECT COUNT(*) n FROM stock_lots WHERE product_id = ?', ['nl-a']).n) === 0, '1 …über den ganzen Weg kein Los entstanden');
  }

  // ══ 2 — Agentenverkauf und Umwandlung ════════════════════════════════════
  UI.push('2 Transfer anlegen/Sold/Create Invoice/Undo/Delete über /agents; Ändern der umgewandelten Rechnung über /invoices/:id/edit');
  {
    await gehFrisch(c, '/agents');
    let r = [];
    if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Transfer')", 30000))) r.push('KEIN-KNOPF');
    else {
      r.push(await clickText(c, 'New Transfer'));
      await warteBis(c, q('[data-create-transfer]'), 15000);
      r.push(await ssPick(c, 'Search clients...', 'e2e-agkunde'));
      if (!(await warteBis(c, q('[data-transfer-product="ag-a"]'), 15000))) r.push('KEIN-STUECK');
      else r.push(await klick(c, '[data-transfer-product="ag-a"]'));
      await sleep(300);
      r.push(await setByLabel(c, 'OUR PRICE (BHD)', '900'));
      r.push(await waehleIn(c, 'Unassigned', 'e2e-emp'));
      r.push(await klick(c, '[data-create-transfer]'));
    }
    ok(await warteAuf(() => !!one("SELECT id FROM agent_transfers WHERE product_id = 'ag-a'").id), `2a Transfer angelegt (${alleOk(r)}; ${await fehlerText(c)})`);
    const t = one("SELECT id, transfer_number FROM agent_transfers WHERE product_id = 'ag-a'");
    const tr = () => one('SELECT status, stock_taken, stock_lot_id, invoice_id FROM agent_transfers WHERE id = ?', [t.id]);
    ok(qty('ag-a') === 1, `2a …Anlegen nimmt noch nichts (${qty('ag-a')})`);

    const inZeile = (was) => c.ev(
      `const row=[...document.querySelectorAll('div')].find(d=>d.style&&d.style.gridTemplateColumns&&d.style.cursor==='pointer'&&d.textContent.includes(${S(t.transfer_number)}));`
      + `if(!row) return 'KEINE-ZEILE'; const el=row.querySelector('[data-transfer-'+${S(was)}+']'); if(!el) return 'KEIN-ELEMENT:'+${S(was)}; if (el.disabled) return 'DISABLED'; el.click(); return 'OK';`);
    const liste = async () => { await gehFrisch(c, '/agents'); await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Transfers')", 20000); await clickText(c, 'Transfers'); return warteBis(c, `document.body.innerText.includes(${S(t.transfer_number)})`, 20000); };

    ok(await liste(), '2b Transferliste zeigt den Transfer');
    r = [await inZeile('sold')];
    await warteBis(c, q('[data-transfer-sold-confirm]'), 10000);
    r.push(await setByLabel(c, 'ACTUAL SALE PRICE (BHD)', '950'));
    r.push(await klick(c, '[data-transfer-sold-confirm]'));
    ok(await warteAuf(() => tr().status === 'sold'), `2b „Sold" → sold (${alleOk(r)})`);
    ok(qty('ag-a') === 0 && Number(tr().stock_taken) === 1 && st('ag-a') === 'sold', `2b …Bestand 1→0, stock_taken 1, sold (${qty('ag-a')}/${tr().stock_taken}/${st('ag-a')})`);

    await liste();
    const sold2 = await inZeile('sold');
    ok(sold2 !== 'OK', `2c zweites „Sold" nicht mehr angeboten (${sold2})`);
    if (sold2 === 'OK') { await sleep(500); await klick(c, '[data-transfer-sold-confirm]'); await sleep(1500); ok(qty('ag-a') === 0, '2c …und kein zweiter Abzug'); }

    await liste();
    r = [await inZeile('convert')];
    await warteBis(c, q('[data-transfer-convert-confirm]'), 10000);
    r.push(await clickText(c, 'Auto-create from agent')); await sleep(250);
    r.push(await klick(c, '[data-transfer-convert-confirm]'));
    ok(await warteAuf(() => !!tr().invoice_id), `2d „Create Invoice" → Rechnung ${tr().invoice_id} (${alleOk(r)}; ${await fehlerText(c)})`);
    const convInv = tr().invoice_id;
    const cl = one('SELECT stock_taken FROM invoice_lines WHERE invoice_id = ?', [convInv]);
    ok(Number(cl.stock_taken) === 0 && qty('ag-a') === 0, `2d …Rechnungszeile stock_taken 0 (der Transfer hält), Bestand 0 (${cl.stock_taken}/${qty('ag-a')})`);

    const invVor = S(dbQ('SELECT * FROM invoice_lines WHERE invoice_id = ?', [convInv]));
    const m = await aendernMaske(c, convInv);
    const err = await fehlerText(c);
    MSG.push('2e Ändern Umwandlungsrechnung: ' + (err || '(keine Meldung sichtbar)') + ' | ' + (await c.ev('return location.pathname;')));
    ok(S(dbQ('SELECT * FROM invoice_lines WHERE invoice_id = ?', [convInv])) === invVor, `2e Ändern der Umwandlungsrechnung: nichts geändert (${m})`);
    ok(/undo the conversion/i.test(err), `2e …Meldung: „${err.slice(0, 180)}"`);

    await liste();
    r = [await inZeile('undo')];
    ok(await warteAuf(() => !tr().invoice_id), `2f „Undo" der Umwandlung (${alleOk(r)}; ${await fehlerText(c)})`);
    ok(qty('ag-a') === 0 && Number(tr().stock_taken) === 1, `2f …Verkauf hält das Stück weiter: Bestand 0, stock_taken 1 (${qty('ag-a')}/${tr().stock_taken})`);

    await liste();
    r = [await inZeile('edit')];
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Delete')", 10000);
    r.push(await clickText(c, 'Delete'));
    ok(await warteAuf(() => !one('SELECT id FROM agent_transfers WHERE id = ?', [t.id]).id), `2g Transfer löschen (Bestätigung) (${alleOk(r)}; Dialoge: ${MSG.filter((x) => /confirm|alert/.test(x)).slice(-2).join(' / ')})`);
    ok(qty('ag-a') === 1 && st('ag-a') === 'in_stock', `2g …genau 1 zurück 0→1, in_stock (${qty('ag-a')}/${st('ag-a')})`);
  }

  // ══ 3 — Produktion anlegen und löschen ═══════════════════════════════════
  UI.push('3 Produktion anlegen (2 Eingänge, 1 Ausgang mit Foto) und löschen über /production und /production/:id');
  {
    await gehFrisch(c, '/production');
    await warteBis(c, q('[data-production-new]'), 20000);
    const r = [await klick(c, '[data-production-new]')];
    await warteBis(c, q('[data-production-save]'), 10000); await sleep(400);
    r.push(await mehrfachWahl(c, 'Search inventory...', ['Omega Prod In1', 'Omega Prod In2']));
    r.push(await klick(c, '[data-production-output-add]'));
    // Ausgang über die normale Artikelmaske: Kategorie, Marke, Name, Foto.
    if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='E2E Cat')", 15000))) r.push('KEINE-ARTIKELMASKE');
    else {
      await clickText(c, 'E2E Cat'); await sleep(300);
      r.push(await setByLabelPrefix(c, 'BRAND', 'E2E'), await setByLabelPrefix(c, 'NAME / MODEL', 'E2E Ring'));
      r.push(await fotoWaehlen(c, JPG)); await sleep(1500);
      const trotzdem = "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Create anyway')";
      if (await c.ev(`return ${trotzdem};`)) await clickText(c, 'Create anyway');
      else { r.push(await clickIncludes(c, 'Add to Production')); if (await warteBis(c, trotzdem, 2500)) await clickText(c, 'Create anyway'); }
      await warteBis(c, "![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='E2E Cat')", 15000);
    }
    if (await warteBis(c, q('[data-production-output-value="0"]'), 10000)) r.push(await setVal(c, '[data-production-output-value="0"]', '600'));
    else r.push('KEIN-AUSGANG');
    await sleep(400);
    r.push(await klick(c, '[data-production-save]'));
    ok(await warteAuf(() => !!one('SELECT id FROM production_records LIMIT 1').id), `3a Produktion angelegt (${alleOk(r)}; ${await fehlerText(c)})`);
    const rec = one('SELECT id FROM production_records LIMIT 1').id;
    const ins = dbQ('SELECT product_id, lot_consumption FROM production_inputs WHERE record_id = ? ORDER BY product_id', [rec]);
    ok(ins.length === 2 && ins.every((i) => JSON.parse(i.lot_consumption || 'null')?.qty === 1), `3a …beide Eingänge mit Verbrauchsnachweis (${S(ins.map((i) => i.lot_consumption))})`);
    ok(qty('pr-1') === 0 && qty('pr-2') === 0 && st('pr-1') === 'consumed', `3a …Eingänge 1→0, consumed (${qty('pr-1')}/${qty('pr-2')}/${st('pr-1')})`);
    const outId = one('SELECT product_id FROM production_outputs WHERE record_id = ?', [rec]).product_id;
    const dlgText = async () => c.ev("const m=[...document.querySelectorAll('p')].find(p=>/Delete this record\\?/.test(p.textContent)); return m?m.textContent.trim():'';");

    // Der Lösch-Hinweis steht an ZWEI Stellen (Liste und Seite) — beide müssen dasselbe sagen.
    await gehFrisch(c, '/production');
    await warteBis(c, "[...document.querySelectorAll('svg.lucide-trash-2')].length > 0", 20000);
    await c.ev("const b=[...document.querySelectorAll('button')].find(x=>x.querySelector('svg.lucide-trash-2')); if(b) b.click(); return 1;");
    await sleep(600);
    const hinweisListe = await dlgText();
    MSG.push('3b Lösch-Dialog (Liste): ' + hinweisListe);
    await clickText(c, 'Cancel');
    await sleep(400);
    ok(await warteAuf(() => !!one('SELECT id FROM production_records WHERE id = ?', [rec]).id), '3b „Cancel“ im Listen-Dialog lässt die Produktion stehen');
    await gehFrisch(c, `/production/${rec}`);
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Delete Record'))", 20000);
    const d = [await clickIncludes(c, 'Delete Record')];
    await sleep(500);
    const hinweis = await dlgText();
    MSG.push('3b Lösch-Dialog: ' + hinweis);
    d.push(await clickText(c, 'Delete'));
    ok(await warteAuf(() => !one('SELECT id FROM production_records WHERE id = ?', [rec]).id), `3b Produktion löschen (${alleOk(d)})`);
    ok(qty('pr-1') === 1 && qty('pr-2') === 1 && st('pr-1') === 'in_stock' && st('pr-2') === 'in_stock', `3b …genau der Verbrauch zurück: 0→1 je Eingang, in_stock (${qty('pr-1')}/${qty('pr-2')}/${st('pr-1')}/${st('pr-2')})`);
    ok(!one('SELECT id FROM products WHERE id = ?', [outId]).id, `3b …Ausgangsartikel entfernt (${outId})`);
    for (const [wo, t] of [['Liste', hinweisListe], ['Seite', hinweis]]) {
      ok(/go back to stock/i.test(t) && /removed from inventory/i.test(t)
        && !/inputs stay deleted|output products remain in inventory/i.test(t),
        `3b …der Lösch-Dialog (${wo}) beschreibt genau das: „${t}"`);
    }
  }

  // ══ 4 — Retoure und gesperrte Änderungen ═════════════════════════════════
  UI.push('4 Retoure (Back to Stock), Retouren-Storno, Rechnungs-Storno mit Retoure, Ändern einer Altrechnung');
  {
    let m = await rechnungMaske(c, 'e2e-kunde', 'rt-a', 1, 'full');
    ok(await warteAuf(() => invCount('rt-a') === 1) && qty('rt-a') === 0, `4a Rechnung rt-a voll bezahlt: Bestand 1→0 (${m}; ${qty('rt-a')})`);
    const invR = lineOf('rt-a').invoice_id;

    await gehFrisch(c, `/invoices/${invR}`);
    const r = [];
    if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Create Return'))", 20000))) r.push('KEIN-KNOPF');
    else {
      r.push(await clickIncludes(c, 'Create Return'));
      await warteBis(c, q('[data-return-save]'), 10000);
      r.push(await c.ev("const h=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()==='UNIT PRICE (incl. VAT)'); if(!h) return 'NO-HEAD'; const cb=h.parentElement.parentElement.querySelector('input[type=checkbox]:not([disabled])'); if(!cb) return 'NO-BOX'; cb.click(); return 'OK';"));
      await sleep(250);
      r.push(await clickText(c, 'Cash'), await clickText(c, 'Back to Stock'), await clickText(c, 'Refund later (Status: Pending)'));
      await sleep(300);
      r.push(await klick(c, '[data-return-save]'));
    }
    ok(await warteAuf(() => !!one('SELECT id FROM sales_returns WHERE invoice_id = ?', [invR]).id), `4b Retoure angelegt (${alleOk(r)}; ${await fehlerText(c)})`);
    ok(await warteAuf(() => qty('rt-a') === 1), `4b …Back to Stock: Bestand 0→1 (${qty('rt-a')}/${st('rt-a')})`);

    // Rechnung mit Retoure stornieren → gesperrt.
    const vorS = one('SELECT status FROM invoices WHERE id = ?', [invR]).status;
    m = await stornoMaske(c, invR);
    const errS = await fehlerText(c);
    MSG.push('4c Storno mit Retoure: ' + (errS || '(keine Meldung / kein Knopf: ' + m + ')'));
    ok(one('SELECT status FROM invoices WHERE id = ?', [invR]).status === vorS && qty('rt-a') === 1, `4c Storno einer Rechnung mit Retoure: nichts geändert (${m}; ${errS.slice(0, 160)})`);

    // Das zurückgenommene Stück wieder verkaufen, dann die Retoure stornieren → RETURN_STOCK_RESOLD.
    m = await rechnungMaske(c, 'e2e-kunde', 'rt-a', 1, 'later');
    ok(await warteAuf(() => invCount('rt-a') === 2) && qty('rt-a') === 0, `4d Wiederverkauf: Bestand 1→0 (${m}; ${qty('rt-a')})`);
    const invR2 = lineOf('rt-a').invoice_id;
    const retoure = async () => {
      await gehFrisch(c, `/invoices/${invR}`);
      const x = [];
      if (!(await warteBis(c, q('[data-return-cancel-open]'), 20000))) return 'KEIN-KNOPF';
      x.push(await klick(c, '[data-return-cancel-open]'));
      await warteBis(c, q('[data-return-cancel-reason]'), 8000);
      x.push(await setVal(c, '[data-return-cancel-reason]', 'E2E Storno'));
      await sleep(200);
      x.push(await klick(c, '[data-return-cancel-confirm]'));
      await sleep(1800);
      return alleOk(x);
    };
    m = await retoure();
    const errR = await fehlerText(c);
    MSG.push('4e Retouren-Storno nach Wiederverkauf: ' + (errR || '(keine Meldung: ' + m + ')'));
    ok(one('SELECT status FROM sales_returns WHERE invoice_id = ?', [invR]).status !== 'REJECTED' && qty('rt-a') === 0,
      `4e Retoure stornieren, nachdem das Stück wieder verkauft ist: abgewiesen, Bestand 0 (${m}; ${one('SELECT status FROM sales_returns WHERE invoice_id = ?', [invR]).status})`);
    ok(/RETURN_STOCK_RESOLD|resold|sold again/i.test(errR), `4e …Meldung: „${errR.slice(0, 180)}"`);

    m = await stornoMaske(c, invR2);
    ok(await warteAuf(() => qty('rt-a') === 1), `4f Wiederverkauf storniert: Bestand 0→1 (${m}; ${qty('rt-a')})`);
    m = await retoure();
    ok(await warteAuf(() => one('SELECT status FROM sales_returns WHERE invoice_id = ?', [invR]).status === 'REJECTED'), `4g jetzt Retoure stornierbar (${m}; ${await fehlerText(c)})`);
    ok(qty('rt-a') === 0, `4g …Stück wieder beim Käufer: Bestand 1→0 (${qty('rt-a')})`);

    // Altrechnung ändern → LEGACY_STOCK_LINES; Vollzahlung → genau ein alter Abzug.
    const vorL = S(dbQ("SELECT * FROM invoice_lines WHERE invoice_id = 'leg-inv'"));
    m = await aendernMaske(c, 'leg-inv');
    const errL = await fehlerText(c);
    MSG.push('4h Ändern Altrechnung: ' + (errL || '(keine Meldung: ' + m + ')'));
    ok(S(dbQ("SELECT * FROM invoice_lines WHERE invoice_id = 'leg-inv'")) === vorL && qty('lg-a') === 3, `4h Ändern der Altrechnung: nichts geändert, Bestand 3 (${m})`);
    ok(/created before the current stock tracking/i.test(errL) && /if cancellation is available/i.test(errL) && !/LEGACY_STOCK_LINES/.test(errL),
      `4h …verständliche Meldung ohne Fehlercode: „${errL.slice(0, 180)}"`);
    m = await listeVollZahlen(c, 'leg-inv');
    ok(await warteAuf(() => one("SELECT status FROM invoices WHERE id = 'leg-inv'").status === 'FINAL'), `4i Altrechnung voll bezahlt → FINAL (${m}; ${await fehlerText(c)})`);
    await sleep(1500);
    ok(qty('lg-a') === 2 && one("SELECT legacy_stock FROM invoice_lines WHERE id = 'leg-line'").legacy_stock === 'deducted',
      `4i …alter Vertrag genau einmal: 3→2 (nicht 1), deducted (${qty('lg-a')}/${one("SELECT legacy_stock FROM invoice_lines WHERE id = 'leg-line'").legacy_stock})`);
  }

  // ══ 5 — Mobile-Upload-Berechtigung (HTTP, echter Server der E2E-App) ═════
  {
    const login = async (email) => { const r = await fetch(`${HTTP}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: OWNER_PW }) }); return r.ok ? (await r.json()).token : 'HTTP' + r.status; };
    const img = seedTool('jpeg', '5');
    const upload = async (tok, ev) => {
      const body = { protocol_version: 1, upload_event_id: ev, entity_id: 'mob-' + ev, mode: 'collection', metadata: { brand: 'Rolex', name: 'E2E Mobile', categoryId: 'cat-watch' }, images: [{ mime: 'image/jpeg', data_base64: img }] };
      const r = await fetch(`${HTTP}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
      return r.status;
    };
    const inbox = () => Number(dbQ('SELECT COUNT(*) n FROM mobile_upload_inbox', [], SERVER_DB)[0]?.n);
    const tOwner = await login(OWNER_EMAIL), tAcc = await login('acc.e2e@lataif.com');
    ok(tOwner.length > 20 && tAcc.length > 20, `5 Anmeldung Owner und ACCOUNTANT am E2E-Server (${String(tOwner).slice(0, 6)}…/${String(tAcc).slice(0, 6)}…)`);
    const i0 = inbox();
    const sAcc = await upload(tAcc, 'ev-acc-1');
    ok(sAcc === 403 && inbox() === i0, `5a ACCOUNTANT: /api/mobile/upload → ${sAcc}, keine Inbox-Zeile`);
    const sOwn = await upload(tOwner, 'ev-own-1');
    ok(sOwn === 201 && inbox() === i0 + 1, `5b Owner: /api/mobile/upload → ${sOwn}, eine Inbox-Zeile`);
    const rp = await fetch(`${HTTP}/api/sync/push`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tOwner}` }, body: '{"changes":[]}' });
    const jp = await rp.text();
    ok(rp.status === 403 && /LEGACY_SYNC_DISABLED/.test(jp), `5c /api/sync/push mit Login-Token → ${rp.status} ${jp}`);
  }

  c.close();
} catch (e) {
  FAIL++; fails.push('suite error: ' + (e && e.message ? e.message : String(e)));
  console.log('E2E ERROR:', e && e.stack ? e.stack : e);
} finally {
  stopApp(); await waitGoneAndFree();
}
ok(prodMtime(PROD_DB_FILE) === PROD_BEFORE.data && prodMtime(PROD_LOCATOR) === PROD_BEFORE.appdata,
  `ISOLATION Produktionsdatenbank und Produktions-Zeiger unverändert (Änderungszeit; ${PROD_DB_FILE || 'kein Zeiger gefunden'})`);

console.log('\nMeldungen/Dialoge:'); for (const m of MSG) console.log('   · ' + m);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — stock-lot UI e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
