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

console.log(`
bulk-metal: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
