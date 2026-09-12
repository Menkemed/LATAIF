// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5D.1 — die übrigen Einstiege der Transfer-Oberfläche vom zweiten Rechner.
// Run: node test/e2e/r5d1-transfer-entrypoints.e2e.mjs
//
//   /transfers/:id  „Edit" → Preis, Rückgabe, Notiz → Save     → transfers.update
//   /transfers/:id  „Mark as Sold" (auch unter Our Price, bestätigt) → transfers.mark_sold
//   /transfers/:id  „Mark as Returned"                          → transfers.mark_returned
//   /agents         „New Transfer" → „+" → „Create & Select"   → customers.create
//
// Bewiesen wird: genau EINE vorhandene Buchung je Handlung, der Primary hat danach denselben Stand
// wie nach derselben Handlung an seiner eigenen Maske, eine verlorene Antwort legt keinen zweiten
// Kunden an, der neue Kunde ist sofort in der Transfermaske gewählt, kein Griff zur lokalen Datenbank.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r5d1-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5d1-entry', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif-e2e-client.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  process.exit(1);
}, 25 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env,
  APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'),
  LATAIF_E2E_SYNC_PORT: String(PORT),
});
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.events = [];
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params?.type || '')) {
        this.events.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.events.push(`exception: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || ''}`.slice(0, 400));
      }
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
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

const killImage = (n) => { try { execFileSync('taskkill', ['/F', '/IM', n, '/T'], { stdio: 'ignore' }); } catch { /* war nicht da */ } };
const killAll = () => { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); };
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const o = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' }); if (!o.includes(name)) return; } catch { return; }
    await sleep(300);
  }
}
async function attachOnly(cdpPort, budget = 60000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function attach(cdpPort, exe, env) {
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setUnterUeberschrift = (c, titel, v) => c.ev(
  `const t=[...document.querySelectorAll('span')].filter(x=>x.textContent.trim()===${S(titel)}).pop(); if(!t) return 'NO-TITLE:'+${S(titel)};`
  + `const e=t.parentElement.querySelector('textarea'); if(!e) return 'NO-TEXTAREA';`
  + `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const SHELL = 'a[href="/settings"]';

const BEOBACHTER = `
  if (window.__r4bInstalliert) { /* schon da */ } else {
  window.__r4bInstalliert = true;
  window.__cmds = [];
  window.__killNext = false;
  window.__dbHits = [];
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => {
    const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/Database not initialized/.test(t)) merke(t);
    oe(...a);
  };
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    if (/\\/api\\/command$/.test(url)) {
      try {
        const body = JSON.parse((a[1] && a[1].body) || '{}');
        window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload });
      } catch (e) { /* kein lesbarer Rumpf */ }
      if (window.__killNext) {
        window.__killNext = false;
        const r = await of(...a);
        try { await r.text(); } catch (e) { /* egal */ }
        throw new TypeError('the answer was lost after the primary had written');
      }
    }
    return of(...a);
  };
  }
`;

function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk) continue;
    if (daten[sp.name] !== undefined) continue;
    const t = String(sp.type || '').toUpperCase();
    daten[sp.name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`)
    .run(...nutzbar.map((k) => daten[k]));
}

/** Offene Transfers — je Handlung einer für den zweiten Rechner (Agent A) und ein Zwilling für den Primary (Agent B). */
const OFFEN = [
  ['r5d1-o1', 'TRF-2025-08001', 'r5d1-agent-a', 'full', 700, null], ['r5d1-o2', 'TRF-2025-08002', 'r5d1-agent-b', 'full', 700, null],
  ['r5d1-o3', 'TRF-2025-08003', 'r5d1-agent-a', 'full', 700, null], ['r5d1-o4', 'TRF-2025-08004', 'r5d1-agent-b', 'full', 700, null],
  ['r5d1-o5', 'TRF-2025-08005', 'r5d1-agent-a', 'split', 1000, 50], ['r5d1-o6', 'TRF-2025-08006', 'r5d1-agent-b', 'split', 1000, 50],
];
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    for (const [id, first, last] of [['r5d1-kunde', 'Nadia', 'Kunde'], ['r5d1-kunde2', 'Omar', 'Zwei']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    const produkt = (id, stock, source) => {
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Omega', name: 'R5D1 ' + id, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 200, purchase_currency: 'BHD', planned_sale_price: 800, stock_status: stock, tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{}', source_type: source, created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: id + '-lot', branch_id, product_id: id, unit_cost: 200, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    };
    for (const id of ['r5d1-c1', 'r5d1-c2']) produkt(id, 'in_stock', 'OWN');
    for (const [aid, cust] of [['r5d1-agent-a', 'r5d1-kunde'], ['r5d1-agent-b', 'r5d1-kunde2']]) {
      insert(db, 'agents', { id: aid, branch_id, name: 'Karim Al Mansour', company: 'KM Trading', phone: '+97333000000', commission_rate: 0, active: 1, customer_id: cust, created_at: now, updated_at: now });
    }
    for (const [id, nr, agent, model, preis, pct] of OFFEN) {
      produkt('p-' + id, 'with_agent', 'AGENT');
      insert(db, 'agent_transfers', {
        id, branch_id, transfer_number: nr, agent_id: agent, product_id: 'p-' + id, agent_price: preis,
        commission_rate: 0, commission_type: 'percent', commission_value: 0, settlement_model: model, excess_split_pct: pct,
        status: 'transferred', transferred_at: now, settlement_paid_amount: 0, settlement_status: 'pending', revision: 1,
        created_at: now, updated_at: now,
      });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
async function lade(c, route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch (e) { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const fehlerAnzeige = (c) => c.ev("return [...document.querySelectorAll('[data-save-error]')].map(e=>e.textContent).join(' | ');");
let primary = null, client = null;

// ── Die Detailseite, wie ein Mensch sie bedient — auf welchem Rechner auch immer ──
async function detailAendern(c) {
  await waitFor(c, '[data-transfer-detail-edit]', 30000);
  await click(c, '[data-transfer-detail-edit]');
  await waitFor(c, '[data-transfer-save]', 15000);
  const r = [
    await setByLabel(c, 'OUR PRICE (BHD)', '750'),
    await setByLabel(c, 'RETURN BY (DATE)', '2026-11-01'),
    await setUnterUeberschrift(c, 'NOTES', 'R5D1 Notiz'),
  ];
  await sleep(250);
  await click(c, '[data-transfer-save]');
  if (!(await warteBis(c, "!document.querySelector('[data-transfer-save]')", 30000))) r.push('NICHT-GESPEICHERT:' + (await fehlerAnzeige(c)));
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
async function detailVerkaufen(c, preis, bestaetigen) {
  await waitFor(c, '[data-transfer-detail-sold]', 30000);
  await click(c, '[data-transfer-detail-sold]');
  await waitFor(c, '[data-transfer-sold-confirm]', 15000);
  if (await setByLabel(c, 'ACTUAL SALE PRICE (BHD)', String(preis)) !== 'OK') return 'KEIN-PREISFELD';
  await sleep(300);
  if (bestaetigen) {
    if (!(await warteBis(c, "document.querySelector('input[type=checkbox]')", 10000))) return 'KEINE-BESTAETIGUNG';
    if (await c.ev("return document.querySelector('[data-transfer-sold-confirm]').disabled;") !== true) return 'OHNE-BESTAETIGUNG-FREI';
    await c.ev("[...document.querySelectorAll('input[type=checkbox]')].pop().click(); return 1;");
    await sleep(250);
  }
  await click(c, '[data-transfer-sold-confirm]');
  return (await warteBis(c, "!document.querySelector('[data-transfer-sold-confirm]')", 30000)) ? 'OK' : 'NICHT-VERKAUFT:' + (await fehlerAnzeige(c));
}
async function detailZurueck(c) {
  await waitFor(c, '[data-transfer-detail-return]', 30000);
  await click(c, '[data-transfer-detail-return]');
  return 'OK';
}
/** „New Transfer" → „+" → Vor- und Nachname → „Create & Select". */
async function neuerKundeInMaske(c, vorname, nachname) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Transfer')", 40000))) return 'KEIN-KNOPF';
  await clickText(c, 'New Transfer');
  await waitFor(c, '[data-create-transfer]', 15000);
  await click(c, 'button[title="New Client"]');
  await waitFor(c, '[data-quick-customer-save]', 15000);
  const r = [await setByLabel(c, 'FIRST NAME', vorname), await setByLabel(c, 'LAST NAME', nachname)];
  await sleep(250);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
const imKundenfeld = (c, name) => warteBis(c,
  `(document.querySelector('[data-ss-trigger="Search clients..."]')?.textContent || '').includes(${S(name)})`, 30000);

// ── Was am Primary steht ──
const TR_OHNE = /^(id|agent_id|product_id|transfer_number|version|sync_status)$|_at$/;
const KU_OHNE = /^(id|first_name|last_name|version|sync_status)$|_at$/;
const norm = (r, ohne) => S(Object.fromEntries(Object.entries(r || {}).filter(([k]) => !ohne.test(k)).sort(([a], [b]) => a.localeCompare(b))));
const transfer = (id) => dbQ(BIZ_DB, 'SELECT * FROM agent_transfers WHERE id = ?', [id])[0] || {};
const forderung = (id) => S(dbQ(BIZ_DB, 'SELECT account, direction, ROUND(SUM(amount), 3) AS s FROM ledger_entries WHERE source_id = ? GROUP BY account, direction ORDER BY account, direction', [id]));
const stueck = (id) => S(dbQ(BIZ_DB, 'SELECT stock_status, source_type, quantity FROM products WHERE id = ?', ['p-' + id])[0] || {});
async function warteAuf(pruefe) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}

try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Der Primary ────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5D1 Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5D1 Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5D1 Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
  primary.close(); primary = null;
  killImage('lataif.exe'); await waitGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL, 90000);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }

  // ── Der Client: echter Weg, kein Kniff ────────────────────────────────
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await click(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await click(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await click(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  ok(true, 'CONNECT frischer Rechner, echter Klick auf „Connect", Anmeldung — dann die normale Anwendung');
  await beobachterLegen();

  // ══════════════════════════════════════════════════════════════════════
  // §1 DETAILSEITE — Edit, dann Sold
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/transfers/r5d1-o1');
    ok(await warteBis(client, "document.body.innerText.includes('TRF-2025-08001')", 45000), 'DETAIL die Detailseite des Transfers am zweiten Rechner');
    ok(await detailAendern(client) === 'OK', 'DETAIL „Edit" → Preis, Rueckgabe, Notiz → Save');
    const up = (await buchungen(client)).filter((x) => x.op === 'transfers.update');
    ok(up.length === 1, `DETAIL genau EINE Buchung transfers.update (${up.length})`);
    const p = up[0]?.payload || {};
    ok(p.id === 'r5d1-o1' && typeof p.expectedRevision === 'number' && p.agentPrice === 750 && p.returnBy === '2026-11-01' && p.notes === 'R5D1 Notiz',
      `DETAIL der Rumpf: Fassung und genau die drei Felder (${S(p)})`);
    ok(!('status' in p) && !('settlementAmount' in p) && !('productId' in p) && !('agentId' in p), `DETAIL …nichts sonst (${Object.keys(p).join(',')})`);
    await warteAuf(() => transfer('r5d1-o1').notes === 'R5D1 Notiz');
    const t = transfer('r5d1-o1');
    ok(Number(t.agent_price) === 750 && t.return_by === '2026-11-01' && t.notes === 'R5D1 Notiz' && t.status === 'transferred',
      'DETAIL der Primary traegt die Aenderung');
    ok(await warteBis(client, "document.body.innerText.includes('R5D1 Notiz')", 30000), 'DETAIL der zweite Rechner zeigt den neuen Stand — gelesen vom Primary');

    ok(await detailVerkaufen(client, 800, false) === 'OK', 'DETAIL „Mark as Sold" mit dem Verkaufspreis');
    const so = (await buchungen(client)).filter((x) => x.op === 'transfers.mark_sold');
    ok(so.length === 1 && so[0].payload?.salePrice === 800 && so[0].payload?.transferId === 'r5d1-o1' && !('acknowledgeBelowPrice' in (so[0].payload || {})),
      `DETAIL genau EINE Buchung transfers.mark_sold (${S(so[0]?.payload)})`);
    await warteAuf(() => transfer('r5d1-o1').status === 'sold');
    const s = transfer('r5d1-o1');
    ok(s.status === 'sold' && Number(s.actual_sale_price) === 800 && Number(s.settlement_amount) === 800, 'DETAIL der Primary: verkauft, Abrechnung vom Haus');
    ok(stueck('r5d1-o1') === S({ stock_status: 'sold', source_type: 'AGENT', quantity: 0 }), `DETAIL …das Stueck ist verkauft (${stueck('r5d1-o1')})`);
    ok(await warteBis(client, "document.body.innerText.includes('SOLD')", 30000), 'DETAIL der zweite Rechner zeigt „SOLD"');

    await geh(primary, '/transfers/r5d1-o2');
    await warteBis(primary, "document.body.innerText.includes('TRF-2025-08002')", 30000);
    ok(await detailAendern(primary) === 'OK', 'DETAIL-PARITAET dieselbe Aenderung an der Detailseite des Primary');
    await warteAuf(() => transfer('r5d1-o2').notes === 'R5D1 Notiz');
    ok(await detailVerkaufen(primary, 800, false) === 'OK', 'DETAIL-PARITAET derselbe Verkauf am Primary');
    await warteAuf(() => transfer('r5d1-o2').status === 'sold');
    const a = norm(transfer('r5d1-o2'), TR_OHNE), b = norm(transfer('r5d1-o1'), TR_OHNE);
    ok(a === b, `DETAIL-PARITAET Transfer: Primary-Maske == PC2${a !== b ? ` (${a} / ${b})` : ''}`);
    ok(forderung('r5d1-o2') === forderung('r5d1-o1') && forderung('r5d1-o1') !== '[]', `DETAIL-PARITAET dieselbe Forderung aus dem Verkauf (${forderung('r5d1-o1')})`);
    ok(stueck('r5d1-o2') === stueck('r5d1-o1'), 'DETAIL-PARITAET derselbe Bestand');
  }

  // ── Unter Our Price, mit Bestätigung ──
  {
    client = await lade(client, '/transfers/r5d1-o5');
    await warteBis(client, "document.body.innerText.includes('TRF-2025-08005')", 45000);
    ok(await detailVerkaufen(client, 900, true) === 'OK', 'DETAIL-UNTER „Sold" unter Our Price — erst die Bestaetigung gibt den Knopf frei');
    const so = (await buchungen(client)).filter((x) => x.op === 'transfers.mark_sold');
    ok(so.length === 1 && so[0].payload?.acknowledgeBelowPrice === true, `DETAIL-UNTER die Bestaetigung reist mit (${S(so[0]?.payload)})`);
    await warteAuf(() => transfer('r5d1-o5').status === 'sold');
    ok(Number(transfer('r5d1-o5').settlement_amount) === 900, 'DETAIL-UNTER wir bekommen den tatsaechlichen Erloes, kein Split');
    await geh(primary, '/transfers/r5d1-o6');
    await warteBis(primary, "document.body.innerText.includes('TRF-2025-08006')", 30000);
    ok(await detailVerkaufen(primary, 900, true) === 'OK', 'DETAIL-UNTER derselbe Verkauf am Primary');
    await warteAuf(() => transfer('r5d1-o6').status === 'sold');
    ok(norm(transfer('r5d1-o6'), TR_OHNE) === norm(transfer('r5d1-o5'), TR_OHNE) && forderung('r5d1-o6') === forderung('r5d1-o5'),
      'DETAIL-UNTER Primary-Maske == PC2 (Transfer und Forderung)');
  }

  // ── Return ──
  {
    client = await lade(client, '/transfers/r5d1-o3');
    await warteBis(client, "document.body.innerText.includes('TRF-2025-08003')", 45000);
    ok(await detailZurueck(client) === 'OK', 'DETAIL-RETURN „Mark as Returned" am zweiten Rechner');
    ok(await warteAuf(() => transfer('r5d1-o3').status === 'returned'), 'DETAIL-RETURN der Primary: zurueckgenommen');
    const rt = (await buchungen(client)).filter((x) => x.op === 'transfers.mark_returned');
    ok(rt.length === 1 && rt[0].payload?.id === 'r5d1-o3' && typeof rt[0].payload?.expectedRevision === 'number', `DETAIL-RETURN genau EINE Buchung (${S(rt[0]?.payload)})`);
    ok(stueck('r5d1-o3') === S({ stock_status: 'in_stock', source_type: 'OWN', quantity: 1 }), 'DETAIL-RETURN das Stueck liegt wieder im Lager und gehoert uns');
    ok(await warteBis(client, "document.body.innerText.includes('RETURNED')", 30000), 'DETAIL-RETURN der zweite Rechner zeigt „RETURNED"');
    await geh(primary, '/transfers/r5d1-o4');
    await warteBis(primary, "document.body.innerText.includes('TRF-2025-08004')", 30000);
    ok(await detailZurueck(primary) === 'OK', 'DETAIL-RETURN dieselbe Handlung am Primary');
    await warteAuf(() => transfer('r5d1-o4').status === 'returned');
    ok(norm(transfer('r5d1-o4'), TR_OHNE) === norm(transfer('r5d1-o3'), TR_OHNE) && stueck('r5d1-o4') === stueck('r5d1-o3'),
      'DETAIL-RETURN Primary-Maske == PC2');
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §2 „+ New Client" in der Transfermaske — mit verlorener Antwort
  // ══════════════════════════════════════════════════════════════════════
  let neuPc2 = '';
  {
    client = await lade(client, '/agents');
    ok(await neuerKundeInMaske(client, 'Lina', 'Client') === 'OK', 'CLIENT „New Transfer" → „+" → die Schnellanlage');
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-quick-customer-save]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'CLIENT die verlorene Antwort wird als offen gemeldet, nicht als Erfolg');
    ok(await exists(client, '[data-quick-customer-save]'), 'CLIENT …die Schnellanlage bleibt offen');
    await click(client, '[data-quick-customer-save]');
    ok(await warteBis(client, "!document.querySelector('[data-quick-customer-save]')", 30000), 'CLIENT der zweite Versuch derselben Absicht kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'customers.create');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `CLIENT zwei Anfragen, DIESELBE Kennung, derselbe Rumpf (${c.length})`);
    ok(S(c[0]?.payload) === S({ firstName: 'Lina', lastName: 'Client' }), `CLIENT der Rumpf der Kundenliste (${S(c[0]?.payload)})`);
    await warteAuf(() => dbQ(BIZ_DB, "SELECT id FROM customers WHERE first_name = 'Lina' AND last_name = 'Client'").length > 0);
    const k = dbQ(BIZ_DB, "SELECT * FROM customers WHERE first_name = 'Lina' AND last_name = 'Client'");
    ok(k.length === 1, `CLIENT genau EIN neuer Kunde am Primary (${k.length})`);
    neuPc2 = String(k[0]?.id || '');
    ok(await imKundenfeld(client, 'Lina Client'), 'CLIENT …und er ist in der Transfermaske sofort gewaehlt');
    await click(client, '[data-transfer-product="r5d1-c1"]'); await sleep(300);
    ok(await setByLabel(client, 'OUR PRICE (BHD)', '500') === 'OK', 'CLIENT Our Price');
    await click(client, '[data-create-transfer]');
    ok(await warteBis(client, "!document.querySelector('[data-create-transfer]')", 45000),
      `CLIENT der Transfer an den neuen Kunden entsteht (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    await warteAuf(() => dbQ(BIZ_DB, "SELECT id FROM agent_transfers WHERE product_id = 'r5d1-c1'").length > 0);
    const ag = dbQ(BIZ_DB, "SELECT a.customer_id FROM agent_transfers t JOIN agents a ON a.id = t.agent_id WHERE t.product_id = 'r5d1-c1'")[0] || {};
    ok(ag.customer_id === neuPc2, 'CLIENT …der Agent des Transfers gehoert zum neuen Kunden');
    const ops = (await buchungen(client)).map((x) => x.op);
    ok(ops.filter((o) => o === 'customers.create').length === 2 && ops.filter((o) => o === 'transfers.create').length === 1,
      `CLIENT die Buchungen des Vorgangs (${ops.join(',')})`);

    await geh(primary, '/agents');
    ok(await neuerKundeInMaske(primary, 'Lina', 'Primary') === 'OK', 'CLIENT-PARITAET dieselbe Schnellanlage am Primary');
    await click(primary, '[data-quick-customer-save]');
    ok(await warteBis(primary, "!document.querySelector('[data-quick-customer-save]')", 30000), 'CLIENT-PARITAET der Primary legt ihn an');
    ok(await imKundenfeld(primary, 'Lina Primary'), 'CLIENT-PARITAET …und waehlt ihn in der Maske');
    await clickText(primary, 'Cancel');
    await warteAuf(() => dbQ(BIZ_DB, "SELECT id FROM customers WHERE first_name = 'Lina' AND last_name = 'Primary'").length > 0);
    const kp = dbQ(BIZ_DB, "SELECT * FROM customers WHERE first_name = 'Lina' AND last_name = 'Primary'")[0] || {};
    ok(norm(kp, KU_OHNE) === norm(k[0], KU_OHNE), `CLIENT-PARITAET derselbe Kunde (${norm(k[0], KU_OHNE)})`);
  }

  // ── Der Client besitzt weiterhin nichts ────────────────────────────────
  {
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
    const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-location|\.db$/i.test(f));
    ok(verboten.length === 0, `LOKAL kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
  }
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
  try { console.log('      (Primary-Konsole) ' + (primary?.events || []).slice(-15).join('\n      (Primary-Konsole) ')); } catch { /* egal */ }
  try { console.log('      (PC2-Konsole) ' + (client?.events || []).slice(-15).join('\n      (PC2-Konsole) ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5d.1: transfer detail writes + new client, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5D_TRANSFER_DETAIL_SHARED_WRITES_PROVED');
console.log('CENTRAL_UI_R5D_TRANSFER_NEW_CLIENT_SHARED_WRITE_PROVED');
