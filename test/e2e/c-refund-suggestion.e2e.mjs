// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT C — Sichtprüfung Variante C (Owner 10.11.2026): die Rückgabemaske schlägt „Store Credit" vor, wenn die
// Rechnung ganz mit Store-Guthaben bezahlt ist; gemischt: keine Vorbelegung, Hinweis; nur bar: wie bisher „Bank Transfer".
// Primary und PC2 mit echter Maus, Bildschirmfotos. Es wird NICHTS gebucht (die Maske wird ohne Bestätigen geschlossen).
// Run: node test/e2e/c-refund-suggestion.e2e.mjs
//
// PROZESS-ISOLATION (Gerüst aus c-settle-balance.e2e.mjs): gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf
// gestartet hat oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt. Nur künstliche Testdaten.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses, closeTestWindow, startedPids, clearTestClientPendingSaves } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'rs-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-c-refund', 'run-' + Date.now());
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
const T0 = Date.now();
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); killTestImage('lataif-e2e-client.exe'); };
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  aufraeumen();
  process.exit(1);
}, 40 * 60 * 1000);

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

/** Echte Maus über CDP: Element in die Mitte holen, Mitte anfahren, drücken, loslassen. */
async function mausKlick(c, sel) {
  const p = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return null; if (e.disabled) return 'DISABLED'; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2, y:r.top+r.height/2});`);
  if (!p || p === 'DISABLED') return 'NO-MAUS:' + sel + (p ? ':DISABLED' : '');
  const { x, y } = JSON.parse(p);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return 'OK';
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




// ══════════════════════════════════════════════════════════════════════════════
// Die Welt des Laufs: Kundin „Sara Credit" mit drei bezahlten Rechnungen (je eine Zeile).
//   A 500 nur Store Credit · B 1.000 = 400 bar + 600 Store Credit · C 300 nur bar
// ══════════════════════════════════════════════════════════════════════════════
const K = 'rs-kunde';
const INV_A = 'rs-inv-a', INV_B = 'rs-inv-b', INV_C = 'rs-inv-c';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const cat = (db.prepare('SELECT id FROM categories LIMIT 1').get() || {}).id || 'cat-rs';
    if (cat === 'cat-rs') insert(db, 'categories', { id: cat, branch_id, name: 'Watches', created_at: new Date().toISOString() });
    const now = new Date().toISOString();
    insert(db, 'customers', { id: K, branch_id, first_name: 'Sara', last_name: 'Credit', phone: '+973 3300 0301', created_at: now, updated_at: now });
    const rechnung = (id, nr, gross, zahlungen) => {
      const pid = `${id}-p`;
      insert(db, 'products', { id: pid, branch_id, category_id: cat, brand: 'Rolex', name: `Item ${nr}`, sku: `SKU-${id}`, quantity: 0, condition: 'Pre-Owned',
        scope_of_delivery: '[]', purchase_price: 0, purchase_currency: 'BHD', planned_sale_price: gross, stock_status: 'sold', tax_scheme: 'ZERO',
        days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'invoices', { id, branch_id, invoice_number: nr, customer_id: K, status: 'FINAL', currency: 'BHD', net_amount: gross, vat_amount: 0,
        gross_amount: gross, paid_amount: gross, issued_at: '2026-10-20T09:00:00.000Z', number_finalized_at: '2026-10-20T09:00:00.000Z', created_at: now, updated_at: now });
      insert(db, 'invoice_lines', { id: `${id}-l1`, invoice_id: id, product_id: pid, quantity: 1, unit_price: gross, vat_rate: 0, tax_scheme: 'ZERO',
        vat_amount: 0, line_total: gross, position: 1 });
      zahlungen.forEach(([method, amount], k) => insert(db, 'payments', { id: `${id}-pay${k}`, branch_id, invoice_id: id, amount, method,
        received_at: '2026-10-20T10:00:00.000Z', created_at: now }));
    };
    rechnung(INV_A, 'INV-2026-000971', 500, [['credit', 500]]);
    rechnung(INV_B, 'INV-2026-000972', 1000, [['cash', 400], ['credit', 600]]);
    rechnung(INV_C, 'INV-2026-000973', 300, [['cash', 300]]);
  } finally { db.close(); }
}
const text = (c, sel) => c.ev(`return (document.querySelector(${S(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim();`);
/** Echte Maus auf einen Knopf mit genau diesem Text. */
async function mausText(c, t) {
  const p = await c.ev(`const e=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2, y:r.top+r.height/2});`);
  if (!p) return 'NO-MAUS:' + t;
  const { x, y } = JSON.parse(p);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return 'OK';
}
const aktiv = (c) => c.ev("return document.querySelector('[data-return-refund-active=\"1\"]')?.getAttribute('data-return-refund-method') || '';");
const hinweis = (c) => c.ev("return document.querySelector('[data-return-refund-suggestion]')?.getAttribute('data-return-refund-suggestion') || '';");
const zaehlerBuchungen = () => zahl('SELECT COUNT(*) AS n FROM ledger_entries') + zahl('SELECT COUNT(*) AS n FROM sales_returns') + zahl('SELECT COUNT(*) AS n FROM credit_notes');
/** Rechnung öffnen, „Create Return" mit der Maus, Vorbelegung und Hinweis lesen, Foto, Maske schließen (Cancel). */
async function pruefe(c, wo, inv, erwartet, hinweisErwartet, foto_) {
  await gehFrisch(c, `/invoices/${inv}`);
  const da = await warteBis(c, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Create Return')", 45000);
  ok(da && await mausText(c, 'Create Return') === 'OK', `${wo} ${inv}: Maus auf „Create Return"`);
  await waitFor(c, '[data-return-refund-method]', 20000);
  await sleep(400);
  const a = await aktiv(c), h = await hinweis(c);
  ok(a === erwartet && h === hinweisErwartet, `${wo} ${inv}: vorbelegt „${a}" (erwartet ${erwartet}), Hinweis „${h || '—'}" (erwartet ${hinweisErwartet || '—'})`);
  if (hinweisErwartet) {
    const t = await text(c, '[data-return-refund-suggestion]');
    ok(hinweisErwartet === 'all_store_credit' ? /Store Credit is suggested/.test(t) && /money refund can still be chosen/.test(t)
      : /600\.000/.test(t) && /400\.000/.test(t) && /not preselected/.test(t), `${wo} ${inv}: Hinweistext (${t.slice(0, 160)})`);
  }
  await foto(c, foto_, '[data-return-refund-method]');
  return a;
}

try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'CA Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'CA Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'CA Admin');
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
  const vorher = zaehlerBuchungen();

  // ── P Primary: drei Rechnungen ──────────────────────────────────────────────────────────────────────────────
  await primary.ev(DIALOGE_PRIMARY);
  await pruefe(primary, 'P', INV_A, 'credit', 'all_store_credit', 'rs-p-a-store-credit');
  // Der Benutzer darf ausdrücklich Geld wählen.
  ok(await mausKlick(primary, '[data-return-refund-method="cash"]') === 'OK' && await aktiv(primary) === 'cash', 'P A: Maus auf „Cash" — Geld-Erstattung ausdrücklich wählbar');
  await foto(primary, 'rs-p-a-cash-chosen', '[data-return-refund-method]');
  await mausText(primary, 'Cancel');
  await pruefe(primary, 'P', INV_B, 'bank', 'mixed_store_credit', 'rs-p-b-mixed');
  await mausText(primary, 'Cancel');
  await pruefe(primary, 'P', INV_C, 'bank', '', 'rs-p-c-cash');
  await mausText(primary, 'Cancel');

  // ── C PC2 (vom Primary): dieselbe Regel ───────────────────────────────────────────────────────────────────────
  client = await lade(client, `/invoices/${INV_A}`);
  await pruefe(client, 'PC2', INV_A, 'credit', 'all_store_credit', 'rs-c-a-store-credit');
  await mausText(client, 'Cancel');
  await pruefe(client, 'PC2', INV_B, 'bank', 'mixed_store_credit', 'rs-c-b-mixed');
  await mausText(client, 'Cancel');

  // ── S Sicherheit: nichts gebucht, PC2 ohne Datenbank ───────────────────────────────────────────────────────────
  await spuelen(primary).catch(() => null);
  ok(zaehlerBuchungen() === vorher, 'S nur angesehen: keine Rückgabe, keine Gutschrift, keine Buchung');
  ok((await kommandos(client)).filter((x) => /^returns\./.test(String(x.op))).length === 0, 'S PC2 hat keinen Rückgabeauftrag geschickt');
  ok((await treffer(client)).length === 0 && !existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SAFETY PC2 ohne eigene Datenbank');
} catch (e) {
  ok(false, 'ABBRUCH: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
} finally {
  clearTimeout(WACHHUND);
  try { client?.close(); } catch { /* zu */ }
  try { primary?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  aufraeumen();
}
console.log(`\nc-refund-suggestion e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('CUSTOMER_ACCOUNT_C_REFUND_SUGGESTION_E2E_PROVED');
process.exit(0);
