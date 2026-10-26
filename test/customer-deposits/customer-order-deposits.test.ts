// ════════════════════════════════════════════════════════════════════════════
// v0.8.91 — Kundenseite: offene Auftragsanzahlungen („Order Deposits").
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores, echte Hausfolgen,
// echtes Hauptbuch, echte Brücke. Run: node --experimental-strip-types test/customer-deposits/customer-order-deposits.test.ts
//
//   A  Anzahlung beim Anlegen + zweite Zahlung: je Auftrag Nummer, Betrag, Weg, Datum; Summe; == Hauptbuch des Kunden
//   B  Überzahlung: offen höchstens der vereinbarte Preis, der Rest ist Kundenguthaben (getrennt), == Hauptbuch
//   C  Umwandlung in die Rechnung: die Anzahlung ist verrechnet (nicht mehr offen), die Forderung steht bei der Rechnung
//   D  Storno (Erstattung / Guthaben / Verfall): nicht mehr offen
//   E  Fremder Kunde und fremde Filiale bleiben draußen; Summe == Abstimmung CUSTOMER_DEPOSITS
//   F  PC2: `page.customer_detail.get` liefert dieselbe Auskunft
//   G  Pins: Kundenseite zeigt Kennzahl und Abschnitt, getrennt von Forderungen und Guthaben
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
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useOrderPaymentStore } = await import('../../src/stores/orderPaymentStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { customerDetailReadsFor } = await import('../../src/core/data/page-reads.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');
const house = await import('../../src/core/orders/order-lifecycle-house.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/store-read-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-24T10:00:00.000Z';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);

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
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first] of [['c1', 'Lulwa'], ['c2', 'Andere']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Kundin','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  for (const [pid, price] of [['p1', 1800], ['p2', 500], ['p3', 300]] as const) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price,
              purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
            VALUES (?,'branch-main','cat-w','Rolex',?,?,1,'New','[]',?,'BHD',?,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
    [pid, 'M ' + pid, 'SKU-' + pid, price / 2, price, NOW, NOW]);
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
            VALUES (?,'branch-main',?,?,1,1,'ACTIVE',?,?)`, ['lot-' + pid, pid, price / 2, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const CTX = { branchId: 'branch-main', tenantId: 'tenant-1', userId: 'user-test', role: 'ADMIN' } as never;

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
/** Ein Auftrag mit Anzahlung — derselbe Anlegeweg wie die Maske am Primary. */
function auftrag(customerId: string, productId: string, price: number, deposit: number, method = 'benefit'): string {
  const id = imHaus(() => useOrderStore.getState().createOrder({
    customerId, depositAmount: deposit, paymentMethod: method, status: 'pending',
    requestedBrand: 'Rolex', requestedModel: 'M', categoryId: 'cat-w',
    lines: [{ productId, description: 'Rolex', quantity: 1, unitPrice: price, taxScheme: 'MARGIN', vatRate: 10 }],
  } as never).id);
  reload();
  return id;
}
const zahlung = (orderId: string, amount: number, method = 'cash'): void => {
  imHaus(() => useOrderPaymentStore.getState().addPayment({ orderId, amount, method, paidAt: new Date().toISOString().slice(0, 10) } as never));
  reload();
};
const deposits = (customerId: string) => customerDetailReadsFor(CTX, customerId).orderDeposits;
/** Was das Hauptbuch für diesen Kunden auf CUSTOMER_DEPOSITS führt (Haben − Soll). */
const ledgerDeposits = (db: Db, customerId: string): number => r3(n(db,
  `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries
    WHERE account = 'CUSTOMER_DEPOSITS' AND counterparty_id = ?`, [customerId]));
const reconRow = () => reconciliationSnapshotFor(CTX).rows.find((r: { account: string }) => r.account === 'CUSTOMER_DEPOSITS') as { ledger: number; domain: number };

// ══ A — Anzahlung beim Anlegen + zweite Zahlung ═══════════════════════════════════════
{
  const db = freshDb();
  const o1 = auftrag('c1', 'p1', 1800, 100, 'benefit');
  let d = deposits('c1');
  ok(d.orders.length === 1 && d.total === 100 && d.orders[0].orderId === o1 && /^ORD-/.test(d.orders[0].orderNumber)
    && d.orders[0].agreedPrice === 1800 && d.orders[0].open === 100,
  `A ein Auftrag: Nummer, vereinbart 1800, offen 100 (${S(d)})`);
  const p0 = d.orders[0].payments[0];
  ok(d.orders[0].payments.length === 1 && p0.amount === 100 && p0.method === 'benefit' && /^\d{4}-\d{2}-\d{2}/.test(p0.paidAt),
    `A die Zahlung mit Betrag, Weg und Datum (${S(p0)})`);
  ok(ledgerDeposits(db, 'c1') === 100, `A == Hauptbuch des Kunden auf CUSTOMER_DEPOSITS (${ledgerDeposits(db, 'c1')})`);
  zahlung(o1, 400, 'cash');
  d = deposits('c1');
  ok(d.total === 500 && d.orders[0].payments.length === 2 && S(d.orders[0].payments.map((p) => [p.amount, p.method])) === S([[100, 'benefit'], [400, 'cash']]),
    `A zweite Zahlung: offen 500, beide Zahlungen in Reihenfolge (${S(d.orders[0].payments)})`);
  ok(ledgerDeposits(db, 'c1') === 500, 'A …und das Hauptbuch sagt dasselbe');
  ok(d.orders[0].toCredit === 0, 'A nichts davon ist Guthaben');
}

// ══ B — Überzahlung ════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const o = auftrag('c1', 'p3', 300, 200, 'cash');
  zahlung(o, 150, 'cash');
  const d = deposits('c1');
  ok(d.orders[0].paid === 350 && d.orders[0].open === 300 && d.orders[0].toCredit === 50 && d.total === 300,
    `B gezahlt 350 bei vereinbart 300: offen 300, 50 sind Guthaben — getrennt (${S(d.orders[0])})`);
  ok(ledgerDeposits(db, 'c1') === 300, `B == Hauptbuch CUSTOMER_DEPOSITS 300 (${ledgerDeposits(db, 'c1')})`);
  ok(n(db, "SELECT COALESCE(SUM(amount - used_amount), 0) FROM customer_credits WHERE customer_id = 'c1' AND status != 'CANCELLED'") === 50,
    'B die 50 liegen als Kundenguthaben (Store Credit), nicht als Anzahlung');
}

// ══ C — Umwandlung in die Rechnung ════════════════════════════════════════════════════
{
  const db = freshDb();
  const o = auftrag('c1', 'p2', 500, 200, 'cash');
  useOrderStore.getState().updateStatus(o, 'arrived');
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const deps = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString(),
  };
  const out = await fin.runConvertOrder(deps, { commandId: ID('31'), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op: 'orders.convert_to_invoice', payloadHash: 'h31' },
    { orderId: o, expectedRevision: n(db, 'SELECT revision FROM orders WHERE id = ?', [o]) });
  setTestDatabase(db as never);
  reload();
  const d = deposits('c1');
  ok(out.kind === 'ok' && d.orders.length === 0 && d.total === 0, `C nach der Umwandlung ist die Anzahlung verrechnet — nicht mehr offen (${out.kind} ${S(d)})`);
  ok(ledgerDeposits(db, 'c1') === 0, `C …und auch im Hauptbuch 0 (${ledgerDeposits(db, 'c1')})`);
  ok(n(db, "SELECT COUNT(*) FROM invoices WHERE customer_id = 'c1' AND status != 'CANCELLED'") === 1, 'C die Forderung steht bei der Rechnung (getrennt)');
}

// ══ D — Storno ═════════════════════════════════════════════════════════════════════
for (const choice of ['refund', 'credit', 'forfeit'] as const) {
  const db = freshDb();
  const o = auftrag('c1', 'p1', 1800, 100, 'cash');
  await house.cancelOrderOnPrimary({ orderId: o, expectedRevision: n(db, 'SELECT revision FROM orders WHERE id = ?', [o]), choice, ...(choice === 'refund' ? { refundMethod: 'cash' } : {}) } as never);
  setTestDatabase(db as never);
  reload();
  const d = deposits('c1');
  ok(d.orders.length === 0 && d.total === 0 && ledgerDeposits(db, 'c1') === 0, `D Storno (${choice}): nicht mehr offen, Hauptbuch 0 (${S(d)} / ${ledgerDeposits(db, 'c1')})`);
}

// ══ E — Abgrenzung und Abstimmung ════════════════════════════════════════════════════
{
  const db = freshDb();
  auftrag('c1', 'p1', 1800, 100);
  auftrag('c2', 'p2', 500, 50);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
          VALUES ('cx','branch-other','Fremd','Filiale','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model, agreed_price, status, created_at, updated_at)
          VALUES ('ord-x','branch-other','ORD-X','c1','R','M',900,'pending',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO order_payments (id, order_id, amount, paid_at, method, created_at) VALUES ('opx','ord-x',77,?,'cash',?)`, [NOW, NOW]);
  const d1 = deposits('c1'); const d2 = deposits('c2');
  ok(d1.total === 100 && d2.total === 50 && !d1.orders.some((o) => o.orderId === 'ord-x'),
    `E je Kunde nur seine Aufträge, keine aus einer fremden Filiale (${d1.total} / ${d2.total})`);
  const row = reconRow();
  ok(r3(row.domain) === r3(d1.total + d2.total) && r3(row.ledger) === r3(d1.total + d2.total),
    `E Σ der Kundenseiten == Abstimmung CUSTOMER_DEPOSITS (Belege ${row.domain}, Hauptbuch ${row.ledger})`);
}

// ══ F — PC2 ═══════════════════════════════════════════════════════════════════════
{
  freshDb();
  const o = auftrag('c1', 'p1', 1800, 100, 'benefit');
  zahlung(o, 250, 'bank');
  const local = deposits('c1');
  const fern = await executeCommand('page.customer_detail.get',
    { actor: { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES' }, input: { customerId: 'c1' } }, undefined) as { kind: string; value?: { data?: { orderDeposits?: unknown } } };
  ok(fern.kind === 'ok' && S(fern.value?.data?.orderDeposits) === S(local) && local.total === 350,
    `F PC2 bekommt über page.customer_detail.get dieselbe Auskunft (${fern.kind} ${S(fern.value?.data?.orderDeposits).slice(0, 120)})`);
  const fremd = await executeCommand('page.customer_detail.get',
    { actor: { tenantId: 'tenant-1', branchId: 'branch-other', userId: 'user-pc2', role: 'ADMIN' }, input: { customerId: 'c1' } }, undefined) as { kind: string; value?: { data?: { orderDeposits?: { total: number } } } };
  ok(fremd.kind === 'ok' && fremd.value?.data?.orderDeposits?.total === 0, 'F aus einer fremden Filiale: keine Anzahlungen dieses Kunden');
}

// ══ G — Pins ═══════════════════════════════════════════════════════════════════════
{
  const cd = src('src/pages/customers/CustomerDetail.tsx');
  ok(/<KpiCard label="Order Deposits" value=\{orderDeposits\.total\}/.test(cd) && /data-customer-order-deposits/.test(cd)
    && /data-customer-order-deposit-payment=\{p\.id\}/.test(cd), 'G Kundenseite: Kennzahl „Order Deposits" und Abschnitt je Auftrag und Zahlung');
  ok(/<KpiCard label="Open Receivables"/.test(cd) && /<KpiCard label="Store Credit"/.test(cd) && !/orderDeposits\.total[^\n]*stats\.outstanding|stats\.outstanding[^\n]*orderDeposits/.test(cd),
    'G Forderungen und Guthaben bleiben eigene Kennzahlen — die Anzahlungen fließen in keine davon ein');
  ok(/orderDeposits: EMPTY_ORDER_DEPOSITS/.test(cd) && /customerReads\.orderDeposits \?\? EMPTY_ORDER_DEPOSITS/.test(cd), 'G ohne Antwort (älterer Primary) einfach leer');
  const pr = src('src/core/data/page-reads.ts');
  ok(/COALESCE\(op\.converted_to_invoice, 0\) = 0/.test(pr) && /o\.status != 'cancelled'/.test(pr) && /Math\.min\(paid, o\.agreedPrice\)/.test(pr),
    'G dieselbe Regel wie die Abstimmung: nicht umgewandelt, nicht storniert, je Auftrag auf den vereinbarten Preis gedeckelt');
  ok(!/INSERT|UPDATE|DELETE/.test(pr.slice(pr.indexOf('function customerOrderDepositsFor'), pr.indexOf('export function customerDetailReadsFor'))),
    'G die Auskunft liest nur — keine Buchungslogik berührt');
}

console.log(`\ncustomer-order-deposits: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
