// ════════════════════════════════════════════════════════════════════════════
// HOTFIX F2 — Reparatur: falschen Kunden korrigieren, in der echten isolierten Test-App (Primary).
// Run: node test/e2e/hotfix-f2-repair-customer.e2e.mjs
//
//   ADMIN    „Change customer" → Dialog: ohne Kunde/Grund nicht bestätigbar; mit beidem gespeichert — Kunde neu,
//            Nummer/Status/Details gleich, Protokoll mit altem/neuem Kunden und Grund; die Seite zeigt den neuen Kunden.
//   SPERREN  bezahlte und abgerechnete Reparatur: keine Schaltfläche.
//   MANAGER  darf korrigieren (zurück auf den alten Kunden).   SALES  sieht die Schaltfläche nicht.
//
// Isoliert: com.lataif.app.e2e, Port 3011 — Produktion (com.lataif.app, E:\LATAIF\Data, 3001/3443) bleibt unberührt;
// beendet werden nur Prozesse am exakten Test-Pfad.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { closeTestWindow, killStarted, killTestImage, spawnTracked, startedPids, waitTestImageGone } from './_e2e-process.mjs';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const RUN = join(os.tmpdir(), 'lataif-hotfix-f2', 'run-' + Date.now());
const APP_DATA_DIR = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
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
const txt = (c, t) => c.ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)})?.click(); return 1;`);
const klick = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; if (e.disabled) return 'DISABLED:'+${S(sel)}; e.click(); return 'OK';`);
const aus = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); return e ? !!e.disabled : 'NO';`);
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1500); }
async function ssPick(c, placeholder, optionId) {
  const a = await c.ev(`const l=[...document.querySelectorAll('[data-ss-trigger=${S(placeholder)}]')]; const e=l[l.length-1]; if(!e) return 'NO'; e.click(); return 'OK';`);
  if (a !== 'OK') return 'KEIN-AUSLOESER:' + placeholder;
  if (!(await warte(c, `document.querySelector('[data-ss-option=${S(optionId)}]')`, 10000))) return 'KEIN-EINTRAG:' + optionId;
  await c.ev(`document.querySelector('[data-ss-option=${S(optionId)}]').click(); return 1;`);
  await sleep(300);
  return 'OK';
}
async function schliessen(c) { const pid = startedPids().pop(); c.close(); await closeTestWindow(pid, APP); await waitTestImageGone('lataif.exe'); }
/** Abmelden und als anderer Benutzer anmelden (dasselbe Testpasswort wie der Owner). */
async function alsBenutzer(c, email) {
  await c.ev("[...document.querySelectorAll('button')].find((b) => /Sign Out/.test(b.textContent))?.click(); return 1;");
  if (!(await warte(c, `document.querySelector('input[type="password"]')`, 30000))) return 'KEIN-LOGIN';
  await set(c, 'input[type="email"]', email); await set(c, 'input[type="password"]', ONBOARD_PW);
  await c.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  return (await warte(c, SHELL, 60000)) ? 'OK' : 'KEINE-SHELL';
}
function insert(d, table, values) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all();
  const data = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt_value !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(String(c.type)) ? 0 : (/_at$|date/i.test(c.name) ? new Date().toISOString() : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  d.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((k) => data[k]));
}
const kundeName = (c) => c.ev("const h=[...document.querySelectorAll('.text-overline')].find(x=>x.textContent.trim()==='CUSTOMER'); return h ? (h.nextElementSibling?.textContent || '') : '';");

let c = null;
try {
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  if (!APP_DATA_DIR.includes(IDENT)) throw new Error('refusing to touch a non-e2e AppData');
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: env() }));

  // ── Aufbau: Erststart (Owner), dann Kunden, Reparaturen und zwei weitere Benutzer bei gestoppter App ──
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach();
  await warte(c, `document.querySelector('[data-first-run-gate], input[placeholder="e.g. Al-Khalifa Luxury"]')`, 90000);
  if (await c.ev(`return !!document.querySelector('[data-first-run-new]');`)) { await c.ev(`document.querySelector('[data-first-run-new]').click(); return 1;`); await sleep(1500); }
  await warte(c, `document.querySelector('input[placeholder="e.g. Al-Khalifa Luxury"]')`);
  await set(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'F2 Repair'); await set(c, 'input[placeholder="e.g. Main Store"]', 'F2 Repair');
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="Full name"]')`);
  await set(c, 'input[placeholder="Full name"]', 'F2 Owner'); await set(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL); await set(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
  await txt(c, 'Next'); await warte(c, `document.querySelector('input[placeholder="10"]')`);
  await set(c, 'input[placeholder="10"]', '10');
  await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  await warte(c, SHELL, 90000);
  await schliessen(c); c = null;
  { const d = new DatabaseSync(BIZ_DB); try {
    const b = d.prepare('SELECT id FROM branches LIMIT 1').get().id; const now = new Date().toISOString();
    const owner = d.prepare('SELECT tenant_id, password_hash FROM users WHERE email = ?').get(OWNER_EMAIL);
    for (const [id, first] of [['k-falsch', 'Falscher'], ['k-richtig', 'Richtiger']]) {
      insert(d, 'customers', { id, branch_id: b, first_name: first, last_name: 'Kunde', country: 'BH', language: 'en', created_at: now, updated_at: now });
    }
    const rep = (id, nr, extra = {}) => insert(d, 'repairs', { id, branch_id: b, repair_number: nr, customer_id: 'k-falsch', repair_scope: 'CUSTOMER',
      status: 'received', item_brand: 'Rolex', item_model: 'Datejust', issue_description: 'Krone lose', repair_type: 'internal',
      charge_to_customer: 90, received_at: now, created_at: now, updated_at: now, ...extra });
    rep('rep-offen', 'REP-2026-90001');
    rep('rep-bezahlt', 'REP-2026-90002', { customer_paid_amount: 90, customer_paid_from: 'cash', customer_payment_ledger_id: 'pay-e2e' });
    insert(d, 'invoices', { id: 'inv-e2e', branch_id: b, invoice_number: 'RINV-2026-900001', customer_id: 'k-falsch', status: 'FINAL',
      net_amount: 90, gross_amount: 90, vat_amount: 0, tax_scheme_snapshot: 'ZERO', issued_at: now, created_at: now, updated_at: now });
    rep('rep-rechnung', 'REP-2026-90003', { invoice_id: 'inv-e2e' });
    for (const [id, mail, role] of [['f2-manager', 'manager.f2@lataif.com', 'manager'], ['f2-sales', 'sales.f2@lataif.com', 'sales']]) {
      insert(d, 'users', { id, tenant_id: owner.tenant_id, email: mail, password_hash: owner.password_hash, name: id, active: 1, created_at: now, updated_at: now });
      insert(d, 'user_branches', { user_id: id, branch_id: b, role, is_default: 1, created_at: now });
    }
  } finally { d.close(); } }
  spawnTracked(APP, [], { env: env(), stdio: 'ignore', detached: true }).unref();
  c = await attach();
  if (!(await warte(c, SHELL, 120000))) throw new Error('shell never appeared');
  await c.ev('window.alert = () => {}; window.confirm = () => true; return 1;');

  // ── ADMIN: korrigieren ──
  const vorher = eins("SELECT repair_number n, status s, issue_description i, item_brand b, revision r FROM repairs WHERE id = 'rep-offen'");
  await gehFrisch(c, '/repairs/rep-offen');
  ok(await warte(c, q('[data-repair-change-customer]'), 20000), 'ADMIN „Change customer" ist da (offene Reparatur)');
  ok(/Falscher Kunde/.test(await kundeName(c)), `ADMIN die Seite zeigt den bisherigen Kunden (${await kundeName(c)})`);
  await klick(c, '[data-repair-change-customer]');
  ok(await warte(c, q('[data-repair-change-customer-dialog]'), 10000), 'ADMIN der Dialog öffnet sich');
  ok(await aus(c, '[data-repair-change-customer-confirm]') === true, 'ADMIN ohne Kunde und Grund: nicht bestätigbar');
  ok(await ssPick(c, 'Search clients...', 'k-richtig') === 'OK', 'ADMIN den richtigen Kunden gewählt');
  ok(await aus(c, '[data-repair-change-customer-confirm]') === true, 'ADMIN ohne Grund: weiterhin nicht bestätigbar (Pflichtgrund)');
  await c.ev(`const e=document.querySelector('[data-repair-change-customer-reason]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, 'E2E: auf falschen Kunden gebucht'); e.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
  await sleep(300);
  ok(await klick(c, '[data-repair-change-customer-confirm]') === 'OK', 'ADMIN bestätigt');
  ok(await warte(c, `!document.querySelector('[data-repair-change-customer-dialog]')`, 20000), 'ADMIN der Dialog schließt sich nach dem Speichern');
  await sleep(1500);
  const nachher = eins("SELECT customer_id k, repair_number n, status s, issue_description i, item_brand b, revision r FROM repairs WHERE id = 'rep-offen'");
  ok(nachher.k === 'k-richtig' && nachher.n === vorher.n && nachher.s === vorher.s && nachher.i === vorher.i && nachher.b === vorher.b && nachher.r === vorher.r + 1,
    `ADMIN Datenbank: Kunde neu, Nummer/Status/Details gleich, eine neue Fassung (${S(vorher)} → ${S(nachher)})`);
  const proto = eins("SELECT old_value o, new_value v, changed_by u FROM audit_log WHERE entity_id = 'rep-offen' AND field_name = 'customer_id' ORDER BY changed_at DESC LIMIT 1");
  ok(/k-falsch/.test(String(proto.o)) && /k-richtig/.test(String(proto.v)) && /auf falschen Kunden gebucht/.test(String(proto.v)) && !!proto.u,
    `ADMIN Protokoll: alt, neu, Grund, Benutzer (${S(proto).slice(0, 200)})`);
  ok(await warte(c, `/Richtiger Kunde/.test([...document.querySelectorAll('.text-overline')].find(x=>x.textContent.trim()==='CUSTOMER')?.nextElementSibling?.textContent || '')`, 15000),
    'ADMIN die Seite zeigt den neuen Kunden');

  // ── SPERREN ──
  for (const [id, was] of [['rep-bezahlt', 'bezahlt'], ['rep-rechnung', 'auf Rechnung']]) {
    await gehFrisch(c, `/repairs/${id}`);
    await warte(c, `document.body.innerText.includes('REP-2026-9000')`, 20000);
    await sleep(800);
    ok(!(await c.ev(`return !!${q('[data-repair-change-customer]')};`)), `SPERRE ${was}: keine Schaltfläche „Change customer"`);
  }

  // ── MANAGER ──
  ok(await alsBenutzer(c, 'manager.f2@lataif.com') === 'OK', 'MANAGER angemeldet');
  await gehFrisch(c, '/repairs/rep-offen');
  ok(await warte(c, q('[data-repair-change-customer]'), 20000), 'MANAGER sieht „Change customer"');
  await klick(c, '[data-repair-change-customer]');
  await warte(c, q('[data-repair-change-customer-dialog]'), 10000);
  await ssPick(c, 'Search clients...', 'k-falsch');
  await c.ev(`const e=document.querySelector('[data-repair-change-customer-reason]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, 'E2E: Manager korrigiert zurück'); e.dispatchEvent(new Event('input',{bubbles:true})); return 1;`);
  await sleep(300);
  await klick(c, '[data-repair-change-customer-confirm]');
  await warte(c, `!document.querySelector('[data-repair-change-customer-dialog]')`, 20000);
  await sleep(1500);
  ok(eins("SELECT customer_id k FROM repairs WHERE id = 'rep-offen'").k === 'k-falsch', 'MANAGER Datenbank: zurück auf den alten Kunden');

  // ── SALES ──
  ok(await alsBenutzer(c, 'sales.f2@lataif.com') === 'OK', 'SALES angemeldet');
  await gehFrisch(c, '/repairs/rep-offen');
  await warte(c, `document.body.innerText.includes('REP-2026-90001')`, 20000);
  await sleep(800);
  ok(!(await c.ev(`return !!${q('[data-repair-change-customer]')};`)), 'SALES: keine Schaltfläche „Change customer"');
} catch (e) {
  FAIL++; fails.push('ABBRUCH: ' + String(e && e.stack ? e.stack : e)); console.log('  x ABBRUCH: ' + String(e && e.stack ? e.stack : e));
} finally {
  try { c?.close(); } catch { /* zu */ }
  killStarted(); killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  clearTimeout(WACHHUND);
}
if (FAIL > 0) { console.log(`\nFAIL — hotfix F2 repair customer e2e: ${PASS} passed, ${FAIL} failed`); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log(`\nPASS — hotfix F2 repair customer e2e: ${PASS} passed, 0 failed`);
console.log('HOTFIX_F2_REPAIR_CUSTOMER_E2E_PROVED');
