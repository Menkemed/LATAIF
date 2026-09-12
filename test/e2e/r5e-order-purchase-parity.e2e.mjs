// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — Auftrag anlegen, Auftrag ändern, Einkauf anlegen vom zweiten Rechner.
// Run: node test/e2e/r5e-order-purchase-parity.e2e.mjs
//
//   /orders/new        normal (bestehender + NEUER Artikel mit Foto, Karte Amex)          → orders.create
//   /orders/new        Sonderanfertigung (Kundengold, Goldschmied, Extra-Gold vom
//                      Goldschmied = Gold-Verbindlichkeit, Spec mit Foto, VAT 10 %)          → orders.create
//   /orders/:id        „Edit" → Lieferant, Einkauf, Preis, Anzahlung, Termin, Notiz → Save  → orders.update
//   /orders/:id        „Edit" am Sonderauftrag → Angebotspreis → Save                      → orders.update
//   /purchases/new     neuer Artikel mit Foto + bestehender, Vorsteuer, Zahlung, Mitarbeiter → purchases.create
//   /purchases/new?sourceOrderId=…  Wareneingang eines Auftrags                         → purchases.create
//
// Bewiesen wird: genau EINE Buchung je Handlung, nichts Abgeleitetes im Rumpf, verlorene Antworten
// legen nichts doppelt an (auch keine zweite Gold-Verbindlichkeit, keinen zweiten Artikel), und
// dieselbe Handlung an der Maske des Primary hat DIESELBE Wirkung.
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
const OWNER_PW = 'r5e-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5e-order', 'run-' + Date.now());
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

const PHOTO = join(RUN, 'r5e-photo.png');
const SEED_PRODUCTS = ['r5e-p1', 'r5e-p2', 'r5e-p3'];
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'r5e-cat', branch_id, name: 'R5E Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    for (const [id, first, last] of [['r5e-kunde', 'Nadia', 'Kunde'], ['r5e-kunde2', 'Omar', 'Zwei']]) {
      insert(db, 'customers', { id, branch_id, first_name: first, last_name: last, country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    }
    for (const [id, name] of [['r5e-sup', 'R5E Lieferant'], ['r5e-gold', 'R5E Goldschmied']]) {
      insert(db, 'suppliers', { id, branch_id, name, active: 1, created_at: now, updated_at: now });
    }
    insert(db, 'employees', { id: 'r5e-emp', branch_id, name: 'R5E Einkauf', employment_status: 'active', created_at: now, updated_at: now });
    for (const [id, tax, planned, cost] of [['r5e-p1', 'VAT_10', 150, 100], ['r5e-p2', 'MARGIN', 200, 120], ['r5e-p3', 'ZERO', 90, 80]]) {
      insert(db, 'products', { id, branch_id, category_id: 'r5e-cat', brand: 'Seiko', name: 'R5E ' + id, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: cost, purchase_currency: 'BHD', planned_sale_price: planned, stock_status: 'in_stock', tax_scheme: tax, days_in_stock: 0, quantity: 1, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now });
      insert(db, 'stock_lots', { id: id + '-lot', branch_id, product_id: id, unit_cost: cost, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: now, created_at: now });
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
const JPEGS = "[...document.querySelectorAll('img')].filter(i=>/^data:image\\/jpeg/.test(i.src)).length";
/** Die Maske „New Item": Kategorie, Marke, Name, Foto — dann ihr Knopf. */
async function neuerArtikel(c, brand, name, submit) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='R5E Cat')", 15000))) return 'KEINE-ARTIKELMASKE';
  await clickText(c, 'R5E Cat'); await sleep(300);
  const r = [await setByLabelPrefix(c, 'BRAND', brand), await setByLabelPrefix(c, 'NAME / MODEL', name)];
  const vor = await c.ev(`return ${JPEGS};`);
  if (await fotoWaehlen(c, PHOTO) !== 'OK') r.push('KEIN-FOTOFELD');
  if (!(await warteBis(c, `${JPEGS} > ${vor}`, 15000))) r.push('KEIN-VORSCHAUBILD');
  await sleep(300);
  // Die Duplikatserkennung der Maske FRAGT bei aehnlichen Artikeln (live oder beim Absenden) —
  // ein Mensch antwortet „Create anyway". Dieselbe Antwort an beiden Rechnern.
  const trotzdem = "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Create anyway')";
  if (await c.ev(`return ${trotzdem};`)) await clickText(c, 'Create anyway');
  else {
    r.push(await clickIncludes(c, submit));
    if (await warteBis(c, trotzdem, 2500)) await clickText(c, 'Create anyway');
  }
  if (!(await warteBis(c, "![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='R5E Cat')", 15000))) {
    r.push('ARTIKELMASKE-BLEIBT:' + String(await c.ev('return document.body.innerText.slice(-200);')).replace(/\s+/g, ' '));
  }
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? schlecht.join(',') : 'OK';
}
/** „New Order", normal: Kunde, ein bestehender Artikel, ein NEUER Artikel mit Foto, Anzahlung mit Karte Amex. */
async function auftragNormal(c, kunde, notiz) {
  if (!(await warteBis(c, "document.querySelector('[data-order-create]')", 45000))) return 'KEINE-MASKE';
  const r = [];
  r.push(await ssPick(c, 'Search clients...', kunde));
  r.push(await ssPick(c, 'Pick product...', 'r5e-p1', 0));
  r.push(await clickText(c, 'Add Item')); await sleep(300);
  r.push(await waehleNth(c, 'New Product', 1, 'new')); await sleep(500);
  r.push(await neuerArtikel(c, 'R5E', 'Neu ' + notiz, 'Artikel uebernehmen'));
  r.push(await setNth(c, 'input[inputmode="decimal"]', 1, '500'));
  r.push(await setByLabel(c, 'DEPOSIT AMOUNT (BHD)', '50'));
  r.push(await clickText(c, 'Card')); await sleep(200);
  r.push(await clickText(c, 'Amex'));
  r.push(await setByLabel(c, 'EXPECTED DELIVERY DATE', '2026-10-01'));
  r.push(await setVal(c, 'textarea[placeholder^="e.g. special requests"]', notiz));
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** „New Order", Sonderanfertigung: Kundengold, Goldschmied-Arbeit, Extra-Gold vom Goldschmied, Spec mit Foto. */
async function auftragCustom(c, kunde, notiz) {
  if (!(await warteBis(c, "document.querySelector('[data-order-create]')", 45000))) return 'KEINE-MASKE';
  const r = [];
  r.push(await ssPick(c, 'Search clients...', kunde));
  r.push(await clickIncludes(c, 'Custom Order')); await sleep(400);
  for (const chip of ['3a · Customer Material', '3b · Goldsmith Labor', '3c · Extra Gold']) { r.push(await clickIncludes(c, chip)); await sleep(200); }
  r.push(await setByLabel(c, 'GOLD WEIGHT (G)', '10'));
  r.push(await clickText(c, '21K'));
  r.push(await ssPick(c, 'Pick: In-house OR a goldsmith', 'r5e-sup'));
  r.push(await setByLabel(c, 'LABOR COST (BHD)', '80'));
  r.push(await setByLabel(c, 'WEIGHT (G)', '5'));
  await sleep(300);
  r.push(await setByLabelPrefix(c, 'COST (BHD)', '120'));
  r.push(await ssPick(c, 'Pick: Own Gold OR a goldsmith (creates gold liability)', 'r5e-gold'));
  r.push(await clickIncludes(c, '+ Define Final Product')); await sleep(400);
  r.push(await neuerArtikel(c, 'R5E', 'Ring Spec', 'Spec uebernehmen'));
  r.push(await setByLabel(c, 'QUOTED PRICE — APPROX. (BHD)', '1100'));
  r.push(await clickIncludes(c, 'VAT 10%'));
  r.push(await setByLabel(c, 'DEPOSIT AMOUNT (BHD)', '300'));
  r.push(await clickText(c, 'Bank'));
  r.push(await setVal(c, 'textarea[placeholder^="e.g. special requests"]', notiz));
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** „Edit" oben auf der Auftragsseite, die Werte, dann „Save". */
async function auftragAendern(c, felder) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Edit'&&b.parentElement.textContent.includes('Order Receipt'))", 45000))) return 'KEIN-EDIT';
  await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Edit'&&b.parentElement.textContent.includes('Order Receipt')).click(); return 1;");
  if (!(await warteBis(c, "document.querySelector('[data-order-save]')", 15000))) return 'KEINE-MASKE';
  // Die Seite liest beim Oeffnen noch nach und setzt das Formular dabei neu — erst danach tippen,
  // und vor dem Speichern nachsehen, ob jede Eingabe noch dasteht (ein Mensch sieht das auch).
  await sleep(1200);
  const r = [];
  const lies = (label) => c.ev(label === 'NOTES'
    ? "const t=[...document.querySelectorAll('span')].filter(x=>x.textContent.trim()==='NOTES').pop(); return t ? t.parentElement.querySelector('textarea').value : '';"
    : `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop(); return l ? l.parentElement.querySelector('input,textarea').value : '';`);
  for (let runde = 0; runde < 3; runde++) {
    r.length = 0;
    for (const [label, v] of felder) {
      if (String(await lies(label)) === v) { r.push('OK'); continue; }
      r.push(label === 'NOTES' ? await setUnterUeberschrift(c, 'NOTES', v) : await setByLabel(c, label, v));
      await sleep(150);
    }
    await sleep(500);
    let alle = true;
    for (const [label, v] of felder) if (String(await lies(label)) !== v) alle = false;
    if (alle) break;
  }
  await sleep(300);
  await click(c, '[data-order-save]');
  if (!(await warteBis(c, "!document.querySelector('[data-order-save]')", 45000))) r.push('NICHT-GESPEICHERT:' + (await fehlerAnzeige(c)));
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** „New Purchase": Lieferant, ein NEUER Artikel mit Foto, ein bestehender, Vorsteuer 10 %, Zahlung, Mitarbeiter. */
async function einkauf(c, notiz) {
  if (!(await warteBis(c, "document.querySelector('[data-purchase-save]')", 45000))) return 'KEINE-MASKE';
  const r = [];
  r.push(await ssPick(c, 'Search suppliers...', 'r5e-sup'));
  r.push(await clickText(c, '+ Define new item…')); await sleep(400);
  r.push(await neuerArtikel(c, 'R5E', 'Neu ' + notiz, 'Use this Item'));
  r.push(await setNth(c, 'input[type="number"][min="1"]', 0, '2'));
  r.push(await setNth(c, 'input[type="number"][min="0"][step="0.001"]', 0, '110'));
  r.push(await clickText(c, 'Add Item')); await sleep(300);
  r.push(await waehleNth(c, 'Existing', 1, 'existing')); await sleep(300);
  r.push(await ssPick(c, 'Pick product...', 'r5e-p3', 0));
  r.push(await setNth(c, 'input[type="number"][min="1"]', 1, '3'));
  r.push(await setNth(c, 'input[type="number"][min="0"][step="0.001"]', 1, '90'));
  r.push(await clickIncludes(c, '10% (Vorsteuer enthalten)'));
  r.push(await setByLabel(c, 'AMOUNT (BHD)', '100'));
  r.push(await clickText(c, 'Cash'));
  r.push(await waehleIn(c, 'Unassigned', 'r5e-emp'));
  r.push(await setVal(c, 'textarea[placeholder^="z.B. Lieferscheinnummer"]', notiz));
  await sleep(300);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}

// ── Was am Primary steht ──
const AUF_OHNE = /^(id|order_number|customer_id|notes|created_by|revision|version|sync_status|existing_product_id|product_id)$|_at$/;
const norm = (r, ohne, auch = []) => S(Object.fromEntries(Object.entries(r || {}).filter(([k]) => !ohne.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b))));
const auftragMit = (notiz) => dbQ(BIZ_DB, 'SELECT * FROM orders WHERE notes = ?', [notiz]);
const pidN = (v) => (v && !SEED_PRODUCTS.includes(v) ? 'NEU' : v);
const zeilenVon = (oid) => dbQ(BIZ_DB, 'SELECT * FROM order_lines WHERE order_id = ? ORDER BY position', [oid])
  .map((z) => { const neu = z.product_id && !SEED_PRODUCTS.includes(z.product_id); return norm({ ...z, product_id: pidN(z.product_id), description: neu ? 'NEU' : z.description }, /^(id|order_id|expense_id)$|_at$/); });
const zahlungVon = (oid) => S(dbQ(BIZ_DB, 'SELECT amount, method, card_brand, note FROM order_payments WHERE order_id = ?', [oid]));
const goldVon = (oid) => {
  const pos = new Map(dbQ(BIZ_DB, 'SELECT id, position FROM order_lines WHERE order_id = ?', [oid]).map((z) => [z.id, z.position]));
  return S(dbQ(BIZ_DB, 'SELECT supplier_id, weight_grams, karat, direction, settlement_type, status, source_order_line_id FROM gold_payables WHERE source_order_id = ?', [oid])
    .map((g) => ({ ...g, source_order_line_id: pos.get(g.source_order_line_id) ?? null })));
};
const buchungVonZahlung = (oid) => S(dbQ(BIZ_DB, `SELECT account, direction, ROUND(SUM(amount), 3) AS s FROM ledger_entries
  WHERE source_id IN (SELECT id FROM order_payments WHERE order_id = ?) GROUP BY account, direction ORDER BY account, direction`, [oid]));
const gebuehrVon = (oid) => S(dbQ(BIZ_DB, 'SELECT category, status, ROUND(amount, 3) AS a FROM expenses WHERE related_entity_id = ?', [oid]));
const neueArtikelVon = (ids) => ids.filter((x) => x && !SEED_PRODUCTS.includes(x))
  .map((x) => norm(dbQ(BIZ_DB, 'SELECT * FROM products WHERE id = ?', [x])[0], /^(id|name|created_by|image_description|image_embedding|version|sync_status)$|_at$/));
const einkaufMit = (notiz) => dbQ(BIZ_DB, 'SELECT * FROM purchases WHERE notes = ?', [notiz]);
const EIN_OHNE = /^(id|purchase_number|notes|supplier_snapshot|created_by|revision|version|sync_status|source_order_id)$|_at$/;
const einkaufZeilen = (pid) => dbQ(BIZ_DB, 'SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid])
  .map((z) => norm({ ...z, product_id: pidN(z.product_id) }, /^(id|purchase_id|source_order_line_id)$|_at$/));
const loseVon = (pid) => S(dbQ(BIZ_DB, 'SELECT product_id, unit_cost, qty_total, qty_remaining, status FROM stock_lots WHERE purchase_id = ? ORDER BY unit_cost', [pid])
  .map((l) => ({ ...l, product_id: pidN(l.product_id) })));
const zahl = (sql, p = []) => Number(Object.values(dbQ(BIZ_DB, sql, p)[0] || { n: 0 })[0]);
async function warteAuf(pruefe) {
  for (let i = 0; i < 40; i++) {
    await spuelen(primary);
    if (pruefe()) return true;
    await sleep(400);
  }
  return false;
}
const woanders = (c, muster) => warteBis(c, `${muster}.test(location.pathname)`, 45000);

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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5E Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5E Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5E Admin');
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
  writePhoto(PHOTO, 90);

  // ══════════════════════════════════════════════════════════════════════
  // §10 AUFTRAG ANLEGEN — normal, am zweiten Rechner und am Primary
  // ══════════════════════════════════════════════════════════════════════
  let pc2Normal = null, pNormal = null;
  {
    client = await lade(client, '/orders/new');
    const m = await auftragNormal(client, 'r5e-kunde', 'R5E PC2 Normal');
    ok(m === 'OK', `ORDER die normale Anlegemaske am zweiten Rechner (${m})`);
    await click(client, '[data-order-create]');
    ok(await woanders(client, '/^\\/orders\\/(?!new)/'), `ORDER der zweite Rechner landet auf dem neuen Auftrag (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = await buchungen(client);
    ok(cmds.length === 1 && cmds[0].op === 'orders.create', `ORDER genau EINE Buchung: ${cmds.map((x) => x.op).join(',') || 'keine'}`);
    const p = cmds[0]?.payload || {};
    ok(!('agreedPrice' in p) && !('taxAmount' in p) && !('remainingAmount' in p) && !('type' in p) && !('orderNumber' in p) && !S(p).includes('base64'),
      `ORDER keine Summe, keine Steuer, kein Rest, kein Typ, keine Nummer, keine Bildbytes (${Object.keys(p).join(',')})`);
    ok(p.lines?.[1]?.newProduct && Array.isArray(p.lines[1].newProduct.stagingIds) && p.lines[1].newProduct.stagingIds.length === 1,
      `ORDER der neue Artikel reist als Entwurf, das Foto als Ablagekennung (${S(p.lines?.[1]?.newProduct).slice(0, 160)})`);
    await warteAuf(() => auftragMit('R5E PC2 Normal').length === 1);
    pc2Normal = auftragMit('R5E PC2 Normal')[0] || {};
    ok(pc2Normal.type === 'normal' && Number(pc2Normal.agreed_price) === 650 && Math.abs(Number(pc2Normal.tax_amount) - 15) < 0.005,
      `ORDER Summe 150 + 500 und sichtbare Steuer 10 % auf die VAT-Zeile vom Haus (${S([pc2Normal.agreed_price, pc2Normal.tax_amount])})`);
    const zeilen = dbQ(BIZ_DB, 'SELECT product_id FROM order_lines WHERE order_id = ?', [pc2Normal.id]);
    const neu = neueArtikelVon(zeilen.map((z) => z.product_id));
    ok(zeilen.length === 2 && neu.length === 1 && /data:image\/jpeg;base64,/.test(neu[0]), 'ORDER der neue Artikel steht, mit Foto');
    ok(zahlungVon(pc2Normal.id).includes('"card_brand":"amex"') && /card/i.test(gebuehrVon(pc2Normal.id)),
      `ORDER Anzahlung mit Kartenart, Kartengebuehr gebucht (${gebuehrVon(pc2Normal.id)})`);
    ok(await warteBis(client, `document.body.innerText.includes(${S(pc2Normal.order_number)})`, 30000), 'ORDER der zweite Rechner zeigt den Auftrag — gelesen vom Primary');
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');

    await geh(primary, '/orders/new');
    ok(await auftragNormal(primary, 'r5e-kunde2', 'R5E Primary Normal') === 'OK', 'ORDER-PARITAET dieselbe Maske am Primary');
    await click(primary, '[data-order-create]');
    ok(await woanders(primary, '/^\\/orders\\/(?!new)/'), 'ORDER-PARITAET der Primary legt ihn über seine eigene Maske an');
    await warteAuf(() => auftragMit('R5E Primary Normal').length === 1);
    pNormal = auftragMit('R5E Primary Normal')[0] || {};
    ok(norm(pNormal, AUF_OHNE) === norm(pc2Normal, AUF_OHNE), `ORDER-PARITAET Kopf: Primary == PC2${norm(pNormal, AUF_OHNE) !== norm(pc2Normal, AUF_OHNE) ? ` (${norm(pNormal, AUF_OHNE)} / ${norm(pc2Normal, AUF_OHNE)})` : ''}`);
    ok(S(zeilenVon(pNormal.id)) === S(zeilenVon(pc2Normal.id)), `ORDER-PARITAET Zeilen (${S(zeilenVon(pc2Normal.id)).slice(0, 200)})`);
    ok(zahlungVon(pNormal.id) === zahlungVon(pc2Normal.id) && buchungVonZahlung(pNormal.id) === buchungVonZahlung(pc2Normal.id)
      && gebuehrVon(pNormal.id) === gebuehrVon(pc2Normal.id), 'ORDER-PARITAET Anzahlung, Buchung, Kartengebuehr');
    const np = neueArtikelVon(dbQ(BIZ_DB, 'SELECT product_id FROM order_lines WHERE order_id = ?', [pNormal.id]).map((z) => z.product_id));
    const nc = neueArtikelVon(dbQ(BIZ_DB, 'SELECT product_id FROM order_lines WHERE order_id = ?', [pc2Normal.id]).map((z) => z.product_id));
    ok(S(np) === S(nc), 'ORDER-PARITAET der neue Artikel (bis auf seinen Namen) derselbe — auch das Foto');
  }

  // ── Sonderanfertigung mit Gold-Verbindlichkeit ──
  let pc2Custom = null;
  {
    client = await lade(client, '/orders/new');
    const m = await auftragCustom(client, 'r5e-kunde', 'R5E PC2 Custom');
    ok(m === 'OK', `CUSTOM die Maske der Sonderanfertigung am zweiten Rechner (${m})`);
    await click(client, '[data-order-create]');
    ok(await woanders(client, '/^\\/orders\\/(?!new)/'), `CUSTOM der Auftrag entsteht (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = (await buchungen(client)).filter((x) => x.op === 'orders.create');
    ok(cmds.length === 1, `CUSTOM genau EINE Buchung (${cmds.length})`);
    const p = cmds[0]?.payload || {};
    ok(p.orderType === 'custom' && p.extraGoldSupplierId === 'r5e-gold' && p.extraGoldGrams === 5 && !('goldPayable' in p) && !('extraGoldValue' in p),
      `CUSTOM Extra-Gold und Goldschmied reisen als Eingabe — die Verbindlichkeit nicht (${S({ t: p.orderType, g: p.extraGoldGrams, s: p.extraGoldSupplierId })})`);
    ok(Array.isArray(p.customProductSpec?.stagingIds) && p.customProductSpec.stagingIds.length === 1, 'CUSTOM das Foto der Spec als Ablagekennung');
    await warteAuf(() => auftragMit('R5E PC2 Custom').length === 1);
    pc2Custom = auftragMit('R5E PC2 Custom')[0] || {};
    ok(pc2Custom.type === 'custom' && Number(pc2Custom.agreed_price) === 1100 && Math.abs(Number(pc2Custom.tax_amount) - 100) < 0.005,
      `CUSTOM Angebot brutto, Steuer 10 % darin (${S([pc2Custom.agreed_price, pc2Custom.tax_amount])})`);
    const kinds = dbQ(BIZ_DB, 'SELECT material_kind FROM order_lines WHERE order_id = ? ORDER BY position', [pc2Custom.id]).map((z) => z.material_kind).join(',');
    ok(kinds === 'custom,labor,gold', `CUSTOM Angebots-, Arbeits- und Goldzeile (${kinds})`);
    const gold = JSON.parse(goldVon(pc2Custom.id));
    ok(gold.length === 1 && gold[0].supplier_id === 'r5e-gold' && Number(gold[0].weight_grams) === 5 && gold[0].karat === '22K' && gold[0].status === 'OPEN' && gold[0].source_order_line_id === 3,
      `CUSTOM die Gold-Verbindlichkeit beim Goldschmied, an der Extra-Gold-Zeile (${S(gold)})`);
    const meta = JSON.parse(String(pc2Custom.custom_meta || '{}'));
    ok(meta.customerGoldWeight === 10 && meta.customerGoldKarat === '21K', 'CUSTOM das Kundengold steht im Auftrag');
    const spec = JSON.parse(String(pc2Custom.custom_product_spec || '{}'));
    ok(Array.isArray(spec.images) && spec.images.length === 1 && /^data:image\/jpeg;base64,/.test(spec.images[0]), 'CUSTOM die Spec des fertigen Stuecks mit Foto');

    await geh(primary, '/orders/new');
    ok(await auftragCustom(primary, 'r5e-kunde2', 'R5E Primary Custom') === 'OK', 'CUSTOM-PARITAET dieselbe Maske am Primary');
    await click(primary, '[data-order-create]');
    ok(await woanders(primary, '/^\\/orders\\/(?!new)/'), 'CUSTOM-PARITAET der Primary legt ihn an');
    await warteAuf(() => auftragMit('R5E Primary Custom').length === 1);
    const pc = auftragMit('R5E Primary Custom')[0] || {};
    ok(norm(pc, AUF_OHNE) === norm(pc2Custom, AUF_OHNE), `CUSTOM-PARITAET Kopf inkl. Spec und Kundenmaterial${norm(pc, AUF_OHNE) !== norm(pc2Custom, AUF_OHNE) ? ` (${norm(pc, AUF_OHNE).slice(0, 300)} / ${norm(pc2Custom, AUF_OHNE).slice(0, 300)})` : ''}`);
    ok(S(zeilenVon(pc.id)) === S(zeilenVon(pc2Custom.id)) && goldVon(pc.id) === goldVon(pc2Custom.id) && zahlungVon(pc.id) === zahlungVon(pc2Custom.id),
      'CUSTOM-PARITAET Zeilen, Gold-Verbindlichkeit, Anzahlung');
  }

  // ── Verlorene Antwort bei der Sonderanfertigung ──
  {
    const goldVor = zahl('SELECT COUNT(*) AS n FROM gold_payables');
    client = await lade(client, '/orders/new');
    ok(await auftragCustom(client, 'r5e-kunde', 'R5E PC2 Verloren') === 'OK', 'VERLOREN die Maske, noch einmal');
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-order-create]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN die Maske meldet den offenen Ausgang');
    await click(client, '[data-order-create]');
    ok(await woanders(client, '/^\\/orders\\/(?!new)/'), 'VERLOREN der zweite Versuch derselben Absicht kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'orders.create');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload), `VERLOREN dieselbe Kennung, derselbe Rumpf (${c.length})`);
    await warteAuf(() => auftragMit('R5E PC2 Verloren').length > 0);
    ok(auftragMit('R5E PC2 Verloren').length === 1 && zahl('SELECT COUNT(*) AS n FROM gold_payables') === goldVor + 1,
      'VERLOREN genau EIN Auftrag und genau EINE Gold-Verbindlichkeit');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §11 AUFTRAG ÄNDERN — Marge und Rest rechnet das Haus; die Angebotszeile beim Sonderauftrag
  // ══════════════════════════════════════════════════════════════════════
  {
    const FELDER = [['SUPPLIER NAME', 'Dealer'], ['SUPPLIER PRICE (BHD)', '100'], ['AGREED PRICE (BHD)', '400'],
      ['DEPOSIT AMOUNT (BHD)', '120'], ['EXPECTED DELIVERY', '2026-11-11'], ['NOTES', 'R5E PC2 geaendert']];
    const revVor = Number(pc2Normal.revision);
    client = await lade(client, '/orders/' + pc2Normal.id);
    ok(await auftragAendern(client, FELDER) === 'OK', 'EDIT die „Edit"-Maske des Auftrags am zweiten Rechner');
    const up = (await buchungen(client)).filter((x) => x.op === 'orders.update');
    const p = up[0]?.payload || {};
    ok(up.length === 1 && S(Object.keys(p).sort()) === S(['agreedPrice', 'depositAmount', 'expectedDelivery', 'expectedRevision', 'id', 'notes', 'supplierName', 'supplierPrice']),
      `EDIT genau EINE Buchung mit den sechs Eingaben und der Fassung (${Object.keys(p).join(',')})`);
    await warteAuf(() => (dbQ(BIZ_DB, 'SELECT notes FROM orders WHERE id = ?', [pc2Normal.id])[0] || {}).notes === 'R5E PC2 geaendert');
    const z = dbQ(BIZ_DB, 'SELECT * FROM orders WHERE id = ?', [pc2Normal.id])[0] || {};
    ok(Number(z.expected_margin) === 300 && Number(z.remaining_amount) === 280 && Number(z.agreed_price) === 400,
      `EDIT Marge 400 − 100 und Rest 400 − 120 vom Haus (${S([z.expected_margin, z.remaining_amount])})`);
    ok(Number(z.revision) > revVor, `EDIT die Fassung steigt (${revVor} → ${z.revision})`);
    await geh(primary, '/orders/' + pNormal.id);
    ok(await auftragAendern(primary, FELDER.map(([l, v]) => [l, l === 'NOTES' ? 'R5E PC2 geaendert' : v])) === 'OK', 'EDIT-PARITAET dieselbe Aenderung am Primary');
    await warteAuf(() => (dbQ(BIZ_DB, 'SELECT notes FROM orders WHERE id = ?', [pNormal.id])[0] || {}).notes === 'R5E PC2 geaendert');
    const zp = dbQ(BIZ_DB, 'SELECT * FROM orders WHERE id = ?', [pNormal.id])[0] || {};
    ok(norm(zp, AUF_OHNE) === norm(z, AUF_OHNE), `EDIT-PARITAET Kopf: Primary == PC2${norm(zp, AUF_OHNE) !== norm(z, AUF_OHNE) ? ` (${norm(zp, AUF_OHNE)} / ${norm(z, AUF_OHNE)})` : ''}`);

    // Sonderauftrag: der Preis zieht die Angebotszeile.
    client = await lade(client, '/orders/' + pc2Custom.id);
    ok(await auftragAendern(client, [['QUOTED PRICE (BHD)', '1300']]) === 'OK', 'EDIT-CUSTOM der Angebotspreis am zweiten Rechner');
    await warteAuf(() => Number((dbQ(BIZ_DB, 'SELECT agreed_price FROM orders WHERE id = ?', [pc2Custom.id])[0] || {}).agreed_price) === 1300);
    const q = dbQ(BIZ_DB, "SELECT unit_price FROM order_lines WHERE order_id = ? AND material_kind = 'custom'", [pc2Custom.id])[0] || {};
    ok(Number(q.unit_price) === 1300, `EDIT-CUSTOM die Angebotszeile traegt den neuen Preis, der Kopf folgt (${q.unit_price})`);
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §12 EINKAUF ANLEGEN — neuer + bestehender Artikel, Vorsteuer, Zahlung, Mitarbeiter
  // ══════════════════════════════════════════════════════════════════════
  {
    const p3Vor = zahl("SELECT quantity AS n FROM products WHERE id = 'r5e-p3'");
    client = await lade(client, '/purchases/new');
    const m = await einkauf(client, 'R5E PC2 Einkauf');
    ok(m === 'OK', `PURCHASE die Einkaufsmaske am zweiten Rechner (${m})`);
    await click(client, '[data-purchase-save]');
    ok(await woanders(client, '/^\\/purchases\\/(?!new)/'), `PURCHASE der zweite Rechner landet auf dem Einkauf (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const c = (await buchungen(client)).filter((x) => x.op === 'purchases.create');
    ok(c.length === 1, `PURCHASE genau EINE Buchung (${c.length})`);
    const p = c[0]?.payload || {};
    ok(p.staffId === 'r5e-emp' && p.taxScheme === 'VAT_10' && p.paymentAmount === 100 && Array.isArray(p.lines?.[0]?.newProduct?.stagingIds)
      && !S(p).includes('base64') && !('purchaseNumber' in p) && !S(p).includes('lotId') && !S(p).includes('vatAmount'),
    `PURCHASE Mitarbeiter, Vorsteuerwahl, Zahlung, Entwurf mit Ablagekennung — keine Nummer, kein Los, keine Steuerbetraege (${Object.keys(p).join(',')})`);
    await warteAuf(() => einkaufMit('R5E PC2 Einkauf').length === 1);
    const e = einkaufMit('R5E PC2 Einkauf')[0] || {};
    ok(Number(e.total_amount) === 490 && e.staff_id === 'r5e-emp' && e.status === 'PARTIALLY_PAID',
      `PURCHASE Summe 2×110 + 3×90, Mitarbeiter und Status vom Haus (${S([e.total_amount, e.staff_id, e.status])})`);
    ok(zahl("SELECT quantity AS n FROM products WHERE id = 'r5e-p3'") === p3Vor + 3, 'PURCHASE der Bestand steigt genau einmal');
    const neu = neueArtikelVon(dbQ(BIZ_DB, 'SELECT product_id FROM purchase_lines WHERE purchase_id = ?', [e.id]).map((z) => z.product_id));
    ok(neu.length === 1 && /data:image\/jpeg;base64,/.test(neu[0]) && neu[0].includes('"quantity":2'), 'PURCHASE der neue Artikel mit Foto und Menge');
    ok(JSON.parse(loseVon(e.id)).length === 2, 'PURCHASE ein Los je Zeile');

    await geh(primary, '/purchases/new');
    const mp = await einkauf(primary, 'R5E Primary Einkauf');
    ok(mp === 'OK', `PURCHASE-PARITAET dieselbe Maske am Primary (${mp})`);
    await click(primary, '[data-purchase-save]');
    ok(await woanders(primary, '/^\\/purchases\\/(?!new)/'), 'PURCHASE-PARITAET der Primary legt ihn an');
    await warteAuf(() => einkaufMit('R5E Primary Einkauf').length === 1);
    const ep = einkaufMit('R5E Primary Einkauf')[0] || {};
    ok(norm(ep, EIN_OHNE) === norm(e, EIN_OHNE), `PURCHASE-PARITAET Kopf${norm(ep, EIN_OHNE) !== norm(e, EIN_OHNE) ? ` (${norm(ep, EIN_OHNE)} / ${norm(e, EIN_OHNE)})` : ''}`);
    ok(S(einkaufZeilen(ep.id)) === S(einkaufZeilen(e.id)) && loseVon(ep.id) === loseVon(e.id), 'PURCHASE-PARITAET Zeilen und Lose');
    const nep = neueArtikelVon(dbQ(BIZ_DB, 'SELECT product_id FROM purchase_lines WHERE purchase_id = ?', [ep.id]).map((z) => z.product_id));
    ok(S(nep) === S(neu), 'PURCHASE-PARITAET der neue Artikel (bis auf seinen Namen) derselbe — auch das Foto');
  }

  // ── Verlorene Antwort beim Einkauf ──
  {
    const vor = S([zahl('SELECT COUNT(*) AS n FROM purchases'), zahl('SELECT COUNT(*) AS n FROM products'), zahl('SELECT COUNT(*) AS n FROM stock_lots')]);
    client = await lade(client, '/purchases/new');
    ok(await einkauf(client, 'R5E PC2 Verloren') === 'OK', 'VERLOREN-E die Einkaufsmaske, noch einmal');
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-purchase-save]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN-E die Maske meldet den offenen Ausgang');
    await click(client, '[data-purchase-save]');
    ok(await woanders(client, '/^\\/purchases\\/(?!new)/'), 'VERLOREN-E der zweite Versuch kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'purchases.create');
    ok(c.length === 2 && c[0].commandId === c[1].commandId, `VERLOREN-E dieselbe Kennung (${c.length})`);
    await warteAuf(() => einkaufMit('R5E PC2 Verloren').length > 0);
    const nach = [zahl('SELECT COUNT(*) AS n FROM purchases'), zahl('SELECT COUNT(*) AS n FROM products'), zahl('SELECT COUNT(*) AS n FROM stock_lots')];
    const v = JSON.parse(vor);
    ok(nach[0] === v[0] + 1 && nach[1] === v[1] + 1 && nach[2] === v[2] + 2, `VERLOREN-E genau ein Einkauf, ein neuer Artikel, zwei Lose (${S(v)} → ${S(nach)})`);
  }

  // ── Wareneingang eines Auftrags ──
  {
    const lid = String((dbQ(BIZ_DB, "SELECT id FROM order_lines WHERE order_id = ? AND product_id = 'r5e-p1'", [pc2Normal.id])[0] || {}).id || '');
    ok(!!lid && (dbQ(BIZ_DB, 'SELECT status FROM order_lines WHERE id = ?', [lid])[0] || {}).status === 'PENDING', 'B2B die Auftragsposition wartet auf Ware');
    client = await lade(client, `/purchases/new?sourceOrderId=${pc2Normal.id}&sourceOrderLineIds=${lid}`);
    ok(await warteBis(client, "document.body.innerText.includes('Beschaffung fuer Order')", 45000), 'B2B die Maske kommt aus dem Auftrag');
    const r = [await ssPick(client, 'Search suppliers...', 'r5e-sup'), await setNth(client, 'input[type="number"][min="0"][step="0.001"]', 0, '95')];
    ok(r.every((x) => x === 'OK'), `B2B Lieferant und Preis (${r.join(',')})`);
    await click(client, '[data-purchase-save]');
    ok(await woanders(client, `/^\\/orders\\/${pc2Normal.id}/`), `B2B zurueck zum Auftrag (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 160) || 'keiner'})`);
    const c = (await buchungen(client)).filter((x) => x.op === 'purchases.create').pop()?.payload || {};
    ok(c.sourceOrderId === pc2Normal.id && c.lines?.[0]?.sourceOrderLineId === lid, `B2B der Auftrag nennt Auftrag und Position (${S({ o: c.sourceOrderId, l: c.lines?.[0]?.sourceOrderLineId })})`);
    ok(await warteAuf(() => (dbQ(BIZ_DB, 'SELECT status FROM order_lines WHERE id = ?', [lid])[0] || {}).status === 'ARRIVED'), 'B2B die Position ist angekommen');
    ok(zahl('SELECT COUNT(*) AS n FROM purchase_lines WHERE source_order_line_id = ?', [lid]) === 1
      && zahl('SELECT COUNT(*) AS n FROM purchases WHERE source_order_id = ?', [pc2Normal.id]) === 1, 'B2B Einkauf und Position sind verknuepft');
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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5e: order create/update + purchase create, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5E_ORDER_CREATE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5E_ORDER_UPDATE_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5E_PURCHASE_CREATE_RUNTIME_PROVED');
