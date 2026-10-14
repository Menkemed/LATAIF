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
  imHaus(() => posting.postOpeningBalances('branch-main', 'user-test'));
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
  ok(registry.ALLOWED_MUTATIONS.at(-2) === 'stock_adjustments.issue' && registry.ALLOWED_MUTATIONS.at(-1) === 'stock_adjustments.cancel'
    && readOps.STORE_READ_OPS.includes('stock_adjustments.product.get') && perms.isOperationCovered('stock_adjustments.product.get')
    && /OP_STOCK_ISSUE,\s*OP_STOCK_CANCEL,\s*OP_STOCK_PRODUCT_GET,\s*\];/.test(src('src-tauri/src/bridge.rs'))
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

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — old stock foundation: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
