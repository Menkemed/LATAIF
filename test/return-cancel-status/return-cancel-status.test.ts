// ════════════════════════════════════════════════════════════════════════════
// RETURN-CANCEL-STATUS — Bestand ist die Wahrheit, der Verkaufsstatus ist daraus abgeleitet.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores und
// Hausfolgen — wie stock-lot-integrity / lot-vat-cost.
// Run: node --experimental-strip-types test/return-cancel-status/return-cancel-status.test.ts
//
//   1 10 Stück, 1 verkauft, retourniert, Retoure-Storno → 9, in_stock   2 Teilretoure
//   3 zwei Retouren derselben Zeile   4 Einzelstück unbezahlt → reserved   5 Einzelstück FINAL → sold
//   6 ohne Los (Menge 10 / Einzelstück)   7 bezahlte Rechnung bearbeiten A → B → C   8 bezahlte löschen
//   9 Kommission (unbezahlt / bezahlt)   10 Sonderstatus bleiben (with_agent, echte Reparatur)
//   11 ein Weg für Primary und PC2
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

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
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-07T10:00:00.000Z';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
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
  usePurchaseStore.getState().loadPurchases();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
}

/** Artikel ohne Los; `price` = sein (Brutto-)Einkaufspreis wie nach einem Einkauf. */
function product(db: Db, id: string, price: number, qty = 0): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Silver',?,?,?,'New','[]',?,'BHD',150,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
  [id, 'Item ' + id, 'SKU-' + id, qty, price, NOW, NOW]);
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
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Test','Kunde','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
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
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };

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
async function meldungAsync(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}

/** Einkauf: Stückpreis BRUTTO, wie die Maske ihn nimmt. */
function kauf(productId: string, quantity: number, unitPrice: number, vat: boolean): string {
  const id = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1',
    lines: [{ productId, quantity, unitPrice, taxScheme: vat ? 'VAT_10' as const : 'ZERO' as const, vatRate: vat ? 10 : 0 }],
  }).id);
  reload();
  return id;
}
/** Verkauf ohne Losangabe — das Haus nimmt das älteste Los und dessen Einstand. */
const LINE = (productId: string, qty = 1, price = 1000, scheme: 'VAT_10' | 'MARGIN' = 'VAT_10') => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 0, taxScheme: scheme, vatRate: 10,
  vatAmount: scheme === 'VAT_10' ? (price * qty) / 10 : 0, lineTotal: scheme === 'VAT_10' ? price * qty * 1.1 : price * qty,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', lines as never, 'LVC').id);
  reload();
  return id;
}
function voll(db: Db, invId: string): void {
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
}
function retoure(db: Db, invId: string, productId: string): string {
  const lineId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [invId]);
  const id = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const rid = rs.createReturn({
      invoiceId: invId, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'defekt',
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
const neu = (): Db => { DB = freshDb(); return DB; };

// ── Messgrößen ──
/** Saldo INVENTORY über das ganze Hauptbuch (Storni sind Gegenbuchungen). */
const inventory = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'INVENTORY'"));
const lotsValue = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED' AND qty_remaining > 0"));
const lotOf = (db: Db, pid: string): string => s(db, 'SELECT id FROM stock_lots WHERE purchase_id = ?', [pid]);
const unitCost = (db: Db, lot: string): number => n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]);
const lotRem = (db: Db, lot: string): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);
const purchaseLeg = (db: Db, pid: string, account: string, dir: string): number =>
  r3(n(db, 'SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE source_module = ? AND source_id = ? AND account = ? AND direction = ?', ['PURCHASE', pid, account, dir]));
const cogsOf = (db: Db, invId: string): number =>
  r3(n(db, "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE source_module = 'INVOICE' AND source_id = ? AND account = 'COGS' AND direction = 'DEBIT'", [invId]));
const invariant = (db: Db, tag: string): void => {
  const a = inventory(db); const b = lotsValue(db);
  ok(eq(a, b), `${tag} Invariante: INVENTORY ${a} == Restwert der Lose ${b}`);
};

const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');

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

const st = (db: Db, pid: string): string => s(db, 'SELECT stock_status FROM products WHERE id = ?', [pid]);
const qty = (db: Db, pid: string): number => n(db, 'SELECT quantity FROM products WHERE id = ?', [pid]);
const invStatus = (db: Db, id: string): string => s(db, 'SELECT status FROM invoices WHERE id = ?', [id]);
/** Status, Menge und Restbestand in einem Satz — und ob sie zueinander passen. */
function stand(db: Db, pid: string, lot: string | null, want: { status: string; rest: number }, tag: string): void {
  const rest = lot ? lotRem(db, lot) : qty(db, pid);
  ok(st(db, pid) === want.status && rest === want.rest && qty(db, pid) === want.rest,
    `${tag}: ${want.status}, Rest ${want.rest} (ist ${st(db, pid)}, Rest ${rest}, quantity ${qty(db, pid)})`);
  const s0 = st(db, pid);
  ok(rest > 0 ? ['in_stock', 'consignment', 'offered'].includes(s0) : ['sold', 'reserved', 'consignment_reserved'].includes(s0),
    `${tag} …Status passt zum Bestand (${s0} bei Rest ${rest})`);
}
function ret(db: Db, invId: string, productId: string, q: number, disposition = 'IN_STOCK', approve = true): string {
  const lineId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [invId, productId]);
  // Je Stück, was die Zeile wirklich kostete (brutto) und an Steuer trug.
  const lq = n(db, 'SELECT quantity FROM invoice_lines WHERE id = ?', [lineId]) || 1;
  const unit = n(db, 'SELECT line_total FROM invoice_lines WHERE id = ?', [lineId]) / lq;
  const vat = n(db, 'SELECT vat_amount FROM invoice_lines WHERE id = ?', [lineId]) / lq;
  const id = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const rid = rs.createReturn({
      invoiceId: invId, refundMethod: 'cash', productDisposition: disposition, reason: 'test',
      lines: [{ invoiceLineId: lineId, productId, quantity: q, unitPrice: unit, vatAmount: vat * q }],
    } as never).id;
    if (approve) { useSalesReturnStore.getState().loadReturns(); useSalesReturnStore.getState().approveReturn(rid); }
    return rid;
  });
  reload();
  return id;
}
function storno(rid: string): string {
  const m = meldung(() => imHaus(() => cancelReturnHouse.cancelReturnInHouse(rid, 'Storno', OWNER_ACTOR, 'branch-main')));
  reload();
  return m;
}

// ══ 1 — 10 Stück, 1 verkauft + bezahlt, retourniert, Retoure storniert ═══════════
{
  const db = neu(); product(db, 'pA', 100); reload();
  const lot = lotOf(db, kauf('pA', 10, 100, false));
  const inv = rechnung([LINE('pA', 1)]); voll(db, inv);
  stand(db, 'pA', lot, { status: 'in_stock', rest: 9 }, '1 nach Verkauf + Zahlung');
  const rid = ret(db, inv, 'pA', 1);
  stand(db, 'pA', lot, { status: 'in_stock', rest: 10 }, '1 nach Retoure');
  ok(storno(rid) === '', '1 Retoure-Storno läuft');
  stand(db, 'pA', lot, { status: 'in_stock', rest: 9 }, '1 nach Retoure-Storno (vorher: sold bei 9 Stück)');
}

// ══ 2 — Teilretoure (Zeile 2 Stück, 1 zurück) ══════════════════════════════════
{
  const db = neu(); product(db, 'pB', 100); reload();
  const lot = lotOf(db, kauf('pB', 10, 100, false));
  const inv = rechnung([LINE('pB', 2)]); voll(db, inv);
  const rid = ret(db, inv, 'pB', 1);
  stand(db, 'pB', lot, { status: 'in_stock', rest: 9 }, '2 nach Teilretoure');
  ok(storno(rid) === '', '2 Retoure-Storno läuft');
  stand(db, 'pB', lot, { status: 'in_stock', rest: 8 }, '2 nach Retoure-Storno');
}

// ══ 3 — zwei Retouren derselben Zeile, eine storniert ═══════════════════════════
{
  const db = neu(); product(db, 'pC', 100); reload();
  const lot = lotOf(db, kauf('pC', 10, 100, false));
  const inv = rechnung([LINE('pC', 3)]); voll(db, inv);
  const r1 = ret(db, inv, 'pC', 1); const r2 = ret(db, inv, 'pC', 1);
  stand(db, 'pC', lot, { status: 'in_stock', rest: 9 }, '3 nach zwei Retouren');
  ok(storno(r1) === '', '3 Storno der ersten Retoure läuft');
  stand(db, 'pC', lot, { status: 'in_stock', rest: 8 }, '3 nach Storno R1');
  ok(s(db, 'SELECT status FROM sales_returns WHERE id = ?', [r2]) !== 'REJECTED', '3 …die zweite Retoure bleibt wirksam');
}

// ══ 4 — Einzelstück, unbezahlte Rechnung ══════════════════════════════════════
{
  const db = neu(); product(db, 'pD', 100); reload();
  const lot = lotOf(db, kauf('pD', 1, 100, false));
  const inv = rechnung([LINE('pD', 1)]);
  stand(db, 'pD', lot, { status: 'reserved', rest: 0 }, '4 nach Verkauf (unbezahlt)');
  const rid = ret(db, inv, 'pD', 1);
  stand(db, 'pD', lot, { status: 'in_stock', rest: 1 }, '4 nach Retoure');
  ok(storno(rid) === '' && invStatus(db, inv) !== 'FINAL', `4 Retoure-Storno läuft, Rechnung nicht FINAL (${invStatus(db, inv)})`);
  stand(db, 'pD', lot, { status: 'reserved', rest: 0 }, '4 nach Retoure-Storno (vorher: sold)');
}

// ══ 5 — Einzelstück, FINAL ════════════════════════════════════════════════════
{
  const db = neu(); product(db, 'pE', 100); reload();
  const lot = lotOf(db, kauf('pE', 1, 100, false));
  const inv = rechnung([LINE('pE', 1)]); voll(db, inv);
  stand(db, 'pE', lot, { status: 'sold', rest: 0 }, '5 nach Verkauf + Zahlung');
  const rid = ret(db, inv, 'pE', 1);
  ok(storno(rid) === '' && invStatus(db, inv) === 'FINAL', `5 Retoure-Storno läuft, Rechnung FINAL (${invStatus(db, inv)})`);
  stand(db, 'pE', lot, { status: 'sold', rest: 0 }, '5 nach Retoure-Storno');
}

// ══ 6 — Artikel ohne Los, Menge 10 ═════════════════════════════════════════════
{
  const db = neu(); product(db, 'pF', 100, 10); reload();
  const inv = rechnung([LINE('pF', 1)]); voll(db, inv);
  const rid = ret(db, inv, 'pF', 1);
  stand(db, 'pF', null, { status: 'in_stock', rest: 10 }, '6 nach Retoure (ohne Los)');
  ok(storno(rid) === '', '6 Retoure-Storno läuft');
  stand(db, 'pF', null, { status: 'in_stock', rest: 9 }, '6 nach Retoure-Storno (ohne Los)');
  ok(n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = 'pF'") === 0, '6 …kein Los entstanden');
  // Einzelstück ohne Los, unbezahlt: dieselbe Regel.
  product(db, 'pF1', 100, 1); reload();
  const inv1 = rechnung([LINE('pF1', 1)]);
  const rid1 = ret(db, inv1, 'pF1', 1);
  ok(storno(rid1) === '', '6 Einzelstück ohne Los: Storno läuft');
  stand(db, 'pF1', null, { status: 'reserved', rest: 0 }, '6 Einzelstück ohne Los, unbezahlt');
}

// ══ 7 — Bezahlte Rechnung bearbeiten: A → B ═════════════════════════════════════
{
  const db = neu(); product(db, 'pJa', 100); product(db, 'pJb', 100); product(db, 'pJc', 100); reload();
  const la = lotOf(db, kauf('pJa', 1, 100, false)); const lb = lotOf(db, kauf('pJb', 1, 100, false));
  const lc = lotOf(db, kauf('pJc', 5, 100, false));
  const inv = rechnung([LINE('pJa', 1)]); voll(db, inv);
  stand(db, 'pJa', la, { status: 'sold', rest: 0 }, '7 A nach Verkauf + Zahlung');
  const e = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('pJb', 1)] as never, reason: 'falscher Artikel' })));
  reload();
  ok(e === '' && invStatus(db, inv) === 'FINAL', `7 Bearbeiten läuft, Rechnung bleibt FINAL (${e} ${invStatus(db, inv)})`);
  stand(db, 'pJa', la, { status: 'in_stock', rest: 1 }, '7 A zurück im Bestand (vorher: sold)');
  stand(db, 'pJb', lb, { status: 'sold', rest: 0 }, '7 B aufgebraucht an FINAL (vorher: in_stock bei 0)');
  // B → C (Mengenartikel 5): C behält Rest → in_stock; B wieder verkaufbar.
  const e2 = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('pJc', 1)] as never, reason: 'nochmal' })));
  reload();
  ok(e2 === '', `7 zweites Bearbeiten läuft (${e2})`);
  stand(db, 'pJb', lb, { status: 'in_stock', rest: 1 }, '7 B zurück');
  stand(db, 'pJc', lc, { status: 'in_stock', rest: 4 }, '7 C mit Restbestand bleibt in_stock');
}

// ══ 8 — Bezahlte Rechnung löschen ══════════════════════════════════════════════
{
  const db = neu(); product(db, 'pK', 100); reload();
  const lot = lotOf(db, kauf('pK', 1, 100, false));
  const inv = rechnung([LINE('pK', 1)]); voll(db, inv);
  const d = meldung(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(inv)));
  reload();
  ok(d === '', `8 Löschen läuft (${d})`);
  stand(db, 'pK', lot, { status: 'in_stock', rest: 1 }, '8 nach Löschen (vorher: sold)');
}

// ══ 9 — Kommission: Gegenprobe ═════════════════════════════════════════════════
function kommission(db: Db, pid: string, cid: string): { invoiceId: string; purchaseId: string } {
  product(db, pid, 0, 1);
  db.run("UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT', purchase_price = 0 WHERE id = ?", [pid]);
  insert(db, 'consignments', {
    id: cid, branch_id: 'branch-main', consignment_number: 'CN-' + cid, consignor_id: 'cust-1', product_id: pid,
    agreed_price: 1000, commission_rate: 15, commission_type: 'percent', status: 'active', agreement_date: '2026-09-01',
    created_at: NOW, updated_at: NOW,
  });
  db.run(`INSERT OR IGNORE INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-2','branch-main','Test','Käufer','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  reload();
  useConsignmentStore.getState().loadConsignments();
  const r = imHaus(() => useConsignmentStore.getState().recordSale(cid, { salePrice: 1000, buyerId: 'cust-2' }));
  reload();
  return r as { invoiceId: string; purchaseId: string };
}
{
  const db = neu();
  const r = kommission(db, 'pKo', 'cons-1');
  const lot = lotOf(db, r.purchaseId);
  stand(db, 'pKo', lot, { status: 'consignment_reserved', rest: 0 }, '9 Kommission verkauft (unbezahlt)');
  const rid = ret(db, r.invoiceId, 'pKo', 1);
  ok(lotRem(db, lot) === 1, '9 …Retoure gibt das Stück zurück');
  ok(storno(rid) === '', '9 Retoure-Storno läuft');
  stand(db, 'pKo', lot, { status: 'consignment_reserved', rest: 0 }, '9 Kommission nach Retoure-Storno (unbezahlt)');
}
{
  const db = neu();
  const r = kommission(db, 'pKp', 'cons-2');
  const lot = lotOf(db, r.purchaseId);
  voll(db, r.invoiceId);
  stand(db, 'pKp', lot, { status: 'sold', rest: 0 }, '9 Kommission bezahlt');
  const rid = ret(db, r.invoiceId, 'pKp', 1);
  ok(storno(rid) === '', '9 Retoure-Storno (bezahlt) läuft');
  stand(db, 'pKp', lot, { status: 'sold', rest: 0 }, '9 Kommission bezahlt nach Retoure-Storno');
}

// ══ 10 — Sonderstatus bleiben unberührt ═════════════════════════════════════════
{
  const db = neu(); product(db, 'pW', 100); reload();
  const lot = lotOf(db, kauf('pW', 10, 100, false));
  const inv = rechnung([LINE('pW', 1)]); voll(db, inv);
  const rid = ret(db, inv, 'pW', 1);
  db.run("UPDATE products SET stock_status = 'with_agent' WHERE id = 'pW'"); reload();
  ok(storno(rid) === '', '10 Storno läuft, während der Artikel beim Agenten ist');
  ok(st(db, 'pW') === 'with_agent' && lotRem(db, lot) === 9, `10 …with_agent bleibt, Bestand 9 (${st(db, 'pW')}/${lotRem(db, lot)})`);
  // UNDER_REPAIR-Retoure eines EINZELSTÜCKS (kein Bestand mehr am Lager): ihr eigenes in_repair wird zurückgenommen …
  const db2 = neu(); product(db2, 'pR', 100); reload();
  const lot2 = lotOf(db2, kauf('pR', 1, 100, false));
  const inv2 = rechnung([LINE('pR', 1)]); voll(db2, inv2);
  const rr = ret(db2, inv2, 'pR', 1, 'UNDER_REPAIR');
  ok(st(db2, 'pR') === 'in_repair', '10 UNDER_REPAIR-Retoure des Einzelstücks setzt in_repair');
  ok(storno(rr) === '', '10 Storno der UNDER_REPAIR-Retoure läuft');
  stand(db2, 'pR', lot2, { status: 'sold', rest: 0 }, '10 …eigenes in_repair zurückgenommen (vorher: sold)');
  // … aber nicht, wenn seither eine echte Reparatur angelegt wurde.
  const rr2 = ret(db2, inv2, 'pR', 1, 'UNDER_REPAIR');
  insert(db2, 'repairs', { id: 'rep-1', branch_id: 'branch-main', product_id: 'pR', status: 'received', created_at: '2999-01-01T00:00:00.000Z', updated_at: NOW });
  ok(storno(rr2) === '' && st(db2, 'pR') === 'in_repair', `10 …mit Reparatur seit der Retoure bleibt in_repair (${st(db2, 'pR')})`);
}

// ══ 12 — Teil-Retoure mit Disposition: der Status folgt dem Restbestand ═════════════
// Ein Stück in Reparatur oder abgeschrieben kehrt nicht ins Lager zurück. Bleibt danach Ware am Lager,
// bleibt der Artikel verkäuflich — der Status gilt für den ganzen Artikel. Nur wenn nichts mehr am Lager
// ist, steht er auf in_repair / write_off (wie bisher beim Einzelstück).
{
  const welt = (pid: string, lager = 10, menge = 3) => {
    const db = neu(); product(db, pid, 100); reload();
    const lot = lotOf(db, kauf(pid, lager, 100, false));
    const inv = rechnung([LINE(pid, menge)]); voll(db, inv);
    return { db, lot, inv };
  };
  { // a) Teilmenge IN_STOCK
    const { db, lot, inv } = welt('pT1');
    const rid = ret(db, inv, 'pT1', 1);
    stand(db, 'pT1', lot, { status: 'in_stock', rest: 8 }, '12a Teil-Retoure IN_STOCK (1 von 3): Stück zurück ins Lager');
    ok(storno(rid) === '', '12a Storno läuft');
    stand(db, 'pT1', lot, { status: 'in_stock', rest: 7 }, '12a …nach Storno');
  }
  for (const [pid, disp] of [['pT2', 'UNDER_REPAIR'], ['pT3', 'WRITE_OFF']] as const) { // b/c) Teilmenge UNDER_REPAIR / WRITE_OFF
    const { db, lot, inv } = welt(pid);
    const rid = ret(db, inv, pid, 1, disp);
    stand(db, pid, lot, { status: 'in_stock', rest: 7 }, `12 Teil-Retoure ${disp} (1 von 3): Artikel bleibt verkäuflich, das Stück geht nicht ins Lager`);
    ok(storno(rid) === '', `12 Storno der ${disp}-Teil-Retoure läuft`);
    stand(db, pid, lot, { status: 'in_stock', rest: 7 }, `12 …nach Storno unverändert verkäuflich`);
  }
  { // d) volle Zeilenmenge, aber noch Ware am Lager
    const { db, lot, inv } = welt('pT4');
    ret(db, inv, 'pT4', 3, 'UNDER_REPAIR');
    stand(db, 'pT4', lot, { status: 'in_stock', rest: 7 }, '12d volle Zeile (3 von 3) UNDER_REPAIR, 7 am Lager: bleibt verkäuflich');
  }
  for (const [pid, disp, want] of [['pT5', 'UNDER_REPAIR', 'in_repair'], ['pT6', 'WRITE_OFF', 'write_off']] as const) { // e) nichts mehr am Lager
    const { db, lot, inv } = welt(pid, 3, 3);
    const rid = ret(db, inv, pid, 1, disp);
    ok(st(db, pid) === want && lotRem(db, lot) === 0, `12e alles verkauft, 1 zurück als ${disp}: ${want} wie bisher (${st(db, pid)})`);
    ok(storno(rid) === '', `12e Storno der ${disp}-Retoure läuft`);
    stand(db, pid, lot, { status: 'sold', rest: 0 }, `12e …${want} zurückgenommen, wieder verkauft`);
  }
  { // f) gemischt — eine Disposition je Retoure: dieselbe Zeile, 1 IN_STOCK und 1 UNDER_REPAIR
    const { db, lot, inv } = welt('pT7');
    const r1 = ret(db, inv, 'pT7', 1);
    const r2 = ret(db, inv, 'pT7', 1, 'UNDER_REPAIR');
    stand(db, 'pT7', lot, { status: 'in_stock', rest: 8 }, '12f gemischt: 1 ins Lager, 1 in Reparatur — verkäuflich, Rest 8');
    ok(storno(r2) === '' && storno(r1) === '', '12f beide Stornos laufen');
    stand(db, 'pT7', lot, { status: 'in_stock', rest: 7 }, '12f …zurück auf den Stand nach dem Verkauf');
  }
}

// ══ 13 — Stückware zählt ganze Stücke: Bruchmengen werden abgewiesen, nichts verschoben ═══════════════
{
  const db = neu(); product(db, 'pF', 100); reload();
  const lot = lotOf(db, kauf('pF', 10, 100, false));
  const fp = (): string => S([lotRem(db, lot), qty(db, 'pF'), st(db, 'pF'), n(db, 'SELECT COUNT(*) FROM invoices'),
    n(db, 'SELECT COUNT(*) FROM invoice_lines'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM sales_returns')]);
  const vor = fp();
  for (const q of [0.5, 1.5]) {
    const m = meldung(() => rechnung([LINE('pF', q)]));
    ok(m.startsWith('PIECE_QUANTITY_NOT_WHOLE'), `13 Verkauf ${q} Stück aus Stück-Los → abgewiesen (${m.slice(0, 60)})`);
  }
  ok(fp() === vor, `13 …nach den Abweisungen: Los, Menge, Status, Rechnungen, Hauptbuch unverändert (${fp()})`);
  const inv = rechnung([LINE('pF', 2)]); voll(db, inv);
  stand(db, 'pF', lot, { status: 'in_stock', rest: 8 }, '13 Ganzstück-Verkauf 2 unverändert');
  const lineId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  const cogsVor = n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'COGS'");
  const vorRet = fp();
  const mr = meldung(() => ret(db, inv, 'pF', 0.5));
  ok(mr.startsWith('PIECE_QUANTITY_NOT_WHOLE'), `13 Retoure 0.5 einer Stück-Los-Zeile → abgewiesen (${mr.slice(0, 60)})`);
  ok(fp() === vorRet && n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'COGS'") === cogsVor,
    '13 …kein Stück zurück ins Los, kein COGS zurückgebucht');
  const rid = ret(db, inv, 'pF', 1);
  stand(db, 'pF', lot, { status: 'in_stock', rest: 9 }, '13 Ganzstück-Retoure 1 unverändert');
  ok(storno(rid) === '', '13 …und ihr Storno');
  stand(db, 'pF', lot, { status: 'in_stock', rest: 8 }, '13 …zurück auf den Stand nach dem Verkauf');
  // Ändern einer Rechnung: dieselbe Regel.
  const me = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, { reason: 'x', lines: [{ lineId, ...LINE('pF', 1.5) }] } as never)));
  ok(me.startsWith('PIECE_QUANTITY_NOT_WHOLE'), `13 Ändern auf 1.5 Stück → abgewiesen (${me.slice(0, 60)})`);
  // Ohne Stückbestand (Dienstleistung) bleibt eine Bruchmenge, wie sie war: kein neues Nein.
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price,
      purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('svc-repair-frac','branch-main','cat-w','Service','Polish','SVC-F',0,'New','[]',0,'BHD',0,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  reload();
  const ms = meldung(() => rechnung([LINE('svc-repair-frac', 0.5, 20)]));
  ok(!ms.startsWith('PIECE_QUANTITY_NOT_WHOLE'), `13 Dienstleistungszeile mit 0.5 wird nicht von der Stück-Regel abgewiesen (${ms || 'angelegt'})`);
  const svc = src('src/stores/salesReturnStore.ts') + src('src/stores/invoiceStore.ts');
  ok((svc.match(/movesPieceStock\(/g) ?? []).length >= 2 && /assertWholePieceLines\(lines\);\s*\n\s*const lineMatch/.test(src('src/stores/invoiceStore.ts')),
    '13 Quelltext: die Regel sitzt in Anlegen, Ändern und Retoure (jeder Weg, auch PC2, läuft hier durch)');
}

// ══ 14 — „Keep as own": nur Kommissionsware, Snapshot beim Anlegen, exakter Storno, Altbestand gesperrt ═══
{
  const { createReturnInHouse } = await import('../../src/core/returns/return-house.ts');
  const consRev = await import('../../src/core/consignment/consignment-reversal-house.ts');
  const { changeContractViolation } = await import('../../src/core/sync/apply-change.ts');
  const prod = (db: Db, pid: string): string =>
    S(db.exec('SELECT source_type, purchase_price, stock_status, quantity FROM products WHERE id = ?', [pid])[0]?.values ?? []);
  const consStatus = (db: Db, cid: string): string => s(db, 'SELECT status FROM consignments WHERE id = ?', [cid]);
  const ausgeglichen = (db: Db): boolean => Math.abs(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.005;
  const lineOfInv = (db: Db, inv: string, pid: string): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, pid]);
  const keepRet = (db: Db, inv: string, pids: string[]): string => {
    const id = imHaus(() => createReturnInHouse({ invoiceId: inv, lines: pids.map((p) => ({ invoiceLineId: lineOfInv(db, inv, p), quantity: 1 })),
      refundMethod: 'cash', productDisposition: 'KEEP_AS_OWN', reason: 'keep', refundNow: true } as never, 'branch-main').returnId);   // CONSIGNMENT-INTEGRITY: der Kommissionsweg erstattet sofort
    reload();
    return id;
  };
  const zaehler = (db: Db): string => S([n(db, 'SELECT COUNT(*) FROM stock_lots'), n(db, 'SELECT COUNT(*) FROM sales_returns'),
    n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM credit_notes')]);

  { // a) eigene Ware + Keep → abgewiesen, ohne jede Wirkung (Gegenprobe: früher neues Los zum Verkaufspreis)
    const db = neu(); product(db, 'pOwn', 100); reload();
    const lot = lotOf(db, kauf('pOwn', 3, 100, false));
    const inv = rechnung([LINE('pOwn', 1)]); voll(db, inv);
    const vorP = prod(db, 'pOwn'); const vorZ = zaehler(db);
    const m = meldung(() => keepRet(db, inv, ['pOwn']));
    ok(m.startsWith('DISPOSITION_NOT_ALLOWED'), `14a nur eigene Ware + Keep → abgewiesen wie bisher (${m.slice(0, 60)})`);
    ok(prod(db, 'pOwn') === vorP && zaehler(db) === vorZ && lotRem(db, lot) === 2, `14a …kein neues Los, Einstand/Quelle/Status unverändert, keine Retoure, keine Buchung (${prod(db, 'pOwn')})`);
    // gemischt: Kommission + eigene Ware auf einer Rechnung → Keep für alle Zeilen → abgewiesen
    kommission(db, 'pMixK', 'cons-mix');
    const rMix = s(db, "SELECT invoice_id FROM consignments WHERE id = 'cons-mix'");
    db.run(`INSERT INTO invoice_lines (id, invoice_id, product_id, quantity, unit_price, purchase_price_snapshot, vat_rate, vat_amount, line_total, tax_scheme, position)
      SELECT 'il-mix-own', ?, 'pOwn', 1, 100, 100, 0, 0, 100, 'MARGIN', 9`, [rMix]);
    // Der eigentliche Fund: EINE Kommissionszeile genügte, und Keep wirkte auf ALLE Zeilen — die eigene Ware bekam
    // ein neues Los zum Verkaufspreis und diesen Preis als Einstand.
    const vorZ2 = zaehler(db); const vorOwn = prod(db, 'pOwn'); const vorMixK = prod(db, 'pMixK');
    const mm = meldung(() => keepRet(db, rMix, ['pMixK', 'pOwn']));
    ok(mm.startsWith('KEEP_ONLY_FOR_CONSIGNMENT') && zaehler(db) === vorZ2 && prod(db, 'pOwn') === vorOwn && prod(db, 'pMixK') === vorMixK
      && n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = 'pOwn' AND purchase_id IS NULL") === 0,
      `14a gemischt (Kommission + eigene Ware) → abgewiesen: kein Los zum Verkaufspreis, Einstand/Quelle beider Artikel unverändert (${mm.slice(0, 50)})`);
  }

  { // b) Kommission über die Rechnungsmaske (PC2 denselben Weg): Snapshot vollständig, Storno exakt
    const db = neu();
    const r = kommission(db, 'pKeep', 'cons-k1');
    const vorP = prod(db, 'pKeep'); const vorC = consStatus(db, 'cons-k1');
    const rid = keepRet(db, r.invoiceId, ['pKeep']);
    const snap = db.exec('SELECT keep_snapshot_at, keep_prev_source_type, keep_prev_purchase_price, keep_prev_stock_status, keep_prev_consignments, keep_lot_id FROM sales_return_lines WHERE return_id = ?', [rid])[0].values[0];
    const keepLot = String(snap[5] ?? '');
    ok(!!snap[0] && snap[1] === 'CONSIGNMENT' && S(JSON.parse(String(snap[4]))) === S([{ id: 'cons-k1', status: vorC }]) && !!keepLot
      && S([snap[1], snap[2], snap[3]]) === S(JSON.parse(vorP)[0].slice(0, 3)),
      `14b Snapshot vollständig: Quelle, Einstand, Status vor dem Keep, Kommission mit Status, Keep-Los (${S(snap)})`);
    ok(JSON.parse(prod(db, 'pKeep'))[0][0] === 'OWN' && consStatus(db, 'cons-k1') === 'returned' && s(db, 'SELECT status FROM stock_lots WHERE id = ?', [keepLot]) === 'ACTIVE',
      '14b Keep wirkt (von der Rechnung aus über den Kommissionsweg): OWN, Kommission returned, Keep-Los aktiv');
    const srl = db.exec("SELECT data FROM sync_changelog WHERE table_name = 'sales_return_lines' ORDER BY id DESC LIMIT 1")[0]?.values?.[0]?.[0];
    ok(!!srl && /keep_snapshot_at/.test(String(srl)) && changeContractViolation('sales_return_lines', 'insert', String(srl)) === null,
      '14b Sync-Feldvertrag: die Retourenzeile reist mit Snapshot und wird vom Vertrag angenommen');
    ok(storno(rid) === '', '14b Storno des Keeps läuft');
    ok(prod(db, 'pKeep') === vorP && consStatus(db, 'cons-k1') === vorC && s(db, 'SELECT status FROM stock_lots WHERE id = ?', [keepLot]) === 'CANCELLED',
      `14b …exakt zurück: Quelle, Einstand, Status, Menge wie vor dem Keep, Kommission ${vorC}, Keep-Los storniert (${prod(db, 'pKeep')} / ${consStatus(db, 'cons-k1')})`);
    ok(s(db, 'SELECT status FROM sales_returns WHERE id = ?', [rid]) === 'REJECTED' && ausgeglichen(db), '14b …Retoure REJECTED, Hauptbuch ausgeglichen');
  }

  { // c) weiterverkauft → Storno abgewiesen, nichts verändert
    const db = neu();
    const r = kommission(db, 'pKeep2', 'cons-k2');
    const rid = keepRet(db, r.invoiceId, ['pKeep2']);
    rechnung([LINE('pKeep2', 1)]);   // das behaltene Stück erneut verkauft
    const vorP = prod(db, 'pKeep2'); const vorZ = zaehler(db);
    const m = storno(rid);
    ok(m.startsWith('RETURN_STOCK_RESOLD') && prod(db, 'pKeep2') === vorP && zaehler(db) === vorZ && consStatus(db, 'cons-k2') === 'returned',
      `14c Keep-Stück weiterverkauft → Storno abgewiesen, keine Doppelbelegung, nichts verändert (${m.slice(0, 50)})`);
  }

  { // d) Kommission seither verändert → abgewiesen
    const db = neu();
    const r = kommission(db, 'pKeep3', 'cons-k3');
    const rid = keepRet(db, r.invoiceId, ['pKeep3']);
    db.run("UPDATE consignments SET status = 'paid_out' WHERE id = 'cons-k3'");
    const vorP = prod(db, 'pKeep3');
    const m = storno(rid);
    ok(m.startsWith('RETURN_KEEP_CONSIGNMENT_CHANGED') && prod(db, 'pKeep3') === vorP, `14d Kommission seither verändert → abgewiesen, nichts überschrieben (${m.slice(0, 50)})`);
  }

  { // e) Kommissionsmaske: Snapshot + Wareneinsatz + Einstand = Auszahlung; Storno exakt inkl. Wareneinsatz
    const db = neu();
    kommission(db, 'pKeepC', 'cons-k4');
    const vorP = prod(db, 'pKeepC'); const vorC = consStatus(db, 'cons-k4');
    const einkaeufe = n(db, "SELECT COUNT(*) FROM purchases WHERE status != 'CANCELLED'");
    const out = imHaus(() => consRev.returnConsignmentAfterSaleInHouse('cons-k4', { disposition: 'KEEP_AS_OWN', refundMethod: 'cash' } as never, 'branch-main'));
    reload();
    const rid = out.returnId;
    ok(consStatus(db, 'cons-k4') === 'returned' && JSON.parse(prod(db, 'pKeepC'))[0][0] === 'OWN' && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'SALES_RETURN_COGS' AND source_id = ?", [rid]) > 0,
      '14e Keep aus der Kommissionsmaske: OWN, Kommission returned, Wareneinsatz zurückgebucht');
    ok(storno(rid) === '', '14e Storno läuft');
    const cogsNetto = n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE source_module = 'SALES_RETURN_COGS' AND source_id = ? AND account = 'COGS'", [rid]);
    ok(prod(db, 'pKeepC') === vorP && consStatus(db, 'cons-k4') === vorC && Math.abs(cogsNetto) < 0.005
      && n(db, "SELECT COUNT(*) FROM purchases WHERE status != 'CANCELLED'") === einkaeufe && ausgeglichen(db),
      `14e …exakt zurück: Artikel, Kommission ${vorC}, Wareneinsatz netto 0, Einkauf beim Einlieferer unverändert, Hauptbuch ausgeglichen (${prod(db, 'pKeepC')})`);
  }

  { // f) Altbestand ohne Snapshot: Storno gesperrt — „Cancel Sale" räumt weiter auf
    const db = neu();
    kommission(db, 'pKeepL', 'cons-k5');
    const out = imHaus(() => consRev.returnConsignmentAfterSaleInHouse('cons-k5', { disposition: 'KEEP_AS_OWN', refundMethod: 'cash' } as never, 'branch-main'));
    reload();
    db.run(`UPDATE sales_return_lines SET keep_snapshot_at = NULL, keep_prev_source_type = NULL, keep_prev_purchase_price = NULL,
      keep_prev_stock_status = NULL, keep_prev_consignments = NULL, keep_lot_id = NULL WHERE return_id = ?`, [out.returnId]);   // wie vor dem Snapshot
    const vorP = prod(db, 'pKeepL'); const vorZ = zaehler(db);
    const m = storno(out.returnId);
    ok(m.startsWith('RETURN_KEEP_NOT_RESTORABLE') && prod(db, 'pKeepL') === vorP && zaehler(db) === vorZ,
      `14f Alt-Keep ohne Snapshot → nicht stornierbar, nichts geraten (${m.slice(0, 50)})`);
    const c = meldung(() => imHaus(() => consRev.cancelConsignmentSaleInHouse('cons-k5', OWNER_ACTOR, 'branch-main')));
    reload();
    ok(c === '' && consStatus(db, 'cons-k5') === 'active' && JSON.parse(prod(db, 'pKeepL'))[0][0] === 'CONSIGNMENT' && ausgeglichen(db),
      `14f …„Cancel Sale" der Kommission räumt den Alt-Keep weiter auf (${c || 'ok'})`);
  }
}

// ══ 15 — „Return to Owner": nur Kommissionsware, gemischt atomar abgewiesen ═══════
{
  const { createReturnInHouse } = await import('../../src/core/returns/return-house.ts');
  const prod = (db: Db, pid: string): string =>
    S(db.exec('SELECT source_type, purchase_price, stock_status, quantity FROM products WHERE id = ?', [pid])[0]?.values ?? []);
  const consStatus = (db: Db, cid: string): string => s(db, 'SELECT status FROM consignments WHERE id = ?', [cid]);
  const ausgeglichen = (db: Db): boolean => Math.abs(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.005;
  const lineOfInv = (db: Db, inv: string, pid: string): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, pid]);
  const rtoRet = (db: Db, inv: string, pids: string[], disposition = 'RETURN_TO_OWNER', refundNow = true): string => {
    const id = imHaus(() => createReturnInHouse({ invoiceId: inv, lines: pids.map((p) => ({ invoiceLineId: lineOfInv(db, inv, p), quantity: 1 })),
      refundMethod: 'cash', productDisposition: disposition, reason: 'rto', refundNow } as never, 'branch-main').returnId);
    reload();
    return id;
  };
  const alles = (db: Db): string => S([
    n(db, 'SELECT COUNT(*) FROM stock_lots'), n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM sales_return_lines'),
    n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM credit_notes'), n(db, 'SELECT COUNT(*) FROM customer_credits'),
    n(db, 'SELECT COUNT(*) FROM sync_changelog'), n(db, 'SELECT COUNT(*) FROM audit_log'),
    db.exec('SELECT id, qty_remaining, status FROM stock_lots ORDER BY id')[0]?.values ?? [],
    db.exec('SELECT id, status, payout_status FROM consignments ORDER BY id')[0]?.values ?? [],
    db.exec('SELECT id, status, paid_amount FROM invoices ORDER BY id')[0]?.values ?? [],
  ]);

  // Eine Kommissionsrechnung, darauf auch eigene Ware (pOwnR, 3 Stück im Los, 1 verkauft).
  const gemischt = (): { db: Db; inv: string; lot: string } => {
    const db = neu(); product(db, 'pOwnR', 100); reload();
    const lot = lotOf(db, kauf('pOwnR', 3, 100, false));
    const r = kommission(db, 'pRK', 'cons-r1');
    db.run(`INSERT INTO invoice_lines (id, invoice_id, product_id, quantity, unit_price, purchase_price_snapshot, vat_rate, vat_amount, line_total, tax_scheme, position, lot_id, stock_taken)
      SELECT 'il-rto-own', ?, 'pOwnR', 1, 100, 100, 0, 0, 100, 'MARGIN', 9, ?, 1`, [r.invoiceId, lot]);
    db.run("UPDATE stock_lots SET qty_remaining = qty_remaining - 1 WHERE id = ?", [lot]);
    db.run("UPDATE invoices SET gross_amount = gross_amount + 100, net_amount = net_amount + 100 WHERE id = ?", [r.invoiceId]);
    reload();
    voll(db, r.invoiceId);
    return { db, inv: r.invoiceId, lot };
  };

  { // a) DER FUND: Kommission + eigene Ware, „Return to Owner" für beide → abgewiesen, ohne jede Wirkung
    const { db, inv, lot } = gemischt();
    const vor = alles(db); const vorOwn = prod(db, 'pOwnR'); const vorK = prod(db, 'pRK'); const vorC = consStatus(db, 'cons-r1');
    const m = meldung(() => rtoRet(db, inv, ['pRK', 'pOwnR']));
    ok(m.startsWith('RETURN_TO_OWNER_ONLY_FOR_CONSIGNMENT'), `15a gemischt + Return to Owner → abgewiesen (${m.slice(0, 60)})`);
    ok(alles(db) === vor && prod(db, 'pOwnR') === vorOwn && prod(db, 'pRK') === vorK && consStatus(db, 'cons-r1') === vorC && lotRem(db, lot) === 2,
      `15a …nichts verändert: eigene Ware weiter am Lager (${prod(db, 'pOwnR')}), Los 2, Kommission ${consStatus(db, 'cons-r1')}, keine Retoure/Gutschrift/Erstattung/Buchung/Sync-Spur`);
    // Dieselbe Ablehnung ohne sofortige Erstattung.
    const m2 = meldung(() => rtoRet(db, inv, ['pOwnR', 'pRK'], 'RETURN_TO_OWNER', false));
    ok(m2.startsWith('RETURN_TO_OWNER_ONLY_FOR_CONSIGNMENT') && alles(db) === vor, `15a …auch ohne Sofort-Erstattung und in anderer Zeilenfolge (${m2.slice(0, 40)})`);
    // Nur die eigene Zeile: wie bisher die alte Regel.
    const m3 = meldung(() => rtoRet(db, inv, ['pOwnR']));
    ok(m3.startsWith('DISPOSITION_NOT_ALLOWED') && alles(db) === vor, `15a nur eigene Ware + Return to Owner → abgewiesen wie bisher (${m3.slice(0, 40)})`);
  }

  { // b) Auf derselben Rechnung getrennt: Kommissionszeile „Return to Owner", eigene Ware „Back to Stock" → beides wirkt
    const { db, inv, lot } = gemischt();
    const rid = rtoRet(db, inv, ['pRK']);
    ok(!!rid && consStatus(db, 'cons-r1') === 'returned' && JSON.parse(prod(db, 'pRK'))[0][2] === 'returned'
      && JSON.parse(prod(db, 'pOwnR'))[0][2] === 'in_stock' && lotRem(db, lot) === 2,
      `15b nur die Kommissionszeile → Return to Owner wirkt nur auf sie (Kommission ${consStatus(db, 'cons-r1')}, eigene Ware unberührt)`);
    const rid2 = rtoRet(db, inv, ['pOwnR'], 'IN_STOCK');
    ok(!!rid2 && lotRem(db, lot) === 3 && JSON.parse(prod(db, 'pOwnR'))[0][2] === 'in_stock' && ausgeglichen(db),
      `15b …die eigene Ware danach „Back to Stock": Stück zurück ins Los (3), Hauptbuch ausgeglichen`);
  }

  { // c) reine Kommissionsretoure über die Rechnungsmaske: der Kommissionsweg; ihr Rückweg ist „Cancel Sale"
    const consRev = await import('../../src/core/consignment/consignment-reversal-house.ts');
    const db = neu();
    const r = kommission(db, 'pRK2', 'cons-r2');   // unbezahlt: die Erstattung storniert nur die Forderung
    const spaeter = meldung(() => rtoRet(db, r.invoiceId, ['pRK2'], 'RETURN_TO_OWNER', false));
    ok(spaeter.startsWith('CONSIGNMENT_RETURN_REFUNDS_NOW'), `15c „später erstatten" gibt es für Kommissionsware nicht (${spaeter.slice(0, 40)})`);
    const rid = rtoRet(db, r.invoiceId, ['pRK2']);
    ok(consStatus(db, 'cons-r2') === 'returned' && JSON.parse(prod(db, 'pRK2'))[0][2] === 'returned'
      && s(db, 'SELECT product_disposition FROM sales_returns WHERE id = ?', [rid]) === 'RETURN_TO_OWNER' && ausgeglichen(db),
      '15c nur Kommissionsware + Return to Owner → Artikel returned, Kommission returned (Kommissionsweg)');
    const vor = alles(db);
    const st = storno(rid);
    ok(st.startsWith('RETURN_VIA_CANCEL_SALE') && alles(db) === vor && s(db, 'SELECT status FROM sales_returns WHERE id = ?', [rid]) !== 'REJECTED',
      `15c …direktes „Cancel Return" abgewiesen, nichts verändert (${st.slice(0, 40)})`);
    const c = meldung(() => imHaus(() => consRev.cancelConsignmentSaleInHouse('cons-r2', OWNER_ACTOR, 'branch-main')));
    reload();
    ok(c === '' && consStatus(db, 'cons-r2') === 'active' && s(db, 'SELECT status FROM sales_returns WHERE id = ?', [rid]) === 'REJECTED' && ausgeglichen(db),
      `15c …„Cancel Sale" nimmt Verkauf und Rückgabe zurück: Kommission active, Retoure REJECTED (${c || 'ok'})`);
  }

  { // d) „Cancel Sale" der Kommission (Return to Owner aus der Kommissionsmaske) läuft unverändert durch das Haus
    const consRev = await import('../../src/core/consignment/consignment-reversal-house.ts');
    const db = neu();
    kommission(db, 'pRK3', 'cons-r3');
    const out = imHaus(() => consRev.returnConsignmentAfterSaleInHouse('cons-r3', { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash' } as never, 'branch-main'));
    reload();
    ok(!!out.returnId && consStatus(db, 'cons-r3') === 'returned' && ausgeglichen(db), '15d Return to Owner aus der Kommissionsmaske läuft wie bisher');
  }

  const rh = src('src/core/returns/return-house.ts');
  ok(/'RETURN_TO_OWNER' && lines\.some\(\(l\) => !l\.productId \|\| !istKommissionsware/.test(rh) && /beforeWrite\?\.\(\);/.test(rh.split('RETURN_TO_OWNER_ONLY_FOR_CONSIGNMENT')[1] ?? ''),
    '15 Quelltext: die Regel steht im Retourenhaus vor dem ersten Schreiben (Maske, PC2 returns.create und Kommissionsmaske laufen hier durch)');
}

// ══ 11 — Ein Weg für Primary und PC2 ═════════════════════════════════════════════
{
  const rc = src('src/core/returns/return-cancel-house.ts');
  ok(!/stock_status = 'sold'/.test(rc), '11 return-cancel-house setzt nirgends mehr pauschal sold');
  ok(/reconcileSaleStatus\(pid, saleSettled/.test(rc), '11 …sondern leitet den Status über reconcileSaleStatus ab');
  ok(/cancelReturnInHouse\(/.test(src('src/core/bridge/sales-reversal-commands.ts')), '11 PC2 returns.cancel ruft dieselbe Hausfolge');
  ok(/cancelReturnInHouse\(/.test(src('src/stores/salesReturnStore.ts')), '11 …Primary-Maske ebenso');
  ok(/reconcileSaleStatus\(pid, !isStillUnpaid\)/.test(src('src/stores/invoiceStore.ts')), '11 editInvoice leitet den Status über dieselbe Regel ab');
  ok(/reconcileSaleStatus\(productId, true\)/.test(src('src/core/lots/lot-queries.ts')), '11 unreserveProductIfRestored nutzt dieselbe Regel (sold → verkaufbar)');
}

console.log(`\nreturn-cancel-status: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
