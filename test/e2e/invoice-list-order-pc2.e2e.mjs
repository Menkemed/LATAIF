// ════════════════════════════════════════════════════════════════════════════
// INVOICE-LIST-ORDER-PC2 — die Rechnungsübersicht nach dem angezeigten Datum, Primary und PC2 nebeneinander.
// Run: node test/e2e/invoice-list-order-pc2.e2e.mjs
//   (nach `npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e-client.conf.json`,
//    Kopie nach lataif-e2e-client.exe, dann `… --config src-tauri/tauri.e2e.conf.json`)
//
//   1  Primary: 9 Rechnungen, in einer anderen Reihenfolge erfasst, als ihr Datum ist (Entwurf, offen, teilbezahlt,
//      Endrechnung mit späterem Endrechnungsdatum, Altbestand-Endrechnung ohne festgehaltenes Datum, storniert)
//      → „/invoices" zeigt sie nach dem angezeigten Datum, neueste zuerst; gleicher Tag: zuletzt erfasste zuerst.
//   2  PC2: dieselbe Reihenfolge, gelesen vom Primary (store.invoices.get), ohne lokale Datenbank.
//   3  Jeder Statusfilter (echte Maus): Draft, Open, Partial, Final, Returned, Cancelled, All — Reihenfolge bleibt.
//   4  „Correct final date" am PC2 (echte Maus/Tastatur): die Endrechnung wandert an ihren neuen Tag — PC2 und Primary.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat oder was am
// EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids } from './_e2e-process.mjs';
import { maus, mausText, tippe } from './_e2e-mouse.mjs';
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
const OWNER_PW = 'lo-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-listorder', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.'); aufraeumen(); process.exit(1); }, 30 * 60 * 1000);

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
const q = (sel) => `document.querySelector(${S(sel)})`;
const alleOk = (r) => (r.every((x) => x === 'OK') ? 'OK' : r.join(' | '));

// Fernaufträge (Ops) mitschreiben, Dialoge abfangen, Datenbankgriffe ohne Datenbank merken.
const HAKEN = `
  if (!window.__loHaken) {
    window.__loHaken = true; window.__cmds = []; window.__alerts = []; window.__dbHits = [];
    window.alert = (m) => { window.__alerts.push(String(m)); };
    window.confirm = () => true;
    const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
    const oe = console.error; console.error = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); oe(...a); };
    const ow = console.warn; console.warn = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); ow(...a); };
    const of = window.fetch;
    window.fetch = async (...a) => {
      let url = ''; try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
      if (/\\/api\\/command$/.test(url)) { try { const b = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: b.op }); } catch (e) { /* egal */ } }
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

// ══════════════════════════════════════════════════════════════════════════════
// Die Rechnungen. Jede hat einen eigenen Betrag (daran erkennt der Test die Zeile).
//   erfasst = Reihenfolge der Erfassung (created_at), 1 = zuerst.
const RECHNUNGEN = [
  // name  brutto  status       Rechnungstag   erfasst  Endrechnung   Zahlungen [Tag, Betrag]
  ['E9', 1990, 'DRAFT',     '2026-11-19', 1, null,         []],
  ['E1', 1110, 'PARTIAL',   '2026-11-14', 2, null,         []],
  ['E2', 1220, 'PARTIAL',   '2026-11-12', 3, null,         []],
  ['E3', 1330, 'FINAL',     '2026-11-10', 4, '2026-11-17', [['2026-11-17', 1330]]],  // vorläufig 10., Endrechnung 17.
  ['E4', 1440, 'FINAL',     '2026-11-09', 5, '2026-11-16', [['2026-11-16', 1440]]],  // Reparatur-Endrechnung (RINV)
  ['E5', 1550, 'PARTIAL',   '2026-11-15', 6, null,         [['2026-11-18', 500]]],   // teilbezahlt — zeigt den Rechnungstag
  ['E6', 1660, 'PARTIAL',   '2026-11-17', 7, null,         []],
  ['E7', 1770, 'FINAL',     '2026-11-05', 8, null,         [['2026-11-13', 1770]]],  // Altbestand: Tag der Vollzahlung 13.
  ['E8', 1880, 'CANCELLED', '2026-11-11', 9, null,         []],
];
const NAME_VON_BETRAG = new Map(RECHNUNGEN.map((r) => [String(r[1]), r[0]]));
const ID = (name) => 'lo-' + name.toLowerCase();

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
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    insert(db, 'customers', { id: 'lo-kunde', branch_id, first_name: 'Order', last_name: 'Customer', phone: '+973 3600 0303', country: 'BH', language: 'en',
      vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    for (const [name, brutto, status, tag, erfasst, final, zahlungen] of RECHNUNGEN) {
      const id = ID(name), pid = id + '-p';
      insert(db, 'products', { id: pid, branch_id, category_id: 'cat-watch', brand: 'Rolex', name: 'Watch ' + name, sku: pid.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]',
        purchase_price: 900, purchase_currency: 'BHD', planned_sale_price: brutto, stock_status: 'sold', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 0,
        images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: 'lot-' + pid, branch_id, product_id: pid, unit_cost: 900, qty_total: 1, qty_remaining: 0, status: 'EXHAUSTED', acquired_at: now, created_at: now });
      const bezahlt = zahlungen.reduce((s, z) => s + z[1], 0);
      const nummer = status === 'FINAL' ? (name === 'E4' ? 'RINV-2026-LO' : 'INV-2026-LO') + name.slice(1) : 'PINV-2026-LO' + name.slice(1);
      insert(db, 'invoices', { id, branch_id, invoice_number: nummer, customer_id: 'lo-kunde', status, currency: 'BHD',
        net_amount: brutto, vat_rate_snapshot: 0, vat_amount: 0, gross_amount: brutto, tax_scheme_snapshot: 'MARGIN', purchase_price_snapshot: 900,
        sale_price_snapshot: brutto, margin_snapshot: brutto - 900, paid_amount: bezahlt, issued_at: tag,
        created_at: `2026-11-20T08:00:0${erfasst}.000Z`, updated_at: now,
        number_finalized_at: status === 'FINAL' ? (final || zahlungen[zahlungen.length - 1][0]) + 'T12:00:00.000Z' : null,
        final_issued_at: final ? final + 'T12:00:00.000Z' : null });
      insert(db, 'invoice_lines', { id: id + '-l1', invoice_id: id, product_id: pid, lot_id: 'lot-' + pid, quantity: 1, unit_price: brutto,
        purchase_price_snapshot: 900, vat_rate: 0, tax_scheme: 'MARGIN', vat_amount: 0, line_total: brutto, position: 1 });
      zahlungen.forEach(([zt, betrag], i) => {
        const payId = `${id}-pay-${i}`, am = zt + 'T12:00:00.000Z';
        insert(db, 'payments', { id: payId, branch_id, invoice_id: id, amount: betrag, method: 'cash', received_at: am, created_at: am });
        // Die Buchung der Zahlung, wie `postInvoicePayment` sie schreibt (Soll CASH / Haben Forderung) — ohne sie
        // lehnt „Correct final date" zu Recht ab („no live accounting entry").
        const tx = payId + '-tx';
        for (const [konto, richtung] of [['CASH', 'DEBIT'], ['ACCOUNTS_RECEIVABLE', 'CREDIT']]) {
          const nr = Number(db.prepare('SELECT COALESCE(MAX(entry_no), 0) AS n FROM ledger_entries').get().n) + 1;
          insert(db, 'ledger_entries', { id: `${payId}-${richtung}`, branch_id, entry_no: nr, transaction_id: tx, occurred_at: am, recorded_at: am,
            account: konto, direction: richtung, amount: betrag, currency: 'BHD', counterparty_type: 'CUSTOMER', counterparty_id: 'lo-kunde',
            source_module: 'PAYMENT', source_id: payId, metadata_json: JSON.stringify({ invoiceId: id, method: 'cash' }), created_by: 'e2e-seed', created_at: am });
        }
      });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

// Die Liste so lesen, wie sie dasteht: je Zeile Name (am Betrag erkannt), angezeigtes Datum, „provisional …".
const ZEILEN = `return JSON.stringify([...document.querySelectorAll('[data-invoice-list-date]')].map((s) => {
  const zeile = s.parentElement; const kinder = [...zeile.children];
  const betrag = (kinder[4]?.textContent || '').replace(/[^0-9]/g, '');
  return { betrag, datum: (s.childNodes[0]?.textContent || '').trim(), vorl: (s.querySelector('[data-invoice-list-issued]')?.textContent || '').trim() };
}));`;
async function liste(c) {
  const z = JSON.parse(await c.ev(ZEILEN));
  return z.map((x) => ({ ...x, name: NAME_VON_BETRAG.get(x.betrag.slice(0, 4)) || '?' + x.betrag }));
}
const namen = (z) => z.map((x) => x.name).join(',');
async function uebersicht(c, n) {
  await gehFrisch(c, '/invoices');
  await warteBis(c, `document.querySelectorAll('[data-invoice-list-date]').length === ${n}`, 30000);
  await sleep(2000);   // PC2: Zahlungen (page.invoice_list.get) sind da
  return liste(c);
}
async function filter(c, label) {
  const r = await mausText(c, label);
  await sleep(900);
  return { r, z: await liste(c) };
}
async function korrekturOeffnen(c, id) {
  await gehFrisch(c, `/invoices/${id}`);
  if (!(await warteBis(c, q('[data-invoice-correct-final-date]'), 30000))) return 'KEIN-KNOPF';
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

const ALLE = 'E9,E6,E3,E4,E5,E1,E7,E2,E8';
const ALLE_TAGE = '19 Nov 26,17 Nov 26,17 Nov 26,16 Nov 26,15 Nov 26,14 Nov 26,13 Nov 26,12 Nov 26,11 Nov 26';
const FILTER = [
  ['Draft', 'E9'], ['Open', 'E6,E5,E1,E2'], ['Partial', 'E6,E5,E1,E2'], ['Final', 'E3,E4,E7'],
  ['Returned', ''], ['Cancelled', 'E8'], ['All', ALLE],
];

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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'LO Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'LO Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'LO Admin');
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
  ok(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoices')[0]?.n === RECHNUNGEN.length, 'SETUP 9 Rechnungen im Primary');
  const ladefolge = dbQ(BIZ_DB, 'SELECT gross_amount AS g FROM invoices ORDER BY created_at DESC').map((r) => NAME_VON_BETRAG.get(String(r.g))).join(',');
  ok(ladefolge === 'E8,E7,E6,E5,E4,E3,E2,E1,E9', `SETUP Ausgang: die Ladefolge (created_at) ist eine andere (${ladefolge})`);

  // ── 1 Primary ────────────────────────────────────────────────────────────
  const P = await uebersicht(primary, RECHNUNGEN.length);
  console.log('      Primary: ' + namen(P) + '  |  ' + P.map((x) => x.datum).join(', '));
  ok(namen(P) === ALLE, `1 PRIMARY nach dem angezeigten Datum, neueste zuerst (${namen(P)})`);
  ok(P.map((x) => x.datum).join(',') === ALLE_TAGE, `1 PRIMARY die angezeigten Tage fallen (${P.map((x) => x.datum).join(', ')})`);
  ok(/10 Nov 26/.test(P.find((x) => x.name === 'E3')?.vorl || '') && /09 Nov 26/.test(P.find((x) => x.name === 'E4')?.vorl || ''),
    `1 Endrechnungen stehen am Endrechnungsdatum; das vorläufige Datum steht klein darunter (${S(P.filter((x) => x.vorl).map((x) => x.name + ':' + x.vorl))})`);

  // ── 2 PC2 ────────────────────────────────────────────────────────────────
  const C = await uebersicht(client, RECHNUNGEN.length);
  console.log('      PC2:     ' + namen(C) + '  |  ' + C.map((x) => x.datum).join(', '));
  ok(S(C) === S(P), `2 PC2 zeigt DIESELBE Reihenfolge und dieselben Tage wie der Primary (${namen(C)})`);

  // ── 3 Jeder Statusfilter, beide Rechner ──────────────────────────────────
  for (const [c, wer] of [[primary, 'PRIMARY'], [client, 'PC2']]) {
    const fehler = [];
    for (const [label, erwartet] of FILTER) {
      const { r, z } = await filter(c, label);
      if (r !== 'OK' || namen(z) !== erwartet) fehler.push(`${label}: ${r} → ${namen(z) || '(leer)'} statt ${erwartet || '(leer)'}`);
    }
    ok(fehler.length === 0, `3 ${wer} jeder Filter (Draft, Open, Partial, Final, Returned, Cancelled, All) in derselben Reihenfolge${fehler.length ? ' — ' + fehler.join('; ') : ''}`);
  }

  // ── 4 „Correct final date" am PC2: E3 17.11. → 11.11. ────────────────────
  {
    const r1 = await korrekturOeffnen(client, ID('E3'));
    const r2 = r1 === 'OK' ? await korrigieren(client, '2026-11-11', 'closing payment typed wrongly') : 'NICHT-GEÖFFNET';
    await spuelen(primary).catch(() => null);
    const gespeichert = await warteAuf(() => String(dbQ(BIZ_DB, 'SELECT final_issued_at AS f FROM invoices WHERE id = ?', [ID('E3')])[0]?.f || '').slice(0, 10) === '2026-11-11');
    if (!gespeichert) {
      console.log('      Dialog: ' + await client.ev(`return JSON.stringify({ fehler: document.querySelector('[data-save-error]')?.textContent || '', offen: !!document.querySelector('[data-final-date-input]'),
        wert: document.querySelector('[data-final-date-input]')?.value, grund: document.querySelector('[data-final-date-reason]')?.value,
        knopf: document.querySelector('[data-final-date-save]')?.disabled, alerts: window.__alerts });`));
      console.log('      Ops danach: ' + (await befehle(client)).map((x) => x.op).slice(-6).join(','));
      console.log('      DB: ' + S(dbQ(BIZ_DB, 'SELECT final_issued_at, revision, status, number_finalized_at FROM invoices WHERE id = ?', [ID('E3')])) + ' edits=' + S(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoice_edits')));
    }
    ok(r1 === 'OK' && r2 === 'OK' && gespeichert, `4 PC2 berichtigt das Endrechnungsdatum über den Primary (echte Maus/Tastatur) (${r1} / ${r2})`);
    const NACH = 'E9,E6,E4,E5,E1,E7,E2,E8,E3';
    const C2 = await uebersicht(client, RECHNUNGEN.length);
    ok(namen(C2) === NACH, `4 PC2: E3 steht jetzt am 11.11. — gleicher Tag wie E8, die zuletzt erfasste (E8) zuerst (${namen(C2)})`);
    const P2 = await uebersicht(primary, RECHNUNGEN.length);
    ok(namen(P2) === NACH && S(P2) === S(C2), `4 PRIMARY ebenso (${namen(P2)})`);
    ok((await client.ev('return window.__alerts.length;')) === 0, `4 keine Fehlermeldung (${await client.ev('return JSON.stringify(window.__alerts);')})`);
  }
  // PC2 las über den ganzen Lauf vom Primary (die erste Ladung kann schon vor dem Mitschnitt laufen — daher am Ende geprüft).
  const ops = (await befehle(client)).map((x) => x.op);
  ok(ops.includes('store.invoices.get') && ops.includes('page.invoice_list.get') && ops.includes('invoices.correct_final_date'),
    `PC2 liest Rechnungen und Zahlungen vom Primary und berichtigt über ihn (${[...new Set(ops)].filter((o) => /invoice/.test(o)).join(',')})`);
  ok((await client.ev('return window.__dbHits.length;')) === 0, 'PC2 greift auf keine lokale Datenbank zu');
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nINVOICE-LIST-ORDER PC2: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
