// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-ADD-VARIANT-UI — Purchase → „Variant of existing", Primary und PC2, echte Maus/Tastatur.
// Run: node test/e2e/purchase-add-variant-ui.e2e.mjs
//   (nach `npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e-client.conf.json`,
//    Kopie nach lataif-e2e-client.exe, dann `… --config src-tauri/tauri.e2e.conf.json`)
//
//   1  Primary: Ausgangsartikel ohne Modell → Variante mit anderem Karat & Color; Vorbelegung, Steuerart leer, Bildwarnung;
//      gespeichert: eigene SKU, eigenes Los, Modell entsteht (Original + Variante).
//   2  PC2: zweite Variante desselben Ausgangsartikels → tritt dem Modell bei, EIN Auftrag purchases.create.
//   3  Anzeige: Variantenliste „Karat & Color", Modellkarte „16 · 18K WG ×1 | 17 · 18K YG ×1 | 18 · 18K YG ×1".
//   4  Collections: „Add variant" auch für einen Artikel ohne Modell.
//   6  Echtes Foto: New Item mit Foto + Existing-Zeile (unverändert); PC2 Edit Purchase → Add variant of existing → dasselbe Medium.
//   7  Kombinierte Suche „Cartier Love WG"; kompakte Detailzeile in New Purchase und Purchase Detail.
//   5  Je neuem Artikel ein Los; keine lokale Datenbank am PC2; keine Fehlermeldung.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat oder was am
// EXAKTEN Test-Pfad läuft. Ports 3011/9223/9224, Datenordner com.lataif.app.e2e(.client).
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { assertE2eClientBinary, e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, closeTestWindow, startedPids } from './_e2e-process.mjs';
import { maus, mausText, waehle, tippe } from './_e2e-mouse.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const OWNER_PW = 'pav-owner-' + Math.random().toString(36).slice(2);

const RUN = join(os.tmpdir(), 'lataif-purchvariant', 'run-' + Date.now());
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
  if (!window.__pvHaken) {
    window.__pvHaken = true; window.__cmds = []; window.__alerts = []; window.__dbHits = [];
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

// ══════════════════════════════════════════════════════════════════════════════
// Stammdaten: ein Lieferant, zwei Ausgangsartikel ohne Modell (Branded Gold Jewelry, Eigenware).
const CAT = 'cat-branded-gold-jewelry';
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
    insert(db, 'suppliers', { id: 'pv-sup', branch_id, name: 'PV Gold Dealer', active: 1, created_at: now, updated_at: now });
    const art = (id, sku, karat, size, name = 'Love Bracelet') => insert(db, 'products', {
      id, branch_id, category_id: CAT, brand: 'Cartier', name, sku, condition: 'New', scope_of_delivery: '["Box"]',
      purchase_price: 2500, purchase_currency: 'BHD', planned_sale_price: 3300, stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0,
      quantity: 1, images: '[]', attributes: JSON.stringify({ item_type: 'Bracelet', karat, size, model_number: 'B6067417' }), source_type: 'OWN',
      created_at: now, updated_at: now });
    art('pv-a', 'CAR-PV-A', '18K Yellow', '17');
    art('pv-c', 'CAR-PV-C', '18K Rose', '19', 'Juste un Clou');
  } finally { try { db.close(); } catch { /* zu */ } }
}
const zaehle = (t) => dbQ(BIZ_DB, `SELECT COUNT(*) AS n FROM ${t}`)[0]?.n;
const modelOf = (id) => dbQ(BIZ_DB, 'SELECT model_key AS k FROM product_models WHERE product_id = ?', [id])[0]?.k ?? null;
const neueArtikel = () => dbQ(BIZ_DB, "SELECT id, sku, attributes, tax_scheme, planned_sale_price, purchase_price FROM products WHERE id NOT IN ('pv-a', 'pv-c') AND id NOT LIKE 'bulk-%' ORDER BY created_at, rowid");
const setByLabelPrefix = (c, prefix, v) => c.ev(
  `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().startsWith(${S(prefix)})).pop();`
  + `if(!l) return 'NO-LABEL:'+${S(prefix)}; const e=l.parentElement.querySelector('input,textarea'); if(!e) return 'NO-INPUT';`
  + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)});`
  + `e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const setNth = (c, sel, nr, v) => c.ev(
  `const e=document.querySelectorAll(${S(sel)})[${nr}]; if(!e) return 'NO:'+${S(sel)}+'#'+${nr};`
  + `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function ssPick(c, placeholder, optionId) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warteBis(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  const r = await maus(c, `[data-ss-option=${S(optionId)}]`);
  await sleep(300);
  return r;
}
// Echtes Foto (übernommen aus r5e-order-purchase-parity): ein kleines PNG, über das Dateifeld gewählt.
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
  // Seit f1ae493e (v0.8.87) trägt ImageUpload ein zweites, verstecktes Feld zum ERSETZEN eines Platzes (ohne `multiple`,
  // es steht zuletzt): ein Foto dort ohne gewählten Platz wird verworfen. Hinzufügen geht über das Feld mit `multiple`.
  const hinzu = await c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][accept="image/*"][multiple]' });
  const { nodeIds } = hinzu.nodeIds?.length ? hinzu : await c.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"][accept="image/*"]' });
  if (!nodeIds || nodeIds.length === 0) return 'KEIN-FELD';
  await c.send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[nodeIds.length - 1] });
  return 'OK';
}

const PHOTO = join(RUN, 'pv-photo.png');
const JPEGS = "[...document.querySelectorAll('img')].filter(i=>/^data:image\\/jpeg/.test(i.src)).length";
const c2price = (c) => c.ev(`const l=[...document.querySelectorAll('[data-purchase-edit-add-price]')]; const e=l[l.length-1]; if(!e) return 'KEIN-PREISFELD'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'2500'); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
// Collections-Maske (übernommen aus article-variants-ui): Element per JS finden, mit der echten Maus/Tastatur bedienen.
async function mausAuf(c, findeJs, name) {
  const da = await c.ev(`document.querySelectorAll('[data-e2e-ziel]').forEach(x=>x.removeAttribute('data-e2e-ziel')); const e=(()=>{ ${findeJs} })(); if(!e) return false; e.setAttribute('data-e2e-ziel','1'); return true;`);
  if (!da) return 'FEHLT:' + name;
  return maus(c, '[data-e2e-ziel]');
}
const chipIn = (box, text) => `const b=document.querySelector(${S(box)}); return b ? [...b.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}) : null;`;
async function tippeIn(c, findeJs, wert, name) {
  const da = await c.ev(`document.querySelectorAll('[data-e2e-feld]').forEach(x=>x.removeAttribute('data-e2e-feld')); const e=(()=>{ ${findeJs} })(); if(!e) return false; e.setAttribute('data-e2e-feld','1'); return true;`);
  if (!da) return 'FEHLT:' + name;
  return tippe(c, '[data-e2e-feld]', wert);
}
const maskenBilder = (c) => c.ev(`return [...document.querySelectorAll('img')].filter(i=>/^data:image/.test(i.src||'')).length;`);
async function setFile(c, path) {
  const vorher = await maskenBilder(c);
  for (let versuch = 0; versuch < 2; versuch++) {
    const r = await c.send('Runtime.evaluate', { expression: `document.querySelector('input[type=file][accept="image/*"]')`, returnByValue: false });
    if (!r.result?.objectId) return 'KEIN-DATEIFELD';
    await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [path] });
    const end = Date.now() + 15000;
    while (Date.now() < end) { if ((await maskenBilder(c)) > vorher) return 'OK'; await sleep(400); }
    await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [] });
    await sleep(500);
  }
  return 'FOTO-NICHT-UEBERNOMMEN';
}
/** Purchase → „Variant of existing" → Ausgangsartikel → Maske: Karat & Color, Größe, Gewicht, Verkaufspreis, Steuerart. */
async function varianteImEinkauf(c, idx, anchorId, { karat, size, weight, sale, tax, price }) {
  const r = [];
  r.push(await waehle(c, `[data-line-source="${idx}"]`, 'variant'));
  r.push((await warteBis(c, q('[data-variant-picker]'), 10000)) ? 'OK' : 'KEIN-PICKER');
  r.push(await ssPick(c, 'Search collection...', anchorId));
  r.push((await warteBis(c, q('[data-variant-hint]'), 10000)) ? 'OK' : 'KEINE-MASKE');
  const vorbelegt = await c.ev(`return JSON.stringify({ brand: [...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith('BRAND'))?.parentElement.querySelector('input')?.value,
    karat: (document.querySelector('[data-variant-karat-confirm] b')?.textContent || ''), tax: [...document.querySelectorAll('[data-variant-tax]')].some(b=>getComputedStyle(b).color==='rgb(15, 15, 16)') });`);
  if (karat) r.push(await mausText(c, karat));
  r.push(await setByLabelPrefix(c, 'SIZE', size));
  r.push(await setByLabelPrefix(c, 'WEIGHT', weight));
  r.push(await setByLabelPrefix(c, 'SALE PRICE', sale));
  r.push(await maus(c, `[data-variant-tax="${tax}"]`));
  r.push(await maus(c, '[data-variant-karat-confirm] input'));
  await sleep(300);
  r.push(await mausText(c, 'Use this Item'));
  const trotzdem = "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Create anyway')";
  if (await warteBis(c, trotzdem, 2000)) r.push(await mausText(c, 'Create anyway'));
  r.push((await warteBis(c, q(`[data-line-variant="${idx}"]`), 10000)) ? 'OK' : 'KEINE-VARIANTENZEILE');
  r.push(await setNth(c, 'input[type="number"][min="0"][step="0.001"]', idx, String(price)));
  return { r: alleOk(r), vorbelegt: JSON.parse(vorbelegt) };
}
async function speichern(c) {
  const vor = zaehle('purchases');
  const r = await maus(c, '[data-purchase-save]');
  await spuelen(primary).catch(() => null);
  const gut = await warteAuf(() => zaehle('purchases') === vor + 1, 30000);
  if (!gut) console.log('      Fehler: ' + await c.ev("return (document.body.innerText.match(/Line \\d[^\\n]*|could not[^\\n]*|choose[^\\n]*/i)||[''])[0];"));
  return r === 'OK' && gut ? 'OK' : r + (gut ? '' : ' | NICHT-GESPEICHERT');
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
    await setVal(primary, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'PV Co');
    await setVal(primary, 'input[placeholder="e.g. Main Store"]', 'PV Branch');
    await clickText(primary, 'Next'); await waitFor(primary, 'input[placeholder="Full name"]');
    await setVal(primary, 'input[placeholder="Full name"]', 'PV Admin');
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

  ok(zaehle('products') >= 2 && zaehle('product_models') === 0, 'SETUP zwei Ausgangsartikel ohne Modell, kein Modell');
  const vorher = { ledger: zaehle('ledger_entries') };

  // ── 1 Primary: Purchase → Variant of existing (Ausgangsartikel ohne Modell), anderes Karat & Color ──
  {
    await gehFrisch(primary, '/purchases/new');
    await warteBis(primary, q('[data-purchase-save]'), 45000);
    const s = await ssPick(primary, 'Search suppliers...', 'pv-sup');
    const v = await varianteImEinkauf(primary, 0, 'pv-a', { karat: '18K White', size: '16', weight: '36.5', sale: '3400', tax: 'MARGIN', price: '2600' });
    ok(s === 'OK' && v.r === 'OK', `1 PRIMARY echte Maus/Tastatur: Lieferant, „Variant of existing", Ausgangsartikel, Maske ausgefüllt (${s} / ${v.r})`);
    ok(v.vorbelegt.brand === 'Cartier' && /18K Yellow/.test(v.vorbelegt.karat) && v.vorbelegt.tax === false,
      `1 Vorbelegung: Marke übernommen, Karat & Color als Vorschlag (18K Yellow), Steuerart NICHT vorbelegt (${S(v.vorbelegt)})`);
    const foto = await primary.ev(`return JSON.stringify({ an: ${q('[data-line-variant-photo="0"]')}?.checked, warn: !!${q('[data-line-variant-photo-warning="0"]')} });`);
    ok(S(JSON.parse(foto)) === S({ an: false, warn: true }), `1 anderes Karat & Color: Bildübernahme aus, Warnung sichtbar (${foto})`);
    const sp = await speichern(primary);
    const neu = neueArtikel();
    const a = neu[0] ? JSON.parse(neu[0].attributes) : {};
    ok(sp === 'OK' && neu.length === 1 && a.karat === '18K White' && a.size === '16' && neu[0].tax_scheme === 'MARGIN' && Number(neu[0].planned_sale_price) === 3400
      && Number(neu[0].purchase_price) === 2600 && !!neu[0].sku && neu[0].sku !== 'CAR-PV-A',
      `1 gespeichert: eigener Artikel mit eigener SKU, 18K White, Größe 16, Verkaufspreis, Einkaufspreis aus der Zeile (${sp}; ${S(neu.map((x) => x.sku))})`);
    const key = modelOf('pv-a');
    ok(!!key && modelOf(neu[0]?.id) === key && zaehle('product_models') === 2, '1 Modell beim Speichern neu angelegt: Original + Variante');
    ok(dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM stock_lots WHERE product_id = ?', [neu[0]?.id])[0]?.n === 1, '1 ein Los wie bei jedem Einkauf');
  }

  // ── 2 PC2: weitere Variante desselben Ausgangsartikels — tritt dem Modell bei ──
  {
    await gehFrisch(client, '/purchases/new');
    await warteBis(client, q('[data-purchase-save]'), 45000);
    const s = await ssPick(client, 'Search suppliers...', 'pv-sup');
    const v = await varianteImEinkauf(client, 0, 'pv-a', { karat: '', size: '18', weight: '37.1', sale: '3500', tax: 'VAT_10', price: '2700' });
    const foto = await client.ev(`return JSON.stringify({ an: ${q('[data-line-variant-photo="0"]')}?.checked, warn: !!${q('[data-line-variant-photo-warning="0"]')} });`);
    ok(S(JSON.parse(foto)) === S({ an: true, warn: false }), `2 PC2 gleiches Karat & Color: Bildübernahme vorgewählt, keine Warnung (${foto})`);
    // Das Original hat kein Foto (Testdaten) — die Übernahme abwählen, sonst würde der Primary sie zu Recht ablehnen.
    await maus(client, '[data-line-variant-photo="0"]');
    const sp = await speichern(client);
    const neu = neueArtikel();
    const n2 = neu[1];
    ok(s === 'OK' && v.r === 'OK' && sp === 'OK' && neu.length === 2 && JSON.parse(n2?.attributes || '{}').karat === '18K Yellow' && n2?.tax_scheme === 'VAT_10',
      `2 PC2 echte Maus/Tastatur: Variante gespeichert (${s} / ${v.r} / ${sp})`);
    ok(modelOf(n2?.id) === modelOf('pv-a') && zaehle('product_models') === 3, '2 PC2: tritt dem bestehenden Modell bei');
    const ops = (await befehle(client)).map((x) => x.op);
    ok(ops.includes('purchases.create') && !ops.includes('product_models.group') && !ops.includes('products.create'),
      `2 PC2: EIN Auftrag purchases.create — kein Nachschritt (${[...new Set(ops)].filter((o) => /purchase|product/.test(o)).join(',')})`);
  }

  // ── 3 Anzeige: Modellkarte nach Größe + Karat & Color, Tabelle, Suche nach Kurzform ──
  {
    await gehFrisch(primary, '/collection/pv-a');
    await warteBis(primary, q('[data-model-row-karat]'), 30000);
    const karat = await primary.ev("return JSON.stringify([...document.querySelectorAll('[data-model-row-karat]')].map(e=>e.textContent.trim()).sort());");
    ok(karat === S(['18K WG', '18K YG', '18K YG']), `3 Variantenliste zeigt „Karat & Color" (${karat})`);
    await gehFrisch(primary, '/collection');
    await warteBis(primary, q('[data-model-sizes]'), 30000);
    const chips = await primary.ev("return [...document.querySelectorAll('[data-model-sizes] span')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()).join(' | ');");
    ok(/16 · 18K WG ×1/.test(chips) && /17 · 18K YG ×1/.test(chips) && /18 · 18K YG ×1/.test(chips), `3 Modellkarte: 16 · 18K WG ×1 | 17 · 18K YG ×1 | 18 · 18K YG ×1 (${chips})`);
    const such = await primary.ev(`const i=[...document.querySelectorAll('input')].find(x=>/search/i.test(x.placeholder||'')); if(!i) return 'KEIN-SUCHFELD'; return 'OK';`);
    ok(such === 'OK', '3 Suchfeld vorhanden');
  }

  // ── 4 Collections: Add variant für einen Artikel OHNE Modell ──
  {
    await gehFrisch(primary, '/collection/pv-c');
    const da = await warteBis(primary, q('[data-model-section="none"] [data-model-add-variant]'), 30000);
    const r = da ? await maus(primary, '[data-model-section="none"] [data-model-add-variant]') : 'KEIN-KNOPF';
    const offen = await warteBis(primary, "/not part of a model yet/.test(document.body.innerText)", 20000);
    ok(r === 'OK' && offen && (await exists(primary, '[data-variant-karat-confirm]')),
      `4 Collections: „Add variant" auch ohne Modell — Maske mit Hinweis „creates the model" und Karat-Bestätigung (${r})`);
  }


  // ── 6 Echtes Foto ─────────────────────────────────────────────────────────────────────────────────────────────
  //   6a Collections → New Item mit echtem Foto (Bildspeicher) = das Foto-Original.
  //   6b New Purchase: New Item MIT Foto + Existing-Zeile, wie bisher; Detailzeile. Ein Einkaufs-Neuartikel trägt sein Foto
  //      im alten Format (products.images) — eine Variante davon bietet die Bildübernahme ehrlich NICHT an.
  //   6c PC2 Edit Purchase → Add variant of existing (Foto-Original aus 6a): dasselbe Medium, keine neue Datei.
  {
    writePhoto(PHOTO, 120);
    const t = [];
    await gehFrisch(primary, '/collection');
    t.push(await mausText(primary, 'New Item'));
    t.push((await warteBis(primary, q('#new-field-categoryId'), 20000)) ? 'OK' : 'KEINE-MASKE');
    t.push(await mausAuf(primary, chipIn('#new-field-categoryId', 'Branded Gold Jewelry'), 'Kategorie')); await sleep(500);
    t.push(await mausAuf(primary, chipIn('#new-field-attr_item_type', 'Bracelet'), 'Item type'));
    t.push(await tippeIn(primary, `return document.querySelector('#new-field-attr_size input');`, '15', 'Size'));
    t.push(await mausAuf(primary, chipIn('#new-field-attr_karat', '18K Rose'), 'Karat'));
    t.push(await setFile(primary, PHOTO));
    t.push(await tippeIn(primary, `return document.querySelector('#new-field-brand input');`, 'Cartier', 'Brand'));
    t.push(await tippeIn(primary, `return document.querySelector('#new-field-name input');`, 'Love Bracelet', 'Name'));
    await sleep(900);
    const anyway = "[...document.querySelectorAll('button')].some(x=>/create anyway/i.test(x.textContent||''))";
    if (!(await primary.ev(`return ${anyway};`))) t.push(await maus(primary, '[data-create-product]'));
    await sleep(1200);
    if (await primary.ev(`return ${anyway};`)) t.push(await mausAuf(primary, "return [...document.querySelectorAll('button')].filter(x=>/create anyway/i.test(x.textContent||'')).pop();", 'Create anyway'));
    t.push((await warteBis(primary, "!document.querySelector('#new-field-categoryId')", 40000)) ? 'OK' : 'MASKE-BLIEB-OFFEN');
    await spuelen(primary).catch(() => null);
    const fotoArtikel = dbQ(BIZ_DB, "SELECT id FROM products WHERE json_extract(attributes, '$.size') = '15' AND json_extract(attributes, '$.karat') = '18K Rose'")[0]?.id;
    await warteAuf(() => !!fotoArtikel && !!dbQ(BIZ_DB, "SELECT media_id AS m FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NULL", [fotoArtikel])[0], 20000);
    const medium = fotoArtikel ? dbQ(BIZ_DB, "SELECT media_id AS m FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1", [fotoArtikel])[0]?.m : null;
    ok(alleOk(t) === 'OK' && !!fotoArtikel && !!medium, `6a Collections → New Item mit echtem Foto (Bildspeicher) — New Stock wie bisher (${alleOk(t)})`);

    // 6b New Purchase: New Item mit Foto + Existing
    await gehFrisch(primary, '/purchases/new');
    await warteBis(primary, q('[data-purchase-save]'), 45000);
    const r = [await ssPick(primary, 'Search suppliers...', 'pv-sup')];
    r.push(await mausText(primary, '+ Define new item…')); await sleep(400);
    r.push((await warteBis(primary, "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Branded Gold Jewelry')", 15000)) ? 'OK' : 'KEINE-MASKE');
    r.push(await mausText(primary, 'Branded Gold Jewelry')); await sleep(400);
    r.push(await setByLabelPrefix(primary, 'BRAND', 'Cartier'));
    r.push(await setByLabelPrefix(primary, 'NAME / MODEL', 'Love Bracelet'));
    r.push(await mausText(primary, 'Bracelet'));
    r.push(await mausText(primary, '18K Rose'));
    r.push(await setByLabelPrefix(primary, 'SIZE', '14'));
    const vor = await primary.ev(`return ${JPEGS};`);
    r.push(await fotoWaehlen(primary, PHOTO));
    r.push((await warteBis(primary, `${JPEGS} > ${vor}`, 15000)) ? 'OK' : 'KEIN-VORSCHAUBILD');
    await sleep(300);
    r.push(await mausText(primary, 'Use this Item'));
    const trotzdem = "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Create anyway')";
    if (await warteBis(primary, trotzdem, 2500)) r.push(await mausText(primary, 'Create anyway'));
    r.push(await setNth(primary, 'input[type="number"][min="0"][step="0.001"]', 0, '2400'));
    r.push(await mausText(primary, 'Add Item')); await sleep(300);
    r.push(await waehle(primary, '[data-line-source="1"]', 'existing')); await sleep(300);
    r.push(await ssPick(primary, 'Pick product...', 'pv-c'));
    r.push(await setNth(primary, 'input[type="number"][min="0"][step="0.001"]', 1, '1500'));
    const detail = await primary.ev("return JSON.stringify([...document.querySelectorAll('[data-purchase-line-detail]')].map(e=>e.textContent.trim()));");
    r.push(await speichern(primary));
    const pid = dbQ(BIZ_DB, 'SELECT id FROM purchases ORDER BY created_at DESC, rowid DESC LIMIT 1')[0]?.id;
    const einkaufsArtikel = dbQ(BIZ_DB, "SELECT id, images FROM products WHERE json_extract(attributes, '$.size') = '14'")[0];
    ok(alleOk(r) === 'OK' && !!einkaufsArtikel && dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM purchase_lines WHERE purchase_id = ? AND product_id = 'pv-c'", [pid])[0]?.n === 1,
      `6b PRIMARY New Item mit Foto + Existing-Zeile wie bisher gespeichert (${alleOk(r)})`);
    ok(/Bracelet · 14 · 18K Rose/.test(detail) && /Bracelet · 19 · 18K Rose/.test(detail), `6b Detailzeile unter dem Artikelnamen: New Item und Existing (${detail})`);

    // 6c PC2: Edit Purchase → Add variant of existing
    await spuelen(primary).catch(() => null);
        await gehFrisch(client, `/purchases/${pid}/edit`);
    await warteBis(client, q('[data-purchase-edit-add-variant]'), 45000);
    const e = [await maus(client, '[data-purchase-edit-add-variant]')];
    e.push((await warteBis(client, q('[data-variant-picker]'), 10000)) ? 'OK' : 'KEIN-PICKER');
    e.push(await ssPick(client, 'Search collection...', fotoArtikel));
    e.push((await warteBis(client, q('[data-variant-hint]'), 10000)) ? 'OK' : 'KEINE-MASKE');
    e.push(await setByLabelPrefix(client, 'SIZE', '20'));
    e.push(await setByLabelPrefix(client, 'SALE PRICE', '3100'));
    e.push(await maus(client, '[data-variant-tax="MARGIN"]'));
    e.push(await maus(client, '[data-variant-karat-confirm] input'));
    e.push(await mausText(client, 'Use this Item'));
    if (await warteBis(client, trotzdem, 2500)) e.push(await mausText(client, 'Create anyway'));
    e.push((await warteBis(client, '[...document.querySelectorAll("[data-line-variant-photo]")].some(x=>x.checked)', 10000)) ? 'OK' : 'BILD-NICHT-VORGEWAEHLT');
    e.push(await c2price(client));
    e.push(await tippe(client, '[data-purchase-edit-reason]', 'forgot the second piece'));
    await sleep(300);
    const vorAnzahl = zaehle('products');
    e.push(await maus(client, '[data-purchase-edit-save]'));
    await spuelen(primary).catch(() => null);
    const gespeichert = await warteAuf(() => zaehle('products') === vorAnzahl + 1, 30000);
    if (!gespeichert) console.log('      Edit: ' + await client.ev("return (document.body.innerText.match(/could not[^\\n]*|New line[^\\n]*|locked[^\\n]*|Only the owner[^\\n]*|Nothing was[^\\n]*/i)||[''])[0];"));
    const neu = dbQ(BIZ_DB, "SELECT id FROM products WHERE json_extract(attributes, '$.size') = '20'")[0]?.id;
    const neuMedium = neu ? dbQ(BIZ_DB, "SELECT media_id AS m FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1", [neu])[0]?.m : null;
    ok(alleOk(e) === 'OK' && gespeichert && !!neu && !!modelOf(neu) && modelOf(neu) === modelOf(fotoArtikel)
      && dbQ(BIZ_DB, 'SELECT COUNT(*) AS n FROM purchase_lines WHERE purchase_id = ? AND product_id = ?', [pid, neu])[0]?.n === 1,
      `6c PC2 Edit Purchase → „Add variant of existing": Zeile DIESES Einkaufs, Modell mit dem Foto-Original (${alleOk(e)})`);
    // Keine neue Datei FÜR DIE VARIANTE: alle ihre Bildverweise zeigen auf Medien, die es vor der Bearbeitung schon gab.
    const eigene = neu ? dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM media_links l JOIN media_objects o ON o.media_id = l.media_id WHERE l.entity_type = 'product' AND l.entity_id = ? AND l.deleted_at IS NULL AND l.media_id != ?", [neu, medium])[0]?.n : -1;
    ok(!!neuMedium && neuMedium === medium && eigene === 0,
      `6c echtes Foto übernommen: dasselbe Medium wie das Original (${neuMedium === medium}), kein eigenes neues Medium (${eigene})`);
  }

  // ── 7 Kombinierte Suche „Cartier Love WG" und Detailzeile in Purchase Detail ──
  {
    await gehFrisch(primary, '/collection');
    await warteBis(primary, q('[data-model-sizes]'), 30000);
    const feld = await primary.ev("const i=[...document.querySelectorAll('input')].find(x=>/search/i.test(x.placeholder||'')); if(!i) return ''; i.setAttribute('data-e2e-suche','1'); return 'OK';");
    const r = feld === 'OK' ? await tippe(primary, '[data-e2e-suche]', 'Cartier Love WG') : 'KEIN-SUCHFELD';
    await sleep(1200);
    const text = await primary.ev('return document.body.innerText;');
    ok(r === 'OK' && /16 · 18K WG/.test(text) && !/Juste un Clou/.test(text), `7 Collections: „Cartier Love WG" findet das Weißgold-Stück, nicht den anderen Artikel (${r})`);
    const pid = dbQ(BIZ_DB, "SELECT purchase_id AS p FROM purchase_lines WHERE product_id = (SELECT id FROM products WHERE json_extract(attributes, '$.size') = '16' AND id NOT IN ('pv-a','pv-c'))")[0]?.p;
    await gehFrisch(primary, `/purchases/${pid}`);
    await warteBis(primary, q('[data-purchase-line-detail]'), 20000);
    const d = await primary.ev("return [...document.querySelectorAll('[data-purchase-line-detail]')].map(e=>e.textContent.trim()).join(' | ');");
    ok(/Bracelet · 16 · 18K White · 36\.50 g/.test(d), `7 Purchase Detail: kompakte Zeile unter dem Artikelnamen (${d})`);
  }

  // ── 5 Nichts doppelt gebucht; New Stock unverändert ──
  {
    const lotsNeu = dbQ(BIZ_DB, "SELECT COUNT(*) AS n FROM stock_lots WHERE product_id NOT IN ('pv-a','pv-c')")[0]?.n;
    ok(lotsNeu === 4 && zaehle('purchases') === 3, `5 je neuem Artikel genau ein Los (2 Varianten, New Item, nachgetragene Variante), drei Einkäufe (${lotsNeu})`);
    ok(zaehle('ledger_entries') > vorher.ledger, '5 Einkaufsbuchungen wie üblich vorhanden');
    ok((await client.ev('return window.__dbHits.length;')) === 0, '5 PC2 greift auf keine lokale Datenbank zu');
    const alerts = [...JSON.parse(await primary.ev('return JSON.stringify(window.__alerts);')), ...JSON.parse(await client.ev('return JSON.stringify(window.__alerts);'))];
    ok(alerts.length === 0, `5 keine Browser-Meldung (${S(alerts)})`);
  }
} catch (e) {
  FAIL++; fails.push('harness: ' + (e?.message ?? e)); console.error(e);
} finally {
  clearTimeout(WACHHUND);
  try { primary?.close(); client?.close(); } catch { /* zu */ }
  aufraeumen();
  await waitTestImageGone('lataif.exe').catch(() => null); await waitTestImageGone('lataif-e2e-client.exe').catch(() => null);
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* bleibt */ }
  console.log(`\nPURCHASE-ADD-VARIANT UI: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
}
