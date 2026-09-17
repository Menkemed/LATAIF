// PRE-G5 MOBILE CONSIGNMENT — die Kommissionsmaske in einem ECHTEN Browser, gegen einen
// Attrappen-Primary.
//
// Dieselbe Bauweise wie `mobile-repair-page.e2e.mjs`: die DREI echten Dateien
// (`mobile_consignment.html`, `mobile_consignment_commands.js`, `mobile_consignment_ui.js`), dazu
// die Helfer, die WOERTLICH aus `mobile_page.rs` geschnitten werden (kein Nachbau), und das echte
// Feldschema. Edge laeuft mit eigenem Profil auf einem eigenen Debug-Port; der Server ist ein
// Testserver ohne Datenbank. Sekunden statt Minuten.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9400 + Math.floor(Math.random() * 500);
const RUN = join(os.tmpdir(), 'lataif-preg5-consign', 'run-' + Date.now());
const PROFILE = join(RUN, 'edge');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);

const html = readFileSync(join(repo, 'src-tauri/src/sync/mobile_consignment.html'), 'utf8');
const befehleRepair = readFileSync(join(repo, 'src-tauri/src/sync/mobile_repair_commands.js'), 'utf8');
const befehle = readFileSync(join(repo, 'src-tauri/src/sync/mobile_consignment_commands.js'), 'utf8');
const ui = readFileSync(join(repo, 'src-tauri/src/sync/mobile_consignment_ui.js'), 'utf8');
const schema = readFileSync(join(repo, 'src-tauri/src/sync/mobile_field_schema.json'), 'utf8');
const page = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');

/** Eine Funktion aus der echten Seite holen — ueber die Klammerbilanz, nicht ueber ein Muster. */
function ausSeite(kopf) {
  const a = page.indexOf(kopf);
  if (a < 0) throw new Error('Helfer nicht gefunden: ' + kopf);
  let tiefe = 0, i = page.indexOf('{', a);
  const start = i;
  for (; i < page.length; i++) {
    if (page[i] === '{') tiefe += 1;
    else if (page[i] === '}') { tiefe -= 1; if (tiefe === 0) break; }
  }
  if (tiefe !== 0) throw new Error('Klammern unausgeglichen: ' + kopf);
  return page.slice(a, start) + page.slice(start, i + 1);
}
const zeileAusSeite = (muster) => {
  const m = muster.exec(page);
  if (!m) throw new Error('Zeile nicht gefunden: ' + muster);
  return m[0];
};

const helfer = [
  ausSeite('function el(tag, attrs, text) {'),
  ausSeite('function uuid() {'),
  ausSeite('function resizePhoto(file, maxDim, quality) {'),
  ausSeite('function dependsSatisfied(attr, pre) {'),
  zeileAusSeite(/const ROW_PREFIX = \{[^}]*\};/),
  ausSeite('function applyDependencies(cat, pre) {'),
  ausSeite('function makeControl(a, pre) {'),
  ausSeite('function normNumber(raw) {'),
  ausSeite('function readAttr(a, pre) {'),
  ausSeite('function aiApplyToForm(result, ids) {'),
].join('\n');

const SHIM = `window.__PROTOKOLL = [];
window.onerror = function (m, s, l, c, err) { window.__PROTOKOLL.push('onerror: ' + m + ' @' + l + ':' + c + ' ' + ((err && err.stack) || '')); };
window.addEventListener('unhandledrejection', function (e) { window.__PROTOKOLL.push('unhandled: ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason))); });
var TOKEN_KEY = 'lataif_mobile_token';
localStorage.setItem(TOKEN_KEY, 'token-test');
var $ = function (id) { return document.getElementById(id); };
var SCREENS = ['consignHome', 'formConsign'];
function screen(id) { SCREENS.forEach(function (s) { $(s).classList.add('hidden'); }); $(id).classList.remove('hidden'); }
var SCHEMA = ${schema};
var catById = function (id) { return SCHEMA.categories.find(function (c) { return c.id === id; }) || null; };
${helfer}
var idbReq = function (req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); };
`;

const UI_DATEI = `(function () {\n${ui}\n  window.__cnHomeOpen = cnHomeOpen;\n  window.__CN = CN;\n})();\n`;

const SEITE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>consignment page test</title></head><body>
${html}
<script src="/repair-commands.js"></script>
<script src="/commands.js"></script>
<script src="/shim.js"></script>
<script src="/ui.js"></script>
</body></html>`;

if (process.env.PREG5_DUMP) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.PREG5_DUMP, SEITE);
  console.log('Seite geschrieben: ' + process.env.PREG5_DUMP);
  process.exit(0);
}

let antwortGeber = () => ({ status: 200, body: { ok: true, value: {} } });
const gesehen = [];
/** Jeder Abruf der Medienroute — mit dem Ausweis, den er mitgebracht hat (oder ohne). */
const medienAbrufe = [];
const server = createServer((req, res) => {
  if (req.method === 'GET') {
    const js = {
      '/repair-commands.js': befehleRepair, '/commands.js': befehle, '/shim.js': SHIM, '/ui.js': UI_DATEI,
    }[req.url.split('?')[0]];
    if (js !== undefined) {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(js);
      return;
    }
    if (req.url.startsWith('/api/media')) {   // eine winzige echte PNG-Antwort
      // Wie die ECHTE Route: sie laeuft hinter der Anmeldung. Ohne Ausweis gibt es nichts —
      // ein nacktes `<img src="/api/media?...">` faellt damit hier genauso auf wie im Haus.
      medienAbrufe.push({ url: req.url, ausweis: String(req.headers.authorization || '') });
      if (!/^Bearer .+/.test(String(req.headers.authorization || ''))) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SEITE);
    return;
  }
  let roh = '';
  req.on('data', (c) => { roh += c; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(roh); } catch { body = null; }
    gesehen.push({ url: req.url, body });
    const a = antwortGeber(req.url, body);
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body === null ? {} : a.body));
  });
});

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.konsole = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        this.konsole.push(m.params.type + ': ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.konsole.push('exception: ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || ''));
      }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  async send(method, params = {}, ms = 30000) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('CDP ' + method + ' ohne Antwort')); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: '(async () => { ' + expr + ' })()', awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}

const KOMMISSION = (rev, extra) => Object.assign({
  id: 'con-1', consignmentNumber: 'CON-2026-0007', consignorId: 'cust-1', productId: 'prod-1',
  agreedPrice: 500, minimumPrice: 450, expiryDate: '2026-12-31', notes: 'Karton dabei',
  payoutModel: 'percent', commissionRate: 20, excessSplitPct: null, payoutLocked: false,
  status: 'active', payoutStatus: 'pending', payoutAmount: null, payoutPaidAmount: 0, payoutOpenAmount: 0,
  salePrice: null, commissionAmount: null, invoiceId: '', revision: rev,
}, extra || {});
const ARTIKEL = { id: 'prod-1', brand: 'Rolex', name: 'Datejust 36', mediaKeys: ['k-1', 'k-2'], mediaIds: ['m-1', 'm-2'] };

let edge = null, c = null;
try {
  if (!existsSync(EDGE)) throw new Error('Edge nicht gefunden: ' + EDGE);
  mkdirSync(PROFILE, { recursive: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/';

  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + CDP_PORT, url], { stdio: 'ignore' });
  let seite = null;
  for (let i = 0; i < 60 && !seite; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      seite = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && /127\.0\.0\.1/.test(t.url));
    } catch { /* noch nicht */ }
    if (!seite) await sleep(300);
  }
  if (!seite) throw new Error('Edge kam nicht hoch');
  c = new CDP(seite.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await sleep(600);
  ok(await c.ev("return !!document.getElementById('cnSaveBtn') && typeof window.__cnHomeOpen === 'function';"),
    '§0 die Seite laedt: Markup + Befehlsmodul + Oberflaeche');

  // Das Feldschema baut die Kategorie-Felder — dieselben Bausteine wie im Anlegeformular.
  ok(await c.ev("return document.getElementById('cnCategory').options.length >= 3;"),
    '§0 die Kategorien kommen aus dem Feldschema');
  const felder = await c.ev(`
    document.getElementById('cnCategory').value = 'cat-watch';
    document.getElementById('cnCategory').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 60));
    return { attrs: document.getElementById('cnAttrs').children.length,
             erstesId: document.getElementById('cnAttrs').querySelector('input, select') ? document.getElementById('cnAttrs').querySelector('input, select').id : '',
             scope: document.getElementById('cnScope').children.length };`);
  ok(felder.attrs > 0 && felder.erstesId.startsWith('cna_') && felder.scope > 0,
    `§0 …samt Merkmalen (eigener Prefix) und Lieferumfang (${S(felder)})`);

  // ── §1 Anlegen: Duplikatsfrage, dann „Create anyway" ────────────────────────────────────────
  let duplikatGefragt = 0;
  antwortGeber = (u, body) => {
    if (/staging/.test(u)) return { status: 201, body: { stagingId: 'a'.repeat(64) } };
    const op = body && body.op;
    const p = (body && body.payload) || {};
    if (op === 'customers.create') return { status: 200, body: { ok: true, value: { customerId: 'cust-1', name: 'Mo Kunde' } } };
    if (op === 'consignments.create') {
      if (!p.acknowledgeDuplicate) {
        duplikatGefragt += 1;
        return { status: 409, body: { ok: false, error: 'POSSIBLE_DUPLICATE', message: 'this looks like an item we already have: Rolex Datejust (RLX-1)' } };
      }
      return { status: 200, body: { ok: true, value: { consignmentId: 'con-1', consignmentNumber: 'CON-2026-0007' } } };
    }
    if (op === 'consignments.get') return { status: 200, body: { ok: true, value: KOMMISSION(3) } };
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };

  await c.ev("document.getElementById('cnNewBtn').click(); return 1;");
  await sleep(200);
  await c.ev(`
    document.getElementById('cnConsignorFirst').value = 'Mo';
    document.getElementById('cnConsignorLast').value = 'Kunde';
    document.getElementById('cnConsignorCreateBtn').click();
    return 1;`);
  await sleep(700);
  ok(await c.ev("return !document.getElementById('cnConsignorPicked').classList.contains('hidden');"),
    '§1 der Einlieferer wird angelegt und gewaehlt');

  // Ein Foto wie von der Kamera — ein ECHTES Bild, sonst hat das Verkleinern nichts zu tun.
  await c.ev(`
    const c2 = document.createElement('canvas'); c2.width = 40; c2.height = 30;
    const x = c2.getContext('2d'); x.fillStyle = '#3c6'; x.fillRect(0, 0, 40, 30);
    const dataUrl = c2.toDataURL('image/jpeg', 0.9);
    const blob = await (await fetch(dataUrl)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'neu.jpg', { type: 'image/jpeg' }));
    const inp = document.getElementById('cnPhotoInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;`);
  for (let i = 0; i < 30; i++) {
    const n = await c.ev("return document.querySelectorAll('#cnPhotoStrip .photo-thumb').length;");
    if (n === 1) break;
    await sleep(200);
  }
  ok(await c.ev("return document.querySelectorAll('#cnPhotoStrip .photo-thumb').length === 1;"),
    '§1 das Foto haengt an der Maske');

  // Die Pflichtfelder der KATEGORIE (Feldschema) gehoeren dazu — ohne sie geht nichts hinaus.
  const ohnePflicht = await c.ev(`
    document.getElementById('cnBrand').value = 'Rolex';
    document.getElementById('cnName').value = 'Datejust 36';
    document.getElementById('cnAgreedPrice').value = '500';
    document.getElementById('cnPayoutModel').value = 'percent';
    document.getElementById('cnCommissionRate').value = '20';
    document.getElementById('cnSaveBtn').click();
    await new Promise((r) => setTimeout(r, 500));
    return { fehler: document.getElementById('cnError').textContent,
             gesendet: !!document.getElementById('cnSuccess').textContent };`);
  ok(/is required/.test(ohnePflicht.fehler) && !ohnePflicht.gesendet,
    `§1 die Pflichtmerkmale der Kategorie werden VOR dem Senden verlangt (${S(ohnePflicht.fehler.slice(0, 60))})`);

  await c.ev(`
    document.getElementById('cna_dial').value = 'Black';
    const mat = document.getElementById('cna_material');
    mat.value = 'Steel';
    mat.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 60));
    document.getElementById('cnSaveBtn').click();
    return 1;`);
  await sleep(900);
  const nachErstem = await c.ev(`return {
    dup: !document.getElementById('cnDuplicateCard').classList.contains('hidden'),
    text: document.getElementById('cnDuplicateText').textContent,
    fehler: document.getElementById('cnError').textContent };`);
  ok(nachErstem.dup && /already have/.test(nachErstem.text),
    `§1 die Duplikatserkennung FRAGT, sie blockiert nicht (${S(nachErstem.text.slice(0, 60))} · Fehler: ${S(nachErstem.fehler.slice(0, 90))})`);
  const ersteAnlage = gesehen.filter((g) => g.body?.op === 'consignments.create');
  ok(ersteAnlage.length === 1 && ersteAnlage[0].body.payload.acknowledgeDuplicate === undefined,
    '§1 …und der erste Versuch hat NICHT vorsorglich bestaetigt');
  const rumpf = ersteAnlage[0].body.payload;
  ok(rumpf.product.categoryId === 'cat-watch' && rumpf.agreedPrice === 500
    && S(rumpf.payout) === S({ model: 'percent', commissionRate: 20 })
    && S(rumpf.stagingIds) === S(['a'.repeat(64)]),
    `§1 der Rumpf traegt Artikel, Preis, Modell und Bildkennung (${S(rumpf.payout)})`);
  ok(!('purchasePrice' in rumpf.product) && !('stockStatus' in rumpf.product) && !('sourceType' in rumpf.product),
    '§1 …und nichts, was der Primary selbst setzt');

  // „Copy details": die Treffer und was uebernommen wird, kommen aus der AUTORITAET.
  const vorherGeber = antwortGeber;
  antwortGeber = (u, body) => {
    if (body && body.op === 'products.duplicates.get') {
      return { status: 200, body: { ok: true, value: { items: [{
        id: 'prod-alt', brand: 'Rolex', name: 'Datejust 41', sku: 'RLX-1', categoryId: 'cat-watch',
        condition: 'Pre-Owned', taxScheme: 'MARGIN', notes: 'Kratzer am Boden', plannedSalePrice: 900,
        minSalePrice: 800, maxSalePrice: 1000, scopeOfDelivery: ['Box'], mediaKeys: ['k-1', 'k-2'],
        // GEFILTERT vom Primary: die Seriennummer ist nicht dabei.
        attributes: { dial: 'Silver', material: 'Steel' }, matchClass: 'POSSIBLE', reasons: ['brand+model'],
      }] } } };
    }
    return vorherGeber(u, body);
  };
  await c.ev("document.getElementById('cnSaveBtn').click(); await new Promise((r) => setTimeout(r, 900)); return 1;");
  ok(await c.ev("return document.querySelectorAll('#cnDuplicateList [data-copy-details]').length === 1;"),
    '§1b die Treffer des Hauses stehen unter der Frage');
  await c.ev("document.querySelector('#cnDuplicateList [data-copy-details]').click(); await new Promise((r) => setTimeout(r, 300)); return 1;");
  const kopiert = await c.ev(`return {
    name: document.getElementById('cnName').value,
    zustand: document.getElementById('cnCondition').value,
    dial: document.getElementById('cna_dial').value,
    sku: document.getElementById('cnSku').value,
    serial: document.getElementById('cna_serial_number') ? document.getElementById('cna_serial_number').value : '',
    scope: Array.from(document.getElementById('cnScope').children).filter((x) => x.classList.contains('on')).map((x) => x.textContent) };`);
  ok(kopiert.name === 'Datejust 41' && kopiert.zustand === 'Pre-Owned' && kopiert.dial === 'Silver'
    && S(kopiert.scope) === S(['Box']),
    `§1b „Copy details" uebernimmt Modell, Zustand, Merkmale und Lieferumfang (${S(kopiert)})`);
  ok(kopiert.sku === '' && kopiert.serial === '',
    `§1b …aber NIE die Referenz und nie die Seriennummer — die gehoeren dem neuen Stueck (${S({ sku: kopiert.sku, serial: kopiert.serial })})`);
  const mehr = await c.ev(`return {
    steuer: document.getElementById('cnTaxScheme').value,
    notiz: document.getElementById('cnItemNotes').value,
    fotos: document.querySelectorAll('#cnPhotoStrip .photo-thumb').length };`);
  ok(mehr.steuer === 'MARGIN' && mehr.notiz === 'Kratzer am Boden',
    `§1b …Steuerart und Artikel-Notiz kommen mit, wie am Rechner (${S(mehr)})`);

  // Die Verkaufsvorstellungen des ARTIKELS haben hier KEIN Feld — der Rechner hat beim Anlegen
  // einer Kommission ebenfalls keines. Die Maske zeigt genau zwei Preise: die Abmachung mit dem
  // Einlieferer. Uebernommen wird trotzdem (und gespeichert — s. §1c).
  const preisfelder = await c.ev(`return {
    verboten: ['cnPlannedSalePrice', 'cnMinSalePrice', 'cnMaxSalePrice']
      .filter((id) => !!document.getElementById(id)),
    sichtbar: Array.from(document.querySelectorAll('#formConsign .row label'))
      .filter((l) => l.offsetParent !== null && /\\(BHD\\)/.test(l.textContent || ''))
      .map((l) => (l.textContent || '').replace(/\\s+/g, ' ').trim()) };`);
  ok(preisfelder.verboten.length === 0,
    `§1b es gibt kein Eingabefeld fuer geplanten/niedrigsten/hoechsten Verkaufspreis (${S(preisfelder.verboten)})`);
  ok(S(preisfelder.sichtbar) === S(['Agreed price (BHD) *', 'Minimum price (BHD)']),
    `§1b …sichtbar sind genau die zwei Preise der Abmachung mit dem Einlieferer (${S(preisfelder.sichtbar)})`);
  ok(mehr.fotos === 1,
    `§1b …und die Bilder des Treffers bleiben AUSSEN, weil schon ein eigenes Foto haengt (${mehr.fotos})`);

  // Dieselbe Uebernahme in ein LEERES Ziel: jetzt kommen die Bilder mit (Regel des Rechners).
  await c.ev(`
    document.querySelectorAll('#cnPhotoStrip .photo-thumb .rm').forEach((b) => b.click());
    return 1;`);
  await sleep(300);
  ok(await c.ev("return document.querySelectorAll('#cnPhotoStrip .photo-thumb').length === 0;"),
    '§1b die Maske ist ohne eigenes Foto');
  await c.ev("document.querySelector('#cnDuplicateList [data-copy-details]').click(); return 1;");
  for (let i = 0; i < 30; i++) {
    const n = await c.ev("return document.querySelectorAll('#cnPhotoStrip .photo-thumb').length;");
    if (n === 2) break;
    await sleep(200);
  }
  const mitBildern = await c.ev("return document.querySelectorAll('#cnPhotoStrip .photo-thumb').length;");
  ok(mitBildern === 2, `§1b …in ein leeres Ziel kopiert sie die Bilder des Treffers mit (${mitBildern})`);
  // …und fuer das Speichern zaehlen sie wie eigene Aufnahmen: ein Foto wieder entfernen, damit der
  // folgende Vergleich der Bildkennungen unveraendert bleibt.
  await c.ev(`
    document.querySelectorAll('#cnPhotoStrip .photo-thumb .rm').forEach((b, i) => { if (i > 0) b.click(); });
    return 1;`);
  await sleep(300);
  const fragen = gesehen.filter((g) => g.body?.op === 'products.duplicates.get');
  ok(fragen.length >= 1 && fragen[0].body.payload.categoryId === 'cat-watch' && fragen[0].body.payload.brand === 'Rolex',
    `§1b die Frage nennt genau die Felder des Fingerabdrucks (${S(fragen[0] && fragen[0].body.payload)})`);
  antwortGeber = vorherGeber;

  await c.ev("document.getElementById('cnCreateAnywayBtn').click(); return 1;");
  await sleep(1000);
  const zweite = gesehen.filter((g) => g.body?.op === 'consignments.create');
  const bestaetigte = zweite.filter((g) => g.body.payload.acknowledgeDuplicate === true);
  ok(zweite.length === 3 && bestaetigte.length === 1
    && zweite.slice(0, 2).every((g) => g.body.commandId !== bestaetigte[0].body.commandId),
    `§1 „Create anyway" ist ein eigener Auftrag mit eigener Kennung (${zweite.length}/${bestaetigte.length})`);
  ok(await c.ev("return /Saved as CON-2026-0007/.test(document.getElementById('cnSuccess').textContent);"),
    '§1 der Mensch sieht die Nummer des Primary');
  // §1c — und die uebernommenen Verkaufsvorstellungen reisen mit, obwohl sie kein Feld haben.
  const angelegt = bestaetigte[0].body.payload.product;
  ok(angelegt.plannedSalePrice === 900 && angelegt.minSalePrice === 800 && angelegt.maxSalePrice === 1000,
    `§1c die uebernommenen Verkaufsvorstellungen werden mitgespeichert, ohne Eingabefeld (${S(angelegt)})`);
  ok(duplikatGefragt === 2, '§1 …und gefragt wurde bei JEDEM unbestaetigten Versuch, nie danach');

  // ── §2 Bearbeiten: nur Geaendertes, Fassung, gesperrtes Modell ──────────────────────────────
  const geladen = await c.ev(`return {
    kopf: document.getElementById('cnHeadline').textContent,
    fotos: document.getElementById('cnPhotoStrip').children.length,
    ware: document.getElementById('cnItemCard').classList.contains('hidden'),
    preis: document.getElementById('cnAgreedPrice').value };`);
  ok(geladen.kopf === 'CON-2026-0007' && geladen.fotos === 2 && geladen.ware && geladen.preis === '500',
    `§2 nach dem Anlegen steht die Kommission da — mit den GESPEICHERTEN Bildern (${S(geladen)})`);

  // §2b — die Vorschau eines GESPEICHERTEN Bildes. Die Medienroute laeuft hinter der Anmeldung;
  // ein nacktes `<img src="/api/media?...">` bekaeme eine Abweisung und zeichnete eine schwarze
  // Kachel. Genau das war der Feldbefund.
  for (let i = 0; i < 30; i++) {
    const fertig = await c.ev(`return Array.from(document.querySelectorAll('#cnPhotoStrip img'))
      .every((e) => (e.getAttribute('src') || '').indexOf('blob:') === 0);`);
    if (fertig) break;
    await sleep(200);
  }
  const quellen = await c.ev(`return Array.from(document.querySelectorAll('#cnPhotoStrip img'))
    .map((e) => (e.getAttribute('src') || '').slice(0, 5));`);
  ok(S(quellen) === S(['blob:', 'blob:']),
    `§2b die Vorschau haengt an einer Objekt-URL, nicht an der Adresse der Medienroute (${S(quellen)})`);
  ok(await c.ev(`return Array.from(document.querySelectorAll('#cnPhotoStrip img'))
    .every((e) => !/\\/api\\/media/.test(e.getAttribute('src') || ''));`),
    '§2b …kein Bild zeigt direkt auf `/api/media`');
  ok(medienAbrufe.length >= 2 && medienAbrufe.every((m) => /^Bearer .+/.test(m.ausweis)),
    `§2b jeder Abruf der Medienroute bringt den Ausweis mit (${S(medienAbrufe.map((m) => !!m.ausweis))})`);
  ok(await c.ev(`return Array.from(document.querySelectorAll('#cnPhotoStrip img'))
    .every((e) => e.naturalWidth > 0);`),
    '§2b …und die Bytes sind wirklich angekommen — die Vorschau ist nicht leer');

  antwortGeber = (u, body) => {
    if (/staging/.test(u)) return { status: 201, body: { stagingId: 'b'.repeat(64) } };
    const op = body && body.op;
    if (op === 'consignments.get') return { status: 200, body: { ok: true, value: KOMMISSION(4, { agreedPrice: 560 }) } };
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    if (op === 'consignments.update') return { status: 200, body: { ok: true, value: {} } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev("document.getElementById('cnAgreedPrice').value = '560'; document.getElementById('cnSaveBtn').click(); return 1;");
  await sleep(900);
  const update = gesehen.filter((g) => g.body?.op === 'consignments.update');
  ok(update.length === 1 && S(Object.keys(update[0].body.payload).sort()) === S(['agreedPrice', 'expectedRevision', 'id'])
    && update[0].body.payload.expectedRevision === 3,
    `§2 nur das geaenderte Feld und die GELESENE Fassung (${S(update[0] && update[0].body.payload)})`);
  ok(await c.ev("return /Changes saved/.test(document.getElementById('cnSuccess').textContent);"),
    '§2 …und die Bestaetigung bleibt stehen');

  // gesperrtes Modell: sichtbar, aber nicht aenderbar
  antwortGeber = (u, body) => {
    const op = body && body.op;
    if (op === 'consignments.get') {
      return { status: 200, body: { ok: true, value: KOMMISSION(5, { payoutLocked: true, salePrice: 700, status: 'sold', payoutAmount: 560, payoutOpenAmount: 560 }) } };
    }
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev("await window.__cnHomeOpen(); return 1;");
  await sleep(300);
  antwortGeber = (u, body) => {
    const op = body && body.op;
    if (op === 'consignments.list') {
      return { status: 200, body: { ok: true, value: { items: [{ id: 'con-1', consignmentNumber: 'CON-2026-0007', agreedPrice: 560, status: 'sold' }] } } };
    }
    if (op === 'consignments.get') {
      return { status: 200, body: { ok: true, value: KOMMISSION(5, { payoutLocked: true, salePrice: 700, status: 'sold', payoutAmount: 560, payoutOpenAmount: 560 }) } };
    }
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    if (op === 'consignments.record_payout') return { status: 200, body: { ok: true, value: {} } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev("document.getElementById('cnSearchBtn').click(); await new Promise((r) => setTimeout(r, 400)); return 1;");
  await c.ev("document.querySelector('#cnList button').click(); await new Promise((r) => setTimeout(r, 600)); return 1;");
  const gesperrt = await c.ev(`return {
    modell: document.getElementById('cnPayoutModel').disabled,
    satz: document.getElementById('cnCommissionRate').disabled,
    hinweis: document.getElementById('cnPayoutLockMsg').textContent,
    verkaufSichtbar: !document.getElementById('cnSaleBtn').classList.contains('hidden'),
    auszahlungSichtbar: !document.getElementById('cnPayoutBtn').classList.contains('hidden'),
    betrag: document.getElementById('cnPayoutAmount').value };`);
  ok(gesperrt.modell && gesperrt.satz && /no longer be changed/.test(gesperrt.hinweis),
    `§2 ein gebuchtes Auszahlungsmodell ist gesperrt — die Sperre kommt vom Primary (${S(gesperrt.hinweis.slice(0, 40))})`);
  ok(!gesperrt.verkaufSichtbar && gesperrt.auszahlungSichtbar && gesperrt.betrag === '560',
    `§2 …ein verkaufter Artikel wird nicht noch einmal verkauft, die offene Auszahlung steht bereit (${S(gesperrt)})`);

  // ── §3 Auszahlung ───────────────────────────────────────────────────────────────────────────
  await c.ev(`
    document.getElementById('cnPayoutMethod').value = 'cash';
    document.getElementById('cnPayoutBtn').click();
    await new Promise((r) => setTimeout(r, 800));
    return 1;`);
  const auszahlung = gesehen.filter((g) => g.body?.op === 'consignments.record_payout');
  ok(auszahlung.length === 1 && auszahlung[0].body.payload.amount === 560
    && auszahlung[0].body.payload.method === 'cash' && auszahlung[0].body.payload.expectedRevision === 5,
    `§3 die Auszahlung nennt Betrag, Weg und Fassung (${S(auszahlung[0] && auszahlung[0].body.payload)})`);

  // ── §2b Was PC2 geaendert hat, sieht das Telefon; ein veralteter Stand ueberschreibt nichts ──
  antwortGeber = (u, body) => {
    const op = body && body.op;
    if (op === 'consignments.list') {
      return { status: 200, body: { ok: true, value: { items: [{ id: 'con-1', consignmentNumber: 'CON-2026-0007', agreedPrice: 777, status: 'active' }] } } };
    }
    // Derselbe Datensatz, von einem ANDEREN Rechner geaendert: neuer Preis, neue Fassung.
    if (op === 'consignments.get') return { status: 200, body: { ok: true, value: KOMMISSION(9, { agreedPrice: 777, notes: 'von PC2' }) } };
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    if (op === 'consignments.update') {
      return { status: 409, body: { ok: false, error: 'RECORD_CHANGED', message: 'this consignment changed in the meantime' } };
    }
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev("document.querySelector('[data-back-consign]').click(); await new Promise((r) => setTimeout(r, 300)); return 1;");
  await c.ev("document.getElementById('cnSearchBtn').click(); await new Promise((r) => setTimeout(r, 400)); return 1;");
  await c.ev("document.querySelector('#cnList button').click(); await new Promise((r) => setTimeout(r, 600)); return 1;");
  const vonPc2 = await c.ev(`return {
    preis: document.getElementById('cnAgreedPrice').value,
    notiz: document.getElementById('cnNotes').value };`);
  ok(vonPc2.preis === '777' && vonPc2.notiz === 'von PC2',
    `§2b eine Aenderung vom anderen Rechner steht nach dem Laden in der Maske (${S(vonPc2)})`);

  await c.ev(`
    document.getElementById('cnAgreedPrice').value = '800';
    document.getElementById('cnSaveBtn').click();
    await new Promise((r) => setTimeout(r, 800));
    return 1;`);
  const nachStale = await c.ev("return document.getElementById('cnError').textContent;");
  ok(/changed this consignment in the meantime|Nothing was overwritten/.test(nachStale),
    `§2b ein veralteter Stand wird abgewiesen, nichts wird ueberschrieben (${S(nachStale.slice(0, 60))})`);

  // ── §2c Die Galerie: behaltene Bilder nach Kennung, neue aus der Ablage ──────────────────────
  antwortGeber = (u, body) => {
    if (/staging/.test(u)) return { status: 201, body: { stagingId: 'c'.repeat(64) } };
    const op = body && body.op;
    if (op === 'consignments.get') return { status: 200, body: { ok: true, value: KOMMISSION(9, { agreedPrice: 777, notes: 'von PC2' }) } };
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    if (op === 'products.update') return { status: 200, body: { ok: true, value: {} } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev(`
    // das zweite gespeicherte Bild entfernen und ein neues aufnehmen
    document.querySelectorAll('#cnPhotoStrip .photo-thumb .rm')[1].click();
    const c2 = document.createElement('canvas'); c2.width = 30; c2.height = 20;
    const x = c2.getContext('2d'); x.fillStyle = '#39c'; x.fillRect(0, 0, 30, 20);
    const blob = await (await fetch(c2.toDataURL('image/jpeg', 0.9))).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'zwei.jpg', { type: 'image/jpeg' }));
    const inp = document.getElementById('cnPhotoInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;`);
  for (let i = 0; i < 30; i++) {
    const sichtbar = await c.ev("return !document.getElementById('cnGallerySaveBtn').classList.contains('hidden');");
    if (sichtbar) break;
    await sleep(200);
  }
  ok(await c.ev("return !document.getElementById('cnGallerySaveBtn').classList.contains('hidden');"),
    '§2c „Save photo changes" erscheint erst, wenn die Galerie wirklich anders ist');
  await c.ev("document.getElementById('cnGallerySaveBtn').click(); await new Promise((r) => setTimeout(r, 900)); return 1;");
  const galerie = gesehen.filter((g) => g.body?.op === 'products.update');
  ok(galerie.length === 1 && S(galerie[0].body.payload.gallery) === S([{ keep: 'm-1' }, { stagingId: 'c'.repeat(64) }])
    && S(Object.keys(galerie[0].body.payload).sort()) === S(['gallery', 'id']),
    `§2c der Galerieauftrag nennt behaltene Kennungen und neue Ablagekennungen — sonst nichts (${S(galerie[0] && galerie[0].body.payload.gallery)})`);

  // ── §2d AI: sie fuellt nur LEERES und speichert nichts ───────────────────────────────────────
  await c.ev("document.querySelector('[data-back-consign]').click(); await new Promise((r) => setTimeout(r, 300)); document.getElementById('cnNewBtn').click(); await new Promise((r) => setTimeout(r, 200)); return 1;");
  antwortGeber = (u, body) => {
    if (/ai\/identify/.test(u)) {
      return { status: 200, body: { result: { brand: 'Omega', name: 'Seamaster', condition: 'Pre-Owned', attributes: { dial: 'Blue' } } } };
    }
    if (/staging/.test(u)) return { status: 201, body: { stagingId: 'd'.repeat(64) } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev(`
    document.getElementById('cnCategory').value = 'cat-watch';
    document.getElementById('cnCategory').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 80));
    document.getElementById('cnBrand').value = 'Rolex';
    const c2 = document.createElement('canvas'); c2.width = 20; c2.height = 20;
    c2.getContext('2d').fillRect(0, 0, 20, 20);
    const blob = await (await fetch(c2.toDataURL('image/jpeg', 0.9))).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'ai.jpg', { type: 'image/jpeg' }));
    const inp = document.getElementById('cnPhotoInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    document.getElementById('cnAiBtn').click();
    await new Promise((r) => setTimeout(r, 800));
    return 1;`);
  const nachAi = await c.ev(`return {
    marke: document.getElementById('cnBrand').value,
    name: document.getElementById('cnName').value,
    zustand: document.getElementById('cnCondition').value,
    dial: document.getElementById('cna_dial') ? document.getElementById('cna_dial').value : '',
    preis: document.getElementById('cnAgreedPrice').value,
    meldung: document.getElementById('cnAiMsg').textContent };`);
  ok(nachAi.marke === 'Rolex' && nachAi.name === 'Seamaster' && nachAi.zustand === 'Pre-Owned' && nachAi.dial === 'Blue',
    `§2d die AI fuellt nur LEERE Felder — auch die Merkmale der Kategorie (${S(nachAi)})`);
  ok(nachAi.preis === '' && /Filled 3 empty fields|Filled/.test(nachAi.meldung),
    `§2d …sie fasst keinen Preis an und sagt, was sie getan hat (${S(nachAi.meldung.slice(0, 50))})`);
  ok(gesehen.filter((g) => g.body?.op === 'consignments.create').length === 3,
    '§2d …und sie speichert nichts');

  // ── §4 Verkauf mit Fehlbetrag: erst das Nein des Primary, dann die Bestaetigung ──────────────
  let verkaufVersuche = 0;
  antwortGeber = (u, body) => {
    const op = body && body.op;
    if (op === 'consignments.list') {
      return { status: 200, body: { ok: true, value: { items: [{ id: 'con-1', consignmentNumber: 'CON-2026-0007', agreedPrice: 560, status: 'active' }] } } };
    }
    if (op === 'consignments.get') return { status: 200, body: { ok: true, value: KOMMISSION(6) } };
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    if (op === 'customers.list') return { status: 200, body: { ok: true, value: { items: [{ id: 'cust-9', firstName: 'Sara', lastName: 'Ahmed' }] } } };
    if (op === 'consignments.record_sale') {
      verkaufVersuche += 1;
      const p = body.payload;
      if (!p.acknowledgeShortfall) {
        return { status: 409, body: { ok: false, error: 'SALE_BELOW_FLOOR', message: 'Sale 300 below consignor floor 500.' } };
      }
      return { status: 200, body: { ok: true, value: {} } };
    }
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev("document.querySelector('[data-back-consign]').click(); await new Promise((r) => setTimeout(r, 300)); return 1;");
  await c.ev("document.getElementById('cnSearchBtn').click(); await new Promise((r) => setTimeout(r, 400)); return 1;");
  await c.ev("document.querySelector('#cnList button').click(); await new Promise((r) => setTimeout(r, 600)); return 1;");
  await c.ev(`
    document.getElementById('cnBuyerSearchBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#cnBuyerResults button').click();
    document.getElementById('cnSalePrice').value = '300';
    document.getElementById('cnSaleBtn').click();
    await new Promise((r) => setTimeout(r, 800));
    return 1;`);
  const nachNein = await c.ev(`return {
    hinweis: document.getElementById('cnShortfallMsg').textContent,
    sichtbar: !document.getElementById('cnShortfallMsg').classList.contains('hidden') };`);
  ok(nachNein.sichtbar && /below consignor floor/.test(nachNein.hinweis),
    `§4 der Fehlbetrag kommt vom PRIMARY, nicht aus einer Rechnung am Telefon (${S(nachNein.hinweis.slice(0, 50))})`);
  const ersterVerkauf = gesehen.filter((g) => g.body?.op === 'consignments.record_sale');
  ok(ersterVerkauf.length === 1 && ersterVerkauf[0].body.payload.acknowledgeShortfall === undefined
    && ersterVerkauf[0].body.payload.buyerId === 'cust-9',
    '§4 …und der erste Versuch hat NICHT vorsorglich bestaetigt');
  await c.ev("document.getElementById('cnSaleBtn').click(); await new Promise((r) => setTimeout(r, 900)); return 1;");
  const beideVerkaeufe = gesehen.filter((g) => g.body?.op === 'consignments.record_sale');
  ok(beideVerkaeufe.length === 2 && beideVerkaeufe[1].body.payload.acknowledgeShortfall === true
    && beideVerkaeufe[0].body.commandId !== beideVerkaeufe[1].body.commandId,
    '§4 die Bestaetigung ist ein eigener Auftrag mit eigener Kennung');
  ok(verkaufVersuche === 2, '§4 …und genau zwei Versuche haben den Primary erreicht');

  // ── §5 Verlorene Antwort: der Vorgang bleibt offen und wird unter DERSELBEN Kennung geklaert ─
  antwortGeber = (u, body) => {
    const op = body && body.op;
    if (op === 'consignments.list') return { status: 200, body: { ok: true, value: { items: [] } } };
    if (op === 'consignments.get') return { status: 200, body: { ok: true, value: KOMMISSION(7) } };
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    if (op === 'consignments.mark_returned') return { status: 504, body: { ok: false, error: 'GATEWAY' } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev("document.getElementById('cnReturnBtn').click(); document.getElementById('cnReturnBtn').click(); await new Promise((r) => setTimeout(r, 900)); return 1;");
  const offen = await c.ev(`
    const db = await new Promise((res, rej) => { const r = indexedDB.open('lataif_mobile_consignment', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const alle = await new Promise((res, rej) => { const r = db.transaction('consignIntents', 'readonly').objectStore('consignIntents').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return alle.map((e) => ({ op: e.op, state: e.state, commandId: e.commandId }));`);
  const offeneRueck = offen.filter((o) => o.op === 'consignments.mark_returned');
  ok(offeneRueck.length === 1 && offeneRueck[0].state === 'unresolved',
    `§5 eine verlorene Antwort laesst den Vorgang durabel offen (${S(offen)})`);
  ok(await c.ev("return !document.getElementById('cnOpenBox').classList.contains('hidden') || document.getElementById('cnOpenList').children.length >= 0;"),
    '§5 …und die Leiste „Unresolved saves" kennt ihn');
  antwortGeber = (u, body) => {
    const op = body && body.op;
    if (op === 'consignments.mark_returned') return { status: 200, body: { ok: true, value: {} } };
    if (op === 'consignments.get') return { status: 200, body: { ok: true, value: KOMMISSION(8, { status: 'returned' }) } };
    if (op === 'products.get') return { status: 200, body: { ok: true, value: ARTIKEL } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev("document.querySelector('[data-back-consign]').click(); await new Promise((r) => setTimeout(r, 400)); return 1;");
  await c.ev("const b = document.querySelector('#cnOpenList button'); if (b) b.click(); await new Promise((r) => setTimeout(r, 900)); return 1;");
  const rueckgaben = gesehen.filter((g) => g.body?.op === 'consignments.mark_returned');
  ok(rueckgaben.length === 2 && rueckgaben[0].body.commandId === rueckgaben[1].body.commandId,
    `§5 „Clarify now" wiederholt DIESELBE Kennung — keine zweite Ruecknahme (${rueckgaben.length})`);

  const protokoll = await c.ev('return window.__PROTOKOLL;');
  ok(protokoll.length === 0, `§6 die Seite hat keinen einzigen Fehler geworfen (${S(protokoll.slice(0, 2))})`);
} catch (e) {
  FAIL += 1;
  fails.push('Lauf abgebrochen: ' + (e && e.message ? e.message : String(e)));
  console.log('  x Lauf abgebrochen: ' + (e && e.stack ? e.stack : e));
} finally {
  if (c) { try { console.log(c.konsole.slice(-5).join('\n')); } catch { /* egal */ } c.close(); }
  if (edge) { try { edge.kill(); } catch { /* egal */ } }
  server.close();
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — preg5 mobile consignment page: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('PRE_G5_MOBILE_CONSIGNMENT_PAGE_PROVED');
