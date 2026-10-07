// ════════════════════════════════════════════════════════════════════════════
// PURITY-METAL-DOMAIN — EINE Reinheitstabelle, getrennt nach Metall; 24K = 0,999 überall.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Hausfolgen.
// Run: node --experimental-strip-types test/purity-metal-domain/purity-metal-domain.test.ts
//
//   1 Tabellen je Metall   2 Rechenbeispiele (24K → 99.900 g überall, 22K, Rückrechnung, Schmelzwert)
//   3 Gold-Abläufe lehnen 925/950/999 im Kern ab (Schuld, Guthaben, Bewegung, Bestand, Ausgleich,
//     Reparatur-Goldeinsatz, Reparatur-Material)   4 Precious Metals: Feinheit passt zum Metall
//   5 Feingold-Summe nur Gold, Gold-Store-Aufstellungen unverändert   6 Quelltext
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

const purity = await import('../../src/core/gold/purity.ts');
const settle = await import('../../src/core/gold/gold-settle.ts');
const goldHouse = await import('../../src/core/gold/gold-house.ts');
const metalHouse = await import('../../src/core/metals/metal-house.ts');
const { useGoldStore } = await import('../../src/stores/goldStore.ts');
const { useMetalStore } = await import('../../src/stores/metalStore.ts');

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
const ACTOR = { branchId: 'branch-main', userId: 'user-test' };
const code = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); } };
const g3 = (x: number): number => Math.round(x * 1000) / 1000;

// ══ 1 — eine Tabelle, getrennt nach Metall ════════════════════════════════════
{
  ok(purity.GOLD_PURITY['24K'] === 0.999 && purity.GOLD_PURITY['22K'] === 0.916 && purity.GOLD_PURITY['21K'] === 0.875
    && purity.GOLD_PURITY['18K'] === 0.75 && purity.GOLD_PURITY['14K'] === 0.585 && purity.GOLD_PURITY['9K'] === 0.375,
    '1 Gold-Karate unverändert: 24K .999 · 22K .916 · 21K .875 · 18K .750 · 14K .585 · 9K .375');
  ok(S(Object.keys(purity.GOLD_PURITY)) === S(['24K', '22K', '21K', '18K', '14K', '9K']), '1 Gold kennt nur Karate (kein 999/925/950)');
  ok(S(purity.SILVER_PURITY) === S({ '999': 0.999, '925': 0.925 }) && S(purity.PLATINUM_PURITY) === S({ '950': 0.95, '999': 0.999 }),
    '1 Silber 999/925, Platin 950/999');
  ok(purity.KARAT_PURITY === purity.GOLD_PURITY, '1 KARAT_PURITY ist die Gold-Tabelle (keine eigene Kopie)');
  ok(metalHouse.METAL_KARATS.gold.join() === '24K,22K,21K,18K,14K,9K' && metalHouse.METAL_KARATS.silver.join() === '999,925'
    && metalHouse.METAL_KARATS.platinum.join() === '950,999', '1 Precious-Metals-Auswahl unverändert (auch die Reihenfolge), jetzt aus derselben Tabelle');
  for (const m of ['gold', 'silver', 'platinum'] as const) {
    ok(S([...purity.METAL_GRADES[m]].sort()) === S(Object.keys(purity.METAL_PURITIES[m]).sort()), `1 …Auswahl ${m} = Schlüssel der Tabelle ${m}`);
  }
}

// ══ 2 — Rechenbeispiele: 24K = 99.900 g Feingold ÜBERALL ═══════════════════════
{
  ok(g3(purity.pureGoldGrams('24K', 100)) === 99.9, '2 100 g 24K → 99.900 g Feingold (purity)');
  ok(g3(100 * (purity.metalPurity('gold', '24K') ?? 0)) === 99.9, '2 …dieselbe Reinheit in Precious Metals (metalPurity gold/24K)');
  ok(metalHouse.meltValueOf(100, 'gold', '24K', 1) === 99.9, `2 …Schmelzwert 100 g 24K bei Spot 1 = 99.900 (vorher 100) (${metalHouse.meltValueOf(100, 'gold', '24K', 1)})`);
  ok(settle.crossKaratPlan('24K', '24K', 100, 100).sourcePurity === 0.999, '2 …und im Gold-Ausgleich (crossKaratPlan)');
  ok(g3(purity.pureGoldGrams('22K', 100)) === 91.6, '2 100 g 22K → 91.600 g');
  ok(g3(100 * (purity.metalPurity('silver', '999') ?? 0)) === 99.9 && g3(100 * (purity.metalPurity('platinum', '999') ?? 0)) === 99.9,
    '2 100 g 999 Silber bzw. Platin → 99.900 g (999 nur in diesen Metallen)');
  ok(g3(purity.sourceEquivalent('24K', '24K', 99.9) / 0.999 * 0.999) === 99.9 && g3(99.9 / purity.purityOf('24K')) === 100,
    '2 Rückrechnung 99.900 g Feingold → 100.000 g 24K');
  ok(g3(purity.targetEquivalent('22K', '24K', 100)) === 91.692, '2 100 g 22K = 91.692 g 24K-Äquivalent (unverändert)');
  ok(metalHouse.meltValueOf(100, 'silver', '925', 1) === 92.5 && metalHouse.meltValueOf(100, 'platinum', '950', 1) === 95,
    '2 Silber 925 / Platin 950: Schmelzwert im eigenen Metall');
  ok(metalHouse.meltValueOf(100, 'gold', '925', 1) === 0 && metalHouse.meltValueOf(100, 'silver', '24K', 1) === 0,
    '2 fremde Feinheit im Metall → kein Schmelzwert (nie still × 1,0)');
}

// ══ 3 — Gold-Abläufe lehnen Silber/Platin ab (Kern, nicht nur Maske) ═════════════
{
  const db = neu();
  ok(purity.goldPurity('925') === null && purity.goldPurity('950') === null && purity.goldPurity('999') === null
    && purity.goldPurity('xyz') === null, '3 goldPurity: 925/950/999/Unsinn sind kein Gold (null statt 1,0)');
  ok(/not a gold karat/.test(code(() => purity.purityOf('925'))), '3 purityOf(925) wirft statt 1,0');
  ok(code(() => settle.assertKnownKarat('925')) === 'GOLD_KARAT_UNKNOWN' && code(() => settle.assertKnownKarat('950')) === 'GOLD_KARAT_UNKNOWN'
    && code(() => settle.assertKnownKarat('999')) === 'GOLD_KARAT_UNKNOWN', '3 assertKnownKarat lehnt 925/950/999 ab');
  for (const k of ['24K', '22K', '21K', '18K', '14K', '9K']) ok(settle.assertKnownKarat(k) === k, `3 …${k} weiterhin angenommen`);
  ok(code(() => settle.insertGoldPayable('branch-main', { supplierId: 'sup-1', weightGrams: 10, karat: '925' })) === 'GOLD_KARAT_UNKNOWN',
    '3 Gold-Schuld in 925 abgelehnt');
  ok(code(() => settle.insertGoldPayable('branch-main', { supplierId: 'sup-1', weightGrams: 10, karat: '950' })) === 'GOLD_KARAT_UNKNOWN',
    '3 Gold-Schuld in 950 abgelehnt');
  ok(code(() => settle.insertCustomerGoldCredit('branch-main', { customerId: 'cust-1', weightGrams: 10, karat: '925' } as never)) === 'GOLD_KARAT_UNKNOWN',
    '3 Kunden-Goldguthaben in 925 abgelehnt');
  ok(code(() => settle.recordGoldMovement({ branchId: 'branch-main', direction: 'in', weightGrams: 5, karat: '925' })) === 'GOLD_KARAT_UNKNOWN',
    '3 Goldbewegung in 925 abgelehnt');
  ok(code(() => settle.adjustPreciousMetals({ branchId: 'branch-main', karat: '950', deltaGrams: 5, sourceLabel: 't', createdBy: 'u' })) === 'GOLD_KARAT_UNKNOWN',
    '3 Gold-Bestand in 950 abgelehnt');
  ok(code(() => settle.crossKaratPlan('925', '24K', 10, 10)) === 'GOLD_KARAT_UNKNOWN', '3 Gold-Ausgleich mit Silber 925 als Quelle abgelehnt');
  ok(n(db, 'SELECT COUNT(*) FROM gold_payables') + n(db, 'SELECT COUNT(*) FROM customer_gold_credits') + n(db, 'SELECT COUNT(*) FROM gold_movements')
    + n(db, 'SELECT COUNT(*) FROM precious_metals') === 0, '3 …nichts geschrieben');
  const pid = settle.insertGoldPayable('branch-main', { supplierId: 'sup-1', weightGrams: 10, karat: '24K' });
  ok(!!pid && s(db, 'SELECT karat FROM gold_payables WHERE id = ?', [pid]) === '24K', '3 Gold-Schuld in 24K weiterhin möglich');
  // Reparatur-Goldeinsatz über die Hausfolge (Primary und PC2).
  insert(db, 'repairs', { id: 'rep-1', branch_id: 'branch-main', repair_number: 'REP-1', customer_id: 'cust-1', status: 'received', created_at: NOW, updated_at: NOW });
  ok(code(() => goldHouse.recordRepairGoldUsageInHouse(ACTOR, { repairId: 'rep-1', source: 'workshop', karat: '925', receivedGrams: 5, supplierId: 'sup-1' } as never)) === 'GOLD_KARAT_UNKNOWN',
    '3 Reparatur-Goldeinsatz in 925 abgelehnt');
  ok(code(() => goldHouse.checkMaterialRows([{ materialKind: 'gold', description: 'x', weightGrams: 2, karat: '950', totalCost: 10, supplierId: 'sup-1' } as never], 'branch-main', true)) === 'GOLD_KARAT_UNKNOWN',
    '3 Reparatur-Material Gold in 950 abgelehnt');
}

// ══ 4 — Precious Metals: Feinheit muss zum Metall passen ═══════════════════════════
{
  const db = neu();
  db.run("INSERT INTO settings (key, value, branch_id, updated_at) VALUES ('spot_price.gold', '50', 'branch-main', ?)", [NOW]);
  const mk = (metalType: string, karat: string) => code(() => metalHouse.createMetalInHouse({ metalType, karat, weightGrams: 100 } as never, 'branch-main'));
  ok(mk('gold', '925') === 'METAL_KARAT_INVALID' && mk('gold', '999') === 'METAL_KARAT_INVALID' && mk('silver', '24K') === 'METAL_KARAT_INVALID'
    && mk('platinum', '925') === 'METAL_KARAT_INVALID', '4 Anlage: gold/925, gold/999, silver/24K, platinum/925 abgelehnt');
  ok(mk('gold', '24K') === '' && mk('silver', '925') === '' && mk('platinum', '950') === '', '4 Anlage: gold/24K, silver/925, platinum/950 angenommen');
  const melt = n(db, "SELECT melt_value FROM precious_metals WHERE metal_type = 'gold' AND karat = '24K'");
  ok(melt === 4995, `4 Schmelzwert 100 g 24K bei 50 BHD/g = 4,995.000 (vorher 5,000) (${melt})`);
  // Gespeicherte Schmelzwerte werden nicht nachträglich neu gerechnet.
  db.run("UPDATE precious_metals SET melt_value = 5000 WHERE metal_type = 'gold'");
  useMetalStore.getState().loadMetals();
  ok(n(db, "SELECT melt_value FROM precious_metals WHERE metal_type = 'gold'") === 5000, '4 …ein alter gespeicherter Wert bleibt stehen');
  const goldId = s(db, "SELECT id FROM precious_metals WHERE metal_type = 'gold'");
  ok(code(() => useMetalStore.getState().updateMetal(goldId, { karat: '925' } as never)) === 'METAL_KARAT_INVALID', '4 Ändern: Gold-Posten auf 925 abgelehnt');
  ok(code(() => useMetalStore.getState().updateMetal(goldId, { metalType: 'silver' } as never)) === 'METAL_KARAT_INVALID', '4 Ändern: Gold-Posten (24K) zu Silber abgelehnt');
  ok(s(db, 'SELECT karat FROM precious_metals WHERE id = ?', [goldId]) === '24K', '4 …nichts geändert');
}

// ══ 5 — Feingold-Summe: nur Gold ════════════════════════════════════════════════
{
  const db = neu();
  for (const [id, type, karat, g] of [['pm1', 'gold', '24K', 100], ['pm2', 'gold', '22K', 50], ['pm3', 'silver', '925', 500], ['pm4', 'silver', '999', 200], ['pm5', 'platinum', '950', 10]] as Array<[string, string, string, number]>) {
    insert(db, 'precious_metals', { id, branch_id: 'branch-main', metal_type: type, karat, weight_grams: g, status: 'in_stock', created_at: NOW, updated_at: NOW });
  }
  const t = useGoldStore.getState().getPureGoldTotal();
  ok(t.totalGrams === 150 && g3(t.pureAuGrams) === g3(99.9 + 45.8), `5 Feingold nur aus Gold: 150 g → ${g3(99.9 + 45.8)} g (vorher +710 g Silber/Platin) (${t.totalGrams}/${g3(t.pureAuGrams)})`);
  ok(t.perKarat.every((r) => ['24K', '22K'].includes(r.karat)), `5 …nur Gold-Karate in der Aufstellung (${t.perKarat.map((r) => r.karat).join()})`);
  // Die Gold-Store-Aufstellungen rechnen unverändert (24K .999, 22K .916).
  settle.insertGoldPayable('branch-main', { supplierId: 'sup-1', weightGrams: 100, karat: '24K' });
  settle.insertGoldPayable('branch-main', { supplierId: 'sup-1', weightGrams: 100, karat: '22K' });
  const top = useGoldStore.getState().getTopSuppliersByGoldOwed(5);
  ok(top.length === 1 && g3(top[0].pureAuGrams) === g3(99.9 + 91.6), `5 Top-Lieferanten Feingold 191.500 g (unverändert) (${S(top.map((x) => g3(x.pureAuGrams)))})`);
  settle.insertCustomerGoldCredit('branch-main', { customerId: 'cust-1', weightGrams: 100, karat: '21K' } as never);
  const topC = useGoldStore.getState().getTopCustomersByGoldCredit(5);
  ok(topC.length === 1 && g3(topC[0].pureAuGrams) === 87.5, `5 Top-Kunden Feingold 87.500 g (unverändert) (${S(topC.map((x) => g3(x.pureAuGrams)))})`);
}

// ══ 6 — Quelltext: keine zweite Tabelle, kein stilles 1,0 ═════════════════════════
{
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(f)) out.push(p); }
    return out;
  };
  const copies = walk(resolvePath(repo, 'src')).filter((p) => !/admin[\\/]RepairFlowTestPage/.test(p) && !/gold[\\/]purity\.ts$/.test(p))
    .filter((p) => /'24K':\s*[01]\.\d/.test(readFileSync(p, 'utf8')));
  ok(copies.length === 0, `6 keine eigene Reinheitstabelle außerhalb von purity.ts (${S(copies.map((p) => p.slice(repo.length + 1)))})`);
  const ml = src('src/pages/metals/MetalList.tsx');
  ok(!/METAL_PURITY/.test(ml) && /metalPurity\(form\.metalType \|\| 'gold', k\)/.test(ml), '6 MetalList zeigt die Feinheit je Metall');
  ok(/purity === null \? 0/.test(src('src/core/metals/metal-house.ts')), '6 meltValueOf: fremde Feinheit → 0, nicht 1');
  ok(!/purityOf\(/.test(src('src/components/work-orders/AddMaterialModal.tsx')) && !/purityOf\(/.test(src('src/pages/orders/OrderCreate.tsx')),
    '6 Masken bewerten über goldPurity (ohne Gold-Karat keine Auto-Bewertung)');
  ok(/metal_type = 'gold' AND karat IS NOT NULL/.test(src('src/stores/goldStore.ts')), '6 getPureGoldTotal filtert auf Gold');
}

console.log(`\npurity-metal-domain: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
