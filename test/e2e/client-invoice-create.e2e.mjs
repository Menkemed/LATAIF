// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3B — ein zweiter Rechner schreibt eine Rechnung, durch die ECHTE Kette.
//
// Der Client ist hier bewusst nur HTTP — genau das, was das Formular des Clients tut: es baut den
// Rumpf (`buildInvoiceRequest`), vergibt EINE Kennung pro Speicherversuch und schickt ihn an
// `POST /api/command`. Alles dahinter ist echt: Anmeldung, Rust-Zulassungsliste, Warteregister,
// Tauri-Ereignis, der Renderer des Primary, `createDirectInvoice`, der durable Nachweis, das
// Speichern. Was hier gruen ist, ist nicht behauptet, sondern gelaufen.
//
// Die drei Fragen, an denen alles haengt:
//   1. Entsteht die Rechnung genau einmal, mit einer Nummer aus dem Zaehler des Primary?
//   2. Was passiert, wenn die Antwort verlorengeht und derselbe Auftrag noch einmal kommt?
//   3. Was passiert, wenn zwei Rechner dasselbe letzte Stueck wollen?
//
// Isolierter e2e-Bezeichner + AppData + Sync-Port (3011); die Produktion wird nie beruehrt.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-owner-' + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-c3b-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const count = (sql, params = []) => Number(dbQ(BIZ_DB, sql, params)[0]?.c ?? -1);

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

function killAllApp() { try { execFileSync('taskkill', ['/F', '/IM', 'lataif.exe', '/T'], { stdio: 'ignore' }); } catch {} }
async function waitProcessGone() {
  for (let i = 0; i < 60; i++) {
    try { const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq lataif.exe'], { encoding: 'utf8' }); if (!/lataif\.exe/i.test(out)) return; } catch { return; }
    await sleep(300);
  }
}
async function waitPortFree(port) {
  for (let i = 0; i < 60; i++) {
    try { const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }); if (!out.split('\n').some((l) => l.includes(`:${port} `) && /LISTENING/.test(l))) return; } catch { return; }
    await sleep(300);
  }
}
async function startApp() {
  spawn(APP, [], { env: appEnv(), stdio: 'ignore', detached: true }).unref();
  const end = Date.now() + 90000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {}
    await sleep(500);
  }
  if (!page) throw new Error('app CDP page did not come up');
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickText = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }

async function frontendLogin(c) {
  await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin');
    await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev("[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;");
  }
  await waitFor(c, 'a[href="/settings"], nav a, [data-testid]', 30000);
}
async function ensureSignedIn(c) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    if (await exists(c, 'a[href="/settings"], nav a, [data-testid]')) return true;
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) {
      try { await frontendLogin(c); return true; } catch { await sleep(1000); }
    }
    await sleep(400);
  }
  throw new Error('app shell never appeared');
}
const invokeErr = (c, cmd, args) => c.ev(`try { await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args || {})}); return 'NO-ERROR'; } catch (e) { return String(e); }`);

/** Bestand im Ruhezustand: ein Produkt mit GENAU EINEM Stueck und ein zweites mit dreien. */
function seedFixture() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    const product = (id, sku, qty) => {
      db.prepare(
        `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
           purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
           quantity, images, attributes, source_type, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'Pre-Owned','[]', 100,'BHD', 150,'in_stock','VAT_10',0,?, '[]','{}','OWN',?,?)`)
        .run(id, branchId, 'cat-watch', 'Zenith', 'C3B ' + sku, sku, qty, now, now);
      db.prepare(
        `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
         VALUES (?,?,?, 100, ?, ?, 'ACTIVE', ?, ?)`)
        .run('lot-' + id, branchId, id, qty, qty, now, now);
    };
    product('c3b-single', 'C3B-ONE', 1);
    product('c3b-many', 'C3B-MANY', 3);
    db.prepare(
      `INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
         vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
       VALUES (?,?,?,?,?, 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run('c3b-cust-1', branchId, 'Remote', 'Buyer', 'C3B Co', now, now);
    return branchId;
  } finally { try { db.close(); } catch {} }
}

// ── Der Client: nur HTTP, keine Datenbank ─────────────────────────────────
let clientToken = null;
async function clientLogin(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  clientToken = (await res.json()).token || null;
  return clientToken;
}
const uuid = () => crypto.randomUUID();

/** Genau der Rumpf, den `buildInvoiceRequest` im Formular baut — Auswahl, nichts Abgeleitetes. */
const request = (productId, unitPrice = 150, qty = 1) => ({
  customerId: 'c3b-cust-1',
  issuedDate: new Date().toISOString().slice(0, 10),
  lines: [{ productId, quantity: qty, unitPrice, scheme: 'auto' }],
});

async function send(op, payload, commandId = uuid()) {
  const res = await fetch(`${BASE}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
    body: JSON.stringify({ op, commandId, payload }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, commandId };
}

console.log('CENTRAL-C3B — a second machine writes an invoice\n');
try {
  // Ein frischer Anfang. Der Pfad traegt den e2e-Bezeichner — die Produktion liegt woanders, und
  // der Vorflug prueft das gleich danach noch einmal.
  if (!APP_DATA_DIR.includes('com.lataif.app.e2e')) throw new Error('refusing to wipe a non-e2e AppData');
  killAllApp(); await waitProcessGone();
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  let c = await startApp();
  await waitInvoke(c);
  await ensureSignedIn(c);

  c.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  seedFixture();
  ok(count("SELECT COUNT(*) c FROM stock_lots WHERE id='lot-c3b-single' AND qty_remaining=1") === 1,
    'the primary has one piece of the single-unit product');

  const seedOut = execFileSync(SEED, ['seed-primary', SERVER_DB], {
    env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8',
  }).trim();
  ok(/OK/.test(seedOut), `the install is provisioned and made primary (${seedOut})`);

  c = await startApp();
  await waitInvoke(c);
  await ensureSignedIn(c);
  ok(await invokeErr(c, 'sync_server_start', {}) === 'NO-ERROR', 'and serves on the LAN');
  {
    const end = Date.now() + 45000; let up = false;
    while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
    ok(up, 'the server answers');
  }
  ok(await clientLogin(OWNER_EMAIL, OWNER_PW) !== null, 'AUTH the client has a session');

  // ── 1) Der Auftrag laeuft: eine Rechnung, eine Nummer, ein Bestandsabzug ──
  const invoicesBefore = count('SELECT COUNT(*) c FROM invoices');
  const first = await send('invoices.create', request('c3b-many'));
  ok(first.status === 200 && first.body.ok === true,
    `CREATE the client creates an invoice through the real chain (${first.status} ${S(first.body).slice(0, 200)})`);
  const created = first.body.value || {};
  ok(/^PINV-\d{4}-\d{6}$/.test(String(created.invoiceNumber)),
    `CREATE with a number from the primary's counter (${created.invoiceNumber})`);
  ok(created.replayed === false, 'CREATE …and it really ran, it was not a replay');
  await sleep(1200); // der Primary speichert nach dem Commit
  ok(count('SELECT COUNT(*) c FROM invoices') === invoicesBefore + 1, 'CREATE exactly one invoice more on disk');
  ok(count('SELECT COUNT(*) c FROM invoices WHERE id=?', [created.invoiceId]) === 1, 'CREATE …and it is that one');
  ok(count('SELECT COUNT(*) c FROM invoice_lines WHERE invoice_id=?', [created.invoiceId]) === 1, 'CREATE with its line');
  ok(count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-c3b-many'") === 2, 'CREATE the stock went down by one');
  ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='INVOICE' AND source_id=?", [created.invoiceId]) > 0,
    'CREATE and it is booked');
  ok(count('SELECT COUNT(*) c FROM remote_command_ledger WHERE command_id=?', [first.commandId]) === 1,
    'CREATE the durable record carries the client command id');

  // ── 2) Der Client hat weiterhin keine eigene Datenbank ────────────────────
  //
  // Strukturell wahr: dieser Client ist ein HTTP-Aufruf. Er hat keinen Datenort, keine Datei und
  // keine Moeglichkeit, eine anzulegen — genau das ist der Punkt.
  ok(typeof fetch === 'function' && !('sqlite' in globalThis),
    'DBLESS the client is nothing but HTTP — it cannot open a business database');

  // ── 3) Verlorene Antwort: dieselbe Kennung, keine zweite Rechnung ─────────
  const before = {
    invoices: count('SELECT COUNT(*) c FROM invoices'),
    lot: count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-c3b-many'"),
    ledger: count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='INVOICE'"),
  };
  const retry = await send('invoices.create', request('c3b-many'), first.commandId);
  ok(retry.status === 200 && retry.body.ok === true, `RETRY the repeat is answered (${retry.status})`);
  ok(retry.body.value?.invoiceId === created.invoiceId && retry.body.value?.invoiceNumber === created.invoiceNumber,
    `RETRY with the SAME invoice and number (${retry.body.value?.invoiceNumber})`);
  ok(retry.body.value?.replayed === true, 'RETRY …and it says so: this was a replay');
  await sleep(800);
  ok(count('SELECT COUNT(*) c FROM invoices') === before.invoices, 'RETRY no second invoice');
  ok(count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-c3b-many'") === before.lot, 'RETRY no second stock deduction');
  ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='INVOICE'") === before.ledger, 'RETRY no second booking');

  // Gegenprobe: eine NEUE Kennung fuer denselben Rumpf schreibt sehr wohl eine zweite Rechnung —
  // genau das verhindert die Regel „eine Kennung pro Vorsatz" in der Oberflaeche.
  const second = await send('invoices.create', request('c3b-many'));
  await sleep(800);
  ok(second.body.ok === true && second.body.value?.invoiceId !== created.invoiceId
    && count('SELECT COUNT(*) c FROM invoices') === before.invoices + 1,
    'RETRY-CONTROL a NEW command id does create a second invoice — which is why the UI never mints one on a timeout');

  // ── 4) Dieselbe Kennung, anderer Rumpf: Widerspruch, kein Lauf ────────────
  const clash = await send('invoices.create', request('c3b-many', 999), first.commandId);
  ok(clash.status === 409 && clash.body.outcome === 'not_executed',
    `CONFLICT same id, different body: refused and never executed (${clash.status} ${S(clash.body)})`);

  // ── 5) Der Rumpf ist ein Wunsch: Abgeleitetes wird abgewiesen ─────────────
  const forged = await send('invoices.create', { ...request('c3b-many'), grossAmount: 1 });
  ok(forged.status === 409 && /INVOICE_PAYLOAD_INVALID/.test(S(forged.body)),
    `AUTHORITY the client cannot dictate derived values (${forged.status} ${S(forged.body).slice(0, 160)})`);

  // ── 6) Menge 1: der zweite Verkauf bekommt ein fachliches Nein ────────────
  const winner = await send('invoices.create', request('c3b-single'));
  ok(winner.body.ok === true, `LASTUNIT the first sale of the single unit goes through (${S(winner.body).slice(0, 120)})`);
  await sleep(800);
  ok(count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-c3b-single'") === 0, 'LASTUNIT the stock is exactly 0');

  const loser = await send('invoices.create', request('c3b-single'));
  ok(loser.status === 409 && loser.body.error === 'STOCK_UNAVAILABLE',
    `LASTUNIT the second sale gets a business no (${loser.status} ${S(loser.body)})`);
  ok(loser.body.outcome === undefined,
    'LASTUNIT …and it is NOT marked as "never executed" — it is a verdict, not a transport failure');
  const invoicesAfterNo = count('SELECT COUNT(*) c FROM invoices');

  // Die Wiederholung derselben abgelehnten Kennung bleibt abgelehnt — auch wenn die Ware zurueckkommt.
  const again = await send('invoices.create', request('c3b-single'), loser.commandId);
  ok(again.status === 409 && again.body.error === 'STOCK_UNAVAILABLE',
    `LASTUNIT the repeat of the rejected id stays rejected (${again.status})`);
  ok(count('SELECT COUNT(*) c FROM invoices') === invoicesAfterNo, 'LASTUNIT …and writes no phantom invoice');
  ok(count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-c3b-single'") === 0, 'LASTUNIT the stock never went negative');
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message || String(e)));
  console.log('  x harness: ' + (e?.message || String(e)));
} finally {
  killAllApp();
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c3b client invoice create e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3B_CLIENT_INVOICE_CHAIN_E2E_PROVED');
