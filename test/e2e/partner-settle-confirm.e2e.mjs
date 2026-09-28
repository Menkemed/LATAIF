// ════════════════════════════════════════════════════════════════════════════
// v0.8.62 — Rückfrage + Partnerabrechnung mit Kartengebühr in der ECHTEN, isolierten Desktop-App.
// Run: node test/e2e/partner-settle-confirm.e2e.mjs
//
//   Kein Stub für `window.confirm`. UI Automation prüft, dass KEIN Windows-Fenster erscheint — nur
//   Fenster des hier gestarteten Prozesses (Prozess-ID). Geprüft:
//   • „Settle sale": Dialog der App mit Aufstellung (kein Windows-Fenster); Cancel → keine Buchung;
//     Settle → genau eine (Dialogfehler = Cancel: Node-Test).
//   • weitere bestehende Rückfrage (Partner löschen) im Dialog der App: Esc lässt ihn stehen, OK löscht.
//   • Artikel A wie im Live-Test: 1.500 Margin-VAT, Einstand 1.000, Kartengebühr 33, 40 % Partner,
//     Beitrag 400 → Partnergewinn 168,618, Anspruch 568,618.
//   • Rechnung mit zwei Artikeln und Gebühr 48,401: Anteile 28,601 + 19,800 = exakt die Gebühr.
//   • Gewinnbericht: Gebühr genau einmal abgezogen.
//   • Einkauf: Partneranteil als BHD-Betrag → Prozent und Kostenanteil.
//
// PROZESS-ISOLATION: gestartet nur über `spawnTracked`, beendet nur, was dieser Lauf gestartet hat.
// Port 3011, CDP 9223, Datenordner com.lataif.app.e2e.
// Die installierte Produktions-App, E:\LATAIF\Data und die Ports 3001/3443 werden nie berührt.
// ════════════════════════════════════════════════════════════════════════════
import { e2ePreflight } from './_e2e-preflight.mjs';
import { killStarted, killTestImage, spawnTracked, waitTestImageGone, foreignProcesses } from './_e2e-process.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const IDENT = 'com.lataif.app.e2e';
const APP_CDP = 9223, PORT = 3011;
const APP = join(process.cwd(), 'src-tauri', 'target', 'debug', 'lataif.exe');
const OWNER_EMAIL = 'admin@lataif.com';
const ONBOARD_PW = 'e2epass123';
const RUN = join(os.tmpdir(), 'lataif-settle-confirm', 'run-' + Date.now());
const APP_DATA_DIR = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), IDENT);
const BIZ_DB = join(APP_DATA_DIR, 'lataif.db');

let PASS = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v) => JSON.stringify(v);
const appEnv = () => ({ ...process.env, LATAIF_E2E_SYNC_PORT: String(PORT), TEMP: join(RUN, 'tmp'), TMP: join(RUN, 'tmp') });

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => { this.ws.addEventListener('open', res); this.ws.addEventListener('error', rej); });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
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

let appPid = 0;
async function attach() {
  const child = spawnTracked(APP, [], { env: appEnv(), stdio: 'ignore', detached: true });
  appPid = child.pid; child.unref();
  const end = Date.now() + 120000; let page = null;
  while (Date.now() < end && !page) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${APP_CDP}/json/list`)).json();
      page = l.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url) && t.webSocketDebuggerUrl);
    } catch { /* noch nicht oben */ }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('no CDP page');
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  const e2 = Date.now() + 60000;
  while (Date.now() < e2 && !(await c.ev('return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);'))) await sleep(400);
  return c;
}
const exists = (c, sel) => c.ev(`return !!document.querySelector(${S(sel)});`);
const setVal = (c, sel, v) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO:'+${S(sel)}; const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(p,'value').set.call(e, ${S(v)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
async function click(c, sel) {
  const r = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'NO'; if (e.disabled) return 'DISABLED'; e.click(); return 'OK';`);
  if (r !== 'OK') throw new Error(`click ${sel} → ${r}`);
}
const clickText = (c, t) => c.ev(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${S(t)}); if(!b) return 'NO:'+${S(t)}; if (b.disabled) return 'DISABLED'; b.click(); return 'OK';`);
async function waitFor(c, sel, t = 45000) {
  const end = Date.now() + t;
  while (Date.now() < end) { if (await exists(c, sel)) return true; await sleep(300); }
  throw new Error(`waitFor ${sel} — ${String(await c.ev('return document.body.innerText.slice(0,300);')).replace(/\s+/g, ' ')}`);
}
const SHELL = 'a[href="/settings"]';
const spuelen = (c) => c.ev('return await window.__TAURI_INTERNALS__.invoke("flush_database_now").catch((e)=>String(e));');
const geh = (c, route) => c.ev(`history.pushState({}, '', ${S(route)}); window.dispatchEvent(new PopStateEvent('popstate')); return 1;`);
async function gehFrisch(c, route) { await geh(c, '/tasks'); await sleep(700); await geh(c, route); await sleep(1200); }
function dbQ(sql, params = []) {
  let db;
  try { db = new DatabaseSync(BIZ_DB, { readOnly: true }); return db.prepare(sql).all(...params); }
  finally { try { db?.close(); } catch { /* zu */ } }
}
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

// Das echte Windows-Fenster des Dialogs bedienen — ausschließlich Fenster DIESES Prozesses.
const UIA = join(RUN, 'dialog.ps1');
function dialog(button, timeoutMs = 15000) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA,
      '-AppPid', String(appPid), '-Button', button, '-TimeoutMs', String(timeoutMs)], { encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) { return 'PS-ERROR ' + String(e.stdout || e.message).slice(0, 300); }
}
const UIA_SRC = `param([int]$AppPid, [string]$Button, [int]$TimeoutMs = 15000)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$C = [System.Windows.Automation.ControlType]
function P($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
$cond = New-Object System.Windows.Automation.AndCondition((P $A::ProcessIdProperty $AppPid), (P $A::ClassNameProperty '#32770'))
$end = (Get-Date).AddMilliseconds($TimeoutMs); $dlg = $null
while (-not $dlg -and (Get-Date) -lt $end) { $dlg = $A::RootElement.FindFirst($T::Descendants, $cond); if (-not $dlg) { Start-Sleep -Milliseconds 200 } }
if (-not $dlg) { 'NO-DIALOG'; exit 0 }
# Das Fenster erst fertig aufbauen lassen (Titel und Text), dann lesen.
Start-Sleep -Milliseconds 600
$texts = @($dlg.FindAll($T::Descendants, (P $A::ControlTypeProperty $C::Text)) | ForEach-Object { $_.Current.Name }) -join ' / '
if ($Button -eq '') { 'OPEN|' + $dlg.Current.Name + '|' + $texts; exit 0 }
# Die Dialogknöpfe sind hier nicht als UIA-Knöpfe sichtbar: den Befehl direkt an DIESES Fenster schicken
# (WM_COMMAND mit IDOK = 1 / IDCANCEL = 2) — nie Tastendrücke an das Vordergrundfenster.
Add-Type -Namespace E2E -Name U32 -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);'
$id = if ($Button -eq 'OK') { 1 } elseif ($Button -eq 'Cancel') { 2 } else { 0 }
if ($id -eq 0) { 'NO-BUTTON:' + $Button; exit 0 }
$hwnd = [System.IntPtr]$dlg.Current.NativeWindowHandle
$name = $dlg.Current.Name
[void][E2E.U32]::PostMessage($hwnd, 0x0111, [System.IntPtr]$id, [System.IntPtr]::Zero)
$gone = (Get-Date).AddSeconds(8); $n = 0
while ([E2E.U32]::IsWindow($hwnd) -and (Get-Date) -lt $gone) { Start-Sleep -Milliseconds 250; $n++; if ($n % 8 -eq 0) { [void][E2E.U32]::PostMessage($hwnd, 0x0111, [System.IntPtr]$id, [System.IntPtr]::Zero) } }
if ([E2E.U32]::IsWindow($hwnd)) { 'STILL-OPEN|' + $name + '|' + $texts; exit 0 }
'CLICKED|' + $name + '|' + $texts; exit 0
'CLICKED|' + $dlg.Current.Name + '|' + $texts
`;

const BR = 'branch-main';
const P = (x) => `sc-${x}`;
function seed() {
  const db = new DatabaseSync(BIZ_DB);
  try {
    const branch_id = (db.prepare('SELECT id FROM branches LIMIT 1').get() || {}).id || BR;
    const cat = (db.prepare('SELECT id FROM categories WHERE branch_id = ? LIMIT 1').get(branch_id) || {}).id || 'cat-watches';
    const now = new Date().toISOString();
    const alt = new Date(Date.now() - 5 * 86400000).toISOString();
    insert(db, 'partners', { id: 'sc-pa', branch_id, name: 'SC Partner', share_percentage: 0, active: 1, created_at: now, updated_at: now });
    insert(db, 'partners', { id: 'sc-del', branch_id, name: 'SC Delete Me', share_percentage: 0, active: 1, created_at: now, updated_at: now });
    insert(db, 'suppliers', { id: 'sc-sup', branch_id, name: 'SC Supplier', phone: '+973 1700 0888', active: 1, created_at: now, updated_at: now });
    insert(db, 'customers', { id: 'sc-kunde', branch_id, first_name: 'SC', last_name: 'Kunde', phone: '+973 3600 0888', created_at: now, updated_at: now });
    // A (1000), C (1000), D (700): alle verkauft, 40 % Partner.
    for (const [x, cost] of [['A', 1000], ['C', 1000], ['D', 700]]) {
      insert(db, 'products', { id: P('prod-' + x), branch_id, category_id: cat, brand: 'Rolex', name: `SC ${x}`, sku: `SC-${x}`, quantity: 0,
        condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: cost, purchase_currency: 'BHD', stock_status: 'sold',
        tax_scheme: 'ZERO', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: alt, updated_at: alt });
      insert(db, 'purchases', { id: P('pur-' + x), branch_id, purchase_number: `SC-PUR-${x}`, supplier_id: 'sc-sup', status: 'PAID', total_amount: cost,
        paid_amount: cost, remaining_amount: 0, purchase_date: alt.slice(0, 10), created_at: alt, updated_at: alt });
      insert(db, 'purchase_lines', { id: P('pl-' + x), purchase_id: P('pur-' + x), product_id: P('prod-' + x), quantity: 1, unit_price: cost, line_total: cost,
        position: 1, tax_scheme: 'ZERO', vat_rate: 0, vat_amount: 0 });
      insert(db, 'stock_lots', { id: P('lot-' + x), branch_id, product_id: P('prod-' + x), purchase_id: P('pur-' + x), purchase_line_id: P('pl-' + x), unit_cost: cost,
        qty_total: 1, qty_remaining: 0, status: 'EXHAUSTED', acquired_at: alt.slice(0, 10), created_at: alt });
      for (const [party, partner, bp] of [['HOUSE', null, 6000], ['PARTNER', 'sc-pa', 4000]]) {
        insert(db, 'item_participations', { id: P(`ip-${x}-${party}`), branch_id, purchase_id: P('pur-' + x), purchase_line_id: P('pl-' + x),
          product_id: P('prod-' + x), party, partner_id: partner, share_bp: bp, cost_share: cost * bp / 10000, line_total: cost, quantity: 1,
          created_at: alt, epoch_id: P('pl-' + x), from_il_rowid: 0, unit_cost: cost });
      }
    }
    // Rechnung A wie live: 1.500 Margin-VAT (VAT 45,455), voll per Karte, Gebühr 33.
    insert(db, 'invoices', { id: P('inv-A'), branch_id, invoice_number: 'SC-INV-A', customer_id: 'sc-kunde', status: 'FINAL', currency: 'BHD',
      net_amount: 1454.545, vat_rate_snapshot: 10, vat_amount: 45.455, gross_amount: 1500, tax_scheme_snapshot: 'MARGIN', purchase_price_snapshot: 1000,
      sale_price_snapshot: 1500, margin_snapshot: 500, paid_amount: 1500, issued_at: now, created_at: now, updated_at: now, number_finalized_at: now });
    insert(db, 'invoice_lines', { id: P('il-A'), invoice_id: P('inv-A'), product_id: P('prod-A'), lot_id: P('lot-A'), quantity: 1, unit_price: 1500,
      purchase_price_snapshot: 1000, vat_rate: 10, tax_scheme: 'MARGIN', vat_amount: 45.455, line_total: 1500, position: 1 });
    insert(db, 'payments', { id: P('pay-A'), branch_id, invoice_id: P('inv-A'), amount: 1500, method: 'card', received_at: now, created_at: now });
    insert(db, 'expenses', { id: P('fee-A'), branch_id, expense_number: 'SC-EXP-A', category: 'CardFees', amount: 33, paid_amount: 33, status: 'PAID',
      payment_method: 'bank', expense_date: now.slice(0, 10), description: 'Card fee', related_module: 'invoice', related_entity_id: P('inv-A'), created_at: now });
    // Rechnung mit zwei Artikeln: C 1.300 + D 900, Gebühr 48,401 (ungerade → Rundung prüfen).
    insert(db, 'invoices', { id: P('inv-CD'), branch_id, invoice_number: 'SC-INV-CD', customer_id: 'sc-kunde', status: 'FINAL', currency: 'BHD',
      net_amount: 2200, vat_rate_snapshot: 0, vat_amount: 0, gross_amount: 2200, tax_scheme_snapshot: 'ZERO', purchase_price_snapshot: 1700,
      sale_price_snapshot: 2200, margin_snapshot: 500, paid_amount: 2200, issued_at: now, created_at: now, updated_at: now, number_finalized_at: now });
    insert(db, 'invoice_lines', { id: P('il-C'), invoice_id: P('inv-CD'), product_id: P('prod-C'), lot_id: P('lot-C'), quantity: 1, unit_price: 1300,
      purchase_price_snapshot: 1000, vat_rate: 0, tax_scheme: 'ZERO', vat_amount: 0, line_total: 1300, position: 1 });
    insert(db, 'invoice_lines', { id: P('il-D'), invoice_id: P('inv-CD'), product_id: P('prod-D'), lot_id: P('lot-D'), quantity: 1, unit_price: 900,
      purchase_price_snapshot: 700, vat_rate: 0, tax_scheme: 'ZERO', vat_amount: 0, line_total: 900, position: 2 });
    insert(db, 'payments', { id: P('pay-CD'), branch_id, invoice_id: P('inv-CD'), amount: 2200, method: 'card', received_at: now, created_at: now });
    insert(db, 'expenses', { id: P('fee-CD'), branch_id, expense_number: 'SC-EXP-CD', category: 'CardFees', amount: 48.401, paid_amount: 48.401, status: 'PAID',
      payment_method: 'bank', expense_date: now.slice(0, 10), description: 'Card fee', related_module: 'invoice', related_entity_id: P('inv-CD'), created_at: now });
  } finally { try { db.close(); } catch { /* zu */ } }
}
const movements = (line) => dbQ(`SELECT kind, amount FROM item_partner_movements WHERE purchase_line_id = ? AND cancelled_at IS NULL ORDER BY rowid`, [line]);
async function aufklappen(c, line) {
  if (await exists(c, `[data-partner-item-expanded="${line}"]`)) return;
  await click(c, `[data-partner-item-toggle="${line}"]`);
  await waitFor(c, `[data-partner-item-expanded="${line}"]`, 10000);
}
async function shot(name) {
  if (!process.env.E2E_SHOTS || !c) return;
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.E2E_SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
}
const attr = (c, sel, a) => c.ev(`return document.querySelector(${S(sel)})?.getAttribute(${S(a)}) ?? null;`);

const WACHHUND = setTimeout(() => { console.log('  x ABBRUCH: Zeitgrenze'); killStarted(); process.exit(1); }, 20 * 60 * 1000);
let c = null;
try {
  const fremd = foreignProcesses('lataif.exe').map((p) => p.pid).sort();
  killTestImage('lataif.exe'); await waitTestImageGone('lataif.exe');
  mkdirSync(join(RUN, 'tmp'), { recursive: true });
  writeFileSync(UIA, UIA_SRC);
  if (existsSync(APP_DATA_DIR)) rmSync(APP_DATA_DIR, { recursive: true, force: true });
  console.log(e2ePreflight({ appPath: APP, appDataDir: APP_DATA_DIR, port: PORT, env: appEnv() }));

  // ── Einrichten wie ein Neukunde, dann Testbestand in die Datei, dann anmelden ──
  c = await attach();
  await waitFor(c, '[data-first-run-gate], input[type="email"], input[placeholder="e.g. Al-Khalifa Luxury"]', 90000);
  if (await exists(c, '[data-first-run-new]')) { await click(c, '[data-first-run-new]'); await sleep(1500); }
  await waitFor(c, 'input[placeholder="e.g. Al-Khalifa Luxury"], input[type="email"]', 60000);
  if (await exists(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]')) {
    await setVal(c, 'input[placeholder="e.g. Al-Khalifa Luxury"]', 'SC Co');
    await setVal(c, 'input[placeholder="e.g. Main Store"]', 'SC Branch');
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="Full name"]');
    await setVal(c, 'input[placeholder="Full name"]', 'SC Admin');
    await setVal(c, 'input[placeholder="you@company.com"]', OWNER_EMAIL);
    await setVal(c, 'input[placeholder="Choose a password"]', ONBOARD_PW);
    await clickText(c, 'Next'); await waitFor(c, 'input[placeholder="10"]');
    await setVal(c, 'input[placeholder="10"]', '10');
    await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Start Using LATAIF'))?.click(); return 1;");
  }
  await waitFor(c, SHELL, 60000);
  await spuelen(c).catch(() => null);
  await sleep(1200);
  c.close(); c = null;
  killStarted(); await waitTestImageGone('lataif.exe');
  seed();
  c = await attach();
  await waitFor(c, SHELL + ', input[type="password"]', 90000);
  if (!(await exists(c, SHELL))) {
    await setVal(c, 'input[type="email"]', OWNER_EMAIL);
    await setVal(c, 'input[type="password"]', ONBOARD_PW);
    await c.ev("document.querySelector('button[type=submit]')?.click(); return 1;");
  }
  await waitFor(c, SHELL, 90000);
  ok(await c.ev('return typeof window.confirm === "function" && !/plugin:dialog\\|confirm/.test(String(window.confirm));'), 'SETUP window.confirm ist der neue Dialogweg (kein Stub)');

  // ── Beitrag 400 für A (Maske ohne Rückfrage) ──
  await gehFrisch(c, '/partners');
  await waitFor(c, '[data-partner-items]', 60000);
  await aufklappen(c, P('pl-A'));
  const knopf = await c.ev(`return document.querySelector('[data-partner-item-contribute="${P('pl-A')}"]')?.textContent.trim() || '';`);
  ok(knopf === 'Partner pays in' && !(await exists(c, `[data-partner-item-payout="${P('pl-A')}"]`)),
    `GELDHANDLUNG Partner schuldet seinen Kostenanteil → nur „Partner pays in" (${knopf})`);
  await click(c, `[data-partner-item-contribute="${P('pl-A')}"]`);
  await waitFor(c, '[data-partner-item-save]', 10000);
  await setVal(c, '[data-partner-item-amount]', '400');
  await click(c, '[data-partner-item-method="cash"]');
  await sleep(200);
  await click(c, '[data-partner-item-save]');
  for (let i = 0; i < 40 && (await exists(c, '[data-partner-item-save]')); i++) await sleep(300);
  await spuelen(c);
  ok(movements(P('pl-A')).map((m) => `${m.kind}:${m.amount}`).join() === 'CONTRIBUTION:400', `BEITRAG 400 gebucht (${S(movements(P('pl-A')))})`);

  // ── Anzeige der Grundlage: Gebühr, Gewinn, Anteile ──
  const saleA = `[data-partner-item-sale="${P('il-A')}"]`;
  await aufklappen(c, P('pl-A'));
  ok(await attr(c, saleA, 'data-sale-fee') === '33.000' && await attr(c, saleA, 'data-sale-profit') === '421.545'
    && await attr(c, saleA, 'data-sale-partner-share') === '168.618',
  `ANSICHT A: Gebühr 33, Gewinn 421,545, Partner 168,618 (${await attr(c, saleA, 'data-sale-fee')}/${await attr(c, saleA, 'data-sale-profit')}/${await attr(c, saleA, 'data-sale-partner-share')})`);
  ok(await attr(c, `${saleA} [data-partner-item-lataif-share]`, 'data-partner-item-lataif-share') === '252.927', 'ANSICHT A: LATAIF-Anteil 252,927');

  // ── „Settle sale" — Dialog der App (kein Windows-Fenster). 1. Cancel: Aufstellung, keine Buchung ──
  const settleBtn = `[data-partner-item-settle="${P('il-A')}"]`;
  await click(c, settleBtn);
  await waitFor(c, '[data-settle-modal]', 10000);
  const mod = await c.ev(`const g=(a)=>document.querySelector('['+a+']')?.getAttribute(a); return JSON.stringify({ fee: g('data-settle-fee'), profit: g('data-settle-profit'), partner: g('data-settle-partner-share'), lataif: g('data-settle-lataif-share') });`).then(JSON.parse);
  ok(mod.fee === '33.000' && mod.profit === '421.545' && mod.partner === '168.618' && mod.lataif === '252.927',
    `DIALOG der App: netto − Einstand − Kartengebühr = Gewinn, Partner- und LATAIF-Anteil (${S(mod)})`);
  ok(dialog('', 1500) === 'NO-DIALOG', 'DIALOG kein Windows-Fenster');
  await shot('settle-modal');
  await click(c, '[data-settle-cancel]');
  await sleep(1200); await spuelen(c);
  ok(!(await exists(c, '[data-settle-modal]')) && movements(P('pl-A')).length === 1 && await exists(c, settleBtn), `CANCEL keine Buchung (${S(movements(P('pl-A')))})`);

  // ── 2. Dialogfehler: die Rückfrage-Schicht wertet einen Fehler als Cancel — Node-Test
  //    (test/partner-items/partner-purchase.test.ts, RÜCKFRAGE-FEHLER); Cancel bucht nichts: Schritt 1.

  // ── 3. Settle: genau eine Abrechnung 168,618, Anspruch 568,618 ──
  await click(c, settleBtn);
  await waitFor(c, '[data-settle-confirm]', 10000);
  await click(c, '[data-settle-confirm]');
  for (let i = 0; i < 30 && movements(P('pl-A')).length < 2; i++) { await sleep(400); await spuelen(c); }
  const mA = movements(P('pl-A'));
  ok(mA.map((m) => `${m.kind}:${m.amount}`).join() === 'CONTRIBUTION:400,PROFIT_SHARE:168.618' && !(await exists(c, '[data-settle-modal]')), `SETTLE genau eine Abrechnung 168,618 (${S(mA)})`);
  const basis = JSON.parse(dbQ(`SELECT basis_json FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PROFIT_SHARE'`, [P('pl-A')])[0]?.basis_json || '{}');
  ok(basis.fee === 33 && basis.net === 1454.545 && basis.cost === 1000 && basis.profit === 421.545, `GRUNDLAGE gespeichert (${S(basis)})`);
  await sleep(800);
  ok(await attr(c, `[data-partner-item="${P('pl-A')}"] [data-partner-item-open]`, 'data-partner-item-open') === '568.618', 'ANSPRUCH 400 + 168,618 = 568,618 offen zugunsten des Partners');
  const pib = dbQ(`SELECT ROUND(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 3) AS s FROM ledger_entries WHERE account = 'PARTNER_ITEM_BALANCE'`)[0]?.s;
  const unbal = dbQ(`SELECT COUNT(*) AS n FROM (SELECT transaction_id, SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) AS d FROM ledger_entries GROUP BY transaction_id HAVING ABS(d) > 0.0005)`)[0]?.n;
  ok(pib === 568.618 && unbal === 0, `HAUPTBUCH Partner-Ausgleichskonto 568,618, alles ausgeglichen (${pib}, ${unbal})`);

  // ── Geldhandlung folgt dem Stand: Guthaben → nur „Pay out"; danach erledigt, kein Beitrag mehr ──
  ok(!(await exists(c, `[data-partner-item-contribute="${P('pl-A')}"]`)) && await exists(c, `[data-partner-item-payout="${P('pl-A')}"]`),
    'GELDHANDLUNG LATAIF schuldet dem Partner → nur „Pay out", kein Beitrag');
  await click(c, `[data-partner-item-payout="${P('pl-A')}"]`);
  await waitFor(c, '[data-partner-item-save]', 10000);
  const vorschlag = await c.ev("return document.querySelector('[data-partner-item-amount] input, input[data-partner-item-amount]')?.value || document.querySelector('[data-partner-item-amount]')?.value || '';");
  const maxText = await c.ev("return document.querySelector('[data-partner-item-max]')?.textContent || '';");
  await click(c, '[data-partner-item-method="cash"]');
  await click(c, '[data-partner-item-save]');
  for (let i = 0; i < 40 && (await exists(c, '[data-partner-item-save]')); i++) await sleep(300);
  await spuelen(c);
  ok(vorschlag === '568.618' && /568\.618/.test(maxText) && movements(P('pl-A')).map((m) => m.kind).join() === 'CONTRIBUTION,PROFIT_SHARE,PAYOUT',
    `AUSZAHLUNG 568,618 vorgeschlagen und gebucht (${vorschlag}, ${maxText})`);
  await sleep(600);
  ok(await attr(c, `[data-partner-item="${P('pl-A')}"] [data-partner-item-money-status]`, 'data-partner-item-money-status') === 'SETTLED'
    && !(await exists(c, `[data-partner-item-contribute="${P('pl-A')}"]`)) && !(await exists(c, `[data-partner-item-payout="${P('pl-A')}"]`)),
    'ERLEDIGT „Settled — nothing open", keine Geldhandlung mehr');
  await c.ev(`document.querySelector('[data-partner-item="${P('pl-A')}"]')?.scrollIntoView({ block: 'center' }); return 1;`);
  await sleep(300);
  await shot('partner-settled');


  // ── Mehrere Artikel auf einer Rechnung: Gebührenanteile = exakt die Gebühr ──
  await aufklappen(c, P('pl-C')); await aufklappen(c, P('pl-D'));
  const fC = await attr(c, `[data-partner-item-sale="${P('il-C')}"]`, 'data-sale-fee');
  const fD = await attr(c, `[data-partner-item-sale="${P('il-D')}"]`, 'data-sale-fee');
  ok(fC === '28.601' && fD === '19.800' && Math.round((Number(fC) + Number(fD)) * 1000) === 48401, `MEHRERE Gebühr 48,401 = ${fC} + ${fD}`);
  ok(await attr(c, `[data-partner-item-sale="${P('il-C')}"]`, 'data-sale-profit') === '271.399'
    && await attr(c, `[data-partner-item-sale="${P('il-D')}"]`, 'data-sale-profit') === '180.200', 'MEHRERE Gewinn je Artikel nach seinem Gebührenanteil');

  // ── Gewinnbericht: Gebühr genau einmal ──
  await gehFrisch(c, '/business-reports');
  await c.ev("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Profit')?.click(); return 1;");
  await waitFor(c, '[data-report-joint-item-profit]', 20000);
  const rep = await c.ev(`const g=(a)=>document.querySelector('['+a+']')?.getAttribute(a); return JSON.stringify({ item: g('data-report-joint-item-profit'), partner: g('data-report-joint-partner-share'), lataif: g('data-report-joint-lataif-share') });`).then(JSON.parse);
  ok(rep.item === '873.144' && rep.partner === '349.258' && rep.lataif === '523.886',
    `BERICHT Artikelgewinn 421,545 + 271,399 + 180,2 (Gebühr einmal), Partner 168,618 + 108,560 + 72,080, LATAIF Rest (${S(rep)})`);

  // ── Weitere bestehende Rückfrage (Partner löschen): Dialog der App statt Windows-Fenster ──
  await gehFrisch(c, '/partners');
  await waitFor(c, '[data-partner-items]', 30000);
  await aufklappen(c, P('pl-A'));
  await c.ev(`document.querySelector('[data-partner-item-sale="${P('il-A')}"]')?.scrollIntoView({ block: 'center' }); return 1;`);
  await sleep(300);
  await shot('partner-sales-row');
  const editDel = `const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Edit').find(x=>{let p=x;for(let i=0;i<8&&p;i++){p=p.parentElement;if(p&&(p.innerText||'').includes('SC Delete Me')&&!(p.innerText||'').includes('SC Partner'))return true;}return false;}); if(!b) return 'NO'; b.click(); return 'OK';`;
  ok(await c.ev(editDel) === 'OK', 'LÖSCHEN Bearbeiten geöffnet');
  await sleep(600);
  ok(await clickText(c, 'Delete') === 'OK', 'LÖSCHEN Knopf');
  await waitFor(c, '[data-app-confirm]', 10000);
  const frage = await c.ev("return document.querySelector('[data-app-confirm-text]')?.textContent || '';");
  ok(/Delete partner "SC Delete Me"?/.test(frage) && dialog('', 1500) === 'NO-DIALOG', `RÜCKFRAGE im Dialog der App, kein Windows-Fenster (${frage})`);
  await shot('app-confirm');
  // Esc = Cancel und schließt NUR die Rückfrage, nicht den Bearbeiten-Dialog darunter.
  // Echte Taste über CDP (wie auf der Tastatur), nicht als synthetisches Ereignis.
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(1000); await spuelen(c);
  ok(!(await exists(c, '[data-app-confirm]')) && dbQ("SELECT COUNT(*) AS n FROM partners WHERE id = 'sc-del'")[0].n === 1
    && await c.ev("return [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Delete');"), 'LÖSCHEN Esc/Cancel: Partner bleibt, Bearbeiten bleibt offen');
  ok(await clickText(c, 'Delete') === 'OK', 'LÖSCHEN Knopf erneut');
  await waitFor(c, '[data-app-confirm-ok]', 10000);
  await click(c, '[data-app-confirm-ok]');
  for (let i = 0; i < 20 && dbQ("SELECT COUNT(*) AS n FROM partners WHERE id = 'sc-del'")[0].n === 1; i++) { await sleep(400); await spuelen(c); }
  ok(dbQ("SELECT COUNT(*) AS n FROM partners WHERE id = 'sc-del'")[0].n === 0, 'LÖSCHEN OK: Partner gelöscht');

  // ── Einkauf: Anteil als BHD-Betrag ──
  await gehFrisch(c, '/purchases/new');
  await waitFor(c, '[data-purchase-partner-open]', 30000);
  const ein = await c.ev(`
    const w=()=>new Promise(r=>setTimeout(r,300)); const q=(s)=>document.querySelector(s);
    const set=(el,v)=>{const p=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));};
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Add Item')?.click(); await w();
    const nums=[...document.querySelectorAll('input[type=number]')].filter(i=>!i.closest('[data-purchase-partner-section]'));
    const price=nums.filter((_,k)=>k%2===1); set(price[0],'1000'); set(price[1],'500'); await w();
    q('[data-purchase-partner-open]').click(); await w();
    const sel=q('[data-purchase-partner-select="0"]'); set(sel,[...sel.options].find(o=>o.textContent==='SC Partner').value); await w();
    q('[data-purchase-partner-line="1"]').click(); await w();
    set(q('[data-purchase-partner-amount="0"]'),'400'); await w();
    const p1=q('[data-purchase-partner-share="0"]').value;
    q('[data-purchase-partner-apply]').click(); await w();
    q('[data-purchase-partner-line="0"]').click(); q('[data-purchase-partner-line="1"]').click(); await w();
    set(q('[data-purchase-partner-amount="0"]'),'333.333'); await w();
    const p2=q('[data-purchase-partner-share="0"]').value;
    q('[data-purchase-partner-apply]').click(); await w();
    return JSON.stringify({ p1, p2, sum: q('[data-purchase-partner-summary]')?.innerText || '' });`).then(JSON.parse);
  ok(ein.p1 === '40' && /LATAIF 60 % \(600\.000 BHD\) · SC Partner 40 % \(400\.000 BHD\)/.test(ein.sum), `EINKAUF 400 von 1.000 → 40 %, Kostenanteil 400,000 (${S(ein)})`);
  ok(ein.p2 === '66.67' && /SC Partner 66\.67 % \(333\.350 BHD\)/.test(ein.sum), `EINKAUF 333,333 von 500 → 66,67 %, tatsächlicher Kostenanteil 333,350 angezeigt (${ein.sum.replace(/\n/g, ' | ')})`);

  ok(foreignProcesses('lataif.exe').map((p) => p.pid).sort().join() === fremd.join(), 'ISOLATION fremde lataif.exe unberührt');
} catch (e) {
  fails.push('THROWN ' + String(e?.stack || e)); console.log('  x', e);
} finally {
  c?.close();
  killStarted();
  clearTimeout(WACHHUND);
}
console.log(`\npartner-settle-confirm e2e: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_SETTLE_CONFIRM_E2E_PROVED');
