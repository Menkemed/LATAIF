// DESKTOP-CONTRACT-E2E — the desktop product contract through the REAL Tauri/WebView2 UI.
//
//   §7   Desktop "New Product" WITH a photo attached IN the create dialog (the path the live
//        v0.8.35 test never actually exercised — the media there came in via a later edit).
//   §8   Desktop edit: add a 2nd photo, leave the editor, come back later, add a 3rd.
//   §9   dependsOn matrix for EVERY dependency in the SSOT: hidden→not required→not persisted,
//        visible→required→persisted, and parent-change→stale value removed.
//   §11  pricing incl. purchase price 0 and decimals, create + edit + readback.
//   §12  validation severity: what the UI calls an error must actually block the save.
//   §15  field completeness: rendered controls == the contract's visible field set, per category.
//
// Everything is derived from the SSOT (default-categories.ts) — no hand-maintained expected lists.
// Isolated e2e identifier + AppData + sync port (3011); production (3001) is never touched.
import { spawn, execFileSync } from 'node:child_process';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CATEGORIES } from '../../src/core/models/default-categories.ts';
import {
  visibleAttributes, requiredAttributeKeys, stripStaleAttributes, isBrandRequired,
} from '../../src/core/products/field-contract.ts';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011, BASE = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-deskcontract-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
const PROD_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif_sync_server.db');
const PROD_BIZ_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? join(APP_DATA_DIR, 'lataif_sync_server.db')], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

function dbQ(file, sql) { let db; try { db = new DatabaseSync(file); return db.prepare(sql).all(); } catch { return []; } finally { try { db?.close(); } catch {} } }
const num = (sql) => { const r = dbQ(BIZ_DB, sql); return r.length ? Number(Object.values(r[0])[0]) : -1; };
const productByName = (name) => { const r = dbQ(BIZ_DB, `SELECT id,category_id,brand,name,attributes,purchase_price,planned_sale_price,min_sale_price,images FROM products WHERE name='${name}'`); return r.length ? r[0] : null; };
const activeLinks = (id) => dbQ(BIZ_DB, `SELECT media_id, sort_order, is_primary FROM media_links WHERE entity_id='${id}' AND deleted_at IS NULL ORDER BY sort_order`);
const deletedLinks = (id) => dbQ(BIZ_DB, `SELECT media_id FROM media_links WHERE entity_id='${id}' AND deleted_at IS NOT NULL`);
const jobsFor = (id) => dbQ(BIZ_DB, `SELECT ingest_request_id, state, error_code FROM media_ingest_jobs WHERE requested_entity_id='${id}'`);
const mediaFiles = () => { const out = []; const walk = (p) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const q = join(p, e.name); if (e.isDirectory()) walk(q); else out.push(q); } }; walk(MEDIA_ROOT); return out; };
const blobStats = () => ({ blobs: num('SELECT COUNT(*) c FROM media_blobs'), gens: num('SELECT COUNT(*) c FROM media_blob_generations'), files: mediaFiles().length });
const sameStats = (a, b) => a.blobs === b.blobs && a.gens === b.gens && a.files === b.files;

class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  close() { try { this.ws.close(); } catch {} }
}
const S = (v) => JSON.stringify(v);


/**
 * LEGACY FIXTURE SETUP - historical attribute keys cannot be produced by this build any more
 * (the create UI only offers current SSOT fields, and the mobile gate rejects unknown keys), so a
 * legacy product is staged AT REST: the app is stopped, the fixture keys are merged into the
 * product's attributes in the isolated e2e DB file, and the app is started again so it loads them
 * through its normal path. Nothing is patched while the app runs and no assertion result is
 * touched - this only recreates data older builds legitimately wrote. Every claim afterwards is
 * made against DB persistence following a REAL user save.
 */
function seedLegacyAttributes(productId, extra) {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const row = db.prepare('SELECT attributes FROM products WHERE id = ?').get(productId);
    const merged = { ...JSON.parse(row.attributes || '{}'), ...extra };
    db.prepare('UPDATE products SET attributes = ? WHERE id = ?').run(JSON.stringify(merged), productId);
    // The row's own create-time sync snapshot predates the fixture. The LAN relay applies such a
    // snapshot unconditionally (LWW by arrival), which would restore the pre-fixture attributes and
    // make this test measure the sync layer instead of the save path. Retiring the fixture product's
    // pending snapshots is part of staging the fixture, not of the assertion.
    db.prepare("UPDATE sync_changelog SET synced = 1 WHERE table_name = 'products' AND record_id = ? AND synced = 0").run(productId);
    return merged;
  } finally { try { db.close(); } catch {} }
}
const attrsOf = (id) => { const r = dbQ(BIZ_DB, `SELECT attributes FROM products WHERE id='${id}'`); return r.length ? JSON.parse(r[0].attributes || '{}') : {}; };

let appProc;
async function startApp() {
  // SINGLE-PC-STORAGE-I2A §4/§5 — HARD STOP before the process exists. Proves the artefact at
  // `APP` really is the isolated E2E build (a plain `cargo build` silently overwrites it with a
  // production-identity binary) and that this suite's AppData root and sync port are the isolated
  // ones. Never a warning: a suite that cannot prove what it is launching does not launch it.
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) { try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error('app CDP page did not come up');
  return page.webSocketDebuggerUrl;
}

/** True once no debug app process is left (the fixture must not race a flushing instance). */
async function waitProcessGone(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let n = 1;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\debug\lataif.exe' }).Count"], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(400);
  }
  return false;
}
function killAllApp() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
async function waitPortFree(port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { let n = 1; try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; } if (!n) return true; await sleep(500); } return false; }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev(`return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);`)) return; await sleep(400); } throw new Error('no invoke'); }
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }
async function frontendLogin(c) {
  await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 60000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co'); await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click(); return 1;`); await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin'); await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL); await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Next')?.click(); return 1;`); await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10'); await c.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;`);
  } else { await setVal(c, 'input[type="email"]', OWNER_EMAIL); await setVal(c, 'input[type="password"]', ONBOARD_PW); await c.ev(`[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;`); }
  await waitFor(c, 'a[href="/settings"], nav a, [data-testid]', 25000);
}

/** Wait for the app shell; sign in only if the login form is what came up. */
async function ensureSignedIn(c) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    if (await exists(c, 'a[href="/settings"], nav a, [data-testid]')) return true;
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) {
      // one bounded attempt per loop pass; a slow first render simply retries the same real flow
      try { await frontendLogin(c); return true; } catch { await sleep(1000); }
    }
    await sleep(400);
  }
  throw new Error('app shell never appeared');
}

/** Fill the create dialog's attribute controls in SSOT order, letting a newly revealed
 *  dependent field render before it is written (one bounded retry, no result retried). */
async function setAttrsFor(c, cat, attrs) {
  for (const a of visibleAttributes(cat, attrs)) {
    const raw = attrs[a.key];
    if (raw === undefined) continue;
    const v = Array.isArray(raw) ? raw[0] : raw;
    let r = await setAttr(c, a.key, v, a.type);
    if (r !== 'OK') { await sleep(700); r = await setAttr(c, a.key, v, a.type); }
    if (r !== 'OK') console.log(`    [harness] could not set ${cat.id}.${a.key}=${JSON.stringify(v)} -> ${r}`);
    await sleep(150);
  }
  await sleep(250);
}
const goto = async (c, path) => { await c.ev(`history.pushState({},'', ${S(path)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`); await sleep(1200); };

// ── the REAL create dialog (WatchList "New Product") ────────────────────────
const clickText = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
async function openCreate(c) {
  await goto(c, '/collection');
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if ((await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>/new (product|item)/i.test(x.textContent)); if(!b) return 'NO'; b.click(); return 'OK';`)) === 'OK') break;
    await sleep(300);
  }
  await waitFor(c, '#new-field-categoryId', 20000);
  return true;
}
const pickCategory = (c, name) => c.ev(`const wrap=document.querySelector('#new-field-categoryId'); if(!wrap) return 'NO'; const b=[...wrap.querySelectorAll('button')].find(x=>x.textContent.trim().toLowerCase().includes(${S(name.toLowerCase())})); if(!b) return 'NOCAT'; b.click(); return 'OK';`);
/** Chip/select/number/text setter for one category attribute inside the create dialog. */
const setAttr = (c, key, value, type) => c.ev(`
  const wrap=document.querySelector('#new-field-attr_' + ${S(key)}); if(!wrap) return 'NOFIELD';
  if (${S(type)} === 'number' || ${S(type)} === 'text') {
    const i=wrap.querySelector('input,textarea'); if(!i) return 'NOINPUT';
    const p=i.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(i, ${S(String(value))});
    i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';
  }
  const b=[...wrap.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(String(value))}); if(!b) return 'NOOPT'; b.click(); return 'OK';`);
/** Which attribute fields does the create dialog currently RENDER? (SSOT keys only.) */
const renderedAttrKeys = (c, keys) => c.ev(`return ${S(keys)}.filter(k => !!document.querySelector('#new-field-attr_' + k));`);
/** The real submit button of the WatchList create dialog ("Add to Collection" / "Retry images"). */
const submitCreate = (c) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>/add to collection|retry images/i.test(x.textContent)); if(!b) return 'NO'; if(b.disabled) return 'BUSY'; b.click(); return 'OK';`);
const createErrors = (c) => c.ev(`return [...document.querySelectorAll('[id^="new-field-"]')].filter(e=>/rgb\\(220, 38, 38\\)|#DC2626/i.test(e.getAttribute('style')||'')).map(e=>e.id);`);
async function setFileOn(c, sel, path) { const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(sel)})`, returnByValue: false }); await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [path] }); }
const draftPhotos = (c) => c.ev(`const inp=document.querySelector('input[type=file][accept="image/*"]'); if(!inp) return -1; const grid=inp.parentElement.firstElementChild; return [...grid.children].filter(x=>x.querySelector('img')).length;`);
async function addPhoto(c, path) {
  const before = await draftPhotos(c);
  await setFileOn(c, 'input[type=file][accept="image/*"]', path);
  const end = Date.now() + 15000;
  while (Date.now() < end) { const n = await draftPhotos(c); if (n === before + 1) return true; if (n > before + 1) return false; await sleep(250); }
  return false;
}

// ── the SSOT drives every expectation ───────────────────────────────────────
const CATS = DEFAULT_CATEGORIES.filter((c) => c.active !== false);
/** A minimal, contract-valid attribute set for a category (required + visible only). */
function validAttrs(cat, overrides = {}) {
  const out = { ...overrides };
  for (let pass = 0; pass < 3; pass++) {
    for (const a of visibleAttributes(cat, out)) {
      if (!a.required || out[a.key] !== undefined) continue;
      out[a.key] = a.type === 'number' ? 5 : a.type === 'boolean' ? true : a.type === 'multiselect' ? [a.options[0]] : (a.options?.[0] ?? 'E2E');
    }
  }
  return out;
}

async function main() {
  killAllApp();
  ok(await waitPortFree(PORT), 'isolated port ' + PORT + ' free before start');
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0;
  const prodBizBefore = existsSync(PROD_BIZ_DB) ? statSync(PROD_BIZ_DB).mtimeMs : 0;
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded');
  const jpgA = join(RUN, 'a.jpg'); writeFileSync(jpgA, Buffer.from(seed('jpeg', '3'), 'base64'));
  const jpgB = join(RUN, 'b.jpg'); writeFileSync(jpgB, Buffer.from(seed('jpeg', '11'), 'base64'));
  const jpgC = join(RUN, 'c.jpg'); writeFileSync(jpgC, Buffer.from(seed('jpeg', '23'), 'base64'));

  let app = new CDP(await startApp()); await waitInvoke(app);
  await ensureSignedIn(app);
  ok(true, 'app up on the isolated instance (production 3001 untouched)');

  // ══ §15 + §12 — per category: rendered fields == contract, requiredness blocks ══
  let sixFields = true, sixCreate = true;
  for (const cat of CATS) {
    await openCreate(app);
    ok((await pickCategory(app, cat.name)) === 'OK', `${cat.id}: category selectable in the create dialog`);
    await sleep(500);
    const allKeys = cat.attributes.map((a) => a.key);
    // with no values yet, the contract's visible set is what must be rendered
    let expected = visibleAttributes(cat, {}).map((a) => a.key);
    let rendered = await renderedAttrKeys(app, allKeys);
    const missing = expected.filter((k) => !rendered.includes(k));
    const extra = rendered.filter((k) => !expected.includes(k));
    if (missing.length || extra.length) { sixFields = false; console.log(`  ${cat.id} field drift — missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`); }
    ok(missing.length === 0 && extra.length === 0, `${cat.id}: rendered attribute controls == contract visible set (no hidden field offered)`);

    // §12: a required-missing save must BLOCK (nothing is created)
    const beforeCount = num('SELECT COUNT(*) c FROM products');
    const name = `E2E ${cat.id} ${Date.now()}`;
    if (isBrandRequired(cat.id)) await setVal(app, '#new-field-brand input', 'E2E Brand');
    await setVal(app, '#new-field-name input', name);
    await submitCreate(app);
    await sleep(900);
    const stillOpen = await exists(app, '#new-field-categoryId');
    const requiredNow = requiredAttributeKeys(cat, {});
    if (requiredNow.length > 0) {
      ok(stillOpen && num('SELECT COUNT(*) c FROM products') === beforeCount, `${cat.id}: save with missing required attributes is BLOCKED (no product created)`);
      ok((await createErrors(app)).length > 0, `${cat.id}: the blocked save marks the offending fields`);
    }

    // now fill exactly the contract's required set → save must succeed
    const attrs = validAttrs(cat);
    await setAttrsFor(app, cat, attrs);
    // §11: purchase price 0 must be acceptable on create
    await setVal(app, '#new-field-purchasePrice input', '0');
    await submitCreate(app);
    const end = Date.now() + 25000; let row = null;
    while (Date.now() < end) { row = productByName(name); if (row) break; await sleep(500); }
    if (!row) { sixCreate = false; console.log(`  ${cat.id}: product was not created`); }
    ok(!!row, `${cat.id}: a contract-complete product saves (purchase price 0 accepted)`);
    if (row) {
      ok(row.purchase_price === 0, `${cat.id}: purchase price 0 persisted as 0 (no invented > 0 rule)`);
      const persisted = JSON.parse(row.attributes || '{}');
      const expectAttrs = stripStaleAttributes(cat, attrs);
      const staleKeys = Object.keys(persisted).filter((k) => !(k in expectAttrs));
      ok(staleKeys.length === 0, `${cat.id}: no attribute outside the contract was persisted (${JSON.stringify(staleKeys)})`);
    }
    await goto(app, '/collection');
  }
  ok(sixFields, 'field completeness (rendered == SSOT visible set): 6/6 categories');
  ok(sixCreate, 'contract-complete create: 6/6 categories');

  // ══ §9/§10 — dependsOn matrix (every dependency in the SSOT) ══
  for (const cat of CATS) {
    for (const attr of cat.attributes.filter((a) => a.dependsOn)) {
      const dep = attr.dependsOn;
      const parent = cat.attributes.find((a) => a.key === dep.key);
      const unmetVal = (parent.options || []).find((o) => !dep.valueIncludes.includes(o));
      const metVal = dep.valueIncludes[0];
      await openCreate(app);
      await pickCategory(app, cat.name); await sleep(500);
      const base = validAttrs(cat, { [dep.key]: unmetVal });
      await setAttrsFor(app, cat, base);
      await sleep(400);
      ok((await renderedAttrKeys(app, [attr.key])).length === 0, `${cat.id}.${attr.key}: NOT rendered while ${dep.key}=${unmetVal}`);
      // dependency satisfied → the field appears
      await setAttr(app, dep.key, metVal, parent.type); await sleep(500);
      ok((await renderedAttrKeys(app, [attr.key])).length === 1, `${cat.id}.${attr.key}: appears when ${dep.key}=${metVal}`);
      // required while visible → save blocked until filled
      if (attr.required) {
        const nameDep = `E2E DEP ${cat.id} ${Date.now()}`;
        if (isBrandRequired(cat.id)) await setVal(app, '#new-field-brand input', 'E2E Brand');
        await setVal(app, '#new-field-name input', nameDep);
        const before = num('SELECT COUNT(*) c FROM products');
        await submitCreate(app);
        await sleep(900);
        ok(num('SELECT COUNT(*) c FROM products') === before, `${cat.id}.${attr.key}: visible+required blocks the save while empty`);
        await setAttr(app, attr.key, (attr.options || ['E2E'])[0], attr.type); await sleep(300);
        await submitCreate(app);
        const end2 = Date.now() + 25000; let r2 = null;
        while (Date.now() < end2) { r2 = productByName(nameDep); if (r2) break; await sleep(500); }
        ok(!!r2, `${cat.id}.${attr.key}: filling it lets the save through`);
        if (r2) {
          const a2 = JSON.parse(r2.attributes || '{}');
          ok(a2[attr.key] !== undefined && String(a2[dep.key]) === metVal, `${cat.id}.${attr.key}: value persisted together with its satisfied parent`);
          // §10 — flip the parent back: the dependent value must disappear from the DB
          await goto(app, '/collection/' + r2.id);
          await c_clickEdit(app);
          await setDetailAttr(app, cat, dep.key, unmetVal, parent.type);
          await sleep(600);
          ok((await detailRenderedAttrKeys(app, [attr.key])).length === 0, `${cat.id}.${attr.key}: disappears in the editor when the parent no longer satisfies it`);
          await clickText(app, 'Save'); await sleep(2500);
          const r3 = productByName(nameDep);
          ok(r3 && JSON.parse(r3.attributes || '{}')[attr.key] === undefined, `${cat.id}.${attr.key}: the now-stale value is REMOVED from persistence (live finding A)`);
          ok(r3 && String(JSON.parse(r3.attributes || '{}')[dep.key]) === unmetVal, `${cat.id}.${dep.key}: the parent change itself persisted`);
        }
      }
      await goto(app, '/collection');
    }
  }

  // ══ §7 — REAL "New Product" with the photo attached IN the create dialog ══
  const createName = `E2E CREATE WITH MEDIA ${Date.now()}`;
  {
    const cat = CATS.find((c) => c.id === 'cat-watch');
    await openCreate(app);
    await pickCategory(app, cat.name); await sleep(500);
    await setVal(app, '#new-field-brand input', 'E2E Brand');
    await setVal(app, '#new-field-name input', createName);
    const attrs = validAttrs(cat);
    await setAttrsFor(app, cat, attrs);
    await setVal(app, '#new-field-purchasePrice input', '12.5');
    ok(await addPhoto(app, jpgA), '§7: a photo was attached INSIDE the create dialog (not via a later edit)');
    await submitCreate(app);
    const end = Date.now() + 40000; let row = null;
    while (Date.now() < end) { row = productByName(createName); if (row && activeLinks(row.id).length === 1) break; await sleep(600); }
    ok(!!row, '§7: the product was created');
    if (row) {
      const links = activeLinks(row.id);
      ok(links.length === 1, '§7: exactly ONE active media link from the create path');
      ok(links[0]?.sort_order === 0 && links[0]?.is_primary === 1, '§7: the first image is primary at slot 0');
      const jobs = jobsFor(row.id);
      ok(jobs.length >= 1 && jobs.every((j) => j.state === 'ready' && !j.error_code), '§7: media ingest terminal, no error code');
      ok(jobs.every((j) => /^[A-Za-z0-9_-]{8,80}$/.test(String(j.ingest_request_id))), '§7: the CREATE-path ingest request id satisfies the media core contract');
      ok(jobs.some((j) => String(j.ingest_request_id).startsWith('create-')), '§7: the request id really came from the CREATE path (not an edit)');
      ok(row.images === '[]', "§7: products.images stays '[]' (durable gallery)");
      ok(row.purchase_price === 12.5, '§7: decimal purchase price persisted exactly');
      await goto(app, '/collection/' + row.id);
      ok((await app.ev(`return [...document.querySelectorAll('img')].filter(i=>String(i.currentSrc||i.src).startsWith('blob:')).length;`)) === 1, '§7: the image is rendered after reopen');
    }
  }

  // ══ §8 — desktop edit: 2nd photo now, 3rd photo in a LATER editor cycle ══
  {
    const row = productByName(createName);
    const statsBefore = blobStats();
    await goto(app, '/collection/' + row.id);
    await c_clickEdit(app);
    ok(await addPhoto(app, jpgB), '§8: second photo added in the editor');
    await clickText(app, 'Save');
    let end = Date.now() + 40000; while (Date.now() < end && activeLinks(row.id).length !== 2) await sleep(500);
    ok(activeLinks(row.id).length === 2, '§8: two active media after the first edit cycle');
    ok(jobsFor(row.id).every((j) => !j.error_code), '§8: no MEDIA_INGEST_INVALID_REQUEST / REQUEST_CONFLICT in cycle 1');
    // leave the editor entirely, come back later
    await goto(app, '/collection'); await sleep(1200);
    await goto(app, '/collection/' + row.id);
    await c_clickEdit(app);
    ok(await addPhoto(app, jpgC), '§8: third photo added in a LATER editor cycle');
    await clickText(app, 'Save');
    end = Date.now() + 40000; while (Date.now() < end && activeLinks(row.id).length !== 3) await sleep(500);
    const links3 = activeLinks(row.id);
    ok(links3.length === 3, '§8: three active media after the second edit cycle (D2 path)');
    ok(jobsFor(row.id).every((j) => !j.error_code), '§8: still no ingest error code (no request-id collision)');
    ok(links3.filter((l) => l.is_primary === 1).length === 1 && links3[0].is_primary === 1, '§8: exactly one primary, at slot 0');
    ok(deletedLinks(row.id).length === 0, '§8: no existing gallery entry was retired by the additions');
    ok(blobStats().blobs > statsBefore.blobs, '§8: the new images really were ingested');

    // ══ §13 — pure text/price edit keeps the media untouched ══
    const beforeIds = activeLinks(row.id).map((l) => l.media_id).join('|');
    const statsNow = blobStats();
    await goto(app, '/collection/' + row.id);
    await c_clickEdit(app);
    await setDetailInput(app, 'SALE PRICE (BHD)', '77.25');
    await clickText(app, 'Save'); await sleep(3000);
    const after = productByName(createName);
    ok(after.planned_sale_price === 77.25, '§13: the price edit persisted');
    ok(after.purchase_price === 12.5, '§13: the other prices are unchanged');
    ok(activeLinks(row.id).map((l) => l.media_id).join('|') === beforeIds, '§13: same media ids, nothing retired');
    ok(deletedLinks(row.id).length === 0, '§13: deleted_at still NULL for every link');
    ok(sameStats(blobStats(), statsNow), '§13: no new blob/generation/file from a text-price edit');
    await goto(app, '/collection/' + row.id);
    ok((await app.ev(`return [...document.querySelectorAll('img')].filter(i=>String(i.currentSrc||i.src).startsWith('blob:')).length;`)) === 3, '§13: all three images still render after reopen');
  }


  // == LEGACY ATTRIBUTE SURVIVAL (a save is not a migration) ==
  // Historical keys that older builds wrote are invisible to this build. They must survive every
  // ordinary desktop save; only a value the contract itself contradicts (unsatisfied dependsOn) goes.
  {
    const watchCat = CATS.find((c) => c.id === 'cat-watch');
    const accCat = CATS.find((c) => c.id === 'cat-accessory');
    const LEGACY_W = { movement: 'Automatic', diamonds: 'Yes', legacy_future_key: 'x' };
    const LEGACY_A = { box: true, papers: 'yes' };

    // Fixture A: Steel watch WITH media, via the real create dialog.
    const nameA = `E2E LEGACY PRICE ${Date.now()}`;
    await openCreate(app); await pickCategory(app, watchCat.name); await sleep(500);
    await setVal(app, '#new-field-brand input', 'E2E Brand');
    await setVal(app, '#new-field-name input', nameA);
    const aAttrs = validAttrs(watchCat, { material: 'Steel' });
    await setAttrsFor(app, watchCat, aAttrs);
    await setVal(app, '#new-field-purchasePrice input', '10');
    ok(await addPhoto(app, jpgB), 'legacy fixture A: created with a photo');
    await submitCreate(app);
    let endA = Date.now() + 40000; let rowA = null;
    while (Date.now() < endA) { rowA = productByName(nameA); if (rowA && activeLinks(rowA.id).length === 1) break; await sleep(600); }
    ok(!!rowA && activeLinks(rowA.id).length === 1, 'legacy fixture A: product + media created');

    // Fixture B: GOLD watch with a valid karat_color and media.
    const nameB = `E2E LEGACY STALE ${Date.now()}`;
    await openCreate(app); await pickCategory(app, watchCat.name); await sleep(500);
    await setVal(app, '#new-field-brand input', 'E2E Brand');
    await setVal(app, '#new-field-name input', nameB);
    const bAttrs = validAttrs(watchCat, { material: 'Solid Gold' });
    await setAttrsFor(app, watchCat, bAttrs);
    await setVal(app, '#new-field-purchasePrice input', '20');
    ok(await addPhoto(app, jpgC), 'legacy fixture B: created with a photo');
    await submitCreate(app);
    let endB = Date.now() + 40000; let rowB = null;
    while (Date.now() < endB) { rowB = productByName(nameB); if (rowB && activeLinks(rowB.id).length === 1) break; await sleep(600); }
    ok(!!rowB && JSON.parse((rowB && rowB.attributes) || '{}').karat_color !== undefined, 'legacy fixture B: gold watch stored its karat_color');

    // Fixture C: accessory (historical box/papers).
    const nameC = `E2E LEGACY ACC ${Date.now()}`;
    await openCreate(app); await pickCategory(app, accCat.name); await sleep(500);
    await setVal(app, '#new-field-name input', nameC);
    const cAttrs = validAttrs(accCat);
    await setAttrsFor(app, accCat, cAttrs);
    await submitCreate(app);
    let endC = Date.now() + 30000; let rowC = null;
    while (Date.now() < endC) { rowC = productByName(nameC); if (rowC) break; await sleep(500); }
    ok(!!rowC, 'legacy fixture C: accessory created');

    // Stage the historical keys AT REST. The app must be REALLY gone first (a still-running
    // instance would flush its own in-memory copy over the fixture), and the write is verified
    // before the app is started again — otherwise the fixture, not the product, would be tested.
    app.close(); killAllApp();
    ok(await waitProcessGone(20000), 'legacy fixture: the app process is fully stopped before staging');
    ok(await waitPortFree(PORT, 20000), 'legacy fixture: the isolated port is free before staging');
    await sleep(1000);
    seedLegacyAttributes(rowA.id, LEGACY_W);
    seedLegacyAttributes(rowB.id, LEGACY_W);
    seedLegacyAttributes(rowC.id, LEGACY_A);
    ok(['movement', 'diamonds', 'legacy_future_key'].every((k) => k in attrsOf(rowA.id))
      && ['box', 'papers'].every((k) => k in attrsOf(rowC.id)), 'legacy fixture: staged keys are verified on disk before the app restarts');
    const app2 = new CDP(await startApp()); await waitInvoke(app2);
    // the reloaded instance usually restores its session; only log in when the login form is up
    await ensureSignedIn(app2);
    ok(Object.keys(attrsOf(rowA.id)).includes('movement'), 'legacy fixture: historical keys are in place before the user save');

    // Pure PRICE edit on a legacy product with media.
    {
      const beforeAttrs = attrsOf(rowA.id);
      const beforeLinks = activeLinks(rowA.id);
      const beforeStats = blobStats();
      await goto(app2, '/collection/' + rowA.id);
      await c_clickEdit(app2);
      await setDetailInput(app2, 'PURCHASE PRICE (BHD)', '33.75');
      await clickText(app2, 'Save'); await sleep(3000);
      await goto(app2, '/collection'); await sleep(800);
      await goto(app2, '/collection/' + rowA.id);
      const after = productByName(nameA); const afterAttrs = attrsOf(rowA.id);
      ok(after.purchase_price === 33.75, 'legacy price edit persisted');
      let survived = true;
      for (const [k, v] of Object.entries(LEGACY_W)) if (afterAttrs[k] !== v) { survived = false; console.log(`  LOST legacy key ${k}: ${JSON.stringify(afterAttrs[k])} (was ${JSON.stringify(v)})`); }
      ok(survived, 'EVERY historical key survives a pure price save with its exact value');
      for (const k of Object.keys(beforeAttrs)) ok(afterAttrs[k] !== undefined, `attribute ${k} still present after the price save`);
      ok(Object.keys(afterAttrs).length === Object.keys(beforeAttrs).length, 'the attribute set is unchanged in size (nothing added, nothing dropped)');
      const afterLinks = activeLinks(rowA.id);
      ok(afterLinks.length === 1 && afterLinks[0].media_id === beforeLinks[0].media_id && afterLinks[0].is_primary === 1, 'media survival: same media id, still primary');
      ok(deletedLinks(rowA.id).length === 0, 'media survival: deleted_at still NULL');
      ok(sameStats(blobStats(), beforeStats), 'media survival: no new blob/generation/file');
      ok((await app2.ev(`return [...document.querySelectorAll('img')].filter(i=>String(i.currentSrc||i.src).startsWith('blob:')).length;`)) === 1, 'media survival: the image renders after reopen');
    }

    // Targeted stale removal: Gold -> Steel drops ONLY karat_color.
    {
      const beforeLinks = activeLinks(rowB.id);
      const beforeStats = blobStats();
      const beforeAttrs = attrsOf(rowB.id);
      await goto(app2, '/collection/' + rowB.id);
      await c_clickEdit(app2);
      await setDetailAttr(app2, watchCat, 'material', 'Steel', 'select');
      await sleep(700);
      ok((await detailRenderedAttrKeys(app2, ['karat_color'])).length === 0, 'karat_color disappears from the editor when material becomes Steel');
      await clickText(app2, 'Save'); await sleep(3000);
      await goto(app2, '/collection'); await sleep(800);
      await goto(app2, '/collection/' + rowB.id);
      const afterAttrs = attrsOf(rowB.id);
      ok(afterAttrs.karat_color === undefined, 'the now-stale karat_color is REMOVED from persistence');
      ok(String(afterAttrs.material) === 'Steel', 'the parent change persisted');
      let kept = true;
      for (const [k, v] of Object.entries(LEGACY_W)) if (afterAttrs[k] !== v) { kept = false; console.log(`  LOST legacy key ${k} during the stale strip`); }
      ok(kept, 'historical keys survive the targeted strip (movement/diamonds/legacy_future_key)');
      for (const k of Object.keys(beforeAttrs)) {
        if (k === 'karat_color') continue;
        ok(afterAttrs[k] !== undefined, `valid attribute ${k} survived the stale strip`);
      }
      const afterLinks = activeLinks(rowB.id);
      ok(afterLinks.length === 1 && afterLinks[0].media_id === beforeLinks[0].media_id, 'media untouched by the attribute edit');
      ok(sameStats(blobStats(), beforeStats), 'no new blob/generation/file from the attribute edit');
    }

    // Accessory: edit a visible field, historical box/papers survive.
    {
      const beforeAttrs = attrsOf(rowC.id);
      const colorAttr = accCat.attributes.find((a) => a.key === 'color');
      const nextColor = colorAttr.options ? (colorAttr.options[1] || colorAttr.options[0]) : 'E2E EDITED';
      await goto(app2, '/collection/' + rowC.id);
      await c_clickEdit(app2);
      // use the attribute's REAL type, otherwise the edit silently does nothing
      const r = await setDetailAttr(app2, accCat, 'color', nextColor, colorAttr.type);
      ok(r === 'OK', 'accessory: the visible color field was really edited (' + r + ')');
      await clickText(app2, 'Save'); await sleep(3000);
      await goto(app2, '/collection'); await sleep(800);
      const afterAttrs = attrsOf(rowC.id);
      ok(String(afterAttrs.color) === String(nextColor), 'accessory: the edited value persisted');
      ok(afterAttrs.box === true && afterAttrs.papers === 'yes', 'accessory historical keys box/papers survive a normal edit');
      ok(Object.keys(afterAttrs).length === Object.keys(beforeAttrs).length, 'no accessory attribute was dropped');
    }
    app = app2;
  }

  // ══ isolation ══
  ok((existsSync(PROD_DB) ? statSync(PROD_DB).mtimeMs : 0) === prodBefore, 'production sync DB untouched');
  ok((existsSync(PROD_BIZ_DB) ? statSync(PROD_BIZ_DB).mtimeMs : 0) === prodBizBefore, 'production business DB untouched');
  app.close();
  console.log(`\nDESKTOP-CONTRACT e2e: ${PASS} passed, ${FAIL} failed`);
}

// ── ProductDetail helpers (edit surface) ────────────────────────────────────
const c_clickEdit = async (c) => { const end = Date.now() + 20000; while (Date.now() < end) { if ((await clickText(c, 'Edit')) === 'OK') { await sleep(900); return true; } await sleep(300); } return false; };
const detailRenderedAttrKeys = (c, keys) => c.ev(`return ${S(keys)}.filter(k => !!document.querySelector('#field-attr_' + k));`);
const setDetailAttr = (c, cat, key, value, type) => c.ev(`
  const wrap=document.querySelector('#field-attr_' + ${S(key)}) || [...document.querySelectorAll('div')].find(d=>d.querySelector('span') && d.querySelector('span').textContent.trim().startsWith(${S(cat.attributes.find(a=>a.key===key)?.label ?? key)}));
  if(!wrap) return 'NOFIELD';
  if (${S(type)} === 'number' || ${S(type)} === 'text') { const i=wrap.querySelector('input,textarea'); if(!i) return 'NOINPUT'; const p=i.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(i, ${S(String(value))}); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return 'OK'; }
  const b=[...wrap.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(String(value))}); if(!b) return 'NOOPT'; b.click(); return 'OK';`);
const setDetailInput = (c, labelPrefix, value) => c.ev(`const lab=[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith(${S(labelPrefix)})); if(!lab) return 'NOLABEL'; const i=lab.parentElement.querySelector('input'); const p=HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(i, ${S(String(value))}); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);

main().catch((e) => { console.error('E2E ERROR:', e?.stack || e?.message || e); FAIL++; }).finally(() => {
  try { killAllApp(); } catch {}
  try { rmSync(RUN, { recursive: true, force: true }); } catch {}
  if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
});
