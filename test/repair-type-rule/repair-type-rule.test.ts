// ════════════════════════════════════════════════════════════════════════════
// REPAIR-TYPE FINAL CORRECTION — gespeicherte Art folgt der aktiven Arbeit (nicht der Vorwahl), Kosten und Status geschützt.
// Run: node --experimental-strip-types test/repair-type-rule/repair-type-rule.test.ts
//   §1 reine Regel + Raster  §2 Internal → erste Werkstattzeile  §3 External / echte Hybrid  §4 geplante Werkstatt
//   §5 Storno  §6 Altbestand + Material  §7 REP-2-Muster  §8 Verdrahtung — §2–§6 je Primary (Haus) und PC2 (Fernbefehl)
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

const S = (v: unknown): string => JSON.stringify(v);

// ════════════════════════════════════════════════════════════════════════════
// REPAIR-REDESIGN A–G — wer arbeitet (In-house / External / Hybrid), die Filter, getrennte Kosten, eigene Arbeit mit
// 0.000 am Primary UND an PC2, die geplante Werkstatt ohne Buchung. Jeder Schreibweg ZWEIMAL: Hausfunktion am Primary
// und Fernbefehl mit dem Rumpf, den dieselbe Maske an PC2 baut.
// ════════════════════════════════════════════════════════════════════════════
const ws = await import('../../src/core/repairs/repair-work-source.ts');
const reg = await import('../../src/core/bridge/command-registry.ts');
const { computeRepairTotalCost, repairTotalCostInHouse } = await import('../../src/stores/repairStore.ts');
const { todayIso } = await import('../../src/core/utils/business-date.ts');
const HEUTE = todayIso();
type Out = { kind: string; code?: string; value?: Record<string, unknown> };
let seq = 9000;
const nx = (): string => String(++seq);
async function nein(p: Promise<unknown>): Promise<string> {
  try { await p; return ''; } catch (e) { return code(e) || (e as Error).message; }
}
const ausgeglichen = (db: Db): boolean =>
  Math.abs(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.0005;
const buchungen = (db: Db): string => all(db, 'SELECT account, direction, amount, source_module FROM ledger_entries ORDER BY rowid');
const ausgaben = (db: Db, rid: string): number =>
  n(db, "SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'", [rid]);
const ausgabenZahl = (db: Db, rid: string): number =>
  n(db, "SELECT COUNT(*) FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'", [rid]);
const ap = (db: Db, sup: string): number =>
  n(db, "SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND counterparty_id = ?", [sup]);
const zeilen = (db: Db, rid: string) => {
  const r = db.exec('SELECT id, supplier_id, work_type, material_kind, cost_amount, status, expense_id FROM repair_lines WHERE repair_id = ? ORDER BY position', [rid])[0];
  return (r?.values ?? []).map((v) => ({ id: String(v[0]), supplierId: v[1] as string | null, workType: v[2] as string | null,
    materialKind: v[3] as string | null, costAmount: Number(v[4]), status: String(v[5]), expenseId: v[6] as string | null }));
};
function kopf(db: Db, id: string) {
  const r = row(db, 'SELECT repair_type, workshop_supplier_id, planned_workshop_supplier_id, issue_description, internal_cost, estimated_cost, actual_cost FROM repairs WHERE id = ?', [id]);
  return { repairType: r.repair_type as string, workshopSupplierId: r.workshop_supplier_id as string | null,
    plannedWorkshopSupplierId: r.planned_workshop_supplier_id as string | null, issueDescription: r.issue_description as string,
    internalCost: Number(r.internal_cost) || 0, estimatedCost: r.estimated_cost === null ? null : Number(r.estimated_cost),
    actualCost: r.actual_cost === null ? null : Number(r.actual_cost) };
}

async function anlegen(db: Db, weg: 'lokal' | 'fern', form: Record<string, unknown>): Promise<string> {
  const basis = { repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Service', taxScheme: 'VAT_10',
    chargeToCustomer: 70, receivedAt: HEUTE, ...form };
  const anlage = ws.repairCreateWorkshopSplit(basis as never);
  if (weg === 'lokal') { const id = (await house.createRepairOnPrimary(anlage as never)).id; reload(); return id; }
  const o = await cmd.runRepairCreate(deps(db), identity(nx(), 'repairs.create'), rules.repairCreateBody(anlage as never, [])) as Out;
  ok(o.kind === 'ok', `NEW (fern) angenommen (${o.code || 'ok'})`);
  reload();
  return String(o.value?.repairId ?? o.value?.id ?? '');
}

const tr = await import('../../src/core/repairs/repair-type-rule.ts');
const flow = await import('../../src/core/repairs/repair-status-flow.ts');
const costMod = await import('../../src/core/repairs/repair-cost.ts');
type Weg = 'lokal' | 'fern';
const WEGE: Weg[] = ['lokal', 'fern'];
const art = (db: Db, id: string): string => s(db, 'SELECT repair_type FROM repairs WHERE id = ?', [id]);
const st = (db: Db, id: string): string => s(db, 'SELECT status FROM repairs WHERE id = ?', [id]);
const protokoll = (db: Db, id: string, feld: string): string[] =>
  (db.exec("SELECT new_value FROM audit_log WHERE entity_type = 'repairs' AND entity_id = ? AND field_name = ? ORDER BY rowid", [id, feld])[0]?.values ?? [])
    .map((v) => String(v[0]));
const marge = (db: Db, id: string): number => n(db, 'SELECT margin FROM repairs WHERE id = ?', [id]);
const konten = (db: Db): string => all(db, "SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries GROUP BY 1, 2 ORDER BY 1, 2");
const ersteZeile = (db: Db, id: string, sup: string | null): string =>
  zeilen(db, id).find((l) => l.status === 'OPEN' && (sup ? l.supplierId === sup : !l.supplierId))?.id ?? '';
/** Kosten wie das bisherige Verhalten sie gerechnet hätte (dieselbe Formel, die bisherige Art). */
const kostenAlt = (db: Db, id: string, altArt: string): number => {
  const k = kopf(db, id);
  const offen = zeilen(db, id).filter((l) => l.status === 'OPEN').reduce((x, l) => x + l.costAmount, 0);
  return computeRepairTotalCost({ ...k, repairType: altArt } as never, offen);
};
const kostenJetzt = (_db: Db, id: string): number => {
  return repairTotalCostInHouse({ id, ...kopf(_db, id) } as never);
};

async function zeile(db: Db, weg: Weg, id: string, body: Record<string, unknown>): Promise<string> {
  if (weg === 'lokal') {
    try { await house.addRepairLineOnPrimary(id, body as never); } catch (e) { reload(); return code(e) || (e as Error).message; }
  } else {
    const o = await life.runAddRepairLine(deps(db), identity(nx(), 'repairs.add_line'), { repairId: id, expectedRevision: rev(db, id), ...body }) as Out;
    if (o.kind !== 'ok') { reload(); return o.code || o.kind; }
  }
  reload(); return 'OK';
}
async function storno(db: Db, weg: Weg, id: string, lineId: string): Promise<string> {
  if (weg === 'lokal') {
    try { await house.cancelRepairLineOnPrimary(lineId); } catch (e) { reload(); return code(e) || (e as Error).message; }
  } else {
    const o = await life.runCancelRepairLine(deps(db), identity(nx(), 'repairs.cancel_line'), { repairId: id, lineId, expectedRevision: rev(db, id) }) as Out;
    if (o.kind !== 'ok') { reload(); return o.code || o.kind; }
  }
  reload(); return 'OK';
}
async function status(db: Db, weg: Weg, id: string, ziel: string): Promise<string> {
  if (weg === 'lokal') {
    try { await house.updateRepairStatusOnPrimary(id, ziel as never, { expectedRevision: rev(db, id) } as never); } catch (e) { reload(); return code(e) || (e as Error).message; }
  } else {
    const o = await life.runUpdateRepairStatus(deps(db), identity(nx(), 'repairs.update_status'), { repairId: id, status: ziel, expectedRevision: rev(db, id) }) as Out;
    if (o.kind !== 'ok') { reload(); return o.code || o.kind; }
  }
  reload(); return 'OK';
}
async function bearbeiten(db: Db, weg: Weg, id: string, aenderung: Record<string, unknown>): Promise<string> {
  reload();
  const vorher = useRepairStore.getState().getRepair(id)!;
  const neu = { ...vorher, ...aenderung };
  if (weg === 'lokal') {
    try { await house.updateRepairOnPrimary(id, neu as never, rev(db, id)); } catch (e) { reload(); return code(e) || (e as Error).message; }
  } else {
    const o = await cmd.runRepairUpdate(deps(db), identity(nx(), 'repairs.update'), rules.repairEditBody(id, rev(db, id), vorher as never, neu as never)) as Out;
    if (o.kind !== 'ok') { reload(); return o.code || o.kind; }
  }
  reload(); return 'OK';
}
async function abrechnen(db: Db, weg: Weg, id: string): Promise<string> {
  if (weg === 'lokal') {
    try { await house.invoiceRepairsOnPrimary([id], { taxScheme: 'ZERO' } as never); } catch (e) { reload(); return code(e) || (e as Error).message; }
  } else {
    const o = await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'),
      { repairs: [{ repairId: id, expectedRevision: rev(db, id) }], taxScheme: 'ZERO', specialMark: false }) as Out;
    if (o.kind !== 'ok') { reload(); return o.code || o.kind; }
  }
  reload(); return 'OK';
}
const WS = { workType: 'service', supplierId: 'sup-1', costAmount: 20, description: 'Workshop service' };
const OWN = { workType: 'polishing', costAmount: 0, description: 'Own polish' };
const welt = (): Db => { const db = freshDb(); db.run('UPDATE suppliers SET is_workshop = 1'); reload(); return db; };
const ergebnis: Record<string, string> = {};

// ══ §1 Die reine Regel ═══════════════════════════════════════════════════════════════════════════
{
  const f = (o: Record<string, unknown>) => tr.decideRepairType({ currentType: 'internal', scope: 'CUSTOMER', status: 'in_progress',
    internalCost: 0, estimatedCost: null, workshopSupplierId: null, plannedWorkshopSupplierId: null, workLines: [], openLineTotal: 0, ...o } as never);
  const shop = [{ supplierId: 'w' }]; const own = [{ supplierId: null }];
  let d = f({ workLines: shop, openLineTotal: 20, workshopSupplierId: 'w' });
  ok(d.type === 'external' && d.changed && d.legacy === 'hybrid' && !d.kept, `§1 Internal (Vorwahl) + erste Werkstattzeile → External, nicht Hybrid (${S(d)})`);
  d = f({ workLines: [...own, ...shop], openLineTotal: 20, workshopSupplierId: 'w' });
  ok(d.type === 'hybrid', '§1 eigene + Werkstatt-Arbeitszeile → Hybrid');
  d = f({ internalCost: 15, workLines: shop, openLineTotal: 20, workshopSupplierId: 'w' });
  ok(d.type === 'hybrid' && !d.kept, '§1 eigene Kosten (15) + Werkstattzeile → Hybrid (eigene Arbeit über die Kosten)');
  d = f({ workLines: own });
  ok(d.type === 'internal' && !d.changed, '§1 nur eigene Arbeit → bleibt Internal');
  d = f({ currentType: 'external', workLines: shop, openLineTotal: 20, workshopSupplierId: 'w' });
  ok(d.type === 'external' && !d.changed, '§1 External + nur Werkstattarbeit → bleibt External');
  d = f({ plannedWorkshopSupplierId: 'w' });
  ok(d.type === 'external' && d.changed, '§1 Internal + nur eingeplante Werkstatt (keine Zeile) → External');
  d = f({ plannedWorkshopSupplierId: 'w', workLines: own });
  ok(d.type === 'hybrid', '§1 eingeplante Werkstatt + eigene Zeile → Hybrid (geplante Arbeit zählt)');
  d = f({ currentType: 'external', assignedWorkshopSupplierId: 'w', internalCost: 30, estimatedCost: 30, workLines: own });
  ok(d.type === 'external' && d.target === 'hybrid' && d.kept === 'MIRROR', '§1 Altgebühr im Kopf + eigene Zeile, Betrag ohne Nachweis: bleibt External (Konflikt)');
  d = f({ currentType: 'hybrid', workLines: shop, openLineTotal: 20, workshopSupplierId: 'w' });
  ok(d.type === 'hybrid' && d.kept === 'HYBRID_KEPT' && !d.changed, '§1 Hybrid wird nie automatisch herabgestuft');
  for (const t of ['internal', 'external', 'hybrid']) {
    const x = f({ currentType: t });
    ok(x.type === t && !x.changed && !x.kept, `§1 keine aktive Arbeit: ${t} bleibt (Altbestand, alle Zeilen storniert)`);
  }
  d = f({ currentType: 'external', workLines: own, internalCost: 0 });
  ok(d.type === 'internal' && d.changed, '§1 External, Werkstatt storniert, nie gesendet, nur eigene Zeile → Internal (kosten-/statusgleich)');
  d = f({ currentType: 'external', workLines: own, status: 'sent_to_workshop' });
  ok(d.type === 'hybrid' && d.kept === 'STATUS', '§1 …aber auf „Sent to workshop": STATUS-Konflikt → bisheriges Verhalten (Hybrid)');
  d = f({ currentType: 'external', workLines: own, status: 'ready', everSentToWorkshop: true });
  ok(d.type === 'hybrid' && d.kept === 'STATUS', '§1 …oder je dort gewesen: STATUS-Konflikt, „Sent to workshop" bleibt im Weg');
  d = f({ currentType: 'external', workLines: own, status: 'returned', returnFromStatus: 'sent_to_workshop' });
  ok(d.type === 'hybrid' && d.kept === 'STATUS', '§1 …oder von dort zurückgegeben: STATUS-Konflikt');
  d = f({ currentType: 'external', workLines: own, internalCost: 25, estimatedCost: 25, mirroredAmount: 25 });
  ok(d.type === 'internal' && !d.kept && d.internalCost === 0, `§1 External ohne Werkstatt, nachgewiesener Spiegel 25, nur eigene Zeile → Internal, Spiegel weg (${S(d)})`);
  d = f({ internalCost: 30, estimatedCost: 25, workshopSupplierId: 'w', plannedWorkshopSupplierId: 'p' });
  ok(d.type === 'internal' && d.target === 'hybrid' && d.kept === 'COST',
    `§1 Hybrid zöge eine Gebühr (25) nach: COST-Konflikt → bisheriges Verhalten bleibt (${S(d)})`);
  d = f({ workLines: shop, openLineTotal: 20, workshopSupplierId: 'w', invoiceId: 'inv-1' });
  ok(d.type === 'hybrid' && d.kept === 'INVOICED', '§1 abgerechnet: keine neue Art, bisheriges Verhalten');
  // Eigenschaft über ein Raster: aus internal ist jede NEUE Art kosten- und statusgleich zum bisherigen Verhalten; wer
  // „external" verlässt, hat keine eigenen Kosten aus dem Betrag (nur mit Nachweis), und eine geltende Gebühr bleibt gleich.
  let geprueft = 0; let verletzt = 0; let spiegel = 0;
  for (const cur of ['internal', 'external', 'hybrid']) for (const ic of [0, 30]) for (const est of [null, 25]) for (const wsId of [null, 'w'])
    for (const lines of [[], own, shop, [...own, ...shop]]) for (const planned of [null, 'p']) for (const assigned of [null, 'a']) for (const nachweis of [false, true])
      for (const status of ['received', 'in_progress', 'sent_to_workshop', 'ready', 'picked_up']) for (const scope of ['CUSTOMER', 'OWN']) for (const ever of [false, true]) {
        const tot = lines.some((l) => l.supplierId) ? 20 : 0;
        const x = tr.decideRepairType({ currentType: cur, scope, status, internalCost: ic, estimatedCost: est, workshopSupplierId: wsId,
          plannedWorkshopSupplierId: planned, assignedWorkshopSupplierId: assigned, workLines: lines, openLineTotal: tot, everSentToWorkshop: ever, mirroredAmount: nachweis ? ic : null } as never);
        const fa = flow.repairStatusFlow(x.legacy, scope); const fb = flow.repairStatusFlow(x.type, scope);
        const statusOk = !(fa.includes(status as never) && !fb.includes(status as never))
          && !(fa.includes('sent_to_workshop') && !fb.includes('sent_to_workshop') && ever);
        if (cur === 'external') {
          // Bleibt „external", zählt internal_cost ohnehin nie. Wer „external" verlässt: kein Spiegel neben einer
          // Werkstattzeile, eigene Kosten höchstens die frühere Kopf-Gebühr, eine geltende Gebühr bleibt gleich.
          if (x.type === 'external') continue;
          spiegel++;
          const nach = costMod.repairCostParts({ repairType: x.type, internalCost: x.internalCost ?? ic, estimatedCost: est, workshopSupplierId: wsId }, tot);
          const vor = costMod.repairCostParts({ repairType: 'external', internalCost: ic, estimatedCost: est, workshopSupplierId: wsId }, tot);
                              if (nach.own > 0.0005 || Math.abs(nach.fee - vor.fee) > 0.0005 || (x.type !== x.legacy && !statusOk) || (ic > 0 && !nachweis)) verletzt++;
          continue;
        }
        if (x.type === x.legacy) continue;
        geprueft++;
        const p = (t: string) => costMod.repairCostParts({ repairType: t, internalCost: ic, estimatedCost: est, workshopSupplierId: wsId }, tot);
        const a = p(x.legacy); const b = p(x.type);
        const kostenGleich = Math.abs(a.own - b.own) + Math.abs(a.fee - b.fee) + Math.abs(a.total - b.total) < 0.0005;
        if (!kostenGleich || !statusOk || x.legacy === 'hybrid' && cur === 'hybrid') verletzt++;
      }
  ok(geprueft > 100 && spiegel > 100 && verletzt === 0,
    `§1 Raster: ${geprueft} neue Entscheidungen aus internal kosten-/statusgleich, ${spiegel} aus external ohne Spiegel neben der Werkstattzeile (${verletzt} Verstöße)`);
}

// ══ §2 Internal (Vorwahl) → erste Werkstattzeile → External; Statusweg, Kosten, Buchungen — Primary und PC2 ══
for (const weg of WEGE) {
  const db = welt();
  const id = await anlegen(db, weg, { repairType: 'internal' });
  ok(art(db, id) === 'internal', `§2 (${weg}) angelegt mit der Vorwahl In-house`);
  ok(await status(db, weg, id, 'in_progress') === 'OK', `§2 (${weg}) in Arbeit`);
  ok(await zeile(db, weg, id, WS) === 'OK', `§2 (${weg}) Werkstattzeile 20`);
  ok(art(db, id) === 'external' && !protokoll(db, id, 'repairType').includes('hybrid'), `§2 (${weg}) gespeichert: External, nie Hybrid (${art(db, id)})`);
  ok(flow.allowedRepairStatusTargets(st(db, id), art(db, id), 'CUSTOMER').includes('sent_to_workshop'), `§2 (${weg}) „Sent to workshop" wird angeboten`);
  ok(Math.abs(kostenJetzt(db, id) - kostenAlt(db, id, 'hybrid')) < 0.0005 && Math.abs(kostenJetzt(db, id) - 20) < 0.0005 && Math.abs(marge(db, id) - 50) < 0.0005,
    `§2 (${weg}) Kosten 20 = wie bisher (Hybrid), Marge 50`);
  ok(ausgabenZahl(db, id) === 1 && Math.abs(ausgaben(db, id) - 20) < 0.0005 && Math.abs(ap(db, 'sup-1') - 20) < 0.0005 && ausgeglichen(db),
    `§2 (${weg}) genau eine Werkstatt-Verbindlichkeit 20, Hauptbuch ausgeglichen`);
  ok(await status(db, weg, id, 'sent_to_workshop') === 'OK' && await status(db, weg, id, 'ready') === 'OK', `§2 (${weg}) Sent to workshop → Ready`);
  ok(await abrechnen(db, weg, id) === 'OK', `§2 (${weg}) abgerechnet`);
  const inv = s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [id]);
  ok(n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [inv]) === 20 && art(db, id) === 'external'
    && Math.abs(ap(db, 'sup-1') - 20) < 0.0005 && ausgabenZahl(db, id) === 1 && ausgeglichen(db),
    `§2 (${weg}) Rechnungseinstand 20, eine Verbindlichkeit, Hauptbuch ausgeglichen`);
  ergebnis['A-' + weg] = konten(db);
}
ok(ergebnis['A-lokal'] === ergebnis['A-fern'], `§2 Primary == PC2: dieselben Buchungen (${ergebnis['A-lokal']})`);

// ══ §3 External ohne eigene Arbeit; echte Hybrid-Reparaturen — Primary und PC2 ══════════════════
for (const weg of WEGE) {
  const db = welt();
  const e = await anlegen(db, weg, { repairType: 'external', workshopSupplierId: 'sup-1' });
  ok(art(db, e) === 'external' && kopf(db, e).plannedWorkshopSupplierId === 'sup-1' && ausgabenZahl(db, e) === 0, `§3 (${weg}) External, Werkstatt eingeplant, nichts gebucht`);
  ok(await zeile(db, weg, e, { ...WS, costAmount: 25 }) === 'OK' && art(db, e) === 'external' && kopf(db, e).plannedWorkshopSupplierId === null
    && kopf(db, e).workshopSupplierId === 'sup-1' && Math.abs(kostenJetzt(db, e) - 25) < 0.0005 && Math.abs(marge(db, e) - 45) < 0.0005,
    `§3 (${weg}) External + Werkstattzeile 25: bleibt External, Plan erfüllt, Kosten 25, Marge 45`);

  const h1 = await anlegen(db, weg, { repairType: 'internal' });
  ok(await zeile(db, weg, h1, OWN) === 'OK' && art(db, h1) === 'internal', `§3 (${weg}) eigene Zeile 0.000: Internal`);
  ok(await zeile(db, weg, h1, WS) === 'OK' && art(db, h1) === 'hybrid' && Math.abs(kostenJetzt(db, h1) - 20) < 0.0005,
    `§3 (${weg}) …dazu Werkstattzeile: Hybrid (echte eigene + externe Arbeit), Kosten 20`);
  const h2 = await anlegen(db, weg, { repairType: 'internal' });
  ok(await zeile(db, weg, h2, WS) === 'OK' && art(db, h2) === 'external' && await zeile(db, weg, h2, OWN) === 'OK' && art(db, h2) === 'hybrid',
    `§3 (${weg}) umgekehrte Reihenfolge: External → eigene Zeile → Hybrid`);
  const h3 = await anlegen(db, weg, { repairType: 'internal', internalCost: 15 });
  ok(await zeile(db, weg, h3, WS) === 'OK' && art(db, h3) === 'hybrid' && Math.abs(kostenJetzt(db, h3) - 35) < 0.0005 && Math.abs(kostenAlt(db, h3, 'hybrid') - 35) < 0.0005,
    `§3 (${weg}) eigene Kosten 15 + Werkstatt 20: Hybrid, Kosten 35 wie bisher`);
  const h4 = await anlegen(db, weg, { repairType: 'hybrid', workshopSupplierId: 'sup-1' });
  ok(art(db, h4) === 'hybrid' && await zeile(db, weg, h4, WS) === 'OK' && art(db, h4) === 'hybrid' && protokoll(db, h4, 'repairTypeKept').length === 0,
    `§3 (${weg}) bewusst Hybrid angelegt (beide Kästchen): bleibt Hybrid, kein Konflikt im Protokoll`);
  ok(ausgeglichen(db), `§3 (${weg}) Hauptbuch ausgeglichen`);
}

// ══ §4 Geplante Werkstatt ohne Arbeitszeile — Primary und PC2 ═══════════════════════════════════
for (const weg of WEGE) {
  const db = welt();
  const i = await anlegen(db, weg, { repairType: 'internal' });
  const vorBuch = konten(db);
  ok(await bearbeiten(db, weg, i, { plannedWorkshopSupplierId: 'sup-1' }) === 'OK', `§4 (${weg}) Werkstatt nachträglich eingeplant`);
  ok(art(db, i) === 'external' && kopf(db, i).plannedWorkshopSupplierId === 'sup-1' && protokoll(db, i, 'recomputedFromPlan').length === 1
    && flow.repairStatusFlow(art(db, i), 'CUSTOMER').includes('sent_to_workshop'),
    `§4 (${weg}) In-house-Vorwahl + Plan → External (Weg mit „Sent to workshop")`);
  ok(konten(db) === vorBuch && ausgabenZahl(db, i) === 0 && Math.abs(marge(db, i) - 70) < 0.0005, `§4 (${weg}) der Plan bucht nichts, Marge unverändert 70`);
  ok(await bearbeiten(db, weg, i, { plannedWorkshopSupplierId: undefined }) === 'OK' && kopf(db, i).plannedWorkshopSupplierId === null && art(db, i) === 'external',
    `§4 (${weg}) Plan entfernt: keine aktive Arbeit → keine Herabstufung`);
  const k = await anlegen(db, weg, { repairType: 'internal', internalCost: 10 });
  ok(await bearbeiten(db, weg, k, { plannedWorkshopSupplierId: 'sup-1' }) === 'OK' && art(db, k) === 'hybrid' && Math.abs(marge(db, k) - 60) < 0.0005,
    `§4 (${weg}) eigene Kosten 10 + Plan → Hybrid, Marge 60 unverändert`);
  const p = await anlegen(db, weg, { repairType: 'external', workshopSupplierId: 'sup-1' });
  ok(await zeile(db, weg, p, OWN) === 'OK' && art(db, p) === 'hybrid' && kopf(db, p).plannedWorkshopSupplierId === 'sup-1',
    `§4 (${weg}) Werkstatt eingeplant + eigene Zeile → Hybrid, der Plan bleibt`);
  ok(ausgeglichen(db) && ausgabenZahl(db, p) === 0, `§4 (${weg}) nichts gebucht, ausgeglichen`);
}

// ══ §5 Stornieren von Arbeitszeilen — Primary und PC2 ═══════════════════════════════════════════
for (const weg of WEGE) {
  const db = welt();
  const a = await anlegen(db, weg, { repairType: 'internal' });
  await status(db, weg, a, 'in_progress');
  await zeile(db, weg, a, WS);
  ok(await storno(db, weg, a, ersteZeile(db, a, 'sup-1')) === 'OK' && art(db, a) === 'external' && ausgabenZahl(db, a) === 0 && Math.abs(ap(db, 'sup-1')) < 0.0005,
    `§5 (${weg}) Werkstattzeile storniert (nie gesendet): bleibt External, Verbindlichkeit zurück`);
  ok(await zeile(db, weg, a, OWN) === 'OK' && art(db, a) === 'internal' && !flow.repairStatusFlow('internal', 'CUSTOMER').includes('sent_to_workshop') && st(db, a) === 'in_progress',
    `§5 (${weg}) …dann nur eigene Arbeit: Internal (kosten- und statusgleich, nie bei der Werkstatt gewesen)`);

  const b = await anlegen(db, weg, { repairType: 'internal' });
  await status(db, weg, b, 'in_progress');
  await zeile(db, weg, b, WS);
  ok(await status(db, weg, b, 'sent_to_workshop') === 'OK', `§5 (${weg}) zur Werkstatt geschickt`);
  const sb = await storno(db, weg, b, ersteZeile(db, b, 'sup-1'));
  if (sb === 'OK') {
    ok(await zeile(db, weg, b, OWN) === 'OK' && art(db, b) === 'hybrid' && protokoll(db, b, 'repairTypeKept').includes('STATUS')
      && st(db, b) === 'sent_to_workshop' && flow.allowedRepairStatusTargets('sent_to_workshop', art(db, b), 'CUSTOMER').includes('ready'),
      `§5 (${weg}) bei der Werkstatt gewesen: nicht Internal (STATUS-Konflikt im Protokoll), „Sent to workshop" bleibt, Ready erreichbar`);
  } else ok(false, `§5 (${weg}) Storno auf „Sent to workshop" abgewiesen: ${sb}`);

  const h = await anlegen(db, weg, { repairType: 'internal' });
  await zeile(db, weg, h, OWN); await zeile(db, weg, h, WS);
  ok(art(db, h) === 'hybrid' && await storno(db, weg, h, ersteZeile(db, h, null)) === 'OK' && art(db, h) === 'hybrid' && protokoll(db, h, 'repairTypeKept').length === 0,
    `§5 (${weg}) Hybrid, eigene Zeile storniert: bleibt Hybrid (keine Herabstufung)`);
  ok(ausgeglichen(db), `§5 (${weg}) Hauptbuch ausgeglichen`);
}

// ══ §6 Altbestand ohne Arbeitszeilen — Bedeutung bleibt; Material zählt nie ═════════════════════
for (const weg of WEGE) {
  const db = welt();
  const alt = (id: string, typ: string, extra: Record<string, unknown>) => insert(db, 'repairs', {
    id, branch_id: 'branch-main', repair_number: 'ALT-' + id, customer_id: 'cust-1', repair_scope: 'CUSTOMER', repair_type: typ,
    issue_description: 'Alt', charge_to_customer: 70, internal_cost: 0, status: 'in_progress', tax_scheme: 'VAT_10', images: '[]',
    item_attributes: '{}', voucher_code: 'V' + id, revision: 1, received_at: NOW, created_at: NOW, updated_at: NOW, ...extra });
  alt('l-int', 'internal', {});
  alt('l-ext', 'external', { workshop_supplier_id: 'sup-1', estimated_cost: 30, internal_cost: 30 });
  alt('l-hyb', 'hybrid', { workshop_supplier_id: 'sup-1', estimated_cost: 20 });
  reload();
  const vorher = ['l-int', 'l-ext', 'l-hyb'].map((x) => `${art(db, x)}:${kostenJetzt(db, x)}`).join(',');
  for (const x of ['l-int', 'l-ext', 'l-hyb']) await bearbeiten(db, weg, x, { notes: 'geprüft' });
  const nachher = ['l-int', 'l-ext', 'l-hyb'].map((x) => `${art(db, x)}:${kostenJetzt(db, x)}`).join(',');
  const quellen = ['l-int', 'l-ext', 'l-hyb'].map((x) => ws.repairWorkSource(kopf(db, x), []).kind).join(',');
  ok(vorher === nachher && vorher === 'internal:0,external:30,hybrid:20' && quellen === 'inhouse,external,hybrid',
    `§6 (${weg}) Altbestand nach einer Bearbeitung unverändert: Art, Kosten, Anzeige (${nachher} / ${quellen})`);
  ok(await zeile(db, weg, 'l-ext', OWN) === 'OK' && art(db, 'l-ext') === 'external' && kopf(db, 'l-ext').workshopSupplierId === 'sup-1' && Math.abs(kostenJetzt(db, 'l-ext') - 30) < 0.0005,
    `§6 (${weg}) Altgebühr + eigene Zeile, Betrag ohne Nachweis: bleibt External, Gebühr 30 bleibt (${kostenJetzt(db, 'l-ext')})`);
  // Material von einem Lieferanten, der keine Werkstatt ist: keine Werkstattarbeit, keine eigene Arbeitsquelle.
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('gold-sup','branch-main','Gold',1,0,?,?)", [NOW, NOW]);
  reload();
  useRepairStore.getState().addRepairLine('l-int', { supplierId: 'gold-sup', costAmount: 13, materialKind: 'gold', description: '21K' } as never);
  reload();
  ok(art(db, 'l-int') === 'internal' && kopf(db, 'l-int').workshopSupplierId === null && ws.repairWorkSource(kopf(db, 'l-int'), zeilen(db, 'l-int')).kind === 'inhouse',
    `§6 (${weg}) Materiallieferant zählt nie als Werkstatt oder Arbeitsquelle (bleibt Internal)`);
}

// ══ §7 REP-2026-00002-Muster: alter Bestand bleibt, keine rückwirkende Änderung ═══════════════════
{
  const db = welt();
  // So steht REP-2026-00002 in der Produktion: hybrid durch die alte Hochstufung, eine Werkstattzeile, abgerechnet.
  const id = await anlegen(db, 'lokal', { repairType: 'internal' });
  await status(db, 'lokal', id, 'in_progress');
  await zeile(db, 'lokal', id, WS);
  db.run("UPDATE repairs SET repair_type = 'hybrid' WHERE id = ?", [id]);
  reload();
  const vor = konten(db) + '|' + marge(db, id);
  reload();
  ok(art(db, id) === 'hybrid' && konten(db) + '|' + marge(db, id) === vor, '§7 bestehender Hybrid-Datensatz: Laden ändert nichts (keine rückwirkende Umstellung)');
  ok(Math.abs(kostenAlt(db, id, 'hybrid') - kostenAlt(db, id, 'external')) < 0.0005,
    '§7 die vorbereitete Korrektur hybrid → external ist hier kostengleich (eigene Kosten 0, eine Werkstattzeile)');
}

// ══ §9 REPAIR COST FINAL SAFETY — Spiegel nur mit Nachweis; Altgebühr bleibt neben Material — Primary und PC2 ══════
{
  const f = (o: Record<string, unknown>) => tr.decideRepairType({ currentType: 'external', scope: 'CUSTOMER', status: 'in_progress',
    internalCost: 25, estimatedCost: 25, workshopSupplierId: 'w', plannedWorkshopSupplierId: null, workLines: [{ supplierId: 'w' }, { supplierId: null }],
    openLineTotal: 25, ...o } as never);
  let d = f({});
  ok(d.type === 'external' && d.kept === 'MIRROR' && d.internalCost === undefined, `§9 gleicher Betrag OHNE Nachweis: nichts geraten, bleibt External, Betrag bleibt (${S(d)})`);
  d = f({ mirroredAmount: 25 });
  ok(d.type === 'hybrid' && d.mirror === 'NEUTRALIZED' && d.internalCost === 0, `§9 mit Nachweis der Anlage: Hybrid, Spiegel 25 → 0 (${S(d)})`);
  d = f({ mirroredAmount: 25, internalCost: 15 });
  ok(d.type === 'external' && d.kept === 'MIRROR', '§9 Nachweis über 25, im Feld steht 15: kein Spiegel mehr, bleibt External');
  d = f({ mirroredAmount: 0 });
  ok(d.kept === 'MIRROR', '§9 Nachweis gelöscht (von Hand geändert): bleibt External');
  d = f({ workLines: [{ supplierId: null }], openLineTotal: 0, assignedWorkshopSupplierId: 'w', headerFeeKept: true, internalCost: 0 });
  ok(d.type === 'hybrid' && costMod.repairCostParts({ repairType: 'hybrid', internalCost: 0, estimatedCost: 25, workshopSupplierId: 'w' }, 5, { headerFeeKept: true }).total === 30,
    '§9 Altgebühr + eigene Arbeit: Hybrid, die Gebühr (25) gilt neben den Zeilen (5) weiter');
  const k = (r: Record<string, unknown>, ls: Array<Record<string, unknown>>) => costMod.repairHeaderFeeKept(r as never, ls as never);
  const kopfW = { repairType: 'external', workshopSupplierId: 'w' };
  ok(k(kopfW, [{ supplierId: 'm', materialKind: 'stone' }]) && k(kopfW, [{ supplierId: null }]) && k(kopfW, [{ supplierId: null, materialKind: 'stone' }]),
    '§9 Gebühr bleibt neben Material (anderer Lieferant, ohne Lieferant) und eigener Arbeit');
  ok(!k(kopfW, []) && !k(kopfW, [{ supplierId: 'w' }]) && !k(kopfW, [{ supplierId: 'x' }]) && !k(kopfW, [{ supplierId: 'w', materialKind: 'stone' }])
    && !k({ repairType: 'internal', workshopSupplierId: 'w' }, [{ supplierId: null }]) && !k({ repairType: 'external' }, [{ supplierId: null }]),
    '§9 nicht bei: Werkstatt-Arbeitszeile, Zeile desselben Lieferanten (auch bisherige Altfälle), eigener Art, ohne Werkstatt');
}
for (const weg of WEGE) {
  const db = welt();
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('mat-sup','branch-main','Steine',1,0,?,?)", [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('sup-2','branch-main','Werkstatt 2',1,1,?,?)", [NOW, NOW]);
  reload();
  const altGebuehr = (id: string): string => {
    insert(db, 'repairs', { id, branch_id: 'branch-main', repair_number: 'ALT-' + id, customer_id: 'cust-1', repair_scope: 'CUSTOMER',
      repair_type: 'external', workshop_supplier_id: 'sup-1', estimated_cost: 25, internal_cost: 25, issue_description: 'Alt', charge_to_customer: 70,
      status: 'in_progress', tax_scheme: 'VAT_10', images: '[]', item_attributes: '{}', voucher_code: 'V' + id, revision: 1, received_at: NOW, created_at: NOW, updated_at: NOW });
    reload();
    return id;
  };
  const material = (id: string, sup: string) => {
    useRepairStore.getState().addRepairLine(id, { supplierId: sup, costAmount: 13, materialKind: 'stone', description: 'Stein' } as never);
    reload();
  };

  // A) Nachgewiesener Spiegel: Anlage mit Gebühr 25 (Werkstattzeile 25, Spiegel 25), dann eigene Politur → 25, nicht 50.
  const a = await anlegen(db, weg, { repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 25 });
  ok(kopf(db, a).internalCost === 25 && protokoll(db, a, 'internalCostMirrored').includes('25'), `§9 (${weg}) die Anlage protokolliert den Spiegel 25`);
  await status(db, weg, a, 'in_progress');
  ok(await zeile(db, weg, a, OWN) === 'OK' && art(db, a) === 'hybrid' && kopf(db, a).internalCost === 0 && Math.abs(kostenJetzt(db, a) - 25) < 0.0005 && Math.abs(marge(db, a) - 45) < 0.0005,
    `§9 (${weg}) + eigene Zeile: Hybrid, Spiegel weg, Kosten 25, Marge 45 (${S(kopf(db, a))})`);
  ok(await status(db, weg, a, 'sent_to_workshop') === 'OK' && await status(db, weg, a, 'ready') === 'OK' && await abrechnen(db, weg, a) === 'OK', `§9 (${weg}) Ready + abgerechnet`);
  const inv = s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [a]);
  ok(ausgabenZahl(db, a) === 1 && Math.abs(ausgaben(db, a) - 25) < 0.0005 && Math.abs(ap(db, 'sup-1') - 25) < 0.0005
    && n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [inv]) === 25,
    `§9 (${weg}) Buchungen: eine Ausgabe 25, Rechnungseinstand 25`);

  // B) Echte eigene Kosten, gleich hoch wie der Voranschlag: kein Nachweis → unangetastet, kein Doppel, kein Verlust.
  const b = await anlegen(db, weg, { repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 25, internalCost: 25 });
  ok(protokoll(db, b, 'internalCostMirrored').length === 0, `§9 (${weg}) eingetragene eigene Kosten 25 = Voranschlag: KEIN Spiegel-Nachweis`);
  const vorB = kostenJetzt(db, b);
  ok(await zeile(db, weg, b, OWN) === 'OK' && art(db, b) === 'external' && kopf(db, b).internalCost === 25 && protokoll(db, b, 'repairTypeKept').includes('MIRROR')
    && Math.abs(kostenJetzt(db, b) - vorB) < 0.0005, `§9 (${weg}) + eigene Zeile: unverändert External, Betrag bleibt, Konflikt im Protokoll, Kosten wie vorher (${vorB})`);

  // C) Spiegel von Hand geändert und zurück: der Nachweis ist weg.
  const c = await anlegen(db, weg, { repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 25 });
  await bearbeiten(db, weg, c, { internalCost: 30 }); await bearbeiten(db, weg, c, { internalCost: 25 });
  ok(await zeile(db, weg, c, OWN) === 'OK' && art(db, c) === 'external' && kopf(db, c).internalCost === 25,
    `§9 (${weg}) von Hand geändert und zurück: kein Nachweis mehr, bleibt unverändert (${S(kopf(db, c))})`);

  // D) Echte eigene Kosten bei Internal bleiben: 15 + Werkstatt 20 = 35.
  const e = await anlegen(db, weg, { repairType: 'internal', internalCost: 15 });
  await zeile(db, weg, e, WS);
  ok(art(db, e) === 'hybrid' && kopf(db, e).internalCost === 15 && Math.abs(kostenJetzt(db, e) - 35) < 0.0005, `§9 (${weg}) Internal 15 + Werkstatt 20: 35, unangetastet`);

  // E) Altgebühr 25, zuerst Material 13: die Gebühr bleibt; „ready" bucht sie einmal; die Werkstattzeile ersetzt sie.
  const g = altGebuehr('g-' + weg);
  const apVor = ap(db, 'sup-1');
  material(g, 'mat-sup');
  ok(kopf(db, g).workshopSupplierId === 'sup-1' && art(db, g) === 'external' && Math.abs(kostenJetzt(db, g) - 38) < 0.0005 && Math.abs(marge(db, g) - 32) < 0.0005
    && ws.repairWorkSource(kopf(db, g), zeilen(db, g)).workshopIds.includes('sup-1'),
    `§9 (${weg}) erste Materialzeile: Werkstatt und Gebühr bleiben, Kosten 25 + 13 = 38, Marge 32 (${S(kopf(db, g))} ${kostenJetzt(db, g)})`);
  ok(await status(db, weg, g, 'sent_to_workshop') === 'OK' && await status(db, weg, g, 'ready') === 'OK', `§9 (${weg}) Sent to workshop → Ready`);
  ok(Math.abs(ap(db, 'sup-1') - apVor - 25) < 0.0005 && Math.abs(ausgaben(db, g) - 38) < 0.0005 && ausgeglichen(db),
    `§9 (${weg}) bei „ready": Gebühr einmal gebucht (Werkstatt +${ap(db, 'sup-1') - apVor}, Ausgaben ${ausgaben(db, g)}), ausgeglichen`);
  ok(await zeile(db, weg, g, { ...WS, costAmount: 25 }) === 'OK' && Math.abs(ap(db, 'sup-1') - apVor - 25) < 0.0005 && Math.abs(ausgaben(db, g) - 38) < 0.0005
    && Math.abs(kostenJetzt(db, g) - 38) < 0.0005 && kopf(db, g).workshopSupplierId === 'sup-1' && ausgeglichen(db),
    `§9 (${weg}) Werkstattzeile ersetzt die Gebühr: keine zweite Verbindlichkeit (Werkstatt +${ap(db, 'sup-1') - apVor}, Ausgaben ${ausgaben(db, g)}, Kosten ${kostenJetzt(db, g)})`);

  // F) Material storniert: die Gebühr gilt weiter. Andere Werkstatt / Material derselben Werkstatt: unverändert, Nein.
  const h = altGebuehr('h-' + weg);
  material(h, 'mat-sup');
  ok(await storno(db, weg, h, zeilen(db, h)[0].id) === 'OK' && kopf(db, h).workshopSupplierId === 'sup-1' && Math.abs(kostenJetzt(db, h) - 25) < 0.0005,
    `§9 (${weg}) Materialzeile storniert: Werkstatt und Gebühr 25 bleiben`);
  const vorH = S(kopf(db, h));
  ok(await zeile(db, weg, h, { ...WS, supplierId: 'sup-2' }) === 'REPAIR_HEADER_FEE_OPEN' && S(kopf(db, h)) === vorH && zeilen(db, h).length === 0,
    `§9 (${weg}) Arbeitszeile einer ANDEREN Werkstatt: nicht zuordenbar, Nein, nichts geändert`);
  let nein2 = '';
  try { material(h, 'sup-1'); } catch (x) { nein2 = code(x); }
  ok(nein2 === 'REPAIR_HEADER_FEE_OPEN' && S(kopf(db, h)) === vorH, `§9 (${weg}) Material derselben Werkstatt: nicht zuordenbar, Nein (${nein2})`);
  ok(ausgeglichen(db), `§9 (${weg}) Hauptbuch ausgeglichen`);
  ergebnis['M-' + weg] = konten(db);
}
ok(ergebnis['M-lokal'] === ergebnis['M-fern'], `§9 Primary == PC2: dieselben Buchungssummen (${ergebnis['M-lokal']} / ${ergebnis['M-fern']})`);

// ══ §8 Verdrahtung ═══════════════════════════════════════════════════════════════════════════════
{
  const store = codeOf(src('src/stores/repairStore.ts'));
  ok(!/currentType === 'internal' && hasExternalLine\) newType = 'hybrid'/.test(store), '§8 die alte Hochstufung steht nicht mehr direkt im Store');
  ok((store.match(/repairTypeDecisionFor\(/g) ?? []).length === 3, '§8 eine Entscheidung: Nachziehen nach Zeilen + Planänderung (+ Definition)');
  ok(/data\.plannedWorkshopSupplierId !== undefined[\s\S]{0,200}before\?\.plannedWorkshopSupplierId/.test(store), '§8 Planänderung im Bearbeiten-Weg (Primary und PC2 über das Haus)');
  const regel = src('src/core/repairs/repair-type-rule.ts');
  ok(!/from '@\/stores|getDatabase|query\(/.test(regel), '§8 die Regel ist rein (kein Store, keine Datenbank)');
  ok(!/repairCostParts\s*=|export function repairCostParts/.test(regel), '§8 die Kostenformel ist unverändert (nur benutzt)');
}

console.log(`\nREPAIR-TYPE FINAL CORRECTION: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('REPAIR_TYPE_FINAL_CORRECTION_PROVED');
