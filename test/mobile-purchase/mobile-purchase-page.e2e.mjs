// MOBILE-PURCHASE — die Einkaufsmaske des Telefons in einem ECHTEN Browser (Edge, schmale Breite),
// gegen einen Attrappen-Primary.
//
// Dieselbe Bauweise wie `test/preg5/mobile-consignment-page.e2e.mjs`: die drei echten Dateien
// (`mobile_purchase.html`, `mobile_purchase_commands.js`, `mobile_purchase_ui.js`), der echte
// Auftraggeber (`mobile_repair_commands.js`), die Helfer WOERTLICH aus `mobile_page.rs` geschnitten und
// das echte Feldschema. Geprueft: Abschnitte auf/zu mit Zusammenfassung, mehrere Positionen, Menge,
// Fotos, Merkmale, Partner (Prozent und BHD), mehrere Zahlungen, Entwurf nach Neuladen, Warten ohne
// Antwort, erneutes Senden unter DERSELBEN Kennung, Bestaetigung, Rueckfrage des Primary, kein
// Partnerbereich ohne aktive Partner, keine waagerechte Rollleiste bei 360 px.
// Run: node test/mobile-purchase/mobile-purchase-page.e2e.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9400 + Math.floor(Math.random() * 500);
const RUN = join(os.tmpdir(), 'lataif-mobile-purchase', 'run-' + Date.now());
const PROFILE = join(RUN, 'edge');

let PASS = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);

const html = readFileSync(join(repo, 'src-tauri/src/sync/mobile_purchase.html'), 'utf8');
const befehleRepair = readFileSync(join(repo, 'src-tauri/src/sync/mobile_repair_commands.js'), 'utf8');
const anzeigeName = readFileSync(join(repo, 'src-tauri/src/sync/mobile_display_name.js'), 'utf8');
const steine = readFileSync(join(repo, 'src-tauri/src/sync/mobile_stones.js'), 'utf8');
const datumRegel = readFileSync(join(repo, 'src-tauri/src/sync/mobile_business_date.js'), 'utf8');
// STONES — dieselben Stile wie die echte Seite (für die Sichtprüfung bei 360 px).
const STEIN_CSS = (() => {
  const pg = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8').split(String.fromCharCode(13)).join('');
  const i = pg.indexOf('/* STONES — kompakter Steinbereich */');
  return pg.slice(i, pg.indexOf(String.fromCharCode(10), pg.indexOf('.stones-foot', i)));
})();
const befehle = readFileSync(join(repo, 'src-tauri/src/sync/mobile_purchase_commands.js'), 'utf8');
const ui = readFileSync(join(repo, 'src-tauri/src/sync/mobile_purchase_ui.js'), 'utf8');
const schema = readFileSync(join(repo, 'src-tauri/src/sync/mobile_field_schema.json'), 'utf8');
const page = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');

function ausSeite(kopf) {
  const a = page.indexOf(kopf);
  if (a < 0) throw new Error('Helfer nicht gefunden: ' + kopf);
  let tiefe = 0, i = page.indexOf('{', a);
  const start = i;
  for (; i < page.length; i++) {
    if (page[i] === '{') tiefe += 1;
    else if (page[i] === '}') { tiefe -= 1; if (tiefe === 0) break; }
  }
  return page.slice(a, start) + page.slice(start, i + 1);
}
const zeile = (m) => { const x = m.exec(page); if (!x) throw new Error('Zeile nicht gefunden: ' + m); return x[0]; };
const helfer = [
  ausSeite('function el(tag, attrs, text) {'), ausSeite('function uuid() {'), ausSeite('function resizePhoto(file, maxDim, quality) {'),
  ausSeite('function dependsSatisfied(attr, pre) {'), zeile(/const ROW_PREFIX = \{[^}]*\};/), ausSeite('function applyDependencies(cat, pre) {'),
  ausSeite('function esc(s) {'), ausSeite('function editableAttrs(cat) {'), ausSeite('function makeStonesControl(id) {'),
  ausSeite('function writeStones(e, rows, attrs) {'), ausSeite('function stonesOf(v) {'),
  ausSeite('function makeControl(a, pre) {'), ausSeite('function normNumber(raw) {'), ausSeite('function readAttr(a, pre) {'),
  ausSeite('function aiApplyToForm(result, ids) {'),
].join('\n');

const SHIM = `window.__P = [];
window.onerror = function (m, s, l, c, err) { window.__P.push('onerror: ' + m + ' @' + l + ':' + c + ' ' + ((err && err.stack) || '')); };
window.addEventListener('unhandledrejection', function (e) { window.__P.push('unhandled: ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason))); });
var TOKEN_KEY = 'lataif_mobile_token';
localStorage.setItem(TOKEN_KEY, 'token-test');
var $ = function (id) { return document.getElementById(id); };
var SCREENS = ['mpHome', 'formMPurchase'];
function screen(id) { SCREENS.forEach(function (s) { $(s).classList.add('hidden'); }); $(id).classList.remove('hidden'); }
function init() { window.__P.push('init() called'); }
var SCHEMA = ${schema};
var catById = function (id) { return SCHEMA.categories.find(function (c) { return c.id === id; }) || null; };
${helfer}
var idbReq = function (req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); };
`;
const UI_DATEI = `(function () {\n${ui}\n  window.__mpHomeOpen = mpHomeOpen;\n  window.__MP = MP;\n})();\n`;
const SEITE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>mobile purchase test</title>
<style>* { box-sizing: border-box; margin: 0; padding: 0; } body { background: #08080A; color: #EAEAEA; font-family: sans-serif; padding: 16px; }
.hidden { display: none; } .card { background: #121216; border: 1px solid #1A1A1F; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
label { display: block; font-size: 11px; margin-bottom: 8px; } input, textarea, select { width: 100%; padding: 12px; font-size: 16px; }
button { width: 100%; padding: 14px; } .photo-strip { display: flex; gap: 8px; overflow-x: auto; } .photo-thumb { position: relative; width: 78px; height: 78px; flex: 0 0 auto; }
.photo-thumb img { width: 100%; height: 100%; object-fit: cover; } .chips { display: flex; flex-wrap: wrap; gap: 8px; } .chip { width: auto; }
.row + .row { margin-top: 14px; } .error, .success { padding: 10px; } .header-row { display: flex; justify-content: space-between; } .photo-area { display: flex; flex-direction: column; }
${STEIN_CSS}</style>
</head><body>
${html}
<script src="/display-name.js"></script><script src="/stones.js"></script><script src="/business-date.js"></script><script src="/repair-commands.js"></script><script src="/commands.js"></script><script src="/shim.js"></script><script src="/ui.js"></script>
</body></html>`;

// ── Attrappen-Primary ─────────────────────────────────────────────────────────────────────────
const gesehen = [];
let partnerListe = [{ id: 'pa-1', name: 'Bashir', active: true }, { id: 'pa-2', name: 'Chalid', active: true }, { id: 'pa-x', name: 'Old', active: false }];
let aiErgebnis = {};
let einkauf = () => ({ status: 200, body: { ok: true, value: { purchaseId: 'pur-1', purchaseNumber: 'PUR-2026-000042', totalAmount: 1361.5, paidAmount: 700, openAmount: 661.5 } } });
const server = createServer((req, res) => {
  if (req.method === 'GET') {
    const js = { '/display-name.js': anzeigeName, '/stones.js': steine, '/business-date.js': datumRegel, '/repair-commands.js': befehleRepair, '/commands.js': befehle, '/shim.js': SHIM, '/ui.js': UI_DATEI }[req.url.split('?')[0]];
    if (js !== undefined) { res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }); res.end(js); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(SEITE); return;
  }
  let roh = '';
  req.on('data', (x) => { roh += x; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(roh); } catch { body = null; }
    gesehen.push({ url: req.url, body });
    let a;
    if (/staging/.test(req.url)) a = { status: 201, body: { stagingId: createHash('sha256').update(String(body && body.dataBase64)).digest('hex') } };
    else if (/ai\/identify/.test(req.url)) a = { status: 200, body: { result: aiErgebnis } };
    else {
      const op = body && body.op;
      if (op === 'store.partners.get') a = { status: 200, body: { ok: true, value: { data: { partners: partnerListe } } } };
      else if (op === 'customers.list') a = { status: 200, body: { ok: true, value: { items: [{ id: 'cust-1', firstName: 'Ali', lastName: 'Hassan', phone: '+973 3600 0101', updatedAt: '2026-09-01T00:00:00.000Z' }] } } };
      else if (op === 'suppliers.list') a = { status: 200, body: { ok: true, value: { items: [{ id: 'sup-1', name: 'Test Supplier', phone: '', active: true }] } } };
      else if (op === 'purchases.create') a = einkauf(body);
      else a = { status: 200, body: { ok: true, value: { items: [] } } };
    }
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body || {}));
  });
});

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
    const r = await this.send('Runtime.evaluate', { expression: '(async () => { ' + expr + ' })()', awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}
/** Eine Aufnahme nur eines Elements (Sichtprüfung eines Bereichs). */
async function shotEl(c, name, sel) {
  if (!process.env.E2E_SHOTS) return;
  const r = await c.ev(`const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.left + window.scrollX, b.top + window.scrollY, b.width, b.height];`);
  const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: r[0], y: r[1], width: r[2], height: r[3], scale: 1 } });
  writeFileSync(join(process.env.E2E_SHOTS, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function shot(c, name) {
  if (!process.env.E2E_SHOTS) return;
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(process.env.E2E_SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
}
// Ein Wert in ein Feld der Maske — wie getippt (input + change).
const tippe = (sel, v) => `(function(){ const e = document.querySelector(${S(sel)}); if (!e) throw new Error('kein Feld ' + ${S(sel)}); e.value = ${S(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })();`;
const klick = (sel) => `(function(){ const e = document.querySelector(${S(sel)}); if (!e) throw new Error('kein Knopf ' + ${S(sel)}); e.click(); })();`;
/** Fotos in das Feld einer Position (oder, mit `feld`, in ein anderes Fotofeld) legen. */
const fotos = (uid, n, feld) => `
  const dt = new DataTransfer();
  for (let i = 0; i < ${n}; i++) {
    const c2 = document.createElement('canvas'); c2.width = 40; c2.height = 30;
    const x = c2.getContext('2d'); x.fillStyle = 'hsl(' + (i * 90) + ',60%,50%)'; x.fillRect(0, 0, 40, 30);
    const blob = await (await fetch(c2.toDataURL('image/jpeg', 0.9))).blob();
    dt.items.add(new File([blob], 'f' + i + '.jpg', { type: 'image/jpeg' }));
  }
  const inp = document.getElementById(${feld ? S(feld) : "'mpf' + " + S(uid)}); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));`;
/** Die Pflichtmerkmale einer Position füllen, die noch leer sind (erste Auswahl, "X", 1). */
const pflicht = (uid) => `
  const it = window.__MP.draft.items.find((x) => x.uid === ${S(uid)}); const cat = catById(it.categoryId);
  for (const a of cat.attributes) {
    if (!a.required) continue;
    const e = document.getElementById('mpa' + it.uid + '_' + a.key); if (!e) continue;
    if (e.tagName === 'SELECT') { if (!e.value) { e.value = [...e.options].find((o) => o.value).value; e.dispatchEvent(new Event('change', { bubbles: true })); } }
    else if (e.classList.contains('chips')) { if (![...e.children].some((x) => x.classList.contains('on'))) e.children[0].click(); }
    else if (!e.value) { e.value = a.type === 'number' ? '1' : 'X'; e.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  await new Promise((r) => setTimeout(r, 50));`;
const summe = (key) => `return document.querySelector('[data-mp-sum="${key}"]')?.textContent || '';`;

let edge = null, c = null;
try {
  if (!existsSync(EDGE)) throw new Error('Edge nicht gefunden: ' + EDGE);
  mkdirSync(PROFILE, { recursive: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + CDP_PORT, url], { stdio: 'ignore' });
  let seite = null;
  for (let i = 0; i < 60 && !seite; i++) {
    try { const l = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json(); seite = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /127\.0\.0\.1/.test(t.url)); } catch { /* noch nicht */ }
    if (!seite) await sleep(300);
  }
  if (!seite) throw new Error('Edge kam nicht hoch');
  c = new CDP(seite.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  // Ein Telefon: 360 px breit.
  await c.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await sleep(500);

  // ── §1 erfassen ──
  await c.ev('await window.__mpHomeOpen(); return 1;');
  await c.ev(klick('#mpNewBtn') + ' await new Promise((r) => setTimeout(r, 300)); return 1;');
  ok(await c.ev("return !document.getElementById('formMPurchase').classList.contains('hidden') && document.querySelectorAll('.mp-sec').length === 5;"),
    '§1 neue Maske mit fünf Abschnitten (Supplier, Details, Items, Payments, Notes)');
  ok(await c.ev("return document.querySelectorAll('.mp-sec.open').length === 2 && !document.querySelector('[data-mp-field=\"purchaseDate\"]');"),
    '§1 nur Lieferant und Positionen offen — Details, Zahlungen, Notizen zugeklappt (keine Endlosseite)');
  // Lieferant: Kunde → Lieferantenrolle.
  await c.ev(klick('[data-mp-action="supplier-mode"][data-mode="customer"]') + ' return 1;');
  await c.ev(tippe('#mpSupSearch', 'Ali') + klick('[data-mp-action="search-customer"]') + ' await new Promise((r) => setTimeout(r, 300)); return 1;');
  await c.ev(klick('[data-mp-action="pick-customer"]') + ' await new Promise((r) => setTimeout(r, 200)); return 1;');
  ok(await c.ev(summe('supplier')) === 'Ali Hassan', '§1 Kunde gewählt — die Zusammenfassung nennt ihn');
  // Position 1: neue Uhr mit zwei Fotos, Merkmal, Partner über BHD.
  const uid1 = await c.ev('return window.__MP.draft.items[0].uid;');
  await c.ev(fotos(uid1, 2) + ' return 1;');
  ok(await c.ev(`return document.querySelectorAll('[data-mp-sec="item:${uid1}"] .photo-thumb').length === 2 && !!document.querySelector('[data-mp-action="ai"][data-uid="${uid1}"]');`),
    '§1 zwei Fotos an Position 1, „AI Identify" erscheint');
  await c.ev(tippe(`[data-mp-field="item:${uid1}:brand"]`, 'Rolex') + tippe(`[data-mp-field="item:${uid1}:name"]`, 'Datejust 41')
    + tippe(`[data-mp-field="item:${uid1}:quantity"]`, '1') + tippe(`[data-mp-field="item:${uid1}:unitPrice"]`, '1000') + ' return 1;');
  const attrId = await c.ev(`return (document.querySelector('#mpAttrs${uid1} input[type=text], #mpAttrs${uid1} input') || {}).id || '';`);
  if (attrId) await c.ev(tippe('#' + attrId, 'REF-123') + ' return 1;');
  await c.ev(pflicht(uid1) + ' return 1;');
  ok(!!attrId && attrId.startsWith('mpa' + uid1 + '_') && await c.ev(`return Object.values(window.__MP.draft.items[0].attributes).includes('REF-123');`),
    `§1 Merkmale der Kategorie mit eigenem Prefix je Position (${attrId})`);
  await c.ev(klick(`[data-mp-action="add-partner"][data-uid="${uid1}"]`) + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  await c.ev(tippe(`[data-mp-field="partner:${uid1}:0:partnerId"]`, 'pa-1') + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  await c.ev(tippe(`[data-mp-field="partner:${uid1}:0:amount"]`, '400') + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  const opts = await c.ev(`return [...document.querySelectorAll('[data-mp-field="partner:${uid1}:0:partnerId"] option')].map((o) => o.value).filter(Boolean);`);
  ok(S(opts) === S(['pa-1', 'pa-2']) && await c.ev(summe('partner:' + uid1)) === 'Partner 40 % · LATAIF 60 %',
    `§1 Partner nur aktive; 400 BHD von 1000 → 40 %, LATAIF 60 % (${S(opts)})`);
  // Position 2: Kette, Menge 3.
  await c.ev(klick('[data-mp-action="add-item"]') + ' await new Promise((r) => setTimeout(r, 200)); return 1;');
  const uid2 = await c.ev('return window.__MP.draft.items[1].uid;');
  await c.ev(tippe(`[data-mp-field="item:${uid2}:categoryId"]`, 'cat-gold-jewelry') + ' await new Promise((r) => setTimeout(r, 150)); return 1;');
  // DISPLAY-NAME — Gold-Diamond Jewellery fragt nicht nach Marke/Modell; die Merkmale benennen den Artikel.
  ok(await c.ev(`return !document.querySelector('[data-mp-field="item:${uid2}:brand"]') && !document.querySelector('[data-mp-field="item:${uid2}:name"]');`),
    '§1 Gold-Diamond Jewellery: keine Felder für Marke/Modell');
  await c.ev(tippe(`[data-mp-field="item:${uid2}:quantity"]`, '3') + tippe(`[data-mp-field="item:${uid2}:unitPrice"]`, '120.5') + ' return 1;');
  await c.ev(pflicht(uid2) + ' return 1;');
  // STONES — die Steinliste der Gold-Position: kompakt, aufklappbar, dieselbe Prüfung wie am Primary.
  const stein = (sel) => `document.querySelector('[id="mpa${uid2}_stones"] ${sel}')`;
  const setze = (sel, v, ev) => `(function(){ const e = ${stein(sel)}; e.value = ${S(v)}; e.dispatchEvent(new Event('${ev}', { bubbles: true })); })();`;
  ok(await c.ev(`return !!document.querySelector('[id="mpa${uid2}_stones"]') && !document.querySelector('[id="mpa${uid2}_diamond_weight"]') && /No stones/.test(${stein('.stones-head')}.textContent);`),
    '§1 STONES Gold-Position: Steinbereich geschlossen („No stones"), kein eigenes Diamond-Weight-Feld');
  await c.ev(`${stein('[data-st="toggle"]')}.click(); ${stein('[data-st="add"]')}.click(); ${stein('[data-st="add"]')}.click(); ${stein('[data-st="add"]')}.click(); return 1;`);
  await c.ev(setze('[data-st="type"][data-i="0"]', 'diamond', 'change') + setze('[data-st="qty"][data-i="0"]', '1', 'input') + setze('[data-st="carat"][data-i="0"]', '0.50', 'input')
    + setze('[data-st="color"][data-i="0"]', 'G', 'change') + setze('[data-st="clarity"][data-i="0"]', 'VS1', 'change') + setze('[data-st="shape"][data-i="0"]', 'oval', 'change')
    + setze('[data-st="type"][data-i="1"]', 'diamond', 'change') + setze('[data-st="qty"][data-i="1"]', '20', 'input') + setze('[data-st="carat"][data-i="1"]', '0.30', 'input')
    + setze('[data-st="type"][data-i="2"]', 'other', 'change') + setze('[data-st="qty"][data-i="2"]', '3', 'input') + ' return 1;');
  ok(await c.ev(`return /Stone 3: enter the stone name/.test(${stein('[data-st-err]')}?.textContent || '') && !${stein('[data-st="color"][data-i="2"]')};`),
    '§1 STONES Other ohne Namen wird benannt; Diamant-Felder nur bei Diamant');
  await c.ev(setze('[data-st="name"][data-i="2"]', 'Spinel', 'input') + setze('[data-st="carat"][data-i="2"]', '0.45', 'input') + ' return 1;');
  await c.ev(`${stein('[data-st="toggle"]')}.click(); ${stein('[data-st="toggle"]')}.click(); return 1;`);
  ok(await c.ev(`return ${stein('.stones-head')}.textContent.includes('3 rows · Diamond 0.80 ct · Spinel 0.45 ct') && /Diamond weight 0\\.80 ct — from the diamond rows/.test(${stein('.stones-foot')}.textContent);`),
    `§1 STONES Zusammenfassung „3 rows · Diamond 0.80 ct · Spinel 0.45 ct", Diamond weight aus den Zeilen (${await c.ev(`return ${stein('.stones-head')}.textContent;`)})`);
  ok(await c.ev('return document.documentElement.scrollWidth <= document.documentElement.clientWidth;'), '§1 STONES bei 360 px kein waagerechtes Scrollen');
  await shot(c, 'mp-stones');
  await shotEl(c, 'mp-stones-el', `[id="mpa${uid2}_stones"]`);
  ok(await c.ev(summe('items')) === '2 positions · 4 pcs · 1,361.500 BHD', `§1 Positionen 1 + Menge 3 = 4 Stück, 1000 + 361,5 (${await c.ev(summe('items'))})`);
  // Zahlungen: bar 500, Bank 200.
  await c.ev(klick('[data-mp-toggle="payments"]') + ' return 1;');
  await c.ev(klick('[data-mp-action="add-payment"]') + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  await c.ev(tippe('[data-mp-field="pay:0:amount"]', '500') + ' return 1;');
  await c.ev(klick('[data-mp-action="add-payment"]') + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  await c.ev(tippe('[data-mp-field="pay:1:method"]', 'bank') + tippe('[data-mp-field="pay:1:amount"]', '200') + ' return 1;');
  ok(await c.ev(summe('payments')) === '700.000 / 1,361.500 BHD paid · 661.500 open', `§1 zwei Zahlungen, Rest offen beim Lieferanten (${await c.ev(summe('payments'))})`);
  // Zuklappen zeigt nur noch die Zusammenfassung.
  await c.ev(klick(`[data-mp-toggle="item:${uid1}"]`) + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  ok(await c.ev(`return !document.querySelector('[data-mp-field="item:${uid1}:brand"]') && /Rolex Datejust 41 · 1 × 1,000.000 · partner/.test(document.querySelector('[data-mp-sum="item:${uid1}"]').textContent);`),
    '§1 Position zugeklappt: nur „Rolex Datejust 41 · 1 × 1,000.000 · partner"');
  const breite = await c.ev('return [document.documentElement.scrollWidth, window.innerWidth];');
  ok(breite[0] <= breite[1], `§1 keine waagerechte Rollleiste bei 360 px (${S(breite)})`);
  await shot(c, 'mp-form');

  // BUSINESS-DATE — „Purchase date": heute vorbelegt, rückdatierbar, Zukunft geht nicht hinaus.
  const heute = new Date().toISOString().split('T')[0];
  const morgen = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const GEWAEHLT = '2026-08-15';
  const einkaeufe = () => gesehen.filter((g) => g.body && g.body.op === 'purchases.create');
  await c.ev(klick('[data-mp-toggle="details"]') + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  const datumFeld = await c.ev(`const e = document.querySelector('[data-mp-field="purchaseDate"]'); return { value: e.value, max: e.max, entwurf: window.__MP.draft.purchaseDate };`);
  ok(datumFeld.value === heute && datumFeld.entwurf === heute && datumFeld.max === morgen, `§1 DATUM „Purchase date" heute vorbelegt, spätester Tag morgen (${S(datumFeld)})`);
  await c.ev(tippe('[data-mp-field="purchaseDate"]', '2099-01-01') + ' return 1;');
  await c.ev(klick('#mpSubmitBtn') + ' await new Promise((r) => setTimeout(r, 500)); return 1;');
  ok(await c.ev("return window.__MP.draft.status === 'draft' && /Purchase date cannot be in the future/.test(document.getElementById('mpError').textContent);") && einkaeufe().length === 0,
    `§1 DATUM Zukunft: kein Auftrag, der Entwurf bleibt, Grund in Worten (${einkaeufe().length})`);
  await c.ev(tippe('[data-mp-field="purchaseDate"]', GEWAEHLT) + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  ok((await c.ev(summe('details'))).startsWith(GEWAEHLT) && await c.ev('return window.__MP.draft.purchaseDate;') === GEWAEHLT,
    `§1 DATUM rückdatiert: im Entwurf und in der Zusammenfassung (${await c.ev(summe('details'))})`);
  await shot(c, 'mp-date');

  // ── §2 Entwurf übersteht Neuladen ──
  await c.ev("await new Promise((r) => setTimeout(r, 900)); location.reload(); return 1;").catch(() => null);
  await sleep(1500);
  c.close();
  const l2 = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
  c = new CDP(l2.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url)).webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  await c.ev('await window.__mpHomeOpen(); return 1;');
  ok(await c.ev("return document.querySelectorAll('[data-mp-draft]').length === 1 && /Draft/.test(document.getElementById('mpDraftList').textContent);"),
    '§2 nach dem Neuladen liegt der Entwurf in der Liste (Draft)');
  await c.ev(klick('[data-mp-open]') + ' await new Promise((r) => setTimeout(r, 300)); return 1;');
  const zurueck = await c.ev(`const d = window.__MP.draft; return { sup: d.supplier.name, n: d.items.length, fotos: d.items[0].photos.length, pct: d.items[0].partners[0].sharePct, q: d.items[1].quantity, pays: d.payments.map((p) => p.method + ':' + p.amount), attr: Object.values(d.items[0].attributes) };`);
  ok(zurueck.sup === 'Ali Hassan' && zurueck.n === 2 && zurueck.fotos === 2 && zurueck.pct === '40' && zurueck.q === '3' && S(zurueck.pays) === S(['cash:500', 'bank:200']) && zurueck.attr.includes('REF-123'),
    `§2 alles wieder da: Lieferant, Positionen, Fotos, Merkmal, Partner, Zahlungen (${S(zurueck)})`);

  ok(await c.ev('return window.__MP.draft.purchaseDate;') === GEWAEHLT, '§2 DATUM das gewählte Datum übersteht das Neuladen');

  // ── §3 kein Netz zum Primary: wartet, gesperrt, keine Buchung ──
  einkauf = () => ({ status: 503, body: { ok: false, error: 'PRIMARY_WINDOW_UNAVAILABLE' } });
  await c.ev(klick('#mpSubmitBtn') + ' await new Promise((r) => setTimeout(r, 1200)); return 1;');
  const warten = await c.ev(`return { s: window.__MP.draft.status, sent: window.__MP.draft.sent, bar: document.getElementById('mpStatusBar').textContent, locked: document.querySelector('[data-mp-field="notes"], [data-mp-action="add-item"]')?.disabled };`);
  ok(warten.s === 'pending' && warten.sent === true && /Waiting for main computer/.test(warten.bar) && /Send again/.test(warten.bar),
    `§3 ohne Antwort: „Waiting for main computer", Senden erneut möglich (${S(warten)})`);
  ok(await c.ev("return [...document.querySelectorAll('#mpSections input, #mpSections button:not([data-mp-toggle])')].every((e) => e.disabled);"),
    '§3 wartend ist die Maske gesperrt — geändert wird nichts mehr unter der offenen Kennung');
  await shot(c, 'mp-pending');
  const erste = gesehen.filter((g) => g.body && g.body.op === 'purchases.create');
  const hochgeladen = gesehen.filter((g) => /staging/.test(g.url)).length;
  ok(erste.length === 1 && hochgeladen === 2 && !/base64|data:image/.test(S(erste[0].body.payload)), `§3 ein Auftrag, zwei Fotos in der Ablage, keine Bytes im Auftrag (${hochgeladen})`);
  const p = erste[0].body.payload;
  ok(S(p.supplierFromCustomer) === S({ customerId: 'cust-1', seenCustomerUpdatedAt: '2026-09-01T00:00:00.000Z' }) && p.lines.length === 2
    && p.lines[1].quantity === 3 && p.lines[0].newProduct.stagingIds.length === 2 && S(p.lines[0].partnerShares) === S([{ partnerId: 'pa-1', sharePct: 40 }])
    && S(p.payments) === S([{ amount: 500, method: 'cash' }, { amount: 200, method: 'bank' }]),
  `§3 Rumpf: Kunde → Lieferant, zwei Positionen, Menge 3, Fotos, Partner 40 %, zwei Zahlungen (${S(p).slice(0, 200)}…)`);
  ok(S(p.lines[1].newProduct.attributes.stones) === S([
    { type: 'diamond', qty: 1, carat: 0.5, color: 'G', clarity: 'VS1', shape: 'oval' },
    { type: 'diamond', qty: 20, carat: 0.3 },
    { type: 'other', qty: 3, carat: 0.45, name: 'Spinel' },
  ]) && !('diamond_weight' in p.lines[1].newProduct.attributes),
    `§3 STONES im Auftrag die geprüften, normalisierten Zeilen — kein Diamond Weight vom Telefon (${S(p.lines[1].newProduct.attributes.stones)})`);
  ok(p.lines[1].brand === '' && p.lines[1].name === '' && p.lines[1].newProduct.brand === null && p.lines[1].newProduct.categoryId === 'cat-gold-jewelry',
    `§3 die Gold-Position reist ohne Marke/Modell (${S(p.lines[1]).slice(0, 160)})`);

  ok(p.purchaseDate === GEWAEHLT && await c.ev('return window.__MP.draft.purchaseDate;') === GEWAEHLT, `§3 DATUM wartend: der Auftrag trägt das gewählte Datum, der Entwurf behält es (${p.purchaseDate})`);

  // ── §4 erneut senden: DIESELBE Kennung, derselbe Rumpf → gebucht ──
  einkauf = () => ({ status: 200, body: { ok: true, value: { purchaseId: 'pur-1', purchaseNumber: 'PUR-2026-000042', totalAmount: 1361.5, paidAmount: 700, openAmount: 661.5, replayed: true } } });
  await c.ev(klick('[data-mp-action="resend"]') + ' await new Promise((r) => setTimeout(r, 1200)); return 1;');
  const alle = gesehen.filter((g) => g.body && g.body.op === 'purchases.create');
  ok(alle.length === 2 && alle[0].body.commandId === alle[1].body.commandId && S(alle[0].body.payload) === S(alle[1].body.payload),
    '§4 zweiter Versuch unter derselben Kennung mit demselben Rumpf (der Primary bucht nie zweimal)');
  ok(alle[1].body.payload.purchaseDate === GEWAEHLT, '§4 DATUM die Wiederholung trägt dasselbe Datum — nicht „heute"');
  ok(await c.ev("return window.__MP.draft.status === 'confirmed' && /Booked/.test(document.getElementById('mpStatusBar').textContent) && /PUR-2026-000042/.test(document.getElementById('mpStatusBar').textContent);"),
    '§4 bestätigt: „Booked" mit der Belegnummer des Primary');
  ok(await c.ev("return window.__MP.draft.items[0].photos.every((p) => !p.dataUrl && p.stagingId);"), '§4 nach der Buchung keine Fotobytes mehr auf dem Telefon');
  await shot(c, 'mp-booked');
  await c.ev('await window.__mpHomeOpen(); await new Promise((r) => setTimeout(r, 300)); return 1;');
  ok(await c.ev("return /PUR-2026-000042/.test(document.getElementById('mpDraftList').textContent) && /Booked/.test(document.getElementById('mpDraftList').textContent);"),
    '§4 die Liste zeigt den gebuchten Einkauf');
  // Wieder geöffnet: nur ansehen — kein „New purchase" im Einkauf (das steht in der Liste), keine Knöpfe.
  await c.ev("document.querySelector('#mpDraftList [data-mp-open]').click(); await new Promise((r) => setTimeout(r, 400)); return 1;");
  ok(await c.ev("return /Booked/.test(document.getElementById('mpStatusBar').textContent) && !document.querySelector('[data-mp-action=\"new-purchase\"]') && document.getElementById('mpActions').classList.contains('hidden');"),
    '§4 ein gebuchter Einkauf öffnet nur zum Ansehen — ohne „New purchase" und ohne Buchungsknöpfe');
  await c.ev('await window.__mpHomeOpen(); await new Promise((r) => setTimeout(r, 300)); return 1;');
  const vorResend = gesehen.filter((g) => g.body && g.body.op === 'purchases.create').length;
  await sleep(300);
  ok(gesehen.filter((g) => g.body && g.body.op === 'purchases.create').length === vorResend, '§4 ein bestätigter Einkauf wird nie erneut geschickt');

  // ── §5 Rückfrage des Primary (möglicher Doppelgänger) → zurück zum Entwurf, bewusste Entscheidung ──
  einkauf = (b) => (b.payload.newSupplierPerson && b.payload.newSupplierPerson.createDespiteExistingSuppliers
    ? { status: 200, body: { ok: true, value: { purchaseId: 'pur-2', purchaseNumber: 'PUR-2026-000043', totalAmount: 10, paidAmount: 0, openAmount: 10 } } }
    : { status: 409, body: { ok: false, error: 'SUPPLIER_CANDIDATES_EXIST', message: 'an existing supplier may be this person (Karim Saleh)' } });
  await c.ev(klick('#mpNewBtn') + ' await new Promise((r) => setTimeout(r, 300)); return 1;');
  await c.ev(klick('[data-mp-action="supplier-mode"][data-mode="person"]') + ' return 1;');
  await c.ev(tippe('[data-mp-field="person.firstName"]', 'Karim') + tippe('[data-mp-field="person.lastName"]', 'Saleh') + ' return 1;');
  // Das Ausweisfoto der neuen Person (optional) — dieselbe Aufnahme wie die Positionsfotos.
  ok(await c.ev("return !!document.querySelector('#mpIdPhoto[data-mp-id-photo]') && /ID \\/ CPR photo \\(optional\\)/.test(document.getElementById('mpSections').textContent);"),
    '§5 „New person" bietet ein optionales Ausweisfoto an');
  await c.ev(fotos('', 1, 'mpIdPhoto') + ' return 1;');
  ok(await c.ev("return !!(window.__MP.draft.supplier.person.idPhoto && window.__MP.draft.supplier.person.idPhoto.dataUrl) && /Captured/.test(document.getElementById('mpSections').textContent) && /ID photo/.test(document.getElementById('mpSections').textContent);"),
    '§5 Ausweisfoto aufgenommen, in der Maske und in der Zusammenfassung');
  await shot(c, 'mp-id-photo');
  const uid3 = await c.ev('return window.__MP.draft.items[0].uid;');
  await c.ev(tippe(`[data-mp-field="item:${uid3}:brand"]`, 'Cartier') + tippe(`[data-mp-field="item:${uid3}:name"]`, 'Tank') + tippe(`[data-mp-field="item:${uid3}:unitPrice"]`, '10') + ' return 1;');
  await c.ev(pflicht(uid3) + ' return 1;');
  await c.ev(klick('#mpSubmitBtn') + ' await new Promise((r) => setTimeout(r, 900)); return 1;');
  ok(await c.ev("return window.__MP.draft.status === 'draft' && /existing supplier may be this person/.test(document.getElementById('mpError').textContent) && !!document.querySelector('[data-mp-field=\"createDespite\"]');"),
    '§5 abgewiesen: zurück zum Entwurf, Grund in Worten, „Create a new supplier anyway" angeboten');
  await c.ev("const e = document.querySelector('[data-mp-field=\"createDespite\"]'); e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); return 1;");
  await c.ev(klick('#mpSubmitBtn') + ' await new Promise((r) => setTimeout(r, 900)); return 1;');
  const k = gesehen.filter((g) => g.body && g.body.op === 'purchases.create').slice(-2);
  ok(k[0].body.commandId !== k[1].body.commandId && k[1].body.payload.newSupplierPerson.createDespiteExistingSuppliers === true && await c.ev("return window.__MP.draft.status === 'confirmed';"),
    '§5 die bewusste Entscheidung ist ein NEUER Auftrag (eigene Kennung) und wird gebucht');
  ok(/^[0-9a-f]{64}$/.test(String(k[1].body.payload.newSupplierPerson.idPhotoStagingId)) && !JSON.stringify(k[1].body.payload).includes('base64')
    && await c.ev("return !window.__MP.draft.supplier.person.idPhoto.dataUrl && !!window.__MP.draft.supplier.person.idPhoto.stagingId;"),
    '§5 das Ausweisfoto reist nur als Ablagekennung; nach der Buchung keine Ausweisbytes mehr auf dem Telefon');

  // ── §6 ohne aktive Partner gar kein Partnerbereich ──
  partnerListe = [{ id: 'pa-x', name: 'Old', active: false }];
  await c.ev('await window.__mpHomeOpen(); await new Promise((r) => setTimeout(r, 200)); return 1;');
  await c.ev(klick('#mpNewBtn') + ' await new Promise((r) => setTimeout(r, 300)); return 1;');
  ok(await c.ev("return !document.querySelector('[data-mp-action=\"add-partner\"]') && !/Partner participation/.test(document.getElementById('mpSections').textContent);"),
    '§6 keine aktiven Partner → kein „Add partner", kein Partnerbereich');
  // §6b KI an einer Uhr-Position: Material mit Goldanteil → „Karat & Color" erscheint, gefüllt, im Entwurf.
  const uid6 = await c.ev('return window.__MP.draft.items[0].uid;');
  await c.ev(tippe(`[data-mp-field="item:${uid6}:categoryId"]`, 'cat-watch') + ' await new Promise((r) => setTimeout(r, 150)); return 1;');
  await c.ev(fotos(uid6, 1) + ' return 1;');
  const karatVorher = await c.ev(`return document.getElementById('mpr${uid6}_karat_color').classList.contains('hidden');`);
  aiErgebnis = { attributes: { karat_color: '18K Rose', material: 'Two-Tone Steel/Gold' } };
  await c.ev(klick(`[data-mp-action="ai"][data-uid="${uid6}"]`) + ' await new Promise((r) => setTimeout(r, 600)); return 1;');
  const karat = await c.ev(`return { verdeckt: document.getElementById('mpr${uid6}_karat_color').classList.contains('hidden'),
    wert: document.getElementById('mpa${uid6}_karat_color').value, entwurf: window.__MP.draft.items[0].attributes };`);
  ok(karatVorher && !karat.verdeckt && karat.wert === '18K Rose' && karat.entwurf.karat_color === '18K Rose' && karat.entwurf.material === 'Two-Tone Steel/Gold',
    `§6b KI: Two-Tone → „Karat & Color" sichtbar, gefüllt und im Entwurf (${S(karat)})`);

  // ── §8 BUSINESS-DATE: wartend über einen Neustart der Seite — dieselbe Kennung, dasselbe Datum ──
  const SPAETER = '2026-07-04';
  const mitDatum = () => gesehen.filter((g) => g.body && g.body.op === 'purchases.create' && g.body.payload.purchaseDate === SPAETER);
  /** Der Entwurf, wie er in der Ablage des Telefons liegt (IndexedDB) — unabhängig von der offenen Maske. */
  const ausAblage = (id) => `
    const db = await new Promise((res, rej) => { const r = indexedDB.open('lataif_mobile_purchase', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const alle = await new Promise((res, rej) => { const r = db.transaction('drafts', 'readonly').objectStore('drafts').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const x = alle.find((e) => e.id === ${S(id)});
    return x ? { status: x.status, datum: x.purchaseDate, nummer: (x.result && x.result.purchaseNumber) || '' } : null;`;
  einkauf = () => ({ status: 503, body: { ok: false, error: 'PRIMARY_WINDOW_UNAVAILABLE' } });
  await c.ev('await window.__mpHomeOpen(); await new Promise((r) => setTimeout(r, 200)); return 1;');
  await c.ev(klick('#mpNewBtn') + ' await new Promise((r) => setTimeout(r, 300)); return 1;');
  const idDatum = await c.ev('return window.__MP.draft.id;');
  await c.ev(tippe('#mpSupSearch', 'Test') + klick('[data-mp-action="search-supplier"]') + ' await new Promise((r) => setTimeout(r, 300)); return 1;');
  await c.ev(klick('[data-mp-action="pick-supplier"]') + ' await new Promise((r) => setTimeout(r, 200)); return 1;');
  const uid8 = await c.ev('return window.__MP.draft.items[0].uid;');
  await c.ev(tippe(`[data-mp-field="item:${uid8}:brand"]`, 'Omega') + tippe(`[data-mp-field="item:${uid8}:name"]`, 'Seamaster') + tippe(`[data-mp-field="item:${uid8}:unitPrice"]`, '25') + ' return 1;');
  await c.ev(pflicht(uid8) + ' return 1;');
  await c.ev(klick('[data-mp-toggle="details"]') + ' await new Promise((r) => setTimeout(r, 100)); return 1;');
  await c.ev(tippe('[data-mp-field="purchaseDate"]', SPAETER) + ' return 1;');
  await c.ev(klick('#mpSubmitBtn') + ' await new Promise((r) => setTimeout(r, 1200)); return 1;');
  ok(mitDatum().length === 1 && await c.ev(`return window.__MP.draft.status === 'pending' && window.__MP.draft.purchaseDate === ${S(SPAETER)};`),
    `§8 DATUM ohne Antwort: wartend, der Auftrag trägt ${SPAETER} (${mitDatum().length})`);
  // Die Seite startet neu (App geschlossen, Telefon neu gestartet) — der wartende Einkauf liegt in der Ablage.
  await c.ev("await new Promise((r) => setTimeout(r, 300)); location.reload(); return 1;").catch(() => null);
  await sleep(1500);
  c.close();
  const l8 = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
  c = new CDP(l8.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url)).webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  const abgelegt = await c.ev(ausAblage(idDatum));
  ok(abgelegt && abgelegt.status === 'pending' && abgelegt.datum === SPAETER, `§8 DATUM nach dem Neustart: wartend in der Ablage, mit dem gewählten Datum (${S(abgelegt)})`);
  // Der Primary ist wieder da: beim Öffnen wird erneut gesendet — dieselbe Kennung, derselbe Rumpf.
  einkauf = () => ({ status: 200, body: { ok: true, value: { purchaseId: 'pur-8', purchaseNumber: 'PUR-2026-000048', totalAmount: 25, paidAmount: 0, openAmount: 25 } } });
  await c.ev('await window.__mpHomeOpen(); await new Promise((r) => setTimeout(r, 1500)); return 1;');
  const beide = mitDatum();
  ok(beide.length === 2 && beide[0].body.commandId === beide[1].body.commandId && S(beide[0].body.payload) === S(beide[1].body.payload),
    `§8 DATUM erneut gesendet nach dem Neustart: dieselbe Kennung, derselbe Rumpf, Datum ${SPAETER} — nicht „heute" (${beide.length})`);
  const gebucht = await c.ev(ausAblage(idDatum));
  ok(gebucht && gebucht.status === 'confirmed' && gebucht.datum === SPAETER && gebucht.nummer === 'PUR-2026-000048', `§8 DATUM gebucht: der Einkauf behält sein Datum (${S(gebucht)})`);

  const protokoll = await c.ev('return window.__P;');
  ok(!protokoll.length, `§7 keine Skriptfehler im Browser (${S(protokoll).slice(0, 300)})`);
} catch (e) {
  fails.push('THROWN ' + String(e && e.stack || e)); console.log('  x', e);
} finally {
  if (c) c.close();
  if (edge) { try { edge.kill(); } catch { /* weg */ } }
  server.close();
}
console.log(`\nmobile-purchase page e2e: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('MOBILE_PURCHASE_PAGE_E2E_PROVED');
