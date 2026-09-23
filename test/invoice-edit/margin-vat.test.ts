// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S2 (Marge) — die Beträge einer fortgesetzten Zeile rechnet das Haus aus dem Los,
// das die Zeile wirklich hält; die Maske zeigt dieses Los fest.
// Run: node --experimental-strip-types test/invoice-edit/margin-vat.test.ts
//
//   1 reine Notizänderung mit fremdem Einstand (900) → Margen-VAT bleibt 18,182 (Einstand 800)
//   2 gespeicherte abweichende Steuer bei unveränderter Zeile bleibt · 3 Preisänderung → neu aus 800
//   4 Mengenerhöhung: eigenes Los reicht / reicht nicht (verständlicher Satz) · 5 PC2 dieselbe Regel
//   6 Rechenregel pur · 7 Maske (Quelltext)
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
// Der echte invoice.paid-Handler (registriert sich beim Laden des Moduls).
await import('../../src/core/automation/automation-handlers.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useProductionStore } = await import('../../src/stores/productionStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { convertTransferInHouse, undoTransferConversionInHouse } = await import('../../src/core/agents/transfer-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { STOCK_UNAVAILABLE_MESSAGE } = await import('../../src/core/lots/lot-availability.ts');
const { classifyLegacyInvoiceLines, LEGACY_STOCK_LINES_MESSAGE } = await import('../../src/core/lots/stock-contract.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-21T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({
    name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0,
  }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
}

/** Artikel: `lotQty` = Einkaufslos mit dieser Menge; null = ohne Los, Menge `manualQty`. */
function product(db: Db, id: string, lotQty: number | null, manualQty = 0, extra: { status?: string; source?: string } = {}): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
  [id, 'M ' + id, 'SKU-' + id, lotQty ?? manualQty, extra.status ?? 'in_stock', extra.source ?? 'OWN', NOW, NOW]);
  if (lotQty !== null) {
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,'branch-main',?,100,?,?,'ACTIVE',?,?)`, ['lot-' + id, id, lotQty, lotQty, NOW, NOW]);
  }
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
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
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
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LINE = (productId: string, qty = 1, price = 1000) => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: (price * qty) / 10, lineTotal: price * qty * 1.1,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>, customerId = 'cust-1'): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, lines as never, 'SLI').id);
  reload();
  return id;
}
function voll(invId: string): string {
  const db = current();
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  const pay = imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
  return pay;
}
const { runInvoiceUpdate } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const { toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
const {
  EDIT_KEPT_LINE_LOT_SHORT, keptLineAmounts, keptLineLotShortMessage, loadEditBaseLines,
} = await import('../../src/core/invoices/edit-lines.ts');

let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };
void OWNER_ACTOR; void imHausAsync; void tick; void useConsignmentStore; void useProductionStore; void useAgentStore;
void cancelReturnHouse; void cancelInvoiceInHouse; void convertTransferInHouse; void undoTransferConversionInHouse;
void createProductionInHouse; void STOCK_UNAVAILABLE_MESSAGE; void classifyLegacyInvoiceLines; void LEGACY_STOCK_LINES_MESSAGE;
void eventBus; void insert; void useCreditNoteStore; void rechnung; void product;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const MV = (preis: number, einstand: number): number => r3(Math.max(0, preis - einstand) * 10 / 110);

interface Zeile { id: string; lot: string; qty: number; preis: number; einstand: number; vat: number; total: number }
const zeilen = (db: Db, inv: string): Zeile[] =>
  (db.exec(`SELECT id, lot_id, quantity, unit_price, purchase_price_snapshot, vat_amount, line_total
              FROM invoice_lines WHERE invoice_id = ? ORDER BY position`, [inv])[0]?.values ?? [])
    .map((v) => ({ id: String(v[0]), lot: String(v[1] ?? ''), qty: Number(v[2]), preis: Number(v[3]), einstand: Number(v[4]), vat: Number(v[5]), total: Number(v[6]) }));
const lotRest = (db: Db, lot: string): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);
/** Margen-/Ausgangssteuer der Rechnung im Hauptbuch (Haben − Soll, nur die INVOICE-Quelle). */
const vatBuch = (db: Db, inv: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries
    WHERE source_module = 'INVOICE' AND source_id = ? AND account IN ('MARGIN_VAT', 'VAT_OUTPUT')`, [inv]);
const ausgeglichen = (db: Db): boolean => Math.abs(n(db,
  "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.005;
function zustand(db: Db): string {
  return S({
    lines: all(db, 'SELECT * FROM invoice_lines ORDER BY id'),
    lots: all(db, 'SELECT id, qty_remaining FROM stock_lots ORDER BY id'),
    inv: all(db, 'SELECT gross_amount, vat_amount, notes FROM invoices ORDER BY id'),
    le: n(db, 'SELECT COUNT(*) FROM ledger_entries'),
  });
}

/** Margen-Artikel: Los A (Einstand 800, `mengeA` Stück, älter) und Los B (Einstand 900, 1 Stück). */
function welt(mengeA = 1): { db: Db; inv: string; z: string } {
  const db = neu();
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('pM','branch-main','cat-w','Rolex','Datejust','SKU-pM',?,'Pre-Owned','[]',850,'BHD',1000,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
  [mengeA + 1, NOW, NOW]);
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES ('lot-A','branch-main','pM',800,?,?,'ACTIVE','2026-01-01',?)`, [mengeA, mengeA, NOW]);
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES ('lot-B','branch-main','pM',900,1,1,'ACTIVE','2026-02-01',?)`, [NOW]);
  reload();
  const zeile = toInvoiceLine({ productId: 'pM', lotId: 'lot-A', quantity: 1, unitPrice: 1000, costBasis: 800, scheme: 'MARGIN' });
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [zeile] as never, 'Marge').id);
  reload();
  voll(inv);
  return { db, inv, z: zeilen(db, inv)[0].id };
}

/** So rechnete die Maske VOR dem Fix: mit dem ältesten OFFENEN Los (B, 900) statt dem gehaltenen. */
const maskeAlt = (lineId: string, qty = 1, preis = 1000) => ({
  lineId, ...toInvoiceLine({ productId: 'pM', lotId: 'lot-B', quantity: qty, unitPrice: preis, costBasis: 900, scheme: 'MARGIN' }),
});
/** So rechnet die Maske JETZT: mit dem gehaltenen Los A und seinem Einstand. */
const maskeNeu = (lineId: string, qty = 1, preis = 1000) => ({
  lineId, ...toInvoiceLine({ productId: 'pM', lotId: 'lot-A', quantity: qty, unitPrice: preis, costBasis: 800, scheme: 'MARGIN' }),
});
function aendern(inv: string, lines: unknown[], notes?: string): string {
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv,
    { lines: lines as never, reason: 'S2-Marge', ...(notes !== undefined ? { notes } : {}) } as never)));
  reload();
  return m;
}

// ══ SETUP ══
{
  const { db, inv } = welt();
  const z = zeilen(db, inv)[0];
  ok(z.lot === 'lot-A' && z.einstand === 800 && Math.abs(z.vat - MV(1000, 800)) < 0.0005 && z.total === 1000,
    `SETUP Margen-Zeile auf Los A: Einstand ${z.einstand}, VAT ${z.vat} (erwartet ${MV(1000, 800)}), Summe ${z.total}`);
  ok(lotRest(db, 'lot-A') === 0 && lotRest(db, 'lot-B') === 1 && Math.abs(vatBuch(db, inv) - MV(1000, 800)) < 0.0005,
    `SETUP …Los A leer, Los B offen (Einstand 900); Hauptbuch-VAT ${vatBuch(db, inv)}`);
}

// 1) Reine Notizänderung — die Gegenstelle rechnet mit Los B (900). Die VAT bleibt 18,182.
{
  const { db, inv, z } = welt();
  const m = aendern(inv, [maskeAlt(z)], 'nur eine Notiz');
  const zz = zeilen(db, inv)[0];
  ok(m === '' && s(db, 'SELECT notes FROM invoices WHERE id = ?', [inv]) === 'nur eine Notiz',
    `1 Notizänderung gespeichert (${m})`);
  ok(Math.abs(zz.vat - 18.182) < 0.0005 && zz.einstand === 800 && zz.lot === 'lot-A' && zz.id === z,
    `1 …Margen-VAT bleibt 18,182 auf Einstand 800, Los A (VAT ${zz.vat}, Einstand ${zz.einstand}, Los ${zz.lot})`);
  ok(Math.abs(n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv]) - 18.182) < 0.0005
    && Math.abs(vatBuch(db, inv) - 18.182) < 0.0005 && ausgeglichen(db),
    `1 …Rechnungskopf und Hauptbuch ebenso (Kopf ${n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv])}, Buch ${vatBuch(db, inv)})`);
  ok(lotRest(db, 'lot-A') === 0 && lotRest(db, 'lot-B') === 1,
    `1 …kein Loswechsel: A ${lotRest(db, 'lot-A')}, B ${lotRest(db, 'lot-B')}`);
  // Die neue Maske schickt dasselbe mit Los A — Ergebnis identisch.
  const vorZeilen = all(db, 'SELECT * FROM invoice_lines');
  const m2 = aendern(inv, [maskeNeu(z)], 'nur eine Notiz');
  ok(m2 === '' && Math.abs(zeilen(db, inv)[0].vat - 18.182) < 0.0005 && all(db, 'SELECT * FROM invoice_lines') === vorZeilen,
    `1 …neue Maske (Los A) ändert die Zeile nicht (${m2})`);
}

// 2) Eine gespeicherte, abweichende Steuer bei fachlich unveränderter Zeile wird nicht still überschrieben.
{
  const { db, inv, z } = welt();
  db.run('UPDATE invoice_lines SET vat_amount = 18.2 WHERE id = ?', [z]);   // z. B. alte Rundung
  reload();
  const m = aendern(inv, [maskeAlt(z)], 'Notiz 2');
  ok(m === '' && Math.abs(zeilen(db, inv)[0].vat - 18.2) < 0.0005,
    `2 unveränderte Zeile: gespeicherte 18,2 bleibt (weder 9,091 noch still 18,182) (${zeilen(db, inv)[0].vat})`);
  // Ändert sich die Zeile fachlich (Preis), wird neu gerechnet — aus dem gehaltenen Einstand.
  const m2 = aendern(inv, [maskeAlt(z, 1, 1100)]);
  const zz = zeilen(db, inv)[0];
  ok(m2 === '' && Math.abs(zz.vat - MV(1100, 800)) < 0.0005 && zz.total === 1100 && zz.einstand === 800,
    `2 …Preis geändert: neu aus Einstand 800 = ${MV(1100, 800)} (${zz.vat}; mit 900 wären es ${MV(1100, 900)})`);
}

// 3) Preisänderung direkt: 1000 → 1100 mit fremdem Einstand geschickt → gerechnet mit 800.
{
  const { db, inv, z } = welt();
  const m = aendern(inv, [maskeAlt(z, 1, 1100)]);
  const zz = zeilen(db, inv)[0];
  ok(m === '' && Math.abs(zz.vat - 27.273) < 0.0005 && Math.abs(vatBuch(db, inv) - 27.273) < 0.0005 && ausgeglichen(db),
    `3 Preis 1100: VAT 27,273 aus Einstand 800 in Zeile und Hauptbuch (${zz.vat}/${vatBuch(db, inv)})`);
  ok(Math.abs(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) - 1100) < 0.0005,
    `3 …Brutto 1100 (${n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv])})`);
}

// 4) Mengenerhöhung — nur aus dem EIGENEN Los.
{
  // a) Los A hat noch eins → geht, Los B bleibt unberührt, VAT aus 2×800.
  const { db, inv, z } = welt(2);
  const m = aendern(inv, [maskeAlt(z, 2, 1000)]);
  const zz = zeilen(db, inv)[0];
  ok(m === '' && zz.qty === 2 && lotRest(db, 'lot-A') === 0 && lotRest(db, 'lot-B') === 1,
    `4a Menge 2 aus Los A: A ${lotRest(db, 'lot-A')}, B ${lotRest(db, 'lot-B')} (${m})`);
  ok(Math.abs(zz.vat - r3(400 * 10 / 110)) < 0.0005 && zz.einstand === 800 && ausgeglichen(db),
    `4a …VAT ${zz.vat} aus 2×(1000−800) (erwartet ${r3(400 * 10 / 110)})`);
}
{
  // b) Los A ist leer, Los B hätte eins → abgelehnt, mit verständlichem Satz, nichts geändert.
  const { db, inv, z } = welt();
  const vor = zustand(db);
  const m = aendern(inv, [maskeAlt(z, 2, 1000)]);
  ok(m.startsWith(EDIT_KEPT_LINE_LOT_SHORT + '|') && zustand(db) === vor,
    `4b Menge 2, Los A leer: abgewiesen, nichts geändert (${m.slice(0, 40)})`);
  ok(m.includes('Rolex Datejust') && m.includes('add the extra pieces as a new line'),
    `4b …der Satz nennt Artikel und Ausweg (${m.split('|')[1]})`);
  // Der Ausweg funktioniert: das Mehr als NEUE Zeile — die nimmt Los B.
  const m2 = aendern(inv, [maskeNeu(z, 1, 1000), toInvoiceLine({ productId: 'pM', lotId: 'lot-B', quantity: 1, unitPrice: 1000, costBasis: 900, scheme: 'MARGIN' })]);
  const zz = zeilen(db, inv);
  ok(m2 === '' && zz.length === 2 && zz[0].id === z && zz[0].lot === 'lot-A' && zz[1].lot === 'lot-B' && lotRest(db, 'lot-B') === 0
    && Math.abs(zz[0].vat - 18.182) < 0.0005 && Math.abs(zz[1].vat - MV(1000, 900)) < 0.0005,
    `4b …Mehr als neue Zeile: Los B, je eigene VAT (${zz.map((x) => `${x.lot}:${x.vat}`).join(', ')}) (${m2})`);
}

// 5) PC2 — dieselbe Regel; alle gehaltenen Lose zählen, jede Zeile behält ihres.
{
  const { db, inv, z } = welt();
  const d = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'h' + x });
  const rev = (): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
  const a = await runInvoiceUpdate(d as never, ident('51') as never, {
    id: inv, expectedRevision: rev(), reason: 'PC2 Notiz', customerId: 'cust-1', notes: 'PC2',
    lines: [{ lineId: z, productId: 'pM', lotId: 'lot-A', quantity: 1, unitPrice: 1000, scheme: 'MARGIN' }],
  });
  reload();
  ok(a.kind === 'ok' && Math.abs(zeilen(db, inv)[0].vat - 18.182) < 0.0005 && zeilen(db, inv)[0].lot === 'lot-A',
    `5 PC2 Notizänderung: VAT 18,182 auf Los A (${a.kind}, ${zeilen(db, inv)[0].vat})`);
  const vor = zustand(db);
  const b = await runInvoiceUpdate(d as never, ident('52') as never, {
    id: inv, expectedRevision: rev(), reason: 'PC2 Menge', customerId: 'cust-1',
    lines: [{ lineId: z, productId: 'pM', lotId: 'lot-A', quantity: 2, unitPrice: 1000, scheme: 'MARGIN' }],
  });
  reload();
  ok(b.kind === 'rejected' && (b as { code: string }).code === EDIT_KEPT_LINE_LOT_SHORT && (b as { frozen: boolean }).frozen === true
    && zustand(db) === vor,
    `5 PC2 Menge über das eigene Los: endgültige Absage mit Kennung (${(b as { code?: string }).code})`);
  // Zweite Zeile auf Los B dazu — danach hält die Rechnung ZWEI Lose desselben Artikels; PC2 schickt
  // für jede Zeile ihr eigenes (wie die Maske jetzt) und kommt durch.
  const c = await runInvoiceUpdate(d as never, ident('53') as never, {
    id: inv, expectedRevision: rev(), reason: 'PC2 zweite Zeile', customerId: 'cust-1',
    lines: [
      { lineId: z, productId: 'pM', lotId: 'lot-A', quantity: 1, unitPrice: 1000, scheme: 'MARGIN' },
      { productId: 'pM', lotId: 'lot-B', quantity: 1, unitPrice: 1000, scheme: 'MARGIN' },
    ],
  });
  reload();
  const z2 = zeilen(db, inv)[1]?.id ?? '';
  const e = await runInvoiceUpdate(d as never, ident('54') as never, {
    id: inv, expectedRevision: rev(), reason: 'PC2 beide Lose', customerId: 'cust-1', notes: 'beide',
    lines: [
      { lineId: z, productId: 'pM', lotId: 'lot-A', quantity: 1, unitPrice: 1000, scheme: 'MARGIN' },
      { lineId: z2, productId: 'pM', lotId: 'lot-B', quantity: 1, unitPrice: 1000, scheme: 'MARGIN' },
    ],
  });
  reload();
  const zz = zeilen(db, inv);
  ok(c.kind === 'ok' && e.kind === 'ok' && zz.length === 2 && zz[0].lot === 'lot-A' && zz[1].lot === 'lot-B'
    && Math.abs(zz[0].vat - MV(1000, 800)) < 0.0005 && Math.abs(zz[1].vat - MV(1000, 900)) < 0.0005 && ausgeglichen(db),
    `5 PC2 mit zwei gehaltenen Losen desselben Artikels: jede Zeile behält Los und VAT (${c.kind}/${e.kind}; ${zz.map((x) => `${x.lot}:${x.vat}`).join(', ')})`);
}

// 6) Rechenregel pur.
{
  const { inv } = welt();
  const b = loadEditBaseLines(inv)[0];
  const gleich = keptLineAmounts(b, { quantity: 1, unitPrice: 1000, taxScheme: 'MARGIN', vatRate: 10 }, 900);
  ok(gleich.vatAmount === b.vatAmount && gleich.lineTotal === b.lineTotal,
    `6 unverändert → gespeicherte Beträge, egal welcher Einstand übergeben wird (${gleich.vatAmount})`);
  const anders = keptLineAmounts(b, { quantity: 1, unitPrice: 1200, taxScheme: 'MARGIN', vatRate: 10 }, 800);
  ok(Math.abs(anders.vatAmount - MV(1200, 800)) < 0.0005 && anders.lineTotal === 1200,
    `6 Preis anders → aus dem übergebenen Einstand (${anders.vatAmount})`);
  const vat10 = keptLineAmounts(b, { quantity: 1, unitPrice: 1000, taxScheme: 'VAT_10', vatRate: 10 }, 800);
  ok(vat10.vatAmount === 100 && vat10.lineTotal === 1100, `6 Steuerart gewechselt → VAT 10 % auf 1000 (${vat10.vatAmount}/${vat10.lineTotal})`);
  const ret = keptLineAmounts({ ...b, returnedQty: 1, vatAmount: 18.2 }, { quantity: 1, unitPrice: 1000, taxScheme: 'MARGIN', vatRate: 10 }, 900);
  ok(ret.vatAmount === 18.2, `6 Zeile mit Retoure → pro Stück wie gespeichert (${ret.vatAmount})`);
  ok(/add the extra pieces as a new line/.test(keptLineLotShortMessage('X', 0)) && /Only 2 more of X/.test(keptLineLotShortMessage('X', 2)),
    '6 Satz bei zu wenig im eigenen Los (leer / Rest)');
}

// 7) Maske — Los der fortgesetzten Zeile fest, kein Wechsel, dieselbe Meldung vor dem Speichern.
{
  const m = src('src/pages/invoices/InvoiceCreate.tsx');
  ok(/kept: \{ productId: l\.productId \|\| '', lotId: l\.lotId \?\? null, cost: l\.purchasePriceSnapshot/.test(m),
    'Q die Maske lädt Los und Einstand der gespeicherten Zeile');
  ok(/\{!c\.kept && c\.lots\.length > 1 && \(/.test(m) && /\{!c\.kept && c\.lots\.length === 1/.test(m) && /· fixed/.test(m),
    'Q Losauswahl bei fortgesetzter Zeile aus, stattdessen das gehaltene Los');
  ok(/const costBasis = kept \? kept\.cost/.test(m) && /lotId: c\.lotIdOut/.test(m) && /lotId: computed\[i\]\?\.lotIdOut/.test(m),
    'Q Maske rechnet und schickt (Primary und PC2) das gehaltene Los');
  ok(/keptLineLotShortMessage\(/.test(m) && /computed\.findIndex\(c => c\.keptShort\)/.test(m),
    'Q Mengenerhöhung über das eigene Los wird vor dem Speichern gemeldet');
  ok(/lotId: \(row\.lot_id as string \| null\) \|\| null/.test(src('src/stores/invoiceStore.ts')), 'Q die Zeile trägt ihr Los in den Store');
  ok(/EDIT_KEPT_LINE_LOT_SHORT,\n  LEGACY_STOCK_LINES/.test(src('src/core/bridge/invoice-lifecycle-commands.ts')), 'Q PC2: Kennung ist endgültiges Urteil');
}
void current;

console.log(`\ninvoice-edit-margin-vat: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
