// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Phase 1 — K1 (Einstand, Lohn-A/P, Goldschuld-Wert) und K2 (Create Invoice atomar, Anrechnung der
// Anzahlung). Echte sql.js-Datenbank (schema.sql + echte Migrationen), echte Stores, echte Hausfolgen, echtes
// Hauptbuch, echte Fernbefehle. Run: node --experimental-strip-types test/custom-order/phase1-k1-k2.test.ts
//
//   A  K1 als „completed" angelegt (ORD-2-Fall): Lohn Soll INVENTORY / Haben AP, Goldwert Soll INVENTORY / Haben
//      GOLD_LIABILITY, beide am Order-Datum, genau einmal (zweiter Lauf ohne Wirkung), Fertigstellung gesetzt
//   B  K1 pending → arrived (PC2) bucht einmal; → completed bucht nichts doppelt
//   C  K1 stornierte Kostenzeile zählt nicht; entfernte Gold-Zeile nimmt ihren Wert zurück; Add Cost bucht den Wert
//   D  K1 Storno der Order: angekommenes Gold bleibt Schuld + Wert, Lagerartikel mit echtem Einstand
//   E  K2 Umwandlung am Primary: Datum, Zero (Satz 0), Brutto 240, Artikel mit SKU/Kategorie/Verknüpfung, COGS 210,
//      INVENTORY der Order 0, Anzahlung ANGERECHNET (Datum/Karte/Gebühr/Banking unverändert, keine Neubuchung)
//   F  K2 Storno → Anzahlung wieder offen; erneute Umwandlung: derselbe Artikel, keine Barzahlung, keine Doppelung
//   G  K2 ohne Anzahlung: offene Rechnung; Altauftrag mit Kopf-Anzahlung ohne Zahlungszeile: Nein
//   H  K2 Brutto bleibt bei VAT 10 % / Margin; Margin-VAT aus dem Einstand
//   I  K2 Fehler mittendrin (VAT-Quartal zu): keine Rechnung, kein Artikel, keine Anrechnung
//   J  K2 PC2 `orders.convert_to_invoice` mit Sonderstück und Rechnungsdatum (dieselbe Wirkung); Überzahlung → Guthaben
//   L  Hauptbuch-Audit: jede Klammer ausgeglichen, Soll = Haben gesamt
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

// ══ A — K1: als „completed" angelegt ═════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen(ORD2);
  const exp = rows(db, `SELECT id, category, amount, expense_date, supplier_id, status FROM expenses WHERE related_module = 'order' AND category = 'Inventory'`);
  ok(exp.length === 1 && Number(exp[0].amount) === 25 && exp[0].expense_date === '2026-10-25' && exp[0].supplier_id === 'sup-arup',
    `A Lohn 25 genau einmal als Lieferantenschuld, Tag 25.10. (${S(exp)})`);
  const expId = String(exp[0]?.id);
  ok(saldo(db, 'INVENTORY', "source_module = 'EXPENSE' AND source_id = ?", [expId]) === 25
    && saldo(db, 'ACCOUNTS_PAYABLE', "source_module = 'EXPENSE' AND source_id = ? AND counterparty_id = 'sup-arup'", [expId]) === -25
    && saldo(db, 'EXPENSES_OPERATING', "source_module = 'EXPENSE' AND source_id = ?", [expId]) === 0,
  'A Lohn: Soll INVENTORY / Haben AP (Arup), kein Betriebsaufwand');
  const gp = rows(db, 'SELECT id, book_value, book_value_date, status, weight_grams, karat FROM gold_payables WHERE source_order_id = ?', [oid])[0];
  ok(gp && Number(gp.book_value) === 185 && gp.book_value_date === '2026-10-25' && gp.status === 'OPEN' && Number(gp.weight_grams) === 4.33,
    `A Goldschuld 4.330 g 21K mit Wert 185 am 25.10. (${S(gp)})`);
  const gpId = String(gp?.id);
  ok(saldo(db, 'INVENTORY', "source_module = 'GOLD_PAYABLE' AND source_id = ?", [gpId]) === 185
    && saldo(db, 'GOLD_LIABILITY', "source_module = 'GOLD_PAYABLE' AND counterparty_id = 'sup-arup'") === -185,
  'A Goldwert: Soll INVENTORY / Haben GOLD_LIABILITY (Arup)');
  ok(s(db, "SELECT substr(occurred_at,1,10) FROM ledger_entries WHERE source_module = 'GOLD_PAYABLE' LIMIT 1") === '2026-10-25',
    'A Goldwert gebucht am Order-Datum');
  ok(s(db, 'SELECT actual_delivery FROM orders WHERE id = ?', [oid]) === '2026-10-25', 'A Fertigstellung = Order-Datum');
  const vorher = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  imHaus(() => useOrderStore.getState().commitOrderLineExpenses(oid, { bookingDate: '2026-10-25' }));
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === vorher && n(db, "SELECT COUNT(*) FROM expenses WHERE related_module = 'order' AND category = 'Inventory'") === 1,
    'A zweiter Lauf: keine zweite Schuld, keine zweite Buchung');
  ok(saldo(db, 'INVENTORY') === 210, `A Lager der Order 210 bis zum Verkauf (${saldo(db, 'INVENTORY')})`);
  // Stichtag: ein Datum vor dem Eröffnungsstichtag wird vor jedem Schreiben abgelehnt.
  const vorStichtag = nein(() => imHaus(() => orderHouse.createOrderInHouse({ ...ORD2, orderDate: '2026-10-01' }, 'branch-main')));
  ok(vorStichtag === 'CORRECTION_BEFORE_OPENING_CUTOFF' && n(db, 'SELECT COUNT(*) FROM orders') === 1,
    `A Order-Datum vor dem Stichtag: Nein, nichts angelegt (${vorStichtag})`);
  ok(buchAusgeglichen(db), 'A Hauptbuch ausgeglichen');
}

// ══ B — K1: pending → arrived (PC2) → completed ══════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, status: 'pending', depositAmount: 0 });
  ok(n(db, "SELECT COUNT(*) FROM expenses WHERE related_module = 'order'") === 0 && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'GOLD_PAYABLE'") === 0,
    'B pending: noch keine Schuld, kein Goldwert');
  const a = await fern(() => life.runUpdateOrderStatus(deps(db), identity('10', 'orders.update_status'), { orderId: oid, status: 'arrived', expectedRevision: orev(db, oid) }));
  ok(a.ok && n(db, "SELECT COUNT(*) FROM expenses WHERE related_module = 'order' AND category = 'Inventory'") === 1
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'GOLD_PAYABLE'") === 2,
  `B arrived (PC2): Lohn + Goldwert je einmal (${a.code})`);
  await fern(() => life.runUpdateOrderStatus(deps(db), identity('11', 'orders.update_status'), { orderId: oid, status: 'notified', expectedRevision: orev(db, oid) }));
  const c = await fern(() => life.runUpdateOrderStatus(deps(db), identity('12', 'orders.update_status'), { orderId: oid, status: 'completed', expectedRevision: orev(db, oid) }));
  ok(c.ok && n(db, "SELECT COUNT(*) FROM expenses WHERE related_module = 'order' AND category = 'Inventory'") === 1
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'GOLD_PAYABLE'") === 2 && saldo(db, 'INVENTORY') === 210,
  `B completed: nichts doppelt, Lager 210 (${c.code})`);
}

// ══ C — K1: stornierte Zeile, entfernte Gold-Zeile, Add Cost ════════════════════════
{
  ok(orderCustomCostBasis([{ costAmount: 25, status: 'DELIVERED' }, { costAmount: 185, status: 'DELIVERED' }, { costAmount: 99, status: 'CANCELLED' }] as never) === 210,
    'C eine stornierte Kostenzeile ist kein Einstand mehr');
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0, status: 'arrived' });
  const goldLine = String(one(db, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'gold'", [oid]));
  imHaus(() => goldHouse.removeOrderCostInHouse(ACTOR, { orderId: oid, lineId: goldLine }));
  ok(n(db, 'SELECT COUNT(*) FROM gold_payables WHERE source_order_id = ?', [oid]) === 0 && saldo(db, 'GOLD_LIABILITY') === 0 && saldo(db, 'INVENTORY') === 25,
    `C Gold-Zeile entfernt: Schuld und Wert weg, Lager nur noch Lohn (${saldo(db, 'INVENTORY')})`);
  imHaus(() => goldHouse.addOrderCostInHouse(ACTOR, { orderId: oid, rows: [{ materialKind: 'gold', description: 'Gold 2g', weightGrams: 2, karat: '18K', totalCost: 70, supplierId: 'sup-arup' }] }));
  const gp2 = rows(db, 'SELECT id, book_value, status FROM gold_payables WHERE source_order_id = ?', [oid]);
  ok(gp2.length === 1 && Number(gp2[0].book_value) === 70 && saldo(db, 'GOLD_LIABILITY') === -70 && saldo(db, 'INVENTORY') === 95,
    `C Add Cost (Gold vom Goldschmied): Wert 70 sofort gebucht (${S(gp2)})`);
  ok(buchAusgeglichen(db), 'C Hauptbuch ausgeglichen');
}

// ══ D — K1: Storno der Order ════════════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0, status: 'arrived' });
  imHaus(() => lifeHouse.cancelOrderInHouse({ orderId: oid, choice: 'forfeit', expectedRevision: orev(db, oid) } as never, 'branch-main'));
  reload();
  const gp = rows(db, 'SELECT status, book_value FROM gold_payables WHERE source_order_id = ?', [oid])[0];
  const prod = rows(db, "SELECT purchase_price, stock_status FROM products WHERE notes LIKE '%From cancelled custom order%'")[0];
  ok(gp?.status === 'OPEN' && Number(gp.book_value) === 185 && saldo(db, 'GOLD_LIABILITY') === -185,
    `D angekommenes Gold bleibt Schuld mit Wert (${S(gp)})`);
  ok(prod && Number(prod.purchase_price) === 210 && prod.stock_status === 'in_stock',
    `D Lagerartikel mit dem gebuchten Einstand 210 (${S(prod)})`);
}

// ══ E — K2: Umwandlung am Primary (ORD-2) ═══════════════════════════════════════════
let orderE = '';
{
  const db = freshDb();
  const oid = anlegen(ORD2);
  orderE = oid;
  const feeVorher = rows(db, "SELECT id, amount, status, expense_date FROM expenses WHERE category = 'CardFees'");
  const opVorher = rows(db, "SELECT id FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT'").length;
  const out = umwandeln(oid);
  const inv = rows(db, 'SELECT id, issued_at, gross_amount, vat_amount, vat_rate_snapshot, status, paid_amount, tax_scheme_snapshot FROM invoices WHERE id = ?', [out.invoiceId])[0];
  ok(String(inv?.issued_at).startsWith('2026-11-01') && Number(inv.gross_amount) === 240 && Number(inv.vat_amount) === 0 && Number(inv.vat_rate_snapshot) === 0,
    `E Rechnung am gewählten Tag, Zero: Brutto 240, VAT 0, Satz 0 (${S(inv)})`);
  const prod = rows(db, 'SELECT id, sku, category_id, purchase_price, stock_status FROM products WHERE id = ?', [out.productIds[0]])[0];
  // CUSTOM-ORDER Review (Owner) — ein Sonderstück hat keine Marke („Custom Order" ist seine Herkunft): ITM + Kategorie (GLD) + Zähler.
  ok(prod && /^ITM-GLD-\d{3,}$/.test(String(prod.sku)) && prod.category_id === 'cat-gold-jewelry' && Number(prod.purchase_price) === 210,
    `E Artikel: SKU aus dem Zähler, Kategorie der Order, Einstand 210 (${S(prod)})`);
  ok(s(db, 'SELECT product_id FROM orders WHERE id = ?', [oid]) === prod?.id
    && s(db, "SELECT product_id FROM order_lines WHERE order_id = ? AND material_kind = 'custom'", [oid]) === prod?.id,
  'E Artikel an Order und Order-Zeile gebunden');
  ok(saldo(db, 'COGS') === 210 && saldo(db, 'INVENTORY') === 0, `E Wareneinsatz 210 genau einmal, Lager danach 0 (${saldo(db, 'COGS')}/${saldo(db, 'INVENTORY')})`);
  const pays = rows(db, 'SELECT method, amount, card_brand FROM payments WHERE invoice_id = ?', [out.invoiceId]);
  ok(pays.length === 1 && pays[0].method === 'order_deposit' && Number(pays[0].amount) === 240 && !pays[0].card_brand,
    `E Anzahlung angerechnet: eine Zahlung 'order_deposit' 240 (${S(pays)})`);
  ok(inv.status === 'FINAL' && Number(inv.paid_amount) === 240, 'E Rechnung voll bezahlt');
  ok(saldo(db, 'CUSTOMER_DEPOSITS') === 0 && saldo(db, 'ACCOUNTS_RECEIVABLE') === 0 && saldo(db, 'CASH') === 0,
    `E Kundenanzahlung 0, Forderung 0, keine Kasse (${saldo(db, 'CUSTOMER_DEPOSITS')}/${saldo(db, 'ACCOUNTS_RECEIVABLE')}/${saldo(db, 'CASH')})`);
  const feeNachher = rows(db, "SELECT id, amount, status, expense_date FROM expenses WHERE category = 'CardFees'");
  ok(S(feeNachher) === S(feeVorher) && feeVorher.length === 1, `E Kartengebühr unverändert, keine neue (${S(feeNachher)})`);
  ok(rows(db, "SELECT id FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT'").length === opVorher
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT' AND reverses_entry_id IS NOT NULL") === 0,
  'E der Geldeingang der Anzahlung wurde NICHT zurückgedreht');
  const op = rows(db, 'SELECT paid_at, method, converted_to_invoice FROM order_payments WHERE order_id = ?', [oid])[0];
  ok(op?.paid_at === '2026-10-25' && op.method === 'card' && Number(op.converted_to_invoice) === 1, `E Order-Zahlung: Tag und Art erhalten, angerechnet (${S(op)})`);
  const bank = loadBankingFor({ branchId: 'branch-main', tenantId: 'tenant-1', userId: 'user-test', role: 'ADMIN' } as never).transactions as unknown as Array<{ id: string; date: string; relatedModule?: string }>;
  const opRows = bank.filter((t) => t.relatedModule === 'order');
  const depPayIds = rows(db, "SELECT id FROM payments WHERE method = 'order_deposit'").map((x) => String(x.id));
  const invRows = bank.filter((t) => depPayIds.some((pid) => String(t.id).includes(pid)));
  ok(opRows.length === 1 && opRows[0].date === '2026-10-25' && invRows.length === 0,
    `E Banking: der Eingang einmal am 25.10., die Anrechnung nicht (${S(opRows.map((t) => t.date))})`);
  ok(Number(one(db, 'SELECT deposit_date FROM orders WHERE id = ?', [oid])) !== 0 && s(db, 'SELECT deposit_date FROM orders WHERE id = ?', [oid]) === '2026-10-25',
    'E Kopf „Deposit date" = Tag der Zahlung');
  const recon = reconciliationSnapshotFor({ branchId: 'branch-main', tenantId: 'tenant-1', userId: 'user-test', role: 'ADMIN' } as never)
    .rows.find((r: { account: string }) => r.account === 'CUSTOMER_DEPOSITS') as { ledger: number; domain: number } | undefined;
  ok(!recon || Math.abs(recon.ledger - recon.domain) < 0.0005, `E Abstimmung Kundenanzahlungen Buch = Domäne (${S(recon)})`);
  ok(buchAusgeglichen(db), 'E Hauptbuch ausgeglichen');
}

// ══ F — K2: Storno und erneute Umwandlung (Teilanzahlung, damit die Rechnung stornierbar ist) ═══════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 100, paymentMethod: 'benefit' });
  const first = umwandeln(oid);
  ok(s(db, 'SELECT status FROM invoices WHERE id = ?', [first.invoiceId]) !== 'FINAL' && n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [first.invoiceId]) === 100,
    'F Rechnung mit Teilanzahlung 100 (nicht FINAL)');
  imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: first.invoiceId, refundMethod: 'cash' } as never, 'branch-main'));
  reload();
  ok(s(db, 'SELECT status FROM invoices WHERE id = ?', [first.invoiceId]) === 'CANCELLED', 'F Rechnung storniert');
  ok(n(db, "SELECT COUNT(*) FROM order_deposit_applications WHERE status = 'ACTIVE'") === 0
    && n(db, 'SELECT converted_to_invoice FROM order_payments WHERE order_id = ?', [oid]) === 0,
  'F Anrechnung zurückgenommen, Order-Zahlung wieder offen');
  ok(saldo(db, 'CUSTOMER_DEPOSITS') === -100 && saldo(db, 'CASH') === 0 && saldo(db, 'BENEFIT') === 100,
    `F die 100 liegen wieder als Anzahlung bei der Order; nichts ausgezahlt (${saldo(db, 'CUSTOMER_DEPOSITS')}/${saldo(db, 'CASH')}/${saldo(db, 'BENEFIT')})`);
  useOrderPaymentStore.getState().loadPayments(oid);
  ok(useOrderPaymentStore.getState().totalPaid(oid) === 100, 'F Order zeigt 100 offen');
  const produkte = n(db, 'SELECT COUNT(*) FROM products');
  const second = umwandeln(oid);
  ok(n(db, 'SELECT COUNT(*) FROM products') === produkte && second.productIds[0] === first.productIds[0],
    'F erneute Umwandlung: DERSELBE Artikel, kein zweiter');
  const pays = rows(db, 'SELECT method, amount FROM payments WHERE invoice_id = ?', [second.invoiceId]);
  ok(pays.length === 1 && pays[0].method === 'order_deposit' && Number(pays[0].amount) === 100 && saldo(db, 'CASH') === 0,
    `F keine erfundene Barzahlung — dieselbe Anzahlung erneut angerechnet (${S(pays)})`);
  ok(n(db, "SELECT COUNT(*) FROM order_deposit_applications WHERE status = 'ACTIVE'") === 1, 'F genau eine aktive Anrechnung');
  ok(saldo(db, 'COGS') === 210 && saldo(db, 'INVENTORY') === 0, `F Wareneinsatz netto einmal (${saldo(db, 'COGS')}/${saldo(db, 'INVENTORY')})`);
  ok(buchAusgeglichen(db), 'F Hauptbuch ausgeglichen');
}

// ══ G — K2: ohne Anzahlung; Altauftrag ═══════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const out = umwandeln(oid);
  ok(n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [out.invoiceId]) === 0 && n(db, 'SELECT COUNT(*) FROM payments') === 0
    && saldo(db, 'ACCOUNTS_RECEIVABLE') === 240,
  'G ohne Anzahlung: offene Rechnung über 240, keine Zahlung');
  const db2 = freshDb();
  const alt = anlegen({ ...ORD2, depositAmount: 0 });
  db2.run('UPDATE orders SET deposit_amount = 50, deposit_paid = 1 WHERE id = ?', [alt]);
  reload();
  const r = nein(() => umwandeln(alt));
  ok(r === 'ORDER_DEPOSIT_WITHOUT_PAYMENT' && n(db2, 'SELECT COUNT(*) FROM invoices') === 0 && n(db2, "SELECT COUNT(*) FROM products WHERE category_id = 'cat-gold-jewelry'") === 0,
    `G Kopf-Anzahlung ohne Zahlungszeile: Nein, nichts angelegt (${r})`);
}

// ══ G2 — K2: Rechnungstag VOR dem Zahltag der Anzahlung → angerechnet wird am Zahltag ═══════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 100, paymentMethod: 'benefit' });
  const paid = s(db, 'SELECT paid_at FROM order_payments WHERE order_id = ?', [oid]).slice(0, 10);
  const out = umwandeln(oid, { invoiceDate: '2026-10-24' });
  const pay = rows(db, 'SELECT received_at FROM payments WHERE invoice_id = ?', [out.invoiceId])[0];
  const app = rows(db, 'SELECT applied_at FROM order_deposit_applications WHERE invoice_id = ?', [out.invoiceId])[0];
  ok(paid === '2026-10-25' && s(db, 'SELECT substr(issued_at, 1, 10) FROM invoices WHERE id = ?', [out.invoiceId]) === '2026-10-24'
    && String(pay?.received_at ?? '').slice(0, 10) === '2026-10-25' && String(app?.applied_at ?? '').slice(0, 10) === '2026-10-25',
  `G2 Rechnung am 24.10., Anrechnung am Zahltag 25.10. — nie vor dem Geldeingang (${S(pay)} / ${S(app)})`);
  ok(buchAusgeglichen(db) && saldo(db, 'CUSTOMER_DEPOSITS') === 0, 'G2 Hauptbuch ausgeglichen, Anzahlungsschuld aufgelöst');
}
// ══ H — K2: Brutto bleibt bei jeder Steuerart ════════════════════════════════════════
for (const [scheme, vat, rate] of [['VAT_10', 21.818, 10], ['MARGIN', 2.727, 10]] as const) {
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const line = String(one(db, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'custom'", [oid]));
  const out = umwandeln(oid, { taxSchemes: { [line]: scheme } });
  const il = rows(db, 'SELECT line_total, vat_amount, tax_scheme, vat_rate, purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])[0];
  ok(Number(il.line_total) === 240 && r3(Number(il.vat_amount)) === vat && il.tax_scheme === scheme && Number(il.vat_rate) === rate && Number(il.purchase_price_snapshot) === 210,
    `H ${scheme}: Brutto 240, VAT ${vat} (${S(il)})`);
}

// ══ I — K2: Fehler mittendrin ════════════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen(ORD2);
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('f1','branch-main',2026,4,?,'{}',?)", [NOW, NOW]);
  const vorher = { p: n(db, 'SELECT COUNT(*) FROM products'), l: n(db, 'SELECT COUNT(*) FROM ledger_entries') };
  const r = nein(() => umwandeln(oid));
  ok(/VAT_PERIOD_FILED/.test(r) && n(db, 'SELECT COUNT(*) FROM invoices') === 0 && n(db, 'SELECT COUNT(*) FROM products') === vorher.p
    && n(db, 'SELECT COUNT(*) FROM ledger_entries') === vorher.l && n(db, 'SELECT COUNT(*) FROM order_deposit_applications') === 0
    && !s(db, 'SELECT product_id FROM orders WHERE id = ?', [oid]),
  `I VAT-Quartal zu: keine Rechnung, kein Artikel, keine Buchung, keine Anrechnung (${r})`);
}

// ══ J — K2: PC2 und Überzahlung ══════════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 300, paymentMethod: 'benefit' });
  ok(n(db, "SELECT COALESCE(SUM(amount),0) FROM customer_credits WHERE source_type = 'order_overpayment' AND status = 'OPEN'") === 60,
    'J Überzahlung 60 liegt vor der Umwandlung als Order-Guthaben');
  const r = await fern(() => fin.runConvertOrder(deps(db), identity('20', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: orev(db, oid), invoiceDate: '2026-11-02' }));
  ok(r.ok, `J PC2: Sonderstück umgewandelt (${r.code})`);
  const invId = String(r.value?.invoiceId ?? '');
  ok(s(db, 'SELECT substr(issued_at,1,10) FROM invoices WHERE id = ?', [invId]) === '2026-11-02'
    && /^ITM-GLD-\d{3,}$/.test(s(db, 'SELECT p.sku FROM products p JOIN orders o ON o.product_id = p.id WHERE o.id = ?', [oid])),
  'J PC2: Rechnungsdatum und Artikel mit SKU wie am Primary');
  const credits = rows(db, "SELECT source_type, amount, status FROM customer_credits WHERE status = 'OPEN'");
  ok(credits.length === 1 && credits[0].source_type === 'overpayment' && Number(credits[0].amount) === 60
    && saldo(db, 'CUSTOMER_CREDIT') === -60 && saldo(db, 'CUSTOMER_DEPOSITS') === 0 && saldo(db, 'ACCOUNTS_RECEIVABLE') === 0,
  `J Überzahlung: genau EIN Guthaben 60 (aus der Anrechnung), Anzahlung 0, Forderung 0 (${S(credits)})`);
  const bad = await fern(() => fin.runConvertOrder(deps(db), identity('21', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: orev(db, oid), invoiceDate: '2099-01-01' }));
  ok(!bad.ok, `J PC2: künftiges Rechnungsdatum abgelehnt (${bad.code})`);
  ok(buchAusgeglichen(db), 'J Hauptbuch ausgeglichen');
}

// ══ K — Pins ═════════════════════════════════════════════════════════════════════════
{
  const od = src('src/pages/orders/OrderDetail.tsx');
  ok(/convertOrderToInvoiceInHouse\(/.test(od) && /runOnPrimary\(/.test(od), 'K Primary nutzt die Hausfolge in einer Klammer');
  ok(/convertOrderToInvoiceInHouse\(/.test(src('src/core/bridge/financial-commands.ts')), 'K PC2 nutzt dieselbe Hausfolge');
  ok(!/markConvertedToInvoice\(/.test(src('src/core/orders/order-payment-carryover.ts')), 'K kein Zurückdrehen der Anzahlung mehr');
}

console.log(`\nCUSTOM-ORDER Phase 1 K1/K2: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
