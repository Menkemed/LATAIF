// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER — Owner-Regel „Edit Order After Invoice Conversion": Kosten, Gold, Goldquelle, Daten, Kunde und Name einer
// umgewandelten Order (FINAL, voll bezahlt) im offenen Quartal korrigieren. Testumgebung wie phase1-review.
// Run: node --experimental-strip-types test/custom-order/edit-after-invoice.test.ts
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })]]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

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
await import('../../src/core/bridge/read-commands.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useOrderPaymentStore } = await import('../../src/stores/orderPaymentStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { loadBankingFor } = await import('../../src/stores/bankingStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const orderHouse = await import('../../src/core/orders/order-house.ts');
const convertHouse = await import('../../src/core/orders/order-convert-house.ts');
const goldHouse = await import('../../src/core/gold/gold-house.ts');
const lifeHouse = await import('../../src/core/orders/order-lifecycle-house.ts');
const cancelHouse = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { orderCustomCostBasis } = await import('../../src/core/orders/order-invoice-lines.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-20T10:00:00.000Z';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function rows(db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, p)[0];
  if (!r) return [];
  return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])));
}

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();
function reload(): void {
  useProductStore.getState().loadProducts();
  useProductStore.getState().loadCategories();
  useCustomerStore.getState().loadCustomers();
  useOrderStore.getState().loadOrders();
  useInvoiceStore.getState().loadInvoices();
  useSupplierStore.getState().loadSuppliers();
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
  db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', ['branch-main', 'tenant-1', 'Haupt', NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-gold-jewelry','branch-main','Gold-Diamond Jewellery','g','#000',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, active, created_at, updated_at) VALUES ('cat-off','branch-main','Alt','g','#000',0,?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('c1','branch-main','Um','Khalid','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('sup-arup','branch-main','Arup Goldsmith',1,1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const ACTOR = { branchId: 'branch-main', userId: 'user-test' };
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (x: string, op: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW,
});
const orev = (db: Db, id: string): number => n(db, 'SELECT revision FROM orders WHERE id = ?', [id]);
interface Ausgang { ok: boolean; code: string; value?: Record<string, unknown> }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown> };
    return o.kind === 'ok' ? { ok: true, code: '', value: o.value } : { ok: false, code: o.code ?? '(ohne Code)' };
  } catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e) }; }
}
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); reload(); throw e; }
}
const codeOf = (e: unknown): string => String((e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e)));
function nein(fn: () => unknown): string { try { fn(); return 'KEIN NEIN'; } catch (e) { return codeOf(e); } }

/** Saldo eines Kontos (Soll − Haben), optional nur Einträge mit Quelle/Gegenpartei. */
const saldo = (db: Db, account: string, where = '1=1', p: unknown[] = []): number => r3(n(db,
  `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ? AND ${where}`, [account, ...p]));
/** Jede Buchung (transaction_id) ist für sich ausgeglichen, das ganze Buch auch. */
function buchAusgeglichen(db: Db): boolean {
  const off = rows(db, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d
    FROM ledger_entries GROUP BY transaction_id HAVING ABS(d) > 0.0005`);
  return off.length === 0;
}

type OI = import('../../src/core/orders/order-create.ts').OrderCreateInput;
const SPEC = { categoryId: 'cat-gold-jewelry', brand: '', name: 'Ring', sku: '', condition: 'New', taxScheme: 'ZERO', scopeOfDelivery: [], attributes: { karat: '21K', weight: 4.33, item_type: 'Ring' }, images: [] };
const ORD2: OI = {
  customerId: 'c1', orderType: 'custom', lines: [{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }],
  quotedPrice: 240, customTaxScheme: 'ZERO', finalProductDescription: 'Ring 21K', customProductSpec: SPEC as never,
  customerGoldGrams: 0, customerGoldKarat: '21K', customerStones: '1 Emerald', goldsmithSupplierId: 'sup-arup', laborCost: 25,
  extraGoldGrams: 4.33, extraGoldKarat: '21K', extraGoldCost: 185, extraGoldSupplierId: 'sup-arup', materials: [],
  depositAmount: 240, paymentMethod: 'card', cardBrand: 'normal', fullyPaid: false, expectedDelivery: '',
  orderDate: '2026-10-25', status: 'completed', notes: '',
};
function anlegen(input: OI): string {
  const id = imHaus(() => orderHouse.createOrderInHouse(input, 'branch-main').order.id);
  reload();
  return id;
}
function umwandeln(orderId: string, req: Partial<import('../../src/core/orders/order-convert-house.ts').OrderConvertRequest> = {}) {
  const out = imHaus(() => convertHouse.convertOrderToInvoiceInHouse({ orderId, invoiceDate: '2026-11-01', ...req }, 'branch-main'));
  reload();
  return out;
}

const goldSettle = await import('../../src/core/gold/order-gold-settle.ts');
const goldCore = await import('../../src/core/gold/gold-settle.ts');
const goldCmd = await import('../../src/core/bridge/gold-commands.ts');
const { useGoldStore } = await import('../../src/stores/goldStore.ts');
const { liveVatQuarters } = await import('../../src/core/tax/vat-quarter-overview.ts');

const payableOf = (db: Db, oid: string): string => String(one(db, 'SELECT id FROM gold_payables WHERE source_order_id = ?', [oid]));
const settle = (pid: string, grams: number, ratePerGram: number, settledOn?: string) =>
  imHaus(() => goldSettle.settleOrderGoldInBhd(ACTOR, { payableId: pid, grams, ratePerGram, ...(settledOn ? { settledOn } : {}) }));
const goldLineCost = (db: Db, oid: string): number => r3(n(db, "SELECT cost_amount FROM order_lines WHERE order_id = ? AND material_kind = 'gold'", [oid]));

const fern2 = fern;

const { setOpeningCutoffForTest } = await import('../../src/core/ledger/correction-dates.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const { productOriginOf } = await import('../../src/core/data/page-reads.ts');
const { loadInvoicesFor } = await import('../../src/stores/invoiceStore.ts');
const { invoiceCostCorrectionSql } = await import('../../src/core/purchases/cost-correction-read.ts');
const { vatFingerprint } = await import('../../src/core/tax/vat-period-lock.ts');
const { buildOrderInvoiceLines } = await import('../../src/core/orders/order-invoice-lines.ts');
const { paymentMethodLabel } = await import('../../src/core/utils/payment-method-label.ts');
const PC2_ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const customLineOf = (db: Db, oid: string): string => String(one(db, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'custom'", [oid]));
const cancelInv = (invoiceId: string) => { imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId, refundMethod: 'cash' } as never, 'branch-main')); reload(); };

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Owner-Regel „Edit Order After Invoice Conversion": eine umgewandelte Custom Order bleibt über die Order korrigierbar,
// solange das VAT-Quartal offen ist — auch FINAL und voll bezahlt. Kosten (Lohn, Gold, Karat, Goldquelle, Goldschuld)
// folgen in derselben Klammer an die Rechnung; der Kunde zieht mit Order, Anzahlungen und Rechnung um.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const goldCmdX = await import('../../src/core/bridge/gold-commands.ts');
const invCmd = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const custCmd = await import('../../src/core/bridge/customer-commands.ts');
const dates = await import('../../src/core/orders/order-dates.ts');
const { createReturnInHouse } = await import('../../src/core/returns/return-house.ts');
const ACTORX = { branchId: 'branch-main', userId: 'user-test' };
const stand = (db: Db, oid: string) => S({
  inv: n(db, 'SELECT COUNT(*) FROM invoices'), pay: n(db, 'SELECT COUNT(*) FROM payments'), op: n(db, 'SELECT COUNT(*) FROM order_payments'),
  l: n(db, 'SELECT COUNT(*) FROM ledger_entries'), ol: n(db, 'SELECT COUNT(*) FROM order_lines WHERE order_id = ?', [oid]),
  gp: n(db, 'SELECT COUNT(*) FROM gold_payables'), ex: n(db, 'SELECT COUNT(*) FROM expenses'),
});
const snap = (db: Db, inv: string) => r3(n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [inv]));
const laborLine = (db: Db, oid: string, d: string) => s(db, 'SELECT id FROM order_lines WHERE order_id = ? AND description = ?', [oid, d]);
const goldLineOf = (db: Db, oid: string) => s(db, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'gold' AND status != 'CANCELLED' ORDER BY position DESC", [oid]);
const umgewandelt = (db: Db, extra: Partial<OI> = {}, scheme = 'ZERO') => {
  const oid = anlegen({ ...ORD2, depositAmount: 240, paymentMethod: 'benefit', ...extra });
  const out = umwandeln(oid, { taxSchemes: { [customLineOf(db, oid)]: scheme as never }, invoiceDate: '2026-10-25' });
  return { oid, out };
};
{
  const db = freshDb();
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('sup-w2','branch-main','Second Goldsmith',1,1,?,?)", [NOW, NOW]);
  reload();
  const { oid, out } = umgewandelt(db);
  const inv = rows(db, 'SELECT status, gross_amount, paid_amount FROM invoices WHERE id = ?', [out.invoiceId])[0];
  ok(inv.status === 'FINAL' && Number(inv.paid_amount) === 240 && snap(db, out.invoiceId) === 210 && saldo(db, 'INVENTORY') === 0 && saldo(db, 'COGS') === 210,
    `E0 Ausgang wie ORD-2: Rechnung FINAL, voll durch die Anzahlung bezahlt, Einstand 210, Lager 0 (${S(inv)})`);
  const invCount = n(db, 'SELECT COUNT(*) FROM invoices'), payCount = n(db, 'SELECT COUNT(*) FROM payments');

  // A1 Lohn nachträglich +5 (Arup) — Rechnung folgt: Einstand 215, Wareneinsatz 215, Lager bleibt 0, Arup 30 offen.
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Extra polish', totalCost: 5, supplierId: 'sup-arup' }] }));
  reload();
  ok(snap(db, out.invoiceId) === 215 && saldo(db, 'COGS') === 215 && saldo(db, 'INVENTORY') === 0 && saldo(db, 'ACCOUNTS_PAYABLE', "counterparty_id = 'sup-arup'") === -30
    && r3(n(db, 'SELECT purchase_price FROM products WHERE id = ?', [out.productIds[0]])) === 215,
    `A1 Lohn +5 nach der Rechnung: Einstand/Wareneinsatz 215, Lager 0, Arup 30, Artikel 215 (${snap(db, out.invoiceId)} / ${saldo(db, 'COGS')} / ${saldo(db, 'INVENTORY')})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === invCount && n(db, 'SELECT COUNT(*) FROM payments') === payCount
    && s(db, 'SELECT status FROM invoices WHERE id = ?', [out.invoiceId]) === 'FINAL' && r3(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [out.invoiceId])) === 240
    && r3(n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [out.invoiceId])) === 0,
    'A1 keine neue Rechnung, keine neue Zahlung; Rechnung bleibt FINAL 240, VAT 0 (Zero)');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'cost_correction_order_after_invoice'") === 1 && buchAusgeglichen(db), 'A1 protokolliert, Hauptbuch ausgeglichen');
  // A2 die Zeile wieder entfernen → 210.
  imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid, lineId: laborLine(db, oid, 'Extra polish') }));
  reload();
  ok(snap(db, out.invoiceId) === 210 && saldo(db, 'COGS') === 210 && saldo(db, 'INVENTORY') === 0 && saldo(db, 'ACCOUNTS_PAYABLE', "counterparty_id = 'sup-arup'") === -25,
    `A2 Lohnzeile entfernt: zurück auf 210, Arup 25 (${snap(db, out.invoiceId)})`);
  // A3 Gold korrigieren (Gramm/Karat/Wert): alte Goldzeile raus, neue 4,5 g 21K 190 bei Arup.
  imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid, lineId: goldLineOf(db, oid) }));
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'gold', description: 'Gold 4.5g 21K', weightGrams: 4.5, karat: '21K', totalCost: 190, supplierId: 'sup-arup' }] }));
  reload();
  const gp = rows(db, "SELECT weight_grams, karat, status, book_value, supplier_id FROM gold_payables WHERE source_order_id = ? AND status = 'OPEN'", [oid]);
  ok(snap(db, out.invoiceId) === 215 && saldo(db, 'COGS') === 215 && saldo(db, 'INVENTORY') === 0 && saldo(db, 'GOLD_LIABILITY', "counterparty_id = 'sup-arup'") === -190
    && gp.length === 1 && Number(gp[0].weight_grams) === 4.5 && Number(gp[0].book_value) === 190,
    `A3 Gold 4,33 g/185 → 4,5 g/190: Goldschuld Arup 190, Einstand 215, Lager 0 (${S(gp)})`);
  // A4 Goldquelle wechseln: dieselbe Goldschuld bei einer anderen Werkstatt.
  imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid, lineId: goldLineOf(db, oid) }));
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'gold', description: 'Gold 4.5g 22K', weightGrams: 4.5, karat: '22K', totalCost: 190, supplierId: 'sup-w2' }] }));
  reload();
  ok(saldo(db, 'GOLD_LIABILITY', "counterparty_id = 'sup-arup'") === 0 && saldo(db, 'GOLD_LIABILITY', "counterparty_id = 'sup-w2'") === -190 && snap(db, out.invoiceId) === 215
    && s(db, "SELECT karat FROM gold_payables WHERE source_order_id = ? AND status = 'OPEN'", [oid]) === '22K',
    'A4 Goldquelle → Second Goldsmith, Karat 22K: Goldschuld dort 190, bei Arup 0, Einstand unverändert 215');
  // A5 eigene Kosten am verkauften Stück: Nein, nichts geschrieben.
  let vor = stand(db, oid);
  const c5 = nein(() => imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'own', totalCost: 3, supplierId: '__INHOUSE__' }] })));
  ok(c5 === 'CUSTOM_COSTS_NOT_BOOKED' && stand(db, oid) === vor, `A5 eigene Kosten nach der Rechnung: Nein (${c5})`);
  // A6 PC2: dieselbe Hausfolge über orders.add_cost / orders.remove_cost.
  const r6 = await fern(() => goldCmdX.runOrderCost(deps(db), identity('a6', 'orders.add_cost'),
    { orderId: oid, expectedRevision: orev(db, oid), rows: [{ materialKind: 'labor', description: 'PC2 fix', totalCost: 4, supplierId: 'sup-arup' }] }));
  reload();
  ok(r6.ok && snap(db, out.invoiceId) === 219 && saldo(db, 'INVENTORY') === 0 && saldo(db, 'COGS') === 219, `A6 PC2 Lohn +4: Einstand 219, Lager 0 (${r6.code})`);
  const r6b = await fern(() => goldCmdX.runOrderCostRemove(deps(db), identity('a7', 'orders.remove_cost'),
    { orderId: oid, expectedRevision: orev(db, oid), lineId: laborLine(db, oid, 'PC2 fix') }));
  reload();
  ok(r6b.ok && snap(db, out.invoiceId) === 215, `A6 PC2 entfernt: 215 (${r6b.code})`);
  // C Daten nach der Rechnung: geht, keine Buchung.
  const l0 = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  imHaus(() => dates.updateOrderDatesInHouse(oid, { orderDate: '2026-10-24', completedOn: '2026-10-25' }, 'branch-main'));
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === l0 && s(db, 'SELECT order_date FROM orders WHERE id = ?', [oid]) === '2026-10-24', 'C Daten der umgewandelten Order korrigiert, keine Buchung');
  ok(buchAusgeglichen(db), 'A Hauptbuch ausgeglichen');

  // B Kundenwechsel (Order → Rechnung → Anzahlung): alles zieht um, rückwirkend; Unbeteiligte unverändert.
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('c2','branch-main','Fatima','Right','BH','en',0,'[]','collector','active',?,?), ('c3','branch-main','Other','Client','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW, NOW, NOW]);
  reload();
  const fremd = anlegen({ ...ORD2, customerId: 'c3', depositAmount: 100, paymentMethod: 'benefit' });
  const c3vor = S(rows(db, "SELECT account, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),3) s FROM ledger_entries WHERE counterparty_id = 'c3' GROUP BY account ORDER BY account"));
  const lines = rows(db, 'SELECT id, product_id, quantity, unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])
    .map((l) => ({ lineId: String(l.id), productId: String(l.product_id), quantity: Number(l.quantity), unitPrice: Number(l.unit_price), purchasePrice: Number(l.purchase_price_snapshot),
      taxScheme: String(l.tax_scheme), vatRate: Number(l.vat_rate), vatAmount: Number(l.vat_amount), lineTotal: Number(l.line_total) }));
  vor = stand(db, oid);
  const b0 = nein(() => imHaus(() => useInvoiceStore.getState().editInvoice(out.invoiceId, { lines: lines as never, customerId: 'c2', reason: 'Wrong client' })));
  ok(/CUSTOMER_CHANGE_NEEDS_CONFIRMATION/.test(b0) && stand(db, oid) === vor && s(db, 'SELECT customer_id FROM orders WHERE id = ?', [oid]) === 'c1', `B ohne Bestätigung: Nein, nichts geändert (${b0})`);
  const c1vor = S(rows(db, "SELECT account, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),3) s FROM ledger_entries WHERE counterparty_id = 'c1' GROUP BY account HAVING ABS(s) > 0.0005 ORDER BY account"));
  const opId = s(db, 'SELECT id FROM order_payments WHERE order_id = ?', [oid]);
  const depVor = rows(db, "SELECT substr(occurred_at,1,10) d, account, direction, amount FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT' AND source_id = ? AND reverses_entry_id IS NULL ORDER BY rowid", [opId]);
  imHaus(() => useInvoiceStore.getState().editInvoice(out.invoiceId, { lines: lines as never, customerId: 'c2', reason: 'Wrong client', confirmCustomerChange: true }));
  reload();
  const sald = (cp: string) => S(rows(db, "SELECT account, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),3) s FROM ledger_entries WHERE counterparty_id = ? GROUP BY account HAVING ABS(s) > 0.0005 ORDER BY account", [cp]));
  ok(s(db, 'SELECT customer_id FROM orders WHERE id = ?', [oid]) === 'c2' && s(db, 'SELECT customer_id FROM invoices WHERE id = ?', [out.invoiceId]) === 'c2',
    'B Order und Rechnung auf den neuen Kunden');
  ok(sald('c1') === '[]' && sald('c2') === c1vor && /CUSTOMER_DEPOSITS|ACCOUNTS_RECEIVABLE/.test(c1vor) === false,
    `B Salden: der neue Kunde trägt genau, was der alte trug; der alte steht überall auf 0 (vorher c1 ${c1vor} / jetzt c1 ${sald('c1')} c2 ${sald('c2')})`);
  const depNeu = rows(db, `SELECT substr(occurred_at,1,10) d, account, direction, amount, counterparty_id cp FROM ledger_entries e1 WHERE source_module = 'ORDER_PAYMENT' AND source_id = ?
    AND reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) ORDER BY rowid`, [opId]);
  ok(depNeu.length === 2 && depNeu.every((x) => x.cp === 'c2' && x.d === String(depVor[0].d)), `B Anzahlung beim neuen Kunden am ursprünglichen Tag (${S(depNeu)})`);
  ok(S(rows(db, "SELECT account, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),3) s FROM ledger_entries WHERE counterparty_id = 'c3' GROUP BY account ORDER BY account")) === c3vor,
    'B ein unbeteiligter Kunde bleibt unverändert');
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === JSON.parse(vor).inv && n(db, 'SELECT COUNT(*) FROM payments') === JSON.parse(vor).pay && n(db, 'SELECT COUNT(*) FROM order_payments') === JSON.parse(vor).op
    && snap(db, out.invoiceId) === 215 && s(db, 'SELECT status FROM invoices WHERE id = ?', [out.invoiceId]) === 'FINAL',
    'B keine neue Rechnung, Zahlung oder Anzahlung; Rechnung FINAL, Einstand 215');
  ok(buchAusgeglichen(db), 'B Hauptbuch ausgeglichen');
  void fremd;
  // B PC2: zurück auf c1 über invoices.update — dieselbe Hausfolge.
  const rb = await fern(() => invCmd.runInvoiceUpdate(deps(db), identity('b9', 'invoices.update'),
    { id: out.invoiceId, expectedRevision: n(db, 'SELECT revision FROM invoices WHERE id = ?', [out.invoiceId]), reason: 'Back', confirmCustomerChange: true,
      customerId: 'c1', lines: lines.map((l) => ({ lineId: l.lineId, productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, scheme: l.taxScheme })) }));
  reload();
  ok(rb.ok && s(db, 'SELECT customer_id FROM orders WHERE id = ?', [oid]) === 'c1' && sald('c2') === '[]' && sald('c1') === c1vor,
    `B PC2 (invoices.update): Order und Rechnung zurück auf den ersten Kunden, Salden 0 (${rb.code})`);
  // D Kundenname: Stammdaten (customers.update) — die Order zeigt den neuen Namen.
  const rd = await fern(() => custCmd.runCustomerUpdate(deps(db), identity('d1', 'customers.update'), { id: 'c1', lastName: 'Khalid-Corrected' }));
  reload();
  ok(rd.ok && s(db, 'SELECT last_name FROM customers WHERE id = ?', ['c1']) === 'Khalid-Corrected', `D Name korrigiert (Stammdaten, VAT-Sperre der Stammdaten bleibt) (${rd.code})`);
  ok(src('src/pages/orders/OrderDetail.tsx').includes('data-order-change-client') && src('src/pages/orders/OrderDetail.tsx').includes('/invoices/${order.invoiceId}/edit'),
    'Maske: „Change client" an der umgewandelten Order führt in die Rechnungskorrektur');
}
{
  // A7 geschlossenes Quartal der Rechnung: Nein, nichts geschrieben. A8 Margin im offenen Quartal: VAT folgt. A9 Retoure: Nein.
  setOpeningCutoffForTest('2026-01-01');
  const db = freshDb();
  const oid = anlegen({ ...ORD2, orderDate: '2026-09-01', depositAmount: 240, paymentMethod: 'benefit' });
  const out = umwandeln(oid, { taxSchemes: { [customLineOf(db, oid)]: 'MARGIN' }, invoiceDate: '2026-09-10' });
  // A8 offen: Margin-VAT aus der neuen Marge.
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Setting', totalCost: 10, supplierId: 'sup-arup' }] }));
  reload();
  ok(snap(db, out.invoiceId) === 220 && r3(n(db, 'SELECT vat_amount FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])) === 1.818 && saldo(db, 'INVENTORY') === 0,
    `A8 Margin, Quartal offen: Einstand 220, Margin-VAT aus 240 − 220 = 1,818 (${n(db, 'SELECT vat_amount FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])})`);
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('q3x','branch-main',2026,3,?,'{}',?)", [NOW, NOW]);
  const vor = stand(db, oid);
  const c7 = nein(() => imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'late', totalCost: 2, supplierId: 'sup-arup' }] })));
  const c7b = nein(() => imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid, lineId: laborLine(db, oid, 'Setting') })));
  ok(c7 === 'ORDER_COSTS_PERIOD_CLOSED' && c7b === 'ORDER_COSTS_PERIOD_CLOSED' && stand(db, oid) === vor && snap(db, out.invoiceId) === 220,
    `A7 Quartal der Rechnung gemeldet: Hinzufügen und Entfernen Nein, nichts geschrieben (${c7}/${c7b})`);
  db.run("DELETE FROM vat_filings WHERE id = 'q3x'");
  // A9 Retoure vorhanden: Nein.
  imHaus(() => createReturnInHouse({ invoiceId: out.invoiceId, lines: [{ invoiceLineId: s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]), quantity: 1 }],
    refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'T', refundNow: false } as never, 'branch-main'));
  reload();
  const c9 = nein(() => imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'x', totalCost: 1, supplierId: 'sup-arup' }] })));
  ok(c9 === 'INVOICE_HAS_RETURNS', `A9 Rechnung mit Retoure: Nein (${c9})`);
  setOpeningCutoffForTest(null);
}
{
  // A10 Goldschuld schon (teil-)beglichen: die Goldzeile bleibt (erst die Begleichung zurücknehmen).
  const db = freshDb();
  const { oid } = umgewandelt(db);
  settle(payableOf(db, oid), 1, 44);
  const c10 = nein(() => imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid, lineId: goldLineOf(db, oid) })));
  ok(c10 !== 'KEIN NEIN', `A10 beglichene Goldschuld: Goldzeile bleibt (${c10})`);
}

{
  // A11 schon an Arup (teil-)bezahlter Lohn — Owner-Entscheidung „Kostenkorrektur" (ersetzt ORDER_COST_PAID): ohne Wahl Nein,
  // nichts geändert; mit Wahl (Guthaben/Rückforderung) geht die Zeile, die Zahlung bleibt stehen (order-cost-correction.test).
  const db = freshDb();
  const { oid, out } = umgewandelt(db);
  const { recordExpensePaymentInHouse } = await import('../../src/core/payables/payables-house.ts');
  const lab = s(db, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'labor'", [oid]);
  const exp = s(db, 'SELECT expense_id FROM order_lines WHERE id = ?', [lab]);
  imHaus(() => recordExpensePaymentInHouse(exp, 10, 'cash', { branchId: 'branch-main', userId: 'user-test', now: NOW }));
  reload();
  const vor = stand(db, oid);
  const c11 = nein(() => imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid, lineId: lab })));
  ok(c11 === 'ORDER_COST_OVERPAY_CHOICE_REQUIRED' && stand(db, oid) === vor && n(db, 'SELECT COUNT(*) FROM expense_payments WHERE expense_id = ?', [exp]) === 1 && snap(db, out.invoiceId) === 210,
    `A11 teilweise bezahlter Lohn ohne Wahl: Nein, Zahlung und Buchung bleiben (${c11})`);
  imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid, lineId: lab, overpayChoice: 'refund' }));
  reload();
  ok(n(db, 'SELECT COUNT(*) FROM order_lines WHERE id = ?', [lab]) === 0 && n(db, 'SELECT COUNT(*) FROM expense_payments WHERE expense_id = ?', [exp]) === 1
    && snap(db, out.invoiceId) === 185 && n(db, "SELECT COUNT(*) FROM supplier_credits WHERE status = 'REFUND_DUE' AND amount = 10") === 1,
    'A11 mit Wahl Rückforderung: Zeile weg, Zahlung bleibt, Rückforderung 10, Einstand 185');
  // Vor der Rechnung gilt dieselbe Regel.
  const oid2 = anlegen({ ...ORD2, status: 'pending', depositAmount: 0 });
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid2, rows: [{ materialKind: 'labor', description: 'Paid work', totalCost: 20, supplierId: 'sup-arup' }] }));
  reload();
  const lab2 = laborLine(db, oid2, 'Paid work');
  imHaus(() => recordExpensePaymentInHouse(s(db, 'SELECT expense_id FROM order_lines WHERE id = ?', [lab2]), 20, 'cash', { branchId: 'branch-main', userId: 'user-test', now: NOW }));
  reload();
  ok(nein(() => imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid2, lineId: lab2 }))) === 'ORDER_COST_OVERPAY_CHOICE_REQUIRED', 'A11 auch vor der Rechnung: bezahlte Kostenzeile nur mit Wahl');
  ok(buchAusgeglichen(db), 'A11 Hauptbuch ausgeglichen');
}

console.log(`\nEDIT ORDER AFTER INVOICE: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
