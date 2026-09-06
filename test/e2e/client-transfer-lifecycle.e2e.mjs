// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3G FINAL — der ECHTE Client fuehrt einen Agenten-Transfer zu Ende: verkauft, abgerechnet.
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
//   1. Ein Verkauf UNTER unserem Preis wird abgewiesen und hinterlaesst NICHTS — die bewusste
//      Bestaetigung ist ein neuer Vorsatz mit NEUER Kennung, nicht dieselbe mit erweitertem Rumpf.
//   2. Nach dem Verkauf stimmt der ganze buchhalterische Endzustand: Transfer, Artikelzustand,
//      Abrechnungsbetrag, Forderung im Ledger, Fassung.
//   3. Eine verschluckte Antwort beim Abrechnen bucht nicht zweimal.
//   4. Zwei Clients auf demselben offenen Transfer erzeugen GENAU EINEN wirtschaftlichen Effekt.
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

const RUN = join(os.tmpdir(), 'lataif-c3gf-ui', 'run-' + Date.now());
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
// Ein Klick, der nichts trifft, ist kein Klick: er wird laut, statt still weiterzulaufen. Ein
// stiller Fehlklick sieht spaeter aus wie ein Fehler der Anwendung.
const click = async (c, sel) => {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') {
    const around = await c.ev("return [...document.querySelectorAll('[data-client-area],button')].slice(0,40).map(e=>(e.getAttribute('data-client-area')||e.textContent.trim().slice(0,24))+(e.disabled?'(disabled)':'')).join(' | ');");
    throw new Error(`click ${sel} → ${r}; on screen: ${around}`);
  }
  return r;
};
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seenTxt = '(no screen)';
  try { seenTxt = String(await c.ev('return document.body.innerText.slice(0,400);')).replace(/\s+/g, ' '); } catch {}
  throw new Error(`waitFor ${sel} — screen says: ${seenTxt}`);
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

/** Ein Lieferant, eine Kategorie, drei Artikel, zwei Kunden — mehr brauchen die beiden nicht. */
function seedFixture() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = branch ? branch.id : 'branch-main';
    const now = new Date().toISOString();
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-c3e';
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)) {
      db.prepare(`INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(catId, branchId, 'C3E Watches', 'watch', '#000', now, now);
    }
    db.prepare(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES ('c3g-sup', ?, 'C3G Workshop', 1, ?, ?)`).run(branchId, now, now);
    const product = (id, sku, qty) => {
      db.prepare(
        `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
           purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
           quantity, images, attributes, source_type, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'Pre-Owned','[]', 100,'BHD', 150,'in_stock','VAT_10',0,?, '[]','{}','OWN',?,?)`)
        .run(id, branchId, catId, 'Zenith', 'C3E ' + sku, sku, qty, now, now);
    };
    product('c3g-a', 'C3G-A', 3);
    product('c3g-b', 'C3G-B', 3);
    // Ein Los je Artikel — ohne Bestand gibt es keine Rechnung.
    for (const [pid, qty] of [['c3g-a', 3], ['c3g-b', 3]]) {
      db.prepare(
        `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
         VALUES (?,?,?, 100, ?, ?, 'ACTIVE', ?, ?)`)
        .run('lot-' + pid, branchId, pid, qty, qty, now, now);
    }
    // Und ein offenes Guthaben fuer den Kunden.
    db.prepare(
      `INSERT INTO customer_credits (id, branch_id, customer_id, source_type, source_id, amount, used_amount, status, created_at)
       VALUES ('c3g-credit', ?, 'c3g-cust', 'manual', 'x', 60, 0, 'OPEN', ?)`)
      .run(branchId, now);
    for (const [id, first] of [['c3g-cust', 'Service'], ['c3g-cust2', 'Second']]) {
      db.prepare(
        `INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
           vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
         VALUES (?, ?, ?, 'Client', 'C3G Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
        .run(id, branchId, first, now, now);
    }
    // ── Ein offener Agenten-Transfer, wie ihn ein Primary-Tag hinterlaesst ──
    // Abrechnungsmodell 'split': nur dort greift die Bestaetigung fuer einen Verkauf UNTER
    // unserem Preis, und genau die soll hier gefahren werden.
    db.prepare(
      `INSERT INTO agents (id, branch_id, name, commission_rate, active, customer_id, created_at, updated_at)
       VALUES ('c3gf-agent', ?, 'C3G Agent', 0, 1, 'c3g-cust', ?, ?)`).run(branchId, now, now);
    db.prepare(
      `INSERT INTO agent_transfers (id, branch_id, transfer_number, agent_id, product_id,
         agent_price, commission_rate, commission_type, settlement_model, excess_split_pct,
         status, transferred_at, created_at, updated_at, created_by)
       VALUES ('c3gf-tr', ?, 'TRF-2026-09001', 'c3gf-agent', 'c3g-a',
         500, 0, 'percent', 'split', 50, 'transferred', ?, ?, ?, 'user-owner')`)
      .run(branchId, now, now, now);
    db.prepare("UPDATE products SET stock_status = 'with_agent', source_type = 'AGENT' WHERE id = 'c3g-a'").run();
    // Und ein zweiter, fuer das Rennen.
    db.prepare(
      `INSERT INTO agent_transfers (id, branch_id, transfer_number, agent_id, product_id,
         agent_price, commission_rate, commission_type, settlement_model, excess_split_pct,
         status, transferred_at, created_at, updated_at, created_by)
       VALUES ('c3gf-race', ?, 'TRF-2026-09002', 'c3gf-agent', 'c3g-b',
         400, 0, 'percent', 'full', NULL, 'transferred', ?, ?, ?, 'user-owner')`)
      .run(branchId, now, now, now);
    db.prepare("UPDATE products SET stock_status = 'with_agent', source_type = 'AGENT' WHERE id = 'c3g-b'").run();

    // ── Vorbereitet wie ein Primary-Tag ihn hinterlässt ──────────────────
    // Ein Auftrag, dessen Ware angekommen ist: eine kundenseitige, noch nicht berechnete Zeile
    // auf ARRIVED. Genau das macht `updateStatus(id,'arrived')` am Primary.
    db.prepare(
      `INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
         agreed_price, tax_amount, deposit_amount, deposit_paid, remaining_amount, status, type,
         created_at, updated_at, created_by)
       VALUES ('c3g-ord', ?, 'ORD-2026-09001', 'c3g-cust2', 'Zenith', 'C3G-B',
         300, 0, 0, 0, 300, 'arrived', 'normal', ?, ?, 'user-owner')`)
      .run(branchId, now, now);
    db.prepare(
      `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price,
         line_total, position, tax_scheme, vat_rate, cost_amount, is_customer_facing, status, created_at)
       VALUES ('c3g-ordline', 'c3g-ord', 'c3g-b', 'C3G-B', 1, 300, 300, 1, 'ZERO', 0, 0, 1, 'ARRIVED', ?)`)
      .run(now);

    // Und eine Kommission, die bereits verkauft ist. Der Auszahlungsbetrag steht damit fest —
    // WIE er entsteht (`markSold` + die Modell-SSOT), beweist das Node-Gate; hier geht es um den
    // Auszahlungsweg selbst.
    db.prepare(
      `INSERT INTO consignments (id, branch_id, consignment_number, consignor_id, product_id,
         agreed_price, commission_rate, commission_type, status, agreement_date,
         sale_price, commission_amount, payout_amount, payout_paid_amount, payout_status,
         created_at, updated_at, created_by)
       VALUES ('c3g-con', ?, 'CON-2026-09001', 'c3g-cust', 'c3g-a',
         1000, 20, 'percent', 'sold', ?, 1200, 240, 960, 0, 'pending', ?, ?, 'user-owner')`)
      .run(branchId, now.split('T')[0], now, now);

    return { branchId, catId };
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

/** Eine Zeile ist erst klickbar, wenn die Liste sie WIRKLICH gerendert hat. */
async function waitForRow(c, sel) {
  await waitFor(c, sel, 45000);
  return click(c, sel);
}

console.log('CENTRAL-C3G FINAL — the real client sells and settles an agent transfer\n');
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
  ok(pMarks.verified.length === 4, `INSTANCE the primary artefact is the isolated e2e build (${pMarks.verified.length})`);
  ok(cMarks.verified.length === 4, `INSTANCE the client artefact is a SEPARATE isolated build (${cMarks.verified.length})`);
  assertE2eScope({ appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  const libRs = readFileSync(join(REPO, 'src-tauri/src/lib.rs'), 'utf8');
  ok(/\.plugin\(tauri_plugin_single_instance::init\(/.test(libRs), 'INSTANCE the single-instance guard is untouched');
  ok(!/LATAIF_E2E_SECOND_INSTANCE|allow_second_instance/.test(libRs), 'INSTANCE …and no test switch in the binary');

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

  const token = await (async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: S({ email: OWNER_EMAIL, password: OWNER_PW }),
    });
    return (await r.json()).token;
  })();
  const send = (op, payload, commandId = crypto.randomUUID()) => fetch(`${BASE}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: S({ op, commandId, payload }),
  });
  const TR = 'c3gf-tr';
  const tRow = (cols) => one(`SELECT ${cols} c FROM agent_transfers WHERE id = ?`, [TR]);
  const rev = () => Number(one('SELECT revision c FROM agent_transfers WHERE id = ?', [TR])?.c);
  const ledgerOf = (mod) => count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module = ?", [mod]);

  ok(String(tRow('status')?.c) === 'transferred', 'SETUP the seeded transfer is out on approval');
  ok(String(one("SELECT stock_status c FROM products WHERE id = 'c3g-a'")?.c) === 'with_agent',
    'SETUP …and the item is with the agent');

  // ── 1) Verkauf UNTER unserem Preis: abgewiesen, null Wirkung ────────────
  await click(client, '[data-client-area="transfers"]');
  await waitFor(client, '[data-client-list]', 30000);
  await waitForRow(client, `[data-client-row="${TR}"]`);
  await waitFor(client, '[data-client-edit-transfer]', 30000);
  await click(client, '[data-client-edit-transfer]');
  await waitFor(client, '[data-client-transfer-sold-box]', 30000);
  ok(true, 'READS transfers.get carries what the sale box needs');

  const soldBefore = seen.filter((x) => x.op === 'transfers.mark_sold').length;
  await setVal(client, '[data-client-transfer-saleprice]', '400');
  await click(client, '[data-client-transfer-sold]');
  await waitFor(client, '[data-client-transfer-below]', 60000);
  await sleep(1200);
  ok(String(tRow('status')?.c) === 'transferred', 'BELOW the refusal left the transfer untouched');
  ok(one('SELECT actual_sale_price c FROM agent_transfers WHERE id = ?', [TR])?.c === null,
    'BELOW …no sale price was written');
  ok(ledgerOf('AGENT_TRANSFER_SOLD') === 0, 'BELOW …and nothing was booked');
  ok(String(await text(client, '[data-client-transfer-below]')).includes('below Our Price'),
    'BELOW the client is told why');

  // Die bewusste Bestaetigung: NEUE Kennung, nicht dieselbe mit erweitertem Rumpf.
  await click(client, '[data-client-transfer-sold-anyway]');
  await waitFor(client, '[data-client-transfer-sold-done]', 60000);
  await sleep(1500);
  const soldCalls = seen.filter((x) => x.op === 'transfers.mark_sold');
  ok(soldCalls.length === soldBefore + 2, `BELOW two attempts were sent (${soldCalls.length - soldBefore})`);
  ok(soldCalls[soldBefore].commandId !== soldCalls[soldBefore + 1].commandId,
    'BELOW …with DIFFERENT command ids — the confirmation is a new intent');
  ok(soldCalls[soldBefore].payload.acknowledgeBelowPrice === undefined,
    'BELOW the first attempt carried no confirmation…');
  ok(soldCalls[soldBefore + 1].payload.acknowledgeBelowPrice === true,
    'BELOW …the second one does');
  ok(soldCalls[soldBefore].payload.expectedRevision === soldCalls[soldBefore + 1].payload.expectedRevision,
    'BELOW …and both name the same revision they read');

  // ── 2) Der ganze buchhalterische Endzustand nach dem Verkauf ────────────
  const afterSold = {
    status: String(tRow('status')?.c),
    price: Number(tRow('actual_sale_price')?.c),
    settlement: Number(tRow('settlement_amount')?.c),
    paid: Number(tRow('settlement_paid_amount')?.c ?? 0),
    settleStatus: String(tRow('settlement_status')?.c),
    commission: Number(tRow('commission_amount')?.c ?? 0),
    soldAt: String(tRow('sold_at')?.c || ''),
    invoice: String(tRow('invoice_id')?.c || ''),
    rev: rev(),
  };
  ok(afterSold.status === 'sold', `SOLD the transfer is sold (${afterSold.status})`);
  ok(afterSold.price === 400, `SOLD the sale price is what the human typed (${afterSold.price})`);
  // Unter unserem Preis gibt es keinen Split — wir bekommen den tatsaechlichen Erloes.
  ok(afterSold.settlement === 400,
    `SOLD and the settlement is the actual proceeds, not a split (${afterSold.settlement})`);
  ok(afterSold.paid === 0, 'SOLD nothing is settled yet');
  ok(afterSold.soldAt !== '', 'SOLD the moment is recorded');
  ok(afterSold.invoice === '', 'SOLD this workflow creates NO invoice — that is a deferred action');
  ok(String(one("SELECT stock_status c FROM products WHERE id = 'c3g-a'")?.c) !== 'in_stock',
    'SOLD the item does not come back into stock');
  ok(ledgerOf('AGENT_TRANSFER_SOLD') > 0, 'SOLD the receivable is booked');
  ok(afterSold.rev > 1, `SOLD and the revision moved (${afterSold.rev})`);

  // ── 3) Abrechnen mit verschluckter Antwort ──────────────────────────────
  await waitFor(client, '[data-client-transfer-settle-box]', 45000);
  const settleBefore = seen.filter((x) => x.op === 'transfers.mark_settled').length;
  const ledgerBefore = count("SELECT COUNT(*) c FROM ledger_entries");
  await setVal(client, '[data-client-transfer-settle-amount]', '400');
  await setVal(client, '[data-client-transfer-settle-method]', 'cash');
  swallowOp = 'transfers.mark_settled';
  await click(client, '[data-client-transfer-settle]');
  await waitFor(client, '[data-client-transfer-settle-pending]', 60000);
  ok(swallowed === 1, 'UNKNOWN the answer was swallowed after the primary had booked');
  await sleep(1500);
  const paidAfterSwallow = Number(tRow('settlement_paid_amount')?.c ?? 0);
  ok(Math.abs(paidAfterSwallow - 400) < 0.005, `UNKNOWN the settlement DID happen (${paidAfterSwallow})`);
  const ledgerAfterSwallow = count("SELECT COUNT(*) c FROM ledger_entries");
  ok(String(await text(client, '[data-client-transfer-settle-pending]')).includes('not known'),
    'UNKNOWN …and the client says the outcome is not known');

  await click(client, '[data-client-transfer-settle]');
  await waitFor(client, '[data-client-transfer-settle-done]', 60000);
  await sleep(1500);
  const settleCalls = seen.filter((x) => x.op === 'transfers.mark_settled');
  ok(settleCalls.length === settleBefore + 2, `UNKNOWN two requests were sent (${settleCalls.length - settleBefore})`);
  ok(settleCalls[settleBefore].commandId === settleCalls[settleBefore + 1].commandId,
    'UNKNOWN …with the SAME command id');
  ok(Math.abs(Number(tRow('settlement_paid_amount')?.c ?? 0) - 400) < 0.005,
    'UNKNOWN and it was NOT settled twice');
  ok(count("SELECT COUNT(*) c FROM ledger_entries") === ledgerAfterSwallow,
    'UNKNOWN no second ledger entry appeared');
  ok(ledgerAfterSwallow > ledgerBefore, 'UNKNOWN …the first one did book, so the check has teeth');
  ok(count('SELECT COUNT(*) c FROM agent_settlement_payments WHERE transfer_id = ?', [TR]) <= 1,
    'UNKNOWN and at most one settlement payment row exists');

  // ── 4) Der Endzustand nach dem Abrechnen ────────────────────────────────
  const afterSettle = {
    status: String(tRow('status')?.c),
    settleStatus: String(tRow('settlement_status')?.c),
    paid: Number(tRow('settlement_paid_amount')?.c ?? 0),
    rev: rev(),
  };
  ok(afterSettle.paid === 400, `SETTLE fully settled (${afterSettle.paid})`);
  ok(afterSettle.settleStatus === 'paid', `SETTLE the settlement status is „paid" (${afterSettle.settleStatus})`);
  ok(afterSettle.rev > afterSold.rev, `SETTLE the revision moved again (${afterSold.rev} → ${afterSettle.rev})`);
  // Terminal: ein weiterer bewusster Versuch ist ein Nein.
  const twice = await send('transfers.mark_settled',
    { transferId: TR, amount: 10, method: 'cash', expectedRevision: afterSettle.rev });
  const twiceBody = await twice.json();
  ok(['ALREADY_SETTLED', 'TRANSFER_NOT_SOLD'].includes(twiceBody.error),
    `SETTLE a terminal transfer is not settled again (${S(twiceBody)})`);
  ok(Number(tRow('settlement_paid_amount')?.c ?? 0) === 400, 'SETTLE …and nothing moved');

  // ── 5) Zwei Clients auf demselben offenen Transfer ──────────────────────
  const RACE = 'c3gf-race';
  const raceRev = Number(one('SELECT revision c FROM agent_transfers WHERE id = ?', [RACE])?.c);
  // Eine WIRKUNG, nicht eine ZEILE: ein Verkauf bucht mehrere Legs (Forderung, Erloes, COGS).
  // Gezaehlt wird deshalb, wie viele VORGAENGE gebucht sind.
  const soldEffects = () => count("SELECT COUNT(DISTINCT source_id) c FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD'");
  const ledgerPre = soldEffects();
  const [r1, r2] = await Promise.all([
    send('transfers.mark_sold', { transferId: RACE, salePrice: 600, expectedRevision: raceRev }),
    send('transfers.mark_sold', { transferId: RACE, salePrice: 700, expectedRevision: raceRev }),
  ]);
  const [rb1, rb2] = [await r1.json(), await r2.json()];
  ok([rb1, rb2].filter((b) => b.ok === true).length === 1,
    `RACE exactly one sale wins (${S([rb1.ok, rb2.ok])})`);
  await sleep(1500);
  const racePrice = Number(one('SELECT actual_sale_price c FROM agent_transfers WHERE id = ?', [RACE])?.c);
  ok(racePrice === 600 || racePrice === 700, `RACE the price is the winner's, not a mixture (${racePrice})`);
  ok(soldEffects() === ledgerPre + 1,
    `RACE and exactly ONE economic effect was booked (${ledgerPre} -> ${soldEffects()})`);
  ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND source_id = ? AND reverses_entry_id IS NULL", [RACE]) > 0,
    'RACE …and it belongs to this transfer');
  ok(String(one('SELECT status c FROM agent_transfers WHERE id = ?', [RACE])?.c) === 'sold',
    'RACE the transfer is sold once');

  // Und zwei gleichzeitige Abrechnungen desselben Transfers.
  const settleRev = Number(one('SELECT revision c FROM agent_transfers WHERE id = ?', [RACE])?.c);
  const target = Number(one('SELECT settlement_amount c FROM agent_transfers WHERE id = ?', [RACE])?.c);
  const [s1, s2] = await Promise.all([
    send('transfers.mark_settled', { transferId: RACE, amount: target, method: 'cash', expectedRevision: settleRev }),
    send('transfers.mark_settled', { transferId: RACE, amount: target, method: 'bank', expectedRevision: settleRev }),
  ]);
  const [sb1, sb2] = [await s1.json(), await s2.json()];
  ok([sb1, sb2].filter((b) => b.ok === true).length === 1,
    `RACE-SETTLE exactly one settlement wins (${S([sb1.ok, sb2.ok])})`);
  await sleep(1500);
  ok(Math.abs(Number(one('SELECT settlement_paid_amount c FROM agent_transfers WHERE id = ?', [RACE])?.c ?? 0) - target) < 0.005,
    'RACE-SETTLE and exactly the settlement amount is out, not double');

  // ── 6) Der Client hat immer noch nichts angelegt ────────────────────────
  const after = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  ok(!after.includes('lataif.db') && !after.includes('lataif_sync_server.db') && !after.includes('data-location.json'),
    `DBLESS after selling and settling the client still owns nothing (${after.join(', ') || 'empty'})`);
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

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c3g transfer lifecycle: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3G_TRANSFER_REAL_CLIENT_E2E_PROVED');
