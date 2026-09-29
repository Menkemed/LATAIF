// ════════════════════════════════════════════════════════════════════════════
// MOBILE-PURCHASE — der vollstaendige Einkauf vom Telefon, echt: Primary (lataif.exe, isolierte
// Instanz) und die echte /mobile-Seite in einem kopflosen Edge. Run: node test/e2e/mobile-purchase.e2e.mjs
//
//   M1  Buchen      Kunde → Lieferant, zwei Positionen (Uhr mit zwei Fotos und Partner 40 % per BHD,
//                   Kette Menge 3), zwei Zahlungen, Rest offen beim Lieferanten — EIN Auftrag.
//   M2  Verlorene   Die Antwort auf purchases.create wird verworfen, NACHDEM der Primary gebucht hat;
//       Antwort     „Send again" wiederholt DIESELBE Kennung → bekanntes Ergebnis, kein zweiter Einkauf.
//   M3  Offline     Die Ablage ist nicht erreichbar: der Einkauf wartet, nichts gebucht; nach Neustart
//                   der Seite wird er automatisch gesendet und gebucht (neue Person + Lieferantenrolle).
//   M4  Grenzen     kein /api/sync/push, keine verwaiste Ablage, Hauptbuch ausgeglichen.
//
// PROZESS-ISOLATION (dauerhafte Regel): gestartet wird nur ueber `spawnTracked`; beendet wird nur,
// was dieser Lauf gestartet hat. Edge ist ein EIGENES Kind dieses Laufs (`killOwnChild`).
// Die installierte Produktions-App, E:LATAIFData und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import {
  killStarted, killTestImage, killTestPid, killOwnChild, spawnTracked, waitTestImageGone,
  foreignProcesses, pathOfPid, startedPids, waitPidGone,
} from './_e2e-process.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
// Eigener Debug-Port je Lauf: ein liegengebliebener Test-Browser eines frueheren Laufs darf NIE die
// Seite sein, die hier gemessen wird — genau das hat einmal eine alte Seite als „aktuell" gezeigt.
const EDGE_CDP = 9700 + Math.floor(Math.random() * 280);
const BASE = `http://127.0.0.1:${PORT}`;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';

const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'preg5-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-mobile-purchase', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const STAGING_ROOT = join(APP_DATA_DIR, 'command-staging');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();
const MESS = {};
const RV = { m1: false, m2: false, m3: false, m4: false };

let edgeProc = null;
const aufraeumen = () => {
  try { killOwnChild(edgeProc); } catch { /* schon weg */ }
  // Nur der EIGENE Test-Browser (PID + Startpfad geprüft, samt Prozessbaum) — nie nach Name oder
  // Befehlszeile: jeder Lauf hat ein eigenes Profil unter RUN, ein Rest eines früheren Laufs stört nicht.
  killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe');
};
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  aufraeumen();
  process.exit(1);
}, 70 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env,
  APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'),
  LATAIF_E2E_SYNC_PORT: String(PORT),
});

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}

// ── CDP ─────────────────────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.events = []; this.requests = []; this.antworten = []; this.paused = null;
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Network.requestWillBeSent') this.requests.push(String(m.params?.request?.url || ''));
      if (m.method === 'Network.responseReceived') {
        const u = String(m.params?.response?.url || '');
        if (/\/api\//.test(u)) this.antworten.push(u.replace(/^https?:\/\/[^/]+/, '') + ' → ' + m.params?.response?.status);
      }
      if (m.method === 'Fetch.requestPaused' && this.paused) this.paused(m.params);
      if (m.method === 'Runtime.consoleAPICalled') {
        this.events.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.events.push(`exception: ${m.params?.exceptionDetails?.exception?.description || ''}`.slice(0, 300));
      }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  async send(method, params = {}, ms = 180000) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method}: keine Antwort in ${ms / 1000} s`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

async function attachOnly(cdpPort, match, budget = 120000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && match.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(400);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function attachApp(cdpPort, exe, env) {
  spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, /tauri\.localhost/);
}

const q = (sel) => `document.querySelector(${S(sel)})`;
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; b.click(); return 'OK';`);
const text = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.textContent.trim() : '';`);
async function warteBis(c, expr, budget = 60000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    try { if (await c.ev(`return !!(${expr});`)) return true; } catch { /* Seite baut noch */ }
    await sleep(400);
  }
  return false;
}
const waitFor = (c, sel, budget = 60000) => warteBis(c, q(sel), budget);
async function warteAuf(pruef, sekunden = 30) {
  for (let i = 0; i < sekunden * 2; i++) { if (pruef()) return true; await sleep(500); }
  return false;
}
const waitInvoke = (c) => warteBis(c, 'window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke', 120000);

// ── Telefon (echte /mobile-Seite in Edge) ───────────────────────────────────
async function startEdge(url) {
  mkdirSync(EDGE_PROFILE, { recursive: true });
  edgeProc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, url,
  ], { stdio: 'ignore' });
  // Genau DIESE Seite, nicht irgendeine: der Vergleich geht gegen die volle Adresse dieses Laufs.
  const c = await attachOnly(EDGE_CDP, new RegExp('^' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 60000);
  await c.send('Network.enable', {}, 15000);
  return c;
}

/** Ein echtes, kleines JPEG als Daten-URL — auf der Seite gerechnet, wie ein Kamerabild. */
const MAKE_PHOTO = (seed) => `
  const c = document.createElement('canvas'); c.width = 240; c.height = 180;
  const x = c.getContext('2d');
  x.fillStyle = 'hsl(' + (${seed} * 47 % 360) + ',60%,50%)'; x.fillRect(0, 0, 240, 180);
  x.fillStyle = '#111'; x.font = '28px sans-serif'; x.fillText('C${seed}', 20, 100);
  return c.toDataURL('image/jpeg', 0.9);`;

async function fotoLegen(phone, seed) {
  return phone.ev(`
    const dataUrl = await (async () => { ${MAKE_PHOTO(seed)} })();
    const res = await fetch(dataUrl); const blob = await res.blob();
    const file = new File([blob], 'c${seed}.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(file);
    const inp = document.getElementById('cnPhotoInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK';`);
}
const fotoZahl = (phone) => phone.ev("return document.querySelectorAll('#cnPhotoStrip .photo-thumb').length;");

// ── Geschaeftsdaten lesen ───────────────────────────────────────────────────
const konById = (id) => dbQ(BIZ_DB, 'SELECT * FROM consignments WHERE id = ?', [id])[0] || null;
const konAnzahl = () => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM consignments')[0]?.n || 0);
const prodById = (id) => dbQ(BIZ_DB, 'SELECT * FROM products WHERE id = ?', [id])[0] || null;
const nachweisFuer = (op) => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM remote_command_ledger WHERE op = ?', [op])[0]?.n || 0);
const medienVon = (produktId) => dbQ(BIZ_DB,
  "SELECT media_id FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC",
  [produktId]);

// ════════════════════════════════════════════════════════════════════════════
let primary = null, phone = null, client = null;
let CON_ID = '', CON_NR = '', PROD_ID = '';
const STEMPEL = Date.now().toString(36);
const MARKE = 'Rolex ' + STEMPEL;
const MODELL = 'Datejust ' + STEMPEL;
const EINLIEFERER_VOR = 'PreG5', EINLIEFERER_NACH = 'Consignor ' + STEMPEL;

try {
  if (!existsSync(SEED)) throw new Error('e2e_scope_seed.exe fehlt: ' + SEED);
  if (!existsSync(EDGE)) throw new Error('Edge nicht gefunden: ' + EDGE);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ══ SETUP — Primary einrichten, Server-Zugang setzen, Server starten ══════════════════════════
  primary = await attachApp(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PreG5 Consign Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'PreG5 Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'PreG5 Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  const SHELL = 'a[href="/settings"]';
  await waitFor(primary, SHELL, 90000);
  const pid1 = startedPids().pop();
  primary.close(); primary = null;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid1} -ErrorAction Stop).CloseMainWindow()`], { encoding: 'utf8', windowsHide: true });
  if (!await waitPidGone(pid1, 120000)) killTestPid(pid1, APP);
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });
  // Stammdaten des Laufs in die Datei (die App ist zu): ein aktiver Partner, ein Lieferant, ein Kunde.
  {
    const db = new DatabaseSync(BIZ_DB);
    try {
      const branch = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id;
      const now = new Date().toISOString();
      db.prepare("INSERT INTO partners (id, branch_id, name, share_percentage, active, created_at, updated_at) VALUES ('mp-pa', ?, 'E2E Partner', 0, 1, ?, ?)").run(branch, now, now);
      db.prepare("INSERT INTO suppliers (id, branch_id, name, phone, active, created_at, updated_at) VALUES ('mp-sup', ?, 'E2E Supplier', '+973 1700 0555', 1, ?, ?)").run(branch, now, now);
      db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, phone, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
        VALUES ('mp-cust', ?, 'Ali', 'Hassan', '+973 3600 0101', 'BH', 'en', 0, '[]', 'collector', 'active', ?, ?)`).run(branch, now, now);
    } finally { db.close(); }
  }

  primary = await attachApp(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL, 120000);
  await primary.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  let gesund = false;
  for (let i = 0; i < 120 && !gesund; i++) { try { gesund = (await fetch(`${BASE}/api/health`)).ok; } catch { /* noch nicht */ } if (!gesund) await sleep(500); }
  ok(gesund, 'SETUP der Primary antwortet auf dem Netz');

  // ══ SETUP — Telefon: die echte /mobile-Seite ══════════════════════════════════════════════════
  phone = await startEdge(`${BASE}/mobile`);
  await waitFor(phone, '#login', 60000);
  await setVal(phone, '#email', OWNER_EMAIL);
  await setVal(phone, '#password', OWNER_PW);
  await klick(phone, '#loginBtn');
  const angemeldet = await warteBis(phone, `${q('#modePicker')} && !document.getElementById('modePicker').classList.contains('hidden')`, 60000);
  ok(angemeldet, 'SETUP das Telefon ist angemeldet (echte Seite, echter Zugang)');

  // ── Helfer der Einkaufsmaske ──────────────────────────────────────────────────────────────────
  const tippe = (sel, v) => setVal(phone, sel, v);
  // Ein Telefon: 360 px breit. Bildschirmfotos nur auf Wunsch (E2E_SHOTS=<Ordner>).
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true }, 15000);
  const shot = async (name) => {
    if (!process.env.E2E_SHOTS) return;
    const r = await phone.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, 30000);
    (await import('node:fs')).writeFileSync(join(process.env.E2E_SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const uidVon = (i) => phone.ev(`return window.__mpTest ? '' : ([...document.querySelectorAll('[data-mp-sec^="item:"]')][${i}] || { getAttribute: () => '' }).getAttribute('data-mp-sec').slice(5);`);
  async function fotosLegen(uid, n) {
    return phone.ev(`
      const dt = new DataTransfer();
      for (let i = 0; i < ${n}; i++) {
        const c = document.createElement('canvas'); c.width = 240; c.height = 180;
        const x = c.getContext('2d'); x.fillStyle = 'hsl(' + ((i + 1) * 97 % 360) + ',60%,50%)'; x.fillRect(0, 0, 240, 180);
        x.fillStyle = '#111'; x.font = '28px sans-serif'; x.fillText('MP' + i, 20, 100);
        const blob = await (await fetch(c.toDataURL('image/jpeg', 0.9))).blob();
        dt.items.add(new File([blob], 'mp' + i + '.jpg', { type: 'image/jpeg' }));
      }
      const inp = document.getElementById('mpf' + ${S(uid)}); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return document.querySelectorAll('[data-mp-sec="item:' + ${S(uid)} + '"] .photo-thumb').length;`);
  }
  /** Pflichtmerkmale der Kategorie füllen (erste Auswahl, Text „X", Zahl 1) — nur leere. */
  async function pflicht(uid, catId) {
    await tippe(`[data-mp-field="item:${uid}:categoryId"]`, catId);
    await sleep(300);
    return phone.ev(`
      const pre = 'mpa' + ${S(uid)} + '_';
      const host = document.getElementById('mpAttrs' + ${S(uid)});
      for (let runde = 0; runde < 2; runde++) for (const e of host.querySelectorAll('select, input, .chips')) {
        if (e.closest('.row') && e.closest('.row').classList.contains('hidden')) continue;
        if (!/\\*/.test((e.closest('.row') && e.closest('.row').querySelector('label') || {}).textContent || '')) continue;
        if (e.tagName === 'SELECT') { if (!e.value) { e.value = [...e.options].find((o) => o.value).value; e.dispatchEvent(new Event('change', { bubbles: true })); } }
        else if (e.classList.contains('chips')) { if (![...e.children].some((x) => x.classList.contains('on'))) e.children[0].click(); }
        else if (!e.value) { e.value = e.type === 'number' ? '1' : 'X'; e.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      await new Promise((r) => setTimeout(r, 200));
      return host.querySelectorAll('[id^="' + pre + '"]').length;`);
  }
  const fotosAmArtikel = (id) => {
    let zeile = [];
    try { zeile = JSON.parse(String((prodById(id) || {}).images || '[]')); } catch { zeile = []; }
    return zeile.length + medienVon(id).length;
  };
  const einkaeufe = () => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM purchases')[0]?.n || 0);
  const unbalanced = () => Number(dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM (SELECT transaction_id, SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) d
    FROM ledger_entries GROUP BY transaction_id HAVING ABS(d) > 0.0005)`)[0]?.n ?? -1);
  const ablageLeer = () => !existsSync(STAGING_ROOT) || readdirSync(STAGING_ROOT, { recursive: true }).filter((f) => /\.(bin|jpe?g|png|webp|blob)$/i.test(String(f))).length === 0;

  // ══ M1 — Einkauf vom Telefon: Kunde → Lieferant, zwei Positionen, Fotos, Partner, zwei Zahlungen ══
  let PUR_NR = '';
  {
    const vorher = einkaeufe();
    await klick(phone, '.mode-btn[data-mode="mpurchase"]');
    const home = await warteBis(phone, `!document.getElementById('mpHome').classList.contains('hidden')`, 30000);
    await warteBis(phone, `window.localStorage.getItem('lataif_mobile_partners') !== null`, 20000);
    await klick(phone, '#mpNewBtn');
    const maske = await warteBis(phone, `!document.getElementById('formMPurchase').classList.contains('hidden')`, 20000);
    await klick(phone, '[data-mp-action="supplier-mode"][data-mode="customer"]');
    await tippe('#mpSupSearch', 'Hassan');
    await klick(phone, '[data-mp-action="search-customer"]');
    await warteBis(phone, `document.querySelectorAll('[data-mp-action="pick-customer"]').length > 0`, 30000);
    await klick(phone, '[data-mp-action="pick-customer"]');
    const u1 = await uidVon(0);
    const fotos = await fotosLegen(u1, 2);
    await pflicht(u1, 'cat-watch');
    await tippe(`[data-mp-field="item:${u1}:brand"]`, MARKE);
    await tippe(`[data-mp-field="item:${u1}:name"]`, MODELL);
    await tippe(`[data-mp-field="item:${u1}:quantity"]`, '1');
    await tippe(`[data-mp-field="item:${u1}:unitPrice"]`, '1000');
    await klick(phone, `[data-mp-action="add-partner"][data-uid="${u1}"]`);
    await sleep(200);
    await tippe(`[data-mp-field="partner:${u1}:0:partnerId"]`, 'mp-pa');
    await sleep(200);
    await tippe(`[data-mp-field="partner:${u1}:0:amount"]`, '400');
    await klick(phone, '[data-mp-action="add-item"]');
    await sleep(300);
    const u2 = await uidVon(1);
    await pflicht(u2, 'cat-gold-jewelry');
    // DISPLAY-NAME — bei Gold-Diamond Jewellery gibt es keine Felder für Marke/Modell.
    await tippe(`[data-mp-field="item:${u2}:quantity"]`, '3');
    await tippe(`[data-mp-field="item:${u2}:unitPrice"]`, '120.5');
    // STONES — die Steinliste der Gold-Position am echten Telefon; gebucht am echten Primary.
    const ST = `[id="mpa${u2}_stones"]`;
    await klick(phone, `${ST} [data-st="toggle"]`);
    await klick(phone, `${ST} [data-st="add"]`); await klick(phone, `${ST} [data-st="add"]`);
    await tippe(`${ST} [data-st="type"][data-i="0"]`, 'diamond');
    await tippe(`${ST} [data-st="qty"][data-i="0"]`, '1');
    await tippe(`${ST} [data-st="carat"][data-i="0"]`, '0.50');
    await tippe(`${ST} [data-st="clarity"][data-i="0"]`, 'VS1');
    await tippe(`${ST} [data-st="type"][data-i="1"]`, 'emerald');
    await tippe(`${ST} [data-st="qty"][data-i="1"]`, '3');
    await tippe(`${ST} [data-st="carat"][data-i="1"]`, '0.45');
    const steinKopf = await text(phone, `${ST} [data-st-sum]`);
    await klick(phone, '[data-mp-toggle="payments"]');
    await klick(phone, '[data-mp-action="add-payment"]'); await sleep(150);
    await tippe('[data-mp-field="pay:0:amount"]', '500');
    await klick(phone, '[data-mp-action="add-payment"]'); await sleep(150);
    await tippe('[data-mp-field="pay:1:method"]', 'benefit');
    await tippe('[data-mp-field="pay:1:amount"]', '400');
    const summen = await phone.ev(`return ['items', 'payments', 'partner:' + ${S(u1)}].map((k) => (document.querySelector('[data-mp-sum="' + k + '"]') || {}).textContent);`);
    const breite = await phone.ev('return [document.documentElement.scrollWidth, window.innerWidth];');
    ok(breite[0] <= breite[1], `M1 keine waagerechte Rollleiste bei 360 px (${S(breite)})`);
    await shot('real-form');
    await klick(phone, '#mpSubmitBtn');
    const gebucht = await warteBis(phone, `/Booked/.test(document.getElementById('mpStatusBar').textContent)`, 120000);
    await shot('real-booked');
    if (!gebucht) console.log('      (M1 Diagnose) ' + String(await text(phone, '#mpError')) + ' | ' + String(await text(phone, '#mpStatusBar')) + ' | ' + phone.antworten.slice(-6).join(' ; '));
    const kopf = dbQ(BIZ_DB, 'SELECT id, purchase_number, supplier_id, total_amount, paid_amount, remaining_amount, status FROM purchases ORDER BY rowid DESC LIMIT 1')[0] || {};
    PUR_NR = String(kopf.purchase_number || '');
    const zeilen = dbQ(BIZ_DB, 'SELECT id, product_id, quantity, unit_price, line_total FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [kopf.id]);
    const lose = dbQ(BIZ_DB, 'SELECT qty_total FROM stock_lots WHERE purchase_id = ? ORDER BY rowid', [kopf.id]).map((r) => r.qty_total);
    const zahlungen = dbQ(BIZ_DB, 'SELECT amount, method FROM purchase_payments WHERE purchase_id = ? ORDER BY rowid', [kopf.id]).map((r) => r.method + ':' + r.amount);
    const lieferant = dbQ(BIZ_DB, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [kopf.supplier_id])[0] || {};
    const teile = dbQ(BIZ_DB, 'SELECT party, share_bp, cost_share FROM item_participations WHERE purchase_line_id = ? ORDER BY party', [zeilen[0]?.id]).map((r) => r.party + ':' + r.share_bp + ':' + r.cost_share);
    // Die Fotos landen über den Anlageweg des Hauses am neuen Artikel: erst normalisiert in der Zeile,
    // später übernimmt sie die Medien-Migration des Hauses in den Medienspeicher (und leert die Zeile).
    // Gezählt wird beides zusammen — genau zwei, nie doppelt.
    await warteAuf(() => fotosAmArtikel(zeilen[0]?.product_id) === 2, 30);
    const bilder = fotosAmArtikel(zeilen[0]?.product_id);
    const kette = prodById(zeilen[1]?.product_id) || {};
    MESS.m1 = { nr: PUR_NR, summen, kopf, zeilen: zeilen.map((z) => [z.quantity, z.unit_price, z.line_total]), lose, zahlungen, teile, bilder, fotos };
    ok(home && maske && fotos === 2, `M1 Telefon: Einkaufsmaske, zwei Fotos an Position 1 (${fotos})`);
    ok(S(summen) === S(['2 positions · 4 pcs · 1,361.500 BHD', '900.000 / 1,361.500 BHD paid · 461.500 open', 'Partner 40 % · LATAIF 60 %']),
      `M1 Zusammenfassungen am Telefon (${S(summen)})`);
    ok(gebucht && /^PUR-/.test(PUR_NR) && einkaeufe() === vorher + 1 && nachweisFuer('purchases.create') === 1,
      `M1 der PRIMARY bucht genau einen Einkauf und vergibt die Nummer (${PUR_NR})`);
    ok(S([kopf.total_amount, kopf.paid_amount, kopf.remaining_amount, kopf.status]) === S([1361.5, 900, 461.5, 'PARTIALLY_PAID']),
      `M1 Summe 1361,5, bezahlt 900, offen 461,5 beim Lieferanten (${S(kopf)})`);
    ok(S(MESS.m1.zeilen) === S([[1, 1000, 1000], [3, 120.5, 361.5]]) && S(lose) === S([1, 3]) && Number(kette.quantity) === 3,
      `M1 zwei Positionen, Menge 3 als EIN Artikel mit Los 3 (${S(MESS.m1.zeilen)} ${S(lose)})`);
    ok(S(zahlungen) === S(['cash:500', 'benefit:400']) && unbalanced() === 0, `M1 zwei eigene Zahlungen, Hauptbuch ausgeglichen (${S(zahlungen)})`);
    ok(String(lieferant.linked_customer_id) === 'mp-cust', 'M1 Kunde → verknüpfte Lieferantenrolle (dieselbe Person)');
    ok(S(teile) === S(['HOUSE:6000:600', 'PARTNER:4000:400']), `M1 Partner 40 % aus 400 BHD, LATAIF 60 % (${S(teile)})`);
    ok(bilder === 2 && ablageLeer(), `M1 genau zwei Fotos am neuen Artikel (Zeile oder Medienspeicher, nie doppelt), Ablage leer (${bilder})`);
    let kAttr = {};
    try { kAttr = JSON.parse(String(kette.attributes || '{}')); } catch { kAttr = {}; }
    ok(steinKopf === 'Stones · 2 rows · Diamond 0.50 ct · Emerald 0.45 ct'
      && S(kAttr.stones) === S([{ type: 'diamond', qty: 1, carat: 0.5, clarity: 'VS1' }, { type: 'emerald', qty: 3, carat: 0.45 }]) && kAttr.diamond_weight === 0.5,
      `M1 STONES Steinliste vom Telefon am Primary: normalisiert, Diamond Weight 0.50 aus den Diamant-Zeilen (${steinKopf} | ${S(kAttr.stones)} | ${kAttr.diamond_weight})`);
    RV.m1 = gebucht && /^PUR-/.test(PUR_NR) && bilder === 2 && S(zahlungen) === S(['cash:500', 'benefit:400']);
  }

  // ══ M2 — Verlorene Antwort: „Send again" unter DERSELBEN Kennung, keine zweite Buchung ═══════════
  {
    const vorher = einkaeufe();
    const ledgerVor = Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM ledger_entries')[0]?.n || 0);
    await phone.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/command', requestStage: 'Response' }] }, 15000);
    let verworfen = 0;
    phone.paused = async (p) => {
      const rumpf = String(p.request?.postData || '');
      if (/purchases\.create/.test(rumpf) && verworfen === 0) {
        verworfen += 1;
        try { await phone.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionAborted' }, 15000); } catch { /* egal */ }
      } else { try { await phone.send('Fetch.continueRequest', { requestId: p.requestId }, 15000); } catch { /* egal */ } }
    };
    // Ein gebuchter Einkauf hat keinen eigenen „New purchase"-Knopf — zurück zur Liste, dort neu.
    await klick(phone, '#mpBackBtn');
    await sleep(300);
    await klick(phone, '#mpNewBtn');
    await sleep(500);
    await klick(phone, '[data-mp-action="supplier-mode"][data-mode="existing"]');
    await tippe('#mpSupSearch', 'E2E');
    await klick(phone, '[data-mp-action="search-supplier"]');
    await warteBis(phone, `document.querySelectorAll('[data-mp-action="pick-supplier"]').length > 0`, 30000);
    await klick(phone, '[data-mp-action="pick-supplier"]');
    const u = await uidVon(0);
    await pflicht(u, 'cat-gold-jewelry');
    await tippe(`[data-mp-field="item:${u}:quantity"]`, '2');
    await tippe(`[data-mp-field="item:${u}:unitPrice"]`, '75');
    await klick(phone, '#mpSubmitBtn');
    const wartet = await warteBis(phone, `/Waiting for main computer/.test(document.getElementById('mpStatusBar').textContent) && /No answer/.test(document.getElementById('mpStatusBar').textContent)`, 120000);
    const nachErstem = einkaeufe();
    await phone.send('Fetch.disable', {}, 15000).catch(() => null);
    phone.paused = null;
    await klick(phone, '[data-mp-action="resend"]');
    const gebucht = await warteBis(phone, `/Booked/.test(document.getElementById('mpStatusBar').textContent)`, 120000);
    const nachKlaerung = einkaeufe();
    const ledgerNach = Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM ledger_entries')[0]?.n || 0);
    MESS.m2 = { verworfen, wartet, nachErstem: nachErstem - vorher, nachKlaerung: nachKlaerung - vorher, nachweis: nachweisFuer('purchases.create'), ledger: ledgerNach - ledgerVor };
    ok(verworfen === 1 && wartet && nachErstem === vorher + 1, `M2 Antwort verloren: der Primary HAT gebucht, das Telefon wartet ehrlich (${S(MESS.m2)})`);
    ok(gebucht && nachKlaerung === nachErstem && nachweisFuer('purchases.create') === 2, `M2 „Send again" liefert das bekannte Ergebnis — kein zweiter Einkauf (${S(MESS.m2)})`);
    RV.m2 = verworfen === 1 && wartet && gebucht && nachKlaerung === nachErstem;
  }

  // ══ M3 — Kein Netz vor dem Senden: Entwurf bleibt, nichts gebucht; danach gebucht ══════════════
  {
    const vorher = einkaeufe();
    await phone.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/staging/media', requestStage: 'Request' }] }, 15000);
    phone.paused = async (p) => { try { await phone.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }, 15000); } catch { /* egal */ } };
    await klick(phone, '#mpBackBtn');
    await sleep(300);
    await klick(phone, '#mpNewBtn');
    await sleep(500);
    await klick(phone, '[data-mp-action="supplier-mode"][data-mode="person"]');
    await tippe('[data-mp-field="person.firstName"]', 'Mona');
    await tippe('[data-mp-field="person.lastName"]', 'Offline ' + STEMPEL);
    const u = await uidVon(0);
    await fotosLegen(u, 1);
    await pflicht(u, 'cat-gold-jewelry');
    await tippe(`[data-mp-field="item:${u}:unitPrice"]`, '55');
    await klick(phone, '#mpSubmitBtn');
    const wartet = await warteBis(phone, `/Not connected to the main computer/.test(document.getElementById('mpStatusBar').textContent)`, 60000);
    const unberuehrt = einkaeufe() === vorher;
    // Neustart der Seite: der wartende Einkauf samt Foto überlebt.
    await phone.send('Fetch.disable', {}, 15000).catch(() => null);
    phone.paused = null;
    await phone.ev('location.reload(); return 1;').catch(() => null);
    await sleep(2500);
    phone.close();
    phone = await attachOnly(EDGE_CDP, /\/mobile/, 60000);
    await phone.send('Network.enable', {}, 15000);
    await warteBis(phone, `${q('#modePicker')} && !document.getElementById('modePicker').classList.contains('hidden')`, 60000);
    await klick(phone, '.mode-btn[data-mode="mpurchase"]');
    // Beim Öffnen der Übersicht wird Wartendes erneut geschickt.
    const gebucht = await warteAuf(() => einkaeufe() === vorher + 1, 60);
    const person = dbQ(BIZ_DB, "SELECT c.id FROM customers c JOIN suppliers s ON s.linked_customer_id = c.id WHERE c.first_name = 'Mona'")[0];
    const pendant = dbQ(BIZ_DB, 'SELECT pl.product_id FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id ORDER BY p.rowid DESC LIMIT 1')[0] || {};
    await warteAuf(() => fotosAmArtikel(pendant.product_id) === 1, 30);
    const pendantBilder = fotosAmArtikel(pendant.product_id);
    const liste = await warteBis(phone, `/Booked/.test(document.getElementById('mpDraftList').textContent)`, 30000);
    MESS.m3 = { wartet, unberuehrt, gebucht, person: !!person, pendantBilder };
    ok(wartet && unberuehrt, `M3 ohne Netz: „Waiting", nichts gesendet, nichts gebucht (${S(MESS.m3)})`);
    ok(gebucht && !!person && liste && pendantBilder === 1, `M3 nach Neustart automatisch gesendet und gebucht, neue Person + verknüpfter Lieferant (${S(MESS.m3)})`);
    RV.m3 = wartet && unberuehrt && gebucht && !!person;
  }

  // ══ M4 — Grenzen: kein Abgleichkanal, Ablage leer, Hauptbuch ausgeglichen ═════════════════════
  {
    const pushs = phone.antworten.filter((z) => /api\/sync\/push/.test(String(z))).length;
    ok(pushs === 0 && ablageLeer() && unbalanced() === 0, `M4 kein /api/sync/push, keine verwaiste Ablage, Hauptbuch ausgeglichen (${pushs})`);
    RV.m4 = pushs === 0 && ablageLeer() && unbalanced() === 0;
  }

  const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid);
  ok(fremdVorher.every((pid) => fremdNachher.includes(pid)), `ISOLATION jede fremde lataif.exe von vorher laeuft noch (${fremdVorher.length} geprueft)`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  try { console.log('      (Telefon-Konsole) ' + (phone?.events || []).slice(-10).join('\n      ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { phone?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe');
}

clearTimeout(WACHHUND);
console.log('\n  MOBILE-PURCHASE                    Ergebnis');
for (const [k, v] of Object.entries(RV)) console.log(`  ${k.padEnd(34)}${v === true ? 'ja' : 'NEIN'}`);
console.log('  Messung ' + JSON.stringify(MESS));
const dauer = Math.round((Date.now() - T0) / 1000);
const ZEILE = `mobile purchase: real /mobile page books a full purchase through purchases.create on the real primary (client as supplier, items with qty, photos, partner, two payments), lost answer resent once, offline draft survives a restart and is booked (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) {
  console.log(`\nFAIL — ${ZEILE}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
if (Object.values(RV).every((v) => v === true)) console.log('MOBILE_PURCHASE_E2E_PROVED');
console.log(`\nPASS — ${ZEILE}`);
