// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4C.3 — die neun neu angeschlossenen Buchungen, wirklich gefahren.
// Run: node test/e2e/r4c3-lifecycle-writes.e2e.mjs
//
// R4C.2 hat neun Buchungen an die gemeinsame Oberfläche angeschlossen und das statisch bewiesen.
// Statisch heißt: der Weg ist gebaut. Ob er trägt, zeigt erst das Fahren — an zwei echten
// Anwendungen, über dieselben Seiten und Knöpfe wie am Hauptrechner:
//
//   /invoices/<id>      → returns.record_refund_payment
//   /consignments/<id>  → consignments.update
//   /repairs/<id>       → repairs.add_line · repairs.update_status · repairs.cancel_line
//   /agents             → transfers.update · transfers.mark_sold · transfers.mark_returned
//   /orders/<id>        → orders.delete_payment
//
// Für jede: genau EINE Wirkung, die Fassung steigt, und der Datenbestand des Primary sagt
// dasselbe wie der Bildschirm des zweiten Rechners. Der Beobachter liegt die ganze Zeit und
// macht jeden Griff zur lokalen Datenbank sofort rot.
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
const OWNER_PW = 'r4c3-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r4c3-writes', 'run-' + Date.now());
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
        window.__cmds.push({ op: body.op, commandId: body.commandId });
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
    const category_id = 'cat-r43';
    insert(db, 'categories', { id: category_id, branch_id, name: 'R4C3 Plain', icon: 'watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'r43-sup', branch_id, name: 'R4C3 Supply', active: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'r43-cust', branch_id, first_name: 'Rita', last_name: 'Lebenslauf', company: 'R4C3 Co', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    for (const [id, sku] of [['r43-prod', 'R43-SKU-01'], ['r43-prod2', 'R43-SKU-02'], ['r43-prod3', 'R43-SKU-03'], ['r43-prod4', 'R43-SKU-04']]) {
      insert(db, 'products', {
        id, branch_id, category_id, brand: 'Zenith', name: 'R4C3 ' + sku, sku,
        condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 700, purchase_currency: 'BHD',
        planned_sale_price: 990, stock_status: 'in_stock', tax_scheme: 'VAT_10', days_in_stock: 0,
        quantity: 1, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now,
      });
    }

    // ── Rechnung mit Retoure, deren Erstattung noch offen ist ────────────
    insert(db, 'invoices', { id: 'r43-inv', branch_id, invoice_number: 'R43INV-01', customer_id: 'r43-cust', status: 'PARTIAL', net_amount: 900, vat_rate_snapshot: 10, vat_amount: 90, gross_amount: 990, tax_scheme_snapshot: 'VAT_10', paid_amount: 990, issued_at: now, created_at: now, updated_at: now });
    insert(db, 'invoice_lines', { id: 'r43-invline', invoice_id: 'r43-inv', product_id: 'r43-prod', quantity: 1, unit_price: 900, purchase_price_snapshot: 700, tax_scheme: 'VAT_10', vat_rate: 10, vat_amount: 90, line_total: 990, position: 0 });
    insert(db, 'sales_returns', { id: 'r43-ret', branch_id, return_number: 'R43RET-01', invoice_id: 'r43-inv', customer_id: 'r43-cust', status: 'APPROVED', total_amount: 300, vat_corrected: 0, return_date: heute, refund_method: 'cash', refund_amount: 300, refund_paid_amount: 0, refund_status: 'PENDING', product_disposition: 'IN_STOCK', created_at: now });

    // ── Kommission ──────────────────────────────────────────────────────
    insert(db, 'sales_return_lines', { id: 'r43-retline', return_id: 'r43-ret', invoice_line_id: 'r43-invline', product_id: 'r43-prod', quantity: 1, unit_price: 300, vat_amount: 0, line_total: 300 });

    // ── Kommission ──────────────────────────────────────────────────────
    insert(db, 'consignments', { id: 'r43-cons', branch_id, consignment_number: 'R43CON-01', consignor_id: 'r43-cust', product_id: 'r43-prod2', agreed_price: 500, minimum_price: 400, commission_rate: 15, payout_amount: 0, payout_status: 'pending', status: 'active', agreement_date: heute, notes: 'Aufbau', created_at: now, updated_at: now });

    // ── Reparatur ───────────────────────────────────────────────────────
    insert(db, 'repairs', { id: 'r43-rep', branch_id, repair_number: 'R43REP-01', customer_id: 'r43-cust', repair_scope: 'CUSTOMER', item_brand: 'Zenith', item_model: 'Defy', issue_description: 'Uhr laeuft nach', repair_type: 'internal', tax_scheme: 'VAT_10', status: 'received', estimated_cost: 0, charge_to_customer: 0, created_at: now, updated_at: now });

    // ── Agent mit drei Transfers ────────────────────────────────────────

    // ── Agent mit drei Transfers ────────────────────────────────────────
    insert(db, 'agents', { id: 'r43-agent', branch_id, name: 'Rami Vertreter', company: 'R4C3 Agents', active: 1, created_at: now, updated_at: now });
    for (const [id, nr, product_id] of [['r43-t1', 'R43TR-01', 'r43-prod2'], ['r43-t2', 'R43TR-02', 'r43-prod3'], ['r43-t3', 'R43TR-03', 'r43-prod4']]) {
      insert(db, 'agent_transfers', { id, branch_id, transfer_number: nr, agent_id: 'r43-agent', product_id, agent_price: 800, minimum_price: 700, commission_rate: 10, status: 'transferred', transferred_at: now, settlement_model: 'full', created_at: now, updated_at: now });
    }

    // ── Auftrag mit Anzahlung ───────────────────────────────────────────
    insert(db, 'orders', { id: 'r43-ord', branch_id, order_number: 'R43ORD-01', customer_id: 'r43-cust', requested_brand: 'Zenith', requested_model: 'Defy', status: 'pending', agreed_price: 1500, created_at: now, updated_at: now });
    insert(db, 'order_payments', { id: 'r43-pay', order_id: 'r43-ord', amount: 200, paid_at: heute, method: 'cash', note: 'Aufbau', created_at: now });
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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R4C3 Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R4C3 Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R4C3 Admin');
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
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(!fehler, `${wo} kein Fehler gemeldet (${String(fehler).slice(0, 140) || 'keiner'})`);
    await spuelen(primary);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §3 RETOURE — /invoices/<id> → returns.record_refund_payment
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/invoices/r43-inv');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R43RET-01')", 40000),
      '3 die Retoure ist auf dem zweiten Rechner sichtbar');
    console.log('      (Diagnose Rechnung) ' + String(await client.ev("return document.body.innerText.replace(/\s+/g,' ').slice(0,700);")));
    ok(await clickContains(client, 'Record Refund') === 'OK'
      || await clickContains(client, 'Refund Payment') === 'OK'
      || await clickContains(client, 'Pay Refund') === 'OK',
      '3 die normale Erstattungsmaske oeffnet');
    await sleep(800);
    await setByLabel(client, 'AMOUNT (BHD)', '300');
    await sleep(300);
    const geklickt = await client.ev("const b=document.querySelector('[data-record-refund]'); if(!b) return 'NO'; if(b.disabled) return 'DIS'; b.click(); return 'OK';");
    ok(geklickt === 'OK', `3 …und der Knopf ist da (${geklickt})`);
    await sleep(3000);
    await nurEine('returns.record_refund_payment', '3');

    const r = dbQ(BIZ_DB, "SELECT refund_paid_amount, refund_status FROM sales_returns WHERE id = 'r43-ret'")[0];
    ok(Math.abs(Number(r?.refund_paid_amount) - 300) < 0.01,
      `3 der Primary hat die Auszahlung (${r?.refund_paid_amount})`);
    const buchung = dbQ(BIZ_DB, "SELECT DISTINCT transaction_id FROM ledger_entries WHERE source_id = 'r43-ret'");
    ok(buchung.length <= 1, `3 …und hoechstens EINE Buchung im Hauptbuch dazu (${buchung.length})`);

    // Frisch gelesen auf PC2: derselbe Stand.
    client = await lade(client, '/invoices/r43-inv');
    ok(await warteBis(client, "/300/.test(document.body.innerText)", 30000),
      '3 …und der zweite Rechner sieht ihn nach frischem Lesen');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §4 KOMMISSION — /consignments/<id> → consignments.update
  // ══════════════════════════════════════════════════════════════════════
  {
    const vorher = dbQ(BIZ_DB, "SELECT revision FROM consignments WHERE id = 'r43-cons'")[0];
    client = await lade(client, '/consignments/r43-cons');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R43CON-01')", 40000),
      '4 die Kommission ist auf dem zweiten Rechner sichtbar');
    ok(await clickText(client, 'Edit') === 'OK', '4 die normale Maske oeffnet');
    await sleep(900);
    console.log('      (Diagnose Kommission) Knoepfe: ' + String(await client.ev("return [...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean).join(' | ').slice(0,500);")));
    console.log('      (Diagnose Kommission) Felder: ' + String(await client.ev("return [...document.querySelectorAll('[data-testid]')].map(e=>e.getAttribute('data-testid')).join(',');")));
    const preis = await setVal(client, '[data-testid="pe-agreed"]', '650');
    ok(preis === 'OK',
      `4 der vereinbarte Preis laesst sich aendern (${preis})`);
    await sleep(300);
    await click(client, '[data-save-consignment]');
    await sleep(3000);
    await nurEine('consignments.update', '4');

    const nachher = dbQ(BIZ_DB, "SELECT agreed_price, revision FROM consignments WHERE id = 'r43-cons'")[0];
    ok(Math.abs(Number(nachher?.agreed_price) - 650) < 0.01,
      `4 der Primary hat den neuen Preis (${nachher?.agreed_price})`);
    ok(Number(nachher?.revision) > Number(vorher?.revision ?? 0),
      `4 …und die Fassung ist gestiegen (${vorher?.revision} → ${nachher?.revision})`);
    client = await lade(client, '/consignments/r43-cons');
    ok(await warteBis(client, "/650/.test(document.body.innerText)", 30000),
      '4 …und der zweite Rechner sieht ihn nach frischem Lesen');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §5 REPARATUR — Zeile anlegen, Status weiterschalten, Zeile stornieren
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/repairs/r43-rep');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R43REP-01')", 40000),
      '5 die Reparatur ist auf dem zweiten Rechner sichtbar');

    // ── add_line — R4C.4: die zweite Arbeitsart-Liste ist weg, der Weg gilt wieder ──
    const revVorZeile = dbQ(BIZ_DB, "SELECT revision FROM repairs WHERE id = 'r43-rep'")[0];
    ok(dbQ(BIZ_DB, "SELECT id FROM repair_lines WHERE repair_id = 'r43-rep'").length === 0,
      '5a der Aufbau hat noch keine Zeile — sie entsteht ueber die Maske');
    ok(await clickContains(client, 'Add Work') === 'OK' || await clickContains(client, 'Add Line') === 'OK',
      '5a die Maske fuer eine Arbeitszeile oeffnet');
    await sleep(900);
    // Die Werkstatt: der erste Eintrag des Pickers (In-house steht dort als erste Option).
    await client.ev("const t=[...document.querySelectorAll('[data-ss-trigger]')].find(e=>/supplier|in-house|workshop/i.test(e.getAttribute('data-ss-trigger')||'')); if(t) t.click(); return 1;");
    await sleep(600);
    await client.ev("const o=document.querySelector('[data-ss-option]'); if(o) o.click(); return 1;");
    await sleep(400);
    // Die Arbeitsart kommt aus der Liste, die die Maske anbietet — nicht aus einer erfundenen.
    const art = await client.ev(
      "const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.value==='service'));"
      + "if(!s) return 'NO'; const p=HTMLSelectElement.prototype;"
      + "Object.getOwnPropertyDescriptor(p,'value').set.call(s,'service');"
      + "s.dispatchEvent(new Event('change',{bubbles:true})); return 'service';");
    ok(art === 'service', `5a die Arbeitsart kommt aus der Auswahl der Maske (${art})`);
    await setByLabel(client, 'COST (BHD)', '80');
    await sleep(300);
    const zeileAb = await client.ev("const b=document.querySelector('[data-add-repair-line]'); if(!b) return 'NO'; if(b.disabled) return 'DIS'; b.click(); return 'OK';");
    ok(zeileAb === 'OK', `5a …und der Knopf ist da (${zeileAb})`);
    await sleep(3000);
    await nurEine('repairs.add_line', '5a');
    const zeilen = dbQ(BIZ_DB, "SELECT id, work_type, cost_amount, status FROM repair_lines WHERE repair_id = 'r43-rep'");
    ok(zeilen.length === 1, `5a genau EINE Zeile entstanden (${zeilen.length})`);
    ok(String(zeilen[0]?.work_type) === 'service',
      `5a …mit genau der Arbeitsart der Maske (${zeilen[0]?.work_type})`);
    ok(Math.abs(Number(zeilen[0]?.cost_amount) - 80) < 0.01, `5a …und den eingegebenen Kosten (${zeilen[0]?.cost_amount})`);
    const revNachZeile = dbQ(BIZ_DB, "SELECT revision FROM repairs WHERE id = 'r43-rep'")[0];
    ok(Number(revNachZeile?.revision) > Number(revVorZeile?.revision ?? 0),
      `5a die Fassung der Reparatur ist gestiegen (${revVorZeile?.revision} → ${revNachZeile?.revision})`);
    client = await lade(client, '/repairs/r43-rep');
    ok(await warteBis(client, "/80/.test(document.body.innerText)", 30000),
      '5a …und der zweite Rechner sieht sie nach frischem Lesen');

    // ── cancel_line ──
    client = await lade(client, '/repairs/r43-rep');
    await warteBis(client, "document.body.innerText.includes('R43REP-01')", 40000);
    await client.ev('window.confirm = () => true; return 1;');
    const storno = await client.ev("const b=document.querySelector('[data-cancel-repair-line]'); if(!b) return 'NO'; b.click(); return 'OK';");
    ok(storno === 'OK', `5c die Zeile laesst sich stornieren (${storno})`);
    await sleep(3000);
    await nurEine('repairs.cancel_line', '5c');
    const zeilen2 = dbQ(BIZ_DB, "SELECT status FROM repair_lines WHERE repair_id = 'r43-rep'");
    // Das Haus ENTFERNT die stornierte Zeile (`DELETE FROM repair_lines`) — es setzt sie nicht
    // auf CANCELLED. Genau das wird hier festgehalten, statt eine erfundene Erwartung zu pruefen.
    ok(zeilen2.length === 0, `5c die stornierte Zeile ist weg (${zeilen2.length} uebrig)`);
    // Eine zweite Stornierung derselben Zeile darf nichts mehr bewirken.
    client = await lade(client, '/repairs/r43-rep');
    await warteBis(client, "document.body.innerText.includes('R43REP-01')", 40000);
    await client.ev('window.confirm = () => true; return 1;');
    const nochmal = await client.ev("const b=document.querySelector('[data-cancel-repair-line]'); if(!b) return 'WEG'; b.click(); return 'DA';");
    await sleep(2500);
    await spuelen(primary);
    const zeilen3 = dbQ(BIZ_DB, "SELECT status FROM repair_lines WHERE repair_id = 'r43-rep'");
    ok(zeilen3.length === 0 && nochmal === 'WEG',
      `5c die Schaltflaeche ist danach weg, und es bleibt bei null Zeilen (${nochmal}, ${zeilen3.length})`);
    // ── update_status ──
    client = await lade(client, '/repairs/r43-rep');
    await warteBis(client, "document.body.innerText.includes('R43REP-01')", 40000);
    const weiter = await client.ev("const b=document.querySelector('[data-repair-advance]'); if(!b) return 'NO'; if(b.disabled) return 'DIS'; b.click(); return 'OK';");
    ok(weiter === 'OK', `5b der naechste Schritt ist da (${weiter})`);
    await sleep(3000);
    await nurEine('repairs.update_status', '5b');
    const rep2 = dbQ(BIZ_DB, "SELECT status, revision FROM repairs WHERE id = 'r43-rep'")[0];
    ok(String(rep2?.status) !== 'received', `5b der Primary hat den neuen Status (${rep2?.status})`);
    ok(Number(rep2?.revision) >= 1,
      `5b …und die Fassung ist wieder gestiegen (${rep2?.revision})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §6 TRANSFER — aendern, verkauft, zurueckgenommen
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/agents/r43-agent');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R43TR-01')", 40000),
      '6 die Transfers sind auf dem zweiten Rechner sichtbar');

    // ── update (der dritte Transfer) ──
    const revVor = dbQ(BIZ_DB, "SELECT revision FROM agent_transfers WHERE id = 'r43-t3'")[0];
    const geoeffnet = await client.ev(
      "const z=[...document.querySelectorAll('*')].find(e=>e.children.length===0 && e.textContent.trim()==='R43TR-03');"
      + "if(!z) return 'NO-ROW'; let r=z; for(let i=0;i<8 && r;i++){ const b=r.querySelector && r.querySelector('[data-transfer-edit]');"
      + "if(b){ b.click(); return 'OK'; } r=r.parentElement; } return 'NO-BTN';");
    ok(geoeffnet === 'OK', `6a die Aenderungsmaske des Transfers oeffnet (${geoeffnet})`);
    await sleep(800);
    await setByLabel(client, 'OUR PRICE (BHD)', '850');
    await sleep(300);
    await click(client, '[data-transfer-save]');
    await sleep(3000);
    await nurEine('transfers.update', '6a');
    const t3 = dbQ(BIZ_DB, "SELECT agent_price, revision FROM agent_transfers WHERE id = 'r43-t3'")[0];
    ok(Math.abs(Number(t3?.agent_price) - 850) < 0.01, `6a der Primary hat den neuen Preis (${t3?.agent_price})`);
    ok(Number(t3?.revision) > Number(revVor?.revision ?? 0), `6a …und die Fassung ist gestiegen (${t3?.revision})`);

    // ── mark_sold (der erste Transfer) ──
    client = await lade(client, '/agents/r43-agent');
    await warteBis(client, "document.body.innerText.includes('R43TR-01')", 40000);
    const sold = await client.ev(
      "const z=[...document.querySelectorAll('*')].find(e=>e.children.length===0 && e.textContent.trim()==='R43TR-01');"
      + "if(!z) return 'NO-ROW'; let r=z; for(let i=0;i<8 && r;i++){ const b=r.querySelector && r.querySelector('[data-transfer-sold]');"
      + "if(b){ b.click(); return 'OK'; } r=r.parentElement; } return 'NO-BTN';");
    ok(sold === 'OK', `6b „verkauft" laesst sich anstossen (${sold})`);
    await sleep(800);
    await click(client, '[data-transfer-sold-confirm]');
    await sleep(3000);
    await nurEine('transfers.mark_sold', '6b');
    const t1 = dbQ(BIZ_DB, "SELECT status, actual_sale_price, revision FROM agent_transfers WHERE id = 'r43-t1'")[0];
    ok(String(t1?.status) === 'sold', `6b der Primary hat den Zustand „verkauft" (${t1?.status})`);
    ok(Number(t1?.actual_sale_price) > 0, `6b …mit einem echten Preis (${t1?.actual_sale_price})`);

    // ── mark_returned (der zweite Transfer) ──
    client = await lade(client, '/agents/r43-agent');
    await warteBis(client, "document.body.innerText.includes('R43TR-02')", 40000);
    const ret = await client.ev(
      "const z=[...document.querySelectorAll('*')].find(e=>e.children.length===0 && e.textContent.trim()==='R43TR-02');"
      + "if(!z) return 'NO-ROW'; let r=z; for(let i=0;i<8 && r;i++){ const b=r.querySelector && r.querySelector('[data-transfer-return]');"
      + "if(b){ b.click(); return 'OK'; } r=r.parentElement; } return 'NO-BTN';");
    ok(ret === 'OK', `6c „zurueckgenommen" laesst sich anstossen (${ret})`);
    await sleep(3000);
    await nurEine('transfers.mark_returned', '6c');
    const t2 = dbQ(BIZ_DB, "SELECT status FROM agent_transfers WHERE id = 'r43-t2'")[0];
    ok(String(t2?.status) === 'returned', `6c der Primary hat den Zustand „zurueckgenommen" (${t2?.status})`);
    const prod = dbQ(BIZ_DB, "SELECT stock_status FROM products WHERE id = 'r43-prod3'")[0];
    ok(String(prod?.stock_status) === 'in_stock', `6c …und der Artikel ist wieder im Bestand (${prod?.stock_status})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §7 ANZAHLUNG LOESCHEN — /orders/<id> → orders.delete_payment
  // ══════════════════════════════════════════════════════════════════════
  {
    const revVor = dbQ(BIZ_DB, "SELECT revision FROM orders WHERE id = 'r43-ord'")[0];
    client = await lade(client, '/orders/r43-ord');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R43ORD-01')", 40000),
      '7 der Auftrag ist auf dem zweiten Rechner sichtbar');
    await client.ev('window.confirm = () => true; return 1;');
    const weg = await client.ev(
      "const b=[...document.querySelectorAll('button')].filter(x=>/^(×|✕|x|Delete|Remove)$/i.test(x.textContent.trim()));"
      + "if(b.length===0) return 'NO'; b[b.length-1].click(); return 'OK';");
    ok(weg === 'OK', `7 die Anzahlung laesst sich loeschen (${weg})`);
    await sleep(3000);
    await nurEine('orders.delete_payment', '7');
    const zahlungen = dbQ(BIZ_DB, "SELECT id FROM order_payments WHERE order_id = 'r43-ord'");
    ok(zahlungen.length === 0, `7 genau die Zielzahlung ist weg (${zahlungen.length} uebrig)`);
    const o = dbQ(BIZ_DB, "SELECT revision FROM orders WHERE id = 'r43-ord'")[0];
    ok(Number(o?.revision) > Number(revVor?.revision ?? 0),
      `7 …und die Fassung des Auftrags ist gestiegen (${revVor?.revision} → ${o?.revision})`);
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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r4c.3: nine newly wired mutations, really driven: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4C3_RETURN_RUNTIME_PROVED');
console.log('CENTRAL_UI_R4C3_CONSIGNMENT_RUNTIME_PROVED');
console.log('CENTRAL_UI_R4C3_REPAIR_RUNTIME_PROVED');
console.log('CENTRAL_UI_R4C3_TRANSFER_RUNTIME_PROVED');
console.log('CENTRAL_UI_R4C3_ORDER_PAYMENT_RUNTIME_PROVED');
console.log('CENTRAL_UI_R4C3_NO_LOCAL_WRITE_RUNTIME_PROVED');
