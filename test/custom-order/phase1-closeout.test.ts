// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Phase 1 — Abschluss: K4 (Daten nach Completed, Werkstatt-Auswahl), OF3 (Kosten nicht im Lager), OF5a (Retoure nach
// getrennter Goldschuld-Differenz). Testumgebung wie phase1-review.
// Run: node --experimental-strip-types test/custom-order/phase1-closeout.test.ts
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
// Abschluss Phase 1 — K4 (Daten nach „Completed", Werkstatt-Auswahl), OF3 (Kosten nicht im Lager → Nein), OF5a (Retoure
// nach getrennter Goldschuld-Differenz → Nein).
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const dates = await import('../../src/core/orders/order-dates.ts');
const costBooking = await import('../../src/core/orders/order-cost-booking.ts');
const { createReturnInHouse } = await import('../../src/core/returns/return-house.ts');
const returnCmd = await import('../../src/core/bridge/return-commands.ts');
const commercial = await import('../../src/core/bridge/commercial-commands.ts');
const lifecycleHouse = await import('../../src/core/orders/order-lifecycle-house.ts');
/** Fingerabdruck des Hauptbuchs: jede Buchung samt Datum. */
const buch = (db: Db): string => S(rows(db, 'SELECT account, direction, amount, occurred_at, source_module, source_id FROM ledger_entries ORDER BY rowid'));
const auditOf = (db: Db, id: string) => rows(db, "SELECT field_name, old_value, new_value, changed_by FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND field_name IN ('order_date', 'actual_delivery') ORDER BY rowid", [id]);

// ══ K4a — Auftragsdatum und Fertigstellung nach „Completed" (Primary): nur diese Felder, protokolliert, keine Buchung ══
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, orderDate: '2026-10-25', depositAmount: 240, paymentMethod: 'benefit' });
  ok(s(db, 'SELECT status FROM orders WHERE id = ?', [oid]) === 'completed' && s(db, 'SELECT actual_delivery FROM orders WHERE id = ?', [oid]) === '2026-10-25',
    'K4a Ausgang: abgeschlossen am 25.10. (K1 setzt die Fertigstellung beim Anlegen)');
  const buchVor = buch(db);
  const rev0 = orev(db, oid);
  const r = imHaus(() => dates.updateOrderDatesInHouse(oid, { orderDate: '2026-10-20', completedOn: '2026-10-24' }, 'branch-main'));
  reload();
  const o = rows(db, 'SELECT order_date, actual_delivery, status FROM orders WHERE id = ?', [oid])[0];
  ok(S(r.changed) === S(['order_date', 'actual_delivery']) && o.order_date === '2026-10-20' && o.actual_delivery === '2026-10-24' && o.status === 'completed'
    && orev(db, oid) > rev0, `K4a Primary: Auftragsdatum 20.10., Fertigstellung 24.10., Status bleibt (${S(o)})`);
  ok(buch(db) === buchVor, 'K4a keine Buchung verschoben oder neu (Lohn-A/P, Goldwert, Anzahlung behalten ihr Datum)');
  const a = auditOf(db, oid);
  ok(a.length === 2 && a[0].field_name === 'order_date' && a[0].old_value === '2026-10-25' && a[0].new_value === '2026-10-20'
    && a[1].field_name === 'actual_delivery' && a[1].new_value === '2026-10-24', `K4a Protokoll je Feld alt → neu (${S(a)})`);
  const again = imHaus(() => dates.updateOrderDatesInHouse(oid, { orderDate: '2026-10-20', completedOn: '2026-10-24' }, 'branch-main'));
  ok(again.changed.length === 0 && auditOf(db, oid).length === 2, 'K4a zweimal dasselbe: nichts geschrieben (idempotent)');
  const fut = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  ok(nein(() => imHaus(() => dates.updateOrderDatesInHouse(oid, { orderDate: fut }, 'branch-main'))) === 'INVALID_INPUT', 'K4a künftiges Datum: Nein');
  ok(nein(() => imHaus(() => dates.updateOrderDatesInHouse(oid, { completedOn: '2026-10-19' }, 'branch-main'))) === 'ORDER_DATES_OUT_OF_ORDER', 'K4a fertig vor dem Auftrag: Nein');
  ok(nein(() => imHaus(() => dates.updateOrderDatesInHouse(oid, { orderDate: '2026-10-25' as never, completedOn: '25.10.2026' }, 'branch-main'))) === 'INVALID_INPUT', 'K4a ungültiges Format: Nein');
  ok(nein(() => imHaus(() => dates.updateOrderDatesInHouse(oid, {}, 'branch-main'))) === 'INVALID_INPUT', 'K4a ohne Feld: Nein');
  ok(S(rows(db, 'SELECT order_date, actual_delivery FROM orders WHERE id = ?', [oid])[0]) === S({ order_date: '2026-10-20', actual_delivery: '2026-10-24' }), 'K4a nach den Nein: unverändert');
  // Laufender Auftrag: Fertigstellung gibt es noch nicht; „Edit"/„Save" bleibt der Weg fürs Datum.
  const run = anlegen({ ...ORD2, status: 'pending', depositAmount: 0 });
  ok(nein(() => imHaus(() => dates.updateOrderDatesInHouse(run, { completedOn: '2026-10-25' }, 'branch-main'))) === 'ORDER_NOT_COMPLETED', 'K4a laufender Auftrag: keine Fertigstellung');
  ok(nein(() => imHaus(() => houseUpdateCompleted(oid))) === 'ORDER_NOT_EDITABLE', 'K4a „Edit" eines abgeschlossenen Auftrags bleibt gesperrt (nur die Daten)');
}
function houseUpdateCompleted(oid: string): unknown {
  return orderHouse.updateOrderInHouse(oid, { agreedPrice: 999, depositAmount: null, supplierName: null, supplierPrice: null, expectedDelivery: null, notes: 'x' }, 'branch-main');
}

// ══ K4b — dieselbe Korrektur vom PC2 (orders.update, nur Datumsfelder): gleiche Hausfolge, Absender im Protokoll ═══════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, orderDate: '2026-10-25', depositAmount: 0 });
  const buchVor = buch(db);
  const r = await fern(() => commercial.runOrderUpdate(deps(db), { ...identity('90', 'orders.update'), userId: 'user-pc2' },
    { id: oid, expectedRevision: orev(db, oid), orderDate: '2026-10-21', completedOn: '2026-10-23' }));
  reload();
  const o = rows(db, 'SELECT order_date, actual_delivery FROM orders WHERE id = ?', [oid])[0];
  const a = auditOf(db, oid);
  ok(r.ok && o.order_date === '2026-10-21' && o.actual_delivery === '2026-10-23' && buch(db) === buchVor && a.length === 2 && a.every((x) => x.changed_by === 'user-pc2'),
    `K4b PC2: Daten korrigiert, keine Buchung, Absender im Protokoll (${r.code} ${S(o)} ${S(a.map((x) => x.changed_by))})`);
  const r2 = await fern(() => commercial.runOrderUpdate(deps(db), identity('91', 'orders.update'), { id: oid, expectedRevision: orev(db, oid), orderDate: '2026-10-22' }));
  ok(r2.ok && s(db, 'SELECT order_date FROM orders WHERE id = ?', [oid]) === '2026-10-22', `K4b PC2 nur Auftragsdatum eines abgeschlossenen Auftrags: geht (${r2.code})`);
  const r3x = await fern(() => commercial.runOrderUpdate(deps(db), identity('92', 'orders.update'), { id: oid, expectedRevision: orev(db, oid), completedOn: '2026-10-21' }));
  ok(!r3x.ok && r3x.code === 'ORDER_DATES_OUT_OF_ORDER', `K4b PC2 dieselbe Prüfung (${r3x.code})`);
  let gemischt = '';
  try { commercial.parseOrderUpdate({ id: oid, expectedRevision: 1, completedOn: '2026-10-23', agreedPrice: 5 }); } catch (e) { gemischt = (e as Error).message; }
  ok(/on its own/.test(gemischt), 'K4b PC2-Rumpf: Fertigstellung nicht zusammen mit anderen Feldern');
  const r4 = await fern(() => commercial.runOrderUpdate(deps(db), identity('93', 'orders.update'), { id: oid, expectedRevision: orev(db, oid), notes: 'x' }));
  ok(!r4.ok && r4.code === 'ORDER_NOT_EDITABLE', `K4b PC2 sonstige Felder eines abgeschlossenen Auftrags: weiterhin Nein (${r4.code})`);
  // Ein laufender Auftrag ändert sein Datum wie bisher über „Save".
  const run = anlegen({ ...ORD2, status: 'pending', depositAmount: 0 });
  const r5 = await fern(() => commercial.runOrderUpdate(deps(db), identity('94', 'orders.update'), { id: run, expectedRevision: orev(db, run), orderDate: '2026-10-19' }));
  ok(r5.ok && s(db, 'SELECT order_date FROM orders WHERE id = ?', [run]) === '2026-10-19' && auditOf(db, run).length === 0,
    `K4b laufender Auftrag: Datum über den bisherigen Weg (${r5.code})`);
}

// ══ K4c — Werkstatt-Auswahl: Lohn und Gold nur Werkstätten (Auftrag); Reparaturen und Steine unverändert ═══════════
{
  const oc = src('src/pages/orders/OrderCreate.tsx'), am = src('src/components/work-orders/AddMaterialModal.tsx');
  const od = src('src/pages/orders/OrderDetail.tsx'), rd = src('src/pages/repairs/RepairDetail.tsx'), rq = src('src/components/repairs/RepairQuickEditModal.tsx');
  ok((oc.match(/\.\.\.workshopOptions\(suppliers as unknown as WorkshopCandidate\[\], \[(goldsmithSupplierId|extraGoldSupplierId)\]\)/g) || []).length === 2
    && !/suppliers\.filter\(s => s\.active\)\.map/.test(oc), 'K4c Order anlegen: SOURCE (Lohn) und GOLD SOURCE zeigen nur Werkstätten');
  ok(/workshopOnlyKinds=\{\['labor', 'gold'\]\}/.test(od) && /workshopOnlyKinds=\{\['labor', 'gold'\]\}/.test(oc)
    && !/workshopOnlyKinds/.test(rd) && !/workshopOnlyKinds/.test(rq),
    'K4c „Add Cost" des Auftrags: Lohn/Gold nur Werkstätten; Reparaturen setzen den Filter nicht');
  ok(/const nurWerkstatt = !!workshopOnlyKinds\?\.includes\(kind\)/.test(am) && /suppliers\.filter\(s => s\.active\)\.map/.test(am),
    'K4c der Dialog filtert nur für die genannten Arten — sonst alle aktiven Lieferanten (Steine, Diamanten, Reparatur)');
  const { workshopOptions } = await import('../../src/core/repairs/repair-workshop-choice.ts');
  const opts = workshopOptions([
    { id: 'a', name: 'Arup', active: true, isWorkshop: true }, { id: 'g', name: 'Gold Bazaar', active: true, isWorkshop: false },
    { id: 'x', name: 'Alt', active: false, isWorkshop: true },
  ], ['g']);
  ok(S(opts.map((o) => o.label)) === S(['Gold Bazaar (not marked as workshop)', 'Arup']),
    `K4c nur Werkstätten; ein schon gespeicherter anderer Lieferant bleibt sichtbar und benannt (${S(opts.map((o) => o.label))})`);
}

// ══ OF3 — Kosten des Sonderstücks, die nicht im Lager gebucht sind: Rechnung und Storno-ins-Lager sagen Nein ═══════
{
  const db = freshDb();
  // Eigene Arbeit (ohne Werkstatt) 30 + Goldschuld bei Arup: der Lohn bucht nichts.
  const oid = anlegen({ ...ORD2, goldsmithSupplierId: '', laborCost: 30, depositAmount: 100, paymentMethod: 'benefit' });
  const own = rows(db, "SELECT id, supplier_id, expense_id, cost_amount FROM order_lines WHERE order_id = ? AND material_kind = 'labor'", [oid])[0];
  ok(own && !own.supplier_id && !own.expense_id && Number(own.cost_amount) === 30, `OF3 Ausgang: eigener Lohn 30 ohne Buchung (${S(own)})`);
  ok(S(costBooking.unbookedOrderCosts(oid).map((c) => c.amount)) === S([30]), 'OF3 erkannt: nur der eigene Lohn ist nicht im Lager (die Goldschuld ist bewertet)');
  const stand = () => S({ i: n(db, 'SELECT COUNT(*) FROM invoices'), p: n(db, 'SELECT COUNT(*) FROM products'), l: n(db, 'SELECT COUNT(*) FROM ledger_entries'),
    a: n(db, 'SELECT COUNT(*) FROM order_deposit_applications'), sq: rows(db, 'SELECT stem, next_number FROM sku_sequences') });
  const vor = stand();
  const m = (() => { try { umwandeln(oid); return ''; } catch (e) { return `${codeOf(e)}|${(e as Error).message}`; } })();
  ok(m.startsWith('CUSTOM_COSTS_NOT_BOOKED|') && /30\.000 BHD/.test(m) && /Nothing was changed/.test(m) && stand() === vor,
    `OF3 Primary: Rechnung abgelehnt, nichts geschrieben (${m.slice(0, 160)})`);
  const line = customLineOf(db, oid);
  const rP = await fern(() => fin.runConvertOrder(deps(db), identity('95', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: orev(db, oid), taxSchemes: { [line]: 'ZERO' }, invoiceDate: '2026-11-01' }));
  ok(!rP.ok && /CUSTOM_COSTS_NOT_BOOKED/.test(rP.code) && stand() === vor, `OF3 PC2: dasselbe Nein (${rP.code})`);
  // Altweg (alte Order ohne Steuerart): dasselbe.
  db.run('UPDATE order_lines SET tax_scheme = NULL WHERE order_id = ? AND is_customer_facing = 1', [oid]);
  reload();
  ok(nein(() => umwandeln(oid, { legacyScheme: 'ZERO' })) === 'CUSTOM_COSTS_NOT_BOOKED' && stand() === vor, 'OF3 Altweg: dasselbe Nein');
  db.run("UPDATE order_lines SET tax_scheme = 'ZERO' WHERE order_id = ? AND is_customer_facing = 1", [oid]);
  reload();
  // Die eigene Zeile entfernen → Rechnung geht; Wareneinsatz = gebuchter Lagerwert (Lager danach 0).
  imHaus(() => goldHouse.removeOrderCostInHouse(ACTOR, { orderId: oid, lineId: String(own.id) }));
  reload();
  ok(saldo(db, 'INVENTORY') === 185, `OF3 vor der Rechnung: Lager 185 (nur die Goldschuld) (${saldo(db, 'INVENTORY')})`);
  const out = umwandeln(oid, { taxSchemes: { [line]: 'ZERO' } });
  ok(saldo(db, 'INVENTORY') === 0 && saldo(db, 'COGS') === 185 && n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]) === 185,
    `OF3 danach: Rechnung zum gebuchten Einstand 185, Lager 0, nie negativ (${saldo(db, 'INVENTORY')} / ${saldo(db, 'COGS')})`);
  ok(buchAusgeglichen(db), 'OF3 Hauptbuch ausgeglichen');
}
{
  // ORD-2-Form: Lohn bei Arup + Goldschuld bei Arup — beides gebucht → Rechnung geht, Lager genau 0, Wareneinsatz 210.
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 240, paymentMethod: 'benefit' });
  ok(costBooking.unbookedOrderCosts(oid).length === 0 && saldo(db, 'INVENTORY') === 210, `OF3 ORD-2-Form: alles im Lager gebucht (210) (${saldo(db, 'INVENTORY')})`);
  const out = umwandeln(oid, { taxSchemes: { [customLineOf(db, oid)]: 'ZERO' }, invoiceDate: '2026-10-25' });
  const inv = rows(db, 'SELECT gross_amount, paid_amount, status, substr(issued_at, 1, 10) AS tag FROM invoices WHERE id = ?', [out.invoiceId])[0];
  ok(saldo(db, 'INVENTORY') === 0 && saldo(db, 'COGS') === 210 && Number(inv.gross_amount) === 240 && Number(inv.paid_amount) === 240 && inv.tag === '2026-10-25',
    `OF3 ORD-2-Form: Rechnung 240 am 25.10., voll angerechnet, Wareneinsatz 210, Lager 0 (${S(inv)})`);
  ok(saldo(db, 'MARGIN_VAT') === 0 && saldo(db, 'OUTPUT_VAT') === 0 && n(db, 'SELECT vat_amount FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]) === 0,
    'OF3 ORD-2-Form: Zero, keine VAT');
  ok(buchAusgeglichen(db), 'OF3 ORD-2-Form Hauptbuch ausgeglichen');
}
{
  // K5-Vorbereitung: der Zahlweg der Lieferantenschuld ist ein Ausgaben-Zahlweg — eine Kartenanzahlung ('card') wird 'bank'.
  const db = freshDb();
  const oid = anlegen({ ...ORD2, status: 'pending', depositAmount: 0 });
  db.run("UPDATE orders SET payment_method = 'card' WHERE id = ?", [oid]);
  reload();
  imHaus(() => goldHouse.addOrderCostInHouse(ACTOR, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Setting', totalCost: 20, supplierId: 'sup-arup' }] }));
  const m = s(db, "SELECT e.payment_method FROM expenses e JOIN order_lines l ON l.expense_id = e.id WHERE l.order_id = ? AND l.description = 'Setting'", [oid]);
  ok(m === 'bank', `Lohn-A/P einer Order mit Kartenanzahlung: Zahlweg bank, nicht card (${m})`);
  db.run("UPDATE orders SET payment_method = 'cash' WHERE id = ?", [oid]);
  reload();
  imHaus(() => goldHouse.addOrderCostInHouse(ACTOR, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Polish', totalCost: 5, supplierId: 'sup-arup' }] }));
  ok(s(db, "SELECT e.payment_method FROM expenses e JOIN order_lines l ON l.expense_id = e.id WHERE l.order_id = ? AND l.description = 'Polish'", [oid]) === 'cash',
    'ein gültiger Zahlweg der Order (cash) bleibt');
}
{
  // Vor K5 (Altbestand ohne K1-Buchungen): Lohn ohne A/P, Gold ohne Buchwert → die Rechnung sagt Nein, statt COGS 210 ohne Lager.
  const db = freshDb();
  const oid = anlegen({ ...ORD2, status: 'pending', depositAmount: 0 });
  db.run("UPDATE order_lines SET status = 'DELIVERED' WHERE order_id = ?", [oid]);
  db.run("UPDATE orders SET status = 'completed' WHERE id = ?", [oid]);
  reload();
  ok(S(costBooking.unbookedOrderCosts(oid).map((c) => c.kind).sort()) === S(['gold', 'labor']) && saldo(db, 'INVENTORY') === 0,
    'OF3 Altbestand wie ORD-2 heute: Lohn und Gold nicht im Lager');
  ok(nein(() => umwandeln(oid, { taxSchemes: { [customLineOf(db, oid)]: 'ZERO' } })) === 'CUSTOM_COSTS_NOT_BOOKED' && n(db, 'SELECT COUNT(*) FROM invoices') === 0,
    'OF3 ohne Korrektur keine Rechnung (kein Wareneinsatz gegen nie gebuchtes Lager)');
  imHaus(() => useOrderStore.getState().commitOrderLineExpenses(oid, { bookingDate: '2026-10-25' }));
  reload();
  ok(costBooking.unbookedOrderCosts(oid).length === 0 && saldo(db, 'INVENTORY') === 210, 'OF3 nach der einmaligen Buchung (wie K5): Lager 210, Rechnung möglich');
}
{
  // Storno ins Lager: mit eigenem Lohn → Nein (vor dem Schreiben); ohne ihn → Lagerartikel zum gebuchten Einstand.
  const db = freshDb();
  const oid = anlegen({ ...ORD2, status: 'pending', depositAmount: 0, goldsmithSupplierId: 'sup-arup', laborCost: 25 });
  imHaus(() => goldHouse.addOrderCostInHouse(ACTOR, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Polish (own)', totalCost: 12, supplierId: '__INHOUSE__' }] }));
  imHaus(() => goldHouse.addOrderCostInHouse(ACTOR, { orderId: oid, rows: [{ materialKind: 'labor', description: 'Setting', totalCost: 20, supplierId: 'sup-arup' }] }));
  reload();
  const vor = S({ p: n(db, 'SELECT COUNT(*) FROM products'), l: n(db, 'SELECT COUNT(*) FROM ledger_entries'), s: s(db, 'SELECT status FROM orders WHERE id = ?', [oid]) });
  const c = nein(() => imHaus(() => lifecycleHouse.cancelOrderInHouse({ orderId: oid, choice: 'forfeit' }, 'branch-main')));
  ok(c === 'CUSTOM_COSTS_NOT_BOOKED' && S({ p: n(db, 'SELECT COUNT(*) FROM products'), l: n(db, 'SELECT COUNT(*) FROM ledger_entries'), s: s(db, 'SELECT status FROM orders WHERE id = ?', [oid]) }) === vor,
    `OF3 Storno ins Lager mit eigenem Lohn: Nein, nichts geschrieben (${c})`);
  const ownId = s(db, "SELECT id FROM order_lines WHERE order_id = ? AND description = 'Polish (own)'", [oid]);
  imHaus(() => goldHouse.removeOrderCostInHouse(ACTOR, { orderId: oid, lineId: ownId }));
  reload();
  const fx = imHaus(() => lifecycleHouse.cancelOrderInHouse({ orderId: oid, choice: 'forfeit' }, 'branch-main'));
  reload();
  const stock = fx.stockProductId ? rows(db, 'SELECT purchase_price, stock_status FROM products WHERE id = ?', [fx.stockProductId])[0] : null;
  ok(stock && Number(stock.purchase_price) === r3(saldo(db, 'INVENTORY')) && Number(stock.purchase_price) === 20,
    `OF3 ohne eigene Kosten: Lagerartikel zum gebuchten Einstand = Lager (${S(stock)} / ${saldo(db, 'INVENTORY')})`);
  // Nur eigene Kosten (nichts gebucht): der Storno legt kein Stück an — kein Nein nötig.
  const oid2 = anlegen({ ...ORD2, status: 'pending', depositAmount: 0, goldsmithSupplierId: '', laborCost: 0, extraGoldGrams: 0, extraGoldCost: 0 });
  imHaus(() => goldHouse.addOrderCostInHouse(ACTOR, { orderId: oid2, rows: [{ materialKind: 'labor', description: 'Own only', totalCost: 9, supplierId: '__INHOUSE__' }] }));
  reload();
  const fx2 = imHaus(() => lifecycleHouse.cancelOrderInHouse({ orderId: oid2, choice: 'forfeit' }, 'branch-main'));
  ok(!fx2.stockProductId && s(db, 'SELECT status FROM orders WHERE id = ?', [oid2]) === 'cancelled', 'OF3 nur eigene Kosten: Storno geht, kein Lagerartikel');
  ok(buchAusgeglichen(db), 'OF3 Storno Hauptbuch ausgeglichen');
  ok(/data-order-own-cost-warning/.test(src('src/pages/orders/OrderCreate.tsx')) && /data-material-own-cost-warning/.test(src('src/components/work-orders/AddMaterialModal.tsx')),
    'OF3 die Maske sagt es schon bei der Eingabe (eigene Kosten ohne Werkstatt)');
}

// ══ OF5a — Retoure nach getrennt gebuchter Goldschuld-Differenz: Nein; nach Rücknahme der Begleichung geht sie ═══════
setOpeningCutoffForTest('2026-01-01');
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, orderDate: '2026-09-01', depositAmount: 240, paymentMethod: 'benefit' });
  const out = umwandeln(oid, { invoiceDate: '2026-09-10', taxSchemes: { [customLineOf(db, oid)]: 'MARGIN' } });
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('q3r','branch-main',2026,3,?,'{}',?)", [NOW, NOW]);
  const res = settle(payableOf(db, oid), 4.33, 44);
  ok(res.costMode === 'SEPARATE', `OF5a Ausgang: Begleichung nach Quartalsabschluss getrennt (${res.costMode})`);
  const il = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]);
  const stand = () => S({ r: n(db, 'SELECT COUNT(*) FROM sales_returns'), l: n(db, 'SELECT COUNT(*) FROM ledger_entries'), p: s(db, 'SELECT stock_status FROM products WHERE id = ?', [out.productIds[0]]) });
  const vor = stand();
  const input = { invoiceId: out.invoiceId, lines: [{ invoiceLineId: il, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'Test', refundNow: false } as never;
  const c = nein(() => imHaus(() => createReturnInHouse(input, 'branch-main')));
  ok(c === 'RETURN_GOLD_SETTLED_SEPARATELY' && stand() === vor, `OF5a Primary: Retoure abgelehnt, nichts geschrieben (${c})`);
  const rP = await fern(() => returnCmd.runCreateReturn(deps(db), identity('96', 'returns.create'),
    { ...(input as object), expectedRevision: n(db, 'SELECT revision FROM invoices WHERE id = ?', [out.invoiceId]) }));
  ok(!rP.ok && rP.code === 'RETURN_GOLD_SETTLED_SEPARATELY' && stand() === vor, `OF5a PC2: dasselbe Nein (${rP.code})`);
  // Nach der Rücknahme der Begleichung (offene Periode heute) geht die Retoure; das Stück kehrt zum Einstand zurück.
  imHaus(() => goldSettle.reverseOrderGoldSettlement(ACTOR, s(db, 'SELECT id FROM gold_payable_settlements')));
  reload();
  const ret = imHaus(() => createReturnInHouse(input, 'branch-main'));
  reload();
  ok(!!ret.returnId && saldo(db, 'COGS') === 0 && saldo(db, 'INVENTORY') === 210,
    `OF5a nach Rücknahme: Retoure geht, Wareneinsatz 0, Lager 210 (= Einstand) (${saldo(db, 'COGS')} / ${saldo(db, 'INVENTORY')})`);
  ok(buchAusgeglichen(db), 'OF5a Hauptbuch ausgeglichen');
}
{
  // Berichtigt im offenen Quartal (INVOICE): keine getrennte Differenz → Retoure wie bisher, Lager zum berichtigten Einstand.
  const db = freshDb();
  const oid = anlegen({ ...ORD2, orderDate: '2026-09-01', depositAmount: 240, paymentMethod: 'benefit' });
  const out = umwandeln(oid, { invoiceDate: '2026-09-10', taxSchemes: { [customLineOf(db, oid)]: 'MARGIN' } });
  ok(settle(payableOf(db, oid), 4.33, 44).costMode === 'INVOICE', 'OF5a offenes Quartal: Rechnung berichtigt');
  const il = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]);
  const ret = imHaus(() => createReturnInHouse({ invoiceId: out.invoiceId, lines: [{ invoiceLineId: il, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'T', refundNow: false } as never, 'branch-main'));
  reload();
  ok(!!ret.returnId && saldo(db, 'COGS') === 0 && saldo(db, 'INVENTORY') === 215.52, `OF5a berichtigte Rechnung: Retoure wie bisher, Lager 215,520 (${saldo(db, 'INVENTORY')})`);
}
setOpeningCutoffForTest(null);

console.log(`\nCUSTOM-ORDER Abschluss: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
