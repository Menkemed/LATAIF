// ════════════════════════════════════════════════════════════════════════════
// REPAIR-REDESIGN A–G — Arbeitsquelle, Filter, getrennte Kosten, 0.000 eigene Arbeit (Primary == PC2), geplante Werkstatt.
// Run: node --experimental-strip-types test/repair-redesign/repair-redesign.test.ts
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
const { computeRepairTotalCost } = await import('../../src/stores/repairStore.ts');
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

// ── 1) Die reine Ableitung: wer arbeitet ─────────────────────────────────────
{
  const L = (o: Record<string, unknown>) => ({ status: 'OPEN', ...o });
  const k = (r: Record<string, unknown>, ls: Array<Record<string, unknown>>) => ws.repairWorkSource(r as never, ls.map(L) as never).kind;
  ok(k({ repairType: 'internal' }, [{ workType: 'polishing', costAmount: 0 }]) === 'inhouse', 'SOURCE eigene Arbeitszeile → In-house');
  ok(k({ repairType: 'internal' }, [{ workType: 'service', supplierId: 'w-a', costAmount: 20 }]) === 'external', 'SOURCE nur Werkstattzeile → External (auch wenn „internal" gespeichert)');
  ok(k({ repairType: 'hybrid' }, [{ workType: 'polishing' }, { workType: 'service', supplierId: 'w-a', costAmount: 20 }]) === 'hybrid', 'SOURCE eigene + Werkstattzeile → Hybrid');
  ok(k({ repairType: 'hybrid' }, [{ workType: 'polishing' }, { workType: 'service', supplierId: 'w-a', status: 'CANCELLED' }]) === 'inhouse',
    'SOURCE nach Storno der Werkstattzeile → In-house (gespeichertes „hybrid" zählt nicht, die Zeilen zählen)');
  ok(k({ repairType: 'internal' }, [{ workType: 'polishing' }, { materialKind: 'gold', supplierId: 'gold-sup', costAmount: 13 }]) === 'inhouse',
    'SOURCE ein Materiallieferant ist KEINE Werkstatt');
  ok(k({ repairType: 'hybrid', workshopSupplierId: 'gold-sup' }, [{ materialKind: 'stone', supplierId: 'gold-sup', costAmount: 13 }]) === 'inhouse',
    'SOURCE nur Material + hochgestuftes „hybrid" vom Materiallieferanten → In-house');
  const geplant = ws.repairWorkSource({ repairType: 'hybrid', plannedWorkshopSupplierId: 'w-a' }, []);
  ok(geplant.kind === 'hybrid' && geplant.plannedWorkshopId === 'w-a' && S(geplant.workshopIds) === S(['w-a']),
    'SOURCE neu angelegt „In-house + Werkstatt A (ohne Gebühr)" → Hybrid, A eingeplant');
  const geplantMitEigener = ws.repairWorkSource({ repairType: 'hybrid', plannedWorkshopSupplierId: 'w-a' }, [L({ workType: 'polishing' })]);
  ok(geplantMitEigener.kind === 'hybrid' && geplantMitEigener.plannedWorkshopId === 'w-a',
    'SOURCE die geplante Werkstatt bleibt, wenn eigene Arbeit dazukommt (vorher verschwand sie mit `workshop_supplier_id`)');
  const alt = ws.repairWorkSource({ repairType: 'external', workshopSupplierId: 'w-b' }, []);
  ok(alt.kind === 'external' && alt.assignedWorkshopId === 'w-b' && S(alt.workshopIds) === S(['w-b']), 'SOURCE ältere Reparatur: Werkstatt ohne jede Zeile = zugeordnet');
  ok(k({ repairType: 'internal' }, []) === 'inhouse' && k({ repairType: 'external' }, []) === 'external' && k({ repairType: 'hybrid' }, []) === 'hybrid',
    'SOURCE ohne Zeilen: die beim Anlegen gewählte Art');
  ok(ws.repairWorkSource({ repairType: 'external' }, []).externalWithoutWorkshop, 'SOURCE External ohne Werkstatt → „No workshop yet"');
}

// ── 2) Die Filter: Arbeitsart und Werkstatt an DERSELBEN Beteiligung ─────────
{
  const hyb = { repairType: 'hybrid', issueDescription: 'Polish + clasp' };
  const hybL = [{ status: 'OPEN', workType: 'polishing', costAmount: 0 }, { status: 'OPEN', workType: 'service', supplierId: 'w-a', costAmount: 20 }];
  const m = (r: Record<string, unknown>, ls: unknown[], f: Record<string, unknown>) => ws.matchRepairWork(r as never, ls as never, f as never);
  ok(m(hyb, hybL, { workType: 'polishing', source: 'inhouse' }).match, 'FILTER Polishing + In-house → Treffer');
  ok(m(hyb, hybL, { workType: 'service', workshopId: 'w-a' }).match, 'FILTER Service + Workshop A → Treffer');
  ok(!m(hyb, hybL, { workType: 'polishing', workshopId: 'w-a' }).match, 'FILTER Polishing + Workshop A → KEIN Treffer (verschiedene Zeilen)');
  ok(!m(hyb, hybL, { workType: 'polishing', source: 'external' }).match, 'FILTER Polishing + External → kein Treffer');
  ok(m(hyb, hybL, { source: 'inhouse' }).match && m(hyb, hybL, { source: 'external' }).match && m(hyb, hybL, { source: 'hybrid' }).match,
    'FILTER Hybrid erscheint unter In-house, External und Hybrid');
  ok(m(hyb, hybL, { source: 'hybrid', workType: 'polishing' }).match && !m({ repairType: 'internal' }, [hybL[0]], { source: 'hybrid' }).match,
    'FILTER „Hybrid" ist die ganze Reparatur');
  const alt = { repairType: 'internal', issueDescription: 'Polish' };
  ok(m(alt, [], { workType: 'polishing' }).match && m(alt, [], { workType: 'polishing' }).viaIssue, 'FILTER älteres „Polish" im Issue: gefunden, als „aus dem Issue" markiert');
  ok(!m(alt, [], { workType: 'polishing', issueFallback: false }).match, 'FILTER …ohne Issue-Suche nicht');
  ok(!m({ repairType: 'internal', issueDescription: 'Polish' }, [{ status: 'OPEN', workType: 'service' }], { workType: 'polishing' }).match,
    'FILTER mit Arbeitszeilen zählt das Issue nicht mehr (die Zeile ist die Wahrheit)');
  const plan = { repairType: 'hybrid', plannedWorkshopSupplierId: 'w-a', issueDescription: 'Polish' };
  ok(m(plan, [], { workshopId: 'w-a' }).match, 'FILTER geplante Werkstatt ohne Zeile: unter Workshop A');
  ok(!m(plan, [], { workType: 'polishing', workshopId: 'w-a' }).match,
    'FILTER geplant + In-house ohne Zeilen: Issue-Art + Werkstatt wäre geraten → kein Treffer');
  ok(m({ repairType: 'external', plannedWorkshopSupplierId: 'w-a', issueDescription: 'Polish' }, [], { workType: 'polishing', workshopId: 'w-a' }).match,
    'FILTER genau EINE Beteiligung: Issue-Art + Werkstatt eindeutig → Treffer');
  ok(m({ repairType: 'external' }, [], { source: 'unassigned' }).match && !m(plan, [], { source: 'unassigned' }).match, 'FILTER „No workshop yet"');
  ok(!m({ repairType: 'internal' }, [{ status: 'OPEN', materialKind: 'gold', supplierId: 'gold-sup', costAmount: 13 }], { workshopId: 'gold-sup' }).match,
    'FILTER ein Materiallieferant ist unter „Workshop" nie ein Treffer');
}

// ── 3) Kosten: getrennt, dieselbe Summe wie Marge/Rechnung, keine Doppelzählung ──
{
  const cases: Array<[string, Record<string, unknown>, Array<Record<string, unknown>>]> = [
    ['internal ohne Zeilen, eigene Kosten 7', { repairType: 'internal', internalCost: 7 }, []],
    ['external mit gespiegeltem internalCost 30 + Werkstattzeile 30', { repairType: 'external', internalCost: 30, estimatedCost: 30, workshopSupplierId: 'w-a' }, [{ status: 'OPEN', supplierId: 'w-a', costAmount: 30 }]],
    ['hybrid: eigene 0 + Werkstatt 20 + Material 15', { repairType: 'hybrid', internalCost: 0 }, [{ status: 'OPEN', costAmount: 0 }, { status: 'OPEN', supplierId: 'w-a', costAmount: 20 }, { status: 'OPEN', materialKind: 'gold', supplierId: 'g', costAmount: 15 }]],
    ['ältere external ohne Zeilen, Gebühr 18', { repairType: 'external', estimatedCost: 18, workshopSupplierId: 'w-b' }, []],
  ];
  for (const [name, r, ls] of cases) {
    const v = ws.repairCostView(r as never, ls as never);
    const linesTotal = ls.filter((l) => l.status === 'OPEN').reduce((s, l) => s + Number(l.costAmount || 0), 0);
    ok(Math.abs(v.total - computeRepairTotalCost(r as never, linesTotal)) < 0.0005 && Math.abs(v.work + v.material - v.linesTotal) < 0.0005,
      `COST ${name}: Summe = computeRepairTotalCost (${v.total}), Arbeit ${v.work} + Material ${v.material}`);
  }
  const ext = ws.repairCostView({ repairType: 'external', internalCost: 30, estimatedCost: 30, workshopSupplierId: 'w-a' }, [{ status: 'OPEN', supplierId: 'w-a', costAmount: 30 }]);
  ok(ext.total === 30 && ext.own === 0, 'COST external: der gespiegelte internalCost zählt NICHT neben der Werkstattzeile (30, nicht 60)');
  const hyb = ws.repairCostView({ repairType: 'hybrid' }, [{ status: 'OPEN', costAmount: 0 }, { status: 'OPEN', supplierId: 'w-a', costAmount: 20 }, { status: 'OPEN', materialKind: 'gold', supplierId: 'g', costAmount: 15 }]);
  ok(hyb.work === 20 && hyb.material === 15 && hyb.total === 35, 'COST Hybrid: Arbeit 20 (eigene 0 + Werkstatt 20), Material 15, gesamt 35');
  ok(ws.repairEstimateRole({ repairType: 'external', workshopSupplierId: 'w-b' }, false) === 'fee' && ws.repairEstimateRole({ repairType: 'external', workshopSupplierId: 'w-b' }, true) === 'info'
    && ws.repairEstimateRole({ repairType: 'internal' }, false) === 'info' && ws.repairEstimateRole({ repairType: 'external' }, false) === 'info',
    'COST „Estimated" ist nur bei der Altgebühr (Werkstatt ohne Zeilen) eine Gebühr, sonst Information');
}

// ── 4) Kostenregel einer Arbeitszeile und Aufteilung beim Anlegen ────────────
{
  ok(ws.repairLineCostIssue(null, 0) === null && ws.repairLineCostIssue(undefined, 0) === null, 'RULE eigene Arbeit 0.000 ist zulässig');
  ok(ws.repairLineCostIssue('w-a', 0) === 'LINE_COST_REQUIRED' && ws.repairLineCostIssue('w-a', 20) === null, 'RULE Werkstattzeile braucht ihren Betrag über 0');
  ok(ws.repairLineCostIssue(null, -1) === 'LINE_COST_INVALID' && ws.repairLineCostIssue(null, Number.NaN) === 'LINE_COST_INVALID', 'RULE negativ/keine Zahl: Nein');
  const sp = ws.repairCreateWorkshopSplit;
  ok(S(sp({ repairType: 'external', workshopSupplierId: 'w-a' })) === S({ repairType: 'external', workshopSupplierId: undefined, plannedWorkshopSupplierId: 'w-a' }),
    'SPLIT external ohne Gebühr → nur eingeplant');
  ok(sp({ repairType: 'hybrid', workshopSupplierId: 'w-a', estimatedCost: 20 }).workshopSupplierId === 'w-a'
    && sp({ repairType: 'hybrid', workshopSupplierId: 'w-a', estimatedCost: 20 }).plannedWorkshopSupplierId === undefined, 'SPLIT mit Gebühr wie bisher (Werkstattzeile entsteht)');
  ok(sp({ repairType: 'internal', workshopSupplierId: 'w-a' }).workshopSupplierId === undefined, 'SPLIT eigene Arbeit hat keine Werkstatt');
}

// ── 5) Am echten Haus: New Repair ohne Arbeitszeile, geplante Werkstatt — keine Buchung ──
async function anlegen(db: Db, weg: 'lokal' | 'fern', form: Record<string, unknown>): Promise<string> {
  const basis = { repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Polish + clasp', taxScheme: 'VAT_10',
    chargeToCustomer: 70, receivedAt: HEUTE, ...form };
  const anlage = ws.repairCreateWorkshopSplit(basis as never);
  if (weg === 'lokal') return (await house.createRepairOnPrimary(anlage as never)).id;
  const o = await cmd.runRepairCreate(deps(db), identity(nx(), 'repairs.create'), rules.repairCreateBody(anlage as never, [])) as Out;
  ok(o.kind === 'ok', `NEW (fern) angenommen (${o.code || 'ok'})`);
  reload();
  return String(o.value?.repairId ?? o.value?.id ?? '');
}
const ergebnisse: Record<string, string> = {};
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  db.run('UPDATE suppliers SET is_workshop = 1');
  const vor = buchungen(db);
  const id = await anlegen(db, weg, { repairType: 'hybrid', workshopSupplierId: 'sup-1' });
  reload();
  const k = kopf(db, id);
  ok(k.repairType === 'hybrid' && k.plannedWorkshopSupplierId === 'sup-1' && !k.workshopSupplierId && zeilen(db, id).length === 0,
    `NEW (${weg}) In-house + Werkstatt ohne Gebühr: Hybrid, Werkstatt eingeplant, KEINE Zeile, keine Altzuordnung (${S(k)})`);
  const quelle = ws.repairWorkSource(k, zeilen(db, id));
  ok(quelle.kind === 'hybrid' && quelle.plannedWorkshopId === 'sup-1', `NEW (${weg}) angezeigt: Hybrid mit geplanter Werkstatt`);
  // Eine Schätzung dazu und durch alle Stufen bis „ready": eine geplante Werkstatt bucht NICHTS.
  await house.updateRepairOnPrimary(id, { ...useRepairStore.getState().getRepair(id), estimatedCost: 25 } as never, rev(db, id));
  for (const st of ['in_progress', 'sent_to_workshop', 'ready'] as const) {
    await house.updateRepairStatusOnPrimary(id, st, { expectedRevision: rev(db, id) });
    reload();
  }
  ok(ausgabenZahl(db, id) === 0 && ap(db, 'sup-1') === 0 && buchungen(db) === vor && ausgeglichen(db),
    `NEW (${weg}) geplant bis Ready mit Schätzung 25: keine Ausgabe, keine Verbindlichkeit, keine Buchung`);
  ergebnisse[weg] = S([k.repairType, k.plannedWorkshopSupplierId, k.workshopSupplierId, zeilen(db, id).length]);
}
ok(ergebnisse.lokal === ergebnisse.fern, `NEW Primary == PC2 (${ergebnisse.lokal} / ${ergebnisse.fern})`);

// ── 6) Eigene Arbeit 0.000 am Primary UND an PC2; Werkstatt 0 abgewiesen; keine Doppelzeile ──
const nullErgebnis: Record<string, string> = {};
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  db.run('UPDATE suppliers SET is_workshop = 1');
  const id = await anlegen(db, 'lokal', { repairType: 'internal' });
  reload();
  const vor = buchungen(db);
  const neueZeile = async (body: Record<string, unknown>, cid = nx()): Promise<Out | string> => (weg === 'lokal'
    ? nein(house.addRepairLineOnPrimary(id, body as never))
    : await Promise.resolve().then(() => life.runAddRepairLine(deps(db), identity(cid, 'repairs.add_line', 'h-' + cid), { repairId: id, expectedRevision: rev(db, id), ...body }))
      .catch((e: unknown) => ({ kind: 'business_error', code: code(e) })) as Out);
  const a = await neueZeile({ workType: 'polishing', costAmount: 0, description: 'High polish' });
  reload();
  const ls = zeilen(db, id);
  ok((weg === 'lokal' ? a === '' : (a as Out).kind === 'ok') && ls.length === 1 && ls[0].costAmount === 0 && !ls[0].supplierId && ls[0].workType === 'polishing',
    `ZERO (${weg}) eigene Politur mit 0.000 gespeichert (${S(ls)})`);
  const w0 = await neueZeile({ workType: 'service', costAmount: 0, supplierId: 'sup-1' });
  const wNeg = await neueZeile({ workType: 'polishing', costAmount: -2 });
  reload();
  const c0 = weg === 'lokal' ? w0 : code(w0);
  const cNeg = weg === 'lokal' ? wNeg : code(wNeg);
  ok(c0 === 'LINE_COST_REQUIRED' && /LINE_COST_INVALID|0 or more|INVALID_PAYLOAD/.test(String(cNeg)) && zeilen(db, id).length === 1,
    `ZERO (${weg}) Werkstattzeile 0 / negativer Betrag: Nein, keine Zeile (${c0} / ${cNeg})`);
  // In Arbeit: die 0-Zeile bucht nichts (keine Ausgabe, keine eigene Arbeit).
  await house.updateRepairStatusOnPrimary(id, 'in_progress', { expectedRevision: rev(db, id) });
  reload();
  ok(ausgabenZahl(db, id) === 0 && buchungen(db) === vor && ausgeglichen(db), `ZERO (${weg}) in Arbeit: 0.000 bucht nichts`);
  // Eine eigene Zeile auf 0 setzen (von 5) — und zurück.
  const z = await neueZeile({ workType: 'engraving', costAmount: 5 });
  reload();
  const zid = zeilen(db, id).find((l) => l.workType === 'engraving')?.id as string;
  ok(!!zid && (weg === 'lokal' ? z === '' : (z as Out).kind === 'ok'), `ZERO (${weg}) eigene Zeile 5 angelegt`);
  const u = weg === 'lokal'
    ? await nein(house.updateRepairLineOnPrimary(id, zid, { costAmount: 0 }, rev(db, id)))
    : code(await life.runUpdateRepairLine(deps(db), identity(nx(), 'repairs.update_line'), { repairId: id, lineId: zid, expectedRevision: rev(db, id), costAmount: 0 }));
  reload();
  ok(u === '' && n(db, 'SELECT cost_amount FROM repair_lines WHERE id = ?', [zid]) === 0 && ausgeglichen(db),
    `ZERO (${weg}) eigene Zeile 5 → 0.000 zulässig, ausgeglichen (${u || 'ok'})`);
  // Fern: dieselbe Kennung zweimal (unklare Antwort, wiederholt) → EINE Zeile.
  if (weg === 'fern') {
    const cid = nx();
    const zahl = zeilen(db, id).length;
    const body = { repairId: id, expectedRevision: rev(db, id), workType: 'plating', costAmount: 0 };
    const e1 = await life.runAddRepairLine(deps(db), identity(cid, 'repairs.add_line', 'same'), body) as Out;
    reload();
    const e2 = await life.runAddRepairLine(deps(db), identity(cid, 'repairs.add_line', 'same'), body) as Out;
    reload();
    ok(e1.kind === 'ok' && e2.kind === 'ok' && zeilen(db, id).length === zahl + 1,
      `ZERO (fern) derselbe Auftrag zweimal (unklare Antwort): genau EINE neue Zeile (${zahl}→${zeilen(db, id).length})`);
    const e3 = await life.runAddRepairLine(deps(db), identity(nx(), 'repairs.add_line'), body) as Out;
    reload();
    ok(code(e3) === 'RECORD_CHANGED' && zeilen(db, id).length === zahl + 1,
      `ZERO (fern) neuer Versuch mit alter Fassung: RECORD_CHANGED, keine zweite Zeile (${code(e3)})`);
  }
  nullErgebnis[weg] = S(zeilen(db, id).filter((l) => l.workType === 'polishing').map((l) => [l.costAmount, l.supplierId]));
}
ok(nullErgebnis.lokal === nullErgebnis.fern, `ZERO Primary == PC2 (${nullErgebnis.lokal})`);

// ── 7) Hybrid am Haus: getrennte Kosten, je Werkstattzeile EINE Verbindlichkeit; Plan erfüllt; Storno ──
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  db.run('UPDATE suppliers SET is_workshop = 1');
  const id = await anlegen(db, 'lokal', { repairType: 'hybrid', workshopSupplierId: 'sup-1' });
  reload();
  const add = async (body: Record<string, unknown>): Promise<void> => {
    if (weg === 'lokal') { await house.addRepairLineOnPrimary(id, body as never); }
    else { const o = await life.runAddRepairLine(deps(db), identity(nx(), 'repairs.add_line'), { repairId: id, expectedRevision: rev(db, id), ...body }) as Out; ok(o.kind === 'ok', `HYB (fern) Zeile (${o.code || 'ok'})`); }
    reload();
  };
  await add({ workType: 'polishing', costAmount: 0, description: 'Full polish' });
  ok(kopf(db, id).plannedWorkshopSupplierId === 'sup-1', `HYB (${weg}) eigene Arbeit dazu: der Plan bleibt`);
  await add({ workType: 'service', costAmount: 20, supplierId: 'sup-1', description: 'Clasp soldering' });
  ok(kopf(db, id).plannedWorkshopSupplierId === null, `HYB (${weg}) die erste Werkstattzeile erfüllt den Plan`);
  // Material von einem Lieferanten, der KEINE Werkstatt ist (Zeile mit material_kind, wie der Materialdialog sie anlegt).
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('gold-sup','branch-main','Gold Supplier',1,0,?,?)", [NOW, NOW]);
  reload();
  useRepairStore.getState().addRepairLine(id, { supplierId: 'gold-sup', costAmount: 15, materialKind: 'gold', description: '21K' } as never);
  reload();
  const ls = zeilen(db, id);
  const k = kopf(db, id);
  const v = ws.repairCostView(k, ls);
  const quelle = ws.repairWorkSource(k, ls);
  ok(v.work === 20 && v.material === 15 && Math.abs(v.total - computeRepairTotalCost(k as never, 35)) < 0.0005 && v.total === 35,
    `HYB (${weg}) Kosten: Arbeit 20, Material 15, gesamt 35 = computeRepairTotalCost`);
  ok(quelle.kind === 'hybrid' && S(quelle.workshopIds) === S(['sup-1']), `HYB (${weg}) Hybrid, Werkstatt nur sup-1 (Goldlieferant zählt nicht)`);
  await house.updateRepairStatusOnPrimary(id, 'in_progress', { expectedRevision: rev(db, id) });
  reload();
  ok(ausgabenZahl(db, id) === 2 && Math.abs(ausgaben(db, id) - 35) < 0.0005 && Math.abs(ap(db, 'sup-1') - 20) < 0.0005
    && Math.abs(ap(db, 'gold-sup') - 15) < 0.0005 && ausgeglichen(db),
    `HYB (${weg}) in Arbeit: je Lieferantenzeile EINE Ausgabe (20 Werkstatt, 15 Material), keine für die 0-Politur, ausgeglichen`);
  // Die Werkstattzeile stornieren → angezeigt In-house; Verbindlichkeit zurück; die gespeicherte Art bleibt.
  const werk = ls.find((l) => l.supplierId === 'sup-1' && !l.materialKind)!;
  if (weg === 'lokal') await house.cancelRepairLineOnPrimary(werk.id);
  else { const o = await life.runCancelRepairLine(deps(db), identity(nx(), 'repairs.cancel_line'), { repairId: id, lineId: werk.id, expectedRevision: rev(db, id) }) as Out; ok(o.kind === 'ok', `HYB (fern) Storno (${o.code || 'ok'})`); }
  reload();
  const nach = ws.repairWorkSource(kopf(db, id), zeilen(db, id));
  ok(nach.kind === 'inhouse' && Math.abs(ap(db, 'sup-1')) < 0.0005 && kopf(db, id).repairType === 'hybrid' && ausgeglichen(db),
    `HYB (${weg}) nach Storno: angezeigt In-house, Werkstatt-Verbindlichkeit zurückgenommen, gespeicherte Art unverändert`);
}

// ── 8) Geplante Werkstatt an der Detailseite ändern/entfernen — Primary und PC2 ──
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  db.run('UPDATE suppliers SET is_workshop = 1');
  const id = await anlegen(db, 'lokal', { repairType: 'external', workshopSupplierId: 'sup-1' });
  reload();
  const vorher = useRepairStore.getState().getRepair(id)!;
  const neu = { ...vorher, plannedWorkshopSupplierId: undefined };
  if (weg === 'lokal') await house.updateRepairOnPrimary(id, neu as never, rev(db, id));
  else {
    const o = await cmd.runRepairUpdate(deps(db), identity(nx(), 'repairs.update'), rules.repairEditBody(id, rev(db, id), vorher as never, neu as never)) as Out;
    ok(o.kind === 'ok', `PLAN (fern) angenommen (${o.code || 'ok'})`);
  }
  reload();
  ok(kopf(db, id).plannedWorkshopSupplierId === null && ws.repairWorkSource(kopf(db, id), []).kind === 'external'
    && ws.repairWorkSource(kopf(db, id), []).externalWithoutWorkshop,
    `PLAN (${weg}) Plan entfernt: External ohne Werkstatt („No workshop yet")`);
}

// ── 9) Lesebefehl fürs Handy: Quelle und getrennte Kosten, Materiallieferant nie Werkstatt ──
{
  const db = freshDb();
  db.run('UPDATE suppliers SET is_workshop = 1');
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('gold-sup','branch-main','Gold Supplier',1,0,?,?)", [NOW, NOW]);
  const id = await anlegen(db, 'lokal', { repairType: 'internal', issueDescription: 'Resize' });
  reload();
  await house.addRepairLineOnPrimary(id, { workType: 'gold_work', costAmount: 5 } as never);
  useRepairStore.getState().addRepairLine(id, { supplierId: 'gold-sup', costAmount: 13, materialKind: 'gold' } as never);
  reload();
  const r = await reg.executeCommand('repairs.list', { actor: { branchId: 'branch-main', tenantId: 'tenant-1', userId: 'user-pc2', role: 'ADMIN' }, input: { limit: 10 } }) as { kind: string; value?: { items: Array<Record<string, unknown>> } };
  const it = r.value?.items.find((x) => x.id === id) as { work?: Record<string, unknown> } | undefined;
  const w = it?.work as { kind: string; workshops: unknown[]; workCost: number; materialCost: number; totalCost: number; workTypes: string[] } | undefined;
  ok(r.kind === 'ok' && w?.kind === 'inhouse' && w.workshops.length === 0 && w.workCost === 5 && w.materialCost === 13 && w.totalCost === 18
    && S(w.workTypes) === S(['gold_work']),
    `READ repairs.list: In-house, keine Werkstatt (Goldlieferant), Arbeit 5 + Material 13 = 18 (${S(w)})`);
}

// ── 10) Verdrahtung der Masken ───────────────────────────────────────────────
{
  const liste = src('src/pages/repairs/RepairList.tsx');
  const quick = src('src/components/repairs/RepairQuickEditModal.tsx');
  const detail = src('src/pages/repairs/RepairDetail.tsx');
  const teile = src('src/components/repairs/RepairWorkParts.tsx');
  ok(/matchRepairWork\(rep, offeneZeilen\.get\(rep\.id\) \?\? \[\]/.test(liste) && /data-repair-filter-worktype/.test(liste)
    && /data-repair-filter-source/.test(liste) && /data-repair-filter-workshop/.test(liste) && /data-repair-filter-issue/.test(liste),
    'WIRE Liste: Arbeitsart-, Quellen- und Werkstattfilter über die geteilte Regel, mit Issue-Schalter');
  ok(/const anlage = repairCreateWorkshopSplit\(form\);/.test(liste) && /data-repair-create-inhouse/.test(liste) && /data-repair-create-external/.test(liste)
    && !/REPAIR_TYPES\.map/.test(liste), 'WIRE New Repair: „Wer arbeitet?" statt Typ-Knöpfen; Werkstatt ohne Gebühr wird eingeplant');
  ok(/data-quick-work-section/.test(quick) && /data-quick-material-section/.test(quick) && /<RepairWorkLineForm/.test(quick)
    && /actualCost: kosten\.hasLines \? rep\.actualCost/.test(quick) && /repairCostView\(rep, offen\)/.test(quick),
    'WIRE Quick Edit: Arbeit und Material getrennt; Actual bei Zeilen nur angezeigt; Summe aus der geteilten Ableitung');
  ok(!/REPAIR_TYPES\.map/.test(detail) && /plannedWorkshopSupplierId/.test(detail) && /<RepairWorkLineForm/.test(detail)
    && /const totalCost = kostenSicht\.total;/.test(detail), 'WIRE Detailseite: kein Typ-Knopf, geplante Werkstatt, gemeinsame Zeilenmaske, Summe = Marge');
  ok(/repairLineCostIssue/.test(teile) && /source: 'inhouse'/.test(teile), 'WIRE Zeilenmaske: dieselbe Kostenregel, Standard eigene Arbeit');
}

console.log(fails.length ? `\nFAIL — repair redesign A–G: ${PASS} passed, ${fails.length} failed` : `\nPASS — repair redesign A–G: ${PASS} passed, 0 failed`);
if (fails.length) process.exit(1);
console.log('REPAIR_REDESIGN_A_G_TESTS');
