// MOBILE-MULTI-IMAGE §3/§14 — several photos per mobile item, through the REAL /mobile page.
//
// The upload contract, the inbox and the desktop ingest have always carried an ordered batch
// (slots 0..N-1, primary = slot 0, MAX_UPLOAD_IMAGES = 8). Only the capture UI held a product to a
// single photo. This suite proves the whole chain end to end and — just as importantly — that the
// assertions would notice if it silently fell back to one image.
//
// Isolated e2e identifier + AppData + sync port (LATAIF_E2E_SYNC_PORT=3011); production (3001) is
// never touched.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
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

const RUN = join(os.tmpdir(), 'lataif-multiimg-e2e', 'run-' + Date.now());
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
const sha = (b64) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16);

function dbQ(file, sql) { let db; try { db = new DatabaseSync(file); return db.prepare(sql).all(); } catch { return []; } finally { try { db?.close(); } catch {} } }
const productCount = () => { const r = dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM products'); return r.length ? r[0].c : -1; };
const activeLinks = (id) => dbQ(BIZ_DB, `SELECT media_id, is_primary, sort_order FROM media_links WHERE entity_id='${id}' AND deleted_at IS NULL ORDER BY sort_order`);
const inboxCount = () => { const r = dbQ(SERVER_DB, 'SELECT COUNT(*) c FROM mobile_upload_inbox'); return r.length ? r[0].c : -1; };
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
function killApp() { try { execFileSync('taskkill', ['/F', '/PID', String(appProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
function killAllApp() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
function killEdge() { try { execFileSync('taskkill', ['/F', '/PID', String(edgeProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
async function waitPortFree(port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; } if (!n) return true; await sleep(500); } return false; }
async function waitHealthy() { const end = Date.now() + 40000; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); } throw new Error('server never healthy'); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
async function invoke(c, cmd, args) { return c.ev(`try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; }`); }

// ── die DESKTOP-Seite (Tauri-Fenster) ───────────────────────────────────────
const ONBOARD_PW = 'e2epass123';
const setValApp = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const existsApp = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
async function waitApp(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsApp(c, sel)) return true; await sleep(300); } throw new Error('waitApp ' + sel); }
// MOBILE-04B2A2 — der Drain-Worker laeuft NUR in einer angemeldeten Desktop-Session (er ist an
// DB- und Auth-Epoche gebunden). Ohne diesen Login bliebe jede Upload-Zeile fuer immer `accepted`
// stehen und der Test wuerde eine Produktlosigkeit messen, die nichts mit Multi-Image zu tun hat.
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

// ── die MOBILE-Seite (Edge) ─────────────────────────────────────────────────
const existsE = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const visE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return !!e && !e.classList.contains('hidden') && e.offsetParent!==null;`);
async function waitE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await existsE(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitVisE(c, sel, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (await visE(c, sel)) return true; await sleep(200); } throw new Error('waitVisE ' + sel); }
const setValE = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
async function setFiles(c, sel, paths) { const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false }); await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: paths }); }
async function mobileLogin(c) { await waitE(c, '#email'); await setValE(c, '#email', OWNER_EMAIL); await setValE(c, '#password', OWNER_PW); await clickE(c, '#loginBtn'); await waitVisE(c, '#modePicker'); }

/** Anmelden UND beweisen, dass das Token wirklich gilt. Der eingebettete Server kann waehrend des
 *  Hochfahrens noch einmal neu starten; faellt das zwischen Login und erstem Upload, ist das gerade
 *  ausgestellte Token ungueltig und der Upload scheitert mit 401, ohne dass die Seite etwas falsch
 *  gemacht haette. Das ist eine Vorbedingung — hier wird sie hergestellt und geprueft. */
async function mobileLoginVerified(c) {
  const probe = async () => {
    const t = await c.ev(`return localStorage.getItem('lataif_mobile_token');`);
    if (!t) return 0;
    const r = await fetch(`${BASE}/api/products/by-sku/__auth_probe__`, { headers: { Authorization: 'Bearer ' + t } });
    return r.status;
  };
  await mobileLogin(c);
  let st = await probe();
  if (st === 401) { await c.ev(`localStorage.removeItem('lataif_mobile_token'); location.reload(); return 1;`); await sleep(2500); await mobileLogin(c); st = await probe(); }
  ok(st !== 0 && st !== 401, `the mobile session is really authenticated before the fixture (${st})`);
}
const thumbCount = (c) => c.ev(`return document.querySelectorAll('#cPhotoStrip .photo-thumb').length;`);
const primaryIndex = (c) => c.ev(`const t=[...document.querySelectorAll('#cPhotoStrip .photo-thumb')]; return t.findIndex(x=>x.classList.contains('is-primary'));`);
const removeThumb = (c, i) => c.ev(`const t=document.querySelectorAll('#cPhotoStrip .photo-thumb')[${i}]; if(!t) return 'NO'; t.querySelector('.rm').click(); return 'OK';`);
const promoteThumb = (c, i) => c.ev(`const t=document.querySelectorAll('#cPhotoStrip .photo-thumb')[${i}]; if(!t) return 'NO'; t.click(); return 'OK';`);

async function startEdge(url) {
  edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, 'about:blank'], { stdio: 'ignore' });
  const end = Date.now() + 40000; let ws = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/list`)).json(); const pg = l.find((t) => t.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
  if (!ws) throw new Error('edge CDP did not come up');
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('Network.enable');
  const uploads = [], responses = [], consoleErrors = [];
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') { const r = m.params.request; if (r && /\/api\/mobile\/upload$/.test(r.url) && r.method === 'POST' && r.postData) { try { uploads.push(JSON.parse(r.postData)); } catch {} } }
    else if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r && /\/api\/mobile\/upload$/.test(r.url)) responses.push(r.status); }
    else if (m.method === 'Runtime.exceptionThrown') { consoleErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception')); }
  });
  await c.send('Page.navigate', { url }); await sleep(1500);
  return { c, uploads, responses, consoleErrors };
}

/** Every field the watch category marks required — an incomplete form never reaches the upload. */
async function fillWatch(edge, name) {
  await setValE(edge, '#cCategory', 'cat-watch'); await sleep(500);
  await setValE(edge, '#cBrand', 'Rolex');
  await setValE(edge, '#cName', name);
  await setValE(edge, '#cCondition', 'Pre-Owned');
  await setValE(edge, '#attr_dial', 'Black');
  await setValE(edge, '#attr_material', 'Steel');
  await sleep(200);
}
/** Direkt gegen den Upload-Vertrag — fuer die Faelle, die die UI vorher wegfiltert. */
async function serverLogin() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) });
  return (await r.json()).token;
}
async function postUpload(token, over) {
  const body = {
    protocol_version: 2,
    mode: 'collection',
    metadata: { categoryId: 'cat-watch', brand: 'Rolex', name: 'Contract Check', condition: 'Pre-Owned', attributes: { dial: 'Black', material: 'Steel' } },
    ...over,
  };
  const r = await fetch(`${BASE}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

/** Was das Formular gerade sagt — damit ein Fehlschlag seinen Grund mitliefert statt nur "0 POSTs". */
const formMsg = (c) => c.ev(`const t=(id)=>{const e=document.getElementById(id); return e && !e.classList.contains('hidden') ? e.textContent.trim() : '';}; return [t('cError'), t('cSuccess'), t('cPendingText')].filter(Boolean).join(' | ');`);
/** Warten, bis der Drain `want` Jobs fertig gemeldet hat. Nach der halben Zeit einmal das Fenster
 *  neu laden — derselbe Griff, den `mobile-fields.e2e.mjs` benutzt: der Poller bewaffnet sich im
 *  post-auth-Pfad, und ein Reload ist der reguläre Weg, ihn erneut durch diesen Pfad zu schicken.
 *  Das versteckt keinen Fehler: schlägt es danach fehl, schlägt der Test fehl. */
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
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');

  // Vier UNTERSCHEIDBARE JPEGs — nur so kann der Test Identitaet und Reihenfolge pruefen und nicht
  // bloss "irgendein Bild ist da".
  const b64 = ['1', '3', '5', '7'].map((n) => seed('jpeg', n));
  const paths = b64.map((b, i) => { const p = join(RUN, `img${i}.jpg`); writeFileSync(p, Buffer.from(b, 'base64')); return p; });
  const hashes = b64.map(sha);
  ok(new Set(hashes).size === 4, 'fixture: four distinguishable JPEGs');

  const ws = await startApp(); const app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');
  // Reihenfolge ist bedeutungstragend: der Drain-Poller wird im POST-AUTH-Pfad bewaffnet und nur
  // dann, wenn die Bindung da bereits konfiguriert ist. Erst konfigurieren, dann anmelden.
  await frontendLogin(app);

  const { c: edge, uploads, responses, consoleErrors } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLoginVerified(edge);
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');

  // ── §3 die Auswahl selbst: mehrere Fotos, entfernen, Cover wechseln ──────
  await setFiles(edge, '#cPhotoInput', [paths[0], paths[1], paths[2]]);
  await waitVisE(edge, '#cPhotoStrip', 10000);
  ok(await thumbCount(edge) === 3, `§3 three photos are visible before save (${await thumbCount(edge)})`);
  ok(await primaryIndex(edge) === 0, '§3 the first photo is the cover');
  ok(await removeThumb(edge, 1) === 'OK', '§3 a single photo can be removed before save');
  ok(await thumbCount(edge) === 2, `§3 …leaving exactly the other two (${await thumbCount(edge)})`);
  ok(await promoteThumb(edge, 1) === 'OK', '§3 tapping a photo promotes it');
  ok(await primaryIndex(edge) === 0, '§3 …and the promoted one is now the cover');
  // Auswahl verwerfen und sauber neu beginnen — der Rest des Tests soll von hier aus deterministisch sein.
  await removeThumb(edge, 0); await removeThumb(edge, 0);
  ok(await thumbCount(edge) === 0, '§3 removing every photo empties the strip');
  ok(!(await visE(edge, '#cPhotoStrip')), '§3 …and the strip disappears again');

  // ── §14.2/§14.3/§14.4 Create mit DREI Bildern, Reihenfolge + Cover ───────
  await fillWatch(edge, 'Multi Three');
  await setFiles(edge, '#cPhotoInput', [paths[0], paths[1], paths[2]]);
  await waitVisE(edge, '#cPhotoStrip', 10000);
  ok(await thumbCount(edge) === 3, '§14.2 three photos selected');
  await promoteThumb(edge, 2);                          // drittes Bild wird Cover
  // Die Seite skaliert und re-encodiert jedes Foto, die Datei-Bytes ueberleben das nicht. Also wird
  // gegen das geprueft, was der Strip WIRKLICH zeigt — genau das soll ja hochgeladen werden.
  const stripSrcs = await edge.ev("return [...document.querySelectorAll('#cPhotoStrip img')].map(i=>i.src);");
  const stripHashes = stripSrcs.map((d) => sha(String(d).split(',')[1] || ''));
  await clickE(edge, '#cSaveBtn');
  let end = Date.now() + 25000; while (Date.now() < end && uploads.length < 1) await sleep(200); await sleep(800);
  ok(uploads.length === 1, `§14.7 exactly one upload POST (${uploads.length}) — form says: ${await formMsg(edge)}`);
  const u = uploads[0];
  ok(Array.isArray(u.images) && u.images.length === 3, `§14.2 the POST carries THREE images (${u.images?.length})`);
  const sent = (u.images || []).map((i) => sha(i.data_base64));
  ok(JSON.stringify(sent) === JSON.stringify(stripHashes),
    `§14.3 the upload order IS the strip order, promoted photo first (${sent.join(',')} vs ${stripHashes.join(',')})`);
  ok(responses.length >= 1 && responses.every((s) => s >= 200 && s < 300), `§14 upload accepted (${responses.join(',')})`);

  // Server-Manifest: Slots 0..2, genau ein primary und das ist Slot 0.
  const imgs = imageRows(u.upload_event_id);
  ok(imgs.length === 3, `§14.2 the inbox stored three images (${imgs.length})`);
  ok(imgs.map((r) => r.slot).join(',') === '0,1,2', `§14.3 slots are 0..2 without gaps (${imgs.map((r) => r.slot).join(',')})`);
  ok(imgs.filter((r) => r.is_primary).length === 1 && imgs[0].is_primary === 1, '§14.4 exactly one primary and it is slot 0');

  // ── Drain: das Produkt bekommt DREI aktive Links ─────────────────────────
  ok(await waitReady(app, 1, 120000), '§14 the drain reported the upload ready — inbox: ' + JSON.stringify(dbQ(SERVER_DB, 'SELECT upload_event_id, state, error_code FROM mobile_upload_inbox')));
  await sleep(1500);
  const pid = u.entity_id;
  const links = activeLinks(pid);
  ok(links.length === 3, `§14.2 the product has THREE active media links (${links.length})`);
  ok(new Set(links.map((l) => l.media_id)).size === 3, '§14.2 …three DISTINCT media, not the same one three times');
  ok(links.filter((l) => l.is_primary).length === 1, `§14.4 exactly one primary link (${links.filter((l) => l.is_primary).length})`);
  ok(links[0].is_primary === 1, '§14.4 …and it is the first in sort order');
  ok(productCount() === 1, `§14.7 exactly one product exists (${productCount()})`);

  // ── §14.7 Double submit: zweimal tippen darf nichts verdoppeln ───────────
  const uploadsBefore = uploads.length;
  await clickE(edge, '.back'); await sleep(400);
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');
  await fillWatch(edge, 'Multi Double');
  await setFiles(edge, '#cPhotoInput', [paths[0], paths[3]]);
  await waitVisE(edge, '#cPhotoStrip', 10000);
  await edge.ev(`const b=document.querySelector('#cSaveBtn'); b.click(); b.click(); return 'OK';`);
  end = Date.now() + 25000; while (Date.now() < end && uploads.length < uploadsBefore + 1) await sleep(200); await sleep(1500);
  ok(uploads.length === uploadsBefore + 1, `§14.7 a double tap produces exactly ONE more POST (${uploads.length - uploadsBefore})`);
  const u2 = uploads[uploads.length - 1];
  ok((u2.images || []).length === 2, `§14.2 …carrying both photos (${u2.images?.length})`);
  ok(await waitReady(app, 2, 120000), '§14 the second upload drained');
  await sleep(1500);
  ok(productCount() === 2, `§14.7 exactly two products in total — no duplicate (${productCount()})`);
  const links2 = activeLinks(u2.entity_id);
  ok(links2.length === 2, `§14.2 the second product has exactly two links (${links2.length})`);
  ok(new Set(links2.map((l) => l.media_id)).size === 2, '§14.2 …two distinct media');

  // ── §14.5a Eine unlesbare Datei reisst die gueltigen NICHT mit ───────────
  //
  // Der Fehler faellt schon beim Dekodieren auf: die Datei wird uebersprungen, die anderen bleiben
  // ausgewaehlt. Genau das muss der Test festhalten — und zwar mit der exakten Zahl, sonst wuerde
  // ein "alles verworfen" oder ein "kaputtes trotzdem uebernommen" unbemerkt durchgehen.
  const badPath = join(RUN, 'bad.jpg'); writeFileSync(badPath, Buffer.from('this is not an image at all', 'utf8'));
  await clickE(edge, '.back'); await sleep(400);
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');
  await setFiles(edge, '#cPhotoInput', [paths[0], badPath, paths[1]]);
  await waitVisE(edge, '#cPhotoStrip', 10000);
  ok(await thumbCount(edge) === 2, `§14.5a an unreadable file is skipped, the two good ones stay (${await thumbCount(edge)})`);
  const skipMsg = await formMsg(edge);
  ok(/could not be loaded/i.test(skipMsg), `§14.5a …and the operator is told (\"${skipMsg}\")`);
  await removeThumb(edge, 0); await removeThumb(edge, 0);
  ok(await thumbCount(edge) === 0, '§14.5a the selection can be cleared again');

  // ── §14.5b Serverseitig: ein kaputtes Bild MITTEN in der Charge ──────────
  //
  // Der Weg ueber die UI kann das nicht erzeugen — sie filtert unlesbare Dateien vorher weg. Also
  // direkt gegen den Upload-Vertrag: Charge mit drei Bildern, das zweite unbrauchbar. Erwartung ist
  // die GANZE Charge abgelehnt, kein Inbox-Rest, kein halbes Produkt.
  const inboxBefore = inboxCount(), productsBefore = productCount();
  const token = await serverLogin();
  ok(!!token, '§14.5b server login for the direct contract check');
  const badBatch = await postUpload(token, {
    upload_event_id: 'e2e-bad-' + Date.now(),
    entity_id: 'e2e-bad-entity-' + Date.now(),
    images: [
      { mime: 'image/jpeg', data_base64: b64[0] },
      { mime: 'image/jpeg', data_base64: Buffer.from('not-an-image').toString('base64') },
      { mime: 'image/jpeg', data_base64: b64[1] },
    ],
  });
  ok(badBatch.status >= 400 && badBatch.status < 500, `§14.5b the batch is rejected (${badBatch.status})`);
  await sleep(3000);
  ok(inboxCount() === inboxBefore, `§14.5b no inbox row is left behind (${inboxCount()} vs ${inboxBefore})`);
  ok(productCount() === productsBefore, `§14.5b and NO product is created (${productCount()} vs ${productsBefore})`);

  // ── §14.6 Retry derselben Charge, jetzt gueltig: genau EIN Produkt ───────
  const retryEvent = 'e2e-retry-' + Date.now(), retryEntity = 'e2e-retry-entity-' + Date.now();
  const body = { upload_event_id: retryEvent, entity_id: retryEntity, images: [{ mime: 'image/jpeg', data_base64: b64[0] }, { mime: 'image/jpeg', data_base64: b64[3] }] };
  const first = await postUpload(token, body);
  const again = await postUpload(token, body);          // exakt derselbe Aufruf — ein Retry
  ok(first.status < 400, `§14.6 the valid batch is accepted (${first.status})`);
  ok(again.status < 400, `§14.6 …and the retry is accepted too, not an error (${again.status})`);
  ok(await waitReady(app, 3, 120000), '§14.6 the retried upload drained');
  await sleep(1500);
  const retryLinks = activeLinks(retryEntity);
  ok(retryLinks.length === 2, `§14.6 the retry produced exactly two links, not four (${retryLinks.length})`);
  ok(new Set(retryLinks.map((l) => l.media_id)).size === 2, '§14.6 …two distinct media, no duplicate');
  ok(dbQ(BIZ_DB, `SELECT COUNT(*) c FROM products WHERE id='${retryEntity}'`)[0].c === 1, '§14.6 …and exactly one product for that entity');

  ok(consoleErrors.length === 0, `no uncaught page exception during the whole run (${consoleErrors.slice(0, 2).join(' | ')})`);
  edge.closeWs(); killEdge(); app.closeWs(); killApp();
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killEdge(); killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    console.log(`\nMOBILE multi-image: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
