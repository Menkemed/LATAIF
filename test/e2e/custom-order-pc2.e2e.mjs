// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Phase 1 — K1/K2/K3a am echten Primary und echten PC2 (zwei isolierte Apps).
// Run: node test/e2e/custom-order-pc2.e2e.mjs
//
//   1 PC2 schaltet einen Sonderauftrag vor (pending → arrived → notified → completed): Lohn-Schuld und Goldwert
//     entstehen genau einmal am Primary.
//   2 PC2 „Create Invoice": EIN Dialog (Datum, Steuerart Zero vorgewählt, Nummernart); Rechnung am gewählten Tag,
//     der Artikel entsteht im Haus mit SKU/Kategorie/Einstand, Wareneinsatz 210, Lager 0.
//   3 PC2 begleicht die Goldschuld in BHD (4.330 g × 44): die Rechnungszeile trägt den tatsächlichen Einstand 215.520.
//   4 PC2 sieht die Begleichung im Dialog und nimmt sie zurück (Review: PC2-Parität): alles wie vorher; Hauptbuch ausgeglichen.
//   5 PC2 Artikelseite: Herkunft „Custom Order" mit Order-Nummer und Rechnung (Review: SKU/Herkunft).
//   6 PC2 Altweg (Order ohne Steuerart je Position): kein Artikel vor dem Dialog; danach EINE Zeile über den Preis (Review).
//
// PROZESS-ISOLATION: gestartet nur über spawnTracked; Ports 3011/9223/9224, Daten com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'co-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-custom-order', 'run-' + Date.now());
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
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.'); aufraeumen(); process.exit(1); }, 40 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env, APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'), LATAIF_E2E_SYNC_PORT: String(PORT),
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
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}
async function attachOnly(cdpPort, budget = 60000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* noch nicht */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c;
}
async function attach(cdpPort, exe, env) { spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref(); return attachOnly(cdpPort, 120000); }
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)'; try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteBis(c, ausdruck, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); } return false; }
async function warteAuf(pruefe, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (pruefe()) return true; await sleep(400); } return pruefe(); }
async function waitInvoke(c) { const end = Date.now() + 60000; while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); } throw new Error('no invoke'); }
const SHELL = 'a[href="/settings"]';
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1500); }
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');

// Fernaufträge (Ops) mitschreiben, Dialoge abfangen, Datenbankgriffe ohne Datenbank merken.
const HAKEN = `
  if (!window.__ipHaken) {
    window.__ipHaken = true; window.__cmds = []; window.__alerts = []; window.__dbHits = [];
    window.alert = (m) => { window.__alerts.push(String(m)); };
    window.confirm = () => true;
    const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
    const oe = console.error; console.error = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); oe(...a); };
    const ow = console.warn; console.warn = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); ow(...a); };
    const of = window.fetch;
    window.fetch = async (...a) => {
      let url = ''; try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
      if (/\\/api\\/command$/.test(url)) { try { const b = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: b.op, payload: b.payload }); } catch (e) { /* egal */ } }
      return of(...a);
    };
  }
`;
async function hakenLegen(c) {
  await c.send('Page.enable', {});
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: HAKEN });
  await c.ev(HAKEN + ' return 1;');
}
const befehle = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));

/** „PAID" aufklappen und die Zeilen lesen: Datum, Zahlungsart, Notiz, Betrag — so, wie sie dastehen. */
const LISTE = `
  const span = [...document.querySelectorAll('span.text-overline')].find((s) => s.textContent.trim() === 'PAID');
  const btn = span && span.closest('button');
  if (!btn) return JSON.stringify({ fehlt: true });
  if (!btn.disabled && btn.title === 'Show payment breakdown') { btn.click(); await new Promise((r) => setTimeout(r, 400)); }
  const box = btn.parentElement.querySelector(':scope > div');
  const zeilen = box ? [...box.querySelectorAll(':scope > div.flex.justify-between.items-center')].map((z) => {
    const links = z.querySelector(':scope > div');
    const t = links ? [...links.querySelectorAll(':scope > span')].map((s) => s.textContent.trim()) : [];
    return { datum: t[0], art: t[1], notiz: t[2] || '', betrag: z.querySelector(':scope > .font-mono')?.textContent.trim() };
  }) : [];
  return JSON.stringify({ disabled: btn.disabled, paid: btn.querySelector('.font-mono')?.textContent.trim(), zeilen });
`;
async function zahlungsliste(c, invId) {
  await gehFrisch(c, `/invoices/${invId}`);
  await warteBis(c, "[...document.querySelectorAll('span.text-overline')].some((s) => s.textContent.trim() === 'PAID')", 30000);
  await sleep(2500);   // PC2: Stores und Auskünfte vom Primary sind da
  return JSON.parse(await c.ev(LISTE));
}
const MODAL = `
  const m = [...document.querySelectorAll('[role="dialog"], .fixed')].find((d) => /Payments —/.test(d.textContent || ''));
  if (!m) return JSON.stringify({ offen: false });
  const leer = /No payments recorded yet/.test(m.textContent);
  const zeilen = [...m.querySelectorAll('input[type=date]')].map((d) => {
    const z = d.parentElement;
    return { datum: d.value, betrag: z.querySelector('input[type=number]')?.value, art: z.querySelector('select')?.value, notiz: z.querySelectorAll('input')[2]?.value || '' };
  });
  return JSON.stringify({ offen: true, leer, zeilen });
`;
async function modalListe(c) {
  const r = await c.ev("const b=[...document.querySelectorAll('button')].find((x)=>/Manage payments/.test(x.textContent)); if(!b) return 'KEIN-KNOPF'; b.click(); return 'OK';");
  if (r !== 'OK') return { offen: false, grund: r };
  await sleep(700);
  return JSON.parse(await c.ev(MODAL));
}

// ══════════════════════════════════════════════════════════════════════════════
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
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k]));
}
const ORD = 'co-ord';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-gold-jewelry'").get()) {
      insert(db, 'categories', { id: 'cat-gold-jewelry', branch_id, name: 'Gold-Diamond Jewellery', icon: 'Gem', color: '#C6A36D', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    insert(db, 'customers', { id: 'co-kunde', branch_id, first_name: 'Um', last_name: 'Khalid', phone: '+973 3600 0303', country: 'BH', language: 'en',
      vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'co-arup', branch_id, name: 'Arup Goldsmith', active: 1, is_workshop: 1, created_at: now, updated_at: now });
    const spec = { categoryId: 'cat-gold-jewelry', brand: '', name: 'Ring', sku: '', condition: 'New', taxScheme: 'ZERO', attributes: { karat: '21K', weight: 4.33, item_type: 'Ring' }, images: [], scopeOfDelivery: [] };
    insert(db, 'orders', { id: ORD, branch_id, order_number: 'ORD-2026-E2E01', customer_id: 'co-kunde', type: 'custom', status: 'pending',
      agreed_price: 240, remaining_amount: 240, requested_brand: 'Custom Order', requested_model: 'Ring', order_date: '2026-10-25',
      goldsmith_supplier_id: 'co-arup', labor_cost: 25, extra_gold_value: 185, custom_product_spec: JSON.stringify(spec),
      created_at: now, updated_at: now });
    const zeile = (id, pos, d) => insert(db, 'order_lines', { id, order_id: ORD, position: pos, quantity: 1, status: 'PENDING', created_at: now, updated_at: now, ...d });
    zeile('co-l1', 1, { description: 'Ring 21K Emerald', unit_price: 240, tax_scheme: 'ZERO', vat_rate: 0, is_customer_facing: 1, material_kind: 'custom', cost_amount: 0 });
    zeile('co-l2', 2, { description: 'Goldsmith Labor — Arup Goldsmith', unit_price: 0, is_customer_facing: 0, material_kind: 'labor', cost_amount: 25, supplier_id: 'co-arup' });
    zeile('co-l3', 3, { description: 'Extra Gold 4.330g 21K — Arup Goldsmith', unit_price: 0, is_customer_facing: 0, material_kind: 'gold', cost_amount: 185,
      material_details: JSON.stringify({ weightGrams: 4.33, karat: '21K', supplierName: 'Arup Goldsmith' }) });
    insert(db, 'gold_payables', { id: 'co-gp', branch_id, supplier_id: 'co-arup', source_order_id: ORD, source_order_line_id: 'co-l3', direction: 'we_owe',
      weight_grams: 4.33, karat: '21K', settlement_type: 'return_gold', fulfilled_grams: 0, status: 'OPEN', created_at: now, updated_at: now });
    // Altbestand: eine abgeschlossene Order OHNE Steuerart an ihrer Position (vor v0.1.15) und ohne Artikel.
    insert(db, 'orders', { id: 'co-leg', branch_id, order_number: 'ORD-2026-E2E02', customer_id: 'co-kunde', type: 'normal', status: 'completed',
      agreed_price: 500, remaining_amount: 500, requested_brand: 'Omega', requested_model: 'Speedmaster', order_date: '2026-10-28', created_at: now, updated_at: now });
    insert(db, 'order_lines', { id: 'co-leg-l1', order_id: 'co-leg', position: 1, quantity: 1, status: 'ARRIVED', description: 'Omega Speedmaster',
      unit_price: 500, is_customer_facing: 1, created_at: now, updated_at: now });
    // CUSTOM-ORDER Abschluss — eine ALTE Custom Order (ohne Steuerart an der Position, ohne Sonderstück-Zeile) OHNE Kategorie.
    insert(db, 'orders', { id: 'co-nocat', branch_id, order_number: 'ORD-2026-E2E03', customer_id: 'co-kunde', type: 'custom', status: 'completed',
      agreed_price: 300, remaining_amount: 300, requested_brand: 'Custom Order', requested_model: 'Bangle', order_date: '2026-10-28',
      custom_product_spec: JSON.stringify({ ...spec, categoryId: '', name: 'Bangle' }), created_at: now, updated_at: now });
    insert(db, 'order_lines', { id: 'co-nocat-l1', order_id: 'co-nocat', position: 1, quantity: 1, status: 'ARRIVED', description: 'Bangle 21K',
      unit_price: 300, is_customer_facing: 1, created_at: now, updated_at: now });
    // …und eine mit MANUELLER SKU in einer Kategorie ohne SKU-Kürzel: die SKU umgeht die Kategorieprüfung nicht.
    insert(db, 'categories', { id: 'co-cat-silver', branch_id, name: 'Silver E2E', icon: 'Gem', color: '#999', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 9, created_at: now, updated_at: now });
    insert(db, 'orders', { id: 'co-skucat', branch_id, order_number: 'ORD-2026-E2E04', customer_id: 'co-kunde', type: 'custom', status: 'completed',
      agreed_price: 280, remaining_amount: 280, requested_brand: 'Custom Order', requested_model: 'Pendant', order_date: '2026-10-28', category_id: 'co-cat-silver',
      custom_product_spec: JSON.stringify({ ...spec, categoryId: 'co-cat-silver', sku: 'LAT-E2E-001', name: 'Pendant' }), created_at: now, updated_at: now });
    insert(db, 'order_lines', { id: 'co-skucat-l1', order_id: 'co-skucat', position: 1, quantity: 1, status: 'ARRIVED', description: 'Pendant',
      unit_price: 280, is_customer_facing: 1, created_at: now, updated_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}
const saldo = (account, where = '1=1', p = []) => Math.round(Number(dbQ(BIZ_DB,
  `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) AS s FROM ledger_entries WHERE account = ? AND ${where}`, [account, ...p])[0]?.s ?? 0) * 1000) / 1000;
const gestern = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
async function weiterSchalten(c, label) {
  const r = await clickText(c, `Advance to ${label}`);
  await sleep(500);
  const r2 = await c.ev("const m=[...document.querySelectorAll('[role=\"dialog\"], .fixed')].find((d)=>/Advance Status/.test(d.textContent||'')); const b=m && [...m.querySelectorAll('button')].find((x)=>x.textContent.trim()==='Confirm'); if(!b) return 'KEIN-CONFIRM'; b.click(); return 'OK';");
  await sleep(2500);
  return `${r}/${r2}`;
}
let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Einrichten (wie invoice-payments-pc2) ─────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'CO Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'CO Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'CO Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null); await sleep(1200);
  const onboardingPid = startedPids().pop();
  primary.close(); primary = null;
  await closeTestWindow(onboardingPid, APP); await waitTestImageGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 90000);
  await hakenLegen(primary);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ } await sleep(500); }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await klick(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await klick(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await klick(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  await hakenLegen(client);
  ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SETUP PC2 ohne Geschäftsdatenbank, angemeldet');

  // ── 1 K1 am PC2: Status vorschalten → Lohn-Schuld + Goldwert genau einmal ──────────────────
  await gehFrisch(client, `/orders/${ORD}`);
  await warteBis(client, "[...document.querySelectorAll('button')].some((b)=>/^Advance to /.test(b.textContent.trim()))", 40000);
  const s1 = await weiterSchalten(client, 'Arrived');
  await spuelen(primary).catch(() => null);
  ok(await warteAuf(() => dbQ(BIZ_DB, `SELECT status FROM orders WHERE id = '${ORD}'`)[0]?.status === 'arrived'), `K1 PC2 → arrived (${s1})`);
  const exp1 = dbQ(BIZ_DB, "SELECT amount FROM expenses WHERE related_module = 'order' AND category = 'Inventory'");
  const gp1 = dbQ(BIZ_DB, "SELECT book_value FROM gold_payables WHERE id = 'co-gp'")[0];
  ok(exp1.length === 1 && Number(exp1[0].amount) === 25 && Number(gp1?.book_value) === 185 && saldo('INVENTORY') === 210 && saldo('GOLD_LIABILITY') === -185,
    `K1 Lohn 25 als Lieferantenschuld, Goldwert 185, Lager 210 (${S(exp1)} / ${S(gp1)} / ${saldo('INVENTORY')})`);
  for (const l of ['Notified', 'Completed']) {
    await gehFrisch(client, `/orders/${ORD}`);
    await warteBis(client, `[...document.querySelectorAll('button')].some((b)=>b.textContent.trim()==='Advance to ${l}')`, 40000);
    await weiterSchalten(client, l);
  }
  await spuelen(primary).catch(() => null);
  ok(await warteAuf(() => dbQ(BIZ_DB, `SELECT status FROM orders WHERE id = '${ORD}'`)[0]?.status === 'completed')
    && dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM expenses WHERE related_module = 'order' AND category = 'Inventory'")[0]?.n === 1
    && saldo('INVENTORY') === 210, 'K1 → completed: nichts doppelt gebucht');

  // ── 2 K2 am PC2: Create Invoice — EIN Dialog mit Datum, Steuerart (Zero vorgewählt), Nummernart ──────────
  await gehFrisch(client, `/orders/${ORD}`);
  await warteBis(client, "[...document.querySelectorAll('button')].some((b)=>b.textContent.trim()==='Create Invoice')", 40000);
  await clickText(client, 'Create Invoice');
  await waitFor(client, '[data-testid="order-invoice-date"]', 20000);
  const vor = await client.ev(`const m=[...document.querySelectorAll('[role="dialog"], .fixed')].find((d)=>d.querySelector('[data-testid="order-invoice-date"]'));
    const aktiv=[...m.querySelectorAll('button')].filter((b)=>/rgba\\(15, ?15, ?16/.test(b.getAttribute('style')||'')).map((b)=>b.textContent.trim());
    return JSON.stringify({ text: m.textContent.includes('240.000 BHD'), aktiv });`);
  ok(/Zero/.test(vor) && /"text":true/.test(vor), `K2 Dialog: Zero vorgewählt, Brutto 240.000 sichtbar (${vor})`);
  ok((await setVal(client, '[data-testid="order-invoice-date"]', gestern)) === 'OK', `K2 Rechnungsdatum gesetzt (${gestern})`);
  await sleep(400);
  const go = await client.ev("const m=[...document.querySelectorAll('[role=\"dialog\"], .fixed')].find((d)=>d.querySelector('[data-testid=\"order-invoice-date\"]')); const b=[...m.querySelectorAll('button')].filter((x)=>x.textContent.trim()==='Create Invoice').pop(); if(!b) return 'NO'; if(b.disabled) return 'DISABLED'; b.click(); return 'OK';");
  await spuelen(primary).catch(() => null);
  ok(go === 'OK' && await warteAuf(() => !!dbQ(BIZ_DB, `SELECT invoice_id FROM orders WHERE id = '${ORD}'`)[0]?.invoice_id, 40000), `K2 PC2 wandelt um (${go})`);
  const inv = dbQ(BIZ_DB, `SELECT i.id, substr(i.issued_at,1,10) AS tag, i.gross_amount, i.vat_amount, i.vat_rate_snapshot FROM invoices i JOIN orders o ON o.invoice_id = i.id WHERE o.id = '${ORD}'`)[0];
  const prod = dbQ(BIZ_DB, `SELECT p.id, p.sku, p.category_id, p.purchase_price, p.origin_type, p.origin_order_number FROM products p JOIN orders o ON o.product_id = p.id WHERE o.id = '${ORD}'`)[0];
  ok(inv?.tag === gestern && Number(inv.gross_amount) === 240 && Number(inv.vat_amount) === 0 && Number(inv.vat_rate_snapshot) === 0,
    `K2 Rechnung am gewählten Tag, Zero, 240, Satz 0 (${S(inv)})`);
  ok(prod && /^ITM-GLD-\d{3,}$/.test(String(prod.sku)) && prod.category_id === 'cat-gold-jewelry' && Number(prod.purchase_price) === 210
    && prod.origin_type === 'CUSTOM_ORDER' && prod.origin_order_number === 'ORD-2026-E2E01',
    `K2 Artikel am Primary im Haus angelegt: SKU ITM-GLD, Kategorie, Einstand, Herkunft (${S(prod)})`);
  ok(saldo('COGS') === 210 && saldo('INVENTORY') === 0, `K2 Wareneinsatz 210, Lager 0 (${saldo('COGS')}/${saldo('INVENTORY')})`);
  const ops = (await befehle(client)).map((x) => x.op);
  ok(ops.includes('orders.convert_to_invoice') && ops.includes('orders.update_status'), `K2 PC2 über die Fernbefehle (${[...new Set(ops)].filter((o) => /orders|gold/.test(o)).join(',')})`);
  ok((await client.ev('return window.__dbHits.length;')) === 0, 'PC2 greift auf keine lokale Datenbank zu');

  // ── 3 K3a am PC2: Goldschuld in BHD (4.330 g × 44) → Rechnungszeile berichtigt ──────────────────────────
  await gehFrisch(client, `/orders/${ORD}`);
  await warteBis(client, "!!document.querySelector('[data-gold-settle-open=\"order_money\"]')", 40000);
  await klick(client, '[data-gold-settle-open="order_money"]');
  await waitFor(client, '[data-testid="order-gold-rate"]', 20000);
  await setVal(client, '[data-testid="order-gold-rate"]', '44');
  await sleep(300);
  const st = await clickText(client, 'Settle in BHD');
  await spuelen(primary).catch(() => null);
  ok(st === 'OK' && await warteAuf(() => dbQ(BIZ_DB, "SELECT status FROM gold_payables WHERE id = 'co-gp'")[0]?.status === 'FULFILLED', 40000), `K3a PC2 begleicht in BHD (${st})`);
  const il = dbQ(BIZ_DB, `SELECT purchase_price_snapshot AS c FROM invoice_lines WHERE invoice_id = '${inv?.id}'`)[0];
  ok(Number(il?.c) === 215.52 && saldo('COGS') === 215.52 && saldo('GOLD_LIABILITY') === 0 && saldo('INVENTORY') === 0,
    `K3a Mehrpreis 5.520 im Einstand der Rechnung, Goldschuld-Wert 0 (${S(il)} / ${saldo('COGS')})`);

  // ── 4 K3a am PC2: die Begleichung im Dialog sehen und zurücknehmen (dieselbe Hausfolge am Primary) ─────────
  {
    await gehFrisch(client, `/orders/${ORD}`);
    await warteBis(client, "!!document.querySelector('[data-gold-settle-open=\"order_settlements\"]')", 40000);
    await klick(client, '[data-gold-settle-open="order_settlements"]');
    const liste = await warteBis(client, "!!document.querySelector('[data-order-gold-settlement]')", 20000);
    const zeile = await client.ev("const z=document.querySelector('[data-order-gold-settlement]'); return z ? z.textContent : '';");
    ok(liste && /4\.330 g × 44\.000 = 190\.520 BHD/.test(String(zeile)), `K3a PC2 sieht die Begleichung im Dialog (${String(zeile).slice(0, 90)})`);
    const rv = await clickText(client, 'Reverse');
    await spuelen(primary).catch(() => null);
    ok(rv === 'OK' && await warteAuf(() => dbQ(BIZ_DB, "SELECT status FROM gold_payables WHERE id = 'co-gp'")[0]?.status === 'OPEN', 30000), `K3a PC2 nimmt die Begleichung zurück (${rv})`);
    const zur = (await befehle(client)).filter((x) => x.op === 'gold.payables.settle').map((x) => x.payload?.mode);
    ok(zur.includes('money_order') && zur.includes('money_order_reverse'), `K3a PC2 über den Fernbefehl (${zur.join(',')})`);
    const il2 = dbQ(BIZ_DB, `SELECT purchase_price_snapshot AS c FROM invoice_lines WHERE invoice_id = '${inv?.id}'`)[0];
    ok(Number(il2?.c) === 210 && saldo('COGS') === 210 && saldo('GOLD_LIABILITY') === -185 && dbQ(BIZ_DB, "SELECT status FROM gold_payable_settlements")[0]?.status === 'REVERSED',
      `K3a Rücknahme: Rechnungszeile 210, Wareneinsatz 210, Goldschuld-Wert 185 (${S(il2)} / ${saldo('COGS')})`);
    const bal = dbQ(BIZ_DB, "SELECT ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d FROM ledger_entries")[0]?.d;
    ok(Math.abs(Number(bal) || 0) < 0.0005, `Hauptbuch ausgeglichen (${bal})`);
  }

  // ── 5 PC2 Artikelseite: Herkunft „Custom Order" mit Order-Nummer und Rechnung ─────────────────────────────
  {
    await gehFrisch(client, `/collection/${prod?.id}`);
    const da = await warteBis(client, "!!document.querySelector('[data-product-origin=\"CUSTOM_ORDER\"]')", 40000);
    const txt = await client.ev("const z=document.querySelector('[data-product-origin]'); return z ? z.textContent : '';");
    ok(da && /Custom Order/.test(String(txt)) && /ORD-2026-E2E01/.test(String(txt)) && !!(await client.ev("return !!document.querySelector('[data-product-origin-invoice]');")),
      `Herkunft am PC2 sichtbar: Custom Order, Order-Nummer, Rechnung (${String(txt).slice(0, 120)})`);
    ok((await client.ev('return window.__dbHits.length;')) === 0, 'PC2 greift auch hier auf keine lokale Datenbank zu');
  }

  // ── 6 PC2 Altweg: kein Artikel vor dem Dialog, danach eine Zeile über den vereinbarten Preis ─────────────────
  {
    const artikel = () => Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM products')[0]?.n ?? 0);
    const vor = artikel();
    await gehFrisch(client, '/orders/co-leg');
    await warteBis(client, "[...document.querySelectorAll('button')].some((b)=>b.textContent.trim()==='Create Invoice')", 40000);
    await clickText(client, 'Create Invoice');
    const dlg = await warteBis(client, "!!document.querySelector('[data-testid=\"order-invoice-date\"]')", 20000);
    const zeigt = await client.ev("const m=[...document.querySelectorAll('[role=\"dialog\"], .fixed')].find((d)=>d.querySelector('[data-testid=\"order-invoice-date\"]')); return m ? m.textContent : '';");
    ok(dlg && /Speedmaster/.test(String(zeigt)) && /500\.000 BHD/.test(String(zeigt)) && artikel() === vor,
      `Altweg PC2: der Dialog zeigt die eine Zeile (Speedmaster, 500.000) — noch kein Artikel angelegt (${artikel()} = ${vor})`);
    const go = await client.ev("const m=[...document.querySelectorAll('[role=\"dialog\"], .fixed')].find((d)=>d.querySelector('[data-testid=\"order-invoice-date\"]')); const b=[...m.querySelectorAll('button')].filter((x)=>x.textContent.trim()==='Create Invoice').pop(); if(!b) return 'NO'; if(b.disabled) return 'DISABLED'; b.click(); return 'OK';");
    await spuelen(primary).catch(() => null);
    ok(go === 'OK' && await warteAuf(() => !!dbQ(BIZ_DB, "SELECT invoice_id FROM orders WHERE id = 'co-leg'")[0]?.invoice_id, 40000), `Altweg PC2 wandelt um (${go})`);
    const inv = dbQ(BIZ_DB, "SELECT i.gross_amount, (SELECT COUNT(*) FROM invoice_lines il WHERE il.invoice_id = i.id) AS zeilen, (SELECT il.tax_scheme FROM invoice_lines il WHERE il.invoice_id = i.id) AS art FROM invoices i JOIN orders o ON o.invoice_id = i.id WHERE o.id = 'co-leg'")[0];
    const p = dbQ(BIZ_DB, "SELECT p.origin_type, p.origin_order_number, p.sku FROM products p JOIN orders o ON o.product_id = p.id WHERE o.id = 'co-leg'")[0];
    ok(inv && Number(inv.gross_amount) === 500 && Number(inv.zeilen) === 1 && artikel() === vor + 1 && p?.origin_type === 'ORDER' && p?.origin_order_number === 'ORD-2026-E2E02',
      `Altweg PC2: eine Rechnungszeile 500 (${inv?.art}), genau EIN Artikel mit Herkunft (${S(inv)} / ${S(p)})`);
    const leg = (await befehle(client)).filter((x) => x.op === 'orders.convert_to_invoice' && x.payload?.orderId === 'co-leg');
    ok(leg.length === 1 && typeof leg[0].payload?.legacyScheme === 'string' && !leg[0].payload?.taxSchemes, `Altweg PC2: EIN Befehl mit der einen Steuerart (${S(leg.map((x) => x.payload))})`);
  }

  // ── 7 PC2 Sonderstück OHNE Kategorie: verständliches Nein vor jedem Schreiben, kein ITM-GEN ─────────────────────
  {
    const stand = () => S({
      p: dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM products')[0]?.n, i: dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoices')[0]?.n,
      sq: dbQ(BIZ_DB, 'SELECT stem, next_number FROM sku_sequences ORDER BY stem'),
      o: dbQ(BIZ_DB, "SELECT product_id, invoice_id, status FROM orders WHERE id = 'co-nocat'"),
      l: dbQ(BIZ_DB, "SELECT product_id, invoice_id, status FROM order_lines WHERE order_id = 'co-nocat'"),
    });
    await spuelen(primary).catch(() => null);
    const vor = stand();
    await gehFrisch(client, '/orders/co-nocat');
    await warteBis(client, "[...document.querySelectorAll('button')].some((b)=>b.textContent.trim()==='Create Invoice')", 40000);
    await clickText(client, 'Create Invoice');
    const dlg = await warteBis(client, "!!document.querySelector('[data-testid=\"order-invoice-date\"]')", 20000);
    const go = await client.ev("const m=[...document.querySelectorAll('[role=\"dialog\"], .fixed')].find((d)=>d.querySelector('[data-testid=\"order-invoice-date\"]')); const b=m && [...m.querySelectorAll('button')].filter((x)=>x.textContent.trim()==='Create Invoice').pop(); if(!b) return 'NO'; if(b.disabled) return 'DISABLED'; b.click(); return 'OK';");
    const meldet = await warteBis(client, "[...document.querySelectorAll('[data-save-error]')].some((d)=>/no category/.test(d.textContent||''))", 30000);
    const text = await client.ev("return [...document.querySelectorAll('[data-save-error]')].map((d)=>d.textContent).join(' | ');");
    await spuelen(primary).catch(() => null);
    await sleep(800);
    ok(dlg && go === 'OK' && meldet && /ITM-GLD/.test(String(text)) && /Nothing was changed/.test(String(text)),
      `Kategorie fehlt PC2: die Maske zeigt das Nein mit Grund (${String(text).slice(0, 200)})`);
    ok(stand() === vor && Number(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM products WHERE sku LIKE 'ITM-GEN%'")[0]?.n ?? 0) === 0,
      `Kategorie fehlt PC2: nichts geschrieben — kein Artikel, keine Rechnung, Zähler unverändert, kein ITM-GEN (${stand() === vor ? 'gleich' : stand()})`);
  }

  // ── 8 PC2 manuelle SKU an der Order + Kategorie ohne SKU-Kürzel: trotzdem Nein, nichts geschrieben ────────────────
  {
    const stand = () => S({
      p: dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM products')[0]?.n, i: dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoices')[0]?.n,
      sq: dbQ(BIZ_DB, 'SELECT stem, next_number FROM sku_sequences ORDER BY stem'),
      o: dbQ(BIZ_DB, "SELECT product_id, invoice_id, status FROM orders WHERE id = 'co-skucat'"),
    });
    await spuelen(primary).catch(() => null);
    const vor = stand();
    await gehFrisch(client, '/orders/co-skucat');
    await warteBis(client, "[...document.querySelectorAll('button')].some((b)=>b.textContent.trim()==='Create Invoice')", 40000);
    await clickText(client, 'Create Invoice');
    const dlg = await warteBis(client, "!!document.querySelector('[data-testid=\"order-invoice-date\"]')", 20000);
    const go = await client.ev("const m=[...document.querySelectorAll('[role=\"dialog\"], .fixed')].find((d)=>d.querySelector('[data-testid=\"order-invoice-date\"]')); const b=m && [...m.querySelectorAll('button')].filter((x)=>x.textContent.trim()==='Create Invoice').pop(); if(!b) return 'NO'; if(b.disabled) return 'DISABLED'; b.click(); return 'OK';");
    const meldet = await warteBis(client, "[...document.querySelectorAll('[data-save-error]')].some((d)=>/not valid for a custom piece/.test(d.textContent||''))", 30000);
    const text = await client.ev("return [...document.querySelectorAll('[data-save-error]')].map((d)=>d.textContent).join(' | ');");
    await spuelen(primary).catch(() => null);
    await sleep(800);
    ok(dlg && go === 'OK' && meldet && /Silver E2E/.test(String(text)) && !/enter a SKU/i.test(String(text)),
      `manuelle SKU PC2: die Kategorie wird trotzdem geprüft — Nein mit Grund (${String(text).slice(0, 200)})`);
    ok(stand() === vor && Number(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM products WHERE sku = 'LAT-E2E-001'")[0]?.n ?? 0) === 0,
      `manuelle SKU PC2: nichts geschrieben, kein Artikel mit der eingetragenen SKU (${stand() === vor ? 'gleich' : stand()})`);
  }

  // ── 9 K4 PC2: Daten eines abgeschlossenen Auftrags korrigieren — nur Datumsfelder, protokolliert, keine Buchung ────────
  {
    await spuelen(primary).catch(() => null);
    const o0 = dbQ(BIZ_DB, `SELECT status, order_date, actual_delivery FROM orders WHERE id = '${ORD}'`)[0];
    const buch = () => S(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n, ROUND(SUM(amount), 3) AS s, MAX(occurred_at) AS m FROM ledger_entries')[0]);
    const buch0 = buch();
    await gehFrisch(client, `/orders/${ORD}`);
    const knopf = await warteBis(client, "!!document.querySelector('[data-order-dates-edit]')", 30000);
    await klick(client, '[data-order-dates-edit]');
    await waitFor(client, '[data-order-dates-form]', 10000);
    const s1 = await setVal(client, '[data-order-dates-order]', '2026-10-24');
    const s2 = await setVal(client, '[data-order-dates-completed]', '2026-10-25');
    const go = await klick(client, '[data-order-dates-save]');
    await spuelen(primary).catch(() => null);
    const gesetzt = await warteAuf(() => {
      const o = dbQ(BIZ_DB, `SELECT order_date, actual_delivery FROM orders WHERE id = '${ORD}'`)[0];
      return o?.order_date === '2026-10-24' && o?.actual_delivery === '2026-10-25';
    }, 30000);
    const aud = dbQ(BIZ_DB, `SELECT field_name, old_value, new_value FROM audit_log WHERE entity_id = '${ORD}' AND field_name IN ('order_date', 'actual_delivery') ORDER BY rowid`);
    ok(knopf && o0?.status === 'completed' && s1 === 'OK' && s2 === 'OK' && go === 'OK' && gesetzt,
      `K4 PC2: „Correct dates\" am abgeschlossenen Auftrag, Auftragsdatum 24.10., Fertigstellung 25.10. (${S(o0)})`);
    ok(buch() === buch0 && aud.length === 2 && aud[0].old_value === String(o0?.order_date) && aud[0].new_value === '2026-10-24',
      `K4 PC2: keine Buchung verschoben, Protokoll alt → neu (${S(aud)})`);
    const cmd = (await befehle(client)).filter((x) => x.op === 'orders.update' && x.payload?.id === ORD);
    ok(cmd.length === 1 && cmd[0].payload?.completedOn === '2026-10-25' && cmd[0].payload?.orderDate === '2026-10-24'
      && Object.keys(cmd[0].payload).sort().join(',') === 'completedOn,expectedRevision,id,orderDate',
      `K4 PC2: EIN orders.update nur mit den Datumsfeldern (${S(cmd.map((x) => x.payload))})`);
    ok((await client.ev('return window.__dbHits.length;')) === 0, 'K4 PC2 greift auf keine lokale Datenbank zu');
  }

  // ── 10 Owner-Regel: umgewandelte Order am PC2 nachträglich korrigieren (Add Cost) — Rechnung folgt, Lager bleibt ───────
  {
    await spuelen(primary).catch(() => null);
    const inv = dbQ(BIZ_DB, `SELECT invoice_id FROM orders WHERE id = '${ORD}'`)[0]?.invoice_id;
    const snap = () => Number(dbQ(BIZ_DB, 'SELECT purchase_price_snapshot AS c FROM invoice_lines WHERE invoice_id = ?', [inv])[0]?.c ?? NaN);
    const s0 = snap(), inv0 = saldo('INVENTORY'), nInv0 = Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoices')[0]?.n);
    await gehFrisch(client, `/orders/${ORD}`);
    await warteBis(client, "!!document.querySelector('[data-order-add-cost-open]')", 30000);
    const r = [await klick(client, '[data-order-add-cost-open]')];
    await warteBis(client, "!!document.querySelector('[data-material-save]')", 10000);
    await sleep(300);
    r.push(await klick(client, '[data-material-kind="labor"]'));
    r.push(await setVal(client, '[data-material-description]', 'PC2 Nacharbeit'));
    r.push(await setVal(client, '[data-material-cost]', '5'));
    r.push(await client.ev("const t=document.querySelector('[data-material-source] [data-ss-trigger]'); if(!t) return 'NO-TRIGGER'; t.click(); return 'OK';"));
    await warteBis(client, "!!document.querySelector('[data-ss-option=\"co-arup\"]')", 15000);
    r.push(await klick(client, '[data-ss-option="co-arup"]'));
    await sleep(250);
    r.push(await klick(client, '[data-material-save]'));
    await spuelen(primary).catch(() => null);
    const gefolgt = await warteAuf(() => Math.abs(snap() - (s0 + 5)) < 0.0005, 30000);
    ok(r.every((x) => x === 'OK') && gefolgt && Math.abs(saldo('INVENTORY') - inv0) < 0.0005
      && Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoices')[0]?.n) === nInv0,
      `Edit nach Rechnung PC2: Add Cost 5 → Einstand der Rechnung ${s0} → ${snap()}, Lager unverändert, keine neue Rechnung (${S(r)})`);
    const cmd = (await befehle(client)).filter((x) => x.op === 'orders.add_cost' && x.payload?.orderId === ORD);
    ok(cmd.length >= 1 && cmd[cmd.length - 1].payload.rows?.[0]?.supplierId === 'co-arup', 'Edit nach Rechnung PC2: EIN orders.add_cost mit der Werkstatt');
    await gehFrisch(client, `/orders/${ORD}`);
    const link = await warteBis(client, "!!document.querySelector('[data-order-change-client]')", 20000);
    await klick(client, '[data-order-change-client]');
    const ziel = await warteBis(client, `location.pathname === '/invoices/${inv}/edit'`, 20000);
    ok(link && ziel, 'Edit nach Rechnung PC2: „Change client" an der Order öffnet die Rechnungskorrektur dieser Rechnung');
  }

  // ── 11 Kostenkorrektur (Owner, ersetzt ORDER_COST_PAID): am PC2 an der umgewandelten Order (FINAL) die Lohnzeile ändern —
  //       unbezahlt ohne Wahl; dann voll bezahlen und senken → Wahl Pflicht, „Claim back" → Rückforderung; Lieferant zeigt
  //       „Record Repayment". Echte Maske, echte Klicks; geprüft in der Datenbank des Primary.
  {
    await spuelen(primary).catch(() => null);
    const inv = dbQ(BIZ_DB, `SELECT invoice_id FROM orders WHERE id = '${ORD}'`)[0]?.invoice_id;
    const snap = () => Number(dbQ(BIZ_DB, 'SELECT purchase_price_snapshot AS c FROM invoice_lines WHERE invoice_id = ?', [inv])[0]?.c ?? NaN);
    const lab = dbQ(BIZ_DB, "SELECT id, expense_id FROM order_lines WHERE order_id = ? AND description = 'PC2 Nacharbeit'", [ORD])[0];
    const ausgabe = () => dbQ(BIZ_DB, 'SELECT amount, paid_amount, status FROM expenses WHERE id = ?', [lab?.expense_id])[0] ?? {};
    const s0 = snap();
    await gehFrisch(client, `/orders/${ORD}`);
    await warteBis(client, `!!document.querySelector('[data-order-cost-edit="${lab?.id}"]')`, 30000);
    const r = [await klick(client, `[data-order-cost-edit="${lab?.id}"]`)];
    await warteBis(client, "!!document.querySelector('[data-order-cost-edit-amount]')", 10000);
    r.push(await setVal(client, '[data-order-cost-edit-amount]', '4'));
    await sleep(250);
    const ohneWahl = await client.ev("return !document.querySelector('[data-order-cost-overpay-choice]') ? 'OK' : 'CHOICE-SHOWN';");
    r.push(await klick(client, '[data-order-cost-edit-save]'));
    await spuelen(primary).catch(() => null);
    const gefolgt = await warteAuf(() => Math.abs(snap() - (s0 - 1)) < 0.0005 && Number(ausgabe().amount) === 4, 30000);
    const cmd1 = (await befehle(client)).filter((x) => x.op === 'orders.remove_cost' && x.payload?.orderId === ORD && x.payload?.newCost !== undefined);
    ok(r.every((x) => x === 'OK') && ohneWahl === 'OK' && gefolgt && Number(ausgabe().paid_amount) === 0,
      `Kostenkorrektur PC2 unbezahlt: 5 → 4 ohne Dialog, Schuld 4, Einstand ${s0} → ${snap()} (${S(r)} / ${S(ausgabe())})`);
    // Voll bezahlen über den A/P-Chip (PayExpenseModal), dann 4 → 3: Überzahlung 1 → Wahl Pflicht.
    await gehFrisch(client, `/orders/${ORD}`);
    await warteBis(client, "!!document.querySelector('button[title=\"Click to record payment for this supplier expense\"]')", 30000);
    // Der Chip in DERSELBEN Zeile (jede Werkstattzeile hat einen) — über den Stift dieser Zeile gefunden.
    const z = [await client.ev(`const e=document.querySelector('[data-order-cost-edit="${lab?.id}"]'); const row=e&&e.parentElement&&e.parentElement.parentElement; const b=row&&row.querySelector('button[title="Click to record payment for this supplier expense"]'); if(!b) return 'NO-CHIP'; b.click(); return 'OK';`)];
    await warteBis(client, "!!document.querySelector('[data-expense-pay-amount]')", 10000);
    z.push(await setVal(client, '[data-expense-pay-amount]', '4'));
    z.push(await klick(client, '[data-expense-pay-method="bank"]'));
    await sleep(200);
    z.push(await klick(client, '[data-expense-pay-save]'));
    await spuelen(primary).catch(() => null);
    const bezahlt = await warteAuf(() => Number(ausgabe().paid_amount) === 4, 30000);
    ok(z.every((x) => x === 'OK') && bezahlt, `Kostenkorrektur PC2: Lohn 4 voll bezahlt (${S(z)} / ${S(ausgabe())})`);
    await gehFrisch(client, `/orders/${ORD}`);
    await warteBis(client, `!!document.querySelector('[data-order-cost-edit="${lab?.id}"]')`, 30000);
    const k = [await klick(client, `[data-order-cost-edit="${lab?.id}"]`)];
    await warteBis(client, "!!document.querySelector('[data-order-cost-edit-amount]')", 10000);
    k.push(await setVal(client, '[data-order-cost-edit-amount]', '3'));
    await warteBis(client, "!!document.querySelector('[data-order-cost-overpay-choice]')", 10000);
    const gesperrt = await client.ev("const b=document.querySelector('[data-order-cost-edit-save]'); return b && b.disabled ? 'OK' : 'NOT-DISABLED';");
    k.push(await klick(client, '[data-order-cost-overpay="refund"]'));
    await sleep(200);
    k.push(await klick(client, '[data-order-cost-edit-save]'));
    await spuelen(primary).catch(() => null);
    const claim = () => dbQ(BIZ_DB, "SELECT amount, status FROM supplier_credits WHERE supplier_id = 'co-arup' AND status IN ('OPEN','REFUND_DUE')");
    const gebucht = await warteAuf(() => claim().length === 1 && claim()[0].status === 'REFUND_DUE' && Number(claim()[0].amount) === 1, 30000);
    ok(k.every((x) => x === 'OK') && gesperrt === 'OK' && gebucht && Math.abs(snap() - (s0 - 2)) < 0.0005 && Number(ausgabe().amount) === 3 && Number(ausgabe().paid_amount) === 4
      && Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM expense_payments WHERE expense_id = ?', [lab?.expense_id])[0]?.n) === 1,
      `Kostenkorrektur PC2 bezahlt 4 → 3: Wahl Pflicht (Speichern gesperrt), „Claim back" → Rückforderung 1, Zahlung bleibt, Einstand ${snap()} (${S(k)} / ${S(claim())})`);
    const cmd2 = (await befehle(client)).filter((x) => x.op === 'orders.remove_cost' && x.payload?.orderId === ORD && x.payload?.newCost !== undefined);
    const c1 = cmd1[cmd1.length - 1]?.payload, c2 = cmd2[cmd2.length - 1]?.payload;
    ok(c1?.newCost === 4 && c1?.overpayChoice === undefined && c2?.newCost === 3 && c2?.overpayChoice === 'refund',
      `Kostenkorrektur PC2: orders.remove_cost mit newCost — erst ohne Wahl, dann mit „refund" (${S([c1, c2])})`);
    await gehFrisch(client, '/suppliers/co-arup');
    const repay = await warteBis(client, "!!document.querySelector('[data-supplier-repay-open]')", 30000);
    ok(repay, 'Kostenkorrektur PC2: Lieferant Arup zeigt die Rückforderung mit „Record Repayment"');
  }
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nCUSTOM-ORDER PC2: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
