// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3H — der ECHTE Client fuehrt die fuenf verbliebenen Geschaeftsablaeufe zu Ende.
//
// Zwei wirkliche Anwendungen auf einer Maschine, zwei Kennungen, echte Klicks:
//   • der PRIMARY (`lataif.exe`, `com.lataif.app.e2e`, CDP 9223) — Datenbank, Buchhaltung, LAN;
//   • der CLIENT (`lataif-e2e-client.exe`, `com.lataif.app.e2e.client`, CDP 9224) — leeres
//     Kontrollverzeichnis, keine Datenbank, nie eine.
//
// Der Single-Instance-Riegel der Produktion wird nicht umgangen, sondern nicht getroffen: zwei
// Kennungen sind zwei Anwendungen.
//
// Fuenf echte Zwei-Instanzen-Flows mit echten Klicks, nicht fuenf Beteuerungen:
//   1. Rueckgabe mit Gutschrift — Bestand, Steuer, Gutschrift, Geld.
//   2. Auftrag: Status → Anzahlung → Umwandlung in eine Rechnung. Das war die Sackgasse aus C3G.
//   3. Kommission: Verkauf → Auszahlung. Ohne Zwischenschritt am Primary.
//   4. Reparatur: Arbeitszeile → Zustandsmaschine → Rechnung.
//   5. Agenten-Transfer → Rechnung.
//
// Zwei davon mit VERSCHLUCKTER Antwort (Rueckgabe, Auftragsanzahlung): dieselbe Kennung, kein
// zweiter Beleg, kein zweites Geld. Dazu auf Befehlsebene die Rennen, die keine Oberflaeche
// erzeugen kann: Ueberrueckgabe, doppelte Anzahlung, doppelter Verkauf, doppelte
// Reparaturrechnung, doppelte Transfer-Umwandlung, alter Stand.
//
// Und durchgehend: der Client hat keine Datenbank, keinen Ausgangskorb, kein Eigenes.
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

const RUN = join(os.tmpdir(), 'lataif-c3h-ui', 'run-' + Date.now());
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


/**
 * Was C3H zusätzlich braucht — alles so, wie ein Primary-Tag es hinterlässt:
 *
 *   • eine BEZAHLTE Rechnung über zwei Stück (die Rückgabe braucht einen Kunden mit Überschuss,
 *     sonst kann gar kein Bargeld zurückfließen),
 *   • eine zweite, für das Rennen um das letzte rückgebbare Stück,
 *   • zwei Aufträge mit angekommener, kundenseitiger, noch nicht berechneter Position,
 *   • zwei aktive Kommissionen,
 *   • zwei Reparaturen (eine offen, eine fertig mit Kundenpreis),
 *   • zwei verkaufte Agenten-Transfers, die auf ihre Rechnung warten.
 */
function seedC3h() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-c3e';
    const now = new Date().toISOString();
    const today = now.split('T')[0];

    const product = (id, sku, qty, cost = 100) => {
      db.prepare(
        `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
           purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
           quantity, images, attributes, source_type, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'Pre-Owned','[]', ?,'BHD', 300,'in_stock','VAT_10',0,?, '[]','{}','OWN',?,?)`)
        .run(id, branchId, catId, 'Zenith', 'C3H ' + sku, sku, cost, qty, now, now);
      db.prepare(
        `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
         VALUES (?,?,?, ?, ?, ?, 'ACTIVE', ?, ?)`)
        .run('lot-' + id, branchId, id, cost, qty, qty, now, now);
    };
    for (const [id, sku] of [['c3h-p1', 'C3H-1'], ['c3h-p2', 'C3H-2'], ['c3h-p3', 'C3H-3'],
      ['c3h-p4', 'C3H-4'], ['c3h-p5', 'C3H-5'], ['c3h-p6', 'C3H-6'], ['c3h-p7', 'C3H-7'],
      ['c3h-p8', 'C3H-8']]) {
      product(id, sku, 5);
    }

    // ── Zwei BEZAHLTE Rechnungen. Bezahlt, damit bei der Rückgabe wirklich Geld zurückfließen
    //    kann — ein unbezahlter Beleg wird nur durch die Gutschrift ausgeglichen.
    const invoice = (id, number, productId, qty, unit) => {
      const net = unit * qty;
      const vat = Math.round(net * 0.1 * 1000) / 1000;
      const gross = net + vat;
      db.prepare(
        `INSERT INTO invoices (id, branch_id, invoice_number, customer_id, status, currency,
           net_amount, vat_rate_snapshot, vat_amount, gross_amount, tax_scheme_snapshot,
           paid_amount, issued_at, created_at, updated_at, created_by)
         VALUES (?,?,?, 'c3g-cust', 'FINAL', 'BHD', ?, 10, ?, ?, 'VAT_10', ?, ?, ?, ?, 'user-owner')`)
        .run(id, branchId, number, net, vat, gross, gross, today, now, now);
      db.prepare(
        `INSERT INTO invoice_lines (id, invoice_id, product_id, description, quantity, unit_price,
           purchase_price_snapshot, vat_rate, tax_scheme, vat_amount, line_total, position, lot_id)
         VALUES (?,?,?,?,?,?, 100, 10, 'VAT_10', ?, ?, 1, ?)`)
        .run(id + '-l1', id, productId, 'C3H line', qty, unit, vat, gross, 'lot-' + productId);
      db.prepare(
        `INSERT INTO payments (id, branch_id, invoice_id, amount, method, received_at, created_at, created_by)
         VALUES (?,?,?,?, 'cash', ?, ?, 'user-owner')`)
        .run(id + '-pay', branchId, id, gross, today, now);
      // Und die Gegenbuchungen, die ein echter Verkauf hinterlässt: Forderung, Erlös, Kasse.
      const leg = (n, account, direction, amount, mod, src) => db.prepare(
        `INSERT INTO ledger_entries (id, branch_id, entry_no, transaction_id, occurred_at, recorded_at,
           account, direction, amount, currency, counterparty_type, counterparty_id,
           source_module, source_id, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'BHD', 'CUSTOMER', 'c3g-cust', ?, ?, 'user-owner', ?)`)
        .run(`${id}-le${n}`, branchId, 9000 + n, `${id}-tx${n}`, now, now, account, direction, amount, mod, src, now);
      leg(1, 'ACCOUNTS_RECEIVABLE', 'DEBIT', gross, 'INVOICE', id);
      leg(2, 'SALES_REVENUE', 'CREDIT', net, 'INVOICE', id);
      leg(3, 'VAT_PAYABLE', 'CREDIT', vat, 'INVOICE', id);
      leg(4, 'COGS', 'DEBIT', 100 * qty, 'INVOICE', id);
      leg(5, 'INVENTORY', 'CREDIT', 100 * qty, 'INVOICE', id);
      leg(6, 'CASH', 'DEBIT', gross, 'PAYMENT', id + '-pay');
      leg(7, 'ACCOUNTS_RECEIVABLE', 'CREDIT', gross, 'PAYMENT', id + '-pay');
      db.prepare('UPDATE products SET quantity = quantity - ? WHERE id = ?').run(qty, productId);
      db.prepare('UPDATE stock_lots SET qty_remaining = qty_remaining - ? WHERE product_id = ?').run(qty, productId);
    };
    invoice('c3h-inv', 'INV-2026-09101', 'c3h-p1', 2, 150);
    invoice('c3h-inv2', 'INV-2026-09102', 'c3h-p2', 1, 150);

    // ── Zwei Aufträge, noch PENDING: der Statuswechsel ist Teil des Ablaufs.
    const order = (id, number, productId, price) => {
      db.prepare(
        `INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
           agreed_price, tax_amount, deposit_amount, deposit_paid, remaining_amount, status, type,
           created_at, updated_at, created_by)
         VALUES (?,?,?, 'c3g-cust2', 'Zenith', ?, ?, 0, 0, 0, ?, 'pending', 'normal', ?, ?, 'user-owner')`)
        .run(id, branchId, number, productId, price, price, now, now);
      db.prepare(
        `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price,
           line_total, position, tax_scheme, vat_rate, cost_amount, is_customer_facing, status, created_at)
         VALUES (?,?,?, 'C3H order line', 1, ?, ?, 1, 'ZERO', 0, 0, 1, 'PENDING', ?)`)
        .run(id + '-l1', id, productId, price, price, now);
    };
    order('c3h-ord', 'ORD-2026-09101', 'c3h-p3', 300);
    order('c3h-ord2', 'ORD-2026-09102', 'c3h-p4', 200);

    // ── Zwei aktive Kommissionen.
    const consign = (id, number, productId, agreed) => {
      db.prepare(
        `INSERT INTO consignments (id, branch_id, consignment_number, consignor_id, product_id,
           agreed_price, commission_rate, commission_type, status, agreement_date,
           payout_paid_amount, payout_status, created_at, updated_at, created_by)
         VALUES (?,?,?, 'c3g-cust', ?, ?, 20, 'percent', 'active', ?, 0, 'pending', ?, ?, 'user-owner')`)
        .run(id, branchId, number, productId, agreed, today, now, now);
      db.prepare("UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT', purchase_price = 0 WHERE id = ?").run(productId);
    };
    consign('c3h-con', 'CON-2026-09101', 'c3h-p5', 1000);
    consign('c3h-con2', 'CON-2026-09102', 'c3h-p6', 900);

    // ── Zwei Reparaturen: eine offen, eine fertig (fürs Rennen um die Rechnung).
    const repair = (id, number, status, charge) => {
      db.prepare(
        `INSERT INTO repairs (id, branch_id, repair_number, customer_id, item_brand, item_model,
           issue_description, repair_type, repair_scope, workshop_supplier_id, estimated_cost,
           internal_cost, charge_to_customer, status, received_at, tax_scheme, created_at, updated_at, created_by)
         VALUES (?,?,?, 'c3g-cust', 'Zenith', 'C3H', 'does not run', 'external', 'CUSTOMER',
           'c3g-sup', 30, 30, ?, ?, ?, 'VAT_10', ?, ?, 'user-owner')`)
        .run(id, branchId, number, charge, status, now, now, now);
    };
    repair('c3h-rep', 'REP-2026-09101', 'received', 120);
    repair('c3h-rep2', 'REP-2026-09102', 'ready', 90);

    // ── Zwei verkaufte Agenten-Transfers, die auf ihre Rechnung warten.
    const transfer = (id, number, productId, price) => {
      db.prepare(
        `INSERT INTO agent_transfers (id, branch_id, transfer_number, agent_id, product_id,
           agent_price, commission_rate, commission_type, settlement_model, status,
           transferred_at, sold_at, actual_sale_price, settlement_amount, settlement_paid_amount,
           settlement_status, created_at, updated_at, created_by)
         VALUES (?,?,?, 'c3gf-agent', ?, ?, 0, 'percent', 'full', 'sold', ?, ?, ?, ?, 0, 'pending', ?, ?, 'user-owner')`)
        .run(id, branchId, number, productId, price, now, now, price, price, now, now);
      db.prepare("UPDATE products SET stock_status = 'with_agent', source_type = 'AGENT' WHERE id = ?").run(productId);
      // Die Forderung aus dem Verkauf — die die Umwandlung stornieren MUSS.
      db.prepare(
        `INSERT INTO ledger_entries (id, branch_id, entry_no, transaction_id, occurred_at, recorded_at,
           account, direction, amount, currency, counterparty_type, counterparty_id,
           source_module, source_id, created_by, created_at)
         VALUES (?,?,?,?,?,?, 'ACCOUNTS_RECEIVABLE', 'DEBIT', ?, 'BHD', 'CUSTOMER', 'c3g-cust',
           'AGENT_TRANSFER_SOLD', ?, 'user-owner', ?)`)
        .run(id + '-le1', branchId, 9500, id + '-tx', now, now, price, id, now);
      db.prepare(
        `INSERT INTO ledger_entries (id, branch_id, entry_no, transaction_id, occurred_at, recorded_at,
           account, direction, amount, currency, counterparty_type, counterparty_id,
           source_module, source_id, created_by, created_at)
         VALUES (?,?,?,?,?,?, 'SALES_REVENUE', 'CREDIT', ?, 'BHD', 'CUSTOMER', 'c3g-cust',
           'AGENT_TRANSFER_SOLD', ?, 'user-owner', ?)`)
        .run(id + '-le2', branchId, 9501, id + '-tx', now, now, price, id, now);
    };
    transfer('c3h-tr', 'TRF-2026-09101', 'c3h-p7', 400);
    transfer('c3h-tr2', 'TRF-2026-09102', 'c3h-p8', 350);
  } finally { try { db.close(); } catch {} }
}
console.log('CENTRAL-C3H — the real client finishes the five remaining business flows\n');
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
  seedC3h();
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
  const sendJson = async (op, payload, id) => (await send(op, payload, id)).json();
  const calls = (op) => seen.filter((x) => x.op === op);
  const revOf = (table, id) => Number(one(`SELECT revision c FROM ${table} WHERE id = ?`, [id])?.c);
  const ledgerRows = () => count('SELECT COUNT(*) c FROM ledger_entries');

  /** Zu einem Bereich, eine Zeile oeffnen, den Aendern-Knopf druecken. */
  async function openEntity(area, id, chip) {
    await click(client, `[data-client-area="${area}"]`);
    await waitFor(client, '[data-client-list]', 30000);
    await waitForRow(client, `[data-client-row="${id}"]`);
    await waitFor(client, chip, 30000);
    await click(client, chip);
  }
  const actionSel = (kind) => `[data-client-action-send="${kind}"]`;
  async function runAction(kind, waitDoneSel = `[data-client-done="${kind}"]`) {
    await waitFor(client, actionSel(kind), 30000);
    await click(client, actionSel(kind));
    if (waitDoneSel) {
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        if (await exists(client, waitDoneSel)) { await sleep(1200); return; }
        // Ein fachliches Nein ist eine ANTWORT — sie soll hier stehen, nicht eine Zeitgrenze.
        const no = await text(client, `[data-client-rejected="${kind}"]`);
        if (no) throw new Error(`action ${kind} refused: ${no}`);
        await sleep(300);
      }
      throw new Error(`action ${kind} never finished`);
    }
    await sleep(1200);
  }

  // ══ 1) Rueckgabe mit Gutschrift ═════════════════════════════════════════
  {
    const INV = 'c3h-inv';
    const qtyBefore = Number(one("SELECT quantity c FROM products WHERE id = 'c3h-p1'")?.c);
    const lotBefore = Number(one("SELECT qty_remaining c FROM stock_lots WHERE id = 'lot-c3h-p1'")?.c);
    const vatBefore = Number(one('SELECT vat_amount c FROM invoices WHERE id = ?', [INV])?.c);
    const cashBefore = Number(one("SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) c FROM ledger_entries WHERE account = 'CASH'")?.c ?? 0);

    await openEntity('invoices', INV, '[data-client-open-invoice]');
    await waitFor(client, '[data-client-returns]', 45000);
    ok(true, 'RETURN the client sees the return panel on the invoice');
    const line = String(one('SELECT id c FROM invoice_lines WHERE invoice_id = ?', [INV])?.c);
    const left = await text(client, `[data-client-return-left="${line}"]`);
    ok(String(left) === '2', `RETURN the primary says two pieces may still come back (${left})`);

    await setVal(client, `[data-client-return-qty="${line}"]`, '1');
    await setVal(client, '[data-client-field="return.method"]', 'cash');
    await runAction('return.create');
    const ret1 = one("SELECT id c FROM sales_returns WHERE invoice_id = ?", [INV]);
    ok(!!ret1, 'RETURN a return document exists');
    const RID = String(ret1?.c);
    ok(/^RET/.test(String(one('SELECT return_number c FROM sales_returns WHERE id = ?', [RID])?.c)),
      'RETURN …with a number out of the house sequence');
    const lotAfter = Number(one("SELECT qty_remaining c FROM stock_lots WHERE id = 'lot-c3h-p1'")?.c);
    ok(lotAfter === lotBefore + 1,
      `RETURN the piece is back in its own lot — cost provenance intact (${lotBefore} → ${lotAfter})`);
    ok(Number(one("SELECT quantity c FROM products WHERE id = 'c3h-p1'")?.c) === qtyBefore + 1,
      `RETURN …and the stock count follows (${qtyBefore} → ${Number(one("SELECT quantity c FROM products WHERE id = 'c3h-p1'")?.c)})`);
    ok(String(one("SELECT stock_status c FROM products WHERE id = 'c3h-p1'")?.c) === 'in_stock',
      'RETURN …and the item is sellable again');
    ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE account = 'COGS'") > 0,
      'RETURN the cost of goods is reversed');
    // Der Preis kam NICHT vom Client.
    const sent = calls('returns.create').at(-1);
    ok(sent && sent.payload.lines[0].unitPrice === undefined, 'RETURN the client sent NO price');
    ok(Number(one('SELECT total_amount c FROM sales_returns WHERE id = ?', [RID])?.c) > 0,
      '…and the house computed one anyway');

    // Genehmigen: Gutschrift + Steuerkorrektur.
    await runAction(`return.approve.${RID}`);
    ok(count('SELECT COUNT(*) c FROM credit_notes WHERE sales_return_id = ?', [RID]) === 1,
      'RETURN exactly one credit note — the tax document');
    ok(Number(one('SELECT vat_amount c FROM invoices WHERE id = ?', [INV])?.c) < vatBefore,
      'RETURN the invoice VAT is corrected');
    ok(String(one('SELECT status c FROM sales_returns WHERE id = ?', [RID])?.c) === 'APPROVED',
      'RETURN the return is approved');

    // Erstatten MIT verschluckter Antwort: dieselbe Kennung, kein zweites Geld.
    const total = Number(one('SELECT total_amount c FROM sales_returns WHERE id = ?', [RID])?.c);
    await setVal(client, `[data-client-refund-amount="${RID}"]`, String(total));
    const refundBefore = calls('returns.refund').length;
    const ledgerBefore = ledgerRows();
    swallowOp = 'returns.refund';
    await click(client, actionSel(`return.refund.${RID}`));
    await waitFor(client, `[data-client-pending="return.refund.${RID}"]`, 60000);
    ok(swallowed >= 1, 'RETURN-UNKNOWN the answer was swallowed after the primary had booked');
    await sleep(1500);
    const paidAfterSwallow = Number(one('SELECT refund_paid_amount c FROM sales_returns WHERE id = ?', [RID])?.c ?? 0);
    ok(paidAfterSwallow > 0, `RETURN-UNKNOWN the refund DID happen (${paidAfterSwallow})`);
    const ledgerAfterSwallow = ledgerRows();
    ok(ledgerAfterSwallow > ledgerBefore, 'RETURN-UNKNOWN …the first attempt really booked');

    await click(client, actionSel(`return.refund.${RID}`));
    await waitFor(client, `[data-client-done="return.refund.${RID}"]`, 60000);
    await sleep(1500);
    const rc = calls('returns.refund');
    ok(rc.length === refundBefore + 2, `RETURN-UNKNOWN two requests were sent (${rc.length - refundBefore})`);
    ok(rc[refundBefore].commandId === rc[refundBefore + 1].commandId,
      'RETURN-UNKNOWN …with the SAME command id');
    ok(Math.abs(Number(one('SELECT refund_paid_amount c FROM sales_returns WHERE id = ?', [RID])?.c ?? 0) - paidAfterSwallow) < 0.005,
      'RETURN-UNKNOWN and NO second refund was paid');
    ok(ledgerRows() === ledgerAfterSwallow, 'RETURN-UNKNOWN no second ledger entry appeared');
    ok(Number(one("SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) c FROM ledger_entries WHERE account = 'CASH'")?.c ?? 0) < cashBefore,
      'RETURN the cash box really got smaller');
  }

  // ══ 2) Auftrag: Status → Anzahlung → Rechnung ═══════════════════════════
  {
    const ORD = 'c3h-ord';
    await openEntity('orders', ORD, '[data-client-edit-order]');
    await waitFor(client, '[data-client-order-lifecycle]', 45000);
    ok(String(one('SELECT status c FROM orders WHERE id = ?', [ORD])?.c) === 'pending',
      'ORDER the seeded order is still pending — nothing is billable yet');

    // Die Sackgasse aus C3G, am ECHTEN Weg gemessen: vor dem Statuswechsel weist der Primary ab.
    const early = await sendJson('orders.convert_to_invoice', { orderId: ORD, expectedRevision: revOf('orders', ORD) });
    ok(early.error === 'ORDER_NOTHING_BILLABLE', `ORDER-GATE nothing is billable before "arrived" (${S(early.error)})`);

    await runAction('order.status');
    ok(String(one('SELECT status c FROM orders WHERE id = ?', [ORD])?.c) === 'arrived',
      'ORDER the client advanced it to arrived');
    ok(String(one("SELECT status c FROM order_lines WHERE order_id = ?", [ORD])?.c) === 'ARRIVED',
      'ORDER …and the line came along — the cascade of the house');

    // Anzahlung MIT verschluckter Antwort.
    await waitFor(client, '[data-client-order-pay-amount]', 30000);
    await setVal(client, '[data-client-order-pay-amount]', '50');
    const payBefore = calls('orders.add_payment').length;
    swallowOp = 'orders.add_payment';
    await click(client, actionSel('order.pay'));
    await waitFor(client, '[data-client-pending="order.pay"]', 60000);
    await sleep(1500);
    ok(count('SELECT COUNT(*) c FROM order_payments WHERE order_id = ?', [ORD]) === 1,
      'ORDER-UNKNOWN the deposit was booked even though the answer was lost');
    await click(client, actionSel('order.pay'));
    await waitFor(client, '[data-client-done="order.pay"]', 60000);
    await sleep(1500);
    const pc = calls('orders.add_payment');
    ok(pc.length === payBefore + 2, `ORDER-UNKNOWN two requests were sent (${pc.length - payBefore})`);
    ok(pc[payBefore].commandId === pc[payBefore + 1].commandId, 'ORDER-UNKNOWN …with the SAME command id');
    ok(count('SELECT COUNT(*) c FROM order_payments WHERE order_id = ?', [ORD]) === 1,
      'ORDER-UNKNOWN and there is ONE deposit, not two');
    ok(Number(one('SELECT deposit_amount c FROM orders WHERE id = ?', [ORD])?.c) === 50,
      'ORDER the order balance follows the payments');

    // Und JETZT die Umwandlung — der ganze Weg ist am zweiten Rechner fahrbar.
    // Das Formular ueber der Tafel liest nach einer Lebenszyklus-Wirkung frisch — vorher war
    // sein Knopf aus, weil es beim Laden noch nichts Abrechenbares gab.
    const end = Date.now() + 45000;
    let enabled = false;
    while (Date.now() < end) {
      if (await client.ev("const e=document.querySelector('[data-client-order-convert]'); return !!e && !e.disabled;")) { enabled = true; break; }
      await sleep(400);
    }
    ok(enabled, 'ORDER-GATE the convert button woke up after the status change');
    // Ein offener Ausgang ist kein Fehlschlag: die Wiederholung faehrt DIESELBE Kennung. Genau
    // dafuer sagt der Knopf danach „Retry the same invoice" — und genau das wird hier geklickt.
    const convertBefore = calls('orders.convert_to_invoice').length;
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      await click(client, '[data-client-order-convert]');
      const t2 = Date.now() + 45000;
      let pending = false;
      while (Date.now() < t2) {
        if (await exists(client, '[data-client-order-convert-done]')) { done = true; break; }
        const no = await text(client, '[data-client-order-convert-rejected]');
        if (no) throw new Error('order convert refused: ' + no);
        if (await exists(client, '[data-client-order-convert-pending]')) { pending = true; break; }
        await sleep(300);
      }
      if (!done && !pending) {
        const box = await text(client, '[data-client-order-convert-box]');
        throw new Error('order convert never finished; box: ' + box);
      }
      if (!done) await sleep(1500);
    }
    if (!done) throw new Error('order convert stayed unknown after four attempts');
    await sleep(1500);
    const convertCalls = calls('orders.convert_to_invoice').slice(convertBefore);
    ok(new Set(convertCalls.map((x) => x.commandId)).size === 1,
      `ORDER-GATE every attempt used the SAME command id (${convertCalls.length} attempts)`);
    await sleep(1500);
    const invId = String(one('SELECT invoice_id c FROM orders WHERE id = ?', [ORD])?.c || '');
    ok(invId !== '', 'ORDER-GATE the order carries an invoice now');
    ok(count('SELECT COUNT(*) c FROM invoices WHERE id = ?', [invId]) === 1, 'ORDER-GATE exactly one');
    ok(String(one('SELECT invoice_number c FROM invoices WHERE id = ?', [invId])?.c || '') !== '',
      'ORDER-GATE …with a number out of the house sequence');
  }

  // ══ 3) Kommission: Verkauf → Auszahlung ═════════════════════════════════
  {
    const CON = 'c3h-con';
    await openEntity('consignments', CON, '[data-client-edit-consignment]');
    await waitFor(client, '[data-client-consignment-lifecycle]', 45000);

    // Vor dem Verkauf gibt es nichts auszuzahlen.
    const early = await sendJson('consignments.record_payout',
      { consignmentId: CON, amount: 10, method: 'cash', expectedRevision: revOf('consignments', CON) });
    ok(early.error === 'NOTHING_TO_PAY_OUT', `CONSIGN-GATE nothing to pay out before the sale (${S(early.error)})`);

    await setVal(client, '[data-client-field="sale.buyer"]', 'c3g-cust2');
    await setVal(client, '[data-client-sale-price]', '1000');
    await runAction('consignment.sale');
    ok(String(one('SELECT status c FROM consignments WHERE id = ?', [CON])?.c) === 'sold',
      'CONSIGN the consignment is sold');
    ok(Number(one('SELECT payout_amount c FROM consignments WHERE id = ?', [CON])?.c) === 800,
      'CONSIGN the payout is 800 (1000 minus 20 %) — computed by the house');
    ok(String(one('SELECT invoice_id c FROM consignments WHERE id = ?', [CON])?.c || '') !== '',
      'CONSIGN …and a buyer invoice exists');
    ok(count("SELECT COUNT(*) c FROM purchases WHERE notes LIKE '%CON-2026-09%'") > 0,
      'CONSIGN …and a purchase against the consignor');
    ok(count("SELECT COUNT(*) c FROM invoices WHERE special_mark = 1") === 0,
      'CONSIGN the remote sale set NO special mark — regular number circle');

    // Und die in C3G freigegebene Auszahlung geht jetzt OHNE Zwischenschritt am Primary.
    await client.ev("[...document.querySelectorAll('[data-client-area]')].find(b=>b.getAttribute('data-client-area')==='consignments')?.click(); return 1;");
    await openEntity('consignments', CON, '[data-client-edit-consignment]');
    await waitFor(client, '[data-client-consignment-payout-amount]', 45000);
    await setVal(client, '[data-client-consignment-payout-amount]', '800');
    await click(client, '[data-client-consignment-payout-save]');
    await waitFor(client, '[data-client-consignment-payout-done]', 60000);
    await sleep(1500);
    ok(Number(one('SELECT payout_paid_amount c FROM consignments WHERE id = ?', [CON])?.c) === 800,
      'CONSIGN-CHAIN the consignor is paid — no primary-only step in between');
  }

  // ══ 4) Reparatur: Arbeitszeile → Zustand → Rechnung ═════════════════════
  {
    const REP = 'c3h-rep';
    await openEntity('repairs', REP, '[data-client-edit-repair]');
    await waitFor(client, '[data-client-repair-lifecycle]', 45000);
    const linesBefore = count('SELECT COUNT(*) c FROM repair_lines WHERE repair_id = ?', [REP]);

    await setVal(client, '[data-client-repair-line-cost]', '25');
    await setVal(client, '[data-client-field="repairline.supplier"]', 'c3g-sup');
    await runAction('repair.addline');
    ok(count('SELECT COUNT(*) c FROM repair_lines WHERE repair_id = ?', [REP]) === linesBefore + 1,
      'REPAIR the work line is there');

    // Die Zustandsmaschine — der Bildschirm bietet nur an, was der Primary erlaubt.
    for (const target of ['in_progress', 'ready']) {
      await waitFor(client, actionSel(`repair.status.${target}`), 45000);
      await click(client, actionSel(`repair.status.${target}`));
      await waitFor(client, `[data-client-done="repair.status.${target}"]`, 60000);
      await sleep(1500);
      ok(String(one('SELECT status c FROM repairs WHERE id = ?', [REP])?.c) === target,
        `REPAIR advanced to ${target}`);
    }
    ok(count("SELECT COUNT(*) c FROM expenses WHERE related_module = 'repair' AND related_entity_id = ?", [REP]) > 0,
      'REPAIR the supplier payable was booked at that stage — by the house');

    await runAction('repair.invoice');
    const rInv = String(one('SELECT invoice_id c FROM repairs WHERE id = ?', [REP])?.c || '');
    ok(rInv !== '', 'REPAIR the repair carries an invoice');
    const internal = Number(one('SELECT internal_cost c FROM repairs WHERE id = ?', [REP])?.c ?? 0);
    const openLines = Number(one("SELECT COALESCE(SUM(cost_amount),0) c FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'", [REP])?.c ?? 0);
    const snap = Number(one('SELECT purchase_price_snapshot c FROM invoice_lines WHERE invoice_id = ?', [rInv])?.c ?? 0);
    ok(Math.abs(snap - (internal + openLines)) < 0.005,
      `REPAIR the invoice cost is internalCost + work lines (${snap} = ${internal} + ${openLines})`);
    // Der Riegel gegen die zweite Rechnung.
    const twice = await sendJson('repairs.create_invoice', { repairId: REP, expectedRevision: revOf('repairs', REP) });
    ok(twice.error === 'REPAIR_ALREADY_INVOICED', `REPAIR no second invoice (${S(twice.error)})`);
    ok(count("SELECT COUNT(*) c FROM invoices WHERE notes LIKE '%Repair%'") === 1,
      'REPAIR exactly one repair invoice stands');
  }

  // ══ 5) Agenten-Transfer → Rechnung ══════════════════════════════════════
  {
    const TR = 'c3h-tr';
    ok(String(one('SELECT status c FROM agent_transfers WHERE id = ?', [TR])?.c) === 'sold',
      'TRANSFER the seeded transfer is sold and waiting to be invoiced');
    await openEntity('transfers', TR, '[data-client-edit-transfer]');
    await waitFor(client, '[data-client-transfer-invoice]', 45000);
    await setVal(client, '[data-client-field="convert.customer"]', 'c3g-cust');
    await runAction('transfer.convert');
    const tInv = String(one('SELECT invoice_id c FROM agent_transfers WHERE id = ?', [TR])?.c || '');
    ok(tInv !== '', 'TRANSFER the transfer carries an invoice now');
    const settlement = Number(one('SELECT settlement_amount c FROM agent_transfers WHERE id = ?', [TR])?.c ?? 0);
    ok(Math.abs(Number(one('SELECT gross_amount c FROM invoices WHERE id = ?', [tInv])?.c ?? 0) - settlement) < 0.005,
      `TRANSFER its total IS the settlement amount (${settlement})`);
    ok(count("SELECT COUNT(*) c FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND source_id = ? AND reverses_entry_id IS NOT NULL", [TR]) > 0,
      'TRANSFER the old receivable from the sale is reversed — it must not stand twice');
    const twice = await sendJson('transfers.convert_to_invoice',
      { transferId: TR, customerId: 'c3g-cust', expectedRevision: revOf('agent_transfers', TR) });
    ok(twice.error === 'TRANSFER_ALREADY_INVOICED', `TRANSFER no second invoice (${S(twice.error)})`);
  }

  // ══ 6) Die Rennen, die keine Oberflaeche erzeugen kann ══════════════════
  {
    // (a) Ueberrueckgabe: zwei Rechner geben gleichzeitig das LETZTE Stueck zurueck.
    const INV2 = 'c3h-inv2';
    const line2 = String(one('SELECT id c FROM invoice_lines WHERE invoice_id = ?', [INV2])?.c);
    const seenRev = revOf('invoices', INV2);
    const [a, b] = await Promise.all([
      sendJson('returns.create', { invoiceId: INV2, expectedRevision: seenRev, lines: [{ invoiceLineId: line2, quantity: 1 }] }),
      sendJson('returns.create', { invoiceId: INV2, expectedRevision: seenRev, lines: [{ invoiceLineId: line2, quantity: 1 }] }),
    ]);
    ok([a, b].filter((x) => x.ok === true).length === 1, `RACE-RETURN exactly one return wins (${S([a.ok, b.ok])})`);
    await sleep(1200);
    ok(count('SELECT COUNT(*) c FROM sales_returns WHERE invoice_id = ?', [INV2]) === 1,
      'RACE-RETURN one return document exists');
    ok(Number(one(`SELECT COALESCE(SUM(srl.quantity),0) c FROM sales_return_lines srl
        JOIN sales_returns r ON r.id = srl.return_id
       WHERE srl.invoice_line_id = ? AND r.status != 'REJECTED'`, [line2])?.c) === 1,
      'RACE-RETURN and exactly ONE piece came back, not two');
    // Und mit frischer Fassung ist die Menge wirklich weg.
    const after = await sendJson('returns.create',
      { invoiceId: INV2, expectedRevision: revOf('invoices', INV2), lines: [{ invoiceLineId: line2, quantity: 1 }] });
    ok(after.error === 'RETURN_QUANTITY_EXCEEDED', `RACE-RETURN the quantity cap holds afterwards (${S(after.error)})`);

    // (b) Doppelte Anzahlung auf denselben Auftrag.
    const ORD2 = 'c3h-ord2';
    const oRev = revOf('orders', ORD2);
    const [p1, p2] = await Promise.all([
      sendJson('orders.add_payment', { orderId: ORD2, amount: 40, method: 'cash', expectedRevision: oRev }),
      sendJson('orders.add_payment', { orderId: ORD2, amount: 40, method: 'bank', expectedRevision: oRev }),
    ]);
    ok([p1, p2].filter((x) => x.ok === true).length === 1, `RACE-PAY exactly one deposit wins (${S([p1.ok, p2.ok])})`);
    await sleep(1200);
    ok(Number(one('SELECT COALESCE(SUM(amount),0) c FROM order_payments WHERE order_id = ?', [ORD2])?.c) === 40,
      'RACE-PAY exactly 40 is booked, not 80');

    // (c) Doppelter Verkauf derselben Kommission.
    const CON2 = 'c3h-con2';
    const cRev = revOf('consignments', CON2);
    const [s1, s2] = await Promise.all([
      sendJson('consignments.record_sale', { consignmentId: CON2, buyerId: 'c3g-cust2', salePrice: 900, expectedRevision: cRev }),
      sendJson('consignments.record_sale', { consignmentId: CON2, buyerId: 'c3g-cust2', salePrice: 950, expectedRevision: cRev }),
    ]);
    ok([s1, s2].filter((x) => x.ok === true).length === 1, `RACE-SALE exactly one sale wins (${S([s1.ok, s2.ok])})`);
    await sleep(1500);
    const salePrice = Number(one('SELECT sale_price c FROM consignments WHERE id = ?', [CON2])?.c);
    ok(salePrice === 900 || salePrice === 950, `RACE-SALE the price is the winner's, not a mixture (${salePrice})`);
    ok(count('SELECT COUNT(*) c FROM invoices WHERE notes LIKE ?', ['%CON-2026-09102%']) === 1,
      'RACE-SALE exactly ONE buyer invoice was created');

    // (d) Doppelte Reparaturrechnung.
    const REP2 = 'c3h-rep2';
    const rRev = revOf('repairs', REP2);
    const [i1, i2] = await Promise.all([
      sendJson('repairs.create_invoice', { repairId: REP2, expectedRevision: rRev }),
      sendJson('repairs.create_invoice', { repairId: REP2, expectedRevision: rRev }),
    ]);
    ok([i1, i2].filter((x) => x.ok === true).length === 1, `RACE-REPAIR exactly one invoice wins (${S([i1.ok, i2.ok])})`);
    await sleep(1200);
    ok(count("SELECT COUNT(*) c FROM invoices WHERE notes LIKE '%REP-2026-09102%'") === 1,
      'RACE-REPAIR exactly ONE repair invoice was created');

    // (e) Doppelte Transfer-Umwandlung.
    const TR2 = 'c3h-tr2';
    const tRev = revOf('agent_transfers', TR2);
    const [c1, c2] = await Promise.all([
      sendJson('transfers.convert_to_invoice', { transferId: TR2, customerId: 'c3g-cust', expectedRevision: tRev }),
      sendJson('transfers.convert_to_invoice', { transferId: TR2, customerId: 'c3g-cust2', expectedRevision: tRev }),
    ]);
    ok([c1, c2].filter((x) => x.ok === true).length === 1, `RACE-CONVERT exactly one conversion wins (${S([c1.ok, c2.ok])})`);
    await sleep(1200);
    const t2inv = String(one('SELECT invoice_id c FROM agent_transfers WHERE id = ?', [TR2])?.c || '');
    ok(t2inv !== '', 'RACE-CONVERT the transfer carries exactly one invoice');
    ok(count("SELECT COUNT(*) c FROM invoices WHERE notes LIKE '%TRF-2026-09102%'") === 1,
      'RACE-CONVERT …and exactly one was created for it');

    // (f) Ein ALTER Stand schreibt nicht ueber einen neueren.
    const REP3 = 'c3h-rep2';
    const staleRev = 1;
    const stale = await sendJson('repairs.update_status', { repairId: REP3, status: 'picked_up', expectedRevision: staleRev });
    ok(stale.error === 'RECORD_CHANGED' || stale.error === 'REPAIR_TRANSITION_NOT_ALLOWED',
      `RACE-STALE an old revision is refused (${S(stale.error)})`);

    // (g) Und kein freier Zielzustand.
    const jump = await sendJson('orders.update_status',
      { orderId: 'c3h-ord2', status: 'completed', expectedRevision: revOf('orders', 'c3h-ord2') });
    ok(jump.error === 'ORDER_TRANSITION_NOT_ALLOWED', `RACE-FLOW no free target status (${S(jump.error)})`);
    const cancel = await sendJson('orders.update_status',
      { orderId: 'c3h-ord2', status: 'cancelled', expectedRevision: revOf('orders', 'c3h-ord2') });
    ok(cancel.error === 'INVALID_PAYLOAD', `RACE-FLOW cancelling is not done from here (${S(cancel.error)})`);

    // (h) Und keine Klasse-C-Aktion erreicht die Bruecke.
    for (const op of ['repairs.delete', 'transfers.undo_convert', 'invoices.set_special_mark',
      'consignments.cancel_sale', 'orders.cancel_with_money', 'returns.cancel']) {
      const r = await send(op, {});
      ok(r.status === 400, `CLASS-C ${op} never reaches the renderer (HTTP ${r.status})`);
    }
  }

  // ══ 7) Der Client hat immer noch nichts angelegt ════════════════════════
  {
    const after = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    ok(!after.includes('lataif.db') && !after.includes('lataif_sync_server.db') && !after.includes('data-location.json'),
      `DBLESS after five business flows the client still owns nothing (${after.join(', ') || 'empty'})`);
    const localHits = await client.ev("return Object.keys(localStorage).filter(k=>/invoice|order|repair|consign|transfer|return|outbox/i.test(k)).join(',');");
    ok(String(localHits) === '', `DBLESS …and keeps no business state in its browser (${localHits})`);
  }
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

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c3h remaining business actions: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3H_REAL_CLIENT_E2E_PROVED');
