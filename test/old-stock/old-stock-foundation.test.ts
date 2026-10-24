// ════════════════════════════════════════════════════════════════════════════
// STOCK CORRECTION 2+3 — FOUNDATION: Altbestand (New Collection Desktop/Handy, Excel-Import) ohne Geld und ohne Buchung,
// „Add Old Stock" (Mengen-Zugang, Eröffnung offen), schreibgeschützte Eröffnungsvorschau, Owner am PC2, Analytics ohne
// erfundenen Abfluss. Nur künstliche Testdaten.
// Gerüst aus test/stock-adjustment/stock-adjustment-phase1.test.ts (echte sql.js-Datenbank, echte Migrationen, Stores, Hauptbuch).
// Run: node test/old-stock/old-stock-foundation.test.ts
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

const { updatePayload, PRODUCT_UPDATE_FIELDS } = await import('../../src/core/data/write-payloads.ts');
const analytics = await import('../../src/core/reports/analytics-snapshot.ts');
const ledgerQ = await import('../../src/core/ledger/queries.ts');
const RCTX = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };

// ══ B — New Collection (Desktop): kein „Paid from", kein behaupteter Kassenabzug, Altwert bleibt ═══════════
{
  const wl = src('src/pages/watches/WatchList.tsx');
  const pd = src('src/pages/watches/ProductDetail.tsx');
  ok(!/PAID FROM|Will deduct|paidFrom: opt/.test(wl) && /historical cost, no money is booked/.test(wl),
    'B1 Desktop New Collection: kein „Paid from", kein „Will deduct from Cash"; der Hinweis sagt: historischer Einstand, kein Geld');
  ok(!/PAID FROM|paidFrom: opt/.test(pd), 'B2 Artikel bearbeiten: kein „Paid from"-Wähler mehr');
  const db = freshDb();
  product(db, 'alt', 667, 1);
  db.run("UPDATE products SET paid_from = 'cash' WHERE id = 'alt'");
  reload();
  const l0 = ledgerCount(db);
  const p = useProductStore.getState().products.find((x) => x.id === 'alt')!;
  const diff = updatePayload(p as never, { ...p, name: 'Renamed' } as never, PRODUCT_UPDATE_FIELDS) as Record<string, unknown>;
  ok(!('paidFrom' in diff) && diff.name === 'Renamed', `B3 die Änderungsabsicht trägt paidFrom nie, solange niemand es ändert (${S(Object.keys(diff))})`);
  imHaus(() => useProductStore.getState().updateProduct('alt', diff as never));
  ok(s(db, "SELECT paid_from FROM products WHERE id = 'alt'") === 'cash' && s(db, "SELECT name FROM products WHERE id = 'alt'") === 'Renamed'
    && ledgerCount(db) === l0, 'B4 bearbeitet: der früher gespeicherte Wert bleibt unverändert, keine Buchung');
  const neu = imHaus(() => useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Rolex', name: 'Old stock', quantity: 2, purchasePrice: 900 } as never));
  ok(ledgerCount(db) === l0 && n(db, 'SELECT COUNT(*) FROM stock_lots WHERE product_id = ?', [neu.id]) === 0
    && one(db, 'SELECT paid_from FROM products WHERE id = ?', [neu.id]) === null && n(db, 'SELECT quantity FROM products WHERE id = ?', [neu.id]) === 2,
    'B5 Desktop New Collection legt Altbestand an: keine Buchung, kein Los, kein paid_from, Menge 2');
}

// ══ C — Analytics: kein erfundener Abfluss für Altbestand; Salden weiter aus dem Hauptbuch ═══════════════════
{
  const db = freshDb();
  product(db, 'alt', 667, 1);
  db.run("UPDATE products SET paid_from = 'cash' WHERE id = 'alt'");
  db.run("DELETE FROM settings WHERE branch_id = 'branch-main' AND key = 'finance.opening_cash'");
  insert(db, 'settings', { id: 'set-oc', branch_id: 'branch-main', key: 'finance.opening_cash', value: '1000' });
  // B1 OPENING ACCOUNTING — postOpeningBalances bucht nicht mehr (eingefroren); die Eröffnung steht so im Hauptbuch,
  // wie ein früherer Stand sie gebucht hat (01.01.2000, Quelle OPENING_BALANCE).
  imHaus(() => posting.postEntries([
    { account: 'CASH', direction: 'DEBIT', amount: 1000, metadata: { kind: 'opening_balance' } },
    { account: 'OPENING_BALANCE_EQUITY', direction: 'CREDIT', amount: 1000, metadata: { kind: 'opening_balance' } },
  ], { occurredAt: '2000-01-01T00:00:00.000Z', sourceModule: 'OPENING_BALANCE', sourceId: 'opening:branch-main', branchId: 'branch-main', userId: 'user-test' }));
  reload();
  const f = analytics.financeFor(RCTX) as Record<string, number> | null;
  ok(!!f && !('productEkCash' in f) && !('productEkBank' in f), 'C1 die Finanzsicht kennt keinen „Product EK"-Abfluss mehr');
  ok(!!f && eq(f.cashBalance, ledgerQ.balanceOf('CASH', { branchId: 'branch-main' })) && eq(f.cashBalance, 1000),
    `C2 Kassensaldo aus dem Hauptbuch, unberührt vom Altbestand mit paid_from = cash (${f?.cashBalance})`);
  ok(!/productEk|EK paid out/.test(src('src/pages/analytics/AnalyticsPage.tsx')) && !/\bpaid_from\b/.test(src('src/core/reports/analytics-snapshot.ts').replace(/\/\/.*$/gm, '')),
    'C3 weder Seite noch Auswertung lesen products.paid_from als Geldabfluss');
}

// ══ D — Owner am PC2: dieselbe Hausfolge am Primary über Fernbefehle (Rolle des Absenders, Replay, Rollback) ═════
const cmdS = await import('../../src/core/bridge/stock-adjustment-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');
const { remoteReadContext } = await import('../../src/core/data/read-context.ts');
const XID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000cc`;
const ident = (x: string, op: string, hash = 'h' + x) => ({ commandId: XID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', op, payloadHash: hash });
const dps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
const issueBody = (db: Db, pid: string, actionId: string, quantity = 1): Record<string, unknown> => ({
  actionId, productId: pid, quantity, expectedQuantity: qtyOf(db, pid), reasonCategory: 'LOST', reason: 'missing at the count (PC2)', businessDate: '2026-10-07',
});
const ledgerRows = (db: Db, id: string): number => n(db, 'SELECT COUNT(*) FROM remote_command_ledger WHERE command_id = ?', [XID(id)]);
const valueOf = (o: unknown): Record<string, unknown> => ((o as { value?: Record<string, unknown> }).value ?? {});
{
  // D1 Rechte: am Netz entscheidet dieselbe Owner-Regel wie an der Karte, und die Hausfolge prüft sie noch einmal.
  ok(perms.permissionForOp('stock_adjustments.issue')?.kind === 'isOwner' && perms.permissionForOp('stock_adjustments.cancel')?.kind === 'isOwner'
    && perms.roleMayRunOp('ADMIN', 'stock_adjustments.issue') && !perms.roleMayRunOp('MANAGER', 'stock_adjustments.issue')
    && !perms.roleMayRunOp('', 'stock_adjustments.cancel') && !perms.roleMayRunOp('SALES', 'stock_adjustments.cancel'),
    'D1 Fernbefehle verlangen den Owner (ADMIN); Manager, Verkauf und eine fehlende Rolle dürfen nicht');
  ok(registry.ALLOWED_MUTATIONS.at(-12) === 'stock_adjustments.issue' && registry.ALLOWED_MUTATIONS.at(-11) === 'stock_adjustments.cancel'
    && readOps.STORE_READ_OPS.includes('stock_adjustments.product.get') && perms.isOperationCovered('stock_adjustments.product.get')
    && /OP_STOCK_ISSUE,\s*OP_STOCK_CANCEL,\s*OP_OLD_STOCK_ADD,\s*OP_STOCK_PRODUCT_GET,\s*OP_PAGE_OLD_STOCK_GET,/.test(src('src-tauri/src/bridge.rs'))
    && /import '\.\/stock-adjustment-commands';/.test(src('src/core/bridge/bridge-listener.ts')),
    'D1 namentlich freigegeben: zwei Buchungen, eine Auskunft — im Renderer und in Rust, am Primary angemeldet');

  const db = freshDb();
  product(db, 'p1', 300, 3); product(db, 'andere', 200, 5); reload();
  const andere = S(db.exec("SELECT * FROM products WHERE id = 'andere'")[0]?.values);
  const d = dps(db);
  const l0 = ledgerCount(db);
  const vor = alles(db);
  const m1 = await cmdS.runStockAction(sa!.issueStockInHouse as never, cmdS.ISSUE_KEYS, d, ident('1', 'stock_adjustments.issue'), 'MANAGER', issueBody(db, 'p1', 'pc2-act-1-xxxxxx'));
  ok(m1.kind === 'rejected' && (m1 as { code: string }).code === 'PERMISSION_DENIED' && (m1 as { frozen: boolean }).frozen
    && S({ ...JSON.parse(alles(db)), log: 0 }) === S({ ...JSON.parse(vor), log: 0 }),
    `D2 MANAGER vom PC2: die Hausfolge weist ab (eingefroren), nichts verändert (${S(m1)})`);

  const r1 = await cmdS.runStockAction(sa!.issueStockInHouse as never, cmdS.ISSUE_KEYS, d, ident('2', 'stock_adjustments.issue'), 'ADMIN', issueBody(db, 'p1', 'pc2-act-2-xxxxxx'));
  const v1 = valueOf(r1);
  const doc1 = adj(db, String(v1.adjustmentId));
  ok(r1.kind === 'ok' && qtyOf(db, 'p1') === 2 && doc1.accounting === 'ACCOUNTING_RECONCILIATION_PENDING' && doc1.created_by === 'user-pc2'
    && ledgerCount(db) === l0 && n(db, 'SELECT COUNT(*) FROM audit_log WHERE entity_id = ?', [String(v1.adjustmentId)]) === 1
    && n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'stock_adjustments' AND record_id = ?", [String(v1.adjustmentId)]) === 1
    && ledgerRows(db, '2') === 1,
    `D3 Owner vom PC2: Abgang am Primary — Beleg ${String(v1.adjustmentNumber)} des Absenders, Menge 3 → 2, keine erfundene Buchung, Protokoll, Sync, Nachweis (${r1.kind})`);
  const nach1 = alles(db);
  const r1b = await cmdS.runStockAction(sa!.issueStockInHouse as never, cmdS.ISSUE_KEYS, d, ident('2', 'stock_adjustments.issue'), 'ADMIN', { ...issueBody(db, 'p1', 'pc2-act-2-xxxxxx'), expectedQuantity: 3 });
  ok(r1b.kind === 'ok' && (r1b as { replayed: boolean }).replayed && alles(db) === nach1,
    `D4 dieselbe Kennung noch einmal (verlorene Antwort): Wiederholung, keine zweite Wirkung (${S(r1b).slice(0, 80)})`);
  const r1c = await cmdS.runStockAction(sa!.issueStockInHouse as never, cmdS.ISSUE_KEYS, d, ident('3', 'stock_adjustments.issue'), 'ADMIN', { ...issueBody(db, 'p1', 'pc2-act-2-xxxxxx'), expectedQuantity: 3 });
  ok(r1c.kind === 'ok' && String(valueOf(r1c).adjustmentId) === String(v1.adjustmentId) && qtyOf(db, 'p1') === 2
    && n(db, 'SELECT COUNT(*) FROM stock_adjustments') === 1 && ledgerCount(db) === l0,
    'D4 neue Kennung, dieselbe action_id (zweiter Versuch derselben Absicht): derselbe Beleg, keine zweite Wirkung');

  let payload = '';
  try { await cmdS.runStockAction(sa!.issueStockInHouse as never, cmdS.ISSUE_KEYS, d, ident('4', 'stock_adjustments.issue'), 'ADMIN', { ...issueBody(db, 'p1', 'pc2-act-4-xxxxxx'), value: 0 }); }
  catch (e) { payload = String((e as { code?: string }).code); }
  ok(payload === 'STOCK_PAYLOAD_INVALID' && qtyOf(db, 'p1') === 2 && ledgerRows(db, '4') === 0, `D5 ein Feld, das nur der Primary bestimmt (value), wird abgewiesen, bevor etwas läuft (${payload})`);

  // D6 Fehler mitten in der Transaktion: alles zurück, kein Nachweis — dieselbe Kennung läuft danach genau einmal.
  db.run("CREATE TRIGGER inject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'inject: audit'); END");
  const vorFehler = alles(db);
  let fehler = '';
  try { await cmdS.runStockAction(sa!.issueStockInHouse as never, cmdS.ISSUE_KEYS, d, ident('5', 'stock_adjustments.issue'), 'ADMIN', issueBody(db, 'p1', 'pc2-act-5-xxxxxx')); }
  catch (e) { fehler = (e as Error).message; }
  ok(/inject: audit/.test(fehler) && alles(db) === vorFehler && ledgerRows(db, '5') === 0, `D6 Fehler beim Protokoll: Beleg, Menge, Nummer, Sync zurück, kein Nachweis (${fehler.slice(0, 60)})`);
  db.run('DROP TRIGGER inject_audit');
  const r5 = await cmdS.runStockAction(sa!.issueStockInHouse as never, cmdS.ISSUE_KEYS, d, ident('5', 'stock_adjustments.issue'), 'ADMIN', issueBody(db, 'p1', 'pc2-act-5-xxxxxx'));
  ok(r5.kind === 'ok' && qtyOf(db, 'p1') === 1 && ledgerRows(db, '5') === 1, 'D6 …danach dieselbe Kennung: genau eine Wirkung (2 → 1)');

  const id5 = String(valueOf(r5).adjustmentId);
  const c1 = await cmdS.runStockAction(sa!.cancelStockAdjustmentInHouse as never, cmdS.CANCEL_KEYS, d, ident('6', 'stock_adjustments.cancel'), 'MANAGER', { adjustmentId: id5, reason: 'found again' });
  ok(c1.kind === 'rejected' && (c1 as { code: string }).code === 'PERMISSION_DENIED' && qtyOf(db, 'p1') === 1, 'D7 Storno vom PC2 als MANAGER: abgewiesen');
  const c2 = await cmdS.runStockAction(sa!.cancelStockAdjustmentInHouse as never, cmdS.CANCEL_KEYS, d, ident('7', 'stock_adjustments.cancel'), 'ADMIN', { adjustmentId: id5, reason: 'found again' });
  ok(c2.kind === 'ok' && qtyOf(db, 'p1') === 2 && adj(db, id5).status === 'CANCELLED' && ledgerCount(db) === l0,
    'D7 Storno vom PC2 als Owner: exakt zurück (1 → 2), keine Buchung');

  // D8 Auskunft: die Filiale kommt aus dem geprüften Absender; die Karte bekommt Belege und Vorschau vom Primary.
  const rd = sa!.stockCorrectionsFor(remoteReadContext({ branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' }), { productId: 'p1', issueQuantity: 1 });
  const fremd = sa!.stockCorrectionsFor(remoteReadContext({ branchId: 'branch-other', userId: 'user-pc2', role: 'ADMIN' }), { productId: 'p1', issueQuantity: null });
  ok(rd.docs.length === 2 && rd.issuePreview?.plan?.path === 'LOTLESS' && rd.issuePreview.plan.qtyBefore === 2 && fremd.docs.length === 0 && fremd.issuePreview === null,
    `D8 Fernauskunft: zwei Belege und die Vorschau der eigenen Filiale, eine fremde Filiale sieht nichts (${rd.docs.length}/${fremd.docs.length})`);
  ok(S(db.exec("SELECT * FROM products WHERE id = 'andere'")[0]?.values) === andere, 'D8 andere Artikel unberührt');

  const panel = src('src/components/products/StockAdjustmentPanel.tsx');
  ok(/w\.save<StockAdjustmentResult>\('stock_adjustments\.issue', \{\s*local: \(\) => issueStockOnPrimary\(input, reload\),\s*remote: \(\) => input,/.test(panel)
    && /w\.save<StockAdjustmentResult>\('stock_adjustments\.cancel', \{\s*local: \(\) => cancelStockAdjustmentOnPrimary\(input, reload\),\s*remote: \(\) => input,/.test(panel)
    && /useSharedRead<StockCorrectionsRead>\(\s*'stock_adjustments\.product\.get'/.test(panel) && !/stockAdjustmentsOf\(|previewStockIssue\(/.test(panel)
    && /!editing && perm\.isOwner && \(\s*<StockAdjustmentPanel/.test(src('src/pages/watches/ProductDetail.tsx')),
    'D9 die Karte: am Primary die Hausfolge lokal, am PC2 derselbe Rumpf als Fernbefehl; Lesen über die Auskunft; nur für den Owner');
  ok(/if \(isClientMode\(\)\) return nurPrimary\(\);\s*return runOnPrimary\(\(\) => issueStockInHouse/.test(src('src/core/stock/stock-adjustment.ts')),
    'D9 der lokale Anschluss schreibt am PC2 nie selbst (nur über den Primary)');
}
// D10 — ein Bild über alle fünf neuen Fernnamen: freigegeben, berechtigt, angemeldet, in Rust bekannt; jede Buchung nur
// für den Owner und nur über die Hausfolge am Primary (der lokale Anschluss weist am PC2 ab).
{
  const MUT = ['stock_adjustments.issue', 'stock_adjustments.cancel', 'stock_adjustments.add_old_stock'];
  const READ = ['stock_adjustments.product.get', 'page.old_stock.get'];
  const rs = src('src-tauri/src/bridge.rs');
  const rustNames = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rs)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)]
    .map((m) => new RegExp(`pub const ${m[0]}: &str = "([^"]+)"`).exec(rs)?.[1] ?? m[0]);
  const known = registry.knownCommands();
  const fehler: string[] = [];
  for (const op of MUT) {
    if (!registry.ALLOWED_MUTATIONS.includes(op)) fehler.push(`${op}: nicht freigegeben`);
    if (perms.OPERATION_PERMISSIONS[op]?.kind !== 'isOwner') fehler.push(`${op}: nicht nur Owner`);
    if (!known.includes(op)) fehler.push(`${op}: nicht angemeldet`);
    if (!rustNames.includes(op)) fehler.push(`${op}: Rust kennt es nicht`);
  }
  for (const op of READ) {
    if (!readOps.STORE_READ_OPS.includes(op) || !(op in perms.READ_PERMISSIONS)) fehler.push(`${op}: Auskunft nicht katalogisiert`);
    if (!known.includes(op)) fehler.push(`${op}: nicht angemeldet`);
    if (!rustNames.includes(op)) fehler.push(`${op}: Rust kennt es nicht`);
  }
  const sa2 = src('src/core/stock/stock-adjustment.ts');
  for (const h of ['issueStockInHouse', 'cancelStockAdjustmentInHouse', 'addOldStockInHouse']) {
    if (!new RegExp(`if \\(isClientMode\\(\\)\\) return nurPrimary\\(\\);\\s*return runOnPrimary\\(\\(\\) => ${h}`).test(sa2)) fehler.push(`${h}: lokaler Anschluss ohne PC2-Sperre`);
  }
  ok(fehler.length === 0 && rustNames.slice(-20, -15).join(',') === [...MUT, ...READ].join(','),
    `D10 drei Buchungen und zwei Auskünfte überall gleich (Freigabe, Owner-Recht, Anmeldung, Rust); lokale Anschlüsse sperren am PC2 (${fehler.join('; ') || 'konsistent'})`);
}

// ══ A — Altbestand: Erfassung ohne Geld, „Add Old Stock", schreibgeschützte Eröffnungsvorschau ═══════════════════
const osr = await import('../../src/core/stock/old-stock-reconciliation.ts');
const schema = await import('../../src/core/db/stock-adjustment-schema.ts');
const ap = await import('../../src/core/sync/apply-change.ts');
const RC = { branchId: 'branch-main' };
const rowOf = (pid: string) => osr.oldStockRowsFor(RC).find((r) => r.productId === pid);
async function altbestand(db: Db, pid: string, quantity: number, unitCost: number, over: Record<string, unknown> = {}): Promise<Aus> {
  try {
    const r = await sa!.addOldStockOnPrimary({ actionId: newAction(), productId: pid, quantity, expectedQuantity: qtyOf(db, pid),
      unitCost, reason: 'found in the second safe (old stock)', ...over }, reload);
    return { ok: true, code: '', r };
  } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message), r: {} }; }
}
/** Verkauf eines Artikels ohne Los zum Einstand wie an der Kasse (der Einstand der Zeile = historischer Einstand). */
function verkaufZu(pid: string, qty: number, cost: number): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ productId: pid, quantity: qty, unitPrice: 500, purchasePrice: cost,
    taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 500 * qty }] as never, 'OLD').id);
  reload();
  return id;
}
const ledgerSnap = (db: Db): string => S(db.exec('SELECT * FROM ledger_entries ORDER BY id')[0]?.values ?? []);
const balance = (db: Db, acc: string): number => r3(n(db, "SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [acc]));

// A1 — die Erfassungswege des Altbestands bewegen kein Geld und buchen nichts (bestätigte Regel C1/C2).
{
  ok(!/post[A-Z]\w*\(|createPurchase|recordPayment/.test(src('src/pages/settings/ImportPage.tsx'))
    && !/post[A-Z]\w*\(|createPurchase|recordPayment/.test(src('src/core/media/mobile-upload-wiring.ts'))
    && !/\bpost[A-Z]\w*\(|createPurchase|recordPayment/.test(src('src/core/media/product-media-create.ts')),
    'A1 Excel-Import, Handy-Erfassung und Anlage mit Medien rufen keine Buchung, keinen Einkauf und keine Zahlung');
  const db = freshDb();
  const l0 = ledgerSnap(db);
  const desk = imHaus(() => useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Omega', name: 'Desktop old stock', quantity: 3, purchasePrice: 400 } as never));
  product(db, 'import1', 250, 2); product(db, 'mobile1', 180, 1); reload();
  const rows = osr.oldStockRowsFor(RC);
  const cls = (id: string): string => rows.find((r) => r.productId === id)?.klass ?? 'FEHLT';
  ok(ledgerSnap(db) === l0 && n(db, 'SELECT COUNT(*) FROM purchases') === 0 && n(db, 'SELECT COUNT(*) FROM payments') === 0
    && cls(desk.id) === 'OPENING_CANDIDATE' && cls('import1') === 'OPENING_CANDIDATE' && cls('mobile1') === 'OPENING_CANDIDATE'
    && rowOf(desk.id)?.shelfValue === 1200 && rowOf('import1')?.shelfValue === 500,
    `A1 Desktop, Import und Handy: Altbestand ohne Buchung, ohne Einkauf, ohne Zahlung — in der Vorschau Eröffnungskandidaten mit Bestand × historischem Einstand (${cls(desk.id)}/${cls('import1')}/${cls('mobile1')})`);
}

// A2 — das Beispiel der Vorlage: 10 Uhren × 100 Altbestand, 4 verkauft, 1 fehlt (Abgang ohne Buchung), 5 im Regal.
{
  const db = freshDb();
  product(db, 'w', 100, 10); reload();
  verkaufZu('w', 4, 100);
  const ab = await abgang(db, 'w', 1);
  const vorher = alles(db);
  const r = rowOf('w');
  ok(!!r && r.klass === 'OPENING_CANDIDATE' && eq(r.soldCogs, 400) && r.pendingRemovalQty === 1 && eq(r.pendingRemovalValue, 100)
    && r.shelfQty === 5 && eq(r.shelfValue, 500) && eq(r.v1, 1000) && eq(r.v2, 900) && eq(balance(db, 'INVENTORY'), -400),
    `A2 Teil (a) 400 aus dem Hauptbuch, (b) 100 offener Abgang, (c) 500 im Regal: V1 1.000, V2 900; INVENTORY heute −400 (${S(r && { a: r.soldCogs, b: r.pendingRemovalValue, c: r.shelfValue, v1: r.v1, v2: r.v2 })}; Abgang ${ab.code || 'ok'})`);
  const rec = osr.oldStockReconciliationFor(RC);
  ok(alles(db) === vorher && S(osr.oldStockReconciliationFor(RC)) === S(rec) && S(osr.planOldStockOpening(RC, 'w')) === S(r),
    'A2 die Vorschau schreibt nichts, rechnet zweimal gleich, und der Einzelweg (spätere Buchung) liefert dieselbe Zeile');
  ok(rec.totals.candidates === 1 && eq(rec.totals.v1, 1000) && eq(rec.totals.v2, 900) && eq(rec.ledger.inventoryBalance, -400) && rec.ledger.unknownInventoryDebits === 0
    && rec.notes.some((x) => /nothing is booked/.test(x)), 'A2 Summen, Hauptbuch-Lage und der Hinweis „nichts gebucht"');
  // Verkauf vor der Eröffnung + Retoure eines Stücks: der gebuchte Wareneinsatz zählt netto, das zurückgenommene Stück einmal (im Regal).
  const inv = s(db, "SELECT i.id FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id WHERE il.product_id = 'w' LIMIT 1");
  const line = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  const lt = n(db, 'SELECT line_total FROM invoice_lines WHERE id = ?', [line]);
  const vat = n(db, 'SELECT vat_amount FROM invoice_lines WHERE id = ?', [line]);
  imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const rid = rs.createReturn({ invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK' as never, reason: 'customer brought one back',
      lines: [{ invoiceLineId: line, productId: 'w', quantity: 1, unitPrice: lt / 4, vatAmount: vat / 4 }] }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
  });
  reload();
  const r2 = rowOf('w');
  ok(!!r2 && eq(r2.soldCogs, 300) && r2.shelfQty === 6 && eq(r2.shelfValue, 600) && eq(r2.v2, 900) && eq(balance(db, 'INVENTORY'), -300),
    `A2 Retoure eines verkauften Stücks vor der Eröffnung: (a) 400 → 300, Regal 5 → 6 (600), V2 bleibt 900 — kein Stück doppelt (${S(r2 && { a: r2.soldCogs, q: r2.shelfQty, c: r2.shelfValue, v2: r2.v2 })})`);
}

// A3 — Einkaufspreis korrigiert: gebuchter Wareneinsatz bleibt, die Vorschau zeigt den Unterschied als Prüffall (D4).
{
  const db = freshDb();
  product(db, 'k', 100, 3); product(db, 'neu', 100, 2); reload();
  verkaufZu('k', 1, 100);
  const cogsVor = balance(db, 'COGS');
  imHaus(() => useProductStore.getState().updateProduct('k', { purchasePrice: 120 } as never));
  imHaus(() => useProductStore.getState().updateProduct('neu', { purchasePrice: 130 } as never));
  const rk = rowOf('k'); const rn = rowOf('neu');
  ok(eq(balance(db, 'COGS'), cogsVor) && eq(cogsVor, 100) && !!rk && eq(rk.soldCogs, 100) && eq(rk.shelfValue, 240)
    && rk.klass === 'REVIEW' && rk.reasons.includes('COST_DIFFERS_FROM_BOOKED_COGS'),
    `A3 nach dem Verkauf korrigiert: gebuchter Wareneinsatz 100 unverändert, Regal zum neuen Einstand, Prüffall „Wertunterschied" (${S(rk?.reasons)})`);
  ok(!!rn && rn.klass === 'OPENING_CANDIDATE' && eq(rn.shelfValue, 260), 'A3 vor jedem Verkauf korrigiert: Kandidat zum neuen historischen Einstand');
}

// A4 — „Add Old Stock": weitere Stücke eines erfassten Artikels — Beleg, Menge, Protokoll, Sync; keine Buchung.
{
  const db = freshDb();
  product(db, 'rolex', 900, 1); product(db, 'andere', 50, 4); reload();
  const andere = S(db.exec("SELECT * FROM products WHERE id = 'andere'")[0]?.values);
  const l0 = ledgerSnap(db); const a0 = audits(db); const c0 = changelog(db);
  const a1 = await altbestand(db, 'rolex', 2, 900);
  const d1 = a1.ok ? adj(db, String(a1.r.adjustmentId)) : {};
  ok(a1.ok && qtyOf(db, 'rolex') === 3 && statusOf(db, 'rolex') === 'in_stock' && d1.direction === 'RECEIPT' && d1.accounting === 'ACCOUNTING_RECONCILIATION_PENDING'
    && Number(d1.value_booked) === 0 && Number(d1.purchase_price_hint) === 900 && d1.reason_category === 'OLD_STOCK' && String(d1.adjustment_number).startsWith('ADJ-')
    && a1.r.direction === 'RECEIPT' && a1.r.unitCostHint === 900,
    `A4 Rolex 1 → 3: Beleg ${String(d1.adjustment_number)} RECEIPT, Eröffnung offen, Wert 0, historischer Einstand 900 (${a1.code || 'ok'})`);
  ok(ledgerSnap(db) === l0 && n(db, 'SELECT COUNT(*) FROM purchases') === 0 && n(db, 'SELECT COUNT(*) FROM payments') === 0,
    'A4 …keine Buchung, kein Einkauf, keine Zahlung, keine Lieferantenschuld');
  ok(audits(db) === a0 + 2 && changelog(db) === c0 + 2 && S(db.exec("SELECT * FROM products WHERE id = 'andere'")[0]?.values) === andere,
    'A4 …Protokoll (Beleg + Menge) und Sync (Beleg + Artikel); andere Artikel unberührt');
  const r = rowOf('rolex');
  ok(!!r && r.klass === 'OPENING_CANDIDATE' && r.oldStockReceipts === 1 && r.oldStockReceiptQty === 2 && eq(r.shelfValue, 2700),
    `A4 …die Vorschau nimmt die drei Stücke auf (Regal 2.700), der Beleg ist als Altbestand vermerkt (${S(r && { k: r.klass, c: r.shelfValue })})`);
  const nach = alles(db);
  const again = await sa!.addOldStockOnPrimary({ actionId: String(adj(db, String(a1.r.adjustmentId)).action_id), productId: 'rolex', quantity: 2, expectedQuantity: 1, unitCost: 900, reason: 'found in the second safe (old stock)' }, reload).catch((e: Error) => e);
  ok(!(again instanceof Error) && (again as Record<string, unknown>).adjustmentId === a1.r.adjustmentId && alles(db) === nach,
    'A4 dieselbe Absicht noch einmal (Doppelklick, verlorene Antwort): derselbe Beleg, keine zweite Wirkung');
  const st = await storno(String(a1.r.adjustmentId), 'counted twice');
  ok(st.ok && qtyOf(db, 'rolex') === 1 && adj(db, String(a1.r.adjustmentId)).status === 'CANCELLED' && ledgerSnap(db) === l0,
    `A4 Storno: wieder 1 Stück, Beleg storniert, keine Buchung (${st.code || 'ok'})`);
  const a2 = await altbestand(db, 'rolex', 2, 950);
  const m = rowOf('rolex');
  ok(a2.ok && m?.klass === 'OPENING_CANDIDATE' && m.valueClear && eq(m.shelfValue, 900 + 2 * 950) && m.costLayers.length === 2,
    `A4 anderer historischer Einstand (950 statt 900): erfasst, die Vorschau trennt die Wertblöcke (1 × 900 + 2 × 950) (${S(m?.costLayers)})`);
  verkauf('rolex', 1);
  const st2 = await storno(String(a2.r.adjustmentId), 'wrong');
  ok(!st2.ok && /MOVED_SINCE/.test(st2.code) && qtyOf(db, 'rolex') === 2, `A4 Storno nach einem Verkauf: abgewiesen (MOVED_SINCE), nichts verändert (${st2.code})`);
}

// A10 — gemischte historische Einstände (Review-Fall): 1 Stück à 250, dazu 2 Stück à 300 = 850 — nie 3 × 250, 3 × 300 oder
// ein Durchschnitt. Nach einem Verkauf ist ohne Los nicht mehr bekannt, welche Stücke übrig sind: kein Wert, Prüffall.
{
  const db = freshDb();
  product(db, 'mix', 250, 1); product(db, 'mix2', 250, 1); reload();
  const add = await altbestand(db, 'mix', 2, 300);
  const r = rowOf('mix');
  const doc = add.ok ? String(adj(db, String(add.r.adjustmentId)).adjustment_number) : '';
  ok(add.ok && !!r && r.klass === 'OPENING_CANDIDATE' && r.valueClear && r.shelfQty === 3 && eq(r.shelfValue, 850) && eq(r.v2, 850)
    && S(r.costLayers) === S([{ qty: 1, unitCost: 250, source: 'ITEM' }, { qty: 2, unitCost: 300, source: doc }]),
    `A10 1 × 250 (Artikel) + 2 × 300 (Beleg ${doc}) = 850, jeder Block mit Herkunft (${S(r && { c: r.shelfValue, layers: r.costLayers })})`);
  const cogs0 = balance(db, 'COGS');
  verkaufZu('mix', 1, 250);
  const r2 = rowOf('mix');
  const rec = osr.oldStockReconciliationFor(RC);
  ok(eq(balance(db, 'COGS'), cogs0 + 250) && !!r2 && r2.klass === 'REVIEW' && r2.reasons.includes('MIXED_COST_NOT_TRACEABLE') && !r2.valueClear
    && r2.v1 === 0 && r2.v2 === 0 && r2.costLayers.length === 0 && eq(r2.soldCogs, 250) && !rec.rows.some((x) => x.klass === 'OPENING_CANDIDATE' && x.productId === 'mix'),
    `A10 …nach einem Verkauf: gebuchter Wareneinsatz 250 bleibt wie gebucht, der Restwert ist nicht nachvollziehbar — Prüffall ohne Wert, kein Kandidat (${S(r2 && { k: r2.klass, why: r2.reasons, clear: r2.valueClear })})`);
  // Die Menge allein reicht nicht: Verkauf zwischen zwei Zugängen, danach stimmt die Menge wieder mit dem letzten Beleg —
  // aber welches Stück verkauft wurde (250 oder 300), weiß niemand.
  product(db, 'mix3', 250, 1); reload();
  await altbestand(db, 'mix3', 2, 300);
  verkaufZu('mix3', 1, 250);
  const nach = await altbestand(db, 'mix3', 1, 250);
  const r4 = rowOf('mix3');
  ok(nach.ok && qtyOf(db, 'mix3') === 3 && !!r4 && r4.klass === 'REVIEW' && r4.reasons.includes('MIXED_COST_NOT_TRACEABLE') && !r4.valueClear,
    `A10 Verkauf zwischen zwei Zugängen: Menge passt wieder, der Wert ist trotzdem nicht belegt — Prüffall (${S(r4 && { k: r4.klass, why: r4.reasons })})`);
  const add2 = await altbestand(db, 'mix2', 2, 300);
  const st = await storno(String(add2.r.adjustmentId), 'wrong cost');
  const r3row = rowOf('mix2');
  ok(add2.ok && st.ok && !!r3row && r3row.klass === 'OPENING_CANDIDATE' && eq(r3row.shelfValue, 250) && r3row.costLayers.length === 1,
    'A10 ein stornierter Beleg mit anderem Einstand zählt nicht mehr: wieder 1 × 250');
}

// A5 — Grenzen von „Add Old Stock" (fail-closed; BLOCKED bis zu den Eröffnungsregeln, wo nötig).
{
  const db = freshDb();
  product(db, 'g1', 300, 2); product(db, 'kauf1', 300, 0); product(db, 'aus', 300, 1); product(db, 'weg', 300, 3); reload();
  kauf('kauf1', 2, 300);
  verkauf('aus', 1);
  const vor = alles(db);
  const codes: Record<string, string> = {};
  codes.lots = (await altbestand(db, 'kauf1', 1, 300)).code;
  codes.sold = (await altbestand(db, 'aus', 1, 300)).code;
  codes.qty0 = (await altbestand(db, 'g1', 0, 300)).code;
  codes.qtyFrac = (await altbestand(db, 'g1', 1.5, 300)).code;
  codes.cost = (await altbestand(db, 'g1', 1, Number.NaN)).code;
  codes.costNeg = (await altbestand(db, 'g1', 1, -1)).code;
  codes.reason = (await altbestand(db, 'g1', 1, 300, { reason: '  ' })).code;
  codes.date = (await altbestand(db, 'g1', 1, 300, { businessDate: '2999-01-01' })).code;
  codes.seen = (await altbestand(db, 'g1', 1, 300, { expectedQuantity: 7 })).code;
  rolle('MANAGER'); codes.role = (await altbestand(db, 'g1', 1, 300)).code; rolle('ADMIN');
  ok(/BLOCKED_HAS_LOTS/.test(codes.lots) && /EXCLUDED_NOT_IN_STOCK/.test(codes.sold) && /QUANTITY_INVALID/.test(codes.qty0) && /QUANTITY_INVALID/.test(codes.qtyFrac)
    && /COST_REQUIRED/.test(codes.cost) && /COST_REQUIRED/.test(codes.costNeg) && /REASON_REQUIRED/.test(codes.reason) && /INVALID_DATE/.test(codes.date)
    && /STOCK_CHANGED/.test(codes.seen) && /PERMISSION_DENIED/.test(codes.role) && alles(db) === vor,
    `A5 abgewiesen ohne Wirkung: Artikel mit Losen (BLOCKED), ausverkauft, Menge 0/Bruch, Einstand fehlt/negativ, kein Grund, Zukunftsdatum, veraltete Menge, kein Owner (${S(codes)})`);
  const ab = await abgang(db, 'weg', 1);
  const vor2 = alles(db);
  const ohne = await altbestand(db, 'weg', 1, 300);
  ok(ab.ok && /REMOVED_PIECE_CHECK/.test(ohne.code) && alles(db) === vor2,
    `A5 Artikel mit offenem Abgang: ohne Bestätigung abgewiesen — ein wiedergefundenes Stück gehört zu seinem Abgang (${ohne.code.slice(0, 40)})`);
  const mit = await altbestand(db, 'weg', 1, 300, { confirmNotRemovedPiece: true });
  ok(mit.ok && qtyOf(db, 'weg') === 3 && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND new_value LIKE '%\"confirmedNotRemoved\":true%'", [String(mit.r.adjustmentId)]) === 1,
    'A5 …mit ausdrücklicher Bestätigung „andere Stücke": erfasst, die Bestätigung steht im Protokoll');
  insert(db, 'ledger_entries', { id: 'unk-1', branch_id: 'branch-main', entry_no: 99001, transaction_id: 'tx-unk', occurred_at: NOW, recorded_at: NOW, account: 'INVENTORY', direction: 'DEBIT', amount: 50, currency: 'BHD', source_module: 'MANUAL', source_id: 'x', created_at: NOW });
  const vor3 = alles(db);
  const unk = await altbestand(db, 'g1', 1, 300);
  const rec = osr.oldStockReconciliationFor(RC);
  ok(/VALUE_NOT_PROVEN/.test(unk.code) && alles(db) === vor3 && rec.ledger.unknownInventoryDebits === 1 && rec.totals.candidates === 0
    && rowOf('g1')?.reasons.includes('LEDGER_UNKNOWN_INVENTORY_DEBIT') && rec.notes.some((x) => /cannot be traced/.test(x)),
    `A5 eine nicht zuordenbare INVENTORY-Buchung im Hauptbuch: kein Zugang, kein Eröffnungskandidat, Hinweis in der Vorschau (${unk.code.slice(0, 30)})`);
}

// A6 — Parallelbetrieb mit Einkauf, Produktion und Reparatur: nur nachweislich nie aktivierte Ware wird Kandidat.
{
  const db = freshDb();
  product(db, 'alt', 200, 2); product(db, 'gekauft', 300, 0); product(db, 'misch', 300, 0); reload();
  kauf('gekauft', 2, 300);
  kauf('misch', 1, 300);
  db.run("UPDATE products SET quantity = 3 WHERE id = 'misch'");   // ein Stück ohne Los neben dem gekauften
  insert(db, 'stock_lots', { id: 'lot-prod', branch_id: 'branch-main', product_id: 'alt', unit_cost: 150, qty_total: 1, qty_remaining: 1, status: 'ACTIVE', unit: 'pcs', acquired_at: NOW, created_at: NOW });
  product(db, 'prod', 0, 1); product(db, 'custom', 400, 1); product(db, 'nul', 0, 1); reload();
  db.run("UPDATE products SET notes = 'From cancelled custom order — capitalized costs 400.000 BHD.' WHERE id = 'custom'");
  insert(db, 'production_records', { id: 'pr-1', branch_id: 'branch-main', created_at: NOW });
  insert(db, 'production_outputs', { id: 'po-1', record_id: 'pr-1', product_id: 'prod', output_value: 120 });
  const rows = osr.oldStockRowsFor(RC);
  const z = (id: string) => rows.find((r) => r.productId === id);
  ok(z('gekauft')?.klass === 'CAPITALISED' && z('gekauft')?.v1 === 0, `A6 gekaufte Ware: schon im Lagerwert — keine Eröffnung (${z('gekauft')?.klass})`);
  ok(z('misch')?.klass === 'REVIEW' && z('misch')!.reasons.includes('QUANTITY_DIFFERS_FROM_LOTS'), `A6 gekauft + Stück ohne Los: Prüffall (${S(z('misch')?.reasons)})`);
  ok(z('alt')?.klass === 'REVIEW' && z('alt')!.reasons.includes('LOT_NOT_FROM_BOOKED_PURCHASE'), `A6 Los ohne gebuchten Einkauf (Produktion/Keep): Prüffall, ein fehlendes Los ist nicht der Nachweis (${S(z('alt')?.reasons)})`);
  ok(z('prod')?.reasons.includes('FROM_PRODUCTION') && z('custom')?.reasons.includes('FROM_CANCELLED_CUSTOM_ORDER') && z('nul')?.reasons.includes('NO_HISTORICAL_COST')
    && z('prod')?.klass === 'REVIEW' && z('custom')?.klass === 'REVIEW' && z('nul')?.klass === 'REVIEW',
    'A6 Produktion, stornierter Sonderauftrag (Kosten schon als Ausgabe) und Artikel ohne Einstand: Prüffälle mit Grund');
}

// A7 — Owner am PC2: „Add Old Stock" als Fernbefehl, Vorschau als Auskunft.
{
  const db = freshDb();
  product(db, 'r2', 500, 1); reload();
  const d = dps(db);
  const body = { actionId: 'pc2-old-1-xxxxxx', productId: 'r2', quantity: 2, expectedQuantity: 1, unitCost: 500, reason: 'old stock from the shop safe' };
  const m = await cmdS.runStockAction(sa!.addOldStockInHouse as never, cmdS.OLD_STOCK_KEYS, d, ident('21', 'stock_adjustments.add_old_stock'), 'MANAGER', body);
  ok(m.kind === 'rejected' && (m as { code: string }).code === 'PERMISSION_DENIED' && qtyOf(db, 'r2') === 1
    && perms.permissionForOp('stock_adjustments.add_old_stock')?.kind === 'isOwner' && registry.ALLOWED_MUTATIONS.at(-10) === 'stock_adjustments.add_old_stock',
    'A7 Fernbefehl verlangt den Owner (Recht und Hausfolge), steht namentlich am Ende der Liste');
  const ok1 = await cmdS.runStockAction(sa!.addOldStockInHouse as never, cmdS.OLD_STOCK_KEYS, d, ident('22', 'stock_adjustments.add_old_stock'), 'ADMIN', body);
  const ok2 = await cmdS.runStockAction(sa!.addOldStockInHouse as never, cmdS.OLD_STOCK_KEYS, d, ident('22', 'stock_adjustments.add_old_stock'), 'ADMIN', body);
  ok(ok1.kind === 'ok' && ok2.kind === 'ok' && (ok2 as { replayed: boolean }).replayed && qtyOf(db, 'r2') === 3 && adj(db, String(valueOf(ok1).adjustmentId)).created_by === 'user-pc2',
    'A7 Owner vom PC2: 1 → 3 am Primary, Beleg des Absenders; dieselbe Kennung noch einmal ohne zweite Wirkung');
  let bad = '';
  try { await cmdS.runStockAction(sa!.addOldStockInHouse as never, cmdS.OLD_STOCK_KEYS, d, ident('23', 'stock_adjustments.add_old_stock'), 'ADMIN', { ...body, actionId: 'pc2-old-2-xxxxxx', accounting: 'BOOKED' }); }
  catch (e) { bad = String((e as { code?: string }).code); }
  ok(bad === 'STOCK_PAYLOAD_INVALID' && qtyOf(db, 'r2') === 3, `A7 ein Feld, das nur der Primary bestimmt (accounting), wird abgewiesen (${bad})`);
  const fern = osr.oldStockReconciliationFor(remoteReadContext({ branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' }));
  const fremd = osr.oldStockReconciliationFor(remoteReadContext({ branchId: 'branch-other', userId: 'user-pc2', role: 'ADMIN' }));
  ok(fern.rows.some((r) => r.productId === 'r2' && r.shelfQty === 3) && fremd.rows.length === 0 && readOps.STORE_READ_OPS.includes('page.old_stock.get'),
    'A7 Auskunft „page.old_stock.get": die Filiale des Absenders, eine fremde Filiale sieht nichts');
  const prev = sa!.stockCorrectionsFor(RC, { productId: 'r2', receiptQuantity: 1, receiptUnitCost: 500 });
  ok(!!prev.receiptPreview?.plan && prev.receiptPreview.plan.qtyBefore === 3 && prev.issuePreview === null, 'A7 die Karte bekommt die Zugangs-Vorschau vom Primary');
}

// A8 — Sync: Altbestands-Beleg und Storno auf einer zweiten Datenbank gleich; Wiederholung ohne Doppelwirkung.
{
  const maxLog = (d: Db): number => n(d, 'SELECT COALESCE(MAX(id), 0) FROM sync_changelog');
  function spiegeln(prim: Db, spiegel: Db, von: number): { bis: number; abgewiesen: string[] } {
    const r = prim.exec('SELECT id, table_name, record_id, action, data FROM sync_changelog WHERE id > ? ORDER BY id', [von])[0];
    const abgewiesen: string[] = []; let bis = von;
    for (const v of r?.values ?? []) {
      bis = Number(v[0]);
      try { ap.applySyncChange(spiegel as never, { table_name: String(v[1]), record_id: String(v[2]), action: String(v[3]), data: String(v[4] ?? '{}') }); }
      catch (e) { abgewiesen.push(`${String(v[1])}/${String(v[3])}: ${String((e as { code?: unknown }).code ?? (e as Error).message)}`); }
    }
    return { bis, abgewiesen };
  }
  const bild = (d: Db): string => S({ belege: d.exec('SELECT * FROM stock_adjustments ORDER BY id')[0]?.values ?? [], artikel: d.exec("SELECT id, quantity, stock_status FROM products WHERE id = 'sy'")[0]?.values, hb: n(d, 'SELECT COUNT(*) FROM ledger_entries') });
  const prim = freshDb();
  product(prim, 'sy', 700, 1); reload();
  const ab = maxLog(prim);
  const spiegel = new SQL.Database((prim as unknown as { export(): Uint8Array }).export()) as unknown as Db;
  const a = await altbestand(prim, 'sy', 2, 700);
  const s1 = spiegeln(prim, spiegel, ab);
  const st = await storno(String(a.r.adjustmentId), 'counted twice');
  const s2 = spiegeln(prim, spiegel, s1.bis);
  const vorRepl = bild(spiegel);
  const s3 = spiegeln(prim, spiegel, ab);
  ok(a.ok && st.ok && s1.abgewiesen.length === 0 && s2.abgewiesen.length === 0 && s3.abgewiesen.length === 0 && bild(spiegel) === bild(prim) && vorRepl === bild(spiegel)
    && n(spiegel, "SELECT COUNT(*) FROM stock_adjustments WHERE direction = 'RECEIPT' AND status = 'CANCELLED'") === 1 && qtyOf(spiegel, 'sy') === 1,
    `A8 Spiegel: Zugang, Storno und Wiederholung des ganzen Abgleichs gleich, keine Doppelwirkung (abgewiesen: ${[...s1.abgewiesen, ...s2.abgewiesen, ...s3.abgewiesen].join('; ') || 'keiner'})`);
}

// A9 — die Belegtabelle einer älteren Entwicklungsdatenbank (nur ISSUE erlaubt) wird einmal verlustfrei umgebaut.
{
  const alt = new SQL.Database() as unknown as Db;
  const ddl = MIGRATIONS.find((m) => m.includes('CREATE TABLE IF NOT EXISTS stock_adjustments'))!.replace("CHECK (direction IN ('ISSUE','RECEIPT','CORRECTION'))", "CHECK (direction IN ('ISSUE'))");
  alt.run(ddl);
  for (const ix of schema.STOCK_ADJUSTMENT_INDEXES) alt.run(ix);
  alt.run(`INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after, accounting, reason_category, reason, business_date, action_id, payload_hash, created_at)
    VALUES ('x1','branch-main','ADJ-1','p','ISSUE',1,2,1,'ACCOUNTING_RECONCILIATION_PENDING','LOST','r','2026-10-01','act-x1','h',?)`, [NOW]);
  let vorher = '';
  try { alt.run(`INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after, accounting, reason_category, reason, business_date, action_id, payload_hash, created_at) VALUES ('x2','branch-main','ADJ-2','p','RECEIPT',1,1,2,'ACCOUNTING_RECONCILIATION_PENDING','OLD_STOCK','r','2026-10-01','act-x2','h',?)`, [NOW]); }
  catch (e) { vorher = (e as Error).message; }
  const zeile = S(alt.exec("SELECT * FROM stock_adjustments WHERE id = 'x1'")[0]?.values);
  const umgebaut = schema.widenStockAdjustmentDirections(alt as never);
  alt.run(`INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after, accounting, reason_category, reason, business_date, action_id, payload_hash, created_at) VALUES ('x2','branch-main','ADJ-2','p','RECEIPT',1,1,2,'ACCOUNTING_RECONCILIATION_PENDING','OLD_STOCK','r','2026-10-01','act-x2','h',?)`, [NOW]);
  let doppelt = '';
  try { alt.run(`INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after, accounting, reason_category, reason, business_date, action_id, payload_hash, created_at) VALUES ('x3','branch-main','ADJ-3','p','RECEIPT',1,1,2,'ACCOUNTING_RECONCILIATION_PENDING','OLD_STOCK','r','2026-10-01','act-x2','h',?)`, [NOW]); }
  catch (e) { doppelt = (e as Error).message; }
  ok(/CHECK/.test(vorher) && umgebaut && S(alt.exec("SELECT * FROM stock_adjustments WHERE id = 'x1'")[0]?.values) === zeile && /UNIQUE/.test(doppelt)
    && schema.widenStockAdjustmentDirections(alt as never) === false && n(alt, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'stock_adjustments_widen'") === 0,
    `A9 Umbau: alte Zeile unverändert, RECEIPT jetzt erlaubt, eindeutige action_id bleibt, zweiter Lauf tut nichts (${umgebaut})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — old stock foundation: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
