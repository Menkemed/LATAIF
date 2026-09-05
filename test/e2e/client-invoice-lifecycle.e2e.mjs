// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3D — der ECHTE Client aendert und bezahlt eine bestehende Rechnung.
//
// Zwei wirkliche Anwendungen auf einer Maschine, zwei Kennungen, echte Klicks:
//   • der PRIMARY (`lataif.exe`, `com.lataif.app.e2e`, CDP 9223) — Datenbank, Buchhaltung, LAN;
//   • der CLIENT (`lataif-e2e-client.exe`, `com.lataif.app.e2e.client`, CDP 9224) — leeres
//     Kontrollverzeichnis, keine Datenbank, nie eine.
//
// Der Single-Instance-Riegel der Produktion wird nicht umgangen, sondern nicht getroffen: zwei
// Kennungen sind zwei Anwendungen.
//
// Was hier bewiesen wird und kein Node-Test beweisen kann:
//   1. Ein Mensch aendert am zweiten Rechner eine gebuchte Rechnung — Summe, Bestand und Ledger
//      am Primary stimmen danach.
//   2. Eine verschluckte Antwort erzeugt KEINE zweite Wirkung (weder Edit noch Zahlung).
//   3. Ein ALTER Stand wird abgewiesen, nachdem der Primary die Rechnung zwischendurch angefasst
//      hat — und nicht still ueberschrieben.
//   4. Zwei fast gleichzeitige Zahlungen erzeugen keinen doppelten wirtschaftlichen Effekt.
//   5. Der Client bleibt dabei ohne Datenbank.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eBinary, assertE2eClientBinary, assertE2eScope, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
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

const RUN = join(os.tmpdir(), 'lataif-c3d-ui', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
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
  LATAIF_E2E_SYNC_PORT: String(PORT),
});

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const count = (sql, params = []) => Number(dbQ(BIZ_DB, sql, params)[0]?.c ?? -1);
const one = (sql, params = []) => dbQ(BIZ_DB, sql, params)[0];

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

/** Ware mit Losen und ein Kunde — mehr braucht eine Rechnung nicht. */
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
        .run(id, branchId, 'cat-watch', 'Zenith', 'LC ' + sku, sku, qty, now, now);
      db.prepare(
        `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
         VALUES (?,?,?, 100, ?, ?, 'ACTIVE', ?, ?)`)
        .run('lot-' + id, branchId, id, qty, qty, now, now);
    };
    product('lc-many', 'LC-MANY', 5);
    db.prepare(
      `INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
         vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
       VALUES (?,?,?,?,?, 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
      .run('lc-cust', branchId, 'Life', 'Cycle', 'LC Co', now, now);
  } finally { try { db.close(); } catch {} }
}

// ── Der Vermittler: leitet weiter und kann EINE Antwort verschlucken ───────
const seen = [];
let swallowOp = null;
let swallowed = 0;
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
    if (parsed?.op) seen.push({ op: parsed.op, commandId: parsed.commandId, payload: parsed.payload });
    let upstream;
    try {
      upstream = await fetch(BASE + req.url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
        body: req.method === 'GET' ? undefined : body,
      });
    } catch {
      res.writeHead(502, CORS); res.end(S({ ok: false, error: 'PROXY_UPSTREAM' })); return;
    }
    const outBody = Buffer.from(await upstream.arrayBuffer());
    if (swallowOp && parsed?.op === swallowOp) {
      // Der Primary IST fertig — er hat committet und gespeichert. Der Client erfaehrt es nicht.
      swallowOp = null; swallowed += 1;
      res.writeHead(504, { 'Content-Type': 'application/json', ...CORS });
      res.end(S({ ok: false, error: 'BRIDGE_TIMEOUT' }));
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...CORS });
    res.end(outBody);
  });
});

console.log('CENTRAL-C3D — the real client edits and pays an existing invoice\n');
let primary = null, client = null;
try {
  if (!APP_DATA_DIR.includes(IDENT)) throw new Error('refusing to touch a non-e2e AppData');
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe'); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(CLIENT_HOME, { recursive: true, force: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  mkdirSync(join(CLIENT_HOME, 'tmp'), { recursive: true });
  mkdirSync(CLIENT_APPDATA, { recursive: true });

  const pMarks = assertE2eBinary(APP);
  const cMarks = assertE2eClientBinary(CLIENT_APP);
  ok(pMarks.verified.length === 4, `INSTANCE the primary artefact is the isolated e2e build (${pMarks.verified.length} markers)`);
  ok(cMarks.verified.length === 4, `INSTANCE the client artefact is a SEPARATE isolated build (${cMarks.verified.length} markers)`);
  assertE2eScope({ appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  const libRs = readFileSync(join(REPO, 'src-tauri/src/lib.rs'), 'utf8');
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

  // ── Der Client ──────────────────────────────────────────────────────────
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev(`localStorage.setItem('lataif_runtime_mode','client'); localStorage.setItem('lataif_client_server_url', ${S(PROXY_BASE)}); return 1;`);
  await client.ev('location.reload(); return 1;');
  await sleep(3000);
  client.close();
  client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"], [data-client-mode]', 60000);
  if (await exists(client, 'input[type="password"]')) {
    await setVal(client, 'input[type="email"]', OWNER_EMAIL);
    await setVal(client, 'input[type="password"]', OWNER_PW);
    await click(client, '[data-client-signin]');
  }
  await waitFor(client, '[data-client-mode]', 45000);
  ok(true, 'UI the client signs in against the primary');

  // ── Eine Rechnung anlegen (der bekannte C3B-Weg) ────────────────────────
  await click(client, '[data-client-area="new-invoice"]');
  await waitFor(client, '[data-client-invoice-form]', 30000);
  await waitFor(client, '[data-client-invoice-customer] option[value="lc-cust"]', 30000);
  await setVal(client, '[data-client-invoice-customer]', 'lc-cust');
  await setVal(client, '[data-client-invoice-product]', 'lc-many');
  await setVal(client, '[data-client-invoice-qty]', '1');
  await setVal(client, '[data-client-invoice-price]', '150');
  await click(client, '[data-client-invoice-save]');
  await waitFor(client, '[data-client-invoice-done]', 60000);
  await sleep(1200);
  const inv = one("SELECT id, gross_amount, updated_at FROM invoices ORDER BY created_at DESC LIMIT 1");
  ok(!!inv, 'SETUP the invoice exists on the primary');
  ok(Number(one("SELECT qty_remaining c FROM stock_lots WHERE id='lot-lc-many'")?.c) === 4,
    'SETUP one unit is sold');

  // ── Die Rechnung oeffnen und aendern ────────────────────────────────────
  await click(client, '[data-client-area="invoices"]');
  await waitFor(client, '[data-client-list]', 30000);
  await click(client, `[data-client-row="${inv.id}"]`);
  await waitFor(client, '[data-client-open-invoice]', 30000);
  await click(client, '[data-client-open-invoice]');
  await waitFor(client, '[data-client-invoice-detail]', 30000);

  const shownNumber = await text(client, '[data-client-invoice-detail-number]');
  ok(String(shownNumber).startsWith('PINV-'), `DETAIL the client shows the primary's number (${shownNumber})`);
  await setVal(client, '[data-client-invoice-detail-qty]', '2');
  await setVal(client, '[data-client-invoice-detail-reason]', 'Client corrected the quantity');
  const grossBefore = Number(inv.gross_amount);
  await click(client, '[data-client-invoice-detail-save]');
  await sleep(2500);

  const afterEdit = one('SELECT gross_amount, updated_at FROM invoices WHERE id = ?', [inv.id]);
  ok(Number(afterEdit.gross_amount) > grossBefore,
    `EDIT the primary applied the change (${grossBefore} → ${afterEdit.gross_amount})`);
  ok(Number(one("SELECT qty_remaining c FROM stock_lots WHERE id='lot-lc-many'")?.c) === 3,
    'EDIT and the stock followed the edit');
  ok(count('SELECT COUNT(*) c FROM invoice_edits WHERE invoice_id = ?', [inv.id]) === 1,
    'EDIT exactly one edit reason was written');
  ok(String(one('SELECT reason c FROM invoice_edits WHERE invoice_id = ?', [inv.id])?.c) === 'Client corrected the quantity',
    'EDIT …with the words the human typed');

  // ── Verlorene Antwort beim Aendern ──────────────────────────────────────
  await waitFor(client, '[data-client-invoice-detail-reason]', 30000);
  await setVal(client, '[data-client-invoice-detail-qty]', '3');
  await setVal(client, '[data-client-invoice-detail-reason]', 'Once more');
  const editsBefore = seen.filter((s) => s.op === 'invoices.update').length;
  swallowOp = 'invoices.update';
  await click(client, '[data-client-invoice-detail-save]');
  await waitFor(client, '[data-client-invoice-detail-editpending]', 60000);
  ok(swallowed === 1, 'UNKNOWN the answer was swallowed after the primary had committed');
  await sleep(1500);
  const grossAfterSwallow = Number(one('SELECT gross_amount c FROM invoices WHERE id = ?', [inv.id])?.c);
  ok(grossAfterSwallow > Number(afterEdit.gross_amount), 'UNKNOWN the change DID happen on the primary…');
  ok(String(await text(client, '[data-client-invoice-detail-editpending]')).includes('not known'),
    'UNKNOWN …and the client says the outcome is not known');

  await click(client, '[data-client-invoice-detail-save]');
  await sleep(2500);
  const editCalls = seen.filter((s) => s.op === 'invoices.update');
  ok(editCalls.length === editsBefore + 2, `UNKNOWN two requests were sent (${editCalls.length - editsBefore})`);
  ok(editCalls[editsBefore].commandId === editCalls[editsBefore + 1].commandId,
    'UNKNOWN …with the SAME command id');
  ok(Number(one('SELECT gross_amount c FROM invoices WHERE id = ?', [inv.id])?.c) === grossAfterSwallow,
    'UNKNOWN the invoice was NOT changed a second time');
  ok(count('SELECT COUNT(*) c FROM invoice_edits WHERE invoice_id = ?', [inv.id]) === 2,
    'UNKNOWN and exactly one more edit reason exists, not two');
  ok(Number(one("SELECT qty_remaining c FROM stock_lots WHERE id='lot-lc-many'")?.c) === 2,
    'UNKNOWN the stock moved once, not twice');

  // ── Ein ALTER Stand wird abgewiesen ─────────────────────────────────────
  //
  // Der Client hat die Ansicht offen. Der PRIMARY aendert die Rechnung dazwischen — hier ueber
  // seine eigene Oberflaeche, per Zahlung (die `updated_at` bewegt).
  await waitFor(client, '[data-client-invoice-detail-reason]', 30000);
  await primary.ev(`
    const m = await import('/src/stores/invoiceStore.ts').catch(() => null);
    return m ? 'has-module' : 'no-module';
  `).catch(() => null);
  // Der Primary bewegt die Rechnung ueber den ECHTEN Weg: eine Zahlung aus seiner eigenen Sitzung.
  const movedBy = await fetch(`${BASE}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await (async () => {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: S({ email: OWNER_EMAIL, password: OWNER_PW }),
      });
      return (await r.json()).token;
    })()) },
    body: S({ op: 'invoices.record_payment', commandId: crypto.randomUUID(), payload: { invoiceId: inv.id, amount: 1, method: 'cash' } }),
  });
  ok(movedBy.ok, `STALE the primary moved the invoice in between (${movedBy.status})`);
  await sleep(1200);

  const beforeStale = one('SELECT gross_amount, paid_amount, updated_at FROM invoices WHERE id = ?', [inv.id]);
  await setVal(client, '[data-client-invoice-detail-qty]', '1');
  await setVal(client, '[data-client-invoice-detail-reason]', 'Stale edit from an old screen');
  await click(client, '[data-client-invoice-detail-save]');
  await waitFor(client, '[data-client-invoice-detail-editrejected]', 60000);
  const said = await text(client, '[data-client-invoice-detail-editrejected]');
  ok(/INVOICE_CHANGED/.test(String(said)), `STALE the client is told the invoice changed (${said})`);
  await sleep(1200);
  ok(Number(one('SELECT gross_amount c FROM invoices WHERE id = ?', [inv.id])?.c) === Number(beforeStale.gross_amount),
    'STALE nothing was overwritten');
  ok(count('SELECT COUNT(*) c FROM invoice_edits WHERE invoice_id = ?', [inv.id]) === 2,
    'STALE and no third edit reason was written');

  // ── Zahlen ──────────────────────────────────────────────────────────────
  await waitFor(client, '[data-client-invoice-detail-amount]', 30000);
  const openNow = Number(one('SELECT (gross_amount - paid_amount) c FROM invoices WHERE id = ?', [inv.id])?.c);
  const paymentsBefore = count('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?', [inv.id]);
  await setVal(client, '[data-client-invoice-detail-amount]', '10');
  await setVal(client, '[data-client-invoice-detail-method]', 'cash');
  await click(client, '[data-client-invoice-detail-pay]');
  await waitFor(client, '[data-client-invoice-detail-paydone]', 60000);
  await sleep(1500);
  ok(count('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?', [inv.id]) === paymentsBefore + 1,
    'PAY exactly one more payment');
  const paidRow = one('SELECT paid_amount, status FROM invoices WHERE id = ?', [inv.id]);
  ok(Number(paidRow.paid_amount) > 0 && String(paidRow.status) === 'PARTIAL',
    `PAY paid and status come from the primary (${paidRow.paid_amount} / ${paidRow.status})`);
  ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module='PAYMENT'") > 0, 'PAY and it is booked');
  ok(Number(openNow) > 0, 'PAY the invoice had something open before');

  // ── Verlorene Antwort beim Zahlen ───────────────────────────────────────
  const paysBefore = seen.filter((s) => s.op === 'invoices.record_payment').length;
  const paidBeforeSwallow = Number(one('SELECT paid_amount c FROM invoices WHERE id = ?', [inv.id])?.c);
  await setVal(client, '[data-client-invoice-detail-amount]', '5');
  swallowOp = 'invoices.record_payment';
  await click(client, '[data-client-invoice-detail-pay]');
  await waitFor(client, '[data-client-invoice-detail-paypending]', 60000);
  ok(swallowed === 2, 'PAY-UNKNOWN the answer was swallowed after the primary had booked');
  await sleep(1500);
  ok(Number(one('SELECT paid_amount c FROM invoices WHERE id = ?', [inv.id])?.c) === paidBeforeSwallow + 5,
    'PAY-UNKNOWN the payment IS booked on the primary…');
  ok(String(await text(client, '[data-client-invoice-detail-paypending]')).includes('not known'),
    'PAY-UNKNOWN …and the client says the outcome is not known');

  await click(client, '[data-client-invoice-detail-pay]');
  await waitFor(client, '[data-client-invoice-detail-paydone]', 60000);
  await sleep(1500);
  const payCalls = seen.filter((s) => s.op === 'invoices.record_payment');
  ok(payCalls.length === paysBefore + 2, `PAY-UNKNOWN two requests were sent (${payCalls.length - paysBefore})`);
  ok(payCalls[paysBefore].commandId === payCalls[paysBefore + 1].commandId,
    'PAY-UNKNOWN …with the SAME command id');
  ok(Number(one('SELECT paid_amount c FROM invoices WHERE id = ?', [inv.id])?.c) === paidBeforeSwallow + 5,
    'PAY-UNKNOWN and NO second payment was booked');

  // ── Zwei fast gleichzeitige Zahlungen ───────────────────────────────────
  //
  // Beide gehen direkt an die Bruecke — so nah beieinander, wie zwei Menschen es nie schaffen.
  const token = await (async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: S({ email: OWNER_EMAIL, password: OWNER_PW }),
    });
    return (await r.json()).token;
  })();
  const rest = Number(one('SELECT (gross_amount - paid_amount) c FROM invoices WHERE id = ?', [inv.id])?.c);
  const paysBeforeRace = count('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?', [inv.id]);
  const post = (amount) => fetch(`${BASE}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: S({ op: 'invoices.record_payment', commandId: crypto.randomUUID(), payload: { invoiceId: inv.id, amount, method: 'cash' } }),
  });
  const [r1, r2] = await Promise.all([post(rest), post(rest)]);
  ok(r1.ok && r2.ok, `CONCURRENT both payments were answered (${r1.status}/${r2.status})`);
  await sleep(1500);
  ok(count('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?', [inv.id]) === paysBeforeRace + 2,
    'CONCURRENT two real payments');
  ok(String(one('SELECT status c FROM invoices WHERE id = ?', [inv.id])?.c) === 'FINAL',
    'CONCURRENT the invoice is final exactly once');
  ok(count("SELECT COUNT(*) c FROM customer_credits WHERE source_type='overpayment'") === 1,
    'CONCURRENT the second one became store credit — not negative receivable');
  const arNet = Number(one(`SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) c
     FROM ledger_entries WHERE account = 'AR' AND counterparty_id = 'lc-cust'`)?.c ?? 0);
  ok(arNet >= -0.005, `CONCURRENT and the receivable never goes negative (${arNet})`);

  // ── Der Client hat immer noch nichts angelegt ───────────────────────────
  const after = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  ok(!after.includes('lataif.db') && !after.includes('lataif_sync_server.db') && !after.includes('data-location.json'),
    `DBLESS after edits and payments the client still owns nothing (${after.join(', ') || 'empty'})`);
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message || String(e)));
  console.log('  x harness: ' + (e?.message || String(e)));
} finally {
  try { primary?.close(); } catch {}
  try { client?.close(); } catch {}
  try { proxy.close(); } catch {}
  killAll();
  await waitGone('lataif.exe');
  await waitGone('lataif-e2e-client.exe');
  rmSync(CLIENT_HOME, { recursive: true, force: true });
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c3d client invoice lifecycle: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3D_REAL_CLIENT_INVOICE_LIFECYCLE_E2E_PROVED');
