// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1a — der Primary ändert eine Rechnung über seine Maske: exklusiv (runOnPrimary), gegen
// die beim Öffnen gesehene Fassung. Echte Bedienung in der isolierten Test-App (nur Primary).
// Run: node test/e2e/p1a-primary-edit.e2e.mjs
//
//   EDIT     Rechnung über /invoices/new anlegen, über /invoices/:id/edit ändern und speichern → Datenbank stimmt.
//   NEUSTART App schließen und neu starten → die Änderung ist dauerhaft gespeichert, nichts doppelt.
//   STALE    Zwei Bearbeitungsansichten derselben Rechnung: die Maske des Primary ist offen, eine zweite
//            Ansicht (PC2-Weg, echter Befehl `invoices.update` über den Server des Primary) speichert
//            zuerst. Die Maske speichert danach → abgewiesen (INVOICE_CHANGED), nichts überschrieben.
//   DANACH   Frisch geöffnet speichert dieselbe Maske wieder; nach erneutem Neustart dauerhaft.
//
// Isoliert: com.lataif.app.e2e, Port 3011 — Produktion (com.lataif.app, E:\LATAIF\Data, 3001/3443) bleibt unberührt;
// beendet werden nur Prozesse am exakten Test-Pfad.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { closeTestWindow, killStarted, killTestImage, spawnTracked, startedPids, waitTestImageGone } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const SEED = join(process.cwd(), 'src-tauri', 'target', 'debug', 'examples', 'e2e_scope_seed.exe');
const RUN = join(os.tmpdir(), 'lataif-p1a-edit', 'run-' + Date.now());
const APP_DATA_DIR = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const SERVER_DB = join(APP_DATA_DIR, 'lataif_sync_server.db');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const OWNER_PW = 'e2e-owner-' + Math.random().toString(36).slice(2);
const env = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze'); killStarted(); killTestImage('lataif.exe'); process.exit(1); }, 15 * 60 * 1000);

const dbQ = (sql, p = []) => { let d; try { d = new DatabaseSync(BIZ_DB, { readOnly: true }); return d.prepare(sql).all(...p); } catch (e) { console.log('      (db) ' + e); return []; } finally { try { d?.close(); } catch { /* zu */ } } };
const eins = (sql, p = []) => dbQ(sql, p)[0] || {};
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
    try { const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json(); const p = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url)); if (p) { const c = new CDP(p.webSocketDebuggerUrl); await c.send('Runtime.enable'); return c; } } catch { /* noch nicht */ }
    await sleep(400);
  }
  throw new Error('no page');
}
const warte = async (c, x, t = 45000) => { const e = Date.now() + t; while (Date.now() < e) { try { if (await c.ev(`return !!(${x});`)) return true; } catch { /* baut */ } await sleep(300); } return false; };
const SHELL = `document.querySelector('a[href="/settings"]')`;
const q = (sel) => `document.querySelector(${S(sel)})`;
const set = (c, s, v) => c.ev(`const e=document.querySelector(${S(s)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
const setVal = (c, sel, v) => c.ev(`const e=[...document.querySelectorAll(${S(sel)})].pop(); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
const txt = (c, t) => c.ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)})?.click(); return 1;`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1200); }
async function ssPick(c, placeholder, optionId) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warte(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}
const fehlerText = (c) => c.ev(`const e=[...document.querySelectorAll('[data-save-error],[role=alert]')].map(x=>x.textContent.trim()).filter(Boolean); const red=[...document.querySelectorAll('div,p,span')].filter(d=>d.children.length<=2 && /rgb\\(220, 38, 38\\)|rgb\\(185, 28, 28\\)|rgb\\(239, 68, 68\\)/i.test(getComputedStyle(d).color) && (d.textContent||'').length>20).map(d=>d.textContent.trim()); return [...e, ...red].join(' | ').slice(0, 400);`);
/** Den Bruttobetrag der ersten Zeile und den Pflichtgrund in die offene Maske schreiben (ohne zu speichern). */
async function maskeAendern(c, brutto, grund) {
  const r = [await c.ev(`const e=document.querySelectorAll('input[inputmode="decimal"]')[0]; if(!e) return 'NO-PREIS'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(String(brutto))}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); e.dispatchEvent(new Event('blur',{bubbles:true})); return 'OK';`)];
  await sleep(400);
  r.push(await setVal(c, 'textarea[placeholder^="Explain why this invoice"]', grund));
  return r.every((x) => x === 'OK') ? 'OK' : r.join(',');
}
async function starten() {
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  const c = await attach();
  if (!(await warte(c, SHELL, 120000))) throw new Error('shell never appeared');
  await c.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
  return c;
}
async function schliessen(c) { const pid = startedPids().pop(); c.close(); await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe'); }
const stand = (id) => eins('SELECT gross_amount g, revision r, status s, (SELECT COUNT(*) FROM invoice_edits e WHERE e.invoice_id = i.id) n FROM invoices i WHERE id = ?', [id]);

let c = null;
try {
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  if (!APP_DATA_DIR.includes(IDENT)) throw new Error('refusing to touch a non-e2e AppData');
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: env() }));

  // ── Aufbau: Erststart, dann Ware + Kunde + Server-Anmeldung bei gestoppter App ──
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach();
  await warte(c, `document.querySelector('[data-first-run-gate], input[placeholder="e.g. Al-Khalifa Luxury"]')`, 90000);
  if (await c.ev(`return !!document.querySelector('[data-first-run-new]');`)) { await c.ev(`document.querySelector('[data-first-run-new]').click(); return 1;`); await sleep(1500); }
  await warte(c, `document.querySelector('input[placeholder="e.g. Al-Khalifa Luxury"]')`);
  await set(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'P1a Edit'); await set(c, 'input[placeholder="e.g. Main Store"]', 'P1a Edit');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="Full name"]')`);
  await set(c, 'input[placeholder="Full name"]', 'P1a Edit'); await set(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL); await set(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="10"]')`);
  await set(c, 'input[placeholder="10"]', '10');
  await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  await warte(c, SHELL, 90000);
  await schliessen(c); c = null;
  { const d = new DatabaseSync(BIZ_DB); try {
    const b = d.prepare('SELECT id FROM branches LIMIT 1').get().id; const now = new Date().toISOString();
    const cat = d.prepare('SELECT id FROM categories LIMIT 1').get()?.id ?? 'cat-watch';
    d.prepare(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery, purchase_price, purchase_currency,
        planned_sale_price, stock_status, tax_scheme, days_in_stock, quantity, images, attributes, source_type, created_at, updated_at)
      VALUES ('p1a', ?, ?, 'Zenith', 'P1a Uhr', 'P1A-1', 'Pre-Owned', '[]', 500, 'BHD', 1000, 'in_stock', 'VAT_10', 0, 1, '[]', '{}', 'OWN', ?, ?)`).run(b, cat, now, now);
    d.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES ('lot-p1a', ?, 'p1a', 500, 1, 1, 'ACTIVE', ?, ?)`).run(b, now, now);
    d.prepare("INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at) VALUES ('k', ?, 'E2E', 'Kunde', 'BH', 'en', 'NONE', '[]', 'PRIVATE', 'active', ?, ?)").run(b, now, now);
  } finally { d.close(); } }
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });
  c = await starten();

  // ── EDIT: anlegen und über die Maske ändern ──
  const anlage = [await (async () => { await gehFrisch(c, '/invoices/new'); return (await warte(c, q('[data-ss-trigger="Search clients..."]'), 20000)) ? 'OK' : 'KEINE-MASKE'; })()];
  anlage.push(await ssPick(c, 'Search clients...', 'k'), await ssPick(c, 'Pick product...', 'p1a'));
  await sleep(500);
  anlage.push(await klick(c, '[data-invoice-pay-later]'));
  await sleep(400);
  anlage.push(await klick(c, '[data-invoice-save]'));
  await sleep(2500);
  const inv = eins("SELECT id FROM invoices ORDER BY created_at DESC LIMIT 1").id;
  const s0 = stand(inv);
  ok(anlage.every((x) => x === 'OK') && !!inv && s0.s === 'PARTIAL', `SETUP Rechnung über die Maske angelegt (${anlage.join(',')}; ${S(s0)})`);

  await gehFrisch(c, `/invoices/${inv}/edit`);
  ok(await warte(c, q('[data-invoice-save]'), 20000), 'EDIT die Maske öffnet');
  await sleep(1500);
  ok(await maskeAendern(c, '1210', 'E2E P1a: Preis korrigiert') === 'OK', 'EDIT Preis und Grund eingetragen');
  ok(await klick(c, '[data-invoice-save]') === 'OK', 'EDIT Speichern geklickt');
  ok(await warte(c, `location.pathname === ${S('/invoices/' + inv)}`, 20000), 'EDIT nach dem Speichern die Detailseite (Erfolg)');
  await sleep(1200);
  const s1 = stand(inv);
  ok(Math.abs(Number(s1.g) - 1210) < 0.01 && Number(s1.n) === 1 && Number(s1.r) > Number(s0.r), `EDIT Datenbank: Brutto 1210, ein Edit, Fassung gestiegen (${S(s0)} → ${S(s1)})`);

  // ── NEUSTART: dauerhaft ──
  await schliessen(c); c = null;
  const s1disk = stand(inv);
  ok(S(s1disk) === S(s1), `NEUSTART nach dem Schließen steht auf der Platte genau derselbe Stand (${S(s1disk)})`);
  c = await starten();
  await gehFrisch(c, `/invoices/${inv}`);
  ok(await warte(c, `document.body.innerText.includes('1,210') || document.body.innerText.includes('1210')`, 20000), 'NEUSTART die Detailseite zeigt den geänderten Betrag');
  ok(S(stand(inv)) === S(s1), 'NEUSTART nach dem Start unverändert (nichts doppelt angewendet)');

  // ── STALE: zwei Bearbeitungsansichten ──
  ok(await c.ev(`try { await window.__TAURI_INTERNALS__.invoke('sync_server_start', {}); return 'OK'; } catch (e) { return String(e); }`) === 'OK', 'STALE der Server des Primary läuft (für die zweite Ansicht)');
  { const end = Date.now() + 45000; let up = false; while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* noch nicht */ } await sleep(500); } ok(up, 'STALE der Server antwortet'); }
  await gehFrisch(c, `/invoices/${inv}/edit`);
  ok(await warte(c, q('[data-invoice-save]'), 20000), 'STALE Ansicht 1 (Maske des Primary) ist offen');
  await sleep(1500);
  const gesehen = stand(inv);
  // Ansicht 2: der PC2-Weg — derselbe Befehl, den die Maske am PC2 schickt, über den echten Server.
  const token = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: S({ email: OWNER_EMAIL, password: OWNER_PW }) })).json()).token;
  const zeile = eins('SELECT id, product_id, lot_id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  const antwort = await fetch(`${BASE}/api/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: S({ op: 'invoices.update', commandId: crypto.randomUUID(), payload: {
      id: inv, expectedRevision: Number(gesehen.r), reason: 'E2E P1a: Ansicht 2 speichert zuerst', customerId: 'k',
      lines: [{ lineId: zeile.id, productId: zeile.product_id, lotId: zeile.lot_id, quantity: 1, unitPrice: 1200, scheme: 'auto' }],
    } }),
  });
  const ab = await antwort.json().catch(() => ({}));
  await sleep(1500);
  const s2 = stand(inv);
  ok(antwort.ok && Math.abs(Number(s2.g) - 1320) < 0.01 && Number(s2.n) === 2 && Number(s2.r) > Number(gesehen.r),
    `STALE Ansicht 2 hat gespeichert (${antwort.status} ${S(ab).slice(0, 80)}; ${S(s2)})`);
  // Ansicht 1 speichert jetzt auf ihrem alten Stand.
  ok(await maskeAendern(c, '1100', 'E2E P1a: Ansicht 1 auf altem Stand') === 'OK', 'STALE Ansicht 1 trägt ihre Änderung ein');
  await klick(c, '[data-invoice-save]');
  await sleep(2500);
  const meldung = await fehlerText(c);
  const pfad = await c.ev('return location.pathname;');
  ok(/changed since you opened it|INVOICE_CHANGED/i.test(meldung) && pfad.endsWith('/edit'), `STALE Ansicht 1 wird abgewiesen und bleibt in der Maske (${meldung.slice(0, 120)})`);
  const s3 = stand(inv);
  ok(S(s3) === S(s2), `STALE nichts überschrieben: Stand von Ansicht 2 bleibt (${S(s3)})`);

  // ── DANACH: frisch geöffnet wieder speicherbar, dauerhaft ──
  await gehFrisch(c, `/invoices/${inv}/edit`);
  await warte(c, q('[data-invoice-save]'), 20000); await sleep(1500);
  ok(await maskeAendern(c, '1100', 'E2E P1a: frisch geöffnet') === 'OK' && await klick(c, '[data-invoice-save]') === 'OK', 'DANACH frisch geöffnet: Änderung eingetragen und gespeichert');
  ok(await warte(c, `location.pathname === ${S('/invoices/' + inv)}`, 20000), 'DANACH Erfolg (Detailseite)');
  await sleep(1200);
  const s4 = stand(inv);
  ok(Math.abs(Number(s4.g) - 1100) < 0.01 && Number(s4.n) === 3, `DANACH Datenbank: Brutto 1100, drei Edits (${S(s4)})`);
  await schliessen(c); c = null;
  ok(S(stand(inv)) === S(s4), 'DANACH nach dem Schließen dauerhaft');
  const lager = eins("SELECT qty_remaining q FROM stock_lots WHERE id = 'lot-p1a'").q;
  ok(Number(lager) === 0, `Lager genau einmal verbraucht (${lager})`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e)); console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  try { c?.close(); } catch { /* zu */ }
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  clearTimeout(WACHHUND);
}
if (FAIL > 0) { console.log(`\nFAIL — p1a primary edit: ${PASS} passed, ${FAIL} failed`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log(`\nPASS — p1a primary edit: ${PASS} passed, 0 failed`);
