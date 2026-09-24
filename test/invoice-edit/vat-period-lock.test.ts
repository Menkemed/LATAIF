// ════════════════════════════════════════════════════════════════════════════
// VAT-PERIOD-LOCK — ein als eingereicht markiertes Quartal ist zu; ein offenes bleibt frei.
// Q2/2026 wird eingereicht (Rechnung A, im Mai voll bezahlt); Q3 bleibt offen (Rechnung B).
// Run: node --experimental-strip-types test/invoice-edit/vat-period-lock.test.ts
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
// Der echte invoice.paid-Handler (registriert sich beim Laden des Moduls).
await import('../../src/core/automation/automation-handlers.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useProductionStore } = await import('../../src/stores/productionStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { convertTransferInHouse, undoTransferConversionInHouse } = await import('../../src/core/agents/transfer-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { STOCK_UNAVAILABLE_MESSAGE } = await import('../../src/core/lots/lot-availability.ts');
const { classifyLegacyInvoiceLines, LEGACY_STOCK_LINES_MESSAGE } = await import('../../src/core/lots/stock-contract.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-21T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({
    name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0,
  }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
}

/** Artikel: `lotQty` = Einkaufslos mit dieser Menge; null = ohne Los, Menge `manualQty`. */
function product(db: Db, id: string, lotQty: number | null, manualQty = 0, extra: { status?: string; source?: string } = {}): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
  [id, 'M ' + id, 'SKU-' + id, lotQty ?? manualQty, extra.status ?? 'in_stock', extra.source ?? 'OWN', NOW, NOW]);
  if (lotQty !== null) {
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,'branch-main',?,100,?,?,'ACTIVE',?,?)`, ['lot-' + id, id, lotQty, lotQty, NOW, NOW]);
  }
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
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const OWNER_ACTOR = { userId: 'user-test', role: 'ADMIN' };

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
async function imHausAsync<T>(fn: () => Promise<T>): Promise<T> {
  posting.beginLedgerTransaction();
  try { const out = await fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LINE = (productId: string, qty = 1, price = 1000) => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: (price * qty) / 10, lineTotal: price * qty * 1.1,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>, customerId = 'cust-1'): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, lines as never, 'SLI').id);
  reload();
  return id;
}
function voll(invId: string): string {
  const db = current();
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  const pay = imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
  return pay;
}
const lock = await import('../../src/core/tax/vat-period-lock.ts');
const { VAT_PERIOD_FILED, VAT_QUARTER_ALREADY_FILED, markVatQuarterFiled, vatFingerprint } = lock;
const { runInvoiceUpdate, runInvoicePayment } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const { runUpdatePayment, runDeletePayment } = await import('../../src/core/bridge/financial-commands.ts');
const { reverseInvoiceInHouse } = await import('../../src/core/invoices/invoice-reversal.ts');
const { CUSTOMER_CHANGE_VAT_FILED } = await import('../../src/core/invoices/customer-change.ts');
const { runCustomerUpdate } = await import('../../src/core/bridge/customer-commands.ts');
const { carryOverOrderPaymentsToInvoice, assertOrderCarryOverMayFinalize } = await import('../../src/core/orders/order-payment-carryover.ts');

void OWNER_ACTOR; void imHausAsync; void tick; void useConsignmentStore; void useProductionStore; void useAgentStore;
void cancelReturnHouse; void cancelInvoiceInHouse; void convertTransferInHouse; void undoTransferConversionInHouse;
void createProductionInHouse; void STOCK_UNAVAILABLE_MESSAGE; void classifyLegacyInvoiceLines; void LEGACY_STOCK_LINES_MESSAGE;
void eventBus; void useCreditNoteStore; void voll; void insert; void rechnung; void S;

const DB = freshDb();
const current = (): Db => DB;
void current;
product(DB, 'pA', 3);
product(DB, 'pB', 2);
product(DB, 'pC', 1);
product(DB, 'pD', 1);
reload();

/** Rechnung anlegen und voll bezahlen; Zahlung und ihre Buchungen auf `am` legen (Testaufbau). */
function bezahlt(pid: string, ausgestellt: string, am: string, qty = 1): { inv: string; z: string; pay: string } {
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ ...LINE(pid, qty, 1000), lotId: 'lot-' + pid }] as never, pid, ausgestellt).id);
  reload();
  const brutto = n(DB, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  const pay = imHaus(() => useInvoiceStore.getState().recordPayment(inv, brutto, 'cash'));
  DB.run('UPDATE payments SET received_at = ? WHERE id = ?', [am, pay]);
  DB.run("UPDATE ledger_entries SET occurred_at = ? WHERE source_module = 'PAYMENT' AND source_id = ?", [am, pay]);
  reload();
  return { inv, z: s(DB, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]), pay };
}
const A = bezahlt('pA', '2026-04-10', '2026-05-10T12:00:00.000Z', 2);   // Q2 — wird eingereicht
const B = bezahlt('pB', '2026-07-05', '2026-07-20T12:00:00.000Z');      // Q3 — offen
const C = bezahlt('pC', '2026-07-06', '2026-07-21T12:00:00.000Z');      // Q3 — offen, soll NICHT nach Q2 wandern
const D = bezahlt('pD', '2026-01-10', '2026-02-10T12:00:00.000Z');      // Q1 — VAT schon bezahlt
DB.run("INSERT INTO tax_payments (id, branch_id, year, quarter, amount, source, paid_at, created_at) VALUES ('tp-q1','branch-main',2026,1,100,'bank',?,?)", [NOW, NOW]);

function stand(inv: string): string {
  return S({
    inv: all(DB, 'SELECT customer_id, status, issued_at, ROUND(gross_amount, 3), paid_amount, invoice_number, notes FROM invoices WHERE id = ?', [inv]),
    lines: all(DB, 'SELECT id, quantity, unit_price, line_total, vat_amount FROM invoice_lines WHERE invoice_id = ? ORDER BY id', [inv]),
    pay: all(DB, 'SELECT id, amount, method, received_at, notes FROM payments WHERE invoice_id = ? ORDER BY id', [inv]),
    le: n(DB, 'SELECT COUNT(*) FROM ledger_entries'),
  });
}
const fp = (inv: string): string => vatFingerprint(inv)?.data ?? '';
function aendere(inv: string, z: string, pid: string, o: { preis?: number; qty?: number; notes?: string; customerId?: string; issuedAt?: string; confirm?: boolean } = {}): string {
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: [{ lineId: z, ...LINE(pid, o.qty ?? Number(one(DB, 'SELECT quantity FROM invoice_lines WHERE id = ?', [z])), o.preis ?? 1000), lotId: 'lot-' + pid }] as never,
    reason: 'VAT-Test', ...(o.notes !== undefined ? { notes: o.notes } : {}), ...(o.customerId ? { customerId: o.customerId } : {}),
    ...(o.issuedAt ? { issuedAt: o.issuedAt } : {}), ...(o.confirm ? { confirmCustomerChange: true } : {}),
  } as never)));
  reload();
  return m;
}
const code = (m: string): string => m.split('|')[0];

// ══ 1) Einreichen ══
{
  ok(vatFingerprint(A.inv)?.quarter === '2026-Q2' && vatFingerprint(B.inv)?.quarter === '2026-Q3' && vatFingerprint(D.inv)?.quarter === '2026-Q1',
    `SETUP A in Q2 (Mai), B/C in Q3, D in Q1 (${vatFingerprint(A.inv)?.month}/${vatFingerprint(B.inv)?.month}/${vatFingerprint(D.inv)?.month})`);
  const r = imHaus(() => markVatQuarterFiled({ branchId: 'branch-main', year: 2026, quarter: 2, userId: 'user-test' }));
  const row = DB.exec('SELECT filed_at, filed_by, invoice_count, snapshot_json FROM vat_filings WHERE year = 2026 AND quarter = 2')[0]?.values?.[0] ?? [];
  const snap = JSON.parse(String(row[3] ?? '{}'));
  ok(r.invoiceCount === 1 && String(row[1]) === 'user-test' && String(row[0]) === r.filedAt && snap.invoices?.[0]?.invoiceId === A.inv
    && JSON.stringify(snap.invoices[0]) === fp(A.inv),
    `1 Q2/2026 eingereicht: Zeitpunkt, Person und die gemeldete Rechnung A festgehalten (${r.invoiceCount} Rechnung, Monat ${snap.invoices?.[0]?.month})`);
  const m2 = meldung(() => imHaus(() => markVatQuarterFiled({ branchId: 'branch-main', year: 2026, quarter: 2 })));
  ok(code(m2) === VAT_QUARTER_ALREADY_FILED && n(DB, 'SELECT COUNT(*) FROM vat_filings') === 1,
    `1 …ein zweites Einreichen desselben Quartals: abgewiesen (${code(m2)})`);
  const ana = src('src/core/reports/analytics-snapshot.ts');
  ok(/filedAt: filedAtByKey\[k\] \?\? null/.test(ana) && /VAT filed \{q\.filedAt\.slice\(0, 10\)\}/.test(src('src/pages/analytics/AnalyticsPage.tsx')),
    'Q die Quartalsübersicht zeigt „VAT filed <Datum>", sonst den Knopf „Mark VAT filed"');
  ok(!/vat_filings|markVatQuarterFiled/.test(src('src/core/tax/nbr-export.ts')),
    'Q der NBR-Export ist unverändert und markiert nichts (ein Export ist keine Einreichung)');
}

// ══ 2) Offenes Quartal: alles wie bisher ══
{
  const m1 = aendere(B.inv, B.z, 'pB', { preis: 1200 });
  const m2 = aendere(C.inv, C.z, 'pC', { customerId: 'cust-2', confirm: true });
  const m3 = aendere(B.inv, B.z, 'pB', { preis: 1200, issuedAt: '2026-07-08' });
  ok(m1 === '' && m2 === '' && m3 === '' && s(DB, 'SELECT customer_id FROM invoices WHERE id = ?', [C.inv]) === 'cust-2',
    `2 Q3 offen: Preis, Kunde, Datum ändern geht (${m1}|${m2}|${m3})`);
  // B ist jetzt teilbezahlt (Preis erhöht) — der Rest heute bezahlt, bleibt im offenen Quartal.
  const offen = n(DB, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [B.inv]);
  const m4 = meldung(() => imHaus(() => useInvoiceStore.getState().recordPayment(B.inv, offen, 'cash')));
  reload();
  ok(m4 === '' && s(DB, 'SELECT status FROM invoices WHERE id = ?', [B.inv]) === 'FINAL', `2 …Restzahlung im offenen Quartal geht (${m4})`);
}

// ══ 3) Eingereichtes Quartal: nur, was den Export nicht ändert ══
{
  const vor = stand(A.inv); const fpVor = fp(A.inv);
  const mNotiz = aendere(A.inv, A.z, 'pA', { notes: 'nur eine interne Notiz' });
  ok(mNotiz === '' && s(DB, 'SELECT notes FROM invoices WHERE id = ?', [A.inv]) === 'nur eine interne Notiz' && fp(A.inv) === fpVor,
    `3a Notiz geändert: erlaubt, Export unverändert (${mNotiz})`);
  const vor2 = stand(A.inv);
  const faelle: Array<[string, () => string, string]> = [
    ['Preis', () => aendere(A.inv, A.z, 'pA', { preis: 900 }), VAT_PERIOD_FILED],
    ['Menge', () => aendere(A.inv, A.z, 'pA', { qty: 1 }), VAT_PERIOD_FILED],
    ['Rechnungsdatum', () => aendere(A.inv, A.z, 'pA', { issuedAt: '2026-04-20' }), VAT_PERIOD_FILED],
    ['Kunde', () => aendere(A.inv, A.z, 'pA', { customerId: 'cust-2', confirm: true }), CUSTOMER_CHANGE_VAT_FILED],
    ['weitere Zahlung', () => { const m = meldung(() => imHaus(() => useInvoiceStore.getState().recordPayment(A.inv, 10, 'cash'))); reload(); return m; }, VAT_PERIOD_FILED],
    ['Zahlungsdatum', () => { const m = meldung(() => imHaus(() => useInvoiceStore.getState().updatePayment(A.pay, A.inv, { receivedAt: '2026-07-15T12:00:00.000Z' }))); reload(); return m; }, VAT_PERIOD_FILED],
    ['Zahlungsart', () => { const m = meldung(() => imHaus(() => useInvoiceStore.getState().updatePayment(A.pay, A.inv, { method: 'bank_transfer' }))); reload(); return m; }, VAT_PERIOD_FILED],
    ['Zahlung löschen', () => { const m = meldung(() => imHaus(() => useInvoiceStore.getState().deletePayment(A.pay, A.inv))); reload(); return m; }, VAT_PERIOD_FILED],
    ['Stornieren', () => { const m = meldung(() => imHaus(() => reverseInvoiceInHouse(A.inv, 'branch-main'))); reload(); return m; }, VAT_PERIOD_FILED],
  ];
  for (const [was, tu, erwartet] of faelle) {
    const m = tu();
    ok(code(m) === erwartet && stand(A.inv) === vor2 && fp(A.inv) === fpVor,
      `3b ${was}: abgewiesen (${code(m)}), Rechnung, Zahlungen, Buchungen und Export unverändert — „${m.split('|')[1]?.slice(0, 60)}…"`);
  }
  const mZNotiz = meldung(() => imHaus(() => useInvoiceStore.getState().updatePayment(A.pay, A.inv, { notes: 'Beleg nachgereicht' })));
  reload();
  ok(mZNotiz === '' && fp(A.inv) === fpVor, `3c Notiz einer Zahlung: erlaubt, Export unverändert (${mZNotiz})`);
  // Eine Retoure ist ein neuer Vorgang in der offenen Periode — der Export von A bleibt, wie er war.
  const mRet = meldung(() => imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const id = rs.createReturn({
      invoiceId: A.inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'VAT-Test',
      lines: [{ invoiceLineId: A.z, productId: 'pA', quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    } as never).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(id);
  }));
  reload();
  ok(mRet === '' && fp(A.inv) === fpVor && n(DB, 'SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ?', [A.inv]) === 1,
    `3d Retoure/Gutschrift auf A: erlaubt (entsteht in der offenen Periode), Export von A unverändert (${mRet})`);
  void vor;
}

// ══ 4) Nichts wandert unbemerkt HINEIN in ein eingereichtes Quartal ══
{
  const vorC = stand(C.inv); const fpC = fp(C.inv);
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().updatePayment(
    s(DB, 'SELECT id FROM payments WHERE invoice_id = ?', [C.inv]), C.inv, { receivedAt: '2026-06-20T12:00:00.000Z' })));
  reload();
  ok(code(m) === VAT_PERIOD_FILED && stand(C.inv) === vorC && fp(C.inv) === fpC && vatFingerprint(C.inv)?.quarter === '2026-Q3',
    `4 Zahlungsdatum von C (Q3) in den Juni verlegt: abgewiesen, C bleibt in Q3 (${code(m)})`);
}

// ══ 5) Bezahltes Quartal (bisheriger Schutz) bleibt zu ══
{
  const vor = stand(D.inv);
  const m = aendere(D.inv, D.z, 'pD', { preis: 800 });
  ok(code(m) === VAT_PERIOD_FILED && stand(D.inv) === vor && /Q1\/2026 is already paid/.test(m),
    `5 Q1/2026 nur bezahlt (nicht markiert): Preisänderung weiter abgewiesen (${m.split('|')[1]?.slice(0, 50)})`);
}

// ══ 6) PC2 — dieselben Regeln, endgültige Absagen ══
{
  const d = {
    db: DB as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string, op: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op, payloadKind: 'x', payloadHash: 'h' + x });
  const rev = (): number => n(DB, 'SELECT revision FROM invoices WHERE id = ?', [A.inv]);
  const vor = stand(A.inv);
  // A hat seit 3d eine Retoure (Preis dort ohnehin gesperrt) — geprüft wird das Rechnungsdatum.
  const u = await runInvoiceUpdate(d as never, ident('a1', 'invoices.update') as never, {
    id: A.inv, expectedRevision: rev(), reason: 'PC2', customerId: 'cust-1', issuedDate: '2026-04-20',
    lines: [{ lineId: A.z, productId: 'pA', lotId: 'lot-pA', quantity: 2, unitPrice: 1000 }],
  });
  const p = await runInvoicePayment(d as never, ident('a2', 'invoices.record_payment') as never, { invoiceId: A.inv, amount: 10, method: 'cash' });
  const up = await runUpdatePayment(d as never, ident('a3', 'invoices.update_payment') as never, {
    invoiceId: A.inv, paymentId: A.pay, expectedRevision: rev(), receivedAt: '2026-07-15T12:00:00.000Z' });
  const dp = await runDeletePayment(d as never, ident('a4', 'invoices.delete_payment') as never, { invoiceId: A.inv, paymentId: A.pay, expectedRevision: rev() });
  reload();
  const alle = [u, p, up, dp] as Array<{ kind: string; code?: string; frozen?: boolean }>;
  ok(alle.every((x) => x.kind === 'rejected' && x.code === VAT_PERIOD_FILED && x.frozen === true) && stand(A.inv) === vor,
    `6 PC2 Rechnungsdatum / Zahlung / Zahlungsdatum / Zahlung löschen: endgültige Absagen (${alle.map((x) => `${x.kind}:${x.code}`).join(', ')})`);
  const notiz = await runInvoiceUpdate(d as never, ident('a5', 'invoices.update') as never, {
    id: A.inv, expectedRevision: rev(), reason: 'PC2 Notiz', customerId: 'cust-1', notes: 'PC2 Notiz',
    lines: [{ lineId: A.z, productId: 'pA', lotId: 'lot-pA', quantity: 2, unitPrice: 1000 }],
  });
  reload();
  ok(notiz.kind === 'ok' && s(DB, 'SELECT notes FROM invoices WHERE id = ?', [A.inv]) === 'PC2 Notiz',
    `6 …PC2 reine Notiz: erlaubt (${notiz.kind})`);
}

// ══ 7) Kundenstamm — Name/Firma/VAT-Konto/Personal-ID einer gemeldeten Rechnung ══
{
  const snap = JSON.parse(s(DB, 'SELECT snapshot_json FROM vat_filings WHERE year = 2026 AND quarter = 2'));
  const g = snap.invoices?.[0];
  ok(g?.customer?.name === 'Ali Hassan' && g?.customer?.vatAccountNumber === '' && g?.lines?.[0]?.[7] === 'Rolex M pA',
    `7 der Filing-Snapshot hält Kundenname, VAT-Konto und Artikelbezeichnung fest (${g?.customer?.name} / ${g?.lines?.[0]?.[7]})`);
  const kunde = (id: string): string => all(DB, 'SELECT first_name, last_name, company, vat_account_number, personal_id, phone FROM customers WHERE id = ?', [id]);
  const upd = (id: string, data: Record<string, unknown>): string => { const m = meldung(() => useCustomerStore.getState().updateCustomer(id, data as never)); reload(); return m; };
  const fpA = fp(A.inv); const vorK = kunde('cust-1');
  for (const [was, data] of [
    ['VAT-Nummer', { vatAccountNumber: 'VAT-200' }], ['Nachname', { lastName: 'Haddad' }],
    ['Firma', { company: 'Hassan Trading' }], ['Personal-ID', { personalId: '880101234' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const m = upd('cust-1', data);
    ok(code(m) === VAT_PERIOD_FILED && kunde('cust-1') === vorK && fp(A.inv) === fpA,
      `7 Kunde von A (Q2 eingereicht): ${was} ändern abgewiesen, Stamm und Export unverändert — „${m.split('|')[1]?.slice(0, 70)}…"`);
  }
  const mTel = upd('cust-1', { phone: '+973 3300 1122', email: 'ali@example.com', notes: 'Stammkunde' });
  ok(mTel === '' && s(DB, 'SELECT phone FROM customers WHERE id = ?', ['cust-1']) === '+973 3300 1122' && fp(A.inv) === fpA,
    `7 …Telefon, E-Mail, Notiz: erlaubt, Export unverändert (${mTel})`);
  const mGanz = upd('cust-1', { firstName: 'Ali', lastName: 'Hassan', company: '', vatAccountNumber: '', personalId: '', phone: '+973 3300 1123' });
  ok(mGanz === '' && fp(A.inv) === fpA, `7 …ganze Maske mit unveränderten Namensfeldern (wie die Desktop-Maske sie schickt): erlaubt (${mGanz})`);
  const mOffen = upd('cust-2', { vatAccountNumber: 'VAT-777', lastName: 'Saleh' });
  ok(mOffen === '' && s(DB, 'SELECT vat_account_number FROM customers WHERE id = ?', ['cust-2']) === 'VAT-777',
    `7 Kunde nur mit Rechnungen im offenen Q3: VAT-Nummer und Name ändern geht (${mOffen})`);

  const d = {
    db: DB as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string, op: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op, payloadKind: 'x', payloadHash: 'h' + x });
  const vorPc2 = kunde('cust-1');
  const r1 = await runCustomerUpdate(d as never, ident('c1', 'customers.update') as never, { id: 'cust-1', vatAccountNumber: 'VAT-PC2' }) as { kind: string; code?: string; frozen?: boolean };
  const r2 = await runCustomerUpdate(d as never, ident('c2', 'customers.update') as never, { id: 'cust-1', phone: '+973 1111' }) as { kind: string };
  reload();
  ok(r1.kind === 'rejected' && r1.code === VAT_PERIOD_FILED && r1.frozen === true && r2.kind === 'ok'
    && s(DB, 'SELECT vat_account_number FROM customers WHERE id = ?', ['cust-1']) === ''
    && s(DB, 'SELECT phone FROM customers WHERE id = ?', ['cust-1']) === '+973 1111' && vorPc2 !== '',
    `7 PC2 customers.update: VAT-Nummer endgültig abgewiesen, Telefon geht (${r1.kind}:${r1.code}, ${r2.kind})`);
}

// ══ 8) Einreichen erst nach dem Quartal ══
{
  const jetzt = new Date();
  const lq = Math.ceil((jetzt.getMonth() + 1) / 3);
  const vorN = n(DB, 'SELECT COUNT(*) FROM vat_filings');
  const m1 = meldung(() => imHaus(() => markVatQuarterFiled({ branchId: 'branch-main', year: jetzt.getFullYear(), quarter: lq })));
  const m2 = meldung(() => imHaus(() => markVatQuarterFiled({ branchId: 'branch-main', year: 2099, quarter: 1 })));
  ok(code(m1) === lock.VAT_QUARTER_NOT_OVER && code(m2) === lock.VAT_QUARTER_NOT_OVER && n(DB, 'SELECT COUNT(*) FROM vat_filings') === vorN,
    `8 laufendes Quartal (Q${lq}/${jetzt.getFullYear()}) und künftiges: nicht einreichbar (${code(m1)})`);
  ok(/new Date\(\) >= new Date\(q\.year, q\.quarter \* 3, 1\)/.test(src('src/pages/analytics/AnalyticsPage.tsx')),
    '8 …der Knopf „Mark VAT filed" erscheint erst nach Quartalsende');
}

// ══ 9) Zahlung löschen: der Abschlusstag rückt nicht still in ein eingereichtes Quartal ══
{
  product(DB, 'pE', 1); reload();
  const E = bezahlt('pE', '2026-06-01', '2026-06-10T12:00:00.000Z');   // voll bezahlt im Juni …
  DB.run(`INSERT INTO payments (id, branch_id, invoice_id, amount, method, received_at, created_at)
          VALUES ('pay-e2','branch-main',?,5,'cash','2026-07-22T12:00:00.000Z',?)`, [E.inv, NOW]);   // … und eine Überzahlung im Juli
  reload();
  const vorE = stand(E.inv);
  ok(vatFingerprint(E.inv)?.quarter === '2026-Q3', `SETUP E steht wegen der Juli-Zahlung in Q3 (${vatFingerprint(E.inv)?.month})`);
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().deletePayment('pay-e2', E.inv)));
  reload();
  ok(code(m) === VAT_PERIOD_FILED && stand(E.inv) === vorE && vatFingerprint(E.inv)?.quarter === '2026-Q3',
    `9 Juli-Zahlung löschen würde E in den eingereichten Juni schieben: abgewiesen, E unverändert (${code(m)})`);
}

// ══ 10) Umwandlungen, die heute abschließen, wenn das laufende Quartal zu ist (VAT schon bezahlt) ══
{
  const jetzt = new Date();
  const lq = Math.ceil((jetzt.getMonth() + 1) / 3);
  DB.run("INSERT INTO tax_payments (id, branch_id, year, quarter, amount, source, paid_at, created_at) VALUES ('tp-lauf','branch-main',?,?,1,'bank',?,?)",
    [jetzt.getFullYear(), lq, NOW, NOW]);
  product(DB, 'pF', 1); product(DB, 'pG', 1); reload();

  // Agent: Settle-Zahlungen decken die ganze Abrechnung → die neue Rechnung wäre heute FINAL.
  insert(DB, 'agents', { id: 'ag-1', branch_id: 'branch-main', name: 'Agent Eins', created_at: NOW, updated_at: NOW });
  insert(DB, 'agent_transfers', { id: 'tr-1', branch_id: 'branch-main', transfer_number: 'T-1', agent_id: 'ag-1', product_id: 'pF',
    agent_price: 1100, commission_rate: 0, status: 'sold', transferred_at: NOW, sold_at: NOW, actual_sale_price: 1100, settlement_amount: 1100 });
  DB.run("INSERT INTO agent_settlement_payments (id, transfer_id, amount, method, paid_at, created_at) VALUES ('asp-1','tr-1',1100,'cash','2026-09-01',?)", [NOW]);
  reload();
  const zaehl = (): string => S([n(DB, 'SELECT COUNT(*) FROM invoices'), n(DB, 'SELECT COUNT(*) FROM agent_settlement_payments'),
    n(DB, 'SELECT COUNT(*) FROM ledger_entries'), s(DB, "SELECT COALESCE(invoice_id, '') FROM agent_transfers WHERE id = 'tr-1'")]);
  const vorAg = zaehl();
  const mAg = meldung(() => imHaus(() => useAgentStore.getState().convertTransferToInvoice('tr-1', 'cust-1')));
  reload();
  ok(code(mAg) === VAT_PERIOD_FILED && zaehl() === vorAg,
    `10 Agent-Convert (eine Transaktion): abgewiesen und ganz zurückgerollt — keine Rechnung, Settle-Zahlungen und Buchungen unverändert (${code(mAg)})`);
  let teil = '';
  try { lock.assertMayFinalizeNow('branch-main', 1100, 500); } catch (e) { teil = (e as Error).message; }
  ok(teil === '', '10 …eine Teilzahlung, die nicht abschließt, bleibt erlaubt');

  // Auftrag: die Anzahlung deckt die Rechnung → Anrechnung würde heute abschließen.
  const inv = rechnung([{ ...LINE('pG', 1, 1000), lotId: 'lot-pG' } as never]);
  insert(DB, 'orders', { id: 'ord-1', branch_id: 'branch-main', customer_id: 'cust-1', order_number: 'O-1', agreed_price: 1100, created_at: NOW, updated_at: NOW });
  DB.run("INSERT INTO order_payments (id, order_id, amount, paid_at, method, created_at) VALUES ('op-1','ord-1',1100,'2026-09-01','cash',?)", [NOW]);
  const zOrd = (): string => S([n(DB, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]),
    n(DB, "SELECT COALESCE(converted_to_invoice, 0) FROM order_payments WHERE id = 'op-1'"), n(DB, 'SELECT COUNT(*) FROM ledger_entries')]);
  const vorOrd = zOrd();
  const mPre = meldung(() => assertOrderCarryOverMayFinalize('ord-1', 1100, 1100));
  const mOrd = meldung(() => imHaus(() => carryOverOrderPaymentsToInvoice(inv, 'ord-1', 'O-1', 1100, 1100)));
  reload();
  ok(code(mPre) === VAT_PERIOD_FILED && code(mOrd) === VAT_PERIOD_FILED && zOrd() === vorOrd,
    `10 Auftrag → Rechnung: Anrechnung der Anzahlung abgewiesen, bevor sie umgebucht wird (${code(mOrd)})`);
  ok(/assertOrderCarryOverMayFinalize\(id, invoiceLineInputs/.test(src('src/pages/orders/OrderDetail.tsx'))
    && /assertOrderCarryOverMayFinalize\(id, calc\.grossAmount/.test(src('src/pages/orders/OrderDetail.tsx'))
    && /VatPeriodFiled\) return new CommandRejected/.test(src('src/core/bridge/lifecycle-commands.ts'))
    && /VatPeriodFiled\) throw new CommandRejected\(VAT_PERIOD_FILED/.test(src('src/core/bridge/financial-commands.ts')),
    '10 …Auftragsansicht fragt vor dem Anlegen; PC2-Umwandlungen (Agent, Auftrag) geben das Nein als endgültiges Urteil weiter');
  DB.run("DELETE FROM tax_payments WHERE id = 'tp-lauf'");
}

// ══ 11) Artikelstamm — Marke/Name eines gemeldeten Artikels ══
{
  const { useProductStore: ps } = await import('../../src/stores/productStore.ts');
  const { runProductUpdate } = await import('../../src/core/bridge/product-commands.ts');
  const art = (id: string): string => all(DB, 'SELECT brand, name, planned_sale_price, notes FROM products WHERE id = ?', [id]);
  const fpA = fp(A.inv); const vor = art('pA');
  const upd = (id: string, data: Record<string, unknown>): string => { const m = meldung(() => ps.getState().updateProduct(id, data as never)); reload(); return m; };
  const mName = upd('pA', { name: 'Submariner Neu' });
  const mMarke = upd('pA', { brand: 'Tudor' });
  ok(code(mName) === VAT_PERIOD_FILED && code(mMarke) === VAT_PERIOD_FILED && art('pA') === vor && fp(A.inv) === fpA,
    `11 Artikel von A (Q2 eingereicht): Name/Marke umbenennen abgewiesen, Stamm und Export unverändert — „${mName.split('|')[1]?.slice(0, 70)}…"`);
  const dur = await ps.getState().editProductTextDurably('pA', { name: 'Submariner Neu' } as never);
  ok(dur.status === 'blocked' && (dur as { errorCode?: string }).errorCode === VAT_PERIOD_FILED && /Brand and name appear/.test(String((dur as { message?: string }).message)) && art('pA') === vor,
    `11 …der durable Desktop-/Handy-Textweg: ebenso abgewiesen, mit lesbarer Meldung (${dur.status})`);
  const mFrei = upd('pA', { plannedSalePrice: 1999, notes: 'Box nachgeliefert' });
  const mGleich = upd('pA', { brand: 'Rolex', name: 'M pA' });
  ok(mFrei === '' && mGleich === '' && n(DB, "SELECT planned_sale_price FROM products WHERE id = 'pA'") === 1999 && fp(A.inv) === fpA,
    `11 …Preis/Notiz ändern und unveränderte Bezeichnung mitschicken: erlaubt, Export unverändert (${mFrei}|${mGleich})`);
  const mOffen = upd('pB', { name: 'Datejust' });
  ok(mOffen === '' && s(DB, "SELECT name FROM products WHERE id = 'pB'") === 'Datejust',
    `11 Artikel nur im offenen Q3 verkauft: umbenennen geht (${mOffen})`);
  const d = {
    db: DB as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string, op: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op, payloadKind: 'x', payloadHash: 'h' + x });
  const r = await runProductUpdate(d as never, ident('p1', 'products.update') as never, { id: 'pA', name: 'Submariner PC2' }) as { kind: string; code?: string; frozen?: boolean; message?: string };
  reload();
  ok(r.kind === 'rejected' && r.code === VAT_PERIOD_FILED && r.frozen === true && /Brand and name appear/.test(String(r.message)),
    `11 PC2 products.update Umbenennung: endgültig abgewiesen mit Meldung (${r.kind}:${r.code})`);
  ok(s(DB, "SELECT name FROM products WHERE id = 'pA'") === 'M pA' && /productVatLabelRefusal\(plan\.productId/.test(src('src/core/media/mobile-upload-wiring.ts')),
    '11 …Name bleibt „M pA"; der Handy-Galerieweg prüft dieselbe Regel');
}

console.log(`\nvat-period-lock: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
