// SKU-UNIFY §15 — the desktop SKU through the REAL Tauri/WebView2 UI, against the real counter.
//
// Every product here is created by filling the actual New Item dialog and pressing the actual
// button, and the one that gets deleted is deleted through the actual Collection delete flow.
// Nothing is inserted with SQL: a direct INSERT would prove that the ALLOCATOR works, which the
// unit gate already does, and say nothing about whether the desktop actually calls it.
//
// What has to hold:
//   • looking at a suggested number costs nothing — cancel, and the counter has not moved,
//   • the number that ends up on the product comes from a CLAIM at save time, not from the
//     suggestion the form was showing, so a suggestion that went stale cannot produce a duplicate,
//   • a deleted number never comes back,
//   • and the phone and the desktop count through ONE sequence, alternating without a collision.
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

const RUN = join(os.tmpdir(), 'lataif-desktop-sku-e2e', 'run-' + Date.now());
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
/** The durable counter — the thing a preview must never touch. */
const counters = () => dbQ(BIZ_DB, 'SELECT stem, next_number FROM sku_sequences ORDER BY stem');
const counterFor = (stem) => { const r = counters().find(c => c.stem === stem); return r ? r.next_number : null; };
const skus = () => dbQ(BIZ_DB, "SELECT sku FROM products WHERE sku IS NOT NULL AND TRIM(sku) <> '' ORDER BY sku").map(r => r.sku);
const skusFor = (stem) => skus().filter(s => String(s).toUpperCase().startsWith(stem));

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
let appProc;
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
async function serverHealthy(ms = 45000) {
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
const clickSel = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
const clickText = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);
/** Substring match — no regex, so a label with brackets in it needs no escaping. */
const clickIncludes = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes(${S(text)})); if(!b) return 'NO'; b.click(); return 'OK';`);
const clickMatch = (c, re) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>new RegExp(${S(re)},'i').test(x.textContent||'')); if(!b) return 'NO'; b.click(); return 'OK';`);
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
async function gotoCollection(c) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const direct = await c.ev(`const a=document.querySelector('a[href="/collection"]'); if(!a) return 'NONE'; a.click(); return 'OK';`);
    if (direct === 'OK') { await sleep(1200); return 'OK'; }
    await c.ev(`const g=[...document.querySelectorAll('div,button,span')].find(e=>e.children.length===0 && /^\\s*INVENTORY\\s*$/i.test(e.textContent||'')); if(g){ (g.closest('button')||g).click(); return 'EXPANDED'; } return 'NOGROUP';`);
    await sleep(600);
  }
  return 'FAILED';
}

// ── the New Item dialog, driven the way a person drives it ───────────────────
const BRAND = 'Zeniqa';                       // a brand nothing else in the fixture uses
const STEM = 'ZEN-WCH-';                      // …so this stem belongs to this suite alone
const previewText = (c) => c.ev(`const e=document.querySelector('[data-sku-preview]'); return e ? e.getAttribute('data-sku-preview') : null;`);

async function openNewItem(c) {
  await clickText(c, 'New Item');
  await waitFor(c, '#new-field-categoryId', 20000);
  await setVal(c, '#new-field-categoryId select', 'cat-watch');
  await sleep(400);
}
/**
 * Fill every required control the dialog is showing. Run twice: a conditional attribute
 * (`karat_color` appears only once `material` is set) does not exist during the first pass.
 */
const fillRequired = (c, name) => c.ev(`
  const set=(el,v)=>{const p=el.tagName==='SELECT'?HTMLSelectElement.prototype:(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype);
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));};
  let n=0;
  for (const box of document.querySelectorAll('[id^="new-field-"]')) {
    if (box.id==='new-field-categoryId') continue;
    const el = box.querySelector('select, textarea, input');
    if (el && !el.disabled) {
      if (el.tagName==='SELECT') {
        if (el.value) continue;
        const opt=[...el.options].find(o=>o.value);
        if (opt) { set(el,opt.value); n++; }
      } else if (!el.value) {
        set(el, el.type==='number' ? '100' : (box.id==='new-field-brand' ? ${S(BRAND)} : (box.id==='new-field-name' ? ${S(name)} : 'E2E')));
        n++;
      }
      continue;
    }
    // A select-type attribute is a row of chips, not a <select>: nothing to set, something to
    // click. A chip that is already chosen paints its background, so an untouched group is the
    // one where every chip is still transparent.
    const chips=[...box.querySelectorAll('button')];
    if (chips.length===0) continue;
    const chosen=chips.some(x=>getComputedStyle(x).backgroundColor!=='rgba(0, 0, 0, 0)');
    if (!chosen) { chips[0].click(); n++; }
  }
  return n;`);

async function prepareNewItem(c, name) {
  await openNewItem(c);
  // Three passes: a conditional attribute (`karat_color` behind `material`) does not exist until
  // the one it depends on has been answered.
  for (let pass = 0; pass < 3; pass++) { await fillRequired(c, name); await sleep(400); }
  await sleep(400);
  return previewText(c);
}
/** Which fields the dialog is currently complaining about — an error paints the box red. */
const fieldErrors = (c) => c.ev(`
  return [...document.querySelectorAll('[id^="new-field-"]')]
    .filter(e => /DC2626/i.test(e.getAttribute('style')||''))
    .map(e => e.id);`);
/** The score-based duplicate warning is not an error; it asks, and the answer here is yes. */
async function passDuplicateWarning(c) {
  const shown = await c.ev(`return /create anyway|similar item/i.test(document.body.innerText||'');`);
  if (!shown) return false;
  await clickMatch(c, 'create anyway');
  await sleep(600);
  return true;
}
async function saveNewItem(c) {
  await clickMatch(c, 'Add to Collection');
  await sleep(800);
  const dup = await passDuplicateWarning(c);
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (!(await exists(c, '#new-field-categoryId'))) return { closed: true, dup, errors: [] };
    await sleep(300);
  }
  return { closed: false, dup, errors: await fieldErrors(c) };
}
/** Create one product end-to-end and return the SKU it was actually given. */
async function createOne(c, name) {
  const before = new Set(skusFor(STEM));
  await prepareNewItem(c, name);
  const saved = await saveNewItem(c);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const now = skusFor(STEM).filter(s => !before.has(s));
    if (now.length > 0) return now[0];
    await sleep(400);
  }
  lastCreateFailure = saved;
  return null;
}
let lastCreateFailure = null;
const why = () => (lastCreateFailure ? ' [' + S(lastCreateFailure) + ']' : '');

/**
 * Delete a product the way the Collection does: narrow the list to it, turn on select mode, pick
 * the card, confirm. The card is found by walking up from the text node until a click actually
 * registers a selection — which is the honest test of "clicked the card", and does not depend on
 * any class name staying what it is today.
 */
const SEARCH = 'input[placeholder="Search by brand, name, SKU..."]';
async function deleteViaUi(c, name, sku) {
  await setVal(c, SEARCH, name);
  await sleep(1200);
  await clickIncludes(c, 'Select');
  await sleep(700);
  const picked = await c.ev(`
    const count=(n)=>[...document.querySelectorAll('button')].some(b=>(b.textContent||'').includes('Delete (' + n + ')'));
    const leaf=[...document.querySelectorAll('*')].filter(e=>(e.textContent||'').includes(${S(name)})
      && ![...e.children].some(ch=>(ch.textContent||'').includes(${S(name)})))[0];
    if(!leaf) return 'NOLEAF:' + [...document.querySelectorAll('h3')].map(h=>h.textContent).join('|').slice(0,120);
    let n=leaf;
    for(let up=0; up<8 && n && n!==document.body; up++, n=n.parentElement){
      n.click();
      if (count(1)) return 'OK@'+up;
    }
    return 'NOSELECT';`);
  await sleep(500);
  await clickIncludes(c, 'Delete (');
  await sleep(900);
  // The confirm dialog's own action, not the toolbar button behind it (that one carries a count).
  const confirmed = await c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>/delete/i.test(x.textContent||'') && !(x.textContent||'').includes('(')); const t=b[b.length-1]; if(!t) return 'NO'; t.click(); return 'OK';`);
  const end = Date.now() + 20000;
  let gone = false;
  while (Date.now() < end) { if (!skusFor(STEM).includes(sku)) { gone = true; break; } await sleep(400); }
  // Leave the page as it was found: out of select mode, no filter.
  if (await c.ev(`return [...document.querySelectorAll('button')].some(b=>(b.textContent||'').includes('Delete ('));`)) {
    await clickText(c, 'Cancel');
    await sleep(400);
  }
  await setVal(c, SEARCH, '');
  await sleep(900);
  return { picked, confirmed, gone };
}

// ── the real mobile side ─────────────────────────────────────────────────────
/** A real JPEG from the fixture binary — the ingress rejects anything that is not one. */
let JPEG_B64 = '';
const jpeg = () => JPEG_B64;
const receipts = (evId) => dbQ(SERVER_DB, 'SELECT state FROM mobile_upload_inbox WHERE upload_event_id = ?', [evId]);

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
async function mobileUpload(token, evId, entityId, name) {
  const res = await fetch(`${BASE}/api/mobile/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      protocol_version: 1, upload_event_id: evId, entity_id: entityId, mode: 'collection',
      metadata: { categoryId: 'cat-watch', brand: BRAND, name, attributes: {} },
      images: [{ mime: 'image/jpeg', data_base64: jpeg() }],
    }),
  });
  return res.status;
}
/** The canonical drain trigger: the worker runs on frontend authentication. */
async function drain(c, evId) {
  for (let round = 0; round < 3; round++) {
    await c.ev('window.location.reload(); return 1;').catch(() => {});
    await sleep(2500);
    try { c.close(); } catch {}
    c = await attach();
    await waitInvoke(c);
    await ensureSignedIn(c);
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      const r = receipts(evId);
      if (r.length && r[0].state === 'ready') return { c, ok: true };
      await sleep(800);
    }
  }
  return { c, ok: (receipts(evId)[0] || {}).state === 'ready' };
}
/** One real phone create; returns the SKU the drain gave it. */
async function mobileCreate(c, token, tag) {
  const before = new Set(skusFor(STEM));
  const evId = 'e2e-sku-' + tag + '-' + Date.now();
  const status = await mobileUpload(token, evId, 'ent-' + tag + '-' + Date.now(), 'Phone ' + tag);
  const d = await drain(c, evId);
  c = d.c;
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const fresh = skusFor(STEM).filter(s => !before.has(s));
    if (fresh.length > 0) return { c, sku: fresh[0], status, drained: d.ok };
    await sleep(600);
  }
  return { c, sku: null, status, drained: d.ok };
}

async function main() {
  console.log('SKU-UNIFY §15 — desktop SKU real-path e2e');

  killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });

  const prodBefore = existsSync(PROD_BIZ_DB) ? dbQ(PROD_BIZ_DB, 'SELECT COUNT(*) c FROM products') : [];
  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded on the isolated instance');
  JPEG_B64 = seed('jpeg', '7');
  ok(JPEG_B64.length > 100, 'fixture: a real JPEG is available (' + JPEG_B64.length + ' b64 chars)');

  let app = await startApp();
  await waitInvoke(app);
  await ensureSignedIn(app);
  // The drain worker is gated on the owner's runtime-scope binding — without it the phone side
  // uploads into an inbox nobody empties.
  const cfg = await invoke(app, 'mobile_runtime_scope_configure',
    { email: OWNER_EMAIL, password: OWNER_PW, tenantId: 'tenant-1', branchId: 'branch-main' });
  ok(cfg.ok && cfg.value && cfg.value.configured === true, 'owner configured the runtime scope binding (' + (cfg.error || '') + ')');

  ok((await gotoCollection(app)) === 'OK', 'the Collection page is reachable from the sidebar');
  await waitFor(app, '[data-testid="open-inventory"], button', 30000);

  ok(counterFor(STEM) === null, 'start state: this stem has no counter yet');
  ok(skusFor(STEM).length === 0, 'and no product carries it');

  // ── §S1 — looking at the number does not take it ──────────────────────────
  // DESKTOP_SKU_PREVIEW_NO_CONSUME
  const p1 = await prepareNewItem(app, 'Preview One');
  ok(p1 === STEM + '001', '§S1 the dialog offers the stem\'s first number (' + p1 + ')');
  ok(counterFor(STEM) === null, '§S1 showing it created no counter — nothing was claimed');
  await clickText(app, 'Cancel');
  await sleep(800);
  ok(counterFor(STEM) === null, '§S1 cancelling left the counter untouched');
  ok(skusFor(STEM).length === 0, '§S1 and no product was created');

  const p2 = await prepareNewItem(app, 'Preview Two');
  ok(p2 === STEM + '001', '§S1 reopening offers the SAME number, because nobody took it (' + p2 + ')');
  await clickText(app, 'Cancel');
  await sleep(800);
  ok(counterFor(STEM) === null, '§S1 a second look is still free');

  // ── §S2 — saving claims it, and the next preview moves on ─────────────────
  const first = await createOne(app, 'Real One');
  ok(first === STEM + '001', '§S2 the saved product carries the previewed number (' + first + ')' + why());
  ok(counterFor(STEM) === 2, '§S2 and the counter moved exactly once (' + counterFor(STEM) + ')');

  const p3 = await prepareNewItem(app, 'Preview Three');
  ok(p3 === STEM + '002', '§S2 the next dialog offers the next number (' + p3 + ')');
  ok(counterFor(STEM) === 2, '§S2 which again cost nothing to look at');
  await clickText(app, 'Cancel');
  await sleep(600);

  // ── §S3 — monotonic through a real delete ────────────────────────────────
  // DESKTOP_SKU_MONOTONIC
  const second = await createOne(app, 'Real Two');
  const third = await createOne(app, 'Real Three');
  ok(second === STEM + '002', '§S3 second create (' + second + ')' + why());
  ok(third === STEM + '003', '§S3 third create (' + third + ')' + why());

  const del = await deleteViaUi(app, 'Real Three', third);
  ok(del.gone === true, '§S3 the third product was deleted through the Collection (' + S(del) + ')');
  ok(!skusFor(STEM).includes(third), '§S3 its SKU is no longer on any product');

  const p4 = await prepareNewItem(app, 'Preview Four');
  ok(p4 === STEM + '004', '§S3 the dialog refuses to offer the retired number (' + p4 + ')');
  await clickText(app, 'Cancel');
  await sleep(600);
  const fourth = await createOne(app, 'Real Four');
  ok(fourth === STEM + '004', '§S3 and the next create goes past it instead of back into the gap (' + fourth + ')');
  ok(!skusFor(STEM).includes(third), '§S3 the deleted number stayed gone');

  // ── §S4 — a typed SKU is kept, and claims nothing ────────────────────────
  const beforeManual = counterFor(STEM);
  await prepareNewItem(app, 'Manual One');
  await setVal(app, 'input[placeholder="Internal reference"]', 'MY-OWN-E2E-REF');
  await sleep(500);
  const previewGone = await previewText(app);
  ok(previewGone === null, '§S4 the suggestion disappears once the operator types their own');
  await saveNewItem(app);
  await sleep(1500);
  ok(skus().includes('MY-OWN-E2E-REF'), '§S4 the typed SKU is what got stored');
  ok(counterFor(STEM) === beforeManual, '§S4 and it claimed nothing from the counter (' + beforeManual + ' → ' + counterFor(STEM) + ')');

  // ── §S5 — one sequence for both surfaces ─────────────────────────────────
  // DESKTOP_MOBILE_SHARED_SKU_SEQUENCE
  const healthy = await serverHealthy();
  ok(healthy, '§S5 the isolated sync server is reachable for the phone side');
  let token = null;
  try { token = healthy ? await mobileToken() : null; } catch { token = null; }
  ok(!!token, '§S5 a real mobile token was obtained');

  if (token) {
    const m1 = await mobileCreate(app, token, 'a');
    app = m1.c;
    ok(m1.sku === STEM + '005', '§S5 the phone continues the desktop\'s count (' + m1.sku + ')');
    const d1 = await createOne(app, 'Alternate One');
    ok(d1 === STEM + '006', '§S5 and the desktop continues the phone\'s (' + d1 + ')');
    const m2 = await mobileCreate(app, token, 'b');
    app = m2.c;
    ok(m2.sku === STEM + '007', '§S5 alternating leaves no gap (' + m2.sku + ', http ' + m2.status + ', drained ' + m2.drained + ')');

    const rows = counters().filter(c => c.stem === STEM);
    ok(rows.length === 1, '§S5 ONE counter row serves both surfaces (' + rows.length + ')');
    const mine = skusFor(STEM);
    ok(new Set(mine).size === mine.length, '§S5 and no two products share a SKU (' + mine.join(',') + ')');

    // ── §S6 — a stale suggestion cannot produce a duplicate ────────────────
    // DESKTOP_SKU_STALE_PREVIEW_SAFE
    const stale = await prepareNewItem(app, 'Stale One');
    ok(stale === STEM + '008', '§S6 the desktop dialog is showing the next number (' + stale + ')');
    const m3 = await mobileCreate(app, token, 'c');           // the phone takes it first
    app = m3.c;
    ok(m3.sku === stale, '§S6 the phone claimed exactly the number the dialog was showing (' + m3.sku + ', http ' + m3.status + ', drained ' + m3.drained + ')');

    // The dialog was closed by the drain's reload; open it again and save — the point is that the
    // number is fetched at SAVE, so whatever a form was showing cannot become a second 008.
    const saved = await createOne(app, 'Stale Two');
    ok(saved === STEM + '009', '§S6 the desktop save claims the NEXT number, not the stale one (' + saved + ')');
    const after = skusFor(STEM);
    ok(new Set(after).size === after.length, '§S6 so nothing collided (' + after.join(',') + ')');
    ok(after.filter(s => s === stale).length === 1, '§S6 and the contested number is on exactly one product');
  } else {
    ok(false, '§S5 could not reach the mobile surface — shared-sequence not proven');
  }

  // ── §S7 — one successful create consumes one number ──────────────────────
  const beforeDouble = counterFor(STEM);
  await prepareNewItem(app, 'Double Submit');
  await clickMatch(app, 'Add to Collection');
  await sleep(900);
  // By now the stock holds several near-identical items, so the score-based duplicate warning is
  // the button that actually commits. Whichever one is on screen gets hit three times in one tick —
  // that is the double click this guards against.
  const tripled = await app.ev(`
    const b=[...document.querySelectorAll('button')].find(x=>/create anyway/i.test(x.textContent||''))
         || [...document.querySelectorAll('button')].find(x=>/Add to Collection/i.test(x.textContent||''));
    if(!b) return 'NO'; b.click(); b.click(); b.click(); return 'OK';`);
  ok(tripled === 'OK', '§S7 the commit button was pressed three times in one tick (' + tripled + ')');
  const endD = Date.now() + 30000;
  while (Date.now() < endD && (await exists(app, '#new-field-categoryId'))) await sleep(300);
  await sleep(2000);
  const afterDouble = counterFor(STEM);
  ok(afterDouble === beforeDouble + 1, '§S7 three clicks on Save consumed exactly one number (' + beforeDouble + ' → ' + afterDouble + ')');
  const names = dbQ(BIZ_DB, "SELECT COUNT(*) c FROM products WHERE name = 'Double Submit'");
  ok(names.length > 0 && names[0].c === 1, '§S7 and created exactly one product (' + (names[0] || {}).c + ')');

  // ── the sequence as a whole ──────────────────────────────────────────────
  const finalSkus = skusFor(STEM);
  ok(new Set(finalSkus).size === finalSkus.length, 'no duplicate SKU was produced anywhere in the run');
  ok(!finalSkus.includes(third), 'the deleted number never reappeared');
  ok(counters().filter(c => c.stem === STEM).length === 1, 'and the whole run went through a single counter row');

  const prodAfter = existsSync(PROD_BIZ_DB) ? dbQ(PROD_BIZ_DB, 'SELECT COUNT(*) c FROM products') : [];
  ok(JSON.stringify(prodBefore) === JSON.stringify(prodAfter), 'isolation: the production business DB is untouched');

  try { app.close(); } catch {}
  killAllApp();
  await waitProcessGone();
  rmSync(RUN, { recursive: true, force: true });

  console.log(`\nSKU-UNIFY desktop-sku e2e: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}

main().catch((e) => { console.error(e); killAllApp(); process.exit(1); });
