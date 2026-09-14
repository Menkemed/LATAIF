// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7A (PP-8, PP-9) — Auftragsstorno mit Überzahlungs-Gutschrift; „Delete Order" und Gold.
// Run: node test/r7a/pp8-pp9-order-credit-delete.test.ts
//
// PP-8: die Überzahlungs-Gutschrift (customer_credits 'order_overpayment', Buchung ORDER_OVERPAY) ist ein
// eigenes Finanzobjekt des Kunden. Der Storno löschte sie HART (Buchung storniert, Zeile weg, kein
// Protokoll) und zog ihren Betrag in den Storno — bei „Verfall" verfiel so auch Kundenguthaben. Jetzt:
// Refund = alles zurück, Gutschrift STORNIERT (Zeile bleibt, Protokoll); Credit/Verfall = die Gutschrift
// bleibt unberührt beim Kunden, die Wahl gilt nur für die Anzahlung. Primary und PC2 gleich, atomar,
// verlorene Antwort genau einmal, der Absender aus dem Ausweis.
//
// PP-9: „Delete Order" (Primary-only) stornierte JEDE offene Gramm-Schuld — auch geliefertes und
// teilweise beglichenes Gold — und ließ eine beglichene mit Verweis auf den gelöschten Auftrag stehen.
// Jetzt: geliefert/bewegt/beglichen oder eine bezahlte Kostenposition → Nein mit Code, NICHTS
// geschrieben (der Weg ist „Cancel Order"); nur reine Planung fällt mit dem Auftrag weg.
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


// ══ R7A ═════════════════════════════════════════════════════════════════════
const { useOrderPaymentStore } = await import('../../src/stores/orderPaymentStore.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const { orderDeleteBlocker } = await import('../../src/stores/orderStore.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const HCTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
let seit = 0;
const marker = (m: string): void => { if (fails.length === seit) console.log(m); seit = fails.length; };

// ── PP-8: der Auftrag mit Überzahlung ───────────────────────────────────────
// Sonderauftrag 2000 (vereinbart), bezahlt 2300 bar → Überzahlungs-Gutschrift 300 (ORDER_OVERPAY).
interface UeberWelt { db: Db; oid: string; creditId: string }
function ueberWelt(): UeberWelt {
  const db = freshDb();
  const oid = imHaus(() => createOrderInHouse(INPUT({ laborCost: 0, extraGoldGrams: 0, extraGoldCost: 0, extraGoldSupplierId: '', depositAmount: 0 }) as never, 'branch-main').order.id);
  reload();
  useOrderPaymentStore.getState().addPayment({ orderId: oid, amount: 2300, paidAt: NOW, method: 'cash' });
  reload();
  return { db, oid, creditId: s(db, "SELECT id FROM customer_credits WHERE source_type = 'order_overpayment' AND source_id = ?", [oid]) };
}
type Wahl = 'refund' | 'credit' | 'forfeit';
const reqOf = (w: UeberWelt, wahl: Wahl) => ({
  orderId: w.oid, expectedRevision: orev(w.db, w.oid), choice: wahl, ...(wahl === 'refund' ? { refundMethod: 'cash' as const } : {}),
});
async function storno(w: UeberWelt, wahl: Wahl, weg: 'P' | 'C', commandId = nx()) {
  setTestDatabase(w.db as never); reload();
  const req = reqOf(w, wahl);
  return weg === 'P'
    ? primary(() => house.cancelOrderOnPrimary(req))
    : fern(() => cmd.runOrderCancel(deps(w.db) as never, identity(commandId) as never, house.orderCancelBody(req)));
}
const offenesGuthaben = (db: Db): number => n(db,
  "SELECT COALESCE(ROUND(SUM(amount - used_amount), 3), 0) FROM customer_credits WHERE customer_id = 'c1' AND status = 'OPEN'");
const lebend = (db: Db, module: string, sid: string): number => n(db, `SELECT COUNT(*) FROM ledger_entries o
  WHERE o.source_module = ? AND o.source_id = ? AND o.reverses_entry_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = o.id)`, [module, sid]);
const zustand = (db: Db) => S({
  credits: rows(db, 'SELECT id, source_type, amount, used_amount, status FROM customer_credits ORDER BY source_type, amount'),
  order: row(db, 'SELECT status FROM orders'), led: lc(db), deletes: n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'customer_credits' AND action = 'delete'"),
});

{
  const w = ueberWelt();
  ok(!!w.creditId && n(w.db, 'SELECT amount FROM customer_credits WHERE id = ?', [w.creditId]) === 300 && offenesGuthaben(w.db) === 300
    && saldo(w.db, 'CUSTOMER_CREDIT') === -300 && saldo(w.db, 'CUSTOMER_DEPOSITS') === -2000 && saldo(w.db, 'CASH') === 2300,
  `SETUP 2300 auf 2000: Gutschrift 300 (OPEN), Anzahlung 2000, Kasse 2300 (${S(rows(w.db, 'SELECT amount, status, source_type FROM customer_credits'))})`);
}

const soll: Record<Wahl, { settled: number; offen: number; deposits: number; credit: number; cash: number; fee: number; overpay: string; neu: number }> = {
  refund: { settled: 2300, offen: 0, deposits: 0, credit: 0, cash: 0, fee: 0, overpay: 'CANCELLED', neu: 0 },
  credit: { settled: 2000, offen: 2300, deposits: 0, credit: -2300, cash: 2300, fee: 0, overpay: 'OPEN', neu: 2000 },
  forfeit: { settled: 2000, offen: 300, deposits: 0, credit: -300, cash: 2300, fee: -2000, overpay: 'OPEN', neu: 0 },
};
for (const wahl of ['refund', 'credit', 'forfeit'] as const) {
  const erg: Record<string, { w: UeberWelt; r: Awaited<ReturnType<typeof storno>> }> = {};
  for (const weg of ['P', 'C'] as const) {
    const w = ueberWelt();
    const auditVor = n(w.db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'customer_credits' AND entity_id = ?", [w.creditId]);
    const r = await storno(w, wahl, weg);
    erg[weg] = { w, r };
    const e = soll[wahl];
    const ov = row(w.db, 'SELECT amount, used_amount, status FROM customer_credits WHERE id = ?', [w.creditId]);
    const neu = n(w.db, "SELECT COALESCE(SUM(amount), 0) FROM customer_credits WHERE source_type = 'order_cancel'");
    const tag = `${wahl.toUpperCase()} [${weg === 'P' ? 'Primary' : 'PC2'}]`;
    ok(r.ok && Number(r.value.settledAmount) === e.settled && s(w.db, 'SELECT status FROM orders') === 'cancelled',
      `${tag} storniert; die Wahl gilt für ${e.settled} (${S(r.value).slice(0, 300)} ${r.code})`);
    ok(Number(ov.amount) === 300 && ov.status === e.overpay && n(w.db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'customer_credits' AND action = 'delete'") === 0,
      `${tag} die Überzahlungs-Gutschrift ist NICHT gelöscht: dieselbe Zeile, 300, ${e.overpay} (${S(ov)})`);
    ok(offenesGuthaben(w.db) === e.offen && neu === e.neu,
      `${tag} Kundenguthaben danach ${e.offen} (neues Storno-Guthaben ${e.neu}) (${offenesGuthaben(w.db)}/${neu})`);
    ok(saldo(w.db, 'CUSTOMER_DEPOSITS') === e.deposits && saldo(w.db, 'CUSTOMER_CREDIT') === e.credit && saldo(w.db, 'CASH') === e.cash
      && saldo(w.db, 'CANCELLATION_FEE_INCOME') === e.fee && balanced(w.db),
    `${tag} Hauptbuch: Anzahlungen 0, Kundenguthaben ${e.credit}, Kasse ${e.cash}, Verfall ${e.fee}, ausgeglichen (${S([saldo(w.db, 'CUSTOMER_DEPOSITS'), saldo(w.db, 'CUSTOMER_CREDIT'), saldo(w.db, 'CASH'), saldo(w.db, 'CANCELLATION_FEE_INCOME')])})`);
    if (wahl === 'refund') {
      const aud = rows(w.db, "SELECT action_type, changed_by FROM audit_log WHERE entity_type = 'customer_credits' AND entity_id = ? ORDER BY rowid", [w.creditId]);
      // Am Primary nennt das Ergebnis die Kennungen, fern (wie Gold/Kosten) die Anzahl.
      const gemeldet = weg === 'P' ? S(r.value.voidedOverpayCreditIds) === S([w.creditId]) : r.value.voidedOverpayCredits === 1 && r.value.keptOverpayCredits === 0;
      ok(lebend(w.db, 'ORDER_OVERPAY', w.oid) === 0 && aud.length > auditVor && gemeldet,
        `${tag} Rückzahlung: Gutschrift storniert statt gelöscht — Reklass-Bein gegengebucht, Protokoll geschrieben (${S(aud)})`);
      ok(String(aud[aud.length - 1]?.changed_by ?? '') === (weg === 'P' ? 'user-test' : 'user-pc2'),
        `${tag} AKTEUR das Protokoll nennt ${weg === 'P' ? 'die Primary-Anmeldung' : 'den geprüften PC2-Absender'} (${S(aud[aud.length - 1])})`);
    } else {
      const gemeldet = weg === 'P' ? S(r.value.keptOverpayCreditIds) === S([w.creditId]) : r.value.keptOverpayCredits === 1 && r.value.voidedOverpayCredits === 0;
      ok(lebend(w.db, 'ORDER_OVERPAY', w.oid) > 0 && gemeldet,
        `${tag} die Gutschrift bleibt samt Buchung beim Kunden (keptOverpayCreditIds)`);
    }
  }
  ok(bild(erg.P.w.db, erg.P.w.oid) === bild(erg.C.w.db, erg.C.w.oid),
    `${wahl.toUpperCase()} PARITÄT Primary == PC2 (Zeilen, Guthaben, Hauptbuch je Quelle)`);
}
marker('R7A_PP8_CHOICES_PINNED');

// Eingelöste Gutschrift → Sperre, nichts geschrieben (Primary und PC2).
for (const weg of ['P', 'C'] as const) {
  const w = ueberWelt();
  w.db.run('UPDATE customer_credits SET used_amount = 50 WHERE id = ?', [w.creditId]);
  const vor = zustand(w.db);
  const r = await storno(w, 'credit', weg);
  ok(!r.ok && r.code === 'ORDER_OVERPAY_CREDIT_USED' && zustand(w.db) === vor,
    `SPERRE [${weg}] eine eingelöste Überzahlungs-Gutschrift sperrt den Storno — nichts geschrieben (${r.code})`);
}

// Verlorene Antwort: dieselbe Kennung zweimal → genau eine Wirkung, das eingefrorene Ergebnis.
{
  const w = ueberWelt();
  const id = nx();
  const req = reqOf(w, 'refund');
  setTestDatabase(w.db as never); reload();
  const r1 = await cmd.runOrderCancel(deps(w.db) as never, identity(id) as never, house.orderCancelBody(req)) as { kind: string; replayed?: boolean };
  const nach1 = zustand(w.db);
  const r2 = await cmd.runOrderCancel(deps(w.db) as never, identity(id) as never, house.orderCancelBody(req)) as { kind: string; replayed?: boolean };
  ok(r1.kind === 'ok' && r2.kind === 'ok' && r2.replayed === true && zustand(w.db) === nach1,
    `LOST dieselbe Kennung zweimal: das zweite Mal replayed, keine zweite Buchung, Gutschrift einmal storniert (${S([r1.kind, r2.kind, r2.replayed])})`);
}

// Fehlerinjektion: die Rückzahlung scheitert NACH dem Storno der Gutschrift → alles zurück.
for (const weg of ['P', 'C'] as const) {
  const w = ueberWelt();
  const vor = zustand(w.db);
  const raw = w.db.run.bind(w.db);
  let k = 0;
  (w.db as { run: Db['run'] }).run = (sql: string, p?: unknown[]) => {
    if (/INSERT INTO ledger_entries/i.test(sql) && ++k === 3) throw new Error('R7A: injected failure');
    return raw(sql, p);
  };
  const r = await storno(w, 'refund', weg);
  (w.db as { run: Db['run'] }).run = raw;
  ok(!r.ok && zustand(w.db) === vor && s(w.db, 'SELECT status FROM customer_credits WHERE id = ?', [w.creditId]) === 'OPEN'
    && lebend(w.db, 'ORDER_OVERPAY', w.oid) > 0,
  `ATOMAR [${weg}] Buchung scheitert nach dem Gutschrift-Storno → nichts bleibt: Gutschrift OPEN, Reklass-Bein lebt, Auftrag offen (${r.code})`);
}

// UI + Quelltext.
{
  const m = codeOf(src('src/components/work-orders/CancelOrderModal.tsx'));
  const od = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  const st = codeOf(src('src/stores/orderStore.ts'));
  const cancel = st.slice(st.indexOf('cancelOrderWithMoney: (id, choice, refundMethod, note) =>'), st.indexOf('deleteOrder: (id) =>'));
  ok(/data-order-cancel-overpay/.test(m) && /overpaymentCredit\s*>\s*0\.005/.test(m) && /overpaymentCredit=\{/.test(od),
    'UI die Storno-Maske zeigt, was mit der Überzahlung geschieht (Refund: mit zurück; sonst: bleibt Guthaben)');
  ok(!/teardownOrderOverpayCredit\(/.test(cancel) && /openOrderOverpayCredit\(id\)/.test(cancel) && /voidOrderOverpayCredit\(id, 'order_cancel_refund'\)/.test(cancel),
    'SOURCE der Storno löscht die Gutschrift nicht mehr (kein Teardown), er storniert sie nur bei Refund');
}
marker('POST_PARITY_R7A_PP8_ORDER_CREDIT_CANCEL_FIXED');

// ── PP-9: „Delete Order" und Gold ────────────────────────────────────────────
const zaehler = (db: Db): string => S({
  o: rows(db, 'SELECT id, status FROM orders ORDER BY id'), l: n(db, 'SELECT COUNT(*) FROM order_lines'),
  gp: rows(db, 'SELECT id, status, fulfilled_grams FROM gold_payables ORDER BY id'), led: lc(db),
  exp: rows(db, 'SELECT id, status, paid_amount FROM expenses ORDER BY id'), ep: n(db, 'SELECT COUNT(*) FROM expense_payments'),
  op: n(db, 'SELECT COUNT(*) FROM order_payments'), cl: n(db, 'SELECT COUNT(*) FROM sync_changelog'), a: n(db, 'SELECT COUNT(*) FROM audit_log'),
});
function loeschen(w: { db: Db; oid: string }): { code: string; gleich: boolean; blocker: string } {
  setTestDatabase(w.db as never); reload();
  const blocker = orderDeleteBlocker(w.oid)?.code ?? '';
  const vor = zaehler(w.db);
  const code = wirft(() => useOrderStore.getState().deleteOrder(w.oid));
  return { code, gleich: zaehler(w.db) === vor, blocker };
}

// (1) reine Planung → Löschen erlaubt, die geplante Gramm-Schuld fällt mit weg.
{
  const w = welt('plan');
  const d = loeschen(w);
  ok(d.blocker === '' && d.code === '' && n(w.db, 'SELECT COUNT(*) FROM orders') === 0
    && s(w.db, 'SELECT status FROM gold_payables WHERE id = ?', [w.gp]) === 'CANCELLED' && owed(w.db, 'sup-1') === 0 && balanced(w.db),
  `PLAN reine Planung: gelöscht, geplante Gramm-Schuld CANCELLED, Hauptbuch ausgeglichen (${d.code || 'ok'})`);
}
// (2) geliefert, (3) Gramm bewegt → gesperrt, nichts geschrieben.
for (const art of ['delivered', 'moved'] as const) {
  const w = welt(art);
  const owedVor = owed(w.db, art === 'delivered' ? 'sup-2' : 'sup-1');
  const d = loeschen(w);
  ok(d.blocker === 'ORDER_DELETE_GOLD_MOVED' && d.code === 'ORDER_DELETE_GOLD_MOVED' && d.gleich
    && owed(w.db, art === 'delivered' ? 'sup-2' : 'sup-1') === owedVor && owedVor > 0,
  `${art.toUpperCase()} ${art === 'delivered' ? 'Gold geliefert (ARRIVED)' : 'Gramm schon bewegt'}: Löschen gesperrt, NICHTS geschrieben, die Schuld bleibt (${d.code}, ${owedVor} g)`);
  // Der Weg ist der Storno — er lässt genau diese Schuld stehen.
  const c = await primary(() => house.cancelOrderOnPrimary({ orderId: w.oid, expectedRevision: orev(w.db, w.oid), choice: 'refund', refundMethod: 'cash' }));
  ok(c.ok && S(c.value.openGoldPayableIds) === S([w.gp]), `${art.toUpperCase()} …der Storno geht und lässt die Gold-Schuld offen`);
}
// (4) ganz beglichen (FULFILLED, in Geld umgewandelt) → gesperrt.
{
  const w = welt('plan');
  setTestDatabase(w.db as never); reload();
  useGoldStore.getState().convertGoldPayableToMoney(w.gp, 95, 'bank', 'R7A');
  const st = s(w.db, 'SELECT status FROM gold_payables WHERE id = ?', [w.gp]);
  const d = loeschen(w);
  ok(st === 'FULFILLED' && d.code === 'ORDER_DELETE_GOLD_MOVED' && d.gleich && s(w.db, 'SELECT status FROM gold_payables WHERE id = ?', [w.gp]) === 'FULFILLED',
    `FULFILLED beglichene Gold-Schuld: Löschen gesperrt, nichts geschrieben (${st}/${d.code})`);
}
// (5) bezahlte Kostenposition (ohne Gold) → gesperrt; unbezahlt → Löschen wie bisher.
function kostenWelt(): { db: Db; oid: string; expId: string } {
  const db = freshDb();
  const out = imHaus(() => {
    const { order } = createOrderInHouse(INPUT({ laborCost: 0, extraGoldGrams: 0, extraGoldCost: 0, extraGoldSupplierId: '', depositAmount: 0 }) as never, 'branch-main');
    addOrderCostInHouse(ACT, { orderId: order.id, rows: [{ materialKind: 'labor', description: 'Fassen', totalCost: 80, supplierId: 'sup-1' }] });
    return order.id;
  });
  reload();
  return { db, oid: out, expId: s(db, 'SELECT expense_id FROM order_lines WHERE order_id = ? AND expense_id IS NOT NULL', [out]) };
}
{
  const w = kostenWelt();
  const apVor = saldo(w.db, 'ACCOUNTS_PAYABLE');
  const d = loeschen(w);
  ok(!!w.expId && d.blocker === '' && d.code === '' && n(w.db, 'SELECT COUNT(*) FROM orders') === 0 && saldo(w.db, 'ACCOUNTS_PAYABLE') === 0 && apVor !== 0 && balanced(w.db),
    `KOSTEN unbezahlt: Löschen wie bisher — A/P sauber zurückgenommen (${apVor} → ${saldo(w.db, 'ACCOUNTS_PAYABLE')})`);
}
{
  const w = kostenWelt();
  setTestDatabase(w.db as never); reload();
  imHaus(() => payables.recordExpensePaymentInHouse(w.expId, 80, 'cash', HCTX));
  const d = loeschen(w);
  ok(d.blocker === 'ORDER_DELETE_COSTS_PAID' && d.code === 'ORDER_DELETE_COSTS_PAID' && d.gleich,
    `KOSTEN bezahlt: Löschen gesperrt — sonst verschwände die Zahlung ohne Gegenbuchung; nichts geschrieben (${d.code})`);
}
// (6) Primary-only bleibt: kein Fernweg; die Maske fragt vorher; der Store prüft zuerst.
{
  const od = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  const st = codeOf(src('src/stores/orderStore.ts'));
  const del = st.slice(st.indexOf('deleteOrder: (id) =>'));
  ok(!registry.ALLOWED_MUTATIONS.includes('orders.delete'), 'PRIMARY-ONLY „Delete Order" hat keinen Fernbefehl');
  ok(/const blocked = orderDeleteBlocker\(id\);\s*if \(blocked\) throw blocked;\s*const db = getDatabase\(\);/.test(del),
    'SOURCE deleteOrder prüft ZUERST (vor jedem Schreiben)');
  ok(/blockDeleteOnClient\(\)[\s\S]{0,600}orderDeleteBlocker\(id\)[\s\S]{0,200}deleteOrder\(id\)/.test(od),
    'UI OrderDetail: Client-Riegel, bezahlt → Storno-Assistent, gesperrt → Grund, erst dann deleteOrder');
}
marker('POST_PARITY_R7A_PP9_ORDER_DELETE_GOLD_FIXED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — post-parity r7a pp-8/pp-9 order credit cancel + delete gold: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
