// RELEASE-SAFETY — Sicherheitsdialoge (Abbrechen/Bestätigen) und VAT-Kalenderquartale in der ECHTEN isolierten E2E-App (com.lataif.app.e2e, Port 3011).
// Run: node test/e2e/release-safety-ui.e2e.mjs   (aus dem Repo-Verzeichnis)
// Helfer aus invoice-vat-ui.e2e.mjs (Preflight, nur eigene Prozesse, Klick-Muster). Produktion (com.lataif.app, E:\LATAIF\Data, 3001/3443) wird weder benutzt noch beendet.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killTestImage, spawnTracked, testProcesses } from './_e2e-process.mjs';

const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223, PORT = 3011, HTTP = `http://127.0.0.1:${PORT}`;
const OWNER_EMAIL = 'admin@lataif.com', ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const RUN = join(os.tmpdir(), 'lataif-release-safety-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const PROD_APPDATA = join(REAL_APPDATA, 'com.lataif.app');
const PROD_LOCATOR = join(PROD_APPDATA, 'data-location.json');
/** Der Datenort der Produktion, wie ihr eigener Zeiger ihn nennt — nur gelesen, nie geschrieben. */
function prodDataDb() {
  try { const r = JSON.parse(readFileSync(PROD_LOCATOR, 'utf8')); return r.path || r.root || r.dataRoot ? join(String(r.path || r.root || r.dataRoot), 'lataif.db') : null; }
  catch { return null; }
}

let PASS = 0, FAIL = 0; const fails = []; const UI = []; const MSG = [];
// Native Tauri-Dialoge (Dialog-Plugin) sind per CDP nicht klickbar: die Antwort kommt aus einer async
// `window.confirm`-Fassung GENAU wie die des Plugins (Promise<boolean>) — so zählt, ob die App wirklich wartet.
const antwort = (c, ja) => c.ev(`window.__dlg = window.__dlg || []; window.confirm = async (m) => { window.__dlg.push(String(m)); return ${ja ? 'true' : 'false'}; }; return 'OK';`);
const dialoge = (c) => c.ev("return (window.__dlg || []).splice(0).join(' | ');");
async function stopUndWeg() { stopApp(); await waitGoneAndFree(); const end = Date.now() + 20000; while (Date.now() < end && testProcesses('lataif.exe').length) await sleep(400); await sleep(1500); }
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const seedTool = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();

function dbQ(sql, params = [], file = BIZ_DB) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const one = (sql, p = []) => dbQ(sql, p)[0] || {};
const qty = (id) => Number(one('SELECT quantity FROM products WHERE id = ?', [id]).quantity);
const st = (id) => String(one('SELECT stock_status FROM products WHERE id = ?', [id]).stock_status);
const lineOf = (pid) => one('SELECT il.*, i.status AS inv_status, i.invoice_number FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.product_id = ? ORDER BY i.created_at DESC, il.rowid DESC LIMIT 1', [pid]);
const invCount = (pid) => Number(one('SELECT COUNT(*) n FROM invoice_lines WHERE product_id = ?', [pid]).n);

// ── CDP ─────────────────────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      // Native Dialoge (alert/confirm) — Text festhalten, bestätigen wie ein Mensch mit „OK".
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
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}

// ── Klick-Helfer (wie r5d/r6e/r7a) ──────────────────────────────────────────
const q = (sel) => `document.querySelector(${S(sel)})`;
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes(${S(t)})).pop(); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setByLabelPrefix = (c, prefix, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().startsWith(${S(prefix)})).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(prefix)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const waehleIn = (c, eintrag, wert) => c.ev(
  `const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.textContent.includes(${S(eintrag)})));`
  + `if(!s) return 'NO-SELECT:'+${S(eintrag)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${S(wert)});`
  + `s.dispatchEvent(new Event('change',{bubbles:true})); return s.value===${S(wert)} ? 'OK' : 'NO-OPTION:'+${S(wert)};`);
const alleOk = (r) => { const b = r.filter((x) => x !== 'OK'); return b.length ? 'FELD:' + b.join(',') : 'OK'; };
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); }
  return false;
}
async function warteAuf(pruefe, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (pruefe()) return true; await sleep(400); } return pruefe(); }
const text = (c) => c.ev('return document.body.innerText;');
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1200); }
async function ssPick(c, placeholder, optionId) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}
async function mehrfachWahl(c, placeholder, labels) {
  const a = await c.ev(`const s=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()===${S(placeholder)}); if(!s) return 'NO'; s.parentElement.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  const r = [];
  for (const label of labels) {
    const suche = `[...document.querySelectorAll('div.cursor-pointer')].find(d=>{ const t=d.querySelector(':scope > div.flex-1 > div'); return t && t.textContent.trim()===${S(label)}; })`;
    if (!(await warteBis(c, suche, 10000))) { r.push('KEIN-EINTRAG:' + label); continue; }
    r.push(await c.ev(`const d=${suche}; d.click(); return 'OK';`));
    await sleep(250);
  }
  await c.ev("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return 1;");
  await sleep(250);
  return alleOk(r);
}
async function nummerWahl(c) {
  if (!(await warteBis(c, q('[data-final-number-confirm]'), 15000))) return 'KEIN-NUMMERNDIALOG';
  const r = [await klick(c, '[data-final-number-normal]')]; await sleep(250);
  r.push(await klick(c, '[data-final-number-confirm]'));
  return alleOk(r);
}
async function fotoWaehlen(c, file) {
  await c.send('DOM.enable', {});
  const { root } = await c.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][accept="image/*"]' });
  if (!nodeIds || nodeIds.length === 0) return 'KEIN-FELD';
  await c.send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[nodeIds.length - 1] });
  return 'OK';
}
/** Sichtbare Fehlermeldung einer Maske/eines Dialogs (roter Kasten), sonst ''. */
const fehlerText = (c) => c.ev(`const e=[...document.querySelectorAll('[data-save-error],[role=alert]')].map(x=>x.textContent.trim()).filter(Boolean); const red=[...document.querySelectorAll('div')].filter(d=>d.children.length<=2 && /rgb\\(220, 38, 38\\)|#DC2626/i.test(getComputedStyle(d).color) && (d.textContent||'').length>20).map(d=>d.textContent.trim()); return [...e, ...red].join(' | ').slice(0, 400);`);

// ── Rechnung über die Maske ─────────────────────────────────────────────────
async function rechnungMaske(c, kunde, pid, menge, zahlung) {
  await gehFrisch(c, '/invoices/new');
  if (!(await warteBis(c, q('[data-ss-trigger="Search clients..."]'), 20000))) return 'KEINE-MASKE';
  const r = [await ssPick(c, 'Search clients...', kunde), await ssPick(c, 'Pick product...', pid)];
  await sleep(500);
  if (menge !== 1) r.push(await setVal(c, 'input[type=number][min="1"][step="1"]', String(menge)));
  if (zahlung === 'later') r.push(await klick(c, '[data-invoice-pay-later]'));
  else { r.push(await klick(c, '[data-invoice-pay-method="cash"]')); r.push(await klick(c, '[data-invoice-pay-full]')); }
  await sleep(400);
  r.push(await klick(c, '[data-invoice-save]'));
  if (zahlung === 'full' && r.every((x) => x === 'OK')) {
    await sleep(600);
    if (await exists(c, '[data-final-number-confirm]')) r.push(await nummerWahl(c));
  }
  return alleOk(r);
}
async function listeVollZahlen(c, invId) {
  await gehFrisch(c, '/invoices');
  if (!(await warteBis(c, q(`[data-pay-invoice="${invId}"]`), 20000))) return 'KEIN-ZAHLKNOPF';
  const r = [await klick(c, `[data-pay-invoice="${invId}"]`)];
  await warteBis(c, q('[data-invoice-list-pay]'), 8000);
  r.push(await klick(c, '[data-invoice-list-pay-method="cash"]'));
  await sleep(200);
  r.push(await klick(c, '[data-invoice-list-pay]'));
  await sleep(700);
  if (await exists(c, '[data-final-number-confirm]')) r.push(await nummerWahl(c));
  return alleOk(r);
}
async function stornoMaske(c, invId) {
  await gehFrisch(c, `/invoices/${invId}`);
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Cancel')", 20000))) return 'KEIN-STORNOKNOPF';
  const r = [await clickText(c, 'Cancel')];
  if (!(await warteBis(c, q('[data-invoice-cancel]'), 8000))) return 'KEIN-DIALOG';
  await sleep(300);
  r.push(await klick(c, '[data-invoice-cancel]'));
  await sleep(1500);
  return alleOk(r);
}
async function aendernMaske(c, invId, bruttoErsteZeile) {
  await gehFrisch(c, `/invoices/${invId}/edit`);
  if (!(await warteBis(c, q('[data-invoice-save]'), 20000))) return 'KEINE-MASKE';
  await sleep(1200);
  const r = [];
  // INVOICE-EDIT S2 — optional den Zeilenbetrag (brutto) der ersten Zeile ändern.
  if (bruttoErsteZeile !== undefined) {
    r.push(await c.ev(`const e=document.querySelectorAll('input[inputmode="decimal"]')[0]; if(!e) return 'NO-PREIS'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(String(bruttoErsteZeile))}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); e.dispatchEvent(new Event('blur',{bubbles:true})); return 'OK';`));
    await sleep(400);
  }
  r.push(await setVal(c, 'textarea[placeholder^="Explain why this invoice"]', 'E2E Änderungsversuch'));
  r.push(await klick(c, '[data-invoice-save]'));
  await sleep(1500);
  return alleOk(r);
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
// ── Anmelden (wie inventory-quantity) ───────────────────────────────────────
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



// ── Testdaten (neue Zeilen bei gestoppter App; `settings` wird nicht gespiegelt) ──
function seedBusiness() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    // Geschäftsjahr ab April — die VAT-Quartale müssen trotzdem Kalenderquartale bleiben.
    db.prepare("DELETE FROM settings WHERE key = 'finance.fiscal_year_start_month'").run();
    insert(db, 'settings', { branch_id, key: 'finance.fiscal_year_start_month', value: '4', category: 'finance', updated_at: now });
    insert(db, 'customers', { id: 'e2e-k', branch_id, first_name: 'Layla', last_name: 'Kunde', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    for (const id of ['rs-a', 'rs-b']) {
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Omega', name: 'Safety ' + id, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD', planned_sale_price: 1000, stock_status: 'in_stock', tax_scheme: 'VAT_10', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{"dial":"Black","material":"Steel"}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: 'lot-' + id, branch_id, product_id: id, unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    }
    insert(db, 'expenses', { id: 'e2e-exp', branch_id, expense_number: 'EXP-E2E-0001', category: 'Other', amount: 12.5, payment_method: 'cash', expense_date: now.slice(0, 10), description: 'E2E Ausgabe', created_at: now });
    insert(db, 'precious_metals', { id: 'e2e-met', branch_id, metal_type: 'gold', karat: '21K', weight_grams: 5, description: 'E2E Goldkette', purchase_price_per_gram: 20, purchase_total: 100, status: 'in_stock', images: '[]', created_at: now, updated_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}

const inv = (id) => one('SELECT id, status, invoice_number, gross_amount, paid_amount, issued_at FROM invoices WHERE id = ?', [id]);
const payCount = (id) => Number(one('SELECT COUNT(*) n FROM payments WHERE invoice_id = ?', [id]).n);
const pageText = (c) => c.ev('return document.body.innerText;');
async function editOeffnen(c, invId) {
  await gehFrisch(c, `/invoices/${invId}/edit`);
  if (!(await warteBis(c, q('[data-invoice-save]'), 20000))) return 'KEINE-MASKE';
  await sleep(1500);
  return 'OK';
}
const grund = (c, t) => setVal(c, 'textarea[placeholder^="Explain why this invoice"]', t);
const speichern = async (c) => { const r = await klick(c, '[data-invoice-save]'); await sleep(1800); return r; };
async function zahlungenOeffnen(c, invId) {
  await gehFrisch(c, `/invoices/${invId}`);
  await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Manage payments'))", 20000);
  const r = await clickIncludes(c, 'Manage payments');
  await warteBis(c, "document.querySelectorAll('input[type=date]').length > 0", 10000);
  return r;
}
const zahlungX = (c) => c.ev("const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='×').pop(); if(!b) return 'NO-X'; b.click(); return 'OK';");

// ═══════════════════════════════════════════════════════════════════════════
console.log('RELEASE SAFETY — Sicherheitsdialoge + VAT-Kalenderquartale in der isolierten E2E-App\n');
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
  c.close(); await stopUndWeg();
  seedBusiness();

  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c); await sleep(1500);
  ok(await c.ev('return String(window.confirm).includes("plugin:dialog|confirm");'),
    'SETUP die App nutzt die async Rückfrage des Tauri-Dialog-Plugins (die Stelle, an der ohne await immer „ja" herauskam)');
  await antwort(c, true);
  ok(one("SELECT value FROM settings WHERE key = 'finance.fiscal_year_start_month'").value === '4', 'SETUP Geschäftsjahresbeginn April eingestellt');

  // Zwei bezahlte Rechnungen über die Maske: A für die Dialoge (offenes Quartal), V für die VAT-Fälle.
  const ids = {};
  for (const [key, pid] of [['a', 'rs-a'], ['v', 'rs-b']]) {
    const m = await rechnungMaske(c, 'e2e-k', pid, 1, 'full');
    await warteAuf(() => lineOf(pid).inv_status === 'FINAL');
    ids[key] = lineOf(pid).invoice_id;
    ok(!!ids[key] && inv(ids[key]).status === 'FINAL', `SETUP ${key}: Rechnung über /invoices/new, voll bezahlt (${m}; ${inv(ids[key]).invoice_number})`);
  }
  await antwort(c, true);

  // ══ D1 — Zahlung löschen (Rechnung → Manage payments → ×) ══
  UI.push('D1 /invoices/:id „Manage payments" → × (Zahlung löschen)');
  {
    const id = ids.a;
    let r = [await zahlungenOeffnen(c, id), await antwort(c, false), await zahlungX(c)];
    await sleep(1800);
    const d = await dialoge(c);
    ok(/Delete this payment/.test(d) && payCount(id) === 1 && inv(id).status === 'FINAL',
      `D1 Abbrechen: Zahlung bleibt, Rechnung bleibt FINAL (${alleOk(r)}; „${d.slice(0, 50)}")`);
    r = [await antwort(c, true), await zahlungX(c)];
    ok(await warteAuf(() => payCount(id) === 0), `D1 Bestätigen: Zahlung gelöscht (${alleOk(r)})`);
    ok(inv(id).status !== 'FINAL' && Number(inv(id).paid_amount) === 0, `D1 …Status neu berechnet (${inv(id).status}, bezahlt ${inv(id).paid_amount})`);
  }

  // ══ D2 — Ausgabe löschen (Liste → Bearbeiten → Delete) ══
  UI.push('D2 /expenses Zeile → Edit Expense → Delete');
  {
    const da = () => Number(one("SELECT COUNT(*) n FROM expenses WHERE id = 'e2e-exp'").n);
    const oeffnen = async () => { await gehFrisch(c, '/expenses'); await warteBis(c, q('[data-expense-row="e2e-exp"]'), 20000); const x = await klick(c, '[data-expense-row="e2e-exp"]'); await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Delete')", 8000); return x; };
    let r = [await oeffnen(), await antwort(c, false), await clickText(c, 'Delete')];
    await sleep(1500);
    const d = await dialoge(c);
    ok(/Delete this expense/.test(d) && da() === 1, `D2 Abbrechen: Ausgabe bleibt (${alleOk(r)}; „${d.slice(0, 40)}")`);
    r = [await antwort(c, true), await clickText(c, 'Delete')];
    ok(await warteAuf(() => da() === 0), `D2 Bestätigen: Ausgabe gelöscht (${alleOk(r)})`);
  }

  // ══ D3 — Goldposten löschen (nacktes confirm → jetzt await window.confirm) ══
  UI.push('D3 /metals Zeile → Delete');
  {
    const da = () => Number(one("SELECT COUNT(*) n FROM precious_metals WHERE id = 'e2e-met'").n);
    const loeschen = async () => { await gehFrisch(c, '/metals'); await warteBis(c, q('[data-metal-row="e2e-met"]'), 20000); return c.ev(`const b=[...document.querySelectorAll('[data-metal-row="e2e-met"] button')].find(x=>x.textContent.trim()==='Delete'); if(!b) return 'NO-DELETE'; b.click(); return 'OK';`); };
    let r = [await antwort(c, false), await loeschen()];
    await sleep(1500);
    const d = await dialoge(c);
    ok(/Delete this item/.test(d) && da() === 1, `D3 Abbrechen: Goldposten bleibt (${alleOk(r)})`);
    r = [await antwort(c, true), await loeschen()];
    ok(await warteAuf(() => da() === 0), `D3 Bestätigen: Goldposten gelöscht (${alleOk(r)})`);
  }

  // ══ VAT — Kalenderquartale trotz Geschäftsjahr ab April ══
  UI.push('VAT /invoices/:id/edit + Manage payments (Mai), /analytics FINANCE, Mark VAT filed');
  {
    const id = ids.v;
    const r = [await editOeffnen(c, id), await setVal(c, 'input[type=date]', '2026-05-10'), await grund(c, 'E2E Rechnungsdatum Mai')];
    r.push(await speichern(c));
    await warteAuf(() => String(inv(id).issued_at).startsWith('2026-05-10'));
    r.push(await zahlungenOeffnen(c, id));
    r.push(await c.ev(`const e=[...document.querySelectorAll('input[type=date]')].pop(); if(!e) return 'NO-DATUM'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'2026-05-12'); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); e.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); return 'OK';`));
    const zahlDatum = () => String(dbQ('SELECT received_at FROM payments WHERE invoice_id = ?', [id])[0]?.received_at);
    await warteAuf(() => zahlDatum().startsWith('2026-05-12'));
    ok(String(inv(id).issued_at).startsWith('2026-05-10') && zahlDatum().startsWith('2026-05-12'), `SETUP V in den Mai gelegt (${alleOk(r)})`);

    await gehFrisch(c, '/analytics');
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='FINANCE')", 20000);
    await clickText(c, 'FINANCE');
    await warteBis(c, q('[data-vat-quarter="2026-Q2"]'), 30000);
    const zeile = await c.ev(`return (document.querySelector('[data-vat-quarter="2026-Q2"]')?.textContent || '').replace(/\\s+/g,' ').trim();`);
    const altQ1 = await exists(c, '[data-vat-file-open="2026-Q1"]');
    ok(/2026 · Q2 Apr–Jun/.test(zeile) && (await exists(c, '[data-vat-file-open="2026-Q2"]')) && !altQ1,
      `VAT1 Mai-Rechnung steht unter „${zeile}" (Kalenderquartal) — nicht unter dem Geschäftsjahres-Q1`);
    let rr = [await antwort(c, false), await klick(c, '[data-vat-file-open="2026-Q2"]')];
    await sleep(2500);
    const d = await dialoge(c);
    const filings = () => Number(one('SELECT COUNT(*) n FROM vat_filings WHERE year = 2026 AND quarter = 2').n);
    ok(/Mark 2026 Q2 as VAT filed/.test(d) && filings() === 0, `VAT2 Abbrechen: nichts eingereicht (${alleOk(rr)})`);
    rr = [await antwort(c, true), await klick(c, '[data-vat-file-open="2026-Q2"]')];
    ok(await warteAuf(() => filings() === 1), `VAT2 Bestätigen: Q2/2026 eingereicht (${alleOk(rr)})`);
    const snap = JSON.parse(String(one('SELECT snapshot_json FROM vat_filings WHERE year = 2026 AND quarter = 2').snapshot_json || '{}'));
    ok(snap.invoices?.length === 1 && snap.invoices[0].invoiceId === id && snap.invoices[0].month === '2026-05',
      `VAT2 …der Snapshot enthält genau die Mai-Rechnung (Monat ${snap.invoices?.[0]?.month}) — Übersicht und Sperre meinen dasselbe Quartal`);
    ok(await warteBis(c, q('[data-vat-filed="2026-Q2"]'), 15000), 'VAT2 …Übersicht zeigt „VAT filed <Datum>"');
    // Die Sperre greift genau dort: Zahlung der gemeldeten Rechnung löschen — auch nach „Bestätigen" abgewiesen.
    const vor = payCount(id);
    const r3 = [await zahlungenOeffnen(c, id), await antwort(c, true), await zahlungX(c)];
    await sleep(2500);
    const fehler = await pageText(c);
    ok(payCount(id) === vor && inv(id).status === 'FINAL', `VAT3 Zahlung der gemeldeten Rechnung löschen: trotz Bestätigung abgewiesen, Zahlung bleibt (${alleOk(r3)})`);
    MSG.push('VAT3 ' + ((fehler.match(/The VAT return for[^\n]*/) || [''])[0]).slice(0, 200));
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

console.log('\nOberflächen:'); for (const u of UI) console.log('   · ' + u);
console.log('\nMeldungen/Dialoge:'); for (const m of MSG) console.log('   · ' + m);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — release safety UI e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
