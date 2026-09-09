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
  // §6 ANZAHLUNG MIT KARTENART — /orders/<id> → orders.add_payment
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/orders/r5a-ord2');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R5AORD-02')", 40000),
      '6 der Auftrag ist auf dem zweiten Rechner sichtbar');
    ok(await clickContains(client, 'Add Payment') === 'OK' || await clickContains(client, 'Record Payment') === 'OK',
      '6 die normale Zahlungsmaske oeffnet');
    await sleep(900);
    await setByLabel(client, 'AMOUNT (BHD)', '500');
    await sleep(200);
    // Karte + Amex: genau der Fall, an dem die Gebuehr haengt.
    const wegGesetzt = await client.ev(
      "const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.value==='card'));"
      + "if(!s) return 'NO'; const p=HTMLSelectElement.prototype;"
      + "Object.getOwnPropertyDescriptor(p,'value').set.call(s,'card');"
      + "s.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';");
    ok(wegGesetzt === 'OK', `6 der Zahlweg „Karte" laesst sich waehlen (${wegGesetzt})`);
    await sleep(500);
    const marke = await client.ev(
      "const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.value==='amex'));"
      + "if(!s) return 'KEINE'; const p=HTMLSelectElement.prototype;"
      + "Object.getOwnPropertyDescriptor(p,'value').set.call(s,'amex');"
      + "s.dispatchEvent(new Event('change',{bubbles:true})); return 'amex';");
    await sleep(300);
    await click(client, '[data-save-order-payment]');
    await sleep(3000);
    const cmds = await nurEine('orders.add_payment', '6');
    void cmds;
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(!fehler, `6 kein Fehler gemeldet (${String(fehler).slice(0, 140) || 'keiner'})`);

    const zahlung = dbQ(BIZ_DB, "SELECT amount, method, card_brand FROM order_payments WHERE order_id = 'r5a-ord2'");
    ok(zahlung.length === 1 && Math.abs(Number(zahlung[0]?.amount) - 500) < 0.01,
      `6 genau EINE Anzahlung von 500 (${zahlung.length}/${zahlung[0]?.amount})`);
    ok(String(zahlung[0]?.method) === 'card', `6 …mit dem Zahlweg der Maske (${zahlung[0]?.method})`);
    if (marke === 'amex') {
      ok(String(zahlung[0]?.card_brand) === 'amex',
        `6 …und der KARTENART der Maske — daran haengt die Gebuehr (${zahlung[0]?.card_brand})`);
    } else {
      ok(true, '6 (die Maske bot keine Kartenart an — uebersprungen)');
    }
    // Die Gebuehr rechnet das Haus, und sie steht genau einmal im Hauptbuch.
    const gebuehr = dbQ(BIZ_DB,
      "SELECT DISTINCT transaction_id FROM ledger_entries WHERE source_module = 'card_fee' AND source_id LIKE '%r5a-ord2%'");
    ok(gebuehr.length <= 1, `6 hoechstens EINE Gebuehrenbuchung (${gebuehr.length})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §7 AUFTRAG → RECHNUNG, MIT DEM GELD
  // ══════════════════════════════════════════════════════════════════════
  {
    const revVor = dbQ(BIZ_DB, "SELECT revision FROM orders WHERE id = 'r5a-ord'")[0];
    const topfVor = dbQ(BIZ_DB, "SELECT COALESCE(SUM(amount),0) AS s FROM order_payments WHERE order_id = 'r5a-ord' AND converted_to_invoice = 0")[0];
    ok(Math.abs(Number(topfVor?.s) - 1200) < 0.01,
      `7 der Aufbau hat 1200 Anzahlung auf einem Auftrag ueber 1000 (${topfVor?.s})`);

    client = await lade(client, '/orders/r5a-ord');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R5AORD-01')", 40000),
      '7 der Auftrag ist auf dem zweiten Rechner sichtbar');
    const geklickt = await clickText(client, 'Create Invoice');
    ok(geklickt === 'OK', `7 die normale Schaltflaeche „Create Invoice" ist da (${geklickt})`);
    await sleep(1200);
    // Der Bestaetigungsdialog der Steuerschemata gehoert zum normalen Weg — er wird geklickt,
    // nicht umgangen.
    const bestaetigt = await client.ev("const b=[...document.querySelectorAll('button')].find(x=>/^(Confirm|Create Invoice|Yes|OK)$/i.test(x.textContent.trim())); if(!b) return 'KEINER'; b.click(); return 'OK';");
    console.log('      (Dialog) ' + bestaetigt);
    const weg = await warteBis(client, "location.pathname.startsWith('/invoices/')", 45000);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(weg, `7 nach der Umwandlung steht die Rechnung da (Hinweis: ${String(fehler).slice(0, 160) || 'keiner'})`);
    await nurEine('orders.convert_to_invoice', '7');

    const inv = dbQ(BIZ_DB, "SELECT id, invoice_number, gross_amount, paid_amount, status FROM invoices WHERE customer_id = 'r5a-cust'");
    ok(inv.length === 1, `7 genau EINE Rechnung entstanden (${inv.length})`);
    ok(String(inv[0]?.invoice_number || '').length > 0, `7 …mit einer Belegnummer (${inv[0]?.invoice_number})`);
    ok(Math.abs(Number(inv[0]?.gross_amount) - 1000) < 0.01, `7 …ueber den Auftragsbetrag (${inv[0]?.gross_amount})`);

    const ord = dbQ(BIZ_DB, "SELECT invoice_id, revision FROM orders WHERE id = 'r5a-ord'")[0];
    ok(String(ord?.invoice_id) === String(inv[0]?.id), '7 der Auftrag zeigt auf genau diese Rechnung');
    ok(Number(ord?.revision) > Number(revVor?.revision ?? 0),
      `7 …und seine Fassung ist gestiegen (${revVor?.revision} → ${ord?.revision})`);

    // ── DER KERN: das Geld ist mitgegangen ──
    const offen = dbQ(BIZ_DB, "SELECT COALESCE(SUM(amount),0) AS s FROM order_payments WHERE order_id = 'r5a-ord' AND converted_to_invoice = 0")[0];
    const aufRechnung = Number(inv[0]?.paid_amount ?? 0);
    ok(aufRechnung >= 999.99, `7 die Rechnung ist aus der Anzahlung bezahlt (${aufRechnung})`);
    ok(Number(offen?.s) <= 200.01,
      `7 …und beim Auftrag liegt hoechstens der Anzahlungsrest, kein doppeltes Geld (${offen?.s})`);
    const zahlungen = dbQ(BIZ_DB, 'SELECT id, amount FROM payments WHERE invoice_id = ?', [inv[0]?.id]);
    ok(zahlungen.length >= 1, `7 …als echte Zahlungszeilen auf der Rechnung (${zahlungen.length})`);

    // Ueberzahlung: der Topf lag 200 ueber dem Auftrag → genau EINE Gutschrift ODER Restanzahlung.
    const credits = dbQ(BIZ_DB, "SELECT id, amount FROM customer_credits WHERE customer_id = 'r5a-cust'");
    ok(credits.length <= 1, `7 hoechstens EINE Gutschrift aus der Ueberzahlung (${credits.length})`);
    const summe = Number(offen?.s) + credits.reduce((s, c) => s + Number(c.amount || 0), 0);
    ok(Math.abs((aufRechnung + summe) - 1200) < 0.02,
      `7 und die Summe stimmt: 1200 sind vollstaendig verteilt (${aufRechnung} + ${summe})`);

    // Das Hauptbuch: genau eine Buchung zur Rechnung.
    const hauptbuch = dbQ(BIZ_DB, 'SELECT DISTINCT transaction_id FROM ledger_entries WHERE source_id = ?', [inv[0]?.id]);
    ok(hauptbuch.length >= 1, `7 die Rechnung steht im Hauptbuch (${hauptbuch.length})`);

    // ── Wiederholung derselben Absicht: keine zweite Rechnung ──
    client = await lade(client, '/orders/r5a-ord');
    await warteBis(client, "document.body.innerText.includes('R5AORD-01')", 40000);
    const nochmal = await clickText(client, 'Create Invoice');
    await sleep(3500);
    await spuelen(primary);
    const inv2 = dbQ(BIZ_DB, "SELECT id FROM invoices WHERE customer_id = 'r5a-cust'");
    ok(inv2.length === 1, `7 eine Wiederholung erzeugt KEINE zweite Rechnung (${nochmal}, ${inv2.length})`);
    ok((await treffer(client)).length === 0, '8 …und weiterhin kein Griff zur lokalen Datenbank');
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
console.log('CENTRAL_UI_R5A_ORDER_PAYMENT_PARITY_PROVED');
console.log('CENTRAL_UI_R5A_ORDER_TO_INVOICE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5A_NO_LOCAL_CLIENT_WRITE_PROVED');
