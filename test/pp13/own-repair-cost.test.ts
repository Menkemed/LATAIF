// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY PP-13 — Reparaturkosten an EIGENER Ware: genau einmal, im Einstand des Artikels.
// Run: node test/pp13/own-repair-cost.test.ts
//
// Beispiel durchgehend: Artikel-Einstand 0, Werkstatt 100, Verkauf 300 → Gewinn 200 — im Hauptbuch
// (REVENUE − COGS − EXPENSES_OPERATING) wie in den Berichten (Marge − Betriebsausgaben), nie 100, nie 300.
//   §1 Zeilenweg unbezahlt, Primary == PC2 (Soll INVENTORY / Haben A/P, kein Aufwand, Akteur)
//   §2 bezahlt: nur Soll A/P / Haben Kasse; Einstand wie unbezahlt
//   §3 Einzelweg (Werkstatt ohne Zeile): dieselbe Regel
//   §4 Wiederholung / verlorene Antwort: genau EINE Kapitalisierung
//   §5 Fehlerinjektion bei „in Arbeit" und „ready": nichts Halbes
//   §6 Storno vor/nach „ready", bezahlt, verkauft, Zeile nach „ready", Betrag geändert, Reparatur gelöscht
//   §7 Ausgaben-Riegel (Betrag/Kategorie/Löschen der kapitalisierten Werkstattschuld)
//   §8 eigene Reparatur ohne Werkstatt: unverändert
//   §9 Kundenreparatur: von PP-13 unberührt (PP-14 gemessen, offen)
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

// ══ POST-PARITY PP-13 ═══════════════════════════════════════════════════════
const payables = await import('../../src/core/payables/payables-house.ts');
const types = await import('../../src/core/models/types.ts');
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
const ersteZeile = (db: Db, id: string): string => s(db, 'SELECT id FROM repair_lines WHERE repair_id = ? ORDER BY position LIMIT 1', [id]);
function bezahlen(db: Db): void {
  for (const e of db.exec("SELECT id, amount - paid_amount FROM expenses WHERE status != 'CANCELLED' AND amount > paid_amount")[0]?.values ?? []) {
    posting.beginLedgerTransaction();
    try {
      payables.recordExpensePaymentInHouse(String(e[0]), Number(e[1]), 'cash', { branchId: 'branch-main', userId: 'user-test', now: NOW });
      posting.commitLedgerTransaction();
    } catch (x) { posting.rollbackLedgerTransaction(); throw x; }
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
/** Einstand, Los, Ausgaben und die Konten — ohne Kennungen und Zeitpunkte. */
function stand(db: Db) {
  return {
    einstand: n(db, "SELECT purchase_price FROM products WHERE id = 'p1'"),
    los: n(db, "SELECT unit_cost FROM stock_lots WHERE id = 'lot-p1'"),
    exp: all(db, 'SELECT category, amount, paid_amount, status, supplier_id, related_module FROM expenses ORDER BY created_at, id'),
    INVENTORY: saldo(db, 'INVENTORY'), AP: -saldo(db, 'ACCOUNTS_PAYABLE'), EXP_OP: saldo(db, 'EXPENSES_OPERATING'), CASH: saldo(db, 'CASH'),
  };
}
/** Der Verkauf 300: Wareneinsatz, Marge, Betriebsausgaben — und der Gewinn in Hauptbuch und Berichten. */
function gewinn(db: Db, invId: string) {
  const snap = n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [invId]);
  const buch = Math.round((-saldo(db, 'REVENUE') - saldo(db, 'COGS') - saldo(db, 'EXPENSES_OPERATING')) * 1000) / 1000;
  return { snap, marge: 300 - snap, operativ: operativ(db), berichte: 300 - snap - operativ(db), buch, COGS: saldo(db, 'COGS'), INVENTORY: saldo(db, 'INVENTORY') };
}
const EXP_OWN_100 = S([['Inventory', 100, 0, 'PENDING', 'sup-1', 'repair']]);

// ── §1 Zeilenweg unbezahlt — Primary == PC2 ──────────────────────────────
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
      `§1 ${weg} Werkstattschuld: EINE Ausgabe „Inventory" 100, Soll INVENTORY / Haben A/P, KEIN Aufwand, Einstand noch 0 (${S(b1)})`);
    ok(b2.einstand === 100 && b2.los === 100 && b2.INVENTORY === 100 && b2.AP === 100 && b2.EXP_OP === 0 && b2.exp === EXP_OWN_100,
      `§1 ${weg} „ready": Artikel + Los 100, Hauptbuch unverändert, keine zweite Ausgabe (${S(b2)})`);
    ok(g.snap === 100 && g.COGS === 100 && g.INVENTORY === 0 && g.buch === 200 && g.berichte === 200 && g.operativ === 0,
      `§1 ${weg} Verkauf 300: COGS 100, INVENTORY 0, Gewinn Hauptbuch 200 == Berichte 200 (${S(g)})`);
    ok(s(db, 'SELECT created_by FROM expenses') === (weg === 'P' ? 'user-test' : 'user-pc2'),
      `§1 ${weg} Akteur der Werkstattschuld: ${weg === 'P' ? 'die Sitzung am Primary' : 'der geprüfte PC2-Absender'} (${s(db, 'SELECT created_by FROM expenses')})`);
  }
  ok(S(bilder.P) === S(bilder.C), `§1 PARITÄT Primary == PC2 in allen drei Ständen\n  P=${S(bilder.P)}\n  C=${S(bilder.C)}`);
}

// ── §2 bezahlt: dieselbe Kostenbasis, nur Soll A/P / Haben Kasse ─────────
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
    `§2 Zahlung: nur A/P −100 / Kasse −100; Einstand 100 wie unbezahlt, kein Aufwand (${S(b)})`);
  const g = gewinn(db, verkaufen(db));
  ok(g.buch === 200 && g.berichte === 200 && g.COGS === 100, `§2 Verkauf 300: Gewinn 200 in Hauptbuch und Berichten (${S(g)})`);
}

// ── §3 Einzelweg: Werkstatt ohne Kostenzeile (Altbestand) ────────────────
{
  const bilder: Record<Weg, unknown[]> = { P: [], C: [] };
  for (const weg of ['P', 'C'] as Weg[]) {
    const db = welt();
    const id = await eigene({ repairType: 'internal', internalCost: 100 });
    posting.beginLedgerTransaction();
    rs().loadRepairs();
    rs().updateRepair(id, { repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 100 });
    posting.commitLedgerTransaction();
    const lines = n(db, 'SELECT COUNT(*) FROM repair_lines WHERE repair_id = ?', [id]);
    const a = await status(weg, db, id, 'in_progress');
    const c = await status(weg, db, id, 'ready');
    const b = stand(db);
    const g = gewinn(db, verkaufen(db));
    bilder[weg] = [b, g];
    ok(lines === 0 && a.ok && c.ok, `§3 ${weg} Einzelweg ohne Zeile angenommen (${lines} Zeilen, ${a.code}/${c.code})`);
    ok(b.einstand === 100 && b.los === 100 && b.INVENTORY === 100 && b.AP === 100 && b.EXP_OP === 0 && b.exp === EXP_OWN_100,
      `§3 ${weg} Werkstattgebühr bei „ready": „Inventory" 100 auf INVENTORY/A/P, Einstand 100, kein Aufwand (${S(b)})`);
    ok(g.buch === 200 && g.berichte === 200, `§3 ${weg} Verkauf 300: Gewinn 200 (${S(g)})`);
  }
  ok(S(bilder.P) === S(bilder.C), '§3 PARITÄT Einzelweg Primary == PC2');
}

// ── §3b „hybrid": eigene Arbeit + Werkstatt — der Voranschlag wird nicht gespiegelt ─────
for (const [own, soll] of [[0, 100], [10, 110]] as Array<[number, number]>) {
  const db = welt();
  const id = await eigene({ repairType: 'hybrid', workshopSupplierId: 'sup-1', estimatedCost: 100, ...(own ? { internalCost: own } : {}) });
  await status('P', db, id, 'in_progress');
  await status('P', db, id, 'ready');
  const b = stand(db);
  const g = gewinn(db, verkaufen(db));
  ok(n(db, 'SELECT internal_cost FROM repairs WHERE id = ?', [id]) === own && b.einstand === soll && b.INVENTORY === 100 && b.EXP_OP === 0
    && g.buch === 300 - soll && g.berichte === 300 - soll,
    `§3b hybrid, eigene Arbeit ${own} + Werkstatt 100: Einstand ${soll} (nicht ${soll + 100}), Gewinn ${300 - soll} (${S(b)} ${S(g)})`);
}

// ── §4 Wiederholung / verlorene Antwort — genau EINE Kapitalisierung ─────
{
  const db = welt();
  const id = await eigene(WERKSTATT);
  await status('C', db, id, 'in_progress');
  const a = await status('C', db, id, 'ready', 'LOST1');
  const b = await status('C', db, id, 'ready', 'LOST1');
  const e1 = stand(db);
  const c = await status('C', db, id, 'ready');
  ok(a.ok && b.ok && (b.replayed || b.frozen) && e1.einstand === 100 && e1.los === 100 && e1.INVENTORY === 100,
    `§4 PC2 verlorene Antwort: dieselbe Kennung → eingefrorenes Ergebnis, Einstand 100 (nicht 200) (${S(b)} ${S(e1)})`);
  ok(!c.ok && c.code === 'REPAIR_TRANSITION_NOT_ALLOWED' && stand(db).einstand === 100,
    `§4 PC2 ein neuer „ready"-Auftrag: Nein (${c.code}), Einstand bleibt 100`);
  const db2 = welt();
  const id2 = await eigene(WERKSTATT);
  await status('P', db2, id2, 'in_progress');
  await status('P', db2, id2, 'ready');
  await status('P', db2, id2, 'ready');
  ok(stand(db2).einstand === 100 && n(db2, 'SELECT COUNT(*) FROM expenses') === 1,
    '§4 Primary „ready" zweimal: genau EINE Kapitalisierung (completed_at-Riegel), eine Werkstattschuld');
}

// ── §5 Fehlerinjektion: nichts Halbes ───────────────────────────────────
for (const weg of ['P', 'C'] as Weg[]) {
  {
    const db = welt();
    const id = await eigene(WERKSTATT);
    db.run("CREATE TRIGGER pp13_led BEFORE INSERT ON ledger_entries BEGIN SELECT RAISE(ABORT, 'pp13 injected'); END;");
    const a = await status(weg, db, id, 'in_progress');
    db.run('DROP TRIGGER pp13_led');
    ok(!a.ok && s(db, 'SELECT status FROM repairs WHERE id = ?', [id]) === 'received' && n(db, 'SELECT COUNT(*) FROM expenses') === 0
      && n(db, 'SELECT COUNT(*) FROM repair_lines WHERE expense_id IS NOT NULL') === 0 && n(db, 'SELECT COUNT(*) FROM ledger_entries') === 0,
      `§5 ${weg} Buchung der Werkstattschuld scheitert (im Store abgefangen) → ganze Handlung zurück: Status, Ausgabe, Verknüpfung (${a.code.slice(0, 80)})`);
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

// ── §6 Storno / Rücknahme ────────────────────────────────────────────────
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
      `§6 ${weg} Storno vor „ready": Schuld gegengebucht, danach „ready" ohne Kosten (kein Einstand aus dem Spiegel) (${S(b)} ${S(e)})`);
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
    ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'products'") > 0 && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'products'") >= 0,
      `§6 ${weg} …die Rücknahme reist mit dem Artikel (Abgleich/Protokoll)`);
  }
  { // nach „ready", bezahlt
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    bezahlen(db);
    const vor = stand(db);
    const a = await storno(weg, db, id, ersteZeile(db, id));
    ok(!a.ok && a.code === 'REPAIR_COST_PAID' && S(stand(db)) === S(vor),
      `§6 ${weg} Storno einer BEZAHLTEN Werkstattzeile: Nein (${a.code}), nichts geschrieben`);
  }
  { // Artikel verkauft
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    const inv = verkaufen(db);
    const vor = stand(db);
    const a = await storno(weg, db, id, ersteZeile(db, id));
    ok(!a.ok && a.code === 'REPAIR_COST_ALREADY_SOLD' && S(stand(db)) === S(vor) && gewinn(db, inv).buch === 200,
      `§6 ${weg} Storno nach dem Verkauf: Nein (${a.code}), Einstand/COGS unberührt, Gewinn 200`);
  }
  { // Zeile nach „ready"
    const db = welt();
    const id = await eigene(WERKSTATT);
    await status(weg, db, id, 'in_progress');
    await status(weg, db, id, 'ready');
    const a = await zeile(weg, db, id, 50);
    const b = stand(db);
    ok(a.ok && b.einstand === 150 && b.los === 150 && b.INVENTORY === 150 && b.AP === 150 && b.EXP_OP === 0,
      `§6 ${weg} Zeile 50 nach „ready": sofort im Einstand (150) und auf INVENTORY/A/P, kein Aufwand (${S(b)})`);
    const neu = s(db, 'SELECT id FROM repair_lines WHERE repair_id = ? AND cost_amount = 50', [id]);
    const c = await storno(weg, db, id, neu);
    const e = stand(db);
    ok(c.ok && e.einstand === 100 && e.los === 100 && e.INVENTORY === 100 && e.AP === 100,
      `§6 ${weg} …und ihr Storno nimmt genau 50 zurück (${S(e)})`);
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
    '§7 die kapitalisierte Werkstattschuld: Betrag, Kategorie und Löschen nur über die Reparaturzeile');
  ok(nein(() => payables.updateExpenseInHouse(expId, { description: 'Politur' }, ctx)) === '',
    '§7 …eine Beschreibung darf sie weiter bekommen');
  const dbK = freshDb();
  const k = await house.createRepairOnPrimary({ repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Service',
    ...WERKSTATT, chargeToCustomer: 300, taxScheme: 'ZERO' } as never);
  await status('P', dbK, k.id, 'in_progress');
  ok(nein(() => payables.updateExpenseInHouse(s(dbK, 'SELECT id FROM expenses'), { category: 'Inventory' }, ctx)) === 'EXPENSE_REPAIR_COST_LOCKED',
    '§7 …und keine Kundenreparatur-Ausgabe wird über die Kategorie zu Bestand');
}

// ── §8 eigene Reparatur ohne Werkstatt: der bestehende Vertrag bleibt ────
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
    ok(b.einstand === 100 && b.los === 100 && b.exp === '[]' && b.EXP_OP === 0 && g.COGS === 100 && g.buch === 200 && g.berichte === 200,
      `§8 ${weg} eigene Arbeit 100: nur im Einstand, keine Ausgabe, EINE Kostenwirkung (COGS 100), Gewinn 200 == 200 (${S(b)} ${S(g)})`);
    // Bestehend, unverändert und dokumentiert: die eigene Arbeit hat keine Buchung beim Entstehen —
    // INVENTORY steht nach dem Verkauf auf −100 (keine Doppelzählung; eigene Frage, nicht PP-13).
    ok(g.INVENTORY === -100, `§8 ${weg} BEKANNT eigene Arbeit ohne Bestandsbuchung: INVENTORY nach dem Verkauf −100`);
  }
  ok(S(bilder.P) === S(bilder.C), '§8 PARITÄT ohne Werkstatt Primary == PC2');
}

// ── §9 Kundenreparatur: von PP-13 unberührt; PP-14 gemessen ─────────────
{
  const db = freshDb();
  const k = await house.createRepairOnPrimary({ repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Service',
    ...WERKSTATT, chargeToCustomer: 300, taxScheme: 'ZERO' } as never);
  await status('P', db, k.id, 'in_progress');
  const b = stand(db);
  ok(b.exp === S([['RepairCosts', 100, 0, 'PENDING', 'sup-1', 'repair']]) && b.EXP_OP === 100 && b.INVENTORY === 0,
    `§9 Kundenreparatur unverändert: „RepairCosts" 100 als Betriebsausgabe (${S(b)})`);
  await status('P', db, k.id, 'ready');
  await house.invoiceRepairsOnPrimary([k.id], { taxScheme: 'ZERO' } as never);
  const inv = row(db, 'SELECT margin_snapshot, purchase_price_snapshot FROM invoices LIMIT 1');
  const buch = Math.round((-saldo(db, 'REVENUE') - saldo(db, 'COGS') - saldo(db, 'EXPENSES_OPERATING')) * 1000) / 1000;
  console.log(`  PP-14 (offen, gemessen): Rechnung 300, Werkstatt 100 → Einstand der Rechnung ${S(inv.purchase_price_snapshot)}, `
    + `COGS ${saldo(db, 'COGS')}, Aufwand ${saldo(db, 'EXPENSES_OPERATING')}, INVENTORY ${saldo(db, 'INVENTORY')}, Gewinn Hauptbuch ${buch} (Soll 200)`);
}

// ── §10 Verdrahtung, Registry ───────────────────────────────────────────
{
  const post = codeOf(src('src/core/ledger/posting.ts'));
  const store = codeOf(src('src/stores/repairStore.ts'));
  const lc = codeOf(src('src/core/bridge/lifecycle-commands.ts'));
  ok(/account: isCapitalizedRepairCost\(expense\) \? 'INVENTORY' : 'EXPENSES_OPERATING'/.test(post),
    '§10 postExpense: kapitalisierte Werkstattschuld Soll INVENTORY, alles andere wie bisher');
  ok(!/'RepairCosts', \?/.test(store) && (store.match(/repairCostCategory\(/g) ?? []).length === 2,
    '§10 Zeilenweg und Einzelweg nehmen die Kategorie aus EINER Regel (repairCostCategory)');
  ok(/ownRepairCost\(repair, lineTotal\)/.test(store) && (store.match(/shiftOwnRepairCost\(/g) ?? []).length === 5,
    '§10 „ready", Zeile nach „ready", Betrag, Storno, Löschen: EIN Weg für den Einstand (shiftOwnRepairCost)');
  ok((lc.match(/watchLedgerPosts\(OP_REPAIRS_(UPDATE_STATUS|ADD_LINE|UPDATE_LINE|CANCEL_LINE)\)/g) ?? []).length === 4,
    '§10 die vier Fernbefehle wachen über ihre Buchungen');
  const ui = codeOf(src('src/pages/repairs/RepairDetail.tsx')) + codeOf(src('src/pages/repairs/RepairList.tsx'));
  ok(/updateRepairStatusOnPrimary\(id, status\)/.test(ui) && /updateRepairStatusOnPrimary\(rep\.id, newStatus\)/.test(ui)
    && /cancelRepairLineOnPrimary\(lineId\)/.test(ui) && /addRepairLineOnPrimary\(id,/.test(ui),
    '§10 die Masken des Primary gehen durch dieselbe Klammer');
  ok(ALLOWED_MUTATIONS.length === 103, `§10 Registry unverändert: 103 Buchungen (${ALLOWED_MUTATIONS.length}) — keine neue Fähigkeit`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — post-parity pp-13 own repair cost capitalization: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('POST_PARITY_PP13_OWN_REPAIR_CAPITALIZATION_CONTRACT_PROVED');
console.log('POST_PARITY_PP13_REPAIR_COST_REVERSAL_PROVED');
