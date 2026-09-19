// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Gold: begleichen, Gold-Verbrauch, Material, Kostenzeilen.
// Primary und PC2 mit derselben Hausfolge, atomar, fassungsgeprüft, sicher.
// Run: node test/r6d/gold-parity.test.ts
//
// Gefahren werden der ECHTE Goldkern (`gold-settle.ts`), die ECHTE Hausfolge (`gold-house.ts`), die
// echten Stores, die echte C3A-Maschine (`runRemoteCommand`, durabler Nachweis) und das echte Schema
// samt Migrationen. Gestellt sind nur das Speichern und die Anmeldung.
//
//   §1 Umfang, Registry, Rechte       §2 Primary zuerst: die Regeln, die vorher fehlten
//   §3 Primary == PC2 je Absicht (Zeilen + Hauptbuch), verlorene Antwort (Wiederholung)
//   §4 Fassung (verlorenes Update)    §5 Atomarität (Fehler an echten Wirkungspunkten)
//   §6 Sicherheit                     §7 Hauptbuch ausgeglichen      §8 Client-Modus   §9 Oberfläche
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const settle = await import('../../src/core/gold/gold-settle.ts');
const house = await import('../../src/core/gold/gold-house.ts');
const cmd = await import('../../src/core/bridge/gold-commands.ts');
const { useGoldStore } = await import('../../src/stores/goldStore.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { metalStockByKaratFor } = await import('../../src/core/data/page-reads.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Eine Zeile mit allen NOT-NULL-Spalten, damit ein Test nicht an einer Schema-Kleinigkeit scheitert. */
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = rows(db, `PRAGMA table_info(${table})`);
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    const name = String(c.name);
    if (!c.notnull || c.dflt_value !== null || c.pk || data[name] !== undefined) continue;
    const t = String(c.type || '').toUpperCase();
    data[name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(name) ? NOW : '');
  }
  const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
}

function reloadStores(): void {
  useGoldStore.getState().loadAll();
  useRepairStore.getState().loadRepairs();
  useRepairStore.getState().loadRepairLines();
  useOrderStore.getState().loadOrders();
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
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  insert(db, 'customers', { id: 'c1', branch_id: 'branch-main', first_name: 'Maya', last_name: 'Main', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'cx', branch_id: 'branch-other', first_name: 'Otto', last_name: 'Other', created_at: NOW, updated_at: NOW });
  for (const [id, branch, active] of [['sup-1', 'branch-main', 1], ['sup-2', 'branch-main', 1], ['sup-off', 'branch-main', 0], ['sup-x', 'branch-other', 1]] as Array<[string, string, number]>) {
    insert(db, 'suppliers', { id, branch_id: branch, name: 'Lieferant ' + id, active, created_at: NOW, updated_at: NOW });
  }
  insert(db, 'repairs', { id: 'rep-1', branch_id: 'branch-main', repair_number: 'REP-1', customer_id: 'c1', status: 'in_progress',
    repair_type: 'internal', repair_scope: 'CUSTOMER', tax_scheme: 'ZERO', received_at: NOW, created_at: NOW, updated_at: NOW });
  insert(db, 'repairs', { id: 'rep-x', branch_id: 'branch-other', repair_number: 'REP-X', customer_id: 'cx', status: 'in_progress',
    repair_type: 'internal', repair_scope: 'CUSTOMER', tax_scheme: 'ZERO', received_at: NOW, created_at: NOW, updated_at: NOW });
  for (const [id, branch, st, cust] of [['ord-1', 'branch-main', 'pending', 'c1'], ['ord-2', 'branch-main', 'pending', 'c1'],
    ['ord-c', 'branch-main', 'cancelled', 'c1'], ['ord-x', 'branch-other', 'pending', 'cx']]) {
    insert(db, 'orders', { id, branch_id: branch, order_number: id.toUpperCase(), customer_id: cust, status: st, created_at: NOW, updated_at: NOW });
  }
  // Eine kundenseitige Zeile auf ord-1 — sie darf NICHT über „remove_cost" gehen.
  insert(db, 'order_lines', { id: 'ol-cust', order_id: 'ord-1', description: 'Ring', quantity: 1, unit_price: 500, line_total: 500,
    position: 1, is_customer_facing: 1, status: 'PENDING', created_at: NOW });
  for (const [id, branch, metal, karat, g] of [['pm-21', 'branch-main', 'gold', '21K', 20], ['pm-24', 'branch-main', 'gold', '24K', 10],
    ['pm-s', 'branch-main', 'silver', '999', 50], ['pm-x', 'branch-other', 'gold', '21K', 5]] as Array<[string, string, string, string, number]>) {
    insert(db, 'precious_metals', { id, branch_id: branch, metal_type: metal, karat, weight_grams: g, description: 'seed ' + id,
      status: 'in_stock', images: '[]', created_at: NOW, updated_at: NOW });
  }
  const gp = (id: string, branch: string, sup: string, karat: string, w: number, extra: Record<string, unknown> = {}) =>
    insert(db, 'gold_payables', { id, branch_id: branch, supplier_id: sup, direction: 'we_owe', weight_grams: w, karat,
      settlement_type: 'return_gold', fulfilled_grams: 0, status: 'OPEN', created_at: NOW, updated_at: NOW, ...extra });
  gp('gp-r', 'branch-main', 'sup-1', '21K', 10, { source_repair_id: 'rep-1' });
  gp('gp-o', 'branch-main', 'sup-1', '21K', 10, { source_order_id: 'ord-1' });
  gp('gp-big', 'branch-main', 'sup-1', '21K', 30, { source_repair_id: 'rep-1' });
  gp('gp-x', 'branch-other', 'sup-x', '21K', 5);
  for (const [id, branch, cust, w] of [['gc-1', 'branch-main', 'c1', 5], ['gc-x', 'branch-other', 'cx', 5]] as Array<[string, string, string, number]>) {
    insert(db, 'customer_gold_credits', { id, branch_id: branch, customer_id: cust, source_repair_id: null, weight_grams: w, karat: '21K',
      fulfilled_grams: 0, status: 'OPEN', created_at: NOW, updated_at: NOW });
  }
  setTestDatabase(db as never);
  reloadStores();
  return db;
}

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nextId = (): string => ID(++seq);
const identity = (commandId: string, op: string, branchId = 'branch-main', hash = 'h') => ({
  commandId, tenantId: 'tenant-1', branchId, userId: 'user-test', role: 'ADMIN', op, payloadHash: hash,
});
function deps(db: Db) {
  return {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* gestellt */ },
    now: () => NOW,
  };
}
type Aus = { kind: 'ok' | 'rejected' | 'thrown'; code: string; value: Record<string, unknown>; replayed: boolean; frozen: boolean };
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>): Promise<Aus> {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok', value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '', frozen: false }
      : { kind: 'rejected', code: String(o.code), frozen: o.frozen === true, value: {}, replayed: false };
  } catch (e) {
    return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? (e as Error).message), value: {}, replayed: false, frozen: false };
  }
}
async function primary(fn: () => Promise<unknown>): Promise<Aus> {
  try { return { kind: 'ok', code: '', value: (await fn()) as Record<string, unknown>, replayed: false, frozen: false }; }
  catch (e) { return { kind: 'rejected', code: String((e as { code?: unknown }).code ?? (e as Error).message), value: {}, replayed: false, frozen: false }; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function payloadMsg(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

/** Eine Datenbank, die beim n-ten Treffer scheitert — für die Fehlerinjektion an echten Wirkungspunkten. */
function faulty(db: Db, pattern: RegExp, nth = 1) {
  const f = { armed: true, hits: 0 };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pattern.test(sql)) { f.hits += 1; if (f.hits === nth) throw new Error('INJECTED at ' + pattern); }
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}

// ── Normalisierung: dieselbe Wirkung, egal welche Kennungen/Zeiten sie bekam ──
const SEEDED = new Set(['gp-r', 'gp-o', 'gp-big', 'gp-x', 'gc-1', 'gc-x', 'rep-1', 'rep-x', 'ord-1', 'ord-2', 'ord-c', 'ord-x',
  'sup-1', 'sup-2', 'sup-off', 'sup-x', 'c1', 'cx', 'ol-cust', 'pm-21', 'pm-24', 'pm-s', 'pm-x']);
const idn = (v: unknown): unknown => (v === null || v === undefined || v === '' ? v : SEEDED.has(String(v)) ? v : 'NEU');
const r6 = (v: unknown): number => Math.round(Number(v ?? 0) * 1e6) / 1e6;
function snap(db: Db): string {
  return S({
    gp: rows(db, `SELECT id, branch_id, supplier_id, source_repair_id, source_repair_line_id, source_order_id, source_order_line_id, direction,
        weight_grams, karat, settlement_type, fulfilled_grams, settlement_expense_id, status, notes, revision FROM gold_payables ORDER BY weight_grams, karat, id`)
      .map((r) => ({ ...r, id: idn(r.id), source_repair_line_id: idn(r.source_repair_line_id), source_order_line_id: idn(r.source_order_line_id),
        settlement_expense_id: idn(r.settlement_expense_id), fulfilled_grams: r6(r.fulfilled_grams) }))
      .sort((a, b) => S(a).localeCompare(S(b))),
    gc: rows(db, 'SELECT id, customer_id, source_repair_id, weight_grams, karat, fulfilled_grams, settlement_credit_id, status, notes, revision FROM customer_gold_credits')
      .map((r) => ({ ...r, id: idn(r.id), settlement_credit_id: idn(r.settlement_credit_id), fulfilled_grams: r6(r.fulfilled_grams) }))
      .sort((a, b) => S(a).localeCompare(S(b))),
    mv: rows(db, 'SELECT branch_id, direction, weight_grams, karat, source_bucket, source_id, target_bucket, target_id, related_repair_id, notes FROM gold_movements')
      .map((r) => ({ ...r, weight_grams: r6(r.weight_grams), source_id: idn(r.source_id), target_id: idn(r.target_id) }))
      .sort((a, b) => S(a).localeCompare(S(b))),
    pm: rows(db, "SELECT branch_id, metal_type, karat, ROUND(SUM(weight_grams), 6) AS g FROM precious_metals WHERE status = 'in_stock' GROUP BY branch_id, metal_type, karat ORDER BY 1, 2, 3"),
    exp: rows(db, `SELECT branch_id, category, amount, paid_amount, payment_method, related_module, related_entity_id, supplier_id, status, created_by,
        CASE WHEN description LIKE 'Gold-Settlement:%' THEN 'GOLD' ELSE description END AS d FROM expenses`)
      .map((r) => ({ ...r, related_entity_id: idn(r.related_entity_id) })).sort((a, b) => S(a).localeCompare(S(b))),
    cc: rows(db, 'SELECT branch_id, customer_id, amount, used_amount, status, source_type, source_id, note FROM customer_credits')
      .sort((a, b) => S(a).localeCompare(S(b))),
    rl: rows(db, 'SELECT repair_id, position, supplier_id, work_type, description, cost_amount, material_kind, material_details, status, expense_id IS NOT NULL AS has_exp FROM repair_lines ORDER BY position'),
    ol: rows(db, `SELECT order_id, position, description, quantity, unit_price, line_total, supplier_id, cost_amount, is_customer_facing, material_kind,
        material_details, status, expense_id IS NOT NULL AS has_exp FROM order_lines ORDER BY order_id, position`),
    rep: rows(db, 'SELECT id, repair_type, actual_cost, workshop_supplier_id, revision FROM repairs ORDER BY id'),
    ord: rows(db, 'SELECT id, status, revision FROM orders ORDER BY id'),
    le: rows(db, 'SELECT source_module, account, direction, ROUND(SUM(amount), 3) AS a, COUNT(*) AS c FROM ledger_entries GROUP BY source_module, account, direction ORDER BY 1, 2, 3'),
  });
}
/** Jede Buchung ist in sich ausgeglichen: Σ Soll == Σ Haben je Quelle. */
function balanced(db: Db): boolean {
  const g = rows(db, `SELECT source_module, source_id, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 3) AS d,
      ROUND(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 3) AS c FROM ledger_entries GROUP BY source_module, source_id`);
  return g.every((r) => Math.abs(Number(r.d) - Number(r.c)) < 0.0005);
}
const rev = (db: Db, table: string, id: string): number => n(db, `SELECT revision FROM ${table} WHERE id = ?`, [id]);
const stripIds = (v: Record<string, unknown>): string => S(Object.fromEntries(Object.entries(v)
  .filter(([k]) => k !== 'replayed')
  .map(([k, x]) => [k, Array.isArray(x) ? x.length : (typeof x === 'string' && !SEEDED.has(x) && /^[0-9a-f-]{36}$/.test(x) ? 'NEU' : x)])));

const OPS = ['gold.payables.settle', 'gold.customer_credits.settle', 'repairs.record_gold_usage', 'repairs.add_material', 'orders.add_cost', 'orders.remove_cost'];

// ══ §1 — Umfang, Registry, Rechte ═══════════════════════════════════════════
{
  ok(OPS.every((op) => registry.ALLOWED_MUTATIONS.includes(op)), 'SCOPE die sechs Gold-Absichten sind namentlich freigegeben');
  ok(OPS.every((op) => registry.knownCommands().includes(op)), `SCOPE und registriert (${OPS.filter((op) => !registry.knownCommands().includes(op)).join(',') || 'alle'})`);
  ok(S(cmd.GOLD_OPS) === S(OPS), 'SCOPE die Befehlsdatei kennt genau diese sechs');
  ok(OPS.slice(0, 4).every((op) => op in perms.OPERATION_PERMISSIONS && perms.OPERATION_PERMISSIONS[op] === null),
    'SCOPE kein erfundenes Recht für Begleichen, Gold-Verbrauch und Material (der Primary hat dort kein Tor)');
  ok(['orders.add_cost', 'orders.remove_cost'].every((op) => perms.OPERATION_PERMISSIONS[op] !== null && perms.OPERATION_PERMISSIONS[op] !== undefined),
    'SCOPE „Add Cost" und das Löschen einer Kostenzeile stehen hinter demselben Recht wie am Primary (canManageOrders)');
  ok(!registry.ALLOWED_MUTATIONS.some((op) => /^gold\.(payables|customer_credits)\.(delete|cancel|create)$/.test(op)),
    'SCOPE kein Löschen/Stornieren/freies Anlegen einer Gold-Schuld von außen');
}
marker('CENTRAL_UI_R6D_GOLD_COMMAND_MODEL_PROVED');

// ══ §2 — Primary zuerst: die Regeln, die vorher fehlten ═══════════════════════
{
  // (a) Mehr zurückgeben als offen — die Maske kündigte das Nein an, geprüft wurde es nie.
  let db = freshDb();
  let vor = snap(db);
  let a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', mode: 'return_gold', grams: 10.5, expectedRevision: 1 }));
  ok(a.code === 'GOLD_OVER_SETTLEMENT' && snap(db) === vor, `RULE return_gold über dem Offenen: Nein, nichts geschrieben (${a.code})`);
  a = await primary(() => house.settleGoldCreditOnPrimary({ creditId: 'gc-1', mode: 'return', grams: 5.5 }));
  ok(a.code === 'GOLD_OVER_SETTLEMENT' && snap(db) === vor, `RULE Kundengold zurück über dem Offenen: Nein (${a.code})`);
  a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', mode: 'shop_gold', grams: 10.5 }));
  ok(a.code === 'GOLD_OVER_SETTLEMENT', `RULE Shop-Gold über dem Offenen: Nein (${a.code})`);
  // (b) Mehr geben als im Laden: 25 g 21K bei 20 g Bestand (die Schuld hätte 30 g offen).
  a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-big', mode: 'shop_gold', grams: 25 }));
  ok(a.code === 'GOLD_SHOP_STOCK_INSUFFICIENT' && snap(db) === vor, `RULE Shop-Gold über dem Bestand: Nein, keine negative Zeile (${a.code})`);
  a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-big', mode: 'shop_gold', grams: 20 }));
  ok(a.kind === 'ok' && n(db, "SELECT COALESCE(SUM(weight_grams),0) FROM precious_metals WHERE karat = '21K' AND branch_id = 'branch-main' AND metal_type = 'gold'") === 0,
    'RULE genau der Bestand geht (20 g → 0 g)');
  // (c) Unbekanntes Karat: keine stille Reinheit 1.0 mehr.
  db = freshDb(); vor = snap(db);
  a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', mode: 'shop_gold', grams: 1, sourceKarat: '23K' }));
  ok(a.code === 'GOLD_KARAT_UNKNOWN' && snap(db) === vor, `RULE unbekanntes Quell-Karat: Nein (${a.code})`);
  ok(wirft(() => settle.insertGoldPayable('branch-main', { supplierId: 'sup-1', weightGrams: 1, karat: 'gold' })) === 'GOLD_KARAT_UNKNOWN',
    'RULE eine neue Gold-Schuld nur in einem Karat mit bekannter Reinheit');
  // (d) Karat gegen Karat: 10 g 21K offen, Quelle 24K. 8.759 g ist die nächste 0.001-g-Eingabe → genau beglichen.
  const plan = settle.crossKaratPlan('24K', '21K', 8.759, 10);
  ok(plan.verdict === 'exact' && plan.exactSourceGrams === 8.759 && plan.targetEquivalent > 10,
    `CROSS 8.759 g 24K = ${plan.targetEquivalent.toFixed(5)} g 21K — innerhalb einer halben Eingabestufe: genau (vorher „zu viel")`);
  ok(settle.crossKaratPlan('24K', '21K', 8.758, 10).verdict === 'partial' && settle.crossKaratPlan('24K', '21K', 8.760, 10).verdict === 'over',
    'CROSS die Stufe darunter bleibt teilweise, die darüber ist zu viel');
  a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', mode: 'shop_gold', grams: 8.759, sourceKarat: '24K', expectedRevision: 1 }));
  const gpr = rows(db, "SELECT status, fulfilled_grams FROM gold_payables WHERE id = 'gp-r'")[0];
  ok(a.kind === 'ok' && gpr.status === 'FULFILLED' && Number(gpr.fulfilled_grams) === 10 && a.value.openGrams === 0,
    `CROSS die Schuld ist GENAU erfüllt — kein Staubrest (${S(gpr)})`);
  ok(Math.abs(n(db, "SELECT weight_grams FROM precious_metals WHERE id = 'pm-24'") - 1.241) < 1e-9
    && n(db, "SELECT COUNT(*) FROM gold_movements WHERE target_id = 'gp-r'") === 2,
    'CROSS aus dem 24K-Bestand gehen genau die eingegebenen 8.759 g; zwei Audit-Zeilen (Quelle, Ziel)');
  db = freshDb();
  a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', mode: 'shop_gold', grams: 8.760, sourceKarat: '24K' }));
  ok(a.code === 'GOLD_OVER_SETTLEMENT', `CROSS eine Stufe zu viel: Nein (${a.code})`);
  // (e) Kundengold: mehr verbraucht als gebracht wurde vorher still ignoriert.
  vor = snap(db);
  a = await primary(() => house.recordRepairGoldUsageOnPrimary({ repairId: 'rep-1', source: 'customer', karat: '21K', receivedGrams: 3, usedGrams: 4, leftover: 'credit' }));
  ok(a.code === 'GOLD_USED_EXCEEDS_RECEIVED' && snap(db) === vor, `RULE verbraucht > erhalten: Nein, nichts geschrieben (${a.code})`);
  // (f) „In-house" als Goldschmied: vorher eine Schuld bei „__INHOUSE__".
  a = await primary(() => house.recordRepairGoldUsageOnPrimary({ repairId: 'rep-1', source: 'workshop', karat: '21K', receivedGrams: 3, supplierId: '__INHOUSE__' }));
  ok(a.code === 'SUPPLIER_NOT_FOUND' && snap(db) === vor, `RULE Workshop-Gold braucht einen echten Lieferanten (${a.code})`);
  // (g) Teilweise beglichene Schuld: nicht mehr hart löschbar — auf allen drei Wegen.
  db = freshDb();
  await primary(() => house.addOrderCostOnPrimary({ orderId: 'ord-2', rows: [{ materialKind: 'gold', description: 'Bar', weightGrams: 4, karat: '22K', totalCost: 100, supplierId: 'sup-2' }] }));
  const olGold = String(one(db, "SELECT id FROM order_lines WHERE order_id = 'ord-2'"));
  const gpGold = String(one(db, 'SELECT id FROM gold_payables WHERE source_order_line_id = ?', [olGold]));
  await primary(() => house.settleGoldPayableOnPrimary({ payableId: gpGold, mode: 'return_gold', grams: 1 }));
  vor = snap(db);
  a = await primary(() => house.removeOrderCostOnPrimary({ orderId: 'ord-2', lineId: olGold }));
  ok(a.code === 'GOLD_PAYABLE_PARTLY_SETTLED' && snap(db) === vor, `PARTLY Kostenzeile mit teilweise beglichener Schuld: Nein, nichts gelöscht (${a.code})`);
  ok(wirft(() => useOrderStore.getState().deleteOrderLine(olGold)) === 'GOLD_PAYABLE_PARTLY_SETTLED' && snap(db) === vor,
    'PARTLY …auch der Store-Weg `deleteOrderLine`');
  ok(wirft(() => useGoldStore.getState().deleteGoldPayable(gpGold)) === 'GOLD_PAYABLE_PARTLY_SETTLED' && snap(db) === vor,
    'PARTLY …und das Löschen der Schuld selbst');
  await primary(() => house.addRepairMaterialOnPrimary({ repairId: 'rep-1', rows: [{ materialKind: 'gold', description: 'Wire', weightGrams: 2, karat: '18K', totalCost: 50, supplierId: 'sup-2' }] }));
  const rlGold = String(one(db, "SELECT id FROM repair_lines WHERE repair_id = 'rep-1' AND material_kind = 'gold'"));
  const gpRl = String(one(db, 'SELECT id FROM gold_payables WHERE source_repair_line_id = ?', [rlGold]));
  await primary(() => house.settleGoldPayableOnPrimary({ payableId: gpRl, mode: 'return_gold', grams: 0.5 }));
  vor = snap(db);
  useRepairStore.getState().loadRepairLines();
  const rlCode = wirft(() => useRepairStore.getState().cancelRepairLine(rlGold));
  // POST-PARITY PP-13/PP-14 — auch die aktivierte Eigenleistung der Zeile bleibt unberührt (erst prüfen, dann schreiben).
  ok(rlCode === 'GOLD_PAYABLE_PARTLY_SETTLED' && snap(db) === vor,
    `PARTLY …und das Stornieren einer Reparaturzeile (repairs.cancel_line) (${rlCode})`);
  // (h) Die Maske sieht, was die Regel zulässt: nur GOLD, netto je Karat, nur die eigene Filiale.
  db = freshDb();
  const ms = metalStockByKaratFor({ branchId: 'branch-main' } as never);
  ok(S(ms.rows) === S([{ karat: '24K', grams: 10 }, { karat: '21K', grams: 20 }]),
    `READ der Ladenbestand im Gold-Modal ist Gold (keine 50 g Silber 999), eigene Filiale (${S(ms.rows)})`);
  // (i) R5E bleibt: dieselben Vorgaben der Gold-Schuld aus dem Auftrag.
  const made = useGoldStore.getState().createGoldPayable({ supplierId: 'sup-1', sourceOrderId: 'ord-1', weightGrams: 2, karat: '22K' });
  const mr = rows(db, 'SELECT direction, settlement_type, status, revision FROM gold_payables WHERE id = ?', [made.id])[0];
  ok(mr.direction === 'we_owe' && mr.settlement_type === 'return_gold' && mr.status === 'OPEN' && (made as unknown as { revision: number }).revision === 1,
    `R5E createGoldPayable: we_owe / return_gold / OPEN, die Zeile trägt ihre Fassung (${S(mr)})`);
}
marker('CENTRAL_UI_R6D_GOLD_PRIMARY_RULES_PROVED');

// ══ §3 — Primary == PC2 je Absicht, verlorene Antwort ═══════════════════════
type Run = (d: ReturnType<typeof deps>, i: ReturnType<typeof identity>, raw: unknown) => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>;
interface Fall {
  name: string;
  op: string;
  setup?: (db: Db) => Promise<void>;
  primary: (db: Db) => Promise<unknown>;
  run: Run;
  body: (db: Db) => Record<string, unknown>;
  expect?: (db: Db) => string | null;
}
const setupCost = async (db: Db): Promise<void> => {
  await house.addOrderCostOnPrimary({ orderId: 'ord-2', rows: [
    { materialKind: 'labor', description: 'Setting', totalCost: 80, supplierId: 'sup-1' },
    { materialKind: 'gold', description: 'Bar', weightGrams: 4, karat: '22K', totalCost: 100, supplierId: 'sup-2' },
  ] });
  void db;
};
const laborLine = (db: Db): string => String(one(db, "SELECT id FROM order_lines WHERE order_id = 'ord-2' AND material_kind = 'labor'"));
const goldLine = (db: Db): string => String(one(db, "SELECT id FROM order_lines WHERE order_id = 'ord-2' AND material_kind = 'gold'"));
const MAT_ROWS = [
  { materialKind: 'diamond', description: 'Round Brilliant', quantity: 2, caratPerPiece: 0.5, totalCost: 400, supplierId: 'sup-1' },
  { materialKind: 'gold', description: 'Gold wire', weightGrams: 3.25, karat: '21K', totalCost: 150, supplierId: 'sup-2' },
  { materialKind: 'stone', description: 'Sapphire', quantity: 1, caratPerPiece: 1.2, totalCost: 90, supplierId: '__INHOUSE__' },
];
const COST_ROWS = [
  { materialKind: 'labor', description: 'Goldsmith labor', totalCost: 120, supplierId: 'sup-1' },
  { materialKind: 'gold', description: 'Extra gold', weightGrams: 5, karat: '22K', totalCost: 260, supplierId: 'sup-2' },
  { materialKind: 'diamond', description: 'Melee', quantity: 10, caratPerPiece: 0.02, totalCost: 75, supplierId: '__INHOUSE__' },
];
const FAELLE: Fall[] = [
  { name: 'payable return_gold (Teil)', op: 'gold.payables.settle',
    primary: () => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 4, notes: 'part' }),
    run: cmd.runGoldPayableSettle, body: () => ({ payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 4, notes: 'part' }),
    expect: (db) => (n(db, "SELECT fulfilled_grams FROM gold_payables WHERE id='gp-r'") === 4 && n(db, "SELECT weight_grams FROM precious_metals WHERE id='pm-21'") === 24 ? null : 'return_gold bucht NICHT 4 g in den Bestand') },
  { name: 'payable shop_gold (voll, gleiches Karat)', op: 'gold.payables.settle',
    primary: () => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', expectedRevision: 1, mode: 'shop_gold', grams: 10 }),
    run: cmd.runGoldPayableSettle, body: () => ({ payableId: 'gp-r', expectedRevision: 1, mode: 'shop_gold', grams: 10 }),
    expect: (db) => (one(db, "SELECT status FROM gold_payables WHERE id='gp-r'") === 'FULFILLED' && n(db, "SELECT weight_grams FROM precious_metals WHERE id='pm-21'") === 10 ? null : 'shop_gold nimmt NICHT 10 g aus dem Bestand') },
  { name: 'payable shop_gold (Karat gegen Karat, genau)', op: 'gold.payables.settle',
    primary: () => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', expectedRevision: 1, mode: 'shop_gold', grams: 8.759, sourceKarat: '24K' }),
    run: cmd.runGoldPayableSettle, body: () => ({ payableId: 'gp-r', expectedRevision: 1, mode: 'shop_gold', grams: 8.759, sourceKarat: '24K' }),
    expect: (db) => (n(db, "SELECT fulfilled_grams FROM gold_payables WHERE id='gp-r'") === 10 ? null : 'nicht genau erfüllt') },
  { name: 'payable money (Auftrags-Gold → Inventory)', op: 'gold.payables.settle',
    primary: () => house.settleGoldPayableOnPrimary({ payableId: 'gp-o', expectedRevision: 1, mode: 'money', agreedBhd: 245.5 }),
    run: cmd.runGoldPayableSettle, body: () => ({ payableId: 'gp-o', expectedRevision: 1, mode: 'money', agreedBhd: 245.5 }),
    expect: (db) => {
      const e = rows(db, "SELECT category, amount, payment_method, status FROM expenses WHERE related_module = 'gold_payable'")[0];
      const l = rows(db, "SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'EXPENSE' ORDER BY direction");
      return e?.category === 'Inventory' && e.payment_method === 'bank' && Number(e.amount) === 245.5
        && S(l.map((x) => [x.account, x.direction, x.amount])) === S([['ACCOUNTS_PAYABLE', 'CREDIT', 245.5], ['EXPENSES_OPERATING', 'DEBIT', 245.5]])
        ? null : `Ausgabe/Buchung falsch (${S(e)} ${S(l)})`;
    } },
  { name: 'payable money (Reparatur-Gold → RepairCosts)', op: 'gold.payables.settle',
    primary: () => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', expectedRevision: 1, mode: 'money', agreedBhd: 99 }),
    run: cmd.runGoldPayableSettle, body: () => ({ payableId: 'gp-r', expectedRevision: 1, mode: 'money', agreedBhd: 99 }),
    expect: (db) => (one(db, "SELECT category FROM expenses WHERE related_entity_id = 'gp-r'") === 'RepairCosts' ? null : 'Kategorie falsch') },
  { name: 'Kundengold zurück (Teil)', op: 'gold.customer_credits.settle',
    primary: () => house.settleGoldCreditOnPrimary({ creditId: 'gc-1', expectedRevision: 1, mode: 'return', grams: 2 }),
    run: cmd.runGoldCreditSettle, body: () => ({ creditId: 'gc-1', expectedRevision: 1, mode: 'return', grams: 2 }) },
  { name: 'Kundengold → BHD-Guthaben', op: 'gold.customer_credits.settle',
    primary: () => house.settleGoldCreditOnPrimary({ creditId: 'gc-1', expectedRevision: 1, mode: 'money', agreedBhd: 50, notes: 'agreed' }),
    run: cmd.runGoldCreditSettle, body: () => ({ creditId: 'gc-1', expectedRevision: 1, mode: 'money', agreedBhd: 50, notes: 'agreed' }),
    expect: (db) => {
      const l = rows(db, "SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'GOLD_CONVERSION' ORDER BY direction");
      return n(db, 'SELECT COUNT(*) FROM customer_credits') === 1
        && S(l.map((x) => [x.account, x.direction, x.amount])) === S([['CUSTOMER_CREDIT', 'CREDIT', 50], ['GOLD_CREDIT_CLEARING', 'DEBIT', 50]])
        ? null : `Guthaben/Buchung falsch (${S(l)})`;
    } },
  { name: 'Gold-Verbrauch: Workshop', op: 'repairs.record_gold_usage',
    primary: () => house.recordRepairGoldUsageOnPrimary({ repairId: 'rep-1', expectedRevision: 1, source: 'workshop', karat: '21K', receivedGrams: 3, supplierId: 'sup-2', settlementType: 'pay_money' }),
    run: cmd.runRepairGoldUsage, body: () => ({ repairId: 'rep-1', expectedRevision: 1, source: 'workshop', karat: '21K', receivedGrams: 3, supplierId: 'sup-2', settlementType: 'pay_money' }),
    expect: (db) => (one(db, "SELECT settlement_type FROM gold_payables WHERE supplier_id = 'sup-2'") === 'pay_money' ? null : 'keine Schuld') },
  { name: 'Gold-Verbrauch: Kunde → Guthaben', op: 'repairs.record_gold_usage',
    primary: () => house.recordRepairGoldUsageOnPrimary({ repairId: 'rep-1', expectedRevision: 1, source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 2, leftover: 'credit' }),
    run: cmd.runRepairGoldUsage, body: () => ({ repairId: 'rep-1', expectedRevision: 1, source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 2, leftover: 'credit' }),
    expect: (db) => (n(db, "SELECT weight_grams FROM customer_gold_credits WHERE source_repair_id = 'rep-1'") === 3 ? null : 'kein Guthaben über 3 g') },
  { name: 'Gold-Verbrauch: Kunde → Laden behält', op: 'repairs.record_gold_usage',
    primary: () => house.recordRepairGoldUsageOnPrimary({ repairId: 'rep-1', expectedRevision: 1, source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 1, leftover: 'shop_keep' }),
    run: cmd.runRepairGoldUsage, body: () => ({ repairId: 'rep-1', expectedRevision: 1, source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 1, leftover: 'shop_keep' }),
    expect: (db) => (n(db, "SELECT weight_grams FROM precious_metals WHERE id='pm-21'") === 24 ? null : 'Bestand nicht +4 g') },
  { name: 'Add Material (drei Positionen)', op: 'repairs.add_material',
    primary: () => house.addRepairMaterialOnPrimary({ repairId: 'rep-1', expectedRevision: 1, rows: MAT_ROWS }),
    run: cmd.runRepairMaterial, body: () => ({ repairId: 'rep-1', expectedRevision: 1, rows: MAT_ROWS }),
    expect: (db) => {
      const rl = rows(db, "SELECT material_kind, supplier_id, expense_id FROM repair_lines WHERE repair_id = 'rep-1' ORDER BY position");
      const gp = rows(db, "SELECT supplier_id, weight_grams, karat, source_repair_line_id FROM gold_payables WHERE supplier_id = 'sup-2'");
      return rl.length === 3 && rl[0].supplier_id === 'sup-1' && !!rl[0].expense_id && rl[1].supplier_id === null && rl[2].supplier_id === null
        && gp.length === 1 && Number(gp[0].weight_grams) === 3.25 && !!gp[0].source_repair_line_id
        ? null : `Zeilen/Schuld falsch (${S(rl)} ${S(gp)})`;
    } },
  { name: 'Add Cost (drei Positionen)', op: 'orders.add_cost',
    primary: () => house.addOrderCostOnPrimary({ orderId: 'ord-2', expectedRevision: 1, rows: COST_ROWS }),
    run: cmd.runOrderCost, body: () => ({ orderId: 'ord-2', expectedRevision: 1, rows: COST_ROWS }),
    expect: (db) => {
      const ol = rows(db, "SELECT material_kind, supplier_id, expense_id, is_customer_facing, status, description FROM order_lines WHERE order_id = 'ord-2' ORDER BY position");
      const gp = rows(db, "SELECT supplier_id, weight_grams, karat, direction, settlement_type FROM gold_payables WHERE source_order_id = 'ord-2'");
      return ol.length === 3 && !!ol[0].expense_id && ol[1].supplier_id === null && !ol[1].expense_id && ol[2].description === '10× 0.02ct Melee'
        && ol.every((x) => x.is_customer_facing === 0 && x.status === 'ARRIVED')
        && gp.length === 1 && gp[0].direction === 'we_owe' && gp[0].settlement_type === 'return_gold'
        ? null : `Zeilen/Schuld falsch (${S(ol)} ${S(gp)})`;
    } },
  { name: 'Kostenzeile löschen (mit A/P)', op: 'orders.remove_cost', setup: setupCost,
    primary: (db) => house.removeOrderCostOnPrimary({ orderId: 'ord-2', expectedRevision: rev(db, 'orders', 'ord-2'), lineId: laborLine(db) }),
    run: cmd.runOrderCostRemove, body: (db) => ({ orderId: 'ord-2', expectedRevision: rev(db, 'orders', 'ord-2'), lineId: laborLine(db) }),
    expect: (db) => (n(db, "SELECT COUNT(*) FROM expenses WHERE related_module = 'order'") === 0
      && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'EXPENSE'") > 2 ? null : 'Ausgabe nicht storniert/gelöscht') },
  { name: 'Kostenzeile löschen (mit offener Gramm-Schuld)', op: 'orders.remove_cost', setup: setupCost,
    primary: (db) => house.removeOrderCostOnPrimary({ orderId: 'ord-2', expectedRevision: rev(db, 'orders', 'ord-2'), lineId: goldLine(db) }),
    run: cmd.runOrderCostRemove, body: (db) => ({ orderId: 'ord-2', expectedRevision: rev(db, 'orders', 'ord-2'), lineId: goldLine(db) }),
    expect: (db) => (n(db, "SELECT COUNT(*) FROM gold_payables WHERE source_order_id = 'ord-2'") === 0 ? null : 'Schuld blieb') },
];

for (const fall of FAELLE) {
  const dbP = freshDb();
  if (fall.setup) { await fall.setup(dbP); reloadStores(); }
  const p = await primary(() => fall.primary(dbP));
  const sP = snap(dbP);
  const eP = fall.expect ? fall.expect(dbP) : null;
  const balP = balanced(dbP);

  const dbR = freshDb();
  if (fall.setup) { await fall.setup(dbR); reloadStores(); }
  const cid = nextId();
  const body = fall.body(dbR);
  const r = await fern(() => fall.run(deps(dbR), identity(cid, fall.op), body));
  const sR = snap(dbR);
  ok(p.kind === 'ok' && r.kind === 'ok', `PARITY ${fall.name}: beide Wege gelingen (${p.code || 'ok'} / ${r.code || 'ok'})`);
  ok(eP === null, `PARITY ${fall.name}: die Wirkung ist die des Hauses${eP ? ' — ' + eP : ''}`);
  ok(sP === sR, `PARITY ${fall.name}: Zeilen, Bestand, Bewegungen, Ausgaben, Guthaben, Hauptbuch Primary == PC2${sP === sR ? '' : `\n     P ${sP.slice(0, 1500)}\n     R ${sR.slice(0, 1500)}`}`);
  ok(stripIds(p.value) === stripIds(r.value), `PARITY ${fall.name}: dieselbe Antwort (${stripIds(p.value)} / ${stripIds(r.value)})`);
  ok(balP && balanced(dbR), `LEDGER ${fall.name}: jede Buchung ausgeglichen (Σ Soll == Σ Haben)`);
  // Verlorene Antwort: dieselbe Kennung noch einmal — die eingefrorene Antwort, keine zweite Wirkung.
  const again = await fern(() => fall.run(deps(dbR), identity(cid, fall.op), body));
  ok(again.kind === 'ok' && again.replayed && snap(dbR) === sR && S(again.value) === S(r.value),
    `REPLAY ${fall.name}: dieselbe Kennung → replayed, genau eine Wirkung`);
}
marker('CENTRAL_UI_R6D_GOLD_PRIMARY_PARITY_PROVED');
marker('CENTRAL_UI_R6D_GOLD_REPLAY_PROVED');
marker('CENTRAL_UI_R6D_GOLD_LEDGER_BALANCED_PROVED');

// ══ §4 — Fassung: kein verlorenes Update ═══════════════════════════════════════
{
  // Zwei Masken sehen dieselbe Schuld (Fassung 1). Vorher schrieb die zweite ABSOLUT „gesehen + neu" zurück.
  const db = freshDb();
  const a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 3 }));
  const vor = snap(db);
  const b = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 3 }));
  ok(a.kind === 'ok' && b.code === 'RECORD_CHANGED' && snap(db) === vor && n(db, "SELECT fulfilled_grams FROM gold_payables WHERE id='gp-r'") === 3,
    `STALE am Primary: die zweite Maske mit der alten Fassung bekommt ein Nein, nichts überschrieben (${b.code})`);
  const stale = async (op: string, run: Run, body: Record<string, unknown>, what: string) => {
    const d = freshDb();
    const before = snap(d);
    const o = await fern(() => run(deps(d), identity(nextId(), op), body));
    ok(o.kind === 'rejected' && o.code === 'RECORD_CHANGED' && o.frozen && snap(d) === before, `STALE PC2 ${what}: alte Fassung → RECORD_CHANGED, eingefroren, nichts geschrieben (${o.code})`);
  };
  await stale('gold.payables.settle', cmd.runGoldPayableSettle, { payableId: 'gp-r', expectedRevision: 2, mode: 'return_gold', grams: 1 }, 'Gold-Schuld');
  await stale('gold.customer_credits.settle', cmd.runGoldCreditSettle, { creditId: 'gc-1', expectedRevision: 7, mode: 'return', grams: 1 }, 'Kundengold');
  await stale('repairs.record_gold_usage', cmd.runRepairGoldUsage, { repairId: 'rep-1', expectedRevision: 9, source: 'workshop', karat: '21K', receivedGrams: 1, supplierId: 'sup-1' }, 'Gold-Verbrauch');
  await stale('repairs.add_material', cmd.runRepairMaterial, { repairId: 'rep-1', expectedRevision: 9, rows: MAT_ROWS }, 'Material');
  await stale('orders.add_cost', cmd.runOrderCost, { orderId: 'ord-2', expectedRevision: 9, rows: COST_ROWS }, 'Kosten');
}
marker('CENTRAL_UI_R6D_GOLD_STALE_REVISION_PROVED');

// ══ §5 — Atomarität: Fehler an echten Wirkungspunkten ═════════════════════════
{
  const inject = async (what: string, pattern: RegExp, nth: number, op: string, run: Run, bodyOf: (db: Db) => Record<string, unknown>, setup?: (db: Db) => Promise<void>) => {
    const db = freshDb();
    if (setup) { await setup(db); reloadStores(); }
    const body = bodyOf(db);
    const before = snap(db);
    const { db: bad, f } = faulty(db, pattern, nth);
    setTestDatabase(bad as never);
    const id = identity(nextId(), op);
    const o = await fern(() => run(deps(bad), id, body));
    setTestDatabase(db as never);
    reloadStores();
    ok(f.hits >= nth && o.kind === 'thrown' && snap(db) === before && lookupCommand(db as never, id as never).kind === 'fresh',
      `ATOMIC ${what}: scheitert es dort, gibt es NICHTS davon — kein halber Stand, kein Nachweis (${o.code.slice(0, 60)})`);
    f.armed = false;
    const retry = await fern(() => run(deps(db), id, body));
    ok(retry.kind === 'ok' && !retry.replayed, `ATOMIC ${what}: dieselbe Kennung danach läuft genau einmal`);
  };
  await inject('Gold → BHD, Buchung scheitert', /INSERT INTO ledger_entries/, 1, 'gold.payables.settle', cmd.runGoldPayableSettle,
    () => ({ payableId: 'gp-o', expectedRevision: 1, mode: 'money', agreedBhd: 120 }));
  await inject('Gold zurück, Audit-Zeile scheitert (nach Schuld + Bestand)', /INSERT INTO gold_movements/, 1, 'gold.payables.settle', cmd.runGoldPayableSettle,
    () => ({ payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 2 }));
  await inject('Karat gegen Karat, zweite Audit-Zeile scheitert', /INSERT INTO gold_movements/, 2, 'gold.payables.settle', cmd.runGoldPayableSettle,
    () => ({ payableId: 'gp-r', expectedRevision: 1, mode: 'shop_gold', grams: 4, sourceKarat: '24K' }));
  await inject('Kundengold → BHD, Gold-Guthaben scheitert (nach Guthaben + Buchung)', /UPDATE customer_gold_credits/, 1, 'gold.customer_credits.settle', cmd.runGoldCreditSettle,
    () => ({ creditId: 'gc-1', expectedRevision: 1, mode: 'money', agreedBhd: 40 }));
  await inject('Laden behält Kundengold, Audit scheitert (nach Bestand)', /INSERT INTO gold_movements/, 1, 'repairs.record_gold_usage', cmd.runRepairGoldUsage,
    () => ({ repairId: 'rep-1', expectedRevision: 1, source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 1, leftover: 'shop_keep' }));
  await inject('Material, die ZWEITE Zeile scheitert', /INSERT INTO repair_lines/, 2, 'repairs.add_material', cmd.runRepairMaterial,
    () => ({ repairId: 'rep-1', expectedRevision: 1, rows: MAT_ROWS }));
  await inject('Material, Lieferanten-Buchung scheitert (vorher verschluckt)', /INSERT INTO ledger_entries/, 1, 'repairs.add_material', cmd.runRepairMaterial,
    () => ({ repairId: 'rep-1', expectedRevision: 1, rows: MAT_ROWS }));
  await inject('Kosten, die Gramm-Schuld scheitert (nach Zeilen + A/P)', /INSERT INTO gold_payables/, 1, 'orders.add_cost', cmd.runOrderCost,
    () => ({ orderId: 'ord-2', expectedRevision: 1, rows: COST_ROWS }));
  await inject('Kosten, A/P-Buchung scheitert (vorher verschluckt)', /INSERT INTO ledger_entries/, 1, 'orders.add_cost', cmd.runOrderCost,
    () => ({ orderId: 'ord-2', expectedRevision: 1, rows: COST_ROWS }));
  await inject('Kostenzeile löschen, das Löschen der Zeile scheitert (nach Schuld + Ausgabe)', /DELETE FROM order_lines/, 1, 'orders.remove_cost', cmd.runOrderCostRemove,
    (db) => ({ orderId: 'ord-2', expectedRevision: rev(db, 'orders', 'ord-2'), lineId: laborLine(db) }), setupCost);
  await inject('Kostenzeile löschen, Storno-Buchung scheitert (vorher verschluckt)', /INSERT INTO ledger_entries/, 1, 'orders.remove_cost', cmd.runOrderCostRemove,
    (db) => ({ orderId: 'ord-2', expectedRevision: rev(db, 'orders', 'ord-2'), lineId: laborLine(db) }), setupCost);

  // Der bestätigte Primary-Befund: ein gescheitertes BHD-Guthaben wurde verschluckt, das Gold trotzdem geschlossen.
  const db = freshDb();
  const before = snap(db);
  const { db: bad } = faulty(db, /INSERT INTO customer_credits/);
  setTestDatabase(bad as never);
  const a = await primary(() => house.settleGoldCreditOnPrimary({ creditId: 'gc-1', expectedRevision: 1, mode: 'money', agreedBhd: 40 }));
  setTestDatabase(db as never);
  ok(a.kind === 'rejected' && snap(db) === before && one(db, "SELECT status FROM customer_gold_credits WHERE id='gc-1'") === 'OPEN',
    `ATOMIC am Primary: scheitert das BHD-Guthaben, bleibt das Gold-Guthaben OFFEN (vorher: FULFILLED ohne Gegenwert) (${a.code.slice(0, 50)})`);
  const { db: bad2 } = faulty(db, /INSERT INTO gold_movements/);
  setTestDatabase(bad2 as never);
  const b = await primary(() => house.addRepairMaterialOnPrimary({ repairId: 'rep-1', rows: MAT_ROWS }));
  setTestDatabase(db as never);
  ok(b.kind === 'ok', 'ATOMIC (Material schreibt keine Gold-Bewegung — die Injektion trifft dort nichts)');
  const db2 = freshDb();
  const before2 = snap(db2);
  const { db: bad3 } = faulty(db2, /INSERT INTO gold_payables/);
  setTestDatabase(bad3 as never);
  const c = await primary(() => house.addOrderCostOnPrimary({ orderId: 'ord-2', rows: COST_ROWS }));
  setTestDatabase(db2 as never);
  reloadStores();
  ok(c.kind === 'rejected' && snap(db2) === before2, 'ATOMIC am Primary: „Add Cost" steht ganz oder gar nicht (vorher blieben die ersten Positionen stehen)');
}
marker('CENTRAL_UI_R6D_GOLD_ATOMICITY_PROVED');

// ══ §6 — Sicherheit: der Primary entscheidet ════════════════════════════════
{
  const db = freshDb();
  const before = snap(db);
  const d = deps(db);
  const fr = async (op: string, run: Run, body: Record<string, unknown>, branch = 'branch-main') => fern(() => run(d, identity(nextId(), op, branch), body));
  let o = await fr('gold.payables.settle', cmd.runGoldPayableSettle, { payableId: 'gp-x', expectedRevision: 1, mode: 'return_gold', grams: 1 });
  ok(o.code === 'GOLD_PAYABLE_NOT_FOUND' && o.frozen, `SECURITY eine Gold-Schuld einer fremden Filiale gibt es nicht (${o.code})`);
  o = await fr('gold.customer_credits.settle', cmd.runGoldCreditSettle, { creditId: 'gc-x', expectedRevision: 1, mode: 'money', agreedBhd: 5 });
  ok(o.code === 'GOLD_CREDIT_NOT_FOUND', `SECURITY ein fremdes Kundengold auch nicht (${o.code})`);
  o = await fr('gold.payables.settle', cmd.runGoldPayableSettle, { payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 1 }, 'branch-other');
  ok(o.code === 'BRANCH_MISMATCH', `SECURITY ein Ausweis einer anderen Filiale: Nein (${o.code})`);
  o = await fr('repairs.add_material', cmd.runRepairMaterial, { repairId: 'rep-x', expectedRevision: 1, rows: MAT_ROWS });
  ok(o.code === 'REPAIR_NOT_FOUND', `SECURITY fremde Reparatur (${o.code})`);
  o = await fr('orders.add_cost', cmd.runOrderCost, { orderId: 'ord-x', expectedRevision: 1, rows: COST_ROWS });
  ok(o.code === 'ORDER_NOT_FOUND', `SECURITY fremder Auftrag (${o.code})`);
  o = await fr('orders.add_cost', cmd.runOrderCost, { orderId: 'ord-c', expectedRevision: 1, rows: COST_ROWS });
  ok(o.code === 'ORDER_CANCELLED', `SECURITY stornierter Auftrag nimmt keine Kosten (wie die Maske) (${o.code})`);
  o = await fr('orders.remove_cost', cmd.runOrderCostRemove, { orderId: 'ord-1', expectedRevision: rev(db, 'orders', 'ord-1'), lineId: 'ol-cust' });
  ok(o.code === 'LINE_NOT_A_COST_LINE', `SECURITY eine Kundenposition ist keine Kostenzeile (${o.code})`);
  o = await fr('orders.remove_cost', cmd.runOrderCostRemove, { orderId: 'ord-2', expectedRevision: 1, lineId: 'ol-cust' });
  ok(o.code === 'LINE_NOT_ON_ORDER', `SECURITY eine Zeile eines anderen Auftrags (${o.code})`);
  for (const [sup, what] of [['sup-x', 'fremder'], ['sup-off', 'inaktiver'], ['nope', 'unbekannter']]) {
    o = await fr('repairs.add_material', cmd.runRepairMaterial, { repairId: 'rep-1', expectedRevision: 1, rows: [{ ...MAT_ROWS[0], supplierId: sup }] });
    ok(o.code === 'SUPPLIER_NOT_FOUND', `SECURITY ${what} Lieferant im Material (${o.code})`);
  }
  o = await fr('repairs.record_gold_usage', cmd.runRepairGoldUsage, { repairId: 'rep-1', expectedRevision: 1, source: 'workshop', karat: '21K', receivedGrams: 2, supplierId: '__INHOUSE__' });
  ok(o.code === 'SUPPLIER_NOT_FOUND', `SECURITY „In-house" ist kein Goldschmied (${o.code})`);
  o = await fr('repairs.record_gold_usage', cmd.runRepairGoldUsage, { repairId: 'rep-1', expectedRevision: 1, source: 'customer', karat: '21K', receivedGrams: 2, usedGrams: 3, leftover: 'credit' });
  ok(o.code === 'GOLD_USED_EXCEEDS_RECEIVED', `SECURITY verbraucht > erhalten (${o.code})`);
  o = await fr('gold.payables.settle', cmd.runGoldPayableSettle, { payableId: 'gp-r', expectedRevision: 1, mode: 'shop_gold', grams: 1, sourceKarat: '99K' });
  ok(o.code === 'GOLD_KARAT_UNKNOWN', `SECURITY unbekanntes Karat (${o.code})`);
  o = await fr('gold.payables.settle', cmd.runGoldPayableSettle, { payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 10.01 });
  ok(o.code === 'GOLD_OVER_SETTLEMENT', `SECURITY Überbegleichung (${o.code})`);
  o = await fr('gold.payables.settle', cmd.runGoldPayableSettle, { payableId: 'gp-big', expectedRevision: 1, mode: 'shop_gold', grams: 21 });
  ok(o.code === 'GOLD_SHOP_STOCK_INSUFFICIENT', `SECURITY mehr als im Laden (${o.code})`);
  o = await fr('gold.payables.settle', cmd.runGoldPayableSettle, { payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 1.0005 });
  ok(o.code === 'GOLD_GRAMS_INVALID', `SECURITY Gramm in 0.001-g-Schritten (${o.code})`);
  o = await fr('repairs.add_material', cmd.runRepairMaterial, { repairId: 'rep-1', expectedRevision: 1, rows: [{ ...MAT_ROWS[0], materialKind: 'labor', quantity: undefined, caratPerPiece: undefined }] });
  ok(o.code === 'MATERIAL_KIND_INVALID', `SECURITY „Labor" bietet die Reparatur-Maske nicht an (${o.code})`);
  o = await fr('repairs.add_material', cmd.runRepairMaterial, { repairId: 'rep-1', expectedRevision: 1, rows: [{ ...MAT_ROWS[0], karat: '21K' }] });
  ok(o.code === 'MATERIAL_FIELD_NOT_APPLICABLE', `SECURITY ein Karat an einem Diamanten (${o.code})`);
  ok(snap(db) === before, 'SECURITY keine dieser Anfragen hat etwas geschrieben');

  // Rumpf: verbotene und abgeleitete Felder, falsche Zahlen, Buchungsdaten.
  const base = { payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 1 };
  for (const k of ['fulfilledGrams', 'openGrams', 'status', 'revision', 'branchId', 'userId', 'weightGrams', 'karat', 'targetEquivalent',
    'spot', 'meltValue', 'fineGrams', 'expenseId', 'settlementExpenseId', 'method', 'paymentMethod', 'category', 'ledger', 'ledgerEntries', 'account', 'debit', 'credit', 'amount']) {
    ok(/the primary decides/.test(payloadMsg(() => cmd.parsePayableSettle({ ...base, [k]: 1 }))), `SECURITY ${k} bestimmt der Primary (Gold-Schuld)`);
  }
  for (const k of ['customerCreditId', 'settlementCreditId', 'fulfilledGrams', 'ledgerEntries']) {
    ok(/the primary decides/.test(payloadMsg(() => cmd.parseCreditSettle({ creditId: 'gc-1', expectedRevision: 1, mode: 'return', grams: 1, [k]: 1 }))), `SECURITY ${k} bestimmt der Primary (Kundengold)`);
  }
  for (const k of ['supplierName', 'costAmount', 'unitPrice', 'lineTotal', 'customerPrice', 'expenseId', 'position', 'status', 'isCustomerFacing', 'materialDetails']) {
    ok(/the primary decides/.test(payloadMsg(() => cmd.parseOrderCost({ orderId: 'ord-2', expectedRevision: 1, rows: [{ ...COST_ROWS[0], [k]: 1 }] }))), `SECURITY ${k} einer Position bestimmt der Primary`);
  }
  ok(/unknown field/.test(payloadMsg(() => cmd.parsePayableSettle({ ...base, foo: 1 }))), 'SECURITY ein unbekanntes Feld wird abgewiesen statt ignoriert');
  for (const bad of [0, -1, NaN, '2', undefined]) {
    ok(payloadMsg(() => cmd.parsePayableSettle({ ...base, grams: bad })) !== '', `SECURITY Gramm ${String(bad)}: Nein`);
    ok(payloadMsg(() => cmd.parsePayableSettle({ payableId: 'gp-r', expectedRevision: 1, mode: 'money', agreedBhd: bad })) !== '', `SECURITY BHD ${String(bad)}: Nein`);
  }
  for (const bad of [undefined, 0, -1, 1.5, '1']) {
    ok(payloadMsg(() => cmd.parsePayableSettle({ ...base, expectedRevision: bad })) !== '', `SECURITY ohne gültige gesehene Fassung kein Begleichen (${String(bad)})`);
  }
  ok(payloadMsg(() => cmd.parsePayableSettle({ ...base, mode: 'money', agreedBhd: 5 })) !== '' && payloadMsg(() => cmd.parsePayableSettle({ ...base, sourceKarat: '24K' })) !== '',
    'SECURITY Gramm UND Geld, oder ein Quell-Karat beim Rückgeben: Nein');
  ok(payloadMsg(() => cmd.parseRepairGoldUsage({ repairId: 'rep-1', expectedRevision: 1, source: 'workshop', karat: '21K', receivedGrams: 1, supplierId: 'sup-1', leftover: 'credit' })) !== ''
    && payloadMsg(() => cmd.parseRepairGoldUsage({ repairId: 'rep-1', expectedRevision: 1, source: 'customer', karat: '21K', receivedGrams: 1, leftover: 'credit', usedGrams: -1 })) !== '',
    'SECURITY Gold-Verbrauch: Rest beim Workshop-Gold, negativer Verbrauch: Nein');
  ok(payloadMsg(() => cmd.parseOrderCost({ orderId: 'ord-2', expectedRevision: 1, rows: [] })) !== ''
    && payloadMsg(() => cmd.parseOrderCost({ orderId: 'ord-2', expectedRevision: 1, rows: [{ ...COST_ROWS[0], totalCost: -5 }] })) !== '',
    'SECURITY keine Position, negativer Betrag: Nein');
}
marker('CENTRAL_UI_R6D_GOLD_INPUT_AUTHORITY_PROVED');

// ══ §7 — Client-Modus: keine lokale Datenbank ═══════════════════════════════════
{
  const db = freshDb();
  const before = snap(db);
  store.set('lataif_runtime_mode', 'client');
  const a = await primary(() => house.settleGoldPayableOnPrimary({ payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold', grams: 1 }));
  const b = await primary(() => house.addOrderCostOnPrimary({ orderId: 'ord-2', expectedRevision: 1, rows: COST_ROWS }));
  let lokal = 0;
  let geschickt: Record<string, unknown> | null = null;
  const req = { payableId: 'gp-r', expectedRevision: 1, mode: 'return_gold' as const, grams: 1 };
  const w = await runSharedWrite(true, {
    local: () => { lokal += 1; return house.settleGoldPayableOnPrimary(req); },
    remote: () => house.goldPayableSettleBody(req),
  }, { send: async (body: Record<string, unknown>) => { geschickt = body; return { kind: 'ok', value: { status: 'OPEN' }, replayed: false } as never; } });
  store.delete('lataif_runtime_mode');
  ok(a.code === 'CLIENT_WRITE_UNSUPPORTED' && b.code === 'CLIENT_WRITE_UNSUPPORTED' && snap(db) === before,
    `CLIENT der Primary-Anschluss verweigert auf einem Client, bevor er die Datenbank fragt (${a.code})`);
  ok(w.kind === 'ok' && lokal === 0 && S(geschickt) === S(req), 'CLIENT die Maske geht dort über den Fernbefehl — mit genau dem Rumpf der Maske, lokal passiert nichts');
}
marker('CENTRAL_UI_R6D_GOLD_CLIENT_NO_LOCAL_DB_PROVED');

// ══ §8 — Oberfläche: jede Maske EIN Anschluss ════════════════════════════════
{
  const modal = codeOf(src('src/components/repairs/SettleGoldModal.tsx'));
  ok(/w\.ok\('gold\.payables\.settle'/.test(modal) && /w\.ok\('gold\.customer_credits\.settle'/.test(modal)
    && /local: \(\) => settleGoldPayableOnPrimary\(req\)/.test(modal) && /local: \(\) => settleGoldCreditOnPrimary\(req\)/.test(modal)
    && /remote: \(\) => goldPayableSettleBody\(req\)/.test(modal) && /remote: \(\) => goldCreditSettleBody\(req\)/.test(modal),
    'UI Settle-Modal: am Primary der Goldkern, auf PC2 derselbe Rumpf als Fernbefehl');
  ok(!/goldStore\.|settleGoldReturn\(|convertGoldPayableToMoney\(|applyShopGold|returnCustomerCredit\(|convertCustomerCreditToMoney\(/.test(modal)
    && !/KARAT_PURITY\[[^\]]+\] \|\| 1\.0/.test(modal), 'UI …ruft keine Store-Schreibaktion mehr und rechnet kein Karat mit Ersatzreinheit');
  ok(/if \(!done\) return;\s*goldLoadAll\(\);\s*onClose\(\);/.test(modal) && /disabled=\{w\.busy\}/.test(modal), 'UI …schließt nur bei Erfolg, gesperrt solange es läuft');
  for (const a of ['data-gold-settle-modal', 'data-gold-settle-grams', 'data-gold-settle-source-karat', 'data-gold-settle-bhd', 'data-gold-settle-notes', 'data-gold-settle-confirm']) {
    ok(modal.includes(a), `UI Settle-Modal trägt ${a}`);
  }
  const rd = codeOf(src('src/pages/repairs/RepairDetail.tsx'));
  ok(/w\.ok\('repairs\.record_gold_usage'/.test(rd) && /local: \(\) => recordRepairGoldUsageOnPrimary\(req\)/.test(rd)
    && /w\.ok\('repairs\.add_material'/.test(rd) && /local: \(\) => addRepairMaterialOnPrimary\(req\)/.test(rd),
    'UI Reparatur: Gold-Verbrauch und Material über je EINE Buchung');
  ok(!/createGoldPayable\(|createCustomerGoldCredit\(|creditShopGold\(/.test(rd), 'UI …keine Gold-Schreibaktion mehr direkt aus der Seite');
  ok(/onSubmitAll=\{handleAddMaterial\}/.test(rd) && /supplierOptions\.filter\(o => o\.id !== '__INHOUSE__'\)/.test(rd) && /Object\.keys\(KARAT_PURITY\)/.test(rd),
    'UI …alle Positionen auf einmal; kein „In-house" als Goldschmied; nur bekannte Karate');
  for (const a of ['data-gold-usage-open', 'data-gold-usage-source', 'data-gold-usage-received', 'data-gold-usage-karat', 'data-gold-usage-supplier',
    'data-gold-usage-settlement', 'data-gold-usage-used', 'data-gold-usage-leftover', 'data-gold-usage-save', 'data-material-open', 'data-gold-settle-open']) {
    ok(rd.includes(a), `UI Reparatur trägt ${a}`);
  }
  const od = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  ok(/w\.ok\('orders\.add_cost'/.test(od) && /local: \(\) => addOrderCostOnPrimary\(req\)/.test(od)
    && /w\.ok\('orders\.remove_cost'/.test(od) && /local: \(\) => removeOrderCostOnPrimary\(req\)/.test(od),
    'UI Auftrag: „Add Cost" und Kostenzeile löschen über je EINE Buchung');
  ok(!/\baddOrderLine\(|\bdeleteOrderLine\(|createGoldPayable\(/.test(od), 'UI …keine Zeilen-/Gold-Schreibaktion mehr direkt aus der Seite');
  ok((od.match(/primaryOnlyDeleteProps\(\)/g) ?? []).length === 2 && (od.match(/blockDeleteOnClient\(\)/g) ?? []).length === 2,
    'UI …das Löschen einer Gold-Schuld selbst bleibt Primary-only (R6B unverändert)');
  for (const a of ['data-order-add-cost-open', 'data-order-cost-remove', 'data-gold-settle-open']) ok(od.includes(a), `UI Auftrag trägt ${a}`);
  const mm = codeOf(src('src/components/work-orders/AddMaterialModal.tsx'));
  ok(/if \(await onSubmitAll\(all\)\) onClose\(\);/.test(mm) && /disabled=\{busy\}/.test(mm), 'UI Material-Modal: eine Buchung, schließt nur bei Erfolg');
  for (const a of ['data-material-kind', 'data-material-description', 'data-material-quantity', 'data-material-carat', 'data-material-grams',
    'data-material-karat', 'data-material-cost', 'data-material-source', 'data-material-add-to-list', 'data-material-save']) {
    ok(mm.includes(a), `UI Material-Modal trägt ${a}`);
  }
  const gc = codeOf(src('src/core/bridge/gold-commands.ts'));
  ok(/settleGoldPayable\(a, req\)/.test(gc) && /settleCustomerGoldCredit\(a, req\)/.test(gc) && /recordRepairGoldUsageInHouse\(a, req\)/.test(gc)
    && /addRepairMaterialInHouse\(a, req\)/.test(gc) && /addOrderCostInHouse\(a, req\)/.test(gc) && /removeOrderCostInHouse\(a, req\)/.test(gc)
    && /assertHouseBranch\(identity\)/.test(gc), 'UI der Fernbefehl ruft DIESELBE Hausfolge wie die Maske des Primary');
  ok(!/INSERT INTO|UPDATE gold_|postExpense\(|postGoldConversionCredit\(/.test(gc), 'UI …und schreibt oder bucht nichts selbst');
  const gs = codeOf(src('src/stores/goldStore.ts'));
  ok(!/PURITY_LOOKUP|\?\? 1\.0|safePost\(/.test(gs) && /settleGoldPayable\(storeActor\(\)/.test(gs) && /settleCustomerGoldCredit\(storeActor\(\)/.test(gs),
    'UI der Store hat keine zweite Gramm-/Karat-/Buchungslogik mehr — er ruft den Goldkern');
  const house2 = codeOf(src('src/core/gold/gold-house.ts')) + codeOf(src('src/core/gold/gold-settle.ts'));
  ok(!/BEGIN|COMMIT|ROLLBACK|saveDatabaseDurably|beginLedgerTransaction\(/.test(house2), 'UI die Hausfolge öffnet und schließt keine Transaktion selbst');
}
marker('CENTRAL_UI_R6D_GOLD_UI_WIRING_PROVED');

// ══ §9 — PRE-G5: der Fachverlauf eines Goldeinsatzes ══════════════════════════
//
// Der Befund aus dem Feldversuch: Kundengold, alles verarbeitet, kein Rest — danach war der
// Vorgang nirgends mehr zu sehen, weil es NICHTS ZU BUCHEN gab. Der Verlauf haelt ihn fest.
// Er ist Nachweis, keine Buchung: keine Schuld, kein Guthaben, kein Ledger, kein Bestand.
{
  const verlauf = (db: Db, repairId = 'rep-1') =>
    rows(db, 'SELECT * FROM repair_gold_usage_history WHERE repair_id = ? ORDER BY recorded_at', [repairId]);

  // (1) Kundengold, alles verarbeitet: Verlauf JA, Schuld/Guthaben NEIN.
  let db = freshDb();
  let vor = snap(db);
  let a = await primary(() => house.recordRepairGoldUsageOnPrimary(
    { repairId: 'rep-1', source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 5, leftover: 'return' }));
  ok(a.kind === 'ok', `HIST Kundengold ohne Rest geht durch (${a.code})`);
  let h = verlauf(db);
  ok(h.length === 1 && String(h[0].source) === 'customer' && Number(h[0].received_grams) === 5
    && Number(h[0].used_grams) === 5 && Number(h[0].remainder_grams) === 0 && String(h[0].leftover) === 'return'
    && String(h[0].karat) === '21K' && String(h[0].branch_id) === 'branch-main' && !!h[0].recorded_at,
  `HIST …und steht mit allen Werten im Verlauf (${JSON.stringify(h[0])})`);
  ok(snap(db) === vor, 'HIST …waehrend Schuld, Guthaben und Bestand unveraendert bleiben — der Verlauf bucht nichts');
  ok(!h[0].supplier_id && !h[0].gold_payable_id && !h[0].gold_credit_id && Number(h[0].shop_kept_grams) === 0,
    'HIST …ohne Lieferant und ohne erfundene Buchungskennung');

  // (2) Kundengold mit Rest, der Kunde nimmt ihn mit: ebenfalls nur Verlauf.
  db = freshDb(); vor = snap(db);
  a = await primary(() => house.recordRepairGoldUsageOnPrimary(
    { repairId: 'rep-1', source: 'customer', karat: '21K', receivedGrams: 8, usedGrams: 6, leftover: 'return' }));
  h = verlauf(db);
  ok(a.kind === 'ok' && h.length === 1 && Number(h[0].remainder_grams) === 2 && String(h[0].leftover) === 'return',
    `HIST der zurueckgegebene Rest steht im Verlauf (${JSON.stringify(h[0] && h[0].remainder_grams)})`);
  ok(snap(db) === vor, 'HIST …und erzeugt weiterhin KEINE Forderung');

  // (3) Kundengold mit Rest als Guthaben: bestehende Wirkung UND genau ein Verlaufseintrag.
  db = freshDb();
  a = await primary(() => house.recordRepairGoldUsageOnPrimary(
    { repairId: 'rep-1', source: 'customer', karat: '21K', receivedGrams: 8, usedGrams: 6, leftover: 'credit' }));
  h = verlauf(db);
  const gutschrift = rows(db, "SELECT id, weight_grams FROM customer_gold_credits WHERE source_repair_id = 'rep-1'");
  ok(a.kind === 'ok' && gutschrift.length === 1 && Number(gutschrift[0].weight_grams) === 2,
    'HIST der Rest als Guthaben bucht weiterhin genau ein Kundenguthaben');
  ok(h.length === 1 && String(h[0].gold_credit_id) === String(gutschrift[0].id) && String(h[0].leftover) === 'credit',
    'HIST …und der Verlauf verweist auf genau dieses Guthaben');

  // …und der Rest, den der Laden behaelt.
  db = freshDb();
  a = await primary(() => house.recordRepairGoldUsageOnPrimary(
    { repairId: 'rep-1', source: 'customer', karat: '21K', receivedGrams: 8, usedGrams: 6, leftover: 'shop_keep' }));
  h = verlauf(db);
  ok(a.kind === 'ok' && h.length === 1 && Number(h[0].shop_kept_grams) === 2 && String(h[0].leftover) === 'shop_keep',
    `HIST der im Haus behaltene Rest steht als solcher im Verlauf (${JSON.stringify(h[0] && h[0].shop_kept_grams)})`);

  // (4) Werkstattgold: Schuld wie bisher, dazu der Verlauf mit ihrer Kennung.
  db = freshDb();
  a = await primary(() => house.recordRepairGoldUsageOnPrimary(
    { repairId: 'rep-1', source: 'workshop', karat: '21K', receivedGrams: 3, supplierId: 'sup-1', settlementType: 'pay_money' }));
  h = verlauf(db);
  // Die Vorlage bringt bereits Schulden mit — gemeint ist die, die GERADE entstanden ist.
  const neueId = String((a.value as { payableId?: string }).payableId || '');
  const schuld = rows(db, 'SELECT id, weight_grams, settlement_type FROM gold_payables WHERE id = ?', [neueId]);
  ok(a.kind === 'ok' && schuld.length === 1 && Number(schuld[0].weight_grams) === 3
    && String(schuld[0].settlement_type) === 'pay_money',
  `HIST Werkstattgold bucht weiterhin genau eine Gramm-Schuld (${JSON.stringify(schuld[0])})`);
  ok(h.length === 1 && String(h[0].source) === 'workshop' && String(h[0].supplier_id) === 'sup-1'
    && String(h[0].gold_payable_id) === String(schuld[0].id) && String(h[0].settlement_type) === 'pay_money'
    && h[0].used_grams === null && h[0].remainder_grams === null,
  `HIST …und der Verlauf nennt Lieferant, Ausgleichsart und die Schuld — ohne erfundenen Verbrauch (${JSON.stringify(h[0])})`);

  // (5) Eine Ablehnung schreibt nichts.
  db = freshDb();
  a = await primary(() => house.recordRepairGoldUsageOnPrimary(
    { repairId: 'rep-1', source: 'customer', karat: '21K', receivedGrams: 3, usedGrams: 4, leftover: 'return' }));
  ok(a.kind === 'rejected' && a.code === 'GOLD_USED_EXCEEDS_RECEIVED' && verlauf(db).length === 0,
    `HIST eine abgewiesene Buchung hinterlaesst KEINEN Verlauf (${a.code})`);
  a = await primary(() => house.recordRepairGoldUsageOnPrimary(
    { repairId: 'rep-1', source: 'workshop', karat: '21K', receivedGrams: 3 }));
  ok(a.kind === 'rejected' && verlauf(db).length === 0, `HIST …auch die ohne Lieferant nicht (${a.code})`);

  // (6) Dieselbe Kennung zweimal: EIN Vorgang, EIN Verlaufseintrag.
  db = freshDb();
  const rumpf = { repairId: 'rep-1', expectedRevision: 1, source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 5, leftover: 'return' };
  const eins = await fern(() => cmd.runRepairGoldUsage(deps(db), identity('gold-hist-1', 'repairs.record_gold_usage'), rumpf));
  const zwei = await fern(() => cmd.runRepairGoldUsage(deps(db), identity('gold-hist-1', 'repairs.record_gold_usage'), rumpf));
  ok(eins.kind === 'ok' && zwei.kind === 'ok' && zwei.replayed === true,
    'HIST die Wiederholung derselben Kennung antwortet aus dem Buch');
  ok(verlauf(db).length === 1, `HIST …und schreibt keinen zweiten Verlaufseintrag (${verlauf(db).length})`);
  const anders = await fern(() => cmd.runRepairGoldUsage(
    deps(db), identity('gold-hist-1', 'repairs.record_gold_usage', 'branch-main', 'anderer-hash'), { ...rumpf, receivedGrams: 9 }));
  ok(anders.kind === 'rejected' && verlauf(db).length === 1,
    `HIST …und derselbe Auftrag mit anderem Inhalt bleibt der bestehende Konflikt (${anders.code})`);

  // (9) Migration: eine Datenbank OHNE die Tabelle bekommt sie additiv, alte Daten bleiben.
  {
    const alt = new SQL.Database() as unknown as Db;
    alt.run(src('src/core/db/schema.sql'));
    for (const stmt of MIGRATIONS) {
      if (/repair_gold_usage_history/.test(stmt)) continue;   // der Stand VOR diesem Schnitt
      try { alt.run(stmt); } catch { /* schon da */ }
    }
    alt.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
    insert(alt, 'customers', { id: 'c1', branch_id: 'branch-main', first_name: 'Alt', last_name: 'Bestand', created_at: NOW, updated_at: NOW });
    insert(alt, 'repairs', { id: 'rep-alt', branch_id: 'branch-main', repair_number: 'REP-2020-00001', customer_id: 'c1', status: 'received', created_at: NOW, updated_at: NOW });
    ok(rows(alt, "SELECT name FROM sqlite_master WHERE type='table' AND name='repair_gold_usage_history'").length === 0,
      'HIST-MIG vor dem Schnitt gibt es die Tabelle nicht');
    for (const stmt of MIGRATIONS) { try { alt.run(stmt); } catch { /* schon da */ } }
    ok(rows(alt, "SELECT name FROM sqlite_master WHERE type='table' AND name='repair_gold_usage_history'").length === 1,
      'HIST-MIG die Migration legt sie an — additiv, ohne Datenverlust');
    ok(rows(alt, "SELECT id FROM repairs WHERE id = 'rep-alt'").length === 1
      && rows(alt, 'SELECT * FROM repair_gold_usage_history').length === 0,
    'HIST-MIG …die vorhandene Reparatur bleibt unveraendert und hat einfach keinen Verlauf');
  }

  // (7/8) Die eine Schreibweise — Rechner und Telefon lesen denselben Satz.
  const ansicht = await import('../../src/core/gold/gold-usage-view.ts');
  const telefon: { MobileRepair?: { goldUsageLine(h: Record<string, unknown>): string } } = {};
  new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js'))(telefon);
  const faelle = [
    { source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 5, remainderGrams: 0, leftover: 'return' },
    { source: 'customer', karat: '18K', receivedGrams: 8, usedGrams: 6, remainderGrams: 2, leftover: 'credit' },
    { source: 'customer', karat: '18K', receivedGrams: 8, usedGrams: 6, remainderGrams: 2, leftover: 'shop_keep' },
    { source: 'workshop', karat: '21K', receivedGrams: 3, settlementType: 'pay_money' },
  ];
  ok(ansicht.goldUsageLine(faelle[0]) === 'Received 5.000 g · Used 5.000 g · Remainder 0.000 g',
    `HIST-VIEW der Fall ohne Rest liest sich vollstaendig (${ansicht.goldUsageLine(faelle[0])})`);
  ok(ansicht.goldUsageLine(faelle[1]) === 'Received 8.000 g · Used 6.000 g · Remainder 2.000 g · kept as customer credit',
    `HIST-VIEW …mit Rest steht auch sein Verbleib da (${ansicht.goldUsageLine(faelle[1])})`);
  ok(ansicht.goldUsageLine(faelle[3]) === 'Received 3.000 g · gold debt · settled in money',
    `HIST-VIEW …und Werkstattgold nennt die Schuld, nicht einen erfundenen Verbrauch (${ansicht.goldUsageLine(faelle[3])})`);
  ok(faelle.every((f) => ansicht.goldUsageLine(f) === telefon.MobileRepair!.goldUsageLine(f)),
    'HIST-VIEW Telefon und Rechner schreiben denselben Satz, Zeichen fuer Zeichen');

  // (7) Der Rechner zeigt ihn — getrennt von Schuld und Guthaben.
  const seite = src('src/pages/repairs/RepairDetail.tsx');
  ok(/GOLD USAGE HISTORY \(\{repairGoldUsage\.length\}\)/.test(seite)
    && /goldUsageLine\(h\)/.test(seite) && /useGoldStore\(s => s\.repairGoldUsage\)/.test(seite),
  'HIST-UI die Reparaturseite hat eine eigene Sektion aus demselben Satz');
  // Die zweite Karte heisst, was sie zeigt: nur was zu BEGLEICHEN ist. Vorher stand dort „GOLD USED"
  // und bei vollstaendig verbrauchtem Kundengold „No gold positions recorded" — direkt neben einem
  // Goldeinsatz, der sehr wohl erfasst war (Feldbefund 19.09.2026).
  ok(/GOLD DEBTS & CREDITS \(\{repairGoldPayables\.length \+ repairCustomerGoldCredits\.length\}\)/.test(seite)
    && !/GOLD USED \(/.test(seite),
  'HIST-UI die Karte fuer Schuld und Guthaben heisst „GOLD DEBTS & CREDITS"');
  ok(/repairGoldPayables\.length === 0 && repairCustomerGoldCredits\.length === 0 \? \(\s*<p[^>]*>Nothing to settle — this repair created no gold debt and no customer gold credit\.<\/p>/.test(seite)
    && !/No gold positions recorded for this repair/.test(seite),
  'HIST-UI …leer sagt sie „Nothing to settle", statt einen erfassten Goldeinsatz zu verleugnen');
  ok(seite.indexOf('GOLD USAGE HISTORY (') > 0 && seite.indexOf('GOLD USAGE HISTORY (') < seite.indexOf('GOLD DEBTS & CREDITS ('),
    'HIST-UI erst der Verlauf (was passiert ist), dann was daraus offen ist');
  ok(/repairGoldPayables\.map\(/.test(seite) && /data-gold-settle-open="settle_supplier_return"/.test(seite)
    && /data-gold-settle-open="convert_supplier_money"/.test(seite) && /repairCustomerGoldCredits\.map\(/.test(seite),
  'HIST-UI die Schuld- und Guthabenzeilen samt ihren Knoepfen sind unveraendert da');
  // Vollstaendig verbrauchtes Kundengold (oben, Fall 1): Verlauf ja, Schuld/Guthaben nein — genau
  // die Lage, in der die erste Karte etwas zeigt und die zweite „Nothing to settle".
  {
    const leer = freshDb();
    await primary(() => house.recordRepairGoldUsageOnPrimary(
      { repairId: 'rep-1', source: 'customer', karat: '21K', receivedGrams: 5, usedGrams: 5, leftover: 'return' }));
    ok(verlauf(leer).length === 1
      && rows(leer, "SELECT id FROM gold_payables WHERE source_repair_id = 'rep-1' AND created_at > ?", [NOW]).length === 0
      && rows(leer, "SELECT id FROM customer_gold_credits WHERE source_repair_id = 'rep-1'").length === 0,
    'HIST-UI verbrauchtes Kundengold: ein Verlaufseintrag, nichts zu begleichen');
  }
  // (8) Das Telefon zeigt ihn — nur lesend.
  const handy = src('src-tauri/src/sync/mobile_repair_ui.js');
  ok(/rpRenderGoldHistory\(rep\)/.test(handy) && /MobileRepair\.goldUsageLine\(h\)/.test(handy),
    'HIST-UI das Telefon zeichnet denselben Satz');
  ok(!/record_gold_usage/.test(handy.split('rpRenderGoldHistory')[1].split('function ')[1] || ''),
    'HIST-UI …und die Anzeige schreibt nichts — „Record gold" bleibt die eine Aktion');
  // Der Verlauf reist in der BESTEHENDEN Auskunft mit — keine neue Operation.
  const reads = src('src/core/bridge/read-commands.ts');
  ok(/FROM repair_gold_usage_history h/.test(reads) && /voucherCode: str\(found\[0\]\.voucher_code\), lines, openLineTotal, goldUsage,/.test(reads),
    'HIST-READ `repairs.get` traegt den Verlauf — ohne neue Leseoperation');
}
marker('PRE_G5_REPAIR_GOLD_USAGE_HISTORY_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6d gold parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6D_GOLD_PROVED');
