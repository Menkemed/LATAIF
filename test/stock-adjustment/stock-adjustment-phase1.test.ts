// ════════════════════════════════════════════════════════════════════════════
// STOCK-ADJUSTMENT Phase 1 — kontrollierter Bestandsabgang eigener Stückware (Korrekturbeleg, Storno, Ausschlüsse, Rollback).
// Nur künstliche Testdaten.
// Gerüst wie test/bulk-metal/bulk-metal.test.ts (echte sql.js-Datenbank, echte Migrationen, Stores, Hausfolgen, Hauptbuch).
// Run: node test/stock-adjustment/stock-adjustment-phase1.test.ts
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
const life = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { capitalizedLineCost, purchaseLotUnitCost, inventoryCostBasis } = await import('../../src/core/lots/lot-cost.ts');

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

// ════════════════════════════════════════════════════════════════════════════
// STOCK-ADJUSTMENT Phase 1 — Bestandsabgang eigener Stückware (mit Los: Bestandsverlust gebucht; ohne Los und
// nachweislich ohne Lagerbuchung: nur Menge, ACCOUNTING_RECONCILIATION_PENDING), Storno, Ausschlüsse, Rollback.
// ════════════════════════════════════════════════════════════════════════════
const sa = await import('../../src/core/stock/stock-adjustment.ts').catch(() => null) as null | Record<string, any>;
const { createPurchaseDetailedInHouse } = await import('../../src/core/purchases/purchase-house.ts');
const bm = await import('../../src/core/bulk/bulk-math.ts');

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
let seqA = 0;
const newAction = (): string => `adj-action-${++seqA}-xxxxxxxx`;
const qtyOf = (db: Db, pid: string): number => n(db, 'SELECT quantity FROM products WHERE id = ?', [pid]);
const statusOf = (db: Db, pid: string): string => s(db, 'SELECT stock_status FROM products WHERE id = ?', [pid]);
const ledgerCount = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const audits = (db: Db): number => n(db, 'SELECT COUNT(*) FROM audit_log');
const changelog = (db: Db): number => n(db, 'SELECT COUNT(*) FROM sync_changelog');
/** Alles, was eine abgewiesene oder zurückgerollte Korrektur nicht verändern darf. */
const alles = (db: Db): string => S({
  p: db.exec('SELECT * FROM products ORDER BY id')[0]?.values, lots: db.exec('SELECT * FROM stock_lots ORDER BY id')[0]?.values,
  ledger: db.exec('SELECT * FROM ledger_entries ORDER BY id')[0]?.values, adj: db.exec('SELECT * FROM stock_adjustments ORDER BY id')[0]?.values,
  seq: db.exec("SELECT * FROM document_sequences WHERE doc_type = 'ADJ'")[0]?.values, log: changelog(db), audit: audits(db),
});
interface Aus { ok: boolean; code: string; r: Record<string, any> }
async function abgang(db: Db, pid: string, quantity: number, over: Record<string, unknown> = {}): Promise<Aus> {
  if (!sa) return { ok: false, code: 'KEIN_MODUL', r: {} };
  try {
    const r = await sa.issueStockOnPrimary({ actionId: newAction(), productId: pid, quantity, expectedQuantity: qtyOf(db, pid),
      reasonCategory: 'LOST', reason: 'not found in the safe at the count', ...over }, reload);
    return { ok: true, code: '', r };
  } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message), r: {} }; }
}
async function storno(id: string, reason = 'found again'): Promise<Aus> {
  if (!sa) return { ok: false, code: 'KEIN_MODUL', r: {} };
  try { return { ok: true, code: '', r: await sa.cancelStockAdjustmentOnPrimary({ adjustmentId: id, reason }, reload) }; }
  catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message), r: {} }; }
}
const rolle = (role: string): void => { useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never }); };
function kauf(pid: string, qty: number, unitPrice = 300): string {
  const id = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', lines: [{ productId: pid, quantity: qty, unitPrice, taxScheme: 'ZERO' as const, vatRate: 0 }],
  } as never).id);
  reload();
  return id;
}
function verkauf(pid: string, qty = 1): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ productId: pid, quantity: qty, unitPrice: 500, purchasePrice: 0,
    taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 500 * qty }] as never, 'ADJ').id);
  reload();
  return id;
}
const adj = (db: Db, id: string): Record<string, unknown> => {
  const r = db.exec('SELECT * FROM stock_adjustments WHERE id = ?', [id])[0];
  return r ? Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]])) : {};
};

// ══ A — ohne Los, nachweislich ohne Lagerbuchung: nur die Menge ═══════════════════════════════════════════
{
  const db = freshDb();
  product(db, 'u1', 300, 3); product(db, 'u2', 300, 1); product(db, 'andere', 200, 5); reload();
  const l0 = ledgerCount(db), a0 = audits(db), c0 = changelog(db);
  const andere = S(db.exec("SELECT * FROM products WHERE id = 'andere'")[0]?.values);
  const a1 = await abgang(db, 'u1', 1);
  const d1 = a1.ok ? adj(db, a1.r.adjustmentId) : {};
  ok(a1.ok && qtyOf(db, 'u1') === 2 && statusOf(db, 'u1') === 'in_stock' && d1.accounting === 'ACCOUNTING_RECONCILIATION_PENDING'
    && Number(d1.value_booked) === 0 && Number(d1.purchase_price_hint) === 300 && Number(d1.qty_before) === 3 && Number(d1.qty_after) === 2
    && String(d1.adjustment_number).startsWith('ADJ-') && String(d1.reason_category) === 'LOST',
    `A1 drei Uhren ohne Los, eine fehlt: 3 → 2, Beleg ${String(d1.adjustment_number)} mit ACCOUNTING_RECONCILIATION_PENDING und Einkaufspreis 300 als Hinweis (${a1.code || 'ok'})`);
  ok(ledgerCount(db) === l0, 'A1 …keine Buchung erfunden (Hauptbuch unverändert)');
  ok(audits(db) === a0 + 2 && changelog(db) === c0 + 2
    && n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'stock_adjustments' AND action = 'insert'") === 1
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = 'u1' AND field_name = 'quantity'") === 1,
    'A1 …strenges Protokoll (Beleg + Menge vorher/nachher) und Sync (Beleg + Artikel)');
  ok(S(db.exec("SELECT * FROM products WHERE id = 'andere'")[0]?.values) === andere, 'A1 …andere Artikel unberührt');
  const st = await storno(a1.r.adjustmentId);
  ok(st.ok && qtyOf(db, 'u1') === 3 && statusOf(db, 'u1') === 'in_stock' && adj(db, a1.r.adjustmentId).status === 'CANCELLED' && ledgerCount(db) === l0,
    `A2 Storno: wieder 3, Status wie vorher, Beleg storniert, keine Buchung (${st.code || 'ok'})`);
  const vor = alles(db);
  const st2 = await storno(a1.r.adjustmentId);
  ok(!st2.ok && /ALREADY_CANCELLED/.test(st2.code) && alles(db) === vor, `A3 Storno noch einmal: abgewiesen, keine Doppelwirkung (${st2.code})`);
  const a4 = await abgang(db, 'u2', 1);
  ok(a4.ok && qtyOf(db, 'u2') === 0 && statusOf(db, 'u2') === 'write_off', `A4 letztes Stück: Menge 0, Status write_off (kein Verkauf) (${a4.code || 'ok'}; ${statusOf(db, 'u2')})`);
  const st4 = await storno(a4.r.adjustmentId);
  ok(st4.ok && qtyOf(db, 'u2') === 1 && statusOf(db, 'u2') === 'in_stock', `A4 …Storno: wieder 1, in stock (${st4.code || 'ok'})`);
}
// ══ B — ohne Los, Lagerwert nicht ausschließbar: abgewiesen, nichts verändert ═══════════════════════════
{
  const db = freshDb();
  product(db, 'b1', 300, 2); product(db, 'b2', 300, 2); product(db, 'b3', 300, 2); reload();
  // b1: Einkaufszeile ohne Los (Altbestand/Anomalie)
  insert(db, 'purchases', { id: 'pb1', branch_id: 'branch-main', purchase_number: 'PUR-X', supplier_id: 'sup-1', status: 'RECEIVED', total_amount: 300, created_at: NOW, updated_at: NOW });
  insert(db, 'purchase_lines', { id: 'plb1', purchase_id: 'pb1', product_id: 'b1', quantity: 1, unit_price: 300, line_total: 300 });
  // b2: Reparaturkosten auf den Artikel aktiviert (eigene Arbeit, Soll INVENTORY)
  insert(db, 'repairs', { id: 'rb2', branch_id: 'branch-main', repair_number: 'REP-X', product_id: 'b2', status: 'picked_up', created_at: NOW, updated_at: NOW });
  imHaus(() => posting.postRepairOwnWork({ sourceId: 'cl-b2', repairId: 'rb2', account: 'INVENTORY', amount: 50, occurredAt: NOW }));
  reload();
  const vor = alles(db);
  const e1 = await abgang(db, 'b1', 1);
  const e2 = await abgang(db, 'b2', 1);
  const e3 = await abgang(db, 'b3', 1);   // b3 selbst ist sauber
  ok(!e1.ok && /VALUE_NOT_PROVEN/.test(e1.code) && !e2.ok && /VALUE_NOT_PROVEN/.test(e2.code) && e3.ok,
    `B1/B2 Einkaufszeile ohne Los bzw. aktivierte Reparaturkosten: abgewiesen; ein sauberer Artikel daneben geht (${e1.code} · ${e2.code} · ${e3.code || 'ok'})`);
  ok(qtyOf(db, 'b1') === 2 && qtyOf(db, 'b2') === 2, 'B1/B2 …an den abgewiesenen Artikeln nichts verändert');
  // B3 — eine INVENTORY-Sollbuchung unbekannter Herkunft im Hauptbuch: jede buchungslose Korrektur wird abgewiesen
  const db3 = freshDb(); product(db3, 'b4', 300, 2); reload();
  imHaus(() => posting.postEntries([
    { account: 'INVENTORY', direction: 'DEBIT', amount: 10, metadata: {} },
    { account: 'OPENING_BALANCE_EQUITY', direction: 'CREDIT', amount: 10, metadata: {} },
  ], { occurredAt: NOW, sourceModule: 'OPENING_BALANCE', sourceId: 'opening:test' }));
  const vor3 = alles(db3);
  const e4 = await abgang(db3, 'b4', 1);
  ok(!e4.ok && /VALUE_NOT_PROVEN/.test(e4.code) && alles(db3) === vor3, `B3 Lagerbuchung unbekannter Herkunft im Hauptbuch: fail-closed, nichts verändert (${e4.code})`);
  void vor;
}
// ══ C — mit Los: Entnahme nach der Loslogik, Bestandsverlust zum Einstand ══════════════════════════════════
{
  const db = freshDb();
  product(db, 'l1', 300, 0); reload();
  kauf('l1', 2, 300);
  const lot = s(db, "SELECT id FROM stock_lots WHERE product_id = 'l1'");
  ok(qtyOf(db, 'l1') === 2 && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE' AND account = 'INVENTORY' AND direction = 'DEBIT'") === 1,
    'C (Vorbereitung) Einkauf von 2 Stück: Los und INVENTORY-Buchung');
  const c1 = await abgang(db, 'l1', 1, { reasonCategory: 'DAMAGED', reason: 'dropped, glass and dial broken' });
  const d1 = c1.ok ? adj(db, c1.r.adjustmentId) : {};
  const loss = n(db, "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE source_module = 'STOCK_ADJUST' AND source_id = ? AND account = 'INVENTORY_LOSS' AND direction = 'DEBIT'", [c1.r.adjustmentId ?? '']);
  const inv = n(db, "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE source_module = 'STOCK_ADJUST' AND source_id = ? AND account = 'INVENTORY' AND direction = 'CREDIT'", [c1.r.adjustmentId ?? '']);
  ok(c1.ok && d1.accounting === 'BOOKED' && Number(d1.value_booked) === 300 && loss === 300 && inv === 300
    && n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]) === 1 && qtyOf(db, 'l1') === 1 && statusOf(db, 'l1') === 'in_stock',
    `C1 mit Los: 2 → 1, Los 1, Bestandsverlust 300 an INVENTORY 300 (${c1.code || 'ok'})`);
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'stock_lots' AND record_id = ?", [lot]) >= 2, 'C1 …das Los reist zum Spiegel');
  const c2 = await storno(c1.r.adjustmentId);
  const netto = n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE source_module = 'STOCK_ADJUST' AND source_id = ? AND account = 'INVENTORY'", [c1.r.adjustmentId ?? '']);
  ok(c2.ok && n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]) === 2 && s(db, 'SELECT status FROM stock_lots WHERE id = ?', [lot]) === 'ACTIVE'
    && qtyOf(db, 'l1') === 2 && Math.abs(netto) < 0.0005, `C2 Storno: Los wieder 2, Buchung zurückgenommen (netto 0) (${c2.code || 'ok'})`);
  const c3 = await abgang(db, 'l1', 2);
  ok(c3.ok && qtyOf(db, 'l1') === 0 && statusOf(db, 'l1') === 'write_off' && s(db, 'SELECT status FROM stock_lots WHERE id = ?', [lot]) === 'EXHAUSTED'
    && Number(adj(db, c3.r.adjustmentId).value_booked) === 600, `C3 beide Stücke: Los EXHAUSTED, Status write_off, Verlust 600 (${c3.code || 'ok'})`);
  // C4 — Los ohne belegten Wert (aus Produktion/Keep: kein Einkauf, keine INVENTORY-Buchung) → abgewiesen
  product(db, 'l2', 100, 1);
  insert(db, 'stock_lots', { id: 'lot-l2', branch_id: 'branch-main', product_id: 'l2', unit_cost: 100, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', acquired_at: NOW, created_at: NOW, unit: 'pcs' });
  reload();
  const vor4 = alles(db);
  const c4 = await abgang(db, 'l2', 1);
  ok(!c4.ok && /VALUE_NOT_PROVEN/.test(c4.code) && alles(db) === vor4, `C4 Los ohne belegten Wert (Produktion/Keep): abgewiesen, nichts verändert (${c4.code})`);
  // C5 — nach dem Abgang wird das letzte Stück verkauft → Storno wäre nicht eindeutig → abgewiesen
  product(db, 'l3', 300, 0); reload(); kauf('l3', 2, 300);
  const c5 = await abgang(db, 'l3', 1);
  verkauf('l3', 1);
  const vor5 = alles(db);
  const c5s = await storno(c5.r.adjustmentId);
  ok(c5.ok && !c5s.ok && /MOVED_SINCE/.test(c5s.code) && alles(db) === vor5 && qtyOf(db, 'l3') === 0,
    `C5 nach dem Abgang verkauft: Storno abgewiesen, kein verkauftes Stück wird wieder verfügbar (${c5s.code})`);
  // C6 — ohne Los: nach dem Abgang ein Verkauf → Storno abgewiesen
  product(db, 'l4', 300, 3); reload();
  const c6 = await abgang(db, 'l4', 1);
  verkauf('l4', 1);
  const vor6 = alles(db);
  const c6s = await storno(c6.r.adjustmentId);
  ok(c6.ok && !c6s.ok && /MOVED_SINCE/.test(c6s.code) && alles(db) === vor6, `C6 ohne Los, danach verkauft: Storno abgewiesen, nichts verändert (${c6s.code})`);
}
// ══ D — Ausschlüsse, Menge, Rolle, PC2: abgewiesen, nichts verändert ════════════════════════════════════════
{
  const db = freshDb();
  for (const id of ['k1', 'g1', 'r1', 'o1', 'p1', 'q1', 'm1']) product(db, id, 300, 2);
  db.run("UPDATE products SET source_type = 'CONSIGNMENT', stock_status = 'consignment' WHERE id = 'k1'");
  insert(db, 'agent_transfers', { id: 'at-g1', branch_id: 'branch-main', product_id: 'g1', status: 'transferred', created_at: NOW, updated_at: NOW });
  db.run("UPDATE products SET stock_status = 'reserved' WHERE id = 'r1'");
  insert(db, 'repairs', { id: 'rep-o1', branch_id: 'branch-main', repair_number: 'REP-O', product_id: 'o1', status: 'in_progress', created_at: NOW, updated_at: NOW });
  insert(db, 'item_participations', { id: 'ip-p1', branch_id: 'branch-main', purchase_id: 'x', purchase_line_id: 'x', product_id: 'p1', party: 'PARTNER', partner_id: 'partner-1', share_bp: 5000, created_at: NOW });
  reload();
  // Edelmetall: der Systemartikel eines Bulk-Einkaufs
  imHaus(() => createPurchaseDetailedInHouse({ supplierId: 'sup-1', purchaseDate: '2026-10-07', taxScheme: 'ZERO', paymentAmount: 0, paymentMethod: 'cash', notes: '', staffId: '',
    lines: [{ mode: 'bulk', brand: '', name: '', sku: '', categoryId: '', quantity: 1, unitPrice: 10,
      bulk: { metal: 'silver', fineness: '925', weightMg: bm.parseGramsToMg('10'), lineTotalFils: 10000, saleTaxScheme: 'MARGIN' } }] } as never, 'branch-main', 'user-test'));
  reload();
  const vor = alles(db);
  const r = {
    kommission: await abgang(db, 'k1', 1), agent: await abgang(db, 'g1', 1), reserviert: await abgang(db, 'r1', 1),
    reparatur: await abgang(db, 'o1', 1), partner: await abgang(db, 'p1', 1), edelmetall: await abgang(db, 'bulk-silver-925-branch-main', 1),
    bruch: await abgang(db, 'q1', 1.5), null: await abgang(db, 'q1', 0), zuviel: await abgang(db, 'q1', 3),
    veraltet: await abgang(db, 'q1', 1, { expectedQuantity: 5 }), ohneGrund: await abgang(db, 'q1', 1, { reason: '  ' }),
    zukunft: await abgang(db, 'q1', 1, { businessDate: '2099-01-01' }),
  };
  rolle('MANAGER'); const mgr = await abgang(db, 'm1', 1); rolle('ADMIN');
  store.set('lataif_runtime_mode', 'client'); const pc2 = await abgang(db, 'm1', 1); store.delete('lataif_runtime_mode');
  const erwartet: Record<string, RegExp> = {
    kommission: /EXCLUDED_NOT_OWN/, agent: /EXCLUDED_AGENT/, reserviert: /EXCLUDED_NOT_IN_STOCK/, reparatur: /EXCLUDED_REPAIR/,
    partner: /EXCLUDED_PARTNER/, edelmetall: /EXCLUDED_BULK_METAL/, bruch: /QUANTITY_INVALID/, null: /QUANTITY_INVALID/,
    zuviel: /QUANTITY_EXCEEDS_STOCK/, veraltet: /STOCK_CHANGED/, ohneGrund: /REASON_REQUIRED/, zukunft: /INVALID_DATE/,
  };
  const falsch = Object.entries(r).filter(([k, v]) => v.ok || !erwartet[k].test(v.code)).map(([k, v]) => `${k}:${v.code || 'OK'}`);
  ok(falsch.length === 0, `D Kommission, Agent, reserviert, Reparatur, Partner, Edelmetall, Bruch/0/zu viel, veralteter Stand, ohne Grund, Zukunft: abgewiesen (${falsch.join(', ') || 'alle richtig'})`);
  ok(/PERMISSION_DENIED/.test(mgr.code) && /PRIMARY_ONLY/.test(pc2.code), `D Manager und PC2: abgewiesen (${mgr.code} · ${pc2.code})`);
  ok(alles(db) === vor, 'D …und an keinem Artikel, Los, Beleg, Zähler, Hauptbuch, Protokoll oder Sync etwas verändert');
}
// ══ E — Protokoll-, Sync- oder Buchungsfehler: vollständiger Rollback (auch die Belegnummer) ═══════════════
for (const [name, trigger, mitLos] of [
  ['Protokoll (ohne Los)', "CREATE TRIGGER t_nein BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'inject: audit'); END", false],
  ['Sync (ohne Los)', "CREATE TRIGGER t_nein BEFORE INSERT ON sync_changelog BEGIN SELECT RAISE(ABORT, 'inject: sync'); END", false],
  ['Buchung (mit Los)', "CREATE TRIGGER t_nein BEFORE INSERT ON ledger_entries WHEN NEW.source_module = 'STOCK_ADJUST' BEGIN SELECT RAISE(ABORT, 'inject: ledger'); END", true],
  ['Protokoll (mit Los)', "CREATE TRIGGER t_nein BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'inject: audit'); END", true],
] as Array<[string, string, boolean]>) {
  const db = freshDb();
  product(db, 'e1', 300, mitLos ? 0 : 3); reload();
  if (mitLos) kauf('e1', 2, 300);
  db.run(trigger);
  const vor = alles(db);
  const e = await abgang(db, 'e1', 1);
  ok(!e.ok && /inject|could not be written|ledger posting failed/.test(e.code) && alles(db) === vor,
    `E ${name} scheitert: vollständig zurück — Menge, Los, Beleg, Nummer, Hauptbuch, Sync, Protokoll (${e.code.slice(0, 70)})`);
}
// ══ F — Wiederholung derselben Absicht: ein Beleg; andere Absicht mit derselben Kennung: Konflikt ════════════
{
  const db = freshDb(); product(db, 'f1', 300, 3); reload();
  const act = 'adj-same-action-xxxxxxxx';
  const f1 = await abgang(db, 'f1', 1, { actionId: act });
  const f2 = await abgang(db, 'f1', 1, { actionId: act, expectedQuantity: 3 });
  const f3 = await abgang(db, 'f1', 2, { actionId: act });
  ok(f1.ok && f2.ok && f2.r.adjustmentId === f1.r.adjustmentId && qtyOf(db, 'f1') === 2 && n(db, 'SELECT COUNT(*) FROM stock_adjustments') === 1
    && !f3.ok && /ACTION_ID_CONFLICT/.test(f3.code), `F Doppelklick: ein Beleg, Menge nur einmal reduziert; andere Menge mit derselben Kennung abgewiesen (${f3.code})`);
  // G — ein Artikel mit Korrekturbeleg ist nicht löschbar (Geschäftsbeleg)
  let g = ''; try { useProductStore.getState().deleteProduct('f1'); } catch (e) { g = (e as Error).message; }
  ok(/Stock Adjustment/.test(g) && qtyOf(db, 'f1') === 2, `G Artikel mit Korrekturbeleg: Löschen abgewiesen (${g.slice(0, 70)})`);
}
// ══ M — gemischte Datenbank: die Herkunft wird je Artikel bewiesen, nicht über einen Kontosaldo ═══════════════
//   A ohne Los, ohne Zugangsbuchung — aber mit eigenem Verkauf (Wareneinsatz) und Retoure (Rücknahme des Wareneinsatzes);
//   B mit gekauftem Los (INVENTORY im Soll); C ohne Los, Reparaturkosten über eine AUSGABE „Inventory" aktiviert.
{
  const db = freshDb();
  product(db, 'mA', 300, 3); product(db, 'mB', 300, 0); product(db, 'mC', 300, 2); reload();
  kauf('mB', 2, 300);
  const invA = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ productId: 'mA', quantity: 1, unitPrice: 500, purchasePrice: 300,
    taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 500 }] as never, 'ADJ').id);
  const lineA = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [invA]);
  imHaus(() => posting.postSalesReturnCogs('ret-mA', [{ invoiceLineId: lineA, productId: 'mA', quantity: 1 }], NOW));
  db.run("UPDATE products SET quantity = 3, stock_status = 'in_stock' WHERE id = 'mA'");   // die Retoure legt das Stück zurück
  insert(db, 'repairs', { id: 'rep-mC', branch_id: 'branch-main', repair_number: 'REP-MC', product_id: 'mC', status: 'picked_up', created_at: NOW, updated_at: NOW });
  insert(db, 'expenses', { id: 'ex-mC', branch_id: 'branch-main', expense_number: 'EXP-MC', category: 'Inventory', amount: 40, payment_method: 'cash',
    expense_date: '2026-10-07', related_module: 'repair', related_entity_id: 'rep-mC', created_at: NOW });
  imHaus(() => posting.postEntries([
    { account: 'INVENTORY', direction: 'DEBIT', amount: 40, metadata: {} },
    { account: 'ACCOUNTS_PAYABLE', direction: 'CREDIT', amount: 40, metadata: {} },
  ], { occurredAt: NOW, sourceModule: 'EXPENSE', sourceId: 'ex-mC' }));
  reload();
  const art = (src: string): number => n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'INVENTORY' AND source_module = ?", [src]);
  ok(art('PURCHASE') > 0 && art('INVOICE') > 0 && art('SALES_RETURN_COGS') > 0 && art('EXPENSE') > 0,
    `M (Vorbereitung) INVENTORY trägt Einkauf (B), Wareneinsatz und Retoure (A), aktivierte Reparaturausgabe (C)`);
  const iA = sa?.lotlessValueIssue('mA'), iC = sa?.lotlessValueIssue('mC');
  ok(iA === null && /repair costs/.test(String(iC)), `M Herkunft je Artikel: A ohne Zugangsbuchung (trotz B, C und eigenem Verkauf/Retoure), C mit aktivierten Reparaturkosten (${iA} · ${iC})`);
  const vorC = alles(db);
  const eC = await abgang(db, 'mC', 1);
  ok(!eC.ok && /VALUE_NOT_PROVEN/.test(eC.code) && alles(db) === vorC, `M C (Reparaturausgabe aktiviert): abgewiesen, nichts verändert (${eC.code})`);
  const eA = await abgang(db, 'mA', 1);
  const eB = await abgang(db, 'mB', 1);
  ok(eA.ok && eA.r.accounting === 'ACCOUNTING_RECONCILIATION_PENDING' && qtyOf(db, 'mA') === 2 && eB.ok && eB.r.accounting === 'BOOKED' && eB.r.value === 300,
    `M A: nur Menge (3 → 2); B: Bestandsverlust 300 — die Buchung von B sperrt A nicht (${eA.code || 'ok'} · ${eB.code || 'ok'})`);
  // Eine INVENTORY-Sollbuchung, die keinem Artikel zuzuordnen ist (Ausgabe ohne Reparaturbezug): fail-closed für Artikel ohne Los
  insert(db, 'expenses', { id: 'ex-frei', branch_id: 'branch-main', expense_number: 'EXP-FREI', category: 'Inventory', amount: 15, payment_method: 'cash',
    expense_date: '2026-10-07', created_at: NOW });
  imHaus(() => posting.postEntries([
    { account: 'INVENTORY', direction: 'DEBIT', amount: 15, metadata: {} },
    { account: 'CASH', direction: 'CREDIT', amount: 15, metadata: {} },
  ], { occurredAt: NOW, sourceModule: 'EXPENSE', sourceId: 'ex-frei' }));
  reload();
  const vorU = alles(db);
  const eA2 = await abgang(db, 'mA', 1);
  ok(!eA2.ok && /VALUE_NOT_PROVEN/.test(eA2.code) && /unknown origin/.test(String(sa?.lotlessValueIssue('mA'))) && alles(db) === vorU,
    `M nicht zuordenbare INVENTORY-Buchung (Ausgabe ohne Reparatur): Artikel ohne Los fail-closed, nichts verändert (${eA2.code})`);
  const eB2 = await abgang(db, 'mB', 1);
  ok(eB2.ok && eB2.r.accounting === 'BOOKED', `M …der Artikel mit belegtem Los bleibt korrigierbar (sein Wert hängt an seiner Einkaufszeile) (${eB2.code || 'ok'})`);
}
// ══ Y — Sync-Parität: eine zweite Testdatenbank bekommt jeden Abgleich-Eintrag über denselben Anwendeweg wie beim Abholen ══
//   Spiegel = Kopie des Primary zum Stichpunkt vor den Korrekturen; danach jeder Eintrag des Primary über `applySyncChange`
//   (samt Manifest-Prüfung). Verglichen: alle Belegzeilen, Artikel (Menge, Status), Los (Rest, Status), Hauptbuch (Anzahl,
//   Salden je Konto, die Buchungszeilen der Belege).
{
  const ap = await import('../../src/core/sync/apply-change.ts');
  const maxLog = (d: Db): number => n(d, 'SELECT COALESCE(MAX(id), 0) FROM sync_changelog');
  function spiegeln(prim: Db, spiegel: Db, ab: number): { bis: number; abgewiesen: string[] } {
    const r = prim.exec('SELECT id, table_name, record_id, action, data FROM sync_changelog WHERE id > ? ORDER BY id', [ab])[0];
    const abgewiesen: string[] = [];
    let bis = ab;
    for (const v of r?.values ?? []) {
      bis = Number(v[0]);
      try { ap.applySyncChange(spiegel as never, { table_name: String(v[1]), record_id: String(v[2]), action: String(v[3]), data: String(v[4] ?? '{}') }); }
      catch (e) { abgewiesen.push(`${String(v[1])}/${String(v[3])}: ${String((e as { code?: unknown }).code ?? (e as Error).message)}`); }
    }
    return { bis, abgewiesen };
  }
  const bild = (d: Db): string => S({
    belege: d.exec('SELECT * FROM stock_adjustments ORDER BY id')[0]?.values ?? [],
    artikel: d.exec("SELECT id, quantity, stock_status FROM products WHERE id IN ('ya','yb') ORDER BY id")[0]?.values,
    lose: d.exec("SELECT id, qty_remaining, status FROM stock_lots WHERE product_id = 'yb' ORDER BY id")[0]?.values,
    hauptbuch: n(d, 'SELECT COUNT(*) FROM ledger_entries'),
    salden: d.exec("SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) FROM ledger_entries GROUP BY account ORDER BY account")[0]?.values,
    belegbuchungen: d.exec("SELECT id, account, direction, amount, reverses_entry_id FROM ledger_entries WHERE source_module = 'STOCK_ADJUST' ORDER BY id")[0]?.values ?? [],
  });
  const prim = freshDb();
  product(prim, 'ya', 300, 3); product(prim, 'yb', 300, 0); reload();
  kauf('yb', 2, 300);
  const ab = maxLog(prim);
  const spiegel = new SQL.Database((prim as unknown as { export(): Uint8Array }).export()) as unknown as Db;
  const a = await abgang(prim, 'ya', 1);
  const b = await abgang(prim, 'yb', 1);
  const s1 = spiegeln(prim, spiegel, ab);
  ok(a.ok && b.ok && s1.abgewiesen.length === 0 && bild(spiegel) === bild(prim) && n(spiegel, 'SELECT COUNT(*) FROM stock_adjustments') === 2,
    `Y Anlegen: beide Belege, Artikelmengen, Los, Hauptbuch (inkl. Bestandsverlust) auf dem Spiegel gleich (abgewiesen: ${s1.abgewiesen.join('; ') || 'keiner'})`);
  const c1 = await storno(a.r.adjustmentId);
  const c2 = await storno(b.r.adjustmentId);
  const s2 = spiegeln(prim, spiegel, s1.bis);
  ok(c1.ok && c2.ok && s2.abgewiesen.length === 0 && bild(spiegel) === bild(prim)
    && n(spiegel, "SELECT COUNT(*) FROM stock_adjustments WHERE status = 'CANCELLED'") === 2 && qtyOf(spiegel, 'ya') === 3 && qtyOf(spiegel, 'yb') === 2,
    `Y Storno: beide Belege auf beiden Seiten CANCELLED, Mengen, Los und Hauptbuch (Rücknahme) gleich (abgewiesen: ${s2.abgewiesen.join('; ') || 'keiner'})`);
  const vorRepl = bild(spiegel);
  const s3 = spiegeln(prim, spiegel, ab);   // derselbe Abgleich noch einmal von vorn
  ok(s3.abgewiesen.length === 0 && bild(spiegel) === vorRepl && bild(spiegel) === bild(prim),
    `Y Wiederholung des ganzen Abgleichs: keine doppelte Anwendung (Belege, Mengen, Los, Hauptbuch unverändert)`);
  let code = '';
  try { ap.applySyncChange(spiegel as never, { table_name: 'stock_adjustments', record_id: String(a.r.adjustmentId), action: 'delete', data: '{}' }); }
  catch (e) { code = String((e as { code?: unknown }).code ?? (e as Error).message); }
  ok(code === ap.SYNC_OPERATION_NOT_ALLOWED && n(spiegel, 'SELECT COUNT(*) FROM stock_adjustments') === 2,
    `Y nicht erlaubt: ein delete auf Korrekturbelegen wird nicht angewendet, der Beleg bleibt (${code || 'ANGEWANDT'})`);
}
// ══ P — Pins ════════════════════════════════════════════════════════════════════════════════════════════════
{
  // Die Lagerwert-Herkunft (Kopf von stock-adjustment.ts) hängt an genau diesen INVENTORY-Sollbuchungen im Code:
  const post = src('src/core/ledger/posting.ts');
  const soll = [...post.matchAll(/account: 'INVENTORY',\s*direction: 'DEBIT'/g)].length;
  const fremd: string[] = [];
  for (const rel of readdirSync(resolvePath(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx)$/.test(rel) || /ledger[\\/]posting\.ts$/.test(rel)) continue;
    if (/account: 'INVENTORY',\s*direction: 'DEBIT'/.test(src('src/' + rel.replace(/\\/g, '/')))) fremd.push(rel);
  }
  ok(soll === 2 && fremd.length === 0 && /if \(e\.category === 'Inventory'\) return 'INVENTORY'/.test(src('src/core/models/types.ts'))
    && /account: 'INVENTORY' \| 'COGS'; amount: number/.test(post),
    `P INVENTORY im Soll nur aus Einkauf und Retouren-Wareneinsatz (2 Stellen), dazu Reparaturkosten — ein neuer Weg muss die Herkunftsregel anpassen (${soll}; ${fremd.join(', ') || 'keine fremden'})`);
  const nutzer: string[] = [];
  for (const rel of readdirSync(resolvePath(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const t = src('src/' + rel.replace(/\\/g, '/')).replace(/export function \w+/g, '');
    if (/issueStock(InHouse|OnPrimary)\(|cancelStockAdjustment(InHouse|OnPrimary)\(/.test(t)) nutzer.push(rel.replace(/\\/g, '/'));
  }
  ok(S(nutzer.sort()) === S(['components/products/StockAdjustmentPanel.tsx', 'core/stock/stock-adjustment.ts']),
    `P ausgelöst nur aus der Karte „Stock corrections" — kein Start, kein Update (${S(nutzer)})`);
  const pd = src('src/pages/watches/ProductDetail.tsx');
  ok(/!editing && perm\.isOwner && !primaryOnlyLocked\(\) && \(\s*<StockAdjustmentPanel/.test(pd), 'P die Karte erscheint nur für den Owner und nur am Primary');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — stock adjustment phase 1: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
