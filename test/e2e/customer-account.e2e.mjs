// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT A1 — Zwei-App-E2E: die Ansicht „Account" eines Kunden am Primary und am PC2 (nur lesen).
// Run: node test/e2e/customer-account.e2e.mjs
//
//   A  Primary: Kunde öffnen, „Account" mit der Maus ⇒ Saldo, beide Seiten, Gold getrennt, Hinweise, Kontoauszug.
//   B  PC2 (ohne eigene Datenbank): dieselbe Ansicht über `parties.account.get` ⇒ dieselben Zahlen und Belege.
//   C  PC2: „Show settled documents" mit der Maus aus/an ⇒ erledigte Belege aus-/eingeblendet, Saldo unverändert.
//   D  PC2: ein Beleg im Konto mit der Maus ⇒ die Rechnung öffnet sich.
//   E  Datenbank: Lesen hat nichts geändert (Belege, Zahlungen, Hauptbuch); Isolation.
//
// PROZESS-ISOLATION (Gerüst wie order-invoice-billing): gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf
// gestartet hat oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses, closeTestWindow, startedPids, clearTestClientPendingSaves } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
const OWNER_PW = 'ca-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-customer-account', 'run-' + Date.now());
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
}, 40 * 60 * 1000);

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
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
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
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
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

// Beobachter am PC2: Fernaufträge und jeder Griff nach einer lokalen Datenbank.
const BEOBACHTER = `
  if (!window.__caInstalliert) {
  window.__caInstalliert = true;
  window.__cmds = []; window.__dbHits = [];
  window.alert = () => {}; window.confirm = () => true;
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    if (/\\/api\\/command$/.test(url)) {
      try { const body = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: body.op, payload: body.payload }); } catch (e) { /* kein Rumpf */ }
    }
    return of(...a);
  };
  }
`;
const DIALOGE_PRIMARY = 'window.alert = () => {}; window.confirm = () => true; return 1;';

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
async function lade(c, route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(p, route) { await geh(p, '/tasks'); await sleep(700); await geh(p, route); await sleep(900); }
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);
let primary = null, client = null;

/** Der Primary spielt seine eigenen Änderungen als Echo wieder ein — vor jedem Vergleich zur Ruhe kommen lassen. */
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
      if (await warteBis(primary, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sync Now')", 8000)) await clickText(primary, 'Sync Now');
    }
    await sleep(700);
  }
  console.log('      (sync) der Echo-Lauf des Primary kam nicht zur Ruhe');
  return false;
}

/** Echte Maus über CDP: Element in die Mitte holen, Mitte anfahren, drücken, loslassen. */
async function mausKlick(c, sel) {
  const p = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return null; if (e.disabled) return 'DISABLED'; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2, y:r.top+r.height/2});`);
  if (!p || p === 'DISABLED') return 'NO-MAUS:' + sel + (p ? ':DISABLED' : '');
  const { x, y } = JSON.parse(p);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return 'OK';
}
async function foto(c, name, sel) {
  const dir = process.env.LATAIF_SHOTS || '';
  if (!dir) return;
  try {
    const fsx = await import('node:fs');
    fsx.mkdirSync(dir, { recursive: true });
    if (sel) { await c.ev(`document.querySelector(${S(sel)})?.scrollIntoView({ block: 'start' }); return 1;`); await sleep(250); }
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fsx.writeFileSync(join(dir, name + '.png'), Buffer.from(r.data, 'base64'));
  } catch (e) { console.log('  (Foto ' + name + ' nicht möglich: ' + String(e).slice(0, 80) + ')'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// Die Welt des Laufs: Ahmed Karimi mit allen Beziehungen (künstliche Testdaten)
//   schuldet uns: PINV 1.500 offen, PINV 500 (200 bezahlt) → 300, We Lent 300, Eröffnung 250 (gebunden)  = 2.350
//   wir schulden: Guthaben 100, We Borrowed 2.000−800 = 1.200, Einkauf der Rolle 800, Kommission 450,
//                 Anzahlung 200 (gebunden)                                                             = 2.750
//   Netto −400: LATAIF schuldet Ahmed.  Erledigt (nur Verlauf): Rechnung 300 voll bezahlt.
//   Nicht gezählt (Hinweise): Darlehen „Ahmed Karimi" ohne Kunde 250, Partner mit gleichem Telefon.  Gold 12,5 g.
// ══════════════════════════════════════════════════════════════════════════════
const K = 'ca-kunde';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'customers', { id: K, branch_id, first_name: 'Ahmed', last_name: 'Karimi', phone: '+973 3300 0001', created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'ca-andere', branch_id, first_name: 'Other', last_name: 'Client', phone: '+973 3900 0009', created_at: now, updated_at: now });
    const rechnung = (id, nr, status, gross, paid, issued, final) => insert(db, 'invoices', { id, branch_id, invoice_number: nr, customer_id: K, status, currency: 'BHD',
      net_amount: gross, vat_amount: 0, gross_amount: gross, paid_amount: paid, issued_at: issued, number_finalized_at: final ? issued : null, created_at: now, updated_at: now });
    rechnung('ca-inv-a', 'PINV-2026-000901', 'PARTIAL', 1500, 0, '2026-10-05T09:00:00.000Z', false);
    rechnung('ca-inv-b', 'PINV-2026-000902', 'PARTIAL', 500, 200, '2026-10-06T09:00:00.000Z', false);
    rechnung('ca-inv-c', 'INV-2026-000903', 'FINAL', 300, 300, '2026-10-07T09:00:00.000Z', true);
    insert(db, 'payments', { id: 'ca-pay-b', branch_id, invoice_id: 'ca-inv-b', amount: 200, method: 'cash', received_at: '2026-10-08T09:00:00.000Z', created_at: now });
    insert(db, 'payments', { id: 'ca-pay-c', branch_id, invoice_id: 'ca-inv-c', amount: 300, method: 'bank_transfer', received_at: '2026-10-09T09:00:00.000Z', created_at: now });
    insert(db, 'customer_credits', { id: 'ca-cc', branch_id, customer_id: K, source_type: 'overpayment', source_id: 'x', amount: 100, used_amount: 0, status: 'OPEN', created_at: '2026-10-01T09:00:00.000Z' });
    const darlehen = (id, dir, amount, customer, counterparty, nr) => insert(db, 'debts', { id, branch_id, loan_number: nr, direction: dir, counterparty, customer_id: customer,
      amount, source: 'cash', status: 'open', created_at: '2026-09-14T09:00:00.000Z', updated_at: now });
    darlehen('ca-borrow', 'we_borrow', 2000, K, 'Ahmed Karimi', 'LOA-2026-000903');
    insert(db, 'debt_payments', { id: 'ca-dp', debt_id: 'ca-borrow', amount: 800, source: 'cash', paid_at: '2026-10-02T09:00:00.000Z', created_at: now });
    darlehen('ca-lend', 'we_lend', 300, K, 'Ahmed Karimi', 'LOA-2026-000904');
    darlehen('ca-hint', 'we_borrow', 250, null, 'Ahmed Karimi', 'LOA-2026-000905');
    insert(db, 'suppliers', { id: 'ca-sup', branch_id, name: 'Ahmed Karimi', phone: '+97333000001', linked_customer_id: K, active: 1, created_at: now, updated_at: now });
    insert(db, 'purchases', { id: 'ca-pur', branch_id, purchase_number: 'PUR-2026-000931', supplier_id: 'ca-sup', status: 'UNPAID', total_amount: 800, paid_amount: 0,
      remaining_amount: 800, purchase_date: '2026-10-12', created_at: now, updated_at: now });
    insert(db, 'categories', { id: 'ca-cat', branch_id, name: 'CA Watch', icon: 'w', color: '#000', attributes: '[]', created_at: now, updated_at: now });
    insert(db, 'products', { id: 'ca-prod', branch_id, category_id: 'ca-cat', brand: 'CA', name: 'Tank', sku: 'CA-1', quantity: 0, condition: 'Pre-Owned', scope_of_delivery: '[]',
      purchase_price: 0, purchase_currency: 'BHD', planned_sale_price: 500, stock_status: 'sold', tax_scheme: 'MARGIN', days_in_stock: 0, images: '[]', attributes: '{}',
      source_type: 'CONSIGNMENT', created_at: now, updated_at: now });
    insert(db, 'consignments', { id: 'ca-con', branch_id, consignment_number: 'CON-2026-00931', consignor_id: K, product_id: 'ca-prod', agreed_price: 500, commission_rate: 10,
      payout_amount: 450, payout_paid_amount: 0, status: 'sold', agreement_date: '2026-10-15', created_at: now, updated_at: now });
    insert(db, 'orders', { id: 'ca-ord', branch_id, order_number: 'ORD-2026-00931', customer_id: K, requested_brand: 'Rolex', requested_model: 'Daytona', agreed_price: 1000,
      status: 'pending', type: 'normal', created_at: now, updated_at: now });
    insert(db, 'order_payments', { id: 'ca-op', order_id: 'ca-ord', amount: 200, paid_at: '2026-10-17T09:00:00.000Z', method: 'cash', created_at: now });
    insert(db, 'opening_balance_items', { id: 'ca-ob', branch_id, item_number: 'OB-2026-000931', party_type: 'CUSTOMER', party_id: K, kind: 'CUSTOMER_RECEIVABLE', scope: 'REMAINDER',
      amount: 250, cutoff_date: '2026-10-15', status: 'RECORDED', accounting: 'PENDING', action_id: 'ca-ob-action-0001', payload_hash: 'h', created_at: now });
    insert(db, 'customer_gold_credits', { id: 'ca-gold', branch_id, customer_id: K, weight_grams: 12.5, karat: '21K', fulfilled_grams: 0, status: 'OPEN', created_at: now, updated_at: now });
    insert(db, 'partners', { id: 'ca-partner', branch_id, name: 'Partner AK', phone: '+97333000001', share_percentage: 0, active: 1, created_at: now, updated_at: now });
    // A1.1 P3 — Guthaben bei seiner Lieferantenrolle, nur auf seine Einkäufe einlösbar (OPEN) → „schuldet uns", gebunden.
    insert(db, 'supplier_credits', { id: 'ca-sc', branch_id, supplier_id: 'ca-sup', amount: 70, used_amount: 0, status: 'OPEN', created_at: '2026-10-14T09:00:00.000Z' });
  } finally { db.close(); }
}

/** Was die Ansicht zeigt: Summen, Richtung, Belege (Schlüssel:offen), Kontoauszug, Hinweise, Gold. */
const ansicht = async (c) => JSON.parse(await c.ev(`const q=(s)=>document.querySelector(s); const d=(s,a)=>q(s)?.getAttribute(a);
  const rows=[...document.querySelectorAll('[data-statement-balance]')];
  return JSON.stringify({ path: location.pathname, owes: Number(d('[data-account-owes-us]','data-account-owes-us')), weOwe: Number(d('[data-account-we-owe]','data-account-we-owe')),
    net: Number(d('[data-account-net]','data-account-net')), dir: d('[data-account-net]','data-account-direction'), netFree: Number(d('[data-account-net-free]','data-account-net-free')),
    docs: [...document.querySelectorAll('[data-account-doc]')].map(e=>e.getAttribute('data-account-doc')+':'+e.getAttribute('data-doc-open')).sort(),
    lastBalance: rows.length ? Number(rows[rows.length-1].getAttribute('data-statement-balance')) : null, statementRows: rows.length,
    incomplete: !!q('[data-account-incomplete]'), debtHint: !!q('[data-hint-debt="ca-hint"]'), partner: d('[data-partner-block="ca-partner"]','data-partner-link'),
    gold: d('[data-gold-karat="21K"]','data-gold-grams'), bound: document.querySelectorAll('[data-doc-bound]').length,
    scBound: !!q('[data-account-doc="supcredit:ca-sc"] [data-doc-bound]'),
    netIncomplete: !!q('[data-account-net-incomplete]'), statusHead: (q('[data-statement-status-head]')?.textContent || '').trim(),
    charge: [...document.querySelectorAll('[data-statement-charge]')].reduce((t,e)=>t+Math.round(Number(e.getAttribute('data-statement-charge'))*1000),0)/1000,
    credit: [...document.querySelectorAll('[data-statement-credit]')].reduce((t,e)=>t+Math.round(Number(e.getAttribute('data-statement-credit'))*1000),0)/1000 });`));
const ERWARTET_DOCS = ['consignment:ca-con:450', 'credit:ca-cc:100', 'debt:ca-borrow:1200', 'debt:ca-lend:300', 'invoice:ca-inv-a:1500', 'invoice:ca-inv-b:300',
  'invoice:ca-inv-c:0', 'opening:ca-ob:250', 'order:ca-ord:200', 'purchase:ca-pur:800', 'supcredit:ca-sc:70'].sort();
const pruefeAnsicht = (v, wer) => {
  ok(v.owes === 2420 && v.weOwe === 2750 && v.net === -330 && v.dir === 'WE_OWE' && v.netFree === -450,
    `${wer} Saldo: Ahmed schuldet 2.420, wir schulden 2.750, Netto −330 (LATAIF schuldet), nur freie Beträge −450 (${S([v.owes, v.weOwe, v.net, v.dir, v.netFree])})`);
  ok(S(v.docs) === S(ERWARTET_DOCS), `${wer} Belege beider Seiten genau wie erwartet, die erledigte Rechnung mit 0 (${S(v.docs)})`);
  ok(v.lastBalance === -330 && v.statementRows === 14, `${wer} Kontoauszug: 14 Zeilen (Belege, Zahlungen, Rückzahlung), endet beim Netto −330 (${v.lastBalance}, ${v.statementRows} Zeilen)`);
  ok(v.incomplete && v.debtHint && v.partner === 'POSSIBLE' && v.gold === '12.5' && v.bound === 3,
    `${wer} Hinweise (Darlehen ohne Kunde, Partner gleiches Telefon) nicht gezählt; Gold 12,5 g getrennt; 3 gebundene Posten (${S([v.incomplete, v.debtHint, v.partner, v.gold, v.bound])})`);
  ok(v.scBound && v.netIncomplete && v.statusHead === 'Status today' && Math.round((v.charge - v.credit) * 1000) === Math.round(v.lastBalance * 1000),
    `${wer} A1.1: Lieferantenguthaben gebunden, Hinweis „unvollständig" am Netto, „Status today", Belastung − Gutschrift = Saldo (${S([v.scBound, v.netIncomplete, v.statusHead, v.charge, v.credit])})`);
};
/** Die Belege, Zahlungen und Buchungen — was ein Lesen nie ändern darf (ohne Fassungs-/Zeitspalten des Sync-Echos). */
const fingerabdruck = () => createHash('sha256').update(S([
  dbQ(BIZ_DB, 'SELECT id, status, gross_amount, paid_amount FROM invoices ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, invoice_id, amount, method FROM payments ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, amount, used_amount, status FROM customer_credits ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, amount, status, customer_id FROM debts ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, amount FROM debt_payments ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, total_amount, paid_amount, status FROM purchases ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, payout_amount, payout_paid_amount, status FROM consignments ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, amount FROM order_payments ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, amount, status FROM opening_balance_items ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, weight_grams, fulfilled_grams, status FROM customer_gold_credits ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT id, linked_customer_id FROM suppliers ORDER BY id'),
  dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM ledger_entries'),
])).digest('hex');

try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  clearTestClientPendingSaves();
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'CA Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'CA Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'CA Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
  const onboardingPid = startedPids().pop();
  primary.close(); primary = null;
  await closeTestWindow(onboardingPid, APP); await waitTestImageGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
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
  ok(true, 'CONNECT frischer PC2 ohne Datenbank, Anmeldung');
  await beobachterLegen();

  await syncRuhe();
  const VORHER = fingerabdruck();

  // ── A Primary: Kunde öffnen, „Account" mit der Maus ───────────────────────────────────────────────────────
  {
    await gehFrisch(primary, `/clients/${K}`);
    await waitFor(primary, '[data-open-customer-account]', 45000);
    ok(await mausKlick(primary, '[data-open-customer-account]') === 'OK', 'A Maus auf „Account" im Kunden');
    const da = await warteBis(primary, "document.querySelector('[data-account-net]')", 45000);
    const v = da ? await ansicht(primary) : {};
    ok(da && v.path === `/clients/${K}/account`, `A die Ansicht „Account" öffnet sich (${v.path})`);
    if (da) pruefeAnsicht(v, 'A Primary');
    await foto(primary, 'ca-a-primary-top', '[data-customer-account]');
    await foto(primary, 'ca-a-primary-statement', '[data-account-statement]');
  }

  // ── B PC2: dieselbe Ansicht vom Primary ────────────────────────────────────────────────────────────────────
  let pc2 = {};
  {
    client = await lade(client, `/clients/${K}`);
    await waitFor(client, '[data-open-customer-account]', 45000);
    ok(await mausKlick(client, '[data-open-customer-account]') === 'OK', 'B Maus auf „Account" am PC2');
    const da = await warteBis(client, "document.querySelector('[data-account-net]')", 45000);
    pc2 = da ? await ansicht(client) : {};
    if (da) pruefeAnsicht(pc2, 'B PC2');
    const prim = await ansicht(primary);
    ok(da && S({ ...pc2, path: '' }) === S({ ...prim, path: '' }), 'B PC2 zeigt genau dasselbe wie der Primary (Summen, Belege, Kontoauszug, Hinweise, Gold)');
    const cmds = await kommandos(client);
    // Der Rumpf einer Fernauskunft ist { op, commandId, payload: <Parameter> } (remote-read.ts).
    ok(cmds.some((x) => x.op === 'parties.account.get' && x.payload?.view === 'customer_account' && x.payload?.partyId === K),
      `B PC2 liest über parties.account.get (view customer_account) vom Primary (${S([...new Set(cmds.map((x) => x.op))])})`);
    await foto(client, 'ca-b-pc2-top', '[data-customer-account]');
  }

  // ── C PC2: erledigte Belege aus- und einblenden (Maus) ─────────────────────────────────────────────────────
  {
    ok(await mausKlick(client, '[data-account-show-settled]') === 'OK', 'C Maus auf „Show settled documents"');
    await warteBis(client, "!document.querySelector('[data-account-doc=\"invoice:ca-inv-c\"]')", 8000);
    const aus = await ansicht(client);
    ok(!aus.docs.includes('invoice:ca-inv-c:0') && aus.docs.length === ERWARTET_DOCS.length - 1 && aus.net === -330 && aus.lastBalance === -330,
      `C ausgeblendet: die bezahlte Rechnung fehlt, Saldo und letzter Kontostand bleiben −330 (${aus.docs.length} Belege)`);
    ok(await mausKlick(client, '[data-account-show-settled]') === 'OK', 'C noch einmal: wieder einblenden');
    await warteBis(client, "document.querySelector('[data-account-doc=\"invoice:ca-inv-c\"]')", 8000);
    const an = await ansicht(client);
    ok(S(an.docs) === S(ERWARTET_DOCS), 'C eingeblendet: alle Belege wieder da');
  }

  // ── D PC2: Beleg aus dem Konto öffnen (Maus) ───────────────────────────────────────────────────────────────
  {
    ok(await mausKlick(client, '[data-account-doc="invoice:ca-inv-a"] a') === 'OK', 'D Maus auf die Rechnung im Konto');
    const da = await warteBis(client, "location.pathname === '/invoices/ca-inv-a'", 20000);
    ok(da, `D die Rechnung PINV-2026-000901 öffnet sich (${await client.ev('return location.pathname;')})`);
  }

  // ── E Datenbank unverändert, Isolation ─────────────────────────────────────────────────────────────────────
  {
    await syncRuhe();
    ok(fingerabdruck() === VORHER, 'E Lesen am Primary und PC2 hat keinen Beleg, keine Zahlung und keine Buchung verändert');
    ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SAFETY PC2 hat keine eigene Geschäftsdatenbank angelegt');
    ok((await treffer(client)).length === 0, 'SAFETY PC2 hat nie eine lokale Datenbank angefragt');
    const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
    ok(S(fremdVorher) === S(fremdNachher), 'ISOLATION fremde LATAIF-Prozesse unberührt');
  }

  // ── F A2 — PC2: möglichen Partner mit diesem Kunden verknüpfen (Maus, App-Rückfrage) ─────────────────────────
  const ROHDATEN = () => S([
    dbQ(BIZ_DB, 'SELECT id, status, gross_amount, paid_amount FROM invoices ORDER BY id'), dbQ(BIZ_DB, 'SELECT id, amount FROM payments ORDER BY id'),
    dbQ(BIZ_DB, 'SELECT id, amount, used_amount, status FROM customer_credits ORDER BY id'), dbQ(BIZ_DB, 'SELECT id, amount FROM debt_payments ORDER BY id'),
    dbQ(BIZ_DB, 'SELECT id, total_amount, paid_amount, status FROM purchases ORDER BY id'), dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM ledger_entries'),
    dbQ(BIZ_DB, 'SELECT id, amount, status, counterparty, direction, source FROM debts ORDER BY id'), dbQ(BIZ_DB, 'SELECT id, name, phone, share_percentage, active FROM partners ORDER BY id'),
  ]);
  const ROH_VOR = ROHDATEN();
  // Der ausdrückliche Protokolleintrag der Verknüpfung (das allgemeine Änderungsprotokoll schreibt zusätzlich seine Zeile).
  const auditZahl = (typ, id) => zahl('SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = ? AND entity_id = ? AND field_name = ?',
    [typ, id, typ === 'partners' ? 'linked_customer_id' : 'customer_id']);
  {
    client = await lade(client, `/clients/${K}/account`);
    await waitFor(client, '[data-partner-link-here="ca-partner"]', 45000);
    ok(await mausKlick(client, '[data-partner-link-here="ca-partner"]') === 'OK', 'F Maus auf „Link to this client" (möglicher Partner)');
    const frage = await warteBis(client, "document.querySelector('[data-app-confirm]')", 10000);
    const text = frage ? await client.ev("return document.querySelector('[data-app-confirm-text]')?.textContent || '';") : '';
    ok(frage && /Link partner "Partner AK" to Ahmed Karimi/.test(text), `F App-Rückfrage vor dem Verknüpfen (${String(text).slice(0, 60)})`);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'F Maus auf „OK"');
    const da = await warteBis(client, "document.querySelector('[data-partner-block=\"ca-partner\"][data-partner-link=\"LINKED\"]')", 45000);
    const v = da ? await ansicht(client) : {};
    ok(da && v.net === -330 && !(await client.ev("return !!document.querySelector('[data-partner-link-here]');")),
      `F PC2: Partner jetzt verknüpft (ohne offene Beträge, Saldo bleibt −330), kein Hinweis mehr (${S([da, v.net])})`);
    await syncRuhe();
    ok(String(dbQ(BIZ_DB, 'SELECT linked_customer_id AS l FROM partners WHERE id = ?', ['ca-partner'])[0]?.l) === K && auditZahl('partners', 'ca-partner') === 1,
      'F Datenbank: partners.linked_customer_id gesetzt, ein Protokolleintrag');
    const cmds = await kommandos(client);
    ok(cmds.some((x) => x.op === 'partners.update' && x.payload?.linkedCustomerId === K && x.payload?.id === 'ca-partner'), 'F PC2 schrieb über partners.update (am Primary geprüft)');
    await foto(client, 'ca-f-pc2-partner-linked', '[data-partner-block="ca-partner"]');
  }

  // ── G A2 — Primary: Darlehen ohne Kunde diesem Kunden zuordnen (Maus, App-Rückfrage) ─────────────────────────
  {
    await gehFrisch(primary, `/clients/${K}/account`);
    await waitFor(primary, '[data-hint-debt-assign="ca-hint"]', 45000);
    // Am Primary ist die Rückfrage für diesen Lauf ersetzt (DIALOGE_PRIMARY: bestätigt sofort) — sie wird hier
    // mitgeschrieben, damit sichtbar bleibt, DASS und WAS gefragt wurde. Der echte App-Dialog ist in F am PC2 geklickt.
    await primary.ev('window.__fragen = []; window.confirm = (m) => { window.__fragen.push(String(m)); return true; }; return 1;');
    ok(await mausKlick(primary, '[data-hint-debt-assign="ca-hint"]') === 'OK', 'G Maus auf „Assign to this client" (LOA-2026-000905)');
    await warteBis(primary, '(window.__fragen || []).length > 0', 10000);
    const fragen = await primary.ev('return JSON.stringify(window.__fragen || []);').then((x) => JSON.parse(x));
    ok(fragen.length === 1 && /Assign loan LOA-2026-000905 .*to Ahmed Karimi/.test(fragen[0]), `G Rückfrage vor dem Zuordnen gestellt (${String(fragen[0] || '').slice(0, 70)})`);
    const da = await warteBis(primary, "document.querySelector('[data-account-doc=\"debt:ca-hint\"]')", 45000);
    const v = da ? await ansicht(primary) : {};
    ok(da && v.weOwe === 3000 && v.net === -580 && v.lastBalance === -580 && !v.incomplete && !v.netIncomplete,
      `G Primary: Darlehen gezählt (wir schulden 3.000, Netto −580), keine Hinweise mehr, Saldo vollständig (${S([v.weOwe, v.net, v.lastBalance, v.incomplete])})`);
    await spuelen(primary);
    const d = dbQ(BIZ_DB, 'SELECT customer_id, amount, status, counterparty FROM debts WHERE id = ?', ['ca-hint'])[0] || {};
    ok(d.customer_id === K && Number(d.amount) === 250 && d.counterparty === 'Ahmed Karimi' && auditZahl('debts', 'ca-hint') === 1,
      'G Datenbank: nur customer_id gesetzt (Betrag, Status, Freitext bleiben), ein Protokolleintrag');
    await foto(primary, 'ca-g-primary-after-links', '[data-customer-account]');
  }

  // ── H PC2 liest denselben Stand; nichts anderes geändert ─────────────────────────────────────────────────────
  {
    await syncRuhe();
    client = await lade(client, `/clients/${K}/account`);
    await waitFor(client, '[data-account-net]', 45000);
    // syncRuhe kann den Primary auf die Sync-Seite geführt haben — frisch zurück ins Konto.
    await gehFrisch(primary, `/clients/${K}/account`);
    await waitFor(primary, '[data-account-net]', 45000);
    const p = await ansicht(client), q = await ansicht(primary);
    const diff = Object.keys(p).filter((k) => k !== 'path' && S(p[k]) !== S(q[k])).map((k) => k + ':' + S(p[k]) + '|' + S(q[k]));
    ok(diff.length === 0 && p.net === -580, `H PC2 zeigt nach beiden Zuordnungen genau dasselbe wie der Primary (${S(diff).slice(0, 400)})`);
    ok(ROHDATEN() === ROH_VOR, 'H Belege, Zahlungen, Darlehensbeträge, Partner-Stammdaten und Buchungen unverändert — nur die beiden Verknüpfungen');
    ok((await treffer(client)).length === 0 && !existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SAFETY PC2 weiter ohne eigene Datenbank');
  }
} catch (e) {
  ok(false, 'ABBRUCH: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
} finally {
  clearTimeout(WACHHUND);
  try { client?.close(); } catch { /* zu */ }
  try { primary?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  aufraeumen();
}
console.log(`\ncustomer-account e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('CUSTOMER_ACCOUNT_E2E_PROVED');
process.exit(0);
