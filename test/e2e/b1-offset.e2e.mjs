// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT B1 — Zwei-App-E2E: Verkaufsrechnung mit Darlehen „We Borrowed" verrechnen (ohne Geld).
// Run: node test/e2e/b1-offset.e2e.mjs
//
//   A  Primary: Rechnung A, „Settle Balance" mit der Maus ⇒ nur passende Darlehen (älteste zuerst), Vorschlag, Vorschau,
//      Teilverrechnung; Buchung Soll LOAN_PAYABLE / Haben AR, keine Geldbuchung, Gegenbeleg an der Rechnung.
//   B  PC2 (ohne Datenbank): Rechnung B schließen ⇒ „Final Number Type", EIN Fernauftrag, Endnummer am Primary.
//   C  PC2: „Remove offset" über den App-Dialog ⇒ Darlehen wieder offen (Gegenzeile), Endnummer bleibt, Rechnung offen.
//   D  Primary: Darlehen zeigt die Verrechnung (STL, Rechnung, „no cash").  E  PC2: Kundenkonto.  F  Sicherheit.
//
// PROZESS-ISOLATION (Gerüst aus customer-account.e2e.mjs): gestartet nur über `spawnTracked`, beendet nur, was dieser
// Lauf gestartet hat oder was am EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
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
const OWNER_PW = 'b1-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-b1-offset', 'run-' + Date.now());
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
// Die Welt des Laufs (künstliche Testdaten): Kunde „Basim Offset" mit zwei offenen Rechnungen und Darlehen.
//   Rechnung A PINV 1.000 offen · Rechnung B PINV 300 offen
//   We Borrowed L1 600 (älter) · L2 800 · fremder Kunde L3 500 · We Lent 300 (nie angeboten)
// ══════════════════════════════════════════════════════════════════════════════
const K = 'b1-kunde';
const INV_A = 'b1-inv-a', INV_B = 'b1-inv-b';
const L1 = 'b1-l1', L2 = 'b1-l2', L3 = 'b1-l3', LEND = 'b1-lend';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'customers', { id: K, branch_id, first_name: 'Basim', last_name: 'Offset', phone: '+973 3300 0101', created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'b1-andere', branch_id, first_name: 'Other', last_name: 'Client', phone: '+973 3900 0109', created_at: now, updated_at: now });
    const rechnung = (id, nr, gross, issued) => insert(db, 'invoices', { id, branch_id, invoice_number: nr, customer_id: K, status: 'PARTIAL', currency: 'BHD',
      net_amount: gross, vat_amount: 0, gross_amount: gross, paid_amount: 0, issued_at: issued, created_at: now, updated_at: now });
    rechnung(INV_A, 'PINV-2026-000951', 1000, '2026-10-20T09:00:00.000Z');
    rechnung(INV_B, 'PINV-2026-000952', 300, '2026-10-21T09:00:00.000Z');
    const darlehen = (id, dir, amount, customer, nr, created) => insert(db, 'debts', { id, branch_id, loan_number: nr, direction: dir, counterparty: 'Basim Offset',
      customer_id: customer, amount, source: 'cash', status: 'OPEN', created_at: created, updated_at: now });
    darlehen(L1, 'we_borrow', 600, K, 'LOA-2026-000951', '2026-10-16T09:00:00.000Z');
    darlehen(L2, 'we_borrow', 800, K, 'LOA-2026-000952', '2026-10-18T09:00:00.000Z');
    darlehen(L3, 'we_borrow', 500, 'b1-andere', 'LOA-2026-000953', '2026-10-16T09:00:00.000Z');
    darlehen(LEND, 'we_lend', 300, K, 'LOA-2026-000954', '2026-10-16T09:00:00.000Z');
  } finally { db.close(); }
}

const offen = (id) => {
  const r = dbQ(BIZ_DB, 'SELECT amount FROM debts WHERE id = ?', [id])[0] || { amount: 0 };
  const p = dbQ(BIZ_DB, 'SELECT COALESCE(SUM(amount), 0) AS s FROM debt_payments WHERE debt_id = ?', [id])[0] || { s: 0 };
  return Math.round((Number(r.amount) - Number(p.s)) * 1000) / 1000;
};
const rechnung = (id) => dbQ(BIZ_DB, 'SELECT status, paid_amount, invoice_number, special_mark FROM invoices WHERE id = ?', [id])[0] || {};
/** Nach einer Buchung: speichern lassen, bis die Datei den erwarteten Stand zeigt (höchstens `ms`). */
async function dateiBis(pruefe, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await spuelen(primary).catch(() => null); if (pruefe()) return true; await sleep(700); }
  return false;
}
const geldBuchungen = () => zahl("SELECT COUNT(*) AS n FROM ledger_entries WHERE account IN ('CASH','BANK','BENEFIT','CARD_CLEARING')");
const legsOf = (paymentId) => dbQ(BIZ_DB, "SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'PAYMENT' AND source_id = ? AND reverses_entry_id IS NULL ORDER BY account", [paymentId]);
/** Unbeteiligte Daten: was keine Verrechnung je ändern darf. */
const unbeteiligt = () => createHash('sha256').update(S([
  dbQ(BIZ_DB, 'SELECT id, amount, status, customer_id, direction FROM debts WHERE id IN (?, ?) ORDER BY id', [L3, LEND]),
  dbQ(BIZ_DB, 'SELECT id, first_name, last_name FROM customers ORDER BY id'),
])).digest('hex');
const dialogZeilen = (c) => c.ev("return JSON.stringify([...document.querySelectorAll('[data-settle-loan]')].map(e=>e.getAttribute('data-settle-loan')));").then((x) => JSON.parse(x || '[]'));
const wert = (c, sel) => c.ev(`return document.querySelector(${S(sel)})?.value ?? null;`);
const text = (c, sel) => c.ev(`return (document.querySelector(${S(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim();`);

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
  const UNB = unbeteiligt();
  const geld0 = geldBuchungen();

  // ── A Primary: Rechnung A (1.000), „Settle Balance" mit der Maus — Teilverrechnung mit L1 (600) ─────────────────────
  let stlA = '';
  {
    await gehFrisch(primary, `/invoices/${INV_A}`);
    await waitFor(primary, '[data-settle-balance]', 45000);
    ok(await mausKlick(primary, '[data-settle-balance]') === 'OK', 'A Maus auf „Settle Balance" (Rechnung A, Primary)');
    await waitFor(primary, '[data-settle-dialog]', 20000);
    const zeilen = await dialogZeilen(primary);
    ok(S(zeilen) === S(['LOA-2026-000951', 'LOA-2026-000952']), `A angeboten nur L1, L2 (älteste zuerst) — nicht fremder Kunde, nicht We Lent (${S(zeilen)})`);
    ok(await wert(primary, '[data-settle-amount]') === '600.000', 'A Vorschlag 600.000 (kleinerer Rest)');
    const vor = await text(primary, '[data-settle-preview]');
    ok(/Partially Paid · open 400\.000/.test(vor) && /Repaid · open 0\.000/.test(vor) && /no cash/.test(vor),
      `A Vorschau vor dem Bestätigen: Rechnung Partially Paid 400, Darlehen Repaid, „no cash" (${vor.slice(0, 170)})`);
    await foto(primary, 'b1-a-primary-dialog');
    ok(await mausKlick(primary, '[data-settle-confirm]') === 'OK', 'A Maus auf „Confirm offset"');
    const da = await warteBis(primary, "document.querySelector('[data-invoice-offset]')", 30000);
    if (!da) {
      console.log('      (A) Dialog sagt: ' + String(await primary.ev("return (document.querySelector('[data-settle-dialog]')?.innerText || '(kein Dialog)').slice(-400);")).replace(/\s+/g, ' '));
      await foto(primary, 'b1-a-primary-after-confirm');
    }
    await dateiBis(() => dbQ(BIZ_DB, 'SELECT id FROM party_offsets WHERE receivable_id = ?', [INV_A]).length > 0);
    const o = dbQ(BIZ_DB, 'SELECT * FROM party_offsets WHERE receivable_id = ?', [INV_A]);
    const pay = dbQ(BIZ_DB, 'SELECT id, amount, method, notes FROM payments WHERE invoice_id = ?', [INV_A]);
    stlA = String(o[0]?.offset_number || '');
    ok(da && o.length === 1 && o[0].status === 'ACTIVE' && Number(o[0].amount) === 600 && o[0].payable_id === L1 && /^STL-/.test(stlA),
      `A Datenbank: eine wirksame Verrechnung ${stlA} über 600 mit L1`);
    ok(pay.length === 1 && pay[0].method === 'debt_offset' && Number(pay[0].amount) === 600 && String(pay[0].notes).includes(stlA), 'A Rechnungszahlung „debt_offset" 600 nennt den Gegenbeleg');
    const legs = legsOf(pay[0]?.id).map((l) => [l.account, l.direction, Number(l.amount)]);
    ok(S(legs) === S([['ACCOUNTS_RECEIVABLE', 'CREDIT', 600], ['LOAN_PAYABLE', 'DEBIT', 600]]), `A Buchung Soll LOAN_PAYABLE / Haben AR 600 (${S(legs)})`);
    const ra = rechnung(INV_A);
    ok(ra.status === 'PARTIAL' && Number(ra.paid_amount) === 600 && offen(L1) === 0 && dbQ(BIZ_DB, 'SELECT status FROM debts WHERE id = ?', [L1])[0]?.status === 'REPAID',
      `A Rechnung PARTIAL (600 beglichen), L1 REPAID (${S([ra.status, ra.paid_amount, offen(L1)])})`);
    ok(geldBuchungen() === geld0, 'A keine Kassen-, Bank-, Benefit- oder Kartenbuchung');
    const zeile = await text(primary, '[data-invoice-offset]');
    ok(zeile.includes(stlA) && zeile.includes('LOA-2026-000951') && /Offset – no cash/.test(zeile), `A Rechnung zeigt Tag, ${stlA}, Darlehen, „Offset – no cash" (${zeile})`);
    ok(await exists(primary, '[data-invoice-payment-method="debt_offset"]'), 'A Zahlungszeile „Debt offset" in PAID');
    await foto(primary, 'b1-a-primary-invoice');
  }

  // ── B PC2: Rechnung B (300) mit L2 schließen — Endnummer, ein Fernauftrag, keine eigene Datenbank ────────────────────
  {
    await syncRuhe();
    client = await lade(client, `/invoices/${INV_B}`);
    await waitFor(client, '[data-settle-balance]', 45000);
    ok(await mausKlick(client, '[data-settle-balance]') === 'OK', 'B PC2: Maus auf „Settle Balance" (Rechnung B)');
    await waitFor(client, '[data-settle-dialog]', 20000);
    const zeilen = await dialogZeilen(client);
    ok(S(zeilen) === S(['LOA-2026-000952']), `B PC2 (vom Primary): nur L2 — L1 ist getilgt (${S(zeilen)})`);
    ok(await wert(client, '[data-settle-amount]') === '300.000', 'B Vorschlag 300.000');
    ok(/^Paid · open 0\.000/.test(await text(client, '[data-settle-preview-invoice]')), 'B Vorschau: Rechnung wird bezahlt');
    ok(await mausKlick(client, '[data-settle-confirm]') === 'OK', 'B Maus auf „Confirm offset"');
    await waitFor(client, '[data-final-number-confirm]', 15000);
    await foto(client, 'b1-b-pc2-final-number');
    ok(await mausKlick(client, '[data-final-number-confirm]') === 'OK', 'B schließt die Rechnung → „Final Number Type" gefragt, Maus auf „Confirm" (normal)');
    const da = await warteBis(client, "document.querySelector('[data-invoice-offset]')", 45000);
    await dateiBis(() => rechnung(INV_B).status === 'FINAL');
    const c = (await kommandos(client)).filter((x) => x.op === 'invoices.record_payment');
    const p0 = c[0]?.payload || {};
    ok(c.length === 1 && p0.method === 'debt_offset' && p0.debtId === L2 && p0.amount === 300 && !('customerId' in p0) && !('invoiceNumber' in p0),
      `B PC2 schickt EINEN Auftrag invoices.record_payment (debt_offset, Darlehen; Kunde/Nummer entscheidet der Primary) (${S(c.map((x) => x.payload))})`);
    const rb = rechnung(INV_B);
    ok(da && rb.status === 'FINAL' && Number(rb.paid_amount) === 300 && !String(rb.invoice_number).startsWith('PINV') && Number(rb.special_mark || 0) === 0,
      `B Primary: Rechnung B FINAL mit Endnummer ${rb.invoice_number}`);
    ok(offen(L2) === 500 && dbQ(BIZ_DB, 'SELECT status FROM debts WHERE id = ?', [L2])[0]?.status === 'PARTIALLY_REPAID', `B L2 Rest 500 (PARTIALLY_REPAID) (${offen(L2)})`);
    ok(geldBuchungen() === geld0, 'B keine Geldbuchung');
    const zeile = await text(client, '[data-invoice-offset]');
    ok(zeile.includes('LOA-2026-000952') && /Offset – no cash/.test(zeile), `B PC2 zeigt die Verrechnung mit Gegenbeleg (${zeile})`);
    ok((await treffer(client)).length === 0 && !existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'B PC2 weiter ohne eigene Datenbank');
    await foto(client, 'b1-b-pc2-invoice');
  }

  // ── C PC2: „Remove offset" (App-Dialog) — Darlehen wieder offen, Endnummer bleibt, Gegenzeile ──────────────────────
  {
    const nrB = rechnung(INV_B).invoice_number;
    ok(await mausKlick(client, '[data-invoice-offset-remove]') === 'OK', 'C PC2: Maus auf „Remove offset"');
    await waitFor(client, '[data-app-confirm]', 15000);
    const frage = await text(client, '[data-app-confirm-text]');
    ok(/Remove offset STL-.*LOA-2026-000952.*No cash moves/.test(frage), `C Rückfrage im App-Dialog (${frage.slice(0, 140)})`);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'C Maus auf „OK" im App-Dialog');
    const weg = await warteBis(client, "document.querySelector('[data-invoice-offset-status=\"REVERSED\"]')", 45000);
    await dateiBis(() => (dbQ(BIZ_DB, 'SELECT status FROM party_offsets WHERE receivable_id = ?', [INV_B])[0] || {}).status === 'REVERSED');
    const o = dbQ(BIZ_DB, 'SELECT status, reverse_reason FROM party_offsets WHERE receivable_id = ?', [INV_B])[0] || {};
    const rb = rechnung(INV_B);
    ok(weg && o.status === 'REVERSED' && offen(L2) === 800 && rb.status === 'PARTIAL' && Number(rb.paid_amount) === 0 && rb.invoice_number === nrB,
      `C aufgehoben: REVERSED (${o.reverse_reason}), L2 wieder 800, Rechnung B offen (PARTIAL), Endnummer bleibt ${rb.invoice_number} (${S([o.status, offen(L2), rb.status])})`);
    ok((await kommandos(client)).some((x) => x.op === 'invoices.delete_payment'), 'C PC2 schickt invoices.delete_payment');
    ok(zahl("SELECT COUNT(*) AS n FROM debt_payments WHERE debt_id = ? AND source = 'offset_reversal' AND amount < 0", [L2]) === 1, 'C Darlehen: Gegenzeile (offset_reversal), Verlauf bleibt');
    ok(geldBuchungen() === geld0, 'C keine Geldbuchung');
    ok(await exists(client, '[data-settle-balance]'), 'C Rechnung B ist wieder verrechenbar („Settle Balance" sichtbar)');
    await foto(client, 'b1-c-pc2-removed');
  }

  // ── D Primary: Darlehen L1 (Gegenbeleg) — Rückzahlungszeile „offset" mit Rechnung und STL ──────────────────────────
  {
    await gehFrisch(primary, '/debts?loan=LOA-2026-000951');
    const da = await warteBis(primary, "document.querySelector('[data-debt-payment-source=\"offset\"]')", 45000);
    const note = da ? await text(primary, '[data-debt-payment-source="offset"] [data-debt-payment-note]') : '';
    ok(da && note.includes(stlA) && note.includes('PINV-2026-000951') && /no cash/.test(note), `D Darlehen zeigt die Verrechnung: ${stlA}, Rechnung, „no cash" (${note})`);
    await foto(primary, 'b1-d-primary-loan');
  }

  // ── E PC2: Kundenkonto — Rechnung A Rest 400, L1 erledigt, Auszug mit Gegenbeleg ───────────────────────────────────
  {
    await syncRuhe();
    client = await lade(client, `/clients/${K}/account`);
    await waitFor(client, '[data-account-net]', 45000);
    const docs = JSON.parse(await client.ev("return JSON.stringify([...document.querySelectorAll('[data-account-doc]')].map(e=>e.getAttribute('data-account-doc')+':'+e.getAttribute('data-doc-open')));") || '[]');
    const auszug = await text(client, '[data-account-statement]');
    ok(docs.includes(`invoice:${INV_A}:400`) && docs.includes(`invoice:${INV_B}:300`) && (docs.includes(`debt:${L1}:0`) || !docs.some((d) => d.startsWith(`debt:${L1}:`))) && docs.includes(`debt:${L2}:800`),
      `E PC2 Kundenkonto: Rechnung A 400, B 300, L1 erledigt, L2 800 (${S(docs)})`);
    ok(auszug.includes(stlA) && /no cash/.test(auszug), 'E Kontoauszug nennt die Verrechnung mit Gegenbeleg und „no cash"');
    await foto(client, 'b1-e-pc2-account', '[data-account-statement]');
  }

  // ── F Sicherheit ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    ok(unbeteiligt() === UNB, 'F fremdes Darlehen, We Lent und Kunden unverändert');
    ok(zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE status = 'ACTIVE'") === 1 && zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE status = 'REVERSED'") === 1,
      'F genau eine wirksame (A) und eine aufgehobene (B) Verrechnung');
    ok(zahl("SELECT COUNT(*) AS n FROM ledger_entries WHERE source_module = 'LOAN_PAYMENT'") === 0, 'F die Darlehenszeilen buchen nicht selbst (keine Doppelbuchung)');
    ok((await treffer(client)).length === 0 && !existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'SAFETY PC2 ohne eigene Datenbank');
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
console.log(`\nb1-offset e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('CUSTOMER_ACCOUNT_B1_OFFSET_E2E_PROVED');
process.exit(0);
