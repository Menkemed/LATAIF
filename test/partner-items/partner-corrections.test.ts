// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — Nachabrechnung, Rückforderung, Verrechnung, nachträgliche Kosten, Sperren, PC2-Befehle
// (Wiederholung, Konflikt, gleichzeitige Aufträge) und Bericht.
// Run: node --experimental-strip-types test/partner-items/partner-corrections.test.ts
// ════════════════════════════════════════════════════════════════════════════
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
const { createReturnInHouse } = await import('../../src/core/returns/return-house.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { returnToSupplierInHouse } = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { localHouseCtx } = await import('../../src/core/payables/payables-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { shiftOwnRepairCost } = await import('../../src/core/repairs/repair-cost-booking.ts');
const { computeSalesMetrics } = await import('../../src/core/reports/sales-metrics.ts');
const { runExclusive } = await import('../../src/core/bridge/command-scheduler.ts');
void CTX; void cmd; void loadPartnersFor; void bankTransactionsFor; void purchaseRules;

const DB = freshDb();
for (const pid of ['pw6', 'pw7', 'pw8', 'pw9']) {
  DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
  [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
}
reload();
const kauf = async (pid: string, price: number, shares: Array<{ partnerId: string; sharePct: number }> | undefined, qty = 1, pay = 0) => {
  const id = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE(pid, price, shares, qty)], pay))).id;
  return { id, line: lineOf(DB, id, pid) };
};
const supplierSide = () => S([n(DB, 'SELECT COUNT(*) FROM purchase_payments'),
  n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0),3) FROM ledger_entries WHERE account='ACCOUNTS_PAYABLE'")]);
const itemOf = (line: string, partnerId = 'pa-b') => house.partnerItemsOverview('branch-main', partnerId)[0].items.find((i) => i.purchaseLineId === line)!;
function retoure(inv: string, il: string, disposition: string, refundNow = true): string {
  return String(imHaus(() => createReturnInHouse({
    invoiceId: inv, lines: [{ invoiceLineId: il, quantity: 1 }], refundMethod: 'cash', productDisposition: disposition as never,
    reason: 'Test', refundNow,
  }, 'branch-main')).returnId);
}

// ── A Mehrere Partner, unterschiedliche Anteile, fehlende/teilweise/vollständige Beiträge, filsgenau ──
{
  const a = await kauf('pw1', 999.999, [{ partnerId: 'pa-b', sharePct: 20 }, { partnerId: 'pa-c', sharePct: 30.55 }], 1, 999.999);
  const parts = DB.exec('SELECT party, partner_id, share_bp, cost_share FROM item_participations WHERE purchase_line_id = ? ORDER BY party, partner_id', [a.line])[0].values;
  const sumCost = n(DB, 'SELECT ROUND(SUM(cost_share), 3) FROM item_participations WHERE purchase_line_id = ?', [a.line]);
  ok(sumCost === 999.999 && S(parts) === S([['HOUSE', null, 4945, 494.499], ['PARTNER', 'pa-b', 2000, 200], ['PARTNER', 'pa-c', 3055, 305.5]]),
    `MULTI Anteile 49,45/20/30,55 auf 999,999: Kostenanteile filsgenau, Summe exakt (${S(parts)})`);
  ok(open(a.line, 'pa-b') === -200 && open(a.line, 'pa-c') === -305.5, 'MULTI ohne Beitrag schulden beide ihren Kostenanteil');
  await move(a.line, 'CONTRIBUTION', 200, 'pa-b');
  await move(a.line, 'CONTRIBUTION', 100.25, 'pa-c', 'cash');
  ok(open(a.line, 'pa-b') === 0 && open(a.line, 'pa-c') === -205.25, 'MULTI vollständig (B) und teilweise (C) finanziert');
  const v = verkauf(DB, 'pw1', lotOf(DB, a.line), 1333.333, 'full');
  const r = await save.settleSaleOnPrimary(v.il);
  const b = r.shares.find((x) => x.partnerId === 'pa-b')!.amount;
  const c = r.shares.find((x) => x.partnerId === 'pa-c')!.amount;
  ok(r.profit === 333.334 && b === 66.667 && c === 101.834, `MULTI Gewinn 333,334 → B 20 % = 66,667, C 30,55 % = 101,834 (${S(r.shares)})`);
  ok(open(a.line, 'pa-b') === 266.667 && open(a.line, 'pa-c') === 202.084, `MULTI nach Verkauf: B 200+66,667, C 100,25+101,834 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
}

// ── B Beispiel des Nutzers: 600/400, Partner zahlt die 100 vor dem Verkauf → Anspruch 650 ──
let EX = { line: '', inv: '', il: '' };
{
  const a = await kauf('pw2', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 600);
  await move(a.line, 'CONTRIBUTION', 400);
  await move(a.line, 'CONTRIBUTION', 100, 'pa-b', 'cash');
  ok(open(a.line) === 0, 'BEISPIEL 400 + 100 nachgezahlt → ausgeglichen');
  const vorher = supplierSide();
  const v = verkauf(DB, 'pw2', lotOf(DB, a.line), 1300, 'full');
  await save.settleSaleOnPrimary(v.il);
  ok(open(a.line) === 650, `BEISPIEL Auszahlungsanspruch 650 (${open(a.line)})`);
  await move(a.line, 'PAYOUT', 650);
  ok(open(a.line) === 0 && supplierSide() === vorher, 'BEISPIEL ausgezahlt; Lieferantenseite unverändert (keine zusätzliche Lieferantenzahlung)');
  EX = { line: a.line, ...v };
}

// ── C Retoure NACH Abrechnung und Auszahlung: Nachabrechnung, Rückforderung, Verlauf bleibt ──
{
  const ret = retoure(EX.inv, EX.il, 'IN_STOCK');
  reload();
  const st = s(DB, 'SELECT status FROM sales_returns WHERE id = ?', [ret]);
  ok(['APPROVED', 'REFUNDED', 'CLOSED'].includes(st), `RETOURE angelegt und erstattet (${st})`);
  const it = itemOf(EX.line);
  ok(it.correctionPending && it.sales[0].state === 'NEEDS_CORRECTION' && it.sales[0].settleable, 'RETOURE die Abrechnung ist als nachzurechnen markiert');
  ok(await code(() => move(EX.line, 'PAYOUT', 1)) === rules.PARTNER_SALE_NEEDS_CORRECTION, 'RETOURE Auszahlungen sind bis zur Nachabrechnung gesperrt');
  const payoutsVor = n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PAYOUT' AND cancelled_at IS NULL", [EX.line]);
  const r = await save.settleSaleOnPrimary(EX.il);
  ok(r.mode === 'CORRECTION' && r.shares[0].amount === -150 && r.shares[0].total === 0, `RETOURE Nachabrechnung bucht nur die Differenz −150 (${S(r)})`);
  ok(n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PAYOUT' AND cancelled_at IS NULL", [EX.line]) === payoutsVor
    && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PROFIT_SHARE' AND cancelled_at IS NULL", [EX.line]) === 1,
    'RETOURE die Erstabrechnung und die echte Auszahlung bleiben stehen');
  // B hat 500 gezahlt, 650 bekommen; das Stück ist zurück (halb seins, 500) → B schuldet 650.
  ok(open(EX.line) === -650, `RETOURE Rückforderung: B schuldet LATAIF 650 (${open(EX.line)})`);
  ok(await code(() => save.settleSaleOnPrimary(EX.il)) === rules.PARTNER_SALE_ALREADY_SETTLED, 'RETOURE keine zweite Nachabrechnung ohne neue Änderung');
  ok(await code(() => move(EX.line, 'CONTRIBUTION', 1150.001)) === rules.PARTNER_ITEM_OVERFUNDED, 'RÜCKZAHLUNG nicht mehr als erlaubt');
  await move(EX.line, 'CONTRIBUTION', 650, 'pa-b', 'cash');
  ok(open(EX.line) === 0, 'RÜCKZAHLUNG 650 → ausgeglichen, B hält wieder seine Hälfte');
  const v2 = verkauf(DB, 'pw2', lotOf(DB, EX.line), 1400, 'full');
  const r2 = await save.settleSaleOnPrimary(v2.il);
  ok(r2.mode === 'SETTLEMENT' && r2.shares[0].amount === 200 && open(EX.line) === 700, `WIEDERVERKAUF 1400 → B 200, Anspruch 500 + 200 (${open(EX.line)})`);
}

// ── D Änderung und Storno der Rechnung nach Abrechnung ──────────────────────
{
  const a = await kauf('pw3', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  const v = verkauf(DB, 'pw3', lotOf(DB, a.line), 1300, 'full');
  await save.settleSaleOnPrimary(v.il);
  const zeile = DB.exec('SELECT id, lot_id FROM invoice_lines WHERE invoice_id = ?', [v.inv])[0].values[0];
  imHaus(() => useInvoiceStore.getState().editInvoice(v.inv, {
    lines: [{ lineId: zeile[0], productId: 'pw3', quantity: 1, unitPrice: 1500, purchasePrice: 1000, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1500, lotId: zeile[1] }] as never,
    reason: 'Preis korrigiert',
  } as never));
  reload();
  ok(s(DB, 'SELECT status FROM invoices WHERE id = ?', [v.inv]) === 'PARTIAL', 'ÄNDERUNG Rechnung 1500, teilbezahlt');
  ok(await code(() => save.settleSaleOnPrimary(v.il)) === rules.PARTNER_SALE_NOT_PAID, 'ÄNDERUNG Nachabrechnung wartet auf volle Zahlung (kein vorzeitiger Gewinn)');
  ok(await code(() => move(a.line, 'PAYOUT', 1)) === rules.PARTNER_SALE_NEEDS_CORRECTION, 'ÄNDERUNG Auszahlung gesperrt, solange die Abrechnung veraltet ist');
  imHaus(() => useInvoiceStore.getState().recordPayment(v.inv, 200, 'cash'));
  reload();
  const r = await save.settleSaleOnPrimary(v.il);
  ok(r.mode === 'CORRECTION' && r.shares[0].amount === 100 && open(a.line) === 750, `ÄNDERUNG nach Vollzahlung: +100 nachberechnet, Anspruch 750 (${open(a.line)})`);
  const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
  // Eine zweite zulässige Änderung macht die Rechnung wieder teilbezahlt — dann darf sie storniert werden.
  imHaus(() => useInvoiceStore.getState().editInvoice(v.inv, {
    lines: [{ lineId: zeile[0], productId: 'pw3', quantity: 1, unitPrice: 1600, purchasePrice: 1000, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1600, lotId: zeile[1] }] as never,
    reason: 'Preis erneut',
  } as never));
  reload();
  const storno = await code(() => imHaus(() => cancelInvoiceInHouse({ invoiceId: v.inv, refundMethod: 'cash' }, 'branch-main')));
  reload();
  const stornoStatus = s(DB, 'SELECT status FROM invoices WHERE id = ?', [v.inv]);
  ok(stornoStatus === 'CANCELLED', `STORNO Rechnung storniert (${storno || 'ok'})`);
  if (stornoStatus === 'CANCELLED') {
    const rc = await save.settleSaleOnPrimary(v.il);
    ok(rc.shares[0].total === 0 && rc.shares[0].amount === -250 && open(a.line) === 0,
      `STORNO Nachabrechnung auf 0 (−250), B hält wieder seine Hälfte (${open(a.line)})`);
  }
}

// ── E Nachträgliche Artikelkosten (Reparatur eigener Ware, vor dem Verkauf) ──
{
  const a = await kauf('pw4', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  ok(open(a.line) === 0, 'KOSTEN vor der Reparatur ausgeglichen');
  imHaus(() => shiftOwnRepairCost({ id: 'rep-1', productId: 'pw4', lotId: lotOf(DB, a.line) } as never, 100, NOW, 'Test-Reparatur'));
  const it = itemOf(a.line);
  ok(open(a.line) === -50 && it.extraCosts === 100 && it.extraCostShare === 50, `KOSTEN Reparatur 100 → B schuldet seinen Anteil 50 (${open(a.line)})`);
  await move(a.line, 'CONTRIBUTION', 50, 'pa-b', 'cash');
  const v = verkauf(DB, 'pw4', lotOf(DB, a.line), 1300, 'full');
  ok(n(DB, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE id = ?', [v.il]) === 1100, 'KOSTEN der Einstand des Verkaufs enthält die Reparatur (ERP)');
  const r = await save.settleSaleOnPrimary(v.il);
  ok(r.profit === 200 && r.shares[0].amount === 100 && open(a.line) === 650, `KOSTEN Gewinn 200 → B 100; Anspruch 550 + 100 = 650 (${open(a.line)})`);
  const nach = await code(() => imHaus(() => shiftOwnRepairCost({ id: 'rep-2', productId: 'pw4', lotId: lotOf(DB, a.line) } as never, 30, NOW, 'zu spät')));
  ok(nach === 'REPAIR_COST_ALREADY_SOLD' && open(a.line) === 650, 'KOSTEN nach dem Verkauf ändert das ERP den Einstand nicht — die Abrechnung bleibt');
}

// ── F Verrechnung zwischen zwei Artikeln (ohne Geld) ────────────────────────
{
  const x = await kauf('pw5', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
  await move(x.line, 'CONTRIBUTION', 500);
  const vx = verkauf(DB, 'pw5', lotOf(DB, x.line), 1200, 'full');
  await save.settleSaleOnPrimary(vx.il);
  ok(open(x.line) === 600, `VERRECHNUNG x verkauft und abgerechnet: LATAIF schuldet 500 + 100 (${open(x.line)})`);
  const y = await kauf('pw6', 400, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 400);
  const le = n(DB, 'SELECT COUNT(*) FROM ledger_entries');
  ok(await code(() => save.offsetItemsOnPrimary({ partnerId: 'pa-b', fromPurchaseLineId: x.line, toPurchaseLineId: y.line, amount: 200.001, date: '2026-09-26' }))
    === rules.PARTNER_ITEM_OFFSET_INVALID, 'VERRECHNUNG nicht mehr als am zweiten Artikel offen');
  const o = await save.offsetItemsOnPrimary({ partnerId: 'pa-b', fromPurchaseLineId: x.line, toPurchaseLineId: y.line, amount: 100, date: '2026-09-26' });
  ok(open(x.line) === 500 && open(y.line) === -100 && n(DB, 'SELECT COUNT(*) FROM ledger_entries') === le, `VERRECHNUNG 100: beide Artikel angepasst, kein Geld, keine Buchung (${o.openFrom}/${o.openTo})`);
  const offId = s(DB, "SELECT id FROM item_partner_movements WHERE kind = 'OFFSET' AND purchase_line_id = ?", [x.line]);
  await save.cancelItemMovementOnPrimary(offId);
  ok(open(x.line) === 600 && open(y.line) === -200, 'VERRECHNUNG Storno nimmt das Paar gemeinsam zurück');
}

// ── G Sperren: was ein gemeinsames Stück ohne Verkauf aus der Beteiligung nähme ──
{
  const a = await kauf('pw7', 800, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 800);
  const pr = await code(() => imHaus(() => returnToSupplierInHouse({ purchaseId: a.id, refundMethod: 'cash' as never, lines: [{ purchaseLineId: a.line, quantity: 1, unitPrice: 800 }] }, localHouseCtx())));
  // Seit PARTNER-ITEMS Rückgaben: die Rückgabe an den Lieferanten geht und rechnet den Partneranteil ab.
  ok(pr === '' && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE kind = 'SUPPLIER_RETURN' AND purchase_line_id = ?", [a.line]) === 1,
    `RÜCKGABE an den Lieferanten mit Partnerabrechnung (${pr || 'ok'})`);
  const a2 = await kauf('pw7', 800, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 800);
  const prod = await code(() => createProductionInHouse({ inputProductIds: ['pw7'], outputs: [] } as never, { branchId: 'branch-main', userId: 'user-test' }));
  ok(prod === 'PARTNER_ITEM_JOINT_BLOCKED', `SPERRE Verbrauch in der Fertigung (${prod})`);
  const v = verkauf(DB, 'pw7', lotOf(DB, a2.line), 900, 'full');
  const ret = await code(() => retoure(v.inv, v.il, 'UNDER_REPAIR'));
  ok(ret === 'PARTNER_ITEM_JOINT_BLOCKED', `SPERRE Retoure „Under repair" nähme das Stück aus der Beteiligung (${ret})`);
  const pending = retoure(v.inv, v.il, 'WRITE_OFF', false);
  reload();
  ok(await code(() => save.settleSaleOnPrimary(v.il)) === rules.PARTNER_SALE_PENDING, 'RETOURE offen (noch nicht erstattet) → Abrechnung wartet');
  imHaus(() => useSalesReturnStore.getState().refundReturn(pending));
  reload();
  const r = await save.settleSaleOnPrimary(v.il);
  ok(r.profit === -800 && r.shares[0].amount === -400, `ABSCHREIBUNG voll erstattet, Stück abgeschrieben → Verlust 800, B trägt 400 (${S(r)})`);
  const solo = await kauf('pw8', 300, undefined, 1, 300);
  const ok2 = await code(() => imHaus(() => returnToSupplierInHouse({ purchaseId: solo.id, refundMethod: 'cash' as never, lines: [{ purchaseLineId: solo.line, quantity: 1, unitPrice: 300 }] }, localHouseCtx())));
  ok(ok2 === '', `OHNE Partner: Rückgabe an den Lieferanten wie bisher (${ok2 || 'ok'})`);
}

// ── H PC2: Befehle, Wiederholung, Konflikt, Filiale, Rumpf, gleichzeitige Aufträge ──
{
  const a = await kauf('pw9', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-00000000abcd`;
  const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
  const deps = () => ({ db: DB as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
  const zuViel = await cmd2.runItemMovement(deps(), identity('10', 'partner_items.record_movement'),
    { purchaseLineId: a.line, partnerId: 'pa-b', kind: 'CONTRIBUTION', amount: 700, method: 'bank', date: '2026-09-26' });
  ok(zuViel.kind === 'rejected' && (zuViel as { code?: string }).code === rules.PARTNER_ITEM_OVERFUNDED && open(a.line) === -500,
    `PC2 Beitrag 700 auf Kostenanteil 500 → Nein, nichts gebucht (${S(zuViel)})`);
  const body = { purchaseLineId: a.line, partnerId: 'pa-b', kind: 'CONTRIBUTION', amount: 500, method: 'bank', date: '2026-09-26' };
  const o1 = await cmd2.runItemMovement(deps(), identity('1', 'partner_items.record_movement'), body);
  const o2 = await cmd2.runItemMovement(deps(), identity('1', 'partner_items.record_movement'), body);
  ok(o1.kind === 'ok' && o2.kind === 'ok' && o2.replayed === true
    && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'CONTRIBUTION'", [a.line]) === 1,
    'PC2 Beitrag; Wiederholung derselben Kennung bucht NICHT ein zweites Mal');
  ok(open(a.line) === 0, `PC2 Beitrag 500 = Kostenanteil → nichts offen (${open(a.line)})`);
  const nochmal = await cmd2.runItemMovement(deps(), identity('11', 'partner_items.record_movement'), { ...body, amount: 1 });
  ok(nochmal.kind === 'rejected' && (nochmal as { code?: string }).code === rules.PARTNER_ITEM_NOTHING_OWED && open(a.line) === 0,
    `PC2 weiterer Beitrag auf ausgeglichenen Artikel → Nein (${S(nochmal)})`);
  const conflictOut = await cmd2.runItemMovement(deps(), identity('1', 'partner_items.record_movement', 'anders'), { ...body, amount: 1 }).catch((e) => ({ kind: 'thrown', code: (e as { code?: string }).code }));
  const conflict = String((conflictOut as { code?: string }).code ?? '');
  ok(conflict === 'COMMAND_ID_CONFLICT', `PC2 dieselbe Kennung mit anderem Inhalt → Konflikt (${conflict})`);
  const fremd = await cmd2.runItemMovement(deps(), { ...identity('2', 'partner_items.record_movement'), branchId: 'branch-other' }, body);
  ok(fremd.kind === 'rejected' && (fremd as { code?: string }).code === 'BRANCH_MISMATCH', 'PC2 fremde Filiale → Nein');
  let felder = '';
  try { cmd2.parseItemMovement({ ...body, open: 5 }); } catch (e) { felder = String((e as Error).message); }
  let unbekannt = '';
  try { cmd2.parseItemMovement({ ...body, supplierPayment: true }); } catch (e) { unbekannt = String((e as Error).message); }
  ok(/primary decides open/.test(felder) && /unknown field/.test(unbekannt), 'PC2 berechnete und unbekannte Felder werden abgewiesen');
  const v = verkauf(DB, 'pw9', lotOf(DB, a.line), 1100, 'full');
  const st = await cmd2.runSettleSale(deps(), identity('5', 'partner_items.settle_sale'), { invoiceLineId: v.il });
  const st2 = await cmd2.runSettleSale(deps(), identity('5', 'partner_items.settle_sale'), { invoiceLineId: v.il });
  const st3 = await cmd2.runSettleSale(deps(), identity('6', 'partner_items.settle_sale'), { invoiceLineId: v.il });
  ok(st.kind === 'ok' && st2.replayed === true && st3.kind === 'rejected' && (st3 as { code?: string }).code === rules.PARTNER_SALE_ALREADY_SETTLED
    && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE invoice_line_id = ? AND cancelled_at IS NULL", [v.il]) === 1,
    'PC2 Abrechnung genau einmal (Wiederholung = Ergebnis, neuer Auftrag = Nein)');
  const settleId = s(DB, "SELECT id FROM item_partner_movements WHERE invoice_line_id = ? AND kind = 'PROFIT_SHARE'", [v.il]);
  const c1 = await cmd2.runCancelMovement(deps(), identity('7', 'partner_items.cancel_movement'), { movementId: settleId });
  ok(c1.kind === 'ok' && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE invoice_line_id = ? AND cancelled_at IS NULL", [v.il]) === 0,
    'PC2 Storno einer Abrechnung (Erfassungsfehler, nichts danach gebucht)');
  const st4 = await cmd2.runSettleSale(deps(), identity('9', 'partner_items.settle_sale'), { invoiceLineId: v.il });
  ok(st4.kind === 'ok' && open(a.line) === 550, `PC2 neu abgerechnet: B 500 zurück + 50 % von 100 → LATAIF schuldet 550 (${open(a.line)})`);
  const beitragBeiGuthaben = await cmd2.runItemMovement(deps(), identity('12', 'partner_items.record_movement'), { ...body, amount: 1 });
  ok(beitragBeiGuthaben.kind === 'rejected' && (beitragBeiGuthaben as { code?: string }).code === rules.PARTNER_ITEM_NOTHING_OWED,
    'PC2 LATAIF schuldet dem Partner → kein Beitrag, nur Auszahlung');
  const pay = { purchaseLineId: a.line, partnerId: 'pa-b', kind: 'PAYOUT', amount: 550, method: 'cash', date: '2026-09-26' };
  const [p1, p2, p3] = await Promise.all([
    // Wie an der Route: jeder Fernauftrag läuft im exklusiven Platz der Schreibreihenfolge.
    runExclusive(() => cmd2.runItemMovement(deps(), identity('3', 'partner_items.record_movement'), pay)),
    runExclusive(() => cmd2.runItemMovement(deps(), identity('4', 'partner_items.record_movement'), pay)),
    code(() => save.recordItemMovementOnPrimary(pay as never)),
  ]);
  const okCount = [p1.kind === 'ok', p2.kind === 'ok', p3 === ''].filter(Boolean).length;
  ok(okCount === 1 && open(a.line) === 0 && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PAYOUT' AND cancelled_at IS NULL", [a.line]) === 1,
    `GLEICHZEITIG genau eine von drei Auszahlungen verbraucht die 550 (${S([p1.kind, p2.kind, p3 || 'ok'])})`);
  const rej = p1.kind === 'rejected' ? '3' : '4';
  const again = await cmd2.runItemMovement(deps(), identity(rej, 'partner_items.record_movement'), pay);
  ok(again.kind === 'rejected' && (again as { code?: string }).code === rules.PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN,
    'PC2 das eingefrorene Nein kommt bei Wiederholung genauso zurück (Buchungsstatus eindeutig)');
  const erledigt = await cmd2.runItemMovement(deps(), identity('13', 'partner_items.record_movement'), { ...body, amount: 1 });
  ok(erledigt.kind === 'rejected' && (erledigt as { code?: string }).code === rules.PARTNER_ITEM_NOTHING_OWED,
    'PC2 verkauft, abgerechnet, ausgezahlt (OPEN 0) → kein weiterer Beitrag');
  const off = await cmd2.runItemOffset(deps(), identity('8', 'partner_items.offset'), { partnerId: 'pa-b', fromPurchaseLineId: a.line, toPurchaseLineId: EX.line, amount: 1, date: '2026-09-26' });
  ok(off.kind === 'rejected' && (off as { code?: string }).code === rules.PARTNER_ITEM_OFFSET_INVALID, `PC2 Verrechnung prüft am Primary (${S(off)})`);
}

// ── I Bericht: Gesamtgewinn unverändert, Partneranteil genau einmal abgezogen ──
{
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  const invs = useInvoiceStore.getState().invoices as never;
  const m = computeSalesMetrics(invs, useSalesReturnStore.getState().returns as never);
  const ohneRetouren = computeSalesMetrics(invs, []);
  const sumMargin = (useInvoiceStore.getState().invoices as Array<{ status: string; marginSnapshot?: number }>)
    .filter((i) => i.status === 'FINAL').reduce((a2, i) => a2 + (i.marginSnapshot || 0), 0);
  ok(Math.abs(ohneRetouren.profit - sumMargin) < 0.0005 && m.profit <= ohneRetouren.profit, 'BERICHT „Total Profit" bleibt der volle ERP-Gewinn (kein Partnerabzug darin)');
  const ov = house.partnerItemsOverview('branch-main');
  const released = ov.reduce((a2, p) => a2 + p.profitReleased, 0);
  ok(Math.abs(-bal('PARTNER_ITEM_PROFIT_SHARE') - released) < 0.0005, `BERICHT freigegeben = gebuchter Partneraufwand (${released})`);
  const reports = ['src/pages/reports/BusinessReportsPage.tsx', 'src/core/reports/sales-metrics.ts', 'src/core/reports/analytics-snapshot.ts', 'src/pages/dashboard/Dashboard.tsx'];
  ok(reports.every((f) => !src(f).includes('PARTNER_ITEM_PROFIT_SHARE')), 'BERICHT kein Bericht liest den gebuchten Partneraufwand — kein doppelter Abzug');
  ok(/profitReport\.profit - jointProfit\.partnerShares/.test(src('src/pages/reports/BusinessReportsPage.tsx')), 'BERICHT „nach Partneranteilen" = Gesamtgewinn − Partneranteile (einmal)');
}

// ── Abgleich und Hauptbuch am Ende ──────────────────────────────────────────
{
  const rec = reconciliationSnapshotFor({ branchId: 'branch-main' } as never);
  const row = rec.rows.find((x) => x.account === 'PARTNER_ITEM_BALANCE')!;
  ok(Math.abs(row.ledger - row.domain) < 0.0005, `ABGLEICH Partner-Ausgleichskonto Hauptbuch ${row.ledger} = Domäne ${row.domain}`);
  ok(n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0, 'ABGLEICH Hauptbuch ausgeglichen');
  const reg = src('src/core/bridge/command-registry.ts');
  ok(['partner_items.record_movement', 'partner_items.settle_sale', 'partner_items.offset', 'partner_items.cancel_movement'].every((o) => reg.includes(`'${o}'`))
    && src('src-tauri/src/bridge.rs').includes('"partner_items.settle_sale"'), 'REGISTRY die vier Befehle stehen in TS- und Rust-Liste');
}

console.log(`\npartner-corrections: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
