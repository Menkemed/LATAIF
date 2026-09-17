// PRE-G5 MOBILE REPAIR — die Repair-Oberflaeche in einem ECHTEN Browser, gegen einen Attrappen-Server.
//
// Warum zusaetzlich zum Zwei-App-Lauf: dort kostet ein Versuch zehn Minuten (zwei Tauri-Apps,
// Onboarding, echte Datenbank). Hier laufen DIESELBEN drei Dateien (`mobile_repair.html`,
// `mobile_repair_commands.js`, `mobile_repair_ui.js`) in einem echten Edge — mit echtem DOM, echtem
// IndexedDB, echtem fetch — gegen erfundene Antworten. Alles, was zwischen „Attrappe" und „Browser"
// unterschiedlich ist (DOM-Eigenheiten, Ereignisse, Speicher), faellt hier in Sekunden auf.
//
// Der Server ist ein reiner Testserver auf einem freien Port; er beruehrt weder die Produktion noch
// eine Datenbank. Edge laeuft mit eigenem Profil und wird nur ueber die eigene PID beendet.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EDGE = existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9300 + Math.floor(Math.random() * 600); // eigener Port je Lauf: nie an eine fremde/alte Sitzung geraten
const RUN = join(os.tmpdir(), 'lataif-preg5-page', 'run-' + Date.now());
const PROFILE = join(RUN, 'edge');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);

// ── Die Seite: dieselben drei Dateien, dazu die Helfer, die die echte Seite ihnen gibt ──────────
const html = readFileSync(join(repo, 'src-tauri/src/sync/mobile_repair.html'), 'utf8');
const commands = readFileSync(join(repo, 'src-tauri/src/sync/mobile_repair_commands.js'), 'utf8');
const ui = readFileSync(join(repo, 'src-tauri/src/sync/mobile_repair_ui.js'), 'utf8');
// Die Helfer sind WOERTLICH die der Seite (`mobile_page.rs`) — wer sie hier nachbaut, testet seine
// Nachbildung. Deshalb werden sie aus der Seite geschnitten.
const page = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');
/** Eine Funktion aus der Seite holen — ueber die Klammerbilanz, nicht ueber ein Endemuster. */
function funktionAusSeite(kopf) {
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
const helferEl = funktionAusSeite('function el(tag, attrs, text) {');
const helferUuid = funktionAusSeite('function uuid() {');
const helferResize = funktionAusSeite('function resizePhoto(file, maxDim, quality) {');
// Die aufklappbaren Abschnitte sind Sache der SEITE — auch sie woertlich, nicht nachgebaut.
const helferFolds = funktionAusSeite('function foldsWire() {');

// Die Helfer der echten Seite als globale Bausteine — WOERTLICH aus `mobile_page.rs` geschnitten,
// damit dieser Test keine Nachbildung prueft.
const SHIM = `window.__PROTOKOLL = [];
window.onerror = function (m, s, l, c, err) { window.__PROTOKOLL.push('onerror: ' + m + ' @' + l + ':' + c + ' ' + ((err && err.stack) || '')); };
window.addEventListener('unhandledrejection', function (e) { window.__PROTOKOLL.push('unhandled: ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason))); });
var TOKEN_KEY = 'lataif_mobile_token';
localStorage.setItem(TOKEN_KEY, 'token-test');
var $ = function (id) { return document.getElementById(id); };
var show = function (id) { $(id).classList.remove('hidden'); };
var hide = function (id) { $(id).classList.add('hidden'); };
var setText = function (id, t) { var e = $(id); e.textContent = t; if (t) e.classList.remove('hidden'); else e.classList.add('hidden'); };
var SCREENS = ['repairHome', 'formRepair'];
function screen(id) { SCREENS.forEach(function (s) { hide(s); }); show(id); }
${helferEl}
${helferUuid}
${helferResize}
${helferFolds}
foldsWire();
var idbReq = function (req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); };
var echtesFetch = window.fetch.bind(window);
window.fetch = function (u, o) { window.__PROTOKOLL.push('fetch ' + u); return echtesFetch(u, o); };
`;
const UI_DATEI = `(function () {\n${ui}\n  window.__rpHomeOpen = rpHomeOpen;\n})();\n`;

const SEITE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>repair page test</title></head><body>
${html}
<script src="/commands.js"></script>
<script src="/shim.js"></script>
<script src="/ui.js"></script>
</body></html>`;

// Beim Suchen eines Fehlers hilft die Seite selbst: `PREG5_DUMP=<datei>` schreibt sie und endet.
if (process.env.PREG5_DUMP) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.PREG5_DUMP, SEITE);
  console.log('Seite geschrieben: ' + process.env.PREG5_DUMP);
  process.exit(0);
}

// ── Der Attrappen-Server ────────────────────────────────────────────────────────────────────────
let antwortGeber = () => ({ status: 200, body: { ok: true, value: {} } });
const gesehen = [];
const server = createServer((req, res) => {
  if (req.method === 'GET') {
    const js = { '/commands.js': commands, '/shim.js': SHIM, '/ui.js': UI_DATEI }[req.url];
    if (js !== undefined) {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(js);
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

// ── CDP ─────────────────────────────────────────────────────────────────────────────────────────
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.konsole = [];
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        this.konsole.push(m.params.type + ': ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (m.method === 'Log.entryAdded') { this.konsole.push('log: ' + m.params.entry.level + ' ' + m.params.entry.text + ' @' + (m.params.entry.url || '') + ':' + (m.params.entry.lineNumber ?? '?')); }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails; this.konsole.push('pos: Zeile ' + (d?.lineNumber ?? '?') + ' Spalte ' + (d?.columnNumber ?? '?'));
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
  await c.send('Log.enable').catch(() => {});
  await sleep(600);
  const geladen = await c.ev("return !!document.getElementById('rpSaveBtn') && typeof window.__rpHomeOpen === 'function';");
  ok(geladen, 'die Seite laedt: Markup + Befehlsmodul + Oberflaeche');

  // ── §1 Erfassen: der Mensch sieht die Bestaetigung ───────────────────────────────────────────
  antwortGeber = (url, body) => {
    if (/staging/.test(url)) return { status: 201, body: { stagingId: 'a'.repeat(64) } };
    const op = body && body.op;
    if (op === 'customers.create') return { status: 200, body: { ok: true, value: { customerId: 'c1', name: 'Mo Kunde' } } };
    if (op === 'repairs.create') return { status: 200, body: { ok: true, value: { repairId: 'rep-1', repairNumber: 'REP-2026-00042' } } };
    if (op === 'repairs.get') {
      return { status: 200, body: { ok: true, value: { id: 'rep-1', repairNumber: 'REP-2026-00042', revision: 1, status: 'received', issueDescription: 'Krone lose', notes: '', repairType: 'internal', actualCost: null, chargeToCustomer: null, images: [], lines: [], openLineTotal: 0, allowedStatusTargets: ['diagnosed'] } } };
    }
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  await c.ev("document.getElementById('rpNewBtn').click(); return 1;");
  await sleep(300);
  await c.ev("document.getElementById('rpCustomerFirst').value='Mo'; document.getElementById('rpCustomerLast').value='Kunde'; document.getElementById('rpCustomerCreateBtn').click(); return 1;");
  await sleep(800);
  const kundeOk = await c.ev("return !document.getElementById('rpCustomerPicked').classList.contains('hidden');");
  ok(kundeOk, 'der Kunde wird angelegt und gewaehlt');

  await c.ev("document.getElementById('rpIssue').value='Krone lose'; document.getElementById('rpSaveBtn').click(); return 1;");
  for (let i = 0; i < 40; i++) {
    const fertig = await c.ev("return !document.getElementById('rpSaveBtn').disabled;");
    if (fertig) break;
    await sleep(250);
  }
  await sleep(400);
  const zustand = await c.ev(`return JSON.stringify({
    erfolg: document.getElementById('rpSuccess').textContent,
    erfolgSichtbar: !document.getElementById('rpSuccess').classList.contains('hidden'),
    fehler: document.getElementById('rpError').textContent,
    knopf: document.getElementById('rpSaveBtn').textContent,
    protokoll: (window.__PROTOKOLL || []).slice(-12),
  });`);
  const z = JSON.parse(zustand);
  ok(z.erfolgSichtbar && /REP-2026-00042/.test(z.erfolg),
    `§1 die Maske meldet den Erfolg mit der Nummer des Primary (${S(z.erfolg)} / Fehler ${S(z.fehler)})`);
  if (!z.erfolgSichtbar) {
    console.log('      (Diagnose) Konsole: ' + c.konsole.slice(-10).join(' ~ '));
    console.log('      (Diagnose) Seitenprotokoll: ' + S(z.protokoll));
  }
  const create = gesehen.filter((g) => g.body && g.body.op === 'repairs.create');
  ok(create.length === 1, `§1 genau EIN Anlagebefehl (${create.length})`);
  ok(create[0] && !/data:/.test(JSON.stringify(create[0].body)), '§1 im Befehl reisen KEINE Bildbytes');

  // ── §2 Aendern: Rueckmeldung und Fassung ─────────────────────────────────────────────────────
  gesehen.length = 0;
  await c.ev("document.getElementById('rpNotes').value='Am Schalter abgegeben'; document.getElementById('rpSaveBtn').click(); return 1;");
  for (let i = 0; i < 40; i++) {
    const fertig = await c.ev("return !document.getElementById('rpSaveBtn').disabled;");
    if (fertig) break;
    await sleep(250);
  }
  await sleep(400);
  const z2 = JSON.parse(await c.ev(`return JSON.stringify({
    erfolg: document.getElementById('rpSuccess').textContent,
    sichtbar: !document.getElementById('rpSuccess').classList.contains('hidden'),
    fehler: document.getElementById('rpError').textContent,
    protokoll: (window.__PROTOKOLL || []).slice(-8),
  });`));
  const update = gesehen.filter((g) => g.body && g.body.op === 'repairs.update');
  ok(z2.sichtbar && /Changes saved/.test(z2.erfolg), `§2 die Aenderung wird bestaetigt (${S(z2.erfolg)} / ${S(z2.fehler)})`);
  ok(update.length === 1, `§2 genau EIN Aenderungsbefehl (${update.length})`);
  ok(update[0] && update[0].body.payload.expectedRevision === 1 && update[0].body.payload.notes === 'Am Schalter abgegeben',
    `§2 er traegt die gelesene Fassung und nur das geaenderte Feld (${S(update[0] && update[0].body.payload)})`);
  if (!z2.sichtbar) console.log('      (Diagnose §2) ' + S(z2.protokoll) + ' | ' + c.konsole.slice(-8).join(' ~ '));

  // ── §3 Aendern MIT neuem Foto: der Bildplan haelt die gespeicherten und haengt das neue an ────
  gesehen.length = 0;
  // Die Maske steht auf der Reparatur; sie hat ein gespeichertes Bild (aus `repairs.get`).
  antwortGeber = (url, body) => {
    if (/staging/.test(url)) return { status: 201, body: { stagingId: 'c'.repeat(64) } };
    const op = body && body.op;
    if (op === 'repairs.get') {
      return { status: 200, body: { ok: true, value: { id: 'rep-1', repairNumber: 'REP-2026-00042', revision: 2, status: 'received', issueDescription: 'Krone lose', notes: 'Am Schalter abgegeben', repairType: 'internal', actualCost: null, chargeToCustomer: null, workshopSupplierId: '', images: ['data:image/jpeg;base64,AAAA'], lines: [], openLineTotal: 0, allowedStatusTargets: ['diagnosed'] } } };
    }
    if (op === 'repairs.update') return { status: 200, body: { ok: true, value: { repairId: 'rep-1' } } };
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  // Erst neu laden, damit die Maske ein GESPEICHERTES Bild kennt.
  await c.ev("window.__rpHomeOpen(); return 1;");
  await sleep(400);
  await c.ev("document.getElementById('rpSearch').value=''; return 1;");
  antwortGeber = ((frueher) => (url, body) => {
    const op = body && body.op;
    if (op === 'repairs.list') return { status: 200, body: { ok: true, value: { items: [{ id: 'rep-1', repairNumber: 'REP-2026-00042', itemBrand: 'Rolex', itemModel: 'DJ', status: 'received' }] } } };
    return frueher(url, body);
  })(antwortGeber);
  await c.ev("document.getElementById('rpSearchBtn').click(); return 1;");
  await sleep(600);
  await c.ev("const b=document.querySelectorAll('#rpList button')[0]; if (b) b.click(); return 1;");
  await sleep(700);
  const vorFoto = await c.ev("return document.querySelectorAll('#rpPhotoStrip .photo-thumb').length;");
  ok(vorFoto === 1, `§3 das gespeicherte Bild steht in der Maske (${vorFoto})`);

  // Ein neues Foto wie von der Kamera: ueber den Datei-Eingang.
  await c.ev(`
    const c2 = document.createElement('canvas'); c2.width = 40; c2.height = 30;
    const x = c2.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 40, 30);
    const dataUrl = c2.toDataURL('image/jpeg', 0.9);
    const blob = await (await fetch(dataUrl)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'neu.jpg', { type: 'image/jpeg' }));
    const inp = document.getElementById('rpPhotoInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;`);
  for (let i = 0; i < 30; i++) {
    const n = await c.ev("return document.querySelectorAll('#rpPhotoStrip .photo-thumb').length;");
    if (n === 2) break;
    await sleep(200);
  }
  const nachFoto = await c.ev("return document.querySelectorAll('#rpPhotoStrip .photo-thumb').length;");
  ok(nachFoto === 2, `§3 das neue Foto liegt daneben (${nachFoto})`);

  await c.ev("document.getElementById('rpSaveBtn').click(); return 1;");
  for (let i = 0; i < 60; i++) {
    const fertig = await c.ev("return !document.getElementById('rpSaveBtn').disabled;");
    if (fertig) break;
    await sleep(250);
  }
  await sleep(400);
  const z3 = JSON.parse(await c.ev(`return JSON.stringify({
    erfolg: document.getElementById('rpSuccess').textContent,
    sichtbar: !document.getElementById('rpSuccess').classList.contains('hidden'),
    fehler: document.getElementById('rpError').textContent,
    protokoll: (window.__PROTOKOLL || []).slice(-10),
  });`));
  const up3 = gesehen.filter((g) => g.body && g.body.op === 'repairs.update');
  ok(z3.sichtbar, `§3 die Aenderung mit Foto wird bestaetigt (${S(z3.erfolg)} / Fehler ${S(z3.fehler)})`);
  ok(up3.length === 1 && !("repairType" in up3[0].body.payload) && !("actualCost" in up3[0].body.payload) && !("chargeToCustomer" in up3[0].body.payload),
    `§3 kein Feld im Rumpf, das die Maske nicht zeigt (${S(up3[0] && Object.keys(up3[0].body.payload))})`);
  ok(up3.length === 1 && S(up3[0].body.payload.photos) === S([{ keep: 0 }, { stagingId: 'c'.repeat(64) }]),
    `§3 der Bildplan ist {keep:0} + neue Kennung (${S(up3[0] && up3[0].body.payload.photos)})`);
  if (!z3.sichtbar) console.log('      (Diagnose §3) ' + S(z3.protokoll) + ' | ' + c.konsole.slice(-10).join(' ~ '));

  // ── §4 Werkstattwege: Arbeitszeile, Storno, Material, Gold, Rechnung ─────────────────────────
  {
    const rep = {
      id: 'rep-1', repairNumber: 'REP-2026-00042', revision: 5, status: 'ready',
      issueDescription: 'Krone lose', notes: '', repairType: 'internal', actualCost: null,
      chargeToCustomer: 40, workshopSupplierId: '', images: [], openLineTotal: 12,
      lines: [{ id: 'line-1', workType: 'service', costAmount: 12, status: 'OPEN', editable: true }],
      allowedStatusTargets: [], invoiceId: '',
    };
    antwortGeber = (url, body) => {
      const op = body && body.op;
      if (op === 'repairs.get') return { status: 200, body: { ok: true, value: rep } };
      if (op === 'repairs.list') return { status: 200, body: { ok: true, value: { items: [{ id: 'rep-1', repairNumber: 'REP-2026-00042', status: 'ready' }] } } };
      if (op === 'suppliers.list') return { status: 200, body: { ok: true, value: { items: [{ id: 'sup-1', name: 'Gold Souq Works' }] } } };
      return { status: 200, body: { ok: true, value: {} } };
    };
    await c.ev("window.__rpHomeOpen(); return 1;");
    await sleep(500);
    await c.ev("document.getElementById('rpSearchBtn').click(); return 1;");
    await sleep(600);
    await c.ev("const b=document.querySelectorAll('#rpList button')[0]; if (b) b.click(); return 1;");
    await sleep(900);
    const werkstattDa = await c.ev("return !document.getElementById('rpWorkCard').classList.contains('hidden') && document.querySelectorAll('#rpLineSupplier option').length >= 2;");
    ok(werkstattDa, '§4 die Werkstattkarte steht an einer bestehenden Reparatur, mit Lieferanten');

    // Die vier Werkstattwege liegen ZU — ein Telefon hat wenig Platz. Der Kopf ist der Schalter.
    const zu = await c.ev(`return Array.from(document.querySelectorAll('#rpWorkCard .fold'))
      .map((f) => f.id + ':' + (f.querySelector('.fold-body').classList.contains('hidden') ? 'zu' : 'auf')).join(',');`);
    ok(zu === 'rpFoldLine:zu,rpFoldMaterial:zu,rpFoldGold:zu,rpFoldInvoice:zu',
      `§4b beim Oeffnen liegen alle vier Abschnitte zu (${zu})`);
    const aufklappen = async (id) => c.ev(`document.querySelector('[data-fold="${id}"]').click();
      return document.getElementById('${id}').classList.contains('open')
        && !document.querySelector('#${id} .fold-body').classList.contains('hidden');`);
    ok(await aufklappen('rpFoldLine'), '§4b ein Tipp auf den Kopf klappt den Abschnitt auf');
    const nurEiner = await c.ev(`return document.querySelector('#rpFoldMaterial .fold-body').classList.contains('hidden');`);
    ok(nurEiner, '§4b …und nur diesen einen — die anderen bleiben, wie sie waren');
    ok(await c.ev(`document.querySelector('[data-fold="rpFoldLine"]').click();
      return document.querySelector('#rpFoldLine .fold-body').classList.contains('hidden')
        && !document.getElementById('rpFoldLine').classList.contains('open');`),
      '§4b derselbe Tipp klappt ihn wieder zu');
    for (const f of ['rpFoldLine', 'rpFoldMaterial', 'rpFoldGold', 'rpFoldInvoice']) await aufklappen(f);

    const knopf = async (id, vorbereiten) => {
      gesehen.length = 0;
      if (vorbereiten) await c.ev(vorbereiten + ' return 1;');
      await c.ev(`document.getElementById('${id}').click(); return 1;`);
      for (let i = 0; i < 40; i++) {
        if (gesehen.some((g) => g.body && g.body.op && g.body.op !== 'repairs.get' && g.body.op !== 'suppliers.list')) break;
        await sleep(200);
      }
      await sleep(400);
      return gesehen.filter((g) => g.body && g.body.op && g.body.op !== 'repairs.get' && g.body.op !== 'suppliers.list');
    };

    const linie = await knopf('rpLineAddBtn', "document.getElementById('rpLineCost').value='12.5'; document.getElementById('rpLineType').value='polishing'; document.getElementById('rpLineSupplier').value='sup-1';");
    ok(linie.length === 1 && linie[0].body.op === 'repairs.add_line'
      && linie[0].body.payload.costAmount === 12.5 && linie[0].body.payload.expectedRevision === 5
      && linie[0].body.payload.supplierId === 'sup-1',
    `§4 „Add work line" sendet repairs.add_line mit Betrag, Art, Lieferant und Fassung (${S(linie[0] && linie[0].body.payload)})`);

    const ohneBetrag = await knopf('rpLineAddBtn', "document.getElementById('rpLineCost').value='';");
    const meldung = await c.ev("return document.getElementById('rpWorkMsg').textContent;");
    ok(ohneBetrag.length === 0 && /cost greater than zero/.test(meldung),
      `§4 ohne Betrag geht NICHTS hinaus, die Maske sagt es (${S(meldung)})`);

    const material = await knopf('rpMatAddBtn', "document.getElementById('rpMatKind').value='gold'; document.getElementById('rpMatText').value='21K Draht'; document.getElementById('rpMatSupplier').value='sup-1'; document.getElementById('rpMatCost').value='30'; document.getElementById('rpMatWeight').value='3.5'; document.getElementById('rpMatKarat').value='21K';");
    ok(material.length === 1 && material[0].body.op === 'repairs.add_material'
      && material[0].body.payload.rows.length === 1 && material[0].body.payload.rows[0].weightGrams === 3.5
      && material[0].body.payload.rows[0].karat === '21K' && !('caratPerPiece' in material[0].body.payload.rows[0]),
    `§4 „Add material" sendet repairs.add_material als eine Position (${S(material[0] && material[0].body.payload.rows)})`);

    const gold = await knopf('rpGoldAddBtn', "document.getElementById('rpGoldSource').value='customer'; document.getElementById('rpGoldSource').dispatchEvent(new Event('change')); document.getElementById('rpGoldKarat').value='18K'; document.getElementById('rpGoldReceived').value='8'; document.getElementById('rpGoldUsed').value='6'; document.getElementById('rpGoldLeftover').value='credit';");
    ok(gold.length === 1 && gold[0].body.op === 'repairs.record_gold_usage'
      && gold[0].body.payload.leftover === 'credit' && !('supplierId' in gold[0].body.payload),
    `§4 „Record gold" sendet Kundengold ohne Lieferant (${S(gold[0] && gold[0].body.payload)})`);

    const rechnung = await knopf('rpInvoiceBtn', "document.getElementById('rpTaxScheme').value='VAT_10';");
    ok(rechnung.length === 1 && rechnung[0].body.op === 'repairs.create_invoice'
      && rechnung[0].body.payload.taxScheme === 'VAT_10' && rechnung[0].body.payload.expectedRevision === 5,
    `§4 „Create invoice" sendet repairs.create_invoice mit Steuerart und Fassung (${S(rechnung[0] && rechnung[0].body.payload)})`);

    // Storno: zwei Klicks (der erste fragt nach), dann geht genau ein Befehl hinaus.
    gesehen.length = 0;
    await c.ev("const b=document.querySelector('[data-line-cancel]'); b.click(); return 1;");
    const nachfrage = await c.ev("return document.querySelector('[data-line-cancel]').textContent;");
    const sofort = gesehen.filter((g) => g.body && g.body.op === 'repairs.cancel_line').length;
    await c.ev("const b=document.querySelector('[data-line-cancel]'); b.click(); return 1;");
    for (let i = 0; i < 40; i++) { if (gesehen.some((g) => g.body && g.body.op === 'repairs.cancel_line')) break; await sleep(200); }
    const storno = gesehen.filter((g) => g.body && g.body.op === 'repairs.cancel_line');
    ok(/Really cancel/.test(nachfrage) && sofort === 0 && storno.length === 1
      && storno[0].body.payload.lineId === 'line-1' && storno[0].body.payload.expectedRevision === 5,
    `§4 „Cancel line" fragt erst nach und sendet dann genau einmal (${S(nachfrage)}; ${S(storno[0] && storno[0].body.payload)})`);

    // Eine bereits fakturierte Reparatur bietet keine zweite Rechnung an.
    rep.invoiceId = 'inv-1';
    await c.ev("window.__rpHomeOpen(); return 1;");
    await sleep(400);
    await c.ev("document.getElementById('rpSearchBtn').click(); return 1;");
    await sleep(500);
    await c.ev("const b=document.querySelectorAll('#rpList button')[0]; if (b) b.click(); return 1;");
    await sleep(800);
    const versteckt = await c.ev("return document.getElementById('rpInvoiceBtn').classList.contains('hidden');");
    ok(versteckt, '§4 eine fakturierte Reparatur bietet keine zweite Rechnung an');
  }
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
  if (c) console.log('      Konsole: ' + c.konsole.slice(-10).join(' ~ '));
} finally {
  try { c?.close(); } catch { /* zu */ }
  try { edge?.kill(); } catch { /* zu */ }
  try { server.close(); } catch { /* zu */ }
  try { rmSync(RUN, { recursive: true, force: true }); } catch { /* egal */ }
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — preg5 mobile repair page: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('PRE_G5_MOBILE_REPAIR_PAGE_PROVED');
