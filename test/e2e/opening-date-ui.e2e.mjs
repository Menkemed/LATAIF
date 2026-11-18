// ACCOUNTING-OPENING-DATE — UI-Smoke-Test in der ECHTEN isolierten E2E-App (com.lataif.app.e2e, Port 3011).
// Run: node test/e2e/opening-date-ui.e2e.mjs   (aus dem Repo-Verzeichnis)
//
//   A  Rechnung und Einkauf vom August 2026 über die normalen Masken; Stichtag ohne Eintrag = 2026-10-15 (Standard)
//   B  mit 15.10.: Preisänderung an der August-Rechnung abgewiesen, Einkaufspreis gesperrt
//   C  Settings → Accounting: Eröffnungsposten zum 15.10. → Prüfung lehnt ab (verständliche Meldung), nichts geändert;
//      Posten über die Kundenseite stornieren → 01.01.2026 prüfen und speichern (Audit); späterer Tag mit Belegen → abgelehnt
//   D  mit 01.01.: Rechnung und Einkauf vom August werden bearbeitet
//   E  Neustart: Stichtag 01.01. aus der Datenbank, Einkauf weiter offen, Rechnung erneut bearbeitet
//   F  Q3/2026 als VAT eingereicht → dieselbe Rechnung wieder gesperrt (VAT-Sperre unverändert)
// Helfer aus invoice-vat-ui.e2e.mjs (Preflight, nur eigene Prozesse). Produktion (com.lataif.app, 3001/3443) wird weder benutzt noch beendet.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killTestImage, spawnTracked, testProcesses } from './_e2e-process.mjs';
import { maus } from './_e2e-mouse.mjs';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223, PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com', ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const RUN = join(os.tmpdir(), 'lataif-opening-date-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const PROD_LOCATOR = join(REAL_APPDATA, 'com.lataif.app', 'data-location.json');
function prodDataDb() {
  try { const r = JSON.parse(readFileSync(PROD_LOCATOR, 'utf8')); return r.path || r.root || r.dataRoot ? join(String(r.path || r.root || r.dataRoot), 'lataif.db') : null; }
  catch { return null; }
}

let PASS = 0, FAIL = 0; const fails = []; const MSG = [];
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const seedTool = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
// Bestätigungen (App-Dialog/Plugin) — Antwort wie ein Mensch, Text festhalten.
const antwort = (c, ja) => c.ev(`window.__dlg = window.__dlg || []; window.confirm = async (m) => { window.__dlg.push(String(m)); return ${ja ? 'true' : 'false'}; }; return 'OK';`);

function dbQ(sql, params = [], file = BIZ_DB) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const one = (sql, p = []) => dbQ(sql, p)[0] || {};
const zahl = (sql, p = []) => Number(Object.values(one(sql, p))[0] ?? 0);

// ── CDP ─────────────────────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Page.javascriptDialogOpening') {
        MSG.push(`${m.params.type}: ${m.params.message}`);
        this.ws.send(JSON.stringify({ id: ++this.id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      }
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  spawnTracked(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* noch nicht */ }
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  return c;
}
function stopApp() { try { killTestImage('lataif.exe'); } catch { /* weg */ } }
async function waitGoneAndFree() {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    let n = 0;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${PORT} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n) return true;
    await sleep(500);
  }
  return false;
}
async function stopUndWeg() { stopApp(); await waitGoneAndFree(); const end = Date.now() + 20000; while (Date.now() < end && testProcesses('lataif.exe').length) await sleep(400); await sleep(1500); }
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}

// ── Klick-Helfer ────────────────────────────────────────────────────────────
const q = (sel) => `document.querySelector(${S(sel)})`;
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const waehleNth = (c, eintrag, nr, wert) => c.ev(
  `const l=[...document.querySelectorAll('select')].filter(x=>[...x.options].some(o=>o.textContent.includes(${S(eintrag)})));`
  + `const s=l[${nr}]; if(!s) return 'NO-SELECT:'+${S(eintrag)}+'#'+${nr}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${S(wert)});`
  + `s.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setNth = (c, sel, nr, v) => c.ev(
  `const e=document.querySelectorAll(${S(sel)})[${nr}]; if(!e) return 'NO:'+${S(sel)}+'#'+${nr};`
  + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const alleOk = (r) => { const b = r.filter((x) => x !== 'OK'); return b.length ? 'FELD:' + b.join(',') : 'OK'; };
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); }
  return false;
}
async function warteAuf(pruefe, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (pruefe()) return true; await sleep(400); } return pruefe(); }
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1200); }
async function ssPick(c, placeholder, optionId, nr = -1) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=${nr}<0?l[l.length-1]:l[${nr}]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}
async function nummerWahl(c) {
  if (!(await warteBis(c, q('[data-final-number-confirm]'), 15000))) return 'KEIN-NUMMERNDIALOG';
  const r = [await klick(c, '[data-final-number-normal]')]; await sleep(250);
  r.push(await klick(c, '[data-final-number-confirm]'));
  return alleOk(r);
}
const fehlerText = (c) => c.ev(`const e=[...document.querySelectorAll('[data-save-error],[role=alert]')].map(x=>x.textContent.trim()).filter(Boolean); const red=[...document.querySelectorAll('div')].filter(d=>d.children.length<=2 && /rgb\\(220, 38, 38\\)|#DC2626/i.test(getComputedStyle(d).color) && (d.textContent||'').length>20).map(d=>d.textContent.trim()); return [...e, ...red].join(' | ').slice(0, 400);`);
const pageText = (c) => c.ev('return document.body.innerText;');

// ── Anmelden ────────────────────────────────────────────────────────────────
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
    await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev("[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;");
  }
  await waitFor(c, 'a[href="/settings"]', 30000);
}
async function ensureSignedIn(c) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    if (await exists(c, 'a[href="/settings"]')) return true;
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) { try { await frontendLogin(c); return true; } catch { await sleep(1000); } }
    await sleep(400);
  }
  throw new Error('app shell never appeared');
}

// ── Testdaten (isoliert, bei gestoppter App) ────────────────────────────────
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
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k] === undefined ? null : daten[k]));
}
function seedBusiness() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    for (const [id, first, last] of [['od-k1', 'Nadia', 'August'], ['od-k2', 'Omar', 'Eroeffnung']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    insert(db, 'suppliers', { id: 'od-sup', branch_id, name: 'OD Lieferant', active: 1, created_at: now, updated_at: now });
    for (const [id, name] of [['od-inv', 'Speedmaster August'], ['od-pur', 'Seamaster Einkauf']]) {
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Omega', name, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD', planned_sale_price: 1000, stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{"dial":"Black","material":"Steel"}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: 'lot-' + id, branch_id, product_id: id, unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Stände ──────────────────────────────────────────────────────────────────
const inv = (id) => one('SELECT id, status, invoice_number, gross_amount, paid_amount, issued_at FROM invoices WHERE id = ?', [id]);
const pur = (id) => one('SELECT id, status, total_amount, purchase_date, revision FROM purchases WHERE id = ?', [id]);
const stichtagZeilen = () => S(dbQ("SELECT branch_id, value FROM settings WHERE key = 'accounting.opening_date'"));
const stichtagAudits = () => dbQ("SELECT old_value, new_value, changed_by FROM audit_log WHERE field_name = 'accounting.opening_date' ORDER BY rowid");
const buchungen = () => zahl('SELECT COUNT(*) AS n FROM ledger_entries');
const posten = () => S(dbQ('SELECT item_number, status, cutoff_date, amount FROM opening_balance_items ORDER BY rowid'));

// ── Masken ──────────────────────────────────────────────────────────────────
async function rechnungAugust(c) {
  await gehFrisch(c, '/invoices/new');
  if (!(await warteBis(c, q('[data-ss-trigger="Search clients..."]'), 20000))) return 'KEINE-MASKE';
  const r = [await ssPick(c, 'Search clients...', 'od-k1'), await ssPick(c, 'Pick product...', 'od-inv')];
  await sleep(500);
  r.push(await setVal(c, 'input[type=date][title^="Default = today"]', '2026-08-10')); await sleep(300);
  r.push(await klick(c, '[data-invoice-pay-method="cash"]')); r.push(await klick(c, '[data-invoice-pay-full]'));
  await sleep(300);
  r.push(await setVal(c, 'input[data-invoice-pay-date], [data-invoice-pay-date] input', '2026-08-12'));
  await sleep(400);
  r.push(await klick(c, '[data-invoice-save]'));
  if (r.every((x) => x === 'OK')) { await sleep(600); if (await exists(c, '[data-final-number-confirm]')) r.push(await nummerWahl(c)); }
  return alleOk(r);
}
async function einkaufAugust(c) {
  await gehFrisch(c, '/purchases/new');
  const r = [];
  if (!(await warteBis(c, q('[data-purchase-save]'), 45000))) return 'KEINE-MASKE';
  await sleep(800);
  r.push(await ssPick(c, 'Search suppliers...', 'od-sup'));
  r.push(await setByLabel(c, 'PURCHASE DATE', '2026-08-10')); await sleep(300);
  r.push(await waehleNth(c, 'Existing', 0, 'existing')); await sleep(400);
  r.push(await ssPick(c, 'Pick product...', 'od-pur', 0)); await sleep(300);
  r.push(await setNth(c, 'input[type="number"][min="1"]', 0, '1'));
  r.push(await setNth(c, 'input[type="number"][min="0"][step="0.001"]', 0, '300'));
  r.push(await setByLabel(c, 'AMOUNT (BHD)', '300'));
  r.push(await clickText(c, 'Cash'));
  r.push(await setVal(c, 'textarea[placeholder^="z.B. Lieferscheinnummer"]', 'OD-E2E-EINKAUF'));
  await sleep(400);
  if (alleOk(r) !== 'OK') return alleOk(r);
  r.push(await klick(c, '[data-purchase-save]'));
  await sleep(800);
  if (await exists(c, '[data-app-confirm-ok]')) r.push(await klick(c, '[data-app-confirm-ok]'));
  return alleOk(r);
}
async function rechnungPreis(c, invId, brutto) {
  await gehFrisch(c, `/invoices/${invId}/edit`);
  if (!(await warteBis(c, q('[data-invoice-save]'), 20000))) return 'KEINE-MASKE';
  await sleep(1200);
  const r = [await c.ev(`const e=document.querySelectorAll('input[inputmode="decimal"]')[0]; if(!e) return 'NO-PREIS'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(String(brutto))}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); e.dispatchEvent(new Event('blur',{bubbles:true})); return 'OK';`)];
  await sleep(400);
  r.push(await setVal(c, 'textarea[placeholder^="Explain why this invoice"]', 'E2E Stichtag Preis'));
  r.push(await klick(c, '[data-invoice-save]'));
  await sleep(1800);
  return alleOk(r);
}
async function einkaufOeffnen(c, pid) {
  await gehFrisch(c, `/purchases/${pid}/edit`);
  await waitFor(c, '[data-purchase-edit-page]', 45000);
  return warteBis(c, "document.querySelector('[data-purchase-edit-price]') && document.querySelector('[data-purchase-edit-price]').value !== '' && !/Checking what can be edited/.test(document.body.innerText)", 30000);
}
const preisFeld = (c) => c.ev("const e=document.querySelector('[data-purchase-edit-price]'); return e ? { zu: !!e.disabled, wert: e.value, sperre: [...document.querySelectorAll('[data-purchase-edit-locked]')].map(x=>x.getAttribute('data-purchase-edit-locked')+': '+x.textContent.trim()).join(' | ') } : null;");
async function stichtagSeite(c) {
  await gehFrisch(c, '/settings?tab=accounting');
  return warteBis(c, q('[data-accounting-opening-date-current]'), 20000);
}
const stichtagAnzeige = (c) => c.ev("return { tag: document.querySelector('[data-accounting-opening-date-current]')?.textContent?.trim() || '', quelle: document.querySelector('[data-accounting-opening-date-source]')?.getAttribute('data-accounting-opening-date-source') || '' };");
async function stichtagPruefen(c, tag) {
  const r = [await setVal(c, '[data-accounting-opening-date-input]', tag)];
  await sleep(300);
  r.push(await maus(c, '[data-accounting-opening-date-check]'));
  await warteBis(c, q('[data-accounting-opening-date-result]'), 10000);
  const ergebnis = await c.ev("const e=document.querySelector('[data-accounting-opening-date-result]'); return { art: e?.getAttribute('data-accounting-opening-date-result') || '', text: (e?.innerText || '').replace(/\\s+/g,' ').trim(), speichernZu: !!document.querySelector('[data-accounting-opening-date-save]')?.disabled };");
  return { r: alleOk(r), ...ergebnis };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('ACCOUNTING OPENING DATE — UI-Smoke-Test in der isolierten E2E-App\n');
const prodMtime = (f) => (f && existsSync(f) ? statSync(f).mtimeMs : 0);
const PROD_DB_FILE = prodDataDb();
const PROD_BEFORE = { data: prodMtime(PROD_DB_FILE), appdata: prodMtime(PROD_LOCATOR) };
let c;
try {
  stopApp(); await waitGoneAndFree();
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(seedTool('seed-primary') === 'SEED_PRIMARY_OK', 'SETUP isolierter Server als Primary (Owner)');
  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c);
  ok(true, 'SETUP erste Anmeldung/Onboarding in der E2E-App');
  c.close(); stopApp(); await waitGoneAndFree();
  seedBusiness();

  // ── Sitzung 2 ────────────────────────────────────────────────────────────────
  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c); await sleep(1500);
  await antwort(c, true);
  ok(await stichtagSeite(c), 'A0 Settings → Accounting geöffnet');
  const a0 = await stichtagAnzeige(c);
  ok(a0.tag === '2026-10-15' && a0.quelle === 'default' && stichtagZeilen() === '[]', `A0 ohne Eintrag: 2026-10-15 (Standard) (${S(a0)})`);

  const mR = await rechnungAugust(c);
  await warteAuf(() => one("SELECT i.status FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.product_id = 'od-inv'").status === 'FINAL');
  const RID = one("SELECT invoice_id FROM invoice_lines WHERE product_id = 'od-inv'").invoice_id;
  ok(!!RID && inv(RID).status === 'FINAL' && String(inv(RID).issued_at).startsWith('2026-08-10'),
    `A1 Rechnung vom 10.08.2026 über /invoices/new, voll bezahlt (${mR}; ${S(inv(RID))})`);
  const mE = await einkaufAugust(c);
  await warteAuf(() => !!one("SELECT id FROM purchases WHERE notes = 'OD-E2E-EINKAUF'").id, 30000);
  const PID = one("SELECT id FROM purchases WHERE notes = 'OD-E2E-EINKAUF'").id;
  ok(!!PID && String(pur(PID).purchase_date).startsWith('2026-08-10') && Number(pur(PID).total_amount) === 300,
    `A2 Einkauf vom 10.08.2026 über /purchases/new (${mE}; ${S(pur(PID))}; ${await fehlerText(c)})`);

  // B — mit dem Standard-Stichtag 15.10. ist beides gesperrt
  {
    const vor = S(inv(RID));
    const m = await rechnungPreis(c, RID, Number(inv(RID).gross_amount) + 100);
    const err = await fehlerText(c);
    ok(S(inv(RID)) === vor && /before the opening cut-off/.test(err), `B1 Preisänderung an der August-Rechnung abgewiesen (${m}) — „${err.slice(0, 140)}"`);
    MSG.push('B1 ' + err.slice(0, 220));
    ok(await einkaufOeffnen(c, PID), 'B2 Einkauf bearbeiten geöffnet');
    const f = await preisFeld(c);
    ok(f?.zu && /PURCHASE_EDIT_BEFORE_CUTOVER/.test(f.sperre) && /2026-10-15/.test(f.sperre), `B2 Einkaufspreis gesperrt, Grund nennt den 15.10. (${S(f)})`);
  }

  // C — Eröffnungsposten zum 15.10. → Änderung abgelehnt; stornieren; dann 01.01. speichern
  {
    await gehFrisch(c, '/clients/od-k2');
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Edit Client')", 20000);
    const r = [await clickText(c, 'Edit Client')];
    await warteBis(c, q('[data-opening-form]'), 15000);
    r.push(await setVal(c, '[data-opening-reference]', 'ALT-4711'));
    r.push(await setVal(c, '[data-opening-date]', '2026-09-01'));
    r.push(await setVal(c, '[data-opening-amount]', '250'));
    await warteBis(c, q('[data-opening-preview]'), 10000);
    r.push(await klick(c, '[data-opening-confirm-not-in-lataif]'));
    if (await exists(c, '[data-opening-confirm-no-overlap]')) r.push(await klick(c, '[data-opening-confirm-no-overlap]'));
    await sleep(300);
    r.push(await klick(c, '[data-opening-submit]'));
    ok(await warteAuf(() => zahl("SELECT COUNT(*) AS n FROM opening_balance_items WHERE status = 'RECORDED' AND cutoff_date = '2026-10-15'") === 1),
      `C0 Eröffnungsposten (Forderung 250 BHD) zum 15.10. über die Kundenseite erfasst (${alleOk(r)}; ${posten()})`);
  }
  {
    const vor = [stichtagZeilen(), posten(), buchungen(), stichtagAudits().length];
    ok(await stichtagSeite(c), 'C1 Settings → Accounting');
    const p = await stichtagPruefen(c, '2026-01-01');
    ok(p.art === 'refused' && p.speichernZu && /1 party opening balance is recorded as of 2026-10-15 \(customer or supplier page → Edit → Opening balances\)/.test(p.text)
      && /cancel it first, or keep the opening date 2026-10-15\. Nothing was changed\./.test(p.text),
      `C1 01.01. mit Eröffnungsposten zum 15.10.: abgelehnt, Speichern gesperrt — „${p.text.slice(0, 260)}"`);
    MSG.push('C1 ' + p.text);
    ok(S([stichtagZeilen(), posten(), buchungen(), stichtagAudits().length]) === S(vor), 'C1 …nichts geändert (Einstellung, Eröffnungsposten, Buchungen, Audit)');
  }
  {
    await gehFrisch(c, '/clients/od-k2');
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Edit Client')", 20000);
    const r = [await clickText(c, 'Edit Client')];
    await warteBis(c, q('[data-opening-cancel]'), 15000);
    r.push(await klick(c, '[data-opening-cancel]'));
    await warteBis(c, q('[data-opening-cancel-reason]'), 5000);
    r.push(await setVal(c, '[data-opening-cancel-reason]', 'E2E vor Stichtag-Änderung'));
    await sleep(200);
    r.push(await klick(c, '[data-opening-cancel-submit]'));
    ok(alleOk(r) === 'OK' && await warteAuf(() => zahl("SELECT COUNT(*) AS n FROM opening_balance_items WHERE status = 'RECORDED'") === 0
      && zahl("SELECT COUNT(*) AS n FROM opening_balance_items WHERE status = 'CANCELLED'") === 1),
      `C2 Eröffnungsposten über die Kundenseite storniert (${alleOk(r)}; ${posten()})`);
  }
  {
    const buchVor = buchungen();
    ok(await stichtagSeite(c), 'C3 Settings → Accounting');
    const p = await stichtagPruefen(c, '2026-01-01');
    ok(p.art === 'ok' && !p.speichernZu && /2026-10-15 → 2026-01-01/.test(p.text), `C3 Prüfung 15.10. → 01.01.: möglich — „${p.text.slice(0, 160)}"`);
    const s = await maus(c, '[data-accounting-opening-date-save]');
    await warteBis(c, q('[data-accounting-opening-date-msg]'), 15000);
    const msg = await c.ev("return document.querySelector('[data-accounting-opening-date-msg]')?.textContent?.trim() || '';");
    const anz = await stichtagAnzeige(c);
    ok(s === 'OK' && /changed from 2026-10-15 to 2026-01-01/.test(msg) && anz.tag === '2026-01-01' && anz.quelle === 'database',
      `C3 gespeichert (echter Mausklick) — „${msg}" (${S(anz)})`);
    const a = stichtagAudits();
    const ich = one("SELECT u.id FROM users u WHERE u.email = ?", [OWNER_EMAIL]).id;
    ok(stichtagZeilen().includes('"value":"2026-01-01"') && a.length === 1 && a[0].old_value === '2026-10-15 (default)' && a[0].new_value === '2026-01-01' && a[0].changed_by === ich,
      `C3 …DB: settings ${stichtagZeilen()}; Audit ${S(a)} (Benutzer ${ich})`);
    ok(buchungen() === buchVor && S(inv(RID)).length > 0 && Number(pur(PID).total_amount) === 300, 'C3 …keine Buchung, Rechnung oder Einkauf verändert');
    const sp = await stichtagPruefen(c, '2026-09-01');
    ok(sp.art === 'refused' && sp.speichernZu && /Between 2026-01-01 and 2026-09-01 there are already \d+ bookings?, 1 invoice and 1 purchase\. .*Nothing was changed\./.test(sp.text),
      `C4 späterer Tag 01.09. mit August-Belegen: abgelehnt — „${sp.text.slice(0, 220)}"`);
    MSG.push('C4 ' + sp.text);
    ok(stichtagZeilen().includes('"value":"2026-01-01"') && stichtagAudits().length === 1, 'C4 …nichts geändert');
  }

  // D — mit 01.01. werden Rechnung und Einkauf vom August bearbeitet
  {
    const brutto0 = Number(inv(RID).gross_amount);
    const m = await rechnungPreis(c, RID, brutto0 + 100);
    ok(await warteAuf(() => Math.abs(Number(inv(RID).gross_amount) - (brutto0 + 100)) < 0.01),
      `D1 August-Rechnung: Preis +100 gespeichert (${m}; ${S(inv(RID))}; ${await fehlerText(c)})`);
    ok(await einkaufOeffnen(c, PID), 'D2 Einkauf bearbeiten geöffnet');
    const f = await preisFeld(c);
    ok(f && !f.zu && !/BEFORE_CUTOVER/.test(f.sperre), `D2 Einkaufspreis offen (${S(f)})`);
    const lid = await c.ev("return document.querySelector('[data-purchase-edit-price]')?.getAttribute('data-purchase-edit-price') || '';");
    const r = [await setVal(c, '[data-purchase-edit-reason]', 'e2e: Preis falsch erfasst'), await setVal(c, `[data-purchase-edit-price="${lid}"]`, '350')];
    await sleep(600);
    if (await exists(c, '[data-purchase-edit-confirm-pay]')) r.push(await klick(c, '[data-purchase-edit-confirm-pay]'));
    await sleep(300);
    r.push(await klick(c, '[data-purchase-edit-save]'));
    await sleep(800);
    if (await exists(c, '[data-app-confirm-ok]')) r.push(await klick(c, '[data-app-confirm-ok]'));
    const blocker = await c.ev("return document.querySelector('[data-purchase-edit-blocker]')?.textContent || '';");
    ok(await warteAuf(() => Number(pur(PID).total_amount) === 350, 30000),
      `D2 Einkauf vom August: Preis 300 → 350 gespeichert (${alleOk(r)}; ${S(pur(PID))}; ${blocker} ${await fehlerText(c)})`);
  }
  await sleep(3000);
  c.close(); await stopUndWeg();

  // ── Sitzung 3: Neustart ──────────────────────────────────────────────────────
  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c); await sleep(1500);
  await antwort(c, true);
  {
    ok(await stichtagSeite(c), 'E1 nach Neustart: Settings → Accounting');
    const a = await stichtagAnzeige(c);
    ok(a.tag === '2026-01-01' && a.quelle === 'database', `E1 …Stichtag 2026-01-01 aus der Datenbank (${S(a)})`);
    ok(await einkaufOeffnen(c, PID), 'E2 Einkauf bearbeiten geöffnet');
    const f = await preisFeld(c);
    ok(f && !f.zu && f.wert === '350', `E2 …Einkaufspreis weiter offen, 350 gespeichert (${S(f)})`);
    const brutto0 = Number(inv(RID).gross_amount);
    const m = await rechnungPreis(c, RID, brutto0 + 50);
    ok(await warteAuf(() => Math.abs(Number(inv(RID).gross_amount) - (brutto0 + 50)) < 0.01),
      `E3 August-Rechnung nach Neustart erneut bearbeitet: +50 (${m}; ${S(inv(RID))}; ${await fehlerText(c)})`);
  }

  // F — VAT: Q3/2026 einreichen → dieselbe Rechnung wieder gesperrt
  {
    await gehFrisch(c, '/analytics');
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='FINANCE')", 20000);
    await clickText(c, 'FINANCE');
    const da = await warteBis(c, q('[data-vat-file-open="2026-Q3"]'), 30000);
    const r = [await klick(c, '[data-vat-file-open="2026-Q3"]')];
    ok(da && await warteAuf(() => zahl('SELECT COUNT(*) AS n FROM vat_filings WHERE year = 2026 AND quarter = 3') === 1), `F1 Q3/2026 als VAT eingereicht (${alleOk(r)})`);
    const vor = S(inv(RID));
    const m = await rechnungPreis(c, RID, Number(inv(RID).gross_amount) + 10);
    const err = await fehlerText(c);
    ok(S(inv(RID)) === vor && /already filed/.test(err), `F2 Preisänderung an der August-Rechnung im eingereichten Q3: abgewiesen (${m}) — „${err.slice(0, 160)}"`);
    MSG.push('F2 ' + err.slice(0, 220));
    const a = await (async () => { await stichtagSeite(c); return stichtagAnzeige(c); })();
    ok(a.tag === '2026-01-01', `F2 …Stichtag unverändert 2026-01-01 (${S(a)})`);
  }
  c.close();
} catch (e) {
  FAIL++; fails.push('suite error: ' + (e && e.message ? e.message : String(e)));
  console.log('E2E ERROR:', e && e.stack ? e.stack : e);
} finally {
  stopApp(); await waitGoneAndFree();
}
ok(prodMtime(PROD_DB_FILE) === PROD_BEFORE.data && prodMtime(PROD_LOCATOR) === PROD_BEFORE.appdata,
  `ISOLATION Produktionsdatenbank und Produktions-Zeiger unverändert (Änderungszeit; ${PROD_DB_FILE || 'kein Zeiger gefunden'})`);
console.log('\nMeldungen/Dialoge:'); for (const m of MSG) console.log('   · ' + m);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — opening date UI e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
