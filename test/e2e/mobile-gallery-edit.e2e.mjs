// MOBILE-EDIT S3 — die GALERIE eines bestehenden Artikels vom Handy aus aendern, durch die echte
// /mobile-Seite.
//
// Bewiesen wird nicht "es sieht richtig aus", sondern was in `media_links` steht: Link-Ids,
// Media-Ids, sort_order, is_primary, deleted_at — vorher und nachher, Zeile fuer Zeile. Zaehler
// allein wuerden jede Verwechslung durchgehen lassen.
//
// Der oberste Vertrag, gegen den hier gemessen wird: kein bestehendes Bild verschwindet durch einen
// Lesefehler, einen Upload-Fehler, einen ueberholten Baseline, einen Retry, einen Doppel-Save oder
// einen unvollstaendig geladenen Zustand.
//
// Isoliert: e2e-Identitaet `com.lataif.app.e2e`, eigenes AppData, eigener Sync-Port 3011. Die
// produktive Installation wird nie geoeffnet — weder lesend noch schreibend.
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

const RUN = join(os.tmpdir(), 'lataif-galleryedit-e2e', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  \u2717 ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const thumbCount = (c) => c.ev(`return document.querySelectorAll('#cPhotoStrip .photo-thumb').length;`);
async function waitThumbs(c, n, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await thumbCount(c) === n) return true; await sleep(200); } return false; }
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const S = (v) => JSON.stringify(v);

function dbQ(file, sql, params = []) { let db; try { db = new DatabaseSync(file); return db.prepare(sql).all(...params); } catch { return []; } finally { try { db?.close(); } catch {} } }
const productRow = (id) => dbQ(BIZ_DB, 'SELECT id, name, brand, sku, purchase_price, planned_sale_price, images FROM products WHERE id = ?', [id])[0] ?? null;
const linkRows = (id) => dbQ(BIZ_DB, 'SELECT link_id, media_id, sort_order, is_primary, deleted_at FROM media_links WHERE entity_id = ? ORDER BY link_id', [id]);
const activeLinks = (id) => linkRows(id).filter((l) => l.deleted_at === null).sort((a, b) => a.sort_order - b.sort_order);
const objectCount = () => dbQ(BIZ_DB, 'SELECT COUNT(*) c FROM media_objects WHERE deleted_at IS NULL')[0]?.c ?? -1;
function mediaFiles() {
  const out = []; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const q = join(p, e.name); if (e.isDirectory()) walk(q); else out.push(q); } }; walk(MEDIA_ROOT); return out.sort();
}
const inboxRows = () => dbQ(SERVER_DB, 'SELECT upload_event_id, state, error_code FROM mobile_upload_inbox');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
/**
 * Anmelden UND beweisen, dass das erhaltene Token wirklich gilt.
 *
 * Der eingebettete Server kann waehrend des Hochfahrens noch einmal neu starten (Datenwurzel,
 * Primary-Zustand). Faellt das zwischen Login und ersten Upload, ist das gerade ausgestellte Token
 * gegen ein neues Secret ungueltig und der erste Upload scheitert mit 401 — ohne dass die Seite
 * etwas falsch gemacht haette. Das ist eine VORBEDINGUNG des Tests, kein Ergebnis: hier wird sie
 * hergestellt und geprueft, statt sie zu hoffen. Kein blindes Wiederholen: hoechstens ein zweiter
 * Anlauf, und das Ergebnis wird zugesichert.
 */
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

async function startEdge(url) {
  edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, 'about:blank'], { stdio: 'ignore' });
  const end = Date.now() + 40000; let ws = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/list`)).json(); const pg = l.find((t) => t.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break; } } catch {} await sleep(300); }
  if (!ws) throw new Error('edge CDP did not come up');
  const c = new CDP(ws);
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('Network.enable');
  const uploads = [], consoleErrors = [], httpErrors = [];
  const phase = { name: 'boot' };
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (r && /\/api\/mobile\/upload$/.test(r.url) && r.postData) { try { uploads.push(JSON.parse(r.postData)); } catch { uploads.push({}); } }
    } else if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r && r.status >= 400 && !/favicon\.ico$/.test(r.url)) httpErrors.push({ status: r.status, url: String(r.url), phase: phase.name });
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception'));
    }
  });
  await c.send('Page.navigate', { url }); await sleep(1500);
  return { c, uploads, consoleErrors, httpErrors, phase };
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
/** Auf einen bestimmten Galerie-Zustand warten (Anzahl aktiver Links). */
async function waitLinks(id, want, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (activeLinks(id).length === want) return true; await sleep(1000); }
  return false;
}
/** Auf den ENDZUSTAND genau dieses Jobs warten — `ready` oder `quarantined`, nichts dazwischen. */
async function waitTerminal(eventId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = inboxRows().find((x) => x.upload_event_id === eventId);
    if (r && (r.state === 'ready' || r.state === 'quarantined')) return r;
    await sleep(1000);
  }
  return inboxRows().find((x) => x.upload_event_id === eventId) ?? null;
}
/** Die Ingress-Route antwortet auf eine angenommene Einreichung mit 2xx. */
const accepted = (status) => status >= 200 && status < 300;
/** Auf eine bestimmte Anzahl Kacheln im EDITOR warten (nicht im Create-Formular). */
async function waitStrip(c, n, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await stripCount(c) === n) return true; await sleep(200); } return false; }

// ── die Detailansicht des Fixture-Artikels frisch oeffnen ──────────────────
// Wichtig fuer S3: JEDES Oeffnen holt einen frischen `gallery_baseline`. Genau darauf beruht der
// Konfliktschutz — ein Bildschirm, der lange offen liegt, speichert nicht mit veralteter Sicht.
async function openFixture(edge, name) {
  await edge.ev(`const b=document.querySelector('.back'); if(b) b.click(); return 1;`);
  await sleep(400);
  if (!(await visE(edge, '#scanScreen'))) {
    await clickE(edge, '.mode-btn[data-mode="scan"]');
    await waitVisE(edge, '#scanScreen', 15000);
  }
  await clickE(edge, '#tabSearch'); await waitVisE(edge, '#searchPane', 10000);
  await setValE(edge, '#searchInput', name); await sleep(2500);
  await edge.ev(`const h=document.querySelector('#searchResults .card, #searchResults > div'); if(h) h.click(); return 1;`);
  await waitVisE(edge, '#scanResult', 15000);
  await waitE(edge, '#pdEditBtn', 10000);
  await clickE(edge, '#pdEditBtn');
  await waitVisE(edge, '#pdEditForm', 10000);
  await waitE(edge, '#peStrip', 10000);
}
const stripCount = (edge) => edge.ev(`return document.querySelectorAll('#peStrip .photo-thumb').length;`);
const coverIndex = (edge) => edge.ev(`const t=[...document.querySelectorAll('#peStrip .photo-thumb')]; return t.findIndex(x=>x.classList.contains('is-primary'));`);
/** Auf einer Kachel: das ✕ (letzter .rm ist ✕ bzw. ‹ — deshalb gezielt ueber den Text). */
/** Die Kacheln des Editors mit ihrer STABILEN Identitaet — Position allein waere zweideutig. */
const thumbLinks = (edge) => edge.ev(`return [...document.querySelectorAll('#peStrip .photo-thumb')].map(function(t){ return t.getAttribute('data-link') || ''; });`);
const indexOfLink = async (edge, linkId) => (await thumbLinks(edge)).indexOf(linkId);
const tapRemove = (edge, i) => edge.ev(`const t=document.querySelectorAll('#peStrip .photo-thumb')[${i}]; if(!t) return 'NO'; const b=[...t.querySelectorAll('button.rm')].find(x=>x.textContent==='✕'||x.textContent==='↺'); if(!b) return 'NOBTN'; b.click(); return 'OK';`);
const tapLeft = (edge, i) => edge.ev(`const t=document.querySelectorAll('#peStrip .photo-thumb')[${i}]; if(!t) return 'NO'; const b=[...t.querySelectorAll('button.rm')].find(x=>x.textContent==='‹'); if(!b) return 'NOBTN'; b.click(); return 'OK';`);
const tapThumb = (edge, i) => edge.ev(`const t=document.querySelectorAll('#peStrip .photo-thumb')[${i}]; if(!t) return 'NO'; t.click(); return 'OK';`);
async function saveEdit(edge) { await clickE(edge, '#peSave'); }

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');

  const paths = ['1', '3', '5', '7'].map((n, i) => { const p = join(RUN, `img${i}.jpg`); writeFileSync(p, Buffer.from(seed('jpeg', n), 'base64')); return p; });
  const extra = ['11', '13', '17', '19'].map((n, i) => { const p = join(RUN, `extra${i}.jpg`); writeFileSync(p, Buffer.from(seed('jpeg', n), 'base64')); return p; });

  const ws = await startApp(); const app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');
  await frontendLogin(app);

  const { c: edge, uploads, consoleErrors, httpErrors, phase } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLoginVerified(edge);

  // ── Fixture: EIN Artikel mit VIER Bildern, ueber den echten Create-Pfad ──
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');
  await setValE(edge, '#cCategory', 'cat-watch'); await sleep(500);
  await setValE(edge, '#cBrand', 'Rolex'); await setValE(edge, '#cName', 'Gallery Fixture');
  await setValE(edge, '#cCondition', 'Pre-Owned');
  await setValE(edge, '#attr_dial', 'Black'); await setValE(edge, '#attr_material', 'Steel');
  await setFiles(edge, '#cPhotoInput', paths); await waitVisE(edge, '#cPhotoStrip', 10000);
  // Auf ALLE vier Kacheln warten, nicht nur auf den sichtbaren Streifen: die Seite skaliert jedes
  // Foto einzeln, und ein Save mitten in dieser Verarbeitung waere ein Rennen, kein Test.
  ok(await waitThumbs(edge, 4, 20000), `fixture: all four photos are prepared (${await thumbCount(edge)})`);
  ok(await clickE(edge, '#cSaveBtn') === 'OK', 'fixture: the save button clicks');
  const drained = await waitReady(app, 1, 120000);
  if (!drained) {
    console.log('DIAG inbox=' + JSON.stringify(inboxRows()));
    console.log('DIAG cError=' + (await textE(edge, '#cError')) + ' cSuccess=' + (await textE(edge, '#cSuccess')));
    console.log('DIAG uploads=' + uploads.length + ' exc=' + JSON.stringify(consoleErrors.slice(0, 3)) + ' http=' + JSON.stringify(httpErrors.slice(0, 5)));
  }
  ok(drained, 'fixture: the four-photo upload drained');
  await sleep(2000);

  const pid = dbQ(BIZ_DB, "SELECT id, sku FROM products WHERE name = 'Gallery Fixture'")[0];
  ok(!!pid, 'fixture: the product exists');
  if (!pid) throw new Error('fixture product missing');
  const base4 = activeLinks(pid.id);
  ok(base4.length === 4, `fixture: four active links (${base4.length})`);
  const productBefore = productRow(pid.id);
  const objectsAtStart = objectCount();

  const token = await serverLogin();
  const read0 = await readProduct(token, pid.sku);
  ok(read0 && read0.gallery_ok === true, `S3 the read contract reports the gallery as really read (${read0?.gallery_ok})`);
  ok(/^[0-9a-f]{64}$/.test(String(read0.gallery_baseline)), 'S3 …with a real baseline');

  // ════════════════════════════════════════════════════════════════════════
  // §19 CANCEL — markieren, hinzufuegen, umsortieren, dann verwerfen
  // ════════════════════════════════════════════════════════════════════════
  phase.name = 'cancel';
  await openFixture(edge, 'Gallery Fixture');
  ok(await stripCount(edge) === 4, `CANCEL the editor shows all four existing photos (${await stripCount(edge)})`);
  ok(await coverIndex(edge) === 0, 'CANCEL the first one is marked as cover');
  const uploadsBeforeCancel = uploads.length;
  const linksBeforeCancel = linkRows(pid.id);
  await tapRemove(edge, 2);                                   // C zum Entfernen markieren
  await setFiles(edge, '#peAddInput', [extra[0]]); await sleep(1200);
  await tapThumb(edge, 4);                                    // das neue Bild zum Cover machen
  ok(await stripCount(edge) === 5, `CANCEL the pending state is visible (${await stripCount(edge)})`);
  await clickE(edge, '#peCancel'); await sleep(1500);
  ok(uploads.length === uploadsBeforeCancel, `CANCEL not one request was sent (${uploads.length - uploadsBeforeCancel})`);
  ok(same(linkRows(pid.id), linksBeforeCancel), 'CANCEL every media_links row is byte-identical');
  ok(same(productRow(pid.id), productBefore), 'CANCEL the product row is untouched');
  ok(inboxRows().length === 1, `CANCEL no upload job was created (${inboxRows().length})`);

  // ════════════════════════════════════════════════════════════════════════
  // §22.2 ADD — vier bestehende + zwei neue
  // ════════════════════════════════════════════════════════════════════════
  phase.name = 'add';
  let ready = 1;                       // der Fixture-Create ist der erste fertige Job
  await openFixture(edge, 'Gallery Fixture');
  await setFiles(edge, '#peAddInput', [extra[0], extra[1]]);
  ok(await waitStrip(edge, 6, 20000), `ADD six thumbnails before saving (${await stripCount(edge)})`);
  await saveEdit(edge);
  // Auf den FERTIGEN Job warten, nicht auf eine Zahl: ein Zaehler, der sich nicht aendert (etwa bei
  // "eines raus, eines rein"), waere sofort erfuellt und wuerde vor der Anwendung weitermessen.
  ok(await waitReady(app, ++ready, 120000), `ADD the save drained (inbox ${JSON.stringify(inboxRows())})`);
  ok(activeLinks(pid.id).length === 6, `ADD the gallery holds six images (${activeLinks(pid.id).length})`);
  const after6 = activeLinks(pid.id);
  ok(same(after6.slice(0, 4).map((l) => [l.link_id, l.media_id, l.sort_order]), base4.map((l) => [l.link_id, l.media_id, l.sort_order])),
    'ADD the four old links keep their ids, media and positions');
  ok(new Set(after6.map((l) => l.media_id)).size === 6, 'ADD six distinct media');
  ok(after6[0].is_primary === 1 && after6[0].link_id === base4[0].link_id, 'ADD the old cover is still the cover');
  ok(after6.filter((l) => l.is_primary === 1).length === 1, 'ADD exactly one primary');
  ok(linkRows(pid.id).filter((l) => l.deleted_at !== null).length === 0, 'ADD not one existing link was retired');
  ok(same(productRow(pid.id), productBefore), 'ADD the product row (sku, prices, name) is untouched');

  // ════════════════════════════════════════════════════════════════════════
  // §22.3 REMOVE — ein bestimmtes bestehendes Bild
  // ════════════════════════════════════════════════════════════════════════
  phase.name = 'remove';
  await openFixture(edge, 'Gallery Fixture');
  // Das Opfer wird ueber seine STABILE Identitaet gewaehlt, nicht ueber eine Position — sonst
  // koennte der Test das Falsche entfernen und es nicht merken.
  const victim = activeLinks(pid.id)[2];
  const vIdx = await indexOfLink(edge, victim.link_id);
  ok(vIdx >= 0, `REMOVE the chosen image is on screen (index ${vIdx})`);
  await tapRemove(edge, vIdx);
  await saveEdit(edge);
  ok(await waitReady(app, ++ready, 120000), `REMOVE the save drained (inbox ${JSON.stringify(inboxRows())})`);
  ok(activeLinks(pid.id).length === 5, `REMOVE five images remain (${activeLinks(pid.id).length})`);
  const after5 = activeLinks(pid.id);
  ok(!after5.some((l) => l.link_id === victim.link_id), 'REMOVE the chosen link is gone from the active gallery');
  ok(same(after5.map((l) => l.media_id), after6.filter((l) => l.link_id !== victim.link_id).map((l) => l.media_id)),
    'REMOVE exactly the other five remain, in their order');
  const retired = linkRows(pid.id).filter((l) => l.deleted_at !== null);
  ok(retired.length === 1 && retired[0].link_id === victim.link_id, `REMOVE exactly one link was retired (${retired.length})`);
  ok(objectCount() === objectsAtStart + 2, `REMOVE the media object itself is untouched — cleanup is the GC's job (${objectCount()} vs ${objectsAtStart + 2})`);

  // ════════════════════════════════════════════════════════════════════════
  // §22.5/§22.6 REORDER + PRIMARY — tap macht zum Cover, ‹ schiebt nach links
  // ════════════════════════════════════════════════════════════════════════
  phase.name = 'reorder';
  await openFixture(edge, 'Gallery Fixture');
  const before5 = activeLinks(pid.id);
  const wantFirst = before5[3].link_id;
  const rIdx = await indexOfLink(edge, wantFirst);
  ok(rIdx > 0, `REORDER the image to promote is on screen and not already first (index ${rIdx})`);
  await tapThumb(edge, rIdx);
  ok(await coverIndex(edge) === 0, 'REORDER the tapped photo moved to the front');
  await saveEdit(edge);
  ok(await waitReady(app, ++ready, 120000), `REORDER the save drained (inbox ${JSON.stringify(inboxRows())})`);
  const afterOrder = activeLinks(pid.id);
  ok(afterOrder[0].link_id === wantFirst, `REORDER the chosen image really is first (${afterOrder[0].link_id === wantFirst})`);
  ok(afterOrder[0].is_primary === 1, 'REORDER …and it is the primary');
  ok(afterOrder.filter((l) => l.is_primary === 1).length === 1, 'REORDER exactly one primary');
  ok(afterOrder.length === 5, `REORDER still five images (${afterOrder.length})`);
  ok(same(afterOrder.map((l) => l.media_id).sort(), before5.map((l) => l.media_id).sort()), 'REORDER not one media identity changed');
  ok(same(afterOrder.map((l) => l.link_id).sort(), before5.map((l) => l.link_id).sort()), 'REORDER and not one link id changed');

  // ════════════════════════════════════════════════════════════════════════
  // §22.4 ADD + REMOVE in EINEM Save
  // ════════════════════════════════════════════════════════════════════════
  phase.name = 'add-remove';
  await openFixture(edge, 'Gallery Fixture');
  const before5b = activeLinks(pid.id);
  const victim2 = before5b[1];
  const v2Idx = await indexOfLink(edge, victim2.link_id);
  ok(v2Idx >= 0, `ADD+REMOVE the image to drop is on screen (index ${v2Idx})`);
  await tapRemove(edge, v2Idx);
  await setFiles(edge, '#peAddInput', [extra[2]]);
  ok(await waitStrip(edge, 6, 20000), `ADD+REMOVE five kept plus one new are staged (${await stripCount(edge)})`);
  await saveEdit(edge);
  // Hier waere ein Zaehler wertlos: fuenf bleiben fuenf. Der fertige Job ist das einzige ehrliche Signal.
  ok(await waitReady(app, ++ready, 120000), `ADD+REMOVE the save drained (inbox ${JSON.stringify(inboxRows())})`);
  ok(activeLinks(pid.id).length === 5, `ADD+REMOVE five images (four kept + one new) (${activeLinks(pid.id).length})`);
  const afterBoth = activeLinks(pid.id);
  ok(!afterBoth.some((l) => l.link_id === victim2.link_id), 'ADD+REMOVE the removed one is gone');
  ok(before5b.filter((l) => l.link_id !== victim2.link_id).every((l) => afterBoth.some((a) => a.link_id === l.link_id)),
    'ADD+REMOVE every kept link survived with its exact id');
  ok(new Set(afterBoth.map((l) => l.media_id)).size === 5, 'ADD+REMOVE the new image appears exactly once');
  ok(afterBoth.filter((l) => l.is_primary === 1).length === 1, 'ADD+REMOVE exactly one primary');

  // ════════════════════════════════════════════════════════════════════════
  // §22.15 GALLERY READ FAILURE → fail closed (direkt am Vertrag)
  // ════════════════════════════════════════════════════════════════════════
  phase.name = 'contract';
  const post = (metadata, images = [], eventId) => fetch(`${BASE}/api/mobile/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ mode: 'collection', upload_event_id: eventId ?? ('ev-' + Math.random().toString(36).slice(2)), entity_id: 'ent-' + Math.random().toString(36).slice(2), protocol_version: 2, metadata, images }),
  });
  const cur = activeLinks(pid.id);
  const curBase = (await readProduct(token, pid.sku)).gallery_baseline;
  const snapshot = linkRows(pid.id);

  // Ein Plan, der ein bestehendes Bild einfach weglaesst — muss abgewiesen werden, nicht loeschen.
  const omitEv = 'ev-omit-' + Math.random().toString(36).slice(2);
  const omit = await post({ kind: 'gallery_edit', productId: pid.id, galleryBaseline: curBase, order: cur.slice(0, 3).map((l) => ({ keep: l.link_id })), remove: [] }, [], omitEv);
  ok(accepted(omit.status), `OMIT the plan is accepted for processing (${omit.status})`);
  const omitJob = await waitTerminal(omitEv, 60000);
  ok(omitJob?.state === 'quarantined' && omitJob?.error_code === 'MOBILE_GALLERY_PLAN_INCOMPLETE',
    `OMIT the job is quarantined, not retried forever (${omitJob?.state}/${omitJob?.error_code})`);
  ok(same(linkRows(pid.id), snapshot), 'OMIT a plan that silently drops an image changes nothing');
  ok(activeLinks(pid.id).length === 5, `OMIT all five images are still there (${activeLinks(pid.id).length})`);

  // Ein ueberholter Baseline — der Artikel hat sich geaendert, seit das Handy ihn gelesen hat.
  const staleEv = 'ev-stale-' + Math.random().toString(36).slice(2);
  const stale = await post({ kind: 'gallery_edit', productId: pid.id, galleryBaseline: 'f'.repeat(64), order: cur.map((l) => ({ keep: l.link_id })), remove: [] }, [], staleEv);
  ok(accepted(stale.status), `STALE a well-formed but stale plan is accepted for processing (${stale.status})`);
  const staleJob = await waitTerminal(staleEv, 60000);
  ok(staleJob?.state === 'quarantined' && staleJob?.error_code === 'MOBILE_GALLERY_BASELINE_CHANGED',
    `STALE the job ends as a conflict, terminal (${staleJob?.state}/${staleJob?.error_code})`);
  ok(same(linkRows(pid.id), snapshot), 'STALE nothing was applied');

  // Formfehler werden schon an der Grenze abgewiesen — kein Job entsteht.
  const inboxBefore = inboxRows().length;
  const rejects = [
    ['no baseline', { kind: 'gallery_edit', productId: pid.id, order: [{ keep: cur[0].link_id }], remove: [] }],
    ['keep and remove the same link', { kind: 'gallery_edit', productId: pid.id, galleryBaseline: curBase, order: [{ keep: cur[0].link_id }], remove: [cur[0].link_id] }],
    ['an empty plan', { kind: 'gallery_edit', productId: pid.id, galleryBaseline: curBase, order: [], remove: [] }],
    ['a ninth image', { kind: 'gallery_edit', productId: pid.id, galleryBaseline: curBase, order: Array.from({ length: 9 }, (_, i) => ({ keep: 'l' + i })), remove: [] }],
  ];
  for (const [what, meta] of rejects) {
    const r = await post(meta);
    ok(r.status === 422, `REJECT ${what} is refused at the boundary (${r.status})`);
  }
  ok(inboxRows().length === inboxBefore, `REJECT not one of them created a job (${inboxRows().length} vs ${inboxBefore})`);
  ok(same(linkRows(pid.id), snapshot), 'REJECT and the gallery is untouched by all of them');

  // §22.12 REPLAY — derselbe Event noch einmal
  phase.name = 'replay';
  const evId = 'ev-replay-' + Math.random().toString(36).slice(2);
  const body = { mode: 'collection', upload_event_id: evId, entity_id: 'ent-replay', protocol_version: 2, images: [], metadata: { kind: 'gallery_edit', productId: pid.id, galleryBaseline: curBase, order: cur.slice(1).map((l) => ({ keep: l.link_id })), remove: [cur[0].link_id] } };
  const first = await fetch(`${BASE}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  ok(accepted(first.status), `REPLAY the first send is accepted (${first.status})`);
  const firstJob = await waitTerminal(evId, 120000);
  ok(firstJob?.state === 'ready', `REPLAY it was applied (${firstJob?.state}/${firstJob?.error_code})`);
  ok(activeLinks(pid.id).length === 4, `REPLAY four images left (${activeLinks(pid.id).length})`);
  const afterReplay1 = linkRows(pid.id);
  const second = await fetch(`${BASE}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const secondBody = await second.json().catch(() => ({}));
  ok(accepted(second.status) && secondBody.state === 'replay', `REPLAY the same event comes back as a replay (${second.status}/${secondBody.state})`);
  await sleep(6000);
  ok(same(linkRows(pid.id), afterReplay1), 'REPLAY not one row changed on the second send');
  ok(activeLinks(pid.id).length === 4, 'REPLAY still four — no duplicate link');
  ok(inboxRows().filter((r) => r.upload_event_id === evId).length === 1, 'REPLAY exactly one inbox row for that event');

  // ── Abschluss ────────────────────────────────────────────────────────────
  ok(inboxRows().every((r) => r.state === 'ready' || r.state === 'quarantined'), `no stranded upload job (${JSON.stringify(inboxRows())})`);
  ok(same(productRow(pid.id), productBefore), 'through every gallery change the product row never moved');
  ok(mediaFiles().length > 0, 'the media files are still on disk');
  ok(consoleErrors.length === 0, `no uncaught page exception (${consoleErrors.slice(0, 2).join(' | ')})`);
  const unexpected = httpErrors.filter((h) => !(h.status === 422 && h.phase === 'contract'));
  ok(unexpected.length === 0, `no unexpected HTTP error (${unexpected.slice(0, 3).map((h) => `${h.status} ${h.phase}`).join(' | ')})`);
  void textE; void waitLinks;

  edge.closeWs(); killEdge(); app.closeWs(); killApp();
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killEdge(); killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    console.log(`\nMOBILE gallery edit S3: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
