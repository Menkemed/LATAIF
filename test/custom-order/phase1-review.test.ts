// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Phase 1 — Review-Findings: SKU/Herkunft, Altweg, Brutto normaler Zeilen, Goldschuld nach Quartalsabschluss,
// PC2-Liste/Rücknahme, Zahlart-Beschriftung + Banking, Return gold (Forderung ≠ Schuld).
// Run: node --experimental-strip-types test/custom-order/phase1-review.test.ts
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

// ══ R1 — SKU ITM-GLD und dauerhafte Herkunft (auch nach Storno; PC2 sieht dasselbe) ═══════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 100, paymentMethod: 'benefit' });
  const nr = s(db, 'SELECT order_number FROM orders WHERE id = ?', [oid]);
  const first = umwandeln(oid);
  const pid = first.productIds[0];
  const p = rows(db, 'SELECT sku, brand, origin_type, origin_order_id, origin_order_number FROM products WHERE id = ?', [pid])[0];
  ok(p.sku === 'ITM-GLD-001' && p.origin_type === 'CUSTOM_ORDER' && p.origin_order_id === oid && p.origin_order_number === nr,
    `R1 Artikel: SKU ITM-GLD-001, Herkunft Custom Order ${nr} am Artikel gespeichert (${S(p)})`);
  const o1 = productOriginOf(pid);
  ok(o1 && o1.type === 'CUSTOM_ORDER' && o1.orderNumber === nr && o1.invoices.length === 1 && o1.invoices[0].invoiceId === first.invoiceId,
    `R1 Artikelseite: Herkunft mit Rechnung (${S(o1)})`);
  cancelInv(first.invoiceId);
  const o2 = productOriginOf(pid);
  ok(o2 && o2.orderNumber === nr && o2.invoices.length === 1 && o2.invoices[0].status === 'CANCELLED',
    `R1 nach Rechnungsstorno: Herkunft bleibt, die stornierte Rechnung steht da (${S(o2)})`);
  useProductStore.getState().updateProduct(pid, { notes: 'umbenannt', name: 'Ring neu' } as never);
  const second = umwandeln(oid);
  const p2 = rows(db, 'SELECT sku, origin_type, origin_order_id, origin_order_number FROM products WHERE id = ?', [pid])[0];
  ok(second.productIds[0] === pid && p2.sku === 'ITM-GLD-001' && p2.origin_order_number === nr && n(db, 'SELECT COUNT(*) FROM products') === 1,
    `R1 erneute Umwandlung: derselbe Artikel, SKU und Herkunft unverändert, kein zweiter (${S(p2)})`);
  const o3 = productOriginOf(pid);
  ok(o3 && o3.invoices.length === 2 && o3.invoices.some((i) => i.status === 'CANCELLED') && o3.invoices.some((i) => i.invoiceId === second.invoiceId),
    'R1 Artikelseite: beide Rechnungen (storniert + neu)');
  const fern = await executeCommand('page.product_detail.get', { actor: PC2_ACTOR, input: { productId: pid } }, undefined) as { kind: string; value?: { data?: { origin?: unknown } } };
  ok(fern.kind === 'ok' && S(fern.value?.data?.origin) === S(o3), `R1 PC2 (page.product_detail.get): dieselbe Herkunft (${S(fern.value?.data?.origin).slice(0, 120)})`);
  // Eine in der Order eingetragene, schon vergebene SKU: Nein vor jedem Schreiben.
  // (Die Order-Anlage prüft eine eingetragene SKU schon selbst; hier wurde sie danach vergeben — z. B. Altbestand.)
  const oid2 = anlegen({ ...ORD2, depositAmount: 0 });
  db.run('UPDATE orders SET custom_product_spec = ? WHERE id = ?', [JSON.stringify({ ...SPEC, sku: 'ITM-GLD-001' }), oid2]);
  reload();
  const vor = { i: n(db, 'SELECT COUNT(*) FROM invoices'), p: n(db, 'SELECT COUNT(*) FROM products'), l: n(db, 'SELECT COUNT(*) FROM ledger_entries') };
  const r = nein(() => umwandeln(oid2));
  ok(r === 'SKU_TAKEN' && n(db, 'SELECT COUNT(*) FROM invoices') === vor.i && n(db, 'SELECT COUNT(*) FROM products') === vor.p && n(db, 'SELECT COUNT(*) FROM ledger_entries') === vor.l,
    `R1 vergebene SKU an der Order: Nein, nichts geschrieben (${r})`);
  const oid3 = anlegen({ ...ORD2, depositAmount: 0 });
  const third = umwandeln(oid3);
  ok(s(db, 'SELECT sku FROM products WHERE id = ?', [third.productIds[0]]) === 'ITM-GLD-002', 'R1 das nächste Sonderstück: ITM-GLD-002 (zentraler Zähler)');
  ok(buchAusgeglichen(db), 'R1 Hauptbuch ausgeglichen');
}

// ══ R2 — Altweg (Order ohne Steuerart je Position): kein Artikel vor dem Dialog, alles in EINER Klammer ═══════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 100, paymentMethod: 'benefit' });
  db.run('UPDATE order_lines SET tax_scheme = NULL WHERE order_id = ?', [oid]);
  reload();
  ok(n(db, 'SELECT COUNT(*) FROM products') === 0, 'R2 vorher: kein Artikel');
  const line = customLineOf(db, oid);
  ok(nein(() => umwandeln(oid, { legacyScheme: 'MARGIN', taxSchemes: { [line]: 'MARGIN' } })) === 'ORDER_CONVERT_MODE_INVALID', 'R2 Altweg und Steuerart je Zeile zugleich: Nein');
  // Fehler mittendrin (VAT-Quartal zu): nichts bleibt — auch kein Artikel.
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('fx','branch-main',2026,4,?,'{}',?)", [NOW, NOW]);
  const f = nein(() => umwandeln(oid, { legacyScheme: 'MARGIN' }));
  ok(/VAT_PERIOD_FILED|filed/i.test(f) && n(db, 'SELECT COUNT(*) FROM products') === 0 && n(db, 'SELECT COUNT(*) FROM invoices') === 0,
    `R2 Fehler in der Klammer: kein Artikel, keine Rechnung (${f.slice(0, 40)})`);
  db.run("DELETE FROM vat_filings WHERE id = 'fx'");
  const out = umwandeln(oid, { legacyScheme: 'MARGIN', specialMark: false });
  const inv = rows(db, 'SELECT gross_amount, paid_amount, status FROM invoices WHERE id = ?', [out.invoiceId])[0];
  const il = rows(db, 'SELECT tax_scheme, line_total, purchase_price_snapshot, product_id FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]);
  const p = rows(db, 'SELECT sku, origin_type, origin_order_id FROM products')[0];
  ok(il.length === 1 && il[0].tax_scheme === 'MARGIN' && Number(il[0].line_total) === 240 && Number(il[0].purchase_price_snapshot) === 210
    && Number(inv.gross_amount) === 240 && Number(inv.paid_amount) === 100,
    `R2 eine Zeile über den vereinbarten Preis 240, Margin, Einstand 210, Anzahlung 100 angerechnet (${S(il)} / ${S(inv)})`);
  ok(n(db, 'SELECT COUNT(*) FROM products') === 1 && p.sku === 'ITM-GLD-001' && p.origin_type === 'CUSTOM_ORDER' && p.origin_order_id === oid
    && s(db, 'SELECT product_id FROM order_lines WHERE id = ?', [line]) === il[0].product_id,
    `R2 Artikel erst in der Klammer: SKU, Herkunft, Sonderstück-Zeile verknüpft (${S(p)})`);
  ok(saldo(db, 'CUSTOMER_DEPOSITS') === 0 && saldo(db, 'ACCOUNTS_RECEIVABLE') === 140 && saldo(db, 'CASH') === 0, 'R2 Anrechnung ohne Geldbewegung, Rest 140 offen');
  cancelInv(out.invoiceId);
  const again = umwandeln(oid, { legacyScheme: 'ZERO' });
  ok(again.productIds[0] === out.productIds[0] && n(db, 'SELECT COUNT(*) FROM products') === 1
    && n(db, "SELECT COUNT(*) FROM order_deposit_applications WHERE status = 'ACTIVE'") === 1 && n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [again.invoiceId]) === 100,
    'R2 Storno + erneut: derselbe Artikel, die Anzahlung genau einmal angerechnet');
  ok(buchAusgeglichen(db), 'R2 Hauptbuch ausgeglichen');
  // Ohne Anzahlung: offene Rechnung. PC2: dieselbe Hausfolge.
  const oid2 = anlegen({ ...ORD2, depositAmount: 0 });
  db.run('UPDATE order_lines SET tax_scheme = NULL WHERE order_id = ?', [oid2]);
  reload();
  const r = await fern(() => fin.runConvertOrder(deps(db), identity('70', 'orders.convert_to_invoice'),
    { orderId: oid2, expectedRevision: orev(db, oid2), legacyScheme: 'ZERO', invoiceDate: '2026-11-02' }));
  const inv2 = r.ok ? rows(db, 'SELECT gross_amount, paid_amount, substr(issued_at, 1, 10) AS tag FROM invoices WHERE id = ?', [String(r.value?.invoiceId)])[0] : null;
  ok(r.ok && inv2 && Number(inv2.gross_amount) === 240 && Number(inv2.paid_amount) === 0 && inv2.tag === '2026-11-02',
    `R2 PC2 Altweg ohne Anzahlung: offene Rechnung 240 am gewählten Tag (${r.code} ${S(inv2)})`);
  let beides = '';
  try { fin.parseConvertOrder({ orderId: 'o', expectedRevision: 1, legacyScheme: 'ZERO', taxSchemes: { a: 'ZERO' } }); } catch (e) { beides = (e as Error).message; }
  ok(/taxSchemes and legacyScheme/.test(beides),
    'R2 PC2-Rumpf: beides zugleich ist ein Nein');
  const oid3 = anlegen({ ...ORD2, depositAmount: 0 });
  ok(nein(() => umwandeln(oid3, { legacyScheme: 'ZERO' })) === 'ORDER_HAS_TAX_SCHEMES', 'R2 eine Order MIT Steuerart je Zeile geht nicht den Altweg');
  const ui = src('src/pages/orders/OrderDetail.tsx');
  ok(!/createProduct\(/.test(ui) && !/convertOrderLinesToInvoiceTx|executeLegacyFinalInvoice|adoptOrderPhotosToProduct/.test(ui) && /legacyScheme/.test(ui),
    'R2 die Ansicht legt keinen Artikel mehr an — sie schickt die Absicht (auch den Altweg) an die Hausfolge');
}

// ══ R3 — Brutto bei normalen Artikelzeilen: unverändert ohne Wechsel, gleich mit Wechsel ════════════════
{
  const prod = { id: 'p1', purchasePrice: 200 } as never;
  const auftrag = { id: 'o', orderNumber: 'O-1' } as never;
  const zeile = (scheme: string, unitPrice: number) => ({ id: 'l1', productId: 'p1', quantity: 1, unitPrice, taxScheme: scheme, isCustomerFacing: true }) as never;
  const bau = (scheme: string, unitPrice: number, neu?: string) => buildOrderInvoiceLines({
    order: auftrag, billableLines: [zeile(scheme, unitPrice)], perLineSchemes: neu ? { l1: neu } as never : undefined,
    customCostBasis: 0, findProduct: () => prod, createProduct: () => prod,
  })[0];
  const a = bau('VAT_10', 300);
  ok(r3(a.lineTotal) === 330 && r3(a.vatAmount) === 30 && r3(a.unitPrice) === 300, `R3 VAT 10 % ohne Wechsel wie bisher: 300 + 30 = 330 (${S(a)})`);
  const b = bau('VAT_10', 300, 'MARGIN');
  ok(r3(b.lineTotal) === 330 && r3(b.vatAmount) === 11.818, `R3 VAT 10 % → Margin: Brutto bleibt 330, Margin-VAT aus 330 − 200 (${S(b)})`);
  const c = bau('VAT_10', 300, 'ZERO');
  ok(r3(c.lineTotal) === 330 && r3(c.vatAmount) === 0, `R3 VAT 10 % → Zero: Brutto bleibt 330 (${S(c)})`);
  const d = bau('MARGIN', 500, 'VAT_10');
  ok(r3(d.lineTotal) === 500 && r3(d.vatAmount) === 45.455 && r3(d.unitPrice) === 454.545, `R3 Margin → VAT 10 %: Brutto bleibt 500, VAT herausgerechnet (${S(d)})`);
  const e = bau('ZERO', 400, 'MARGIN');
  ok(r3(e.lineTotal) === 400 && r3(e.vatAmount) === 18.182, `R3 Zero → Margin: Brutto bleibt 400 (${S(e)})`);
  const g = bau('MARGIN', 500);
  ok(r3(g.lineTotal) === 500 && r3(g.vatAmount) === 27.273, `R3 Margin ohne Wechsel wie bisher (${S(g)})`);
}

// ══ R4 — Goldschuld nach Abschluss des Rechnungsquartals: Differenz in der offenen Periode, Rechnung unverändert ═══
setOpeningCutoffForTest('2026-01-01');
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, orderDate: '2026-09-01', depositAmount: 0 });
  const line = customLineOf(db, oid);
  const out = umwandeln(oid, { invoiceDate: '2026-09-10', taxSchemes: { [line]: 'MARGIN' } });
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('q3','branch-main',2026,3,?,'{}',?)", [NOW, NOW]);
  const ilId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]);
  const fpVor = S(vatFingerprint(out.invoiceId));
  const q3Vor = S(liveVatQuarters('branch-main').get('2026-Q3'));
  const pid = payableOf(db, oid);
  // In das gemeldete Quartal zurückdatiert: Nein (die Sperre bleibt).
  ok(/VAT_PERIOD_FILED|filed/i.test(nein(() => settle(pid, 1, 44, '2026-09-20'))), 'R4 Begleichung im gemeldeten Quartal: Nein');
  const res = settle(pid, 4.33, 44);
  ok(res.costMode === 'SEPARATE' && !res.invoiceLineCorrected && res.difference === 5.52, `R4 heute (offen): erlaubt, Differenz +5,520 getrennt (${S(res)})`);
  const il = rows(db, 'SELECT purchase_price_snapshot, vat_amount FROM invoice_lines WHERE id = ?', [ilId])[0];
  ok(Number(il.purchase_price_snapshot) === 210 && r3(Number(il.vat_amount)) === 2.727 && S(vatFingerprint(out.invoiceId)) === fpVor
    && S(liveVatQuarters('branch-main').get('2026-Q3')) === q3Vor,
    `R4 Rechnung, VAT-Fingerabdruck und gemeldetes Q3 unverändert (${S(il)})`);
  const diffRow = rows(db, `SELECT account, direction, amount, source_line_id, substr(occurred_at, 1, 7) AS m FROM ledger_entries
     WHERE source_module = 'EXPENSE' AND account = 'COGS'`)[0];
  ok(diffRow && Number(diffRow.amount) === 5.52 && diffRow.direction === 'DEBIT' && diffRow.source_line_id === ilId && diffRow.m === new Date().toISOString().slice(0, 7),
    `R4 Differenz im Wareneinsatz der offenen Periode, der Rechnungszeile zugeordnet (${S(diffRow)})`);
  ok(saldo(db, 'COGS') === 215.52 && saldo(db, 'INVENTORY') === 0 && saldo(db, 'GOLD_LIABILITY') === 0 && saldo(db, 'MARGIN_VAT') === -2.727,
    `R4 Hauptbuch: COGS 215,520, Lager 0, Goldschuld 0, Margin-VAT unverändert 2,727 (${saldo(db, 'COGS')})`);
  const st = rows(db, 'SELECT cost_mode, vat_status, old_vat_amount, new_vat_amount, invoice_line_id FROM gold_payable_settlements')[0];
  ok(st.cost_mode === 'SEPARATE' && st.vat_status === 'REVIEW' && r3(Number(st.old_vat_amount)) === 2.727 && r3(Number(st.new_vat_amount)) === 2.225 && st.invoice_line_id === ilId,
    `R4 Begleichung: VAT-Wirkung nur geschätzt (2,727 → 2,225), REVIEW für den gesonderten Korrekturvorgang (${S(st)})`);
  const inv = loadInvoicesFor({ branchId: 'branch-main' } as never).invoices.find((i) => i.id === out.invoiceId)!;
  ok(r3(inv.costCorrection ?? 0) === 5.52 && r3(n(db, `SELECT ${invoiceCostCorrectionSql()} FROM invoices i WHERE i.id = ?`, [out.invoiceId])) === 5.52,
    'R4 Gewinnleser nehmen die Differenz dazu (dieselbe Stelle wie D1)');
  ok(r3(n(db, 'SELECT purchase_price FROM products WHERE id = ?', [out.productIds[0]])) === 215.52, 'R4 der Artikel trägt den tatsächlichen Einstand');
  ok(buchAusgeglichen(db), 'R4 Hauptbuch ausgeglichen');
  // Rücknahme: geht (nichts an der Rechnung) — alles wie vorher.
  const sid = s(db, 'SELECT id FROM gold_payable_settlements');
  imHaus(() => goldSettle.reverseOrderGoldSettlement(ACTOR, sid));
  reload();
  ok(saldo(db, 'COGS') === 210 && saldo(db, 'GOLD_LIABILITY') === -185 && s(db, 'SELECT status FROM gold_payable_settlements') === 'REVERSED'
    && r3(n(db, `SELECT ${invoiceCostCorrectionSql()} FROM invoices i WHERE i.id = ?`, [out.invoiceId])) === 0 && S(vatFingerprint(out.invoiceId)) === fpVor,
    'R4 Rücknahme: COGS 210, Goldschuld 185 offen, keine Korrektur mehr, Rechnung unverändert');
  // Rechnungsstorno (heute) nimmt eine getrennte Differenz mit: das Stück kehrt zum tatsächlichen Einstand zurück.
  settle(pid, 4.33, 44);
  cancelInv(out.invoiceId);
  const st2 = rows(db, "SELECT cost_mode, status FROM gold_payable_settlements WHERE status = 'ACTIVE'")[0];
  ok(st2.cost_mode === 'UNSOLD' && saldo(db, 'COGS') === 0 && saldo(db, 'INVENTORY') === 215.52
    && r3(n(db, 'SELECT purchase_price FROM products WHERE id = ?', [out.productIds[0]])) === 215.52,
    `R4 Storno der Rechnung: Differenz zurück ins Lager, Stück zu 215,520, COGS 0 (${S(st2)} / ${saldo(db, 'INVENTORY')})`);
  ok(buchAusgeglichen(db), 'R4 Hauptbuch nach Storno ausgeglichen');
}
{
  // Berichtigt im offenen Quartal, danach gemeldet: eine Rücknahme würde das Quartal ändern → Nein.
  const db = freshDb();
  const oid = anlegen({ ...ORD2, orderDate: '2026-09-01', depositAmount: 0 });
  const out = umwandeln(oid, { invoiceDate: '2026-09-10', taxSchemes: { [customLineOf(db, oid)]: 'MARGIN' } });
  const res = settle(payableOf(db, oid), 4.33, 44);
  ok(res.costMode === 'INVOICE' && n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]) === 215.52, 'R4b offenes Quartal: Rechnung berichtigt');
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('q3b','branch-main',2026,3,?,'{}',?)", [NOW, NOW]);
  const r = nein(() => imHaus(() => goldSettle.reverseOrderGoldSettlement(ACTOR, s(db, 'SELECT id FROM gold_payable_settlements'))));
  ok(r === 'SETTLEMENT_INVOICE_PERIOD_CLOSED' && s(db, 'SELECT status FROM gold_payable_settlements') === 'ACTIVE',
    `R4b danach gemeldet: Rücknahme abgelehnt, nichts geändert (${r})`);
}
setOpeningCutoffForTest(null);

// ══ R5 — PC2: Begleichungen sehen (store.gold.get) und zurücknehmen ═══════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const pid = payableOf(db, oid);
  settle(pid, 2, 44);
  useGoldStore.getState().loadGoldPayables();
  const lokal = useGoldStore.getState().orderGoldSettlements.filter((x) => x.payableId === pid && x.status === 'ACTIVE');
  const fern = await executeCommand('store.gold.get', { actor: PC2_ACTOR, input: {} }, undefined) as { kind: string; value?: { data?: { orderGoldSettlements?: unknown[] } } };
  const remote = (fern.value?.data?.orderGoldSettlements ?? []) as Array<{ id: string; payableId: string; status: string; costMode: string }>;
  ok(lokal.length === 1 && fern.kind === 'ok' && S(remote.filter((x) => x.payableId === pid)) === S(useGoldStore.getState().orderGoldSettlements.filter((x) => x.payableId === pid)),
    `R5 PC2 bekommt dieselben Begleichungen wie der Primary (${remote.length})`);
  const zur = await fern2(() => goldCmd.runGoldPayableSettle(deps(db), identity('80', 'gold.payables.settle'),
    { payableId: pid, expectedRevision: n(db, 'SELECT revision FROM gold_payables WHERE id = ?', [pid]), mode: 'money_order_reverse', settlementId: remote[0]?.id }));
  ok(zur.ok && s(db, 'SELECT status FROM gold_payable_settlements') === 'REVERSED' && saldo(db, 'GOLD_LIABILITY') === -185, `R5 PC2 nimmt zurück — dieselbe Hausfolge (${zur.code})`);
  const modal = src('src/components/gold/SettleOrderGoldModal.tsx');
  ok(/useGoldStore\(\(s\) => s\.orderGoldSettlements\)/.test(modal) && !/readsFromPrimary|activeOrderGoldSettlements|query\(/.test(modal),
    'R5 das Modal liest die Liste aus dem Gold-Bestand — Primary und PC2 gleich, keine eigene Abfrage');
}

// ══ R6 — Zahlart lesbar (NBR-Export, Rechnung); Banking ohne Geld-lose Zahlungen ═══════════════════════════
{
  ok(paymentMethodLabel('order_deposit') === 'Order deposit' && paymentMethodLabel('credit') === 'Store Credit'
    && paymentMethodLabel('bank_transfer') === 'Bank Transfer' && paymentMethodLabel('crypto') === 'Crypto', 'R6 Zahlart-Beschriftung an einer Stelle');
  ok(/paymentMethodLabel\(p\.method\)/.test(src('src/core/tax/nbr-export.ts')) && /paymentMethodLabel\(p\.method\)/.test(src('src/pages/invoices/InvoiceDetail.tsx')),
    'R6 NBR-Export und Rechnungsansicht nutzen sie (kein Rohwert „order_deposit")');
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const out = umwandeln(oid);
  for (const [id, method, amount] of [['pay-c', 'cash', 50], ['pay-k', 'credit', 30], ['pay-d', 'order_deposit', 20]] as const) {
    db.run('INSERT INTO payments (id, branch_id, invoice_id, amount, method, received_at, created_at) VALUES (?,?,?,?,?,?,?)', [id, 'branch-main', out.invoiceId, amount, method, NOW, NOW]);
  }
  const tx = loadBankingFor({ branchId: 'branch-main' } as never).transactions.map((t) => t.id);
  ok(tx.includes('pay-pay-c') && !tx.includes('pay-pay-k') && !tx.includes('pay-pay-d'),
    `R6 Banking: Barzahlung ja; Kundenguthaben-Verrechnung und Anzahlungs-Anrechnung nein (kein Geld) (${tx.filter((x) => x.startsWith('pay-')).join(',')})`);
}

// ══ R7 — Return gold: Forderung (unser Gold beim Goldschmied) ≠ Goldschuld ═══════════════════════════════════
{
  const db = freshDb();
  const claim = goldCore.insertGoldPayable('branch-main', { supplierId: 'sup-arup', weightGrams: 5, karat: '21K', direction: 'they_owe', settlementType: 'return_gold' });
  const debt = goldCore.insertGoldPayable('branch-main', { supplierId: 'sup-arup', weightGrams: 3, karat: '21K', direction: 'we_owe', settlementType: 'return_gold' });
  const bestand = goldCore.shopGoldStock('branch-main', '21K');
  const r1 = imHaus(() => goldCore.settleGoldPayable(ACTOR, { payableId: claim, mode: 'return_gold', grams: 2 }));
  ok(r1.fulfilledGrams === 2 && r1.openGrams === 3 && r1.status === 'OPEN' && r3(goldCore.shopGoldStock('branch-main', '21K') - bestand) === 2,
    `R7 der Goldschmied gibt 2 g UNSERES Golds zurück: seine Balance 5 → 3, unser Bestand +2 (${S(r1)})`);
  ok(S(rows(db, 'SELECT fulfilled_grams, status FROM gold_payables WHERE id = ?', [debt])[0]) === S({ fulfilled_grams: 0, status: 'OPEN' }),
    'R7 die Goldschuld bei derselben Werkstatt bleibt unverändert');
  for (const mode of ['money', 'shop_gold'] as const) {
    ok(nein(() => imHaus(() => goldCore.settleGoldPayable(ACTOR, { payableId: claim, mode, grams: 1, agreedBhd: 10 }))) === 'GOLD_CLAIM_RETURN_ONLY',
      `R7 unsere Forderung nicht per ${mode}`);
  }
  ok(nein(() => imHaus(() => goldCore.settleGoldPayable(ACTOR, { payableId: claim, mode: 'return_gold', grams: 4 }))) === 'GOLD_OVER_SETTLEMENT', 'R7 mehr zurück als offen: Nein');
  ok(nein(() => imHaus(() => goldCore.settleGoldPayable(ACTOR, { payableId: debt, mode: 'return_gold', grams: 1 }))) === 'GOLD_RETURN_NOT_A_SETTLEMENT',
    'R7 eine Goldschuld wird nie durch „Return gold" erfüllt');
  ok(S(rows(db, 'SELECT fulfilled_grams, status FROM gold_payables WHERE id = ?', [debt])[0]) === S({ fulfilled_grams: 0, status: 'OPEN' }), 'R7 …sie bleibt offen');
  const rd = src('src/pages/repairs/RepairDetail.tsx'), sd = src('src/pages/suppliers/SupplierDetail.tsx');
  ok(/gp\.direction === 'they_owe' && \(\s*<div[^>]*>\s*\{\/\*[^*]*\*\/\}\s*<button data-gold-settle-open="settle_supplier_return"/.test(rd)
    && /gp\.direction === 'they_owe' && \(\s*<button data-gold-settle-open="settle_supplier_return"/.test(sd),
    'R7 Oberfläche: „Return gold" nur bei unserer Forderung (Reparatur und Lieferant)');
}

console.log(`\nCUSTOM-ORDER Review: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
