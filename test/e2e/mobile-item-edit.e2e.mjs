// MOBILE-EDIT S1+S2 — Lesevertrag und Text-Edit eines BESTEHENDEN Artikels, durch die echte
// /mobile-Seite.
//
//   S1: der Artikel-Lesevertrag traegt die VOLLSTAENDIGE geordnete Galerie mit stabilen Identitaeten
//       (link_id, media_id, is_primary, sort_order, image_key, thumb_key) und einen deterministischen
//       `gallery_baseline`. Rein lesend — die Check-Item-Ansicht darf davon nicht regressieren.
//   S2: der Text-Edit aendert Produktfelder und laesst die Galerie NACHWEISLICH unberuehrt: dieselben
//       Link-IDs, dieselben Media-IDs, dieselbe Reihenfolge, dasselbe Titelbild, dieselben Dateien.
//
// Der Beweis ist der Vorher/Nachher-Vergleich der Identitaeten, nicht "vier Bilder sind sichtbar".
// Isoliert: e2e-Identitaet `com.lataif.app.e2e`, eigenes AppData, Sync-Port 3011; Produktion (3001)
// wird nie geoeffnet.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
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

const RUN = join(os.tmpdir(), 'lataif-itemedit-e2e', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
const STAGING = join(APP_DATA_DIR, 'mobile-upload-staging');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  \u2717 ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const S = (v) => JSON.stringify(v);

function dbQ(file, sql, params = []) { let db; try { db = new DatabaseSync(file); return db.prepare(sql).all(...params); } catch { return []; } finally { try { db?.close(); } catch {} } }
const productRow = (id) => dbQ(BIZ_DB, 'SELECT id, name, brand, condition, storage_location, notes, sku, purchase_price, planned_sale_price, min_sale_price, images FROM products WHERE id = ?', [id])[0] ?? null;
/** Die Galerie als IDENTITAETEN — genau das, was ein Text-Edit nicht anfassen darf. */
const linkRows = (id) => dbQ(BIZ_DB, 'SELECT link_id, media_id, sort_order, is_primary, deleted_at FROM media_links WHERE entity_id = ? ORDER BY link_id', [id]);
const activeLinks = (id) => linkRows(id).filter((l) => l.deleted_at === null);
const mediaCounts = () => ({
  objects: dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM media_objects')[0]?.c ?? -1,
  gens: dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM media_blob_generations')[0]?.c ?? -1,
  links: dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM media_links')[0]?.c ?? -1,
});
function mediaFiles() {
  const out = []; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const q = join(p, e.name); if (e.isDirectory()) walk(q); else out.push(q); } }; walk(MEDIA_ROOT); return out.sort();
}
const stagedFiles = () => { let n = 0; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else if (!e.name.endsWith('.tmp')) n++; } }; walk(STAGING); return n; };
const inboxRows = () => dbQ(SERVER_DB, 'SELECT upload_event_id, state FROM mobile_upload_inbox');
const changeRows = () => dbQ(SERVER_DB, "SELECT record_id, action FROM sync_changelog WHERE table_name = 'products'");

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
async function waitE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsE(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitVisE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await visE(c, sel)) return true; await sleep(200); } throw new Error('waitVisE ' + sel); }
const setValE = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if(e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
const textE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.textContent.trim() : '';`);
async function setFiles(c, sel, paths) { const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false }); await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: paths }); }
async function mobileLogin(c) { await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW); await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker'); }

async function startEdge(url) {
  edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, 'about:blank'], { stdio: 'ignore' });
  const end = Date.now() + 40000; let ws = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/list`)).json(); const pg = l.find((t) => t.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
  if (!ws) throw new Error('edge CDP did not come up');
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('Network.enable');
  const pushes = [], consoleErrors = [], httpErrors = [], uploadStatus = [];
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      // Der Text-Edit laeuft ueber denselben Upload-Weg wie ein neuer Artikel — hier wird jede
      // Schreibanfrage der Seite gezaehlt, damit "genau EINE Mutation" wirklich messbar ist.
      if (r && /\/api\/(mobile\/upload|sync\/push)$/.test(r.url) && r.postData) {
        try { pushes.push(JSON.parse(r.postData)); } catch { pushes.push({}); }
      }
    }
    else if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r && /\/api\/mobile\/upload$/.test(r.url)) uploadStatus.push(r.status);
      // Das Favicon interessiert hier nicht — die Seite liefert keins, der Browser fragt trotzdem.
      if (r && r.status >= 400 && !/favicon\.ico$/.test(r.url)) httpErrors.push(`${r.status} ${String(r.url).slice(0, 90)}`);
    }
    else if (m.method === 'Runtime.exceptionThrown') { consoleErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception')); }
  });
  await c.send('Page.navigate', { url }); await sleep(1500);
  return { c, pushes, consoleErrors, httpErrors, uploadStatus };
}

async function serverLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) });
  return (await r.json()).token;
}
const readProduct = async (token, sku) => {
  const r = await fetch(`${BASE}/api/products/by-sku/${encodeURIComponent(sku)}`, { headers: { Authorization: 'Bearer ' + token } });
  return r.ok ? r.json() : null;
};
async function waitReady(app, want, ms) {
  const half = Date.now() + Math.floor(ms / 2);
  const ready = () => dbQ(SERVER_DB, "SELECT COUNT(*) c FROM mobile_upload_inbox WHERE state='ready'")[0]?.c ?? 0;
  while (Date.now() < half) { if (ready() >= want) return true; await sleep(1000); }
  await app.ev('window.location.reload(); return 1;').catch(() => {});
  await sleep(3000);
  const end = Date.now() + Math.floor(ms / 2);
  while (Date.now() < end) { if (ready() >= want) return true; await sleep(1000); }
  return false;
}
/** Auf das Ankommen des Textedits im Business-Datenbestand warten. */
async function waitProductField(id, field, want, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = productRow(id); if (r && r[field] === want) return true; await sleep(1000); }
  return false;
}
const sameLinks = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');

  const paths = ['1', '3', '5', '7'].map((n, i) => { const p = join(RUN, `img${i}.jpg`); writeFileSync(p, Buffer.from(seed('jpeg', n), 'base64')); return p; });

  const ws = await startApp(); const app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');
  await frontendLogin(app);

  const { c: edge, pushes, consoleErrors, httpErrors, uploadStatus } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLogin(edge);

  // ── Fixture: EIN Artikel mit VIER Bildern, ueber den echten Create-Pfad ──
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');
  await setValE(edge, '#cCategory', 'cat-watch'); await sleep(500);
  await setValE(edge, '#cBrand', 'Rolex'); await setValE(edge, '#cName', 'Edit Fixture');
  await setValE(edge, '#cCondition', 'Pre-Owned');
  await setValE(edge, '#attr_dial', 'Black'); await setValE(edge, '#attr_material', 'Steel');
  await setFiles(edge, '#cPhotoInput', paths); await waitVisE(edge, '#cPhotoStrip', 10000);
  await clickE(edge, '#cSaveBtn');
  ok(await waitReady(app, 1, 120000), 'fixture: the four-photo upload drained');
  await sleep(2000);

  const pid = dbQ(BIZ_DB, "SELECT id, sku FROM products WHERE name = 'Edit Fixture'")[0];
  ok(!!pid, 'fixture: the product exists');
  if (!pid) throw new Error('fixture product missing');
  const before = { product: productRow(pid.id), links: linkRows(pid.id), files: mediaFiles(), counts: mediaCounts() };
  ok(before.links.filter((l) => l.deleted_at === null).length === 4, `fixture: four active links (${before.links.filter((l) => l.deleted_at === null).length})`);

  // ════════════════════════════════════════════════════════════════════════
  // S1 — der Lesevertrag
  // ════════════════════════════════════════════════════════════════════════
  const token = await serverLogin();
  const read1 = await readProduct(token, pid.sku);
  ok(!!read1, 'S1 the product is readable by SKU');
  ok(Array.isArray(read1.gallery) && read1.gallery.length === 4, `S1 the read contract carries all four gallery entries (${read1.gallery?.length})`);
  const fields = ['link_id', 'media_id', 'is_primary', 'sort_order', 'image_key'];
  ok(read1.gallery.every((g) => fields.every((f) => g[f] !== undefined && g[f] !== null)), 'S1 every entry carries link_id, media_id, is_primary, sort_order, image_key');
  ok(read1.gallery.filter((g) => g.is_primary).length === 1, `S1 exactly one entry is primary (${read1.gallery.filter((g) => g.is_primary).length})`);
  ok(read1.gallery[0].is_primary === true, 'S1 the primary comes first');
  const dbIds = activeLinks(pid.id).map((l) => l.media_id).sort();
  ok(JSON.stringify(read1.gallery.map((g) => g.media_id).sort()) === JSON.stringify(dbIds), 'S1 the gallery identities are exactly the ones in media_links');
  ok(/^[0-9a-f]{64}$/.test(String(read1.gallery_baseline)), `S1 gallery_baseline is a sha-256 (${String(read1.gallery_baseline).slice(0, 16)}…)`);
  const read2 = await readProduct(token, pid.sku);
  ok(read2.gallery_baseline === read1.gallery_baseline, 'S1 the baseline is deterministic across two reads');
  ok(read1.id && read1.category_id && read1.sku, 'S1 the editable identity fields are present (id, category, sku)');

  // Check Item darf nicht regressieren: dieselbe Detailansicht, jetzt mit allen Fotos.
  await clickE(edge, '.back'); await sleep(300);
  await clickE(edge, '.mode-btn[data-mode="scan"]'); await waitVisE(edge, '#scanScreen');
  await clickE(edge, '#tabSearch'); await waitVisE(edge, '#searchPane');
  await setValE(edge, '#searchInput', 'Edit Fixture'); await sleep(2500);
  await edge.ev(`const h=document.querySelector('#searchResults .card, #searchResults > div'); if(h) h.click(); return 1;`);
  await waitVisE(edge, '#scanResult', 15000);
  ok(await existsE(edge, '#pdPhoto'), 'S1 Check Item still shows the main photo (no regression)');
  const thumbs = await edge.ev(`return document.querySelectorAll('#pdGallery .photo-thumb').length;`);
  ok(thumbs === 4, `S1 …and now all four photos (${thumbs})`);

  // ════════════════════════════════════════════════════════════════════════
  // S2 — Text-Edit: Cancel schreibt nichts
  // ════════════════════════════════════════════════════════════════════════
  await waitE(edge, '#pdEditBtn', 10000);
  ok(await clickE(edge, '#pdEditBtn') === 'OK', 'S2 the Edit button opens the form');
  await waitVisE(edge, '#pdEditForm', 10000);
  ok(await edge.ev(`return document.querySelector('#peName').value;`) === 'Edit Fixture', 'S2 the form is prefilled with the current name');
  const pushesBeforeCancel = pushes.length;
  await setValE(edge, '#peName', 'CANCELLED NAME');
  await setValE(edge, '#peNotes', 'cancelled note');
  await clickE(edge, '#peCancel'); await sleep(1500);
  ok(pushes.length === pushesBeforeCancel, `S2 Cancel sends nothing (${pushes.length - pushesBeforeCancel} requests)`);
  ok(JSON.stringify(productRow(pid.id)) === JSON.stringify(before.product), 'S2 Cancel leaves the product row untouched');
  ok(sameLinks(linkRows(pid.id), before.links), 'S2 Cancel leaves every media link untouched');
  // Die vier Fixture-Bilder liegen weiterhin im Staging — sie werden erst vom Staging-GC abgeraeumt,
  // nicht vom Upload. Massgeblich ist deshalb, dass ein TEXT-EDIT dort nichts hinzufuegt.
  const stagedBeforeEdit = stagedFiles();

  // ════════════════════════════════════════════════════════════════════════
  // S2 — Text-Edit: nur der Name aendert sich, die Galerie NICHT
  // ════════════════════════════════════════════════════════════════════════
  await clickE(edge, '#pdEditBtn'); await waitVisE(edge, '#pdEditForm', 10000);
  await setValE(edge, '#peName', 'Edited Name');
  await clickE(edge, '#peSave');
  const applied = await waitProductField(pid.id, 'name', 'Edited Name', 90000);
  ok(applied, `S2 the text edit reached the business database (msg: ${await textE(edge, '#peMsg')}; upload statuses: ${uploadStatus.join(',')}; inbox: ${JSON.stringify(dbQ(SERVER_DB, 'SELECT upload_event_id, mode, state, error_code, product_id FROM mobile_upload_inbox'))})`);

  const after = { product: productRow(pid.id), links: linkRows(pid.id), files: mediaFiles(), counts: mediaCounts() };
  ok(after.product?.name === 'Edited Name', 'S2 the name is the edited one');
  ok(after.product?.sku === before.product.sku, 'PATCH-SAFETY the SKU is unchanged');
  ok(after.product?.brand === before.product.brand, 'PATCH-SAFETY an untouched field keeps its value (brand)');
  ok(after.product?.condition === before.product.condition, 'PATCH-SAFETY …and condition');
  ok(after.product?.purchase_price === before.product.purchase_price
    && after.product?.planned_sale_price === before.product.planned_sale_price
    && after.product?.min_sale_price === before.product.min_sale_price, 'PATCH-SAFETY prices are unchanged');
  ok(after.product?.images === before.product.images, 'PATCH-SAFETY products.images is untouched');

  // Der eigentliche Beweis: IDENTITAETEN, nicht Sichtbarkeit.
  ok(sameLinks(after.links, before.links), 'PRESERVE every media_links row is byte-identical (ids, order, primary, deleted_at)');
  ok(after.links.filter((l) => l.deleted_at === null).length === 4, `PRESERVE still exactly four active links (${after.links.filter((l) => l.deleted_at === null).length})`);
  ok(JSON.stringify(after.counts) === JSON.stringify(before.counts), `PRESERVE no media object/generation/link was created or retired (${JSON.stringify(after.counts)})`);
  ok(JSON.stringify(after.files) === JSON.stringify(before.files), `PRESERVE not one media file was deleted or added (${after.files.length} vs ${before.files.length})`);
  const readAfter = await readProduct(token, pid.sku);
  ok(readAfter.gallery_baseline === read1.gallery_baseline, 'PRESERVE the gallery baseline is unchanged — the gallery never moved');

  // Negativkontrolle: der Vergleich MUSS anschlagen, wenn ein Link verschwindet.
  const tampered = before.links.filter((_, i) => i !== 0);
  ok(!sameLinks(tampered, before.links), 'NEGATIVE CONTROL the preserve comparison fails when one link is missing');
  const reordered = before.links.map((l, i) => (i === 0 ? { ...l, sort_order: l.sort_order + 1 } : l));
  ok(!sameLinks(reordered, before.links), 'NEGATIVE CONTROL …and when only the order changes');
  const reprimaried = before.links.map((l, i) => (i === 0 ? { ...l, is_primary: l.is_primary ? 0 : 1 } : l));
  ok(!sameLinks(reprimaried, before.links), 'NEGATIVE CONTROL …and when only the primary flag moves');

  // ════════════════════════════════════════════════════════════════════════
  // S2 — Doppeltipp erzeugt genau eine Mutation
  // ════════════════════════════════════════════════════════════════════════
  const beforeDouble = { pushes: pushes.length, changes: changeRows().length, links: linkRows(pid.id) };
  await clickE(edge, '#pdEditBtn'); await waitVisE(edge, '#pdEditForm', 10000);
  await setValE(edge, '#peNotes', 'double tap note');
  await edge.ev(`const b=document.querySelector('#peSave'); b.click(); b.click(); return 'OK';`);
  await sleep(6000);
  ok(pushes.length === beforeDouble.pushes + 1, `S2 a double tap produces exactly ONE request (${pushes.length - beforeDouble.pushes})`);
  ok(await waitProductField(pid.id, 'notes', 'double tap note', 60000), 'S2 …and the note arrived');
  ok(sameLinks(linkRows(pid.id), beforeDouble.links), 'S2 …with the gallery still untouched');

  // ════════════════════════════════════════════════════════════════════════
  // S2 — Fehlgeschlagener Save aendert nichts
  // ════════════════════════════════════════════════════════════════════════
  const beforeFail = { product: productRow(pid.id), links: linkRows(pid.id), files: mediaFiles() };
  // Ein ungueltiges Token laesst den Push real scheitern (401) — kein kuenstlicher Abbruch.
  await edge.ev(`localStorage.setItem('lataif_mobile_token','broken-token'); return 1;`);
  await clickE(edge, '#pdEditBtn'); await waitVisE(edge, '#pdEditForm', 10000);
  await setValE(edge, '#peName', 'SHOULD NOT PERSIST');
  await clickE(edge, '#peSave');
  await sleep(6000);
  const failMsg = await textE(edge, '#peMsg');
  ok(/failed|expired/i.test(failMsg), `FAILURE the form reports the failure ("${failMsg.slice(0, 70)}")`);
  ok(productRow(pid.id)?.name === beforeFail.product.name, 'FAILURE the product keeps its previous name');
  ok(sameLinks(linkRows(pid.id), beforeFail.links), 'FAILURE the gallery is untouched');
  ok(JSON.stringify(mediaFiles()) === JSON.stringify(beforeFail.files), 'FAILURE not one media file changed');

  // ════════════════════════════════════════════════════════════════════════
  // Der Vertrag selbst — direkt gegen /api/mobile/upload, ohne die UI
  // ════════════════════════════════════════════════════════════════════════
  const postUpload = async (body) => {
    const r = await fetch(`${BASE}/api/mobile/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ protocol_version: 2, mode: 'collection', ...body }),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  const editBody = (over) => ({
    upload_event_id: 'ct-' + Math.random().toString(36).slice(2),
    entity_id: 'ct-entity-' + Math.random().toString(36).slice(2),
    metadata: { kind: 'text_edit', productId: pid.id, patch: { notes: 'contract' } },
    images: [],
    ...over,
  });

  // §3 — die Null-Bild-Ausnahme gilt NUR fuer einen Text-Edit. Ein Create ohne Bild bleibt ungueltig.
  const emptyCreate = await postUpload({
    upload_event_id: 'ct-empty-' + Date.now(), entity_id: 'ct-empty-entity-' + Date.now(),
    metadata: { categoryId: 'cat-watch', brand: 'Rolex', name: 'No Photo', condition: 'Pre-Owned', attributes: { dial: 'Black', material: 'Steel' } },
    images: [],
  });
  ok(emptyCreate.status === 422, `ZERO-IMAGE a create without a photo is still refused (${emptyCreate.status})`);

  // §2 — ein Create darf den Edit-Marker gar nicht erst tragen koennen.
  const markedCreate = await postUpload({
    upload_event_id: 'ct-mark-' + Date.now(), entity_id: 'ct-mark-entity-' + Date.now(),
    metadata: { kind: 'text_edit', categoryId: 'cat-watch', brand: 'Rolex', name: 'Marked', condition: 'Pre-Owned' },
    images: [],
  });
  ok(markedCreate.status === 422, `ROUTING a create payload carrying the edit marker is refused (${markedCreate.status})`);

  // §2 — kaputter Patch: fail closed, kein Job.
  const badPatch = await postUpload(editBody({ metadata: { kind: 'text_edit', productId: pid.id, patch: { sku: 'HACK-1' } } }));
  ok(badPatch.status === 422, `ROUTING a patch touching a field outside the allowlist is refused (${badPatch.status})`);
  const noTarget = await postUpload(editBody({ metadata: { kind: 'text_edit', patch: { notes: 'x' } } }));
  ok(noTarget.status === 422, `ROUTING an edit without a target product is refused (${noTarget.status})`);

  // §5 — POST angenommen, Anwendung scheitert: das Ziel gibt es nicht.
  const beforeGhost = { products: dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM products')[0].c, links: linkRows(pid.id), files: mediaFiles() };
  const ghost = await postUpload(editBody({ metadata: { kind: 'text_edit', productId: 'does-not-exist-' + Date.now(), patch: { notes: 'ghost' } } }));
  ok(ghost.status === 201, `POST-ACCEPT the job is accepted first (${ghost.status})`);
  const ghostEvent = ghost.json?.uploadEventId;
  const ghostState = async () => {
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      const r = dbQ(SERVER_DB, 'SELECT state, error_code FROM mobile_upload_inbox WHERE upload_event_id = ?', [ghostEvent])[0];
      if (r && r.state !== 'accepted' && r.state !== 'processing') return r;
      await sleep(1000);
    }
    return dbQ(SERVER_DB, 'SELECT state, error_code FROM mobile_upload_inbox WHERE upload_event_id = ?', [ghostEvent])[0];
  };
  const ghostRow = await ghostState();
  ok(ghostRow?.state === 'quarantined', `POST-ACCEPT the drain ends it in a clean terminal state (${JSON.stringify(ghostRow)})`);
  ok(ghostRow?.error_code === 'MOBILE_UPLOAD_TARGET_CONFLICT', 'POST-ACCEPT …with the reason recorded');
  ok(dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM products')[0].c === beforeGhost.products, 'POST-ACCEPT no product was created by a failed edit');
  ok(sameLinks(linkRows(pid.id), beforeGhost.links), 'POST-ACCEPT the gallery is untouched');
  ok(JSON.stringify(mediaFiles()) === JSON.stringify(beforeGhost.files), 'POST-ACCEPT not one media file changed');

  // §6 — derselbe Job noch einmal: der Replay ist ein no-op, keine zweite Wirkung.
  const beforeReplay = { links: linkRows(pid.id), products: dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM products')[0].c };
  const replayBody = editBody({ metadata: { kind: 'text_edit', productId: pid.id, patch: { notes: 'replayed once' } } });
  const first = await postUpload(replayBody);
  ok(first.status === 201, `REPLAY the edit is accepted (${first.status})`);
  ok(await waitProductField(pid.id, 'notes', 'replayed once', 90000), 'REPLAY …and applied');
  const again = await postUpload(replayBody);            // exakt derselbe uploadEventId + Inhalt
  ok(again.status === 200 && again.json?.state === 'replay', `REPLAY the repeat is answered as a replay, not a second job (${again.status} ${again.json?.state})`);
  await sleep(4000);
  ok(dbQ(SERVER_DB, 'SELECT COUNT(*) c FROM mobile_upload_inbox WHERE upload_event_id = ?', [replayBody.upload_event_id])[0].c === 1,
    'REPLAY exactly one inbox row for that event id');
  ok(productRow(pid.id)?.notes === 'replayed once', 'REPLAY the field carries the value exactly once');
  ok(dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM products')[0].c === beforeReplay.products, 'REPLAY no second product');
  ok(sameLinks(linkRows(pid.id), beforeReplay.links), 'REPLAY no media side effect');

  // ════════════════════════════════════════════════════════════════════════
  // Keine gestrandeten Jobs, kein Staging-Rest
  // ════════════════════════════════════════════════════════════════════════
  const inbox = inboxRows();
  // Jede Zeile steht auf einem TERMINALEN Zustand — nichts haengt in `accepted`/`processing` fest.
  // `quarantined` ist dabei ein gewolltes Ergebnis: der absichtlich ins Leere zielende Edit.
  ok(inbox.every((r) => r.state === 'ready' || r.state === 'quarantined'), `no stranded upload job (${JSON.stringify(inbox)})`);
  ok(inbox.filter((r) => r.state === 'quarantined').length === 1, `exactly the one deliberately failed edit is quarantined (${inbox.filter((r) => r.state === 'quarantined').length})`);
  ok(stagedFiles() === stagedBeforeEdit, `a text edit stages nothing (${stagedFiles()} vs ${stagedBeforeEdit})`);
  ok(consoleErrors.length === 0, `no uncaught page exception (${consoleErrors.slice(0, 2).join(' | ')})`);
  const unexpected = httpErrors.filter((h) => !/401/.test(h));
  ok(unexpected.length === 0, `no unexpected HTTP error (${unexpected.slice(0, 3).join(' | ')})`);

  edge.closeWs(); killEdge(); app.closeWs(); killApp();
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killEdge(); killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    console.log(`\nMOBILE item-edit S1+S2: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
