// ════════════════════════════════════════════════════════════════════════════
// COLLECTION INITIAL QTY CORRECTION — „Correct initial qty“: die erste Mengeneingabe eines New-Collection-Artikels
// berichtigen (5 erfasst, 3 da), nur am nachweislich unberührten Artikel, Owner am Primary und PC2, Beleg CORRECTION mit
// Menge vorher/nachher, Grund, Zeit und Akteur, atomar, idempotent, Schutz gegen veraltete Fenster — KEINE Buchung.
// Gerüst aus test/old-stock/old-stock-foundation.test.ts (echte sql.js-Datenbank, echte Migrationen, Stores, Hauptbuch).
// Nur künstliche Testdaten. Run: node test/stock-correction/initial-qty-correction.test.ts
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
// Werkzeuge
// ════════════════════════════════════════════════════════════════════════════
const sa = await import('../../src/core/stock/stock-adjustment.ts');
const cmdS = await import('../../src/core/bridge/stock-adjustment-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const osr = await import('../../src/core/stock/old-stock-reconciliation.ts');
const schema = await import('../../src/core/db/stock-adjustment-schema.ts');
const { lifecycleEditRefusal } = await import('../../src/core/products/lifecycle-fields.ts');

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
const act = (): string => `iq-action-${++seqA}-xxxxxxxx`;
const qtyOf = (db: Db, pid: string): number => n(db, 'SELECT quantity FROM products WHERE id = ?', [pid]);
const ledgerCount = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const imbalance = (db: Db): number => Number(one(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries") ?? 0);
const rolle = (role: string): void => { useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never }); };
const ACTX = { branchId: 'branch-main', userId: 'user-test', now: NOW, role: 'ADMIN' };
/** Alles, was eine abgewiesene oder zurückgerollte Korrektur nicht verändern darf. */
const alles = (db: Db): string => S({
  p: db.exec('SELECT id, quantity, stock_status FROM products ORDER BY id')[0]?.values, adj: db.exec('SELECT * FROM stock_adjustments ORDER BY id')[0]?.values,
  ledger: ledgerCount(db), seq: db.exec("SELECT * FROM document_sequences WHERE doc_type = 'ADJ'")[0]?.values,
  audit: n(db, 'SELECT COUNT(*) FROM audit_log'), log: n(db, 'SELECT COUNT(*) FROM sync_changelog'),
});
/** Ein Artikel über „New Collection" (Altbestand, keine Buchung) — der echte Anlegeweg. */
function neu(db: Db, qty: number, price = 100, name = 'Typo'): string {
  const p = imHaus(() => useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Rolex', name, quantity: qty, purchasePrice: price } as never));
  reload();
  return p.id;
}
async function korr(db: Db, pid: string, newQuantity: number, over: Record<string, unknown> = {}): Promise<{ ok: boolean; code: string; r: Record<string, any> }> {
  try {
    const r = await sa.correctInitialQtyOnPrimary({ actionId: act(), productId: pid, newQuantity, expectedQuantity: qtyOf(db, pid), reason: 'entered wrongly when recorded', ...over } as never, reload);
    return { ok: true, code: '', r: r as never };
  } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message), r: {} }; }
}
function failOn(db: Db, pattern: RegExp, nth = 1): Db {
  let seen = 0;
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (pattern.test(sql) && ++seen === nth) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  setTestDatabase(proxy as never);
  return proxy;
}
function kauf(pid: string, qty: number, unitPrice = 300): void {
  imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', lines: [{ productId: pid, quantity: qty, unitPrice, taxScheme: 'ZERO' as const, vatRate: 0 }],
  } as never));
  reload();
}
function verkauf(pid: string, qty = 1): void {
  imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ productId: pid, quantity: qty, unitPrice: 500, purchasePrice: 0,
    taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 500 * qty }] as never, 'IQ'));
  reload();
}

// ══ A — die Berichtigung: 5 erfasst, 3 da (und zurück auf 4), ohne jede Buchung ═══════════════════════════════════
{
  const db = freshDb();
  const pid = neu(db, 5, 100);
  const l0 = ledgerCount(db);
  const a1 = await korr(db, pid, 3);
  const row = a1.ok ? db.exec('SELECT * FROM stock_adjustments WHERE id = ?', [a1.r.adjustmentId])[0] : null;
  const z = row ? Object.fromEntries(row.columns.map((c, i) => [c, row.values[0][i]])) : {};
  ok(a1.ok && qtyOf(db, pid) === 3 && z.direction === 'CORRECTION' && Number(z.qty_before) === 5 && Number(z.qty_after) === 3 && Number(z.quantity) === 2
    && z.reason_category === 'INITIAL_QTY' && Number(z.value_booked) === 0 && z.status === 'POSTED' && z.created_by === 'user-test'
    && s(db, 'SELECT stock_status FROM products WHERE id = ?', [pid]) === 'in_stock' && a1.r.direction === 'CORRECTION',
    `A1 erste Eingabe 5 → 3 berichtigt: Beleg CORRECTION (vorher 5, nachher 3, Grund, Owner, Zeit), Status bleibt in_stock (${a1.code || a1.r.adjustmentNumber})`);
  ok(ledgerCount(db) === l0 && Math.abs(imbalance(db)) < 0.0005
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account IN ('INVENTORY','INVENTORY_LOSS','CASH','BANK','BENEFIT','VAT_INPUT','VAT_OUTPUT','ACCOUNTS_PAYABLE')") === 0
    && n(db, 'SELECT COUNT(*) FROM purchases') === 0 && n(db, 'SELECT COUNT(*) FROM stock_lots') === 0,
    'A2 keine Buchung (kein Lagerverlust, kein Geld, keine VAT, kein Einkauf), kein Los');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'stock_adjustments' AND entity_id = ? AND action_type = 'CREATE'", [a1.r.adjustmentId]) === 1
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'products' AND entity_id = ? AND field_name = 'quantity' AND old_value = '5'", [pid]) === 1
    && n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'stock_adjustments'") >= 1 && n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'products' AND record_id = ?", [pid]) >= 1,
    'A3 dauerhaftes Protokoll (Beleg + Mengenänderung vorher/nachher, Akteur) und Sync in derselben Transaktion');
  const a2 = await korr(db, pid, 4);
  ok(a2.ok && qtyOf(db, pid) === 4 && ledgerCount(db) === l0, `A4 positive Berichtigung (3 → 4) — eine weitere Eingabekorrektur am unberührten Artikel ist erlaubt (${a2.code})`);
  let storno = '';
  try { imHaus(() => sa.cancelStockAdjustmentInHouse({ adjustmentId: a1.r.adjustmentId, reason: 'x' } as never, ACTX as never)); } catch (e) { storno = String((e as { code?: string }).code); }
  ok(storno === 'CORRECTION_NOT_CANCELLABLE', 'A5 eine Eingabekorrektur wird nicht storniert, nur noch einmal berichtigt');
}

// ══ B — Prüfungen: was abgewiesen wird, schreibt nichts ══════════════════════════════════════════════════════════
{
  const db = freshDb();
  const pid = neu(db, 5);
  const vor = alles(db);
  const fails: Array<[string, number, Record<string, unknown>, string]> = [
    ['gleiche Menge', 5, {}, 'QUANTITY_UNCHANGED'],
    ['null Stück', 0, {}, 'QUANTITY_INVALID'],
    ['halbes Stück', 2.5, {}, 'QUANTITY_INVALID'],
    ['ohne Grund', 3, { reason: '  ' }, 'REASON_REQUIRED'],
    ['veralteter Stand (PC2)', 3, { expectedQuantity: 4 }, 'STOCK_CHANGED'],
    ['ohne Aktionskennung', 3, { actionId: 'x' }, 'ACTION_ID_REQUIRED'],
  ];
  const bad: string[] = [];
  for (const [name, q, over, code] of fails) { const r = await korr(db, pid, q, over); if (r.ok || r.code !== code) bad.push(`${name}: ${r.code || 'ok'}`); }
  rolle('MANAGER');
  const m = await korr(db, pid, 3);
  rolle('ADMIN');
  ok(bad.length === 0 && !m.ok && m.code === 'PERMISSION_DENIED' && alles(db) === vor,
    `B1 Eingaben streng, nur der Owner, veralteter Stand abgewiesen — nichts geschrieben (${bad.join('; ') || 'alle sieben'})`);

  // Vorgeschichte: jede Bewegung, Bindung oder Buchung sperrt (fail-closed)
  const fall = async (name: string, setup: (pid: string) => void | Promise<void>, code: RegExp, qty = 5): Promise<string> => {
    const p = neu(db, qty, 100, name);
    await setup(p);
    reload();
    const vorF = alles(db);
    const q = qtyOf(db, p);
    const r = await korr(db, p, q + 1);
    return !r.ok && code.test(r.code) && alles(db) === vorF ? '' : `${name}: ${r.code || 'ok'}`;
  };
  const fehler: string[] = [];
  fehler.push(await fall('verkauft', (p) => verkauf(p, 1), /HAS_HISTORY/));
  fehler.push(await fall('eingekauft', (p) => kauf(p, 2), /BLOCKED_HAS_LOTS|HAS_HISTORY/));
  fehler.push(await fall('Angebot', (p) => insert(db, 'offer_lines', { id: 'ol-' + p, offer_id: 'of-1', product_id: p, created_at: NOW }), /HAS_HISTORY/));
  fehler.push(await fall('Altbestand dazu', async (p) => { await sa.addOldStockOnPrimary({ actionId: act(), productId: p, quantity: 1, expectedQuantity: 5, unitCost: 100, reason: 'found' } as never, reload); }, /HAS_HISTORY/));
  fehler.push(await fall('Abgang storniert', async (p) => {
    const r = await sa.issueStockOnPrimary({ actionId: act(), productId: p, quantity: 1, expectedQuantity: 5, reasonCategory: 'LOST', reason: 'x' } as never, reload);
    await sa.cancelStockAdjustmentOnPrimary({ adjustmentId: r.adjustmentId, reason: 'found again' } as never, reload);
  }, /HAS_HISTORY/));
  fehler.push(await fall('Agent (zurück)', (p) => insert(db, 'agent_transfers', { id: 'at-' + p, branch_id: 'branch-main', product_id: p, agent_id: 'ag-1', status: 'returned', created_at: NOW }), /HAS_HISTORY/));
  fehler.push(await fall('Reparatur (abgeholt)', (p) => insert(db, 'repairs', { id: 'rp-' + p, branch_id: 'branch-main', product_id: p, status: 'picked_up', created_at: NOW }), /HAS_HISTORY/));
  fehler.push(await fall('reserviert', (p) => { db.run("UPDATE products SET stock_status = 'reserved' WHERE id = ?", [p]); }, /EXCLUDED_NOT_IN_STOCK/));
  fehler.push(await fall('Kommission', (p) => { db.run("UPDATE products SET source_type = 'CONSIGNMENT' WHERE id = ?", [p]); }, /EXCLUDED_NOT_OWN/));
  fehler.push(await fall('früher frei bearbeitet / zusammengeführt', (p) => insert(db, 'audit_log', { id: 'au-' + p, branch_id: 'branch-main', module: 'Product', entity_type: 'products', entity_id: p, action_type: 'UPDATE', field_name: 'quantity', old_value: '2', new_value: '5', changed_at: NOW }), /HAS_HISTORY/));
  const rest = fehler.filter(Boolean);
  ok(rest.length === 0, `B2 Vorgeschichte sperrt: Verkauf, Einkauf/Los, Angebot, Altbestand, stornierter Abgang, Agent, Reparatur, Reservierung, Kommission, protokollierte Mengenänderung — nichts geschrieben (${rest.join('; ') || 'alle zehn'})`);
  // Ein Hauptbuch mit Lagerbuchung unbekannter Herkunft sperrt jeden Artikel ohne Los (dieselbe Herkunftsregel wie Abgang/Altbestand).
  const p2 = neu(db, 5, 100, 'Ledger');
  insert(db, 'ledger_entries', { id: 'le-x', branch_id: 'branch-main', transaction_id: 'tx-x', account: 'INVENTORY', direction: 'DEBIT', amount: 10, source_module: 'MANUAL', source_id: 'x', occurred_at: NOW, created_at: NOW });
  const vl = await korr(db, p2, 3);
  db.run("DELETE FROM ledger_entries WHERE id = 'le-x'");
  ok(!vl.ok && vl.code === 'VALUE_NOT_PROVEN', `B3 unklare Lagerbuchung im Hauptbuch → fail-closed (${vl.code})`);
}

// ══ C — Wiederholung, PC2, Rollback ═══════════════════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const pid = neu(db, 5);
  const body = { actionId: 'iq-fixed-action-1', productId: pid, newQuantity: 3, expectedQuantity: 5, reason: 'typo' };
  const r1 = await sa.correctInitialQtyOnPrimary(body as never, reload);
  const nach = alles(db);
  const r2 = await sa.correctInitialQtyOnPrimary(body as never, reload);
  let konflikt = '';
  try { await sa.correctInitialQtyOnPrimary({ ...body, reason: 'other' } as never, reload); } catch (e) { konflikt = String((e as { code?: string }).code); }
  ok(r1.adjustmentId === r2.adjustmentId && alles(db) === nach && konflikt === 'ACTION_ID_CONFLICT' && qtyOf(db, pid) === 3,
    'C1 dieselbe Aktion zweimal: derselbe Beleg, keine zweite Änderung; dieselbe Kennung mit anderem Inhalt: abgewiesen');

  const p2 = neu(db, 5, 100, 'PC2');
  const XID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000aa`;
  const ident = (x: string, op: string, hash = 'h' + x) => ({ commandId: XID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', op, payloadHash: hash });
  const dps = { db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW };
  const pb = { actionId: 'pc2-iq-action-1', productId: p2, newQuantity: 2, expectedQuantity: 5, reason: 'PC2 typo' };
  const vorM = alles(db);
  const m = await cmdS.runStockAction(sa.correctInitialQtyInHouse as never, cmdS.INITIAL_QTY_KEYS, dps, ident('1', 'stock_adjustments.correct_initial'), 'MANAGER', pb);
  ok(m.kind === 'rejected' && (m as { code: string }).code === 'PERMISSION_DENIED' && (m as { frozen: boolean }).frozen && alles(db) === vorM, 'C2 PC2 als Manager: abgewiesen, eingefroren, nichts geschrieben');
  const o1 = await cmdS.runStockAction(sa.correctInitialQtyInHouse as never, cmdS.INITIAL_QTY_KEYS, dps, ident('2', 'stock_adjustments.correct_initial'), 'ADMIN', pb);
  reload();
  const nachO = alles(db);
  const o2 = await cmdS.runStockAction(sa.correctInitialQtyInHouse as never, cmdS.INITIAL_QTY_KEYS, dps, ident('2', 'stock_adjustments.correct_initial'), 'ADMIN', pb);
  const stale = await cmdS.runStockAction(sa.correctInitialQtyInHouse as never, cmdS.INITIAL_QTY_KEYS, dps, ident('3', 'stock_adjustments.correct_initial'), 'ADMIN',
    { ...pb, actionId: 'pc2-iq-action-2', newQuantity: 4, expectedQuantity: 5 });
  ok(o1.kind === 'ok' && (o2 as { replayed?: boolean }).replayed === true && alles(db) === nachO && qtyOf(db, p2) === 2
    && stale.kind === 'rejected' && (stale as { code: string }).code === 'STOCK_CHANGED' && n(db, "SELECT COUNT(*) FROM stock_adjustments WHERE created_by = 'user-pc2'") === 1,
    'C3 PC2 als Owner: berichtigt (5 → 2); Wiederholung derselben Kennung ändert nichts; ein Fenster mit veraltetem Stand (sah 5) wird abgewiesen');
  let feld = '';
  try { await cmdS.runStockAction(sa.correctInitialQtyInHouse as never, cmdS.INITIAL_QTY_KEYS, dps, ident('4', 'stock_adjustments.correct_initial'), 'ADMIN', { ...pb, actionId: 'pc2-iq-action-3', qtyAfter: 9 }); }
  catch (e) { feld = (e as Error).message; }
  ok(/unknown field: qtyAfter/.test(feld), 'C4 der Rumpf ist streng (Menge vorher/nachher, Beleg und Buchungslage bestimmt der Primary)');

  const p3 = neu(db, 5, 100, 'Rollback');
  const vorR = alles(db);
  const bad = failOn(db, /INSERT INTO audit_log/);
  let rb = '';
  try { await sa.correctInitialQtyOnPrimary({ actionId: act(), productId: p3, newQuantity: 3, expectedQuantity: 5, reason: 'typo' } as never, reload); } catch (e) { rb = (e as Error).message; }
  setTestDatabase(db as never);
  reload();
  ok(/INJECTED/.test(rb) && alles(db) === vorR && qtyOf(db, p3) === 5, 'C5 scheitert das Protokoll, bleibt alles wie vorher (Menge, Beleg, Nummer, Sync) — Rollback');
}

// ══ D — bestehende Wege unverändert, Artikelmaske ändert die Menge nie, Eröffnungsvorschau ═══════════════════════
{
  const db = freshDb();
  const pid = neu(db, 5, 100);
  const vorher = osr.oldStockRowsFor({ branchId: 'branch-main' }, pid)[0];
  await korr(db, pid, 3);
  const nachher = osr.oldStockRowsFor({ branchId: 'branch-main' }, pid)[0];
  const alle = osr.oldStockRowsFor({ branchId: 'branch-main' });
  ok(vorher.klass === 'OPENING_CANDIDATE' && vorher.shelfQty === 5 && eq(vorher.shelfValue, 500)
    && nachher.klass === 'OPENING_CANDIDATE' && nachher.shelfQty === 3 && eq(nachher.shelfValue, 300) && S(nachher.costLayers) === S([{ qty: 3, unitCost: 100, source: 'ITEM' }])
    && nachher.oldStockReceipts === 0 && nachher.pendingRemovalQty === 0 && alle.filter((r) => r.productId === pid).length === 1,
    `D1 Eröffnungsvorschau rechnet mit der berichtigten Menge: 5 × 100 = 500 → 3 × 100 = 300, ein Wertblock, kein Zugang, kein Abgang, keine Doppelerfassung (${nachher.shelfValue})`);
  const add = await sa.addOldStockOnPrimary({ actionId: act(), productId: pid, quantity: 2, expectedQuantity: 3, unitCost: 100, reason: 'found later' } as never, reload);
  const rem = await sa.issueStockOnPrimary({ actionId: act(), productId: pid, quantity: 1, expectedQuantity: 5, reasonCategory: 'LOST', reason: 'lost' } as never, reload);
  const danach = await korr(db, pid, 7);
  ok(add.qtyAfter === 5 && rem.qtyAfter === 4 && qtyOf(db, pid) === 4 && !danach.ok && danach.code === 'HAS_HISTORY',
    'D2 „Add old stock" und „Remove from stock" arbeiten unverändert nach einer Berichtigung; danach ist die erste Eingabe keine mehr (Berichtigung gesperrt)');
  ok(/accounting reconciliation pending|opening pending/.test(src('src/components/products/StockAdjustmentPanel.tsx')) && /data-initial-qty-open/.test(src('src/components/products/StockAdjustmentPanel.tsx'))
    && /d\.status === 'POSTED' && d\.direction !== 'CORRECTION' && <Button/.test(src('src/components/products/StockAdjustmentPanel.tsx')),
    'D3 die Karte „Stock corrections" hat „Correct initial qty"; eine Berichtigung zeigt keinen Storno-Knopf');
  const cur = db.exec('SELECT * FROM products WHERE id = ?', [pid])[0];
  const curRow = Object.fromEntries(cur.columns.map((c, i) => [c, cur.values[0][i]]));
  const unberuehrt = neu(db, 5, 100, 'Edit');
  const vorE = alles(db);
  const ed = await useProductStore.getState().editProductTextDurably(unberuehrt, { quantity: 3 } as never) as { status: string; errorCode?: string };
  reload();
  ok(ed.errorCode === 'PRODUCT_LIFECYCLE_LOCKED' && alles(db) === vorE && qtyOf(db, unberuehrt) === 5,
    `D4a auch an einem unberührten Artikel ändert das normale Speichern die Menge nicht (${ed.status}/${ed.errorCode ?? ''}) — dafür gibt es nur „Correct initial qty"`);
  ok(lifecycleEditRefusal(curRow, { quantity: 9 }) !== null && lifecycleEditRefusal(curRow, { quantity: 4, name: 'x' }) === null
    && /const \{ quantity: _menge, stockStatus: _status, sourceType: _herkunft, \.\.\.stammdaten \} = form;/.test(src('src/pages/watches/ProductDetail.tsx'))
    && /data-initial-qty-hint/.test(src('src/pages/watches/ProductDetail.tsx')),
    'D4 das normale Speichern ändert die Menge nie (die Maske schickt sie nicht, das Haus weist eine Änderung ab); Edit weist den Owner auf die Berichtigung hin');
  ok(Math.abs(imbalance(db)) < 0.0005, 'D5 Hauptbuch ausgeglichen');
}

// ══ E — Schema, Namen ═══════════════════════════════════════════════════════════════════════════════════════════
{
  const alt = new SQL.Database() as unknown as Db;
  const ddl = MIGRATIONS.find((m) => m.includes('CREATE TABLE IF NOT EXISTS stock_adjustments'))!.replace(schema.DIRECTION_CHECK, schema.RECEIPT_DIRECTION_CHECK);
  alt.run(ddl);
  for (const ix of schema.STOCK_ADJUSTMENT_INDEXES) alt.run(ix);
  const ins = (id: string, dir: string, action: string): string => {
    try { alt.run(`INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after, accounting, reason_category, reason, business_date, action_id, payload_hash, created_at)
      VALUES (?, 'branch-main', ?, 'p', ?, 1, 2, 1, 'ACCOUNTING_RECONCILIATION_PENDING', 'X', 'r', '2026-10-01', ?, 'h', ?)`, [id, 'ADJ-' + id, dir, action, NOW]); return ''; }
    catch (e) { return (e as Error).message; }
  };
  ins('x1', 'RECEIPT', 'a1');
  const vorher = ins('x2', 'CORRECTION', 'a2');
  const zeile = S(alt.exec("SELECT * FROM stock_adjustments WHERE id = 'x1'")[0]?.values);
  const umgebaut = schema.widenStockAdjustmentDirections(alt as never);
  const nachher = ins('x3', 'CORRECTION', 'a3');
  ok(/CHECK/.test(vorher) && umgebaut && nachher === '' && S(alt.exec("SELECT * FROM stock_adjustments WHERE id = 'x1'")[0]?.values) === zeile
    && schema.widenStockAdjustmentDirections(alt as never) === false && /UNIQUE/.test(ins('x4', 'CORRECTION', 'a3')),
    'E1 vorhandene Tabelle (ISSUE/RECEIPT) wird einmal umgebaut: alte Zeilen unverändert, CORRECTION erlaubt, eindeutige Aktion bleibt, zweiter Lauf tut nichts');
  const live = freshDb();
  ok(/'ISSUE','RECEIPT','CORRECTION'/.test(s(live, "SELECT sql FROM sqlite_master WHERE name = 'stock_adjustments'")), 'E2 neue Datenbanken bekommen die Regel direkt');

  // E2b — eine vollständige Datenbank mit der Regel VOR dieser Änderung (Phase 2/3: ISSUE/RECEIPT) und echten Belegen.
  const iM = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE IF NOT EXISTS stock_adjustments'));
  const origM = MIGRATIONS[iM];
  MIGRATIONS[iM] = origM.replace(schema.DIRECTION_CHECK, schema.RECEIPT_DIRECTION_CHECK);
  const voll = freshDb();
  MIGRATIONS[iM] = origM;
  const pr = neu(voll, 2, 100, 'Widen receipt');
  await sa.addOldStockOnPrimary({ actionId: act(), productId: pr, quantity: 1, expectedQuantity: 2, unitCost: 100, reason: 'found' } as never, reload);
  const pi = neu(voll, 4, 100, 'Widen issue');
  await sa.issueStockOnPrimary({ actionId: act(), productId: pi, quantity: 1, expectedQuantity: 4, reasonCategory: 'LOST', reason: 'lost' } as never, reload);
  const pk = neu(voll, 5, 100, 'Widen correction');
  const bild = (db: Db): string => S({
    rows: db.exec('SELECT * FROM stock_adjustments ORDER BY id')[0]?.values,
    cols: db.exec('PRAGMA table_info(stock_adjustments)')[0]?.values,
    idx: db.exec("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stock_adjustments' ORDER BY name")[0]?.values,
    fk: db.exec('PRAGMA foreign_key_list(stock_adjustments)')[0]?.values ?? [],
    trig: n(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'stock_adjustments'"),
    refs: n(db, "SELECT COUNT(*) FROM sqlite_master WHERE sql LIKE '%REFERENCES stock_adjustments%'"),
    log: n(db, 'SELECT COUNT(*) FROM sync_changelog'), audit: n(db, 'SELECT COUNT(*) FROM audit_log'),
    p: db.exec('SELECT id, quantity, stock_status FROM products ORDER BY id')[0]?.values,
  });
  const vorAlt = alles(voll);
  const zuFrueh = await korr(voll, pk, 3);
  ok(!zuFrueh.ok && /CHECK/.test(zuFrueh.code) && alles(voll) === vorAlt && qtyOf(voll, pk) === 5,
    `E2b vor dem Umbau scheitert eine Berichtigung an der alten Regel vollständig (Rollback: Menge, Beleg, Nummer, Protokoll, Sync) (${zuFrueh.code.slice(0, 40)})`);
  const vorU = bild(voll);
  const idxVor = n(voll, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stock_adjustments'");
  const umgebautV = schema.widenStockAdjustmentDirections(voll as never);
  const regel = (spalte: string, wert: unknown): string => {
    try {
      voll.run(`INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after, accounting, reason_category, reason, business_date, status, action_id, payload_hash, created_at)
        VALUES ('bad', 'branch-main', 'ADJ-bad', 'p', 'ISSUE', 1, 2, 1, 'BOOKED', 'X', 'r', '2026-10-01', 'POSTED', 'bad-action', 'h', ?)`, [NOW]);
      voll.run(`UPDATE stock_adjustments SET ${spalte} = ? WHERE id = 'bad'`, [wert]);
      voll.run("DELETE FROM stock_adjustments WHERE id = 'bad'");
      return '';
    } catch (e) { voll.run("DELETE FROM stock_adjustments WHERE id = 'bad'"); return (e as Error).message; }
  };
  const regeln = [regel('quantity', 0), regel('accounting', 'X'), regel('status', 'X'), regel('direction', 'X'), regel('reason', null)];
  ok(umgebautV && bild(voll) === vorU && idxVor === 4 && n(voll, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'stock_adjustments_widen'") === 0
    && regeln.every((m) => /CHECK|NOT NULL/.test(m)) && schema.widenStockAdjustmentDirections(voll as never) === false,
    `E2c Umbau einer echten Datenbank: Belege (Abgang, Altbestand) Feld für Feld gleich, dieselben Spalten, alle Indizes (eindeutige Aktion, eindeutige Nummer, Artikel, Primärschlüssel), keine Fremdschlüssel/Trigger/Verweise vorher wie nachher, kein neuer Sync- oder Protokolleintrag (kein Echo), alle übrigen Regeln (Menge > 0, Buchungslage, Status, Richtung, Pflichtfelder) greifen weiter, zweiter Lauf tut nichts (${regeln.map((m) => m.slice(0, 18)).join(' | ')})`);
  const nachU = await korr(voll, pk, 3);
  ok(nachU.ok && qtyOf(voll, pk) === 3 && n(voll, "SELECT COUNT(*) FROM stock_adjustments WHERE direction = 'CORRECTION'") === 1, `E2d nach dem Umbau ist die Berichtigung möglich (${nachU.code})`);
  const rs = src('src-tauri/src/bridge.rs');
  ok(registry.ALLOWED_MUTATIONS.at(-1) === 'stock_adjustments.correct_initial' && perms.permissionForOp('stock_adjustments.correct_initial')?.kind === 'isOwner'
    && perms.roleMayRunOp('ADMIN', 'stock_adjustments.correct_initial') && !perms.roleMayRunOp('MANAGER', 'stock_adjustments.correct_initial')
    && registry.knownCommands().includes('stock_adjustments.correct_initial')
    && /pub const OP_STOCK_CORRECT_INITIAL: &str = "stock_adjustments\.correct_initial";/.test(rs) && /OP_PAGE_OPENING_BALANCES_GET,\s*\/\/[^\n]*\n\s*OP_STOCK_CORRECT_INITIAL,\s*\];/.test(rs),
    'E3 der Fernbefehl ist freigegeben (am Ende der Liste), nur für den Owner, angemeldet und in Rust bekannt');
  const sync = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_fields: string[] }> };
  ok(['direction', 'qty_before', 'qty_after', 'reason', 'created_by'].every((f) => sync.tables.stock_adjustments.allowed_fields.includes(f)),
    'E4 der Beleg reist mit dem vorhandenen Sync-Vertrag von stock_adjustments (keine neue Tabelle, keine neue Spalte)');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — initial qty correction: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
