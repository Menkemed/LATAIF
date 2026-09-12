// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5C — die verbindliche Regel „abrechenbar": fertig ODER abgeholt.
// Run: node test/e2e/r5c-billable.e2e.mjs
//
// Ein kleiner, echter Lauf mit zwei Rechnern. Dieselben Reparaturen, dieselbe Liste, dieselbe
// Detailseite — am zweiten Rechner (ohne Datenbank) und am Primary:
//
//   • „fertig" und „abgeholt": Auswahl, Kürzel und „Create Invoice" werden angeboten und rechnen ab;
//   • „empfangen", „in Arbeit", „zurückgegeben": nichts davon wird angeboten;
//   • nach der Rechnung wird nichts mehr angeboten — keine zweite Rechnung;
//   • Primary == PC2, und der zweite Rechner besitzt keine Geschäftsdatenbank.
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r5c-bill-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5c-billable', 'run-' + Date.now());
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
const WACHHUND = setTimeout(() => {
  console.log('  x ABBRUCH: Zeitgrenze erreicht — der Lauf steht.');
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  try { execFileSync('taskkill', ['/F', '/IM', 'lataif-e2e-client.exe', '/T'], { stdio: 'ignore' }); } catch { /* weg */ }
  process.exit(1);
}, 20 * 60 * 1000);

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
    this.events = [];
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        this.events.push(`exception: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || ''}`.slice(0, 400));
      }
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

const killImage = (n) => { try { execFileSync('taskkill', ['/F', '/IM', n, '/T'], { stdio: 'ignore' }); } catch { /* war nicht da */ } };
const killAll = () => { killImage('lataif.exe'); killImage('lataif-e2e-client.exe'); };
async function waitGone(name) {
  for (let i = 0; i < 60; i++) {
    try { const o = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' }); if (!o.includes(name)) return; } catch { return; }
    await sleep(300);
  }
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
  spawn(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
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

const BEOBACHTER = `
  if (window.__r4bInstalliert) { /* schon da */ } else {
  window.__r4bInstalliert = true;
  window.__cmds = [];
  window.__dbHits = [];
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const oe = console.error;
  console.error = (...a) => {
    const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' ');
    if (/Database not initialized/.test(t)) merke(t);
    oe(...a);
  };
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    if (/\\/api\\/command$/.test(url)) {
      try {
        const body = JSON.parse((a[1] && a[1].body) || '{}');
        window.__cmds.push({ op: body.op, commandId: body.commandId, payload: body.payload });
      } catch (e) { /* kein lesbarer Rumpf */ }
    }
    return of(...a);
  };
  }
`;

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
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`)
    .run(...nutzbar.map((k) => daten[k]));
}

/** Je Status eine Reparatur; „fertig" und „abgeholt" doppelt — einmal für PC2, einmal für den Primary. */
const REP = [
  ['bl-rep-1', 'BL-0001', 'ready', 60], ['bl-rep-2', 'BL-0002', 'picked_up', 80],
  ['bl-rep-3', 'BL-0003', 'received', 60], ['bl-rep-4', 'BL-0004', 'in_progress', 60], ['bl-rep-5', 'BL-0005', 'returned', 60],
  ['bl-rep-6', 'BL-0006', 'ready', 60], ['bl-rep-7', 'BL-0007', 'picked_up', 80],
];
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'customers', { id: 'bl-kunde', branch_id, first_name: 'Lina', last_name: 'Rechnung', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    for (const [id, nr, status, charge] of REP) {
      insert(db, 'repairs', { id, branch_id, repair_number: nr, customer_id: 'bl-kunde', item_brand: 'Tudor', item_model: 'Pelagos', issue_description: 'Service ' + nr, repair_type: 'internal', internal_cost: 20, charge_to_customer: charge, margin: charge - 20, tax_scheme: 'VAT_10', status, received_at: now, completed_at: now, picked_up_at: status === 'picked_up' ? now : null, voucher_code: 'B' + nr.replace(/\D/g, '').padStart(7, '0'), images: '[]', item_attributes: '{}', repair_scope: 'CUSTOMER', revision: 1, created_at: now, updated_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
async function lade(c, route) {
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch (e) { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const fehlerAnzeige = (c) => c.ev("return [...document.querySelectorAll('[data-save-error]')].map(e=>e.textContent).join(' | ');");

/** Was die Zeile einer Reparatur in der Liste anbietet: Auswahl und Rechnungskürzel. */
const angebot = (c, nr) => c.ev(
  `const row=[...document.querySelectorAll('div.cursor-pointer')].find(d=>d.style&&d.style.gridTemplateColumns&&d.textContent.includes(${S(nr)}));`
  + `if(!row) return 'KEINE-ZEILE'; return (row.querySelector('input[type=checkbox]') ? 'A' : '-') + (row.querySelector('[data-repair-quick-invoice]') ? 'K' : '-');`);
const kuerzel = (c, nr) => c.ev(
  `const row=[...document.querySelectorAll('div.cursor-pointer')].find(d=>d.style&&d.style.gridTemplateColumns&&d.textContent.includes(${S(nr)}));`
  + `const b=row&&row.querySelector('[data-repair-quick-invoice]'); if(!b) return 'NO'; b.click(); return 'OK';`);
/** „Create Invoice" der Detailseite: Steuerdialog (Vorgabe der Reparatur) → Nummernart (normal) → Confirm. */
async function detailRechnung(c) {
  await click(c, '[data-repair-invoice]');
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Next: Choose Number Type')", 15000))) return 'KEIN-STEUERDIALOG';
  await clickText(c, 'Next: Choose Number Type');
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Confirm')", 15000))) return 'KEIN-NUMMERNDIALOG';
  await clickText(c, 'Confirm');
  return (await warteBis(c, "/^\\/invoices\\//.test(location.pathname)", 45000)) ? 'OK' : 'KEINE-RECHNUNG:' + (await fehlerAnzeige(c));
}
const rechnungVon = (rid) => String(dbQ(BIZ_DB, 'SELECT invoice_id FROM repairs WHERE id = ?', [rid])[0]?.invoice_id || '');
const INV_OHNE = /^(id|invoice_number|notes|created_by|revision|version|sync_status)$|_at$/;
const rechnung = (id) => {
  const k = dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [id])[0] || {};
  return S({
    kopf: Object.fromEntries(Object.entries(k).filter(([x]) => !INV_OHNE.test(x)).sort(([a], [b]) => a.localeCompare(b))),
    zeilen: dbQ(BIZ_DB, 'SELECT unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [id]),
    buchung: dbQ(BIZ_DB, 'SELECT account, direction, ROUND(SUM(amount), 3) AS s FROM ledger_entries WHERE source_id = ? GROUP BY account, direction ORDER BY account, direction', [id]),
  });
};
const vermerk = (rid) => String(dbQ(BIZ_DB, 'SELECT i.notes FROM invoices i JOIN repairs r ON r.invoice_id = i.id WHERE r.id = ?', [rid])[0]?.notes || '');
async function warteAuf(pruefe) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}

let primary = null, client = null;
try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Der Primary ────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5C Bill Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5C Bill Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5C Admin');
    await setVal(primary, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(primary, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="10"]');
    await setVal(primary, 'input[placeholder="10"]', '10');
    await primary.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 60000);
  await spuelen(primary).catch(() => null);
  await sleep(1200);
  primary.close(); primary = null;
  killImage('lataif.exe'); await waitGone('lataif.exe');
  seed();
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL, 90000);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  {
    const end = Date.now() + 60000; let oben = false;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { oben = true; break; } } catch { /* noch nicht */ }
      await sleep(500);
    }
    ok(oben, 'SETUP der Primary antwortet auf dem Netz');
  }

  // ── Der Client ────────────────────────────────────────────────────────
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
  await beobachterLegen();
  client = await lade(client, '/repairs');
  await warteBis(client, "document.body.innerText.includes('BL-0007')", 45000);
  await geh(primary, '/repairs');
  await warteBis(primary, "document.body.innerText.includes('BL-0007')", 45000);

  // ── 1) Was angeboten wird — dieselbe Regel auf beiden Rechnern ──────────
  const soll = { 'BL-0001': 'AK', 'BL-0002': 'AK', 'BL-0003': '--', 'BL-0004': '--', 'BL-0005': '--' };
  for (const [nr, erwartet] of Object.entries(soll)) {
    const a = await angebot(client, nr);
    const b = await angebot(primary, nr);
    const status = REP.find((x) => x[1] === nr)[2];
    ok(a === erwartet && b === erwartet,
      `LISTE ${nr} (${status}): Auswahl/Kuerzel ${erwartet === 'AK' ? 'angeboten' : 'NICHT angeboten'} — PC2 ${a}, Primary ${b}`);
  }
  for (const [rid, nr] of [['bl-rep-3', 'BL-0003'], ['bl-rep-4', 'BL-0004'], ['bl-rep-5', 'BL-0005']]) {
    client = await lade(client, '/repairs/' + rid);
    await warteBis(client, `document.body.innerText.includes(${S(nr)})`, 30000);
    await sleep(600);
    await geh(primary, '/repairs/' + rid);
    await warteBis(primary, `document.body.innerText.includes(${S(nr)})`, 30000);
    await sleep(600);
    ok(!(await exists(client, '[data-repair-invoice]')) && !(await exists(primary, '[data-repair-invoice]')),
      `DETAIL ${nr} (${REP.find((x) => x[1] === nr)[2]}): kein „Create Invoice" — weder PC2 noch Primary`);
  }

  // ── 2) „fertig" über das Kürzel, „abgeholt" über die Detailseite — PC2 und Primary ──
  client = await lade(client, '/repairs');
  await warteBis(client, "document.body.innerText.includes('BL-0001')", 30000);
  ok(await kuerzel(client, 'BL-0001') === 'OK', 'FERTIG PC2: das Kuerzel der Liste');
  ok(await warteBis(client, "/^\\/invoices\\//.test(location.pathname)", 45000), `FERTIG PC2: die Rechnung entsteht (${String(await fehlerAnzeige(client)).slice(0, 160) || 'ok'})`);
  client = await lade(client, '/repairs/bl-rep-2');
  await waitFor(client, '[data-repair-invoice]', 30000);
  const d2 = await detailRechnung(client);
  ok(d2 === 'OK', `ABGEHOLT PC2: „Create Invoice" der Detailseite (${d2})`);

  await geh(primary, '/repairs');
  await warteBis(primary, "document.body.innerText.includes('BL-0006')", 30000);
  ok(await kuerzel(primary, 'BL-0006') === 'OK', 'FERTIG Primary: dasselbe Kuerzel');
  ok(await warteBis(primary, "/^\\/invoices\\//.test(location.pathname)", 45000), 'FERTIG Primary: die Rechnung entsteht');
  await geh(primary, '/repairs/bl-rep-7');
  await waitFor(primary, '[data-repair-invoice]', 30000);
  const d7 = await detailRechnung(primary);
  ok(d7 === 'OK', `ABGEHOLT Primary: dieselbe Detailseite (${d7})`);

  await warteAuf(() => !!rechnungVon('bl-rep-1') && !!rechnungVon('bl-rep-2') && !!rechnungVon('bl-rep-6') && !!rechnungVon('bl-rep-7'));
  for (const [pc2, pri, was] of [['bl-rep-1', 'bl-rep-6', 'FERTIG'], ['bl-rep-2', 'bl-rep-7', 'ABGEHOLT']]) {
    const a = rechnungVon(pc2), b = rechnungVon(pri);
    ok(!!a && !!b && rechnung(a) === rechnung(b), `${was} Primary == PC2: Rechnungskopf, Zeilen und Buchung${a && b && rechnung(a) !== rechnung(b) ? ` (${rechnung(b)} / ${rechnung(a)})` : ''}`);
  }
  ok(/^Combined Repair Service · BL-0001$/.test(vermerk('bl-rep-1')) && /^Combined Repair Service · BL-0006$/.test(vermerk('bl-rep-6')),
    'FERTIG der Vermerk der Liste auf beiden Rechnern');
  ok(/^Repair Service · BL-0002 · Service BL-0002$/.test(vermerk('bl-rep-2')) && /^Repair Service · BL-0007 · Service BL-0007$/.test(vermerk('bl-rep-7')),
    'ABGEHOLT der Vermerk der Detailseite auf beiden Rechnern');
  ok(dbQ(BIZ_DB, "SELECT status FROM repairs WHERE id IN ('bl-rep-1','bl-rep-2') ORDER BY id").map((r) => r.status).join(',') === 'ready,picked_up',
    'STATUS die Rechnung aendert den Reparaturstatus nicht');

  // ── 3) Keine zweite Rechnung ─────────────────────────────────────────
  client = await lade(client, '/repairs');
  await warteBis(client, "document.body.innerText.includes('BL-0002')", 30000);
  ok(await angebot(client, 'BL-0001') === '--' && await angebot(client, 'BL-0002') === '--', 'EINMAL nach der Rechnung bietet die Liste nichts mehr an');
  client = await lade(client, '/repairs/bl-rep-2');
  await warteBis(client, "document.body.innerText.includes('BL-0002')", 30000);
  await sleep(600);
  ok(!(await exists(client, '[data-repair-invoice]')), 'EINMAL …und die Detailseite auch nicht');
  const proRep = dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM invoices WHERE notes LIKE '%BL-000%'")[0]?.n;
  ok(Number(proRep) === 4, `EINMAL genau vier Rechnungen — eine je abgerechneter Reparatur (${proRep})`);
  ok(dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM repairs WHERE id IN ('bl-rep-3','bl-rep-4','bl-rep-5') AND COALESCE(invoice_id,'') <> ''")[0]?.n === 0,
    'EINMAL die nicht abrechenbaren tragen keine Rechnung');
  const c = (await kommandos(client)).filter((x) => x.op === 'repairs.create_invoice');
  ok(c.length === 0, 'EINMAL auf den Seiten danach wurde nichts mehr geschickt');

  // ── 4) Der Client besitzt nichts ───────────────────────────────────────
  ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
  const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-location|\.db$/i.test(f));
  ok(verboten.length === 0, `LOKAL kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
  try { console.log('      (Primary) ' + (primary?.events || []).slice(-10).join('\n      (Primary) ')); } catch { /* egal */ }
  try { console.log('      (PC2) ' + (client?.events || []).slice(-10).join('\n      (PC2) ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5c: billable rule, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5C_BILLABLE_RUNTIME_PROVED');
