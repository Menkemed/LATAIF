// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS S1 (v0.8.101) — VAT_10-Kostenbasis gemeinsamer Artikel: wirtschaftlicher Kostenanteil netto
// (abziehbare Vorsteuer gehört nicht zum Einstand), Vorsteuer getrennt angezeigt, Lieferantenrückgabe mit dem
// Netto-Erstattungswert (wie die Rückgabebuchung), Verkauf/Gewinn/Verlust, Reparatur, mehrere Partner, Teilbeiträge,
// ZERO unverändert, Altbestand (brutto gespeichert) ohne Saldoänderung. Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/partner-vat-basis.test.ts
/* eslint-disable @typescript-eslint/no-unused-vars -- übernommener Harness (nicht jeder Helfer wird hier gebraucht). */
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const store = new Map<string, string>([
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'],
  ['lataif_sync_token', 'test-token'],
]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
await import('../../src/core/automation/automation-handlers.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore, loadPurchasesFor } = await import('../../src/stores/purchaseStore.ts');
const { usePartnerStore, loadPartnersFor } = await import('../../src/stores/partnerStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { bankTransactionsFor } = await import('../../src/stores/bankingStore.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const purchaseRules = await import('../../src/core/purchases/purchase-create.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const rules = await import('../../src/core/partners/item-participation.ts');
const house = await import('../../src/core/partners/item-participation-house.ts');
const save = await import('../../src/core/partners/item-participation-save.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-26T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  useInvoiceStore.getState().loadInvoices();
  usePurchaseStore.getState().loadPurchases();
  usePartnerStore.getState().loadPartners();
}

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  for (const [id, name, active] of [['pa-b', 'Bashir', 1], ['pa-c', 'Chalid', 1], ['pa-off', 'Old Partner', 0]] as Array<[string, string, number]>) {
    db.run(`INSERT INTO partners (id, branch_id, name, share_percentage, active, created_at, updated_at)
      VALUES (?, 'branch-main', ?, 0, ?, ?, ?)`, [id, name, active, NOW, NOW]);
  }
  for (const pid of ['pw1', 'pw2', 'pw3', 'pw4', 'pw5']) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
    [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
async function code(p: () => unknown): Promise<string> {
  try { await p(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)); }
}
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };
type PI = import('../../src/core/purchases/purchase-create.ts').PurchaseCreateInput;
const EINKAUF = (lines: PI['lines'], pay = 0): PI => ({
  supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines,
  paymentAmount: pay, paymentMethod: 'bank', notes: '', staffId: '',
});
const ZEILE = (productId: string, price = 1000, partnerShares?: Array<{ partnerId: string; sharePct: number }>, qty = 1): PI['lines'][number] => ({
  mode: 'existing', productId, brand: 'Rolex', name: 'Sub ' + productId, sku: 'SKU-' + productId, categoryId: 'cat-w',
  quantity: qty, unitPrice: price, ...(partnerShares ? { partnerShares } : {}),
});
const lineOf = (db: Db, purchaseId: string, productId: string): string =>
  s(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ? AND product_id = ?', [purchaseId, productId]);
const lotOf = (db: Db, purchaseLineId: string): string => s(db, 'SELECT id FROM stock_lots WHERE purchase_line_id = ?', [purchaseLineId]);
const open = (lineId: string, partnerId = 'pa-b'): number => house.partnerItemOpen(lineId, partnerId, 'branch-main');
const bal = (account: string): number => {
  const db = DB;
  return n(db, `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?`, [account]);
};
const move = (lineId: string, kind: 'CONTRIBUTION' | 'PAYOUT', amount: number, partnerId = 'pa-b', method: 'cash' | 'bank' | 'benefit' = 'bank') =>
  save.recordItemMovementOnPrimary({ purchaseLineId: lineId, partnerId, kind, amount, method, date: '2026-09-21' });

function verkauf(db: Db, productId: string, lotId: string, price: number, pay: 'none' | 'part' | 'full', qty = 1): { inv: string; il: string } {
  // Wie die Maske: mit gewähltem Los reist dessen Einstand als purchasePrice mit.
  const unitCost = n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lotId]);
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{
    productId, quantity: qty, unitPrice: price, purchasePrice: unitCost, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0,
    lineTotal: price * qty, lotId,
  }] as never, 'P').id);
  reload();
  const brutto = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  if (pay !== 'none') imHaus(() => useInvoiceStore.getState().recordPayment(inv, pay === 'full' ? brutto : brutto / 2, 'cash'));
  reload();
  return { inv, il: s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]) };
}


const cmd2 = await import('../../src/core/bridge/partner-item-commands.ts');
const plc = await import('../../src/core/bridge/purchase-lifecycle-commands.ts');
const { createReturnInHouse } = await import('../../src/core/returns/return-house.ts');
const { returnToSupplierInHouse, cancelPurchaseInHouse } = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { localHouseCtx, applyCreditToPurchaseInHouse } = await import('../../src/core/payables/payables-house.ts');
const { shiftOwnRepairCost } = await import('../../src/core/repairs/repair-cost-booking.ts');
const { runExclusive } = await import('../../src/core/bridge/command-scheduler.ts');
void CTX; void cmd; void loadPartnersFor; void bankTransactionsFor; void purchaseRules;

// ── Helfer VAT_10 ───────────────────────────────────────────────────────────
const DB = freshDb();
for (let i = 6; i <= 40; i++) {
  const pid = 'pw' + i;
  DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
  [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
}
reload();
type Shares = Array<{ partnerId: string; sharePct: number }>;
const kauf = async (pid: string, gross: number, shares: Shares | undefined, qty = 1, pay = 0, scheme: 'ZERO' | 'VAT_10' = 'VAT_10') => {
  const id = (await purchaseHouse.createPurchaseOnPrimary({ ...EINKAUF([ZEILE(pid, gross, shares, qty)], pay), taxScheme: scheme })).id;
  return { id, line: lineOf(DB, id, pid) };
};
const ret = (purchaseId: string, line: string, qty: number, unitPrice: number, refundMethod = 'cash') =>
  imHaus(() => returnToSupplierInHouse({ purchaseId, refundMethod: refundMethod as never, lines: [{ purchaseLineId: line, quantity: qty, unitPrice }] }, localHouseCtx()));
const view = (line: string, partnerId = 'pa-b') => house.partnerItemsOverview('branch-main', partnerId)[0]?.items.find((i) => i.purchaseLineId === line);
/** Verkauf mit 10 % VAT auf den Verkaufspreis (netto), voll bezahlt. */
function verkaufV(productId: string, lotId: string, net: number, qty = 1): { inv: string; il: string } {
  const unitCost = n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lotId]);
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{
    productId, quantity: qty, unitPrice: net, purchasePrice: unitCost, taxScheme: 'VAT_10', vatRate: 10, vatAmount: net * qty * 0.1,
    lineTotal: net * qty * 1.1, lotId,
  }] as never, 'P').id);
  reload();
  const brutto = n(DB, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, brutto, 'cash'));
  reload();
  return { inv, il: s(DB, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]) };
}
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const kontoSaldo = (account: string, partnerId?: string): number => r3(n(DB,
  `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?${partnerId ? ' AND counterparty_id = ?' : ''}`,
  partnerId ? [account, partnerId] : [account]));
const vatInput = (): number => -kontoSaldo('VAT_INPUT');
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const abgleich = (): number => {
  const row = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows.find((x) => x.account === 'PARTNER_ITEM_BALANCE')!;
  return r3(row.ledger - row.domain);
};
/** Hauptbuch je Partner = Summe seiner wirksamen Bewegungen (Beitrag, Gewinnanteil +; Auszahlung −). */
const partnerAbgleich = (partnerId: string): number => {
  const dom = n(DB, `SELECT COALESCE(SUM(CASE WHEN kind = 'PAYOUT' THEN -amount WHEN kind IN ('CONTRIBUTION','PROFIT_SHARE','PROFIT_CORRECTION','SUPPLIER_RETURN') THEN amount ELSE 0 END), 0)
    FROM item_partner_movements WHERE partner_id = ? AND cancelled_at IS NULL`, [partnerId]);
  return r3(kontoSaldo('PARTNER_ITEM_BALANCE', partnerId) - dom);
};
const PB40 = [{ partnerId: 'pa-b', sharePct: 40 }];

// ── V1 Einkauf VAT_10: wirtschaftlicher Kostenanteil netto, Vorsteuer getrennt ──
let V1 = { id: '', line: '' };
{
  const vat0 = vatInput();
  V1 = await kauf('pw6', 1100, PB40, 1, 1100);
  const lot = lotOf(DB, V1.line);
  ok(r3(n(DB, 'SELECT vat_amount FROM purchase_lines WHERE id = ?', [V1.line])) === 100 && r3(n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot])) === 1000
    && r3(vatInput() - vat0) === 100, 'V1 Einkauf 1100 brutto: Vorsteuer 100 abziehbar, Los-Einstand 1000 (netto)');
  ok(open(V1.line) === -400, `V1 B schuldet wirtschaftlich 40 % von 1000 = 400 (${open(V1.line)})`);
  const v = view(V1.line)!;
  ok(v.costShare === 400 && v.extraCosts === 0 && v.extraCostShare === 0 && v.owedCost === 400,
    `V1 Anzeige: Kostenanteil 400 (netto), keine „Zusatzkosten" aus der Vorsteuer (${S([v.costShare, v.extraCosts, v.extraCostShare, v.owedCost])})`);
  ok(v.purchaseGross === 1100 && v.purchaseInputVat === 100 && v.lineTotal === 1000 && v.inputVatInCostShare === 0,
    `V1 Anzeige trennt: Einkauf brutto 1100, Vorsteuer 100 (LATAIF erstattet), Kostenbasis 1000 (${S([v.purchaseGross, v.purchaseInputVat, v.lineTotal, v.inputVatInCostShare])})`);
  ok(r3(n(DB, "SELECT cost_share FROM item_participations WHERE purchase_line_id = ? AND party = 'PARTNER'", [V1.line])) === 400
    && r3(n(DB, "SELECT line_total FROM item_participations WHERE purchase_line_id = ? AND party = 'PARTNER'", [V1.line])) === 1000,
    'V1 gespeichert: Kostenanteil 400 und Kostenbasis 1000 (netto) — dieselbe Basis wie das Los');
  ok(await code(() => move(V1.line, 'CONTRIBUTION', 401)) === rules.PARTNER_ITEM_OVERFUNDED, 'V1 Beitrag über dem wirtschaftlichen Anteil abgewiesen');
  await move(V1.line, 'CONTRIBUTION', 250);
  ok(open(V1.line) === -150, `V1 Teilbeitrag 250 → schuldet noch 150 (${open(V1.line)})`);
  await move(V1.line, 'CONTRIBUTION', 150);
  ok(open(V1.line) === 0 && abgleich() === 0 && partnerAbgleich('pa-b') === 0 && ausgeglichen(), 'V1 voll eingezahlt: 0 offen, Hauptbuch = Domäne');
}

// ── V2 Verkauf VAT_10 mit Gewinn: Gewinn = Netto − Einstand, Vorsteuer/Umsatzsteuer nie im Gewinn ──
{
  const v = verkaufV('pw6', lotOf(DB, V1.line), 1500);
  await save.settleSaleOnPrimary(v.il);
  const ps = r3(n(DB, "SELECT amount FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PROFIT_SHARE' AND cancelled_at IS NULL", [V1.line]));
  ok(ps === 200, `V2 Verkauf 1650 brutto (150 VAT): Gewinn 500, B 40 % = 200 (${ps})`);
  ok(open(V1.line) === 600, `V2 B bekommt Kapital 400 + Gewinn 200 = 600 (${open(V1.line)})`);
  await move(V1.line, 'PAYOUT', 600, 'pa-b', 'bank');
  ok(open(V1.line) === 0 && kontoSaldo('PARTNER_ITEM_BALANCE', 'pa-b') === 0 && abgleich() === 0 && ausgeglichen(), 'V2 ausgezahlt: Partnerkonto 0, Abgleich ohne Differenz');
}

// ── V3 Lieferantenrückgabe VAT_10 zum vollen Preis: kein „Gewinn" aus der Vorsteuer ──
{
  const a = await kauf('pw7', 1100, PB40, 1, 1100);
  await move(a.line, 'CONTRIBUTION', 400);
  const vat0 = vatInput();
  const ps0 = kontoSaldo('PARTNER_ITEM_PROFIT_SHARE');
  ret(a.id, a.line, 1, 1100, 'cash');
  const amt = r3(n(DB, "SELECT amount FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'SUPPLIER_RETURN'", [a.line]));
  ok(amt === 0, `V3 Rückgabe 1100 brutto = 1000 netto + 100 Vorsteuer zurück: Partnerergebnis 0, nicht 40 (${amt})`);
  ok(r3(vat0 - vatInput()) === 100, 'V3 Vorsteuer 100 wird mit der Rückgabe zurückgebucht');
  ok(open(a.line) === 400, `V3 B bekommt genau seine 400 zurück (${open(a.line)})`);
  ok(kontoSaldo('PARTNER_ITEM_PROFIT_SHARE') === ps0 && abgleich() === 0 && ausgeglichen(), 'V3 kein Gewinnanteil gebucht, Abgleich ohne Differenz');
  const b = view(a.line)!.movements.find((m) => m.kind === 'SUPPLIER_RETURN')!;
  ok(/refund value 1000\.000 vs cost 1000\.000/.test(String(b.detail)), `V3 Verlauf nennt den Netto-Erstattungswert (${b.detail})`);
}

// ── V4 Rückgabe mit geringerer Erstattung (990 brutto = 900 netto): Verlust 100, B trägt 40 ──
{
  const a = await kauf('pw8', 1100, PB40, 1, 1100);
  await move(a.line, 'CONTRIBUTION', 400);
  ret(a.id, a.line, 1, 990, 'bank');
  ok(open(a.line) === 360, `V4 Erstattung 990 brutto (900 netto): Verlust 100, B −40 → 360 (${open(a.line)})`);
  ok(abgleich() === 0 && ausgeglichen(), 'V4 Abgleich ohne Differenz');
}

// ── V5 Zwei Partner, zwei Stücke, Teilbeiträge, Verkauf eines Stücks, Rückgabe des anderen ──
{
  const a = await kauf('pw9', 550, [{ partnerId: 'pa-b', sharePct: 30 }, { partnerId: 'pa-c', sharePct: 20 }], 2, 1100);
  ok(open(a.line, 'pa-b') === -300 && open(a.line, 'pa-c') === -200, `V5 netto 1000: B schuldet 300, C 200 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
  await move(a.line, 'CONTRIBUTION', 300, 'pa-b');
  await move(a.line, 'CONTRIBUTION', 100, 'pa-c');
  const v = verkaufV('pw9', lotOf(DB, a.line), 800);
  await save.settleSaleOnPrimary(v.il);
  ok(open(a.line, 'pa-b') === 240 && open(a.line, 'pa-c') === 60,
    `V5 1 Stück verkauft (Gewinn 300): B 300 + 90 − 150 = 240, C 100 + 60 − 100 = 60 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
  ret(a.id, a.line, 1, 550, 'cash');
  ok(open(a.line, 'pa-b') === 390 && open(a.line, 'pa-c') === 160,
    `V5 zweites Stück zurück (netto 500 = Einstand): B 390, C 160 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
  ok(abgleich() === 0 && partnerAbgleich('pa-c') === 0 && ausgeglichen(), 'V5 Abgleich je Partner ohne Differenz');
}

// ── V6 Ohne VAT (ZERO): unverändert ──────────────────────────────────────────
{
  const a = await kauf('pw10', 1000, PB40, 1, 1000, 'ZERO');
  const v = view(a.line)!;
  ok(open(a.line) === -400 && v.costShare === 400 && v.extraCosts === 0 && v.purchaseGross === 1000 && v.purchaseInputVat === 0,
    `V6 ZERO: Kostenanteil 400, Basis = Bruttopreis (${S([open(a.line), v.costShare, v.purchaseGross, v.purchaseInputVat])})`);
  await move(a.line, 'CONTRIBUTION', 400);
  ret(a.id, a.line, 1, 1000, 'cash');
  ok(open(a.line) === 400 && r3(n(DB, "SELECT amount FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'SUPPLIER_RETURN'", [a.line])) === 0,
    'V6 ZERO-Rückgabe wie bisher: Ergebnis 0, B bekommt 400');
}

// ── V7 Reparatur am VAT_10-Artikel: nur die Reparatur ist „Zusatzkosten" ──────
{
  const a = await kauf('pw11', 1100, PB40, 1, 1100);
  imHaus(() => shiftOwnRepairCost({ id: 'rep-v7', productId: 'pw11', lotId: lotOf(DB, a.line) } as never, 100, NOW, 'Reparatur'));
  const v = view(a.line)!;
  ok(open(a.line) === -440 && v.extraCosts === 100 && v.extraCostShare === 40 && v.costShare === 400,
    `V7 Reparatur 100: B schuldet 400 + 40 = 440, Zusatzkosten genau 100 (${S([open(a.line), v.costShare, v.extraCosts, v.extraCostShare])})`);
  await move(a.line, 'CONTRIBUTION', 440);
  const s7 = verkaufV('pw11', lotOf(DB, a.line), 1500);
  await save.settleSaleOnPrimary(s7.il);
  ok(open(a.line) === 600, `V7 Verkauf netto 1500 − Einstand 1100 = 400 Gewinn, B 160 → 440 + 160 = 600 (${open(a.line)})`);
  ok(abgleich() === 0 && ausgeglichen(), 'V7 Abgleich ohne Differenz');
}

// ── V8 Verkauf mit Verlust (VAT_10) ─────────────────────────────────────────
{
  const a = await kauf('pw12', 1100, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1100);
  await move(a.line, 'CONTRIBUTION', 500);
  const s8 = verkaufV('pw12', lotOf(DB, a.line), 800);
  await save.settleSaleOnPrimary(s8.il);
  ok(open(a.line) === 400, `V8 netto 800 − 1000 = −200, B trägt 100 → 400 (${open(a.line)})`);
  ok(abgleich() === 0 && ausgeglichen(), 'V8 Abgleich ohne Differenz');
}

// ── V9 Altbestand: Abschnitt brutto gespeichert (vor v0.8.101) — Salden unverändert, Anzeige erklärt ──
{
  const a = await kauf('pw13', 1100, PB40, 1, 1100);
  // So legte die alte Version den Abschnitt an: Kostenbasis und Kostenanteil brutto.
  DB.run("UPDATE item_participations SET line_total = 1100, unit_cost = 1100, cost_share = CASE party WHEN 'PARTNER' THEN 440 ELSE 660 END WHERE purchase_line_id = ?", [a.line]);
  const vorher = S(DB.exec('SELECT * FROM item_participations WHERE purchase_line_id = ?', [a.line]));
  ok(open(a.line) === -400, `V9 Altbestand: B schuldet weiterhin 400 (netto) — keine Saldoänderung (${open(a.line)})`);
  const v = view(a.line)!;
  ok(v.costShare === 440 && v.inputVatInCostShare === 40 && v.extraCostShare === -40 && v.owedCost === 400,
    `V9 Anzeige nennt die enthaltene Vorsteuer 40 statt „Zusatzkosten" (${S([v.costShare, v.inputVatInCostShare, v.extraCostShare, v.owedCost])})`);
  ok(S(DB.exec('SELECT * FROM item_participations WHERE purchase_line_id = ?', [a.line])) === vorher, 'V9 Lesen ändert keine Daten');
  await move(a.line, 'CONTRIBUTION', 400);
  ret(a.id, a.line, 1, 1100, 'cash');
  ok(open(a.line) === 400 && abgleich() === 0, `V9 Altbestand-Rückgabe: auch hier kein Vorsteuer-„Gewinn" (${open(a.line)})`);
}

// ── V10 Code: Einkauf übergibt die Vorsteuer; Rückgabe rechnet wie die Rückgabebuchung ──
{
  const ps = src('src/stores/purchaseStore.ts');
  ok(/insertLineParticipations\([\s\S]{0,300}vatAmount: l\.vatAmount/.test(ps), 'V10 createPurchase übergibt die Vorsteuer je Zeile');
  ok(/getPurchaseLineInputSplit/.test(src('src/core/partners/item-participation-house.ts')), 'V10 Rückgabe: Netto-Erstattungswert aus derselben Vorsteuer-Aufteilung wie die Buchung');
}

console.log(`\npartner-vat-basis: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_VAT_BASIS_PROVED');
