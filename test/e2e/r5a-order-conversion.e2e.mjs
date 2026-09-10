// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5A — Auftrag → Rechnung, mit dem Geld.
// Run: node test/e2e/r5a-order-conversion.e2e.mjs
//
// Die Umwandlung war seit R3 die bekannteste Lücke: die Fernbuchung legte die Rechnung an, und
// die Anzahlung blieb beim Auftrag liegen. Eine halbe Handlung, die wie ein Erfolg aussieht.
//
// R5A hat die Rechnung dahinter aus der Auftragsansicht in eine Domänenfunktion gehoben
// (`core/orders/order-payment-carryover`) und lässt den Fernbefehl DIESELBE innerhalb seiner
// Transaktion ausführen. Hier wird das gefahren, an zwei echten Rechnern:
//
//   /orders/<id> mit Anzahlung  →  „Create Invoice"  →  orders.convert_to_invoice
//   /orders/<id>                →  „Save Payment"    →  orders.add_payment (mit Kartenart)
//
// Bewiesen wird: genau EINE Rechnung, die Anzahlung vollständig übertragen, die Überzahlung nach
// dem Vertrag des Hauses behandelt, das Hauptbuch genau einmal, die Fassungen richtig — und eine
// Wiederholung derselben Absicht erzeugt keine zweite Rechnung.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
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
const OWNER_PW = 'r5a-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5a-writes', 'run-' + Date.now());
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
/** Ein Feld über seine Beschriftung — so, wie ein Mensch es findet. */
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].find(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)});`
  + `if(!l) return 'NO-LABEL'; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
const clickContains = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes(${S(t)})); if(!b) return 'NO'; b.click(); return 'OK';`);
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

/**
 * Der Beobachter — er lebt im TEST und liegt vor dem ersten Skript der Seite.
 *
 *   • Er schreibt jede Buchung mit, die über die Brücke geht (Name und Kennung).
 *   • Er kann EINE Antwort verlieren lassen: die Anfrage läuft wirklich (der Primary schreibt),
 *     und danach wirft er. Genau das ist der Fall, den keine Oberfläche von „nie angekommen"
 *     unterscheiden kann — und deshalb der einzige, der den Vertrag wirklich prüft.
 */
const BEOBACHTER = `
  if (window.__r4bInstalliert) { /* schon da */ } else {
  window.__r4bInstalliert = true;
  window.__cmds = [];
  window.__killNext = false;
  window.__killed = 0;
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
      if (window.__killNext) {
        window.__killNext = false;
        window.__killed++;
        const r = await of(...a);          // der Primary bekommt sie WIRKLICH
        try { await r.text(); } catch (e) { /* egal */ }
        throw new TypeError('the answer was lost after the primary had written');
      }
    }
    return of(...a);
  };
  }
`;



/**
 * Ein Feld, das die Tabelle nicht hat, ist kein Grund für einen Abbruch mitten im Aufbau —
 * sondern für ein ehrliches Weglassen. Deshalb fragt der Aufbau die Tabelle, statt zu raten.
 */
function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  // Pflichtspalten ohne Vorgabe, die der Aufbau nicht kennt, bekommen einen neutralen Wert —
  // sonst scheitert der Aufbau an einer Spalte, die mit der Pruefung nichts zu tun hat.
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk) continue;
    if (daten[sp.name] !== undefined) continue;
    const t = String(sp.type || '').toUpperCase();
    daten[sp.name] = /INT|REAL|NUM/.test(t)
      ? 0
      : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  const fehlend = Object.keys(werte).filter((k) => !namen.includes(k));
  if (fehlend.length) console.log(`      (Aufbau) ${tabelle}: ohne ${fehlend.join(', ')}`);
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`)
    .run(...nutzbar.map((k) => daten[k]));
}


function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const heute = now.slice(0, 10);
    const category_id = 'cat-r5a';
    insert(db, 'categories', { id: category_id, branch_id, name: 'R5A Plain', icon: 'watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'r5a-cust', branch_id, first_name: 'Omar', last_name: 'Anzahlung', company: 'R5A Co', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'products', {
      id: 'r5a-prod', branch_id, category_id, brand: 'Zenith', name: 'R5A Chronometer', sku: 'R5A-SKU-01',
      condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD',
      planned_sale_price: 1000, stock_status: 'in_stock', tax_scheme: 'ZERO', days_in_stock: 0,
      quantity: 1, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now,
    });

    // Ein fertiger Auftrag ueber 1000, mit einer ANZAHLUNG von 400 — und einer zweiten von 800,
    // so dass der Topf (1200) ueber der Rechnung liegt: genau der Ueberzahlungsfall.
    insert(db, 'orders', { id: 'r5a-ord', branch_id, order_number: 'R5AORD-01', customer_id: 'r5a-cust', requested_brand: 'Zenith', requested_model: 'Defy', status: 'completed', agreed_price: 1000, type: 'normal', created_at: now, updated_at: now });
    insert(db, 'order_lines', { id: 'r5a-line', order_id: 'r5a-ord', product_id: 'r5a-prod', description: 'R5A Chronometer', quantity: 1, unit_price: 1000, line_total: 1000, position: 0, tax_scheme: 'ZERO', vat_rate: 0, is_customer_facing: 1, status: 'ARRIVED', created_at: now });
    insert(db, 'order_payments', { id: 'r5a-pay1', order_id: 'r5a-ord', amount: 400, paid_at: heute, method: 'cash', note: 'Anzahlung', created_at: now });
    insert(db, 'order_payments', { id: 'r5a-pay2', order_id: 'r5a-ord', amount: 800, paid_at: heute, method: 'cash', note: 'Restzahlung', created_at: now });

    // Die Ware liegt wirklich im Lager: ein Los je Artikel, sonst verbraucht die Rechnung nichts.
    insert(db, 'stock_lots', { id: 'lot-r5a-prod', branch_id, product_id: 'r5a-prod', unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });

    // Ein dritter Auftrag, eigener Kunde — hier geht die Antwort verloren.
    insert(db, 'customers', { id: 'r5a-cust3', branch_id, first_name: 'Lina', last_name: 'Stillstand', company: 'R5A Co', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'products', {
      id: 'r5a-prod2', branch_id, category_id, brand: 'Zenith', name: 'R5A Pilot', sku: 'R5A-SKU-02',
      condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 200, purchase_currency: 'BHD',
      planned_sale_price: 500, stock_status: 'in_stock', tax_scheme: 'ZERO', days_in_stock: 0,
      quantity: 1, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now,
    });
    insert(db, 'stock_lots', { id: 'lot-r5a-prod2', branch_id, product_id: 'r5a-prod2', unit_cost: 200, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    insert(db, 'orders', { id: 'r5a-ord3', branch_id, order_number: 'R5AORD-03', customer_id: 'r5a-cust3', requested_brand: 'Zenith', requested_model: 'Pilot', status: 'completed', agreed_price: 500, type: 'normal', created_at: now, updated_at: now });
    insert(db, 'order_lines', { id: 'r5a-line3', order_id: 'r5a-ord3', product_id: 'r5a-prod2', description: 'R5A Pilot', quantity: 1, unit_price: 500, line_total: 500, position: 0, tax_scheme: 'ZERO', vat_rate: 0, is_customer_facing: 1, status: 'ARRIVED', created_at: now });
    insert(db, 'order_payments', { id: 'r5a-pay3', order_id: 'r5a-ord3', amount: 300, paid_at: heute, method: 'cash', note: 'Anzahlung', created_at: now });

    // Der ZWILLING von r5a-ord — dieselben Werte, eigener Kunde, eigener Artikel. Ihn wandelt der
    // Primary ueber seine normale Oberflaeche um; danach wird die Wirkung beider verglichen.
    insert(db, 'customers', { id: 'r5a-custP', branch_id, first_name: 'Omar', last_name: 'Anzahlung', company: 'R5A Co', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'products', {
      id: 'r5a-prodP', branch_id, category_id, brand: 'Zenith', name: 'R5A Chronometer', sku: 'R5A-SKU-0P',
      condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD',
      planned_sale_price: 1000, stock_status: 'in_stock', tax_scheme: 'ZERO', days_in_stock: 0,
      quantity: 1, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now,
    });
    insert(db, 'stock_lots', { id: 'lot-r5a-prodP', branch_id, product_id: 'r5a-prodP', unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    insert(db, 'orders', { id: 'r5a-ordP', branch_id, order_number: 'R5AORD-0P', customer_id: 'r5a-custP', requested_brand: 'Zenith', requested_model: 'Defy', status: 'completed', agreed_price: 1000, type: 'normal', created_at: now, updated_at: now });
    insert(db, 'order_lines', { id: 'r5a-lineP', order_id: 'r5a-ordP', product_id: 'r5a-prodP', description: 'R5A Chronometer', quantity: 1, unit_price: 1000, line_total: 1000, position: 0, tax_scheme: 'ZERO', vat_rate: 0, is_customer_facing: 1, status: 'ARRIVED', created_at: now });
    insert(db, 'order_payments', { id: 'r5a-payP1', order_id: 'r5a-ordP', amount: 400, paid_at: heute, method: 'cash', note: 'Anzahlung', created_at: now });
    insert(db, 'order_payments', { id: 'r5a-payP2', order_id: 'r5a-ordP', amount: 800, paid_at: heute, method: 'cash', note: 'Restzahlung', created_at: now });

    // Ein zweiter Auftrag, offen — Ziel fuer die Anzahlung mit Kartenart.
    insert(db, 'orders', { id: 'r5a-ord2', branch_id, order_number: 'R5AORD-02', customer_id: 'r5a-cust', requested_brand: 'Zenith', requested_model: 'Pilot', status: 'pending', agreed_price: 2000, type: 'normal', created_at: now, updated_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}

/**
 * Die Steuerleitung. Sie besitzt die Registrierung des Beobachters und wird NIE geschlossen: eine
 * geschlossene Sitzung nimmt ihre vorab registrierten Seitenskripte mit, und der Beobachter waere
 * ab dem naechsten Seitenaufbau spurlos weg — der Lauf saehe gruen aus und haette nichts gemessen.
 * Genau daran ist die erste Fassung dieses Tests gescheitert.
 */
let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
/** Eine Fläche frisch aufbauen und ein neues Arbeitsfenster greifen. */
async function lade(c, route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch (e) { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
/**
 * Lesen und Schreiben gehen denselben Weg über die Brücke. Gezählt wird hier nur, was SCHREIBT —
 * dieselbe Regel wie in der Registry: eine Auskunft heisst `.list` oder `.get`.
 */
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));

/** Der Primary schreibt in sql.js; erst dieser Aufruf legt den Stand auf die Platte. */
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Der Primary ────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5A Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5A Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5A Admin');
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
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }

  // ── Der Client: echter Weg, kein Kniff ────────────────────────────────
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
  {
    // Der Beobachter muss WIRKLICH liegen — sonst misst der ganze Lauf nichts.
    client = await lade(client, '/clients');
    await waitFor(client, SHELL, 45000);
    ok(await client.ev('return Array.isArray(window.__cmds);') === true,
      'SETUP der Beobachter liegt vor dem ersten Skript der Seite');
  }




  /** Nach jeder Handlung: was ging wirklich über die Brücke, und blieb die Datenbank unberührt? */
  async function nurEine(op, wo) {
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === op,
      `${wo} genau EINE Buchung ging ueber die Bruecke: ${cmds.map((c) => c.op).join(',') || 'keine'}`);
    ok((await treffer(client)).length === 0, `8 ${wo} kein Griff zur lokalen Datenbank`);
    await spuelen(primary);
    return cmds;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ZAHLUNG MIT KARTENART — /orders/<id> → orders.add_payment
  // Der Zahlweg ist eine Reihe echter Knoepfe, keine Auswahlliste: er wird geklickt.
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/orders/r5a-ord2');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R5AORD-02')", 40000),
      'ZAHLUNG der Auftrag ist auf dem zweiten Rechner sichtbar');
    ok(await clickContains(client, 'Add Payment') === 'OK' || await clickContains(client, 'Record Payment') === 'OK',
      'ZAHLUNG die normale Zahlungsmaske oeffnet');
    await sleep(900);
    await setByLabel(client, 'AMOUNT (BHD)', '500');
    await sleep(200);
    const wegGesetzt = await clickText(client, 'Card');
    ok(wegGesetzt === 'OK', `ZAHLUNG der Zahlweg „Card" ist ein Knopf und laesst sich klicken (${wegGesetzt})`);
    await sleep(400);
    const marke = (await clickText(client, 'Amex')) === 'OK' ? 'amex' : 'KEINE';
    ok(marke === 'amex', `ZAHLUNG …und die Kartenart „Amex" erscheint erst danach (${marke})`);
    await sleep(300);
    await click(client, '[data-save-order-payment]');
    await sleep(3000);
    const cmds = await nurEine('orders.add_payment', 'ZAHLUNG');
    const p = cmds[0]?.payload || {};
    ok(p.method === 'card' && p.cardBrand === 'amex', `ZAHLUNG der Rumpf traegt Zahlweg und Kartenart (${p.method}/${p.cardBrand})`);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(!fehler, `ZAHLUNG kein Fehler gemeldet (${String(fehler).slice(0, 140) || 'keiner'})`);

    const zahlung = dbQ(BIZ_DB, "SELECT amount, method, card_brand FROM order_payments WHERE order_id = 'r5a-ord2'");
    ok(zahlung.length === 1 && Math.abs(Number(zahlung[0]?.amount) - 500) < 0.01,
      `ZAHLUNG genau EINE Anzahlung von 500 (${zahlung.length}/${zahlung[0]?.amount})`);
    ok(String(zahlung[0]?.method) === 'card', `ZAHLUNG …mit dem Zahlweg der Maske (${zahlung[0]?.method})`);
    ok(String(zahlung[0]?.card_brand) === 'amex',
      `ZAHLUNG …und der KARTENART der Maske — daran haengt die Gebuehr (${zahlung[0]?.card_brand})`);
    const gebuehr = dbQ(BIZ_DB,
      "SELECT DISTINCT transaction_id FROM ledger_entries WHERE source_module = 'card_fee' AND source_id LIKE '%r5a-ord2%'");
    ok(gebuehr.length <= 1, `ZAHLUNG hoechstens EINE Gebuehrenbuchung (${gebuehr.length})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // AUFTRAG → RECHNUNG — der Weg NACH „abrechenbar", Schritt fuer Schritt
  // ══════════════════════════════════════════════════════════════════════
  /** Was die Seite direkt vor der Entscheidung zeigt — gelesen, nicht erraten. */
  const BEREIT = "const m=/(\\d+) item\\(s\\) bereit zum Invoicen/.exec(document.body.innerText); return m ? Number(m[1]) : 0;";
  const DIALOG = "const p=[...document.querySelectorAll('p')].find(x=>x.textContent.includes('Review the VAT scheme'));"
    + "if(!p) return 'null'; const rows=[...p.parentElement.querySelectorAll('div')].filter(d=>d.children.length===2"
    + "&&d.children[0].tagName==='SPAN'&&d.children[1].querySelectorAll('button').length===3"
    + "&&d.children[0].textContent.trim()!=='APPLY TO ALL LINES');"
    + "return JSON.stringify(rows.map(r=>({zeile:r.children[0].textContent.trim(),"
    + "schema:([...r.children[1].querySelectorAll('button')].find(b=>/15, 15, 16/.test(b.style.border))||{}).textContent||null})));";
  const DIALOG_ABBRECHEN = "const p=[...document.querySelectorAll('p')].find(x=>x.textContent.includes('Review the VAT scheme'));"
    + "const b=p&&[...p.parentElement.querySelectorAll('button')].find(x=>x.textContent.trim()==='Cancel'); if(!b) return 'NO'; b.click(); return 'OK';";
  const SCHEMA_OFFEN = "document.body.innerText.includes('VAT-Schema bestaetigen')";
  const NUMMER_OFFEN = "document.body.innerText.includes('Choose Invoice Number Type')";
  /** Der Weg des Primary, ohne Neuaufbau: dieselbe Seite, dieselbe Anwendung — nur die Adresse. */
  const primaryZu = (route) => primary.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);

  {
    const revVor = dbQ(BIZ_DB, "SELECT revision FROM orders WHERE id = 'r5a-ord'")[0];
    const topfVor = dbQ(BIZ_DB, "SELECT COALESCE(SUM(amount),0) AS s FROM order_payments WHERE order_id = 'r5a-ord' AND converted_to_invoice = 0")[0];
    ok(Math.abs(Number(topfVor?.s) - 1200) < 0.01,
      `UMWANDLUNG der Aufbau hat 1200 Anzahlung auf einem Auftrag ueber 1000 (${topfVor?.s})`);

    // ── Der Primary: derselbe Auftrag, dieselbe Maske — bis direkt VOR die Entscheidung ──
    await primaryZu('/orders/r5a-ord');
    const pOben = await warteBis(primary, "document.body.innerText.includes('R5AORD-01')", 30000);
    const pBereit = await primary.ev(BEREIT);
    await clickText(primary, 'Create Invoice');
    const pDlg = await warteBis(primary, SCHEMA_OFFEN, 15000);
    const pZeilen = JSON.parse(await primary.ev(DIALOG));
    const pZu = await primary.ev(DIALOG_ABBRECHEN);
    console.log(`      (Primary vor der Entscheidung) sichtbar=${pOben} bereit=${pBereit} Dialog=${pDlg} Zeilen=${S(pZeilen)} Abbruch=${pZu}`);

    // ── LOKAL: der Zwilling, am Primary ueber die normale Oberflaeche umgewandelt ──
    const maxRowid = () => Number(dbQ(BIZ_DB, 'SELECT COALESCE(MAX(rowid),0) AS m FROM ledger_entries')[0]?.m ?? 0);
    // Kennungen, Nummern, Zeiten und Freitexte sind naturgemaess neu — alles andere muss gleich sein.
    const OHNE = /^(id|rowid)$|_id$|_at$|number|^notes?$|description|reference|created_by|entry_no|metadata_json|^sku$|^name$/;
    const norm = (rows) => rows.map((r) => S(Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k))
      .map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v])))).sort();
    const effekt = (ordId, custId, prodId, lotId, ab) => {
      const inv = dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE customer_id = ?', [custId]);
      const invId = inv[0]?.id;
      const buch = dbQ(BIZ_DB, 'SELECT source_module, account, direction, amount, tax_scheme_snapshot, vat_rate_snapshot, counterparty_type FROM ledger_entries WHERE rowid > ? ORDER BY rowid', [ab]);
      const saldo = {};
      for (const b of buch) saldo[b.account] = Math.round(((saldo[b.account] || 0) + (b.direction === 'DEBIT' ? 1 : -1) * Number(b.amount)) * 1000) / 1000;
      const summe = (acc, dir) => Math.round(buch.filter((b) => b.account === acc && b.direction === dir).reduce((s, b) => s + Number(b.amount), 0) * 1000) / 1000;
      return {
        invId, anzahl: inv.length, saldo, arSoll: summe('ACCOUNTS_RECEIVABLE', 'DEBIT'), arHaben: summe('ACCOUNTS_RECEIVABLE', 'CREDIT'),
        rechnung: norm(inv), zeilen: norm(dbQ(BIZ_DB, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', [invId])),
        zahlungen: norm(dbQ(BIZ_DB, 'SELECT * FROM payments WHERE invoice_id = ?', [invId])),
        gutschriften: norm(dbQ(BIZ_DB, 'SELECT * FROM customer_credits WHERE customer_id = ?', [custId])),
        auftrag: norm(dbQ(BIZ_DB, 'SELECT * FROM orders WHERE id = ?', [ordId])),
        positionen: norm(dbQ(BIZ_DB, 'SELECT * FROM order_lines WHERE order_id = ?', [ordId])),
        anzahlungen: norm(dbQ(BIZ_DB, 'SELECT * FROM order_payments WHERE order_id = ?', [ordId])),
        hauptbuch: norm(buch),
        lager: norm(dbQ(BIZ_DB, 'SELECT * FROM stock_lots WHERE id = ?', [lotId])),
        artikel: norm(dbQ(BIZ_DB, 'SELECT * FROM products WHERE id = ?', [prodId])),
        kopf: dbQ(BIZ_DB, 'SELECT gross_amount, paid_amount, status FROM invoices WHERE id = ?', [invId])[0],
        zahlBetraege: dbQ(BIZ_DB, 'SELECT amount, method FROM payments WHERE invoice_id = ? ORDER BY amount', [invId]),
        gutBetraege: dbQ(BIZ_DB, 'SELECT amount, used_amount, source_type, status FROM customer_credits WHERE customer_id = ?', [custId]),
        offen: Number(dbQ(BIZ_DB, 'SELECT COALESCE(SUM(amount),0) AS s FROM order_payments WHERE order_id = ? AND converted_to_invoice = 0', [ordId])[0]?.s ?? 0),
        auftragGeld: dbQ(BIZ_DB, 'SELECT status, deposit_amount, remaining_amount, revision FROM orders WHERE id = ?', [ordId])[0],
        zeileBerechnet: String(dbQ(BIZ_DB, 'SELECT invoice_id FROM order_lines WHERE order_id = ?', [ordId])[0]?.invoice_id ?? '') === String(invId),
      };
    };
    await spuelen(primary);
    const abLokal = maxRowid();
    await primaryZu('/orders/r5a-ordP');
    const lokalWeg = await warteBis(primary, "document.body.innerText.includes('R5AORD-0P')", 30000)
      && (await clickText(primary, 'Create Invoice')) === 'OK'
      && await warteBis(primary, SCHEMA_OFFEN, 15000)
      && (await clickText(primary, 'Weiter')) === 'OK'
      && await warteBis(primary, NUMMER_OFFEN, 15000)
      && (await clickText(primary, 'Confirm')) === 'OK'
      && await warteBis(primary, "location.pathname.startsWith('/invoices/')", 30000);
    ok(lokalWeg, 'LOKAL der Primary wandelt den Zwilling ueber seine normale Oberflaeche um (beide Dialoge)');
    // Der lokale Weg speichert ueber den normalen (verzoegerten) Speicherpfad — nicht ueber den
    // durablen des Fernbefehls. Deshalb wird gewartet, bis der Stand wirklich auf der Platte steht:
    // die Rechnung UND der fertige Anzahlungsuebertrag (der laeuft lokal nach dem Commit).
    let lokal = null;
    for (let i = 0; i < 40; i++) {
      await spuelen(primary);
      await sleep(500);
      lokal = effekt('r5a-ordP', 'r5a-custP', 'r5a-prodP', 'lot-r5a-prodP', abLokal);
      if (lokal.anzahl === 1 && lokal.offen === 0 && lokal.gutBetraege.length > 0) break;
    }

    // ── PC2: derselbe Auftrag ──
    client = await lade(client, '/orders/r5a-ord');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R5AORD-01')", 40000),
      'WEG der Auftrag ist auf dem zweiten Rechner sichtbar');
    const cBereit = await client.ev(BEREIT);
    const geklickt = await clickText(client, 'Create Invoice');
    ok(geklickt === 'OK', `WEG die normale Schaltflaeche „Create Invoice" ist da (${geklickt})`);
    const cDlg = await warteBis(client, SCHEMA_OFFEN, 15000);
    const cZeilen = JSON.parse(await client.ev(DIALOG));
    console.log(`      (PC2 vor der Entscheidung)     bereit=${cBereit} Dialog=${cDlg} Zeilen=${S(cZeilen)}`);
    ok(cBereit === 1, `WEG PC2 zaehlt die abrechenbare Position (${cBereit}) — kein geschluckter Lesefehler`);
    ok(cDlg, 'WEG nach „abrechenbar" kommt der Schema-Dialog — der Weg bricht nicht vorher ab');
    ok(pDlg && pBereit === cBereit && S(pZeilen) === S(cZeilen) && cZeilen.length === 1 && cZeilen[0].schema === 'Zero',
      `PARITAET Primary und PC2 sehen vor der Entscheidung dasselbe (${S(pZeilen)} / ${S(cZeilen)})`);
    ok((await buchungen(client)).length === 0, 'WEG bis hierher ging keine Buchung ueber die Bruecke');

    // ── Die beiden Dialoge: bedient, nicht umgangen ──
    ok(await clickText(client, 'Weiter') === 'OK', 'DIALOG der Schema-Dialog wird mit „Weiter" bestaetigt');
    const nummer = await warteBis(client, NUMMER_OFFEN, 15000);
    ok(nummer, 'DIALOG danach fragt die Maske nach der Nummernart — der normale Weg');
    ok((await buchungen(client)).length === 0, 'DIALOG …und auch der Schema-Dialog hat nichts geschickt');
    await spuelen(primary);
    const abFern = maxRowid();
    ok(await clickText(client, 'Confirm') === 'OK', 'DIALOG die Nummernart wird mit „Confirm" bestaetigt (Normal Final)');

    const weg = await warteBis(client, "location.pathname.startsWith('/invoices/')", 45000);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(weg, `UMWANDLUNG nach der Umwandlung steht die Rechnung da (Hinweis: ${String(fehler).slice(0, 160) || 'keiner'})`);
    const cmds = await nurEine('orders.convert_to_invoice', 'DISPATCH');
    const rumpf = cmds[0]?.payload || {};
    console.log('      (Dispatch) ' + S({ commandId: cmds[0]?.commandId, ...rumpf }));
    ok(String(cmds[0]?.commandId || '').length >= 16, `DISPATCH mit eigener Kennung (${cmds[0]?.commandId})`);
    ok(rumpf.orderId === 'r5a-ord' && rumpf.expectedRevision === Number(revVor?.revision),
      `DISPATCH der Rumpf traegt den Auftrag und die GESEHENE Fassung (${rumpf.orderId}/${rumpf.expectedRevision} = ${revVor?.revision})`);
    ok(S(rumpf.taxSchemes) === S({ 'r5a-line': 'ZERO' }) && rumpf.specialMark === false && rumpf.markComplete === false,
      `DISPATCH …und genau die Wahl der Dialoge (${S(rumpf.taxSchemes)} · special=${rumpf.specialMark} · abschliessen=${rumpf.markComplete})`);

    const inv = dbQ(BIZ_DB, "SELECT id, invoice_number, gross_amount, paid_amount, status, special_mark FROM invoices WHERE customer_id = 'r5a-cust'");
    ok(inv.length === 1, `UMWANDLUNG genau EINE Rechnung entstanden (${inv.length})`);
    ok(String(inv[0]?.invoice_number || '').length > 0, `UMWANDLUNG …mit einer Belegnummer (${inv[0]?.invoice_number})`);
    ok(Math.abs(Number(inv[0]?.gross_amount) - 1000) < 0.01, `UMWANDLUNG …ueber den Auftragsbetrag (${inv[0]?.gross_amount})`);
    ok(Number(inv[0]?.special_mark) === 0, 'UMWANDLUNG …im normalen Nummernkreis, wie im Dialog gewaehlt');
    ok(await client.ev(`return location.pathname === ${S('/invoices/' + inv[0]?.id)};`),
      'UMWANDLUNG PC2 zeigt GENAU die Rechnung, die der Primary angelegt hat');

    const ord = dbQ(BIZ_DB, "SELECT invoice_id, revision FROM orders WHERE id = 'r5a-ord'")[0];
    ok(String(ord?.invoice_id) === String(inv[0]?.id), 'UMWANDLUNG der Auftrag zeigt auf genau diese Rechnung');
    ok(Number(ord?.revision) > Number(revVor?.revision ?? 0),
      `UMWANDLUNG …und seine Fassung ist gestiegen (${revVor?.revision} → ${ord?.revision})`);
    const zeile = dbQ(BIZ_DB, "SELECT invoice_id FROM order_lines WHERE id = 'r5a-line'")[0];
    ok(String(zeile?.invoice_id) === String(inv[0]?.id), 'UMWANDLUNG die Position ist berechnet');

    // ── DER KERN: das Geld ist mitgegangen ──
    const offen = dbQ(BIZ_DB, "SELECT COALESCE(SUM(amount),0) AS s FROM order_payments WHERE order_id = 'r5a-ord' AND converted_to_invoice = 0")[0];
    const aufRechnung = Number(inv[0]?.paid_amount ?? 0);
    ok(aufRechnung >= 999.99, `GELD die Rechnung ist aus der Anzahlung bezahlt (${aufRechnung})`);
    ok(Number(offen?.s) <= 200.01,
      `GELD …und beim Auftrag liegt hoechstens der Anzahlungsrest, kein doppeltes Geld (${offen?.s})`);
    const zahlungen = dbQ(BIZ_DB, 'SELECT id, amount FROM payments WHERE invoice_id = ?', [inv[0]?.id]);
    ok(zahlungen.length >= 1, `GELD …als echte Zahlungszeilen auf der Rechnung (${zahlungen.length})`);
    const credits = dbQ(BIZ_DB, "SELECT id, amount FROM customer_credits WHERE customer_id = 'r5a-cust'");
    ok(credits.length <= 1, `GELD hoechstens EINE Gutschrift aus der Ueberzahlung (${credits.length})`);
    // Vertrag des Hauses: der Ueberzahlungsanteil wird EINE Rechnungszahlung, und daraus entsteht
    // die Gutschrift — sie steckt also IN der bezahlten Summe, nicht daneben.
    ok(Math.abs((aufRechnung + Number(offen?.s)) - 1200) < 0.02,
      `GELD 1200 sind vollstaendig verteilt: Rechnung + Rest beim Auftrag (${aufRechnung} + ${offen?.s})`);
    const gutschrift = credits.reduce((s, c) => s + Number(c.amount || 0), 0);
    ok(Math.abs(gutschrift - Math.max(0, aufRechnung - 1000)) < 0.02,
      `GELD …und die Gutschrift ist genau der Ueberzahlungsanteil (${gutschrift} = ${aufRechnung} − 1000)`);
    const hauptbuch = dbQ(BIZ_DB, 'SELECT DISTINCT transaction_id FROM ledger_entries WHERE source_id = ?', [inv[0]?.id]);
    ok(hauptbuch.length >= 1, `GELD die Rechnung steht im Hauptbuch (${hauptbuch.length})`);

    // ── §1 DIE ÜBERZAHLUNG, BITGENAU — Vorschuss 1200, Rechnung 1000, Ueberschuss 200 ──
    const fern = effekt('r5a-ord', 'r5a-cust', 'r5a-prod', 'lot-r5a-prod', abFern);
    for (const [wer, e] of [['PC2', fern], ['Primary', lokal]]) {
      console.log(`      (Buchhaltung ${wer}) ` + S({ kopf: e.kopf, zahlungen: e.zahlBetraege, gutschriften: e.gutBetraege,
        offenBeimAuftrag: e.offen, auftrag: e.auftragGeld, AR: { soll: e.arSoll, haben: e.arHaben }, saldo: e.saldo }));
    }
    console.log('      (Hauptbuch PC2) ' + fern.hauptbuch.join(' '));
    ok(fern.arSoll === 1000 && fern.arHaben === 1000 && fern.saldo.ACCOUNTS_RECEIVABLE === 0,
      `KONTO auf die Forderung der Rechnung werden genau 1000 angerechnet, nicht 1200 (Soll ${fern.arSoll} / Haben ${fern.arHaben})`);
    ok(fern.saldo.CUSTOMER_CREDIT === -200,
      `KONTO der Ueberschuss 200 steht als Kundenguthaben im Haben (${fern.saldo.CUSTOMER_CREDIT})`);
    ok(fern.gutBetraege.length === 1 && Number(fern.gutBetraege[0].amount) === 200 && fern.gutBetraege[0].source_type === 'overpayment'
      && Number(fern.gutBetraege[0].used_amount || 0) === 0 && fern.gutBetraege[0].status === 'OPEN',
      `KONTO …und als genau EINE offene Gutschrift ueber 200 aus der Ueberzahlung (${S(fern.gutBetraege)})`);
    ok(S(fern.zahlBetraege) === S([{ amount: 200, method: 'cash' }, { amount: 400, method: 'cash' }, { amount: 600, method: 'cash' }]),
      `KONTO die Zahlungszeilen: 400 + 600 bis zur Summe, 200 als Ueberzahlungsanteil (${S(fern.zahlBetraege)})`);
    ok(Number(fern.kopf?.paid_amount) === 1200 && Number(fern.kopf?.gross_amount) === 1000 && fern.kopf?.status === 'FINAL',
      `KONTO der Rechnungskopf fuehrt 1200 als ERHALTEN (Hausvertrag Slice 3: Ueberschuss → Guthaben statt Forderung) bei 1000 Summe, FINAL (${S(fern.kopf)})`);
    ok(fern.offen === 0, `KONTO beim Auftrag bleibt keine Anzahlung liegen (${fern.offen})`);
    ok(Math.abs(Object.values(fern.saldo).reduce((s, v) => s + v, 0)) < 0.001, `KONTO das Hauptbuch ist ausgeglichen (${S(fern.saldo)})`);
    ok(fern.saldo.REVENUE === -1000, `KONTO Umsatz genau 1000 (${fern.saldo.REVENUE})`);

    // ── §2 LOKAL vs FERN — dieselbe Wirkung, nur die Kennungen sind neu ──
    ok(lokal.anzahl === 1 && fern.anzahl === 1 && lokal.zeileBerechnet && fern.zeileBerechnet,
      'PARITAET beide Wege: genau eine Rechnung, die Position zeigt auf sie');
    for (const teil of ['rechnung', 'zeilen', 'zahlungen', 'gutschriften', 'auftrag', 'positionen', 'anzahlungen', 'hauptbuch', 'lager', 'artikel']) {
      const gleich = S(lokal[teil]) === S(fern[teil]);
      ok(gleich, `PARITAET ${teil}: Primary-Oberflaeche == PC2${gleich ? '' : ` — lokal ${S(lokal[teil])} / fern ${S(fern[teil])}`}`);
    }
    ok(S(lokal.saldo) === S(fern.saldo), `PARITAET Kontensalden gleich (${S(lokal.saldo)})`);

    // ── Danach: der Auftrag ist auf beiden Rechnern berechnet ──
    client = await lade(client, '/orders/r5a-ord');
    await warteBis(client, "document.body.innerText.includes('R5AORD-01')", 40000);
    ok(await client.ev(BEREIT) === 0, 'PARITAET PC2 sieht danach nichts mehr abzurechnen — wie der Primary');
    ok((await treffer(client)).length === 0, 'LOKAL …und weiterhin kein Griff zur lokalen Datenbank');
  }

  // ══════════════════════════════════════════════════════════════════════
  // DIE ANTWORT GEHT VERLOREN — derselbe Vorsatz, noch einmal
  // ══════════════════════════════════════════════════════════════════════
  {
    const rechnungen = () => dbQ(BIZ_DB, "SELECT id, paid_amount FROM invoices WHERE customer_id = 'r5a-cust3'");
    const stand = (invId) => ({
      zahlungen: dbQ(BIZ_DB, 'SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ?', [invId])[0],
      buchungen: dbQ(BIZ_DB, 'SELECT COUNT(DISTINCT transaction_id) AS n FROM ledger_entries WHERE source_id = ? OR source_id IN (SELECT id FROM payments WHERE invoice_id = ?)', [invId, invId])[0],
      anzahlung: dbQ(BIZ_DB, "SELECT COUNT(*) AS n, COALESCE(SUM(converted_to_invoice),0) AS k FROM order_payments WHERE order_id = 'r5a-ord3'")[0],
    });
    const durchDieDialoge = async () => {
      if (await clickText(client, 'Create Invoice') !== 'OK') return 'kein Knopf';
      if (!(await warteBis(client, SCHEMA_OFFEN, 15000))) return 'kein Schema-Dialog';
      if (await clickText(client, 'Weiter') !== 'OK') return 'kein Weiter';
      if (!(await warteBis(client, NUMMER_OFFEN, 15000))) return 'kein Nummern-Dialog';
      return 'OK';
    };

    client = await lade(client, '/orders/r5a-ord3');
    await waitFor(client, SHELL, 45000);
    await warteBis(client, "document.body.innerText.includes('R5AORD-03')", 40000);
    ok(await durchDieDialoge() === 'OK', 'VERLOREN der erste Versuch geht den normalen Weg durch beide Dialoge');
    await client.ev('window.__killNext = true; return 1;');
    await clickText(client, 'Confirm');
    const gemeldet = await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000);
    ok(gemeldet, 'VERLOREN die Seite meldet den offenen Ausgang, statt Erfolg zu behaupten');
    ok(await client.ev("return location.pathname === '/orders/r5a-ord3';"), 'VERLOREN …und bleibt beim Auftrag stehen');
    ok(await client.ev('return window.__killed;') === 1, 'VERLOREN (die Antwort wurde wirklich weggenommen)');
    await spuelen(primary);
    const a = rechnungen();
    ok(a.length === 1, `VERLOREN der Primary HAT geschrieben — genau eine Rechnung (${a.length})`);
    const vorher = stand(a[0]?.id);

    // Derselbe Vorsatz, erneut — kein neuer Rumpf, kein Kniff, derselbe Klickweg.
    ok(await durchDieDialoge() === 'OK', 'VERLOREN der zweite Versuch geht denselben Weg');
    await clickText(client, 'Confirm');
    const weg = await warteBis(client, "location.pathname.startsWith('/invoices/')", 40000);
    ok(weg, 'VERLOREN …kommt durch und zeigt die Rechnung');
    const c = (await kommandos(client)).filter((x) => x.op === 'orders.convert_to_invoice');
    ok(c.length === 2 && c[0].commandId === c[1].commandId,
      `VERLOREN zwei Anfragen, DIESELBE Kennung (${c.length}: ${c.map((x) => String(x.commandId).slice(0, 8)).join(' / ')})`);
    ok(c.length === 2 && S(c[0].payload) === S(c[1].payload), 'VERLOREN …mit demselben Rumpf');
    await spuelen(primary);
    const b = rechnungen();
    ok(b.length === 1 && b[0]?.id === a[0]?.id, `VERLOREN keine zweite Rechnung — dieselbe (${b.length})`);
    ok(await client.ev(`return location.pathname === ${S('/invoices/' + a[0]?.id)};`), 'VERLOREN PC2 zeigt genau diese');
    const nachher = stand(a[0]?.id);
    console.log('      (Stand vor/nach der Wiederholung) ' + S({ vorher, nachher }));
    ok(Number(nachher.zahlungen?.n) === Number(vorher.zahlungen?.n) && Math.abs(Number(nachher.zahlungen?.s) - Number(vorher.zahlungen?.s)) < 0.001,
      `VERLOREN kein zweiter Anzahlungsuebertrag (${S(vorher.zahlungen)} → ${S(nachher.zahlungen)})`);
    ok(Math.abs(Number(a[0]?.paid_amount) - 300) < 0.01, `VERLOREN …die 300 Anzahlung stehen genau einmal auf der Rechnung (${a[0]?.paid_amount})`);
    ok(Number(nachher.buchungen?.n) === Number(vorher.buchungen?.n) && Number(vorher.buchungen?.n) >= 1,
      `VERLOREN kein doppeltes Hauptbuch (${vorher.buchungen?.n} → ${nachher.buchungen?.n})`);
    ok(S(nachher.anzahlung) === S(vorher.anzahlung), `VERLOREN die Anzahlungszeilen bleiben, wie sie waren (${S(nachher.anzahlung)})`);
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ── §8 Der Client besitzt weiterhin nichts ────────────────────────────
  {
    const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-location|\.db$/i.test(f));
    ok(verboten.length === 0, `8 kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
  }
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5a: order to invoice, with the money: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5A_OVERPAYMENT_ACCOUNTING_PINNED');
console.log('CENTRAL_UI_R5A_LOCAL_REMOTE_EFFECT_PARITY_PROVED');
console.log('CENTRAL_UI_R5A2_PREDISPATCH_PATH_AUDITED');
console.log('CENTRAL_UI_R5A2_PREDISPATCH_PARITY_PROVED');
console.log('CENTRAL_UI_R5A2_REAL_CONVERSION_DISPATCH_PROVED');
console.log('CENTRAL_UI_R5A1_CONVERSION_IDEMPOTENCY_PROVED');
console.log('CENTRAL_UI_R5A_ORDER_PAYMENT_PARITY_PROVED');
console.log('CENTRAL_UI_R5A_ORDER_TO_INVOICE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5A_NO_LOCAL_CLIENT_WRITE_PROVED');
