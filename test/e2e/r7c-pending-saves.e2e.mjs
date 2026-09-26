// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7C — offene Speichervorgänge von PC2 (pending saves), Kennungskonflikt aus dem durablen
// Nachweis und die 0-Byte-Geschäftsdatenbank — gezielt, zwei echte Anwendungen (Primary + PC2).
// Run: node test/e2e/r7c-pending-saves.e2e.mjs
//
//   S1 LOST     PC2 (als B) „New Client": die Antwort geht verloren (Anfrage zugestellt, Antwort verworfen).
//               Die Maske sagt „No answer from the primary"; der Primary hat GENAU einen Kunden und GENAU eine
//               Zeile im durablen Nachweis; die Datei `<AppLocalData>/pending-saves/<Kennung>.json` steht auf
//               „unresolved" und trägt den ursprünglichen Rumpf.
//   S2 R2       dieselbe offene Maske, ein Feld geändert, „Speichern": NICHTS geht hinaus („changes were NOT
//               sent"), kein neuer Nachweis, kein zweiter Kunde, kein Kunde mit dem geänderten Wert.
//   S3 R1       reguläres Beenden + Neustart des Primary (Speicher der Brücke leer) UND von PC2: die Leiste
//               „Unresolved saves" zeigt genau diesen Vorgang; „Clarify now" → „WAS saved" (Replay), nichts
//               doppelt, die Datei ist weg, die Leiste leer.
//               N1: PC2 endet nach WM_CLOSE von selbst (Exit-Code 0, kein Helfer), weiter als B, keine Datenbank auf
//               PC2. (Bis `617c2c8` ging das nicht — Lauf 2 beendete PC2 über den Helfer.)
//               Gezielt: `R7C_NUR=S3 node test/e2e/r7c-pending-saves.e2e.mjs` (S1-Schritte als Vorbedingung).
//   S4 R3       Primary erneut regulär neu gestartet (die Kennung steht nur noch im durablen Nachweis):
//               dieselbe Kennung mit anderem Rumpf → 409 BRIDGE_COMMAND_ID_CONFLICT / not_executed; mit dem
//               ursprünglichen Rumpf → 200 replayed. Kundenbestand unverändert.
//   S5 R4       reguläres Beenden, Geschäftsdatenbank beiseite kopiert und auf 0 Byte gesetzt: der Start zeigt die
//               Wiederherstellungsmeldung, die Datei bleibt 0 Byte mit derselben Änderungszeit, keine
//               lataif.db.tmp-*. Danach die Bytes zurück, normaler Start, der Kunde aus S1 ist da.
//
// PROZESS-ISOLATION (dauerhafte Regel): gestartet wird nur über `spawnTracked`; beendet wird nur, was dieser
// Lauf gestartet hat — regulär nur nach Prüfung von PID UND exaktem Test-Pfad, hart nur über den Helfer
// (`killTestPid` mit eigener PID + exaktem Test-Pfad). Die installierte Produktions-App wird nie beendet, nie
// benutzt; E:\LATAIF\Data und die Produktionsports 3001/3443 bleiben tabu.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, killTestPid, spawnTracked, waitTestImageGone, foreignProcesses, pathOfPid, startedPids, waitPidGone } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { OCR_FILES } from '../../src/core/ai/ocr-assets.ts';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
let RV_STATE = {}, MESS_STATE = {};
/** Die PID des Primary, den DIESER Lauf gestartet hat (der zuletzt gestartete Test-Prozess am exakten Pfad). */
function eigenerPrimary() {
  const pid = startedPids().filter((p) => String(pathOfPid(p) || '').replace(/\//g, '\\').toLowerCase() === APP.replace(/\//g, '\\').toLowerCase()).pop();
  if (!pid) throw new Error('no own primary pid');
  return pid;
}
/** Reguläres Beenden: Fenster schließen (WM_CLOSE) — nur eine eigene PID am exakten Test-Pfad. Kein Beenden erzwingen. */
function regulaerSchliessen(pid) {
  const live = String(pathOfPid(pid) || '').replace(/\//g, '\\').toLowerCase();
  if (!startedPids().includes(pid) || live !== APP.replace(/\//g, '\\').toLowerCase()) throw new Error(`refusing to close ${pid} (${live})`);
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).CloseMainWindow()`], { encoding: 'utf8', windowsHide: true });
  return /True/i.test(out);
}
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r7c-owner-' + Math.random().toString(36).slice(2);
// Der zweite echte Benutzer (wie im R6E-Akteurslauf): eigene Kennung/E-Mail, Owner-Rolle, der bcrypt-Wert
// des Owners kopiert — die Anmeldung prüft ihn mit dem echten `bcrypt::verify`.
const B_ID = 'user-r7c-b';
const B_EMAIL = 'kollege.r7c@lataif.com';
const B_NAME = 'PP14 Kollege B';

const RUN = join(os.tmpdir(), 'lataif-r7c', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();
// Gezielter Lauf, z. B. `R7C_NUR=S3` (N1: PC2 regulär beenden): die S1-Schritte laufen dann nur als Vorbedingung (sie erzeugen
// den offenen Vorgang), die übrigen Szenarien entfallen.
const NUR = String(process.env.R7C_NUR || '').split(',').map((s) => s.trim()).filter(Boolean);
const laeuft = (s) => NUR.length === 0 || NUR.includes(s);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  aufraeumen();
  process.exit(1);
}, 110 * 60 * 1000);

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

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.events = [];
    // Nur Beobachtung: jede URL, die diese Seite UND ihre Worker anfragen (ab `netzAn`).
    this.requests = []; this.netz = false;
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Network.requestWillBeSent') this.requests.push(String(m.params?.request?.url || ''));
      if (m.method === 'Target.attachedToTarget' && this.netz && m.params?.sessionId) {
        for (const method of ['Network.enable', 'Runtime.runIfWaitingForDebugger']) {
          this.ws.send(JSON.stringify({ id: ++this.id, sessionId: m.params.sessionId, method, params: {} }));
        }
      }
      if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params?.type || '')) {
        this.events.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.events.push(`exception: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || ''}`.slice(0, 400));
      }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  // Jede Anfrage mit Frist: ein ausbleibendes Protokoll-Echo bricht laut ab, statt den Lauf stumm anzuhalten.
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
  async netzAn() {
    if (this.netz) return;
    this.netz = true;
    await this.send('Network.enable', {}, 10000);
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, 10000);
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

async function attachOnly(cdpPort, budget = 60000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
/** Nur Beobachtung, auf einer EIGENEN Verbindung: die Netz-Mitschrift stört nie die Verbindung, die bedient. */
async function netzBeobachter(cdpPort) {
  const b = await attachOnly(cdpPort, 30000);
  await b.netzAn();
  return b;
}
/** Exit-Code je eigener PID — Beleg für „regulär": `AppHandle::exit(0)` endet mit 0, der Helfer (`taskkill /F`) nicht. */
const EXITS = new Map();
async function exitCodeVon(pid) {
  for (let i = 0; i < 50 && !EXITS.has(Number(pid)); i++) await sleep(100);
  return EXITS.has(Number(pid)) ? EXITS.get(Number(pid)).code : null;
}
async function attach(cdpPort, exe, env) {
  const ch = spawnTracked(exe, [], { env, stdio: 'ignore', detached: true });
  ch.on('exit', (code, signal) => EXITS.set(ch.pid, { code, signal }));
  ch.unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
/** Klick ohne Abbruch: 'OK' oder der Grund. */
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
/** Klick auf das Element, das ein Ausdruck liefert. */
const klickAusdruck = (c, ausdruck, was) => c.ev(`const e=(${ausdruck}); if(!e) return 'NO:'+${S(was)}; if (e.disabled) return 'DISABLED:'+${S(was)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
/** Ein Feld, dessen Beschriftung so BEGINNT (die Beschriftung wechselt z. B. „AUTO" → „MANUELL"). */
const setByLabelPrefix = (c, prefix, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().startsWith(${S(prefix)})).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(prefix)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const waehleNth = (c, eintrag, nr, wert) => c.ev(
  `const l=[...document.querySelectorAll('select')].filter(x=>[...x.options].some(o=>o.textContent.includes(${S(eintrag)})));`
  + `const s=l[${nr}]; if(!s) return 'NO-SELECT:'+${S(eintrag)}+'#'+${nr}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${S(wert)});`
  + `s.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setNth = (c, sel, nr, v) => c.ev(
  `const e=document.querySelectorAll(${S(sel)})[${nr}]; if(!e) return 'NO:'+${S(sel)}+'#'+${nr};`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const SHELL = 'a[href="/settings"]';
const alleOk = (r) => { const schlecht = r.filter((x) => x !== 'OK'); return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK'; };
const q = (sel) => `document.querySelector(${S(sel)})`;
const knopfDa = (t) => `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${S(t)})`;

// Der Beobachter auf PC2: Fernaufträge, ihre Antworten, Datenbankgriffe, Kern-Aufrufe, Dialoge — und
// EINE verlorene Antwort auf Wunsch (die Anfrage GEHT hinaus und wird ausgeführt, nur die Antwort fehlt).
const BEOBACHTER = `
  if (window.__r6fInstalliert) { /* schon da */ } else {
  window.__r6fInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__invokes = []; window.__alerts = []; window.__dropNext = null;
  window.__staged = 0;
  window.alert = (m) => { window.__alerts.push(String(m)); };
  window.confirm = () => true;
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); oe(...a); };
  const ow = console.warn;
  console.warn = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); ow(...a); };
  (function haken() {
    const t = window.__TAURI_INTERNALS__;
    if (t && t.invoke && !t.__r6f) {
      const oi = t.invoke.bind(t);
      t.invoke = (cmd, args, opts) => { window.__invokes.push(String(cmd)); return oi(cmd, args, opts); };
      t.__r6f = true;
    } else if (!t || !t.__r6f) setTimeout(haken, 30);
  })();
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    if (/\\/api\\/staging\\/media$/.test(url)) window.__staged++;
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload }); } catch (e) { /* kein lesbarer Rumpf */ }
    }
    if (body && window.__dropNext && body.op === window.__dropNext) {
      window.__dropNext = null;
      const r0 = await of(...a);
      try { await r0.text(); } catch (e) { /* egal */ }
      window.__answers.push({ op: body.op, commandId: body.commandId, dropped: true });
      throw new TypeError('R6F: simulated lost response');
    }
    const r = await of(...a);
    if (body && body.op && !/\\.(get|list)$/.test(String(body.op))) {
      try {
        const j = await r.clone().json();
        window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, ok: !!(j && j.ok === true), error: (j && j.error) || null, replayed: !!(j && j.value && j.value.replayed) });
      } catch (e) { window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, unreadable: true }); }
    }
    return r;
  };
  }
`;
const DIALOGE_PRIMARY = 'window.__alerts = window.__alerts || []; window.alert = (m) => { window.__alerts.push(String(m)); }; window.confirm = () => true; return 1;';

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

let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
// Datenbankgriffe und Kern-Aufrufe über ALLE Seiten des Laufs (ein Neuladen leert die Fensterlisten).
const ALLE_TREFFER = [], ALLE_AUFRUFE = [];
async function ernte(c) {
  try {
    ALLE_TREFFER.push(...(await treffer(c)));
    ALLE_AUFRUFE.push(...(await aufrufe(c)));
  } catch { /* Seite schon weg */ }
}
async function lade(c, route) {
  await ernte(c);
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
/** Am Primary frisch einsteigen: über eine andere Seite, damit die Zielseite neu lädt (frische Fassung). */
async function gehFrisch(p, route) {
  await geh(p, '/settings');
  await sleep(700);
  await geh(p, route);
  await sleep(900);
}
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)) && !/^store\.|^page\.|^domain\.|^session\./.test(String(x.op)));
const antworten = (c) => c.ev('return JSON.stringify(window.__answers || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const aufrufe = (c) => c.ev('return JSON.stringify(window.__invokes || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const FEHLER_SEL = '[data-save-error],[data-production-error],[data-ocr-error]';
const fehlerText = (c, sel = FEHLER_SEL) => c.ev(`return [...document.querySelectorAll(${S(sel)})].map(e=>e.textContent).join(' | ') + ((window.__alerts || []).length ? ' | alert: ' + window.__alerts.slice(-2).join(' / ') : '');`).catch(() => '');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
let primary = null, client = null;

async function warteAuf(pruefe, runden = 40) {
  for (let i = 0; i < runden; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}

/** Wie R6E: vor jedem Laden und Vergleich, bis der Primary nichts mehr zu schieben hat. */
async function syncRuhe(t = 75000) {
  const end = Date.now() + t;
  let angestossen = false;
  while (Date.now() < end) {
    await spuelen(primary);
    const offen = zahl('SELECT COUNT(*) AS n FROM sync_changelog WHERE synced = 0');
    const stand = zahl('SELECT COALESCE(MAX(last_sync_id), 0) AS m FROM sync_cursor');
    const kopf = Number(dbQ(SERVER_DB, 'SELECT COALESCE(MAX(id), 0) AS m FROM sync_changelog')[0]?.m || 0);
    if (offen === 0 && stand >= kopf) return true;
    if (!angestossen) {
      angestossen = true;
      await geh(primary, '/settings?tab=sync');
      if (await warteBis(primary, knopfDa('Sync Now'), 8000)) await clickText(primary, 'Sync Now');
    }
    await sleep(700);
  }
  console.log('      (sync) der Echo-Lauf des Primary kam nicht zur Ruhe');
  return false;
}

// ── Datenbank-Blick ──────────────────────────────────────────────────────────
const idSet = (t) => new Set(dbQ(BIZ_DB, `SELECT id FROM ${t}`).map((r) => r.id));
const neueZeilen = (t, vorher, where = '1=1', params = []) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE ${where}`, params).filter((r) => !vorher.has(r.id));
const zeile = (t, id) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE id = ?`, [id])[0] || {};
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);
const maxRow = (t) => zahl(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`);
/** Die Zeilen, die in GENAU diesem Fenster (von, bis] entstanden sind — eine Seite, nicht ihr Zwilling. */
const fenster = (t, von, bis) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE rowid > ? AND rowid <= ? ORDER BY rowid`, [von, bis]);
const ledgerMax = () => maxRow('ledger_entries');
const buchungenSeit = (row) => dbQ(BIZ_DB, 'SELECT account, direction, amount, source_module, transaction_id, reverses_entry_id FROM ledger_entries WHERE rowid > ? ORDER BY rowid', [row]);
const ledgerNorm = (rows) => S(rows.map((r) => [r.account, r.direction, Math.round(Number(r.amount) * 1000), r.source_module, r.reverses_entry_id ? 'R' : '']).map((x) => S(x)).sort());
/** Der Saldo je Konto und Gegenpartei über das GANZE Hauptbuch — was ein Bericht zeigt. */
const salden = () => dbQ(BIZ_DB, `SELECT account, COALESCE(counterparty_id, '') AS cp,
    ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
  FROM ledger_entries GROUP BY account, cp HAVING ABS(net) > 0.0005 ORDER BY account, cp`);
const saldoCp = (cp) => dbQ(BIZ_DB, `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
  FROM ledger_entries WHERE counterparty_id = ? GROUP BY account HAVING ABS(net) > 0.0005 ORDER BY account`, [cp]);
const activeLinks = (id) => dbQ(BIZ_DB, "SELECT media_id, sort_order, is_primary FROM media_links WHERE entity_id = ? AND deleted_at IS NULL ORDER BY sort_order", [id]);
const deletedLinks = (id) => dbQ(BIZ_DB, "SELECT media_id FROM media_links WHERE entity_id = ? AND deleted_at IS NOT NULL", [id]);
const auditVon = (ids) => dbQ(BIZ_DB, `SELECT entity_type, action_type, field_name FROM audit_log WHERE entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`, ids);
const AKTEUR_SPALTE = /(_by|^user_id|_user_id)$/;
const akteure = (rows) => [...new Set(rows.flatMap((r) => Object.entries(r || {})
  .filter(([k, v]) => AKTEUR_SPALTE.test(k) && v !== null && v !== undefined && v !== '').map(([, v]) => String(v))))];

// ── Normalisieren: Kennungen, Zeiten, Nummern raus; Zwillingsnamen (… C / … P) gleichgesetzt ──────
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /\b[0-9a-f]{32,64}\b/g;
const NUMMER_RE = /\b[A-Z]{2,5}-(?:\d{4}-)?\d{3,6}\b/g;
const TEXTFELD = /^(description|notes|note|title|reason)$/;
function zw(v, k) {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v !== 'string') return v;
  let s = v.replace(UUID_RE, '<uuid>').replace(HEX_RE, '<hex>').replace(NUMMER_RE, '<nr>').replace(/\bNo: \d+/g, 'No: <nr>')
    .replace(/((?:r6f|R6F|r7a|R7A|pp14|PP14)[A-Za-z0-9 _-]*?[ -])([CP])(?![A-Za-z0-9])/g, '$1X');
  if (k && TEXTFELD.test(k)) s = s.replace(/\b[0-9a-f]{8}\b/g, '<id8>');
  return s;
}
const OHNE_STD = /^(id|created_at|updated_at|created_by|recorded_at|occurred_at|entry_no|transaction_id|[a-z_]*_number|sync_status|[a-z_]*_at|assigned_to|changed_by|user_id|link_id)$/;
// Der Handelnde ist GEWOLLT verschieden (B gegen A) und wird eigens geprüft.
const OHNE_AKTEUR = /(_by|_user_id)$/;
function nzWert(v, ohne, k) {
  if (Array.isArray(v)) return v.map((x) => nzWert(x, ohne)).map((x) => S(x)).sort().map((x) => JSON.parse(x));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v)
      .filter(([kk]) => !OHNE_STD.test(kk) && !OHNE_AKTEUR.test(kk) && !(ohne && ohne.test(kk)))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kk, vv]) => [kk, nzWert(vv, ohne, kk)]));
  }
  return zw(v, k);
}
const nz = (v, ohne) => S(nzWert(v, ohne));

// ── Die Welt des Laufs: Zwillinge für PC2 (C) und Primary (P) ─────────────────
const KUNDE = (x) => `pp14-kunde-${x}`;
const LIEF = (x) => `pp14-lief-${x}`;
const OW = (x) => `pp14-ow-${x}`, OI = (x) => `pp14-oi-${x}`;
const RO = (x) => `pp14-ro-${x}`, RI = (x) => `pp14-ri-${x}`, RK = (x) => `pp14-rk-${x}`, RC = (x) => `pp14-rc-${x}`;
const LO = (x) => `pp14-lo-${x}`, LK = (x) => `pp14-lk-${x}`, LC = (x) => `pp14-lc-${x}`;
const HEUTE = new Date().toISOString().slice(0, 10);
const tag = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const jpeg = (salt) => execFileSync(SEED, ['jpeg', String(salt)], { encoding: 'utf8' }).trim();
const JPG = (n) => join(RUN, `pp14-${n}.jpg`);
const DOC_NAME = (x) => `pp14-beleg-${x}.png`;
const DOC_FILE = (x) => join(RUN, DOC_NAME(x));

/** Geschäftsdaten + Benutzer B in der Geschäftsdatenbank (dieselbe Form wie der Onboarding-Owner). */
function seedGeschaeft() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'pp14-cat', branch_id, name: 'PP14 Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    // Der Platzhalter-Kunde eigener Ware — derselbe, den `createRepair` anlegt.
    const eigen = `sys-own-shop-${branch_id}`;
    insert(db, 'customers', { id: eigen, branch_id, first_name: 'Own', last_name: 'Shop', country: 'BH', language: 'en', vip_level: 0, preferences: '[]', customer_type: 'SYSTEM', sales_stage: 'lead', created_at: now, updated_at: now });
    // Eigene Ware in der Reparatur: Einstand 0, ein Los zu 0, Verkaufspreis 300, Steuer 0 %.
    const artikel = (id, name) => {
      insert(db, 'products', { id, branch_id, category_id: 'pp14-cat', brand: 'Omega', name, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 0, purchase_currency: 'BHD', planned_sale_price: 300, tax_scheme: 'ZERO', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{}', stock_status: 'in_repair', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: id + '-lot', branch_id, product_id: id, unit_cost: 0, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    };
    const reparatur = (id, nr, felder) => insert(db, 'repairs', {
      id, branch_id, repair_number: nr, voucher_code: nr, issue_description: 'PP14 Service', status: 'diagnosed',
      received_at: now, diagnosed_at: now, images: '[]', item_attributes: '{}', revision: 1, created_at: now, updated_at: now, ...felder,
    });
    const kostenzeile = (id, rid, lief, betrag) => insert(db, 'repair_lines', {
      id, branch_id, repair_id: rid, position: 1, supplier_id: lief, work_type: 'service', description: 'PP14 Werkstatt',
      cost_amount: betrag, status: 'OPEN', created_at: now, updated_at: now,
    });
    for (const x of ['C', 'P']) {
      const tel = (n) => `+973 38${x === 'C' ? '1' : '2'}${n} 0${x === 'C' ? '6' : '7'}33`;
      insert(db, 'customers', { id: KUNDE(x), branch_id, first_name: 'PP14', last_name: `Kunde ${x}`, phone: tel('1'), country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
      insert(db, 'suppliers', { id: LIEF(x), branch_id, name: `PP14 Werkstatt ${x}`, phone: tel('4'), active: 1, created_at: now, updated_at: now });
      artikel(OW(x), `PP14 Uhr W ${x}`);
      artikel(OI(x), `PP14 Uhr I ${x}`);
      // Eigene Ware + Werkstatt: die Zeile trägt den Voranschlag (wie `createRepair`), internal_cost ist der Spiegel.
      reparatur(RO(x), `PP14-RO-${x}`, { repair_scope: 'OWN', customer_id: eigen, product_id: OW(x), lot_id: OW(x) + '-lot', repair_type: 'external', workshop_supplier_id: LIEF(x), estimated_cost: 100, internal_cost: 100, tax_scheme: 'VAT_10', item_brand: 'Omega', item_model: `PP14 Uhr W ${x}` });
      kostenzeile(LO(x), RO(x), LIEF(x), 100);
      // Eigene Ware, eigene Arbeit 100 — keine Werkstatt.
      reparatur(RI(x), `PP14-RI-${x}`, { repair_scope: 'OWN', customer_id: eigen, product_id: OI(x), lot_id: OI(x) + '-lot', repair_type: 'internal', internal_cost: 100, tax_scheme: 'VAT_10', item_brand: 'Omega', item_model: `PP14 Uhr I ${x}` });
      // Kundenware + Werkstatt 100, Preis 300, Steuer 0 %.
      reparatur(RK(x), `PP14-RK-${x}`, { repair_scope: 'CUSTOMER', customer_id: KUNDE(x), repair_type: 'external', workshop_supplier_id: LIEF(x), estimated_cost: 100, internal_cost: 100, charge_to_customer: 300, tax_scheme: 'ZERO', item_brand: 'Rolex', item_model: `PP14 Kunde ${x}` });
      kostenzeile(LK(x), RK(x), LIEF(x), 100);
      // Kundenware + Werkstatt 40 — ihre Zeile wird unbezahlt storniert.
      reparatur(RC(x), `PP14-RC-${x}`, { repair_scope: 'CUSTOMER', customer_id: KUNDE(x), repair_type: 'external', workshop_supplier_id: LIEF(x), estimated_cost: 40, internal_cost: 40, charge_to_customer: 200, tax_scheme: 'ZERO', item_brand: 'Cartier', item_model: `PP14 Storno ${x}` });
      kostenzeile(LC(x), RC(x), LIEF(x), 40);
    }
    // B wie der Onboarding-Owner: dieselbe Mandanten- und Filialzuordnung, dieselbe Rolle.
    const a = db.prepare('SELECT u.id, u.tenant_id, u.password_hash, ub.branch_id, ub.role FROM users u JOIN user_branches ub ON ub.user_id = u.id ORDER BY ub.is_default DESC, u.created_at LIMIT 1').get() || {};
    insert(db, 'users', { id: B_ID, tenant_id: a.tenant_id || 'tenant-1', email: B_EMAIL, password_hash: a.password_hash || '!', name: B_NAME, active: 1, created_at: now, updated_at: now });
    insert(db, 'user_branches', { user_id: B_ID, branch_id: a.branch_id || branch_id, role: a.role || 'ADMIN', is_default: 1, created_at: now });
    return a;
  } finally { try { db.close(); } catch { /* zu */ } }
}
/** B im Server-Konto: dieselben drei Zeilen wie der Owner (users, user_branches, server_credentials). */
function seedServerB() {
  const db = new DatabaseSync(SERVER_DB);
  try {
    const now = new Date().toISOString();
    const o = db.prepare('SELECT u.tenant_id, u.password_hash FROM users u WHERE u.email = ?').get(OWNER_EMAIL) || {};
    insert(db, 'users', { id: B_ID, tenant_id: o.tenant_id || 'tenant-1', email: B_EMAIL, password_hash: o.password_hash, name: B_NAME, active: 1, created_at: now, updated_at: now });
    insert(db, 'user_branches', { user_id: B_ID, branch_id: 'branch-main', role: 'owner', is_default: 1, created_at: now });
    insert(db, 'server_credentials', { user_id: B_ID, credential_state: 'active', password_changed_at: now, provisioned_at: now, provisioned_by: 'r6f-e2e-seed', classified_reason: 'r6f-second-real-user', created_at: now, updated_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Die Nachweise ────────────────────────────────────────────────────────────
const OPS = ['repairs.update_status', 'expenses.record_payment', 'repairs.create_invoice', 'repairs.cancel_line'];
const LOST_OPS = ['repairs.update_status'];
const BEWEIS = Object.fromEntries(OPS.map((o) => [o, { C: 0, P: 0, versuche: 0 }]));
const LOST = {};
const EXTRA = { ownWorkshop: false, ownInternal: false, customer: false, invoice: false, paid: false, reversalAllowed: false, reversalBlocked: false, sale: false, reports: false };
let AKTEUR_FEHL = 0;
let A_ID = '';
const akteurVon = (x) => (x === 'C' ? B_ID : A_ID);
const andererVon = (x) => (x === 'C' ? A_ID : B_ID);
/** Nur Diagnose: am Primary mitgeschriebene gescheiterte Kern-Aufrufe (Befehl + Fehlertext) und Konsole. */
// Übersteht ein Neuladen (Page.addScriptToEvaluateOnNewDocument) und schreibt JEDEN `media_*`-Aufruf
// mit Ausgang mit (Fehlerobjekt als JSON), dazu jeden anderen gescheiterten Aufruf.
const PRIMARY_HAKEN_SRC = `(function haken() {
  const t = window.__TAURI_INTERNALS__;
  if (!t || !t.invoke) { setTimeout(haken, 30); return; }
  if (t.__r6fDiag) return;
  t.__r6fDiag = true; window.__invokeErrors = window.__invokeErrors || [];
  const oi = t.invoke.bind(t);
  const kurz = (v) => { try { return (typeof v === 'string' ? v : JSON.stringify(v, (k, x) => (Array.isArray(x) && x.length > 32 ? '[' + x.length + ' items]' : x))).slice(0, 700); } catch (e) { return String(v).slice(0, 700); } };
  t.invoke = (cmd, args, opts) => {
    const c = String(cmd); const at = new Date().toISOString();
    return Promise.resolve(oi(cmd, args, opts)).then((r) => {
      if (/^media_/.test(c)) window.__invokeErrors.push({ cmd: c, ok: true, res: kurz(r), at });
      return r;
    }, (e) => {
      window.__invokeErrors.push({ cmd: c, ok: false, err: kurz(e), at, id: args && (args.ingestRequestId || '') });
      throw e;
    });
  };
})();`;
async function diagnose(wer) {
  try {
    const inv = await primary.ev('return JSON.stringify((window.__invokeErrors || []).filter((x) => !x.ok || /prepare|commit|abort/.test(x.cmd)).slice(-12));');
    console.log(`      (diagnose ${wer}) Kern-Aufrufe am Primary (media_* und gescheiterte): ${inv}`);
    const jdir = join(APP_DATA_DIR, 'media', '.ingest-journal');
    const haengend = existsSync(jdir) ? readdirSync(jdir).filter((f) => f.endsWith('.json')).map((f) => {
      try { const j = JSON.parse(readFileSync(join(jdir, f), 'utf8')); return j.state === 'preparing' ? `${j.ingest_request_id} (${j.created_at})` : null; } catch { return null; }
    }).filter(Boolean) : [];
    const tmp = existsSync(jdir) ? readdirSync(jdir).filter((f) => /\.tmp$|journal-tmp|\.creating$/.test(f)) : [];
    console.log(`      (diagnose ${wer}) Ingest-Journal: ${haengend.length} hängend in „preparing" [${haengend.join(' · ')}] · Temp-Dateien [${tmp.join(' · ')}]`);
    console.log(`      (diagnose ${wer}) Primary-Konsole: ${(primary.events || []).filter((e) => !/embedding compute failed|Pull failed: 401/.test(e)).slice(-8).join(' // ').slice(0, 1500)}`);
  } catch (e) { console.log(`      (diagnose ${wer}) ${String(e)}`); }
}
const absenderVon = (cmdId) =>String(dbQ(BIZ_DB, 'SELECT user_id FROM remote_command_ledger WHERE command_id = ?', [cmdId])[0]?.user_id || '');

/**
 * EINE Handlung, zweimal durch dieselbe Maske: PC2 (als B, Fernauftrag) auf seinem Zwilling, dann der
 * Primary (als A).
 *   route(x) · bereit(x) (Ausdruck) · vorher(x) · fuellen(c,x,v) → 'OK' · speichern(c,x,v) → 'OK'
 *   fertig(x,v) (genau EINE Wirkung am Primary) · zu(x,v) (Ausdruck: die Maske meldet Erfolg)
 *   keys (die Absichtsfelder des Rumpfs) · rumpf(p,x,v) · zustand(x,v) (was verglichen wird) · ohne (RegExp)
 *   neu(x,v) (die neuen Zeilen, deren created_by den Handelnden nennen muss) · buchungsZeilen
 *   lost (Selektor der Fehleranzeige): nur auf PC2 — die erste Antwort geht verloren.
 */
async function paar(def) {
  const erg = {};
  BEWEIS[def.op].versuche++;
  for (const x of ['C', 'P']) {
    const seite = x === 'C' ? 'PC2/B' : 'Primary/A';
    const wer = `${def.name} [${seite}]`;
    const failVor = FAIL;
    let c;
    await syncRuhe();
    if (x === 'C') { client = await lade(client, def.route('C')); c = client; }
    else { await gehFrisch(primary, def.route('P')); c = primary; }
    const bereit = await warteBis(c, def.bereit(x), 45000);
    ok(bereit, `${wer} die Maske ist da (${def.route(x)})`);
    const v = { ...(def.vorher ? def.vorher(x) : {}), led: ledgerMax(), aud: maxRow('audit_log') };
    const vorCmd = x === 'C' ? (await buchungen(c)).length : 0;
    const vorAnt = x === 'C' ? (await antworten(c)).length : 0;
    const m = bereit ? await def.fuellen(c, x, v) : 'NICHT-BEREIT';
    ok(m === 'OK', `${wer} Eingaben (${m})`);
    if (def.lost && x === 'C') {
      await c.ev(`window.__dropNext = ${S(def.op)}; return 1;`);
      const s1 = await def.speichern(c, x, v);
      const sichtbar = await warteBis(c, `[...document.querySelectorAll(${S(def.lost)})].some((e) => /No answer from the primary/.test(e.textContent))`, 60000);
      ok(s1 === 'OK' && sichtbar, `LOST ${def.name}: die Antwort geht verloren — die Maske sagt „keine Antwort, nochmal speichern" (${s1}; ${String(await fehlerText(c, def.lost)).slice(0, 220)})`);
      const lief = await warteAuf(() => def.fertig(x, v));
      ok(lief, `LOST ${def.name}: der Primary HAT ausgeführt`);
      const offen = !(await c.ev(`return !!(${def.zu(x, v)});`));
      ok(offen, `LOST ${def.name}: kein Schein-Erfolg — die Maske bleibt stehen`);
      await sleep(500);
      const s2 = await def.speichern(c, x, v);
      ok(s2 === 'OK', `LOST ${def.name}: „Speichern" noch einmal (${s2})`);
      LOST[def.op] = s1 === 'OK' && sichtbar && lief && offen && s2 === 'OK';
    } else {
      const s = await def.speichern(c, x, v);
      ok(s === 'OK', `${wer} Speichern (${s})`);
    }
    const wirkung = await warteAuf(() => def.fertig(x, v), 90);
    ok(wirkung, `${wer} die Wirkung steht am Primary (Hinweis: ${String(await fehlerText(c)).slice(0, 220) || 'keiner'})`);
    if (!wirkung) await diagnose(wer);
    ok(await warteBis(c, def.zu(x, v), 30000), `${wer} die Maske meldet Erfolg (Hinweis: ${String(await fehlerText(c)).slice(0, 220) || 'keiner'})`);
    await sleep(600);
    await syncRuhe();
    ok(def.fertig(x, v), `${wer} genau EINE Wirkung — auch danach noch (nach dem Echo des Primary)`);
    // Das Fenster DIESER Seite schließen — der Zwilling am Primary läuft danach und darf nicht mitzählen.
    Object.assign(v, { ledEnd: ledgerMax(), audEnd: maxRow('audit_log') });
    const L = fenster('ledger_entries', v.led, v.ledEnd);
    const A = fenster('audit_log', v.aud, v.audEnd);
    const Z = def.zustand(x, v);
    // Wer hat gehandelt? Kein Protokoll und keine Buchung dieses Fensters nennt den ANDEREN Benutzer.
    const genannt = akteure([...A, ...L]);
    const leck = genannt.includes(andererVon(x));
    const auditGut = A.length === 0 || A.some((a) => a.changed_by === akteurVon(x));
    const neu = def.neu ? def.neu(x, v) : [];
    const neuGut = neu.length > 0 ? neu.every((r) => r.created_by === akteurVon(x)) : !def.neu;
    ok(!leck && auditGut && neuGut, `${wer} AKTEUR Protokoll (${A.length}), Buchungen (${L.length}) und neue Zeilen (${neu.length}) nennen den Handelnden ${akteurVon(x)}, nie den anderen (${genannt.join(',') || '—'} · neu ${neu.map((r) => r.created_by).join(',') || '—'})`);
    if (leck || !auditGut || !neuGut) AKTEUR_FEHL++;
    let cc = [];
    if (x === 'C') {
      cc = (await buchungen(c)).slice(vorCmd);
      const n = def.lost ? 2 : 1;
      const gleich = n === 1 || (cc.length === 2 && cc[0].commandId === cc[1].commandId && S(cc[0].payload) === S(cc[1].payload));
      ok(cc.length === n && cc.every((k) => k.op === def.op) && gleich,
        `${wer} ${n === 1 ? 'genau EIN Auftrag' : 'zweimal DERSELBE Auftrag (Kennung + Rumpf)'} ${def.op} (${cc.map((k) => k.op + ':' + String(k.commandId).slice(0, 8)).join(', ')})`);
      const p = cc[0]?.payload || {};
      ok(S(Object.keys(p).sort()) === S([...def.keys].sort()), `${wer} der Rumpf nennt nur die Absicht — keinen Urheber (${S(Object.keys(p).sort())})`);
      if (def.rumpf) ok(!!def.rumpf(p, x, v), `${wer} die Werte im Rumpf (${S(p).slice(0, 500)})`);
      const abs = absenderVon(cc[0]?.commandId);
      ok(abs === B_ID, `${wer} der durable Nachweis nennt den geprüften Absender B (${abs})`);
      if (abs !== B_ID) AKTEUR_FEHL++;
      if (def.lost) {
        const an = (await antworten(c)).slice(vorAnt).filter((a) => a.op === def.op);
        const replay = an.length === 2 && an[0].dropped === true && an[1].ok === true && an[1].replayed === true;
        ok(replay, `LOST ${def.name}: die Wiederholung bekommt das eingefrorene Ergebnis (replayed) (${S(an).slice(0, 240)})`);
        LOST[def.op] = !!LOST[def.op] && replay;
      }
    }
    erg[x] = { L, A, Z, v, cmds: cc, gut: FAIL === failVor };
  }
  const zC = nz(erg.C.Z, def.ohne), zP = nz(erg.P.Z, def.ohne);
  const z = zC === zP;
  ok(z, `${def.name} PARITAET Zustand: Primary == PC2 (PC2 ${zC.slice(0, 900)} // Primary ${zP.slice(0, 900)})`);
  const lC = ledgerNorm(erg.C.L), lP = ledgerNorm(erg.P.L);
  const l = lC === lP;
  ok(l, `${def.name} PARITAET Hauptbuch je Quelle: Primary == PC2 (${erg.C.L.length}/${erg.P.L.length} Zeilen; ${lC.slice(0, 300)} // ${lP.slice(0, 300)})`);
  const aNorm = (rows) => S(rows.map((a) => [a.entity_type, a.action_type, a.field_name]).map((r) => S(r)).sort());
  const a = aNorm(erg.C.A) === aNorm(erg.P.A);
  ok(a, `${def.name} PARITAET Protokoll: dieselben Einträge (Art/Feld) (${aNorm(erg.C.A).slice(0, 300)} // ${aNorm(erg.P.A).slice(0, 300)})`);
  if (def.buchungsZeilen !== undefined) {
    ok(erg.C.L.length === def.buchungsZeilen && erg.P.L.length === def.buchungsZeilen,
      `${def.name} Hauptbuch: je Seite genau ${def.buchungsZeilen} Zeilen (${erg.C.L.length}/${erg.P.L.length})`);
  }
  if (def.lost) LOST[def.op] = !!LOST[def.op] && l && z && erg.C.L.length === erg.P.L.length;
  if (erg.C.gut && z && l && a) BEWEIS[def.op].C++;
  if (erg.P.gut && z && l && a) BEWEIS[def.op].P++;
  return erg;
}

// ── Die Masken, wie ein Mensch sie bedient ──────────────────────────────────
/** Eine Suchauswahl (SearchSelect): den Auslöser (den n-ten, sonst den letzten) öffnen, dann den Eintrag. */
async function ssPick(c, placeholder, optionId, nr = -1) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=${nr}<0?l[l.length-1]:l[${nr}]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}
/** Die Mehrfachauswahl (SearchMultiSelect): öffnen, die Einträge nach Beschriftung anhaken, schließen. */
async function mehrfachWahl(c, placeholder, labels) {
  const a = await c.ev(`const s=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()===${S(placeholder)}); if(!s) return 'NO'; s.parentElement.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  const r = [];
  for (const label of labels) {
    const suche = `[...document.querySelectorAll('div.cursor-pointer')].find(d=>{ const t=d.querySelector(':scope > div.flex-1 > div'); return t && t.textContent.trim()===${S(label)}; })`;
    if (!(await warteBis(c, suche, 10000))) { r.push('KEIN-EINTRAG:' + label); continue; }
    r.push(await c.ev(`const d=${suche}; d.click(); return 'OK';`));
    await sleep(250);
  }
  await c.ev("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1;");
  await sleep(250);
  return alleOk(r);
}
/** Der Nummerndialog (NumberTypeDialog): normal oder Sonder, dann bestätigen. */
async function nummerWahl(c, sonder) {
  if (!(await warteBis(c, q('[data-final-number-confirm]'), 15000))) return 'KEIN-NUMMERNDIALOG';
  const r = [await klick(c, sonder ? '[data-final-number-special]' : '[data-final-number-normal]')];
  await sleep(250);
  r.push(await klick(c, '[data-final-number-confirm]'));
  return alleOk(r);
}
/** Ein Foto in die (letzte) Bildauswahl der offenen Maske legen — über den Dateidialog-Weg des Browsers. */
async function fotoWaehlen(c, file) {
  await c.send('DOM.enable', {});
  const { root } = await c.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][accept="image/*"]' });
  if (!nodeIds || nodeIds.length === 0) return 'KEIN-FELD';
  await c.send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[nodeIds.length - 1] });
  return 'OK';
}
async function setFileApp(c, sel, path) {
  const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false });
  if (!r.result?.objectId) return 'KEIN-FELD:' + sel;
  await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: path ? [path] : [] });
  return 'OK';
}
const JPEGS = "[...document.querySelectorAll('img')].filter(i=>/^data:image\\/jpeg/.test(i.src)).length";
/** Die Maske „New Product" (NewProductModal): Kategorie, Marke, Name, Foto — dann ihr Knopf. */
async function neuerArtikel(c, brand, name, submit, foto) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='R6F Cat')", 15000))) return 'KEINE-ARTIKELMASKE';
  await clickText(c, 'R6F Cat'); await sleep(300);
  const r = [await setByLabelPrefix(c, 'BRAND', brand), await setByLabelPrefix(c, 'NAME / MODEL', name)];
  const vor = await c.ev(`return ${JPEGS};`);
  if (await fotoWaehlen(c, foto) !== 'OK') r.push('KEIN-FOTOFELD');
  if (!(await warteBis(c, `${JPEGS} > ${vor}`, 15000))) r.push('KEIN-VORSCHAUBILD');
  await sleep(300);
  // Die Duplikatserkennung FRAGT bei ähnlichen Artikeln — ein Mensch antwortet „Create anyway".
  const trotzdem = "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Create anyway')";
  if (await c.ev(`return ${trotzdem};`)) await clickText(c, 'Create anyway');
  else {
    r.push(await clickIncludes(c, submit));
    if (await warteBis(c, trotzdem, 2500)) await clickText(c, 'Create anyway');
  }
  if (!(await warteBis(c, "![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='R6F Cat')", 15000))) {
    r.push('ARTIKELMASKE-BLEIBT:' + String(await c.ev('return document.body.innerText.slice(-200);')).replace(/\s+/g, ' '));
  }
  return alleOk(r);
}

// ── Die Galerie der Artikelseite (wie `media-edit-ui.e2e.mjs`) ─────────────────
const PHOTO_INPUT = 'input[type=file][accept="image/*"]';
const draftPhotos = (c) => c.ev(`const inp=document.querySelector('input[type=file][accept="image/*"]'); if(!inp) return -1; const grid=inp.parentElement.firstElementChild; return [...grid.children].filter(x=>x.querySelector('img')).length;`);
const removePhoto = (c, idx) => c.ev(`const inp=document.querySelector('input[type=file][accept="image/*"]'); if(!inp) return 'NO'; const grid=inp.parentElement.firstElementChild; const cells=[...grid.children].filter(x=>x.querySelector('img')); const cell=cells[${idx}]; if(!cell) return 'NOCELL'; const b=cell.querySelector('button'); if(!b) return 'NOBTN'; b.click(); return 'OK';`);
const clickEdit = (c) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Edit'); if(!b) return 'NO'; b.click(); return 'OK';`);
const photoControlsLocked = (c) => c.ev(`return !!document.querySelector('#media-loading-notice');`);
async function waitStableFileInput(c, t = 8000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    const a = await c.ev(`const e=document.querySelector(${S(PHOTO_INPUT)}); if(!e||!document.contains(e)) return null; window.__e2eLastInput=e; return true;`);
    if (a) {
      await sleep(350);
      const same = await c.ev(`const e=document.querySelector(${S(PHOTO_INPUT)}); return !!e && document.contains(e) && e===window.__e2eLastInput;`);
      if (same) return true;
      continue;
    }
    await sleep(200);
  }
  return false;
}
async function waitDraftUptake(c, before, t) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    const n = await draftPhotos(c);
    if (n === before + 1) return true;
    if (n > before + 1) return false;
    await sleep(250);
  }
  return false;
}
/** Ein Foto über das echte versteckte Feld — mit genau EINER kontrollierten Wiederholung des Dateiwegs. */
async function addPhoto(c, path) {
  const before = await draftPhotos(c);
  await waitStableFileInput(c);
  await setFileApp(c, PHOTO_INPUT, path);
  if (await waitDraftUptake(c, before, 15000)) return true;
  if ((await draftPhotos(c)) !== before) return false;
  await waitStableFileInput(c);
  await setFileApp(c, PHOTO_INPUT, null);
  await sleep(600);
  const afterClear = await draftPhotos(c);
  if (afterClear === before + 1) return true;
  if (afterClear !== before) return false;
  await setFileApp(c, PHOTO_INPUT, path);
  return waitDraftUptake(c, before, 15000);
}
/** „Edit" und warten, bis der Entwurf die Galerie trägt UND das Bildbearbeiten frei ist. */
async function enterEditor(c, expectPhotos, t = 30000) {
  await clickEdit(c);
  const end = Date.now() + t;
  while (Date.now() < end) {
    if ((await draftPhotos(c)) === expectPhotos && !(await photoControlsLocked(c))
      && await c.ev(`return ${q('[data-product-images="ready"]')} !== null;`)) return true;
    await sleep(300);
  }
  return false;
}

// ── Stände für den Vergleich ─────────────────────────────────────────────────
const inListe = (ids) => ids.map(() => '?').join(',');
const artikelStand = (ids) => dbQ(BIZ_DB, `SELECT id, stock_status, quantity, purchase_price, source_type, images FROM products WHERE id IN (${inListe(ids)}) ORDER BY id`, ids);
const loseStand = (ids) => dbQ(BIZ_DB, `SELECT product_id, unit_cost, qty_total, qty_remaining, status FROM stock_lots WHERE product_id IN (${inListe(ids)}) ORDER BY product_id, rowid`, ids);

// ── Vorbereitung am Primary (als A) über die normalen, schon bewiesenen Masken ──
async function einkaufAmPrimary(name, x, zeilen, zahlung, notiz) {
  await syncRuhe();
  await gehFrisch(primary, '/purchases/new');
  const r = [];
  if (await warteBis(primary, q('[data-purchase-save]'), 45000)) {
    await sleep(800);
    r.push(await ssPick(primary, 'Search suppliers...', LIEF(x)));
    for (let i = 0; i < zeilen.length; i++) {
      if (i > 0) { r.push(await clickText(primary, 'Add Item')); await sleep(300); }
      r.push(await waehleNth(primary, 'Existing', i, 'existing')); await sleep(400);
      r.push(await ssPick(primary, 'Pick product...', zeilen[i].pid, i)); await sleep(300);
      r.push(await setNth(primary, 'input[type="number"][min="1"]', i, String(zeilen[i].qty)));
      r.push(await setNth(primary, 'input[type="number"][min="0"][step="0.001"]', i, String(zeilen[i].preis)));
    }
    r.push(await setByLabel(primary, 'AMOUNT (BHD)', String(zahlung)));
    r.push(await clickText(primary, 'Cash'));
    r.push(await setVal(primary, 'textarea[placeholder^="z.B. Lieferscheinnummer"]', notiz));
    await sleep(400);
  } else r.push('KEINE-MASKE');
  const m = alleOk(r);
  const s = m === 'OK' ? await klick(primary, '[data-purchase-save]') : 'NICHT-GEFUELLT';
  const mit = () => dbQ(BIZ_DB, 'SELECT id FROM purchases WHERE notes = ?', [notiz]);
  const da = s === 'OK' && await warteAuf(() => mit().length === 1, 60);
  const id = mit()[0]?.id;
  ok(da && !!id, `VORBEREITUNG ${name} (${x}) am Primary als A über „New Purchase" (${m}/${s}; ${String(await primary.ev('return document.body.innerText.slice(0,200);')).replace(/\s+/g, ' ').slice(0, 160)})`);
  return id;
}
async function anzahlungAmPrimary(x, oid, betrag) {
  await syncRuhe();
  await gehFrisch(primary, `/orders/${oid}`);
  const r = [];
  if (await warteBis(primary, knopfDa('Add Payment'), 45000)) {
    r.push(await clickText(primary, 'Add Payment'));
    if (await warteBis(primary, q('[data-save-order-payment]'), 10000)) {
      await sleep(300);
      r.push(await setByLabel(primary, 'AMOUNT (BHD)', String(betrag)));
      await sleep(200);
      r.push(await klick(primary, '[data-save-order-payment]'));
    } else r.push('KEINE-ZAHLMASKE');
  } else r.push('KEIN-KNOPF');
  const da = alleOk(r) === 'OK' && await warteAuf(() => zahl('SELECT COUNT(*) AS n FROM order_payments WHERE order_id = ?', [oid]) === 1);
  ok(da, `VORBEREITUNG Anzahlung ${betrag} bar auf ${oid} am Primary als A (${alleOk(r)}; ${String(await fehlerText(primary)).slice(0, 160)})`);
}
/** Ein Knopf einer Positionszeile der Auftragsseite: im Statusfeld oder in der Aktionsspalte daneben. */
const zeilenKnopf = (lineId, hook, nachbar = false) => nachbar
  ? `(document.querySelector('[data-order-line="${lineId}"]')?.nextElementSibling?.querySelector('${hook}') || null)`
  : `document.querySelector('[data-order-line="${lineId}"] ${hook}')`;
/** Ein Knopf in der Zeile einer Aufgabe (nach ihrem Titel gefunden). */
const aufgabenKnopf = (titel, hook) => `([...document.querySelectorAll('${hook}')].find((b) => b.parentElement && b.parentElement.parentElement && b.parentElement.parentElement.textContent.includes(${S(titel)})) || null)`;
const PR = {}, PK = {}, TASK = {}, DOC = {};
const ANZ_CN = {};

// ── PP-13/PP-14: Stände und Handlungen an der Reparatur ──────────────────────
const repStand = (id) => { const r = zeile('repairs', id); return { status: r.status, margin: r.margin === null || r.margin === undefined ? null : Number(r.margin), fertig: !!r.completed_at, rechnung: !!r.invoice_id }; };
const repAusgaben = (id) => dbQ(BIZ_DB, "SELECT id, category, amount, paid_amount, status, supplier_id, created_by FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED' ORDER BY rowid", [id]);
const alleAusgabenIds = (id) => dbQ(BIZ_DB, "SELECT id FROM expenses WHERE related_module = 'repair' AND related_entity_id = ?", [id]).map((r) => r.id);
const zahlungIds = (ids) => (ids.length ? dbQ(BIZ_DB, `SELECT id FROM expense_payments WHERE expense_id IN (${ids.map(() => '?').join(',')})`, ids).map((r) => r.id) : []);
/** Das Hauptbuch je Konto (Soll − Haben) über die genannten Quellen — Stornos eingeschlossen. */
function netto(ids) {
  if (!ids.length) return {};
  const rows = dbQ(BIZ_DB, `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
    FROM ledger_entries WHERE source_id IN (${ids.map(() => '?').join(',')}) GROUP BY account ORDER BY account`, ids);
  return Object.fromEntries(rows.filter((r) => Math.abs(Number(r.net)) > 0.0005).map((r) => [r.account, Number(r.net)]));
}
const artikelKosten = (pid) => ({ einstand: Number(zeile('products', pid).purchase_price), los: Number(zeile('stock_lots', pid + '-lot').unit_cost), bestand: zeile('products', pid).stock_status });
/** Die Reparatur, wie sie verglichen wird: Stand, Ausgaben, Konten ihrer Ausgaben und Zahlungen, Artikel. */
/** Quellen der aktivierten Eigenleistung: die Reparatur (eigene Kosten) und ihre Zeilen im Haus. */
const eigenQuellen = (rep) => [rep, ...dbQ(BIZ_DB, 'SELECT id FROM repair_lines WHERE repair_id = ?', [rep]).map((r) => r.id)];
const reparaturZustand = (rep, pid) => {
  const ids = alleAusgabenIds(rep);
  return {
    rep: repStand(rep),
    exp: repAusgaben(rep).map((e) => [e.category, Number(e.amount), Number(e.paid_amount), e.status, e.supplier_id ? 'WERKSTATT' : null]),
    konten: netto([...ids, ...zahlungIds(ids), ...eigenQuellen(rep)]),
    artikel: pid ? artikelKosten(pid) : null,
  };
};
const SAVE_OK = "(!document.querySelector('[data-save-error]') || !document.querySelector('[data-save-error]').textContent.trim())";

/** „Mark as …" der Detailseite — `repairs.update_status`. */
const weiter = (name, rep, ziel, pid, extra = {}) => ({
  name, op: 'repairs.update_status', ...(extra.lost ? { lost: '[data-save-error]' } : {}),
  route: (x) => `/repairs/${rep(x)}`,
  bereit: () => q('[data-repair-advance]'),
  vorher: (x) => ({ rev: Number(zeile('repairs', rep(x)).revision), exp: idSet('expenses') }),
  fuellen: async () => 'OK',
  speichern: (c) => klick(c, '[data-repair-advance]'),
  fertig: (x) => zeile('repairs', rep(x)).status === ziel,
  zu: () => SAVE_OK,
  keys: ['expectedRevision', 'repairId', 'status'],
  rumpf: (p, x, v) => p.repairId === rep('C') && p.status === ziel && p.expectedRevision === v.rev,
  zustand: (x) => reparaturZustand(rep(x), pid ? pid(x) : null),
  ...(extra.neu ? { neu: (x, v) => neueZeilen('expenses', v.exp, 'related_entity_id = ?', [rep(x)]) } : {}),
  buchungsZeilen: extra.zeilen ?? 0,
});

/** „Create Invoice" der Detailseite: 0 % Steuer, normale Nummer — `repairs.create_invoice`. */
const rechnungDef = {
  name: 'REPAIR-INVOICE (Kundenware + Werkstatt)', op: 'repairs.create_invoice',
  route: (x) => `/repairs/${RK(x)}`,
  bereit: () => q('[data-repair-invoice]'),
  vorher: (x) => ({ rev: Number(zeile('repairs', RK(x)).revision), inv: idSet('invoices') }),
  fuellen: async (c) => {
    const r = [await klick(c, '[data-repair-invoice]')];
    if (!(await warteBis(c, knopfDa('Next: Choose Number Type'), 15000))) return 'KEIN-STEUERDIALOG';
    r.push(await c.ev("const l=[...document.querySelectorAll('label')].find(x=>x.textContent.includes('0% (No VAT)')); if(!l) return 'NO-ZERO'; l.click(); return 'OK';"));
    await sleep(250);
    r.push(await clickText(c, 'Next: Choose Number Type'));
    if (!(await warteBis(c, `${q('[data-final-number-confirm]')} || ${knopfDa('Confirm')}`, 15000))) return 'KEIN-NUMMERNDIALOG';
    if (await exists(c, '[data-final-number-normal]')) r.push(await klick(c, '[data-final-number-normal]'));
    await sleep(250);
    return alleOk(r);
  },
  speichern: async (c) => ((await exists(c, '[data-final-number-confirm]')) ? klick(c, '[data-final-number-confirm]') : clickText(c, 'Confirm')),
  fertig: (x) => !!zeile('repairs', RK(x)).invoice_id,
  zu: () => "/^\\/invoices\\//.test(location.pathname)",
  // Die normale Nummer schickt die Maske ohne `specialMark` (nur „Special Final" setzt es).
  keys: ['repairs', 'taxScheme'],
  rumpf: (p, x, v) => p.taxScheme === 'ZERO' && p.specialMark === undefined && p.repairs?.length === 1
    && p.repairs[0].repairId === RK('C') && p.repairs[0].expectedRevision === v.rev,
  zustand: (x) => kundenRechnung(x),
  neu: (x, v) => neueZeilen('invoices', v.inv),
  buchungsZeilen: 2,
};
/** Die Rechnung der Kundenreparatur: Einstand, Marge, ihre Buchungen — dazu die Reparatur. */
const kundenRechnung = (x) => {
  const inv = zeile('invoices', zeile('repairs', RK(x)).invoice_id);
  const line = dbQ(BIZ_DB, 'SELECT purchase_price_snapshot, line_total, tax_scheme FROM invoice_lines WHERE invoice_id = ?', [inv.id])[0] || {};
  return { einstand: Number(line.purchase_price_snapshot), marge: Number(inv.margin_snapshot), netto: Number(inv.net_amount), konten: netto([inv.id]), reparatur: reparaturZustand(RK(x)) };
};

const werkstattAusgabe = (x) => String(zeile('repair_lines', LK(x)).expense_id || '');
/** „Record Payment" der Ausgabenliste auf die Werkstattschuld der Kundenreparatur — `expenses.record_payment`. */
const zahlungDef = {
  name: 'EXPENSE-PAY (Werkstatt der Kundenreparatur)', op: 'expenses.record_payment',
  route: () => '/expenses',
  bereit: (x) => q(`[data-expense-pay-open="${werkstattAusgabe(x)}"]`),
  vorher: (x) => ({ exp: werkstattAusgabe(x), rev: Number(zeile('expenses', werkstattAusgabe(x)).revision) }),
  fuellen: async (c, x, v) => {
    const r = [await klick(c, `[data-expense-pay-open="${v.exp}"]`)];
    if (!(await warteBis(c, q('[data-expense-pay-save]'), 10000))) return 'KEINE-MASKE';
    await sleep(300);
    r.push(await setVal(c, '[data-expense-pay-amount]', '100'));
    r.push(await klick(c, '[data-expense-pay-method="cash"]'));
    await sleep(300);
    return alleOk(r);
  },
  speichern: (c) => klick(c, '[data-expense-pay-save]'),
  fertig: (x, v) => Number(zeile('expenses', v.exp).paid_amount) >= 100 - 0.0005,
  zu: () => `!${q('[data-expense-pay-save]')}`,
  keys: ['amount', 'expectedRevision', 'expenseId', 'method'],
  rumpf: (p, x, v) => p.expenseId === werkstattAusgabe('C') && Number(p.amount) === 100 && p.method === 'cash' && p.expectedRevision === v.rev,
  zustand: (x) => reparaturZustand(RK(x)),
  buchungsZeilen: 2,
};

/** „Remove" einer Kostenzeile der Detailseite — `repairs.cancel_line`. */
const stornoDef = {
  name: 'REPAIR-CANCEL-LINE (Kundenware, unbezahlt)', op: 'repairs.cancel_line',
  route: (x) => `/repairs/${RC(x)}`,
  bereit: () => q('[data-cancel-repair-line]'),
  vorher: (x) => ({ rev: Number(zeile('repairs', RC(x)).revision), exp: String(zeile('repair_lines', LC(x)).expense_id || '') }),
  fuellen: async () => 'OK',
  speichern: (c) => klick(c, '[data-cancel-repair-line]'),
  fertig: (x) => !zeile('repair_lines', LC(x)).id,
  zu: () => `!${q('[data-cancel-repair-line]')}`,
  keys: ['expectedRevision', 'lineId', 'repairId'],
  rumpf: (p, x, v) => p.repairId === RC('C') && p.lineId === LC('C') && p.expectedRevision === v.rev,
  zustand: (x, v) => ({ rep: repStand(RC(x)), exp: repAusgaben(RC(x)).length, konten: netto([v.exp]) }),
  buchungsZeilen: 2,
};

/** Vorbereitung am Primary (als A): der Verkauf eigener Ware über die normale Rechnungsmaske (Kasse, voll). */
async function verkaufAmPrimary(x, pid) {
  await syncRuhe();
  const iids = idSet('invoices');
  await gehFrisch(primary, '/invoices/new');
  const r = [];
  if (await warteBis(primary, q('[data-ss-trigger="Search clients..."]'), 45000)) {
    r.push(await ssPick(primary, 'Search clients...', KUNDE(x)));
    r.push(await ssPick(primary, 'Pick product...', pid));
    if (!(await warteBis(primary, "document.body.innerText.includes('Lot ·')", 15000))) r.push('KEIN-LOS');
    r.push(await klick(primary, '[data-invoice-pay-method="cash"]'));
    await sleep(200);
    r.push(await klick(primary, '[data-invoice-pay-full]'));
    await sleep(400);
    r.push(await klick(primary, '[data-invoice-save]'));
    r.push(await nummerWahl(primary, false));
  } else r.push('NICHT-BEREIT');
  const mitArtikel = 'id IN (SELECT invoice_id FROM invoice_lines WHERE product_id = ?)';
  const da = alleOk(r) === 'OK' && await warteAuf(() => neueZeilen('invoices', iids, mitArtikel, [pid]).length === 1);
  const id = neueZeilen('invoices', iids, mitArtikel, [pid])[0]?.id;
  ok(da && !!id, `VORBEREITUNG Verkauf ${pid} für 300 am Primary als A (${alleOk(r)}; ${String(await fehlerText(primary)).slice(0, 160)})`);
  return id;
}

let STALE = '', staleVorher = '', dateienVorher = [], LEDGER_BASIS = 0;
try {
  assertE2eClientBinary(CLIENT_APP);
  if (!existsSync(SEED)) throw new Error('e2e_scope_seed.exe fehlt: ' + SEED);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));
  // Echte, deterministische JPEGs (derselbe Weg wie der Media-Lauf): A+B Vorbereitung, C neu, D Fertigung.
  for (const [n, salt] of [['a', 11], ['b', 23], ['c', 37], ['d', 51]]) writeFileSync(JPG(n), Buffer.from(jpeg(salt), 'base64'));

  // ══ SETUP — Primary (Onboarding als A), Geschäftsdaten, Benutzer B, Primary-Server ══════════════
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R7C Pending Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R7C Pending Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R7C Pending Admin A');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  // R7B-Review — die Anmeldung ist Sekunden alt. Kein Warten, kein hartes Beenden: Fenster schließen.
  const ersterPid = eigenerPrimary();
  primary.close(); primary = null;
  const ersterZu = regulaerSchliessen(ersterPid);
  const ersterWeg = await waitPidGone(ersterPid, 90000);
  ok(ersterZu && ersterWeg, `CLOSE nach dem Onboarding regulär geschlossen (${ersterZu}/${ersterWeg})`);
  const aVorlage = seedGeschaeft();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });
  seedServerB();
  {
    const u = dbQ(SERVER_DB, 'SELECT u.id, u.email, u.active, u.password_hash, ub.role, ub.is_default, ub.branch_id FROM users u JOIN user_branches ub ON ub.user_id = u.id WHERE u.id = ?', [B_ID])[0] || {};
    const cr = dbQ(SERVER_DB, 'SELECT credential_state FROM server_credentials WHERE user_id = ?', [B_ID])[0] || {};
    ok(u.email === B_EMAIL && Number(u.active) === 1 && u.role === 'owner' && /^\$2/.test(String(u.password_hash || '')) && cr.credential_state === 'active',
      `SETUP Benutzer B im Server-Konto: eigene Kennung/E-Mail, Owner, echter bcrypt-Wert, Zugang aktiv (${u.id}/${u.role}/${cr.credential_state})`);
    const bb = dbQ(BIZ_DB, 'SELECT u.id, ub.role, ub.branch_id FROM users u JOIN user_branches ub ON ub.user_id = u.id WHERE u.id = ?', [B_ID])[0] || {};
    ok(bb.id === B_ID && bb.role === aVorlage.role, `SETUP Benutzer B in der Geschäftsdatenbank wie der Onboarding-Owner (${bb.role}/${bb.branch_id})`);
  }

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  const zweiterStartAngemeldet = await warteBis(primary, `!!document.querySelector(${S(SHELL)})`, 90000);
  RV_STATE.closeLogin = zweiterStartAngemeldet;
  ok(zweiterStartAngemeldet, 'CLOSE der zweite Start ist angemeldet — die Sekunden alte Anmeldung überstand das reguläre Beenden ohne Wartezeit');
  await waitFor(primary, SHELL, 5000);
  await primary.ev(DIALOGE_PRIMARY);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }
  A_ID = String(await primary.ev('try { return JSON.parse(localStorage.getItem("lataif_session") || "{}").userId || ""; } catch (e) { return ""; }') || '');
  ok(!!A_ID && A_ID !== B_ID, `SETUP der Primary ist als A angemeldet (${A_ID}), B ist ein anderer Mensch (${B_ID})`);
  await primary.send('Page.enable', {});
  // ══════════════════════════════════════════════════════════════════════
  // Helfer dieses Laufs
  // ══════════════════════════════════════════════════════════════════════
  const R7C_ALLE = { lost: 'S1', changedNotSent: 'S2', clarifyAfterRestart: 'S3', pc2RegularClose: 'S3', ledgerConflictHttp: 'S4', zeroByteRecovery: 'S5', restoreStart: 'S5' };
  const R7C = Object.fromEntries(Object.entries(R7C_ALLE).filter(([, s]) => s === 'S1' || laeuft(s)).map(([k]) => [k, false]));
  const MESS = {};
  RV_STATE = R7C; MESS_STATE = MESS;
  const api = async (pfad, body, token) => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${pfad}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch { /* kein JSON */ }
      return { status: r.status, j };
    } catch (e) { return { status: 0, j: null, err: String(e) }; }
  };
  /** Ein Fernauftrag an den frisch gestarteten Primary. Nur „noch nicht erreichbar" (0/503) wird wiederholt — dieselbe
   *  Kennung, derselbe Rumpf; jede echte Antwort zählt. */
  async function befehlAn(body, token, budgetMs = 60000) {
    const end = Date.now() + budgetMs;
    let r = await api('/api/command', body, token);
    while ((r.status === 0 || r.status === 503) && Date.now() < end) { await sleep(1000); r = await api('/api/command', body, token); }
    return r;
  }
  /** Derselbe Inhalt, gleich welche Schlüsselreihenfolge (wie `stableJson` der Anwendung). */
  const stabil = (v) => {
    if (Array.isArray(v)) return `[${v.map((x) => stabil(x === undefined ? null : x)).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stabil(v[k])}`).join(',')}}`;
    return JSON.stringify(v) ?? 'null';
  };
  const gleicherPfad = (a, b) => String(a || '').replace(/\//g, '\\').toLowerCase() === String(b || '').replace(/\//g, '\\').toLowerCase();
  /** Die PID des PC2, den DIESER Lauf gestartet hat (der zuletzt gestartete Test-Prozess am exakten Pfad). */
  function eigenerPc2() {
    const pid = startedPids().filter((p) => gleicherPfad(pathOfPid(p), CLIENT_APP)).pop();
    if (!pid) throw new Error('no own pc2 pid');
    return pid;
  }
  /** Reguläres Beenden von PC2: Fenster schließen (WM_CLOSE) — nur eine eigene PID am exakten Test-Pfad. */
  function regulaerSchliessenPc2(pid) {
    const live = pathOfPid(pid);
    if (!startedPids().includes(pid) || !gleicherPfad(live, CLIENT_APP)) throw new Error(`refusing to close ${pid} (${live})`);
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).CloseMainWindow()`], { encoding: 'utf8', windowsHide: true });
    return /True/i.test(out);
  }
  /**
   * Einen EIGENEN Prozess beenden: regulär (Fenster schließen) und warten. Endet er im Budget nicht, beendet ihn der
   * Helfer hart — nur diese PID, nur am exakten Test-Pfad (`killTestPid`). `hart` wird mitgeschrieben und zählt nie als
   * reguläres Ende.
   */
  async function eigenenBeenden(wer, pid, exe, budgetMs) {
    const t0 = Date.now();
    let zu = false;
    try { zu = gleicherPfad(exe, APP) ? regulaerSchliessen(pid) : regulaerSchliessenPc2(pid); } catch (e) { console.log(`      (${wer}) ${String(e)}`); }
    const weg = await waitPidGone(pid, budgetMs);
    let hart = false, hartWeg = false;
    if (!weg) {
      hart = killTestPid(pid, exe);
      hartWeg = await waitPidGone(pid, 30000);
      console.log(`      (${wer}) endete nicht nach dem Schließen — eigener Prozess ${pid} über den Helfer beendet (${hart}/${hartWeg})`);
    }
    return { wer, zu, weg, hart, beendet: weg || hartWeg, exitCode: await exitCodeVon(pid), sekunden: Math.round((Date.now() - t0) / 1000) };
  }
  async function primaryStarten() {
    const t0 = Date.now();
    primary = await attach(APP_CDP, APP, appEnv());
    await waitInvoke(primary);
    const oben = await warteBis(primary, `!!document.querySelector(${S(SHELL)})`, 180000);
    await primary.ev(DIALOGE_PRIMARY);
    await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
    let da = false;
    for (let i = 0; i < 240 && !da; i++) { try { da = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* noch nicht */ } if (!da) await sleep(500); }
    return { oben, da, startS: Math.round((Date.now() - t0) / 1000) };
  }
  /** Reguläres Beenden des eigenen Primary, dann Neustart — danach ist der Kennungsspeicher der Brücke (Rust) leer. */
  async function primaryNeustart(was) {
    const pid = eigenerPrimary();
    try { primary.close(); } catch { /* zu */ }
    primary = null;
    const ende = await eigenenBeenden(`Primary ${was}`, pid, APP, 180000);
    const start = await primaryStarten();
    const r = { was, ...ende, ...start };
    (MESS.neustarts ||= []).push(r);
    return r;
  }
  async function pc2Anmelden() {
    await waitFor(client, 'input[type="password"]', 60000);
    await setVal(client, 'input[type="email"]', B_EMAIL);
    await setVal(client, 'input[type="password"]', OWNER_PW);
    await click(client, '[data-client-signin]');
    await waitFor(client, SHELL, 90000);
  }

  // Die Ablage der offenen Vorgänge von PC2: `<AppLocalData>/pending-saves/<Kennung>.json`. Den Ort nennt die Anwendung
  // selbst (derselbe Pfad-Aufruf wie `appLocalDataDir()`, BaseDirectory.AppLocalData = 15); die beiden möglichen Orte
  // (umgelenktes und echtes LOCALAPPDATA) sind nur die Rückfallebene.
  const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
  let PEND_DIR = '';
  const pendKandidaten = () => [...new Set([PEND_DIR, join(CLIENT_HOME, 'Local', CLIENT_IDENT, 'pending-saves'), join(REAL_LOCALAPPDATA, CLIENT_IDENT, 'pending-saves')].filter(Boolean))];
  const nurTestOrdner = (d) => String(d).toLowerCase().includes(CLIENT_IDENT) && /pending-saves$/i.test(String(d));
  function pendDatei(id) {
    if (!id) return null;
    for (const d of pendKandidaten()) { const f = join(d, `${id}.json`); if (existsSync(f)) return f; }
    return null;
  }
  function pendLesen(id) {
    const f = pendDatei(id);
    if (!f) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return { unlesbar: String(e) }; }
  }
  const pendAlle = () => pendKandidaten().flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => /\.json$/i.test(f)).map((f) => f.slice(0, -5)) : []));
  /** Jede `lataif*.db*` unter den Profilorten von PC2 (nur lesen) — PC2 darf keine Geschäfts- oder Serverdatenbank haben. */
  function pc2Datenbanken() {
    const out = [];
    const lauf = (d, tiefe) => {
      if (tiefe > 8 || !existsSync(d)) return;
      let eintraege = [];
      try { eintraege = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of eintraege) {
        const p = join(d, x.name);
        if (x.isDirectory()) lauf(p, tiefe + 1);
        else if (/^lataif.*\.db/i.test(x.name)) out.push(p);
      }
    };
    for (const w of [CLIENT_HOME, join(REAL_LOCALAPPDATA, CLIENT_IDENT), join(REAL_APPDATA, CLIENT_IDENT)]) lauf(w, 0);
    return out;
  }

  // Der Kunde dieses Laufs (Vor- und Nachname eindeutig) und der durable Nachweis des Primary.
  const STEMPEL = Date.now().toString(36);
  const VOR = 'R7C';
  const NACH1 = `Offen ${STEMPEL}`;
  const NACH2 = `Geaendert ${STEMPEL}`;
  const kundenMit = (nach) => zahl('SELECT COUNT(*) AS n FROM customers WHERE first_name = ? AND last_name = ?', [VOR, nach]);
  const nachweisVon = (id) => zahl('SELECT COUNT(*) AS n FROM remote_command_ledger WHERE command_id = ?', [id]);
  const anlagenImNachweis = () => zahl("SELECT COUNT(*) AS n FROM remote_command_ledger WHERE op = 'customers.create'");
  const FEHLER_KUNDE = '[data-save-error]';
  const fehlerMit = (re) => `[...document.querySelectorAll(${S(FEHLER_KUNDE)})].some((e) => ${re}.test(e.textContent))`;
  const BAR = '[data-testid="pending-saves-bar"]';
  const ROW = '[data-testid="pending-save-row"]';
  const NOTE = '[data-testid="pending-save-note"]';
  const zeilenDerLeiste = (c) => c.ev(`return JSON.stringify([...document.querySelectorAll(${S(ROW)})].map((e) => ({ id: e.getAttribute('data-command-id'), state: e.getAttribute('data-state') })));`).then((s) => JSON.parse(s || '[]'));

  // ══ SETUP — PC2: frischer Rechner ohne Datenbank, leere Ablage, Anmeldung als B über die normale Maske ══════════
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  {
    const basis = await client.ev("return await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 15 }).catch((e) => 'FEHLER:' + String(e));");
    if (typeof basis === 'string' && basis && !basis.startsWith('FEHLER:')) PEND_DIR = join(basis, 'pending-saves');
    MESS.pendingDir = PEND_DIR || String(basis);
    // Reste eines früheren Laufs — nur im Ordner des e2e-Clients. Sonst stünden fremde Vorgänge in der Leiste.
    for (const d of pendKandidaten()) if (nurTestOrdner(d) && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await click(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await click(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await pc2Anmelden();
  {
    const sitzung = JSON.parse(String(await client.ev('return localStorage.getItem("lataif_session") || "{}";')) || '{}');
    ok(sitzung.userId === B_ID && nurTestOrdner(PEND_DIR) && pendAlle().length === 0,
      `SETUP PC2 ohne Datenbank, angemeldet als B (${sitzung.userId}); Ablage der offenen Vorgänge leer (${MESS.pendingDir})`);
  }
  await beobachterLegen();
  client = await lade(client, '/clients');
  await waitFor(client, SHELL, 45000);
  ok(await client.ev('return Array.isArray(window.__cmds);') === true && !(await exists(client, BAR)),
    'SETUP der Beobachter liegt vor dem ersten Skript der Seite; keine Leiste „Unresolved saves"');

  // ══ S1 LOST — „New Client" auf PC2, die Antwort geht verloren (zugestellt, ausgeführt, Antwort verworfen) ══════
  let CMD_ID = '', ORIG = null;
  {
    client = await lade(client, '/clients');
    await waitFor(client, SHELL, 45000);
    const r = [await clickText(client, 'New Client')];
    await sleep(700);
    r.push(await setByLabel(client, 'FIRST NAME', VOR));
    r.push(await setByLabel(client, 'LAST NAME', NACH1));
    await sleep(300);
    const vorCmd = (await kommandos(client)).length;
    const vorAnlagen = anlagenImNachweis();
    await client.ev("window.__dropNext = 'customers.create'; return 1;");
    r.push(await klick(client, '[data-create-client]'));
    const text = await warteBis(client, fehlerMit(/No answer from the primary/), 60000);
    const fehler = String(await fehlerText(client, FEHLER_KUNDE));
    const cc = (await kommandos(client)).slice(vorCmd).filter((x) => x.op === 'customers.create');
    CMD_ID = String(cc[0]?.commandId || '');
    const verworfen = (await antworten(client)).some((a) => a.commandId === CMD_ID && a.dropped === true);
    const lief = await warteAuf(() => kundenMit(NACH1) === 1, 60);
    const offen = await exists(client, '[data-create-client]');
    // Vor dem Versand geschrieben („sending"), nach der Stille auf „unresolved" gesetzt.
    let rec = null;
    for (let i = 0; i < 20 && !(rec && rec.state === 'unresolved'); i++) { rec = pendLesen(CMD_ID); if (!(rec && rec.state === 'unresolved')) await sleep(500); }
    ORIG = rec?.payload || null;
    const dateiGut = !!rec && rec.v === 1 && rec.commandId === CMD_ID && rec.op === 'customers.create' && rec.state === 'unresolved'
      && !!ORIG && S(ORIG).includes(NACH1) && S(ORIG).includes(VOR)
      && rec.context?.userId === B_ID && String(rec.context?.server || '').includes(String(PORT));
    const gleicherRumpf = !!ORIG && stabil(ORIG) === stabil(cc[0]?.payload ?? null);
    const offeneDateien = pendAlle();
    MESS.s1 = { commandId: CMD_ID, datei: pendDatei(CMD_ID), state: rec?.state, lastCode: rec?.lastCode, kunden: kundenMit(NACH1), nachweis: nachweisVon(CMD_ID), anlagen: [vorAnlagen, anlagenImNachweis()], offeneDateien: offeneDateien.length };
    const gesendet = alleOk(r) === 'OK' && cc.length === 1 && verworfen && text;
    const einmal = lief && kundenMit(NACH1) === 1 && nachweisVon(CMD_ID) === 1 && anlagenImNachweis() === vorAnlagen + 1;
    ok(gesendet, `S1 LOST die Antwort geht verloren — die Maske sagt „No answer from the primary" (${alleOk(r)}; ${cc.length} Auftrag; verworfen ${verworfen}; ${fehler.slice(0, 160)})`);
    ok(einmal, `S1 LOST der Primary HAT genau einmal ausgeführt: 1 Kunde „${VOR} ${NACH1}", 1 Zeile im durablen Nachweis (${S(MESS.s1)})`);
    ok(offen, 'S1 LOST kein Schein-Erfolg — die Maske bleibt offen');
    ok(dateiGut && gleicherRumpf && offeneDateien.length === 1 && offeneDateien[0] === CMD_ID,
      `S1 LOST pending-saves/${CMD_ID}.json steht auf „unresolved", nennt B und den Primary, trägt den gesendeten ursprünglichen Rumpf (${rec?.state}/${rec?.lastCode}; gleich ${gleicherRumpf}; ${S(ORIG).slice(0, 200)})`);
    R7C.lost = gesendet && einmal && offen && dateiGut && gleicherRumpf && offeneDateien.length === 1;
  }

  // ══ S2 R2 — dieselbe offene Maske, ein Feld geändert: nichts geht hinaus ═════════════════════════════════════
  if (laeuft('S2')) {
    const vorCmd = (await kommandos(client)).length;
    const vorAnlagen = anlagenImNachweis();
    const r = [await setByLabel(client, 'LAST NAME', NACH2)];
    await sleep(400);
    r.push(await klick(client, '[data-create-client]'));
    const text = await warteBis(client, fehlerMit(/changes were NOT sent/), 30000);
    const fehler = String(await fehlerText(client, FEHLER_KUNDE));
    await sleep(1500);
    await spuelen(primary);
    const cc = (await kommandos(client)).slice(vorCmd).filter((x) => x.op === 'customers.create');
    const rec = pendLesen(CMD_ID);
    MESS.s2 = { gesendet: cc.length, anlagen: [vorAnlagen, anlagenImNachweis()], original: kundenMit(NACH1), geaendert: kundenMit(NACH2), nachweis: nachweisVon(CMD_ID), state: rec?.state, dateien: pendAlle().length };
    const gut = alleOk(r) === 'OK' && text && cc.length === 0 && anlagenImNachweis() === vorAnlagen && nachweisVon(CMD_ID) === 1
      && kundenMit(NACH1) === 1 && kundenMit(NACH2) === 0 && !!rec && rec.state === 'unresolved' && stabil(rec.payload) === stabil(ORIG);
    ok(gut, `S2 R2 geändertes Formular: „changes were NOT sent", kein Auftrag, kein neuer Nachweis, 1 Original-Kunde, 0 mit „${NACH2}", die Datei behält den ursprünglichen Rumpf (${alleOk(r)}; ${S(MESS.s2)}; ${fehler.slice(0, 160)})`);
    R7C.changedNotSent = gut;
  }

  // ══ S3 R1 — Primary UND PC2 regulär neu gestartet: die Leiste zeigt den Vorgang, „Clarify now" → Replay ══════════
  {
    const p = await primaryNeustart('S3');
    const pGut = p.zu && p.weg && !p.hart && p.oben && p.da;
    ok(pGut, `S3 der Primary endet nach dem Schließen selbst und startet neu — angemeldet, erreichbar (${S(p)})`);
    await ernte(client);
    // N1 — PC2 regulär beenden: Fenster schließen (WM_CLOSE) und warten, bis der Prozess VON SELBST endet (Exit-Code 0 aus
    // `AppHandle::exit(0)`). Bis `617c2c8` ging das nicht (Lauf 2: „state not managed … The app stays open", PC2 über den
    // Helfer beendet). Der Helfer bleibt nur Sicherheitsnetz und zählt dann als NEIN. Lebt PC2 nach 30 s noch, wird VOR dem
    // Helfer mitgeschrieben, was das Fenster zeigt und was die Konsole sagt. Vorher/nachher: die Datei des offenen Vorgangs
    // Byte für Byte gleich; keine Datenbank unter den Profilorten von PC2.
    const pc2Pid = eigenerPc2();
    const dateiVor = pendDatei(CMD_ID);
    const shaVor = dateiVor ? sha(dateiVor) : '';
    const dbVor = pc2Datenbanken();
    const t0 = Date.now();
    let zu1 = false, diag = null;
    try { zu1 = regulaerSchliessenPc2(pc2Pid); } catch (err) { diag = String(err); }
    const ersterWeg = await waitPidGone(pc2Pid, 30000);
    if (!ersterWeg) {
      try {
        diag = {
          text: String(await client.ev('return document.body.innerText.slice(0, 500);')).replace(/\s+/g, ' '),
          konsole: (client.events || []).slice(-12),
        };
      } catch (err) { diag = 'cdp: ' + String(err); }
    }
    MESS.pc2SchliessenDiag = diag;
    try { client.close(); } catch { /* zu */ }
    try { steuer.close(); } catch { /* zu */ }
    client = null; steuer = null;
    const e = ersterWeg
      ? { wer: 'PC2 S3', zu: zu1, weg: true, hart: false, beendet: true, exitCode: await exitCodeVon(pc2Pid), sekunden: Math.round((Date.now() - t0) / 1000) }
      : await eigenenBeenden('PC2 S3', pc2Pid, CLIENT_APP, 30000);
    const dateiNach = pendDatei(CMD_ID);
    const dateiUeberlebt = !!dateiVor && !!dateiNach && sha(dateiNach) === shaVor;
    const dbNachEnde = pc2Datenbanken();
    const regulaer = e.zu === true && e.weg === true && e.hart === false && e.exitCode === 0;
    ok(regulaer, `S3 N1 PC2 endet nach dem Schließen (WM_CLOSE) von selbst — Exit-Code 0, kein Helfer (${S(e)}${diag ? '; Diagnose ' + S(diag) : ''})`);
    R7C.pc2RegularClose = regulaer;
    client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
    await waitInvoke(client);
    const bereit = await warteBis(client, `${q(SHELL)} || ${q('[data-client-signin]')}`, 120000);
    let neuAngemeldet = false;
    if (bereit && !(await exists(client, SHELL))) { await pc2Anmelden(); neuAngemeldet = true; }
    const sitzung = JSON.parse(String(await client.ev('return localStorage.getItem("lataif_session") || "{}";')) || '{}');
    await beobachterLegen();
    client = await lade(client, '/clients');
    await waitFor(client, SHELL, 45000);
    MESS.pc2Neustart = { ...e, dateiVor: !!dateiVor, dateiUeberlebt, neuAngemeldet, userId: sitzung.userId, datenbanken: [dbVor.length, dbNachEnde.length] };
    const eGut = regulaer && dateiUeberlebt && sitzung.userId === B_ID && !neuAngemeldet;
    ok(eGut, `S3 PC2 nach dem regulären Ende neu gestartet: weiterhin als B angemeldet (ohne neue Anmeldung); die Datei des offenen Vorgangs vor und nach dem Beenden da, Byte für Byte gleich (${S(MESS.pc2Neustart)})`);

    const leiste = await warteBis(client, `${q(BAR)} && document.querySelectorAll(${S(ROW)}).length > 0`, 60000);
    const zeilen = await zeilenDerLeiste(client);
    const leisteGut = leiste && zeilen.length === 1 && zeilen[0].id === CMD_ID && zeilen[0].state === 'unresolved';
    ok(leisteGut, `S3 R1 die Leiste „Unresolved saves" zeigt genau diesen Vorgang (${S(zeilen)})`);

    const vorCmd = (await kommandos(client)).length;
    const vorAnt = (await antworten(client)).length;
    const vorAnlagen = anlagenImNachweis();
    const k = await klick(client, '[data-testid="pending-save-clarify"]');
    const notiz = await warteBis(client, `[...document.querySelectorAll(${S(NOTE)})].some((e) => /WAS saved/.test(e.textContent))`, 90000);
    const notizText = String(await client.ev(`return [...document.querySelectorAll(${S(NOTE)})].map((e) => e.textContent).join(' | ');`));
    const cc = (await kommandos(client)).slice(vorCmd).filter((x) => x.op === 'customers.create');
    const an = (await antworten(client)).slice(vorAnt).filter((a) => a.commandId === CMD_ID);
    let weg = false;
    for (let i = 0; i < 30 && !weg; i++) { weg = !pendDatei(CMD_ID); if (!weg) await sleep(500); }
    const keineZeile = await warteBis(client, `document.querySelectorAll(${S(ROW)}).length === 0`, 15000);
    await spuelen(primary);
    MESS.s3 = { klick: k, gesendet: cc.map((x) => String(x.commandId).slice(0, 8)), antwort: an, original: kundenMit(NACH1), geaendert: kundenMit(NACH2), nachweis: nachweisVon(CMD_ID), anlagen: [vorAnlagen, anlagenImNachweis()], dateiWeg: weg, dateien: pendAlle().length, notiz: notizText.slice(0, 160) };
    const gleich = cc.length === 1 && cc[0].commandId === CMD_ID && stabil(cc[0].payload) === stabil(ORIG);
    const replay = an.length === 1 && an[0].status === 200 && an[0].ok === true && an[0].replayed === true;
    const bestand = kundenMit(NACH1) === 1 && kundenMit(NACH2) === 0 && nachweisVon(CMD_ID) === 1 && anlagenImNachweis() === vorAnlagen;
    ok(k === 'OK' && notiz && gleich && replay, `S3 R1 „Clarify now" wiederholt den URSPRÜNGLICHEN Auftrag unter SEINER Kennung → „WAS saved" (Replay) (${S(MESS.s3)})`);
    ok(bestand, `S3 R1 nichts doppelt: 1 Kunde „${VOR} ${NACH1}", 0 mit „${NACH2}", genau 1 Nachweis für die Kennung`);
    ok(weg && keineZeile, `S3 R1 die Datei ist weg, die Leiste hat keine Zeile mehr (${weg}/${keineZeile})`);
    const dbEnde = pc2Datenbanken();
    const keineDb = dbVor.length === 0 && dbNachEnde.length === 0 && dbEnde.length === 0;
    ok(keineDb, `S3 keine Datenbank auf PC2 — vor dem Beenden, danach und nach Neustart + Klärung (${S([dbVor, dbNachEnde, dbEnde])})`);
    R7C.clarifyAfterRestart = pGut && eGut && leisteGut && k === 'OK' && notiz && gleich && replay && bestand && weg && keineZeile && keineDb;
  }

  // ══ S4 R3 — die Kennung nur noch im durablen Nachweis: anderer Rumpf → 409 not_executed, ursprünglicher → Replay ══
  if (laeuft('S4')) {
    const p = await primaryNeustart('S4');
    const pGut = p.zu && p.weg && !p.hart && p.oben && p.da;
    ok(pGut, `S4 der Primary erneut regulär neu gestartet — die Kennung steht nur noch im durablen Nachweis (${S(p)})`);
    const TOKEN_B = String(await client.ev('return localStorage.getItem("lataif_client_token") || "";'));
    const ANDERS = { ...(ORIG || {}), lastName: NACH2 };
    const vorAnlagen = anlagenImNachweis();
    const stand = () => ({ original: kundenMit(NACH1), geaendert: kundenMit(NACH2), nachweis: nachweisVon(CMD_ID), anlagen: anlagenImNachweis() });
    const unveraendert = (s) => s.original === 1 && s.geaendert === 0 && s.nachweis === 1 && s.anlagen === vorAnlagen;
    const k = await befehlAn({ op: 'customers.create', commandId: CMD_ID, payload: ANDERS }, TOKEN_B);
    await spuelen(primary);
    const nachK = stand();
    const konflikt = k.status === 409 && k.j?.ok === false && k.j?.error === 'BRIDGE_COMMAND_ID_CONFLICT' && k.j?.outcome === 'not_executed' && unveraendert(nachK);
    ok(konflikt, `S4 R3 dieselbe Kennung, anderer Rumpf → 409 BRIDGE_COMMAND_ID_CONFLICT / not_executed, Bestand unverändert (${k.status} ${S(k.j).slice(0, 220)}; ${S(nachK)})`);
    const o = await befehlAn({ op: 'customers.create', commandId: CMD_ID, payload: ORIG }, TOKEN_B);
    await spuelen(primary);
    const nachO = stand();
    const wieder = o.status === 200 && o.j?.ok === true && o.j?.value?.replayed === true && unveraendert(nachO);
    ok(wieder, `S4 R3 dieselbe Kennung, ursprünglicher Rumpf → 200 replayed, Bestand unverändert (${o.status} ${S(o.j).slice(0, 220)}; ${S(nachO)})`);
    MESS.s4 = { tokenB: TOKEN_B.length > 0, konflikt: [k.status, k.j?.error, k.j?.outcome], original: [o.status, o.j?.value?.replayed === true], ...nachO };
    R7C.ledgerConflictHttp = pGut && TOKEN_B.length > 0 && konflikt && wieder;
  }

  // ══ S5 R4 — die vorhandene 0-Byte-Geschäftsdatenbank: Wiederherstellungsmeldung, Datei unberührt ════════════════
  if (laeuft('S5')) {
    if (!BIZ_DB.includes('com.lataif.app.e2e') || !APP_DATA_DIR.includes('com.lataif.app.e2e')) throw new Error('refusing to touch a database outside the e2e data dir: ' + BIZ_DB);
    const pid = eigenerPrimary();
    try { primary.close(); } catch { /* zu */ }
    primary = null;
    const e1 = await eigenenBeenden('Primary S5 vor 0 Byte', pid, APP, 180000);
    const KOPIE = join(RUN, 'r7c-lataif.db.kopie');
    copyFileSync(BIZ_DB, KOPIE);
    const kopieSha = sha(KOPIE), kopieGroesse = statSync(KOPIE).size;
    const kundeInKopie = Number(dbQ(KOPIE, 'SELECT COUNT(*) AS n FROM customers WHERE first_name = ? AND last_name = ?', [VOR, NACH1])[0]?.n || 0);
    writeFileSync(BIZ_DB, Buffer.alloc(0));
    const null0 = statSync(BIZ_DB);
    const tmpDateien = () => readdirSync(APP_DATA_DIR).filter((f) => /^lataif\.db\.tmp/.test(f));
    const dbDateien = () => readdirSync(APP_DATA_DIR).filter((f) => f.startsWith('lataif.db')).sort();
    const tmpVor = tmpDateien(), dbVor = dbDateien();
    ok(e1.zu && e1.weg && !e1.hart && kopieGroesse > 0 && kundeInKopie === 1 && null0.size === 0,
      `S5 R4 Primary regulär beendet, Geschäftsdatenbank beiseite kopiert (${kopieGroesse} B, Kunde darin ${kundeInKopie}) und auf 0 Byte gesetzt (${S(e1)})`);
    await sleep(1200);
    primary = await attach(APP_CDP, APP, appEnv());
    await waitInvoke(primary);
    const RE = 'nicht geoeffnet werden|Sicherung wieder her';
    const schirm = await warteBis(primary, `/${RE}/.test(document.body.innerText)`, 90000);
    // Die Anwendung entscheidet fertig — ein spätes Speichern hätte jetzt Zeit gehabt.
    await sleep(6000);
    const text = String(await primary.ev('return document.body.innerText.slice(0, 400);')).replace(/\s+/g, ' ');
    const keineShell = !(await exists(primary, SHELL));
    const keinFirstRun = !(await exists(primary, '[data-first-run-gate]')) && !(await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]'));
    let health = 'no-answer';
    try { health = String((await fetch(`http://127.0.0.1:${PORT}/api/health`)).status); } catch { health = 'no-answer'; }
    const s1 = statSync(BIZ_DB);
    const laufend = s1.size === 0 && s1.mtimeMs === null0.mtimeMs && tmpDateien().length === tmpVor.length && S(dbDateien()) === S(dbVor);
    ok(schirm && keineShell && keinFirstRun, `S5 R4 die 0-Byte-Datenbank führt zur Wiederherstellungsmeldung — keine Anwendung, kein Ersteinrichten (${text.slice(0, 160)})`);
    ok(laufend, `S5 R4 während sie läuft: lataif.db 0 Byte, dieselbe Änderungszeit, keine lataif.db.tmp-* (${s1.size} B, mtime ${s1.mtimeMs === null0.mtimeMs}; ${S(dbDateien())})`);
    const pid2 = eigenerPrimary();
    try { primary.close(); } catch { /* zu */ }
    primary = null;
    const e2 = await eigenenBeenden('Primary S5 Wiederherstellungsschirm', pid2, APP, 60000);
    const s2 = statSync(BIZ_DB);
    const nachEnde = s2.size === 0 && s2.mtimeMs === null0.mtimeMs && tmpDateien().length === tmpVor.length && S(dbDateien()) === S(dbVor);
    ok(e2.beendet, `S5 R4 die eigene Instanz am Wiederherstellungsschirm ist beendet (regulär ${e2.weg}, sonst über den Helfer ${e2.hart})`);
    ok(nachEnde, `S5 R4 auch das Beenden fasst sie nicht an: 0 Byte, dieselbe Änderungszeit, keine lataif.db.tmp-* (${s2.size} B; ${S(dbDateien())})`);
    MESS.s5 = { vorher: e1.sekunden, kopieB: kopieGroesse, kundeInKopie, beendenAmSchirm: { zu: e2.zu, weg: e2.weg, hart: e2.hart }, healthAmSchirm: health, dbDateien: dbDateien() };
    R7C.zeroByteRecovery = e1.zu && e1.weg && !e1.hart && kundeInKopie === 1 && schirm && keineShell && keinFirstRun && laufend && nachEnde && e2.beendet;

    // Die Bytes zurück — ein normaler Start, der Kunde aus S1 ist da.
    writeFileSync(BIZ_DB, readFileSync(KOPIE));
    const zurueck = sha(BIZ_DB) === kopieSha;
    primary = await attach(APP_CDP, APP, appEnv());
    await waitInvoke(primary);
    const normal = await warteBis(primary, `${q(SHELL)} || ${q('input[type="password"]')}`, 180000);
    const text2 = String(await primary.ev('return document.body.innerText.slice(0, 400);')).replace(/\s+/g, ' ');
    const keinSchirm = !new RegExp(RE).test(text2);
    const angemeldet = await exists(primary, SHELL);
    const kunde = kundenMit(NACH1);
    MESS.s5.wiederStart = { zurueck, normal, angemeldet, kunde };
    ok(zurueck && normal && keinSchirm && kunde === 1, `S5 R4 die gesicherten Bytes zurück → normaler Start (${angemeldet ? 'angemeldet' : 'Anmeldung'}), der Kunde „${VOR} ${NACH1}" ist da (${kunde})`);
    R7C.restoreStart = zurueck && normal && keinSchirm && kunde === 1;
  }

  // Die Produktion (fremde lataif.exe) ist durch diesen Lauf nicht berührt worden.
  const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid);
  ok(fremdVorher.every((pid) => fremdNachher.includes(pid)), `ISOLATION jede fremde lataif.exe von vorher läuft noch (${fremdVorher.length} geprüft)`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  try { console.log('      (Primary-Konsole) ' + (primary?.events || []).slice(-15).join('\n      (Primary-Konsole) ')); } catch { /* egal */ }
  try { console.log('      (PC2-Konsole) ' + (client?.events || []).slice(-15).join('\n      (PC2-Konsole) ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log('\n  R7C offene Speichervorgänge        Ergebnis');
for (const [k, v] of Object.entries(RV_STATE)) console.log(`  ${k.padEnd(34)}${v === true ? 'ja' : 'NEIN'}`);
console.log('  Messung ' + JSON.stringify(MESS_STATE));
const dauer = Math.round((Date.now() - T0) / 1000);
const ZEILE = `post-parity r7c pending saves${NUR.length ? ` [gezielt: ${NUR.join(',')}; S1-Schritte als Vorbedingung]` : ''}: lost answer kept as unresolved file, changed form not sent, pc2 closes on its own, clarify after primary + pc2 restart replays once, durable-ledger id conflict is 409 not_executed, 0-byte business db stays untouched behind the recovery screen (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) {
  console.log(`\nFAIL — ${ZEILE}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
if (Object.keys(RV_STATE).length > 0 && Object.values(RV_STATE).every((v) => v === true)) console.log(NUR.length ? `POST_PARITY_R7C_TARGETED_${NUR.join('_')}_PROVED` : 'POST_PARITY_R7C_PENDING_SAVES_E2E_PROVED');
console.log(`\nPASS — ${ZEILE}`);
