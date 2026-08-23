// MOBILE v0.8.48 — die Preissperre auf dem ECHTEN ausgelieferten Mobile-Edit-Screen.
//
// Alles darunter ist bereits bewiesen: die Regel selbst (`price-eligibility.ts`), die verbindliche
// Pruefung in der Schreib-Transaktion (`coordinator.ts`) und der Wortlaut des Hinweises
// (`price-lock-display.test.ts`). Was NICHT bewiesen war: dass die Regel im wirklich gerenderten
// DOM ankommt. Genau daran ist sie zuletzt gescheitert — `price_editable` wurde berechnet, aber nie
// mitgeschickt, und die drei Preisfelder waren auf dem Handy schlicht unerreichbar. Ein statischer
// Test haette das nie gesehen.
//
// Deshalb hier ausschliesslich der echte Weg: die ausgelieferte /mobile-Seite in einem echten
// Browser, Suche -> Treffer oeffnen -> frisch lesen -> "Edit item", und danach die
// Geschaeftsdatenbank als Zeuge. Keine Mock-Komponente, kein Aufruf einer Hilfsfunktion.
//
//   A  freier eigener Artikel   -> Felder sichtbar, bedienbar, Werte da, Speichern wirkt
//   B  an einer Rechnung        -> Felder sichtbar, gesperrt, Grund benannt, Notiz weiter editierbar
//   C  unklare Herkunft         -> Felder sichtbar, gesperrt, KEIN erfundener Grund
//   D  Treffer sagt "erlaubt", die Lage hat sich geaendert -> der frische Read entscheidet
//
// Isoliert: e2e-Identitaet `com.lataif.app.e2e`, eigenes AppData, Sync-Port 3011; Produktion (3001)
// wird nie geoeffnet.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, EDGE_CDP = 9224, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123', TENANT = 'tenant-1', BRANCH = 'branch-main';

const RUN = join(os.tmpdir(), 'lataif-pricelock-e2e', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  \u2717 ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const S = (v) => JSON.stringify(v);

function dbQ(file, sql, params = []) { let db; try { db = new DatabaseSync(file); return db.prepare(sql).all(...params); } catch { return []; } finally { try { db?.close(); } catch {} } }
const productRow = (id) => dbQ(BIZ_DB, 'SELECT id, name, sku, category_id, quantity, notes, source_type, purchase_price, planned_sale_price, min_sale_price FROM products WHERE id = ?', [id])[0] ?? null;
const linkRows = (id) => dbQ(BIZ_DB, 'SELECT link_id, media_id, sort_order, is_primary, deleted_at FROM media_links WHERE entity_id = ? ORDER BY link_id', [id]);
const invoiceLines = (id) => dbQ(BIZ_DB, 'SELECT id FROM invoice_lines WHERE product_id = ?', [id]);

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else if (m.method) { for (const h of this.handlers) h(m); } });
  }
  on(fn) { this.handlers.push(fn); }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  closeWs() { try { this.ws.close(); } catch {} }
}

let appProc, edgeProc;
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 90000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  return page.webSocketDebuggerUrl;
}
function killApp() { try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
function killAllApp() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
function killEdge() { try { execFileSync('taskkill', ['/F', '/PID', String(edgeProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
async function waitPortFree(port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; } if (!n) return true; await sleep(500); } return false; }
async function waitHealthy() { const end = Date.now() + 40000; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); } throw new Error('server never healthy'); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
async function invoke(c, cmd, args) { return c.ev(`try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; }`); }

const setValApp = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const existsApp = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
async function waitApp(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsApp(c, sel)) return true; await sleep(300); } throw new Error('waitApp ' + sel); }
async function frontendLogin(c) {
  await waitApp(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 60000);
  const click = (label) => c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${S(label)})?.click(); return 1;`);
  if (await existsApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setValApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setValApp(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await click('Next'); await waitApp(c, 'input[placeholder="Full name"]');
    await setValApp(c, 'input[placeholder="Full name"]', 'E2E Admin');
    await setValApp(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setValApp(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await click('Next'); await waitApp(c, 'input[placeholder="10"]');
    await setValApp(c, 'input[placeholder="10"]', '10');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
  } else {
    await setValApp(c, 'input[type="email"]', OWNER_EMAIL);
    await setValApp(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`);
  }
  await waitApp(c, 'a[href="/settings"], nav a, [data-testid]', 45000);
}

const existsE = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const visE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return !!e && !e.classList.contains('hidden') && e.offsetParent!==null;`);
const disabledE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? !!e.disabled : null;`);
const valueE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.value : null;`);
async function waitE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsE(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitVisE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await visE(c, sel)) return true; await sleep(200); } throw new Error('waitVisE ' + sel); }
const setValE = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if(e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
const textE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.textContent.trim() : '';`);
async function mobileLogin(c) { await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW); await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker'); }
/** Anmelden UND beweisen, dass das Token wirklich gilt — ein Serverneustart waehrend des Bootens
 *  wuerde es sonst still entwerten und jeden folgenden Lesefehler entschuldbar machen. */
async function mobileLoginVerified(c) {
  const probe = async () => {
    const t = await c.ev(`return localStorage.getItem('lataif_mobile_token');`);
    if (!t) return 0;
    return (await fetch(`${BASE}/api/products/by-sku/__auth_probe__`, { headers: { Authorization: 'Bearer ' + t } })).status;
  };
  await mobileLogin(c);
  let st = await probe();
  if (st === 401) { await c.ev(`localStorage.removeItem('lataif_mobile_token'); location.reload(); return 1;`); await sleep(2500); await mobileLogin(c); st = await probe(); }
  ok(st !== 0 && st !== 401, `the mobile session is really authenticated before the fixture (${st})`);
}

async function startEdge(url) {
  edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, 'about:blank'], { stdio: 'ignore' });
  const end = Date.now() + 40000; let ws = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/list`)).json(); const pg = l.find((t) => t.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
  if (!ws) throw new Error('edge CDP did not come up');
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('Network.enable');
  const consoleErrors = [], httpErrors = [];
  c.on((m) => {
    if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r && r.status >= 400 && !/favicon\.ico$/.test(r.url)) httpErrors.push({ status: r.status, url: String(r.url) }); }
    else if (m.method === 'Runtime.exceptionThrown') { consoleErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception')); }
  });
  await c.send('Page.navigate', { url }); await sleep(1500);
  return { c, consoleErrors, httpErrors };
}

async function serverLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) });
  return (await r.json()).token;
}
const apiById = async (token, id) => { const r = await fetch(`${BASE}/api/products/by-id/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer ' + token } }); return r.ok ? r.json() : null; };
const apiSearch = async (token, q) => { const r = await fetch(`${BASE}/api/products/search?q=${encodeURIComponent(q)}&limit=20`, { headers: { Authorization: 'Bearer ' + token } }); return r.ok ? (await r.json()).results || [] : []; };

// ── Fixture: vier Artikel, direkt in die Geschaeftsdatenbank, VOR dem Start der App ─────────────
//
// Der Anlageweg ist hier nicht das Thema (der ist eigenstaendig bewiesen) — die Ausgangslage ist es.
// Deshalb echte Zeilen mit echten Preisen, und fuer den Rechnungsfall die vollstaendige Kette
// Kunde -> Rechnung -> Rechnungszeile statt einer verwaisten Zeile.
const P_FREE = 'p-pl-free', P_INV = 'p-pl-inv', P_UNK = 'p-pl-unk', P_FRESH = 'p-pl-fresh';
const SKU_FREE = 'PL-FREE-001', SKU_INV = 'PL-INV-001', SKU_UNK = 'PL-UNK-001', SKU_FRESH = 'PL-FRESH-001';
const NOW = '2026-08-20T09:00:00.000Z';

function seedBusinessDb() {
  const db = new DatabaseSync(BIZ_DB);
  const branchId = db.prepare('SELECT id FROM branches LIMIT 1').get()?.id;
  if (!branchId) throw new Error('no branch in the seeded business DB');
  const cat = db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()?.id
    ?? db.prepare('SELECT id FROM categories LIMIT 1').get()?.id;
  if (!cat) throw new Error('no category in the seeded business DB');
  const ins = db.prepare(
    `INSERT OR REPLACE INTO products (id, branch_id, category_id, brand, name, sku, condition,
       storage_location, purchase_price, planned_sale_price, min_sale_price, stock_status,
       images, attributes, quantity, notes, source_type, created_at, updated_at, version, sync_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const attrs = JSON.stringify({ dial: 'Black', material: 'Steel' });
  db.exec('BEGIN');
  ins.run(P_FREE, branchId, cat, 'Rolex', 'Price Free', SKU_FREE, 'Pre-Owned', 'Safe A', 9000, 12000, 10000, 'in_stock', '[]', attrs, 3, 'free note', 'OWN', NOW, NOW, 1, 'synced');
  ins.run(P_INV, branchId, cat, 'Rolex', 'Price Invoiced', SKU_INV, 'Pre-Owned', 'Safe B', 4000, 6000, 5000, 'sold', '[]', attrs, 1, 'invoiced note', 'OWN', NOW, NOW, 1, 'synced');
  // Unklare Herkunft: eine Klasse, die dieser Bildschirm nicht kennt — so, wie sie aus einem Import
  // oder einer neueren Version stammen kann. Keine Korruption: die Spalte ist freier Text, die Zeile
  // ist vollstaendig, nur ihre Einordnung ist dem Anzeigevertrag unbekannt.
  ins.run(P_UNK, branchId, cat, 'Rolex', 'Price Unknown Origin', SKU_UNK, 'Pre-Owned', 'Safe C', 700, 900, 800, 'in_stock', '[]', attrs, 2, 'unknown note', 'IMPORTED', NOW, NOW, 1, 'synced');
  ins.run(P_FRESH, branchId, cat, 'Rolex', 'Price Fresh Read', SKU_FRESH, 'Pre-Owned', 'Safe D', 100, 200, 150, 'in_stock', '[]', attrs, 1, 'fresh note', 'OWN', NOW, NOW, 1, 'synced');

  db.prepare(`INSERT OR REPLACE INTO customers (id, branch_id, first_name, last_name, created_at, updated_at)
              VALUES (?,?,?,?,?,?)`).run('cust-pl', branchId, 'Price', 'Lock', NOW, NOW);
  db.prepare(`INSERT OR REPLACE INTO invoices (id, branch_id, invoice_number, customer_id, status, net_amount,
                vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('inv-pl', branchId, 'PL-0001', 'cust-pl', 'issued', 6000, 0, 0, 6000, 'MARGIN', NOW, NOW);
  db.exec('COMMIT');
  db.close();
  return { branchId, cat };
}

/** Eine Rechnungszeile fuer ein Produkt — die eine Bindung, die eine Preisaenderung sperrt. */
function addInvoiceLine(productId, lineId) {
  const db = new DatabaseSync(BIZ_DB);
  try {
    db.prepare(`INSERT OR REPLACE INTO invoice_lines (id, invoice_id, product_id, description, unit_price, vat_rate, tax_scheme, vat_amount, line_total, position)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run(lineId, 'inv-pl', productId, 'sold', 6000, 0, 'MARGIN', 0, 6000, 1);
  } finally { db.close(); }
}

/** Genau DEN Treffer anklicken, der diese SKU traegt.
 *
 * Nicht "die erste Karte": die vorige Trefferliste steht beim Tippen noch im DOM, und ein Wartelauf
 * auf irgendeine Karte oeffnet dann den vorigen Artikel. Der Test wuerde gruen aussehen und die
 * falsche Sache pruefen — genau das ist beim ersten Lauf passiert. */
async function clickHit(edge, sku) {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const n = await edge.ev(`return [...document.querySelectorAll('#searchResults .hit')].filter(x=>x.textContent.includes(${S(sku)})).length;`);
    if (n === 1) break;
    await sleep(300);
  }
  const clicked = await edge.ev(`const c=[...document.querySelectorAll('#searchResults .hit')].filter(x=>x.textContent.includes(${S(sku)})); if(c.length!==1) return c.length; c[0].click(); return 'OK';`);
  if (clicked !== 'OK') throw new Error(`search did not show exactly one hit for ${sku} (${clicked})`);
  await waitVisE(edge, '#scanResult', 15000);
}

/** Suchen, Treffer oeffnen, Bearbeiten aufklappen — genau die Handgriffe des Benutzers. */
async function openForEdit(edge, sku) {
  await clickE(edge, '#tabSearch'); await waitVisE(edge, '#searchPane');
  await setValE(edge, '#searchInput', sku);
  await clickHit(edge, sku);
  await waitE(edge, '#pdEditBtn', 15000);
  await clickE(edge, '#pdEditBtn');
  await waitVisE(edge, '#pdEditForm', 10000);
}
const PRICE_SEL = ['#pePurchasePrice', '#peSalePrice', '#peMinSalePrice'];
async function priceDom(edge) {
  const out = { visible: [], disabled: [], values: [] };
  out.box = await visE(edge, '#pePrices');
  for (const s of PRICE_SEL) { out.visible.push(await visE(edge, s)); out.disabled.push(await disabledE(edge, s)); out.values.push(await valueE(edge, s)); }
  out.lockVisible = await visE(edge, '#pePriceLock');
  out.lockText = await textE(edge, '#pePriceLock');
  return out;
}
async function waitPrice(id, field, want, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = productRow(id); if (r && Number(r[field]) === want) return true; await sleep(1000); }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');

  // Erster Start nur, damit Mandant, Filiale, Kategorien und der Besitzer real entstehen.
  let ws = await startApp(); let app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');
  await frontendLogin(app);
  app.closeWs(); killApp(); await sleep(2500);

  seedBusinessDb();
  addInvoiceLine(P_INV, 'invline-pl-1');
  ok(productRow(P_FREE)?.source_type === 'OWN', 'fixture: the free item is our own stock');
  ok(invoiceLines(P_INV).length === 1, 'fixture: the invoiced item really carries an invoice line');
  ok(invoiceLines(P_FREE).length === 0, 'fixture: the free item carries none');

  // Neustart GEGEN die gesetzten Daten — die App liest sie damit auch in ihren eigenen Speicher.
  ws = await startApp(); app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  await frontendLogin(app);
  const token = await serverLogin();

  const { c: edge, consoleErrors, httpErrors } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLoginVerified(edge);
  await clickE(edge, '.mode-btn[data-mode="scan"]'); await waitVisE(edge, '#scanScreen');

  // ════════════════════════════════════════════════════════════════════════
  // A — freier eigener Artikel: sichtbar, bedienbar, und das Speichern wirkt
  // ════════════════════════════════════════════════════════════════════════
  const beforeA = productRow(P_FREE); const linksA = linkRows(P_FREE);
  const readA = await apiById(token, P_FREE);
  ok(readA?.price_editable === true, `A the read contract releases the free item (${S(readA?.price_editable)})`);

  await openForEdit(edge, SKU_FREE);
  ok((await textE(edge, '#scanDetails')).includes('Price Free'), 'A DOM the screen really shows the free item');
  const a = await priceDom(edge);
  ok(a.box === true, 'A DOM the price section is on screen');
  ok(a.visible.every(Boolean), `A DOM all three price fields are visible (${S(a.visible)})`);
  ok(a.disabled.every((d) => d === false), `A DOM …and none of them is disabled (${S(a.disabled)})`);
  ok(Number(a.values[0]) === 9000 && Number(a.values[1]) === 12000 && Number(a.values[2]) === 10000,
    `A DOM the current values came from the fresh read (${S(a.values)})`);
  ok(a.lockVisible === false && a.lockText === '', `A DOM no lock hint is shown ("${a.lockText}")`);
  ok(await disabledE(edge, '#peNotes') === false, 'A DOM the descriptive fields are editable too');

  await setValE(edge, '#peSalePrice', '12750');
  ok(await clickE(edge, '#peSave') === 'OK', 'A the save button clicks');
  const savedA = await waitPrice(P_FREE, 'planned_sale_price', 12750, 120000);
  ok(savedA, `A SAVE the new sale price reached the business database (msg: ${await textE(edge, '#peMsg')}; inbox: ${S(dbQ(SERVER_DB, 'SELECT state, error_code FROM mobile_upload_inbox'))})`);
  const afterA = productRow(P_FREE);
  ok(Number(afterA?.purchase_price) === 9000, `A SAVE the purchase price is untouched (${afterA?.purchase_price})`);
  ok(Number(afterA?.min_sale_price) === 10000, `A SAVE the minimum sale price is untouched (${afterA?.min_sale_price})`);
  ok(afterA?.sku === beforeA.sku, 'A SAVE the SKU is unchanged');
  ok(afterA?.category_id === beforeA.category_id, 'A SAVE the category is unchanged');
  ok(Number(afterA?.quantity) === Number(beforeA.quantity), `A SAVE the quantity is unchanged (${afterA?.quantity})`);
  ok(JSON.stringify(linkRows(P_FREE)) === JSON.stringify(linksA), 'A SAVE the gallery is unchanged');

  // ════════════════════════════════════════════════════════════════════════
  // B — an einer Rechnung: sichtbar, gesperrt, mit Grund; der Rest bleibt nutzbar
  // ════════════════════════════════════════════════════════════════════════
  const readB = await apiById(token, P_INV);
  ok(readB?.price_editable === false, `B the read contract locks the invoiced item (${S(readB?.price_editable)})`);
  ok(readB?.price_lock_reason === 'linked' && readB?.price_lock_detail === 'Invoice',
    `B …and names the invoice (${S(readB?.price_lock_reason)}/${S(readB?.price_lock_detail)})`);

  await clickE(edge, '#pdBack').catch(() => {});
  await openForEdit(edge, SKU_INV);
  ok((await textE(edge, '#scanDetails')).includes('Price Invoiced'), 'B DOM the screen really shows the invoiced item');
  const b = await priceDom(edge);
  ok(b.box === true, 'B DOM the price section is still on screen — not hidden away');
  ok(b.visible.every(Boolean), `B DOM all three price fields are visible (${S(b.visible)})`);
  ok(Number(b.values[0]) === 4000 && Number(b.values[1]) === 6000 && Number(b.values[2]) === 5000,
    `B DOM the current prices are readable (${S(b.values)})`);
  ok(b.disabled.every((d) => d === true), `B DOM every one of them is disabled (${S(b.disabled)})`);
  ok(b.lockVisible === true, 'B DOM the reason is shown');
  ok(b.lockText === '\uD83D\uDD12 Price editing locked \u2014 linked to Invoice.', `B DOM …and it names the invoice ("${b.lockText}")`);
  ok(await disabledE(edge, '#peNotes') === false, 'B DOM the item is NOT locked as a whole — the note stays editable');

  const beforeB = productRow(P_INV);
  await setValE(edge, '#peNotes', 'note on a sold item');
  ok(await clickE(edge, '#peSave') === 'OK', 'B the save button clicks');
  const savedB = await (async () => { const end = Date.now() + 120000; while (Date.now() < end) { if (productRow(P_INV)?.notes === 'note on a sold item') return true; await sleep(1000); } return false; })();
  ok(savedB, `B SAVE the note reached the business database (msg: ${await textE(edge, '#peMsg')})`);
  const afterB = productRow(P_INV);
  ok(Number(afterB?.purchase_price) === Number(beforeB.purchase_price)
    && Number(afterB?.planned_sale_price) === Number(beforeB.planned_sale_price)
    && Number(afterB?.min_sale_price) === Number(beforeB.min_sale_price),
    `B SAVE not one price moved (${afterB?.purchase_price}/${afterB?.planned_sale_price}/${afterB?.min_sale_price})`);

  // ════════════════════════════════════════════════════════════════════════
  // C — unklare Herkunft: gesperrt, aber ohne erfundenen Grund
  // ════════════════════════════════════════════════════════════════════════
  const readC = await apiById(token, P_UNK);
  ok(readC?.price_editable === false, `C the read contract locks what it cannot classify (${S(readC?.price_editable)})`);
  ok(readC?.price_lock_reason === 'unknown' && readC?.price_lock_detail === undefined,
    `C …and states no reason at all (${S(readC?.price_lock_reason)}/${S(readC?.price_lock_detail)})`);

  await clickE(edge, '#pdBack').catch(() => {});
  await openForEdit(edge, SKU_UNK);
  ok((await textE(edge, '#scanDetails')).includes('Price Unknown Origin'), 'C DOM the screen really shows the unclassified item');
  const cDom = await priceDom(edge);
  ok(cDom.box === true && cDom.visible.every(Boolean), `C DOM the price fields are visible (${S(cDom.visible)})`);
  ok(cDom.disabled.every((d) => d === true), `C DOM all of them are disabled (${S(cDom.disabled)})`);
  ok(cDom.lockText === '\uD83D\uDD12 Price editing locked for this item.', `C DOM the hint stays general ("${cDom.lockText}")`);
  ok(!/Invoice|Purchase|Stock lot|Consignment|linked to|agent/i.test(cDom.lockText),
    'C DOM …and invents neither an invoice nor a purchase nor a lot');
  ok(await disabledE(edge, '#peNotes') === false, 'C DOM the descriptive fields stay editable');

  // ════════════════════════════════════════════════════════════════════════
  // D — der zwischengespeicherte Treffer entscheidet NICHT
  // ════════════════════════════════════════════════════════════════════════
  //
  // Genau der Live-Fehler aus v0.8.47, jetzt auf den Preisstatus angewandt: die Trefferliste bleibt
  // beim Zurueckgehen absichtlich erhalten. Aendert sich die Lage in der Zwischenzeit, darf der alte
  // Treffer nicht zur Bearbeitungsgrundlage werden.
  await clickE(edge, '#pdBack').catch(() => {});
  const hits = await apiSearch(token, SKU_FRESH);
  ok(hits.length === 1 && hits[0].id === P_FRESH, `D the search finds the item (${hits.length})`);
  ok(hits[0].price_editable === true, `D the search hit says "editable" (${S(hits[0].price_editable)})`);

  await openForEdit(edge, SKU_FRESH);
  const d1 = await priceDom(edge);
  ok(d1.disabled.every((x) => x === false), `D the screen first shows it as editable (${S(d1.disabled)})`);

  // Zurueck zur Liste — sie wird NICHT neu abgefragt, die alten Treffer stehen weiter da.
  ok(await clickE(edge, '#pdBack') === 'OK', 'D back to search keeps the previous hits');
  await waitVisE(edge, '#searchPane', 10000);
  addInvoiceLine(P_FRESH, 'invline-pl-2');
  ok(invoiceLines(P_FRESH).length === 1, 'D the item is now on an invoice');
  const readD = await apiById(token, P_FRESH);
  ok(readD?.price_editable === false && readD?.price_lock_detail === 'Invoice',
    `D a fresh read now locks it (${S(readD?.price_editable)}/${S(readD?.price_lock_detail)})`);

  // Denselben, unveraenderten Treffer aus der Liste oeffnen.
  await clickHit(edge, SKU_FRESH);
  await waitE(edge, '#pdEditBtn', 15000);
  await clickE(edge, '#pdEditBtn'); await waitVisE(edge, '#pdEditForm', 10000);
  ok((await textE(edge, '#scanDetails')).includes('Price Fresh Read'), 'D DOM the screen really shows the same item again');
  const d2 = await priceDom(edge);
  ok(d2.visible.every(Boolean), `D DOM the price fields are still visible (${S(d2.visible)})`);
  ok(d2.disabled.every((x) => x === true), `D DOM …but now disabled — the fresh read decided, not the cached hit (${S(d2.disabled)})`);
  ok(d2.lockText === '\uD83D\uDD12 Price editing locked \u2014 linked to Invoice.', `D DOM …with the current reason ("${d2.lockText}")`);
  ok(invoiceLines(P_FRESH).length === 1, 'D the invoice line was still there while the screen was read');

  // ── Sauberkeit ─────────────────────────────────────────────────────────
  const inbox = dbQ(SERVER_DB, 'SELECT upload_event_id, state, error_code FROM mobile_upload_inbox');
  ok(inbox.every((r) => r.state === 'ready'), `no stranded or quarantined upload job (${S(inbox)})`);
  ok(consoleErrors.length === 0, `no uncaught page exception (${consoleErrors.slice(0, 2).join(' | ')})`);
  ok(httpErrors.length === 0, `no unexpected HTTP error (${S(httpErrors.slice(0, 3))})`);

  edge.closeWs(); killEdge(); app.closeWs(); killApp();
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killEdge(); killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    console.log(`\nMOBILE price-lock DOM: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
