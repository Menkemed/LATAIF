// ════════════════════════════════════════════════════════════════════════════
// LOT-VAT-COST — der Einstand eines Loses ist GENAU das, was auf INVENTORY aktiviert wurde.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores,
// echte Hausfolgen, echtes Hauptbuch — wie stock-lot-integrity.
// Run: node --experimental-strip-types test/lot-vat-cost/lot-vat-cost.test.ts
//
//   1 ZERO unverändert (Einstand = Stückpreis)
//   2 VAT_10 Menge 1: Los 100 / INVENTORY 100 / VAT_INPUT 10 / A/P 110; Verkauf COGS 100;
//     Retoure (IN_STOCK) und Retoure-Storno
//   3 VAT_10 Menge 3: Teilverkauf, vollständiger Verkauf — kein negativer INVENTORY-Rest
//   4 Rücksendung an den Lieferanten   5 Einkaufsstorno
//   6 Production mit VAT_10-Eingang (Los-Wert) und Eingang ohne Los (Einkaufspreis)
//   7 Rundung: 7 × 10 brutto (netto 63,636 ÷ 7) — der Rest wird gezeigt, nicht kaschiert
//   8 Margensteuer liest den Netto-Einstand   9 Quelltext: eine Regel, ein Schreibweg
// Invariante überall: Σ Restmenge × Einstand aller Lose == Saldo INVENTORY.
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

// ══ 1 — ZERO unverändert ═════════════════════════════════════════════════════
{
  const db = neu();
  product(db, 'pZ', 500); reload();
  const pid = kauf('pZ', 2, 500.125, false);
  const lot = lotOf(db, pid);
  ok(unitCost(db, lot) === 500.125, `1 ZERO: Einstand = Stückpreis 500.125, unverändert (${unitCost(db, lot)})`);
  ok(purchaseLeg(db, pid, 'INVENTORY', 'DEBIT') === 1000.25 && purchaseLeg(db, pid, 'VAT_INPUT', 'DEBIT') === 0,
    `1 …INVENTORY 1000.25, keine Vorsteuer (${purchaseLeg(db, pid, 'INVENTORY', 'DEBIT')})`);
  invariant(db, '1 nach Einkauf');
  const inv = rechnung([LINE('pZ', 1)]);
  ok(cogsOf(db, inv) === 500.125, `1 …COGS 500.125 (${cogsOf(db, inv)})`);
  invariant(db, '1 nach Teilverkauf');
}

// ══ 2 — VAT_10 Menge 1: 110 brutto = 100 netto + 10 Vorsteuer ═════════════════
{
  const db = neu();
  product(db, 'p1', 110); reload();
  const pid = kauf('p1', 1, 110, true);
  const lot = lotOf(db, pid);
  ok(eq(unitCost(db, lot), 100), `2 Los-Einstand 100 (netto), nicht 110 (${unitCost(db, lot)})`);
  ok(purchaseLeg(db, pid, 'INVENTORY', 'DEBIT') === 100, `2 INVENTORY Soll 100 (${purchaseLeg(db, pid, 'INVENTORY', 'DEBIT')})`);
  ok(purchaseLeg(db, pid, 'VAT_INPUT', 'DEBIT') === 10, `2 VAT_INPUT Soll 10 (${purchaseLeg(db, pid, 'VAT_INPUT', 'DEBIT')})`);
  ok(purchaseLeg(db, pid, 'ACCOUNTS_PAYABLE', 'CREDIT') === 110, `2 Lieferant Haben 110 (${purchaseLeg(db, pid, 'ACCOUNTS_PAYABLE', 'CREDIT')})`);
  ok(n(db, "SELECT purchase_price FROM products WHERE id = 'p1'") === 110, '2 …products.purchase_price bleibt 110 (Anzeige, unberührt)');
  invariant(db, '2 nach Einkauf');

  const inv = rechnung([LINE('p1', 1)]);
  ok(eq(n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [inv]), 100), '2 Verkauf: Einstand-Schnappschuss 100');
  ok(cogsOf(db, inv) === 100, `2 …COGS 100, INVENTORY Haben 100 (${cogsOf(db, inv)})`);
  ok(inventory(db) === 0 && lotRem(db, lot) === 0, `2 …vollständig verbraucht: INVENTORY 0.000, Los 0 (${inventory(db)})`);
  invariant(db, '2 nach Verkauf');

  voll(db, inv);
  const rid = retoure(db, inv, 'p1');
  ok(lotRem(db, lot) === 1, `2 Retoure IN_STOCK: Los 0→1 (${lotRem(db, lot)})`);
  ok(inventory(db) === 100, `2 …COGS-Rückbuchung 100: INVENTORY 100 (${inventory(db)})`);
  invariant(db, '2 nach Retoure');

  const c = meldung(() => imHaus(() => cancelReturnHouse.cancelReturnInHouse(rid, 'Storno', OWNER_ACTOR, 'branch-main')));
  reload();
  ok(c === '' && lotRem(db, lot) === 0, `2 Retoure-Storno läuft: Los 1→0 (${c} ${lotRem(db, lot)})`);
  ok(inventory(db) === 0, `2 …COGS wieder gebucht: INVENTORY 0 (${inventory(db)})`);
  invariant(db, '2 nach Retoure-Storno');
}

// ══ 3 — VAT_10 Menge 3: Teil- und vollständiger Verkauf ═══════════════════════
{
  const db = neu();
  product(db, 'p3', 110); reload();
  const pid = kauf('p3', 3, 110, true);
  const lot = lotOf(db, pid);
  ok(eq(unitCost(db, lot), 100) && purchaseLeg(db, pid, 'INVENTORY', 'DEBIT') === 300 && purchaseLeg(db, pid, 'VAT_INPUT', 'DEBIT') === 30,
    `3 Einkauf 3 × 110: Los 3 × 100, INVENTORY 300, VAT_INPUT 30 (${unitCost(db, lot)})`);
  invariant(db, '3 nach Einkauf');
  const a = rechnung([LINE('p3', 1)]);
  ok(cogsOf(db, a) === 100 && inventory(db) === 200 && lotRem(db, lot) === 2, `3 Teilverkauf 1: COGS 100, INVENTORY 200, Los 2 (${inventory(db)})`);
  invariant(db, '3 nach Teilverkauf');
  const b = rechnung([LINE('p3', 2)]);
  ok(cogsOf(db, b) === 200 && lotRem(db, lot) === 0, `3 Rest 2: COGS 200, Los 0 (${cogsOf(db, b)})`);
  ok(inventory(db) === 0, `3 …kein Vorsteuer-Minus mehr: INVENTORY 0.000 (vorher −30) (${inventory(db)})`);
  invariant(db, '3 nach vollständigem Verkauf');
}

// ══ 4 — Rücksendung an den Lieferanten ═════════════════════════════════════════
{
  const db = neu();
  product(db, 'p4', 110); reload();
  const pid = kauf('p4', 3, 110, true);
  const lot = lotOf(db, pid);
  const plId = s(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ?', [pid]);
  const r = meldung(() => imHaus(() => life.returnToSupplierInHouse(
    { purchaseId: pid, refundMethod: 'bank', lines: [{ purchaseLineId: plId, quantity: 1, unitPrice: 110 }] } as never, CTX)));
  reload();
  ok(r === '' && lotRem(db, lot) === 2, `4 Rücksendung 1 von 3 läuft: Los 3→2 (${r} ${lotRem(db, lot)})`);
  ok(inventory(db) === 200, `4 …INVENTORY netto zurück: 300→200 (${inventory(db)})`);
  ok(r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='VAT_INPUT'")) === 20,
    '4 …VAT_INPUT anteilig zurück: 30→20');
  invariant(db, '4 nach Rücksendung');
  const inv = rechnung([LINE('p4', 2)]);
  ok(cogsOf(db, inv) === 200 && inventory(db) === 0, `4 Rest verkauft: COGS 200, INVENTORY 0 (${inventory(db)})`);
  invariant(db, '4 nach Verkauf');
}

// ══ 5 — Einkaufsstorno ═════════════════════════════════════════════════════════
{
  const db = neu();
  product(db, 'p5', 110); reload();
  const pid = kauf('p5', 2, 110, true);
  invariant(db, '5 nach Einkauf');
  const c = meldung(() => imHaus(() => life.cancelPurchaseInHouse(pid, 'branch-main')));
  reload();
  ok(c === '' && s(db, 'SELECT status FROM stock_lots WHERE purchase_id = ?', [pid]) === 'CANCELLED', `5 Storno läuft, Los CANCELLED (${c})`);
  ok(inventory(db) === 0 && lotsValue(db) === 0, `5 …INVENTORY 0, Restwert 0 (${inventory(db)})`);
}

// ══ 6 — Production ═════════════════════════════════════════════════════════════
{
  const db = neu();
  product(db, 'pIn', 110); product(db, 'pLess', 50, 1); reload();
  useProductStore.getState().loadCategories();
  kauf('pIn', 1, 110, true);
  ok(n(db, "SELECT purchase_price FROM products WHERE id = 'pIn'") === 110, '6 SETUP Eingang: purchase_price 110 (brutto), Los 100');
  const OUT = (value: number) => ({ spec: { categoryId: 'cat-w', brand: 'Custom', name: 'Ring', condition: 'New', taxScheme: 'MARGIN', attributes: {}, images: [] }, value });

  // Brutto (110 + 50) passt NICHT mehr: der Eingang ist 100 wert, nicht 110.
  const vorLots = S(db.exec('SELECT * FROM stock_lots ORDER BY id')[0]?.values);
  const m = await meldungAsync(() => imHausAsync(() => createProductionInHouse(
    { inputProductIds: ['pIn', 'pLess'], outputs: [OUT(160)] as never }, { branchId: 'branch-main', userId: 'user-test' })));
  ok(/PRODUCTION_VALUE_MISMATCH/.test(m) && /Input 150\.00/.test(m), `6 NEG Ausgang 160 (brutto): abgewiesen, Input 150 (${m.slice(0, 70)})`);
  ok(S(db.exec('SELECT * FROM stock_lots ORDER BY id')[0]?.values) === vorLots, '6 …nichts verbraucht');

  invariant(db, '6 vor Production');
  const made = await imHausAsync(() => createProductionInHouse(
    { inputProductIds: ['pIn', 'pLess'], outputs: [OUT(150)] as never }, { branchId: 'branch-main', userId: 'user-test' }));
  const inVal = (pid: string): number => n(db, 'SELECT input_value FROM production_inputs WHERE record_id = ? AND product_id = ?', [made.recordId, pid]);
  ok(inVal('pIn') === 100, `6 Eingang mit Los: input_value 100 = Los-Wert (${inVal('pIn')})`);
  ok(inVal('pLess') === 50, `6 Eingang ohne Los: input_value 50 = Einkaufspreis (Rückfall) (${inVal('pLess')})`);
  ok(n(db, 'SELECT total_value FROM production_records WHERE id = ?', [made.recordId]) === 150, '6 …Gesamtwert 150');
  const outLot = s(db, 'SELECT id FROM stock_lots WHERE product_id = ?', [made.outputProductIds[0]]);
  ok(unitCost(db, outLot) === 150, `6 …Ausgangslos 150 (${unitCost(db, outLot)})`);
  // Das Los des Eingangs (100) geht an den Ausgang; der Artikel ohne Los hatte nie eine INVENTORY-Buchung.
  ok(inventory(db) === 100 && lotsValue(db) === 150, `6 …INVENTORY 100, Lose 150 (+50 aus dem Artikel ohne Los, wie bisher) (${inventory(db)}/${lotsValue(db)})`);
}
{
  const db = neu();
  product(db, 'pOnly', 110); reload();
  useProductStore.getState().loadCategories();
  kauf('pOnly', 1, 110, true);
  const made = await imHausAsync(() => createProductionInHouse(
    { inputProductIds: ['pOnly'], outputs: [{ spec: { categoryId: 'cat-w', brand: 'C', name: 'R', condition: 'New', taxScheme: 'MARGIN', attributes: {}, images: [] }, value: 100 }] as never },
    { branchId: 'branch-main', userId: 'user-test' }));
  ok(made.totalValue === 100, `6 nur Los-Eingang: Wert 100 (${made.totalValue})`);
  invariant(db, '6 nach Production (nur Los-Eingang)');
  const inv = rechnung([LINE(made.outputProductIds[0], 1)]);
  ok(cogsOf(db, inv) === 100 && inventory(db) === 0, `6 Ausgang verkauft: COGS 100, INVENTORY 0 (${inventory(db)})`);
}

// ══ 7 — Rundung: 7 × 10 brutto ═════════════════════════════════════════════════
{
  const db = neu();
  product(db, 'p7', 10); product(db, 'p7b', 10); reload();
  const pid = kauf('p7', 7, 10, true);
  const lot = lotOf(db, pid);
  const net = purchaseLeg(db, pid, 'INVENTORY', 'DEBIT');
  ok(net === 63.636 && purchaseLeg(db, pid, 'VAT_INPUT', 'DEBIT') === 6.364, `7 Einkauf 70 brutto: INVENTORY 63.636, VAT_INPUT 6.364 (${net})`);
  ok(eq(unitCost(db, lot) * 7, 63.636), `7 …Los 7 × ${unitCost(db, lot)} = 63.636 (ungerundet geteilt)`);
  invariant(db, '7 nach Einkauf');
  // Einzeln verkauft: jede Zeile bucht ROUND(9.0908…) = 9.091 → zusammen 63.637.
  for (let i = 0; i < 7; i++) rechnung([LINE('p7', 1)]);
  const rest = inventory(db);
  ok(lotRem(db, lot) === 0, '7 7 Einzelverkäufe: Los 0');
  ok(rest === -0.001, `7 BEKANNTER RUNDUNGSREST: INVENTORY ${rest} (sichtbar, nicht kaschiert; ≤ 0.0005 je Stück)`);
  // Dieselbe Menge in EINER Zeile: kein Rest.
  const pid2 = kauf('p7b', 7, 10, true);
  const before = inventory(db);
  const inv = rechnung([LINE('p7b', 7)]);
  ok(cogsOf(db, inv) === 63.636 && r3(inventory(db) - before) === -63.636, `7 7 in einer Zeile: COGS 63.636, kein Rest (${cogsOf(db, inv)})`);
  ok(lotRem(db, lotOf(db, pid2)) === 0, '7 …Los 0');
}

// ══ 8 — Margensteuer liest den Netto-Einstand ═══════════════════════════════════
{
  const db = neu();
  product(db, 'p8', 110); reload();
  kauf('p8', 1, 110, true);
  const inv = rechnung([LINE('p8', 1, 200, 'MARGIN')]);
  ok(eq(n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [inv]), 100),
    '8 MARGIN-Verkauf eines 10 %-Einkaufs: Einstand 100 (Margensteuer auf 200 − 100, bewusste Folge)');
  ok(cogsOf(db, inv) === 100 && inventory(db) === 0, `8 …COGS 100, INVENTORY 0 (${inventory(db)})`);
}

// ══ 9 — Quelltext: eine Regel, ein Schreibweg ═══════════════════════════════════
{
  ok(capitalizedLineCost(110, 10) === 100 && capitalizedLineCost(70, 70 * 10 / 110) === 63.636, '9 capitalizedLineCost: 110/10 → 100, 70/6.3636 → 63.636');
  ok(purchaseLotUnitCost({ qty: 3, unitPrice: 110, lineTotal: 330, vatAmount: 30 }) === 100, '9 purchaseLotUnitCost VAT_10 → netto je Stück');
  ok(purchaseLotUnitCost({ qty: 2, unitPrice: 500.125, lineTotal: 1000.25, vatAmount: 0 }) === 500.125, '9 purchaseLotUnitCost ZERO → Stückpreis unverändert');
  ok(inventoryCostBasis(110, 100) === 100 && inventoryCostBasis(50, undefined) === 50 && inventoryCostBasis(50, 0) === 0, '9 inventoryCostBasis: Los-Wert, sonst Einkaufspreis');

  const post = src('src/core/ledger/posting.ts');
  const body = post.slice(post.indexOf('export function postPurchaseReceived('), post.indexOf('export function getPurchaseLineInputSplit('));
  ok(/const net = capitalizedLineCost\(line\.lineTotal, line\.vatAmount\)/.test(body), '9 postPurchaseReceived bucht INVENTORY über capitalizedLineCost');
  ok(/purchaseLotUnitCost\(l\)/.test(src('src/stores/purchaseStore.ts')), '9 createPurchase legt das Los mit purchaseLotUnitCost an');
  const ph = src('src/core/production/production-house.ts');
  ok(/inventoryCostBasis\(purchasePrice, getStockAggregates\(\[id\]\)\.get\(id\)\?\.totalValue\)/.test(ph)
    && /fils\(p\.costBasis\)/.test(ph) && !/fils\(p\.purchasePrice\)/.test(ph), '9 Production: Prüfung und input_value über die Kostenbasis');
  const pp = src('src/pages/production/ProductionPage.tsx');
  ok(/useSharedRead\('inventory\.lot_aggregates\.get'/.test(pp) && /inventoryCostBasis\(p\.purchasePrice, lotAgg\.get\(p\.id\)\?\.totalValue\)/.test(pp)
    && !/\+ p\.purchasePrice/.test(pp), '9 Production-Maske: dieselbe Basis, auf PC2 über dieselbe Fernauskunft');
  // Lose entstehen nur an den bekannten Stellen — kein zweiter Einkaufsweg mit eigener Kostenregel.
  const writers: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f) && /INSERT INTO stock_lots/.test(readFileSync(p, 'utf8'))) writers.push(p.slice(repo.length + 1).replace(/\\/g, '/'));
    }
  };
  walk(resolvePath(repo, 'src'));
  // BULK METAL V1 — das Bulk-Lot des Einkaufs legt bulk-lot-house an (Wert = aktiviertes INVENTORY-Soll).
  ok(S(writers.sort()) === S(['src/core/bulk/bulk-lot-house.ts', 'src/core/db/database.ts', 'src/core/production/production-house.ts', 'src/stores/purchaseStore.ts', 'src/stores/salesReturnStore.ts']),
    `9 Los-Anlage nur in Backfill, Production, Einkauf (auch Bulk), Retoure (${S(writers)})`);
  const cc = src('src/core/bridge/commercial-commands.ts');
  ok(/createPurchaseDetailedInHouse|runPurchaseCreate/.test(cc) && !/INSERT INTO stock_lots/.test(cc), '9 PC2/Handy (purchases.create) laufen über createPurchase');
}

console.log(`\nlot-vat-cost: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
