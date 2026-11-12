// ════════════════════════════════════════════════════════════════════════════
// Owner 12.11.2026 — Ausgaben und „Pay Supplier" mit Zahlungstag (Bahrain-Tag), mehrere Zahlwege. Zwei-App-E2E (Primary + PC2),
// echte Maus/Tastatur — auch das Datum wird per Mausklick ins Feld und Ziffern über die Tastatur eingegeben.
// Run: node test/e2e/expense-pay-date-split.e2e.mjs
//
//   A  Primary: Ausgabenliste → „Record payment" ⇒ 300 Cash am 03.11. + „Add payment method" 200 Bank heute; zu viel gesperrt;
//      Datenbank, Hauptbuch (Tag je Zahlung) und Banking (eine Zeile je Zahlung, Konto = Zahlweg).
//   B  PC2: Reparatur (hybrid) → A/P-Chip ⇒ Tag vor der Werkstattkost schon in der Maske gesperrt; dann 150 Cash am 06.11.
//   C  PC2: Ausgabenliste → geteilt 100 Benefit am 04.11. + 300 Cash heute ⇒ EIN Fernauftrag mit payments; Banking am PC2.
//   D  PC2: „Pay Supplier" 320 (Ausgabe 120 + Einkauf 200) ⇒ 03.11. gesperrt (vor dem Einkauf), 05.11. gebucht: Zahlungen,
//      Hauptbuch, Lieferantensaldo, Lieferantenseite und Banking am 05.11.; EIN Fernauftrag mit paidDate.
//   E  PC2: Reparatur-Kostendatum — „Edit date" an der bezahlten Werkstattzeile: nach der Zahlung abgewiesen, davor
//      gebucht (Storno am alten, Neubuchung am neuen Tag, Zahlung unverändert); In-house-Zeile mit Kostendatum; Primary gleich.
//   F  PC2: „Pay Supplier" 150 auf 120 offen → 30 Vorauszahlung: Banking zeigt den vollen Geldabgang, je Zeile genau einmal.
//
// PROZESS-ISOLATION (Gerüst aus b23-purchase-offset.e2e.mjs): gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf
// gestartet hat oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt. Nur künstliche Testdaten.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { maus, tippe } from './_e2e-mouse.mjs';
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
const OWNER_PW = 'eps-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-eps-split', 'run-' + Date.now());
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
  if (!window.__b1Installiert) {
  window.__b1Installiert = true;
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
// Die Welt des Laufs (künstliche Testdaten):
//   Werkstatt „Eps Workshop"
//     A  Ausgabe Rent 500 (Tag 01.11., offen)         — Primary: geteilt 300 Cash am 03.11. + 200 Bank heute
//     B  Ausgabe Utilities 400 (Tag 02.11., offen)    — PC2: geteilt 100 Benefit am 04.11. + 300 Cash heute
//     R  Reparatur (hybrid) mit Werkstattzeile 150 (Ausgabe Tag 05.11., offen) — PC2 über den A/P-Chip, Tag 06.11.
//   Lieferant „Eps Metals" — PC2 „Pay Supplier" 320 am 05.11.
//   Lieferant „Eps Prepaid" — PC2 „Pay Supplier" 150 auf 120 offen → 30 Vorauszahlung (Banking: voller Abgang)
//     S  Ausgabe 120 (Tag 02.11.) + Einkauf PUR-2026-000975 über 200 (Tag 04.11.), beide offen
// „Heute" ist der Kalendertag in Bahrain (UTC+3) — wie in den Masken.
// ══════════════════════════════════════════════════════════════════════════════
const SUP = 'eps-sup', SUP2 = 'eps-sup2', SUP3 = 'eps-sup3';
const EXP_A = 'eps-exp-a', EXP_B = 'eps-exp-b', EXP_R = 'eps-exp-r', REP = 'eps-rep', EXP_S = 'eps-exp-s', PUR_S = 'eps-pur-s';
const NUM_A = 'EXP-2026-000971', NUM_B = 'EXP-2026-000972', NUM_R = 'EXP-2026-000973', NUM_S = 'EXP-2026-000975', PNUM_S = 'PUR-2026-000975';
const EXP_T = 'eps-exp-t', NUM_T = 'EXP-2026-000976';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'suppliers', { id: SUP, branch_id, name: 'Eps Workshop', active: 1, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: SUP2, branch_id, name: 'Eps Metals', active: 1, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: SUP3, branch_id, name: 'Eps Prepaid', active: 1, created_at: now, updated_at: now });
    let nr = 970000;
    const le = (id, acc, dir, amount, sup, mod, sid, date) => insert(db, 'ledger_entries', { id, branch_id, entry_no: ++nr, transaction_id: 'eps-tx-' + sid,
      occurred_at: `${date}T09:00:00.000Z`, recorded_at: now, account: acc, direction: dir, amount, currency: 'BHD', counterparty_type: 'SUPPLIER',
      counterparty_id: sup, source_module: mod, source_id: sid, created_by: 'e2e', created_at: now });
    const ausgabe = (id, num, category, amount, date, extra = {}, sup = SUP) => {
      insert(db, 'expenses', { id, branch_id, expense_number: num, category, amount, paid_amount: 0, payment_method: 'bank', expense_date: date,
        description: 'E2E ' + category, supplier_id: sup, status: 'PENDING', created_at: now, revision: 1, ...extra });
      le(`eps-le-${id}-d`, category === 'Inventory' ? 'INVENTORY' : 'EXPENSES_OPERATING', 'DEBIT', amount, sup, 'EXPENSE', id, date);
      le(`eps-le-${id}-c`, 'ACCOUNTS_PAYABLE', 'CREDIT', amount, sup, 'EXPENSE', id, date);
    };
    ausgabe(EXP_A, NUM_A, 'Rent', 500, '2026-11-01');
    ausgabe(EXP_B, NUM_B, 'Utilities', 400, '2026-11-02');
    let cat = (db.prepare('SELECT id FROM categories WHERE branch_id = ? LIMIT 1').get(branch_id) || {}).id;
    if (!cat) { cat = 'eps-cat'; insert(db, 'categories', { id: cat, branch_id, name: 'Watches', icon: 'w', color: '#000', created_at: now, updated_at: now }); }
    const artikel = (sfx, pur, purNum, sup, status, total, paid, date) => {
      insert(db, 'products', { id: 'eps-prod' + sfx, branch_id, category_id: cat, brand: 'Rolex', name: 'Datejust' + sfx, sku: 'EPS' + (sfx || '-1'), quantity: 1,
        condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: total, purchase_currency: 'BHD', stock_status: 'in_stock', tax_scheme: 'MARGIN',
        images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'purchases', { id: pur, branch_id, purchase_number: purNum, supplier_id: sup, status, total_amount: total,
        paid_amount: paid, remaining_amount: total - paid, purchase_date: date, created_at: now, updated_at: now });
      insert(db, 'purchase_lines', { id: 'eps-pl' + sfx, purchase_id: pur, product_id: 'eps-prod' + sfx, description: 'Datejust' + sfx, quantity: 1, unit_price: total,
        line_total: total, position: 0, tax_scheme: 'ZERO', vat_rate: 0, vat_amount: 0 });
      insert(db, 'stock_lots', { id: 'eps-lot' + sfx, branch_id, product_id: 'eps-prod' + sfx, purchase_id: pur, purchase_line_id: 'eps-pl' + sfx, qty_total: 1, qty_remaining: 1,
        unit_cost: total, status: 'ACTIVE', acquired_at: `${date}T09:00:00.000Z`, created_at: now });
    };
    artikel('', 'eps-pur', 'PUR-2026-000971', SUP, 'PAID', 1000, 1000, '2026-10-20');
    insert(db, 'customers', { id: 'eps-kunde', branch_id, first_name: 'Eva', last_name: 'Repair', phone: '+973 3300 0471', created_at: now, updated_at: now });
    insert(db, 'repairs', { id: REP, branch_id, repair_number: 'REP-2026-000971', customer_id: 'eps-kunde', product_id: 'eps-prod', lot_id: 'eps-lot', status: 'in_progress',
      repair_scope: 'OWN', repair_type: 'hybrid', workshop_supplier_id: SUP, issue_description: 'Service + polish', received_at: '2026-11-05T09:00:00.000Z',
      created_at: now, updated_at: now });
    ausgabe(EXP_R, NUM_R, 'Inventory', 150, '2026-11-05', { related_module: 'repair', related_entity_id: REP, description: 'Workshop' });
    insert(db, 'repair_lines', { id: 'eps-rl', branch_id, repair_id: REP, position: 1, supplier_id: SUP, work_type: 'service', description: 'Service',
      cost_amount: 150, expense_id: EXP_R, status: 'OPEN', created_at: now, updated_at: now });
    // Lieferant „Eps Metals": offene Ausgabe 120 (02.11.) und offener Einkauf 200 (04.11.).
    ausgabe(EXP_S, NUM_S, 'Miscellaneous', 120, '2026-11-02', {}, SUP2);
    // Lieferant „Eps Prepaid": nur eine offene Ausgabe 120 (kein Einkauf) — ein Überschuss wird Vorauszahlungs-Guthaben.
    insert(db, 'repairs', { id: 'eps-rep-t', branch_id, repair_number: 'REP-2026-000976', customer_id: 'eps-kunde', product_id: 'eps-prod', status: 'received',
      repair_scope: 'CUSTOMER', repair_type: 'external', workshop_supplier_id: SUP3, issue_description: 'Strap', received_at: '2026-11-03T09:00:00.000Z',
      created_at: now, updated_at: now });
    ausgabe(EXP_T, NUM_T, 'Miscellaneous', 120, '2026-11-03', { related_module: 'repair', related_entity_id: 'eps-rep-t', description: 'Workshop prepaid' }, SUP3);
    artikel('-s', PUR_S, PNUM_S, SUP2, 'UNPAID', 200, 0, '2026-11-04');
    le('eps-le-pur-s-d', 'INVENTORY', 'DEBIT', 200, SUP2, 'PURCHASE', PUR_S, '2026-11-04');
    le('eps-le-pur-s-c', 'ACCOUNTS_PAYABLE', 'CREDIT', 200, SUP2, 'PURCHASE', PUR_S, '2026-11-04');
  } finally { db.close(); }
}
/** Der heutige Kalendertag in Bahrain (wie die Masken vorbelegen und was gebucht wird). */
const HEUTE = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
/** Der Standardtag des Primary ohne Angabe (UTC) — nur ein ANDERER Tag reist im Auftrag. */
const UTC_HEUTE = () => new Date().toISOString().slice(0, 10);
const zahlungen = (ex) => dbQ(BIZ_DB, 'SELECT amount, method, substr(paid_at, 1, 10) AS tag FROM expense_payments WHERE expense_id = ? ORDER BY paid_at, amount DESC', [ex])
  .map((r) => `${Number(r.amount)} ${r.method} ${r.tag}`);
const kaufZahlungen = (pid) => dbQ(BIZ_DB, 'SELECT amount, method, substr(paid_at, 1, 10) AS tag FROM purchase_payments WHERE purchase_id = ? ORDER BY paid_at, amount DESC', [pid])
  .map((r) => `${Number(r.amount)} ${r.method} ${r.tag}`);
const geld = (ex) => dbQ(BIZ_DB, `SELECT le.account, le.amount, substr(le.occurred_at, 1, 10) AS tag FROM ledger_entries le JOIN expense_payments ep ON ep.id = le.source_id
  WHERE le.source_module = 'EXPENSE_PAYMENT' AND ep.expense_id = ? AND le.account != 'ACCOUNTS_PAYABLE' ORDER BY le.occurred_at, le.account`, [ex])
  .map((r) => `${r.account} ${Number(r.amount)} ${r.tag}`);
const kaufGeld = (pid) => dbQ(BIZ_DB, `SELECT le.account, le.amount, substr(le.occurred_at, 1, 10) AS tag FROM ledger_entries le JOIN purchase_payments pp ON pp.id = le.source_id
  WHERE le.source_module = 'PURCHASE_PAYMENT' AND pp.purchase_id = ? AND le.account != 'ACCOUNTS_PAYABLE' ORDER BY le.occurred_at, le.account`, [pid])
  .map((r) => `${r.account} ${Number(r.amount)} ${r.tag}`);
const apSaldo = (sup) => Math.round(1000 * Number(dbQ(BIZ_DB, `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0) AS s
  FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND counterparty_type = 'SUPPLIER' AND counterparty_id = ?`, [sup])[0]?.s || 0)) / 1000;
const ausgabeZeile = (ex) => dbQ(BIZ_DB, 'SELECT paid_amount, status FROM expenses WHERE id = ?', [ex])[0] || {};
async function dateiBis(pruefe, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await spuelen(primary).catch(() => null); if (pruefe()) return true; await sleep(700); }
  return false;
}
const text = (c, sel) => c.ev(`return (document.querySelector(${S(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim();`);
const wert = (c, sel) => c.ev(`return document.querySelector(${S(sel)})?.value ?? null;`);
const aktiv = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? getComputedStyle(e).borderColor : null;`);
const gesperrt = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)})?.disabled;`);
const zeile = (i, feld) => `[data-expense-pay-row="${i}"] [data-expense-pay-${feld}]`;
const methode = (i, m) => `[data-expense-pay-row="${i}"] [data-expense-pay-method="${m}"]`;
const bankZeilen = (c, num) => c.ev(`return JSON.stringify([...document.querySelectorAll('div')]
  .filter((d) => d.style.gridTemplateColumns === '100px 120px 80px 1fr 110px 40px' && (d.children[3]?.textContent || '').includes(${S(num)}))
  .map((d) => [d.children[0].textContent.trim(), d.children[2].textContent.replace(/[^A-Za-z]/g, ''), (d.children[4]?.textContent || '').replace(/[^0-9.]/g, '')]).sort());`)
  .then((x) => JSON.parse(x || '[]'));

/**
 * ECHTE Benutzereingabe ins Datumsfeld: Maus auf das erste Segment (links im Feld), dann Ziffern über die Tastatur in
 * der Reihenfolge, die das Feld zeigt (Gebietsschema der Oberfläche, z. B. TT/MM/JJJJ). Kein Setzen des Werts per Skript.
 */
async function datumTippen(c, sel, iso) {
  const p = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return null; if (e.disabled) return 'DISABLED'; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+8, y:r.top+r.height/2});`);
  if (!p || p === 'DISABLED') return 'NO-FELD:' + sel + (p ? ':DISABLED' : '');
  const ord = String(await c.ev("return new Intl.DateTimeFormat(navigator.language).formatToParts(new Date(2026, 10, 3)).filter((x) => ['day','month','year'].includes(x.type)).map((x) => x.type).join(',');"));
  const reihen = [ord];
  for (const alt of ['day,month,year', 'month,day,year', 'year,month,day']) if (!reihen.includes(alt)) reihen.push(alt);
  const [y, m, d] = iso.split('-');
  const teile = { day: d, month: m, year: y };
  let zuletzt = '';
  for (const reihe of reihen) {
    const { x, y: yy } = JSON.parse(p);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: yy });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: yy, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: yy, button: 'left', clickCount: 1 });
    await sleep(120);
    for (const t of reihe.split(',')) {
      for (const ch of teile[t]) {
        const vk = ch.charCodeAt(0);
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Digit' + ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Digit' + ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      }
    }
    await sleep(250);
    zuletzt = String(await c.ev(`return document.querySelector(${S(sel)})?.value ?? '';`));
    if (zuletzt === iso) return 'OK';
  }
  return `WERT:${zuletzt} (Reihenfolgen ${reihen.join(' | ')})`;
}

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
  // Ein Tag ohne eigene Angabe reist nur, wenn der Bahrain-Tag vom UTC-Tag des Primary abweicht (00:00–03:00 Ortszeit).
  const heuteImAuftrag = () => (HEUTE() === UTC_HEUTE() ? undefined : HEUTE());

  // ── A Primary: Ausgabenliste → „Record payment" ⇒ 300 Cash am 03.11. (Tastatur) + „Add payment method" ⇒ 200 Bank heute ──
  {
    await gehFrisch(primary, '/expenses');
    await waitFor(primary, `[data-expense-pay-open="${EXP_A}"]`, 45000);
    ok(await mausKlick(primary, `[data-expense-pay-open="${EXP_A}"]`) === 'OK', 'A Primary: Maus auf „Record payment" an Ausgabe A');
    await waitFor(primary, '[data-expense-pay-save]', 15000);
    ok(await wert(primary, zeile(0, 'amount')) === '500' && await wert(primary, zeile(0, 'date')) === HEUTE(),
      `A Vorbelegung: offener Betrag 500, Tag heute in Bahrain (${await wert(primary, zeile(0, 'amount'))} / ${await wert(primary, zeile(0, 'date'))})`);
    const minMax = await primary.ev(`const e=document.querySelector(${S(zeile(0, 'date'))}); return e ? e.min + '|' + e.max : '';`);
    ok(minMax === `2026-11-01|${HEUTE()}`, `A Datumsfeld: frühestens der Ausgabetag, spätestens heute in Bahrain (${minMax})`);
    ok(await tippe(primary, zeile(0, 'amount'), '300') === 'OK', 'A Tastatur: 300');
    const t0 = await datumTippen(primary, zeile(0, 'date'), '2026-11-03');
    ok(t0 === 'OK', `A Maus + Tastatur ins Datumsfeld: 03.11. (${t0})`);
    ok(await mausKlick(primary, methode(0, 'cash')) === 'OK', 'A Maus: Cash');
    ok(await mausKlick(primary, '[data-expense-pay-add]') === 'OK', 'A Maus auf „Add payment method"');
    await waitFor(primary, zeile(1, 'amount'), 10000);
    ok(await wert(primary, zeile(1, 'amount')) === '200' && await aktiv(primary, methode(1, 'bank')) !== await aktiv(primary, methode(1, 'cash')),
      `A zweite Zeile: Rest 200 vorbelegt, ein anderer Zahlweg (Bank) gewählt (${await wert(primary, zeile(1, 'amount'))})`);
    const summe = await text(primary, '[data-expense-pay-sum]');
    ok(/Total of 2 payments/.test(summe) && /500\.000/.test(summe), `A Summe beider Zahlungen 500 (${summe})`);
    ok(await tippe(primary, zeile(1, 'amount'), '250') === 'OK', 'A Tastatur: zu viel (250)');
    await warteBis(primary, "document.querySelector('[data-expense-pay-too-much]')", 5000);
    ok(await exists(primary, '[data-expense-pay-too-much]') && await gesperrt(primary, '[data-expense-pay-save]'), 'A mehr als offen: Hinweis, „Record Payment" gesperrt');
    ok(await tippe(primary, zeile(1, 'amount'), '200') === 'OK', 'A Tastatur: zurück auf 200');
    await warteBis(primary, "!document.querySelector('[data-expense-pay-too-much]')", 5000);
    await foto(primary, 'eps-a-primary-split');
    ok(await mausKlick(primary, '[data-expense-pay-save]') === 'OK', 'A Maus auf „Record Payment"');
    await dateiBis(() => zahlungen(EXP_A).length === 2);
    ok(S(zahlungen(EXP_A)) === S(['300 cash 2026-11-03', `200 bank ${HEUTE()}`]), `A Datenbank: zwei Zahlungen je Zahlweg und Tag (${S(zahlungen(EXP_A))})`);
    ok(S(geld(EXP_A)) === S(['CASH 300 2026-11-03', `BANK 200 ${HEUTE()}`]), `A Hauptbuch: Cash am 03.11., Bank heute (${S(geld(EXP_A))})`);
    const a = ausgabeZeile(EXP_A);
    ok(Number(a.paid_amount) === 500 && a.status === 'PAID', `A Ausgabe bezahlt (${S(a)})`);
    await warteBis(primary, "!document.querySelector('[data-expense-pay-save]')", 10000);
    await gehFrisch(primary, '/banking');
    await warteBis(primary, `document.body.innerText.includes(${S(NUM_A)})`, 20000);
    const bz = await bankZeilen(primary, NUM_A);
    ok(S(bz) === S([['2026-11-03', 'Cash', '300.000'], [HEUTE(), 'Bank', '200.000']].sort()), `A Banking: zwei Zeilen — Cash 300 am 03.11., Bank 200 heute (${S(bz)})`);
    await foto(primary, 'eps-a-primary-banking');
  }

  // ── B PC2: Reparatur (hybrid) → A/P-Chip ⇒ Tag vor der Werkstattkost schon in der Maske gesperrt; dann 150 Cash am 06.11. ─
  {
    await syncRuhe();
    client = await lade(client, `/repairs/${REP}`);
    await waitFor(client, `[data-repair-expense-pay="${EXP_R}"]`, 45000);
    ok(await mausKlick(client, `[data-repair-expense-pay="${EXP_R}"]`) === 'OK', 'B PC2: Maus auf den A/P-Chip der Werkstattzeile');
    await waitFor(client, '[data-expense-pay-save]', 15000);
    ok(await wert(client, zeile(0, 'amount')) === '150' && await wert(client, zeile(0, 'date')) === HEUTE(), 'B Vorbelegung 150, heute in Bahrain');
    ok(await mausKlick(client, methode(0, 'cash')) === 'OK', 'B Maus: Cash');
    const vor = (await kommandos(client)).filter((x) => x.op === 'expenses.record_payment').length;
    const t1 = await datumTippen(client, zeile(0, 'date'), '2026-11-04');
    ok(t1 === 'OK', `B Maus + Tastatur ins Datumsfeld: 04.11. (vor der Werkstattkost 05.11.) (${t1})`);
    await warteBis(client, "document.querySelector('[data-expense-pay-date-error]')", 5000);
    const hinweis = await text(client, '[data-expense-pay-date-error]');
    ok(/cannot be before the expense date \(2026-11-05\)/.test(hinweis) && await gesperrt(client, '[data-expense-pay-save]'),
      `B PC2 prüft schon in der Maske: Hinweis, „Record Payment" gesperrt (${hinweis})`);
    const t2 = await datumTippen(client, zeile(0, 'date'), '2026-11-06');
    ok(t2 === 'OK', `B Maus + Tastatur ins Datumsfeld: 06.11. (${t2})`);
    await warteBis(client, "!document.querySelector('[data-expense-pay-date-error]')", 5000);
    await foto(client, 'eps-b-pc2-repair-date');
    ok(await mausKlick(client, '[data-expense-pay-save]') === 'OK', 'B Maus auf „Record Payment"');
    await dateiBis(() => zahlungen(EXP_R).length === 1);
    ok(S(zahlungen(EXP_R)) === S(['150 cash 2026-11-06']) && S(geld(EXP_R)) === S(['CASH 150 2026-11-06']),
      `B Werkstatt bezahlt am gewählten Tag: Zahlung und Hauptbuch 06.11. (${S(zahlungen(EXP_R))} ${S(geld(EXP_R))})`);
    const r = ausgabeZeile(EXP_R);
    ok(Number(r.paid_amount) === 150 && r.status === 'PAID', `B Werkstattkost bezahlt (${S(r)})`);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'expenses.record_payment');
    const letzte = cmds.at(-1)?.payload || {};
    ok(cmds.length === vor + 1 && letzte.paidDate === '2026-11-06' && letzte.amount === 150 && letzte.method === 'cash' && letzte.payments === undefined && letzte.paidAt === undefined,
      `B PC2 schickt EINE Zahlung mit paidDate (kein paidAt, keine payments) (${S(letzte)})`);
    await warteBis(client, "!document.querySelector('[data-expense-pay-save]')", 10000);
    await warteBis(client, `!document.querySelector('[data-repair-expense-pay="${EXP_R}"]')`, 20000);
    await foto(client, 'eps-b-pc2-repair-paid');
  }

  // ── C PC2: Ausgabenliste → geteilt 100 Benefit am 04.11. (Tastatur) + 300 Cash heute — EIN Fernauftrag mit payments ──────
  {
    await syncRuhe();
    client = await lade(client, '/expenses');
    await waitFor(client, `[data-expense-pay-open="${EXP_B}"]`, 45000);
    ok(await mausKlick(client, `[data-expense-pay-open="${EXP_B}"]`) === 'OK', 'C PC2: Maus auf „Record payment" an Ausgabe B');
    await waitFor(client, '[data-expense-pay-save]', 15000);
    ok(await tippe(client, zeile(0, 'amount'), '100') === 'OK', 'C Tastatur: 100');
    ok(await mausKlick(client, methode(0, 'benefit')) === 'OK', 'C Maus: Benefit');
    const t3 = await datumTippen(client, zeile(0, 'date'), '2026-11-04');
    ok(t3 === 'OK', `C Maus + Tastatur ins Datumsfeld: 04.11. (${t3})`);
    ok(await mausKlick(client, '[data-expense-pay-add]') === 'OK', 'C Maus auf „Add payment method"');
    await waitFor(client, zeile(1, 'amount'), 10000);
    ok(await wert(client, zeile(1, 'amount')) === '300', `C zweite Zeile: Rest 300 vorbelegt (${await wert(client, zeile(1, 'amount'))})`);
    ok(await mausKlick(client, methode(1, 'cash')) === 'OK', 'C Maus: Cash in Zeile 2');
    await foto(client, 'eps-c-pc2-split');
    const vor = (await kommandos(client)).filter((x) => x.op === 'expenses.record_payment').length;
    ok(await mausKlick(client, '[data-expense-pay-save]') === 'OK', 'C Maus auf „Record Payment"');
    await dateiBis(() => zahlungen(EXP_B).length === 2);
    ok(S(zahlungen(EXP_B)) === S(['100 benefit 2026-11-04', `300 cash ${HEUTE()}`]) && S(geld(EXP_B)) === S(['BENEFIT 100 2026-11-04', `CASH 300 ${HEUTE()}`]),
      `C Datenbank und Hauptbuch: Benefit 100 am 04.11., Cash 300 heute (${S(zahlungen(EXP_B))} ${S(geld(EXP_B))})`);
    const b = ausgabeZeile(EXP_B);
    ok(Number(b.paid_amount) === 400 && b.status === 'PAID', `C Ausgabe bezahlt (${S(b)})`);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'expenses.record_payment');
    const p = cmds.at(-1)?.payload || {};
    ok(cmds.length === vor + 1 && Array.isArray(p.payments) && p.payments.length === 2 && p.amount === undefined && p.method === undefined
      && p.payments[0].paidDate === '2026-11-04' && p.payments[0].method === 'benefit' && p.payments[1].paidDate === heuteImAuftrag() && p.payments[1].method === 'cash',
      `C PC2 schickt EINEN Auftrag mit payments (Tag nur, wo nicht der Standardtag) (${S(p)})`);
    await warteBis(client, "!document.querySelector('[data-expense-pay-save]')", 10000);
    client = await lade(client, '/banking');
    await warteBis(client, `document.body.innerText.includes(${S(NUM_B)})`, 30000);
    const bz = await bankZeilen(client, NUM_B);
    ok(S(bz) === S([['2026-11-04', 'Benefit', '100.000'], [HEUTE(), 'Cash', '300.000']].sort()), `C Banking am PC2: Benefit 100 am 04.11., Cash 300 heute (${S(bz)})`);
    await foto(client, 'eps-c-pc2-banking');
  }

  // ── D PC2: Lieferant → „Pay Supplier" 320 Bank (FIFO: Ausgabe 120 + Einkauf 200); Tag per Tastatur: 03.11. gesperrt, 05.11. ──
  {
    await syncRuhe();
    const ap0 = apSaldo(SUP2);
    client = await lade(client, `/suppliers/${SUP2}`);
    await waitFor(client, '[data-supplier-pay-open]', 45000);
    ok(await mausKlick(client, '[data-supplier-pay-open]') === 'OK', 'D PC2: Maus auf „Pay Supplier"');
    await waitFor(client, '[data-supplier-pay-amount]', 15000);
    ok(await wert(client, '[data-supplier-pay-date]') === HEUTE(), `D Zahlungstag vorbelegt heute in Bahrain (${await wert(client, '[data-supplier-pay-date]')})`);
    ok(await tippe(client, '[data-supplier-pay-amount]', '320') === 'OK', 'D Tastatur: 320');
    ok(await mausKlick(client, '[data-supplier-pay-method="bank"]') === 'OK', 'D Maus: Bank');
    const t4 = await datumTippen(client, '[data-supplier-pay-date]', '2026-11-03');
    ok(t4 === 'OK', `D Maus + Tastatur ins Datumsfeld: 03.11. (${t4})`);
    await warteBis(client, "document.querySelector('[data-supplier-pay-date-error]')", 5000);
    const hinweis = await text(client, '[data-supplier-pay-date-error]');
    ok(hinweis.includes(PNUM_S) && hinweis.includes('2026-11-04') && await gesperrt(client, '[data-supplier-pay-save]'),
      `D vor dem getroffenen Einkauf: Hinweis mit Belegnummer, „Pay" gesperrt (${hinweis})`);
    const t5 = await datumTippen(client, '[data-supplier-pay-date]', '2026-11-05');
    ok(t5 === 'OK', `D Maus + Tastatur ins Datumsfeld: 05.11. (${t5})`);
    await warteBis(client, "!document.querySelector('[data-supplier-pay-date-error]')", 5000);
    await foto(client, 'eps-d-pc2-pay-supplier');
    const vor = (await kommandos(client)).filter((x) => x.op === 'suppliers.pay').length;
    ok(await mausKlick(client, '[data-supplier-pay-save]') === 'OK', 'D Maus auf „Pay 320.000 BHD"');
    await dateiBis(() => zahlungen(EXP_S).length === 1 && kaufZahlungen(PUR_S).length === 1);
    ok(S(zahlungen(EXP_S)) === S(['120 bank 2026-11-05']) && S(kaufZahlungen(PUR_S)) === S(['200 bank 2026-11-05']),
      `D Zahlungshistorie: Ausgabe 120 und Einkauf 200, beide am 05.11. (${S(zahlungen(EXP_S))} ${S(kaufZahlungen(PUR_S))})`);
    ok(S(geld(EXP_S)) === S(['BANK 120 2026-11-05']) && S(kaufGeld(PUR_S)) === S(['BANK 200 2026-11-05']),
      `D Hauptbuch am gewählten Tag (${S(geld(EXP_S))} ${S(kaufGeld(PUR_S))})`);
    ok(ap0 === 320 && apSaldo(SUP2) === 0, `D Lieferantensaldo (A/P) 320 → 0 (${ap0} → ${apSaldo(SUP2)})`);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'suppliers.pay');
    const p = cmds.at(-1)?.payload || {};
    ok(cmds.length === vor + 1 && p.paidDate === '2026-11-05' && p.paidAt === undefined && p.amount === 320 && p.method === 'bank',
      `D PC2 schickt EINEN Auftrag suppliers.pay mit paidDate (${S(p)})`);
    await warteBis(client, "!document.querySelector('[data-supplier-pay-save]')", 10000);
    await syncRuhe();
    client = await lade(client, `/suppliers/${SUP2}`);
    await warteBis(client, "/PAYMENTS \\(1\\)/.test(document.body.innerText)", 30000);
    const seite = String(await client.ev('return document.body.innerText;'));
    ok(new RegExp(`${PNUM_S}[\\s\\S]{0,40}05 Nov 2026`).test(seite), 'D Lieferantenseite: Zahlung zum Einkauf mit „05 Nov 2026"');
    await foto(client, 'eps-d-pc2-supplier-payments', '[data-supplier-pay-open]');
    client = await lade(client, '/banking');
    await warteBis(client, `document.body.innerText.includes(${S(PNUM_S)})`, 30000);
    const bzE = await bankZeilen(client, NUM_S), bzP = await bankZeilen(client, PNUM_S);
    ok(S(bzE) === S([['2026-11-05', 'Bank', '120.000']]) && S(bzP) === S([['2026-11-05', 'Bank', '200.000']]),
      `D Banking am PC2: beide Zahlungen am 05.11. (${S(bzE)} ${S(bzP)})`);
    await foto(client, 'eps-d-pc2-banking');
    ok(S(await treffer(client)) === '[]', 'D PC2 griff nie nach einer lokalen Datenbank');
  }

  // ── E PC2: Reparatur-Kostendatum — „Edit date" an der bezahlten Werkstattzeile (nach der Zahlung abgewiesen, davor
  //    gebucht), dann eine In-house-Zeile mit Kostendatum per Tastatur; der Primary zeigt dasselbe ────────────────────
  {
    await syncRuhe();
    const rlAnzeige = '[data-repair-line-cost-date-show="eps-rl"]';
    client = await lade(client, `/repairs/${REP}`);
    await waitFor(client, '[data-repair-line-cost-date-edit="eps-rl"]', 45000);
    const anzeige0 = await text(client, rlAnzeige);
    ok(/05 Nov 2026/.test(anzeige0), `E PC2: die Zeile zeigt ihr Kostendatum (Altbestand = Tag der Ausgabe) (${anzeige0})`);
    ok(await mausKlick(client, '[data-repair-line-cost-date-edit="eps-rl"]') === 'OK', 'E Maus auf „Edit date"');
    await waitFor(client, '[data-repair-cost-date-input]', 15000);
    const t6 = await datumTippen(client, '[data-repair-cost-date-input]', '2026-11-07');
    ok(t6 === 'OK', `E Maus + Tastatur ins Datumsfeld: 07.11. (${t6})`);
    ok(await tippe(client, '[data-repair-cost-date-reason]', 'workshop bill dated later') === 'OK', 'E Tastatur: Grund');
    const vor = (await kommandos(client)).filter((x) => x.op === 'repairs.update_line').length;
    ok(await mausKlick(client, '[data-repair-cost-date-save]') === 'OK', 'E Maus auf „Save cost date"');
    await warteBis(client, '/already paid on 2026-11-06/.test(document.body.innerText)', 20000);
    ok(/already paid on 2026-11-06/.test(String(await client.ev('return document.body.innerText;')))
      && String(dbQ(BIZ_DB, 'SELECT expense_date AS d FROM expenses WHERE id = ?', [EXP_R])[0]?.d) === '2026-11-05' && await exists(client, '[data-repair-cost-date-save]'),
      'E nach der Zahlung (06.11.): der Primary lehnt verständlich ab, nichts geändert, Dialog bleibt offen');
    const t7 = await datumTippen(client, '[data-repair-cost-date-input]', '2026-11-04');
    ok(t7 === 'OK', `E Maus + Tastatur ins Datumsfeld: 04.11. (${t7})`);
    ok(await tippe(client, '[data-repair-cost-date-reason]', 'workshop invoice is dated 04.11.') === 'OK', 'E Tastatur: Grund');
    await foto(client, 'eps-e-pc2-cost-date-dialog');
    ok(await mausKlick(client, '[data-repair-cost-date-save]') === 'OK', 'E Maus auf „Save cost date"');
    await dateiBis(() => String(dbQ(BIZ_DB, 'SELECT cost_date AS d FROM repair_lines WHERE id = ?', ['eps-rl'])[0]?.d) === '2026-11-04');
    const lebendR = dbQ(BIZ_DB, `SELECT e1.account, substr(e1.occurred_at, 1, 10) AS tag FROM ledger_entries e1 WHERE e1.source_module = 'EXPENSE' AND e1.source_id = ?
      AND e1.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) ORDER BY e1.account`, [EXP_R]).map((r) => `${r.account} ${r.tag}`);
    const storno = dbQ(BIZ_DB, "SELECT substr(occurred_at, 1, 10) AS tag FROM ledger_entries WHERE source_module = 'EXPENSE' AND source_id = ? AND reverses_entry_id IS NOT NULL", [EXP_R]).map((r) => r.tag);
    ok(String(dbQ(BIZ_DB, 'SELECT expense_date AS d FROM expenses WHERE id = ?', [EXP_R])[0]?.d) === '2026-11-04'
      && S(lebendR) === S(['ACCOUNTS_PAYABLE 2026-11-04', 'INVENTORY 2026-11-04']) && storno.length === 2 && storno.every((x) => x === '2026-11-05'),
      `E Ausgabe + Kostenbuchung am 04.11., Gegenbuchung am alten Tag 05.11. (${S(lebendR)} / ${S(storno)})`);
    ok(S(zahlungen(EXP_R)) === S(['150 cash 2026-11-06']) && S(geld(EXP_R)) === S(['CASH 150 2026-11-06']), 'E Zahlung und Zahlungstag unverändert (06.11.)');
    const cmds = (await kommandos(client)).filter((x) => x.op === 'repairs.update_line');
    const p = cmds.at(-1)?.payload || {};
    ok(cmds.length === vor + 2 && p.costDate === '2026-11-04' && /04\.11\./.test(String(p.reason)) && p.costAmount === undefined,
      `E PC2 schickt repairs.update_line mit costDate + reason (${S(p)})`);
    await warteBis(client, "!document.querySelector('[data-repair-cost-date-save]')", 10000);
    // In-house-Zeile mit Kostendatum (Vorgabe Annahmetag 05.11.), per Tastatur 06.11.
    ok(await mausKlick(client, '[data-repair-add-work]') === 'OK', 'E Maus auf „+ Add Work"');
    await waitFor(client, '[data-repair-line-cost-date]', 15000);
    ok(await wert(client, '[data-repair-line-cost-date]') === '2026-11-05', `E Vorgabe: Kostendatum = Annahmetag 05.11. (${await wert(client, '[data-repair-line-cost-date]')})`);
    ok(await tippe(client, '[data-repair-line-cost]', '25') === 'OK', 'E Tastatur: Kosten 25 (In-house)');
    const t8 = await datumTippen(client, '[data-repair-line-cost-date]', '2026-11-06');
    ok(t8 === 'OK', `E Maus + Tastatur ins Kostendatum: 06.11. (${t8})`);
    await foto(client, 'eps-e-pc2-add-work-cost-date');
    const vorA = (await kommandos(client)).filter((x) => x.op === 'repairs.add_line').length;
    ok(await mausKlick(client, '[data-add-repair-line]') === 'OK', 'E Maus auf „Add Line"');
    await dateiBis(() => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM repair_lines WHERE repair_id = ? AND cost_amount = 25', [REP])[0]?.n) === 1);
    const neu = dbQ(BIZ_DB, 'SELECT id, cost_date FROM repair_lines WHERE repair_id = ? AND cost_amount = 25', [REP])[0] || {};
    const eigen = dbQ(BIZ_DB, "SELECT account, substr(occurred_at, 1, 10) AS tag FROM ledger_entries WHERE source_module = 'REPAIR_OWN_WORK' AND source_id = ? ORDER BY account", [String(neu.id)])
      .map((r) => `${r.account} ${r.tag}`);
    ok(neu.cost_date === '2026-11-06' && S(eigen) === S(['EXPENSES_OPERATING 2026-11-06', 'INVENTORY 2026-11-06']),
      `E In-house 25: Zeile und Eigenleistung am 06.11. (${S(neu)} ${S(eigen)})`);
    const pa = (await kommandos(client)).filter((x) => x.op === 'repairs.add_line');
    ok(pa.length === vorA + 1 && pa.at(-1)?.payload?.costDate === '2026-11-06', `E PC2 schickt repairs.add_line mit costDate (${S(pa.at(-1)?.payload)})`);
    // Der Primary zeigt dieselben Kostendaten.
    await syncRuhe();
    await gehFrisch(primary, `/repairs/${REP}`);
    await warteBis(primary, `document.querySelector(${S(rlAnzeige)})`, 30000);
    const primAnzeige = await text(primary, rlAnzeige);
    const primNeu = await text(primary, `[data-repair-line-cost-date-show="${String(neu.id)}"]`);
    ok(/04 Nov 2026/.test(primAnzeige) && /06 Nov 2026/.test(primNeu), `E Primary zeigt dieselben Kostendaten (${primAnzeige} | ${primNeu})`);
    await foto(primary, 'eps-e-primary-repair-cost-dates', '[data-repair-add-work]');
    ok(S(await treffer(client)) === '[]', 'E PC2 griff nie nach einer lokalen Datenbank');
  }

  // ── F PC2: Banking nach „Pay Supplier" mit Überzahlung — 150 bezahlt, 120 offen → 30 Vorauszahlung als eigene Zeile ───
  {
    await syncRuhe();
    client = await lade(client, `/suppliers/${SUP3}`);
    await waitFor(client, '[data-supplier-pay-open]', 45000);
    ok(await mausKlick(client, '[data-supplier-pay-open]') === 'OK', 'F PC2: Maus auf „Pay Supplier"');
    await waitFor(client, '[data-supplier-pay-amount]', 15000);
    ok(await tippe(client, '[data-supplier-pay-amount]', '150') === 'OK', 'F Tastatur: 150 (offen sind 120)');
    ok(await mausKlick(client, '[data-supplier-pay-method="cash"]') === 'OK', 'F Maus: Cash');
    const vor = (await kommandos(client)).filter((x) => x.op === 'suppliers.pay').length;
    ok(await mausKlick(client, '[data-supplier-pay-save]') === 'OK', 'F Maus auf „Pay 150.000 BHD"');
    await waitFor(client, '[data-app-confirm]', 15000);
    const frage = await text(client, '[data-app-confirm]');
    ok(/30\.000 excess/.test(frage) && /supplier credit/.test(frage), `F App-Rückfrage nennt den Überschuss 30 als Lieferantenguthaben (${frage.slice(0, 120)})`);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'F Maus auf „OK" der Rückfrage');
    await dateiBis(() => zahlungen(EXP_T).length === 1);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'suppliers.pay');
    ok(cmds.length === vor + 1 && cmds.at(-1)?.payload?.confirmExcessAsCredit === true, `F EIN Auftrag mit bestätigtem Überschuss (${S(cmds.at(-1)?.payload)})`);
    const hb = Number(dbQ(BIZ_DB, "SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entries WHERE account = 'CASH' AND direction = 'CREDIT' AND counterparty_id = ?", [SUP3])[0]?.s || 0);
    ok(hb === 150, `F Hauptbuch: 150 Cash-Abgang beim Lieferanten (${hb})`);
    await warteBis(client, "!document.querySelector('[data-supplier-pay-save]')", 10000);
    client = await lade(client, '/banking');
    await warteBis(client, `document.body.innerText.includes(${S(NUM_T)})`, 30000);
    const bzE = await bankZeilen(client, NUM_T), bzV = await bankZeilen(client, 'Eps Prepaid');
    ok(S(bzE) === S([[HEUTE(), 'Cash', '120.000']]) && S(bzV) === S([[HEUTE(), 'Cash', '30.000']]),
      `F Banking am PC2: 120 Ausgabe + 30 Vorauszahlung = der volle Geldabgang 150, je genau einmal (${S(bzE)} ${S(bzV)})`);
    await foto(client, 'eps-f-pc2-banking-prepayment');
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
console.log(`\nexpense-pay-date-split e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('EXPENSE_PAY_DATE_SPLIT_E2E_PROVED');
process.exit(0);
