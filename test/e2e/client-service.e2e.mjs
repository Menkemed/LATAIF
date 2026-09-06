// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3F — der ECHTE Client nimmt eine Reparatur auf und gibt Ware auf Kommission.
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
//   1. Ein Mensch nimmt am zweiten Rechner eine Reparatur auf und aendert sie.
//   2. Er gibt ein Stueck Ware auf Kommission hinaus und nimmt es zurueck — der Artikelzustand
//      am Primary folgt exakt (in_stock/OWN -> with_agent/AGENT -> in_stock/OWN).
//      „Transfer" ist hier KEIN Filialtransfer: es gibt im Haus keinen.
//   3. Eine verschluckte Antwort erzeugt KEINEN zweiten Beleg und keine zweite Zustandswirkung.
//   4. Zwei Clients um dasselbe letzte Stueck: genau einer bekommt es.
//   5. Ein ALTER Stand wird abgewiesen. Der Client bleibt dabei ohne Datenbank.
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

const RUN = join(os.tmpdir(), 'lataif-c3f-ui', 'run-' + Date.now());
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
      VALUES ('c3f-sup', ?, 'C3F Workshop', 1, ?, ?)`).run(branchId, now, now);
    const product = (id, sku, qty) => {
      db.prepare(
        `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
           purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
           quantity, images, attributes, source_type, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'Pre-Owned','[]', 100,'BHD', 150,'in_stock','VAT_10',0,?, '[]','{}','OWN',?,?)`)
        .run(id, branchId, catId, 'Zenith', 'C3E ' + sku, sku, qty, now, now);
    };
    product('c3f-a', 'C3F-A', 1);
    product('c3f-b', 'C3F-B', 1);
    product('c3f-c', 'C3F-C', 1);
    for (const [id, first] of [['c3f-cust', 'Service'], ['c3f-cust2', 'Second']]) {
      db.prepare(
        `INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
           vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
         VALUES (?, ?, ?, 'Client', 'C3F Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
        .run(id, branchId, first, now, now);
    }
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

console.log('CENTRAL-C3F — the real client books repairs and sends items out on approval\n');
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
  const post = (op, payload) => fetch(`${BASE}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: S({ op, commandId: crypto.randomUUID(), payload }),
  });

  // ── 1) Reparatur aufnehmen ──────────────────────────────────────────────
  await click(client, '[data-client-area="new-repair"]');
  await waitFor(client, '[data-client-repair-form]', 30000);
  await waitFor(client, '[data-client-field="repair.customerId"] option[value="c3f-cust"]', 30000);
  ok(true, 'READS customers.list reaches the repair form');
  await waitFor(client, '[data-client-field="repair.workshopSupplierId"] option[value="c3f-sup"]', 30000);
  ok(true, 'READS …and suppliers.list feeds the workshop picker');

  await setVal(client, '[data-client-field="repair.customerId"]', 'c3f-cust');
  await setVal(client, '[data-client-field="repair.itemBrand"]', 'Rolex');
  await setVal(client, '[data-client-field="repair.itemModel"]', 'Submariner');
  await setVal(client, '[data-client-field="repair.issueDescription"]', 'Krone klemmt');
  await setVal(client, '[data-client-field="repair.estimatedCost"]', '40');
  await setVal(client, '[data-client-field="repair.chargeToCustomer"]', '100');
  await click(client, '[data-client-repair-save]');
  await waitFor(client, '[data-client-repair-done]', 60000);
  await sleep(1500);

  const rep = one('SELECT id, repair_number, status, charge_to_customer, margin, voucher_code, revision FROM repairs ORDER BY created_at DESC LIMIT 1');
  ok(!!rep, 'REPAIR the repair exists on the primary');
  ok(String(await text(client, '[data-client-repair-number]')) === String(rep.repair_number),
    `REPAIR the client shows the primary's number (${rep.repair_number})`);
  ok(String(rep.status) === 'received', `REPAIR the primary set the initial status (${rep.status})`);
  ok(String(rep.voucher_code || '').length === 8, 'REPAIR …and the voucher code');
  ok(rep.margin === null,
    `REPAIR the margin is NOT derived at intake — the house does not do it either (${rep.margin})`);

  // ── 2) Reparatur aendern ────────────────────────────────────────────────
  await click(client, '[data-client-repair-back]');
  await waitFor(client, '[data-client-list]', 30000);
  await waitForRow(client, `[data-client-row="${rep.id}"]`);
  await waitFor(client, '[data-client-edit-repair]', 30000);
  await click(client, '[data-client-edit-repair]');
  await waitFor(client, '[data-client-repair-form]', 30000);
  await setVal(client, '[data-client-field="repair.chargeToCustomer"]', '150');
  await setVal(client, '[data-client-field="repair.diagnosis"]', 'Krone ersetzt');
  await click(client, '[data-client-repair-save]');
  await waitFor(client, '[data-client-repair-done]', 60000);
  await sleep(1500);
  const repAfter = one('SELECT charge_to_customer, margin, diagnosis, revision FROM repairs WHERE id = ?', [rep.id]);
  ok(Number(repAfter.charge_to_customer) === 150, `REPAIR-EDIT the new charge stands (${repAfter.charge_to_customer})`);
  ok(Number(repAfter.margin) === 110,
    `REPAIR-EDIT …and on the edit it IS derived, by the primary (150 − 40 = ${repAfter.margin})`);
  ok(String(repAfter.diagnosis) === 'Krone ersetzt', 'REPAIR-EDIT …with the words the human typed');
  ok(Number(repAfter.revision) > Number(rep.revision), 'REPAIR-EDIT the revision moved');

  const staleRepair = await post('repairs.update', { id: rep.id, expectedRevision: Number(rep.revision), chargeToCustomer: 1 });
  const staleBody = await staleRepair.json();
  ok(staleBody.error === 'RECORD_CHANGED', `REPAIR-STALE an old revision is refused (${S(staleBody)})`);
  ok(Number(one('SELECT charge_to_customer c FROM repairs WHERE id = ?', [rep.id])?.c) === 150,
    'REPAIR-STALE and nothing was overwritten');

  // ── 3) Ware auf Kommission hinaus ───────────────────────────────────────
  await click(client, '[data-client-repair-back]');
  await waitFor(client, '[data-client-list]', 30000);
  await click(client, '[data-client-area="new-transfer"]');
  await waitFor(client, '[data-client-transfer-form]', 30000);
  await waitFor(client, '[data-client-field="transfer.productId"] option[value="c3f-a"]', 30000);
  ok(true, 'READS products.list feeds the item picker');
  ok(String(one("SELECT stock_status c FROM products WHERE id = 'c3f-a'")?.c) === 'in_stock',
    'STOCK before: the item is in stock');

  await setVal(client, '[data-client-field="transfer.customerId"]', 'c3f-cust');
  await setVal(client, '[data-client-field="transfer.productId"]', 'c3f-a');
  await setVal(client, '[data-client-field="transfer.agentPrice"]', '500');
  await click(client, '[data-client-transfer-save]');
  await waitFor(client, '[data-client-transfer-done]', 60000);
  await sleep(1500);

  const tr = one('SELECT id, transfer_number, agent_id, product_id, status, agent_price, revision FROM agent_transfers ORDER BY transferred_at DESC LIMIT 1');
  ok(!!tr, 'TRANSFER the transfer exists on the primary');
  ok(/^TRF-\d{4}-\d{5}$/.test(String(tr.transfer_number)), `TRANSFER the number came from the counter (${tr.transfer_number})`);
  ok(String(tr.status) === 'transferred', 'TRANSFER it is out on approval');
  ok(String(one("SELECT stock_status c FROM products WHERE id = 'c3f-a'")?.c) === 'with_agent',
    'STOCK after: the item is with the agent…');
  ok(String(one("SELECT source_type c FROM products WHERE id = 'c3f-a'")?.c) === 'AGENT',
    'STOCK …and no longer ours');
  ok(Number(one("SELECT quantity c FROM products WHERE id = 'c3f-a'")?.c) === 1,
    'STOCK the QUANTITY is untouched — an approval moves a state, not an amount');
  ok(count('SELECT COUNT(*) c FROM agents WHERE customer_id = ?', ['c3f-cust']) === 1,
    'TRANSFER the primary found/created the agent — the client named none');

  // ── 4) Verlorene Antwort beim Hinausgeben ───────────────────────────────
  await click(client, '[data-client-transfer-again]');
  await waitFor(client, '[data-client-transfer-form]', 30000);
  await waitFor(client, '[data-client-field="transfer.productId"] option[value="c3f-b"]', 30000);
  await setVal(client, '[data-client-field="transfer.customerId"]', 'c3f-cust2');
  await setVal(client, '[data-client-field="transfer.productId"]', 'c3f-b');
  await setVal(client, '[data-client-field="transfer.agentPrice"]', '300');
  const before = seen.filter((x) => x.op === 'transfers.create').length;
  const seqBefore = Number(one("SELECT next_number c FROM document_sequences WHERE doc_type = 'TRF'")?.c);
  swallowOp = 'transfers.create';
  await click(client, '[data-client-transfer-save]');
  await waitFor(client, '[data-client-pending="transfer"]', 60000);
  ok(swallowed === 1, 'UNKNOWN the answer was swallowed after the primary had committed');
  await sleep(1500);
  ok(count('SELECT COUNT(*) c FROM agent_transfers') === 2, 'UNKNOWN the transfer DID happen on the primary…');
  ok(String(await text(client, '[data-client-pending="transfer"]')).includes('not known'),
    'UNKNOWN …and the client says the outcome is not known');

  await click(client, '[data-client-transfer-save]');
  await waitFor(client, '[data-client-transfer-done]', 60000);
  await sleep(1500);
  const calls = seen.filter((x) => x.op === 'transfers.create');
  ok(calls.length === before + 2, `UNKNOWN two requests were sent (${calls.length - before})`);
  ok(calls[before].commandId === calls[before + 1].commandId, 'UNKNOWN …with the SAME command id');
  ok(count('SELECT COUNT(*) c FROM agent_transfers') === 2, 'UNKNOWN no second transfer');
  ok(Number(one("SELECT next_number c FROM document_sequences WHERE doc_type = 'TRF'")?.c) === seqBefore + 1,
    'UNKNOWN and exactly ONE number was consumed, not two');
  ok(String(one("SELECT stock_status c FROM products WHERE id = 'c3f-b'")?.c) === 'with_agent',
    'UNKNOWN the item went out once, not twice');
  ok(String(await text(client, '[data-client-transfer-replayed]')).includes('already run'),
    'UNKNOWN the client is told it was the replay');

  // ── 5) Aendern und zurueckholen ─────────────────────────────────────────
  await click(client, '[data-client-transfer-list]');
  await waitFor(client, '[data-client-list]', 30000);
  await waitForRow(client, `[data-client-row="${tr.id}"]`);
  await waitFor(client, '[data-client-edit-transfer]', 30000);
  await click(client, '[data-client-edit-transfer]');
  await waitFor(client, '[data-client-transfer-form]', 30000);
  await setVal(client, '[data-client-field="transfer.agentPrice"]', '650');
  await click(client, '[data-client-transfer-save]');
  await waitFor(client, '[data-client-transfer-done]', 60000);
  await sleep(1500);
  const trAfter = one('SELECT agent_price, revision FROM agent_transfers WHERE id = ?', [tr.id]);
  ok(Number(trAfter.agent_price) === 650, `TRANSFER-EDIT the new price stands (${trAfter.agent_price})`);
  ok(Number(trAfter.revision) > Number(tr.revision), 'TRANSFER-EDIT the revision moved');

  await click(client, '[data-client-transfer-list]');
  await waitFor(client, '[data-client-list]', 30000);
  await waitForRow(client, `[data-client-row="${tr.id}"]`);
  await waitFor(client, '[data-client-edit-transfer]', 30000);
  await click(client, '[data-client-edit-transfer]');
  await waitFor(client, '[data-client-transfer-return]', 30000);
  await click(client, '[data-client-transfer-return]');
  await waitFor(client, '[data-client-transfer-returned]', 60000);
  await sleep(1500);
  ok(String(one('SELECT status c FROM agent_transfers WHERE id = ?', [tr.id])?.c) === 'returned',
    'RETURN the transfer is back');
  ok(String(one("SELECT stock_status c FROM products WHERE id = 'c3f-a'")?.c) === 'in_stock',
    'STOCK back: the item is in stock again…');
  ok(String(one("SELECT source_type c FROM products WHERE id = 'c3f-a'")?.c) === 'OWN',
    'STOCK …and ours again');
  ok(Number(one("SELECT quantity c FROM products WHERE id = 'c3f-a'")?.c) === 1,
    'STOCK and the quantity never moved at all');

  // Eine zweite Rueckgabe ist ein Nein, kein stilles Ja.
  const freshRev = Number(one('SELECT revision c FROM agent_transfers WHERE id = ?', [tr.id])?.c);
  const twice = await post('transfers.mark_returned', { id: tr.id, expectedRevision: freshRev });
  const twiceBody = await twice.json();
  ok(twiceBody.error === 'TRANSFER_ALREADY_RETURNED', `RETURN a second return is refused (${S(twiceBody)})`);

  // ── 6) Zwei Clients um dasselbe letzte Stueck ───────────────────────────
  const outBefore = count('SELECT COUNT(*) c FROM agent_transfers');
  const body = { customerId: 'c3f-cust', productId: 'c3f-c', agentPrice: 200 };
  const [r1, r2] = await Promise.all([post('transfers.create', body), post('transfers.create', { ...body, customerId: 'c3f-cust2' })]);
  const [b1, b2] = [await r1.json(), await r2.json()];
  const winners = [b1, b2].filter((b) => b.ok === true).length;
  ok(winners === 1, `RACE exactly one gets the item (${S([b1.ok, b2.ok])})`);
  ok(count('SELECT COUNT(*) c FROM agent_transfers') === outBefore + 1, 'RACE exactly one transfer was created');
  ok(Number(one("SELECT quantity c FROM products WHERE id = 'c3f-c'")?.c) === 1,
    'RACE the quantity never went negative');
  ok(String(one("SELECT stock_status c FROM products WHERE id = 'c3f-c'")?.c) === 'with_agent',
    'RACE the item is out exactly once');

  // ── 7) Was NICHT freigegeben ist, erreicht nichts ───────────────────────
  for (const op of ['transfers.mark_sold', 'transfers.delete', 'repairs.update_status', 'repairs.delete']) {
    const r = await post(op, {});
    const b = await r.json().catch(() => ({}));
    ok(!r.ok || b.ok === false, `CLOSED ${op} is refused (${r.status})`);
  }

  // ── 8) Der Client hat immer noch nichts angelegt ────────────────────────
  const after = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  ok(!after.includes('lataif.db') && !after.includes('lataif_sync_server.db') && !after.includes('data-location.json'),
    `DBLESS after repairs and approvals the client still owns nothing (${after.join(', ') || 'empty'})`);
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

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c3f client repairs and approvals: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3F_REAL_CLIENT_REPAIR_TRANSFER_E2E_PROVED');
