// MOBILE-GALLERY — New Collection Item: „Take photo" UND „Choose from gallery", durch die ECHTE /mobile-Seite.
//
// Beide Wege füllen dieselbe Liste über denselben Handler; Hochladen, AI Identify, Retry und Drain
// sind die bestehenden. Geprüft wird auf einem kleinen Telefon (360 px breit):
//   ein Galeriebild · mehrere auf einmal · Kamera + Galerie gemischt · Auswahl abbrechen · Foto entfernen ·
//   Höchstzahl 8 · AI Identify mit einem Galeriebild · verlorene Antwort + Retry ohne doppelte Medien.
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
const TENANT = 'tenant-1', BRANCH = 'branch-main';

const RUN = join(os.tmpdir(), 'lataif-gallery-e2e', 'run-' + Date.now());
const OUT = join(os.tmpdir(), 'lataif-evidence', 'mobile-gallery');
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

function dbQ(file, sql) { let db; try { db = new DatabaseSync(file); return db.prepare(sql).all(); } catch { return []; } finally { try { db?.close(); } catch {} } }
const productCount = () => { const r = dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM products'); return r.length ? r[0].c : -1; };
const activeLinks = (id) => dbQ(BIZ_DB, `SELECT media_id, is_primary, sort_order FROM media_links WHERE entity_id='${id}' AND deleted_at IS NULL ORDER BY sort_order`);
const inboxRows = (ev) => dbQ(SERVER_DB, `SELECT upload_event_id, state FROM mobile_upload_inbox WHERE upload_event_id='${ev}'`);
const readyCount = () => { const r = dbQ(SERVER_DB, "SELECT COUNT(*) c FROM mobile_upload_inbox WHERE state='ready'"); return r.length ? r[0].c : -1; };
const imageRows = (ev) => dbQ(SERVER_DB, `SELECT slot, is_primary, content_hash FROM mobile_upload_image WHERE upload_event_id='${ev}' ORDER BY slot`);

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
const ONBOARD_PW = 'e2epass123';
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
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
async function setFiles(c, sel, paths) { const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false }); await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: paths }); }
/** Galerie/Kamera wählen und warten, bis die Liste die erwartete Länge hat (das Verkleinern ist asynchron). */
async function waehle(c, sel, paths, soll) {
  await setFiles(c, sel, paths);
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await thumbCount(c) === soll) return true; await sleep(150); }
  return false;
}
async function mobileLogin(c) { await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW); await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker'); }
async function mobileLoginVerified(c) {
  const probe = async () => { const t = await c.ev(`return localStorage.getItem('lataif_mobile_token');`); if (!t) return 0; const r = await fetch(`${BASE}/api/products/by-sku/__auth_probe__`, { headers: { Authorization: 'Bearer ' + t } }); return r.status; };
  await mobileLogin(c);
  let st = await probe();
  if (st === 401) { await c.ev(`localStorage.removeItem('lataif_mobile_token'); location.reload(); return 1;`); await sleep(2500); await mobileLogin(c); st = await probe(); }
  ok(st !== 0 && st !== 401, `the mobile session is really authenticated (${st})`);
}
const thumbCount = (c) => c.ev(`return document.querySelectorAll('#cPhotoStrip .photo-thumb').length;`);
const removeThumb = (c, i) => c.ev(`const t=document.querySelectorAll('#cPhotoStrip .photo-thumb')[${i}]; if(!t) return 'NO'; t.querySelector('.rm').click(); return 'OK';`);
const stripSrcs = (c) => c.ev("return [...document.querySelectorAll('#cPhotoStrip img')].map(i=>i.src);");
const formMsg = (c) => c.ev(`const t=(id)=>{const e=document.getElementById(id); return e && !e.classList.contains('hidden') ? e.textContent.trim() : '';}; return [t('cError'), t('cSuccess'), t('cPendingText')].filter(Boolean).join(' | ');`);
async function clearPhotos(c) { for (let i = 0; i < 12 && (await thumbCount(c)) > 0; i++) await removeThumb(c, 0); }

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
  const uploads = [], responses = [], identify = [], consoleErrors = [];
  const verloren = { an: false, getroffen: 0 };
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (r && /\/api\/mobile\/upload$/.test(r.url) && r.method === 'POST' && r.postData) { try { uploads.push(JSON.parse(r.postData)); } catch {} }
      if (r && /\/api\/ai\/identify$/.test(r.url) && r.method === 'POST' && r.postData) { try { identify.push(JSON.parse(r.postData)); } catch {} }
    } else if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r && /\/api\/mobile\/upload$/.test(r.url)) responses.push(r.status); }
    else if (m.method === 'Fetch.requestPaused') {
      // Die Antwort des Servers ist da (er HAT die Charge angenommen) — das Telefon bekommt sie nie.
      if (verloren.an) { verloren.an = false; verloren.getroffen++; c.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionClosed' }).catch(() => {}); }
      else c.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    }
    else if (m.method === 'Runtime.exceptionThrown') { consoleErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception')); }
  });
  await c.send('Page.navigate', { url }); await sleep(1500);
  return { c, uploads, responses, identify, consoleErrors, verloren };
}
async function fillWatch(edge, name) {
  await setValE(edge, '#cCategory', 'cat-watch'); await sleep(500);
  await setValE(edge, '#cBrand', 'Rolex');
  await setValE(edge, '#cName', name);
  await setValE(edge, '#cCondition', 'Pre-Owned');
  await setValE(edge, '#attr_dial', 'Black');
  await setValE(edge, '#attr_material', 'Steel');
  await sleep(200);
}
async function waitReady(app, want, ms) {
  const half = Date.now() + Math.floor(ms / 2);
  while (Date.now() < half) { if (readyCount() >= want) return true; await sleep(1000); }
  await app.ev('window.location.reload(); return 1;').catch(() => {});
  await sleep(3000);
  const end = Date.now() + Math.floor(ms / 2);
  while (Date.now() < end) { if (readyCount() >= want) return true; await sleep(1000); }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');

  const b64 = ['1', '3', '5', '7'].map((n) => seed('jpeg', n));
  const paths = b64.map((b, i) => { const p = join(RUN, `img${i}.jpg`); writeFileSync(p, Buffer.from(b, 'base64')); return p; });
  ok(new Set(b64.map(sha)).size === 4, 'fixture: four distinguishable JPEGs');

  const ws = await startApp(); const app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');
  await frontendLogin(app);

  const { c: edge, uploads, responses, identify, consoleErrors, verloren } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLoginVerified(edge);
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');

  // ── 0 Aufbau: zwei Wege, kompakt auf 360 px ──────────────────────────────
  const aufbau = JSON.parse(await edge.ev(`const r=(s)=>{const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return {t:Math.round(b.top),l:Math.round(b.left),w:Math.round(b.width),h:Math.round(b.height),txt:e.textContent.trim()};};
    const cam=document.querySelector('#cPhotoInput'), gal=document.querySelector('#cGalleryInput');
    return JSON.stringify({ take:r('#cTakePhoto'), gallery:r('#cChooseGallery'), scroll:document.documentElement.scrollWidth, vw:innerWidth,
      camCapture:cam&&cam.getAttribute('capture'), camMultiple:!!(cam&&cam.multiple), galCapture:gal&&gal.hasAttribute('capture'), galMultiple:!!(gal&&gal.multiple), galAccept:gal&&gal.accept,
      takeFor:document.querySelector('#cTakePhoto')?.getAttribute('for'), galFor:document.querySelector('#cChooseGallery')?.getAttribute('for') });`));
  ok(aufbau.take?.txt.includes('Take photo') && aufbau.gallery?.txt.includes('Choose from gallery'), `§0 two choices: „Take photo" and „Choose from gallery" (${aufbau.take?.txt} | ${aufbau.gallery?.txt})`);
  ok(aufbau.takeFor === 'cPhotoInput' && aufbau.galFor === 'cGalleryInput', '§0 …each opens its own picker');
  ok(aufbau.camCapture === 'environment' && aufbau.galCapture === false && aufbau.galMultiple === true && aufbau.galAccept === 'image/*',
    `§0 camera keeps capture=environment; gallery has NO capture, takes several images (${S({ c: aufbau.camCapture, g: aufbau.galCapture, m: aufbau.galMultiple })})`);
  ok(aufbau.take && aufbau.gallery && aufbau.take.t === aufbau.gallery.t && aufbau.take.w >= 130 && aufbau.gallery.w >= 130 && aufbau.take.h <= 100,
    `§0 compact on 360 px: side by side, each ≥ 130 px wide, ≤ 100 px high (${S([aufbau.take, aufbau.gallery])})`);
  ok(aufbau.scroll <= aufbau.vw, `§0 no horizontal scrolling at ${aufbau.vw} px (${aufbau.scroll})`);

  // ── 1 ein Galeriebild ────────────────────────────────────────────────────
  ok(await waehle(edge, '#cGalleryInput', [paths[0]], 1), `§1 one gallery photo is added (${await thumbCount(edge)})`);
  ok(await visE(edge, '#cAiBtn'), '§1 …and AI Identify is offered for it');
  // ── 2 mehrere auf einmal, hinzugefügt (nicht ersetzt) ────────────────────
  ok(await waehle(edge, '#cGalleryInput', [paths[1], paths[2]], 3), `§2 several gallery photos at once are ADDED to the existing one (${await thumbCount(edge)})`);
  // ── 3 Kamera + Galerie gemischt, eine Liste in Auswahlreihenfolge ────────
  ok(await waehle(edge, '#cPhotoInput', [paths[3]], 4), `§3 a camera photo joins the same list (${await thumbCount(edge)})`);
  {
    const s = (await stripSrcs(edge)).map((d) => sha(String(d).split(',')[1] || ''));
    ok(new Set(s).size === 4, `§3 four distinct previews, camera and gallery mixed (${s.join(',')})`);
  }
  ok(/4 of 8 photos/.test(await edge.ev("return document.querySelector('#cPhotoCount').textContent;")), '§3 the counter shows 4 of 8');
  // ── 4 Auswahl abbrechen ändert nichts ────────────────────────────────────
  {
    const vor = await stripSrcs(edge);
    await setFiles(edge, '#cGalleryInput', []);
    await edge.ev(`const g=document.querySelector('#cGalleryInput'); g.dispatchEvent(new Event('cancel',{bubbles:true})); g.dispatchEvent(new Event('change',{bubbles:true})); return 1;`);
    await sleep(600);
    ok(S(await stripSrcs(edge)) === S(vor) && (await formMsg(edge)) === '', '§4 cancelling the gallery changes nothing (same photos, same order, no message)');
  }
  // ── 5 ein Foto einzeln entfernen ─────────────────────────────────────────
  {
    const vor = await stripSrcs(edge);
    ok(await removeThumb(edge, 1) === 'OK' && await thumbCount(edge) === 3, '§5 a single photo can be removed');
    ok(S(await stripSrcs(edge)) === S([vor[0], vor[2], vor[3]]), '§5 …exactly that one, the others keep their order');
  }
  // ── 6 Höchstzahl 8 ───────────────────────────────────────────────────────
  {
    await setFiles(edge, '#cGalleryInput', [paths[0], paths[1], paths[2], paths[3], paths[0], paths[1], paths[2]]);
    const end = Date.now() + 20000; while (Date.now() < end && (await formMsg(edge)) === '') await sleep(200);
    ok(await thumbCount(edge) === 8, `§6 the limit holds: 3 + 7 chosen → 8 kept (${await thumbCount(edge)})`);
    ok(/At most 8 photos per item — 2 not added/.test(await formMsg(edge)), `§6 …and the operator is told (${await formMsg(edge)})`);
    const voll = JSON.parse(await edge.ev(`return JSON.stringify({ t: document.querySelector('#cTakePhoto').classList.contains('is-full'), g: document.querySelector('#cChooseGallery').classList.contains('is-full'), ci: document.querySelector('#cPhotoInput').disabled, gi: document.querySelector('#cGalleryInput').disabled, txt: document.querySelector('#cPhotoCount').textContent });`));
    ok(voll.t && voll.g && voll.ci && voll.gi && /8 of 8/.test(voll.txt), `§6 at 8 both choices are disabled (${S(voll)})`);
    await mkdirSync(OUT, { recursive: true });
    const shot = await edge.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'collection-photos-360px-full.png'), Buffer.from(shot.data, 'base64'));
    await removeThumb(edge, 7);
    const wieder = await edge.ev("return !document.querySelector('#cChooseGallery').classList.contains('is-full') && !document.querySelector('#cGalleryInput').disabled;");
    ok(wieder && await thumbCount(edge) === 7, '§6 removing one re-enables adding');
  }
  await clearPhotos(edge);
  await edge.ev("document.getElementById('cError').classList.add('hidden'); return 1;");

  // ── 7 AI Identify mit einem Galeriebild ──────────────────────────────────
  {
    ok(await waehle(edge, '#cGalleryInput', [paths[2], paths[1]], 2), '§7 two gallery photos chosen');
    const cover = (await stripSrcs(edge))[0];
    const vor = identify.length;
    await clickE(edge, '#cAiBtn');
    const end = Date.now() + 30000; while (Date.now() < end && identify.length === vor) await sleep(200);
    await edge.ev("return new Promise(r=>{ const t=Date.now(); const f=()=>{ if (!/Identifying/.test(document.querySelector('#cAiBtn').textContent) || Date.now()-t>30000) r(1); else setTimeout(f,200); }; f(); });");
    ok(identify.length === vor + 1 && identify[identify.length - 1].image === cover,
      `§7 AI Identify sends the gallery cover photo, unchanged (${identify.length - vor} request; same image ${identify[identify.length - 1]?.image === cover})`);
    ok(await thumbCount(edge) === 2 && S((await stripSrcs(edge))[0]) === S(cover), '§7 …and leaves the photos as they were');
  }
  await clearPhotos(edge);

  // ── 8 Kamera + Galerie hochladen, Antwort geht verloren, Retry: keine doppelten Medien ──
  {
    await fillWatch(edge, 'Gallery Mixed');
    ok(await waehle(edge, '#cPhotoInput', [paths[0]], 1) && await waehle(edge, '#cGalleryInput', [paths[1], paths[2]], 3), '§8 camera + gallery: three photos');
    const strip = (await stripSrcs(edge)).map((d) => sha(String(d).split(',')[1] || ''));
    await edge.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/mobile/upload', requestStage: 'Response' }] });
    verloren.an = true;
    const vorUp = uploads.length;
    await clickE(edge, '#cSaveBtn');
    let end = Date.now() + 30000; while (Date.now() < end && verloren.getroffen === 0) await sleep(200);
    await sleep(1500);
    ok(verloren.getroffen === 1 && uploads.length === vorUp + 1, `§8 the first upload reached the server, its answer was lost (${verloren.getroffen}/${uploads.length - vorUp})`);
    const u = uploads[uploads.length - 1];
    ok((u.images || []).length === 3 && S(u.images.map((i) => sha(i.data_base64))) === S(strip),
      '§8 …it carried the three photos in strip order (camera + gallery through the same path)');
    ok(/queued|pending/i.test(await formMsg(edge)), `§8 the phone keeps it as pending (${await formMsg(edge)})`);
    ok(inboxRows(u.upload_event_id).length === 1, '§8 the server holds exactly one inbox row for it');
    await edge.send('Fetch.disable');
    await waitVisE(edge, '#cRetryPending', 10000);
    const vorRetry = uploads.length;
    await clickE(edge, '#cRetryPending');
    end = Date.now() + 30000; while (Date.now() < end && uploads.length === vorRetry) await sleep(200);
    await sleep(2000);
    const r = uploads[uploads.length - 1];
    ok(uploads.length === vorRetry + 1 && r.upload_event_id === u.upload_event_id && r.entity_id === u.entity_id,
      `§8 Retry resends the SAME upload id and entity (${r?.upload_event_id === u.upload_event_id})`);
    ok(responses[responses.length - 1] === 200 || responses[responses.length - 1] === 201, `§8 …and the server accepts it as a replay (${responses[responses.length - 1]})`);
    ok(inboxRows(u.upload_event_id).length === 1 && imageRows(u.upload_event_id).length === 3, `§8 still ONE inbox row and THREE images (${inboxRows(u.upload_event_id).length}/${imageRows(u.upload_event_id).length})`);
    ok(await waitReady(app, 1, 120000), '§8 the desktop drained it');
    await sleep(1500);
    const links = activeLinks(u.entity_id);
    ok(productCount() === 1 && links.length === 3 && new Set(links.map((l) => l.media_id)).size === 3 && links.filter((l) => l.is_primary).length === 1,
      `§8 exactly one product with three distinct media, one cover — no duplicates (${productCount()} / ${links.length})`);
    await updatePendingWait(edge);
    ok(!(await visE(edge, '#cRetryPending')), '§8 nothing is pending any more');
  }

  ok(consoleErrors.length === 0, `no uncaught page exception (${consoleErrors.slice(0, 2).join(' | ')})`);
  edge.closeWs(); killEdge(); app.closeWs(); killApp();
}
async function updatePendingWait(edge) { for (let i = 0; i < 20; i++) { if (!(await visE(edge, '#cRetryPending'))) return; await sleep(300); } }

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killEdge(); killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    console.log(`\nMOBILE gallery pick: ${PASS} passed, ${FAIL} failed — Nachweise: ${OUT}`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
