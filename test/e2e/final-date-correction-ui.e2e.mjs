// Owner 19.11.2026 — „Correct final invoice date" in der ECHTEN isolierten E2E-App (com.lataif.app.e2e, Port 3011).
// Run: node test/e2e/final-date-correction-ui.e2e.mjs   (aus dem Repo-Verzeichnis, nach `npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`)
//
//   A  Rechnung 02.11. über /invoices/new, voll bezahlt mit falschem Zahlungstag 10.11.
//   B  Knopf (echte Maus) → Dialog; ohne Grund gesperrt; 01.11. (vor dem Rechnungstag) → Nein, nichts geändert
//   C  08.11. mit Grund (echte Tastatur) → Zahlung und Endrechnungsdatum gemeinsam, Nummer bleibt, Protokoll, Detailseite
// Gerüst aus opening-date-ui.e2e.mjs (Preflight, nur eigene Prozesse). Produktion (com.lataif.app, 3001/3443) bleibt unberührt.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killTestImage, spawnTracked, testProcesses } from './_e2e-process.mjs';
import { maus, tippe } from './_e2e-mouse.mjs';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223, PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com', ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const RUN = join(os.tmpdir(), 'lataif-final-date-e2e', 'run-' + Date.now());
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
    insert(db, 'customers', { id: 'fd-k1', branch_id, first_name: 'Layla', last_name: 'Datum', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'products', { id: 'fd-inv', branch_id, category_id: 'cat-watch', brand: 'Omega', name: 'Speedmaster Endrechnung', sku: 'FD-INV', condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 400, purchase_currency: 'BHD', planned_sale_price: 1000, stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{"dial":"Black","material":"Steel"}', source_type: 'OWN', created_at: now, updated_at: now });
    insert(db, 'stock_lots', { id: 'lot-fd-inv', branch_id, product_id: 'fd-inv', unit_cost: 400, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}

const kopf = (id) => one('SELECT invoice_number, status, final_issued_at, revision FROM invoices WHERE id = ?', [id]);
const zahlung = (id) => one('SELECT id, received_at, amount, method FROM payments WHERE invoice_id = ?', [id]);
const zahlBuchung = (pid) => S(dbQ(`SELECT e1.account, e1.direction, e1.amount, substr(e1.occurred_at, 1, 10) AS tag FROM ledger_entries e1
   WHERE e1.source_module = 'PAYMENT' AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) ORDER BY e1.account`, [pid]));
const detailDatum = (c) => c.ev("return document.querySelector('[data-invoice-detail-date]')?.textContent?.trim() || '';");

async function rechnungNovember(c) {
  await gehFrisch(c, '/invoices/new');
  if (!(await warteBis(c, q('[data-ss-trigger="Search clients..."]'), 20000))) return 'KEINE-MASKE';
  const r = [await ssPick(c, 'Search clients...', 'fd-k1'), await ssPick(c, 'Pick product...', 'fd-inv')];
  await sleep(500);
  r.push(await setVal(c, 'input[type=date][title^="Default = today"]', '2026-11-02')); await sleep(300);
  r.push(await klick(c, '[data-invoice-pay-method="cash"]')); r.push(await klick(c, '[data-invoice-pay-full]'));
  await sleep(300);
  // Der Tippfehler, um den es geht: bezahlt am 08.11., erfasst als 10.11.
  r.push(await setVal(c, 'input[data-invoice-pay-date], [data-invoice-pay-date] input', '2026-11-10'));
  await sleep(400);
  r.push(await klick(c, '[data-invoice-save]'));
  if (r.every((x) => x === 'OK')) { await sleep(600); if (await exists(c, '[data-final-number-confirm]')) r.push(await nummerWahl(c)); }
  return alleOk(r);
}
async function korrekturOeffnen(c, rid) {
  await gehFrisch(c, `/invoices/${rid}`);
  if (!(await warteBis(c, q('[data-invoice-correct-final-date]'), 20000))) return 'KEIN-KNOPF';
  const r = [await maus(c, '[data-invoice-correct-final-date]')];
  r.push((await warteBis(c, q('[data-final-date-input]'), 10000)) ? 'OK' : 'KEIN-DIALOG');
  return alleOk(r);
}
async function korrigieren(c, tag, grund) {
  const r = [await setVal(c, '[data-final-date-input]', tag)];
  r.push(await tippe(c, '[data-final-date-reason]', grund));
  await sleep(300);
  r.push(await maus(c, '[data-final-date-save]'));
  return alleOk(r);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('CORRECT FINAL INVOICE DATE — UI-Test in der isolierten E2E-App\n');
const prodMtime = (f) => (f && existsSync(f) ? statSync(f).mtimeMs : 0);
const PROD_DB_FILE = prodDataDb();
const PROD_BEFORE = { data: prodMtime(PROD_DB_FILE), appdata: prodMtime(PROD_LOCATOR) };
let c;
try {
  stopApp(); await waitGoneAndFree();
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  ok(seedTool('seed-primary') === 'SEED_PRIMARY_OK', 'SETUP isolierter Server als Primary (Owner = ADMIN)');
  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c);
  ok(true, 'SETUP erste Anmeldung/Onboarding in der E2E-App');
  c.close(); stopApp(); await waitGoneAndFree();
  seedBusiness();

  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c); await sleep(1500);
  await antwort(c, true);

  // A — Rechnung vom 02.11., voll bezahlt mit falschem Zahlungstag 10.11.
  const mR = await rechnungNovember(c);
  await warteAuf(() => one("SELECT i.status FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.product_id = 'fd-inv'").status === 'FINAL');
  const RID = one("SELECT invoice_id FROM invoice_lines WHERE product_id = 'fd-inv'").invoice_id;
  const k0 = kopf(RID), z0 = zahlung(RID);
  ok(!!RID && k0.status === 'FINAL' && String(k0.final_issued_at).startsWith('2026-11-10') && String(z0.received_at).startsWith('2026-11-10'),
    `A1 Rechnung über /invoices/new, voll bezahlt, Endrechnungsdatum 10.11. (${mR}; ${S(k0)})`);

  // B — der Knopf öffnet den Dialog; ohne Grund kein Speichern; ein Tag vor dem Rechnungstag → Nein, nichts geändert
  {
    ok(await korrekturOeffnen(c, RID) === 'OK', 'B1 „Correct final date" mit echter Maus geöffnet');
    const zu = await c.ev("return !!document.querySelector('[data-final-date-save]')?.disabled;");
    ok(zu, 'B1 …ohne Grund ist „Correct date" gesperrt');
    const vor = S([kopf(RID), zahlung(RID), zahlBuchung(z0.id)]);
    const m = await korrigieren(c, '2026-11-01', 'Zahlungstag falsch getippt');
    await sleep(1500);
    const err = await fehlerText(c);
    ok(m === 'OK' && /cannot be before the invoice date/.test(err) && S([kopf(RID), zahlung(RID), zahlBuchung(z0.id)]) === vor,
      `B2 01.11. (vor dem Rechnungstag): abgewiesen, nichts geändert — „${err.slice(0, 160)}"`);
    MSG.push('B2 ' + err.slice(0, 220));
  }

  // C — richtiger Tag 08.11.: Zahlung und Endrechnungsdatum wandern gemeinsam, Nummer bleibt, Protokoll mit Grund
  {
    ok(await korrekturOeffnen(c, RID) === 'OK', 'C1 Dialog erneut geöffnet');
    const m = await korrigieren(c, '2026-11-08', 'Zahlungstag falsch getippt (08. statt 10.)');
    ok(await warteAuf(() => String(kopf(RID).final_issued_at).startsWith('2026-11-08'), 20000),
      `C1 gespeichert (echter Klick): Endrechnungsdatum ${kopf(RID).final_issued_at} (${m}; ${await fehlerText(c)})`);
    const k1 = kopf(RID), z1 = zahlung(RID);
    ok(String(z1.received_at).startsWith('2026-11-08') && k1.invoice_number === k0.invoice_number && Number(k1.revision) > Number(k0.revision),
      `C2 Zahlung am 08.11., Nummer unverändert ${k1.invoice_number}, Fassung ${k0.revision} → ${k1.revision}`);
    ok(/"tag":"2026-11-08"/.test(zahlBuchung(z0.id)) && !/"tag":"2026-11-10"/.test(zahlBuchung(z0.id)),
      `C3 Hauptbuch: die Zahlung steht lebend am 08.11. (${zahlBuchung(z0.id)})`);
    ok(zahl("SELECT COUNT(*) AS n FROM invoice_edits WHERE invoice_id = ? AND reason LIKE 'Zahlungstag falsch getippt (08.%'", [RID]) === 1
      && zahl("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND field_name = 'final_issued_at' AND new_value LIKE '%falsch getippt%'", [RID]) === 1,
    'C4 Protokoll: invoice_edits und Audit mit Grund');
    await gehFrisch(c, `/invoices/${RID}`);
    await warteBis(c, q('[data-invoice-detail-date]'), 15000);
    const d = await detailDatum(c);
    ok(/8/.test(d) && /Nov/.test(d) && !/10/.test(d), `C5 Detailseite zeigt das korrigierte Datum („${d}")`);
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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — final date correction UI e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
