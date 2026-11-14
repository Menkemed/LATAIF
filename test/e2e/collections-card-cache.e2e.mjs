// ════════════════════════════════════════════════════════════════════════════
// COLLECTIONS-S1/S2 — RAM-Cache der Kartenbilder + Laden erst bei Sichtbarkeit (Primary UND PC2).
// Run: node scripts/e2e-diag-runner.mjs <out> test/e2e/collections-card-cache.e2e.mjs
//
//   SETUP    N Artikel über den echten Fernweg (Ablage + products.create), jeder dritte mit 3 Bildern, zwei Kategorien.
//   KALT     /collection: es laden nur sichtbare/bald sichtbare Karten (nicht alle N).
//   SCROLL   nach unten: die übrigen laden nach, jede Karte einmal.
//   ZURÜCK   Artikel öffnen → zurück: sichtbare Bilder aus dem RAM — Primary 0 Bildlesungen, PC2 0 /api/media.
//   KATEGORIE wechseln und zurück: keine erneute Bildabfrage.
//   ÄNDERUNG products.update ersetzt das Hauptbild → die Karte zeigt das NEUE Bild (Bytes = Datei des neuen Hauptbilds).
//   MOBILE   gallery_edit über /api/mobile/upload → die Karte zeigt das neue Bild.
//   SPUREN   Navigation schreibt keine Zeile in die Datenbanken, keine Datei, kein localStorage/IndexedDB-Eintrag.
//   ALT      zum Vergleich gemessen: die Arbeitslast des bisherigen Wegs (jede Karte liest ihre ganze Galerie) — im selben
//            Test-Binary nachgestellt (Primary: media_read_verified je Galeriebild; PC2: products.get + /api/media je Bild).
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat oder was am
// EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'cc-owner-' + Math.random().toString(36).slice(2);
const N = Number(process.env.CC_N || 90);
const T0 = Date.now();
const schritt = (s) => console.log(`      [${Math.round((Date.now() - T0) / 1000)}s] ${s}`);

const RUN = join(os.tmpdir(), 'lataif-cardcache', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = []; const MESS = {};
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.'); aufraeumen(); process.exit(1); }, 45 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env, APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'), LATAIF_E2E_SYNC_PORT: String(PORT),
});
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.listeners = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method) for (const f of this.listeners) { try { f(m); } catch { /* egal */ } }
    });
  }
  on(f) { this.listeners.push(f); }
  async send(method, params = {}, ms = 120000) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`CDP ${method} > ${ms} ms`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Ein Browser-Dialog (alert/confirm) blockiert jede Auswertung — er wird angenommen und protokolliert. */
  async dialogeAnnehmen() {
    await this.send('Page.enable', {});
    this.on((m) => { if (m.method === 'Page.javascriptDialogOpening') { console.log('      DIALOG: ' + String(m.params.message).slice(0, 160)); void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => null); } });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}
async function attachOnly(cdpPort, budget = 60000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* noch nicht */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c;
}
async function attach(cdpPort, exe, env) { spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref(); return attachOnly(cdpPort, 120000); }
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)'; try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteAuf(pruefe, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (await pruefe()) return true; await sleep(400); } return pruefe(); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); } throw new Error('no invoke'); }
const SHELL = 'a[href="/settings"]';
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');

// ── Zählung: Primary-IPC (ipc.localhost/<cmd>) und PC2-Netz (/api/media, /api/command products.get) über CDP ──
function zaehler(c) {
  const z = { mediaRead: 0, apiMedia: 0, productsGet: 0, ipcAll: 0 };
  c.on((m) => {
    if (m.method !== 'Network.requestWillBeSent') return;
    const r = m.params.request; const u = String(r?.url || '');
    if (r?.method === 'OPTIONS') return;   // CORS-Vorabanfrage: keine Übertragung
    if (/ipc\.localhost\//.test(u)) { z.ipcAll++; if (/ipc\.localhost\/media_read_verified(_raw)?(\?|$)/.test(u)) z.mediaRead++; }
    if (/\/api\/media\?key=/.test(u)) z.apiMedia++;
    if (/\/api\/command$/.test(u) && r.postData) { try { if (JSON.parse(r.postData).op === 'products.get') z.productsGet++; } catch { /* egal */ } }
  });
  return z;
}
const snap = (z) => ({ ...z });
const diff = (a, b) => ({ mediaRead: b.mediaRead - a.mediaRead, apiMedia: b.apiMedia - a.apiMedia, productsGet: b.productsGet - a.productsGet });

// ── Seite: Karten, sichtbare Karten, geladene Bilder ─────────────────────────
const KARTEN = `
  window.__ccBoxes = () => [...document.querySelectorAll('[data-page-scroll] div')].filter((d) => d.style.height === '180px');
  window.__ccVisible = () => { const sc = document.querySelector('[data-page-scroll]'); if (!sc) return []; const R = sc.getBoundingClientRect();
    return window.__ccBoxes().filter((b) => { const r = b.getBoundingClientRect(); return r.bottom > R.top && r.top < R.bottom; }); };
  window.__ccLoaded = (b) => { const i = b.querySelector('img'); return !!(i && i.complete && i.naturalWidth > 0); };
  window.__ccState = () => { const all = window.__ccBoxes(); const vis = window.__ccVisible();
    return { cards: all.length, blob: all.filter((b) => /^blob:/.test(b.querySelector('img')?.src || '')).length,
      skeleton: all.filter((b) => !b.querySelector('img') && b.querySelector('div[aria-hidden]')).length,
      visible: vis.length, visibleLoaded: vis.filter(window.__ccLoaded).length }; };
`;
async function karten(c) { await c.ev(KARTEN + ' return 1;'); return c.ev('return window.__ccState();'); }
/** Wartet im Seitentakt (requestAnimationFrame) bis alle sichtbaren Karten ein geladenes Bild haben; liefert ms ab Start. */
const BIS_SICHTBAR_GELADEN = (vorher) => `
  ${KARTEN}
  const t0 = performance.now();
  ${vorher}
  let first = -1;
  return await new Promise((res) => { const tick = () => {
    const vis = window.__ccVisible(); const t = performance.now() - t0;
    if (vis.length > 0 && first < 0) first = { ms: Math.round(t), loaded: vis.filter(window.__ccLoaded).length, of: vis.length };
    if (vis.length > 0 && vis.every(window.__ccLoaded)) return res({ ms: Math.round(t), first, visible: vis.length });
    if (t > 30000) return res({ ms: -1, first, visible: vis.length, loaded: vis.filter(window.__ccLoaded).length });
    requestAnimationFrame(tick); }; tick(); });
`;
async function kalt(c) { await geh(c, '/tasks'); await sleep(800); return c.ev(BIS_SICHTBAR_GELADEN(`history.pushState({}, '', '/collection'); window.dispatchEvent(new PopStateEvent('popstate'));`)); }
async function nachUntenScrollen(c) {
  await c.ev(KARTEN + ' return 1;');
  for (let i = 0; i < 80; i++) {
    const fertig = await c.ev(`const sc=document.querySelector('[data-page-scroll]'); sc.scrollTop += sc.clientHeight * 0.8; await new Promise(r=>setTimeout(r,250)); return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;`);
    if (fertig) break;
  }
  await warteAuf(async () => { const s = await karten(c); return s.skeleton === 0; }, 60000);
  await c.ev(`document.querySelector('[data-page-scroll]').scrollTop = 0; return 1;`); await sleep(500);
}
/** Karte mit dem Namen `name`: die Bytes des gezeigten Bilds (SHA-256). */
const kartenBildSha = (c, name) => c.ev(`
  ${KARTEN}
  const box = window.__ccBoxes().find((b) => (b.parentElement?.textContent || '').includes(${S(name)}));
  const img = box?.querySelector('img'); if (!img) return 'KEIN-BILD';
  const buf = await (await fetch(img.src)).arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');`);
const kategorieKlick = (c, name) => c.ev(`const g=[...document.querySelectorAll('div')].find(d=>d.children.length>1 && [...d.children].some(x=>x.textContent.trim()==='Category') && d.querySelector('button')); const root=g||document;
  const b=[...root.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(name)}).pop(); if(!b) return 'NO:'+${S(name)}; b.click(); return 'OK';`);

// ── Spuren: Zeilen aller Tabellen, Dateien der Datenordner (ohne WebView-Profil), Browser-Speicher ──
function zeilen(file) {
  const out = {};
  for (const t of dbQ(file, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) out[t.name] = dbQ(file, `SELECT COUNT(*) c FROM "${t.name}"`)[0]?.c;
  return out;
}
function dateien(dir) {
  const out = [];
  const walk = (d) => { let l = []; try { l = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of l) { const p = join(d, e.name); if (e.isDirectory()) { if (!/EBWebView|logs?$/i.test(e.name)) walk(p); } else out.push(relative(dir, p)); } };
  walk(dir); return out.sort();
}
const browserSpeicher = (c) => c.ev(`const dbs = indexedDB.databases ? (await indexedDB.databases()).map(d=>d.name).sort() : []; return JSON.stringify({ ls: Object.keys(localStorage).sort(), ss: Object.keys(sessionStorage).sort(), idb: dbs, caches: (await caches.keys()).sort() });`);

function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk) continue;
    if (daten[sp.name] !== undefined) continue;
    const t = String(sp.type || '').toUpperCase();
    daten[sp.name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k]));
}
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    for (const [id, name, i] of [['cc-cat-a', 'CCWatch', 0], ['cc-cat-b', 'CCRing', 1]]) {
      insert(db, 'categories', { id, branch_id, name, icon: 'Watch', color: '#000000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: i, created_at: now, updated_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}
const MAIN_OF = `SELECT g.storage_key AS key, l.media_id AS mid FROM media_links l
    JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
    JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
    JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
   WHERE l.entity_type = 'product' AND l.entity_id = ? AND l.deleted_at IS NULL ORDER BY l.is_primary DESC, l.sort_order`;
const dateiSha = (key) => { try { return createHash('sha256').update(readFileSync(join(APP_DATA_DIR, 'media', String(key)))).digest('hex'); } catch { return 'FEHLT'; } };

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Einrichten (wie die übrigen Zwei-Rechner-Läufe) ──────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'CC Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'CC Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'CC Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null); await sleep(1200);
  const onboardingPid = startedPids().pop();
  primary.close(); primary = null;
  await closeTestWindow(onboardingPid, APP); await waitTestImageGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 90000);
  await primary.ev('window.confirm = () => true; return 1;');
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ } await sleep(500); }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }

  // ── N Artikel mit Bildern über den echten Fernweg ────────────────────────
  const api = async (pfad, body, token) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${pfad}`, { signal: AbortSignal.timeout(90000), method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: r.status, j };
  };
  const befehl = (op, payload, token) => api('/api/command', { op, commandId: randomUUID(), payload }, token);
  const login = await api('/api/auth/login', { email: OWNER_EMAIL, password: OWNER_PW });
  const TOKEN = login.j?.token;
  ok(login.status === 200 && !!TOKEN, `SETUP Anmeldung am Primary-Server (${login.status})`);
  const aufnahme = (seed) => primary.ev(`const w=800,h=533; const c=document.createElement('canvas'); c.width=w; c.height=h; const g=c.getContext('2d');
    const gr=g.createLinearGradient(0,0,w,h); gr.addColorStop(0,'hsl(${(seed * 37) % 360},55%,35%)'); gr.addColorStop(1,'#d9b38c'); g.fillStyle=gr; g.fillRect(0,0,w,h);
    let s=${seed}+1; const r=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
    for(let i=0;i<400;i++){ g.fillStyle='rgba('+Math.floor(r()*255)+','+Math.floor(r()*255)+','+Math.floor(r()*255)+',0.55)'; g.beginPath(); g.arc(r()*w, r()*h, 2+r()*24, 0, 6.283); g.fill(); }
    g.fillStyle='#fff'; g.font='bold 64px Arial'; g.fillText('CC ${seed}', 30, 100);
    return c.toDataURL('image/jpeg', 0.7).split(',')[1];`);
  const ablegen = async (b64) => { const r = await api('/api/staging/media', { mime: 'image/jpeg', dataBase64: b64 }, TOKEN); return r.status === 201 ? String(r.j?.stagingId || '') : `FEHLER:${r.status}`; };
  const t0 = Date.now(); let bildNr = 0; const artikel = [];
  for (let i = 0; i < N; i++) {
    const n = i % 3 === 0 ? 3 : 1;
    const ids = []; for (let k = 0; k < n; k++) ids.push(await ablegen(await aufnahme(++bildNr)));
    const name = `CC Item ${String(i).padStart(3, '0')}`;
    const r = await befehl('products.create', { categoryId: i % 2 ? 'cc-cat-b' : 'cc-cat-a', brand: 'CC', name, stagingIds: ids }, TOKEN);
    if (r.status !== 200 || !r.j?.ok) { console.log('      create ' + i + ': ' + r.status + ' ' + S(r.j).slice(0, 200)); break; }
    artikel.push({ name, id: r.j?.value?.productId, sku: r.j?.value?.sku, n });
    if (i % 30 === 29) schritt('angelegt ' + (i + 1));
  }
  await spuelen(primary);
  const mitBild = dbQ(BIZ_DB, "SELECT COUNT(DISTINCT entity_id) c FROM media_links WHERE entity_type='product' AND deleted_at IS NULL")[0]?.c;
  const galerieBilder = dbQ(BIZ_DB, "SELECT COUNT(*) c FROM media_links WHERE entity_type='product' AND deleted_at IS NULL")[0]?.c;
  MESS.setup = { artikel: artikel.length, mitBild, galerieBilder, sek: Math.round((Date.now() - t0) / 1000) };
  ok(artikel.length === N && mitBild === N, `SETUP ${N} Artikel mit Bildern angelegt (${S(MESS.setup)})`);

  // PC2 verbinden
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await klick(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await klick(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await klick(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  await client.ev('window.confirm = () => true; return 1;');
  ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SETUP PC2 ohne Geschäftsdatenbank, angemeldet');

  // Primary-Store frisch (die Artikel kamen über den Fernweg), Zähler an beiden Rechnern.
  await primary.ev('location.reload(); return 1;'); await sleep(4000);
  primary.close(); primary = await attachOnly(APP_CDP); await waitFor(primary, SHELL, 90000);
  await primary.ev('window.confirm = () => true; return 1;');
  // maxPostDataSize: CDP liefert sonst JEDEN IPC-Body mit — das Speichern schickt die ganze DB und blockiert die Test-Verbindung.
  for (const c of [primary, client]) { await c.send('Network.enable', { maxPostDataSize: 65536 }); await c.dialogeAnnehmen(); }
  schritt('Messung beginnt');
  const zP = zaehler(primary), zC = zaehler(client);

  const spurenVorher = { biz: zeilen(BIZ_DB), srv: zeilen(SERVER_DB), dP: dateien(APP_DATA_DIR), dC: dateien(CLIENT_DATA_DIR), bP: await browserSpeicher(primary), bC: await browserSpeicher(client) };

  for (const [rolle, c, z] of [['PRIMARY', primary, zP], ['PC2', client, zC]]) {
    const M = (MESS[rolle] = {});
    schritt(rolle + ' KALT');
    // ── KALT ──
    let a = snap(z);
    const k = await kalt(c);
    await sleep(1500);
    const sk = await karten(c);
    M.kalt = { ...k, ...diff(a, snap(z)), state: sk };
    const geladeneKarten = rolle === 'PRIMARY' ? null : M.kalt.apiMedia;
    ok(k.ms >= 0 && sk.cards >= N, `${rolle} KALT sichtbare Karten geladen in ${k.ms} ms (${sk.visible} sichtbar, ${sk.cards} Karten)`);
    ok(sk.blob < sk.cards / 2 && sk.skeleton > sk.cards / 2,
      `${rolle} LAZY beim Öffnen laden nur sichtbare/bald sichtbare Karten (${sk.blob} von ${sk.cards} geladen, ${sk.skeleton} warten)`);
    if (rolle === 'PRIMARY') ok(M.kalt.mediaRead > 0 && M.kalt.mediaRead < galerieBilder / 2, `${rolle} LAZY Bildlesungen ${M.kalt.mediaRead} statt ${galerieBilder} (alle Galerien)`);
    else ok(geladeneKarten > 0 && geladeneKarten <= sk.blob && M.kalt.productsGet < N / 2, `${rolle} LAZY /api/media ${geladeneKarten}, products.get ${M.kalt.productsGet} statt ${N} + ${galerieBilder}`);

    schritt(rolle + ' SCROLL');
    // ── SCROLL ──
    a = snap(z);
    await nachUntenScrollen(c);
    const ss = await karten(c);
    M.scroll = { ...diff(a, snap(z)), state: ss };
    ok(ss.skeleton === 0 && ss.blob === N, `${rolle} SCROLL alle ${N} Karten haben ihr Bild (${ss.blob})`);
    if (rolle === 'PC2') ok(M.kalt.apiMedia + M.scroll.apiMedia === N, `${rolle} SCROLL jede Karte holte genau EIN Bild (${M.kalt.apiMedia + M.scroll.apiMedia} /api/media für ${N} Karten, Galerie hätte ${galerieBilder})`);

    schritt(rolle + ' ZURÜCK');
    // ── ZURÜCK aus Item Details ──
    await c.ev(KARTEN + ` const b = window.__ccVisible()[0]; b.click(); return 1;`);
    await warteAuf(async () => !(await c.ev("return location.pathname === '/collection';")), 10000);
    await sleep(2500);
    a = snap(z);
    const zb = await c.ev(BIS_SICHTBAR_GELADEN('history.back();'));
    await sleep(1500);
    M.zurueck = { ...zb, ...diff(a, snap(z)) };
    ok(zb.ms >= 0 && zb.first && zb.first.loaded === zb.first.of,
      `${rolle} ZURÜCK sichtbare Bilder sofort da: ${zb.first?.loaded}/${zb.first?.of} beim ersten Bild nach ${zb.first?.ms} ms, alle nach ${zb.ms} ms`);
    if (rolle === 'PRIMARY') ok(M.zurueck.mediaRead === 0, `${rolle} ZURÜCK 0 Bildlesungen (${M.zurueck.mediaRead}) — Bild aus dem RAM-Cache`);
    else ok(M.zurueck.apiMedia === 0, `${rolle} ZURÜCK 0 Bildübertragungen /api/media (${M.zurueck.apiMedia}); nur Fingerabdruck products.get ${M.zurueck.productsGet}`);

    schritt(rolle + ' KATEGORIE');
    // ── KATEGORIE wechseln und zurück ──
    a = snap(z);
    const r1 = await kategorieKlick(c, 'CCRing'); await sleep(1200);
    const kb = await karten(c);
    const r2 = await kategorieKlick(c, 'All'); await sleep(200);
    const ka = await c.ev(BIS_SICHTBAR_GELADEN(''));
    await sleep(1500);
    M.kategorie = { ...ka, ring: kb.cards, ...diff(a, snap(z)) };
    ok(r1 === 'OK' && r2 === 'OK' && kb.cards === Math.floor(N / 2) && ka.ms >= 0, `${rolle} KATEGORIE CCRing (${kb.cards} Karten) → All, sichtbar geladen nach ${ka.ms} ms`);
    if (rolle === 'PRIMARY') ok(M.kategorie.mediaRead === 0, `${rolle} KATEGORIE keine erneute Bildlesung (${M.kategorie.mediaRead})`);
    else ok(M.kategorie.apiMedia === 0, `${rolle} KATEGORIE keine erneute Bildübertragung (${M.kategorie.apiMedia}); Fingerabdruck products.get ${M.kategorie.productsGet}`);
  }

  // ── SPUREN: die Navigation hat nichts geschrieben ──
  {
    const nachher = { biz: zeilen(BIZ_DB), srv: zeilen(SERVER_DB), dP: dateien(APP_DATA_DIR), dC: dateien(CLIENT_DATA_DIR), bP: await browserSpeicher(primary), bC: await browserSpeicher(client) };
    const geaendert = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
    const bizD = geaendert(spurenVorher.biz, nachher.biz), srvD = geaendert(spurenVorher.srv, nachher.srv);
    console.log('      Zeilen geändert: biz ' + S(bizD.map((t) => `${t}:${spurenVorher.biz[t]}→${nachher.biz[t]}`)) + ' srv ' + S(srvD.map((t) => `${t}:${spurenVorher.srv[t]}→${nachher.srv[t]}`)));
    const neueDateienP = nachher.dP.filter((f) => !spurenVorher.dP.includes(f)), neueDateienC = nachher.dC.filter((f) => !spurenVorher.dC.includes(f));
    ok(bizD.filter((t) => !/^(audit_log|changelog|sync_|app_events)/.test(t)).length === 0, `SPUREN Geschäftsdatenbank: keine neue Zeile durch die Navigation (${S(bizD)})`);
    ok(!bizD.some((t) => /media|image|thumb|cache/i.test(t)) && !srvD.some((t) => /media|image|thumb|cache/i.test(t)), 'SPUREN keine Medien-/Cache-Tabelle gewachsen');
    ok(neueDateienP.length === 0 && neueDateienC.length === 0, `SPUREN keine neue Datei in den Datenordnern (Primary ${S(neueDateienP)}, PC2 ${S(neueDateienC)})`);
    ok(nachher.bP === spurenVorher.bP && nachher.bC === spurenVorher.bC, `SPUREN localStorage/sessionStorage/IndexedDB/CacheStorage unverändert (${nachher.bP} | ${nachher.bC})`);
    MESS.spuren = { biz: bizD, srv: srvD };
  }

  // ── ÄNDERUNG: products.update ersetzt das Hauptbild eines sichtbaren Artikels ──
  // Die beiden ersten SICHTBAREN Karten oben (Primary und PC2 sortieren gleich).
  const oben = await primary.ev(KARTEN + ` return window.__ccVisible().map((b) => (b.parentElement?.textContent.match(/CC Item \\d{3}/) || [''])[0]);`);
  schritt('sichtbar oben: ' + S(oben.slice(0, 3)));
  {
    const x = artikel.find((a) => a.name === oben[0]) ?? artikel[0];
    const vorher = dbQ(BIZ_DB, MAIN_OF, [x.id]);
    schritt('ÄNDERUNG ablegen');
    const neu = await ablegen(await aufnahme(9001));
    const gallery = [{ stagingId: neu }, ...vorher.slice(1).map((r) => ({ keep: r.mid }))];
    schritt('ÄNDERUNG products.update');
    const r = await befehl('products.update', { id: x.id, gallery }, TOKEN);
    schritt('ÄNDERUNG antwort ' + r.status + ' ' + S(r.j).slice(0, 160));
    await spuelen(primary);
    const nach = dbQ(BIZ_DB, MAIN_OF, [x.id]);
    const soll = dateiSha(nach[0]?.key);
    ok(r.status === 200 && nach[0]?.key !== vorher[0]?.key, `ÄNDERUNG Hauptbild über products.update ersetzt (${r.status} ${S(r.j?.error || '')})`);
    for (const [rolle, c] of [['PRIMARY', primary], ['PC2', client]]) {
      schritt(rolle + ' ÄNDERUNG prüfen');
      const alt = await kartenBildSha(c, x.name);
      await c.ev(KARTEN + ` const b = window.__ccVisible()[1]; b.click(); return 1;`); await sleep(2000);
      await c.ev('history.back(); return 1;');
      const ist = await warteAuf(async () => (await kartenBildSha(c, x.name)) === soll, 15000);
      ok(ist && alt !== soll, `${rolle} ÄNDERUNG die Karte zeigt nach Rückkehr das NEUE Hauptbild (vorher ${String(alt).slice(0, 8)}, jetzt ${String(await kartenBildSha(c, x.name)).slice(0, 8)}, Datei ${soll.slice(0, 8)})`);
    }
  }

  // ── MOBILE: gallery_edit über /api/mobile/upload ──
  {
    const y = artikel.find((a) => a.name === oben[2]) ?? artikel[3];
    // Die Mobile-Bindung (wie mobile-gallery-edit.e2e.mjs): ohne sie holt der Primary keinen Handy-Auftrag ab.
    {
      const br = dbQ(BIZ_DB, 'SELECT id, tenant_id FROM branches LIMIT 1')[0] || {};
      const cfg = await primary.ev(`try{ const v=await window.__TAURI_INTERNALS__.invoke('mobile_runtime_scope_configure', ${S({ email: OWNER_EMAIL, password: OWNER_PW, tenantId: br.tenant_id, branchId: br.id })}); return {ok:true,v}; }catch(e){ return {ok:false,e:String((e&&e.message)||e)}; }`);
      schritt('MOBILE Bindung ' + S(cfg).slice(0, 160));
    }
    schritt('MOBILE lesen ' + y.name);
    const read = await (await fetch(`http://127.0.0.1:${PORT}/api/products/by-id/${encodeURIComponent(y.id)}`, { signal: AbortSignal.timeout(60000), headers: { Authorization: 'Bearer ' + TOKEN } })).json().catch(() => ({}));
    const vorher = dbQ(BIZ_DB, MAIN_OF, [y.id]);
    const b64 = await aufnahme(9002);
    const res = await fetch(`http://127.0.0.1:${PORT}/api/mobile/upload`, {
      signal: AbortSignal.timeout(60000), method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ protocol_version: 2, upload_event_id: 'cc-mob-' + Date.now(), entity_id: 'cc-mob-ent-' + Date.now(), mode: 'collection',
        metadata: { kind: 'gallery_edit', productId: y.id, galleryBaseline: read.gallery_baseline, order: [{ new: 0 }, ...(read.gallery || []).slice(1).map((l) => ({ keep: l.link_id }))], remove: [(read.gallery || [])[0]?.link_id].filter(Boolean) },
        images: [{ mime: 'image/jpeg', data_base64: b64 }] }),
    });
    schritt('MOBILE gesendet ' + res.status);
    // Die PC2-Karte hält das ALTE Bild im RAM — sie muss es über den Fingerabdruck ersetzen.
    const altPc2 = await kartenBildSha(client, y.name);
    const uebernommen = () => { const n = dbQ(BIZ_DB, MAIN_OF, [y.id]); return !!(n[0] && n[0].key !== vorher[0]?.key); };
    let angewandt = await warteAuf(async () => uebernommen(), 15000);
    if (!angewandt) {
      // Ohne Mobile-Bindung hat der Test-Primary keinen Abhol-Timer; die Abholung läuft nach der Anmeldung
      // (wie in mobile-gallery-edit.e2e.mjs) — also neu laden. Das leert den RAM-Cache des PRIMARY (nicht den des PC2).
      schritt('MOBILE Primary neu laden (Abholung nach Anmeldung)');
      await primary.ev('location.reload(); return 1;').catch(() => null); await sleep(4000);
      primary.close(); primary = await attachOnly(APP_CDP); await waitFor(primary, SHELL, 90000);
      await primary.ev('window.confirm = () => true; return 1;');
      angewandt = await warteAuf(async () => uebernommen(), 60000);
      await geh(primary, '/collection'); await sleep(1500);
    }
    const soll = dateiSha(dbQ(BIZ_DB, MAIN_OF, [y.id])[0]?.key);
    ok(res.status >= 200 && res.status < 300 && angewandt, `MOBILE gallery_edit angenommen und am Primary übernommen (${res.status})`);
    ok(altPc2 !== soll && altPc2 !== 'KEIN-BILD', `MOBILE PC2 zeigte vorher das alte Bild aus dem RAM (${String(altPc2).slice(0, 8)} ≠ ${soll.slice(0, 8)})`);
    for (const [rolle, c] of [['PRIMARY', primary], ['PC2', client]]) {
      schritt(rolle + ' MOBILE prüfen');
      await geh(c, '/tasks'); await sleep(800); await c.ev('history.back(); return 1;');
      const ist = await warteAuf(async () => (await kartenBildSha(c, y.name)) === soll, 15000);
      ok(ist && angewandt, `${rolle} MOBILE die Karte zeigt das per Handy geänderte Hauptbild (${String(await kartenBildSha(c, y.name)).slice(0, 8)} = ${soll.slice(0, 8)})`);
    }
  }

  schritt('ALT');
  // ── ALT: die Arbeitslast des bisherigen Wegs, im selben Binary nachgestellt ──
  {
    const tenant = dbQ(BIZ_DB, 'SELECT tenant_id FROM branches LIMIT 1')[0]?.tenant_id;
    const items = dbQ(BIZ_DB, `SELECT g.stored_blob_hash AS h, g.extension AS e FROM media_links l
      JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
      JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
      JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
      WHERE l.entity_type='product' AND l.deleted_at IS NULL`);
    const altP = await primary.ev(`const items=${S(items)}; const t0=performance.now();
      await Promise.all(items.map((i)=>window.__TAURI_INTERNALS__.invoke('media_read_verified',{tenantScope:${S(tenant)},hash:i.h,extension:i.e}).then((r)=>new Blob([new Uint8Array(r.bytes)]))));
      return Math.round(performance.now()-t0);`);
    const t1 = performance.now();
    await Promise.all(artikel.map(async (x) => {
      const d = await befehl('products.get', { id: x.id }, TOKEN);
      for (const key of (d.j?.value?.mediaKeys ?? [])) await (await fetch(`http://127.0.0.1:${PORT}/api/media?key=${encodeURIComponent(key)}`, { headers: { Authorization: 'Bearer ' + TOKEN } })).arrayBuffer();
    }));
    MESS.alt = { primaryMs: altP, primaryBilder: items.length, pc2Ms: Math.round(performance.now() - t1), pc2Auskuenfte: artikel.length };
    console.log('      ALT (je Öffnen/Zurück bisher): ' + S(MESS.alt));
  }
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  console.log('\nMESSWERTE ' + JSON.stringify(MESS, null, 1));
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nCOLLECTIONS CARD CACHE: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
