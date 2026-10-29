// ════════════════════════════════════════════════════════════════════════════
// CONSIGNMENT MULTI-SALE + D3 — Zwei-App-E2E mit zwei echten, isolierten Anwendungen (Primary + PC2 ohne Datenbank).
// Run: node test/e2e/consignment-multi-sale-pc2.e2e.mjs
//
//   A  Drei Kommissionen zweier Einlieferer über den echten PC2-Befehl (consignments.create).
//   B  PC2-Liste „Items": Auswahl (bleibt beim Filterwechsel), „Record Sale (3)", Käufer, Bar + Benefit → EIN Fernauftrag.
//   C  Primary: EINE Rechnung (3 Zeilen, Verkaufstag), Zahlungen, je Artikel ein Einkauf, Einlieferer getrennt.
//   D  D3 am PC2: Einlieferer bezahlt, Käufer bringt EINEN Artikel zurück → „Repayment still open": offene Rückforderung,
//      kein fiktiver Geldeingang, die übrigen Artikel bleiben verkauft; die Detailseite zeigt es.
//   E  PC2 Cancel Sale der Sammelrechnung ist vorher gesperrt (ein Artikel ging samt Rückzahlung zurück).
//   F  Zweiter Verkauf, Einlieferer B bezahlt: PC2 Cancel Sale der GANZEN Rechnung mit „Geld zurück (Kasse)".
//   G  Abgleich Lager/AP/Lieferanten-Guthaben.   H  PC2 ohne Datenbank, Prozess-Isolation.
//   R  FINAL RELEASE GATE: PC2 „Record Repayment" (Beleg supplier_credit_refunds), „Is Workshop" über New/Edit Supplier
//      (Bücher bitgleich), Repair-Auswahl nur Workshops, historische Zuordnung bleibt; echte Sicherung → frischer Ordner →
//      echte Wiederherstellung → echte App zeigt Beleg, Markierung und Zuordnung.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat oder was am EXAKTEN
// Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, ihr Datenordner und ihre Ports werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
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
const OWNER_PW = 'cms-owner-' + Math.random().toString(36).slice(2);
const MGR_ID = 'pe-manager', MGR_EMAIL = 'manager.pe@lataif.com', MGR_NAME = 'PE Manager';

const RUN = join(os.tmpdir(), 'lataif-consignment-multi-sale', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCAL = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCAL, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const MEDIA_ROOT = join(APP_DATA_DIR, 'media');
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
}, 100 * 60 * 1000);

const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const clientEnv = () => ({
  ...process.env,
  APPDATA: CLIENT_APPDATA, LOCALAPPDATA: join(CLIENT_HOME, 'Local'),
  TEMP: join(CLIENT_HOME, 'tmp'), TMP: join(CLIENT_HOME, 'tmp'),
  LATAIF_E2E_SYNC_PORT: String(PORT),
});
const seedCmd = (...args) => execFileSync(SEED, args, { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();
function dbQ(file, sql, params = []) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

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

async function attachOnly(cdpPort, budget = 60000, notId = null) {
  const end = Date.now() + budget; let page = null;
  while (Date.now() < end) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl && t.id !== notId);
      if (page) break;
    } catch { /* noch nicht oben */ }
    await sleep(500);
  }
  if (!page) throw new Error('no CDP page on ' + cdpPort);
  const c = new CDP(page.webSocketDebuggerUrl);
  c.pageId = page.id;
  await c.send('Runtime.enable');
  return c;
}
async function attach(cdpPort, exe, env) {
  spawnTracked(exe, [], { env, stdio: 'ignore', detached: true }).unref();
  return attachOnly(cdpPort, 120000);
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
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
  while (Date.now() < end) { try { if (await c.ev(`return !!(${ausdruck});`)) return true; } catch { /* Seite wechselt */ } await sleep(350); }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const SHELL = 'a[href="/settings"]';
const alleOk = (r) => { const schlecht = r.filter((x) => x !== 'OK'); return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK'; };
const q = (sel) => `document.querySelector(${S(sel)})`;

// Der Beobachter am PC2: Fernaufträge und ihre Antworten, Datenbankgriffe — und EINE verlorene Antwort auf Wunsch.
const BEOBACHTER = `
  if (!window.__peInstalliert) {
  window.__peInstalliert = true;
  window.__cmds = []; window.__answers = []; window.__dbHits = []; window.__dropNext = null;
  window.alert = () => {}; window.confirm = () => true;
  const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
  window.addEventListener('error', (e) => { if (/Database not initialized/.test(String(e.message))) merke(e.message); });
  window.addEventListener('unhandledrejection', (e) => { if (/Database not initialized/.test(String(e.reason))) merke(e.reason); });
  const of = window.fetch;
  window.fetch = async (...a) => {
    let url = '';
    try { url = String(a[0] && a[0].url ? a[0].url : a[0]); } catch (e) { url = ''; }
    let body = null;
    if (/\\/api\\/command$/.test(url)) {
      try { body = JSON.parse((a[1] && a[1].body) || '{}'); let auth = ''; try { const h = (a[1] && a[1].headers) || {}; auth = h.Authorization || h.authorization || ''; } catch (e) { auth = ''; } window.__cmds.push({ op: body.op, commandId: body.commandId, url, auth }); } catch (e) { /* kein Rumpf */ }
    }
    if (body && window.__dropNext && body.op === window.__dropNext) {
      // Die Anfrage GEHT hinaus und wird am Primary ausgeführt — nur die Antwort kommt nie an.
      window.__dropNext = null;
      const r0 = await of(...a);
      try { await r0.text(); } catch (e) { /* egal */ }
      window.__answers.push({ op: body.op, commandId: body.commandId, dropped: true });
      throw new TypeError('PE: simulated lost response');
    }
    const r = await of(...a);
    if (body && body.op && !/\\.(get|list)$/.test(String(body.op))) {
      try { const j = await r.clone().json(); window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, ok: !!(j && j.ok === true), error: (j && j.error) || null, replayed: !!(j && j.value && j.value.replayed) }); }
      catch (e) { window.__answers.push({ op: body.op, commandId: body.commandId, status: r.status, unreadable: true }); }
    }
    return r;
  };
  }
`;
let steuer = null;
async function beobachterLegen() {
  steuer = await attachOnly(CLIENT_CDP, 30000);
  await steuer.send('Page.enable', {});
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: BEOBACHTER });
}
const ALLE_CMDS = [], ALLE_ANTWORTEN = [], ALLE_TREFFER = [];
const kommandos = (c) => c.ev('return JSON.stringify(window.__cmds || []);').then((s) => JSON.parse(s || '[]'));
const antworten = (c) => c.ev('return JSON.stringify(window.__answers || []);').then((s) => JSON.parse(s || '[]'));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
async function merke(c) {
  try { ALLE_CMDS.push(...(await kommandos(c))); ALLE_ANTWORTEN.push(...(await antworten(c))); ALLE_TREFFER.push(...(await treffer(c))); } catch { /* Seite weg */ }
  try { await c.ev('window.__cmds = []; window.__answers = []; window.__dbHits = []; return 1;'); } catch { /* Seite weg */ }
}
async function lade(c, route) {
  await merke(c);
  await steuer.ev(`location.replace(${S(route)}); return 1;`);
  try { c.close(); } catch { /* zu */ }
  await sleep(3200);
  return attachOnly(CLIENT_CDP, 30000);
}
const geh = (p, route) => p.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(p, route) { await geh(p, '/tasks'); await sleep(700); await geh(p, route); await sleep(900); }
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const fehlerText = (c) => c.ev("return [...document.querySelectorAll('[data-save-error]')].map(e=>e.textContent).join(' | ');").catch(() => '');
let primary = null, client = null;

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

// ── Datenbank-Blick ──────────────────────────────────────────────────────────
const zahl = (sql, params = []) => Number(Object.values(dbQ(BIZ_DB, sql, params)[0] || { n: 0 })[0] || 0);
const zeile = (t, id) => dbQ(BIZ_DB, `SELECT * FROM ${t} WHERE id = ?`, [id])[0] || {};
const saldo = (account, extra = '', p = []) => Math.round(zahl(`SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) AS n FROM ledger_entries WHERE account = ? ${extra}`, [account, ...p]) * 1000) / 1000;
const r3 = (x) => Math.round(Number(x) * 1000) / 1000;

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
/** Die Welt des Laufs: eine Kategorie ohne Pflichtmerkmale, zwei Einlieferer, ein Käufer. */
function seedBusiness() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'pe-cat', branch_id, name: 'PE Watch', icon: 'w', color: '#000', attributes: '[]', created_at: now, updated_at: now });
    // Zwei Einlieferer (Kunden), der Käufer — ihre Lieferanten-Rollen legt der erste Verkauf an.
    insert(db, 'customers', { id: 'cm-con-a', branch_id, first_name: 'Con', last_name: 'Alpha', phone: '+973 3600 0201', created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'cm-con-b', branch_id, first_name: 'Con', last_name: 'Beta', phone: '+973 3600 0202', created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'pe-kunde', branch_id, first_name: 'PE', last_name: 'Kunde', phone: '+973 3600 0101', created_at: now, updated_at: now });
    // Der Manager auch in der Geschäftsdatenbank (wie der Owner: users + user_branches), Rolle MANAGER.
    const a = db.prepare('SELECT u.tenant_id, u.password_hash FROM users u LIMIT 1').get() || {};
    insert(db, 'users', { id: MGR_ID, tenant_id: a.tenant_id || 'tenant-1', email: MGR_EMAIL, password_hash: a.password_hash || '!', name: MGR_NAME, active: 1, created_at: now, updated_at: now });
    insert(db, 'user_branches', { user_id: MGR_ID, branch_id, role: 'MANAGER', is_default: 1, created_at: now });
  } finally { db.close(); }
}
/** Ein Manager im Server-Konto (dieselben drei Zeilen wie der Owner, Rolle manager) — gleiches Passwort. */
function seedServerManager() {
  const db = new DatabaseSync(SERVER_DB);
  try {
    const now = new Date().toISOString();
    const o = db.prepare('SELECT u.tenant_id, u.password_hash FROM users u WHERE u.email = ?').get(OWNER_EMAIL) || {};
    insert(db, 'users', { id: MGR_ID, tenant_id: o.tenant_id || 'tenant-1', email: MGR_EMAIL, password_hash: o.password_hash, name: MGR_NAME, active: 1, created_at: now, updated_at: now });
    insert(db, 'user_branches', { user_id: MGR_ID, branch_id: 'branch-main', role: 'manager', is_default: 1, created_at: now });
    insert(db, 'server_credentials', { user_id: MGR_ID, credential_state: 'active', password_changed_at: now, provisioned_at: now, provisioned_by: 'pe-e2e-seed', classified_reason: 'pe-manager', created_at: now, updated_at: now });
  } finally { db.close(); }
}
/** Ein Fernauftrag von PC2 mit DESSEN Anmeldung, genau wie die Maske ihn schickt. */
async function sende(c, op, payload) {
  const auth = [...ALLE_CMDS, ...(await kommandos(c))].map((x) => x.auth).find(Boolean) || '';
  const url = `http://127.0.0.1:${PORT}/api/command`;
  return JSON.parse(await c.ev(`const r = await fetch(${S(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ${S(auth)} }, body: JSON.stringify({ op: ${S(op)}, commandId: crypto.randomUUID(), payload: ${S(payload)} }) }); let b = null; try { b = await r.json(); } catch (e) { b = null; } return JSON.stringify({ status: r.status, body: b });`));
}
const kmd = (op) => ALLE_CMDS.filter((x) => x.op === op);
const antw = (op) => ALLE_ANTWORTEN.filter((x) => x.op === op);


try {
  assertE2eClientBinary(CLIENT_APP);
  const fremdVorher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  aufraeumen(); await waitTestImageGone('lataif.exe'); await waitTestImageGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp'), join(RUN, 'backups')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  if (existsSync(WV2_DIR)) rmSync(WV2_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Setup: Primary einrichten, Welt säen, als Primary konfigurieren, PC2 verbinden ──────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) {
    await click(primary, '[data-first-run-new]');
    const alt = primary.pageId; primary.close(); await sleep(2500);
    primary = await attachOnly(APP_CDP, 90000, alt);
  }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PE Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'PE Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'PE Admin');
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
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  seedBusiness();
  seedCmd('seed-primary', SERVER_DB);
  seedServerManager();

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(primary, SHELL))) {
    await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
    await setVal(primary, 'input[type="password"]', ONBOARD_PW);
    await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(primary, SHELL, 90000);
  await primary.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
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
  ok(true, 'CONNECT frischer PC2 ohne Datenbank, Anmeldung als Owner');
  await beobachterLegen();
  client = await lade(client, '/purchases');
  await waitFor(client, SHELL, 30000);

  // ── Helfer dieses Laufs ─────────────────────────────────────────────────────────────────────────
  const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
  /** Eine Suchauswahl: den Auslöser öffnen, dann den Eintrag (dieselbe Hilfe wie im R5F-Lauf). */
  async function ssPick(c, placeholder, optionId) {
    const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
    if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
    if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
    await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
    await sleep(300);
    return 'OK';
  }
  async function nummerWaehlen(c) {
    if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Normal Final'))", 15000))) return 'KEIN-DIALOG';
    const r = [await clickIncludes(c, 'Normal Final')];
    await sleep(200);
    r.push(await clickText(c, 'Confirm'));
    return alleOk(r);
  }
  // Der Rumpf jedes consignments.*-Auftrags, wie PC2 ihn wirklich schickt.
  const KOERPER = `
    if (!window.__cmsInstalliert) {
      window.__cmsInstalliert = true; window.__conBodies = [];
      const of2 = window.fetch;
      window.fetch = async (...a) => {
        try { const url = String(a[0] && a[0].url ? a[0].url : a[0]); if (/\\/api\\/command$/.test(url)) { const b = JSON.parse((a[1] && a[1].body) || '{}'); if (/^consignments\\./.test(b.op)) window.__conBodies.push(JSON.stringify({ op: b.op, payload: b.payload })); } } catch (e) { /* kein Rumpf */ }
        return of2(...a);
      };
    }`;
  await steuer.send('Page.addScriptToEvaluateOnNewDocument', { source: KOERPER });
  const koerper = async (c, op) => (JSON.parse(await c.ev('return JSON.stringify(window.__conBodies || []);') || '[]'))
    .map((x) => JSON.parse(x)).filter((x) => x.op === op).map((x) => x.payload);
  async function kommission(consignorId, name, preis) {
    const r = await sende(client, 'consignments.create', {
      consignorId, product: { brand: 'CMS', name, categoryId: 'pe-cat', condition: 'Pre-Owned' }, agreedPrice: preis,
      payout: { model: 'percent', commissionRate: 20 },
    });
    await spuelen(primary);
    return String(r.body?.value?.consignmentId || '');
  }
  const kon = (id) => zeile('consignments', id);
  // CONSIGNOR-JOINT-PURCHASE — der Einkauf einer Kommission: an der Spalte des Einkaufs (allein) oder an seiner Zeile (gemeinsam).
  const einkaufVon = (cid) => dbQ(BIZ_DB, `SELECT p.* FROM purchases p WHERE p.status != 'CANCELLED'
    AND (p.source_consignment_id = ? OR EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id = ?))
    ORDER BY p.rowid DESC`, [cid, cid])[0] || {};
  /** PC2: die Kommissionsliste, Reiter „Items". */
  async function itemsListe() {
    await syncRuhe();
    client = await lade(client, '/consignments');
    await waitFor(client, SHELL, 30000);
    if (!(await warteBis(client, "[...document.querySelectorAll('button')].some(b=>/^Items \\(/.test(b.textContent.trim()))", 30000))) return 'KEIN-REITER';
    await client.ev("[...document.querySelectorAll('button')].find(b=>/^Items \\(/.test(b.textContent.trim())).click(); return 1;");
    return (await warteBis(client, q('[data-consignment-select-all]'), 20000)) ? 'OK' : 'KEINE-LISTE';
  }
  /** PC2: im offenen Verkaufsdialog Käufer, Zahlungen, bestätigen, Nummernkreis. */
  async function verkaufen(kaeufer, zahlungen) {
    const r = [];
    if (!(await warteBis(client, q('[data-consignment-sale-dialog]'), 15000))) return 'KEIN-DIALOG';
    r.push(await ssPick(client, 'Search clients...', kaeufer));
    for (let i = 0; i < zahlungen.length; i++) {
      if (i > 0) r.push(await klick(client, '[data-consignment-sale-pay-add]'));
      await sleep(200);
      const z = zahlungen[i];
      r.push(await client.ev(`const rows=[...document.querySelectorAll('[data-consignment-sale-pay-row]')]; const row=rows[${i}]; if(!row) return 'KEINE-ZEILE';
        const m=row.querySelector('[data-consignment-sale-pay-method=${S(z.method)}]'); if(!m) return 'KEIN-WEG'; m.click(); return 'OK';`));
      await sleep(200);
      r.push(await client.ev(`const rows=[...document.querySelectorAll('[data-consignment-sale-pay-row]')]; const e=rows[${i}].querySelector('[data-consignment-sale-pay-amount]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(String(z.amount))}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`));
    }
    await sleep(300);
    r.push(await klick(client, '[data-consignment-sale]'));
    r.push(await nummerWaehlen(client));
    if (!(await warteBis(client, `!${q('[data-consignment-sale-dialog]')}`, 30000))) r.push('BLEIBT:' + (await fehlerText(client)));
    await spuelen(primary);
    return alleOk(r);
  }

  // ── A Drei Kommissionen zweier Einlieferer (echter PC2-Befehl consignments.create) ──────────────
  const K1 = await kommission('cm-con-a', 'Alpha CMS', 1000);
  const K2 = await kommission('cm-con-a', 'Beta CMS', 2000);
  const K3 = await kommission('cm-con-b', 'Gamma CMS', 3000);
  ok(K1 && K2 && K3 && [K1, K2, K3].every((k) => kon(k).status === 'active'), `A drei aktive Kommissionen, zwei Einlieferer (${S([K1, K2, K3].map((k) => kon(k).status))})`);

  // ── B PC2: Items-Liste, alle drei auswählen, EIN Verkauf mit gemischter Teilzahlung ──────────────
  {
    const r = [await itemsListe()];
    // Auswahl bleibt beim Filterwechsel: einen wählen, auf „Sold" filtern, zurück auf „All".
    r.push(await klick(client, `[data-consignment-select="${K1}"]`));
    r.push(await clickText(client, 'Sold')); await sleep(300);
    const bleibt = await client.ev(`return /1 item selected/.test(${q('[data-consignment-selection]')}?.innerText || '');`);
    r.push(await clickText(client, 'All')); await sleep(300);
    r.push(await klick(client, '[data-consignment-select-all]')); await sleep(300);
    const leiste = String(await client.ev(`return ${q('[data-consignment-selection]')}?.innerText || '';`));
    ok(bleibt && /3 items selected/.test(leiste) && /2 consignors/.test(leiste) && /6,000\.000/.test(leiste),
      `B Auswahl über zwei Einlieferer, bleibt beim Filterwechsel (${leiste.replace(/\s+/g, ' ').slice(0, 120)})`);
    r.push(await klick(client, '[data-consignment-record-sale-selected]'));
    r.push(await verkaufen('pe-kunde', [{ method: 'cash', amount: 1000 }, { method: 'benefit', amount: 500 }]));
    await merke(client);
    ok(alleOk(r) === 'OK' && kmd('consignments.record_sale').length === 1 && antw('consignments.record_sale').some((a) => a.ok),
      `B PC2 bucht den Verkauf mit EINEM Fernauftrag consignments.record_sale (${alleOk(r)} ${S(antw('consignments.record_sale'))})`);
    const rumpf = (await koerper(client, 'consignments.record_sale')).pop() || {};
    ok(rumpf.items?.length === 3 && rumpf.items.every((i) => Number(i.expectedRevision) >= 1) && rumpf.payments?.length === 2 && rumpf.buyerId === 'pe-kunde',
      `B der Rumpf: drei Artikel je mit gesehener Fassung, Käufer, zwei Zahlungen (${S(rumpf).slice(0, 220)})`);
  }
  const inv = String(kon(K1).invoice_id || '');
  {
    const i = zeile('invoices', inv);
    ok(inv && kon(K2).invoice_id === inv && kon(K3).invoice_id === inv && [K1, K2, K3].every((k) => kon(k).status === 'sold'),
      'C Primary: alle drei Kommissionen sold, an DERSELBEN Rechnung');
    ok(zahl('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?', [inv]) === 3 && r3(i.gross_amount) === 6000 && r3(i.paid_amount) === 1500
      && i.status === 'PARTIAL' && String(i.issued_at || '').slice(0, 10) === new Date().toISOString().slice(0, 10),
    `C EINE Rechnung: 3 Zeilen, 6000, bezahlt 1500, PARTIAL, datiert auf den Verkaufstag (${S([i.gross_amount, i.paid_amount, i.status, i.issued_at])})`);
    const pays = dbQ(BIZ_DB, 'SELECT method, amount FROM payments WHERE invoice_id = ? ORDER BY amount', [inv]);
    ok(S(pays.map((p) => [p.method, r3(p.amount)])) === S([['benefit', 500], ['cash', 1000]]), `C Zahlungen bar + Benefit (${S(pays)})`);
    const ein = [K1, K2, K3].map((k) => einkaufVon(k));
    const zeilenA = dbQ(BIZ_DB, 'SELECT source_consignment_id AS k, line_total AS v FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [ein[0].id]);
    ok(ein[0].id && ein[0].id === ein[1].id && ein[0].id !== ein[2].id && r3(ein[0].total_amount) === 2400 && r3(ein[2].total_amount) === 2400
      && ein[0].supplier_id !== ein[2].supplier_id
      && S(zeilenA.map((z) => [z.k, r3(z.v)]).sort((x, y) => x[1] - y[1])) === S([[K1, 800], [K2, 1600]])
      && zahl('SELECT COUNT(*) AS n FROM purchase_payments') === 0,
    `C je Einlieferer EIN Einkauf: A 2400 (Zeilen 800 / 1600), B 2400 — nichts automatisch ausgezahlt (${S(ein.map((p) => [p.total_amount, p.supplier_id]))})`);
    ok(r3(zahl("SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) AS n FROM ledger_entries")) === 0, 'C Hauptbuch ausgeglichen');
  }

  // ── D D3: Einlieferer A ist für K1 bezahlt; der Käufer bringt K1 zurück → „Repayment still open" am PC2 ────
  {
    // Der gemeinsame Einkauf von Einlieferer A (K1 + K2, 2400) wird ganz bezahlt; zurück käme bei K1 genau seine Zeile (800).
    const p1 = einkaufVon(K1);
    const z = await sende(client, 'purchases.record_payment', { purchaseId: p1.id, expectedRevision: Number(p1.revision), amount: 2400, method: 'bank' });
    await spuelen(primary);
    ok(z.status === 200 && z.body?.ok && zeile('purchases', p1.id).status === 'PAID', `D gemeinsamer Einkauf von A bezahlt (bank 2400) (${z.status})`);
    const bank = saldo('BANK');
    await syncRuhe();
    client = await lade(client, `/consignments/${K1}`);
    await waitFor(client, '[data-consignment-return-after-sale]', 45000);
    const r = [await klick(client, '[data-consignment-return-after-sale]')];
    if (!(await warteBis(client, q('[data-consignor-refund]'), 15000))) r.push('KEINE-WAHL');
    r.push(await klick(client, '[data-consignor-refund-mode="pending"]'));
    r.push(await klick(client, '[data-consignment-return-after-sale-confirm]'));
    if (!(await warteBis(client, `!${q('[data-consignor-refund]')}`, 30000))) r.push('BLEIBT:' + (await fehlerText(client)));
    await spuelen(primary);
    await merke(client);
    const rumpf = (await koerper(client, 'consignments.return_after_sale')).pop() || {};
    ok(alleOk(r) === 'OK' && rumpf.consignorRefund?.mode === 'pending', `D PC2 schickt die Rückgabe mit der Wahl „pending" (${alleOk(r)} ${S(rumpf)})`);
    const pret = dbQ(BIZ_DB, 'SELECT status, refund_method, refund_amount FROM purchase_returns WHERE purchase_id = ?', [p1.id])[0] || {};
    const sc = dbQ(BIZ_DB, 'SELECT amount, used_amount, status FROM supplier_credits')[0] || {};
    ok(kon(K1).status === 'returned' && pret.refund_method === 'credit' && r3(pret.refund_amount) === 800 && r3(sc.amount) === 800 && sc.status === 'OPEN',
      `D Primary: K1 returned, Lieferanten-Retoure mit offener Rückforderung 800 (${S([kon(K1).status, pret, sc])})`);
    ok(saldo('BANK') === bank && zahl("SELECT COUNT(*) AS n FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND reverses_entry_id IS NOT NULL") === 0,
      `D kein fiktiver Geldeingang: Bank unverändert, die Auszahlung wurde nicht umgebucht (${bank} → ${saldo('BANK')})`);
    ok(kon(K2).status === 'sold' && kon(K3).status === 'sold' && zeile('invoices', inv).status !== 'CANCELLED',
      'D die übrigen Artikel der Rechnung bleiben verkauft');
    // Die Detailseite am PC2 zeigt die offene Rückforderung (reist mit dem Lesebefehl).
    client = await lade(client, `/consignments/${K1}`);
    const anzeige = await warteBis(client, "document.querySelector('[data-consignor-repayment=\"pending\"]') && /800\\.000 BHD open/.test(document.body.innerText)", 30000);
    ok(anzeige, 'D PC2-Detailseite: „Repayment pending — 800 open"');
  }

  // ── E Cancel Sale der ganzen Rechnung ist am PC2 VORHER gesperrt (K1 ging samt Rückzahlung zurück) ──────────
  {
    client = await lade(client, `/consignments/${K2}`);
    await waitFor(client, '[data-consignment-cancel-sale]', 45000);
    await klick(client, '[data-consignment-cancel-sale]');
    const sperre = await warteBis(client, `${q(`[data-cancel-sale-settled="${K1}"]`)} && ${q('[data-consignment-cancel-sale-confirm]')}.disabled`, 15000);
    const liste = String(await client.ev(`return ${q('[data-cancel-sale-items]')}?.innerText || '';`));
    ok(sperre && /Alpha CMS/.test(liste) && /Beta CMS/.test(liste) && /Gamma CMS/.test(liste),
      `E PC2: der Storno-Dialog zeigt alle drei Artikel und sperrt vorher (${liste.replace(/\s+/g, ' ').slice(0, 120)})`);
  }

  // ── F Ein zweiter Verkauf (zwei Einlieferer), Einlieferer B bezahlt; Cancel Sale am PC2 mit „Geld zurück (Kasse)" ──
  {
    const K4 = await kommission('cm-con-a', 'Delta CMS', 1000);
    const K5 = await kommission('cm-con-b', 'Epsilon CMS', 2000);
    const r = [await itemsListe()];
    r.push(await klick(client, `[data-consignment-select="${K4}"]`));
    r.push(await klick(client, `[data-consignment-select="${K5}"]`));
    r.push(await klick(client, '[data-consignment-record-sale-selected]'));
    r.push(await verkaufen('pe-kunde', []));
    const inv2 = String(kon(K4).invoice_id || '');
    ok(alleOk(r) === 'OK' && inv2 && kon(K5).invoice_id === inv2, `F zweiter Verkauf über zwei Einlieferer gebucht (${alleOk(r)})`);
    const p5 = einkaufVon(K5);
    await sende(client, 'purchases.record_payment', { purchaseId: p5.id, expectedRevision: Number(p5.revision), amount: 1600, method: 'bank' });
    await spuelen(primary);
    const kasse = saldo('CASH');
    await syncRuhe();
    client = await lade(client, `/consignments/${K4}`);
    await waitFor(client, '[data-consignment-cancel-sale]', 45000);
    const s = [await klick(client, '[data-consignment-cancel-sale]')];
    if (!(await warteBis(client, q(`[data-consignor-refund="${K5}"]`), 15000))) s.push('KEINE-WAHL-FUER-K5');
    s.push(await klick(client, '[data-consignment-cancel-sale-confirm]'));
    if (!(await warteBis(client, `!${q('[data-consignment-cancel-sale-confirm]')}`, 30000))) s.push('BLEIBT:' + (await fehlerText(client)));
    await spuelen(primary);
    await merke(client);
    const rumpf = (await koerper(client, 'consignments.cancel_sale')).pop() || {};
    ok(alleOk(s) === 'OK' && rumpf.consignorRefunds?.[K5]?.mode === 'received', `F PC2 storniert die GANZE Rechnung, Wahl für den bezahlten Einlieferer im Rumpf (${alleOk(s)} ${S(rumpf)})`);
    const pret = dbQ(BIZ_DB, 'SELECT status, refund_method, refund_amount FROM purchase_returns WHERE purchase_id = ?', [p5.id])[0] || {};
    ok(kon(K4).status === 'active' && kon(K5).status === 'active' && zeile('invoices', inv2).status === 'CANCELLED'
      && einkaufVon(K4).id === undefined && pret.status === 'COMPLETED' && pret.refund_method === 'cash' && r3(pret.refund_amount) === 1600,
    `F Primary: beide active, Rechnung storniert, unbezahlter Einkauf storniert, bezahlter über Lieferanten-Retoure (Kasse 1600) (${S(pret)})`);
    ok(r3(saldo('CASH') - kasse) === 1600, `F Kasse +1600 als tatsächlicher Eingang (${kasse} → ${saldo('CASH')})`);
    ok(r3(zahl("SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) AS n FROM ledger_entries")) === 0, 'F Hauptbuch ausgeglichen');
  }

  // ── G Abgleich am Primary: Lager == Lose, AP == offene Einkäufe, Lieferanten-Guthaben == Hauptbuch ──────────
  {
    const lose = r3(zahl("SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS n FROM stock_lots WHERE status = 'ACTIVE'"));
    const ap = r3(zahl("SELECT COALESCE(SUM(remaining_amount), 0) AS n FROM purchases WHERE status NOT IN ('CANCELLED','DRAFT')"));
    const sc = r3(zahl("SELECT COALESCE(SUM(amount - used_amount), 0) AS n FROM supplier_credits"));
    ok(r3(saldo('INVENTORY')) === lose && r3(-saldo('ACCOUNTS_PAYABLE')) === ap && r3(saldo('SUPPLIER_CREDIT')) === sc,
      `G Abgleich: Lager ${saldo('INVENTORY')}==${lose}, AP ${-saldo('ACCOUNTS_PAYABLE')}==${ap}, Guthaben ${saldo('SUPPLIER_CREDIT')}==${sc}`);
  }

  // ── H PC2 ohne Datenbank, Prozess-Isolation ─────────────────────────────────────────────────────
  await merke(client);
  ok(ALLE_TREFFER.length === 0, `H PC2 hat nie eine Geschäftsdatenbank angefasst (${S(ALLE_TREFFER).slice(0, 120)})`);
  // ── R FINAL RELEASE GATE: Rückzahlung + Workshop am PC2, historische Zuordnung, dann Sicherung → Wiederherstellung ──
  //    R1 PC2 „Record Repayment" (300 Kasse) auf die offene Rückforderung aus D  → supplier_credit_refunds + Hauptbuch
  //    R2 PC2 „New Supplier" mit „Is Workshop" und „Edit Supplier" → is_workshop; Einkäufe/Zahlungen/Buchungen unverändert
  //    R3 PC2 Repair-Auswahl nur Workshops; eine Reparatur behält ihren Workshop, auch wenn die Markierung fällt
  //    R4 echte Sicherung (Snapshot-Host) → frischer Ordner → echte Wiederherstellung → echte App → Bild unverändert
  {
    const heute = new Date().toISOString().split('T')[0];
    const credit = dbQ(BIZ_DB, "SELECT id, supplier_id, amount, used_amount FROM supplier_credits WHERE status = 'OPEN' ORDER BY rowid")[0] || {};
    const kasse0 = saldo('CASH');
    // R1 — Rückzahlung über die echte Maske am PC2.
    await syncRuhe();
    client = await lade(client, `/consignments/${K1}`);
    await waitFor(client, `[data-consignor-repayment-record="${credit.id}"]`, 45000);
    const r = [await klick(client, `[data-consignor-repayment-record="${credit.id}"]`)];
    if (!(await warteBis(client, q('[data-consignor-repayment-dialog]'), 15000))) r.push('KEIN-DIALOG');
    r.push(await setVal(client, '[data-consignor-repayment-amount]', '300'));
    r.push(await klick(client, '[data-consignor-repayment-method="cash"]'));
    r.push(await klick(client, '[data-consignor-repayment-confirm]'));
    if (!(await warteBis(client, `!${q('[data-consignor-repayment-dialog]')}`, 30000))) r.push('BLEIBT:' + (await fehlerText(client)));
    await spuelen(primary);
    const belege = dbQ(BIZ_DB, 'SELECT supplier_credit_id, amount, method, received_at FROM supplier_credit_refunds');
    const nachCredit = zeile('supplier_credits', credit.id);
    const buchung = dbQ(BIZ_DB, "SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'SUPPLIER_CREDIT_REFUND' ORDER BY account");
    ok(alleOk(r) === 'OK' && belege.length === 1 && belege[0].supplier_credit_id === credit.id && r3(belege[0].amount) === 300 && belege[0].method === 'cash'
      && String(belege[0].received_at).startsWith(heute),
      `R1 PC2 „Record Repayment": ein Beleg 300 Kasse, heute (${alleOk(r)} ${S(belege)})`);
    ok(r3(nachCredit.used_amount) === 300 && nachCredit.status === 'OPEN' && r3(saldo('CASH') - kasse0) === 300
      && S(buchung.map((b) => [b.account, b.direction, r3(b.amount)])) === S([['CASH', 'DEBIT', 300], ['SUPPLIER_CREDIT', 'CREDIT', 300]]),
      `R1 Primary: Guthaben 300 von 800 eingelöst, DR Kasse / CR Lieferanten-Guthaben (${S(buchung)})`);
    client = await lade(client, `/consignments/${K1}`);
    const teil = await warteBis(client, "document.querySelector('[data-consignor-repayment-status=\"partial\"]') && /500\\.000 BHD still open/.test(document.body.innerText) && document.querySelector('[data-consignor-repayment-receipts]')", 30000);
    ok(teil, 'R1 PC2-Detailseite: „Partly repaid — 500 still open" und der Beleg');

    // R2 — Workshop-Markierung über die echten Masken am PC2; die Bücher bleiben.
    const buecher = () => S(['purchases', 'purchase_lines', 'purchase_payments', 'purchase_returns', 'supplier_credits', 'supplier_credit_refunds',
      'ledger_entries', 'invoices', 'payments', 'consignments', 'stock_lots'].map((t) => dbQ(BIZ_DB, `SELECT * FROM ${t} ORDER BY rowid`)));
    const vorBuecher = buecher();
    // Einlieferer A = der Lieferant der offenen Rückforderung aus D; B = der andere Einlieferer.
    const supA = String(credit.supplier_id || '');
    const supB = String(dbQ(BIZ_DB, "SELECT supplier_id FROM purchases WHERE supplier_id != ? AND source_consignment_id IS NOT NULL LIMIT 1", [supA])[0]?.supplier_id || '');
    const WNAME = 'Gate Workshop ' + Date.now().toString(36);
    client = await lade(client, '/suppliers');
    await waitFor(client, SHELL, 30000);
    const n = [await clickText(client, 'New Supplier')];
    if (!(await warteBis(client, q('[data-supplier-create-is-workshop]'), 15000))) n.push('KEIN-DIALOG');
    n.push(await setVal(client, 'input[placeholder="e.g. Gold Dealer LLC"]', WNAME));
    n.push(await klick(client, '[data-supplier-create-is-workshop]'));
    n.push(await klick(client, '[data-supplier-create-save]'));
    if (!(await warteBis(client, `!${q('[data-supplier-create-is-workshop]')}`, 30000))) n.push('BLEIBT:' + (await fehlerText(client)));
    await spuelen(primary);
    const werk = dbQ(BIZ_DB, 'SELECT id, is_workshop, active FROM suppliers WHERE name = ?', [WNAME])[0] || {};
    ok(alleOk(n) === 'OK' && Number(werk.is_workshop) === 1 && Number(werk.active) === 1, `R2 PC2 „New Supplier" mit „Is Workshop" → is_workshop = 1 am Primary (${alleOk(n)})`);
    client = await lade(client, `/suppliers/${supA}`);
    await waitFor(client, SHELL, 30000);
    const e = [await clickText(client, 'Edit')];
    if (!(await warteBis(client, q('[data-supplier-is-workshop]'), 15000))) e.push('KEIN-FELD');
    e.push(await klick(client, '[data-supplier-is-workshop]'));
    e.push(await klick(client, '[data-supplier-save]'));
    if (!(await warteBis(client, `!${q('[data-supplier-is-workshop]')}`, 30000))) e.push('BLEIBT:' + (await fehlerText(client)));
    await spuelen(primary);
    ok(alleOk(e) === 'OK' && Number(zeile('suppliers', supA).is_workshop) === 1 && Number(zeile('suppliers', supB).is_workshop) === 0,
      `R2 PC2 „Edit Supplier" markiert den Einlieferer A; B bleibt unmarkiert (${alleOk(e)})`);
    ok(buecher() === vorBuecher, 'R2 Einkäufe, Zahlungen, Retouren, Guthaben, Belege, Hauptbuch, Rechnungen, Kommissionen und Lose bitgleich');
    client = await lade(client, '/suppliers');
    const badge = await warteBis(client, `[...document.querySelectorAll('[data-supplier-workshop-badge]')].map((b) => b.parentElement.textContent).some((t) => t.includes(${S(WNAME)}))`, 30000);
    ok(badge, 'R2 PC2-Lieferantenliste zeigt das Workshop-Badge');

    // R3 — Auswahl am PC2 und historische Zuordnung.
    client = await lade(client, '/repairs');
    await waitFor(client, SHELL, 30000);
    const a = [await clickText(client, 'New Repair')];
    await sleep(800);
    // REPAIR-REDESIGN — „Wer arbeitet?": die Werkstatt ankreuzen; eigene Arbeit ist ein eigenes Häkchen, kein Eintrag der Auswahl.
    a.push(await client.ev("const e=document.querySelector('[data-repair-create-external]'); if(!e) return 'NO-EXTERNAL'; if(!e.checked) e.click(); return 'OK';"));
    await sleep(500);
    a.push(await client.ev(`const l=[...document.querySelectorAll('[data-ss-trigger="Pick a workshop / goldsmith"]')]; const t=l[l.length-1]; if(!t) return 'NO-TRIGGER'; t.click(); return 'OK';`));
    const angebot = await warteBis(client, `document.querySelector('[data-ss-option=${S(werk.id)}]')`, 15000);
    const auswahl = await client.ev(`return { werk: !!document.querySelector('[data-ss-option=${S(werk.id)}]'), a: !!document.querySelector('[data-ss-option=${S(supA)}]'), b: !!document.querySelector('[data-ss-option=${S(supB)}]'), inhouse: !!document.querySelector('[data-ss-option="__INHOUSE__"]') };`);
    ok(alleOk(a) === 'OK' && angebot && auswahl.werk && auswahl.a && !auswahl.b && !auswahl.inhouse,
      `R3 PC2 Repair-Auswahl: die Workshops, NICHT der unmarkierte Lieferant; eigene Arbeit ist das eigene Häkchen (${S(auswahl)})`);
    await client.ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); [...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Cancel').forEach(b=>b.click()); return 1;");
    const rep = await sende(client, 'repairs.create', { customerId: 'pe-kunde', issueDescription: 'Gate glass', repairType: 'external', workshopSupplierId: werk.id, receivedAt: heute });
    await spuelen(primary);
    const repId = String(rep.body?.value?.repairId || '');
    ok(rep.status === 200 && zeile('repairs', repId).workshop_supplier_id === werk.id, `R3 Reparatur mit diesem Workshop angelegt (${rep.status})`);
    const aus = await sende(client, 'suppliers.update', { id: werk.id, isWorkshop: false });
    await spuelen(primary);
    ok(aus.status === 200 && Number(zeile('suppliers', werk.id).is_workshop) === 0 && zeile('repairs', repId).workshop_supplier_id === werk.id,
      'R3 Markierung zurückgenommen: die Reparatur behält ihren Workshop');
    await syncRuhe();
    client = await lade(client, `/repairs/${repId}`);
    const historisch = await warteBis(client, `document.body.innerText.includes(${S(WNAME)})`, 30000);
    ok(historisch, 'R3 PC2 zeigt die Reparatur weiter mit ihrem (nicht mehr markierten) Workshop');
    const sc = r3(zahl("SELECT COALESCE(SUM(amount - used_amount), 0) AS n FROM supplier_credits"));
    ok(r3(saldo('SUPPLIER_CREDIT')) === sc && r3(zahl("SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) AS n FROM ledger_entries")) === 0,
      `R3 Abgleich: Lieferanten-Guthaben ${saldo('SUPPLIER_CREDIT')} == ${sc}, Hauptbuch ausgeglichen`);

    // R4 — Sicherung → frischer Ordner → Wiederherstellung → echte App.
    await merke(client);
    await spuelen(primary);
    try { steuer?.close(); } catch { /* zu */ }
    try { client?.close(); } catch { /* zu */ }
    client = null;
    killTestImage('lataif-e2e-client.exe'); await waitTestImageGone('lataif-e2e-client.exe');
    try { primary?.close(); } catch { /* zu */ }
    primary = null;
    killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe'); await sleep(1500);
    const TAB = ['supplier_credit_refunds', 'supplier_credits', 'suppliers', 'repairs', 'repair_lines', 'purchases', 'purchase_lines', 'purchase_payments',
      'purchase_returns', 'invoices', 'invoice_lines', 'payments', 'consignments', 'ledger_entries', 'stock_lots', 'customers'];
    const ohneLagerdauer = (rows) => rows.map(({ days_in_stock: _d, ...x }) => x);
    const bild = () => S({ ...Object.fromEntries(TAB.map((t) => [t, dbQ(BIZ_DB, `SELECT * FROM ${t} ORDER BY rowid`)])),
      products: ohneLagerdauer(dbQ(BIZ_DB, 'SELECT * FROM products ORDER BY id')),
      media_links: dbQ(BIZ_DB, 'SELECT link_id, entity_type, entity_id, media_id, sort_order, deleted_at FROM media_links ORDER BY link_id') });
    const vor = bild();
    const spalten = dbQ(BIZ_DB, 'PRAGMA table_info(suppliers)').map((c) => c.name);
    const mediaVor = existsSync(MEDIA_ROOT) ? readdirSync(MEDIA_ROOT, { recursive: true }).length : 0;
    const snapDir = join(RUN, 'backups', 'snap-gate');
    mkdirSync(join(RUN, 'backups'), { recursive: true });
    const out = seedCmd('backup', APP_DATA_DIR, snapDir, new Date().toISOString());
    const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'));
    ok(/^BACKUP_OK files=\d+ additional=1 status=complete$/.test(out) && manifest.additionalDbFiles?.[0]?.fileName === 'lataif_sync_server.db'
      && manifest.files.every((f) => existsSync(join(snapDir, f.relPath)) && sha256(join(snapDir, f.relPath)) === f.hash),
      `R4 Sicherung mit dem echten Snapshot-Host: beide Datenbanken, jede Datei passt zu ihrem Hash (${out})`);
    const identity = join(RUN, 'identity'); mkdirSync(identity, { recursive: true });
    const carried = readdirSync(APP_DATA_DIR, { withFileTypes: true }).filter((x) => x.isFile() && !/^lataif(_sync_server)?\.db/.test(x.name)).map((x) => x.name);
    for (const f of carried) copyFileSync(join(APP_DATA_DIR, f), join(identity, f));
    rmSync(APP_DATA_DIR, { recursive: true, force: true });
    mkdirSync(APP_DATA_DIR, { recursive: true });
    for (const f of carried) copyFileSync(join(identity, f), join(APP_DATA_DIR, f));
    ok(!existsSync(BIZ_DB) && !existsSync(SERVER_DB), `R4 frischer Datenordner ohne Datenbanken (Kennung übernommen: ${carried.join(', ') || 'keine'})`);
    const rout = seedCmd('restore', APP_DATA_DIR, snapDir);
    ok(/^RESTORE_OK files=\d+ status=complete$/.test(rout) && sha256(BIZ_DB) === manifest.db.sha256 && sha256(SERVER_DB) === manifest.additionalDbFiles[0].sha256,
      `R4 echte Wiederherstellung, beide Datenbanken byte-gleich (${rout})`);
    ok(bild() === vor && S(dbQ(BIZ_DB, 'PRAGMA table_info(suppliers)').map((c) => c.name)) === S(spalten) && spalten.includes('is_workshop'),
      'R4 Rückzahlungsbeleg, Guthaben, Workshop-Markierungen, Reparatur-Zuordnung, Einkäufe, Rechnungen, Hauptbuch und Artikel unverändert; Spalte is_workshop da');
    ok((existsSync(MEDIA_ROOT) ? readdirSync(MEDIA_ROOT, { recursive: true }).length : 0) === mediaVor, `R4 Medienbaum wie vorher (${mediaVor} Einträge)`);
    primary = await attach(APP_CDP, APP, appEnv());
    await waitInvoke(primary);
    await waitFor(primary, SHELL + ', input[type="password"], [data-first-run-gate]', 90000);
    ok(!(await exists(primary, '[data-first-run-gate]')), 'R4 die App fragt nach der Wiederherstellung NICHT erneut nach der Einrichtung');
    if (!(await exists(primary, SHELL))) {
      await setVal(primary, 'input[type="email"]', OWNER_EMAIL);
      await setVal(primary, 'input[type="password"]', ONBOARD_PW);
      await primary.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
    }
    await waitFor(primary, SHELL, 90000);
    // Nach dem Neustart auf dem wiederhergestellten Stand braucht die erste Seite unter Last länger (Startroutinen) — 90 s.
    const fehlerR4 = [];
    primary.ws.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') fehlerR4.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || ''); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') fehlerR4.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')); } catch { /* egal */ } });
    await primary.send('Runtime.enable').catch(() => null);
    await gehFrisch(primary, `/consignments/${K1}`);
    const beleg = await warteBis(primary, "document.querySelector('[data-consignor-repayment-status=\"partial\"]') && document.querySelector('[data-consignor-repayment-receipts]') && /Received .* Cash/.test(document.querySelector('[data-consignor-repayment-receipts]').innerText)", 90000);
    if (!beleg) console.log('      (R4 Fehler) ' + fehlerR4.join(' ~ ').slice(0, 1500));
    if (!beleg) console.log('      (R4 Diagnose) ' + String(await primary.ev("const c = document.querySelector('[data-consignor-repayment]'); return [location.pathname, c ? 'KARTE ' + c.getAttribute('data-consignor-repayment-status') : 'KEINE KARTE', document.body.innerText.split(String.fromCharCode(10)).join(' | ').slice(0, 1500)].join(' || ');").catch((x) => String(x))));
    await gehFrisch(primary, '/suppliers');
    const markiert = await warteBis(primary, "document.querySelectorAll('[data-supplier-workshop-badge]').length === 1", 30000);
    await gehFrisch(primary, `/repairs/${repId}`);
    const zuordnung = await warteBis(primary, `document.body.innerText.includes(${S(WNAME)})`, 30000);
    ok(beleg && markiert && zuordnung, `R4 die wiederhergestellte App zeigt Rückzahlungsbeleg, genau einen markierten Workshop und die alte Zuordnung (${S([beleg, markiert, zuordnung])})`);
    await spuelen(primary);
    const nachStart = bild();
    try { primary.close(); } catch { /* zu */ }
    primary = null;
    killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe'); await sleep(1500);
    ok(nachStart === vor, 'R4 der Start auf dem wiederhergestellten Stand ändert daran nichts (außer der täglichen Lagerdauer)');
  }

  const fremdNachher = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  ok(S(fremdVorher) === S(fremdNachher), 'ISOLATION fremde LATAIF-Prozesse (die Produktions-App) unberührt');
} catch (e) {
  ok(false, 'ABBRUCH: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
} finally {
  clearTimeout(WACHHUND);
  try { steuer?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { primary?.close(); } catch { /* zu */ }
  aufraeumen();
}
console.log(`\nconsignment-multi-sale-pc2 e2e: ${PASS} passed, ${FAIL} failed (${Math.round((Date.now() - T0) / 1000)} s)`);
if (FAIL) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('CONSIGNMENT_MULTI_SALE_PC2_E2E_PROVED');
process.exit(0);
