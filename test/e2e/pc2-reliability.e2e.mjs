// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PC2-RELIABILITY — Ausfall, Wiederherstellung, verlorene Antworten, alte Stände und Rennen, zwei echte Anwendungen
// (Primary + PC2) über die HEUTIGE gemeinsame Oberfläche. Ersatz für die Prüfungen der alten Client-Läufe C3B–C3G
// und C5 (`data-client-area`, seit 71d1fc4 entfernt), die nicht schon anderswo laufen (Zuordnung: docs/ai/
// client-e2e-coverage.md). Run: node test/e2e/pc2-reliability.e2e.mjs   (gezielt: PC2R_NUR=A1,A2,B3 …)
//
//   A1 AUS        Primary HART aus, PC2 offen: Lesen → die Leiste „The main computer is not answering"; „New Client"
//                 → „No answer from the primary", offener Vorgang; in der Primary-Datei NICHTS (Kunde, Nachweis);
//                 PC2 hat keine eigene Datenbank.                                                          (C5 S4/S5)
//   A2 WIEDER     Primary neu gestartet: „Reload" → Leiste weg, Daten da; „Clarify now" → erst noch unklar, nach der
//                 Frist „not saved"; „Save it now" → GENAU ein Kunde, nichts mehr offen.                      (C5 S6/G1/G2)
//   A3 KILL       PC2 bucht (Antwort da), sofort Primary HART aus: Kunde UND Nachweis stehen in der Datei; nach dem
//                 Neustart beantwortet dieselbe Kennung mit demselben Rumpf als Replay, nichts doppelt; PC2 arbeitet
//                 ohne neue Anmeldung weiter.                                                              (C5 S15/G3)
//   A4 PC2-KILL   Antwort verloren, PC2 HART beendet: nach dem Neustart zeigt die Leiste den Vorgang, „Clarify now"
//                 → „WAS saved", genau eine Wirkung.                                                       (C5 G8)
//   A5 RENNEN     echtes HTTP gegen den laufenden Primary: dieselbe Kennung zweimal gleichzeitig → eine Wirkung; zwei
//                 Rechnungen um das letzte Stück → genau eine, die andere STOCK_UNAVAILABLE; zwei Zahlungen gleichzeitig
//                 → beide, einmal FINAL, kein Guthaben.                                       (C5 S12/S13, C3D D7, C3E K10)
//   B1 GUTHABEN   PC2 „Guthaben verrechnen", Antwort verloren → zweiter Klick dieselbe Kennung, Guthaben genau einmal.
//                                                                                                           (C3G F1)
//   B2 AENDERN    PC2 ändert den Zeilenbetrag einer Rechnung, Antwort verloren → Replay, genau eine Änderung, die
//                 Forderung genau einmal neu gebucht.                                                       (C3D D2/D3)
//   B3 STALE-RE   PC2 hat die Maske offen, der Primary bucht dazwischen eine Zahlung → INVOICE_CHANGED sichtbar,
//                 nichts überschrieben, kein offener Vorgang.                                              (C3D D4)
//   B4 LETZTES    PC2 hat das letzte Stück in der Rechnung, ein anderer Rechner verkauft es vorher →
//                 STOCK_UNAVAILABLE sichtbar, keine Phantomrechnung, kein offener Vorgang, neuer Versuch = neue Kennung.
//                                                                                                           (C3B B4)
//   B5 KUNDE      PC2 „Edit Client", Antwort verloren → Replay, nur das geänderte Feld.                     (C3C M4)
//   B6 STALE-KO   PC2 hat die Kommission offen, sie ändert sich dazwischen → RECORD_CHANGED, nichts überschrieben.
//                                                                                                           (C3E K6)
//   B7 UNTERPREIS Transferliste „Sold" unter Our Price (split): Warnung, ohne Haken kein Verkauf, mit Haken genau EIN
//                 transfers.mark_sold mit acknowledgeBelowPrice; Primary == PC2.                            (C3G T1)
//   I  INTEGRITAET am Ende: integrity_check, Hauptbuch je Buchung ausgeglichen, keine doppelte Zahlungsbuchung.  (C5 S18)
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`; beendet nur eigene PIDs am exakten Test-Pfad (`killTestPid`,
// `closeTestWindow`). Produktion (com.lataif.app, E:\LATAIF\Data, Ports 3001/3443) bleibt unberührt und unbenutzt.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import {
  clearTestClientPendingSaves, closeTestWindow, foreignProcesses, killStarted, killTestImage, killTestPid, pathOfPid,
  spawnTracked, startedPids, waitPidGone, waitTestImageGone,
} from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'pc2r-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-pc2-reliability', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);
// Der Client hält Fensterspeicher und offene Vorgänge unter dem ECHTEN LocalAppData seiner Testkennung.
const CLIENT_REAL_LOCAL = join(REAL_LOCALAPPDATA, CLIENT_IDENT);

const NUR = String(process.env.PC2R_NUR || '').split(',').map((s) => s.trim()).filter(Boolean);
const laeuft = (s) => NUR.length === 0 || NUR.includes(s);
let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();
const HEUTE = new Date().toISOString().slice(0, 10);
// Korrekturen vor dem Eröffnungsstichtag sperrt P1b — die Rechnungen dieses Laufs liegen danach (Stichtag aus dem Code).
const STICHTAG = /OPENING_CUTOFF_DATE = '(\d{4}-\d{2}-\d{2})'/.exec(readFileSync(join(process.cwd(), 'src/core/parties/opening-balances.ts'), 'utf8'))[1];
const RECHNUNGSTAG = new Date(Date.parse(STICHTAG + 'T00:00:00.000Z') + 5 * 86400000).toISOString().slice(0, 10);

const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  aufraeumen();
  process.exit(1);
}, 45 * 60 * 1000);

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
  catch (e) { console.log('      (db) ' + String(e).slice(0, 160)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);
const zeile = (t, id) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE id = ?`, [id])[0] || {};

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.events = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params?.type || '')) {
        this.events.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
      }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    this.ws.addEventListener('close', () => { for (const { rej } of this.pending.values()) rej(new Error('cdp closed')); this.pending.clear(); });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    // Eine geschlossene Verbindung antwortet nie — sofort scheitern statt ewig warten.
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('cdp not open (' + method + ')');
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
const normPfad = (p) => resolve(String(p || '')).toLowerCase();
/** Die eigene, zuletzt gestartete PID am exakten Pfad (Primary oder PC2). */
function eigenePid(exe) {
  const pid = startedPids().filter((p) => normPfad(pathOfPid(p)) === normPfad(exe)).pop();
  if (!pid) throw new Error('no own pid for ' + exe);
  return pid;
}

const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const clickContains = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { try { if (await exists(c, sel)) return true; } catch { /* Seite lädt */ } await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { try { if (await c.ev(`return !!(${ausdruck});`)) return true; } catch { /* Seite lädt */ } await sleep(350); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);').catch(() => false)) return; await sleep(400); }
  throw new Error('no invoke');
}
const SHELL = 'a[href="/settings"]';
const q = (sel) => `document.querySelector(${S(sel)})`;
const FEHLER = '[data-save-error]';
const fehlerMit = (re) => `[...document.querySelectorAll(${S(FEHLER)})].some((e) => ${re}.test(e.textContent))`;
const fehlerText = (c) => c.ev(`return [...document.querySelectorAll(${S(FEHLER)})].map((e) => e.textContent).join(' | ');`).catch(() => '');

// Der Beobachter auf PC2: Fernaufträge, Antworten, die verlorene Antwort (`__dropNext`), Datenbankgriffe, Dialoge.
const BEOBACHTER = `
  if (window.__pc2rInstalliert) { /* schon da */ } else {
  window.__pc2rInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__alerts = []; window.__dropNext = null;
  window.alert = (m) => { window.__alerts.push(String(m)); };
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload }); } catch (e) { /* kein Rumpf */ }
    }
    if (body && window.__dropNext && body.op === window.__dropNext) {
      // Die Anfrage GEHT hinaus und wird am Primary ausgeführt — nur die Antwort kommt nie an.
      window.__dropNext = null;
      const r0 = await of(...a);
      try { await r0.text(); } catch (e) { /* egal */ }
      window.__answers.push({ op: body.op, commandId: body.commandId, dropped: true });
      throw new TypeError('PC2R: simulated lost response');
    }
    const r = await of(...a);
    if (body && body.op && !/\\.(get|list)$/.test(String(body.op)) && !/^(store|page|domain|session)\\./.test(String(body.op))) {
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
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)) && !/^(store|page|domain|session)\./.test(String(x.op)));
const antworten = (c) => c.ev('return JSON.stringify(window.__answers || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');

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

// ── Die Welt des Laufs (in die Datei, während der Primary geschlossen ist) ──
const KUNDE = 'pc2r-kunde';
const INV = { credA: 'pc2r-inv-cred-a', credB: 'pc2r-inv-cred-b', edit: 'pc2r-inv-edit', stale: 'pc2r-inv-stale', race: 'pc2r-inv-race' };
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'pc2r-cat', branch_id, name: 'PC2R Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    const kunde = (id, first, last) => insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    kunde(KUNDE, 'Mara', 'Reliable'); kunde('pc2r-einl', 'Emil', 'Einlieferer');
    const artikel = (id, extra) => insert(db, 'products', { id, branch_id, category_id: 'pc2r-cat', brand: 'Tudor', name: 'PC2R ' + id, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: 220, tax_scheme: 'VAT_10', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', revision: 1, created_at: now, updated_at: now, ...extra });
    const lager = (pid) => {
      artikel(pid, { stock_status: 'in_stock', quantity: 1 });
      insert(db, 'stock_lots', { id: `${pid}-lot`, branch_id, product_id: pid, unit_cost: 100, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    };
    const verkauft = (pid) => {
      artikel(pid, { stock_status: 'reserved', quantity: 0 });
      insert(db, 'stock_lots', { id: `${pid}-lot`, branch_id, product_id: pid, unit_cost: 100, qty_total: 1, qty_remaining: 0, status: 'EXHAUSTED', acquired_at: now, created_at: now });
    };
    for (const [k, inv] of Object.entries(INV)) {
      const pid = 'pc2r-p-' + k;
      verkauft(pid);
      insert(db, 'invoices', { id: inv, branch_id, invoice_number: inv.toUpperCase(), customer_id: KUNDE, status: 'PARTIAL', currency: 'BHD', net_amount: 200, vat_rate_snapshot: 10, vat_amount: 20, gross_amount: 220, paid_amount: 0, tax_scheme_snapshot: 'VAT_10', issued_at: RECHNUNGSTAG + 'T00:00:00.000Z', revision: 1, created_at: now, updated_at: now });
      insert(db, 'invoice_lines', { id: `${inv}-l1`, invoice_id: inv, product_id: pid, lot_id: `${pid}-lot`, quantity: 1, unit_price: 200, purchase_price: 100, vat_rate: 10, tax_scheme: 'VAT_10', vat_amount: 20, line_total: 220, position: 1 });
    }
    lager('pc2r-last'); lager('pc2r-last2');
    // Kommission
    artikel('pc2r-cp', { stock_status: 'in_stock', quantity: 1, source_type: 'CONSIGNMENT' });
    insert(db, 'consignments', { id: 'pc2r-con', branch_id, consignment_number: 'PC2R-CON-1', consignor_id: 'pc2r-einl', product_id: 'pc2r-cp', agreed_price: 1000, commission_rate: 15, commission_type: 'percent', status: 'active', payout_status: 'pending', agreement_date: now, revision: 1, created_at: now, updated_at: now });
    // Agent mit zwei Split-Transfers (C für PC2, P für den Primary)
    insert(db, 'agents', { id: 'pc2r-agent', branch_id, name: 'Rafi Vertreter', company: 'PC2R Agents', active: 1, created_at: now, updated_at: now });
    for (const x of ['C', 'P']) {
      lager('pc2r-tp-' + x);
      insert(db, 'agent_transfers', { id: 'pc2r-trf-' + x, branch_id, transfer_number: 'PC2R-TR-' + x, agent_id: 'pc2r-agent', product_id: 'pc2r-tp-' + x, agent_price: 800, minimum_price: 500, commission_rate: 10, status: 'transferred', transferred_at: now, settlement_model: 'split', excess_split_pct: 50, revision: 1, created_at: now, updated_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Prozesse ──
let primary = null, client = null, steuer = null;
async function gesund(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* noch nicht */ } await sleep(500); }
  return false;
}
async function primaryStarten() {
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await primary.ev(DIALOGE_PRIMARY);
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await clickText(primary, 'Sign In');
  }
  await waitFor(primary, SHELL, 90000);
  await primary.ev(DIALOGE_PRIMARY);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  return gesund();
}
async function primaryHartAus() {
  const pid = eigenePid(APP);
  try { primary?.close(); } catch { /* zu */ } primary = null;
  const getroffen = killTestPid(pid, APP);
  const weg = await waitPidGone(pid, 30000);
  return getroffen && weg;
}
async function beobachterLegen() {
  try { steuer?.close(); } catch { /* zu */ }
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
async function lade(route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { client?.close(); } catch { /* zu */ }
  await sleep(3200);
  client = await attachOnly(CLIENT_CDP, 30000);
  await waitFor(client, SHELL, 45000);
  return client;
}
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function clientVerbinden() {
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
  await beobachterLegen();
}
/** Offene Vorgänge von PC2 (`pending-saves/<Kennung>.json`) — nur lesend. */
const pendOrte = () => [join(CLIENT_REAL_LOCAL, 'pending-saves'), join(CLIENT_HOME, 'Local', CLIENT_IDENT, 'pending-saves')];
function pendLesen(id) {
  for (const d of pendOrte()) { const f = join(d, `${id}.json`); if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } } }
  return null;
}
const pendAnzahl = () => pendOrte().reduce((n, d) => n + (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).length : 0), 0);
const ROW = '[data-testid="pending-save-row"]', NOTE = '[data-testid="pending-save-note"]';
const notizen = (c) => c.ev(`return [...document.querySelectorAll(${S(NOTE)})].map((e) => e.textContent).join(' | ');`).catch(() => '');
const pc2Datenbanken = () => [CLIENT_DATA_DIR, CLIENT_REAL_LOCAL].flatMap((d) => (existsSync(d) ? readdirSync(d) : []).filter((f) => /\.db$/i.test(f)));
/** Ein Auftrag über das echte HTTP des Primary (ein „anderer Rechner"). */
async function befehl(token, op, payload, commandId = crypto.randomUUID()) {
  const r = await fetch(`${BASE}/api/command`, { signal: AbortSignal.timeout(60000), method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ op, commandId, payload }) });
  let body = null; try { body = await r.json(); } catch { /* leer */ }
  return { status: r.status, body, commandId };
}
async function warteAuf(pruefe, runden = 40) {
  for (let i = 0; i < runden; i++) { if (primary) await spuelen(primary).catch(() => null); if (pruefe()) return true; await sleep(400); }
  return false;
}
const kundenMit = (nach) => zahl('SELECT COUNT(*) AS n FROM customers WHERE last_name = ?', [nach]);
const nachweisVon = (id) => zahl('SELECT COUNT(*) AS n FROM remote_command_ledger WHERE command_id = ?', [id]);

/** „New Client" auf PC2 — ausfüllen und speichern; gibt die Kennung des Auftrags zurück. */
async function neuerKunde(vor, nach, drop = false) {
  await geh(client, '/clients'); await sleep(1500);
  const r = [await clickText(client, 'New Client')];
  await sleep(700);
  r.push(await setByLabel(client, 'FIRST NAME', vor));
  r.push(await setByLabel(client, 'LAST NAME', nach));
  await sleep(300);
  const vorCmd = (await kommandos(client)).length;
  if (drop) await client.ev("window.__dropNext = 'customers.create'; return 1;");
  r.push(await klick(client, '[data-create-client]'));
  await sleep(800);
  const cc = (await kommandos(client)).slice(vorCmd).filter((x) => x.op === 'customers.create');
  return { felder: r.every((x) => x === 'OK') ? 'OK' : r.join(','), commandId: String(cc[0]?.commandId || ''), payload: cc[0]?.payload ?? null };
}

const MESS = {};
try {
  assertE2eClientBinary(CLIENT_APP);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid);
  clearTestClientPendingSaves();
  rmSync(CLIENT_REAL_LOCAL, { recursive: true, force: true });
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ══ SETUP — Primary (Onboarding), Welt, Server-Konto; PC2 frisch verbunden ══
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PC2R Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'PC2R Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'PC2R Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
  {
    const pid = eigenePid(APP);
    primary.close(); primary = null;
    await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe');
  }
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });
  ok(await primaryStarten(), 'SETUP der Primary antwortet auf dem Netz');
  await clientVerbinden();
  ok(true, 'SETUP PC2 frisch verbunden und angemeldet (normale Masken)');
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }) })).json();
  const ANDERER = String(login.token || '');   // ein zweiter Rechner (eigene Sitzung), nur über HTTP
  ok(!!ANDERER, 'SETUP ein zweiter Absender (eigene Sitzung) für die Rennen und Zwischenbuchungen');
  const STEMPEL = String(Date.now()).slice(-6);

  // ══ A1 AUS — Primary hart aus, während PC2 offen ist ══════════════════════════════════════════════════════════
  let A1 = { commandId: '', nach: '' };
  if (laeuft('A1') || laeuft('A2')) {
    console.log(`  == A1 ${Math.round((Date.now() - T0) / 1000)}s`);
    // Einmal echt neu laden, solange der Primary antwortet: erst dann trägt die Seite den Beobachter
    // (addScriptToEvaluateOnNewDocument wirkt nur auf NEUE Dokumente). Danach nur noch In-App-Navigation.
    await lade('/clients'); await sleep(1500);
    ok(!(await exists(client, '[data-primary-unreachable]')), 'A1 solange der Primary antwortet, gibt es keine Leiste');
    ok(await primaryHartAus(), 'A1 der Primary ist HART beendet (eigene PID, exakter Test-Pfad)');
    await geh(client, '/collection'); await sleep(1200);
    await geh(client, '/clients');
    const leiste = await warteBis(client, q('[data-primary-unreachable="unreachable"]'), 30000);
    const leisteText = String(await client.ev(`return ${q('[data-primary-unreachable-text]')}?.textContent || '';`));
    ok(leiste && /not answering/.test(leisteText) && /out of date/.test(leisteText),
      `A1 Lesen ohne Primary: PC2 SAGT es („${leisteText.slice(0, 90)}")`);
    A1.nach = `Aus${STEMPEL}`;
    const k = await neuerKunde('Olga', A1.nach);
    A1.commandId = k.commandId;
    ok(k.felder === 'OK' && !!k.commandId, `A1 „New Client" auf PC2 abgeschickt (${k.felder})`);
    const ohneAntwort = await warteBis(client, fehlerMit(/No answer from the primary/), 60000);
    ok(ohneAntwort, `A1 die Maske sagt „No answer from the primary" (${String(await fehlerText(client)).slice(0, 160)})`);
    let rec = null;
    for (let i = 0; i < 30 && !(rec && rec.state === 'unresolved'); i++) { rec = pendLesen(A1.commandId); if (!(rec && rec.state === 'unresolved')) await sleep(500); }
    ok(!!rec && rec.state === 'unresolved' && rec.op === 'customers.create', `A1 der Vorgang ist auf PC2 abgelegt („unresolved") (${S(rec ? { state: rec.state, op: rec.op } : null)})`);
    ok(kundenMit(A1.nach) === 0 && nachweisVon(A1.commandId) === 0, 'A1 in der Datei des Primary steht NICHTS — kein Kunde, kein Nachweis');
    ok(pc2Datenbanken().length === 0, `A1 PC2 hat keine eigene Datenbank angelegt (${S(pc2Datenbanken())})`);
  }

  // ══ A2 WIEDER — Primary neu gestartet; Leiste weg; „Clarify now" → nicht angekommen → „Save it now" ══════════
  if (laeuft('A2')) {
    console.log(`  == A2 ${Math.round((Date.now() - T0) / 1000)}s`);
    ok(await primaryStarten(), 'A2 der Primary ist wieder da');
    await klick(client, '[data-primary-reload]').catch(() => 'weg');
    await sleep(3500);
    try { client.close(); } catch { /* zu */ }
    client = await attachOnly(CLIENT_CDP, 30000);
    await waitFor(client, SHELL, 60000);
    await beobachterLegen();
    await lade('/clients');
    ok(await warteBis(client, "document.body.innerText.includes('Reliable')", 30000) && !(await exists(client, '[data-primary-unreachable]')),
      'A2 nach „Reload": Daten vom Primary da, keine Leiste mehr — ohne neue Anmeldung');
    ok(await warteBis(client, `document.querySelectorAll(${S(ROW)}).length === 1`, 30000), 'A2 die Leiste „Unresolved saves" zeigt den Vorgang');
    await klick(client, '[data-testid="pending-save-clarify"]');
    ok(await warteBis(client, `/Still no clear answer/.test([...document.querySelectorAll(${S(NOTE)})].map((n) => n.textContent).join(' '))`, 30000),
      `A2 direkt danach ist es noch unklar — nichts wird erraten (${await notizen(client)})`);
    await sleep(62000);
    await klick(client, '[data-testid="pending-save-clarify"]');
    ok(await warteBis(client, q('[data-testid="pending-save-not-saved"]'), 30000), `A2 nach der Frist: „nicht angekommen" (${await notizen(client)})`);
    ok(kundenMit(A1.nach) === 0, 'A2 …und von selbst passiert nichts');
    await klick(client, '[data-testid="pending-save-send"]');
    ok(await warteAuf(() => kundenMit(A1.nach) === 1), 'A2 „Save it now" → der Kunde steht am Primary');
    ok(await warteBis(client, `document.querySelectorAll(${S(ROW)}).length === 0`, 30000) && pendAnzahl() === 0,
      `A2 nichts mehr offen (Leiste leer, keine Ablagedatei; ${pendAnzahl()})`);
    await sleep(1500); await spuelen(primary);
    ok(kundenMit(A1.nach) === 1, 'A2 genau EIN Kunde — nichts doppelt');
  }

  // ══ A3 KILL — PC2 bucht, sofort Primary hart aus; Datei hat Wirkung + Nachweis; Replay nach dem Neustart ═════════
  if (laeuft('A3')) {
    console.log(`  == A3 ${Math.round((Date.now() - T0) / 1000)}s`);
    const nach = `Kill${STEMPEL}`;
    const k = await neuerKunde('Kurt', nach);
    const antwort = await warteBis(client, `(window.__answers || []).some((a) => a.commandId === ${S(k.commandId)} && a.ok === true)`, 30000);
    ok(k.felder === 'OK' && antwort, `A3 PC2 bucht und bekommt die Antwort (${k.felder})`);
    await spuelen(primary).catch(() => null);
    ok(await primaryHartAus(), 'A3 sofort danach: Primary HART beendet');
    const rec = dbQ(BIZ_DB, 'SELECT status, op, result_json FROM remote_command_ledger WHERE command_id = ?', [k.commandId])[0];
    ok(kundenMit(nach) === 1 && rec?.status === 'completed' && rec?.op === 'customers.create' && !!rec?.result_json,
      `A3 in der Datei: der Kunde UND der Nachweis mit Ergebnis (${S({ kunde: kundenMit(nach), status: rec?.status })})`);
    ok(await primaryStarten(), 'A3 Primary neu gestartet');
    const token = String(await client.ev("return localStorage.getItem('lataif_client_token') || '';"));
    const replay = await befehl(token, 'customers.create', k.payload, k.commandId);
    ok(replay.status === 200 && replay.body?.ok === true && replay.body?.value?.replayed === true,
      `A3 dieselbe Kennung + derselbe Rumpf → Replay aus dem Nachweis (${replay.status} ${S(replay.body).slice(0, 160)})`);
    await spuelen(primary);
    ok(kundenMit(nach) === 1, 'A3 …nichts doppelt: genau EIN Kunde');
    await lade('/clients');
    ok(await warteBis(client, `document.body.innerText.includes(${S(nach)})`, 30000) && !(await exists(client, 'input[type="password"]')),
      'A3 PC2 arbeitet ohne neue Anmeldung weiter und sieht den Kunden');
  }

  // ══ A4 PC2-KILL — Antwort verloren, PC2 hart beendet; nach dem Neustart: „Clarify now" → „WAS saved" ═══════════
  if (laeuft('A4')) {
    console.log(`  == A4 ${Math.round((Date.now() - T0) / 1000)}s`);
    const nach = `Pc2Kill${STEMPEL}`;
    const k = await neuerKunde('Paula', nach, true);
    ok(await warteBis(client, fehlerMit(/No answer from the primary/), 60000), 'A4 Antwort verloren: „No answer from the primary"');
    ok(await warteAuf(() => kundenMit(nach) === 1), 'A4 der Primary HAT ausgeführt');
    let rec = null;
    for (let i = 0; i < 30 && !(rec && rec.state === 'unresolved'); i++) { rec = pendLesen(k.commandId); if (!(rec && rec.state === 'unresolved')) await sleep(500); }
    ok(rec?.state === 'unresolved', 'A4 der Vorgang liegt auf PC2 („unresolved")');
    const pc2 = eigenePid(CLIENT_APP);
    try { client.close(); } catch { /* zu */ } try { steuer.close(); } catch { /* zu */ }
    ok(killTestPid(pc2, CLIENT_APP) && await waitPidGone(pc2, 30000), 'A4 PC2 HART beendet (eigene PID, exakter Test-Pfad)');
    client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
    await waitInvoke(client);
    await waitFor(client, SHELL, 90000);
    await beobachterLegen();
    await lade('/clients');
    ok(await warteBis(client, `document.querySelectorAll(${S(ROW)}).length === 1`, 30000), 'A4 nach dem Neustart zeigt PC2 den Vorgang (ohne neue Anmeldung)');
    const vorCmd = (await kommandos(client)).length;
    await klick(client, '[data-testid="pending-save-clarify"]');
    ok(await warteBis(client, `/WAS saved/.test([...document.querySelectorAll(${S(NOTE)})].map((n) => n.textContent).join(' '))`, 60000),
      `A4 „Clarify now" → „WAS saved" (${await notizen(client)})`);
    ok((await kommandos(client)).slice(vorCmd).filter((x) => x.op === 'customers.create').length === 0, 'A4 Klären fragt nur — kein Auftrag gesendet');
    ok(await warteBis(client, `document.querySelectorAll(${S(ROW)}).length === 0`, 20000), 'A4 nichts mehr offen');
    await spuelen(primary);
    ok(kundenMit(nach) === 1 && nachweisVon(k.commandId) === 1, 'A4 genau EINE Wirkung, genau EIN Nachweis');
  }

  // ══ A5 RENNEN — echtes HTTP gegen den laufenden Primary ══════════════════════════════════════════════════════
  if (laeuft('A5')) {
    console.log(`  == A5 ${Math.round((Date.now() - T0) / 1000)}s`);
    // a) dieselbe Kennung zweimal gleichzeitig
    const nach = `Doppelt${STEMPEL}`;
    const rumpf = { firstName: 'Dora', lastName: nach };
    const id = crypto.randomUUID();
    const [x, y] = await Promise.all([befehl(ANDERER, 'customers.create', rumpf, id), befehl(ANDERER, 'customers.create', rumpf, id)]);
    await spuelen(primary);
    const kid = (r) => String(r.body?.value?.customerId || r.body?.value?.id || '');
    ok([x, y].every((r) => r.status === 200 && r.body?.ok === true) && kundenMit(nach) === 1 && nachweisVon(id) === 1 && kid(x) === kid(y),
      `A5a dieselbe Kennung gleichzeitig: beide beantwortet, GENAU ein Kunde, ein Nachweis, dieselbe Kennung des Kunden (${S([x.status, y.status, x.body?.value?.replayed, y.body?.value?.replayed, kundenMit(nach)])})`);
    // b) zwei Rechnungen um das letzte Stück
    const rechnung = (pid) => ({ customerId: KUNDE, lines: [{ productId: pid, lotId: pid + '-lot', quantity: 1, unitPrice: 500, scheme: 'auto' }], issuedDate: HEUTE, specialMark: false, payments: [] });
    const [r1, r2] = await Promise.all([befehl(ANDERER, 'invoices.create', rechnung('pc2r-last')), befehl(ANDERER, 'invoices.create', rechnung('pc2r-last'))]);
    await spuelen(primary);
    const gewonnen = [r1, r2].filter((r) => r.body?.ok === true);
    const verloren = [r1, r2].find((r) => r.body?.ok !== true);
    ok(gewonnen.length === 1 && verloren?.body?.error === 'STOCK_UNAVAILABLE',
      `A5b zwei Rechnungen um das letzte Stück: genau eine, die andere STOCK_UNAVAILABLE (${S([r1.body?.ok, r1.body?.error, r2.body?.ok, r2.body?.error])})`);
    ok(zahl("SELECT COUNT(*) AS n FROM invoice_lines WHERE product_id = 'pc2r-last'") === 1
      && Number(zeile('stock_lots', 'pc2r-last-lot').qty_remaining) === 0 && Number(zeile('products', 'pc2r-last').quantity) === 0,
      'A5b …eine Rechnungszeile, das Los leer, der Bestand 0 — nie negativ');
    // c) zwei Zahlungen gleichzeitig auf dieselbe Rechnung
    const zahlung = (amount) => ({ invoiceId: INV.race, amount, method: 'cash', paidDate: HEUTE, specialMarkOnFinal: false });
    const [z1, z2] = await Promise.all([befehl(ANDERER, 'invoices.record_payment', zahlung(110)), befehl(ANDERER, 'invoices.record_payment', zahlung(110))]);
    await spuelen(primary);
    const inv = zeile('invoices', INV.race);
    ok([z1, z2].every((r) => r.body?.ok === true) && zahl('SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?', [INV.race]) === 2
      && Math.abs(Number(inv.paid_amount) - 220) < 0.005 && inv.status === 'FINAL'
      && zahl("SELECT COUNT(*) AS n FROM customer_credits WHERE source_id = ? OR source_id IN (SELECT id FROM payments WHERE invoice_id = ?)", [INV.race, INV.race]) === 0,
      `A5c zwei Zahlungen gleichzeitig: beide gebucht, zusammen genau der Betrag, einmal FINAL, kein Guthaben (${S({ z: [z1.body?.ok, z2.body?.ok], bezahlt: inv.paid_amount, status: inv.status })})`);
  }

  // ══ B1 GUTHABEN — „Guthaben verrechnen" auf PC2, Antwort verloren ════════════════════════════════════════════
  if (laeuft('B1')) {
    console.log(`  == B1 ${Math.round((Date.now() - T0) / 1000)}s`);
    // Das Guthaben entsteht fachlich echt: eine Überzahlung von 50 an einer anderen Rechnung desselben Kunden.
    const ueber = await befehl(ANDERER, 'invoices.record_payment', { invoiceId: INV.credA, amount: 270, method: 'cash', paidDate: HEUTE, specialMarkOnFinal: false });
    await spuelen(primary);
    const guthaben = () => zahl('SELECT COALESCE(SUM(amount - COALESCE(used_amount, 0)), 0) AS n FROM customer_credits WHERE customer_id = ?', [KUNDE]);
    ok(ueber.body?.ok === true && Math.abs(guthaben() - 50) < 0.005, `B1 Vorbedingung: 50 Guthaben aus einer Überzahlung (${S({ ok: ueber.body?.ok, err: ueber.body?.error, guthaben: guthaben() })})`);
    const saldo = await befehl(ANDERER, 'parties.balances.get', { customerIds: [KUNDE], supplierIds: [], v: 0 });
    console.log('      (B1 Primary meldet) ' + S(saldo.body).slice(0, 300));
    await lade('/invoices/' + INV.credB);
    // Der Guthaben-Block steht im Dialog „Record Payment" (InvoiceDetail) — wie ein Mensch: erst den Dialog öffnen.
    ok(await warteBis(client, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Record Payment'))", 30000)
      && await clickContains(client, 'Record Payment') === 'OK', 'B1 PC2 öffnet „Record Payment"');
    ok(await warteBis(client, q('[data-apply-credit]'), 30000), 'B1 PC2 zeigt „Guthaben verrechnen" (50 BHD vom Primary)');
    const vorCmd = (await buchungen(client)).length, vorAnt = (await antworten(client)).length;
    await client.ev("window.__dropNext = 'invoices.apply_credit'; return 1;");
    ok(await klick(client, '[data-apply-credit]') === 'OK', 'B1 Klick');
    ok(await warteBis(client, fehlerMit(/No answer from the primary/), 30000), `B1 Antwort verloren: „No answer" (${String(await fehlerText(client)).slice(0, 140)})`);
    ok(await warteAuf(() => Math.abs(Number(zeile('invoices', INV.credB).paid_amount) - 50) < 0.005), 'B1 der Primary HAT verrechnet');
    await sleep(500);
    ok(await klick(client, '[data-apply-credit]') === 'OK', 'B1 zweiter Klick');
    await sleep(2500); await spuelen(primary);
    const cc = (await buchungen(client)).slice(vorCmd).filter((x) => x.op === 'invoices.apply_credit');
    const an = (await antworten(client)).slice(vorAnt).filter((a) => a.op === 'invoices.apply_credit');
    ok(cc.length === 2 && cc[0].commandId === cc[1].commandId && S(cc[0].payload) === S(cc[1].payload)
      && an.length === 2 && an[0].dropped === true && an[1].ok === true && an[1].replayed === true,
      `B1 zweimal DERSELBE Auftrag, die Wiederholung bekommt das eingefrorene Ergebnis (${S(an)})`);
    ok(Math.abs(Number(zeile('invoices', INV.credB).paid_amount) - 50) < 0.005 && zahl('SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?', [INV.credB]) === 1
      && Math.abs(guthaben()) < 0.005,
      `B1 Guthaben GENAU einmal verbraucht: eine Zahlung, 50 bezahlt, nichts mehr übrig (${S({ bezahlt: zeile('invoices', INV.credB).paid_amount, rest: guthaben() })})`);
  }

  // ══ B2 AENDERN — Zeilenbetrag einer Rechnung auf PC2, Antwort verloren ══════════════════════════════════════
  if (laeuft('B2')) {
    console.log(`  == B2 ${Math.round((Date.now() - T0) / 1000)}s`);
    await lade(`/invoices/${INV.edit}/edit`);
    ok(await warteBis(client, "document.querySelector('[data-save-invoice]') && document.querySelector('[data-invoice-line-gross]')", 45000), 'B2 die Bearbeiten-Maske ist da');
    await sleep(800);
    const f = [await setVal(client, '[data-invoice-line-gross]', '330'), await setVal(client, 'textarea[placeholder^="Explain why"]', 'PC2R Preis korrigiert')];
    ok(f.every((x) => x === 'OK'), `B2 Betrag und Grund eingetragen (${f.join(',')})`);
    await sleep(400);
    const vorCmd = (await buchungen(client)).length, vorAnt = (await antworten(client)).length;
    await client.ev("window.__dropNext = 'invoices.update'; return 1;");
    ok(await klick(client, '[data-save-invoice]') === 'OK', 'B2 Speichern');
    ok(await warteBis(client, fehlerMit(/No answer from the primary/), 30000), `B2 Antwort verloren: „No answer" (${String(await fehlerText(client)).slice(0, 140)})`);
    ok(await warteAuf(() => Math.abs(Number(zeile('invoices', INV.edit).gross_amount) - 330) < 0.005), 'B2 der Primary HAT geändert');
    await sleep(500);
    ok(await klick(client, '[data-save-invoice]') === 'OK', 'B2 Speichern noch einmal');
    await sleep(3000); await spuelen(primary);
    const cc = (await buchungen(client)).slice(vorCmd).filter((x) => x.op === 'invoices.update');
    const an = (await antworten(client)).slice(vorAnt).filter((a) => a.op === 'invoices.update');
    ok(cc.length === 2 && cc[0].commandId === cc[1].commandId && S(cc[0].payload) === S(cc[1].payload) && an[1]?.replayed === true,
      `B2 dieselbe Kennung, derselbe Rumpf, Replay (${S(an)})`);
    const ar = zahl("SELECT ROUND(COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0), 3) AS n FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND source_id = ?", [INV.edit]);
    ok(zahl('SELECT COUNT(*) AS n FROM invoice_edits WHERE invoice_id = ?', [INV.edit]) === 1 && Math.abs(Number(zeile('invoices', INV.edit).gross_amount) - 330) < 0.005,
      'B2 GENAU eine Änderung (ein Prüfvermerk), Brutto 330');
    ok(Math.abs(ar - 330) < 0.005, `B2 die Forderung steht genau einmal auf dem neuen Betrag (${ar})`);
  }

  // ══ B3 STALE-RE — PC2 hat die Maske offen, der Primary bucht dazwischen ══════════════════════════════════════
  if (laeuft('B3')) {
    console.log(`  == B3 ${Math.round((Date.now() - T0) / 1000)}s`);
    await lade(`/invoices/${INV.stale}/edit`);
    ok(await warteBis(client, "document.querySelector('[data-save-invoice]')", 45000), 'B3 PC2 hat die Bearbeiten-Maske offen');
    await sleep(800);
    const rev0 = Number(zeile('invoices', INV.stale).revision);
    const z = await befehl(ANDERER, 'invoices.record_payment', { invoiceId: INV.stale, amount: 50, method: 'cash', paidDate: HEUTE });
    await spuelen(primary);
    ok(z.body?.ok === true && Number(zeile('invoices', INV.stale).revision) > rev0, `B3 dazwischen bucht ein anderer Rechner eine Zahlung (Fassung ${rev0} → ${zeile('invoices', INV.stale).revision})`);
    await setVal(client, 'textarea[placeholder^="e.g. delivery details"]', 'PC2R alte Maske');
    await setVal(client, 'textarea[placeholder^="Explain why"]', 'PC2R alte Fassung');
    await sleep(300);
    const vorCmd = (await buchungen(client)).length;
    ok(await klick(client, '[data-save-invoice]') === 'OK', 'B3 PC2 speichert mit der alten Fassung');
    ok(await warteBis(client, fehlerMit(/changed since you opened it/), 20000), `B3 klares Nein in der Maske (${String(await fehlerText(client)).slice(0, 180)})`);
    await sleep(1000); await spuelen(primary);
    const cc = (await buchungen(client)).slice(vorCmd).filter((x) => x.op === 'invoices.update');
    ok(cc.length === 1 && cc[0].payload?.expectedRevision === rev0, `B3 der Auftrag nannte die gesehene Fassung ${rev0}`);
    ok(zeile('invoices', INV.stale).notes !== 'PC2R alte Maske' && zahl('SELECT COUNT(*) AS n FROM invoice_edits WHERE invoice_id = ?', [INV.stale]) === 0
      && Math.abs(Number(zeile('invoices', INV.stale).paid_amount) - 50) < 0.005,
      'B3 nichts überschrieben: keine Notiz, kein Prüfvermerk, die Zahlung des anderen bleibt');
    ok(!(await exists(client, ROW)) && pendAnzahl() === 0, 'B3 ein klares Nein ist kein offener Vorgang');
  }

  // ══ B4 LETZTES — PC2 hat das letzte Stück in der Rechnung, ein anderer verkauft es vorher ═══════════════════════
  if (laeuft('B4')) {
    console.log(`  == B4 ${Math.round((Date.now() - T0) / 1000)}s`);
    await lade('/invoices/new');
    ok(await warteBis(client, q('[data-ss-trigger="Search clients..."]'), 45000), 'B4 die neue Rechnung ist offen');
    const ss = async (ph, id) => {
      const a = await client.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(ph)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
      if (a !== 'OK') return 'KEIN-AUSLOESER:' + ph;
      if (!(await warteBis(client, `document.querySelector('[data-ss-option=${S(id)}]')`, 10000))) return 'KEIN-EINTRAG:' + id;
      await client.ev(`document.querySelector('[data-ss-option=${S(id)}]').click(); return 1;`); await sleep(300); return 'OK';
    };
    const f = [await ss('Search clients...', KUNDE), await ss('Pick product...', 'pc2r-last2')];
    f.push((await warteBis(client, "document.body.innerText.includes('Lot ·')", 15000)) ? 'OK' : 'KEIN-LOS');
    f.push(await klick(client, '[data-invoice-pay-method="cash"]'));
    f.push(await setVal(client, '[data-invoice-pay-amount]', '100'));
    await sleep(400);
    ok(f.every((x) => x === 'OK'), `B4 Kunde, das letzte Stück, Teilzahlung 100 (${f.join(',')})`);
    const fremd = await befehl(ANDERER, 'invoices.create', { customerId: KUNDE, lines: [{ productId: 'pc2r-last2', lotId: 'pc2r-last2-lot', quantity: 1, unitPrice: 500, scheme: 'auto' }], issuedDate: HEUTE, specialMark: false, payments: [] });
    await spuelen(primary);
    ok(fremd.body?.ok === true, 'B4 dazwischen verkauft ein anderer Rechner das Stück');
    const vorCmd = (await buchungen(client)).length;
    ok(await klick(client, '[data-invoice-save]') === 'OK', 'B4 PC2 speichert');
    ok(await warteBis(client, fehlerMit(/no longer available/), 30000), `B4 der echte Grund steht in der Maske, nicht „No answer" (${String(await fehlerText(client)).slice(0, 160)})`);
    await sleep(800);
    ok(await klick(client, '[data-invoice-save]') === 'OK', 'B4 bewusster zweiter Versuch');
    await sleep(2500); await spuelen(primary);
    const cc = (await buchungen(client)).slice(vorCmd).filter((x) => x.op === 'invoices.create');
    ok(cc.length === 2 && cc[0].commandId !== cc[1].commandId, `B4 ein neuer Versuch nach einem endgültigen Nein ist ein NEUER Auftrag (${cc.map((x) => String(x.commandId).slice(0, 8)).join(',')})`);
    ok(zahl("SELECT COUNT(*) AS n FROM invoice_lines WHERE product_id = 'pc2r-last2'") === 1 && Number(zeile('stock_lots', 'pc2r-last2-lot').qty_remaining) === 0,
      'B4 keine Phantomrechnung: nur die des anderen, das Los leer');
    ok(!(await exists(client, ROW)) && pendAnzahl() === 0, 'B4 kein offener Vorgang');
  }

  // ══ B5 KUNDE — „Edit Client" auf PC2, Antwort verloren ══════════════════════════════════════════════════════
  if (laeuft('B5')) {
    console.log(`  == B5 ${Math.round((Date.now() - T0) / 1000)}s`);
    await lade('/clients/' + KUNDE);
    ok(await clickContains(client, 'Edit Client') === 'OK', 'B5 „Edit Client" öffnet');
    await sleep(800);
    ok(await setByLabel(client, 'COMPANY', 'Ferne PC2R AG') === 'OK', 'B5 Firma eingetragen');
    const vorCmd = (await buchungen(client)).length, vorAnt = (await antworten(client)).length;
    await client.ev("window.__dropNext = 'customers.update'; return 1;");
    ok(await klick(client, '[data-save-client]') === 'OK', 'B5 Speichern');
    ok(await warteBis(client, fehlerMit(/No answer from the primary/), 30000), 'B5 Antwort verloren: „No answer"');
    ok(await warteAuf(() => zeile('customers', KUNDE).company === 'Ferne PC2R AG'), 'B5 der Primary HAT geändert');
    await sleep(500);
    ok(await klick(client, '[data-save-client]') === 'OK', 'B5 Speichern noch einmal');
    await sleep(2500); await spuelen(primary);
    const cc = (await buchungen(client)).slice(vorCmd).filter((x) => x.op === 'customers.update');
    const an = (await antworten(client)).slice(vorAnt).filter((a) => a.op === 'customers.update');
    ok(cc.length === 2 && cc[0].commandId === cc[1].commandId && S(cc[0].payload) === S(cc[1].payload) && an[1]?.replayed === true,
      `B5 dieselbe Kennung, derselbe Rumpf, Replay (${S(an)})`);
    const k = zeile('customers', KUNDE);
    ok(k.company === 'Ferne PC2R AG' && k.first_name === 'Mara' && k.last_name === 'Reliable', 'B5 nur das geänderte Feld, der Rest unberührt');
  }

  // ══ B6 STALE-KO — PC2 hat die Kommission offen, sie ändert sich dazwischen ═════════════════════════════════════
  if (laeuft('B6')) {
    console.log(`  == B6 ${Math.round((Date.now() - T0) / 1000)}s`);
    await lade('/consignments/pc2r-con');
    ok(await warteBis(client, "document.body.innerText.includes('PC2R-CON-1')", 40000), 'B6 die Kommission ist auf PC2 sichtbar');
    ok(await clickText(client, 'Edit') === 'OK', 'B6 „Edit" öffnet');
    await sleep(900);
    const rev0 = Number(zeile('consignments', 'pc2r-con').revision);
    const fremd = await befehl(ANDERER, 'consignments.update', { id: 'pc2r-con', expectedRevision: rev0, agreedPrice: 900 });
    await spuelen(primary);
    ok(fremd.body?.ok === true && Number(zeile('consignments', 'pc2r-con').agreed_price) === 900, `B6 dazwischen ändert ein anderer Rechner den Preis auf 900 (${S(fremd.body).slice(0, 100)})`);
    ok(await setVal(client, '[data-testid="pe-agreed"]', '650') === 'OK', 'B6 PC2 trägt 650 ein');
    await sleep(300);
    const vorAnt = (await antworten(client)).length;
    ok(await klick(client, '[data-save-consignment]') === 'OK', 'B6 PC2 speichert mit der alten Fassung');
    ok(await warteBis(client, fehlerMit(/changed since you opened it|RECORD_CHANGED/), 20000), `B6 klares Nein (${String(await fehlerText(client)).slice(0, 160)})`);
    await sleep(800); await spuelen(primary);
    const an = (await antworten(client)).slice(vorAnt).filter((a) => a.op === 'consignments.update');
    ok(an.length === 1 && an[0].error === 'RECORD_CHANGED', `B6 die Antwort ist RECORD_CHANGED (${S(an)})`);
    ok(Number(zeile('consignments', 'pc2r-con').agreed_price) === 900 && !(await exists(client, ROW)), 'B6 nichts überschrieben (900 bleibt), kein offener Vorgang');
  }

  // ══ B7 UNTERPREIS — Transferliste „Sold" unter Our Price (split), PC2 und Primary ══════════════════════════════
  if (laeuft('B7')) {
    console.log(`  == B7 ${Math.round((Date.now() - T0) / 1000)}s`);
    const verkaufen = async (c, x, istPc2) => {
      const nr = 'PC2R-TR-' + x;
      // `lade` ersetzt die Verbindung zu PC2 — danach mit der NEUEN weiter.
      if (istPc2) { await lade('/agents/pc2r-agent'); c = client; }
      else { await geh(c, '/agents/pc2r-agent'); await sleep(1500); }
      await warteBis(c, `document.body.innerText.includes(${S(nr)})`, 40000);
      const r = [await c.ev(
        `const z=[...document.querySelectorAll('*')].find(e=>e.children.length===0 && e.textContent.trim()===${S(nr)});`
        + "if(!z) return 'NO-ROW'; let r=z; for(let i=0;i<8 && r;i++){ const b=r.querySelector && r.querySelector('[data-transfer-sold]');"
        + "if(b){ b.click(); return 'OK'; } r=r.parentElement; } return 'NO-BTN';")];
      await sleep(800);

      r.push(await setByLabel(c, 'ACTUAL SALE PRICE (BHD)', '600'));
      await sleep(400);
      const warnung = await exists(c, '[data-transfer-sold-below]');
      const gesperrt = await c.ev(`return !!document.querySelector('[data-transfer-sold-confirm]')?.disabled;`);
      r.push(await klick(c, '[data-transfer-sold-ack]'));
      await sleep(300);
      const frei = !(await c.ev(`return !!document.querySelector('[data-transfer-sold-confirm]')?.disabled;`));
      r.push(await klick(c, '[data-transfer-sold-confirm]'));
      return { felder: r, warnung, gesperrt, frei };
    };
    // `verkaufen` lädt die Seite neu — die Aufzeichnung beginnt dort bei null, alles darin gehört zu diesem Verkauf.
    const pc = await verkaufen(client, 'C', true);
    ok(pc.warnung && pc.gesperrt && pc.frei, `B7 [PC2] Warnung „below Our Price", ohne Haken gesperrt, mit Haken frei (${S(pc)})`);
    ok(await warteAuf(() => zeile('agent_transfers', 'pc2r-trf-C').status === 'sold'), `B7 [PC2] der Transfer ist verkauft (${String(await fehlerText(client)).slice(0, 140) || 'kein Fehler'})`);
    const cc = (await buchungen(client)).filter((x) => x.op === 'transfers.mark_sold');
    ok(cc.length === 1 && cc[0].payload?.acknowledgeBelowPrice === true && cc[0].payload?.salePrice === 600,
      `B7 [PC2] genau EIN transfers.mark_sold, mit der Bestätigung (${S(cc.map((x) => x.payload))})`);
    const pp = await verkaufen(primary, 'P', false);
    ok(pp.warnung && pp.gesperrt && pp.frei, `B7 [Primary] dieselbe Maske, dieselbe Regel (${S(pp)})`);
    ok(await warteAuf(() => zeile('agent_transfers', 'pc2r-trf-P').status === 'sold'), 'B7 [Primary] der Transfer ist verkauft');
    const t = (x) => { const r = zeile('agent_transfers', 'pc2r-trf-' + x); return { status: r.status, preis: Number(r.actual_sale_price), abrechnung: Number(r.settlement_amount) }; };
    ok(S(t('C')) === S(t('P')) && t('C').preis === 600 && Math.abs(t('C').abrechnung - 600) < 0.005,
      `B7 Primary == PC2: verkauft zu 600, ohne Split — uns steht genau der tatsächliche Betrag zu (${S([t('C'), t('P')])})`);
  }

  // ══ I INTEGRITAET — am Ende ════════════════════════════════════════════════════════════════════════════════
  {
    await spuelen(primary).catch(() => null);
    const integ = String(Object.values(dbQ(BIZ_DB, 'PRAGMA integrity_check')[0] || {})[0] || '');
    ok(integ === 'ok', `I integrity_check der Geschäftsdatenbank (${integ})`);
    const schief = dbQ(BIZ_DB, `SELECT transaction_id, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS d FROM ledger_entries
      GROUP BY transaction_id HAVING ABS(d) > 0.0005`);
    ok(schief.length === 0, `I das Hauptbuch ist je Buchung ausgeglichen (${S(schief.slice(0, 3))})`);
    const doppelt = dbQ(BIZ_DB, `SELECT source_id, account, direction, COUNT(*) AS n FROM ledger_entries WHERE source_module = 'PAYMENT' AND reverses_entry_id IS NULL
      GROUP BY source_id, account, direction HAVING n > 1`);
    ok(doppelt.length === 0, `I keine Zahlung doppelt gebucht (${S(doppelt.slice(0, 3))})`);
    ok(pc2Datenbanken().length === 0, 'I PC2 hat bis zum Ende keine eigene Datenbank');
  }
  const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid);
  ok(fremdVorher.every((pid) => fremdNachher.includes(pid)), `ISOLATION jede fremde lataif.exe von vorher läuft noch (${fremdVorher.length} geprüft)`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  try { console.log('      (Primary-Konsole) ' + (primary?.events || []).slice(-10).join('\n      (Primary-Konsole) ')); } catch { /* egal */ }
  try { console.log('      (PC2-Konsole) ' + (client?.events || []).slice(-10).join('\n      (PC2-Konsole) ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
}
clearTimeout(WACHHUND);
const dauer = Math.round((Date.now() - T0) / 1000);
const ZEILE = `pc2 reliability: outage, recovery, lost answers, stale state, races, two apps (${Math.floor(dauer / 60)}m ${dauer % 60}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) { console.log(`\nFAIL — ${ZEILE}`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log(`\nPASS — ${ZEILE}`);
console.log('PC2_RELIABILITY_OUTAGE_RECOVERY_LOST_STALE_RACE_PROVED');
