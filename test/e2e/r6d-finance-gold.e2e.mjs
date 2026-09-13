// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Steuer, Geld, Verbindlichkeiten, Gold und Edelmetall, zwei echte Anwendungen.
// Run: node test/e2e/r6d-finance-gold.e2e.mjs
//
//   Jede der 28 Buchungen läuft ZWEIMAL durch dieselbe Maske: zuerst auf PC2 (ohne Geschäftsdatenbank,
//   Fernauftrag /api/command), dann am Primary auf dem Zwilling (runOnPrimary). Verglichen werden die
//   normalisierten Geschäftszeilen (ohne Kennung/Zeit/Nummer), Status, Fassung und die Hauptbuchzeilen
//   der Handlung (Konto, Richtung, Betrag, Quelle). Auf PC2 zusätzlich: genau EIN Auftrag mit genau
//   den Absichtsfeldern.
//
//   LOST    verlorene Antwort (tax, expense payment, supplier pay, gold settle, debt payment, scrap
//           create): der Primary führt aus, die Antwort geht verloren, die Maske sagt „keine Antwort",
//           der zweite Klick schickt DIESELBE Kennung — genau eine Wirkung, genau eine Buchung
//   STALE   PC2 hält ein Darlehen offen, der Primary ändert es, PC2 speichert → RECORD_CHANGED, nichts
//   NEG     Überzahlung eines Darlehens → DEBT_OVERPAYMENT, am Primary dasselbe Nein
//   LEDGER  jede Buchungstransaktion dieses Laufs ist ausgeglichen (Σ Soll == Σ Haben)
//   SAFETY  PC2 mit einer ALTEN lataif.db: unberührt, kein eigener Kern, keine lokale Datenbank
//
// PROZESS-ISOLATION (dauerhafte Regel): gestartet wird nur über `spawnTracked`, beendet wird nur, was
// dieser Lauf gestartet hat (PID mit Pfadprüfung) oder was am EXAKTEN Test-Pfad läuft. Die installierte
// Produktions-App wird nie beendet, nie benutzt.
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
const OWNER_PW = 'r6d-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r6d', 'run-' + Date.now());
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
}, 100 * 60 * 1000);

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
/** Den Knopf `sel` in der Karte, die `karte` zeigt — die kleinste Umgebung mit genau diesem einen Knopf. */
const klickInKarte = (c, karte, sel) => c.ev(`const kand=[...document.querySelectorAll(${S(sel)})]; for (const x of kand) { let p=x; for(let i=0;i<12&&p;i++){ p=p.parentElement; if(!p) break; if ((p.innerText||'').includes(${S(karte)})) { if (p.querySelectorAll(${S(sel)}).length===1) { if (x.disabled) return 'DISABLED'; x.click(); return 'OK'; } break; } } } return 'NO-KARTE:'+${S(karte)};`);
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

// Der Beobachter: Fernaufträge, ihre Antworten, Datenbankgriffe, Kern-Aufrufe, Dialoge — und EINE
// verlorene Antwort auf Wunsch.
const BEOBACHTER = `
  if (window.__r6dInstalliert) { /* schon da */ } else {
  window.__r6dInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__invokes = []; window.__alerts = []; window.__dropNext = null;
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
    if (t && t.invoke && !t.__r6d) {
      const oi = t.invoke.bind(t);
      t.invoke = (cmd, args, opts) => { window.__invokes.push(String(cmd)); return oi(cmd, args, opts); };
      t.__r6d = true;
    } else if (!t || !t.__r6d) setTimeout(haken, 30);
  })();
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
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
      throw new TypeError('R6D: simulated lost response');
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
  try { ALLE_TREFFER.push(...(await treffer(c))); ALLE_AUFRUFE.push(...(await aufrufe(c))); } catch { /* Seite schon weg */ }
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
const FEHLER_SEL = '[data-save-error],[data-gold-settle-error],[data-material-error],[data-gold-usage-error],[data-scrap-form-error]';
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
 * Der Primary synchronisiert (Auto-LAN) mit seinem EIGENEN Sync-Server: alle 30 s schiebt er seine
 * Änderungen hoch und spielt sie als Echo wieder ein (applyUpsert → UPDATE → der Fassungs-Trigger
 * zählt +1). Das ist ein Hintergrundlauf, der mit der geprüften Buchung nichts zu tun hat — gemessen
 * im ersten Lauf: ohne Warten traf er zwischen „Seite geladen" und „Speichern" und machte die
 * gesehene Fassung alt (RECORD_CHANGED ohne fremde Änderung). Deshalb wird vor jedem Laden und vor
 * jedem Vergleich gewartet, bis der Primary nichts mehr zu schieben hat und sein Echo eingespielt ist.
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
      // Nicht 30 s auf den Zeitgeber warten: derselbe Lauf über den Knopf „Sync Now" des Primary
      // (Einstellungen → Sync / Server). Nur dieser Knopf — nie „Disconnect".
      angestossen = true;
      await geh(primary, '/settings?tab=sync');
      if (await warteBis(primary, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sync Now')", 8000)) {
        await clickText(primary, 'Sync Now');
      }
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
const bestand21 = () => zahl("SELECT COALESCE(SUM(weight_grams), 0) AS g FROM precious_metals WHERE metal_type = 'gold' AND status = 'in_stock' AND karat = '21K'");
const spotSilber = () => Number(dbQ(BIZ_DB, "SELECT value FROM settings WHERE key = 'spot_price.silver'")[0]?.value ?? NaN);

// ── Normalisieren: Kennungen, Zeiten, Nummern raus; Zwillingsnamen (… C / … P) gleichgesetzt ──────
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TEXTFELD = /^(description|notes|note|material_details)$/;
function zw(v, k) {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v !== 'string') return v;
  let s = v.replace(UUID_RE, '<uuid>').replace(/((?:r6d|R6D)[A-Za-z0-9 _-]*?[ -])([CP])(?![A-Za-z0-9])/g, '$1X');
  if (k && TEXTFELD.test(k)) s = s.replace(/\b[0-9a-f]{8}\b/g, '<id8>');
  return s;
}
const OHNE_STD = /^(id|created_at|updated_at|created_by|recorded_at|occurred_at|moved_at|paid_at_actual|settled_at|entry_no|transaction_id|[a-z_]*_number|sync_status|position)$/;
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
const KUNDE = (x) => `r6d-kunde-${x}`, LIEF = (x) => `r6d-lief-${x}`, PARTNER = (x) => `r6d-partner-${x}`;
const REP = (x) => `r6d-rep-${x}`, ORD = (x) => `r6d-ord-${x}`;
const GP1 = (x) => `r6d-gp1-${x}`, GP2 = (x) => `r6d-gp2-${x}`, CGC = (x) => `r6d-cgc-${x}`;
const SELL = (x) => `r6d-silber-sell-${x}`, MELT = (x) => `r6d-silber-melt-${x}`;
const EXP1 = (x) => `r6d-exp1-${x}`, EXP2 = (x) => `r6d-exp2-${x}`, PUR = (x) => `r6d-pur-${x}`, K2 = (x) => `r6d-k2-${x}`;
const HEUTE = new Date().toISOString().slice(0, 10);
const tag = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const JAHR = new Date().getFullYear();
const QUARTAL = Math.floor(new Date().getMonth() / 3) + 1;
const QKEY = `${JAHR}-Q${QUARTAL}`;

function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const alt = new Date(Date.now() - 20 * 86400000).toISOString();
    insert(db, 'employees', { id: 'r6d-emp', branch_id, name: 'R6D Mitarbeiter', role: 'Sales', employment_status: 'active', created_at: now, updated_at: now });
    insert(db, 'precious_metals', { id: 'r6d-stock-21k', branch_id, metal_type: 'gold', karat: '21K', weight_grams: 50, description: 'R6D Bestand', status: 'in_stock', images: '[]', paid_amount: 0, payment_status: 'PAID', created_at: alt, updated_at: alt });
    for (const x of ['C', 'P']) {
      insert(db, 'customers', { id: KUNDE(x), branch_id, first_name: 'R6D', last_name: `Kunde ${x}`, phone: x === 'C' ? '+973 3600 0111' : '+973 3600 0222', created_at: now, updated_at: now });
      insert(db, 'suppliers', { id: LIEF(x), branch_id, name: `R6D Lief ${x}`, phone: x === 'C' ? '+973 1700 0111' : '+973 1700 0222', active: 1, created_at: now, updated_at: now });
      insert(db, 'partners', { id: PARTNER(x), branch_id, name: `R6D Partner ${x}`, share_percentage: 10, active: 1, created_at: now, updated_at: now });
      insert(db, 'repairs', { id: REP(x), branch_id, repair_number: `REP-R6D-${x}`, customer_id: KUNDE(x), item_brand: 'R6D', item_model: 'Uhr', issue_description: 'R6D Service', repair_type: 'internal', status: 'in_progress', received_at: alt, images: '[]', item_attributes: '{}', created_at: alt, updated_at: alt });
      insert(db, 'orders', { id: ORD(x), branch_id, order_number: `ORD-R6D-${x}`, customer_id: KUNDE(x), requested_brand: 'R6D', requested_model: 'Ring', agreed_price: 500, status: 'pending', type: 'custom', attributes: '{}', created_at: alt, updated_at: alt });
      insert(db, 'gold_payables', { id: GP1(x), branch_id, supplier_id: LIEF(x), source_repair_id: REP(x), direction: 'we_owe', weight_grams: 10, karat: '21K', settlement_type: 'return_gold', fulfilled_grams: 0, status: 'OPEN', created_at: alt, updated_at: alt });
      insert(db, 'gold_payables', { id: GP2(x), branch_id, supplier_id: LIEF(x), source_order_id: ORD(x), direction: 'we_owe', weight_grams: 5, karat: '21K', settlement_type: 'return_gold', fulfilled_grams: 0, status: 'OPEN', created_at: alt, updated_at: alt });
      insert(db, 'customer_gold_credits', { id: CGC(x), branch_id, customer_id: KUNDE(x), source_repair_id: REP(x), weight_grams: 8, karat: '22K', fulfilled_grams: 0, status: 'OPEN', created_at: alt, updated_at: alt });
      for (const [id, was] of [[SELL(x), 'Verkauf'], [MELT(x), 'Schmelze']]) {
        insert(db, 'precious_metals', { id, branch_id, metal_type: 'silver', karat: '925', weight_grams: 100, purchase_total: 50, description: `R6D Silber ${was} ${x}`, status: 'in_stock', images: '[]', paid_amount: 0, payment_status: 'PAID', created_at: alt, updated_at: alt });
      }
      insert(db, 'expenses', { id: EXP1(x), branch_id, expense_number: `R6D-EXP-${x}1`, category: 'RepairCosts', amount: 60, payment_method: 'bank', expense_date: tag(-12), description: 'R6D Werkstatt 1', related_module: 'repair', related_entity_id: REP(x), created_at: alt, status: 'PENDING', paid_amount: 0, supplier_id: LIEF(x) });
      insert(db, 'expenses', { id: EXP2(x), branch_id, expense_number: `R6D-EXP-${x}2`, category: 'RepairCosts', amount: 40, payment_method: 'bank', expense_date: tag(-11), description: 'R6D Werkstatt 2', related_module: 'repair', related_entity_id: REP(x), created_at: alt, status: 'PENDING', paid_amount: 0, supplier_id: LIEF(x) });
      insert(db, 'purchases', { id: PUR(x), branch_id, purchase_number: `R6D-PUR-${x}`, supplier_id: LIEF(x), status: 'UNPAID', total_amount: 200, paid_amount: 0, remaining_amount: 200, purchase_date: tag(-10), notes: 'R6D Einkauf', created_at: alt, updated_at: alt });
      insert(db, 'supplier_credits', { id: K2(x), branch_id, supplier_id: LIEF(x), amount: 200, used_amount: 0, status: 'OPEN', note: 'R6D Guthaben', created_at: alt });
    }
    // Eine abgeschlossene Rechnung mit Umsatzsteuer im laufenden Quartal → das Quartal ist offen.
    insert(db, 'invoices', { id: 'r6d-inv-1', branch_id, invoice_number: 'R6D-INV-1', customer_id: KUNDE('C'), status: 'FINAL', currency: 'BHD', net_amount: 1000, vat_rate_snapshot: 10, vat_amount: 100, gross_amount: 1100, tax_scheme_snapshot: 'VAT_10', paid_amount: 0, issued_at: now, created_at: now, updated_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Die Nachweise ────────────────────────────────────────────────────────────
const OPS = [
  'tax.record_payment', 'banking.transfer', 'partners.record_tx', 'debts.create', 'debts.update', 'debts.record_payment',
  'expenses.create', 'expenses.update', 'expenses.record_payment', 'expenses.template_create', 'expenses.template_update',
  'purchases.record_payment', 'purchases.apply_credit', 'suppliers.pay', 'suppliers.apply_credit', 'suppliers.refund_credit',
  'gold.payables.settle', 'gold.customer_credits.settle', 'repairs.record_gold_usage', 'repairs.add_material',
  'orders.add_cost', 'orders.remove_cost',
  'metals.create', 'metals.update_status', 'metals.set_spot_price', 'scrap_trades.create', 'scrap_trades.update', 'scrap_trades.cancel',
];
const BEWEIS = Object.fromEntries(OPS.map((o) => [o, { C: 0, P: 0, versuche: 0 }]));
const LOST = {};

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
      ok(offen, `LOST ${def.name}: kein Schein-Erfolg — die Maske bleibt offen`);
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
    if (x === 'C') {
      const cc = (await buchungen(c)).slice(vorCmd);
      const n = def.lost ? 2 : 1;
      const gleich = n === 1 || (cc.length === 2 && cc[0].commandId === cc[1].commandId && S(cc[0].payload) === S(cc[1].payload));
      ok(cc.length === n && cc.every((k) => k.op === def.op) && gleich,
        `${wer} ${n === 1 ? 'genau EIN Auftrag' : 'zweimal DERSELBE Auftrag (Kennung + Rumpf)'} ${def.op} (${cc.map((k) => k.op + ':' + String(k.commandId).slice(0, 8)).join(', ')})`);
      const p = cc[0]?.payload || {};
      ok(S(Object.keys(p).sort()) === S([...def.keys].sort()), `${wer} der Rumpf nennt nur die Absicht (${S(Object.keys(p).sort())})`);
      if (def.rumpf) ok(!!def.rumpf(p, x, v), `${wer} die Werte im Rumpf (${S(p).slice(0, 400)})`);
      if (def.lost) {
        const an = (await antworten(c)).slice(vorAnt).filter((a) => a.op === def.op);
        const replay = an.length === 2 && an[0].dropped === true && an[1].ok === true && an[1].replayed === true;
        ok(replay, `LOST ${def.name}: die Wiederholung bekommt das eingefrorene Ergebnis (replayed) (${S(an).slice(0, 240)})`);
        LOST[def.op] = !!LOST[def.op] && replay;
      }
    }
    erg[x] = { L, Z, gut: FAIL === failVor };
  }
  const zC = nz(erg.C.Z, def.ohne), zP = nz(erg.P.Z, def.ohne);
  const z = zC === zP;
  ok(z, `${def.name} PARITAET Zustand: Primary == PC2 (PC2 ${zC.slice(0, 600)} // Primary ${zP.slice(0, 600)})`);
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

/** Ein Eintrag einer Suchauswahl (SearchSelect) wählen: Auslöser in der Hülle, dann die Option. */
async function waehle(c, huelle, id) {
  const r = await c.ev(`const t=document.querySelector(${S(huelle + ' [data-ss-trigger]')}); if(!t) return 'NO-TRIGGER:'+${S(huelle)}; t.click(); return 'OK';`);
  if (r !== 'OK') return r;
  if (!(await warteBis(c, q(`[data-ss-option="${id}"]`), 15000))) return 'NO-OPTION:' + id;
  const r2 = await klick(c, `[data-ss-option="${id}"]`);
  await sleep(250);
  return r2;
}

const DEBT = {}, EXP = {}, TPL = {}, K1 = {}, LINE_STEIN = {}, TRADE = {};

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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R6D Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R6D Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R6D Admin');
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
  ok(true, 'CONNECT frischer Rechner ohne Datenbank, Anmeldung — dann die normale Anwendung');
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
  // TAX — „Mark paid" im Quartal → tax.record_payment (verlorene Antwort auf PC2)
  // ══════════════════════════════════════════════════════════════════════
  await paar({
    name: 'TAX', op: 'tax.record_payment', lost: '[data-save-error]',
    route: () => '/analytics',
    bereit: () => "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'STOCK')",
    vorher: () => ({ ids: idSet('tax_payments') }),
    fuellen: async (c) => {
      // Der Reiter FINANCE der Auswertung — nicht die gleichnamige Gruppe der Seitenleiste.
      const r = [await c.ev("const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='FINANCE' && [...(x.parentElement?.querySelectorAll('button')||[])].some(y=>y.textContent.trim()==='STOCK')); if(!b) return 'NO-REITER'; b.click(); return 'OK';")];
      if (!(await warteBis(c, q(`[data-tax-pay-open="${QKEY}"]`), 30000))) return 'KEIN-QUARTAL:' + QKEY;
      r.push(await klick(c, `[data-tax-pay-open="${QKEY}"]`));
      if (!(await warteBis(c, q('[data-tax-pay-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(400);
      r.push(await setVal(c, '[data-tax-pay-amount]', '30'));
      r.push(await setVal(c, '[data-tax-pay-date]', HEUTE));
      r.push(await klick(c, '[data-tax-pay-source="cash"]'));
      r.push(await setVal(c, '[data-tax-pay-note]', ' NBR-R6D '));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-tax-pay-save]'),
    fertig: (x, v) => neueZeilen('tax_payments', v.ids).length === 1,
    zu: () => `!${q('[data-tax-pay-save]')}`,
    keys: ['amount', 'note', 'paidAt', 'quarter', 'source', 'year'],
    rumpf: (p) => p.amount === 30 && p.note === 'NBR-R6D' && p.source === 'cash' && p.year === JAHR && p.quarter === QUARTAL && p.paidAt === HEUTE,
    zustand: (x, v) => neueZeilen('tax_payments', v.ids),
    buchungsZeilen: 2,
  });
  {
    const z = dbQ(BIZ_DB, 'SELECT year, quarter, amount, source, note FROM tax_payments ORDER BY created_at');
    ok(z.length === 2 && z.every((r) => Number(r.amount) === 30 && r.source === 'cash' && r.note === 'NBR-R6D' && Number(r.quarter) === QUARTAL),
      `TAX genau zwei Steuerzahlungen im Haus (eine je Rechner, die verlorene Antwort nicht doppelt) (${S(z)})`);
  }
  console.log('CENTRAL_UI_R6D_TAX_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // MONEY — Umbuchung, Gesellschafter, Darlehen anlegen/zurückzahlen/berichtigen
  // ══════════════════════════════════════════════════════════════════════
  await paar({
    name: 'BANK', op: 'banking.transfer',
    route: () => '/banking',
    bereit: () => q('[data-bank-transfer-open]'),
    vorher: () => ({ ids: idSet('bank_transfers') }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-bank-transfer-open]')];
      if (!(await warteBis(c, q('[data-bank-transfer-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await klick(c, '[data-bank-transfer-from="cash"]'));
      r.push(await klick(c, '[data-bank-transfer-to="bank"]'));
      r.push(await setVal(c, '[data-bank-transfer-amount]', '12.5'));
      r.push(await setVal(c, '[data-bank-transfer-date]', HEUTE));
      r.push(await setVal(c, '[data-bank-transfer-notes]', 'R6D Umbuchung'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-bank-transfer-save]'),
    fertig: (x, v) => neueZeilen('bank_transfers', v.ids).length === 1,
    zu: () => `!${q('[data-bank-transfer-save]')}`,
    keys: ['amount', 'direction', 'notes', 'transferDate'],
    rumpf: (p) => p.direction === 'CASH_TO_BANK' && p.amount === 12.5 && p.transferDate === HEUTE && p.notes === 'R6D Umbuchung',
    zustand: (x, v) => neueZeilen('bank_transfers', v.ids),
    buchungsZeilen: 2,
  });

  await paar({
    name: 'PARTNER', op: 'partners.record_tx',
    route: () => '/partners',
    bereit: (x) => `document.body.innerText.includes(${S(`R6D Partner ${x}`)}) && ${q('[data-partner-tx-open="INVESTMENT"]')}`,
    vorher: () => ({ ids: idSet('partner_transactions') }),
    fuellen: async (c, x) => {
      const r = [await klickInKarte(c, `R6D Partner ${x}`, '[data-partner-tx-open="INVESTMENT"]')];
      if (!(await warteBis(c, q('[data-partner-tx-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await setVal(c, '[data-partner-tx-amount]', '100'));
      r.push(await setVal(c, '[data-partner-tx-date]', HEUTE));
      r.push(await klick(c, '[data-partner-tx-method="cash"]'));
      r.push(await setVal(c, '[data-partner-tx-notes]', 'R6D Einlage'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-partner-tx-save]'),
    fertig: (x, v) => neueZeilen('partner_transactions', v.ids).length === 1,
    zu: () => `!${q('[data-partner-tx-save]')}`,
    keys: ['amount', 'date', 'kind', 'method', 'notes', 'partnerId'],
    rumpf: (p) => p.partnerId === PARTNER('C') && p.kind === 'INVESTMENT' && p.amount === 100 && p.method === 'cash' && p.date === HEUTE,
    zustand: (x, v) => neueZeilen('partner_transactions', v.ids),
  });

  await paar({
    name: 'DEBT-CREATE', op: 'debts.create',
    route: () => '/debts',
    bereit: () => q('[data-debt-create-open]'),
    vorher: () => ({ ids: idSet('debts') }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-debt-create-open]')];
      if (!(await warteBis(c, q('[data-debt-create-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await klick(c, '[data-debt-create-direction="we_lend"]'));
      r.push(await waehle(c, '[data-debt-create-customer]', KUNDE(x)));
      r.push(await setVal(c, '[data-debt-create-amount]', '300'));
      r.push(await setVal(c, '[data-debt-create-due]', tag(30)));
      r.push(await klick(c, '[data-debt-create-source="cash"]'));
      r.push(await setVal(c, '[data-debt-create-notes]', 'R6D Darlehen'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-debt-create-save]'),
    fertig: (x, v) => neueZeilen('debts', v.ids).length === 1,
    zu: () => `!${q('[data-debt-create-save]')}`,
    keys: ['amount', 'customerId', 'direction', 'dueDate', 'notes', 'source'],
    rumpf: (p) => p.customerId === KUNDE('C') && p.amount === 300 && p.direction === 'we_lend' && p.source === 'cash' && p.dueDate === tag(30) && p.notes === 'R6D Darlehen',
    zustand: (x, v) => { const r = neueZeilen('debts', v.ids); DEBT[x] = r[0]?.id; return r; },
  });

  const debtZahlungen = (id) => dbQ(BIZ_DB, 'SELECT amount, source, paid_at, notes FROM debt_payments WHERE debt_id = ? ORDER BY created_at', [id]);
  await paar({
    name: 'DEBT-PAY', op: 'debts.record_payment', lost: '[data-save-error]',
    route: () => '/debts',
    bereit: (x) => q(`[data-debt-row="${DEBT[x]}"]`),
    vorher: (x) => ({ rev: Number(zeile('debts', DEBT[x]).revision), n: debtZahlungen(DEBT[x]).length }),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-debt-row="${DEBT[x]}"]`)];
      if (!(await warteBis(c, q('[data-debt-pay-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setVal(c, '[data-debt-pay-amount]', '50'));
      r.push(await setVal(c, '[data-debt-pay-date]', HEUTE));
      r.push(await klick(c, '[data-debt-pay-source="bank"]'));
      r.push(await setVal(c, '[data-debt-pay-note]', 'R6D Rate'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-debt-pay-save]'),
    fertig: (x, v) => debtZahlungen(DEBT[x]).length === v.n + 1,
    zu: () => `${q('[data-debt-pay-amount]')} && ${q('[data-debt-pay-amount]')}.value === ''`,
    keys: ['amount', 'debtId', 'expectedRevision', 'notes', 'paidAt', 'source'],
    rumpf: (p, x, v) => p.debtId === DEBT.C && p.expectedRevision === v.rev && p.amount === 50 && p.source === 'bank' && p.notes === 'R6D Rate' && p.paidAt === HEUTE,
    zustand: (x) => ({ debt: zeile('debts', DEBT[x]), zahlungen: debtZahlungen(DEBT[x]) }),
  });

  // NEG — mehr zurückzahlen als offen: dasselbe Nein auf beiden Rechnern, nichts geschrieben.
  {
    const texte = {};
    for (const x of ['C', 'P']) {
      const seite = x === 'C' ? 'PC2' : 'Primary';
      let c;
      await syncRuhe();
      if (x === 'C') { client = await lade(client, '/debts'); c = client; } else { await gehFrisch(primary, '/debts'); c = primary; }
      await warteBis(c, q(`[data-debt-row="${DEBT[x]}"]`), 30000);
      const n0 = debtZahlungen(DEBT[x]).length;
      const vorC = x === 'C' ? (await buchungen(c)).length : 0;
      const vorA = x === 'C' ? (await antworten(c)).length : 0;
      const r = [await klick(c, `[data-debt-row="${DEBT[x]}"]`)];
      await warteBis(c, q('[data-debt-pay-save]'), 10000);
      await sleep(300);
      r.push(await setVal(c, '[data-debt-pay-amount]', '1000'));
      r.push(await klick(c, '[data-debt-pay-source="cash"]'));
      await sleep(200);
      r.push(await klick(c, '[data-debt-pay-save]'));
      ok(alleOk(r) === 'OK', `NEG [${seite}] Überzahlung eingegeben (${alleOk(r)})`);
      ok(await warteBis(c, "[...document.querySelectorAll('[data-save-error]')].some((e) => /more than what is still open/.test(e.textContent))", 20000),
        `NEG [${seite}] das Nein des Hauses steht in der Maske (${String(await fehlerText(c)).slice(0, 200)})`);
      texte[x] = String(await fehlerText(c, '[data-save-error]'));
      if (x === 'C') {
        const cc = (await buchungen(c)).slice(vorC);
        const an = (await antworten(c)).slice(vorA);
        ok(cc.length === 1 && cc[0].op === 'debts.record_payment' && cc[0].payload.amount === 1000, `NEG [PC2] genau EIN Auftrag (${cc.map((k) => k.op + S(k.payload)).join(',')})`);
        ok(an.length === 1 && an[0].ok === false && an[0].error === 'DEBT_OVERPAYMENT', `NEG [PC2] die Antwort trägt den Code DEBT_OVERPAYMENT (${S(an)})`);
      }
      await sleep(800); await spuelen(primary);
      ok(debtZahlungen(DEBT[x]).length === n0, `NEG [${seite}] nichts geschrieben — keine Zahlung`);
    }
    ok(texte.C === texte.P && /250\.000/.test(texte.C), `NEG PARITAET dieselbe Meldung auf beiden Rechnern (${texte.C} // ${texte.P})`);
  }

  await paar({
    name: 'DEBT-EDIT', op: 'debts.update',
    route: () => '/debts',
    bereit: (x) => q(`[data-debt-row="${DEBT[x]}"]`),
    vorher: (x) => ({ rev: Number(zeile('debts', DEBT[x]).revision) }),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-debt-row="${DEBT[x]}"]`)];
      if (!(await warteBis(c, q('[data-debt-edit-open]'), 10000))) return 'KEIN-EDIT';
      r.push(await klick(c, '[data-debt-edit-open]'));
      if (!(await warteBis(c, q('[data-debt-edit-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await setVal(c, '[data-debt-edit-amount]', '350'));
      r.push(await setVal(c, '[data-debt-edit-notes]', 'R6D geaendert'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-debt-edit-save]'),
    fertig: (x) => Number(zeile('debts', DEBT[x]).amount) === 350 && zeile('debts', DEBT[x]).notes === 'R6D geaendert',
    zu: () => `!${q('[data-debt-edit-save]')}`,
    keys: ['amount', 'debtId', 'expectedRevision', 'notes'],
    rumpf: (p, x, v) => p.debtId === DEBT.C && p.expectedRevision === v.rev && p.amount === 350 && p.notes === 'R6D geaendert',
    zustand: (x) => ({ debt: zeile('debts', DEBT[x]), zahlungen: debtZahlungen(DEBT[x]) }),
  });

  // STALE — PC2 hält das Darlehen offen, der Primary zahlt darauf, PC2 speichert mit der alten Fassung.
  {
    await syncRuhe();
    client = await lade(client, '/debts');
    await warteBis(client, q(`[data-debt-row="${DEBT.C}"]`), 30000);
    await klick(client, `[data-debt-row="${DEBT.C}"]`);
    ok(await warteBis(client, q('[data-debt-pay-save]'), 10000), 'STALE PC2 hat das Darlehen offen');
    const rev0 = Number(zeile('debts', DEBT.C).revision);
    const n0 = debtZahlungen(DEBT.C).length;
    await gehFrisch(primary, '/debts');
    await warteBis(primary, q(`[data-debt-row="${DEBT.C}"]`), 30000);
    const r = [await klick(primary, `[data-debt-row="${DEBT.C}"]`)];
    await warteBis(primary, q('[data-debt-pay-save]'), 10000);
    await sleep(300);
    r.push(await setVal(primary, '[data-debt-pay-amount]', '10'));
    r.push(await klick(primary, '[data-debt-pay-source="cash"]'));
    await sleep(200);
    r.push(await klick(primary, '[data-debt-pay-save]'));
    ok(alleOk(r) === 'OK' && await warteAuf(() => debtZahlungen(DEBT.C).length === n0 + 1 && Number(zeile('debts', DEBT.C).revision) > rev0),
      `STALE der Primary ändert dasselbe Darlehen (Fassung ${rev0} → ${zeile('debts', DEBT.C).revision})`);
    const n1 = debtZahlungen(DEBT.C).length;
    const vorC = (await buchungen(client)).length;
    const vorA = (await antworten(client)).length;
    const r2 = [await setVal(client, '[data-debt-pay-amount]', '20'), await klick(client, '[data-debt-pay-source="cash"]')];
    await sleep(200);
    r2.push(await klick(client, '[data-debt-pay-save]'));
    ok(alleOk(r2) === 'OK', `STALE PC2 speichert mit der alten Fassung (${alleOk(r2)})`);
    ok(await warteBis(client, "[...document.querySelectorAll('[data-save-error]')].some((e) => /changed since you opened it/.test(e.textContent))", 20000),
      `STALE PC2: klares Nein in der Maske — nicht blind überschrieben (${String(await fehlerText(client)).slice(0, 200)})`);
    const cc = (await buchungen(client)).slice(vorC);
    const an = (await antworten(client)).slice(vorA);
    ok(cc.length === 1 && cc[0].op === 'debts.record_payment' && cc[0].payload.expectedRevision === rev0, `STALE der Auftrag nannte die gesehene (alte) Fassung ${rev0} (${cc.map((k) => S(k.payload)).join(',')})`);
    ok(an.length === 1 && an[0].ok === false && an[0].error === 'RECORD_CHANGED', `STALE die Antwort ist RECORD_CHANGED (${S(an)})`);
    await sleep(800); await spuelen(primary);
    ok(debtZahlungen(DEBT.C).length === n1 && !debtZahlungen(DEBT.C).some((z) => Number(z.amount) === 20), 'STALE nichts geschrieben — die Zahlung von PC2 fehlt, die des Primary steht');
  }

  // ══════════════════════════════════════════════════════════════════════
  // PAYABLES — Ausgaben, Daueraufträge, Einkauf, Lieferant
  // ══════════════════════════════════════════════════════════════════════
  const expZahlungen = (id) => dbQ(BIZ_DB, 'SELECT amount, method, paid_at, note, reference FROM expense_payments WHERE expense_id = ? ORDER BY created_at', [id]);
  await paar({
    name: 'EXPENSE-CREATE', op: 'expenses.create',
    route: () => '/expenses',
    bereit: () => q('[data-expense-new-open]'),
    vorher: () => ({ ids: idSet('expenses') }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-expense-new-open]')];
      if (!(await warteBis(c, q('[data-expense-create-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await klick(c, '[data-expense-category="Utilities"]'));
      r.push(await setVal(c, '[data-expense-amount]', '40'));
      r.push(await setVal(c, '[data-expense-date]', HEUTE));
      r.push(await klick(c, '[data-expense-timing="partial"]'));
      if (!(await warteBis(c, q('[data-expense-partial]'), 5000))) return 'KEIN-TEILBETRAG';
      r.push(await setVal(c, '[data-expense-partial]', '15'));
      r.push(await klick(c, '[data-expense-method="cash"]'));
      r.push(await setVal(c, '[data-expense-description]', 'R6D Strom'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-expense-create-save]'),
    fertig: (x, v) => neueZeilen('expenses', v.ids).length === 1,
    zu: () => `!${q('[data-expense-create-save]')}`,
    keys: ['amount', 'category', 'description', 'expenseDate', 'partialAmount', 'paymentMethod', 'timing'],
    rumpf: (p) => p.category === 'Utilities' && p.amount === 40 && p.timing === 'partial' && p.partialAmount === 15 && p.paymentMethod === 'cash' && p.expenseDate === HEUTE,
    zustand: (x, v) => { const e = neueZeilen('expenses', v.ids); EXP[x] = e[0]?.id; return { e, z: expZahlungen(EXP[x]) }; },
    buchungsZeilen: 4,
  });

  await paar({
    name: 'EXPENSE-EDIT', op: 'expenses.update',
    route: () => '/expenses',
    bereit: (x) => q(`[data-expense-row="${EXP[x]}"]`),
    vorher: (x) => ({ rev: Number(zeile('expenses', EXP[x]).revision) }),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-expense-row="${EXP[x]}"]`)];
      if (!(await warteBis(c, q('[data-expense-edit-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setVal(c, '[data-expense-edit-amount]', '45'));
      r.push(await setVal(c, '[data-expense-edit-description]', 'R6D Strom neu'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-expense-edit-save]'),
    fertig: (x) => Number(zeile('expenses', EXP[x]).amount) === 45,
    zu: () => `!${q('[data-expense-edit-save]')}`,
    keys: ['amount', 'description', 'expectedRevision', 'expenseId'],
    rumpf: (p, x, v) => p.expenseId === EXP.C && p.expectedRevision === v.rev && p.amount === 45 && p.description === 'R6D Strom neu',
    zustand: (x) => ({ e: zeile('expenses', EXP[x]), z: expZahlungen(EXP[x]) }),
  });

  await paar({
    name: 'EXPENSE-PAY', op: 'expenses.record_payment', lost: '[data-save-error]',
    route: () => '/expenses',
    bereit: (x) => q(`[data-expense-pay-open="${EXP[x]}"]`),
    vorher: (x) => ({ rev: Number(zeile('expenses', EXP[x]).revision), n: expZahlungen(EXP[x]).length }),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-expense-pay-open="${EXP[x]}"]`)];
      if (!(await warteBis(c, q('[data-expense-pay-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(600);
      r.push(await setVal(c, '[data-expense-pay-amount]', '30'));
      r.push(await klick(c, '[data-expense-pay-method="bank"]'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-expense-pay-save]'),
    fertig: (x, v) => expZahlungen(EXP[x]).length === v.n + 1,
    zu: () => `!${q('[data-expense-pay-save]')}`,
    keys: ['amount', 'expectedRevision', 'expenseId', 'method'],
    rumpf: (p, x, v) => p.expenseId === EXP.C && p.expectedRevision === v.rev && p.amount === 30 && p.method === 'bank',
    zustand: (x) => ({ e: zeile('expenses', EXP[x]), z: expZahlungen(EXP[x]) }),
    buchungsZeilen: 2,
  });

  await paar({
    name: 'TEMPLATE-CREATE', op: 'expenses.template_create',
    route: () => '/expenses',
    bereit: () => q('[data-expense-new-open]'),
    vorher: () => ({ ids: idSet('recurring_expense_templates'), eids: idSet('expenses') }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-expense-new-open]')];
      if (!(await warteBis(c, q('[data-expense-create-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await klick(c, '[data-expense-category="Rent"]'));
      r.push(await setVal(c, '[data-expense-amount]', '500'));
      r.push(await setVal(c, '[data-expense-date]', HEUTE));
      r.push(await klick(c, '[data-expense-timing="now"]'));
      r.push(await klick(c, '[data-expense-method="bank"]'));
      r.push(await setVal(c, '[data-expense-description]', 'R6D Miete'));
      r.push(await klick(c, '[data-expense-recurring]'));
      if (!(await warteBis(c, q('[data-template-day]'), 5000))) return 'KEIN-TAG';
      r.push(await setVal(c, '[data-template-end]', '2027-12-31'));
      await sleep(300);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-expense-create-save]'),
    fertig: (x, v) => neueZeilen('recurring_expense_templates', v.ids).length === 1,
    zu: () => `!${q('[data-expense-create-save]')}`,
    keys: ['amount', 'category', 'dayOfMonth', 'description', 'endDate', 'payNowDefault', 'paymentMethod', 'startDate'],
    rumpf: (p) => p.category === 'Rent' && p.amount === 500 && p.payNowDefault === true && p.paymentMethod === 'bank'
      && p.dayOfMonth === Number(HEUTE.slice(8)) && p.startDate === HEUTE && p.endDate === '2027-12-31' && p.description === 'R6D Miete',
    zustand: (x, v) => {
      const t = neueZeilen('recurring_expense_templates', v.ids);
      TPL[x] = t[0]?.id;
      return { t, e: neueZeilen('expenses', v.eids) };
    },
  });
  ok(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM expenses WHERE recurring_template_id IN (?, ?)', [TPL.C, TPL.P])[0]?.n === 2,
    'TEMPLATE-CREATE der laufende Monat ist je Vorlage genau einmal angelegt (in derselben Buchung)');

  await paar({
    name: 'TEMPLATE-PAUSE', op: 'expenses.template_update',
    route: () => '/expenses',
    bereit: (x) => q(`[data-template-toggle="${TPL[x]}"]`),
    vorher: (x) => ({ rev: Number(zeile('recurring_expense_templates', TPL[x]).revision) }),
    fuellen: async () => 'OK',
    speichern: (c, x) => klick(c, `[data-template-toggle="${TPL[x]}"]`),
    fertig: (x) => Number(zeile('recurring_expense_templates', TPL[x]).active) === 0,
    zu: (x) => `${q(`[data-template-toggle="${TPL[x]}"]`)}?.getAttribute('data-template-active') === '0'`,
    keys: ['active', 'expectedRevision', 'templateId'],
    rumpf: (p, x, v) => p.templateId === TPL.C && p.active === false && p.expectedRevision === v.rev,
    zustand: (x) => zeile('recurring_expense_templates', TPL[x]),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'TEMPLATE-EDIT', op: 'expenses.template_update',
    route: () => '/expenses',
    bereit: (x) => q(`[data-template-edit="${TPL[x]}"]`),
    vorher: (x) => ({ rev: Number(zeile('recurring_expense_templates', TPL[x]).revision) }),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-template-edit="${TPL[x]}"]`)];
      if (!(await warteBis(c, q('[data-template-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await setVal(c, '[data-template-edit-amount]', '550'));
      r.push(await setVal(c, '[data-template-edit-day]', '15'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-template-save]'),
    fertig: (x) => Number(zeile('recurring_expense_templates', TPL[x]).amount) === 550 && Number(zeile('recurring_expense_templates', TPL[x]).day_of_month) === 15,
    zu: () => `!${q('[data-template-save]')}`,
    keys: ['amount', 'dayOfMonth', 'expectedRevision', 'templateId'],
    rumpf: (p, x, v) => p.templateId === TPL.C && p.amount === 550 && p.dayOfMonth === 15 && p.expectedRevision === v.rev,
    zustand: (x) => zeile('recurring_expense_templates', TPL[x]),
    buchungsZeilen: 0,
  });

  const purZahlungen = (id) => dbQ(BIZ_DB, 'SELECT amount, method, paid_at, reference, note FROM purchase_payments WHERE purchase_id = ? ORDER BY created_at', [id]);
  await paar({
    name: 'PURCHASE-PAY', op: 'purchases.record_payment',
    route: (x) => `/purchases/${PUR(x)}`,
    bereit: () => q('[data-purchase-pay-open]'),
    vorher: (x) => ({ rev: Number(zeile('purchases', PUR(x)).revision) }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-purchase-pay-open]')];
      if (!(await warteBis(c, q('[data-purchase-pay-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await setVal(c, '[data-purchase-pay-amount]', '80'));
      r.push(await klick(c, '[data-purchase-pay-method="bank"]'));
      await sleep(150);
      r.push(await setVal(c, '[data-purchase-pay-reference]', 'TT-R6D'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-purchase-pay-save]'),
    fertig: (x) => purZahlungen(PUR(x)).length === 1,
    zu: () => `!${q('[data-purchase-pay-amount]')}`,
    keys: ['amount', 'expectedRevision', 'method', 'purchaseId', 'reference'],
    rumpf: (p, x, v) => p.purchaseId === PUR('C') && p.amount === 80 && p.method === 'bank' && p.reference === 'TT-R6D' && p.expectedRevision === v.rev,
    zustand: (x) => ({ p: zeile('purchases', PUR(x)), z: purZahlungen(PUR(x)) }),
  });

  await paar({
    name: 'PURCHASE-CREDIT', op: 'purchases.apply_credit',
    route: (x) => `/purchases/${PUR(x)}`,
    bereit: () => q('[data-purchase-pay-open]'),
    vorher: (x) => ({ rev: Number(zeile('purchases', PUR(x)).revision) }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-purchase-pay-open]')];
      if (!(await warteBis(c, q('[data-purchase-pay-amount]'), 10000))) return 'KEINE-MASKE';
      if (!(await warteBis(c, `${q('[data-purchase-pay-method="credit"]')} && !${q('[data-purchase-pay-method="credit"]')}.disabled`, 15000))) return 'KEIN-GUTHABEN';
      r.push(await klick(c, '[data-purchase-pay-method="credit"]'));
      if (!(await warteBis(c, q('[data-purchase-credit-save]'), 5000))) return 'KEIN-GUTHABEN-KNOPF';
      r.push(await setVal(c, '[data-purchase-pay-amount]', '120'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-purchase-credit-save]'),
    fertig: (x) => zeile('purchases', PUR(x)).status === 'PAID',
    zu: () => `!${q('[data-purchase-pay-amount]')}`,
    keys: ['amount', 'expectedRevision', 'purchaseId'],
    rumpf: (p, x, v) => p.purchaseId === PUR('C') && p.amount === 120 && p.expectedRevision === v.rev,
    zustand: (x) => ({ p: zeile('purchases', PUR(x)), z: purZahlungen(PUR(x)), k2: zeile('supplier_credits', K2(x)) }),
  });

  await paar({
    name: 'SUPPLIER-PAY', op: 'suppliers.pay', lost: '[data-save-error]',
    route: (x) => `/suppliers/${LIEF(x)}`,
    bereit: () => q('[data-supplier-pay-open]'),
    vorher: () => ({ kids: idSet('supplier_credits') }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-supplier-pay-open]')];
      if (!(await warteBis(c, q('[data-supplier-pay-amount]'), 10000))) return 'KEINE-MASKE';
      await sleep(500);
      r.push(await setVal(c, '[data-supplier-pay-amount]', '150'));
      r.push(await klick(c, '[data-supplier-pay-method="bank"]'));
      if (!(await warteBis(c, `${q('[data-supplier-pay-save]')} && !${q('[data-supplier-pay-save]')}.disabled`, 10000))) return 'KNOPF-GESPERRT';
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-supplier-pay-save]'),
    fertig: (x, v) => zeile('expenses', EXP1(x)).status === 'PAID' && zeile('expenses', EXP2(x)).status === 'PAID'
      && neueZeilen('supplier_credits', v.kids, 'supplier_id = ? AND source_purchase_id IS NULL AND source_return_id IS NULL', [LIEF(x)]).length === 1,
    zu: () => `!${q('[data-supplier-pay-amount]')}`,
    keys: ['amount', 'method', 'mode', 'supplierId'],
    rumpf: (p) => p.supplierId === LIEF('C') && p.amount === 150 && p.method === 'bank' && p.mode === 'fifo',
    zustand: (x, v) => {
      const k = neueZeilen('supplier_credits', v.kids, 'supplier_id = ?', [LIEF(x)]);
      K1[x] = k[0]?.id;
      return { e1: zeile('expenses', EXP1(x)), e2: zeile('expenses', EXP2(x)), z1: expZahlungen(EXP1(x)), z2: expZahlungen(EXP2(x)), k };
    },
  });
  ok(!!K1.C && !!K1.P && Number(zeile('supplier_credits', K1.C).amount) === 50, `SUPPLIER-PAY der Überschuss (50) wurde je Rechner EIN Lieferanten-Guthaben (${S(zeile('supplier_credits', K1.C))})`);

  await paar({
    name: 'SUPPLIER-REFUND', op: 'suppliers.refund_credit',
    route: (x) => `/suppliers/${LIEF(x)}`,
    bereit: (x) => q(`[data-supplier-refund-open="${K1[x]}"]`),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-supplier-refund-open="${K1[x]}"]`)];
      if (!(await warteBis(c, q('[data-supplier-refund-save]'), 10000))) return 'KEINE-MASKE';
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-supplier-refund-save]'),
    fertig: (x) => !zeile('supplier_credits', K1[x]).id,
    zu: () => `!${q('[data-supplier-refund-save]')}`,
    keys: ['creditId'],
    rumpf: (p) => p.creditId === K1.C,
    zustand: (x) => ({ weg: !zeile('supplier_credits', K1[x]).id, offen: dbQ(BIZ_DB, 'SELECT amount, used_amount, status, note FROM supplier_credits WHERE supplier_id = ?', [LIEF(x)]) }),
    buchungsZeilen: 2,
  });
  console.log('CENTRAL_UI_R6D_FINANCE_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // GOLD — begleichen (Werkstatt, Laden, Geld), Kundengold, Gold-Verbrauch, Material, Kosten
  // ══════════════════════════════════════════════════════════════════════
  const bewegungen = (id) => dbQ(BIZ_DB, 'SELECT direction, weight_grams, karat, source_bucket, source_id, target_bucket, target_id, related_repair_id, notes FROM gold_movements WHERE source_id = ? OR target_id = ? ORDER BY moved_at', [id, id]);
  const settleFuellen = (oeffner, felder) => async (c) => {
    const r = [await klick(c, oeffner)];
    if (!(await warteBis(c, q('[data-gold-settle-confirm]'), 10000))) return 'KEINE-MASKE';
    await sleep(400);
    for (const [sel, wert] of felder) r.push(await setVal(c, sel, wert));
    await sleep(250);
    return alleOk(r);
  };
  await paar({
    name: 'GOLD-RETURN', op: 'gold.payables.settle', lost: '[data-gold-settle-error]',
    route: (x) => `/repairs/${REP(x)}`,
    bereit: () => q('[data-gold-settle-open="settle_supplier_return"]'),
    vorher: (x) => ({ rev: Number(zeile('gold_payables', GP1(x)).revision), bestand: bestand21() }),
    fuellen: settleFuellen('[data-gold-settle-open="settle_supplier_return"]', [['[data-gold-settle-grams]', '4'], ['[data-gold-settle-notes]', 'R6D Rueckgabe']]),
    speichern: (c) => klick(c, '[data-gold-settle-confirm]'),
    fertig: (x) => Number(zeile('gold_payables', GP1(x)).fulfilled_grams) === 4 && bewegungen(GP1(x)).length === 1,
    zu: () => `!${q('[data-gold-settle-confirm]')}`,
    keys: ['expectedRevision', 'grams', 'mode', 'notes', 'payableId'],
    rumpf: (p, x, v) => p.payableId === GP1('C') && p.mode === 'return_gold' && p.grams === 4 && p.notes === 'R6D Rueckgabe' && p.expectedRevision === v.rev,
    zustand: (x, v) => ({ gp: zeile('gold_payables', GP1(x)), bestandDelta: Math.round((bestand21() - v.bestand) * 1000) / 1000, bew: bewegungen(GP1(x)) }),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'GOLD-MONEY', op: 'gold.payables.settle',
    route: (x) => `/repairs/${REP(x)}`,
    bereit: () => q('[data-gold-settle-open="convert_supplier_money"]'),
    vorher: (x) => ({ rev: Number(zeile('gold_payables', GP1(x)).revision), eids: idSet('expenses') }),
    fuellen: settleFuellen('[data-gold-settle-open="convert_supplier_money"]', [['[data-gold-settle-bhd]', '30'], ['[data-gold-settle-notes]', 'R6D in Geld']]),
    speichern: (c) => klick(c, '[data-gold-settle-confirm]'),
    fertig: (x, v) => zeile('gold_payables', GP1(x)).status === 'FULFILLED' && neueZeilen('expenses', v.eids).length === 1,
    zu: () => `!${q('[data-gold-settle-confirm]')}`,
    keys: ['agreedBhd', 'expectedRevision', 'mode', 'notes', 'payableId'],
    rumpf: (p, x, v) => p.payableId === GP1('C') && p.mode === 'money' && p.agreedBhd === 30 && p.expectedRevision === v.rev,
    zustand: (x, v) => ({ gp: zeile('gold_payables', GP1(x)), e: neueZeilen('expenses', v.eids), bew: bewegungen(GP1(x)) }),
    buchungsZeilen: 2,
  });

  await paar({
    name: 'GOLD-SHOP', op: 'gold.payables.settle',
    route: (x) => `/orders/${ORD(x)}`,
    bereit: () => q('[data-gold-settle-open="apply_shop_to_supplier"]'),
    vorher: (x) => ({ rev: Number(zeile('gold_payables', GP2(x)).revision), bestand: bestand21() }),
    fuellen: settleFuellen('[data-gold-settle-open="apply_shop_to_supplier"]', [['[data-gold-settle-grams]', '5']]),
    speichern: (c) => klick(c, '[data-gold-settle-confirm]'),
    fertig: (x) => zeile('gold_payables', GP2(x)).status === 'FULFILLED' && bewegungen(GP2(x)).length === 1,
    zu: () => `!${q('[data-gold-settle-confirm]')}`,
    keys: ['expectedRevision', 'grams', 'mode', 'payableId'],
    rumpf: (p, x, v) => p.payableId === GP2('C') && p.mode === 'shop_gold' && p.grams === 5 && p.expectedRevision === v.rev,
    zustand: (x, v) => ({ gp: zeile('gold_payables', GP2(x)), bestandDelta: Math.round((bestand21() - v.bestand) * 1000) / 1000, bew: bewegungen(GP2(x)) }),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'CREDIT-RETURN', op: 'gold.customer_credits.settle',
    route: (x) => `/repairs/${REP(x)}`,
    bereit: () => q('[data-gold-settle-open="return_customer"]'),
    vorher: (x) => ({ rev: Number(zeile('customer_gold_credits', CGC(x)).revision) }),
    fuellen: settleFuellen('[data-gold-settle-open="return_customer"]', [['[data-gold-settle-grams]', '3']]),
    speichern: (c) => klick(c, '[data-gold-settle-confirm]'),
    fertig: (x) => Number(zeile('customer_gold_credits', CGC(x)).fulfilled_grams) === 3,
    zu: () => `!${q('[data-gold-settle-confirm]')}`,
    keys: ['creditId', 'expectedRevision', 'grams', 'mode'],
    rumpf: (p, x, v) => p.creditId === CGC('C') && p.mode === 'return' && p.grams === 3 && p.expectedRevision === v.rev,
    zustand: (x) => ({ cgc: zeile('customer_gold_credits', CGC(x)), bew: bewegungen(CGC(x)) }),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'CREDIT-MONEY', op: 'gold.customer_credits.settle',
    route: (x) => `/repairs/${REP(x)}`,
    bereit: () => q('[data-gold-settle-open="convert_customer_money"]'),
    vorher: (x) => ({ rev: Number(zeile('customer_gold_credits', CGC(x)).revision), ids: idSet('customer_credits') }),
    fuellen: settleFuellen('[data-gold-settle-open="convert_customer_money"]', [['[data-gold-settle-bhd]', '40']]),
    speichern: (c) => klick(c, '[data-gold-settle-confirm]'),
    fertig: (x, v) => zeile('customer_gold_credits', CGC(x)).status === 'FULFILLED' && neueZeilen('customer_credits', v.ids).length === 1,
    zu: () => `!${q('[data-gold-settle-confirm]')}`,
    keys: ['agreedBhd', 'creditId', 'expectedRevision', 'mode'],
    rumpf: (p, x, v) => p.creditId === CGC('C') && p.mode === 'money' && p.agreedBhd === 40 && p.expectedRevision === v.rev,
    zustand: (x, v) => ({ cgc: zeile('customer_gold_credits', CGC(x)), cc: neueZeilen('customer_credits', v.ids), bew: bewegungen(CGC(x)) }),
    buchungsZeilen: 2,
  });

  await paar({
    name: 'GOLD-USAGE-WORKSHOP', op: 'repairs.record_gold_usage',
    route: (x) => `/repairs/${REP(x)}`,
    bereit: () => q('[data-gold-usage-open]'),
    vorher: (x) => ({ ids: idSet('gold_payables'), rev: Number(zeile('repairs', REP(x)).revision) }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-gold-usage-open]')];
      if (!(await warteBis(c, q('[data-gold-usage-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await klick(c, '[data-gold-usage-source="workshop"]'));
      r.push(await setVal(c, '[data-gold-usage-received]', '7'));
      r.push(await setVal(c, '[data-gold-usage-karat]', '21K'));
      r.push(await waehle(c, '[data-gold-usage-supplier]', LIEF(x)));
      r.push(await klick(c, '[data-gold-usage-settlement="return_gold"]'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-gold-usage-save]'),
    fertig: (x, v) => neueZeilen('gold_payables', v.ids, 'source_repair_id = ?', [REP(x)]).length === 1,
    zu: () => `!${q('[data-gold-usage-save]')}`,
    keys: ['expectedRevision', 'karat', 'receivedGrams', 'repairId', 'settlementType', 'source', 'supplierId'],
    rumpf: (p, x, v) => p.repairId === REP('C') && p.source === 'workshop' && p.karat === '21K' && p.receivedGrams === 7 && p.supplierId === LIEF('C') && p.settlementType === 'return_gold' && p.expectedRevision === v.rev,
    zustand: (x, v) => neueZeilen('gold_payables', v.ids),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'GOLD-USAGE-CUSTOMER', op: 'repairs.record_gold_usage',
    route: (x) => `/repairs/${REP(x)}`,
    bereit: () => q('[data-gold-usage-open]'),
    vorher: (x) => ({ ids: idSet('customer_gold_credits'), rev: Number(zeile('repairs', REP(x)).revision) }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-gold-usage-open]')];
      if (!(await warteBis(c, q('[data-gold-usage-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await klick(c, '[data-gold-usage-source="customer"]'));
      if (!(await warteBis(c, q('[data-gold-usage-used]'), 5000))) return 'KEIN-VERBRAUCH';
      r.push(await setVal(c, '[data-gold-usage-received]', '10'));
      r.push(await setVal(c, '[data-gold-usage-karat]', '22K'));
      r.push(await setVal(c, '[data-gold-usage-used]', '6'));
      r.push(await klick(c, '[data-gold-usage-leftover="credit"]'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-gold-usage-save]'),
    fertig: (x, v) => neueZeilen('customer_gold_credits', v.ids, 'source_repair_id = ?', [REP(x)]).length === 1,
    zu: () => `!${q('[data-gold-usage-save]')}`,
    keys: ['expectedRevision', 'karat', 'leftover', 'receivedGrams', 'repairId', 'source', 'usedGrams'],
    rumpf: (p, x, v) => p.repairId === REP('C') && p.source === 'customer' && p.karat === '22K' && p.receivedGrams === 10 && p.usedGrams === 6 && p.leftover === 'credit' && p.expectedRevision === v.rev,
    zustand: (x, v) => neueZeilen('customer_gold_credits', v.ids),
    buchungsZeilen: 0,
  });
  ok(Number(neueZeilen('customer_gold_credits', new Set([CGC('C'), CGC('P')]), 'source_repair_id = ?', [REP('C')])[0]?.weight_grams) === 4,
    'GOLD-USAGE-CUSTOMER der Rest (10 − 6 = 4 g) wurde Kundenguthaben');

  const ROW_DIAMANT = ['caratPerPiece', 'description', 'materialKind', 'quantity', 'supplierId', 'totalCost'];
  await paar({
    name: 'REPAIR-MATERIAL', op: 'repairs.add_material',
    route: (x) => `/repairs/${REP(x)}`,
    bereit: () => q('[data-material-open]'),
    vorher: (x) => ({ ids: idSet('repair_lines'), eids: idSet('expenses'), rev: Number(zeile('repairs', REP(x)).revision) }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-material-open]')];
      if (!(await warteBis(c, q('[data-material-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await klick(c, '[data-material-kind="diamond"]'));
      r.push(await setVal(c, '[data-material-description]', 'R6D Brillant'));
      r.push(await setVal(c, '[data-material-quantity]', '2'));
      r.push(await setVal(c, '[data-material-carat]', '0.5'));
      r.push(await setVal(c, '[data-material-cost]', '120'));
      r.push(await waehle(c, '[data-material-source]', LIEF(x)));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-material-save]'),
    fertig: (x, v) => { const l = neueZeilen('repair_lines', v.ids, 'repair_id = ?', [REP(x)]); return l.length === 1 && !!l[0].expense_id; },
    zu: () => `!${q('[data-material-save]')}`,
    keys: ['expectedRevision', 'repairId', 'rows'],
    rumpf: (p, x, v) => p.repairId === REP('C') && p.expectedRevision === v.rev && Array.isArray(p.rows) && p.rows.length === 1
      && S(Object.keys(p.rows[0]).sort()) === S(ROW_DIAMANT) && p.rows[0].materialKind === 'diamond' && p.rows[0].quantity === 2
      && p.rows[0].caratPerPiece === 0.5 && p.rows[0].totalCost === 120 && p.rows[0].supplierId === LIEF('C'),
    zustand: (x, v) => ({ l: neueZeilen('repair_lines', v.ids), e: neueZeilen('expenses', v.eids) }),
  });

  await paar({
    name: 'ORDER-ADD-COST', op: 'orders.add_cost',
    route: (x) => `/orders/${ORD(x)}`,
    bereit: () => q('[data-order-add-cost-open]'),
    vorher: (x) => ({ ids: idSet('order_lines'), eids: idSet('expenses'), gids: idSet('gold_payables'), rev: Number(zeile('orders', ORD(x)).revision) }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-order-add-cost-open]')];
      if (!(await warteBis(c, q('[data-material-save]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      // Position 1: Arbeit beim Lieferanten → A/P
      r.push(await klick(c, '[data-material-kind="labor"]'));
      r.push(await setVal(c, '[data-material-description]', 'R6D Fassen'));
      r.push(await setVal(c, '[data-material-cost]', '80'));
      r.push(await waehle(c, '[data-material-source]', LIEF(x)));
      r.push(await klick(c, '[data-material-add-to-list]'));
      await sleep(300);
      // Position 2: ein Stein (wird danach wieder gelöscht)
      r.push(await klick(c, '[data-material-kind="diamond"]'));
      r.push(await setVal(c, '[data-material-description]', 'R6D Stein'));
      r.push(await setVal(c, '[data-material-quantity]', '1'));
      r.push(await setVal(c, '[data-material-carat]', '0.3'));
      r.push(await setVal(c, '[data-material-cost]', '45'));
      r.push(await waehle(c, '[data-material-source]', LIEF(x)));
      r.push(await klick(c, '[data-material-add-to-list]'));
      await sleep(300);
      // Position 3: Goldschmied-Gold → Gramm-Schuld statt Geld
      r.push(await klick(c, '[data-material-kind="gold"]'));
      r.push(await setVal(c, '[data-material-description]', 'R6D Gold'));
      r.push(await setVal(c, '[data-material-grams]', '3'));
      r.push(await klick(c, '[data-material-karat="21K"]'));
      await sleep(200);
      r.push(await setVal(c, '[data-material-cost]', '60'));
      r.push(await waehle(c, '[data-material-source]', LIEF(x)));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-material-save]'),
    fertig: (x, v) => neueZeilen('order_lines', v.ids, 'order_id = ?', [ORD(x)]).length === 3,
    zu: () => `!${q('[data-material-save]')}`,
    keys: ['expectedRevision', 'orderId', 'rows'],
    rumpf: (p, x, v) => p.orderId === ORD('C') && p.expectedRevision === v.rev && Array.isArray(p.rows) && p.rows.length === 3
      && S(p.rows.map((r) => r.materialKind)) === S(['labor', 'diamond', 'gold'])
      && S(Object.keys(p.rows[0]).sort()) === S(['description', 'materialKind', 'supplierId', 'totalCost'])
      && S(Object.keys(p.rows[2]).sort()) === S(['description', 'karat', 'materialKind', 'quantity', 'supplierId', 'totalCost', 'weightGrams'])
      && p.rows[2].weightGrams === 3 && p.rows[2].karat === '21K' && p.rows.every((r) => r.supplierId === LIEF('C')),
    zustand: (x, v) => {
      const l = neueZeilen('order_lines', v.ids, 'order_id = ?', [ORD(x)]);
      LINE_STEIN[x] = l.find((z) => z.material_kind === 'diamond')?.id;
      return { l, e: neueZeilen('expenses', v.eids), g: neueZeilen('gold_payables', v.gids) };
    },
  });

  await paar({
    name: 'ORDER-REMOVE-COST', op: 'orders.remove_cost',
    route: (x) => `/orders/${ORD(x)}`,
    bereit: (x) => q(`[data-order-cost-remove="${LINE_STEIN[x]}"]`),
    vorher: (x) => ({ exp: zeile('order_lines', LINE_STEIN[x]).expense_id, rev: Number(zeile('orders', ORD(x)).revision) }),
    fuellen: async () => 'OK',
    speichern: (c, x) => klick(c, `[data-order-cost-remove="${LINE_STEIN[x]}"]`),
    fertig: (x) => !zeile('order_lines', LINE_STEIN[x]).id,
    zu: (x) => `!${q(`[data-order-cost-remove="${LINE_STEIN[x]}"]`)}`,
    keys: ['expectedRevision', 'lineId', 'orderId'],
    rumpf: (p, x, v) => p.orderId === ORD('C') && p.lineId === LINE_STEIN.C && p.expectedRevision === v.rev,
    zustand: (x, v) => ({ weg: !zeile('order_lines', LINE_STEIN[x]).id, e: v.exp ? zeile('expenses', v.exp) : null, rest: dbQ(BIZ_DB, 'SELECT material_kind, cost_amount, status FROM order_lines WHERE order_id = ?', [ORD(x)]) }),
  });

  await paar({
    name: 'SUPPLIER-CREDIT', op: 'suppliers.apply_credit',
    route: (x) => `/suppliers/${LIEF(x)}`,
    bereit: () => q('[data-supplier-pay-open]'),
    vorher: () => ({ pids: idSet('expense_payments') }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-supplier-pay-open]')];
      if (!(await warteBis(c, q('[data-supplier-pay-amount]'), 10000))) return 'KEINE-MASKE';
      if (!(await warteBis(c, `${q('[data-supplier-pay-method="credit"]')} && !${q('[data-supplier-pay-method="credit"]')}.disabled`, 15000))) return 'KEIN-GUTHABEN';
      r.push(await klick(c, '[data-supplier-pay-method="credit"]'));
      if (!(await warteBis(c, q('[data-supplier-credit-save]'), 5000))) return 'KEIN-GUTHABEN-KNOPF';
      await sleep(300);
      r.push(await setVal(c, '[data-supplier-pay-amount]', '30'));
      if (!(await warteBis(c, `!${q('[data-supplier-credit-save]')}.disabled`, 5000))) return 'KNOPF-GESPERRT';
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-supplier-credit-save]'),
    fertig: (x) => Number(zeile('supplier_credits', K2(x)).used_amount) === 150,
    zu: () => `!${q('[data-supplier-pay-amount]')}`,
    keys: ['amount', 'supplierId'],
    rumpf: (p) => p.supplierId === LIEF('C') && p.amount === 30,
    zustand: (x, v) => ({ k2: zeile('supplier_credits', K2(x)), z: neueZeilen('expense_payments', v.pids, "method = 'credit'") }),
  });
  console.log('CENTRAL_UI_R6D_GOLD_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // METALS — anlegen, Spotpreis, verkaufen, einschmelzen
  // ══════════════════════════════════════════════════════════════════════
  await paar({
    name: 'METAL-CREATE', op: 'metals.create',
    route: () => '/metals',
    bereit: () => q('[data-metal-new-open]'),
    vorher: () => ({ ids: idSet('precious_metals'), gids: idSet('gold_movements'), eids: idSet('expenses') }),
    fuellen: async (c, x) => {
      const r = [await klick(c, '[data-metal-new-open]')];
      if (!(await warteBis(c, q('[data-metal-save]'), 10000))) return 'KEINE-MASKE';
      r.push(await klick(c, '[data-metal-type="gold"]'));
      r.push(await klick(c, '[data-metal-karat="22K"]'));
      r.push(await setVal(c, '[data-metal-weight]', '12.5'));
      r.push(await setVal(c, '[data-metal-purchase-total]', '70'));
      r.push(await setVal(c, '[data-metal-price-per-gram]', '5.6'));
      r.push(await waehle(c, '[data-metal-supplier]', LIEF(x)));
      r.push(await setVal(c, '[data-metal-description]', 'R6D Barren'));
      r.push(await setVal(c, '[data-metal-notes]', 'R6D Notiz'));
      await sleep(250);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-metal-save]'),
    fertig: (x, v) => neueZeilen('precious_metals', v.ids, "description = 'R6D Barren'").length === 1,
    zu: () => `!${q('[data-metal-save]')}`,
    keys: ['description', 'karat', 'metalType', 'notes', 'purchasePricePerGram', 'purchaseTotal', 'supplierId', 'supplierName', 'weightGrams'],
    rumpf: (p) => p.metalType === 'gold' && p.karat === '22K' && p.weightGrams === 12.5 && p.purchaseTotal === 70 && p.purchasePricePerGram === 5.6
      && p.supplierId === LIEF('C') && p.supplierName === 'R6D Lief C' && p.description === 'R6D Barren' && p.notes === 'R6D Notiz',
    zustand: (x, v) => ({ m: neueZeilen('precious_metals', v.ids), g: neueZeilen('gold_movements', v.gids), e: neueZeilen('expenses', v.eids) }),
  });

  await paar({
    name: 'METAL-SPOT', op: 'metals.set_spot_price',
    route: () => '/metals',
    bereit: () => q('[data-metal-spot-input="silver"]'),
    fuellen: async () => 'OK',
    speichern: (c, x) => c.ev(`const e=document.querySelector('[data-metal-spot-input="silver"]'); if(!e) return 'NO'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(x === 'C' ? '1.25' : '1.3')}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); return 'OK';`),
    fertig: (x) => spotSilber() === (x === 'C' ? 1.25 : 1.3),
    zu: () => `!document.querySelector('[data-save-error]') && !${q('[data-metal-spot-input="silver"]')}.disabled`,
    keys: ['metalType', 'price'],
    rumpf: (p) => p.metalType === 'silver' && p.price === 1.25,
    zustand: (x) => ({ metall: 'silver', uebernommen: spotSilber() === (x === 'C' ? 1.25 : 1.3) }),
    buchungsZeilen: 0,
  });

  await paar({
    name: 'METAL-SELL', op: 'metals.update_status',
    route: () => '/metals',
    bereit: (x) => q(`[data-metal-row="${SELL(x)}"] [data-metal-sell-open]`),
    vorher: (x) => ({ rev: Number(zeile('precious_metals', SELL(x)).revision) }),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-metal-row="${SELL(x)}"] [data-metal-sell-open]`)];
      if (!(await warteBis(c, q('[data-metal-sell-confirm]'), 10000))) return 'KEINE-MASKE';
      r.push(await setVal(c, '[data-metal-sell-price]', '55'));
      await sleep(250);
      // R6D Accounting-Gate — der Verkauf nennt, wie das Geld hereinkam (Metallzahlung → Kasse, Erlös).
      if (!(await warteBis(c, q('[data-metal-sell-method="cash"]'), 5000))) return 'KEIN-ZAHLWEG';
      r.push(await klick(c, '[data-metal-sell-method="cash"]'));
      await sleep(200);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-metal-sell-confirm]'),
    fertig: (x) => zeile('precious_metals', SELL(x)).status === 'sold',
    zu: () => `!${q('[data-metal-sell-confirm]')}`,
    keys: ['expectedRevision', 'metalId', 'paymentMethod', 'salePrice', 'status'],
    rumpf: (p, x, v) => p.metalId === SELL('C') && p.status === 'sold' && p.salePrice === 55 && p.paymentMethod === 'cash' && p.expectedRevision === v.rev,
    zustand: (x) => {
      const z = zeile('precious_metals', SELL(x));
      const zahlung = dbQ(BIZ_DB, 'SELECT amount, method FROM metal_payments WHERE metal_id = ?', [SELL(x)]);
      return { ...z, zahlung };
    },
    // Soll Kasse 55 / Haben Erlös 55 (METAL_PAYMENT) — vorher schrieb der Verkauf gar keine Buchung.
    buchungsZeilen: 2,
  });

  await paar({
    name: 'METAL-MELT', op: 'metals.update_status',
    route: () => '/metals',
    bereit: (x) => q(`[data-metal-row="${MELT(x)}"] [data-metal-melt-open]`),
    vorher: (x) => ({ rev: Number(zeile('precious_metals', MELT(x)).revision) }),
    fuellen: async (c, x) => {
      const r = [await klick(c, `[data-metal-row="${MELT(x)}"] [data-metal-melt-open]`)];
      if (!(await warteBis(c, q('[data-metal-melt-confirm]'), 10000))) return 'KEINE-MASKE';
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-metal-melt-confirm]'),
    fertig: (x) => zeile('precious_metals', MELT(x)).status === 'melted',
    zu: () => `!${q('[data-metal-melt-confirm]')}`,
    keys: ['expectedRevision', 'metalId', 'status'],
    rumpf: (p, x, v) => p.metalId === MELT('C') && p.status === 'melted' && p.expectedRevision === v.rev,
    zustand: (x) => zeile('precious_metals', MELT(x)),
    buchungsZeilen: 0,
  });
  ok(Number(zeile('precious_metals', MELT('C')).current_spot_price) === 1.3 && Math.abs(Number(zeile('precious_metals', MELT('C')).melt_value) - 100 * 0.925 * 1.3) < 0.001,
    `METAL-MELT das Haus fror SEINEN Spotpreis ein (${zeile('precious_metals', MELT('C')).current_spot_price} / ${zeile('precious_metals', MELT('C')).melt_value})`);

  // ══════════════════════════════════════════════════════════════════════
  // SCRAP — anlegen (verlorene Antwort), ändern, stornieren
  // ══════════════════════════════════════════════════════════════════════
  const scrapStand = (id) => ({
    t: zeile('scrap_trades', id),
    lines: dbQ(BIZ_DB, 'SELECT weight_grams, karat, purchase_price, sale_price, profit, notes, images_purchase, images_sale FROM scrap_trade_lines WHERE scrap_trade_id = ?', [id]),
    pays: dbQ(BIZ_DB, 'SELECT direction, method, amount FROM scrap_trade_payments WHERE scrap_trade_id = ?', [id]),
  });
  await paar({
    name: 'SCRAP-CREATE', op: 'scrap_trades.create', lost: '[data-save-error]',
    route: () => '/scrap-trades/new',
    bereit: () => q('[data-scrap-save="create"]'),
    vorher: () => ({ ids: idSet('scrap_trades') }),
    fuellen: async (c) => {
      const r = [];
      r.push(await setVal(c, '[data-scrap-seller-name]', 'R6D Verkaeufer'));
      r.push(await setVal(c, '[data-scrap-seller-phone]', '+973 3900 0001'));
      r.push(await setVal(c, '[data-scrap-trade-date]', HEUTE));
      r.push(await setVal(c, '[data-scrap-buyer-name]', 'R6D Haendler'));
      r.push(await setVal(c, '[data-scrap-buyer-phone]', '+973 3900 0002'));
      r.push(await setVal(c, '[data-scrap-line="0"] [data-scrap-line-weight]', '5'));
      r.push(await klick(c, '[data-scrap-line="0"] [data-scrap-line-karat="21K"]'));
      r.push(await setVal(c, '[data-scrap-line="0"] [data-scrap-line-purchase]', '100'));
      r.push(await setVal(c, '[data-scrap-line="0"] [data-scrap-line-sale]', '120'));
      r.push(await setVal(c, '[data-scrap-notes]', 'R6D Altgold'));
      r.push(await klick(c, '[data-scrap-pay="out"] [data-scrap-pay-row="0"] [data-scrap-pay-method="cash"]'));
      r.push(await setVal(c, '[data-scrap-pay="out"] [data-scrap-pay-row="0"] [data-scrap-pay-amount]', '100'));
      r.push(await klick(c, '[data-scrap-pay="in"] [data-scrap-pay-row="0"] [data-scrap-pay-method="bank"]'));
      r.push(await setVal(c, '[data-scrap-pay="in"] [data-scrap-pay-row="0"] [data-scrap-pay-amount]', '120'));
      await sleep(300);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-scrap-save="create"]'),
    fertig: (x, v) => neueZeilen('scrap_trades', v.ids).length === 1,
    zu: () => "/^\\/scrap-trades\\/[^/]+$/.test(location.pathname) && !/\\/new$/.test(location.pathname)",
    keys: ['buyerName', 'buyerPhone', 'lines', 'notes', 'paymentsIn', 'paymentsOut', 'sellerName', 'sellerPhone', 'tradeDate'],
    rumpf: (p) => p.sellerName === 'R6D Verkaeufer' && p.buyerName === 'R6D Haendler' && p.tradeDate === HEUTE
      && p.lines.length === 1 && S(Object.keys(p.lines[0]).sort()) === S(['karat', 'purchasePrice', 'salePrice', 'weightGrams'])
      && p.lines[0].karat === '21K' && p.lines[0].weightGrams === 5 && S(p.paymentsOut) === S([{ method: 'cash', amount: 100 }]) && S(p.paymentsIn) === S([{ method: 'bank', amount: 120 }]),
    zustand: (x, v) => { const t = neueZeilen('scrap_trades', v.ids); TRADE[x] = t[0]?.id; return scrapStand(TRADE[x]); },
  });

  await paar({
    name: 'SCRAP-EDIT', op: 'scrap_trades.update',
    route: (x) => `/scrap-trades/${TRADE[x]}`,
    bereit: () => q('[data-scrap-edit-open]'),
    vorher: (x) => ({ version: Number(zeile('scrap_trades', TRADE[x]).version) }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-scrap-edit-open]')];
      if (!(await warteBis(c, q('[data-scrap-save="edit"]'), 10000))) return 'KEINE-MASKE';
      await sleep(300);
      r.push(await setVal(c, '[data-scrap-line="0"] [data-scrap-line-sale]', '130'));
      r.push(await setVal(c, '[data-scrap-pay="in"] [data-scrap-pay-row="0"] [data-scrap-pay-amount]', '130'));
      await sleep(300);
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-scrap-save="edit"]'),
    fertig: (x, v) => Number(zeile('scrap_trades', TRADE[x]).version) === v.version + 1 && Number(zeile('scrap_trades', TRADE[x]).sale_price) === 130,
    zu: () => `${q('[data-scrap-edit-open]')} && !${q('[data-scrap-save="edit"]')}`,
    keys: ['buyerName', 'buyerPhone', 'expectedVersion', 'lines', 'notes', 'paymentsIn', 'paymentsOut', 'sellerName', 'sellerPhone', 'tradeDate', 'tradeId'],
    rumpf: (p, x, v) => p.tradeId === TRADE.C && p.expectedVersion === v.version && p.lines[0].salePrice === 130 && S(p.paymentsIn) === S([{ method: 'bank', amount: 130 }]),
    zustand: (x) => scrapStand(TRADE[x]),
  });

  await paar({
    name: 'SCRAP-CANCEL', op: 'scrap_trades.cancel',
    route: (x) => `/scrap-trades/${TRADE[x]}`,
    bereit: () => q('[data-scrap-cancel-open]'),
    vorher: (x) => ({ version: Number(zeile('scrap_trades', TRADE[x]).version) }),
    fuellen: async (c) => {
      const r = [await klick(c, '[data-scrap-cancel-open]')];
      if (!(await warteBis(c, q('[data-scrap-cancel-confirm]'), 10000))) return 'KEINE-MASKE';
      return alleOk(r);
    },
    speichern: (c) => klick(c, '[data-scrap-cancel-confirm]'),
    fertig: (x) => zeile('scrap_trades', TRADE[x]).status === 'cancelled',
    zu: () => `!${q('[data-scrap-cancel-confirm]')} && document.body.innerText.includes('CANCELLED')`,
    keys: ['expectedVersion', 'tradeId'],
    rumpf: (p, x, v) => p.tradeId === TRADE.C && p.expectedVersion === v.version,
    zustand: (x) => scrapStand(TRADE[x]),
  });
  {
    const offen = (id) => dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM ledger_entries le WHERE le.source_module = 'SCRAP_TRADE' AND le.source_id = ? AND le.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = le.id)", [id])[0]?.n;
    ok(offen(TRADE.C) === 0 && offen(TRADE.P) === 0, 'SCRAP-CANCEL keine offene Buchung mehr — jede Transaktion des Geschäfts ist umgekehrt');
  }
  console.log('CENTRAL_UI_R6D_METALS_RUNTIME_PROVED_CANDIDATE');

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
  // ECHO — der eigene Sync-Lauf des Primary zählt keine Fassung mehr (Befund aus Lauf 1, behoben in
  // `applyUpsert`: ein Echo ohne Änderung wird nicht geschrieben). Der Alltag, der vorher scheiterte:
  // PC2 zahlt, der Primary schiebt und spielt sein Echo ein, PC2 zahlt gleich noch einmal.
  // ══════════════════════════════════════════════════════════════════════
  {
    ok(await syncRuhe(), 'ECHO Ausgangslage: der Primary hat nichts mehr zu schieben');
    client = await lade(client, '/debts');
    await warteBis(client, q(`[data-debt-row="${DEBT.C}"]`), 30000);
    await klick(client, `[data-debt-row="${DEBT.C}"]`);
    await warteBis(client, q('[data-debt-pay-save]'), 10000);
    const n0 = debtZahlungen(DEBT.C).length;
    const r1 = [await setVal(client, '[data-debt-pay-amount]', '1'), await klick(client, '[data-debt-pay-source="cash"]')];
    await sleep(200);
    r1.push(await klick(client, '[data-debt-pay-save]'));
    ok(alleOk(r1) === 'OK' && await warteAuf(() => debtZahlungen(DEBT.C).length === n0 + 1), `ECHO PC2 zahlt 1,000 auf das Darlehen (${String(await fehlerText(client)).slice(0, 160) || 'kein Fehler'})`);
    await sleep(1500);
    const revA = Number(zeile('debts', DEBT.C).revision);
    const TAB = ['debts', 'expenses', 'recurring_expense_templates', 'purchases', 'gold_payables', 'customer_gold_credits', 'precious_metals', 'orders', 'invoices', 'repairs'];
    const stand = () => S(TAB.map((t) => dbQ(BIZ_DB, `SELECT id, revision FROM ${t} ORDER BY id`)));
    const vorher = stand();
    // Ein voller Lauf: der Primary schiebt die Zahlung hoch UND spielt sie als Echo wieder ein.
    const kopfVor = Number(dbQ(SERVER_DB, 'SELECT COALESCE(MAX(id), 0) AS m FROM sync_changelog')[0]?.m || 0);
    ok(await syncRuhe(), 'ECHO der Primary hat geschoben und sein Echo eingespielt');
    const kopfNach = Number(dbQ(SERVER_DB, 'SELECT COALESCE(MAX(id), 0) AS m FROM sync_changelog')[0]?.m || 0);
    ok(kopfNach > kopfVor, `ECHO der Lauf hat die Zahlung wirklich über den Server geführt (Kopf ${kopfVor} → ${kopfNach})`);
    ok(Number(zeile('debts', DEBT.C).revision) === revA, `ECHO die Fassung des Darlehens bleibt ${revA} (${zeile('debts', DEBT.C).revision})`);
    ok(stand() === vorher, 'ECHO keine Fassung in Darlehen, Ausgaben, Vorlagen, Einkäufen, Gold, Metall, Aufträgen, Rechnungen, Reparaturen hat sich durch das Echo bewegt');
    // PC2 hält noch den Stand nach seiner eigenen Zahlung — die zweite Zahlung muss durchgehen.
    const vorA = (await antworten(client)).length;
    const r2 = [await setVal(client, '[data-debt-pay-amount]', '1'), await klick(client, '[data-debt-pay-source="cash"]')];
    await sleep(200);
    r2.push(await klick(client, '[data-debt-pay-save]'));
    ok(alleOk(r2) === 'OK' && await warteAuf(() => debtZahlungen(DEBT.C).length === n0 + 2),
      `ECHO die zweite Zahlung nach dem Echo geht durch — kein RECORD_CHANGED ohne fremde Änderung (${S((await antworten(client)).slice(vorA)).slice(0, 200)})`);
  }
  console.log('CENTRAL_UI_R6D_SYNC_ECHO_RUNTIME_PROVED_CANDIDATE');

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
    ok(neu.length === 0 && !dateien.some((f) => /lataif_sync_server\.db|outbox|data-location/i.test(f)), `LOKAL keine neue Datei, keine Konfig-DB, keine Warteschlange (${dateien.join(', ')})`);
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
const LOST_OPS = ['tax.record_payment', 'expenses.record_payment', 'suppliers.pay', 'gold.payables.settle', 'debts.record_payment', 'scrap_trades.create'];
console.log(`  verlorene Antwort: ${LOST_OPS.map((o) => `${o}=${LOST[o] ? 'ja' : 'NEIN'}`).join(' · ')}`);
ok(alleBeide(OPS), `ALLE 28 Buchungen auf PC2 UND am Primary bewiesen (fehlend: ${OPS.filter((o) => !(BEWEIS[o].C > 0 && BEWEIS[o].P > 0)).join(', ') || 'keine'})`);
ok(LOST_OPS.every((o) => LOST[o]), `LOST alle sechs verlorenen Antworten: dieselbe Kennung, genau eine Wirkung, genau eine Buchung`);
const dauer = Math.round((Date.now() - T0) / 1000);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r6d: tax + money + payables + gold + metals, lost response, stale, two apps (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
const gruppe = {
  TAX: ['tax.record_payment'],
  FINANCE: OPS.filter((o) => /^(banking|partners|debts|expenses|purchases|suppliers)\./.test(o)),
  GOLD: OPS.filter((o) => /^(gold|repairs|orders)\./.test(o)),
  METALS: OPS.filter((o) => /^(metals|scrap_trades)\./.test(o)),
};
if (alleBeide(gruppe.TAX)) console.log('CENTRAL_UI_R6D_TAX_RUNTIME_PROVED');
if (alleBeide(gruppe.FINANCE)) console.log('CENTRAL_UI_R6D_FINANCE_RUNTIME_PROVED');
if (alleBeide(gruppe.GOLD)) console.log('CENTRAL_UI_R6D_GOLD_RUNTIME_PROVED');
if (alleBeide(gruppe.METALS)) console.log('CENTRAL_UI_R6D_METALS_RUNTIME_PROVED');
if (LOST_OPS.every((o) => LOST[o])) console.log('CENTRAL_UI_R6D_LOST_RESPONSE_PROVED');
console.log('CENTRAL_UI_R6D_SYNC_ECHO_RUNTIME_PROVED');
console.log('CENTRAL_UI_R6D_TWO_APP_RUNTIME_PROVED');
