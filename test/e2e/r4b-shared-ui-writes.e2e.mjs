// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4B — vier echte Schreibaktionen aus der GEMEINSAMEN Oberfläche.
// Run: node test/e2e/r4b-shared-ui-writes.e2e.mjs
//
// R3 hat es gemessen: die gemeinsame Oberfläche erreichte KEINE der vierzig geprüften
// Fernbuchungen — jede Schreibaktion ging direkt in die lokale Datenbank, die es auf einem
// zweiten Rechner nicht gibt. R4B legt die Weiche darunter; hier wird sie GEFAHREN:
//
//   /clients            → „New Client"  → customers.create
//   /clients/<id>       → „Edit Client" → customers.update
//   /collection/<id>    → „Edit"        → products.update
//   /invoices/new       → „Save Invoice"→ invoices.create
//
// Es gibt keine Client-Maske und keinen Testzugang: dieselben Routen, dieselben Knöpfe,
// dieselben React-Komponenten wie am Hauptrechner. Und danach steht dasselbe im Datenbestand
// des Primary wie auf dem Bildschirm des zweiten Rechners.
//
// §8 — der teuerste Fall: die ANTWORT geht verloren, NACHDEM der Primary geschrieben hat. Der
// Test nimmt sie der Oberfläche weg (er lässt die Anfrage wirklich laufen und wirft danach). Die
// Oberfläche darf dann nicht „gespeichert" sagen; und der zweite Klick auf denselben Vorsatz muss
// mit DERSELBEN Kennung gehen und genau EINEN Vorgang hinterlassen.
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
const OWNER_PW = 'r4b-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r4b-writes', 'run-' + Date.now());
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

function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    // Eine EIGENE Kategorie ohne Pflichtmerkmale: sonst blockiert die Feldpruefung der Maske den
    // Speichervorgang, und der Test misst die Pruefung statt den Schreibweg.
    const catId = 'cat-r4b';
    db.prepare(`INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, created_at, updated_at)
      VALUES (?,?,?,?,?,'[]','[]','[]',?,?)`).run(catId, branchId, 'R4B Plain', 'watch', '#000', now, now);
    db.prepare(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES ('r4b-sup', ?, 'R4B Supply', 1, ?, ?)`).run(branchId, now, now);
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES ('r4b-cust', ?, 'Bestand', 'Kunde', 'R4B Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run(branchId, now, now);
    db.prepare(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES ('r4b-prod', ?, ?, 'Zenith', 'R4B Chronometer', 'R4B-SKU-01', 'Pre-Owned','[]',
        700,'BHD', 990,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`).run(branchId, catId, now, now);
    db.prepare(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
        total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
      VALUES ('r4b-pur', ?, 'R4BPUR-01', 'r4b-sup', 'PAID', 700, 700, 0, ?, ?, ?)`)
      .run(branchId, now, now, now);
    db.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('r4b-lot', ?, 'r4b-prod', 'r4b-pur', 700, 1, 1, 'ACTIVE', ?, ?)`).run(branchId, now, now);
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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R4B Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R4B Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R4B Admin');
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

  // ══════════════════════════════════════════════════════════════════════
  // §7A — Kunde anlegen, ueber /clients
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/clients');
    await waitFor(client, SHELL, 45000);
    ok(await clickText(client, 'New Client') === 'OK', '7A die normale Maske „New Client" oeffnet');
    await sleep(700);
    await setByLabel(client, 'FIRST NAME', 'Kira');
    await setByLabel(client, 'LAST NAME', 'Fernschreib');
    await setByLabel(client, 'COMPANY', 'Ferne GmbH');
    await click(client, '[data-create-client]');
    const zu = await warteBis(client, "!document.querySelector('[data-create-client]')", 30000);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(zu, `7A der Speichervorgang endet mit einem Ergebnis (Fehler: ${String(fehler).slice(0, 120) || 'keiner'})`);

    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'customers.create',
      `7A genau EINE Buchung ging ueber die Bruecke: ${cmds.map((c) => c.op).join(',') || 'keine'}`);
    ok(typeof cmds[0]?.commandId === 'string' && cmds[0].commandId.length > 10,
      '7A …mit einer Kennung des Vorsatzes');
    ok((await treffer(client)).length === 0, '7A und kein Griff zur lokalen Datenbank');

    await spuelen(primary);
    const rows = dbQ(BIZ_DB, "SELECT id, first_name, company FROM customers WHERE last_name = 'Fernschreib'");
    ok(rows.length === 1, `7A im Datenbestand des Primary steht GENAU EIN neuer Kunde (${rows.length})`);
    ok(rows[0]?.first_name === 'Kira' && rows[0]?.company === 'Ferne GmbH',
      `7A …mit genau den eingegebenen Werten (${rows[0]?.first_name}/${rows[0]?.company})`);
    globalThis.__neuerKunde = rows[0]?.id;

    // Frisch gelesen auf PC2: derselbe Kunde steht in der Liste.
    client = await lade(client, '/clients');
    const sichtbar = await warteBis(client, "document.body.innerText.includes('Fernschreib')", 30000);
    ok(sichtbar, '7A …und der zweite Rechner sieht ihn nach frischem Lesen');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §7B — Kunde aendern, ueber /clients/<id>
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = globalThis.__neuerKunde;
    client = await lade(client, '/clients/' + id);
    await waitFor(client, SHELL, 45000);
    ok(await clickContains(client, 'Edit Client') === 'OK', '7B die normale Maske „Edit Client" oeffnet');
    await sleep(800);
    await setByLabel(client, 'COMPANY', 'Ferne AG');
    await click(client, '[data-save-client]');
    const zu = await warteBis(client, "!document.querySelector('[data-save-client]')", 30000);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(zu, `7B der Speichervorgang endet mit einem Ergebnis (Fehler: ${String(fehler).slice(0, 120) || 'keiner'})`);

    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'customers.update',
      `7B genau EINE Buchung: ${cmds.map((c) => c.op).join(',') || 'keine'}`);
    ok((await treffer(client)).length === 0, '7B und kein Griff zur lokalen Datenbank');

    await spuelen(primary);
    const rows = dbQ(BIZ_DB, 'SELECT company, first_name FROM customers WHERE id = ?', [id]);
    ok(rows[0]?.company === 'Ferne AG', `7B der Primary hat die Aenderung (${rows[0]?.company})`);
    ok(rows[0]?.first_name === 'Kira', '7B …und NUR sie: der Rest ist unangetastet');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §7C — Artikel aendern, ueber /collection/<id>
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/collection/r4b-prod');
    await waitFor(client, SHELL, 45000);
    ok(await clickContains(client, 'Edit') === 'OK', '7C die normale Artikelmaske oeffnet');
    await sleep(900);
    await setByLabel(client, 'STORAGE LOCATION', 'Tresor 7');
    await click(client, '[data-save-product]');
    const zu = await warteBis(client, "!document.querySelector('[data-save-product]')", 30000);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(zu, `7C der Speichervorgang endet mit einem Ergebnis (Fehler: ${String(fehler).slice(0, 140) || 'keiner'})`);

    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'products.update',
      `7C genau EINE Buchung: ${cmds.map((c) => c.op).join(',') || 'keine'}`);
    ok((await treffer(client)).length === 0, '7C und kein Griff zur lokalen Datenbank');

    await spuelen(primary);
    const rows = dbQ(BIZ_DB, "SELECT storage_location, sku, images FROM products WHERE id = 'r4b-prod'");
    ok(rows[0]?.storage_location === 'Tresor 7', `7C der Primary hat die Aenderung (${rows[0]?.storage_location})`);
    ok(rows[0]?.sku === 'R4B-SKU-01', '7C …und die SKU hat der Client nicht angefasst');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §7D — Rechnung anlegen, ueber /invoices/new
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/invoices/new');
    await waitFor(client, '[data-ss-trigger="Search clients..."]', 45000);
    await click(client, '[data-ss-trigger="Search clients..."]');
    await sleep(600);
    await click(client, '[data-ss-option="r4b-cust"]');
    await sleep(600);
    await click(client, '[data-ss-trigger="Pick product..."]');
    await sleep(600);
    ok(await exists(client, '[data-ss-option="r4b-prod"]'), '7D der Artikel steht im Picker');
    await click(client, '[data-ss-option="r4b-prod"]');
    await sleep(1500);
    await click(client, '[data-save-invoice]');
    const weg = await warteBis(client, "location.pathname !== '/invoices/new'", 40000);
    const fehler = await client.ev("return (document.body.innerText.match(/No answer|not available|Failed[^\\n]*/) || [''])[0];");
    ok(weg, `7D nach dem Speichern steht die neue Rechnung da (Hinweis: ${String(fehler).slice(0, 140) || 'keiner'})`);

    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'invoices.create',
      `7D genau EINE Buchung: ${cmds.map((c) => c.op).join(',') || 'keine'}`);
    ok((await treffer(client)).length === 0, '7D und kein Griff zur lokalen Datenbank');

    await spuelen(primary);
    const rows = dbQ(BIZ_DB, "SELECT id, invoice_number, gross_amount FROM invoices WHERE customer_id = 'r4b-cust'");
    ok(rows.length === 1, `7D im Datenbestand des Primary steht GENAU EINE Rechnung (${rows.length})`);
    ok(Number(rows[0]?.gross_amount) > 0, `7D …mit einem echten Betrag (${rows[0]?.gross_amount})`);
    const zeilen = dbQ(BIZ_DB, 'SELECT product_id, lot_id FROM invoice_lines WHERE invoice_id = ?', [rows[0]?.id]);
    ok(zeilen.length === 1 && zeilen[0]?.product_id === 'r4b-prod',
      `7D …und ihre Zeile nennt den gewaehlten Artikel (${zeilen.length})`);
    const los = dbQ(BIZ_DB, "SELECT qty_remaining FROM stock_lots WHERE id = 'r4b-lot'");
    ok(Number(los[0]?.qty_remaining) === 0, `7D …und der Bestand wurde abgezogen (${los[0]?.qty_remaining})`);
    globalThis.__rechnungsNummer = rows[0]?.invoice_number;
  }

  // ══════════════════════════════════════════════════════════════════════
  // §8 — die Antwort geht verloren, NACHDEM der Primary geschrieben hat
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/clients');
    await waitFor(client, SHELL, 45000);
    await clickText(client, 'New Client');
    await sleep(700);
    await setByLabel(client, 'FIRST NAME', 'Lene');
    await setByLabel(client, 'LAST NAME', 'Stillstand');
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-create-client]');
    const gemeldet = await warteBis(client, "document.querySelector('[data-save-error]')", 30000);
    ok(gemeldet, '8 die Oberflaeche meldet den offenen Ausgang, statt Erfolg zu behaupten');
    const text = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(/not clear whether/i.test(String(text)), `8 …und benennt ihn als offen (${String(text).slice(0, 90)})`);
    ok(await exists(client, '[data-create-client]'), '8 …die Maske bleibt offen, der Vorsatz ist nicht verbraucht');
    ok(await client.ev('return window.__killed;') === 1, '8 (die Antwort wurde wirklich weggenommen)');

    // Derselbe Vorsatz, erneut. Kein neuer Rumpf, kein neuer Klickweg — nur nochmal speichern.
    await click(client, '[data-create-client]');
    const zu = await warteBis(client, "!document.querySelector('[data-create-client]')", 30000);
    ok(zu, '8 der zweite Versuch derselben Absicht kommt durch');

    const cmds = await kommandos(client);
    const kunde = cmds.filter((c) => c.op === 'customers.create');
    ok(kunde.length === 2, `8 zwei Anfragen gingen raus (${kunde.length})`);
    ok(kunde[0].commandId === kunde[1].commandId,
      `8 …aber BEIDE mit derselben Kennung (${kunde[0]?.commandId?.slice(0, 8)} / ${kunde[1]?.commandId?.slice(0, 8)})`);

    await spuelen(primary);
    const rows = dbQ(BIZ_DB, "SELECT id FROM customers WHERE last_name = 'Stillstand'");
    ok(rows.length === 1, `8 und im Datenbestand steht GENAU EIN Kunde, nicht zwei (${rows.length})`);
  }
  {
    // Dasselbe fuer die Rechnung — dort haengen Nummer, Bestand und Buchung daran.
    const los = dbQ(BIZ_DB, "SELECT qty_remaining FROM stock_lots WHERE product_id = 'r4b-prod' AND qty_remaining > 0");
    if (los.length === 0) {
      // Ein zweites Los, damit die zweite Rechnung ueberhaupt Ware hat.
      const db = new DatabaseSync(BIZ_DB);
      try {
        const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id;
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
          VALUES ('r4b-lot-2', ?, 'r4b-prod', 'r4b-pur', 700, 1, 1, 'ACTIVE', ?, ?)`).run(branchId, now, now);
        db.prepare("UPDATE products SET stock_status = 'in_stock', quantity = 1 WHERE id = 'r4b-prod'").run();
      } finally { try { db.close(); } catch { /* zu */ } }
      // Der Primary haelt seinen Stand im Fenster — er muss ihn neu einlesen.
      primary.close();
      killImage('lataif.exe'); await waitGone('lataif.exe');
      primary = await attach(APP_CDP, APP, appEnv());
      await waitInvoke(primary);
      await waitFor(primary, SHELL, 90000);
      await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
      await sleep(2500);
    }

    client = await lade(client, '/invoices/new');
    await waitFor(client, '[data-ss-trigger="Search clients..."]', 45000);
    await click(client, '[data-ss-trigger="Search clients..."]');
    await sleep(600);
    await click(client, '[data-ss-option="r4b-cust"]');
    await sleep(600);
    await click(client, '[data-ss-trigger="Pick product..."]');
    await sleep(600);
    await click(client, '[data-ss-option="r4b-prod"]');
    await sleep(1500);
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-save-invoice]');
    const gemeldet = await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000);
    ok(gemeldet, '8 die Rechnungsmaske meldet den offenen Ausgang');
    ok(await client.ev("return location.pathname === '/invoices/new';"),
      '8 …und bleibt stehen, statt einen Erfolg vorzutaeuschen');

    await click(client, '[data-save-invoice]');
    const weg = await warteBis(client, "location.pathname !== '/invoices/new'", 40000);
    ok(weg, '8 der zweite Versuch derselben Absicht kommt durch');

    const cmds = (await kommandos(client)).filter((c) => c.op === 'invoices.create');
    ok(cmds.length === 2 && cmds[0].commandId === cmds[1].commandId,
      `8 zwei Anfragen, EINE Kennung (${cmds.length} / ${cmds[0]?.commandId === cmds[1]?.commandId})`);

    await spuelen(primary);
    const rows = dbQ(BIZ_DB, "SELECT id, invoice_number FROM invoices WHERE customer_id = 'r4b-cust' ORDER BY created_at");
    ok(rows.length === 2, `8 es gibt GENAU zwei Rechnungen — die von §7D und diese eine (${rows.length})`);
    const nummern = rows.map((r) => r.invoice_number);
    ok(new Set(nummern).size === 2, `8 …mit verschiedenen Nummern, keine doppelt vergeben (${nummern.join(',')})`);
    const zeilen = dbQ(BIZ_DB, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [rows[1]?.id]);
    ok(zeilen.length === 1, `8 …die zweite Rechnung hat GENAU eine Zeile, nicht zwei (${zeilen.length})`);
    const hauptbuch = dbQ(BIZ_DB,
      'SELECT DISTINCT transaction_id FROM ledger_entries WHERE source_id = ?', [rows[1]?.id]);
    ok(hauptbuch.length <= 1, `8 …und hoechstens EINE Buchung im Hauptbuch dazu (${hauptbuch.length})`);
    const ersteBuchung = dbQ(BIZ_DB,
      'SELECT DISTINCT transaction_id FROM ledger_entries WHERE source_id = ?', [rows[0]?.id]);
    ok(ersteBuchung.length === 1,
      `8 (und die Rechnung aus §7D hat genau eine — der Vergleich ist echt: ${ersteBuchung.length})`);
  }

  // ── §6 Der Client besitzt weiterhin nichts ────────────────────────────
  {
    const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-location|\.db$/i.test(f));
    ok(verboten.length === 0, `DBLESS kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r4b: four real shared-UI writes from a db-less client: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4B_REAL_SHARED_UI_WRITE_E2E_PROVED');
console.log('CENTRAL_UI_R4B_REAL_UI_LOST_RESPONSE_PROVED');
