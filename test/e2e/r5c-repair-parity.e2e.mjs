// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5C — Reparatur anlegen, ändern, abrechnen vom zweiten Rechner.
// Run: node test/e2e/r5c-repair-parity.e2e.mjs
//
// Dieselben Reparaturmasken wie am Primary, auf einem Rechner OHNE Datenbank:
//
//   /repairs      „New Repair" (Kunde, mit Kategorie, Merkmalen, Foto, Mitarbeiter)   → repairs.create
//   /repairs      „New Repair" → „Own Item" (Artikel + Los)                             → repairs.create
//   /repairs/:id  „Edit" → Zahlwege, Kartenart, Kosten, Referenz, Diagnose, Foto → Save → repairs.update
//   /repairs      Auswahl → „Create Combined Invoice"                                    → repairs.create_invoice
//   /repairs/:id  „Create Invoice" → Steuer → Nummernart                                 → repairs.create_invoice
//
// Bewiesen wird: genau EINE Buchung je Handlung, nichts, was der Primary bestimmt, im Rumpf,
// verlorene Antworten legen nichts doppelt an, ein Fehler mitten in der Rechnung hinterlässt nichts
// und ein Wiederholen danach gelingt genau einmal — und dieselbe Handlung an der Maske des Primary
// hat DIESELBE Wirkung (Zeile, Nebenbuchungen, Rechnung).
// ════════════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from 'node:child_process';
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const CLIENT_IDENT = 'com.lataif.app.e2e.client';
const APP_CDP = 9223, CLIENT_CDP = 9224, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const CLIENT_APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif-e2e-client.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'r5c-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5c-repair', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const CLIENT_HOME = join(RUN, 'client-home');
const CLIENT_APPDATA = join(CLIENT_HOME, 'Roaming');
const CLIENT_DATA_DIR = join(CLIENT_APPDATA, CLIENT_IDENT);
const PHOTO = join(RUN, 'r5c-photo.png');
const PHOTO2 = join(RUN, 'r5c-photo-2.png');

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

/** Ein echtes Foto — ein PNG, das der Browser dekodieren und die Maske verkleinern kann. */
function writePhoto(file, farbe) {
  const w = 96, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 5) & 0xff; raw[o + 1] = (y * 7) & 0xff; raw[o + 2] = farbe;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
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
/** Ein Textfeld unter einer Überschrift (DIAGNOSIS, NOTES …) — dort gibt es kein <label>. */
const setUnterUeberschrift = (c, titel, v) => c.ev(
  `const t=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()===${S(titel)}); if(!t) return 'NO-TITLE:'+${S(titel)};`
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
async function fotoWaehlen(c, file) {
  await c.send('DOM.enable', {});
  const { root } = await c.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][accept="image/*"]' });
  if (!nodeIds || nodeIds.length === 0) return 'KEIN-FELD';
  await c.send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[nodeIds.length - 1] });
  return 'OK';
}
const SHELL = 'a[href="/settings"]';
const JPEGS = "[...document.querySelectorAll('img')].filter(i=>/^data:image\\/jpeg/.test(i.src)).length";

const BEOBACHTER = `
  if (window.__r4bInstalliert) { /* schon da */ } else {
  window.__r4bInstalliert = true;
  window.__cmds = [];
  window.__staged = [];
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
    if (/\\/api\\/staging\\/media$/.test(url)) window.__staged.push(Date.now());
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

/** Fertige Reparaturen für die Rechnungsfälle — je Fall ein eigenes Paar, und ein Zwilling für den Primary. */
const FERTIG = [
  ['r5c-rep-1', 'R5C-0001', 'r5c-kunde', 90, 'VAT_10'], ['r5c-rep-2', 'R5C-0002', 'r5c-kunde', 60, 'ZERO'],
  ['r5c-rep-3', 'R5C-0003', 'r5c-kunde2', 40, 'VAT_10'], ['r5c-rep-4', 'R5C-0004', 'r5c-kunde2', 30, 'VAT_10'],
  ['r5c-rep-5', 'R5C-0005', 'r5c-kunde', 45, 'VAT_10'], ['r5c-rep-6', 'R5C-0006', 'r5c-kunde', 55, 'VAT_10'],
  ['r5c-rep-7', 'R5C-0007', 'r5c-kunde', 90, 'VAT_10'], ['r5c-rep-8', 'R5C-0008', 'r5c-kunde', 60, 'ZERO'],
];
let WATCH = 'Watch';
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const cat = db.prepare("SELECT id, branch_id, name FROM categories WHERE id = 'cat-watch'").get();
    if (!cat) {
      insert(db, 'categories', { id: 'cat-watch', branch_id, name: 'Watch', icon: 'Watch', color: '#000', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 0, created_at: now, updated_at: now });
    } else {
      WATCH = String(cat.name);
      if (cat.branch_id !== branch_id) console.log(`      (seed) cat-watch gehoert zu ${cat.branch_id}, das Haus ist ${branch_id}`);
    }
    for (const [id, first, last] of [['r5c-kunde', 'Nadia', 'Kunde'], ['r5c-kunde2', 'Omar', 'Zwei']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    insert(db, 'suppliers', { id: 'r5c-werkstatt', branch_id, name: 'R5C Werkstatt', active: 1, created_at: now, updated_at: now });
    insert(db, 'employees', { id: 'r5c-emp', branch_id, name: 'R5C Techniker', employment_status: 'active', created_at: now, updated_at: now });
    // Zwei gleiche eigene Stücke mit je ZWEI Losen — dann bietet die Maske die Losauswahl an.
    for (const [pid, sku] of [['r5c-own-a', 'R5C-OWN-A'], ['r5c-own-b', 'R5C-OWN-B']]) {
      insert(db, 'products', { id: pid, branch_id, category_id: 'cat-watch', brand: 'Omega', name: 'R5C Eigen', sku, condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 500, purchase_currency: 'BHD', stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, quantity: 2, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      for (const l of ['1', '2']) {
        insert(db, 'stock_lots', { id: `${pid}-lot${l}`, branch_id, product_id: pid, unit_cost: 250, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
      }
    }
    for (const [id, nr, cust, charge, tax] of FERTIG) {
      insert(db, 'repairs', { id, branch_id, repair_number: nr, customer_id: cust, item_brand: 'Tudor', item_model: 'Black Bay', issue_description: 'Service ' + nr, repair_type: 'internal', internal_cost: 20, charge_to_customer: charge, margin: charge - 20, tax_scheme: tax, status: 'ready', received_at: now, completed_at: now, voucher_code: 'V' + nr.replace(/\D/g, '').padStart(7, '0'), images: '[]', item_attributes: '{}', repair_scope: 'CUSTOMER', revision: 1, created_at: now, updated_at: now });
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
const ablagen = (c) => c.ev('return (window.__staged || []).length;');
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
async function neueReparatur(c) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New Repair')", 40000))) return 'KEIN-KNOPF';
  if (await clickText(c, 'New Repair') !== 'OK') return 'KEIN-KNOPF';
  if (!(await warteBis(c, "document.querySelector('[data-create-repair]')", 15000))) return 'KEINE-MASKE';
  return 'OK';
}
async function kundenMaske(c, issue, mitFoto = true) {
  if (await neueReparatur(c) !== 'OK') return 'KEINE-MASKE';
  const r = [];
  await click(c, '[data-ss-trigger="Search clients by name, company, phone..."]'); await sleep(500);
  await click(c, '[data-ss-option="r5c-kunde"]'); await sleep(300);
  r.push(await clickText(c, WATCH)); await sleep(400);
  r.push(await setByLabel(c, 'BRAND', 'Rolex'));
  r.push(await setByLabel(c, 'NAME / MODEL', 'Submariner'));
  r.push(await setByLabel(c, 'REFERENCE', '116610LN'));
  r.push(await setByLabel(c, 'SERIAL NUMBER', 'Z12345'));
  r.push(await clickText(c, 'Steel'));
  r.push(await setByLabel(c, 'ITEM DESCRIPTION (OPTIONAL)', 'Kratzer am Glas'));
  r.push(await setVal(c, 'textarea[placeholder="Describe the issue or requested repair..."]', issue));
  r.push(await clickText(c, 'External')); await sleep(300);
  await click(c, '[data-ss-trigger="Pick: In-house OR a workshop / goldsmith"]'); await sleep(500);
  await click(c, '[data-ss-option="r5c-werkstatt"]'); await sleep(300);
  r.push(await setByLabel(c, 'WORKSHOP FEE (BHD, OPTIONAL)', '30'));
  r.push(await setByLabel(c, 'CHARGE TO CLIENT (BHD)', '90'));
  r.push(await clickText(c, '0% (no VAT)'));
  r.push(await setByLabel(c, 'ESTIMATED READY DATE', '2026-09-20'));
  r.push(await waehleIn(c, 'Unassigned', 'r5c-emp'));
  r.push(await setVal(c, 'textarea[placeholder="Internal notes..."]', 'Kunde wartet'));
  if (mitFoto) {
    if (await fotoWaehlen(c, PHOTO) !== 'OK') return 'KEIN-FOTOFELD';
    if (!(await warteBis(c, `${JPEGS} >= 1`, 15000))) return 'KEIN-VORSCHAUBILD';
  }
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
async function eigeneMaske(c, productId, lotId, issue) {
  if (await neueReparatur(c) !== 'OK') return 'KEINE-MASKE';
  const own = await c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.firstElementChild&&x.firstElementChild.textContent.trim()==='Own Item'); if(!b) return 'NO'; b.click(); return 'OK';`);
  if (own !== 'OK') return 'KEIN-OWN';
  await sleep(400);
  await click(c, '[data-ss-trigger="Search by brand, name, SKU, reference, attributes..."]'); await sleep(500);
  await click(c, `[data-ss-option="${productId}"]`); await sleep(600);
  if (!(await warteBis(c, "[...document.querySelectorAll('select')].some(s=>[...s.options].some(o=>o.textContent.includes('Auto (oldest active lot')))", 15000))) return 'KEINE-LOSAUSWAHL';
  const r = [
    await waehleIn(c, 'Auto (oldest active lot', lotId),
    await setVal(c, 'textarea[placeholder="Describe the issue or requested repair..."]', issue),
    await setByLabel(c, 'INTERNAL COST (BHD, OPTIONAL)', '15'),
    await waehleIn(c, 'Unassigned', 'r5c-emp'),
  ];
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
async function bearbeiten(c) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Edit')", 30000))) return 'KEIN-EDIT';
  if (await clickText(c, 'Edit') !== 'OK') return 'KEIN-EDIT';
  if (!(await warteBis(c, "document.querySelector('[data-repair-save]')", 15000))) return 'KEINE-MASKE';
  const r = [
    await setByLabel(c, 'ACTUAL COST (BHD)', '55'),
    await setByLabel(c, 'CHARGE TO CUSTOMER (BHD)', '150'),
    await clickText(c, 'Benefit'), // die ERSTE Gruppe: womit das Haus seine Kosten bezahlt hat
    await clickText(c, 'Card'),
  ];
  await sleep(300);
  r.push(await clickText(c, 'Amex'));
  r.push(await setByLabel(c, 'REFERENCE', '116500'));
  r.push(await setByLabel(c, 'ITEM DESCRIPTION (OPTIONAL)', 'Glas neu'));
  r.push(await setUnterUeberschrift(c, 'DIAGNOSIS', 'Glas gesprungen'));
  if (await fotoWaehlen(c, PHOTO2) !== 'OK') r.push('KEIN-FOTOFELD');
  if (!(await warteBis(c, `${JPEGS} >= 2`, 15000))) r.push('KEIN-ZWEITES-BILD');
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** Eine Handlung in der Zeile einer Reparatur der Liste. */
const inZeile = (c, nr, was) => c.ev(
  `const row=[...document.querySelectorAll('div.cursor-pointer')].find(d=>d.style&&d.style.gridTemplateColumns&&d.textContent.includes(${S(nr)}));`
  + `if(!row) return 'KEINE-ZEILE:'+${S(nr)}; let el=null;`
  + `if (${S(was)}==='check') el=row.querySelector('input[type=checkbox]');`
  + `else if (${S(was)}==='invoice') el=row.querySelector('[data-repair-quick-invoice]');`
  + `else el=[...row.querySelectorAll('button')].find(b=>b.textContent.trim()===${S(was)});`
  + `if(!el) return 'KEIN-ELEMENT:'+${S(was)}; if (el.disabled) return 'DISABLED'; el.click(); return 'OK';`);

// ── Was am Primary steht ──
const reparatur = (issue) => dbQ(BIZ_DB, 'SELECT * FROM repairs WHERE issue_description = ?', [issue]);
const REP_OHNE = /^(id|repair_number|voucher_code|revision|version|sync_status|created_by|customer_payment_ledger_id|customer_payment_date|issue_description)$|_at$/;
const repNorm = (r, auch = []) => S(Object.fromEntries(Object.entries(r || {})
  .filter(([k]) => !REP_OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b))));
const ausgaben = (rid) => S(dbQ(BIZ_DB,
  "SELECT category, status, ROUND(amount, 3) AS a, payment_method FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? ORDER BY category, status, a", [rid]));
const zahlungsbuchung = (rid) => S(dbQ(BIZ_DB,
  `SELECT account, direction, ROUND(SUM(amount), 3) AS s FROM ledger_entries
    WHERE source_id = (SELECT customer_payment_ledger_id FROM repairs WHERE id = ?) GROUP BY account, direction ORDER BY account, direction`, [rid]));
const INV_OHNE = /^(id|invoice_number|notes|created_by|revision|version|sync_status)$|_at$/;
const rechnung = (id) => {
  const k = dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [id])[0] || {};
  return {
    kopf: S(Object.fromEntries(Object.entries(k).filter(([x]) => !INV_OHNE.test(x)).sort(([a], [b]) => a.localeCompare(b)))),
    zeilen: S(dbQ(BIZ_DB, 'SELECT unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [id])),
    buchung: S(dbQ(BIZ_DB, 'SELECT account, direction, ROUND(SUM(amount), 3) AS s FROM ledger_entries WHERE source_id = ? GROUP BY account, direction ORDER BY account, direction', [id])),
  };
};
const rechnungVon = (rid) => String(dbQ(BIZ_DB, 'SELECT invoice_id FROM repairs WHERE id = ?', [rid])[0]?.invoice_id || '');
async function warteAufZeile(issue) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    const r = reparatur(issue);
    if (r.length > 0) return r;
    await sleep(400);
  }
  return [];
}
async function warteAuf(pruefe) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}

try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  writePhoto(PHOTO, 140);
  writePhoto(PHOTO2, 30);
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Der Primary ────────────────────────────────────────────────────────
  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5C Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5C Branch');
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
  client = await lade(client, '/repairs');
  await waitFor(client, SHELL, 45000);
  ok(await client.ev('return Array.isArray(window.__cmds);') === true, 'SETUP der Beobachter liegt vor dem ersten Skript der Seite');

  // ══════════════════════════════════════════════════════════════════════
  // §9 ANLEGEN — Kundenreparatur mit allen Feldern der Maske, mit Foto
  // ══════════════════════════════════════════════════════════════════════
  let pc2Kunde = null;
  {
    const m = await kundenMaske(client, 'R5C PC2 Kunde');
    ok(m === 'OK', `CREATE die normale Anlegemaske am zweiten Rechner (${m})`);
    await click(client, '[data-create-repair]');
    const zu = await warteBis(client, "!document.querySelector('[data-create-repair]')", 45000);
    ok(zu, `CREATE die Maske schliesst nach dem Anlegen (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'repairs.create', `CREATE genau EINE Buchung: ${cmds.map((x) => x.op).join(',') || 'keine'}`);
    const p = cmds[0]?.payload || {};
    ok(Array.isArray(p.photos) && p.photos.length === 1 && /^[0-9a-f]{64}$/.test(p.photos[0]?.stagingId || ''),
      `CREATE das Foto reist nur als Inhaltskennung (${S(p.photos)})`);
    ok(!S(p).includes('base64') && !('repairNumber' in p) && !('voucherCode' in p) && !('status' in p) && !('margin' in p) && !('branchId' in p),
      `CREATE …keine Bildbytes, keine Nummer, kein Status, keine Marge, keine Filiale (${Object.keys(p).join(',')})`);
    ok(p.itemCategoryId === 'cat-watch' && p.itemAttributes?.material === 'Steel' && p.staffId === 'r5c-emp' && p.taxScheme === 'ZERO',
      `CREATE Kategorie, Merkmale, Mitarbeiter und Steuerwahl reisen mit (${S({ c: p.itemCategoryId, a: p.itemAttributes, s: p.staffId, t: p.taxScheme })})`);
    ok(await ablagen(client) === 1, 'CREATE das Foto ging EINMAL in die Zwischenablage');
    const r = await warteAufZeile('R5C PC2 Kunde');
    ok(r.length === 1, `CREATE genau EINE Reparatur am Primary (${r.length})`);
    pc2Kunde = r[0];
    ok(pc2Kunde?.branch_id === HAUS && /^REP-/.test(String(pc2Kunde?.repair_number)) && String(pc2Kunde?.voucher_code).length === 8 && pc2Kunde?.status === 'received',
      `CREATE Filiale, Nummer, Gutschein und Anfangsstatus bestimmt der Primary (${pc2Kunde?.repair_number}/${pc2Kunde?.status})`);
    ok(pc2Kunde?.item_brand === 'Rolex' && pc2Kunde?.item_model === 'Submariner' && pc2Kunde?.item_reference === '116610LN'
      && pc2Kunde?.item_serial === 'Z12345' && pc2Kunde?.item_description === 'Kratzer am Glas' && pc2Kunde?.staff_id === 'r5c-emp'
      && Number(pc2Kunde?.charge_to_customer) === 90 && Number(pc2Kunde?.internal_cost) === 30 && pc2Kunde?.tax_scheme === 'ZERO',
      'CREATE jede Eingabe der Maske steht in der Zeile — die eigenen Kosten aus der geteilten Ableitung');
    const bilder = JSON.parse(String(pc2Kunde?.images || '[]'));
    ok(bilder.length === 1 && /^data:image\/jpeg;base64,/.test(bilder[0]), 'CREATE das Foto steht in der Reparatur, wie die Maske es verkleinert hat');
    const zeilen = dbQ(BIZ_DB, 'SELECT supplier_id, cost_amount FROM repair_lines WHERE repair_id = ?', [pc2Kunde?.id]);
    ok(zeilen.length === 1 && zeilen[0].supplier_id === 'r5c-werkstatt' && Number(zeilen[0].cost_amount) === 30,
      `CREATE die erste Arbeitszeile legt das Haus an (${S(zeilen)})`);
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ── Verlorene Antwort beim Anlegen ──
  {
    client = await lade(client, '/repairs');
    ok(await kundenMaske(client, 'R5C PC2 Verloren', false) === 'OK', 'VERLOREN die Anlegemaske, noch einmal');
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-create-repair]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN die Maske meldet den offenen Ausgang, statt Erfolg zu behaupten');
    ok(await exists(client, '[data-create-repair]'), 'VERLOREN …und bleibt offen');
    await click(client, '[data-create-repair]');
    ok(await warteBis(client, "!document.querySelector('[data-create-repair]')", 45000), 'VERLOREN der zweite Versuch derselben Absicht kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'repairs.create');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `VERLOREN zwei Anfragen, DIESELBE Kennung, derselbe Rumpf (${c.length})`);
    ok((await warteAufZeile('R5C PC2 Verloren')).length === 1 && reparatur('R5C PC2 Verloren').length === 1, 'VERLOREN genau EINE Reparatur');
  }

  // ── Dieselbe Kundenreparatur an der Maske des Primary ──
  let pKunde = null;
  {
    await geh(primary, '/repairs');
    const m = await kundenMaske(primary, 'R5C Primary Kunde');
    ok(m === 'OK', `PARITAET die Anlegemaske des Primary, mit denselben Eingaben (${m})`);
    await click(primary, '[data-create-repair]');
    ok(await warteBis(primary, "!document.querySelector('[data-create-repair]')", 45000), 'PARITAET der Primary legt sie über seine eigene Maske an');
    pKunde = (await warteAufZeile('R5C Primary Kunde'))[0];
    ok(!!pKunde && repNorm(pKunde) === repNorm(pc2Kunde),
      `PARITAET Zeile: Primary-Maske == PC2${pKunde && repNorm(pKunde) !== repNorm(pc2Kunde) ? ` (${repNorm(pKunde)} / ${repNorm(pc2Kunde)})` : ''}`);
    const zl = (rid) => S(dbQ(BIZ_DB, 'SELECT position, supplier_id, work_type, cost_amount, status FROM repair_lines WHERE repair_id = ?', [rid]));
    ok(zl(pKunde?.id) === zl(pc2Kunde?.id), 'PARITAET …und dieselbe erste Arbeitszeile');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §9 ANLEGEN — Reparatur an EIGENER Ware (Artikel + Los)
  // ══════════════════════════════════════════════════════════════════════
  let pc2Eigen = null;
  {
    client = await lade(client, '/repairs');
    const m = await eigeneMaske(client, 'r5c-own-a', 'r5c-own-a-lot2', 'R5C PC2 Eigen');
    ok(m === 'OK', `OWN die Anlegemaske mit „Own Item", Artikel und Losauswahl (${m})`);
    await click(client, '[data-create-repair]');
    ok(await warteBis(client, "!document.querySelector('[data-create-repair]')", 45000), `OWN die Maske schliesst (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const c = (await buchungen(client)).filter((x) => x.op === 'repairs.create');
    const p = c[c.length - 1]?.payload || {};
    ok(p.repairScope === 'OWN' && p.productId === 'r5c-own-a' && p.lotId === 'r5c-own-a-lot2',
      `OWN der Auftrag nennt Artikel und Los (${S({ s: p.repairScope, p: p.productId, l: p.lotId })})`);
    ok(!('customerId' in p) && !('chargeToCustomer' in p) && !('taxScheme' in p) && !('itemBrand' in p) && !('stockStatus' in p),
      `OWN …und keinen Kunden, keinen Preis, keine Steuer, keine Artikelangaben, keinen Bestand (${Object.keys(p).join(',')})`);
    pc2Eigen = (await warteAufZeile('R5C PC2 Eigen'))[0];
    ok(pc2Eigen?.repair_scope === 'OWN' && pc2Eigen?.customer_id === `sys-own-shop-${HAUS}` && pc2Eigen?.product_id === 'r5c-own-a'
      && pc2Eigen?.lot_id === 'r5c-own-a-lot2', `OWN Platzhalter-Kunde, Artikel und Los setzt der Primary (${pc2Eigen?.customer_id}/${pc2Eigen?.lot_id})`);
    ok(pc2Eigen?.item_brand === 'Omega' && pc2Eigen?.item_model === 'R5C Eigen' && pc2Eigen?.item_reference === 'R5C-OWN-A'
      && pc2Eigen?.item_category_id === 'cat-watch' && pc2Eigen?.charge_to_customer === null,
      'OWN die Artikelangaben kommen vom Artikel; kein Kundenpreis');
    ok(dbQ(BIZ_DB, "SELECT stock_status FROM products WHERE id = 'r5c-own-a'")[0]?.stock_status === 'in_repair', 'OWN der Artikel ist in Reparatur — vom Haus gesetzt');

    await geh(primary, '/repairs');
    ok(await eigeneMaske(primary, 'r5c-own-b', 'r5c-own-b-lot2', 'R5C Primary Eigen') === 'OK', 'OWN-PARITAET dieselbe Maske am Primary');
    await click(primary, '[data-create-repair]');
    const pEigen = (await warteAufZeile('R5C Primary Eigen'))[0];
    ok(!!pEigen && repNorm(pEigen, ['product_id', 'lot_id', 'item_reference']) === repNorm(pc2Eigen, ['product_id', 'lot_id', 'item_reference']),
      `OWN-PARITAET Zeile: Primary-Maske == PC2${pEigen ? '' : ' (keine Zeile)'}`);
    ok(dbQ(BIZ_DB, "SELECT stock_status FROM products WHERE id = 'r5c-own-b'")[0]?.stock_status === 'in_repair', 'OWN-PARITAET …und derselbe Bestandsstatus');
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §10/§12 ÄNDERN — erst der Nachbar (Status aus der Liste), dann „Save" mit den Klasse-B-Feldern
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/repairs');
    await warteBis(client, `document.body.innerText.includes(${S(pc2Kunde?.repair_number)})`, 30000);
    ok(await inZeile(client, pc2Kunde?.repair_number, 'Start') === 'OK', 'NACHBAR die Abkuerzung „Start" der Liste am zweiten Rechner');
    ok(await warteAuf(() => dbQ(BIZ_DB, 'SELECT status FROM repairs WHERE id = ?', [pc2Kunde?.id])[0]?.status === 'in_progress'),
      'NACHBAR …schaltet die Reparatur ueber dieselbe Buchung weiter wie die Detailseite');
    const st = (await buchungen(client)).filter((x) => x.op === 'repairs.update_status');
    ok(st.length === 1 && typeof st[0].payload?.expectedRevision === 'number', 'NACHBAR …mit der gesehenen Fassung');
    await geh(primary, '/repairs');
    await warteBis(primary, `document.body.innerText.includes(${S(pKunde?.repair_number)})`, 30000);
    ok(await inZeile(primary, pKunde?.repair_number, 'Start') === 'OK', 'NACHBAR dieselbe Abkuerzung am Primary');
    await warteAuf(() => dbQ(BIZ_DB, 'SELECT status FROM repairs WHERE id = ?', [pKunde?.id])[0]?.status === 'in_progress');

    client = await lade(client, '/repairs/' + pc2Kunde?.id);
    const m = await bearbeiten(client);
    ok(m === 'OK', `EDIT die normale „Edit"-Maske am zweiten Rechner (${m})`);
    await click(client, '[data-repair-save]');
    ok(await warteBis(client, "!document.querySelector('[data-repair-save]')", 45000),
      `EDIT die Maske schliesst nach dem Speichern (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const up = (await buchungen(client)).filter((x) => x.op === 'repairs.update');
    ok(up.length === 1, `EDIT genau EINE Buchung (${up.length})`);
    const p = up[0]?.payload || {};
    ok(typeof p.expectedRevision === 'number' && p.customerPaidFrom === 'card' && p.customerCardBrand === 'amex' && p.internalPaidFrom === 'benefit'
      && p.actualCost === 55 && p.chargeToCustomer === 150 && p.itemReference === '116500' && p.diagnosis === 'Glas gesprungen',
      `EDIT Fassung, Zahlwege, Kartenart, Kosten, Referenz und Diagnose reisen mit (${Object.keys(p).join(',')})`);
    ok(!('margin' in p) && !('internalCost' in p) && !('customerPaidAmount' in p) && !('taxScheme' in p) && !S(p).includes('base64'),
      'EDIT …keine Marge, keine abgeleiteten Kosten, kein Zahlbetrag, keine Steuer, keine Bildbytes');
    ok(S(p.photos?.map((x) => Object.keys(x)[0])) === S(['keep', 'stagingId']) && p.photos?.[0]?.keep === 0,
      `EDIT das vorhandene Foto nach seiner Stelle, das neue als Ablagekennung (${S(p.photos)})`);
    await spuelen(primary);
    const z = dbQ(BIZ_DB, 'SELECT * FROM repairs WHERE id = ?', [pc2Kunde?.id])[0] || {};
    ok(z.customer_paid_from === 'card' && z.customer_card_brand === 'amex' && z.internal_paid_from === 'benefit',
      'EDIT die Zahlwege stehen in der Zeile');
    ok(z.customer_payment_status === 'PAID' && Number(z.customer_paid_amount) === 150 && !!z.customer_payment_ledger_id,
      `EDIT die Kundenzahlung ist vom Haus gebucht (${z.customer_payment_status}/${z.customer_paid_amount})`);
    ok(Math.abs(Number(z.margin) - (150 - Number(z.internal_cost))) < 0.001, `EDIT die Marge rechnet der Primary (${z.margin})`);
    ok(JSON.parse(String(z.images || '[]')).length === 2 && z.item_reference === '116500' && z.item_description === 'Glas neu' && z.diagnosis === 'Glas gesprungen',
      'EDIT Foto, Referenz, Beschreibung und Diagnose stehen in der Zeile');
    ok(/CardFee|card/i.test(ausgaben(pc2Kunde?.id)), `EDIT die Kartengebuehr ist gebucht (${ausgaben(pc2Kunde?.id)})`);

    // Dieselbe Änderung an der Maske des Primary — dieselbe Wirkung, auch im Geld.
    await geh(primary, '/repairs/' + pKunde?.id);
    ok(await bearbeiten(primary) === 'OK', 'EDIT-PARITAET dieselbe „Edit"-Maske am Primary');
    await click(primary, '[data-repair-save]');
    ok(await warteBis(primary, "!document.querySelector('[data-repair-save]')", 45000), 'EDIT-PARITAET der Primary speichert');
    await warteAuf(() => dbQ(BIZ_DB, 'SELECT customer_paid_from FROM repairs WHERE id = ?', [pKunde?.id])[0]?.customer_paid_from === 'card');
    const zp = dbQ(BIZ_DB, 'SELECT * FROM repairs WHERE id = ?', [pKunde?.id])[0] || {};
    ok(repNorm(zp) === repNorm(z), `EDIT-PARITAET Zeile: Primary-Maske == PC2${repNorm(zp) !== repNorm(z) ? ` (${repNorm(zp)} / ${repNorm(z)})` : ''}`);
    ok(ausgaben(pKunde?.id) === ausgaben(pc2Kunde?.id), `EDIT-PARITAET dieselben Ausgaben (Werkstatt, Kartengebuehr) (${ausgaben(pKunde?.id)})`);
    ok(zahlungsbuchung(pKunde?.id) === zahlungsbuchung(pc2Kunde?.id) && zahlungsbuchung(pc2Kunde?.id) !== '[]',
      `EDIT-PARITAET dieselbe Buchung der Kundenzahlung (${zahlungsbuchung(pc2Kunde?.id)})`);
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §11 ABRECHNEN — mehrere Reparaturen in EINE Rechnung
  // ══════════════════════════════════════════════════════════════════════
  let pc2Rechnung = '';
  {
    client = await lade(client, '/repairs');
    await warteBis(client, "document.body.innerText.includes('R5C-0002')", 30000);
    ok(await inZeile(client, 'R5C-0001', 'check') === 'OK' && await inZeile(client, 'R5C-0002', 'check') === 'OK',
      'INVOICE zwei fertige Reparaturen desselben Kunden ausgewaehlt');
    ok(await clickText(client, 'Create Combined Invoice') === 'OK', 'INVOICE „Create Combined Invoice"');
    await waitFor(client, '[data-combined-invoice-confirm]', 15000);
    await click(client, '[data-combined-invoice-confirm]');
    ok(await warteBis(client, "/^\\/invoices\\//.test(location.pathname)", 45000),
      `INVOICE der zweite Rechner landet auf der neuen Rechnung (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const iv = (await buchungen(client)).filter((x) => x.op === 'repairs.create_invoice');
    ok(iv.length === 1, `INVOICE genau EINE Buchung (${iv.length})`);
    const p = iv[0]?.payload || {};
    ok(S(p.repairs?.map((x) => x.repairId)) === S(['r5c-rep-1', 'r5c-rep-2']) && p.repairs.every((x) => typeof x.expectedRevision === 'number'),
      `INVOICE der Auftrag nennt jede Reparatur mit ihrer Fassung (${S(p.repairs)})`);
    ok(!('lines' in p) && !('grossAmount' in p) && !('customerId' in p) && !('invoiceNumber' in p) && !('vatAmount' in p),
      `INVOICE …und keinen Betrag, keine Steuer, keine Zeilen, keinen Kunden, keine Nummer (${Object.keys(p).join(',')})`);
    await spuelen(primary);
    pc2Rechnung = rechnungVon('r5c-rep-1');
    ok(!!pc2Rechnung && rechnungVon('r5c-rep-2') === pc2Rechnung, 'INVOICE beide Reparaturen tragen DIESELBE Rechnung');
    ok(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?', [pc2Rechnung])[0]?.n === 2, 'INVOICE …mit einer Zeile je Reparatur');
    const k = dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [pc2Rechnung])[0] || {};
    ok(/^Combined Repair Service · R5C-0001, R5C-0002$/.test(String(k.notes)) && k.branch_id === HAUS && k.customer_id === 'r5c-kunde',
      `INVOICE Vermerk, Filiale und Kunde vom Haus (${k.notes})`);
    ok(S(dbQ(BIZ_DB, 'SELECT DISTINCT tax_scheme FROM invoice_lines WHERE invoice_id = ? ORDER BY 1', [pc2Rechnung]).map((r) => r.tax_scheme)) === S(['VAT_10', 'ZERO']),
      'INVOICE jede Zeile mit dem Schema IHRER Reparatur');
    ok(dbQ(BIZ_DB, "SELECT status FROM repairs WHERE id IN ('r5c-rep-1','r5c-rep-2')").every((r) => r.status === 'ready'), 'INVOICE der Reparaturstatus bleibt');

    // Dieselbe Sammelrechnung an der Liste des Primary.
    await geh(primary, '/repairs');
    await warteBis(primary, "document.body.innerText.includes('R5C-0008')", 30000);
    ok(await inZeile(primary, 'R5C-0007', 'check') === 'OK' && await inZeile(primary, 'R5C-0008', 'check') === 'OK', 'INVOICE-PARITAET dieselbe Auswahl am Primary');
    await clickText(primary, 'Create Combined Invoice');
    await waitFor(primary, '[data-combined-invoice-confirm]', 15000);
    await click(primary, '[data-combined-invoice-confirm]');
    ok(await warteBis(primary, "/^\\/invoices\\//.test(location.pathname)", 45000), 'INVOICE-PARITAET der Primary legt sie über seine eigene Liste an');
    await warteAuf(() => !!rechnungVon('r5c-rep-7'));
    const pr = rechnungVon('r5c-rep-7');
    const a = rechnung(pr), b = rechnung(pc2Rechnung);
    ok(!!pr && a.kopf === b.kopf, `INVOICE-PARITAET Rechnungskopf: Primary == PC2${a.kopf !== b.kopf ? ` (${a.kopf} / ${b.kopf})` : ''}`);
    ok(a.zeilen === b.zeilen, `INVOICE-PARITAET Zeilen (${b.zeilen})`);
    ok(a.buchung === b.buchung && b.buchung !== '[]', `INVOICE-PARITAET Buchung (${b.buchung})`);
  }

  // ── Verlorene Antwort bei der Sammelrechnung ──
  {
    client = await lade(client, '/repairs');
    await warteBis(client, "document.body.innerText.includes('R5C-0004')", 30000);
    await inZeile(client, 'R5C-0003', 'check'); await inZeile(client, 'R5C-0004', 'check');
    await clickText(client, 'Create Combined Invoice');
    await waitFor(client, '[data-combined-invoice-confirm]', 15000);
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-combined-invoice-confirm]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN-R die Sammelrechnung meldet den offenen Ausgang');
    ok(await exists(client, '[data-combined-invoice-confirm]'), 'VERLOREN-R …und bleibt offen');
    await click(client, '[data-combined-invoice-confirm]');
    ok(await warteBis(client, "/^\\/invoices\\//.test(location.pathname)", 45000), 'VERLOREN-R der zweite Versuch kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'repairs.create_invoice');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload),
      `VERLOREN-R zwei Anfragen, DIESELBE Kennung, derselbe Rumpf (${c.length})`);
    await spuelen(primary);
    const r3 = rechnungVon('r5c-rep-3');
    ok(!!r3 && rechnungVon('r5c-rep-4') === r3 && dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM invoices WHERE customer_id = 'r5c-kunde2'")[0]?.n === 1,
      'VERLOREN-R genau EINE Rechnung, an beiden Reparaturen');
  }

  // ── Einzeln, an der Detailseite: Steuer- und Nummernwahl ──
  {
    client = await lade(client, '/repairs/r5c-rep-5');
    await waitFor(client, '[data-repair-invoice]', 30000);
    await click(client, '[data-repair-invoice]');
    ok(await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Next: Choose Number Type')", 15000), 'DETAIL der Steuerdialog oeffnet');
    await client.ev("const l=[...document.querySelectorAll('label')].find(x=>x.textContent.includes('0% (No VAT)')); l && l.click(); return 1;");
    await clickText(client, 'Next: Choose Number Type');
    ok(await warteBis(client, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Confirm')", 15000), 'DETAIL …dann die Nummernart');
    await client.ev("const t=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent.trim()==='Special Final'); t && t.click(); return 1;");
    await sleep(300);
    await clickText(client, 'Confirm');
    ok(await warteBis(client, "/^\\/invoices\\//.test(location.pathname)", 45000), `DETAIL die Rechnung entsteht (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const iv = (await buchungen(client)).filter((x) => x.op === 'repairs.create_invoice');
    const p = iv[iv.length - 1]?.payload || {};
    ok(iv.length === 1 && p.taxScheme === 'ZERO' && p.specialMark === true && p.repairs?.[0]?.repairId === 'r5c-rep-5',
      `DETAIL EIN Auftrag mit der Wahl beider Dialoge (${S(p)})`);
    await spuelen(primary);
    const inv = rechnungVon('r5c-rep-5');
    ok(!!inv && dbQ(BIZ_DB, 'SELECT tax_scheme FROM invoice_lines WHERE invoice_id = ?', [inv])[0]?.tax_scheme === 'ZERO', 'DETAIL die Steuerwahl gilt auf der Zeile');
    ok(dbQ(BIZ_DB, "SELECT tax_scheme FROM repairs WHERE id = 'r5c-rep-5'")[0]?.tax_scheme === 'ZERO', 'DETAIL …und steht danach an der Reparatur');
    ok(Number(dbQ(BIZ_DB, 'SELECT special_mark FROM invoices WHERE id = ?', [inv])[0]?.special_mark) === 1, 'DETAIL die Nummernart erreicht die Rechnung');
    ok(/^Repair Service · R5C-0005 · Service R5C-0005$/.test(String(dbQ(BIZ_DB, 'SELECT notes FROM invoices WHERE id = ?', [inv])[0]?.notes)),
      'DETAIL der Einzelvermerk wie an der Detailseite');
  }

  // ── Ein Fehler mitten in der Rechnung: nichts bleibt — und danach genau einmal ──
  {
    const ledgerVorher = Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM ledger_entries')[0]?.n);
    const invVorher = Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoices')[0]?.n);
    const oben = await primaryNeustart((db) => db.exec(`CREATE TRIGGER r5c_e2e_fail BEFORE UPDATE OF invoice_id ON repairs
      WHEN NEW.id = 'r5c-rep-6' AND NEW.invoice_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'r5c e2e injected'); END;`));
    ok(oben, 'FEHLER der Primary laeuft wieder — mit einer Sperre an der Verknuepfung');
    client = await lade(client, '/repairs');
    await warteBis(client, "document.body.innerText.includes('R5C-0006')", 30000);
    ok(await inZeile(client, 'R5C-0006', 'invoice') === 'OK', 'FEHLER das Rechnungskuerzel der Liste');
    ok(await warteBis(client, "document.querySelector('[data-save-error]') && document.querySelector('[data-save-error]').textContent.length > 0", 30000),
      `FEHLER der zweite Rechner zeigt, dass es nicht geklappt hat (${String(await fehlerAnzeige(client)).slice(0, 160)})`);
    ok(!/^\/invoices\//.test(String(await client.ev('return location.pathname;'))), 'FEHLER …und springt auf keine Rechnung');
    await spuelen(primary);
    ok(rechnungVon('r5c-rep-6') === '' && Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoices')[0]?.n) === invVorher
      && Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM ledger_entries')[0]?.n) === ledgerVorher,
      'FEHLER kein Beleg, keine Verknuepfung, keine Buchung');
    ok(await primaryNeustart((db) => db.exec('DROP TRIGGER r5c_e2e_fail')), 'FEHLER die Sperre ist weg, der Primary laeuft');
    client = await lade(client, '/repairs');
    await warteBis(client, "document.body.innerText.includes('R5C-0006')", 30000);
    ok(await inZeile(client, 'R5C-0006', 'invoice') === 'OK', 'WIEDERHOLT dasselbe Kuerzel noch einmal');
    ok(await warteBis(client, "/^\\/invoices\\//.test(location.pathname)", 45000), 'WIEDERHOLT jetzt entsteht die Rechnung');
    await spuelen(primary);
    const r6 = rechnungVon('r5c-rep-6');
    ok(!!r6 && Number(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM invoices')[0]?.n) === invVorher + 1, 'WIEDERHOLT genau EINE Rechnung');
    ok(/^Repair Service · R5C-0006/.test(String(dbQ(BIZ_DB, 'SELECT notes FROM invoices WHERE id = ?', [r6])[0]?.notes)), 'WIEDERHOLT …fuer genau diese Reparatur');
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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5c: repair create/update/invoice, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5C_REPAIR_CREATE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5C_REPAIR_UPDATE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5C_REPAIR_INVOICE_RUNTIME_PROVED');
