// MOBILE-GALLERY — Check Item → Edit → Photos: „Take photo" UND „Choose from gallery", durch die ECHTE /mobile-Seite.
//
// Beide Wege füllen dieselbe Edit-Liste über denselben Handler; gespeichert wird über den bestehenden
// gallery_edit-Auftrag (Baseline, Queue, Replay). Geprüft wird auf einem kleinen Telefon (360 px breit):
//   ein Galeriebild · mehrere auf einmal · bestehende + neue Bilder · Kamera + Galerie gemischt ·
//   Auswahl abbrechen · Bild entfernen · Höchstzahl 8 · Cancel · Save mit verlorener Antwort + erneutem
//   Save (derselbe Auftrag, keine doppelten Medien) · ein echter Baseline-Konflikt bleibt Konflikt.
//
// Isolierter E2E-Bezeichner + AppData + Sync-Port (LATAIF_E2E_SYNC_PORT=3011); Produktion (3001) wird
// nie berührt. Beendet wird nur, was dieser Lauf selbst gestartet hat.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killOwnChild, killTestImage, killTestPid } from './_e2e-process.mjs';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
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

const RUN = join(os.tmpdir(), 'lataif-checkitem-gallery-e2e', 'run-' + Date.now());
const OUT = join(os.tmpdir(), 'lataif-evidence', 'mobile-check-item-gallery');
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const S = (v) => JSON.stringify(v);
const sha = (b64) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function dbQ(file, sql, params = []) { let db; try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); } catch { return []; } finally { try { db?.close(); } catch {} } }
const linkRows = (id) => dbQ(BIZ_DB, 'SELECT link_id, media_id, sort_order, is_primary, deleted_at FROM media_links WHERE entity_id = ? ORDER BY link_id', [id]);
const activeLinks = (id) => linkRows(id).filter((l) => l.deleted_at === null).sort((a, b) => a.sort_order - b.sort_order);
const inboxRows = () => dbQ(SERVER_DB, 'SELECT upload_event_id, state, error_code FROM mobile_upload_inbox');
const readyCount = () => inboxRows().filter((r) => r.state === 'ready').length;

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
function killApp() { try { killTestPid(appProc.pid); } catch {} }
function killAllApp() { try { killTestImage('lataif.exe'); } catch {} }
function killEdge() { try { killOwnChild(edgeProc); } catch {} }
async function waitPortFree(port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; } if (!n) return true; await sleep(500); } return false; }
async function waitHealthy() { const end = Date.now() + 40000; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); } throw new Error('server never healthy'); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
async function invoke(c, cmd, args) { return c.ev(`try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; }`); }

// ── die DESKTOP-Seite (Tauri-Fenster): angemeldet, damit der Drain läuft ────
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

// ── die MOBILE-Seite (Edge, 360 px) ─────────────────────────────────────────
const existsE = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const visE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return !!e && !e.classList.contains('hidden') && e.offsetParent!==null;`);
async function waitE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsE(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitVisE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await visE(c, sel)) return true; await sleep(200); } throw new Error('waitVisE ' + sel); }
const setValE = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if(e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
const textE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.textContent.trim() : '';`);
async function setFiles(c, sel, paths) { const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false }); await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: paths }); }
async function mobileLogin(c) { await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW); await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker'); }
async function mobileLoginVerified(c) {
  const probe = async () => { const t = await c.ev(`return localStorage.getItem('lataif_mobile_token');`); if (!t) return 0; const r = await fetch(`${BASE}/api/products/by-sku/__auth_probe__`, { headers: { Authorization: 'Bearer ' + t } }); return r.status; };
  await mobileLogin(c);
  let st = await probe();
  if (st === 401) { await c.ev(`localStorage.removeItem('lataif_mobile_token'); location.reload(); return 1;`); await sleep(2500); await mobileLogin(c); st = await probe(); }
  ok(st !== 0 && st !== 401, `the mobile session is really authenticated (${st})`);
}
async function startEdge(url) {
  edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, 'about:blank'], { stdio: 'ignore' });
  const end = Date.now() + 40000; let ws = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/list`)).json(); const pg = l.find((t) => t.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
  if (!ws) throw new Error('edge CDP did not come up');
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('Network.enable');
  // Ein kleines Telefon: 360 × 780 CSS-Pixel, Touch, Telefon-Darstellung.
  await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const uploads = [], responses = [], consoleErrors = [];
  const verloren = { an: false, getroffen: 0 };
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (r && /\/api\/mobile\/upload$/.test(r.url) && r.method === 'POST' && r.postData) { try { uploads.push(JSON.parse(r.postData)); } catch {} }
    } else if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r && /\/api\/mobile\/upload$/.test(r.url)) responses.push(r.status); }
    else if (m.method === 'Fetch.requestPaused') {
      // Die Antwort des Servers ist da (er HAT den Auftrag angenommen) — das Telefon bekommt sie nie.
      if (verloren.an) { verloren.an = false; verloren.getroffen++; c.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionClosed' }).catch(() => {}); }
      else c.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    }
    else if (m.method === 'Runtime.exceptionThrown') { consoleErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception')); }
  });
  await c.send('Page.navigate', { url }); await sleep(1500);
  return { c, uploads, responses, consoleErrors, verloren };
}
async function serverLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) });
  return (await r.json()).token;
}
const readProduct = async (token, sku) => { const r = await fetch(`${BASE}/api/products/by-sku/${encodeURIComponent(sku)}`, { headers: { Authorization: 'Bearer ' + token } }); return r.ok ? r.json() : null; };
async function waitReady(app, want, ms) {
  const half = Date.now() + Math.floor(ms / 2);
  while (Date.now() < half) { if (readyCount() >= want) return true; await sleep(1000); }
  await app.ev('window.location.reload(); return 1;').catch(() => {});
  await sleep(3000);
  const end = Date.now() + Math.floor(ms / 2);
  while (Date.now() < end) { if (readyCount() >= want) return true; await sleep(1000); }
  return false;
}
async function waitTerminal(eventId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = inboxRows().find((x) => x.upload_event_id === eventId); if (r && (r.state === 'ready' || r.state === 'quarantined')) return r; await sleep(1000); }
  return inboxRows().find((x) => x.upload_event_id === eventId) ?? null;
}

// ── der Editor des Artikels ─────────────────────────────────────────────────
async function openFixture(edge, name) {
  await edge.ev(`const b=document.querySelector('.back'); if(b) b.click(); return 1;`);
  await sleep(400);
  if (!(await visE(edge, '#scanScreen'))) { await clickE(edge, '.mode-btn[data-mode="scan"]'); await waitVisE(edge, '#scanScreen', 15000); }
  await clickE(edge, '#tabSearch'); await waitVisE(edge, '#searchPane', 10000);
  await setValE(edge, '#searchInput', name); await sleep(2500);
  await edge.ev(`const h=document.querySelector('#searchResults .card, #searchResults > div'); if(h) h.click(); return 1;`);
  await waitVisE(edge, '#scanResult', 15000);
  await waitE(edge, '#pdEditBtn', 10000);
  await clickE(edge, '#pdEditBtn');
  await waitVisE(edge, '#pdEditForm', 10000);
  await waitE(edge, '#peStrip', 10000);
}
const stripCount = (e) => e.ev(`return document.querySelectorAll('#peStrip .photo-thumb').length;`);
async function waitStrip(c, n, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await stripCount(c) === n) return true; await sleep(150); } return false; }
/** Jede Kachel: bestehend (Link-Id) oder neu (Vorschau-Fingerabdruck) — die Identität, nicht die Position. */
const tiles = (e) => e.ev(`return [...document.querySelectorAll('#peStrip .photo-thumb')].map(function(t){ const l=t.getAttribute('data-link')||''; const s=(t.querySelector('img')||{}).src||''; return l ? 'L:'+l : 'N:'+(s.split(',')[1]||'').slice(-24); });`);
const tapRemove = (e, i) => e.ev(`const t=document.querySelectorAll('#peStrip .photo-thumb')[${i}]; if(!t) return 'NO'; const b=[...t.querySelectorAll('button.rm')].find(x=>x.textContent==='✕'||x.textContent==='↺'); if(!b) return 'NOBTN'; b.click(); return 'OK';`);
const msgOf = (e) => textE(e, '#peMsg');
async function waehle(e, sel, paths, soll) { await setFiles(e, sel, paths); return waitStrip(e, soll, 15000); }

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');

  const b64 = ['1', '3', '5', '7', '11', '13', '17', '19', '23', '29'].map((n) => seed('jpeg', n));
  const paths = b64.map((b, i) => { const p = join(RUN, `img${i}.jpg`); writeFileSync(p, Buffer.from(b, 'base64')); return p; });
  ok(new Set(b64.map(sha)).size === b64.length, 'fixture: ten distinguishable JPEGs');

  const ws = await startApp(); const app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');
  await frontendLogin(app);

  const { c: edge, uploads, responses, consoleErrors, verloren } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLoginVerified(edge);

  // ── Fixture: EIN Artikel mit ZWEI Bildern, über den echten Create-Pfad ──
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');
  await setValE(edge, '#cCategory', 'cat-watch'); await sleep(500);
  await setValE(edge, '#cBrand', 'Rolex'); await setValE(edge, '#cName', 'Check Gallery');
  await setValE(edge, '#cCondition', 'Pre-Owned');
  await setValE(edge, '#attr_dial', 'Black'); await setValE(edge, '#attr_material', 'Steel');
  await setFiles(edge, '#cPhotoInput', [paths[0], paths[1]]);
  { const end = Date.now() + 20000; while (Date.now() < end && (await edge.ev(`return document.querySelectorAll('#cPhotoStrip .photo-thumb').length;`)) < 2) await sleep(200); }
  ok(await clickE(edge, '#cSaveBtn') === 'OK', 'fixture: the save button clicks');
  ok(await waitReady(app, 1, 120000), 'fixture: the two-photo upload drained');
  await sleep(2000);
  const pid = dbQ(BIZ_DB, "SELECT id, sku FROM products WHERE name = 'Check Gallery'")[0];
  if (!pid) throw new Error('fixture product missing');
  const base2 = activeLinks(pid.id);
  ok(base2.length === 2, `fixture: two active links (${base2.length})`);
  let ready = 1;

  // ── 0 Aufbau im Editor: zwei Wege, kompakt auf 360 px ────────────────────
  await openFixture(edge, 'Check Gallery');
  ok(await waitStrip(edge, 2), `§0 the editor shows the two existing photos (${await stripCount(edge)})`);
  const aufbau = JSON.parse(await edge.ev(`const r=(s)=>{const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return {t:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height),txt:e.textContent.trim()};};
    const cam=document.querySelector('#peAddInput'), gal=document.querySelector('#peGalleryInput');
    return JSON.stringify({ take:r('#peTakePhoto'), gallery:r('#peChooseGallery'), scroll:document.documentElement.scrollWidth, vw:innerWidth,
      camCapture:cam&&cam.getAttribute('capture'), galCapture:gal&&gal.hasAttribute('capture'), galMultiple:!!(gal&&gal.multiple), galAccept:gal&&gal.accept,
      takeFor:document.querySelector('#peTakePhoto')?.getAttribute('for'), galFor:document.querySelector('#peChooseGallery')?.getAttribute('for'), hint:document.querySelector('#peAddHint')?.textContent });`));
  ok(aufbau.take?.txt.includes('Take photo') && aufbau.gallery?.txt.includes('Choose from gallery'), `§0 two choices: „Take photo" and „Choose from gallery" (${aufbau.take?.txt} | ${aufbau.gallery?.txt})`);
  ok(aufbau.takeFor === 'peAddInput' && aufbau.galFor === 'peGalleryInput', '§0 …each opens its own picker');
  ok(aufbau.camCapture === 'environment' && aufbau.galCapture === false && aufbau.galMultiple === true && aufbau.galAccept === 'image/*',
    `§0 camera keeps capture=environment; gallery has NO capture, takes several images (${S({ c: aufbau.camCapture, g: aufbau.galCapture, m: aufbau.galMultiple })})`);
  ok(aufbau.take && aufbau.gallery && aufbau.take.t === aufbau.gallery.t && aufbau.take.w >= 120 && aufbau.gallery.w >= 120 && aufbau.take.h <= 100,
    `§0 compact on 360 px: side by side, each ≥ 120 px wide, ≤ 100 px high (${S([aufbau.take, aufbau.gallery])})`);
  ok(aufbau.scroll <= aufbau.vw, `§0 no horizontal scrolling at ${aufbau.vw} px (${aufbau.scroll})`);
  ok(/2 of 8/.test(aufbau.hint || ''), `§0 the counter shows 2 of 8 (${aufbau.hint})`);
  {
    await edge.ev(`document.querySelector('#peStrip').scrollIntoView({ block: 'start' }); return 1;`); await sleep(400);
    const shot = await edge.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'check-item-edit-photos-360px.png'), Buffer.from(shot.data, 'base64'));
  }

  // ── 1 ein Galeriebild, die bestehenden bleiben ───────────────────────────
  const L = base2.map((l) => 'L:' + l.link_id);
  ok(await waehle(edge, '#peGalleryInput', [paths[2]], 3), `§1 one gallery photo is added (${await stripCount(edge)})`);
  let t = await tiles(edge);
  ok(same(t.slice(0, 2), L) && t[2].startsWith('N:'), `§1 …behind the two existing photos, which stay in place (${S(t)})`);
  // ── 2 mehrere auf einmal, hinzugefügt (nicht ersetzt) ────────────────────
  ok(await waehle(edge, '#peGalleryInput', [paths[3], paths[4]], 5), `§2 several gallery photos at once are ADDED (${await stripCount(edge)})`);
  // ── 3 Kamera + Galerie gemischt ──────────────────────────────────────────
  ok(await waehle(edge, '#peAddInput', [paths[5]], 6), `§3 a camera photo joins the same list (${await stripCount(edge)})`);
  t = await tiles(edge);
  ok(same(t.slice(0, 2), L) && new Set(t.slice(2)).size === 4 && t.slice(2).every((x) => x.startsWith('N:')),
    `§3 existing + four distinct new photos, camera and gallery mixed (${S(t)})`);
  // ── 4 Auswahl abbrechen ändert nichts ────────────────────────────────────
  {
    const vor = await tiles(edge);
    await setFiles(edge, '#peGalleryInput', []);
    await edge.ev(`const g=document.querySelector('#peGalleryInput'); g.dispatchEvent(new Event('cancel',{bubbles:true})); g.dispatchEvent(new Event('change',{bubbles:true})); return 1;`);
    await sleep(600);
    ok(same(await tiles(edge), vor) && (await msgOf(edge)) === '', '§4 cancelling the gallery changes nothing (same photos, same order, no message)');
  }
  // ── 5 ein neues Bild wieder entfernen ────────────────────────────────────
  {
    const vor = await tiles(edge);
    ok(await tapRemove(edge, 3) === 'OK' && await stripCount(edge) === 5, '§5 a new photo can be removed again');
    ok(same(await tiles(edge), [vor[0], vor[1], vor[2], vor[4], vor[5]]), '§5 …exactly that one, the others keep their order');
  }
  // ── 6 Höchstzahl 8 ───────────────────────────────────────────────────────
  {
    await setFiles(edge, '#peGalleryInput', [paths[6], paths[7], paths[8], paths[9]]);
    const end = Date.now() + 20000; while (Date.now() < end && !/At most/.test(await msgOf(edge))) await sleep(200);
    ok(await stripCount(edge) === 8, `§6 the limit holds: 5 + 4 chosen → 8 kept (${await stripCount(edge)})`);
    ok(/At most 8 photos per item — 1 not added/.test(await msgOf(edge)), `§6 …and the operator is told (${await msgOf(edge)})`);
    const voll = JSON.parse(await edge.ev(`return JSON.stringify({ t: document.querySelector('#peTakePhoto').classList.contains('is-full'), g: document.querySelector('#peChooseGallery').classList.contains('is-full'), ci: document.querySelector('#peAddInput').disabled, gi: document.querySelector('#peGalleryInput').disabled, txt: document.querySelector('#peAddHint').textContent });`));
    ok(voll.t && voll.g && voll.ci && voll.gi && /8 of 8/.test(voll.txt), `§6 at 8 both choices are disabled (${S(voll)})`);
    await edge.ev(`document.querySelector('#peStrip').scrollIntoView({ block: 'start' }); return 1;`); await sleep(400);
    const shot = await edge.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'check-item-edit-photos-360px-full.png'), Buffer.from(shot.data, 'base64'));
    await tapRemove(edge, 7);
    const wieder = await edge.ev("return !document.querySelector('#peChooseGallery').classList.contains('is-full') && !document.querySelector('#peGalleryInput').disabled;");
    ok(wieder && await stripCount(edge) === 7, '§6 removing one re-enables adding');
  }
  // ── 7 Cancel verwirft alles ──────────────────────────────────────────────
  {
    const upVor = uploads.length, linksVor = linkRows(pid.id), inboxVor = inboxRows().length;
    await clickE(edge, '#peCancel'); await sleep(1200);
    ok(uploads.length === upVor && inboxRows().length === inboxVor && same(linkRows(pid.id), linksVor), '§7 Cancel sends nothing and changes no media row');
    await clickE(edge, '#pdEditBtn'); await waitVisE(edge, '#pdEditForm', 10000);
    ok(await waitStrip(edge, 2) && same(await tiles(edge), L), `§7 reopening shows only the two existing photos again (${S(await tiles(edge))})`);
    await clickE(edge, '#peCancel'); await sleep(400);
  }

  // ── 8 Save: bestehende + neue Galeriebilder, Antwort geht verloren, erneutes Save ──
  {
    await openFixture(edge, 'Check Gallery');
    ok(await waehle(edge, '#peGalleryInput', [paths[2], paths[3]], 4), '§8 two gallery photos added to the two existing ones');
    const neuVorschau = (await edge.ev(`return [...document.querySelectorAll('#peStrip .photo-thumb img')].slice(2).map(i=>i.src.split(',')[1]||'');`)).map(sha);
    await edge.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/mobile/upload', requestStage: 'Response' }] });
    verloren.an = true;
    const vorUp = uploads.length;
    await clickE(edge, '#peSave');
    let end = Date.now() + 30000; while (Date.now() < end && verloren.getroffen === 0) await sleep(200);
    end = Date.now() + 15000; while (Date.now() < end && !/Not confirmed/.test(await msgOf(edge))) await sleep(200);
    ok(verloren.getroffen === 1 && uploads.length === vorUp + 1, `§8 the first save reached the server, its answer was lost (${verloren.getroffen}/${uploads.length - vorUp})`);
    const u = uploads[uploads.length - 1];
    ok(u?.metadata?.kind === 'gallery_edit' && S(u.metadata.order) === S([{ keep: base2[0].link_id }, { keep: base2[1].link_id }, { new: 0 }, { new: 1 }])
      && (u.images || []).length === 2 && S(u.images.map((i) => sha(i.data_base64))) === S(neuVorschau),
      `§8 …one gallery_edit: the two existing kept in place, the two gallery photos appended (${S(u?.metadata?.order)})`);
    ok(/Not confirmed yet/.test(await msgOf(edge)) && !/nothing was changed/i.test(await msgOf(edge)), `§8 the phone says „not confirmed", not „failed — nothing changed" (${await msgOf(edge)})`);
    ok(inboxRows().filter((r) => r.upload_event_id === u.upload_event_id).length === 1, '§8 the server holds exactly one inbox row for it');
    await edge.send('Fetch.disable');
    const vorRetry = uploads.length;
    await clickE(edge, '#peSave');
    end = Date.now() + 30000; while (Date.now() < end && uploads.length === vorRetry) await sleep(200);
    await sleep(1500);
    const r = uploads[uploads.length - 1];
    ok(uploads.length === vorRetry + 1 && r.upload_event_id === u.upload_event_id && r.entity_id === u.entity_id,
      `§8 Save again resends the SAME job (same upload id and entity: ${r?.upload_event_id === u.upload_event_id})`);
    ok([200, 201, 202].includes(responses[responses.length - 1]), `§8 …which the server answers as accepted/replay (${responses[responses.length - 1]})`);
    ok(await waitReady(app, ++ready, 120000), `§8 the desktop applied it (${S(inboxRows())})`);
    await sleep(1500);
    const after = activeLinks(pid.id);
    ok(after.length === 4 && new Set(after.map((l) => l.media_id)).size === 4, `§8 four photos, four distinct media — no duplicates (${after.length})`);
    ok(same(after.slice(0, 2).map((l) => [l.link_id, l.media_id]), base2.map((l) => [l.link_id, l.media_id])) && after[0].is_primary === 1,
      '§8 the two existing photos keep their links, order and cover');
    ok(inboxRows().filter((x) => x.upload_event_id === u.upload_event_id).length === 1 && inboxRows().every((x) => x.state !== 'quarantined'),
      `§8 one inbox row for the job, nothing quarantined (${S(inboxRows())})`);
  }

  // ── 9 echter Konflikt: die Galerie ändert sich, während der Editor offen ist ──
  {
    await openFixture(edge, 'Check Gallery');
    ok(await waitStrip(edge, 4), `§9 the editor shows the current four photos (${await stripCount(edge)})`);
    // Hinter dem Rücken des Telefons: ein anderer Auftrag stellt die Reihenfolge um.
    const token = await serverLogin();
    const cur = activeLinks(pid.id);
    const base = (await readProduct(token, pid.sku)).gallery_baseline;
    const evOther = 'ev-other-' + Math.random().toString(36).slice(2);
    const other = await fetch(`${BASE}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ mode: 'collection', upload_event_id: evOther, entity_id: 'ent-' + evOther, protocol_version: 2, images: [],
        metadata: { kind: 'gallery_edit', productId: pid.id, galleryBaseline: base, order: [cur[1], cur[0], cur[2], cur[3]].map((l) => ({ keep: l.link_id })), remove: [] } }) });
    ok(other.status >= 200 && other.status < 300, `§9 the other change is accepted (${other.status})`);
    ok((await waitTerminal(evOther, 120000))?.state === 'ready', '§9 …and applied');
    const nachAnderem = linkRows(pid.id);
    // Jetzt speichert das Telefon mit seiner (überholten) Sicht ein Galeriebild dazu.
    ok(await waehle(edge, '#peGalleryInput', [paths[6]], 5), '§9 the phone adds a gallery photo on its stale view');
    const vorUp = uploads.length;
    await clickE(edge, '#peSave');
    const end = Date.now() + 30000; while (Date.now() < end && uploads.length === vorUp) await sleep(200);
    const mine = uploads[uploads.length - 1];
    const job = await waitTerminal(mine.upload_event_id, 120000);
    ok(job?.state === 'quarantined' && job?.error_code === 'MOBILE_GALLERY_BASELINE_CHANGED', `§9 the phone's job ends as a conflict (${job?.state}/${job?.error_code})`);
    ok(same(linkRows(pid.id), nachAnderem) && activeLinks(pid.id).length === 4, '§9 nothing of it was applied — the other change stands, no photo added');
    await sleep(2000);
    console.log('  · §9 phone message: ' + (await msgOf(edge)));
  }

  ok(consoleErrors.length === 0, `no uncaught page exception (${consoleErrors.slice(0, 2).join(' | ')})`);
  edge.closeWs(); killEdge(); app.closeWs(); killApp();
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killEdge(); killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    console.log(`\nMOBILE check item gallery: ${PASS} passed, ${FAIL} failed — Nachweise: ${OUT}`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
