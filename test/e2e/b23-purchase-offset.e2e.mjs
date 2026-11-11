// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT B2/B3 — Zwei-App-E2E: Einkaufsverrechnung (normal + Kommission) gegen Rechnungen derselben Person, ohne Geld.
// Run: node test/e2e/b23-purchase-offset.e2e.mjs
//
//   A  Primary: Einkauf → „Settle Balance" (Maus) ⇒ nur dieser Einkauf vorgewählt, Kennzeichnung normal/Kommission,
//      namensgleicher Lieferant ohne Verknüpfung nie angeboten; EINE STL; Einkauf Paid, paid_amount bleibt Geld; AP Lieferant.
//   B  PC2 (ohne Datenbank): Rechnung → „Settle Balance" ⇒ nur diese Rechnung vorgewählt; Kommissions-Einkauf; Endnummer;
//      EIN Fernauftrag.
//   C  PC2: Einkauf zeigt die Verrechnungszeile, ohne Void/Edit date.
//   D  Primary: „Remove offset" auf der Rechnung ⇒ Einkauf wieder offen, Zeile storniert (nicht gelöscht).
//   E  PC2: ganze STL im Kundenkonto rückgängig.   F  Sicherheit.
//
// PROZESS-ISOLATION (Gerüst aus c-settle-balance.e2e.mjs): gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf
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
const OWNER_PW = 'b23-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-b23-offset', 'run-' + Date.now());
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
// Die Welt des Laufs (künstliche Testdaten): Kundin „Bea Offset" mit AUSDRÜCKLICH verknüpfter Lieferantenrolle.
//   Einkäufe: PN normal 300 · PC Kommission 200 (je mit Einkaufsbuchung AP beim Lieferanten)
//   Rechnungen: A 500 · B 150 (offen)   ·   ein Lieferant gleichen Namens OHNE Verknüpfung mit Einkauf 999 (nie angeboten)
// ══════════════════════════════════════════════════════════════════════════════
const K = 'b23-kunde';
const SUP = 'b23-sup', SUP_FREMD = 'b23-sup-fremd';
const PN = 'b23-pn', PC = 'b23-pc', PX = 'b23-px';
const INV_A = 'b23-inv-a', INV_B = 'b23-inv-b';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'customers', { id: K, branch_id, first_name: 'Bea', last_name: 'Offset', phone: '+973 3300 0401', created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: SUP, branch_id, name: 'Bea Offset', active: 1, linked_customer_id: K, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: SUP_FREMD, branch_id, name: 'Bea Offset', active: 1, created_at: now, updated_at: now });
    let nr = 990000;
    const einkauf = (id, num, sup, total, date, consignment) => {
      insert(db, 'purchases', { id, branch_id, purchase_number: num, supplier_id: sup, status: 'UNPAID', total_amount: total, paid_amount: 0,
        remaining_amount: total, purchase_date: date, created_at: now, updated_at: now, ...(consignment ? { source_consignment_id: 'b23-con' } : {}) });
      const tx = 'b23-tx-' + id;
      for (const [acc, dir] of [['INVENTORY', 'DEBIT'], ['ACCOUNTS_PAYABLE', 'CREDIT']]) {
        insert(db, 'ledger_entries', { id: `b23-le-${id}-${dir}`, branch_id, entry_no: ++nr, transaction_id: tx, occurred_at: `${date}T09:00:00.000Z`,
          recorded_at: now, account: acc, direction: dir, amount: total, currency: 'BHD', counterparty_type: 'SUPPLIER', counterparty_id: sup,
          source_module: 'PURCHASE', source_id: id, created_by: 'e2e', created_at: now });
      }
    };
    einkauf(PN, 'PUR-2026-000981', SUP, 300, '2026-10-10', false);
    einkauf(PC, 'PUR-2026-000982', SUP, 200, '2026-10-11', true);
    einkauf(PX, 'PUR-2026-000983', SUP_FREMD, 999, '2026-10-09', false);
    const rechnung = (id, num, gross, issued) => insert(db, 'invoices', { id, branch_id, invoice_number: num, customer_id: K, status: 'PARTIAL', currency: 'BHD',
      net_amount: gross, vat_amount: 0, gross_amount: gross, paid_amount: 0, issued_at: issued, created_at: now, updated_at: now });
    rechnung(INV_A, 'PINV-2026-000981', 500, '2026-10-20T09:00:00.000Z');
    rechnung(INV_B, 'PINV-2026-000982', 150, '2026-10-21T09:00:00.000Z');
    // v0.8.101 S4 — Kundin „Pia Partner" mit AUSDRÜCKLICH verknüpftem Partner: gemeinsamer Artikel 1000 (50 %), Partner hat
    // 600 eingezahlt bei 500 Kostenanteil → LATAIF schuldet ihm 100 (auszahlbar, keine Sperre). Rechnung 250 offen.
    insert(db, 'customers', { id: K_P, branch_id, first_name: 'Pia', last_name: 'Partner', phone: '+973 3300 0402', created_at: now, updated_at: now });
    insert(db, 'partners', { id: PARTNER_P, branch_id, name: 'Pia Partner', share_percentage: 0, active: 1, linked_customer_id: K_P, created_at: now, updated_at: now });
    let cat = (db.prepare('SELECT id FROM categories WHERE branch_id = ? LIMIT 1').get(branch_id) || {}).id;
    if (!cat) { cat = 'b23-cat'; insert(db, 'categories', { id: cat, branch_id, name: 'Watches', icon: 'w', color: '#000', created_at: now, updated_at: now }); }
    insert(db, 'products', { id: PROD_P, branch_id, category_id: cat, brand: 'Rolex', name: 'Joint piece', sku: 'B23-JP-1', quantity: 1,
      condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 1000, purchase_currency: 'BHD', stock_status: 'in_stock', tax_scheme: 'MARGIN',
      images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
    insert(db, 'purchases', { id: PUR_P, branch_id, purchase_number: 'PUR-2026-000985', supplier_id: SUP_FREMD, status: 'PAID', total_amount: 1000,
      paid_amount: 1000, remaining_amount: 0, purchase_date: '2026-10-05', created_at: now, updated_at: now });
    insert(db, 'purchase_lines', { id: PL_P, purchase_id: PUR_P, product_id: PROD_P, description: 'Joint piece', quantity: 1, unit_price: 1000, line_total: 1000,
      position: 0, tax_scheme: 'ZERO', vat_rate: 0, vat_amount: 0 });
    insert(db, 'stock_lots', { id: 'b23-lot-p', branch_id, product_id: PROD_P, purchase_id: PUR_P, purchase_line_id: PL_P, qty_total: 1, qty_remaining: 1,
      unit_cost: 1000, status: 'ACTIVE', acquired_at: '2026-10-05T09:00:00.000Z', created_at: now });
    for (const [party, partner_id] of [['HOUSE', null], ['PARTNER', PARTNER_P]]) {
      insert(db, 'item_participations', { id: `b23-ip-${party}`, branch_id, purchase_id: PUR_P, purchase_line_id: PL_P, product_id: PROD_P, party, partner_id,
        share_bp: 5000, cost_share: 500, line_total: 1000, quantity: 1, created_at: now, epoch_id: PL_P, from_il_rowid: 0, unit_cost: 1000 });
    }
    insert(db, 'item_partner_movements', { id: 'b23-ipm-c', branch_id, purchase_id: PUR_P, purchase_line_id: PL_P, partner_id: PARTNER_P, kind: 'CONTRIBUTION',
      amount: 600, method: 'cash', occurred_at: '2026-10-06', created_at: now });
    for (const [acc, dir, cpt, cp] of [['CASH', 'DEBIT', 'PARTNER', PARTNER_P], ['PARTNER_ITEM_BALANCE', 'CREDIT', 'PARTNER', PARTNER_P]]) {
      insert(db, 'ledger_entries', { id: `b23-le-ipm-${dir}`, branch_id, entry_no: ++nr, transaction_id: 'b23-tx-ipm', occurred_at: '2026-10-06T09:00:00.000Z',
        recorded_at: now, account: acc, direction: dir, amount: 600, currency: 'BHD', counterparty_type: cpt, counterparty_id: cp,
        source_module: 'PARTNER_ITEM', source_id: 'b23-ipm-c', created_by: 'e2e', created_at: now });
    }
    insert(db, 'invoices', { id: INV_P, branch_id, invoice_number: 'PINV-2026-000985', customer_id: K_P, status: 'PARTIAL', currency: 'BHD',
      net_amount: 250, vat_amount: 0, gross_amount: 250, paid_amount: 0, issued_at: '2026-10-22T09:00:00.000Z', created_at: now, updated_at: now });

    // v0.8.101 Abschlussprüfung — Kunde „Quinn Partner" mit verknüpftem Partner Q und verknüpfter Lieferantenrolle.
    //   Artikel I: gemeinsam 1000 (Q 40 %), Q hat 400 eingezahlt; EIGENE Reparatur in Arbeit, Werkstattzeile 100 (offen, gebucht).
    //   Artikel J: gemeinsam 1000 (Q 50 %), an Q zu viel ausgezahlt 150 → GEBUCHTE Rückforderung 150 (Kostenanteil 500 nur berechnet).
    //   Gegenposten: Store Credit 30, „We Borrowed" 80, offener Einkauf 50 — FIFO 30 + 80 + 40 = 150.
    insert(db, 'customers', { id: K_Q, branch_id, first_name: 'Quinn', last_name: 'Partner', phone: '+973 3300 0403', created_at: now, updated_at: now });
    insert(db, 'partners', { id: PARTNER_Q, branch_id, name: 'Quinn Partner', share_percentage: 0, active: 1, linked_customer_id: K_Q, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: SUP_Q, branch_id, name: 'Quinn Partner', active: 1, linked_customer_id: K_Q, created_at: now, updated_at: now });
    const le = (id, acc, dir, amount, cpt, cp, mod, sid, tx) => insert(db, 'ledger_entries', { id, branch_id, entry_no: ++nr, transaction_id: tx,
      occurred_at: '2026-10-07T09:00:00.000Z', recorded_at: now, account: acc, direction: dir, amount, currency: 'BHD', counterparty_type: cpt,
      counterparty_id: cp, source_module: mod, source_id: sid, created_by: 'e2e', created_at: now });
    const gemeinsam = (sfx, pct) => {
      const prod = 'b23-prod-' + sfx, pur = 'b23-pur-' + sfx, pl = 'b23-pl-' + sfx, lot = 'b23-lot-' + sfx;
      insert(db, 'products', { id: prod, branch_id, category_id: cat, brand: 'Rolex', name: 'Joint ' + sfx, sku: 'B23-J-' + sfx, quantity: 1, condition: 'Pre-Owned',
        scope_of_delivery: '[]', purchase_price: 1000, purchase_currency: 'BHD', stock_status: 'in_stock', tax_scheme: 'MARGIN', images: '[]', attributes: '{}',
        source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'purchases', { id: pur, branch_id, purchase_number: 'PUR-2026-00098' + (sfx === 'i' ? '6' : sfx === 'j' ? '7' : '9'), supplier_id: SUP_FREMD, status: 'PAID',
        total_amount: 1000, paid_amount: 1000, remaining_amount: 0, purchase_date: '2026-10-05', created_at: now, updated_at: now });
      insert(db, 'purchase_lines', { id: pl, purchase_id: pur, product_id: prod, description: 'Joint ' + sfx, quantity: 1, unit_price: 1000, line_total: 1000,
        position: 0, tax_scheme: 'ZERO', vat_rate: 0, vat_amount: 0 });
      insert(db, 'stock_lots', { id: lot, branch_id, product_id: prod, purchase_id: pur, purchase_line_id: pl, qty_total: 1, qty_remaining: 1,
        unit_cost: 1000, status: 'ACTIVE', acquired_at: '2026-10-05T09:00:00.000Z', created_at: now });
      for (const [party, partner_id, bp] of [['HOUSE', null, 10000 - pct * 100], ['PARTNER', PARTNER_Q, pct * 100]]) {
        insert(db, 'item_participations', { id: `b23-ip-${sfx}-${party}`, branch_id, purchase_id: pur, purchase_line_id: pl, product_id: prod, party, partner_id,
          share_bp: bp, cost_share: bp / 10, line_total: 1000, quantity: 1, created_at: now, epoch_id: pl, from_il_rowid: 0, unit_cost: 1000 });
      }
      return { prod, pur, pl, lot };
    };
    const I = gemeinsam('i', 40);
    insert(db, 'item_partner_movements', { id: 'b23-ipm-i-c', branch_id, purchase_id: I.pur, purchase_line_id: I.pl, partner_id: PARTNER_Q, kind: 'CONTRIBUTION',
      amount: 400, method: 'cash', occurred_at: '2026-10-06', created_at: now });
    le('b23-le-ipm-i-d', 'CASH', 'DEBIT', 400, 'PARTNER', PARTNER_Q, 'PARTNER_ITEM', 'b23-ipm-i-c', 'b23-tx-ipm-i');
    le('b23-le-ipm-i-c', 'PARTNER_ITEM_BALANCE', 'CREDIT', 400, 'PARTNER', PARTNER_Q, 'PARTNER_ITEM', 'b23-ipm-i-c', 'b23-tx-ipm-i');
    insert(db, 'repairs', { id: REP_I, branch_id, repair_number: 'REP-2026-000981', customer_id: K_Q, product_id: I.prod, lot_id: I.lot, status: 'in_progress',
      repair_scope: 'OWN', repair_type: 'external', workshop_supplier_id: SUP_FREMD, issue_description: 'Service', received_at: '2026-10-08T09:00:00.000Z',
      created_at: now, updated_at: now });
    insert(db, 'expenses', { id: EXP_I, branch_id, expense_number: 'EXP-2026-000981', category: 'Inventory', amount: 100, paid_amount: 0, payment_method: 'bank',
      expense_date: '2026-10-08', description: 'Workshop', related_module: 'repair', related_entity_id: REP_I, supplier_id: SUP_FREMD, status: 'PENDING',
      created_at: now, revision: 1 });
    insert(db, 'repair_lines', { id: 'b23-rl-i', branch_id, repair_id: REP_I, position: 1, supplier_id: SUP_FREMD, work_type: 'service', cost_amount: 100,
      expense_id: EXP_I, status: 'OPEN', created_at: now, updated_at: now });
    le('b23-le-exp-i-d', 'INVENTORY', 'DEBIT', 100, 'SUPPLIER', SUP_FREMD, 'EXPENSE', EXP_I, 'b23-tx-exp-i');
    le('b23-le-exp-i-c', 'ACCOUNTS_PAYABLE', 'CREDIT', 100, 'SUPPLIER', SUP_FREMD, 'EXPENSE', EXP_I, 'b23-tx-exp-i');
    const J = gemeinsam('j', 50);
    insert(db, 'item_partner_movements', { id: 'b23-ipm-j-p', branch_id, purchase_id: J.pur, purchase_line_id: J.pl, partner_id: PARTNER_Q, kind: 'PAYOUT',
      amount: 150, method: 'bank', occurred_at: '2026-10-06', created_at: now });
    le('b23-le-ipm-j-d', 'PARTNER_ITEM_BALANCE', 'DEBIT', 150, 'PARTNER', PARTNER_Q, 'PARTNER_ITEM', 'b23-ipm-j-p', 'b23-tx-ipm-j');
    le('b23-le-ipm-j-c', 'BANK', 'CREDIT', 150, 'PARTNER', PARTNER_Q, 'PARTNER_ITEM', 'b23-ipm-j-p', 'b23-tx-ipm-j');
    insert(db, 'customer_credits', { id: CC_Q, branch_id, customer_id: K_Q, amount: 30, used_amount: 0, status: 'OPEN', source_type: 'overpayment',
      source_id: 'b23-pay-q', created_at: '2026-10-09T09:00:00.000Z' });
    le('b23-le-cc-d', 'CASH', 'DEBIT', 30, 'CUSTOMER', K_Q, 'PAYMENT', 'b23-pay-q', 'b23-tx-cc');
    le('b23-le-cc-c', 'CUSTOMER_CREDIT', 'CREDIT', 30, 'CUSTOMER', K_Q, 'PAYMENT', 'b23-pay-q', 'b23-tx-cc');
    insert(db, 'debts', { id: DEBT_Q, branch_id, loan_number: 'LOAN-2026-000981', direction: 'we_borrow', customer_id: K_Q, counterparty: 'Quinn Partner',
      amount: 80, status: 'ACTIVE', source: 'cash', created_at: '2026-10-09T09:00:00.000Z', updated_at: now, revision: 1 });
    le('b23-le-debt-d', 'CASH', 'DEBIT', 80, 'CUSTOMER', K_Q, 'LOAN', DEBT_Q, 'b23-tx-debt');
    le('b23-le-debt-c', 'LOAN_PAYABLE', 'CREDIT', 80, 'CUSTOMER', K_Q, 'LOAN', DEBT_Q, 'b23-tx-debt');
    insert(db, 'purchases', { id: PUR_Q, branch_id, purchase_number: 'PUR-2026-000988', supplier_id: SUP_Q, status: 'UNPAID', total_amount: 50, paid_amount: 0,
      remaining_amount: 50, purchase_date: '2026-10-09', created_at: now, updated_at: now });
    le('b23-le-purq-d', 'INVENTORY', 'DEBIT', 50, 'SUPPLIER', SUP_Q, 'PURCHASE', PUR_Q, 'b23-tx-purq');
    le('b23-le-purq-c', 'ACCOUNTS_PAYABLE', 'CREDIT', 50, 'SUPPLIER', SUP_Q, 'PURCHASE', PUR_Q, 'b23-tx-purq');
    // v0.8.101 Lieferantenrückgabe mit Zusatzkosten — Artikel K: gemeinsam 1000 (Q 50 %), per Bank bezahlt; danach aktivierte
    // Zusatzkosten 100 (Polieren, gebucht und bezahlt) → Einstand 1100. Q hat 550 eingezahlt (500 Einkauf + 50 Zusatzkosten).
    const Kx = gemeinsam('k', 50);
    db.prepare('UPDATE stock_lots SET unit_cost = 1100 WHERE id = ?').run(Kx.lot);
    le('b23-le-pur-k-d', 'INVENTORY', 'DEBIT', 1000, 'SUPPLIER', SUP_FREMD, 'PURCHASE', Kx.pur, 'b23-tx-pur-k');
    le('b23-le-pur-k-c', 'BANK', 'CREDIT', 1000, 'SUPPLIER', SUP_FREMD, 'PURCHASE', Kx.pur, 'b23-tx-pur-k');
    le('b23-le-exp-k-d', 'INVENTORY', 'DEBIT', 100, 'SUPPLIER', SUP_FREMD, 'EXPENSE', 'b23-exp-k', 'b23-tx-exp-k');
    le('b23-le-exp-k-c', 'BANK', 'CREDIT', 100, 'SUPPLIER', SUP_FREMD, 'EXPENSE', 'b23-exp-k', 'b23-tx-exp-k');
    insert(db, 'item_partner_movements', { id: 'b23-ipm-k-c', branch_id, purchase_id: Kx.pur, purchase_line_id: Kx.pl, partner_id: PARTNER_Q, kind: 'CONTRIBUTION',
      amount: 550, method: 'cash', occurred_at: '2026-10-06', created_at: now });
    le('b23-le-ipm-k-d', 'CASH', 'DEBIT', 550, 'PARTNER', PARTNER_Q, 'PARTNER_ITEM', 'b23-ipm-k-c', 'b23-tx-ipm-k');
    le('b23-le-ipm-k-c', 'PARTNER_ITEM_BALANCE', 'CREDIT', 550, 'PARTNER', PARTNER_Q, 'PARTNER_ITEM', 'b23-ipm-k-c', 'b23-tx-ipm-k');
  } finally { db.close(); }
}
const K_P = 'b23-kunde-p', PARTNER_P = 'b23-partner-p', PROD_P = 'b23-prod-p', PUR_P = 'b23-pur-p', PL_P = 'b23-pl-p', INV_P = 'b23-inv-p';
const K_Q = 'b23-kunde-q', PARTNER_Q = 'b23-partner-q', SUP_Q = 'b23-sup-q', REP_I = 'b23-rep-i', EXP_I = 'b23-exp-i', CC_Q = 'b23-cc-q', DEBT_Q = 'b23-debt-q', PUR_Q = 'b23-pur-q';
const PL_I = 'b23-pl-i', PL_J = 'b23-pl-j', PL_K = 'b23-pl-k', PUR_K = 'b23-pur-k';
const einkaufZeile = (id) => dbQ(BIZ_DB, 'SELECT status, paid_amount, remaining_amount FROM purchases WHERE id = ?', [id])[0] || {};
const rechnung = (id) => dbQ(BIZ_DB, 'SELECT status, paid_amount, invoice_number, special_mark FROM invoices WHERE id = ?', [id])[0] || {};
async function dateiBis(pruefe, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await spuelen(primary).catch(() => null); if (pruefe()) return true; await sleep(700); }
  return false;
}
const geldBuchungen = () => zahl("SELECT COUNT(*) AS n FROM ledger_entries WHERE account IN ('CASH','BANK','BENEFIT','CARD_CLEARING')");
const apLieferant = () => Math.round(1000 * Number(dbQ(BIZ_DB, `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0) AS s
  FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND counterparty_type = 'SUPPLIER' AND counterparty_id = ?`, [SUP])[0]?.s || 0)) / 1000;
const unbeteiligt = () => createHash('sha256').update(S([
  dbQ(BIZ_DB, 'SELECT id, status, paid_amount, remaining_amount FROM purchases WHERE id = ?', [PX]),
  dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM purchase_payments WHERE purchase_id = ?', [PX]),
])).digest('hex');
const text = (c, sel) => c.ev(`return (document.querySelector(${S(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim();`);
const attrs = (c, sel, a) => c.ev(`return JSON.stringify([...document.querySelectorAll(${S(sel)})].map(e=>e.getAttribute(${S(a)})));`).then((x) => JSON.parse(x || '[]'));
const stlRows = (nr) => dbQ(BIZ_DB, 'SELECT offset_number, payable_type, payable_id, receivable_id, amount, status FROM party_offsets WHERE settlement_number = ? ORDER BY offset_number', [nr]);
const offsetZeilen = (pid) => dbQ(BIZ_DB, "SELECT id, amount, reference, voided_at FROM purchase_payments WHERE purchase_id = ? AND method = 'offset' ORDER BY created_at", [pid]);

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
  const UNB = unbeteiligt();
  const geld0 = geldBuchungen();
  const ap0 = apLieferant();
  const checkbox = (sel) => `${sel} input[type="checkbox"]`;

  // ── A Primary: Einkauf PN → „Settle Balance" ⇒ nur PN vorgewählt; IA←PN 300 ───────────────────────────────────────
  let stl1 = '';
  {
    await gehFrisch(primary, `/purchases/${PN}`);
    await waitFor(primary, '[data-purchase-settle-open]', 45000);
    ok(await mausKlick(primary, '[data-purchase-settle-open]') === 'OK', 'A Primary: Maus auf „Settle Balance" am Einkauf');
    await waitFor(primary, '[data-settle-balance]', 30000);
    const src = await attrs(primary, '[data-settle-source]', 'data-settle-source');
    const art = await attrs(primary, '[data-settle-source]', 'data-settle-source-purchase');
    const an = await attrs(primary, '[data-settle-source]', 'data-settle-on');
    ok(S(src) === S(['PUR-2026-000981', 'PUR-2026-000982']) && S(art) === S(['normal', 'consignment']),
      `A rechts nur die Einkäufe der verknüpften Rolle, normal/Kommission gekennzeichnet; der namensgleiche fehlt (${S(src)} ${S(art)})`);
    ok(S(an) === S(['1', '0']), `A vom Einkauf: nur dieser Einkauf vorgewählt (${S(an)})`);
    const inv = await attrs(primary, '[data-settle-invoice]', 'data-settle-invoice');
    ok(S(inv) === S(['PINV-2026-000981', 'PINV-2026-000982']), `A links die offenen Rechnungen der Kundin, älteste zuerst (${S(inv)})`);
    const paare = await attrs(primary, '[data-settle-pair]', 'data-settle-pair');
    ok(S(paare) === S(['PUR-2026-000981>PINV-2026-000981']) && (await attrs(primary, '[data-settle-total]', 'data-settle-total'))[0] === '300.000',
      `A Vorschlag: PN 300 → A (${S(paare)})`);
    const quelle = await text(primary, '[data-settle-source="PUR-2026-000981"]');
    ok(/Purchase/.test(quelle) && /purchase → Paid/.test(quelle), `A vorher/nachher am Einkauf: „→ Paid" (${quelle.slice(0, 160)})`);
    await foto(primary, 'b23-a-primary-dialog');
    ok(await mausKlick(primary, '[data-settle-confirm]') === 'OK', 'A Maus auf „Confirm settlement"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE payable_type = 'PURCHASE'") >= 1);
    stl1 = String(dbQ(BIZ_DB, "SELECT settlement_number FROM party_offsets WHERE payable_type = 'PURCHASE' ORDER BY created_at LIMIT 1")[0]?.settlement_number || '');
    const rows = stlRows(stl1);
    ok(/^STL-\d{4}-\d{6}$/.test(stl1) && rows.length === 1 && rows[0].payable_type === 'PURCHASE' && rows[0].payable_id === PN && Number(rows[0].amount) === 300,
      `A Datenbank: EINE STL ${stl1}, Zuordnung PURCHASE PN 300 (${S(rows)})`);
    const pn = einkaufZeile(PN), ra = rechnung(INV_A);
    ok(pn.status === 'PAID' && Number(pn.paid_amount) === 0 && Number(pn.remaining_amount) === 0, `A PN: Paid, paid_amount bleibt Geld (0), Rest 0 (${S(pn)})`);
    ok(ra.status === 'PARTIAL' && Number(ra.paid_amount) === 300, `A Rechnung A: 300 verrechnet, 200 offen (${S(ra)})`);
    ok(geldBuchungen() === geld0 && Math.abs(ap0 - apLieferant() - 300) < 0.0005, `A keine Geldbuchung; AP beim Lieferanten −300 (${ap0} → ${apLieferant()})`);
    const zeile = offsetZeilen(PN);
    ok(zeile.length === 1 && zeile[0].reference === `${stl1}/1` && !zeile[0].voided_at, 'A Zeile am Einkauf: offset mit der Verrechnungsnummer');
  }

  // ── B PC2: Rechnung B → „Settle Balance" ⇒ nur B vorgewählt; B←PC 150 (voll bezahlt, Endnummer); EIN Fernauftrag ────
  let stl2 = '';
  {
    await syncRuhe();
    client = await lade(client, `/invoices/${INV_B}`);
    await waitFor(client, '[data-settle-balance]', 45000);
    ok(await mausKlick(client, 'button[data-settle-balance]') === 'OK', 'B PC2: Maus auf „Settle Balance" auf der Rechnung');
    await waitFor(client, 'div[data-settle-balance]', 30000);
    const an = await attrs(client, '[data-settle-invoice]', 'data-settle-on');
    const inv = await attrs(client, '[data-settle-invoice]', 'data-settle-invoice');
    ok(S(inv) === S(['PINV-2026-000981', 'PINV-2026-000982']) && S(an) === S(['0', '1']), `B von der Rechnung: nur sie vorgewählt (${S(inv)} ${S(an)})`);
    const src = await attrs(client, '[data-settle-source]', 'data-settle-source');
    ok(S(src) === S(['PUR-2026-000982']) && S(await attrs(client, '[data-settle-source]', 'data-settle-source-purchase')) === S(['consignment']),
      `B rechts nur noch der offene Kommissions-Einkauf (PN ist beglichen) (${S(src)})`);
    const paare = await attrs(client, '[data-settle-pair]', 'data-settle-pair');
    ok(S(paare) === S(['PUR-2026-000982>PINV-2026-000982']) && (await attrs(client, '[data-settle-total]', 'data-settle-total'))[0] === '150.000', `B Vorschlag PC 150 → B (${S(paare)})`);
    await foto(client, 'b23-b-pc2-dialog');
    ok(await mausKlick(client, '[data-settle-confirm]') === 'OK', 'B Maus auf „Confirm settlement"');
    await waitFor(client, '[data-settle-numbers]', 15000);
    ok(await mausKlick(client, '[data-settle-number-for="PINV-2026-000982"] [data-settle-number-choice="normal"]') === 'OK', 'B Maus: Normal Final');
    ok(await mausKlick(client, '[data-settle-numbers-confirm]') === 'OK', 'B Maus auf „Confirm settlement" (Endnummer)');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE payable_type = 'PURCHASE'") >= 2);
    stl2 = String(dbQ(BIZ_DB, "SELECT settlement_number FROM party_offsets WHERE payable_type = 'PURCHASE' AND payable_id = ? LIMIT 1", [PC])[0]?.settlement_number || '');
    const pc = einkaufZeile(PC), rb = rechnung(INV_B);
    ok(stl2 && stl2 !== stl1 && pc.status === 'PARTIALLY_PAID' && Number(pc.remaining_amount) === 50 && Number(pc.paid_amount) === 0,
      `B PC: teilbeglichen, Rest 50, paid_amount 0 (${stl2} ${S(pc)})`);
    ok(rb.status === 'FINAL' && !String(rb.invoice_number).startsWith('PINV') && Number(rb.special_mark || 0) === 0, `B Rechnung B voll bezahlt mit Endnummer ${rb.invoice_number}`);
    ok((await kommandos(client)).filter((x) => x.op === 'customers.settle_balance').length === 1, 'B PC2 schickt EINEN Auftrag customers.settle_balance');
    ok(geldBuchungen() === geld0 && Math.abs(ap0 - apLieferant() - 450) < 0.0005, `B keine Geldbuchung; AP beim Lieferanten insgesamt −450 (${apLieferant()})`);
  }

  // ── C PC2: der Kommissions-Einkauf zeigt die Verrechnungszeile — kein Void dafür ─────────────────────────────────
  {
    client = await lade(client, `/purchases/${PC}`);
    const sel = `[data-purchase-payment-offset="${stl2}/1"]`;
    const da = await warteBis(client, `document.querySelector(${S(sel)})`, 45000);
    const zeile = da ? await text(client, sel) : '';
    ok(da && /OFFSET/.test(zeile) && /no cash/.test(zeile), `C PC2: Einkauf zeigt „OFFSET ${stl2}/1 · no cash" (${zeile})`);
    const offId = offsetZeilen(PC)[0]?.id;
    ok(!!offId && !(await exists(client, `[data-purchase-payment-void="${offId}"]`)) && !(await exists(client, `[data-purchase-payment-date="${offId}"]`)),
      'C keine „Void"/„Edit date" für die Verrechnungszeile (nur über Rechnung bzw. Konto aufhebbar)');
    ok(await exists(client, '[data-purchase-settle-open]'), 'C der Rest 50 ist weiter verrechenbar („Settle Balance" am Einkauf)');
    await foto(client, 'b23-c-pc2-purchase');
  }

  // ── D Primary: Rechnung A → „Remove offset" ⇒ PN wieder offen, Zeile storniert (nicht gelöscht) ──────────────────────
  {
    await syncRuhe();
    await gehFrisch(primary, `/invoices/${INV_A}`);
    await warteBis(primary, `document.querySelector('[data-invoice-offset="${stl1}/1"] [data-invoice-offset-remove]')`, 45000);
    const z = await text(primary, `[data-invoice-offset="${stl1}/1"]`);
    ok(z.includes('PUR-2026-000981') && /purchase/.test(z), `D Rechnung A nennt den Gegenbeleg „purchase PUR-…" (${z.slice(0, 160)})`);
    ok(await mausKlick(primary, `[data-invoice-offset="${stl1}/1"] [data-invoice-offset-remove]`) === 'OK', 'D Maus auf „Remove offset"');
    await dateiBis(() => (stlRows(stl1)[0] || {}).status === 'REVERSED');
    const pn = einkaufZeile(PN), ra = rechnung(INV_A), zeile = offsetZeilen(PN);
    ok(pn.status === 'UNPAID' && Number(pn.remaining_amount) === 300 && ra.status === 'PARTIAL' && Number(ra.paid_amount) === 0,
      `D PN wieder offen 300, Rechnung A wieder offen (${S(pn)} ${S(ra)})`);
    ok(zeile.length === 1 && !!zeile[0].voided_at, 'D die Zeile am Einkauf ist storniert (voided_at), nicht gelöscht');
    ok(geldBuchungen() === geld0, 'D keine Geldbuchung');
  }

  // ── E PC2: Kundenkonto → ganze zweite STL rückgängig (App-Dialog) ─────────────────────────────────────────────────
  {
    await syncRuhe();
    client = await lade(client, `/clients/${K}/account`);
    await waitFor(client, `[data-settlement-undo="${stl2}"]`, 45000);
    // S0 (v0.8.101): eine Einkaufsverrechnung steht als „Purchase <Nummer>" mit Link auf den Einkauf — nie als „We Borrowed".
    const quellen = await client.ev(`return [...document.querySelectorAll('[data-settlement-line]')].map((tr) => (tr.children[1]?.textContent || '').replace(/\\s+/g, ' ').trim());`);
    const links = await client.ev(`return [...document.querySelectorAll('[data-settlement-line-source="PURCHASE"]')].map((a) => a.getAttribute('href'));`);
    ok(quellen.length > 0 && quellen.every((q) => /^Purchase \S+/.test(q)) && !quellen.some((q) => /We Borrowed/.test(q))
      && links.length === quellen.length && links.every((h) => /\/purchases\/./.test(String(h))),
      `E S0: Verrechnungsliste zeigt „Purchase …" mit Link auf den Einkauf (${S(quellen)} ${S(links)})`);
    ok(await mausKlick(client, `[data-settlement-undo="${stl2}"]`) === 'OK', `E PC2: Maus auf „Undo settlement" (${stl2})`);
    await waitFor(client, '[data-app-confirm]', 15000);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'E Maus auf „OK"');
    await dateiBis(() => stlRows(stl2).every((r) => r.status === 'REVERSED'));
    const pc = einkaufZeile(PC), rb = rechnung(INV_B);
    ok(pc.status === 'UNPAID' && Number(pc.remaining_amount) === 200 && rb.status === 'PARTIAL' && Number(rb.paid_amount) === 0,
      `E PC wieder ganz offen, Rechnung B wieder offen (Endnummer bleibt ${rb.invoice_number}) (${S(pc)})`);
    ok((await kommandos(client)).filter((x) => x.op === 'customers.settlement_reverse').length === 1, 'E PC2 schickt EINEN Auftrag customers.settlement_reverse');
    await foto(client, 'b23-e-pc2-undone', '[data-settlements]');
  }

  // ── F Sicherheit ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    ok(unbeteiligt() === UNB, 'F der namensgleiche, nicht verknüpfte Lieferant: Einkauf unberührt');
    ok(geldBuchungen() === geld0 && Math.abs(apLieferant() - ap0) < 0.0005, 'F während des ganzen Laufs keine Geldbuchung; AP beim Lieferanten wieder wie vorher');
    ok(zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE status = 'ACTIVE'") === 0 && zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE status = 'REVERSED'") === 2,
      'F beide Zuordnungen stehen als REVERSED (nie gelöscht)');
    ok(zahl("SELECT COUNT(*) AS n FROM purchase_payments WHERE method = 'offset' AND voided_at IS NOT NULL") === 2
      && zahl("SELECT COUNT(*) AS n FROM purchase_payments WHERE method = 'offset' AND voided_at IS NULL") === 0, 'F beide Einkaufszeilen storniert, keine wirksame mehr');
    ok((await treffer(client)).length === 0 && !existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SAFETY PC2 ohne eigene Datenbank');
  }

  // ── G PC2 (Nachbesserung 10.11.): Einkauf PC → „Settle Balance" ⇒ NUR PC vorgewählt; „Change amount" mit echter Maus und
  //    Tastatur: über der Obergrenze abgewiesen, Teilbetrag 120.500 (Rest geht per FIFO an Rechnung B), B auf 0 ⇒ EINE
  //    Zuordnung 120.500, PC teilweise verrechnet (Rest 79.500). Ein Fernauftrag mit den Beträgen.
  {
    await syncRuhe();
    const vorKommandos = (await kommandos(client)).filter((x) => x.op === 'customers.settle_balance').length;
    client = await lade(client, `/purchases/${PC}`);
    await waitFor(client, '[data-purchase-settle-open]', 45000);
    ok(await maus(client, '[data-purchase-settle-open]') === 'OK', 'G PC2: Maus auf „Settle Balance" am Kommissions-Einkauf');
    await waitFor(client, 'div[data-settle-balance]', 30000);
    const src = await attrs(client, '[data-settle-source]', 'data-settle-source');
    const an = await attrs(client, '[data-settle-source]', 'data-settle-on');
    ok(S(src) === S(['PUR-2026-000981', 'PUR-2026-000982']) && S(an) === S(['0', '1']),
      `G vom Einkauf: genau dieser Einkauf vorgewählt, der andere offene Einkauf NICHT (${S(src)} ${S(an)})`);
    ok(S(await attrs(client, '[data-settle-invoice]', 'data-settle-on')) === S(['1', '1']), 'G Rechnungen: beide angeboten und gewählt (älteste zuerst)');
    const zeileA = '[data-settle-pair="PUR-2026-000982>PINV-2026-000981"]';
    // Rechnung B trägt seit Schritt B ihre Endnummer (bleibt nach dem Aufheben) — die Zeile wird über diese Nummer gefunden.
    const nrB = String(await client.ev(`return [...document.querySelectorAll('[data-settle-invoice]')].map(e=>e.getAttribute('data-settle-invoice'))[1] || '';`));
    const zeileB = `[data-settle-pair="PUR-2026-000982>${nrB}"]`;
    ok(!!nrB && nrB !== 'PINV-2026-000982', `G Rechnung B steht mit ihrer Endnummer da (${nrB})`);
    ok((await attrs(client, zeileA, 'data-settle-pair-amount'))[0] === '200.000' && (await attrs(client, zeileA, 'data-settle-pair-max'))[0] === '200.000',
      'G Vorschlag: PC 200 → A (Obergrenze 200)');
    ok(await maus(client, `${zeileA} [data-settle-amount-edit]`) === 'OK', 'G Maus auf „Change amount" (PC → A)');
    await waitFor(client, `${zeileA} [data-settle-amount-input]`, 10000);
    ok(await tippe(client, `${zeileA} [data-settle-amount-input]`, '250') === 'OK', 'G Tastatur: 250 (über der Obergrenze)');
    await warteBis(client, `document.querySelector('${zeileA} [data-settle-amount-error]')`, 5000);
    const fehler = await text(client, `${zeileA} [data-settle-amount-error]`);
    ok(/At most 200\.000/.test(fehler) && await client.ev("return document.querySelector('[data-settle-confirm]').disabled === true;"),
      `G über der Obergrenze: Hinweis „At most 200.000", „Confirm" gesperrt (${fehler})`);
    ok(await tippe(client, `${zeileA} [data-settle-amount-input]`, '120.5') === 'OK', 'G Tastatur: 120.5');
    await warteBis(client, `document.querySelector('${zeileB}')`, 5000);
    ok((await attrs(client, zeileA, 'data-settle-pair-amount'))[0] === '120.500' && (await attrs(client, zeileB, 'data-settle-pair-amount'))[0] === '79.500'
      && (await attrs(client, '[data-settle-total]', 'data-settle-total'))[0] === '200.000',
      'G sofort neu gerechnet: A 120.500, der Rest 79.500 geht per FIFO an B, Summe 200.000');
    ok(await maus(client, `${zeileA} [data-settle-amount-done]`) === 'OK', 'G Maus auf „Done"');
    ok(await maus(client, `${zeileB} [data-settle-amount-edit]`) === 'OK', 'G Maus auf „Change amount" (PC → B)');
    await waitFor(client, `${zeileB} [data-settle-amount-input]`, 10000);
    ok(await tippe(client, `${zeileB} [data-settle-amount-input]`, '0') === 'OK', 'G Tastatur: 0 (B bleibt aus)');
    await warteBis(client, `document.querySelector('[data-settle-pairs="1"]')`, 5000);
    ok(await maus(client, `${zeileB} [data-settle-amount-done]`) === 'OK', 'G Maus auf „Done"');
    const quelle = await text(client, '[data-settle-source="PUR-2026-000982"]');
    ok((await attrs(client, '[data-settle-total]', 'data-settle-total'))[0] === '120.500' && /open after 79\.500/.test(quelle) && /purchase → Partially paid/.test(quelle),
      `G Vorschau: Summe 120.500, Einkauf danach 79.500 offen, „→ Partially paid" (${quelle.slice(0, 160)})`);
    await foto(client, 'b23-g-pc2-change-amount');
    ok(await maus(client, '[data-settle-confirm]') === 'OK', 'G Maus auf „Confirm settlement"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE payable_id = 'b23-pc' AND status = 'ACTIVE'") === 1);
    const stl3 = String(dbQ(BIZ_DB, "SELECT settlement_number FROM party_offsets WHERE payable_id = ? AND status = 'ACTIVE' LIMIT 1", [PC])[0]?.settlement_number || '');
    const rows = stlRows(stl3);
    const pc = einkaufZeile(PC), ra = rechnung(INV_A), rb = rechnung(INV_B);
    ok(rows.length === 1 && rows[0].receivable_id === INV_A && Number(rows[0].amount) === 120.5, `G Datenbank: EINE Zuordnung PC → A 120.500 unter ${stl3} (${S(rows)})`);
    ok(pc.status === 'PARTIALLY_PAID' && Number(pc.remaining_amount) === 79.5 && Number(pc.paid_amount) === 0, `G PC teilweise verrechnet, Rest 79.500, kein Geld (${S(pc)})`);
    ok(Number(ra.paid_amount) === 120.5 && ra.status === 'PARTIAL' && Number(rb.paid_amount) === 0, `G A 120.500 verrechnet, B unberührt (${S(ra)} ${S(rb)})`);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'customers.settle_balance');
    const am = cmds[cmds.length - 1]?.payload?.amounts;
    ok(cmds.length === vorKommandos + 1 && S(am) === S([{ invoiceId: INV_A, sourceId: PC, amount: 120.5 }, { invoiceId: INV_B, sourceId: PC, amount: 0 }]),
      `G PC2 schickt EINEN Auftrag mit den von Hand gesetzten Beträgen (${S(am)})`);
    ok(geldBuchungen() === geld0, 'G keine Geldbuchung');
    client = await lade(client, `/purchases/${PC}`);
    const sel = `[data-purchase-payment-offset="${stl3}/1"]`;
    const da = await warteBis(client, `document.querySelector(${S(sel)})`, 45000);
    ok(da && await exists(client, '[data-purchase-settle-open]'), 'G Einkauf zeigt die Verrechnungszeile; der Rest 79.500 bleibt verrechenbar');
    await foto(client, 'b23-g-pc2-purchase-partial');
  }

  // ── H PC2 (v0.8.101 S4): Kundenkonto „Pia Partner" → „Settle Balance" ⇒ Partnerguthaben 100 als vierte Gruppe, Maus,
  //    EIN Fernauftrag, kein Geld; danach ganze STL rückgängig (App-Dialog) ───────────────────────────────────────────
  {
    await syncRuhe();
    const geldH = geldBuchungen();
    const pib = () => Math.round(1000 * Number(dbQ(BIZ_DB, `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0) AS s
      FROM ledger_entries WHERE account = 'PARTNER_ITEM_BALANCE' AND counterparty_id = ?`, [PARTNER_P])[0]?.s || 0)) / 1000;
    ok(pib() === 600, `H vorher: Partnerkonto 600 (Haben) (${pib()})`);
    client = await lade(client, `/clients/${K_P}/account`);
    await waitFor(client, '[data-account-settle]', 45000);
    ok(await mausKlick(client, '[data-account-settle]') === 'OK', 'H PC2: Maus auf „Settle Balance" im Kundenkonto');
    await waitFor(client, '[data-settle-balance]', 30000);
    const art = await attrs(client, '[data-settle-source]', 'data-settle-source-kind');
    const partner = await attrs(client, '[data-settle-source]', 'data-settle-source-partner');
    ok(S(art) === S(['PARTNER_ITEM']) && S(partner) === S([PARTNER_P]), `H rechts genau das Partnerguthaben des verknüpften Partners (${S(art)} ${S(partner)})`);
    const quelle = await text(client, '[data-settle-source="PUR-2026-000985"]');
    ok(/Partner balance · Pia Partner/.test(quelle) && /counts as paid out to the partner — no cash/.test(quelle), `H gekennzeichnet, vorher/nachher (${quelle.slice(0, 180)})`);
    const paare = await attrs(client, '[data-settle-pair]', 'data-settle-pair');
    ok(S(paare) === S(['PUR-2026-000985>PINV-2026-000985']) && (await attrs(client, '[data-settle-total]', 'data-settle-total'))[0] === '100.000',
      `H Vorschlag: Partner 100 → Rechnung (${S(paare)})`);
    await foto(client, 'b23-h-pc2-partner-dialog');
    const vorKommandos = (await kommandos(client)).filter((x) => x.op === 'customers.settle_balance').length;
    ok(await mausKlick(client, '[data-settle-confirm]') === 'OK', 'H Maus auf „Confirm settlement"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE payable_type = 'PARTNER_ITEM' AND status = 'ACTIVE'") === 1);
    const stlP = String(dbQ(BIZ_DB, "SELECT settlement_number FROM party_offsets WHERE payable_type = 'PARTNER_ITEM' LIMIT 1")[0]?.settlement_number || '');
    const rows = stlRows(stlP);
    ok(rows.length === 1 && rows[0].payable_id === PL_P && Number(rows[0].amount) === 100, `H Datenbank: EINE STL ${stlP}, PARTNER_ITEM 100 (${S(rows)})`);
    const mv = dbQ(BIZ_DB, "SELECT kind, amount, method, cancelled_at FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PAYOUT'", [PL_P]);
    ok(mv.length === 1 && mv[0].method === 'offset' && Number(mv[0].amount) === 100 && !mv[0].cancelled_at, `H am Partnerartikel: Auszahlung per Verrechnung (${S(mv)})`);
    ok(pib() === 500 && geldBuchungen() === geldH && Number(rechnung(INV_P).paid_amount) === 100, `H Soll Partnerkonto 100 (→ 500), keine Geldbuchung, Rechnung 100 bezahlt (${pib()})`);
    const hCmds = (await kommandos(client)).filter((x) => x.op === 'customers.settle_balance');
    ok(hCmds.length === vorKommandos + 1 && S(hCmds.at(-1)?.payload?.sourceIds) === S([PL_P]), `H PC2 schickt EINEN Auftrag customers.settle_balance mit dem Partnerartikel (${S(hCmds.at(-1)?.payload?.sourceIds)})`);
    // Die Verrechnungsliste nennt das Partnerguthaben mit Link in den Partnerartikel — nie „We Borrowed".
    client = await lade(client, `/clients/${K_P}/account`);
    await waitFor(client, `[data-settlement-undo="${stlP}"]`, 45000);
    const q = await client.ev(`return [...document.querySelectorAll('[data-settlement-line]')].map((tr) => (tr.children[1]?.textContent || '').replace(/\\s+/g, ' ').trim());`);
    const href = await attrs(client, '[data-settlement-line-source="PARTNER_ITEM"]', 'href');
    ok(q.length === 1 && /^Partner balance PUR-2026-000985$/.test(q[0]) && /\/partners\?partner=/.test(String(href[0])), `H Verrechnungsliste: „Partner balance …" mit Link (${S(q)} ${S(href)})`);
    await foto(client, 'b23-h-pc2-partner-settled', '[data-settlements]');
    ok(await mausKlick(client, `[data-settlement-undo="${stlP}"]`) === 'OK', `H PC2: Maus auf „Undo settlement" (${stlP})`);
    await waitFor(client, '[data-app-confirm]', 15000);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'H Maus auf „OK"');
    await dateiBis(() => stlRows(stlP).every((r) => r.status === 'REVERSED'));
    const mv2 = dbQ(BIZ_DB, "SELECT cancelled_at FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PAYOUT'", [PL_P]);
    ok(stlRows(stlP).every((r) => r.status === 'REVERSED') && mv2.length === 1 && !!mv2[0].cancelled_at && pib() === 600 && Number(rechnung(INV_P).paid_amount) === 0,
      `H rückgängig: Zuordnung REVERSED, Auszahlung storniert (nicht gelöscht), Partnerkonto wieder 600, Rechnung wieder offen (${pib()})`);
    ok(geldBuchungen() === geldH, 'H auch das Rückgängig bewegt kein Geld');
  }

  // ── I PC2 (v0.8.101 S3): Partner bezahlt die Werkstatt direkt — Teilbetrag 60, dann 40, Storno des Teilbetrags ─────────
  {
    await syncRuhe();
    const geldI = geldBuchungen();
    const saldo = (acc, cp) => Math.round(1000 * Number(dbQ(BIZ_DB, `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0) AS s
      FROM ledger_entries WHERE account = ? AND counterparty_id = ?`, [acc, cp])[0]?.s || 0)) / 1000;
    const ap0 = saldo('ACCOUNTS_PAYABLE', SUP_FREMD), pq0 = saldo('PARTNER_ITEM_BALANCE', PARTNER_Q);
    client = await lade(client, `/partners?partner=${PARTNER_Q}&item=${PL_I}`);
    await waitFor(client, '[data-partner-cost-pay="EXP-2026-000981"]', 45000);
    const offenText = await text(client, `[data-partner-item-expanded="${PL_I}"]`);
    ok(/Open workshop costs/.test(offenText) && /EXP-2026-000981/.test(offenText), `I offene Werkstattkosten am Partnerartikel sichtbar (${offenText.slice(0, 120)})`);
    ok(await mausKlick(client, '[data-partner-cost-pay="EXP-2026-000981"]') === 'OK', 'I PC2: Maus auf „Partner paid directly"');
    await waitFor(client, '[data-partner-direct-amount]', 15000);
    ok(await tippe(client, '[data-partner-direct-amount]', '60') === 'OK', 'I Tastatur: Teilbetrag 60');
    await foto(client, 'b23-i-pc2-direct-dialog');
    const vor = (await kommandos(client)).filter((x) => x.op === 'expenses.record_payment').length;
    ok(await mausKlick(client, '[data-partner-direct-save]') === 'OK', 'I Maus auf „Confirm"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM expense_payments WHERE expense_id = ? AND method = 'partner'", [EXP_I]) === 1);
    const e1 = dbQ(BIZ_DB, 'SELECT paid_amount, status, payment_method FROM expenses WHERE id = ?', [EXP_I])[0] || {};
    ok(Number(e1.paid_amount) === 60 && e1.payment_method === 'bank' && saldo('ACCOUNTS_PAYABLE', SUP_FREMD) === ap0 - 60 && saldo('PARTNER_ITEM_BALANCE', PARTNER_Q) === pq0 + 60,
      `I Werkstattschuld −60, Partnerkonto +60, Geldweg der Ausgabe unverändert (${JSON.stringify(e1)})`);
    ok(geldBuchungen() === geldI, 'I keine Geldbuchung von LATAIF');
    const cmdsI = (await kommandos(client)).filter((x) => x.op === 'expenses.record_payment');
    ok(cmdsI.length === vor + 1 && cmdsI.at(-1)?.payload?.method === 'partner' && cmdsI.at(-1)?.payload?.partnerId === PARTNER_Q,
      `I PC2 schickt EINEN Auftrag expenses.record_payment (partner, ${PARTNER_Q})`);
    // Zweite Teilzahlung 40 → Werkstatt voll bezahlt.
    client = await lade(client, `/partners?partner=${PARTNER_Q}&item=${PL_I}`);
    await waitFor(client, '[data-partner-cost-pay="EXP-2026-000981"]', 45000);
    ok(await mausKlick(client, '[data-partner-cost-pay="EXP-2026-000981"]') === 'OK', 'I PC2: zweite Teilzahlung');
    await waitFor(client, '[data-partner-direct-amount]', 15000);
    ok(await tippe(client, '[data-partner-direct-amount]', '40') === 'OK', 'I Tastatur: 40');
    ok(await mausKlick(client, '[data-partner-direct-save]') === 'OK', 'I Maus auf „Confirm"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM expense_payments WHERE expense_id = ? AND method = 'partner'", [EXP_I]) === 2);
    const e2 = dbQ(BIZ_DB, 'SELECT paid_amount, status FROM expenses WHERE id = ?', [EXP_I])[0] || {};
    ok(Number(e2.paid_amount) === 100 && e2.status === 'PAID' && saldo('ACCOUNTS_PAYABLE', SUP_FREMD) === ap0 - 100 && geldBuchungen() === geldI,
      `I Werkstatt voll bezahlt (100, PAID), kein Geld von LATAIF (${JSON.stringify(e2)})`);
    // Storno des ersten Teilbetrags (Erfassungsfehler) — App-Dialog. Erlaubt nur ohne spätere Bewegung → den zweiten (letzten) stornieren.
    const letzte = String(dbQ(BIZ_DB, "SELECT id FROM item_partner_movements WHERE purchase_line_id = ? AND method = 'direct' ORDER BY rowid DESC LIMIT 1", [PL_I])[0]?.id || '');
    client = await lade(client, `/partners?partner=${PARTNER_Q}&item=${PL_I}`);
    await waitFor(client, `[data-partner-item-cancel="${letzte}"]`, 45000);
    ok(await mausKlick(client, `[data-partner-item-cancel="${letzte}"]`) === 'OK', 'I PC2: Maus auf „reverse (entry error)" der Direktzahlung 40');
    await waitFor(client, '[data-app-confirm]', 15000);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'I Maus auf „OK"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM expense_payments WHERE expense_id = ? AND method = 'partner'", [EXP_I]) === 1);
    const e3 = dbQ(BIZ_DB, 'SELECT paid_amount, status FROM expenses WHERE id = ?', [EXP_I])[0] || {};
    ok(Number(e3.paid_amount) === 60 && e3.status !== 'PAID' && saldo('ACCOUNTS_PAYABLE', SUP_FREMD) === ap0 - 60 && saldo('PARTNER_ITEM_BALANCE', PARTNER_Q) === pq0 + 60,
      `I Storno: Werkstattschuld wieder 40 offen, Partnerkonto +60, Bewegung storniert (${JSON.stringify(e3)})`);
    ok(geldBuchungen() === geldI, 'I auch das Storno bewegt kein Geld');
    await foto(client, 'b23-i-pc2-direct-after', `[data-partner-item-expanded="${PL_I}"]`);
  }

  // ── J PC2 (v0.8.101 S5): gebuchte Partnerforderung 150 gegen Store Credit 30 + We Borrowed 80 + Einkauf 40, dann Rückgängig ──
  {
    await syncRuhe();
    const geldJ = geldBuchungen();
    client = await lade(client, `/clients/${K_Q}/account`);
    await waitFor(client, '[data-account-settle]', 45000);
    ok(await mausKlick(client, '[data-account-settle]') === 'OK', 'J PC2: Maus auf „Settle Balance"');
    await waitFor(client, '[data-settle-balance]', 30000);
    const links = await attrs(client, '[data-settle-invoice]', 'data-settle-invoice-kind');
    const rechts = await attrs(client, '[data-settle-source]', 'data-settle-source-kind');
    ok(S(links) === S(['PARTNER_ITEM']) && S(rechts) === S(['STORE_CREDIT', 'LOAN_BORROWED', 'PURCHASE']),
      `J links nur die gebuchte Partnerforderung (nicht der Kostenanteil, nicht Artikel I), rechts Store Credit, Darlehen, Einkauf (${S(links)} ${S(rechts)})`);
    const lt = await text(client, '[data-settle-invoice="PUR-2026-000987"]');
    ok(/Partner owes · Quinn Partner/.test(lt) && /open 150\.000/.test(lt.replace(/,/g, '')), `J gekennzeichnet „Partner owes", offen 150 (${lt.slice(0, 160)})`);
    const paare = await attrs(client, '[data-settle-pair]', 'data-settle-pair');
    ok(paare.length === 3 && (await attrs(client, '[data-settle-total]', 'data-settle-total'))[0] === '150.000', `J Vorschlag FIFO 30 + 80 + 40 = 150 (${S(paare)})`);
    await foto(client, 'b23-j-pc2-receivable-dialog');
    ok(await mausKlick(client, '[data-settle-confirm]') === 'OK', 'J Maus auf „Confirm settlement"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE receivable_type = 'PARTNER_ITEM' AND status = 'ACTIVE'") === 3);
    const stlJ = String(dbQ(BIZ_DB, "SELECT settlement_number FROM party_offsets WHERE receivable_type = 'PARTNER_ITEM' LIMIT 1")[0]?.settlement_number || '');
    const rows = stlRows(stlJ);
    ok(rows.length === 3 && S(rows.map((r) => [r.payable_type, Number(r.amount)])) === S([['STORE_CREDIT', 30], ['DEBT', 80], ['PURCHASE', 40]]),
      `J EINE STL ${stlJ}: Store Credit 30, Darlehen 80, Einkauf 40 (${S(rows)})`);
    const cc = dbQ(BIZ_DB, 'SELECT used_amount, status FROM customer_credits WHERE id = ?', [CC_Q])[0] || {};
    ok(Number(cc.used_amount) === 30 && cc.status === 'USED' && zahl('SELECT COUNT(*) AS n FROM customer_credit_offsets WHERE customer_credit_id = ? AND reversed_at IS NULL', [CC_Q]) === 1
      && zahl('SELECT COUNT(*) AS n FROM credit_applications WHERE credit_id = ?', [CC_Q]) === 0, 'J Store Credit verbraucht über den eigenen Beleg, keine Anrechnung');
    ok(zahl("SELECT COUNT(*) AS n FROM debt_payments WHERE debt_id = ? AND source = 'offset'", [DEBT_Q]) === 1
      && Number(einkaufZeile(PUR_Q).remaining_amount) === 10, 'J Darlehen 0 offen, Einkauf 10 offen');
    ok(geldBuchungen() === geldJ && zahl("SELECT COUNT(*) AS n FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'CONTRIBUTION' AND method = 'offset' AND cancelled_at IS NULL", [PL_J]) === 3,
      'J keine Geldbuchung; drei Rückzahlungen per Verrechnung am Partnerartikel');
    ok((await kommandos(client)).filter((x) => x.op === 'customers.settle_balance').length >= 1, 'J PC2 schickt den Auftrag customers.settle_balance');
    client = await lade(client, `/clients/${K_Q}/account`);
    await waitFor(client, `[data-settlement-undo="${stlJ}"]`, 45000);
    const rk = await attrs(client, '[data-settlement-line-receivable="PARTNER_ITEM"]', 'href');
    ok(rk.length === 3 && rk.every((h) => /\/partners\?partner=/.test(String(h))), `J Verrechnungsliste: „→ Partner owes …" mit Link (${S(rk)})`);
    ok(await mausKlick(client, `[data-settlement-undo="${stlJ}"]`) === 'OK', `J PC2: Maus auf „Undo settlement" (${stlJ})`);
    await waitFor(client, '[data-app-confirm]', 15000);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'J Maus auf „OK"');
    await dateiBis(() => stlRows(stlJ).every((r) => r.status === 'REVERSED'));
    const cc2 = dbQ(BIZ_DB, 'SELECT used_amount, status FROM customer_credits WHERE id = ?', [CC_Q])[0] || {};
    ok(stlRows(stlJ).every((r) => r.status === 'REVERSED') && Number(cc2.used_amount) === 0 && cc2.status === 'OPEN' && Number(einkaufZeile(PUR_Q).remaining_amount) === 50
      && zahl("SELECT COUNT(*) AS n FROM item_partner_movements WHERE purchase_line_id = ? AND method = 'offset' AND cancelled_at IS NULL", [PL_J]) === 0,
      'J Rückgängig: Store Credit frei, Darlehen und Einkauf wieder offen, Bewegungen storniert');
    ok(geldBuchungen() === geldJ, 'J auch das Rückgängig bewegt kein Geld');
  }

  // ── K PC2 (v0.8.101 Lieferantenrückgabe mit Zusatzkosten): gemeinsamer Artikel K, Einstand 1100 (1000 + 100 Polieren), Q 50 %.
  //    Erst Rücknahmepreis 1100 (abgewiesen, nichts geschrieben), dann 1000 + Zusatzkosten 50 per Bank → Verlust 50, Q trägt 25. ──
  {
    await syncRuhe();
    const soll = (acc) => Math.round(1000 * Number(dbQ(BIZ_DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) AS s
      FROM ledger_entries WHERE account = ?`, [acc])[0]?.s || 0)) / 1000;
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const lose = () => Math.round(1000 * Number(dbQ(BIZ_DB, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS s FROM stock_lots WHERE status != 'CANCELLED'")[0]?.s || 0)) / 1000;
    const inv0 = soll('INVENTORY'), los0 = soll('INVENTORY_LOSS'), bank0 = soll('BANK'), lager0 = lose();
    client = await lade(client, `/purchases/${PUR_K}`);
    await waitFor(client, '[data-purchase-return-open]', 45000);
    ok(await mausKlick(client, '[data-purchase-return-open]') === 'OK', 'K PC2: Maus auf „Return to Supplier"');
    await waitFor(client, `[data-purchase-return-line="${PL_K}"]`, 15000);
    ok(await mausKlick(client, `[data-purchase-return-line="${PL_K}"]`) === 'OK', 'K Maus: Zeile K auswählen');
    ok(await tippe(client, `[data-purchase-return-price="${PL_K}"]`, '1100') === 'OK', 'K Tastatur: Rücknahmepreis 1100 (Zusatzkosten im Preis versteckt)');
    ok(await mausKlick(client, '[data-purchase-return-method="bank"]') === 'OK', 'K Maus: Erstattung „Bank"');
    const vor = (await kommandos(client)).filter((x) => x.op === 'purchases.return_to_supplier').length;
    ok(await mausKlick(client, '[data-purchase-return-confirm]') === 'OK', 'K Maus auf „Confirm Return"');
    await sleep(2500);
    const dialogText = await text(client, '[data-save-error]').catch(() => '');
    ok(zahl("SELECT COUNT(*) AS n FROM purchase_returns WHERE purchase_id = ? AND status != 'DRAFT'", [PUR_K]) === 0 && soll('INVENTORY') === inv0
      && /more than this purchase is worth|above the purchase price/.test(String(dialogText)) && /added costs refunded/.test(String(dialogText)),
      `K Preis über dem Einkauf abgewiesen, Hinweis im Dialog, nichts gebucht (${String(dialogText).replace(/\s+/g, ' ').slice(-200)})`);
    ok(await tippe(client, `[data-purchase-return-price="${PL_K}"]`, '1000') === 'OK', 'K Tastatur: Rücknahmepreis 1000');
    ok(await tippe(client, `[data-purchase-return-added="${PL_K}"]`, '50') === 'OK', 'K Tastatur: Zusatzkosten erstattet 50');
    const fuss = await text(client, '[data-purchase-return-added-total]');
    ok(/total refund 1,?050.000/.test(fuss) && /50.000 BHD$/.test(fuss), `K Dialog zeigt „+ Added costs refunded 50“ und Gesamterstattung 1050 (${fuss})`);
    await foto(client, 'b23-k-pc2-return-dialog');
    ok(await mausKlick(client, '[data-purchase-return-confirm]') === 'OK', 'K Maus auf „Confirm Return"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM purchase_returns WHERE purchase_id = ? AND status = 'COMPLETED'", [PUR_K]) === 1);
    const ret = dbQ(BIZ_DB, "SELECT id, refund_amount, added_cost_refund, refund_method FROM purchase_returns WHERE purchase_id = ? AND status = 'COMPLETED'", [PUR_K])[0] || {};
    ok(Number(ret.refund_amount) === 1000 && Number(ret.added_cost_refund) === 50 && ret.refund_method === 'bank',
      `K Rückgabe: Rücknahme 1000 und Zusatzkosten 50 getrennt erfasst (${S(ret)})`);
    ok(r3(soll('BANK') - bank0) === 1050 && r3(soll('INVENTORY_LOSS') - los0) === 50 && r3(inv0 - soll('INVENTORY')) === 1100,
      `K Hauptbuch: Bank +1050, Verlust 50 (INVENTORY_LOSS), Lager −1100 (${r3(soll('BANK') - bank0)}/${r3(soll('INVENTORY_LOSS') - los0)}/${r3(inv0 - soll('INVENTORY'))})`);
    ok(r3(lager0 - lose()) === 1100, `K kein Lagerrest: auch die Lose sinken um 1100 (${r3(lager0 - lose())})`);
    const pm = dbQ(BIZ_DB, "SELECT amount FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'SUPPLIER_RETURN' AND cancelled_at IS NULL", [PL_K]);
    ok(pm.length === 1 && Number(pm[0].amount) === -25, `K Partner Q trägt die Hälfte des Verlusts (−25) — Anspruch 550 − 25 = 525 (${S(pm)})`);
    const cmds = (await kommandos(client)).filter((x) => x.op === 'purchases.return_to_supplier');
    ok(cmds.length === vor + 2 && Number(cmds.at(-1)?.payload?.lines?.[0]?.addedCostRefund) === 50,
      `K PC2 schickt den Auftrag purchases.return_to_supplier, zuletzt mit addedCostRefund 50 (${cmds.length - vor} Versuche)`);
    await waitFor(client, '[data-purchase-return-added-shown]', 30000).catch(() => null);
    const gezeigt = await text(client, '[data-purchase-return-added-shown]');
    ok(/added costs/.test(gezeigt) && /50.000/.test(gezeigt), `K Einkauf zeigt an der Rückgabe „+ added costs 50“ (${gezeigt})`);
    await foto(client, 'b23-k-pc2-after-return');
  }

  // ── L PC2 (v0.8.101 „Cancel return", Owner 11.11.): die Rückgabe aus K vollständig zurücknehmen; der Einkauf bleibt.
  //    Erst ohne bestätigte Rückzahlung (Nein mit Betrag und Weg, nichts geschrieben), dann bestätigt: Rolex wieder mit 1100
  //    im Lager, Verlust 50 gegengebucht, 1050 per Bank an den Lieferanten zurück, Partneranteil −25 storniert. ──
  {
    await syncRuhe();
    const soll = (acc) => Math.round(1000 * Number(dbQ(BIZ_DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) AS s
      FROM ledger_entries WHERE account = ?`, [acc])[0]?.s || 0)) / 1000;
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const lose = () => Math.round(1000 * Number(dbQ(BIZ_DB, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS s FROM stock_lots WHERE status != 'CANCELLED'")[0]?.s || 0)) / 1000;
    const retK = dbQ(BIZ_DB, "SELECT id, return_number FROM purchase_returns WHERE purchase_id = ? AND status = 'COMPLETED'", [PUR_K])[0] || {};
    const inv0 = soll('INVENTORY'), los0 = soll('INVENTORY_LOSS'), bank0 = soll('BANK'), lager0 = lose(), led0 = zahl('SELECT COUNT(*) AS n FROM ledger_entries');
    client = await lade(client, `/purchases/${PUR_K}`);
    await waitFor(client, `[data-purchase-return-cancel="${retK.id}"]`, 45000);
    ok(await mausKlick(client, `[data-purchase-return-cancel="${retK.id}"]`) === 'OK', `L PC2: Maus auf „Cancel return" an ${retK.return_number}`);
    await waitFor(client, '[data-purchase-return-cancel-dialog]', 15000);
    const dlg = await text(client, '[data-purchase-return-cancel-dialog]');
    ok(/1,?050\.000 BHD back by bank/.test(dlg.replace(/\s+/g, ' ')), `L Dialog nennt die Erstattung 1050 per Bank zur Bestätigung (${dlg.slice(0, 160)})`);
    ok(await tippe(client, '[data-purchase-return-cancel-reason]', 'supplier sent the watch back') === 'OK', 'L Tastatur: Grund');
    const vor = (await kommandos(client)).filter((x) => x.op === 'purchases.cancel_return').length;
    ok(await mausKlick(client, '[data-purchase-return-cancel-confirm]') === 'OK', 'L Maus auf „Cancel Return" (ohne Bestätigung der Rückzahlung)');
    await sleep(2500);
    const nein = await text(client, '[data-purchase-return-cancel-dialog] [data-save-error]').catch(() => '');
    ok(/paid 1050\.000 BHD back by bank/.test(nein) && zahl('SELECT COUNT(*) AS n FROM ledger_entries') === led0
      && dbQ(BIZ_DB, 'SELECT status FROM purchase_returns WHERE id = ?', [retK.id])[0]?.status === 'COMPLETED',
      `L ohne Bestätigung: Nein mit offenem Betrag, nichts gebucht (${nein.slice(0, 160)})`);
    await foto(client, 'b23-l-pc2-cancel-blocked', '[data-purchase-return-cancel-dialog]');
    ok(await mausKlick(client, '[data-purchase-return-cancel-repaid]') === 'OK', 'L Maus: „I have repaid 1,050.000 BHD to the supplier by bank" angehakt');
    ok(await mausKlick(client, '[data-purchase-return-cancel-confirm]') === 'OK', 'L Maus auf „Cancel Return"');
    await dateiBis(() => dbQ(BIZ_DB, 'SELECT status FROM purchase_returns WHERE id = ?', [retK.id])[0]?.status === 'CANCELLED');
    const rk = dbQ(BIZ_DB, 'SELECT status, refund_repaid_amount, cancel_reason, refund_amount, added_cost_refund FROM purchase_returns WHERE id = ?', [retK.id])[0] || {};
    ok(rk.status === 'CANCELLED' && Number(rk.refund_repaid_amount) === 1050 && rk.cancel_reason === 'supplier sent the watch back'
      && Number(rk.refund_amount) === 1000 && Number(rk.added_cost_refund) === 50,
      `L Rückgabe CANCELLED, Beträge bleiben (Historie), Rückzahlung 1050 vermerkt (${S(rk)})`);
    ok(r3(soll('INVENTORY') - inv0) === 1100 && r3(lose() - lager0) === 1100 && r3(los0 - soll('INVENTORY_LOSS')) === 50 && r3(bank0 - soll('BANK')) === 1050,
      `L Hauptbuch: Lager +1100 (= Lose), Verlust −50, Bank −1050 (${r3(soll('INVENTORY') - inv0)}/${r3(lose() - lager0)}/${r3(los0 - soll('INVENTORY_LOSS'))}/${r3(bank0 - soll('BANK'))})`);
    const pk = dbQ(BIZ_DB, 'SELECT status, total_amount, paid_amount, remaining_amount FROM purchases WHERE id = ?', [PUR_K])[0] || {};
    ok(pk.status === 'PAID' && Number(pk.total_amount) === 1000 && Number(pk.paid_amount) === 1000 && Number(pk.remaining_amount) === 0,
      `L Einkauf wie vor der Rückgabe: 1000 bezahlt (${S(pk)})`);
    ok(zahl("SELECT COUNT(*) AS n FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'SUPPLIER_RETURN' AND cancelled_at IS NULL", [PL_K]) === 0
      && dbQ(BIZ_DB, "SELECT stock_status FROM products WHERE id = 'b23-prod-k'")[0]?.stock_status === 'in_stock',
      'L Partneranteil am Verlust storniert, die Rolex ist wieder im Lager');
    const cmds = (await kommandos(client)).filter((x) => x.op === 'purchases.cancel_return');
    ok(cmds.length === vor + 2 && cmds.at(-1)?.payload?.refundRepaid === true && cmds.at(-1)?.payload?.returnId === retK.id,
      `L PC2 schickt purchases.cancel_return (erst ohne, dann mit bestätigter Rückzahlung; ${cmds.length - vor} Versuche)`);
    await waitFor(client, `[data-purchase-return-repaid-shown="${retK.id}"]`, 30000).catch(() => null);
    const gezeigt = await text(client, `[data-purchase-return-repaid-shown="${retK.id}"]`);
    ok(/repaid 1,?050\.000 bank/.test(gezeigt), `L Einkauf zeigt an der stornierten Rückgabe „repaid 1,050.000 bank" (${gezeigt})`);
    await foto(client, 'b23-l-pc2-after-cancel');
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
console.log(`\nb23-purchase-offset e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('CUSTOMER_ACCOUNT_B23_PURCHASE_OFFSET_E2E_PROVED');
process.exit(0);
