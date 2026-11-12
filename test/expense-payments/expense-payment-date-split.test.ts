// ════════════════════════════════════════════════════════════════════════════
// Owner 12.11.2026 — Ausgaben bezahlen: Zahlungstag wählbar, mehrere Zahlwege in einer Handlung (Haus, PC2, Banking)
// Harness aus partner-ownership.test.ts.
// Run: node test/expense-payments/expense-payment-date-split.test.ts
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

// ════════════════════════════════════════════════════════════════════════════
// Owner 12.11.2026 — „Record Expense Payment":
//   • der Zahlungstag ist wählbar (ohne Angabe heute); nicht in der Zukunft, nicht vor dem Tag der Ausgabe;
//   • eine Zahlung kann auf mehrere Zahlwege geteilt werden (z. B. 300 Cash + 200 Bank), jeder mit eigenem Tag —
//     in EINER Handlung: alles oder nichts.
// Hauptbuch (occurred_at), Zahlungszeilen (paid_at) und Banking (eine Zeile je Zahlung, Konto = Zahlweg) folgen dem Tag.
// ════════════════════════════════════════════════════════════════════════════
const payables = await import('../../src/core/payables/payables-house.ts');
const pcmds = await import('../../src/core/bridge/payables-commands.ts');
const repairs = await import('../../src/core/repairs/repair-house.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const DB = freshDb();
const HEUTE = NOW.slice(0, 10); // 2026-09-26
type Row = { amount: number; method: string; paidAt?: string };
const ausgabe = (amount: number, expenseDate: string, category = 'Rent', supplierId?: string): string =>
  imHaus(() => payables.createExpenseInHouse({ category, amount, paymentMethod: 'bank', expenseDate, initialPaid: 0,
    ...(supplierId ? { supplierId } : {}) } as never, CTX)).expenseId;
const zahl = (ex: string, amount: number, method: string, paidAt?: string) =>
  imHaus(() => payables.recordExpensePaymentInHouse(ex, amount, method, CTX, paidAt ? { paidAt } : {}));
const teil = (ex: string, rows: Row[], expectedRevision?: number) =>
  imHaus(() => payables.recordExpensePaymentsInHouse(ex, rows, CTX, expectedRevision === undefined ? {} : { expectedRevision }));
const fehler = (fn: () => unknown): string => {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)); }
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const nichts = () => S({
  le: n(DB, 'SELECT COUNT(*) FROM ledger_entries'), ep: n(DB, 'SELECT COUNT(*) FROM expense_payments'),
  ex: DB.exec('SELECT id, paid_amount, status, payment_method FROM expenses ORDER BY id')[0]?.values ?? [],
});
const zahlungen = (ex: string): Array<[number, string, string]> =>
  (DB.exec('SELECT amount, method, paid_at FROM expense_payments WHERE expense_id = ? ORDER BY paid_at, amount', [ex])[0]?.values ?? [])
    .map((v) => [Number(v[0]), String(v[1]), String(v[2])]);
const buchung = (ex: string): Array<[string, string, number, string]> =>
  (DB.exec(`SELECT le.account, le.direction, le.amount, le.occurred_at FROM ledger_entries le
              JOIN expense_payments ep ON ep.id = le.source_id
             WHERE le.source_module = 'EXPENSE_PAYMENT' AND ep.expense_id = ? ORDER BY le.occurred_at, le.account`, [ex])[0]?.values ?? [])
    .map((v) => [String(v[0]), String(v[1]), Number(v[2]), String(v[3]).slice(0, 10)]);
const geld = (ex: string): string[] => buchung(ex).filter((b) => b[0] !== 'ACCOUNTS_PAYABLE').map((b) => `${b[0]} ${b[1]} ${b[2]} ${b[3]}`);
const BT = () => bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, []) as
  Array<{ id: string; date: string; account: string; amount: number; type: string; relatedEntityId?: string }>;
const bank = (ex: string): string[] => BT().filter((t) => t.type === 'EXPENSE_OUT' && t.relatedEntityId === ex)
  .map((t) => `${t.account} ${t.amount} ${String(t.date).slice(0, 10)}`).sort();
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const abgleich = (tag: string) => {
  const rows = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows;
  const diff = (acc: string) => { const r = rows.find((x) => x.account === acc); return r ? Math.abs(Number(r.ledger) - Number(r.domain)) : 0; };
  ok(ausgeglichen() && diff('ACCOUNTS_PAYABLE') < 0.0015 && diff('SUPPLIER_CREDIT') < 0.0015,
    `${tag} Abgleich: Hauptbuch ausgeglichen, A/P und Lieferantenguthaben = Domäne (AP ${diff('ACCOUNTS_PAYABLE')})`);
};
const ausg = (ex: string) => S(DB.exec('SELECT paid_amount, status FROM expenses WHERE id = ?', [ex])[0].values[0]);

// ── E1 ohne Angabe: heute ───────────────────────────────────────────────────────
{
  const ex = ausgabe(100, '2026-09-10');
  const r = zahl(ex, 100, 'cash');
  ok(r.status === 'PAID' && S(zahlungen(ex)) === S([[100, 'cash', HEUTE]]), `E1 ohne Tag: Zahlung heute (${S(zahlungen(ex))})`);
  ok(S(geld(ex)) === S([`CASH CREDIT 100 ${HEUTE}`]), `E1 Hauptbuch heute (${S(geld(ex))})`);
  ok(S(bank(ex)) === S([`cash 100 ${HEUTE}`]), `E1 Banking: Cash heute (${S(bank(ex))})`);
}

// ── E2 gewählter Tag in der Vergangenheit (≥ Ausgabetag) ───────────────────────
{
  const ex = ausgabe(200, '2026-09-10');
  zahl(ex, 200, 'bank', '2026-09-15');
  ok(S(zahlungen(ex)) === S([[200, 'bank', '2026-09-15']]), `E2 paid_at = gewählter Tag (${S(zahlungen(ex))})`);
  ok(S(buchung(ex)) === S([['ACCOUNTS_PAYABLE', 'DEBIT', 200, '2026-09-15'], ['BANK', 'CREDIT', 200, '2026-09-15']]),
    `E2 Hauptbuch am gewählten Tag: Soll A/P, Haben BANK (${S(buchung(ex))})`);
  ok(S(bank(ex)) === S(['bank 200 2026-09-15']), `E2 Banking zeigt den Zahlungstag, nicht den Ausgabetag (${S(bank(ex))})`);
  const gleich = ausgabe(50, '2026-09-10');
  zahl(gleich, 50, 'benefit', '2026-09-10');
  ok(S(zahlungen(gleich)) === S([[50, 'benefit', '2026-09-10']]), 'E2 Zahlung am Tag der Ausgabe selbst: erlaubt');
}

// ── E3–E5 abgewiesen, nichts geschrieben ────────────────────────────────────────
{
  const ex = ausgabe(100, '2026-09-10');
  const v = nichts();
  ok(fehler(() => zahl(ex, 100, 'cash', '2026-09-28')) === 'PAYMENT_DATE_INVALID' && nichts() === v, 'E3 Tag in der Zukunft: PAYMENT_DATE_INVALID, nichts geschrieben');
  ok(fehler(() => zahl(ex, 100, 'cash', '2026-09-09')) === 'PAYMENT_DATE_BEFORE_EXPENSE' && nichts() === v, 'E4 vor dem Ausgabetag: PAYMENT_DATE_BEFORE_EXPENSE, nichts geschrieben');
  ok(fehler(() => zahl(ex, 100, 'cash', '2026-02-30')) === 'PAYMENT_DATE_INVALID' && nichts() === v, 'E5 kein echter Tag (30.02.): PAYMENT_DATE_INVALID');
  ok(fehler(() => zahl(ex, 100, 'cash', '15.09.2026')) === 'PAYMENT_DATE_INVALID' && nichts() === v, 'E5 falsches Format: PAYMENT_DATE_INVALID');
  ok(fehler(() => zahl(ex, 100, 'cash', '2026-09-15T08:00:00.000Z')) === 'PAYMENT_DATE_INVALID' && nichts() === v, 'E5 Zeitstempel statt Tag: PAYMENT_DATE_INVALID');
}

// ── E6 geteilt: 300 Cash am 12. + 200 Bank am 20. → zwei Zahlungen, bezahlt ────
{
  const ex = ausgabe(500, '2026-09-10');
  const r = teil(ex, [{ amount: 300, method: 'cash', paidAt: '2026-09-12' }, { amount: 200, method: 'bank', paidAt: '2026-09-20' }]);
  ok(r.payments.length === 2 && r.status === 'PAID' && r.paidAmount === 500 && r.remainingAmount === 0,
    `E6 eine Handlung, zwei Zahlungen, bezahlt (${S({ n: r.payments.length, st: r.status, p: r.paidAmount, rest: r.remainingAmount })})`);
  ok(S(zahlungen(ex)) === S([[300, 'cash', '2026-09-12'], [200, 'bank', '2026-09-20']]), `E6 Zahlungszeilen je Zahlweg und Tag (${S(zahlungen(ex))})`);
  ok(S(geld(ex)) === S(['CASH CREDIT 300 2026-09-12', 'BANK CREDIT 200 2026-09-20']), `E6 Hauptbuch: Cash 300 am 12., Bank 200 am 20. (${S(geld(ex))})`);
  ok(S(bank(ex)) === S(['bank 200 2026-09-20', 'cash 300 2026-09-12']), `E6 Banking: zwei Zeilen, je Konto und Tag (${S(bank(ex))})`);
  // teilweise geteilt, später der Rest
  const ex2 = ausgabe(1000, '2026-09-01');
  const t = teil(ex2, [{ amount: 300, method: 'cash' }, { amount: 200, method: 'benefit', paidAt: '2026-09-05' }]);
  ok(t.status !== 'PAID' && t.remainingAmount === 500 && t.paidAmount === 500, `E6 Teilbetrag geteilt: Rest 500 offen (${t.status})`);
  zahl(ex2, 500, 'bank', '2026-09-25');
  ok(ausg(ex2) === S([1000, 'PAID']) && S(bank(ex2)) === S(['bank 500 2026-09-25', 'benefit 200 2026-09-05', `cash 300 ${HEUTE}`]),
    `E6 Rest später per Bank: bezahlt, Banking drei Zeilen (${S(bank(ex2))})`);
  abgleich('E6');
}

// ── E7–E9 geteilt abgewiesen: alles oder nichts ─────────────────────────────────
{
  const ex = ausgabe(500, '2026-09-10');
  const v = nichts();
  ok(fehler(() => teil(ex, [{ amount: 300, method: 'cash' }, { amount: 250, method: 'bank' }])) === 'EXPENSE_OVERPAYMENT' && nichts() === v,
    'E7 Summe über dem offenen Betrag: EXPENSE_OVERPAYMENT, nichts geschrieben');
  ok(fehler(() => teil(ex, [{ amount: 300, method: 'cash' }, { amount: 100, method: 'bank', paidAt: '2026-09-28' }])) === 'PAYMENT_DATE_INVALID' && nichts() === v,
    'E8 zweite Zeile mit künftigem Tag: abgewiesen, auch die erste NICHT gebucht');
  ok(fehler(() => teil(ex, [{ amount: 300, method: 'cash' }, { amount: 100, method: 'bank', paidAt: '2026-09-01' }])) === 'PAYMENT_DATE_BEFORE_EXPENSE' && nichts() === v,
    'E8 zweite Zeile vor dem Ausgabetag: abgewiesen, nichts gebucht');
  ok(fehler(() => teil(ex, [{ amount: 300, method: 'cash' }, { amount: 0, method: 'bank' }])) === 'PAYMENT_AMOUNT_INVALID' && nichts() === v,
    'E8 Betrag 0: PAYMENT_AMOUNT_INVALID');
  ok(fehler(() => teil(ex, [{ amount: 300, method: 'cash' }, { amount: 100, method: 'card' }])) === 'PAYMENT_METHOD_INVALID' && nichts() === v,
    'E8 unbekannter Zahlweg: PAYMENT_METHOD_INVALID');
  ok(fehler(() => teil(ex, [{ amount: 300, method: 'cash' }, { amount: 100, method: 'partner' }])) === 'PAYMENT_METHOD_INVALID' && nichts() === v,
    'E9 Partner-Direktzahlung wird nicht geteilt: PAYMENT_METHOD_INVALID');
  ok(fehler(() => teil(ex, [{ amount: 300, method: 'cash' }, { amount: 100, method: 'credit' }])) === 'PAYMENT_METHOD_INVALID' && nichts() === v,
    'E9 Guthaben ist kein Zahlweg hier: PAYMENT_METHOD_INVALID');
  ok(fehler(() => teil(ex, [])) === 'PAYMENT_ROWS_REQUIRED' && nichts() === v, 'E9 keine Zeile: PAYMENT_ROWS_REQUIRED');
  ok(fehler(() => teil(ex, Array.from({ length: 6 }, () => ({ amount: 10, method: 'cash' })))) === 'PAYMENT_ROWS_TOO_MANY' && nichts() === v,
    'E9 sechs Zeilen: PAYMENT_ROWS_TOO_MANY (höchstens 5)');
  const rev = n(DB, 'SELECT revision FROM expenses WHERE id = ?', [ex]);
  ok(fehler(() => teil(ex, [{ amount: 100, method: 'cash' }], rev + 7)) === 'RECORD_CHANGED' && nichts() === v, 'E9 veralteter Stand: RECORD_CHANGED');
  const fertig = ausgabe(100, '2026-09-10');
  zahl(fertig, 100, 'cash');
  const v2 = nichts();
  ok(fehler(() => teil(fertig, [{ amount: 10, method: 'cash' }])) === 'EXPENSE_OVERPAYMENT' && nichts() === v2, 'E9 schon bezahlt: abgewiesen');
}

// ── E10 Werkstattkosten einer Reparatur (Lieferant) mit Tag und geteilt ───────────
{
  const kaufId = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE('pw1', 1000)], 1000))).id;
  const lot = lotOf(DB, lineOf(DB, kaufId, 'pw1'));
  const rid = (await repairs.createRepairOnPrimary({ repairScope: 'OWN', productId: 'pw1', lotId: lot, issueDescription: 'Service',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 150 } as never)).id;
  await repairs.updateRepairStatusOnPrimary(rid, 'in_progress' as never);
  const ex = s(DB, 'SELECT expense_id FROM repair_lines WHERE repair_id = ? AND expense_id IS NOT NULL LIMIT 1', [rid]);
  ok(!!ex && s(DB, 'SELECT supplier_id FROM expenses WHERE id = ?', [ex]) === 'sup-1', `E10 Reparatur hat eine Werkstatt-Ausgabe beim Lieferanten (${ex})`);
  // Die Reparatur wurde vor einer Woche erfasst (die Werkstatt wird erst jetzt bezahlt).
  DB.run("UPDATE expenses SET expense_date = '2026-09-18' WHERE id = ?", [ex]);
  const v = nichts();
  ok(fehler(() => teil(ex, [{ amount: 100, method: 'cash', paidAt: '2026-09-17' }, { amount: 50, method: 'bank' }])) === 'PAYMENT_DATE_BEFORE_EXPENSE' && nichts() === v,
    'E10 Tag vor der Reparaturkost: abgewiesen');
  teil(ex, [{ amount: 100, method: 'cash', paidAt: '2026-09-20' }, { amount: 50, method: 'bank', paidAt: '2026-09-22' }]);
  ok(ausg(ex) === S([150, 'PAID']) && S(geld(ex)) === S(['CASH CREDIT 100 2026-09-20', 'BANK CREDIT 50 2026-09-22']),
    `E10 Werkstatt bezahlt: Cash 100 am 20., Bank 50 am 22. (${S(geld(ex))})`);
  const ap = buchung(ex).filter((b) => b[0] === 'ACCOUNTS_PAYABLE');
  ok(ap.length === 2 && r3(ap.reduce((a, b) => a + b[2], 0)) === 150, 'E10 A/P beim Lieferanten um 150 entlastet');
  ok(n(DB, "SELECT COUNT(*) FROM ledger_entries le JOIN expense_payments ep ON ep.id = le.source_id WHERE le.source_module = 'EXPENSE_PAYMENT' AND ep.expense_id = ? AND le.counterparty_id = 'sup-1'", [ex]) === 4,
    'E10 alle Zahlungsbuchungen tragen den Lieferanten (Kontoauszug des Lieferanten)');
  abgleich('E10');
}

// ── E11 PC2: geteilte Zahlung über den Befehl, Wiederholung, strenger Rumpf ───────
{
  const ex = ausgabe(500, '2026-09-10', 'Utilities');
  const rev = n(DB, 'SELECT revision FROM expenses WHERE id = ?', [ex]);
  const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-0000000000e1`;
  const deps = () => ({ db: DB as never, begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
  const ident = (k: number) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op: 'expenses.record_payment', payloadHash: 'h' + k });
  const run = async (k: number, body: unknown): Promise<{ kind: string; code?: string; replayed?: boolean }> => {
    try { return await pcmds.runExpensePayment(deps() as never, ident(k) as never, body) as { kind: string; code?: string; replayed?: boolean }; }
    catch (e) { return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? '') }; }
  };
  const body = { expenseId: ex, expectedRevision: rev, payments: [{ amount: 300, method: 'cash', paidDate: '2026-09-12' }, { amount: 200, method: 'bank' }] };
  const x1 = await run(1, body);
  const x2 = await run(1, body);
  ok(x1.kind === 'ok' && x2.kind === 'ok' && x2.replayed === true && S(zahlungen(ex)) === S([[300, 'cash', '2026-09-12'], [200, 'bank', HEUTE]]),
    `E11 PC2 geteilt: genau einmal gebucht, ohne Tag = heute am Primary (${x1.kind}/${x2.kind}/${S(zahlungen(ex))})`);
  const ex2 = ausgabe(100, '2026-09-10');
  const rev2 = n(DB, 'SELECT revision FROM expenses WHERE id = ?', [ex2]);
  const v = nichts();
  const beide = await run(2, { expenseId: ex2, expectedRevision: rev2, amount: 100, method: 'cash', payments: [{ amount: 100, method: 'cash' }] });
  ok(beide.code === 'PAYABLES_PAYLOAD_INVALID' && nichts() === v, `E11 amount/method UND payments zugleich: abgewiesen (${S(beide)})`);
  const verboten = await run(3, { expenseId: ex2, expectedRevision: rev2, amount: 100, method: 'cash', paidAt: '2026-09-12' });
  ok(verboten.code === 'PAYABLES_PAYLOAD_INVALID' && nichts() === v, `E11 paidAt bestimmt der Client nicht (Feld heißt paidDate) (${S(verboten)})`);
  const fremd = await run(4, { expenseId: ex2, expectedRevision: rev2, payments: [{ amount: 100, method: 'cash', note: 'x' }] });
  ok(fremd.code === 'PAYABLES_PAYLOAD_INVALID' && nichts() === v, `E11 unbekanntes Feld in einer Zeile: abgewiesen (${S(fremd)})`);
  const sechs = await run(5, { expenseId: ex2, expectedRevision: rev2, payments: Array.from({ length: 6 }, () => ({ amount: 10, method: 'cash' })) });
  ok(sechs.code === 'PAYABLES_PAYLOAD_INVALID' && nichts() === v, `E11 sechs Zeilen: abgewiesen (${S(sechs)})`);
  const zukunftForm = await run(6, { expenseId: ex2, expectedRevision: rev2, amount: 100, method: 'cash', paidDate: '2099-01-01' });
  ok(zukunftForm.code === 'PAYABLES_PAYLOAD_INVALID' && nichts() === v, `E11 Tag weit in der Zukunft: schon der Rumpf abgewiesen (${S(zukunftForm)})`);
  const zukunftHaus = await run(7, { expenseId: ex2, expectedRevision: rev2, amount: 100, method: 'cash', paidDate: '2026-09-28' });
  ok(zukunftHaus.kind === 'rejected' && zukunftHaus.code === 'PAYMENT_DATE_INVALID' && nichts() === v,
    `E11 Tag nach dem Primary-Heute: PAYMENT_DATE_INVALID (${S(zukunftHaus)})`);
  const einzeln = await run(8, { expenseId: ex2, expectedRevision: rev2, amount: 100, method: 'bank', paidDate: '2026-09-15' });
  ok(einzeln.kind === 'ok' && S(zahlungen(ex2)) === S([[100, 'bank', '2026-09-15']]) && S(geld(ex2)) === S(['BANK CREDIT 100 2026-09-15']),
    `E11 PC2 eine Zahlung mit Tag: gebucht am gewählten Tag (${S(zahlungen(ex2))})`);
  abgleich('E11');
}

// ── E12 SALES ohne Zahlungsrecht ─────────────────────────────────────────────────
{
  const ex = ausgabe(100, '2026-09-10');
  const rev = n(DB, 'SELECT revision FROM expenses WHERE id = ?', [ex]);
  const v = nichts();
  const sales = await registry.executeCommand('expenses.record_payment',
    { input: { expenseId: ex, expectedRevision: rev, payments: [{ amount: 60, method: 'cash' }, { amount: 40, method: 'bank', paidDate: '2026-09-15' }] } },
    { commandId: '00000099-0000-4000-8000-0000000000e1', tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'SALES', payloadHash: 'h99' } as never) as { kind: string; code?: string };
  ok(sales.kind === 'business_error' && sales.code === 'PERMISSION_DENIED' && nichts() === v, `E12 SALES: PERMISSION_DENIED, nichts gebucht (${S(sales)})`);
}

// ── E13 Banking-Altbestand: Ausgabe ohne Zahlungszeile bleibt EINE Zeile am Ausgabetag ─
{
  const ex = ausgabe(80, '2026-09-03');
  DB.run("UPDATE expenses SET paid_amount = 80, status = 'PAID', payment_method = 'cash' WHERE id = ?", [ex]);
  ok(S(bank(ex)) === S(['cash 80 2026-09-03']), `E13 Altbestand ohne Zahlungszeile: eine Zeile wie bisher (${S(bank(ex))})`);
  DB.run('UPDATE expenses SET paid_amount = 0, status = \'UNPAID\' WHERE id = ?', [ex]);
}

console.log(`\nexpense-payment-date-split: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('EXPENSE_PAYMENT_DATE_SPLIT_PROVED');
