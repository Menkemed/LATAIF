// ════════════════════════════════════════════════════════════════════════════
// REPAIR-PREVIEW-ABNAHME — die freigegebene Vorschau A–G gegen die laufende Test-App, mit echten Maus- und
// Tastatureingaben (`_e2e-mouse.mjs`): ein Klick geht nur hinaus, wenn das Element sichtbar und nicht verdeckt ist.
// Run: node test/e2e/repair-preview-acceptance.e2e.mjs
//
//   F   New Repair „Who does the work?": an-/abwählen, Felder erscheinen, nichts geht verloren, Validierung,
//       Speichern und erneutes Öffnen (Primary und PC2).
//   A   Liste: Filter, Suche, Rechnungsstatus, Kostenaufteilung, Quick Edit.
//   BCD Quick Edit: Arbeit, Material, Beträge, Kosten, Close/Save.
//   G   Detailseite: Quick Edit, Statusschritte, Gruppen, Summen, Altgebühr, geplante Werkstatt, „Not set".
//   BUCH Kosten und Buchungen: je Zeile genau eine Verbindlichkeit, eigene Arbeit 0.000 bucht nichts.
//   E   Handy: Filter, Karten, Gruppen, Summen, Add Work.
//   COLL Collection: Verkaufs- und Mindestpreis direkt an der Karte (Primary, PC2), Einkaufskosten unberührt.
//
// PROZESS-ISOLATION wie in allen Läufen: nur `spawnTracked`, Test-Kennung, Port 3011, nie die Produktion.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import {
  killStarted, killTestImage, killTestPid, killOwnChild, spawnTracked, waitTestImageGone,
  startedPids, waitPidGone,
} from './_e2e-process.mjs';
import { edgeBrowserEndpoint, closeEdge, waitEdgeProfileGone } from './_e2e-browser.mjs';
import { maus, mausText, tippe, waehle, sichtbar } from './_e2e-mouse.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const EDGE_CDP = 9700 + Math.floor(Math.random() * 280);
const BASE = `http://127.0.0.1:${PORT}`;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'preview-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const RUN = join(os.tmpdir(), 'lataif-repair-preview', 'run-' + Date.now());
const EDGE_PROFILE = join(RUN, 'edge-profile');
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const CLIENT_LOCAL_STATE = join(REAL_LOCALAPPDATA, CLIENT_IDENT);

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();
let edgeProc = null, edgeBrowserWs = '';
async function edgeSchliessen() { if (await closeEdge(edgeBrowserWs, EDGE_CDP)) edgeBrowserWs = ''; return !edgeBrowserWs; }
const aufraeumen = () => {
  try { killOwnChild(edgeProc); } catch { /* schon weg */ }
  killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe');
};
const WACHHUND = setTimeout(async () => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht.');
  await edgeSchliessen(); aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  process.exit(1);
}, 30 * 60 * 1000);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env, APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'), LATAIF_E2E_SYNC_PORT: String(PORT),
});
function dbQ(sql, params = []) {
  let db;
  try { db = new DatabaseSync(BIZ_DB, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.fehler = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') this.fehler.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 300));
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}, ms = 180000) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method}: keine Antwort`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}
async function attachOnly(cdpPort, match, budget = 120000) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && match.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(400);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function attachApp(cdpPort, exe, env) {
  spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, /tauri\.localhost/);
}
const q = (sel) => `document.querySelector(${S(sel)})`;
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; b.click(); return 'OK';`);
const text = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.textContent.trim() : '';`);
const wert = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.value : null;`);
async function warteBis(c, expr, budget = 30000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    try { if (await c.ev(`return !!(${expr});`)) return true; } catch { /* Seite baut noch */ }
    await sleep(300);
  }
  return false;
}
const waitFor = (c, sel, budget = 45000) => warteBis(c, q(sel), budget);
async function warteAuf(pruef, sekunden = 30) {
  for (let i = 0; i < sekunden * 2; i++) { if (pruef()) return true; await sleep(500); }
  return false;
}
const waitInvoke = (c) => warteBis(c, 'window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke', 120000);
const zahl = (s) => { const n = parseFloat(String(s).replace(/,/g, '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; };
const foto = async (c, name) => { try { const p = await c.send('Page.captureScreenshot', { format: 'png' }, 30000); writeFileSync(join(RUN, name + '.png'), Buffer.from(p.data, 'base64')); } catch (e) { console.log('      (Foto) ' + String(e)); } };

const STUB = `window.alert = () => {}; window.confirm = () => true;`;

// ── Bestand ──
function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const namen = spalten.map((r) => r.name);
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk || daten[sp.name] !== undefined) continue;
    daten[sp.name] = /INT|REAL|NUM/.test(String(sp.type).toUpperCase()) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => namen.includes(k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k]));
}
function seedDaten() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const branch_id = db.prepare('SELECT id FROM branches LIMIT 1').get().id;
    const now = new Date().toISOString();
    insert(db, 'suppliers', { id: 'ws-a', branch_id, name: 'Werkstatt A', active: 1, is_workshop: 1, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'ws-b', branch_id, name: 'Werkstatt B', active: 1, is_workshop: 1, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'mat', branch_id, name: 'Gold Lieferant', active: 1, is_workshop: 0, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'e2e-kunde', branch_id, first_name: 'E2E', last_name: 'Kunde', phone: '+97338100000', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'purchases', { id: 'e2e-pur', branch_id, purchase_number: 'PUR-E2E-1', supplier_id: 'mat', status: 'PAID', purchase_date: '2026-10-29', total_amount: 1000, paid_amount: 1000, created_at: now, updated_at: now });
    let pos = 0;
    for (const id of ['kauf', 'kauf2', 'kom', 'eigen']) {
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Tudor', name: 'Black Bay ' + id, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_date: '2026-10-29', purchase_price: 500, purchase_currency: 'BHD', quantity: 1, stock_status: 'in_stock', source_type: id === 'kom' ? 'CONSIGNMENT' : 'OWN', tax_scheme: 'MARGIN', images: '[]', attributes: JSON.stringify({ dial: 'Black', material: 'Steel' }), created_at: now, updated_at: now });
      if (id === 'kom') continue;
      pos += 1;
      insert(db, 'purchase_lines', { id: 'pl-' + id, purchase_id: 'e2e-pur', product_id: id, quantity: 1, unit_price: 500, line_total: 500, position: pos, tax_scheme: 'ZERO', vat_rate: 0, vat_amount: 0, created_product: 1 });
      insert(db, 'stock_lots', { id: 'lot-' + id, branch_id, product_id: id, purchase_id: 'e2e-pur', purchase_line_id: 'pl-' + id, unit_cost: 500, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: '2026-10-29', created_at: now });
    }
    const alt = { branch_id, images: '[]', item_attributes: '{}', revision: 1, repair_scope: 'CUSTOMER', customer_id: 'e2e-kunde', tax_scheme: 'ZERO', item_brand: 'Omega', item_model: 'De Ville', received_at: now, created_at: now, updated_at: now };
    // Eine Werkstatt mit Gebühr, ohne Zeile: sie bleibt beim Start, wie sie ist (siehe G und repair-legacy-fee.e2e).
    insert(db, 'repairs', { ...alt, id: 'alt-gebuehr', repair_number: 'REP-ALT-1', voucher_code: 'ALT1', issue_description: 'Service', status: 'received', repair_type: 'external', workshop_supplier_id: 'ws-b', estimated_cost: 18, charge_to_customer: 35 });
    insert(db, 'repairs', { ...alt, id: 'alt-polish', repair_number: 'REP-ALT-2', voucher_code: 'ALT2', issue_description: 'Polish', status: 'picked_up', repair_type: 'internal', charge_to_customer: 25 });
  } finally { db.close(); }
}

const rep = (id) => dbQ('SELECT repair_number nr, repair_type typ, status, workshop_supplier_id ws, planned_workshop_supplier_id plan, planned_work_type planArt, estimated_cost est, internal_cost own, actual_cost ist, charge_to_customer preis, margin FROM repairs WHERE id = ?', [id])[0] || {};
const zeilen = (id) => dbQ("SELECT id, supplier_id ws, work_type art, cost_amount kosten, material_kind mat, description txt FROM repair_lines WHERE repair_id = ? AND status = 'OPEN' ORDER BY position", [id]);
const ausgaben = (id) => dbQ("SELECT id, amount, supplier_id ws, status FROM expenses WHERE (related_module = 'repair' AND related_entity_id = ?) OR id IN (SELECT expense_id FROM repair_lines WHERE repair_id = ?)", [id, id]);
const artikel = (id) => dbQ('SELECT planned_sale_price vk, min_sale_price mind, purchase_price ek, expected_margin marge FROM products WHERE id = ?', [id])[0] || {};
const belege = () => S(['purchases', 'purchase_lines', 'stock_lots', 'ledger_entries', 'expenses'].map((t) => dbQ(`SELECT * FROM ${t} ORDER BY rowid`)));
const offeneDateien = () => { const d = join(CLIENT_LOCAL_STATE, 'pending-saves'); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).length : 0; };
const anzahlReparaturen = () => Number(dbQ('SELECT COUNT(*) n FROM repairs')[0]?.n || 0);

// ── Maske „New Repair" ──
const I = '[data-repair-create-inhouse]', E = '[data-repair-create-external]';
const I_TYP = '[data-repair-create-inhouse-type]', I_KOST = '[data-repair-create-inhouse-cost]';
const E_TYP = '[data-repair-create-external-type]', E_FEE = '[data-repair-create-fee]';
const WERKSTATT = '[data-ss-trigger="Pick a workshop / goldsmith"]';
const BADGE = '[data-repair-create-work] [data-repair-work-source]';
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function maskeAuf(c) {
  await geh(c, '/tasks'); await sleep(400); await geh(c, '/repairs');
  await warteBis(c, `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Repair')`, 30000);
  const r = await mausText(c, 'New Repair');
  await waitFor(c, '[data-create-repair]', 15000);
  await sleep(300);
  return r;
}
async function kundeUndProblem(c, issue) {
  const r = [];
  r.push(await maus(c, '[data-ss-trigger="Search clients by name, company, phone..."]'));
  await waitFor(c, '[data-ss-option="e2e-kunde"]', 15000);
  r.push(await maus(c, '[data-ss-option="e2e-kunde"]'));
  await sleep(200);
  r.push(await tippe(c, 'textarea[placeholder="Describe the issue or requested repair..."]', issue));
  return r.every((x) => x === 'OK') ? 'OK' : r.join(',');
}
async function werkstattWaehlen(c, id) {
  const a = await maus(c, WERKSTATT);
  if (a !== 'OK') return a;
  await waitFor(c, `[data-ss-option="${id}"]`, 15000);
  const b = await maus(c, `[data-ss-option="${id}"]`);
  await sleep(200);
  return b;
}
/** „Create Repair" per Maus; die neue Reparatur öffnet sich — Antwort: ihre Kennung. */
async function anlegen(c) {
  const vor = await c.ev('return location.pathname;');
  const k = await maus(c, '[data-create-repair]');
  if (k !== 'OK') return { fehler: k };
  if (!await warteBis(c, `/\\/repairs\\/.+/.test(location.pathname) && location.pathname !== ${S(vor)}`, 30000)) {
    return { fehler: 'keine Detailseite: ' + await text(c, '[data-save-error]') };
  }
  return { id: await c.ev(`return decodeURIComponent(location.pathname.split('/').pop());`) };
}

let primary = null, phone = null, client = null, steuer = null;
async function ladeP(route) {
  await primary.ev(`location.replace(${S(route)}); return 1;`);
  primary.close(); await sleep(3200);
  primary = await attachOnly(APP_CDP, /tauri\.localhost/, 30000);
  await waitFor(primary, 'a[href="/settings"]', 45000);
  await primary.ev(STUB + ' return 1;');
  return primary;
}
async function lade(route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { client.close(); } catch { /* zu */ }
  await sleep(3200);
  client = await attachOnly(CLIENT_CDP, /tauri\.localhost/, 30000);
  await waitFor(client, 'a[href="/settings"]', 45000);
  // Die App setzt beim Start ihren eigenen Dialog auf window.confirm; danach hier wieder abkürzen.
  await client.ev(STUB + ' return 1;');
  return client;
}
const zeileDa = (c, nr) => c.ev(`return !!document.querySelector('[data-repair-row-work=${S(nr)}]');`);
const reihenNummern = (c) => c.ev(`return [...document.querySelectorAll('[data-repair-row-work]')].map((e) => e.getAttribute('data-repair-row-work'));`);

try {
  assertE2eClientBinary(CLIENT_APP);
  if (!existsSync(SEED)) throw new Error('e2e_scope_seed.exe fehlt: ' + SEED);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  if (existsSync(CLIENT_LOCAL_STATE)) rmSync(CLIENT_LOCAL_STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ══ SETUP ══
  primary = await attachApp(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await klick(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'Preview Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'Preview Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'Preview Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, 'a[href="/settings"]', 90000);
  const pid1 = startedPids().pop();
  primary.close(); primary = null;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid1} -ErrorAction Stop).CloseMainWindow()`], { encoding: 'utf8', windowsHide: true });
  if (!await waitPidGone(pid1, 120000)) killTestPid(pid1, APP);
  seedDaten();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });
  primary = await attachApp(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, 'a[href="/settings"]', 120000);
  await primary.ev(STUB + ' return 1;');
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  let gesund = false;
  for (let i = 0; i < 120 && !gesund; i++) { try { gesund = (await fetch(`${BASE}/api/health`)).ok; } catch { /* noch nicht */ } if (!gesund) await sleep(500); }
  ok(gesund, 'SETUP Primary antwortet');
  const cfg = await primary.ev(`try { return await window.__TAURI_INTERNALS__.invoke('mobile_runtime_scope_configure', ${S({ email: OWNER_EMAIL, password: OWNER_PW, tenantId: 'tenant-1', branchId: 'branch-main' })}); } catch (e) { return { fehler: String(e) }; }`);
  ok(cfg?.configured === true, `SETUP Handy-Annahme (${S(cfg)})`);
  client = await attachApp(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP, /tauri\.localhost/);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await klick(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await klick(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP, /tauri\.localhost/);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await klick(client, '[data-client-signin]');
  ok(await waitFor(client, 'a[href="/settings"]', 90000), 'SETUP PC2 angemeldet');
  steuer = await attachOnly(CLIENT_CDP, /tauri\.localhost/, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await primary.send('Page.enable', {}).catch(() => null);

  const ID = {};
  // ══ F — „Who does the work?": Zustandswechsel mit der Maus ══
  {
    ok(await maskeAuf(primary) === 'OK', 'F „New Repair" per Maus');
    const stand = () => primary.ev(`return { i: ${q(I)}?.checked, e: ${q(E)}?.checked, badge: ${q(BADGE)}?.textContent, inF: !!${q(I_TYP)}, exF: !!${q(E_TYP)} };`);
    let s = await stand();
    ok(s.i === false && s.e === false && s.badge === 'Not set yet' && !s.inF && !s.exF, `F1 Start: nichts angekreuzt, „Not set yet", keine Felder (${S(s)})`);
    ok(await sichtbar(primary, '[data-repair-create-none]'), 'F1 Hinweis „No work ticked yet"');

    ok(await maus(primary, I) === 'OK', 'F2 In-house anklicken'); await sleep(250);
    s = await stand();
    ok(s.i && !s.e && s.badge === 'In-house' && s.inF && !s.exF, `F2 In-house: angekreuzt, Felder da, Art In-house (${S(s)})`);
    ok(await sichtbar(primary, I_TYP) && await sichtbar(primary, I_KOST), 'F2 Work type und Extra cost sichtbar');
    ok(!/Sent To Workshop/i.test(await text(primary, '[data-repair-create-steps]')), 'F2 kein „Sent to workshop"');
    ok(await waehle(primary, I_TYP, 'gold_work') === 'OK' && await tippe(primary, I_KOST, '5') === 'OK', 'F2 Work type wählen, Kosten tippen');

    ok(await maus(primary, I) === 'OK', 'F3 In-house wieder abwählen'); await sleep(250);
    s = await stand();
    ok(!s.i && !s.e && s.badge === 'Not set yet' && !s.inF, `F3 abgewählt: Häkchen weg, Felder weg, Not set (${S(s)})`);
    ok(await sichtbar(primary, '[data-repair-create-kept-inhouse]'), 'F3 Hinweis: Eingaben bleiben erhalten');
    ok(await maus(primary, I) === 'OK', 'F4 erneut ankreuzen'); await sleep(250);
    ok(await wert(primary, I_TYP) === 'gold_work' && await wert(primary, I_KOST) === '5', 'F4 Eingaben sind wieder da (kein Datenverlust)');

    ok(await maus(primary, E) === 'OK', 'F5 External dazu'); await sleep(250);
    s = await stand();
    ok(s.i && s.e && s.badge === 'Hybrid' && s.exF, `F5 beide: Hybrid, Werkstattfelder da (${S(s)})`);
    ok(await sichtbar(primary, WERKSTATT) && await sichtbar(primary, E_TYP) && await sichtbar(primary, E_FEE), 'F5 Workshop, Work type, Fee sichtbar');
    ok(/Sent To Workshop/i.test(await text(primary, '[data-repair-create-steps]')), 'F5 Statusschritte mit „Sent to workshop"');
    ok(await tippe(primary, E_FEE, '20') === 'OK' && await tippe(primary, '[data-repair-create-charge]', '70') === 'OK', 'F5 Fee und Charge tippen');
    await sleep(200);
    ok(zahl(await text(primary, '[data-repair-create-margin] strong')) === 45, `F5 Estimated margin 70 − 5 − 20 = 45 (${await text(primary, '[data-repair-create-margin]')})`);
    await foto(primary, 'F-new-repair-hybrid');
    await primary.ev(`document.querySelector('[data-repair-create-work]').scrollIntoView({block:'start'}); return 1;`); await sleep(200);
    await foto(primary, 'F-new-repair-karten');

    ok(await maus(primary, I) === 'OK', 'F6 In-house abwählen'); await sleep(250);
    s = await stand();
    ok(!s.i && s.e && s.badge === 'External workshop' && !s.inF && s.exF, `F6 nur External (${S(s)})`);
    ok(zahl(await text(primary, '[data-repair-create-margin] strong')) === 50, 'F6 abgewählte Kosten zählen nicht in der Marge');
    ok(await maus(primary, E) === 'OK', 'F7 External abwählen'); await sleep(250);
    s = await stand();
    ok(!s.i && !s.e && s.badge === 'Not set yet' && !s.exF, `F7 die letzte Wahl lässt sich abwählen — der gemeldete Fehler (${S(s)})`);
    ok(await maus(primary, E) === 'OK', 'F7 External wieder an'); await sleep(250);
    ok(await wert(primary, E_FEE) === '20', 'F7 die Gebühr ist wieder da');

    // Ungültig: Werkstatt fehlt.
    ok(await kundeUndProblem(primary, 'Validierung') === 'OK', 'F8 Kunde und Problem');
    const vor = anzahlReparaturen();
    ok(await maus(primary, '[data-create-repair]') === 'OK', 'F8 Create ohne Werkstatt');
    ok(await warteBis(primary, `/Choose the workshop/.test(document.querySelector('[data-save-error]')?.textContent || '')`, 10000), `F8 sagt, was fehlt (${await text(primary, '[data-save-error]')})`);
    ok(anzahlReparaturen() === vor, 'F8 nichts angelegt');
    await tippe(primary, E_FEE, '-3');
    await werkstattWaehlen(primary, 'ws-a');
    await maus(primary, '[data-create-repair]');
    ok(await warteBis(primary, `/Workshop fee must be/.test(document.querySelector('[data-save-error]')?.textContent || '')`, 10000) && anzahlReparaturen() === vor, 'F8 negative Gebühr abgewiesen');
    await mausText(primary, 'Cancel'); await sleep(300);
  }
  // ══ F — Speichern und erneut öffnen (Primary) ══
  const badgeDetail = (c) => c.ev(`return document.querySelector('[data-repair-work-source-text]')?.parentElement.querySelector('[data-repair-work-source]')?.textContent || '';`);
  {
    // In-house, ohne Zusatzkosten
    await maskeAuf(primary); await kundeUndProblem(primary, 'Polish only');
    await maus(primary, I); await sleep(200);
    await waehle(primary, I_TYP, 'polishing');
    await tippe(primary, '[data-repair-create-charge]', '30');
    let r = await anlegen(primary); ID.in = r.id;
    ok(!!r.id, `S1 In-house angelegt (${S(r)})`);
    let d = rep(ID.in), z = zeilen(ID.in);
    ok(d.typ === 'internal' && z.length === 1 && z[0].art === 'polishing' && z[0].kosten === 0 && !z[0].ws, `S1 eigene Zeile Polishing 0.000 (${S({ d, z })})`);
    ok(ausgaben(ID.in).length === 0, 'S1 keine Verbindlichkeit');

    // In-house mit Zusatzkosten
    await maskeAuf(primary); await kundeUndProblem(primary, 'Service in-house');
    await maus(primary, I); await sleep(200);
    await waehle(primary, I_TYP, 'service'); await tippe(primary, I_KOST, '10');
    r = await anlegen(primary); ID.in10 = r.id;
    d = rep(ID.in10); z = zeilen(ID.in10);
    ok(d.typ === 'internal' && z.length === 1 && z[0].art === 'service' && z[0].kosten === 10, `S2 eigene Zeile 10.000 (${S({ d, z })})`);

    // Werkstatt mit Gebühr; vorher In-house angetippt und wieder abgewählt → nichts davon wird gespeichert
    await maskeAuf(primary); await kundeUndProblem(primary, 'Clasp');
    await maus(primary, I); await sleep(200); await tippe(primary, I_KOST, '99'); await maus(primary, I); await sleep(200);
    await maus(primary, E); await sleep(200);
    ok(await werkstattWaehlen(primary, 'ws-a') === 'OK', 'S3 Werkstatt per Maus wählbar (nicht verdeckt)');
    await waehle(primary, E_TYP, 'plating'); await tippe(primary, E_FEE, '20'); await tippe(primary, '[data-repair-create-charge]', '60');
    r = await anlegen(primary); ID.ex = r.id;
    d = rep(ID.ex); z = zeilen(ID.ex);
    ok(d.typ === 'external' && z.length === 1 && z[0].ws === 'ws-a' && z[0].art === 'plating' && z[0].kosten === 20, `S3 Werkstattzeile mit gewählter Art; abgewählte 99 nicht gespeichert (${S({ d, z })})`);
    await ladeP(`/repairs/${ID.ex}`);
    ok(await warteBis(primary, q('[data-repair-cost-group="ws-a"]'), 20000) && await badgeDetail(primary) === 'External workshop', `S3 nach erneutem Öffnen External, Gruppe da (${await badgeDetail(primary)})`);

    // Werkstatt ohne Gebühr: eingeplant
    await maskeAuf(primary); await kundeUndProblem(primary, 'Gold work later');
    await maus(primary, E); await sleep(200);
    await werkstattWaehlen(primary, 'ws-b'); await waehle(primary, E_TYP, 'gold_work');
    r = await anlegen(primary); ID.plan = r.id;
    d = rep(ID.plan); z = zeilen(ID.plan);
    ok(d.typ === 'external' && d.plan === 'ws-b' && d.planArt === 'gold_work' && !d.ws && z.length === 0, `S4 geplant, Art bleibt gespeichert, keine Zeile (${S({ d, z })})`);
    ok(ausgaben(ID.plan).length === 0, 'S4 keine Verbindlichkeit');
    await ladeP(`/repairs/${ID.plan}`);
    ok(/planned/.test(await text(primary, '[data-repair-work-source-text]')), `S4 nach erneutem Öffnen „planned" (${await text(primary, '[data-repair-work-source-text]')})`);

    // Hybrid
    await maskeAuf(primary); await kundeUndProblem(primary, 'Polish + clasp');
    await maus(primary, I); await sleep(200); await waehle(primary, I_TYP, 'polishing');
    await maus(primary, E); await sleep(200);
    await werkstattWaehlen(primary, 'ws-a'); await waehle(primary, E_TYP, 'service'); await tippe(primary, E_FEE, '20'); await tippe(primary, '[data-repair-create-charge]', '70');
    r = await anlegen(primary); ID.hy = r.id;
    d = rep(ID.hy); z = zeilen(ID.hy);
    ok(d.typ === 'hybrid' && z.length === 2 && z.some((l) => l.ws === 'ws-a' && l.kosten === 20 && l.art === 'service') && z.some((l) => !l.ws && l.kosten === 0 && l.art === 'polishing'), `S5 Hybrid: zwei Zeilen (${S({ d, z })})`);

    // Nichts angekreuzt
    await maskeAuf(primary); await kundeUndProblem(primary, 'Polish maybe');
    r = await anlegen(primary); ID.none = r.id;
    d = rep(ID.none);
    ok(d.typ === 'unset' && zeilen(ID.none).length === 0, `S6 „Not set" gespeichert (${S(d)})`);
    await ladeP(`/repairs/${ID.none}`);
    ok(await warteBis(primary, q('[data-repair-work-source-text]'), 20000) && await badgeDetail(primary) === 'Not set yet', `S6 nach erneutem Öffnen „Not set yet" (${await badgeDetail(primary)})`);
  }
  // ══ F — Own Item: keine Preisfelder, die eigene Arbeit steht trotzdem als Zeile da ══
  {
    await maskeAuf(primary);
    await primary.ev(`[...document.querySelectorAll('button')].find((x) => x.firstElementChild && x.firstElementChild.textContent.trim() === 'Own Item').setAttribute('data-e2e-own', '1'); return 1;`);
    ok(await maus(primary, '[data-e2e-own]') === 'OK', 'S7 Own Item wählen'); await sleep(300);
    ok(!await exists(primary, '[data-repair-create-charge]'), 'S7 kein Kundenpreis bei eigener Ware');
    await maus(primary, '[data-ss-trigger="Search by brand, name, SKU, reference, attributes..."]');
    await waitFor(primary, '[data-ss-option="eigen"]', 15000);
    await maus(primary, '[data-ss-option="eigen"]'); await sleep(400);
    await tippe(primary, 'textarea[placeholder="Describe the issue or requested repair..."]', 'Own polish');
    await maus(primary, I); await sleep(200);
    await waehle(primary, I_TYP, 'polishing'); await tippe(primary, I_KOST, '6'); await sleep(200);
    ok(/Cost added to product on Ready/.test(await text(primary, '[data-repair-create-price]')), 'S7 Hinweis auf den Einstand');
    const r = await anlegen(primary); ID.own = r.id;
    const z = zeilen(ID.own);
    ok(rep(ID.own).typ === 'internal' && z.length === 1 && z[0].art === 'polishing' && z[0].kosten === 6, `S7 eigene Zeile an eigener Ware (${S({ r, z })})`);
    ok(artikel('eigen').ek === 500, 'S7 Einstand erst bei Ready');
  }
  // ══ F — PC2: dieselbe Maske über den Primary ══
  {
    await lade('/repairs');
    await maskeAuf(client); await kundeUndProblem(client, 'PC2 hybrid');
    await maus(client, I); await sleep(200); await waehle(client, I_TYP, 'engraving'); await tippe(client, I_KOST, '4');
    await maus(client, E); await sleep(200);
    ok(await werkstattWaehlen(client, 'ws-a') === 'OK', 'PC2 Werkstatt wählbar');
    await waehle(client, E_TYP, 'stone_setting'); await tippe(client, E_FEE, '12');
    await tippe(client, '[data-repair-create-charge]', '50');
    let r = await anlegen(client); ID.pc2 = r.id;
    ok(!!r.id, `PC2 Hybrid angelegt (${S(r)})`);
    await warteAuf(() => zeilen(ID.pc2).length === 2, 15);
    const d = rep(ID.pc2), z = zeilen(ID.pc2);
    ok(d.typ === 'hybrid' && z.some((l) => !l.ws && l.art === 'engraving' && l.kosten === 4) && z.some((l) => l.ws === 'ws-a' && l.art === 'stone_setting' && l.kosten === 12), `PC2 beide Zeilen wie am Primary (${S({ d, z })})`);
    await maskeAuf(client); await kundeUndProblem(client, 'PC2 none');
    r = await anlegen(client); ID.pc2none = r.id;
    ok(rep(ID.pc2none).typ === 'unset', 'PC2 „Not set" gespeichert');
    await maskeAuf(client); await kundeUndProblem(client, 'PC2 plan');
    await maus(client, E); await sleep(200); await werkstattWaehlen(client, 'ws-b'); await waehle(client, E_TYP, 'plating');
    r = await anlegen(client); ID.pc2plan = r.id;
    const dp = rep(ID.pc2plan);
    ok(dp.typ === 'external' && dp.plan === 'ws-b' && dp.planArt === 'plating', `PC2 geplante Werkstatt samt Art (${S(dp)})`);
    await lade(`/repairs/${ID.pc2plan}`);
    ok(await warteBis(client, `/planned/.test(document.querySelector('[data-repair-work-source-text]')?.textContent || '')`, 20000), 'PC2 erneut geöffnet: „planned"');
    ok(offeneDateien() === 0, 'PC2 nichts offen');
  }
  const NR = Object.fromEntries(Object.entries(ID).map(([k, id]) => [k, rep(id).nr]));

  // ══ A — Liste ══
  {
    await ladeP('/repairs');
    await waitFor(primary, '[data-repair-filter-source="all"]', 30000);
    const alle = anzahlReparaturen();
    ok(await warteBis(primary, `/Showing ${alle} of ${alle}/.test(document.querySelector('[data-repair-showing]')?.textContent || '')`, 20000), `A „Showing x of y" (${await text(primary, '[data-repair-showing]')})`);
    ok(new RegExp(`· ${alle} total`).test(await primary.ev('return document.body.innerText;')), 'A Kopf: „active · total"');
    const filter = async (sel) => { const r = await maus(primary, sel); await sleep(350); return r; };
    await filter('[data-repair-filter-source="inhouse"]');
    let n = await reihenNummern(primary);
    ok(n.includes(NR.in) && n.includes(NR.hy) && !n.includes(NR.ex) && !n.includes(NR.none), `A Quelle In-house (${S(n)})`);
    await filter('[data-repair-filter-source="external"]');
    n = await reihenNummern(primary);
    ok(n.includes(NR.ex) && n.includes(NR.plan) && n.includes(NR.hy) && n.includes('REP-ALT-1') && !n.includes(NR.in), `A Quelle External (${S(n)})`);
    await filter('[data-repair-filter-source="hybrid"]');
    n = await reihenNummern(primary);
    ok(n.includes(NR.hy) && n.includes(NR.pc2) && n.length === 2, `A Quelle Hybrid (${S(n)})`);
    await filter('[data-repair-filter-source="unassigned"]');
    n = await reihenNummern(primary);
    ok(n.includes(NR.none) && n.includes(NR.pc2none) && !n.includes(NR.in), `A „Unassigned" trifft Not set (${S(n)})`);
    await filter('[data-repair-filter-source="all"]');
    await waehle(primary, '[data-repair-filter-workshop]', 'ws-b'); await sleep(350);
    n = await reihenNummern(primary);
    ok(n.includes(NR.plan) && n.includes('REP-ALT-1') && !n.includes(NR.ex), `A Werkstatt B (${S(n)})`);
    await waehle(primary, '[data-repair-filter-workshop]', ''); await sleep(250);
    await filter('[data-repair-filter-worktype="gold_work"]');
    n = await reihenNummern(primary);
    ok(n.includes(NR.plan), `A Arbeitsart Gold Work trifft die geplante Werkstatt (${S(n)})`);
    await filter('[data-repair-filter-worktype="polishing"]');
    n = await reihenNummern(primary);
    ok(n.includes(NR.in) && n.includes(NR.hy) && n.includes('REP-ALT-2'), `A Polishing: Zeilen und Altbestand übers Issue (${S(n)})`);
    ok(await exists(primary, '[data-repair-found-via-issue]'), 'A „Found via Issue"');
    await filter('[data-repair-filter-issue]');
    n = await reihenNummern(primary);
    ok(!n.includes('REP-ALT-2'), 'A Issue-Schalter aus: Altbestand weg');
    await filter('[data-repair-filter-issue]');
    await filter('[data-repair-filter-reset]');
    ok(/Showing (\d+) of \1/.test(await text(primary, '[data-repair-showing]')), 'A „Reset filters"');
    const suche = 'input[placeholder="Search by repair #, customer, item, voucher..."]';
    ok(await tippe(primary, suche, 'Werkstatt B') === 'OK', 'A Suche tippen');
    await warteBis(primary, `document.querySelectorAll('[data-repair-row-work]').length > 0 && document.querySelectorAll('[data-repair-row-work]').length < ${alle}`, 8000);
    n = await reihenNummern(primary);
    ok(n.includes(NR.plan) && n.includes('REP-ALT-1') && !n.includes(NR.in), `A Suche findet die Werkstatt (${S(n)})`);
    await tippe(primary, suche, ''); await sleep(400);
    ok(/Work 20(\.0+)? · Mat\. 0/.test(await text(primary, `[data-repair-cost-split=${S(NR.hy)}]`)), `A Kosten aufgeteilt (${await text(primary, `[data-repair-cost-split=${S(NR.hy)}]`)})`);
    ok(/No cost lines/.test(await text(primary, `[data-repair-cost-split=${S(NR.plan)}]`)) && /Workshop fee/.test(await text(primary, '[data-repair-cost-split="REP-ALT-1"]')), 'A „No cost lines" und Altgebühr');
    ok(await text(primary, `[data-repair-quick-edit=${S(NR.in)}]`) === 'Quick Edit', 'A Knopf heißt „Quick Edit"');
    const farbe = await primary.ev(`return getComputedStyle(document.querySelector('[data-repair-filter-source="all"]')).backgroundColor;`);
    ok(farbe === 'rgb(113, 93, 227)', `A Auswahl violett (${farbe})`);
    await foto(primary, 'A-liste');
  }
  // ══ B C D — Quick Edit ══
  {
    ok(await maus(primary, `[data-repair-quick-edit=${S(NR.in10)}]`) === 'OK', 'B Quick Edit öffnet per Maus');
    ok(await waitFor(primary, `[data-repair-quick-edit-modal=${S(NR.in10)}]`, 15000), 'B Fenster da');
    ok(await sichtbar(primary, '[data-quick-work-section]') && await sichtbar(primary, '[data-quick-material-section]'), 'B Arbeit und Material getrennt');
    ok(await sichtbar(primary, '[data-quick-work-group="inhouse"]'), 'B Gruppe In-house');
    ok(await maus(primary, '[data-quick-add-work]') === 'OK', 'C + Add Work');
    await waitFor(primary, '[data-quick-work-form]', 8000);
    ok(await maus(primary, '[data-quick-work-source-external]') === 'OK', 'C Quelle External');
    await sleep(200);
    ok(await exists(primary, '[data-quick-work-problem]') && await primary.ev(`return document.querySelector('[data-quick-work-save]').disabled;`), 'C ohne Werkstatt: Speichern gesperrt, Grund steht da');
    await maus(primary, '[data-quick-work-form] [data-ss-trigger="Pick a workshop / goldsmith"]');
    await waitFor(primary, '[data-ss-option="ws-a"]', 8000);
    await maus(primary, '[data-ss-option="ws-a"]'); await sleep(200);
    await tippe(primary, '[data-quick-work-cost]', '0'); await sleep(200);
    ok(/above 0/.test(await text(primary, '[data-quick-work-problem]')), 'C Werkstatt mit 0: Grund steht da');
    await tippe(primary, '[data-quick-work-cost]', '15'); await waehle(primary, '[data-quick-work-type]', 'engraving');
    await tippe(primary, '[data-quick-work-description]', 'Gravur');
    ok(await maus(primary, '[data-quick-work-save]') === 'OK', 'C Zeile speichern');
    ok(await warteAuf(() => zeilen(ID.in10).length === 2), 'C zweite Zeile da');
    ok(rep(ID.in10).typ === 'hybrid', `C aus eigener Arbeit + Werkstatt wird Hybrid (${rep(ID.in10).typ})`);
    ok(await warteBis(primary, q('[data-quick-work-group="ws-a"]'), 10000), 'C Gruppe der Werkstatt');
    ok(zahl(await text(primary, '[data-quick-total-cost]')) === 25, `C Summe 10 + 15 (${await text(primary, '[data-quick-total-cost]')})`);
    // Zeile ändern
    const wsZeile = zeilen(ID.in10).find((l) => l.ws === 'ws-a');
    ok(await maus(primary, `[data-quick-line-edit=${S(wsZeile.id)}]`) === 'OK', 'C Edit an der Zeile');
    await waitFor(primary, '[data-quick-line-cost]', 8000);
    await tippe(primary, '[data-quick-line-cost]', '16');
    ok(await maus(primary, '[data-quick-line-save]') === 'OK', 'C Save line');
    ok(await warteAuf(() => zeilen(ID.in10).find((l) => l.ws === 'ws-a')?.kosten === 16), 'C Betrag geändert');
    // Zeile stornieren
    ok(await maus(primary, `[data-quick-line-cancel=${S(wsZeile.id)}]`) === 'OK', 'C Cancel an der Zeile');
    ok(await warteAuf(() => zeilen(ID.in10).length === 1), 'C Zeile entfernt');
    ok(rep(ID.in10).typ === 'hybrid', 'C Hybrid bleibt nach Storno (Owner-Regel: keine automatische Herabstufung)');
    await sleep(500);
    // Betrag + Fuß
    await tippe(primary, '[data-quick-charge]', '99'); await sleep(200);
    ok(await sichtbar(primary, '[data-quick-unsaved]'), 'D ungespeichert wird gesagt');
    ok(await maus(primary, '[data-quick-save-amounts]') === 'OK', 'D Save im Fuß');
    ok(await warteAuf(() => rep(ID.in10).preis === 99), `D Preis gespeichert (${rep(ID.in10).preis})`);
    await sleep(400);
    ok(/%/.test(await text(primary, '[data-quick-margin]')), `D Marge mit Prozent (${await text(primary, '[data-quick-margin]')})`);
    ok(await maus(primary, '[data-quick-advanced]') === 'OK', 'D Advanced öffnen');
    await sleep(200);
    ok(await primary.ev(`return document.querySelector('[data-quick-actual]').disabled;`) && await sichtbar(primary, '[data-quick-estimated]'), 'D Actual aus Zeilen gesperrt, Estimated frei');
    await foto(primary, 'BCD-quick-edit');
    ok(await maus(primary, '[data-quick-close]') === 'OK', 'D Close');
    await warteBis(primary, `!document.querySelector('[data-repair-quick-edit-modal]')`, 8000);
    // Material an einer Werkstatt-Reparatur: Lieferant ist keine Werkstatt
    await maus(primary, `[data-repair-quick-edit=${S(NR.ex)}]`);
    await waitFor(primary, `[data-repair-quick-edit-modal=${S(NR.ex)}]`, 15000);
    ok(await maus(primary, '[data-quick-add-material]') === 'OK', 'C + Add Material');
    await waitFor(primary, '[data-material-kind="stone"]', 8000);
    await maus(primary, '[data-material-kind="stone"]'); await sleep(200);
    await tippe(primary, '[data-material-description]', 'Sapphire');
    await tippe(primary, '[data-material-quantity]', '1'); await tippe(primary, '[data-material-carat]', '0.5');
    await tippe(primary, 'input[data-material-cost]', '15');
    await maus(primary, '[data-ss-trigger="Pick: Shop / Own Stock OR a supplier"]');
    await waitFor(primary, '[data-ss-option="mat"]', 8000);
    await maus(primary, '[data-ss-option="mat"]'); await sleep(200);
    await maus(primary, '[data-material-save]');
    ok(await warteAuf(() => zeilen(ID.ex).some((l) => l.mat === 'stone')), `C Material gespeichert (${await text(primary, '[data-material-error]')})`);
    const dm = rep(ID.ex);
    ok(dm.typ === 'external' && dm.ws === 'ws-a', `C Materiallieferant ändert die Quelle nicht (${S(dm)})`);
    await warteBis(primary, q('[data-quick-material-total]'), 5000);
    ok(zahl(await text(primary, '[data-quick-material-total]')) === 15 && zahl(await text(primary, '[data-quick-work-total]')) === 20, 'C Summen getrennt');
    await maus(primary, '[data-quick-close]');
  }
  // ══ G — Detailseite ══
  {
    await ladeP(`/repairs/${ID.hy}`);
    await waitFor(primary, '[data-repair-detail-quick-edit]', 20000);
    ok(await maus(primary, '[data-repair-detail-quick-edit]') === 'OK', 'G Quick Edit an der Detailseite');
    ok(await waitFor(primary, `[data-repair-quick-edit-modal=${S(NR.hy)}]`, 10000), 'G Fenster öffnet');
    await maus(primary, '[data-quick-close]'); await sleep(300);
    ok(await sichtbar(primary, '[data-repair-cost-group="inhouse"]') && await sichtbar(primary, '[data-repair-cost-group="ws-a"]'), 'G Gruppen In-house und Werkstatt');
    ok(await sichtbar(primary, '[data-repair-flow-hint]'), 'G Hinweis „Sent to workshop"');
    const aktuell = await primary.ev(`return getComputedStyle(document.querySelector('[data-repair-flow-current] span')).backgroundColor;`);
    ok(aktuell === 'rgb(113, 93, 227)', `G aktueller Schritt violett (${aktuell})`);
    const box = (k) => text(primary, `[data-repair-cost-box=${S(k)}]`).then(zahl);
    ok(await box('work') === 20 && await box('material') === 0 && await box('total') === 20 && await box('charge') === 70 && await box('margin') === 50, `G fünf Summen (${await text(primary, '[data-repair-cost-summary]')})`);
    await foto(primary, 'G-detail-hybrid');
    await primary.ev(`document.querySelector('[data-repair-cost-group="inhouse"]').scrollIntoView({block:'center'}); return 1;`); await sleep(200);
    await foto(primary, 'G-detail-kosten');
    // Altgebühr: Sie hat alle Starts unverändert überstanden; erst der Klick macht daraus eine Zeile (hier an PC2).
    ok(zeilen('alt-gebuehr').length === 0, `G Altgebühr: der Start hat keine Zeile angelegt (${S(zeilen('alt-gebuehr'))})`);
    await lade('/repairs/alt-gebuehr');
    ok(await waitFor(client, '[data-repair-legacy-fee]', 20000), 'G Altgebühr wird angezeigt');
    ok(await text(client, '[data-repair-cost-box="total"]').then(zahl) === 18, 'G sie zählt als Gebühr');
    ok(await maus(client, '[data-repair-legacy-convert]') === 'OK', 'G „Turn into a work line"');
    ok(await warteAuf(() => zeilen('alt-gebuehr').length === 1), `G Zeile entstanden (${await text(client, '[data-save-error]')})`);
    const zl = zeilen('alt-gebuehr')[0];
    ok(zl.ws === 'ws-b' && zl.kosten === 18, `G Zeile der Werkstatt über die Gebühr (${S(zl)})`);
    ok(await warteBis(client, `!document.querySelector('[data-repair-legacy-fee]')`, 10000) && await text(client, '[data-repair-cost-box="total"]').then(zahl) === 18, 'G Summe unverändert 18');
    ok(ausgaben('alt-gebuehr').length === 0, 'G Status „received": keine Buchung');
    // Geplante Werkstatt: Add Work ist vorbelegt
    await ladeP(`/repairs/${ID.plan}`);
    ok(await maus(primary, '[data-repair-add-work]') === 'OK', 'G + Add Work');
    await waitFor(primary, '[data-repair-line-form]', 8000);
    ok(await wert(primary, '[data-repair-line-type]') === 'gold_work' && await primary.ev(`return document.querySelector('[data-repair-line-source-external]').getAttribute('aria-pressed');`) === 'true', 'G vorbelegt mit Werkstatt und gewählter Art');
    await tippe(primary, '[data-repair-line-cost]', '30');
    await maus(primary, '[data-add-repair-line]');
    ok(await warteAuf(() => zeilen(ID.plan).length === 1), 'G Zeile da');
    const dp = rep(ID.plan);
    ok(!dp.plan && !dp.planArt && dp.typ === 'external' && zeilen(ID.plan)[0].art === 'gold_work' && zeilen(ID.plan)[0].ws === 'ws-b', `G Plan beendet (${S(dp)})`);
    // „Not set": Material ändert nichts, Arbeit setzt die Art
    await ladeP(`/repairs/${ID.none}`);
    await waitFor(primary, '[data-material-open]', 20000);
    await maus(primary, '[data-material-open]');
    await waitFor(primary, '[data-material-kind="stone"]', 8000);
    await maus(primary, '[data-material-kind="stone"]'); await sleep(200);
    await tippe(primary, '[data-material-description]', 'Ruby'); await tippe(primary, '[data-material-quantity]', '1'); await tippe(primary, '[data-material-carat]', '0.2');
    await tippe(primary, 'input[data-material-cost]', '7');
    await maus(primary, '[data-ss-trigger="Pick: Shop / Own Stock OR a supplier"]');
    await waitFor(primary, '[data-ss-option="mat"]', 8000);
    await maus(primary, '[data-ss-option="mat"]'); await sleep(200);
    await maus(primary, '[data-material-save]');
    ok(await warteAuf(() => zeilen(ID.none).length === 1), `G Material an „Not set" (${await text(primary, '[data-material-error]')})`);
    ok(rep(ID.none).typ === 'unset', `G Material setzt die Art nicht (${rep(ID.none).typ})`);
    await sleep(500);
    await maus(primary, '[data-repair-add-work]');
    await waitFor(primary, '[data-repair-line-form]', 8000);
    await waehle(primary, '[data-repair-line-type]', 'polishing');
    await maus(primary, '[data-add-repair-line]');
    ok(await warteAuf(() => zeilen(ID.none).length === 2), 'G eigene Arbeit an „Not set"');
    ok(rep(ID.none).typ === 'internal', `G die erste Arbeit setzt die Art (${rep(ID.none).typ})`);
  }
  // ══ BUCH — Kosten und Buchungen ══
  {
    const schritt = async (route, ziel) => {
      await ladeP(route);
      for (let i = 0; i < 8; i++) {
        if (rep(ziel.id).status === ziel.status) break;
        if (!await warteBis(primary, q('[data-repair-advance]'), 15000)) break;
        const vor = rep(ziel.id).status;
        await maus(primary, '[data-repair-advance]');
        await warteAuf(() => rep(ziel.id).status !== vor, 12);
        await sleep(500);
      }
    };
    await schritt(`/repairs/${ID.ex}`, { id: ID.ex, status: 'ready' });
    ok(rep(ID.ex).status === 'ready', `BUCH External bis Ready (${rep(ID.ex).status})`);
    const aus = ausgaben(ID.ex);
    const wsAus = aus.filter((a) => a.ws === 'ws-a');
    ok(wsAus.length === 1 && wsAus[0].amount === 20, `BUCH genau eine Verbindlichkeit an die Werkstatt über 20 (${S(aus)})`);
    ok(await text(primary, '[data-repair-cost-box="total"]').then(zahl) === 35, `BUCH Kosten 20 + Material 15, gespiegelter Voranschlag zählt nicht doppelt (${await text(primary, '[data-repair-cost-summary]')})`);
    await schritt(`/repairs/${ID.in}`, { id: ID.in, status: 'ready' });
    ok(rep(ID.in).status === 'ready' && ausgaben(ID.in).length === 0, `BUCH eigene Arbeit 0.000 bucht nichts (${S(ausgaben(ID.in))})`);
    // Rechnung aus der Liste, dann Anzeige und Filter
    await ladeP('/repairs');
    await waitFor(primary, `[data-repair-row-work=${S(NR.ex)}]`, 20000);
    await primary.ev(`const zeile=document.querySelector('[data-repair-row-work=${S(NR.ex).replace(/"/g, '\\"')}]').parentElement; zeile.querySelector('[data-repair-quick-invoice]').setAttribute('data-e2e-rechnung','1'); return 1;`);
    ok(await maus(primary, '[data-e2e-rechnung]') === 'OK', 'BUCH „Create Invoice" in der Zeile');
    await waitFor(primary, '[data-combined-invoice-confirm]', 10000);
    ok(await maus(primary, '[data-combined-invoice-confirm]') === 'OK', 'BUCH bestätigen');
    ok(await warteBis(primary, `/\\/invoices\\//.test(location.pathname)`, 20000), 'BUCH Rechnung öffnet');
    await geh(primary, '/repairs');
    await waitFor(primary, '[data-repair-filter-invoice="created"]', 20000);
    await sleep(600);
    ok(await primary.ev(`return document.querySelector('[data-repair-row-work=${S(NR.ex).replace(/"/g, '\\"')}]').parentElement.querySelector('[data-repair-invoice-state]').getAttribute('data-repair-invoice-state');`) === 'created', 'A Rechnungsstatus „created" in der Zeile');
    await maus(primary, '[data-repair-filter-invoice="created"]'); await sleep(350);
    let n = await reihenNummern(primary);
    ok(n.length === 1 && n[0] === NR.ex, `A Filter Invoice Created (${S(n)})`);
    await maus(primary, '[data-repair-filter-invoice="not_created"]'); await sleep(350);
    n = await reihenNummern(primary);
    ok(!n.includes(NR.ex) && n.includes(NR.in), 'A Filter Not Created');
    await maus(primary, '[data-repair-filter-invoice="all"]');
  }
  // ══ E — Handy ══
  {
    mkdirSync(EDGE_PROFILE, { recursive: true });
    edgeProc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${EDGE_PROFILE}`, `--remote-debugging-port=${EDGE_CDP}`, `${BASE}/mobile`], { stdio: 'ignore' });
    phone = await attachOnly(EDGE_CDP, new RegExp('^' + `${BASE}/mobile`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 60000);
    edgeBrowserWs = await edgeBrowserEndpoint(EDGE_CDP);
    await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await waitFor(phone, '#login', 60000);
    await setVal(phone, '#email', OWNER_EMAIL); await setVal(phone, '#password', OWNER_PW);
    await klick(phone, '#loginBtn');
    await warteBis(phone, `document.getElementById('modePicker') && !document.getElementById('modePicker').classList.contains('hidden')`, 60000);
    ok(await maus(phone, '.mode-btn[data-mode="repair"]') === 'OK', 'E Reparatur-Modus');
    await warteBis(phone, `!document.getElementById('repairHome').classList.contains('hidden') || !document.getElementById('formRepair').classList.contains('hidden')`, 20000);
    if (await phone.ev(`return !document.getElementById('formRepair').classList.contains('hidden');`)) await klick(phone, '[data-back-repair]');
    ok(await waitFor(phone, '[data-rp-filter-source="hybrid"]', 20000) && await sichtbar(phone, '[data-rp-filter-worktype="polishing"]'), 'E Filter für Arbeitsart und Quelle sichtbar');
    await warteBis(phone, `document.querySelectorAll('#rpList .card').length > 0`, 20000);
    const nummern = () => phone.ev(`return [...document.querySelectorAll('[data-rp-card-money]')].map((e) => e.getAttribute('data-rp-card-money'));`);
    const treffer = (nr) => phone.ev(`return !!document.querySelector('[data-rp-card-money=${S(nr).replace(/"/g, '\\"')}]');`);
    ok(/Issue:/.test(await text(phone, `[data-rp-card-issue=${S(NR.hy)}]`)) && /Cost 20\.000 · Charge 70\.000/.test(await text(phone, `[data-rp-card-money=${S(NR.hy)}]`)), `E Karte: Problem, Kosten, Preis (${await text(phone, `[data-rp-card-money=${S(NR.hy)}]`)})`);
    await foto(phone, 'E-handy-liste');
    ok(await maus(phone, '[data-rp-filter-source="hybrid"]') === 'OK', 'E Quelle Hybrid');
    await warteBis(phone, `document.querySelectorAll('[data-rp-card-money]').length === 2 || document.querySelectorAll('[data-rp-card-money]').length === 3`, 15000);
    let n = await nummern();
    ok(n.includes(NR.hy) && !n.includes(NR.ex), `E gefiltert am Primary (${S(n)})`);
    await maus(phone, '[data-rp-filter-source="all"]'); await sleep(800);
    await maus(phone, '[data-rp-filter-worktype="polishing"]');
    await warteBis(phone, `document.querySelector('[data-rp-filter-worktype="polishing"]').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('[data-rp-card-money]').length > 0`, 15000);
    await sleep(500);
    n = await nummern();
    ok(n.includes(NR.hy) && n.includes('REP-ALT-2') && !n.includes(NR.pc2plan), `E Arbeitsart Polishing, Altbestand übers Issue (${S(n)})`);
    ok(/Found via Issue/.test(await text(phone, '[data-rp-card-types="REP-ALT-2"]')), 'E „Found via Issue"');
    await maus(phone, '[data-rp-filter-worktype="all"]'); await sleep(800);
    // Öffnen
    await phone.ev(`[...document.querySelectorAll('#rpList button')].find((b) => b.textContent.includes(${S(NR.hy)})).setAttribute('data-e2e-oeffnen','1'); return 1;`);
    ok(await maus(phone, '[data-e2e-oeffnen]') === 'OK', 'E Karte öffnen');
    await warteBis(phone, `!document.getElementById('formRepair').classList.contains('hidden')`, 20000);
    ok(/Hybrid/.test(await text(phone, '#rpSubline')), `E Art steht da (${await text(phone, '#rpSubline')})`);
    ok(await sichtbar(phone, '[data-rp-line-group="work"]') && await sichtbar(phone, '[data-rp-line-group="material"]'), 'E Arbeit und Material getrennt');
    const summe = (k) => text(phone, `[data-rp-total=${S(k)}]`).then(zahl);
    ok(await summe('work') === 20 && await summe('material') === 0 && await summe('total') === 20 && await summe('charge') === 70 && await summe('margin') === 50, `E Summen und Marge (${await text(phone, '#rpTotals')})`);
    await foto(phone, 'E-handy-detail');
    ok(await maus(phone, '[data-fold="rpFoldLine"]') === 'OK', 'E „Add work line" aufklappen');
    await sleep(300);
    await waehle(phone, '#rpLineType', 'engraving');
    await waehle(phone, '#rpLineSupplier', await phone.ev(`return document.getElementById('rpLineSupplier').options[0].value;`));
    ok(await tippe(phone, '#rpLineCost', '0') === 'OK', 'E Kosten 0.000 tippen');
    ok(await maus(phone, '#rpLineAddBtn') === 'OK', 'E Add work line');
    ok(await warteAuf(() => zeilen(ID.hy).some((l) => l.art === 'engraving' && l.kosten === 0 && !l.ws)), `E eigene Arbeit 0.000 gespeichert (${await text(phone, '#rpWorkMsg')})`);
    await sleep(1200);
    await waehle(phone, '#rpLineSupplier', 'ws-a'); await tippe(phone, '#rpLineCost', '0');
    const vor = zeilen(ID.hy).length;
    await maus(phone, '#rpLineAddBtn');
    await warteBis(phone, `(document.getElementById('rpWorkMsg').textContent || '').length > 0 && !/added/.test(document.getElementById('rpWorkMsg').textContent)`, 15000);
    ok(zeilen(ID.hy).length === vor, `E Werkstatt mit 0 abgewiesen (${await text(phone, '#rpWorkMsg')})`);
    // „Not set" am Handy
    await klick(phone, '[data-back-repair]');
    await warteBis(phone, `!document.getElementById('repairHome').classList.contains('hidden')`, 20000);
    await warteBis(phone, `[...document.querySelectorAll('#rpList button')].some((b) => b.textContent.includes(${S(NR.pc2none)}))`, 15000);
    ok(/Not set yet/.test(await phone.ev(`return [...document.querySelectorAll('#rpList button')].find((b) => b.textContent.includes(${S(NR.pc2none)})).textContent;`)), 'E „Not set yet" am Handy');
  }
  // ══ COLL — Collection: Preise direkt an der Karte ══
  {
    const belegeVorher = belege();
    await ladeP('/collection');
    ok(await waitFor(primary, '[data-collection-edit-prices="kauf"]', 30000), 'COLL Knopf an der Karte');
    ok(await maus(primary, '[data-collection-edit-prices="kauf"]') === 'OK', 'COLL Primary öffnen per Maus');
    ok(await waitFor(primary, '[data-collection-price-modal="kauf"]', 8000), 'COLL Fenster, Karte bleibt geöffnet (keine Navigation)');
    ok(await primary.ev('return location.pathname;') === '/collection', 'COLL bleibt in der Collection');
    ok(/500/.test(await text(primary, '[data-collection-price-cost]')), 'COLL Einkaufspreis steht nur da');
    ok(await primary.ev(`return document.querySelectorAll('[data-collection-price-modal] input').length;`) === 2, 'COLL nur Verkaufs- und Mindestpreis sind Felder');
    await tippe(primary, '[data-collection-price-sale]', '850'); await tippe(primary, '[data-collection-price-min]', '700');
    await sleep(200);
    ok(/350/.test(await text(primary, '[data-collection-price-margin]')), `COLL erwartete Marge (${await text(primary, '[data-collection-price-margin]')})`);
    await foto(primary, 'COLL-preise');
    ok(await maus(primary, '[data-collection-price-save]') === 'OK', 'COLL Save');
    ok(await warteAuf(() => artikel('kauf').vk === 850 && artikel('kauf').mind === 700), `COLL Primary gespeichert (${S(artikel('kauf'))})`);
    const a1 = artikel('kauf');
    ok(a1.ek === 500 && a1.marge === 350 && belege() === belegeVorher, `COLL Einkaufspreis und Buchhaltung unberührt, Marge folgt (${S(a1)})`);
    ok(await warteBis(primary, `/850/.test(document.querySelector('[data-collection-sale="kauf"]')?.textContent || '') && /700/.test(document.querySelector('[data-collection-min="kauf"]')?.textContent || '')`, 15000), 'COLL die Karte zeigt die neuen Preise');
    // Mindestpreis leeren
    await maus(primary, '[data-collection-edit-prices="kauf"]');
    await waitFor(primary, '[data-collection-price-modal="kauf"]', 8000);
    ok(await wert(primary, '[data-collection-price-sale]') === '850', 'COLL Fenster zeigt den Stand');
    await tippe(primary, '[data-collection-price-min]', '');
    await maus(primary, '[data-collection-price-save]');
    ok(await warteAuf(() => artikel('kauf').mind === null && artikel('kauf').vk === 850), `COLL Mindestpreis geleert (${S(artikel('kauf'))})`);
    // PC2
    await lade('/collection');
    ok(await waitFor(client, '[data-collection-edit-prices="kauf2"]', 30000), 'COLL PC2 Knopf an der Karte');
    ok(await maus(client, '[data-collection-edit-prices="kauf2"]') === 'OK', 'COLL PC2 öffnen');
    await waitFor(client, '[data-collection-price-modal="kauf2"]', 8000);
    await tippe(client, '[data-collection-price-sale]', '640'); await tippe(client, '[data-collection-price-min]', '600');
    await maus(client, '[data-collection-price-save]');
    ok(await warteAuf(() => artikel('kauf2').vk === 640 && artikel('kauf2').mind === 600), `COLL PC2 gespeichert (${S(artikel('kauf2'))}; ${await text(client, '[data-save-error]')})`);
    ok(artikel('kauf2').ek === 500 && belege() === belegeVorher, 'COLL PC2 Einkaufspreis und Buchhaltung unberührt');
    ok(await warteBis(client, `/640/.test(document.querySelector('[data-collection-sale="kauf2"]')?.textContent || '')`, 15000), 'COLL PC2 die Karte zeigt den Preis');
    ok(await zeilenOffen(client) === 0 && offeneDateien() === 0, 'COLL PC2 kein offener Eintrag');
    // Sperre am PC2: Kommissionsware zeigt ihren Grund im Fenster
    await client.ev(`[...document.querySelectorAll('button')].find((b) => /consign/i.test(b.textContent.trim()) && b.textContent.trim().length < 20)?.setAttribute('data-e2e-kom','1'); return 1;`);
    await maus(client, '[data-e2e-kom]');
    await waitFor(client, '[data-collection-edit-prices="kom"]', 15000);
    await maus(client, '[data-collection-edit-prices="kom"]');
    await waitFor(client, '[data-collection-price-modal="kom"]', 8000);
    await tippe(client, '[data-collection-price-sale]', '123');
    await maus(client, '[data-collection-price-save]');
    ok(await warteBis(client, `/cannot be changed here/.test(document.querySelector('[data-collection-price-modal]')?.textContent || '')`, 20000), `COLL PC2 gesperrter Artikel nennt den Grund (${await text(client, '[data-collection-price-modal]')})`);
    ok(artikel('kom').vk === null && await zeilenOffen(client) === 0 && offeneDateien() === 0, 'COLL PC2 nichts gespeichert, kein offener Eintrag');
  }
  ok(primary.fehler.length === 0, `ENDE keine Fehler in der Oberfläche des Primary (${S(primary.fehler)})`);
  console.log('  Bildschirmfotos: ' + RUN);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { phone?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  await edgeSchliessen();
  aufraeumen();
  await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
}
await waitEdgeProfileGone(EDGE_PROFILE);
clearTimeout(WACHHUND);
function zeilenOffen(c) { return c.ev(`return document.querySelectorAll('[data-testid="pending-save-row"]').length;`); }
const ZEILE = `repair preview acceptance A-G + collection prices (${Math.round((Date.now() - T0) / 1000)}s): ${PASS} passed, ${FAIL} failed`;
if (FAIL > 0) {
  console.log(`\nFAIL — ${ZEILE}`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`\nPASS — ${ZEILE}`);
console.log('REPAIR_PREVIEW_ACCEPTANCE_E2E_PROVED');
