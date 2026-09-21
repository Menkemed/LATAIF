// ════════════════════════════════════════════════════════════════════════════
// POST-0858 — die neuen Sperren nach v0.8.58, je an echten Zeilen einer echten sql.js-Datenbank.
// Run: node --experimental-strip-types test/hardening/post-0858-guards.test.ts
//
// Je Sperre: Positiv (abgelehnt, nichts geändert) und, wo billig, eine Negativkontrolle
// (der erlaubte Weg läuft weiter). Schema = schema.sql + echte Migrationen + A1 + Medienschema.
//   1 editInvoice Kundenwechsel   2 updatePayment + Überzahlungs-Guthaben   3 Consignment-Backfill
//   4 Teil-Erstattung Methodenwechsel   5 Storno unbezahlt mit Retoure   6 Lot-geführt ohne offenes Los
//   7 deleteInvoice   8 Retoure-Storno nach Wiederverkauf   9 Einkauf-Storno nach Verkauf
//   10 Altgold-Backfill line_key/branch_id   11 Auftrags-Storno übernimmt Vorlage   12 Merge-Galerie
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
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useScrapTradeStore } = await import('../../src/stores/scrapTradeStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { cancelPurchaseInHouse } = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { backfillConsignmentPayouts } = await import('../../src/core/ledger/backfill.ts');
const { STOCK_UNAVAILABLE_MESSAGE } = await import('../../src/core/lots/lot-availability.ts');
const orderHouse = await import('../../src/core/orders/order-house.ts');
const orderMedia = await import('../../src/core/orders/order-media.ts');

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
}

function product(db: Db, id: string, lotQty: number | null): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
  [id, 'M ' + id, 'SKU-' + id, lotQty ?? 0, NOW, NOW]);
  if (lotQty !== null) {
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,'branch-main',?,100,?,?,'ACTIVE',?,?)`, ['lot-' + id, id, lotQty, lotQty, NOW, NOW]);
  }
}

// Basis wie test/r6e/credit-note-reversal.test.ts (+ Lieferant wie r6f/purchase-parity).
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
  product(db, 'p2', 1);
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
/** Code (falls vorhanden) sonst Meldung; '' = kein Fehler. */
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

const LINE = (productId: string, price = 1000) => ({
  productId, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: price / 10, lineTotal: price * 1.1,
});
function rechnung(productId = 'p2', customerId = 'cust-1', paid = 0): string {
  const id = imHaus(() => {
    const inv = useInvoiceStore.getState().createDirectInvoice(customerId, [LINE(productId)], 'POST-0858');
    if (paid > 0) useInvoiceStore.getState().recordPayment(inv.id, paid, 'cash');
    return inv.id;
  });
  reload();
  return id;
}
function retoure(invId: string, methode: 'cash' | 'credit' = 'cash', productId = 'p2'): string {
  const lineId = s(current(), 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [invId]);
  const id = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const rid = rs.createReturn({
      invoiceId: invId, refundMethod: methode, productDisposition: 'IN_STOCK', reason: 'defekt',
      lines: [{ invoiceLineId: lineId, productId, quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
    return rid;
  });
  reload();
  return id;
}
let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };

/** Was ein abgelehnter Vorgang nicht verändern darf. */
function zustand(db: Db): string {
  return S({
    inv: all(db, 'SELECT * FROM invoices ORDER BY id'),
    lines: all(db, 'SELECT * FROM invoice_lines ORDER BY id'),
    pay: all(db, 'SELECT * FROM payments ORDER BY id'),
    ret: all(db, 'SELECT * FROM sales_returns ORDER BY id'),
    cn: all(db, 'SELECT * FROM credit_notes ORDER BY id'),
    cc: all(db, 'SELECT * FROM customer_credits ORDER BY id'),
    lots: all(db, 'SELECT * FROM stock_lots ORDER BY id'),
    prod: all(db, 'SELECT id, quantity, stock_status FROM products ORDER BY id'),
    pur: all(db, 'SELECT id, status FROM purchases ORDER BY id'),
    le: all(db, 'SELECT id, account, direction, amount, source_module, source_id FROM ledger_entries ORDER BY id'),
  });
}
const lotRem = (db: Db, lot: string): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);

// ══ 1 — editInvoice: Kundenwechsel bei Zahlungen / Delta-Zahlung ═══════════════
{
  const db = neu();
  const inv = rechnung('p2', 'cust-1', 500);
  const zeilen = () => [{ ...LINE('p2'), lotId: s(db, 'SELECT lot_id FROM invoice_lines WHERE invoice_id = ?', [inv]) || undefined }];
  const vor = zustand(db);
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, { lines: zeilen() as never, customerId: 'cust-2', reason: 'test' })));
  ok(/Cannot change the customer of an invoice that has payments/.test(m), `1 bezahlte Rechnung: Kundenwechsel abgelehnt (${m})`);
  ok(zustand(db) === vor, '1 …Rechnung, Zahlungen, Hauptbuch unverändert');
  ok(s(db, 'SELECT customer_id FROM invoices WHERE id = ?', [inv]) === 'cust-1', '1 …Kunde bleibt cust-1');

  const db2 = neu();
  const inv2 = rechnung('p2', 'cust-1', 0);
  const zeilen2 = [{ ...LINE('p2'), lotId: s(db2, 'SELECT lot_id FROM invoice_lines WHERE invoice_id = ?', [inv2]) || undefined }];
  const vor2 = zustand(db2);
  const m2 = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv2, {
    lines: zeilen2 as never, customerId: 'cust-2', reason: 'test', deltaPayment: { amount: 100, method: 'cash' as never },
  })));
  ok(/Cannot change the customer of an invoice that has payments/.test(m2), `1 unbezahlt + Delta-Zahlung: abgelehnt (${m2})`);
  ok(zustand(db2) === vor2, '1 …nichts geändert');

  // Negativkontrolle: unbezahlt, ohne Delta → Wechsel läuft.
  const m3 = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv2, { lines: zeilen2 as never, customerId: 'cust-2', reason: 'test' })));
  reload();
  ok(m3 === '' && s(db2, 'SELECT customer_id FROM invoices WHERE id = ?', [inv2]) === 'cust-2',
    `1 NEG unbezahlt ohne Delta: Kundenwechsel läuft (${m3})`);
}

// ══ 2 — updatePayment: Überzahlungs-Guthaben sperrt Geld-Bein-Änderung ═══════════
{
  const db = neu();
  const inv = rechnung('p2', 'cust-1', 0);
  imHaus(() => {
    useInvoiceStore.getState().recordPayment(inv, 1000, 'cash');
    useInvoiceStore.getState().recordPayment(inv, 200, 'cash');
  });
  reload();
  const payA = s(db, 'SELECT id FROM payments WHERE invoice_id = ? AND amount = 1000', [inv]);
  ok(n(db, "SELECT COUNT(*) FROM customer_credits WHERE source_type = 'overpayment'") === 1, '2 SETUP Überzahlung erzeugte ein overpayment-Guthaben');
  const vor = zustand(db);
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().updatePayment(payA, inv, { amount: 900 })));
  ok(/store credit from an overpayment/.test(m), `2 Betrag der anderen Zahlung ändern: abgelehnt (${m})`);
  ok(zustand(db) === vor, '2 …nichts geändert');

  // Negativkontrolle: ohne Überzahlungs-Guthaben läuft dieselbe Änderung.
  const db2 = neu();
  const inv2 = rechnung('p2', 'cust-1', 0);
  imHaus(() => useInvoiceStore.getState().recordPayment(inv2, 1000, 'cash'));
  reload();
  const p2 = s(db2, 'SELECT id FROM payments WHERE invoice_id = ?', [inv2]);
  const m2 = meldung(() => imHaus(() => useInvoiceStore.getState().updatePayment(p2, inv2, { amount: 900 })));
  ok(m2 === '' && n(db2, 'SELECT amount FROM payments WHERE id = ?', [p2]) === 900, `2 NEG ohne Guthaben: Betrag 1000→900 läuft (${m2})`);
}

// ══ 3 — backfillConsignmentPayouts überspringt live gebuchte Auszahlung ═══════════
{
  const db = neu();
  for (const id of ['cons-live', 'cons-alt']) {
    insert(db, 'consignments', {
      id, branch_id: 'branch-main', consignment_number: 'CN-' + id, consignor_id: 'cust-1', product_id: 'p2',
      agreed_price: 1000, payout_amount: 850, payout_paid_amount: 850, payout_method: 'cash', payout_date: '2026-09-01',
      status: 'paid_out', agreement_date: '2026-08-01', created_at: NOW, updated_at: NOW,
    });
  }
  imHaus(() => posting.postConsignmentPayout({
    id: '5f1c7b2e-1111-4a2b-9c3d-000000000001', consignmentId: 'cons-live', consignorId: 'cust-1', amount: 850, method: 'cash', paidAt: '2026-09-01',
  }));
  const liveVor = n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'CONSIGNMENT_PAYOUT' AND metadata_json LIKE '%cons-live%'");
  ok(liveVor === 2, `3 SETUP Live-Auszahlung gebucht (${liveVor} Beine, zufällige source_id)`);
  const res = imHaus(() => backfillConsignmentPayouts('branch-main'));
  const liveNach = n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'CONSIGNMENT_PAYOUT' AND metadata_json LIKE '%cons-live%'");
  ok(liveNach === liveVor && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_id = 'cp-cons-live'") === 0,
    `3 live gebuchtes Consignment: keine zweite Buchung (${liveVor}→${liveNach})`);
  // Negativkontrolle: das Consignment ohne Buchung wird nachgebucht.
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_id = 'cp-cons-alt'") === 2 && res.posted === 1 && res.skipped === 1,
    `3 NEG ungebuchtes Consignment wird nachgebucht (posted ${res.posted}, skipped ${res.skipped})`);
}

// ══ 4 — recordRefundPayment: Methodenwechsel bei Teil-Erstattung ════════════════
{
  const db = neu();
  const inv = rechnung('p2', 'cust-1', 1100);
  const rid = retoure(inv, 'cash');
  const m1 = meldung(() => imHaus(() => useSalesReturnStore.getState().recordRefundPayment(rid, 300, 'cash')));
  useSalesReturnStore.getState().loadReturns();
  ok(m1 === '' && n(db, 'SELECT refund_paid_amount FROM sales_returns WHERE id = ?', [rid]) === 300, `4 SETUP Teil-Erstattung 300 bar (${m1})`);
  const vor = zustand(db);
  const m2 = meldung(() => imHaus(() => useSalesReturnStore.getState().recordRefundPayment(rid, 300, 'bank')));
  ok(/already partly refunded by cash/.test(m2), `4 zweite Teil-Erstattung per Bank: abgelehnt (${m2})`);
  ok(zustand(db) === vor, '4 …nichts geändert');
  useSalesReturnStore.getState().loadReturns();
  const m3 = meldung(() => imHaus(() => useSalesReturnStore.getState().recordRefundPayment(rid, 300, 'cash')));
  ok(m3 === '' && n(db, 'SELECT refund_paid_amount FROM sales_returns WHERE id = ?', [rid]) === 600, `4 NEG dieselbe Methode (bar) läuft weiter (${m3})`);
}

// ══ 5 — cancelInvoiceInHouse: unbezahlt mit wirksamer Retoure/Gutschrift ═════════
{
  const db = neu();
  product(db, 'p5', 1); product(db, 'p5b', 1); reload();
  // Teil-Retoure (eine von zwei Zeilen) — eine Voll-Retoure macht die Rechnung RETURNED (andere Sperre).
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE('p5'), LINE('p5b')], 'x').id);
  reload();
  const l5 = s(db, "SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = 'p5'", [inv]);
  imHaus(() => {
    const rid = useSalesReturnStore.getState().createReturn({
      invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'defekt',
      lines: [{ invoiceLineId: l5, productId: 'p5', quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
  });
  reload();
  ok(n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]) === 0 && n(db, "SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED'", [inv]) === 1,
    `5 SETUP unbezahlte Rechnung (${s(db, 'SELECT status FROM invoices WHERE id = ?', [inv])}) mit freigegebener Teil-Retoure + Gutschrift`);
  const vor = zustand(db);
  const c = wirft(() => imHaus(() => cancelInvoiceInHouse({ invoiceId: inv, refundMethod: 'cash' }, 'branch-main')));
  ok(c === 'INVOICE_HAS_RETURNS', `5 Storno abgelehnt: INVOICE_HAS_RETURNS (${c})`);
  ok(zustand(db) === vor, '5 …nichts geändert');
  // Negativkontrolle: unbezahlt ohne Retoure → Storno läuft.
  const inv2 = rechnung('p2', 'cust-1', 0);
  const c2 = wirft(() => imHaus(() => cancelInvoiceInHouse({ invoiceId: inv2, refundMethod: 'cash' }, 'branch-main')));
  ok(c2 === '' && s(db, 'SELECT status FROM invoices WHERE id = ?', [inv2]) === 'CANCELLED', `5 NEG ohne Retoure: Storno läuft (${c2})`);
}

// ══ 6 — assertLotTrackedLinesResolved (createDirectInvoice) ══════════════════════
{
  const db = neu();
  product(db, 'p-leer', 1);
  db.run("UPDATE stock_lots SET qty_remaining = 0, status = 'DEPLETED' WHERE id = 'lot-p-leer'");
  product(db, 'p-storno', 1);
  db.run("UPDATE stock_lots SET status = 'CANCELLED' WHERE id = 'lot-p-storno'");
  product(db, 'p-service', null);
  reload();
  for (const pid of ['p-leer', 'p-storno']) {
    const vorInv = n(db, 'SELECT COUNT(*) FROM invoices');
    const vor = zustand(db);
    const m = meldung(() => imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE(pid)], 'x')));
    ok(m === STOCK_UNAVAILABLE_MESSAGE, `6 ${pid} (Lose, keins offen): abgelehnt mit STOCK_UNAVAILABLE (${m})`);
    ok(n(db, 'SELECT COUNT(*) FROM invoices') === vorInv && zustand(db) === vor, `6 ${pid} …keine Rechnung angelegt, nichts geändert`);
  }
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE('p-service')], 'x')));
  ok(m === '' && n(db, "SELECT COUNT(*) FROM invoice_lines WHERE product_id = 'p-service'") === 1, `6 NEG Produkt ganz ohne Lose: fakturierbar (${m})`);
}

// ══ 7 — deleteInvoice: CANCELLED und mit Retoure/Gutschrift gesperrt ═════════════
{
  const db = neu();
  product(db, 'p7', 3); reload();
  const invC = rechnung('p7', 'cust-1', 0);
  imHaus(() => cancelInvoiceInHouse({ invoiceId: invC, refundMethod: 'cash' }, 'branch-main'));
  reload();
  ok(s(db, 'SELECT status FROM invoices WHERE id = ?', [invC]) === 'CANCELLED', '7 SETUP stornierte Rechnung');
  const lotVor = lotRem(db, 'lot-p7');
  const vor = zustand(db);
  const m1 = meldung(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(invC)));
  ok(/Cannot delete a cancelled invoice/.test(m1), `7 CANCELLED löschen: abgelehnt (${m1})`);
  ok(zustand(db) === vor && lotRem(db, 'lot-p7') === lotVor, `7 …Lose unverändert (${lotVor})`);

  const invR = rechnung('p7', 'cust-1', 0);
  retoure(invR, 'cash', 'p7');
  const lotVor2 = lotRem(db, 'lot-p7');
  const vor2 = zustand(db);
  const m2 = meldung(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(invR)));
  ok(/Cannot delete an invoice with a return or credit note/.test(m2), `7 mit Retoure/Gutschrift löschen: abgelehnt (${m2})`);
  ok(zustand(db) === vor2 && lotRem(db, 'lot-p7') === lotVor2, `7 …Lose unverändert (${lotVor2})`);

  // Negativkontrolle: einfache Rechnung löschen gibt das Los zurück.
  const invN = rechnung('p7', 'cust-1', 0);
  const lotVor3 = lotRem(db, 'lot-p7');
  const m3 = meldung(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(invN)));
  ok(m3 === '' && lotRem(db, 'lot-p7') === lotVor3 + 1, `7 NEG normale Rechnung löschen läuft, Los +1 (${lotVor3}→${lotRem(db, 'lot-p7')}) ${m3}`);
}

// ══ 8 — cancelReturnInHouse: Stück schon wieder verkauft ════════════════════════
{
  const db = neu();
  const inv = rechnung('p2', 'cust-1', 0);
  const rid = retoure(inv, 'cash');
  ok(lotRem(db, 'lot-p2') === 1, '8 SETUP Retoure IN_STOCK: Los wieder 1');
  rechnung('p2', 'cust-2', 0);
  ok(lotRem(db, 'lot-p2') === 0, '8 SETUP Stück wiederverkauft: Los 0');
  const vor = zustand(db);
  const c = wirft(() => imHaus(() => cancelReturnHouse.cancelReturnInHouse(rid, 'Storno', OWNER_ACTOR, 'branch-main')));
  ok(c === 'RETURN_STOCK_RESOLD', `8 Retoure-Storno abgelehnt: RETURN_STOCK_RESOLD (${c})`);
  ok(zustand(db) === vor, '8 …nichts geändert');
  // Negativkontrolle: ohne Wiederverkauf läuft der Storno.
  const db2 = neu();
  const inv2 = rechnung('p2', 'cust-1', 0);
  const rid2 = retoure(inv2, 'cash');
  const c2 = wirft(() => imHaus(() => cancelReturnHouse.cancelReturnInHouse(rid2, 'Storno', OWNER_ACTOR, 'branch-main')));
  ok(c2 === '' && s(db2, 'SELECT status FROM sales_returns WHERE id = ?', [rid2]) === 'REJECTED' && lotRem(db2, 'lot-p2') === 0,
    `8 NEG ohne Wiederverkauf: Storno läuft, Los wieder 0 (${c2})`);
}

// ══ 9 — cancelPurchaseInHouse: Ware aus dem Einkauf steht auf einer Rechnung ══════
{
  const db = neu();
  product(db, 'p9', null);
  product(db, 'p9b', null);
  reload();
  const kauf = (pid: string): string => imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1',
    lines: [{ productId: pid, quantity: 1, unitPrice: 500, taxScheme: 'ZERO' as const, vatRate: 0 }],
  } as never).id);
  const pid = kauf('p9');
  reload();
  const lot = s(db, 'SELECT id FROM stock_lots WHERE purchase_id = ?', [pid]);
  ok(lot !== '', '9 SETUP Einkauf legt ein Los mit purchase_id an');
  const inv = rechnung('p9', 'cust-1', 0);
  ok(s(db, 'SELECT lot_id FROM invoice_lines WHERE invoice_id = ?', [inv]) === lot, '9 SETUP die Rechnung verbraucht genau dieses Los');
  const vor = zustand(db);
  const c = wirft(() => imHaus(() => cancelPurchaseInHouse(pid, 'branch-main')));
  ok(c === 'PURCHASE_STOCK_SOLD', `9 Einkauf-Storno abgelehnt: PURCHASE_STOCK_SOLD (${c})`);
  ok(zustand(db) === vor, '9 …nichts geändert');
  // Negativkontrolle: unverkaufter Einkauf lässt sich stornieren.
  const pidB = kauf('p9b');
  reload();
  const c2 = wirft(() => imHaus(() => cancelPurchaseInHouse(pidB, 'branch-main')));
  ok(c2 === '' && s(db, 'SELECT status FROM purchases WHERE id = ?', [pidB]) === 'CANCELLED', `9 NEG unverkaufter Einkauf: Storno läuft (${c2})`);
  // Negativkontrolle: verkauft, aber voll zurückgenommen (wirksame Retoure) → Storno erlaubt.
  product(db, 'p9c', null);
  reload();
  const pidC = kauf('p9c');
  reload();
  const invC = rechnung('p9c', 'cust-1', 0);
  const ridC = retoure(invC, 'cash', 'p9c');
  ok(s(db, 'SELECT status FROM sales_returns WHERE id = ?', [ridC]) !== 'REJECTED'
    && n(db, 'SELECT COUNT(*) FROM sales_return_lines WHERE return_id = ?', [ridC]) === 1,
  '9 SETUP verkaufte Zeile voll zurückgenommen (wirksame Retoure)');
  const c3 = wirft(() => imHaus(() => cancelPurchaseInHouse(pidC, 'branch-main')));
  ok(c3 === '' && s(db, 'SELECT status FROM purchases WHERE id = ?', [pidC]) === 'CANCELLED',
    `9 NEG verkauft + voll retourniert: Storno läuft (${c3})`);
  // Und die Retoure macht nur IHRE Zeile frei: der erste Einkauf bleibt gesperrt.
  ok(wirft(() => imHaus(() => cancelPurchaseInHouse(pid, 'branch-main'))) === 'PURCHASE_STOCK_SOLD',
    '9 …der verkaufte, nicht retournierte Einkauf bleibt gesperrt');
}

// ══ 10 — scrapTradeStore backfillTradeData: line_key + branch_id ═════════════════
{
  const db = neu();
  insert(db, 'scrap_trades', {
    id: 'st-legacy', branch_id: 'branch-main', weight_grams: 5, karat: '22K', purchase_price: 100, sale_price: 130, profit: 30,
    images_purchase: '[]', images_sale: '[]', created_at: NOW, updated_at: NOW,
  });
  ok(n(db, "SELECT COUNT(*) FROM scrap_trade_lines WHERE scrap_trade_id = 'st-legacy'") === 0, '10 SETUP Alt-Handel ohne Zeilen');
  useScrapTradeStore.getState().loadTrades();
  const r = db.exec("SELECT id, line_key, branch_id FROM scrap_trade_lines WHERE scrap_trade_id = 'st-legacy'")[0]?.values ?? [];
  ok(r.length === 1, `10 loadTrades legt genau eine Zeile an (${r.length})`);
  ok(r.length === 1 && String(r[0][1]) === String(r[0][0]) && String(r[0][2]) === 'branch-main',
    `10 …mit line_key = id und branch_id des Handels (${S(r[0])})`);
  useScrapTradeStore.getState().loadTrades();
  ok(n(db, "SELECT COUNT(*) FROM scrap_trade_lines WHERE scrap_trade_id = 'st-legacy'") === 1, '10 …idempotent beim zweiten Laden');
}

// ══ 11/12 — Medien: Auftrags-Storno und Merge ══════════════════════════════════
const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 53 + i * 3) & 0xff);
const url = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const linksOf = (db: Db, type: string, id: string, role?: string): string[] =>
  (db.exec(
    `SELECT media_id FROM media_links WHERE entity_type = ? AND entity_id = ?${role ? ' AND media_role = ?' : ''} AND deleted_at IS NULL ORDER BY sort_order`,
    role ? [type, id, role] : [type, id],
  )[0]?.values ?? []).map((v) => String(v[0]));
const LEER = {
  customerId: 'cust-1', orderType: 'normal', lines: [], quotedPrice: 0, customTaxScheme: 'MARGIN', finalProductDescription: '',
  customProductSpec: undefined, customerGoldGrams: 0, customerGoldKarat: '22K', customerStones: '', goldsmithSupplierId: '',
  laborCost: 0, extraGoldGrams: 0, extraGoldKarat: '22K', extraGoldCost: 0, extraGoldSupplierId: '', materials: [],
  depositAmount: 0, paymentMethod: 'cash', cardBrand: 'normal', fullyPaid: false, expectedDelivery: '', status: 'pending', notes: '',
};
const ORDER = (bilder: string[]) => ({
  ...LEER, orderType: 'custom', quotedPrice: 500, finalProductDescription: 'Ring nach Vorlage',
  lines: [{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }],
  customProductSpec: { categoryId: 'cat-w', brand: 'Eigen', name: 'Ring', sku: '', condition: 'New', taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {}, images: bilder },
});

{
  const db = neu();
  const made = await orderHouse.createOrderOnPrimary(ORDER([url(bild(1)), url(bild(2))]) as never);
  const orderId = made.order.id;
  const vorlage = linksOf(db, 'order', orderId, 'reference_image');
  ok(vorlage.length === 2, `11 SETUP Auftrag mit zwei Vorlagebildern (${vorlage.length})`);
  // Angefangene Arbeit: eine realisierte Kostenzeile (ARRIVED, mit Expense).
  insert(db, 'order_lines', {
    id: 'ol-cost', order_id: orderId, description: 'Goldschmied', quantity: 1, is_customer_facing: 0,
    cost_amount: 200, expense_id: 'exp-1', status: 'ARRIVED', created_at: NOW, updated_at: NOW,
  });
  useOrderStore.getState().loadOrders();
  let eff: { stockProductId?: string } = {};
  const m = meldung(() => { eff = imHaus(() => useOrderStore.getState().cancelOrderWithMoney(orderId, 'forfeit')); });
  ok(m === '' && !!eff.stockProductId, `11 Storno mit angefangener Arbeit legt ein Lagerstück an (${m} ${eff.stockProductId ?? ''})`);
  const bilder = eff.stockProductId ? linksOf(db, 'product', eff.stockProductId, 'stock_image') : [];
  ok(S(bilder) === S(vorlage), `11 …und es trägt dieselben Vorlage-Medien als stock_image (${bilder.length})`);
}

{
  const db = neu();
  const made = await orderHouse.createOrderOnPrimary(ORDER([url(bild(7)), url(bild(8))]) as never);
  const quelle = useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Q', name: 'Quelle', images: [] } as never);
  const ziel = useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Z', name: 'Ziel', images: [] } as never);
  orderMedia.adoptOrderPhotosToProduct(made.order.id, quelle.id);
  const galerie = linksOf(db, 'product', quelle.id, 'stock_image');
  ok(galerie.length === 2 && linksOf(db, 'product', ziel.id).length === 0, '12 SETUP Quelle mit zwei Fotos, Ziel ohne');
  useProductStore.getState().loadProducts();
  const m = meldung(() => imHaus(() => useProductStore.getState().mergeIntoExisting(quelle.id, ziel.id)));
  ok(m === '', `12 mergeIntoExisting läuft (${m})`);
  ok(S(linksOf(db, 'product', ziel.id, 'stock_image')) === S(galerie), '12 …Ziel übernimmt die Galerie der Quelle (dieselben Medien)');
  ok(linksOf(db, 'product', quelle.id).length === 0
    && n(db, "SELECT COUNT(*) FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND deleted_at IS NOT NULL", [quelle.id]) === 2,
  '12 …die Verknüpfungen der Quelle sind zurückgezogen');
  ok(n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [quelle.id]) === 0, '12 …und die Quelle ist gelöscht');
}

console.log(`\npost-0858-guards: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
