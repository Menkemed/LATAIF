// ════════════════════════════════════════════════════════════════════════════
// Owner 14.11.2026 — „New Transfer" mit mehreren Artikeln, danach EINEN Transfer bearbeiten und einen falschen Artikel
// entfernen. Zwei-App-E2E (Primary + PC2), echte Maus/Tastatur. Kurz, keine Regression.
// Run: node test/e2e/transfer-multi-edit.e2e.mjs
//
//   P  PC2: drei Artikel ankreuzen, je eigener Preis, gemeinsam Full, ein Artikel Split 40 % ⇒ EIN `transfers.create`
//      mit drei `items`, drei Transfers (eigene Nummern, Preise, Modelle), Stücke „with_agent". Dann einen Transfer
//      bearbeiten (Preis 950, Split 30 %) ⇒ EIN `transfers.update`; die anderen unverändert. „Remove" am PC2 gesperrt.
//   Q  Primary: dieselbe Maske — drei Artikel, gemeinsam Split 60 %, ein Artikel Full; einen bearbeiten (Preis, Full);
//      einen falschen Artikel entfernen (Grund) ⇒ Transfer gelöscht, Stück zurück im Lager, Protokoll mit Grund; die
//      anderen unberührt. Danach den falschen Artikel aus der PC2-Übergabe am Primary entfernen ⇒ PC2 zeigt ihn nicht mehr.
//
// PROZESS-ISOLATION (Gerüst aus expense-pay-date-split.e2e.mjs): gestartet nur über `spawnTracked`, beendet nur, was dieser
// Lauf gestartet hat oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt. Nur künstliche Testdaten.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { maus, mausText, tippe, waehle } from './_e2e-mouse.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids, clearTestClientPendingSaves } from './_e2e-process.mjs';
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
const OWNER_PW = 'tme-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-tme', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const T0 = Date.now();
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  aufraeumen();
  process.exit(1);
}, 30 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env,
  APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'),
  LATAIF_E2E_SYNC_PORT: String(PORT),
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
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
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
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  return c;
}
async function attach(cdpPort, exe, env) {
  spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  let seen = '(nichts)';
  try { seen = String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' '); } catch { /* egal */ }
  throw new Error(`waitFor ${sel} — Bildschirm sagt: ${seen}`);
}
async function warteBis(c, ausdruck, t = 30000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const SHELL = 'a[href="/settings"]';

// Beobachter am PC2: Fernaufträge und jeder Griff nach einer lokalen Datenbank.
const BEOBACHTER = `
  if (!window.__b1Installiert) {
  window.__b1Installiert = true;
  window.__cmds = []; window.__dbHits = [];
  window.alert = () => {}; window.confirm = () => true;
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    if (/\\/api\\/command$/.test(url)) {
      try { const body = JSON.parse((a[1] && a[1].body) || '{}'); window.__cmds.push({ op: body.op, payload: body.payload }); } catch (e) { /* kein Rumpf */ }
    }
    return of(...a);
  };
  }
`;
const DIALOGE_PRIMARY = 'window.alert = () => {}; window.confirm = () => true; return 1;';

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

let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
async function lade(c, route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(p, route) { await geh(p, '/tasks'); await sleep(700); await geh(p, route); await sleep(900); }
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);
let primary = null, client = null;

/** Der Primary spielt seine eigenen Änderungen als Echo wieder ein — vor jedem Vergleich zur Ruhe kommen lassen. */
async function syncRuhe(t = 75000) {
  const end = Date.now() + t;
  let angestossen = false;
  while (Date.now() < end) {
    await spuelen(primary);
    const offen = zahl('SELECT COUNT(*) AS n FROM sync_changelog WHERE synced = 0');
    const stand = zahl('SELECT COALESCE(MAX(last_sync_id), 0) AS m FROM sync_cursor');
    const kopf = Number(dbQ(SERVER_DB, 'SELECT COALESCE(MAX(id), 0) AS m FROM sync_changelog')[0]?.m || 0);
    if (offen === 0 && stand >= kopf) return true;
    if (!angestossen) {
      angestossen = true;
      await geh(primary, '/settings?tab=sync');
      if (await warteBis(primary, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sync Now')", 8000)) await clickText(primary, 'Sync Now');
    }
    await sleep(700);
  }
  console.log('      (sync) der Echo-Lauf des Primary kam nicht zur Ruhe');
  return false;
}
async function foto(c, name, sel) {
  const dir = process.env.LATAIF_SHOTS || '';
  if (!dir) return;
  try {
    const fsx = await import('node:fs');
    fsx.mkdirSync(dir, { recursive: true });
    if (sel) { await c.ev(`document.querySelector(${S(sel)})?.scrollIntoView({ block: 'start' }); return 1;`); await sleep(250); }
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fsx.writeFileSync(join(dir, name + '.png'), Buffer.from(r.data, 'base64'));
  } catch (e) { console.log('  (Foto ' + name + ' nicht möglich: ' + String(e).slice(0, 80) + ')'); }
}
async function dateiBis(pruefe, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await spuelen(primary).catch(() => null); if (pruefe()) return true; await sleep(700); }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// Die Welt des Laufs (künstliche Testdaten): zwei Kunden, sechs eigene Stücke im Lager (Einstand 200, geplant 800).
//   P (PC2):     tme-p1, tme-p2, tme-p3 an „Nadia Multi"   — tme-p3 ist der falsche Artikel
//   Q (Primary): tme-p4, tme-p5, tme-p6 an „Omar Primary"  — tme-p6 ist der falsche Artikel
// ══════════════════════════════════════════════════════════════════════════════
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    for (const [id, first, last] of [['tme-kunde', 'Nadia', 'Multi'], ['tme-kunde2', 'Omar', 'Primary']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    for (let i = 1; i <= 6; i++) {
      const id = 'tme-p' + i;
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Omega', name: 'TME Piece ' + i, sku: 'TME-P' + i, condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 200, purchase_currency: 'BHD', planned_sale_price: 800, stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 1, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: id + '-lot', branch_id, product_id: id, unit_cost: 200, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    }
  } finally { db.close(); }
}
const SZENEN = (process.env.E2E_SZENEN || '').toUpperCase();
const szene = (k) => !SZENEN || SZENEN.includes(k);

const transferVon = (pid) => dbQ(BIZ_DB, 'SELECT id, transfer_number AS nr, agent_price AS preis, settlement_model AS modell, excess_split_pct AS pct, status, revision FROM agent_transfers WHERE product_id = ?', [pid])[0] || null;
const kurz = (t) => (t ? `${Number(t.preis)} ${t.modell}${t.modell === 'split' ? ' ' + Number(t.pct) : ''} ${t.status}` : 'weg');
const stueck = (pid) => dbQ(BIZ_DB, 'SELECT stock_status AS s, source_type AS q FROM products WHERE id = ?', [pid])[0] || {};

/** Ein Feld über seine Beschriftung markieren, damit Maus und Tastatur es treffen. */
const markiereFeld = (c, label) => c.ev(`document.querySelectorAll('[data-e2e-feld]').forEach(x=>x.removeAttribute('data-e2e-feld'));
  const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();
  if(!l) return false; const e=l.parentElement.querySelector('input,textarea'); if(!e) return false; e.setAttribute('data-e2e-feld','1'); return true;`);
/** Einen Knopf in der Listenzeile eines Transfers markieren. */
const zeileKnopf = (c, nr, was) => c.ev(`document.querySelectorAll('[data-e2e-zeile]').forEach(x=>x.removeAttribute('data-e2e-zeile'));
  const row=[...document.querySelectorAll('div')].find(d=>d.style&&d.style.gridTemplateColumns&&d.style.cursor==='pointer'&&d.textContent.includes(${S(nr)}));
  if(!row) return 'KEINE-ZEILE:'+${S(nr)}; const el=row.querySelector('[data-transfer-'+${S(was)}+']'); if(!el) return 'KEIN-ELEMENT:'+${S(was)};
  el.setAttribute('data-e2e-zeile','1'); return 'OK';`);

/**
 * „New Transfer" wie ein Mensch: Kunde wählen, Artikel ankreuzen, gemeinsames Modell (und Anteil), je Artikel Preis per
 * Tastatur und auf Wunsch eigenes Modell/Anteil. `stuecke` = [[id, preis, [modell, anteil?] | null], …].
 */
async function neueUebergabe(c, kunde, stuecke, gemeinsam, gemeinsamPct) {
  const r = [];
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Transfer')", 40000))) return 'KEIN-KNOPF';
  r.push(await mausText(c, 'New Transfer'));
  if (!(await warteBis(c, "document.querySelector('[data-create-transfer]')", 15000))) return 'KEINE-MASKE';
  r.push(await maus(c, '[data-ss-trigger="Search clients..."]')); await sleep(400);
  r.push(await maus(c, `[data-ss-option="${kunde}"]`)); await sleep(300);
  for (const [id] of stuecke) {
    if (!(await warteBis(c, `document.querySelector('[data-transfer-product="${id}"]')`, 15000))) return 'KEIN-STUECK:' + id;
    r.push(await maus(c, `[data-transfer-product="${id}"]`)); await sleep(250);
  }
  if (gemeinsam === 'split') {
    r.push(await mausText(c, 'Our Price + Split')); await sleep(300);
    r.push((await markiereFeld(c, "SHOP'S SHARE OF EXCESS (%)")) ? 'OK' : 'KEIN-ANTEIL');
    r.push(await tippe(c, '[data-e2e-feld]', gemeinsamPct));
  }
  for (const [id, preis, eigen] of stuecke) {
    r.push(await tippe(c, `[data-transfer-item-price="${id}"]`, preis));
    if (eigen) {
      r.push(await waehle(c, `[data-transfer-item-model="${id}"]`, eigen[0])); await sleep(250);
      if (eigen[1] !== undefined) r.push(await tippe(c, `[data-transfer-item-pct="${id}"]`, eigen[1]));
    }
  }
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** Liste „Transfers" zeigen und warten, bis die Zeile da ist. */
async function zurListe(c, nr) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Transfers')", 40000))) return 'KEIN-REITER';
  const r = await mausText(c, 'Transfers');
  if (r !== 'OK') return r;
  return (await warteBis(c, `document.body.innerText.includes(${S(nr)})`, 30000)) ? 'OK' : 'KEINE-ZEILE:' + nr;
}
/** „Edit" in der Zeile eines Transfers ⇒ das Fenster „Edit Transfer". */
async function bearbeitenOeffnen(c, nr) {
  const l = await zurListe(c, nr);
  if (l !== 'OK') return l;
  const z = await zeileKnopf(c, nr, 'edit');
  if (z !== 'OK') return z;
  const m = await maus(c, '[data-e2e-zeile]');
  if (m !== 'OK') return m;
  return (await warteBis(c, "document.querySelector('[data-transfer-edit-modal]')", 15000)) ? 'OK' : 'KEIN-FENSTER';
}

try {
  assertE2eClientBinary(CLIENT_APP);
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  clearTestClientPendingSaves();
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'TME Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'TME Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'TME Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
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
  await primary.ev(DIALOGE_PRIMARY);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }
  client = await attach(CLIENT_CDP, CLIENT_APP, clientEnv());
  await waitInvoke(client);
  await client.ev('localStorage.clear(); return 1;');
  await client.ev('location.reload(); return 1;'); await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, '[data-first-run-gate]', 90000);
  await click(client, '[data-first-run-connect]');
  await waitFor(client, '[data-first-run-server]', 20000);
  await setVal(client, '[data-first-run-server]', `127.0.0.1:${PORT}`);
  await click(client, '[data-first-run-connect-go]');
  await sleep(3500);
  client.close(); client = await attachOnly(CLIENT_CDP);
  await waitFor(client, 'input[type="password"]', 60000);
  await setVal(client, 'input[type="email"]', OWNER_EMAIL);
  await setVal(client, 'input[type="password"]', OWNER_PW);
  await click(client, '[data-client-signin]');
  await waitFor(client, SHELL, 90000);
  ok(true, 'CONNECT frischer PC2 ohne Datenbank, Anmeldung');
  await beobachterLegen();
  await syncRuhe();

  // ── P PC2: drei Artikel, eigene Preise, gemeinsam Full, tme-p2 Split 40 % ⇒ EIN Auftrag, drei Transfers ──
  let p1 = null, p3 = null;
  if (szene('P')) {
    client = await lade(client, '/agents');
    const r = await neueUebergabe(client, 'tme-kunde', [['tme-p1', '900', null], ['tme-p2', '1200', ['split', '40']], ['tme-p3', '700', null]], 'full');
    ok(r === 'OK', `P PC2 „New Transfer": Kunde, drei Artikel, Preise, Modell je Artikel per Maus/Tastatur (${r})`);
    const knopf = String(await client.ev("return document.querySelector('[data-create-transfer]')?.textContent.trim() || '';"));
    ok(knopf === 'Transfer 3 items' && Number(await client.ev("return document.querySelectorAll('[data-transfer-item]').length;")) === 3,
      `P Maske: drei gewählte Artikel, Knopf „${knopf}"`);
    await foto(client, 'tme-p-pc2-new-transfer', '[data-transfer-selected]');
    const vor = (await kommandos(client)).filter((x) => x.op === 'transfers.create').length;
    ok(await maus(client, '[data-create-transfer]') === 'OK', 'P Maus auf „Transfer 3 items"');
    ok(await warteBis(client, "!document.querySelector('[data-create-transfer]')", 45000), 'P die Maske schließt nach dem Speichern');
    await dateiBis(() => ['tme-p1', 'tme-p2', 'tme-p3'].every((id) => transferVon(id)));
    const cm = (await kommandos(client)).filter((x) => x.op === 'transfers.create');
    ok(cm.length === vor + 1 && Array.isArray(cm.at(-1)?.payload?.items) && cm.at(-1).payload.items.length === 3,
      `P EIN Fernauftrag transfers.create mit drei items (${cm.length - vor}, ${S(cm.at(-1)?.payload?.items?.map((x) => x.productId))})`);
    const t = ['tme-p1', 'tme-p2', 'tme-p3'].map(transferVon);
    ok(S(t.map(kurz)) === S(['900 full transferred', '1200 split 40 transferred', '700 full transferred']),
      `P drei Transfers mit eigenem Preis und Modell (${S(t.map(kurz))})`);
    ok(new Set(t.map((x) => x?.nr)).size === 3 && t.every((x) => /^TRF-/.test(String(x?.nr))), `P je Artikel eine eigene Nummer (${t.map((x) => x?.nr).join(', ')})`);
    ok(['tme-p1', 'tme-p2', 'tme-p3'].every((id) => stueck(id).s === 'with_agent'), 'P alle drei Stücke sind „with_agent"');
    [p1, , p3] = t;

    // Bearbeiten: tme-p1 Preis 950, Split 30 %.
    const b = await bearbeitenOeffnen(client, p1.nr);
    ok(b === 'OK', `P PC2 „Edit" an ${p1.nr} öffnet „Edit Transfer" (${b})`);
    const sperre = await maus(client, '[data-transfer-remove-open]');
    ok(/^GESPERRT/.test(sperre) && await client.ev("return document.querySelector('[data-transfer-remove-open]')?.getAttribute('data-primary-only');") === 'delete',
      `P „Remove" ist am PC2 gesperrt und erklärt (${sperre})`);
    const e = [await tippe(client, '[data-transfer-edit-price]', '950'), await waehle(client, '[data-transfer-edit-model]', 'split')];
    await sleep(300);
    e.push(await tippe(client, '[data-transfer-edit-pct]', '30'));
    ok(e.every((x) => x === 'OK'), `P Tastatur: Preis 950, Modell Split, Anteil 30 (${e.join(',')})`);
    await foto(client, 'tme-p-pc2-edit', '[data-transfer-edit-modal]');
    const vorU = (await kommandos(client)).filter((x) => x.op === 'transfers.update').length;
    ok(await maus(client, '[data-transfer-save]') === 'OK', 'P Maus auf „Save"');
    await dateiBis(() => Number(transferVon('tme-p1')?.preis) === 950);
    const cu = (await kommandos(client)).filter((x) => x.op === 'transfers.update');
    const pl = cu.at(-1)?.payload || {};
    ok(cu.length === vorU + 1 && pl.agentPrice === 950 && pl.settlementModel === 'split' && pl.excessSplitPct === 30 && Number(pl.expectedRevision) > 0
      && Object.keys(pl).sort().join(',') === 'agentPrice,excessSplitPct,expectedRevision,id,settlementModel',
      `P EIN Fernauftrag transfers.update mit genau den geänderten Feldern (${S(pl)})`);
    ok(S(['tme-p1', 'tme-p2', 'tme-p3'].map((id) => kurz(transferVon(id)))) === S(['950 split 30 transferred', '1200 split 40 transferred', '700 full transferred']),
      `P nur der bearbeitete Transfer ändert sich (${S(['tme-p1', 'tme-p2', 'tme-p3'].map((id) => kurz(transferVon(id))))})`);
    ok(await warteBis(client, "!document.querySelector('[data-transfer-edit-modal]')", 15000), 'P das Fenster schließt nach dem Speichern');
  }

  // ── Q Primary: dieselbe Maske — gemeinsam Split 60 %, tme-p6 Full; bearbeiten; falschen Artikel entfernen ──
  if (szene('Q')) {
    await syncRuhe();
    await gehFrisch(primary, '/agents');
    const r = await neueUebergabe(primary, 'tme-kunde2', [['tme-p4', '1000', null], ['tme-p5', '1500', null], ['tme-p6', '600', ['full']]], 'split', '60');
    ok(r === 'OK', `Q Primary „New Transfer": gemeinsam Split 60 %, ein Artikel Full (${r})`);
    ok(await maus(primary, '[data-create-transfer]') === 'OK', 'Q Maus auf „Transfer 3 items"');
    ok(await warteBis(primary, "!document.querySelector('[data-create-transfer]')", 45000), 'Q die Maske schließt nach dem Speichern');
    await dateiBis(() => ['tme-p4', 'tme-p5', 'tme-p6'].every((id) => transferVon(id)));
    const t = ['tme-p4', 'tme-p5', 'tme-p6'].map(transferVon);
    ok(S(t.map(kurz)) === S(['1000 split 60 transferred', '1500 split 60 transferred', '600 full transferred']) && new Set(t.map((x) => x?.nr)).size === 3,
      `Q drei Transfers mit eigenem Preis und Modell, eigene Nummern (${S(t.map(kurz))})`);
    const [p4, p5, p6] = t;

    // Bearbeiten: tme-p5 Preis 1400, Full.
    ok(await bearbeitenOeffnen(primary, p5.nr) === 'OK', `Q Primary „Edit" an ${p5.nr}`);
    const e = [await tippe(primary, '[data-transfer-edit-price]', '1400'), await waehle(primary, '[data-transfer-edit-model]', 'full')];
    ok(e.every((x) => x === 'OK'), `Q Tastatur: Preis 1400, Modell Full (${e.join(',')})`);
    ok(await maus(primary, '[data-transfer-save]') === 'OK', 'Q Maus auf „Save"');
    await dateiBis(() => Number(transferVon('tme-p5')?.preis) === 1400);
    ok(kurz(transferVon('tme-p5')) === '1400 full transferred' && transferVon('tme-p5')?.pct == null && kurz(transferVon('tme-p4')) === '1000 split 60 transferred',
      `Q bearbeitet: 1400 Full ohne Anteil; der Nachbar unverändert (${kurz(transferVon('tme-p5'))} / ${kurz(transferVon('tme-p4'))})`);

    // Entfernen: tme-p6 ist der falsche Artikel — nichts gebucht ⇒ löschen, Stück zurück, Grund im Protokoll.
    const entfernen = async (nr, grund) => {
      const o = await bearbeitenOeffnen(primary, nr);
      if (o !== 'OK') return o;
      const a = await maus(primary, '[data-transfer-remove-open]');
      if (a !== 'OK') return 'OEFFNEN:' + a;
      await waitFor(primary, '[data-transfer-remove-plan]', 10000);
      const plan = String(await primary.ev("return document.querySelector('[data-transfer-remove-plan]')?.textContent || '';"));
      if (!/Nothing is booked yet/.test(plan)) return 'PLAN:' + plan.slice(0, 80);
      const vorGrund = await maus(primary, '[data-transfer-remove-confirm]');
      if (!/^GESPERRT/.test(vorGrund)) return 'OHNE-GRUND:' + vorGrund;
      const g = await tippe(primary, '[data-transfer-remove-reason]', grund);
      if (g !== 'OK') return 'GRUND:' + g;
      await foto(primary, 'tme-q-remove-' + nr, '[data-transfer-remove]');
      const k = await maus(primary, '[data-transfer-remove-confirm]');
      return k === 'OK' ? 'OK' : 'BESTAETIGEN:' + k;
    };
    const w6 = await entfernen(p6.nr, 'wrong item selected');
    ok(w6 === 'OK', `Q „Remove this transfer…" → Plan „Nothing is booked", ohne Grund gesperrt, mit Grund bestätigt (${w6})`);
    await dateiBis(() => !transferVon('tme-p6'));
    const au = dbQ(BIZ_DB, "SELECT action_type AS a, old_value AS o FROM audit_log WHERE entity_id = ? AND action_type = 'DELETE'", [p6.id]);
    ok(!transferVon('tme-p6') && stueck('tme-p6').s === 'in_stock' && stueck('tme-p6').q === 'OWN',
      `Q gelöscht, das Stück ist zurück im Lager (${kurz(transferVon('tme-p6'))}, ${S(stueck('tme-p6'))})`);
    ok(au.length === 1 && /wrong item selected/.test(String(au[0].o)) && String(au[0].o).includes(p6.nr), `Q Protokoll: DELETE mit Nummer und Grund (${String(au[0]?.o).slice(0, 120)})`);
    ok(kurz(transferVon('tme-p4')) === '1000 split 60 transferred' && kurz(transferVon('tme-p5')) === '1400 full transferred'
      && stueck('tme-p4').s === 'with_agent' && stueck('tme-p5').s === 'with_agent', 'Q die anderen Transfers derselben Übergabe sind unberührt');
    ok(await warteBis(primary, "!document.querySelector('[data-transfer-edit-modal]')", 15000)
      && !(await primary.ev(`return document.body.innerText.includes(${S(p6.nr)});`)), `Q die Liste zeigt ${p6.nr} nicht mehr`);

    // Der falsche Artikel aus der PC2-Übergabe: am Primary entfernt (Löschen bleibt am Primary) — PC2 zeigt ihn nicht mehr.
    if (p3 && p1) {
      const w3 = await entfernen(p3.nr, 'wrong item in PC2 hand-over');
      ok(w3 === 'OK', `Q PC2-Übergabe: ${p3.nr} am Primary entfernt (${w3})`);
      await dateiBis(() => !transferVon('tme-p3'));
      ok(!transferVon('tme-p3') && stueck('tme-p3').s === 'in_stock' && kurz(transferVon('tme-p1')) === '950 split 30 transferred' && kurz(transferVon('tme-p2')) === '1200 split 40 transferred',
        'Q PC2-Übergabe: tme-p3 gelöscht und im Lager, tme-p1/tme-p2 unberührt');
      await syncRuhe();
      client = await lade(client, '/agents');
      const l = await zurListe(client, p1.nr);
      const sicht = String(await client.ev('return document.body.innerText;'));
      ok(l === 'OK' && !sicht.includes(p3.nr) && sicht.includes(p1.nr), `Q PC2 zeigt dieselbe Liste: ${p1.nr} da, ${p3.nr} weg (${l})`);
      await foto(client, 'tme-q-pc2-list-after-remove');
    }
    ok(S(await treffer(client)) === '[]', 'PC2 griff nie nach einer lokalen Datenbank');
  }
} catch (e) {
  ok(false, 'ABBRUCH: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
} finally {
  clearTimeout(WACHHUND);
  try { client?.close(); } catch { /* zu */ }
  try { primary?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  aufraeumen();
}
console.log(`\ntransfer-multi-edit e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('TRANSFER_MULTI_EDIT_E2E_PROVED');
process.exit(0);
