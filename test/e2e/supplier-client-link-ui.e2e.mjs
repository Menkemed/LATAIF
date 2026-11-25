// ════════════════════════════════════════════════════════════════════════════
// SUPPLIER-CLIENT-LINK-UI — „Link to Client" (Lieferantenseite) und „Link Supplier" (Kundenseite),
// Primary und PC2, echte Maus/Tastatur.
// Run: node test/e2e/supplier-client-link-ui.e2e.mjs
//   (nach `npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e-client.conf.json`,
//    Kopie nach lataif-e2e-client.exe, dann `… --config src-tauri/tauri.e2e.conf.json`)
//
//   1  Primary, Lieferant „Cash Customer" (unverknüpft, gleicher Name wie ein Kunde): der Hinweis „Possible match"
//      hat jetzt „Link to this client" → Bestätigung → Link. Nur linked_customer_id gesetzt; „Linked Client" erscheint.
//   2  Primary, Lieferant ohne Treffer: Kopfknopf „Link to Client" → freie Suche → Kunde wählen → Link.
//      Ein Kunde, der schon eine Lieferantenrolle hat, steht in der Suche, ist aber nicht wählbar.
//   3  PC2, Kunde „Muneer Watchmaker" (gleiche Telefonnummer wie Lieferant „Muneer"): „Link this supplier" → Link
//      über suppliers.update am Primary.
//   4  PC2, Kunde mit Lieferantenrolle: kein „Link Supplier"-Knopf. Kunde ohne Treffer: „Link Supplier" → Suche →
//      ein schon verknüpfter Lieferant ist nicht wählbar.
//   5  Nichts sonst geändert: Einkäufe, Hauptbuch, übrige Spalten der Lieferanten.
//   6  Unlink (V3): bei aktiver Verrechnung abgelehnt (Meldung nennt die STL); sonst mit Pflichtgrund gelöst — Primary und PC2.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat oder was am
// EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids } from './_e2e-process.mjs';
import { maus, tippe } from './_e2e-mouse.mjs';
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
const OWNER_PW = 'scl-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-supplierlink', 'run-' + Date.now());
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
const text = (c, sel) => c.ev(`return (document.querySelector(${S(sel)})?.textContent || '').replace(/\\s+/g, ' ').trim();`);

const HAKEN = `
  if (!window.__slHaken) {
    window.__slHaken = true; window.__cmds = []; window.__alerts = []; window.__dbHits = [];
    window.alert = (m) => { window.__alerts.push(String(m)); };
    window.confirm = () => true;
    const merke = (t) => window.__dbHits.push(String(t).slice(0, 200));
    const oe = console.error; console.error = (...a) => { const t = a.map((x) => (x && x.message) ? x.message : String(x)).join(' '); if (/Database not initialized/.test(t)) merke(t); oe(...a); };
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
// Stammdaten. Kunden K*, Lieferanten S*.
const KUNDEN = [
  // id        Vorname   Nachname      Telefon
  ['sl-k1', 'Cash', 'Customer', null],
  ['sl-k2', 'Muneer', 'Watchmaker', '+973 3379 2066'],
  ['sl-k3', 'Taken', 'Client', '+973 3600 0003'],     // hat schon Lieferant S3
  ['sl-k4', 'Fourth', 'Client', '+973 3600 0004'],    // ohne Treffer, für die freie Suche
  ['sl-k5', 'Fifth', 'Person', '+973 3600 0005'],     // PC2: Kunde ohne Treffer
];
const LIEFERANTEN = [
  // id        Name               Telefon          verknüpft
  ['sl-s1', 'Cash Customer', null, null],
  ['sl-s2', 'Muneer', '+97333792066', null],
  ['sl-s3', 'Taken Supplier', '+973 3600 0003', 'sl-k3'],
  ['sl-s4', 'Other Name Trading', '+973 3600 0099', null],
];

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
    const now = '2026-11-20T08:00:00.000Z';
    for (const [id, first_name, last_name, phone] of KUNDEN) {
      insert(db, 'customers', { id, branch_id, first_name, last_name, phone, country: 'BH', language: 'en',
        vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    for (const [id, name, phone, linked] of LIEFERANTEN) {
      insert(db, 'suppliers', { id, branch_id, name, phone, linked_customer_id: linked, active: 1, notes: 'seed ' + id, created_at: now, updated_at: now });
    }
    // 6 — eine AKTIVE Verrechnung zwischen K4 und einem Einkauf von S4 (nur die Zeile, die die Sperre liest).
    insert(db, 'purchases', { id: 'sl-p4', branch_id, purchase_number: 'PUR-SL-4', supplier_id: 'sl-s4', status: 'PAID', total_amount: 10,
      paid_amount: 0, remaining_amount: 0, purchase_date: '2026-11-20', created_at: now, updated_at: now });
    insert(db, 'party_offsets', { id: 'sl-po', branch_id, offset_number: 'STL-2026-009999/1', settlement_number: 'STL-2026-009999', customer_id: 'sl-k4',
      receivable_type: 'INVOICE', receivable_id: 'sl-inv', receivable_payment_id: 'sl-inv-pay', payable_type: 'PURCHASE', payable_id: 'sl-p4',
      payable_payment_id: 'sl-p4-pay', amount: 10, offset_date: '2026-11-20', status: 'ACTIVE', created_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}
const verknuepft = (sid) => dbQ(BIZ_DB, 'SELECT linked_customer_id AS l FROM suppliers WHERE id = ?', [sid])[0]?.l ?? null;
// Alle Spalten eines Lieferanten außer der Verknüpfung, dem Änderungsstempel und dem Stand (`revision` zählt der
// Trigger trg_suppliers_revision bei jeder Änderung hoch — er wird unten eigens geprüft).
const rumpf = (sid) => { const r = { ...(dbQ(BIZ_DB, 'SELECT * FROM suppliers WHERE id = ?', [sid])[0] || {}) }; delete r.linked_customer_id; delete r.updated_at; delete r.revision; return S(r); };
const stand = (sid) => Number(dbQ(BIZ_DB, 'SELECT revision AS r FROM suppliers WHERE id = ?', [sid])[0]?.r);
const zaehle = (t) => dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM ${t}`)[0]?.n;

// Dialog über die echte Maus: Suche tippen, Treffer wählen, Link.
async function sucheUndWaehle(c, suchtext, pickSel) {
  const r = [];
  if (!(await warteBis(c, q('[data-link-search]'), 10000))) return 'KEIN-DIALOG';
  r.push(await tippe(c, '[data-link-search]', suchtext));
  r.push((await warteBis(c, q(pickSel), 10000)) ? 'OK' : 'KEIN-TREFFER:' + pickSel);
  if (r.at(-1) !== 'OK') return alleOk(r);
  r.push(await maus(c, pickSel));
  return alleOk(r);
}
async function bestaetigen(c) {
  const r = [(await warteBis(c, q('[data-link-confirm]'), 10000)) ? 'OK' : 'KEINE-BESTAETIGUNG'];
  if (r[0] === 'OK') r.push(await maus(c, '[data-link-save]'));
  return alleOk(r);
}

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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'SL Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'SL Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'SL Admin');
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
  ok(zaehle('suppliers') === LIEFERANTEN.length && zaehle('customers') === KUNDEN.length, `SETUP ${KUNDEN.length} Kunden, ${LIEFERANTEN.length} Lieferanten im Primary`);

  const vorher = { ledger: zaehle('ledger_entries'), purchases: zaehle('purchases'), expenses: zaehle('expenses'), invoices: zaehle('invoices'),
    rumpf: Object.fromEntries(LIEFERANTEN.map(([id]) => [id, rumpf(id)])),
    stand: Object.fromEntries(LIEFERANTEN.map(([id]) => [id, stand(id)])) };

  // ── 1 Primary: „Cash Customer" über den Hinweis „Possible match" ────────
  {
    await gehFrisch(primary, '/suppliers/sl-s1');
    const hinweis = await warteBis(primary, q('[data-client-possible-link]'), 30000);
    ok(hinweis, '1 PRIMARY Lieferant „Cash Customer": der Hinweis „Possible match" hat einen Link-Knopf');
    ok(await exists(primary, '[data-supplier-link-client]'), '1 PRIMARY Kopfknopf „Link to Client" ist da (noch nicht verknüpft)');
    const r = [hinweis ? await maus(primary, '[data-client-possible-link]') : 'KEIN-HINWEIS'];
    r.push(await bestaetigen(primary));
    const bestaetigung = await text(primary, '[data-link-confirm]').catch(() => '');
    await spuelen(primary).catch(() => null);
    const gesetzt = await warteAuf(() => verknuepft('sl-s1') === 'sl-k1');
    ok(alleOk(r) === 'OK' && gesetzt, `1 PRIMARY echte Maus: Link → linked_customer_id = Cash Customer (${alleOk(r)}; ${verknuepft('sl-s1')})`);
    ok(/Cash Customer/.test(bestaetigung) || gesetzt, '1 die Bestätigung nannte Kunde und Lieferant');
    ok(await warteBis(primary, q('[data-linked-client-open]'), 15000), '1 PRIMARY „Linked Client" mit Kundensaldo erscheint');
    ok(!(await exists(primary, '[data-supplier-link-client]')) && !(await exists(primary, '[data-client-possible-match]')),
      '1 PRIMARY danach kein Link-Knopf und kein „Possible match" mehr');
  }

  // ── 2 Primary: freie Suche vom Lieferanten ohne Treffer ─────────────────
  {
    await gehFrisch(primary, '/suppliers/sl-s4');
    ok(await warteBis(primary, q('[data-supplier-link-client]'), 30000) && !(await exists(primary, '[data-client-possible-match]')),
      '2 PRIMARY Lieferant ohne Treffer: kein „Possible match", aber „Link to Client"');
    const r = [await maus(primary, '[data-supplier-link-client]')];
    // Erst den vergebenen Kunden suchen: steht da, ist gesperrt.
    r.push((await warteBis(primary, q('[data-link-search]'), 10000)) ? 'OK' : 'KEIN-DIALOG');
    r.push(await tippe(primary, '[data-link-search]', 'Taken'));
    const gesperrt = await warteBis(primary, `${q('[data-link-pick-customer="sl-k3"]')}?.disabled === true`, 10000);
    const gesperrtText = await text(primary, '[data-link-pick-customer="sl-k3"]');
    ok(gesperrt && /already linked to supplier/.test(gesperrtText), `2 PRIMARY Kunde mit Lieferantenrolle steht in der Suche, ist aber nicht wählbar („${gesperrtText}")`);
    r.push(await sucheUndWaehle(primary, 'Fourth', '[data-link-pick-customer="sl-k4"]'));
    r.push(await bestaetigen(primary));
    await spuelen(primary).catch(() => null);
    const gesetzt = await warteAuf(() => verknuepft('sl-s4') === 'sl-k4');
    ok(alleOk(r) === 'OK' && gesetzt, `2 PRIMARY echte Maus/Tastatur: Suche „Fourth" → Link (${alleOk(r)}; ${verknuepft('sl-s4')})`);
    ok(verknuepft('sl-s3') === 'sl-k3', '2 die vorhandene Verknüpfung S3 → K3 ist unverändert');
  }

  // ── 3 PC2: Kunde „Muneer Watchmaker" über den Hinweis ───────────────────
  {
    await gehFrisch(client, '/clients/sl-k2');
    const hinweis = await warteBis(client, q('[data-supplier-possible-link]'), 30000);
    ok(hinweis, '3 PC2 Kunde „Muneer Watchmaker": der Hinweis „Possible match · supplier Muneer" hat einen Link-Knopf');
    const r = [hinweis ? await maus(client, '[data-supplier-possible-link]') : 'KEIN-HINWEIS'];
    r.push(await bestaetigen(client));
    await spuelen(primary).catch(() => null);
    const gesetzt = await warteAuf(() => verknuepft('sl-s2') === 'sl-k2');
    ok(alleOk(r) === 'OK' && gesetzt, `3 PC2 echte Maus: Link → am Primary linked_customer_id = Muneer Watchmaker (${alleOk(r)}; ${verknuepft('sl-s2')})`);
    ok(await warteBis(client, q('[data-supplier-role-card]'), 15000), '3 PC2 die Lieferantenrolle erscheint auf der Kundenseite');
    ok(!(await exists(client, '[data-customer-link-supplier]')), '3 PC2 danach kein „Link Supplier"-Knopf mehr');
  }

  // ── 4 PC2: Sperren ──────────────────────────────────────────────────────
  {
    await gehFrisch(client, '/clients/sl-k3');
    await warteBis(client, q('[data-supplier-role-card]'), 20000);
    ok((await exists(client, '[data-supplier-role-card]')) && !(await exists(client, '[data-customer-link-supplier]')),
      '4 PC2 Kunde mit Lieferantenrolle: kein „Link Supplier"');
    await gehFrisch(client, '/clients/sl-k5');
    const da = await warteBis(client, q('[data-customer-link-supplier]'), 30000);
    const r = [da ? await maus(client, '[data-customer-link-supplier]') : 'KEIN-KNOPF'];
    r.push((await warteBis(client, q('[data-link-search]'), 10000)) ? 'OK' : 'KEIN-DIALOG');
    r.push(await tippe(client, '[data-link-search]', 'Taken'));
    const gesperrt = await warteBis(client, `${q('[data-link-pick-supplier="sl-s3"]')}?.disabled === true`, 10000);
    ok(alleOk(r) === 'OK' && gesperrt, `4 PC2 „Link Supplier" → Suche: ein schon verknüpfter Lieferant ist nicht wählbar (${alleOk(r)})`);
    await maus(client, '[data-link-pick-supplier="sl-s3"]');   // Klick auf gesperrte Zeile: nichts passiert
    await sleep(800);
    ok(!(await exists(client, '[data-link-confirm]')) && verknuepft('sl-s3') === 'sl-k3', '4 PC2 Klick auf die gesperrte Zeile ändert nichts');
    await clickText(client, 'Cancel');
  }

  // ── 5 Nichts sonst geändert ─────────────────────────────────────────────
  {
    await spuelen(primary).catch(() => null);
    const nachher = { ledger: zaehle('ledger_entries'), purchases: zaehle('purchases'), expenses: zaehle('expenses'), invoices: zaehle('invoices') };
    ok(nachher.ledger === vorher.ledger && nachher.purchases === vorher.purchases && nachher.expenses === vorher.expenses && nachher.invoices === vorher.invoices,
      `5 keine Buchung, kein Einkauf, keine Ausgabe, keine Rechnung (${S(vorher.ledger)}→${S(nachher.ledger)})`);
    const geaendert = LIEFERANTEN.map(([id]) => id).filter((id) => rumpf(id) !== vorher.rumpf[id]);
    ok(geaendert.length === 0, `5 an den Lieferanten änderte sich nur die Verknüpfung (sonst: ${geaendert.join(',') || '—'})`);
    const staende = LIEFERANTEN.map(([id]) => stand(id) - vorher.stand[id]);
    ok(S(staende) === S([1, 1, 0, 1]), `5 der Stand (revision) stieg je Verknüpfung um genau 1, S3 unverändert (${S(staende)})`);
    ok(S(LIEFERANTEN.map(([id]) => verknuepft(id))) === S(['sl-k1', 'sl-k2', 'sl-k3', 'sl-k4']), '5 Endstand der Verknüpfungen S1→K1, S2→K2, S3→K3, S4→K4');
    const ops = (await befehle(client)).map((x) => x.op);
    ok(ops.includes('suppliers.update'), `5 PC2 verknüpfte über den Primary (suppliers.update) (${[...new Set(ops)].filter((o) => /supplier/.test(o)).join(',')})`);
  }

  // ── 6 Unlink (echte Maus/Tastatur): gesperrt bei aktiver Verrechnung, sonst gelöst — Primary und PC2 ──
  const unlinkAudit = (sid) => dbQ(BIZ_DB, "SELECT old_value AS o, new_value AS n, changed_by AS u FROM audit_log WHERE entity_type = 'suppliers' AND entity_id = ? AND field_name = 'linked_customer_id' AND new_value LIKE '%reason%'", [sid]);
  {
    // 6a Primary, S4 ↔ K4 mit aktiver STL: abgelehnt, die Meldung nennt die Nummer, nichts geändert.
    await gehFrisch(primary, '/suppliers/sl-s4');
    const r = [(await warteBis(primary, q('[data-supplier-unlink-client]'), 30000)) ? await maus(primary, '[data-supplier-unlink-client]') : 'KEIN-KNOPF'];
    r.push((await warteBis(primary, q('[data-unlink-reason]'), 10000)) ? 'OK' : 'KEIN-DIALOG');
    r.push(await tippe(primary, '[data-unlink-reason]', 'wrong client'));
    r.push(await maus(primary, '[data-unlink-save]'));
    const gemeldet = await warteBis(primary, `/STL-2026-009999/.test(${q('[data-unlink-supplier-client]')}?.textContent || '')`, 15000);
    ok(alleOk(r) === 'OK' && gemeldet && verknuepft('sl-s4') === 'sl-k4' && unlinkAudit('sl-s4').length === 0,
      `6a PRIMARY Unlink bei aktiver Verrechnung abgelehnt, Meldung nennt STL-2026-009999, Verknüpfung bleibt (${alleOk(r)})`);
    await clickText(primary, 'Cancel');
  }
  {
    // 6b Primary, S1 ↔ K1 ohne Verrechnung: gelöst; danach wieder „Link to Client".
    await gehFrisch(primary, '/suppliers/sl-s1');
    const r = [(await warteBis(primary, q('[data-supplier-unlink-client]'), 30000)) ? await maus(primary, '[data-supplier-unlink-client]') : 'KEIN-KNOPF'];
    r.push((await warteBis(primary, q('[data-unlink-reason]'), 10000)) ? 'OK' : 'KEIN-DIALOG');
    r.push(await tippe(primary, '[data-unlink-reason]', 'linked by mistake'));
    r.push(await maus(primary, '[data-unlink-save]'));
    await spuelen(primary).catch(() => null);
    const geloest = await warteAuf(() => verknuepft('sl-s1') === null);
    const au = unlinkAudit('sl-s1');
    ok(alleOk(r) === 'OK' && geloest, `6b PRIMARY echte Maus/Tastatur: Unlink mit Grund → Verknüpfung entfernt (${alleOk(r)}; ${verknuepft('sl-s1')})`);
    ok(au.length === 1 && /sl-k1/.test(String(au[0].o)) && /linked by mistake/.test(String(au[0].n)), `6b Protokoll mit bisherigem Kunden und Grund (${S(au)})`);
    ok(await warteBis(primary, q('[data-supplier-link-client]'), 15000) && !(await exists(primary, '[data-linked-client-card]')),
      '6b PRIMARY danach wieder „Link to Client", keine Karte „Linked Client"');
  }
  {
    // 6c PC2, Kunde K2 ↔ S2: ohne Grund kein Klick möglich; mit Grund gelöst über den Primary.
    await gehFrisch(client, '/clients/sl-k2');
    const r = [(await warteBis(client, q('[data-customer-unlink-supplier]'), 30000)) ? await maus(client, '[data-customer-unlink-supplier]') : 'KEIN-KNOPF'];
    r.push((await warteBis(client, q('[data-unlink-reason]'), 10000)) ? 'OK' : 'KEIN-DIALOG');
    const gesperrt = await client.ev(`return ${q('[data-unlink-save]')}?.disabled === true;`);
    ok(gesperrt, '6c PC2 ohne Grund ist „Unlink" nicht klickbar');
    r.push(await tippe(client, '[data-unlink-reason]', 'wrong person'));
    r.push(await maus(client, '[data-unlink-save]'));
    await spuelen(primary).catch(() => null);
    const geloest = await warteAuf(() => verknuepft('sl-s2') === null);
    const au = unlinkAudit('sl-s2');
    ok(alleOk(r) === 'OK' && geloest && au.length === 1 && /wrong person/.test(String(au[0].n)),
      `6c PC2 echte Maus/Tastatur: Unlink über den Primary, mit Protokoll (${alleOk(r)}; ${verknuepft('sl-s2')}; ${S(au)})`);
    ok(await warteBis(client, q('[data-customer-link-supplier]'), 15000) && !(await exists(client, '[data-supplier-role-card]')),
      '6c PC2 danach wieder „Link Supplier", keine Karte „Supplier Role"');
  }
  {
    await spuelen(primary).catch(() => null);
    ok(zaehle('ledger_entries') === vorher.ledger && zaehle('purchases') === vorher.purchases && zaehle('invoices') === vorher.invoices
      && dbQ(BIZ_DB, "SELECT status FROM party_offsets WHERE id = 'sl-po'")[0]?.status === 'ACTIVE',
      '6 Unlink änderte keine Buchung, keinen Einkauf, keine Rechnung; die aktive Verrechnung bleibt');
    ok(S(LIEFERANTEN.map(([id]) => verknuepft(id))) === S([null, null, 'sl-k3', 'sl-k4']), '6 Endstand S1, S2 gelöst; S3→K3, S4→K4 bleiben');
    ok((await client.ev('return window.__dbHits.length;')) === 0, '6 PC2 greift auf keine lokale Datenbank zu');
    const alerts = [...JSON.parse(await primary.ev('return JSON.stringify(window.__alerts);')), ...JSON.parse(await client.ev('return JSON.stringify(window.__alerts);'))];
    ok(alerts.length === 0, `6 keine Browser-Meldung (${S(alerts)})`);
  }
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nSUPPLIER-CLIENT-LINK UI: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
