// CENTRAL-C5 FINAL §2 — gebuchte Bilder ueberleben den kompletten Neustart des Primary.
//
// Die Abnahme (`c5-operational-acceptance.e2e.mjs`) hat bereits gezeigt, dass ein von PC2
// angelegtes Bild nach einem Neustart noch auf der Platte liegt. Hier geht es um die Frage
// dahinter, und zwar auf allen drei Wegen, auf denen ein Bild ueberhaupt gebucht wird:
//
//   A  PC2 legt ein Produkt MIT Bild an        (products.create + Ablage)
//   B  PC2 aendert die Galerie dieses Produkts (products.update + Ablage, altes Bild behalten)
//   C  Ein Telefon laedt hoch                  (/api/mobile/upload → Eingang → Drain)
//
// Danach wird der Primary komplett beendet und neu gestartet, und alle drei muessen ueber ihren
// NORMALEN Leseweg wieder herauskommen: `GET /api/media?key=…`, dieselbe Route, die auch die
// Trefferliste und das Telefon benutzen. Nicht „die Datei liegt da", sondern „der Verbraucher
// bekommt sie".
//
// Zwei Dinge werden dabei mitbewiesen, weil sie sonst leicht verwechselt werden:
//   • Die Bytes kommen aus der kanonischen Ablage, nicht aus der Durchreiche: der Schluessel IST
//     der SHA-256 der Bytes, und genau der wird nachgerechnet.
//   • Die Muellabfuhr der Durchreiche kann einem gebuchten Beleg nichts anhaben: die Staging-
//     Verzeichnisse werden vollstaendig geloescht — haerter als jede echte GC — und danach liest
//     sich alles unveraendert.
//
// Kein neuer Produktcode, keine neue Medienarchitektur, keine neue Operation.

import { spawn, execFileSync } from 'node:child_process';
import { assertE2eBinary, assertE2eScope, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';

// ── Ein echtes, dekodierbares PNG, je Farbe ein anderer Hash ────────────────
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
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-owner-' + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-c5-media', 'run-' + Date.now());
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
  finally { try { db?.close(); } catch { /* egal */ } }
}
const one = (sql, p = []) => dbQ(BIZ_DB, sql, p)[0];

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
    } catch { /* noch nicht oben */ }
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
    } catch { /* noch nicht */ }
    await sleep(400);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO'; b.click(); return 'OK';`);
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

/** Eine Kategorie — mehr braucht dieser Test an Stammdaten nicht. */
function seedCategory() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branchId = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const catId = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-c5m';
    if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)) {
      db.prepare('INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(catId, branchId, 'C5 Media', 'watch', '#000', now, now);
    }
    return { branchId, catId };
  } finally { db.close(); }
}

console.log('CENTRAL-C5 FINAL — committed media survives a full primary restart\n');
let primary = null;
try {
  if (!APP_DATA_DIR.includes(IDENT)) throw new Error('refusing to touch a non-e2e AppData');
  killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });

  ok(assertE2eBinary(APP).verified.length === 4, 'the primary artefact is the isolated e2e build');
  assertE2eScope({ appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await ensureSignedIn(primary);
  primary.close(); killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  const { catId } = seedCategory();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  async function startPrimary() {
    const p = await attach(APP_CDP, APP, appEnv());
    await waitInvoke(p);
    await ensureSignedIn(p);
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
    primary = null;
    killImage('lataif.exe'); await waitGone('lataif.exe'); await waitPortFree(PORT);
  }

  primary = await startPrimary();
  ok(true, 'the primary serves on the LAN');

  // Der Drain der Telefone laeuft nur bei konfigurierter Bindung, und der Poller wird im
  // POST-AUTH-Pfad bewaffnet. Also erst binden, dann die Anmeldung erneut durchlaufen —
  // dieselbe Reihenfolge, die auch ein Besitzer in den Einstellungen erzeugt.
  const cfg = await primary.ev(`try { const v = await window.__TAURI_INTERNALS__.invoke('mobile_runtime_scope_configure', { email: ${S(OWNER_EMAIL)}, password: ${S(OWNER_PW)}, tenantId: 'tenant-1', branchId: 'branch-main' }); return JSON.stringify(v); } catch (e) { return 'ERR ' + String(e); }`);
  ok(/"configured":\s*true/.test(String(cfg)), `the owner binds the mobile runtime scope (${String(cfg).slice(0, 90)})`);
  await primary.ev('window.location.reload(); return 1;').catch(() => {});
  await sleep(3000);
  try { primary.close(); } catch { /* egal */ }
  primary = await attachOnly(APP_CDP);
  await waitInvoke(primary);
  await ensureSignedIn(primary);

  const token = await (async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: S({ email: OWNER_EMAIL, password: OWNER_PW }),
    });
    return (await r.json()).token;
  })();
  const auth = { Authorization: 'Bearer ' + token };
  const sendJson = async (op, payload) => {
    const r = await fetch(`${BASE}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: S({ op, commandId: crypto.randomUUID(), payload }),
    });
    let b = {}; try { b = await r.json(); } catch { /* kein Rumpf */ }
    return { status: r.status, ...b };
  };
  /** Bytes in die neutrale Ablage legen; zurueck kommt ihre Inhaltskennung. */
  const stage = async (png) => {
    const r = await fetch(`${BASE}/api/staging/media`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: S({ mime: 'image/png', dataBase64: png.toString('base64') }),
    });
    let b = {}; try { b = await r.json(); } catch { /* kein Rumpf */ }
    return String(b.stagingId || b.id || b.contentHash || '');
  };
  const keysOf = (entityId) => dbQ(BIZ_DB, `
    SELECT g.storage_key k, g.gen_status s, g.stored_blob_hash h
      FROM media_links l
      JOIN media_objects o ON o.media_id = l.media_id
      JOIN media_blob_generations g ON g.blob_id = o.master_blob_id
     WHERE l.entity_id = ? AND l.deleted_at IS NULL AND g.gen_status = 'available'`, [entityId]);

  // ── A — PC2 legt ein Produkt MIT Bild an ─────────────────────────────────
  const sidA = await stage(makePng(24, 210, 40, 40));
  ok(sidA.length === 64, `A the client can shelve bytes and gets a content hash (${sidA.slice(0, 12)}…)`);
  const created = await sendJson('products.create', {
    categoryId: catId, brand: 'Cinq', name: 'C5M With Image', condition: 'Pre-Owned',
    purchasePrice: 50, stagingIds: [sidA],
  });
  ok(created.ok === true, `A …and creates a product with it (${S(created.error || 'ok')})`);
  const productId = String(created.value?.productId || '');
  ok(productId.length > 0, `A …and the product has an id (${productId.slice(0, 12)}…)`);
  await sleep(1500);
  const afterCreate = keysOf(productId);
  ok(afterCreate.length === 1, `A one committed image on the new product (${afterCreate.length})`);

  // ── B — PC2 aendert die Galerie: altes Bild behalten, neues dazu ─────────
  const mediaA = String(one('SELECT media_id c FROM media_links WHERE entity_id = ? AND deleted_at IS NULL', [productId])?.c || '');
  const sidB = await stage(makePng(24, 30, 40, 200));
  ok(sidB.length === 64 && sidB !== sidA, 'B a SECOND, different image is shelved');
  const edited = await sendJson('products.update', {
    id: productId, gallery: [{ keep: mediaA }, { stagingId: sidB }],
  });
  ok(edited.ok === true, `B …and the gallery change is committed (${S(edited.error || 'ok')})`);
  await sleep(1500);
  const afterEdit = keysOf(productId);
  ok(afterEdit.length === 2, `B the product now carries two committed images (${afterEdit.length})`);

  // ── C — Ein Telefon laedt hoch ───────────────────────────────────────────
  const evId = crypto.randomUUID();
  const up = await fetch(`${BASE}/api/mobile/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: S({
      protocol_version: 1, upload_event_id: evId, entity_id: 'c5m-phone', mode: 'collection',
      metadata: { brand: 'Cinq', categoryId: catId, name: 'C5M Phone Item' },
      images: [{ mime: 'image/png', data_base64: makePng(24, 40, 190, 90).toString('base64') }],
    }),
  });
  ok(up.status === 200 || up.status === 201, `C the phone upload is accepted (${up.status})`);
  ok(Number(dbQ(SERVER_DB, 'SELECT COUNT(*) c FROM mobile_upload_inbox')[0]?.c ?? -1) >= 1,
    'C …and lands in the phone inbox on the server side');
  // Der Drain laeuft nach der Anmeldung von selbst. Ihm wird Zeit gegeben; nach der Haelfte ein
  // Neuladen, weil genau das der Weg ist, auf dem der Poller neu bewaffnet wird.
  const findPhone = () => String(one("SELECT id c FROM products WHERE name = 'C5M Phone Item'")?.c || '');
  let phoneId = '';
  for (let i = 0; i < 60 && !phoneId; i++) { phoneId = findPhone(); if (!phoneId) await sleep(1000); }
  if (!phoneId) {
    await primary.ev('window.location.reload(); return 1;').catch(() => {});
    await sleep(4000);
    try { primary.close(); } catch { /* egal */ }
    primary = await attachOnly(APP_CDP); await waitInvoke(primary); await ensureSignedIn(primary);
    for (let i = 0; i < 60 && !phoneId; i++) { phoneId = findPhone(); if (!phoneId) await sleep(1000); }
  }
  ok(phoneId.length > 0, `C …and the drain turns it into a real product (${phoneId.slice(0, 12) || 'never'})`);
  let phoneKeys = [];
  for (let i = 0; i < 60; i++) { phoneKeys = keysOf(phoneId); if (phoneKeys.length) break; await sleep(1000); }
  ok(phoneKeys.length >= 1, `C …with committed media of its own (${phoneKeys.length})`);

  // ── Die drei Schluessel, um die es geht ──────────────────────────────────
  const keys = [...afterEdit.map((r) => r.k), ...phoneKeys.map((r) => r.k)];
  ok(new Set(keys).size === keys.length, `three DIFFERENT committed images (${keys.length})`);

  /** Ein Bild ueber den NORMALEN Leseweg holen — genau so, wie es die Oberflaeche tut. */
  const readMedia = async (key) => {
    const r = await fetch(`${BASE}/api/media?key=${encodeURIComponent(key)}`, { headers: auth });
    const body = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    return { status: r.status, type: r.headers.get('content-type') || '', body };
  };
  const before = [];
  for (const k of keys) before.push(await readMedia(k));
  ok(before.every((r) => r.status === 200 && r.body.length > 0),
    `all three read over the normal media route BEFORE the restart (${S(before.map((r) => r.status))})`);

  // ── Der komplette Neustart ───────────────────────────────────────────────
  await stopPrimary();
  primary = await startPrimary();
  ok(true, 'the primary has been fully restarted');

  const after = [];
  for (const k of keys) after.push(await readMedia(k));
  ok(after.every((r) => r.status === 200), `all three still answer 200 afterwards (${S(after.map((r) => r.status))})`);
  ok(after.every((r) => /^image\//.test(r.type)), `…as images (${S(after.map((r) => r.type))})`);
  ok(after.every((r, i) => r.body.equals(before[i].body)), '…byte-for-byte what they were before');

  // Der Schluessel IST der Inhalt: was hier herauskommt, kann nichts anderes sein als das
  // kanonische Original. Eine Durchreiche-Kopie wuerde diese Rechnung nicht bestehen.
  const stems = keys.map((k) => String(k).split('/').pop().split('.')[0]);
  ok(after.every((r, i) => createHash('sha256').update(r.body).digest('hex') === stems[i]),
    'each answer hashes to its own storage key — canonical bytes, not a staging copy');

  // Und sie liegen wirklich in der kanonischen Ablage, nicht in einer Durchreiche.
  const mediaRoot = [join(APP_DATA_DIR, 'media'), join(APP_DATA_DIR, 'Media')].find((p) => existsSync(p));
  ok(!!mediaRoot, `a canonical media root exists (${mediaRoot || 'none'})`);
  ok(keys.every((k) => existsSync(join(mediaRoot || '', String(k)))),
    'every committed key resolves to a file under that root');

  // ── Die Muellabfuhr der Durchreiche darf gebuchte Belege nicht anfassen ──
  const stagingDirs = readdirSync(APP_DATA_DIR).filter((f) => /staging/i.test(f));
  console.log('  staging dirs: ' + (stagingDirs.join(' ') || '(none)'));
  ok(!stagingDirs.some((d) => keys.some((k) => existsSync(join(APP_DATA_DIR, d, String(k))))),
    'no committed key lives inside a staging shelf');
  // Haerter als jede echte GC: die Durchreiche wird komplett geloescht.
  for (const d of stagingDirs) rmSync(join(APP_DATA_DIR, d), { recursive: true, force: true });
  const afterSweep = [];
  for (const k of keys) afterSweep.push(await readMedia(k));
  ok(afterSweep.every((r, i) => r.status === 200 && r.body.equals(before[i].body)),
    'wiping every staging shelf leaves all three committed images untouched');
  ok(keys.every((k) => Number(dbQ(BIZ_DB, "SELECT COUNT(*) c FROM media_blob_generations WHERE storage_key = ? AND gen_status = 'available'", [k])[0]?.c ?? 0) === 1),
    '…and each is still booked as available in the database');
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.stack || e));
  console.log('  x harness: ' + (e?.message || e));
} finally {
  try { primary?.close(); } catch { /* egal */ }
  killImage('lataif.exe');
  await waitGone('lataif.exe');
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central c5 media restart durability: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('  · ' + f); process.exit(1); }
console.log('CENTRAL_C5_MEDIA_DURABILITY_PROVED');
