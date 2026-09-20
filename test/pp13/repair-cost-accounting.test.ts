// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY PP-13 + PP-14 — Reparaturkosten: EINE Domain, zwei Buchungsverträge.
// Run: node test/pp13/repair-cost-accounting.test.ts
//
// Eigene Ware:  Werkstatt/eigene Arbeit 100, Verkauf 300 → Einstand 100, INVENTORY +100 → 0, COGS 100, Gewinn 200.
// Kundenware:   Werkstatt/eigene Arbeit 100, Rechnung 300 → kein Bestand, COGS 100 (einmal), Gewinn 200.
// Jeweils im Hauptbuch (REVENUE − COGS − EXPENSES_OPERATING) UND in den Berichten (Marge − Betriebsausgaben).
//   §0 die Domain (repairCostParts) — ein Teil, eine Ausgabe
//   §1–§8 eigene Ware: Zeilen- und Einzelweg, hybrid, Wiederholung, Fehlerinjektion, Storno, Riegel, eigene Arbeit
//   §11–§17 Kundenware: Werkstatt unbezahlt/bezahlt, eigene Arbeit, Direktzahlung, Storno, verlorene Antwort, Fehlerinjektion
//   §10 Verdrahtung, Registry 175
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // Gestellt wird nur die IPC-Grenze zu Rust (Zwischenablage) und die echte Testdatenbank.
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
const { tauriState, stageForTest } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
await import('../../src/core/bridge/return-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const cmd = await import('../../src/core/bridge/service-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const house = await import('../../src/core/repairs/repair-house.ts');
const rules = await import('../../src/core/repairs/repair-rules.ts');
const { R4C_MATRIX } = await import('../uiparity/_r4c-write-matrix.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NOW = '2026-09-10T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function row(db: Db, sql: string, p: unknown[] = []): Record<string, unknown> {
  const r = db.exec(sql, p)[0];
  if (!r || r.values.length === 0) return {};
  return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
}
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Eine Zeile anlegen, deren Pflichtspalten ohne Vorgabe sinnvoll gefüllt werden. */
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
  useProductStore.getState().loadCategories();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useRepairStore.getState().loadRepairs();
  useRepairStore.getState().loadRepairLines();
  useSupplierStore.getState().loadSuppliers();
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
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  for (const [id, branch] of [['cat-w', 'branch-main'], ['cat-watch', 'branch-main'], ['cat-foreign', 'branch-other']]) {
    db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,'w','#000',?,?)",
      [id, branch, id, NOW, NOW]);
  }
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'], ['cust-x', 'Fremd', 'branch-other']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch] of [['sup-1', 'branch-main'], ['sup-other', 'branch-other']]) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,1,?,?)',
      [id, branch, 'Werkstatt ' + id, NOW, NOW]);
  }
  for (const [id, branch, st] of [['emp-1', 'branch-main', 'active'], ['emp-gone', 'branch-main', 'inactive'], ['emp-x', 'branch-other', 'active']]) {
    insert(db, 'employees', { id, branch_id: branch, name: 'M ' + id, employment_status: st, created_at: NOW, updated_at: NOW });
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (const [id, branch, source, stock] of [
    ['p1', 'branch-main', 'OWN', 'in_stock'], ['p2', 'branch-main', 'OWN', 'in_stock'],
    ['p-cons', 'branch-main', 'CONSIGNMENT', 'consignment'], ['p-foreign', 'branch-other', 'OWN', 'in_stock'],
    ['svc-repair-branch-main', 'branch-main', 'OWN', 'in_stock'],
  ]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,'cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
    [id, branch, 'M ' + id, 'SKU-' + id, stock, source, NOW, NOW]);
    // Der Service-Artikel der Reparaturrechnung hat — wie im Haus — keine Lose.
    if (id.startsWith('svc-repair-')) continue;
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,?,?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, branch, id, NOW, NOW]);
  }
  reload();
  tauriState.reset();
  return db;
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const OWNER = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
const val = <T>(o: unknown): T => (o as { value: T }).value;
const code = (o: unknown): string => (o as { code?: string }).code ?? '';
const frozen = (o: unknown): boolean => (o as { frozen?: boolean }).frozen === true;
const rev = (db: Db, id: string): number => n(db, 'SELECT revision FROM repairs WHERE id = ?', [id]);

const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 37 + i * 11) & 0xff);
const alsDataUrl = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const ablegen = async (urls: string[]): Promise<string[]> =>
  urls.map((u) => stageForTest(Uint8Array.from(Buffer.from(u.split(',')[1], 'base64')), OWNER));

/** Die fachlich relevanten Spalten einer Reparatur — ohne Kennung, Nummern und Zeitpunkte. */
const COLS = [
  'repair_scope', 'customer_id', 'product_id', 'lot_id', 'item_category_id', 'item_attributes', 'tax_scheme',
  'item_brand', 'item_model', 'item_reference', 'item_serial', 'item_description', 'issue_description',
  'diagnosis', 'repair_type', 'external_vendor', 'workshop_supplier_id', 'estimated_cost', 'actual_cost',
  'internal_cost', 'charge_to_customer', 'margin', 'status', 'estimated_ready', 'notes', 'images', 'staff_id',
  'customer_paid_from', 'customer_card_brand', 'internal_paid_from', 'customer_paid_amount',
  'customer_payment_status', 'customer_payment_method',
].join(', ');
const bildDerReparatur = (db: Db, id: string) => ({
  zeile: row(db, `SELECT ${COLS} FROM repairs WHERE id = ?`, [id]),
  arbeit: all(db, 'SELECT position, supplier_id, work_type, cost_amount, status FROM repair_lines WHERE repair_id = ? ORDER BY position', [id]),
  nummer: s(db, 'SELECT repair_number FROM repairs WHERE id = ?', [id]),
});

// ══ POST-PARITY PP-13 + PP-14 ═══════════════════════════════════════════════
const payables = await import('../../src/core/payables/payables-house.ts');
const types = await import('../../src/core/models/types.ts');
const costs = await import('../../src/core/repairs/repair-cost.ts');
const invCancel = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { useExpenseStore } = await import('../../src/stores/expenseStore.ts');
const rs = () => useRepairStore.getState();
const S = (v: unknown): string => JSON.stringify(v);
const saldo = (db: Db, a: string): number => n(db,
  "SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = ?", [a]);
const PC2 = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
let seq = 700;
const idC = (op: string, x = String(++seq)) => ({ commandId: ID('7' + x), ...PC2, op, payloadHash: 'pp13-' + op + x });
type Weg = 'P' | 'C';
interface Aus { ok: boolean; code: string; replayed: boolean; frozen: boolean }
async function fern(fn: () => Promise<unknown>): Promise<Aus> {
  try {
    const o = await fn() as { kind: string; code?: string; replayed?: boolean; frozen?: boolean };
    return { ok: o.kind === 'ok', code: o.code ?? '', replayed: o.replayed === true, frozen: o.frozen === true };
  } catch (e) { return { ok: false, code: String((e as Error).message), replayed: false, frozen: false }; }
}
async function lokal(fn: () => Promise<unknown>): Promise<Aus> {
  try { await fn(); return { ok: true, code: '', replayed: false, frozen: false }; } catch (e) {
    return { ok: false, code: String((e as { code?: string }).code ?? (e as Error).message), replayed: false, frozen: false };
  }
}
/** Ein Schritt am Store in einer Ledger-Klammer (wie das Haus) — für Vorbereitungen ohne eigene Maske. */
function amStore<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; } catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function welt(): Db {
  const db = freshDb();
  db.run("UPDATE products SET purchase_price = 0 WHERE id = 'p1'");
  db.run("UPDATE stock_lots SET unit_cost = 0 WHERE product_id = 'p1'");
  reload();
  return db;
}
const WERKSTATT = { repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 100 };
async function eigene(form: Record<string, unknown>): Promise<string> {
  return (await house.createRepairOnPrimary({
    repairScope: 'OWN', productId: 'p1', lotId: 'lot-p1', issueDescription: 'Service', ...form,
  } as never)).id;
}
async function kunde(form: Record<string, unknown>): Promise<string> {
  return (await house.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Service', chargeToCustomer: 300, taxScheme: 'ZERO', ...form,
  } as never)).id;
}
async function status(weg: Weg, db: Db, id: string, st: string, x?: string): Promise<Aus> {
  rs().loadRepairs();
  if (weg === 'P') return lokal(() => house.updateRepairStatusOnPrimary(id, st as never));
  return fern(() => life.runUpdateRepairStatus(deps(db) as never, idC('repairs.update_status', x) as never,
    { repairId: id, status: st, expectedRevision: rev(db, id) }));
}
async function zeile(weg: Weg, db: Db, id: string, cost: number): Promise<Aus> {
  if (weg === 'P') return lokal(() => house.addRepairLineOnPrimary(id, { supplierId: 'sup-1', workType: 'service' as never, costAmount: cost }));
  return fern(() => life.runAddRepairLine(deps(db) as never, idC('repairs.add_line') as never,
    { repairId: id, expectedRevision: rev(db, id), supplierId: 'sup-1', workType: 'service', costAmount: cost }));
}
async function storno(weg: Weg, db: Db, id: string, lineId: string): Promise<Aus> {
  if (weg === 'P') return lokal(() => house.cancelRepairLineOnPrimary(lineId));
  return fern(() => life.runCancelRepairLine(deps(db) as never, idC('repairs.cancel_line') as never,
    { repairId: id, lineId, expectedRevision: rev(db, id) }));
}
async function abrechnen(weg: Weg, db: Db, id: string, x?: string): Promise<{ aus: Aus; invId: string }> {
  rs().loadRepairs();
  const aus = weg === 'P'
    ? await lokal(() => house.invoiceRepairsOnPrimary([id], { taxScheme: 'ZERO' } as never))
    : await fern(() => life.runCreateRepairInvoice(deps(db) as never, idC('repairs.create_invoice', x) as never,
      { repairs: [{ repairId: id, expectedRevision: rev(db, id) }], taxScheme: 'ZERO', specialMark: false }));
  return { aus, invId: s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [id]) };
}
const ersteZeile = (db: Db, id: string): string => s(db, 'SELECT id FROM repair_lines WHERE repair_id = ? ORDER BY position LIMIT 1', [id]);
function bezahlen(db: Db): void {
  for (const e of db.exec("SELECT id, amount - paid_amount FROM expenses WHERE status != 'CANCELLED' AND amount > paid_amount")[0]?.values ?? []) {
    amStore(() => payables.recordExpensePaymentInHouse(String(e[0]), Number(e[1]), 'cash', { branchId: 'branch-main', userId: 'user-test', now: NOW }));
  }
}
function verkaufen(db: Db): string {
  reload();
  const pp = n(db, "SELECT purchase_price FROM products WHERE id = 'p1'");
  return useInvoiceStore.getState().createDirectInvoice('cust-1', [{ productId: 'p1', lotId: 'lot-p1', quantity: 1, unitPrice: 300,
    purchasePrice: pp, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 300 }], 'PP-13').id;
}
const operativ = (db: Db): number => (db.exec("SELECT category, amount FROM expenses WHERE status != 'CANCELLED'")[0]?.values ?? [])
  .filter((v) => !types.isCapitalizedExpenseCategory(String(v[0]))).reduce((a, v) => a + Number(v[1]), 0);
const buchGewinn = (db: Db): number => Math.round((-saldo(db, 'REVENUE') - saldo(db, 'COGS') - saldo(db, 'EXPENSES_OPERATING')) * 1000) / 1000;
/** Rohertrag im Hauptbuch (Erlös − Wareneinsatz) — die Größe der Marge in den Berichten. */
const brutto = (db: Db): number => Math.round((-saldo(db, 'REVENUE') - saldo(db, 'COGS')) * 1000) / 1000;
const eigenleistung = (db: Db): number => n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'REPAIR_OWN_WORK'");
/** Einstand, Los, Ausgaben und die Konten — ohne Kennungen und Zeitpunkte. */
function stand(db: Db) {
  return {
    einstand: n(db, "SELECT purchase_price FROM products WHERE id = 'p1'"),
    los: n(db, "SELECT unit_cost FROM stock_lots WHERE id = 'lot-p1'"),
    exp: all(db, "SELECT category, amount, paid_amount, status, supplier_id, related_module FROM expenses WHERE status != 'CANCELLED' ORDER BY created_at, id"),
    INVENTORY: saldo(db, 'INVENTORY'), AP: -saldo(db, 'ACCOUNTS_PAYABLE'), EXP_OP: saldo(db, 'EXPENSES_OPERATING'), CASH: saldo(db, 'CASH'),
    COGS: saldo(db, 'COGS'),
  };
}
/** Der Verkauf 300 eigener Ware: Wareneinsatz, Marge, Betriebsausgaben — Gewinn in Hauptbuch und Berichten. */
function gewinn(db: Db, invId: string) {
  const snap = n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [invId]);
  return { snap, marge: 300 - snap, operativ: operativ(db), berichte: 300 - snap - operativ(db), buch: buchGewinn(db), COGS: saldo(db, 'COGS'), INVENTORY: saldo(db, 'INVENTORY') };
}
/** Die Kundenreparatur: Rechnung (falls da), Marge der Reparatur, Konten, Gewinn in Hauptbuch und Berichten. */
function kundenStand(db: Db, id: string) {
  const invId = s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [id]);
  const inv = invId ? row(db, 'SELECT margin_snapshot, purchase_price_snapshot, status FROM invoices WHERE id = ?', [invId]) : {};
  const margin = n(db, 'SELECT margin FROM repairs WHERE id = ?', [id]);
  const aktiv = invId && inv.status !== 'CANCELLED';
  return {
    exp: all(db, "SELECT category, amount, paid_amount, status, supplier_id, related_module FROM expenses WHERE status != 'CANCELLED' ORDER BY created_at, id"),
    REVENUE: -saldo(db, 'REVENUE'), COGS: saldo(db, 'COGS'), INVENTORY: saldo(db, 'INVENTORY'), AP: -saldo(db, 'ACCOUNTS_PAYABLE'),
    EXP_OP: saldo(db, 'EXPENSES_OPERATING'), CASH: saldo(db, 'CASH'), margin,
    invEinstand: aktiv ? Number(inv.purchase_price_snapshot) : null, invMarge: aktiv ? Number(inv.margin_snapshot) : null,
    buch: buchGewinn(db), berichte: (aktiv ? Number(inv.margin_snapshot) : margin) - operativ(db),
  };
}
const EXP_OWN_100 = S([['Inventory', 100, 0, 'PENDING', 'sup-1', 'repair']]);
const EXP_KUNDE_100 = S([['RepairServiceCost', 100, 0, 'PENDING', 'sup-1', 'repair']]);
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END)
    FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.every((r) => Number(r[1]) === Number(r[2]));
}
const M: Record<string, boolean> = {};

// ── §0 die Domain: ein Teil, eine Ausgabe ────────────────────────────────
{
  const p = costs.repairCostParts;
  const f = (r: Record<string, unknown>, l = 0) => S(p(r as never, l));
  ok(f({ repairType: 'external', internalCost: 100, estimatedCost: 100, workshopSupplierId: 'sup-1' }, 100) === S({ own: 0, lines: 100, fee: 0, total: 100 }),
    '§0 external + Werkstattzeile: der gespiegelte internalCost zählt NICHT neben der Zeile');
  ok(f({ repairType: 'external', internalCost: 100, estimatedCost: 100, workshopSupplierId: 'sup-1' }) === S({ own: 0, lines: 0, fee: 100, total: 100 }),
    '§0 Altbestand (Werkstatt ohne Zeile): die Gebühr, genau einmal');
  ok(f({ repairType: 'external', internalCost: 100, estimatedCost: 100 }) === S({ own: 0, lines: 0, fee: 0, total: 0 }),
    '§0 ohne Zeile und ohne Werkstatt ist ein Voranschlag keine Kosten (kein Einstand/keine Marge aus dem Spiegel)');
  ok(f({ repairType: 'hybrid', internalCost: 10, estimatedCost: 100, workshopSupplierId: 'sup-1' }, 100) === S({ own: 10, lines: 100, fee: 0, total: 110 }),
    '§0 hybrid: eigene Arbeit + Zeile');
  ok(f({ repairType: 'internal', internalCost: 100 }, 30) === S({ own: 100, lines: 30, fee: 0, total: 130 }),
    '§0 internal: eigene Arbeit + Zeilen im Haus');
  M.domain = fails.length === 0;
}

// ── §1 eigene Ware, Zeilenweg unbezahlt — Primary == PC2 ────────────────
{
  const bilder: Record<Weg, unknown[]> = { P: [], C: [] };
  for (const weg of ['P', 'C'] as Weg[]) {
    const db = welt();
    const id = await eigene(WERKSTATT);
    const a = await status(weg, db, id, 'in_progress');
    const b1 = stand(db);
    const c = await status(weg, db, id, 'ready');
    const b2 = stand(db);
    const g = gewinn(db, verkaufen(db));
    bilder[weg] = [b1, b2, g];
    ok(a.ok && c.ok, `§1 ${weg} „in Arbeit" und „ready" angenommen (${a.code}/${c.code})`);
    ok(b1.exp === EXP_OWN_100 && b1.INVENTORY === 100 && b1.AP === 100 && b1.EXP_OP === 0 && b1.einstand === 0,
      `§1 ${weg} Werkstattschuld: EINE Ausgabe „Inventory" 100, Soll INVENTORY / Haben A/P, KEIN Aufwand (${S(b1)})`);
    ok(b2.einstand === 100 && b2.los === 100 && b2.INVENTORY === 100 && b2.AP === 100 && b2.EXP_OP === 0 && b2.exp === EXP_OWN_100,
      `§1 ${weg} „ready": Artikel + Los 100, keine zweite Ausgabe (${S(b2)})`);
    ok(g.snap === 100 && g.COGS === 100 && g.INVENTORY === 0 && g.buch === 200 && g.berichte === 200 && g.operativ === 0 && balanced(db),
      `§1 ${weg} Verkauf 300: COGS 100, INVENTORY 0, Gewinn Hauptbuch 200 == Berichte 200 (${S(g)})`);
    ok(s(db, 'SELECT created_by FROM expenses') === (weg === 'P' ? 'user-test' : 'user-pc2'),
      `§1 ${weg} Akteur der Werkstattschuld (${s(db, 'SELECT created_by FROM expenses')})`);
  }
  ok(S(bilder.P) === S(bilder.C), `§1 PARITÄT Primary == PC2\n  P=${S(bilder.P)}\n  C=${S(bilder.C)}`);
}

// ── §2 eigene Ware bezahlt: nur Soll A/P / Haben Kasse ───────────────────
{
  const db = welt();
  const id = await eigene(WERKSTATT);
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  const vor = stand(db);
  bezahlen(db);
  const b = stand(db);
  ok(b.einstand === vor.einstand && b.los === vor.los && b.INVENTORY === 100 && b.AP === 0 && b.CASH === -100 && b.EXP_OP === 0
    && b.exp === S([['Inventory', 100, 100, 'PAID', 'sup-1', 'repair']]),
    `§2 Zahlung: nur A/P −100 / Kasse −100; Einstand 100 wie unbezahlt (${S(b)})`);
  const g = gewinn(db, verkaufen(db));
  ok(g.buch === 200 && g.berichte === 200 && g.COGS === 100, `§2 Verkauf 300: Gewinn 200 (${S(g)})`);
}

// ── §3 eigene Ware, Einzelweg (Werkstatt ohne Kostenzeile, Altbestand) ──
{
  const bilder: Record<Weg, unknown[]> = { P: [], C: [] };
  for (const weg of ['P', 'C'] as Weg[]) {
    const db = welt();
    const id = await eigene({ repairType: 'internal', internalCost: 100 });
    amStore(() => { rs().loadRepairs(); rs().updateRepair(id, { repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 100 }); });
    const lines = n(db, 'SELECT COUNT(*) FROM repair_lines WHERE repair_id = ?', [id]);
    const a = await status(weg, db, id, 'in_progress');
    const c = await status(weg, db, id, 'ready');
    const b = stand(db);
    const g = gewinn(db, verkaufen(db));
    bilder[weg] = [b, g];
    ok(lines === 0 && a.ok && c.ok, `§3 ${weg} Einzelweg ohne Zeile angenommen (${lines} Zeilen, ${a.code}/${c.code})`);
    ok(b.einstand === 100 && b.los === 100 && b.INVENTORY === 100 && b.AP === 100 && b.EXP_OP === 0 && b.exp === EXP_OWN_100,
      `§3 ${weg} Werkstattgebühr bei „ready": „Inventory" 100, dieselbe Regel wie der Zeilenweg (${S(b)})`);
    ok(g.buch === 200 && g.berichte === 200, `§3 ${weg} Verkauf 300: Gewinn 200 (${S(g)})`);
  }
  ok(S(bilder.P) === S(bilder.C), '§3 PARITÄT Einzelweg Primary == PC2');
}

// ── §3b hybrid: eigene Arbeit + Werkstatt, der Voranschlag wird nicht gespiegelt ──
for (const [own, soll] of [[0, 100], [10, 110]] as Array<[number, number]>) {
  const db = welt();
  const id = await eigene({ repairType: 'hybrid', workshopSupplierId: 'sup-1', estimatedCost: 100, ...(own ? { internalCost: own } : {}) });
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  const b = stand(db);
  const g = gewinn(db, verkaufen(db));
  ok(n(db, 'SELECT internal_cost FROM repairs WHERE id = ?', [id]) === own && b.einstand === soll && b.INVENTORY === soll && b.EXP_OP === -own
    && b.AP === 100 && brutto(db) === 300 - soll && g.marge === 300 - soll && g.INVENTORY === 0,
    `§3b hybrid, eigene Arbeit ${own} + Werkstatt 100: Einstand = INVENTORY ${soll} (nicht ${soll + 100}); A/P nur die Werkstatt (100), die eigene Arbeit als Eigenleistung (${-own}); Rohertrag ${300 - soll} == Marge (${S(b)} ${S(g)})`);
}

// ── §4 Wiederholung / verlorene Antwort — genau EINE Kostenwirkung ───────
{
  const db = welt();
  const id = await eigene(WERKSTATT);
  await status('C', db, id, 'in_progress');
  const a = await status('C', db, id, 'ready', 'LOST1');
  const b = await status('C', db, id, 'ready', 'LOST1');
  const e1 = stand(db);
  const c = await status('C', db, id, 'ready');
  ok(a.ok && b.ok && (b.replayed || b.frozen) && e1.einstand === 100 && e1.los === 100 && e1.INVENTORY === 100,
    `§4 PC2 verlorene Antwort: dieselbe Kennung → eingefroren, Einstand 100 (nicht 200) (${S(b)} ${S(e1)})`);
  ok(!c.ok && c.code === 'REPAIR_TRANSITION_NOT_ALLOWED' && stand(db).einstand === 100,
    `§4 PC2 ein neuer „ready"-Auftrag: Nein (${c.code}), Einstand bleibt 100`);
  const db2 = welt();
  const id2 = await eigene(WERKSTATT);
  await status('P', db2, id2, 'in_progress');
  await status('P', db2, id2, 'ready');
  await status('P', db2, id2, 'ready');
  ok(stand(db2).einstand === 100 && n(db2, 'SELECT COUNT(*) FROM expenses') === 1,
    '§4 Primary „ready" zweimal: genau EINE Kapitalisierung, eine Werkstattschuld');
}

// ── §5 Fehlerinjektion eigene Ware: nichts Halbes ───────────────────────
for (const weg of ['P', 'C'] as Weg[]) {
  {
    const db = welt();
    const id = await eigene(WERKSTATT);
    db.run("CREATE TRIGGER pp13_led BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT, 'pp13 injected'); END;");
    const a = await status(weg, db, id, 'in_progress');
    db.run('DROP TRIGGER pp13_led');
    ok(!a.ok && s(db, 'SELECT status FROM repairs WHERE id = ?', [id]) === 'received' && n(db, 'SELECT COUNT(*) FROM expenses') === 0
      && n(db, 'SELECT COUNT(*) FROM repair_lines WHERE expense_id IS NOT NULL') === 0 && n(db, 'SELECT COUNT(*) FROM ledger_entries') === 0,
      `§5 ${weg} Buchung der Werkstattschuld scheitert (im Store abgefangen) → ganze Handlung zurück`);
    const b = await status(weg, db, id, 'in_progress');
    ok(b.ok && stand(db).exp === EXP_OWN_100, `§5 ${weg} …der zweite Versuch bucht genau einmal`);
  }
  {
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    db.run("CREATE TRIGGER pp13_lot BEFORE UPDATE ON stock_lots BEGIN SELECT RAISE(ABORT, 'pp13 injected'); END;");
    const a = await status(weg, db, id, 'ready');
    db.run('DROP TRIGGER pp13_lot');
    const b = stand(db);
    ok(!a.ok && s(db, 'SELECT status FROM repairs WHERE id = ?', [id]) === 'in_progress' && !s(db, 'SELECT completed_at FROM repairs WHERE id = ?', [id])
      && b.einstand === 0 && b.los === 0 && b.INVENTORY === 100 && b.exp === EXP_OWN_100,
      `§5 ${weg} Kapitalisierung scheitert am Los → Artikel, Status und completed_at unberührt (${S(b)})`);
    const c = await status(weg, db, id, 'ready');
    ok(c.ok && stand(db).einstand === 100, `§5 ${weg} …der zweite Versuch kapitalisiert genau einmal`);
  }
}

// ── §6 Storno / Rücknahme eigene Ware ─────────────────────────────────────
for (const weg of ['P', 'C'] as Weg[]) {
  { // vor „ready"
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    const a = await storno(weg, db, id, ersteZeile(db, id));
    const b = stand(db);
    const c = await status(weg, db, id, 'ready');
    const e = stand(db);
    ok(a.ok && b.exp === '[]' && b.INVENTORY === 0 && b.AP === 0 && c.ok && e.einstand === 0 && e.los === 0 && e.exp === '[]' && e.INVENTORY === 0,
      `§6 ${weg} Storno vor „ready": Schuld gegengebucht, danach „ready" ohne Kosten (${S(b)} ${S(e)})`);
  }
  { // nach „ready", unbezahlt
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    const a = await storno(weg, db, id, ersteZeile(db, id));
    const b = stand(db);
    ok(a.ok && b.einstand === 0 && b.los === 0 && b.INVENTORY === 0 && b.AP === 0 && b.EXP_OP === 0 && b.exp === '[]',
      `§6 ${weg} Storno nach „ready", unbezahlt: Einstand, Los, INVENTORY und A/P gemeinsam zurück (${S(b)})`);
    ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'products'") > 0, `§6 ${weg} …die Rücknahme reist mit dem Artikel`);
  }
  { // nach „ready", bezahlt
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    bezahlen(db);
    const vor = stand(db);
    const a = await storno(weg, db, id, ersteZeile(db, id));
    ok(!a.ok && a.code === 'REPAIR_COST_PAID' && S(stand(db)) === S(vor), `§6 ${weg} Storno einer BEZAHLTEN Zeile: Nein (${a.code}), nichts geschrieben`);
  }
  { // Artikel verkauft
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    const inv = verkaufen(db);
    const vor = stand(db);
    const a = await storno(weg, db, id, ersteZeile(db, id));
    const z = await zeile(weg, db, id, 50);
    ok(!a.ok && a.code === 'REPAIR_COST_ALREADY_SOLD' && !z.ok && z.code === 'REPAIR_COST_ALREADY_SOLD' && S(stand(db)) === S(vor) && gewinn(db, inv).buch === 200,
      `§6 ${weg} nach dem Verkauf: Storno UND neue Zeile = Nein (${a.code}/${z.code}), Einstand/COGS unberührt, Gewinn 200`);
  }
  { // Zeile nach „ready"
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    const a = await zeile(weg, db, id, 50);
    const b = stand(db);
    ok(a.ok && b.einstand === 150 && b.los === 150 && b.INVENTORY === 150 && b.AP === 150 && b.EXP_OP === 0,
      `§6 ${weg} Zeile 50 nach „ready": sofort im Einstand (150) und auf INVENTORY/A/P (${S(b)})`);
    const neu = s(db, 'SELECT id FROM repair_lines WHERE repair_id = ? AND cost_amount = 50', [id]);
    const c = await storno(weg, db, id, neu);
    const e = stand(db);
    ok(c.ok && e.einstand === 100 && e.los === 100 && e.INVENTORY === 100 && e.AP === 100, `§6 ${weg} …ihr Storno nimmt genau 50 zurück (${S(e)})`);
    const g = gewinn(db, verkaufen(db));
    ok(g.buch === 200 && g.berichte === 200, `§6 ${weg} …Verkauf 300: Gewinn 200`);
  }
}
{ // Betrag einer Zeile nach „ready" geändert (PC2 — die Maske des Primary ändert keine Zeilenbeträge)
  const db = welt();
  const id = await eigene(WERKSTATT);
  await status('C', db, id, 'in_progress');
  await status('C', db, id, 'ready');
  const a = await fern(() => life.runUpdateRepairLine(deps(db) as never, idC('repairs.update_line') as never,
    { repairId: id, lineId: ersteZeile(db, id), expectedRevision: rev(db, id), costAmount: 120 }));
  const b = stand(db);
  ok(a.ok && b.einstand === 120 && b.los === 120 && b.INVENTORY === 120 && b.AP === 120 && b.EXP_OP === 0,
    `§6 PC2 Zeilenbetrag 100 → 120 nach „ready": Einstand und Schuld gemeinsam 120 (${a.code} ${S(b)})`);
}
{ // Reparatur gelöscht (Primary-only)
  const db = welt();
  const id = await eigene(WERKSTATT);
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  rs().loadRepairs();
  rs().deleteRepair(id);
  const b = stand(db);
  ok(b.einstand === 0 && b.los === 0 && b.INVENTORY === 0 && b.AP === 0, `§6 Reparatur gelöscht: Einstand und Schuld zurück (${S(b)})`);
  const db2 = welt();
  const id2 = await eigene(WERKSTATT);
  await status('P', db2, id2, 'in_progress');
  await status('P', db2, id2, 'ready');
  bezahlen(db2);
  const vor = stand(db2);
  rs().loadRepairs();
  let code = '';
  try { rs().deleteRepair(id2); } catch (e) { code = String((e as { code?: string }).code ?? ''); }
  ok(code === 'REPAIR_COST_PAID' && S(stand(db2)) === S(vor) && n(db2, 'SELECT COUNT(*) FROM repairs WHERE id = ?', [id2]) === 1,
    `§6 Reparatur mit bezahlter Werkstattschuld löschen: Nein (${code}), nichts geschrieben`);
}
M.pp13reversal = fails.length === 0;

// ── §7 Ausgaben-Riegel ───────────────────────────────────────────────────
{
  const db = welt();
  const id = await eigene(WERKSTATT);
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  const expId = s(db, 'SELECT id FROM expenses');
  const ctx = { branchId: 'branch-main', userId: 'user-test', now: NOW };
  const nein = (f: () => unknown): string => { try { f(); return ''; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); } };
  const vor = stand(db);
  ok(nein(() => payables.updateExpenseInHouse(expId, { amount: 50 }, ctx)) === 'EXPENSE_REPAIR_COST_LOCKED'
    && nein(() => payables.updateExpenseInHouse(expId, { category: 'Miscellaneous' }, ctx)) === 'EXPENSE_REPAIR_COST_LOCKED'
    && /cancel its repair line/.test(nein(() => useExpenseStore.getState().deleteExpense(expId)))
    && S(stand(db)) === S(vor),
    '§7 gebuchte Reparaturkosten: Betrag, Kategorie und Löschen nur über die Reparatur');
  ok(nein(() => payables.updateExpenseInHouse(expId, { description: 'Politur' }, ctx)) === '', '§7 …eine Beschreibung darf sie bekommen');
  ok(nein(() => payables.createExpenseFromIntent({ category: 'RepairServiceCost', amount: 5, paymentMethod: 'cash', expenseDate: '2026-09-10', timing: 'now' } as never, ctx)) === 'EXPENSE_CATEGORY_RESERVED',
    '§7 den Dienstleistungs-Einstand legt nur die Reparatur an');
}

// ── §8 eigene Ware ohne Werkstatt: eigene Arbeit auf den Bestand ────────
{
  const bilder: Record<Weg, unknown[]> = { P: [], C: [] };
  for (const weg of ['P', 'C'] as Weg[]) {
    const db = welt();
    const id = await eigene({ repairType: 'internal', internalCost: 100 });
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    const b = stand(db);
    const g = gewinn(db, verkaufen(db));
    bilder[weg] = [b, g];
    ok(b.einstand === 100 && b.los === 100 && b.exp === '[]' && b.INVENTORY === 100 && b.AP === 0 && b.CASH === 0 && b.EXP_OP === -100,
      `§8 ${weg} eigene Arbeit 100 ohne Zahlweg: KEINE Ausgabe, KEINE Verbindlichkeit, KEIN Geldfluss — aktivierte Eigenleistung Soll INVENTORY / Haben EXPENSES_OPERATING, Artikel + Los 100 (${S(b)})`);
    ok(g.COGS === 100 && g.INVENTORY === 0 && brutto(db) === 200 && g.marge === 200 && g.operativ === 0 && balanced(db),
      `§8 ${weg} Verkauf 300: COGS 100, INVENTORY 0, Rohertrag 200 == Marge 200 (${S(g)})`);
  }
  ok(S(bilder.P) === S(bilder.C), '§8 PARITÄT eigene Arbeit Primary == PC2');
  const db = welt();
  const id = await eigene({ repairType: 'internal', internalCost: 100 });
  amStore(() => { rs().loadRepairs(); rs().updateRepair(id, { internalPaidFrom: 'cash' }); });
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  const b = stand(db);
  const g = gewinn(db, verkaufen(db));
  ok(b.exp === S([['Inventory', 100, 100, 'PAID', null, 'repair']]) && b.INVENTORY === 100 && b.AP === 0 && b.CASH === -100 && g.buch === 200 && g.INVENTORY === 0
    && eigenleistung(db) === 0,
    `§8 eigene Kosten bar bezahlt (INTERNAL PAID FROM Cash): EINE Ausgabe, Soll INVENTORY / Haben Kasse (über A/P, netto 0), keine Eigenleistung, Gewinn 200 (${S(b)} ${S(g)})`);
  { // Gesamtbild: die eigene Arbeit steckt schon in einer gebuchten Betriebsausgabe (Lohn 100, bar) — sie wirkt genau einmal.
    const db2 = welt();
    amStore(() => payables.createExpenseInHouse({ category: 'Miscellaneous', amount: 100, paymentMethod: 'cash', expenseDate: '2026-09-10',
      initialPaid: 100, description: 'Lohn der eigenen Werkstatt' } as never, { branchId: 'branch-main', userId: 'user-test', now: NOW }));
    const id2 = await eigene({ repairType: 'internal', internalCost: 100 });
    await status('P', db2, id2, 'in_progress');
    await status('P', db2, id2, 'ready');
    const g2 = gewinn(db2, verkaufen(db2));
    ok(g2.buch === 200 && saldo(db2, 'EXPENSES_OPERATING') === 0 && saldo(db2, 'COGS') === 100 && saldo(db2, 'CASH') === -100 && -saldo(db2, 'ACCOUNTS_PAYABLE') === 0,
      `§8 Gesamtbild: Lohn 100 (gebucht) + eigene Arbeit aktiviert → Aufwand 0, COGS 100, Kasse −100 (der Lohn), keine Verbindlichkeit — Gewinn 200, der Betrag wirkt genau EINMAL (${S(g2)})`);
  }
  M.pp13internal = fails.length === 0;
}
M.pp13 = fails.length === 0;

// ── §11 Kundenreparatur + Werkstatt, unbezahlt — Primary == PC2 ─────────
{
  const bilder: Record<Weg, unknown[]> = { P: [], C: [] };
  for (const weg of ['P', 'C'] as Weg[]) {
    const db = freshDb();
    const id = await kunde(WERKSTATT);
    const a = await status(weg, db, id, 'in_progress');
    const k1 = kundenStand(db, id);
    const c = await status(weg, db, id, 'ready');
    const k2 = kundenStand(db, id);
    const r = await abrechnen(weg, db, id);
    const k3 = kundenStand(db, id);
    bilder[weg] = [k1, k2, k3];
    ok(a.ok && c.ok && r.aus.ok && !!r.invId, `§11 ${weg} in Arbeit, ready, Rechnung angenommen (${a.code}/${c.code}/${r.aus.code})`);
    ok(k1.exp === EXP_KUNDE_100 && k1.COGS === 100 && k1.AP === 100 && k1.EXP_OP === 0 && k1.INVENTORY === 0,
      `§11 ${weg} Werkstattschuld: EINE Ausgabe „RepairServiceCost" 100, Soll COGS / Haben A/P, kein Aufwand, kein Bestand (${S(k1)})`);
    ok(k2.margin === 200 && k2.exp === EXP_KUNDE_100, `§11 ${weg} „ready": Marge 200, keine zweite Ausgabe (${S(k2)})`);
    ok(k3.invEinstand === 100 && k3.invMarge === 200 && k3.REVENUE === 300 && k3.COGS === 100 && k3.INVENTORY === 0 && k3.EXP_OP === 0
      && k3.buch === 200 && k3.berichte === 200 && balanced(db),
      `§11 ${weg} Rechnung 300: Einstand 100 (nicht 200), KEIN zweiter Wareneinsatz, INVENTORY 0, Gewinn Hauptbuch 200 == Berichte 200 (${S(k3)})`);
    ok(s(db, 'SELECT created_by FROM expenses') === (weg === 'P' ? 'user-test' : 'user-pc2'), `§11 ${weg} Akteur der Werkstattschuld`);
  }
  ok(S(bilder.P) === S(bilder.C), `§11 PARITÄT Kundenreparatur Primary == PC2\n  P=${S(bilder.P)}\n  C=${S(bilder.C)}`);
}

// ── §12 Kundenreparatur bezahlt: die Zahlung ändert keinen Gewinn ───────
{
  const db = freshDb();
  const id = await kunde(WERKSTATT);
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  await abrechnen('P', db, id);
  const vor = kundenStand(db, id);
  bezahlen(db);
  const nach = kundenStand(db, id);
  ok(vor.buch === 200 && nach.buch === 200 && nach.berichte === 200 && nach.margin === vor.margin && nach.COGS === 100 && nach.AP === 0 && nach.CASH === -100,
    `§12 Werkstatt bezahlt: nur A/P −100 / Kasse −100; Marge, COGS und Gewinn (200) unverändert (${S(vor)} → ${S(nach)})`);
}

// ── §13 Kundenreparatur mit eigener Arbeit (bar bezahlt) ─────────────────
{
  const db = freshDb();
  const id = await kunde({ repairType: 'internal', internalCost: 100 });
  amStore(() => { rs().loadRepairs(); rs().updateRepair(id, { internalPaidFrom: 'cash' }); });
  await status('P', db, id, 'in_progress');
  const k0 = kundenStand(db, id);
  await status('P', db, id, 'ready');
  const k1 = kundenStand(db, id);
  await abrechnen('P', db, id);
  const k2 = kundenStand(db, id);
  ok(k0.exp === '[]' && k1.exp === S([['RepairServiceCost', 100, 100, 'PAID', null, 'repair']]) && k1.COGS === 100 && k1.CASH === -100 && k1.INVENTORY === 0,
    `§13 eigene Arbeit bei „ready": EINE Ausgabe, Soll COGS / Haben Kasse (über A/P), kein Bestand (${S(k1)})`);
  ok(k2.invEinstand === 100 && k2.buch === 200 && k2.berichte === 200 && k2.COGS === 100, `§13 Rechnung 300: Gewinn 200 (${S(k2)})`);
}

// ── §14 Kundenreparatur mit Direktzahlung (ohne Rechnung) ───────────────
{
  const db = freshDb();
  const id = await kunde(WERKSTATT);
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  amStore(() => { rs().loadRepairs(); rs().updateRepair(id, { customerPaidFrom: 'cash' }); });
  const k = kundenStand(db, id);
  ok(k.REVENUE === 300 && k.COGS === 100 && k.INVENTORY === 0 && k.margin === 200 && k.buch === 200 && k.berichte === 200,
    `§14 Direktzahlung 300: Erlös 300, COGS 100 (einmal), Gewinn 200 in Hauptbuch und Berichten (${S(k)})`);
}

// ── §15 Storno / Rücknahme Kundenreparatur ───────────────────────────────
for (const weg of ['P', 'C'] as Weg[]) {
  { // Zeile vor der Rechnung, unbezahlt
    const db = freshDb();
    const id = await kunde(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    const a = await storno(weg, db, id, ersteZeile(db, id));
    await status(weg, db, id, 'ready');
    const k = kundenStand(db, id);
    ok(a.ok && k.exp === '[]' && k.COGS === 0 && k.AP === 0 && k.margin === 300 && k.INVENTORY === 0,
      `§15 ${weg} Werkstattzeile vor der Rechnung storniert: Schuld und COGS zurück, „ready" ohne Kosten aus dem Spiegel (${S(k)})`);
  }
  { // nach der Rechnung
    const db = freshDb();
    const id = await kunde(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    await abrechnen(weg, db, id);
    const vor = kundenStand(db, id);
    const a = await storno(weg, db, id, ersteZeile(db, id));
    const z = await zeile(weg, db, id, 50);
    ok(!a.ok && a.code === 'REPAIR_ALREADY_INVOICED' && !z.ok && z.code === 'REPAIR_ALREADY_INVOICED' && S(kundenStand(db, id)) === S(vor),
      `§15 ${weg} nach der Rechnung: Storno und neue Zeile = Nein (${a.code}/${z.code}), nichts geschrieben`);
  }
  { // bezahlt vor der Rechnung
    const db = freshDb();
    const id = await kunde(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    bezahlen(db);
    const vor = kundenStand(db, id);
    const a = await storno(weg, db, id, ersteZeile(db, id));
    ok(!a.ok && a.code === 'REPAIR_COST_PAID' && S(kundenStand(db, id)) === S(vor), `§15 ${weg} bezahlte Werkstattzeile: Nein (${a.code}), keine verwaiste Zahlung`);
  }
}
{ // Rechnung storniert
  const db = freshDb();
  const id = await kunde(WERKSTATT);
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  const r = await abrechnen('P', db, id);
  const a = await lokal(() => invCancel.cancelInvoiceOnPrimary({ invoiceId: r.invId, refundMethod: 'cash' }));
  const k = kundenStand(db, id);
  ok(a.ok && s(db, 'SELECT status FROM invoices WHERE id = ?', [r.invId]) === 'CANCELLED' && k.REVENUE === 0 && k.COGS === 100 && k.AP === 100
    && k.INVENTORY === 0 && k.exp === EXP_KUNDE_100 && balanced(db) && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'invoices'") > 0,
    `§15 Rechnung storniert: Erlös zurück; die Werkstattarbeit bleibt EINE Kostenwirkung (COGS 100, A/P 100 an die Werkstatt), kein Bestand, keine negative Kosten, Protokoll (${a.code} ${S(k)})`);
}
{ // Kopfkosten nach „ready" geändert, danach abgerechnet
  const db = freshDb();
  const id = await kunde({ repairType: 'internal', internalCost: 100 });
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  amStore(() => { rs().loadRepairs(); rs().updateRepair(id, { internalCost: 120 }); });
  const k1 = kundenStand(db, id);
  ok(k1.exp === '[]' && k1.COGS === 120 && k1.margin === 180 && k1.AP === 0 && k1.EXP_OP === -120 && eigenleistung(db) === 6,
    `§15 eigene Kosten (ohne Zahlweg) 100 → 120 nach „ready": Eigenleistung storniert + neu gebucht (Soll COGS / Haben EXPENSES_OPERATING 120), keine Verbindlichkeit, Marge 180 (${S(k1)})`);
  await abrechnen('P', db, id);
  let code = '';
  try { amStore(() => { rs().loadRepairs(); rs().updateRepair(id, { internalCost: 130 }); }); } catch (e) { code = String((e as { code?: string }).code ?? ''); }
  const k2 = kundenStand(db, id);
  ok(code === 'REPAIR_ALREADY_INVOICED' && k2.invEinstand === 120 && k2.COGS === 120 && n(db, 'SELECT internal_cost FROM repairs WHERE id = ?', [id]) === 120,
    `§15 …nach der Rechnung: Nein (${code}), Einstand und COGS bleiben 120`);
  const db2 = freshDb();
  const id2 = await kunde({ repairType: 'internal', internalCost: 100 });
  amStore(() => { rs().loadRepairs(); rs().updateRepair(id2, { internalPaidFrom: 'cash' }); });
  await status('P', db2, id2, 'in_progress');
  await status('P', db2, id2, 'ready');
  let code2 = '';
  try { amStore(() => { rs().loadRepairs(); rs().updateRepair(id2, { internalCost: 50 }); }); } catch (e) { code2 = String((e as { code?: string }).code ?? ''); }
  ok(code2 === 'REPAIR_COST_PAID' && n(db2, 'SELECT internal_cost FROM repairs WHERE id = ?', [id2]) === 100 && kundenStand(db2, id2).COGS === 100,
    `§15 bezahlte eigene Kosten nach unten: Nein (${code2}), nichts geschrieben`);
}
M.pp14reversal = fails.length === 0;

// ── §16 Kundenreparatur: verlorene Antwort ───────────────────────────────
{
  const db = freshDb();
  const id = await kunde({ repairType: 'internal', internalCost: 100 });
  await status('C', db, id, 'in_progress');
  const a = await status('C', db, id, 'ready', 'LOSTK');
  const b = await status('C', db, id, 'ready', 'LOSTK');
  const r1 = await abrechnen('C', db, id, 'LOSTI');
  const r2 = await abrechnen('C', db, id, 'LOSTI');
  const k = kundenStand(db, id);
  ok(a.ok && b.ok && (b.replayed || b.frozen) && r1.aus.ok && r2.aus.ok && (r2.aus.replayed || r2.aus.frozen)
    && n(db, 'SELECT COUNT(*) FROM expenses') === 0 && eigenleistung(db) === 2 && n(db, 'SELECT COUNT(*) FROM invoices') === 1
    && k.COGS === 100 && brutto(db) === 200 && k.invMarge === 200,
    `§16 PC2 verlorene Antwort bei „ready" und bei der Rechnung: je eingefroren, EINE Eigenleistung (keine Ausgabe), EINE Rechnung, Rohertrag 200 (${S(k)})`);
  ok(s(db, "SELECT created_by FROM ledger_entries WHERE source_module = 'REPAIR_OWN_WORK' LIMIT 1") === 'user-pc2',
    `§16 Akteur der Eigenleistung: der geprüfte PC2-Absender (${s(db, "SELECT created_by FROM ledger_entries WHERE source_module = 'REPAIR_OWN_WORK' LIMIT 1")})`);
}

// ── §17 Kundenreparatur: Fehlerinjektion bei „ready" ────────────────────
for (const weg of ['P', 'C'] as Weg[]) {
  const db = freshDb();
  const id = await kunde({ repairType: 'internal', internalCost: 100 });
  await status(weg, db, id, 'in_progress');
  db.run("CREATE TRIGGER pp14_led BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT, 'pp14 injected'); END;");
  const a = await status(weg, db, id, 'ready');
  db.run('DROP TRIGGER pp14_led');
  ok(!a.ok && s(db, 'SELECT status FROM repairs WHERE id = ?', [id]) === 'in_progress' && n(db, 'SELECT COUNT(*) FROM expenses') === 0
    && n(db, 'SELECT COUNT(*) FROM ledger_entries') === 0 && !s(db, 'SELECT completed_at FROM repairs WHERE id = ?', [id]),
    `§17 ${weg} die Buchung der eigenen Kosten scheitert → „ready" ganz zurück (Status, Marge, completed_at, keine Buchung)`);
  const b = await status(weg, db, id, 'ready');
  ok(b.ok && eigenleistung(db) === 2 && n(db, 'SELECT COUNT(*) FROM expenses') === 0 && kundenStand(db, id).COGS === 100,
    `§17 ${weg} …der zweite Versuch bucht genau einmal`);
}
M.pp14 = fails.length === 0;

// ── §18 Abstimmung je Eigentumsart — Quelle == Hauptbuch == A/P/Kasse == Einstand == COGS == Berichte ──
// hybrid: eigene Kosten 20 + Werkstattzeile 100 (unbezahlt) + Zeile im Haus 30 = Quelle 150; Preis 300.
for (const scope of ['OWN', 'CUSTOMER'] as const) {
  for (const bezahlt of [false, true]) {
    const db = welt();
    const form = { repairType: 'hybrid', workshopSupplierId: 'sup-1', estimatedCost: 100, internalCost: 20 };
    const id = scope === 'OWN' ? await eigene(form) : await kunde(form);
    if (bezahlt) amStore(() => { rs().loadRepairs(); rs().updateRepair(id, { internalPaidFrom: 'cash' }); });
    const zl = await lokal(() => house.addRepairLineOnPrimary(id, { workType: 'service' as never, costAmount: 30 }));
    await status('P', db, id, 'in_progress');
    await status('P', db, id, 'ready');
    rs().loadRepairs();
    const rep = rs().getRepair(id)!;
    const quelle = costs.repairCostParts(rep, n(db, "SELECT COALESCE(SUM(cost_amount),0) FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'", [id])).total;
    const konto = scope === 'OWN' ? 'INVENTORY' : 'COGS';
    const vor = { quelle, soll: saldo(db, konto), ap: -saldo(db, 'ACCOUNTS_PAYABLE'), kasse: saldo(db, 'CASH'), eigen: saldo(db, 'EXPENSES_OPERATING'),
      andere: saldo(db, scope === 'OWN' ? 'COGS' : 'INVENTORY'), einstand: scope === 'OWN' ? n(db, "SELECT purchase_price FROM products WHERE id = 'p1'") : null };
    let nach: Record<string, unknown>;
    if (scope === 'OWN') {
      const g = gewinn(db, verkaufen(db));
      nach = { einstandVerkauf: g.snap, COGS: g.COGS, INVENTORY: g.INVENTORY, marge: g.marge, brutto: brutto(db), operativ: g.operativ };
    } else {
      await abrechnen('P', db, id);
      const k = kundenStand(db, id);
      nach = { einstandVerkauf: k.invEinstand, COGS: k.COGS, INVENTORY: k.INVENTORY, marge: k.invMarge, brutto: brutto(db), operativ: operativ(db) };
    }
    const gut = zl.ok && vor.quelle === 150 && vor.soll === 150 && vor.ap === 100 && vor.kasse === (bezahlt ? -20 : 0) && vor.eigen === (bezahlt ? -30 : -50)
      && vor.andere === 0 && (scope === 'OWN' ? vor.einstand === 150 : vor.einstand === null)
      && nach.einstandVerkauf === 150 && nach.COGS === 150 && nach.INVENTORY === 0 && nach.marge === 150 && nach.brutto === 150 && nach.operativ === 0 && balanced(db);
    ok(gut, `§18 ${scope}${bezahlt ? ' (eigene Kosten bar)' : ''}: Quelle 150 == ${konto} 150; A/P nur die Werkstatt 100; Kasse nur, wenn bezahlt (${vor.kasse}); `
      + `eigene Arbeit als Eigenleistung (${vor.eigen}); Einstand/COGS 150; Marge 150 == Rohertrag 150; keine Betriebsausgabe (${S(vor)} ${S(nach)})`);
  }
}
M.gegenkonto = fails.length === 0;

// ── §10 Verdrahtung, Registry ───────────────────────────────────────────
{
  const post = codeOf(src('src/core/ledger/posting.ts'));
  const store = codeOf(src('src/stores/repairStore.ts'));
  const booking = codeOf(src('src/core/repairs/repair-cost-booking.ts'));
  const lc = codeOf(src('src/core/bridge/lifecycle-commands.ts'));
  const sc = codeOf(src('src/core/bridge/service-commands.ts'));
  const an = codeOf(src('src/core/reports/analytics-snapshot.ts'));
  ok(/account: repairCostAccount\(expense\) \?\? 'EXPENSES_OPERATING'/.test(post) && (post.match(/!isRepairServiceLine\(line\.productId\)/g) ?? []).length === 2,
    '§10 postExpense bucht nach Eigentum; Rechnung und COGS-Nachtrag buchen für Reparaturzeilen keinen zweiten Wareneinsatz');
  ok((store.match(/repairCostCategory\(/g) ?? []).length === 1 && /repairCostCategory\(scope\)/.test(booking),
    '§10 EINE Kategorie-Regel für Zeilen und Kopfkosten (repairCostCategory)');
  ok(/if \(firstReady\) syncRepairHeaderCosts\(id, now, \{ capitalize: false \}\)/.test(store) && /const totalCost = computeRepairTotalCost\(repair, lineTotal\)/.test(store)
    && /return repairCostParts\(r, lineTotal\)\.total/.test(store) && /const fullCost = computeRepairTotalCost\(r, sumOpenRepairLineCosts\(r\.id\)\)/.test(store),
    '§10 „ready", Marge, Einstand und Rechnungseinstand: EINE Ableitung (repairCostParts)');
  ok((store.match(/shiftOwnRepairCost\(/g) ?? []).length === 5, '§10 „ready", Zeile nach „ready", Betrag, Storno, Löschen: EIN Weg für den Einstand');
  ok((lc.match(/watchLedgerPosts\(OP_REPAIRS_(UPDATE_STATUS|ADD_LINE|UPDATE_LINE|CANCEL_LINE)\)/g) ?? []).length === 4
    && /watchLedgerPosts\(OP_REPAIRS_UPDATE\)/.test(sc), '§10 die fünf Fernbefehle wachen über ihre Buchungen');
  ok(/AND NOT EXISTS \(SELECT 1 FROM expenses e/.test(an), '§10 Analytics zählt gebuchte eigene Arbeit nicht zusätzlich als Reparatur-Abfluss');
  ok(/if \(!supplierId\) \{ syncOwnWork\(lineId, repairId, scope, cost, now\); continue; \}/.test(store)
    && /account: 'EXPENSES_OPERATING', direction: 'CREDIT', amount, metadata: \{ repairId: input\.repairId, kind: 'repair_own_work' \}/.test(post)
    && !/Paid with the repair \(in-house cost\)/.test(store),
    '§10 Zeile im Haus / eigene Kosten ohne Zahlweg: aktivierte Eigenleistung (Haben EXPENSES_OPERATING) — keine künstliche Verbindlichkeit, kein künstlicher Geldfluss');
  ok(ALLOWED_MUTATIONS.length === 104, `§10 Registry unverändert: 104 Buchungen (${ALLOWED_MUTATIONS.length}) — keine neue Fähigkeit`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — post-parity pp-13 + pp-14 repair cost accounting: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('POST_PARITY_REPAIR_COST_DOMAIN_PROVED');
console.log('POST_PARITY_PP13_OWN_REPAIR_CAPITALIZATION_CONTRACT_PROVED');
console.log('POST_PARITY_PP13_INTERNAL_REPAIR_CAPITALIZATION_PROVED');
console.log('POST_PARITY_PP13_REPAIR_COST_REVERSAL_PROVED');
console.log('POST_PARITY_PP14_CUSTOMER_REPAIR_ACCOUNTING_PROVED');
console.log('POST_PARITY_PP14_CUSTOMER_REPAIR_REVERSAL_PROVED');
console.log('POST_PARITY_REPAIR_LEDGER_REPORT_PARITY_PROVED');
console.log('POST_PARITY_PP13_PP14_COUNTERACCOUNT_PINNED');
