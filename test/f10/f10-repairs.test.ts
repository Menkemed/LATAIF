// ════════════════════════════════════════════════════════════════════════════
// F10 — Reparaturen nach dem alten Start-Fehler: ein fälschlich geschlossenes Edelmetall-Los wieder öffnen, Gold-Schmuck
// „New" belegt wiederherstellen, und die Gold-Umstellung nur noch einmal je Datenbank. Nur künstliche Testdaten.
// Gerüst wie test/bulk-metal/bulk-metal.test.ts (echte sql.js-Datenbank, echte Migrationen, Stores, Hausfolgen, Hauptbuch).
// Run: node test/f10/f10-repairs.test.ts
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
// F10 — die belegten Reparaturen nach dem alten Start-Fehler (Silber-Los, Gold-Zustand), nur ausdrücklich ausgelöst.
// ════════════════════════════════════════════════════════════════════════════
const bm = await import('../../src/core/bulk/bulk-math.ts');
const lh = await import('../../src/core/bulk/bulk-lot-house.ts') as Record<string, any>;
const ba = await import('../../src/core/bulk/bulk-actions.ts') as Record<string, any>;
const reads = await import('../../src/core/bulk/bulk-reads.ts');
const { createPurchaseDetailedInHouse } = await import('../../src/core/purchases/purchase-house.ts');
const { createInvoiceInHouse } = await import('../../src/core/invoices/invoice-create-house.ts');
const { LEGACY_STOCK_REPAIRS, runLegacyStockRepairsOnce, hasStockLotsTable } = await import('../../src/core/db/legacy-stock-repair.ts');
// Im alten Code (Gegenprobe) gibt es die neuen Module nicht — dort steht die Gold-Umstellung im Startblock.
const goldMig = await import('../../src/core/db/legacy-gold-condition.ts').catch(() => null) as null | Record<string, any>;
const goldRes = await import('../../src/core/products/gold-condition-restore.ts').catch(() => null) as null | Record<string, any>;

const PDATE = '2026-10-07';
let seqA = 0;
const newAction = (): string => `f10-action-${++seqA}-xxxxxxxx`;
function bulkKauf(weight: string, cost: string): string {
  const weightMg = bm.parseGramsToMg(weight);
  const lineTotalFils = bm.parseBhdToFils(cost);
  const r = imHaus(() => createPurchaseDetailedInHouse({
    supplierId: 'sup-1', purchaseDate: PDATE, taxScheme: 'ZERO', paymentAmount: 0, paymentMethod: 'cash', notes: '', staffId: '',
    lines: [{ mode: 'bulk', brand: '', name: '', sku: '', categoryId: '', quantity: 1, unitPrice: lineTotalFils / 1000,
      bulk: { metal: 'silver', fineness: '925', weightMg, lineTotalFils, saleTaxScheme: 'MARGIN' } }],
  } as never, 'branch-main', 'user-test'));
  reload();
  return r.purchase.id;
}
const lotOf = (db: Db, pid: string): string => s(db, "SELECT id FROM stock_lots WHERE purchase_id = ? AND unit = 'mg'", [pid]);
function verkaufe(lotId: string, weight: string, price = '100'): string {
  const r = imHaus(() => createInvoiceInHouse({ customerId: 'cust-1', specialMark: false,
    lines: [{ bulkIntent: { lotId, weightMg: bm.parseGramsToMg(weight), bulkType: 'RING', unitPriceFils: bm.parseBhdToFils(price, true) } }] as never }, 'branch-main'));
  reload();
  return r.invoiceId;
}
/** Der F10-Schaden, wie v0.8.80 ihn bei jedem Start anrichtete: Schritt 2 der Altkorrektur OHNE die Edelmetall-Ausnahme. */
const ALT_SCHRITT_2 = LEGACY_STOCK_REPAIRS[6].replace(/\s+AND COALESCE\(unit, 'pcs'\) = 'pcs'/, '');
const altStart = (db: Db): void => { db.run(ALT_SCHRITT_2); reload(); };
/** Was eine Reparatur nicht verändern darf: Gewicht, Wert, Stückfelder, Bewegungen, Hauptbuch, Einkauf. */
const fest = (db: Db, lotId: string): string => S({
  lot: db.exec(`SELECT remaining_weight_mg, remaining_value_fils, original_weight_mg, original_value_fils, qty_total, qty_remaining, unit_cost,
    purchase_id, closed_at, composition_json FROM stock_lots WHERE id = ?`, [lotId])[0]?.values,
  moves: db.exec('SELECT * FROM bulk_lot_movements WHERE lot_id = ? ORDER BY seq', [lotId])[0]?.values,
  ledger: db.exec('SELECT * FROM ledger_entries ORDER BY id')[0]?.values,
  purchases: db.exec('SELECT * FROM purchases ORDER BY id')[0]?.values,
});
const status = (db: Db, lotId: string): string => s(db, 'SELECT status FROM stock_lots WHERE id = ?', [lotId]);
const changelog = (db: Db): number => n(db, 'SELECT COUNT(*) FROM sync_changelog');
const audits = (db: Db): number => n(db, 'SELECT COUNT(*) FROM audit_log');
/** Alles in der Datenbank, was eine abgewiesene oder zurückgerollte Reparatur nicht verändern darf. */
const alles = (db: Db): string => S({
  lots: db.exec('SELECT * FROM stock_lots ORDER BY id')[0]?.values, p: db.exec('SELECT * FROM products ORDER BY id')[0]?.values,
  moves: db.exec('SELECT * FROM bulk_lot_movements ORDER BY id')[0]?.values, ledger: db.exec('SELECT * FROM ledger_entries ORDER BY id')[0]?.values,
  log: changelog(db), audit: audits(db),
});
const reopenInput = (lotId: string, over: Record<string, unknown> = {}) => {
  const l = lh.getBulkLot(lotId);
  return { actionId: newAction(), lotId, purchaseId: l.purchaseId, expectedRevision: l.revision,
    confirmWeightMg: l.remainingWeightMg, confirmValueFils: l.remainingValueFils, reason: 'F10: wrongly closed at start-up', ...over };
};
/** Über den Anschluss der Maske (runOnPrimary): '' oder der Code. Gegenprobe: der alte Code hat keinen Anschluss. */
async function reopen(lotId: string, over: Record<string, unknown> = {}): Promise<string> {
  if (!ba.reopenWronglyClosedLotOnPrimary) return 'KEIN_ANSCHLUSS';
  try { await ba.reopenWronglyClosedLotOnPrimary(reopenInput(lotId, over), reload); return ''; }
  catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
const rolle = (role: string): void => { useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never }); };
const bewiesen = (): string[] => ((reads as Record<string, any>).wronglyClosedBulkLotRows ? (reads as Record<string, any>).wronglyClosedBulkLotRows('branch-main') : []).map((l: { id: string }) => l.id);

// ══ S1 — fälschlich geschlossenes Silber-Los (nur Einkauf): wieder ACTIVE, sonst nichts ═══════════════════════
{
  const db = freshDb();
  const lot = lotOf(db, bulkKauf('2477', '870'));
  const anderes = lotOf(db, bulkKauf('50', '20'));
  verkaufe(anderes, '50');   // ein zweites Los, wirklich aufgebraucht — es bleibt, wie es ist
  ok(status(db, lot) === 'ACTIVE' && status(db, anderes) === 'EXHAUSTED', 'S1 (Vorbereitung) Einkauf legt das Los ACTIVE an; das zweite ist verkauft');
  altStart(db);
  ok(status(db, lot) === 'EXHAUSTED' && n(db, 'SELECT remaining_weight_mg FROM stock_lots WHERE id = ?', [lot]) === 2477000,
    `S1 (Vorbereitung) der alte Start schließt es mit vollem Restgewicht (${status(db, lot)})`);
  ok(lh.wronglyClosedIssue?.(lot) === null && S(bewiesen()) === S([lot]), `S1 als bewiesen erkannt, das wirklich aufgebrauchte nicht (${S(bewiesen())})`);
  const vor = fest(db, lot); const vorAnderes = S(db.exec('SELECT * FROM stock_lots WHERE id = ?', [anderes])[0]?.values);
  const a0 = audits(db); const c0 = n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'stock_lots' AND record_id = ?", [lot]);
  const e = await reopen(lot);
  ok(e === '' && status(db, lot) === 'ACTIVE' && fest(db, lot) === vor,
    `S1 Reparatur: Status ACTIVE; Gewicht, Wert, Stückfelder, Bewegungen, Hauptbuch und Einkauf unverändert (${e || 'ok'})`);
  ok(S(db.exec('SELECT * FROM stock_lots WHERE id = ?', [anderes])[0]?.values) === vorAnderes, 'S1 …das andere Los ist unberührt');
  ok(audits(db) === a0 + 1 && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND action_type = 'STATUS_CHANGE' AND field_name = 'status' AND old_value LIKE '%EXHAUSTED%'", [lot]) === 1
    && n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'stock_lots' AND record_id = ?", [lot]) === c0 + 1
    && JSON.parse(s(db, "SELECT data FROM sync_changelog WHERE table_name = 'stock_lots' AND record_id = ? ORDER BY id DESC LIMIT 1", [lot])).status === 'ACTIVE',
    'S1 …ein strenger Protokolleintrag und ein Sync-Eintrag (volle Zeile, Status ACTIVE)');
  let inv = true; try { lh.assertBulkLotInvariants(lot); } catch { inv = false; }
  ok(inv && reads.bulkInventoryValuation('branch-main').valueFils === 870000, 'S1 …Invarianten erfüllt, der Lagerwert zählt die 870 BHD wieder');
  let verkauft = ''; try { verkaufe(lot, '10'); } catch (x) { verkauft = (x as Error).message; }
  ok(verkauft === '' && n(db, 'SELECT remaining_weight_mg FROM stock_lots WHERE id = ?', [lot]) === 2467000, `S1 …und wieder verkaufbar (10 g verkauft) (${verkauft || 'ok'})`);
  // S6 — noch einmal: keine zweite Veränderung
  const vor2 = alles(db);
  const e2 = await reopen(lot);
  ok(/BULK_LOT_ALREADY_ACTIVE/.test(e2) && alles(db) === vor2, `S6 wiederholt: abgewiesen, keine zweite Veränderung (${e2 || 'GEÄNDERT'})`);
}
// ══ S2 — teilweise verkauft, dann fälschlich geschlossen: der belegte Rest kommt zurück ═══════════════════════
{
  const db = freshDb();
  const lot = lotOf(db, bulkKauf('2477', '870'));
  verkaufe(lot, '100');
  const rest = n(db, 'SELECT remaining_weight_mg FROM stock_lots WHERE id = ?', [lot]);
  altStart(db);
  const vor = fest(db, lot);
  const e = await reopen(lot);
  let inv = true; try { lh.assertBulkLotInvariants(lot); } catch { inv = false; }
  ok(e === '' && status(db, lot) === 'ACTIVE' && fest(db, lot) === vor && rest === 2377000 && inv,
    `S2 teilweise verkauft und geschlossen: wieder ACTIVE mit dem belegten Rest 2.377 g, sonst unverändert (${e || 'ok'})`);
}
// ══ S3 — wirklich aufgebraucht: abgewiesen ═══════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const lot = lotOf(db, bulkKauf('50', '20'));
  verkaufe(lot, '50');
  const vor = alles(db);
  const e = await reopen(lot);
  ok(status(db, lot) === 'EXHAUSTED' && /BULK_REPAIR_NOT_PROVEN/.test(e) && alles(db) === vor && bewiesen().length === 0,
    `S3 aufgebrauchtes Los: nicht angeboten, Reparatur abgewiesen, nichts verändert (${e || 'GEÖFFNET'})`);
}
// ══ S4 — widersprüchliche Geschichte, falscher Einkauf, veralteter Stand, Rolle: abgewiesen ══════════════════
{
  const db = freshDb();
  const lot = lotOf(db, bulkKauf('2477', '870'));
  altStart(db);
  const anderKauf = bulkKauf('10', '5');
  const vor = alles(db);
  const falsch = await reopen(lot, { purchaseId: anderKauf });
  const alt = await reopen(lot, { confirmWeightMg: 2400000 });
  rolle('MANAGER'); const mgr = await reopen(lot); rolle('ADMIN');
  ok(/BULK_REPAIR_MISMATCH/.test(falsch) && /BULK_REPAIR_STALE/.test(alt) && /PERMISSION_DENIED/.test(mgr) && alles(db) === vor,
    `S4 anderer Einkauf / veralteter Stand / Manager: abgewiesen, nichts verändert (${falsch} · ${alt} · ${mgr})`);
  // Restgewicht passt nicht zu den Bewegungen (z. B. ein fehlender Verkauf)
  db.run('UPDATE stock_lots SET remaining_weight_mg = remaining_weight_mg - 1000 WHERE id = ?', [lot]);
  const vorW = alles(db);
  const w = await reopen(lot);
  ok(/BULK_REPAIR_NOT_PROVEN/.test(w) && alles(db) === vorW && bewiesen().length === 0,
    `S4 Restgewicht widerspricht den Bewegungen: nicht angeboten, abgewiesen, nichts verändert (${w || 'GEÖFFNET'})`);
  // Bewegungskette mit Lücke
  db.run('UPDATE stock_lots SET remaining_weight_mg = remaining_weight_mg + 1000 WHERE id = ?', [lot]);
  db.run('UPDATE bulk_lot_movements SET seq = 5 WHERE lot_id = ?', [lot]);
  const vorL = alles(db);
  const l = await reopen(lot);
  ok(/BULK_REPAIR_NOT_PROVEN/.test(l) && alles(db) === vorL, `S4 Bewegungskette mit Lücke: abgewiesen, nichts verändert (${l || 'GEÖFFNET'})`);
}
// ══ S5 — Protokoll oder Sync scheitert: vollständiger Rollback ══════════════════════════════════════════════
for (const [name, trigger] of [
  ['Protokoll', "CREATE TRIGGER t_nein BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'inject: audit'); END"],
  ['Sync', "CREATE TRIGGER t_nein BEFORE INSERT ON sync_changelog BEGIN SELECT RAISE(ABORT, 'inject: sync'); END"],
] as Array<[string, string]>) {
  const db = freshDb();
  const lot = lotOf(db, bulkKauf('2477', '870'));
  altStart(db);
  db.run(trigger);
  const vor = alles(db);
  const e = await reopen(lot);
  ok((name === 'Sync' ? /sync change-log entry could not be written/ : /inject: audit/).test(e) && status(db, lot) === 'EXHAUSTED' && alles(db) === vor, `S5 ${name} scheitert: vollständig zurück, Los bleibt EXHAUSTED (${e.slice(0, 60) || 'GEÖFFNET'})`);
}

// ══ G — Gold-Schmuck „New" ══════════════════════════════════════════════════════════════════════════════════
const GOLD_OPTS = '["New","Pre-Owned","Vintage"]';
function goldKategorie(db: Db, opts = GOLD_OPTS): void {
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, condition_options, created_at, updated_at) VALUES ('cat-gold-jewelry','branch-main','Gold-Diamond Jewellery','g','#000',?,?,?)", [opts, NOW, NOW]);
}
function goldArtikel(db: Db, id: string, cond = 'Pre-Owned', cat = 'cat-gold-jewelry'): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
      planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main',?,'Gold',?,?,1,?,'[]',300,'BHD',500,'in_stock','MARGIN',0,'[]','{"karat":"18K Yellow","weight":5}','OWN',?,?)`,
  [id, cat, 'Ring ' + id, 'SKU-' + id, cond, NOW, NOW]);
  reload();
}
/** Der Benutzer setzt den Zustand auf der Artikelseite (derselbe Weg wie „Save"): protokolliert. */
async function zustand(id: string, cond: string): Promise<string> {
  const r = await useProductStore.getState().editProductTextDurably(id, { condition: cond } as never) as { status: string; errorCode?: string };
  reload();
  return r.status + (r.errorCode ? ':' + r.errorCode : '');
}
/** Ein Programmstart auf der vorhandenen Datenbank — was `runMigrations` tut. */
function neustart(db: Db): string {
  const hatteLose = hasStockLotsTable(db as never);
  const goldVorher = goldMig ? goldMig.goldCategoryAllowedNew(db) : null;
  for (const m of MIGRATIONS) { try { db.run(m); } catch { /* wie runMigrations */ } }
  runLegacyStockRepairsOnce(db as never, hatteLose);
  const r = goldMig ? goldMig.runGoldConditionMigrationOnce(db, goldVorher) : '(kein Modul)';
  reload();
  return r;
}
const cond = (db: Db, id: string): string => s(db, 'SELECT condition FROM products WHERE id = ?', [id]);
const ALT_GOLD = `UPDATE products SET condition = 'Pre-Owned' WHERE category_id = 'cat-gold-jewelry' AND condition = 'New'`;

// G1 — „New" bleibt über wiederholte Starts; andere Zustände und Artikel unberührt
{
  const db = freshDb(); goldKategorie(db);
  goldArtikel(db, 'g1'); goldArtikel(db, 'g2', 'Vintage'); goldArtikel(db, 'w1', 'New', 'cat-w');
  const z = await zustand('g1', 'New');
  const r = [neustart(db), neustart(db), neustart(db)];
  ok(z === 'edited' && cond(db, 'g1') === 'New' && cond(db, 'g2') === 'Vintage' && cond(db, 'w1') === 'New'
    && s(db, "SELECT condition_options FROM categories WHERE id = 'cat-gold-jewelry'").includes('"New"'),
    `G1 Gold „New" bleibt über drei Starts, „Vintage" und andere Kategorien unberührt (${z}; ${r.join('/')}; ${cond(db, 'g1')})`);
  ok(r[0] === 'marked-applied' && r[1] === 'already-done' && s(db, "SELECT value FROM settings WHERE key = 'migration.gold_condition_pre_owned_once_v1'") === '1',
    `G1 …die Kategorie erlaubte „New" schon: nur der Merker, danach nichts mehr (${r.join('/')})`);
}
// G1b — Datenbank aus der Zeit ohne „New" (17.–23.05.): die historische Umstellung läuft genau einmal
{
  const db = freshDb(); goldKategorie(db, '["Pre-Owned","Vintage"]');
  goldArtikel(db, 'h1', 'New');
  const r1 = neustart(db);
  const nach1 = cond(db, 'h1');
  const z = await zustand('h1', 'New');
  const r2 = neustart(db);
  ok(r1 === 'applied' && nach1 === 'Pre-Owned' && z === 'edited' && r2 === 'already-done' && cond(db, 'h1') === 'New',
    `G1b alte Datenbank: einmal umgestellt, danach bleibt ein neu gesetztes „New" (${r1}/${nach1} → ${r2}/${cond(db, 'h1')})`);
}
// G2–G6 — die belegte Wiederherstellung
const restore = async (ids: string[], reason = 'F10: set back by the start-up step'): Promise<string> => {
  if (!goldRes) return 'KEIN_MODUL';
  try { const r = await goldRes.restoreGoldConditionOnPrimary({ productIds: ids, reason }, reload); return 'ok:' + r.restored.length; }
  catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
};
{
  const db = freshDb(); goldKategorie(db);
  goldArtikel(db, 'n1'); goldArtikel(db, 'n2'); goldArtikel(db, 'u1'); goldArtikel(db, 'x1'); goldArtikel(db, 'v1', 'Vintage'); goldArtikel(db, 'w2', 'New', 'cat-w');
  for (const id of ['n1', 'n2', 'x1']) await zustand(id, 'New');   // vom Benutzer auf „New" gesetzt (protokolliert)
  await zustand('u1', 'New'); await zustand('u1', 'Pre-Owned');      // vom Benutzer selbst zurück auf „Pre-Owned"
  db.run(ALT_GOLD); reload();                                         // der alte Start: still auf „Pre-Owned"
  db.run("UPDATE products SET purchase_price = 999 WHERE id = 'x1'"); reload();   // danach ohne Protokoll anders → kein Beweis
  neustart(db);                                                       // die neue Fassung: Merker, keine weitere Umstellung
  const kand = goldRes ? goldRes.goldConditionRestoreCandidates().map((c: { productId: string }) => c.productId).sort() : [];
  ok(S(kand) === S(['n1', 'n2']), `G2 bewiesen sind genau die still umgestellten Artikel (${S(kand)}) — nicht der vom Benutzer zurückgesetzte, nicht der danach veränderte, kein anderer`);
  // G3 — nicht bewiesen dabei → alles abgewiesen, nichts verändert
  const vor = alles(db);
  const e3 = await restore(['n1', 'u1']);
  const e3b = await restore(['x1']);
  rolle('MANAGER'); const e3c = await restore(['n1']); rolle('ADMIN');
  ok(/GOLD_RESTORE_NOT_PROVEN/.test(e3) && /GOLD_RESTORE_NOT_PROVEN/.test(e3b) && /PERMISSION_DENIED/.test(e3c) && alles(db) === vor,
    `G3 ohne Beweis (auch gemischt) oder als Manager: abgewiesen, nichts verändert (${e3} · ${e3b} · ${e3c})`);
  // G4 — Protokoll / Sync scheitern → zurück
  for (const [name, trigger] of [
    ['Protokoll', "CREATE TRIGGER t_nein BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'inject: audit'); END"],
    ['Sync', "CREATE TRIGGER t_nein BEFORE INSERT ON sync_changelog BEGIN SELECT RAISE(ABORT, 'inject: sync'); END"],
  ] as Array<[string, string]>) {
    db.run(trigger);
    const vorF = alles(db);
    const e = await restore(['n1', 'n2']);
    db.run('DROP TRIGGER t_nein');
    ok((name === 'Sync' ? /sync change-log entry could not be written/ : /inject: audit/).test(e) && alles(db) === vorF && cond(db, 'n1') === 'Pre-Owned', `G4 ${name} scheitert: vollständig zurück (${e.slice(0, 60)})`);
  }
  // G5 — die Wiederherstellung: nur der Zustand, sonst nichts
  const spalten = (id: string): string => S(db.exec('SELECT quantity, purchase_price, planned_sale_price, stock_status, source_type, attributes, category_id FROM products WHERE id = ?', [id])[0]?.values);
  const andere = S(db.exec("SELECT * FROM products WHERE id NOT IN ('n1','n2') ORDER BY id")[0]?.values);
  const vorSp = spalten('n1') + spalten('n2'); const ledger = S(db.exec('SELECT * FROM ledger_entries')[0]?.values); const a0 = audits(db); const c0 = changelog(db);
  const e5 = await restore(['n1', 'n2']);
  ok(e5 === 'ok:2' && cond(db, 'n1') === 'New' && cond(db, 'n2') === 'New' && spalten('n1') + spalten('n2') === vorSp
    && S(db.exec("SELECT * FROM products WHERE id NOT IN ('n1','n2') ORDER BY id")[0]?.values) === andere && S(db.exec('SELECT * FROM ledger_entries')[0]?.values) === ledger,
    `G5 Wiederherstellung: beide wieder „New"; Menge, Preise, Status, Herkunft, Attribute, Hauptbuch und alle anderen Artikel unverändert (${e5})`);
  ok(audits(db) === a0 + 2 && n(db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'condition' AND old_value LIKE '%Pre-Owned%' AND new_value LIKE '%F10_GOLD_CONDITION_RESTORE%'") === 2
    && changelog(db) === c0 + 2 && JSON.parse(s(db, "SELECT data FROM sync_changelog WHERE record_id = 'n1' ORDER BY id DESC LIMIT 1")).condition === 'New',
    'G5 …je Artikel ein strenger Protokolleintrag (mit Beleg) und ein Sync-Eintrag');
  // G6 — noch einmal, und ein weiterer Start: keine Doppelwirkung, „New" bleibt
  const vor6 = alles(db);
  const e6 = await restore(['n1', 'n2']);
  const kand6 = goldRes ? goldRes.goldConditionRestoreCandidates().length : -1;
  ok(/GOLD_RESTORE_NOT_PROVEN/.test(e6) && alles(db) === vor6 && kand6 === 0, `G6 wiederholt: nichts mehr zu tun, nichts verändert (${e6})`);
  neustart(db);
  ok(cond(db, 'n1') === 'New' && cond(db, 'n2') === 'New', 'G6 …und ein weiterer Start lässt „New" stehen');
}
// G7 — ohne den Start-Fix in der Datenbank (Merker fehlt) keine Wiederherstellung (der nächste Start nähme sie sonst zurück)
{
  const db = freshDb(); goldKategorie(db); goldArtikel(db, 'm1');
  await zustand('m1', 'New'); db.run(ALT_GOLD); reload();
  const vor = alles(db);
  const e = await restore(['m1']);
  ok(/STARTUP_FIX_NOT_ACTIVE/.test(e) && alles(db) === vor, `G7 Merker fehlt: abgewiesen, nichts verändert (${e})`);
}

// ══ Z — der Zustand bleibt frei bearbeitbar: New ↔ Pre-Owned, am Primary und vom PC2, über Speichern und Neustart ══
{
  const pc = await import('../../src/core/bridge/product-commands.ts');
  await import('../../src/core/bridge/command-registry.ts');
  await import('../../src/core/bridge/command-permissions.ts');
  let nr = 7000;
  const pc2 = async (db: Db, id: string, condition: string): Promise<string> => {
    const x = String(++nr);
    const deps = { db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
      rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW };
    const identity = { commandId: `${x.padStart(8, '0')}-0000-4000-8000-000000000000`, tenantId: 'tenant-1', branchId: 'branch-main',
      userId: 'user-pc2', role: 'ADMIN', op: 'products.update', payloadHash: 'h' + x };
    try {
      const o = await pc.runProductUpdate(deps as never, identity as never, { id, condition }) as { kind: string; code?: string };
      reload();
      return o.kind === 'ok' ? 'ok' : String(o.code);
    } catch (e) { return 'THROWN:' + String((e as { code?: unknown }).code ?? (e as Error).message); }
  };
  const db = freshDb(); goldKategorie(db);
  goldArtikel(db, 'z1', 'New'); goldArtikel(db, 'z2', 'Pre-Owned');
  neustart(db);   // erster Start der neuen Fassung: nur der Merker
  const schritte: string[] = [];
  const pruef = (id: string, soll: string): boolean => { neustart(db); const ist = cond(db, id); schritte.push(`${id}:${soll}→${ist}`); return ist === soll; };
  // Primary, Artikelseite (Hausfolge der Maske)
  const a1 = await zustand('z1', 'Pre-Owned'); const p1 = cond(db, 'z1') === 'Pre-Owned' && pruef('z1', 'Pre-Owned');
  const a2 = await zustand('z1', 'New'); const p2 = cond(db, 'z1') === 'New' && pruef('z1', 'New');
  ok(a1 === 'edited' && a2 === 'edited' && p1 && p2,
    `Z Primary: New → Pre-Owned → New gespeichert, jeder Stand übersteht einen Neustart (${a1}/${a2}; ${schritte.join(', ')})`);
  // PC2, products.update (derselbe Hauskern am Primary)
  const b1 = await pc2(db, 'z2', 'New'); const q1 = cond(db, 'z2') === 'New' && pruef('z2', 'New');
  const b2 = await pc2(db, 'z2', 'Pre-Owned'); const q2 = cond(db, 'z2') === 'Pre-Owned' && pruef('z2', 'Pre-Owned');
  const b3 = await pc2(db, 'z2', 'New'); const q3 = cond(db, 'z2') === 'New' && pruef('z2', 'New');
  ok(b1 === 'ok' && b2 === 'ok' && b3 === 'ok' && q1 && q2 && q3,
    `Z PC2: New ↔ Pre-Owned gespeichert, jeder Stand übersteht einen Neustart (${b1}/${b2}/${b3}; ${schritte.slice(2).join(', ')})`);
  ok(goldMig?.runGoldConditionMigrationOnce(db, false) === 'already-done' && cond(db, 'z1') === 'New' && cond(db, 'z2') === 'New',
    'Z die Gold-Umstellung läuft nach dem Merker nie wieder — selbst wenn die Kategorie „New" einmal nicht anböte');
}

// ══ P — Pins: nie automatisch, nur am Primary, der Startblock enthält die Umstellung nicht mehr ════════════════
{
  ok(!MIGRATIONS.some((m) => /SET condition = 'Pre-Owned'/.test(m)), 'P Startblock: keine Gold-Umstellung mehr bei jedem Start');
  const dbSrc = src('src/core/db/database.ts');
  const rm = dbSrc.slice(dbSrc.indexOf('function runMigrations'), dbSrc.indexOf('const migrations: string[] = [', dbSrc.indexOf('function runMigrations')));
  ok(/goldCategoryAllowedNew\(database\)/.test(rm) && /runGoldConditionMigrationOnce\(database, goldAllowedNew\)/.test(dbSrc),
    'P runMigrations fragt die Kategorie VOR dem Block und stellt einmal je Datenbank um');
  const nutzer: string[] = [];
  for (const rel of readdirSync(resolvePath(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const t = src('src/' + rel.replace(/\\/g, '/'));
    if (/reopenWronglyClosedLot(InHouse|OnPrimary)\(|restoreGoldCondition(InHouse|OnPrimary)\(/.test(t.replace(/export (const|function) \w+/g, ''))) nutzer.push(rel.replace(/\\/g, '/'));
  }
  ok(S(nutzer.sort()) === S(['core/bulk/bulk-actions.ts', 'core/products/gold-condition-restore.ts', 'pages/settings/DataRepairsTab.tsx']),
    `P die Reparaturen ruft nur die Maske „Data Repairs" (über den Primary-Anschluss) — kein Start, kein Update (${S(nutzer)})`);
  const sp = src('src/pages/settings/SettingsPage.tsx');
  ok(/case 'repairs': return <DataRepairsTab \/>/.test(sp) && /primaryOnlyLocked\(\)/.test(sp) && /canManageSettings/.test(sp),
    'P „Data Repairs" liegt in den Einstellungen (nur am Primary, nur Admin)');
  // PC2: die Anschlüsse weisen ab
  store.set('lataif_runtime_mode', 'client');
  const pc2 = ba.reopenWronglyClosedLotOnPrimary ? await ba.reopenWronglyClosedLotOnPrimary({} as never, reload).then(() => 'OK', (e: { code?: string }) => String(e.code)) : 'KEIN_ANSCHLUSS';
  const pc2g = goldRes ? await goldRes.restoreGoldConditionOnPrimary({ productIds: ['x'], reason: 'x' }, reload).then(() => 'OK', (e: { code?: string }) => String(e.code)) : 'KEIN_MODUL';
  store.delete('lataif_runtime_mode');
  ok(pc2 === 'PRIMARY_ONLY' && pc2g === 'PRIMARY_ONLY', `P auf PC2 abgewiesen (${pc2} · ${pc2g})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — f10 repairs (silver lot, gold condition): ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
