// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5D — Agenten-Transfer anlegen, umwandeln, gesammelt umwandeln vom zweiten Rechner.
// Run: node test/e2e/r5d-transfer-parity.e2e.mjs
//
// Dieselben Masken wie am Primary, auf einem Rechner OHNE Datenbank:
//
//   /agents  „New Transfer" (Kunde, Stück, Our Price, Split 60 %, Rückgabe, Mitarbeiter)  → transfers.create
//   /agents  Transfers → „Create Invoice" → gewählter Kunde                               → transfers.convert_to_invoice
//   /agents  Transfers → „Create Invoice" → „Auto-create from agent"                      → transfers.convert_to_invoice
//   /agents  Transfers → Auswahl → „Create Combined Invoice" → „Auto-create from agent"   → transfers.convert_many_to_invoice
//
// Bewiesen wird: genau EINE Buchung je Handlung, nichts, was der Primary bestimmt, im Rumpf,
// verlorene Antworten legen nichts doppelt an (auch keinen zweiten Kunden), ein Fehler mitten in der
// Sammelrechnung hinterlässt nichts und ein Wiederholen danach gelingt genau einmal — und dieselbe
// Handlung an der Maske des Primary hat DIESELBE Wirkung (Transfer, Agent, Kunde, Rechnung, Buchung).
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
const OWNER_PW = 'r5d-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5d-transfer', 'run-' + Date.now());
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
}, 35 * 60 * 1000);

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
      if (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params?.type || '')) {
        this.events.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
      }
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
/** Ein Feld über seine Beschriftung — so, wie ein Mensch es findet. */
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
/** Ein Textfeld unter einer Überschrift (NOTES …) — dort gibt es kein <label>. */
const setUnterUeberschrift = (c, titel, v) => c.ev(
  `const t=[...document.querySelectorAll('span')].filter(x=>x.textContent.trim()===${S(titel)}).pop(); if(!t) return 'NO-TITLE:'+${S(titel)};`
  + `const e=t.parentElement.querySelector('textarea'); if(!e) return 'NO-TEXTAREA';`
  + `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';`);
/** Eine Auswahlliste, erkannt an einem ihrer Einträge. */
const waehleIn = (c, eintrag, wert) => c.ev(
  `const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.textContent.includes(${S(eintrag)})));`
  + `if(!s) return 'NO-SELECT:'+${S(eintrag)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${S(wert)});`
  + `s.dispatchEvent(new Event('change',{bubbles:true})); return s.value===${S(wert)} ? 'OK' : 'NO-OPTION:'+${S(wert)};`);
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
  window.__killNext = false;
  window.__killed = 0;
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
      if (window.__killNext) {
        window.__killNext = false;
        window.__killed++;
        const r = await of(...a);
        try { await r.text(); } catch (e) { /* egal */ }
        throw new TypeError('the answer was lost after the primary had written');
      }
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

/**
 * Verkaufte Transfers für die Umwandlungen — je Fall ein eigener, und ein Zwilling für den Primary.
 * Agent A (PC2) und Agent B (Primary) tragen dieselben Angaben, damit „Auto-create" vergleichbar ist.
 * Die Nummern stammen aus einem anderen Jahr — der Zähler des laufenden Jahres bleibt unberührt.
 */
const VERKAUFT = [
  ['r5d-t-e1', 'TRF-2025-09001', 'r5d-agent-a', 'MARGIN', 400], ['r5d-t-e2', 'TRF-2025-09002', 'r5d-agent-b', 'MARGIN', 400],
  ['r5d-t-a1', 'TRF-2025-09003', 'r5d-agent-a', 'VAT_10', 330], ['r5d-t-a2', 'TRF-2025-09004', 'r5d-agent-b', 'VAT_10', 330],
  ['r5d-t-l1', 'TRF-2025-09005', 'r5d-agent-a', 'MARGIN', 250],
  ['r5d-t-b1', 'TRF-2025-09006', 'r5d-agent-a', 'MARGIN', 400], ['r5d-t-b2', 'TRF-2025-09007', 'r5d-agent-a', 'VAT_10', 330],
  ['r5d-t-b3', 'TRF-2025-09008', 'r5d-agent-b', 'MARGIN', 400], ['r5d-t-b4', 'TRF-2025-09009', 'r5d-agent-b', 'VAT_10', 330],
  ['r5d-t-f1', 'TRF-2025-09010', 'r5d-agent-a', 'MARGIN', 210], ['r5d-t-f2', 'TRF-2025-09011', 'r5d-agent-a', 'MARGIN', 220],
];
const AGENT = { name: 'Karim Al Mansour', company: 'KM Trading', phone: '+97333000000', whatsapp: '+97333000001', email: 'km@example.com' };
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    if (!db.prepare("SELECT id FROM categories WHERE id = 'cat-watch'").get()) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    }
    for (const [id, first, last] of [['r5d-kunde', 'Nadia', 'Kunde'], ['r5d-kunde2', 'Omar', 'Zwei'], ['r5d-neu-a', 'Samir', 'Neu'], ['r5d-neu-b', 'Samir', 'Neu']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    insert(db, 'employees', { id: 'r5d-emp', branch_id, name: 'R5D Uebergabe', employment_status: 'active', created_at: now, updated_at: now });
    const produkt = (id, stock, source, tax, qty) => {
      insert(db, 'products', { id, branch_id, category_id: 'cat-watch', brand: 'Omega', name: 'R5D ' + id, sku: id.toUpperCase(), condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 200, purchase_currency: 'BHD', planned_sale_price: 800, stock_status: stock, tax_scheme: tax, days_in_stock: 0, quantity: qty, images: '[]', attributes: '{}', source_type: source, created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: id + '-lot', branch_id, product_id: id, unit_cost: 200, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
    };
    for (const id of ['r5d-c1', 'r5d-c2', 'r5d-c3']) produkt(id, 'in_stock', 'OWN', 'MARGIN', 1);
    for (const [aid, cust] of [['r5d-agent-a', 'r5d-kunde'], ['r5d-agent-b', 'r5d-kunde2']]) {
      insert(db, 'agents', { id: aid, branch_id, ...AGENT, commission_rate: 0, active: 1, customer_id: cust, created_at: now, updated_at: now });
    }
    for (const [id, nr, agent, tax, betrag] of VERKAUFT) {
      // Wie nach „Sold" im Haus: das Stück ist verkauft (Menge 0), der Transfer trägt den Abrechnungsbetrag.
      produkt('p-' + id, 'sold', 'AGENT', tax, 0);
      insert(db, 'agent_transfers', {
        id, branch_id, transfer_number: nr, agent_id: agent, product_id: 'p-' + id, agent_price: betrag - 50,
        commission_rate: 0, commission_type: 'percent', commission_value: 0, commission_amount: 0,
        settlement_model: 'full', status: 'sold', transferred_at: now, sold_at: now, actual_sale_price: betrag,
        settlement_amount: betrag, settlement_paid_amount: 0, settlement_status: 'pending', revision: 1,
        created_at: now, updated_at: now,
      });
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
const buchungen = async (c) => (await kommandos(c)).filter((x) => !/\.(list|get)$/.test(String(x.op)));
const treffer = (c) => c.ev('return JSON.stringify(window.__dbHits || []);').then((s) => JSON.parse(s || '[]'));
const spuelen = (p) => p.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const fehlerAnzeige = (c) => c.ev("return [...document.querySelectorAll('[data-save-error]')].map(e=>e.textContent).join(' | ');");

let primary = null, client = null;

/** Den Primary anhalten, seine Datei ändern (nur so erreicht man die Datenbank eines laufenden Hauses), neu starten. */
async function primaryNeustart(aendern) {
  await spuelen(primary).catch(() => null);
  await sleep(1000);
  try { primary.close(); } catch { /* zu */ }
  primary = null;
  killImage('lataif.exe'); await waitGone('lataif.exe');
  const db = new DatabaseSync(BIZ_DB);
  try { aendern(db); } finally { try { db.close(); } catch { /* zu */ } }
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, SHELL, 90000);
  await primary.ev('return await window.__TAURI_INTERNALS__.invoke("sync_server_start", {}).catch((e)=>String(e));').catch(() => null);
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true; } catch { /* noch nicht */ }
    await sleep(500);
  }
  return false;
}

// ── Die Masken, wie ein Mensch sie bedient — auf welchem Rechner auch immer ──
/** „New Transfer": Kunde, Stück, Our Price 900, Split mit 60 %, Rückgabedatum, Mitarbeiter. */
async function neuerTransfer(c, kunde, stueck) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Transfer')", 40000))) return 'KEIN-KNOPF';
  if (await clickText(c, 'New Transfer') !== 'OK') return 'KEIN-KNOPF';
  if (!(await warteBis(c, "document.querySelector('[data-create-transfer]')", 15000))) return 'KEINE-MASKE';
  const r = [];
  await click(c, '[data-ss-trigger="Search clients..."]'); await sleep(500);
  await click(c, `[data-ss-option="${kunde}"]`); await sleep(300);
  if (!(await warteBis(c, `document.querySelector('[data-transfer-product="${stueck}"]')`, 15000))) return 'KEIN-STUECK';
  await click(c, `[data-transfer-product="${stueck}"]`); await sleep(300);
  r.push(await setByLabel(c, 'OUR PRICE (BHD)', '900'));
  r.push(await clickText(c, 'Our Price + Split')); await sleep(300);
  r.push(await setByLabel(c, "SHOP'S SHARE OF EXCESS (%)", '60'));
  r.push(await setByLabel(c, 'RETURN BY (DATE)', '2026-10-01'));
  r.push(await waehleIn(c, 'Unassigned', 'r5d-emp'));
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** Eine Handlung in der Zeile eines Transfers der Liste. */
const inZeile = (c, nr, was) => c.ev(
  `const row=[...document.querySelectorAll('div')].find(d=>d.style&&d.style.gridTemplateColumns&&d.style.cursor==='pointer'&&d.textContent.includes(${S(nr)}));`
  + `if(!row) return 'KEINE-ZEILE:'+${S(nr)}; let el=null;`
  + `if (${S(was)}==='check') el=row.querySelector('input[type=checkbox]');`
  + `else el=row.querySelector('[data-transfer-'+${S(was)}+']');`
  + `if(!el) return 'KEIN-ELEMENT:'+${S(was)}; if (el.disabled) return 'DISABLED'; el.click(); return 'OK';`);
async function transferListe(c) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Transfers')", 40000))) return false;
  await clickText(c, 'Transfers');
  return warteBis(c, "document.body.innerText.includes('TRF-2025-09001')", 30000);
}
/** „Create Invoice" in einer Zeile, dann „BILL TO" und bestätigen. */
async function umwandeln(c, nr, auto) {
  if (await inZeile(c, nr, 'convert') !== 'OK') return 'KEIN-KNOPF';
  if (!(await warteBis(c, "document.querySelector('[data-transfer-convert-confirm]')", 15000))) return 'KEINE-MASKE';
  if (auto && await clickText(c, 'Auto-create from agent') !== 'OK') return 'KEIN-AUTO';
  await sleep(250);
  await click(c, '[data-transfer-convert-confirm]');
  return 'OK';
}
async function sammelMaske(c, nrs) {
  for (const nr of nrs) if (await inZeile(c, nr, 'check') !== 'OK') return 'KEINE-AUSWAHL:' + nr;
  await sleep(300);
  if (await clickText(c, 'Create Combined Invoice') !== 'OK') return 'KEIN-SAMMELKNOPF';
  if (!(await warteBis(c, "document.querySelector('[data-transfer-bulk-confirm]')", 15000))) return 'KEINE-MASKE';
  if (await clickText(c, 'Auto-create from agent') !== 'OK') return 'KEIN-AUTO';
  await sleep(250);
  return 'OK';
}

// ── Was am Primary steht ──
const transferVon = (pid) => dbQ(BIZ_DB, 'SELECT * FROM agent_transfers WHERE product_id = ?', [pid]);
const TR_OHNE = /^(id|agent_id|product_id|transfer_number|version|sync_status)$|_at$/;
const norm = (r, ohne, auch = []) => S(Object.fromEntries(Object.entries(r || {})
  .filter(([k]) => !ohne.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b))));
const AG_OHNE = /^(id|customer_id|version|sync_status)$|_at$/;
const KU_OHNE = /^(id|version|sync_status)$|_at$/;
const INV_OHNE = /^(id|invoice_number|notes|customer_id|revision|version|sync_status)$|_at$|_date$/;
const rechnung = (id) => ({
  kopf: norm(dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [id])[0], INV_OHNE),
  zeilen: S(dbQ(BIZ_DB, 'SELECT unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [id])),
  buchung: S(dbQ(BIZ_DB, 'SELECT account, direction, ROUND(SUM(amount), 3) AS s FROM ledger_entries WHERE source_id = ? GROUP BY account, direction ORDER BY account, direction', [id])),
});
const rechnungVon = (tid) => String(dbQ(BIZ_DB, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [tid])[0]?.invoice_id || '');
const kundeVon = (invId) => dbQ(BIZ_DB, 'SELECT c.* FROM customers c JOIN invoices i ON i.customer_id = c.id WHERE i.id = ?', [invId])[0] || {};
const zahl = (sql, p = []) => Number(Object.values(dbQ(BIZ_DB, sql, p)[0] || { n: 0 })[0]);
const autoKunden = (wofuer) => zahl('SELECT COUNT(*) AS n FROM customers WHERE notes = ?', [`Auto-created from agent ${AGENT.name} for ${wofuer}.`]);
async function warteAuf(pruefe) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}
const aufRechnung = (c) => warteBis(c, "/^\\/invoices\\//.test(location.pathname)", 45000);

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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5D Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5D Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5D Admin');
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
  const HAUS = dbQ(BIZ_DB, 'SELECT id FROM branches LIMIT 1')[0]?.id;

  // ── Der Client: echter Weg, kein Kniff ────────────────────────────────
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
  ok(true, 'CONNECT frischer Rechner, echter Klick auf „Connect", Anmeldung — dann die normale Anwendung');
  await beobachterLegen();
  client = await lade(client, '/agents');
  await waitFor(client, SHELL, 45000);
  ok(await client.ev('return Array.isArray(window.__cmds);') === true, 'SETUP der Beobachter liegt vor dem ersten Skript der Seite');

  // ══════════════════════════════════════════════════════════════════════
  // §10 ANLEGEN — „New Transfer" am zweiten Rechner
  // ══════════════════════════════════════════════════════════════════════
  let pc2T = null;
  const zaehlerVor = zahl("SELECT next_number AS n FROM document_sequences WHERE doc_type = 'TRF'");
  {
    const m = await neuerTransfer(client, 'r5d-neu-a', 'r5d-c1');
    ok(m === 'OK', `CREATE die normale Anlegemaske am zweiten Rechner (${m})`);
    await click(client, '[data-create-transfer]');
    const zu = await warteBis(client, "!document.querySelector('[data-create-transfer]')", 45000);
    ok(zu, `CREATE die Maske schliesst nach dem Anlegen (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'transfers.create', `CREATE genau EINE Buchung: ${cmds.map((x) => x.op).join(',') || 'keine'}`);
    const p = cmds[0]?.payload || {};
    ok(S(Object.keys(p).sort()) === S(['agentPrice', 'customerId', 'excessSplitPct', 'productId', 'returnBy', 'settlementModel', 'staffId']),
      `CREATE der Rumpf traegt genau die Felder der Maske (${Object.keys(p).join(',')})`);
    ok(p.customerId === 'r5d-neu-a' && p.productId === 'r5d-c1' && p.agentPrice === 900 && p.settlementModel === 'split'
      && p.excessSplitPct === 60 && p.returnBy === '2026-10-01' && p.staffId === 'r5d-emp',
      `CREATE …mit den Werten der Maske, auch dem Mitarbeiter (${S(p)})`);
    await warteAuf(() => transferVon('r5d-c1').length > 0);
    const r = transferVon('r5d-c1');
    ok(r.length === 1, `CREATE genau EIN Transfer am Primary (${r.length})`);
    pc2T = r[0] || {};
    ok(pc2T.branch_id === HAUS && /^TRF-\d{4}-\d{5}$/.test(String(pc2T.transfer_number)) && pc2T.status === 'transferred',
      `CREATE Filiale, Nummer und Anfangsstatus bestimmt der Primary (${pc2T.transfer_number}/${pc2T.status})`);
    ok(pc2T.staff_id === 'r5d-emp' && Number(pc2T.agent_price) === 900 && pc2T.settlement_model === 'split'
      && Number(pc2T.excess_split_pct) === 60 && pc2T.return_by === '2026-10-01',
      'CREATE jede Eingabe der Maske steht am Transfer');
    const stueck = dbQ(BIZ_DB, "SELECT stock_status, source_type FROM products WHERE id = 'r5d-c1'")[0] || {};
    ok(stueck.stock_status === 'with_agent' && stueck.source_type === 'AGENT', `CREATE Bestand und Eigentum wechselt das Haus (${S(stueck)})`);
    const ag = dbQ(BIZ_DB, 'SELECT * FROM agents WHERE id = ?', [pc2T.agent_id])[0] || {};
    ok(ag.customer_id === 'r5d-neu-a' && ag.name === 'Samir Neu', `CREATE das Haus legt den Agenten zum Kunden an (${ag.name})`);
    ok(Number(pc2T.revision) >= 1 && !!pc2T.created_by, `CREATE Fassung und Anleger stehen (${pc2T.revision}/${pc2T.created_by})`);
    const led = dbQ(BIZ_DB, 'SELECT user_id, op FROM remote_command_ledger WHERE command_id = ?', [cmds[0]?.commandId])[0] || {};
    ok(led.op === 'transfers.create' && !!led.user_id, `AUDIT der Auftrag steht mit seinem Absender im Buch des Primary (${S(led)})`);
    ok(zahl("SELECT next_number AS n FROM document_sequences WHERE doc_type = 'TRF'") === zaehlerVor + 1 || zaehlerVor === 0,
      'CREATE genau eine Nummer ausgegeben');
    ok(await transferListe(client) && await warteBis(client, `document.body.innerText.includes(${S(pc2T.transfer_number)})`, 30000),
      'CREATE der zweite Rechner sieht den neuen Transfer — gelesen vom Primary');
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ── Verlorene Antwort beim Anlegen ──
  let verlorenT = null;
  {
    client = await lade(client, '/agents');
    ok(await neuerTransfer(client, 'r5d-neu-a', 'r5d-c3') === 'OK', 'VERLOREN die Anlegemaske, noch einmal');
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-create-transfer]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN die Maske meldet den offenen Ausgang, statt Erfolg zu behaupten');
    ok(await exists(client, '[data-create-transfer]'), 'VERLOREN …und bleibt offen');
    await click(client, '[data-create-transfer]');
    ok(await warteBis(client, "!document.querySelector('[data-create-transfer]')", 45000), 'VERLOREN der zweite Versuch derselben Absicht kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'transfers.create');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `VERLOREN zwei Anfragen, DIESELBE Kennung, derselbe Rumpf (${c.length})`);
    await warteAuf(() => transferVon('r5d-c3').length > 0);
    ok(transferVon('r5d-c3').length === 1, 'VERLOREN genau EIN Transfer');
    verlorenT = transferVon('r5d-c3')[0] || {};
    ok(zahl('SELECT COUNT(*) AS n FROM agents WHERE customer_id = ?', ['r5d-neu-a']) === 1, 'VERLOREN …derselbe Agent, kein zweiter');
  }

  // ── Dieselbe Übergabe an der Maske des Primary ──
  {
    await geh(primary, '/agents');
    const m = await neuerTransfer(primary, 'r5d-neu-b', 'r5d-c2');
    ok(m === 'OK', `PARITAET die Anlegemaske des Primary, mit denselben Eingaben (${m})`);
    await click(primary, '[data-create-transfer]');
    ok(await warteBis(primary, "!document.querySelector('[data-create-transfer]')", 45000), 'PARITAET der Primary legt ihn über seine eigene Maske an');
    await warteAuf(() => transferVon('r5d-c2').length > 0);
    const pT = transferVon('r5d-c2')[0] || {};
    ok(!!pT.id && norm(pT, TR_OHNE) === norm(pc2T, TR_OHNE),
      `PARITAET Transfer: Primary-Maske == PC2${norm(pT, TR_OHNE) !== norm(pc2T, TR_OHNE) ? ` (${norm(pT, TR_OHNE)} / ${norm(pc2T, TR_OHNE)})` : ''}`);
    const agP = dbQ(BIZ_DB, 'SELECT * FROM agents WHERE id = ?', [pT.agent_id])[0];
    const agC = dbQ(BIZ_DB, 'SELECT * FROM agents WHERE id = ?', [pc2T.agent_id])[0];
    ok(norm(agP, AG_OHNE) === norm(agC, AG_OHNE), `PARITAET …derselbe Agent (${norm(agC, AG_OHNE)})`);
    ok(S(dbQ(BIZ_DB, "SELECT stock_status, source_type FROM products WHERE id = 'r5d-c2'")) === S(dbQ(BIZ_DB, "SELECT stock_status, source_type FROM products WHERE id = 'r5d-c1'")),
      'PARITAET …und derselbe Bestandswechsel');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §11 EINZELN UMWANDELN — gewählter Kunde
  // ══════════════════════════════════════════════════════════════════════
  {
    const kundenVor = zahl('SELECT COUNT(*) AS n FROM customers');
    client = await lade(client, '/agents');
    ok(await transferListe(client), 'CONVERT die Transferliste am zweiten Rechner');
    const m = await umwandeln(client, 'TRF-2025-09001', false);
    ok(m === 'OK', `CONVERT „Create Invoice" mit dem vorgeschlagenen Kunden (${m})`);
    ok(await aufRechnung(client), `CONVERT der zweite Rechner landet auf der neuen Rechnung (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cv = (await buchungen(client)).filter((x) => x.op === 'transfers.convert_to_invoice');
    ok(cv.length === 1, `CONVERT genau EINE Buchung (${cv.length})`);
    const p = cv[0]?.payload || {};
    ok(p.transferId === 'r5d-t-e1' && p.customerId === 'r5d-kunde' && typeof p.expectedRevision === 'number' && !('autoCustomer' in p),
      `CONVERT Transfer, Fassung und der gewaehlte Kunde (${S(p)})`);
    ok(!('grossAmount' in p) && !('lines' in p) && !('invoiceNumber' in p) && !('status' in p),
      `CONVERT …kein Betrag, keine Zeilen, keine Nummer, kein Status (${Object.keys(p).join(',')})`);
    await warteAuf(() => !!rechnungVon('r5d-t-e1'));
    const inv = rechnungVon('r5d-t-e1');
    const k = dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [inv])[0] || {};
    ok(!!inv && k.customer_id === 'r5d-kunde' && Math.abs(Number(k.gross_amount) - 400) < 0.005 && k.branch_id === HAUS,
      `CONVERT EINE Rechnung an den Kunden, ueber den Abrechnungsbetrag (${k.gross_amount})`);
    ok(k.notes === 'Agent settlement · transfer TRF-2025-09001', `CONVERT der Vermerk des Hauses (${k.notes})`);
    ok(zahl('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?', [inv]) === 1, 'CONVERT …mit einer Zeile');
    ok(zahl('SELECT COUNT(*) AS n FROM customers') === kundenVor, 'CONVERT …und KEIN neuer Kunde');
    ok(dbQ(BIZ_DB, "SELECT status FROM agent_transfers WHERE id = 'r5d-t-e1'")[0]?.status === 'sold', 'CONVERT der Transfer traegt die Rechnung');

    await geh(primary, '/agents');
    ok(await transferListe(primary), 'CONVERT-PARITAET die Transferliste am Primary');
    ok(await umwandeln(primary, 'TRF-2025-09002', false) === 'OK', 'CONVERT-PARITAET dieselbe Handlung am Primary');
    ok(await aufRechnung(primary), 'CONVERT-PARITAET der Primary legt sie über seine eigene Liste an');
    await warteAuf(() => !!rechnungVon('r5d-t-e2'));
    const a = rechnung(rechnungVon('r5d-t-e2')), b = rechnung(inv);
    ok(a.kopf === b.kopf, `CONVERT-PARITAET Kopf: Primary == PC2${a.kopf !== b.kopf ? ` (${a.kopf} / ${b.kopf})` : ''}`);
    ok(a.zeilen === b.zeilen && a.buchung === b.buchung && b.buchung !== '[]', `CONVERT-PARITAET Zeilen und Buchung (${b.buchung})`);
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ── Einzeln umwandeln — „Auto-create from agent" ──
  {
    const vor = autoKunden('transfer settlements');
    client = await lade(client, '/agents');
    ok(await transferListe(client), 'AUTO die Transferliste am zweiten Rechner');
    ok(await umwandeln(client, 'TRF-2025-09003', true) === 'OK', 'AUTO „Create Invoice" → „Auto-create from agent"');
    ok(await aufRechnung(client), `AUTO der zweite Rechner landet auf der neuen Rechnung (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cv = (await buchungen(client)).filter((x) => x.op === 'transfers.convert_to_invoice');
    const p = cv[cv.length - 1]?.payload || {};
    ok(p.autoCustomer === true && !('customerId' in p) && !('firstName' in p) && !('phone' in p),
      `AUTO der Auftrag sagt nur „auto" — keine Angaben des Kunden (${S(p)})`);
    ok((await buchungen(client)).filter((x) => x.op === 'customers.create').length === 0, 'AUTO …kein vorgeschalteter Kundenbefehl');
    await warteAuf(() => !!rechnungVon('r5d-t-a1'));
    const inv = rechnungVon('r5d-t-a1');
    const kunde = kundeVon(inv);
    ok(autoKunden('transfer settlements') === vor + 1, 'AUTO genau EIN neuer Kunde');
    ok(kunde.first_name === 'Karim' && kunde.last_name === 'Al Mansour' && kunde.company === AGENT.company && kunde.phone === AGENT.phone
      && kunde.whatsapp === AGENT.whatsapp && kunde.email === AGENT.email && kunde.branch_id === HAUS,
    `AUTO der Kunde traegt die Angaben des Agenten (${S([kunde.first_name, kunde.last_name, kunde.company])})`);

    await geh(primary, '/agents');
    ok(await transferListe(primary), 'AUTO-PARITAET die Transferliste am Primary');
    ok(await umwandeln(primary, 'TRF-2025-09004', true) === 'OK', 'AUTO-PARITAET dieselbe Handlung am Primary');
    ok(await aufRechnung(primary), 'AUTO-PARITAET der Primary legt sie an');
    await warteAuf(() => !!rechnungVon('r5d-t-a2'));
    const invP = rechnungVon('r5d-t-a2');
    ok(norm(kundeVon(invP), KU_OHNE) === norm(kunde, KU_OHNE), `AUTO-PARITAET derselbe neue Kunde (${norm(kunde, KU_OHNE)})`);
    const a = rechnung(invP), b = rechnung(inv);
    ok(a.kopf === b.kopf && a.zeilen === b.zeilen && a.buchung === b.buchung, `AUTO-PARITAET dieselbe Rechnung, dieselbe Buchung (${b.zeilen})`);
  }

  // ── Verlorene Antwort bei „Auto-create" ──
  {
    const vor = autoKunden('transfer settlements');
    const invVor = zahl('SELECT COUNT(*) AS n FROM invoices');
    client = await lade(client, '/agents');
    await transferListe(client);
    if (await inZeile(client, 'TRF-2025-09005', 'convert') !== 'OK') ok(false, 'VERLOREN-A der Knopf in der Zeile');
    await waitFor(client, '[data-transfer-convert-confirm]', 15000);
    await clickText(client, 'Auto-create from agent'); await sleep(250);
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-transfer-convert-confirm]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN-A die Maske meldet den offenen Ausgang');
    ok(await exists(client, '[data-transfer-convert-confirm]'), 'VERLOREN-A …und bleibt offen');
    await click(client, '[data-transfer-convert-confirm]');
    ok(await aufRechnung(client), 'VERLOREN-A der zweite Versuch derselben Absicht kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'transfers.convert_to_invoice');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `VERLOREN-A zwei Anfragen, DIESELBE Kennung, derselbe Rumpf (${c.length})`);
    await warteAuf(() => !!rechnungVon('r5d-t-l1'));
    ok(zahl('SELECT COUNT(*) AS n FROM invoices') === invVor + 1 && autoKunden('transfer settlements') === vor + 1,
      'VERLOREN-A genau EINE Rechnung und genau EIN neuer Kunde');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §12 GESAMMELT — zwei verkaufte Transfers eines Agenten, „Auto-create", mit verlorener Antwort
  // ══════════════════════════════════════════════════════════════════════
  {
    const vor = autoKunden('combined invoice');
    const invVor = zahl('SELECT COUNT(*) AS n FROM invoices');
    client = await lade(client, '/agents');
    ok(await transferListe(client), 'BATCH die Transferliste am zweiten Rechner');
    const m = await sammelMaske(client, ['TRF-2025-09006', 'TRF-2025-09007']);
    ok(m === 'OK', `BATCH zwei verkaufte ausgewaehlt, „Create Combined Invoice", „Auto-create" (${m})`);
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-transfer-bulk-confirm]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'BATCH die verlorene Antwort wird als offen gemeldet');
    await click(client, '[data-transfer-bulk-confirm]');
    ok(await aufRechnung(client), `BATCH der zweite Versuch landet auf der Rechnung (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const c = (await kommandos(client)).filter((x) => x.op === 'transfers.convert_many_to_invoice');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `BATCH zwei Anfragen, DIESELBE Kennung (${c.length})`);
    const p = c[0]?.payload || {};
    ok(S(p.transfers?.map((x) => x.id)) === S(['r5d-t-b1', 'r5d-t-b2']) && p.transfers.every((x) => typeof x.expectedRevision === 'number') && p.autoCustomer === true,
      `BATCH jeder Transfer mit seiner Fassung, dazu „auto" (${S(p)})`);
    ok(!('customerId' in p) && !('lines' in p) && !('grossAmount' in p), `BATCH …kein Kunde, keine Zeilen, kein Betrag (${Object.keys(p).join(',')})`);
    await warteAuf(() => !!rechnungVon('r5d-t-b1'));
    const inv = rechnungVon('r5d-t-b1');
    ok(!!inv && rechnungVon('r5d-t-b2') === inv, 'BATCH beide Transfers tragen DIESELBE Rechnung');
    ok(zahl('SELECT COUNT(*) AS n FROM invoices') === invVor + 1 && zahl('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?', [inv]) === 2,
      'BATCH genau EINE Rechnung mit zwei Zeilen — trotz Wiederholung');
    ok(autoKunden('combined invoice') === vor + 1, 'BATCH genau EIN neuer Kunde mit dem Vermerk der Sammelrechnung');
    ok(Math.abs(Number(dbQ(BIZ_DB, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv])[0]?.gross_amount) - 730) < 0.005, 'BATCH die Summe beider Abrechnungen');

    await geh(primary, '/agents');
    ok(await transferListe(primary), 'BATCH-PARITAET die Transferliste am Primary');
    ok(await sammelMaske(primary, ['TRF-2025-09008', 'TRF-2025-09009']) === 'OK', 'BATCH-PARITAET dieselbe Auswahl am Primary');
    await click(primary, '[data-transfer-bulk-confirm]');
    ok(await aufRechnung(primary), 'BATCH-PARITAET der Primary legt sie an');
    await warteAuf(() => !!rechnungVon('r5d-t-b3'));
    const invP = rechnungVon('r5d-t-b3');
    const a = rechnung(invP), b = rechnung(inv);
    ok(a.kopf === b.kopf && a.zeilen === b.zeilen && a.buchung === b.buchung && b.buchung !== '[]',
      `BATCH-PARITAET dieselbe Rechnung, dieselben Zeilen, dieselbe Buchung${a.kopf !== b.kopf ? ` (${a.kopf} / ${b.kopf})` : ''}`);
    ok(norm(kundeVon(invP), KU_OHNE) === norm(kundeVon(inv), KU_OHNE), 'BATCH-PARITAET derselbe neue Kunde');
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ── Ein Fehler mitten in der Sammelrechnung: nichts bleibt — und danach genau einmal ──
  {
    const ledgerVorher = zahl('SELECT COUNT(*) AS n FROM ledger_entries');
    const invVorher = zahl('SELECT COUNT(*) AS n FROM invoices');
    const kundenVorher = zahl('SELECT COUNT(*) AS n FROM customers');
    const oben = await primaryNeustart((db) => db.exec(`CREATE TRIGGER r5d_e2e_fail BEFORE UPDATE OF invoice_id ON agent_transfers
      WHEN NEW.id = 'r5d-t-f2' AND NEW.invoice_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'r5d e2e injected'); END;`));
    ok(oben, 'FEHLER der Primary laeuft wieder — mit einer Sperre an der zweiten Verknuepfung');
    client = await lade(client, '/agents');
    ok(await transferListe(client), 'FEHLER die Transferliste');
    ok(await sammelMaske(client, ['TRF-2025-09010', 'TRF-2025-09011']) === 'OK', 'FEHLER dieselbe Sammelmaske');
    await click(client, '[data-transfer-bulk-confirm]');
    ok(await warteBis(client, "/No answer from the primary|Not saved|r5d e2e injected|failed|error/i.test(document.body.innerText)", 30000),
      `FEHLER der zweite Rechner zeigt, dass es nicht geklappt hat (${String(await fehlerAnzeige(client)).slice(0, 160)})`);
    ok(!/^\/invoices\//.test(String(await client.ev('return location.pathname;'))), 'FEHLER …und springt auf keine Rechnung');
    await spuelen(primary);
    ok(rechnungVon('r5d-t-f1') === '' && rechnungVon('r5d-t-f2') === '', 'FEHLER keine Teilmenge fakturiert — auch der erste Transfer nicht');
    ok(zahl('SELECT COUNT(*) AS n FROM invoices') === invVorher && zahl('SELECT COUNT(*) AS n FROM ledger_entries') === ledgerVorher
      && zahl('SELECT COUNT(*) AS n FROM customers') === kundenVorher,
    'FEHLER kein Beleg, keine Buchung, kein neuer Kunde');
    ok(await primaryNeustart((db) => db.exec('DROP TRIGGER r5d_e2e_fail')), 'FEHLER die Sperre ist weg, der Primary laeuft');
    client = await lade(client, '/agents');
    ok(await transferListe(client), 'WIEDERHOLT die Transferliste');
    ok(await sammelMaske(client, ['TRF-2025-09010', 'TRF-2025-09011']) === 'OK', 'WIEDERHOLT dieselbe Auswahl noch einmal');
    await click(client, '[data-transfer-bulk-confirm]');
    ok(await aufRechnung(client), 'WIEDERHOLT jetzt entsteht die Rechnung');
    await warteAuf(() => !!rechnungVon('r5d-t-f1'));
    ok(rechnungVon('r5d-t-f1') !== '' && rechnungVon('r5d-t-f2') === rechnungVon('r5d-t-f1')
      && zahl('SELECT COUNT(*) AS n FROM invoices') === invVorher + 1 && zahl('SELECT COUNT(*) AS n FROM customers') === kundenVorher + 1,
    'WIEDERHOLT genau EINE Rechnung, genau EIN Kunde, beide Transfers verknuepft');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §13 Die Nachbarn: ändern, verkaufen, zurücknehmen — an den eben angelegten Transfers
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/agents');
    ok(await transferListe(client), 'NACHBAR die Transferliste');
    ok(await inZeile(client, pc2T.transfer_number, 'edit') === 'OK', 'NACHBAR „Edit" am angelegten Transfer');
    await waitFor(client, '[data-transfer-save]', 15000);
    ok(await setUnterUeberschrift(client, 'NOTES', 'R5D Notiz') === 'OK', 'NACHBAR die Notiz');
    await click(client, '[data-transfer-save]');
    ok(await warteBis(client, "!document.querySelector('[data-transfer-save]')", 30000), 'NACHBAR gespeichert');
    ok(await warteAuf(() => dbQ(BIZ_DB, 'SELECT notes FROM agent_transfers WHERE id = ?', [pc2T.id])[0]?.notes === 'R5D Notiz'), 'NACHBAR transfers.update wirkt');
    ok(await inZeile(client, pc2T.transfer_number, 'sold') === 'OK', 'NACHBAR „Sold"');
    await waitFor(client, '[data-transfer-sold-confirm]', 15000);
    ok(await setByLabel(client, 'ACTUAL SALE PRICE (BHD)', '950') === 'OK', 'NACHBAR der Verkaufspreis');
    await click(client, '[data-transfer-sold-confirm]');
    ok(await warteAuf(() => dbQ(BIZ_DB, 'SELECT status FROM agent_transfers WHERE id = ?', [pc2T.id])[0]?.status === 'sold'), 'NACHBAR transfers.mark_sold wirkt');
    ok(Math.abs(Number(dbQ(BIZ_DB, 'SELECT settlement_amount FROM agent_transfers WHERE id = ?', [pc2T.id])[0]?.settlement_amount) - 930) < 0.005,
      'NACHBAR …mit dem Split des Anlegens: 900 + 40 % von 50 bleiben beim Kunden → 930');
    ok(await inZeile(client, verlorenT.transfer_number, 'return') === 'OK', 'NACHBAR „Return"');
    ok(await warteAuf(() => dbQ(BIZ_DB, 'SELECT status FROM agent_transfers WHERE id = ?', [verlorenT.id])[0]?.status === 'returned'), 'NACHBAR transfers.mark_returned wirkt');
    ok(S(dbQ(BIZ_DB, "SELECT stock_status, source_type FROM products WHERE id = 'r5d-c3'")[0]) === S({ stock_status: 'in_stock', source_type: 'OWN' }),
      'NACHBAR …und das Stueck liegt wieder im Lager');
    const ops = (await buchungen(client)).map((x) => x.op);
    ok(['transfers.update', 'transfers.mark_sold', 'transfers.mark_returned'].every((o) => ops.includes(o)), `NACHBAR drei Buchungen (${ops.join(',')})`);
  }

  // ── Der Client besitzt weiterhin nichts ────────────────────────────────
  {
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
    const eintraege = existsSync(CLIENT_DATA_DIR) ? readdirSync(CLIENT_DATA_DIR) : [];
    const verboten = eintraege.filter((f) => /lataif\.db|lataif_sync_server\.db|outbox|data-location|\.db$/i.test(f));
    ok(verboten.length === 0, `LOKAL kein Geschaeftsspeicher auf dem Client (${eintraege.join(', ') || 'leer'})`);
  }
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e));
  try { console.log('      (Primary-Konsole) ' + (primary?.events || []).slice(-15).join('\n      (Primary-Konsole) ')); } catch { /* egal */ }
  try { console.log('      (PC2-Konsole) ' + (client?.events || []).slice(-15).join('\n      (PC2-Konsole) ')); } catch { /* egal */ }
} finally {
  try { primary?.close(); } catch { /* zu */ }
  try { client?.close(); } catch { /* zu */ }
  try { steuer?.close(); } catch { /* zu */ }
  killAll();
  await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
}

clearTimeout(WACHHUND);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5d: transfer create/convert/combined, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5D_TRANSFER_CREATE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5D_SINGLE_CONVERT_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5D_BATCH_CONVERT_RUNTIME_PROVED');
