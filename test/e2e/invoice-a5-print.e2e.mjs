// ════════════════════════════════════════════════════════════════════════════
// INVOICE-A5 — der A5-Beleg in zwei echten, isolierten Anwendungen (Primary + PC2).
// Run: node test/e2e/invoice-a5-print.e2e.mjs
//
//   Geprüft über die echten Knöpfe „PDF", „Print" und „Save & Print":
//     • A5 hoch; FINAL → TAX INVOICE, PARTIAL → ADVANCE PAYMENT INVOICE, DRAFT → PROFORMA INVOICE,
//       CANCELLED → Stempel CANCELLED; eine einseitige und eine mehrseitige Rechnung (PDF aus dem
//       gedruckten HTML, Seitenzahl, nichts ragt über die Seitenbreite).
//     • „Save & Print" bucht genau EINE Rechnung (Primary und PC2) und druckt sie.
//     • PC2 druckt dieselben Firmendaten wie der Primary — frisch vom Primary bei jedem Druck: eine
//       Änderung in Settings am Primary gilt am PC2 sofort, ohne Neustart. Ohne Antwort druckt PC2 nicht.
//
//   Der native Druckdialog wird NICHT geöffnet: `print()` des Beleg-Rahmens wird abgefangen und das
//   HTML festgehalten, das gedruckt worden wäre. Alles davor ist der echte Weg der App.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat
// oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224 (+ 9231 für den Kopflos-Browser),
// Datenordner com.lataif.app.e2e(.client). Die installierte Produktions-App und E:\LATAIF\Data
// werden nie berührt, ebenso die Produktions-Ports 3001/3443.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killOwnChild, killStarted, killTestImage, spawnTracked, waitTestImageGone } from './_e2e-process.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, EDGE_CDP = 9231, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'a5-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-a5print', 'run-' + Date.now());
const OUT = join(os.tmpdir(), 'lataif-evidence', 'invoice-a5-e2e');
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
let edgeProc = null;
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); try { if (edgeProc) killOwnChild(edgeProc); } catch { /* weg */ } };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.'); aufraeumen(); process.exit(1); }, 60 * 60 * 1000);

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
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);

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
async function attachOnly(cdpPort, budget = 60000, muster = /tauri\.localhost/) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); page = l.find((t) => t.type === 'page' && muster.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* noch nicht */ }
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
const alleOk = (r) => { const b = r.filter((x) => x !== 'OK'); return b.length ? 'FELD:' + b.join(',') : 'OK'; };
const q = (sel) => `document.querySelector(${S(sel)})`;
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1200); }
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
async function ssPick(c, placeholder, optionId) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 15000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}

// Der Druck-Abgriff: `print()` des Beleg-Rahmens hält das HTML fest, statt den Dialog zu öffnen.
// Er greift am Getter `contentWindow` — genau dort ruft die App `print()` —, damit es keine Rolle
// spielt, ob `document.open()` im Rahmen ein neues Fenster-Objekt anlegt. Dazu: Dialoge und die
// Fernaufträge (wie in den übrigen Zwei-App-Läufen), samt EINER verlorenen Antwort auf Wunsch.
const HAKEN = `
  if (!window.__a5Haken) {
    window.__a5Haken = true; window.__a5Drucke = []; window.__alerts = []; window.__cmds = []; window.__dropNext = null;
    window.alert = (m) => { window.__alerts.push(String(m)); };
    window.confirm = () => true;
    const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, get() {
      const w = d.get.call(this);
      if (!w || this.id !== 'lataif-invoice-a5') return w;
      const el = this;
      return new Proxy(w, { get(t, k) {
        if (k === 'print') return () => { const dd = el.contentDocument; window.__a5Drucke.push({ at: Date.now(), url: location.pathname + location.search, mode: dd.compatMode, html: (dd.doctype ? '<!DOCTYPE ' + dd.doctype.name + '>' : '') + dd.documentElement.outerHTML }); };
        const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
      } });
    } });
    const of = window.fetch;
    window.fetch = async (...a) => {
      let url = ''; try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
      let body = null;
      if (/\\/api\\/command$/.test(url)) { try { body = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: body.op, commandId: body.commandId }); } catch (e) { /* egal */ } }
      if (body && window.__dropNext && body.op === window.__dropNext) { window.__dropNext = null; throw new TypeError('A5: simulated network failure'); }
      return of(...a);
    };
  }
`;
async function hakenLegen(c) {
  await c.send('Page.enable', {});
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: HAKEN });
  await c.ev(HAKEN + ' return 1;');
}
const drucke = (c) => c.ev('return JSON.stringify(window.__a5Drucke || []);').then((s) => JSON.parse(s || '[]'));
const befehle = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
async function neuerDruck(c, vorher, t = 20000) {
  const end = Date.now() + t;
  while (Date.now() < end) { const d = await drucke(c); if (d.length > vorher) return d[d.length - 1]; await sleep(250); }
  return null;
}
async function druckeUeber(c, invId, knopf) {
  await gehFrisch(c, `/invoices/${invId}`);
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='PDF')", 30000))) return { fehler: 'KEIN-PDF-KNOPF' };
  await sleep(800);   // Artikel/Kunde geladen (PC2: vom Primary)
  const vorher = (await drucke(c)).length;
  const r = await clickText(c, knopf);
  if (r !== 'OK') return { fehler: r };
  const d = await neuerDruck(c, vorher);
  return d ? { html: d.html, url: d.url, mode: d.mode } : { fehler: 'KEIN-DRUCK' };
}

// ── Firmendaten im gedruckten HTML ──────────────────────────────────────────
const titel = (h) => (/<h1>([^<]*)<\/h1>/.exec(h) || [])[1] || '';
const firma = (h) => ({
  cr: (/<b>CR No\.:<\/b>\s*([^\s|<&]+)/.exec(h) || [])[1] || '',
  vat: (/<b>VAT No\.:<\/b>\s*([^\s|<&]+)/.exec(h) || [])[1] || '',
  insta: h.includes('@e2e_insta'), phone: h.includes('+973 1111 2222'), terms: h.includes('E2E terms: goods remain ours.'),
  mail: h.includes('lataifwll@gmail.com'),
});
const zahlart = (h) => (/Payment Mode<\/th><td class="colon">:<\/td><td>([^<]*)<\/td>/.exec(h) || [])[1] || '';

// ── PDF und Breite aus dem gedruckten HTML (kopfloser Edge, eigener Profilordner je Aufruf) ──
function pdfAus(html, name) {
  mkdirSync(OUT, { recursive: true });
  const hf = join(OUT, name + '.html'), pf = join(OUT, name + '.pdf');
  writeFileSync(hf, html);
  rmSync(pf, { force: true });
  execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer', `--user-data-dir=${join(RUN, 'edge-pdf-' + name)}`,
    `--print-to-pdf=${pf}`, pathToFileURL(hf).href], { stdio: 'ignore', timeout: 90000 });
  const pdf = readFileSync(pf).toString('latin1');
  return { file: pf, seiten: (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length, box: ((/\/MediaBox\s*\[([^\]]*)\]/.exec(pdf) || [])[1] || '').trim() };
}
let kopflos = null;
async function breitenPruefung(name) {
  if (!kopflos) {
    edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(RUN, 'edge-cdp')}`, `--remote-debugging-port=${EDGE_CDP}`, 'about:blank'], { stdio: 'ignore' });
    kopflos = await attachOnly(EDGE_CDP, 40000, /^about:blank|^file:/);
    await kopflos.send('Page.enable');
  }
  // A5 hoch, 8 mm Rand links und rechts → 132 mm Inhalt ≈ 499 CSS-Pixel.
  await kopflos.send('Emulation.setDeviceMetricsOverride', { width: 499, height: 700, deviceScaleFactor: 1, mobile: false });
  await kopflos.send('Emulation.setScrollbarsHidden', { hidden: true });
  await kopflos.send('Emulation.setEmulatedMedia', { media: 'print' });
  await kopflos.send('Page.navigate', { url: pathToFileURL(join(OUT, name + '.html')).href });
  await sleep(1500);
  return kopflos.ev(`const w = document.documentElement.clientWidth;
    const teile = ['table.items', '.sum', '.terms', '.sign', '.foot', '.head'].map((s) => [s, document.querySelector(s)]);
    return JSON.stringify({ w, scroll: document.documentElement.scrollWidth,
      fehlt: teile.filter(([, e]) => !e).map(([s]) => s),
      zuBreit: teile.filter(([, e]) => e && e.getBoundingClientRect().right > w + 0.5).map(([s, e]) => s + ':' + Math.round(e.getBoundingClientRect().right)) });`).then((s) => JSON.parse(s));
}

// ══════════════════════════════════════════════════════════════════════════════
// Die Welt des Laufs
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
const INV = { final: 'a5-inv-final', partial: 'a5-inv-partial', draft: 'a5-inv-draft', cancel: 'a5-inv-cancel', lang: 'a5-inv-lang' };
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const setze = (key, value) => db.prepare(`INSERT INTO settings (branch_id, key, value, category, updated_at) VALUES (?, ?, ?, 'company', ?)
      ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(branch_id, key, value, now);
    setze('company.cr_number', 'E2E-CR-1'); setze('company.instagram', 'e2e_insta');
    setze('invoice.terms', 'E2E terms: goods remain ours.'); setze('company.phone', '+973 1111 2222');
    for (const [id, name] of [['cat-watch', 'Watch'], ['cat-gold-jewelry', 'Gold-Diamond Jewellery']]) {
      if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(id)) {
        insert(db, 'categories', { id, branch_id, name, icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
      }
    }
    insert(db, 'customers', { id: 'a5-kunde', branch_id, first_name: 'Test', last_name: 'Customer', phone: '+973 3600 0101', country: 'BH', language: 'en',
      vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    const produkt = (id, cat, brand, name, attrs, verkauft, preis = 1300) => {
      insert(db, 'products', { id, branch_id, category_id: cat, brand, name, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]',
        purchase_price: 900, purchase_currency: 'BHD', planned_sale_price: preis, stock_status: verkauft ? 'sold' : 'in_stock', tax_scheme: 'MARGIN',
        days_in_stock: 0, quantity: verkauft ? 0 : 1, images: '[]', attributes: JSON.stringify(attrs), source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: 'lot-' + id, branch_id, product_id: id, unit_cost: 900, qty_total: 1, qty_remaining: verkauft ? 0 : 1,
        status: verkauft ? 'EXHAUSTED' : 'ACTIVE', acquired_at: now, created_at: now });
    };
    const uhr = { reference_number: '126300', serial_number: 'M0W65666', case_diameter_mm: 41, dial: 'Green Mint', bezel: 'Smooth', material: 'Two-Tone Steel/Gold', karat_color: '18K Yellow' };
    produkt('a5-w', 'cat-watch', 'Rolex', 'Datejust 41', uhr, true);
    produkt('a5-g', 'cat-gold-jewelry', '', '', { item_type: 'Ring', description: 'DOUBLE RING', karat: '18K White', weight: 2.92, diamond_weight: 0.14 }, true, 700);
    for (let i = 1; i <= 14; i++) produkt('a5-l' + i, 'cat-watch', 'Omega', 'Constellation ' + i, { ...uhr, serial_number: 'L' + (1000 + i) }, true, 500 + i);
    produkt('a5-sp', 'cat-watch', 'Tudor', 'Black Bay 58', { reference_number: 'M79030N', dial: 'Black', material: 'Steel' }, false, 4200);
    produkt('a5-sp2', 'cat-watch', 'Tudor', 'Pelagos 39', { reference_number: 'M25407N', dial: 'Black', material: 'Titanium' }, false, 5100);

    const rechnung = (id, nummer, status, zeilen, bezahlt, methode) => {
      const brutto = zeilen.reduce((s, [, p]) => s + p, 0);
      insert(db, 'invoices', { id, branch_id, invoice_number: nummer, customer_id: 'a5-kunde', status, currency: 'BHD', net_amount: brutto, vat_rate_snapshot: 0,
        vat_amount: 0, gross_amount: brutto, tax_scheme_snapshot: 'MARGIN', purchase_price_snapshot: 900 * zeilen.length, sale_price_snapshot: brutto,
        margin_snapshot: brutto - 900 * zeilen.length, paid_amount: bezahlt, issued_at: now, created_at: now, updated_at: now,
        ...(status === 'DRAFT' ? {} : { number_finalized_at: now }) });
      zeilen.forEach(([pid, preis], i) => insert(db, 'invoice_lines', { id: id + '-l' + i, invoice_id: id, product_id: pid, lot_id: 'lot-' + pid, quantity: 1,
        unit_price: preis, purchase_price_snapshot: 900, vat_rate: 0, tax_scheme: 'MARGIN', vat_amount: 0, line_total: preis, position: i + 1 }));
      if (bezahlt > 0) insert(db, 'payments', { id: id + '-pay', branch_id, invoice_id: id, amount: bezahlt, method: methode, received_at: now, created_at: now });
    };
    rechnung(INV.final, 'INV-2026-A51', 'FINAL', [['a5-w', 1300]], 1300, 'cash');
    rechnung(INV.partial, 'INV-2026-A52', 'PARTIAL', [['a5-w', 1300], ['a5-g', 700]], 500, 'card');
    rechnung(INV.draft, 'DRAFT-A53', 'DRAFT', [['a5-g', 700]], 0, 'cash');
    rechnung(INV.cancel, 'INV-2026-A54', 'CANCELLED', [['a5-g', 700]], 0, 'cash');
    rechnung(INV.lang, 'INV-2026-A55', 'FINAL', Array.from({ length: 14 }, (_, i) => ['a5-l' + (i + 1), 501 + i]), 7091, 'bank');
  } finally { try { db.close(); } catch { /* zu */ } }
}

let primary = null, client = null;
async function rechnungMaske(c, pid) {
  await gehFrisch(c, '/invoices/new');
  if (!(await warteBis(c, q('[data-ss-trigger="Search clients..."]'), 30000))) return 'KEINE-MASKE';
  const r = [await ssPick(c, 'Search clients...', 'a5-kunde'), await ssPick(c, 'Pick product...', pid)];
  await sleep(600);
  r.push(await klick(c, '[data-invoice-pay-method="cash"]'));
  r.push(await klick(c, '[data-invoice-pay-full]'));
  await sleep(400);
  r.push(await klick(c, '[data-invoice-save-print]'));
  await sleep(800);
  if (await warteBis(c, q('[data-final-number-confirm]'), 15000)) {
    r.push(await klick(c, '[data-final-number-normal]')); await sleep(250);
    r.push(await klick(c, '[data-final-number-confirm]'));
  }
  return alleOk(r);
}

try {
  assertE2eClientBinary(CLIENT_APP);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Einrichten: Onboarding, dann die Welt säen ───────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'A5 Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'A5 Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'A5 Admin');
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

  // ── 1 Primary: PDF / Print je Status ─────────────────────────────────────
  const P = {};
  for (const [k, id] of Object.entries(INV)) {
    const d = await druckeUeber(primary, id, 'PDF');
    ok(!!d.html && d.mode === 'CSS1Compat' && d.html.startsWith('<!DOCTYPE html>'), `PRIMARY „PDF" druckt ${k} — Standardmodus mit Doctype (${d.fehler || d.mode})`);
    P[k] = d.html || '';
  }
  ok(/@page \{ size: A5 portrait;/.test(P.final), 'PRIMARY A5 hoch');
  ok(titel(P.final) === 'TAX INVOICE', `PRIMARY FINAL → TAX INVOICE (${titel(P.final)})`);
  ok(titel(P.partial) === 'ADVANCE PAYMENT INVOICE', `PRIMARY PARTIAL → ADVANCE PAYMENT INVOICE (${titel(P.partial)})`);
  ok(titel(P.draft) === 'PROFORMA INVOICE', `PRIMARY DRAFT → PROFORMA INVOICE (${titel(P.draft)})`);
  ok(/<div class="stamp">CANCELLED<\/div>/.test(P.cancel) && !/<div class="stamp">/.test(P.final), 'PRIMARY CANCELLED → Stempel CANCELLED (nur dort)');
  {
    const f = firma(P.final);
    ok(f.cr === 'E2E-CR-1' && f.vat === '220015625500002' && f.insta && f.phone && f.terms && f.mail,
      `PRIMARY Firmendaten aus Settings (CR ${f.cr}, VAT ${f.vat}, Instagram ${f.insta}, Telefon ${f.phone}, Terms ${f.terms})`);
    ok(zahlart(P.final) === 'Cash' && /Card/.test(zahlart(P.partial)) && /Credit/.test(zahlart(P.partial)),
      `PRIMARY Zahlungsart aus den Zahlungen (${zahlart(P.final)} | ${zahlart(P.partial)})`);
    ok(/18K Yellow Gold/.test(P.final) && /Double Ring · 18K White Gold · 2\.92 g|<span class="nw">18K White Gold<\/span>/.test(P.partial),
      'PRIMARY Gold-Anzeige „18K … Gold" in Angaben und Namen');
    ok(/data:image\/png;base64,/.test(P.final), 'PRIMARY Emblem und Schriftzüge sind eingebettet');
  }
  {
    const d = await druckeUeber(primary, INV.final, 'Print');
    ok(!!d.html && titel(d.html) === 'TAX INVOICE' && firma(d.html).cr === 'E2E-CR-1', `PRIMARY „Print" druckt denselben A5-Beleg (${d.fehler || 'ok'})`);
  }
  // Einseitig und mehrseitig: PDF aus genau dem gedruckten HTML, nichts ragt über die Seite.
  for (const [k, soll] of [['final', 1], ['partial', 1], ['cancel', 1], ['lang', 2]]) {
    const p = pdfAus(P[k], 'primary-' + k);
    ok(p.seiten === soll && /^0 0 4(19\.\d+|20) 59(4\.\d+|5)$/.test(p.box), `PDF ${k}: ${p.seiten} Seite(n), erwartet ${soll}; A5 (${p.box})`);
    const b = await breitenPruefung('primary-' + k);
    ok(b.fehlt.length === 0 && b.zuBreit.length === 0 && b.scroll <= b.w + 1,
      `PDF ${k}: Tabelle, Summen, Terms, Unterschriften und Fußzeile vollständig in der Seitenbreite (${S(b)})`);
  }

  // ── 2 Primary: Save & Print — genau eine Buchung ─────────────────────────
  {
    const vorInv = zahl('SELECT COUNT(*) n FROM invoices'), vorPay = zahl('SELECT COUNT(*) n FROM payments'), vorLed = zahl('SELECT COUNT(*) n FROM ledger_entries');
    const vorDruck = (await drucke(primary)).length;
    const m = await rechnungMaske(primary, 'a5-sp');
    const d = await neuerDruck(primary, vorDruck, 30000);
    await spuelen(primary).catch(() => null);
    const neu = dbQ(BIZ_DB, "SELECT i.id, i.invoice_number, i.status FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id WHERE l.product_id = 'a5-sp'");
    ok(m === 'OK' && !!d, `SAVE&PRINT Primary: angelegt und gedruckt (${m}; Druck ${!!d})`);
    ok(neu.length === 1 && zahl('SELECT COUNT(*) n FROM invoices') === vorInv + 1 && zahl('SELECT COUNT(*) n FROM payments') === vorPay + 1,
      `SAVE&PRINT Primary: genau EINE Rechnung und EINE Zahlung (${neu.length}; +${zahl('SELECT COUNT(*) n FROM invoices') - vorInv}/+${zahl('SELECT COUNT(*) n FROM payments') - vorPay})`);
    ok(!!d && titel(d.html) === 'TAX INVOICE' && d.html.includes('Tudor Black Bay 58') && firma(d.html).cr === 'E2E-CR-1', 'SAVE&PRINT Primary: der Druck zeigt genau diese Rechnung');
    const nachLed = zahl('SELECT COUNT(*) n FROM ledger_entries');
    // Nachladen der Seite: kein zweiter Druck, keine zweite Buchung.
    // Dieselbe Verbindung: der Abgriff liegt per addScriptToEvaluateOnNewDocument schon im neuen Dokument.
    await primary.send('Page.reload', {}); await sleep(4000);
    await waitFor(primary, SHELL, 60000); await sleep(2500);
    ok((await drucke(primary)).length === 0 && !(await primary.ev('return location.search.includes("print=1");')),
      'SAVE&PRINT Primary: nach Neuladen kein zweiter Druck (print=1 ist weg)');
    await spuelen(primary).catch(() => null);
    ok(zahl('SELECT COUNT(*) n FROM invoices') === vorInv + 1 && zahl('SELECT COUNT(*) n FROM ledger_entries') === nachLed && nachLed > vorLed,
      `SAVE&PRINT Primary: keine Doppelbuchung (Hauptbuch +${nachLed - vorLed}, danach unverändert)`);
  }

  // ── 3 PC2 verbinden ──────────────────────────────────────────────────────
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
  ok(true, 'CONNECT frischer PC2 ohne Datenbank, Anmeldung');

  // ── 4 PC2 druckt dieselben Firmendaten wie der Primary ───────────────────
  {
    const C = {};
    for (const k of ['final', 'partial', 'lang']) {
      const d = await druckeUeber(client, INV[k], k === 'partial' ? 'Print' : 'PDF');
      ok(!!d.html, `PC2 druckt ${k} (${d.fehler || 'ok'})`);
      C[k] = d.html || '';
    }
    ok(S(firma(C.final)) === S(firma(P.final)) && firma(C.final).cr === 'E2E-CR-1', `PC2 dieselben Firmendaten wie der Primary (${S(firma(C.final))})`);
    ok(zahlart(C.final) === zahlart(P.final) && zahlart(C.partial) === zahlart(P.partial), `PC2 dieselbe Zahlungsart (${zahlart(C.final)} | ${zahlart(C.partial)})`);
    ok(titel(C.partial) === 'ADVANCE PAYMENT INVOICE' && titel(C.final) === 'TAX INVOICE', 'PC2 dieselben Titel je Status');
    const gleich = ['final', 'partial', 'lang'].filter((k) => C[k] === P[k]);
    ok(gleich.length === 3, `PC2 der gedruckte Beleg ist zeichengleich mit dem des Primary (${gleich.join(',') || 'keiner'})`);
    const ops = (await befehle(client)).map((x) => x.op);
    ok(ops.filter((o) => o === 'page.invoice_print.get').length >= 3, `PC2 fragt bei JEDEM Druck den Primary (${ops.filter((o) => o === 'page.invoice_print.get').length}×)`);
    ok(!existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'PC2 hat keine Geschäftsdatenbank');
  }

  // ── 5 Änderung in Settings am Primary gilt am PC2 sofort ─────────────────
  {
    await gehFrisch(primary, '/settings?tab=company');
    const r = [];
    if (await warteBis(primary, q('[data-invoice-setting="crNumber"]'), 20000)) {
      r.push(await setVal(primary, '[data-invoice-setting="crNumber"]', 'E2E-CR-2'));
      await sleep(300);
      r.push(await clickText(primary, 'Save Changes'));
    } else r.push('KEIN-FELD');
    await spuelen(primary).catch(() => null);
    ok(await warteAuf(() => dbQ(BIZ_DB, "SELECT value FROM settings WHERE key = 'company.cr_number'")[0]?.value === 'E2E-CR-2'),
      `SETTINGS am Primary geändert (${alleOk(r)})`);
    const d = await druckeUeber(client, INV.final, 'PDF');
    ok(!!d.html && firma(d.html).cr === 'E2E-CR-2' && !d.html.includes('E2E-CR-1'), `PC2 druckt sofort die NEUE CR No. — ohne Neustart, ohne Release (${d.html ? firma(d.html).cr : d.fehler})`);
    const dp = await druckeUeber(primary, INV.final, 'PDF');
    ok(!!dp.html && firma(dp.html).cr === 'E2E-CR-2', 'PRIMARY ebenso');
  }

  // ── 6 PC2 ohne Antwort vom Primary: kein Druck mit alten Werten ──────────
  {
    await gehFrisch(client, `/invoices/${INV.final}`);
    await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='PDF')", 30000);
    await sleep(800);
    const vorD = (await drucke(client)).length, vorA = await client.ev('return window.__alerts.length;');
    await client.ev("window.__dropNext = 'page.invoice_print.get'; return 1;");
    await clickText(client, 'PDF');
    await sleep(3000);
    const alerts = await client.ev('return JSON.stringify(window.__alerts);').then((s) => JSON.parse(s));
    ok((await drucke(client)).length === vorD && alerts.length === vorA + 1 && /company information could not be loaded/i.test(alerts[alerts.length - 1] || ''),
      `PC2 ohne Antwort: kein Druck, klare Meldung (${alerts[alerts.length - 1] || 'keine'})`);
  }

  // ── 7 PC2: Save & Print — genau eine Buchung, Druck mit den Daten des Primary ──
  {
    const vorInv = zahl('SELECT COUNT(*) n FROM invoices'), vorPay = zahl('SELECT COUNT(*) n FROM payments');
    const vorDruck = (await drucke(client)).length, vorCmds = (await befehle(client)).length;
    const m = await rechnungMaske(client, 'a5-sp2');
    const d = await neuerDruck(client, vorDruck, 40000);
    await spuelen(primary).catch(() => null);
    const creates = (await befehle(client)).slice(vorCmds).filter((x) => x.op === 'invoices.create');
    const neu = dbQ(BIZ_DB, "SELECT i.id FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id WHERE l.product_id = 'a5-sp2'");
    ok(m === 'OK' && !!d, `SAVE&PRINT PC2: angelegt und gedruckt (${m}; Druck ${!!d})`);
    ok(creates.length === 1 && neu.length === 1 && zahl('SELECT COUNT(*) n FROM invoices') === vorInv + 1 && zahl('SELECT COUNT(*) n FROM payments') === vorPay + 1,
      `SAVE&PRINT PC2: genau EIN invoices.create, EINE Rechnung, EINE Zahlung (${creates.length}/${neu.length})`);
    ok(!!d && titel(d.html) === 'TAX INVOICE' && d.html.includes('Tudor Pelagos 39') && firma(d.html).cr === 'E2E-CR-2', 'SAVE&PRINT PC2: der Druck zeigt diese Rechnung mit den aktuellen Firmendaten');
    await sleep(3000);
    ok((await drucke(client)).length === vorDruck + 1 && zahl('SELECT COUNT(*) n FROM invoices') === vorInv + 1, 'SAVE&PRINT PC2: kein zweiter Druck, keine zweite Rechnung');
  }
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  try { kopflos?.close(); } catch { /* zu */ }
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nINVOICE-A5 print (Primary + PC2): ${PASS} passed, ${FAIL} failed — Nachweise: ${OUT}`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
