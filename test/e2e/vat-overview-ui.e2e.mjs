// VAT-QUARTALSÜBERSICHT — Übersicht und NBR-Exportgrundlage in der ECHTEN isolierten E2E-App (com.lataif.app.e2e, Port 3011).
// Run: node test/e2e/vat-overview-ui.e2e.mjs   (aus dem Repo-Verzeichnis)
// Helfer aus release-safety-ui.e2e.mjs. Produktion (com.lataif.app, E:\LATAIF\Data, 3001/3443) wird weder benutzt noch beendet.
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
const RUN = join(os.tmpdir(), 'lataif-vat-overview-e2e', 'run-' + Date.now());
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




// ── Testdaten ───────────────────────────────────────────────────────────────
function seedBusiness() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    db.prepare("DELETE FROM settings WHERE key = 'finance.fiscal_year_start_month'").run();
    insert(db, 'settings', { branch_id, key: 'finance.fiscal_year_start_month', value: '4', category: 'finance', updated_at: now });
    insert(db, 'customers', { id: 'e2e-k', branch_id, first_name: 'Samir', last_name: 'Kunde', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    for (const id of ['vo-j', 'vo-f', 'vo-p']) {
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Omega', name: 'Overview ' + id, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD', planned_sale_price: 1000, stock_status: 'in_stock', tax_scheme: 'VAT_10', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{"dial":"Black","material":"Steel"}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: 'lot-' + id, branch_id, product_id: id, unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}
const inv = (id) => one('SELECT id, status, invoice_number, gross_amount, paid_amount, issued_at FROM invoices WHERE id = ?', [id]);
const lineVat = (id) => Number(one('SELECT SUM(vat_amount) s FROM invoice_lines WHERE invoice_id = ?', [id]).s);
/** Unabhängig: VAT der FINAL-Rechnungen (VAT_10-Zeilen), deren Vollzahlung im Kalenderquartal liegt. */
const exportVat = (von, bis) => Number(one(`SELECT COALESCE(SUM(l.vat_amount),0) s FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
   WHERE i.status = 'FINAL' AND COALESCE(i.butterfly,0) = 0 AND l.tax_scheme = 'VAT_10'
     AND COALESCE((SELECT MAX(received_at) FROM payments p WHERE p.invoice_id = i.id), i.issued_at) >= ?
     AND COALESCE((SELECT MAX(received_at) FROM payments p WHERE p.invoice_id = i.id), i.issued_at) < ?`, [von, bis]).s);
const pageText = (c) => c.ev('return document.body.innerText;');
const grund = (c, t) => setVal(c, 'textarea[placeholder^="Explain why this invoice"]', t);
async function listeZahlen(c, invId, betrag) {
  await gehFrisch(c, '/invoices');
  if (!(await warteBis(c, q(`[data-pay-invoice="${invId}"]`), 20000))) return 'KEIN-ZAHLKNOPF';
  const r = [await klick(c, `[data-pay-invoice="${invId}"]`)];
  await warteBis(c, q('[data-invoice-list-pay]'), 8000);
  r.push(await klick(c, '[data-invoice-list-pay-method="cash"]'));
  if (betrag !== undefined) r.push(await setVal(c, 'input[data-invoice-list-pay-amount]', String(betrag)));
  await sleep(200);
  r.push(await klick(c, '[data-invoice-list-pay]'));
  await sleep(900);
  if (await exists(c, '[data-final-number-confirm]')) r.push(await nummerWahl(c));
  return alleOk(r);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('VAT-ÜBERSICHT — Übersicht und Exportgrundlage in der isolierten E2E-App\n');
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
  await antwort(c, true);

  // J: Rechnung vom 20. Juni, erst heute (Q3) voll bezahlt. F: heute voll bezahlt. P: nur teilbezahlt.
  const ids = {};
  for (const [key, pid] of [['j', 'vo-j'], ['f', 'vo-f'], ['p', 'vo-p']]) {
    const m = await rechnungMaske(c, 'e2e-k', pid, 1, key === 'f' ? 'full' : 'later');
    await warteAuf(() => !!lineOf(pid).invoice_id);
    ids[key] = lineOf(pid).invoice_id;
    ok(!!ids[key], `SETUP ${key}: Rechnung über /invoices/new (${m}; ${inv(ids[key]).status})`);
  }
  {
    await gehFrisch(c, `/invoices/${ids.j}/edit`);
    await warteBis(c, q('[data-invoice-save]'), 20000); await sleep(1200);
    const r = [await setVal(c, 'input[type=date]', '2026-06-20'), await grund(c, 'E2E Rechnungsdatum Juni')];
    r.push(await klick(c, '[data-invoice-save]')); await sleep(1800);
    await warteAuf(() => String(inv(ids.j).issued_at).startsWith('2026-06-20'));
    r.push(await listeZahlen(c, ids.j));
    await warteAuf(() => inv(ids.j).status === 'FINAL');
    r.push(await listeZahlen(c, ids.p, 300));
    await warteAuf(() => Number(inv(ids.p).paid_amount) > 0);
    ok(String(inv(ids.j).issued_at).startsWith('2026-06-20') && inv(ids.j).status === 'FINAL' && inv(ids.p).status === 'PARTIAL' && Number(inv(ids.p).paid_amount) === 300,
      `SETUP J ausgestellt 20.06., heute voll bezahlt; P teilbezahlt 300 (${alleOk(r)})`);
  }

  UI.push('VAT /analytics FINANCE — Quartalszeilen, Teilbezahlt-Zeile');
  await gehFrisch(c, '/analytics');
  await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='FINANCE')", 20000);
  await clickText(c, 'FINANCE');
  await warteBis(c, q('[data-vat-quarter="2026-Q3"]'), 30000);
  const zahl = (sel) => c.ev(`return Number((document.querySelector(${S(sel)})?.textContent || 'NaN').replace(/[^0-9.\\-]/g, ''));`);
  const q3ui = await zahl('[data-vat-output="2026-Q3"]');
  const q3export = exportVat('2026-07-01', '2026-10-01');
  const q2da = await exists(c, '[data-vat-quarter="2026-Q2"]');
  ok(Math.abs(q3ui - q3export) < 0.01 && Math.abs(q3export - (lineVat(ids.j) + lineVat(ids.f))) < 0.01,
    `VAT1 Q3 Ausgangs-VAT in der Übersicht ${q3ui} = Exportgrundlage ${q3export} (J + F, J trotz Rechnungsdatum Juni)`);
  ok(!q2da, `VAT1 …kein Q2-Eintrag für J (die alte Übersicht zählte J nach Rechnungsdatum unter Q2)`);
  const teilText = await c.ev(`return (document.querySelector('[data-vat-partial]')?.textContent || '').replace(/\\s+/g,' ').trim();`);
  const teilVat = await zahl('[data-vat-partial-vat]');
  ok(/Partly paid – not in the current NBR export: 1 invoice/.test(teilText) && Math.abs(teilVat - lineVat(ids.p)) < 0.01,
    `VAT2 Teilbezahlt getrennt: „${teilText.slice(0, 110)}" — nicht im Q3-Betrag`);
  ok(lineVat(ids.p) > 0 && Math.abs(q3ui - (lineVat(ids.j) + lineVat(ids.f))) < 0.01,
    `VAT2 …P (VAT ${lineVat(ids.p)}) fließt nicht in den ausgewiesenen Q3-Betrag ein`);
  const netto = await c.ev(`const row=document.querySelector('[data-vat-quarter="2026-Q3"]')?.closest('.flex.items-center.justify-between'); return row ? row.textContent : '';`);
  ok(/NET OWED/.test(netto) && (await exists(c, '[data-tax-pay-open="2026-Q3"]')),
    'VAT3 „NET OWED" und „Mark paid" stehen auf der Q3-Zeile der Exportgrundlage');
  ok(/Same basis as the NBR export/.test(await pageText(c)), 'VAT3 …Hinweis auf die Grundlage sichtbar');

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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — vat overview UI e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
