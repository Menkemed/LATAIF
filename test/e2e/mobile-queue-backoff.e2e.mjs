// MOBILE-QUEUE — Wartezeit + nicht blockierende Auswahl, an einer echten isolierten App.
// Run: node test/e2e/mobile-queue-backoff.e2e.mjs
//
//   A (Galerie-Edit, Artikel A) scheitert voruebergehend: seine zwischengespeicherte Bilddatei ist von einem
//   anderen Prozess gesperrt (wie durch eine Sicherung oder einen Virenscanner). A wird zurueckgestellt, nicht
//   quarantaeniert. B (Artikel B) laeuft trotzdem durch; A2 (zweiter Auftrag fuer Artikel A) ueberholt A nicht.
//   Ein Neustart der App verliert Zaehler und Wartezeit nicht. Nach Freigabe der Sperre laeuft A, danach A2.
//
// Isoliert: e2e-Identitaet com.lataif.app.e2e, eigenes AppData, Sync-Port 3011. Produktion (3001/3443) und
// E:\LATAIF\Data werden nie beruehrt; beendet wird nur, was dieser Lauf selbst gestartet hat.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killOwnChild, killTestImage, killTestPid } from './_e2e-process.mjs';
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

const RUN = join(os.tmpdir(), 'lataif-retryqueue-e2e', 'run-' + Date.now());
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
function killApp() { try { killTestPid(appProc.pid); } catch {} }
function killAllApp() { try { killTestImage('lataif.exe'); } catch {} }
function killEdge() { try { killOwnChild(edgeProc); } catch {} }
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
// ════════════════════════════════════════════════════════════════════════════
const retryRow = (ev) => dbQ(SERVER_DB, 'SELECT attempt_count, next_attempt_at, last_error_code FROM mobile_upload_retry WHERE upload_event_id = ?', [ev])[0] ?? null;
const job = (ev) => dbQ(SERVER_DB, 'SELECT upload_event_id, state, error_code, updated_at FROM mobile_upload_inbox WHERE upload_event_id = ?', [ev])[0] ?? null;
const notesOf = (id) => dbQ(BIZ_DB, 'SELECT notes FROM products WHERE id = ?', [id])[0]?.notes ?? null;
async function post(token, body) {
  const r = await fetch(`${BASE}/api/mobile/upload`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ protocol_version: 2, mode: 'collection', ...body }) });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, json: j };
}
async function waitJob(ev, states, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const j = job(ev); if (j && states.includes(j.state)) return j; await sleep(500); }
  return job(ev);
}
function findStaged(key) {
  const base = key.split(/[\\/]/).pop();
  const out = []; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else if (e.name === base) out.push(q); } };
  walk(join(APP_DATA_DIR, 'mobile-upload-staging')); return out[0] ?? null;
}
// Ein fremder Prozess (wie eine Sicherung oder ein Virenscanner) sperrt die Datei exklusiv.
let lockProc = null;
async function lockFile(path) {
  const flag = join(RUN, 'lock-held.txt'), release = join(RUN, 'lock-release.txt');
  rmSync(flag, { force: true }); rmSync(release, { force: true });
  const ps = `$f=[System.IO.File]::Open('${path.replace(/'/g, "''")}','Open','Read','None'); Set-Content -Path '${flag}' -Value 'held'; while(-not (Test-Path '${release}')){ Start-Sleep -Milliseconds 100 }; $f.Close()`;
  lockProc = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  const end = Date.now() + 15000; while (Date.now() < end && !existsSync(flag)) await sleep(50);
  return existsSync(flag);
}
async function unlockFile() {
  writeFileSync(join(RUN, 'lock-release.txt'), 'go');
  const end = Date.now() + 10000; while (Date.now() < end && lockProc && lockProc.exitCode === null) await sleep(100);
  try { if (lockProc && lockProc.exitCode === null) killOwnChild(lockProc); } catch {}
}
// Abmelden wie der Logout-Knopf: nur die Sitzung entfernen (der Drain-Poller laeuft nur angemeldet).
const desktopLogout = async (app) => { await app.ev("localStorage.removeItem('lataif_session'); location.reload(); return 1;").catch(() => {}); await sleep(3500); };
// Wieder anmelden (nach Abmelden/Neustart): der Anmeldebildschirm hat ggf. nur das Passwortfeld.
async function desktopSignIn(app) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    if (await existsApp(app, 'a[href="/settings"]')) return;
    if (await existsApp(app, 'input[type="password"]')) break;
    await sleep(400);
  }
  if (await existsApp(app, 'a[href="/settings"]')) return;
  if (await existsApp(app, 'input[type="email"]')) await setValApp(app, 'input[type="email"]', OWNER_EMAIL);
  await setValApp(app, 'input[type="password"]', ONBOARD_PW);
  await app.ev("const b=document.querySelector('button[type=submit]') || [...document.querySelectorAll('button')].find(x=>/sign in|log ?in|anmelden/i.test(x.textContent)); if(b) b.click(); return 1;");
  await waitApp(app, 'a[href="/settings"]', 60000);
}
const iso = (s) => Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));

async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');
  const b64 = ['1', '3', '5', '7'].map((n) => seed('jpeg', n));

  let ws = await startApp(); let app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');
  await frontendLogin(app);
  const token = await serverLogin();

  // ── Fixture: zwei Artikel A und B, ueber den echten Upload-Weg angelegt ──
  const create = (ev, entity, name, img) => post(token, { upload_event_id: ev, entity_id: entity,
    metadata: { categoryId: 'cat-watch', brand: 'Rolex', name, condition: 'Pre-Owned', attributes: { dial: 'Black', material: 'Steel' } },
    images: [{ mime: 'image/jpeg', data_base64: img }] });
  const PA = 'e2e-prod-A-' + Date.now(), PB = 'e2e-prod-B-' + Date.now();
  ok((await create('ev-create-A', PA, 'Queue A', b64[0])).status < 300 && (await create('ev-create-B', PB, 'Queue B', b64[1])).status < 300, 'fixture: two creates accepted');
  const ca = await waitJob('ev-create-A', ['ready', 'quarantined'], 120000), cb = await waitJob('ev-create-B', ['ready', 'quarantined'], 120000);
  ok(ca?.state === 'ready' && cb?.state === 'ready', `fixture: both articles exist (${ca?.state}, ${cb?.state})`);
  await sleep(1500);
  const skuA = dbQ(BIZ_DB, 'SELECT sku FROM products WHERE id = ?', [PA])[0]?.sku;
  const readA = await readProduct(token, skuA);
  ok(readA?.gallery_ok === true && Array.isArray(readA.gallery) && readA.gallery.length === 1, 'fixture: article A has one photo and a readable gallery');

  // ── 1 A wird eingestellt, waehrend der Desktop abgemeldet ist; die Bilddatei wird gesperrt ──
  await desktopLogout(app);
  const pa = await post(token, { upload_event_id: 'ev-A', entity_id: 'job-ev-A', images: [{ mime: 'image/jpeg', data_base64: b64[2] }],
    metadata: { kind: 'gallery_edit', productId: PA, galleryBaseline: readA.gallery_baseline, order: [{ keep: readA.gallery[0].link_id }, { new: 0 }], remove: [] } });
  ok(pa.status < 300 && job('ev-A')?.state === 'accepted', `STEP1 job A accepted (${pa.status})`);
  const key = dbQ(SERVER_DB, "SELECT storage_key FROM mobile_upload_image WHERE upload_event_id = 'ev-A'")[0]?.storage_key;
  const staged = key ? findStaged(key) : null;
  ok(!!staged && await lockFile(staged), `STEP1 another process holds an exclusive lock on A's staged image (${staged ? 'locked' : 'not found'})`);
  await desktopSignIn(app);                                   // the desktop comes back → its drain runs
  const end1 = Date.now() + 60000; while (Date.now() < end1 && !retryRow('ev-A')) await sleep(500);
  const r1 = retryRow('ev-A');
  ok(job('ev-A')?.state === 'accepted' && r1?.attempt_count >= 1 && r1?.last_error_code === 'MOBILE_UPLOAD_STAGING_BUSY',
    `STEP1 A failed transiently: still accepted, attempt ${r1?.attempt_count}, last error ${r1?.last_error_code} — not quarantined`);
  ok(r1 && iso(r1.next_attempt_at) > Date.now(), `STEP1 next_attempt_at is in the future (${r1?.next_attempt_at})`);

  // ── 1b Neustart der App: Zaehler und Wartezeit bleiben ──
  app.closeWs(); killApp(); await waitPortFree(PORT, 20000);
  ws = await startApp(); app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  await desktopSignIn(app);
  const r1b = retryRow('ev-A');
  ok(r1b && r1b.attempt_count >= r1.attempt_count && job('ev-A')?.state === 'accepted', `RESTART counter and wait survived (attempt ${r1.attempt_count} → ${r1b?.attempt_count}, ${job('ev-A')?.state})`);
  const token2 = await serverLogin();

  // ── 2/3 B wird eingestellt und laeuft durch, obwohl A noch wartet ──
  const pb = await post(token2, { upload_event_id: 'ev-B', entity_id: 'job-ev-B', images: [], metadata: { kind: 'text_edit', productId: PB, patch: { notes: 'B independent' } } });
  ok(pb.status < 300, `STEP2 job B accepted (${pb.status})`);
  // ── 6 A2 (zweiter Auftrag fuer Artikel A) wird DAZWISCHEN eingestellt ──
  const pa2 = await post(token2, { upload_event_id: 'ev-A2', entity_id: 'job-ev-A2', images: [], metadata: { kind: 'text_edit', productId: PA, patch: { notes: 'A2 after A' } } });
  ok(pa2.status < 300, `STEP6 job A2 for the same article accepted (${pa2.status})`);
  const jb = await waitJob('ev-B', ['ready', 'quarantined'], 60000);
  const rWhileB = retryRow('ev-A');
  ok(jb?.state === 'ready' && notesOf(PB) === 'B independent', `STEP3 B was processed (${jb?.state}, notes "${notesOf(PB)}")`);
  ok(job('ev-A')?.state === 'accepted' && rWhileB && iso(rWhileB.next_attempt_at) > iso(jb.updated_at) - 1000,
    `STEP3 …while A was still waiting for its retry (A ${job('ev-A')?.state}, next ${rWhileB?.next_attempt_at}, B done ${jb?.updated_at})`);
  await sleep(16000);                                         // at least one more poll with A still locked
  ok(job('ev-A2')?.state === 'accepted' && notesOf(PA) !== 'A2 after A', `STEP6 A2 does not overtake A (A2 ${job('ev-A2')?.state}, A ${job('ev-A')?.state})`);

  // ── 4/5 Ursache entfernt: A laeuft nach Ablauf der Wartezeit, danach A2 ──
  await unlockFile();
  const ja = await waitJob('ev-A', ['ready', 'quarantined'], 200000);
  const ja2 = await waitJob('ev-A2', ['ready', 'quarantined'], 60000);
  const rFinal = retryRow('ev-A');
  ok(ja?.state === 'ready', `STEP5 A was processed successfully after the wait (${ja?.state}; attempts ${rFinal?.attempt_count}, last ${rFinal?.last_error_code})`);
  ok(activeLinks(PA).length === 2, `STEP5 A's gallery now holds the kept photo plus the new one (${activeLinks(PA).length})`);
  ok(ja2?.state === 'ready' && notesOf(PA) === 'A2 after A' && iso(ja2.updated_at) >= iso(ja.updated_at), `STEP6 A2 ran only after A (A ${ja?.updated_at}, A2 ${ja2?.updated_at})`);
  ok(inboxRows().every((r) => r.state === 'ready'), `QUEUE nothing stuck, nothing quarantined (${JSON.stringify(inboxRows().map((r) => r.state))})`);

  app.closeWs(); killApp();
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    try { if (lockProc && lockProc.exitCode === null) { writeFileSync(join(RUN, 'lock-release.txt'), 'go'); await sleep(500); killOwnChild(lockProc); } } catch {}
    killEdge(); killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    console.log(`\nMOBILE-QUEUE retry backoff (real app): ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
