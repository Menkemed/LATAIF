// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT B2/B3 — Zwei-App-E2E: Einkaufsverrechnung (normal + Kommission) gegen Rechnungen derselben Person, ohne Geld.
// Run: node test/e2e/b23-purchase-offset.e2e.mjs
//
//   A  Primary: Einkauf → „Settle Balance" (Maus) ⇒ nur dieser Einkauf vorgewählt, Kennzeichnung normal/Kommission,
//      namensgleicher Lieferant ohne Verknüpfung nie angeboten; EINE STL; Einkauf Paid, paid_amount bleibt Geld; AP Lieferant.
//   B  PC2 (ohne Datenbank): Rechnung → „Settle Balance" ⇒ nur diese Rechnung vorgewählt; Kommissions-Einkauf; Endnummer;
//      EIN Fernauftrag.
//   C  PC2: Einkauf zeigt die Verrechnungszeile, ohne Void/Edit date.
//   D  Primary: „Remove offset" auf der Rechnung ⇒ Einkauf wieder offen, Zeile storniert (nicht gelöscht).
//   E  PC2: ganze STL im Kundenkonto rückgängig.   F  Sicherheit.
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
const OWNER_PW = 'b23-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-b23-offset', 'run-' + Date.now());
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
// Die Welt des Laufs (künstliche Testdaten): Kundin „Bea Offset" mit AUSDRÜCKLICH verknüpfter Lieferantenrolle.
//   Einkäufe: PN normal 300 · PC Kommission 200 (je mit Einkaufsbuchung AP beim Lieferanten)
//   Rechnungen: A 500 · B 150 (offen)   ·   ein Lieferant gleichen Namens OHNE Verknüpfung mit Einkauf 999 (nie angeboten)
// ══════════════════════════════════════════════════════════════════════════════
const K = 'b23-kunde';
const SUP = 'b23-sup', SUP_FREMD = 'b23-sup-fremd';
const PN = 'b23-pn', PC = 'b23-pc', PX = 'b23-px';
const INV_A = 'b23-inv-a', INV_B = 'b23-inv-b';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'customers', { id: K, branch_id, first_name: 'Bea', last_name: 'Offset', phone: '+973 3300 0401', created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: SUP, branch_id, name: 'Bea Offset', active: 1, linked_customer_id: K, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: SUP_FREMD, branch_id, name: 'Bea Offset', active: 1, created_at: now, updated_at: now });
    let nr = 990000;
    const einkauf = (id, num, sup, total, date, consignment) => {
      insert(db, 'purchases', { id, branch_id, purchase_number: num, supplier_id: sup, status: 'UNPAID', total_amount: total, paid_amount: 0,
        remaining_amount: total, purchase_date: date, created_at: now, updated_at: now, ...(consignment ? { source_consignment_id: 'b23-con' } : {}) });
      const tx = 'b23-tx-' + id;
      for (const [acc, dir] of [['INVENTORY', 'DEBIT'], ['ACCOUNTS_PAYABLE', 'CREDIT']]) {
        insert(db, 'ledger_entries', { id: `b23-le-${id}-${dir}`, branch_id, entry_no: ++nr, transaction_id: tx, occurred_at: `${date}T09:00:00.000Z`,
          recorded_at: now, account: acc, direction: dir, amount: total, currency: 'BHD', counterparty_type: 'SUPPLIER', counterparty_id: sup,
          source_module: 'PURCHASE', source_id: id, created_by: 'e2e', created_at: now });
      }
    };
    einkauf(PN, 'PUR-2026-000981', SUP, 300, '2026-10-10', false);
    einkauf(PC, 'PUR-2026-000982', SUP, 200, '2026-10-11', true);
    einkauf(PX, 'PUR-2026-000983', SUP_FREMD, 999, '2026-10-09', false);
    const rechnung = (id, num, gross, issued) => insert(db, 'invoices', { id, branch_id, invoice_number: num, customer_id: K, status: 'PARTIAL', currency: 'BHD',
      net_amount: gross, vat_amount: 0, gross_amount: gross, paid_amount: 0, issued_at: issued, created_at: now, updated_at: now });
    rechnung(INV_A, 'PINV-2026-000981', 500, '2026-10-20T09:00:00.000Z');
    rechnung(INV_B, 'PINV-2026-000982', 150, '2026-10-21T09:00:00.000Z');
  } finally { db.close(); }
}
const einkaufZeile = (id) => dbQ(BIZ_DB, 'SELECT status, paid_amount, remaining_amount FROM purchases WHERE id = ?', [id])[0] || {};
const rechnung = (id) => dbQ(BIZ_DB, 'SELECT status, paid_amount, invoice_number, special_mark FROM invoices WHERE id = ?', [id])[0] || {};
async function dateiBis(pruefe, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { await spuelen(primary).catch(() => null); if (pruefe()) return true; await sleep(700); }
  return false;
}
const geldBuchungen = () => zahl("SELECT COUNT(*) AS n FROM ledger_entries WHERE account IN ('CASH','BANK','BENEFIT','CARD_CLEARING')");
const apLieferant = () => Math.round(1000 * Number(dbQ(BIZ_DB, `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0) AS s
  FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND counterparty_type = 'SUPPLIER' AND counterparty_id = ?`, [SUP])[0]?.s || 0)) / 1000;
const unbeteiligt = () => createHash('sha256').update(S([
  dbQ(BIZ_DB, 'SELECT id, status, paid_amount, remaining_amount FROM purchases WHERE id = ?', [PX]),
  dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM purchase_payments WHERE purchase_id = ?', [PX]),
])).digest('hex');
const text = (c, sel) => c.ev(`return (document.querySelector(${S(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim();`);
const attrs = (c, sel, a) => c.ev(`return JSON.stringify([...document.querySelectorAll(${S(sel)})].map(e=>e.getAttribute(${S(a)})));`).then((x) => JSON.parse(x || '[]'));
const stlRows = (nr) => dbQ(BIZ_DB, 'SELECT offset_number, payable_type, payable_id, receivable_id, amount, status FROM party_offsets WHERE settlement_number = ? ORDER BY offset_number', [nr]);
const offsetZeilen = (pid) => dbQ(BIZ_DB, "SELECT id, amount, reference, voided_at FROM purchase_payments WHERE purchase_id = ? AND method = 'offset' ORDER BY created_at", [pid]);

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
  const ap0 = apLieferant();
  const checkbox = (sel) => `${sel} input[type="checkbox"]`;

  // ── A Primary: Einkauf PN → „Settle Balance" ⇒ nur PN vorgewählt; IA←PN 300 ───────────────────────────────────────
  let stl1 = '';
  {
    await gehFrisch(primary, `/purchases/${PN}`);
    await waitFor(primary, '[data-purchase-settle-open]', 45000);
    ok(await mausKlick(primary, '[data-purchase-settle-open]') === 'OK', 'A Primary: Maus auf „Settle Balance" am Einkauf');
    await waitFor(primary, '[data-settle-balance]', 30000);
    const src = await attrs(primary, '[data-settle-source]', 'data-settle-source');
    const art = await attrs(primary, '[data-settle-source]', 'data-settle-source-purchase');
    const an = await attrs(primary, '[data-settle-source]', 'data-settle-on');
    ok(S(src) === S(['PUR-2026-000981', 'PUR-2026-000982']) && S(art) === S(['normal', 'consignment']),
      `A rechts nur die Einkäufe der verknüpften Rolle, normal/Kommission gekennzeichnet; der namensgleiche fehlt (${S(src)} ${S(art)})`);
    ok(S(an) === S(['1', '0']), `A vom Einkauf: nur dieser Einkauf vorgewählt (${S(an)})`);
    const inv = await attrs(primary, '[data-settle-invoice]', 'data-settle-invoice');
    ok(S(inv) === S(['PINV-2026-000981', 'PINV-2026-000982']), `A links die offenen Rechnungen der Kundin, älteste zuerst (${S(inv)})`);
    const paare = await attrs(primary, '[data-settle-pair]', 'data-settle-pair');
    ok(S(paare) === S(['PUR-2026-000981>PINV-2026-000981']) && (await attrs(primary, '[data-settle-total]', 'data-settle-total'))[0] === '300.000',
      `A Vorschlag: PN 300 → A (${S(paare)})`);
    const quelle = await text(primary, '[data-settle-source="PUR-2026-000981"]');
    ok(/Purchase/.test(quelle) && /purchase → Paid/.test(quelle), `A vorher/nachher am Einkauf: „→ Paid" (${quelle.slice(0, 160)})`);
    await foto(primary, 'b23-a-primary-dialog');
    ok(await mausKlick(primary, '[data-settle-confirm]') === 'OK', 'A Maus auf „Confirm settlement"');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE payable_type = 'PURCHASE'") >= 1);
    stl1 = String(dbQ(BIZ_DB, "SELECT settlement_number FROM party_offsets WHERE payable_type = 'PURCHASE' ORDER BY created_at LIMIT 1")[0]?.settlement_number || '');
    const rows = stlRows(stl1);
    ok(/^STL-\d{4}-\d{6}$/.test(stl1) && rows.length === 1 && rows[0].payable_type === 'PURCHASE' && rows[0].payable_id === PN && Number(rows[0].amount) === 300,
      `A Datenbank: EINE STL ${stl1}, Zuordnung PURCHASE PN 300 (${S(rows)})`);
    const pn = einkaufZeile(PN), ra = rechnung(INV_A);
    ok(pn.status === 'PAID' && Number(pn.paid_amount) === 0 && Number(pn.remaining_amount) === 0, `A PN: Paid, paid_amount bleibt Geld (0), Rest 0 (${S(pn)})`);
    ok(ra.status === 'PARTIAL' && Number(ra.paid_amount) === 300, `A Rechnung A: 300 verrechnet, 200 offen (${S(ra)})`);
    ok(geldBuchungen() === geld0 && Math.abs(ap0 - apLieferant() - 300) < 0.0005, `A keine Geldbuchung; AP beim Lieferanten −300 (${ap0} → ${apLieferant()})`);
    const zeile = offsetZeilen(PN);
    ok(zeile.length === 1 && zeile[0].reference === `${stl1}/1` && !zeile[0].voided_at, 'A Zeile am Einkauf: offset mit der Verrechnungsnummer');
  }

  // ── B PC2: Rechnung B → „Settle Balance" ⇒ nur B vorgewählt; B←PC 150 (voll bezahlt, Endnummer); EIN Fernauftrag ────
  let stl2 = '';
  {
    await syncRuhe();
    client = await lade(client, `/invoices/${INV_B}`);
    await waitFor(client, '[data-settle-balance]', 45000);
    ok(await mausKlick(client, 'button[data-settle-balance]') === 'OK', 'B PC2: Maus auf „Settle Balance" auf der Rechnung');
    await waitFor(client, 'div[data-settle-balance]', 30000);
    const an = await attrs(client, '[data-settle-invoice]', 'data-settle-on');
    const inv = await attrs(client, '[data-settle-invoice]', 'data-settle-invoice');
    ok(S(inv) === S(['PINV-2026-000981', 'PINV-2026-000982']) && S(an) === S(['0', '1']), `B von der Rechnung: nur sie vorgewählt (${S(inv)} ${S(an)})`);
    const src = await attrs(client, '[data-settle-source]', 'data-settle-source');
    ok(S(src) === S(['PUR-2026-000982']) && S(await attrs(client, '[data-settle-source]', 'data-settle-source-purchase')) === S(['consignment']),
      `B rechts nur noch der offene Kommissions-Einkauf (PN ist beglichen) (${S(src)})`);
    const paare = await attrs(client, '[data-settle-pair]', 'data-settle-pair');
    ok(S(paare) === S(['PUR-2026-000982>PINV-2026-000982']) && (await attrs(client, '[data-settle-total]', 'data-settle-total'))[0] === '150.000', `B Vorschlag PC 150 → B (${S(paare)})`);
    await foto(client, 'b23-b-pc2-dialog');
    ok(await mausKlick(client, '[data-settle-confirm]') === 'OK', 'B Maus auf „Confirm settlement"');
    await waitFor(client, '[data-settle-numbers]', 15000);
    ok(await mausKlick(client, '[data-settle-number-for="PINV-2026-000982"] [data-settle-number-choice="normal"]') === 'OK', 'B Maus: Normal Final');
    ok(await mausKlick(client, '[data-settle-numbers-confirm]') === 'OK', 'B Maus auf „Confirm settlement" (Endnummer)');
    await dateiBis(() => zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE payable_type = 'PURCHASE'") >= 2);
    stl2 = String(dbQ(BIZ_DB, "SELECT settlement_number FROM party_offsets WHERE payable_type = 'PURCHASE' AND payable_id = ? LIMIT 1", [PC])[0]?.settlement_number || '');
    const pc = einkaufZeile(PC), rb = rechnung(INV_B);
    ok(stl2 && stl2 !== stl1 && pc.status === 'PARTIALLY_PAID' && Number(pc.remaining_amount) === 50 && Number(pc.paid_amount) === 0,
      `B PC: teilbeglichen, Rest 50, paid_amount 0 (${stl2} ${S(pc)})`);
    ok(rb.status === 'FINAL' && !String(rb.invoice_number).startsWith('PINV') && Number(rb.special_mark || 0) === 0, `B Rechnung B voll bezahlt mit Endnummer ${rb.invoice_number}`);
    ok((await kommandos(client)).filter((x) => x.op === 'customers.settle_balance').length === 1, 'B PC2 schickt EINEN Auftrag customers.settle_balance');
    ok(geldBuchungen() === geld0 && Math.abs(ap0 - apLieferant() - 450) < 0.0005, `B keine Geldbuchung; AP beim Lieferanten insgesamt −450 (${apLieferant()})`);
  }

  // ── C PC2: der Kommissions-Einkauf zeigt die Verrechnungszeile — kein Void dafür ─────────────────────────────────
  {
    client = await lade(client, `/purchases/${PC}`);
    const sel = `[data-purchase-payment-offset="${stl2}/1"]`;
    const da = await warteBis(client, `document.querySelector(${S(sel)})`, 45000);
    const zeile = da ? await text(client, sel) : '';
    ok(da && /OFFSET/.test(zeile) && /no cash/.test(zeile), `C PC2: Einkauf zeigt „OFFSET ${stl2}/1 · no cash" (${zeile})`);
    const offId = offsetZeilen(PC)[0]?.id;
    ok(!!offId && !(await exists(client, `[data-purchase-payment-void="${offId}"]`)) && !(await exists(client, `[data-purchase-payment-date="${offId}"]`)),
      'C keine „Void"/„Edit date" für die Verrechnungszeile (nur über Rechnung bzw. Konto aufhebbar)');
    ok(await exists(client, '[data-purchase-settle-open]'), 'C der Rest 50 ist weiter verrechenbar („Settle Balance" am Einkauf)');
    await foto(client, 'b23-c-pc2-purchase');
  }

  // ── D Primary: Rechnung A → „Remove offset" ⇒ PN wieder offen, Zeile storniert (nicht gelöscht) ──────────────────────
  {
    await syncRuhe();
    await gehFrisch(primary, `/invoices/${INV_A}`);
    await warteBis(primary, `document.querySelector('[data-invoice-offset="${stl1}/1"] [data-invoice-offset-remove]')`, 45000);
    const z = await text(primary, `[data-invoice-offset="${stl1}/1"]`);
    ok(z.includes('PUR-2026-000981') && /purchase/.test(z), `D Rechnung A nennt den Gegenbeleg „purchase PUR-…" (${z.slice(0, 160)})`);
    ok(await mausKlick(primary, `[data-invoice-offset="${stl1}/1"] [data-invoice-offset-remove]`) === 'OK', 'D Maus auf „Remove offset"');
    await dateiBis(() => (stlRows(stl1)[0] || {}).status === 'REVERSED');
    const pn = einkaufZeile(PN), ra = rechnung(INV_A), zeile = offsetZeilen(PN);
    ok(pn.status === 'UNPAID' && Number(pn.remaining_amount) === 300 && ra.status === 'PARTIAL' && Number(ra.paid_amount) === 0,
      `D PN wieder offen 300, Rechnung A wieder offen (${S(pn)} ${S(ra)})`);
    ok(zeile.length === 1 && !!zeile[0].voided_at, 'D die Zeile am Einkauf ist storniert (voided_at), nicht gelöscht');
    ok(geldBuchungen() === geld0, 'D keine Geldbuchung');
  }

  // ── E PC2: Kundenkonto → ganze zweite STL rückgängig (App-Dialog) ─────────────────────────────────────────────────
  {
    await syncRuhe();
    client = await lade(client, `/clients/${K}/account`);
    await waitFor(client, `[data-settlement-undo="${stl2}"]`, 45000);
    ok(await mausKlick(client, `[data-settlement-undo="${stl2}"]`) === 'OK', `E PC2: Maus auf „Undo settlement" (${stl2})`);
    await waitFor(client, '[data-app-confirm]', 15000);
    ok(await mausKlick(client, '[data-app-confirm-ok]') === 'OK', 'E Maus auf „OK"');
    await dateiBis(() => stlRows(stl2).every((r) => r.status === 'REVERSED'));
    const pc = einkaufZeile(PC), rb = rechnung(INV_B);
    ok(pc.status === 'UNPAID' && Number(pc.remaining_amount) === 200 && rb.status === 'PARTIAL' && Number(rb.paid_amount) === 0,
      `E PC wieder ganz offen, Rechnung B wieder offen (Endnummer bleibt ${rb.invoice_number}) (${S(pc)})`);
    ok((await kommandos(client)).filter((x) => x.op === 'customers.settlement_reverse').length === 1, 'E PC2 schickt EINEN Auftrag customers.settlement_reverse');
    await foto(client, 'b23-e-pc2-undone', '[data-settlements]');
  }

  // ── F Sicherheit ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    ok(unbeteiligt() === UNB, 'F der namensgleiche, nicht verknüpfte Lieferant: Einkauf unberührt');
    ok(geldBuchungen() === geld0 && Math.abs(apLieferant() - ap0) < 0.0005, 'F während des ganzen Laufs keine Geldbuchung; AP beim Lieferanten wieder wie vorher');
    ok(zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE status = 'ACTIVE'") === 0 && zahl("SELECT COUNT(*) AS n FROM party_offsets WHERE status = 'REVERSED'") === 2,
      'F beide Zuordnungen stehen als REVERSED (nie gelöscht)');
    ok(zahl("SELECT COUNT(*) AS n FROM purchase_payments WHERE method = 'offset' AND voided_at IS NOT NULL") === 2
      && zahl("SELECT COUNT(*) AS n FROM purchase_payments WHERE method = 'offset' AND voided_at IS NULL") === 0, 'F beide Einkaufszeilen storniert, keine wirksame mehr');
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
console.log(`\nb23-purchase-offset e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('CUSTOMER_ACCOUNT_B23_PURCHASE_OFFSET_E2E_PROVED');
process.exit(0);
