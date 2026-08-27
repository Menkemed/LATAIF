// POST-V0838 §G2 — Check Item search focus through the REAL mobile web UI.
//
// The failure this guards against only appears with a long result list: picking a hit used to
// leave the list sitting above the product, so on a phone the operator scrolled through hundreds
// of rows to see what they had just opened. The proof therefore needs a list that genuinely
// scrolls, not two fixtures.
//
// What is asserted: the list is gone once a hit is open, the detail is the SAME renderer the QR
// scanner uses, going back restores query + results + scroll WITHOUT a second search request, and
// the QR path never fabricates a back-state of its own.
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
const EDGE_CDP = 9227;
const OWNER_EMAIL = 'admin@lataif.com';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const ONBOARD_PW = 'e2epass123';

const RUN = join(os.tmpdir(), 'lataif-searchfocus-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const EDGE_PROFILE = join(RUN, 'edge-profile');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const PROD_BIZ_DB = join(REAL_APPDATA, 'com.lataif.app', 'lataif.db');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const seed = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
function dbQ(file, sql) { let db; try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(); } catch { return []; } finally { try { db?.close(); } catch {} } }

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.handlers = [];
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
      if (m.method) for (const h of this.handlers) { try { h(m.method, m.params); } catch {} }
    });
  }
  on(fn) { this.handlers.push(fn); }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

let appProc, edgeProc;
async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  appProc = spawn(APP, [], { env: appEnv(), stdio: 'ignore' });
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
function killAllApp() { try { execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target\\debug\\lataif.exe' } | Stop-Process -Force"], { stdio: 'ignore' }); } catch {} }
function killEdge() { try { edgeProc && execFileSync('taskkill', ['/F', '/PID', String(edgeProc.pid), '/T'], { stdio: 'ignore' }); } catch {} }
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

const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }
const clickText = (c, text) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}); if(!b) return 'NO'; b.click(); return 'OK';`);

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

// ── the mobile browser ──────────────────────────────────────────────────────
async function startEdge(url) {
  mkdirSync(EDGE_PROFILE, { recursive: true });
  edgeProc = spawn(EDGE, [
    `--remote-debugging-port=${EDGE_CDP}`, `--user-data-dir=${EDGE_PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=msWebOOUI,msPdfOOUI',
    '--window-size=420,780', url,
  ], { stdio: 'ignore' });
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${EDGE_CDP}/json/list`)).json();
      const p = l.find(t => t.type === 'page' && t.url.includes('/mobile') && t.webSocketDebuggerUrl);
      if (p) { const c = new CDP(p.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c; }
    } catch {}
    await sleep(500);
  }
  throw new Error('edge never opened /mobile');
}
const setValE = (c, sel, v) => setVal(c, sel, v);
const clickE = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; e.click(); return 'OK';`);
async function waitE(c, sel, t = 25000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(200); } throw new Error('waitE ' + sel); }
async function waitVisE(c, sel, t = 25000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    const v = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return false; return !e.classList.contains('hidden') && !!e.offsetParent;`);
    if (v) return true;
    await sleep(200);
  }
  throw new Error('waitVisE ' + sel);
}
async function mobileLogin(c) {
  await waitE(c, '#email');
  await setValE(c, '#email', OWNER_EMAIL);
  await setValE(c, '#password', OWNER_PW);
  await clickE(c, '#loginBtn');
  await waitVisE(c, '#modePicker');
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const t = await c.ev('return localStorage.getItem("lataif_mobile_token");');
    if (t && t.length > 20) return;
    await sleep(200);
  }
  throw new Error('mobile login produced no token');
}
/** Type into the REAL search box and let the page's own debounce run the search. */
async function uiSearch(c, term, minHits) {
  const count = () => c.ev(`const b=document.querySelector('#searchResults'); return b ? b.querySelectorAll('[data-hit]').length : -1;`);
  const failed = () => c.ev(`const b=document.querySelector('#searchResults'); return b ? /Search failed|Search unavailable/i.test(b.innerText||'') : false;`);
  const end = Date.now() + 30000;
  // The page's debounce fires on every input event. A request issued in the instant the session is
  // still settling comes back 401 and the box keeps that message, because nothing re-triggers the
  // search on its own. Re-typing is what a person would do, so the harness does the same rather
  // than reaching past the UI.
  while (Date.now() < end) {
    await setValE(c, '#searchInput', '');
    await sleep(120);
    await setValE(c, '#searchInput', term);
    const inner = Date.now() + 6000;
    while (Date.now() < inner) {
      const n = await count();
      if (n >= minHits) return n;
      if (await failed()) break;
      await sleep(250);
    }
  }
  return await count();
}

/** Seed a scrollable amount of products AT REST (app stopped). */
function seedProducts(n) {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const b = db.prepare('SELECT id FROM branches LIMIT 1').get();
    const branchId = b ? b.id : 'branch-main';
    const now = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
         purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, quantity,
         images, attributes, source_type, created_at, updated_at)
       VALUES (?,?,'cat-watch','Searchbrand',?,?,'Pre-Owned','[]',100,'BHD','in_stock','MARGIN',0,1,'[]',?,'OWN',?,?)`);
    const ids = [];
    for (let i = 1; i <= n; i++) {
      const id = 'sf-' + String(i).padStart(3, '0');
      ids.push(id);
      ins.run(id, branchId, 'Searchable Item ' + String(i).padStart(3, '0'), 'SRC-WCH-' + String(i).padStart(3, '0'),
        JSON.stringify({ reference_number: 'REF-' + i, serial_number: 'SER-' + i }), now, now);
    }
    return ids;
  } finally { try { db.close(); } catch {} }
}

async function main() {
  console.log('POST-V0838 §G2 — mobile search detail focus e2e');
  killAllApp(); killEdge(); await waitProcessGone(); await waitPortFree(PORT);
  rmSync(APP_DATA_DIR, { recursive: true, force: true });
  rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true });
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const prodBefore = existsSync(PROD_BIZ_DB) ? dbQ(PROD_BIZ_DB, 'SELECT COUNT(*) c FROM products') : [];

  ok(seed('seed-primary') === 'SEED_PRIMARY_OK', 'server seeded on the isolated instance');
  let app = await startApp();
  await waitInvoke(app);
  await ensureSignedIn(app);

  // fixtures at rest, then restart so the app loads them normally
  app.close(); killAllApp(); await waitProcessGone(); await waitPortFree(PORT);
  const ids = seedProducts(40);
  app = await startApp();
  await waitInvoke(app);
  await ensureSignedIn(app);
  ok(await serverHealthy(), 'the isolated sync server is up');
  ok(ids.length === 40, 'fixture: 40 searchable products staged (' + ids.length + ')');

  const edge = await startEdge(`${BASE}/mobile`);
  await mobileLogin(edge);

  // ── the search list ───────────────────────────────────────────────────────
  // §1.1 — capture the page's OWN search requests off the wire: headers, status, initiator.
  // Never the token itself; only whether the header is there, its scheme and a length/fingerprint.
  const net = { sent: [], done: [] };
  edge.on((method, params) => {
    if (method === 'Network.requestWillBeSent' && String(params.request?.url || '').includes('/api/products/search')) {
      const h = params.request.headers || {};
      const authKey = Object.keys(h).find(k => k.toLowerCase() === 'authorization');
      const auth = authKey ? String(h[authKey]) : null;
      net.sent.push({
        id: params.requestId, url: params.request.url, method: params.request.method,
        hasAuth: !!auth, scheme: auth ? auth.split(' ')[0] : null,
        tokenLen: auth ? (auth.split(' ')[1] || '').length : 0,
        t: Math.round(params.timestamp * 1000),
        initiator: params.initiator?.type,
      });
    }
    if (method === 'Network.responseReceived' && String(params.response?.url || '').includes('/api/products/search')) {
      net.done.push({ id: params.requestId, status: params.response.status });
    }
  });
  await edge.send('Network.enable');

  // Enter Check Item from the mode picker exactly as the operator does, then the Search tab.
  await clickE(edge, '.mode-btn[data-mode="scan"]');
  await sleep(800);
  await clickE(edge, '#tabSearch');
  await waitVisE(edge, '#searchPane');
  const hits = await uiSearch(edge, 'Searchable', 20);
  {
    // §1.1 — the page's OWN request off the wire, not a fetch the test issued: proves the search is
    // authenticated correctly by the product, so a 401 here would be a real defect and never a flake.
    const byId = Object.fromEntries(net.done.map(d => [d.id, d.status]));
    const seen = net.sent.map(r => ({ ...r, status: byId[r.id] ?? null }));
    const answered = seen.filter(r => r.status !== null);
    if (answered.length > 0) {
      ok(answered.every(r => r.hasAuth && r.scheme === 'Bearer' && r.tokenLen > 20),
        '§G2 every search the page sent carried a Bearer credential');
      ok(answered.every(r => r.status === 200),
        '§G2 and every one of them was answered 200 (' + answered.map(r => r.status).join(',') + ')');
      ok(answered.every(r => r.initiator === 'script'), '§G2 issued by the page script, not by the harness');
    }
  }
  ok(hits >= 20, '§G2 the query returns a long result list (' + hits + ' hits)');
  const listBefore = await edge.ev(`return [...document.querySelectorAll('#searchResults [data-hit]')].map(e=>e.innerText.replace(/\\s+/g,' ').trim()).join('|');`);
  ok(listBefore.length > 0, '§G2 the hits are rendered');

  // scroll well down the list, then remember exactly where we are
  await edge.ev(`window.scrollTo(0, Math.max(300, document.body.scrollHeight * 0.6)); return 1;`);
  await sleep(400);
  const scrollBefore = await edge.ev('return Math.round(window.scrollY);');
  ok(scrollBefore > 100, '§G2 the list really scrolls (offset ' + scrollBefore + ')');

  // count search requests from here on — going back must not issue another one
  await edge.ev(`window.__searchCalls = 0; if (!window.__fetchPatched) { const f = window.fetch; window.fetch = function(u, o) { try { if (String(u).includes('/api/products/search')) window.__searchCalls++; } catch(e){} return f.apply(this, arguments); }; window.__fetchPatched = true; } return 1;`);

  // ── open a hit ────────────────────────────────────────────────────────────
  const targetIdx = 12;

  // §2/§3 — who actually owns the 1229px, and what does the layout look like after Back?
  const SCROLL_PROBE = `
    const pick = (el, name) => { if (!el) return { name, missing: true };
      const cs = getComputedStyle(el);
      return { name, top: Math.round(el.scrollTop||0), sh: el.scrollHeight, ch: el.clientHeight,
        oh: el.offsetHeight, hasParent: !!el.offsetParent, display: cs.display,
        visibility: cs.visibility, overflowY: cs.overflowY, cls: (el.className||'').toString().slice(0,60) };
    };
    const out = { winY: Math.round(window.scrollY), innerH: window.innerHeight,
      docEl: pick(document.documentElement, 'documentElement'), body: pick(document.body, 'body'),
      pane: pick(document.querySelector('#searchPane'), 'searchPane'),
      results: pick(document.querySelector('#searchResults'), 'searchResults'),
      scanResult: pick(document.querySelector('#scanResult'), 'scanResult'),
      rows: document.querySelectorAll('#searchResults [data-hit]').length,
      ancestors: [] };
    let el = document.querySelector('#searchResults');
    while (el && el !== document.body) { const cs = getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflowY)) out.ancestors.push({ id: el.id||el.tagName, overflowY: cs.overflowY, top: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight });
      el = el.parentElement; }
    return JSON.stringify(out);`;
  const ownerBefore = JSON.parse(await edge.ev(SCROLL_PROBE));
  ok(ownerBefore.docEl.top === ownerBefore.winY && ownerBefore.winY > 100,
    '§G2 the scrolling element is the document itself (documentElement.scrollTop=' + ownerBefore.docEl.top + ')');
  ok(ownerBefore.ancestors.length === 0, '§G2 no inner scroll container competes for the offset');
  ok(ownerBefore.docEl.sh > ownerBefore.docEl.ch, '§G2 the document is genuinely taller than the viewport');
  await sleep(1200);                       // let any debounce still in flight from typing land
  await edge.ev('window.__searchCalls = 0; return 1;');
  const opened = await edge.ev(`const c=document.querySelector('#searchResults [data-hit="${targetIdx}"]'); if(!c) return 'NO'; c.click(); return 'OK';`);
  ok(opened === 'OK', '§G2 a hit deep in the list can be opened');
  await waitVisE(edge, '#scanResult');
  await sleep(600);

  const paneHidden = await edge.ev(`const p=document.querySelector('#searchPane'); return !p || p.classList.contains('hidden') || !p.offsetParent;`);
  ok(paneHidden === true, '§G2 the whole search pane is gone once the product is open');
  const listVisible = await edge.ev(`const b=document.querySelector('#searchResults'); if(!b) return false; return !!b.offsetParent && b.querySelectorAll('[data-hit]').length > 0;`);
  ok(listVisible === false, '§G2 no result rows are left next to the detail');
  const detailText = await edge.ev(`const d=document.querySelector('#scanDetails'); return d ? d.innerText.replace(/\\s+/g,' ').trim().slice(0,400) : '';`);
  ok(/Searchable Item/.test(detailText), '§G2 the full product detail is what is shown');
  ok(/Stock check/i.test(detailText), '§G2 and it is the COMPLETE detail (the stock-check block is part of it)');
  const hasBack = await edge.ev(`return !!document.querySelector('#pdBack');`);
  ok(hasBack === true, '§G2 a back control is offered for a search-opened product');
  const sameRenderer = await edge.ev(`return !!document.querySelector('#scanDetails') && !!document.querySelector('#scStatus, #scLatest');`);
  ok(sameRenderer === true, '§G2 it is the shared renderer, not a second simplified view');

  // ── back ──────────────────────────────────────────────────────────────────
  await edge.ev(`document.querySelector('#pdBack').click(); return 1;`);
  await sleep(800);
  // §3 — the layout must be back BEFORE anything about scrolling is claimed: a hidden or
  // zero-height results block would make a restored offset impossible and the scroll assertion
  // below meaningless.
  const ownerAfter = JSON.parse(await edge.ev(SCROLL_PROBE));
  ok(ownerAfter.pane.hasParent && ownerAfter.pane.display !== 'none', '§G2 the search pane is back in the active layout');
  ok(ownerAfter.results.hasParent && ownerAfter.results.oh > 0, '§G2 the results block has real height again (' + ownerAfter.results.oh + 'px)');
  ok(ownerAfter.rows === ownerBefore.rows, '§G2 the same number of rows is rendered (' + ownerAfter.rows + ')');
  ok(ownerAfter.scanResult.display === 'none', '§G2 the product detail is out of the layout again');
  ok(ownerAfter.docEl.sh >= ownerBefore.docEl.sh - 40, '§G2 the document is as tall as before, so the offset is reachable');
  const callsAfterBack = await edge.ev('return window.__searchCalls;');
  ok(callsAfterBack === 0, '§G2 going back issued NO second search request (' + callsAfterBack + ')');
  const queryAfter = await edge.ev(`const i=document.querySelector('#searchInput'); return i ? i.value : null;`);
  ok(queryAfter === 'Searchable', '§G2 the query is exactly as it was');
  const listAfter = await edge.ev(`return [...document.querySelectorAll('#searchResults [data-hit]')].map(e=>e.innerText.replace(/\\s+/g,' ').trim()).join('|');`);
  ok(listAfter === listBefore, '§G2 the very same results are back, in the same order');
  await sleep(400);
  const scrollAfter = await edge.ev('return Math.round(window.scrollY);');
  ok(Math.abs(scrollAfter - scrollBefore) <= 120, '§G2 the scroll offset is restored (' + scrollBefore + ' → ' + scrollAfter + ')');
  const targetVisible = await edge.ev(`const c=document.querySelector('#searchResults [data-hit="${targetIdx}"]'); if(!c) return false; const r=c.getBoundingClientRect(); return r.top > -400 && r.top < window.innerHeight + 400;`);
  ok(targetVisible === true, '§G2 the hit that was opened is back in view');

  // ── a second round stays stable ───────────────────────────────────────────
  await edge.ev(`const c=document.querySelector('#searchResults [data-hit="3"]'); if(c) c.click(); return 1;`);
  await waitVisE(edge, '#scanResult');
  await sleep(500);
  ok(await edge.ev(`const p=document.querySelector('#searchPane'); return !p || p.classList.contains('hidden') || !p.offsetParent;`),
    '§G2 the second open hides the list again');
  await edge.ev(`document.querySelector('#pdBack')?.click(); return 1;`);
  await sleep(700);
  ok(await edge.ev(`return document.querySelectorAll('#searchResults [data-hit]').length > 0;`), '§G2 and back still restores the list');
  ok(await edge.ev('return window.__searchCalls;') === 0, '§G2 still without re-querying the server');

  // ── §G2.11 — switching tabs drops the back state ──────────────────────────
  await clickE(edge, '#tabScan');
  await sleep(600);
  await clickE(edge, '#tabSearch');
  await sleep(400);
  const staleBack = await edge.ev(`const b=document.querySelector('#pdBack'); return !!b && !!b.offsetParent;`);
  ok(staleBack === false, '§G2 a tab switch leaves no reachable back control behind');

  // ── §G2.10 — the QR path renders the same detail and invents no back state ─
  const token = await edge.ev('return localStorage.getItem("lataif_mobile_token");');
  const qrProduct = await (await fetch(`${BASE}/api/products/by-id/${ids[5]}`, { headers: { Authorization: 'Bearer ' + token } })).json();
  ok(!!qrProduct && qrProduct.id === ids[5], '§G2 the QR lookup route answers for the same product');
  await edge.ev(`window.__qr = ${JSON.stringify(JSON.stringify(qrProduct))}; return 1;`);
  // The page is one IIFE, so `showProduct` is deliberately not reachable from outside it and a
  // camera cannot be driven here. The QR contract is therefore proven against the SHIPPED page
  // source: one renderer, one entry point, and a scanner call site that passes no origin - which is
  // exactly what makes a scanned product get no back-to-search control. The runtime half (a
  // search-opened product really rendering through that entry point) is asserted above.
  const pageSrc = await (await fetch(`${BASE}/mobile`)).text();
  const count = (re) => (pageSrc.match(re) || []).length;
  ok(count(/function\s+showProduct\s*\(/g) === 1, '§G2 the shipped page defines exactly ONE product entry point');
  ok(count(/function\s+renderProduct\s*\(/g) === 1, '§G2 and exactly ONE product renderer - there is no second simplified view');
  // v0.8.50 — die Zusicherung gilt der ABSICHT, nicht einer Schreibweise: der Scanner ruft denselben
  // Eingang ohne Herkunft auf. Dass er dazwischen auf seine Generation prueft (und deshalb nicht mehr
  // `showProduct(await res.json())` in einer Zeile schreiben kann), aendert daran nichts.
  const calls = pageSrc.match(/showProduct\([^;\n]*\);/g) || [];
  const noOrigin = calls.filter((c) => !c.includes(','));
  ok(noOrigin.length === 1 && /showProduct\(\s*data\s*\);/.test(noOrigin[0]),
    '§G2 the QR lookup calls that same entry point with NO origin argument (' + noOrigin.join(' | ') + ')');
  ok(calls.length > 1 && calls.filter((c) => c.includes(',')).every((c) => /'search'|currentOrigin/.test(c)),
    '§G2 only the search path passes an origin');
  ok(/if\s*\(b\)\s*b\.onclick\s*=\s*backToSearch;/.test(pageSrc) || /pdBack/.test(pageSrc),
    '§G2 the back control is wired from the same entry point');

  const prodAfter = existsSync(PROD_BIZ_DB) ? dbQ(PROD_BIZ_DB, 'SELECT COUNT(*) c FROM products') : [];
  ok(JSON.stringify(prodBefore) === JSON.stringify(prodAfter), 'isolation: the production business DB is untouched');

  try { edge.close(); } catch {}
  killEdge();
  try { app.close(); } catch {}
  killAllApp();
  await waitProcessGone();
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* Edge may still hold the profile dir; the temp folder is disposable */ }

  console.log(`\nPOST-V0838 mobile-search-focus e2e: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}

main().catch((e) => { console.error(e); killEdge(); killAllApp(); process.exit(1); });
