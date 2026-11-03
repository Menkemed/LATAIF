// ════════════════════════════════════════════════════════════════════════════
// HOTFIX F1 — Altbestand + Einkauf desselben Artikels: Mengen addieren, Einstände je Los.
// Run: node test/hotfix-f1/old-stock-purchase.test.ts
//
//   §A Altbestand 2 (New Collection/Import, ohne Los) + Einkauf 4 → 6; Los 2 × alt + Los 4 × neu; Einkauf unverändert
//   §B wiederholter Einkauf (+1 → 7, kein zweites Altbestands-Los); Verkauf FIFO zuerst aus dem Altbestand
//   §C Einkaufs-Storno → 2 bleiben; Nachtragen einer Position; PC2 (purchases.create) = Primary
//   §D „Add old stock" als Herkunft; Kommission, Auftragsartikel, Artikel mit Los-Historie: unverändert
//   §E Buchungen: der Altbestand bleibt ungebucht (keine INVENTORY-Buchung für das Altbestands-Los)
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
/** Einkauf: Stückpreis BRUTTO, wie die Maske ihn nimmt. */
function kauf(productId: string, quantity: number, unitPrice: number, vat: boolean): string {
  const id = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1',
    lines: [{ productId, quantity, unitPrice, taxScheme: vat ? 'VAT_10' as const : 'ZERO' as const, vatRate: vat ? 10 : 0 }],
  }).id);
  reload();
  return id;
}

const cmd = await import('../../src/core/bridge/commercial-commands.ts');
await import('../../src/core/bridge/read-commands.ts');
const { addOldStockInHouse } = await import('../../src/core/stock/stock-adjustment.ts');
const { oldStockRowsFor } = await import('../../src/core/stock/old-stock-reconciliation.ts');
const { getAvailableStock } = await import('../../src/core/lots/lot-queries.ts');
const { appendPurchaseLinesInHouse } = await import('../../src/stores/purchaseStore.ts');

const all = (db: Db, sql: string, p: unknown[] = []): string => S(db.exec(sql, p)[0]?.values ?? []);
const menge = (db: Db, pid: string): number => n(db, 'SELECT quantity FROM products WHERE id = ?', [pid]);
/** Die Lose eines Artikels: [aus Einkauf?, Einstand, gesamt, Rest, Status] in Reihenfolge des Zugangs. */
const lose = (db: Db, pid: string): string => all(db,
  'SELECT purchase_id IS NOT NULL, ROUND(unit_cost, 3), qty_total, qty_remaining, status FROM stock_lots WHERE product_id = ? ORDER BY acquired_at, created_at, rowid', [pid]);
const konto = (db: Db, acc: string): number => r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account = ?", [acc]));
const OLD = '2026-09-01T08:00:00.000Z';
/** Altbestand ohne Los (wie New Collection / Excel-Import): Menge und historischer Einkaufspreis am Artikel. */
function altbestand(db: Db, id: string, qty: number, price: number): void {
  product(db, id, price, qty);
  db.run('UPDATE products SET purchase_date = ?, created_at = ? WHERE id = ?', ['2026-09-01', OLD, id]);
  reload();
}
const LINE = (productId: string, qty = 1, price = 1000) => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: price * qty,
});

// ── §A Altbestand 2 + Einkauf 4 = 6, zwei Einstände ─────────────────────────────────────────────
{
  const db = freshDb();
  altbestand(db, 'rolex', 2, 100);
  ok(menge(db, 'rolex') === 2 && lose(db, 'rolex') === '[]', '§A Ausgang: 2 Stück Altbestand, kein Los');
  const kaufId = kauf('rolex', 4, 150, false);
  ok(menge(db, 'rolex') === 6, `§A Altbestand 2 + Einkauf 4 = 6 (vorher 4) — ${menge(db, 'rolex')}`);
  ok(lose(db, 'rolex') === '[[0,100,2,2,"ACTIVE"],[1,150,4,4,"ACTIVE"]]',
    `§A zwei Lose: 2 × 100 (Altbestand, ohne Einkauf) und 4 × 150 (Einkauf) — ${lose(db, 'rolex')}`);
  ok(getAvailableStock('rolex') === 6 && useProductStore.getState().products.find((p) => p.id === 'rolex')?.quantity === 6,
    '§A Collection (Lader) und verfügbarer Bestand zeigen 6');
  ok(all(db, 'SELECT quantity, unit_price, line_total FROM purchase_lines WHERE purchase_id = ?', [kaufId]) === '[[4,150,600]]'
    && n(db, 'SELECT total_amount FROM purchases WHERE id = ?', [kaufId]) === 600, '§A der Einkauf selbst bleibt 4 × 150 = 600');
  ok(konto(db, 'INVENTORY') === 600 && n(db, 'SELECT COUNT(*) FROM ledger_entries WHERE source_id IN (SELECT id FROM stock_lots WHERE purchase_id IS NULL)') === 0,
    '§E Hauptbuch: INVENTORY nur der Einkauf (600) — der Altbestand bleibt ungebucht');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'stock_lots' AND new_value LIKE '%OLD_STOCK_KEPT_ON_FIRST_PURCHASE%'") === 1,
    '§A die Übernahme des Altbestands als Los steht im Protokoll');
  const row = oldStockRowsFor({ branchId: 'branch-main' }).find((r) => r.productId === 'rolex');
  ok(row && row.klass === 'REVIEW' && row.reasons.includes('LOT_NOT_FROM_BOOKED_PURCHASE'),
    `§A Old-Stock-Seite: der Artikel bleibt Prüffall (Altbestand ungebucht) statt still „gebucht" (${row?.klass} ${S(row?.reasons)})`);
  // Mit 10 % Vorsteuer: neues Los netto, Altbestand mit seinem historischen Preis.
  altbestand(db, 'omega', 2, 100);
  kauf('omega', 4, 110, true);
  ok(menge(db, 'omega') === 6 && lose(db, 'omega') === '[[0,100,2,2,"ACTIVE"],[1,100,4,4,"ACTIVE"]]',
    `§A Einkauf mit VAT 10 %: 6 Stück, Altbestand 2 × 100, Einkauf 4 × 100 netto — ${lose(db, 'omega')}`);
}

// ── §B wiederholter Einkauf, Verkauf FIFO ───────────────────────────────────────────────────────
{
  const db = freshDb();
  altbestand(db, 'tudor', 2, 100);
  kauf('tudor', 4, 150, false);
  kauf('tudor', 1, 200, false);
  ok(menge(db, 'tudor') === 7 && n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = 'tudor' AND purchase_id IS NULL") === 1,
    `§B zweiter Einkauf +1 → 7, kein zweites Altbestands-Los — ${lose(db, 'tudor')}`);
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE('tudor', 1, 1000)] as never, 'F1').id);
  reload();
  ok(menge(db, 'tudor') === 6 && n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [inv]) === 100
    && lose(db, 'tudor').startsWith('[[0,100,2,1,"ACTIVE"]'),
    `§B Verkauf nimmt FIFO zuerst den Altbestand (Einstand 100), Bestand 6 — ${lose(db, 'tudor')}`);
}

// ── §C Storno, Nachtragen, PC2 ──────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  altbestand(db, 'cartier', 2, 100);
  const kaufId = kauf('cartier', 4, 150, false);
  const m = meldung(() => imHaus(() => life.cancelPurchaseInHouse(kaufId, 'branch-main')));
  reload();
  ok(m === '' && menge(db, 'cartier') === 2 && lose(db, 'cartier') === '[[0,100,2,2,"ACTIVE"],[1,150,4,4,"CANCELLED"]]',
    `§C Einkaufs-Storno: die 4 gehen, die 2 Altbestand bleiben — ${m || lose(db, 'cartier')}`);

  altbestand(db, 'breitling', 3, 80);
  product(db, 'anderer', 0, 0); reload();
  const kauf2 = kauf('anderer', 1, 50, false);
  const datum = s(db, 'SELECT purchase_date FROM purchases WHERE id = ?', [kauf2]);
  const m2 = meldung(() => imHaus(() => appendPurchaseLinesInHouse(kauf2, datum, [{ productId: 'breitling', quantity: 2, unitPrice: 90 }] as never, CTX)));
  reload();
  ok(m2 === '' && menge(db, 'breitling') === 5 && lose(db, 'breitling') === '[[0,80,3,3,"ACTIVE"],[1,90,2,2,"ACTIVE"]]',
    `§C Position nachgetragen (Purchase Edit): 3 + 2 = 5 — ${m2 || lose(db, 'breitling')}`);

  altbestand(db, 'iwc', 2, 100);
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const deps = { db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW };
  const out = await cmd.runPurchaseCreate(deps as never, { commandId: ID('71'), tenantId: 'tenant-1', branchId: 'branch-main',
    userId: 'user-pc2', role: 'ADMIN', op: 'purchases.create', payloadHash: 'h71' } as never,
  { supplierId: 'sup-1', lines: [{ productId: 'iwc', quantity: 4, unitPrice: 150 }] });
  reload();
  ok((out as { kind: string }).kind === 'ok' && menge(db, 'iwc') === 6 && lose(db, 'iwc') === '[[0,100,2,2,"ACTIVE"],[1,150,4,4,"ACTIVE"]]',
    `§C PC2 (purchases.create): dasselbe — 6, zwei Lose — ${S(out).slice(0, 160)} ${lose(db, 'iwc')}`);
  // Wiederholbarkeit: derselbe Auftrag (gleiche Kennung) ein zweites Mal — eingefrorene Antwort, kein zweites Los.
  const nochmal = await cmd.runPurchaseCreate(deps as never, { commandId: ID('71'), tenantId: 'tenant-1', branchId: 'branch-main',
    userId: 'user-pc2', role: 'ADMIN', op: 'purchases.create', payloadHash: 'h71' } as never,
  { supplierId: 'sup-1', lines: [{ productId: 'iwc', quantity: 4, unitPrice: 150 }] });
  reload();
  ok((nochmal as { kind: string; replayed?: boolean }).kind === 'ok' && (nochmal as { replayed?: boolean }).replayed === true
    && menge(db, 'iwc') === 6 && n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = 'iwc'") === 2
    && n(db, "SELECT COUNT(*) FROM purchase_lines WHERE product_id = 'iwc'") === 1,
    `§C derselbe PC2-Auftrag noch einmal: wiederholt, weiterhin 6, ein Altbestands-Los, ein Einkauf (${S(nochmal).slice(0, 80)})`);
  // Doppelt in EINEM Einkauf (zwei Zeilen desselben Artikels): ein Altbestands-Los, beide Einkaufslose.
  altbestand(db, 'zenith', 2, 100);
  imHaus(() => usePurchaseStore.getState().createPurchase({ supplierId: 'sup-1', lines: [
    { productId: 'zenith', quantity: 1, unitPrice: 150, taxScheme: 'ZERO' as const, vatRate: 0 },
    { productId: 'zenith', quantity: 3, unitPrice: 160, taxScheme: 'ZERO' as const, vatRate: 0 }] }));
  reload();
  ok(menge(db, 'zenith') === 6 && n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = 'zenith' AND purchase_id IS NULL") === 1,
    `§C zwei Zeilen desselben Artikels in einem Einkauf: 2 + 1 + 3 = 6, genau ein Altbestands-Los — ${lose(db, 'zenith')}`);
}

// ── §D Herkunft „Add old stock"; Kommission, Auftrag, Los-Historie unverändert ──────────────────
{
  const db = freshDb();
  altbestand(db, 'patek', 1, 100);
  const r = meldung(() => imHaus(() => addOldStockInHouse({ actionId: 'f1-add-old-0001', productId: 'patek', quantity: 1, expectedQuantity: 1,
    unitCost: 100, reason: 'found in safe' }, { ...CTX, role: 'ADMIN' })));
  reload();
  kauf('patek', 4, 150, false);
  ok(r === '' && menge(db, 'patek') === 6 && lose(db, 'patek') === '[[0,100,2,2,"ACTIVE"],[1,150,4,4,"ACTIVE"]]',
    `§D Altbestand über „Add old stock" (1 + 1) + Einkauf 4 = 6 — ${r || lose(db, 'patek')}`);

  product(db, 'kom', 0, 1);
  db.run("UPDATE products SET source_type = 'CONSIGNMENT', stock_status = 'consignment' WHERE id = 'kom'");
  reload();
  imHaus(() => usePurchaseStore.getState().createPurchase({ supplierId: 'sup-1',
    lines: [{ productId: 'kom', quantity: 1, unitPrice: 800, taxScheme: 'ZERO' as const, vatRate: 0, sourceConsignmentId: 'con-1' }] } as never));
  reload();
  ok(menge(db, 'kom') === 1 && lose(db, 'kom') === '[[1,800,1,1,"ACTIVE"]]', `§D Kommission: dasselbe Stück — 1, ein Los (${lose(db, 'kom')})`);

  product(db, 'auftrag', 0, 0); reload();
  kauf('auftrag', 1, 500, false);
  ok(menge(db, 'auftrag') === 1 && lose(db, 'auftrag') === '[[1,500,1,1,"ACTIVE"]]', '§D Auftrags-/Neuartikel mit Menge 0: nur das Einkaufslos');

  product(db, 'los', 0, 0); reload();
  kauf('los', 2, 100, false); kauf('los', 3, 120, false);
  ok(menge(db, 'los') === 5 && n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = 'los' AND purchase_id IS NULL") === 0,
    '§D Artikel mit Los-Historie: wie bisher Σ Lose (2 + 3 = 5), kein Altbestands-Los');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — hotfix F1 old stock + purchase: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('HOTFIX_F1_OLD_STOCK_PURCHASE_PROVED');
