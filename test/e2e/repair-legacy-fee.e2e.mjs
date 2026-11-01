// ════════════════════════════════════════════════════════════════════════════
// ALTGEBÜHR — eine Werkstatt mit Gebühr im Kopf, ohne Zeile, in der echten Test-App (nur Primary), mit echtem Neustart.
// Run: node test/e2e/repair-legacy-fee.e2e.mjs
//
//   START  Ein Neustart lässt sie unverändert: keine Zeile, keine Buchung, keine Änderung an Kosten oder Marge.
//   KLICK  Nur „Turn into a work line" macht daraus eine Zeile; die Summe bleibt.
//   READY  Ohne Umwandlung wird bei „Ready" genau einmal gebucht, davor nichts.
//   NACHHER Umwandlung vor und nach „Ready": die Verbindlichkeit steht genau einmal da, nichts doppelt.
//   BEZAHLT Eine ganz oder teilweise bezahlte Gebühr wird nicht umgewandelt: klarer Grund, nichts geändert.
//
// Isoliert: com.lataif.app.e2e, Port 3011 — Produktion und E:\LATAIF\Data bleiben unberührt.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, killTestPid, spawnTracked, startedPids, waitPidGone, waitTestImageGone } from './_e2e-process.mjs';
import { maus, sichtbar, tippe } from './_e2e-mouse.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const RUN = join(os.tmpdir(), 'lataif-legacy-fee', 'run-' + Date.now());
const APP_DATA_DIR = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const env = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const aufraeumen = () => { killStarted(); killTestImage('lataif.exe'); };
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze erreicht.'); aufraeumen(); process.exit(1); }, 15 * 60 * 1000);

function dbQ(sql, params = []) {
  let db;
  try { db = new DatabaseSync(BIZ_DB, { readOnly: true }); return db.prepare(sql).all(...params); }
  catch (e) { console.log('      (db) ' + String(e)); return []; }
  finally { try { db?.close(); } catch { /* zu */ } }
}
class CDP {
  constructor(u) {
    this.ws = new WebSocket(u); this.id = 0; this.p = new Map();
    this.ready = new Promise((a, b) => { this.ws.addEventListener('open', a); this.ws.addEventListener('error', b); });
    this.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { res, rej } = this.p.get(m.id); this.p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  async send(method, params = {}) { await this.ready; const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(x) { const r = await this.send('Runtime.evaluate', { expression: `(async () => { ${x} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
  close() { try { this.ws.close(); } catch { /* zu */ } }
}
async function attach() {
  for (let i = 0; i < 300; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json();
      const p = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
      if (p) { const c = new CDP(p.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c; }
    } catch { /* noch nicht oben */ }
    await sleep(400);
  }
  throw new Error('no page');
}
const warte = async (c, x, t = 45000) => { const e = Date.now() + t; while (Date.now() < e) { try { if (await c.ev(`return !!(${x});`)) return true; } catch { /* baut */ } await sleep(300); } return false; };
const warteAuf = async (f, s = 25) => { for (let i = 0; i < s * 2; i++) { if (f()) return true; await sleep(500); } return false; };
const SHELL = `document.querySelector('a[href="/settings"]')`;
const set = (c, s, v) => c.ev(`const e=document.querySelector(${S(s)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
const txt = (c, t) => c.ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)})?.click(); return 1;`);
const zahl = (s) => { const n = parseFloat(String(s).replace(/,/g, '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; };
const text = (c, s) => c.ev(`const e=document.querySelector(${S(s)}); return e ? e.textContent.trim() : '';`);

function insert(db, tabelle, werte) {
  const spalten = db.prepare(`PRAGMA table_info(${tabelle})`).all();
  const daten = { ...werte };
  for (const sp of spalten) {
    if (!sp.notnull || sp.dflt_value !== null || sp.pk || daten[sp.name] !== undefined) continue;
    daten[sp.name] = /INT|REAL|NUM/.test(String(sp.type).toUpperCase()) ? 0 : (/_at$|date/i.test(sp.name) ? new Date().toISOString() : '');
  }
  const nutzbar = Object.keys(daten).filter((k) => spalten.some((s) => s.name === k));
  db.prepare(`INSERT INTO ${tabelle} (${nutzbar.join(', ')}) VALUES (${nutzbar.map(() => '?').join(', ')})`).run(...nutzbar.map((k) => daten[k]));
}
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    const branch_id = db.prepare('SELECT id FROM branches LIMIT 1').get().id;
    const now = new Date().toISOString();
    insert(db, 'suppliers', { id: 'ws-b', branch_id, name: 'Werkstatt B', active: 1, is_workshop: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'k', branch_id, first_name: 'E2E', last_name: 'Kunde', country: 'BH', language: 'en', vip_level: 'NONE', preferences: '[]', customer_type: 'PRIVATE', sales_stage: 'active', created_at: now, updated_at: now });
    const alt = { branch_id, images: '[]', item_attributes: '{}', revision: 1, repair_scope: 'CUSTOMER', customer_id: 'k', tax_scheme: 'ZERO', item_brand: 'Omega', item_model: 'De Ville', received_at: now, created_at: now, updated_at: now, status: 'received', repair_type: 'external', workshop_supplier_id: 'ws-b', issue_description: 'Service', charge_to_customer: 35 };
    insert(db, 'repairs', { ...alt, id: 'a', repair_number: 'REP-ALT-A', voucher_code: 'A', estimated_cost: 18 });
    insert(db, 'repairs', { ...alt, id: 'b', repair_number: 'REP-ALT-B', voucher_code: 'B', estimated_cost: 18 });
    insert(db, 'repairs', { ...alt, id: 'c', repair_number: 'REP-ALT-C', voucher_code: 'C', estimated_cost: 18 });
    insert(db, 'repairs', { ...alt, id: 'p', repair_number: 'REP-ALT-P', voucher_code: 'P', estimated_cost: 18 });
    insert(db, 'repairs', { ...alt, id: 'q', repair_number: 'REP-ALT-Q', voucher_code: 'Q', estimated_cost: 18 });
    // Erfasster Aufwand ≠ Voranschlag: die frühere Umwandlung hätte hier die Summe still geändert.
    insert(db, 'repairs', { ...alt, id: 'e', repair_number: 'REP-ALT-E', voucher_code: 'E', estimated_cost: 18, actual_cost: 25 });
  } finally { db.close(); }
}
const kopf = (id) => dbQ('SELECT repair_type typ, status, workshop_supplier_id ws, estimated_cost est, actual_cost ist, internal_cost own, margin, revision, updated_at FROM repairs WHERE id = ?', [id])[0] || {};
const zeilen = (id) => dbQ("SELECT id, supplier_id ws, work_type art, cost_amount kosten, expense_id ex FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'", [id]);
const ausgaben = (id) => dbQ("SELECT id, amount, status FROM expenses WHERE ((related_module = 'repair' AND related_entity_id = ?) OR id IN (SELECT expense_id FROM repair_lines WHERE repair_id = ?)) AND status != 'CANCELLED'", [id, id]);
const alleAusgaben = (id) => dbQ("SELECT id FROM expenses WHERE (related_module = 'repair' AND related_entity_id = ?) OR id IN (SELECT expense_id FROM repair_lines WHERE repair_id = ?)", [id, id]);
/** Was an die Werkstatt offen ist: Haben minus Soll auf ACCOUNTS_PAYABLE aller Ausgaben dieser Reparatur (Stornos eingerechnet). */
const schuld = (id) => {
  const ids = alleAusgaben(id).map((e) => e.id);
  if (!ids.length) return 0;
  const r = dbQ(`SELECT direction d, amount a FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND source_module = 'EXPENSE' AND source_id IN (${ids.map(() => '?').join(',')})`, ids);
  return r.reduce((s, x) => s + (x.d === 'CREDIT' ? x.a : -x.a), 0);
};
const stand = () => S(['a', 'b', 'c', 'e', 'p', 'q'].map((id) => [kopf(id), dbQ('SELECT * FROM repair_lines WHERE repair_id = ?', [id])])) + S(dbQ('SELECT * FROM expenses')) + S(dbQ('SELECT * FROM ledger_entries'));

let c = null;
const stub = () => c.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
async function zuUndAuf() {
  const pid = startedPids().pop();
  c.close(); c = null;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).CloseMainWindow()`], { encoding: 'utf8', windowsHide: true });
  if (!await waitPidGone(pid, 120000)) killTestPid(pid, APP);
}
async function start() {
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach();
  await warte(c, SHELL, 120000);
  await stub();
}
const geh = async (route) => { await c.ev(`history.pushState({}, '', '/tasks'); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`); await sleep(300); await c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`); await sleep(500); };
async function bis(id, ziel, nachSchritt) {
  await geh(`/repairs/${id}`);
  for (let i = 0; i < 8 && kopf(id).status !== ziel; i++) {
    if (!await warte(c, `document.querySelector('[data-repair-advance]')`, 15000)) break;
    const vor = kopf(id).status;
    await maus(c, '[data-repair-advance]');
    await warteAuf(() => kopf(id).status !== vor, 12);
    await sleep(500);
    if (nachSchritt && kopf(id).status !== ziel) nachSchritt(kopf(id).status);
  }
  return kopf(id).status;
}
const gesamt = () => text(c, '[data-repair-cost-box="total"]').then(zahl);

try {
  aufraeumen(); await waitTestImageGone('lataif.exe');
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: env() }));
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach();
  await warte(c, `document.querySelector('[data-first-run-gate], input[placeholder="e.g. Al-Khalifa Luxury"]')`, 90000);
  if (await c.ev(`return !!document.querySelector('[data-first-run-new]');`)) { await c.ev(`document.querySelector('[data-first-run-new]').click(); return 1;`); await sleep(1500); }
  await warte(c, `document.querySelector('input[placeholder="e.g. Al-Khalifa Luxury"]')`);
  await set(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'Alt'); await set(c, 'input[placeholder="e.g. Main Store"]', 'Alt');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="Full name"]')`);
  await set(c, 'input[placeholder="Full name"]', 'Alt'); await set(c, 'input[placeholder="you@company.com"]', 'admin@lataif.com'); await set(c, 'input[placeholder="Choose a password"]', 'e2epass123');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="10"]')`);
  await set(c, 'input[placeholder="10"]', '10');
  await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  await warte(c, SHELL, 90000);
  await zuUndAuf();
  seed();
  const vorStart = stand();

  // ══ START — zwei echte Neustarts ══
  await start();
  await sleep(1500);
  ok(stand() === vorStart, 'START 1. Start: Reparaturen, Zeilen, Ausgaben und Hauptbuch in der Datei unverändert');
  await geh('/repairs/a');
  ok(await warte(c, `document.querySelector('[data-repair-legacy-fee]')`, 20000), 'START die Altgebühr steht als Altgebühr da, nicht als Zeile');
  ok(await sichtbar(c, '[data-repair-legacy-convert]'), 'START der Knopf „Turn into a work line" ist sichtbar');
  ok(await gesamt() === 18, 'START Gesamtkosten 18 aus der Gebühr');
  await geh('/repairs/e');
  await warte(c, `document.querySelector('[data-repair-cost-box="total"]')`, 15000);
  ok(await gesamt() === 18, `START Aufwand 25 ≠ Voranschlag 18: die Summe bleibt 18, wird nicht still zu 25 (${await gesamt()})`);
  await zuUndAuf(); await start();
  await sleep(1500);
  ok(stand() === vorStart, 'START 2. Start: weiterhin unverändert');
  ok(['a', 'b', 'c', 'e'].every((id) => zeilen(id).length === 0), 'START keine einzige Zeile entstanden');

  // ══ READY — ohne Umwandlung: vor „Ready" nichts, dann genau einmal ══
  {
    const vorher = [];
    const st = await bis('b', 'ready', (s) => vorher.push([s, ausgaben('b').length]));
    ok(st === 'ready', `READY erreicht (${st})`);
    ok(vorher.length >= 2 && vorher.every((x) => x[1] === 0), `READY davor keine Buchung (${S(vorher)})`);
    await warteAuf(() => ausgaben('b').length > 0, 10);
    const a = ausgaben('b');
    ok(a.length === 1 && a[0].amount === 18, `READY genau eine Ausgabe über 18 (${S(a)})`);
    ok(Math.abs(schuld('b') - 18) < 0.0005, `READY Verbindlichkeit genau 18 (${schuld('b')})`);
    ok(zeilen('b').length === 0, 'READY die Gebühr bleibt Gebühr, keine Zeile');
    await warte(c, `document.querySelector('[data-repair-cost-box="margin"]')`, 10000);
    ok(await gesamt() === 18 && zahl(await text(c, '[data-repair-cost-box="margin"]')) === 17, `READY Kosten 18, Marge 17 (${await text(c, '[data-repair-cost-summary]')})`);
    const vorNeustart = S([ausgaben('b'), schuld('b'), zeilen('b')]);
    await zuUndAuf(); await start();
    await sleep(1500);
    ok(S([ausgaben('b'), schuld('b'), zeilen('b')]) === vorNeustart, 'READY Neustart ändert daran nichts');
  }
  // ══ KLICK — vor „Ready" umwandeln: danach läuft die Zeile nach ihrer Regel, genau eine Buchung ══
  {
    await geh('/repairs/a');
    await warte(c, `document.querySelector('[data-repair-legacy-convert]')`, 20000);
    ok(await maus(c, '[data-repair-legacy-convert]') === 'OK', 'KLICK „Turn into a work line" per Maus');
    ok(await warteAuf(() => zeilen('a').length === 1), 'KLICK Zeile entstanden');
    const z = zeilen('a')[0];
    ok(z.ws === 'ws-b' && z.kosten === 18 && z.art === 'service', `KLICK Zeile der Werkstatt über die Gebühr (${S(z)})`);
    ok(ausgaben('a').length === 0, 'KLICK der Klick selbst bucht nichts');
    ok(await warte(c, `!document.querySelector('[data-repair-legacy-fee]')`, 10000), 'KLICK der Hinweis ist weg');
    await warte(c, `document.querySelector('[data-repair-cost-box="total"]')`, 10000);
    ok(await gesamt() === 18, 'KLICK Summe unverändert 18');
    ok(kopf('a').typ === 'external', `KLICK Art bleibt External (${kopf('a').typ})`);
    // Eine Arbeitszeile bucht nach ihrer bestehenden Regel ab „In Progress", die Gebühr erst bei „Ready" (siehe READY).
    const schritte = [];
    const st = await bis('a', 'ready', (s) => schritte.push([s, ausgaben('a').length]));
    ok(st === 'ready', `KLICK bis Ready (${st})`);
    ok(S(schritte.filter((x) => x[0] === 'diagnosed')) === S([['diagnosed', 0]]) && schritte.filter((x) => x[0] !== 'diagnosed').every((x) => x[1] === 1), `KLICK Zeile bucht ab „In Progress", davor nichts (${S(schritte)})`);
    await warteAuf(() => ausgaben('a').length > 0, 10);
    const a = ausgaben('a');
    ok(a.length === 1 && a[0].amount === 18 && Math.abs(schuld('a') - 18) < 0.0005, `KLICK genau eine Ausgabe, Verbindlichkeit 18 (${S(a)}, ${schuld('a')})`);
  }
  // ══ NACHHER — erst „Ready" (Gebühr gebucht), dann umwandeln: die Verbindlichkeit wird nicht doppelt ══
  {
    ok(await bis('c', 'ready') === 'ready', 'NACHHER bis Ready');
    await warteAuf(() => ausgaben('c').length > 0, 10);
    ok(ausgaben('c').length === 1 && Math.abs(schuld('c') - 18) < 0.0005, `NACHHER Gebühr gebucht (${S(ausgaben('c'))})`);
    await warte(c, `document.querySelector('[data-repair-legacy-convert]')`, 15000);
    ok(await maus(c, '[data-repair-legacy-convert]') === 'OK', 'NACHHER „Turn into a work line"');
    ok(await warteAuf(() => zeilen('c').length === 1), 'NACHHER Zeile entstanden');
    await sleep(1200);
    const a = ausgaben('c');
    ok(a.length === 1 && a[0].amount === 18, `NACHHER genau eine offene Ausgabe über 18 (${S(a)})`);
    ok(Math.abs(schuld('c') - 18) < 0.0005, `NACHHER Verbindlichkeit bleibt 18, nicht 36 (${schuld('c')})`);
    await warte(c, `document.querySelector('[data-repair-cost-box="total"]')`, 10000);
    ok(await gesamt() === 18, 'NACHHER Summe 18');
    const nach = S([ausgaben('c'), schuld('c'), zeilen('c').length]);
    await zuUndAuf(); await start();
    await sleep(1500);
    ok(S([ausgaben('c'), schuld('c'), zeilen('c').length]) === nach, 'NACHHER Neustart ändert nichts');
  }
  // ══ BEZAHLT — die Gebühr ist bezahlt: sie bleibt, die Umwandlung wird abgewiesen, nichts halb geändert ══
  for (const [id, betrag, wort] of [['p', '18', 'ganz'], ['q', '5', 'teilweise']]) {
    ok(await bis(id, 'ready') === 'ready', `BEZAHLT ${wort}: bis Ready`);
    await warteAuf(() => ausgaben(id).length === 1, 10);
    const ex = ausgaben(id)[0];
    await geh('/expenses');
    await warte(c, `document.querySelector('[data-expense-pay-open=${S(ex.id)}]')`, 20000);
    ok(await maus(c, `[data-expense-pay-open=${S(ex.id)}]`) === 'OK', `BEZAHLT ${wort}: „Pay" an der Ausgabe`);
    await warte(c, `document.querySelector('[data-expense-pay-amount]')`, 8000);
    await tippe(c, '[data-expense-pay-amount]', betrag);
    await maus(c, '[data-expense-pay-save]');
    ok(await warteAuf(() => Math.abs(Number(dbQ('SELECT paid_amount p FROM expenses WHERE id = ?', [ex.id])[0]?.p) - Number(betrag)) < 0.0005), `BEZAHLT ${wort}: ${betrag} bezahlt`);
    await sleep(600);
    const belege = () => S([zeilen(id), dbQ('SELECT id, amount, paid_amount, status FROM expenses WHERE id = ?', [ex.id]), alleAusgaben(id), kopf(id), dbQ(`SELECT * FROM ledger_entries WHERE source_id = ? ORDER BY rowid`, [ex.id]), dbQ('SELECT COUNT(*) n FROM ledger_entries')]);
    const vorher = belege();
    await geh(`/repairs/${id}`);
    await warte(c, `document.querySelector('[data-repair-legacy-convert]')`, 15000);
    ok(await maus(c, '[data-repair-legacy-convert]') === 'OK', `BEZAHLT ${wort}: „Turn into a work line" geklickt`);
    ok(await warte(c, `/already paid/i.test(document.querySelector('[data-save-error]')?.textContent || '')`, 15000), `BEZAHLT ${wort}: der Grund steht da (${await text(c, '[data-save-error]')})`);
    await sleep(1000);
    ok(belege() === vorher, `BEZAHLT ${wort}: Zeilen, Ausgabe, Art und Hauptbuch unverändert`);
    ok(zeilen(id).length === 0, `BEZAHLT ${wort}: keine Zeile`);
    await warte(c, `document.querySelector('[data-repair-cost-box="total"]')`, 10000);
    ok(await gesamt() === 18 && await sichtbar(c, '[data-repair-legacy-fee]'), `BEZAHLT ${wort}: die Gebühr bleibt, Summe 18`);
    const nachKlick = belege();
    await zuUndAuf(); await start();
    await sleep(1500);
    ok(belege() === nachKlick, `BEZAHLT ${wort}: Neustart ändert nichts, nichts war halb gespeichert`);
  }
  ok(zeilen('e').length === 0 && kopf('e').ist === 25 && kopf('e').est === 18, 'ENDE die nicht angefasste Altreparatur steht wie am Anfang');
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e)); console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  try { c?.close(); } catch { /* zu */ }
  aufraeumen(); await waitTestImageGone('lataif.exe');
  clearTimeout(WACHHUND);
}
if (FAIL > 0) { console.log(`\nFAIL — repair legacy fee: ${PASS} passed, ${FAIL} failed`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log(`\nPASS — repair legacy fee: ${PASS} passed, 0 failed`);
console.log('REPAIR_LEGACY_FEE_E2E_PROVED');
