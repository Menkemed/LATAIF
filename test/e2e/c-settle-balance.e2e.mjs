// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT C — Zwei-App-E2E: „Settle Balance" im Kundenkonto (Store Credit + We Borrowed gegen Rechnungen, ohne Geld).
// Run: node test/e2e/c-settle-balance.e2e.mjs
//
//   A  Primary: Konto → „Settle Balance" mit der Maus ⇒ Reihenfolge, Häkchen abwählen ⇒ Vorschlag neu, Endnummer (Special),
//      EINE STL mit drei Zuordnungen; Buchungen ohne Geld.
//   B  PC2 (ohne Datenbank): Rest verrechnen ⇒ zwei Rechnungen voll bezahlt, Endnummern je Rechnung, EIN Fernauftrag.
//   C  PC2: „Undo settlement" (App-Dialog) ⇒ ganze STL aufgehoben, Endnummer bleibt, Guthaben und Darlehen wieder offen.
//   D  Primary: Rechnung zeigt die Zuordnungen; „Remove offset" einer einzelnen Zuordnung.
//   E  PC2: veralteter Stand ⇒ nichts gebucht, Hinweis, neuer Vorschlag.   F  Sicherheit.
//
// PROZESS-ISOLATION (Gerüst aus b1-offset.e2e.mjs): gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf
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
const OWNER_PW = 'c-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-c-settle', 'run-' + Date.now());
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
// Die Welt des Laufs (künstliche Testdaten): Kundin „Cara Settle".
//   Rechnungen A 500 · B 800 · C 300 (offen) · Store Credit SC1 200 · We Borrowed L1 600 (älter), L2 1.000
//   fremder Kunde L3 500 · We Lent 300 (nie angeboten)
// ══════════════════════════════════════════════════════════════════════════════
const K = 'c-kunde';
const INV_A = 'c-inv-a', INV_B = 'c-inv-b', INV_C = 'c-inv-c';
const SC1 = 'c-sc1';
const L1 = 'c-l1', L2 = 'c-l2', L3 = 'c-l3', LEND = 'c-lend';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'customers', { id: K, branch_id, first_name: 'Cara', last_name: 'Settle', phone: '+973 3300 0201', created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'c-andere', branch_id, first_name: 'Other', last_name: 'Client', phone: '+973 3900 0209', created_at: now, updated_at: now });
    const rechnung = (id, nr, gross, issued) => insert(db, 'invoices', { id, branch_id, invoice_number: nr, customer_id: K, status: 'PARTIAL', currency: 'BHD',
      net_amount: gross, vat_amount: 0, gross_amount: gross, paid_amount: 0, issued_at: issued, created_at: now, updated_at: now });
    rechnung(INV_A, 'PINV-2026-000961', 500, '2026-10-20T09:00:00.000Z');
    rechnung(INV_B, 'PINV-2026-000962', 800, '2026-10-21T09:00:00.000Z');
    rechnung(INV_C, 'PINV-2026-000963', 300, '2026-10-22T09:00:00.000Z');
    insert(db, 'customer_credits', { id: SC1, branch_id, customer_id: K, amount: 200, used_amount: 0, status: 'OPEN', source_type: 'overpayment',
      created_at: '2026-10-10T09:00:00.000Z' });
    const darlehen = (id, dir, amount, customer, nr, created) => insert(db, 'debts', { id, branch_id, loan_number: nr, direction: dir, counterparty: 'Cara Settle',
      customer_id: customer, amount, source: 'cash', status: 'OPEN', created_at: created, updated_at: now });
    darlehen(L1, 'we_borrow', 600, K, 'LOA-2026-000961', '2026-10-16T09:00:00.000Z');
    darlehen(L2, 'we_borrow', 1000, K, 'LOA-2026-000962', '2026-10-18T09:00:00.000Z');
    darlehen(L3, 'we_borrow', 500, 'c-andere', 'LOA-2026-000963', '2026-10-16T09:00:00.000Z');
    darlehen(LEND, 'we_lend', 300, K, 'LOA-2026-000964', '2026-10-16T09:00:00.000Z');
  } finally { db.close(); }
}

const offen = (id) => {
  const r = dbQ(BIZ_DB, 'SELECT amount FROM debts WHERE id = ?', [id])[0] || { amount: 0 };
  const p = dbQ(BIZ_DB, 'SELECT COALESCE(SUM(amount), 0) AS s FROM debt_payments WHERE debt_id = ?', [id])[0] || { s: 0 };
  return Math.round((Number(r.amount) - Number(p.s)) * 1000) / 1000;
};
const rechnung = (id) => dbQ(BIZ_DB, 'SELECT status, paid_amount, invoice_number, special_mark FROM invoices WHERE id = ?', [id])[0] || {};
const guthaben = () => dbQ(BIZ_DB, 'SELECT used_amount, status FROM customer_credits WHERE id = ?', [SC1])[0] || {};
async function dateiBis(pruefe, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await spuelen(primary).catch(() => null); if (pruefe()) return true; await sleep(700); }
  return false;
}
const geldBuchungen = () => zahl("SELECT COUNT(*) AS n FROM ledger_entries WHERE account IN ('CASH','BANK','BENEFIT','CARD_CLEARING')");
const unbeteiligt = () => createHash('sha256').update(S([
  dbQ(BIZ_DB, 'SELECT id, amount, status, customer_id, direction FROM debts WHERE id IN (?, ?) ORDER BY id', [L3, LEND]),
  dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM debt_payments WHERE debt_id IN (?, ?)", [L3, LEND]),
])).digest('hex');
const text = (c, sel) => c.ev(`return (document.querySelector(${S(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim();`);
const attrs = (c, sel, a) => c.ev(`return JSON.stringify([...document.querySelectorAll(${S(sel)})].map(e=>e.getAttribute(${S(a)})));`).then((x) => JSON.parse(x || '[]'));
const stlRows = (nr) => dbQ(BIZ_DB, 'SELECT offset_number, payable_type, payable_id, receivable_id, amount, status FROM party_offsets WHERE settlement_number = ? ORDER BY offset_number', [nr]);

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
  const checkbox = (sel) => `${sel} input[type="checkbox"]`;

  // ── A Primary: Konto → Settle Balance; C und L2 abwählen ⇒ A←SC1 200, A←L1 300, B←L1 300; A Special ─────────────────
  let stl1 = '';
  {
    await gehFrisch(primary, `/clients/${K}/account`);
    await waitFor(primary, '[data-account-settle]', 45000);
    ok(await mausKlick(primary, '[data-account-settle]') === 'OK', 'A Primary: Maus auf „Settle Balance" im Kundenkonto');
    await waitFor(primary, '[data-settle-balance]', 20000);
    const inv = await attrs(primary, '[data-settle-invoice]', 'data-settle-invoice');
    const src = await attrs(primary, '[data-settle-source]', 'data-settle-source');
    ok(S(inv) === S(['PINV-2026-000961', 'PINV-2026-000962', 'PINV-2026-000963']), `A links die offenen Rechnungen, älteste zuerst (${S(inv)})`);
    ok(S(src) === S(['Store credit', 'LOA-2026-000961', 'LOA-2026-000962']), `A rechts Store Credit, dann We Borrowed (älteste zuerst) — kein fremdes Darlehen, kein We Lent (${S(src)})`);
    ok(await text(primary, '[data-settle-total]') === '1600.000 BHD' || (await attrs(primary, '[data-settle-total]', 'data-settle-total'))[0] === '1600.000', 'A Vorschlag mit allem: 1.600');
    ok(await mausKlick(primary, checkbox('[data-settle-invoice="PINV-2026-000963"]')) === 'OK' && await mausKlick(primary, checkbox('[data-settle-source="LOA-2026-000962"]')) === 'OK',
      'A Maus: Rechnung C und Darlehen L2 abgewählt');
    await warteBis(primary, "document.querySelector('[data-settle-pairs=\"3\"]')", 5000);
    const paare = await attrs(primary, '[data-settle-pair]', 'data-settle-pair');
    ok(S(paare) === S(['Store credit>PINV-2026-000961', 'LOA-2026-000961>PINV-2026-000961', 'LOA-2026-000961>PINV-2026-000962'])
      && (await attrs(primary, '[data-settle-total]', 'data-settle-total'))[0] === '800.000',
    `A Vorschlag sofort neu: SC1→A, L1→A, L1→B, Summe 800 (${S(paare)})`);
    const summe = await text(primary, '[data-settle-summary]');
    ok(/Fully paid: PINV-2026-000961/.test(summe) && /Stay partly open: PINV-2026-000962 \(500\.000\)/.test(summe) && /unchanged/.test(summe),
      `A Vorschau: A voll bezahlt, B bleibt 500 offen, Nettosaldo unverändert (${summe.slice(0, 220)})`);
    await foto(primary, 'c-a-primary-dialog');
    ok(await mausKlick(primary, '[data-settle-confirm]') === 'OK', 'A Maus auf „Confirm settlement"');
    await waitFor(primary, '[data-settle-numbers]', 15000);
    const fuer = await attrs(primary, '[data-settle-number-for]', 'data-settle-number-for');
    ok(S(fuer) === S(['PINV-2026-000961']), `A Endnummer nur für die voll bezahlte Rechnung gefragt (${S(fuer)})`);
    ok(await mausKlick(primary, '[data-settle-number-for="PINV-2026-000961"] [data-settle-number-choice="special"]') === 'OK', 'A Maus: Special Final');
    await foto(primary, 'c-a-primary-numbers');
    ok(await mausKlick(primary, '[data-settle-numbers-confirm]') === 'OK', 'A Maus auf „Confirm settlement" (Endnummern)');
    const da = await warteBis(primary, "document.querySelector('[data-account-settled]')", 30000);
    await dateiBis(() => zahl('SELECT COUNT(*) AS n FROM party_offsets WHERE settlement_number IS NOT NULL') >= 3);
    stl1 = String(dbQ(BIZ_DB, 'SELECT settlement_number FROM party_offsets WHERE settlement_number IS NOT NULL ORDER BY created_at LIMIT 1')[0]?.settlement_number || '');
    const rows = stlRows(stl1);
    ok(da && /^STL-\d{4}-\d{6}$/.test(stl1) && rows.length === 3 && rows.every((r) => r.status === 'ACTIVE')
      && S(rows.map((r) => [r.offset_number, r.payable_type, Number(r.amount)])) === S([[`${stl1}/1`, 'STORE_CREDIT', 200], [`${stl1}/2`, 'DEBT', 300], [`${stl1}/3`, 'DEBT', 300]]),
    `A Datenbank: EINE STL ${stl1} mit drei Zuordnungen (${S(rows.map((r) => [r.offset_number, r.payable_type, r.amount]))})`);
    const ra = rechnung(INV_A), rb = rechnung(INV_B);
    ok(ra.status === 'FINAL' && String(ra.invoice_number).startsWith('SINV-') && Number(ra.special_mark) === 1 && rb.status === 'PARTIAL' && Number(rb.paid_amount) === 300,
      `A Rechnung A Paid mit Special-Endnummer ${ra.invoice_number}; B Partially Paid 300 (${S([ra.status, rb.status, rb.paid_amount])})`);
    ok(Number(guthaben().used_amount) === 200 && offen(L1) === 0 && offen(L2) === 1000, `A Guthaben verbraucht, L1 getilgt, L2 unberührt (${S([guthaben(), offen(L1), offen(L2)])})`);
    ok(geldBuchungen() === geld0, 'A keine Kassen-, Bank-, Benefit- oder Kartenbuchung');
    const ban = await text(primary, '[data-account-settled]');
    ok(ban.includes(stl1) && /3 offsets/.test(ban) && /800\.000/.test(ban) && /No cash/.test(ban), `A Hinweis im Konto: ${ban}`);
    ok(await exists(primary, `[data-settlement="${stl1}"][data-settlement-status="ACTIVE"]`), 'A Settlement-Übersicht zeigt die STL mit allen Zuordnungen');
    await foto(primary, 'c-a-primary-account', '[data-settlements]');
  }

  // ── B PC2: Rest verrechnen — B←L2 500, C←L2 300; zwei Endnummern (C Special); EIN Fernauftrag ───────────────────────
  let stl2 = '';
  {
    await syncRuhe();
    client = await lade(client, `/clients/${K}/account`);
    await waitFor(client, '[data-account-settle]', 45000);
    ok(await mausKlick(client, '[data-account-settle]') === 'OK', 'B PC2: Maus auf „Settle Balance"');
    await waitFor(client, '[data-settle-balance]', 20000);
    const inv = await attrs(client, '[data-settle-invoice]', 'data-settle-invoice');
    const src = await attrs(client, '[data-settle-source]', 'data-settle-source');
    ok(S(inv) === S(['PINV-2026-000962', 'PINV-2026-000963']) && S(src) === S(['LOA-2026-000962']), `B PC2 (vom Primary): B, C gegen L2 (${S(inv)} / ${S(src)})`);
    const paare = await attrs(client, '[data-settle-pair]', 'data-settle-pair');
    ok(S(paare) === S(['LOA-2026-000962>PINV-2026-000962', 'LOA-2026-000962>PINV-2026-000963']), `B Vorschlag L2→B 500, L2→C 300 (${S(paare)})`);
    ok(await mausKlick(client, '[data-settle-confirm]') === 'OK', 'B Maus auf „Confirm settlement"');
    await waitFor(client, '[data-settle-numbers]', 15000);
    const fuer = await attrs(client, '[data-settle-number-for]', 'data-settle-number-for');
    ok(S(fuer) === S(['PINV-2026-000962', 'PINV-2026-000963']), `B Endnummer je voll bezahlter Rechnung gefragt (${S(fuer)})`);
    ok(await mausKlick(client, '[data-settle-number-for="PINV-2026-000963"] [data-settle-number-choice="special"]') === 'OK', 'B Maus: C Special, B bleibt Normal');
    ok(await mausKlick(client, '[data-settle-numbers-confirm]') === 'OK', 'B Maus auf „Confirm settlement"');
    const da = await warteBis(client, "document.querySelector('[data-account-settled]')", 45000);
    await dateiBis(() => rechnung(INV_C).status === 'FINAL');
    const c = (await kommandos(client)).filter((x) => x.op === 'customers.settle_balance');
    const p0 = c[0]?.payload?.input || c[0]?.payload || {};
    ok(c.length === 1 && Array.isArray(p0.invoiceIds) && Array.isArray(p0.sourceIds) && typeof p0.expectedStamp === 'string' && p0.expectedTotal === 800
      && p0.finalNumbers && p0.finalNumbers[INV_C] === 'special' && p0.finalNumbers[INV_B] === 'normal' && !('lines' in p0) && !('allocations' in p0),
    `B PC2 schickt EINEN Auftrag customers.settle_balance — nur Auswahl, Stand, Summe, Endnummernwahl (${S(c.map((x) => x.payload))})`);
    stl2 = String(dbQ(BIZ_DB, 'SELECT settlement_number FROM party_offsets WHERE settlement_number IS NOT NULL AND settlement_number != ? ORDER BY created_at LIMIT 1', [stl1])[0]?.settlement_number || '');
    const rb = rechnung(INV_B), rc = rechnung(INV_C);
    ok(da && /^STL-/.test(stl2) && stlRows(stl2).length === 2 && rb.status === 'FINAL' && String(rb.invoice_number).startsWith('INV-') && rc.status === 'FINAL' && String(rc.invoice_number).startsWith('SINV-'),
      `B Primary: ${stl2} zwei Zuordnungen; B ${rb.invoice_number}, C ${rc.invoice_number}`);
    ok(offen(L2) === 200 && geldBuchungen() === geld0, `B L2 Rest 200, keine Geldbuchung (${offen(L2)})`);
    ok((await treffer(client)).length === 0 && !existsSync(join(CLIENT_DATA_DIR, 'lataif.db')), 'B PC2 weiter ohne eigene Datenbank');
    await foto(client, 'c-b-pc2-account', '[data-settlements]');
  }

  // ── C PC2: ganze erste STL rückgängig (App-Dialog) — Endnummer bleibt ──────────────────────────────────────────────
  {
    const nrA = rechnung(INV_A).invoice_number;
    await waitFor(client, `[data-settlement-undo="${stl1}"]`, 20000);
    ok(await mausKlick(client, `[data-settlement-undo="${stl1}"]`) === 'OK', `C PC2: Maus auf „Undo settlement" (${stl1})`);
    await waitFor(client, '[data-app-confirm]', 15000);
    // Der App-Dialog zeigt die erste Zeile als Frage und den Rest als Erläuterung — beides lesen.
    const frage = await text(client, '[data-app-confirm]');
    ok(frage.includes(stl1) && /No cash moves/.test(frage) && /Final invoice numbers stay/.test(frage), `C Rückfrage im App-Dialog (${frage.slice(0, 200)})`);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'C Maus auf „OK"');
    const weg = await warteBis(client, `document.querySelector('[data-settlement="${stl1}"][data-settlement-status="REVERSED"]')`, 45000);
    await dateiBis(() => stlRows(stl1).every((r) => r.status === 'REVERSED'));
    const ra = rechnung(INV_A), rb = rechnung(INV_B);
    ok(weg && stlRows(stl1).every((r) => r.status === 'REVERSED') && ra.status === 'PARTIAL' && Number(ra.paid_amount) === 0 && ra.invoice_number === nrA
      && rb.status === 'PARTIAL' && Number(rb.paid_amount) === 500,
    `C ganze STL aufgehoben: A wieder offen (Endnummer bleibt ${ra.invoice_number}), B nur noch STL2 500 (${S([ra.status, rb.status, rb.paid_amount])})`);
    ok(Number(guthaben().used_amount) === 0 && guthaben().status === 'OPEN' && offen(L1) === 600, `C Guthaben und L1 wieder ganz offen (${S([guthaben(), offen(L1)])})`);
    ok((await kommandos(client)).filter((x) => x.op === 'customers.settlement_reverse').length === 1, 'C PC2 schickt EINEN Auftrag customers.settlement_reverse');
    ok(geldBuchungen() === geld0, 'C keine Geldbuchung');
    await foto(client, 'c-c-pc2-undone', '[data-settlements]');
  }

  // ── D Primary: Rechnung B zeigt die Zuordnungen; eine einzelne entfernen ───────────────────────────────────────────
  {
    await syncRuhe();
    await gehFrisch(primary, `/invoices/${INV_B}`);
    await warteBis(primary, `document.querySelector('[data-invoice-offset="${stl2}/1"]')`, 45000);
    const status = await attrs(primary, '[data-invoice-offset]', 'data-invoice-offset-status');
    const nummern = await attrs(primary, '[data-invoice-offset]', 'data-invoice-offset');
    ok(nummern.includes(`${stl1}/3`) && nummern.includes(`${stl2}/1`) && status.includes('REVERSED') && status.includes('ACTIVE'),
      `D Rechnung B: ${stl1}/3 aufgehoben, ${stl2}/1 wirksam (${S(nummern)} ${S(status)})`);
    const zeile = await text(primary, `[data-invoice-offset="${stl2}/1"]`);
    ok(zeile.includes(stl2) && /settlement/.test(zeile) && zeile.includes('LOA-2026-000962') && /Offset – no cash/.test(zeile), `D Zeile mit STL, Gegenbeleg, „Offset – no cash" (${zeile})`);
    ok(await mausKlick(primary, `[data-invoice-offset="${stl2}/1"] [data-invoice-offset-remove]`) === 'OK', 'D Maus auf „Remove offset" (eine Zuordnung)');
    await dateiBis(() => (stlRows(stl2).find((r) => r.offset_number === `${stl2}/1`) || {}).status === 'REVERSED');
    const rb = rechnung(INV_B);
    ok(rb.status === 'PARTIAL' && Number(rb.paid_amount) === 0 && String(rb.invoice_number).startsWith('INV-') && offen(L2) === 700,
      `D eine Zuordnung entfernt: B wieder offen 800 (Endnummer bleibt), L2 offen 700 (${S([rb.status, rb.paid_amount, offen(L2)])})`);
    ok(geldBuchungen() === geld0, 'D keine Geldbuchung');
    await foto(primary, 'c-d-primary-invoice');
  }

  // ── E PC2: veralteter Stand — inzwischen ändert der Primary etwas ⇒ nichts gebucht, Hinweis, neuer Vorschlag ─────────
  {
    await syncRuhe();
    client = await lade(client, `/clients/${K}/account`);
    await waitFor(client, '[data-account-settle]', 45000);
    ok(await mausKlick(client, '[data-account-settle]') === 'OK', 'E PC2: „Settle Balance" geöffnet');
    await waitFor(client, '[data-settle-balance]', 20000);
    const vorher = (await attrs(client, '[data-settle-total]', 'data-settle-total'))[0];
    // Der Primary hebt inzwischen die letzte Zuordnung der zweiten STL auf (C wird wieder offen, L2 wieder 1.000).
    await gehFrisch(primary, `/invoices/${INV_C}`);
    await warteBis(primary, `document.querySelector('[data-invoice-offset="${stl2}/2"] [data-invoice-offset-remove]')`, 30000);
    ok(await mausKlick(primary, `[data-invoice-offset="${stl2}/2"] [data-invoice-offset-remove]`) === 'OK', 'E Primary entfernt inzwischen die andere Zuordnung');
    await dateiBis(() => stlRows(stl2).every((r) => r.status === 'REVERSED'));
    const zaehler = zahl('SELECT COUNT(*) AS n FROM party_offsets');
    ok(await mausKlick(client, '[data-settle-confirm]') === 'OK', 'E PC2: „Confirm settlement" mit dem alten Stand');
    if (await warteBis(client, "document.querySelector('[data-settle-numbers]')", 4000)) await mausKlick(client, '[data-settle-numbers-confirm]');
    const hinweis = await warteBis(client, "document.querySelector('[data-settle-notice]')", 30000);
    const nachher = (await attrs(client, '[data-settle-total]', 'data-settle-total'))[0];
    ok(hinweis && zahl('SELECT COUNT(*) AS n FROM party_offsets') === zaehler, `E nichts gebucht, Hinweis „changed in the meantime", neuer Vorschlag (${vorher} → ${nachher})`);
    ok(nachher !== vorher, 'E der neue Vorschlag zeigt den aktuellen Stand');
    await foto(client, 'c-e-pc2-stale');
    await clickText(client, 'Cancel');
  }

  // ── F Sicherheit ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    ok(unbeteiligt() === UNB, 'F fremdes Darlehen und We Lent unverändert');
    ok(geldBuchungen() === geld0, 'F während des ganzen Laufs keine Geldbuchung');
    ok(zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE status = 'ACTIVE'") === 0 && zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE status = 'REVERSED'") === 5,
      'F alle fünf Zuordnungen stehen als REVERSED (nie gelöscht)');
    ok(zahl("SELECT COUNT(*) AS n FROM invoices WHERE id IN (?, ?, ?) AND number_finalized_at IS NOT NULL", [INV_A, INV_B, INV_C]) === 3
      && zahl("SELECT COUNT(DISTINCT invoice_number) AS n FROM invoices WHERE id IN (?, ?, ?)", [INV_A, INV_B, INV_C]) === 3,
    'F jede Endnummer einmal vergeben und behalten');
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
console.log(`\nc-settle-balance e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('CUSTOMER_ACCOUNT_C_SETTLE_BALANCE_E2E_PROVED');
process.exit(0);
