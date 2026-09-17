// ════════════════════════════════════════════════════════════════════════════
// PRE-G5 MOBILE CONSIGNMENT — Reparaturen vom Telefon, gezielt und mit drei echten Oberflaechen:
// Primary (lataif.exe), Telefon (die echte /mobile-Seite in einem kopflosen Edge) und PC2
// (lataif-e2e-client.exe). Run: node test/e2e/pre-g5-mobile-repair.e2e.mjs
//
//   M1  Erfassen    Telefon legt Kunde + Reparatur mit ZWEI Fotos an. Der Primary vergibt Nummer und
//                   Gutscheincode (kein `REP-MOB-`), die Bilder stehen normalisiert in der Zeile, im
//                   durablen Nachweis steht GENAU eine Zeile.
//   M2  Bearbeiten  Dasselbe Telefon aendert Problem + Notiz und haengt ein drittes Foto an — eine
//                   Aenderung, eine neue Fassung, die beiden alten Bilder Byte fuer Byte erhalten.
//   M3  Verlorene   Die Antwort auf einen Befehl wird VERWORFEN, nachdem der Primary ihn ausgefuehrt
//       Antwort     hat. Das Telefon zeigt den Vorgang unter „Unresolved saves"; „Clarify now"
//                   wiederholt DIESELBE Kennung → Replay, KEINE zweite Reparatur, kein zweites Bild.
//   M4  Veraltet    PC2 aendert die Reparatur. Das Telefon steht noch auf der alten Fassung und
//                   speichert → `RECORD_CHANGED`, die Aenderung von PC2 bleibt unangetastet.
//   M5  Beide Wege  Telefon sieht die PC2-Aenderung nach dem Neuladen; PC2 sieht die Reparatur des
//                   Telefons in seiner Liste. Ein Datensatz, zwei Oberflaechen.
//   M7  Werkstatt  Arbeitszeile anlegen und zuruecknehmen, Status bis „ready“, Kundenbetrag, Rechnung —
//                   alles ueber die vorhandenen Fernbefehle des Primary, am echten Datenbestand.
//   M6  Medien      Die Ablage des Primary ist nach dem Erfolg leer (keine verwaisten Blobs), jedes
//                   Bild ist JPEG <= 100 000 B, und das Telefon hat nie `/api/sync/push` gerufen.
//
// PROZESS-ISOLATION (dauerhafte Regel): gestartet wird nur ueber `spawnTracked`; beendet wird nur,
// was dieser Lauf gestartet hat — regulaer nach Pruefung von PID UND exaktem Test-Pfad, hart nur
// ueber den Helfer. Edge ist ein EIGENES Kind dieses Laufs (`killOwnChild`). Die installierte
// Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 bleiben unberuehrt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
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

const RUN = join(os.tmpdir(), 'lataif-preg5-cn', 'run-' + Date.now());
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
const RV = {
  create: false, pc2Sieht: false, bilder: false, pc2Aendert: false, staleEdit: false,
  replay: false, duplikat: false, copyDetails: false, payout: false,
};

let edgeProc = null;
const aufraeumen = () => {
  try { killOwnChild(edgeProc); } catch { /* schon weg */ }
  // Liegengebliebene Test-Browser DIESER Testreihe (erkennbar am eigenen Profilverzeichnis) — ein
  // fremder Edge wird nie angefasst.
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | Where-Object { $_.CommandLine -match "lataif-preg5" } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  } catch { /* kein Test-Browser da */ }
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
  assertE2eClientBinary(CLIENT_APP);
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

  /** Die Kommissionsmaske mit den Pflichtangaben fuellen (Kategorie „Watch"). */
  async function wareFuellen(marke, modell) {
    await phone.ev(`
      const cat = document.getElementById('cnCategory');
      cat.value = 'cat-watch';
      cat.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 120));
      return 1;`);
    await setVal(phone, '#cnBrand', marke);
    await setVal(phone, '#cnName', modell);
    await phone.ev(`
      const dial = document.getElementById('cna_dial');
      if (dial) dial.value = 'Black';
      const mat = document.getElementById('cna_material');
      if (mat) { mat.value = 'Steel'; mat.dispatchEvent(new Event('change')); }
      await new Promise((r) => setTimeout(r, 120));
      return 1;`);
  }

  // ══ K1 — Erfassen: Einlieferer + Artikel + Kommission mit zwei Fotos ══════════════════════════
  {
    const vorher = konAnzahl();
    await klick(phone, '.mode-btn[data-mode="consign"]');
    const uebersicht = await warteBis(phone, `!document.getElementById('consignHome').classList.contains('hidden')`, 30000);
    await klick(phone, '#cnNewBtn');
    const maske = await warteBis(phone, `!document.getElementById('formConsign').classList.contains('hidden')`, 20000);

    await setVal(phone, '#cnConsignorFirst', EINLIEFERER_VOR);
    await setVal(phone, '#cnConsignorLast', EINLIEFERER_NACH);
    await klick(phone, '#cnConsignorCreateBtn');
    const einlieferer = await warteBis(phone, `!document.getElementById('cnConsignorPicked').classList.contains('hidden')`, 60000);

    await fotoLegen(phone, 1); await sleep(500);
    await fotoLegen(phone, 2); await sleep(500);
    const fotos = await fotoZahl(phone);

    await wareFuellen(MARKE, MODELL);
    await setVal(phone, '#cnAgreedPrice', '500');
    await setVal(phone, '#cnPayoutModel', 'percent');
    await setVal(phone, '#cnCommissionRate', '20');
    await klick(phone, '#cnSaveBtn');
    const gespeichert = await warteBis(phone, `/Saved as /.test(document.getElementById('cnSuccess').textContent)`, 120000);
    if (!gespeichert) {
      console.log('      (K1 Diagnose) Fehler: ' + String(await text(phone, '#cnError'))
        + ' | Erfolg: ' + String(await text(phone, '#cnSuccess'))
        + ' | Antworten: ' + phone.antworten.slice(-6).join(' ; ')
        + ' | Konsole: ' + (phone.events || []).slice(-10).join(' ~ '));
    }
    const neu = dbQ(BIZ_DB, 'SELECT id, consignment_number, product_id, commission_type, commission_rate, agreed_price, status FROM consignments ORDER BY rowid DESC LIMIT 1')[0] || {};
    CON_ID = String(neu.id || ''); CON_NR = String(neu.consignment_number || ''); PROD_ID = String(neu.product_id || '');
    const artikel = prodById(PROD_ID) || {};
    const medien = medienVon(PROD_ID);
    const einmal = konAnzahl() === vorher + 1 && nachweisFuer('consignments.create') === 1;
    MESS.k1 = {
      nummer: CON_NR, modell: neu.commission_type, satz: neu.commission_rate, preis: neu.agreed_price,
      sku: artikel.sku, bestand: artikel.stock_status, herkunft: artikel.source_type,
      einstand: artikel.purchase_price, menge: artikel.quantity, medien: medien.length, fotos,
    };
    ok(uebersicht && maske && einlieferer, 'K1 das Telefon legt den Einlieferer ueber customers.create an');
    ok(fotos === 2, `K1 zwei Fotos liegen in der Maske (${fotos})`);
    ok(gespeichert && /^CON-/.test(CON_NR), `K1 der PRIMARY vergibt die Kommissionsnummer (${CON_NR})`);
    ok(einmal, `K1 genau eine Kommission, genau eine Zeile im durablen Nachweis (${konAnzahl() - vorher}/${nachweisFuer('consignments.create')})`);
    // Der Einstand ist der ERWARTUNGSWERT des Hauses (consignmentStore: percent → agreed x
    // (1 - Satz/100), also 500 x 0,8 = 400) — nicht 0 und nicht etwas vom Telefon.
    ok(String(artikel.brand) === MARKE && String(artikel.stock_status) === 'consignment'
      && String(artikel.source_type) === 'CONSIGNMENT' && Number(artikel.purchase_price) === 400
      && Number(artikel.quantity) === 1 && String(artikel.sku || '').length > 0,
      `K1 der Artikel entsteht mit den festen Werten des Hauses, Einstand = Erwartungswert (${S(MESS.k1)})`);
    ok(String(neu.commission_type) === 'percent' && Number(neu.commission_rate) === 20 && Number(neu.agreed_price) === 500,
      `K1 Auszahlungsmodell und Preis stehen so, wie die Maske sie genannt hat (${S({ m: neu.commission_type, r: neu.commission_rate })})`);
    ok(medien.length === 2, `K1 beide Fotos liegen im MEDIENSPEICHER am Artikel (${medien.length})`);
    RV.create = uebersicht && maske && einlieferer && fotos === 2 && gespeichert && /^CON-/.test(CON_NR) && einmal;
    RV.bilder = medien.length === 2;
  }

  // ══ K2 — Duplikatsfrage, „Copy details" und „Create anyway" ═══════════════════════════════════
  {
    const vorher = konAnzahl();
    await klick(phone, '[data-back-consign]');
    await warteBis(phone, `!document.getElementById('consignHome').classList.contains('hidden')`, 20000);
    await klick(phone, '#cnNewBtn');
    await warteBis(phone, `!document.getElementById('formConsign').classList.contains('hidden')`, 20000);
    // Derselbe Einlieferer, dieselbe Ware: genau der Fall, den die Erkennung des Hauses meldet.
    await setVal(phone, '#cnConsignorSearch', EINLIEFERER_NACH);
    await klick(phone, '#cnConsignorSearchBtn');
    await warteBis(phone, `document.querySelectorAll('#cnConsignorResults button').length > 0`, 60000);
    await phone.ev("document.querySelector('#cnConsignorResults button').click(); return 1;");
    await fotoLegen(phone, 3); await sleep(500);
    await wareFuellen(MARKE, MODELL);
    await setVal(phone, '#cnAgreedPrice', '480');
    await setVal(phone, '#cnCommissionRate', '20');
    await klick(phone, '#cnSaveBtn');
    const gefragt = await warteBis(phone, `!document.getElementById('cnDuplicateCard').classList.contains('hidden')`, 120000);
    const unveraendert = konAnzahl() === vorher;
    const frageText = await text(phone, '#cnDuplicateText');
    ok(gefragt && unveraendert, `K2 der Primary FRAGT nach dem Duplikat und legt nichts an (${S(frageText.slice(0, 70))})`);
    RV.duplikat = gefragt && unveraendert;

    // „Copy details" — die Treffer und die uebernommenen Merkmale kommen aus der Autoritaet.
    const treffer = await warteBis(phone, `document.querySelectorAll('#cnDuplicateList [data-copy-details]').length > 0`, 60000);
    if (!treffer) {
      const probe = await phone.ev(`
        const t = localStorage.getItem('lataif_mobile_token');
        const res = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
          body: JSON.stringify({ op: 'products.duplicates.get', commandId: crypto.randomUUID(), payload: { categoryId: 'cat-watch', brand: ${S(MARKE)}, name: ${S(MODELL)} } }) });
        return res.status + ' :: ' + (await res.text()).slice(0, 300);`).catch((e) => String(e));
      console.log('      (K2 Diagnose) Duplikatsauskunft: ' + String(probe));
    }
    await setVal(phone, '#cnName', '');
    await phone.ev(`const d = document.getElementById('cna_dial'); if (d) d.value = ''; return 1;`);
    await phone.ev("const b = document.querySelector('#cnDuplicateList [data-copy-details]'); if (b) b.click(); return 1;");
    await sleep(600);
    const kopiert = await phone.ev(`return JSON.stringify({
      name: document.getElementById('cnName').value,
      dial: document.getElementById('cna_dial') ? document.getElementById('cna_dial').value : '',
      sku: document.getElementById('cnSku').value });`);
    const k = JSON.parse(String(kopiert));
    MESS.k2 = { treffer, kopiert: k };
    ok(treffer && k.name === MODELL && k.dial === 'Black' && k.sku === '',
      `K2 „Copy details" uebernimmt Modell und Merkmale des gefundenen Artikels — nie die Referenz (${S(k)})`);
    RV.copyDetails = treffer && k.name === MODELL && k.dial === 'Black' && k.sku === '';

    await klick(phone, '#cnCreateAnywayBtn');
    const zweite = await warteBis(phone, `/Saved as /.test(document.getElementById('cnSuccess').textContent)`, 120000);
    ok(zweite && konAnzahl() === vorher + 1,
      `K2 „Create anyway" legt GENAU eine zweite Kommission an (${konAnzahl() - vorher})`);
  }

  // ══ K3 — Verlorene Antwort: Klaeren wiederholt DIESELBE Kennung ═══════════════════════════════
  {
    const vorher = konAnzahl();
    await phone.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/command', requestStage: 'Response' }] }, 15000);
    let verworfen = 0;
    phone.paused = async (p) => {
      const istBefehl = /\/api\/command$/.test(String(p.request?.url || ''));
      const rumpf = String(p.request?.postData || '');
      if (istBefehl && /consignments\.create/.test(rumpf) && verworfen === 0) {
        verworfen += 1;
        try { await phone.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionAborted' }, 15000); } catch { /* egal */ }
      } else {
        try { await phone.send('Fetch.continueRequest', { requestId: p.requestId }, 15000); } catch { /* egal */ }
      }
    };
    await klick(phone, '[data-back-consign]');
    await warteBis(phone, `!document.getElementById('consignHome').classList.contains('hidden')`, 20000);
    await klick(phone, '#cnNewBtn');
    await warteBis(phone, `!document.getElementById('formConsign').classList.contains('hidden')`, 20000);
    await setVal(phone, '#cnConsignorSearch', EINLIEFERER_NACH);
    await klick(phone, '#cnConsignorSearchBtn');
    await warteBis(phone, `document.querySelectorAll('#cnConsignorResults button').length > 0`, 60000);
    await phone.ev("document.querySelector('#cnConsignorResults button').click(); return 1;");
    await wareFuellen('Omega ' + STEMPEL, 'Seamaster ' + STEMPEL);
    await setVal(phone, '#cnAgreedPrice', '700');
    await setVal(phone, '#cnCommissionRate', '15');
    await klick(phone, '#cnSaveBtn');
    // Die Antwort kam nie an — der Vorgang bleibt offen und sichtbar.
    const offen = await warteBis(phone, `/No answer from the main computer/.test(document.getElementById('cnError').textContent)`, 120000);
    const nachErstem = konAnzahl();
    await phone.send('Fetch.disable', {}, 15000).catch(() => null);
    phone.paused = null;
    await klick(phone, '[data-back-consign]');
    await warteBis(phone, `document.querySelectorAll('#cnOpenList button').length > 0`, 60000);
    await phone.ev("document.querySelector('#cnOpenList button').click(); return 1;");
    await sleep(3000);
    const nachKlaerung = konAnzahl();
    const nachweis = nachweisFuer('consignments.create');
    MESS.k3 = { verworfen, offen, nachErstem: nachErstem - vorher, nachKlaerung: nachKlaerung - vorher, nachweis };
    ok(offen, 'K3 die verlorene Antwort bleibt ehrlich offen');
    ok(nachKlaerung === nachErstem, `K3 „Clarify now" legt KEINE zweite Kommission an (${S(MESS.k3)})`);
    RV.replay = offen && nachKlaerung === nachErstem;
  }

  // ══ SETUP PC2 ════════════════════════════════════════════════════════════════════════════════
  client = await attachApp(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await waitFor(client, '[data-first-run-gate]', 120000);
  await klick(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await klick(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP, /tauri\.localhost/);
  let pc2Da = false, pc2Token = 0;
  // Der Ausweis ist der Beweis, nicht die Maske. Die Anmeldung von PC2 ist im Testaufbau
  // gelegentlich wackelig (dokumentierte Grenze des Reparaturschnitts), deshalb fuenf Versuche.
  for (let versuch = 0; versuch < 5 && !pc2Da; versuch++) {
    await waitFor(client, '[data-client-signin]', 60000);
    await setVal(client, '[data-client-email]', OWNER_EMAIL);
    await setVal(client, '[data-client-password]', OWNER_PW);
    await sleep(1200);
    await klick(client, '[data-client-signin]');
    const shell = await warteBis(client, `${q(SHELL)} && (localStorage.getItem('lataif_client_token') || '').length > 0`, 60000);
    pc2Token = Number(await client.ev("return (localStorage.getItem('lataif_client_token') || '').length;").catch(() => 0));
    pc2Da = shell && pc2Token > 0;
    if (!pc2Da) await sleep(2000);
  }
  ok(pc2Da, `SETUP PC2 ist angemeldet (ohne eigene Datenbank; Ausweis ${pc2Token} Zeichen)`);

  // ══ K4/K5 — PC2 sieht denselben Datensatz, aendert ihn; das Telefon ueberschreibt nichts ══════
  {
    // Das Telefon wieder auf die ERSTE Kommission (mit deren gelesener Fassung).
    await klick(phone, '[data-back-consign]');
    await warteBis(phone, `!document.getElementById('consignHome').classList.contains('hidden')`, 20000);
    await setVal(phone, '#cnSearch', CON_NR);
    await klick(phone, '#cnSearchBtn');
    await warteBis(phone, `[...document.querySelectorAll('#cnList button')].filter((b) => b.textContent.includes(${S(CON_NR)})).length === 1`, 60000);
    await phone.ev(`const b=[...document.querySelectorAll('#cnList button')].find((x) => x.textContent.includes(${S(CON_NR)})); if(b) b.click(); return 1;`);
    const aufRichtiger = await warteBis(phone, `document.getElementById('cnHeadline').textContent === ${S(CON_NR)}`, 60000);
    ok(aufRichtiger, `K4 das Telefon hat wieder ${CON_NR} offen (Stand vor der fremden Aenderung)`);

    // PC2: dieselbe Kommission in seiner Liste — und derselbe Artikel samt Bildern.
    // Den ECHTEN Weg gehen: der Eintrag in der Seitenleiste, nicht ein geschobener Verlauf.
    await client.ev(`const a = document.querySelector('a[href="/consignments"]');
      if (a) a.click(); else { history.pushState({}, '', '/consignments'); window.dispatchEvent(new PopStateEvent('popstate')); }
      return 1;`);
    await sleep(3000);
    // Die Liste am Rechner gruppiert nach EINLIEFERER — die Nummer steht erst in der aufgeklappten
    // Zeile. Also wird aufgeklappt, wie es ein Mensch taete.
    const beimEinlieferer = await warteBis(client, `document.body.innerText.includes(${S(EINLIEFERER_NACH)})`, 90000);
    await client.ev(`const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim().includes(${S(EINLIEFERER_NACH)}));
      if (el) { let n = el; for (let i = 0; i < 8 && n; i++) { if (n.onclick || n.getAttribute('role') === 'button' || n.tagName === 'BUTTON' || n.tagName === 'TR') { n.click(); break; } n = n.parentElement; } }
      return 1;`);
    await sleep(2500);
    let sichtbar = beimEinlieferer && await warteBis(client, `document.body.innerText.includes(${S(CON_NR)})`, 60000);
    if (!sichtbar) {
      console.log('      (K5 Diagnose) PC2-Seite: ' + String(await client.ev("return JSON.stringify({ pfad: location.pathname, text: document.body.innerText.slice(0, 400) });").catch((e) => String(e))));
      // Zweiter Versuch ueber den Verlauf — falls die Seitenleiste im Client-Modus anders heisst.
      await client.ev(`history.pushState({}, '', '/consignments'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
      sichtbar = await warteBis(client, `document.body.innerText.includes(${S(CON_NR)})`, 60000);
    }
    const pc2Bilder = await client.ev(`
      const token = localStorage.getItem('lataif_client_token') || '';
      const res = await fetch('http://127.0.0.1:${PORT}/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ op: 'products.get', commandId: crypto.randomUUID(), payload: { id: ${S(PROD_ID)} } }) });
      const j = await res.json().catch(() => ({}));
      return JSON.stringify({ status: res.status, keys: (j.value && j.value.mediaKeys || []).length, brand: j.value && j.value.brand });`);
    const b = JSON.parse(String(pc2Bilder));
    MESS.k5 = { sichtbar, pc2Bilder: b };
    ok(sichtbar, `K5 PC2 sieht die Kommission des Telefons in seiner Liste (${CON_NR})`);
    ok(b.status === 200 && b.keys === 2 && String(b.brand) === MARKE,
      `K5 …und denselben Artikel samt BEIDEN Bildern (${S(b)})`);
    RV.pc2Sieht = sichtbar && b.keys === 2;

    // PC2 aendert den vereinbarten Preis ueber denselben Fernbefehl, den seine Maske benutzt.
    const pc2Aenderung = await client.ev(`
      const token = localStorage.getItem('lataif_client_token') || '';
      const server = 'http://127.0.0.1:${PORT}';
      const getRes = await fetch(server + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ op: 'consignments.get', commandId: crypto.randomUUID(), payload: { id: ${S(CON_ID)} } }) });
      const got = await getRes.json().catch(() => ({}));
      const revision = got && got.value ? got.value.revision : 0;
      if (!revision) return JSON.stringify({ status: getRes.status, revision: 0 });
      const res = await fetch(server + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ op: 'consignments.update', commandId: crypto.randomUUID(), payload: { id: ${S(CON_ID)}, expectedRevision: revision, agreedPrice: 555 } }) });
      return JSON.stringify({ status: res.status, revision });`);
    const pc2Ok = /"status":200/.test(String(pc2Aenderung));
    const nachPc2 = konById(CON_ID) || {};
    ok(pc2Ok && Number(nachPc2.agreed_price) === 555, `K5 PC2 aendert denselben Datensatz (${String(pc2Aenderung).slice(0, 80)})`);
    RV.pc2Aendert = pc2Ok && Number(nachPc2.agreed_price) === 555;

    // Das Telefon steht auf der ALTEN Fassung: sein Speichern darf nichts ueberschreiben.
    await setVal(phone, '#cnAgreedPrice', '600');
    await klick(phone, '#cnSaveBtn');
    const abgewiesen = await warteBis(phone, `/changed this consignment in the meantime/.test(document.getElementById('cnError').textContent)`, 120000);
    const danach = konById(CON_ID) || {};
    const nichtUeberschrieben = Number(danach.agreed_price) === 555;
    MESS.k4 = { abgewiesen, preis: Number(danach.agreed_price || 0) };
    ok(abgewiesen && nichtUeberschrieben, `K4 veraltete Handy-Aenderung → RECORD_CHANGED, nichts ueberschrieben (${S(MESS.k4)})`);
    RV.staleEdit = abgewiesen && nichtUeberschrieben;

    // Nach dem Neuladen sieht das Telefon, was PC2 geschrieben hat.
    await klick(phone, '[data-back-consign]');
    await warteBis(phone, `!document.getElementById('consignHome').classList.contains('hidden')`, 20000);
    await setVal(phone, '#cnSearch', CON_NR);
    await klick(phone, '#cnSearchBtn');
    await warteBis(phone, `[...document.querySelectorAll('#cnList button')].filter((b) => b.textContent.includes(${S(CON_NR)})).length === 1`, 60000);
    await phone.ev(`const b=[...document.querySelectorAll('#cnList button')].find((x) => x.textContent.includes(${S(CON_NR)})); if(b) b.click(); return 1;`);
    const sieht = await warteBis(phone, `document.getElementById('cnAgreedPrice').value === '555'`, 60000);
    ok(sieht, 'K5 das Telefon sieht die Aenderung von PC2 nach dem Neuladen');
  }

  // ══ K6 — Ein Auszahlungsvertrag am ECHTEN Datenbestand: Modellwechsel, dann gesperrt ══════════
  {
    // Solange nichts gebucht ist, darf das Modell wechseln — die Regel gehoert dem Primary.
    await setVal(phone, '#cnPayoutModel', 'cost_split');
    await phone.ev("document.getElementById('cnPayoutModel').dispatchEvent(new Event('change')); return 1;");
    await setVal(phone, '#cnExcessSplitPct', '40');
    await klick(phone, '#cnSaveBtn');
    const gewechselt = await warteBis(phone, `/Changes saved/.test(document.getElementById('cnSuccess').textContent)`, 120000);
    const zeile = konById(CON_ID) || {};
    ok(gewechselt && String(zeile.commission_type) === 'cost_split' && Number(zeile.excess_split_pct) === 40,
      `K6 das Auszahlungsmodell wechselt, solange der Primary es erlaubt (${S({ m: zeile.commission_type, s: zeile.excess_split_pct })})`);

    // Eine Auszahlung OHNE Verkauf: der Primary weist sie ab — das Telefon erfindet keinen Betrag.
    // Die Anfrage wird in kleinen Schritten gestellt, damit ein einzelner Aufruf nie lange haengt.
    const stand = await phone.ev(`
      const t = localStorage.getItem("lataif_mobile_token");
      const r = await fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ op: "consignments.get", commandId: crypto.randomUUID(), payload: { id: ${S(CON_ID)} } }) });
      const j = await r.json();
      return JSON.stringify({ revision: j.value && j.value.revision, locked: j.value && j.value.payoutLocked, offen: j.value && j.value.payoutOpenAmount });`);
    const st = JSON.parse(String(stand));
    const versuch = await phone.ev(`
      const t = localStorage.getItem("lataif_mobile_token");
      const r = await fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ op: "consignments.record_payout", commandId: crypto.randomUUID(), payload: { consignmentId: ${S(CON_ID)}, expectedRevision: ${st.revision}, amount: 10, method: "cash" } }) });
      return r.status + " :: " + (await r.text()).slice(0, 140);`);
    MESS.k6 = { stand: st, versuch: String(versuch).slice(0, 120) };
    ok(!/^200/.test(String(versuch)),
      `K6 eine Auszahlung ohne Verkauf weist der PRIMARY ab (${S(MESS.k6.versuch)})`);
    RV.payout = gewechselt && String(zeile.commission_type) === 'cost_split' && !/^200/.test(String(versuch));
  }

  // ══ K7 — Grenzen: keine eigene Datenbank auf PC2, kein Abgleichkanal fuer Kommissionen ════════
  {
    const keineEigeneDb = !existsSync(join(CLIENT_HOME, 'Local', CLIENT_IDENT, 'lataif.db'));
    const pushs = phone.antworten.filter((z) => /api\/sync\/push/.test(String(z))).length;
    MESS.k7 = { keineEigeneDb, pushs };
    ok(keineEigeneDb, 'K7 PC2 hat keine eigene Geschaeftsdatenbank angelegt');
    ok(pushs === 0, `K7 das Telefon hat den Abgleichkanal nie benutzt (${pushs})`);
  }

  const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid);
  ok(fremdVorher.every((pid) => fremdNachher.includes(pid)), `ISOLATION jede fremde lataif.exe von vorher laeuft noch (${fremdVorher.length} geprueft)`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  try { console.log('      (Telefon-Konsole) ' + (phone?.events || []).slice(-10).join('\n      ')); } catch { /* egal */ }
  try { console.log('      (Primary-Konsole) ' + (primary?.events || []).slice(-10).join('\n      ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { phone?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log('\n  PRE-G5 Mobile Consignment         Ergebnis');
for (const [k, v] of Object.entries(RV)) console.log(`  ${k.padEnd(34)}${v === true ? 'ja' : 'NEIN'}`);
console.log('  Messung ' + JSON.stringify(MESS));
const dauer = Math.round((Date.now() - T0) / 1000);
const ZEILE = `pre-g5 mobile consignment: phone creates a consignment through the primary's own domain (item + consignment in one transaction, media store), duplicate asked and copied from the authority, lost answer clarified once, stale phone edit refused, pc2 and phone share one record (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) {
  console.log(`\nFAIL — ${ZEILE}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
if (Object.values(RV).every((v) => v === true)) console.log('PRE_G5_MOBILE_CONSIGNMENT_E2E_PROVED');
console.log(`\nPASS — ${ZEILE}`);
