// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — wer eine Buchung verantwortet: ZWEI echte Benutzer, zwei echte Anwendungen.
// Run: node test/e2e/r6e-actor-attribution.e2e.mjs
//
//   Der vorige Zwei-Rechner-Lauf (r6e-sales-offers-invoice) meldete PC2 und den Primary mit DEMSELBEN
//   Benutzer an — er konnte nicht zeigen, WEM eine Fernbuchung zugeschrieben wird. Hier:
//     • Benutzer A = die Anmeldung am Primary (der Owner aus dem Onboarding, `user-owner`);
//     • Benutzer B = ein ZWEITER echter Benutzer (eigene Kennung, eigene E-Mail, Owner-Rolle in
//       branch-main) — im Server-Konto (users + user_branches + server_credentials, dieselben Zeilen
//       wie beim Owner) und in der Geschäftsdatenbank (users + user_branches wie der Onboarding-Owner).
//       PC2 meldet sich über die normale Anmeldemaske als B an; der Primary bleibt als A angemeldet.
//
//   Jede Handlung läuft ZWEIMAL durch dieselbe Maske (Zwillingsdaten C/P): auf PC2 als B, am Primary
//   als A. Bewiesen wird in der Datenbank des Primary:
//     INVOICE   Rechnung mit Kartenzahlung (voll, Nummerndialog normal) — Rechnung, Zahlung,
//               automatische Kartengebühr (expenses), jede Hauptbuchzeile und das Protokoll gehören
//               dem Handelnden (PC2 → B, Primary → A); der Geschäftszustand beider Zwillinge ist gleich
//     PAYMENT   Teilzahlung über die Rechnungsliste auf eine offene Rechnung, die A am Primary angelegt
//               hat — die Rechnung bleibt A, Zahlung + Buchung gehören dem Zahlenden
//     RETURN    „Cancel Return" auf der Rechnungsseite, Retoure vorbereitet am Primary — Storno-Protokoll
//               und Gutschrift-Storno nennen den Handelnden; die Gutschrift bleibt STEHEN (CANCELLED mit
//               cancelled_at/cancelled_by/cancel_reason), sie wird nicht gelöscht
//     SPOOF     rohe Fernaufträge über die Brücke von PC2 mit eingeschleustem `createdBy`/`userId`
//               (auch in der Zahlung) → abgewiesen, nichts geschrieben, kein Nachweis „completed"
//     SESSION   der Primary zeigt danach weiterhin A als angemeldet; PC2 bleibt B
//     LEDGER    jede Buchungstransaktion dieses Laufs ist ausgeglichen
//     SAFETY    PC2 ohne Datenbank: alte lataif.db unberührt, kein eigener Kern, keine lokale Datei
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
// Der zweite echte Benutzer. Sein Server-Passwort ist ein echter bcrypt-Wert: der des Owners, kopiert
// (Node hat kein bcrypt; die Anmeldung prüft ihn mit dem echten `bcrypt::verify`). Kennung, E-Mail,
// Name und Rolle sind seine eigenen — der Ausweis trägt `sub = B`.
const B_ID = 'user-r6e-b';
const B_EMAIL = 'kollege.b@lataif.com';
const B_NAME = 'R6E Kollege B';

const RUN = join(os.tmpdir(), 'lataif-r6e-actor', 'run-' + Date.now());
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
}, 60 * 60 * 1000);

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

// Der Beobachter auf PC2: Fernaufträge, ihre Antworten, Datenbankgriffe, Kern-Aufrufe, Dialoge.
const BEOBACHTER = `
  if (window.__r6eInstalliert) { /* schon da */ } else {
  window.__r6eInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__invokes = []; window.__alerts = [];
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
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload }); } catch (e) { /* kein lesbarer Rumpf */ }
    }
    const r = await of(...a);
    if (body && body.op && !/\\.(get|list)$/.test(String(body.op))) {
      try {
        const j = await r.clone().json();
        window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, ok: !!(j && j.ok === true), error: (j && j.error) || null });
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
async function gehFrisch(p, route) {
  await geh(p, '/tasks');
  await sleep(700);
  await geh(p, route);
  await sleep(900);
}
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)) && !/^store\.|^page\.|^domain\.|^session\./.test(String(x.op)));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const aufrufe = (c) => c.ev('return JSON.stringify(window.__invokes || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const FEHLER_SEL = '[data-save-error]';
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

/** Wie im R6E-Lauf: vor jedem Laden und Vergleich, bis der Primary nichts mehr zu schieben hat. */
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
const seitRow = (t, row) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE rowid > ? ORDER BY rowid`, [row]);
/** Die Zeilen, die in GENAU diesem Fenster (von, bis] entstanden sind — eine Seite, nicht ihr Zwilling. */
const fenster = (t, von, bis) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE rowid > ? AND rowid <= ? ORDER BY rowid`, [von, bis]);
const ledgerMax = () => maxRow('ledger_entries');
const buchungenSeit = (row) => dbQ(BIZ_DB, 'SELECT account, direction, amount, source_module, transaction_id, reverses_entry_id FROM ledger_entries WHERE rowid > ? ORDER BY rowid', [row]);
const ledgerNorm = (rows) => S(rows.map((r) => [r.account, r.direction, Math.round(Number(r.amount) * 1000), r.source_module, r.reverses_entry_id ? 'R' : '']).map((x) => S(x)).sort());
/** Jede Spalte, die einen Menschen nennt (…_by, user_id) — für den Leck-Test: nie der ANDERE Benutzer. */
const AKTEUR_SPALTE = /(_by|^user_id|_user_id)$/;
const akteure = (rows) => [...new Set(rows.flatMap((r) => Object.entries(r || {})
  .filter(([k, v]) => AKTEUR_SPALTE.test(k) && v !== null && v !== undefined && v !== '').map(([, v]) => String(v))))];

// ── Normalisieren (wie R6E): Kennungen, Zeiten, Nummern raus; Zwillingsnamen gleichgesetzt ──────
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMMER_RE = /\b[A-Z]{2,5}-(?:\d{4}-)?\d{3,6}\b/g;
const TEXTFELD = /^(description|notes|note|title)$/;
function zw(v, k) {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v !== 'string') return v;
  // „Card fee (Normal) · No: 000003" — die laufende Rechnungsnummer steht auch ohne Präfix im Text.
  let s = v.replace(UUID_RE, '<uuid>').replace(NUMMER_RE, '<nr>').replace(/\bNo: \d+/g, 'No: <nr>').replace(/((?:r6e|R6E)[A-Za-z0-9 _-]*?[ -])([CP])(?![A-Za-z0-9])/g, '$1X');
  if (k && TEXTFELD.test(k)) s = s.replace(/\b[0-9a-f]{8}\b/g, '<id8>');
  return s;
}
const OHNE_STD = /^(id|created_at|updated_at|created_by|recorded_at|occurred_at|entry_no|transaction_id|[a-z_]*_number|sync_status|position|[a-z_]*_at|assigned_to|changed_by|user_id)$/;
// Der Handelnde ist GEWOLLT verschieden (B gegen A) und wird eigens geprüft — der Zustandsvergleich
// sieht nur die Geschäftswirkung.
const OHNE_AKTEUR = /(_by|_user_id)$/;
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
const KUNDE = (x) => `r6e-akteur-kunde-${x}`;
const PROD = (k, x) => `r6e-akteur-${k}-${x}`;
const ARTIKEL = ['pa', 'pb', 'pc', 'pd'];
const HEUTE = new Date().toISOString().slice(0, 10);
const GRUND = 'R6E Akteur Kunde behaelt die Uhr';

/** Geschäftsdaten + Benutzer B in der Geschäftsdatenbank (dieselbe Form wie der Onboarding-Owner). */
function seedGeschaeft() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    // Die Anwendung (sql.js) erzwingt in der Geschäftsdatenbank keine Fremdschlüssel — der Seed tut es auch nicht.
    db.exec('PRAGMA foreign_keys = OFF');
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'r6e-akteur-cat', branch_id, name: 'R6E Akteur Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    insert(db, 'employees', { id: 'r6e-akteur-emp', branch_id, name: 'R6E Akteur Kasse', employment_status: 'active', created_at: now, updated_at: now });
    for (const x of ['C', 'P']) {
      insert(db, 'customers', { id: KUNDE(x), branch_id, first_name: 'R6E', last_name: `Akteur ${x}`, phone: x === 'C' ? '+973 3600 0711' : '+973 3600 0722', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
      for (const k of ARTIKEL) {
        const id = PROD(k, x);
        insert(db, 'products', { id, branch_id, category_id: 'r6e-akteur-cat', brand: 'Omega', name: `R6E Akteur Uhr ${k} ${x}`, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD', planned_sale_price: 1000, tax_scheme: 'VAT_10', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{}', stock_status: 'in_stock', source_type: 'OWN', created_at: now, updated_at: now });
        insert(db, 'stock_lots', { id: id + '-lot', branch_id, product_id: id, unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
      }
    }
    // B wie der Onboarding-Owner: dieselbe Mandanten- und Filialzuordnung, dieselbe Rolle (ADMIN).
    const a = db.prepare('SELECT u.id, u.tenant_id, u.password_hash, ub.branch_id, ub.role FROM users u JOIN user_branches ub ON ub.user_id = u.id ORDER BY ub.is_default DESC, u.created_at LIMIT 1').get() || {};
    insert(db, 'users', { id: B_ID, tenant_id: a.tenant_id || 'tenant-1', email: B_EMAIL, password_hash: a.password_hash || '!', name: B_NAME, active: 1, created_at: now, updated_at: now });
    insert(db, 'user_branches', { user_id: B_ID, branch_id: a.branch_id || branch_id, role: a.role || 'ADMIN', is_default: 1, created_at: now });
    return a;
  } finally { try { db.close(); } catch { /* zu */ } }
}

/**
 * B im Server-Konto: dieselben drei Zeilen, die der Owner hat (users, user_branches mit is_default=1
 * und Rolle 'owner', server_credentials 'active'). Die Anmeldung (`routes.rs::login`) liest genau diese.
 */
function seedServerB() {
  const db = new DatabaseSync(SERVER_DB);
  try {
    const now = new Date().toISOString();
    const o = db.prepare('SELECT u.tenant_id, u.password_hash FROM users u WHERE u.email = ?').get(OWNER_EMAIL) || {};
    insert(db, 'users', { id: B_ID, tenant_id: o.tenant_id || 'tenant-1', email: B_EMAIL, password_hash: o.password_hash, name: B_NAME, active: 1, created_at: now, updated_at: now });
    insert(db, 'user_branches', { user_id: B_ID, branch_id: 'branch-main', role: 'owner', is_default: 1, created_at: now });
    insert(db, 'server_credentials', { user_id: B_ID, credential_state: 'active', password_changed_at: now, provisioned_at: now, provisioned_by: 'r6e-e2e-seed', classified_reason: 'r6e-second-real-user', created_at: now, updated_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Die Nachweise ────────────────────────────────────────────────────────────
const OPS = ['invoices.create', 'invoices.record_payment', 'returns.cancel'];
const BEWEIS = Object.fromEntries(OPS.map((o) => [o, { C: 0, P: 0 }]));
const AKTEUR = { invoice: false, payment: false, retoure: false, spoof: false, sitzung: false, pc2Ohne: false };
let A_ID = '', A_NAME = '', SITZUNG_A0 = null;
const wer = (x) => (x === 'C' ? B_ID : A_ID);
const anderer = (x) => (x === 'C' ? A_ID : B_ID);
const absenderVon = (cmdId) => String(dbQ(BIZ_DB, 'SELECT user_id FROM remote_command_ledger WHERE command_id = ?', [cmdId])[0]?.user_id || '');

/** EINE Handlung, zweimal durch dieselbe Maske: PC2 (als B) auf seinem Zwilling, dann der Primary (als A). */
async function paar(def) {
  const erg = {};
  for (const x of ['C', 'P']) {
    const seite = x === 'C' ? 'PC2/B' : 'Primary/A';
    const w = `${def.name} [${seite}]`;
    const failVor = FAIL;
    let c;
    await syncRuhe();
    if (x === 'C') { client = await lade(client, def.route('C')); c = client; }
    else { await gehFrisch(primary, def.route('P')); c = primary; }
    const bereit = await warteBis(c, def.bereit(x), 45000);
    ok(bereit, `${w} die Maske ist da (${def.route(x)})`);
    const v = {
      ...(def.vorher ? def.vorher(x) : {}),
      led: ledgerMax(), aud: maxRow('audit_log'), pay: maxRow('payments'), exp: maxRow('expenses'),
    };
    const vorCmd = x === 'C' ? (await buchungen(c)).length : 0;
    const m = bereit ? await def.fuellen(c, x, v) : 'NICHT-BEREIT';
    ok(m === 'OK', `${w} Eingaben (${m})`);
    const s = await def.speichern(c, x, v);
    ok(s === 'OK', `${w} Speichern (${s})`);
    ok(await warteAuf(() => def.fertig(x, v)), `${w} die Wirkung steht am Primary (Hinweis: ${String(await fehlerText(c)).slice(0, 220) || 'keiner'})`);
    ok(await warteBis(c, def.zu(x, v), 25000), `${w} die Maske meldet Erfolg (Hinweis: ${String(await fehlerText(c)).slice(0, 220) || 'keiner'})`);
    await sleep(600);
    await syncRuhe();
    ok(def.fertig(x, v), `${w} genau EINE Wirkung — auch nach dem Echo des Primary`);
    // Das Fenster DIESER Seite schließen — der Zwilling am Primary läuft danach und darf nicht mitzählen.
    Object.assign(v, { ledEnd: ledgerMax(), audEnd: maxRow('audit_log'), payEnd: maxRow('payments'), expEnd: maxRow('expenses') });
    const L = buchungenSeit(v.led).filter((r, i) => i < v.ledEnd - v.led);
    const Z = def.zustand(x, v);
    let cc = [];
    if (x === 'C') {
      cc = (await buchungen(c)).slice(vorCmd);
      ok(cc.length === 1 && cc[0].op === def.op, `${w} genau EIN Fernauftrag ${def.op} (${cc.map((k) => k.op + ':' + String(k.commandId).slice(0, 8)).join(', ')})`);
      const p = cc[0]?.payload || {};
      ok(S(Object.keys(p).sort()) === S([...def.keys].sort()), `${w} der Rumpf nennt nur die Absicht — keinen Urheber (${S(Object.keys(p).sort())})`);
      if (def.rumpf) ok(!!def.rumpf(p, x, v), `${w} die Werte im Rumpf (${S(p).slice(0, 400)})`);
      const abs = absenderVon(cc[0]?.commandId);
      ok(abs === B_ID, `${w} der durable Nachweis nennt den geprüften Absender B (${abs})`);
    }
    erg[x] = { L, Z, v, cmds: cc, gut: FAIL === failVor };
  }
  const zC = nz(erg.C.Z, def.ohne || OHNE_AKTEUR), zP = nz(erg.P.Z, def.ohne || OHNE_AKTEUR);
  const z = zC === zP;
  ok(z, `${def.name} PARITAET Zustand: Primary == PC2 (PC2 ${zC.slice(0, 700)} // Primary ${zP.slice(0, 700)})`);
  const lC = ledgerNorm(erg.C.L), lP = ledgerNorm(erg.P.L);
  const l = lC === lP;
  ok(l && erg.C.L.length > 0, `${def.name} PARITAET Hauptbuch je Quelle: Primary == PC2 (${erg.C.L.length}/${erg.P.L.length} Zeilen; ${lC.slice(0, 300)} // ${lP.slice(0, 300)})`);
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
/** Der Nummerndialog (NumberTypeDialog): normal oder Sonder, dann bestätigen. */
async function nummerWahl(c, sonder) {
  if (!(await warteBis(c, q('[data-final-number-confirm]'), 15000))) return 'KEIN-NUMMERNDIALOG';
  const r = [await klick(c, sonder ? '[data-final-number-special]' : '[data-final-number-normal]')];
  await sleep(250);
  r.push(await klick(c, '[data-final-number-confirm]'));
  return alleOk(r);
}
/**
 * „Create Return" am Primary: die (einzige) Zeile anhaken, Bar, zurück ins Lager, Erstattung JETZT.
 * Auf der UNBEZAHLTEN Rechnung ist der Barrückfluss 0 — „jetzt" heißt dann: genehmigen, Gutschrift
 * ausstellen (Forderungsstorno), nichts auszahlen. So entsteht eine Gutschrift, und die Retoure bleibt
 * stornierbar („Refund later" genehmigt nie → keine Gutschrift; eine Auszahlung sperrt das Storno).
 */
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
  r.push(await clickText(c, 'Refund jetzt zahlen'));
  await sleep(300);
  return alleOk(r);
}

// ── Stände für den Vergleich ─────────────────────────────────────────────────
const artikelStand = (ids) => dbQ(BIZ_DB, `SELECT id, stock_status, quantity FROM products WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids);
const loseStand = (ids) => dbQ(BIZ_DB, `SELECT product_id, qty_remaining, status FROM stock_lots WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY product_id`, ids);
const rechnungStand = (id) => ({
  inv: zeile('invoices', id),
  lines: dbQ(BIZ_DB, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', [id]),
  pays: dbQ(BIZ_DB, 'SELECT * FROM payments WHERE invoice_id = ?', [id]),
});
const mitArtikel = () => 'id IN (SELECT invoice_id FROM invoice_lines WHERE product_id = ?)';
const rechnungMit = (k, x) => dbQ(BIZ_DB, `SELECT * FROM invoices WHERE ${mitArtikel()}`, [PROD(k, x)]);

/** Die Rechnungsmaske (InvoiceCreate): Kunde, Artikel (mit Los), Zahlart (+ Kartenmarke), Betrag. */
const rechnungFuellen = (k, methode, betrag, marke) => async (c, x) => {
  const r = [await ssPick(c, 'Search clients...', KUNDE(x))];
  r.push(await ssPick(c, 'Pick product...', PROD(k, x)));
  if (!(await warteBis(c, "document.body.innerText.includes('Lot ·')", 15000))) return 'KEIN-LOS';
  r.push(await klick(c, `[data-invoice-pay-method="${methode}"]`));
  if (marke) {
    if (await warteBis(c, q(`[data-invoice-pay-card-brand="${marke}"]`), 8000)) r.push(await klick(c, `[data-invoice-pay-card-brand="${marke}"]`));
    else r.push('KEINE-KARTENMARKE');
  }
  await sleep(200);
  if (betrag === 'voll') r.push(await klick(c, '[data-invoice-pay-full]'));
  else if (betrag === 'spaeter') r.push(await klick(c, '[data-invoice-pay-later]'));
  else r.push(await setVal(c, '[data-invoice-pay-amount]', String(betrag)));
  await sleep(400);
  return alleOk(r);
};

/** Vorbereitung am Primary (als A): eine Rechnung über die normale Maske. */
async function rechnungAmPrimary(name, x, k, methode, betrag) {
  await syncRuhe();
  const iids = idSet('invoices');
  await gehFrisch(primary, '/invoices/new');
  const bereit = await warteBis(primary, q('[data-ss-trigger="Search clients..."]'), 45000);
  const m = bereit ? await rechnungFuellen(k, methode, betrag)(primary, x) : 'NICHT-BEREIT';
  let s = m === 'OK' ? await klick(primary, '[data-invoice-save]') : 'NICHT-GEFUELLT';
  if (s === 'OK' && betrag === 'voll') s = await nummerWahl(primary, false);
  const da = s === 'OK' && await warteAuf(() => neueZeilen('invoices', iids, mitArtikel(), [PROD(k, x)]).length === 1);
  const id = neueZeilen('invoices', iids, mitArtikel(), [PROD(k, x)])[0]?.id;
  ok(da && !!id, `VORBEREITUNG ${name} (${x}) am Primary als A (${m}/${s}; ${String(await fehlerText(primary)).slice(0, 160)})`);
  return id;
}

const INV1 = {}, INV2 = {}, INV3 = {}, RET = {}, CN = {};

try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ══ SETUP — Primary (Onboarding als A), Geschäftsdaten, Benutzer B, Primary-Server ══════════════
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R6E Akteur Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R6E Akteur Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R6E Admin A');
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
    ok(u.email === B_EMAIL && Number(u.active) === 1 && u.role === 'owner' && Number(u.is_default) === 1 && u.branch_id === 'branch-main'
      && /^\$2/.test(String(u.password_hash || '')) && cr.credential_state === 'active',
    `SETUP Benutzer B im Server-Konto: eigene Kennung/E-Mail, Owner in branch-main, echter bcrypt-Wert, Zugang aktiv (${u.id}/${u.role}/${cr.credential_state})`);
    const bb = dbQ(BIZ_DB, 'SELECT u.id, ub.role, ub.branch_id FROM users u JOIN user_branches ub ON ub.user_id = u.id WHERE u.id = ?', [B_ID])[0] || {};
    ok(bb.id === B_ID && bb.role === aVorlage.role && bb.branch_id === aVorlage.branch_id,
      `SETUP Benutzer B in der Geschäftsdatenbank wie der Onboarding-Owner (${bb.role}/${bb.branch_id} · Vorlage ${aVorlage.id}/${aVorlage.role})`);
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
  A_NAME = String(dbQ(BIZ_DB, 'SELECT name FROM users WHERE id = ?', [A_ID])[0]?.name || '');
  ok(!!A_ID && A_ID !== B_ID && !!A_NAME, `SETUP der Primary ist als A angemeldet (${A_ID} „${A_NAME}"), B ist ein anderer Mensch (${B_ID})`);
  // Die Sitzung, wie der Primary sie VOR allen Fernaufträgen zeigt — der Vergleichsstand für SESSION.
  SITZUNG_A0 = JSON.parse(String(await primary.ev('return localStorage.getItem("lataif_session") || "{}";')) || '{}');
  if (SITZUNG_A0?.user?.name !== A_NAME) console.log(`      (info) die Sitzung des Primary trägt den Anzeigenamen „${SITZUNG_A0?.user?.name}" (Datenbank: „${A_NAME}") — Kennung ${SITZUNG_A0?.userId}`);

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
    const s = JSON.parse(String(await client.ev('return localStorage.getItem("lataif_session") || "{}";')) || '{}');
    ok(s.userId === B_ID && s.role === 'owner', `CONNECT PC2 ist als B angemeldet — der Ausweis nennt sub = B, Rolle owner (${s.userId}/${s.role})`);
  }
  await beobachterLegen();

  // Die ALTE Geschäftsdatei im Datenordner von PC2 — sie darf in keinem Schritt angefasst werden.
  await spuelen(primary);
  mkdirSync(CLIENT_DATA_DIR, { recursive: true });
  const STALE = join(CLIENT_DATA_DIR, 'lataif.db');
  copyFileSync(BIZ_DB, STALE);
  const staleVorher = sha(STALE);
  const dateienVorher = readdirSync(CLIENT_DATA_DIR).sort();
  const LEDGER_BASIS = ledgerMax();

  // ══ VORBEREITUNG am Primary (als A): offene Rechnung für die Teilzahlung; bezahlte Rechnung + Retoure ══
  for (const x of ['C', 'P']) INV2[x] = await rechnungAmPrimary('offene Rechnung (Teilzahlung 300 bar)', x, 'pb', 'cash', 300);
  for (const x of ['C', 'P']) INV3[x] = await rechnungAmPrimary('unbezahlte Rechnung für die Retoure (Pay Later)', x, 'pc', 'cash', 'spaeter');
  ok(['C', 'P'].every((x) => zeile('invoices', INV2[x]).status === 'PARTIAL' && zeile('invoices', INV2[x]).created_by === A_ID)
    && ['C', 'P'].every((x) => zeile('invoices', INV3[x]).status === 'PARTIAL' && Number(zeile('invoices', INV3[x]).paid_amount) === 0 && zeile('invoices', INV3[x]).created_by === A_ID),
  `VORBEREITUNG die Vorlagen gehören A (${['C', 'P'].map((x) => `${zeile('invoices', INV2[x]).status}/${zeile('invoices', INV2[x]).created_by} ${zeile('invoices', INV3[x]).status}/${zeile('invoices', INV3[x]).created_by}`).join(' · ')})`);
  for (const x of ['C', 'P']) {
    await syncRuhe();
    const vorR = idSet('sales_returns');
    await gehFrisch(primary, `/invoices/${INV3[x]}`);
    const m = await retoureMaske(primary);
    const s = m === 'OK' ? await klick(primary, '[data-return-save]') : 'NICHT-GEFUELLT';
    ok(m === 'OK' && s === 'OK' && await warteAuf(() => neueZeilen('sales_returns', vorR, 'invoice_id = ?', [INV3[x]]).length === 1),
      `VORBEREITUNG Retoure (${x}) am Primary als A (${m}/${s}; ${String(await fehlerText(primary)).slice(0, 160)})`);
    RET[x] = neueZeilen('sales_returns', vorR, 'invoice_id = ?', [INV3[x]])[0]?.id;
    CN[x] = dbQ(BIZ_DB, 'SELECT * FROM credit_notes WHERE sales_return_id = ?', [RET[x]]);
  }
  ok(['C', 'P'].every((x) => CN[x].length >= 1 && CN[x].every((cn) => (cn.status || 'ISSUED') === 'ISSUED' && cn.created_by === A_ID)),
    `VORBEREITUNG je Retoure eine wirksame Gutschrift, ausgestellt von A (${['C', 'P'].map((x) => CN[x].map((cn) => `${cn.credit_note_number}/${cn.status}/${cn.created_by}`).join(',') || 'KEINE').join(' · ')})`);
  ok(['C', 'P'].every((x) => Number(zeile('sales_returns', RET[x]).refund_paid_amount || 0) === 0 && zeile('sales_returns', RET[x]).status !== 'REJECTED'),
    `VORBEREITUNG nichts ausgezahlt — die Retoure bleibt stornierbar (${['C', 'P'].map((x) => `${zeile('sales_returns', RET[x]).status}/${zeile('sales_returns', RET[x]).refund_paid_amount}`).join(' · ')})`);

  // ══ INVOICE — Rechnung mit Kartenzahlung (voll → Nummerndialog normal) ═══════════════════════════
  const rechnung = await paar({
    name: 'INV-CREATE-CARD', op: 'invoices.create',
    route: () => '/invoices/new',
    bereit: () => q('[data-ss-trigger="Search clients..."]'),
    vorher: () => ({ iids: idSet('invoices') }),
    fuellen: rechnungFuellen('pa', 'card', 'voll', 'normal'),
    speichern: async (c) => {
      const a = await klick(c, '[data-invoice-save]');
      if (a !== 'OK') return a;
      return nummerWahl(c, false);
    },
    fertig: (x, v) => neueZeilen('invoices', v.iids, mitArtikel(), [PROD('pa', x)]).length === 1,
    zu: () => '/^\\/invoices\\/[^/]+$/.test(location.pathname) && !/\\/new$/.test(location.pathname)',
    keys: ['customerId', 'issuedDate', 'lines', 'payment', 'specialMark'],
    rumpf: (p) => p.customerId === KUNDE('C') && p.issuedDate === HEUTE && p.specialMark === false
      && S(p.payment) === S({ amount: 1100, method: 'card', cardBrand: 'normal' })
      && S(p.lines) === S([{ productId: PROD('pa', 'C'), lotId: PROD('pa', 'C') + '-lot', quantity: 1, unitPrice: 1000, scheme: 'auto' }]),
    zustand: (x, v) => {
      INV1[x] = neueZeilen('invoices', v.iids, mitArtikel(), [PROD('pa', x)])[0]?.id;
      return {
        r: rechnungStand(INV1[x]),
        gebuehr: dbQ(BIZ_DB, "SELECT * FROM expenses WHERE related_entity_id = ? AND category = 'CardFees'", [INV1[x]]),
        a: artikelStand([PROD('pa', x)]), lose: loseStand([PROD('pa', x)]),
      };
    },
  });
  {
    let alle = true;
    for (const x of ['C', 'P']) {
      const U = wer(x), X = anderer(x), v = rechnung[x].v, id = INV1[x];
      const tag = `INV-CREATE-CARD Akteur [${x === 'C' ? 'PC2' : 'Primary'}] erwartet ${U}`;
      const inv = zeile('invoices', id);
      const lines = dbQ(BIZ_DB, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', [id]);
      const pays = dbQ(BIZ_DB, 'SELECT * FROM payments WHERE invoice_id = ?', [id]);
      const fee = dbQ(BIZ_DB, "SELECT * FROM expenses WHERE related_entity_id = ? AND category = 'CardFees'", [id]);
      const led = fenster('ledger_entries', v.led, v.ledEnd);
      const ids = new Set([id, ...lines.map((l) => l.id), ...pays.map((p) => p.id), ...fee.map((e) => e.id)]);
      const au = fenster('audit_log', v.aud, v.audEnd);
      const auR = au.filter((a) => ids.has(a.entity_id));
      const g = [
        ok(inv.created_by === U, `${tag}: invoices.created_by (${inv.created_by} · ${inv.invoice_number} ${inv.status})`),
        ok(/^INV-/.test(String(inv.invoice_number)) && inv.status === 'FINAL', `${tag}: Vollzahlung → Endnummer im normalen Kreis (${inv.invoice_number}/${inv.status})`),
        ok(pays.length === 1 && pays[0].created_by === U && pays[0].method === 'card', `${tag}: payments.created_by (${S(pays.map((p) => [p.method, p.amount, p.created_by]))})`),
        ok(fee.length === 1 && fee[0].created_by === U && Number(fee[0].amount) > 0, `${tag}: die automatische Kartengebühr expenses.created_by (${S(fee.map((e) => [e.amount, e.created_by]))})`),
        ok(led.length >= 4 && led.every((l) => l.created_by === U), `${tag}: jede neue Hauptbuchzeile ledger_entries.created_by (${led.length} Zeilen; ${S(akteure(led))})`),
        ok(auR.length >= 1 && auR.every((a) => a.changed_by === U), `${tag}: audit_log.changed_by der Rechnung/Zahlung/Gebühr (${auR.length} von ${au.length} im Fenster; ${S([...new Set(auR.map((a) => a.changed_by))])})`),
        ok(!akteure([inv, ...lines, ...pays, ...fee, ...led, ...auR]).includes(X), `${tag}: keine Spalte (…_by/user_id) nennt den ANDEREN Benutzer ${X} (${S(akteure([inv, ...lines, ...pays, ...fee, ...led, ...auR]))})`),
      ];
      const fremd = au.filter((a) => !ids.has(a.entity_id));
      if (fremd.length) console.log(`      (info) ${tag}: ${fremd.length} weitere Protokollzeilen im Fenster: ${S(fremd.map((a) => [a.entity_type, a.field_name, a.changed_by])).slice(0, 300)}`);
      alle = alle && g.every(Boolean);
    }
    AKTEUR.invoice = alle && BEWEIS['invoices.create'].C > 0 && BEWEIS['invoices.create'].P > 0;
  }
  console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_INVOICE_CANDIDATE');

  // ══ PAYMENT — Teilzahlung über die Rechnungsliste auf die offene Rechnung von A ═════════════════
  const zahlung = await paar({
    name: 'PAY-PARTIAL (Liste)', op: 'invoices.record_payment',
    route: () => '/invoices',
    bereit: (x) => q(`[data-pay-invoice="${INV2[x]}"]`),
    vorher: (x) => ({ paid: Number(zeile('invoices', INV2[x]).paid_amount), n: dbQ(BIZ_DB, 'SELECT id FROM payments WHERE invoice_id = ?', [INV2[x]]).length }),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-pay-invoice="${INV2[x]}"]`)];
      if (!(await warteBis(c, q('[data-invoice-list-pay]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setVal(c, '[data-invoice-list-pay-amount]', '200'));
      r.push(await klick(c, '[data-invoice-list-pay-method="cash"]'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-invoice-list-pay]'),
    fertig: (x, v) => dbQ(BIZ_DB, 'SELECT id FROM payments WHERE invoice_id = ?', [INV2[x]]).length === v.n + 1
      && Math.abs(Number(zeile('invoices', INV2[x]).paid_amount) - (v.paid + 200)) < 0.001,
    zu: () => `!${q('[data-invoice-list-pay]')}`,
    keys: ['amount', 'invoiceId', 'method'],
    rumpf: (p) => p.invoiceId === INV2.C && p.amount === 200 && p.method === 'cash',
    zustand: (x) => ({ r: rechnungStand(INV2[x]), a: artikelStand([PROD('pb', x)]) }),
  });
  {
    let alle = true;
    for (const x of ['C', 'P']) {
      const U = wer(x), X = anderer(x), v = zahlung[x].v, id = INV2[x];
      const tag = `PAY-PARTIAL Akteur [${x === 'C' ? 'PC2' : 'Primary'}] erwartet ${U}`;
      const inv = zeile('invoices', id);
      const neu = fenster('payments', v.pay, v.payEnd).filter((p) => p.invoice_id === id);
      const led = fenster('ledger_entries', v.led, v.ledEnd);
      const ids = new Set([id, ...neu.map((p) => p.id)]);
      const au = fenster('audit_log', v.aud, v.audEnd);
      const auR = au.filter((a) => ids.has(a.entity_id));
      const g = [
        ok(inv.created_by === A_ID && inv.status === 'PARTIAL', `${tag}: die Rechnung bleibt beim Anleger A und offen (${inv.created_by}/${inv.status}, bezahlt ${inv.paid_amount})`),
        ok(neu.length === 1 && neu[0].created_by === U && Number(neu[0].amount) === 200, `${tag}: die neue Zahlung payments.created_by (${S(neu.map((p) => [p.method, p.amount, p.created_by]))})`),
        ok(led.length >= 2 && led.every((l) => l.created_by === U), `${tag}: ihre Hauptbuchzeilen ledger_entries.created_by (${led.length} Zeilen; ${S(akteure(led))})`),
        ok(auR.every((a) => a.changed_by === U), `${tag}: audit_log.changed_by der Zahlung/Rechnung (${auR.length} von ${au.length} im Fenster; ${S([...new Set(auR.map((a) => a.changed_by))])})`),
        ok(!akteure([...neu, ...led, ...auR]).includes(X), `${tag}: keine neue Spalte nennt den ANDEREN Benutzer ${X} (${S(akteure([...neu, ...led, ...auR]))})`),
      ];
      alle = alle && g.every(Boolean);
    }
    AKTEUR.payment = alle && BEWEIS['invoices.record_payment'].C > 0 && BEWEIS['invoices.record_payment'].P > 0;
  }
  console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_PAYMENT_CANDIDATE');

  // ══ RETURN — „Cancel Return" auf der Rechnungsseite (Retoure von A vorbereitet) ═════════════════
  const storno = await paar({
    name: 'RETURN-CANCEL', op: 'returns.cancel',
    route: (x) => `/invoices/${INV3[x]}`,
    bereit: () => q('[data-return-cancel-open]'),
    vorher: (x) => ({ rev: Number(zeile('sales_returns', RET[x]).revision), cn: dbQ(BIZ_DB, 'SELECT id, credit_note_number FROM credit_notes WHERE sales_return_id = ?', [RET[x]]) }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-return-cancel-open]')];
      if (!(await warteBis(c, q('[data-return-cancel-reason]'), 10000))) return 'KEINE-MASKE';
      r.push(await setVal(c, '[data-return-cancel-reason]', GRUND));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-return-cancel-confirm]'),
    fertig: (x) => zeile('sales_returns', RET[x]).status === 'REJECTED',
    zu: () => `!${q('[data-return-cancel-confirm]')}`,
    keys: ['expectedRevision', 'reason', 'returnId'],
    rumpf: (p, x, v) => p.returnId === RET.C && p.expectedRevision === v.rev && p.reason === GRUND,
    zustand: (x) => ({
      ret: zeile('sales_returns', RET[x]),
      rl: dbQ(BIZ_DB, 'SELECT * FROM sales_return_lines WHERE return_id = ?', [RET[x]]),
      r: rechnungStand(INV3[x]),
      a: artikelStand([PROD('pc', x)]), lose: loseStand([PROD('pc', x)]),
      cn: dbQ(BIZ_DB, 'SELECT * FROM credit_notes WHERE invoice_id = ?', [INV3[x]]),
      cc: dbQ(BIZ_DB, 'SELECT status, amount, used_amount FROM customer_credits WHERE source_id IN (SELECT id FROM credit_notes WHERE sales_return_id = ?)', [RET[x]]),
    }),
  });
  {
    let alle = true;
    for (const x of ['C', 'P']) {
      const U = wer(x), X = anderer(x), v = storno[x].v;
      const tag = `RETURN-CANCEL Akteur [${x === 'C' ? 'PC2' : 'Primary'}] erwartet ${U}`;
      const cn = dbQ(BIZ_DB, 'SELECT * FROM credit_notes WHERE sales_return_id = ?', [RET[x]]);
      const au = fenster('audit_log', v.aud, v.audEnd);
      const cancel = au.filter((a) => a.entity_id === RET[x] && a.field_name === 'cancel');
      const cnIds = new Set(v.cn.map((c) => c.id));
      const cnAu = au.filter((a) => a.entity_type === 'credit_notes' && cnIds.has(a.entity_id));
      const led = fenster('ledger_entries', v.led, v.ledEnd);
      const g = [
        ok(cancel.length === 1 && cancel[0].changed_by === U, `${tag}: genau EIN Storno-Protokoll, changed_by = der Handelnde (${S(cancel.map((a) => a.changed_by))})`),
        ok(v.cn.length >= 1 && cn.length === v.cn.length && v.cn.every((o) => cn.some((c) => c.id === o.id && c.credit_note_number === o.credit_note_number)),
          `${tag}: die Gutschrift bleibt STEHEN — dieselbe Zeile, dieselbe Nummer (${v.cn.length} vorher → ${cn.length} nachher: ${cn.map((c) => c.credit_note_number).join(',')})`),
        ok(cn.length >= 1 && cn.every((c) => c.status === 'CANCELLED' && c.cancelled_by === U && c.cancel_reason === GRUND && !!c.cancelled_at && c.created_by === A_ID),
          `${tag}: die Gutschrift ist CANCELLED mit cancelled_at/cancelled_by/cancel_reason — ausgestellt von A, storniert vom Handelnden (${S(cn.map((c) => [c.status, c.cancelled_by, c.cancel_reason, !!c.cancelled_at, c.created_by]))})`),
        ok(cnAu.length === cnIds.size && cnAu.every((a) => a.changed_by === U), `${tag}: je Gutschrift ein Protokoll an IHRER Zeile mit dem Handelnden (${cnAu.length}/${cnIds.size}; ${S(cnAu.map((a) => a.changed_by))})`),
        ok(led.length >= 1 && led.every((l) => l.created_by === U && !!l.reverses_entry_id), `${tag}: die Umkehrbuchungen gehören dem Handelnden (${led.length} Zeilen; ${S(akteure(led))})`),
        ok(!akteure([...cancel, ...cnAu, ...led]).includes(X) && !cn.some((c) => c.cancelled_by === X), `${tag}: nichts nennt den ANDEREN Benutzer ${X}`),
        ok(zeile('sales_returns', RET[x]).status === 'REJECTED', `${tag}: die Retoure bleibt als REJECTED stehen`),
      ];
      alle = alle && g.every(Boolean);
    }
    AKTEUR.retoure = alle && BEWEIS['returns.cancel'].C > 0 && BEWEIS['returns.cancel'].P > 0;
  }
  console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_RETURN_CANCEL_CANDIDATE');

  // ══ SPOOF — rohe Fernaufträge über die Brücke von PC2, mit eingeschleustem Urheber ═════════════
  {
    await syncRuhe();
    const roh = async (op, payload) => JSON.parse(String(await client.ev(`
      const url = localStorage.getItem('lataif_client_server_url'); const tok = localStorage.getItem('lataif_client_token');
      if (!url || !tok) return JSON.stringify({ id: '', status: 0, body: 'KEIN-AUSWEIS' });
      const id = (crypto.randomUUID ? crypto.randomUUID() : (() => { const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20); })());
      const r = await fetch(url + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ op: ${S(op)}, commandId: id, payload: ${S(payload)} }) });
      let t = ''; try { t = await r.text(); } catch (e) { t = String(e); }
      return JSON.stringify({ id, status: r.status, body: t });`)));
    const vor = {
      inv: zahl('SELECT COUNT(*) AS n FROM invoices'), pay: maxRow('payments'), led: ledgerMax(), exp: maxRow('expenses'), aud: maxRow('audit_log'),
      pays2: dbQ(BIZ_DB, 'SELECT id FROM payments WHERE invoice_id = ?', [INV2.C]).length, paid2: Number(zeile('invoices', INV2.C).paid_amount),
    };
    const linie = [{ productId: PROD('pd', 'C'), lotId: PROD('pd', 'C') + '-lot', quantity: 1, unitPrice: 1000, scheme: 'auto' }];
    const faelle = [
      ['invoices.record_payment + createdBy=A', 'invoices.record_payment', { invoiceId: INV2.C, amount: 5, method: 'cash', createdBy: A_ID }],
      ['invoices.create + userId=A', 'invoices.create', { customerId: KUNDE('C'), lines: linie, issuedDate: HEUTE, specialMark: false, payment: { amount: 100, method: 'cash' }, userId: A_ID }],
      ['invoices.create + payment.createdBy=A', 'invoices.create', { customerId: KUNDE('C'), lines: linie, issuedDate: HEUTE, specialMark: false, payment: { amount: 100, method: 'cash', createdBy: A_ID } }],
    ];
    const ids = [];
    let abgewiesen = true;
    for (const [name, op, payload] of faelle) {
      const a = await roh(op, payload);
      let j = {}; try { j = JSON.parse(a.body); } catch { j = {}; }
      ids.push(a.id);
      const nein = !!a.id && j.ok !== true && /PAYLOAD|INVALID|unknown field|decides/i.test(a.body);
      ok(nein, `SPOOF ${name}: abgewiesen (HTTP ${a.status}; ${String(a.body).slice(0, 220)})`);
      abgewiesen = abgewiesen && nein;
    }
    await sleep(800); await spuelen(primary);
    const nachLed = seitRow('ledger_entries', vor.led), nachPay = seitRow('payments', vor.pay), nachExp = seitRow('expenses', vor.exp);
    const nachAud = seitRow('audit_log', vor.aud).filter((a) => ['invoices', 'payments', 'invoice_lines', 'expenses'].includes(String(a.entity_type)));
    const nichts = zahl('SELECT COUNT(*) AS n FROM invoices') === vor.inv && nachPay.length === 0 && nachLed.length === 0 && nachExp.length === 0 && nachAud.length === 0
      && dbQ(BIZ_DB, 'SELECT id FROM payments WHERE invoice_id = ?', [INV2.C]).length === vor.pays2
      && Math.abs(Number(zeile('invoices', INV2.C).paid_amount) - vor.paid2) < 0.0005
      && artikelStand([PROD('pd', 'C')])[0]?.stock_status === 'in_stock';
    ok(nichts, `SPOOF …und nichts wurde geschrieben — keine Rechnung, Zahlung, Gebühr, Buchung, kein Protokoll, der Artikel bleibt im Lager (${nachPay.length}/${nachLed.length}/${nachExp.length}/${nachAud.length})`);
    const nachweis = dbQ(BIZ_DB, `SELECT command_id, status FROM remote_command_ledger WHERE command_id IN (${ids.map(() => '?').join(',')})`, ids);
    ok(!nachweis.some((r) => r.status === 'completed'), `SPOOF kein durabler Nachweis „completed" für diese Kennungen (${S(nachweis)})`);
    AKTEUR.spoof = abgewiesen && nichts && !nachweis.some((r) => r.status === 'completed');
  }
  console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_SPOOF_CANDIDATE');

  // ══ SESSION — der Primary zeigt weiterhin A, PC2 weiterhin B ═════════════════════════════════════
  {
    await gehFrisch(primary, '/invoices');
    const sP = JSON.parse(String(await primary.ev('return localStorage.getItem("lataif_session") || "{}";')) || '{}');
    const leiste = String(await primary.ev("return (document.querySelector('.app-sidebar') || {}).innerText || '';") || '');
    const shell = await exists(primary, SHELL);
    // Verglichen mit der Sitzung VOR den Fernaufträgen (Kennung, Rolle, Anzeigename, Token) — und die
    // Seitenleiste zeigt genau diesen Namen, nie B.
    const nameA = String(SITZUNG_A0?.user?.name || A_NAME);
    const gutP = sP.userId === A_ID && sP.userId === SITZUNG_A0?.userId && sP.role === SITZUNG_A0?.role && sP.token === SITZUNG_A0?.token
      && sP.user?.name === nameA && shell && leiste.includes(nameA) && !leiste.includes(B_NAME) && !leiste.includes(B_ID);
    ok(gutP, `SESSION der Primary ist weiterhin als A angemeldet — Sitzung ${sP.userId}/${sP.role} unverändert, Seitenleiste zeigt „${nameA}", nicht B (${leiste.replace(/\s+/g, ' ').slice(-120)})`);
    const sC = JSON.parse(String(await client.ev('return localStorage.getItem("lataif_session") || "{}";')) || '{}');
    ok(sC.userId === B_ID, `SESSION PC2 bleibt B (${sC.userId})`);
    AKTEUR.sitzung = gutP && sC.userId === B_ID;
  }

  // ══ LEDGER — jede Buchungstransaktion dieses Laufs ist ausgeglichen ═════════════════════════════
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
    ok(rows.length > 0 && schief.length === 0, `LEDGER ${tx.size} Transaktionen / ${rows.length} Zeilen dieses Laufs — jede ausgeglichen (${S(schief).slice(0, 300)})`);
    const wer2 = dbQ(BIZ_DB, 'SELECT created_by, COUNT(*) AS n FROM ledger_entries WHERE rowid > ? GROUP BY created_by', [LEDGER_BASIS]);
    ok(wer2.every((r) => r.created_by === A_ID || r.created_by === B_ID), `LEDGER jede Zeile dieses Laufs gehört A oder B — kein dritter, kein leerer Urheber (${S(wer2)})`);
    console.log(`  · Hauptbuch dieses Laufs: ${rows.length} Zeilen in ${tx.size} Transaktionen · Urheber ${S(wer2)}`);
  }

  // ══ SAFETY — PC2 ohne Datenbank: kein Griff, alte Datei unberührt ═══════════════════════════════
  {
    await ernte(client);
    const a = ALLE_TREFFER.length === 0;
    ok(a, `LOKAL kein Griff zur lokalen Datenbank — über alle Seiten des Laufs (${S(ALLE_TREFFER).slice(0, 200)})`);
    const b = !ALLE_AUFRUFE.some((x) => /stock_check|flush_database|backup|import|save_database/i.test(x));
    ok(b, `LOKAL kein Aufruf des eigenen Kerns zum Speichern (${[...new Set(ALLE_AUFRUFE)].join(',').slice(0, 300)})`);
    const c = sha(STALE) === staleVorher;
    ok(c, 'LOKAL die alte Geschäftsdatei auf PC2 ist unberührt');
    const dateien = readdirSync(CLIENT_DATA_DIR).sort();
    const neu = dateien.filter((f) => !dateienVorher.includes(f));
    const d = neu.length === 0 && !dateien.some((f) => /lataif_sync_server\.db|outbox|data-location/i.test(f));
    ok(d, `LOKAL keine neue Datei, keine Konfig-DB, keine Warteschlange (${dateien.join(', ')})`);
    const schluessel = await client.ev('return JSON.stringify(Object.keys(localStorage));');
    const e = !/outbox|pending|queue/i.test(schluessel);
    ok(e, `LOKAL keine lokale Warteschlange im Speicher (${schluessel})`);
    AKTEUR.pc2Ohne = a && b && c && d && e;
  }

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
console.log('\n  Handlung                        PC2 (B)  Primary (A)');
for (const o of OPS) console.log(`  ${o.padEnd(32)}${(BEWEIS[o].C > 0 ? 'ja' : 'NEIN').padEnd(9)}${BEWEIS[o].P > 0 ? 'ja' : 'NEIN'}`);
console.log(`  Akteur: ${Object.entries(AKTEUR).map(([k, v]) => `${k}=${v ? 'ja' : 'NEIN'}`).join(' · ')}`);
const alleBeide = OPS.every((o) => BEWEIS[o].C > 0 && BEWEIS[o].P > 0);
ok(alleBeide, `ALLE ${OPS.length} Handlungen auf PC2 (B) UND am Primary (A) mit gleicher Wirkung (fehlend: ${OPS.filter((o) => !(BEWEIS[o].C > 0 && BEWEIS[o].P > 0)).join(', ') || 'keine'})`);
ok(Object.values(AKTEUR).every(Boolean), `AKTEUR Rechnung, Zahlung, Retourenstorno, Spoofing, Sitzung, PC2 ohne Datenbank (${Object.entries(AKTEUR).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'alle'})`);
const dauer = Math.round((Date.now() - T0) / 1000);
if (FAIL > 0) {
  for (const f of fails) console.log('  - ' + f);
} else {
  if (AKTEUR.invoice) console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_INVOICE_PROVED');
  if (AKTEUR.payment) console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_PAYMENT_PROVED');
  if (AKTEUR.retoure) console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_RETURN_CANCEL_PROVED');
  if (AKTEUR.spoof) console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_SPOOF_REJECTED');
  console.log('CENTRAL_UI_R6E_DISTINCT_ACTOR_E2E_PROVED');
}
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r6e distinct actor: invoice + payment + return cancel + spoofing, user A on the primary, user B on PC2, two apps (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
