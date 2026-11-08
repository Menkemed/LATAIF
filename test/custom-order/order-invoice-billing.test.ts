// ════════════════════════════════════════════════════════════════════════════
// ORDER ↔ INVOICE (v0.8.99) — nach der Umwandlung zeigt die Order Betrag und Zahlstand ihrer Rechnung.
// Run: node test/custom-order/order-invoice-billing.test.ts
//
//   §1 unbezahlte Order → Rechnung → Teilzahlung (Partially Paid) → Vollzahlung (Paid)
//   §2 Rechnungspreis geändert ⇒ Order zeigt neuen Betrag und offenen Saldo; Auftragspreis bleibt ursprünglich
//   §3 vorhandene Anzahlung angerechnet, nicht doppelt gezählt
//   §4 nach Neustart (neu geöffnete Datenbank) derselbe Stand
//   §5 Storno der Rechnung: kein Paid, Anzahlung wieder offen
//   §6 rein: Zeilenbrutto, Teilumwandlung, Rückzahlung, Gutschrift, Überzahlung
//   §7 Quelltext: Liste, Detail und PC2 lesen denselben Stand
// Gerüst wie test/custom-order/phase1-k1-k2.test.ts (echte Datenbank, Stores, Hausfolgen, Hauptbuch).
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


// ════════════════════════════════════════════════════════════════════════════
// ORDER ↔ INVOICE — die Prüfungen dieses Laufs
// ════════════════════════════════════════════════════════════════════════════
const { orderPaidTotalsFor } = await import('../../src/core/data/page-reads.ts');
const { orderBillingOf, orderLineGross } = await import('../../src/core/orders/order-billing.ts');
const CTX = { branchId: 'branch-main', tenantId: 'tenant-1', userId: 'user-test', role: 'ADMIN' };
type Bill = import('../../src/core/orders/order-billing.ts').OrderBilling;
const stand = (oid: string): Bill | undefined => orderPaidTotalsFor(CTX as never).billing?.find((b) => b.orderId === oid);
const kurz = (b: Bill | undefined): string => S(b ? [b.status, b.total, b.paid, b.remaining, b.originalPrice] : null);
const zahlen = (invoiceId: string, betrag: number): void => { imHaus(() => useInvoiceStore.getState().recordPayment(invoiceId, betrag, 'cash')); reload(); };

// ══ §1 Unbezahlte Order → Rechnung → Teilzahlung → Vollzahlung ═══════════════════════════════════════
{
  freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const vorher = orderPaidTotalsFor(CTX as never);
  ok(!(vorher.billing ?? []).some((b) => b.orderId === oid), '§1 vor der Umwandlung: kein Rechnungsstand, die Order rechnet wie bisher');
  const out = umwandeln(oid);
  ok(kurz(stand(oid)) === S(['UNPAID', 240, 0, 240, 240]) && stand(oid)?.fullyInvoiced === true && stand(oid)?.payInvoiceId === out.invoiceId,
    `§1 umgewandelt, unbezahlt: Unpaid, Betrag 240, offen 240, Zahlung gehört auf die Rechnung (${kurz(stand(oid))})`);
  zahlen(out.invoiceId, 100);
  ok(kurz(stand(oid)) === S(['PARTIALLY_PAID', 240, 100, 140, 240]), `§1 Teilzahlung 100 auf der Rechnung ⇒ Order Partially Paid, offen 140 (${kurz(stand(oid))})`);
  zahlen(out.invoiceId, 140);
  ok(kurz(stand(oid)) === S(['PAID', 240, 240, 0, 240]) && !stand(oid)?.payInvoiceId,
    `§1 Rest 140 bezahlt ⇒ Order Paid, offen 0 (${kurz(stand(oid))})`);
}

// ══ §2 Preis der Rechnung geändert ⇒ Order zeigt den neuen Betrag, der Auftragspreis bleibt der ursprüngliche ═══════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const out = umwandeln(oid);
  const z = rows(db, 'SELECT id, product_id, lot_id, quantity, unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])[0];
  imHaus(() => useInvoiceStore.getState().editInvoice(out.invoiceId, {
    lines: [{ lineId: String(z.id), productId: String(z.product_id), lotId: z.lot_id ? String(z.lot_id) : undefined, quantity: 1, unitPrice: 300,
      purchasePrice: Number(z.purchase_price_snapshot), taxScheme: String(z.tax_scheme), vatRate: Number(z.vat_rate), vatAmount: 0, lineTotal: 300 }],
    reason: 'Preis mit dem Kunden neu vereinbart',
  } as never));
  reload();
  ok(Number(one(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [out.invoiceId])) === 300 && kurz(stand(oid)) === S(['UNPAID', 300, 0, 300, 240]),
    `§2 Rechnung 240 → 300: Order zeigt Betrag 300, offen 300, ursprünglich 240 (${kurz(stand(oid))})`);
  ok(Number(one(db, 'SELECT agreed_price FROM orders WHERE id = ?', [oid])) === 240, '§2 der Auftragspreis selbst bleibt 240 (nichts an der Order geschrieben)');
  zahlen(out.invoiceId, 100);
  ok(kurz(stand(oid)) === S(['PARTIALLY_PAID', 300, 100, 200, 240]), `§2 Teilzahlung 100 ⇒ offen 200 (${kurz(stand(oid))})`);
  // Preis wieder gesenkt (unter das Bezahlte nicht nötig): 300 → 150 bei 100 bezahlt ⇒ offen 50.
  const z2 = rows(db, 'SELECT id, product_id, lot_id, purchase_price_snapshot, tax_scheme, vat_rate FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])[0];
  imHaus(() => useInvoiceStore.getState().editInvoice(out.invoiceId, {
    lines: [{ lineId: String(z2.id), productId: String(z2.product_id), lotId: z2.lot_id ? String(z2.lot_id) : undefined, quantity: 1, unitPrice: 150,
      purchasePrice: Number(z2.purchase_price_snapshot), taxScheme: String(z2.tax_scheme), vatRate: Number(z2.vat_rate), vatAmount: 0, lineTotal: 150 }],
    reason: 'Rabatt',
  } as never));
  reload();
  ok(kurz(stand(oid)) === S(['PARTIALLY_PAID', 150, 100, 50, 240]), `§2 Rechnung 300 → 150 bei 100 bezahlt ⇒ offen 50 (${kurz(stand(oid))})`);
}

// ══ §3 Vorhandene Anzahlung: angerechnet, nicht doppelt ═════════════════════════════════════════════
{
  const db = freshDb();
  const voll = anlegen(ORD2);   // Anzahlung 240 = Preis
  const outV = umwandeln(voll);
  ok(kurz(stand(voll)) === S(['PAID', 240, 240, 0, 240]) && Number(one(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [outV.invoiceId])) === 240,
    `§3 volle Anzahlung 240: Order Paid, bezahlt 240 — nicht 480 (${kurz(stand(voll))})`);
}
{
  freshDb();
  const teil = anlegen({ ...ORD2, depositAmount: 100 });
  const out = umwandeln(teil);
  ok(kurz(stand(teil)) === S(['PARTIALLY_PAID', 240, 100, 140, 240]), `§3 Anzahlung 100 angerechnet: Partially Paid, offen 140 (${kurz(stand(teil))})`);
  zahlen(out.invoiceId, 140);
  ok(kurz(stand(teil)) === S(['PAID', 240, 240, 0, 240]), `§3 Rest auf der Rechnung bezahlt ⇒ Paid, bezahlt 240 (Anzahlung einmal) (${kurz(stand(teil))})`);
}

// ══ §4 Nach Neustart derselbe Stand (alles aus der Datenbank gelesen, nichts im Speicher) ═══════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 100 });
  umwandeln(oid);
  const vorher = kurz(stand(oid));
  const bytes = (db as unknown as { export(): Uint8Array }).export();
  const neu = new SQL.Database(bytes) as unknown as Db;
  resetDurabilityStateForTest(); resetTransactionHealthForTest();
  setTestDatabase(neu as never); installWriteGuard(neu as never); reload();
  ok(kurz(stand(oid)) === vorher && vorher === S(['PARTIALLY_PAID', 240, 100, 140, 240]), `§4 nach Neustart (neu geöffnete Datenbank) derselbe Stand (${vorher} / ${kurz(stand(oid))})`);
}

// ══ §5 Storno der Rechnung: kein „Paid" aus einer stornierten Rechnung; die Anzahlung ist wieder offen ════════════
{
  freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 100 });
  const out = umwandeln(oid);
  imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: out.invoiceId, refundMethod: 'cash' } as never, 'branch-main'));
  reload();
  const t = orderPaidTotalsFor(CTX as never);
  ok(!stand(oid) && t.totals.find((x) => x.orderId === oid)?.paid === 100,
    `§5 Rechnung storniert: kein Rechnungsstand mehr, die Order zeigt wieder ihre offene Anzahlung 100 (${S(t.totals)})`);
}

// ══ §6 Rein: Zeilenbrutto, Teilumwandlung, Rückzahlung, Gutschrift — kein falsches „Paid" ══════════════════════
{
  ok(orderLineGross({ unitPrice: 100, quantity: 2, taxScheme: 'VAT_10' }) === 220 && orderLineGross({ unitPrice: 240, quantity: 1, taxScheme: 'VAT_10', materialKind: 'custom' }) === 240
    && orderLineGross({ unitPrice: 50, quantity: 1, taxScheme: 'MARGIN' }) === 50, '§6 Zeilenbrutto wie die Umwandlung (VAT 10 % aufgeschlagen, Sonderstück brutto, Margin netto = brutto)');
  const inv = (gross: number, paid: number, cc = 0) => ({ invoiceId: 'i', invoiceNumber: 'INV-1', status: 'PARTIAL', gross, paid, creditCancel: cc });
  const teil = orderBillingOf({ orderId: 'o', agreedPrice: 500, openDeposits: 50, invoices: [inv(300, 300)], uninvoicedGross: 200, lineLinked: true });
  ok(S([teil.status, teil.total, teil.paid, teil.remaining, teil.fullyInvoiced]) === S(['PARTIALLY_PAID', 500, 350, 150, false]),
    `§6 Teilumwandlung: Rechnung 300 bezahlt + Rest 200 mit offener Anzahlung 50 ⇒ offen 150, Order-Anzahlung weiter möglich (${S(teil)})`);
  const alt = orderBillingOf({ orderId: 'o', agreedPrice: 500, openDeposits: 0, invoices: [inv(500, 500)], uninvoicedGross: 500, lineLinked: false });
  ok(alt.status === 'PAID' && alt.total === 500, '§6 Altauftrag (nur Kopf verknüpft): gilt als ganz berechnet, kein doppelter Rest');
  const rueck = orderBillingOf({ orderId: 'o', agreedPrice: 240, openDeposits: 0, invoices: [inv(240, 140)], uninvoicedGross: 0, lineLinked: true });
  ok(rueck.status === 'PARTIALLY_PAID' && rueck.remaining === 100, '§6 Rückzahlung (Rechnung nur noch 140 bezahlt) ⇒ nicht Paid, offen 100');
  const gut = orderBillingOf({ orderId: 'o', agreedPrice: 240, openDeposits: 0, invoices: [inv(240, 0, 240)], uninvoicedGross: 0, lineLinked: true });
  ok(gut.status === 'UNPAID' && gut.remaining === 0, '§6 Gutschrift über alles, nichts bezahlt ⇒ nichts offen, aber kein „Paid"');
  const ueber = orderBillingOf({ orderId: 'o', agreedPrice: 240, openDeposits: 0, invoices: [inv(200, 240)], uninvoicedGross: 0, lineLinked: true });
  ok(ueber.status === 'PAID' && ueber.paid === 200 && ueber.remaining === 0, '§6 Überzahlung zählt höchstens den Rechnungsbetrag (Rest ist Kundenguthaben)');
}

// ══ §7 Quelltext: Liste, Detail und PC2 lesen denselben Stand ═════════════════════════════════════
{
  const liste = src('src/pages/orders/OrderList.tsx');
  const detail = src('src/pages/orders/OrderDetail.tsx');
  ok(/billingByOrder/.test(liste) && /billing \? billing\.status : deriveOrderPaymentStatus/.test(liste) && /navigate\(`\/invoices\/\$\{billing\.payInvoiceId\}`\)/.test(liste),
    '§7 Liste: Betrag/Zahlstand aus der Rechnung; ganz berechnet ⇒ „Pay invoice" statt neuer Anzahlung');
  ok(/useSharedRead\('page\.order_list\.get', \{\}, orderPaidTotalsFor/.test(detail) && /billing\?\.fullyInvoiced/.test(detail) && /AGREED PRICE \(ORIGINAL\)/.test(detail),
    '§7 Detail: derselbe Lesebefehl, Auftragspreis als Originalwert, Zahlung auf der Rechnung');
  ok(/OP_PAGE_ORDER_LIST_GET[\s\S]{0,300}orderPaidTotalsFor\(ctx\)/.test(src('src/core/bridge/store-read-commands.ts')),
    '§7 PC2: der Lesebefehl liefert dieselbe Funktion (inkl. Rechnungsstand)');
}

console.log(fails.length ? `\nFAIL — order invoice billing: ${PASS} passed, ${fails.length} failed` : `\nPASS — order invoice billing: ${PASS} passed, 0 failed`);
if (fails.length) process.exit(1);
