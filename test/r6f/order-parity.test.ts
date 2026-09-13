// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — der Lebenszyklus eines Auftrags: „Cancel Order" (`orders.cancel`), die
// Statusknöpfe einer Position (`orders.update_line_status`), „⚠ Beim Supplier bestellen"
// (`orders.mark_line_ordered`) und der Positionsdialog (`orders.update_line`) — EINE Hausfolge für
// Primary und PC2 (`core/orders/order-lifecycle-house`).
// Run: node test/r6f/order-parity.test.ts
//
// Gefahren werden die ECHTEN Hausfolgen, die echten Primary-Anschlüsse (`…OnPrimary` → `runOnPrimary`),
// die echten Store-Schreibwege, die echte C3A-Maschine mit durablem Nachweis und das echte Schema samt
// Hauptbuch. Gestellt sind nur das Speichern, die Zwischenablage der Fotos und — im Client-Abschnitt — das Netz.
//
//   §1 Umfang   §2 Storno: Primary == PC2 (drei Wege)   §3 Storno: Befunde, Atomarität   §4 Storno:
//   Wiederholung, Fassung, Sperren, Autorität   §5 Positionsstatus   §6 „bestellt"   §7 Positionsdialog
//   §8 Client   §9 Oberfläche
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
  // Abgleich eingeschaltet: `trackChange` schreibt ins Änderungsprotokoll — messbar, auch im Rollback.
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
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const cmd = await import('../../src/core/bridge/order-lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useGoldStore } = await import('../../src/stores/goldStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const house = await import('../../src/core/orders/order-lifecycle-house.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
let seit = 0;
const marker = (m: string): void => { if (fails.length === seit) console.log(m); seit = fails.length; };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';

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
  useOrderStore.getState().loadOrders();
  try { useGoldStore.getState().loadGoldPayables(); } catch { /* */ }
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
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first, branch] of [['c1', 'Ali', 'branch-main'], ['cx', 'Fremd', 'branch-other']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch, active] of [['sup-1', 'branch-main', 1], ['sup-2', 'branch-main', 1], ['sup-off', 'branch-main', 0], ['sup-x', 'branch-other', 1]] as Array<[string, string, number]>) {
    insert(db, 'suppliers', { id, branch_id: branch, name: 'Lieferant ' + id, active, created_at: NOW, updated_at: NOW });
  }
  for (const [id, branch, tax] of [['p1', 'branch-main', 'MARGIN'], ['p2', 'branch-main', 'VAT_10'], ['p-x', 'branch-other', 'MARGIN']]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,'cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,'in_stock',?,0,'[]','{}','OWN',?,?)`,
    [id, branch, 'M ' + id, 'SKU-' + id, tax, NOW, NOW]);
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,?,?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, branch, id, NOW, NOW]);
  }
  // Ein Auftrag einer anderen Filiale — samt Position.
  insert(db, 'orders', { id: 'ord-x', branch_id: 'branch-other', order_number: 'ORD-X', customer_id: 'cx', status: 'pending', created_at: NOW, updated_at: NOW });
  insert(db, 'order_lines', { id: 'olx', order_id: 'ord-x', description: 'Fremd', quantity: 1, unit_price: 100, line_total: 100, position: 1,
    is_customer_facing: 1, status: 'PENDING', created_at: NOW });
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nx = (): string => ID(++seq);
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (commandId: string, op: string, over: Partial<typeof ACTOR> = {}) =>
  ({ commandId, ...ACTOR, ...over, op, payloadHash: 'h' + commandId });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => { /* gestellt */ },
  now: () => NOW,
});

interface Ausgang { ok: boolean; code: string; frozen: boolean; thrown: boolean; value: Record<string, unknown>; replayed: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean; frozen?: boolean };
    if (o.kind === 'ok') return { ok: true, code: '', frozen: false, thrown: false, value: o.value ?? {}, replayed: o.replayed === true };
    return { ok: false, code: o.code ?? '(ohne Code)', frozen: o.frozen === true, thrown: false, value: {}, replayed: false };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, thrown: true, value: {}, replayed: false };
  }
}
async function primary(p: () => unknown): Promise<Ausgang> {
  try { return { ok: true, code: '', frozen: false, thrown: false, value: (await p() ?? {}) as Record<string, unknown>, replayed: false }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, thrown: true, value: {}, replayed: false }; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function faulty(db: Db, pattern: RegExp) {
  const f = { armed: true };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pattern.test(sql)) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}

const OHNE = /^(id|version|sync_status)$|_at$|_date$/;
function ohne(r: Record<string, unknown>, auch: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const changelog = (db: Db): number => n(db, 'SELECT COUNT(*) FROM sync_changelog');
const orev = (db: Db, id: string): number => n(db, 'SELECT revision FROM orders WHERE id = ?', [id]);
const salden = (db: Db): string => S(rows(db,
  `SELECT account, COALESCE(counterparty_id, '') AS cp, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
     FROM ledger_entries GROUP BY account, cp HAVING ABS(net) > 0.0005 ORDER BY account, cp`));
const saldo = (db: Db, account: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = ?`, [account]);
/** Jede Buchung gleicht sich aus: Soll == Haben, je Transaktion, in Fils. */
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END)
    FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.length > 0 && t.every((r) => Number(r[1]) === Number(r[2]));
}

// ════════════════════════════════════════════════════════════════════════════
// Die Welt eines Auftrags: zwei Artikelzeilen (p2 mit Lieferantenkosten 200), die Angebotszeile eines
// Sonderstücks (800), eine angekommene Goldschmied-Arbeit (A/P 150), Extra-Gold (100) mit offener
// Gramm-Schuld — vereinbart 2300, Anzahlung 300 bar.
// ════════════════════════════════════════════════════════════════════════════
interface Welt { db: Db; oid: string; p1: string; p2: string; quote: string; labor: string; gold: string }
function auftrag(o: { anzahlung?: number; kosten?: boolean } = {}): Welt {
  const db = freshDb();
  const kosten = o.kosten !== false;
  const oid = imHaus(() => {
    const os = useOrderStore.getState();
    const lines: Array<Record<string, unknown>> = [
      { productId: 'p1', description: 'Rolex M p1', quantity: 1, unitPrice: 1000, taxScheme: 'MARGIN', vatRate: 10 },
      { productId: 'p2', description: 'Rolex M p2', quantity: 1, unitPrice: 500, taxScheme: 'VAT_10', vatRate: 10, supplierId: 'sup-1', costAmount: 200 },
      { description: 'Atelier Ring R6F', quantity: 1, unitPrice: 800, taxScheme: 'MARGIN', vatRate: 10, materialKind: 'custom', costAmount: 0 },
    ];
    if (kosten) {
      lines.push({ description: 'Goldsmith Labor', quantity: 1, unitPrice: 0, isCustomerFacing: false, materialKind: 'labor', supplierId: 'sup-1', costAmount: 150, status: 'ARRIVED' });
      lines.push({ description: 'Extra Gold 5.000g 22K', quantity: 1, unitPrice: 0, isCustomerFacing: false, materialKind: 'gold', costAmount: 100 });
    }
    const order = os.createOrder({
      customerId: 'c1', depositAmount: o.anzahlung ?? 300, paymentMethod: 'cash', status: 'pending', supplierPrice: 1500,
      requestedBrand: 'Atelier', requestedModel: 'Ring R6F', categoryId: 'cat-w',
      customProductSpec: { categoryId: 'cat-w', brand: 'Atelier', name: 'Ring R6F', images: [] },
      lines,
    } as never);
    os.commitOrderLineExpenses(order.id);
    return order.id;
  });
  const L = (pos: number): string => s(db, 'SELECT id FROM order_lines WHERE order_id = ? AND position = ?', [oid, pos]);
  const w: Welt = { db, oid, p1: L(1), p2: L(2), quote: L(3), labor: kosten ? L(4) : '', gold: kosten ? L(5) : '' };
  if (kosten) {
    insert(db, 'gold_payables', { id: 'gp-1', branch_id: 'branch-main', supplier_id: 'sup-1', source_order_id: oid, source_order_line_id: w.gold,
      direction: 'we_owe', weight_grams: 5, karat: '22K', settlement_type: 'return_gold', fulfilled_grams: 0, status: 'OPEN', created_at: NOW, updated_at: NOW });
  }
  reload();
  return w;
}

const SEEDED = new Set(['p1', 'p2', 'p-x', 'c1', 'cx', 'sup-1', 'sup-2', 'sup-off', 'sup-x', 'cat-w', 'gp-1', 'branch-main', 'branch-other']);
const idn = (v: unknown): unknown => (v === null || v === undefined || v === '' ? v : SEEDED.has(String(v)) ? v : 'NEU');
function bild(w: Welt): string {
  const o = ohne(row(w.db, 'SELECT * FROM orders WHERE id = ?', [w.oid]));
  return S({
    order: { ...o, product_id: idn(o.product_id), existing_product_id: idn(o.existing_product_id) },
    lines: rows(w.db, `SELECT position, product_id, description, quantity, unit_price, line_total, supplier_id, cost_amount, is_customer_facing,
        material_kind, status, ordered_supplier_id, invoice_id, expense_id IS NOT NULL AS has_exp FROM order_lines WHERE order_id = ? ORDER BY position`, [w.oid])
      .map((r) => ({ ...r, product_id: idn(r.product_id) })),
    credits: rows(w.db, 'SELECT branch_id, customer_id, amount, used_amount, status, source_type, note FROM customer_credits ORDER BY source_type, amount'),
    gold: rows(w.db, 'SELECT id, status, weight_grams, fulfilled_grams FROM gold_payables ORDER BY id'),
    products: rows(w.db, `SELECT branch_id, category_id, brand, name, sku, quantity, purchase_price, planned_sale_price, stock_status, tax_scheme,
        source_type, notes, images FROM products ORDER BY brand, name, sku`),
    lots: rows(w.db, 'SELECT product_id, qty_remaining, status FROM stock_lots ORDER BY product_id'),
    expenses: rows(w.db, 'SELECT branch_id, category, amount, paid_amount, status, supplier_id, related_module, description FROM expenses ORDER BY description'),
    payments: rows(w.db, 'SELECT amount, method, converted_to_invoice FROM order_payments ORDER BY amount'),
    ledger: rows(w.db, 'SELECT source_module, account, direction, ROUND(SUM(amount), 3) AS a, COUNT(*) AS c FROM ledger_entries GROUP BY 1, 2, 3 ORDER BY 1, 2, 3'),
    salden: salden(w.db),
  });
}
/** Die Hausfolge liest `getDatabase()` — also vor jedem Weg die Welt, um die es geht. */
function auf(w: Welt): Welt {
  setTestDatabase(w.db as never);
  reload();
  return w;
}
function diff(a: string, b: string): string {
  const A = JSON.parse(a) as Record<string, unknown>; const B = JSON.parse(b) as Record<string, unknown>;
  return Object.keys({ ...A, ...B }).filter((k) => S(A[k]) !== S(B[k])).map((k) => `${k}: ${S(A[k]).slice(0, 300)} vs ${S(B[k]).slice(0, 300)}`).join(' · ');
}

const OPS = ['orders.cancel', 'orders.update_line_status', 'orders.mark_line_ordered', 'orders.update_line'];

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  for (const op of OPS) {
    ok(registry.ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist namentlich freigegeben`);
    ok(registry.knownCommands().includes(op), `SCOPE ${op} ist registriert`);
  }
  ok(S([...cmd.ORDER_LIFECYCLE_OPS]) === S(OPS), 'SCOPE die Befehlsdatei kennt genau diese vier');
  ok(OPS.every((op) => op in perms.OPERATION_PERMISSIONS) && perms.OPERATION_PERMISSIONS['orders.update_line_status'] === null,
    'SCOPE der Positionsstatus hat kein Tor (die Knöpfe am Primary auch nicht)');
  for (const op of ['orders.cancel', 'orders.mark_line_ordered', 'orders.update_line']) {
    ok(perms.roleMayRunOp('ADMIN', op) && !perms.roleMayRunOp('SALES', op), `SCOPE ${op}: dasselbe Recht wie perm.canManageOrders`);
  }
  ok(perms.roleMayRunOp('SALES', 'orders.update_line_status'), 'SCOPE …der Statusknopf auch für den Verkauf');
  const reg = codeOf(src('src/core/bridge/order-lifecycle-commands.ts'));
  ok((reg.match(/registerCommand\(/g) || []).length === 4 && !/for \(|forEach/.test(reg.slice(reg.indexOf('registerCommand('))),
    'SCOPE vier ausdrückliche Anmeldungen, keine Schleife');
  ok(!registry.ALLOWED_MUTATIONS.includes('orders.delete'), 'SCOPE „Delete Order" bleibt am Primary');
}
marker('CENTRAL_UI_R6F_ORDER_SCOPE_PROVED');

// ══ §2 — Storno: Primary == PC2, alle drei Wege ══════════════════════════════
const NOTIZ = 'Fuer die naechste Uhr';
async function stornoPaar(choice: 'refund' | 'credit' | 'forfeit', extra: Record<string, unknown>, welt: Parameters<typeof auftrag>[0] = {}) {
  const wP = auftrag(welt);
  const wR = auftrag(welt);
  const lcP = lc(wP.db);
  const revP = orev(wP.db, wP.oid);
  auf(wP);
  const p = await primary(() => house.cancelOrderOnPrimary({ orderId: wP.oid, expectedRevision: revP, choice, ...extra } as never));
  auf(wR);
  const r = await fern(() => cmd.runOrderCancel(deps(wR.db), identity(nx(), 'orders.cancel'),
    house.orderCancelBody({ orderId: wR.oid, expectedRevision: orev(wR.db, wR.oid), choice, ...extra } as never)));
  return { wP, wR, p, r, lcP, revP };
}
{
  // Rückzahlung über die Bank
  const { wP, wR, p, r, lcP, revP } = await stornoPaar('refund', { refundMethod: 'bank' });
  const bP = bild(wP); const bR = bild(wR);
  ok(p.ok && r.ok, `CANCEL refund: beide Wege stornieren (${p.code || 'ok'} / ${r.code || 'ok'})`);
  ok(bP === bR, `CANCEL refund: lokal == fern — Auftrag, Positionen, Guthaben, Gold, Artikel, Lose, Ausgaben, Buchungen, Salden (${diff(bP, bR) || 'gleich'})`);
  const w = wR;
  ok(s(w.db, 'SELECT status FROM orders WHERE id = ?', [w.oid]) === 'cancelled'
    && n(w.db, "SELECT COUNT(*) FROM order_lines WHERE order_id = ? AND status != 'CANCELLED'", [w.oid]) === 0,
  'CANCEL Auftrag und alle Positionen CANCELLED');
  ok(S(rows(w.db, "SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'ORDER_CANCEL' ORDER BY direction"))
    === S([{ account: 'BANK', direction: 'CREDIT', amount: 300 }, { account: 'CUSTOMER_DEPOSITS', direction: 'DEBIT', amount: 300 }]),
  'LEDGER Rückzahlung: DR Kundenanzahlung / CR Bank über die Anzahlung');
  ok(Math.abs(saldo(w.db, 'CUSTOMER_DEPOSITS')) < 0.0005, `LEDGER die Anzahlungsverbindlichkeit ist ausgeglichen (${saldo(w.db, 'CUSTOMER_DEPOSITS')})`);
  ok(s(w.db, "SELECT status FROM gold_payables WHERE id = 'gp-1'") === 'CANCELLED', 'GOLD die offene Gramm-Schuld ist storniert');
  ok(s(w.db, "SELECT status FROM expenses WHERE description LIKE '%labor%'") === 'PENDING'
    && s(w.db, 'SELECT expense_id FROM order_lines WHERE id = ?', [w.labor]) === '',
  'A/P die Schuld an den Goldschmied bleibt OFFEN (er hat gearbeitet); die Zeile hängt nicht mehr daran');
  const stueck = row(w.db, "SELECT brand, name, quantity, purchase_price, planned_sale_price, stock_status, source_type, created_by FROM products WHERE brand = 'Atelier'");
  ok(stueck.name === 'Ring R6F' && Number(stueck.quantity) === 1 && Number(stueck.purchase_price) === 250
    && Number(stueck.planned_sale_price) === 2300 && stueck.stock_status === 'in_stock' && stueck.source_type === 'OWN',
  `STOCK das angefangene Sonderstück ist ein Lagerartikel zur Kostenbasis (Arbeit + Gold = 250), wie die Maske verspricht (${S(stueck)})`);
  ok(row(wP.db, "SELECT created_by FROM products WHERE brand = 'Atelier'").created_by === 'user-test' && stueck.created_by === 'user-pc2',
    'AUTHOR das Lagerstück gehört dem, der storniert hat — lokal der Sitzung, fern dem Absender');
  const auditP = s(wP.db, "SELECT changed_by FROM audit_log WHERE entity_type = 'orders' AND field_name = 'cancelChoice'");
  const auditR = s(wR.db, "SELECT changed_by FROM audit_log WHERE entity_type = 'orders' AND field_name = 'cancelChoice'");
  ok(auditP === 'user-test' && auditR === 'user-pc2', `AUDIT das Protokoll nennt den Stornierenden (${auditP} / ${auditR})`);
  ok(Number(r.value.settledAmount) === 300 && typeof r.value.stockProductId === 'string' && r.value.stockProductId !== ''
    && Number(r.value.cancelledGoldPayables) === 1 && Number(r.value.openExpenses) === 1 && Number(r.value.revision) > revP,
  `RESULT die Antwort nennt Betrag, Lagerstück, Gold, offene A/P und die neue Fassung (${S(r.value)})`);
  ok(Number(p.value.settledAmount) === 300 && p.value.status === 'cancelled', 'RESULT …am Primary dieselbe');
  ok(balanced(wP.db) && balanced(wR.db) && lc(wP.db) > lcP, 'LEDGER jede Buchung gleicht sich aus (Primary und PC2)');
}
{
  // Guthaben — die Notiz der Maske erreicht es
  const { wP, wR, p, r } = await stornoPaar('credit', { note: NOTIZ });
  const bP = bild(wP); const bR = bild(wR);
  ok(p.ok && r.ok && bP === bR, `CANCEL credit: lokal == fern (${diff(bP, bR) || 'gleich'})`);
  const cc = row(wR.db, "SELECT branch_id, customer_id, amount, used_amount, status, source_type, source_id, note FROM customer_credits WHERE source_type = 'order_cancel'");
  ok(cc.branch_id === 'branch-main' && cc.customer_id === 'c1' && Number(cc.amount) === 300 && cc.status === 'OPEN' && cc.source_id === wR.oid,
    `CREDIT ein offenes Guthaben über die Anzahlung (${S(cc)})`);
  ok(cc.note === NOTIZ, `BEFUND behoben: die Notiz der Maske steht am Guthaben — vorher kam immer der Standardtext (${S(cc.note)})`);
  ok(Math.abs(saldo(wR.db, 'CUSTOMER_CREDIT') + 300) < 0.0005 && Math.abs(saldo(wR.db, 'CUSTOMER_DEPOSITS')) < 0.0005,
    'LEDGER Anzahlung → Store-Guthaben (CUSTOMER_CREDIT 300 Haben), kein Geld bewegt');
  ok(typeof r.value.customerCreditId === 'string' && r.value.customerCreditId !== '', 'RESULT die Antwort nennt das Guthaben');
}
{
  // Verfall
  const { wP, wR, p, r } = await stornoPaar('forfeit', {});
  const bP = bild(wP); const bR = bild(wR);
  ok(p.ok && r.ok && bP === bR, `CANCEL forfeit: lokal == fern (${diff(bP, bR) || 'gleich'})`);
  ok(Math.abs(saldo(wR.db, 'CANCELLATION_FEE_INCOME') + 300) < 0.0005 && Math.abs(saldo(wR.db, 'CUSTOMER_DEPOSITS')) < 0.0005
    && n(wR.db, 'SELECT COUNT(*) FROM customer_credits') === 0,
  'LEDGER Verfall: Stornogebühr als Ertrag, Anzahlung ausgeglichen, kein Guthaben');
}
{
  // Ohne Geld und ohne angefangene Arbeit: nur Status und Marker
  const { wP, wR, p, r } = await stornoPaar('refund', { refundMethod: 'cash' }, { anzahlung: 0, kosten: false });
  ok(p.ok && r.ok && bild(wP) === bild(wR), 'CANCEL ohne Anzahlung: lokal == fern');
  ok(n(wR.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_CANCEL'") === 0 && Number(r.value.settledAmount) === 0
    && r.value.stockProductId === null && n(wR.db, "SELECT COUNT(*) FROM products WHERE brand = 'Atelier'") === 0,
  'CANCEL …keine Geldbuchung, kein Lagerstück (keine Arbeit angefallen)');
}
marker('CENTRAL_UI_R6F_ORDER_CANCEL_PARITY_PROVED');

// ══ §3 — Storno: Befunde und Atomarität ══════════════════════════════════════
{
  // BEFUND: umgewandelte Anzahlung (Geld liegt auf einer später stornierten Rechnung) wurde erneut erstattet.
  const w = auftrag();
  const pay = s(w.db, 'SELECT id FROM order_payments WHERE order_id = ?', [w.oid]);
  imHaus(() => {
    posting.postOrderPaymentReversed(pay);
    w.db.run('UPDATE order_payments SET converted_to_invoice = 1 WHERE id = ?', [pay]);
  });
  const r = await fern(() => cmd.runOrderCancel(deps(w.db), identity(nx(), 'orders.cancel'),
    { orderId: w.oid, expectedRevision: orev(w.db, w.oid), choice: 'refund', refundMethod: 'cash' }));
  ok(r.ok && Number(r.value.settledAmount) === 0 && n(w.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_CANCEL'") === 0,
    `BEFUND behoben: eine schon umgewandelte Anzahlung wird nicht ein zweites Mal erstattet (${S(r.value.settledAmount)})`);
  ok(Math.abs(saldo(w.db, 'CUSTOMER_DEPOSITS')) < 0.0005 && Math.abs(saldo(w.db, 'CASH')) < 0.0005,
    `LEDGER …Anzahlung und Kasse bleiben ausgeglichen (vorher: Kasse −300, Anzahlung im Soll) (${saldo(w.db, 'CASH')})`);
}
{
  // Atomarität: eine Buchung, das Guthaben, das Lagerstück, die Gold-Schuld — jeder Fehler nimmt ALLES zurück.
  const PUNKTE: Array<[string, RegExp, 'refund' | 'credit']> = [
    ['Buchung', /INSERT INTO ledger_entries/, 'refund'],
    ['Guthaben', /INSERT INTO customer_credits/, 'credit'],
    ['Lagerstück', /INSERT INTO products/, 'refund'],
    ['Gold-Schuld', /UPDATE gold_payables/, 'refund'],
    ['Statuskaskade', /UPDATE order_lines SET status = 'CANCELLED'/, 'refund'],
  ];
  let k = 0;
  for (const [was, muster, choice] of PUNKTE) {
    for (const weg of ['primary', 'fern'] as const) {
      const w = auftrag();
      const vor = S([bild(w), lc(w.db), changelog(w.db)]);
      const req = { orderId: w.oid, expectedRevision: orev(w.db, w.oid), choice, ...(choice === 'refund' ? { refundMethod: 'cash' } : { note: 'x' }) };
      const { db: bad } = faulty(w.db, muster);
      setTestDatabase(bad as never);
      let aus: Ausgang;
      try {
        aus = weg === 'primary'
          ? await primary(() => house.cancelOrderOnPrimary(req as never))
          : await fern(() => cmd.runOrderCancel(deps(bad), identity(ID(9000 + (++k)), 'orders.cancel'), req));
      } finally { setTestDatabase(w.db as never); }
      ok(!aus.ok && S([bild(w), lc(w.db), changelog(w.db)]) === vor,
        `ATOMIC ${weg} ${was} scheitert: kein halb stornierter Auftrag, nichts gebucht, nichts protokolliert (${aus.code.slice(0, 60)})`);
    }
  }
}
marker('CENTRAL_UI_R6F_ORDER_CANCEL_ATOMIC_PROVED');

// ══ §4 — Storno: Wiederholung, Fassung, Sperren, Autorität ═══════════════════
{
  const w = auftrag();
  const body = { orderId: w.oid, expectedRevision: orev(w.db, w.oid), choice: 'refund', refundMethod: 'cash' };
  const cid = nx();
  const a = await fern(() => cmd.runOrderCancel(deps(w.db), identity(cid, 'orders.cancel'), body));
  const nachA = S([lc(w.db), changelog(w.db), n(w.db, 'SELECT COUNT(*) FROM products')]);
  const b = await fern(() => cmd.runOrderCancel(deps(w.db), identity(cid, 'orders.cancel'), body));
  ok(a.ok && b.ok && b.replayed && S(b.value.revision) === S(a.value.revision), 'LOST dieselbe Kennung: die eingefrorene Antwort, kein zweiter Lauf');
  ok(S([lc(w.db), changelog(w.db), n(w.db, 'SELECT COUNT(*) FROM products')]) === nachA, 'LOST …genau eine Wirkung: Buchungen, Abgleich, Lagerstück unverändert');
  const c = await fern(() => cmd.runOrderCancel(deps(w.db), identity(nx(), 'orders.cancel'), { ...body, expectedRevision: orev(w.db, w.oid) }));
  const cp = await primary(() => house.cancelOrderOnPrimary({ ...body, expectedRevision: orev(w.db, w.oid) } as never));
  ok(c.code === 'ORDER_ALREADY_CANCELLED' && c.frozen && cp.code === 'ORDER_ALREADY_CANCELLED', `ALREADY auf beiden Wegen dasselbe Nein (${c.code} / ${cp.code})`);
}
{
  const w = auftrag();
  const vor = bild(w);
  const stale = await fern(() => cmd.runOrderCancel(deps(w.db), identity(nx(), 'orders.cancel'),
    { orderId: w.oid, expectedRevision: orev(w.db, w.oid) + 1, choice: 'forfeit' }));
  const staleP = await primary(() => house.cancelOrderOnPrimary({ orderId: w.oid, expectedRevision: orev(w.db, w.oid) + 1, choice: 'forfeit' }));
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && staleP.code === 'RECORD_CHANGED' && bild(w) === vor,
    `STALE eine andere als die gesehene Fassung: RECORD_CHANGED, nichts geschrieben (${stale.code} / ${staleP.code})`);
}
{
  const sperre = async (label: string, setup: (w: Welt) => void, code: string, welt: Parameters<typeof auftrag>[0] = {}) => {
    const w = auftrag(welt);
    setup(w);
    const vor = bild(w);
    const req = { orderId: w.oid, expectedRevision: orev(w.db, w.oid), choice: 'refund' as const, refundMethod: 'cash' as const };
    const r = await fern(() => cmd.runOrderCancel(deps(w.db), identity(nx(), 'orders.cancel'), req));
    const p = await primary(() => house.cancelOrderOnPrimary(req));
    ok(r.code === code && r.frozen && p.code === code && bild(w) === vor, `BLOCK ${label}: auf beiden Wegen ${code}, nichts geschrieben (${r.code} / ${p.code})`);
  };
  await sperre('abgeschlossener Auftrag (die Maske bietet „Cancel Order" nicht an)',
    (w) => w.db.run("UPDATE orders SET status = 'completed' WHERE id = ?", [w.oid]), 'ORDER_NOT_CANCELLABLE');
  await sperre('eine Position auf einer Rechnung', (w) => w.db.run("UPDATE order_lines SET invoice_id = 'inv-x' WHERE id = ?", [w.p1]), 'ORDER_LINES_INVOICED');
  await sperre('eingelöste Überzahlungs-Gutschrift (Slice 4a)',
    (w) => w.db.run("UPDATE customer_credits SET used_amount = 50 WHERE source_type = 'order_overpayment'"), 'ORDER_OVERPAY_CREDIT_USED', { anzahlung: 2500 });
  // Fremde Filiale
  const w = auftrag();
  const fremd = await fern(() => cmd.runOrderCancel(deps(w.db), identity(nx(), 'orders.cancel'), { orderId: 'ord-x', expectedRevision: 1, choice: 'forfeit' }));
  const fremdId = await fern(() => cmd.runOrderCancel(deps(w.db), identity(nx(), 'orders.cancel', { branchId: 'branch-other' }), { orderId: 'ord-x', expectedRevision: 1, choice: 'forfeit' }));
  ok(fremd.code === 'ORDER_NOT_FOUND' && fremdId.code === 'BRANCH_MISMATCH' && s(w.db, "SELECT status FROM orders WHERE id = 'ord-x'") === 'pending',
    `SECURITY ein Auftrag einer anderen Filiale: nicht gefunden; ein Ausweis einer anderen Filiale: BRANCH_MISMATCH (${fremd.code} / ${fremdId.code})`);
  // Der Rumpf
  const base = { orderId: 'o', expectedRevision: 1, choice: 'refund', refundMethod: 'cash' };
  for (const k of ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'created_by', 'actor', 'createdAt', 'updatedAt', 'revision', 'status',
    'totalPaid', 'paidAmount', 'amount', 'settledAmount', 'refundAmount', 'creditAmount', 'customerId', 'customerCreditId', 'stockProductId',
    'purchasePrice', 'customCostBasis', 'expenseIds', 'account', 'debit', 'credit']) {
    ok(/the primary decides/.test(meldung(() => cmd.parseOrderCancel({ ...base, [k]: 1 }))), `SECURITY ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(meldung(() => cmd.parseOrderCancel({ ...base, foo: 1 }))), 'SECURITY ein unbekanntes Feld wird abgewiesen statt ignoriert');
  for (const bad of [undefined, 0, -1, 1.5, '1']) {
    ok(meldung(() => cmd.parseOrderCancel({ ...base, expectedRevision: bad })) !== '', `SECURITY ohne gültige Fassung kein Storno (${String(bad)})`);
  }
  ok(wirft(() => cmd.parseOrderCancel({ ...base, choice: 'gift' })) === 'CANCEL_CHOICE_INVALID'
    && wirft(() => cmd.parseOrderCancel({ orderId: 'o', expectedRevision: 1, choice: 'refund' })) === 'REFUND_METHOD_REQUIRED'
    && wirft(() => cmd.parseOrderCancel({ ...base, refundMethod: 'card' })) === 'REFUND_METHOD_INVALID'
    && wirft(() => cmd.parseOrderCancel({ orderId: 'o', expectedRevision: 1, choice: 'credit', refundMethod: 'cash' })) === 'CANCEL_FIELD_NOT_APPLICABLE'
    && wirft(() => cmd.parseOrderCancel({ ...base, note: 'x' })) === 'CANCEL_FIELD_NOT_APPLICABLE',
  'SECURITY die Wahl der Maske: drei Wege; Zahlweg nur zur Rückzahlung, Notiz nur zum Guthaben — mit den Codes des Hauses');
  ok(wirft(() => cmd.parseOrderCancel({ orderId: 'o', expectedRevision: 1, choice: 'credit', note: NOTIZ })) === '', 'SECURITY …ein Guthaben mit Notiz ist gültig');
}
marker('CENTRAL_UI_R6F_ORDER_CANCEL_PROVED');

// ══ §5 — Eine Position weiterschalten ════════════════════════════════════════
const statusFern = (w: Welt, lineId: string, status: string, cid = nx(), over: Record<string, unknown> = {}) =>
  fern(() => cmd.runOrderLineStatus(deps(w.db), identity(cid, 'orders.update_line_status'),
    { orderId: w.oid, lineId, status, expectedRevision: orev(w.db, w.oid), ...over }));
{
  const wP = auftrag();
  const wR = auftrag();
  const revR = orev(wR.db, wR.oid);
  auf(wP);
  const p = await primary(() => house.setOrderLineStatusOnPrimary({ orderId: wP.oid, lineId: wP.p2, status: 'ARRIVED', expectedRevision: orev(wP.db, wP.oid) }));
  auf(wR);
  const r = await statusFern(wR, wR.p2, 'ARRIVED');
  const bP = bild(wP); const bR = bild(wR);
  ok(p.ok && r.ok && bP === bR, `LINE PENDING → ARRIVED: lokal == fern — Position, A/P, Buchungen (${p.code || 'ok'} / ${r.code || 'ok'} ${diff(bP, bR)})`);
  const exp = row(wR.db, "SELECT amount, status, supplier_id, category, created_by FROM expenses WHERE description LIKE '%-L2%'");
  ok(Number(exp.amount) === 200 && exp.status === 'PENDING' && exp.supplier_id === 'sup-1' && exp.category === 'Inventory',
    `A/P die angekommene Position bucht ihre Lieferantenkosten (${S(exp)})`);
  ok(s(wP.db, "SELECT created_by FROM expenses WHERE description LIKE '%-L2%'") === 'user-test' && exp.created_by === 'user-pc2',
    'AUTHOR die Ausgabe gehört dem, der den Knopf gedrückt hat');
  ok(Math.abs(saldo(wR.db, 'ACCOUNTS_PAYABLE') + 350) < 0.0005 && balanced(wR.db), `LEDGER A/P jetzt 150 + 200 (${saldo(wR.db, 'ACCOUNTS_PAYABLE')})`);
  ok(r.value.status === 'ARRIVED' && r.value.previousStatus === 'PENDING' && Number(r.value.bookedExpenses) === 1
    && r.value.orderStatus === 'pending' && Number(r.value.revision) > revR,
  `RESULT Status, vorheriger Status, gebuchte A/P, Auftragsstatus (Roll-up: noch pending), neue Fassung (${S(r.value)})`);
  // Weiter und zurück
  const d = await statusFern(wR, wR.p2, 'DELIVERED');
  const back = await statusFern(wR, wR.p2, 'PENDING');
  ok(d.ok && back.ok && n(wR.db, "SELECT COUNT(*) FROM expenses WHERE description LIKE '%-L2%'") === 1
    && s(wR.db, 'SELECT status FROM order_lines WHERE id = ?', [wR.p2]) === 'PENDING',
  'LINE DELIVERED und zurück auf PENDING: keine zweite A/P, die gebuchte bleibt (Vertrag wie bisher)');
  // Alle kundenseitigen Positionen angekommen → der Auftrag rollt auf „arrived"
  await statusFern(wR, wR.p1, 'ARRIVED'); await statusFern(wR, wR.p2, 'ARRIVED'); const q = await statusFern(wR, wR.quote, 'ARRIVED');
  ok(q.ok && q.value.orderStatus === 'arrived' && s(wR.db, 'SELECT status FROM orders WHERE id = ?', [wR.oid]) === 'arrived',
    'ROLLUP alle Positionen angekommen: der Auftrag steht auf arrived (dieselbe Ableitung wie am Primary)');
  ok(n(wR.db, 'SELECT COUNT(*) FROM stock_lots') === 3 && n(wR.db, "SELECT SUM(qty_remaining) FROM stock_lots WHERE branch_id = 'branch-main'") === 2,
    'STOCK der Positionsstatus bewegt keinen Bestand (erst die Rechnung tut das)');
}
{
  const w = auftrag();
  const cid = nx();
  const rumpf = { orderId: w.oid, lineId: w.p2, status: 'ARRIVED', expectedRevision: orev(w.db, w.oid) };
  const a = await fern(() => cmd.runOrderLineStatus(deps(w.db), identity(cid, 'orders.update_line_status'), rumpf));
  const nach = S([lc(w.db), changelog(w.db), n(w.db, 'SELECT COUNT(*) FROM expenses')]);
  const b = await fern(() => cmd.runOrderLineStatus(deps(w.db), identity(cid, 'orders.update_line_status'), rumpf));
  ok(a.ok && b.ok && b.replayed && S([lc(w.db), changelog(w.db), n(w.db, 'SELECT COUNT(*) FROM expenses')]) === nach,
    'LOST dieselbe Kennung: eingefrorene Antwort, genau eine A/P');
  const vor = bild(w);
  const stale = await statusFern(w, w.p1, 'ARRIVED', nx(), { expectedRevision: orev(w.db, w.oid) - 1 });
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && bild(w) === vor, `STALE RECORD_CHANGED, nichts geschrieben (${stale.code})`);
  const sperren: Array<[string, () => Promise<Ausgang>, string]> = [
    ['Kostenzeile (die Karte zeigt nur Kundenpositionen)', () => statusFern(w, w.labor, 'DELIVERED'), 'LINE_NOT_A_CUSTOMER_LINE'],
    ['derselbe Status', () => statusFern(w, w.p2, 'ARRIVED'), 'LINE_STATUS_UNCHANGED'],
    ['Position eines anderen Auftrags', () => statusFern(w, 'olx', 'ARRIVED'), 'LINE_NOT_ON_ORDER'],
    ['Auftrag einer anderen Filiale', () => fern(() => cmd.runOrderLineStatus(deps(w.db), identity(nx(), 'orders.update_line_status'),
      { orderId: 'ord-x', lineId: 'olx', status: 'ARRIVED', expectedRevision: 1 })), 'ORDER_NOT_FOUND'],
  ];
  for (const [label, run, code] of sperren) {
    const v = bild(w);
    const r = await run();
    ok(r.code === code && r.frozen && bild(w) === v, `BLOCK ${label}: ${code} (${r.code})`);
  }
  // Bestellt beim Lieferanten → kein manuelles ARRIVED; „↺ Undo" nimmt den Marker zurück.
  const m = await fern(() => cmd.runOrderLineOrdered(deps(w.db), identity(nx(), 'orders.mark_line_ordered'),
    { orderId: w.oid, lineId: w.p1, supplierId: 'sup-2', expectedRevision: orev(w.db, w.oid) }));
  const nochmal = await statusFern(w, w.p1, 'ARRIVED');
  const nochmalP = await primary(() => house.setOrderLineStatusOnPrimary({ orderId: w.oid, lineId: w.p1, status: 'DELIVERED', expectedRevision: orev(w.db, w.oid) }));
  ok(m.ok && nochmal.code === 'LINE_ORDERED_NEEDS_RECEIPT' && nochmalP.code === 'LINE_ORDERED_NEEDS_RECEIPT',
    `BLOCK eine bestellte Position kommt über den Wareneingang an, nicht per Knopf (${nochmal.code} / ${nochmalP.code})`);
  const undo = await statusFern(w, w.p1, 'PENDING');
  ok(undo.ok && S(row(w.db, 'SELECT status, ordered_supplier_id FROM order_lines WHERE id = ?', [w.p1])) === S({ status: 'PENDING', ordered_supplier_id: null }),
    '„↺ Undo" zurück auf PENDING — der Lieferanten-Marker ist mit weg');
  // Der Rumpf
  const base = { orderId: 'o', lineId: 'l', status: 'ARRIVED', expectedRevision: 1 };
  ok(wirft(() => cmd.parseOrderLineStatus({ ...base, status: 'CANCELLED' })) === 'LINE_STATUS_INVALID'
    && wirft(() => cmd.parseOrderLineStatus({ ...base, status: 'ORDERED' })) === 'LINE_STATUS_INVALID'
    && wirft(() => cmd.parseOrderLineStatus({ ...base, status: 'arrived' })) === 'LINE_STATUS_INVALID',
  'SECURITY genau die drei Ziele der Knöpfe — Storno und „bestellt" haben eigene Wege');
  for (const k of ['orderStatus', 'expenseId', 'expenseIds', 'costAmount', 'supplierId', 'invoiceId', 'createdBy', 'created_by', 'actor', 'userId', 'branchId', 'revision', 'debit']) {
    ok(/the primary decides/.test(meldung(() => cmd.parseOrderLineStatus({ ...base, [k]: 'x' }))), `SECURITY ${k} bestimmt der Primary`);
  }
  ok(meldung(() => cmd.parseOrderLineStatus({ orderId: 'o', lineId: 'l', status: 'ARRIVED' })) !== '', 'SECURITY ohne Fassung kein Statuswechsel');
  // Storniert: keine Knöpfe mehr
  const wc = auftrag();
  await fern(() => cmd.runOrderCancel(deps(wc.db), identity(nx(), 'orders.cancel'), { orderId: wc.oid, expectedRevision: orev(wc.db, wc.oid), choice: 'forfeit' }));
  const nachStorno = await statusFern(wc, wc.p1, 'ARRIVED');
  ok(nachStorno.code === 'ORDER_CANCELLED', `BLOCK ein stornierter Auftrag nimmt keinen Positionsstatus mehr (${nachStorno.code})`);
}
{
  // Atomarität: die A/P scheitert → der Status gilt auch nicht (vorher: Status ARRIVED, Schuld fehlte).
  let k = 0;
  for (const [was, muster] of [['Ausgabe', /INSERT INTO expenses/], ['A/P-Buchung', /INSERT INTO ledger_entries/]] as Array<[string, RegExp]>) {
    for (const weg of ['primary', 'fern'] as const) {
      const w = auftrag();
      const vor = S([bild(w), lc(w.db), changelog(w.db)]);
      const req = { orderId: w.oid, lineId: w.p2, status: 'ARRIVED' as const, expectedRevision: orev(w.db, w.oid) };
      const { db: bad } = faulty(w.db, muster);
      setTestDatabase(bad as never);
      let aus: Ausgang;
      try {
        aus = weg === 'primary'
          ? await primary(() => house.setOrderLineStatusOnPrimary(req))
          : await fern(() => cmd.runOrderLineStatus(deps(bad), identity(ID(9500 + (++k)), 'orders.update_line_status'), req));
      } finally { setTestDatabase(w.db as never); }
      ok(!aus.ok && S([bild(w), lc(w.db), changelog(w.db)]) === vor && s(w.db, 'SELECT status FROM order_lines WHERE id = ?', [w.p2]) === 'PENDING',
        `ATOMIC ${weg} ${was} scheitert: die Position bleibt PENDING, keine halbe A/P (${aus.code.slice(0, 70)})`);
    }
  }
}
marker('CENTRAL_UI_R6F_ORDER_LINE_LIFECYCLE_PROVED');

// ══ §6 — „⚠ Beim Supplier bestellen" ═════════════════════════════════════════
const orderedFern = (w: Welt, lineId: string, extra: Record<string, unknown> = {}, cid = nx()) =>
  fern(() => cmd.runOrderLineOrdered(deps(w.db), identity(cid, 'orders.mark_line_ordered'),
    { orderId: w.oid, lineId, expectedRevision: orev(w.db, w.oid), ...extra }));
{
  const wP = auftrag();
  const wR = auftrag();
  const lcR = lc(wR.db); const expR = n(wR.db, 'SELECT COUNT(*) FROM expenses');
  auf(wP);
  const p = await primary(() => house.markOrderLineOrderedOnPrimary({ orderId: wP.oid, lineId: wP.p1, supplierId: 'sup-2', expectedRevision: orev(wP.db, wP.oid) }));
  auf(wR);
  const r = await orderedFern(wR, wR.p1, { supplierId: 'sup-2' });
  const bP = bild(wP); const bR = bild(wR);
  ok(p.ok && r.ok && bP === bR, `ORDERED lokal == fern (${p.code || 'ok'} / ${r.code || 'ok'} ${diff(bP, bR)})`);
  ok(S(row(wR.db, 'SELECT status, ordered_supplier_id FROM order_lines WHERE id = ?', [wR.p1])) === S({ status: 'ORDERED', ordered_supplier_id: 'sup-2' }),
    'ORDERED Status und geplanter Lieferant stehen an der Position');
  ok(lc(wR.db) === lcR && n(wR.db, 'SELECT COUNT(*) FROM expenses') === expR && n(wR.db, "SELECT SUM(qty_remaining) FROM stock_lots WHERE branch_id = 'branch-main'") === 2,
    'ORDERED ein reiner Marker: keine Buchung, keine Ausgabe, kein Bestand (die kommen mit dem Einkauf)');
  ok(r.value.status === 'ORDERED' && r.value.supplierId === 'sup-2' && r.value.orderStatus === 'pending' && Number(r.value.revision) > 0,
    `RESULT Status, Lieferant, Auftragsstatus, Fassung (${S(r.value)})`);
  const ohneLieferant = await orderedFern(wR, wR.p2);
  ok(ohneLieferant.ok && ohneLieferant.value.supplierId === null, '„Supplier wählen — oder leer lassen": ohne Lieferant geht es auch');
}
{
  const w = auftrag();
  const cid = nx();
  const a = await orderedFern(w, w.p1, { supplierId: 'sup-1' }, cid);
  const nach = changelog(w.db);
  const b = await fern(() => cmd.runOrderLineOrdered(deps(w.db), identity(cid, 'orders.mark_line_ordered'), { orderId: w.oid, lineId: w.p1, supplierId: 'sup-1', expectedRevision: 1 }));
  ok(a.ok && b.ok && b.replayed && changelog(w.db) === nach, 'LOST dieselbe Kennung: eingefrorene Antwort, eine Wirkung');
  const stale = await orderedFern(w, w.p2, { expectedRevision: orev(w.db, w.oid) + 5 });
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && s(w.db, 'SELECT status FROM order_lines WHERE id = ?', [w.p2]) === 'PENDING', `STALE RECORD_CHANGED (${stale.code})`);
  // Beschafft über einen aktiven Einkauf
  insert(w.db, 'purchases', { id: 'pur-1', branch_id: 'branch-main', supplier_id: 'sup-1', status: 'RECEIVED', created_at: NOW, updated_at: NOW });
  insert(w.db, 'purchase_lines', { id: 'pl-1', purchase_id: 'pur-1', source_order_line_id: w.p2, description: 'p2', quantity: 1, unit_price: 200, created_at: NOW });
  w.db.run("UPDATE order_lines SET status = 'ARRIVED' WHERE id = ?", [w.quote]);
  const sperren: Array<[string, () => Promise<Ausgang>, string]> = [
    ['Angebotszeile eines Sonderstücks', () => orderedFern(w, w.quote), 'LINE_NOT_A_PRODUCT_LINE'],
    ['Kostenzeile', () => orderedFern(w, w.labor), 'LINE_NOT_A_CUSTOMER_LINE'],
    ['schon bestellt', () => orderedFern(w, w.p1), 'LINE_NOT_PENDING'],
    ['über einen Einkauf beschafft', () => orderedFern(w, w.p2), 'LINE_ALREADY_SOURCED'],
  ];
  for (const [label, run, code] of sperren) {
    const v = bild(w);
    const r = await run();
    ok(r.code === code && r.frozen && bild(w) === v, `BLOCK ${label}: ${code} (${r.code})`);
  }
  const w2 = auftrag();
  for (const [label, sid] of [['inaktiver Lieferant', 'sup-off'], ['Lieferant einer anderen Filiale', 'sup-x'], ['erfundener Lieferant', 'sup-nope']]) {
    const r = await orderedFern(w2, w2.p1, { supplierId: sid });
    const p = await primary(() => house.markOrderLineOrderedOnPrimary({ orderId: w2.oid, lineId: w2.p1, supplierId: sid, expectedRevision: orev(w2.db, w2.oid) }));
    ok(r.code === 'SUPPLIER_NOT_FOUND' && p.code === 'SUPPLIER_NOT_FOUND' && s(w2.db, 'SELECT status FROM order_lines WHERE id = ?', [w2.p1]) === 'PENDING',
      `SECURITY ${label}: die Auswahl der Maske kennt ihn nicht (${r.code} / ${p.code})`);
  }
  w2.db.run("UPDATE order_lines SET invoice_id = 'inv-x' WHERE id = ?", [w2.p1]);
  const inv = await orderedFern(w2, w2.p1);
  ok(inv.code === 'LINE_INVOICED', `BLOCK eine Position auf einer Rechnung (${inv.code})`);
  const base = { orderId: 'o', lineId: 'l', expectedRevision: 1 };
  for (const k of ['status', 'orderedSupplierId', 'orderStatus', 'invoiceId', 'createdBy', 'created_by', 'actor', 'userId', 'branchId', 'revision']) {
    ok(/the primary decides/.test(meldung(() => cmd.parseOrderLineOrdered({ ...base, [k]: 'x' }))), `SECURITY ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(meldung(() => cmd.parseOrderLineOrdered({ ...base, foo: 1 }))), 'SECURITY ein unbekanntes Feld wird abgewiesen');
}
marker('CENTRAL_UI_R6F_ORDER_MARK_ORDERED_PROVED');

// ══ §7 — Der Positionsdialog ══════════════════════════════════════════════════
const PNG = 'data:image/png;base64,AAAA';
const STAGE = 'a'.repeat(64);
const readStaged = async () => ({ mime: 'image/png', dataBase64: 'AAAA' });
const editFern = (w: Welt, lineId: string, extra: Record<string, unknown>, cid = nx(), discard?: (id: string) => Promise<void>) =>
  fern(() => cmd.runOrderLineEdit(deps(w.db), identity(cid, 'orders.update_line'),
    { orderId: w.oid, lineId, expectedRevision: orev(w.db, w.oid), ...extra },
    { readStaged, discardStaged: discard ?? (async () => { /* */ }) }));
{
  const wP = auftrag();
  const wR = auftrag();
  const patch = { description: 'Rolex M p2 x2', quantity: 2, unitPrice: 600 };
  auf(wP);
  const p = await primary(() => house.updateOrderLineOnPrimary({ orderId: wP.oid, lineId: wP.p2, expectedRevision: orev(wP.db, wP.oid), ...patch }));
  auf(wR);
  const r = await editFern(wR, wR.p2, patch);
  const bP = bild(wP); const bR = bild(wR);
  ok(p.ok && r.ok && bP === bR, `EDIT lokal == fern (${p.code || 'ok'} / ${r.code || 'ok'} ${diff(bP, bR)})`);
  const kopf = row(wR.db, 'SELECT agreed_price, remaining_amount, expected_margin FROM orders WHERE id = ?', [wR.oid]);
  ok(n(wR.db, 'SELECT line_total FROM order_lines WHERE id = ?', [wR.p2]) === 1200 && Number(kopf.agreed_price) === 3000,
    `EDIT Zeilensumme und vereinbarter Preis rechnet das Haus (${S(kopf)})`);
  ok(Number(kopf.remaining_amount) === 2700 && Number(kopf.expected_margin) === 1500,
    `BEFUND behoben: Rest (Preis − Anzahlung) und Marge (Preis − Einkauf) folgen dem neuen Preis — vorher blieben sie beim alten (${S(kopf)})`);
  ok(Number(r.value.lineTotal) === 1200 && Number(r.value.agreedPrice) === 3000 && Number(r.value.remainingAmount) === 2700
    && Number(r.value.expectedMargin) === 1500 && r.value.productId === 'p2', `RESULT (${S(r.value)})`);
  ok(balanced(wR.db) && n(wR.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_OVERPAY'") === 0,
    'LEDGER kein Überschuss → keine Umbuchung');
}
{
  // Ein neuer Artikel — die Fotos reisen fern als Kennungen der Zwischenablage.
  const wP = auftrag();
  const wR = auftrag();
  const spec = { categoryId: 'cat-w', brand: 'Neu', name: 'Uhr R6F', condition: 'New', images: [PNG], purchasePrice: 999, quantity: 7 };
  auf(wP);
  const p = await primary(() => house.updateOrderLineOnPrimary({ orderId: wP.oid, lineId: wP.p1, expectedRevision: orev(wP.db, wP.oid), newProduct: spec as never, description: 'Neu Uhr R6F' }));
  const body = await house.orderLineEditBody({ orderId: wR.oid, lineId: wR.p1, expectedRevision: orev(wR.db, wR.oid), newProduct: spec as never, description: 'Neu Uhr R6F' },
    async (urls) => urls.map(() => STAGE));
  const verworfen: string[] = [];
  auf(wR);
  const r = await fern(() => cmd.runOrderLineEdit(deps(wR.db), identity(nx(), 'orders.update_line'), body,
    { readStaged, discardStaged: async (id: string) => { verworfen.push(id); } }));
  const bP = bild(wP); const bR = bild(wR);
  ok(S((body as { newProduct?: Record<string, unknown> }).newProduct) === S({ categoryId: 'cat-w', brand: 'Neu', name: 'Uhr R6F', condition: 'New', stagingIds: [STAGE] }),
    `NEWPRODUCT der Rumpf trägt nur die Felder der Maske und die Kennung des Fotos (${S(body.newProduct)})`);
  ok(p.ok && r.ok && bP === bR, `NEWPRODUCT lokal == fern (${p.code || 'ok'} / ${r.code || 'ok'} ${diff(bP, bR)})`);
  const neu = row(wR.db, "SELECT id, quantity, purchase_price, stock_status, images, created_by FROM products WHERE brand = 'Neu'");
  ok(Number(neu.quantity) === 0 && Number(neu.purchase_price) === 0 && neu.stock_status === 'in_stock' && neu.images === S([PNG]),
    `NEWPRODUCT der Artikel entsteht ohne Bestand und ohne Einstand (die kommen mit dem Wareneingang), mit Foto (${S(neu)})`);
  ok(s(wR.db, 'SELECT product_id FROM order_lines WHERE id = ?', [wR.p1]) === neu.id && r.value.createdProductId === neu.id,
    'NEWPRODUCT die Position zeigt auf den neuen Artikel');
  ok(s(wP.db, "SELECT created_by FROM products WHERE brand = 'Neu'") === 'user-test' && neu.created_by === 'user-pc2' && S(verworfen) === S([STAGE]),
    'AUTHOR der Artikel gehört dem Absender; die Ablage ist nach dem Erfolg geräumt');
  // Atomarität: der Artikel scheitert → die ganze Änderung
  let k = 0;
  for (const weg of ['primary', 'fern'] as const) {
    const w = auftrag();
    const vor = S([bild(w), changelog(w.db)]);
    const { db: bad } = faulty(w.db, /INSERT INTO products/);
    setTestDatabase(bad as never);
    let aus: Ausgang;
    const req = { orderId: w.oid, lineId: w.p1, expectedRevision: orev(w.db, w.oid), newProduct: { categoryId: 'cat-w', brand: 'Neu', name: 'Uhr' }, quantity: 3, unitPrice: 50 };
    try {
      aus = weg === 'primary'
        ? await primary(() => house.updateOrderLineOnPrimary(req))
        : await fern(() => cmd.runOrderLineEdit(deps(bad), identity(ID(9700 + (++k)), 'orders.update_line'), req, { readStaged }));
    } finally { setTestDatabase(w.db as never); }
    ok(!aus.ok && S([bild(w), changelog(w.db)]) === vor,
      `BEFUND behoben (${weg}): scheitert der neue Artikel, gilt auch Menge/Preis nicht — vorher blieb die Zeile beim alten Artikel mit neuem Preis (${aus.code.slice(0, 60)})`);
  }
  const w = auftrag();
  const vor = bild(w);
  const kaputt = await editFern(w, w.p1, { newProduct: { categoryId: 'cat-nope', brand: 'X', name: 'Y' } });
  ok(!kaputt.ok && kaputt.frozen && bild(w) === vor, `NEWPRODUCT ein Entwurf, den die Maske abweist, wird auch fern abgewiesen (${kaputt.code})`);
  const geist = await editFern(w, w.p1, { newProduct: { categoryId: 'cat-w', brand: 'X', name: 'Y', stagingIds: [STAGE] } }, nx());
  ok(geist.ok, 'NEWPRODUCT (Kontrolle: ein gültiger Entwurf mit Foto geht)');
  const weg = await fern(() => cmd.runOrderLineEdit(deps(w.db), identity(nx(), 'orders.update_line'),
    { orderId: w.oid, lineId: w.p2, expectedRevision: orev(w.db, w.oid), newProduct: { categoryId: 'cat-w', brand: 'X', name: 'Z', stagingIds: ['b'.repeat(64)] } },
    { readStaged: async () => { throw new Error('gone'); } }));
  ok(!weg.ok && !weg.frozen && s(w.db, "SELECT COUNT(*) FROM products WHERE name = 'Z'") === '0', `MEDIA ein verschwundenes Foto: kein Urteil, nichts angelegt (${weg.code})`);
}
{
  // Überzahlung: der neue Preis liegt unter der Anzahlung → Store-Guthaben (Slice 4a)
  const wP = auftrag({ anzahlung: 2300 });
  const wR = auftrag({ anzahlung: 2300 });
  auf(wP);
  const p = await primary(() => house.updateOrderLineOnPrimary({ orderId: wP.oid, lineId: wP.p2, expectedRevision: orev(wP.db, wP.oid), unitPrice: 300 }));
  auf(wR);
  const r = await editFern(wR, wR.p2, { unitPrice: 300 });
  const bP = bild(wP); const bR = bild(wR);
  ok(p.ok && r.ok && bP === bR, `OVERPAY lokal == fern (${diff(bP, bR)})`);
  const cc = row(wR.db, "SELECT amount, status FROM customer_credits WHERE source_type = 'order_overpayment'");
  ok(Number(cc.amount) === 200 && cc.status === 'OPEN' && Math.abs(saldo(wR.db, 'CUSTOMER_CREDIT') + 200) < 0.0005,
    `BEFUND behoben: 2300 bezahlt, neuer Preis 2100 → 200 Store-Guthaben wie nach jeder Zahlung (${S(cc)})`);
  ok(balanced(wR.db), 'LEDGER ausgeglichen');
  wR.db.run("UPDATE customer_credits SET used_amount = 50 WHERE source_type = 'order_overpayment'");
  const vor = bild(wR);
  const blk = await editFern(wR, wR.p2, { unitPrice: 500 });
  const blkP = await primary(() => house.updateOrderLineOnPrimary({ orderId: wR.oid, lineId: wR.p2, expectedRevision: orev(wR.db, wR.oid), unitPrice: 500 }));
  ok(blk.code === 'ORDER_OVERPAY_CREDIT_USED' && blkP.code === 'ORDER_OVERPAY_CREDIT_USED' && bild(wR) === vor,
    `BLOCK ein schon eingelöstes Guthaben wird nie still umgebucht (${blk.code} / ${blkP.code})`);
  const nurText = await editFern(wR, wR.p2, { description: 'nur Text' });
  ok(nurText.ok, 'BLOCK …eine Änderung, die den Preis nicht bewegt, geht weiter');
}
{
  const w = auftrag();
  const cid = nx();
  const a = await editFern(w, w.p1, { quantity: 2 }, cid);
  const nach = S([changelog(w.db), orev(w.db, w.oid)]);
  const b = await editFern(w, w.p1, { quantity: 2 }, cid);
  ok(a.ok && b.ok && b.replayed && S([changelog(w.db), orev(w.db, w.oid)]) === nach, 'LOST dieselbe Kennung: eingefrorene Antwort, eine Wirkung');
  const vor = bild(w);
  const stale = await editFern(w, w.p1, { quantity: 5, expectedRevision: orev(w.db, w.oid) - 1 });
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && bild(w) === vor, `STALE RECORD_CHANGED, nichts geschrieben (${stale.code})`);
  insert(w.db, 'purchases', { id: 'pur-1', branch_id: 'branch-main', supplier_id: 'sup-1', status: 'RECEIVED', created_at: NOW, updated_at: NOW });
  insert(w.db, 'purchase_lines', { id: 'pl-1', purchase_id: 'pur-1', source_order_line_id: w.p2, description: 'p2', quantity: 1, unit_price: 200, created_at: NOW });
  const sperren: Array<[string, () => Promise<Ausgang>, string]> = [
    ['Artikelwechsel einer beschafften Position', () => editFern(w, w.p2, { productId: 'p1' }), 'LINE_ALREADY_SOURCED'],
    ['Artikel einer anderen Filiale', () => editFern(w, w.p1, { productId: 'p-x' }), 'PRODUCT_NOT_FOUND'],
    ['erfundener Artikel', () => editFern(w, w.p1, { productId: 'p-nope' }), 'PRODUCT_NOT_FOUND'],
    ['Kostenzeile', () => editFern(w, w.labor, { description: 'x' }), 'LINE_NOT_A_CUSTOMER_LINE'],
    ['Position eines anderen Auftrags', () => editFern(w, 'olx', { description: 'x' }), 'LINE_NOT_ON_ORDER'],
  ];
  for (const [label, run, code] of sperren) {
    const v = bild(w);
    const r = await run();
    ok(r.code === code && r.frozen && bild(w) === v, `BLOCK ${label}: ${code} (${r.code})`);
  }
  const menge = await editFern(w, w.p2, { quantity: 3 });
  ok(menge.ok && n(w.db, 'SELECT quantity FROM order_lines WHERE id = ?', [w.p2]) === 3, 'EDIT eine beschaffte Position: Menge, Preis und Text bleiben frei');
  w.db.run("UPDATE order_lines SET invoice_id = 'inv-x' WHERE id = ?", [w.p1]);
  w.db.run("UPDATE order_lines SET status = 'CANCELLED' WHERE id = ?", [w.quote]);
  const inv = await editFern(w, w.p1, { description: 'x' });
  const can = await editFern(w, w.quote, { description: 'x' });
  ok(inv.code === 'LINE_INVOICED' && can.code === 'LINE_CANCELLED', `BLOCK Rechnung / storniert (${inv.code} / ${can.code})`);
  const base = { orderId: 'o', lineId: 'l', expectedRevision: 1, quantity: 1 };
  for (const k of ['lineTotal', 'agreedPrice', 'remainingAmount', 'expectedMargin', 'margin', 'costAmount', 'purchasePrice', 'vatAmount', 'taxScheme',
    'position', 'invoiceId', 'supplierId', 'isCustomerFacing', 'status', 'createdBy', 'created_by', 'actor', 'userId', 'branchId', 'revision', 'account']) {
    ok(/the primary decides/.test(meldung(() => cmd.parseOrderLineEdit({ ...base, [k]: 1 }))), `SECURITY ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(meldung(() => cmd.parseOrderLineEdit({ ...base, foo: 1 }))), 'SECURITY ein unbekanntes Feld wird abgewiesen');
  ok(/unknown field/.test(meldung(() => cmd.parseOrderLineEdit({ ...base, newProduct: { categoryId: 'cat-w', brand: 'a', name: 'b', purchasePrice: 5 } }))),
    'SECURITY …auch im Artikel-Entwurf: Einstand bestimmt der Wareneingang');
  ok(meldung(() => cmd.parseOrderLineEdit({ ...base, newProduct: { categoryId: 'cat-w', brand: 'a', name: 'b', stagingIds: ['../x'] } })) !== '',
    'SECURITY eine Fotokennung ist ein Inhaltshash, kein Pfad');
  for (const bad of [0, -1, 1.5, '2']) ok(wirft(() => cmd.parseOrderLineEdit({ ...base, quantity: bad })) === 'LINE_QUANTITY_INVALID', `SECURITY Menge ${String(bad)}: Nein`);
  ok(wirft(() => cmd.parseOrderLineEdit({ ...base, unitPrice: -1 })) === 'LINE_PRICE_INVALID', 'SECURITY negativer Preis: Nein');
  ok(wirft(() => cmd.parseOrderLineEdit({ ...base, productId: 'p1', newProduct: { categoryId: 'cat-w', brand: 'a', name: 'b' } })) === 'LINE_PRODUCT_AMBIGUOUS',
    'SECURITY ein vorhandener ODER ein neuer Artikel');
  ok(wirft(() => cmd.parseOrderLineEdit({ orderId: 'o', lineId: 'l', expectedRevision: 1 })) === 'LINE_EDIT_EMPTY', 'SECURITY eine Änderung muss etwas ändern');
}
marker('CENTRAL_UI_R6F_ORDER_LINE_EDIT_PROVED');

// ══ §8 — Client: keine lokale Datenbank ═════════════════════════════════════
{
  const w = auftrag();
  const vor = bild(w);
  store.set('lataif_runtime_mode', 'client');
  const rev = orev(w.db, w.oid);
  const codes = [
    await primary(() => house.cancelOrderOnPrimary({ orderId: w.oid, expectedRevision: rev, choice: 'forfeit' })),
    await primary(() => house.setOrderLineStatusOnPrimary({ orderId: w.oid, lineId: w.p2, status: 'ARRIVED', expectedRevision: rev })),
    await primary(() => house.markOrderLineOrderedOnPrimary({ orderId: w.oid, lineId: w.p1, expectedRevision: rev })),
    await primary(() => house.updateOrderLineOnPrimary({ orderId: w.oid, lineId: w.p1, expectedRevision: rev, quantity: 2 })),
  ].map((x) => x.code);
  let lokal = 0;
  let geschickt: Record<string, unknown> | null = null;
  const req = { orderId: w.oid, expectedRevision: rev, choice: 'credit' as const, note: NOTIZ };
  const wr = await runSharedWrite(true, {
    local: () => { lokal += 1; return house.cancelOrderOnPrimary(req); },
    remote: () => house.orderCancelBody(req),
  }, { send: async (b: Record<string, unknown>) => { geschickt = b; return { kind: 'ok', value: {}, replayed: false } as never; } });
  store.delete('lataif_runtime_mode');
  ok(codes.every((c) => c === 'CLIENT_WRITE_UNSUPPORTED') && bild(w) === vor,
    `CLIENT jeder Primary-Anschluss verweigert auf einem Client, bevor er die Datenbank fragt (${codes.join(',')})`);
  ok(wr.kind === 'ok' && lokal === 0 && S(geschickt) === S(req) && wirft(() => cmd.parseOrderCancel(geschickt)) === '',
    'CLIENT die Maske geht dort über den Fernbefehl — genau die Wahl der Maske, und der Primary nimmt den Rumpf an');
  for (const b of [house.orderLineStatusBody({ orderId: 'o', lineId: 'l', status: 'DELIVERED', expectedRevision: 3 }),
    house.orderLineOrderedBody({ orderId: 'o', lineId: 'l', supplierId: '', expectedRevision: 3 })]) {
    ok(wirft(() => (b.status ? cmd.parseOrderLineStatus(b) : cmd.parseOrderLineOrdered(b))) === '', `CLIENT der Rumpf passt zum Befehl (${S(b)})`);
  }
}
marker('CENTRAL_UI_R6F_ORDER_CLIENT_NO_LOCAL_DB_PROVED');

// ══ §9 — Oberfläche: jede Handlung EIN Anschluss ════════════════════════════
{
  const od = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  ok(/w\.ok\('orders\.cancel'/.test(od) && /local: \(\) => cancelOrderOnPrimary\(req\)/.test(od) && /remote: \(\) => orderCancelBody\(req\)/.test(od),
    'UI „Cancel Order": am Primary die Hausfolge, auf PC2 derselbe Rumpf');
  ok(/w\.save\('orders\.update_line_status'/.test(od) && /local: \(\) => setOrderLineStatusOnPrimary\(req\)/.test(od) && /remote: \(\) => orderLineStatusBody\(req\)/.test(od),
    'UI die Statusknöpfe (und „↺ Undo") über EINE Buchung');
  ok(/w\.ok\('orders\.mark_line_ordered'/.test(od) && /local: \(\) => markOrderLineOrderedOnPrimary\(req\)/.test(od) && /remote: \(\) => orderLineOrderedBody\(req\)/.test(od),
    'UI „Bestellt markieren" über EINE Buchung');
  ok(/w\.ok\('orders\.update_line'/.test(od) && /local: \(\) => updateOrderLineOnPrimary\(req\)/.test(od) && /orderLineEditBody\(req, stageDataUrls\)/.test(od),
    'UI der Positionsdialog über EINE Buchung, Fotos über die Zwischenablage');
  ok(!/cancelOrderWithMoney\(|\bmarkOrderLineOrdered\(|\bupdateOrderLine\(|updateOrderLineStatus\(/.test(od),
    'UI …keine der vier Store-Schreibaktionen mehr direkt aus der Seite');
  const cancel = /async function handleCancel\([\s\S]*?\n {2}\}/.exec(od)?.[0] ?? '';
  ok(cancel.length > 100 && !/deleteOrder\(/.test(cancel), 'BEFUND behoben: nach einem Storno über „Delete Order" wird der bezahlte Auftrag nicht mehr hart gelöscht');
  ok((od.match(/primaryOnlyDeleteProps\(\)/g) ?? []).length === 2 && (od.match(/blockDeleteOnClient\(\)/g) ?? []).length === 2,
    'UI „Delete Order" bleibt Primary-only (R6B unverändert)');
  ok(/totalPaid=\{totalPaidActive\}/.test(od) && /busy=\{w\.busy\}\s*submitError=\{w\.fehler\}\s*fromDelete=\{cancelFromDelete\}/.test(od),
    'UI die Maske zeigt die Summe, die das Haus bucht, sperrt während des Laufs und zeigt den Ausgang');
  for (const a of ['data-order-cancel-open', 'data-order-line-status', 'data-order-line-undo', 'data-order-line-edit', 'data-order-line-mark-ordered',
    'data-order-line-mark-ordered-supplier', 'data-order-line-mark-ordered-confirm', 'data-order-line=']) {
    ok(od.includes(a), `UI Auftrag trägt ${a}`);
  }
  const cm = codeOf(src('src/components/work-orders/CancelOrderModal.tsx'));
  ok(/choice === 'credit' && trimmed \? trimmed : undefined/.test(cm) && /disabled=\{busy\}/.test(cm) && /<WriteError text=\{submitError\}/.test(cm),
    'UI Storno-Maske: die Notiz reist mit dem Guthaben, der Knopf ist während des Laufs gesperrt');
  for (const a of ['data-order-cancel-choice', 'data-order-cancel-refund-method', 'data-order-cancel-note', 'data-order-cancel-confirm', 'data-order-cancel-back', 'data-order-cancel-from-delete']) {
    ok(cm.includes(a), `UI Storno-Maske trägt ${a}`);
  }
  const em = codeOf(src('src/components/work-orders/OrderLineEditModal.tsx'));
  for (const a of ['data-order-line-save', 'data-order-line-edit-description', 'data-order-line-edit-quantity', 'data-order-line-edit-price', 'data-order-line-edit-mode']) {
    ok(em.includes(a), `UI Positionsdialog trägt ${a}`);
  }
  ok(/disabled=\{busy\}/.test(em) && /<WriteError text=\{submitError\}/.test(em), 'UI …gesperrt während des Laufs, der Ausgang wird gezeigt');
  const oc = codeOf(src('src/core/bridge/order-lifecycle-commands.ts'));
  ok(/cancelOrderInHouse\(req, identity\.branchId\)/.test(oc) && /setOrderLineStatusInHouse\(req, identity\.branchId\)/.test(oc)
    && /markOrderLineOrderedInHouse\(req, identity\.branchId\)/.test(oc) && /updateOrderLineInHouse\(\{ \.\.\.req, newProduct \}, identity\.branchId\)/.test(oc)
    && (oc.match(/assertHouseBranch\(identity\)/g) ?? []).length === 4,
  'UI der Fernbefehl ruft DIESELBE Hausfolge wie die Maske — in den Büchern dieses Rechners');
  ok(!/INSERT INTO|UPDATE orders|postOrderCancellationChoice\(|postExpense\(/.test(oc), 'UI …und schreibt oder bucht nichts selbst');
  const oh = codeOf(src('src/core/orders/order-lifecycle-house.ts'));
  ok(!/BEGIN|COMMIT|ROLLBACK|saveDatabaseDurably|beginLedgerTransaction\(|rollbackLedgerTransaction\(/.test(oh), 'UI die Hausfolge öffnet und schließt keine Transaktion selbst');
  ok((oh.match(/watchLedgerPosts\('/g) ?? []).length === 3, 'UI …jede abgefangene Buchung (Storno, Status, Dialog) bricht die Handlung ab');
  const st = codeOf(src('src/stores/orderStore.ts'));
  const storno = st.slice(st.indexOf('cancelOrderWithMoney: (id, choice, refundMethod, note) =>'), st.indexOf('  deleteOrder: (id) =>'));
  ok(storno.length > 500 && !/safePost\(/.test(storno) && !/catch \(err\)/.test(storno) && /converted_to_invoice, 0\) = 0/.test(storno),
    'STORE der Storno bucht ohne safePost, legt das Lagerstück ohne verschlucktes try/catch an und zählt nur nicht umgewandelte Anzahlungen');
  const edit = st.slice(st.indexOf('updateOrderLine: (lineId, patch) =>'), st.indexOf('commitOrderLineExpenses: (orderId) =>'));
  ok(edit.length > 300 && !/catch \(err\)/.test(edit) && /trackUpdate\('order_lines', lineId, written\)/.test(edit),
    'STORE der Positionsdialog legt den Artikel ohne verschlucktes try/catch an und protokolliert die geschriebenen Spalten (kein Foto im Protokoll)');
}
marker('CENTRAL_UI_R6F_ORDER_UI_WIRING_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6f order parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
