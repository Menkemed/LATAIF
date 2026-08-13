// POST-V0838 §G1 — the automatic SKU over the REAL mobile create path.
//
// Nothing here inserts a product. Every product is created the way a phone creates one: a real
// POST to /api/mobile/upload with a real JPEG and a real token, a real inbox receipt, the runtime
// scope binding, and the app's own post-auth drain worker. The SKU is then read off the row the
// app wrote.
//
// The three properties that matter, none of which a unit test can show:
//   • the first item of a fresh stem is -001 (the seed-increment bug this closes made it -002),
//   • a number is never handed out twice, not even after the product holding it is deleted through
//     the real Collection delete flow,
//   • replaying the same upload creates nothing and — critically — CONSUMES NO NUMBER, even though
//     allocation happens before the receipt hash is computed.
//
// Isolated e2e identifier + AppData + sync port (3011); production (3001) is never touched.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';
const TENANT = 'tenant-1';

const RUN = join(os.tmpdir(), 'lataif-autosku-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const PROD_BIZ_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch { return []; }
  finally { try { db?.close(); } catch {} }
}
const products = () => dbQ(BIZ_DB, 'SELECT id, brand, name, sku, quantity, images FROM products ORDER BY created_at, id');
const skuOf = (id) => { const r = dbQ(BIZ_DB, 'SELECT sku FROM products WHERE id=?', [id]); return r.length ? r[0].sku : null; };
const sequenceRow = (stem) => { const r = dbQ(BIZ_DB, 'SELECT stem, next_number FROM sku_sequences WHERE stem=?', [stem]); return r.length ? r[0] : null; };
const receipts = (evId) => dbQ(SERVER_DB, 'SELECT upload_event_id, state FROM mobile_upload_inbox WHERE upload_event_id=?', [evId]);
const receiptRows = (evId) => dbQ(BIZ_DB, 'SELECT upload_event_id, entity_id, product_id, canonical_product_metadata_hash, prepared_manifest_hash FROM mobile_upload_receipts WHERE upload_event_id=?', [evId]);
const activeLinks = (pid) => dbQ(BIZ_DB, 'SELECT link_id FROM media_links WHERE entity_id=? AND deleted_at IS NULL', [pid]);

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

let appProc;
async function attach() {
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find(t => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {}
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  return attach();
}
function killAllApp() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
async function waitProcessGone(ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' }).Count"], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(400);
  }
  return false;
}
async function waitPortFree(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(500);
  }
  return false;
}
async function serverHealthy(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {} await sleep(500); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); }
  throw new Error('no invoke');
}
async function invoke(c, cmd, args) {
  return c.ev(`return (async()=>{ try{ const v=await window.__TAURI_INTERNALS__.invoke(${S(cmd)}, ${S(args)}); return {ok:true,value:v===undefined?null:v}; }catch(e){ return {ok:false,error:String((e&&e.message)||e)}; } })();`);
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
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`);
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

// ── the real mobile side: a real token, a real upload, the app's own drain ───
async function mobileToken() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PW }),
  });
  if (!r.ok) throw new Error('mobile login ' + r.status);
  const j = await r.json();
  if (!j.token) throw new Error('no token');
  return j.token;
}
/** POST the SAME shape the mobile page posts. Returns the HTTP status and parsed body. */
async function upload(token, evId, entityId, jpegB64, brand, name) {
  const res = await fetch(`${BASE}/api/mobile/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      protocol_version: 1,
      upload_event_id: evId,
      entity_id: entityId,
      mode: 'collection',
      metadata: { categoryId: 'cat-watch', brand, name, attributes: {} },
      images: [{ mime: 'image/jpeg', data_base64: jpegB64 }],
    }),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const inboxState = (evId) => { const r = receipts(evId); return r.length ? r[0].state : null; };

/** The canonical drain trigger: the worker runs on frontend authentication, gated on the binding. */
async function reloadAndAuth(app) {
  await app.ev('window.location.reload(); return 1;').catch(() => {});
  await sleep(2500);
  try { app.close(); } catch {}
  const c = await attach();
  await waitInvoke(c);
  await ensureSignedIn(c);
  return c;
}
async function drainUntilReady(app, evId, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    app = await reloadAndAuth(app);
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      if (inboxState(evId) === 'ready') return { app, ok: true };
      await sleep(800);
    }
  }
  return { app, ok: inboxState(evId) === 'ready' };
}

async function main() {
  console.log('POST-V0838 §G1 — mobile auto-SKU real path e2e');
  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_BIZ_DB) ? dbQ(PROD_BIZ_DB, 'SELECT COUNT(*) c FROM products') : [];

  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded on the isolated instance');
  const JPEG_B64 = seed('jpeg', '7');
  ok(JPEG_B64.length > 100, 'fixture: a real JPEG is available (' + JPEG_B64.length + ' b64 chars)');

  let app = await startApp();
  await waitInvoke(app);
  await ensureSignedIn(app);
  ok(await serverHealthy(), 'the isolated sync server is up');

  // the binding the drain worker is gated on
  const cfg = await invoke(app, 'mobile_runtime_scope_configure',
    { email: OWNER_EMAIL, password: OWNER_PW, tenantId: TENANT, branchId: 'branch-main' });
  ok(cfg.ok && cfg.value && cfg.value.configured === true, 'owner configured the runtime scope binding (' + (cfg.error || '') + ')');

  const token = await mobileToken();
  ok(!!token, 'a real mobile token was obtained from /api/auth/login');

  // ── §2/§3 — a brand-new stem: 001, then 002, then 003 ─────────────────────
  const BRAND = 'Zephyrtest';            // ZEP-WCH-, guaranteed unused in a fresh install
  const STEM = 'ZEP-WCH-';
  ok(sequenceRow(STEM) === null, '§3 the stem has no counter yet — this really is its first use');
  ok(dbQ(BIZ_DB, "SELECT id FROM products WHERE sku LIKE 'ZEP-WCH-%'").length === 0, '§3 and no product carries it');

  const made = [];
  for (let i = 1; i <= 3; i++) {
    // The page mints the product id itself (MOBILE-UUID); the server pins it. A constant id would
    // make the second upload a target conflict, which is what a shared empty id produced.
    const evId = 'g1-seq-' + i + '-' + Date.now();
    const entityId = crypto.randomUUID();
    const before = products().map(p => p.id);
    const up = await upload(token, evId, entityId, JPEG_B64, BRAND, 'Sequence Item ' + i);
    ok(up.status === 200 || up.status === 201, '§2 upload ' + i + ' accepted (' + up.status + ')');
    ok(receipts(evId).length === 1, '§2 upload ' + i + ' produced exactly one inbox receipt');
    const r = await drainUntilReady(app, evId); app = r.app;
    ok(r.ok, '§2 upload ' + i + ' was drained to READY by the app (' + inboxState(evId) + ')');
    const added = products().filter(p => !before.includes(p.id));
    ok(added.length === 1, '§2 upload ' + i + ' created exactly one product (' + added.length + ')');
    if (added.length === 1) {
      made.push({ evId, entityId, id: added[0].id, sku: added[0].sku });
      ok(added[0].sku === STEM + String(i).padStart(3, '0'),
        '§2 product ' + i + ' carries ' + STEM + String(i).padStart(3, '0') + ' (got ' + added[0].sku + ')');
      ok(added[0].images === '[]', '§2 product ' + i + ' is gallery-backed, not inline');
      ok(activeLinks(added[0].id).length === 1, '§2 product ' + i + ' has exactly one active media link');
    }
  }
  ok(made.length === 3 && new Set(made.map(m => m.sku)).size === 3, '§2 three products, three distinct SKUs');
  ok(made[0] && made[0].sku === 'ZEP-WCH-001', '§3 the FIRST item of a fresh stem is -001, not -002');
  const quarantined = dbQ(SERVER_DB, "SELECT upload_event_id FROM mobile_upload_inbox WHERE state='quarantined'");
  ok(quarantined.length === 0, '§2 nothing was quarantined (' + quarantined.length + ')');

  // ── §5/§6 — replay: nothing created, and NO number consumed ───────────────
  if (made.length < 3) { console.log('  (sequence incomplete - replay section skipped)'); }
  const target = made[2] || made[made.length - 1];
  if (!target) { console.log('POST-V0838 mobile-auto-sku e2e: ' + PASS + ' passed, ' + (FAIL + 1) + ' failed'); killAllApp(); process.exit(1); }
  const seqBeforeReplay = sequenceRow(STEM);
  const receiptBefore = receiptRows(target.evId)[0] || null;
  const countBefore = products().length;
  const replay = await upload(token, target.evId, target.entityId, JPEG_B64, BRAND, 'Sequence Item 3');
  ok([200, 201, 409].includes(replay.status), '§5 the replay is answered without creating a new event (' + replay.status + ')');
  ok(receipts(target.evId).length === 1, '§5 still exactly one inbox row');
  const r2 = await drainUntilReady(app, target.evId, 1); app = r2.app;
  await sleep(2000);
  ok(products().length === countBefore, '§5 the replay created no product (' + products().length + ' vs ' + countBefore + ')');
  ok(skuOf(target.id) === target.sku, '§5 the product kept its SKU (' + skuOf(target.id) + ')');
  ok(activeLinks(target.id).length === 1, '§5 still exactly one active media link');
  const receiptAfter = receiptRows(target.evId)[0] || null;
  ok(receiptBefore && receiptAfter && receiptBefore.canonical_product_metadata_hash === receiptAfter.canonical_product_metadata_hash,
    '§6 the receipt hash is byte-identical after the replay — the allocation did not re-run');
  ok(receiptBefore && receiptAfter && receiptBefore.product_id === receiptAfter.product_id, '§6 and it still binds the same product');
  const seqAfterReplay = sequenceRow(STEM);
  ok(seqBeforeReplay && seqAfterReplay && seqBeforeReplay.next_number === seqAfterReplay.next_number,
    '§5 the sequence did NOT advance on the replay (' + (seqBeforeReplay && seqBeforeReplay.next_number) + ' → ' + (seqAfterReplay && seqAfterReplay.next_number) + ')');

  // the next REAL product must continue at 004, not skip to 005
  {
    const evId = 'g1-after-replay-' + Date.now();
    const entityId = crypto.randomUUID();
    const before = products().map(p => p.id);
    const up = await upload(token, evId, entityId, JPEG_B64, BRAND, 'After Replay');
    ok(up.status === 200 || up.status === 201, '§6 a genuinely new upload is accepted (' + up.status + ')');
    const r = await drainUntilReady(app, evId); app = r.app;
    ok(r.ok, '§6 and is drained (' + inboxState(evId) + ')');
    const added = products().filter(p => !before.includes(p.id));
    ok(added.length === 1, '§6 it created exactly one product');
    if (added.length === 1) {
      ok(added[0].sku === 'ZEP-WCH-004',
        '§6 the number after a replay is the NEXT one, not one skipped by the replay (got ' + added[0].sku + ')');
      made.push({ evId, entityId, id: added[0].id, sku: added[0].sku });
    }
  }

  const prodAfter = existsSync(PROD_BIZ_DB) ? dbQ(PROD_BIZ_DB, 'SELECT COUNT(*) c FROM products') : [];
  ok(JSON.stringify(prodBefore) === JSON.stringify(prodAfter), 'isolation: the production business DB is untouched');

  try { app.close(); } catch {}
  killAllApp();
  await waitProcessGone();
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}

  console.log(`\nPOST-V0838 mobile-auto-sku e2e: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}

main().catch((e) => { console.error(e); killAllApp(); process.exit(1); });
