// MOBILE-FIELDS-CONTRACT-V2-I1 — full 6-category v2 contract E2E: real /mobile page → v2 POST → inbox →
// drain → product → media → desktop product-detail readback → desktop edit/save/reopen, for EVERY real
// category. Plus: v2 negative matrix (each 422/409, no inbox/blob/product leak), v1 legacy compat + a real
// persisted-v1-inbox restart drain, dependsOn + category-switch stale-field, and full-payload exactly-once.
//
// Isolated e2e identifier + AppData + sync port (LATAIF_E2E_SYNC_PORT=3011); production (3001) never touched.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
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

const RUN = join(os.tmpdir(), 'lataif-fields-e2e', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const STAGING = join(APP_DATA_DIR, 'mobile-upload-staging');
const PROD_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  \u2717 ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const verify = () => Object.fromEntries(seed('verify').replace('VERIFY ', '').split(' ').map((kv) => kv.split('=')));
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql) { let db; try { db = new DatabaseSync(file); return db.prepare(sql).all(); } catch { return []; } finally { try { db?.close(); } catch {} } }
const inboxCount = () => { const r = dbQ(SERVER_DB, 'SELECT COUNT(*) c FROM mobile_upload_inbox'); return r.length ? r[0].c : -1; };
const readyCount = () => { const r = dbQ(SERVER_DB, "SELECT COUNT(*) c FROM mobile_upload_inbox WHERE state='ready'"); return r.length ? r[0].c : -1; };
const productRow = (id) => { const r = dbQ(BIZ_DB, `SELECT id,category_id,brand,name,condition,scope_of_delivery,attributes,purchase_price,planned_sale_price,min_sale_price,expected_margin FROM products WHERE id='${id}'`); return r.length ? r[0] : null; };
const productCount = () => { const r = dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM products'); return r.length ? r[0].c : -1; };
// MEDIA-EDIT-PRESERVE — the active gallery of a product (deleted_at IS NULL), and
// global blob-generation count, to prove a pure text edit neither retires a link
// nor creates a new one/blob.
const activeLinks = (id) => dbQ(BIZ_DB, `SELECT media_id, is_primary FROM media_links WHERE entity_id='${id}' AND deleted_at IS NULL ORDER BY sort_order`);
const linkTotal = (id) => { const r = dbQ(BIZ_DB, `SELECT COUNT(*) c FROM media_links WHERE entity_id='${id}'`); return r.length ? r[0].c : -1; };
const blobGenTotal = () => { const r = dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM media_blob_generations'); return r.length ? r[0].c : -1; };
const stagedFiles = (root) => { let n = 0; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else if (!e.name.endsWith('.tmp')) n++; } }; walk(root); return n; };

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else if (m.method) { for (const h of this.handlers) h(m); } }); }
  on(fn) { this.handlers.push(fn); }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  close() { try { this.ws.close(); } catch {} }
}
const S = (v) => JSON.stringify(v);

// ── app helpers ──
let appProc;
async function startApp() {
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error('app CDP page did not come up');
  return page.webSocketDebuggerUrl;
}
function killApp() { try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
function killAllApp() {
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {}
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -match 'lataif-fields-e2e|remote-debugging-port=" + EDGE_CDP + "' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }"], { stdio: 'ignore' }); } catch {}
}
async function waitPortFree(port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; } if (!n) return true; await sleep(500); } return false; }
async function waitHealthy() { const end = Date.now() + 40000; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); } throw new Error('server never healthy'); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
async function invoke(c, cmd, args) { return c.ev(`return (async()=>{ try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; } })();`); }
const setValApp = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const existsApp = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
async function waitApp(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsApp(c, sel)) return true; await sleep(300); } throw new Error('waitApp ' + sel); }
async function frontendLogin(c) {
  await waitApp(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 60000);
  if (await existsApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setValApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co'); await setValApp(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`); await waitApp(c, 'input[placeholder="Full name"]');
    await setValApp(c, 'input[placeholder="Full name"]', 'E2E Admin'); await setValApp(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL); await setValApp(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click();`); await waitApp(c, 'input[placeholder="10"]');
    await setValApp(c, 'input[placeholder="10"]', '10'); await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click();`);
  } else { await setValApp(c, 'input[type="email"]', OWNER_EMAIL); await setValApp(c, 'input[type="password"]', ONBOARD_PW); await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click();`); }
  await waitApp(c, 'a[href="/settings"], nav a, [data-testid]', 45000);
}
async function pollReady(want, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (readyCount() >= want) return true; await sleep(1000); } return false; }
async function openDetailText(c, entity, t = 15000) {
  await c.ev(`history.pushState({},'', ${S('/collection/' + entity)}); window.dispatchEvent(new PopStateEvent('popstate'));`).catch(() => {});
  const end = Date.now() + t; let txt = '';
  while (Date.now() < end) { await sleep(1000); txt = await c.ev(`return document.body ? document.body.innerText : '';`); if (txt && txt.length > 120 && !/not found/i.test(txt)) break; }
  return txt || '';
}
// Desktop edit: open detail, click Edit, change the universal name, Save, reopen, return the reopened text.
async function editProductName(c, entity, oldName, newName) {
  await openDetailText(c, entity);
  await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Edit'); if(b) b.click(); return !!b;`);
  const end = Date.now() + 8000; let found = false;
  while (Date.now() < end) { found = await c.ev(`return [...document.querySelectorAll('input')].some(i=>i.value===${S(oldName)});`); if (found) break; await sleep(300); }
  if (!found) return '';
  await c.ev(`const i=[...document.querySelectorAll('input')].find(x=>x.value===${S(oldName)}); if(!i) return 'NO'; const p=HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(i, ${S(newName)}); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
  await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Save'); if(b) b.click(); return !!b;`);
  await sleep(1800);
  await c.ev(`history.pushState({},'', '/collection'); window.dispatchEvent(new PopStateEvent('popstate'));`).catch(() => {});
  await sleep(800);
  return await openDetailText(c, entity);
}

// MOBILE-PRICING — desktop edit of a single price field (by its Input label prefix), then reopen. Used to
// prove a price edit persists AND does not disturb the media gallery (text-only durable path).
async function editProductField(c, entity, labelPrefix, newVal) {
  await openDetailText(c, entity);
  await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Edit'); if(b) b.click(); return !!b;`);
  const end = Date.now() + 8000; let ready = false;
  while (Date.now() < end) { ready = await c.ev(`return [...document.querySelectorAll('label')].some(l=>l.textContent.trim().startsWith(${S(labelPrefix)}));`); if (ready) break; await sleep(300); }
  if (!ready) return 'NOEDIT';
  const set = await c.ev(`const lab=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith(${S(labelPrefix)})); if(!lab) return 'NOLABEL'; const inp=lab.parentElement.querySelector('input'); if(!inp) return 'NOINPUT'; const p=HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(inp, ${S(newVal)}); inp.dispatchEvent(new Event('input',{bubbles:true})); inp.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
  if (set !== 'OK') return set;
  await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Save'); if(b) b.click(); return !!b;`);
  await sleep(1800);
  await c.ev(`history.pushState({},'', '/collection'); window.dispatchEvent(new PopStateEvent('popstate'));`).catch(() => {});
  await sleep(600);
  return 'OK';
}

// ── server login + direct POST ──
async function serverLogin() { const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) }); return (await r.json()).token; }
async function post(token, event, entity, meta, imgB64, version = 2, includeMeta = true) {
  const body = { protocol_version: version, upload_event_id: event, entity_id: entity, mode: 'collection', images: [{ mime: 'image/jpeg', data_base64: imgB64 }] };
  if (includeMeta) body.metadata = meta;
  const r = await fetch(`${BASE}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

// ── Edge (real /mobile page) ──
let edgeProc;
async function startEdge(url) {
  edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, 'about:blank'], { stdio: 'ignore' });
  const end = Date.now() + 40000; let ws = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/list`)).json(); const pg = l.find((t) => t.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
  if (!ws) throw new Error('edge CDP did not come up');
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('Network.enable');
  const uploads = [], responses = [];
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') { const r = m.params.request; if (r && /\/api\/mobile\/upload$/.test(r.url) && r.method === 'POST' && r.postData) { try { uploads.push(JSON.parse(r.postData)); } catch {} } }
    else if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r && /\/api\/mobile\/upload$/.test(r.url)) responses.push(r.status); }
  });
  await c.send('Page.navigate', { url }); await sleep(1500);
  return { c, uploads, responses };
}
function killEdge() { try { execFileSync('taskkill', ['/F', '/PID', String(edgeProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
const existsE = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const visE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return !!e && !e.classList.contains('hidden') && e.offsetParent!==null;`);
async function waitE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsE(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitVisE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await visE(c, sel)) return true; await sleep(200); } throw new Error('waitVisE ' + sel); }
const setValE = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickChip = (c, container, text) => c.ev(`const b=[...document.querySelectorAll(${S(container + ' .chip')})].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function setFile(c, sel, path) { const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false }); await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [path] }); }
async function mobileLogin(c) { await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW); await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker'); }

// Data-driven category matrix. `attrs`: key → [inputValue, expectedPersisted]. `req`: required attr keys.
const CATS = [
  { id: 'cat-watch', label: 'Watch', brandReq: true, cond: 'Pre-Owned', scope: ['Box', 'Papers'],
    attrs: { case_diameter_mm: ['41', 41], dial: ['Black', 'Black'], serial_number: ['SER-1', 'SER-1'], reference_number: ['126610', '126610'], material: ['Steel', 'Steel'] },
    visible: ['case_diameter_mm', 'dial', 'material'], absent: ['weight', 'item_type'] },
  { id: 'cat-gold-jewelry', label: 'Gold', brandReq: false, cond: 'New', scope: ['Certificate'],
    attrs: { weight: ['12.5', 12.5], diamond_weight: ['0.75', 0.75], item_type: ['Ring', 'Ring'], karat: ['18K Yellow', '18K Yellow'] },
    visible: ['weight', 'karat', 'item_type'], absent: ['case_diameter_mm', 'dial'] },
  { id: 'cat-branded-gold-jewelry', label: 'BrandedGold', brandReq: true, cond: 'New', scope: [],
    attrs: { item_type: ['Bracelet', 'Bracelet'], size: ['52', '52'], karat: ['18K Yellow', '18K Yellow'], weight: ['20', 20] },
    visible: ['item_type', 'size', 'karat'], absent: ['case_diameter_mm', 'color'] },
  { id: 'cat-original-gold-jewelry', label: 'OriginalGold', brandReq: true, cond: 'Antique', scope: ['Box'],
    attrs: { item_type: ['Necklace', 'Necklace'], karat: ['21K Yellow', '21K Yellow'], weight: ['30', 30], model_number: ['MN-9', 'MN-9'] },
    visible: ['item_type', 'karat'], absent: ['case_diameter_mm', 'color'] },
  { id: 'cat-accessory', label: 'Accessory', brandReq: false, cond: 'Pre-Owned', scope: ['Dust Bag'],
    attrs: { item_type: ['Handbag', 'Handbag'], color: ['Black', 'Black'], material: ['Leather', 'Leather'], description: ['Nice bag', 'Nice bag'] },
    visible: ['color', 'material', 'item_type'], absent: ['weight', 'karat'] },
  { id: 'cat-spare-part', label: 'SparePart', brandReq: true, cond: 'New', scope: ['Packaging'],
    attrs: { part_type: ['Dial', 'Dial'], material: ['Steel', 'Steel'], original_or_copy: ['Original', 'Original'], description: ['spare desc', 'spare desc'] },
    visible: ['part_type', 'original_or_copy'], absent: ['case_diameter_mm', 'color'] },
];

// MOBILE-PRICING — the three canonical prices per category. `raw` is what the user types into the
// /mobile inputs (watch uses a decimal COMMA to exercise client normalisation → dot); `exp` is the
// numeric value expected in the payload + DB. All categories carry pricing (product-level, all six).
const PRICES = {
  'cat-watch':                { raw: { purchasePrice: '1,25', plannedSalePrice: '2.5', minSalePrice: '2' },       exp: { purchase_price: 1.25, planned_sale_price: 2.5,  min_sale_price: 2 } },
  'cat-gold-jewelry':         { raw: { purchasePrice: '100',  plannedSalePrice: '150.75', minSalePrice: '120' },  exp: { purchase_price: 100,  planned_sale_price: 150.75, min_sale_price: 120 } },
  'cat-branded-gold-jewelry': { raw: { purchasePrice: '250.5', plannedSalePrice: '400', minSalePrice: '300' },    exp: { purchase_price: 250.5, planned_sale_price: 400, min_sale_price: 300 } },
  'cat-original-gold-jewelry':{ raw: { purchasePrice: '80',   plannedSalePrice: '95.25', minSalePrice: '85' },    exp: { purchase_price: 80,   planned_sale_price: 95.25, min_sale_price: 85 } },
  'cat-accessory':            { raw: { purchasePrice: '30',   plannedSalePrice: '45', minSalePrice: '' },         exp: { purchase_price: 30,   planned_sale_price: 45, min_sale_price: null } },
  'cat-spare-part':           { raw: { purchasePrice: '', plannedSalePrice: '', minSalePrice: '' },               exp: { purchase_price: 0,    planned_sale_price: null, min_sale_price: null } },
};
const expPayloadPrices = (catId) => { const e = PRICES[catId].exp; const o = {}; if (e.purchase_price) o.purchasePrice = e.purchase_price; if (e.planned_sale_price != null) o.plannedSalePrice = e.planned_sale_price; if (e.min_sale_price != null) o.minSalePrice = e.min_sale_price; return o; };

async function fillAndSubmit(edge, cat, jpg, i, doubleClick = false) {
  await setValE(edge, '#cCategory', cat.id); await sleep(500);
  for (const k of cat.visible) ok(await existsE(edge, '#attr_' + k), `${cat.label}: field ${k} visible`);
  for (const k of cat.absent) ok(!(await existsE(edge, '#attr_' + k)), `${cat.label}: foreign field ${k} NOT visible`);
  await setFile(edge, '#cPhotoInput', jpg); await waitVisE(edge, '#cPhotoStatus', 10000);
  await setValE(edge, '#cBrand', 'BR-' + cat.label); await setValE(edge, '#cName', 'NM-' + cat.label); await setValE(edge, '#cSku', 'SKU-' + i);
  await setValE(edge, '#cCondition', cat.cond);
  for (const s of cat.scope) await clickChip(edge, '#cScope', s);
  for (const [k, [v]] of Object.entries(cat.attrs)) await setValE(edge, '#attr_' + k, v);
  // MOBILE-PRICING — fill the three price inputs (empty string leaves the field blank → optional/null).
  const pr = PRICES[cat.id].raw;
  await setValE(edge, '#cPurchasePrice', pr.purchasePrice); await setValE(edge, '#cSalePrice', pr.plannedSalePrice); await setValE(edge, '#cMinSalePrice', pr.minSalePrice);
  await sleep(200);
  if (doubleClick) await edge.ev(`const b=document.querySelector('#cSaveBtn'); b.click(); b.click(); return 'OK';`);
  else await clickE(edge, '#cSaveBtn');
}

async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;

  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');
  const jpg = join(RUN, 'a.jpg'); writeFileSync(jpg, Buffer.from(seed('jpeg', '1'), 'base64'));
  const imgB64 = seed('jpeg', '1');

  const ws = await startApp(); const app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  ok(true, 'e2e server healthy on ' + PORT + ' (production 3001 untouched)');
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');

  const { c: edge, uploads } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLogin(edge);
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');

  // ── dependsOn + category-switch stale-field (real page) ──
  await setValE(edge, '#cCategory', 'cat-watch'); await sleep(400);
  await setValE(edge, '#attr_material', 'Solid Gold'); await sleep(200);
  ok(await visE(edge, '#row_karat_color'), 'dependsOn: karat_color visible when material=Solid Gold');
  await setValE(edge, '#attr_karat_color', '18K Yellow'); await sleep(150);
  await setValE(edge, '#attr_material', 'Steel'); await sleep(200);
  ok(!(await visE(edge, '#row_karat_color')), 'dependsOn: karat_color hidden again when material=Steel');
  await setValE(edge, '#cCategory', 'cat-gold-jewelry'); await sleep(400);
  ok(!(await existsE(edge, '#attr_dial')) && !(await existsE(edge, '#attr_karat_color')), 'category switch drops all watch-only fields');

  // ── 6-category matrix: fill + submit v2, capture payload ──
  const entities = {};
  for (let i = 0; i < CATS.length; i++) {
    const cat = CATS[i];
    await fillAndSubmit(edge, cat, jpg, i, i === 0); // watch (i=0) double-clicks → exactly-once
    const end = Date.now() + 20000; while (Date.now() < end && !uploads.find((u) => u.metadata?.categoryId === cat.id)) await sleep(200); await sleep(800);
    const ups = uploads.filter((u) => u.metadata?.categoryId === cat.id);
    ok(ups.length === 1, `${cat.label}: exactly one POST (double-click safe)` + (i === 0 ? '' : ' [single]'));
    const u = ups[0];
    ok(u.protocol_version === 2, `${cat.label}: POST is protocol_version 2`);
    let attrsOk = true;
    for (const [k, [, exp]] of Object.entries(cat.attrs)) if (u.metadata.attributes[k] !== exp) { attrsOk = false; console.log(`  ${cat.label} attr ${k}=${JSON.stringify(u.metadata.attributes[k])} exp ${JSON.stringify(exp)}`); }
    ok(attrsOk, `${cat.label}: payload attributes exact (typed)`);
    ok(u.metadata.condition === cat.cond, `${cat.label}: condition in payload`);
    ok(JSON.stringify(u.metadata.scopeOfDelivery || []) === JSON.stringify(cat.scope), `${cat.label}: Included/scope in payload`);
    ok(!cat.absent.some((k) => k in (u.metadata.attributes || {})), `${cat.label}: no foreign attrs in payload`);
    // MOBILE-PRICING — the v2 payload carries EXACTLY the entered prices (empty → omitted; comma → dot).
    const expP = expPayloadPrices(cat.id);
    let pricesOk = true;
    for (const [k, v] of Object.entries(expP)) if (u.metadata[k] !== v) { pricesOk = false; console.log(`  ${cat.label} payload price ${k}=${JSON.stringify(u.metadata[k])} exp ${v}`); }
    for (const k of ['purchasePrice', 'plannedSalePrice', 'minSalePrice']) if (!(k in expP) && (k in u.metadata)) { pricesOk = false; console.log(`  ${cat.label} unexpected payload price ${k}=${JSON.stringify(u.metadata[k])}`); }
    ok(pricesOk, `${cat.label}: v2 payload carries the exact prices (optional omitted, comma normalised)`);
    entities[cat.id] = u.entity_id;
    await waitVisE(edge, '#cSuccess', 10000).catch(() => {});
  }
  ok(inboxCount() === 6, 'exactly six inbox rows for the six categories');
  await edge.close(); killEdge();

  // ── v2 negative matrix (direct POST) — 422/409, no inbox growth ──
  const token = await serverLogin();
  const before = inboxCount();
  const stagedBefore = stagedFiles(STAGING);
  const neg = [
    ['missing required attr (v2 watch)', { categoryId: 'cat-watch', brand: 'X', name: 'Y' }, 2, true],
    ['missing required brand (v2)', { categoryId: 'cat-watch', name: 'Y', attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['unknown category', { categoryId: 'cat-nope', brand: 'X' }, 2, true],
    ['unknown attribute', { categoryId: 'cat-accessory', attributes: { item_type: 'Handbag', color: 'B', material: 'L', description: 'd', storage_key: 'x' } }, 2, true],
    ['foreign attribute', { categoryId: 'cat-watch', brand: 'X', name: 'Y', attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel', weight: 5 } }, 2, true],
    ['stale dependsOn field', { categoryId: 'cat-watch', brand: 'X', name: 'Y', attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel', karat_color: '18K Yellow' } }, 2, true],
    ['bad enum', { categoryId: 'cat-gold-jewelry', attributes: { weight: 5, item_type: 'Ring', karat: '99K' } }, 2, true],
    ['negative number', { categoryId: 'cat-gold-jewelry', attributes: { weight: -5, item_type: 'Ring', karat: '18K Yellow' } }, 2, true],
    ['string instead of number', { categoryId: 'cat-gold-jewelry', attributes: { weight: '12.5', item_type: 'Ring', karat: '18K Yellow' } }, 2, true],
    ['null required', { categoryId: 'cat-gold-jewelry', attributes: { weight: null, item_type: 'Ring', karat: '18K Yellow' } }, 2, true],
    ['control-plane key', { categoryId: 'cat-watch', brand: 'X', name: 'Y', tenant_id: 'EVIL', attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['oversized string', { categoryId: 'cat-accessory', attributes: { item_type: 'Handbag', color: 'B', material: 'L', description: 'x'.repeat(3000) } }, 2, true],
    // ── MOBILE-PRICING negative matrix (v2) — reject before staging ──
    ['negative purchase price', { categoryId: 'cat-watch', brand: 'X', name: 'Y', purchasePrice: -1, attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['negative sale price', { categoryId: 'cat-watch', brand: 'X', name: 'Y', plannedSalePrice: -0.5, attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['negative min price', { categoryId: 'cat-watch', brand: 'X', name: 'Y', minSalePrice: -100, attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['string price', { categoryId: 'cat-watch', brand: 'X', name: 'Y', purchasePrice: '100', attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['bool price', { categoryId: 'cat-watch', brand: 'X', name: 'Y', plannedSalePrice: true, attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['array price', { categoryId: 'cat-watch', brand: 'X', name: 'Y', purchasePrice: [1], attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['object price', { categoryId: 'cat-watch', brand: 'X', name: 'Y', purchasePrice: { v: 1 }, attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['non-finite price (JSON string form)', { categoryId: 'cat-watch', brand: 'X', name: 'Y', purchasePrice: 'Infinity', attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['unknown pricing key', { categoryId: 'cat-watch', brand: 'X', name: 'Y', maxSalePrice: 5, attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['margin mass-assignment', { categoryId: 'cat-watch', brand: 'X', name: 'Y', expectedMargin: 999, attributes: { case_diameter_mm: 40, dial: 'B', material: 'Steel' } }, 2, true],
    ['pricing on v1 (legacy surface)', { categoryId: 'cat-watch', brand: 'X', name: 'Y', purchasePrice: 10 }, 1, true],
  ];
  let allRej = true;
  for (let i = 0; i < neg.length; i++) { const [name, meta, ver, inc] = neg[i]; const r = await post(token, `neg-${i}`, `prod-neg-${i}`, meta, imgB64, ver, inc); if (r.status !== 422) { allRej = false; console.log('  neg not 422:', name, r.status, JSON.stringify(r.body)); } }
  ok(allRej, 'every invalid v2 payload → 422 rejected');
  // unknown protocol version + missing metadata
  const badVer = await post(token, 'neg-ver', 'prod-neg-ver', { categoryId: 'cat-watch' }, imgB64, 3, true);
  ok(badVer.status === 422 && badVer.body?.code === 'MOBILE_UPLOAD_UNSUPPORTED_PROTOCOL', 'unknown protocol_version 3 → 422');
  const noMeta = await post(token, 'neg-nometa', 'prod-neg-nometa', {}, imgB64, 2, false);
  ok(noMeta.status === 400 || noMeta.status === 422, 'v2 without metadata → 4xx');
  ok(inboxCount() === before, 'no inbox row created by ANY rejected request (no leak)');
  ok(stagedFiles(STAGING) === stagedBefore, 'no staged blob from any reject (content-addressed staging unchanged)');

  // ── v1 legacy compat (minimal, no required attrs) + version-identity conflict (direct POST) ──
  const v1 = await post(token, 'ev-v1', 'prod-v1', { categoryId: 'cat-watch', brand: 'LegacyBrand', name: 'Legacy Watch', sku: null }, imgB64, 1, true);
  ok(v1.status === 201 && v1.body?.state === 'accepted', 'v1 legacy minimal payload (no required attrs) → 201 accepted');
  // version is part of payload identity: the SAME id + SAME (fully valid) metadata under v1 then v2 → conflict.
  const fullM = { categoryId: 'cat-watch', brand: 'VerBrand', name: 'Ver Watch', attributes: { case_diameter_mm: 40, dial: 'Black', material: 'Steel' } };
  ok((await post(token, 'ev-ver', 'prod-ver', fullM, imgB64, 1, true)).status === 201, 'full valid payload accepted under v1');
  ok((await post(token, 'ev-ver', 'prod-ver', fullM, imgB64, 2, true)).status === 409, 'same uploadEventId + same metadata but v1→v2 → 409 (version in payload identity)');
  ok(inboxCount() === before + 2, 'two legacy inbox rows added; the version conflict was a no-op');

  // ── drain everything → products persisted, readback + edit per category ──
  await frontendLogin(app);
  if (!(await pollReady(8, 70000))) { await app.ev(`window.location.reload();`).catch(() => {}); await sleep(3000); }
  ok(await pollReady(8, 40000), 'app drain created all 8 products (6 v2 + 2 legacy) → ready');

  let sixReadback = true, sixEdit = true, sixMedia = true, sixPrice = true;
  for (const cat of CATS) {
    const id = entities[cat.id]; const row = productRow(id);
    if (!row) { sixReadback = false; console.log('  no product row for ' + cat.label); continue; }
    const a = JSON.parse(row.attributes || '{}');
    let good = row.category_id === cat.id && row.condition === cat.cond
      && JSON.stringify(JSON.parse(row.scope_of_delivery || '[]')) === JSON.stringify(cat.scope);
    for (const [k, [, exp]] of Object.entries(cat.attrs)) if (a[k] !== exp) { good = false; console.log(`  ${cat.label} DB attr ${k}=${JSON.stringify(a[k])} exp ${JSON.stringify(exp)}`); }
    ok(good, `${cat.label}: business DB has ALL fields (attributes+condition+scope, typed)`);
    if (!good) sixReadback = false;
    // MOBILE-PRICING — the three prices persisted EXACTLY (optional → null). Values are binary-exact.
    const expP = PRICES[cat.id].exp;
    const priceReadOk = row.purchase_price === expP.purchase_price && row.planned_sale_price === expP.planned_sale_price && row.min_sale_price === expP.min_sale_price;
    if (!priceReadOk) { sixPrice = false; console.log(`  ${cat.label} DB prices: ${JSON.stringify({ p: row.purchase_price, s: row.planned_sale_price, m: row.min_sale_price })} exp ${JSON.stringify(expP)}`); }
    ok(priceReadOk, `${cat.label}: purchase/sale/min prices persisted EXACTLY to the business DB`);
    // UI readback: detail renders a representative value.
    const detail = await openDetailText(app, id);
    const sample = Object.values(cat.attrs)[0][1];
    ok(detail.includes(String(sample)) && detail.includes('NM-' + cat.label), `${cat.label}: desktop product detail renders the mobile values`);
    // MEDIA-EDIT-PRESERVE — snapshot the mobile photo's gallery BEFORE a pure
    // text edit (name only). The uploaded product has exactly one active link.
    const linksBefore = activeLinks(id); const totalBefore = linkTotal(id); const gensBefore = blobGenTotal();
    ok(linksBefore.length === 1, `${cat.label}: uploaded product has exactly 1 active media link before edit`);
    const mediaIdBefore = linksBefore[0]?.media_id;
    const pricesBefore = { p: row.purchase_price, s: row.planned_sale_price, m: row.min_sale_price };
    // desktop edit → save → reopen. This changes ONLY the name → text-only path.
    const reopened = await editProductName(app, id, 'NM-' + cat.label, 'NM-' + cat.label + ' EDITED');
    if (!reopened.includes('NM-' + cat.label + ' EDITED')) { sixEdit = false; console.log('  edit failed for ' + cat.label); }
    ok(reopened.includes('NM-' + cat.label + ' EDITED'), `${cat.label}: desktop edit → save → reopen persists`);
    // THE FIX: the mobile photo must survive a text-only edit — same active
    // link, same media identity, nothing retired, no new link, no new blob.
    const linksAfter = activeLinks(id);
    const mediaSurvived = linksAfter.length === 1 && linksAfter[0]?.media_id === mediaIdBefore
      && linkTotal(id) === totalBefore && blobGenTotal() === gensBefore;
    if (!mediaSurvived) { sixMedia = false; console.log(`  MEDIA LOST for ${cat.label}: before=${mediaIdBefore} after=${JSON.stringify(linksAfter)} total ${totalBefore}->${linkTotal(id)} gens ${gensBefore}->${blobGenTotal()}`); }
    ok(mediaSurvived, `${cat.label}: mobile photo SURVIVES a text-only desktop edit (link+identity+blob preserved)`);
    // A pure text edit must NOT change any price.
    const afterName = productRow(id);
    const pricesUnchanged = afterName.purchase_price === pricesBefore.p && afterName.planned_sale_price === pricesBefore.s && afterName.min_sale_price === pricesBefore.m;
    if (!pricesUnchanged) { sixPrice = false; console.log(`  ${cat.label} prices changed by a text edit`); }
    ok(pricesUnchanged, `${cat.label}: a text-only edit leaves all prices unchanged`);
    // The desktop detail still renders an image (blob object URL), not the empty state.
    const afterImg = await app.ev(`return document.querySelectorAll('img').length;`);
    ok(afterImg > 0, `${cat.label}: product detail still shows an image after the text edit`);
    // MOBILE-PRICING — now edit a PRICE (sale price) on the desktop → persists, media still preserved.
    const newSale = (Number(expP.planned_sale_price) || 0) + 7.5;
    const pe = await editProductField(app, id, 'SALE PRICE (BHD)', String(newSale));
    const afterPrice = productRow(id);
    const priceEditOk = pe === 'OK' && afterPrice.planned_sale_price === newSale;
    const mediaStillOk = activeLinks(id).length === 1 && activeLinks(id)[0]?.media_id === mediaIdBefore && blobGenTotal() === gensBefore;
    if (!(priceEditOk && mediaStillOk)) { sixPrice = false; console.log(`  ${cat.label} price-edit: outcome=${pe} sale=${afterPrice.planned_sale_price} exp ${newSale} media=${JSON.stringify(activeLinks(id))}`); }
    ok(priceEditOk, `${cat.label}: desktop SALE PRICE edit → save → reopen persists the new price`);
    ok(mediaStillOk, `${cat.label}: media still preserved after a price edit (text-only durable path)`);
  }
  ok(sixReadback, 'six-category desktop readback: 6/6');
  ok(sixEdit, 'six-category desktop edit/save/reopen: 6/6');
  ok(sixMedia, 'six-category media SURVIVES text-only edit: 6/6 (regression guard for the photo-deletion bug)');
  ok(sixPrice, 'six-category pricing: mobile→DB readback + text-edit-preserves + price-edit-persists 6/6');
  ok(!!productRow('prod-v1') && !!productRow('prod-ver'), 'legacy v1 products persisted (backward compat end-to-end)');

  // ── restart: no re-drain (persisted inbox drains exactly once) ──
  app.close(); killApp(); await sleep(1500);
  const ws2 = await startApp(); const app2 = new CDP(ws2); await waitInvoke(app2);
  ok(inboxCount() === 8 && readyCount() === 8, 'after restart: 8 inbox rows all ready (no re-drain duplicates)');
  ok(productCount() >= 8, 'after restart: all products persisted');
  app2.close();

  // ── isolation ──
  ok(verify().secret_leaks === '0', 'no owner secret in the audit sink');
  let leaked = 0; const scan = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { try { scan(p); } catch {} } else { try { if (readFileSync(p, 'latin1').includes(OWNER_PW)) leaked++; } catch {} } } };
  try { scan(RUN); scan(APP_DATA_DIR); } catch {}
  ok(leaked === 0, 'owner secret not persisted anywhere in the isolated tree');
  ok((existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0) === prodBefore, 'production DB (3001 install) untouched');

  console.log(`\nMOBILE-FIELDS-CONTRACT-V2-I1 e2e: ${PASS} passed, ${FAIL} failed  (readback ${sixReadback ? '6/6' : 'FAIL'}, edit ${sixEdit ? '6/6' : 'FAIL'}, media-survives-edit ${sixMedia ? '6/6' : 'FAIL'}, pricing ${sixPrice ? '6/6' : 'FAIL'})`);
}
main().catch((e) => { console.error('E2E ERROR:', e?.stack || e?.message || e); FAIL++; }).finally(() => {
  try { killEdge(); } catch {} try { killAllApp(); } catch {}
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  try { rmSync(APP_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(WV2_DIR, { recursive: true, force: true }); } catch {}
  process.exit(FAIL > 0 ? 1 : 0);
});
