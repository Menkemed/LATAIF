// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — Einkauf, Auftrag, Kommission, Fertigung, Bilder, Büro: zwei echte
// Anwendungen, zwei echte Benutzer.
// Run: node test/e2e/r6f-purchases-orders-office.e2e.mjs
//
//   Jede Handlung läuft ZWEIMAL durch dieselbe normale Maske: zuerst auf PC2 (ohne Geschäftsdatenbank,
//   angemeldet als Benutzer B, Fernauftrag /api/command), dann am Primary (angemeldet als A) auf dem
//   Zwilling. Verglichen wird in der Datenbank des Primary: Zeilen, Status, Bestand/Lose, Salden,
//   Hauptbuch je Quelle (ausgeglichen), Medien, Protokoll, Fassungen. Auf PC2 zusätzlich: genau EIN
//   Auftrag mit genau den Absichtsfeldern, der durable Nachweis nennt B.
//
//   PURCHASES   Return to Supplier (Bank-Erstattung), Cancel (verlorene Antwort), Inbox-Foto verwerfen
//   ORDERS      „beim Supplier bestellt" → „↺ Undo" → ARRIVED (Lieferanten-A/P) → Positionsdialog;
//               Cancel mit Geld (Rückzahlung per Bank, verlorene Antwort)
//   CONSIGNMENT Rückgabe nach dem Verkauf (bezahlt, „Keep", Bank) · Rückgabe (unbezahlt, „Return to
//               Owner") → Cancel Sale (cleanup, verlorene Antwort): Salden je Konto/Gegenpartei wieder
//               wie VOR dem Verkauf, Rechnung + Gutschrift CANCELLED (nicht gelöscht)
//   PRODUCTION  New Record mit Ausgangsfoto über die Zwischenablage (verlorene Antwort)
//   MEDIA       Produktbild ändern: eins weg, eins dazu → media_links am Primary
//   OFFICE      Aufgabe anlegen / ändern / erledigen; Dokument hochladen (verlorene Antwort) + OCR
//               (verlorene Antwort; am Primary aus SEINEM gespeicherten Inhalt — die echte Erkennung
//               mit den Dateien der App: derselbe Text auf beiden Seiten, gespeichert, kein Request
//               an einen fremden Host, weder am Primary noch auf PC2)
//   LEDGER      jede Buchungstransaktion dieses Laufs ist ausgeglichen
//   SAFETY      PC2 mit einer ALTEN lataif.db: unberührt, kein eigener Kern, keine lokale Datenbank
//
// PROZESS-ISOLATION (dauerhafte Regel): gestartet wird nur über `spawnTracked`, beendet wird nur, was
// dieser Lauf gestartet hat (PID mit Pfadprüfung) oder was am EXAKTEN Test-Pfad läuft. Die installierte
// Produktions-App wird nie beendet, nie benutzt; E:\LATAIF\Data und die Ports 3001/3443 bleiben tabu.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { OCR_FILES } from '../../src/core/ai/ocr-assets.ts';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r6f-owner-' + Math.random().toString(36).slice(2);
// Der zweite echte Benutzer (wie im R6E-Akteurslauf): eigene Kennung/E-Mail, Owner-Rolle, der bcrypt-Wert
// des Owners kopiert — die Anmeldung prüft ihn mit dem echten `bcrypt::verify`.
const B_ID = 'user-r6f-b';
const B_EMAIL = 'kollege.r6f@lataif.com';
const B_NAME = 'R6F Kollege B';

const RUN = join(os.tmpdir(), 'lataif-r6f', 'run-' + Date.now());
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
async function attach(cdpPort, exe, env) {
  spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref();
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
    .replace(/((?:r6f|R6F)[A-Za-z0-9 _-]*?[ -])([CP])(?![A-Za-z0-9])/g, '$1X');
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
const KUNDE = (x) => `r6f-kunde-${x}`, KONS = (x) => `r6f-kons-${x}`, KAEUFER = (x) => `r6f-kaeufer-${x}`;
const LIEF = (x) => `r6f-lief-${x}`;
const PA = (x) => `r6f-pa-${x}`, PB = (x) => `r6f-pb-${x}`, PC = (x) => `r6f-pc-${x}`;
const ORD1 = (x) => `r6f-ord1-${x}`, ORD2 = (x) => `r6f-ord2-${x}`;
const LA = (x) => `r6f-ol-a-${x}`, LB = (x) => `r6f-ol-b-${x}`, LC = (x) => `r6f-ol-c-${x}`;
const K1 = (x) => `r6f-kon1-${x}`, K2 = (x) => `r6f-kon2-${x}`, K1P = (x) => `r6f-k1-${x}`, K2P = (x) => `r6f-k2-${x}`;
const IN1 = (x) => `r6f-in1-${x}`, IN2 = (x) => `r6f-in2-${x}`;
const BILD = (x) => `r6f-bild-${x}`;
const INB = (x) => `r6f-inb-${x}`;
const HEUTE = new Date().toISOString().slice(0, 10);
const tag = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const jpeg = (salt) => execFileSync(SEED, ['jpeg', String(salt)], { encoding: 'utf8' }).trim();
const JPG = (n) => join(RUN, `r6f-${n}.jpg`);
const DOC_NAME = (x) => `r6f-beleg-${x}.png`;
const DOC_FILE = (x) => join(RUN, DOC_NAME(x));

/** Geschäftsdaten + Benutzer B in der Geschäftsdatenbank (dieselbe Form wie der Onboarding-Owner). */
function seedGeschaeft() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'r6f-cat', branch_id, name: 'R6F Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    const artikel = (id, name, extra = {}, lot = true) => {
      insert(db, 'products', { id, branch_id, category_id: 'r6f-cat', brand: 'Omega', name, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: 1000, tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{}', stock_status: 'in_stock', source_type: 'OWN', created_at: now, updated_at: now, ...extra });
      if (lot) insert(db, 'stock_lots', { id: id + '-lot', branch_id, product_id: id, unit_cost: extra.purchase_price ?? 100, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    };
    const bildDaten = `data:image/jpeg;base64,${jpeg(5)}`;
    for (const x of ['C', 'P']) {
      const tel = (n) => `+973 36${x === 'C' ? '1' : '2'}${n} 0${x === 'C' ? '6' : '7'}11`;
      for (const [id, first, last, n] of [[KUNDE(x), 'R6F', `Kunde ${x}`, '1'], [KONS(x), 'R6F', `Einlieferer ${x}`, '2'], [KAEUFER(x), 'R6F', `Kaeufer ${x}`, '3']]) {
        insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, phone: tel(n), country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
      }
      insert(db, 'suppliers', { id: LIEF(x), branch_id, name: `R6F Lief ${x}`, phone: tel('4'), active: 1, created_at: now, updated_at: now });
      // Einkauf: bestehende Artikel ohne Bestand — der Einkauf bucht Menge und Lose.
      for (const [id, n] of [[PA(x), 'pa'], [PB(x), 'pb'], [PC(x), 'pc']]) artikel(id, `R6F Ware ${n} ${x}`, { quantity: 0 }, false);
      // Aufträge: ORD1 (Wunschuhr ohne Artikel, Armband mit Lieferantenkosten), ORD2 (Anzahlung → Storno).
      insert(db, 'orders', { id: ORD1(x), branch_id, order_number: `R6F-ORD1-${x}`, customer_id: KUNDE(x), requested_brand: 'R6F', requested_model: 'Wunsch', agreed_price: 1500, status: 'pending', type: 'normal', revision: 1, created_at: now, updated_at: now });
      insert(db, 'order_lines', { id: LA(x), order_id: ORD1(x), description: `R6F Wunschuhr ${x}`, quantity: 1, unit_price: 500, line_total: 500, position: 1, tax_scheme: 'MARGIN', vat_rate: 0, is_customer_facing: 1, status: 'PENDING', created_at: now });
      insert(db, 'order_lines', { id: LB(x), order_id: ORD1(x), description: `R6F Armband ${x}`, quantity: 1, unit_price: 1000, line_total: 1000, position: 2, tax_scheme: 'MARGIN', vat_rate: 0, is_customer_facing: 1, status: 'PENDING', supplier_id: LIEF(x), cost_amount: 150, created_at: now });
      insert(db, 'orders', { id: ORD2(x), branch_id, order_number: `R6F-ORD2-${x}`, customer_id: KUNDE(x), requested_brand: 'R6F', requested_model: 'Kette', agreed_price: 800, status: 'pending', type: 'normal', revision: 1, created_at: now, updated_at: now });
      insert(db, 'order_lines', { id: LC(x), order_id: ORD2(x), description: `R6F Kette ${x}`, quantity: 1, unit_price: 800, line_total: 800, position: 1, tax_scheme: 'MARGIN', vat_rate: 0, is_customer_facing: 1, status: 'PENDING', created_at: now });
      // Kommissionen: K1 (bezahlt → Rückgabe „Keep"), K2 (unbezahlt → Rückgabe → Cancel Sale).
      for (const [kid, pid, nr] of [[K1(x), K1P(x), '1'], [K2(x), K2P(x), '2']]) {
        artikel(pid, `R6F Kom${nr} ${x}`, { stock_status: 'consignment', quantity: 1, purchase_price: 0, source_type: 'CONSIGNMENT' }, false);
        insert(db, 'consignments', { id: kid, branch_id, consignment_number: `R6F-KON${nr}-${x}`, consignor_id: KONS(x), product_id: pid, status: 'active', agreed_price: 1000, commission_type: 'percent', commission_rate: 20, payout_status: 'pending', payout_paid_amount: 0, agreement_date: HEUTE, revision: 1, created_at: now, updated_at: now });
      }
      // Fertigung: zwei Eingänge (150 + 100).
      artikel(IN1(x), `R6F In1 ${x}`, { purchase_price: 150 });
      artikel(IN2(x), `R6F In2 ${x}`, { purchase_price: 100 });
      // Produktbild.
      artikel(BILD(x), `R6F Bild ${x}`, { purchase_price: 400, expected_margin: 600 });
      // Inbox-Foto vom Handy.
      insert(db, 'purchase_inbox', { id: INB(x), branch_id, images: JSON.stringify([bildDaten]), note: `R6F vom Handy ${x}`, status: 'pending', created_at: now, created_by: 'user-mobile' });
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
const OPS = [
  'purchases.return_to_supplier', 'purchases.cancel', 'purchases.dismiss_inbox',
  'orders.mark_line_ordered', 'orders.update_line_status', 'orders.update_line', 'orders.cancel',
  'consignments.return_after_sale', 'consignments.cancel_sale',
  'production.create', 'products.update',
  'tasks.create', 'tasks.update', 'documents.upload', 'documents.set_ocr',
];
const LOST_OPS = ['purchases.cancel', 'orders.cancel', 'consignments.cancel_sale', 'production.create', 'documents.upload', 'documents.set_ocr'];
const BEWEIS = Object.fromEntries(OPS.map((o) => [o, { C: 0, P: 0, versuche: 0 }]));
const LOST = {};
const EXTRA = { purchase: false, inbox: false, order: false, presale: false, noDelete: false, keep: false, production: false, bild: false, tasks: false, upload: false, ocr: '' };
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
const kaufStand = (pid, x) => ({
  p: zeile('purchases', pid),
  lines: dbQ(BIZ_DB, 'SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid]),
  pays: dbQ(BIZ_DB, 'SELECT amount, method FROM purchase_payments WHERE purchase_id = ? ORDER BY rowid', [pid]),
  rets: dbQ(BIZ_DB, 'SELECT * FROM purchase_returns WHERE purchase_id = ?', [pid]),
  retLines: dbQ(BIZ_DB, 'SELECT prl.* FROM purchase_return_lines prl JOIN purchase_returns pr ON pr.id = prl.return_id WHERE pr.purchase_id = ? ORDER BY prl.rowid', [pid]),
  lose: dbQ(BIZ_DB, 'SELECT product_id, unit_cost, qty_total, qty_remaining, status FROM stock_lots WHERE purchase_id = ? ORDER BY product_id', [pid]),
  stueck: artikelStand([PA(x), PB(x), PC(x)]),
  guthaben: dbQ(BIZ_DB, 'SELECT amount, used_amount, status FROM supplier_credits WHERE supplier_id = ? ORDER BY rowid', [LIEF(x)]),
  audit: auditVon([pid]),
});
const auftragStand = (oid, x) => ({
  o: zeile('orders', oid),
  l: dbQ(BIZ_DB, 'SELECT * FROM order_lines WHERE order_id = ? ORDER BY position', [oid]),
  pay: dbQ(BIZ_DB, 'SELECT amount, method, converted_to_invoice FROM order_payments WHERE order_id = ? ORDER BY rowid', [oid]),
  exp: dbQ(BIZ_DB, 'SELECT category, amount, paid_amount, status, supplier_id, related_module, description FROM expenses WHERE supplier_id = ? ORDER BY rowid', [LIEF(x)]),
  cred: dbQ(BIZ_DB, 'SELECT amount, used_amount, status, source_type, note FROM customer_credits WHERE customer_id = ? ORDER BY rowid', [KUNDE(x)]),
  audit: auditVon([oid]),
});
const KINV = { 1: {}, 2: {} };
function konStand(nr, x) {
  const kid = nr === 1 ? K1(x) : K2(x);
  const k = zeile('consignments', kid);
  const inv = KINV[nr][x];
  return {
    k,
    prod: zeile('products', k.product_id),
    inv: zeile('invoices', inv),
    invLines: dbQ(BIZ_DB, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', [inv]),
    pays: dbQ(BIZ_DB, 'SELECT amount, method FROM payments WHERE invoice_id = ? ORDER BY rowid', [inv]),
    cn: dbQ(BIZ_DB, 'SELECT * FROM credit_notes WHERE invoice_id = ? ORDER BY rowid', [inv]),
    ret: dbQ(BIZ_DB, 'SELECT * FROM sales_returns WHERE invoice_id = ? ORDER BY rowid', [inv]),
    retLines: dbQ(BIZ_DB, 'SELECT srl.quantity, srl.unit_price, srl.vat_amount, srl.line_total FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id WHERE sr.invoice_id = ?', [inv]),
    pur: dbQ(BIZ_DB, 'SELECT purchase_number, status, total_amount, paid_amount, remaining_amount FROM purchases WHERE notes LIKE ?', [`%${k.consignment_number}%`]),
    exp: dbQ(BIZ_DB, 'SELECT category, amount, paid_amount, status FROM expenses WHERE related_entity_id = ?', [kid]),
    lose: loseStand([k.product_id]),
    cred: dbQ(BIZ_DB, 'SELECT amount, used_amount, status, source_type FROM customer_credits WHERE customer_id = ?', [KAEUFER(x)]),
    audit: auditVon([kid]),
  };
}

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
async function verkaufAmPrimary(nr, x) {
  const kid = nr === 1 ? K1(x) : K2(x);
  await syncRuhe();
  await gehFrisch(primary, `/consignments/${kid}`);
  const r = [];
  if (await warteBis(primary, knopfDa('Record Sale'), 45000)) {
    r.push(await clickText(primary, 'Record Sale'));
    if (await warteBis(primary, q('[data-consignment-sale]'), 15000)) {
      r.push(await ssPick(primary, 'Search clients...', KAEUFER(x)));
      r.push(await setByLabel(primary, 'SALE PRICE (BHD)', '1200'));
      await sleep(300);
      r.push(await klick(primary, '[data-consignment-sale]'));
      r.push(await nummerWahl(primary, false));
    } else r.push('KEINE-MASKE');
  } else r.push('KEIN-KNOPF');
  const da = alleOk(r) === 'OK' && await warteAuf(() => zeile('consignments', kid).status === 'sold' && !!zeile('consignments', kid).invoice_id);
  KINV[nr][x] = zeile('consignments', kid).invoice_id;
  ok(da && !!KINV[nr][x], `VORBEREITUNG Verkauf K${nr} (${x}) an ${KAEUFER(x)} für 1200 am Primary als A (${alleOk(r)}; ${String(await fehlerText(primary)).slice(0, 160)})`);
}
async function rechnungBezahlenAmPrimary(invId, x) {
  await syncRuhe();
  await gehFrisch(primary, `/invoices/${invId}`);
  const inv = zeile('invoices', invId);
  const rest = Math.round((Number(inv.gross_amount) - Number(inv.paid_amount)) * 1000) / 1000;
  const r = [];
  if (await warteBis(primary, knopfDa('Record Payment'), 45000)) {
    r.push(await clickText(primary, 'Record Payment'));
    if (await warteBis(primary, q('[data-record-payment]'), 10000)) {
      await sleep(300);
      r.push(await setByLabel(primary, 'AMOUNT (BHD)', String(rest)));
      r.push(await clickText(primary, 'Cash'));
      await sleep(250);
      r.push(await klick(primary, '[data-record-payment]'));
      if (await warteBis(primary, q('[data-final-number-confirm]'), 6000)) r.push(await nummerWahl(primary, false));
    } else r.push('KEINE-MASKE');
  } else r.push('KEIN-KNOPF');
  const da = alleOk(r) === 'OK' && await warteAuf(() => Number(zeile('invoices', invId).paid_amount) >= Number(zeile('invoices', invId).gross_amount) - 0.0005);
  ok(da, `VORBEREITUNG Käuferrechnung (${x}) voll bar bezahlt (${rest}) am Primary als A (${alleOk(r)}; ${String(await fehlerText(primary)).slice(0, 160)})`);
}
async function bilderAmPrimary(x, dateien) {
  await syncRuhe();
  await gehFrisch(primary, `/collection/${BILD(x)}`);
  const r = [];
  if (!(await warteBis(primary, knopfDa('Edit'), 45000))) r.push('KEIN-EDIT');
  else if (!(await enterEditor(primary, 0))) r.push('EDITOR-NICHT-FREI');
  else {
    for (const f of dateien) r.push((await addPhoto(primary, f)) ? 'OK' : 'FOTO-NICHT-UEBERNOMMEN');
    r.push(await klick(primary, '[data-save-product]'));
  }
  const da = alleOk(r) === 'OK' && await warteAuf(() => activeLinks(BILD(x)).length === dateien.length, 90)
    && await warteBis(primary, `!${q('[data-save-product]')}`, 30000);
  ok(da, `VORBEREITUNG ${dateien.length} Bilder an ${BILD(x)} am Primary als A (${alleOk(r)}; Links ${activeLinks(BILD(x)).length}; ${String(await fehlerText(primary)).slice(0, 160)})`);
}
/** Ein Knopf einer Positionszeile der Auftragsseite: im Statusfeld oder in der Aktionsspalte daneben. */
const zeilenKnopf = (lineId, hook, nachbar = false) => nachbar
  ? `(document.querySelector('[data-order-line="${lineId}"]')?.nextElementSibling?.querySelector('${hook}') || null)`
  : `document.querySelector('[data-order-line="${lineId}"] ${hook}')`;
/** Ein Knopf in der Zeile einer Aufgabe (nach ihrem Titel gefunden). */
const aufgabenKnopf = (titel, hook) => `([...document.querySelectorAll('${hook}')].find((b) => b.parentElement && b.parentElement.parentElement && b.parentElement.parentElement.textContent.includes(${S(titel)})) || null)`;
const PR = {}, PK = {}, TASK = {}, DOC = {};
const ANZ_CN = {};

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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R6F Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R6F Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R6F Admin A');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
  primary.close(); primary = null;
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
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
  await waitFor(primary, SHELL, 90000);
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
  await primary.send('Page.addScriptToEvaluateOnNewDocument', { source: PRIMARY_HAKEN_SRC });
  await primary.ev(`${PRIMARY_HAKEN_SRC} return 1;`);
  // Das Belegbild für Upload + OCR: echter Text, gezeichnet von der Seite des Primary (PNG).
  {
    const b64 = await primary.ev(`const c=document.createElement('canvas'); c.width=720; c.height=180; const g=c.getContext('2d');
      g.fillStyle='#ffffff'; g.fillRect(0,0,720,180); g.fillStyle='#000000'; g.font='bold 64px Arial'; g.fillText('LATAIF R6F 4711', 24, 112);
      return c.toDataURL('image/png').split(',')[1];`);
    for (const x of ['C', 'P']) writeFileSync(DOC_FILE(x), Buffer.from(String(b64), 'base64'));
    ok(readFileSync(DOC_FILE('C')).subarray(0, 4).toString('hex') === '89504e47', 'SETUP das Belegbild ist ein echtes PNG mit Text');
  }

  // ══ PC2 — frischer Rechner ohne Datenbank, Anmeldung als B über die normale Maske ══════════════
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
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
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', B_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await click(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  {
    const sitzung = JSON.parse(String(await client.ev('return localStorage.getItem("lataif_session") || "{}";')) || '{}');
    ok(sitzung.userId === B_ID, `CONNECT PC2 ohne Datenbank, angemeldet als B über die normale Maske (${sitzung.userId})`);
  }
  await beobachterLegen();

  // Die ALTE Geschäftsdatei im Datenordner von PC2 — sie darf in keinem Schritt angefasst werden.
  await spuelen(primary);
  mkdirSync(CLIENT_DATA_DIR, { recursive: true });
  STALE = join(CLIENT_DATA_DIR, 'lataif.db');
  copyFileSync(BIZ_DB, STALE);
  staleVorher = sha(STALE);
  dateienVorher = readdirSync(CLIENT_DATA_DIR).sort();
  LEDGER_BASIS = ledgerMax();

  // ══════════════════════════════════════════════════════════════════════
  // PURCHASES — Return to Supplier, Cancel (verlorene Antwort), Inbox-Foto verwerfen
  // ══════════════════════════════════════════════════════════════════════
  // Je Zwilling zwei Einkäufe am Primary über „New Purchase": R (pa 2×500 + pb 1×800, bar 1500 bezahlt)
  // und K (pc 1×600, bar 100 bezahlt) — beide teilbezahlt, also rückgabe- und stornierbar.
  for (const x of ['C', 'P']) PR[x] = await einkaufAmPrimary('Einkauf R', x, [{ pid: PA(x), qty: 2, preis: 500 }, { pid: PB(x), qty: 1, preis: 800 }], 1500, `R6F Einkauf R ${x}`);
  for (const x of ['C', 'P']) PK[x] = await einkaufAmPrimary('Einkauf K', x, [{ pid: PC(x), qty: 1, preis: 600 }], 100, `R6F Einkauf K ${x}`);
  ok(['C', 'P'].every((x) => zeile('purchases', PR[x]).status === 'PARTIALLY_PAID' && Number(zeile('purchases', PR[x]).remaining_amount) === 300
    && zeile('purchases', PK[x]).status === 'PARTIALLY_PAID'),
  `VORBEREITUNG beide Einkäufe je Zwilling teilbezahlt (R offen ${['C', 'P'].map((x) => zeile('purchases', PR[x]).remaining_amount).join('/')})`);

  const retoure = await paar({
    name: 'PUR-RETURN', op: 'purchases.return_to_supplier',
    route: (x) => `/purchases/${PR[x]}`,
    bereit: () => q('[data-purchase-return-open]'),
    vorher: (x) => {
      const l = dbQ(BIZ_DB, 'SELECT id FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [PR[x]]).map((r) => r.id);
      return { rev: Number(zeile('purchases', PR[x]).revision), lA: l[0], lB: l[1], rets: idSet('purchase_returns') };
    },
    fuellen: async (c, x, v) => {
      const r = [await klick(c, '[data-purchase-return-open]')];
      if (!(await warteBis(c, q('[data-purchase-return-confirm]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      for (const [l, preis] of [[v.lA, 500], [v.lB, 800]]) {
        r.push(await klick(c, `[data-purchase-return-line="${l}"]`)); await sleep(200);
        r.push(await setVal(c, `[data-purchase-return-qty="${l}"]`, '1')); await sleep(100);
        r.push(await setVal(c, `[data-purchase-return-price="${l}"]`, String(preis))); await sleep(100);
      }
      r.push(await klick(c, '[data-purchase-return-method="bank"]'));
      r.push(await setVal(c, '[data-purchase-return-notes]', 'R6F defekt'));
      await sleep(300);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-purchase-return-confirm]'),
    fertig: (x, v) => neueZeilen('purchase_returns', v.rets, 'purchase_id = ?', [PR[x]]).length === 1,
    zu: () => `!${q('[data-purchase-return-confirm]')}`,
    keys: ['expectedRevision', 'lines', 'notes', 'purchaseId', 'refundMethod'],
    rumpf: (p, x, v) => p.purchaseId === PR.C && p.expectedRevision === v.rev && p.refundMethod === 'bank' && p.notes === 'R6F defekt'
      && S(p.lines) === S([{ purchaseLineId: v.lA, quantity: 1, unitPrice: 500 }, { purchaseLineId: v.lB, quantity: 1, unitPrice: 800 }]),
    neu: (x, v) => neueZeilen('purchase_returns', v.rets, 'purchase_id = ?', [PR[x]]),
    zustand: (x) => kaufStand(PR[x], x),
    ohne: /^supplier_snapshot$/,
  });
  {
    const werte = ['C', 'P'].map((x) => {
      const p = zeile('purchases', PR[x]);
      const r = dbQ(BIZ_DB, 'SELECT * FROM purchase_returns WHERE purchase_id = ?', [PR[x]]);
      const lose = dbQ(BIZ_DB, 'SELECT qty_remaining, status FROM stock_lots WHERE purchase_id = ? ORDER BY product_id', [PR[x]]);
      return { p: [p.status, Number(p.total_amount), Number(p.paid_amount), Number(p.remaining_amount)],
        r: r.map((z) => [z.status, Number(z.total_amount), Number(z.refund_amount), z.refund_method]),
        lose: lose.map((l) => [Number(l.qty_remaining), l.status]) };
    });
    const soll = { p: ['PAID', 500, 500, 0], r: [['COMPLETED', 1300, 1000, 'bank']], lose: [[1, 'ACTIVE'], [0, 'EXHAUSTED']] };
    const gut = werte.every((w) => S(w) === S(soll));
    ok(gut, `PUR-RETURN erst der offene Rest (300), der Überschuss (1000) ist Erstattung per Bank; Retoure COMPLETED 1300; Los A 2→1, Los B 1→0 (${S(werte)})`);
    const pr = (L) => S(L.filter((r) => r.source_module === 'PURCHASE_RETURN').map((r) => [r.account, r.direction, Math.round(Number(r.amount) * 1000)]).map((z) => S(z)).sort());
    const sollL = S([['ACCOUNTS_PAYABLE', 'DEBIT', 300000], ['BANK', 'DEBIT', 1000000], ['INVENTORY', 'CREDIT', 1300000]].map((z) => S(z)).sort());
    ok(pr(retoure.C.L) === sollL && pr(retoure.P.L) === sollL, `PUR-RETURN Hauptbuch: AP um den Rest, BANK um die Erstattung, INVENTORY um die Ware (${pr(retoure.C.L)})`);
    EXTRA.purchase = gut && pr(retoure.C.L) === sollL;
  }

  const kaufStorno = await paar({
    name: 'PUR-CANCEL', op: 'purchases.cancel', lost: '[data-save-error]',
    route: (x) => `/purchases/${PK[x]}`,
    bereit: () => q('[data-purchase-cancel]'),
    vorher: (x) => ({ rev: Number(zeile('purchases', PK[x]).revision) }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-purchase-cancel]')];
      if (!(await warteBis(c, q('[data-purchase-cancel-confirm]'), 10000))) return 'KEINE-MASKE';
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-purchase-cancel-confirm]'),
    fertig: (x) => zeile('purchases', PK[x]).status === 'CANCELLED',
    zu: () => `!${q('[data-purchase-cancel-confirm]')}`,
    keys: ['expectedRevision', 'purchaseId'],
    rumpf: (p, x, v) => p.purchaseId === PK.C && p.expectedRevision === v.rev,
    zustand: (x) => kaufStand(PK[x], x),
    ohne: /^supplier_snapshot$/,
  });
  {
    const gut = ['C', 'P'].every((x) => dbQ(BIZ_DB, 'SELECT status FROM stock_lots WHERE purchase_id = ?', [PK[x]]).every((l) => l.status === 'CANCELLED')
      && zeile('products', PC(x)).stock_status === 'returned' && Number(zeile('products', PC(x)).quantity) === 0);
    const umkehr = ['C', 'P'].every((x) => kaufStorno[x].L.some((r) => r.reverses_entry_id));
    const ap = ['C', 'P'].map((x) => S(saldoCp(LIEF(x)).filter((a) => a.account === 'ACCOUNTS_PAYABLE')));
    ok(gut && umkehr && ap.every((a) => a === '[]'),
      `PUR-CANCEL Lose storniert, Artikel ohne Bestand, Einkaufs- und Zahlungsbuchungen umgekehrt (nicht gelöscht), AP beim Lieferanten auf 0 (${ap.join(' / ')})`);
    EXTRA.purchase = EXTRA.purchase && gut && umkehr;
  }

  const inbox = await paar({
    name: 'INBOX-DISMISS', op: 'purchases.dismiss_inbox',
    route: () => '/purchases',
    bereit: (x) => q(`[data-purchase-inbox-dismiss="${INB(x)}"]`),
    vorher: (x) => ({ bild: zeile('purchase_inbox', INB(x)).images, links: zahl('SELECT COUNT(*) AS n FROM media_links') }),
    fuellen: async () => 'OK',
    speichern: (c, x) => klick(c, `[data-purchase-inbox-dismiss="${INB(x)}"]`),
    fertig: (x) => zeile('purchase_inbox', INB(x)).status === 'dismissed',
    zu: (x) => `!${q(`[data-purchase-inbox-dismiss="${INB(x)}"]`)}`,
    keys: ['inboxId'],
    rumpf: (p) => p.inboxId === INB('C'),
    zustand: (x) => ({ i: zeile('purchase_inbox', INB(x)), audit: auditVon([INB(x)]) }),
    buchungsZeilen: 0,
  });
  EXTRA.inbox = ['C', 'P'].every((x) => zeile('purchase_inbox', INB(x)).images === inbox[x].v.bild)
    && zahl('SELECT COUNT(*) AS n FROM media_links') >= inbox.C.v.links;
  ok(EXTRA.inbox, 'INBOX-DISMISS das Foto bleibt in seiner Zeile (inline), kein Media-Eintrag wird angefasst — nur der Status');
  console.log('CENTRAL_UI_R6F_PURCHASES_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // ORDERS — „beim Supplier bestellt" → „↺ Undo" → ARRIVED → Positionsdialog; Cancel mit Geld
  // ══════════════════════════════════════════════════════════════════════
  for (const x of ['C', 'P']) await anzahlungAmPrimary(x, ORD2(x), 200);
  const ordRev = (oid) => ({ rev: Number(zeile('orders', oid).revision) });

  await paar({
    name: 'ORDER-MARK-ORDERED', op: 'orders.mark_line_ordered',
    route: (x) => `/orders/${ORD1(x)}`,
    bereit: (x) => zeilenKnopf(LA(x), '[data-order-line-mark-ordered]', true),
    vorher: (x) => ordRev(ORD1(x)),
    fuellen: async (c, x) => {
      const r = [await klickAusdruck(c, zeilenKnopf(LA(x), '[data-order-line-mark-ordered]', true), 'mark-ordered')];
      if (!(await warteBis(c, q('[data-order-line-mark-ordered-confirm]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await ssPick(c, 'Supplier waehlen — oder leer lassen', LIEF(x)));
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-order-line-mark-ordered-confirm]'),
    fertig: (x) => zeile('order_lines', LA(x)).status === 'ORDERED' && zeile('order_lines', LA(x)).ordered_supplier_id === LIEF(x),
    zu: () => `!${q('[data-order-line-mark-ordered-confirm]')}`,
    keys: ['expectedRevision', 'lineId', 'orderId', 'supplierId'],
    rumpf: (p, x, v) => p.orderId === ORD1('C') && p.lineId === LA('C') && p.supplierId === LIEF('C') && p.expectedRevision === v.rev,
    zustand: (x) => auftragStand(ORD1(x), x),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'ORDER-LINE-UNDO', op: 'orders.update_line_status',
    route: (x) => `/orders/${ORD1(x)}`,
    bereit: (x) => zeilenKnopf(LA(x), '[data-order-line-undo]'),
    vorher: (x) => ordRev(ORD1(x)),
    fuellen: async () => 'OK',
    speichern: (c, x) => klickAusdruck(c, zeilenKnopf(LA(x), '[data-order-line-undo]'), 'undo'),
    fertig: (x) => zeile('order_lines', LA(x)).status === 'PENDING',
    zu: (x) => zeilenKnopf(LA(x), '[data-order-line-status="ARRIVED"]'),
    keys: ['expectedRevision', 'lineId', 'orderId', 'status'],
    rumpf: (p, x, v) => p.orderId === ORD1('C') && p.lineId === LA('C') && p.status === 'PENDING' && p.expectedRevision === v.rev,
    zustand: (x) => auftragStand(ORD1(x), x),
    buchungsZeilen: 0,
  });

  const ankunft = await paar({
    name: 'ORDER-LINE-ARRIVED', op: 'orders.update_line_status',
    route: (x) => `/orders/${ORD1(x)}`,
    bereit: (x) => zeilenKnopf(LB(x), '[data-order-line-status="ARRIVED"]'),
    vorher: (x) => ({ ...ordRev(ORD1(x)), exps: idSet('expenses') }),
    fuellen: async () => 'OK',
    speichern: (c, x) => klickAusdruck(c, zeilenKnopf(LB(x), '[data-order-line-status="ARRIVED"]'), 'arrived'),
    fertig: (x) => zeile('order_lines', LB(x)).status === 'ARRIVED' && !!zeile('order_lines', LB(x)).expense_id,
    zu: (x) => `(() => { const b = ${zeilenKnopf(LB(x), '[data-order-line-status="ARRIVED"]')}; return !!b && getComputedStyle(b).color === 'rgb(255, 255, 255)'; })()`,
    keys: ['expectedRevision', 'lineId', 'orderId', 'status'],
    rumpf: (p, x, v) => p.orderId === ORD1('C') && p.lineId === LB('C') && p.status === 'ARRIVED' && p.expectedRevision === v.rev,
    zustand: (x) => auftragStand(ORD1(x), x),
  });
  {
    const e = ['C', 'P'].map((x) => neueZeilen('expenses', ankunft[x].v.exps, 'supplier_id = ?', [LIEF(x)]));
    const gut = e.every((l) => l.length === 1 && Math.abs(Number(l[0].amount) - 150) < 0.0005) && ankunft.C.L.length > 0;
    ok(gut, `ORDER-LINE-ARRIVED die Lieferanten-A/P (150) entsteht in DERSELBEN Handlung — je eine Ausgabe, gebucht (${S(e.map((l) => l.map((z) => [z.amount, z.status])))}, ${ankunft.C.L.length} Buchungszeilen)`);
    EXTRA.order = gut;
  }

  await paar({
    name: 'ORDER-LINE-EDIT', op: 'orders.update_line',
    route: (x) => `/orders/${ORD1(x)}`,
    bereit: (x) => zeilenKnopf(LA(x), '[data-order-line-edit]', true),
    vorher: (x) => ordRev(ORD1(x)),
    fuellen: async (c, x) => {
      const r = [await klickAusdruck(c, zeilenKnopf(LA(x), '[data-order-line-edit]', true), 'edit')];
      if (!(await warteBis(c, q('[data-order-line-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(600);
      r.push(await setVal(c, '[data-order-line-edit-description]', `R6F Wunschuhr geaendert ${x}`));
      r.push(await setVal(c, '[data-order-line-edit-quantity]', '2'));
      r.push(await setVal(c, '[data-order-line-edit-price]', '450'));
      await sleep(300);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-order-line-save]'),
    fertig: (x) => Number(zeile('order_lines', LA(x)).quantity) === 2 && Number(zeile('order_lines', LA(x)).unit_price) === 450,
    zu: () => `!${q('[data-order-line-save]')}`,
    keys: ['description', 'expectedRevision', 'lineId', 'orderId', 'quantity', 'unitPrice'],
    rumpf: (p, x, v) => p.orderId === ORD1('C') && p.lineId === LA('C') && p.description === 'R6F Wunschuhr geaendert C'
      && p.quantity === 2 && p.unitPrice === 450 && p.expectedRevision === v.rev,
    zustand: (x) => auftragStand(ORD1(x), x),
    buchungsZeilen: 0,
  });
  {
    const gut = ['C', 'P'].every((x) => Number(zeile('order_lines', LA(x)).line_total) === 900 && Number(zeile('orders', ORD1(x)).agreed_price) === 1900);
    ok(gut, `ORDER-LINE-EDIT Zeilensumme 900 und vereinbarter Preis 1900 rechnet das Haus (${['C', 'P'].map((x) => `${zeile('order_lines', LA(x)).line_total}/${zeile('orders', ORD1(x)).agreed_price}`).join(' · ')})`);
    EXTRA.order = EXTRA.order && gut;
  }

  const auftragStorno = await paar({
    name: 'ORDER-CANCEL', op: 'orders.cancel', lost: '[data-save-error]',
    route: (x) => `/orders/${ORD2(x)}`,
    bereit: () => q('[data-order-cancel-open]'),
    vorher: (x) => ordRev(ORD2(x)),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-order-cancel-open]')];
      if (!(await warteBis(c, q('[data-order-cancel-confirm]'), 10000))) return 'KEINE-MASKE';
      if (!(await warteBis(c, q('[data-order-cancel-choice="refund"]'), 10000))) return 'KEIN-GELDBLOCK (Anzahlung nicht gesehen)';
      await sleep(300);
      r.push(await klick(c, '[data-order-cancel-choice="refund"]'));
      await sleep(150);
      r.push(await klick(c, '[data-order-cancel-refund-method="bank"]'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-order-cancel-confirm]'),
    fertig: (x) => zeile('orders', ORD2(x)).status === 'cancelled',
    zu: () => `!${q('[data-order-cancel-confirm]')}`,
    keys: ['choice', 'expectedRevision', 'orderId', 'refundMethod'],
    rumpf: (p, x, v) => p.orderId === ORD2('C') && p.choice === 'refund' && p.refundMethod === 'bank' && p.expectedRevision === v.rev,
    zustand: (x) => auftragStand(ORD2(x), x),
  });
  {
    const zeilen = ['C', 'P'].every((x) => dbQ(BIZ_DB, 'SELECT status FROM order_lines WHERE order_id = ?', [ORD2(x)]).every((l) => l.status === 'CANCELLED'));
    const bank = ['C', 'P'].every((x) => auftragStorno[x].L.some((r) => r.account === 'BANK' && r.direction === 'CREDIT' && Math.abs(Number(r.amount) - 200) < 0.0005));
    // Beim Kunden als Gegenpartei bleiben nur die Geldkonten: bar erhalten (+200), per Bank zurück (−200).
    // Die Anzahlungsschuld (und jedes andere Konto) steht auf null.
    const kunde = ['C', 'P'].map((x) => S(saldoCp(KUNDE(x))));
    const sollKunde = S([{ account: 'BANK', net: -200 }, { account: 'CASH', net: 200 }]);
    ok(zeilen && bank && kunde.every((k) => k === sollKunde),
      `ORDER-CANCEL Auftrag und Positionen CANCELLED, die Anzahlung (200) geht per BANK zurück — beim Kunden nur noch Kasse +200 / Bank −200, keine offene Anzahlungsschuld (${kunde.join(' / ')})`);
    EXTRA.order = EXTRA.order && zeilen && bank;
  }
  console.log('CENTRAL_UI_R6F_ORDERS_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // CONSIGNMENT — Rückgabe nach dem Verkauf (K1 bezahlt, „Keep", Bank); K2: Rückgabe, dann Cancel Sale
  // ══════════════════════════════════════════════════════════════════════
  for (const x of ['C', 'P']) { await verkaufAmPrimary(1, x); await rechnungBezahlenAmPrimary(KINV[1][x], x); }
  const konRev = (kid) => ({ rev: Number(zeile('consignments', kid).revision), rets: idSet('sales_returns') });
  const rueckgabeFuellen = (disposition, erstattung) => async (c) => {
    const r = [await klick(c, '[data-consignment-return-after-sale]')];
    if (!(await warteBis(c, q('[data-consignment-return-after-sale-confirm]'), 10000))) return 'KEINE-MASKE';
    await sleep(300);
    r.push(await klick(c, `[data-consignment-return-disposition="${disposition}"]`));
    if (erstattung) {
      if (!(await warteBis(c, q(`[data-consignment-return-refund-method="${erstattung}"]`), 10000))) r.push('KEIN-ERSTATTUNGSWEG (Zahlung nicht gesehen)');
      else r.push(await klick(c, `[data-consignment-return-refund-method="${erstattung}"]`));
    } else if (await c.ev(`return !!${q('[data-consignment-return-refund-method]')};`)) r.push('ERSTATTUNGSWEG-OHNE-ZAHLUNG');
    r.push(await setVal(c, '[data-consignment-return-reason]', 'R6F Kaeufer gibt zurueck'));
    await sleep(250);
    return alleOk(r);
  };

  const keep = await paar({
    name: 'KON-RETURN-KEEP (bezahlt, Bank)', op: 'consignments.return_after_sale',
    route: (x) => `/consignments/${K1(x)}`,
    bereit: () => q('[data-consignment-return-after-sale]'),
    vorher: (x) => konRev(K1(x)),
    fuellen: rueckgabeFuellen('KEEP_AS_OWN', 'bank'),
    speichern: (c) => klick(c, '[data-consignment-return-after-sale-confirm]'),
    fertig: (x) => zeile('consignments', K1(x)).status === 'returned',
    zu: () => `!${q('[data-consignment-return-after-sale-confirm]')}`,
    keys: ['consignmentId', 'disposition', 'expectedRevision', 'reason', 'refundMethod'],
    rumpf: (p, x, v) => p.consignmentId === K1('C') && p.disposition === 'KEEP_AS_OWN' && p.refundMethod === 'bank'
      && p.reason === 'R6F Kaeufer gibt zurueck' && p.expectedRevision === v.rev,
    neu: (x, v) => neueZeilen('sales_returns', v.rets, 'invoice_id = ?', [KINV[1][x]]),
    zustand: (x) => konStand(1, x),
  });
  {
    const w = ['C', 'P'].map((x) => {
      const p = zeile('products', K1P(x));
      const r = dbQ(BIZ_DB, 'SELECT status, product_disposition FROM sales_returns WHERE invoice_id = ?', [KINV[1][x]]);
      const lose = dbQ(BIZ_DB, "SELECT qty_remaining FROM stock_lots WHERE product_id = ? AND status = 'ACTIVE' AND qty_remaining > 0", [K1P(x)]);
      return { p: [p.stock_status, p.source_type, Number(p.quantity)], r: r.map((z) => [z.status, z.product_disposition]), lose: lose.length };
    });
    const gut = w.every((z) => S(z) === S({ p: ['in_stock', 'OWN', 1], r: [['REFUNDED', 'KEEP_AS_OWN']], lose: 1 }));
    const bank = ['C', 'P'].every((x) => keep[x].L.some((r) => r.account === 'BANK' && r.direction === 'CREDIT'));
    ok(gut && bank, `KON-RETURN-KEEP die Ware ist eigener Bestand (ein aktives Los), die Retoure REFUNDED, die Erstattung geht per BANK hinaus (${S(w)})`);
    EXTRA.keep = gut && bank;
  }

  // K2 — der Stand VOR dem Verkauf ist das Ziel des Stornos: Salden je Konto und Gegenpartei.
  await syncRuhe();
  const SALDEN_VOR = S(salden());
  for (const x of ['C', 'P']) await verkaufAmPrimary(2, x);
  await paar({
    name: 'KON-RETURN-OWNER (unbezahlt)', op: 'consignments.return_after_sale',
    route: (x) => `/consignments/${K2(x)}`,
    bereit: () => q('[data-consignment-return-after-sale]'),
    vorher: (x) => konRev(K2(x)),
    fuellen: rueckgabeFuellen('RETURN_TO_OWNER', null),
    speichern: (c) => klick(c, '[data-consignment-return-after-sale-confirm]'),
    fertig: (x) => zeile('consignments', K2(x)).status === 'returned',
    zu: () => `!${q('[data-consignment-return-after-sale-confirm]')}`,
    keys: ['consignmentId', 'disposition', 'expectedRevision', 'reason'],
    rumpf: (p, x, v) => p.consignmentId === K2('C') && p.disposition === 'RETURN_TO_OWNER' && p.reason === 'R6F Kaeufer gibt zurueck' && p.expectedRevision === v.rev,
    neu: (x, v) => neueZeilen('sales_returns', v.rets, 'invoice_id = ?', [KINV[2][x]]),
    zustand: (x) => konStand(2, x),
  });
  for (const x of ['C', 'P']) ANZ_CN[x] = zahl('SELECT COUNT(*) AS n FROM credit_notes WHERE invoice_id = ?', [KINV[2][x]]);
  ok(['C', 'P'].every((x) => ANZ_CN[x] >= 1), `KON-RETURN-OWNER je Rechnung eine Gutschrift (${ANZ_CN.C}/${ANZ_CN.P})`);

  const kStorno = await paar({
    name: 'KON-CANCEL-SALE (cleanup)', op: 'consignments.cancel_sale', lost: '[data-save-error]',
    route: (x) => `/consignments/${K2(x)}`,
    bereit: () => q('[data-consignment-cancel-sale]'),
    vorher: (x) => konRev(K2(x)),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-consignment-cancel-sale]')];
      if (!(await warteBis(c, q('[data-consignment-cancel-sale-confirm]'), 10000))) return 'KEINE-MASKE';
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-consignment-cancel-sale-confirm]'),
    fertig: (x) => zeile('consignments', K2(x)).status === 'active' && zeile('invoices', KINV[2][x]).status === 'CANCELLED',
    zu: () => `!${q('[data-consignment-cancel-sale-confirm]')}`,
    keys: ['consignmentId', 'expectedRevision'],
    rumpf: (p, x, v) => p.consignmentId === K2('C') && p.expectedRevision === v.rev,
    zustand: (x) => konStand(2, x),
  });
  {
    const je = ['C', 'P'].map((x) => {
      const inv = zeile('invoices', KINV[2][x]);
      const cn = dbQ(BIZ_DB, 'SELECT status FROM credit_notes WHERE invoice_id = ?', [KINV[2][x]]);
      const ret = dbQ(BIZ_DB, 'SELECT status FROM sales_returns WHERE invoice_id = ?', [KINV[2][x]]);
      const k = zeile('consignments', K2(x));
      const pur = dbQ(BIZ_DB, 'SELECT status FROM purchases WHERE notes LIKE ?', [`%${k.consignment_number}%`]);
      const p = zeile('products', K2P(x));
      return {
        inv: [inv.id === KINV[2][x], inv.status, zahl('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?', [KINV[2][x]]) >= 1],
        cn: [cn.length === ANZ_CN[x], cn.every((z) => z.status === 'CANCELLED')],
        ret: ret.length >= 1 && ret.every((z) => z.status === 'REJECTED'),
        pur: pur.length >= 1 && pur.every((z) => z.status === 'CANCELLED'),
        k: k.status, p: [p.stock_status, Number(p.quantity)],
      };
    });
    const soll = { inv: [true, 'CANCELLED', true], cn: [true, true], ret: true, pur: true, k: 'active', p: ['consignment', 1] };
    const noDelete = je.every((z) => S(z) === S(soll));
    ok(noDelete, `KON-CANCEL-SALE Rechnung CANCELLED (steht mit Zeile), Gutschrift CANCELLED (nicht gelöscht), Retoure REJECTED, Einlieferer-Einkauf CANCELLED, Kommission wieder aktiv, Ware wieder in Kommission (${S(je)})`);
    const umkehr = ['C', 'P'].every((x) => kStorno[x].L.some((r) => r.reverses_entry_id));
    await syncRuhe();
    const nach = S(salden());
    ok(nach === SALDEN_VOR && umkehr,
      `KON-CANCEL-SALE PRE-SALE: jeder Saldo je Konto und Gegenpartei steht wieder wie VOR dem Verkauf — storniert, nicht gelöscht (${nach === SALDEN_VOR ? 'gleich' : `vorher ${SALDEN_VOR.slice(0, 400)} // nachher ${nach.slice(0, 400)}`})`);
    EXTRA.noDelete = noDelete;
    EXTRA.presale = nach === SALDEN_VOR && umkehr;
  }
  console.log('CENTRAL_UI_R6F_CONSIGNMENT_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // PRODUCTION — New Record mit Ausgangsfoto über die Zwischenablage (verlorene Antwort)
  // ══════════════════════════════════════════════════════════════════════
  const produktionsStand = (x, v) => {
    const rec = neueZeilen('production_records', v.recs)[0] || {};
    const rid = rec.id || '';
    const outs = dbQ(BIZ_DB, 'SELECT * FROM production_outputs WHERE record_id = ?', [rid]);
    const ins = dbQ(BIZ_DB, 'SELECT product_id, input_value FROM production_inputs WHERE record_id = ? ORDER BY product_id', [rid]);
    const op = outs.map((o) => zeile('products', o.product_id));
    return {
      rec, ins, outs: outs.map((o) => ({ output_value: o.output_value })),
      inProd: artikelStand([IN1(x), IN2(x)]), inLots: loseStand([IN1(x), IN2(x)]),
      outProd: op, outLots: op.map((p) => loseStand([p.id])),
      media: op.map((p) => activeLinks(p.id).map((l) => [Number(l.sort_order), Number(l.is_primary)])),
      audit: auditVon([rid]),
    };
  };
  const fertigung = await paar({
    name: 'PRODUCTION-CREATE', op: 'production.create', lost: '[data-production-error]',
    route: () => '/production',
    bereit: () => `${q('[data-production-new]')} && !${q('[data-production-new]')}.disabled`,
    vorher: () => ({ recs: idSet('production_records') }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-production-new]')];
      if (!(await warteBis(c, q('[data-production-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(400);
      r.push(await mehrfachWahl(c, 'Search inventory...', [`Omega R6F In1 ${x}`, `Omega R6F In2 ${x}`]));
      r.push(await klick(c, '[data-production-output-add]'));
      r.push(await neuerArtikel(c, 'R6F', `R6F Ring ${x}`, 'Add to Production', JPG('d')));
      if (!(await warteBis(c, q('[data-production-output-value="0"]'), 10000))) r.push('KEIN-AUSGANG');
      else r.push(await setVal(c, '[data-production-output-value="0"]', '250'));
      r.push(await setVal(c, '[data-production-labor]', '5'));
      r.push(await setVal(c, '[data-production-overhead]', '2.5'));
      r.push(await setVal(c, '[data-production-notes]', 'R6F Fertigung'));
      await sleep(300);
      if (!(await warteBis(c, `${q('[data-production-save]')} && !${q('[data-production-save]')}.disabled`, 8000))) r.push('SPEICHERN-GESPERRT');
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-production-save]'),
    fertig: (x, v) => neueZeilen('production_records', v.recs).length === 1 && zeile('products', IN1(x)).stock_status === 'consumed',
    zu: () => `!${q('[data-production-save]')}`,
    keys: ['inputProductIds', 'laborCost', 'notes', 'outputs', 'overheadCost'],
    rumpf: (p) => S([...(p.inputProductIds || [])].sort()) === S([IN1('C'), IN2('C')].sort()) && p.laborCost === 5 && p.overheadCost === 2.5
      && p.notes === 'R6F Fertigung' && (p.outputs || []).length === 1 && p.outputs[0].value === 250
      && Array.isArray(p.outputs[0].spec?.stagingIds) && p.outputs[0].spec.stagingIds.length === 1
      && /^[0-9a-f]{64}$/.test(String(p.outputs[0].spec.stagingIds[0])) && !S(p).includes('data:image'),
    neu: (x, v) => neueZeilen('production_records', v.recs),
    zustand: produktionsStand,
    ohne: /^(sku|product_snapshot)$/,
    buchungsZeilen: 0,
  });
  {
    const je = ['C', 'P'].map((x) => {
      const z = produktionsStand(x, fertigung[x].v);
      const p = z.outProd[0] || {};
      return { wert: Number(z.rec.total_value), ein: z.inProd.map((a) => a.stock_status), aus: [p.stock_status, Number(p.quantity), p.images], bilder: z.media[0] || [], lose: (z.outLots[0] || []).map((l) => [Number(l.unit_cost), l.status]) };
    });
    const gut = je.every((z) => z.wert === 250 && S(z.ein) === S(['consumed', 'consumed']) && S(z.aus) === S(['in_stock', 1, '[]'])
      && z.bilder.length === 1 && S(z.lose) === S([[250, 'ACTIVE']]));
    const staged = Number(await client.ev('return window.__staged || 0;').catch(() => 0));
    ok(gut, `PRODUCTION Beleg 250, beide Eingänge verbraucht, der Ausgang auf Lager (Los 250) — sein Foto als EIN media_link, nicht in products.images (${S(je)})`);
    ok(staged >= 1, `PRODUCTION PC2 hat das Foto über die Zwischenablage des Primary gereicht (${staged} Ablagen; der Auftrag nennt nur die Kennung)`);
    EXTRA.production = gut && staged >= 1;
  }
  console.log('CENTRAL_UI_R6F_PRODUCTION_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // MEDIA — Produktbild ändern: das erste weg, ein neues dazu (PC2: Galerie-Plan mit Ablage)
  // ══════════════════════════════════════════════════════════════════════
  for (const x of ['C', 'P']) await bilderAmPrimary(x, [JPG('a'), JPG('b')]);
  await paar({
    name: 'PRODUCT-IMAGE', op: 'products.update',
    route: (x) => `/collection/${BILD(x)}`,
    bereit: () => knopfDa('Edit'),
    vorher: (x) => ({ links: activeLinks(BILD(x)) }),
    fuellen: async (c, x, v) => {
      if (v.links.length !== 2) return 'VORBEREITUNG-FEHLT:' + v.links.length;
      if (!(await enterEditor(c, 2))) return 'EDITOR-NICHT-FREI:' + await draftPhotos(c);
      const r = [await removePhoto(c, 0)];
      await sleep(500);
      r.push((await addPhoto(c, JPG('c'))) ? 'OK' : 'FOTO-NICHT-UEBERNOMMEN');
      const n = await draftPhotos(c);
      if (n !== 2) r.push('ENTWURF:' + n);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-save-product]'),
    fertig: (x, v) => {
      const a = activeLinks(BILD(x));
      return a.length === 2 && !a.some((l) => l.media_id === v.links[0].media_id) && a.some((l) => l.media_id === v.links[1].media_id)
        && deletedLinks(BILD(x)).some((l) => l.media_id === v.links[0].media_id);
    },
    zu: () => `!${q('[data-save-product]')}`,
    keys: ['gallery', 'id'],
    rumpf: (p, x, v) => p.id === BILD('C') && Array.isArray(p.gallery) && p.gallery.length === 2
      && S(p.gallery[0]) === S({ keep: v.links[1].media_id }) && /^[0-9a-f]{64}$/.test(String(p.gallery[1]?.stagingId || '')) && !S(p).includes('data:'),
    zustand: (x, v) => ({
      p: zeile('products', BILD(x)),
      links: activeLinks(BILD(x)).map((l) => ({ sort_order: Number(l.sort_order), is_primary: Number(l.is_primary), behalten: l.media_id === v.links[1].media_id })),
      weg: deletedLinks(BILD(x)).length,
    }),
    buchungsZeilen: 0,
  });
  {
    const je = ['C', 'P'].map((x) => ({ aktiv: activeLinks(BILD(x)).length, weg: deletedLinks(BILD(x)).length, bilder: zeile('products', BILD(x)).images }));
    EXTRA.bild = je.every((z) => z.aktiv === 2 && z.weg === 1 && z.bilder === '[]');
    ok(EXTRA.bild, `PRODUCT-IMAGE je Zwilling 2 aktive media_links (behalten + neu), der entfernte weich zurückgezogen (deleted_at), products.images bleibt leer (${S(je)})`);
  }
  console.log('CENTRAL_UI_R6F_PRODUCTION_MEDIA_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // OFFICE — Aufgabe anlegen / ändern / erledigen; Dokument hochladen (verlorene Antwort) + OCR
  // ══════════════════════════════════════════════════════════════════════
  const T1 = (x) => `R6F Aufgabe ${x}`, T2 = (x) => `R6F Aufgabe neu ${x}`;
  const taskRev = (x) => ({ rev: Number(zeile('tasks', TASK[x]).revision) });
  await paar({
    name: 'TASK-CREATE', op: 'tasks.create',
    route: () => '/tasks',
    bereit: () => q('[data-task-new]'),
    vorher: () => ({ ids: idSet('tasks') }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-task-new]')];
      if (!(await warteBis(c, q('[data-task-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setVal(c, '[data-task-title]', T1(x)));
      r.push(await setVal(c, '[data-task-description]', 'R6F Uhr beim Kunden abholen'));
      r.push(await setVal(c, '[data-task-type]', 'follow_up'));
      r.push(await setVal(c, '[data-task-priority]', 'high'));
      r.push(await setVal(c, '[data-task-due]', tag(5)));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-task-save]'),
    fertig: (x, v) => neueZeilen('tasks', v.ids, 'title = ?', [T1(x)]).length === 1,
    zu: () => `!${q('[data-task-save]')}`,
    keys: ['description', 'dueAt', 'linkedEntityId', 'linkedEntityType', 'priority', 'title', 'type'],
    rumpf: (p) => p.title === T1('C') && p.description === 'R6F Uhr beim Kunden abholen' && p.type === 'follow_up' && p.priority === 'high'
      && p.dueAt === tag(5) && p.linkedEntityType === null && p.linkedEntityId === null,
    neu: (x, v) => neueZeilen('tasks', v.ids, 'title = ?', [T1(x)]),
    zustand: (x, v) => { TASK[x] = neueZeilen('tasks', v.ids, 'title = ?', [T1(x)])[0]?.id; return { t: zeile('tasks', TASK[x]), audit: auditVon([TASK[x]]) }; },
    buchungsZeilen: 0,
  });
  await paar({
    name: 'TASK-UPDATE', op: 'tasks.update',
    route: () => '/tasks',
    bereit: (x) => aufgabenKnopf(T1(x), '[data-task-edit]'),
    vorher: taskRev,
    fuellen: async (c, x) => {
      const r = [await klickAusdruck(c, aufgabenKnopf(T1(x), '[data-task-edit]'), 'edit')];
      if (!(await warteBis(c, `${q('[data-task-title]')} && ${q('[data-task-title]')}.value === ${S(T1(x))}`, 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setVal(c, '[data-task-title]', T2(x)));
      r.push(await setVal(c, '[data-task-priority]', 'urgent'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-task-save]'),
    fertig: (x) => zeile('tasks', TASK[x]).title === T2(x) && zeile('tasks', TASK[x]).priority === 'urgent',
    zu: () => `!${q('[data-task-save]')}`,
    keys: ['description', 'dueAt', 'expectedRevision', 'linkedEntityId', 'linkedEntityType', 'priority', 'taskId', 'title', 'type'],
    rumpf: (p, x, v) => p.taskId === TASK.C && p.expectedRevision === v.rev && p.title === T2('C') && p.priority === 'urgent' && p.type === 'follow_up',
    zustand: (x) => ({ t: zeile('tasks', TASK[x]), audit: auditVon([TASK[x]]) }),
    buchungsZeilen: 0,
  });
  await paar({
    name: 'TASK-COMPLETE', op: 'tasks.update',
    route: () => '/tasks',
    bereit: (x) => aufgabenKnopf(T2(x), '[data-task-complete]'),
    vorher: taskRev,
    fuellen: async () => 'OK',
    speichern: (c, x) => klickAusdruck(c, aufgabenKnopf(T2(x), '[data-task-complete]'), 'complete'),
    fertig: (x) => zeile('tasks', TASK[x]).status === 'completed' && !!zeile('tasks', TASK[x]).completed_at,
    zu: (x) => `!${aufgabenKnopf(T2(x), '[data-task-complete]')}`,
    keys: ['expectedRevision', 'status', 'taskId'],
    rumpf: (p, x, v) => p.taskId === TASK.C && p.status === 'completed' && p.expectedRevision === v.rev,
    zustand: (x) => ({ t: zeile('tasks', TASK[x]), audit: auditVon([TASK[x]]) }),
    buchungsZeilen: 0,
  });
  EXTRA.tasks = ['C', 'P'].every((x) => { const t = zeile('tasks', TASK[x]); return t.title === T2(x) && t.priority === 'urgent' && t.status === 'completed' && t.created_by === akteurVon(x); });
  ok(EXTRA.tasks, 'TASKS angelegt, geändert, erledigt — je Zwilling vom Handelnden angelegt, der Erledigt-Zeitpunkt vom Primary');

  const dateiInhalt = (x) => 'data:image/png;base64,' + readFileSync(DOC_FILE(x)).toString('base64');
  await paar({
    name: 'DOC-UPLOAD', op: 'documents.upload', lost: '[data-save-error]',
    route: () => '/documents',
    bereit: () => q('[data-document-upload]'),
    vorher: () => ({ ids: idSet('documents') }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-document-upload]')];
      if (!(await warteBis(c, q('[data-document-upload-confirm]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setFileApp(c, 'input[data-document-file]', DOC_FILE(x)));
      if (!(await warteBis(c, `document.body.innerText.includes(${S(DOC_NAME(x))})`, 10000))) r.push('DATEI-NICHT-GEWAEHLT');
      r.push(await klick(c, '[data-document-class="receipt"]'));
      r.push(await ssPick(c, 'Entity type...', 'customer'));
      if (!(await warteBis(c, q('[data-document-link-id]'), 8000))) r.push('KEIN-KENNUNGSFELD');
      else r.push(await setVal(c, '[data-document-link-id]', KUNDE(x)));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-document-upload-confirm]'),
    fertig: (x, v) => neueZeilen('documents', v.ids, 'file_name = ?', [DOC_NAME(x)]).length === 1,
    zu: () => `!${q('[data-document-upload-confirm]')}`,
    keys: ['content', 'docClass', 'fileName', 'linkedEntityId', 'linkedEntityType'],
    rumpf: (p) => p.fileName === DOC_NAME('C') && p.docClass === 'receipt' && p.linkedEntityType === 'customer' && p.linkedEntityId === KUNDE('C')
      && p.content === dateiInhalt('C'),
    neu: (x, v) => neueZeilen('documents', v.ids, 'file_name = ?', [DOC_NAME(x)]),
    zustand: (x, v) => {
      DOC[x] = neueZeilen('documents', v.ids, 'file_name = ?', [DOC_NAME(x)])[0]?.id;
      const d = zeile('documents', DOC[x]);
      return { d: { ...d, file_path: createHash('sha256').update(String(d.file_path || '')).digest('hex').slice(0, 16) }, audit: auditVon([DOC[x]]) };
    },
    buchungsZeilen: 0,
  });
  EXTRA.upload = ['C', 'P'].every((x) => {
    const d = zeile('documents', DOC[x]);
    return d.file_path === dateiInhalt(x) && d.file_type === 'image/png' && Number(d.file_size) === readFileSync(DOC_FILE(x)).length
      && d.doc_class === 'receipt' && d.linked_entity_type === 'customer' && d.linked_entity_id === KUNDE(x) && d.created_by === akteurVon(x);
  });
  ok(EXTRA.upload, 'DOC-UPLOAD der Inhalt steht bytegenau am Primary, Typ und Größe bestimmt der Primary aus dem Inhalt, Verknüpfung zum Kunden, angelegt vom Handelnden');

  // OCR — am Primary aus SEINEM gespeicherten Inhalt, mit den Dateien der App (Worker, Kern, eng+ara) —
  // kein CDN. PC2: die erste Antwort geht verloren; die Wiederholung bekommt das eingefrorene Ergebnis:
  // genau EINE Erkennung, EINE neue Fassung, kein zweites Dokument.
  {
    const karte = (x) => `[...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.trim() === ${S(DOC_NAME(x))})`;
    const docsVor = zahl('SELECT COUNT(*) AS n FROM documents');
    const beobP = await netzBeobachter(APP_CDP), beobC = await netzBeobachter(CLIENT_CDP);
    let netzC = [];
    await paar({
      name: 'DOC-OCR', op: 'documents.set_ocr', lost: '[data-ocr-error]',
      route: () => '/documents',
      bereit: (x) => karte(x),
      vorher: (x) => ({ rev: Number(zeile('documents', DOC[x]).revision) }),
      fuellen: async (c, x) => {
        if (x === 'C') beobC.requests.length = 0;
        const r = [await klickAusdruck(c, karte(x), 'karte')];
        if (!(await warteBis(c, q('[data-document-ocr]'), 20000))) r.push('KEIN-OCR-KNOPF');
        return alleOk(r);
      },
      speichern: (c) => klick(c, '[data-document-ocr]'),
      fertig: (x, v) => { const d = zeile('documents', DOC[x]); return Number(d.ocr_reviewed) === 1 && !!d.ocr_text && Number(d.revision) === v.rev + 1; },
      zu: () => `${q('[data-document-ocr]')} && ${q('[data-document-ocr]')}.textContent.includes('Re-run OCR')`,
      keys: ['documentId', 'expectedRevision'],
      rumpf: (p, x, v) => p.documentId === DOC.C && p.expectedRevision === v.rev,
      zustand: (x, v) => {
        if (x === 'C') netzC = [...beobC.requests];
        const d = zeile('documents', DOC[x]);
        return { text: String(d.ocr_text || '').trim(), conf: Number(d.ocr_confidence), reviewed: Number(d.ocr_reviewed), rev: Number(d.revision) - v.rev, audit: auditVon([DOC[x]]) };
      },
      buchungsZeilen: 0,
    });
    await spuelen(primary);
    const dC = zeile('documents', DOC.C), dP = zeile('documents', DOC.P);
    const tC = String(dC.ocr_text || '').trim(), tP = String(dP.ocr_text || '').trim();
    ok(!!tC && tC === tP && /4711|R6F|LATAIF/i.test(tC), `OCR echte Erkennung für PC2 und am Primary: derselbe Text aus dem gespeicherten Bild („${tC.slice(0, 60)}")`);
    const gespeichert = Number(dC.ocr_reviewed) === 1 && Number(dP.ocr_reviewed) === 1 && Number(dC.ocr_confidence) > 0 && Number(dC.ocr_confidence) === Number(dP.ocr_confidence);
    ok(gespeichert, `OCR Text, „gelaufen" und Sicherheit stehen in der Datenbankdatei des Primary (${S([dC.ocr_confidence, dP.ocr_confidence])})`);
    const keinDoppel = zahl('SELECT COUNT(*) AS n FROM documents') === docsVor;
    ok(keinDoppel, 'OCR kein zweites Dokument — auch nicht durch die Wiederholung');
    // Kein CDN: jede Anfrage der Seite UND ihrer Worker (CDP, ab dem ersten Klick) ging an die App selbst.
    const netzP = [...beobP.requests];
    beobP.close(); beobC.close();
    const eigen = (u) => /^(https?:\/\/(tauri\.localhost|ipc\.localhost|127\.0\.0\.1(:\d+)?)(\/|$)|ipc:|data:|blob:)/.test(String(u));
    const fremd = [...netzP, ...netzC].filter((u) => !eigen(u));
    const geladen = Object.keys(OCR_FILES).filter((f) => netzP.some((u) => u === `http://tauri.localhost/ocr/${f}`));
    console.log(`  · OCR-Netz: Primary ${netzP.length} Anfragen (OCR-Dateien: ${geladen.join(', ') || 'keine gesehen'}), PC2 ${netzC.length}`);
    ok(fremd.length === 0, `OCR kein Request an einen fremden Host — kein CDN (${S(fremd).slice(0, 300)})`);
    ok(geladen.length === Object.keys(OCR_FILES).length, `OCR Worker, Kern und Sprachdaten kamen vom Primary selbst (${geladen.length}/${Object.keys(OCR_FILES).length})`);
    const quelle = Object.fromEntries(Object.entries(OCR_FILES).map(([f, p]) => [f, readFileSync(join(process.cwd(), p)).length]));
    const imApp = JSON.parse(String(await primary.ev(`const out = {}; for (const f of ${S(Object.keys(OCR_FILES))}) {
      try { const r = await fetch('/ocr/' + f); out[f] = r.ok ? (await r.arrayBuffer()).byteLength : -r.status; } catch (e) { out[f] = String(e); } }
      return JSON.stringify(out);`)));
    const ausgeliefert = S(imApp) === S(quelle);
    ok(ausgeliefert, `OCR die App liefert jede OCR-Datei selbst aus, bytegenau so groß wie die Quelle (${S(imApp)})`);
    EXTRA.ocr = tC && tC === tP && gespeichert && keinDoppel && fremd.length === 0 && geladen.length === Object.keys(OCR_FILES).length && ausgeliefert ? 'stored' : '';
  }
  console.log('CENTRAL_UI_R6F_OFFICE_RUNTIME_PROVED_CANDIDATE');

  // Nur Diagnose: Medien-Kernaufrufe und hängende Ingest-Journale über den ganzen Lauf (auch wenn grün).
  await diagnose('ENDE');

  // ══════════════════════════════════════════════════════════════════════
  // LEDGER — jede Buchungstransaktion dieses Laufs ist ausgeglichen
  // ══════════════════════════════════════════════════════════════════════
  {
    await spuelen(primary);
    const rows = buchungenSeit(LEDGER_BASIS);
    const tx = new Map();
    for (const r of rows) {
      const t = tx.get(r.transaction_id) || { d: 0, c: 0 };
      if (r.direction === 'DEBIT') t.d += Math.round(Number(r.amount) * 1000); else t.c += Math.round(Number(r.amount) * 1000);
      tx.set(r.transaction_id, t);
    }
    const schief = [...tx.entries()].filter(([, t]) => t.d !== t.c);
    ok(rows.length > 0 && schief.length === 0, `LEDGER ${tx.size} Transaktionen / ${rows.length} Zeilen dieses Laufs — jede ausgeglichen (Σ Soll == Σ Haben) (${S(schief).slice(0, 300)})`);
    const quellen = [...new Set(rows.map((r) => r.source_module))].sort();
    console.log(`  · Hauptbuch dieses Laufs: ${rows.length} Zeilen in ${tx.size} Transaktionen · Quellen ${quellen.join(', ')}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // SAFETY — kein Griff zur lokalen Datenbank, die alte Datei unberührt
  // ══════════════════════════════════════════════════════════════════════
  {
    await ernte(client);
    ok(ALLE_TREFFER.length === 0, `LOKAL kein Griff zur lokalen Datenbank — über alle Seiten des Laufs (${S(ALLE_TREFFER).slice(0, 200)})`);
    ok(!ALLE_AUFRUFE.some((x) => /stock_check|flush_database|backup|import|save_database/i.test(x)),
      `LOKAL kein Aufruf des eigenen Kerns zum Speichern (${[...new Set(ALLE_AUFRUFE)].join(',').slice(0, 300)})`);
    ok(sha(STALE) === staleVorher, 'LOKAL die alte Geschäftsdatei auf PC2 ist unberührt');
    const dateien = readdirSync(CLIENT_DATA_DIR).sort();
    const neu = dateien.filter((f) => !dateienVorher.includes(f));
    ok(neu.length === 0 && !dateien.some((f) => /lataif_sync_server\.db|outbox|data-location|media/i.test(f)), `LOKAL keine neue Datei, keine Konfig-DB, keine Warteschlange, kein Medienordner (${dateien.join(', ')})`);
    const schluessel = await client.ev('return JSON.stringify(Object.keys(localStorage));');
    ok(!/outbox|pending|queue/i.test(schluessel), `LOKAL keine lokale Warteschlange im Speicher (${schluessel})`);
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
console.log('\n  Handlung                          PC2   Primary');
for (const o of OPS) console.log(`  ${o.padEnd(34)}${(BEWEIS[o].C > 0 ? 'ja' : 'NEIN').padEnd(6)}${BEWEIS[o].P > 0 ? 'ja' : 'NEIN'}`);
const alleBeide = (ops) => ops.every((o) => BEWEIS[o].C > 0 && BEWEIS[o].P > 0);
console.log(`  verlorene Antwort: ${LOST_OPS.map((o) => `${o}=${LOST[o] ? 'ja' : 'NEIN'}`).join(' · ')}`);
console.log(`  Zusatz: ${Object.entries(EXTRA).map(([k, v]) => `${k}=${v === true ? 'ja' : v === false ? 'NEIN' : (v || 'NEIN')}`).join(' · ')} · Akteur-Fehler ${AKTEUR_FEHL}`);
ok(alleBeide(OPS), `ALLE ${OPS.length} Handlungen auf PC2 UND am Primary bewiesen (fehlend: ${OPS.filter((o) => !(BEWEIS[o].C > 0 && BEWEIS[o].P > 0)).join(', ') || 'keine'})`);
ok(LOST_OPS.every((o) => LOST[o]), `LOST alle ${LOST_OPS.length} verlorenen Antworten: dieselbe Kennung, genau eine Wirkung, dieselbe Buchung`);
ok(AKTEUR_FEHL === 0, `AKTEUR jede Fernbuchung gehört B, jede Primary-Buchung A — kein Leck (${AKTEUR_FEHL} Fehler)`);
ok(EXTRA.ocr === 'stored', `OCR echte Erkennung auf beiden Seiten gespeichert, offline (${EXTRA.ocr || 'kein Ausgang'})`);
const dauer = Math.round((Date.now() - T0) / 1000);
const ZEILE = `central ui parity r6f: purchases + orders + consignment + production/media + office, lost response, two apps, two users (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) {
  console.log(`\nFAIL — ${ZEILE}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
if (alleBeide(['purchases.return_to_supplier', 'purchases.cancel', 'purchases.dismiss_inbox']) && EXTRA.purchase && EXTRA.inbox) console.log('CENTRAL_UI_R6F_PURCHASES_RUNTIME_PROVED');
if (alleBeide(['orders.mark_line_ordered', 'orders.update_line_status', 'orders.update_line', 'orders.cancel']) && EXTRA.order) console.log('CENTRAL_UI_R6F_ORDERS_RUNTIME_PROVED');
if (alleBeide(['consignments.return_after_sale', 'consignments.cancel_sale']) && EXTRA.keep && EXTRA.presale && EXTRA.noDelete) console.log('CENTRAL_UI_R6F_CONSIGNMENT_RUNTIME_PROVED');
if (alleBeide(['production.create', 'products.update']) && EXTRA.production && EXTRA.bild) console.log('CENTRAL_UI_R6F_PRODUCTION_MEDIA_RUNTIME_PROVED');
if (alleBeide(['tasks.create', 'tasks.update', 'documents.upload', 'documents.set_ocr']) && EXTRA.tasks && EXTRA.upload && EXTRA.ocr === 'stored') console.log('CENTRAL_UI_R6F_OFFICE_RUNTIME_PROVED');
if (alleBeide(['documents.set_ocr']) && LOST['documents.set_ocr'] && EXTRA.ocr === 'stored') console.log('CENTRAL_UI_R6F_OCR_RUNTIME_PROVED');
if (LOST_OPS.every((o) => LOST[o])) console.log('CENTRAL_UI_R6F_LOST_RESPONSE_PROVED');
console.log('CENTRAL_UI_R6F_TWO_APP_PROVED');
console.log(`\nPASS — ${ZEILE}`);
