// MOBILE-QUEUE — der hängende Handy-Auftrag aus dem Echtbetrieb (CAR-OGJ-001), durch die echte /mobile-Seite.
// Run: node test/e2e/mobile-edit-queue.e2e.mjs
//
//   1. Bild ersetzen + Jahr leeren + Einkaufspreis leeren am Handy → klare Meldung, KEIN Auftrag, nichts geändert.
//   2. Derselbe Auftrag direkt an den Server (alte, nicht neu geladene Seite) → 422 mit festem Code, kein Queue-Eintrag.
//   3. Danach eine gültige Änderung (Einkaufspreis 0, Jahr leer, neues Bild) → wird übernommen, und das Handy meldet
//      „Saved“ statt der Warnung „not applied yet“ (Wartezeit 40 s bei 15-s-Abholen; die Zeit wird gemessen).
//
// Isoliert: e2e-Identität com.lataif.app.e2e, eigenes AppData, Sync-Port 3011. Produktion (3001/3443) und
// E:\LATAIF\Data werden nie berührt; beendet wird nur, was dieser Lauf selbst gestartet hat.
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

const RUN = join(os.tmpdir(), 'lataif-editqueue-e2e', 'run-' + Date.now());
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
const peMsg = (edge) => edge.ev(`const e=document.querySelector('#peMsg'); return e ? e.textContent.trim() : '';`);
const attrsOf = (id) => { try { return JSON.parse(dbQ(BIZ_DB, 'SELECT attributes FROM products WHERE id = ?', [id])[0]?.attributes || '{}'); } catch { return {}; } };

async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded as Primary');
  const b64 = ['1', '3', '5'].map((n) => seed('jpeg', n));
  const paths = b64.map((b, i) => { const p = join(RUN, `img${i}.jpg`); writeFileSync(p, Buffer.from(b, 'base64')); return p; });

  const ws = await startApp(); const app = new CDP(ws); await waitInvoke(app); await waitHealthy();
  const cfg = await invoke(app, 'mobile_runtime_scope_configure', { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: BRANCH });
  ok(cfg.ok && cfg.value?.configured === true, 'owner configured runtime binding');
  await frontendLogin(app);

  const { c: edge, uploads, consoleErrors, phase } = await startEdge(`${BASE}/mobile`);
  await waitE(edge, '#loginBtn', 20000); await mobileLoginVerified(edge);

  // ── Fixture: ein Original-Goldschmuck wie CAR-OGJ-001 — Einkaufspreis 1650, Jahr 2024, ein Foto ──
  phase.name = 'fixture';
  await clickE(edge, '.mode-btn[data-mode="collection"]'); await waitVisE(edge, '#formCollection');
  await setValE(edge, '#cCategory', 'cat-original-gold-jewelry'); await sleep(600);
  await setValE(edge, '#cBrand', 'Cartier'); await setValE(edge, '#cName', 'Love Queue');
  await setValE(edge, '#cCondition', 'Pre-Owned');
  await setValE(edge, '#attr_item_type', 'Bangle'); await setValE(edge, '#attr_karat', '18K Yellow');
  await setValE(edge, '#attr_year', '2024'); await setValE(edge, '#cPurchasePrice', '1650');
  await setFiles(edge, '#cPhotoInput', [paths[0]]);
  ok(await waitThumbs(edge, 1, 20000), 'fixture: one photo prepared');
  await clickE(edge, '#cSaveBtn');
  const drained = await waitReady(app, 1, 120000);
  if (!drained) console.log('DIAG cError=' + (await textE(edge, '#cError')) + ' inbox=' + JSON.stringify(inboxRows()));
  ok(drained, 'fixture: the item was created through the real phone path');
  await sleep(1500);
  const pid = dbQ(BIZ_DB, "SELECT id, sku FROM products WHERE name = 'Love Queue'")[0];
  if (!pid) throw new Error('fixture product missing');
  const before = productRow(pid.id), linksBefore = linkRows(pid.id);
  ok(Number(before.purchase_price) === 1650 && attrsOf(pid.id).year === 2024 && activeLinks(pid.id).length === 1,
    `fixture: purchase price 1650, year 2024, one photo (${before.purchase_price} / ${attrsOf(pid.id).year} / ${activeLinks(pid.id).length})`);

  // ── 1 Der Fall aus dem Echtbetrieb am Handy: klare Ablehnung, kein Auftrag ─────────
  phase.name = 'repro';
  await openFixture(edge, 'Love Queue');
  const oldLink = (await thumbLinks(edge))[0];
  await setFiles(edge, '#peAddInput', [paths[1]]); ok(await waitStrip(edge, 2, 20000), 'REPRO the new photo is staged');
  await tapRemove(edge, 0);
  await setValE(edge, '#pea_year', ''); await setValE(edge, '#pePurchasePrice', '');
  const upBefore = uploads.length, inboxBefore = inboxRows().length;
  await saveEdit(edge); await sleep(2500);
  ok(/Purchase price cannot be empty — enter 0 if there is no cost\./.test(await peMsg(edge)), `REPRO the phone refuses with the "enter 0" hint (${await peMsg(edge)})`);
  ok(uploads.length === upBefore && inboxRows().length === inboxBefore, `REPRO no request, no queue entry (${uploads.length - upBefore} / ${inboxRows().length - inboxBefore})`);
  ok(same(productRow(pid.id), before) && same(linkRows(pid.id), linksBefore) && attrsOf(pid.id).year === 2024,
    'REPRO nothing changed — no photo, no year, no price (no partial apply)');

  // ── 2 Derselbe Auftrag direkt an den Server (z. B. alte, nicht neu geladene Seite) ─
  phase.name = 'server';
  const token = await serverLogin();
  const read = await readProduct(token, pid.sku);
  const direct = await fetch(`${BASE}/api/mobile/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ protocol_version: 2, upload_event_id: 'e2e-stuck-' + Date.now(), entity_id: 'e2e-stuck-entity-' + Date.now(), mode: 'collection',
      metadata: { kind: 'gallery_edit', productId: pid.id, galleryBaseline: read.gallery_baseline, order: [{ new: 0 }], remove: [oldLink],
        patch: { attributes: { year: null }, purchasePrice: null } },
      images: [{ mime: 'image/jpeg', data_base64: b64[1] }] }),
  });
  let body = null; try { body = await direct.json(); } catch { body = null; }
  ok(direct.status === 422 && body?.code === 'MOBILE_EDIT_PURCHASE_PRICE_REQUIRED', `SERVER refuses with 422 and a stable code (${direct.status} ${body?.code})`);
  ok(inboxRows().length === inboxBefore, `SERVER the command never enters the queue (${inboxRows().length - inboxBefore})`);

  // ── 3 Danach eine gültige Änderung: wird übernommen, das Handy meldet „Saved“ ─────
  phase.name = 'valid';
  await openFixture(edge, 'Love Queue');
  await setFiles(edge, '#peAddInput', [paths[2]]); ok(await waitStrip(edge, 2, 20000), 'VALID the new photo is staged');
  await tapRemove(edge, 0);
  await setValE(edge, '#pea_year', ''); await setValE(edge, '#pePurchasePrice', '0');
  const t0 = Date.now();
  await saveEdit(edge);
  let appliedAt = 0, msgAt = 0, msg = '';
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (!appliedAt && inboxRows().filter((r) => r.state === 'ready').length >= 2) appliedAt = Date.now();
    const saved = await edge.ev(`return [...document.querySelectorAll('#scanDetails div')].map(d=>d.textContent.trim()).find(t=>/^Saved — the photos above are the current state|^Saved\\.$/.test(t)) || '';`);
    msg = await peMsg(edge);
    if (saved || /not applied yet/.test(msg)) { msgAt = Date.now(); msg = saved || msg; break; }
    await sleep(500);
  }
  const tApply = appliedAt ? Math.round((appliedAt - t0) / 1000) : -1, tMsg = msgAt ? Math.round((msgAt - t0) / 1000) : -1;
  console.log(`      timing: desktop applied after ~${tApply}s, phone answered after ~${tMsg}s: "${msg}"`);
  ok(/^Saved — the photos above|^Saved\.$/.test(msg) && !/not applied yet/.test(msg), `VALID the phone confirms instead of warning (${msg})`);
  const after = productRow(pid.id), act = activeLinks(pid.id);
  ok(Number(after.purchase_price) === 0 && attrsOf(pid.id).year === undefined, `VALID price 0 and year cleared were applied (${after.purchase_price} / ${attrsOf(pid.id).year})`);
  ok(act.length === 1 && act[0].link_id !== oldLink && !!linkRows(pid.id).find((l) => l.link_id === oldLink)?.deleted_at, 'VALID exactly one photo: the new one; the old one retired');
  ok(inboxRows().every((r) => r.state === 'ready'), `VALID every queue entry is ready, nothing stuck (${JSON.stringify(inboxRows().map((r) => r.state))})`);

  ok(consoleErrors.length === 0, `no uncaught page exception (${consoleErrors.slice(0, 2).join(' | ')})`);
  edge.closeWs(); killEdge(); app.closeWs(); killApp();
}

main()
  .catch((e) => { FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e); })
  .finally(async () => {
    killEdge(); killAllApp();
    await waitPortFree(PORT, 10000);
    try { rmSync(RUN, { recursive: true, force: true }); } catch {}
    console.log(`\nMOBILE-QUEUE stuck command (real app): ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
  });
