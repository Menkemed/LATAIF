// ════════════════════════════════════════════════════════════════════════════
// PRE-G5 MOBILE REPAIR — Reparaturen vom Telefon, gezielt und mit drei echten Oberflaechen:
// Primary (lataif.exe), Telefon (die echte /mobile-Seite in einem kopflosen Edge) und PC2
// (lataif-e2e-client.exe). Run: node test/e2e/pre-g5-mobile-repair.e2e.mjs
//
//   M1  Erfassen    Telefon legt Kunde (mit Vorwahl + Ausweisnummer) + Reparatur mit ZWEI Fotos an. Der
//                   Primary vergibt Nummer und Gutscheincode (kein `REP-MOB-`), die Bilder liegen
//                   normalisiert im Medienkern der Reparatur (seit MEDIA-REPAIR, 2026-09-20 — nicht mehr
//                   in `repairs.images`), im durablen Nachweis steht GENAU eine Zeile.
//   M2  Bearbeiten  Dasselbe Telefon aendert Problem + Notiz und haengt ein drittes Foto an — eine
//                   Aenderung, eine neue Fassung, die beiden alten Bilder bleiben (dasselbe Medium, derselbe Inhalt).
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
// ueber den Helfer. Edge wird ueber seine EIGENE Debug-Verbindung geschlossen (`edgeSchliessen`) —
// `killOwnChild` bleibt nur der Rueckfall. Die installierte
// Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 bleiben unberuehrt. Kein aeusseres
// `timeout` um diesen Lauf: es beendet nur node, und App wie Browser blieben verwaist stehen —
// die Zeitgrenze ist der WACHHUND unten, er raeumt vorher auf.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import {
  killStarted, killTestImage, killTestPid, killOwnChild, spawnTracked, waitTestImageGone,
  foreignProcesses, pathOfPid, startedPids, waitPidGone,
} from './_e2e-process.mjs';
import { edgeBrowserEndpoint, closeEdge, waitEdgeProfileGone } from './_e2e-browser.mjs';
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

const RUN = join(os.tmpdir(), 'lataif-preg5', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
// PC2 legt seinen Fenster-Speicher (EBWebView: Server, Ausweis, Sitzung) und seine offenen Speichervorgaenge
// (`pending-saves`) unter dem ECHTEN LocalAppData seiner Test-Kennung ab — die Umleitung ueber die Umgebung
// greift dort nicht. Ohne Neuanfang startet PC2 mit dem Ausweis eines frueheren Laufs fuer einen Server, den
// es nicht mehr gibt: keine Erststart-Maske, keine Anmeldemaske, jede Anfrage 401. Dieser Ordner gehoert nur
// der Test-Kennung (nie der Produktion) und wird deshalb zu Beginn geleert — wie APP_DATA_DIR des Primary.
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const CLIENT_LOCAL_STATE = join(REAL_LOCALAPPDATA, CLIENT_IDENT);
const STAGING_ROOT = join(APP_DATA_DIR, 'command-staging');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();
const MESS = {};
const RV = { create: false, edit: false, lostAnswer: false, staleEdit: false, bothSurfaces: false, workshop: false, media: false };

let edgeProc = null;
let edgeBrowserWs = '';
/** Den Test-Browser ueber seine EIGENE Debug-Verbindung schliessen — warum, steht in `_e2e-browser.mjs`. */
async function edgeSchliessen() {
  if (await closeEdge(edgeBrowserWs, EDGE_CDP)) edgeBrowserWs = '';
  return !edgeBrowserWs;
}
const aufraeumen = () => {
  try { killOwnChild(edgeProc); } catch { /* schon weg */ }
  // Nur der EIGENE Test-Browser (PID + Startpfad geprüft, samt Prozessbaum) — nie nach Name oder
  // Befehlszeile: jeder Lauf hat ein eigenes Profil unter RUN, ein Rest eines früheren Laufs stört nicht.
  killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe');
};
// `PREG5_WACHHUND_MS` verkuerzt die Grenze — nur um den Aufraeumweg bei einer Zeitueberschreitung zu beweisen.
const WACHHUND = setTimeout(async () => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  await edgeSchliessen();
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  const rest = await waitEdgeProfileGone(EDGE_PROFILE);
  console.log('  ABBRUCH-AUFRAEUMEN ' + JSON.stringify({ edgeGestartet: !!edgeProc, browserZu: !edgeBrowserWs, reste: rest }));
  process.exit(1);
}, Number(process.env.PREG5_WACHHUND_MS) || 70 * 60 * 1000);

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
  // Die Browser-Verbindung DIESES Browsers — damit wird er am Ende geschlossen (siehe `edgeSchliessen`).
  edgeBrowserWs = await edgeBrowserEndpoint(EDGE_CDP);
  return c;
}

/** Ein echtes, kleines JPEG als Daten-URL — auf der Seite gerechnet, wie ein Kamerabild. */
const MAKE_PHOTO = (seed) => `
  const c = document.createElement('canvas'); c.width = 240; c.height = 180;
  const x = c.getContext('2d');
  x.fillStyle = 'hsl(' + (${seed} * 47 % 360) + ',60%,50%)'; x.fillRect(0, 0, 240, 180);
  x.fillStyle = '#111'; x.font = '28px sans-serif'; x.fillText('P${seed}', 20, 100);
  return c.toDataURL('image/jpeg', 0.9);`;

/** Ein Foto in die Maske legen — ueber den Datei-Eingang der Kamera (Vorgabe) oder der Galerie (MOBILE-REPAIR-GALLERY). */
async function fotoLegen(phone, seed, eingang = 'rpPhotoInput') {
  return phone.ev(`
    const dataUrl = await (async () => { ${MAKE_PHOTO(seed)} })();
    const res = await fetch(dataUrl); const blob = await res.blob();
    const file = new File([blob], 'p${seed}.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(file);
    const inp = document.getElementById(${S(eingang)});
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK';`);
}
const fotoZahl = (phone) => phone.ev("return document.querySelectorAll('#rpPhotoStrip .photo-thumb').length;");

// ── Geschaeftsdaten lesen ───────────────────────────────────────────────────
const repZeile = (nr) => dbQ(BIZ_DB, 'SELECT * FROM repairs WHERE repair_number = ?', [nr])[0] || null;
const repById = (id) => dbQ(BIZ_DB, 'SELECT * FROM repairs WHERE id = ?', [id])[0] || null;
const repAnzahl = () => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM repairs')[0]?.n || 0);
const nachweisFuer = (op) => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM remote_command_ledger WHERE op = ?', [op])[0]?.n || 0);
// MEDIA-REPAIR (seit 2026-09-20) — die Fotos einer Reparatur liegen im Medienkern: Verknuepfung → Medium →
// aktuelle Generation. `repairs.images` ist nur noch der Altweg und wird beim Speichern geleert.
const fotosVon = (id) => dbQ(BIZ_DB, `SELECT l.media_id AS media, g.stored_blob_hash AS hash, g.byte_size AS bytes,
    g.mime_type AS mime, g.gen_status AS stand
  FROM media_links l
  JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
  JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
  JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
  WHERE l.entity_type = 'repair' AND l.entity_id = ? AND l.media_role = 'gallery' AND l.deleted_at IS NULL
  ORDER BY l.sort_order ASC`, [id]);
const fotoGut = (f) => f.mime === 'image/jpeg' && Number(f.bytes) > 0 && Number(f.bytes) <= 100000 && f.stand === 'available';
const bildspalteLeer = (id) => { const v = String(repById(id)?.images ?? ''); return v === '' || v === '[]' || v === 'null'; };
const stagingDateien = () => {
  const out = [];
  const lauf = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) lauf(p); else out.push(p); } };
  lauf(STAGING_ROOT);
  return out;
};

// ════════════════════════════════════════════════════════════════════════════
let primary = null, phone = null, client = null;
let REP_ID = '', REP_NR = '';
const STEMPEL = Date.now().toString(36);
const ISSUE1 = 'Crown loose ' + STEMPEL;
const ISSUE2 = 'Crown loose and glass scratched ' + STEMPEL;
const BRAND = 'Rolex ' + STEMPEL;
const KUNDE_VOR = 'PreG5', KUNDE_NACH = 'Phone ' + STEMPEL;

try {
  assertE2eClientBinary(CLIENT_APP);
  if (!existsSync(SEED)) throw new Error('e2e_scope_seed.exe fehlt: ' + SEED);
  if (!existsSync(EDGE)) throw new Error('Edge nicht gefunden: ' + EDGE);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  if (existsSync(CLIENT_LOCAL_STATE)) rmSync(CLIENT_LOCAL_STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ══ SETUP — Primary einrichten, Server-Zugang setzen, Server starten ═══════════════════════════
  primary = await attachApp(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PreG5 Repair Co');
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
  // Regulaer schliessen, den Server-Zugang setzen, neu starten.
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

  // ══ SETUP — Telefon: die echte /mobile-Seite, Anmeldung mit dem Server-Zugang ══════════════════
  phone = await startEdge(`${BASE}/mobile`);
  await waitFor(phone, '#login', 60000);
  await setVal(phone, '#email', OWNER_EMAIL);
  await setVal(phone, '#password', OWNER_PW);
  await klick(phone, '#loginBtn');
  const angemeldet = await warteBis(phone, `${q('#modePicker')} && !document.getElementById('modePicker').classList.contains('hidden')`, 60000);
  ok(angemeldet, 'SETUP das Telefon ist angemeldet (echte Seite, echter Zugang)');

  // ══ M1 — Erfassen: Kunde + Reparatur mit zwei Fotos ═══════════════════════════════════════════
  {
    const vorher = repAnzahl();
    await klick(phone, '.mode-btn[data-mode="repair"]');
    const uebersicht = await warteBis(phone, `!document.getElementById('repairHome').classList.contains('hidden')`, 30000);
    await klick(phone, '#rpNewBtn');
    const maske = await warteBis(phone, `!document.getElementById('formRepair').classList.contains('hidden')`, 20000);

    await setVal(phone, '#rpCustomerFirst', KUNDE_VOR);
    await setVal(phone, '#rpCustomerLast', KUNDE_NACH);
    // MOBILE-CONTACT — Vorwahl + Nummer + Ausweisnummer wie am Rechner; der Primary speichert E.164.
    await setVal(phone, '#rpCustomerPhoneIso', 'SA');
    await setVal(phone, '#rpCustomerPhone', '5 1234 5678');
    await setVal(phone, '#rpCustomerPersonalId', ' 900123456 ');
    await klick(phone, '#rpCustomerCreateBtn');
    const kundeDa = await warteBis(phone, `!document.getElementById('rpCustomerPicked').classList.contains('hidden')`, 60000);
    const kundenZeilen = dbQ(BIZ_DB, 'SELECT id, phone, personal_id FROM customers WHERE first_name = ? AND last_name = ?', [KUNDE_VOR, KUNDE_NACH]);
    const kontakt = kundenZeilen[0] || {};
    ok(kundenZeilen.length === 1 && kontakt.phone === '+966512345678' && kontakt.personal_id === '900123456',
      `M1 KONTAKT der Primary speichert die Nummer international und die Ausweisnummer (${S({ phone: kontakt.phone, personalId: kontakt.personal_id })})`);
    const zurueck = await phone.ev("return { iso: document.getElementById('rpCustomerPhoneIso').value, nr: document.getElementById('rpCustomerPhone').value, id: document.getElementById('rpCustomerPersonalId').value };");
    ok(zurueck.iso === 'BH' && zurueck.nr === '' && zurueck.id === '', `M1 KONTAKT nach dem Anlegen steht die Maske wieder auf Bahrain und leer (${S(zurueck)})`);

    // MOBILE-REPAIR-GALLERY — ein Foto von der Kamera, eines aus der Galerie: beide in dieselbe Reparatur.
    await fotoLegen(phone, 1); await sleep(400);
    await fotoLegen(phone, 2, 'rpGalleryInput'); await sleep(400);
    const fotos = await fotoZahl(phone);

    await setVal(phone, '#rpIssue', ISSUE1);
    await setVal(phone, '#rpBrand', BRAND);
    await setVal(phone, '#rpModel', 'Datejust');
    const klickErgebnis = await klick(phone, '#rpSaveBtn');
    const gespeichert = await warteBis(phone, `!document.getElementById('rpSuccess').classList.contains('hidden')`, 60000);
    const meldung = await text(phone, '#rpSuccess');
    if (!gespeichert) {
      const knopf = await text(phone, '#rpSaveBtn');
      const probe = await phone.ev(`
        const t = localStorage.getItem('lataif_mobile_token');
        const res = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
          body: JSON.stringify({ op: 'repairs.list', commandId: crypto.randomUUID(), payload: { limit: 5 } }) });
        const txt = await res.text();
        return res.status + ' :: ' + txt.slice(0, 200);`).catch((e) => 'probe-fehler: ' + String(e));
      console.log('      (M1 Diagnose) Klick=' + klickErgebnis + ' | Knopf="' + knopf + '"'
        + ' | Fehlerfeld: ' + String(await text(phone, '#rpError'))
        + ' | Leseprobe: ' + String(probe)
        + ' | get-Probe: ' + String(await phone.ev("const t0=Date.now(); const r=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('lataif_mobile_token')},body:JSON.stringify({op:'repairs.get',commandId:crypto.randomUUID(),payload:{id:''}})}); const txt=await r.text(); return r.status+' in '+(Date.now()-t0)+'ms len='+txt.length;"))
        + ' | Antworten: ' + phone.antworten.slice(-8).join(' ; ')
        + ' | DOM: ' + String(await phone.ev("const e=document.getElementById('rpSuccess'); const f=document.getElementById('rpError'); return JSON.stringify({ok:!!e, cls: e?e.className:null, txt: e?e.textContent:null, err: f?f.className:null, knopf: document.getElementById('rpSaveBtn').textContent, gesperrt: document.getElementById('rpSaveBtn').disabled});"))
        + ' | Konsole: ' + (phone.events || []).slice(-14).join(' ~ '));
    }

    const neu = dbQ(BIZ_DB, 'SELECT id, repair_number, voucher_code, status, created_by, images FROM repairs ORDER BY rowid DESC LIMIT 1')[0] || {};
    REP_ID = String(neu.id || ''); REP_NR = String(neu.repair_number || '');
    const bilder = fotosVon(REP_ID);
    const nummerGut = /^REP-/.test(REP_NR) && !/REP-MOB-/.test(REP_NR);
    const einmal = repAnzahl() === vorher + 1 && nachweisFuer('repairs.create') === 1;
    MESS.m1 = { nummer: REP_NR, gutschein: String(neu.voucher_code || '').length, status: neu.status, bilder: bilder.length, fotosInMaske: fotos, kunden: kundenZeilen.length, meldung: meldung.slice(0, 80) };
    ok(uebersicht && maske && kundeDa && kundenZeilen.length === 1, `M1 das Telefon legt den Kunden ueber customers.create an (${S(MESS.m1.kunden)})`);
    ok(fotos === 2, `M1 zwei Fotos liegen in der Maske (${fotos})`);
    ok(gespeichert && nummerGut, `M1 der PRIMARY vergibt die Nummer — kein REP-MOB- (${REP_NR})`);
    ok(einmal, `M1 genau eine Reparatur, genau eine Zeile im durablen Nachweis (${repAnzahl() - vorher}/${nachweisFuer('repairs.create')})`);
    ok(bilder.length === 2 && bilder.every(fotoGut) && bildspalteLeer(REP_ID),
      `M1 beide Fotos liegen normalisiert im Medienkern der Reparatur — JPEG <= 100 000 B, keine Bildbytes in der Zeile (${S(bilder.map((f) => [f.mime, f.bytes, f.stand]))})`);
    RV.create = uebersicht && maske && kundeDa && kundenZeilen.length === 1 && fotos === 2 && gespeichert && nummerGut && einmal
      && bilder.length === 2 && bilder.every(fotoGut) && bildspalteLeer(REP_ID);
  }

  // ══ M2 — Bearbeiten: Problem + Notiz + drittes Foto ════════════════════════════════════════════
  {
    const vorBilder = fotosVon(REP_ID);
    const vorFassung = Number(repById(REP_ID)?.revision || 0);
    const vorNachweis = nachweisFuer('repairs.update');
    await setVal(phone, '#rpIssue', ISSUE2);
    await setVal(phone, '#rpNotes', 'Handed in at the counter');
    await fotoLegen(phone, 3, 'rpGalleryInput'); await sleep(400);
    await klick(phone, '#rpSaveBtn');
    const gespeichert = await warteBis(phone, `/Changes saved/.test(document.getElementById('rpSuccess').textContent)`, 120000);
    const zeile = repById(REP_ID) || {};
    const bilder = fotosVon(REP_ID);
    const gleich = (a, b) => !!a && !!b && a.media === b.media && a.hash === b.hash;
    const alteErhalten = vorBilder.length === 2 && bilder.length === 3 && gleich(bilder[0], vorBilder[0]) && gleich(bilder[1], vorBilder[1])
      && !vorBilder.some((v) => v.media === bilder[2].media) && bilder.every(fotoGut) && bildspalteLeer(REP_ID);
    const einmal = nachweisFuer('repairs.update') === vorNachweis + 1;
    // Was das Telefon nach dem Speichern zeigt, kommt vom Primary (die Maske liest die Reparatur neu).
    const inMaske = await warteBis(phone, `document.querySelectorAll('#rpPhotoStrip .photo-thumb').length === 3`, 30000);
    MESS.m2 = { issue: String(zeile.issue_description || '').slice(0, 60), notes: zeile.notes, bilder: bilder.length, inMaske, fassung: [vorFassung, Number(zeile.revision || 0)] };
    ok(gespeichert && String(zeile.issue_description) === ISSUE2 && String(zeile.notes) === 'Handed in at the counter',
      `M2 Problem und Notiz sind geaendert (${S(MESS.m2)})`);
    ok(alteErhalten, `M2 das dritte Foto kommt HINZU, die beiden alten bleiben — dasselbe Medium, derselbe Inhalt (${vorBilder.length} → ${bilder.length})`);
    ok(inMaske, `M2 das Telefon zeigt nach dem Speichern alle drei Fotos vom Primary (${await fotoZahl(phone)})`);
    ok(einmal && Number(zeile.revision || 0) > vorFassung, `M2 genau eine Aenderung, die Fassung steigt (${S(MESS.m2.fassung)})`);
    RV.edit = gespeichert && String(zeile.issue_description) === ISSUE2 && alteErhalten && einmal;
  }

  // ══ M3 — Die Antwort geht verloren: Klaeren wiederholt DIESELBE Kennung ════════════════════════
  {
    const vorRep = repAnzahl();
    const vorNachweis = nachweisFuer('repairs.create');
    // Die Antwort auf den NAECHSTEN Befehl wird verworfen, nachdem der Primary ihn ausgefuehrt hat:
    // die Anfrage geht hinaus, die Antwort erreicht die Seite nie. Genau der Fall, den die Kennung
    // eines Vorhabens abfaengt.
    await phone.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/command', requestStage: 'Response' }] }, 15000);
    let verworfen = 0;
    phone.paused = async (p) => {
      const istBefehl = /\/api\/command$/.test(String(p.request?.url || ''));
      const rumpf = String(p.request?.postData || '');
      if (istBefehl && /repairs\.create/.test(rumpf) && verworfen === 0) {
        verworfen += 1;
        try { await phone.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionAborted' }, 15000); } catch { /* egal */ }
      } else {
        try { await phone.send('Fetch.continueRequest', { requestId: p.requestId }, 15000); } catch { /* egal */ }
      }
    };

    await klick(phone, '[data-back-repair]');
    await warteBis(phone, `!document.getElementById('repairHome').classList.contains('hidden')`, 20000);
    await klick(phone, '#rpNewBtn');
    await warteBis(phone, `!document.getElementById('formRepair').classList.contains('hidden')`, 20000);
    await klick(phone, '#rpCustomerSearchBtn');
    await sleep(1500);
    await phone.ev(`const b=[...document.querySelectorAll('#rpCustomerResults button')][0]; if(b) b.click(); return 1;`);
    await fotoLegen(phone, 4); await sleep(400);
    const ISSUE3 = 'Battery empty ' + STEMPEL;
    await setVal(phone, '#rpIssue', ISSUE3);
    await klick(phone, '#rpSaveBtn');
    const offen = await warteBis(phone, `/No answer from the main computer/.test(document.getElementById('rpError').textContent)`, 120000);
    // Der Primary HAT gebucht — trotz verlorener Antwort.
    const gebucht = await warteAuf(() => repAnzahl() === vorRep + 1, 60);
    await phone.send('Fetch.disable', {}, 15000);
    phone.paused = null;

    await klick(phone, '[data-back-repair]');
    const leiste = await warteBis(phone, `!document.getElementById('rpOpenBox').classList.contains('hidden')`, 30000);
    const zeilen = await phone.ev("return document.querySelectorAll('#rpOpenList button').length;");
    await phone.ev(`const b=[...document.querySelectorAll('#rpOpenList button')][0]; if(b) b.click(); return 1;`);
    const geklaert = await warteBis(phone, `document.getElementById('rpOpenBox').classList.contains('hidden')`, 120000);
    const nachher = repAnzahl();
    const nachweis = nachweisFuer('repairs.create');
    const mitIssue3 = Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM repairs WHERE issue_description = ?', [ISSUE3])[0]?.n || 0);
    const m3Fotos = fotosVon(String(dbQ(BIZ_DB, 'SELECT id FROM repairs WHERE issue_description = ?', [ISSUE3])[0]?.id || ''));
    MESS.m3 = { verworfen, vorRep, nachher, nachweisVor: vorNachweis, nachweis, zeilenInLeiste: zeilen, mitIssue3, fotos: m3Fotos.length };
    ok(verworfen === 1 && offen, `M3 die Antwort ging verloren, die Maske sagt es ehrlich (${S(MESS.m3)})`);
    ok(gebucht, 'M3 der Primary hatte trotzdem gebucht');
    ok(leiste && zeilen === 1, `M3 der Vorgang steht unter „Unresolved saves" (${zeilen})`);
    ok(geklaert && nachher === vorRep + 1 && mitIssue3 === 1 && nachweis === vorNachweis + 1,
      `M3 „Clarify now" wiederholt DIESELBE Kennung → Replay: KEINE zweite Reparatur (${S(MESS.m3)})`);
    ok(m3Fotos.length === 1 && m3Fotos.every(fotoGut), `M3 …und kein zweites Bild: genau ein Foto an der Reparatur (${m3Fotos.length})`);
    RV.lostAnswer = verworfen === 1 && offen && gebucht && leiste && zeilen === 1 && geklaert
      && nachher === vorRep + 1 && mitIssue3 === 1 && nachweis === vorNachweis + 1 && m3Fotos.length === 1;
  }

  // ══ SETUP PC2 — derselbe Datensatz auf dem zweiten Rechner ═════════════════════════════════════
  client = await attachApp(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  const pc2Frisch = await waitFor(client, '[data-first-run-gate]', 120000);
  ok(pc2Frisch && !existsSync(join(CLIENT_LOCAL_STATE, 'pending-saves')),
    `SETUP PC2 beginnt frisch: Erststart-Maske, kein Ausweis und kein offener Speichervorgang eines frueheren Laufs (${pc2Frisch})`);
  await klick(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await klick(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP, /tauri\.localhost/);
  // Die Anmeldung ist erst fertig, wenn der Ausweis wirklich liegt — die Oberflaeche allein ist
  // kein Beweis (ein zu frueher Klick auf ein noch nicht bereites Formular sendet nichts).
  let pc2Da = false, pc2Token = 0;
  for (let versuch = 0; versuch < 3 && !pc2Da; versuch++) {
    // Die EIGENEN Kennzeichen der Anmeldemaske — generische Felder treffen sonst die Oberflaeche
    // dahinter, und dann wird still nichts gesendet.
    await waitFor(client, '[data-client-signin]', 60000);
    await setVal(client, '[data-client-email]', OWNER_EMAIL);
    await setVal(client, '[data-client-password]', OWNER_PW);
    await sleep(400);
    await klick(client, '[data-client-signin]');
    const shell = await warteBis(client, `${q(SHELL)} && (localStorage.getItem('lataif_client_token') || '').length > 0`, 60000);
    pc2Token = Number(await client.ev("return (localStorage.getItem('lataif_client_token') || '').length;").catch(() => 0));
    pc2Da = shell && pc2Token > 0;
    if (!pc2Da) {
      const bild = String(await client.ev("return JSON.stringify({ knopf: !!document.querySelector('[data-client-signin]'), gesperrt: (document.querySelector('[data-client-signin]') || {}).disabled, email: (document.querySelector('[data-client-email]') || {}).value, text: document.body.innerText.slice(0, 220) });").catch((e) => String(e)));
      console.log(`      (PC2) Anmeldeversuch ${versuch + 1}: Oberflaeche ${shell}, Ausweis ${pc2Token} Zeichen — ${bild.slice(0, 320)}`);
      await sleep(2000);
    }
  }
  ok(pc2Da, `SETUP PC2 ist angemeldet (ohne eigene Datenbank; Ausweis ${pc2Token} Zeichen)`);

  // ══ M4/M5 — PC2 aendert, das Telefon darf NICHT ueberschreiben, sieht danach die Aenderung ═════
  {
    const DIAG = 'Checked on PC2 ' + STEMPEL;
    // Das Telefon steht nach S3 auf der ZWEITEN Reparatur — fuer diesen Fall muss es wieder die
    // erste offen haben, mit deren gelesener Fassung.
    await klick(phone, '[data-back-repair]');
    await warteBis(phone, `!document.getElementById('repairHome').classList.contains('hidden')`, 20000);
    await setVal(phone, '#rpSearch', REP_NR);
    await klick(phone, '#rpSearchBtn');
    // Auf den TREFFER warten, nicht auf irgendeine Liste: die vorige Liste steht noch, bis die
    // Antwort da ist — wer zu frueh klickt, oeffnet die falsche Reparatur.
    await warteBis(phone, `[...document.querySelectorAll('#rpList button')].filter((b) => b.textContent.includes(${S(REP_NR)})).length === 1`, 60000);
    await phone.ev(`const b=[...document.querySelectorAll('#rpList button')].find((x) => x.textContent.includes(${S(REP_NR)})); if(b) b.click(); return 1;`);
    const aufRichtiger = await warteBis(phone, `document.getElementById('rpHeadline').textContent === ${S(REP_NR)}`, 60000);
    ok(aufRichtiger, `M4 das Telefon hat wieder ${REP_NR} offen (Stand vor der fremden Aenderung)`);
    const vorFassung = Number(repById(REP_ID)?.revision || 0);
    // Zuerst die Sicht: PC2 muss die Reparatur des Telefons in seiner Liste haben.
    await client.ev(`history.pushState({}, '', '/repairs'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
    await sleep(2500);
    const sichtbar = await warteBis(client, `document.body.innerText.includes(${S(REP_NR)})`, 60000);
    await client.ev(`const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0 && e.textContent.trim()===${S(REP_NR)}); if(el){ let n=el; for(let i=0;i<6 && n;i++){ if(n.onclick||n.tagName==='TR'||n.getAttribute('role')==='button'){ n.click(); break; } n=n.parentElement; } } return 1;`);
    await sleep(2500);
    const aufDetail = await warteBis(client, `document.body.innerText.includes(${S(REP_NR)}) && [...document.querySelectorAll('button')].some(b=>/Edit|Save/.test(b.textContent))`, 60000);
    MESS.m5 = { listeSichtbar: sichtbar, detail: aufDetail };
    ok(sichtbar, `M5 PC2 sieht die Reparatur des Telefons in seiner Liste (${REP_NR})`);
    // MOBILE-REPAIR-GALLERY — die Fotos des Telefons (Kamera + Galerie) stehen in der Reparatur auf PC2 UND am
    // Primary — wirklich geladen (naturalWidth > 0), nicht nur als leere Rahmen.
    const sollBilder = fotosVon(REP_ID).length;
    const geladen = `[...document.querySelectorAll('img[alt^="Item photo"]')].filter((i) => i.complete && i.naturalWidth > 0).length`;
    const pc2Bilder = await warteBis(client, `${geladen} === ${sollBilder}`, 60000);
    const pc2Zahl = await client.ev(`return ${geladen};`);
    ok(sollBilder === 3 && pc2Bilder, `GALERIE PC2 zeigt alle Fotos der Telefon-Reparatur, geladen (${pc2Zahl}/${sollBilder})`);
    await primary.ev(`history.pushState({}, '', '/repairs/' + ${S(REP_ID)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
    const primBilder = await warteBis(primary, `${geladen} === ${sollBilder}`, 60000);
    const primZahl = await primary.ev(`return ${geladen};`);
    ok(sollBilder === 3 && primBilder, `GALERIE der Primary zeigt dieselben Fotos, geladen (${primZahl}/${sollBilder})`);
    MESS.galerie = { soll: sollBilder, pc2: pc2Zahl, primary: primZahl };

    // Aenderung von PC2 ueber den Fernbefehl, den die Oberflaeche ohnehin benutzt.
    const pc2Aenderung = await client.ev(`
      const token = localStorage.getItem('lataif_client_token')
        || (Object.keys(localStorage).filter((k) => /token/i.test(k)).map((k) => localStorage.getItem(k))[0] || '');
      const server = 'http://127.0.0.1:${PORT}';
      const repRes = await fetch(server + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ op: 'repairs.get', commandId: crypto.randomUUID(), payload: { id: ${S(REP_ID)} } }) });
      const repTxt = await repRes.text();
      let rep = null; try { rep = JSON.parse(repTxt); } catch (e) { rep = null; }
      const revision = rep && rep.value ? rep.value.revision : 0;
      if (!revision) return JSON.stringify({ status: repRes.status, revision: 0, token: token ? token.length : 0, body: repTxt.slice(0, 160) });
      const res = await fetch(server + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ op: 'repairs.update', commandId: crypto.randomUUID(), payload: { id: ${S(REP_ID)}, expectedRevision: revision, diagnosis: ${S(DIAG)} } }) });
      return JSON.stringify({ status: res.status, revision });`);
    const pc2Ok = /"status":200/.test(String(pc2Aenderung));
    const nachPc2 = repById(REP_ID) || {};
    ok(pc2Ok && String(nachPc2.diagnosis) === DIAG, `M5 PC2 aendert denselben Datensatz (${String(pc2Aenderung).slice(0, 90)})`);

    // Das Telefon steht noch auf der ALTEN Fassung: sein Speichern darf die Aenderung nicht ueberschreiben.
    await setVal(phone, '#rpNotes', 'Phone wrote over it');
    await klick(phone, '#rpSaveBtn');
    const abgewiesen = await warteBis(phone, `/changed this repair in the meantime/.test(document.getElementById('rpError').textContent)`, 120000);
    const danach = repById(REP_ID) || {};
    const nichtUeberschrieben = String(danach.diagnosis) === DIAG && String(danach.notes) !== 'Phone wrote over it';
    MESS.m4 = { abgewiesen, diagnosis: String(danach.diagnosis || '').slice(0, 40), notes: String(danach.notes || '').slice(0, 40), fassung: [vorFassung, Number(danach.revision || 0)] };
    ok(abgewiesen && nichtUeberschrieben, `M4 veraltete Handy-Aenderung → RECORD_CHANGED, nichts ueberschrieben (${S(MESS.m4)})`);
    RV.staleEdit = abgewiesen && nichtUeberschrieben;

    // Und nach dem Neuladen sieht das Telefon, was PC2 geschrieben hat.
    await klick(phone, '[data-back-repair]');
    await warteBis(phone, `!document.getElementById('repairHome').classList.contains('hidden')`, 20000);
    await setVal(phone, '#rpSearch', REP_NR);
    await klick(phone, '#rpSearchBtn');
    // Auf den TREFFER warten, nicht auf irgendeine Liste: die vorige Liste steht noch, bis die
    // Antwort da ist — wer zu frueh klickt, oeffnet die falsche Reparatur.
    await warteBis(phone, `[...document.querySelectorAll('#rpList button')].filter((b) => b.textContent.includes(${S(REP_NR)})).length === 1`, 60000);
    await phone.ev(`const b=[...document.querySelectorAll('#rpList button')].find((x) => x.textContent.includes(${S(REP_NR)})); if(b) b.click(); return 1;`);
    const sieht = await warteBis(phone, `document.getElementById('rpDiagnosis').value === ${S(DIAG)}`, 60000);
    if (!sieht) console.log('      (M5 Diagnose) Diagnosefeld: ' + String(await phone.ev("return document.getElementById('rpDiagnosis').value;")) + ' | Trefferzahl: ' + String(await phone.ev("return document.querySelectorAll('#rpList button').length;")) + ' | Kopf: ' + String(await text(phone, '#rpHeadline')));
    ok(sieht, 'M5 das Telefon sieht die Aenderung von PC2 nach dem Neuladen');
    RV.bothSurfaces = sichtbar && pc2Ok && sieht;
  }

  // ══ M7 — Werkstattwege am ECHTEN Primary: Arbeitszeile, Storno, Status, Rechnung ══════════════
  {
    const zeilen = () => dbQ(BIZ_DB, 'SELECT id, work_type, cost_amount, status FROM repair_lines WHERE repair_id = ?', [REP_ID]);
    const vorZeilen = zeilen().length;
    const vorAusgaben = Number(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM expenses WHERE related_module = 'repair' AND related_entity_id = ?", [REP_ID])[0]?.n || 0);

    // ── REPAIR-WORKSHOP-FILTER am echten Primary: PC2 legt einen Workshop und einen normalen Lieferanten an
    //    (suppliers.create, derselbe Befehl wie „New Supplier"); das Telefon bietet bei Arbeitszeile und Gold NUR den
    //    Workshop, bei Material beide; PC2 zeigt die Markierung in seiner Lieferantenliste.
    {
      const pc2Anlegen = (body) => client.ev(`
        const token = localStorage.getItem('lataif_client_token') || '';
        const res = await fetch('http://127.0.0.1:${PORT}/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ op: 'suppliers.create', commandId: crypto.randomUUID(), payload: ${S(body)} }) });
        return res.status + ' ' + (await res.text()).slice(0, 160);`);
      const WNAME = 'Workshop ' + STEMPEL, PNAME = 'Parts ' + STEMPEL;
      const a1 = await pc2Anlegen({ name: WNAME, isWorkshop: true });
      const a2 = await pc2Anlegen({ name: PNAME });
      await warteAuf(() => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM suppliers WHERE name IN (?, ?)', [WNAME, PNAME])[0]?.n) === 2, 30);
      const zeileW = dbQ(BIZ_DB, 'SELECT id, is_workshop FROM suppliers WHERE name = ?', [WNAME])[0] || {};
      const zeileP = dbQ(BIZ_DB, 'SELECT id, is_workshop FROM suppliers WHERE name = ?', [PNAME])[0] || {};
      ok(/^200 /.test(String(a1)) && /^200 /.test(String(a2)) && Number(zeileW.is_workshop) === 1 && Number(zeileP.is_workshop) === 0,
        `WORKSHOP PC2 legt Workshop (is_workshop=1) und normalen Lieferanten (0) am Primary an (${String(a1).slice(0, 40)} / ${String(a2).slice(0, 40)})`);
      await client.ev(`history.pushState({}, '', '/suppliers'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
      const pc2Badge = await warteBis(client, `[...document.querySelectorAll('[data-supplier-workshop-badge]')].some((b) => b.parentElement.textContent.includes(${S(WNAME)}))
        && document.body.innerText.includes(${S(PNAME)})`, 60000);
      const pc2Falsch = await client.ev(`return [...document.querySelectorAll('[data-supplier-workshop-badge]')].some((b) => b.parentElement.textContent.includes(${S(PNAME)}));`);
      ok(pc2Badge && !pc2Falsch, 'WORKSHOP PC2 zeigt die Markierung in seiner Lieferantenliste — nur beim Workshop');
      // Das Telefon oeffnet die Reparatur neu (die Lieferanten werden je geoeffneter Reparatur gelesen).
      await setVal(phone, '#rpSearch', REP_NR);
      await klick(phone, '#rpSearchBtn');
      await warteBis(phone, `[...document.querySelectorAll('#rpList button')].filter((b) => b.textContent.includes(${S(REP_NR)})).length === 1`, 60000);
      await phone.ev(`const b=[...document.querySelectorAll('#rpList button')].find((x) => x.textContent.includes(${S(REP_NR)})); if(b) b.click(); return 1;`);
      await warteBis(phone, `[...document.querySelectorAll('#rpMatSupplier option')].some((o) => o.value === ${S(zeileP.id)})`, 60000);
      const listen = await phone.ev(`const v = (id) => [...document.querySelectorAll('#' + id + ' option')].map((o) => o.value);
        return { line: v('rpLineSupplier'), gold: v('rpGoldSupplier'), mat: v('rpMatSupplier'), hinweis: !document.getElementById('rpLineSupplierHint').classList.contains('hidden') };`);
      MESS.workshop = { line: listen.line.length, gold: listen.gold.length, mat: listen.mat.length, hinweis: listen.hinweis };
      ok(listen.line.includes('__INHOUSE__') && listen.line.includes(zeileW.id) && !listen.line.includes(zeileP.id) && !listen.hinweis,
        `WORKSHOP Telefon „Add work line": eigene Werkstatt + Workshop, NICHT der normale Lieferant (${S(MESS.workshop)})`);
      ok(listen.gold.includes(zeileW.id) && !listen.gold.includes(zeileP.id) && !listen.gold.includes('__INHOUSE__'),
        'WORKSHOP Telefon „Gold vom Workshop": nur der Workshop');
      ok(listen.mat.includes(zeileW.id) && listen.mat.includes(zeileP.id), 'WORKSHOP Telefon „Material": alle aktiven Lieferanten');
    }

    // ── Arbeitszeile (eigene Werkstatt, damit keine Lieferantenschuld noetig ist)
    await phone.ev(`
      document.getElementById('rpLineCost').value = '12.5';
      document.getElementById('rpLineType').value = 'polishing';
      document.getElementById('rpLineSupplier').value = ${S('__INHOUSE__')};
      document.getElementById('rpLineAddBtn').click();
      return 1;`);
    const zeileDa = await warteAuf(() => zeilen().length === vorZeilen + 1, 90);
    const neueZeile = zeilen().find((z) => Number(z.cost_amount) === 12.5) || {};
    const werkMeldung = await text(phone, '#rpWorkMsg');
    MESS.m7 = { zeilen: [vorZeilen, zeilen().length], art: neueZeile.work_type, kosten: Number(neueZeile.cost_amount || 0), meldung: werkMeldung.slice(0, 60) };
    ok(zeileDa && neueZeile.work_type === 'polishing', `M7 „Add work line" schreibt die Zeile am Primary (${S(MESS.m7)})`);
    if (!zeileDa) {
      console.log('      (M7 Diagnose) Fehler: ' + String(await text(phone, '#rpError')) + ' | Erfolg: ' + String(await text(phone, '#rpSuccess'))
        + ' | Kopf: ' + String(await text(phone, '#rpHeadline')) + ' | Werkstattkarte sichtbar: '
        + String(await phone.ev("return !document.getElementById('rpWorkCard').classList.contains('hidden');").catch((e) => String(e)))
        + ' | Antworten: ' + phone.antworten.slice(-8).join(' ; ') + ' | Konsole: ' + (phone.events || []).slice(-8).join(' ~ '));
    }

    // ── Dieselbe Zeile zuruecknehmen (zwei Klicks: erst Nachfrage)
    const lineId = String(neueZeile.id || '');
    await phone.ev(`const b=document.querySelector('[data-line-cancel="' + ${S(lineId)} + '"]'); if (b) b.click(); return 1;`);
    await sleep(300);
    await phone.ev(`const b=document.querySelector('[data-line-cancel="' + ${S(lineId)} + '"]'); if (b) b.click(); return 1;`);
    const zeileWeg = await warteAuf(() => zeilen().length === vorZeilen, 90);
    const ausgabenNachher = Number(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'", [REP_ID])[0]?.n || 0);
    ok(zeileWeg && ausgabenNachher === vorAusgaben,
      `M7 „Cancel line" nimmt die Zeile samt Ausgabe zurueck (${zeilen().length} Zeilen, ${ausgabenNachher} offene Ausgaben)`);

    // ── Status bis „ready" ueber die Schritte, die der PRIMARY erlaubt
    let schritte = 0;
    for (let i = 0; i < 4; i++) {
      const stand = String(repById(REP_ID)?.status || '');
      if (stand === 'ready') break;
      const ziel = await phone.ev("const b=[...document.querySelectorAll('#rpStatusRow button')][0]; if (!b) return ''; const t=b.textContent.replace('Mark as ',''); b.click(); return t;");
      if (!ziel) break;
      schritte += 1;
      await warteAuf(() => String(repById(REP_ID)?.status || '') === String(ziel), 90);
      await sleep(800);
    }
    const bereit = String(repById(REP_ID)?.status || '');
    ok(bereit === 'ready', `M7 der Status laeuft ueber die vom Primary erlaubten Schritte bis „ready" (${schritte} Schritte, jetzt ${bereit})`);

    // ── Kundenbetrag setzen (eigenes Maskenfeld) und Rechnung stellen
    await setVal(phone, '#rpChargeToCustomer', '45');
    await klick(phone, '#rpSaveBtn');
    await warteAuf(() => Number(repById(REP_ID)?.charge_to_customer || 0) === 45, 90);
    const betrag = Number(repById(REP_ID)?.charge_to_customer || 0);
    await phone.ev("document.getElementById('rpTaxScheme').value='VAT_10'; document.getElementById('rpInvoiceBtn').click(); return 1;");
    const fakturiert = await warteAuf(() => String(repById(REP_ID)?.invoice_id || '') !== '', 120);
    const rechnungsId = String(repById(REP_ID)?.invoice_id || '');
    const rechnung = dbQ(BIZ_DB, 'SELECT id, invoice_number, gross_amount, tax_scheme_snapshot, customer_id FROM invoices WHERE id = ?', [rechnungsId])[0] || {};
    const werkMeldung2 = await text(phone, '#rpWorkMsg');
    MESS.m7rechnung = { betrag, rechnungsId: rechnungsId.slice(0, 8), nummer: String(rechnung.invoice_number || ''), brutto: Number(rechnung.gross_amount || 0), steuer: String(rechnung.tax_scheme_snapshot || ''), meldung: werkMeldung2.slice(0, 60) };
    ok(betrag === 45 && fakturiert && rechnungsId !== '' && !!rechnung.id && Number(rechnung.gross_amount || 0) > 0,
      `M7 „Create invoice" erzeugt die Rechnung am Primary (${S(MESS.m7rechnung)})`);
    const keineZweite = await warteBis(phone, `document.getElementById('rpInvoiceBtn').classList.contains('hidden')`, 30000);
    ok(keineZweite, 'M7 danach bietet die Maske keine zweite Rechnung mehr an');
    RV.workshop = zeileDa && zeileWeg && bereit === 'ready' && fakturiert && keineZweite;
  }

  // ══ M6 — Medien und Grenzen ═══════════════════════════════════════════════════════════════════
  {
    const bilder = fotosVon(REP_ID);
    const groessen = bilder.map((f) => Number(f.bytes));
    const imRahmen = bilder.length === 3 && bilder.every(fotoGut) && bildspalteLeer(REP_ID);
    const staging = stagingDateien();
    const pushGerufen = phone.requests.filter((u) => /\/api\/sync\/push/.test(u)).length;
    const befehle = phone.requests.filter((u) => /\/api\/command/.test(u)).length;
    const stagingRufe = phone.requests.filter((u) => /\/api\/staging\/media/.test(u)).length;
    // Alle Orte, an denen PC2 eine Datenbank anlegen koennte — die umgeleiteten UND die echten seiner Test-Kennung.
    const keineEigeneDb = [join(CLIENT_HOME, 'Local', CLIENT_IDENT), join(CLIENT_APPDATA, CLIENT_IDENT), CLIENT_LOCAL_STATE, join(REAL_APPDATA, CLIENT_IDENT)]
      .every((d) => !existsSync(join(d, 'lataif.db')));
    MESS.m6 = { bilder: groessen, stagingDateien: staging.length, pushGerufen, befehle, stagingRufe, keineEigeneDb };
    ok(imRahmen, `M6 jedes Bild ist JPEG und <= 100 000 B, die alte Bildspalte bleibt leer (${S(groessen)})`);
    ok(staging.length === 0, `M6 die Ablage des Primary ist nach dem Erfolg leer — kein verwaister Blob (${staging.length})`);
    ok(pushGerufen === 0 && befehle > 0 && stagingRufe > 0,
      `M6 das Telefon schreibt NUR ueber /api/command (+Ablage) — nie ueber /api/sync/push (${S(MESS.m6)})`);
    ok(keineEigeneDb, 'M6 auf PC2 entsteht keine Geschaeftsdatenbank');
    RV.media = imRahmen && staging.length === 0 && pushGerufen === 0 && befehle > 0 && stagingRufe > 0 && keineEigeneDb;
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
  await edgeSchliessen();
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
}

// Der Test-Browser ist zu — und mit ihm jeder Prozess seines Profils (nur gelesen, nichts beendet).
const reste = await waitEdgeProfileGone(EDGE_PROFILE);
ok(!edgeBrowserWs && reste === 0, `AUFRAEUMEN der Test-Browser ist geschlossen, kein Prozess seines Profils laeuft noch (${reste})`);
MESS.aufraeumen = { browserZu: !edgeBrowserWs, reste };

clearTimeout(WACHHUND);
console.log('\n  PRE-G5 Mobile Repair              Ergebnis');
for (const [k, v] of Object.entries(RV)) console.log(`  ${k.padEnd(34)}${v === true ? 'ja' : 'NEIN'}`);
console.log('  Messung ' + JSON.stringify(MESS));
const dauer = Math.round((Date.now() - T0) / 1000);
const ZEILE = `pre-g5 mobile repair: phone creates and edits a repair through the primary's own domain (remote command + staging), lost answer clarified once, stale phone edit refused, pc2 and phone share one record (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) {
  console.log(`\nFAIL — ${ZEILE}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
if (Object.values(RV).every((v) => v === true)) console.log('PRE_G5_MOBILE_REPAIR_E2E_PROVED');
console.log(`\nPASS — ${ZEILE}`);
