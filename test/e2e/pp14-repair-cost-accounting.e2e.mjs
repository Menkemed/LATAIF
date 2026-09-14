// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY PP-13 + PP-14 — Reparaturkosten: zwei echte Anwendungen, zwei echte Benutzer.
// Run: node test/e2e/pp14-repair-cost-accounting.e2e.mjs
//
//   Jede Handlung läuft ZWEIMAL durch dieselbe normale Maske: zuerst auf PC2 (ohne Geschäftsdatenbank,
//   angemeldet als Benutzer B, Fernauftrag /api/command), dann am Primary (angemeldet als A) auf dem
//   Zwilling. Verglichen wird in der Datenbank des Primary.
//
//   EIGENE WARE + WERKSTATT   in Arbeit → an Werkstatt → fertig (verlorene Antwort): Ausgabe „Inventory",
//                             Soll INVENTORY / Haben A/P, Artikel + Los 100, kein Aufwand; Verkauf 300 → COGS 100, Gewinn 200
//   EIGENE WARE, EIGENE ARBEIT in Arbeit → fertig: eigene Kosten 100 ohne Zahlweg als aktivierte Eigenleistung
//                             (Soll INVENTORY / Haben EXPENSES_OPERATING — keine Verbindlichkeit, keine Kasse), Artikel + Los 100
//   KUNDENWARE + WERKSTATT    in Arbeit → an Werkstatt → fertig → Rechnung 300: Ausgabe „RepairServiceCost",
//                             Soll COGS / Haben A/P, KEIN Bestand, die Rechnung bucht keinen zweiten Wareneinsatz, Marge 200
//   BEZAHLT                   die Werkstatt der Kundenreparatur bezahlt: nur A/P / Kasse, Marge und COGS unverändert
//   RÜCKNAHME                 eine unbezahlte Werkstattzeile storniert (Schuld + COGS zurück); eine bezahlte: Nein
//                             (REPAIR_COST_PAID), nichts geschrieben
//   LEDGER                    jede Buchungstransaktion dieses Laufs ist ausgeglichen
//   SAFETY                    PC2 mit einer ALTEN lataif.db: unberührt, kein eigener Kern, keine lokale Datenbank
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
const OWNER_PW = 'pp14-owner-' + Math.random().toString(36).slice(2);
// Der zweite echte Benutzer (wie im R6E-Akteurslauf): eigene Kennung/E-Mail, Owner-Rolle, der bcrypt-Wert
// des Owners kopiert — die Anmeldung prüft ihn mit dem echten `bcrypt::verify`.
const B_ID = 'user-pp14-b';
const B_EMAIL = 'kollege.pp14@lataif.com';
const B_NAME = 'PP14 Kollege B';

const RUN = join(os.tmpdir(), 'lataif-pp14', 'run-' + Date.now());
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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PP14 Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'PP14 Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'PP14 Admin A');
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



  const XS = ['C', 'P'];
  const eigeneWare = (x) => reparaturZustand(RO(x), OW);
  // ══════════════════════════════════════════════════════════════════════
  // PP-13 — eigene Ware + Werkstatt: in Arbeit → an Werkstatt → fertig (verlorene Antwort)
  // ══════════════════════════════════════════════════════════════════════
  await paar(weiter('RO → in Arbeit (Werkstattschuld)', RO, 'in_progress', OW, { neu: true, zeilen: 2 }));
  {
    const je = XS.map((x) => reparaturZustand(RO(x), OW(x)));
    ok(je.every((z) => S(z.exp) === S([['Inventory', 100, 0, 'PENDING', 'WERKSTATT']]) && S(z.konten) === S({ ACCOUNTS_PAYABLE: -100, INVENTORY: 100 }) && z.artikel.einstand === 0),
      `PP-13 Werkstattschuld eigener Ware: EINE Ausgabe „Inventory" 100, Soll INVENTORY / Haben A/P, KEIN Aufwand, Einstand noch 0 (${S(je).slice(0, 500)})`);
  }
  await paar(weiter('RO → an Werkstatt', RO, 'sent_to_workshop', OW));
  await paar(weiter('RO → fertig (Kapitalisierung)', RO, 'ready', OW, { lost: true }));
  {
    const je = XS.map((x) => reparaturZustand(RO(x), OW(x)));
    EXTRA.ownWorkshop = je.every((z) => z.artikel.einstand === 100 && z.artikel.los === 100 && z.artikel.bestand === 'in_stock'
      && S(z.konten) === S({ ACCOUNTS_PAYABLE: -100, INVENTORY: 100 }) && z.exp.length === 1);
    ok(EXTRA.ownWorkshop, `PP-13 fertig: Artikel + Los 100 (genau EINMAL, auch nach der verlorenen Antwort), zurück im Bestand, keine zweite Ausgabe (${S(je).slice(0, 500)})`);
  }
  console.log('POST_PARITY_PP13_OWN_WORKSHOP_RUNTIME_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // PP-13 — eigene Ware, eigene Arbeit 100 (keine Werkstatt)
  // ══════════════════════════════════════════════════════════════════════
  await paar(weiter('RI → in Arbeit', RI, 'in_progress', OI));
  await paar(weiter('RI → fertig (eigene Arbeit auf den Bestand)', RI, 'ready', OI, { zeilen: 2 }));
  {
    const je = XS.map((x) => reparaturZustand(RI(x), OI(x)));
    EXTRA.ownInternal = je.every((z) => S(z.exp) === '[]' && S(z.konten) === S({ EXPENSES_OPERATING: -100, INVENTORY: 100 })
      && z.artikel.einstand === 100 && z.artikel.los === 100);
    ok(EXTRA.ownInternal, `PP-13 eigene Arbeit ohne Zahlweg: KEINE Ausgabe/Verbindlichkeit/Kasse — aktivierte Eigenleistung Soll INVENTORY / Haben EXPENSES_OPERATING, Artikel + Los 100 (${S(je).slice(0, 500)})`);
  }
  console.log('POST_PARITY_PP13_INTERNAL_RUNTIME_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // PP-14 — Kundenware + Werkstatt: in Arbeit → an Werkstatt → fertig
  // ══════════════════════════════════════════════════════════════════════
  await paar(weiter('RK → in Arbeit (Werkstattschuld)', RK, 'in_progress', null, { neu: true, zeilen: 2 }));
  await paar(weiter('RK → an Werkstatt', RK, 'sent_to_workshop', null));
  await paar(weiter('RK → fertig (Marge)', RK, 'ready', null));
  {
    const je = XS.map((x) => reparaturZustand(RK(x)));
    EXTRA.customer = je.every((z) => S(z.exp) === S([['RepairServiceCost', 100, 0, 'PENDING', 'WERKSTATT']]) && S(z.konten) === S({ ACCOUNTS_PAYABLE: -100, COGS: 100 })
      && z.rep.margin === 200);
    ok(EXTRA.customer, `PP-14 Werkstattschuld der Kundenware: EINE Ausgabe „RepairServiceCost", Soll COGS / Haben A/P, KEIN Bestand, Marge 200 (${S(je).slice(0, 500)})`);
  }

  // ── bezahlt: die Zahlung begleicht nur A/P ──
  await paar(zahlungDef);
  {
    const je = XS.map((x) => reparaturZustand(RK(x)));
    EXTRA.paid = je.every((z) => S(z.exp) === S([['RepairServiceCost', 100, 100, 'PAID', 'WERKSTATT']]) && S(z.konten) === S({ CASH: -100, COGS: 100 }) && z.rep.margin === 200);
    ok(EXTRA.paid, `PP-14 bezahlt: nur Soll A/P / Haben Kasse — COGS 100 und Marge 200 unverändert (${S(je).slice(0, 500)})`);
  }

  // ── die bezahlte Zeile ist nicht mehr stornierbar ──
  {
    const blockiert = [];
    for (const x of XS) {
      let c;
      await syncRuhe();
      if (x === 'C') { client = await lade(client, `/repairs/${RK(x)}`); c = client; } else { await gehFrisch(primary, `/repairs/${RK(x)}`); c = primary; }
      await c.ev(DIALOGE_PRIMARY);
      const da = await warteBis(c, q('[data-cancel-repair-line]'), 45000);
      const vor = S(reparaturZustand(RK(x)));
      const vorAnt = x === 'C' ? (await antworten(c)).length : 0;
      const r = da ? await klick(c, '[data-cancel-repair-line]') : 'KEIN-KNOPF';
      const nein = await warteBis(c, "[...document.querySelectorAll('[data-save-error]')].some((e) => /already paid/.test(e.textContent)) || (window.__alerts || []).some((a) => /already paid/.test(a))", 30000);
      await sleep(800);
      await spuelen(primary);
      const nach = S(reparaturZustand(RK(x)));
      let urteil = true;
      if (x === 'C') {
        const an = (await antworten(c)).slice(vorAnt).filter((a) => a.op === 'repairs.cancel_line');
        urteil = an.length === 1 && an[0].ok === false && /REPAIR_COST_PAID/.test(S(an[0].error));
      }
      const gut = r === 'OK' && nein && vor === nach && !!zeile('repair_lines', LK(x)).id && urteil;
      blockiert.push(gut);
      ok(gut, `PP-14 REVERSAL-BLOCKED [${x === 'C' ? 'PC2/B' : 'Primary/A'}] bezahlte Werkstattzeile: Nein (REPAIR_COST_PAID) sichtbar, nichts geschrieben (${r}; ${String(await fehlerText(c)).slice(0, 200)})`);
    }
    EXTRA.reversalBlocked = blockiert.every(Boolean);
  }

  // ── die Rechnung: kein zweiter Wareneinsatz ──
  await paar(rechnungDef);
  {
    const je = XS.map((x) => kundenRechnung(x));
    EXTRA.invoice = je.every((z) => z.einstand === 100 && z.marge === 200 && z.netto === 300 && S(z.konten) === S({ ACCOUNTS_RECEIVABLE: 300, REVENUE: -300 })
      && S(z.reparatur.konten) === S({ CASH: -100, COGS: 100 }));
    ok(EXTRA.invoice, `PP-14 Rechnung 300: Einstand 100 (nicht 200), Marge 200, die Rechnung bucht nur Forderung/Erlös — KEIN Wareneinsatz, KEIN Bestand; die 100 wirken genau einmal (COGS aus der Werkstattschuld) (${S(je).slice(0, 600)})`);
  }
  console.log('POST_PARITY_PP14_CUSTOMER_RUNTIME_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // PP-14 — Rücknahme erlaubt: eine unbezahlte Werkstattzeile stornieren
  // ══════════════════════════════════════════════════════════════════════
  await paar(weiter('RC → in Arbeit (Werkstattschuld 40)', RC, 'in_progress', null, { neu: true, zeilen: 2 }));
  {
    const je = XS.map((x) => reparaturZustand(RC(x)));
    ok(je.every((z) => S(z.konten) === S({ ACCOUNTS_PAYABLE: -40, COGS: 40 })), `PP-14 RC vor dem Storno: COGS 40 / A/P 40 (${S(je)})`);
  }
  const storno = await paar(stornoDef);
  EXTRA.reversalAllowed = XS.every((x) => storno[x]?.gut && S(storno[x].Z.konten) === S({}) && storno[x].Z.exp === 0);
  ok(EXTRA.reversalAllowed, `PP-14 REVERSAL-ALLOWED Storno der unbezahlten Zeile: Ausgabe weg, COGS und A/P gegengebucht (netto 0), nichts Negatives (${S(XS.map((x) => storno[x]?.Z))})`);

  // ══════════════════════════════════════════════════════════════════════
  // Verkauf der eigenen Ware (am Primary als A): der Einstand geht genau einmal als COGS
  // ══════════════════════════════════════════════════════════════════════
  {
    const ergebnis = [];
    for (const x of XS) {
      for (const pid of [OW(x), OI(x)]) {
        const inv = await verkaufAmPrimary(x, pid);
        const line = inv ? dbQ(BIZ_DB, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [inv])[0] || {} : {};
        const kopf = inv ? zeile('invoices', inv) : {};
        const rep = pid === OW(x) ? RO(x) : RI(x);
        const ids = alleAusgabenIds(rep);
        const konten = netto([...ids, ...zahlungIds(ids), ...eigenQuellen(rep), inv || '']);
        ergebnis.push({ x, pid, einstand: Number(line.purchase_price_snapshot), marge: Number(kopf.margin_snapshot), konten });
      }
    }
    EXTRA.sale = ergebnis.every((e) => e.einstand === 100 && e.marge === 200 && (e.konten.INVENTORY ?? 0) === 0 && e.konten.COGS === 100
      && e.konten.REVENUE === -300 && (e.pid.includes('-oi-') ? e.konten.EXPENSES_OPERATING === -100 : !('EXPENSES_OPERATING' in e.konten)));
    ok(EXTRA.sale, `PP-13 Verkauf 300 je eigene Ware: Wareneinsatz 100 = Einstand, INVENTORY zurück auf 0, Marge 200, kein Aufwand (${S(ergebnis).slice(0, 700)})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Berichte == Hauptbuch: keine Reparaturkosten als Betriebsausgabe, Gewinn je Fall 200
  // ══════════════════════════════════════════════════════════════════════
  {
    await spuelen(primary);
    const kat = dbQ(BIZ_DB, "SELECT DISTINCT category FROM expenses WHERE related_module = 'repair' AND status != 'CANCELLED' ORDER BY category").map((r) => r.category);
    const opRep = zahl(`SELECT COUNT(*) AS n FROM ledger_entries l JOIN expenses e ON e.id = l.source_id
      WHERE l.source_module = 'EXPENSE' AND l.account = 'EXPENSES_OPERATING' AND e.related_module = 'repair'`);
    const invCogs = zahl(`SELECT COUNT(*) AS n FROM ledger_entries l JOIN invoice_lines il ON il.id = l.source_line_id
      WHERE l.source_module = 'INVOICE' AND l.account IN ('COGS', 'INVENTORY') AND il.product_id LIKE 'svc-repair-%'`);
    const je = XS.map((x) => ({ x, kunde: kundenRechnung(x).marge, eigen: ['ow', 'oi'].map((k) => Number(dbQ(BIZ_DB, `SELECT margin_snapshot FROM invoices WHERE id IN (SELECT invoice_id FROM invoice_lines WHERE product_id = ?)`, [`pp14-${k}-${x}`])[0]?.margin_snapshot)) }));
    EXTRA.reports = S(kat) === S(['Inventory', 'RepairServiceCost']) && opRep === 0 && invCogs === 0
      && je.every((z) => z.kunde === 200 && z.eigen.every((m) => m === 200));
    ok(EXTRA.reports, `BERICHTE == HAUPTBUCH Reparaturkosten nur „Inventory"/„RepairServiceCost" (${kat.join(',')}), keine auf EXPENSES_OPERATING (${opRep}), kein Wareneinsatz auf der Reparaturrechnung (${invCogs}); Gewinn je Fall 200 (${S(je)})`);
  }
  console.log('POST_PARITY_REPAIR_LEDGER_REPORT_RUNTIME_CANDIDATE');

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
console.log(`  Zusatz: ${Object.entries(EXTRA).map(([k, v]) => `${k}=${v === true ? 'ja' : 'NEIN'}`).join(' · ')} · Akteur-Fehler ${AKTEUR_FEHL}`);
ok(alleBeide(OPS), `ALLE ${OPS.length} Handlungen auf PC2 UND am Primary bewiesen (fehlend: ${OPS.filter((o) => !(BEWEIS[o].C > 0 && BEWEIS[o].P > 0)).join(', ') || 'keine'})`);
ok(LOST_OPS.every((o) => LOST[o]), `LOST die verlorene Antwort: dieselbe Kennung, genau eine Wirkung, dieselbe Buchung`);
ok(AKTEUR_FEHL === 0, `AKTEUR jede Fernbuchung gehört B, jede Primary-Buchung A — kein Leck (${AKTEUR_FEHL} Fehler)`);
ok(Object.values(EXTRA).every((v) => v === true), `ZUSATZ jede fachliche Prüfung grün (${Object.entries(EXTRA).filter(([, v]) => v !== true).map(([k]) => k).join(', ') || 'alle'})`);
const dauer = Math.round((Date.now() - T0) / 1000);
const ZEILE = `post-parity pp-13 + pp-14 repair cost accounting: own item workshop + own work, customer repair workshop, paid, reversal allowed/blocked, sale — two apps, two users (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) {
  console.log(`\nFAIL — ${ZEILE}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
if (EXTRA.ownWorkshop && EXTRA.ownInternal && EXTRA.sale) console.log('POST_PARITY_PP13_RUNTIME_PROVED');
if (EXTRA.customer && EXTRA.invoice && EXTRA.paid) console.log('POST_PARITY_PP14_RUNTIME_PROVED');
if (EXTRA.reversalAllowed && EXTRA.reversalBlocked) console.log('POST_PARITY_REPAIR_REVERSAL_RUNTIME_PROVED');
if (LOST_OPS.every((o) => LOST[o])) console.log('POST_PARITY_REPAIR_LOST_RESPONSE_PROVED');
if (EXTRA.reports) console.log('POST_PARITY_REPAIR_LEDGER_REPORT_RUNTIME_PROVED');
console.log('POST_PARITY_PP13_PP14_TWO_APP_PROVED');
console.log(`\nPASS — ${ZEILE}`);
