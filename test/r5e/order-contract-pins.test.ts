// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E FINAL — die Verträge des Primary, gegen den Stand vor R5E (54ea905) festgenagelt.
// Run: node test/r5e/order-contract-pins.test.ts
//
//   §1 Vorzeichen: jedes Feld, das R5E als ≥ 0 prüft — auf beiden Wegen; das Guthaben aus Überzahlung bleibt.
//   §2 Abgeschlossen/storniert: kein „Edit" — die bestehende Invariante der Maske, zentral am Ändern-Weg.
//   §3 Gold-Verbindlichkeit: Zeile, Gramm/Karat, Gläubiger, keine zweite Geldschuld, Ausgleichswege.
//   §4 Test-Delta commercial-documents: nichts übersprungen, abgeleitete Felder und Filiale bleiben zu.
//   §5 „+ New Supplier" im Einkauf: eine neue Fern-Schreiblücke, nicht unter den 40, Registry 107.
// ════════════════════════════════════════════════════════════════════════════
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
const { tauriState, stageForTest } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const orderHouse = await import('../../src/core/orders/order-house.ts');
const orderRules = await import('../../src/core/orders/order-create.ts');
const orderEdit = await import('../../src/core/orders/order-edit.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const purchaseRules = await import('../../src/core/purchases/purchase-create.ts');
const { R4C_MATRIX } = await import('../uiparity/_r4c-write-matrix.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NOW = '2026-09-12T10:00:00.000Z';
const S = (v: unknown): string => JSON.stringify(v);

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function rows(db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, p)[0];
  if (!r) return [];
  return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])));
}
const row = (db: Db, sql: string, p: unknown[] = []): Record<string, unknown> => rows(db, sql, p)[0] ?? {};

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
  useInvoiceStore.getState().loadInvoices();
  useOrderStore.getState().loadOrders();
  usePurchaseStore.getState().loadPurchases();
  useSupplierStore.getState().loadSuppliers();
}

const SEED_PRODUCTS = ['p1', 'p2', 'p3', 'p-svc', 'p-foreign'];
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
  for (const [id, branch] of [['cat-w', 'branch-main'], ['cat-repair-service-branch-main', 'branch-main'], ['cat-foreign', 'branch-other']]) {
    db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,'w','#000',?,?)", [id, branch, id, NOW, NOW]);
  }
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'],
    ['cust-x', 'Fremd', 'branch-other'], ['sys-walkin', 'Walk-in', 'branch-main']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch, active] of [['sup-1', 'branch-main', 1], ['sup-gold', 'branch-main', 1], ['sup-off', 'branch-main', 0], ['sup-x', 'branch-other', 1]] as Array<[string, string, number]>) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,?,?,?)', [id, branch, 'Lieferant ' + id, active, NOW, NOW]);
  }
  for (const [id, branch, st] of [['emp-1', 'branch-main', 'active'], ['emp-gone', 'branch-main', 'inactive'], ['emp-x', 'branch-other', 'active']]) {
    insert(db, 'employees', { id, branch_id: branch, name: 'M ' + id, employment_status: st, created_at: NOW, updated_at: NOW });
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (const [id, branch, cat, tax] of [['p1', 'branch-main', 'cat-w', 'VAT_10'], ['p2', 'branch-main', 'cat-w', 'MARGIN'],
    ['p3', 'branch-main', 'cat-w', 'ZERO'], ['p-svc', 'branch-main', 'cat-repair-service-branch-main', 'VAT_10'],
    ['p-foreign', 'branch-other', 'cat-foreign', 'MARGIN']]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,?,'Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,'in_stock',?,0,'[]','{}','OWN',?,?)`,
    [id, branch, cat, 'M ' + id, 'SKU-' + id, tax, NOW, NOW]);
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,?,?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, branch, id, NOW, NOW]);
  }
  insert(db, 'purchase_inbox', { id: 'inbox-1', branch_id: 'branch-main', images: '[]', note: 'Foto', status: 'open', created_at: NOW });
  insert(db, 'purchase_inbox', { id: 'inbox-x', branch_id: 'branch-other', images: '[]', note: 'Fremd', status: 'open', created_at: NOW });
  reload();
  tauriState.reset();
  return db;
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const OWNER = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const fremd = (x: string, op: string) => ({ ...identity(x, op), branchId: 'branch-other' });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
const orev = (db: Db, id: string): number => n(db, 'SELECT revision FROM orders WHERE id = ?', [id]);

/** Ein Foto, wie die Maske es als Data-URL hält — und wie die Zwischenablage es wieder hergibt. */
const foto = (seed: number): string => `data:image/jpeg;base64,${Buffer.from(Uint8Array.from({ length: 48 }, (_, i) => (seed * 31 + i * 7) & 0xff)).toString('base64')}`;
const stage = async (urls: readonly string[]): Promise<string[]> =>
  urls.map((u) => stageForTest(Uint8Array.from(Buffer.from(u.split(',')[1], 'base64')), OWNER));

interface Ausgang { ok: boolean; code: string; value?: Record<string, unknown>; replayed?: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean };
    if (o.kind === 'ok') return { ok: true, code: '', value: o.value, replayed: o.replayed };
    return { ok: false, code: o.code ?? '(ohne Code)' };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e) };
  }
}
async function primary(p: () => Promise<unknown>): Promise<Ausgang> {
  try { return { ok: true, code: '', value: await p() as Record<string, unknown> }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e) }; }
}

const OHNE = /^(id|version|sync_status)$|_at$/;
function ohne(r: Record<string, unknown>, auch: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}
const unterschiede = (a: unknown, b: unknown, wo: string): string[] => (S(a) === S(b) ? [] : [`${wo}: ${S(a).slice(0, 300)} ≠ ${S(b).slice(0, 300)}`]);
const buchungen = (db: Db): string =>
  S(db.exec('SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries GROUP BY account, direction ORDER BY account, direction')[0]?.values ?? []);
const pid = (v: unknown): unknown => (typeof v === 'string' && SEED_PRODUCTS.includes(v) ? v : (v ? 'NEU' : v));


const { useGoldStore } = await import('../../src/stores/goldStore.ts');

type OI = import('../../src/core/orders/order-create.ts').OrderCreateInput;
const LEER: OI = {
  customerId: 'cust-1', orderType: 'normal', lines: [], quotedPrice: 0, customTaxScheme: 'MARGIN', finalProductDescription: '',
  customProductSpec: undefined, customerGoldGrams: 0, customerGoldKarat: '22K', customerStones: '', goldsmithSupplierId: '',
  laborCost: 0, extraGoldGrams: 0, extraGoldKarat: '22K', extraGoldCost: 0, extraGoldSupplierId: '', materials: [],
  depositAmount: 0, paymentMethod: 'cash', cardBrand: 'normal', fullyPaid: false, expectedDelivery: '', status: 'pending', notes: '',
};
const SPEC = {
  categoryId: 'cat-w', brand: 'Omega', name: 'Pin', sku: '', condition: 'New', taxScheme: 'VAT_10',
  scopeOfDelivery: ['Box'], purchaseCurrency: 'BHD', attributes: {}, images: [] as string[],
};
const NORMAL: OI = {
  ...LEER, lines: [{ mode: 'existing', productId: 'p1', description: 'x', scheme: 'auto', quantity: 1, unitPrice: 600 }],
  depositAmount: 100, paymentMethod: 'cash',
};
const CUSTOM: OI = {
  ...LEER, orderType: 'custom', lines: [{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }],
  quotedPrice: 1100, customTaxScheme: 'VAT_10', customProductSpec: SPEC, customerGoldGrams: 12.5, customerGoldKarat: '21K',
  goldsmithSupplierId: 'sup-1', laborCost: 80, extraGoldGrams: 5, extraGoldKarat: '22K', extraGoldCost: 120, extraGoldSupplierId: 'sup-gold',
  materials: [{ materialKind: 'diamond', description: 'RB', quantity: 2, caratPerPiece: 0.5, totalCost: 400, supplierId: 'sup-1' }],
  depositAmount: 300, paymentMethod: 'bank', status: 'arrived',
};
const MIXED: OI = {
  ...LEER, orderType: 'mixed', lines: [{ mode: 'existing', productId: 'p3', description: 'x', scheme: 'auto', quantity: 1, unitPrice: 250 }],
  quotedPrice: 600, customTaxScheme: 'MARGIN', finalProductDescription: 'Ring', customProductSpec: SPEC,
};
let nth = 1000;
const nextId = (): string => String(nth++);

/** Dieselbe Eingabe einmal über die Maske des Primary, einmal über den Fernbefehl — je eine frische Welt. */
async function beideAnlegen(input: OI) {
  const dbP = freshDb();
  const p = await primary(() => orderHouse.createOrderOnPrimary(input));
  const dbR = freshDb();
  const r = await fern(async () => cmd.runOrderCreate(deps(dbR), identity(nextId(), 'orders.create'), await orderRules.orderCreateBody(input, stage)));
  return { p, r, dbP, dbR, nP: n(dbP, 'SELECT COUNT(*) FROM orders'), nR: n(dbR, 'SELECT COUNT(*) FROM orders') };
}

/** Ein laufender Auftrag im gewünschten Zustand, dann „Save" der Auftragsseite auf einem der beiden Wege. */
async function editWelt(weg: 'primary' | 'fern', status: string, form: Record<string, unknown>) {
  const db = freshDb();
  const made = await orderHouse.createOrderOnPrimary(NORMAL);
  const oid = made.order.id;
  if (status !== 'pending') db.run('UPDATE orders SET status = ? WHERE id = ?', [status, oid]);
  useOrderStore.getState().loadOrders();
  const order = useOrderStore.getState().orders.find((o) => o.id === oid)!;
  const vorher = S(ohne(row(db, 'SELECT * FROM orders WHERE id = ?', [oid])));
  const f = { ...order, ...form };
  const aus = weg === 'primary'
    ? await primary(() => orderHouse.updateOrderOnPrimary(oid, f))
    : await fern(() => cmd.runOrderUpdate(deps(db), identity(nextId(), 'orders.update'), orderEdit.orderEditBody(oid, orev(db, oid), f)));
  return { aus, unveraendert: S(ohne(row(db, 'SELECT * FROM orders WHERE id = ?', [oid]))) === vorher };
}

// ── §1 Vorzeichen: jedes Feld, das R5E als ≥ 0 prüft ─────────────────────
{
  const base = await beideAnlegen(MIXED);
  ok(base.p.ok && base.r.ok, `SIGN die Grundform (alle Betraege ≥ 0) legt auf beiden Wegen an (${base.p.code || 'ok'} / ${base.r.code || 'ok'})`);
  const faelle: Array<[string, OI]> = [
    ['quotedPrice', { ...MIXED, quotedPrice: -100 }],
    ['customerGoldGrams', { ...CUSTOM, customerGoldGrams: -1 }],
    ['laborCost', { ...CUSTOM, laborCost: -80 }],
    ['extraGoldGrams', { ...CUSTOM, extraGoldGrams: -5 }],
    ['extraGoldCost', { ...CUSTOM, extraGoldGrams: 0, extraGoldCost: -120 }],
    ['depositAmount', { ...NORMAL, depositAmount: -100 }],
    ['line unitPrice', { ...NORMAL, lines: [{ ...NORMAL.lines[0], unitPrice: -600 }] }],
    ['material totalCost', { ...CUSTOM, materials: [{ ...CUSTOM.materials[0], totalCost: -400 }] }],
  ];
  for (const [feld, bad] of faelle) {
    const w = await beideAnlegen(bad);
    ok(!w.p.ok && w.p.code === 'INVALID_INPUT' && !w.r.ok && w.nP === 0 && w.nR === 0,
      `SIGN CREATE ${feld} < 0: auf beiden Wegen abgewiesen, nichts geschrieben (${w.p.code || 'DURCHGELASSEN'} / ${w.r.code || 'DURCHGELASSEN'})`);
  }
  // Der einzige legitime „Überschuss" bleibt: eine Anzahlung über der Summe wird Guthaben — auf beiden Wegen.
  const over = await beideAnlegen({ ...NORMAL, depositAmount: 900 });
  const credit = (db: Db): number => n(db, "SELECT COALESCE(SUM(amount), 0) FROM customer_credits WHERE customer_id = 'cust-1'");
  ok(over.p.ok && over.r.ok && n(over.dbP, 'SELECT remaining_amount FROM orders') < 0 && credit(over.dbP) > 0 && credit(over.dbP) === credit(over.dbR),
    `SIGN eine Anzahlung ueber der Summe bleibt erlaubt und wird Guthaben (${credit(over.dbP)} / ${credit(over.dbR)})`);
  for (const feld of ['agreedPrice', 'depositAmount', 'supplierPrice']) {
    const a = await editWelt('primary', 'pending', { [feld]: -1 });
    const b = await editWelt('fern', 'pending', { [feld]: -1 });
    ok(a.aus.code === 'INVALID_AMOUNT' && !b.aus.ok && a.unveraendert && b.unveraendert,
      `SIGN EDIT ${feld} < 0: auf beiden Wegen abgewiesen, der Auftrag unveraendert (${a.aus.code || 'DURCHGELASSEN'} / ${b.aus.code || 'DURCHGELASSEN'})`);
  }
}

// ── §2 Abgeschlossen / storniert: kein „Edit" mehr ───────────────────────
{
  for (const st of ['pending', 'arrived', 'notified']) {
    const a = await editWelt('primary', st, { notes: 'geaendert' });
    const b = await editWelt('fern', st, { notes: 'geaendert' });
    ok(a.aus.ok && b.aus.ok && !a.unveraendert && !b.unveraendert, `TERMINAL ${st}: der laufende Auftrag wird auf beiden Wegen geaendert (${a.aus.code || 'ok'} / ${b.aus.code || 'ok'})`);
  }
  for (const st of ['completed', 'cancelled']) {
    const a = await editWelt('primary', st, { notes: 'geaendert', agreedPrice: 1 });
    const b = await editWelt('fern', st, { notes: 'geaendert', agreedPrice: 1 });
    ok(a.aus.code === 'ORDER_NOT_EDITABLE' && b.aus.code === 'ORDER_NOT_EDITABLE' && a.unveraendert && b.unveraendert,
      `TERMINAL ${st}: auf beiden Wegen ORDER_NOT_EDITABLE, nichts geaendert (${a.aus.code || 'ok'} / ${b.aus.code || 'ok'})`);
  }
  const od = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  ok(/!isCancelled && !isCompleted && perm\.canManageOrders && \(\s*<Button[^>]*onClick=\{\(\) => setEditing\(true\)\}/.test(od)
    && (od.match(/setEditing\(true\)/g) ?? []).length === 1,
  'TERMINAL die Maske bietet „Edit" — ihren einzigen Einstieg — nur fuer den laufenden Auftrag (wie vor R5E)');
  ok((codeOf(src('src/core/orders/order-house.ts')).match(/ORDER_NOT_EDITABLE/g) ?? []).length === 1
    && !/ORDER_NOT_EDITABLE|NOT_EDITABLE/.test(codeOf(src('src/stores/orderStore.ts'))),
  'TERMINAL die Sperre sitzt nur am Aendern-Weg — Status, Zahlung, Umwandlung und Zeilen behalten ihre eigenen Regeln');
}

// ── §3 Die Gold-Verbindlichkeit ─────────────────────────────────────────────
{
  const lines = (db: Db, oid: string) => rows(db,
    'SELECT id, material_kind, supplier_id, cost_amount, description, expense_id FROM order_lines WHERE order_id = ? ORDER BY position', [oid]);
  const dbA = freshDb();
  const made = await orderHouse.createOrderOnPrimary(CUSTOM);
  const oid = made.order.id;
  const eg = lines(dbA, oid).find((z) => z.material_kind === 'gold')!;
  const labor = lines(dbA, oid).find((z) => z.material_kind === 'labor')!;
  const gp = rows(dbA, 'SELECT * FROM gold_payables WHERE source_order_id = ?', [oid]);
  ok(gp.length === 1 && gp[0].id === made.goldPayableId, 'GOLD genau eine Verbindlichkeit je Auftrag — die, die der Anlegeweg meldet');
  ok(String(eg.description).startsWith('Extra Gold 5.000g 22K') && gp[0].source_order_line_id === eg.id,
    'GOLD sie entsteht aus der Extra-Gold-Zeile und haengt an ihr (source_order_line_id)');
  ok(Number(gp[0].weight_grams) === 5 && gp[0].karat === '22K', 'GOLD Gramm und Karat sind die Extra-Gold-Eingaben der Maske');
  ok(gp[0].supplier_id === 'sup-gold' && gp[0].direction === 'we_owe' && gp[0].settlement_type === 'return_gold' && gp[0].status === 'OPEN',
    `GOLD Glaeubiger ist der Goldschmied des Extra-Golds; wir schulden Gold, offen (${S([gp[0].supplier_id, gp[0].direction, gp[0].settlement_type, gp[0].status])})`);
  ok(eg.supplier_id === null && labor.supplier_id === 'sup-1', 'GOLD die Extra-Gold-Zeile traegt keinen Lieferanten, die Arbeitszeile ihren');
  useOrderStore.getState().commitOrderLineExpenses(oid);
  const gebucht = lines(dbA, oid);
  ok(gebucht.find((z) => z.id === eg.id)!.expense_id === null && gebucht.find((z) => z.id === labor.id)!.expense_id !== null
    && gebucht.filter((z) => z.expense_id !== null).every((z) => z.supplier_id !== null),
  'GOLD die Geld-A/P bucht nur Zeilen mit Lieferant — fuer das Extra-Gold entsteht keine zweite Geldschuld');
  ok(n(dbA, "SELECT COUNT(*) FROM expenses WHERE related_module = 'gold_payable'") === 0, 'GOLD …und keine Gold-Ausgabe, solange nicht beglichen');
  useGoldStore.getState().loadGoldPayables();
  ok(useGoldStore.getState().goldPayables.filter((g) => g.sourceOrderId === oid).map((g) => g.id).join() === made.goldPayableId,
    'GOLD die Auftragsseite findet sie (sourceOrderId)');
  ok(useGoldStore.getState().getGoldPayablesBySupplier('sup-gold').some((g) => g.id === made.goldPayableId), 'GOLD die Lieferantenseite findet sie');
  useGoldStore.getState().settleGoldReturn(made.goldPayableId!, 5);
  ok(s(dbA, 'SELECT status FROM gold_payables WHERE id = ?', [made.goldPayableId]) === 'FULFILLED', 'GOLD in Gold beglichen');

  const dbB = freshDb();
  const r = await fern(async () => cmd.runOrderCreate(deps(dbB), identity(nextId(), 'orders.create'), await orderRules.orderCreateBody(CUSTOM, stage)));
  const oidB = String(r.value?.orderId ?? '');
  const gpB = s(dbB, 'SELECT id FROM gold_payables WHERE source_order_id = ?', [oidB]);
  ok(r.ok && gpB !== '' && String(r.value?.goldPayableId) === gpB, 'GOLD fern angelegt: dieselbe Verbindlichkeit, gemeldet');
  useGoldStore.getState().loadGoldPayables();
  useGoldStore.getState().convertGoldPayableToMoney(gpB, 300, 'bank');
  ok(n(dbB, "SELECT COUNT(*) FROM expenses WHERE related_module = 'gold_payable' AND supplier_id = 'sup-gold'") === 1
    && s(dbB, 'SELECT status FROM gold_payables WHERE id = ?', [gpB]) === 'FULFILLED',
  'GOLD in Geld beglichen: EINE Geldschuld an den Goldschmied — erst jetzt');

  const dbC = freshDb();
  const madeC = await orderHouse.createOrderOnPrimary({ ...CUSTOM, status: 'pending' });
  useOrderStore.getState().deleteOrderLine(s(dbC, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'gold'", [madeC.order.id]));
  ok(n(dbC, 'SELECT COUNT(*) FROM gold_payables WHERE source_order_id = ?', [madeC.order.id]) === 0, 'GOLD eine offene Verbindlichkeit geht mit ihrer Zeile');

  const ohneLief = await beideAnlegen({ ...CUSTOM, extraGoldSupplierId: '' });
  ok(ohneLief.p.ok && ohneLief.r.ok && n(ohneLief.dbP, 'SELECT COUNT(*) FROM gold_payables') === 0 && n(ohneLief.dbR, 'SELECT COUNT(*) FROM gold_payables') === 0,
    'GOLD ohne Goldschmied am Extra-Gold keine Verbindlichkeit (wie vor R5E)');
}

// ── §4 Der Test-Delta: was offen wurde, was geschlossen bleibt ─────────────
{
  const cd = src('test/bridge/commercial-documents.test.ts');
  ok(!/\.skip\(|\bxit\(|if \(false\)/.test(codeOf(cd)), 'DELTA kein uebersprungener Fall');
  for (const label of ['eine Summe', 'einen Rest', 'eine Marge', 'einen Typ', 'ein Material an der Position', 'eine Rechnung',
    'einen Stornostatus', 'eine Gold-Verbindlichkeit', 'eine Steuer', 'einen Goldwert am Kopf', 'einen Einstand an der Spec',
    'einen Bestand am neuen Produkt', 'einen Status', 'einen bezahlten Betrag', 'eine Vorsteuer', 'einen Einstand am neuen Artikel',
    'einen Bestand am neuen Artikel', 'Fotos als Bytes', 'eine Losnummer']) {
    ok(cd.includes(`['${label}'`), `DELTA die Absage „${label}" steht`);
  }
  const body = await orderRules.orderCreateBody(NORMAL, stage);
  for (const [k, v] of [['agreedPrice', 1], ['remainingAmount', 0], ['expectedMargin', 1], ['taxAmount', 1], ['extraGoldValue', 1],
    ['goldPayable', {}], ['invoiceId', 'x'], ['type', 'custom'], ['status', 'cancelled'], ['depositPaid', true]] as Array<[string, unknown]>) {
    let threw = false;
    try { cmd.parseOrderCreate({ ...body, [k]: v }); } catch { threw = true; }
    ok(threw, `DELTA orders.create: der Rumpf setzt ${k} nicht`);
  }
  const dbF = freshDb();
  const fo = await fern(() => cmd.runOrderCreate(deps(dbF), fremd(nextId(), 'orders.create'), body));
  ok(fo.code === 'BRANCH_MISMATCH' && n(dbF, 'SELECT COUNT(*) FROM orders') === 0, `DELTA die Filialpruefung bleibt (${fo.code})`);
}

// ── §5 „+ New Supplier" im Einkauf: eine NEUE Fern-Schreiblücke ───────────
{
  ok(!ALLOWED_MUTATIONS.includes('suppliers.create') && ALLOWED_MUTATIONS.length === 41, 'GAP es gibt keine Buchung suppliers.create — und keine weitere ausser invoices.cancel (41)');
  const rust = src('src-tauri/src/bridge.rs');
  const rustOps = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].length;
  ok(!/suppliers\.create/.test(rust) && rustOps === 108, `GAP die Registry kennt sie nicht und steht bei 108 (R5F.1: invoices.cancel) (${rustOps})`);
  const stand = [R4C_MATRIX.filter((z) => z.verdrahtet).length, R4C_MATRIX.filter((z) => z.paritaet === 'exakt' && !z.verdrahtet).length,
    R4C_MATRIX.filter((z) => z.luecke === 'B').length, R4C_MATRIX.filter((z) => z.paritaet === 'keine-ui').length];
  // R5F schliesst weitere Zeilen — die Matrix bleibt bei 40, ohne offene „exakt"-Zeile und ohne Lieferanten.
  ok(!R4C_MATRIX.some((z) => z.op.startsWith('suppliers.')) && stand[0] >= 33 && stand[1] === 0 && stand[3] >= 2
    && stand[0] + stand[1] + stand[2] + stand[3] === 40,
  `GAP die Matrix zaehlt sie nicht mit (${stand.join('/')})`);
  const pc = codeOf(src('src/pages/purchases/PurchaseCreate.tsx'));
  ok(/function handleCreateSupplier\(\)[\s\S]{0,300}createSupplier\(newSupplierForm\)/.test(pc) && !/'suppliers\./.test(pc),
    'GAP „+ New Supplier" legt am Primary lokal an — einen Fernweg gibt es nicht');
  const doc = src('docs/central-ui-parity.md');
  ok(doc.includes('CENTRAL_UI_R5E_NEW_SUPPLIER_WRITE_GAP_RECORDED') && doc.includes('+ New Supplier') && doc.includes('suppliers.create'),
    'GAP die Luecke steht im Dokument');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r5e final contract pins: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5E_ORDER_AMOUNT_SIGN_CONTRACT_PINNED');
console.log('CENTRAL_UI_R5E_ORDER_TERMINAL_EDIT_CONTRACT_PINNED');
console.log('CENTRAL_UI_R5E_GOLD_LIABILITY_CONTRACT_PINNED');
console.log('CENTRAL_UI_R5E_TEST_DELTA_AUDITED');
console.log('CENTRAL_UI_R5E_NEW_SUPPLIER_WRITE_GAP_RECORDED');
