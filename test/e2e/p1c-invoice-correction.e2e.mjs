// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1c — Rechnungsmaske: Steuerartwechsel hält das Brutto, Kundenüberzahlung mit Pflichtwahl
// (Rückzahlung = offener Anspruch bis zur Auszahlung), Teilretoure (nur der Rest korrigierbar). Echte Bedienung
// der Maske und der Rechnungsansicht in der isolierten Test-App; Gegenstelle (PC2-Weg) über den echten Server.
// Run: node test/e2e/p1c-invoice-correction.e2e.mjs
//
//   STEUER     Rechnung über /invoices/new; im Edit VAT 10 % → Margin → Zero-rated: Brutto 1100 bleibt (Maske + DB).
//   UEBER      Voll bezahlt; Preis 990 → Wahl erscheint, ohne Wahl kein Speichern; „Refund" → offener Anspruch 110,
//              Kasse unverändert; „Record refund" 40 per Bank → Abfluss 40, offen 70; NEUSTART dauerhaft;
//              Rest 70 über den PC2-Weg (`returns.record_refund_payment`) → REFUNDED, Wiederholung ohne Wirkung.
//   RETOURE    3 Stück (PC2-Weg), 1 retourniert; die Maske zeigt die retournierte Zeile gesperrt und den Rest
//              (2 Stück) korrigierbar; Rest 1980 → eigene Zeile, Retoure/Los/Lager unverändert.
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
const RUN = join(os.tmpdir(), 'lataif-p1c-edit', 'run-' + Date.now());
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
const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze'); killStarted(); killTestImage('lataif.exe'); process.exit(1); }, 20 * 60 * 1000);

const dbQ = (sql, p = []) => { let d; try { d = new DatabaseSync(BIZ_DB, { readOnly: true }); return d.prepare(sql).all(...p); } catch (e) { console.log('      (db) ' + e); return []; } finally { try { d?.close(); } catch { /* zu */ } } };
const eins = (sql, p = []) => dbQ(sql, p)[0] || {};
const r3 = (v) => Math.round(Number(v || 0) * 1000) / 1000;
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
const wert = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? e.value : 'NO';`);
const aus = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? !!e.disabled : 'NO';`);
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
/** Brutto einer Zeile in der offenen Maske eintragen (wie getippt). */
const brutto = (c, idx, v) => c.ev(`const e=document.querySelector('[data-invoice-line-gross="${idx}"]'); if(!e) return 'NO-PREIS'; if (e.disabled) return 'DISABLED'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, ${S(String(v))}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); e.dispatchEvent(new Event('blur',{bubbles:true})); return 'OK';`);
const grund = (c, t) => setVal(c, 'textarea[placeholder^="Explain why this invoice"]', t);
async function starten() {
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  const c = await attach();
  if (!(await warte(c, SHELL, 120000))) throw new Error('shell never appeared');
  await c.ev('window.alert = () => {}; window.confirm = () => true; return 1;');
  return c;
}
async function schliessen(c) { const pid = startedPids().pop(); c.close(); await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe'); }
async function serverAn(c) {
  const r = await c.ev(`try { await window.__TAURI_INTERNALS__.invoke('sync_server_start', {}); return 'OK'; } catch (e) { return String(e); }`);
  const end = Date.now() + 45000; let up = false;
  while (Date.now() < end) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* noch nicht */ } await sleep(500); }
  return r === 'OK' && up;
}
let TOKEN = '';
async function befehl(op, payload, commandId = crypto.randomUUID()) {
  if (!TOKEN) TOKEN = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: S({ email: OWNER_EMAIL, password: OWNER_PW }) })).json()).token;
  const a = await fetch(`${BASE}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: S({ op, commandId, payload }) });
  return { status: a.status, ok: a.ok, body: await a.json().catch(() => ({})) };
}
const kasse = (acc) => r3(eins("SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) s FROM ledger_entries WHERE account = ?", [acc]).s);
const anspruch = (inv) => eins("SELECT id, amount a, used_amount u, status s FROM customer_credits WHERE source_type = 'invoice_edit' AND source_id = ?", [inv]);

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
  await set(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'P1c Edit'); await set(c, 'input[placeholder="e.g. Main Store"]', 'P1c Edit');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="Full name"]')`);
  await set(c, 'input[placeholder="Full name"]', 'P1c Edit'); await set(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL); await set(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="10"]')`);
  await set(c, 'input[placeholder="10"]', '10');
  await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  await warte(c, SHELL, 90000);
  await schliessen(c); c = null;
  { const d = new DatabaseSync(BIZ_DB); try {
    const b = d.prepare('SELECT id FROM branches LIMIT 1').get().id; const now = new Date().toISOString();
    const cat = d.prepare('SELECT id FROM categories LIMIT 1').get()?.id ?? 'cat-watch';
    const ware = (id, name, sku, cost, qty) => {
      d.prepare(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery, purchase_price, purchase_currency,
          planned_sale_price, stock_status, tax_scheme, days_in_stock, quantity, images, attributes, source_type, created_at, updated_at)
        VALUES (?, ?, ?, 'Zenith', ?, ?, 'Pre-Owned', '[]', ?, 'BHD', 1000, 'in_stock', 'VAT_10', 0, ?, '[]', '{}', 'OWN', ?, ?)`).run(id, b, cat, name, sku, cost, qty, now, now);
      d.prepare(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run('lot-' + id, b, id, cost, qty, qty, now, now);
    };
    ware('p1ca', 'P1c Uhr', 'P1C-1', 500, 1);
    ware('p1cr', 'P1c Manschettenknoepfe', 'P1C-2', 100, 3);
    d.prepare("INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at) VALUES ('k', ?, 'E2E', 'Kunde', 'BH', 'en', 'NONE', '[]', 'PRIVATE', 'active', ?, ?)").run(b, now, now);
  } finally { d.close(); } }
  execFileSync(SEED, ['seed-primary', SERVER_DB], { env: { ...process.env, E2E_OWNER_PW: OWNER_PW }, encoding: 'utf8' });
  c = await starten();

  // ── STEUER: anlegen und Steuerart wechseln ──
  const anlage = [await (async () => { await gehFrisch(c, '/invoices/new'); return (await warte(c, q('[data-ss-trigger="Search clients..."]'), 20000)) ? 'OK' : 'KEINE-MASKE'; })()];
  anlage.push(await ssPick(c, 'Search clients...', 'k'), await ssPick(c, 'Pick product...', 'p1ca'));
  await sleep(500);
  anlage.push(await klick(c, '[data-invoice-pay-later]'));
  await sleep(400);
  anlage.push(await klick(c, '[data-invoice-save]'));
  await sleep(2500);
  const inv = eins("SELECT id FROM invoices ORDER BY created_at DESC LIMIT 1").id;
  ok(anlage.every((x) => x === 'OK') && !!inv && r3(eins('SELECT gross_amount g FROM invoices WHERE id = ?', [inv]).g) === 1100, `SETUP Rechnung 1100 über die Maske angelegt (${anlage.join(',')})`);
  for (const [scheme, vat] of [['MARGIN', 54.545], ['ZERO', 0]]) {
    await gehFrisch(c, `/invoices/${inv}/edit`);
    await warte(c, q('[data-invoice-line-scheme="0"]'), 20000); await sleep(1200);
    const vor = await wert(c, '[data-invoice-line-gross="0"]');
    const sv = await setVal(c, '[data-invoice-line-scheme="0"]', scheme);
    await sleep(500);
    const nach = await wert(c, '[data-invoice-line-gross="0"]');
    ok(sv === 'OK' && vor === '1100.00' && nach === '1100.00', `STEUER Maske: Steuerart → ${scheme}, der Kundenpreis bleibt 1100.00 (${vor} → ${nach})`);
    await grund(c, `E2E P1c: Steuerart ${scheme}`);
    await klick(c, '[data-invoice-save]');
    ok(await warte(c, `location.pathname === ${S('/invoices/' + inv)}`, 20000), `STEUER ${scheme} gespeichert (Detailseite) ${await fehlerText(c)}`);
    await sleep(1000);
    const st = eins("SELECT gross_amount g, vat_amount v, (SELECT tax_scheme FROM invoice_lines WHERE invoice_id = i.id) t FROM invoices i WHERE id = ?", [inv]);
    ok(r3(st.g) === 1100 && r3(st.v) === vat && st.t === scheme, `STEUER Datenbank: Brutto 1100, VAT ${vat}, ${scheme} (${S(st)})`);
  }

  // ── UEBER: Überzahlung mit Pflichtwahl ──
  ok(await serverAn(c), 'UEBER der Server des Primary läuft (Gegenstelle)');
  const zahl = await befehl('invoices.record_payment', { invoiceId: inv, amount: 1100, method: 'cash' });
  await sleep(1200);
  ok(zahl.ok && r3(eins('SELECT paid_amount p FROM invoices WHERE id = ?', [inv]).p) === 1100, `UEBER voll bezahlt 1100 bar (PC2-Weg) (${zahl.status} ${S(zahl.body).slice(0, 80)})`);
  const kasseVor = kasse('CASH');
  await gehFrisch(c, `/invoices/${inv}/edit`);
  await warte(c, q('[data-invoice-line-gross="0"]'), 20000); await sleep(1200);
  ok(await brutto(c, 0, '990') === 'OK', 'UEBER Preis 1100 → 990 eingetragen');
  await sleep(500);
  ok(await warte(c, q('[data-invoice-overpay-choice]'), 5000), 'UEBER die Wahl „customer credit / refund" erscheint');
  await grund(c, 'E2E P1c: Preis gesenkt');
  await klick(c, '[data-invoice-save]');
  await sleep(1500);
  const ohne = await fehlerText(c);
  ok((await c.ev('return location.pathname;')).endsWith('/edit') && /overpaid/i.test(ohne) && !anspruch(inv).id,
    `UEBER ohne Wahl wird nicht gespeichert (${ohne.slice(0, 100)})`);
  ok(await klick(c, '[data-invoice-overpay="refund"]') === 'OK' && await warte(c, q('[data-invoice-refund-claim-note]'), 5000),
    'UEBER „Refund" gewählt: Hinweis „open refund owed … no cash or bank booking"');
  await klick(c, '[data-invoice-save]');
  ok(await warte(c, `location.pathname === ${S('/invoices/' + inv)}`, 20000), `UEBER mit Wahl gespeichert ${await fehlerText(c)}`);
  await sleep(1200);
  const a1 = anspruch(inv);
  ok(r3(a1.a) === 110 && r3(a1.u) === 0 && a1.s === 'REFUND_DUE' && kasse('CASH') === kasseVor && kasse('BANK') === 0
    && Number(eins('SELECT COUNT(*) n FROM customer_credit_refunds').n) === 0,
    `UEBER Datenbank: offener Rückzahlungsanspruch 110, Kasse/Bank unverändert (${S(a1)}, Kasse ${kasse('CASH')})`);
  ok(await warte(c, `document.querySelector('[data-invoice-refund-owed]')?.innerText.includes('110')`, 10000), 'UEBER die Rechnung zeigt „Refund owed to customer 110"');
  ok(await klick(c, '[data-invoice-record-refund]') === 'OK' && await warte(c, q('[data-invoice-refund-modal]'), 5000), 'UEBER „Record refund" öffnet die Auszahlung');
  await setVal(c, '[data-invoice-refund-amount]', '40');
  await klick(c, '[data-invoice-refund-method="bank"]');
  await sleep(300);
  await klick(c, '[data-invoice-refund-confirm]');
  await sleep(2000);
  const a2 = anspruch(inv);
  ok(r3(a2.u) === 40 && a2.s === 'REFUND_DUE' && kasse('BANK') === -40 && kasse('CASH') === kasseVor
    && S(dbQ('SELECT amount, method FROM customer_credit_refunds')) === S([{ amount: 40, method: 'bank' }]),
    `UEBER Auszahlung 40 per Bank: Bank −40, offen 70 (${S(a2)}) ${await fehlerText(c)}`);
  ok(await warte(c, `document.querySelector('[data-invoice-refund-owed]')?.innerText.includes('70')`, 10000), 'UEBER die Rechnung zeigt jetzt 70 offen und die Auszahlung');
  await schliessen(c); c = null;
  ok(S(anspruch(inv)) === S(a2) && Number(eins('SELECT COUNT(*) n FROM customer_credit_refunds').n) === 1, 'NEUSTART Anspruch und Auszahlung dauerhaft gespeichert');
  c = await starten();
  ok(await serverAn(c), 'NEUSTART Server wieder an');
  TOKEN = '';
  const cmd = crypto.randomUUID();
  const rest = await befehl('returns.record_refund_payment', { invoiceId: inv, creditId: a2.id, amount: 70, method: 'cash' }, cmd);
  const wdh = await befehl('returns.record_refund_payment', { invoiceId: inv, creditId: a2.id, amount: 70, method: 'cash' }, cmd);
  await sleep(1200);
  const a3 = anspruch(inv);
  ok(rest.ok && wdh.ok && a3.s === 'REFUNDED' && r3(a3.u) === 110 && kasse('CASH') === r3(kasseVor - 70)
    && Number(eins('SELECT COUNT(*) n FROM customer_credit_refunds').n) === 2,
    `UEBER Rest 70 bar über den PC2-Weg; dieselbe Auftragskennung zweimal → genau eine Auszahlung (${rest.status}/${wdh.status}, ${S(a3)})`);
  await gehFrisch(c, `/invoices/${inv}`);
  ok(await warte(c, `document.querySelector('[data-invoice-refund-owed]')?.innerText.includes('REFUNDED')`, 10000), 'UEBER die Rechnung zeigt „REFUNDED"');

  // ── RETOURE: Teilretoure, nur der Rest korrigierbar ──
  const neu = await befehl('invoices.create', { customerId: 'k', lines: [{ productId: 'p1cr', lotId: 'lot-p1cr', quantity: 3, unitPrice: 1000, scheme: 'auto' }] });
  const inv2 = neu.body?.result?.invoiceId || neu.body?.invoiceId || eins("SELECT id FROM invoices WHERE id != ? ORDER BY created_at DESC LIMIT 1", [inv]).id;
  const X = eins('SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv2]).id;
  const ret = await befehl('returns.create', { invoiceId: inv2, expectedRevision: Number(eins('SELECT revision r FROM invoices WHERE id = ?', [inv2]).r),
    lines: [{ invoiceLineId: X, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'E2E P1c' });
  const rid = eins('SELECT id FROM sales_returns WHERE invoice_id = ?', [inv2]).id;
  const appr = await befehl('returns.approve', { returnId: rid, expectedRevision: Number(eins('SELECT revision r FROM sales_returns WHERE id = ?', [rid]).r) });
  await sleep(1200);
  const lotVor = Number(eins("SELECT qty_remaining q FROM stock_lots WHERE id = 'lot-p1cr'").q);
  const srlVor = S(dbQ('SELECT invoice_line_id, quantity FROM sales_return_lines'));
  ok(neu.ok && ret.ok && appr.ok && !!X && srlVor === S([{ invoice_line_id: X, quantity: 1 }]),
    `RETOURE 3 Stück (PC2-Weg), 1 retourniert und genehmigt (${neu.status}/${ret.status}/${appr.status})`);
  await gehFrisch(c, `/invoices/${inv2}/edit`);
  await warte(c, q('[data-invoice-line-gross="0"]'), 20000); await sleep(1500);
  const gesperrt = [await aus(c, '[data-invoice-line-gross="0"]'), await aus(c, '[data-invoice-line-scheme="0"]'), await aus(c, '[data-invoice-line-qty="0"]')];
  const offen = [await aus(c, '[data-invoice-line-gross="1"]'), await aus(c, '[data-invoice-line-scheme="1"]')];
  ok(S(gesperrt) === S([true, true, true]) && S(offen) === S([false, false]) && await warte(c, q('[data-invoice-line-returned="0"]'), 3000)
    && await warte(c, q('[data-invoice-line-rest="1"]'), 3000) && await wert(c, '[data-invoice-line-qty="1"]') === '2',
    `RETOURE Maske: retournierte Zeile gesperrt (${gesperrt}), Rest 2 Stück korrigierbar (${offen})`);
  ok(await brutto(c, 1, '1980') === 'OK', 'RETOURE Rest 2 Stück: 2200 → 1980');
  await grund(c, 'E2E P1c: Preis der übrigen Stücke');
  await klick(c, '[data-invoice-save]');
  ok(await warte(c, `location.pathname === ${S('/invoices/' + inv2)}`, 20000), `RETOURE gespeichert ${await fehlerText(c)}`);
  await sleep(1200);
  const zeilen = dbQ('SELECT id, quantity, unit_price, lot_id, purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv2]);
  ok(zeilen.length === 2 && zeilen[0].id === X && Number(zeilen[0].quantity) === 1 && r3(zeilen[0].unit_price) === 1000
    && Number(zeilen[1].quantity) === 2 && r3(zeilen[1].unit_price) === 900 && zeilen[1].lot_id === 'lot-p1cr' && r3(zeilen[1].purchase_price_snapshot) === 100,
    `RETOURE Datenbank: retournierte Zeile (ID, 1 × 1000) bleibt, Rest als eigene Zeile 2 × 900 auf demselben Los (${S(zeilen)})`);
  ok(Number(eins("SELECT qty_remaining q FROM stock_lots WHERE id = 'lot-p1cr'").q) === lotVor && S(dbQ('SELECT invoice_line_id, quantity FROM sales_return_lines')) === srlVor
    && r3(eins('SELECT gross_amount g FROM invoices WHERE id = ?', [inv2]).g) === 3080,
    'RETOURE Los und Retourenzeile unverändert, Rechnung 1100 + 1980 = 3080');
  await schliessen(c); c = null;
  ok(dbQ('SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv2]).length === 2, 'RETOURE nach dem Schließen dauerhaft');
  const bilanz = r3(eins("SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) s FROM ledger_entries").s);
  ok(bilanz === 0, `Hauptbuch ausgeglichen (${bilanz})`);
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e)); console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  try { c?.close(); } catch { /* zu */ }
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  clearTimeout(WACHHUND);
}
if (FAIL > 0) { console.log(`\nFAIL — p1c invoice correction: ${PASS} passed, ${FAIL} failed`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log(`\nPASS — p1c invoice correction: ${PASS} passed, 0 failed`);
