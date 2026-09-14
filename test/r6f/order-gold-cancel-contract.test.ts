// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — Vertrag „ORDER CANCEL / GOLD LIABILITY".
// Run: node test/r6f/order-gold-cancel-contract.test.ts
//
// Woher die Gold-Verbindlichkeit eines Auftrags kommt (gold_payables, direction 'we_owe'):
//   • „Save Order" mit Extra-Gold des Goldschmieds (`createOrderInHouse` → `insertGoldPayable`),
//     verknüpft mit der Extra-Gold-Kostenzeile (PENDING, ohne Lieferant — die Schuld lebt in Gramm);
//   • „Add Cost" mit Goldschmied-Gold (`addOrderCostInHouse`) — die Zeile kommt ARRIVED an.
// Kundengold eines Sonderauftrags ist KEINE Verbindlichkeit: es steht nur in `custom_meta`.
//
// Der Vertrag: „Cancel Order" storniert nur die reine PLANUNG (nichts geliefert, nichts bewegt).
// Geliefertes Gold (Zeile ARRIVED/DELIVERED) oder eine teilweise beglichene Schuld (Gramm bewegt)
// bleibt OFFEN — ein echter Anspruch des Lieferanten, wie die realisierte A/P. Gefahren werden die
// echten Schreibwege (Auftrag, „Add Cost", Goldkern), die echte Hausfolge am Primary und der echte
// Fernbefehl (`orders.cancel`), das echte Schema samt Hauptbuch.
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
const { createOrderInHouse } = await import('../../src/core/orders/order-house.ts');
const { addOrderCostInHouse } = await import('../../src/core/gold/gold-house.ts');
const { settleGoldPayable, creditShopGoldCore, shopGoldStock } = await import('../../src/core/gold/gold-settle.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-14T10:00:00.000Z';

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
  db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', ['branch-main', 'tenant-1', 'Haupt', NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Jewellery','j','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('c1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  for (const id of ['sup-1', 'sup-2']) {
    insert(db, 'suppliers', { id, branch_id: 'branch-main', name: 'Goldschmied ' + id, active: 1, created_at: NOW, updated_at: NOW });
  }
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
const ACT = { branchId: 'branch-main', userId: 'user-test' };
const identity = (commandId: string) => ({
  commandId, tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op: 'orders.cancel', payloadHash: 'h' + commandId,
});
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => { /* gestellt */ },
  now: () => NOW,
});
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}

interface Ausgang { ok: boolean; code: string; value: Record<string, unknown> }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown> };
    return o.kind === 'ok' ? { ok: true, code: '', value: o.value ?? {} } : { ok: false, code: o.code ?? '(ohne Code)', value: {} };
  } catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), value: {} }; }
}
async function primary(p: () => unknown): Promise<Ausgang> {
  try { return { ok: true, code: '', value: (await p() ?? {}) as Record<string, unknown> }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), value: {} }; }
}

// ── Messpunkte: Hauptbuch und Gramm ─────────────────────────────────────────
const saldo = (db: Db, account: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = ?`, [account]);
/** Soll == Haben je Transaktion, in Fils. */
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END)
    FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.length > 0 && t.every((r) => Number(r[1]) === Number(r[2]));
}
/** Offene Gramm je Lieferant (Gewicht − erfüllt, nur OPEN) — die Gold-Schuld des Ladens. */
const owed = (db: Db, supplier: string): number => n(db,
  "SELECT COALESCE(ROUND(SUM(weight_grams - fulfilled_grams), 6), 0) FROM gold_payables WHERE supplier_id = ? AND status = 'OPEN'", [supplier]);
const movements = (db: Db): string => S(rows(db,
  'SELECT direction, weight_grams, karat, source_bucket, target_bucket FROM gold_movements ORDER BY direction, weight_grams'));
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const orev = (db: Db, id: string): number => n(db, 'SELECT revision FROM orders WHERE id = ?', [id]);

/** Der Zustand ohne Kennungen und Zeitstempel — Primary und PC2 müssen gleich enden. */
function bild(db: Db, oid: string): string {
  return S({
    order: row(db, 'SELECT status, agreed_price, deposit_amount, custom_meta FROM orders WHERE id = ?', [oid]),
    lines: rows(db, `SELECT position, description, material_kind, is_customer_facing, supplier_id, cost_amount, status,
        expense_id IS NOT NULL AS has_exp FROM order_lines WHERE order_id = ? ORDER BY position`, [oid]),
    gold: rows(db, 'SELECT supplier_id, direction, weight_grams, karat, settlement_type, fulfilled_grams, status FROM gold_payables ORDER BY supplier_id, karat'),
    goldCredits: rows(db, 'SELECT customer_id, weight_grams, status FROM customer_gold_credits'),
    stock: rows(db, "SELECT karat, ROUND(SUM(weight_grams), 6) AS g FROM precious_metals WHERE metal_type = 'gold' GROUP BY karat ORDER BY karat"),
    movements: movements(db),
    credits: rows(db, 'SELECT amount, status, source_type FROM customer_credits ORDER BY amount'),
    products: rows(db, 'SELECT brand, name, purchase_price, planned_sale_price, stock_status FROM products ORDER BY brand, name'),
    expenses: rows(db, 'SELECT category, amount, paid_amount, status, supplier_id, related_module FROM expenses ORDER BY amount'),
    ledger: rows(db, 'SELECT source_module, account, direction, ROUND(SUM(amount), 3) AS a, COUNT(*) AS c FROM ledger_entries GROUP BY 1, 2, 3 ORDER BY 1, 2, 3'),
  });
}

// ── Die Welten — gebaut über die echten Schreibwege ─────────────────────────
const INPUT = (over: Record<string, unknown> = {}) => ({
  customerId: 'c1', orderType: 'custom', lines: [], quotedPrice: 2000, customTaxScheme: 'MARGIN',
  finalProductDescription: 'Ring mit Goldschmied-Gold',
  customProductSpec: { categoryId: 'cat-w', brand: 'Atelier', name: 'Ring Gold', images: [] },
  customerGoldGrams: 10, customerGoldKarat: '21K', customerStones: '',
  goldsmithSupplierId: 'sup-1', laborCost: 150,
  extraGoldGrams: 5, extraGoldKarat: '22K', extraGoldCost: 100, extraGoldSupplierId: 'sup-1',
  materials: [], depositAmount: 300, paymentMethod: 'cash', cardBrand: 'normal', fullyPaid: false,
  expectedDelivery: '', status: 'pending', notes: '', ...over,
});
type Art = 'plan' | 'delivered' | 'moved';
interface Welt { db: Db; oid: string; gp: string; goldLine: string }
function welt(art: Art): Welt {
  const db = freshDb();
  const out = imHaus(() => {
    if (art === 'delivered') {
      // Auftrag ohne geplantes Extra-Gold; danach „Add Cost": Arbeit (A/P) und Goldschmied-Gold (Gramm-Schuld), beide ARRIVED.
      const { order } = createOrderInHouse(INPUT({ laborCost: 0, extraGoldGrams: 0, extraGoldCost: 0, extraGoldSupplierId: '' }) as never, 'branch-main');
      const r = addOrderCostInHouse(ACT, { orderId: order.id, rows: [
        { materialKind: 'labor', description: 'Fassen', totalCost: 80, supplierId: 'sup-1' },
        { materialKind: 'gold', description: 'Goldschmied-Gold', weightGrams: 3, karat: '21K', totalCost: 60, supplierId: 'sup-2' },
      ] });
      return { oid: order.id, gp: r.goldPayableIds[0] ?? '', goldLine: r.lineIds[1] ?? '' };
    }
    const { order, goldPayableId } = createOrderInHouse(INPUT() as never, 'branch-main');
    if (art === 'moved') {
      // Der Laden hat 2 g seines 22K-Bestands schon an den Goldschmied gegeben (Goldkern, shop_gold).
      creditShopGoldCore(ACT, '22K', 10, { sourceLabel: 'Anfangsbestand' });
      settleGoldPayable(ACT, { payableId: goldPayableId ?? '', mode: 'shop_gold', grams: 2 });
    }
    const gl = s(db, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'gold'", [order.id]);
    return { oid: order.id, gp: goldPayableId ?? '', goldLine: gl };
  });
  reload();
  return { db, ...out };
}
function auf(w: Welt): Welt { setTestDatabase(w.db as never); reload(); return w; }

/** Die Messpunkte VOR dem Storno — Hauptbuch, offene Gramm, Status der Goldzeile. */
function messung(w: Welt) {
  return {
    deposits: saldo(w.db, 'CUSTOMER_DEPOSITS'), cash: saldo(w.db, 'CASH'), ap: saldo(w.db, 'ACCOUNTS_PAYABLE'),
    balanced: balanced(w.db), owed1: owed(w.db, 'sup-1'), owed2: owed(w.db, 'sup-2'),
    goldLine: s(w.db, 'SELECT status FROM order_lines WHERE id = ?', [w.goldLine]),
  };
}

/** Dieselbe Welt zweimal: Storno am Primary (Hausfolge) und über den Fernbefehl — beide mit Rückzahlung bar. */
async function paar(art: Art) {
  const wP = welt(art);
  const wR = welt(art);
  const vorP = bild(wP.db, wP.oid);
  const vorR = bild(wR.db, wR.oid);
  const m = messung(wR);
  auf(wP);
  const p = await primary(() => house.cancelOrderOnPrimary({ orderId: wP.oid, expectedRevision: orev(wP.db, wP.oid), choice: 'refund', refundMethod: 'cash' }));
  auf(wR);
  const r = await fern(() => cmd.runOrderCancel(deps(wR.db) as never, identity(nx()) as never,
    house.orderCancelBody({ orderId: wR.oid, expectedRevision: orev(wR.db, wR.oid), choice: 'refund', refundMethod: 'cash' })));
  return { wP, wR, p, r, vorP, vorR, m };
}

// ══ §1 — Reine Planung: Extra-Gold beim Anlegen, nichts geliefert, nichts bewegt ══
{
  const { wP, wR, p, r, vorP, vorR, m } = await paar('plan');
  ok(vorP === vorR, 'PLAN beide Welten beginnen gleich');
  const w = wR;
  // VORHER
  const vor = JSON.parse(vorR) as { gold: Array<Record<string, unknown>>; goldCredits: unknown[]; movements: string; stock: unknown[]; ledger: unknown[] };
  ok(S(vor.gold) === S([{ supplier_id: 'sup-1', direction: 'we_owe', weight_grams: 5, karat: '22K', settlement_type: 'return_gold', fulfilled_grams: 0, status: 'OPEN' }]),
    `PLAN vorher: EINE offene Gramm-Schuld 5 g 22K an den Goldschmied (${S(vor.gold)})`);
  ok(row(w.db, 'SELECT source_order_id, source_order_line_id FROM gold_payables WHERE id = ?', [w.gp]).source_order_id === w.oid
    && s(w.db, 'SELECT source_order_line_id FROM gold_payables WHERE id = ?', [w.gp]) === w.goldLine && w.goldLine !== '',
  'PLAN vorher: die Schuld gehört NUR diesem Auftrag und hängt an seiner Extra-Gold-Zeile');
  const gl = row(w.db, 'SELECT material_kind, is_customer_facing, supplier_id, cost_amount, expense_id FROM order_lines WHERE id = ?', [w.goldLine]);
  ok(gl.material_kind === 'gold' && Number(gl.is_customer_facing) === 0 && gl.supplier_id === null && Number(gl.cost_amount) === 100 && gl.expense_id === null,
    `PLAN vorher: die Extra-Gold-Zeile ist eine Kostenzeile ohne Lieferant und ohne A/P (${S(gl)})`);
  ok(vor.goldCredits.length === 0 && vor.stock.length === 0 && vor.movements === '[]',
    'PLAN vorher: Kundengold (10 g 21K) ist KEINE Verbindlichkeit — kein Gold-Guthaben, kein Bestand, keine Bewegung');
  ok(/"customerGoldWeight":10/.test(s(w.db, 'SELECT custom_meta FROM orders WHERE id = ?', [w.oid])), 'PLAN vorher: Kundengold steht nur als Memo im Auftrag');
  ok(Math.abs(m.deposits + 300) < 0.0005 && Math.abs(m.cash - 300) < 0.0005 && m.ap === 0 && m.balanced
    && S(vor.ledger.map((x) => (x as { source_module: string }).source_module).filter((v, i, a) => a.indexOf(v) === i)) === S(['ORDER_PAYMENT']),
  `PLAN vorher: Hauptbuch nur die Anzahlung (Kasse 300 / Kundenanzahlung 300), ausgeglichen — Gold bucht kein BHD (${S(m)})`);
  ok(m.owed1 === 5 && m.goldLine === 'PENDING', `PLAN vorher: der Laden schuldet dem Goldschmied 5 g; die Goldzeile ist PENDING (${S(m)})`);
  // NACHHER
  const bP = bild(wP.db, wP.oid); const bR = bild(wR.db, wR.oid);
  ok(p.ok && r.ok, `PLAN beide Wege stornieren (${p.code || 'ok'} / ${r.code || 'ok'})`);
  ok(bP === bR, 'PLAN Primary == PC2: Auftrag, Zeilen, Gold, Bestand, Bewegungen, Buchungen');
  ok(s(w.db, 'SELECT status FROM gold_payables WHERE id = ?', [w.gp]) === 'CANCELLED' && n(w.db, 'SELECT fulfilled_grams FROM gold_payables WHERE id = ?', [w.gp]) === 0,
    'PLAN nachher: die geplante Gramm-Schuld ist CANCELLED (nie geliefert, nie bewegt)');
  ok(owed(w.db, 'sup-1') === 0 && owed(wP.db, 'sup-1') === 0, 'PLAN nachher: offene Gramm an den Goldschmied = 0');
  ok(movements(w.db) === '[]' && shopGoldStock('branch-main', '22K') === 0, 'PLAN nachher: keine Gramm-Bewegung, Bestand unverändert 0');
  ok(n(w.db, 'SELECT COUNT(*) FROM customer_gold_credits') === 0 && /"customerGoldWeight":10/.test(s(w.db, 'SELECT custom_meta FROM orders WHERE id = ?', [w.oid])),
    'PLAN nachher: Kundengold unberührt (kein Anspruch entsteht oder erlischt im System)');
  ok(Math.abs(saldo(w.db, 'CUSTOMER_DEPOSITS')) < 0.0005 && Math.abs(saldo(w.db, 'CASH')) < 0.0005 && balanced(w.db) && balanced(wP.db),
    'PLAN nachher: Anzahlung bar zurück, Soll == Haben je Transaktion (Primary und PC2)');
  ok(n(w.db, "SELECT COUNT(*) FROM products WHERE brand = 'Atelier'") === 0, 'PLAN nachher: kein Lagerstück (keine Arbeit angefallen)');
  ok(S(p.value.cancelledGoldPayableIds) === S([wP.gp]) && S(p.value.openGoldPayableIds) === '[]'
    && Number(r.value.cancelledGoldPayables) === 1 && Number(r.value.openGoldPayables) === 0,
  `PLAN Antwort: 1 storniert, 0 offen (${S(r.value)})`);
}

// ══ §2 — Gold geliefert: „Add Cost" (ARRIVED), der Goldschmied hat das Gold gebracht ══
{
  const { wP, wR, p, r, vorR, m } = await paar('delivered');
  const w = wR;
  const vor = JSON.parse(vorR) as { gold: unknown[] };
  ok(S(vor.gold) === S([{ supplier_id: 'sup-2', direction: 'we_owe', weight_grams: 3, karat: '21K', settlement_type: 'return_gold', fulfilled_grams: 0, status: 'OPEN' }]),
    `DELIVERED vorher: offene Gramm-Schuld 3 g 21K an sup-2 (${S(vor.gold)})`);
  ok(m.goldLine === 'ARRIVED' && m.owed2 === 3, `DELIVERED vorher: die Goldzeile ist ARRIVED (geliefert), 3 g offen (${S(m)})`);
  ok(Math.abs(m.ap + 80) < 0.0005 && m.balanced, `DELIVERED vorher: nur die Arbeit ist A/P (80), das Gold lebt in Gramm (${S(m)})`);
  const bP = bild(wP.db, wP.oid); const bR = bild(wR.db, wR.oid);
  ok(p.ok && r.ok && bP === bR, `DELIVERED beide Wege stornieren, Primary == PC2 (${p.code || 'ok'} / ${r.code || 'ok'})`);
  ok(s(w.db, 'SELECT status FROM gold_payables WHERE id = ?', [w.gp]) === 'OPEN' && owed(w.db, 'sup-2') === 3 && owed(wP.db, 'sup-2') === 3,
    'DELIVERED nachher: die Schuld für geliefertes Gold ÜBERLEBT den Storno — 3 g bleiben offen');
  const stueck = row(w.db, "SELECT purchase_price, stock_status FROM products WHERE brand = 'Atelier'");
  ok(Number(stueck.purchase_price) === 140 && stueck.stock_status === 'in_stock',
    `DELIVERED nachher: das Stück (Arbeit 80 + Gold 60) ist Lagerartikel — das Gold darin ist weiter geschuldet (${S(stueck)})`);
  ok(s(w.db, "SELECT status FROM expenses WHERE related_module = 'order'") === 'PENDING', 'DELIVERED nachher: die A/P der Arbeit bleibt offen (wie bisher)');
  ok(movements(w.db) === '[]' && balanced(w.db) && balanced(wP.db) && Math.abs(saldo(w.db, 'CUSTOMER_DEPOSITS')) < 0.0005,
    'DELIVERED nachher: keine Gramm-Bewegung, Soll == Haben, Anzahlung ausgeglichen');
  ok(S(p.value.cancelledGoldPayableIds) === '[]' && S(p.value.openGoldPayableIds) === S([wP.gp])
    && Number(r.value.cancelledGoldPayables) === 0 && Number(r.value.openGoldPayables) === 1,
  `DELIVERED Antwort: 0 storniert, 1 offen (${S(r.value)})`);
  // Der Anspruch ist lebendig: er wird nach dem Storno regulär beglichen (Goldkern, in BHD).
  auf(w);
  const lcVor = lc(w.db);
  imHaus(() => settleGoldPayable(ACT, { payableId: w.gp, mode: 'money', agreedBhd: 60 }));
  ok(s(w.db, 'SELECT status FROM gold_payables WHERE id = ?', [w.gp]) === 'FULFILLED' && owed(w.db, 'sup-2') === 0
    && Math.abs(saldo(w.db, 'ACCOUNTS_PAYABLE') + 140) < 0.0005 && lc(w.db) > lcVor && balanced(w.db),
  'DELIVERED danach: die überlebende Schuld wird beglichen — FULFILLED, A/P 80 + 60, ausgeglichen');
}

// ══ §3 — Gramm bewegt: 2 g der 5-g-Schuld schon aus dem Ladenbestand gegeben ══
{
  const { wP, wR, p, r, vorR, m } = await paar('moved');
  const w = wR;
  const vor = JSON.parse(vorR) as { gold: unknown[]; stock: unknown[]; movements: string };
  ok(S(vor.gold) === S([{ supplier_id: 'sup-1', direction: 'we_owe', weight_grams: 5, karat: '22K', settlement_type: 'return_gold', fulfilled_grams: 2, status: 'OPEN' }]),
    `MOVED vorher: die Schuld ist teilweise beglichen und trotzdem OPEN (2 von 5 g) (${S(vor.gold)})`);
  ok(S(vor.stock) === S([{ karat: '22K', g: 8 }]), `MOVED vorher: Ladenbestand 22K 10 − 2 = 8 g (${S(vor.stock)})`);
  ok(m.owed1 === 3 && m.goldLine === 'PENDING' && m.balanced, `MOVED vorher: 3 g noch offen, Goldzeile PENDING (${S(m)})`);
  const bP = bild(wP.db, wP.oid); const bR = bild(wR.db, wR.oid);
  ok(p.ok && r.ok && bP === bR, `MOVED beide Wege stornieren, Primary == PC2 (${p.code || 'ok'} / ${r.code || 'ok'})`);
  ok(s(w.db, 'SELECT status FROM gold_payables WHERE id = ?', [w.gp]) === 'OPEN' && n(w.db, 'SELECT fulfilled_grams FROM gold_payables WHERE id = ?', [w.gp]) === 2
    && owed(w.db, 'sup-1') === 3 && owed(wP.db, 'sup-1') === 3,
  'MOVED nachher: die teilweise beglichene Schuld ÜBERLEBT (Goldkern-Regel: sobald Gramm bewegt wurden, bleibt sie) — 3 g offen');
  auf(w);
  ok(shopGoldStock('branch-main', '22K') === 8 && movements(w.db) === vor.movements,
    'MOVED nachher: Bestand (8 g) und Gramm-Bewegungen unverändert — kein Gegenstück verschwindet');
  ok(balanced(w.db) && balanced(wP.db) && Math.abs(saldo(w.db, 'CUSTOMER_DEPOSITS')) < 0.0005, 'MOVED nachher: Soll == Haben, Anzahlung ausgeglichen');
  ok(S(p.value.cancelledGoldPayableIds) === '[]' && S(p.value.openGoldPayableIds) === S([wP.gp])
    && Number(r.value.cancelledGoldPayables) === 0 && Number(r.value.openGoldPayables) === 1,
  `MOVED Antwort: 0 storniert, 1 offen (${S(r.value)})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6f order gold cancel contract: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6F_ORDER_GOLD_CANCEL_CONTRACT_PINNED');
