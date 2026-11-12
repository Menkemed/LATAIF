// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER — Kostenkorrektur (Owner): bezahlte und unbezahlte Order-Kosten ändern/löschen — Schuld folgt, bei
// Überzahlung Guthaben oder Rückforderung. Testumgebung wie edit-after-invoice.
// Run: node --experimental-strip-types test/custom-order/order-cost-correction.test.ts
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Kostenkorrektur (Owner-Entscheidung, ersetzt ORDER_COST_PAID): Kosten ändern/löschen, die Lieferantenschuld
// folgt; nur bei echter Überzahlung wählt der Mensch Guthaben oder Rückforderung. Beispiel Lohn 25 → 20.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const { recordExpensePaymentInHouse, recordSupplierCreditRefundInHouse } = await import('../../src/core/payables/payables-house.ts');
const { runCounterpartyAudit } = await import('../../src/core/ledger/counterpartyAudit.ts');
const { supplierCreditsFor } = await import('../../src/stores/supplierStore.ts');
const { orderDeleteBlocker } = await import('../../src/stores/orderStore.ts');
const HCTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };
const JETZT = () => ({ ...HCTX, now: new Date().toISOString() });
const RCTX = { branchId: 'branch-main', tenantId: 'tenant-1', userId: 'user-test', role: 'ADMIN' } as never;

const labOf = (db: Db, oid: string): string => s(db, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'labor' ORDER BY position LIMIT 1", [oid]);
const expOf = (db: Db, lineId: string): string => s(db, 'SELECT expense_id FROM order_lines WHERE id = ?', [lineId]);
const zahlen = (db: Db, lineId: string, amt: number): void => {
  imHaus(() => recordExpensePaymentInHouse(expOf(db, lineId), amt, 'bank', HCTX));
  reload();
};
const aendern = (oid: string, lineId: string, newCost: number, overpayChoice?: 'credit' | 'refund') => {
  const out = imHaus(() => goldHouse.changeOrderCostInHouse(ACTORX, { orderId: oid, lineId, newCost, ...(overpayChoice ? { overpayChoice } : {}) }));
  reload();
  return out;
};
const loeschen = (oid: string, lineId: string, overpayChoice?: 'credit' | 'refund') => {
  const out = imHaus(() => goldHouse.removeOrderCostInHouse(ACTORX, { orderId: oid, lineId, ...(overpayChoice ? { overpayChoice } : {}) }));
  reload();
  return out;
};
const ap = (db: Db): number => saldo(db, 'ACCOUNTS_PAYABLE', "counterparty_id = 'sup-arup'");
const sc = (db: Db): number => saldo(db, 'SUPPLIER_CREDIT', "counterparty_id = 'sup-arup'");
const credits = (db: Db) => rows(db, "SELECT id, amount, used_amount, status FROM supplier_credits WHERE supplier_id = 'sup-arup' ORDER BY created_at, id");
/** Abgleich: AP und Lieferantenguthaben Buch = Domäne (gesamt und je Lieferant), keine Guthaben-Befunde, Buch ausgeglichen. */
function abgleich(db: Db): string {
  const recon = reconciliationSnapshotFor(RCTX).rows
    .filter((r: { account: string }) => ['ACCOUNTS_PAYABLE', 'SUPPLIER_CREDIT', 'INVENTORY'].includes(r.account))
    .filter((r: { ledger: number; domain: number | null }) => r.domain !== null && r.domain !== undefined && Math.abs(r.ledger - Number(r.domain)) > 0.0005)
    .map((r: { account: string; ledger: number; domain: number }) => `${r.account} ${r.ledger}/${r.domain}`);
  const run = (sql: string, p: unknown[] = []) => rows(db, sql, p);
  const a = runCounterpartyAudit(run as never, 'branch-main');
  const bad = [...a.apBySupplier.rows, ...a.supplierCreditBySupplier.rows].filter((r) => r.status !== 'ok')
    .map((r) => `${r.account}:${r.id} ${r.diffFils}`);
  const issues = a.issues.filter((i) => i.side === 'supplier').map((i) => `${i.kind}:${i.detail}`);
  const out = [...recon, ...bad, ...issues, ...(buchAusgeglichen(db) ? [] : ['Buch unausgeglichen'])];
  return out.join(' | ');
}
/** Eine Order wie ORD-2 vor der Rechnung: Lohn 25 Arup gebucht (offen), Goldschuld 4,33 g. */
const vorRechnung = (db: Db): string => { void db; return anlegen({ ...ORD2, depositAmount: 0 }); };

// ── K1: 0 bezahlt — Schuld wird 20, kein Dialog, keine Guthaben ──────────────────────────────────────────────
{
  const db = freshDb();
  const oid = vorRechnung(db);
  const lab = labOf(db, oid);
  const exp = expOf(db, lab);
  ok(!!exp && r3(n(db, 'SELECT amount FROM expenses WHERE id = ?', [exp])) === 25 && ap(db) === -25, `K1 Ausgang: Lohn 25 an Arup offen (${ap(db)})`);
  const inv0 = saldo(db, 'INVENTORY');
  const r = aendern(oid, lab, 20);
  ok(r.overpay === 0 && !r.overpayCreditId && r3(n(db, 'SELECT cost_amount FROM order_lines WHERE id = ?', [lab])) === 20
    && r3(n(db, 'SELECT amount FROM expenses WHERE id = ?', [exp])) === 20 && s(db, 'SELECT status FROM expenses WHERE id = ?', [exp]) === 'PENDING'
    && ap(db) === -20 && saldo(db, 'INVENTORY') === r3(inv0 - 5) && credits(db).length === 0,
    `K1 0 bezahlt: 25 → 20 ohne Wahl, Schuld 20, Lager −5, kein Guthaben (${S(r)} AP ${ap(db)})`);
  const l0 = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  aendern(oid, lab, 20);
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === l0, 'K1 dieselbe Änderung noch einmal: keine Buchung');
  ok(abgleich(db) === '', `K1 Abgleich AP/Guthaben/Lager Buch = Domäne (${abgleich(db)})`);
  // Erhöhen geht genauso (30): Schuld 30.
  aendern(oid, lab, 30);
  ok(ap(db) === -30 && r3(n(db, 'SELECT amount FROM expenses WHERE id = ?', [exp])) === 30 && abgleich(db) === '', `K1 erhöhen auf 30: Schuld 30 (${ap(db)})`);
}

// ── K2: 10 bezahlt — Restschuld 10, kein Dialog ──────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const oid = vorRechnung(db);
  const lab = labOf(db, oid);
  zahlen(db, lab, 10);
  const bank0 = saldo(db, 'BANK');
  const r = aendern(oid, lab, 20);
  const e = rows(db, 'SELECT amount, paid_amount, status FROM expenses WHERE id = ?', [expOf(db, lab)])[0];
  ok(r.overpay === 0 && Number(e.amount) === 20 && Number(e.paid_amount) === 10 && e.status === 'PENDING' && ap(db) === -10
    && credits(db).length === 0 && saldo(db, 'BANK') === bank0 && n(db, 'SELECT COUNT(*) FROM expense_payments') === 1,
    `K2 10 bezahlt: 25 → 20 → Restschuld 10, Zahlung unverändert, kein Guthaben (${S(e)} AP ${ap(db)})`);
  ok(abgleich(db) === '', `K2 Abgleich (${abgleich(db)})`);
}

// ── K3: 25 bezahlt — Wahl Pflicht; Guthaben 5; Folgeänderungen ohne Doppel ──────────────────────────────────
{
  const db = freshDb();
  const oid = vorRechnung(db);
  const lab = labOf(db, oid);
  const exp = expOf(db, lab);
  zahlen(db, lab, 25);
  const bank0 = saldo(db, 'BANK');
  const vor = stand(db, oid);
  const c0 = nein(() => aendern(oid, lab, 20));
  ok(c0 === 'ORDER_COST_OVERPAY_CHOICE_REQUIRED' && stand(db, oid) === vor && r3(n(db, 'SELECT cost_amount FROM order_lines WHERE id = ?', [lab])) === 25,
    `K3 25 bezahlt, ohne Wahl: Nein, nichts geändert (${c0})`);
  const r = aendern(oid, lab, 20, 'credit');
  const c = credits(db);
  ok(r.overpay === 5 && r.overpayKind === 'credit' && c.length === 1 && Number(c[0].amount) === 5 && c[0].status === 'OPEN'
    && ap(db) === 0 && sc(db) === 5 && saldo(db, 'BANK') === bank0,
    `K3 Guthaben: 5 BHD verrechenbar, Schuld 0, kein Geld bewegt (${S(c)} AP ${ap(db)} SC ${sc(db)})`);
  const e = rows(db, 'SELECT amount, paid_amount, status FROM expenses WHERE id = ?', [exp])[0];
  ok(Number(e.amount) === 20 && Number(e.paid_amount) === 25 && e.status === 'PAID'
    && n(db, 'SELECT COUNT(*) FROM expense_payments WHERE expense_id = ?', [exp]) === 1
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'EXPENSE_PAYMENT' AND reverses_entry_id IS NULL") === 2
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'EXPENSE_PAYMENT' AND reverses_entry_id IS NOT NULL") === 0,
    `K3 Originalzahlung 25 bleibt unverändert (Zeile + Buchung), Ausgabe 20 PAID (${S(e)})`);
  ok(supplierCreditsFor(RCTX, 'sup-arup').availableAmount === 5
    && supplierCreditsFor(RCTX, 'sup-arup').credits[0]?.kind === 'order_cost_overpay',
    'K3 Lieferantenkarte: 5 verfügbar, Art „Order Cost Overpayment"');
  ok(abgleich(db) === '', `K3 Abgleich (${abgleich(db)})`);
  const l1 = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  aendern(oid, lab, 20, 'credit');
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === l1 && credits(db).length === 1, 'K3 Wiederholung: kein zweites Guthaben, keine Buchung');
  // 20 → 15: Überzahlung 10 — das unbenutzte Guthaben wird angeglichen (eines, nie zwei).
  aendern(oid, lab, 15, 'credit');
  const c2 = credits(db);
  ok(c2.length === 1 && Number(c2[0].amount) === 10 && sc(db) === 10 && ap(db) === 0 && abgleich(db) === '',
    `K3 15: genau ein Guthaben 10 (${S(c2)} SC ${sc(db)})`);
  // zurück auf 25: Überzahlung 0 — Guthaben verschwindet, ohne Wahl.
  aendern(oid, lab, 25);
  ok(credits(db).length === 0 && sc(db) === 0 && ap(db) === 0 && r3(n(db, 'SELECT amount FROM expenses WHERE id = ?', [exp])) === 25 && abgleich(db) === '',
    `K3 zurück auf 25: kein Guthaben, Schuld 0 (SC ${sc(db)} AP ${ap(db)})`);
  // 30: offen 5.
  aendern(oid, lab, 30);
  ok(ap(db) === -5 && credits(db).length === 0 && s(db, 'SELECT status FROM expenses WHERE id = ?', [exp]) === 'PENDING' && abgleich(db) === '',
    `K3 30: 5 offen (${ap(db)})`);
}

// ── K4: 25 bezahlt — Rückforderung 5; Record Repayment; danach gesperrt ────────────────────────────────────
{
  const db = freshDb();
  const oid = vorRechnung(db);
  const lab = labOf(db, oid);
  zahlen(db, lab, 25);
  const r = aendern(oid, lab, 20, 'refund');
  const c = credits(db);
  ok(r.overpayKind === 'refund' && c.length === 1 && Number(c[0].amount) === 5 && c[0].status === 'REFUND_DUE' && sc(db) === 5 && ap(db) === 0,
    `K4 Rückforderung: 5 offen gegenüber Arup (${S(c)})`);
  const karte = supplierCreditsFor(RCTX, 'sup-arup');
  ok(karte.availableAmount === 0 && karte.credits.length === 1 && karte.credits[0].kind === 'repayment_claim'
    && useSupplierStore.getState().getOpenCredits('sup-arup').length === 0,
    `K4 nicht verrechenbar (verfügbar 0), sichtbar als „Repayment Claim" (${S(karte)})`);
  ok(abgleich(db) === '', `K4 Abgleich (${abgleich(db)})`);
  const bank0 = saldo(db, 'BANK');
  const rp = imHaus(() => recordSupplierCreditRefundInHouse({ creditId: String(c[0].id), amount: 2, method: 'bank' }, JETZT()));
  reload();
  ok(rp.creditStatus === 'REFUND_DUE' && rp.openAmount === 3 && saldo(db, 'BANK') === r3(bank0 + 2) && sc(db) === 3 && abgleich(db) === '',
    `K4 Record Repayment 2: Bank +2, offen 3 (${S(rp)})`);
  const rp2 = imHaus(() => recordSupplierCreditRefundInHouse({ creditId: String(c[0].id), amount: 3, method: 'cash' }, JETZT()));
  reload();
  const bk = loadBankingFor(RCTX).transactions.filter((t: { id: string }) => t.id.startsWith('scref-'));
  ok(bk.length === 2 && bk.reduce((x: number, t: { amount: number }) => x + Number(t.amount), 0) === 5 && bk.every((t: { description: string; link: string }) => t.description.includes('Repayment claim') && t.link === '/suppliers/sup-arup'),
    `K4 Banking: Eingänge 2 + 3 als „Repayment received · Repayment claim …“ mit Ziel Lieferant (${S(bk)})`);
  ok(rp2.creditStatus === 'REFUNDED' && rp2.openAmount === 0 && sc(db) === 0 && abgleich(db) === '', `K4 Rest 3: zurückgezahlt (${S(rp2)} / ${abgleich(db)})`);
  const vor = stand(db, oid);
  const cu = nein(() => aendern(oid, lab, 22));
  ok(cu === 'ORDER_COST_OVERPAY_USED' && stand(db, oid) === vor, `K4 Überzahlung schon zurückgezahlt: Betrag bleibt (${cu})`);
  const cx = nein(() => imHaus(() => recordSupplierCreditRefundInHouse({ creditId: String(c[0].id), amount: 1, method: 'cash' }, JETZT())));
  ok(cx === 'SUPPLIER_CREDIT_NOT_OPEN', `K4 nie mehr als offen (${cx})`);
}

// ── K5: Löschen — unbezahlt wie bisher; teil-/voll bezahlt mit Wahl; Zahlungen bleiben; Order-Löschen gesperrt ──────
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0, extraGoldGrams: 0, extraGoldCost: 0 });
  const lab = labOf(db, oid);
  const exp = expOf(db, lab);
  zahlen(db, lab, 10);
  const vor = stand(db, oid);
  const c0 = nein(() => loeschen(oid, lab));
  ok(c0 === 'ORDER_COST_OVERPAY_CHOICE_REQUIRED' && stand(db, oid) === vor, `K5 teilweise bezahlt, ohne Wahl: Nein (${c0})`);
  const inv0 = saldo(db, 'INVENTORY');
  const r = loeschen(oid, lab, 'refund');
  ok(r.overpay === 10 && r.overpayKind === 'refund' && n(db, 'SELECT COUNT(*) FROM order_lines WHERE id = ?', [lab]) === 0
    && s(db, 'SELECT status FROM expenses WHERE id = ?', [exp]) === 'CANCELLED' && n(db, 'SELECT COUNT(*) FROM expense_payments WHERE expense_id = ?', [exp]) === 1
    && ap(db) === 0 && sc(db) === 10 && saldo(db, 'INVENTORY') === r3(inv0 - 25),
    `K5 teilweise bezahlt löschen + Rückforderung: Zeile weg, Ausgabe storniert, Zahlung bleibt, 10 Rückforderung, Lager −25 (${S(r)})`);
  ok(abgleich(db) === '', `K5 Abgleich nach Löschen (${abgleich(db)})`);
  // Owner 12.11.2026 — Banking zeigt eine Zeile je Zahlung (id exp-<Ausgabe>-<Zahlung>): nach der Ausgabe filtern.
  const out5 = loadBankingFor(RCTX).transactions.filter((t: { relatedEntityId?: string; type?: string }) => t.relatedEntityId === exp && t.type === 'EXPENSE_OUT');
  ok(out5.length === 1 && Number(out5[0].amount) === 10 && out5[0].flow === 'out',
    `K5 Banking: der echte Abfluss 10 der gelöschten Zeile bleibt sichtbar (${S(out5)})`);
  const blk = orderDeleteBlocker(oid);
  ok(blk?.code === 'ORDER_DELETE_COSTS_PAID', `K5 Order löschen: gesperrt (die Zahlung bliebe ohne Auftrag) (${blk?.code})`);
  // unbezahlte Zeile: wie bisher, kein Dialog, keine Guthaben.
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Unpaid', totalCost: 8, supplierId: 'sup-arup' }] }));
  reload();
  const u = laborLine(db, oid, 'Unpaid');
  const ue = expOf(db, u);
  const r2 = loeschen(oid, u);
  ok(!r2.overpay && n(db, 'SELECT COUNT(*) FROM expenses WHERE id = ?', [ue]) === 0 && credits(db).length === 1 && ap(db) === 0 && abgleich(db) === '',
    `K5 unbezahlte Zeile löschen: wie bisher (Ausgabe weg), keine Wahl (${S(r2)})`);
  // voll bezahlt löschen → Guthaben 20.
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Paid', totalCost: 20, supplierId: 'sup-arup' }] }));
  reload();
  const pz = laborLine(db, oid, 'Paid');
  zahlen(db, pz, 20);
  const r3x = loeschen(oid, pz, 'credit');
  ok(r3x.overpay === 20 && r3x.overpayKind === 'credit' && sc(db) === 30 && ap(db) === 0 && abgleich(db) === '',
    `K5 voll bezahlt löschen + Guthaben 20 (SC ${sc(db)} = 10 Rückforderung + 20 Guthaben)`);
}

// ── K6: nach der Umwandlung (FINAL, voll bezahlt) — Rechnung folgt, keine neue Rechnung/Zahlung ──────────────
{
  const db = freshDb();
  const { oid, out } = umgewandelt(db);
  const lab = labOf(db, oid);
  zahlen(db, lab, 25);
  const invCount = n(db, 'SELECT COUNT(*) FROM invoices'), payCount = n(db, 'SELECT COUNT(*) FROM payments');
  ok(snap(db, out.invoiceId) === 210 && s(db, 'SELECT status FROM invoices WHERE id = ?', [out.invoiceId]) === 'FINAL', 'K6 Ausgang: FINAL, Einstand 210');
  const r = aendern(oid, lab, 20, 'credit');
  ok(r.overpay === 5 && snap(db, out.invoiceId) === 205 && saldo(db, 'COGS') === 205 && saldo(db, 'INVENTORY') === 0
    && r3(n(db, 'SELECT purchase_price FROM products WHERE id = ?', [out.productIds[0]])) === 205 && sc(db) === 5 && ap(db) === 0,
    `K6 Lohn 25 → 20 nach FINAL: Einstand/Wareneinsatz/Artikel 205, Lager 0, Guthaben 5 (${snap(db, out.invoiceId)}/${saldo(db, 'COGS')}/${saldo(db, 'INVENTORY')})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === invCount && n(db, 'SELECT COUNT(*) FROM payments') === payCount
    && s(db, 'SELECT status FROM invoices WHERE id = ?', [out.invoiceId]) === 'FINAL' && r3(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [out.invoiceId])) === 240,
    'K6 keine neue Rechnung, keine neue Zahlung, Rechnung FINAL 240');
  ok(abgleich(db) === '', `K6 Abgleich (${abgleich(db)})`);
  // Löschen nach FINAL (bezahlt 25, jetzt 20 + Guthaben 5) → Gesamtüberzahlung 25, EIN Guthaben 25.
  const r2 = loeschen(oid, lab, 'credit');
  ok(r2.overpay === 25 && credits(db).length === 1 && sc(db) === 25 && snap(db, out.invoiceId) === 185 && saldo(db, 'COGS') === 185 && saldo(db, 'INVENTORY') === 0 && abgleich(db) === '',
    `K6 Lohnzeile nach FINAL löschen: ein Guthaben 25, Einstand 185 (${S(credits(db))})`);
  // Gold-Gramm-Zeile: nicht über „Change Cost".
  const cg = nein(() => aendern(oid, goldLineOf(db, oid), 150));
  ok(cg === 'ORDER_COST_GOLD_DEBT', `K6 Goldschuld (Gramm) nicht über Change Cost (${cg})`);
}

// ── K7: VAT-Periodensperren ───────────────────────────────────────────────────────────────────────────────
{
  setOpeningCutoffForTest('2026-01-01');
  const db = freshDb();
  const oid = anlegen({ ...ORD2, orderDate: '2026-09-01', depositAmount: 240, paymentMethod: 'benefit' });
  const out = umwandeln(oid, { taxSchemes: { [customLineOf(db, oid)]: 'ZERO' as never }, invoiceDate: '2026-09-10' });
  const lab = labOf(db, oid);
  zahlen(db, lab, 25);
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('q3x','branch-main',2026,3,?,'{}',?)", [NOW, NOW]);
  const vor = stand(db, oid);
  const c1 = nein(() => aendern(oid, lab, 20, 'credit'));
  const c2 = nein(() => loeschen(oid, lab, 'credit'));
  ok(c1 === 'ORDER_COSTS_PERIOD_CLOSED' && c2 === 'ORDER_COSTS_PERIOD_CLOSED' && stand(db, oid) === vor && snap(db, out.invoiceId) === 210,
    `K7 Rechnungsquartal gemeldet: Ändern/Löschen Nein, nichts geändert (${c1}/${c2})`);
  // Ohne Rechnung: die Schuld ist am 15.09. gebucht (Q3 gemeldet) — eine Betragsänderung buchte dort neu → Nein.
  const oid2 = anlegen({ ...ORD2, depositAmount: 0, status: 'pending', laborCost: 0, extraGoldGrams: 0, extraGoldCost: 0, orderDate: '2026-09-01' });
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid2, rows: [{ materialKind: 'labor', description: 'Sep work', totalCost: 25, supplierId: 'sup-arup' }] }));
  reload();
  const l2 = laborLine(db, oid2, 'Sep work');
  db.run("UPDATE expenses SET expense_date = '2026-09-15' WHERE id = ?", [expOf(db, l2)]);
  const vor2 = stand(db, oid2);
  const c3 = nein(() => aendern(oid2, l2, 20));
  ok(c3 === 'VAT_PERIOD_FILED' && stand(db, oid2) === vor2, `K7 Ausgabe in gemeldetem Quartal: Betrag bleibt (${c3})`);
  db.run("DELETE FROM vat_filings WHERE id = 'q3x'");
  setOpeningCutoffForTest(null);
}

// ── K8: PC2 — derselbe Befehl orders.remove_cost (newCost / overpayChoice), dieselben Neins ─────────────────────
{
  const db = freshDb();
  const { oid, out } = umgewandelt(db);
  const lab = labOf(db, oid);
  zahlen(db, lab, 25);
  const bad = await fern(() => goldCmd.runOrderCostRemove(deps(db), identity('c1', 'orders.remove_cost'),
    { orderId: oid, expectedRevision: orev(db, oid), lineId: lab, newCost: 20, overpayChoice: 'gift' }));
  ok(!bad.ok && bad.code === 'GOLD_PAYLOAD_INVALID', `K8 PC2 unbekannte Wahl: Nein (${bad.code})`);
  const r0 = await fern(() => goldCmd.runOrderCostRemove(deps(db), identity('c2', 'orders.remove_cost'),
    { orderId: oid, expectedRevision: orev(db, oid), lineId: lab, newCost: 20 }));
  ok(!r0.ok && r0.code === 'ORDER_COST_OVERPAY_CHOICE_REQUIRED', `K8 PC2 ohne Wahl: eingefrorenes Nein (${r0.code})`);
  const r1 = await fern(() => goldCmd.runOrderCostRemove(deps(db), identity('c3', 'orders.remove_cost'),
    { orderId: oid, expectedRevision: orev(db, oid), lineId: lab, newCost: 20, overpayChoice: 'refund' }));
  reload();
  ok(r1.ok && r1.value?.overpay === 5 && r1.value?.overpayKind === 'refund' && snap(db, out.invoiceId) === 205 && credits(db)[0]?.status === 'REFUND_DUE'
    && abgleich(db) === '', `K8 PC2 Change Cost + Rückforderung: wie am Primary (${S(r1.value)} / ${abgleich(db)})`);
  // Wiederholung desselben Befehls (gleiche commandId): dieselbe Antwort, keine zweite Buchung.
  const l0 = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const r1b = await fern(() => goldCmd.runOrderCostRemove(deps(db), identity('c3', 'orders.remove_cost'),
    { orderId: oid, expectedRevision: orev(db, oid), lineId: lab, newCost: 20, overpayChoice: 'refund' }));
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === l0 && credits(db).length === 1, `K8 PC2 Wiederholung: keine zweite Buchung (${r1b.ok}/${r1b.code})`);
  // PC2 löschen (offen bezahlt 25, Rückforderung 5 unbenutzt → Überzahlung 25 als Guthaben).
  const r2 = await fern(() => goldCmd.runOrderCostRemove(deps(db), identity('c4', 'orders.remove_cost'),
    { orderId: oid, expectedRevision: orev(db, oid), lineId: lab, overpayChoice: 'credit' }));
  reload();
  ok(r2.ok && r2.value?.overpay === 25 && credits(db).length === 1 && credits(db)[0].status === 'OPEN' && sc(db) === 25 && snap(db, out.invoiceId) === 185
    && abgleich(db) === '', `K8 PC2 Löschen + Guthaben 25 (${S(r2.value)} / ${abgleich(db)})`);
}

// ── K10: Werkstattzeile ohne gebuchte Schuld (0) bekommt einen Betrag → Lieferantenschuld wie bei „Add Cost" ─────────
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0, extraGoldGrams: 0, extraGoldCost: 0 });
  const lid = imHaus(() => useOrderStore.getState().addOrderLine(oid, { description: 'Zero work', quantity: 1, unitPrice: 0, isCustomerFacing: false,
    materialKind: 'labor' as never, supplierId: 'sup-arup', costAmount: 0, status: 'ARRIVED' }));
  reload();
  const ap0 = ap(db);
  ok(!expOf(db, lid), 'K10 Ausgang: Werkstattzeile 0 ohne Ausgabe');
  aendern(oid, lid, 7);
  ok(!!expOf(db, lid) && r3(n(db, 'SELECT amount FROM expenses WHERE id = ?', [expOf(db, lid)])) === 7 && r3(ap(db) - ap0) === -7 && abgleich(db) === '',
    `K10 0 → 7: Lieferantenschuld 7 gebucht (${r3(ap(db) - ap0)})`);
}

// ── K11: heutiges Quartal gemeldet/VAT bezahlt — unbezahlt löschen bleibt der alte Weg (keine neue Sperre, wie r6d);
//         die neuen Buchungen (Betrag ändern, Überzahlung) sind gesperrt, nichts geändert. ─────────────────────────────
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0, extraGoldGrams: 0, extraGoldCost: 0 });
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Stone setting', totalCost: 6, supplierId: 'sup-arup' }] }));
  imHaus(() => goldHouse.addOrderCostInHouse(ACTORX, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Paid part', totalCost: 9, supplierId: 'sup-arup' }] }));
  reload();
  const paidLine = laborLine(db, oid, 'Paid part');
  zahlen(db, paidLine, 9);
  const heute = new Date();
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('qnow','branch-main',?,?,?,'{}',?)",
    [heute.getFullYear(), Math.floor(heute.getMonth() / 3) + 1, NOW, NOW]);
  const vor = stand(db, oid);
  const c1 = nein(() => aendern(oid, labOf(db, oid), 20));
  const c2 = nein(() => aendern(oid, paidLine, 5, 'credit'));
  ok(c1 === 'VAT_PERIOD_FILED' && c2 === 'VAT_PERIOD_FILED' && stand(db, oid) === vor, `K11 Betrag ändern / Überzahlung: Nein (${c1}/${c2})`);
  const r = loeschen(oid, laborLine(db, oid, 'Stone setting'));
  ok(!r.overpay && n(db, "SELECT COUNT(*) FROM order_lines WHERE order_id = ? AND description = 'Stone setting'", [oid]) === 0 && abgleich(db) === '',
    `K11 unbezahlte Zeile löschen: wie bisher erlaubt (${S(r)})`);
  db.run("DELETE FROM vat_filings WHERE id = 'qnow'");
}

// ── K9: Maske, Quelle ─────────────────────────────────────────────────────────────────────────────────────
{
  const od = src('src/pages/orders/OrderDetail.tsx');
  ok(od.includes('data-order-cost-edit=') && od.includes('data-order-cost-overpay="credit"') && od.includes('data-order-cost-overpay="refund"')
    && od.includes('changeOrderCostOnPrimary') && od.includes('orderCostChangeBody'),
    'K9 Maske: „Change Cost" an der Kostenzeile, Wahl Guthaben/Rückforderung nur bei Überzahlung, Primary + PC2');
  ok(src('src/pages/suppliers/SupplierDetail.tsx').includes('data-supplier-repay-open') && src('src/pages/suppliers/SupplierDetail.tsx').includes('saveSupplierCreditRepayment'),
    'K9 Lieferant: Rückforderung mit „Record Repayment"');
  ok(!src('src/core/gold/gold-house.ts').includes("new GoldRejected('ORDER_COST_PAID'"), 'K9 die pauschale Sperre ORDER_COST_PAID ist ersetzt');
}

console.log(`\nORDER COST CORRECTION: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
