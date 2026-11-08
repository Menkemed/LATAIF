// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT A1 — das gemeinsame Kundenkonto (nur lesen): Saldo gegen die bestehenden offenen Posten, keine
// Doppelzählung, Partner (Forderung/Verbindlichkeit, bezahlt, noch nicht abgerechnet), Kunde↔Lieferant nur über die
// ausdrückliche Verknüpfung, Gold getrennt, Hinweise statt Namens-Verknüpfung, Primary = PC2, Öffnen ändert nichts.
// Nur künstliche Testdaten in einer In-Memory-Datenbank (sql.js) — keine Produktionsdaten.
// Gerüst aus test/partner-items/partner-open-balances.test.ts (echte Migrationen, Stores, Hauptbuch, Partnerlogik).
// Run: node test/customer-account/customer-account.test.ts
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
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore, customerStatsFor, customerStoreCreditFor } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { usePartnerStore } = await import('../../src/stores/partnerStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const house = await import('../../src/core/partners/item-participation-house.ts');
const save = await import('../../src/core/partners/item-participation-save.ts');
const recv = await import('../../src/core/finance/receivables.ts');
const payS = await import('../../src/stores/payablesStore.ts');
const pageReads = await import('../../src/core/data/page-reads.ts');
await import('../../src/core/bridge/party-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
const ca = await import('../../src/core/parties/customer-account.ts');
const pa = await import('../../src/core/parties/party-account.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-10-20T10:00:00.000Z';
const F = (x: number): number => Math.round(x * 1000);
const eq = (a: number, b: number): boolean => F(a) === F(b);

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
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
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zwei',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  const kunde = (id: string, branch: string, fn: string, ln: string, phone: string | null): void => {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, phone, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,?,?,'BH','en',0,'[]','collector','active',?,?)`, [id, branch, fn, ln, phone, NOW, NOW]);
  };
  kunde('cust-1', 'branch-main', 'Ahmed', 'Karimi', '+973 3300 0001');
  kunde('cust-2', 'branch-main', 'Other', 'Client', '+973 3999 9999');
  kunde('cust-x', 'branch-2', 'Fremd', 'Kunde', null);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, phone, linked_customer_id, active, created_at, updated_at) VALUES ('sup-ak','branch-main','Ahmed Karimi','+97333000001','cust-1',1,?,?)", [NOW, NOW]);
  for (const [id, name, phone] of [['pa-ak', 'Bashir Partner', '+97333000001'], ['pa-b', 'Bashir', null]] as Array<[string, string, string | null]>) {
    db.run(`INSERT INTO partners (id, branch_id, name, phone, share_percentage, active, created_at, updated_at)
      VALUES (?, 'branch-main', ?, ?, 0, 1, ?, ?)`, [id, name, phone, NOW, NOW]);
  }
  for (let i = 1; i <= 12; i++) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',0,'BHD',1300,?,'ZERO',0,'[]','{}','OWN',?,?)`,
    // pk1–pk4 liegen zum Verkauf bereit; pk5–pk12 kommen erst über einen Einkauf ins Lager (wie im Partnertest).
    ['pk' + i, 'Sub pk' + i, 'SKU-pk' + i, i <= 4 ? 1 : 0, i <= 4 ? 'in_stock' : 'sold', NOW, NOW]);
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
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({ name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0 }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}
const ar = (db: Db, cid = 'cust-1'): number => n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
  WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_type = 'CUSTOMER' AND counterparty_id = ?`, [cid]);

const DB = freshDb();
const CTX = { branchId: 'branch-main' };
const acc = () => ca.customerAccountFor(CTX, 'cust-1');
const sumOpen = (a: ReturnType<typeof acc>, pred: (d: ReturnType<typeof acc>['docs'][number]) => boolean): number =>
  a.docs.filter(pred).reduce((t, d) => t + F(d.open), 0) / 1000;
const sale = (pid: string, price: number, date: string, customerId = 'cust-1'): string => {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, [{ productId: pid, quantity: 1, unitPrice: price, purchasePrice: 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price }] as never, 'CA-TEST', date).id);
  reload();
  return id;
};

// ════════════════════════════════════════════════════════════════════════════
// Seed — alle Beziehungen eines Kunden, je mit einem Gegenbeispiel, das NICHT zählen darf.
// ════════════════════════════════════════════════════════════════════════════
const I1 = sale('pk1', 1500, '2026-10-05T09:00:00.000Z');
const I2 = sale('pk2', 500, '2026-10-06T09:00:00.000Z');
imHaus(() => useInvoiceStore.getState().recordPayment(I2, 200, 'cash'));
const I3 = sale('pk3', 300, '2026-10-07T09:00:00.000Z');
imHaus(() => useInvoiceStore.getState().recordPayment(I3, 300, 'cash'));
const IOTHER = sale('pk4', 777, '2026-10-07T09:00:00.000Z', 'cust-2');
insert(DB, 'invoices', { id: 'inv-cancel', branch_id: 'branch-main', invoice_number: 'PINV-X', customer_id: 'cust-1', status: 'CANCELLED', currency: 'BHD',
  net_amount: 999, vat_amount: 0, gross_amount: 999, paid_amount: 0, issued_at: '2026-10-08', created_at: NOW, updated_at: NOW });
reload();

// Guthaben: offen 100 (davon später 40 eingelöst), verbraucht 50, storniert 70, Rückzahlungsanspruch 30.
insert(DB, 'customer_credits', { id: 'cc-open', branch_id: 'branch-main', customer_id: 'cust-1', source_type: 'overpayment', source_id: 'x', amount: 100, used_amount: 0, status: 'OPEN', created_at: '2026-10-01T09:00:00.000Z' });
insert(DB, 'customer_credits', { id: 'cc-used', branch_id: 'branch-main', customer_id: 'cust-1', source_type: 'sales_return', source_id: 'y', amount: 50, used_amount: 50, status: 'USED', created_at: '2026-09-01T09:00:00.000Z' });
insert(DB, 'customer_credits', { id: 'cc-void', branch_id: 'branch-main', customer_id: 'cust-1', source_type: 'overpayment', source_id: 'z', amount: 70, used_amount: 0, status: 'CANCELLED', created_at: '2026-09-02T09:00:00.000Z' });
insert(DB, 'customer_credits', { id: 'cc-ref', branch_id: 'branch-main', customer_id: 'cust-1', source_type: 'invoice_edit', source_id: I3, amount: 30, used_amount: 0, status: 'REFUND_DUE', created_at: '2026-10-09T09:00:00.000Z' });

// Darlehen.
const debt = (id: string, dir: string, amount: number, status: string, customerId: string | null, counterparty: string, loan: string): void =>
  insert(DB, 'debts', { id, branch_id: 'branch-main', loan_number: loan, direction: dir, counterparty, customer_id: customerId, amount, source: 'cash', status, created_at: '2026-09-14T09:00:00.000Z', updated_at: NOW });
debt('d-borrow', 'we_borrow', 2000, 'open', 'cust-1', 'Ahmed Karimi', 'LOA-2026-000003');
insert(DB, 'debt_payments', { id: 'dp-1', debt_id: 'd-borrow', amount: 800, source: 'cash', paid_at: '2026-10-02T09:00:00.000Z', created_at: NOW });
debt('d-lend', 'we_lend', 300, 'open', 'cust-1', 'Ahmed Karimi', 'LOA-2026-000004');
debt('d-repaid', 'we_borrow', 400, 'REPAID', 'cust-1', 'Ahmed Karimi', 'LOA-2026-000006');
insert(DB, 'debt_payments', { id: 'dp-2', debt_id: 'd-repaid', amount: 400, source: 'bank', paid_at: '2026-09-20T09:00:00.000Z', created_at: NOW });
debt('d-canon', 'MONEY_RECEIVED', 100, 'OPEN', 'cust-1', 'Ahmed Karimi', 'LOA-2026-000007');
debt('d-cancel', 'we_lend', 999, 'CANCELLED', 'cust-1', 'Ahmed Karimi', 'LOA-2026-000008');
debt('d-hint', 'we_borrow', 250, 'open', null, 'ahmed  karimi', 'LOA-2026-000005');
debt('d-other', 'we_borrow', 90, 'open', null, 'Someone Else', 'LOA-2026-000009');

// Lieferantenrolle (verknüpft): offener Einkauf 800, bezahlter 400, Entwurf 999 (zählt nie), Guthaben 70.
const EINKAUF = (supplierId: string, pid: string, price: number, pay: number) => ({
  supplierId, purchaseDate: '2026-10-12', taxScheme: 'ZERO', paymentAmount: pay, paymentMethod: 'bank', notes: '', staffId: '',
  lines: [{ mode: 'existing', productId: pid, brand: 'Rolex', name: 'Sub ' + pid, sku: 'SKU-' + pid, categoryId: 'cat-w', quantity: 1, unitPrice: price }],
});
const P1 = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF('sup-ak', 'pk5', 800, 0) as never)).id;
const P2 = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF('sup-ak', 'pk6', 400, 400) as never)).id;
insert(DB, 'purchases', { id: 'pur-draft', branch_id: 'branch-main', purchase_number: 'PUR-DRAFT', supplier_id: 'sup-ak', status: 'DRAFT', total_amount: 999, paid_amount: 0, remaining_amount: 999, purchase_date: '2026-10-13', created_at: NOW, updated_at: NOW });
insert(DB, 'supplier_credits', { id: 'sc-1', branch_id: 'branch-main', supplier_id: 'sup-ak', amount: 70, used_amount: 0, status: 'OPEN', created_at: '2026-10-14T09:00:00.000Z' });

// Kommission: Altweg (verkauft, Auszahlung offen 450) und Record Sale (Schuld als Einkauf bei einem NICHT verknüpften Lieferanten).
insert(DB, 'consignments', { id: 'con-1', branch_id: 'branch-main', consignment_number: 'CON-2026-00009', consignor_id: 'cust-1', product_id: 'pk7', agreed_price: 500,
  commission_rate: 10, payout_amount: 450, payout_paid_amount: 0, status: 'sold', agreement_date: '2026-10-15', created_at: NOW, updated_at: NOW });
insert(DB, 'consignments', { id: 'con-2', branch_id: 'branch-main', consignment_number: 'CON-2026-00010', consignor_id: 'cust-1', product_id: 'pk8', agreed_price: 300,
  commission_rate: 10, payout_amount: 250, payout_paid_amount: 0, status: 'sold', invoice_id: 'inv-cons', agreement_date: '2026-10-16', created_at: NOW, updated_at: NOW });
insert(DB, 'purchases', { id: 'pur-cons', branch_id: 'branch-main', purchase_number: 'PUR-CONS', supplier_id: 'sup-1', status: 'UNPAID', total_amount: 250, paid_amount: 0, remaining_amount: 250,
  purchase_date: '2026-10-16', source_consignment_id: 'con-2', created_at: NOW, updated_at: NOW });

// Auftrag: offene Anzahlung 200 (gebunden); stornierter Auftrag mit 300 zählt nicht.
const auftrag = (id: string, status: string, pay: number): void => {
  insert(DB, 'orders', { id, branch_id: 'branch-main', order_number: 'ORD-' + id, customer_id: 'cust-1', requested_brand: 'Rolex', requested_model: 'Daytona', agreed_price: 1000, status, created_at: NOW, updated_at: NOW });
  insert(DB, 'order_payments', { id: 'op-' + id, order_id: id, amount: pay, paid_at: '2026-10-17T09:00:00.000Z', method: 'cash', created_at: NOW });
};
auftrag('o1', 'pending', 200);
auftrag('o2', 'cancelled', 300);

// Eröffnungsposten: Kunde schuldet 250 (erfasst), 99 storniert; Lieferantenrolle: wir schulden 60.
const ob = (id: string, partyType: string, partyId: string, kind: string, amount: number, status: string): void =>
  insert(DB, 'opening_balance_items', { id, branch_id: 'branch-main', item_number: 'OB-' + id, party_type: partyType, party_id: partyId, kind, scope: 'REMAINDER',
    amount, cutoff_date: '2026-10-15', status, accounting: 'PENDING', action_id: 'act-' + id, payload_hash: 'h', created_at: NOW });
ob('ob1', 'CUSTOMER', 'cust-1', 'CUSTOMER_RECEIVABLE', 250, 'RECORDED');
ob('ob2', 'CUSTOMER', 'cust-1', 'CUSTOMER_ADVANCE', 99, 'CANCELLED');
ob('ob3', 'SUPPLIER', 'sup-ak', 'SUPPLIER_PAYABLE', 60, 'RECORDED');

// Gold: 12,5 g offen (21K), 5 g erledigt.
insert(DB, 'customer_gold_credits', { id: 'g1', branch_id: 'branch-main', customer_id: 'cust-1', weight_grams: 12.5, karat: '21K', fulfilled_grams: 0, status: 'OPEN', created_at: NOW, updated_at: NOW });
insert(DB, 'customer_gold_credits', { id: 'g2', branch_id: 'branch-main', customer_id: 'cust-1', weight_grams: 5, karat: '21K', fulfilled_grams: 5, status: 'FULFILLED', created_at: NOW, updated_at: NOW });
reload();

// ══ A — Summen und Netto gegen den erwarteten Stand ═══════════════════════════════════════════════════════════
const A0 = acc();
{
  ok(eq(A0.owesUs.total, 1500 + 300 + 300 + 250 + 70) && eq(A0.owesUs.bound, 250) && eq(A0.owesUs.free, 2170),
    `A1 Ahmed schuldet uns 2420 (Rechnungen 1800, We Lent 300, Eröffnung 250 gebunden, Lieferantenguthaben 70) (${S(A0.owesUs)})`);
  const weOwe = 100 + 30 + 1200 + 100 + 800 + 450 + 250 + 200 + 60;
  ok(eq(A0.weOwe.total, weOwe) && eq(A0.weOwe.bound, 260) && eq(A0.weOwe.free, weOwe - 260),
    `A2 wir schulden 3190 (Guthaben 100, Rückzahlung 30, We Borrowed 1200+100, Einkauf 800, Kommission 450+250, Anzahlung 200 und Eröffnung 60 gebunden) (${S(A0.weOwe)})`);
  ok(eq(A0.net, 2420 - weOwe) && A0.direction === 'WE_OWE' && eq(A0.netFree, 2170 - (weOwe - 260)),
    `A3 Netto −770: LATAIF schuldet Ahmed; nur freie Beträge −760 (${A0.net} / ${A0.netFree})`);
  const keys = A0.docs.map((d) => d.key);
  ok(!keys.includes('invoice:inv-cancel') && !keys.includes(`invoice:${IOTHER}`) && !keys.includes('credit:cc-void') && !keys.includes('debt:d-cancel')
    && !keys.includes('purchase:pur-draft') && !keys.includes('order:o2') && !keys.includes('opening:ob2') && !keys.includes('debt:d-hint') && !keys.includes('consignment:con-2'),
    'A4 nicht gezählt: stornierte Rechnung, fremder Kunde, storniertes Guthaben, storniertes Darlehen, Einkaufsentwurf, stornierter Auftrag, stornierter Eröffnungsposten, unverknüpftes Darlehen, Kommission mit Rechnung (läuft als Einkauf)');
  const doc = (k: string) => A0.docs.find((d) => d.key === k);
  ok(doc(`invoice:${I3}`)?.status === 'SETTLED' && doc('debt:d-repaid')?.status === 'SETTLED' && doc('credit:cc-used')?.status === 'SETTLED' && doc(`purchase:${P2}`)?.status === 'SETTLED',
    'A5 abgeschlossene Vorgänge stehen im Verlauf (Status Settled), zählen aber nichts');
  ok(doc('purchase:pur-cons')?.kind === 'CONSIGNMENT_PAYOUT' && eq(doc('purchase:pur-cons')!.open, 250) && doc('order:o1')?.bound?.startsWith('bound to order') === true
    && doc('opening:ob1')?.bound !== null && doc('opening:ob3')?.side === 'WE_OWE',
    'A6 Kommission über Record Sale als Auszahlung (Einkauf beim nicht verknüpften Einlieferer, über die Kommission zugeordnet); Anzahlung und Eröffnungsposten gebunden');
  ok(doc('credit:cc-ref')?.number === doc(`invoice:${I3}`)?.number && doc(`invoice:${I3}`)?.number !== s(DB, 'SELECT invoice_number FROM invoices WHERE id = ?', [I3]),
    `A7 Rechnungsnummern überall in der Anzeigeform der App (Endnummer), auch beim Rückzahlungsanspruch (${doc('credit:cc-ref')?.number})`);
}

if (process.env.CA_DUMP) (await import('node:fs')).writeFileSync(process.env.CA_DUMP, JSON.stringify(A0, null, 1));

// ══ B — gegen die bestehenden Quellen (Single Source of Truth) ═════════════════════════════════════════════════
{
  const r = recv.receivablesBreakdown('branch-main').filter((x) => x.customerId === 'cust-1');
  const inv = sumOpen(A0, (d) => d.kind === 'INVOICE');
  ok(eq(inv, r.reduce((t, x) => t + F(x.open), 0) / 1000) && eq(inv, 1800), `B1 Rechnungen = Receivables des Kunden (${inv})`);
  ok(eq(inv, ar(DB)), `B2 Rechnungen = Hauptbuch-Forderung des Kunden (${inv} / ${ar(DB)})`);
  const stats = customerStatsFor(CTX as never, 'cust-1')!;
  ok(eq(sumOpen(A0, (d) => d.kind === 'LOAN_LENT'), stats.loanOutstanding) && eq(stats.invoiceOutstanding, inv),
    `B3 We Lent und Rechnungen = Kundenkennzahlen (${stats.loanOutstanding} / ${stats.invoiceOutstanding})`);
  ok(eq(sumOpen(A0, (d) => d.kind === 'STORE_CREDIT'), customerStoreCreditFor(CTX as never, 'cust-1')), 'B4 Store Credit = einlösbares Guthaben des Kunden');
  const p = payS.loadPayablesFor(CTX as never).payables;
  const pc = (type: string) => p.filter((x) => x.type === type && x.counterpartyId === 'cust-1').reduce((t, x) => t + F(x.outstanding), 0) / 1000;
  ok(eq(sumOpen(A0, (d) => d.key === 'debt:d-borrow'), pc('loan')),
    `B5 We Borrowed (we_borrow) = Payables des Kunden (${pc('loan')}); dazu zählt das kanonische MONEY_RECEIVED-Darlehen (100), das Payables nicht kennt`);
  ok(eq(sumOpen(A0, (d) => d.kind === 'REFUND_DUE' || d.kind === 'RETURN_REFUND'), pc('refund')), `B6 Rückzahlungsansprüche = Payables „Refund" (${pc('refund')})`);
  ok(eq(sumOpen(A0, (d) => d.key === 'consignment:con-1'), pc('consignor')), `B7 Kommission Altweg = Payables „Consignor" (${pc('consignor')})`);
  const supP = (sid: string) => p.filter((x) => x.type === 'supplier' && x.counterpartyId === sid).reduce((t, x) => t + F(x.outstanding), 0) / 1000;
  ok(eq(sumOpen(A0, (d) => d.kind === 'PURCHASE'), supP('sup-ak')) && eq(sumOpen(A0, (d) => d.key === 'purchase:pur-cons'), 250) && supP('sup-1') >= 250,
    `B8 Einkäufe der Rolle = Payables des Lieferanten (${supP('sup-ak')}); der Kommissions-Einkauf steht genau einmal`);
  ok(eq(sumOpen(A0, (d) => d.kind === 'ORDER_DEPOSIT'), pageReads.customerOrderDepositsFor(CTX as never, 'cust-1').total), 'B9 Anzahlungen = offene Auftragsanzahlungen der Kundenseite');
}

// ══ C — keine Doppelzählung: Guthaben einlösen und Zahlung erfassen ════════════════════════════════════════════
{
  const vor = acc();
  const eingeloest = imHaus(() => useInvoiceStore.getState().applyCreditToInvoice(I1, 40));
  reload();
  const nach = acc();
  ok(eingeloest === 40 && eq(nach.owesUs.total, vor.owesUs.total - 40) && eq(nach.weOwe.total, vor.weOwe.total - 40) && eq(nach.net, vor.net),
    `C1 40 Guthaben auf eine Rechnung: beide Seiten −40, Netto unverändert (${vor.net} → ${nach.net})`);
  imHaus(() => useInvoiceStore.getState().recordPayment(I1, 100, 'cash'));
  reload();
  const bar = acc();
  ok(eq(bar.owesUs.total, nach.owesUs.total - 100) && eq(bar.weOwe.total, nach.weOwe.total) && eq(bar.net, nach.net - 100), 'C2 Barzahlung 100: nur die Forderung sinkt, Netto −100');
  const i1 = bar.statement.filter((r) => r.docKey === `invoice:${I1}`);
  ok(i1.some((r) => r.text === 'Store credit applied' && eq(r.change, -40)) && bar.statement.some((r) => r.docKey === 'credit:cc-open' && /Applied to/.test(r.text) && eq(r.change, 40)),
    'C3 Kontoauszug: die Einlösung steht auf der Rechnung (−40) und am Guthaben (+40) — gleicht sich aus');
}

// ══ D — Kontoauszug: chronologisch, endet genau beim Netto, jeder Beleg ergibt seinen offenen Betrag ══════════
{
  const a = acc();
  const last = a.statement[a.statement.length - 1];
  const sum = a.statement.reduce((t, r) => t + F(r.change), 0) / 1000;
  ok(eq(last.balance, a.net) && eq(sum, a.net), `D1 letzte Zeile = Netto (${last.balance} / ${a.net})`);
  const sorted = a.statement.every((r, k) => k === 0 || a.statement[k - 1].date <= r.date);
  ok(sorted, 'D2 nach Datum geordnet');
  const perDoc = a.docs.every((d) => {
    const t = a.statement.filter((r) => r.docKey === d.key).reduce((x, r) => x + F(r.change), 0);
    return t === (d.side === 'OWES_US' ? 1 : -1) * F(d.open);
  });
  ok(perDoc, 'D3 je Beleg: Summe seiner Zeilen = sein offener Betrag (mit Vorzeichen der Seite)');
  ok(a.statement.some((r) => r.docKey === `invoice:${I3}` && r.status === 'SETTLED') && a.statement.some((r) => r.docKey === 'debt:d-borrow' && r.text === 'Repayment · Cash' && eq(r.change, 800)),
    'D4 abgeschlossene Belege und Rückzahlungen stehen im Verlauf');
  ok(a.statement.every((r) => typeof r.href === 'string' || r.href === null) && a.statement.filter((r) => r.docKey.startsWith('invoice:')).every((r) => r.href?.startsWith('/invoices/')),
    'D5 jede Zeile verweist auf ihren Beleg');
}

// ══ E — Gold getrennt in Gramm ═════════════════════════════════════════════════════════════════════════════════
{
  const a = acc();
  ok(S(a.gold) === S([{ karat: '21K', grams: 12.5, count: 1 }]), `E1 Gold 12,5 g 21K offen, das erledigte nicht (${S(a.gold)})`);
  insert(DB, 'customer_gold_credits', { id: 'g3', branch_id: 'branch-main', customer_id: 'cust-1', weight_grams: 7, karat: '18K', fulfilled_grams: 0, status: 'OPEN', created_at: NOW, updated_at: NOW });
  const b = acc();
  ok(b.gold.length === 2 && eq(b.net, a.net) && eq(b.weOwe.total, a.weOwe.total), 'E2 mehr Gold ändert keinen BHD-Betrag');
}

// ══ F — Verknüpfungen: nur ausdrücklich; Name/Telefon = Hinweis ═════════════════════════════════════════════════
{
  const a = acc();
  ok(a.supplierRole?.id === 'sup-ak' && a.hints.suppliers.length === 0, 'F1 die verknüpfte Lieferantenrolle zählt; kein Lieferanten-Hinweis');
  ok(a.hints.debts.length === 1 && a.hints.debts[0].id === 'd-hint' && eq(a.hints.debts[0].open, 250) && !a.complete,
    `F2 Darlehen ohne Kunde mit gleichem Namen = Hinweis (nicht gezählt), Saldo als unvollständig markiert (${S(a.incomplete)})`);
  DB.run("UPDATE suppliers SET linked_customer_id = NULL WHERE id = 'sup-ak'");
  const b = acc();
  ok(b.supplierRole === null && b.hints.suppliers.length === 1 && b.hints.suppliers[0].matchedBy === 'phone' && eq(b.hints.suppliers[0].outstanding, 800)
    && !b.docs.some((d) => d.key === `purchase:${P1}`) && b.docs.some((d) => d.key === 'purchase:pur-cons'),
    'F3 ohne Verknüpfung: Lieferant nur als Hinweis (Telefon), seine Einkäufe zählen nicht — der Kommissions-Einkauf bleibt (über die Kommission zugeordnet)');
  DB.run("UPDATE suppliers SET linked_customer_id = 'cust-1' WHERE id = 'sup-ak'");
  let code = '';
  try { ca.customerAccountFor(CTX, 'cust-x'); } catch (e) { code = (e as { code?: string }).code ?? ''; }
  ok(code === 'PARTY_NOT_FOUND', 'F4 Filialgrenze: ein Kunde einer anderen Filiale hat hier kein Konto');
}

// ══ G — Partner: offener Stand der Partnerlogik, nichts erwartetes; ohne Verknüpfung nur Hinweis ═══════════════
{
  const kauf = async (pid: string, price: number) => {
    const id = (await purchaseHouse.createPurchaseOnPrimary({ ...EINKAUF('sup-1', pid, price, price), lines: [{ ...EINKAUF('sup-1', pid, price, price).lines[0], partnerShares: [{ partnerId: 'pa-ak', sharePct: 50 }] }] } as never)).id;
    return { id, line: s(DB, 'SELECT id FROM purchase_lines WHERE purchase_id = ? AND product_id = ?', [id, pid]) };
  };
  const vor = acc();
  const K = await kauf('pk9', 1000);
  const ov = () => house.partnerItemsOverview('branch-main', 'pa-ak');
  const docs1 = ca.partnerDocsOf(ov());
  ok(docs1.length === 1 && docs1[0].kind === 'PARTNER_RECEIVABLE' && docs1[0].side === 'OWES_US' && docs1[0].openF === 500000,
    `G1 Partner schuldet seinen Kostenanteil 500 → Forderung (${S(docs1.map((d) => [d.kind, d.openF]))})`);
  const recvPartner = recv.receivablesBreakdown('branch-main').filter((r) => r.partnerId === 'pa-ak').reduce((t, r) => t + F(r.open), 0) / 1000;
  ok(eq(docs1[0].openF / 1000, recvPartner), 'G2 dieselbe Zahl wie Receivables „Partner"');
  const a = acc();
  ok(a.hints.partners.length === 1 && a.hints.partners[0].link === 'POSSIBLE' && a.hints.partners[0].matchedBy === 'phone' && eq(a.hints.partners[0].owedByPartner, 500)
    && a.partners.length === 0 && eq(a.net, vor.net) && !a.docs.some((d) => d.kind.startsWith('PARTNER')),
    'G3 möglicher Partner (gleiches Telefon) wird angezeigt, zählt aber nicht — Netto unverändert, keine Verknüpfung über Telefon');
  ok(a.incomplete.some((t) => /partner/.test(t)), 'G4 der Saldo ist als unvollständig markiert (Partner nicht verknüpfbar)');
  await save.recordItemMovementOnPrimary({ purchaseLineId: K.line, partnerId: 'pa-ak', kind: 'CONTRIBUTION', amount: 500, method: 'bank', date: '2026-10-18' });
  ok(ca.partnerDocsOf(ov()).length === 0, 'G5 Beitrag voll eingezahlt → nichts offen, keine Partnerzeile');
  const unitCost = n(DB, 'SELECT unit_cost FROM stock_lots WHERE purchase_line_id = ?', [K.line]);
  const lot = s(DB, 'SELECT id FROM stock_lots WHERE purchase_line_id = ?', [K.line]);
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-2', [{ productId: 'pk9', quantity: 1, unitPrice: 1300, purchasePrice: unitCost,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1300, lotId: lot }] as never, 'P').id);
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, 1300, 'cash'));
  reload();
  const pv = ca.partnerView(ov()[0], 'POSSIBLE', 'phone');
  ok(ca.partnerDocsOf(ov()).length === 0 && pv.items[0].profitNotSettled > 0 && eq(pv.items[0].profitShare, 0),
    `G6 verkauft, noch nicht abgerechnet: der rechnerische Gewinnanteil (${pv.items[0].profitNotSettled}) ist KEINE Schuld`);
  const il = s(DB, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  await save.settleSaleOnPrimary(il);
  const docs2 = ca.partnerDocsOf(ov());
  const payPartner = payS.loadPayablesFor(CTX as never).payables.filter((x) => x.type === 'partner' && x.counterpartyId === 'pa-ak').reduce((t, x) => t + F(x.outstanding), 0) / 1000;
  ok(docs2.length === 1 && docs2[0].kind === 'PARTNER_PAYABLE' && docs2[0].side === 'WE_OWE' && eq(docs2[0].openF / 1000, payPartner) && eq(payPartner, 650),
    `G7 nach der Abrechnung schuldet LATAIF Beitrag + Gewinnanteil 650 → Verbindlichkeit = Payables „Partner" (${payPartner})`);
  await save.recordItemMovementOnPrimary({ purchaseLineId: K.line, partnerId: 'pa-ak', kind: 'PAYOUT', amount: 250, method: 'bank', date: '2026-10-19' });
  const docs3 = ca.partnerDocsOf(ov());
  const pv3 = ca.partnerView(ov()[0], 'LINKED', null);
  ok(docs3.length === 1 && docs3[0].openF === 400000 && eq(pv3.items[0].paidOut, 250) && eq(pv3.items[0].contributed, 500) && pv3.items[0].sales.length === 1,
    'G8 Auszahlung 250 → noch 400 offen; Partnerkonto zeigt Beitrag, Verkauf und Auszahlung');
  // Mit Verknüpfung (simuliert): die Partnerzeile läuft genau einmal in den Saldo.
  const raw = { customer: a.customer, supplierRole: a.supplierRole, partners: [], gold: [], hints: { debts: [], suppliers: [], partners: [] },
    docs: [{ key: 'invoice:t', kind: 'INVOICE' as const, side: 'OWES_US' as const, number: 'T', date: '2026-10-01', totalF: 1000000, openF: 1000000, events: [] }, ...docs3] };
  const sim = ca.buildCustomerAccount(raw);
  ok(eq(sim.weOwe.total, 400) && eq(sim.net, 600) && sim.complete, 'G9 verknüpft (simuliert): Partnerschuld 400 einmal im Saldo, Netto 1000 − 400');
}

// ══ H — Primary = PC2, nichts geändert durch Lesen ═══════════════════════════════════════════════════════════════
{
  const vorher = DB.export();
  const ledger = n(DB, 'SELECT COUNT(*) FROM ledger_entries');
  const log = n(DB, 'SELECT COUNT(*) FROM sync_changelog');
  const lokal = pa.partyAccountReadFor(CTX, { partyType: 'CUSTOMER', partyId: 'cust-1', view: ca.CUSTOMER_ACCOUNT_VIEW });
  const actor = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES' };
  const fern = await executeCommand('parties.account.get', { actor, input: { partyType: 'CUSTOMER', partyId: 'cust-1', view: 'customer_account' } }, undefined) as { kind: string; value: { data: typeof lokal } };
  ok(fern.kind === 'ok' && S(fern.value.data.customerAccount) === S(lokal.customerAccount) && lokal.customerAccount !== undefined,
    'H1 PC2 bekommt über parties.account.get genau dasselbe Kundenkonto wie der Primary');
  const ohne = await executeCommand('parties.account.get', { actor, input: { partyType: 'CUSTOMER', partyId: 'cust-1' } }, undefined) as { kind: string; value: { data: Record<string, unknown> } };
  ok(ohne.kind === 'ok' && !('customerAccount' in ohne.value.data), 'H2 ohne view bleibt die Auskunft wie bisher (kein Kundenkonto)');
  const fremd = await executeCommand('parties.account.get', { actor: { ...actor, branchId: 'branch-2' }, input: { partyType: 'CUSTOMER', partyId: 'cust-1', view: 'customer_account' } }, undefined) as { kind: string; code?: string };
  ok(fremd.kind === 'business_error' && fremd.code === 'PARTY_NOT_FOUND', `H3 PC2 einer anderen Filiale sieht den Kunden nicht (${fremd.kind}/${fremd.code})`);
  const nachher = DB.export();
  ok(Buffer.from(vorher).equals(Buffer.from(nachher)) && n(DB, 'SELECT COUNT(*) FROM ledger_entries') === ledger && n(DB, 'SELECT COUNT(*) FROM sync_changelog') === log,
    'H4 Lesen (lokal und PC2) ändert die Datenbank nicht: keine Buchung, kein Änderungsprotokoll, Datei bytegleich');
}

// ══ I — Quelltext: Ansicht, Weg und Grenzen ════════════════════════════════════════════════════════════════════
{
  const app = src('src/App.tsx');
  const page = src('src/pages/customers/CustomerAccountPage.tsx');
  const detail = src('src/pages/customers/CustomerDetail.tsx');
  const core = src('src/core/parties/customer-account.ts');
  ok(app.includes('path="/clients/:id/account"') && detail.includes('data-open-customer-account') && page.includes('OP_PARTIES_ACCOUNT_GET') && page.includes('useSharedRead'),
    'I1 Ansicht „Account" je Kunde, erreichbar aus dem Kunden, gelesen über parties.account.get (Primary lokal, PC2 vom Primary)');
  ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(core.replace(/\/\/.*$/gm, '')) && !/postEntries|trackChange|runOnPrimary/.test(core),
    'I2 das Kundenkonto schreibt nichts (kein INSERT/UPDATE/DELETE, keine Buchung, kein Sync)');
  ok(!/partner_transactions/.test(core.replace(/\/\/.*$/gm, '')), 'I3 keine Gesellschafter-/Eigenkapitalkonten im Kundenkonto');
  ok(/linkedPartnerIds[\s\S]{0,400}return \[\];/.test(core), 'I4 Partner zählen nur über eine ausdrückliche Verknüpfung (heute keine — Owner-Entscheidung P1)');
}

console.log(`\nCUSTOMER ACCOUNT A1: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
