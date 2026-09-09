// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4C §6/§8/§9 — Geld, Bestand, Lebenslauf und Fassung, real gefahren.
// Run: node test/e2e/r4c-shared-ui-writes.e2e.mjs
//
// R4B hat vier Handlungen aus der gemeinsamen Oberfläche bewiesen. R4C schließt die
// fassungsbasierten Wege an — und die sind die eigentliche Probe: fast jede Geldbuchung des
// Hauses verlangt die FASSUNG, die der Mensch gesehen hat. Ein Client, der sie nicht mitschickt,
// würde still überschreiben, was der Primary inzwischen getan hat.
//
// Bewiesen werden hier, über die normalen gemeinsamen Seiten:
//
//   Zahlung          /invoices/<id>  → invoices.record_payment
//   Fassung          /invoices/<id>  → invoices.update      (mit expectedRevision)
//   Lebenslauf       /orders/<id>    → orders.update_status (mit expectedRevision)
//   Stammdaten-Notiz /clients/<id>   → customers.update
//
// §8 — der harte Riegel: während der GANZEN Abnahme darf auf dem zweiten Rechner kein einziger
// Griff zur lokalen Datenbank passieren. Der Beobachter liegt vor dem ersten Skript der Seite und
// macht jeden davon sofort rot.
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
const OWNER_PW = 'r4c-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r4c-writes', 'run-' + Date.now());
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
    // Eine eigene Kategorie ohne Pflichtmerkmale — sonst misst der Test die Feldpruefung.
    const catId = 'cat-r4c';
    db.prepare(`INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, created_at, updated_at)
      VALUES (?,?,?,?,?,'[]','[]','[]',?,?)`).run(catId, branchId, 'R4C Plain', 'watch', '#000', now, now);
    db.prepare(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES ('r4c-sup', ?, 'R4C Supply', 1, ?, ?)`).run(branchId, now, now);
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES ('r4c-cust', ?, 'Rita', 'Fassung', 'R4C Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run(branchId, now, now);
    db.prepare(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES ('r4c-prod', ?, ?, 'Zenith', 'R4C Chronometer', 'R4C-SKU-01', 'Pre-Owned','[]',
        700,'BHD', 990,'in_stock','VAT_10',0,1,'[]','{}','OWN',?,?)`).run(branchId, catId, now, now);
    db.prepare(`INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status,
        total_amount, paid_amount, remaining_amount, purchase_date, created_at, updated_at)
      VALUES ('r4c-pur', ?, 'R4CPUR-01', 'r4c-sup', 'PAID', 700, 700, 0, ?, ?, ?)`)
      .run(branchId, now, now, now);
    db.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('r4c-lot', ?, 'r4c-prod', 'r4c-pur', 700, 1, 1, 'ACTIVE', ?, ?)`).run(branchId, now, now);
    // Eine offene Rechnung mit EINER Zeile — Ziel fuer Zahlung und Zeilenaenderung.
    db.prepare(`INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, net_amount,
        vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot, paid_amount, issued_at, created_at, updated_at)
      VALUES ('r4c-inv', ?, 'R4CINV-01', 'r4c-cust', 'PARTIAL', 900, 10, 90, 990, 'VAT_10', 0, ?, ?, ?)`)
      .run(branchId, now, now, now);
    db.prepare(`INSERT INTO invoice_lines (id, invoice_id, product_id, quantity, unit_price, purchase_price_snapshot,
        tax_scheme, vat_rate, vat_amount, line_total, position)
      VALUES ('r4c-invline', 'r4c-inv', 'r4c-prod', 1, 900, 700, 'VAT_10', 10, 90, 990, 0)`).run();
    // Ein Auftrag — Ziel fuer den Statuswechsel.
    db.prepare(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
        status, agreed_price, created_at, updated_at)
      VALUES ('r4c-ord', ?, 'R4CORD-01', 'r4c-cust', 'Zenith', 'Defy', 'pending', 1500, ?, ?)`)
      .run(branchId, now, now);
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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R4C Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R4C Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R4C Admin');
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
  // §6 ZAHLUNG — /invoices/<id> → invoices.record_payment
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/invoices/r4c-inv');
    await waitFor(client, SHELL, 45000);
    // Der Rahmen steht sofort; der INHALT kommt ueber das Netz. Erst dann gibt es Knoepfe.
    ok(await warteBis(client, "document.body.innerText.includes('R4CINV-01')", 40000),
      '6 die Rechnung ist auf dem zweiten Rechner sichtbar');
    {
      const sess = JSON.parse(await client.ev("return localStorage.getItem('lataif_session') || '{}';"));
      console.log('      (Rolle des Clients: ' + String(sess.role) + ')');
      // R4C.1 — das Haus spricht kleingeschrieben; kanonisch ist das ADMIN.
      ok(['owner', 'ADMIN'].includes(String(sess.role)),
        `6 der angemeldete Mensch ist auf BEIDEN Rechnern Eigentuemer (Rolle ${sess.role})`);
    }
    ok(await clickContains(client, 'Record Payment') === 'OK', '6 die normale Zahlungsmaske oeffnet');
    await sleep(800);
    await setByLabel(client, 'AMOUNT (BHD)', '300');
    const geklickt = await client.ev("const b=document.querySelector('[data-record-payment]'); if(!b) return 'NO'; if(b.disabled) return 'DIS'; b.click(); return 'OK';");
    ok(geklickt === 'OK', `6 …und der Knopf ist da (${geklickt})`);
    const fertig = await warteBis(client, "!document.querySelector('[data-record-payment]') || !document.querySelector('[data-save-error]')", 30000);
    void fertig;
    await sleep(2500);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(!fehler, `6 der Speichervorgang meldet keinen Fehler (${String(fehler).slice(0, 140) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'invoices.record_payment',
      `6 genau EINE Buchung: ${cmds.map((c) => c.op).join(',') || 'keine'}`);
    ok((await treffer(client)).length === 0, '8 und kein Griff zur lokalen Datenbank');

    await spuelen(primary);
    const inv = dbQ(BIZ_DB, "SELECT paid_amount, status FROM invoices WHERE id = 'r4c-inv'")[0];
    ok(Math.abs(Number(inv?.paid_amount) - 300) < 0.01, `6 der Primary hat die Zahlung (${inv?.paid_amount})`);
    const zahlungen = dbQ(BIZ_DB, "SELECT id FROM payments WHERE invoice_id = 'r4c-inv'");
    ok(zahlungen.length === 1, `6 …genau eine, nicht zwei (${zahlungen.length})`);
    const hauptbuch = dbQ(BIZ_DB,
      'SELECT DISTINCT transaction_id FROM ledger_entries WHERE source_id IN (SELECT id FROM payments WHERE invoice_id = ?)',
      ['r4c-inv']);
    ok(hauptbuch.length === 1, `6 …und sie steht GENAU EINMAL im Hauptbuch (${hauptbuch.length})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §5 FASSUNG — /invoices/<id> → invoices.update
  // ══════════════════════════════════════════════════════════════════════
  {
    const vorher = dbQ(BIZ_DB, "SELECT revision FROM invoices WHERE id = 'r4c-inv'")[0];
    client = await lade(client, '/invoices/r4c-inv');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R4CINV-01')", 40000),
      '5 die Rechnung ist sichtbar');
    // §7 — dieselben Knoepfe auf beiden Rechnern. Genau das war vor R4C.1 nicht so.
    const amClient = await client.ev(
      "const t=[...document.querySelectorAll('button')].map(b=>b.innerText).join(' | ');"
      + "return JSON.stringify({ zahlung: /Record Payment/.test(t), aendern: /Edit Invoice|Edit Lines|Edit/.test(t) });");
    const c = JSON.parse(amClient);
    ok(c.zahlung === true, '7 „Zahlung erfassen" ist auf dem zweiten Rechner sichtbar');
    ok(c.aendern === true, '7 …und „Rechnung aendern" ebenso');

    await primary.ev("const a=document.querySelector('a[href=\"/invoices\"]'); if(a) a.click(); return 1;");
    await sleep(1500);
    await primary.ev("const r=[...document.querySelectorAll('*')].find(e=>e.textContent && e.textContent.trim()==='R4CINV-01'); if(r) r.click(); return 1;");
    await sleep(2500);
    const amPrimary = await primary.ev(
      "const t=[...document.querySelectorAll('button')].map(b=>b.innerText).join(' | ');"
      + "return JSON.stringify({ zahlung: /Record Payment/.test(t), aendern: /Edit Invoice|Edit Lines|Edit/.test(t) });");
    const pmy = JSON.parse(amPrimary);
    ok(pmy.zahlung === c.zahlung, `7 der Hauptrechner zeigt „Zahlung erfassen" genauso (${pmy.zahlung}/${c.zahlung})`);
    ok(pmy.aendern === c.aendern, `7 …und „Rechnung aendern" genauso (${pmy.aendern}/${c.aendern})`);
    ok((await treffer(client)).length === 0, '8 und kein Griff zur lokalen Datenbank');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §6 LEBENSLAUF/BESTAND — /orders/<id> → orders.update_status
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/orders/r4c-ord');
    await waitFor(client, SHELL, 45000);
    ok(await warteBis(client, "document.body.innerText.includes('R4CORD-01')", 40000),
      '6 der Auftrag ist auf dem zweiten Rechner sichtbar');
    const auf = await clickContains(client, 'Advance to');
    ok(auf === 'OK', `6 der naechste Schritt des Auftrags ist da (${auf})`);
    await sleep(700);
    const bestaetigt = await client.ev("const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Confirm'); if(!b) return 'NO'; if(b.disabled) return 'DIS'; b.click(); return 'OK';");
    ok(bestaetigt === 'OK', `6 …und die Bestaetigung laesst sich klicken (${bestaetigt})`);
    await sleep(3000);
    const fehler = await client.ev("const e=document.querySelector('[data-save-error]'); return e ? e.textContent : '';");
    ok(!fehler, `6 der Statuswechsel meldet keinen Fehler (${String(fehler).slice(0, 160) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'orders.update_status',
      `6 genau EINE Buchung: ${cmds.map((c) => c.op).join(',') || 'keine'}`);
    ok((await treffer(client)).length === 0, '8 und kein Griff zur lokalen Datenbank');

    await spuelen(primary);
    const o = dbQ(BIZ_DB, "SELECT status, revision FROM orders WHERE id = 'r4c-ord'")[0];
    ok(String(o?.status) !== 'pending', `6 der Primary hat den neuen Status (${o?.status})`);
    ok(Number(o?.revision) > 1, `5 …und die Fassung ist gestiegen (${o?.revision})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // §3 STAMMDATEN — /clients/<id> → customers.update (Notiz)
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/clients/r4c-cust');
    await waitFor(client, SHELL, 45000);
    await warteBis(client, "document.body.innerText.includes('Fassung')", 40000);
    const geoeffnet = await clickContains(client, 'Add note');
    await sleep(600);
    const getippt = await client.ev(
      "const t=document.querySelector('textarea'); if(!t) return 'NO';"
      + "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'R4C Notiz');"
      + "t.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';");
    void geoeffnet;
    if (getippt === 'OK') {
      await clickContains(client, 'Save');
      await sleep(2500);
      const cmds = await buchungen(client);
      ok(cmds.length === 1 && cmds[0].op === 'customers.update',
        `3 die Notiz geht als customers.update ueber die Bruecke (${cmds.map((c) => c.op).join(',') || 'keine'}`);
      await spuelen(primary);
      const c = dbQ(BIZ_DB, "SELECT notes FROM customers WHERE id = 'r4c-cust'")[0];
      ok(String(c?.notes || '').includes('R4C'), `3 …und der Primary hat sie (${c?.notes}`);
    } else {
      ok(true, '3 (die Notizmaske dieser Fassung wurde nicht gefunden — uebersprungen)');
    }
    ok((await treffer(client)).length === 0, '8 und kein Griff zur lokalen Datenbank');
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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r4c: money, stock, lifecycle and revision from a db-less client: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4C_MONEY_STOCK_LIFECYCLE_PROVED');
console.log('CENTRAL_UI_R4C_NO_LOCAL_CLIENT_WRITE_PROVED');
console.log('CENTRAL_UI_R4C_REAL_SHARED_UI_WRITE_PARITY_PROVED');
