// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5C — die verbindliche Regel „abrechenbar": fertig ODER abgeholt.
// Run: node test/e2e/r5c-billable.e2e.mjs
//
// Ein kleiner, echter Lauf mit zwei Rechnern. Dieselben Reparaturen, dieselbe Liste, dieselbe
// Detailseite — am zweiten Rechner (ohne Datenbank) und am Primary:
//
//   • „fertig" und „abgeholt": Auswahl, Kürzel und „Create Invoice" werden angeboten und rechnen ab;
//   • „empfangen", „in Arbeit", „zurückgegeben": nichts davon wird angeboten;
//   • nach der Rechnung wird nichts mehr angeboten — keine zweite Rechnung;
//   • Primary == PC2, und der zweite Rechner besitzt keine Geschäftsdatenbank.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killTestImage, tasklistTestImage } from './_e2e-process.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r5c-bill-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5c-billable', 'run-' + Date.now());
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
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  try { killTestImage('lataif.exe'); } catch { /* weg */ }
  try { killTestImage('lataif-e2e-client.exe'); } catch { /* weg */ }
  process.exit(1);
}, 20 * 60 * 1000);

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

const killImage = (n) => { try { killTestImage(n); } catch { /* war nicht da */ } };
const killAll = () => { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); };
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const o = tasklistTestImage(name); if (!o.includes(name)) return; } catch { return; }
    await sleep(300);
  }
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
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
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

const BEOBACHTER = `
  if (window.__r4bInstalliert) { /* schon da */ } else {
  window.__r4bInstalliert = true;
  window.__cmds = [];
  window.__dbHits = [];
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => {
    const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/Database not initialized/.test(t)) merke(t);
    oe(...a);
  };
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    if (/\\/api\\/command$/.test(url)) {
      try {
        const body = JSON.parse((a[1] && a[1].body) || '{}');
        window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload });
      } catch (e) { /* kein lesbarer Rumpf */ }
    }
    return of(...a);
  };
  }
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
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`)
    .run(...nutzbar.map((k) => daten[k]));
}

/** Je Status eine Reparatur; „fertig" und „abgeholt" doppelt — einmal für PC2, einmal für den Primary. */
const REP = [
  ['bl-rep-1', 'BL-0001', 'ready', 60], ['bl-rep-2', 'BL-0002', 'picked_up', 80],
  ['bl-rep-3', 'BL-0003', 'received', 60], ['bl-rep-4', 'BL-0004', 'in_progress', 60], ['bl-rep-5', 'BL-0005', 'returned', 60],
  ['bl-rep-6', 'BL-0006', 'ready', 60], ['bl-rep-7', 'BL-0007', 'picked_up', 80],
];
/** v0.8.94 — Quick Edit: eigene Reparaturen (Nummern ohne „BL-000", damit die Zählungen oben unberührt bleiben). */
const TAG = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const QREP = [['bq-rep-1', 'BQ-0001', 'ready'], ['bq-rep-2', 'BQ-0002', 'ready'], ['bq-rep-3', 'BQ-0003', 'ready']];
/** REPAIR-INVOICE-INDICATOR — Sonderfälle der Rechnungsanzeige: verwaiste Verknüpfung und Rechnungsentwurf. */
const XREP = [['bx-rep-1', 'BX-0001', 'picked_up', 'bx-inv-gibt-es-nicht'], ['bx-rep-2', 'BX-0002', 'ready', 'bx-inv-entwurf']];
/** REPAIR-TYPE FINAL CORRECTION — je App eine Reparatur mit der Vorwahl In-house, in Arbeit, noch ohne Zeile. */
const TREP = [['bt-rep-1', 'BT-0001'], ['bt-rep-2', 'BT-0002']];
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'customers', { id: 'bl-kunde', branch_id, first_name: 'Lina', last_name: 'Rechnung', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    for (const [id, nr, status, charge] of REP) {
      insert(db, 'repairs', { id, branch_id, repair_number: nr, customer_id: 'bl-kunde', item_brand: 'Tudor', item_model: 'Pelagos', issue_description: 'Service ' + nr, repair_type: 'internal', internal_cost: 0, charge_to_customer: charge, margin: charge, tax_scheme: 'VAT_10', status, received_at: now, completed_at: now, picked_up_at: status === 'picked_up' ? now : null, voucher_code: 'B' + nr.replace(/\D/g, '').padStart(7, '0'), images: '[]', item_attributes: '{}', repair_scope: 'CUSTOMER', revision: 1, created_at: now, updated_at: now });
    }
    // v0.8.94 — die Quick-Edit-Reparaturen (nach dem Kunden, auf den sie zeigen).
    for (const [id, nr, status] of QREP) {
      insert(db, 'repairs', { id, branch_id, repair_number: nr, customer_id: 'bl-kunde', item_brand: 'Omega', item_model: 'Seamaster', issue_description: 'Quick ' + nr, repair_type: 'internal', internal_cost: 0, charge_to_customer: 50, margin: 50, tax_scheme: 'VAT_10', status, received_at: `${TAG(10)}T12:00:00.000Z`, completed_at: now, voucher_code: 'Q' + nr.replace(/\D/g, '').padStart(7, '0'), images: '[]', item_attributes: '{}', repair_scope: 'CUSTOMER', revision: 1, created_at: now, updated_at: now });
    }
    // REPAIR-INVOICE-INDICATOR — ein Rechnungsentwurf (ohne Zeilen, ohne Buchung) und eine Verknüpfung ins Leere.
    insert(db, 'invoices', { id: 'bx-inv-entwurf', branch_id, invoice_number: 'PINV-BX-0001', customer_id: 'bl-kunde', status: 'DRAFT', net_amount: 40, vat_amount: 0, gross_amount: 40, paid_amount: 0, created_at: now, updated_at: now });
    // Die App selbst prüft keine Fremdschlüssel (sql.js ohne PRAGMA foreign_keys) — so entsteht eine verwaiste
    // invoice_id im Bestand; node:sqlite prüft sie, deshalb hier wie dort ausgeschaltet.
    insert(db, 'suppliers', { id: 'bt-ws', branch_id, name: 'BT Werkstatt', active: 1, is_workshop: 1, created_at: now, updated_at: now });
    for (const [id, nr] of TREP) {
      insert(db, 'repairs', { id, branch_id, repair_number: nr, customer_id: 'bl-kunde', item_brand: 'Cartier', item_model: 'Tank', issue_description: 'Typ ' + nr, repair_type: 'internal', internal_cost: 0, charge_to_customer: 60, margin: 60, tax_scheme: 'VAT_10', status: 'in_progress', received_at: now, voucher_code: 'T' + nr.replace(/\D/g, '').padStart(7, '0'), images: '[]', item_attributes: '{}', repair_scope: 'CUSTOMER', revision: 1, created_at: now, updated_at: now });
    }
    db.exec('PRAGMA foreign_keys = OFF');
    for (const [id, nr, status, invoice_id] of XREP) {
      insert(db, 'repairs', { id, branch_id, repair_number: nr, customer_id: 'bl-kunde', item_brand: 'Rolex', item_model: 'Datejust', issue_description: 'Sonderfall ' + nr, repair_type: 'internal', internal_cost: 0, charge_to_customer: 40, margin: 40, tax_scheme: 'VAT_10', status, invoice_id, received_at: now, completed_at: now, picked_up_at: status === 'picked_up' ? now : null, voucher_code: 'X' + nr.replace(/\D/g, '').padStart(7, '0'), images: '[]', item_attributes: '{}', repair_scope: 'CUSTOMER', revision: 1, created_at: now, updated_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
async function lade(c, route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch (e) { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const fehlerAnzeige = (c) => c.ev("return [...document.querySelectorAll('[data-save-error]')].map(e=>e.textContent).join(' | ');");

/** Was die Zeile einer Reparatur in der Liste anbietet: Auswahl und Rechnungskürzel. */
const angebot = (c, nr) => c.ev(
  `const row=[...document.querySelectorAll('div.cursor-pointer')].find(d=>d.style&&d.style.gridTemplateColumns&&d.textContent.includes(${S(nr)}));`
  + `if(!row) return 'KEINE-ZEILE'; return (row.querySelector('input[type=checkbox]') ? 'A' : '-') + (row.querySelector('[data-repair-quick-invoice]') ? 'K' : '-');`);
/** Das Kürzel der Liste — seit v0.8.94 mit dem Fenster „Create Invoice": Vorgabe lesen, Steuerart wählen, bestätigen.
 *  Gibt 'OK:<Vorgabe>' zurück. */
async function kuerzel(c, nr, steuer) {
  const k = await c.ev(
    `const row=[...document.querySelectorAll('div.cursor-pointer')].find(d=>d.style&&d.style.gridTemplateColumns&&d.textContent.includes(${S(nr)}));`
    + `const b=row&&row.querySelector('[data-repair-quick-invoice]'); if(!b) return 'NO'; b.click(); return 'OK';`);
  if (k !== 'OK') return k;
  if (!(await warteBis(c, "!!document.querySelector('[data-combined-invoice-confirm]') && !!document.querySelector('[data-repair-invoice-tax-option]')", 15000))) return 'KEIN-FENSTER';
  const vorgabe = await c.ev(`const r=document.querySelector('[data-repair-invoice-tax-option] input:checked'); return r ? r.closest('[data-repair-invoice-tax-option]').getAttribute('data-repair-invoice-tax-option') : 'KEINE';`);
  if (steuer) { await click(c, `[data-repair-invoice-tax-option="${steuer}"] input`); await sleep(250); }
  await click(c, '[data-combined-invoice-confirm]');
  return 'OK:' + vorgabe;
}
/** „Create Invoice" der Detailseite: Steuerdialog (Vorgabe der Reparatur) → Nummernart (normal) → Confirm. */
async function detailRechnung(c) {
  await click(c, '[data-repair-invoice]');
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Next: Choose Number Type')", 15000))) return 'KEIN-STEUERDIALOG';
  await clickText(c, 'Next: Choose Number Type');
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Confirm')", 15000))) return 'KEIN-NUMMERNDIALOG';
  await clickText(c, 'Confirm');
  return (await warteBis(c, "/^\\/invoices\\//.test(location.pathname)", 45000)) ? 'OK' : 'KEINE-RECHNUNG:' + (await fehlerAnzeige(c));
}
const rechnungVon = (rid) => String(dbQ(BIZ_DB, 'SELECT invoice_id FROM repairs WHERE id = ?', [rid])[0]?.invoice_id || '');
const INV_OHNE = /^(id|invoice_number|notes|created_by|revision|version|sync_status)$|_at$/;
const rechnung = (id) => {
  const k = dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [id])[0] || {};
  return S({
    kopf: Object.fromEntries(Object.entries(k).filter(([x]) => !INV_OHNE.test(x)).sort(([a], [b]) => a.localeCompare(b))),
    zeilen: dbQ(BIZ_DB, 'SELECT unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [id]),
    buchung: dbQ(BIZ_DB, 'SELECT account, direction, ROUND(SUM(amount), 3) AS s FROM ledger_entries WHERE source_id = ? GROUP BY account, direction ORDER BY account, direction', [id]),
  });
};
const vermerk = (rid) => String(dbQ(BIZ_DB, 'SELECT i.notes FROM invoices i JOIN repairs r ON r.invoice_id = i.id WHERE r.id = ?', [rid])[0]?.notes || '');
async function warteAuf(pruefe) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  // Wie r5c-repair-parity: die ungeklärten Speichervorgänge des Test-Clients liegen im FESTEN <LocalAppData> —
  // ein Rest eines früheren Laufs sperrte sonst das Abrechnen („An earlier save of this kind … is still unresolved").
  if (CLIENT_IDENT.endsWith('.e2e.client')) {
    rmSync(join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), CLIENT_IDENT, 'pending-saves'), { recursive: true, force: true });
  }
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Der Primary ────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5C Bill Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5C Bill Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5C Admin');
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
  killImage('lataif.exe'); await waitGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  // Wie in den übrigen Zwei-App-Läufen: nach dem Säen kann die gespeicherte Sitzung fremd sein — dann anmelden.
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 90000);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }

  // ── Der Client ────────────────────────────────────────────────────────
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
  await beobachterLegen();
  client = await lade(client, '/repairs');
  await warteBis(client, "document.body.innerText.includes('BL-0007')", 45000);
  await geh(primary, '/repairs');
  await warteBis(primary, "document.body.innerText.includes('BL-0007')", 45000);

  // ── 1) Was angeboten wird — dieselbe Regel auf beiden Rechnern ──────────
  const soll = { 'BL-0001': 'AK', 'BL-0002': 'AK', 'BL-0003': '--', 'BL-0004': '--', 'BL-0005': '--' };
  for (const [nr, erwartet] of Object.entries(soll)) {
    const a = await angebot(client, nr);
    const b = await angebot(primary, nr);
    const status = REP.find((x) => x[1] === nr)[2];
    ok(a === erwartet && b === erwartet,
      `LISTE ${nr} (${status}): Auswahl/Kuerzel ${erwartet === 'AK' ? 'angeboten' : 'NICHT angeboten'} — PC2 ${a}, Primary ${b}`);
  }
  for (const [rid, nr] of [['bl-rep-3', 'BL-0003'], ['bl-rep-4', 'BL-0004'], ['bl-rep-5', 'BL-0005']]) {
    client = await lade(client, '/repairs/' + rid);
    await warteBis(client, `document.body.innerText.includes(${S(nr)})`, 30000);
    await sleep(600);
    await geh(primary, '/repairs/' + rid);
    await warteBis(primary, `document.body.innerText.includes(${S(nr)})`, 30000);
    await sleep(600);
    ok(!(await exists(client, '[data-repair-invoice]')) && !(await exists(primary, '[data-repair-invoice]')),
      `DETAIL ${nr} (${REP.find((x) => x[1] === nr)[2]}): kein „Create Invoice" — weder PC2 noch Primary`);
  }

  // ── 2) „fertig" über das Kürzel, „abgeholt" über die Detailseite — PC2 und Primary ──
  client = await lade(client, '/repairs');
  await warteBis(client, "document.body.innerText.includes('BL-0001')", 30000);
  ok(await kuerzel(client, 'BL-0001', 'ZERO') === 'OK:VAT_10', 'FERTIG PC2: das Kuerzel der Liste fragt die Steuerart (Vorgabe VAT 10 %, gewählt 0 %)');
  ok(await warteBis(client, "/^\\/invoices\\//.test(location.pathname)", 45000), `FERTIG PC2: die Rechnung entsteht (${String(await fehlerAnzeige(client)).slice(0, 160) || 'ok'})`);
  client = await lade(client, '/repairs/bl-rep-2');
  await waitFor(client, '[data-repair-invoice]', 30000);
  const d2 = await detailRechnung(client);
  ok(d2 === 'OK', `ABGEHOLT PC2: „Create Invoice" der Detailseite (${d2})`);

  await geh(primary, '/repairs');
  await warteBis(primary, "document.body.innerText.includes('BL-0006')", 30000);
  ok(await kuerzel(primary, 'BL-0006', 'ZERO') === 'OK:VAT_10', 'FERTIG Primary: dasselbe Kuerzel, dieselbe Frage (gewählt 0 %)');
  ok(await warteBis(primary, "/^\\/invoices\\//.test(location.pathname)", 45000), 'FERTIG Primary: die Rechnung entsteht');
  await geh(primary, '/repairs/bl-rep-7');
  await waitFor(primary, '[data-repair-invoice]', 30000);
  const d7 = await detailRechnung(primary);
  ok(d7 === 'OK', `ABGEHOLT Primary: dieselbe Detailseite (${d7})`);

  await warteAuf(() => !!rechnungVon('bl-rep-1') && !!rechnungVon('bl-rep-2') && !!rechnungVon('bl-rep-6') && !!rechnungVon('bl-rep-7'));
  for (const [pc2, pri, was] of [['bl-rep-1', 'bl-rep-6', 'FERTIG'], ['bl-rep-2', 'bl-rep-7', 'ABGEHOLT']]) {
    const a = rechnungVon(pc2), b = rechnungVon(pri);
    ok(!!a && !!b && rechnung(a) === rechnung(b), `${was} Primary == PC2: Rechnungskopf, Zeilen und Buchung${a && b && rechnung(a) !== rechnung(b) ? ` (${rechnung(b)} / ${rechnung(a)})` : ''}`);
  }
  ok(/^Repair Service · BL-0001 · Service BL-0001$/.test(vermerk('bl-rep-1')) && /^Repair Service · BL-0006 · Service BL-0006$/.test(vermerk('bl-rep-6')),
    'FERTIG der Vermerk einer Reparatur auf beiden Rechnern (v0.8.94 nach der Zahl der Reparaturen)');
  {
    const zeilen = dbQ(BIZ_DB, 'SELECT tax_scheme, vat_amount FROM invoice_lines WHERE invoice_id IN (?, ?)', [rechnungVon('bl-rep-1'), rechnungVon('bl-rep-6')]);
    const steuer = dbQ(BIZ_DB, "SELECT tax_scheme FROM repairs WHERE id IN ('bl-rep-1','bl-rep-6')").map((r) => r.tax_scheme).join(',');
    ok(zeilen.length === 2 && zeilen.every((r) => r.tax_scheme === 'ZERO' && Number(r.vat_amount) === 0) && steuer === 'ZERO,ZERO',
      `FERTIG die Wahl 0 % aus der Liste gilt: Zeilen ohne VAT, an der Reparatur gespeichert — PC2 und Primary (${S(zeilen)} / ${steuer})`);
  }
  ok(/^Repair Service · BL-0002 · Service BL-0002$/.test(vermerk('bl-rep-2')) && /^Repair Service · BL-0007 · Service BL-0007$/.test(vermerk('bl-rep-7')),
    'ABGEHOLT der Vermerk der Detailseite auf beiden Rechnern');
  ok(dbQ(BIZ_DB, "SELECT status FROM repairs WHERE id IN ('bl-rep-1','bl-rep-2') ORDER BY id").map((r) => r.status).join(',') === 'ready,picked_up',
    'STATUS die Rechnung aendert den Reparaturstatus nicht');

  // ── 3) Keine zweite Rechnung ─────────────────────────────────────────
  client = await lade(client, '/repairs');
  await warteBis(client, "document.body.innerText.includes('BL-0002')", 30000);
  ok(await angebot(client, 'BL-0001') === '--' && await angebot(client, 'BL-0002') === '--', 'EINMAL nach der Rechnung bietet die Liste nichts mehr an');
  client = await lade(client, '/repairs/bl-rep-2');
  await warteBis(client, "document.body.innerText.includes('BL-0002')", 30000);
  await sleep(600);
  ok(!(await exists(client, '[data-repair-invoice]')), 'EINMAL …und die Detailseite auch nicht');
  const proRep = dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM invoices WHERE notes LIKE '%BL-000%'")[0]?.n;
  ok(Number(proRep) === 4, `EINMAL genau vier Rechnungen — eine je abgerechneter Reparatur (${proRep})`);
  ok(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM repairs WHERE id IN ('bl-rep-3','bl-rep-4','bl-rep-5') AND COALESCE(invoice_id,'') <> ''")[0]?.n === 0,
    'EINMAL die nicht abrechenbaren tragen keine Rechnung');
  const c = (await kommandos(client)).filter((x) => x.op === 'repairs.create_invoice');
  ok(c.length === 0, 'EINMAL auf den Seiten danach wurde nichts mehr geschickt');

  // ── 3a) REPAIR-INVOICE-INDICATOR — Rechnungsanzeige und -filter der Liste, PC2 und Primary ──
  const zeileVon = (nr) => `[...document.querySelectorAll('div.cursor-pointer')].find(d=>d.style&&d.style.gridTemplateColumns&&d.textContent.includes(${S(nr)}))`;
  const anzeige = (c, nr) => c.ev(
    `const row=${zeileVon(nr)}; if(!row) return 'KEINE-ZEILE'; const z=row.querySelector('[data-repair-invoice-state]'); if(!z) return 'KEINE-ANZEIGE';`
    + `const o=z.querySelector('[data-repair-invoice-open]');`
    + `return z.getAttribute('data-repair-invoice-state') + '|' + (o ? o.getAttribute('data-repair-invoice-open') : '') + '|' + z.textContent.trim();`);
  const sichtbar = (c) => c.ev(`return [...document.querySelectorAll('div.cursor-pointer')].filter(d=>d.style&&d.style.gridTemplateColumns)`
    + `.map(d=>(d.textContent.match(/B[LX]-000\\d/)||[''])[0]).filter(Boolean).sort().join(',');`);
  const chip = (c, f) => c.ev(`const b=document.querySelector('[data-repair-filter-invoice=${S(f)}]'); return b ? b.textContent.trim() : 'KEIN-CHIP';`);
  const BL = dbQ(BIZ_DB, "SELECT r.repair_number AS nr, COALESCE(r.invoice_id,'') AS inv, COALESCE(i.status,'') AS st, COALESCE(i.invoice_number,'') AS num "
    + "FROM repairs r LEFT JOIN invoices i ON i.id = r.invoice_id WHERE r.repair_number LIKE 'BL-000%' OR r.repair_number LIKE 'BX-000%' ORDER BY r.repair_number");
  const gilt = (r) => !!r.inv && !!r.st && r.st !== 'CANCELLED';
  const sollMit = BL.filter(gilt).map((r) => r.nr).join(',');
  const sollOhne = BL.filter((r) => !gilt(r)).map((r) => r.nr).join(',');
  const alleMit = Number(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM repairs r JOIN invoices i ON i.id = r.invoice_id WHERE i.status <> 'CANCELLED'")[0]?.n);
  ok(sollMit === 'BL-0001,BL-0002,BL-0006,BL-0007,BX-0002' && sollOhne === 'BL-0003,BL-0004,BL-0005,BX-0001',
    `INDIKATOR Ausgangslage: vier mit Rechnung + ein Entwurf, drei ohne + eine verwaiste Verknüpfung (${sollMit} / ${sollOhne})`);
  async function indikator(wer, c) {
    if (!(await warteBis(c, "document.body.innerText.includes('BL-0007') && !!document.querySelector('[data-repair-invoice-state]')", 30000))) {
      ok(false, `INDIKATOR ${wer}: die Liste zeigt keine Rechnungsspalte`); return;
    }
    for (const r of BL) {
      const a = await anzeige(c, r.nr);
      const soll = !r.inv ? 'none||Not created'
        : !r.st ? 'missing||⚠ Invoice not foundData problem'
          : r.st === 'DRAFT' ? `draft|${r.inv}|Invoice Draft${r.num}` : null;
      ok(soll ? a === soll : a.startsWith(`created|${r.inv}|✓ Invoice created`) && a.endsWith(r.num) && r.num !== '',
        `INDIKATOR ${wer} ${r.nr}: ${soll ?? `✓ Invoice created ${r.num}`} (${a})`);
    }
    ok(await c.ev(`const row=${zeileVon('BX-0001')}; return !!(row && row.querySelector('[data-repair-invoice-problem]') && !row.querySelector('[data-repair-invoice-open]'));`),
      `INDIKATOR ${wer} BX-0001: als Datenproblem markiert, nichts zum Öffnen`);
    ok(await chip(c, 'created') === `Invoice Created${alleMit}`, `INDIKATOR ${wer} Zähler „Invoice Created" ${alleMit} (${await chip(c, 'created')})`);
    await click(c, '[data-repair-filter-invoice="created"]'); await sleep(400);
    const mit = await sichtbar(c);
    await click(c, '[data-repair-filter-invoice="not_created"]'); await sleep(400);
    const ohne = await sichtbar(c);
    ok(mit === sollMit && ohne === sollOhne, `INDIKATOR ${wer} Filter Invoice Created / Not Created (${mit} / ${ohne})`);
    // UND mit dem Statusfilter: „Ready" + Not Created = keine BL-Zeile, „Ready" + Created = die beiden fertigen mit Rechnung.
    await clickText(c, 'Ready'); await sleep(400);
    const bereitOhne = await sichtbar(c);
    await click(c, '[data-repair-filter-invoice="created"]'); await sleep(400);
    const bereitMit = await sichtbar(c);
    ok(bereitOhne === '' && bereitMit === 'BL-0001,BL-0006,BX-0002', `INDIKATOR ${wer} zusammen mit Status „Ready" (Not Created: ${bereitOhne || 'leer'} / Created: ${bereitMit})`);
    await clickText(c, 'All'); await click(c, '[data-repair-filter-invoice="all"]'); await sleep(400);
    ok(await sichtbar(c) === 'BL-0001,BL-0002,BL-0003,BL-0004,BL-0005,BL-0006,BL-0007,BX-0001,BX-0002', `INDIKATOR ${wer} „All": wieder alle neun`);
    // Klick auf die Anzeige öffnet die Rechnung (nicht die Reparatur).
    const r1 = BL.find((r) => r.nr === 'BL-0002');
    await c.ev(`const row=${zeileVon('BL-0002')}; row.querySelector('[data-repair-invoice-open]').click(); return 1;`);
    ok(await warteBis(c, `location.pathname === ${S('/invoices/' + r1.inv)} && document.body.innerText.includes(${S(r1.num)})`, 20000),
      `INDIKATOR ${wer} Klick öffnet die Rechnung ${r1.num}`);
  }
  client = await lade(client, '/repairs');
  await indikator('PC2', client);
  await geh(primary, '/repairs');
  await indikator('Primary', primary);
  ok(Number(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM invoices WHERE notes LIKE '%BL-000%'")[0]?.n) === 4
    && dbQ(BIZ_DB, "SELECT status FROM invoices WHERE id = 'bx-inv-entwurf'")[0]?.status === 'DRAFT'
    && dbQ(BIZ_DB, "SELECT invoice_id FROM repairs WHERE id = 'bx-rep-1'")[0]?.invoice_id === 'bx-inv-gibt-es-nicht'
    && (await kommandos(client)).filter((x) => /^(repairs|invoices|payments)\./.test(String(x.op))).length === 0,
    'INDIKATOR Anzeige und Filter schicken nichts und legen keine Rechnung an');

  // ── 3c) REPAIR-TYPE FINAL CORRECTION — Internal (Vorwahl) + erste Werkstattzeile über die Maske → External ──
  async function werkstattZeile(c) {
    const auf = await c.ev("const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().endsWith('Add Work')); if(!b) return 'NO'; b.click(); return 'OK';");
    if (auf !== 'OK') return 'KEIN-KNOPF';
    if (!(await warteBis(c, "!!document.querySelector('[data-repair-line-source-external]')", 10000))) return 'KEINE-MASKE';
    await click(c, '[data-repair-line-source-external]'); await sleep(300);
    await c.ev("const t=document.querySelector('[data-ss-trigger=\"Pick a workshop / goldsmith\"]'); if(t) t.click(); return 1;"); await sleep(500);
    const w = await c.ev("const o=document.querySelector('[data-ss-option=\"bt-ws\"]'); if(!o) return 'NO'; o.click(); return 'OK';");
    if (w !== 'OK') return 'KEINE-WERKSTATT';
    await sleep(300);
    const k = await c.ev("let e=document.querySelector('[data-repair-line-cost]'); if(e&&e.tagName!=='INPUT') e=e.querySelector('input'); if(!e) return 'NO';"
      + "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'20'); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';");
    if (k !== 'OK') return 'KEINE-KOSTEN';
    await sleep(300);
    return c.ev("const b=document.querySelector('[data-add-repair-line]'); if(!b) return 'NO'; if(b.disabled) return 'DIS'; b.click(); return 'OK';");
  }
  const typRep = (id) => dbQ(BIZ_DB, 'SELECT repair_type, workshop_supplier_id, actual_cost, margin, status FROM repairs WHERE id = ?', [id])[0] || {};
  for (const [wer, [rid, nr], apSoll] of [['PC2', TREP[0], 20], ['Primary', TREP[1], 40]]) {
    let c;
    if (wer === 'PC2') { client = await lade(client, '/repairs/' + rid); c = client; } else { await geh(primary, '/repairs/' + rid); c = primary; }
    await warteBis(c, `document.body.innerText.includes(${S(nr)})`, 30000);
    ok(typRep(rid).repair_type === 'internal', `TYP ${wer} ${nr}: angelegt mit der Vorwahl In-house`);
    const z = await werkstattZeile(c);
    ok(z === 'OK', `TYP ${wer} Werkstattzeile 20 über die Maske (${z} ${String(await fehlerAnzeige(c)).slice(0, 120)})`);
    ok(await warteAuf(() => typRep(rid).repair_type === 'external'), `TYP ${wer} gespeichert: External, nicht Hybrid (${S(typRep(rid))})`);
    const aud = dbQ(BIZ_DB, "SELECT new_value FROM audit_log WHERE entity_id = ? AND field_name = 'repairType'", [rid]).map((r) => r.new_value);
    ok(!aud.includes('hybrid') && typRep(rid).workshop_supplier_id === 'bt-ws' && Number(typRep(rid).actual_cost) === 20 && Number(typRep(rid).margin) === 40,
      `TYP ${wer} nie Hybrid im Protokoll; Werkstatt, Kosten 20, Marge 40 (${S(typRep(rid))})`);
    const exp = dbQ(BIZ_DB, "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'", [rid])[0] || {};
    const apWs = Number(dbQ(BIZ_DB, "SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0) AS s FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND counterparty_id = 'bt-ws'")[0]?.s);
    const saldo = Number(dbQ(BIZ_DB, "SELECT ROUND(COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0), 3) AS s FROM ledger_entries")[0]?.s);
    ok(Number(exp.n) === 1 && Number(exp.s) === 20 && Math.abs(apWs - apSoll) < 0.0005 && Math.abs(saldo) < 0.0005,
      `TYP ${wer} genau eine Werkstatt-Verbindlichkeit 20 (Werkstatt gesamt ${apWs}), Hauptbuch ausgeglichen`);
    if (wer === 'PC2') {
      const cm = (await kommandos(client)).filter((x) => x.op === 'repairs.add_line');
      ok(cm.length === 1, `TYP PC2 genau EIN Auftrag repairs.add_line (${cm.length})`);
      client = await lade(client, '/repairs/' + rid); c = client;
    } else { await geh(primary, '/repairs'); await geh(primary, '/repairs/' + rid); }
    ok(await warteBis(c, "document.querySelector('[data-repair-work-source]')?.getAttribute('data-repair-work-source') === 'external' && /sent to workshop/i.test(document.body.innerText)", 30000),
      `TYP ${wer} Detailseite: Arbeitsquelle External, „Sent to workshop" wird angeboten`);
  }

  // ── 3b) v0.8.94 Quick Edit aus der Liste — PC2 und Primary ────────────
  const rep = (id) => dbQ(BIZ_DB, 'SELECT * FROM repairs WHERE id = ?', [id])[0] || {};
  const offeneZeilen = (id) => dbQ(BIZ_DB, "SELECT * FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'", [id]);
  /** „Edit" in der Zeile der Liste → das Quick-Edit-Fenster dieser Reparatur. */
  async function quickOeffnen(c, nr) {
    if (!(await warteBis(c, `document.body.innerText.includes(${S(nr)})`, 30000))) return 'KEINE-ZEILE';
    const k = await c.ev(`const b=document.querySelector('[data-repair-quick-edit=${S(nr)}]'); if(!b) return 'NO'; b.click(); return 'OK';`);
    if (k !== 'OK') return k;
    return (await warteBis(c, `!!document.querySelector('[data-repair-quick-edit-modal=${S(nr)}]')`, 15000)) ? 'OK' : 'KEIN-FENSTER';
  }
  {
    // PC2 — BQ-0001: Preis ändern, Arbeitszeile im Haus, Abholung vor 2 Tagen mit Rechnung (0 %), datiert auf den Abholtag.
    client = await lade(client, '/repairs');
    ok(await quickOeffnen(client, 'BQ-0001') === 'OK', 'QUICK PC2: „Edit" öffnet das Quick-Edit-Fenster');
    await setVal(client, '[data-quick-charge]', '75'); await sleep(200);
    await click(client, '[data-quick-save-amounts]');
    ok(await warteAuf(() => Number(rep('bq-rep-1').charge_to_customer) === 75), `QUICK PC2: Preis 50 → 75 gespeichert (${await fehlerAnzeige(client)})`);
    await warteBis(client, "!document.querySelector('[data-quick-save-amounts]') || document.querySelector('[data-quick-save-amounts]').disabled", 15000);
    await click(client, '[data-quick-add-work]'); await sleep(300);
    // REPAIR-REDESIGN — die Quelle ist ein Schalter (In-house | External workshop); In-house ist vorbelegt.
    await click(client, '[data-quick-work-source-inhouse]'); await sleep(200);
    await setVal(client, '[data-quick-work-description]', 'Politur'); await setVal(client, '[data-quick-work-cost]', '5'); await sleep(200);
    await click(client, '[data-quick-work-save]');
    ok(await warteAuf(() => offeneZeilen('bq-rep-1').length === 1 && Number(offeneZeilen('bq-rep-1')[0].cost_amount) === 5),
      `QUICK PC2: Arbeitszeile „Politur" 5 im Haus angelegt (${await fehlerAnzeige(client)})`);
    ok(await warteBis(client, "(document.querySelector('[data-quick-lines-total]')?.textContent || '').includes('5')", 20000),
      'QUICK PC2: die Summen im Fenster zeigen die neue Zeile');
    await warteBis(client, "!!document.querySelector('[data-quick-status-target=\"picked_up\"]') && !document.querySelector('[data-quick-status-target=\"picked_up\"]').disabled", 20000);
    await click(client, '[data-quick-status-target="picked_up"]');
    ok(await warteBis(client, "!!document.querySelector('[data-pickup-date]')", 10000), 'QUICK PC2: „Picked Up" fragt den Abholtag');
    await setVal(client, '[data-pickup-date]', TAG(2)); await sleep(200);
    await click(client, '[data-pickup-invoice]'); await sleep(200);
    await click(client, '[data-pickup-invoice-tax="ZERO"] input'); await sleep(200);
    await click(client, '[data-status-confirm]');
    ok(await warteAuf(() => rep('bq-rep-1').status === 'picked_up' && String(rep('bq-rep-1').picked_up_at) === `${TAG(2)}T12:00:00.000Z`
      && String(rep('bq-rep-1').picked_up_recorded_at || '').slice(0, 10) === TAG(0)),
    `QUICK PC2: abgeholt am ${TAG(2)}, erfasst heute (${S([rep('bq-rep-1').picked_up_at, rep('bq-rep-1').picked_up_recorded_at])})`);
    ok(await warteAuf(() => !!rechnungVon('bq-rep-1')), `QUICK PC2: die Rechnung entsteht gleich mit (${await fehlerAnzeige(client)})`);
    const inv = dbQ(BIZ_DB, 'SELECT substr(issued_at, 1, 10) AS d, gross_amount FROM invoices WHERE id = ?', [rechnungVon('bq-rep-1')])[0] || {};
    const zl = dbQ(BIZ_DB, 'SELECT tax_scheme, vat_amount FROM invoice_lines WHERE invoice_id = ?', [rechnungVon('bq-rep-1')]);
    ok(inv.d === TAG(2) && Number(inv.gross_amount) === 75 && zl.length === 1 && zl[0].tax_scheme === 'ZERO' && Number(zl[0].vat_amount) === 0,
      `QUICK PC2: Rechnung datiert auf den Abholtag ${TAG(2)}, 75 ohne VAT (${S(inv)} ${S(zl)})`);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'repairs.update_status' && x.payload.repairId === 'bq-rep-1');
    ok(cmds.length === 1 && cmds[0].payload.pickedUpDate === TAG(2), `QUICK PC2: EIN Statusauftrag mit dem Abholtag (${S(cmds.map((x) => x.payload))})`);
  }
  {
    // Primary — BQ-0002: „Returned" aus Versehen, dann „Reopen as Ready" (alter Stand zurück, protokolliert).
    await geh(primary, '/repairs');
    ok(await quickOeffnen(primary, 'BQ-0002') === 'OK', 'QUICK Primary: dasselbe Fenster');
    await click(primary, '[data-quick-status-target="returned"]');
    ok(await warteBis(primary, "!!document.querySelector('[data-repair-status-dialog=\"returned\"]')", 10000), 'QUICK Primary: „Returned" fragt nach');
    await click(primary, '[data-status-confirm]');
    ok(await warteAuf(() => rep('bq-rep-2').status === 'returned' && rep('bq-rep-2').return_from_status === 'ready'),
      `QUICK Primary: zurückgegeben, die Stufe davor gemerkt (${S([rep('bq-rep-2').status, rep('bq-rep-2').return_from_status])})`);
    ok(await warteBis(primary, "!!document.querySelector('[data-quick-status-target=\"reopen\"]')", 15000), 'QUICK Primary: jetzt wird „Reopen" angeboten');
    await click(primary, '[data-quick-status-target="reopen"]');
    ok(await warteBis(primary, "!!document.querySelector('[data-repair-status-dialog=\"reopen\"]')", 10000), 'QUICK Primary: das Reopen-Fenster');
    await click(primary, '[data-status-confirm]');
    ok(await warteAuf(() => rep('bq-rep-2').status === 'ready' && !rep('bq-rep-2').return_from_status && !!rep('bq-rep-2').completed_at),
      `QUICK Primary: wieder „ready", Merker geleert (${S([rep('bq-rep-2').status, rep('bq-rep-2').return_from_status])})`);
    ok(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = 'bq-rep-2' AND action_type = 'STATUS_CHANGE' AND old_value = 'returned' AND new_value = 'ready' AND changed_by IS NOT NULL")[0]?.n === 1,
      'QUICK Primary: die Rücknahme steht im Audit-Protokoll (Benutzer, Zeitpunkt)');
    await primary.ev("document.querySelector('[data-repair-quick-edit-modal] ')?.closest('.fixed')?.querySelector('.absolute')?.click(); return 1;");
    await sleep(500);
    // Primary — BQ-0003: „Picked Up" direkt in der Zeile → Abholtag gestern, ohne Rechnung.
    await geh(primary, '/repairs?r=' + Date.now());
    await warteBis(primary, "document.body.innerText.includes('BQ-0003')", 20000);
    const zeile = await primary.ev(`const row=[...document.querySelectorAll('div.cursor-pointer')].find(d=>d.style&&d.style.gridTemplateColumns&&d.textContent.includes('BQ-0003'));`
      + `const b=row&&[...row.querySelectorAll('button')].find(x=>x.textContent.trim()==='Picked Up'); if(!b) return 'NO'; b.click(); return 'OK';`);
    ok(zeile === 'OK' && await warteBis(primary, "!!document.querySelector('[data-pickup-date]')", 10000), `QUICK Primary: „Picked Up" in der Zeile fragt den Abholtag (${zeile})`);
    await setVal(primary, '[data-pickup-date]', TAG(1)); await sleep(200);
    await click(primary, '[data-status-confirm]');
    ok(await warteAuf(() => rep('bq-rep-3').status === 'picked_up' && String(rep('bq-rep-3').picked_up_at) === `${TAG(1)}T12:00:00.000Z` && !rechnungVon('bq-rep-3')),
      `QUICK Primary: abgeholt am ${TAG(1)}, keine Rechnung ohne Wahl (${S([rep('bq-rep-3').status, rep('bq-rep-3').picked_up_at])})`);
  }

  // ── 4) Der Client besitzt nichts ───────────────────────────────────────
  ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-location|\.db$/i.test(f));
  ok(verboten.length === 0, `LOKAL kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
  try { console.log('      (Primary) ' + (primary?.events || []).slice(-10).join('\n      (Primary) ')); } catch { /* egal */ }
  try { console.log('      (PC2) ' + (client?.events || []).slice(-10).join('\n      (PC2) ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5c: billable rule, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5C_BILLABLE_RUNTIME_PROVED');
