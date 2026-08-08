// MOBILE-MEDIA-PRICING-I1C — the two end-to-end proofs the I1B slice left open, both through REAL UI:
//
//   §3/§4  real /mobile page: category-switch pricing behaviour, then a PRICED v2 watch enqueued while
//          OFFLINE → durable queue survives a full page reload → back online → retry → exactly-once.
//   §1     real Tauri/WebView2 ProductDetail: explicit UI image remove (single / one-of-two / all) and
//          add-after-empty — the reconcile path that MUST still work after the preserve fix.
//   §2/§5  real UI recheck: a pure text/price save keeps the SAME image RENDERED (not just linked).
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

const RUN = join(os.tmpdir(), 'lataif-mediaui-e2e', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
const PROD_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');
const PROD_BIZ_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  \u2717 ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const verify = () => Object.fromEntries(seed('verify').replace('VERIFY ', '').split(' ').map((kv) => kv.split('=')));
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql) { let db; try { db = new DatabaseSync(file); return db.prepare(sql).all(); } catch { return []; } finally { try { db?.close(); } catch {} } }
const one = (file, sql) => { const r = dbQ(file, sql); return r.length ? r[0] : null; };
const num = (file, sql) => { const r = dbQ(file, sql); return r.length ? Number(Object.values(r[0])[0]) : -1; };
const inboxCount = () => num(SERVER_DB, 'SELECT COUNT(*) c FROM mobile_upload_inbox');
const readyCount = () => num(SERVER_DB, "SELECT COUNT(*) c FROM mobile_upload_inbox WHERE state='ready'");
const productCount = () => num(BIZ_DB, 'SELECT COUNT(*) c FROM products');
const receiptCount = (ev) => num(BIZ_DB, `SELECT COUNT(*) c FROM mobile_upload_receipts WHERE upload_event_id='${ev}'`);
const productRow = (id) => one(BIZ_DB, `SELECT id,brand,name,condition,attributes,purchase_price,planned_sale_price,min_sale_price,images FROM products WHERE id='${id}'`);
// Active gallery (ordered) and the full link history, so a soft-delete is visible and countable.
const activeLinks = (id) => dbQ(BIZ_DB, `SELECT media_id, sort_order, is_primary FROM media_links WHERE entity_id='${id}' AND deleted_at IS NULL ORDER BY sort_order`);
const allLinks = (id) => dbQ(BIZ_DB, `SELECT media_id, sort_order, is_primary, deleted_at FROM media_links WHERE entity_id='${id}'`);
const deletedLinks = (id) => dbQ(BIZ_DB, `SELECT media_id FROM media_links WHERE entity_id='${id}' AND deleted_at IS NOT NULL`);
// Blob-side totals: a link remove must NEVER delete a blob/generation (no physical delete, no soft delete).
const blobStats = () => ({
  blobs: num(BIZ_DB, 'SELECT COUNT(*) c FROM media_blobs'),
  liveBlobs: num(BIZ_DB, 'SELECT COUNT(*) c FROM media_blobs WHERE deleted_at IS NULL'),
  gens: num(BIZ_DB, 'SELECT COUNT(*) c FROM media_blob_generations'),
  liveGens: num(BIZ_DB, 'SELECT COUNT(*) c FROM media_blob_generations WHERE deleted_at IS NULL'),
  files: mediaFiles().length,
});
const mediaFiles = () => { const out = []; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const q = join(p, e.name); if (e.isDirectory()) walk(q); else out.push(q); } }; walk(MEDIA_ROOT); return out; };
const sameStats = (a, b) => a.blobs === b.blobs && a.liveBlobs === b.liveBlobs && a.gens === b.gens && a.liveGens === b.liveGens && a.files === b.files;

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else if (m.method) { for (const h of this.handlers) h(m); } }); }
  on(fn) { this.handlers.push(fn); }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  close() { try { this.ws.close(); } catch {} }
}
const S = (v) => JSON.stringify(v);

// ── app process ──
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
  try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -match 'lataif-mediaui-e2e|remote-debugging-port=" + EDGE_CDP + "' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }"], { stdio: 'ignore' }); } catch {}
}
async function waitPortFree(port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; } if (!n) return true; await sleep(500); } return false; }
async function waitHealthy() { const end = Date.now() + 40000; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); } throw new Error('server never healthy'); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
async function invoke(c, cmd, args) { return c.ev(`try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; }`); }
const setValApp = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const existsApp = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
async function waitApp(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsApp(c, sel)) return true; await sleep(300); } throw new Error('waitApp ' + sel); }
async function frontendLogin(c) {
  await waitApp(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 60000);
  if (await existsApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setValApp(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co'); await setValApp(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click(); return 1;`); await waitApp(c, 'input[placeholder="Full name"]');
    await setValApp(c, 'input[placeholder="Full name"]', 'E2E Admin'); await setValApp(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL); await setValApp(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click(); return 1;`); await waitApp(c, 'input[placeholder="10"]');
    await setValApp(c, 'input[placeholder="10"]', '10'); await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
  } else { await setValApp(c, 'input[type="email"]', OWNER_EMAIL); await setValApp(c, 'input[type="password"]', ONBOARD_PW); await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`); }
  await waitApp(c, 'a[href="/settings"], nav a, [data-testid]', 45000);
}
async function pollReady(want, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (readyCount() >= want) return true; await sleep(1000); } return false; }

// ── ProductDetail UI driving (the REAL desktop UI) ──
async function openDetail(c, id, t = 20000) {
  await c.ev(`history.pushState({},'', ${S('/collection/' + id)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`).catch(() => {});
  const end = Date.now() + t; let txt = '';
  while (Date.now() < end) { await sleep(1000); txt = await c.ev(`return document.body ? document.body.innerText : '';`); if (txt && txt.length > 120 && !/not found/i.test(txt)) break; }
  return txt || '';
}
async function leaveDetail(c) { await c.ev(`history.pushState({},'', '/collection'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`).catch(() => {}); await sleep(700); }
/** The rendered gallery: how many <img> the detail shows from a real blob: Object-URL (i.e. resolved media). */
const renderedBlobImgs = (c) => c.ev(`return [...document.querySelectorAll('img')].filter(i=>String(i.currentSrc||i.src).startsWith('blob:')).length;`);
const clickEdit = (c) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Edit'); if(!b) return 'NO'; b.click(); return 'OK';`);
const clickSave = (c) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Save'); if(!b) return 'NO'; b.click(); return 'OK';`);
/** Number of image cells currently in the editor's ImageUpload draft (the grid cell that holds an <img>). */
const draftPhotos = (c) => c.ev(`const inp=document.querySelector('input[type=file][accept="image/*"]'); if(!inp) return -1; const grid=inp.parentElement.firstElementChild; return [...grid.children].filter(x=>x.querySelector('img')).length;`);
/** Click the X on the idx-th draft image — the REAL user remove gesture. */
const removePhoto = (c, idx) => c.ev(`const inp=document.querySelector('input[type=file][accept="image/*"]'); if(!inp) return 'NO'; const grid=inp.parentElement.firstElementChild; const cells=[...grid.children].filter(x=>x.querySelector('img')); const cell=cells[${idx}]; if(!cell) return 'NOCELL'; const b=cell.querySelector('button'); if(!b) return 'NOBTN'; b.click(); return 'OK';`);
const PHOTO_INPUT = 'input[type=file][accept="image/*"]';
async function setFileApp(c, sel, path) { const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false }); await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: path ? [path] : [] }); }
/** The ONLY success signal for an add: the editor's draft grew by EXACTLY one preview. `input.files`
 *  is deliberately not used — it reflects what CDP wrote, not what the app took up. Growing by more
 *  than one is an anomaly and fails closed rather than passing. */
async function waitDraftUptake(c, before, t) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    const n = await draftPhotos(c);
    if (n === before + 1) return true;
    if (n > before + 1) return false;
    await sleep(250);
  }
  return false;
}
/**
 * Add a photo through the REAL hidden file input, with exactly ONE controlled harness retry.
 *
 * Root cause of the intermittent gate: a second `DOM.setFileInputFiles` on the SAME input within one
 * editor session does not reliably fire `change` in WebView2, so the app never sees the pick. The file
 * list is therefore cleared first, which makes the re-set a genuine change. This retries ONLY the CDP
 * file-picking gesture — never a save, a reconcile, a DB write or any product operation — and never
 * more than once. If the app still does not take the file up, the test fails with a harness diagnosis.
 */
async function addPhoto(c, path) {
  const before = await draftPhotos(c);
  // Bind only to an ATTACHED, settled input node. On an EMPTY gallery the editor swaps the disabled
  // placeholder out the moment photo editing unlocks, which re-creates the sibling <input>; a file set
  // on the node captured a tick earlier lands on a DETACHED element and the app never sees the pick.
  await waitStableFileInput(c);
  await setFileApp(c, PHOTO_INPUT, path);
  // Generous first window: a slow compress is NOT a lost event. Re-picking too eagerly would feed the
  // SAME bytes into the draft twice, which in turn makes one durable batch stage two identical
  // renditions — a purely test-made pathology that surfaced as assorted ingest errors.
  if (await waitDraftUptake(c, before, 15000)) return true;
  const mid = await draftPhotos(c);
  if (mid !== before) { console.log(`    [harness] addPhoto: unexpected draft movement ${before} → ${mid}`); return false; }
  await waitStableFileInput(c);
  await setFileApp(c, PHOTO_INPUT, null); // clear → the next set is a real change event
  await sleep(600);
  const afterClear = await draftPhotos(c);
  if (afterClear === before + 1) return true;   // the first pick landed late — must NOT be picked again
  if (afterClear !== before) { console.log(`    [harness] addPhoto: draft moved to ${afterClear} while clearing`); return false; }
  await setFileApp(c, PHOTO_INPUT, path);
  if (await waitDraftUptake(c, before, 15000)) return true;
  console.log(`    [harness] addPhoto: the editor did not take the file up after one controlled re-set (draft ${before} → ${await draftPhotos(c)})`);
  return false;
}
/** Wait until the hidden file input exists, is attached to the document, and stayed the SAME node
 *  across a settle interval — i.e. the editor is done re-rendering around it. */
async function waitStableFileInput(c, t = 8000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    const a = await c.ev(`const e=document.querySelector(${S(PHOTO_INPUT)}); if(!e||!document.contains(e)) return null; window.__e2eLastInput=e; return true;`);
    if (a) {
      await sleep(350);
      const same = await c.ev(`const e=document.querySelector(${S(PHOTO_INPUT)}); return !!e && document.contains(e) && e===window.__e2eLastInput;`);
      if (same) return true;
      continue;
    }
    await sleep(200);
  }
  return false;
}
async function waitEditor(c, t = 12000) { const end = Date.now() + t; while (Date.now() < end) { if ((await draftPhotos(c)) >= 0) return true; await sleep(300); } return false; }
/** Click Save, wait until the durable gallery actually reaches `expectLinks`, then reopen the detail.
 *  Returns any media error code the editor surfaced (empty string = clean save). */
async function saveAndReopen(c, id, expectLinks, t = 90000) {
  await clickSave(c);
  // Wait for BOTH: the durable gallery reached the expected shape AND the editor actually closed (the
  // page leaves edit mode only on a durable success). Polling the DB alone can continue while a slow
  // save is still running, which would leave the frozen edit batch open and make the NEXT edit collide
  // with it — a harness artefact, not a product behaviour.
  const end = Date.now() + t;
  while (Date.now() < end) {
    const closed = await c.ev(`return ![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Save');`);
    if (closed && activeLinks(id).length === expectLinks) break;
    await sleep(500);
  }
  const err = await c.ev(`const t=document.body?document.body.innerText:''; return t.split('\\n').filter(l=>/MEDIA_[A-Z_]+/.test(l)).join(' | ');`);
  await leaveDetail(c); await openDetail(c, id);
  return err || '';
}
/** True once photo editing is UNLOCKED, i.e. the draft was seeded from the final gallery (the
 *  "Images loading…" notice is the product's own signal for the locked state). */
const photoControlsLocked = (c) => c.ev(`return !!document.querySelector('#media-loading-notice');`);
/** Enter the editor and wait until the draft holds the expected gallery images AND photo editing has
 *  unlocked — i.e. what a real user does: open Edit, wait for the photos to appear, then act. */
async function enterEditor(c, expectPhotos, t = 25000) {
  await clickEdit(c); await waitEditor(c);
  const end = Date.now() + t;
  while (Date.now() < end) {
    if ((await draftPhotos(c)) === expectPhotos && !(await photoControlsLocked(c))) return true;
    await sleep(300);
  }
  return (await draftPhotos(c)) === expectPhotos && !(await photoControlsLocked(c));
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
const setOffline = (c, off) => c.send('Network.emulateNetworkConditions', { offline: off, latency: 0, downloadThroughput: off ? 0 : -1, uploadThroughput: off ? 0 : -1 });
const existsE = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const visE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return !!e && !e.classList.contains('hidden') && e.offsetParent!==null;`);
const valE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.value : null;`);
async function waitE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsE(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitVisE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await visE(c, sel)) return true; await sleep(200); } throw new Error('waitVisE ' + sel); }
const setValE = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickChip = (c, container, text) => c.ev(`const b=[...document.querySelectorAll(${S(container + ' .chip')})].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function setFileE(c, sel, path) { const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false }); await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [path] }); }
async function mobileLogin(c) { await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW); await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker'); }
/** Read the DURABLE IndexedDB queue directly (independent of any page global), projected so no image bytes
 *  are serialised across CDP — only their length + a short fingerprint, which is enough to prove identity. */
const readQueue = (c) => c.ev(`
  const rows = await new Promise((res, rej) => { const r = indexedDB.open('lataif_mobile_uploads', 1);
    r.onsuccess = () => { const db = r.result; const q = db.transaction('collectionUploads','readonly').objectStore('collectionUploads').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); };
    r.onerror = () => rej(r.error); });
  return rows.map((e) => ({ uploadEventId: e.uploadEventId, entityId: e.entityId, protocolVersion: e.protocolVersion, state: e.state,
    metadata: e.metadata, imageCount: (e.images||[]).length, imageLen: (e.images&&e.images[0]||'').length, imageTail: (e.images&&e.images[0]||'').slice(-24) }));`);

const WATCH_META = { brand: 'OfflineBrand', name: 'Offline Submariner', sku: 'OFF-1', cond: 'Pre-Owned', scope: ['Box', 'Papers'],
  attrs: { case_diameter_mm: ['41', 41], dial: ['Black', 'Black'], material: ['Steel', 'Steel'] } };
const PRICES = { purchasePrice: ['1,25', 1.25], plannedSalePrice: ['2.5', 2.5], minSalePrice: ['2', 2] };

async function fillWatch(c) {
  await setValE(c, '#cCategory', 'cat-watch'); await sleep(400);
  await setValE(c, '#cBrand', WATCH_META.brand); await setValE(c, '#cName', WATCH_META.name); await setValE(c, '#cSku', WATCH_META.sku);
  await setValE(c, '#cCondition', WATCH_META.cond);
  for (const s of WATCH_META.scope) await clickChip(c, '#cScope', s);
  for (const [k, [v]] of Object.entries(WATCH_META.attrs)) await setValE(c, '#attr_' + k, v);
  await setValE(c, '#cPurchasePrice', PRICES.purchasePrice[0]); await setValE(c, '#cSalePrice', PRICES.plannedSalePrice[0]); await setValE(c, '#cMinSalePrice', PRICES.minSalePrice[0]);
}

// ══════════════════════════════════════════════════════════════════════════
async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start (no zombie listener)');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;
  const prodBizBefore = existsSync(PROD_BIZ_DB) ? statSync(PROD_BIZ_DB).mtimeMs : 0;

  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');
  const jpg1 = join(RUN, 'a.jpg'); writeFileSync(jpg1, Buffer.from(seed('jpeg', '1'), 'base64'));
  const jpg2 = join(RUN, 'b.jpg'); writeFileSync(jpg2, Buffer.from(seed('jpeg', '7'), 'base64'));
  const jpg3 = join(RUN, 'c.jpg'); writeFileSync(jpg3, Buffer.from(seed('jpeg', '13'), 'base64'));
  const jpg4 = join(RUN, 'd.jpg'); writeFileSync(jpg4, Buffer.from(seed('jpeg', '29'), 'base64'));

  let app = new CDP(await startApp()); await waitInvoke(app); await waitHealthy();
  ok(true, 'e2e server healthy on ' + PORT + ' (production 3001 untouched)');
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');

  const { c: edge, uploads, responses } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLogin(edge);
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');

  // ══ §4 — category switch: pricing is PRODUCT-wide (all 6 categories), attributes are not ══
  await setValE(edge, '#cCategory', 'cat-watch'); await sleep(400);
  await setValE(edge, '#cPurchasePrice', '11.5'); await setValE(edge, '#cSalePrice', '22'); await setValE(edge, '#cMinSalePrice', '18');
  await setValE(edge, '#attr_dial', 'Black');
  await setValE(edge, '#cCategory', 'cat-gold-jewelry'); await sleep(500);
  ok(await existsE(edge, '#cPurchasePrice'), 'pricing fields exist for a non-watch category (product-wide per SSOT)');
  const [p1, s1, m1] = [await valE(edge, '#cPurchasePrice'), await valE(edge, '#cSalePrice'), await valE(edge, '#cMinSalePrice')];
  ok(p1 === '11.5' && s1 === '22' && m1 === '18', 'category switch keeps the three product-wide prices (deliberate form contract)');
  ok(!(await existsE(edge, '#attr_dial')) && !(await existsE(edge, '#attr_case_diameter_mm')), 'category switch drops the previous category-specific attributes (no stale fields)');
  await setValE(edge, '#cCategory', 'cat-watch'); await sleep(500);
  const [p2, s2, m2] = [await valE(edge, '#cPurchasePrice'), await valE(edge, '#cSalePrice'), await valE(edge, '#cMinSalePrice')];
  ok(p2 === '11.5' && s2 === '22' && m2 === '18', 'switching back is deterministic (prices unchanged)');
  ok((await valE(edge, '#attr_dial')) === '', 'switching back re-renders category attributes EMPTY (never a stale value)');

  // ══ §3 — priced v2 watch enqueued while OFFLINE, survives a full page reload, then retries ══
  await fillWatch(edge);
  await setFileE(edge, '#cPhotoInput', jpg1); await waitVisE(edge, '#cPhotoStatus', 10000);
  await setOffline(edge, true);
  const inboxBefore = inboxCount();
  await clickE(edge, '#cSaveBtn');
  // the send must fail while offline → the entry stays durable and drainable
  let q = [];
  const qEnd = Date.now() + 40000;
  while (Date.now() < qEnd) { q = await readQueue(edge); if (q.length === 1 && q[0].state === 'retryable') break; await sleep(500); }
  ok(q.length === 1, 'offline save persisted EXACTLY ONE durable queue entry');
  ok(inboxCount() === inboxBefore, 'nothing reached the server while offline (inbox unchanged)');
  const q0 = q[0] || {};
  ok(q0.state === 'retryable', 'the offline entry is retryable (an unknown/failed send never deletes it)');
  ok(q0.protocolVersion === 2, 'queued entry carries protocol_version 2');
  ok(q0.imageCount === 1 && q0.imageLen > 100, 'queued entry still carries its photo bytes (media stays attached)');
  const md0 = q0.metadata || {};
  ok(md0.purchasePrice === PRICES.purchasePrice[1] && md0.plannedSalePrice === PRICES.plannedSalePrice[1] && md0.minSalePrice === PRICES.minSalePrice[1],
    'queued metadata holds all THREE prices, normalised (1,25 → 1.25)');
  ok(md0.brand === WATCH_META.brand && md0.name === WATCH_META.name && md0.sku === WATCH_META.sku && md0.condition === WATCH_META.cond
    && JSON.stringify(md0.scopeOfDelivery || []) === JSON.stringify(WATCH_META.scope)
    && md0.attributes?.case_diameter_mm === 41 && md0.attributes?.dial === 'Black' && md0.attributes?.material === 'Steel',
    'queued metadata holds the full v2 field set');

  // Full page reload. The document itself is served by the app, so the network must be back for the page to
  // load at all — but the page NEVER auto-drains, so this still proves the durable queue survives a reload
  // and only an explicit user trigger resends it (asserted right below: inbox still unchanged).
  await setOffline(edge, false);
  await edge.send('Page.reload', { ignoreCache: true }); await sleep(2500);
  await waitVisE(edge, '#modePicker', 25000);
  const q2 = await readQueue(edge);
  const q1 = q2[0] || {};
  ok(q2.length === 1, 'after a full page reload the queue still holds exactly one entry');
  ok(inboxCount() === inboxBefore, 'the reload alone sent NOTHING (no auto-drain; only a user trigger resends)');
  ok(q1.uploadEventId === q0.uploadEventId && q1.entityId === q0.entityId, 'reload keeps the SAME uploadEventId + entityId (never a new event)');
  ok(q1.protocolVersion === 2, 'reload keeps protocol_version 2 (retry never downgrades)');
  ok(JSON.stringify(q1.metadata) === JSON.stringify(q0.metadata), 'reload keeps the FULL metadata incl. all three prices byte-identical');
  ok(q1.imageCount === 1 && q1.imageLen === q0.imageLen && q1.imageTail === q0.imageTail, 'reload keeps the SAME photo attached to the SAME event');

  // user-triggered retry (network is back) → accepted exactly once
  await clickE(edge, '.mode-btn[data-mode="collection"]').catch(() => {});
  await waitVisE(edge, '#cRetryPending', 20000);
  const respBefore = responses.length;
  await clickE(edge, '#cRetryPending');
  const rEnd = Date.now() + 30000;
  while (Date.now() < rEnd && !responses.slice(respBefore).some((s) => s === 201 || s === 200)) await sleep(300);
  ok(responses.slice(respBefore).some((s) => s === 201 || s === 200), 'retry after reconnect is accepted (2xx)');
  const sent = uploads[uploads.length - 1] || {};
  ok(sent.protocol_version === 2 && sent.upload_event_id === q0.uploadEventId, 'the retried POST uses the SAME uploadEventId at protocol_version 2');
  ok(sent.metadata?.purchasePrice === 1.25 && sent.metadata?.plannedSalePrice === 2.5 && sent.metadata?.minSalePrice === 2, 'the retried POST carries the exact prices');
  ok(inboxCount() === inboxBefore + 1, 'exactly ONE inbox row from the whole offline→reload→retry cycle');
  const qAfter = await readQueue(edge);
  ok(qAfter.length === 0, 'a successful send drops the durable entry (no re-send on the next trigger)');
  // a second explicit retry must create nothing
  await clickE(edge, '#cRetryPending').catch(() => {});
  await sleep(2000);
  ok(inboxCount() === inboxBefore + 1, 'a SECOND retry creates no second inbox event (exactly-once)');
  const PID = q0.entityId;

  await edge.close(); killEdge();

  // ══ drain → product + media + receipt + exact prices ══
  await frontendLogin(app);
  if (!(await pollReady(1, 60000))) { await app.ev(`window.location.reload(); return 1;`).catch(() => {}); await sleep(3000); }
  ok(await pollReady(1, 45000), 'the desktop drain ingested the retried upload → inbox ready');
  const row = productRow(PID);
  ok(!!row, 'exactly the queued entityId became the product id');
  ok(productCount() === 1, 'exactly ONE product from the whole cycle');
  ok(row && row.images === '[]', "products.images stays '[]' (media lives in the durable gallery)");
  ok(receiptCount(q0.uploadEventId) === 1, 'exactly one terminal mobile_upload_receipt for this uploadEventId');
  ok(activeLinks(PID).length === 1, 'exactly ONE active media link');
  ok(row && row.purchase_price === 1.25 && row.planned_sale_price === 2.5 && row.min_sale_price === 2, 'all three prices persisted EXACTLY into the business DB');
  const attrs0 = JSON.parse(row?.attributes || '{}');
  ok(row?.brand === WATCH_META.brand && row?.condition === WATCH_META.cond && attrs0.case_diameter_mm === 41 && attrs0.material === 'Steel', 'the full v2 field set persisted');

  // ══ §2 + §5 — a pure PRICE edit keeps the SAME image RENDERED (not just linked) ══
  const detail0 = await openDetail(app, PID);
  ok(detail0.includes(WATCH_META.name), 'desktop detail opened for the mobile product');
  const imgs0 = await renderedBlobImgs(app);
  ok(imgs0 > 0, 'desktop detail RENDERS the mobile photo (blob object URL)');
  const mediaIdBefore = activeLinks(PID)[0]?.media_id;
  const statsBefore = blobStats();
  ok(await enterEditor(app, 1, 20000), 'editor seeded the draft with the ONE existing gallery image');
  await setValApp(app, 'input[value="2.5"]', '');
  const setPrice = await app.ev(`const lab=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith('SALE PRICE (BHD)')); if(!lab) return 'NOLABEL'; const inp=lab.parentElement.querySelector('input'); const p=HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(inp, '9.75'); inp.dispatchEvent(new Event('input',{bubbles:true})); inp.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
  ok(setPrice === 'OK', 'sale price changed in the real editor');
  await clickSave(app); await sleep(2200);
  await leaveDetail(app);
  const detail1 = await openDetail(app, PID);
  const rowAfterPrice = productRow(PID);
  ok(rowAfterPrice?.planned_sale_price === 9.75, 'the edited price persisted');
  ok(rowAfterPrice?.purchase_price === 1.25 && rowAfterPrice?.min_sale_price === 2, 'the OTHER two prices are unchanged');
  const linksAfterPrice = activeLinks(PID);
  ok(linksAfterPrice.length === 1 && linksAfterPrice[0].media_id === mediaIdBefore, 'the SAME media id is still the active gallery (no reconcile on a price edit)');
  ok(deletedLinks(PID).length === 0, 'no media_link was soft-deleted by the price edit (deleted_at IS NULL)');
  ok(allLinks(PID).length === 1, 'no NEW media_link was created by the price edit');
  ok(sameStats(blobStats(), statsBefore), 'no new blob/generation/file, and none deleted, from a price edit');
  ok((await renderedBlobImgs(app)) > 0 && detail1.includes(WATCH_META.name), 'after reopen the SAME image is really RENDERED again in the desktop UI');

  // ══ §1 — explicit UI remove/add through the real ProductDetail editor ══
  // (setup for B) add a SECOND photo through the real file input → 2 active links
  ok(await enterEditor(app, 1, 20000), 'editor reopened with 1 draft image');
  ok(await addPhoto(app, jpg2), 'a second photo was added through the real Add-Photo input');
  const addErr = await saveAndReopen(app, PID, 2);
  ok(addErr === '', 'UI add saved without a media error' + (addErr ? ' [' + addErr + ']' : ''));
  let links = activeLinks(PID);
  ok(links.length === 2, 'UI add → exactly TWO active media links');
  ok(links[0]?.sort_order === 0 && links[0]?.is_primary === 1 && links[1]?.sort_order === 1 && links[1]?.is_primary === 0, 'primary invariant after add: exactly one primary, at slot 0');
  ok((await renderedBlobImgs(app)) >= 2, 'both images are rendered in the desktop detail');
  const twoStats = blobStats();
  const keptId = links[1].media_id, droppedId = links[0].media_id;

  // B) remove ONE of two through the UI
  ok(await enterEditor(app, 2, 20000), 'editor seeded the draft with BOTH gallery images');
  ok((await removePhoto(app, 0)) === 'OK', 'clicked the real remove (X) on the first image');
  ok((await draftPhotos(app)) === 1, 'the draft now holds exactly one image');
  const rmOneErr = await saveAndReopen(app, PID, 1);
  ok(rmOneErr === '', 'remove-one saved without a media error' + (rmOneErr ? ' [' + rmOneErr + ']' : ''));
  links = activeLinks(PID);
  ok(links.length === 1, 'remove-one-of-two → exactly ONE active link remains');
  ok(links[0]?.media_id === keptId, 'exactly the OTHER media id survived (identity preserved)');
  ok(links[0]?.sort_order === 0 && links[0]?.is_primary === 1, 'the survivor was compacted to slot 0 and promoted to primary');
  ok(deletedLinks(PID).some((r) => r.media_id === droppedId), 'the removed link is SOFT-deleted (deleted_at set), not erased');
  ok(sameStats(blobStats(), twoStats), 'remove-one deleted NO blob/generation/file');
  ok((await renderedBlobImgs(app)) === 1, 'the detail now renders exactly one image');

  // A) single remove: the last remaining image
  ok(await enterEditor(app, 1, 20000), 'editor seeded the draft with the last image');
  ok((await removePhoto(app, 0)) === 'OK', 'clicked the real remove (X) on the only image');
  ok((await draftPhotos(app)) === 0, 'the draft is now empty');
  const rmLastErr = await saveAndReopen(app, PID, 0);
  ok(rmLastErr === '', 'single remove saved without a media error' + (rmLastErr ? ' [' + rmLastErr + ']' : ''));
  ok(activeLinks(PID).length === 0, 'single remove → gallery has NO active link');
  ok(deletedLinks(PID).length === 2, 'both removed links are soft-deleted (full audit history kept)');
  ok(sameStats(blobStats(), twoStats), 'single remove deleted NO blob/generation/file');
  ok((await renderedBlobImgs(app)) === 0, 'the detail renders no image after the remove');

  // C) two more images, then remove ALL in one edit
  ok(await enterEditor(app, 0, 20000), 'editor opened on an empty gallery');
  ok(await addPhoto(app, jpg3), 'added photo 1 of 2 after the empty state');
  ok(await addPhoto(app, jpg4), 'added photo 2 of 2 after the empty state');
  const add2Err = await saveAndReopen(app, PID, 2);
  ok(add2Err === '', 'two-image add saved without a media error' + (add2Err ? ' [' + add2Err + ']' : ''));
  ok(activeLinks(PID).length === 2, 'two fresh images are active again');
  const fourStats = blobStats();
  ok(await enterEditor(app, 2, 20000), 'editor seeded both fresh images');
  ok((await removePhoto(app, 0)) === 'OK' && (await removePhoto(app, 0)) === 'OK', 'removed BOTH images through the UI');
  ok((await draftPhotos(app)) === 0, 'the draft is empty after removing all');
  const rmAllErr = await saveAndReopen(app, PID, 0);
  ok(rmAllErr === '', 'remove-all saved without a media error' + (rmAllErr ? ' [' + rmAllErr + ']' : ''));
  ok(activeLinks(PID).length === 0, 'remove-all → gallery empty');
  ok((await renderedBlobImgs(app)) === 0, 'nothing rendered after remove-all');
  ok(sameStats(blobStats(), fourStats), 'remove-all deleted NO blob/generation/file');

  // D) add after empty
  ok(await enterEditor(app, 0, 20000), 'editor opened on the emptied gallery');
  ok(await addPhoto(app, jpg2), 'added a photo after the gallery was emptied');
  const addBackErr = await saveAndReopen(app, PID, 1);
  ok(addBackErr === '', 'add-after-empty saved without a media error' + (addBackErr ? ' [' + addBackErr + ']' : ''));
  const finalLinks = activeLinks(PID);
  ok(finalLinks.length === 1, 'add-after-empty → exactly ONE active link');
  ok(finalLinks[0]?.sort_order === 0 && finalLinks[0]?.is_primary === 1, 'add-after-empty → primary invariant correct (one primary at slot 0)');
  ok((await renderedBlobImgs(app)) === 1, 'the newly added image is rendered in the desktop detail');
  ok(productCount() === 1, 'the whole remove/add cycle never created a second product');

  // ══ §4/§5 — the GALLERY SEED RACE: editing in the REAL pre-seed window ══
  // The state under test is the natural one: ProductDetail is freshly mounted, the resolver is still
  // fetching the verified bytes over IPC, and the user opens the editor before the gallery concluded.
  // NOTHING in the durable media storage is touched (no blob moved/hidden, no journal poked) — an
  // earlier version of this test did that and raced the app's own background media recovery. The only
  // test-side lever is CDP CPU throttling, which slows the PAGE (never data) so the pre-seed window is
  // wide enough to observe; the assertions below are pure product behaviour.
  const setHold = (on) => app.ev(`window.__e2eHoldGallerySeed = ${on ? 'true' : 'false'}; return window.__e2eHoldGallerySeed === ${on ? 'true' : 'false'};`);
  const releaseHold = () => app.ev(`window.__e2eHoldGallerySeed = false; if (typeof window.__e2eResumeGallerySeed === 'function') window.__e2eResumeGallerySeed(); return window.__e2eHoldGallerySeed === false;`);

  const raceStats = blobStats();
  const raceLinksBefore = activeLinks(PID);
  const raceMediaId = raceLinksBefore[0]?.media_id;
  const raceRetiredBefore = deletedLinks(PID).length; // whatever the earlier remove cases left behind
  ok(raceLinksBefore.length === 1, 'race setup: the product has exactly one active media link');

  // A) the seed is HELD, so the pre-seed state is observable for as long as the test needs it
  ok((await app.ev(`return window.__LATAIF_E2E__ === true;`)) === true, 'race setup: this is the e2e build (the seed hold exists ONLY here)');
  ok((await app.ev(`return window.__e2eHoldGallerySeed === undefined || window.__e2eHoldGallerySeed === false;`)) === true, 'race setup: the hold defaults to OFF (nothing is held until the test asks)');
  ok(await setHold(true), 'race setup: seed hold engaged');
  await leaveDetail(app);
  await openDetail(app, PID);
  ok((await renderedBlobImgs(app)) === 1, 'race A: the gallery data IS available in the background (read view renders it) — only the editor seed is held');
  ok((await clickEdit(app)) === 'OK', 'race A: the editor was opened while the seed is held');
  await sleep(1500);
  ok((await photoControlsLocked(app)) === true, 'race A: the "Images loading…" locked state is shown even though the gallery resolved');
  ok((await draftPhotos(app)) === 0, 'race A: draftSeeded is still false — nothing was seeded into the draft');
  ok((await app.ev(`const inp=document.querySelector('input[type=file][accept="image/*"]'); if(!inp) return -1; const grid=inp.parentElement.firstElementChild; return [...grid.querySelectorAll('button')].length;`)) === 0, 'race B: no remove (X) control exists while locked → removing is impossible');
  ok((await app.ev(`const t=document.body.innerText; return t.includes('Add Photo');`)) === false, 'race A: no "Add Photo" control exists while locked → adding is impossible');
  ok((await app.ev(`const i=document.querySelector('input[type=file][accept="image/*"]'); return !!i && i.disabled === false;`)) === true, 'race A: only the hidden input remains (the visible controls are gone), so a pick can only come from automation');
  // Under the hold the state cannot flip mid-check, so a programmatic pick is a CONCLUSIVE probe: the
  // disabled ImageUpload must drop it, leaving the draft (and therefore imagesDirty) untouched.
  await setFileApp(app, PHOTO_INPUT, jpg3);
  await sleep(2000);
  ok((await draftPhotos(app)) === 0, 'race A: a file forced onto the input while locked is NOT taken up (imagesDirty cannot be set before the seed)');
  ok(activeLinks(PID).length === 1 && activeLinks(PID)[0].media_id === raceMediaId, 'race A/B: the durable gallery is untouched by everything done in the locked state');
  ok(sameStats(blobStats(), raceStats), 'race A/B: no blob/object/generation/file was created or deleted in the locked state');

  // E) text/price stay editable while held, and the save must take the gallery-safe text-only path
  const priceDuringLoad = await app.ev(`const lab=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith('MIN SALE PRICE (BHD)')); if(!lab) return 'NOLABEL'; const inp=lab.parentElement.querySelector('input'); const p=HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(inp, '3.5'); inp.dispatchEvent(new Event('input',{bubbles:true})); inp.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
  ok(priceDuringLoad === 'OK', 'race E: text/price fields stay editable while images are locked');
  await clickSave(app);
  { const end = Date.now() + 30000; while (Date.now() < end) { if (await app.ev(`return ![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Save');`)) break; await sleep(400); } }
  await sleep(800);
  ok(activeLinks(PID).length === 1 && activeLinks(PID)[0].media_id === raceMediaId, 'race E: the price save from the locked state left the gallery untouched (same media id)');
  ok(activeLinks(PID)[0].is_primary === 1 && activeLinks(PID)[0].sort_order === 0, 'race E: primary/slot unchanged');
  ok(deletedLinks(PID).length === raceRetiredBefore, 'race E: the save retired NO additional link (deleted_at untouched)');
  ok(sameStats(blobStats(), raceStats), 'race E: no blob/object/generation/file created or deleted by that save');
  ok(productRow(PID)?.min_sale_price === 3.5, 'race E: the price edited while images were locked was persisted');

  // C) release the hold → the NORMAL seed path runs → add, save → old AND new image present
  ok(await releaseHold(), 'race C: seed hold released');
  await leaveDetail(app); await openDetail(app, PID);
  ok((await renderedBlobImgs(app)) === 1, 'race C: the existing image renders once the gallery resolved');
  ok(await enterEditor(app, 1, 20000), 'race C: the editor now seeds the draft from the FINAL gallery');
  ok((await photoControlsLocked(app)) === false, 'race C: the loading notice is gone once seeded (photo editing unlocked)');
  ok(await addPhoto(app, jpg3), 'race C: adding a photo works once the gallery is authoritative');
  const raceAddErr = await saveAndReopen(app, PID, 2);
  ok(raceAddErr === '', 'race C: the add saved cleanly' + (raceAddErr ? ' [' + raceAddErr + ']' : ''));
  const raceLinks = activeLinks(PID);
  ok(raceLinks.length === 2, 'race C: OLD + NEW image are both active (the existing one was never retired)');
  ok(raceLinks.some((l) => l.media_id === raceMediaId), 'race C: the pre-existing media id survived the add');
  ok(raceLinks[0].sort_order === 0 && raceLinks[0].is_primary === 1 && raceLinks[1].is_primary === 0, 'race C: primary invariant holds after the add');

  // D) explicit remove of the OLD image on an authoritative gallery → exactly that one goes
  ok(await enterEditor(app, 2, 20000), 'race D: editor seeded with both images');
  const oldIdx = raceLinks.findIndex((l) => l.media_id === raceMediaId);
  ok((await removePhoto(app, oldIdx)) === 'OK', 'race D: removed exactly the pre-existing image via the UI');
  const raceRmErr = await saveAndReopen(app, PID, 1);
  ok(raceRmErr === '', 'race D: the remove saved cleanly' + (raceRmErr ? ' [' + raceRmErr + ']' : ''));
  const afterRm = activeLinks(PID);
  ok(afterRm.length === 1 && afterRm[0].media_id !== raceMediaId, 'race D: ONLY the selected image was removed, the other one stayed');
  ok(deletedLinks(PID).some((r) => r.media_id === raceMediaId), 'race D: the removed link is soft-deleted');
  ok(afterRm[0].sort_order === 0 && afterRm[0].is_primary === 1, 'race D: the survivor is primary at slot 0');
  ok(blobStats().liveBlobs === blobStats().blobs && blobStats().liveGens === blobStats().gens, 'race D: no blob/generation was deleted by the remove');
  ok((await renderedBlobImgs(app)) === 1, 'race D: the detail renders exactly the surviving image');

  // The automation hold must be OFF again before the run ends — a leaked hold would silently disable
  // the seed for every later assertion, so it is itself an assertion (and it never survives a restart:
  // it is a plain window global with no persistence).
  ok((await app.ev(`return window.__e2eHoldGallerySeed === false;`)) === true, 'cleanup: the e2e seed hold is released at the end of the run');

  // ══ restart: nothing re-drains, the gallery survives ══
  const finalLinks2 = activeLinks(PID);
  const finalMediaId = finalLinks2[0]?.media_id;
  app.close(); killApp(); await sleep(1500);
  const app2 = new CDP(await startApp()); await waitInvoke(app2);
  await sleep(2500);
  ok((await app2.ev(`return window.__e2eHoldGallerySeed === undefined;`)) === true, 'after restart: the hold is gone (no persistence — a fresh page starts unheld)');
  ok(inboxCount() === inboxBefore + 1 && readyCount() === inboxBefore + 1, 'after restart: still exactly one inbox row, ready (no re-drain)');
  ok(productCount() === 1, 'after restart: still exactly one product');
  const restartLinks = activeLinks(PID);
  ok(restartLinks.length === 1 && restartLinks[0].media_id === finalMediaId, 'after restart: the same single active media link');
  const rowFinal = productRow(PID);
  ok(rowFinal?.purchase_price === 1.25 && rowFinal?.planned_sale_price === 9.75 && rowFinal?.min_sale_price === 3.5, 'after restart: prices are exactly as edited (incl. the one edited while the gallery was loading)');
  app2.close();

  // ══ isolation ══
  ok(verify().secret_leaks === '0', 'no owner secret in the audit sink');
  let leaked = 0; const scan = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { try { scan(p); } catch {} } else { try { if (readFileSync(p, 'latin1').includes(OWNER_PW)) leaked++; } catch {} } } };
  try { scan(RUN); scan(APP_DATA_DIR); } catch {}
  ok(leaked === 0, 'owner secret not persisted anywhere in the isolated tree');
  ok((existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0) === prodBefore, 'production sync DB (3001 install) untouched');
  ok((existsSync(PROD_BIZ_DB) ? statSync(PROD_BIZ_DB).mtimeMs : 0) === prodBizBefore, 'production business DB untouched');

  console.log(`\nMOBILE-MEDIA-PRICING-I1C ui/offline e2e: ${PASS} passed, ${FAIL} failed`);
}
main().catch((e) => { console.error('E2E ERROR:', e?.stack || e?.message || e); FAIL++; }).finally(() => {
  try { killEdge(); } catch {} try { killAllApp(); } catch {}
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
});
