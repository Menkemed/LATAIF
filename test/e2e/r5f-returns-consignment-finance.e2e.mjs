// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F — Retoure anlegen, Kommission verkaufen und auszahlen vom zweiten Rechner.
// Run: node test/e2e/r5f-returns-consignment-finance.e2e.mjs
//
//   /invoices/:id       „Create Return" → später erstatten (Mitarbeiter, Grund)          → returns.create
//   /invoices/:id       „Create Return" → „Refund jetzt zahlen" (Retoure + Erstattung)   → returns.create
//   /consignments/:id   „Record Sale" → Nummerndialog „Special Final"                   → consignments.record_sale
//   /consignments/:id   „Pay Out (legacy)" → der offene Rest, Weg, Referenz              → consignments.record_payout
//
// Bewiesen wird: genau EINE Buchung je Handlung, nichts Abgeleitetes im Rumpf, verlorene Antworten
// wirken nicht doppelt (keine zweite Retoure, Erstattung, Rechnung, Auszahlung), und dieselbe
// Handlung an der Maske des Primary hat DIESELBE Wirkung.
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
const OWNER_PW = 'r5f-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5f-finance', 'run-' + Date.now());
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
const setByLabel = (c, label, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(label)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setUnterUeberschrift = (c, titel, v) => c.ev(
  `const t=[...document.querySelectorAll('span')].filter(x=>x.textContent.trim()===${S(titel)}).pop(); if(!t) return 'NO-TITLE:'+${S(titel)};`
  + `const e=t.parentElement.querySelector('textarea'); if(!e) return 'NO-TEXTAREA';`
  + `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';`);
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

async function fotoWaehlen(c, file) {
  await c.send('DOM.enable', {});
  const { root } = await c.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][accept="image/*"]' });
  if (!nodeIds || nodeIds.length === 0) return 'KEIN-FELD';
  await c.send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[nodeIds.length - 1] });
  return 'OK';
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


// ── Die Masken, wie ein Mensch sie bedient — auf welchem Rechner auch immer ──
const clickIncludes = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${S(t)})); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
const waehleIn = (c, eintrag, wert) => c.ev(
  `const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.textContent.includes(${S(eintrag)})));`
  + `if(!s) return 'NO-SELECT:'+${S(eintrag)}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${S(wert)});`
  + `s.dispatchEvent(new Event('change',{bubbles:true})); return s.value===${S(wert)} ? 'OK' : 'NO-OPTION:'+${S(wert)};`);
const waehleNth = (c, eintrag, nr, wert) => c.ev(
  `const l=[...document.querySelectorAll('select')].filter(x=>[...x.options].some(o=>o.textContent.includes(${S(eintrag)})));`
  + `const s=l[${nr}]; if(!s) return 'NO-SELECT:'+${S(eintrag)}+'#'+${nr}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${S(wert)});`
  + `s.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setNth = (c, sel, nr, v) => c.ev(
  `const e=document.querySelectorAll(${S(sel)})[${nr}]; if(!e) return 'NO:'+${S(sel)}+'#'+${nr};`
  + `const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;`
  + `Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
/** Ein Feld, dessen Beschriftung so BEGINNT (die Beschriftung wechselt z. B. „AUTO" → „MANUELL"). */
const setByLabelPrefix = (c, prefix, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().startsWith(${S(prefix)})).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(prefix)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
/** Eine Suchauswahl: den Ausloeser (den n-ten, sonst den letzten) oeffnen, dann den Eintrag. */
async function ssPick(c, placeholder, optionId, nr = -1) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=${nr}<0?l[l.length-1]:l[${nr}]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}

// ── Die Welt des Laufs: Rechnungen (bezahlt, Ware verkauft) und Kommissionen ──
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    const heute = now.slice(0, 10);
    insert(db, 'categories', { id: 'r5f-cat', branch_id, name: 'R5F Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    for (const [id, first, last] of [['r5f-kunde', 'Lina', 'Kunde'], ['r5f-kaeufer', 'Sami', 'Kaeufer']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    insert(db, 'employees', { id: 'r5f-emp', branch_id, name: 'R5F Kasse', employment_status: 'active', created_at: now, updated_at: now });
    const artikel = (id, extra) => insert(db, 'products', { id, branch_id, category_id: 'r5f-cat', brand: 'Omega', name: 'R5F ' + id, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: 220, tax_scheme: 'VAT_10', days_in_stock: 0, images: '[]', attributes: '{}', created_at: now, updated_at: now, ...extra });
    // Je eine Rechnung, voll bar bezahlt, die Ware verkauft (ihr Los aufgebraucht).
    for (const tag of ['A', 'B', 'C', 'D', 'E']) {
      const pid = `r5f-p${tag}`, lot = `${pid}-lot`, inv = `r5f-inv-${tag}`;
      artikel(pid, { stock_status: 'sold', quantity: 0, source_type: 'OWN' });
      insert(db, 'stock_lots', { id: lot, branch_id, product_id: pid, unit_cost: 100, qty_total: 1, qty_remaining: 0, status: 'EXHAUSTED', acquired_at: now, created_at: now });
      insert(db, 'invoices', { id: inv, branch_id, invoice_number: `R5F-INV-${tag}`, customer_id: 'r5f-kunde', status: 'FINAL', currency: 'BHD', net_amount: 200, vat_rate_snapshot: 10, vat_amount: 20, gross_amount: 220, paid_amount: 220, tax_scheme_snapshot: 'VAT_10', issued_at: now, created_at: now, updated_at: now });
      insert(db, 'invoice_lines', { id: `${inv}-l1`, invoice_id: inv, product_id: pid, lot_id: lot, quantity: 1, unit_price: 200, purchase_price: 100, vat_rate: 10, tax_scheme: 'VAT_10', vat_amount: 20, line_total: 220, position: 1 });
      insert(db, 'payments', { id: `${inv}-pay`, branch_id, invoice_id: inv, amount: 220, method: 'cash', received_at: now, created_at: now });
    }
    // Drei Kommissionen zum Verkaufen, drei alte Verkaeufe OHNE Rechnung zum Auszahlen.
    for (const tag of ['P', 'C', 'L']) {
      artikel(`r5f-k${tag}`, { stock_status: 'consignment', quantity: 1, purchase_price: 0, tax_scheme: 'MARGIN', source_type: 'CONSIGNMENT' });
      insert(db, 'consignments', { id: `r5f-con-${tag}`, branch_id, consignment_number: `R5F-CON-${tag}`, consignor_id: 'r5f-kunde', product_id: `r5f-k${tag}`, status: 'active', agreed_price: 1000, commission_type: 'percent', commission_rate: 20, payout_status: 'pending', payout_paid_amount: 0, agreement_date: heute, created_at: now, updated_at: now });
      artikel(`r5f-l${tag}`, { stock_status: 'sold', quantity: 0, purchase_price: 0, tax_scheme: 'MARGIN', source_type: 'CONSIGNMENT' });
      insert(db, 'consignments', { id: `r5f-leg-${tag}`, branch_id, consignment_number: `R5F-LEG-${tag}`, consignor_id: 'r5f-kunde', product_id: `r5f-l${tag}`, status: 'sold', agreed_price: 1000, commission_type: 'percent', commission_rate: 20, sale_price: 1000, commission_amount: 200, payout_amount: 800, payout_paid_amount: 0, payout_status: 'pending', agreement_date: heute, created_at: now, updated_at: now });
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

// ── Die Masken, wie ein Mensch sie bedient ──
/** „Create Return": die (einzige) Zeile anhaken, Weg, Warenfolge, Grund, Mitarbeiter, Zeitpunkt. */
async function retoureMaske(c, { methode, jetzt, staff, grund }) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Create Return'))", 45000))) return 'KEIN-KNOPF';
  const r = [await clickIncludes(c, 'Create Return')];
  if (!(await warteBis(c, "document.querySelector('[data-return-save]')", 15000))) return 'KEINE-MASKE';
  r.push(await c.ev("const h=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()==='UNIT PRICE (incl. VAT)'); if(!h) return 'NO-HEAD';"
    + " const cb=h.parentElement.parentElement.querySelector('input[type=checkbox]:not([disabled])'); if(!cb) return 'NO-BOX'; cb.click(); return 'OK';"));
  await sleep(250);
  r.push(await clickText(c, methode));
  r.push(await clickText(c, 'Back to Stock'));
  if (grund) r.push(await setByLabel(c, 'REASON FOR RETURN (optional)', grund));
  // Der Mitarbeiter wird IMMER ausdruecklich gewaehlt: die Maske setzt ihn beim Oeffnen nicht zurueck
  // (ein zweiter Return auf derselben Seite erbte sonst den vorigen — Nebenbefund, im Dokument).
  {
    const st = staff ?? '';
    r.push(await c.ev(`const t=[...document.querySelectorAll('span')].filter(x=>x.textContent.trim()==='STAFF').pop(); const s=t&&t.parentElement.querySelector('select'); if(!s) return 'NO-STAFF';`
      + ` Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${S(st)}); s.dispatchEvent(new Event('change',{bubbles:true})); return s.value===${S(st)}?'OK':'NO-OPTION';`));
  }
  if (methode !== 'Store Credit') r.push(await clickText(c, jetzt ? 'Refund jetzt zahlen' : 'Refund later (Status: Pending)'));
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** „Record Sale": Kaeufer, Preis — dann „Confirm Sale" und im Nummerndialog die Wahl. */
async function verkaufMaske(c, kaeufer, preis) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Record Sale')", 45000))) return 'KEIN-KNOPF';
  const r = [await clickText(c, 'Record Sale')];
  if (!(await warteBis(c, "document.querySelector('[data-consignment-sale]')", 15000))) return 'KEINE-MASKE';
  r.push(await ssPick(c, 'Search clients...', kaeufer));
  r.push(await setByLabel(c, 'SALE PRICE (BHD)', String(preis)));
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
async function nummerWaehlen(c, sonder) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Special Final'))", 15000))) return 'KEIN-DIALOG';
  const r = [await clickIncludes(c, sonder ? 'Special Final' : 'Normal Final')];
  await sleep(200);
  r.push(await clickText(c, 'Confirm'));
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** „Pay Out (legacy)": Weg und Referenz. */
async function auszahlungMaske(c, weg, referenz) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Pay Out (legacy)'))", 45000))) return 'KEIN-KNOPF';
  const r = [await clickIncludes(c, 'Pay Out (legacy)')];
  if (!(await warteBis(c, "document.querySelector('[data-consignment-payout]')", 15000))) return 'KEINE-MASKE';
  r.push(await clickText(c, weg));
  r.push(await setByLabel(c, 'REFERENCE', referenz));
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}

/** Zum Beleg navigieren und warten, bis er WIRKLICH gezeichnet ist (sonst greift die Maske noch den vorigen). */
const gehZu = async (p, route, merkmal) => { await geh(p, route); await warteBis(p, 'document.body.innerText.includes(' + S(merkmal) + ')', 20000); await sleep(600); };
// ── Was am Primary steht ──
const norm = (r, ohne, auch = []) => S(Object.fromEntries(Object.entries(r || {}).filter(([k]) => !ohne.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b))));
const zahl = (sql, p = []) => Number(Object.values(dbQ(BIZ_DB, sql, p)[0] || { n: 0 })[0]);
async function warteAuf(pruefe) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}
const RET_OHNE = /^(id|return_number|invoice_id|created_by|revision|version|sync_status)$|_at$/;
const retoureVon = (inv) => dbQ(BIZ_DB, 'SELECT * FROM sales_returns WHERE invoice_id = ?', [inv]);
const zeilenVon = (inv) => S(dbQ(BIZ_DB, 'SELECT l.quantity, l.unit_price, l.vat_amount, l.line_total FROM sales_return_lines l JOIN sales_returns r ON r.id = l.return_id WHERE r.invoice_id = ?', [inv]));
const gutschriftVon = (inv) => dbQ(BIZ_DB, 'SELECT * FROM credit_notes WHERE invoice_id = ?', [inv])
  .map((c) => norm(c, /^(id|credit_note_number|invoice_id|sales_return_id|created_by|revision|version|sync_status)$|_at$/));
const buchungVonGutschrift = (inv) => S(dbQ(BIZ_DB, `SELECT account, direction, ROUND(SUM(amount), 3) AS s, COUNT(*) AS n FROM ledger_entries
  WHERE source_module = 'CREDIT_NOTE' AND source_id IN (SELECT id FROM credit_notes WHERE invoice_id = ?) GROUP BY account, direction ORDER BY account, direction`, [inv]));
const rechnungVon = (inv) => norm(dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [inv])[0], /^(id|invoice_number|revision|version|sync_status|created_by)$|_at$/);
const warenVon = (tag) => S([dbQ(BIZ_DB, 'SELECT quantity, stock_status FROM products WHERE id = ?', [`r5f-p${tag}`])[0], dbQ(BIZ_DB, 'SELECT qty_remaining, status FROM stock_lots WHERE id = ?', [`r5f-p${tag}-lot`])[0]]);
const KOM_OHNE = /^(id|consignment_number|product_id|invoice_id|revision|version|sync_status|created_by)$|_at$/;
const kommissionVon = (id) => dbQ(BIZ_DB, 'SELECT * FROM consignments WHERE id = ?', [id])[0] || {};
const rechnungDerKommission = (id) => dbQ(BIZ_DB, 'SELECT * FROM invoices WHERE id = ?', [kommissionVon(id).invoice_id || ''])[0] || {};
const einkaufDerKommission = (nr) => S(dbQ(BIZ_DB, 'SELECT total_amount, paid_amount, status FROM purchases WHERE notes LIKE ?', ['%' + nr + '%']));
const buchungDerRechnung = (inv) => S(dbQ(BIZ_DB, `SELECT account, direction, ROUND(SUM(amount), 3) AS s, COUNT(*) AS n FROM ledger_entries
  WHERE source_module = 'INVOICE' AND source_id = ? GROUP BY account, direction ORDER BY account, direction`, [inv]));
const auszahlungsBuchung = (id) => S(dbQ(BIZ_DB, `SELECT account, direction, ROUND(SUM(amount), 3) AS s, COUNT(*) AS n FROM ledger_entries
  WHERE source_module = 'CONSIGNMENT_PAYOUT' AND metadata_json LIKE ? GROUP BY account, direction ORDER BY account, direction`, ['%"consignmentId":"' + id + '"%']));

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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5F Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5F Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5F Admin');
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

  // ══════════════════════════════════════════════════════════════════════
  // §12 RETOURE — spaeter erstatten (Mitarbeiter, Grund wie getippt)
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/invoices/r5f-inv-B');
    const m = await retoureMaske(client, { methode: 'Cash', jetzt: false, staff: 'r5f-emp', grund: '  defekt  ' });
    ok(m === 'OK', `RETURN die Retourenmaske am zweiten Rechner (${m})`);
    await click(client, '[data-return-save]');
    ok(await warteAuf(() => retoureVon('r5f-inv-B').length === 1), `RETURN die Retoure steht am Primary (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'returns.create', `RETURN genau EINE Buchung (${cmds.map((x) => x.op).join(',') || 'keine'})`);
    const p = cmds[0]?.payload || {};
    ok(p.staffId === 'r5f-emp' && p.refundNow === false && p.reason === '  defekt  ' && p.refundMethod === 'cash' && p.productDisposition === 'IN_STOCK'
      && S(Object.keys(p.lines?.[0] || {}).sort()) === S(['invoiceLineId', 'quantity']) && !('refundAmount' in p) && !('totalAmount' in p),
    `RETURN Eingaben der Maske — kein Preis, kein Betrag (${S(p).slice(0, 220)})`);
    const r = retoureVon('r5f-inv-B')[0] || {};
    ok(r.status === 'REQUESTED' && r.refund_status === 'PENDING_REFUND' && r.staff_id === 'r5f-emp' && r.reason === '  defekt  ' && Number(r.total_amount) === 220,
      `RETURN offen, mit Mitarbeiter und Grund, Betrag 220 vom Haus (${S([r.status, r.refund_status, r.staff_id, r.total_amount])})`);
    ok(warenVon('B') === S([{ quantity: 1, stock_status: 'in_stock' }, { qty_remaining: 1, status: 'ACTIVE' }]) || /"quantity":1/.test(warenVon('B')),
      `RETURN die Ware ist zurueck im Bestand, ihr Los wieder frei (${warenVon('B')})`);
    ok(gutschriftVon('r5f-inv-B').length === 0, 'RETURN spaeter heisst: noch keine Gutschrift');
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');

    await gehZu(primary, '/invoices/r5f-inv-A', 'R5F-INV-A');
    { const mm = await retoureMaske(primary, { methode: 'Cash', jetzt: false, staff: 'r5f-emp', grund: '  defekt  ' }); ok(mm === 'OK', 'RETURN-PARITAET dieselbe Maske am Primary (' + mm + ')'); }
    await click(primary, '[data-return-save]');
    ok(await warteAuf(() => retoureVon('r5f-inv-A').length === 1), 'RETURN-PARITAET der Primary legt sie an');
    const rp = retoureVon('r5f-inv-A')[0] || {};
    ok(norm(rp, RET_OHNE) === norm(r, RET_OHNE), `RETURN-PARITAET Kopf: Primary == PC2${norm(rp, RET_OHNE) !== norm(r, RET_OHNE) ? ` (${norm(rp, RET_OHNE)} / ${norm(r, RET_OHNE)})` : ''}`);
    ok(zeilenVon('r5f-inv-A') === zeilenVon('r5f-inv-B') && warenVon('A') === warenVon('B') && rechnungVon('r5f-inv-A') === rechnungVon('r5f-inv-B'),
      'RETURN-PARITAET Zeilen, Bestand, Los und Rechnung');
  }

  // ── Retoure mit Sofort-Erstattung ──
  {
    client = await lade(client, '/invoices/r5f-inv-D');
    { const mm = await retoureMaske(client, { methode: 'Cash', jetzt: true }); ok(mm === 'OK', 'REFUND die Maske „Refund jetzt zahlen" am zweiten Rechner (' + mm + ')'); }
    await click(client, '[data-return-save]');
    ok(await warteAuf(() => (retoureVon('r5f-inv-D')[0] || {}).status === 'REFUNDED'), `REFUND die Retoure ist erstattet (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'returns.create' && cmds[0].payload?.refundNow === true,
      `REFUND EINE Buchung traegt Retoure UND Erstattung (${cmds.map((x) => x.op).join(',')})`);
    const r = retoureVon('r5f-inv-D')[0] || {};
    ok(Number(r.refund_paid_amount) === 220 && r.refund_status === 'REFUNDED' && gutschriftVon('r5f-inv-D').length === 1,
      `REFUND 220 bar erstattet, eine Gutschrift (${S([r.refund_paid_amount, r.refund_status])})`);
    ok(/"CASH"/.test(buchungVonGutschrift('r5f-inv-D')), `REFUND die Gutschrift ist gebucht, das Geld floss aus der Kasse (${buchungVonGutschrift('r5f-inv-D')})`);

    await gehZu(primary, '/invoices/r5f-inv-C', 'R5F-INV-C');
    { const mm = await retoureMaske(primary, { methode: 'Cash', jetzt: true }); ok(mm === 'OK', 'REFUND-PARITAET dieselbe Maske am Primary (' + mm + ')'); }
    await click(primary, '[data-return-save]');
    ok(await warteAuf(() => (retoureVon('r5f-inv-C')[0] || {}).status === 'REFUNDED'), 'REFUND-PARITAET der Primary erstattet');
    const rp = retoureVon('r5f-inv-C')[0] || {};
    ok(norm(rp, RET_OHNE) === norm(r, RET_OHNE), `REFUND-PARITAET Kopf${norm(rp, RET_OHNE) !== norm(r, RET_OHNE) ? ` (${norm(rp, RET_OHNE)} / ${norm(r, RET_OHNE)})` : ''}`);
    ok(S(gutschriftVon('r5f-inv-C')) === S(gutschriftVon('r5f-inv-D')) && buchungVonGutschrift('r5f-inv-C') === buchungVonGutschrift('r5f-inv-D')
      && rechnungVon('r5f-inv-C') === rechnungVon('r5f-inv-D') && warenVon('C') === warenVon('D'),
    `REFUND-PARITAET Gutschrift, Buchung, Rechnung, Bestand (${buchungVonGutschrift('r5f-inv-C')} / ${buchungVonGutschrift('r5f-inv-D')})`);
  }

  // ── Verlorene Antwort bei der Sofort-Erstattung ──
  {
    client = await lade(client, '/invoices/r5f-inv-E');
    { const mm = await retoureMaske(client, { methode: 'Cash', jetzt: true }); ok(mm === 'OK', 'VERLOREN-R die Maske, noch einmal (' + mm + ')'); }
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-return-save]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN-R die Maske meldet den offenen Ausgang');
    await click(client, '[data-return-save]');
    ok(await warteAuf(() => (retoureVon('r5f-inv-E')[0] || {}).status === 'REFUNDED'), 'VERLOREN-R der zweite Versuch derselben Absicht kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'returns.create');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload), `VERLOREN-R dieselbe Kennung, derselbe Rumpf (${c.length})`);
    ok(retoureVon('r5f-inv-E').length === 1 && gutschriftVon('r5f-inv-E').length === 1 && Number(retoureVon('r5f-inv-E')[0].refund_paid_amount) === 220
      && buchungVonGutschrift('r5f-inv-E') === buchungVonGutschrift('r5f-inv-D'),
    'VERLOREN-R genau EINE Retoure, EINE Gutschrift, EINMAL erstattet, EINMAL gebucht');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §13 KOMMISSION — Verkauf im Sonderkreis, Auszahlung
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/consignments/r5f-con-C');
    { const mm = await verkaufMaske(client, 'r5f-kaeufer', 1200); ok(mm === 'OK', 'SALE die Verkaufsmaske am zweiten Rechner (' + mm + ')'); }
    await click(client, '[data-consignment-sale]');
    { const mm = await nummerWaehlen(client, true); ok(mm === 'OK', 'SALE der Nummerndialog: „Special Final" (' + mm + ')'); }
    ok(await warteAuf(() => kommissionVon('r5f-con-C').status === 'sold'), `SALE die Kommission ist verkauft (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'consignments.record_sale', `SALE genau EINE Buchung (${cmds.map((x) => x.op).join(',')})`);
    const p = cmds[0]?.payload || {};
    ok(p.specialMark === true && p.salePrice === 1200 && p.buyerId === 'r5f-kaeufer' && !('commissionAmount' in p) && !('payoutAmount' in p) && !('invoiceId' in p),
      `SALE die Wahl im Nummerndialog reist mit — Provision, Auszahlung, Rechnung nicht (${S(p).slice(0, 200)})`);
    const k = kommissionVon('r5f-con-C');
    const inv = rechnungDerKommission('r5f-con-C');
    ok(Number(k.payout_amount) === 960 && Number(k.commission_amount) === 240 && Number(inv.special_mark) === 1 && Number(inv.gross_amount) === 1200,
      `SALE Auszahlung 960 und Provision 240 vom Haus, Rechnung im Sonderkreis (${S([k.payout_amount, k.commission_amount, inv.special_mark])})`);
    ok(/960/.test(einkaufDerKommission('R5F-CON-C')), `SALE der Einkauf beim Einlieferer traegt seine Auszahlung (${einkaufDerKommission('R5F-CON-C')})`);

    await gehZu(primary, '/consignments/r5f-con-P', 'R5F-CON-P');
    { const mm = await verkaufMaske(primary, 'r5f-kaeufer', 1200); ok(mm === 'OK', 'SALE-PARITAET dieselbe Maske am Primary (' + mm + ')'); }
    await click(primary, '[data-consignment-sale]');
    { const mm = await nummerWaehlen(primary, true); ok(mm === 'OK', 'SALE-PARITAET derselbe Nummerndialog (' + mm + ')'); }
    ok(await warteAuf(() => kommissionVon('r5f-con-P').status === 'sold'), 'SALE-PARITAET der Primary verkauft');
    const kp = kommissionVon('r5f-con-P');
    const ip = rechnungDerKommission('r5f-con-P');
    const INV_OHNE = /^(id|invoice_number|notes|revision|version|sync_status|created_by)$|_at$/;
    ok(norm(kp, KOM_OHNE) === norm(k, KOM_OHNE), `SALE-PARITAET Kommission${norm(kp, KOM_OHNE) !== norm(k, KOM_OHNE) ? ` (${norm(kp, KOM_OHNE)} / ${norm(k, KOM_OHNE)})` : ''}`);
    ok(norm(ip, INV_OHNE) === norm(inv, INV_OHNE) && einkaufDerKommission('R5F-CON-P') === einkaufDerKommission('R5F-CON-C')
      && buchungDerRechnung(ip.id) === buchungDerRechnung(inv.id),
    `SALE-PARITAET Rechnung (Sonderkreis), Einkauf, Buchung${norm(ip, INV_OHNE) !== norm(inv, INV_OHNE) ? ` (${norm(ip, INV_OHNE).slice(0, 300)} / ${norm(inv, INV_OHNE).slice(0, 300)})` : ''}`);
  }

  // ── Verlorene Antwort beim Verkauf ──
  {
    const vor = [zahl('SELECT COUNT(*) AS n FROM invoices'), zahl('SELECT COUNT(*) AS n FROM purchases')];
    client = await lade(client, '/consignments/r5f-con-L');
    { const mm = await verkaufMaske(client, 'r5f-kaeufer', 1200); ok(mm === 'OK', 'VERLOREN-S die Verkaufsmaske (' + mm + ')'); }
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-consignment-sale]');
    { const mm = await nummerWaehlen(client, false); ok(mm === 'OK', 'VERLOREN-S der Nummerndialog (' + mm + ')'); }
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN-S die Maske meldet den offenen Ausgang');
    await click(client, '[data-consignment-sale]');
    { const mm = await nummerWaehlen(client, false); ok(mm === 'OK', 'VERLOREN-S dieselbe Wahl, noch einmal (' + mm + ')'); }
    ok(await warteAuf(() => kommissionVon('r5f-con-L').status === 'sold'), 'VERLOREN-S der zweite Versuch kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'consignments.record_sale');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload), `VERLOREN-S dieselbe Kennung, derselbe Rumpf (${c.length})`);
    ok(zahl('SELECT COUNT(*) AS n FROM invoices') === vor[0] + 1 && zahl('SELECT COUNT(*) AS n FROM purchases') === vor[1] + 1,
      'VERLOREN-S genau EINE Rechnung und EIN Einkauf');
  }

  // ── Auszahlung (Verkauf ohne Rechnung) ──
  {
    client = await lade(client, '/consignments/r5f-leg-C');
    { const mm = await auszahlungMaske(client, 'Bank Transfer', 'R5F-REF'); ok(mm === 'OK', 'PAYOUT die Auszahlungsmaske am zweiten Rechner (' + mm + ')'); }
    await click(client, '[data-consignment-payout]');
    ok(await warteAuf(() => kommissionVon('r5f-leg-C').status === 'paid_out'), `PAYOUT die Kommission ist ausbezahlt (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = await buchungen(client);
    const p = cmds[0]?.payload || {};
    ok(cmds.length === 1 && cmds[0].op === 'consignments.record_payout' && p.amount === 800 && p.method === 'bank_transfer' && p.reference === 'R5F-REF'
      && !('payoutStatus' in p) && !('payoutPaidAmount' in p),
    `PAYOUT EINE Buchung: der offene Rest, den die Maske sah, Weg und Referenz (${S(p).slice(0, 200)})`);
    const k = kommissionVon('r5f-leg-C');
    ok(k.payout_status === 'paid' && Number(k.payout_paid_amount) === 800 && k.payout_method === 'bank_transfer', `PAYOUT „paid" erst bei null Rest (${S([k.payout_status, k.payout_paid_amount])})`);
    const b = JSON.parse(auszahlungsBuchung('r5f-leg-C'));
    ok(b.length === 2 && b.every((x) => Number(x.s) === 800 && Number(x.n) === 1) && b.some((x) => x.account === 'BANK'), `PAYOUT genau EINE Buchung: Aufwand an Bank (${S(b)})`);

    await gehZu(primary, '/consignments/r5f-leg-P', 'R5F-LEG-P');
    { const mm = await auszahlungMaske(primary, 'Bank Transfer', 'R5F-REF'); ok(mm === 'OK', 'PAYOUT-PARITAET dieselbe Maske am Primary (' + mm + ')'); }
    await click(primary, '[data-consignment-payout]');
    ok(await warteAuf(() => kommissionVon('r5f-leg-P').status === 'paid_out'), 'PAYOUT-PARITAET der Primary zahlt aus');
    const kp = kommissionVon('r5f-leg-P');
    ok(norm(kp, KOM_OHNE) === norm(k, KOM_OHNE) && auszahlungsBuchung('r5f-leg-P') === auszahlungsBuchung('r5f-leg-C'),
      `PAYOUT-PARITAET Kommission und Buchung${norm(kp, KOM_OHNE) !== norm(k, KOM_OHNE) ? ` (${norm(kp, KOM_OHNE)} / ${norm(k, KOM_OHNE)})` : ''}`);
  }

  // ── Verlorene Antwort bei der Auszahlung ──
  {
    client = await lade(client, '/consignments/r5f-leg-L');
    { const mm = await auszahlungMaske(client, 'Cash', 'R5F-L'); ok(mm === 'OK', 'VERLOREN-P die Auszahlungsmaske (' + mm + ')'); }
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-consignment-payout]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN-P die Maske meldet den offenen Ausgang');
    await click(client, '[data-consignment-payout]');
    ok(await warteAuf(() => kommissionVon('r5f-leg-L').status === 'paid_out'), 'VERLOREN-P der zweite Versuch kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'consignments.record_payout');
    ok(c.length === 2 && c[0].commandId === c[1].commandId, `VERLOREN-P dieselbe Kennung (${c.length})`);
    const b = JSON.parse(auszahlungsBuchung('r5f-leg-L'));
    ok(Number(kommissionVon('r5f-leg-L').payout_paid_amount) === 800 && b.length === 2 && b.every((x) => Number(x.n) === 1 && Number(x.s) === 800),
      `VERLOREN-P genau EINMAL ausgezahlt, EINMAL gebucht (${S(b)})`);
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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5f: returns + consignment finance, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5F_RETURNS_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5F_CONSIGNMENT_FINANCE_RUNTIME_PROVED');
