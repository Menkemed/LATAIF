// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — Angebote, Rechnung mit Zahlung, Rücknahmen und Nachrichtenprotokoll,
// zwei echte Anwendungen.
// Run: node test/e2e/r6e-sales-offers-invoice.e2e.mjs
//
//   Jede Buchung läuft ZWEIMAL durch dieselbe Maske: zuerst auf PC2 (ohne Geschäftsdatenbank,
//   Fernauftrag /api/command), dann am Primary auf dem Zwilling (runOnPrimary). Verglichen werden die
//   normalisierten Geschäftszeilen (ohne Kennung/Zeit/Nummer), Status, Bestand/Lose, Fassung und die
//   Hauptbuchzeilen der Handlung (Konto, Richtung, Betrag, Quelle). Auf PC2 zusätzlich: genau EIN
//   Auftrag mit genau den Absichtsfeldern.
//
//   OFFERS    anlegen → bearbeiten (Kopf + Position dazu + Preis + Position weg, EIN Save) → senden →
//             annehmen → Rechnung; zweites Angebot: senden und ablehnen über die Zeilenknöpfe der Liste
//   INVOICE   Rechnung MIT Zahlung (voll → Nummerndialog normal bzw. Sonder → SINV-Kreis), Teilzahlung,
//             Endzahlung mit Sondernummer über die Liste, Endzahlung normal über die Rechnungsseite,
//             Butterfly an/aus
//   REVERSAL  Retoure stornieren (Owner), Umwandlung eines Agenten-Transfers zurücknehmen (Rechnung
//             bleibt als CANCELLED stehen, Transfer wieder „sold", Verkaufsforderung wieder da)
//   MESSAGE   Nachricht aus der Vorschau (WhatsApp) → genau EIN Protokolleintrag, created_by = Absender
//   STALE     PC2 hält ein Angebot im Bearbeiten, der Primary ändert es, PC2 speichert → RECORD_CHANGED
//   LOST      verlorene Antwort (offers.create, offers.convert_to_invoice, invoices.create mit Zahlung,
//             returns.cancel, transfers.undo_convert): dieselbe Kennung, genau eine Wirkung
//   LEDGER    jede Buchungstransaktion dieses Laufs ist ausgeglichen (Σ Soll == Σ Haben)
//   SAFETY    PC2 mit einer ALTEN lataif.db: unberührt, kein eigener Kern, keine lokale Datenbank
//
// Die KI-Vorschau erzeugt ihren Text über OpenAI. Hier geht KEIN Aufruf ins Netz: die Testseite
// beantwortet api.openai.com selbst (fester Text), und `window.open` (WhatsApp) wird nur mitgeschrieben.
//
// PROZESS-ISOLATION (dauerhafte Regel): gestartet wird nur über `spawnTracked`, beendet wird nur, was
// dieser Lauf gestartet hat (PID mit Pfadprüfung) oder was am EXAKTEN Test-Pfad läuft. Die installierte
// Produktions-App wird nie beendet, nie benutzt; E:\LATAIF\Data und die Ports 3001/3443 bleiben tabu.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r6e-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r6e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
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
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
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
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
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
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
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

// Der feste Text der KI-Vorschau — die Testseite beantwortet api.openai.com selbst.
const KI_TEXT = 'R6E Nachricht: Ihr Angebot liegt bereit, wir freuen uns auf Ihren Besuch.';
const KI_SCHLUESSEL = 'sk-r6e-e2e-kein-echter-schluessel';
const OBF_SEED = 'lataif-2026-key-obf';
/** Dieselbe leichte Verschleierung wie `ai-service.ts` — so liest PC2 den Schlüssel, ohne ihn als Datei zu schreiben. */
const verschleiert = (klar) => Buffer.from([...klar].map((ch, i) => ch.charCodeAt(0) ^ OBF_SEED.charCodeAt(i % OBF_SEED.length))).toString('base64');

// Der Beobachter: Fernaufträge, ihre Antworten, Datenbankgriffe, Kern-Aufrufe, Dialoge — und EINE
// verlorene Antwort auf Wunsch. Dazu: api.openai.com antwortet die Seite selbst, `window.open` wird
// nur mitgeschrieben.
const BEOBACHTER = `
  if (window.__r6eInstalliert) { /* schon da */ } else {
  window.__r6eInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__invokes = []; window.__alerts = []; window.__dropNext = null;
  window.__opens = []; window.__aiCalls = 0;
  window.alert = (m) => { window.__alerts.push(String(m)); };
  window.confirm = () => true;
  window.open = (u) => { window.__opens.push(String(u)); return null; };
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); oe(...a); };
  const ow = console.warn;
  console.warn = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); ow(...a); };
  (function haken() {
    const t = window.__TAURI_INTERNALS__;
    if (t && t.invoke && !t.__r6e) {
      const oi = t.invoke.bind(t);
      t.invoke = (cmd, args, opts) => { window.__invokes.push(String(cmd)); return oi(cmd, args, opts); };
      t.__r6e = true;
    } else if (!t || !t.__r6e) setTimeout(haken, 30);
  })();
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    if (/^https:\\/\\/api\\.openai\\.com\\//.test(url)) {
      window.__aiCalls++;
      if (/chat\\/completions/.test(url)) return new Response(JSON.stringify({ choices: [{ message: { content: ${S(KI_TEXT)} } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{"error":"r6e: kein Netz"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload }); } catch (e) { /* kein lesbarer Rumpf */ }
    }
    if (body && window.__dropNext && body.op === window.__dropNext) {
      // Die Anfrage GEHT hinaus und wird am Primary ausgeführt — nur die Antwort kommt nie an.
      window.__dropNext = null;
      const r0 = await of(...a);
      try { await r0.text(); } catch (e) { /* egal */ }
      window.__answers.push({ op: body.op, commandId: body.commandId, dropped: true });
      throw new TypeError('R6E: simulated lost response');
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
/** Am Primary (ohne Neuladen): api.openai.com beantwortet die Seite selbst, `window.open` nur mitgeschrieben. */
const KI_PRIMARY = `
  if (!window.__r6eKi) {
    window.__r6eKi = true; window.__opens = []; window.__aiCalls = 0;
    window.open = (u) => { window.__opens.push(String(u)); return null; };
    const of = window.fetch;
    window.fetch = async (...a) => {
      let url = '';
      try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
      if (/^https:\\/\\/api\\.openai\\.com\\//.test(url)) {
        window.__aiCalls++;
        if (/chat\\/completions/.test(url)) return new Response(JSON.stringify({ choices: [{ message: { content: ${S(KI_TEXT)} } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return new Response('{"error":"r6e: kein Netz"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      return of(...a);
    };
  }
  return 1;
`;

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
const ALLE_TREFFER = [], ALLE_AUFRUFE = [], ALLE_KI = [];
async function ernte(c) {
  try {
    ALLE_TREFFER.push(...(await treffer(c)));
    ALLE_AUFRUFE.push(...(await aufrufe(c)));
    ALLE_KI.push(Number(await c.ev('return window.__aiCalls || 0;')) || 0);
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
  await geh(p, '/tasks');
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
const FEHLER_SEL = '[data-save-error],[data-message-log-note]';
const fehlerText = (c, sel = FEHLER_SEL) => c.ev(`return [...document.querySelectorAll(${S(sel)})].map(e=>e.textContent).join(' | ');`).catch(() => '');
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

/**
 * Der Primary synchronisiert (Auto-LAN) mit seinem EIGENEN Sync-Server; ein Echo-Lauf zwischen
 * „Seite geladen" und „Speichern" darf die gesehene Fassung nicht alt machen (Befund R6D). Vor jedem
 * Laden und vor jedem Vergleich wird gewartet, bis der Primary nichts mehr zu schieben hat.
 */
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
      // Nicht 30 s auf den Zeitgeber warten: derselbe Lauf über den Knopf „Sync Now" des Primary.
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
const ledgerMax = () => zahl('SELECT COALESCE(MAX(rowid), 0) AS m FROM ledger_entries');
const buchungenSeit = (row) => dbQ(BIZ_DB, 'SELECT account, direction, amount, source_module, transaction_id, reverses_entry_id FROM ledger_entries WHERE rowid > ? ORDER BY rowid', [row]);
const ledgerNorm = (rows) => S(rows.map((r) => [r.account, r.direction, Math.round(Number(r.amount) * 1000), r.source_module, r.reverses_entry_id ? 'R' : '']).map((x) => S(x)).sort());

// ── Normalisieren: Kennungen, Zeiten, Nummern raus; Zwillingsnamen (… C / … P) gleichgesetzt ──────
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMMER_RE = /\b[A-Z]{2,5}-(?:\d{4}-)?\d{3,6}\b/g;
const TEXTFELD = /^(description|notes|note|title)$/;
function zw(v, k) {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v !== 'string') return v;
  let s = v.replace(UUID_RE, '<uuid>').replace(NUMMER_RE, '<nr>').replace(/((?:r6e|R6E)[A-Za-z0-9 _-]*?[ -])([CP])(?![A-Za-z0-9])/g, '$1X');
  if (k && TEXTFELD.test(k)) s = s.replace(/\b[0-9a-f]{8}\b/g, '<id8>');
  return s;
}
const OHNE_STD = /^(id|created_at|updated_at|created_by|recorded_at|occurred_at|entry_no|transaction_id|[a-z_]*_number|sync_status|position|[a-z_]*_at|assigned_to|changed_by|user_id)$/;
function nzWert(v, ohne, k) {
  if (Array.isArray(v)) return v.map((x) => nzWert(x, ohne)).map((x) => S(x)).sort().map((x) => JSON.parse(x));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v)
      .filter(([kk]) => !OHNE_STD.test(kk) && !(ohne && ohne.test(kk)))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kk, vv]) => [kk, nzWert(vv, ohne, kk)]));
  }
  return zw(v, k);
}
const nz = (v, ohne) => S(nzWert(v, ohne));

// ── Die Welt des Laufs: Zwillinge für PC2 (C) und Primary (P) ─────────────────
const KUNDE = (x) => `r6e-kunde-${x}`;
const PROD = (k, x) => `r6e-${k}-${x}`;
const LABEL = (k, x) => `Omega R6E Uhr ${k} ${x}`;
const AGENT = (x) => `r6e-agent-${x}`, TRF = (x) => `r6e-trf-${x}`, TP = (x) => `r6e-tp-${x}`;
const TRF_NR = (x) => (x === 'C' ? 'TRF-2026-06001' : 'TRF-2026-06002');
const ARTIKEL = ['pa', 'pb', 'pc', 'pd', 'pe', 'pf', 'pg', 'ph'];
const HEUTE = new Date().toISOString().slice(0, 10);
const tag = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'r6e-cat', branch_id, name: 'R6E Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    insert(db, 'employees', { id: 'r6e-emp', branch_id, name: 'R6E Kasse', employment_status: 'active', created_at: now, updated_at: now });
    const artikel = (id, name, extra) => {
      insert(db, 'products', { id, branch_id, category_id: 'r6e-cat', brand: 'Omega', name, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD', planned_sale_price: 1000, tax_scheme: 'VAT_10', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{}', stock_status: 'in_stock', source_type: 'OWN', created_at: now, updated_at: now, ...extra });
      insert(db, 'stock_lots', { id: id + '-lot', branch_id, product_id: id, unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    };
    for (const x of ['C', 'P']) {
      insert(db, 'customers', { id: KUNDE(x), branch_id, first_name: 'R6E', last_name: `Kunde ${x}`, phone: x === 'C' ? '+973 3600 0611' : '+973 3600 0622', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
      for (const k of ARTIKEL) artikel(PROD(k, x), `R6E Uhr ${k} ${x}`);
      // Der Agent verkauft für uns; seine Forderung läuft über den Kunden des Agenten.
      insert(db, 'agents', { id: AGENT(x), branch_id, name: `R6E Agent ${x}`, company: 'R6E Trading', phone: x === 'C' ? '+973 3700 0611' : '+973 3700 0622', commission_rate: 0, active: 1, customer_id: KUNDE(x), created_at: now, updated_at: now });
      artikel(TP(x), `R6E Uhr tp ${x}`, { stock_status: 'with_agent', source_type: 'AGENT' });
      insert(db, 'agent_transfers', {
        id: TRF(x), branch_id, transfer_number: TRF_NR(x), agent_id: AGENT(x), product_id: TP(x), agent_price: 900,
        commission_rate: 0, commission_type: 'percent', commission_value: 0, commission_amount: 0,
        settlement_model: 'full', status: 'transferred', transferred_at: now, settlement_paid_amount: 0, settlement_status: 'pending', revision: 1,
        created_at: now, updated_at: now,
      });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Die Nachweise ────────────────────────────────────────────────────────────
const OPS = [
  'offers.create', 'offers.update', 'offers.set_status', 'offers.convert_to_invoice',
  'invoices.create', 'invoices.record_payment', 'invoices.set_butterfly',
  'returns.cancel', 'transfers.undo_convert', 'customers.log_message',
];
const BEWEIS = Object.fromEntries(OPS.map((o) => [o, { C: 0, P: 0, versuche: 0 }]));
const LOST = {};
const EXTRA = { stale: false, sinv: false, butterfly: false, retoure: false, undo: false, akteur: false, nachricht: false };

/**
 * EINE Buchung, zweimal durch dieselbe Maske: PC2 (Fernauftrag) auf seinem Zwilling, dann der Primary.
 *   route(x) · bereit(x) (Ausdruck) · vorher(x) · fuellen(c,x,v) → 'OK' · speichern(c,x,v) → 'OK'
 *   fertig(x,v) (genau EINE Wirkung am Primary) · zu(x,v) (Ausdruck: die Maske meldet Erfolg)
 *   keys (die Absichtsfelder des Rumpfs) · rumpf(p,x,v) · zustand(x,v) (was verglichen wird) · ohne (RegExp)
 *   lost (Selektor der Fehleranzeige): nur auf PC2 — die erste Antwort geht verloren.
 */
async function paar(def) {
  const erg = {};
  BEWEIS[def.op].versuche++;
  for (const x of ['C', 'P']) {
    const seite = x === 'C' ? 'PC2' : 'Primary';
    const wer = `${def.name} [${seite}]`;
    const failVor = FAIL;
    let c;
    await syncRuhe();
    if (x === 'C') { client = await lade(client, def.route('C')); c = client; }
    else { await gehFrisch(primary, def.route('P')); c = primary; }
    const bereit = await warteBis(c, def.bereit(x), 45000);
    ok(bereit, `${wer} die Maske ist da (${def.route(x)})`);
    const v = def.vorher ? def.vorher(x) : {};
    const vorCmd = x === 'C' ? (await buchungen(c)).length : 0;
    const vorAnt = x === 'C' ? (await antworten(c)).length : 0;
    const vorL = ledgerMax();
    const m = bereit ? await def.fuellen(c, x, v) : 'NICHT-BEREIT';
    ok(m === 'OK', `${wer} Eingaben (${m})`);
    if (def.lost && x === 'C') {
      await c.ev(`window.__dropNext = ${S(def.op)}; return 1;`);
      const s1 = await def.speichern(c, x, v);
      const sichtbar = await warteBis(c, `[...document.querySelectorAll(${S(def.lost)})].some((e) => /No answer from the primary/.test(e.textContent))`, 25000);
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
    ok(await warteAuf(() => def.fertig(x, v)), `${wer} die Wirkung steht am Primary (Hinweis: ${String(await fehlerText(c)).slice(0, 220) || 'keiner'})`);
    ok(await warteBis(c, def.zu(x, v), 25000), `${wer} die Maske meldet Erfolg (Hinweis: ${String(await fehlerText(c)).slice(0, 220) || 'keiner'})`);
    await sleep(600);
    await syncRuhe();
    ok(def.fertig(x, v), `${wer} genau EINE Wirkung — auch danach noch (nach dem Echo des Primary)`);
    const L = buchungenSeit(vorL);
    const Z = def.zustand(x, v);
    let cc = [];
    if (x === 'C') {
      cc = (await buchungen(c)).slice(vorCmd);
      const n = def.lost ? 2 : 1;
      const gleich = n === 1 || (cc.length === 2 && cc[0].commandId === cc[1].commandId && S(cc[0].payload) === S(cc[1].payload));
      ok(cc.length === n && cc.every((k) => k.op === def.op) && gleich,
        `${wer} ${n === 1 ? 'genau EIN Auftrag' : 'zweimal DERSELBE Auftrag (Kennung + Rumpf)'} ${def.op} (${cc.map((k) => k.op + ':' + String(k.commandId).slice(0, 8)).join(', ')})`);
      const p = cc[0]?.payload || {};
      ok(S(Object.keys(p).sort()) === S([...def.keys].sort()), `${wer} der Rumpf nennt nur die Absicht (${S(Object.keys(p).sort())})`);
      if (def.rumpf) ok(!!def.rumpf(p, x, v), `${wer} die Werte im Rumpf (${S(p).slice(0, 500)})`);
      if (def.lost) {
        const an = (await antworten(c)).slice(vorAnt).filter((a) => a.op === def.op);
        const replay = an.length === 2 && an[0].dropped === true && an[1].ok === true && an[1].replayed === true;
        ok(replay, `LOST ${def.name}: die Wiederholung bekommt das eingefrorene Ergebnis (replayed) (${S(an).slice(0, 240)})`);
        LOST[def.op] = !!LOST[def.op] && replay;
      }
    }
    erg[x] = { L, Z, v, cmds: cc, gut: FAIL === failVor };
  }
  const zC = nz(erg.C.Z, def.ohne), zP = nz(erg.P.Z, def.ohne);
  const z = zC === zP;
  ok(z, `${def.name} PARITAET Zustand: Primary == PC2 (PC2 ${zC.slice(0, 700)} // Primary ${zP.slice(0, 700)})`);
  const lC = ledgerNorm(erg.C.L), lP = ledgerNorm(erg.P.L);
  const l = lC === lP;
  ok(l, `${def.name} PARITAET Hauptbuch: Primary == PC2 (${erg.C.L.length}/${erg.P.L.length} Zeilen; ${lC.slice(0, 300)} // ${lP.slice(0, 300)})`);
  if (def.buchungsZeilen !== undefined) {
    ok(erg.C.L.length === def.buchungsZeilen && erg.P.L.length === def.buchungsZeilen,
      `${def.name} Hauptbuch: je Seite genau ${def.buchungsZeilen} Zeilen (${erg.C.L.length}/${erg.P.L.length})`);
  }
  if (def.lost) LOST[def.op] = !!LOST[def.op] && l && erg.C.L.length === erg.P.L.length;
  if (erg.C.gut && z && l) BEWEIS[def.op].C++;
  if (erg.P.gut && z && l) BEWEIS[def.op].P++;
  return erg;
}

/** Eine Suchauswahl (SearchSelect): den Auslöser mit diesem Platzhalter öffnen, dann den Eintrag. */
async function ssPick(c, placeholder, optionId) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}
/** Die Mehrfachauswahl (SearchMultiSelect, ohne eigene Haken): öffnen, die Einträge nach Beschriftung anhaken, schließen. */
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
/** Eine Zeile der Transferliste (TransferTable) und darin der Knopf `data-transfer-<was>`. */
const inZeile = (c, nr, was) => c.ev(
  `const row=[...document.querySelectorAll('div')].find(d=>d.style&&d.style.gridTemplateColumns&&d.style.cursor==='pointer'&&d.textContent.includes(${S(nr)}));`
  + `if(!row) return 'KEINE-ZEILE:'+${S(nr)}; const el=row.querySelector('[data-transfer-'+${S(was)}+']');`
  + `if(!el) return 'KEIN-ELEMENT:'+${S(was)}; if (el.disabled) return 'DISABLED'; el.click(); return 'OK';`);
/** „Create Return" am Primary: die (einzige) Zeile anhaken, Bar, zurück ins Lager, Erstattung später. */
async function retoureMaske(c) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Create Return'))", 45000))) return 'KEIN-KNOPF';
  const r = [await clickIncludes(c, 'Create Return')];
  if (!(await warteBis(c, q('[data-return-save]'), 15000))) return 'KEINE-MASKE';
  r.push(await c.ev("const h=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()==='UNIT PRICE (incl. VAT)'); if(!h) return 'NO-HEAD';"
    + " const cb=h.parentElement.parentElement.querySelector('input[type=checkbox]:not([disabled])'); if(!cb) return 'NO-BOX'; cb.click(); return 'OK';"));
  await sleep(250);
  r.push(await clickText(c, 'Cash'));
  r.push(await clickText(c, 'Back to Stock'));
  r.push(await c.ev(`const t=[...document.querySelectorAll('span')].filter(x=>x.textContent.trim()==='STAFF').pop(); const s=t&&t.parentElement.querySelector('select'); if(!s) return 'NO-STAFF';`
    + " Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ''); s.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';"));
  r.push(await clickText(c, 'Refund later (Status: Pending)'));
  await sleep(300);
  return alleOk(r);
}

// ── Stände für den Vergleich ─────────────────────────────────────────────────
const artikelStand = (ids) => dbQ(BIZ_DB, `SELECT id, stock_status, quantity, last_offer_price FROM products WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids);
const loseStand = (ids) => dbQ(BIZ_DB, `SELECT product_id, qty_remaining, status FROM stock_lots WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY product_id`, ids);
const angebotStand = (id, x) => ({
  o: zeile('offers', id),
  l: dbQ(BIZ_DB, 'SELECT * FROM offer_lines WHERE offer_id = ?', [id]),
  t: dbQ(BIZ_DB, 'SELECT title, type, priority, status, auto_generated, linked_entity_type FROM tasks WHERE linked_entity_id = ?', [id]),
  a: artikelStand(['pa', 'pb', 'pc', 'pd'].map((k) => PROD(k, x))),
});
const rechnungStand = (id) => ({
  inv: zeile('invoices', id),
  lines: dbQ(BIZ_DB, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', [id]),
  pays: dbQ(BIZ_DB, 'SELECT * FROM payments WHERE invoice_id = ?', [id]),
});
const mitArtikel = (k) => `id IN (SELECT invoice_id FROM invoice_lines WHERE product_id = ?)`;
const endziffern = (nr) => Number(String(nr || '').match(/(\d+)$/)?.[1] ?? NaN);
const OFFER = {}, OFFER2 = {}, INV_OFFER = {}, INV_N = {}, INV_S = {}, INV_T = {}, RET = {}, TRF_INV = {};
let PRIMARY_USER = '';
const absenderVon = (cmdId) => String(dbQ(BIZ_DB, 'SELECT user_id FROM remote_command_ledger WHERE command_id = ?', [cmdId])[0]?.user_id || '');

// ── Angebot anlegen (Liste → „New Offer") ────────────────────────────────────
const angebotFuellen = (keys, preise, notes, gueltig) => async (c, x) => {
  const r = [await klick(c, '[data-offer-new]')];
  if (!(await warteBis(c, q('[data-offer-create-save]'), 10000))) return 'KEINE-MASKE';
  await sleep(300);
  r.push(await ssPick(c, 'Search clients by name, company, phone...', KUNDE(x)));
  r.push(await mehrfachWahl(c, 'Search products by brand, name, SKU...', keys.map((k) => LABEL(k, x))));
  for (const [k, preis] of Object.entries(preise)) {
    if (!(await warteBis(c, q(`[data-offer-new-price="${PROD(k, x)}"]`), 8000))) { r.push('KEIN-PREIS:' + k); continue; }
    r.push(await setVal(c, `[data-offer-new-price="${PROD(k, x)}"]`, String(preis)));
  }
  r.push(await setVal(c, '[data-offer-new-valid-until]', gueltig));
  r.push(await setVal(c, '[data-offer-new-notes]', notes));
  await sleep(300);
  return alleOk(r);
};

try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R6E Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R6E Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R6E Admin');
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
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

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
  PRIMARY_USER = String(await primary.ev('try { return JSON.parse(localStorage.getItem("lataif_session") || "{}").userId || ""; } catch (e) { return ""; }') || '');
  ok(!!PRIMARY_USER, `SETUP die Sitzung des Primary nennt ihren Benutzer (${PRIMARY_USER})`);
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
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await click(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  ok(true, 'CONNECT frischer Rechner ohne Datenbank, Anmeldung als Owner — dann die normale Anwendung');
  await beobachterLegen();

  // Die ALTE Geschäftsdatei im Datenordner von PC2 — sie darf in keinem Schritt angefasst werden.
  await spuelen(primary);
  mkdirSync(CLIENT_DATA_DIR, { recursive: true });
  const STALE = join(CLIENT_DATA_DIR, 'lataif.db');
  copyFileSync(BIZ_DB, STALE);
  const staleVorher = sha(STALE);
  const dateienVorher = readdirSync(CLIENT_DATA_DIR).sort();
  const LEDGER_BASIS = ledgerMax();

  // ══════════════════════════════════════════════════════════════════════
  // OFFERS — anlegen (verlorene Antwort), bearbeiten, senden, annehmen, Rechnung (verlorene Antwort)
  // ══════════════════════════════════════════════════════════════════════
  const erstellt = await paar({
    name: 'OFFER-CREATE', op: 'offers.create', lost: '[data-save-error]',
    route: () => '/offers',
    bereit: () => q('[data-offer-new]'),
    vorher: () => ({ ids: idSet('offers') }),
    fuellen: angebotFuellen(['pa', 'pb'], { pa: 950 }, 'R6E Angebot', tag(14)),
    speichern: (c) => klick(c, '[data-offer-create-save]'),
    fertig: (x, v) => neueZeilen('offers', v.ids, 'customer_id = ?', [KUNDE(x)]).length === 1,
    zu: () => `!${q('[data-offer-create-save]')}`,
    keys: ['customerId', 'lines', 'notes', 'validUntil'],
    rumpf: (p) => p.customerId === KUNDE('C') && p.notes === 'R6E Angebot' && p.validUntil === tag(14)
      && S((p.lines || []).map((l) => [l.productId, l.unitPrice]).sort()) === S([[PROD('pa', 'C'), 950], [PROD('pb', 'C'), 1000]]),
    zustand: (x, v) => { const o = neueZeilen('offers', v.ids, 'customer_id = ?', [KUNDE(x)]); OFFER[x] = o[0]?.id; return angebotStand(OFFER[x], x); },
    buchungsZeilen: 0,
  });
  {
    const oC = zeile('offers', OFFER.C), oP = zeile('offers', OFFER.P);
    const absC = absenderVon(erstellt.C.cmds[0]?.commandId);
    ok(!!absC && oC.created_by === absC && oP.created_by === PRIMARY_USER,
      `OFFER-CREATE Akteur: PC2-Angebot nennt den geprüften Absender, das des Primary seine Sitzung (${oC.created_by}/${absC} · ${oP.created_by}/${PRIMARY_USER})`);
    ok(artikelStand([PROD('pa', 'C'), PROD('pb', 'C')]).every((a) => a.stock_status === 'offered'), 'OFFER-CREATE die Stücke stehen als „offered"');
    EXTRA.akteur = !!absC && oC.created_by === absC && oP.created_by === PRIMARY_USER;
  }

  await paar({
    name: 'OFFER-EDIT', op: 'offers.update',
    route: (x) => `/offers/${OFFER[x]}`,
    bereit: () => q('[data-offer-edit]'),
    vorher: (x) => ({ rev: Number(zeile('offers', OFFER[x]).revision), la: dbQ(BIZ_DB, 'SELECT id FROM offer_lines WHERE offer_id = ? AND product_id = ?', [OFFER[x], PROD('pa', x)])[0]?.id }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-offer-edit]')];
      if (!(await warteBis(c, q('[data-offer-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setVal(c, '[data-offer-notes]', 'R6E geaendert'));
      r.push(await setVal(c, '[data-offer-valid-until]', tag(21)));
      r.push(await klick(c, '[data-offer-line-add]'));
      if (!(await warteBis(c, q(`[data-offer-add-product="${PROD('pc', x)}"]`), 10000))) return 'KEIN-ARTIKEL-ZUM-HINZUFUEGEN';
      r.push(await klick(c, `[data-offer-add-product="${PROD('pc', x)}"]`));
      await sleep(300);
      r.push(await setVal(c, `[data-offer-line-price="${PROD('pa', x)}"]`, '900'));
      r.push(await klick(c, `[data-offer-line-remove="${PROD('pb', x)}"]`));
      await sleep(300);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-offer-save]'),
    fertig: (x, v) => Number(zeile('offers', OFFER[x]).revision) > v.rev
      && S(dbQ(BIZ_DB, 'SELECT product_id FROM offer_lines WHERE offer_id = ? ORDER BY product_id', [OFFER[x]]).map((l) => l.product_id)) === S([PROD('pa', x), PROD('pc', x)]),
    zu: () => `!${q('[data-offer-save]')}`,
    keys: ['expectedRevision', 'lines', 'notes', 'offerId', 'validUntil'],
    rumpf: (p, x, v) => p.offerId === OFFER.C && p.expectedRevision === v.rev && p.notes === 'R6E geaendert' && p.validUntil === tag(21)
      && nz(p.lines) === nz([{ productId: PROD('pa', 'C'), unitPrice: 900 }, { productId: PROD('pc', 'C'), unitPrice: 1000 }])
      && (p.lines || []).find((l) => l.productId === PROD('pa', 'C'))?.id === v.la && !('id' in ((p.lines || []).find((l) => l.productId === PROD('pc', 'C')) || { id: 1 })),
    zustand: (x) => angebotStand(OFFER[x], x),
    buchungsZeilen: 0,
  });
  ok(artikelStand([PROD('pb', 'C'), PROD('pb', 'P')]).every((a) => a.stock_status === 'in_stock')
    && artikelStand([PROD('pc', 'C'), PROD('pc', 'P')]).every((a) => a.stock_status === 'offered'),
  'OFFER-EDIT die entfernte Position gibt ihr Stück frei, die neue bindet ihres');

  await paar({
    name: 'OFFER-SEND', op: 'offers.set_status',
    route: (x) => `/offers/${OFFER[x]}`,
    bereit: () => q('[data-offer-send]'),
    vorher: (x) => ({ rev: Number(zeile('offers', OFFER[x]).revision) }),
    fuellen: async () => 'OK',
    speichern: (c) => klick(c, '[data-offer-send]'),
    fertig: (x) => zeile('offers', OFFER[x]).status === 'sent',
    zu: () => q('[data-offer-accept]'),
    keys: ['expectedRevision', 'offerId', 'status'],
    rumpf: (p, x, v) => p.offerId === OFFER.C && p.status === 'sent' && p.expectedRevision === v.rev,
    zustand: (x) => angebotStand(OFFER[x], x),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'OFFER-ACCEPT', op: 'offers.set_status',
    route: (x) => `/offers/${OFFER[x]}`,
    bereit: () => q('[data-offer-accept]'),
    vorher: (x) => ({ rev: Number(zeile('offers', OFFER[x]).revision) }),
    fuellen: async () => 'OK',
    speichern: (c) => klick(c, '[data-offer-accept]'),
    fertig: (x) => zeile('offers', OFFER[x]).status === 'accepted',
    zu: () => q('[data-offer-create-invoice]'),
    keys: ['expectedRevision', 'offerId', 'status'],
    rumpf: (p, x, v) => p.offerId === OFFER.C && p.status === 'accepted' && p.expectedRevision === v.rev,
    zustand: (x) => angebotStand(OFFER[x], x),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'OFFER-CONVERT', op: 'offers.convert_to_invoice', lost: '[data-save-error]',
    route: (x) => `/offers/${OFFER[x]}`,
    bereit: () => q('[data-offer-create-invoice]'),
    vorher: (x) => ({ iids: idSet('invoices'), rev: Number(zeile('offers', OFFER[x]).revision) }),
    fuellen: async () => 'OK',
    speichern: async (c) => {
      const a = await klick(c, '[data-offer-create-invoice]');
      if (a !== 'OK') return a;
      // Der Schema-Dialog (ConfirmTaxSchemeModal, ohne Haken): sein „Create Invoice" — nicht der Seitenknopf.
      const modal = "[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Create Invoice' && !b.hasAttribute('data-offer-create-invoice')).pop()";
      if (!(await warteBis(c, modal, 10000))) return 'KEIN-SCHEMA-DIALOG';
      await sleep(250);
      await c.ev(`${modal}.click(); return 1;`);
      return nummerWahl(c, false);
    },
    fertig: (x, v) => neueZeilen('invoices', v.iids, 'offer_id = ?', [OFFER[x]]).length === 1,
    zu: () => '/^\\/invoices\\/[^/]+$/.test(location.pathname)',
    keys: ['expectedRevision', 'offerId', 'perLineSchemes', 'specialMark'],
    rumpf: (p, x, v) => p.offerId === OFFER.C && p.expectedRevision === v.rev && p.specialMark === false
      && Object.keys(p.perLineSchemes || {}).length === 2 && Object.values(p.perLineSchemes || {}).every((s) => s === 'VAT_10'),
    zustand: (x, v) => {
      const inv = neueZeilen('invoices', v.iids, 'offer_id = ?', [OFFER[x]]);
      INV_OFFER[x] = inv[0]?.id;
      return { r: rechnungStand(INV_OFFER[x]), o: zeile('offers', OFFER[x]), a: artikelStand([PROD('pa', x), PROD('pc', x)]), lose: loseStand([PROD('pa', x), PROD('pc', x)]) };
    },
  });
  ok(['C', 'P'].every((x) => /^PINV-/.test(String(zeile('invoices', INV_OFFER[x]).invoice_number)) && zeile('invoices', INV_OFFER[x]).status === 'PARTIAL'),
    `OFFER-CONVERT je eine offene Teilrechnung (PINV) — ${zeile('invoices', INV_OFFER.C).invoice_number} / ${zeile('invoices', INV_OFFER.P).invoice_number}`);

  // Das zweite Angebot: über die Zeilenknöpfe der Liste senden und ablehnen.
  await paar({
    name: 'OFFER2-CREATE', op: 'offers.create',
    route: () => '/offers',
    bereit: () => q('[data-offer-new]'),
    vorher: () => ({ ids: idSet('offers') }),
    fuellen: angebotFuellen(['pd'], {}, 'R6E zweites', tag(10)),
    speichern: (c) => klick(c, '[data-offer-create-save]'),
    fertig: (x, v) => neueZeilen('offers', v.ids, 'customer_id = ?', [KUNDE(x)]).length === 1,
    zu: () => `!${q('[data-offer-create-save]')}`,
    keys: ['customerId', 'lines', 'notes', 'validUntil'],
    rumpf: (p) => p.customerId === KUNDE('C') && S(p.lines) === S([{ productId: PROD('pd', 'C'), unitPrice: 1000 }]),
    zustand: (x, v) => { const o = neueZeilen('offers', v.ids, 'customer_id = ?', [KUNDE(x)]); OFFER2[x] = o[0]?.id; return angebotStand(OFFER2[x], x); },
    buchungsZeilen: 0,
  });
  await paar({
    name: 'OFFER2-SEND (Liste)', op: 'offers.set_status',
    route: () => '/offers',
    bereit: (x) => q(`[data-offer-row-send="${OFFER2[x]}"]`),
    vorher: (x) => ({ rev: Number(zeile('offers', OFFER2[x]).revision) }),
    fuellen: async () => 'OK',
    speichern: (c, x) => klick(c, `[data-offer-row-send="${OFFER2[x]}"]`),
    fertig: (x) => zeile('offers', OFFER2[x]).status === 'sent',
    zu: (x) => q(`[data-offer-row-reject="${OFFER2[x]}"]`),
    keys: ['expectedRevision', 'offerId', 'status'],
    rumpf: (p, x, v) => p.offerId === OFFER2.C && p.status === 'sent' && p.expectedRevision === v.rev,
    zustand: (x) => angebotStand(OFFER2[x], x),
    buchungsZeilen: 0,
  });
  await paar({
    name: 'OFFER2-REJECT (Liste)', op: 'offers.set_status',
    route: () => '/offers',
    bereit: (x) => q(`[data-offer-row-reject="${OFFER2[x]}"]`),
    vorher: (x) => ({ rev: Number(zeile('offers', OFFER2[x]).revision) }),
    fuellen: async () => 'OK',
    speichern: (c, x) => klick(c, `[data-offer-row-reject="${OFFER2[x]}"]`),
    fertig: (x) => zeile('offers', OFFER2[x]).status === 'rejected',
    zu: (x) => `!${q(`[data-offer-row-reject="${OFFER2[x]}"]`)}`,
    keys: ['expectedRevision', 'offerId', 'status'],
    rumpf: (p, x, v) => p.offerId === OFFER2.C && p.status === 'rejected' && p.expectedRevision === v.rev,
    zustand: (x) => angebotStand(OFFER2[x], x),
    buchungsZeilen: 0,
  });
  ok(artikelStand([PROD('pd', 'C'), PROD('pd', 'P')]).every((a) => a.stock_status === 'in_stock'), 'OFFER2-REJECT das Stück ist wieder frei');

  // STALE — PC2 hält ein Angebot im Bearbeiten, der Primary ändert dasselbe, PC2 speichert.
  {
    await syncRuhe();
    client = await lade(client, '/offers');
    await warteBis(client, q('[data-offer-new]'), 30000);
    const ids0 = idSet('offers');
    const m0 = await angebotFuellen(['pg'], {}, 'R6E drittes', tag(7))(client, 'C');
    const s0 = await klick(client, '[data-offer-create-save]');
    ok(m0 === 'OK' && s0 === 'OK' && await warteAuf(() => neueZeilen('offers', ids0, 'customer_id = ?', [KUNDE('C')]).length === 1), `STALE ein drittes Angebot für PC2 (${m0}/${s0})`);
    const O3 = neueZeilen('offers', ids0, 'customer_id = ?', [KUNDE('C')])[0]?.id;
    await syncRuhe();
    client = await lade(client, `/offers/${O3}`);
    await warteBis(client, q('[data-offer-edit]'), 30000);
    const r1 = [await klick(client, '[data-offer-edit]')];
    await warteBis(client, q('[data-offer-save]'), 10000);
    r1.push(await setVal(client, '[data-offer-notes]', 'R6E Stand PC2'));
    ok(alleOk(r1) === 'OK', `STALE PC2 hat das Angebot im Bearbeiten (${alleOk(r1)})`);
    const rev0 = Number(zeile('offers', O3).revision);
    await gehFrisch(primary, `/offers/${O3}`);
    await warteBis(primary, q('[data-offer-edit]'), 30000);
    const r2 = [await klick(primary, '[data-offer-edit]')];
    await warteBis(primary, q('[data-offer-save]'), 10000);
    r2.push(await setVal(primary, '[data-offer-notes]', 'R6E Stand Primary'));
    r2.push(await klick(primary, '[data-offer-save]'));
    ok(alleOk(r2) === 'OK' && await warteAuf(() => Number(zeile('offers', O3).revision) > rev0 && zeile('offers', O3).notes === 'R6E Stand Primary'),
      `STALE der Primary ändert dasselbe Angebot (Fassung ${rev0} → ${zeile('offers', O3).revision})`);
    const rev1 = Number(zeile('offers', O3).revision);
    const linien = S(dbQ(BIZ_DB, 'SELECT product_id, unit_price FROM offer_lines WHERE offer_id = ?', [O3]));
    const vorC = (await buchungen(client)).length;
    const vorA = (await antworten(client)).length;
    const s3 = await klick(client, '[data-offer-save]');
    ok(s3 === 'OK', `STALE PC2 speichert mit der alten Fassung (${s3})`);
    const nein = await warteBis(client, "[...document.querySelectorAll('[data-save-error]')].some((e) => /changed since you opened it/.test(e.textContent))", 20000);
    ok(nein, `STALE PC2: klares Nein in der Maske — nicht blind überschrieben (${String(await fehlerText(client)).slice(0, 200)})`);
    const cc = (await buchungen(client)).slice(vorC);
    const an = (await antworten(client)).slice(vorA);
    ok(cc.length === 1 && cc[0].op === 'offers.update' && cc[0].payload.expectedRevision === rev0, `STALE der Auftrag nannte die gesehene (alte) Fassung ${rev0} (${cc.map((k) => S(k.payload)).join(',')})`);
    ok(an.length === 1 && an[0].ok === false && an[0].error === 'RECORD_CHANGED', `STALE die Antwort ist RECORD_CHANGED (${S(an)})`);
    await sleep(800); await spuelen(primary);
    const o3 = zeile('offers', O3);
    const nichts = Number(o3.revision) === rev1 && o3.notes === 'R6E Stand Primary' && S(dbQ(BIZ_DB, 'SELECT product_id, unit_price FROM offer_lines WHERE offer_id = ?', [O3])) === linien;
    ok(nichts, `STALE nichts geschrieben — Fassung ${o3.revision}, Notiz des Primary, Positionen unverändert`);
    ok(await exists(client, '[data-offer-save]'), 'STALE der Entwurf auf PC2 bleibt offen (nichts geht verloren)');
    EXTRA.stale = nein && cc.length === 1 && an[0]?.error === 'RECORD_CHANGED' && nichts;
  }
  console.log('CENTRAL_UI_R6E_OFFERS_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // INVOICE — Anlegen mit Zahlung (normal, Sonder, Teil), Endzahlung (Liste: Sonder, Seite: normal), Butterfly
  // ══════════════════════════════════════════════════════════════════════
  const rechnungFuellen = (k, methode, betrag) => async (c, x) => {
    const r = [await ssPick(c, 'Search clients...', KUNDE(x))];
    r.push(await ssPick(c, 'Pick product...', PROD(k, x)));
    if (!(await warteBis(c, "document.body.innerText.includes('Lot ·')", 15000))) return 'KEIN-LOS';
    r.push(await klick(c, `[data-invoice-pay-method="${methode}"]`));
    if (betrag === 'voll') r.push(await klick(c, '[data-invoice-pay-full]'));
    else r.push(await setVal(c, '[data-invoice-pay-amount]', String(betrag)));
    await sleep(400);
    return alleOk(r);
  };
  const rechnungNeu = (name, k, methode, betrag, sonder, extra = {}) => ({
    name, op: 'invoices.create',
    route: () => '/invoices/new',
    bereit: () => q('[data-ss-trigger="Search clients..."]'),
    vorher: () => ({ iids: idSet('invoices') }),
    fuellen: rechnungFuellen(k, methode, betrag),
    speichern: async (c) => {
      const a = await klick(c, '[data-invoice-save]');
      if (a !== 'OK' || betrag !== 'voll') return a;
      return nummerWahl(c, sonder);
    },
    fertig: (x, v) => neueZeilen('invoices', v.iids, mitArtikel(k), [PROD(k, x)]).length === 1,
    zu: () => '/^\\/invoices\\/[^/]+$/.test(location.pathname) && !/\\/new$/.test(location.pathname)',
    keys: ['customerId', 'issuedDate', 'lines', 'payment', 'specialMark'],
    rumpf: (p) => p.customerId === KUNDE('C') && p.issuedDate === HEUTE && p.specialMark === sonder
      && S(p.payment) === S({ amount: betrag === 'voll' ? 1100 : betrag, method: methode })
      && S(p.lines) === S([{ productId: PROD(k, 'C'), lotId: PROD(k, 'C') + '-lot', quantity: 1, unitPrice: 1000, scheme: 'auto' }]),
    zustand: (x, v) => {
      const inv = neueZeilen('invoices', v.iids, mitArtikel(k), [PROD(k, x)]);
      return { r: rechnungStand(inv[0]?.id), a: artikelStand([PROD(k, x)]), lose: loseStand([PROD(k, x)]) };
    },
    merke: (x, v) => neueZeilen('invoices', v.iids, mitArtikel(k), [PROD(k, x)])[0]?.id,
    ...extra,
  });
  const merken = (erg, ziel, def) => { for (const x of ['C', 'P']) ziel[x] = def.merke(x, erg[x].v); };
  {
    const d = rechnungNeu('INV-CREATE-NORMAL', 'pe', 'cash', 'voll', false, { lost: '[data-save-error]' });
    merken(await paar(d), INV_N, d);
  }
  {
    const d = rechnungNeu('INV-CREATE-SPECIAL', 'pf', 'bank_transfer', 'voll', true);
    merken(await paar(d), INV_S, d);
  }
  {
    const d = rechnungNeu('INV-CREATE-PARTIAL', 'ph', 'cash', 300, false);
    merken(await paar(d), INV_T, d);
  }
  ok(['C', 'P'].every((x) => /^INV-/.test(String(zeile('invoices', INV_N[x]).invoice_number)) && zeile('invoices', INV_N[x]).status === 'FINAL' && Number(zeile('invoices', INV_N[x]).special_mark) === 0),
    `INV-CREATE-NORMAL Vollzahlung → Endnummer im normalen Kreis (${zeile('invoices', INV_N.C).invoice_number} / ${zeile('invoices', INV_N.P).invoice_number})`);
  ok(['C', 'P'].every((x) => /^SINV-/.test(String(zeile('invoices', INV_S[x]).invoice_number)) && zeile('invoices', INV_S[x]).status === 'FINAL' && Number(zeile('invoices', INV_S[x]).special_mark) === 1),
    `INV-CREATE-SPECIAL Vollzahlung + Sonder → SINV (${zeile('invoices', INV_S.C).invoice_number} / ${zeile('invoices', INV_S.P).invoice_number})`);
  ok(['C', 'P'].every((x) => /^PINV-/.test(String(zeile('invoices', INV_T[x]).invoice_number)) && zeile('invoices', INV_T[x]).status === 'PARTIAL'),
    `INV-CREATE-PARTIAL Teilzahlung → PINV, kein Nummerndialog (${zeile('invoices', INV_T.C).invoice_number} / ${zeile('invoices', INV_T.P).invoice_number})`);

  await paar({
    name: 'PAY-FINAL-SPECIAL (Liste)', op: 'invoices.record_payment',
    route: () => '/invoices',
    bereit: (x) => q(`[data-pay-invoice="${INV_T[x]}"]`),
    vorher: (x) => ({ rest: Math.round((Number(zeile('invoices', INV_T[x]).gross_amount) - Number(zeile('invoices', INV_T[x]).paid_amount)) * 1000) / 1000 }),
    fuellen: async (c, x, v) => {
      const r = [await klick(c, `[data-pay-invoice="${INV_T[x]}"]`)];
      if (!(await warteBis(c, q('[data-invoice-list-pay]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setVal(c, '[data-invoice-list-pay-amount]', String(v.rest)));
      r.push(await klick(c, '[data-invoice-list-pay-method="bank_transfer"]'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: async (c) => {
      const a = await klick(c, '[data-invoice-list-pay]');
      if (a !== 'OK') return a;
      return nummerWahl(c, true);
    },
    fertig: (x) => zeile('invoices', INV_T[x]).status === 'FINAL',
    zu: () => `!${q('[data-invoice-list-pay]')}`,
    keys: ['amount', 'invoiceId', 'method', 'specialMarkOnFinal'],
    rumpf: (p, x, v) => p.invoiceId === INV_T.C && p.amount === v.rest && p.method === 'bank_transfer' && p.specialMarkOnFinal === true,
    zustand: (x) => ({ r: rechnungStand(INV_T[x]), a: artikelStand([PROD('ph', x)]) }),
  });

  await paar({
    name: 'PAY-FINAL-NORMAL (Rechnungsseite)', op: 'invoices.record_payment',
    route: (x) => `/invoices/${INV_OFFER[x]}`,
    bereit: () => knopfDa('Record Payment'),
    vorher: (x) => ({ rest: Math.round((Number(zeile('invoices', INV_OFFER[x]).gross_amount) - Number(zeile('invoices', INV_OFFER[x]).paid_amount)) * 1000) / 1000 }),
    fuellen: async (c, x, v) => {
      const r = [await clickText(c, 'Record Payment')];
      if (!(await warteBis(c, q('[data-record-payment]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setByLabel(c, 'AMOUNT (BHD)', String(v.rest)));
      r.push(await clickText(c, 'Cash'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: async (c) => {
      const a = await klick(c, '[data-record-payment]');
      if (a !== 'OK') return a;
      return nummerWahl(c, false);
    },
    fertig: (x) => zeile('invoices', INV_OFFER[x]).status === 'FINAL',
    zu: () => `!${q('[data-record-payment]')}`,
    keys: ['amount', 'invoiceId', 'method', 'specialMarkOnFinal'],
    rumpf: (p, x, v) => p.invoiceId === INV_OFFER.C && p.amount === v.rest && p.method === 'cash' && p.specialMarkOnFinal === false,
    zustand: (x) => ({ r: rechnungStand(INV_OFFER[x]), a: artikelStand([PROD('pa', x), PROD('pc', x)]) }),
  });
  {
    const tT = ['C', 'P'].map((x) => zeile('invoices', INV_T[x])), tO = ['C', 'P'].map((x) => zeile('invoices', INV_OFFER[x]));
    ok(tT.every((i) => /^SINV-/.test(String(i.invoice_number)) && Number(i.special_mark) === 1),
      `PAY-FINAL-SPECIAL die Endzahlung mit Sonderwahl zieht aus dem SINV-Kreis (${tT.map((i) => i.invoice_number).join(' / ')})`);
    ok(tO.every((i) => /^INV-/.test(String(i.invoice_number)) && Number(i.special_mark) === 0),
      `PAY-FINAL-NORMAL die Endzahlung normal zieht aus dem INV-Kreis (${tO.map((i) => i.invoice_number).join(' / ')})`);
    // Die Kreise: in der Reihenfolge der Handlungen lückenlos, keiner fasst den anderen an.
    const sinv = [INV_S.C, INV_S.P, INV_T.C, INV_T.P].map((id) => endziffern(zeile('invoices', id).invoice_number));
    const inv = [INV_N.C, INV_N.P, INV_OFFER.C, INV_OFFER.P].map((id) => endziffern(zeile('invoices', id).invoice_number));
    const lueckenlos = (a) => a.every((n, i) => Number.isFinite(n) && (i === 0 || n === a[i - 1] + 1));
    ok(lueckenlos(sinv), `SINV-Kreis lückenlos über beide Rechner (${sinv.join(',')})`);
    ok(lueckenlos(inv), `INV-Kreis lückenlos über beide Rechner — die verlorene Antwort hat keine Nummer verbraucht (${inv.join(',')})`);
    EXTRA.sinv = lueckenlos(sinv) && lueckenlos(inv) && tT.every((i) => /^SINV-/.test(String(i.invoice_number)));
  }

  for (const [name, von, nach] of [['BUTTERFLY-ON', 'off', 'on'], ['BUTTERFLY-OFF', 'on', 'off']]) {
    await paar({
      name, op: 'invoices.set_butterfly',
      route: (x) => `/invoices/${INV_S[x]}`,
      bereit: () => q(`[data-invoice-butterfly="${von}"]`),
      vorher: (x) => ({ rev: Number(zeile('invoices', INV_S[x]).revision) }),
      fuellen: async () => 'OK',
      speichern: (c) => klick(c, '[data-invoice-butterfly]'),
      fertig: (x) => Number(zeile('invoices', INV_S[x]).butterfly) === (nach === 'on' ? 1 : 0),
      zu: () => q(`[data-invoice-butterfly="${nach}"]`),
      keys: ['butterfly', 'expectedRevision', 'invoiceId'],
      rumpf: (p, x, v) => p.invoiceId === INV_S.C && p.butterfly === (nach === 'on') && p.expectedRevision === v.rev,
      zustand: (x) => zeile('invoices', INV_S[x]),
      buchungsZeilen: 0,
    });
  }
  EXTRA.butterfly = ['C', 'P'].every((x) => Number(zeile('invoices', INV_S[x]).butterfly) === 0);
  console.log('CENTRAL_UI_R6E_INVOICE_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // REVERSAL — Retoure stornieren (Owner), Umwandlung eines Transfers zurücknehmen
  // ══════════════════════════════════════════════════════════════════════
  // Vorbereitung am Primary (vorhandene, schon geprüfte Masken): je Zwilling eine Retoure auf die
  // voll bezahlte Rechnung; je Zwilling der Agenten-Transfer „sold" und in eine Rechnung umgewandelt.
  for (const x of ['C', 'P']) {
    await syncRuhe();
    const vorR = idSet('sales_returns');
    await gehFrisch(primary, `/invoices/${INV_N[x]}`);
    const m = await retoureMaske(primary);
    const s = m === 'OK' ? await klick(primary, '[data-return-save]') : 'NICHT-GEFUELLT';
    ok(m === 'OK' && s === 'OK' && await warteAuf(() => neueZeilen('sales_returns', vorR, 'invoice_id = ?', [INV_N[x]]).length === 1),
      `VORBEREITUNG Retoure auf ${x === 'C' ? 'die PC2-Rechnung' : 'die Primary-Rechnung'} am Primary (${m}/${s}; ${String(await fehlerText(primary)).slice(0, 160)})`);
    RET[x] = neueZeilen('sales_returns', vorR, 'invoice_id = ?', [INV_N[x]])[0]?.id;
  }
  for (const x of ['C', 'P']) {
    await syncRuhe();
    await gehFrisch(primary, '/agents');
    const liste = await warteBis(primary, knopfDa('Transfers'), 40000);
    if (liste) await clickText(primary, 'Transfers');
    ok(liste && await warteBis(primary, `document.body.innerText.includes(${S(TRF_NR(x))})`, 30000), `VORBEREITUNG die Transferliste am Primary zeigt ${TRF_NR(x)}`);
    const r = [await inZeile(primary, TRF_NR(x), 'sold')];
    if (await warteBis(primary, q('[data-transfer-sold-confirm]'), 10000)) r.push(await klick(primary, '[data-transfer-sold-confirm]')); else r.push('KEIN-VERKAUF-DIALOG');
    const verkauft = await warteAuf(() => zeile('agent_transfers', TRF(x)).status === 'sold');
    ok(alleOk(r) === 'OK' && verkauft, `VORBEREITUNG Transfer ${TRF_NR(x)} „sold" (${alleOk(r)})`);
    await warteBis(primary, `document.body.innerText.includes(${S(TRF_NR(x))})`, 20000);
    const r2 = [await inZeile(primary, TRF_NR(x), 'convert')];
    if (await warteBis(primary, q('[data-transfer-convert-confirm]'), 10000)) r2.push(await klick(primary, '[data-transfer-convert-confirm]')); else r2.push('KEIN-UMWANDLUNGS-DIALOG');
    const um = await warteAuf(() => !!zeile('agent_transfers', TRF(x)).invoice_id);
    TRF_INV[x] = zeile('agent_transfers', TRF(x)).invoice_id;
    ok(alleOk(r2) === 'OK' && um, `VORBEREITUNG Transfer ${TRF_NR(x)} in eine Rechnung umgewandelt (${alleOk(r2)}; ${TRF_INV[x]})`);
  }
  // Offene Verkaufsforderungen = Buchungs-TRANSAKTIONEN (eine hat vier Beine: Forderung/Erlös, Einsatz/Lager).
  const verkaufsforderung = (tid) => zahl("SELECT COUNT(DISTINCT le.transaction_id) AS n FROM ledger_entries le WHERE le.source_module = 'AGENT_TRANSFER_SOLD' AND le.source_id = ? AND le.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = le.id)", [tid]);
  ok(['C', 'P'].every((x) => verkaufsforderung(TRF(x)) === 0), 'VORBEREITUNG die Umwandlung hat die Verkaufsforderung ausgebucht (keine offene AGENT_TRANSFER_SOLD-Buchung)');

  const retoureWer = {};
  const storno = await paar({
    name: 'RETURN-CANCEL', op: 'returns.cancel', lost: '[data-save-error]',
    route: (x) => `/invoices/${INV_N[x]}`,
    bereit: () => q('[data-return-cancel-open]'),
    vorher: (x) => ({ rev: Number(zeile('sales_returns', RET[x]).revision), au: idSet('audit_log') }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-return-cancel-open]')];
      if (!(await warteBis(c, q('[data-return-cancel-reason]'), 10000))) return 'KEINE-MASKE';
      r.push(await setVal(c, '[data-return-cancel-reason]', 'R6E Kunde behaelt die Uhr'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-return-cancel-confirm]'),
    fertig: (x) => zeile('sales_returns', RET[x]).status === 'REJECTED',
    zu: () => `!${q('[data-return-cancel-confirm]')}`,
    keys: ['expectedRevision', 'reason', 'returnId'],
    rumpf: (p, x, v) => p.returnId === RET.C && p.expectedRevision === v.rev && p.reason === 'R6E Kunde behaelt die Uhr',
    zustand: (x, v) => {
      retoureWer[x] = neueZeilen('audit_log', v.au, "entity_id = ? AND field_name = 'cancel'", [RET[x]]);
      return {
        ret: zeile('sales_returns', RET[x]),
        rl: dbQ(BIZ_DB, 'SELECT * FROM sales_return_lines WHERE return_id = ?', [RET[x]]),
        r: rechnungStand(INV_N[x]),
        a: artikelStand([PROD('pe', x)]), lose: loseStand([PROD('pe', x)]),
        cn: dbQ(BIZ_DB, "SELECT * FROM credit_notes WHERE invoice_id = ?", [INV_N[x]]),
      };
    },
  });
  {
    const absC = absenderVon(storno.C.cmds[0]?.commandId);
    const aC = retoureWer.C || [], aP = retoureWer.P || [];
    ok(aC.length === 1 && aP.length === 1 && aC[0].changed_by === absC && aP[0].changed_by === PRIMARY_USER,
      `RETURN-CANCEL genau EIN Storno-Protokoll je Rechner, mit dem Handelnden (${aC.map((a) => a.changed_by).join(',')}/${absC} · ${aP.map((a) => a.changed_by).join(',')}/${PRIMARY_USER})`);
    ok(['C', 'P'].every((x) => zeile('sales_returns', RET[x]).status === 'REJECTED' && zeile('invoices', INV_N[x]).status === 'FINAL'),
      'RETURN-CANCEL die Retoure bleibt als REJECTED stehen (Geschichte), die Rechnung ist wieder FINAL');
    EXTRA.retoure = aC.length === 1 && aP.length === 1 && aC[0].changed_by === absC && aP[0].changed_by === PRIMARY_USER;
  }

  await paar({
    name: 'TRANSFER-UNDO', op: 'transfers.undo_convert', lost: '[data-save-error]',
    route: (x) => `/transfers/${TRF(x)}`,
    bereit: () => q('[data-transfer-undo]'),
    vorher: (x) => ({ rev: Number(zeile('agent_transfers', TRF(x)).revision), inv: zeile('agent_transfers', TRF(x)).invoice_id }),
    fuellen: async () => 'OK',
    speichern: (c) => klick(c, '[data-transfer-undo]'),
    fertig: (x, v) => !zeile('agent_transfers', TRF(x)).invoice_id && zeile('invoices', v.inv).status === 'CANCELLED',
    zu: () => `!${q('[data-transfer-undo]')}`,
    keys: ['expectedRevision', 'transferId'],
    rumpf: (p, x, v) => p.transferId === TRF('C') && p.expectedRevision === v.rev,
    zustand: (x, v) => ({
      t: zeile('agent_transfers', TRF(x)), r: rechnungStand(v.inv),
      a: artikelStand([TP(x)]), lose: loseStand([TP(x)]), forderung: verkaufsforderung(TRF(x)),
    }),
  });
  {
    const gut = ['C', 'P'].every((x) => {
      const t = zeile('agent_transfers', TRF(x)), i = zeile('invoices', TRF_INV[x]);
      return t.status === 'sold' && !t.invoice_id && i.id === TRF_INV[x] && i.status === 'CANCELLED' && verkaufsforderung(TRF(x)) === 1;
    });
    ok(gut, `TRANSFER-UNDO die Rechnung bleibt als CANCELLED stehen, der Transfer ist wieder „sold" ohne Rechnung, die Verkaufsforderung steht wieder (${['C', 'P'].map((x) => `${zeile('agent_transfers', TRF(x)).status}/${zeile('invoices', TRF_INV[x]).status}/${verkaufsforderung(TRF(x))}`).join(' · ')})`);
    EXTRA.undo = gut;
  }
  console.log('CENTRAL_UI_R6E_REVERSAL_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // MESSAGE — Nachricht aus der Vorschau (Kundenseite, „AI Message" → WhatsApp) → EIN Protokolleintrag
  // ══════════════════════════════════════════════════════════════════════
  {
    // Primary: die Seite beantwortet api.openai.com selbst; der Schlüssel über Einstellungen → AI.
    await primary.ev(KI_PRIMARY);
    // Frisch einsteigen: die Einstellungen lesen den Reiter nur beim Aufbau (syncRuhe stand auf „sync").
    await gehFrisch(primary, '/settings?tab=ai');
    if (!(await warteBis(primary, q('input[placeholder="sk-..."]'), 8000))) await clickText(primary, 'AI / OpenAI');
    const feld = await warteBis(primary, q('input[placeholder="sk-..."]'), 20000);
    await sleep(1200);
    const r = feld ? [await setVal(primary, 'input[placeholder="sk-..."]', KI_SCHLUESSEL)] : ['KEIN-FELD'];
    await sleep(200);
    r.push(await clickText(primary, 'Save'));
    ok(alleOk(r) === 'OK' && await warteBis(primary, "document.body.innerText.includes('AI settings saved.')", 10000), `MESSAGE Primary: KI-Schlüssel gesetzt (Einstellungen → AI) (${alleOk(r)})`);
    // PC2: der Schlüssel verschleiert im Seitenspeicher (keine Datei im Datenordner); die Seite lädt neu.
    await client.ev(`localStorage.setItem('lataif_openai_key', ${S(verschleiert(KI_SCHLUESSEL))}); return 1;`);
  }
  const nachricht = await paar({
    name: 'MESSAGE-LOG', op: 'customers.log_message',
    route: (x) => `/clients/${KUNDE(x)}`,
    bereit: () => "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('AI Message'))",
    vorher: (x) => ({ ids: idSet('customer_messages'), au: idSet('audit_log'), opens: 0 }),
    fuellen: async (c) => {
      const r = [await clickIncludes(c, 'AI Message')];
      // POST-PARITY R7B PP-3 — auf PC2 schreibt die KI keinen Text mehr (der Schlüssel bleibt am Primary,
      // ein eigener alter Schlüssel wird nie benutzt): die Maske sagt es, der Text wird von Hand gesetzt.
      if (c === client) {
        if (!(await warteBis(c, q('[data-ai-locked-note]'), 20000))) return 'KEIN-KI-HINWEIS';
        r.push(await setVal(c, 'textarea', KI_TEXT));
      }
      if (!(await warteBis(c, `[...document.querySelectorAll('textarea')].some((t) => t.value === ${S(KI_TEXT)})`, 20000))) return 'KEIN-TEXT:' + String(await c.ev("return document.body.innerText.slice(-300);")).replace(/\s+/g, ' ');
      if (!(await warteBis(c, `${q('[data-message-whatsapp]')} && !${q('[data-message-whatsapp]')}.disabled`, 10000))) return 'WHATSAPP-GESPERRT';
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-message-whatsapp]'),
    fertig: (x, v) => neueZeilen('customer_messages', v.ids, 'customer_id = ?', [KUNDE(x)]).length === 1,
    zu: () => q('[data-message-log-status="ok"]'),
    keys: ['body', 'channel', 'customerId', 'kind'],
    rumpf: (p) => p.customerId === KUNDE('C') && p.channel === 'whatsapp' && p.kind === 'follow_up' && p.body === KI_TEXT,
    zustand: (x, v) => ({
      m: neueZeilen('customer_messages', v.ids, 'customer_id = ?', [KUNDE(x)]),
      au: neueZeilen('audit_log', v.au, "entity_type = 'customer_messages'").map((a) => ({ action_type: a.action_type })),
    }),
    buchungsZeilen: 0,
  });
  {
    const absC = absenderVon(nachricht.C.cmds[0]?.commandId);
    const mC = dbQ(BIZ_DB, 'SELECT created_by, channel, body FROM customer_messages WHERE customer_id = ?', [KUNDE('C')]);
    const mP = dbQ(BIZ_DB, 'SELECT created_by, channel, body FROM customer_messages WHERE customer_id = ?', [KUNDE('P')]);
    ok(mC.length === 1 && mP.length === 1 && !!absC && mC[0].created_by === absC && mP[0].created_by === PRIMARY_USER,
      `MESSAGE genau EIN Eintrag je Kunde; created_by = der Handelnde (PC2 ${mC[0]?.created_by}/${absC} · Primary ${mP[0]?.created_by}/${PRIMARY_USER})`);
    const opensC = Number(await client.ev('return (window.__opens || []).length;')) || 0;
    const opensP = Number(await primary.ev('return (window.__opens || []).length;')) || 0;
    const kiP = Number(await primary.ev('return window.__aiCalls || 0;')) || 0;
    ok(opensC === 1 && opensP === 1, `MESSAGE WhatsApp wurde je Rechner genau einmal geöffnet (abgefangen, kein Fenster) (${opensC}/${opensP})`);
    ok(kiP >= 1 && Number(await client.ev('return window.__aiCalls || 0;')) === 0,
      'MESSAGE am Primary kam der Text aus der (abgefangenen) KI-Anfrage; auf PC2 gab es KEINE KI-Anfrage (R7B PP-3) — kein Aufruf ins Netz');
    EXTRA.nachricht = mC.length === 1 && mP.length === 1 && mC[0].created_by === absC && mP[0].created_by === PRIMARY_USER && opensC === 1 && opensP === 1;
    await client.ev("localStorage.removeItem('lataif_openai_key'); return 1;");
  }
  console.log('CENTRAL_UI_R6E_MESSAGE_RUNTIME_PROVED_CANDIDATE');

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
    ok(neu.length === 0 && !dateien.some((f) => /lataif_sync_server\.db|outbox|data-location|openai/i.test(f)), `LOKAL keine neue Datei, keine Konfig-DB, keine Warteschlange, kein Schlüssel als Datei (${dateien.join(', ')})`);
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
console.log('\n  Buchung                         PC2   Primary');
for (const o of OPS) console.log(`  ${o.padEnd(32)}${(BEWEIS[o].C > 0 ? 'ja' : 'NEIN').padEnd(6)}${BEWEIS[o].P > 0 ? 'ja' : 'NEIN'}`);
const alleBeide = (ops) => ops.every((o) => BEWEIS[o].C > 0 && BEWEIS[o].P > 0);
const LOST_OPS = ['offers.create', 'offers.convert_to_invoice', 'invoices.create', 'returns.cancel', 'transfers.undo_convert'];
console.log(`  verlorene Antwort: ${LOST_OPS.map((o) => `${o}=${LOST[o] ? 'ja' : 'NEIN'}`).join(' · ')}`);
console.log(`  Zusatz: ${Object.entries(EXTRA).map(([k, v]) => `${k}=${v ? 'ja' : 'NEIN'}`).join(' · ')}`);
ok(alleBeide(OPS), `ALLE ${OPS.length} Buchungen auf PC2 UND am Primary bewiesen (fehlend: ${OPS.filter((o) => !(BEWEIS[o].C > 0 && BEWEIS[o].P > 0)).join(', ') || 'keine'})`);
ok(LOST_OPS.every((o) => LOST[o]), 'LOST alle fünf verlorenen Antworten: dieselbe Kennung, genau eine Wirkung, dieselbe Buchung');
ok(Object.values(EXTRA).every(Boolean), `ZUSATZ Stale, Nummernkreise, Butterfly, Storno-Protokoll, Undo-Stand, Akteur, Nachricht (${Object.entries(EXTRA).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'alle'})`);
const dauer = Math.round((Date.now() - T0) / 1000);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r6e: offers + invoice + reversal + message, lost response, stale, two apps (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
if (alleBeide(OPS.filter((o) => o.startsWith('offers.'))) && EXTRA.stale && EXTRA.akteur) console.log('CENTRAL_UI_R6E_OFFERS_RUNTIME_PROVED');
if (alleBeide(['invoices.create', 'invoices.record_payment', 'invoices.set_butterfly']) && EXTRA.sinv && EXTRA.butterfly) console.log('CENTRAL_UI_R6E_INVOICE_RUNTIME_PROVED');
if (alleBeide(['returns.cancel', 'transfers.undo_convert']) && EXTRA.retoure && EXTRA.undo) console.log('CENTRAL_UI_R6E_REVERSAL_RUNTIME_PROVED');
if (alleBeide(['customers.log_message']) && EXTRA.nachricht) console.log('CENTRAL_UI_R6E_MESSAGE_RUNTIME_PROVED');
if (LOST_OPS.every((o) => LOST[o])) console.log('CENTRAL_UI_R6E_LOST_RESPONSE_PROVED');
console.log('CENTRAL_UI_R6E_TWO_APP_PROVED');
