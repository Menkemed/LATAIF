// ARTIKELVARIANTEN (Owner 23.11.2026, Lösung E) — Abnahme in der ECHTEN isolierten E2E-App (com.lataif.app.e2e, Port 3011),
// mit echter Maus und Tastatur über CDP (Klick nur auf sichtbare, unverdeckte Elemente).
// Run: node test/e2e/article-variants-ui.e2e.mjs   (aus dem Repo, nach `npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json`
//      und `cargo build --manifest-path src-tauri/Cargo.toml --features e2e --examples`)
//
//   A  New Item (unverändert): drei „Cartier Love Bracelet" (16/17/17) mit je eigenem Foto über die echte Maske
//   B  Group items: Auswahl, Vorschau, Speichern — nur product_models + Audit, keine Artikelzeile geändert
//   C  Collection: eine Modellkarte mit 16 ×1 / 17 ×2; „Single items" zeigt drei Karten
//   D  Item Detail: Modell-Abschnitt mit drei Varianten, Zeilenklick öffnet die Variante
//   E  Merge photos: gemeinsames Bild, keine neue Datei; Undo stellt alles her
//   F  Add variant: New-Item-Maske vorbefüllt, Steuerart Pflicht (keine Margin-Vorgabe), Modellbild wiederverwendet, ohne neue Datei
//   G  Edit group: entfernen, Gruppierung aufheben — Artikel bleiben
//   H  New Item ohne Modell: unverändert (Margin vorbelegt, keine Zuordnung)
// Gerüst aus final-date-correction-ui.e2e.mjs. Produktion (com.lataif.app, 3001/3443) bleibt unberührt.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killTestImage, spawnTracked, testProcesses } from './_e2e-process.mjs';
import { maus, mausText, tippe } from './_e2e-mouse.mjs';

const REPO = process.cwd();
const APP = join(REPO, 'src-tauri/target/debug/lataif.exe');
const SEED = join(REPO, 'src-tauri/target/debug/examples/e2e_scope_seed.exe');
const IDENT = 'com.lataif.app.e2e';
const CDP_PORT = 9223, PORT = 3011;
const OWNER_EMAIL = 'admin@lataif.com', ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'e2e-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const RUN = join(os.tmpdir(), 'lataif-variants-e2e', 'run-' + Date.now());
const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = join(REAL_APPDATA, IDENT);
const WV2_DIR = join(REAL_LOCALAPPDATA, IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const PROD_LOCATOR = join(REAL_APPDATA, 'com.lataif.app', 'data-location.json');
function prodDataDb() {
  try { const r = JSON.parse(readFileSync(PROD_LOCATOR, 'utf8')); return r.path || r.root || r.dataRoot ? join(String(r.path || r.root || r.dataRoot), 'lataif.db') : null; }
  catch { return null; }
}

let PASS = 0, FAIL = 0; const fails = []; const MSG = [];
const ok = (c, m) => { if (c) { PASS++; console.log('  ✓ ' + m); } else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });
const seedTool = (mode, arg) => execFileSync(SEED, [mode, arg ?? SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' }).trim();

function dbQ(sql, params = [], file = BIZ_DB) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
const one = (sql, p = []) => dbQ(sql, p)[0] || {};
const zahl = (sql, p = []) => Number(Object.values(one(sql, p))[0] ?? 0);

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Page.javascriptDialogOpening') {
        MSG.push(`${m.params.type}: ${m.params.message}`);
        this.ws.send(JSON.stringify({ id: ++this.id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      }
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

async function startApp() {
  e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() });
  spawnTracked(APP, [], { env: appEnv(), stdio: 'ignore' });
  const end = Date.now() + 60000; let page = null;
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl); if (page) break; } catch { /* noch nicht */ }
    await sleep(400);
  }
  if (!page) throw new Error('app CDP page did not come up');
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('DOM.enable');
  return c;
}
function stopApp() { try { killTestImage('lataif.exe'); } catch { /* weg */ } }
async function waitGoneAndFree() {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    let n = 0;
    try { n = parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${PORT} -EA SilentlyContinue).Count`], { encoding: 'utf8' }).trim() || '0', 10); } catch { n = 0; }
    if (!n && testProcesses('lataif.exe').length === 0) return true;
    await sleep(500);
  }
  return false;
}
async function waitInvoke(c) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { if (await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);')) return; await sleep(400); }
  throw new Error('no invoke');
}
const q = (sel) => `document.querySelector(${S(sel)})`;
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${S(t)}).pop(); if(!b) return 'NO:'+${S(t)}; b.click(); return 'OK';`);
async function warteBis(c, ausdruck, t = 30000) { const end = Date.now() + t; while (Date.now() < end) { if (await c.ev(`return !!(${ausdruck});`)) return true; await sleep(350); } return false; }
async function warteAuf(pruefe, t = 20000) { const end = Date.now() + t; while (Date.now() < end) { if (pruefe()) return true; await sleep(400); } return pruefe(); }
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1400); }
const pageText = (c) => c.ev('return document.body.innerText;');
const alleOk = (r) => { const b = r.filter((x) => x !== 'OK'); return b.length ? 'FEHLER:' + b.join(',') : 'OK'; };

/** Markiert das Element, das ein JS-Ausdruck findet, und klickt es mit der echten Maus. */
async function mausAuf(c, findeJs, name) {
  const da = await c.ev(`document.querySelectorAll('[data-e2e-ziel]').forEach(x=>x.removeAttribute('data-e2e-ziel')); const e=(()=>{ ${findeJs} })(); if(!e) return false; e.setAttribute('data-e2e-ziel','1'); return true;`);
  if (!da) return 'FEHLT:' + name;
  return maus(c, '[data-e2e-ziel]');
}
const chipIn = (box, text) => `const b=document.querySelector(${S(box)}); return b ? [...b.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(text)}) : null;`;
/** Tippt mit der echten Tastatur in das Eingabefeld unter einem Feld-Kasten / einer Beschriftung. */
async function tippeIn(c, findeJs, wert, name) {
  const da = await c.ev(`document.querySelectorAll('[data-e2e-feld]').forEach(x=>x.removeAttribute('data-e2e-feld')); const e=(()=>{ ${findeJs} })(); if(!e) return false; e.setAttribute('data-e2e-feld','1'); return true;`);
  if (!da) return 'FEHLT:' + name;
  return tippe(c, '[data-e2e-feld]', wert);
}
const inputUnterLabel = (label) => `const l=[...document.querySelectorAll('label')].filter(x=>x.textContent.trim().replace(/\\*$/,'').trim()===${S(label)}).pop(); return l ? l.parentElement.querySelector('input,textarea') : null;`;

// ── Anmelden ───────────────────────────────────────────────────────────────
async function waitFor(c, sel, t = 45000) { const end = Date.now() + t; while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); } throw new Error('waitFor ' + sel); }
async function frontendLogin(c) {
  await waitFor(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'E2E Co');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'E2E Branch');
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'E2E Admin');
    await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  } else {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev("[...document.querySelectorAll('button')].find(b=>/sign in/i.test(b.textContent))?.click(); return 1;");
  }
  await waitFor(c, 'a[href="/settings"]', 30000);
}
async function ensureSignedIn(c) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    if (await exists(c, 'a[href="/settings"]')) return true;
    if (await exists(c, 'input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]')) { try { await frontendLogin(c); return true; } catch { await sleep(1000); } }
    await sleep(400);
  }
  throw new Error('app shell never appeared');
}

// ── Testbilder: echte, verschiedene PNG-Dateien ─────────────────────────────
function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function pngFile(name, rgb) {
  const w = 64, h = 48; const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const ring = Math.abs(Math.hypot(x - 32, (y - 24) * 1.3) - 16) < 4; raw[o] = ring ? 200 : rgb[0]; raw[o + 1] = ring ? 160 : rgb[1]; raw[o + 2] = ring ? 60 : rgb[2]; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const p = join(RUN, name); writeFileSync(p, png); return p;
}
const PHOTO_INPUT = 'input[type=file][accept="image/*"]';
// Das ERSTE Dateifeld der Maske fügt hinzu (das zweite ersetzt ein Bild). Gezählt werden die Daten-URL-Vorschauen der Maske.
const maskenBilder = (c) => c.ev(`return [...document.querySelectorAll('img')].filter(i=>/^data:image/.test(i.src||'')).length;`);
async function setFile(c, path) {
  const vorher = await maskenBilder(c);
  for (let versuch = 0; versuch < 2; versuch++) {
    const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${S(PHOTO_INPUT)})`, returnByValue: false });
    if (!r.result?.objectId) return 'KEIN-DATEIFELD';
    await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [path] });
    const end = Date.now() + 15000;
    while (Date.now() < end) { if ((await maskenBilder(c)) > vorher) return 'OK'; await sleep(400); }
    await c.send('DOM.setFileInputFiles', { objectId: r.result.objectId, files: [] });
    await sleep(500);
  }
  return 'FOTO-NICHT-UEBERNOMMEN';
}

// ── Datenblick ─────────────────────────────────────────────────────────────
const PRODUCT_FIELDS = 'id, sku, brand, name, category_id, attributes, purchase_price, planned_sale_price, min_sale_price, stock_status, tax_scheme, source_type, quantity, images';
const produkte = () => dbQ(`SELECT ${PRODUCT_FIELDS} FROM products WHERE brand = 'Cartier' ORDER BY created_at`);
const modelle = () => dbQ('SELECT product_id, model_key FROM product_models ORDER BY product_id');
const hauptbild = (pid) => one(`SELECT media_id FROM media_links WHERE entity_type='product' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, [pid]).media_id || null;
const galerie = (pid) => dbQ(`SELECT media_id FROM media_links WHERE entity_type='product' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order`, [pid]).map((r) => r.media_id);
const dateien = () => zahl('SELECT COUNT(*) AS n FROM media_blob_generations');
// Bilddateien auf der Platte: alles unter einem Ordner `media` im Datenbereich der E2E-App (wo immer der Datenort liegt).
const medienDateienAufPlatte = () => {
  let n = 0;
  const walk = (d, inMedia) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), inMedia || e.name === 'media');
      else if (inMedia && /\.(jpe?g|png|webp)$/i.test(e.name)) n++;
    }
  };
  walk(APP_DATA_DIR, false);
  return n;
};

async function neuerArtikel(c, { size, weight, sale, photo, expectDuplicate }) {
  const r = [];
  r.push(await mausText(c, 'New Item'));
  if (!(await warteBis(c, q('#new-field-categoryId'), 20000))) return 'KEINE-MASKE';
  r.push(await mausAuf(c, chipIn('#new-field-categoryId', 'Branded Gold Jewelry'), 'Kategorie'));
  await sleep(500);
  // Erst alles außer Marke/Name: die Live-Duplikatprüfung startet erst mit Marke oder Name (sie würde sonst beim
  // Tippen der weiteren Felder die Maske überdecken — beim zweiten Stück desselben Modells ist sie erwartet).
  r.push(await mausAuf(c, chipIn('#new-field-attr_item_type', 'Bracelet'), 'Item type'));
  r.push(await tippeIn(c, `return document.querySelector('#new-field-attr_size input');`, size, 'Size'));
  r.push(await mausAuf(c, chipIn('#new-field-attr_karat', '18K Yellow'), 'Karat'));
  r.push(await tippeIn(c, `return document.querySelector('#new-field-attr_weight input');`, weight, 'Weight'));
  if (photo) r.push(await setFile(c, photo));
  r.push(await tippeIn(c, inputUnterLabel('SALE PRICE (BHD)'), sale, 'Sale'));
  r.push(await tippeIn(c, `return document.querySelector('#new-field-brand input');`, 'Cartier', 'Brand'));
  r.push(await tippeIn(c, `return document.querySelector('#new-field-name input');`, 'Love Bracelet', 'Name'));
  if (!(await c.ev(`return [...document.querySelectorAll('button')].some(x=>/create anyway/i.test(x.textContent||''));`))) {
    r.push(await maus(c, '[data-create-product]'));
  }
  await sleep(1200);
  if (await c.ev(`return [...document.querySelectorAll('button')].some(x=>/create anyway/i.test(x.textContent||''));`)) {
    if (!expectDuplicate) MSG.push('Duplikatwarnung bei ' + size);
    r.push(await mausAuf(c, `return [...document.querySelectorAll('button')].filter(x=>/create anyway/i.test(x.textContent||'')).pop();`, 'Create anyway'));
  }
  const zu = await warteBis(c, `!document.querySelector('#new-field-categoryId')`, 40000);
  r.push(zu ? 'OK' : 'MASKE-BLIEB-OFFEN');
  return alleOk(r);
}

// ═════════════════════════════════════════════════════════════════════════
console.log('ARTIKELVARIANTEN — UI-Abnahme in der isolierten E2E-App\n');
const prodMtime = (f) => (f && existsSync(f) ? statSync(f).mtimeMs : 0);
const PROD_DB_FILE = prodDataDb();
const PROD_BEFORE = { data: prodMtime(PROD_DB_FILE), appdata: prodMtime(PROD_LOCATOR) };
let c;
try {
  stopApp(); await waitGoneAndFree();
  rmSync(APP_DATA_DIR, { recursive: true, force: true }); rmSync(WV2_DIR, { recursive: true, force: true });
  mkdirSync(APP_DATA_DIR, { recursive: true }); mkdirSync(join(RUN, 'tmp'), { recursive: true });
  const FOTO = [pngFile('a.png', [240, 236, 228]), pngFile('b.png', [222, 232, 242]), pngFile('c.png', [236, 242, 226])];
  ok(seedTool('seed-primary') === 'SEED_PRIMARY_OK', 'SETUP isolierter Server als Primary (Owner = ADMIN)');
  c = await startApp(); await waitInvoke(c); await ensureSignedIn(c);
  ok(true, 'SETUP erste Anmeldung/Onboarding in der E2E-App');
  await c.ev('window.confirm = async () => true; return 1;');
  await gehFrisch(c, '/collection');

  // A — drei Artikel über „New Item" (unverändert), je mit eigenem Foto
  const a1 = await neuerArtikel(c, { size: '16', weight: '30.12', sale: '3150', photo: FOTO[0] });
  const a2 = await neuerArtikel(c, { size: '17', weight: '31.40', sale: '3250', photo: FOTO[1], expectDuplicate: true });
  const a3 = await neuerArtikel(c, { size: '17', weight: '31.28', sale: '3250', photo: FOTO[2], expectDuplicate: true });
  await warteAuf(() => produkte().length === 3 && produkte().every((p) => hauptbild(p.id)), 30000);
  const P = produkte();
  ok(P.length === 3 && P.every((p) => p.tax_scheme === 'MARGIN' && /^CAR-BGJ-\d+/.test(String(p.sku)) && Number(p.quantity) === 1),
    `A1 New Item unverändert: drei Artikel, SKU vergeben, Margin vorbelegt, Menge 1 (${a1}/${a2}/${a3}; ${S(P.map((p) => [p.sku, p.tax_scheme]))})`);
  ok(new Set(P.map((p) => hauptbild(p.id))).size === 3, 'A2 jeder Artikel hat sein eigenes Foto');
  const [p1, p2, p3] = P.map((p) => p.id);
  const vorher = S(produkte());
  const changelogVorher = zahl("SELECT COUNT(*) AS n FROM sync_changelog WHERE table_name = 'products'");

  // B — Group items
  {
    const r = [await maus(c, '[data-open-group-items]')];
    r.push((await warteBis(c, q('[data-group-items-modal]'), 10000)) ? 'OK' : 'KEIN-DIALOG');
    for (const id of [p1, p2, p3]) r.push(await maus(c, `[data-group-check="${id}"]`));
    r.push(await maus(c, '[data-group-preview]'));
    r.push((await warteBis(c, q('[data-group-save]'), 8000)) ? 'OK' : 'KEINE-VORSCHAU');
    const vorschau = await pageText(c);
    r.push(await maus(c, '[data-group-save]'));
    ok(await warteAuf(() => modelle().length === 3, 15000), `B1 Group items mit echter Maus: drei Zuordnungen (${alleOk(r)})`);
    ok(/Only the model assignment is saved/.test(vorschau), 'B2 die Vorschau sagt, dass nur die Zuordnung gespeichert wird');
    ok(new Set(modelle().map((m) => m.model_key)).size === 1, 'B3 ein Modell');
    ok(S(produkte()) === vorher, 'B4 keine Artikelzeile geändert (Preis, SKU, Bild, Status, Steuerart)');
    ok(zahl("SELECT COUNT(*) AS n FROM sync_changelog WHERE table_name = 'products'") === changelogVorher && zahl("SELECT COUNT(*) AS n FROM sync_changelog WHERE table_name = 'product_models'") === 0,
      'B5 kein Changelog-Eintrag (weder Artikel noch Zuordnung)');
    ok(zahl("SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'product_models' AND action_type = 'CREATE'") === 3, 'B6 Audit je Artikel');
  }
  const KEY = modelle()[0]?.model_key;

  // C — Collection: Modellkarte, Größen, Einzelansicht
  {
    await gehFrisch(c, '/collection');
    await warteBis(c, q('[data-model-card]'), 15000);
    const karte = await c.ev(`const k=document.querySelector('[data-model-card]'); return k ? k.innerText : '';`);
    // PURCHASE ADD VARIANT — die Karte schlüsselt nach Größe UND Karat & Color auf („16 · 18K YG ×1").
    ok(/16 · 18K YG\s*×1/.test(karte) && /17 · 18K YG\s*×2/.test(karte) && /3\s*available/.test(karte) && /Love Bracelet/.test(karte), `C1 eine Modellkarte: 16 ×1, 17 ×2, 3 available („${karte.replace(/\s+/g, ' ').slice(0, 140)}")`);
    ok(await c.ev(`return document.querySelectorAll('[data-model-card]').length;`) === 1, 'C2 genau eine Karte für das Modell');
    const r = await maus(c, '[data-collection-view="single"]');
    await sleep(800);
    ok(r === 'OK' && await c.ev(`return document.querySelectorAll('[data-model-card]').length;`) === 0 && /Love Bracelet/.test(await pageText(c)), 'C3 „Single items" zeigt die Artikel einzeln');
    await maus(c, '[data-collection-view="grouped"]'); await sleep(800);
  }

  // D — Item Detail mit allen Varianten
  {
    const r = [await mausAuf(c, `return document.querySelector('[data-model-card] h3');`, 'Modellkarte')];
    r.push((await warteBis(c, q(`[data-model-section="${KEY}"]`), 15000)) ? 'OK' : 'KEIN-ABSCHNITT');
    const zeilen = await c.ev(`return document.querySelectorAll('[data-model-variant]').length;`);
    ok(alleOk(r) === 'OK' && zeilen === 3, `D1 Detailseite: Modell-Abschnitt mit drei Varianten (${alleOk(r)})`);
    const text = await c.ev(`return document.querySelector('[data-model-section]')?.closest('div')?.parentElement?.innerText || '';`);
    ok(/CAR-BGJ/.test(text) && /30\.12 g/.test(text) && /31\.40 g/.test(text), 'D2 je Variante SKU, Größe, Gewicht, Preis, Status');
    const url0 = await c.ev('return location.pathname;');
    const ziel = await c.ev(`const r=[...document.querySelectorAll('[data-model-variant]')].find(x=>!x.style.background); return r ? r.getAttribute('data-model-variant') : null;`);
    await maus(c, `[data-model-variant="${ziel}"]`);
    await warteBis(c, `location.pathname.endsWith(${S(ziel)})`, 8000);
    ok(await c.ev('return location.pathname;') !== url0, 'D3 Zeilenklick öffnet die Variante');
  }

  // E — Merge photos: gemeinsames Bild, keine neue Datei; Undo
  {
    const pick = hauptbild(p1);
    const dateien0 = dateien(), platte0 = medienDateienAufPlatte();
    const vorherGal = S([p1, p2, p3].map(galerie));
    const r = [await maus(c, '[data-model-merge-photos]')];
    r.push((await warteBis(c, q(`[data-merge-pick="${pick}"]`), 20000)) ? 'OK' : 'KEINE-BILDER');
    r.push(await mausAuf(c, `return document.querySelector('[data-merge-pick="${pick}"] input');`, 'Bildwahl'));
    r.push(await maus(c, '[data-merge-open-confirm]'));
    r.push(await maus(c, '[data-merge-ack]'));
    r.push(await maus(c, '[data-merge-confirm]'));
    ok(!!pick && await warteAuf(() => [p2, p3].every((id) => hauptbild(id) === pick), 20000), `E1 Merge photos (echte Maus): alle drei zeigen dasselbe Medium (${alleOk(r)})`);
    ok(dateien() === dateien0 && medienDateienAufPlatte() === platte0, `E2 keine neue Datei, keine Neuberechnung (${dateien()}/${dateien0}; Platte ${medienDateienAufPlatte()}/${platte0})`);
    ok(galerie(p2).length === 2 && galerie(p3).length === 2, 'E3 bisherige Bilder bleiben als weiteres Bild (Standard „Keep")');
    await warteBis(c, q('[data-merge-undo]'), 10000);
    await maus(c, '[data-merge-undo]');
    ok(await warteAuf(() => S([p1, p2, p3].map(galerie)) === vorherGal, 15000), 'E4 Undo stellt die alten Bildfolgen her');
    await mausText(c, 'Close').catch(() => null); await sleep(500);
  }

  // F — Add variant über die New-Item-Maske
  {
    const tplPick = hauptbild(p1);
    const dateien0 = dateien(), platte0 = medienDateienAufPlatte();
    await gehFrisch(c, `/collection/${p1}`);
    await warteBis(c, q('[data-model-add-variant]'), 15000);
    const r = [await maus(c, '[data-model-add-variant]')];
    r.push((await warteBis(c, q('[data-variant-hint]'), 15000)) ? 'OK' : 'KEIN-VARIANTEN-MODUS');
    const kopf = await pageText(c);
    const vor = await c.ev(`return { brand: document.querySelector('#new-field-brand input')?.value, name: document.querySelector('#new-field-name input')?.value, size: document.querySelector('#new-field-attr_size input')?.value || '' };`);
    ok(/Add Variant — Love Bracelet/.test(kopf) && vor.brand === 'Cartier' && vor.name === 'Love Bracelet' && vor.size === '', `F1 Maske vorbefüllt (Marke, Name), Größe leer (${S(vor)}; ${alleOk(r)})`);
    // ohne Steuerart: gesperrt
    await tippeIn(c, `return document.querySelector('#new-field-attr_size input');`, '18', 'Size');
    await tippeIn(c, `return document.querySelector('#new-field-attr_weight input');`, '32.05', 'Weight');
    await tippeIn(c, inputUnterLabel('SALE PRICE (BHD)'), '3300', 'Sale');
    await maus(c, '[data-create-product]'); await sleep(900);
    ok(/Choose the tax scheme/.test(await pageText(c)) && produkte().length === 3, 'F2 keine automatische Steuerart: ohne Wahl wird nichts angelegt');
    await mausAuf(c, chipIn('#new-field-taxScheme', 'Margin'), 'Margin');
    // PURCHASE ADD VARIANT — Karat & Color kommt als Vorschlag: ausdrücklich bestätigen (echte Maus).
    await maus(c, '[data-variant-karat-confirm] input'); await sleep(200);
    const reuse = await c.ev(`return !!document.querySelector('[data-variant-reuse-photo] input')?.checked;`);
    await maus(c, '[data-create-product]');
    const zu = await warteBis(c, `!document.querySelector('#new-field-categoryId')`, 40000);
    await warteAuf(() => produkte().length === 4 && modelle().length === 4, 20000);
    const neu = produkte().find((p) => ![p1, p2, p3].includes(p.id));
    ok(zu && neu && modelle().some((m) => m.product_id === neu.id && m.model_key === KEY), `F3 neue Variante angelegt und dem Modell zugeordnet (${neu?.sku})`);
    ok(neu && neu.tax_scheme === 'MARGIN' && JSON.parse(neu.attributes).size === '18' && Number(neu.planned_sale_price) === 3300, 'F4 eigene Angaben gespeichert (Größe 18, Preis, gewählte Steuerart)');
    await warteAuf(() => neu && hauptbild(neu.id) === tplPick, 15000);
    ok(reuse && neu && hauptbild(neu.id) === tplPick && dateien() === dateien0 && medienDateienAufPlatte() === platte0,
      `F5 Modellbild wiederverwendet — dasselbe Medium, keine neue Datei (${dateien()}/${dateien0})`);
    ok(zahl("SELECT COUNT(*) AS n FROM stock_lots") === 0 && neu && Number(neu.quantity) === 1, 'F6 derselbe Anlegeweg wie New Item (Bestand = Menge 1, keine erfundene Buchung)');
  }

  // G — Edit group: entfernen, aufheben
  {
    const vorG = S(produkte().map((p) => [p.id, p.sku, p.planned_sale_price, p.stock_status]));
    await gehFrisch(c, `/collection/${p2}`);
    await warteBis(c, q('[data-model-edit-group]'), 15000);
    const r = [await maus(c, '[data-model-edit-group]')];
    r.push((await warteBis(c, q(`[data-edit-group-remove="${p3}"]`), 10000)) ? 'OK' : 'KEIN-DIALOG');
    r.push(await maus(c, `[data-edit-group-remove="${p3}"]`));
    ok(await warteAuf(() => modelle().length === 3 && !modelle().some((m) => m.product_id === p3), 15000), `G1 ein Artikel aus dem Modell genommen (${alleOk(r)})`);
    await sleep(600);
    await maus(c, '[data-edit-group-dissolve]'); await sleep(300);
    await maus(c, '[data-edit-group-dissolve-confirm]');
    ok(await warteAuf(() => modelle().length === 0, 15000), 'G2 Gruppierung aufgehoben: keine Zuordnung mehr');
    ok(S(produkte().map((p) => [p.id, p.sku, p.planned_sale_price, p.stock_status])) === vorG && produkte().length === 4, 'G3 alle Artikel bestehen unverändert weiter');
  }

  // H — New Item ohne Modell: unverändert
  {
    await gehFrisch(c, '/collection');
    await mausText(c, 'New Item');
    await warteBis(c, q('#new-field-categoryId'), 15000);
    const st = await c.ev(`return { hint: !!document.querySelector('[data-variant-hint]'), margin: (()=>{ const b=[...document.querySelectorAll('#new-field-taxScheme button')].find(x=>x.textContent.trim()==='Margin'); return b ? getComputedStyle(b).borderColor : ''; })(), title: document.body.innerText.includes('New Item') };`);
    ok(!st.hint && /15, 15, 16/.test(st.margin) && st.title, `H1 New Item unverändert: kein Varianten-Modus, Margin vorbelegt (${S(st)})`);
    await mausText(c, 'Cancel').catch(() => null);
  }
  c.close();
} catch (e) {
  FAIL++; fails.push('suite error: ' + (e && e.message ? e.message : String(e)));
  console.log('E2E ERROR:', e && e.stack ? e.stack : e);
} finally {
  stopApp(); await waitGoneAndFree();
}
ok(prodMtime(PROD_DB_FILE) === PROD_BEFORE.data && prodMtime(PROD_LOCATOR) === PROD_BEFORE.appdata,
  `ISOLATION Produktionsdatenbank und Produktions-Zeiger unverändert (Änderungszeit; ${PROD_DB_FILE || 'kein Zeiger gefunden'})`);
console.log('\nMeldungen/Dialoge:'); for (const m of MSG) console.log('   · ' + m);
console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — article variants UI e2e: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
