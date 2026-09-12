// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6B — die acht B-Einstiege und die gefährlichen Stellen, zwei echte Anwendungen.
// Run: node test/e2e/r6b-safety-existing-commands.e2e.mjs
//
//   B   /invoices/:id/edit Save Changes           → invoices.update          (Primary == PC2, Datum gleich)
//       /invoices  Pay (Teil)                      → invoices.record_payment
//       /invoices  Pay → Nummernwahl Normal        → invoices.record_payment  (zweiter Einstieg)
//       /invoices  Pay → Nummernwahl Sonder (PC2)  → ehrliches Nein, kein Auftrag
//       /invoices/:id  Mark as Picked Up           → repairs.update_status    (nur die fertige Reparatur)
//       /collection/:id  Confirm AI Identification → products.update {aiConfirmedAt:true}
//       /orders  Pay                               → orders.add_payment
//       /consignments Items → Return               → consignments.mark_returned
//       /consignors/:id  Return                    → consignments.mark_returned (zweiter Einstieg)
//   SAFETY auf dem datenbanklosen PC2 (mit einer ALTEN lataif.db im Datenordner):
//       Inventur/Stock-Check gesperrt, kein Aufruf des lokalen Kerns · /import gesperrt ·
//       Löschknöpfe gesperrt · Abmelden führt zurück zur Anmeldung · nichts Lokales geschrieben.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
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
const OWNER_PW = 'r6b-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r6b-safety', 'run-' + Date.now());
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
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif-e2e-client.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  process.exit(1);
}, 35 * 60 * 1000);

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

const killImage = (n) => { try { execFileSync('taskkill', ['/F', '/IM', n, '/T'], { stdio: 'ignore' }); } catch { /* war nicht da */ } };
const killAll = () => { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); };
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const o = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' }); if (!o.includes(name)) return; } catch { return; }
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
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
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

// Der Beobachter: Fernaufträge, Datenbankgriffe, Kern-Aufrufe (invoke), Dialoge.
const BEOBACHTER = `
  if (window.__r6bInstalliert) { /* schon da */ } else {
  window.__r6bInstalliert = true;
  window.__cmds = []; window.__dbHits = []; window.__invokes = []; window.__alerts = [];
  window.alert = (m) => { window.__alerts.push(String(m)); };
  window.confirm = () => true;
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => {
    const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/Database not initialized/.test(t)) merke(t);
    oe(...a);
  };
  const ow = console.warn;
  console.warn = (...a) => {
    const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/Database not initialized/.test(t)) merke(t);
    ow(...a);
  };
  (function haken() {
    const t = window.__TAURI_INTERNALS__;
    if (t && t.invoke && !t.__r6b) {
      const oi = t.invoke.bind(t);
      t.invoke = (cmd, args, opts) => { window.__invokes.push(String(cmd)); return oi(cmd, args, opts); };
      t.__r6b = true;
    } else if (!t || !t.__r6b) setTimeout(haken, 30);
  })();
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
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`)
    .run(...nutzbar.map((k) => daten[k]));
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
const gehZu = async (p, route, merkmal) => { await geh(p, route); await warteBis(p, 'document.body.innerText.includes(' + S(merkmal) + ')', 20000); await sleep(700); };
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)) && !/^store\.|^page\.|^domain\.|^session\./.test(String(x.op)));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const aufrufe = (c) => c.ev('return JSON.stringify(window.__invokes || []);').then((s) => JSON.parse(s || '[]'));
const hinweise = (c) => c.ev('return JSON.stringify(window.__alerts || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const fehlerAnzeige = (c) => c.ev("return [...document.querySelectorAll('[data-save-error]')].map(e=>e.textContent).join(' | ');");
let primary = null, client = null;

const norm = (r, ohne, auch = []) => S(Object.fromEntries(Object.entries(r || {}).filter(([k]) => !ohne.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b))));
async function warteAuf(pruefe) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}
const INV_OHNE = /^(id|invoice_number|revision|version|sync_status|created_by|customer_id)$|_at$/;
const rechnung = (inv) => dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [inv])[0] || {};
const rechnungN = (inv) => norm(rechnung(inv), INV_OHNE);
const zahlungen = (inv) => S(dbQ(BIZ_DB, 'SELECT amount, method FROM payments WHERE invoice_id = ? ORDER BY amount', [inv]));
const buchung = (inv) => S(dbQ(BIZ_DB, `SELECT account, direction, ROUND(SUM(amount), 3) AS s, COUNT(*) AS n FROM ledger_entries
  WHERE source_id = ? OR source_id IN (SELECT id FROM payments WHERE invoice_id = ?) GROUP BY account, direction ORDER BY account, direction`, [inv, inv]));
const reparatur = (id) => (dbQ(BIZ_DB, 'SELECT status FROM repairs WHERE id = ?', [id])[0] || {}).status;
const REP_OHNE = /^(id|repair_number|invoice_id|revision|version|sync_status|created_by|voucher_code)$|_at$/;
const reparaturN = (id) => norm(dbQ(BIZ_DB, 'SELECT * FROM repairs WHERE id = ?', [id])[0], REP_OHNE);
const kiStempel = (pid) => String((dbQ(BIZ_DB, 'SELECT ai_confirmed_at FROM products WHERE id = ?', [pid])[0] || {}).ai_confirmed_at ?? '');
const anzahlungen = (ord) => S(dbQ(BIZ_DB, 'SELECT amount, method, paid_at FROM order_payments WHERE order_id = ? ORDER BY amount', [ord]));
const kommission = (id) => dbQ(BIZ_DB, 'SELECT status, payout_status FROM consignments WHERE id = ?', [id])[0] || {};
const kommissionsWare = (id) => (dbQ(BIZ_DB, 'SELECT p.stock_status FROM products p JOIN consignments c ON c.product_id = p.id WHERE c.id = ?', [id])[0] || {}).stock_status;
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

// ── Die Welt des Laufs ──
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'r6b-cat', branch_id, name: 'R6B Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    const kunde = (id, first, last) => insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    kunde('r6b-kunde', 'Maya', 'Safety'); kunde('r6b-einl-P', 'Pia', 'Einlieferer'); kunde('r6b-einl-C', 'Carl', 'Einlieferer');
    insert(db, 'employees', { id: 'r6b-emp', branch_id, name: 'R6B Kasse', employment_status: 'active', created_at: now, updated_at: now });
    const artikel = (id, extra) => insert(db, 'products', { id, branch_id, category_id: 'r6b-cat', brand: 'Tudor', name: 'R6B ' + id, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: 220, tax_scheme: 'VAT_10', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', revision: 1, created_at: now, updated_at: now, ...extra });
    const verkauft = (pid, status) => {
      artikel(pid, { stock_status: status, quantity: 0 });
      insert(db, 'stock_lots', { id: `${pid}-lot`, branch_id, product_id: pid, unit_cost: 100, qty_total: 1, qty_remaining: 0, status: 'EXHAUSTED', acquired_at: now, created_at: now });
    };
    const rechnungAnlegen = (inv, status, gross, bezahlt, pid) => {
      insert(db, 'invoices', { id: inv, branch_id, invoice_number: inv.toUpperCase(), customer_id: 'r6b-kunde', status, currency: 'BHD', net_amount: gross / 1.1, vat_rate_snapshot: 10, vat_amount: gross - gross / 1.1, gross_amount: gross, paid_amount: bezahlt, tax_scheme_snapshot: 'VAT_10', issued_at: '2026-09-10T00:00:00.000Z', revision: 1, created_at: now, updated_at: now });
      insert(db, 'invoice_lines', { id: `${inv}-l1`, invoice_id: inv, product_id: pid, lot_id: `${pid}-lot`, quantity: 1, unit_price: 200, purchase_price: 100, vat_rate: 10, tax_scheme: 'VAT_10', vat_amount: 20, line_total: 220, position: 1 });
      if (bezahlt > 0) insert(db, 'payments', { id: `${inv}-pay`, branch_id, invoice_id: inv, amount: bezahlt, method: 'cash', received_at: now, created_at: now });
    };
    // Rechnung ändern, Zahlungen aus der Liste, Sonderkreis, Löschknopf — offen, unbezahlt.
    for (const t of ['EP', 'EC', 'LP', 'LC', 'NP', 'NC', 'SC', 'DC']) {
      verkauft(`r6b-p${t}`, 'reserved');
      rechnungAnlegen(`r6b-inv-${t}`, 'PARTIAL', 220, 0, `r6b-p${t}`);
    }
    // Abholen: bezahlte Rechnung, eine fertige und eine Reparatur in Arbeit.
    for (const t of ['RP', 'RC']) {
      verkauft(`r6b-p${t}`, 'sold');
      rechnungAnlegen(`r6b-inv-${t}`, 'FINAL', 220, 220, `r6b-p${t}`);
      for (const [n, st] of [['1', 'ready'], ['2', 'in_progress']]) {
        insert(db, 'repairs', { id: `r6b-rep-${t}${n}`, branch_id, repair_number: `R6B-REP-${t}${n}`, customer_id: 'r6b-kunde', item_brand: 'Rolex', item_model: 'Datejust', issue_description: 'Service', repair_type: 'internal', repair_scope: 'CUSTOMER', status: st, charge_to_customer: 200, internal_cost: 0, invoice_id: `r6b-inv-${t}`, revision: 1, received_at: now, created_at: now, updated_at: now });
      }
    }
    // KI-Bestätigung.
    for (const t of ['P', 'C']) artikel(`r6b-ai-${t}`, { stock_status: 'in_stock', quantity: 1, ai_identified_snapshot: JSON.stringify({ brand: 'Tudor', model: 'Black Bay' }) });
    // Aufträge.
    for (const t of ['P', 'C']) insert(db, 'orders', { id: `r6b-ord-${t}`, branch_id, order_number: `R6B-ORD-${t}`, customer_id: 'r6b-kunde', requested_brand: 'Omega', requested_model: 'Speedmaster', agreed_price: 500, status: 'pending', type: 'normal', revision: 1, created_at: now, updated_at: now });
    // Kommissionen: Liste (L) und Einlieferer (D).
    for (const [t, einl] of [['LP', 'r6b-einl-P'], ['LC', 'r6b-einl-C'], ['DP', 'r6b-einl-P'], ['DC', 'r6b-einl-C']]) {
      artikel(`r6b-cp${t}`, { stock_status: 'in_stock', quantity: 1, source_type: 'CONSIGNMENT' });
      insert(db, 'consignments', { id: `r6b-con-${t}`, branch_id, consignment_number: `R6B-CON-${t}`, consignor_id: einl, product_id: `r6b-cp${t}`, agreed_price: 1000, commission_rate: 15, commission_type: 'percent', status: 'active', payout_status: 'pending', agreement_date: now, revision: 1, created_at: now, updated_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Die Masken ──
async function rechnungAendern(c) {
  if (!(await warteBis(c, "document.querySelector('[data-save-invoice]') && document.querySelector('textarea[placeholder^=\"Explain why\"]')", 45000))) return 'KEINE-MASKE';
  await sleep(800);
  const r = [
    await setVal(c, 'textarea[placeholder^="e.g. delivery details"]', 'R6B geaenderte Notiz'),
    await setVal(c, 'input[type="date"]', '2026-09-01'),
    await setVal(c, 'textarea[placeholder^="Explain why"]', 'R6B Grund der Aenderung'),
  ];
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
async function listenZahlung(c, inv, betrag) {
  if (!(await warteBis(c, `document.querySelector('[data-pay-invoice="${inv}"]')`, 45000))) return 'KEIN-KNOPF';
  const r = [await c.ev(`const b=document.querySelector('[data-pay-invoice="${inv}"]'); b.click(); return 'OK';`)];
  if (!(await warteBis(c, "document.querySelector('[data-invoice-list-pay]')", 15000))) return 'KEINE-MASKE';
  r.push(await setByLabel(c, 'AMOUNT (BHD)', String(betrag)));
  r.push(await clickText(c, 'cash'));
  await sleep(250);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
async function nummerWaehlen(c, sonder) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Special Final'))", 15000))) return 'KEIN-DIALOG';
  const r = [await clickIncludes(c, sonder ? 'Special Final' : 'Normal Final')];
  await sleep(200);
  r.push(await clickText(c, 'Confirm'));
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
async function auftragZahlung(c, ord, betrag) {
  if (!(await warteBis(c, `document.querySelector('[data-pay-order="${ord}"]')`, 45000))) return 'KEIN-KNOPF';
  const r = [await c.ev(`document.querySelector('[data-pay-order="${ord}"]').click(); return 'OK';`)];
  if (!(await warteBis(c, "document.querySelector('[data-order-list-pay]')", 15000))) return 'KEINE-MASKE';
  r.push(await setByLabel(c, 'AMOUNT (BHD)', String(betrag)));
  await sleep(250);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
const gesperrt = (c, sel, art) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; return (e.disabled && e.getAttribute('data-primary-only')===${S(art)} && !!e.getAttribute('title')) ? 'GESPERRT' : ('OFFEN:'+e.disabled+':'+e.getAttribute('data-primary-only'));`);
const knopfMitText = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(text)}); if(!b.length) return 'NO'; const x=b[0]; return (x.disabled ? 'D' : 'E') + ':' + (x.getAttribute('data-primary-only')||'-');`);

try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R6B Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R6B Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R6B Admin');
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
  ok(true, 'CONNECT frischer Rechner, echter Klick auf „Connect", Anmeldung — dann die normale Anwendung');
  await beobachterLegen();

  // ══════════════════════════════════════════════════════════════════════
  // B1 — Rechnung ändern (Edit-Seite) → invoices.update
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/invoices/r6b-inv-EC/edit');
    { const m = await rechnungAendern(client); ok(m === 'OK', `EDIT die Maske am zweiten Rechner (${m})`); }
    await click(client, '[data-save-invoice]');
    ok(await warteAuf(() => rechnung('r6b-inv-EC').notes === 'R6B geaenderte Notiz'), `EDIT die Änderung steht am Primary (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const c = (await buchungen(client)).filter((x) => x.op !== 'customers.create');
    const p = c[0]?.payload || {};
    ok(c.length === 1 && c[0].op === 'invoices.update' && p.id === 'r6b-inv-EC' && p.expectedRevision === 1 && p.reason === 'R6B Grund der Aenderung'
      && p.issuedDate === '2026-09-01' && !('deltaPayment' in p) && Array.isArray(p.lines) && p.lines.length === 1,
    `EDIT genau EIN Auftrag invoices.update — Rechnung, Fassung, Grund, Datum, Zeilen, keine Zahlung (${c.map((x) => x.op).join(',')} · ${Object.keys(p).join(',')})`);
    await gehZu(primary, '/invoices/r6b-inv-EP/edit', 'Save Changes');
    { const m = await rechnungAendern(primary); ok(m === 'OK', `EDIT-PARITAET dieselbe Maske am Primary (${m})`); }
    await click(primary, '[data-save-invoice]');
    ok(await warteAuf(() => rechnung('r6b-inv-EP').notes === 'R6B geaenderte Notiz'), 'EDIT-PARITAET der Primary ändert');
    ok(rechnungN('r6b-inv-EP') === rechnungN('r6b-inv-EC'), `EDIT-PARITAET Rechnung: Primary == PC2${rechnungN('r6b-inv-EP') !== rechnungN('r6b-inv-EC') ? ` (${rechnungN('r6b-inv-EP')} / ${rechnungN('r6b-inv-EC')})` : ''}`);
    const dP = rechnung('r6b-inv-EP').issued_at, dC = rechnung('r6b-inv-EC').issued_at;
    ok(dP === '2026-09-01T00:00:00.000Z' && dC === dP, `EDIT-PARITAET das Datum steht auf beiden Wegen gleich (${dP} / ${dC})`);
    const eP = dbQ(BIZ_DB, 'SELECT reason FROM invoice_edits WHERE invoice_id = ?', ['r6b-inv-EP']);
    const eC = dbQ(BIZ_DB, 'SELECT reason FROM invoice_edits WHERE invoice_id = ?', ['r6b-inv-EC']);
    ok(eP.length === 1 && eC.length === 1 && eP[0].reason === eC[0].reason, `EDIT-PARITAET je EIN Prüfvermerk mit demselben Grund (${eP.length}/${eC.length})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // B2/B3 — „Pay" in der Rechnungsliste, und die Nummernwahl → invoices.record_payment
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/invoices');
    const vorher = (await buchungen(client)).length;
    { const m = await listenZahlung(client, 'r6b-inv-LC', 100); ok(m === 'OK', `PAY die Zahlmaske der Liste am zweiten Rechner (${m})`); }
    await click(client, '[data-invoice-list-pay]');
    ok(await warteAuf(() => Number(rechnung('r6b-inv-LC').paid_amount) === 100), `PAY die Teilzahlung steht am Primary (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    let c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'invoices.record_payment' && S(c[0].payload) === S({ invoiceId: 'r6b-inv-LC', amount: 100, method: 'cash' }),
      `PAY genau EIN Auftrag invoices.record_payment — Rechnung, Betrag, Weg (${c.map((x) => x.op + S(x.payload)).join(',')})`);

    await sleep(1500);
    const vorher2 = (await buchungen(client)).length;
    { const m = await listenZahlung(client, 'r6b-inv-NC', 220); ok(m === 'OK', `PAY-FINAL die Zahlmaske (${m})`); }
    await click(client, '[data-invoice-list-pay]');
    { const m = await nummerWaehlen(client, false); ok(m === 'OK', `PAY-FINAL die Nummernwahl „Normal" — der zweite Einstieg (${m})`); }
    ok(await warteAuf(() => rechnung('r6b-inv-NC').status === 'FINAL' && Number(rechnung('r6b-inv-NC').paid_amount) === 220), 'PAY-FINAL die Rechnung ist voll bezahlt und endgültig');
    c = (await buchungen(client)).slice(vorher2);
    ok(c.length === 1 && c[0].op === 'invoices.record_payment' && S(c[0].payload) === S({ invoiceId: 'r6b-inv-NC', amount: 220, method: 'cash' }),
      `PAY-FINAL auch der zweite Einstieg erreicht dieselbe Buchung, genau einmal (${c.map((x) => x.op).join(',')})`);

    await sleep(1500);
    const vorher3 = (await buchungen(client)).length;
    const hinweisVorher = (await hinweise(client)).length;
    { const m = await listenZahlung(client, 'r6b-inv-SC', 220); ok(m === 'OK', `SONDER die Zahlmaske (${m})`); }
    await click(client, '[data-invoice-list-pay]');
    { const m = await nummerWaehlen(client, true); ok(m === 'OK', `SONDER die Nummernwahl „Special" (${m})`); }
    await sleep(1500);
    const h = (await hinweise(client)).slice(hinweisVorher);
    ok(h.some((x) => /special number circle/.test(x) && /not available on a connected client/.test(x)), `SONDER ehrliches Nein am zweiten Rechner (${S(h).slice(0, 160)})`);
    ok((await buchungen(client)).length === vorher3 && Number(rechnung('r6b-inv-SC').paid_amount) === 0 && rechnung('r6b-inv-SC').status === 'PARTIAL',
      'SONDER kein Auftrag, keine Zahlung, kein stiller Normalkreis');

    await gehZu(primary, '/invoices', 'R6B-INV-LP');
    await primary.ev(DIALOGE_PRIMARY);
    { const m = await listenZahlung(primary, 'r6b-inv-LP', 100); ok(m === 'OK', `PAY-PARITAET die Zahlmaske am Primary (${m})`); }
    await click(primary, '[data-invoice-list-pay]');
    ok(await warteAuf(() => Number(rechnung('r6b-inv-LP').paid_amount) === 100), 'PAY-PARITAET der Primary bucht');
    await sleep(1200);
    { const m = await listenZahlung(primary, 'r6b-inv-NP', 220); ok(m === 'OK', `PAY-FINAL-PARITAET die Zahlmaske am Primary (${m})`); }
    await click(primary, '[data-invoice-list-pay]');
    { const m = await nummerWaehlen(primary, false); ok(m === 'OK', `PAY-FINAL-PARITAET Nummernwahl am Primary (${m})`); }
    ok(await warteAuf(() => rechnung('r6b-inv-NP').status === 'FINAL'), 'PAY-FINAL-PARITAET der Primary schließt die Rechnung');
    ok(rechnungN('r6b-inv-LP') === rechnungN('r6b-inv-LC') && zahlungen('r6b-inv-LP') === zahlungen('r6b-inv-LC')
      && rechnungN('r6b-inv-NP') === rechnungN('r6b-inv-NC') && zahlungen('r6b-inv-NP') === zahlungen('r6b-inv-NC'),
    `PAY-PARITAET Rechnung und Zahlungen: Primary == PC2${rechnungN('r6b-inv-NP') !== rechnungN('r6b-inv-NC') ? ` (${rechnungN('r6b-inv-NP')} / ${rechnungN('r6b-inv-NC')})` : ''}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // B4 — „Mark as Picked Up" → repairs.update_status (nur die fertige Reparatur)
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/invoices/r6b-inv-RC');
    const vorher = (await buchungen(client)).length;
    ok(await warteBis(client, "document.querySelector('[data-repair-pickup]')", 45000), 'PICKUP der Knopf steht an der bezahlten Rechnung');
    await click(client, '[data-repair-pickup]');
    ok(await warteAuf(() => reparatur('r6b-rep-RC1') === 'picked_up'), `PICKUP die fertige Reparatur ist abgeholt (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    await sleep(1200);
    const c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'repairs.update_status' && S(c[0].payload) === S({ repairId: 'r6b-rep-RC1', status: 'picked_up', expectedRevision: 1 }),
      `PICKUP genau EIN Auftrag — die fertige Reparatur mit ihrer Fassung (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    ok(reparatur('r6b-rep-RC2') === 'in_progress', 'PICKUP die Reparatur in Arbeit überspringt „ready" NICHT');
    await gehZu(primary, '/invoices/r6b-inv-RP', 'R6B-INV-RP');
    await primary.ev(DIALOGE_PRIMARY);
    ok(await warteBis(primary, "document.querySelector('[data-repair-pickup]')", 30000), 'PICKUP-PARITAET derselbe Knopf am Primary');
    await click(primary, '[data-repair-pickup]');
    ok(await warteAuf(() => reparatur('r6b-rep-RP1') === 'picked_up'), 'PICKUP-PARITAET der Primary holt ab');
    ok(reparatur('r6b-rep-RP2') === 'in_progress', 'PICKUP-PARITAET auch am Primary springt die Reparatur in Arbeit nicht mehr (Primary-Fix)');
    ok(reparaturN('r6b-rep-RP1') === reparaturN('r6b-rep-RC1'), `PICKUP-PARITAET Reparatur: Primary == PC2${reparaturN('r6b-rep-RP1') !== reparaturN('r6b-rep-RC1') ? ` (${reparaturN('r6b-rep-RP1')} / ${reparaturN('r6b-rep-RC1')})` : ''}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // B5 — „Confirm AI Identification" → products.update { aiConfirmedAt: true }
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/collection/r6b-ai-C');
    const vorher = (await buchungen(client)).length;
    ok(await warteBis(client, "document.querySelector('[data-ai-confirm]')", 45000), 'AI der Knopf steht am identifizierten Artikel');
    await click(client, '[data-ai-confirm]');
    ok(await warteAuf(() => kiStempel('r6b-ai-C') !== ''), `AI die Bestätigung steht am Primary (${kiStempel('r6b-ai-C')})`);
    const c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'products.update' && S(c[0].payload) === S({ id: 'r6b-ai-C', aiConfirmedAt: true }),
      `AI genau EIN Auftrag — nur die Absicht, keine Uhrzeit des Clients (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    ok(/^\d{4}-\d{2}-\d{2}T/.test(kiStempel('r6b-ai-C')), 'AI die Zeit stempelt der Primary');
    await gehZu(primary, '/collection/r6b-ai-P', 'R6B r6b-ai-P');
    ok(await warteBis(primary, "document.querySelector('[data-ai-confirm]')", 30000), 'AI-PARITAET derselbe Knopf am Primary');
    await click(primary, '[data-ai-confirm]');
    ok(await warteAuf(() => kiStempel('r6b-ai-P') !== ''), 'AI-PARITAET der Primary bestätigt');
  }

  // ══════════════════════════════════════════════════════════════════════
  // B6 — „Pay" in der Auftragsliste → orders.add_payment
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/orders');
    const vorher = (await buchungen(client)).length;
    { const m = await auftragZahlung(client, 'r6b-ord-C', 100); ok(m === 'OK', `ORDER die Zahlmaske der Auftragsliste (${m})`); }
    await click(client, '[data-order-list-pay]');
    ok(await warteAuf(() => /"amount":100/.test(anzahlungen('r6b-ord-C'))), `ORDER die Anzahlung steht am Primary (${anzahlungen('r6b-ord-C')} · Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    const c = (await buchungen(client)).slice(vorher);
    const p = c[0]?.payload || {};
    ok(c.length === 1 && c[0].op === 'orders.add_payment' && p.orderId === 'r6b-ord-C' && p.amount === 100 && p.method === 'cash' && p.expectedRevision === 1 && /^\d{4}-\d{2}-\d{2}$/.test(p.paidAt),
      `ORDER genau EIN Auftrag orders.add_payment mit der gesehenen Fassung (${c.map((x) => x.op + S(x.payload)).join(',')})`);
    await gehZu(primary, '/orders', 'R6B-ORD-P');
    { const m = await auftragZahlung(primary, 'r6b-ord-P', 100); ok(m === 'OK', `ORDER-PARITAET die Zahlmaske am Primary (${m})`); }
    await click(primary, '[data-order-list-pay]');
    ok(await warteAuf(() => /"amount":100/.test(anzahlungen('r6b-ord-P'))), 'ORDER-PARITAET der Primary bucht');
    ok(anzahlungen('r6b-ord-P') === anzahlungen('r6b-ord-C'), `ORDER-PARITAET Anzahlung: Primary == PC2 (${anzahlungen('r6b-ord-P')} / ${anzahlungen('r6b-ord-C')})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // B7/B8 — „Return" in der Kommissionsliste und beim Einlieferer → consignments.mark_returned
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/consignments');
    await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Items ('))", 30000);
    await clickIncludes(client, 'Items (');
    const vorher = (await buchungen(client)).length;
    ok(await warteBis(client, "document.querySelector('[data-consignment-list-return=\"r6b-con-LC\"]')", 30000), 'RETURN der Knopf in der Kommissionsliste');
    await click(client, '[data-consignment-list-return="r6b-con-LC"]');
    ok(await warteAuf(() => kommission('r6b-con-LC').status === 'returned'), 'RETURN die Kommission ist zurück');
    let c = (await buchungen(client)).slice(vorher);
    ok(c.length === 1 && c[0].op === 'consignments.mark_returned' && S(c[0].payload) === S({ consignmentId: 'r6b-con-LC', expectedRevision: 1 }),
      `RETURN genau EIN Auftrag mit der gesehenen Fassung (${c.map((x) => x.op + S(x.payload)).join(',')})`);

    client = await lade(client, '/consignors/r6b-einl-C');
    const vorher2 = (await buchungen(client)).length;
    ok(await warteBis(client, "document.querySelector('[data-consignor-return=\"r6b-con-DC\"]')", 30000), 'RETURN-2 der Knopf beim Einlieferer — der zweite Einstieg');
    await click(client, '[data-consignor-return="r6b-con-DC"]');
    ok(await warteAuf(() => kommission('r6b-con-DC').status === 'returned'), 'RETURN-2 die Kommission ist zurück');
    c = (await buchungen(client)).slice(vorher2);
    ok(c.length === 1 && c[0].op === 'consignments.mark_returned' && S(c[0].payload) === S({ consignmentId: 'r6b-con-DC', expectedRevision: 1 }),
      `RETURN-2 derselbe Anschluss, genau einmal (${c.map((x) => x.op).join(',')})`);

    await gehZu(primary, '/consignments', 'Consignments');
    await clickIncludes(primary, 'Items (');
    ok(await warteBis(primary, "document.querySelector('[data-consignment-list-return=\"r6b-con-LP\"]')", 30000), 'RETURN-PARITAET derselbe Knopf am Primary');
    await click(primary, '[data-consignment-list-return="r6b-con-LP"]');
    ok(await warteAuf(() => kommission('r6b-con-LP').status === 'returned'), 'RETURN-PARITAET der Primary nimmt zurück');
    await gehZu(primary, '/consignors/r6b-einl-P', 'Pia');
    ok(await warteBis(primary, "document.querySelector('[data-consignor-return=\"r6b-con-DP\"]')", 30000), 'RETURN-2-PARITAET derselbe Knopf am Primary');
    await click(primary, '[data-consignor-return="r6b-con-DP"]');
    ok(await warteAuf(() => kommission('r6b-con-DP').status === 'returned'), 'RETURN-2-PARITAET der Primary nimmt zurück');
    ok(S([kommission('r6b-con-LP'), kommissionsWare('r6b-con-LP')]) === S([kommission('r6b-con-LC'), kommissionsWare('r6b-con-LC')])
      && S([kommission('r6b-con-DP'), kommissionsWare('r6b-con-DP')]) === S([kommission('r6b-con-DC'), kommissionsWare('r6b-con-DC')]),
    `RETURN-PARITAET Kommission und Ware: Primary == PC2 (${S([kommission('r6b-con-LC'), kommissionsWare('r6b-con-LC')])})`);
  }
  console.log('CENTRAL_UI_R6B_EXISTING_COMMANDS_RUNTIME_PROVED_CANDIDATE');

  // ══════════════════════════════════════════════════════════════════════
  // SAFETY — der datenbanklose Rechner, mit einer ALTEN Geschäftsdatei im Datenordner
  // ══════════════════════════════════════════════════════════════════════
  {
    await spuelen(primary);
    mkdirSync(CLIENT_DATA_DIR, { recursive: true });
    const STALE = join(CLIENT_DATA_DIR, 'lataif.db');
    copyFileSync(BIZ_DB, STALE);
    const staleVorher = sha(STALE);
    const dateienVorher = readdirSync(CLIENT_DATA_DIR).sort();

    // Inventur und Stock-Check
    client = await lade(client, '/collection');
    await warteBis(client, "document.querySelector('[data-testid=\"open-inventory\"]')", 30000);
    ok(await gesperrt(client, '[data-testid="open-inventory"]', 'inventory') === 'GESPERRT', 'INVENTUR „Stock Check" ist auf dem Client gesperrt und erklärt');
    await client.ev("document.querySelector('[data-testid=\"open-inventory\"]').click(); return 1;");
    await sleep(800);
    ok(!(await exists(client, '[data-testid="inv-save"]')), 'INVENTUR es öffnet sich keine Inventurmaske');
    ok(await gesperrt(client, '[data-primary-only="import"]', 'import') === 'GESPERRT', 'IMPORT „Import Excel" ist auf dem Client gesperrt und erklärt');
    ok(await knopfMitText(client, 'Select') === 'D:delete', 'DELETE „Select" (Mehrfach löschen) ist gesperrt');
    client = await lade(client, '/collection/r6b-ai-C');
    ok(await warteBis(client, "document.querySelector('[data-primary-only=\"stock-check\"]')", 30000), 'INVENTUR der Einzel-Check zeigt einen Satz statt Knöpfen');
    ok(await knopfMitText(client, 'Available') === 'NO' && await knopfMitText(client, 'Not available') === 'NO', 'INVENTUR kein „Available"/„Not available" auf dem Client');
    const inv = await aufrufe(client);
    ok(!inv.some((x) => /stock_check/.test(x)), `INVENTUR kein Aufruf des lokalen Kerns für Stock-Checks (${[...new Set(inv)].join(',').slice(0, 300)})`);

    // Import
    client = await lade(client, '/import');
    ok(await warteBis(client, "document.body.innerText.includes('Only available on the main computer')", 20000), 'IMPORT die Route sagt „nur am Hauptrechner"');
    ok(!(await client.ev("return [...document.querySelectorAll('button')].some(b=>/^Import \\d+ Items?$/.test(b.textContent.trim()));")), 'IMPORT kein Importknopf auf dem Client');

    // Löschen
    const vorherB = (await buchungen(client)).length;
    client = await lade(client, '/invoices/r6b-inv-DC');
    await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Delete')", 30000);
    ok(await knopfMitText(client, 'Delete') === 'D:delete', 'DELETE Rechnung löschen ist gesperrt und markiert');
    await client.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Delete')?.click(); return 1;");
    client = await lade(client, '/clients/r6b-kunde');
    // „Delete Client" steht in der Bearbeiten-Ansicht des Kunden (am Primary genauso).
    await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Edit Client'))", 30000);
    ok(await clickIncludes(client, 'Edit Client') === 'OK', 'DELETE die Kundenseite öffnet ihre Bearbeiten-Ansicht');
    await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Delete Client'))", 30000);
    ok(await client.ev("const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Delete Client')); return b ? (b.disabled && b.getAttribute('data-primary-only')==='delete') : false;"),
      'DELETE Kunde löschen ist gesperrt und markiert');
    await client.ev("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Delete Client'))?.click(); return 1;");
    await sleep(800);
    ok(dbQ(BIZ_DB, 'SELECT id FROM invoices WHERE id = ?', ['r6b-inv-DC']).length === 1 && dbQ(BIZ_DB, 'SELECT id FROM customers WHERE id = ?', ['r6b-kunde']).length === 1
      && (await buchungen(client)).length === vorherB, 'DELETE nichts gelöscht, kein Auftrag');

    // Primary unverändert
    await gehZu(primary, '/invoices/r6b-inv-DC', 'R6B-INV-DC');
    ok(await knopfMitText(primary, 'Delete') === 'E:-', 'PRIMARY der Löschknopf am Primary bleibt, wie er war');
    await gehZu(primary, '/collection/r6b-ai-P', 'R6B r6b-ai-P');
    ok(await warteBis(primary, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Available')", 20000) && !(await exists(primary, '[data-primary-only="stock-check"]')),
      'PRIMARY der Einzel-Check am Primary bleibt, wie er war');
    await gehZu(primary, '/collection', 'Collection');
    ok(!(await primary.ev("const b=document.querySelector('[data-testid=\"open-inventory\"]'); return !b || b.hasAttribute('data-primary-only');")), 'PRIMARY die Inventur am Primary bleibt verfügbar');

    // Stolperdrähte
    ok((await treffer(client)).length === 0, `LOKAL kein Griff zur lokalen Datenbank (${S(await treffer(client)).slice(0, 200)})`);
    const alle = await aufrufe(client);
    ok(!alle.some((x) => /stock_check|flush_database|backup|import|save_database/i.test(x)), `LOKAL kein lokaler Schreibaufruf im Kern (${[...new Set(alle)].join(',').slice(0, 300)})`);
    ok(sha(STALE) === staleVorher, 'LOKAL die alte Geschäftsdatei ist unberührt');
    const dateien = readdirSync(CLIENT_DATA_DIR).sort();
    const neu = dateien.filter((f) => !dateienVorher.includes(f));
    ok(neu.length === 0 && !dateien.some((f) => /lataif_sync_server\.db|outbox|data-location/i.test(f)), `LOKAL keine neue Datei, keine Konfig-DB, keine Outbox (${dateien.join(', ')})`);
    const schluessel = await client.ev('return JSON.stringify(Object.keys(localStorage));');
    ok(!/outbox|pending|queue/i.test(schluessel), `LOKAL keine lokale Warteschlange im Speicher (${schluessel})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // LOGOUT — zurück zu Verbinden/Anmelden
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/');
    await waitFor(client, SHELL, 30000);
    const r = await clickText(client, 'Sign Out');
    ok(r === 'OK', `LOGOUT der Knopf (${r})`);
    ok(await warteBis(client, "document.querySelector('[data-client-signin]') && document.querySelector('input[type=\"password\"]')", 20000), 'LOGOUT die Anwendung ist zurück bei der Anmeldung');
    const ls = await client.ev("return JSON.stringify({ t: localStorage.getItem('lataif_client_token'), s: localStorage.getItem('lataif_session'), u: localStorage.getItem('lataif_client_server_url') });");
    const o = JSON.parse(ls);
    ok(o.t === null && o.s === null && !!o.u, `LOGOUT Ausweis und Sitzung weg, die Serveradresse bleibt (${ls})`);
    ok((await treffer(client)).length === 0, 'LOGOUT ohne einen Griff zur lokalen Datenbank');
  }
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
  try { console.log('      (Primary-Konsole) ' + (primary?.events || []).slice(-15).join('\n      (Primary-Konsole) ')); } catch { /* egal */ }
  try { console.log('      (PC2-Konsole) ' + (client?.events || []).slice(-15).join('\n      (PC2-Konsole) ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r6b: existing commands + safety, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6B_EXISTING_COMMAND_ENTRYPOINTS_WIRED');
console.log('CENTRAL_UI_R6B_INVENTORY_CLIENT_FAIL_CLOSED_PROVED');
console.log('CENTRAL_UI_R6B_IMPORT_CLIENT_FAIL_CLOSED_PROVED');
console.log('CENTRAL_UI_R6B_CLIENT_LOGOUT_PROVED');
console.log('CENTRAL_UI_R6B_UNSUPPORTED_DELETES_FAIL_CLOSED');
console.log('CENTRAL_UI_R6B_TWO_APP_RUNTIME_PROVED');
