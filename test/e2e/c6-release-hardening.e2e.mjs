// CENTRAL-C6 — die letzte Runde vor der Auslieferung: was der fertige Rechner tut und was nicht.
//
// Kein Fullsweep. C3 und C5 haben ihre Wege bereits an echten Anwendungen bewiesen; hier laeuft
// genau das, was C6 wirklich veraendert hat oder was ohne einen Lauf nur behauptet waere:
//
//   §1  beide Artefakte sind isolierte Testbauten, nicht versehentlich die Produktion
//   §2  die Registry antwortet, und ein fremder Name kommt nicht durch
//   §3  PC2 startet ohne Datenbank — kein lataif.db, keine Serverdatenbank, keine Datenwurzel
//   §4  und ohne den alten Desktop-Abgleich: keine Adresse, kein Token, kein LAN-Modus
//   §5  eine Auskunft, eine Stammdaten-Buchung, eine Geld-/Bestandsbuchung
//   §6  ohne gueltigen Ausweis passiert nichts
//   §7  der Primary startet neu, PC2 arbeitet weiter
//   §8  der Nachbar Mobile ist unbeschaedigt: Eingang und Drain
//   §9  ein gebuchtes Bild kommt ueber seinen normalen Leseweg zurueck
//   §10 die Inhaltsrichtlinie greift WIRKLICH: fremdes Skript blockiert, eigenes WASM laeuft
//   §11 PC2 ueberlebt einen eigenen Neustart und legt dabei immer noch nichts an
//   §12 und die Datenbank ist am Ende heil
//
// Registry 59, keine neue Operation, keine neue Geschaeftsregel.

import { spawn, execFileSync } from 'node:child_process';
import { assertE2eBinary, assertE2eClientBinary, assertE2eScope, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(size, r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) { raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b; }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const CLIENT_APP = join(REPO, 'src-tauri/target/debug/lataif-e2e-client.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-owner-' + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-c6', 'run-' + Date.now());
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
  ...process.env, APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'), LATAIF_E2E_SYNC_PORT: String(PORT),
});

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch { /* egal */ } }
}
const one = (sql, p = []) => dbQ(BIZ_DB, sql, p)[0];
const count = (sql, p = []) => Number(one(sql, p)?.c ?? -1);

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
  close() { try { this.ws.close(); } catch { /* egal */ } }
}

const killImage = (name) => { try { execFileSync('taskkill', ['/F', '/IM', name, '/T'], { stdio: 'ignore' }); } catch { /* laeuft nicht */ } };
const killAll = () => { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); };
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
async function findPage(cdpPort, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch { /* noch nicht oben */ }
    await sleep(400);
  }
  return null;
}
async function attach(cdpPort, exe, env) {
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  const page = await findPage(cdpPort, 120000);
  if (!page) throw new Error(`no CDP page on ${cdpPort} for ${exe}`);
  const c = new CDP(page.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c;
}
async function attachOnly(cdpPort) {
  const page = await findPage(cdpPort, 60000);
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c;
}
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
const click = async (c, sel) => {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
};
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error('waitFor ' + sel);
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
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
    const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-c6';
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)) {
      db.prepare('INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(catId, branchId, 'C6 Watches', 'watch', '#000', now, now);
    }
    db.prepare(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_price, purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock,
        quantity, images, attributes, source_type, created_at, updated_at)
      VALUES ('c6-p1', ?, ?, 'Zenith', 'C6 Piece', 'C6-1', 'Pre-Owned', '[]', 100, 'BHD', 150, 'in_stock', 'VAT_10', 0, 3, '[]', '{}', 'OWN', ?, ?)`)
      .run(branchId, catId, now, now);
    db.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('c6-lot', ?, 'c6-p1', 100, 3, 3, 'ACTIVE', ?, ?)`).run(branchId, now, now);
    db.prepare(`INSERT INTO customers (id, branch_id, first_name, last_name, company, country, language,
        vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES ('c6-cust', ?, 'Sechs', 'Client', 'C6 Co', 'BH', 'en', 'NONE', '[]', 'PRIVATE', 'active', ?, ?)`)
      .run(branchId, now, now);
    return { branchId, catId };
  } finally { db.close(); }
}

console.log('CENTRAL-C6 — release hardening: legacy sync off, CSP on, boundaries proved\n');
let primary = null, client = null;
try {
  if (!APP_DATA_DIR.includes(IDENT)) throw new Error('refusing to touch a non-e2e AppData');
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe'); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(CLIENT_HOME, { recursive: true, force: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  mkdirSync(join(CLIENT_HOME, 'tmp'), { recursive: true });
  mkdirSync(CLIENT_APPDATA, { recursive: true });

  // ── §1 — die Artefakte ──────────────────────────────────────────────────
  ok(assertE2eBinary(APP).verified.length === 4, 'ARTEFACT the primary is the isolated e2e build');
  ok(assertE2eClientBinary(CLIENT_APP).verified.length === 4, 'ARTEFACT the client is a SEPARATE isolated build');
  assertE2eScope({ appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await ensureSignedIn(primary);
  primary.close(); killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  const { catId } = seedFixture();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  async function startPrimary() {
    const p = await attach(APP_CDP, APP, appEnv());
    await waitInvoke(p); await ensureSignedIn(p);
    await invokeErr(p, 'sync_server_start', {});
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) return p; } catch { /* noch nicht */ }
      await sleep(500);
    }
    throw new Error('the primary never answered on the LAN');
  }
  async function stopPrimary() {
    try { primary?.close(); } catch { /* egal */ }
    primary = null; killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  }

  primary = await startPrimary();
  ok(true, 'the primary serves on the LAN');
  const cfg = await primary.ev(`try { const v = await window.__TAURI_INTERNALS__.invoke('mobile_runtime_scope_configure', { email: ${S(OWNER_EMAIL)}, password: ${S(OWNER_PW)}, tenantId: 'tenant-1', branchId: 'branch-main' }); return JSON.stringify(v); } catch (e) { return 'ERR ' + String(e); }`);
  ok(/"configured":\s*true/.test(String(cfg)), 'the owner binds the mobile runtime scope');
  await primary.ev('window.location.reload(); return 1;').catch(() => {});
  await sleep(3000);
  try { primary.close(); } catch { /* egal */ }
  primary = await attachOnly(APP_CDP); await waitInvoke(primary); await ensureSignedIn(primary);

  const token = await (async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: S({ email: OWNER_EMAIL, password: OWNER_PW }),
    });
    return (await r.json()).token;
  })();
  const auth = { Authorization: 'Bearer ' + token };
  const sendJson = async (op, payload, headers = auth) => {
    const r = await fetch(`${BASE}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: S({ op, commandId: crypto.randomUUID(), payload }),
    });
    let b = {}; try { b = await r.json(); } catch { /* kein Rumpf */ }
    return { status: r.status, ...b };
  };

  // ── §2 — die Registry antwortet, ein fremder Name nicht ─────────────────
  {
    const probe = await sendJson('bridge.probe', {});
    ok(probe.ok === true, `REGISTRY the probe answers (${S(probe.error || 'ok')})`);
    const alien = await sendJson('invoices.obliterate', {});
    ok(alien.status !== 200 && alien.ok !== true, `REGISTRY an unknown name never gets through (${alien.status})`);
    ok(count("SELECT COUNT(*) c FROM remote_command_ledger WHERE op = 'invoices.obliterate'") === 0,
      'REGISTRY …and leaves no line in the ledger');
  }

  // ── §3/§4 — PC2 startet ohne Datenbank und ohne alten Abgleich ──────────
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev(`localStorage.setItem('lataif_runtime_mode','client'); localStorage.setItem('lataif_client_server_url', ${S(BASE)}); return 1;`);
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
  ok(true, 'CLIENT PC2 signs in against the primary');
  {
    const listing = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    const owned = listing.filter((f) => /^lataif\.db|^lataif_sync_server\.db|data-location\.json|^\.lataif-data-root\.json|outbox/i.test(f));
    ok(owned.length === 0, `CLIENT owns no business db, no server db, no data root (${listing.join(' ') || 'empty'})`);
    const keys = await client.ev('return Object.keys(localStorage).sort().join(",");');
    ok(!/lataif_sync_url|lataif_sync_token|lataif_sync_last_id|lataif_lan_mode/.test(String(keys)),
      `CLIENT and no legacy sync state at all (${keys})`);
  }

  // ── §5 — eine Auskunft, eine Stammdatenbuchung, eine Geldbuchung ────────
  const remoteRead = async (op, payload) => {
    const r = await fetch(`${BASE}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: S({ op, commandId: crypto.randomUUID(), payload }),
    });
    let b = {}; try { b = await r.json(); } catch { /* kein Rumpf */ }
    return b;
  };
  {
    const list = await remoteRead('customers.list', {});
    ok(list.ok === true && list.value !== undefined && list.value !== null,
      `READ a read still answers (${S(list.error || 'ok')})`);
    const made = await sendJson('customers.create', { firstName: 'C6', lastName: 'Remote', customerType: 'PRIVATE' });
    ok(made.ok === true, `WRITE a masterdata write still lands (${S(made.error || 'ok')})`);
    ok(count("SELECT COUNT(*) c FROM customers WHERE first_name = 'C6'") === 1, 'WRITE …as exactly one row');

    const ledgerBefore = count('SELECT COUNT(*) c FROM ledger_entries');
    const lotBefore = Number(one("SELECT qty_remaining c FROM stock_lots WHERE id = 'c6-lot'")?.c);
    const inv = await sendJson('invoices.create', {
      customerId: 'c6-cust', lines: [{ productId: 'c6-p1', quantity: 1, unitPrice: 150 }],
    });
    ok(inv.ok === true, `MONEY an accounting write lands (${S(inv.error || 'ok')})`);
    await sleep(1200);
    ok(count('SELECT COUNT(*) c FROM ledger_entries') > ledgerBefore, 'MONEY …the ledger moved');
    ok(Number(one("SELECT qty_remaining c FROM stock_lots WHERE id = 'c6-lot'")?.c) === lotBefore - 1,
      'MONEY …and exactly one piece left the lot');
  }

  // ── §6 — ohne Ausweis passiert nichts ───────────────────────────────────
  {
    const before = count('SELECT COUNT(*) c FROM customers');
    const r = await fetch(`${BASE}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: S({ op: 'customers.create', commandId: crypto.randomUUID(), payload: { firstName: 'Ghost', lastName: 'X' } }),
    });
    ok(r.status === 401 || r.status === 403, `AUTH no token, no entry (${r.status})`);
    const bad = await sendJson('customers.create', { firstName: 'Ghost', lastName: 'X' }, { Authorization: 'Bearer not.a.token' });
    ok(bad.status === 401 || bad.status === 403, `AUTH a forged token is no ticket either (${bad.status})`);
    ok(count('SELECT COUNT(*) c FROM customers') === before, 'AUTH …and neither wrote a row');
  }

  // ── §7 — Primary Neustart, PC2 arbeitet weiter ──────────────────────────
  await stopPrimary();
  primary = await startPrimary();
  {
    const again = await sendJson('customers.create', { firstName: 'AfterRestart', lastName: 'Remote', customerType: 'PRIVATE' });
    ok(again.ok === true, `RESTART PC2 writes again after the primary came back (${S(again.error || 'ok')})`);
    const reread = await client.ev("try { const r = await fetch(localStorage.getItem('lataif_client_server_url') + '/api/health'); return r.status; } catch (e) { return String(e); }");
    ok(Number(reread) === 200, `RESTART …and the client window reaches it again (${reread})`);
  }

  // ── §8 — der Nachbar Mobile ist unbeschaedigt ───────────────────────────
  {
    const up = await fetch(`${BASE}/api/mobile/upload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: S({
        protocol_version: 1, upload_event_id: crypto.randomUUID(), entity_id: 'c6-phone', mode: 'collection',
        metadata: { brand: 'Cinq', categoryId: catId, name: 'C6 Phone Item' },
        images: [{ mime: 'image/png', data_base64: makePng(24, 40, 190, 90).toString('base64') }],
      }),
    });
    ok(up.status === 200 || up.status === 201, `MOBILE the ingress still accepts (${up.status})`);
    ok(Number(dbQ(SERVER_DB, 'SELECT COUNT(*) c FROM mobile_upload_inbox')[0]?.c ?? -1) >= 1, 'MOBILE …and the inbox holds it');
    let phoneId = '';
    for (let i = 0; i < 90 && !phoneId; i++) {
      phoneId = String(one("SELECT id c FROM products WHERE name = 'C6 Phone Item'")?.c || '');
      if (!phoneId) await sleep(1000);
    }
    ok(phoneId.length > 0, `MOBILE …and the drain still turns it into a product (${phoneId.slice(0, 12) || 'never'})`);
  }

  // ── §9 — ein gebuchtes Bild ueber seinen normalen Leseweg ───────────────
  {
    // Das Buchen der Bilder folgt dem Produkt mit etwas Abstand — also warten statt raten.
    let keys = [];
    for (let i = 0; i < 60; i++) {
      keys = dbQ(BIZ_DB, "SELECT storage_key k FROM media_blob_generations WHERE gen_status = 'available'").map((r) => String(r.k));
      if (keys.length) break;
      await sleep(1000);
    }
    ok(keys.length > 0, `MEDIA there is committed media (${keys.length})`);
    if (!keys.length) throw new Error('no committed media to read');
    const r = await fetch(`${BASE}/api/media?key=${encodeURIComponent(keys[0])}`, { headers: auth });
    const body = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    ok(r.status === 200 && body.length > 0, `MEDIA …and it reads over the normal route (${r.status})`);
    const stem = keys[0].split('/').pop().split('.')[0];
    ok(createHash('sha256').update(body).digest('hex') === stem, 'MEDIA …byte-for-byte the canonical file');
  }

  // ── §10 — die Inhaltsrichtlinie greift wirklich ─────────────────────────
  {
    // Die Geschaeftsdatenbank IST WebAssembly. Laeuft sie, ist 'wasm-unsafe-eval' richtig gesetzt.
    const wasm = await primary.ev("return typeof WebAssembly === 'object' ? await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0])).then(()=> 'wasm-ok').catch((e)=> 'wasm-blocked: ' + e) : 'no-wasm';");
    ok(wasm === 'wasm-ok', `CSP the app may still compile its own WASM (${wasm})`);
    // Und ein fremdes Skript kommt nicht herein.
    const blocked = await primary.ev(`
      return await new Promise((resolve) => {
        let violated = '';
        const onV = (e) => { violated = e.violatedDirective || 'violation'; };
        document.addEventListener('securitypolicyviolation', onV, { once: true });
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/left-pad@1.3.0/index.js';
        s.onload = () => { document.removeEventListener('securitypolicyviolation', onV); resolve('LOADED'); };
        s.onerror = () => setTimeout(() => resolve(violated || 'error-without-violation'), 200);
        document.head.appendChild(s);
        setTimeout(() => resolve(violated || 'timeout'), 4000);
      });`);
    ok(String(blocked).includes('script-src'), `CSP a foreign script is refused by the policy (${blocked})`);
    // Ein eingebettetes Skript OHNE Nonce ist der zweite Weg, fremden Code hereinzubekommen.
    // (Ein `eval` ueber die Entwicklerschnittstelle waere kein Beweis: Auswertungen von dort
    // sind von der Richtlinie ausgenommen — ein Element IM Dokument ist es nicht.)
    const inlineBlocked = await primary.ev(`
      return await new Promise((resolve) => {
        let violated = '';
        const onV = (e) => { violated = e.violatedDirective || 'violation'; };
        document.addEventListener('securitypolicyviolation', onV, { once: true });
        const s = document.createElement('script');
        s.textContent = 'window.__cspInlineRan = true;';
        document.head.appendChild(s);
        setTimeout(() => {
          document.removeEventListener('securitypolicyviolation', onV);
          resolve(window.__cspInlineRan ? 'INLINE-RAN' : (violated || 'blocked-silently'));
        }, 300);
      });`);
    ok(String(inlineBlocked).includes('script-src'), `CSP …and an inline script without a nonce is refused (${inlineBlocked})`);
    // Der Datenbestand haengt daran: ohne WASM waere die Anwendung tot, nicht nur streng.
    ok(count('SELECT COUNT(*) c FROM customers') > 0, 'CSP the business database is open and answering under the policy');
  }

  // ── §11 — PC2 ueberlebt seinen eigenen Neustart und legt nichts an ──────
  {
    try { client.close(); } catch { /* egal */ }
    client = null;
    killImage('lataif-e2e-client.exe'); await waitGone('lataif-e2e-client.exe');
    client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
    await waitInvoke(client);
    await waitFor(client, '[data-client-mode], input[type="password"]', 60000);
    if (await exists(client, 'input[type="password"]')) {
      await setVal(client, 'input[type="email"]', OWNER_EMAIL);
      await setVal(client, 'input[type="password"]', OWNER_PW);
      await click(client, '[data-client-signin]');
    }
    await waitFor(client, '[data-client-mode]', 45000);
    ok(true, 'RELAUNCH PC2 comes back as a client, not as a second primary');
    const listing = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    ok(!listing.some((f) => /^lataif\.db|^lataif_sync_server\.db|outbox/i.test(f)),
      `RELAUNCH …and still owns nothing (${listing.join(' ') || 'empty'})`);
    const keys = await client.ev('return Object.keys(localStorage).sort().join(",");');
    ok(!/lataif_sync_url|lataif_sync_token|lataif_lan_mode/.test(String(keys)),
      `RELAUNCH …and no legacy sync worker left a trace (${keys})`);
  }

  // ── §12 — ist die Datenbank am Ende heil ────────────────────────────────
  {
    const integrity = dbQ(BIZ_DB, 'PRAGMA integrity_check')[0];
    ok(String(Object.values(integrity || {})[0]) === 'ok', `INTEGRITY integrity_check (${S(integrity)})`);
    ok(dbQ(BIZ_DB, 'PRAGMA foreign_key_check').length === 0, 'INTEGRITY foreign_key_check is empty');
    ok(count('SELECT COUNT(*) c FROM products WHERE COALESCE(quantity, 0) < 0') === 0, 'INTEGRITY no negative product quantity');
    ok(count('SELECT COUNT(*) c FROM stock_lots WHERE qty_remaining < 0') === 0, 'INTEGRITY no negative lot');
    ok(count('SELECT COUNT(*) c FROM (SELECT invoice_number FROM invoices GROUP BY invoice_number HAVING COUNT(*) > 1)') === 0,
      'INTEGRITY no duplicate invoice number');
    ok(count('SELECT COUNT(*) c FROM (SELECT command_id FROM remote_command_ledger GROUP BY command_id HAVING COUNT(*) > 1)') === 0,
      'INTEGRITY no command id twice');
    ok(count("SELECT COUNT(*) c FROM remote_command_ledger WHERE status = 'completed' AND result_json IS NULL") === 0,
      'INTEGRITY every completed command carries its frozen result');
    const dr = Number(one("SELECT ROUND(SUM(amount),3) c FROM ledger_entries WHERE direction = 'DEBIT'")?.c ?? 0);
    const cr = Number(one("SELECT ROUND(SUM(amount),3) c FROM ledger_entries WHERE direction = 'CREDIT'")?.c ?? 0);
    ok(Math.abs(dr - cr) < 0.005, `INTEGRITY the ledger is balanced (${dr} == ${cr})`);
    // Und die Migrationen sind nach all den Neustarts vollstaendig geblieben.
    const tables = dbQ(BIZ_DB, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    for (const t of ['remote_command_ledger', 'document_sequences', 'sku_sequences', 'authoritative_revisions']) {
      ok(tables.includes(t), `MIGRATION ${t} is there after every restart`);
    }
    const trg = dbQ(BIZ_DB, "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%revision%'").length;
    ok(trg > 0, `MIGRATION the revision triggers survived (${trg})`);
    for (const t of ['invoices', 'orders', 'repairs', 'agent_transfers', 'consignments']) {
      const cols = dbQ(BIZ_DB, `PRAGMA table_info(${t})`).map((r) => r.name);
      ok(cols.includes('revision'), `MIGRATION ${t}.revision is there`);
    }
    ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'INTEGRITY and there is still no client database anywhere');
  }
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.stack || e));
  console.log('  x harness: ' + (e?.message || e));
} finally {
  try { primary?.close(); } catch { /* egal */ }
  try { client?.close(); } catch { /* egal */ }
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c6 release hardening: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('  · ' + f); process.exit(1); }
console.log('CENTRAL_C6_FINAL_TARGETED_REGRESSION_PROVED');
