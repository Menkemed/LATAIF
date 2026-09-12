// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F.1 — Rechnungsstorno vom zweiten Rechner, und der Mitarbeiter einer neuen Retoure.
// Run: node test/e2e/r5f1-invoice-cancel.e2e.mjs
//
//   /invoices/:id  Cancel -> Dialog (Cash) -> Cancel Invoice   (teilbezahlt)  -> invoices.cancel
//   /invoices/:id  Cancel -> Dialog -> Cancel Invoice          (unbezahlt)    -> invoices.cancel
//   /invoices/:id  Create Return A mit Mitarbeiter, dann B auf derselben Seite -> returns.create x2
//
// Bewiesen wird: genau EIN Storno-Auftrag, keine einzelne Freigabe/Erstattung, verlorene Antwort ohne
// zweite Wirkung, Primary == PC2, kein lokaler Schreibgriff; die zweite Retoure beginnt bei Unassigned.
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
const OWNER_PW = 'r5f1-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-r5f1-cancel', 'run-' + Date.now());
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


// ── Die Welt des Laufs: Rechnungen zum Stornieren und zum zweimaligen Zurücknehmen ──
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || 'branch-main';
    const now = new Date().toISOString();
    insert(db, 'categories', { id: 'r5g-cat', branch_id, name: 'R5G Cat', icon: 'Watch', color: '#715DE3', attributes: '[]', scope_options: '[]', condition_options: '[]', active: 1, sort_order: 99, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'r5g-kunde', branch_id, first_name: 'Maya', last_name: 'Storno', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    insert(db, 'employees', { id: 'r5g-emp', branch_id, name: 'R5G Kasse', employment_status: 'active', created_at: now, updated_at: now });
    const artikel = (id, extra) => insert(db, 'products', { id, branch_id, category_id: 'r5g-cat', brand: 'Tudor', name: 'R5G ' + id, sku: id.toUpperCase(), condition: 'New', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: 220, tax_scheme: 'VAT_10', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: now, updated_at: now, ...extra });
    const rechnung = (inv, status, gross, bezahlt, zeilen) => {
      insert(db, 'invoices', { id: inv, branch_id, invoice_number: inv.toUpperCase(), customer_id: 'r5g-kunde', status, currency: 'BHD', net_amount: gross / 1.1, vat_rate_snapshot: 10, vat_amount: gross - gross / 1.1, gross_amount: gross, paid_amount: bezahlt, tax_scheme_snapshot: 'VAT_10', issued_at: now, created_at: now, updated_at: now });
      zeilen.forEach((pid, i) => insert(db, 'invoice_lines', { id: `${inv}-l${i + 1}`, invoice_id: inv, product_id: pid, lot_id: `${pid}-lot`, quantity: 1, unit_price: 200, purchase_price: 100, vat_rate: 10, tax_scheme: 'VAT_10', vat_amount: 20, line_total: 220, position: i + 1 }));
      if (bezahlt > 0) insert(db, 'payments', { id: `${inv}-pay`, branch_id, invoice_id: inv, amount: bezahlt, method: 'cash', received_at: now, created_at: now });
    };
    const verkauft = (pid, status) => {
      artikel(pid, { stock_status: status, quantity: 0 });
      insert(db, 'stock_lots', { id: `${pid}-lot`, branch_id, product_id: pid, unit_cost: 100, qty_total: 1, qty_remaining: 0, status: 'EXHAUSTED', acquired_at: now, created_at: now });
    };
    // Stornieren: teilbezahlt (100 von 220) — F Primary, G PC2, H verlorene Antwort; unbezahlt — I Primary, J PC2.
    for (const [tag, bezahlt] of [['F', 100], ['G', 100], ['H', 100], ['I', 0], ['J', 0]]) {
      verkauft(`r5g-p${tag}`, 'reserved');
      rechnung(`r5g-inv-${tag}`, 'PARTIAL', 220, bezahlt, [`r5g-p${tag}`]);
    }
    // Zweimal zurücknehmen auf derselben Seite: zwei Zeilen, voll bezahlt — K Primary, L PC2.
    for (const tag of ['K', 'L']) {
      verkauft(`r5g-p${tag}1`, 'sold'); verkauft(`r5g-p${tag}2`, 'sold');
      rechnung(`r5g-inv-${tag}`, 'FINAL', 440, 440, [`r5g-p${tag}1`, `r5g-p${tag}2`]);
    }
  } finally { try { db.close(); } catch { /* zu */ } }
}

/** „Cancel" → Dialog → (bei Geld) Erstattungsweg. */
async function stornoDialog(c, weg) {
  if (!(await warteBis(c, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Cancel')", 45000))) return 'KEIN-KNOPF';
  const r = [await clickText(c, 'Cancel')];
  if (!(await warteBis(c, "document.querySelector('[data-invoice-cancel]')", 15000))) return 'KEIN-DIALOG';
  if (weg) r.push(await clickText(c, weg));
  await sleep(250);
  const schlecht = r.filter((x) => x !== 'OK');
  return schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK';
}
/** Die Retourenmaske OHNE den Mitarbeiter anzufassen — gezeigt wird, womit sie beginnt. */
async function retoureOhneMitarbeiter(c) {
  const r = [await clickIncludes(c, 'Create Return')];
  if (!(await warteBis(c, "document.querySelector('[data-return-save]')", 15000))) return { m: 'KEINE-MASKE', staff: '?' };
  r.push(await c.ev("const h=[...document.querySelectorAll('span')].find(x=>x.textContent.trim()==='UNIT PRICE (incl. VAT)'); if(!h) return 'NO-HEAD';"
    + " const cb=h.parentElement.parentElement.querySelector('input[type=checkbox]:not([disabled])'); if(!cb) return 'NO-BOX'; cb.click(); return 'OK';"));
  await sleep(250);
  r.push(await clickText(c, 'Cash'));
  r.push(await clickText(c, 'Refund later (Status: Pending)'));
  const staff = await c.ev("const t=[...document.querySelectorAll('span')].filter(x=>x.textContent.trim()==='STAFF').pop(); const s=t&&t.parentElement.querySelector('select'); return s ? s.value : 'NO-STAFF';");
  await sleep(250);
  const schlecht = r.filter((x) => x !== 'OK');
  return { m: schlecht.length ? 'FELD:' + schlecht.join(',') : 'OK', staff };
}
// R5F FINAL — die Notiz wird NICHT ausgeblendet: nur die Rechnungsnummer des jeweiligen Zwillings wird zu
// <INVOICE_NO>, der Rest muss wortgleich sein.
const STO_OHNE = /^(id|return_number|invoice_id|created_by|revision|version|sync_status)$|_at$/;
const mitNr = (zeile, nr) => ({ ...zeile, notes: zeile && zeile.notes != null ? String(zeile.notes).split(nr).join('<INVOICE_NO>') : zeile?.notes });
const warenG = (pid) => S([dbQ(BIZ_DB, 'SELECT quantity, stock_status FROM products WHERE id = ?', [pid])[0], dbQ(BIZ_DB, 'SELECT qty_remaining, status FROM stock_lots WHERE id = ?', [`${pid}-lot`])[0]]);
const statusVon = (inv) => (dbQ(BIZ_DB, 'SELECT status FROM invoices WHERE id = ?', [inv])[0] || {}).status;

try {
  assertE2eClientBinary(CLIENT_APP);
  killAll(); await waitGone('lataif.exe'); await waitGone('lataif-e2e-client.exe');
  for (const d of [RUN, CLIENT_APPDATA, join(CLIENT_HOME, 'Local'), join(CLIENT_HOME, 'tmp'), join(RUN, 'tmp')]) mkdirSync(d, { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  primary = await attach(APP_CDP, APP, appEnv());
  await waitInvoke(primary);
  await waitFor(primary, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(primary, '[data-first-run-new]')) { await click(primary, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'R5G Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'R5G Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'R5G Admin');
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
  // §6 RECHNUNG STORNIEREN — mit Geld (Retoure + Freigabe + Erstattung), am zweiten Rechner und am Primary
  // ══════════════════════════════════════════════════════════════════════
  {
    client = await lade(client, '/invoices/r5g-inv-G');
    { const mm = await stornoDialog(client, 'Cash'); ok(mm === 'OK', `CANCEL der Storno-Dialog am zweiten Rechner (${mm})`); }
    await click(client, '[data-invoice-cancel]');
    ok(await warteAuf(() => statusVon('r5g-inv-G') === 'CANCELLED'), `CANCEL die Rechnung ist storniert (Hinweis: ${String(await fehlerAnzeige(client)).slice(0, 200) || 'keiner'})`);
    const cmds = await buchungen(client);
    const p = cmds[0]?.payload || {};
    ok(cmds.length === 1 && cmds[0].op === 'invoices.cancel' && S(Object.keys(p).sort()) === S(['expectedRevision', 'invoiceId', 'refundMethod']) && p.refundMethod === 'cash',
      `CANCEL genau EIN Storno-Auftrag — Rechnung, Fassung, Weg, sonst nichts (${cmds.map((x) => x.op).join(',')} · ${Object.keys(p).join(',')})`);
    ok(!cmds.some((x) => /^returns\.(create|approve|refund)$/.test(x.op)), 'CANCEL keine einzelne Freigabe oder Erstattung ueber den Fernweg');
    const r = retoureVon('r5g-inv-G')[0] || {};
    const cn = dbQ(BIZ_DB, 'SELECT cash_refund_amount, receivable_cancel_amount FROM credit_notes WHERE invoice_id = ?', ['r5g-inv-G'])[0] || {};
    ok(retoureVon('r5g-inv-G').length === 1 && Number(r.total_amount) === 220 && Number(r.refund_paid_amount) === 100 && r.refund_method === 'cash'
      && Number(cn.cash_refund_amount) === 100 && Number(cn.receivable_cancel_amount) === 120,
    `CANCEL Retoure zum Rechnungspreis, genau das Gezahlte (100) bar zurueck, der Rest storniert die Forderung (${S([r.total_amount, r.refund_paid_amount, cn])})`);
    ok(warenG('r5g-pG') === S([{ quantity: 1, stock_status: 'in_stock' }, { qty_remaining: 1, status: 'ACTIVE' }]) || /"quantity":1/.test(warenG('r5g-pG')),
      `CANCEL die Ware ist zurueck, ihr Los frei (${warenG('r5g-pG')})`);
    ok((await treffer(client)).length === 0, 'LOKAL kein Griff zur lokalen Datenbank');

    await gehZu(primary, '/invoices/r5g-inv-F', 'R5G-INV-F');
    { const mm = await stornoDialog(primary, 'Cash'); ok(mm === 'OK', `CANCEL-PARITAET derselbe Dialog am Primary (${mm})`); }
    await click(primary, '[data-invoice-cancel]');
    ok(await warteAuf(() => statusVon('r5g-inv-F') === 'CANCELLED'), 'CANCEL-PARITAET der Primary storniert');
    const rp = retoureVon('r5g-inv-F')[0] || {};
    const rpN = norm(mitNr(rp, 'R5G-INV-F'), STO_OHNE);
    const rN = norm(mitNr(r, 'R5G-INV-G'), STO_OHNE);
    ok(rpN === rN && /<INVOICE_NO>/.test(rN), `CANCEL-PARITAET Retoure samt Notiz (nur die Nummer normalisiert): Primary == PC2${rpN !== rN ? ` (${rpN} / ${rN})` : ''}`);
    // Die Notiz der Gutschrift nennt die Rechnungsnummer: NUR sie wird zu <INVOICE_NO>, der Rest muss gleich sein.
    const cnMitNr = (inv, nr) => gutschriftVon(inv).map((x) => S(mitNr(JSON.parse(x), nr)));
    ok(S(cnMitNr('r5g-inv-F', 'R5G-INV-F')) === S(cnMitNr('r5g-inv-G', 'R5G-INV-G')) && /<INVOICE_NO>/.test(S(cnMitNr('r5g-inv-G', 'R5G-INV-G')))
      && buchungVonGutschrift('r5g-inv-F') === buchungVonGutschrift('r5g-inv-G')
      && rechnungVon('r5g-inv-F') === rechnungVon('r5g-inv-G') && warenG('r5g-pF') === warenG('r5g-pG'),
    `CANCEL-PARITAET Gutschrift, Buchung, Rechnung, Bestand${rechnungVon('r5g-inv-F') !== rechnungVon('r5g-inv-G') ? ` (${rechnungVon('r5g-inv-F')} / ${rechnungVon('r5g-inv-G')})` : ''}`);
  }

  // ── Verlorene Antwort beim Storno ──
  {
    client = await lade(client, '/invoices/r5g-inv-H');
    { const mm = await stornoDialog(client, 'Cash'); ok(mm === 'OK', `VERLOREN-C der Dialog (${mm})`); }
    await client.ev('window.__killNext = true; return 1;');
    await click(client, '[data-invoice-cancel]');
    ok(await warteBis(client, "/not clear whether/i.test(document.body.innerText)", 30000), 'VERLOREN-C der Dialog meldet den offenen Ausgang');
    await click(client, '[data-invoice-cancel]');
    ok(await warteAuf(() => statusVon('r5g-inv-H') === 'CANCELLED'), 'VERLOREN-C der zweite Versuch derselben Absicht kommt durch');
    const c = (await kommandos(client)).filter((x) => x.op === 'invoices.cancel');
    ok(c.length === 2 && c[0].commandId === c[1].commandId && S(c[0].payload) === S(c[1].payload), `VERLOREN-C dieselbe Kennung, derselbe Rumpf (${c.length})`);
    ok(retoureVon('r5g-inv-H').length === 1 && dbQ(BIZ_DB, 'SELECT id FROM credit_notes WHERE invoice_id = ?', ['r5g-inv-H']).length === 1
      && Number(retoureVon('r5g-inv-H')[0].refund_paid_amount) === 100 && buchungVonGutschrift('r5g-inv-H') === buchungVonGutschrift('r5g-inv-G')
      && warenG('r5g-pH') === warenG('r5g-pG'),
    'VERLOREN-C genau EINE Retoure, EINE Gutschrift, EINMAL erstattet, EINMAL gebucht, EIN Bestandseffekt');
  }

  // ── Storno ohne Geld ──
  {
    client = await lade(client, '/invoices/r5g-inv-J');
    { const mm = await stornoDialog(client, null); ok(mm === 'OK', `CANCEL-0 der Dialog ohne Zahlung (${mm})`); }
    await click(client, '[data-invoice-cancel]');
    ok(await warteAuf(() => statusVon('r5g-inv-J') === 'CANCELLED'), 'CANCEL-0 storniert');
    ok(retoureVon('r5g-inv-J').length === 0 && /"quantity":1/.test(warenG('r5g-pJ')) && /in_stock/.test(warenG('r5g-pJ')),
      `CANCEL-0 keine Retoure — nur die Ware zurueck (${warenG('r5g-pJ')})`);
    await gehZu(primary, '/invoices/r5g-inv-I', 'R5G-INV-I');
    { const mm = await stornoDialog(primary, null); ok(mm === 'OK', `CANCEL-0-PARITAET derselbe Dialog am Primary (${mm})`); }
    await click(primary, '[data-invoice-cancel]');
    ok(await warteAuf(() => statusVon('r5g-inv-I') === 'CANCELLED'), 'CANCEL-0-PARITAET der Primary storniert');
    ok(rechnungVon('r5g-inv-I') === rechnungVon('r5g-inv-J') && warenG('r5g-pI') === warenG('r5g-pJ'), 'CANCEL-0-PARITAET Rechnung und Bestand: Primary == PC2');
  }

  // ══════════════════════════════════════════════════════════════════════
  // §7 ZWEI RETOUREN AUF DERSELBEN SEITE — der Mitarbeiter beginnt frisch
  // ══════════════════════════════════════════════════════════════════════
  const zweimal = async (c, inv, wer) => {
    { const mm = await retoureMaske(c, { methode: 'Cash', jetzt: false, staff: 'r5g-emp' }); ok(mm === 'OK', `STAFF ${wer}: Retoure A mit Mitarbeiter (${mm})`); }
    await click(c, '[data-return-save]');
    ok(await warteAuf(() => retoureVon(inv).length === 1), `STAFF ${wer}: Retoure A steht`);
    await sleep(1200);
    const b = await retoureOhneMitarbeiter(c);
    ok(b.m === 'OK' && b.staff === '', `STAFF ${wer}: „Create Return" beginnt wieder bei „Unassigned" (${b.m} · ${S(b.staff)})`);
    await click(c, '[data-return-save]');
    ok(await warteAuf(() => retoureVon(inv).length === 2), `STAFF ${wer}: Retoure B steht`);
    const st = dbQ(BIZ_DB, 'SELECT staff_id FROM sales_returns WHERE invoice_id = ? ORDER BY return_number', [inv]).map((x) => x.staff_id ?? null);
    ok(S(st) === S(['r5g-emp', null]), `STAFF ${wer}: die Datenbank zeigt A mit, B ohne Mitarbeiter (${S(st)})`);
  };
  client = await lade(client, '/invoices/r5g-inv-L');
  await zweimal(client, 'r5g-inv-L', 'PC2');
  await gehZu(primary, '/invoices/r5g-inv-K', 'R5G-INV-K');
  await zweimal(primary, 'r5g-inv-K', 'Primary');

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
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — central ui parity r5f.1: invoice cancel + return staff reset, two apps: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5F1_INVOICE_CANCEL_RUNTIME_PROVED');
console.log('CENTRAL_UI_R5F1_RETURN_STAFF_RESET_PROVED');
console.log('CENTRAL_UI_R5F_CANCEL_NOTE_PARITY_PROVED');
