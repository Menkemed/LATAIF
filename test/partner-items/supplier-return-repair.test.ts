// ════════════════════════════════════════════════════════════════════════════
// v0.8.101 — Lieferantenrückgabe nach Reparatur: kein stiller Restwert im Lager (Hauptbuch INVENTORY = Bestand)
// Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/supplier-return-repair.test.ts
/* eslint-disable @typescript-eslint/no-unused-vars -- übernommener Harness (nicht jeder Helfer wird hier gebraucht). */
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
await import('../../src/core/automation/automation-handlers.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore, loadPurchasesFor } = await import('../../src/stores/purchaseStore.ts');
const { usePartnerStore, loadPartnersFor } = await import('../../src/stores/partnerStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { bankTransactionsFor } = await import('../../src/stores/bankingStore.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const purchaseRules = await import('../../src/core/purchases/purchase-create.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const rules = await import('../../src/core/partners/item-participation.ts');
const house = await import('../../src/core/partners/item-participation-house.ts');
const save = await import('../../src/core/partners/item-participation-save.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-26T10:00:00.000Z';

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
  useInvoiceStore.getState().loadInvoices();
  usePurchaseStore.getState().loadPurchases();
  usePartnerStore.getState().loadPartners();
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
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  for (const [id, name, active] of [['pa-b', 'Bashir', 1], ['pa-c', 'Chalid', 1], ['pa-off', 'Old Partner', 0]] as Array<[string, string, number]>) {
    db.run(`INSERT INTO partners (id, branch_id, name, share_percentage, active, created_at, updated_at)
      VALUES (?, 'branch-main', ?, 0, ?, ?, ?)`, [id, name, active, NOW, NOW]);
  }
  for (const pid of ['pw1', 'pw2', 'pw3', 'pw4', 'pw5']) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
    [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
async function code(p: () => unknown): Promise<string> {
  try { await p(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)); }
}
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };
type PI = import('../../src/core/purchases/purchase-create.ts').PurchaseCreateInput;
const EINKAUF = (lines: PI['lines'], pay = 0): PI => ({
  supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines,
  paymentAmount: pay, paymentMethod: 'bank', notes: '', staffId: '',
});
const ZEILE = (productId: string, price = 1000, partnerShares?: Array<{ partnerId: string; sharePct: number }>, qty = 1): PI['lines'][number] => ({
  mode: 'existing', productId, brand: 'Rolex', name: 'Sub ' + productId, sku: 'SKU-' + productId, categoryId: 'cat-w',
  quantity: qty, unitPrice: price, ...(partnerShares ? { partnerShares } : {}),
});
const lineOf = (db: Db, purchaseId: string, productId: string): string =>
  s(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ? AND product_id = ?', [purchaseId, productId]);
const lotOf = (db: Db, purchaseLineId: string): string => s(db, 'SELECT id FROM stock_lots WHERE purchase_line_id = ?', [purchaseLineId]);
const open = (lineId: string, partnerId = 'pa-b'): number => house.partnerItemOpen(lineId, partnerId, 'branch-main');
const bal = (account: string): number => {
  const db = DB;
  return n(db, `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?`, [account]);
};
const move = (lineId: string, kind: 'CONTRIBUTION' | 'PAYOUT', amount: number, partnerId = 'pa-b', method: 'cash' | 'bank' | 'benefit' = 'bank') =>
  save.recordItemMovementOnPrimary({ purchaseLineId: lineId, partnerId, kind, amount, method, date: '2026-09-21' });

function verkauf(db: Db, productId: string, lotId: string, price: number, pay: 'none' | 'part' | 'full', qty = 1): { inv: string; il: string } {
  // Wie die Maske: mit gewähltem Los reist dessen Einstand als purchasePrice mit.
  const unitCost = n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lotId]);
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{
    productId, quantity: qty, unitPrice: price, purchasePrice: unitCost, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0,
    lineTotal: price * qty, lotId,
  }] as never, 'P').id);
  reload();
  const brutto = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  if (pay !== 'none') imHaus(() => useInvoiceStore.getState().recordPayment(inv, pay === 'full' ? brutto : brutto / 2, 'cash'));
  reload();
  return { inv, il: s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]) };
}


const cmd2 = await import('../../src/core/bridge/partner-item-commands.ts');
const plc = await import('../../src/core/bridge/purchase-lifecycle-commands.ts');
const { createReturnInHouse } = await import('../../src/core/returns/return-house.ts');
const { returnToSupplierInHouse, cancelPurchaseInHouse } = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { localHouseCtx, applyCreditToPurchaseInHouse } = await import('../../src/core/payables/payables-house.ts');
const { shiftOwnRepairCost } = await import('../../src/core/repairs/repair-cost-booking.ts');
const { runExclusive } = await import('../../src/core/bridge/command-scheduler.ts');
void CTX; void cmd; void loadPartnersFor; void bankTransactionsFor; void purchaseRules;

// ════════════════════════════════════════════════════════════════════════════
// Lieferantenrückgabe nach Reparatur: bleiben aktivierte Reparaturkosten nach vollständiger Rückgabe still im Lagerwert?
// Lagerwert im Hauptbuch (INVENTORY) gegen den Bestand (Σ Restmenge × Einstand der aktiven Lose).
// ════════════════════════════════════════════════════════════════════════════
const repairs = await import('../../src/core/repairs/repair-house.ts');
const DB = freshDb();
for (let i = 6; i <= 20; i++) {
  const pid = 'pw' + i;
  DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
  [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
}
reload();
type Shares = Array<{ partnerId: string; sharePct: number }>;
const kauf = async (pid: string, price: number, shares: Shares | undefined, qty = 1, pay = 0) => {
  const id = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE(pid, price, shares, qty)], pay))).id;
  return { id, line: lineOf(DB, id, pid) };
};
const ret = (purchaseId: string, line: string, qty: number, unitPrice: number) =>
  imHaus(() => returnToSupplierInHouse({ purchaseId, refundMethod: 'cash' as never, lines: [{ purchaseLineId: line, quantity: qty, unitPrice }] }, localHouseCtx()));
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const inventarHauptbuch = (): number => r3(n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'INVENTORY'"));
const inventarBestand = (): number => r3(n(DB, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED'"));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
async function reparaturFertig(pid: string, lot: string, kosten: number): Promise<void> {
  const id = (await repairs.createRepairOnPrimary({ repairScope: 'OWN', productId: pid, lotId: lot, issueDescription: 'Service',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: kosten } as never)).id;
  await repairs.updateRepairStatusOnPrimary(id, 'in_progress' as never);
  await repairs.updateRepairStatusOnPrimary(id, 'ready' as never);
}

// ── L1 Eigener Artikel 1000, Reparatur 100 („ready"), vollständige Rückgabe zum Einkaufspreis ──
{
  const a = await kauf('pw6', 1000, undefined, 1, 1000);
  const lot = lotOf(DB, a.line);
  await reparaturFertig('pw6', lot, 100);
  ok(r3(n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot])) === 1100 && inventarHauptbuch() === inventarBestand(),
    `L1 vor der Rückgabe: Los 1100, Hauptbuch INVENTORY = Bestand (${inventarHauptbuch()}/${inventarBestand()})`);
  const vorher = { hb: inventarHauptbuch(), bestand: inventarBestand(), lose: S(DB.exec('SELECT qty_remaining, unit_cost FROM stock_lots WHERE id = ?', [lot])[0].values) };
  const c = await code(() => Promise.resolve(ret(a.id, a.line, 1, 1000)));
  ok(c === 'PURCHASE_RETURN_HAS_ADDED_COSTS', `L1 Rückgabe gesperrt: das Stück trägt 100 aktivierte Reparaturkosten, sie blieben sonst still im Lager (${c})`);
  ok(inventarHauptbuch() === vorher.hb && inventarBestand() === vorher.bestand
    && S(DB.exec('SELECT qty_remaining, unit_cost FROM stock_lots WHERE id = ?', [lot])[0].values) === vorher.lose && ausgeglichen(),
    'L1 nichts geschrieben: Lager, Los und Hauptbuch unverändert');
}

// ── L2 Ohne Reparatur: Rückgabe wie bisher, kein Restwert ──────────────────
{
  const a = await kauf('pw7', 1000, undefined, 1, 1000);
  const hb0 = inventarHauptbuch(), b0 = inventarBestand();
  ret(a.id, a.line, 1, 1000);
  ok(r3(hb0 - inventarHauptbuch()) === 1000 && r3(b0 - inventarBestand()) === 1000 && inventarHauptbuch() === inventarBestand() && ausgeglichen(),
    'L2 ohne Reparatur: Haben INVENTORY 1000 = Los 1000, kein Restwert');
}

// ── L3 Gemeinsamer Artikel mit Reparatur: ebenso gesperrt (Partneranteil würde sonst gegen einen Lagerrest gerechnet) ──
{
  const a = await kauf('pw8', 1000, [{ partnerId: 'pa-b', sharePct: 40 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 400);
  await reparaturFertig('pw8', lotOf(DB, a.line), 100);
  const c = await code(() => Promise.resolve(ret(a.id, a.line, 1, 1000)));
  ok(c === 'PURCHASE_RETURN_HAS_ADDED_COSTS' && open(a.line) === -40 && inventarHauptbuch() === inventarBestand(),
    `L3 gemeinsamer Artikel: gesperrt, Partner unverändert (schuldet 40), Lager = Hauptbuch (${c}, ${open(a.line)})`);
}

console.log(`\nsupplier-return-repair: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('SUPPLIER_RETURN_REPAIR_PROVED');
