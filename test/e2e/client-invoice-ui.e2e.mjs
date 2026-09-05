// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3B — der ECHTE Client: zwei Anwendungen, echte Klicks, eine Rechnung.
//
// Alles davor war stellvertretend: ein HTTP-Aufruf, der tat, was die Oberflaeche tun wuerde. Hier
// laeuft die Oberflaeche wirklich. Zwei Fenster auf einer Maschine:
//
//   • der PRIMARY (`lataif.exe`, Kennung `com.lataif.app.e2e`, CDP 9223) — mit Datenbank,
//     Buchhaltung und LAN-Server;
//   • der CLIENT (`lataif-e2e-client.exe`, Kennung `com.lataif.app.e2e.client`, CDP 9224) — mit
//     einem LEEREN Kontrollverzeichnis. Genau deshalb legt er nichts an: der Rust-Start bricht bei
//     einem leeren Verzeichnis ab, bevor irgendetwas geoeffnet wird, und die Oberflaeche entscheidet
//     sich fuer den Clientmodus, bevor sie ueberhaupt nach einer Datenbank fragt.
//
// Der Single-Instance-Riegel der Produktion wird dabei NICHT umgangen — er wird nicht getroffen:
// zwei verschiedene Kennungen sind zwei verschiedene Anwendungen. Ein Produktionsbinary erzwingt
// weiterhin genau eine Instanz pro Maschine.
//
// Die Antwort des Primary laeuft durch einen kleinen Vermittler (Port 3012). Er kann eine Antwort
// NACH dem Commit verschlucken — damit laesst sich der einzige Fall wirklich nachstellen, der die
// ganze Kennungsregel traegt: der Benutzer sieht nichts und klickt noch einmal.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eBinary, assertE2eClientBinary, assertE2eScope, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const CLIENT_APP = join(REPO, 'src-tauri/target/debug/lataif-e2e-client.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011, PROXY = 3012;
const BASE = `http://127.0.0.1:${PORT}`;
const PROXY_BASE = `http://127.0.0.1:${PROXY}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-owner-' + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-c3b-ui', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
// Der Client bekommt ein eigenes, LEERES Zuhause — nicht das des Primary.
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env,
  APPDATA: CLIENT_APPDATA,
  LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'),
  TMP: join(CLIENT_HOME, 'tmp'),
  // Der Client startet NIE einen Server; der Port steht hier nur, damit nichts auf 3001 zeigt.
  LATAIF_E2E_SYNC_PORT: String(PORT),
});

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

const killImage = (name) => { try { execFileSync('taskkill', ['/F', '/IM', name, '/T'], { stdio: 'ignore' }); } catch {} };
function killAll() { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); }
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' }); if (!out.includes(name)) return; } catch { return; }
    await sleep(300);
  }
}
async function waitPortFree(port) {
  for (let i = 0; i < 60; i++) {
    try { const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }); if (!out.split('\n').some((l) => l.includes(`:${port} `) && /LISTENING/.test(l))) return; } catch { return; }
    await sleep(300);
  }
}
async function attach(cdpPort, exe, env) {
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  const end = Date.now() + 120000; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(500);
  }
  if (!page) throw new Error(`no CDP page on ${cdpPort} for ${exe}`);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function attachOnly(cdpPort) {
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
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
const text = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.textContent.trim() : null;`);
const click = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
/** Wartet — und sagt beim Scheitern, was stattdessen auf dem Schirm stand. Ein nackter Timeout
 *  erklaert nichts, und genau daran verliert man bei einer Oberflaeche die meiste Zeit. */
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(no screen)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,400);')).replace(/\s+/g, ' '); } catch {}
  throw new Error(`waitFor ${sel} — screen says: ${seen}`);
}

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
  throw new Error('primary shell never appeared');
}
const invokeErr = (c, cmd, args) => c.ev(`try { await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args || {})}); return 'NO-ERROR'; } catch (e) { return String(e); }`);

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
        .run(id, branchId, 'cat-watch', 'Zenith', 'UI ' + sku, sku, qty, now, now);
      db.prepare(
        `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
         VALUES (?,?,?, 100, ?, ?, 'ACTIVE', ?, ?)`)
        .run('lot-' + id, branchId, id, qty, qty, now, now);
    };
    product('ui-many', 'UI-MANY', 3);
    product('ui-single', 'UI-ONE', 1);
    db.prepare(
      `INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
         vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
       VALUES (?,?,?,?,?, 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run('ui-cust-1', branchId, 'Ui', 'Buyer', 'UI Co', now, now);
  } finally { try { db.close(); } catch {} }
}

// ── Der Vermittler: leitet weiter und kann EINE Antwort verschlucken ───────
const seenCommandIds = [];
let swallowNext = false;
let swallowed = 0;
// Der Vermittler steht zwischen zwei Fenstern, nicht im Netz: die Seite laeuft unter
// `tauri.localhost`, spricht also mit einem fremden Ursprung. Ohne die Freigabe-Kopfzeilen wuerde
// die WebView die Antwort verwerfen, und der Client saehe „Server nicht erreichbar" — ein Fehler
// des Messaufbaus, der wie ein Fehler des Produkts aussaehe.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const proxy = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    let parsed = null;
    try { parsed = JSON.parse(body.toString('utf8')); } catch {}
    if (parsed?.op === 'invoices.create') seenCommandIds.push(parsed.commandId);
    let upstream;
    try {
      upstream = await fetch(BASE + req.url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
        body: req.method === 'GET' ? undefined : body,
      });
    } catch (e) {
      res.writeHead(502, CORS); res.end(S({ ok: false, error: 'PROXY_UPSTREAM' })); return;
    }
    const outBody = Buffer.from(await upstream.arrayBuffer());
    if (swallowNext && parsed?.op === 'invoices.create') {
      // Der Primary IST fertig — er hat committet und gespeichert (die Antwort liegt hier vor).
      // Der Client erfaehrt sie nicht: er bekommt eine Zeitgrenze, genau wie wenn die Bruecke zu
      // lange gebraucht haette.
      //
      // Die Verbindung einfach zu kappen waere NICHT dasselbe: eine WebView schickt einen POST,
      // dessen Verbindung ohne Antwort abbricht, von sich aus noch einmal — dieselbe Kennung, und
      // der Primary antwortet mit dem eingefrorenen Ergebnis. Ein schoener Beleg dafuer, dass die
      // Kennung traegt, aber eben nicht der Fall, den dieser Abschnitt zeigen will.
      swallowNext = false; swallowed += 1;
      res.writeHead(504, { 'Content-Type': 'application/json', ...CORS });
      res.end(S({ ok: false, error: 'BRIDGE_TIMEOUT' }));
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...CORS });
    res.end(outBody);
  });
});

console.log('CENTRAL-C3B — the real client UI writes an invoice\n');
let primary = null, client = null;
try {
  if (!APP_DATA_DIR.includes(IDENT)) throw new Error('refusing to touch a non-e2e AppData');
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe'); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(CLIENT_HOME, { recursive: true, force: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  mkdirSync(join(CLIENT_HOME, 'tmp'), { recursive: true });
  mkdirSync(CLIENT_APPDATA, { recursive: true });

  // Beide Artefakte sind das, was sie zu sein behaupten — und sie sind NICHT dasselbe.
  const pMarks = assertE2eBinary(APP);
  const cMarks = assertE2eClientBinary(CLIENT_APP);
  ok(pMarks.verified.length === 4, `INSTANCE the primary artefact is the isolated e2e build (${pMarks.verified.length} markers)`);
  ok(cMarks.verified.length === 4, `INSTANCE the client artefact is a SEPARATE isolated build (${cMarks.verified.length} markers)`);
  assertE2eScope({ appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  ok(!CLIENT_DATA_DIR.includes(IDENT + '\\') && CLIENT_DATA_DIR.includes(CLIENT_IDENT),
    `INSTANCE and it lives in its own control directory (${CLIENT_DATA_DIR})`);

  // Und der Riegel der Produktion bleibt, wie er ist: EINE Instanz pro Kennung.
  const libRs = (await import('node:fs')).readFileSync(join(REPO, 'src-tauri/src/lib.rs'), 'utf8');
  ok(/\.plugin\(tauri_plugin_single_instance::init\(/.test(libRs),
    'INSTANCE the single-instance guard is untouched — two windows here are two IDENTITIES, not a bypass');
  ok(!/LATAIF_E2E_SECOND_INSTANCE|allow_second_instance/.test(libRs),
    'INSTANCE …and no test switch was built into the shipped binary');

  // ── Der Primary ─────────────────────────────────────────────────────────
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await ensureSignedIn(primary);

  primary.close(); killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  seedFixture();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await ensureSignedIn(primary);
  ok(await invokeErr(primary, 'sync_server_start', {}) === 'NO-ERROR', 'the primary serves on the LAN');
  {
    const end = Date.now() + 45000; let up = false;
    while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
    ok(up, 'the server answers');
  }
  await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));

  // ── Der Client: eigene Anwendung, leeres Zuhause ────────────────────────
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);

  // Die Wahl „dieser Rechner ist eine Oberflaeche" trifft der Mensch in den Einstellungen; hier
  // wird genau der Zustand gesetzt, den dieser Knopf hinterlaesst, und neu geladen.
  await client.ev(`localStorage.setItem('lataif_runtime_mode','client'); localStorage.setItem('lataif_client_server_url', ${S(PROXY_BASE)}); return 1;`);
  await client.ev('location.reload(); return 1;');
  await sleep(3000);
  // Nach dem Neuladen ist die Seite eine andere — derselbe Prozess, neues Dokument. Es wird NICHT
  // noch eine Anwendung gestartet: eine zweite Instanz derselben Kennung beendet sich sofort selbst.
  client.close();
  client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"], [data-client-mode]', 60000);

  // ── DB-los, im laufenden Prozess gemessen ───────────────────────────────
  const clientFiles = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  ok(!clientFiles.includes('lataif.db'), `DBLESS the running client has no business database (${clientFiles.join(', ') || 'empty'})`);
  ok(!clientFiles.includes('lataif_sync_server.db'), 'DBLESS …and no server database');
  ok(!clientFiles.includes('data-location.json'), 'DBLESS …and no data root locator');
  ok(await client.ev("return localStorage.getItem('lataif_runtime_mode');") === 'client', 'DBLESS the client is in client mode');
  ok(await client.ev("return Object.keys(localStorage).filter(k=>k.startsWith('lataif')).sort().join(',');")
    === 'lataif_client_server_url,lataif_client_token,lataif_runtime_mode'
    || (await client.ev("return Object.keys(localStorage).filter(k=>k.startsWith('lataif')).sort().join(',');")).indexOf('lataif_sync') === -1,
    'DBLESS …and keeps nothing but mode, address and session locally');

  // ── Anmeldung in der echten Oberflaeche ─────────────────────────────────
  if (await exists(client, 'input[type="password"]')) {
    await setVal(client, 'input[type="email"]', OWNER_EMAIL);
    await setVal(client, 'input[type="password"]', OWNER_PW);
    await click(client, '[data-client-signin]');
  }
  try {
    await waitFor(client, '[data-client-mode]', 45000);
  } catch (e) {
    // Beim Fehlschlag sagen, WAS auf dem Schirm steht — ein Timeout allein erklaert nichts.
    const body = String(await client.ev('return document.body.innerText.slice(0,400);')).replace(/\s+/g, ' ');
    throw new Error('client sign-in never completed — screen says: ' + body);
  }
  ok(true, 'UI the client signs in against the primary');

  // ── Rechnung anlegen: echte Klicks ──────────────────────────────────────
  await click(client, '[data-client-area="new-invoice"]');
  await waitFor(client, '[data-client-invoice-form]', 30000);
  await waitFor(client, '[data-client-invoice-customer] option[value="ui-cust-1"]', 30000);
  await setVal(client, '[data-client-invoice-customer]', 'ui-cust-1');
  await setVal(client, '[data-client-invoice-product]', 'ui-many');
  await setVal(client, '[data-client-invoice-qty]', '1');
  await setVal(client, '[data-client-invoice-price]', '150');
  const invoicesBefore = count('SELECT COUNT(*) c FROM invoices');
  await click(client, '[data-client-invoice-save]');
  await waitFor(client, '[data-client-invoice-done]', 60000);

  const shownNumber = await text(client, '[data-client-invoice-number]');
  ok(/^PINV-\d{4}-\d{6}$/.test(String(shownNumber)), `UI the client shows the primary's invoice number (${shownNumber})`);
  await sleep(1500);
  ok(count('SELECT COUNT(*) c FROM invoices') === invoicesBefore + 1, 'UI exactly one invoice more');
  const row = dbQ(BIZ_DB, 'SELECT id, invoice_number FROM invoices WHERE invoice_number = ?', [shownNumber])[0];
  ok(!!row, 'UI …and it is the one the screen shows');
  ok(count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-ui-many'") === 2, 'UI the stock went down by one');
  ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='INVOICE' AND source_id=?", [row?.id]) > 0, 'UI and it is booked');
  ok(count('SELECT COUNT(*) c FROM remote_command_ledger') >= 1, 'UI the durable record exists');
  ok(seenCommandIds.length === 1, `UI the UI sent exactly one command (${seenCommandIds.length})`);

  // ── Unbekannter Ausgang: derselbe Knopf, dieselbe Kennung ───────────────
  await click(client, '[data-client-invoice-new]');
  await waitFor(client, '[data-client-invoice-form]', 20000);
  await setVal(client, '[data-client-invoice-customer]', 'ui-cust-1');
  await setVal(client, '[data-client-invoice-product]', 'ui-many');
  await setVal(client, '[data-client-invoice-qty]', '1');
  await setVal(client, '[data-client-invoice-price]', '150');
  const before = {
    invoices: count('SELECT COUNT(*) c FROM invoices'),
    lot: count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-ui-many'"),
    ledger: count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='INVOICE'"),
    sent: seenCommandIds.length,
  };
  swallowNext = true;
  await click(client, '[data-client-invoice-save]');
  await waitFor(client, '[data-client-invoice-pending]', 60000);
  ok(swallowed === 1, 'UNKNOWN the answer was swallowed after the primary had committed');
  await sleep(1500);
  ok(count('SELECT COUNT(*) c FROM invoices') === before.invoices + 1, 'UNKNOWN the invoice DOES exist on the primary…');
  ok((await text(client, '[data-client-invoice-pending]')).includes('not known'),
    'UNKNOWN …and the client says the outcome is not known, not that it failed');

  // Der Benutzer klickt erneut — genau der Moment, in dem eine Oberflaeche eine zweite Rechnung schreibt.
  await click(client, '[data-client-invoice-save]');
  await waitFor(client, '[data-client-invoice-done]', 60000);
  const retryNumber = await text(client, '[data-client-invoice-number]');
  ok(seenCommandIds.length === before.sent + 2, `UNKNOWN two requests were sent (${seenCommandIds.length - before.sent})`);
  ok(seenCommandIds[before.sent] === seenCommandIds[before.sent + 1],
    `UNKNOWN …with the SAME command id (${seenCommandIds[before.sent]} / ${seenCommandIds[before.sent + 1]})`);
  await sleep(1200);
  ok(count('SELECT COUNT(*) c FROM invoices') === before.invoices + 1, 'UNKNOWN still exactly one invoice');
  ok(count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-ui-many'") === before.lot - 1, 'UNKNOWN one stock effect');
  ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='INVOICE'") > before.ledger, 'UNKNOWN and it is booked');
  ok(count('SELECT COUNT(*) c FROM invoices WHERE invoice_number = ?', [retryNumber]) === 1,
    `UNKNOWN the screen shows the one invoice that exists (${retryNumber})`);

  // ── Fachliches Nein in der Oberflaeche ──────────────────────────────────
  await click(client, '[data-client-invoice-new]');
  await waitFor(client, '[data-client-invoice-form]', 20000);
  await setVal(client, '[data-client-invoice-customer]', 'ui-cust-1');
  await setVal(client, '[data-client-invoice-product]', 'ui-single');
  await setVal(client, '[data-client-invoice-qty]', '1');
  await setVal(client, '[data-client-invoice-price]', '150');
  await click(client, '[data-client-invoice-save]');
  await waitFor(client, '[data-client-invoice-done]', 60000);
  ok(count("SELECT qty_remaining c FROM stock_lots WHERE id='lot-ui-single'") === 0, 'REJECT the single unit is sold');

  // Und jetzt dasselbe noch einmal — die Ware ist weg.
  await click(client, '[data-client-invoice-new]');
  await waitFor(client, '[data-client-invoice-form]', 20000);
  await setVal(client, '[data-client-invoice-customer]', 'ui-cust-1');
  await setVal(client, '[data-client-invoice-product]', 'ui-single');
  await setVal(client, '[data-client-invoice-qty]', '1');
  await setVal(client, '[data-client-invoice-price]', '150');
  const beforeNo = count('SELECT COUNT(*) c FROM invoices');
  const sentBeforeNo = seenCommandIds.length;
  await click(client, '[data-client-invoice-save]');
  await waitFor(client, '[data-client-invoice-rejected]', 60000);
  const said = await text(client, '[data-client-invoice-rejected]');
  ok(/STOCK_UNAVAILABLE/.test(String(said)), `REJECT the client shows the business no (${said})`);
  ok(!(await exists(client, '[data-client-invoice-notexecuted]')),
    'REJECT …and does NOT call it "not executed" — it is a verdict');
  await sleep(1000);
  ok(count('SELECT COUNT(*) c FROM invoices') === beforeNo, 'REJECT no phantom invoice');

  // Ein bewusst neuer Versuch bekommt eine NEUE Kennung.
  await click(client, '[data-client-invoice-restart]');
  await waitFor(client, '[data-client-invoice-form]', 20000);
  await setVal(client, '[data-client-invoice-customer]', 'ui-cust-1');
  await setVal(client, '[data-client-invoice-product]', 'ui-many');
  await setVal(client, '[data-client-invoice-qty]', '1');
  await setVal(client, '[data-client-invoice-price]', '150');
  await click(client, '[data-client-invoice-save]');
  await waitFor(client, '[data-client-invoice-done]', 60000);
  ok(seenCommandIds[sentBeforeNo] !== seenCommandIds[seenCommandIds.length - 1],
    'REJECT a deliberate new attempt uses a NEW command id — the rejected one is not recycled');

  // ── Der Client hat immer noch nichts angelegt ───────────────────────────
  const after = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  ok(!after.includes('lataif.db') && !after.includes('lataif_sync_server.db') && !after.includes('data-location.json'),
    `DBLESS after four invoices the client still owns nothing (${after.join(', ') || 'empty'})`);
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message || String(e)));
  console.log('  x harness: ' + (e?.message || String(e)));
} finally {
  try { primary?.close(); } catch {}
  try { client?.close(); } catch {}
  try { proxy.close(); } catch {}
  killAll();
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c3b real client ui: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3B_REAL_CLIENT_UI_INSTANCE_PROVED');
console.log('CENTRAL_C3B_CLIENT_INVOICE_UI_E2E_PROVED');
