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
  // UNDER_REPAIR-Retoure: ihr eigenes in_repair wird zurückgenommen …
  const db2 = neu(); product(db2, 'pR', 100); reload();
  const lot2 = lotOf(db2, kauf('pR', 10, 100, false));
  const inv2 = rechnung([LINE('pR', 1)]); voll(db2, inv2);
  const rr = ret(db2, inv2, 'pR', 1, 'UNDER_REPAIR');
  ok(st(db2, 'pR') === 'in_repair', '10 UNDER_REPAIR-Retoure setzt in_repair (unverändert, eigener späterer Punkt)');
  ok(storno(rr) === '', '10 Storno der UNDER_REPAIR-Retoure läuft');
  stand(db2, 'pR', lot2, { status: 'in_stock', rest: 9 }, '10 …eigenes in_repair zurückgenommen (vorher: sold)');
  // … aber nicht, wenn seither eine echte Reparatur angelegt wurde.
  const rr2 = ret(db2, inv2, 'pR', 1, 'UNDER_REPAIR');
  insert(db2, 'repairs', { id: 'rep-1', branch_id: 'branch-main', product_id: 'pR', status: 'received', created_at: '2999-01-01T00:00:00.000Z', updated_at: NOW });
  ok(storno(rr2) === '' && st(db2, 'pR') === 'in_repair', `10 …mit Reparatur seit der Retoure bleibt in_repair (${st(db2, 'pR')})`);
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
