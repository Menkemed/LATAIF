// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — gezielte Tests gemäß docs/bulk-metal-v1-spec.md, Kapitel 17.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores,
// echte Hausfolgen, echtes Hauptbuch.
// Run: node --experimental-strip-types test/bulk-metal/bulk-metal.test.ts
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
// BULK METAL V1 — Teil 1: Rechnen, Einkauf, Lot-Hausfolge, manuelle Aktionen, Storno, BM-Nummern.
// ════════════════════════════════════════════════════════════════════════════
const bm = await import('../../src/core/bulk/bulk-math.ts');
const bp = await import('../../src/core/bulk/bulk-product.ts');
const lh = await import('../../src/core/bulk/bulk-lot-house.ts');
const lq = await import('../../src/core/lots/lot-queries.ts');
const { createPurchaseDetailedInHouse } = await import('../../src/core/purchases/purchase-house.ts');

const PDATE = '2026-10-07';
const CTXB = { branchId: 'branch-main', userId: 'user-test', now: NOW, role: 'ADMIN' };
const MANAGER = { ...CTXB, role: 'MANAGER' };
const SALES = { ...CTXB, role: 'SALES' };

let DB: Db | null = null;
const neu = (): Db => { DB = freshDb(); return DB; };
const inventory = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'INVENTORY'"));
const accountBal = (db: Db, acc: string): number =>
  r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [acc]));
const bulkValueFils = (db: Db): number =>
  n(db, "SELECT COALESCE(SUM(remaining_value_fils), 0) FROM stock_lots WHERE unit = 'mg' AND status != 'CANCELLED'");
const lotOfPurchase = (db: Db, pid: string): string => s(db, "SELECT id FROM stock_lots WHERE purchase_id = ? AND unit = 'mg' ORDER BY lot_no", [pid]);
const lot = (id: string) => lh.getBulkLot(id)!;
const moves = (id: string) => lh.movementsOf(id);
const invOk = (id: string): boolean => { try { lh.assertBulkLotInvariants(id); return true; } catch (e) { console.log('    ' + (e as Error).message); return false; } };

interface KaufOpts { metal?: string; fineness?: string; weight: string; cost: string; vat?: boolean; saleTax?: string; composition?: unknown; }
function bulkLine(o: KaufOpts) {
  const weightMg = bm.parseGramsToMg(o.weight);
  const lineTotalFils = bm.parseBhdToFils(o.cost);
  return {
    mode: 'bulk' as const, brand: '', name: '', sku: '', categoryId: '', quantity: 1, unitPrice: lineTotalFils / 1000,
    bulk: { metal: o.metal ?? 'silver', fineness: o.fineness ?? '925', weightMg, lineTotalFils,
      saleTaxScheme: o.saleTax ?? (o.vat ? 'VAT_10' : 'MARGIN'), composition: o.composition },
  };
}
function bulkKaufInput(lines: KaufOpts[], vat = false) {
  return { supplierId: 'sup-1', purchaseDate: PDATE, taxScheme: vat ? 'VAT_10' : 'ZERO', lines: lines.map(bulkLine),
    paymentAmount: 0, paymentMethod: 'cash', notes: '', staffId: '' };
}
function bulkKauf(o: KaufOpts): string {
  const r = imHaus(() => createPurchaseDetailedInHouse(bulkKaufInput([o], !!o.vat) as never, 'branch-main', 'user-test'));
  reload();
  return r.purchase.id;
}
const COMP = [
  { type: 'RINGS', weightMg: 180000, pieces: 30 }, { type: 'BRACELETS_BANGLES', weightMg: 100000 },
  { type: 'NECKLACES_CHAINS', weightMg: 120000 }, { type: 'SETS', weightMg: 70000 }, { type: 'MIXED_OTHER', weightMg: 30000 },
];
let aid = 0;
const newAction = (): string => `action-${++aid}-xxxxxxxx`;

// ══ A — Rechnen ══════════════════════════════════════════════════════════════
{
  ok(bm.parseGramsToMg('7') === 7000 && bm.parseGramsToMg('7.5') === 7500 && bm.parseGramsToMg('7.500') === 7500, 'A1 Gramm-Text → mg exakt');
  for (const bad of ['7.5001', '0', '-1', '1,5', '1e3', ' 7', '', '.5']) ok(meldung(() => bm.parseGramsToMg(bad)).startsWith('BULK_WEIGHT_INVALID'), `A1 „${bad}" abgewiesen`);
  ok(bm.parseBhdToFils('25') === 25000 && bm.parseBhdToFils('1000.000') === 1000000, 'A2 BHD-Text → Fils exakt');
  ok(meldung(() => bm.parseBhdToFils('1,000.000')).startsWith('BULK_AMOUNT_INVALID') && meldung(() => bm.parseBhdToFils('25.0001')).startsWith('BULK_AMOUNT_INVALID'), 'A2 Trennzeichen / 4 Dezimalen abgewiesen');
  ok(bm.allocateFils(1000000, 500000, 7000) === 14000, 'A3 1000 BHD / 500 g, 7 g → 14.000');
  ok(bm.allocateFils(10000, 3000, 1000) === 3333 && bm.allocateFils(6667, 2000, 1000) === 3334 && bm.allocateFils(3333, 1000, 1000) === 3333, 'A3 Rundungsbeispiel 3.333 / 3.334 (half-up) / Rest 3.333 = 10.000');
  ok(bm.allocateFils(1e8, 1e8, 33333333) === 33333333, 'A3 BigInt bei 10^8 × 10^8 exakt');
  ok(bm.vatFilsOfGross(1100000, 10) === 100000 && bm.vatFilsOfGross(1, 10) === 0 && bm.vatFilsOfGross(11, 10) === 1, 'A4 Vorsteuer in Fils (half-up)');
  ok(bm.costPerGramText(1000000, 500000) === '2.000' && bm.costPerGramText(6667, 2000) === '3.334', 'A5 Kosten/g-Text');
  ok(bm.formatMg(7000) === '7.000' && bm.formatFils(1000000) === '1000.000' && bm.filsToBhd(14000) === 14, 'A6 Anzeige aus Integern');
  const src0 = src('src/core/bulk/bulk-math.ts');
  ok(!/Math\.round\([^)]*\* 1000\)/.test(src0.replace(/filsOfStoredAmount[\s\S]*?\n}\n/, '')), 'A7 kein Math.round(float × 1000) im Eingabepfad');
}

// ══ B — Einkauf ZERO 500 g / 1000 BHD ═════════════════════════════════════════
{
  const db = neu();
  const pid = bulkKauf({ weight: '500', cost: '1000', composition: COMP });
  const id = lotOfPurchase(db, pid);
  const L = lot(id);
  ok(!!id && L.lotNo === 'BM-0001', `B1 Lot BM-0001 (${L?.lotNo})`);
  ok(L.originalWeightMg === 500000 && L.remainingWeightMg === 500000 && L.originalValueFils === 1000000 && L.remainingValueFils === 1000000, 'B1 500.000 g / 1000.000 BHD in mg/Fils');
  ok(n(db, 'SELECT qty_total + qty_remaining + unit_cost FROM stock_lots WHERE id = ?', [id]) === 0, 'B1 Stückfelder 0');
  ok(L.saleTaxScheme === 'MARGIN' && L.status === 'ACTIVE' && L.composition.length === 5, 'B1 MARGIN, ACTIVE, Composition gespeichert');
  const prod = db.exec("SELECT id, sku, quantity, stock_status, category_id, source_type FROM products WHERE id LIKE 'bulk-%'")[0]?.values ?? [];
  ok(prod.length === 1 && prod[0][0] === 'bulk-silver-925-branch-main' && prod[0][1] === null && Number(prod[0][2]) === 0
    && prod[0][3] === 'in_stock' && prod[0][4] === 'cat-bulk-metal-branch-main', `B2 Systemartikel ohne SKU, Menge 0, in_stock (${S(prod)})`);
  ok(n(db, "SELECT COUNT(*) FROM stock_lots WHERE purchase_id = ?", [pid]) === 1, 'B2 kein zusätzliches Stück-Los');
  const pl = db.exec('SELECT quantity, line_total, vat_amount, description FROM purchase_lines WHERE purchase_id = ?', [pid])[0].values[0];
  ok(Number(pl[0]) === 1 && Number(pl[1]) === 1000 && Number(pl[2]) === 0 && pl[3] === 'Silver 925 · 500.000 g (bulk)', `B3 Einkaufszeile ${S(pl)}`);
  ok(inventory(db) === 1000 && bulkValueFils(db) === 1000000, 'B4 INVENTORY 1000.000 = Σ Restwert');
  const m = moves(id);
  ok(m.length === 1 && m[0].kind === 'PURCHASE' && m[0].seq === 1 && m[0].weightMg === 500000, 'B5 Bewegung PURCHASE seq 1');
  ok(invOk(id), 'B6 Invarianten');
  // Stückpfade sind blind
  ok(lq.getActiveLots('bulk-silver-925-branch-main').length === 0, 'B7 getActiveLots sieht das Bulk-Lot nicht');
  ok(meldung(() => lq.consumeLot(id, 1)).startsWith('BULK_LOT_PIECE_PATH') && meldung(() => lq.restoreLot(id, 1)).startsWith('BULK_LOT_PIECE_PATH'), 'B7 consumeLot/restoreLot werfen');
  ok(!lq.getStockAggregates().has('bulk-silver-925-branch-main'), 'B7 Aggregate ohne Bulk');
  ok(lq.computeStockValuation([{ id: 'bulk-silver-925-branch-main', purchasePrice: 0, quantity: 0 }]).count === 0, 'B7 Bewertung zählt kein Stück');
  lq.reconcileSaleStatus('bulk-silver-925-branch-main', true); lq.reserveProductIfDepleted('bulk-silver-925-branch-main');
  ok(s(db, "SELECT stock_status FROM products WHERE id = 'bulk-silver-925-branch-main'") === 'in_stock', 'B7 Status des Systemartikels bleibt in_stock');
}

// ══ C — Einkauf VAT_10 1100 brutto → Lot 1000 netto ══════════════════════════
{
  const db = neu();
  const pid = bulkKauf({ weight: '500', cost: '1100', vat: true });
  const L = lot(lotOfPurchase(db, pid));
  ok(L.originalValueFils === 1000000 && L.saleTaxScheme === 'VAT_10', 'C1 Lot-Wert netto 1000.000, VAT_10');
  ok(inventory(db) === 1000 && accountBal(db, 'VAT_INPUT') === 100 && accountBal(db, 'ACCOUNTS_PAYABLE') === -1100, 'C2 INVENTORY 1000 / VAT_INPUT 100 / AP 1100');
  // Gold 24K, Rundungsgrenze 0.011 brutto → Vorsteuer 0.001, Lot 0.010
  const p2 = bulkKauf({ metal: 'gold', fineness: '24K', weight: '1', cost: '0.011', vat: true });
  const L2 = lot(lotOfPurchase(db, p2));
  ok(L2.originalValueFils === 10 && L2.lotNo === 'BM-0002' && L2.productId === 'bulk-gold-24k-branch-main', `C3 Gold 24K: Lot 0.010, BM-0002 (${L2.originalValueFils})`);
  ok(inventory(db) === r3(1000 + 0.01) && bulkValueFils(db) === 1000010, 'C3 INVENTORY = Σ Restwert');
  ok(meldungAsync !== undefined && meldung(() => imHaus(() => createPurchaseDetailedInHouse(bulkKaufInput([{ metal: 'silver', fineness: '24K', weight: '1', cost: '1' }]) as never, 'branch-main', 'user-test'))).startsWith('BULK_METAL_INVALID'), 'C4 Silber 24K abgewiesen');
  ok(meldung(() => imHaus(() => createPurchaseDetailedInHouse(bulkKaufInput([{ weight: '10', cost: '1', composition: [{ type: 'RINGS', weightMg: 10001 }] }]) as never, 'branch-main', 'user-test'))).startsWith('BULK_COMPOSITION_EXCEEDS_WEIGHT'), 'C5 Composition > Gewicht abgewiesen');
}

// ══ D — manuelle Aktionen: Korrektur, Write-off, Close, Stornieren, Replay ════
{
  const db = neu();
  const pid = bulkKauf({ weight: '500', cost: '1000', composition: COMP });
  const id = lotOfPurchase(db, pid);
  // Korrektur ohne Composition-Anpassung unter die Composition-Summe → Nein
  const a0 = newAction();
  ok(meldung(() => imHaus(() => lh.correctLotInHouse({ actionId: a0, lotId: id, expectedRevision: lot(id).revision, newWeightMg: 480000, composition: COMP, reason: 'nachgewogen' }, CTXB))).startsWith('BULK_COMPOSITION_EXCEEDS_WEIGHT'), 'D1 Gewicht unter Composition-Summe ohne Anpassung → Nein');
  const comp2 = COMP.map((c) => c.type === 'MIXED_OTHER' ? { ...c, weightMg: 10000 } : c);
  const a1 = newAction();
  const r1 = imHaus(() => lh.correctLotInHouse({ actionId: a1, lotId: id, expectedRevision: lot(id).revision, newWeightMg: 480000, composition: comp2, reason: 'nachgewogen' }, CTXB));
  ok(lot(id).originalWeightMg === 480000 && lot(id).remainingWeightMg === 480000 && lot(id).remainingValueFils === 1000000, 'D1 Korrektur auf 480 g mit angepasster Composition; Wert unverändert');
  ok(r1.kind === 'WEIGHT_CORRECTION' && r1.weightMg === -20000 && r1.compositionAfter?.find((c) => c.type === 'MIXED_OTHER')?.weightMg === 10000, 'D1 Ergebnis mit Composition vorher/nachher');
  const r1b = imHaus(() => lh.correctLotInHouse({ actionId: a1, lotId: id, expectedRevision: 0, newWeightMg: 480000, composition: comp2, reason: 'nachgewogen' }, CTXB));
  ok(S(r1b) === S(r1) && moves(id).length === 2, 'D2 Replay gleiche action_id (alte Revision) → identische Antwort, keine zweite Bewegung');
  ok(meldung(() => imHaus(() => lh.correctLotInHouse({ actionId: a1, lotId: id, expectedRevision: lot(id).revision, newWeightMg: 490000, composition: comp2, reason: 'nachgewogen' }, CTXB))).startsWith('BULK_ACTION_ID_CONFLICT'), 'D2 gleiche action_id, andere Eingabe → Konflikt');
  ok(meldung(() => imHaus(() => lh.correctLotInHouse({ actionId: newAction(), lotId: id, expectedRevision: 0, newWeightMg: 500000, composition: comp2, reason: 'x' }, CTXB))).startsWith('BULK_LOT_REVISION_CHANGED'), 'D2 neue Aktion mit veralteter Revision → Nein');
  ok(meldung(() => imHaus(() => lh.correctLotInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, newWeightMg: 500000, composition: comp2, reason: 'x' }, SALES))).startsWith('PERMISSION_DENIED'), 'D2 SALES darf nicht korrigieren');
  ok(meldung(() => imHaus(() => lh.writeOffInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, weightMg: 1200, reason: '' }, CTXB))).startsWith('BULK_REASON_REQUIRED'), 'D3 Grund Pflicht');
  // Write-off 1.200 g von 480 g / 1000 BHD → round(1000000 × 1200 / 480000) = 2500
  const a2 = newAction();
  const w1 = imHaus(() => lh.writeOffInHouse({ actionId: a2, lotId: id, expectedRevision: lot(id).revision, weightMg: 1200, reason: 'Waage' }, MANAGER));
  ok(w1.kind === 'WRITE_OFF' && w1.valueFils === -2500 && lot(id).remainingWeightMg === 478800 && lot(id).remainingValueFils === 997500, `D3 Write-off 1.2 g = 2.500 (${w1.valueFils})`);
  ok(accountBal(db, 'INVENTORY_LOSS') === 2.5 && inventory(db) === 997.5 && bulkValueFils(db) === 997500, 'D3 Soll INVENTORY_LOSS / Haben INVENTORY 2.500; INVENTORY = Σ Restwert');
  // Verlorene Antwort: Revision ist gestiegen, Wiederholung mit gleicher action_id → gleiche Antwort
  const w1b = imHaus(() => lh.writeOffInHouse({ actionId: a2, lotId: id, expectedRevision: 0, weightMg: 1200, reason: 'Waage' }, MANAGER));
  ok(S(w1b) === S(w1) && accountBal(db, 'INVENTORY_LOSS') === 2.5 && moves(id).length === 3, 'D4 Lost-response-Replay: identisch, keine zweite Abschreibung');
  ok(meldung(() => imHaus(() => lh.correctLotInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, newWeightMg: 500000, composition: comp2, reason: 'x' }, CTXB))).startsWith('BULK_LOT_IN_USE'), 'D5 nach Abschreibung keine Korrektur mehr');
  // Stornieren: MANAGER nein, ADMIN ja
  const target = moves(id).at(-1)!;
  ok(meldung(() => imHaus(() => lh.reverseAdjustmentInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, movementId: target.id, reason: 'Tippfehler' }, MANAGER))).startsWith('PERMISSION_DENIED'), 'D6 MANAGER darf nicht stornieren');
  const a3 = newAction();
  const rv = imHaus(() => lh.reverseAdjustmentInHouse({ actionId: a3, lotId: id, expectedRevision: lot(id).revision, movementId: target.id, reason: 'Tippfehler' }, CTXB));
  ok(rv.kind === 'ADJUSTMENT_REVERSAL' && lot(id).remainingWeightMg === 480000 && lot(id).remainingValueFils === 1000000, 'D6 ADMIN storniert die letzte Abschreibung exakt');
  ok(accountBal(db, 'INVENTORY_LOSS') === 0 && inventory(db) === 1000, 'D6 Hauptbuch gespiegelt');
  ok(meldung(() => imHaus(() => lh.reverseAdjustmentInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, movementId: target.id, reason: 'x' }, CTXB))).startsWith('BULK_REVERSAL_NOT_LAST'), 'D6 zweimal stornieren → Nein');
  ok(meldung(() => imHaus(() => lh.reverseAdjustmentInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, movementId: moves(id).at(-1)!.id, reason: 'x' }, CTXB))).startsWith('BULK_REVERSAL_NOT_LAST'), 'D6 Stornierung stornieren → Nein');
  // Close mit veraltetem Rest → Nein; richtig → CLOSED; Stornieren → ACTIVE
  ok(meldung(() => imHaus(() => lh.closeLotInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, confirmWeightMg: 479000, confirmValueFils: 1000000, reason: 'Rest' }, CTXB))).startsWith('BULK_CLOSE_STALE'), 'D7 Close mit veraltetem Rest → Nein');
  const c1 = imHaus(() => lh.closeLotInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, confirmWeightMg: 480000, confirmValueFils: 1000000, reason: 'Rest' }, CTXB));
  ok(c1.kind === 'CLOSE' && lot(id).status === 'CLOSED' && lot(id).closedAt !== null && lot(id).remainingWeightMg === 0 && lot(id).remainingValueFils === 0, 'D7 Close → CLOSED, 0/0');
  ok(accountBal(db, 'INVENTORY_LOSS') === 1000 && inventory(db) === 0, 'D7 Restwert 1000.000 als Bestandsverlust');
  const rc = imHaus(() => lh.reverseAdjustmentInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, movementId: moves(id).at(-1)!.id, reason: 'falsch geschlossen' }, CTXB));
  ok(rc.lot.status === 'ACTIVE' && lot(id).closedAt === null && lot(id).remainingWeightMg === 480000 && inventory(db) === 1000 && accountBal(db, 'INVENTORY_LOSS') === 0, 'D8 Close storniert → ACTIVE, closed_at leer, Spiegel');
  // Write-off X = Rest wird als Close ausgeführt
  const wx = imHaus(() => lh.writeOffInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, weightMg: 480000, reason: 'alles' }, CTXB));
  ok(wx.kind === 'CLOSE' && lot(id).status === 'CLOSED', 'D9 Write-off des ganzen Rests = Close');
  ok(invOk(id) && moves(id).every((m, i) => m.seq === i + 1), 'D10 Invarianten, seq lückenlos');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE module = 'BulkMetals'") >= 6, 'D11 Audit je manueller Aktion');
}

// ══ E — Einkauf stornieren / Lieferantenrückgabe ═════════════════════════════
{
  const db = neu();
  const p1 = bulkKauf({ weight: '100', cost: '200' });
  const id1 = lotOfPurchase(db, p1);
  imHaus(() => life.cancelPurchaseInHouse(p1, 'branch-main'));
  ok(lot(id1).status === 'CANCELLED' && lot(id1).remainingWeightMg === 0 && moves(id1).at(-1)?.kind === 'PURCHASE_CANCEL', 'E1 unbenutzt storniert: CANCELLED + PURCHASE_CANCEL');
  ok(inventory(db) === 0 && invOk(id1), 'E1 INVENTORY gespiegelt, Invarianten');
  ok(s(db, "SELECT stock_status FROM products WHERE id = 'bulk-silver-925-branch-main'") === 'in_stock', 'E1 Systemartikel bleibt in_stock');
  const p2 = bulkKauf({ weight: '100', cost: '200' });
  const id2 = lotOfPurchase(db, p2);
  imHaus(() => lh.writeOffInHouse({ actionId: newAction(), lotId: id2, expectedRevision: lot(id2).revision, weightMg: 1000, reason: 'x' }, CTXB));
  ok(meldung(() => imHaus(() => life.cancelPurchaseInHouse(p2, 'branch-main'))).startsWith('BULK_LOT_IN_USE'), 'E2 benutzt → BULK_LOT_IN_USE');
  const plId = s(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ?', [p2]);
  ok(meldung(() => imHaus(() => life.returnToSupplierInHouse({ purchaseId: p2, refundMethod: 'credit' as never, lines: [{ purchaseLineId: plId, quantity: 1, unitPrice: 1 }] }, CTX))).includes('BULK_NOT_SUPPORTED_HERE'), 'E3 Lieferantenrückgabe gesperrt');
}

// ══ F — BM-Nummern ═══════════════════════════════════════════════════════════
{
  const db = neu();
  const p1 = bulkKauf({ weight: '1', cost: '1' });
  const r2 = imHaus(() => createPurchaseDetailedInHouse(bulkKaufInput([{ weight: '1', cost: '1' }, { metal: 'gold', fineness: '18K', weight: '2', cost: '5' }]) as never, 'branch-main', 'user-test'));
  reload();
  const nos = db.exec("SELECT lot_no FROM stock_lots WHERE unit = 'mg' ORDER BY lot_no")[0].values.map((v) => v[0]);
  ok(S(nos) === S(['BM-0001', 'BM-0002', 'BM-0003']) && !!p1 && !!r2, `F1 fortlaufend, zwei Zeilen → zwei Nummern (${S(nos)})`);
  // zurückgerollter Einkauf verbraucht keine Nummer
  ok(meldung(() => imHaus(() => { createPurchaseDetailedInHouse(bulkKaufInput([{ weight: '1', cost: '1' }]) as never, 'branch-main', 'user-test'); throw new Error('boom'); })).includes('boom'), 'F2 Einkauf scheitert nach dem Anlegen');
  const p4 = bulkKauf({ weight: '1', cost: '1' });
  ok(s(db, 'SELECT lot_no FROM stock_lots WHERE purchase_id = ?', [p4]) === 'BM-0004', 'F2 nach Rollback: BM-0004 (keine verbrauchte Nummer)');
  // Zähler zu niedrig / fehlt → Selbstheilung über MAX
  db.run('DELETE FROM bulk_lot_sequences');
  const p5 = bulkKauf({ weight: '1', cost: '1' });
  ok(s(db, 'SELECT lot_no FROM stock_lots WHERE purchase_id = ?', [p5]) === 'BM-0005', 'F3 Zähler fehlt → BM-0005 aus MAX');
  // erzwungenes Duplikat scheitert am Unique-Index
  ok(meldung(() => db.run("UPDATE stock_lots SET lot_no = 'BM-0001' WHERE purchase_id = ?", [p5])).includes('UNIQUE'), 'F4 Duplikat scheitert am Unique-Index');
  // zweite Filiale: eigene Nummernfolge
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zwei',?,?)", [NOW, NOW]);
  const no2 = lh.allocateBulkLotNo('branch-2', NOW);
  ok(no2 === 'BM-0001', 'F5 andere Filiale beginnt bei BM-0001');
}

// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — Teil 2: Verkauf, Ändern, Storno, Löschen, Retoure, Retoure-Storno, Beispiel 15.
// ════════════════════════════════════════════════════════════════════════════
const { createInvoiceInHouse } = await import('../../src/core/invoices/invoice-create-house.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');

interface Sale { lotId: string; weight: string; type?: string; price: string; description?: string }
const intent = (x: Sale) => ({
  bulkIntent: { lotId: x.lotId, weightMg: bm.parseGramsToMg(x.weight), bulkType: x.type ?? 'RING', unitPriceFils: bm.parseBhdToFils(x.price, true), ...(x.description ? { description: x.description } : {}) },
});
function verkauf(sales: Sale[]): string {
  const r = imHaus(() => createInvoiceInHouse({ customerId: 'cust-1', lines: sales.map(intent) as never, specialMark: false }, 'branch-main'));
  reload();
  return r.invoiceId;
}
function zahlen(db: Db, invId: string, amount?: number): void {
  const offen = amount ?? n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
}
function retoureBulk(db: Db, invId: string, lineId: string, qty = 1, disposition = 'IN_STOCK'): string {
  const lt = n(db, 'SELECT line_total FROM invoice_lines WHERE id = ?', [lineId]);
  const vat = n(db, 'SELECT vat_amount FROM invoice_lines WHERE id = ?', [lineId]);
  const pid = s(db, 'SELECT product_id FROM invoice_lines WHERE id = ?', [lineId]);
  const id = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const rid = rs.createReturn({ invoiceId: invId, refundMethod: 'cash', productDisposition: disposition as never, reason: 'zurück',
      lines: [{ invoiceLineId: lineId, productId: pid, quantity: qty, unitPrice: lt, vatAmount: vat }] }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
    return rid;
  });
  reload();
  return id;
}
const lineOf = (db: Db, invId: string, pos = 1): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ? AND position = ?', [invId, pos]);
const lineRow = (db: Db, lineId: string): Record<string, unknown> => {
  const r = db.exec('SELECT * FROM invoice_lines WHERE id = ?', [lineId])[0];
  return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
};
const ledgerOf = (db: Db, module: string, sourceId: string, account: string): number =>
  r3(n(db, `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries
             WHERE source_module = ? AND source_id = ? AND account = ?`, [module, sourceId, account]));
const balancedInventory = (db: Db): boolean => {
  const ok0 = Math.abs(inventory(db) - bulkValueFils(db) / 1000) < 0.0005;
  if (!ok0) console.log(`    INVENTORY ${inventory(db)} vs Σ Restwert ${bulkValueFils(db) / 1000}`);
  return ok0;
};

// ══ G — Verkauf MARGIN: Spec 15, Schritt 0–2, und zwei Zeilen aus demselben Lot ══
{
  const db = neu();
  const pid = bulkKauf({ weight: '500', cost: '1000', composition: COMP });
  const id = lotOfPurchase(db, pid);
  const inv1 = verkauf([{ lotId: id, weight: '7', type: 'RING', price: '25' }]);
  const l1 = lineRow(db, lineOf(db, inv1));
  ok(Number(l1.quantity) === 1 && Number(l1.unit_price) === 25 && l1.tax_scheme === 'MARGIN' && Number(l1.vat_amount) === 1
    && Number(l1.line_total) === 25 && Number(l1.purchase_price_snapshot) === 14 && l1.lot_id === id
    && Number(l1.bulk_weight_mg) === 7000 && Number(l1.bulk_cogs_fils) === 14000 && l1.bulk_type === 'RING' && Number(l1.stock_taken) === 1,
  `G1 Zeile Ring: Menge 1, 25.000, MARGIN, MwSt intern 1.000, Snapshot 14.000 (${S([l1.unit_price, l1.vat_amount, l1.purchase_price_snapshot])})`);
  ok(l1.description === 'Ring · Silver 925 · 7.000 g' && l1.bulk_metal === 'silver' && l1.bulk_fineness === '925', `G1 Beschreibung „${String(l1.description)}"`);
  ok(ledgerOf(db, 'INVOICE', inv1, 'ACCOUNTS_RECEIVABLE') === 25 && ledgerOf(db, 'INVOICE', inv1, 'REVENUE') === -24
    && ledgerOf(db, 'INVOICE', inv1, 'MARGIN_VAT') === -1 && ledgerOf(db, 'INVOICE', inv1, 'COGS') === 14 && ledgerOf(db, 'INVOICE', inv1, 'INVENTORY') === -14,
  'G1 Hauptbuch: AR 25 / REVENUE 24 / MARGIN_VAT 1 / COGS 14 / INVENTORY −14');
  ok(lot(id).remainingWeightMg === 493000 && lot(id).remainingValueFils === 986000 && lot(id).status === 'ACTIVE', 'G1 Lot 493.000 g / 986.000');
  const inv2 = verkauf([{ lotId: id, weight: '21.5', type: 'NECKLACE_CHAIN', price: '70' }]);
  const l2 = lineRow(db, lineOf(db, inv2));
  ok(Number(l2.bulk_cogs_fils) === 43000 && Number(l2.vat_amount) === 2.455 && Number(l2.line_total) === 70, `G2 Necklace: COGS 43.000, MwSt 2.455 (${S([l2.bulk_cogs_fils, l2.vat_amount])})`);
  ok(ledgerOf(db, 'INVOICE', inv2, 'REVENUE') === -67.545, 'G2 REVENUE 67.545');
  ok(lot(id).remainingWeightMg === 471500 && lot(id).remainingValueFils === 943000, 'G2 Lot 471.500 g / 943.000');
  ok(balancedInventory(db) && invOk(id), 'G3 INVENTORY = Σ Restwert, Invarianten');
  ok(s(db, "SELECT stock_status FROM products WHERE id = 'bulk-silver-925-branch-main'") === 'in_stock'
    && n(db, "SELECT quantity FROM products WHERE id = 'bulk-silver-925-branch-main'") === 0, 'G3 Systemartikel bleibt in_stock / Menge 0');
  // Zwei Zeilen aus demselben Lot in einer Rechnung, Rundung: 3 g / 10 BHD
  const p3 = bulkKauf({ metal: 'gold', fineness: '21K', weight: '3', cost: '10' });
  const g = lotOfPurchase(db, p3);
  const inv3 = verkauf([{ lotId: g, weight: '1', price: '5', type: 'PENDANT' }, { lotId: g, weight: '1', price: '5', type: 'EARRINGS' }]);
  ok(Number(lineRow(db, lineOf(db, inv3, 1)).bulk_cogs_fils) === 3333 && Number(lineRow(db, lineOf(db, inv3, 2)).bulk_cogs_fils) === 3334, 'G4 zwei Zeilen eines Lots: 3.333 dann 3.334 (half-up)');
  const inv4 = verkauf([{ lotId: g, weight: '1', price: '5', type: 'OTHER' }]);
  ok(Number(lineRow(db, lineOf(db, inv4)).bulk_cogs_fils) === 3333 && lot(g).status === 'EXHAUSTED' && lot(g).remainingValueFils === 0, 'G4 letzter Verbrauch nimmt exakt den Rest 3.333 → EXHAUSTED, 0/0');
  ok(balancedInventory(db) && invOk(g), 'G4 INVENTORY = Σ Restwert');
  // Abweisungen
  ok(meldung(() => verkauf([{ lotId: g, weight: '0.001', price: '1' }])).includes('BULK_LOT_NOT_ACTIVE'), 'G5 erschöpftes Lot → Nein');
  ok(meldung(() => verkauf([{ lotId: id, weight: '471.501', price: '1' }])).includes('BULK_WEIGHT_EXCEEDS_REMAINING'), 'G5 mehr als Rest → Nein');
  ok(meldung(() => verkauf([{ lotId: id, weight: '1', price: '1', type: 'BRACELET' }])).includes('BULK_TYPE_INVALID'), 'G5 Typ ungültig → Nein');
  ok(meldung(() => imHaus(() => createInvoiceInHouse({ customerId: 'cust-1', lines: [{ productId: 'bulk-silver-925-branch-main', quantity: 1, unitPrice: 5, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 5 }] as never, specialMark: false }, 'branch-main'))).includes('BULK_PRODUCT_DIRECT_SALE'), 'G5 Systemartikel als Stückzeile → Nein');
  ok(n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id LIKE 'bulk-%' AND unit = 'pcs'") === 0, 'G6 kein Phantom-Stück-Los');
}

// ══ H — Verkauf VAT_10 und ZERO ══════════════════════════════════════════════
{
  const db = neu();
  const p = bulkKauf({ weight: '500', cost: '1100', vat: true });
  const id = lotOfPurchase(db, p);
  const inv = verkauf([{ lotId: id, weight: '7', price: '25' }]);
  const l = lineRow(db, lineOf(db, inv));
  ok(l.tax_scheme === 'VAT_10' && Number(l.unit_price) === 25 && Number(l.vat_amount) === 2.5 && Number(l.line_total) === 27.5 && Number(l.purchase_price_snapshot) === 14,
    `H1 VAT_10: netto 25.000, MwSt 2.500, Kunde 27.500, COGS 14.000 (${S([l.vat_amount, l.line_total])})`);
  ok(ledgerOf(db, 'INVOICE', inv, 'ACCOUNTS_RECEIVABLE') === 27.5 && ledgerOf(db, 'INVOICE', inv, 'REVENUE') === -25 && ledgerOf(db, 'INVOICE', inv, 'VAT_OUTPUT') === -2.5,
    'H1 Hauptbuch AR 27.5 / REVENUE 25 / VAT_OUTPUT 2.5');
  // dieselbe Zeile wie eine normale VAT_10-Zeile mit gleichem Preis und Einstand
  const { toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
  const normal = toInvoiceLine({ productId: 'x', quantity: 1, unitPrice: 25, costBasis: 14, scheme: 'VAT_10' });
  ok(normal.vatAmount === Number(l.vat_amount) && normal.lineTotal === Number(l.line_total) && normal.unitPrice === Number(l.unit_price), 'H2 identisch zu einer normalen VAT_10-Zeile');
  const pz = bulkKauf({ metal: 'gold', fineness: '24K', weight: '10', cost: '400', saleTax: 'ZERO' });
  const z = lotOfPurchase(db, pz);
  const invz = verkauf([{ lotId: z, weight: '10', type: 'BY_WEIGHT', price: '450' }]);
  const lz = lineRow(db, lineOf(db, invz));
  ok(lz.tax_scheme === 'ZERO' && Number(lz.vat_amount) === 0 && Number(lz.line_total) === 450 && Number(lz.bulk_cogs_fils) === 400000 && lot(z).status === 'EXHAUSTED',
    'H3 ZERO: keine MwSt, Kunde 450.000, COGS = ganzer Rest 400.000');
  ok(balancedInventory(db), 'H4 INVENTORY = Σ Restwert');
}

// ══ I — Ändern ════════════════════════════════════════════════════════════════
{
  const db = neu();
  const p = bulkKauf({ weight: '10', cost: '20' });
  const id = lotOfPurchase(db, p);
  const inv = verkauf([{ lotId: id, weight: '10', price: '30' }]);   // ganzer Lot → EXHAUSTED
  const lineId = lineOf(db, inv);
  ok(lot(id).status === 'EXHAUSTED', 'I0 Lot erschöpft');
  const rev = (): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
  void rev;
  // Preis/Typ/Beschreibung ändern: COGS bleibt, Lot unberührt
  imHaus(() => useInvoiceStore.getState().editInvoice(inv, { reason: 'Preis', lines: [{ lineId, productId: 'bulk-silver-925-branch-main', unitPrice: 0, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 0,
    bulkIntent: { lotId: id, weightMg: 10000, bulkType: 'SET', unitPriceFils: 35000, description: 'Set · Silver 925 · 10.000 g' } }] as never }));
  reload();
  const e1 = lineRow(db, lineId);
  ok(Number(e1.unit_price) === 35 && Number(e1.purchase_price_snapshot) === 20 && Number(e1.bulk_cogs_fils) === 20000 && e1.bulk_type === 'SET' && Number(e1.vat_amount) === r3(15 * 10 / 110),
    `I1 Preis 35, Typ SET, COGS unverändert 20.000, MwSt neu (${S([e1.unit_price, e1.vat_amount, e1.bulk_type])})`);
  ok(lot(id).remainingWeightMg === 0 && moves(id).length === 2 && ledgerOf(db, 'INVOICE', inv, 'COGS') === 20, 'I1 Lot unberührt, COGS-Saldo 20');
  // Lot/Gewicht ändern → gesperrt
  ok(meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, { reason: 'x', lines: [{ lineId, productId: 'bulk-silver-925-branch-main', unitPrice: 0, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 0,
    bulkIntent: { lotId: id, weightMg: 9000, bulkType: 'SET', unitPriceFils: 35000 } }] as never }))).includes('BULK_LINE_FIELDS_LOCKED'), 'I2 Gewicht einer bestehenden Bulk-Zeile → gesperrt');
  // Entfernen + neu im selben Edit aus dem gerade erschöpften Lot (9 g)
  imHaus(() => useInvoiceStore.getState().editInvoice(inv, { reason: 'Gewicht korrigiert', lines: [{ productId: '', unitPrice: 0, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 0,
    bulkIntent: { lotId: id, weightMg: 9000, bulkType: 'RING', unitPriceFils: 30000 } }] as never }));
  reload();
  const lines2 = db.exec('SELECT id, bulk_weight_mg, bulk_cogs_fils FROM invoice_lines WHERE invoice_id = ?', [inv])[0].values;
  ok(lines2.length === 1 && lines2[0][0] !== lineId && Number(lines2[0][1]) === 9000 && Number(lines2[0][2]) === 18000, `I3 alte Zeile zurück, neue 9 g = 18.000 (${S(lines2)})`);
  ok(lot(id).remainingWeightMg === 1000 && lot(id).remainingValueFils === 2000 && lot(id).status === 'ACTIVE', 'I3 Lot 1.000 g / 2.000 ACTIVE');
  const kinds = moves(id).map((m) => m.kind);
  ok(S(kinds) === S(['PURCHASE', 'SALE', 'SALE_REVERSAL', 'SALE']), `I3 Bewegungen ${S(kinds)}`);
  ok(balancedInventory(db) && invOk(id), 'I4 INVENTORY = Σ Restwert, Invarianten');
}

// ══ J — Storno ohne/mit Zahlung, Löschen ═════════════════════════════════════
{
  const db = neu();
  const p = bulkKauf({ weight: '100', cost: '200' });
  const id = lotOfPurchase(db, p);
  const inv = verkauf([{ lotId: id, weight: '10', price: '50' }]);
  imHaus(() => cancelInvoiceInHouse({ invoiceId: inv, refundMethod: 'cash' }, 'branch-main'));
  reload();
  ok(lot(id).remainingWeightMg === 100000 && lot(id).remainingValueFils === 200000 && moves(id).at(-1)?.kind === 'SALE_REVERSAL', 'J1 Storno ohne Zahlung: exakt zurück (SALE_REVERSAL)');
  ok(ledgerOf(db, 'INVOICE', inv, 'COGS') === 0 && balancedInventory(db), 'J1 COGS gespiegelt, INVENTORY = Σ Restwert');
  const inv2 = verkauf([{ lotId: id, weight: '10', price: '50' }]);
  zahlen(db, inv2, 20);   // Teilzahlung → PARTIAL mit Geld
  imHaus(() => cancelInvoiceInHouse({ invoiceId: inv2, refundMethod: 'cash' }, 'branch-main'));
  reload();
  const k2 = moves(id).map((m) => m.kind);
  ok(lot(id).remainingWeightMg === 100000 && k2.at(-1) === 'RETURN' && k2.filter((k) => k === 'RETURN' || k === 'SALE_REVERSAL').length === 2,
    `J2 Storno mit Zahlung: über die Retoure genau einmal zurück (${S(k2)})`);
  ok(inventory(db) === 200 && balancedInventory(db) && invOk(id), 'J2 kein doppelter INVENTORY-Effekt');
  const inv3 = verkauf([{ lotId: id, weight: '30', price: '90' }]);
  imHaus(() => useInvoiceStore.getState().deleteInvoice(inv3));
  reload();
  const last = moves(id).at(-1)!;
  ok(lot(id).remainingWeightMg === 100000 && last.kind === 'SALE_REVERSAL' && last.sourceId === inv3 && !!last.sourceLineId, 'J3 Löschen: exakt zurück, Bewegung behält Rechnungs- und Zeilen-Id');
  ok(balancedInventory(db) && invOk(id), 'J3 INVENTORY = Σ Restwert');
}

// ══ K — Retoure und Retoure-Storno ═══════════════════════════════════════════
{
  const db = neu();
  const p = bulkKauf({ weight: '10', cost: '20' });
  const id = lotOfPurchase(db, p);
  const inv = verkauf([{ lotId: id, weight: '10', price: '30' }]);
  zahlen(db, inv);
  const line = lineOf(db, inv);
  ok(meldung(() => retoureBulk(db, inv, line, 0.5)).includes('BULK_RETURN_WHOLE_LINE_ONLY'), 'K1 Teilmenge 0.5 → Nein');
  ok(meldung(() => retoureBulk(db, inv, line, 1, 'WRITE_OFF')).includes('BULK_RETURN_DISPOSITION'), 'K1 Disposition WRITE_OFF → Nein');
  // Lot schließen ist nicht möglich (Rest 0) — Retoure in ein erschöpftes Lot
  const rid = retoureBulk(db, inv, line);
  ok(lot(id).remainingWeightMg === 10000 && lot(id).remainingValueFils === 20000 && lot(id).status === 'ACTIVE', 'K2 Retoure: exakt 10 g / 20.000 zurück, EXHAUSTED → ACTIVE');
  ok(ledgerOf(db, 'SALES_RETURN_COGS', rid, 'INVENTORY') === 20 && ledgerOf(db, 'SALES_RETURN_COGS', rid, 'COGS') === -20, 'K2 COGS-Rückbuchung = bulk_cogs_fils');
  ok(balancedInventory(db) && invOk(id), 'K2 INVENTORY = Σ Restwert');
  // Retoure-Storno
  imHaus(() => cancelReturnHouse.cancelReturnInHouse(rid, 'Irrtum', OWNER_ACTOR, 'branch-main'));
  reload();
  ok(lot(id).remainingWeightMg === 0 && lot(id).status === 'EXHAUSTED' && moves(id).at(-1)?.kind === 'RETURN_CANCEL', 'K3 Retoure-Storno: wieder heraus (RETURN_CANCEL), EXHAUSTED');
  ok(balancedInventory(db) && invOk(id), 'K3 INVENTORY = Σ Restwert');
  // Retoure → Ware wieder verkauft → Retoure-Storno = RESOLD
  const rid2 = retoureBulk(db, inv, line);
  verkauf([{ lotId: id, weight: '4', price: '10' }]);
  ok(meldung(() => imHaus(() => cancelReturnHouse.cancelReturnInHouse(rid2, 'x', OWNER_ACTOR, 'branch-main'))).includes('RETURN_STOCK_RESOLD'), 'K4 nach Weiterverkauf → RETURN_STOCK_RESOLD');
  // Retoure in ein GESCHLOSSENES Lot reaktiviert es
  const db2 = neu();
  const p2 = bulkKauf({ weight: '10', cost: '20' });
  const id2 = lotOfPurchase(db2, p2);
  const invB = verkauf([{ lotId: id2, weight: '4', price: '10' }]);
  zahlen(db2, invB);
  imHaus(() => lh.closeLotInHouse({ actionId: newAction(), lotId: id2, expectedRevision: lot(id2).revision, confirmWeightMg: 6000, confirmValueFils: 12000, reason: 'Rest' }, CTXB));
  ok(lot(id2).status === 'CLOSED', 'K5 Lot geschlossen');
  retoureBulk(db2, invB, lineOf(db2, invB));
  ok(lot(id2).status === 'ACTIVE' && lot(id2).closedAt === null && lot(id2).remainingWeightMg === 4000 && lot(id2).remainingValueFils === 8000, 'K5 Retoure in CLOSED-Lot → ACTIVE, closed_at leer, 4 g / 8.000');
  ok(balancedInventory(db2) && invOk(id2), 'K5 INVENTORY = Σ Restwert');
}

// ══ L — Spec 15 komplett: Einkauf, Ring, Necklace, Schwund, Retoure Ring, Händler, Close ══
{
  const db = neu();
  const p = bulkKauf({ weight: '500', cost: '1000', composition: COMP });
  const id = lotOfPurchase(db, p);
  const ring = verkauf([{ lotId: id, weight: '7', type: 'RING', price: '25' }]);
  zahlen(db, ring);
  verkauf([{ lotId: id, weight: '21.5', type: 'NECKLACE_CHAIN', price: '70' }]);
  imHaus(() => lh.writeOffInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, weightMg: 1200, reason: 'Nachwiegen, Waagendifferenz' }, CTXB));
  ok(lot(id).remainingWeightMg === 470300 && lot(id).remainingValueFils === 940600, 'L3 nach Schwund 470.300 g / 940.600');
  const rr = retoureBulk(db, ring, lineOf(db, ring));
  ok(lot(id).remainingWeightMg === 477300 && lot(id).remainingValueFils === 954600 && ledgerOf(db, 'SALES_RETURN_COGS', rr, 'INVENTORY') === 14, 'L4 Retoure Ring: 477.300 g / 954.600, COGS 14 zurück');
  const dealer = verkauf([{ lotId: id, weight: '475', type: 'BY_WEIGHT', price: '1000' }]);
  const ld = lineRow(db, lineOf(db, dealer));
  ok(Number(ld.bulk_cogs_fils) === 950000 && Number(ld.vat_amount) === 4.545 && ledgerOf(db, 'INVOICE', dealer, 'REVENUE') === -995.455, 'L5 Händler 475 g: COGS 950.000, MwSt 4.545, REVENUE 995.455');
  imHaus(() => lh.closeLotInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, confirmWeightMg: 2300, confirmValueFils: 4600, reason: 'Rest Abrieb' }, CTXB));
  ok(lot(id).status === 'CLOSED' && lot(id).remainingWeightMg === 0 && lot(id).remainingValueFils === 0, 'L6 Close: 0/0, CLOSED');
  ok(inventory(db) === 0 && accountBal(db, 'INVENTORY_LOSS') === 7 && accountBal(db, 'COGS') === 993, `L7 Abstimmung: INVENTORY 0, Verlust 7.000, COGS 993.000 (${accountBal(db, 'COGS')})`);
  const seq = moves(id).map((m) => `${m.seq}:${m.kind}`);
  ok(S(seq) === S(['1:PURCHASE', '2:SALE', '3:SALE', '4:WRITE_OFF', '5:RETURN', '6:SALE', '7:CLOSE']), `L7 Bewegungen ${S(seq)}`);
  ok(invOk(id), 'L7 Invarianten');
}

// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — Teil 3: Auskünfte, „Sold as", Abstimmung, Lagerwert, Ausblendungen, Sperren,
// Druck/NBR, PC2-Fernbefehle (Parität, verbotene Felder, Replay), Registry.
// ════════════════════════════════════════════════════════════════════════════
const reads = await import('../../src/core/bulk/bulk-reads.ts');
const { lotAggregatesFor } = await import('../../src/core/data/domain-reads.ts');
const analytics = await import('../../src/core/reports/analytics-snapshot.ts');
const { loadProductsFor } = await import('../../src/stores/productStore.ts');
const { isOwnStockAsset } = await import('../../src/core/lots/stock-metrics.ts');
const { isRepairableOwnProduct } = await import('../../src/core/repairs/repair-rules.ts');
const { assertProductsInBranch } = await import('../../src/core/stock/inventory-house.ts');
const { globalSearchFor } = await import('../../src/core/search/global-search.ts');
const { buildInvoiceA5Data } = await import('../../src/core/pdf/invoice-a5.ts');
const { buildMonthSheet } = await import('../../src/core/tax/nbr-export.ts');
const cmdC = await import('../../src/core/bridge/commercial-commands.ts');
const cmdI = await import('../../src/core/bridge/invoice-command.ts');
const cmdIL = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const cmdR = await import('../../src/core/bridge/return-commands.ts');
const cmdSR = await import('../../src/core/bridge/sales-reversal-commands.ts');
const cmdB = await import('../../src/core/bridge/bulk-metal-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');

const RCTX = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const reconOk = (): boolean => {
  const r = reads.bulkLedgerReconciliation('branch-main');
  if (!r.ok) console.log(`    Abstimmung: Lots ${r.lotsValueFils} vs Hauptbuch ${r.ledgerValueFils}`);
  return r.ok;
};

// ══ M — Auskünfte, „Sold as", Abstimmung nach jedem Schritt ══════════════════
{
  const db = neu();
  const p = bulkKauf({ weight: '500', cost: '1000', composition: COMP });
  const id = lotOfPurchase(db, p);
  let allOk = reconOk();
  const ring = verkauf([{ lotId: id, weight: '7', type: 'RING', price: '25' }]); allOk = allOk && reconOk();
  zahlen(db, ring);
  const neck = verkauf([{ lotId: id, weight: '21.5', type: 'NECKLACE_CHAIN', price: '70' }]); allOk = allOk && reconOk();
  const sold = (): Record<string, number> => Object.fromEntries(reads.soldAsFor(id).map((x) => [x.bulkType, x.soldMg]));
  ok(S(sold()) === S({ NECKLACE_CHAIN: 21500, RING: 7000 }), `M1 Sold as nach zwei Verkäufen ${S(sold())}`);
  const rr = retoureBulk(db, ring, lineOf(db, ring)); allOk = allOk && reconOk();
  ok(S(sold()) === S({ NECKLACE_CHAIN: 21500 }), 'M2 retournierter Ring zählt nicht');
  imHaus(() => cancelReturnHouse.cancelReturnInHouse(rr, 'Irrtum', OWNER_ACTOR, 'branch-main')); reload(); allOk = allOk && reconOk();
  ok(S(sold()) === S({ NECKLACE_CHAIN: 21500, RING: 7000 }), 'M3 Retoure storniert → Ring wieder in der Statistik');
  imHaus(() => useInvoiceStore.getState().editInvoice(neck, { reason: 'Typ', lines: [{ lineId: lineOf(db, neck), productId: 'bulk-silver-925-branch-main', unitPrice: 0, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 0,
    bulkIntent: { lotId: id, weightMg: 21500, bulkType: 'PENDANT', unitPriceFils: 70000 } }] as never })); reload(); allOk = allOk && reconOk();
  ok(S(sold()) === S({ PENDANT: 21500, RING: 7000 }), 'M4 Typänderung wirkt rückwirkend auf Sold as');
  imHaus(() => cancelInvoiceInHouse({ invoiceId: neck, refundMethod: 'cash' }, 'branch-main')); reload(); allOk = allOk && reconOk();
  ok(S(sold()) === S({ RING: 7000 }), 'M5 stornierte Rechnung zählt nicht');
  const del = verkauf([{ lotId: id, weight: '3', type: 'EARRINGS', price: '9' }]); allOk = allOk && reconOk();
  imHaus(() => useInvoiceStore.getState().deleteInvoice(del)); reload(); allOk = allOk && reconOk();
  ok(S(sold()) === S({ RING: 7000 }), 'M6 gelöschte Rechnung zählt nicht');
  const net = -moves(id).filter((m) => ['SALE', 'SALE_REVERSAL', 'RETURN', 'RETURN_CANCEL'].includes(m.kind)).reduce((s0, m) => s0 + m.weightMg, 0);
  ok(net === 7000, `M7 Invariante 9: Σ Sold as = Netto-Verkauf aus Bewegungen (${net})`);
  imHaus(() => lh.writeOffInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, weightMg: 1200, reason: 'x' }, CTXB)); allOk = allOk && reconOk();
  imHaus(() => lh.reverseAdjustmentInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, movementId: moves(id).at(-1)!.id, reason: 'x' }, CTXB)); allOk = allOk && reconOk();
  const p2 = bulkKauf({ metal: 'gold', fineness: '18K', weight: '50', cost: '1500', vat: true }); allOk = allOk && reconOk();
  imHaus(() => life.cancelPurchaseInHouse(p2, 'branch-main')); allOk = allOk && reconOk();
  ok(allOk, 'M8 Abstimmung Σ Restwert = Bulk-INVENTORY nach JEDEM Schritt (Verkauf, Retoure, Storno, Edit, Löschen, Write-off, Stornierung, VAT_10-Einkauf, Einkaufsstorno)');
  const page = reads.bulkMetalsPageFor(RCTX);
  ok(page.articles.length === 2 && page.totalValueFils === bulkValueFils(db) && page.reconciliation.ok, `M9 Seite: 2 Artikel, Gesamtwert = Σ Restwert (${page.totalValueFils})`);
  const detail = reads.bulkLotDetailFor(RCTX, id)!;
  ok(detail.movements.length === moves(id).length && detail.sales.length === 2 && detail.lot.composition.length === 5, 'M10 Lot-Detail: Verlauf, Verkäufe, Composition');
  ok(detail.movements.some((m) => m.document === 'deleted invoice'), 'M10 …gelöschte Rechnung im Verlauf benannt');
  const forSale = reads.bulkLotsForSaleFor(RCTX);
  ok(forSale.length === 1 && forSale[0].lotId === id, 'M11 Lot-Auswahl: nur aktive Lots mit Rest');
  const prev = reads.bulkAllocationPreviewFor(RCTX, id, 5000);
  ok(prev.cogsFils === bm.allocateFils(lot(id).remainingValueFils, lot(id).remainingWeightMg, 5000), 'M12 Vorschau = Zuteilung');
  ok(reads.bulkInventoryValuation('branch-main').valueFils === bulkValueFils(db), 'M13 Bewertung = Σ Restwert');
}

// ══ N — Lagerwert genau einmal, nie als Stück; Verlustzeile ══════════════════
{
  const db = neu();
  product(db, 'p-w', 300, 2);   // zwei Stück ohne Los zu 300
  const p = bulkKauf({ weight: '100', cost: '200' });
  const id = lotOfPurchase(db, p);
  imHaus(() => lh.writeOffInHouse({ actionId: newAction(), lotId: id, expectedRevision: lot(id).revision, weightMg: 10000, reason: 'Schwund' }, CTXB));
  const st = analytics.stockFor(RCTX)!;
  ok(r3(st.totalEK) === r3(600 + 180) && st.totalItems === 2 && r3(st.bulkValue) === 180, `N1 Analytics: Wert 600 + Bulk 180, Stück 2 (${st.totalEK}/${st.totalItems})`);
  ok(st.byCat.some((c) => c.name.startsWith('Bulk metal') && r3(c.value) === 180 && c.cnt === 0), 'N1 eigene Zeile „Bulk metal", 0 Stück');
  const sa = analytics.salesFor(RCTX)!;
  ok(r3(sa.bulkInventoryLoss) === 20 && r3(sa.profitAfterInventoryLoss) === r3(sa.totalProfit - 20), 'N2 Verlustzeile 20.000, Gewinn danach abgezogen');
  const agg = lotAggregatesFor(RCTX);
  ok(agg.bulkValueFils === 180000 && (agg.bulkLossByDay ?? []).reduce((s0, [, v]) => s0 + v, 0) === 20000, 'N3 Lot-Zahlen tragen Bulk-Wert und Tagesverluste (Dashboard/Reports, auch PC2)');
  ok(!agg.paare.some(([pid]) => pid.startsWith('bulk-')), 'N3 keine Bulk-Paare in den Stück-Aggregaten');
  ok(loadProductsFor(RCTX).products.every((x) => !x.id.startsWith('bulk-')), 'N4 Artikelliste (Collection, Auswahlen, Dubletten, Import, KI) ohne Systemartikel');
  ok(!isOwnStockAsset({ id: 'bulk-silver-925-branch-main', stockStatus: 'in_stock', sourceType: 'OWN' }), 'N4 Systemartikel ist kein Stück-Asset');
}

// ══ O — Ausblenden und Sperren ═══════════════════════════════════════════════
{
  const db = neu();
  bulkKauf({ weight: '10', cost: '20' });
  const BID = 'bulk-silver-925-branch-main';
  ok(meldung(() => useProductStore.getState().updateProduct(BID, { name: 'x' } as never)).startsWith('BULK_SYSTEM_PRODUCT_LOCKED'), 'O1 updateProduct gesperrt');
  ok(meldung(() => useProductStore.getState().deleteProduct(BID)).startsWith('BULK_SYSTEM_PRODUCT_LOCKED'), 'O1 deleteProduct gesperrt');
  ok(useProductStore.getState().deleteProducts([BID]).blocked.some((b) => b.id === BID), 'O1 deleteProducts blockiert');
  ok(meldung(() => useProductStore.getState().updateCategory('cat-bulk-metal-branch-main', { name: 'x' } as never)).startsWith('BULK_SYSTEM_PRODUCT_LOCKED'), 'O1 Kategorie gesperrt');
  ok(n(db, `SELECT COUNT(*) FROM products WHERE id = ? AND sku IS NULL`, [BID]) === 1, 'O2 sku = NULL');
  ok(!isRepairableOwnProduct({ id: BID, sourceType: 'OWN' }), 'O3 keine Reparatur am Systemartikel');
  ok(meldung(() => assertProductsInBranch(db as never, 'branch-main', [BID])).includes('not an item of this branch'), 'O3 Inventur weist den Systemartikel ab');
  const gs = globalSearchFor(RCTX as never, { q: 'Silver' } as never);
  ok(!S(gs).includes(BID), 'O3 globale Suche ohne Systemartikel');
  ok((await meldungAsync(() => imHausAsync(() => createProductionInHouse({ inputProductIds: [BID], outputs: [] } as never, CTX as never)))).includes('BULK_NOT_SUPPORTED_HERE'), 'O3 Produktion mit Bulk → BULK_NOT_SUPPORTED_HERE');
  const files: Array<[string, RegExp]> = [
    ['src/core/offers/offer-house.ts', /bulk-'\)\) throw new OfferRejected\('BULK_NOT_SUPPORTED_HERE'/],
    ['src/core/orders/order-house.ts', /id NOT LIKE 'bulk-%'/],
    ['src/core/agents/transfer-house.ts', /id NOT LIKE 'bulk-%'/],
    ['src/core/repairs/repair-house.ts', /id NOT LIKE 'bulk-%'/],
    ['src/core/production/production-house.ts', /BULK_NOT_SUPPORTED_HERE/],
    ['src/core/bridge/read-commands.ts', /id NOT LIKE 'bulk-%'[\s\S]*id NOT LIKE 'bulk-%'[\s\S]*id NOT LIKE 'bulk-%'/],
    ['src/core/bridge/product-commands.ts', /BULK_SYSTEM_PRODUCT_LOCKED/],
    ['src-tauri/src/sync/product_query.rs', /WHERE p\.branch_id = \?2 AND p\.id NOT LIKE 'bulk-%'/],
    ['src-tauri/src/sync/stock_check.rs', /AND p\.id NOT LIKE 'bulk-%'/],
    ['src/core/purchases/purchase-house.ts', /NOT LIKE 'cat-bulk-metal%' AND id NOT LIKE 'bulk-%'/],
  ];
  for (const [f, re] of files) ok(re.test(src(f)), `O4 Ausschluss/Gate in ${f}`);
}

// ══ P — Druck und NBR: Beschreibung mit Gewicht, nie Lot/COGS/SKU ════════════
{
  const db = neu();
  const pm = bulkKauf({ weight: '100', cost: '200' });
  const pv = bulkKauf({ metal: 'silver', fineness: '999', weight: '100', cost: '220', vat: true });
  const invM = verkauf([{ lotId: lotOfPurchase(db, pm), weight: '7', price: '25' }]);
  const invV = verkauf([{ lotId: lotOfPurchase(db, pv), weight: '7', price: '25' }]);
  zahlen(db, invM); zahlen(db, invV);
  const inv = useInvoiceStore.getState().invoices.find((i) => i.id === invM)!;
  const a5 = buildInvoiceA5Data({ company: {} as never, invoice: { number: inv.invoiceNumber, status: inv.status, issuedAt: inv.issuedAt, grossAmount: inv.grossAmount, paidAmount: inv.paidAmount, lines: inv.lines }, customer: null, products: useProductStore.getState().products, paymentMethods: [] } as never);
  const out = S(a5);
  ok(a5.lines[0].description === 'Ring · Silver 925 · 7.000 g' && a5.lines[0].sku === '' && a5.lines[0].qty === 1, `D1 A5: Beschreibung, keine SKU, 1 pcs (${S(a5.lines[0])})`);
  ok(!/BM-\d/.test(out) && !out.includes('14000') && !out.includes('bulk-'), 'D1 A5 enthält weder Lot-Nummer noch COGS noch Systemartikel');
  const invoices = useInvoiceStore.getState().invoices.filter((i) => i.id === invM || i.id === invV);
  const sheet = buildMonthSheet({ year: 2026, month: new Date(invoices[0].issuedAt ?? NOW).getMonth(), invoices } as never, useCustomerStore.getState().customers, useProductStore.getState().products);
  const rows = sheet.filter((r) => Array.isArray(r) && r.includes('Ring · Silver 999 · 7.000 g'));
  ok(rows.length === 1 && rows[0].includes(25) && rows[0].includes(2.5) && rows[0].includes(27.5), `N2 NBR VAT_10: netto 25 / MwSt 2.5 / brutto 27.5 (${S(rows[0])})`);
  ok(!/BM-\d|bulk-|14\.000|14000/.test(S(sheet)), 'N2 NBR ohne Lot/COGS/Systemartikel');
  // NBR-Margenblatt (bestehendes Format): Einkauf = zugeteilter COGS der Zeile, Verkauf, Marge, MwSt auf Marge.
  const mRow = sheet.find((r) => Array.isArray(r) && r.includes('Ring · Silver 925 · 7.000 g')) as Array<unknown> | undefined;
  ok(!!mRow && mRow[7] === 14 && mRow[8] === 25 && mRow[9] === 11 && mRow[10] === 1 && mRow[11] === 10,
    `N1 NBR MARGIN: Einkauf 14 / Verkauf 25 / Marge 11 / MwSt 1 / exkl. 10 (${S(mRow)})`);
}

// ══ Q — PC2: Fernbefehle, Parität, verbotene Felder, Replay ══════════════════
const XID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000bb`;
const ident = (x: string, op: string, role = 'ADMIN', hash = 'h' + x) => ({ commandId: XID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role, op, payloadHash: hash });
const dps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
const okv = <T>(o: unknown): T => (o as { value: T }).value;

/** Projektion für die Paritätsprüfung (ohne Kennungen/Zeiten). */
function projection(db: Db): string {
  const q = (sql: string) => db.exec(sql)[0]?.values ?? [];
  return S({
    lots: q(`SELECT lot_no, metal_type, fineness, original_weight_mg, remaining_weight_mg, original_value_fils, remaining_value_fils, sale_tax_scheme, status, composition_json FROM stock_lots WHERE unit = 'mg' ORDER BY lot_no`),
    moves: q(`SELECT l.lot_no, m.seq, m.kind, m.weight_mg, m.value_fils, m.weight_after_mg, m.value_after_fils, m.bulk_type, m.reason FROM bulk_lot_movements m JOIN stock_lots l ON l.id = m.lot_id ORDER BY l.lot_no, m.seq`),
    lines: q(`SELECT quantity, unit_price, purchase_price_snapshot, tax_scheme, vat_amount, line_total, bulk_weight_mg, bulk_cogs_fils, bulk_type, description FROM invoice_lines WHERE bulk_weight_mg IS NOT NULL ORDER BY bulk_weight_mg, unit_price`),
    ledger: q(`SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) FROM ledger_entries GROUP BY account ORDER BY account`),
  });
}

{
  // — lokal —
  const dbL = neu();
  const pL = bulkKauf({ weight: '500', cost: '1000', composition: COMP });
  const lotL = lotOfPurchase(dbL, pL);
  const iL = verkauf([{ lotId: lotL, weight: '7', type: 'RING', price: '25' }]);
  imHaus(() => useInvoiceStore.getState().editInvoice(iL, { reason: 'Preis', lines: [{ lineId: lineOf(dbL, iL), productId: 'bulk-silver-925-branch-main', unitPrice: 0, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 0,
    bulkIntent: { lotId: lotL, weightMg: 7000, bulkType: 'RING', unitPriceFils: 30000 } }] as never })); reload();
  zahlen(dbL, iL);
  const rL = retoureBulk(dbL, iL, lineOf(dbL, iL));
  imHaus(() => cancelReturnHouse.cancelReturnInHouse(rL, 'Irrtum', OWNER_ACTOR, 'branch-main')); reload();
  imHaus(() => lh.writeOffInHouse({ actionId: 'local-wo-1-xxxx', lotId: lotL, expectedRevision: lot(lotL).revision, weightMg: 1200, reason: 'Waage' }, CTXB));
  imHaus(() => lh.closeLotInHouse({ actionId: 'local-cl-1-xxxx', lotId: lotL, expectedRevision: lot(lotL).revision, confirmWeightMg: lot(lotL).remainingWeightMg, confirmValueFils: lot(lotL).remainingValueFils, reason: 'Rest' }, CTXB));
  imHaus(() => lh.reverseAdjustmentInHouse({ actionId: 'local-rv-1-xxxx', lotId: lotL, expectedRevision: lot(lotL).revision, movementId: moves(lotL).at(-1)!.id, reason: 'falsch' }, CTXB));
  const projL = projection(dbL);

  // — fern —
  const dbR = neu();
  const d = dps(dbR);
  const pr = await cmdC.runPurchaseCreate(d, ident('1', 'purchases.create'), { ...bulkKaufInput([{ weight: '500', cost: '1000', composition: COMP }]), purchaseDate: PDATE });
  ok(pr.kind === 'ok', `Q1 Einkauf fern (${S(pr)})`);
  reload();
  const lotR = s(dbR, "SELECT id FROM stock_lots WHERE unit = 'mg'");
  const tryRun = async (f: () => Promise<unknown>): Promise<unknown> => { try { return await f(); } catch (e) { return e; } };
  const bad = await tryRun(() => cmdI.runInvoiceCreate(d, ident('2', 'invoices.create'), { customerId: 'cust-1', lines: [{ kind: 'bulk', bulkLotId: lotR, weightMg: 7000, bulkType: 'RING', unitPriceFils: 25000, taxScheme: 'ZERO' }] }));
  ok(String((bad as Error).message ?? S(bad)).includes('the primary decides taxScheme'), 'Q2 verbotenes Feld taxScheme in der Bulk-Zeile → Nein');
  const bad2 = await tryRun(() => cmdI.runInvoiceCreate(d, ident('3', 'invoices.create'), { customerId: 'cust-1', lines: [{ kind: 'bulk', bulkLotId: lotR, weightMg: 7000, bulkType: 'RING', unitPriceFils: 25000, bulkCogsFils: 1 }] }));
  ok(String((bad2 as Error).message ?? S(bad2)).includes('unknown field in bulk line'), 'Q2 bulkCogsFils vom Client → Nein');
  const bad3 = await tryRun(() => cmdI.runInvoiceCreate(d, ident('4', 'invoices.create'), { customerId: 'cust-1', lines: [{ kind: 'bulk', bulkLotId: lotR, weightMg: 7.5, bulkType: 'RING', unitPriceFils: 25000 }] }));
  ok(String((bad3 as Error).message ?? S(bad3)).includes('whole number of milligrams'), 'Q2 Gewicht keine ganze mg-Zahl → Nein');
  const ir = await cmdI.runInvoiceCreate(d, ident('5', 'invoices.create'), { customerId: 'cust-1', lines: [{ kind: 'bulk', bulkLotId: lotR, weightMg: 7000, bulkType: 'RING', unitPriceFils: 25000 }] });
  ok(ir.kind === 'ok', `Q3 Verkauf fern (${S(ir)})`);
  reload();
  const iR = okv<{ invoiceId: string }>(ir).invoiceId;
  const rev = (id0: string): number => n(dbR, 'SELECT revision FROM invoices WHERE id = ?', [id0]);
  const lockErr = await cmdIL.runInvoiceUpdate(d, ident('6', 'invoices.update'), { id: iR, expectedRevision: rev(iR), reason: 'x',
    customerId: 'cust-1', lines: [{ kind: 'bulk', lineId: lineOf(dbR, iR), bulkLotId: lotR, weightMg: 6000, bulkType: 'RING', unitPriceFils: 25000 }] });
  ok(lockErr.kind === 'rejected' && (lockErr as { code: string }).code === 'BULK_LINE_FIELDS_LOCKED', `Q4 Gewicht ändern fern → gesperrt (${S(lockErr)})`);
  const up = await cmdIL.runInvoiceUpdate(d, ident('7', 'invoices.update'), { id: iR, expectedRevision: rev(iR), reason: 'Preis',
    customerId: 'cust-1', lines: [{ kind: 'bulk', lineId: lineOf(dbR, iR), bulkLotId: lotR, weightMg: 7000, bulkType: 'RING', unitPriceFils: 30000 }] });
  ok(up.kind === 'ok', `Q4 Preis ändern fern (${S(up)})`);
  reload();
  zahlen(dbR, iR);
  const half = await cmdR.runCreateReturn(d, ident('8', 'returns.create'), { invoiceId: iR, expectedRevision: rev(iR), lines: [{ invoiceLineId: lineOf(dbR, iR), quantity: 0.5 }], refundMethod: 'cash', refundNow: true });
  ok(half.kind === 'rejected' && (half as { code: string }).code === 'BULK_RETURN_WHOLE_LINE_ONLY', `Q5 Teil-Retoure fern → Nein (${S(half)})`);
  const rr = await cmdR.runCreateReturn(d, ident('9', 'returns.create'), { invoiceId: iR, expectedRevision: rev(iR), lines: [{ invoiceLineId: lineOf(dbR, iR), quantity: 1 }], refundMethod: 'cash', refundNow: false });
  ok(rr.kind === 'ok', `Q5 Retoure fern (${S(rr)})`);
  reload();
  const rid = s(dbR, 'SELECT id FROM sales_returns ORDER BY created_at DESC LIMIT 1');
  const rc = await cmdSR.runReturnCancel(d, ident('10', 'returns.cancel'), { returnId: rid, reason: 'Irrtum', expectedRevision: n(dbR, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]) });
  ok(rc.kind === 'ok', `Q6 Retoure-Storno fern (${S(rc)})`);
  reload();
  // manuelle Aktionen fern
  const wbBad = await tryRun(() => cmdB.runBulkAction(lh.writeOffInHouse as never, ['actionId', 'lotId', 'expectedRevision', 'weightMg', 'reason', 'businessDate'], d,
    ident('11', 'bulk_metals.write_off'), 'ADMIN', { actionId: 'local-wo-1-xxxx', lotId: lotR, expectedRevision: lot(lotR).revision, weightMg: 1200, reason: 'Waage', valueFils: 1 }));
  ok(String((wbBad as Error).message).includes('unknown field: valueFils'), 'Q7 valueFils vom Client → Nein');
  const sales = await cmdB.runBulkAction(lh.writeOffInHouse as never, ['actionId', 'lotId', 'expectedRevision', 'weightMg', 'reason', 'businessDate'], d,
    ident('12', 'bulk_metals.write_off'), 'SALES', { actionId: 'sales-wo-1-xxxx', lotId: lotR, expectedRevision: lot(lotR).revision, weightMg: 1200, reason: 'Waage' });
  ok(sales.kind === 'rejected' && (sales as { code: string }).code === 'PERMISSION_DENIED', 'Q7 SALES darf nicht abschreiben');
  const WO = ['actionId', 'lotId', 'expectedRevision', 'weightMg', 'reason', 'businessDate'];
  const body = { actionId: 'local-wo-1-xxxx', lotId: lotR, expectedRevision: lot(lotR).revision, weightMg: 1200, reason: 'Waage' };
  const w1 = await cmdB.runBulkAction(lh.writeOffInHouse as never, WO, d, ident('13', 'bulk_metals.write_off'), 'ADMIN', body);
  const w2 = await cmdB.runBulkAction(lh.writeOffInHouse as never, WO, d, ident('13', 'bulk_metals.write_off'), 'ADMIN', body);
  const w3 = await cmdB.runBulkAction(lh.writeOffInHouse as never, WO, d, ident('14', 'bulk_metals.write_off'), 'ADMIN', body);
  ok(w1.kind === 'ok' && w2.kind === 'ok' && (w2 as { replayed: boolean }).replayed && S(okv(w1)) === S(okv(w2)), 'Q8 gleiche command_id → eingefrorene Antwort (replayed)');
  ok(w3.kind === 'ok' && S(okv(w1)) === S(okv(w3)) && moves(lotR).filter((m) => m.kind === 'WRITE_OFF').length === 1, 'Q8 neue command_id + gleiche action_id → identische Antwort, eine Bewegung');
  const CL = ['actionId', 'lotId', 'expectedRevision', 'confirmWeightMg', 'confirmValueFils', 'reason', 'businessDate'];
  const c1 = await cmdB.runBulkAction(lh.closeLotInHouse as never, CL, d, ident('15', 'bulk_metals.close_lot'), 'MANAGER',
    { actionId: 'local-cl-1-xxxx', lotId: lotR, expectedRevision: lot(lotR).revision, confirmWeightMg: lot(lotR).remainingWeightMg, confirmValueFils: lot(lotR).remainingValueFils, reason: 'Rest' });
  ok(c1.kind === 'ok', `Q9 Close fern (MANAGER) (${S(c1)})`);
  const RV = ['actionId', 'lotId', 'expectedRevision', 'movementId', 'reason'];
  const rvM = await cmdB.runBulkAction(lh.reverseAdjustmentInHouse as never, RV, d, ident('16', 'bulk_metals.reverse_adjustment'), 'MANAGER',
    { actionId: 'mgr-rv-1-xxxxxx', lotId: lotR, expectedRevision: lot(lotR).revision, movementId: moves(lotR).at(-1)!.id, reason: 'falsch' });
  ok(rvM.kind === 'rejected' && (rvM as { code: string }).code === 'PERMISSION_DENIED', 'Q9 MANAGER darf nicht stornieren');
  const rv = await cmdB.runBulkAction(lh.reverseAdjustmentInHouse as never, RV, d, ident('17', 'bulk_metals.reverse_adjustment'), 'ADMIN',
    { actionId: 'local-rv-1-xxxx', lotId: lotR, expectedRevision: lot(lotR).revision, movementId: moves(lotR).at(-1)!.id, reason: 'falsch' });
  ok(rv.kind === 'ok', `Q9 Stornieren fern (ADMIN) (${S(rv)})`);
  const projR = projection(dbR);
  ok(projR === projL, 'X1 Parität: Einkauf, Verkauf, Edit, Retoure, Retoure-Storno, Write-off, Close, Stornieren fern = lokal (Lots, Bewegungen, Zeilen, Hauptbuch)');
  if (projR !== projL) { console.log('    lokal:', projL.slice(0, 600)); console.log('    fern: ', projR.slice(0, 600)); }
  ok(reconOk() && invOk(lotR), 'X1 Abstimmung und Invarianten nach dem Fernlauf');
  // Lot-Nummern: erster Einkauf fern, zweiter am Primary → BM-0001, BM-0002
  bulkKauf({ weight: '1', cost: '1' });
  const nos = dbR.exec("SELECT lot_no FROM stock_lots WHERE unit = 'mg' ORDER BY lot_no")[0].values.map((v) => v[0]);
  ok(S(nos) === S(['BM-0001', 'BM-0002']), `B1 Nummern PC2 dann Primary: ${S(nos)}`);
}

// ══ R — Registry, Rechte, Lesebefehle ═══════════════════════════════════════
{
  const am = registry.ALLOWED_MUTATIONS;
  ok(S(am.slice(-4)) === S(['bulk_metals.write_off', 'bulk_metals.close_lot', 'bulk_metals.correct_weight', 'bulk_metals.reverse_adjustment']), 'X4 vier Mutationen am Ende der Liste');
  ok(perms.OPERATION_PERMISSIONS['bulk_metals.write_off']?.kind === 'isAdmin' && perms.OPERATION_PERMISSIONS['bulk_metals.close_lot']?.kind === 'isAdmin'
    && perms.OPERATION_PERMISSIONS['bulk_metals.correct_weight']?.kind === 'isAdmin' && perms.OPERATION_PERMISSIONS['bulk_metals.reverse_adjustment']?.kind === 'isOwner', 'X3 Rechte: isAdmin ×3, isOwner ×1');
  const ro = readOps.STORE_READ_OPS;
  ok(['page.bulk_metals.get', 'bulk_metals.lots_for_sale.get', 'bulk_metals.lot_detail.get', 'bulk_metals.allocation_preview.get'].every((x) => ro.includes(x)), 'X4 vier Lesebefehle freigegeben');
  const rust = src('src-tauri/src/bridge.rs');
  const ops = [...am.slice(-4), 'page.bulk_metals.get', 'bulk_metals.lots_for_sale.get', 'bulk_metals.lot_detail.get', 'bulk_metals.allocation_preview.get'];
  ok(ops.every((x) => rust.includes(`"${x}"`)), 'X4 Rust kennt alle acht');
  const remoteOps = (rust.split('pub const REMOTE_OPS')[1] ?? '').split('];')[0].match(/OP_[A-Z0-9_]+/g) ?? [];
  ok(remoteOps.length === 192, `X4 REMOTE_OPS = 192 (${remoteOps.length})`);
}

console.log(`
bulk-metal: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
