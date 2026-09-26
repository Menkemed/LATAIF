// INVOICE-EDIT S2/S3/S4 + VAT-PERIOD-LOCK — ein gemeinsamer UI-Lauf durch die ECHTE isolierte E2E-App (com.lataif.app.e2e, Port 3011).
// Run: node test/e2e/invoice-vat-ui.e2e.mjs   (aus dem Repo-Verzeichnis)
// Helfer 1:1 aus stock-lot-ui.e2e.mjs (Preflight, nur eigene Prozesse, Klick-Muster). Produktion (com.lataif.app, E:\LATAIF\Data, 3001/3443) wird weder benutzt noch beendet.
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
const RUN = join(os.tmpdir(), 'lataif-invoice-vat-e2e', 'run-' + Date.now());
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
// Artikel MIT Einkaufslos (je 1 Los); s2-a hat 2 Stück, damit genau 1 zum Erhöhen fehlt.
const PRODUKTE = [['s2-a', 'Speedmaster S2', 2], ['s3-a', 'Seamaster S3', 1], ['s4-a', 'Constellation S4', 1], ['vt-a', 'De Ville VAT', 1]];
function seedBusiness() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    for (const [id, first, last] of [['e2e-k1', 'Nadia', 'Falsch'], ['e2e-k2', 'Omar', 'Richtig']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    for (const [id, name, menge] of PRODUKTE) {
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Omega', name, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD', planned_sale_price: 1000, stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: menge, images: '[]', attributes: '{"dial":"Black","material":"Steel"}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: 'lot-' + id, branch_id, product_id: id, unit_cost: 400, qty_total: menge, qty_remaining: menge, status: 'ACTIVE', acquired_at: now, created_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

const inv = (id) => one('SELECT id, customer_id, status, invoice_number, number_finalized_at, gross_amount, paid_amount, vat_amount, notes, issued_at FROM invoices WHERE id = ?', [id]);
const pays = (id) => S(dbQ('SELECT id, amount, method, received_at FROM payments WHERE invoice_id = ? ORDER BY id', [id]));
const payCount = (id) => Number(one('SELECT COUNT(*) n FROM payments WHERE invoice_id = ?', [id]).n);
const ar = (cust) => Math.round(Number(one("SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0) s FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?", [cust]).s) * 1000) / 1000;
const lot = (pid) => Number(one('SELECT qty_remaining FROM stock_lots WHERE product_id = ?', [pid]).qty_remaining);
const lineRow = (invId) => one('SELECT quantity, line_total, vat_amount, purchase_price_snapshot, lot_id FROM invoice_lines WHERE invoice_id = ?', [invId]);
const nrAudits = (id) => Number(one("SELECT COUNT(*) n FROM audit_log WHERE entity_id = ? AND field_name = 'invoice_number'", [id]).n);
const pageText = (c) => c.ev('return document.body.innerText;');

async function editOeffnen(c, invId) {
  await gehFrisch(c, `/invoices/${invId}/edit`);
  if (!(await warteBis(c, q('[data-invoice-save]'), 20000))) return 'KEINE-MASKE';
  await sleep(1500);
  return 'OK';
}
const grund = (c, t) => setVal(c, 'textarea[placeholder^="Explain why this invoice"]', t);
const notiz = (c, t) => setVal(c, 'textarea[placeholder^="e.g. delivery details"]', t);
const speichern = async (c) => { const r = await klick(c, '[data-invoice-save]'); await sleep(1800); return r; };
const aufDetail = (c, invId) => c.ev(`return location.pathname === ${S('/invoices/' + invId)};`);

// ═══════════════════════════════════════════════════════════════════════════
console.log('INVOICE + VAT — gemeinsamer UI-Lauf in der isolierten E2E-App\n');
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

  // ── Sitzung 2: vier Rechnungen über die Maske, alle voll bezahlt ─────────────
  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c); await sleep(1500);
  const ids = {};
  for (const [key, kunde, pid] of [['s2', 'e2e-k2', 's2-a'], ['s3', 'e2e-k1', 's3-a'], ['s4', 'e2e-k2', 's4-a'], ['vt', 'e2e-k2', 'vt-a']]) {
    const m = await rechnungMaske(c, kunde, pid, 1, 'full');
    await warteAuf(() => one('SELECT status FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.product_id = ?', [pid]).status === 'FINAL');
    ids[key] = lineOf(pid).invoice_id;
    ok(!!ids[key] && inv(ids[key]).status === 'FINAL' && /^S?INV-/.test(String(inv(ids[key]).invoice_number)),
      `SETUP ${key}: Rechnung über /invoices/new angelegt und voll bezahlt (${m}; ${inv(ids[key]).invoice_number}, ${inv(ids[key]).status})`);
  }
  // Erst sichern lassen, dann warten, bis der Test-Prozess WIRKLICH weg ist — Lauf 1 zeigte: ein
  // freier Port allein reicht nicht, die Rückdatierung wurde vom ausgehenden Prozess überschrieben.
  await sleep(3000);
  c.close(); await stopUndWeg();

  // ── Sitzung 3: die eigentlichen Prüfungen ────────────────────────────────────
  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c); await sleep(1500);
  await antwort(c, true);
  // Die VAT-Rechnung über die Oberfläche in den Mai legen, solange Q2 noch offen ist (Lauf 1/2: ein
  // direktes Schreiben in die Datei überschreibt die App beim Start — es fehlt im Changelog).
  {
    const id = ids.vt;
    const r = [await editOeffnen(c, id), await setVal(c, 'input[type=date]', '2026-05-10'), await grund(c, 'E2E Rechnungsdatum Mai')];
    r.push(await speichern(c));
    await warteAuf(() => String(inv(id).issued_at).startsWith('2026-05-10'));
    await gehFrisch(c, `/invoices/${id}`);
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Manage payments'))", 20000);
    r.push(await clickIncludes(c, 'Manage payments'));
    await warteBis(c, "document.querySelectorAll('input[type=date]').length > 0", 10000);
    r.push(await c.ev(`const e=[...document.querySelectorAll('input[type=date]')].pop(); if(!e) return 'NO-DATUM'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'2026-05-12'); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); e.dispatchEvent(new FocusEvent('blur')); e.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); return 'OK';`));
    await warteAuf(() => String(dbQ('SELECT received_at FROM payments WHERE invoice_id = ?', [id])[0]?.received_at).startsWith('2026-05-12'));
    ok(String(inv(id).issued_at).startsWith('2026-05-10') && String(dbQ('SELECT received_at FROM payments WHERE invoice_id = ?', [id])[0]?.received_at).startsWith('2026-05-12'),
      `SETUP VAT-Rechnung über Maske + „Manage payments" in den Mai gelegt, Q2 noch offen (${alleOk(r)}; ${inv(id).issued_at} / ${dbQ('SELECT received_at FROM payments WHERE invoice_id = ?', [id])[0]?.received_at})`);
  }

  // ══ S2 — Bearbeiten: festes Los, Mengenerhöhung ohne Bestand, reine Notiz ══
  UI.push('S2 /invoices/:id/edit — Los-Anzeige, Menge 1→3, Notiz');
  {
    const id = ids.s2;
    ok((await editOeffnen(c, id)) === 'OK', 'S2 Bearbeiten-Maske geöffnet');
    const t = await pageText(c);
    ok(/Lot ·[^\n]*· fixed/.test(t), `S2a das feste Einkaufslos wird angezeigt („${(t.match(/Lot ·[^\n]*· fixed/) || [''])[0]}")`);
    const vor = S([lineRow(id), inv(id), qty('s2-a'), lot('s2-a')]);
    const r = [await setVal(c, 'input[type=number][min="1"][step="1"]', '3'), await grund(c, 'E2E S2 Menge erhöhen')];
    await sleep(500);
    r.push(await speichern(c));
    const err = await fehlerText(c);
    ok(S([lineRow(id), inv(id), qty('s2-a'), lot('s2-a')]) === vor && !(await aufDetail(c, id)),
      `S2b Menge 1→3 bei 1 freiem Stück: abgewiesen, Rechnung/Bestand/Los unverändert (${alleOk(r)})`);
    ok(err.length > 0, `S2b …Meldung in der Maske: „${err.slice(0, 160)}"`);
    MSG.push('S2b ' + err.slice(0, 200));

    const vatVor = S([lineRow(id).vat_amount, inv(id).vat_amount, inv(id).gross_amount]);
    ok((await editOeffnen(c, id)) === 'OK', 'S2c Maske neu geöffnet');
    const r2 = [await notiz(c, 'E2E S2 nur Notiz'), await grund(c, 'E2E S2 Notiz')];
    r2.push(await speichern(c));
    ok(await warteAuf(() => inv(id).notes === 'E2E S2 nur Notiz'), `S2c reine Notiz gespeichert (${alleOk(r2)}; ${await fehlerText(c)})`);
    ok(S([lineRow(id).vat_amount, inv(id).vat_amount, inv(id).gross_amount]) === vatVor && inv(id).status === 'FINAL',
      `S2c …Margin-VAT und Brutto unverändert (${vatVor})`);
  }

  // ══ S3 — Falscher Kunde auf bezahlter Rechnung ══
  UI.push('S3 /invoices/:id/edit — Kunde K1→K2, Bestätigung abbrechen, dann bestätigen');
  {
    const id = ids.s3;
    const vorPays = pays(id); const vorNr = inv(id).invoice_number;
    const arVor = [ar('e2e-k1'), ar('e2e-k2')];
    ok((await editOeffnen(c, id)) === 'OK', 'S3 Bearbeiten-Maske geöffnet');
    const r = [await ssPick(c, 'Search clients...', 'e2e-k2'), await grund(c, 'E2E S3 falscher Kunde')];
    r.push(await antwort(c, false));
    r.push(await speichern(c));
    const dlg = await dialoge(c);
    ok(/Correct the customer/.test(dlg) && inv(id).customer_id === 'e2e-k1' && pays(id) === vorPays && !(await aufDetail(c, id)),
      `S3a Bestätigungsdialog abgebrochen: nichts geändert, Kunde bleibt K1, Maske bleibt offen (${alleOk(r)}; Dialog: „${dlg.slice(0, 90)}…")`);
    MSG.push('S3 Dialog: ' + dlg.slice(0, 260));
    await antwort(c, true);
    const r2 = [await speichern(c)];
    ok(await warteAuf(() => inv(id).customer_id === 'e2e-k2'), `S3b bestätigt: Kunde K1→K2 (${alleOk(r2)}; ${await fehlerText(c)})`);
    ok(pays(id) === vorPays && inv(id).invoice_number === vorNr && inv(id).status === 'FINAL',
      `S3b …Zahlungen (Betrag/Datum/Art) und Rechnungsnummer ${vorNr} unverändert`);
    ok(ar('e2e-k1') === 0 && ar('e2e-k2') === 0,
      `S3b …Kundenforderungen: K1 ${ar('e2e-k1')} / K2 ${ar('e2e-k2')} BHD (vorher ${arVor.join(' / ')}) — keine offene Forderung beim falschen Kunden`);
  }

  // ══ S4 — FINAL → PARTIAL → FINAL ══
  UI.push('S4 /invoices/:id/edit Preis erhöhen → PARTIAL; /invoices Rest bezahlen → FINAL');
  {
    const id = ids.s4;
    const nr = inv(id).invoice_number; const nrAt = inv(id).number_finalized_at;
    const bestand = S([qty('s4-a'), lot('s4-a'), st('s4-a')]);
    const brutto0 = Number(inv(id).gross_amount);
    const m = await aendernMaske(c, id, brutto0 + 200);
    ok(await warteAuf(() => inv(id).status === 'PARTIAL'), `S4a Preis +200: FINAL → PARTIAL (${m}; ${inv(id).paid_amount}/${inv(id).gross_amount}; ${await fehlerText(c)})`);
    ok(inv(id).invoice_number === nr && payCount(id) === 1, `S4a …Nummer ${nr} bleibt, weiterhin 1 Zahlung`);
    await gehFrisch(c, '/invoices');
    await warteBis(c, q(`[data-pay-invoice="${id}"]`), 20000);
    const r = [await klick(c, `[data-pay-invoice="${id}"]`)];
    await warteBis(c, q('[data-invoice-list-pay]'), 8000);
    r.push(await klick(c, '[data-invoice-list-pay-method="cash"]')); await sleep(200);
    r.push(await klick(c, '[data-invoice-list-pay]')); await sleep(900);
    const nummerDialog = await exists(c, '[data-final-number-confirm]');
    if (nummerDialog) r.push(await nummerWahl(c));
    ok(await warteAuf(() => inv(id).status === 'FINAL'), `S4b Rest bezahlt: PARTIAL → FINAL (${alleOk(r)})`);
    await sleep(1200);
    ok(!nummerDialog && inv(id).invoice_number === nr && inv(id).number_finalized_at === nrAt && nrAudits(id) === 1,
      `S4b …dieselbe Nummer ${inv(id).invoice_number}, kein zweiter Nummerndialog, Endnummer einmal vergeben (${nrAudits(id)}×)`);
    ok(payCount(id) === 2 && Math.abs(Number(inv(id).paid_amount) - (brutto0 + 200)) < 0.01 && ar('e2e-k2') === 0,
      `S4b …genau 2 Zahlungen = ${inv(id).paid_amount} BHD, Forderung K2 ${ar('e2e-k2')}`);
    ok(S([qty('s4-a'), lot('s4-a'), st('s4-a')]) === bestand,
      `S4b …kein zweiter Bestandsabzug (Menge/Los/Status ${bestand})`);
  }

  // ══ VAT — Quartal einreichen, Sperre, Notiz, Artikelumbenennung ══
  UI.push('VAT /analytics Finance „Mark VAT filed"; /invoices/:id/edit; /collection/:id Umbenennen');
  {
    const id = ids.vt;
    await gehFrisch(c, '/analytics');
    await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='FINANCE')", 20000);
    await clickText(c, 'FINANCE');
    const da = await warteBis(c, q('[data-vat-file-open="2026-Q2"]'), 30000);
    const offen = await exists(c, '[data-vat-file-open="2026-Q3"]');
    ok(da && !offen, `VAT0 Knopf „Mark VAT filed" für Q2/2026 da, für das laufende Q3 nicht (${da}/${offen})`);
    const filings = () => Number(one('SELECT COUNT(*) n FROM vat_filings WHERE year = 2026 AND quarter = 2').n);
    const r0 = [await antwort(c, false), await klick(c, '[data-vat-file-open="2026-Q2"]')];
    await sleep(2500);
    const d0 = await dialoge(c);
    ok(/Mark 2026 Q2 as VAT filed/.test(d0) && filings() === 0 && (await exists(c, '[data-vat-file-open="2026-Q2"]')),
      `VAT1 Rückfrage abgebrochen: nichts eingereicht, Knopf bleibt (${alleOk(r0)})`);
    await antwort(c, true);
    const r = [await klick(c, '[data-vat-file-open="2026-Q2"]')];
    const nDlg = MSG.length; MSG.push('VAT1 Dialog: ' + (await dialoge(c)).slice(0, 200));
    ok(await warteAuf(() => filings() === 1), `VAT1 Q2/2026 als eingereicht markiert (${alleOk(r)})`);
    const f = one('SELECT filed_at, filed_by, invoice_count, snapshot_json FROM vat_filings WHERE year = 2026 AND quarter = 2');
    const snap = JSON.parse(String(f.snapshot_json || '{}'));
    ok(f.filed_by && Number(f.invoice_count) === 1 && snap.invoices?.[0]?.invoiceId === id && snap.invoices?.[0]?.lines?.[0]?.[7] === 'Omega De Ville VAT',
      `VAT1 …Zeitpunkt ${String(f.filed_at).slice(0, 19)}, Person, 1 Rechnung mit Kunde/Artikel im Snapshot; Dialog: „${MSG.slice(nDlg).join(' ').slice(0, 70)}…"`);
    ok(await warteBis(c, q('[data-vat-filed="2026-Q2"]'), 15000), 'VAT1 …Übersicht zeigt „VAT filed <Datum>"');

    const vor = S([inv(id), lineRow(id), pays(id)]);
    const m = await aendernMaske(c, id, Number(inv(id).gross_amount) + 100);
    const err = await fehlerText(c);
    ok(S([inv(id), lineRow(id), pays(id)]) === vor && /already filed/.test(err),
      `VAT2 Preisänderung an der gemeldeten Rechnung: abgewiesen, nichts geändert (${m}) — „${err.slice(0, 130)}"`);
    MSG.push('VAT2 ' + err.slice(0, 220));
    ok((await editOeffnen(c, id)) === 'OK', 'VAT3 Maske neu geöffnet');
    const r3 = [await notiz(c, 'E2E interne Notiz'), await grund(c, 'E2E Notiz nach Einreichung')];
    r3.push(await speichern(c));
    ok(await warteAuf(() => inv(id).notes === 'E2E interne Notiz'), `VAT3 interne Notiz nach der Einreichung: gespeichert (${alleOk(r3)}; ${await fehlerText(c)})`);
    ok(inv(id).gross_amount === JSON.parse(vor)[0].gross_amount && inv(id).issued_at === JSON.parse(vor)[0].issued_at && pays(id) === JSON.parse(vor)[2],
      'VAT3 …Beträge, Rechnungsdatum und Zahlungen unverändert');

    // Artikel der gemeldeten Rechnung umbenennen.
    const umbenennen = async (pid, name) => {
      await gehFrisch(c, `/collection/${pid}`);
      if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Edit')", 20000))) return 'KEIN-EDIT';
      const rr = [await clickText(c, 'Edit')];
      await warteBis(c, q('#field-name input'), 10000);
      rr.push(await setVal(c, '#field-name input', name));
      await sleep(300);
      rr.push(await klick(c, '[data-save-product]'));
      await sleep(2000);
      return alleOk(rr);
    };
    const nameVor = one("SELECT name FROM products WHERE id = 'vt-a'").name;
    const u1 = await umbenennen('vt-a', 'De Ville NEU');
    const e1 = await c.ev(`return (document.querySelector('[data-save-error]')?.textContent || '').trim();`);
    ok(one("SELECT name FROM products WHERE id = 'vt-a'").name === nameVor && /Brand and name appear in that return/.test(e1),
      `VAT4 Artikel der gemeldeten Rechnung umbenennen: abgewiesen, Name bleibt „${nameVor}" (${u1}) — „${e1.slice(0, 120)}"`);
    MSG.push('VAT4 ' + e1.slice(0, 220));
    const u2 = await umbenennen('s2-a', 'Speedmaster Neu');
    ok(await warteAuf(() => one("SELECT name FROM products WHERE id = 's2-a'").name === 'Speedmaster Neu'),
      `VAT4 …Artikel nur im offenen Quartal verkauft: umbenennen geht (${u2})`);
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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — invoice + VAT UI e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
