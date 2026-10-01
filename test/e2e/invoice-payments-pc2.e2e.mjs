// ════════════════════════════════════════════════════════════════════════════
// INVOICE-PAYMENTS-PC2 — die Zahlungsliste auf der Rechnungsseite, Primary und PC2 nebeneinander.
// Run: node test/e2e/invoice-payments-pc2.e2e.mjs
//
//   Dieselbe Rechnung (zwei eigene Zahlungen, dazu eine Zahlung einer ANDEREN Rechnung desselben
//   Kunden) wird am Primary und am PC2 geöffnet, „PAID" aufgeklappt und „Manage payments" geöffnet.
//   Erwartet: PC2 zeigt genau dieselben rechnungsbezogenen Zahlungen wie der Primary — gelesen vom
//   Primary, nicht aus einer lokalen Quelle. Danach eine Berichtigung am PC2 (Zahlungsart): die Liste
//   am PC2 zeigt sofort den neuen Stand.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat
// oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone } from './_e2e-process.mjs';
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
const OWNER_PW = 'ip-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-invpay', 'run-' + Date.now());
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
const INV = 'ip-inv', ANDERE = 'ip-inv-andere';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const tag = (d) => new Date(Date.parse('2026-09-20T10:00:00.000Z') + d * 86400000).toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    insert(db, 'customers', { id: 'ip-kunde', branch_id, first_name: 'Pay', last_name: 'Customer', phone: '+973 3600 0202', country: 'BH', language: 'en',
      vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    for (const [pid, name] of [['ip-p1', 'Datejust 36'], ['ip-p2', 'Explorer 40']]) {
      insert(db, 'products', { id: pid, branch_id, category_id: 'cat-watch', brand: 'Rolex', name, sku: pid.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]',
        purchase_price: 900, purchase_currency: 'BHD', planned_sale_price: 2000, stock_status: 'sold', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 0,
        images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: 'lot-' + pid, branch_id, product_id: pid, unit_cost: 900, qty_total: 1, qty_remaining: 0, status: 'EXHAUSTED', acquired_at: now, created_at: now });
    }
    const rechnung = (id, nummer, pid, brutto, bezahlt) => {
      insert(db, 'invoices', { id, branch_id, invoice_number: nummer, customer_id: 'ip-kunde', status: bezahlt >= brutto ? 'FINAL' : 'PARTIAL', currency: 'BHD',
        net_amount: brutto, vat_rate_snapshot: 0, vat_amount: 0, gross_amount: brutto, tax_scheme_snapshot: 'MARGIN', purchase_price_snapshot: 900,
        sale_price_snapshot: brutto, margin_snapshot: brutto - 900, paid_amount: bezahlt, issued_at: tag(0), created_at: tag(0), updated_at: now, number_finalized_at: now });
      insert(db, 'invoice_lines', { id: id + '-l1', invoice_id: id, product_id: pid, lot_id: 'lot-' + pid, quantity: 1, unit_price: brutto,
        purchase_price_snapshot: 900, vat_rate: 0, tax_scheme: 'MARGIN', vat_amount: 0, line_total: brutto, position: 1 });
    };
    rechnung(INV, 'INV-2026-IP1', 'ip-p1', 2000, 500);
    rechnung(ANDERE, 'INV-2026-IP2', 'ip-p2', 1500, 1500);
    insert(db, 'payments', { id: 'ip-pay-1', branch_id, invoice_id: INV, amount: 300, method: 'cash', received_at: tag(1), notes: 'Anzahlung bar', created_at: tag(1) });
    insert(db, 'payments', { id: 'ip-pay-2', branch_id, invoice_id: INV, amount: 200, method: 'card', received_at: tag(3), created_at: tag(3) });
    insert(db, 'payments', { id: 'ip-pay-x', branch_id, invoice_id: ANDERE, amount: 1500, method: 'bank_transfer', received_at: tag(2), created_at: tag(2) });
  } finally { try { db.close(); } catch { /* zu */ } }
}

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Einrichten ───────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'IP Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'IP Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'IP Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null); await sleep(1200);
  primary.close(); primary = null;
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
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

  // ── 1 dieselbe Rechnung auf beiden Rechnern ──────────────────────────────
  const P = await zahlungsliste(primary, INV);
  const C = await zahlungsliste(client, INV);
  console.log('      Primary: ' + S(P));
  console.log('      PC2:     ' + S(C));
  ok(P.zeilen?.length === 2 && P.zeilen.map((z) => z.art).join(',') === 'Cash,Card' && /300/.test(P.zeilen[0].betrag) && P.zeilen[0].notiz === 'Anzahlung bar',
    `PRIMARY zeigt die zwei Zahlungen dieser Rechnung (nicht die der anderen) (${S(P.zeilen)})`);
  ok(S(C.zeilen) === S(P.zeilen) && C.paid === P.paid, `PC2 zeigt DIESELBEN Zahlungen wie der Primary (${C.zeilen?.length ?? 0} vs ${P.zeilen?.length ?? 0})`);
  const ops = (await befehle(client)).map((x) => x.op);
  ok(ops.includes('page.invoice_print.get'), `PC2 liest die Zahlungen vom Primary (${[...new Set(ops)].filter((o) => /invoice/.test(o)).join(',')})`);
  ok((await client.ev('return window.__dbHits.length;')) === 0, 'PC2 greift auf keine lokale Datenbank zu');

  // ── 2 „Manage payments": dieselbe Liste ──────────────────────────────────
  const PM = await modalListe(primary);
  const CM = await modalListe(client);
  ok(PM.offen && PM.zeilen.length === 2 && S(CM.zeilen) === S(PM.zeilen), `„Manage payments" auf beiden gleich (${S(PM.zeilen)} | ${S(CM.zeilen)})`);

  // ── 3 Berichtigung am PC2: die Liste zeigt sofort den neuen Stand ────────
  {
    const r = await client.ev(`const m=[...document.querySelectorAll('[role="dialog"], .fixed')].find((d)=>/Payments —/.test(d.textContent||'')); if(!m) return 'KEIN-DIALOG';
      const s=[...m.querySelectorAll('select')][1]; if(!s) return 'KEINE-AUSWAHL';
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'benefit'); s.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
    await spuelen(primary).catch(() => null);
    ok(r === 'OK' && await warteAuf(() => dbQ(BIZ_DB, "SELECT method FROM payments WHERE id = 'ip-pay-2'")[0]?.method === 'benefit'),
      `PC2 berichtigt die Zahlungsart über den Primary (${r})`);
    const ok2 = await warteBis(client, `(() => { const m=[...document.querySelectorAll('[role="dialog"], .fixed')].find((d)=>/Payments —/.test(d.textContent||'')); const s=m && [...m.querySelectorAll('select')][1]; return s && s.value === 'benefit'; })()`, 20000);
    await client.ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 1;");
    await sleep(500);
    const nachher = JSON.parse(await client.ev(LISTE));
    ok(ok2 && nachher.zeilen?.map((z) => z.art).join(',') === 'Cash,Benefit', `PC2 zeigt danach den neuen Stand ohne Neuladen (${S(nachher.zeilen?.map((z) => z.art))})`);
    const P2 = await zahlungsliste(primary, INV);
    ok(P2.zeilen?.map((z) => z.art).join(',') === 'Cash,Benefit', 'PRIMARY ebenso');
  }
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nINVOICE-PAYMENTS PC2: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
