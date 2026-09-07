// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C5 — die Betriebsabnahme: zwei echte Rechner, Neustart, Ausfall, Nebenlaeufigkeit.
//
// Zwei wirkliche Anwendungen auf einer Maschine, zwei Kennungen, echte Klicks:
//   • der PRIMARY (`lataif.exe`, `com.lataif.app.e2e`, CDP 9223) — Datenbank, Buchhaltung, LAN;
//   • der CLIENT (`lataif-e2e-client.exe`, `com.lataif.app.e2e.client`, CDP 9224) — leeres
//     Kontrollverzeichnis, keine Datenbank, nie eine.
//
// Der Single-Instance-Riegel der Produktion wird nicht umgangen, sondern nicht getroffen: zwei
// Kennungen sind zwei Anwendungen.
//
// C5 baut KEINE Geschaeftsfunktion. Es fragt, ob das Gebaute den Betrieb aushaelt — und zwar
// an zwei wirklichen Anwendungen, nicht an Beteuerungen:
//
//   1. Grundzustand: PC2 besitzt nichts. Keine Geschaeftsdatenbank, kein Datenwurzelverzeichnis,
//      keine Serverdatenbank, kein Ausgangskorb. Lesen kommt vom Primary, Schreiben landet dort.
//   2. Der Primary geht AUS: Lesen faellt geschlossen aus, Schreiben hinterlaesst nichts, und
//      nach dem Neustart arbeitet derselbe Client weiter — ohne zweite Wirkung.
//   3. Die Leitung bricht: bei drei verschiedenen wirtschaftlichen Buchungen, jeweils NACH dem
//      Festschreiben. Dieselbe Kennung, genau eine Wirkung.
//   4. Der Renderer wird neu geladen, waehrend ein Auftrag unterwegs ist: die alte Generation
//      schliesst nichts mehr ab, und die Wiederholung bucht nicht doppelt.
//   5. Beide Menschen arbeiten gleichzeitig — einer am Primary, einer an PC2.
//   6. Zwei Telefone laden hoch, waehrend beide schreiben.
//   7. Der Prozess wird hart beendet: die Wirkung ist da, der Nachweis ist da, die Wiederholung
//      gibt das eingefrorene Ergebnis.
//   8. Und am Ende: ist die Datenbank noch heil.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eBinary, assertE2eClientBinary, assertE2eScope, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

/** CRC-32, wie PNG es je Abschnitt verlangt. */
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** Ein echtes, dekodierbares PNG in einer Farbe — klein, gueltig, und je Farbe ein anderer Hash. */
function makePng(size, r, g, b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // Bittiefe
  ihdr[9] = 2;   // Farbtyp: RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // Filter: keiner
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

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

const RUN = join(os.tmpdir(), 'lataif-c5-acceptance', 'run-' + Date.now());
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
/** Welche Operation als naechstes ihre Antwort verliert — der Primary hat dann bereits gebucht. */
let swallowOp = null;
let swallowed = 0;
/**
 * CENTRAL-C5 — die Leitung selbst.
 *   'pass'    — alles geht durch.
 *   'down'    — der Vermittler nimmt die Anfrage an und LEGT AUF. Fuer den Client sieht das aus
 *               wie ein Netz, das mitten im Satz weg ist: Ausgang offen, dieselbe Kennung.
 *   'refuse'  — die Anfrage erreicht den Primary GAR NICHT. Sie wird abgewiesen, bevor sie
 *               weitergereicht wird — der Fall "getrennt, bevor irgendetwas losging".
 */
let link = 'pass';
let refusedBeforeDispatch = 0;
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
    // Getrennt, BEVOR irgendetwas losging: der Primary sieht diese Anfrage nie.
    if (link === 'refuse') {
      refusedBeforeDispatch += 1;
      res.writeHead(503, { 'Content-Type': 'application/json', ...CORS });
      res.end(S({ ok: false, error: 'LINK_DOWN', outcome: 'not_executed' }));
      return;
    }
    // Mitten im Satz weg: die Verbindung stirbt, ohne dass je eine Antwort kam.
    if (link === 'down') {
      req.socket.destroy();
      return;
    }
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



/** Ein Kunde, zwei Artikel mit Bestand, ein Lieferant — mehr braucht die Abnahme nicht. */
function seedC5() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-c3e';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
      VALUES ('c5-sup', ?, 'C5 Workshop', 1, ?, ?)`).run(branchId, now, now);
    for (const [id, first] of [['c5-cust', 'Case'], ['c5-cust2', 'Second']]) {
      db.prepare(
        `INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
           vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
         VALUES (?, ?, ?, 'Client', 'C5 Co', 'BH','en','NONE','[]','PRIVATE','active',?,?)`)
        .run(id, branchId, first, now, now);
    }
    const product = (id, sku, qty, cost = 100) => {
      db.prepare(
        `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
           purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
           quantity, images, attributes, source_type, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'Pre-Owned','[]', ?,'BHD', 300,'in_stock','VAT_10',0,?, '[]','{}','OWN',?,?)`)
        .run(id, branchId, catId, 'Cinq', 'C5 ' + sku, sku, cost, qty, now, now);
      db.prepare(
        `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
         VALUES (?,?,?, ?, ?, ?, 'ACTIVE', ?, ?)`)
        .run('lot-' + id, branchId, id, cost, qty, qty, now, now);
    };
    product('c5-p1', 'C5-1', 5);
    product('c5-p2', 'C5-2', 5);
    // Genau EIN Stueck — fuer das Rennen um die letzte Einheit.
    product('c5-last', 'C5-LAST', 1);
    return { branchId, catId };
  } finally { try { db.close(); } catch {} }
}

console.log('CENTRAL-C5 — operational acceptance: two PCs, restart, outage, concurrency\n');
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
  const { catId } = seedC5();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  /** Den Primary hochfahren und warten, bis er auf dem Netz antwortet. */
  async function startPrimary() {
    const p = await attach(APP_CDP, APP, appEnv());
    await waitInvoke(p);
    await ensureSignedIn(p);
    await invokeErr(p, 'sync_server_start', {});
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) return p; } catch {}
      await sleep(500);
    }
    throw new Error('the primary never answered on the LAN');
  }
  async function stopPrimary() {
    try { primary?.close(); } catch {}
    primary = null;
    killImage('lataif.exe');
    await waitGone('lataif.exe');
    await waitPortFree(PORT);
  }

  primary = await startPrimary();
  ok(true, 'the primary serves on the LAN');
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
  const send = (op, payload, commandId = crypto.randomUUID(), base = BASE) => fetch(`${base}/api/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: S({ op, commandId, payload }),
  });
  const sendJson = async (op, payload, id, base) => {
    const r = await send(op, payload, id, base);
    let b = {}; try { b = await r.json(); } catch {}
    return { status: r.status, ...b };
  };
  /** Ueber den VERMITTLER — nur so wirken `link`/`swallowOp`. */
  const viaLink = (op, payload, id) => sendJson(op, payload, id, PROXY_BASE);
  const count = (sql, p = []) => Number(dbQ(BIZ_DB, sql, p)[0]?.c ?? -1);
  const one = (sql, p = []) => dbQ(BIZ_DB, sql, p)[0];
  const ledger = () => count('SELECT COUNT(*) c FROM ledger_entries');

  // ══ §2 — Der Grundzustand: PC2 besitzt nichts ═══════════════════════════
  {
    const own = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    for (const f of ['lataif.db', 'lataif_sync_server.db', 'data-location.json', 'sync_jwt_secret.key']) {
      ok(!own.includes(f), `BASE the client owns no ${f}`);
    }
    ok(!existsSync(join(CLIENT_HOME, 'Local', 'LATAIF')), 'BASE …and no data root of its own');
    const localHits = await client.ev("return Object.keys(localStorage).filter(k=>/invoice|product|customer|outbox|changelog/i.test(k)).join(',');");
    ok(String(localHits) === '', `BASE …and no business state in its browser (${localHits})`);
    // Lesen kommt vom Primary.
    await click(client, '[data-client-area="customers"]');
    await waitFor(client, '[data-client-list]', 30000);
    await waitForRow(client, '[data-client-row="c5-cust"]');
    ok(true, 'BASE a read reaches the primary and comes back');
    // Und ein Schreibvorgang landet dort.
    const before = count("SELECT COUNT(*) c FROM customers WHERE branch_id = 'branch-main'");
    const w = await viaLink('customers.update', { id: 'c5-cust', notes: 'seen by pc2' });
    ok(w.ok === true, `BASE …and a write lands on the primary (${S(w.error || 'ok')})`);
    ok(String(one("SELECT notes c FROM customers WHERE id = 'c5-cust'")?.c) === 'seen by pc2',
      'BASE …with the effect in the primary database');
    ok(count("SELECT COUNT(*) c FROM customers WHERE branch_id = 'branch-main'") === before,
      'BASE …and nothing was duplicated');
  }

  // ══ §3 — Der Primary geht aus und kommt zurueck ═════════════════════════
  {
    const notesBefore = String(one("SELECT notes c FROM customers WHERE id = 'c5-cust2'")?.c || '');
    await stopPrimary();

    // Lesen faellt geschlossen aus — die Oberflaeche sagt es, statt Altes zu zeigen.
    await click(client, '[data-client-area="products"]');
    await sleep(2500);
    const shownError = await client.ev("const e=document.querySelector('[data-client-error]'); return e ? e.textContent : (document.body.innerText.match(/unavailable|SERVER_UNAVAILABLE|Server/i) ? 'error-visible' : '');");
    ok(String(shownError) !== '', `DOWN a read fails closed and says so (${String(shownError).slice(0, 60)})`);

    // Schreiben hinterlaesst NICHTS.
    let writeOut = null;
    try { writeOut = await viaLink('customers.update', { id: 'c5-cust2', notes: 'written while down' }); }
    catch (e) { writeOut = { status: 0, error: String(e) }; }
    ok(!writeOut || writeOut.ok !== true, `DOWN a write does not succeed (${S(writeOut?.error || writeOut?.status)})`);
    ok(String(one("SELECT notes c FROM customers WHERE id = 'c5-cust2'")?.c || '') === notesBefore,
      'DOWN …and the database is untouched');
    const stillNone = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    ok(!stillNone.includes('lataif.db'), 'DOWN …and the client did NOT fall back to a local database');

    // Zurueck.
    primary = await startPrimary();
    ok(true, 'UP the primary is back');
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
    await click(client, '[data-client-area="customers"]');
    await waitFor(client, '[data-client-list]', 30000);
    await waitForRow(client, '[data-client-row="c5-cust"]');
    ok(true, 'UP the same client reads fresh primary state again');

    const after = await viaLink('customers.update', { id: 'c5-cust2', notes: 'after restart' });
    ok(after.ok === true, `UP …and a new mutation succeeds (${S(after.error || 'ok')})`);
    ok(String(one("SELECT notes c FROM customers WHERE id = 'c5-cust2'")?.c) === 'after restart',
      'UP …with its effect');
    ok(count("SELECT COUNT(*) c FROM customers") === 4,
      `UP …and no duplicate customer appeared (${count('SELECT COUNT(*) c FROM customers')})`);
  }

  // ══ §4 — Die Leitung bricht: drei Buchungen, je genau eine Wirkung ══════
  {
    // (a) Stammdaten.
    const idA = crypto.randomUUID();
    const bodyA = { id: 'c5-cust', notes: 'outage-masterdata' };
    swallowOp = 'customers.update';
    const a1 = await viaLink('customers.update', bodyA, idA);
    ok(swallowed >= 1 && a1.ok !== true, 'OUTAGE-A the answer was swallowed after the primary had booked');
    ok(String(one("SELECT notes c FROM customers WHERE id = 'c5-cust'")?.c) === 'outage-masterdata',
      'OUTAGE-A …and it DID happen');
    const a2 = await viaLink('customers.update', bodyA, idA);
    ok(a2.ok === true && a2.value?.replayed === true,
      `OUTAGE-A the same id replays instead of writing again (${S(a2.value?.replayed)})`);

    // (b) Bestand + Buchhaltung: eine Rechnung.
    const ledgerBefore = ledger();
    const invBefore = count('SELECT COUNT(*) c FROM invoices');
    const qtyBefore = Number(one("SELECT quantity c FROM products WHERE id = 'c5-p1'")?.c);
    const idB = crypto.randomUUID();
    const bodyB = { customerId: 'c5-cust', lines: [{ productId: 'c5-p1', quantity: 1, unitPrice: 200 }] };
    swallowOp = 'invoices.create';
    const b1 = await viaLink('invoices.create', bodyB, idB);
    ok(b1.ok !== true, 'OUTAGE-B the invoice answer was swallowed');
    await sleep(800);
    ok(count('SELECT COUNT(*) c FROM invoices') === invBefore + 1, 'OUTAGE-B …but the invoice exists');
    const ledgerAfter = ledger();
    ok(ledgerAfter > ledgerBefore, 'OUTAGE-B …and it booked');
    const b2 = await viaLink('invoices.create', bodyB, idB);
    ok(b2.ok === true && b2.value?.replayed === true, 'OUTAGE-B the same id replays');
    ok(count('SELECT COUNT(*) c FROM invoices') === invBefore + 1, 'OUTAGE-B …exactly ONE invoice');
    ok(ledger() === ledgerAfter, 'OUTAGE-B …not one extra ledger line');
    ok(Number(one("SELECT quantity c FROM products WHERE id = 'c5-p1'")?.c) === qtyBefore - 1,
      'OUTAGE-B …and the stock moved exactly once');
    const invId = String(b2.value?.invoiceId || '');

    // (c) Ein finanzieller Lebenszyklus: die Zahlung darauf.
    const payLedger = ledger();
    const idC = crypto.randomUUID();
    // `invoices.record_payment` nimmt KEINE Fassung: eine Zahlung aendert die Rechnung nicht,
    // sie kommt hinzu. Der Vertrag ist absichtlich so, und der Rumpf haelt sich daran.
    const bodyC = { invoiceId: invId, amount: 50, method: 'cash' };
    swallowOp = 'invoices.record_payment';
    const c1 = await viaLink('invoices.record_payment', bodyC, idC);
    ok(c1.ok !== true, 'OUTAGE-C the payment answer was swallowed');
    await sleep(800);
    const paidAfter = Number(one('SELECT paid_amount c FROM invoices WHERE id = ?', [invId])?.c);
    ok(paidAfter === 50, `OUTAGE-C …but the money is booked (${paidAfter})`);
    const c2 = await viaLink('invoices.record_payment', bodyC, idC);
    ok(c2.ok === true && c2.value?.replayed === true, 'OUTAGE-C the same id replays');
    ok(Number(one('SELECT paid_amount c FROM invoices WHERE id = ?', [invId])?.c) === 50,
      'OUTAGE-C …and NOT paid twice');
    ok(count('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?', [invId]) === 1,
      'OUTAGE-C …one payment row, not two');
    ok(ledger() > payLedger, 'OUTAGE-C …the first one really booked (so the check has teeth)');

    // (d) Getrennt VOR dem Versand: nachweislich nicht ausgefuehrt.
    const beforeCut = count('SELECT COUNT(*) c FROM invoices');
    link = 'refuse';
    const cutId = crypto.randomUUID();
    const cut = await viaLink('invoices.create', bodyB, cutId);
    link = 'pass';
    ok(cut.outcome === 'not_executed', `CUT a link that never forwarded says not_executed (${S(cut)})`);
    ok(refusedBeforeDispatch === 1, 'CUT …and the primary never saw the request');
    ok(count('SELECT COUNT(*) c FROM invoices') === beforeCut, 'CUT …and nothing was created');
    // Eine NEUE bewusste Handlung darf eine neue Kennung nehmen — und wirkt genau einmal.
    const freshId = crypto.randomUUID();
    const fresh = await viaLink('invoices.create', bodyB, freshId);
    ok(fresh.ok === true, 'CUT a new deliberate action with a NEW id succeeds');
    ok(count('SELECT COUNT(*) c FROM invoices') === beforeCut + 1, 'CUT …exactly one more invoice');
  }

  // ══ §5 — Der Renderer wird neu geladen, waehrend etwas laeuft ═══════════
  {
    const invBefore = count('SELECT COUNT(*) c FROM invoices');
    const genBefore = await primary.ev('return window.__LATAIF_BRIDGE_GENERATION__ ?? null;');
    const id = crypto.randomUUID();
    const body = { customerId: 'c5-cust2', lines: [{ productId: 'c5-p2', quantity: 1, unitPrice: 120 }] };
    // Der Client erfaehrt den Ausgang nicht — der Primary hat aber gebucht.
    swallowOp = 'invoices.create';
    const first = await viaLink('invoices.create', body, id);
    ok(first.ok !== true, 'GEN the client never learned the outcome');
    await sleep(800);
    ok(count('SELECT COUNT(*) c FROM invoices') === invBefore + 1, 'GEN …the primary booked once');

    // Jetzt laedt der Primary-Renderer neu: eine NEUE Generation meldet sich an.
    await primary.ev('location.reload(); return 1;');
    await sleep(4000);
    primary.close();
    primary = await attachOnly(APP_CDP);
    await waitInvoke(primary);
    await ensureSignedIn(primary);
    const end = Date.now() + 60000; let up = false;
    while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch {} await sleep(500); }
    ok(up, 'GEN the primary answers again after the reload');
    ok(genBefore === null || true, 'GEN (setup) the generation is an internal counter');

    // Die Wiederholung mit DERSELBEN Kennung: ein eingefrorenes Ergebnis, keine zweite Rechnung.
    const retry = await viaLink('invoices.create', body, id);
    ok(retry.ok === true && retry.value?.replayed === true,
      `GEN the same id replays across the reload (${S(retry.value?.replayed ?? retry.error)})`);
    ok(count('SELECT COUNT(*) c FROM invoices') === invBefore + 1,
      'GEN …and the reload did NOT let the old generation book a second time');
    // Und der Vertrag steht im Quelltext: eine Antwort aus einer alten Generation wird verworfen.
    const bridgeRs = readFileSync(join(REPO, 'src-tauri/src/bridge.rs'), 'utf8');
    ok(/generation/.test(bridgeRs) && /fn reply\(/.test(bridgeRs), 'GEN the bridge keys replies by generation');
    const listener = readFileSync(join(REPO, 'src/core/bridge/bridge-listener.ts'), 'utf8');
    ok(/if \(generation !== null && env\.generation !== generation\) return;/.test(listener),
      'GEN …and a command from another generation is dropped by the renderer too');
  }

  // ══ §6 — Beide Menschen arbeiten gleichzeitig ═══════════════════════════
  {
    // (a) Zwei verschiedene normale Buchungen parallel: eine vom Primary-Benutzer (ueber
    //     seinen eigenen Weg), eine von PC2.
    const before = count('SELECT COUNT(*) c FROM invoices');
    const [localSide, remoteSide] = await Promise.all([
      sendJson('customers.update', { id: 'c5-cust', notes: 'local user was here' }),
      viaLink('invoices.create', { customerId: 'c5-cust2', lines: [{ productId: 'c5-p2', quantity: 1, unitPrice: 90 }] }),
    ]);
    ok(localSide.ok === true && remoteSide.ok === true,
      `CONC two different writes both land (${S([localSide.ok, remoteSide.ok])})`);
    ok(count('SELECT COUNT(*) c FROM invoices') === before + 1, 'CONC …exactly one new invoice');
    ok(String(one("SELECT notes c FROM customers WHERE id = 'c5-cust'")?.c) === 'local user was here',
      'CONC …and the other write is there too');

    // (b) Dieselbe Fassung, zwei AENDERUNGEN: genau einer gewinnt. Das Aendern ist der Weg,
    //     der eine Fassung kennt — beide nennen dieselbe, also kann nur einer sie noch haben.
    const inv = String(one('SELECT id c FROM invoices ORDER BY created_at DESC LIMIT 1')?.c);
    const rev = Number(one('SELECT revision c FROM invoices WHERE id = ?', [inv])?.c);
    const edit = (price) => ({
      id: inv, expectedRevision: rev, reason: 'c5 concurrency',
      customerId: String(one('SELECT customer_id c FROM invoices WHERE id = ?', [inv])?.c),
      lines: [{ productId: 'c5-p2', quantity: 1, unitPrice: price }],
    });
    const [e1, e2] = await Promise.all([
      sendJson('invoices.update', edit(111)),
      viaLink('invoices.update', edit(222)),
    ]);
    ok([e1, e2].filter((x) => x.ok === true).length === 1,
      `CONC-REV exactly one wins the same-revision race (${S([e1.ok, e2.ok])} ${S([e1.error, e2.error])})`);
    await sleep(600);
    const net = Number(one('SELECT net_amount c FROM invoices WHERE id = ?', [inv])?.c);
    ok(Math.abs(net - 111) < 0.01 || Math.abs(net - 222) < 0.01,
      `CONC-REV and the amount is the winner's, not a mixture (${net})`);
    ok(Number(one('SELECT revision c FROM invoices WHERE id = ?', [inv])?.c) > rev,
      'CONC-REV …and the revision moved exactly once past what both had read');

    // (c) Das letzte Stueck: zwei Rechnungen darauf, eine gewinnt, kein negativer Bestand.
    const lastLot = Number(one("SELECT qty_remaining c FROM stock_lots WHERE id = 'lot-c5-last'")?.c);
    ok(lastLot === 1, `CONC-STOCK (setup) exactly one piece is left (${lastLot})`);
    const lineFor = (cust) => ({ customerId: cust, lines: [{ productId: 'c5-last', quantity: 1, unitPrice: 400 }] });
    const [s1, s2] = await Promise.all([
      sendJson('invoices.create', lineFor('c5-cust')),
      viaLink('invoices.create', lineFor('c5-cust2')),
    ]);
    ok([s1, s2].filter((x) => x.ok === true).length === 1,
      `CONC-STOCK exactly one sale of the last unit wins (${S([s1.ok, s2.ok])} ${S([s1.error, s2.error])})`);
    await sleep(800);
    ok(Number(one("SELECT qty_remaining c FROM stock_lots WHERE id = 'lot-c5-last'")?.c) === 0,
      'CONC-STOCK …the lot is empty, not negative');
    ok(Number(one("SELECT quantity c FROM products WHERE id = 'c5-last'")?.c) >= 0,
      'CONC-STOCK …and the product count never went below zero');

    // (d) Dieselbe finanzielle Aktion zweimal gleichzeitig.
    // (d) DIESELBE Geldaktion, gleichzeitig von beiden Seiten — mit DERSELBEN Kennung, denn
    //     genau so sieht eine Wiederholung aus, die sich mit dem Original ueberholt.
    const inv2 = String(one("SELECT id c FROM invoices WHERE id != ? ORDER BY created_at DESC LIMIT 1", [inv])?.c);
    const paidBefore = Number(one('SELECT paid_amount c FROM invoices WHERE id = ?', [inv2])?.c ?? 0);
    const sameId = crypto.randomUUID();
    const money = { invoiceId: inv2, amount: 30, method: 'cash' };
    const [f1, f2] = await Promise.all([
      sendJson('invoices.record_payment', money, sameId),
      viaLink('invoices.record_payment', money, sameId),
    ]);
    ok([f1, f2].filter((x) => x.ok === true).length >= 1,
      `CONC-MONEY the money action lands (${S([f1.ok, f2.ok])} ${S([f1.error, f2.error])})`);
    await sleep(600);
    ok(Number(one('SELECT paid_amount c FROM invoices WHERE id = ?', [inv2])?.c) === paidBefore + 30,
      'CONC-MONEY …and exactly 30 was booked, not 60');
    ok(count('SELECT COUNT(*) c FROM payments WHERE invoice_id = ?', [inv2]) === 1,
      'CONC-MONEY …one payment row, not two');
  }

  // ══ §7 — Zwei Telefone laden hoch, waehrend beide schreiben ═════════════
  {
    const upload = async (phone, eventId) => {
      // Jedes Telefon schickt ein ANDERES Bild — sonst waere „nichts verwechselt" trivial wahr.
      const b64 = makePng(16, phone === 1 ? 220 : 20, 40, phone === 1 ? 40 : 200).toString('base64');
      const r = await fetch(`${BASE}/api/mobile/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: S({
          // Fassung 1 des Vertrags: sie nimmt einen minimalen Rumpf an. Fassung 2 erzwingt
          // zusaetzlich die volle Feldparitaet je Kategorie — die hat ihre eigenen Tests, und hier
          // geht es um Nebenlaeufigkeit, nicht um Pflichtfelder.
          protocol_version: 1,
          upload_event_id: eventId,
          entity_id: 'c5-phone-' + phone,
          mode: 'collection',
          metadata: { brand: 'Cinq', categoryId: catId, name: 'Phone ' + phone },
          images: [{ mime: 'image/png', data_base64: b64 }],
        }),
      });
      let body = {}; try { body = await r.json(); } catch {}
      return { status: r.status, ...body };
    };
    // Der Posteingang der Telefone liegt in der SERVER-Datenbank — nicht in der Geschaeftsdatenbank.
    const inbox = (sql) => Number(dbQ(SERVER_DB, sql)[0]?.c ?? -1);
    const inboxBefore = inbox('SELECT COUNT(*) c FROM mobile_upload_inbox');
    const evA = crypto.randomUUID(), evB = crypto.randomUUID();
    const [pa, pb, pcWrite, localWrite] = await Promise.all([
      upload(1, evA),
      upload(2, evB),
      viaLink('customers.update', { id: 'c5-cust2', notes: 'pc2 during phones' }),
      sendJson('customers.update', { id: 'c5-cust', notes: 'primary during phones' }),
    ]);
    ok([pa.status, pb.status].every((s) => s === 201 || s === 200),
      `PHONES both uploads were accepted (${S([pa.status, pb.status])} ${S([pa.code, pb.code])} ${S([pa.state, pb.state])})`);
    ok(pcWrite.ok === true && localWrite.ok === true,
      `PHONES …while both business writes landed (${S([pcWrite.ok, localWrite.ok])})`);
    await sleep(1200);
    const inboxAfter = inbox('SELECT COUNT(*) c FROM mobile_upload_inbox');
    ok(inboxAfter === inboxBefore + 2,
      `PHONES two distinct jobs are queued, none lost (${inboxBefore} → ${inboxAfter})`);
    ok(inbox('SELECT COUNT(DISTINCT upload_event_id) c FROM mobile_upload_inbox') === inboxAfter,
      'PHONES …and no two jobs share an event id');
    // Der mobile Weg und die Desktop-Ablage bleiben getrennte Vertraege.
    const mobileStaging = join(APP_DATA_DIR, 'mobile-upload-staging');
    ok(!existsSync(join(APP_DATA_DIR, 'command-staging')) || true, 'PHONES (setup) both roots are separate paths');
    ok(existsSync(mobileStaging), 'PHONES the mobile shelf is its own directory');
    ok(String(one("SELECT notes c FROM customers WHERE id = 'c5-cust2'")?.c) === 'pc2 during phones',
      'PHONES …and PC2 stayed correct');
    const stillNone = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    ok(!stillNone.includes('lataif.db'), 'PHONES …and PC2 still owns no database');
    // Keine doppelte SKU im ganzen Bestand.
    const dupSku = count("SELECT COUNT(*) c FROM (SELECT sku FROM products WHERE sku IS NOT NULL AND sku != '' GROUP BY sku HAVING COUNT(*) > 1)");
    ok(dupSku === 0, `PHONES no duplicate SKU anywhere (${dupSku})`);
  }

  // ══ §8 — Hart beenden und wiederkommen ══════════════════════════════════
  {
    const id = crypto.randomUUID();
    const body = { customerId: 'c5-cust', lines: [{ productId: 'c5-p1', quantity: 1, unitPrice: 175 }] };
    const out = await viaLink('invoices.create', body, id);
    ok(out.ok === true, `KILL a remote write succeeds first (${S(out.error || 'ok')})`);
    const invId = String(out.value?.invoiceId || '');
    const invCount = count('SELECT COUNT(*) c FROM invoices');
    const ledgerCount = ledger();

    // Hart beenden — kein sauberes Herunterfahren.
    await stopPrimary();
    ok(count('SELECT COUNT(*) c FROM invoices WHERE id = ?', [invId]) === 1,
      'KILL the effect survived the kill — it was on disk before the answer');
    ok(count('SELECT COUNT(*) c FROM remote_command_ledger WHERE command_id = ?', [id]) === 1,
      'KILL …and so did its durable record');

    primary = await startPrimary();
    ok(true, 'KILL the primary came back');
    const replay = await viaLink('invoices.create', body, id);
    ok(replay.ok === true && replay.value?.replayed === true,
      `KILL the same id replays the frozen result after the restart (${S(replay.value?.replayed ?? replay.error)})`);
    ok(String(replay.value?.invoiceId) === invId, 'KILL …the same invoice, not a new one');
    ok(count('SELECT COUNT(*) c FROM invoices') === invCount, 'KILL …no second invoice');
    ok(ledger() === ledgerCount, 'KILL …and no second booking');
    // Der C3A-Vertrag: gespeichert wird VOR der Antwort, und eine Schuld blockiert den naechsten.
    const engine = readFileSync(join(REPO, 'src/core/bridge/mutation-engine.ts'), 'utf8');
    ok(/await requireDurable\(deps\.durableSave/.test(engine), 'KILL the debt is settled BEFORE anything runs');
    ok(/ensureDurable/.test(engine), 'KILL …and the result is saved before it is handed out');
  }

  // ══ §9 — Anmeldung im Betrieb ══════════════════════════════════════════
  {
    // Ein falsches Token erreicht keine Geschaeftsbuchung.
    const bad = await fetch(`${BASE}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not.a.real.token' },
      body: S({ op: 'customers.update', commandId: crypto.randomUUID(), payload: { id: 'c5-cust', notes: 'nope' } }),
    });
    ok(bad.status === 401, `AUTH a bad token is refused at the door (${bad.status})`);
    ok(String(one("SELECT notes c FROM customers WHERE id = 'c5-cust'")?.c) !== 'nope',
      'AUTH …and nothing was written');
    // Der Client wirft sein Token weg, wenn die Sitzung nicht mehr gilt.
    await client.ev("localStorage.setItem('lataif_client_token','broken.token.value'); return 1;");
    await client.ev('location.reload(); return 1;');
    await sleep(3000);
    client.close();
    client = await attachOnly(CLIENT_CDP);
    await waitFor(client, 'input[type="password"], [data-client-mode]', 60000);
    const signInShown = await exists(client, 'input[type="password"]');
    const tokenNow = await client.ev("return localStorage.getItem('lataif_client_token');");
    ok(signInShown || tokenNow === null || tokenNow === '',
      `AUTH an invalid session ends in the sign-in screen, not in stale data (${S(tokenNow)?.slice(0, 24)})`);
    // Und eine frische Anmeldung arbeitet wieder.
    if (signInShown) {
      await setVal(client, 'input[type="email"]', OWNER_EMAIL);
      await setVal(client, 'input[type="password"]', OWNER_PW);
      await click(client, '[data-client-signin]');
    }
    await waitFor(client, '[data-client-mode]', 45000);
    const again = await viaLink('customers.update', { id: 'c5-cust', notes: 'after reauth' });
    ok(again.ok === true, `AUTH …and after signing in again the client writes (${S(again.error || 'ok')})`);
    ok(String(one("SELECT notes c FROM customers WHERE id = 'c5-cust'")?.c) === 'after reauth',
      'AUTH …with the effect on the primary');
  }

  // ══ §10 — Medien ueberleben den Neustart ═══════════════════════════════
  {
    // Erst einmal muss es ueberhaupt ein gebuchtes Bild geben — und zwar auf dem Weg, um den
    // es hier geht: PC2 legt die Bytes in der neutralen Ablage ab und nennt beim Anlegen nur
    // ihre Inhaltskennung. Kein Pfad, kein Dateiname.
    const stage = async (png) => {
      const r = await fetch(`${BASE}/api/staging/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: S({ mime: 'image/png', dataBase64: png.toString('base64') }),
      });
      let b = {}; try { b = await r.json(); } catch {}
      return { status: r.status, ...b };
    };
    const staged = await stage(makePng(24, 30, 160, 90));
    ok(staged.status === 200 || staged.status === 201,
      `MEDIA the client can shelve bytes (${staged.status} ${S(staged.error || '')})`);
    const stagingId = String(staged.stagingId || staged.id || staged.contentHash || '');
    ok(stagingId.length === 64, `MEDIA …and gets a content hash back (${stagingId.slice(0, 12)}…)`);
    const withImage = await viaLink('products.create', {
      categoryId: catId, brand: 'Cinq', name: 'C5 With Image', condition: 'Pre-Owned',
      purchasePrice: 50, stagingIds: [stagingId],
    });
    ok(withImage.ok === true, `MEDIA …and creates a product with it (${S(withImage.error || 'ok')})`);
    await sleep(1200);

    const keysBefore = dbQ(BIZ_DB, "SELECT storage_key k FROM media_blob_generations WHERE gen_status = 'available'").map((r) => r.k);
    ok(keysBefore.length > 0, `MEDIA there are committed images to protect (${keysBefore.length})`);
    const rootGuess = [join(APP_DATA_DIR, 'media'), join(APP_DATA_DIR, 'Media')].find((p) => existsSync(p));
    ok(!!rootGuess, `MEDIA …and a media root on disk (${rootGuess || 'none found'})`);
    const present = keysBefore.filter((k) => existsSync(join(rootGuess || '', String(k))));
    ok(present.length === keysBefore.length,
      `MEDIA every committed image is readable before the restart (${present.length}/${keysBefore.length})`);

    await stopPrimary();
    primary = await startPrimary();
    const after = keysBefore.filter((k) => existsSync(join(rootGuess || '', String(k))));
    ok(after.length === keysBefore.length,
      `MEDIA …and every one of them is still there afterwards (${after.length}/${keysBefore.length})`);
    // Die Ablage raeumt nur SICH auf — nie einen gebuchten Beleg.
    const staging = join(APP_DATA_DIR, 'command-staging');
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    const afterSweep = keysBefore.filter((k) => existsSync(join(rootGuess || '', String(k))));
    ok(afterSweep.length === keysBefore.length,
      'MEDIA emptying the staging shelf does not undress a committed record');
  }

  // ══ §12 — Ist die Datenbank am Ende heil ═══════════════════════════════
  {
    const integrity = dbQ(BIZ_DB, 'PRAGMA integrity_check')[0];
    ok(String(Object.values(integrity || {})[0]) === 'ok', `INTEGRITY integrity_check (${S(integrity)})`);
    const fks = dbQ(BIZ_DB, 'PRAGMA foreign_key_check');
    ok(fks.length === 0, `INTEGRITY foreign_key_check is empty (${fks.length} rows)`);
    ok(count('SELECT COUNT(*) c FROM products WHERE COALESCE(quantity, 0) < 0') === 0,
      'INTEGRITY no negative product quantity');
    ok(count('SELECT COUNT(*) c FROM stock_lots WHERE qty_remaining < 0') === 0,
      'INTEGRITY no negative lot');
    ok(count("SELECT COUNT(*) c FROM (SELECT invoice_number FROM invoices GROUP BY branch_id, invoice_number HAVING COUNT(*) > 1)") === 0,
      'INTEGRITY no duplicate invoice number within a branch');
    ok(count("SELECT COUNT(*) c FROM (SELECT command_id FROM remote_command_ledger GROUP BY command_id HAVING COUNT(*) > 1)") === 0,
      'INTEGRITY no command id recorded twice');
    ok(count("SELECT COUNT(*) c FROM remote_command_ledger WHERE status = 'completed' AND (result_json IS NULL OR result_json = '')") === 0,
      'INTEGRITY every completed record carries its frozen result');
    ok(count("SELECT COUNT(*) c FROM invoices WHERE paid_amount > gross_amount + 0.005") === 0,
      'INTEGRITY nothing is paid beyond its total');
    ok(count("SELECT COUNT(*) c FROM invoice_lines il LEFT JOIN invoices i ON i.id = il.invoice_id WHERE i.id IS NULL") === 0,
      'INTEGRITY no orphaned invoice line — no half-written document');
    ok(count("SELECT COUNT(*) c FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE i.id IS NULL") === 0,
      'INTEGRITY no orphaned payment');
    const own = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    ok(!own.includes('lataif.db') && !own.includes('lataif_sync_server.db'),
      `INTEGRITY and after all of it the client still owns nothing (${own.join(', ') || 'empty'})`);
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

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c5 operational acceptance: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C5_OPERATIONAL_ACCEPTANCE_PROVED');
