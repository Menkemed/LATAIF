// ════════════════════════════════════════════════════════════════════════════
// Owner 12.11.2026 — Ausgaben und „Pay Supplier" bezahlen: Zahlungstag wählbar (Bahrain-Tag, Periodenschutz), mehrere
// Zahlwege in einer Handlung (Haus, PC2, Banking, Lieferantensaldo).
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
// Dazu „Pay Supplier" (Sammelzahlung) mit Zahlungstag. Ein Zahlungstag ist ein Kalendertag in Bahrain (UTC+3): bis heute in
// Bahrain, nicht vor dem Beleg, nicht vor dem Eröffnungsstichtag, nicht in einem eingereichten/bezahlten VAT-Quartal.
// ════════════════════════════════════════════════════════════════════════════
const payables = await import('../../src/core/payables/payables-house.ts');
const pcmds = await import('../../src/core/bridge/payables-commands.ts');
const repairs = await import('../../src/core/repairs/repair-house.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const DB = freshDb();
const { setOpeningCutoffForTest } = await import('../../src/core/ledger/correction-dates.ts');
const pd = await import('../../src/core/utils/payment-date.ts');
// Die Szenarien spielen im September 2026 — VOR der Eröffnung (15.10.). Wie andere Regeltests: früherer Stichtag;
// E15 prüft mit der echten Owner-Konstante.
setOpeningCutoffForTest('2026-01-01');
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
  ok(fehler(() => zahl(ex, 100, 'cash', '2026-09-27')) === 'PAYMENT_DATE_INVALID' && nichts() === v, 'E3 morgen in Bahrain (13:00 Ortszeit): PAYMENT_DATE_INVALID — kein Tag Spielraum für Zahlungen');
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


// ── E14 Bahrain-Zeitzone: der Zahlungstag ist ein Kalendertag in Bahrain (UTC+3), ohne Spielraum nach vorn ────────
{
  const t = Date.parse('2026-11-12T22:30:00.000Z'); // 13.11. 01:30 in Bahrain
  ok(pd.bahrainTodayIso(t) === '2026-11-13' && pd.bahrainTodayIso(Date.parse('2026-11-12T20:59:00.000Z')) === '2026-11-12',
    'E14 Bahrain-Heute: 01:30 Ortszeit ist schon der 13., 23:59 Ortszeit noch der 12.');
  ok(pd.paymentDateIssue('2026-11-13', 'd', t) === null && /future/.test(pd.paymentDateIssue('2026-11-14', 'd', t) ?? ''), 'E14 Regel: heute in Bahrain ja, morgen nein');
  ok(/future/.test(pd.paymentDateIssue('2026-11-13', 'd', Date.parse('2026-11-12T10:00:00.000Z')) ?? ''), 'E14 Regel: tagsüber ist morgen Zukunft (kein Tag Spielraum)');
  ok(pd.paymentDateIssue('2026-02-30', 'd') !== null && pd.paymentDateIssue('12.11.2026', 'd') !== null && pd.paymentDateIssue(undefined, 'd') === null,
    'E14 Regel: kein echter Tag / falsches Format abgewiesen, leer = heute');
  const NACHT = { ...CTX, now: '2026-09-26T22:30:00.000Z' }; // 27.09. 01:30 in Bahrain
  const ex = ausgabe(100, '2026-09-10');
  const v = nichts();
  ok(fehler(() => imHaus(() => payables.recordExpensePaymentInHouse(ex, 50, 'cash', NACHT, { paidAt: '2026-09-28' }))) === 'PAYMENT_DATE_INVALID' && nichts() === v,
    'E14 nachts: der morgige Tag in Bahrain wird abgewiesen');
  imHaus(() => payables.recordExpensePaymentInHouse(ex, 50, 'cash', NACHT, { paidAt: '2026-09-27' }));
  imHaus(() => payables.recordExpensePaymentInHouse(ex, 50, 'bank', NACHT));
  ok(S(zahlungen(ex)) === S([[50, 'bank', '2026-09-26'], [50, 'cash', '2026-09-27']]),
    `E14 nachts: Bahrain-Heute (27.) gewählt = so gebucht; ohne Tag wie bisher der Standardtag des Primary (${S(zahlungen(ex))})`);
}

// ── E15 Periodenschutz: Eröffnungsstichtag (echte Owner-Konstante) und eingereichtes VAT-Quartal ─────────────────
{
  const ex = ausgabe(300, '2026-09-10');
  const ohne = ausgabe(10, '2026-09-10');
  const v = nichts();
  setOpeningCutoffForTest(null);
  const c1 = fehler(() => zahl(ex, 100, 'cash', '2026-09-15'));
  ok(c1 === 'PAYMENT_DATE_BEFORE_OPENING' && nichts() === v, `E15 gewählter Tag vor dem Eröffnungsstichtag: abgewiesen (${c1})`);
  const c1b = fehler(() => teil(ex, [{ amount: 100, method: 'cash' }, { amount: 100, method: 'bank', paidAt: '2026-09-15' }]));
  ok(c1b === 'PAYMENT_DATE_BEFORE_OPENING' && nichts() === v, `E15 auch als Zeile einer geteilten Zahlung — nichts gebucht (${c1b})`);
  zahl(ohne, 10, 'cash');
  ok(ausg(ohne) === S([10, 'PAID']), 'E15 ohne gewählten Tag (heute) bleibt alles wie bisher');
  setOpeningCutoffForTest('2026-01-01');
  DB.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('vf-q3', 'branch-main', 2026, 3, ?, '{}', ?)", [NOW, NOW]);
  const v2 = nichts();
  const c2 = fehler(() => zahl(ex, 100, 'cash', '2026-09-15'));
  ok(c2 === 'VAT_PERIOD_FILED' && nichts() === v2, `E15 gewählter Tag in einem eingereichten VAT-Quartal (Q3/2026): abgewiesen (${c2})`);
  DB.run("DELETE FROM vat_filings WHERE id = 'vf-q3'");
  zahl(ex, 300, 'cash', '2026-09-15');
  ok(ausg(ex) === S([300, 'PAID']), 'E15 Quartal wieder offen: derselbe Tag geht');
}

// ── E16 „Pay Supplier" im Haus: ein Tag für alle Teilzahlungen; nie vor einem getroffenen Beleg ─────────────────────
const lieferant = (id: string) => DB.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?, 'branch-main', ?, 1, ?, ?)",
  [id, 'Lieferant ' + id, NOW, NOW]);
const stempel = (sup: string): string => payables.supplierOpenStamp(payables.openSupplierItems(sup, 'branch-main'));
const pay = (sup: string, amount: number, method: string, extra: Record<string, unknown> = {}) =>
  imHaus(() => payables.paySupplierInHouse({ supplierId: sup, amount, method, mode: 'fifo', expectedOpenStamp: stempel(sup), ...extra } as never, CTX));
const meldung = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as Error).message); } };
const apLief = (sup: string): number => r3(n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND counterparty_id = ?", [sup]));
const kaufZahlungen = (pid: string): Array<[number, string, string]> =>
  (DB.exec('SELECT amount, method, paid_at FROM purchase_payments WHERE purchase_id = ? ORDER BY paid_at, amount', [pid])[0]?.values ?? [])
    .map((v) => [Number(v[0]), String(v[1]), String(v[2]).slice(0, 10)]);
const kaufGeld = (pid: string): string[] => (DB.exec(`SELECT le.account, le.amount, le.occurred_at FROM ledger_entries le JOIN purchase_payments pp ON pp.id = le.source_id
   WHERE le.source_module = 'PURCHASE_PAYMENT' AND pp.purchase_id = ? AND le.account != 'ACCOUNTS_PAYABLE' ORDER BY le.occurred_at, le.amount`, [pid])[0]?.values ?? [])
  .map((v) => `${v[0]} ${Number(v[1])} ${String(v[2]).slice(0, 10)}`);
const nichts2 = () => nichts() + S([n(DB, 'SELECT COUNT(*) FROM purchase_payments'), n(DB, 'SELECT COUNT(*) FROM supplier_credits')]);
{
  lieferant('sup-2');
  const exA = ausgabe(100, '2026-09-05', 'Rent', 'sup-2');
  const kauf = (await purchaseHouse.createPurchaseOnPrimary({ ...EINKAUF([ZEILE('pw2', 200)], 0), supplierId: 'sup-2', purchaseDate: '2026-09-08' })).id;
  const kaufNr = s(DB, 'SELECT purchase_number FROM purchases WHERE id = ?', [kauf]);
  const ap0 = apLief('sup-2');
  const v = nichts2();
  const m1 = meldung(() => pay('sup-2', 300, 'bank', { paidAt: '2026-09-07' }));
  ok(fehler(() => pay('sup-2', 300, 'bank', { paidAt: '2026-09-07' })) === 'PAYMENT_DATE_BEFORE_PURCHASE' && m1.includes(kaufNr) && nichts2() === v,
    `E16 Tag vor dem getroffenen Einkauf: abgewiesen mit Belegnummer, nichts gebucht (${m1.slice(0, 110)})`);
  ok(fehler(() => pay('sup-2', 50, 'bank', { paidAt: '2026-09-04' })) === 'PAYMENT_DATE_BEFORE_EXPENSE' && nichts2() === v,
    'E16 Tag vor der getroffenen Ausgabe: abgewiesen, nichts gebucht');
  ok(fehler(() => pay('sup-2', 300, 'bank', { paidAt: '2026-09-27' })) === 'PAYMENT_DATE_INVALID' && nichts2() === v, 'E16 morgen in Bahrain: abgewiesen');
  ok(fehler(() => pay('sup-2', 300, 'bank', { paidAt: '2026-9-10' })) === 'PAYMENT_DATE_INVALID' && nichts2() === v, 'E16 falsches Format: abgewiesen');
  setOpeningCutoffForTest(null);
  ok(fehler(() => pay('sup-2', 300, 'bank', { paidAt: '2026-09-10' })) === 'PAYMENT_DATE_BEFORE_OPENING' && nichts2() === v, 'E16 vor dem Eröffnungsstichtag: abgewiesen');
  setOpeningCutoffForTest('2026-01-01');
  DB.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('vf-q3b', 'branch-main', 2026, 3, ?, '{}', ?)", [NOW, NOW]);
  ok(fehler(() => pay('sup-2', 300, 'bank', { paidAt: '2026-09-10' })) === 'VAT_PERIOD_FILED' && nichts2() === v, 'E16 im eingereichten VAT-Quartal: abgewiesen');
  DB.run("DELETE FROM vat_filings WHERE id = 'vf-q3b'");
  // FIFO 50 trifft nur die Ausgabe (05.09.) — der 06.09. liegt vor dem Einkauf (08.09.), der hier aber nicht bezahlt wird.
  pay('sup-2', 50, 'cash', { paidAt: '2026-09-06' });
  pay('sup-2', 250, 'bank', { paidAt: '2026-09-10' });
  ok(S(zahlungen(exA)) === S([[50, 'cash', '2026-09-06'], [50, 'bank', '2026-09-10']]) && S(kaufZahlungen(kauf)) === S([[200, 'bank', '2026-09-10']]),
    `E16 Zahlungshistorie: Ausgabe 50 Cash am 06.09. + 50 Bank am 10.09., Einkauf 200 Bank am 10.09. (${S(zahlungen(exA))} ${S(kaufZahlungen(kauf))})`);
  ok(S(geld(exA)) === S(['CASH CREDIT 50 2026-09-06', 'BANK CREDIT 50 2026-09-10']) && S(kaufGeld(kauf)) === S(['BANK 200 2026-09-10']),
    `E16 Hauptbuch am gewählten Tag (${S(geld(exA))} ${S(kaufGeld(kauf))})`);
  ok(ap0 === 300 && apLief('sup-2') === 0, `E16 Lieferantensaldo (A/P) 300 → 0 (${ap0} → ${apLief('sup-2')})`);
  const bk = BT().filter((t) => t.relatedEntityId === exA || t.relatedEntityId === kauf).map((t) => `${t.type} ${t.account} ${t.amount} ${String(t.date).slice(0, 10)}`).sort();
  ok(S(bk) === S(['EXPENSE_OUT bank 50 2026-09-10', 'EXPENSE_OUT cash 50 2026-09-06', 'PURCHASE_OUT bank 200 2026-09-10']), `E16 Banking am Zahlungstag (${S(bk)})`);
  abgleich('E16');
}

// ── E17 Überschuss mit Tag: Vorauszahlungs-Guthaben bzw. Überzahlung des Einkaufs am gewählten Tag ─────────────────────
{
  lieferant('sup-3');
  const ex = ausgabe(100, '2026-09-05', 'Rent', 'sup-3');
  const r = pay('sup-3', 150, 'cash', { paidAt: '2026-09-12', confirmExcessAsCredit: true });
  const pre = (DB.exec("SELECT account, direction, amount, substr(occurred_at, 1, 10) FROM ledger_entries WHERE source_module = 'SUPPLIER_PREPAYMENT' AND source_id = ? ORDER BY account", [r.excessRef])[0]?.values ?? [])
    .map((x) => x.join(' '));
  ok(r.excessTo === 'standalone_credit' && S(zahlungen(ex)) === S([[100, 'cash', '2026-09-12']]) && S(pre) === S(['CASH CREDIT 50 2026-09-12', 'SUPPLIER_CREDIT DEBIT 50 2026-09-12']),
    `E17 Vorauszahlung 50 am gewählten Tag (${S(pre)})`);
  lieferant('sup-4');
  const k = (await purchaseHouse.createPurchaseOnPrimary({ ...EINKAUF([ZEILE('pw3', 200)], 0), supplierId: 'sup-4', purchaseDate: '2026-09-08' })).id;
  const r2 = pay('sup-4', 250, 'bank', { paidAt: '2026-09-14', confirmExcessAsCredit: true });
  ok(r2.excessTo === 'purchase_overpay' && S(kaufZahlungen(k)) === S([[50, 'bank', '2026-09-14'], [200, 'bank', '2026-09-14']]) && S(kaufGeld(k)) === S(['BANK 50 2026-09-14', 'BANK 200 2026-09-14']),
    `E17 Überzahlung des Einkaufs am gewählten Tag (${S(kaufZahlungen(k))})`);
  abgleich('E17');
}

// ── E18 alter Auftrag ohne Tag: wie bisher heute ─────────────────────────────────────────────────────────────────────
{
  lieferant('sup-5');
  const ex = ausgabe(70, '2026-09-05', 'Rent', 'sup-5');
  pay('sup-5', 70, 'benefit');
  ok(S(zahlungen(ex)) === S([[70, 'benefit', HEUTE]]) && S(geld(ex)) === S([`BENEFIT CREDIT 70 ${HEUTE}`]), 'E18 Pay Supplier ohne Tag: heute, wie bisher');
}

// ── E19 PC2 „suppliers.pay": paidDate, Wiederholung, alter Rumpf, strenger Rumpf ───────────────────────────────────
{
  lieferant('sup-6');
  const ex = ausgabe(100, '2026-09-05', 'Rent', 'sup-6');
  const ex2 = ausgabe(80, '2026-09-06', 'Rent', 'sup-6');
  const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-0000000000f1`;
  const deps = () => ({ db: DB as never, begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
  const ident = (k: number) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op: 'suppliers.pay', payloadHash: 'h' + k });
  const run = async (k: number, body: unknown): Promise<{ kind: string; code?: string; replayed?: boolean }> => {
    try { return await pcmds.runSupplierPay(deps() as never, ident(k) as never, body) as { kind: string; code?: string; replayed?: boolean }; }
    catch (e) { return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? '') }; }
  };
  const kopf = () => ({ supplierId: 'sup-6', mode: 'fifo', expectedOpenStamp: stempel('sup-6') });
  const v = nichts2();
  const a = await run(1, { ...kopf(), amount: 100, method: 'cash', paidAt: '2026-09-11' });
  ok(a.code === 'PAYABLES_PAYLOAD_INVALID' && nichts2() === v, `E19 paidAt bestimmt der Client nicht (Feld heißt paidDate) (${S(a)})`);
  const b = await run(2, { ...kopf(), amount: 100, method: 'cash', paidDate: '2099-01-01' });
  ok(b.code === 'PAYABLES_PAYLOAD_INVALID' && nichts2() === v, `E19 Tag weit in der Zukunft: schon der Rumpf abgewiesen (${S(b)})`);
  const c = await run(3, { ...kopf(), amount: 100, method: 'cash', paidDate: '2026-09-27' });
  ok(c.kind === 'rejected' && c.code === 'PAYMENT_DATE_INVALID' && nichts2() === v, `E19 morgen in Bahrain (Uhr des Primary): abgewiesen (${S(c)})`);
  const body = { ...kopf(), amount: 100, method: 'cash', paidDate: '2026-09-11' };
  const x1 = await run(4, body);
  const x2 = await run(4, body);
  ok(x1.kind === 'ok' && x2.kind === 'ok' && x2.replayed === true && S(zahlungen(ex)) === S([[100, 'cash', '2026-09-11']]) && S(geld(ex)) === S(['CASH CREDIT 100 2026-09-11']),
    `E19 PC2 mit paidDate: genau einmal, am gewählten Tag (${x1.kind}/${x2.kind}/${S(zahlungen(ex))})`);
  const alt = await run(5, { ...kopf(), amount: 80, method: 'bank' });
  ok(alt.kind === 'ok' && S(zahlungen(ex2)) === S([[80, 'bank', HEUTE]]), `E19 alter Rumpf ohne paidDate: angenommen, heute gebucht (${S(zahlungen(ex2))})`);
  abgleich('E19');
}

// ── E20 SALES ohne Zahlungsrecht ───────────────────────────────────────────────────────────────────────────────────
{
  lieferant('sup-7');
  ausgabe(40, '2026-09-05', 'Rent', 'sup-7');
  const v = nichts2();
  const sales = await registry.executeCommand('suppliers.pay',
    { input: { supplierId: 'sup-7', amount: 40, method: 'cash', mode: 'fifo', expectedOpenStamp: stempel('sup-7'), paidDate: '2026-09-15' } },
    { commandId: '00000098-0000-4000-8000-0000000000f1', tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'SALES', payloadHash: 'h98' } as never) as { kind: string; code?: string };
  ok(sales.kind === 'business_error' && sales.code === 'PERMISSION_DENIED' && nichts2() === v, `E20 SALES: PERMISSION_DENIED, nichts gebucht (${S(sales)})`);
}

// ── E21 Banking bei Überzahlung: 500 bezahlt, 400 offen → 100 Vorauszahlung; jeder echte Geldabgang genau einmal ─────
{
  lieferant('sup-8');
  const ex1 = ausgabe(250, '2026-09-05', 'Rent', 'sup-8');
  const ex2 = ausgabe(150, '2026-09-06', 'Rent', 'sup-8');
  const r = pay('sup-8', 500, 'cash', { paidAt: '2026-09-12', confirmExcessAsCredit: true });
  const hbGeld = (dir: string): number => r3(n(DB, "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE account IN ('CASH','BANK','BENEFIT') AND counterparty_id = 'sup-8' AND direction = ?", [dir]));
  type Bt = { id: string; date: string; account: string; amount: number; type: string; flow: string; relatedEntityId?: string };
  const zum = (): Bt[] => (BT() as unknown as Bt[]).filter((t) => t.relatedEntityId === ex1 || t.relatedEntityId === ex2 || t.relatedEntityId === 'sup-8');
  const summe = (flow: string): number => r3(zum().filter((t) => t.flow === flow).reduce((a, t) => a + Number(t.amount), 0));
  ok(r.excessTo === 'standalone_credit' && r.excessAmount === 100 && hbGeld('CREDIT') === 500, `E21 Hauptbuch: 500 Cash-Abgang (400 Schuld + 100 Vorauszahlung) (${hbGeld('CREDIT')})`);
  ok(summe('out') === 500, `E21 Banking zeigt den VOLLEN Geldabgang 500 (${summe('out')}: ${S(zum().map((t) => `${t.type} ${t.account} ${t.amount} ${String(t.date).slice(0, 10)}`))})`);
  const pre = zum().filter((t) => t.relatedEntityId === 'sup-8');
  ok(pre.length === 1 && pre[0].amount === 100 && pre[0].account === 'cash' && String(pre[0].date).slice(0, 10) === '2026-09-12' && pre[0].flow === 'out',
    `E21 die Vorauszahlung 100 als eigene Zeile am Zahlungstag, Konto Cash (${S(pre)})`);
  imHaus(() => payables.refundStandaloneCreditInHouse(String(r.excessRef), CTX));
  ok(hbGeld('DEBIT') === 100 && summe('in') === 100 && summe('out') === 500,
    `E21 „Refund Credit": 100 kommen zurück — Banking zeigt den Eingang, der Abgang bleibt (in ${summe('in')}, out ${summe('out')})`);
  ok(summe('out') - summe('in') === hbGeld('CREDIT') - hbGeld('DEBIT'), 'E21 Banking-Liste = Hauptbuch (netto 400), keine doppelte Geldbewegung');
  // Überschuss auf einem Einkauf (E17, sup-4): die Überzahlung ist eine Einkaufszahlung — genau einmal, nicht zusätzlich als Vorauszahlung.
  const k4 = s(DB, "SELECT id FROM purchases WHERE supplier_id = 'sup-4'");
  const out4 = (BT() as unknown as Bt[]).filter((t) => t.flow === 'out' && (t.relatedEntityId === k4 || t.relatedEntityId === 'sup-4'));
  ok(r3(out4.reduce((a, t) => a + Number(t.amount), 0)) === 250 && out4.every((t) => t.type === 'PURCHASE_OUT'),
    `E21 Überzahlung auf dem Einkauf: 250 genau einmal als Einkaufszahlungen (${S(out4.map((t) => `${t.type} ${t.amount}`))})`);
  abgleich('E21');
}

console.log(`\nexpense-payment-date-split: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('EXPENSE_PAYMENT_DATE_SPLIT_PROVED');
