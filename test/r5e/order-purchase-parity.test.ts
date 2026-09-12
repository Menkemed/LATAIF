// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — Auftrag anlegen, Auftrag ändern, Einkauf anlegen: dieselbe Wirkung.
// Run: node test/r5e/order-purchase-parity.test.ts
//
// Bewiesen an echten Zeilen einer echten sql.js-Datenbank, jeweils in ZWEI gleich gesäten Welten —
// einmal über den Anschluss der Maske am Primary (`order-house`, `purchase-house`), einmal über den
// Fernbefehl mit genau dem Rumpf, den dieselbe Maske am zweiten Rechner baut:
//
//   §2 Auftrag anlegen: normal (bestehende + NEUE Artikel mit Foto), Sonderanfertigung (Angebot mit
//      Steuerwahl, Spec mit Foto, Kundenmaterial, Goldschmied, Extra-Gold samt Gold-Verbindlichkeit,
//      Diamanten), gemischt, voll bezahlt — Kopf, Zeilen, Artikel, Zahlung, Buchung, Verbindlichkeit.
//   §3 Auftrag ändern: Marge und Rest leitet das Haus ab; beim Sonderauftrag die Angebotszeile.
//   §4 Einkauf anlegen: bestehender + neuer Artikel, Lose, Menge, Mitarbeiter, Zahlung, Vorsteuer,
//      Wareneingang eines Auftrags, Inbox-Foto.
//   §6/§7 Atomar: Fehler nach dem Auftrag, nach den Zeilen, nach Buchung/Verbindlichkeit; nach dem
//      neuen Artikel, nach dem Beleg, nach dem Los, vor der Menge, vor der Auftragsverknüpfung.
//   §9 Autorität: fremde Filiale/Kunde/Artikel/Lieferant/Mitarbeiter/Auftrag, nichts Abgeleitetes.
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

/** Was ein Auftrag im Haus hinterlässt — ohne Kennungen und Zeitpunkte; neue Artikel als „NEU". */
function bildDesAuftrags(db: Db, oid: string) {
  const zeilen = rows(db, 'SELECT * FROM order_lines WHERE order_id = ? ORDER BY position', [oid]);
  const lineIds = zeilen.map((z) => String(z.id));
  const neu = zeilen.filter((z) => z.product_id && !SEED_PRODUCTS.includes(String(z.product_id))).map((z) => String(z.product_id));
  return {
    kopf: ohne(row(db, 'SELECT * FROM orders WHERE id = ?', [oid]), ['existing_product_id']),
    zeilen: zeilen.map((z) => ({ ...ohne(z, ['order_id', 'expense_id']), product_id: pid(z.product_id) })),
    neueArtikel: neu.map((id) => ohne(row(db, 'SELECT * FROM products WHERE id = ?', [id]))),
    zahlungen: rows(db, 'SELECT amount, paid_at, method, card_brand, note FROM order_payments WHERE order_id = ? ORDER BY created_at', [oid]),
    gold: rows(db, 'SELECT * FROM gold_payables WHERE source_order_id = ?', [oid])
      .map((g) => ({ ...ohne(g, ['source_order_id', 'source_order_line_id']), zeile: lineIds.indexOf(String(g.source_order_line_id)) })),
    ausgaben: S(db.exec("SELECT category, status, ROUND(amount, 3) FROM expenses WHERE related_module = 'order' ORDER BY category, amount")[0]?.values ?? []),
    buchungen: buchungen(db),
  };
}

// ── §1 Der Umfang ───────────────────────────────────────────────────────────
{
  const vorher = ['returns.create', 'returns.approve', 'returns.refund', 'purchases.create',
    'consignments.record_sale', 'consignments.record_payout', 'orders.create', 'orders.update'];
  const drei = ['orders.create', 'orders.update', 'purchases.create'];
  for (const op of drei) {
    const z = R4C_MATRIX.find((x) => x.op === op);
    ok(!!z && z.paritaet === 'exakt' && z.verdrahtet && z.luecke === null, `SCOPE ${op} ist geschlossen`);
    ok(ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist eine VORHANDENE Buchung`);
  }
  // R5F schliesst weitere Zeilen — gepinnt wird, dass keine der drei zurueckfaellt und nur aus dem
  // R5E-Rest weiter geschlossen wird.
  const nochB = R4C_MATRIX.filter((z) => z.luecke === 'B').map((z) => z.op).sort();
  const restR5E = vorher.filter((op) => !drei.includes(op));
  ok(nochB.every((op) => restR5E.includes(op)), `SCOPE die uebrigen Klasse-B-Zeilen stammen aus dem R5E-Rest (${nochB.join(', ')})`);
  ok(ALLOWED_MUTATIONS.length === 41, `SCOPE nur die freigegebene neue Buchung invoices.cancel (${ALLOWED_MUTATIONS.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  const rustOps = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].length;
  ok(rustOps === 108, `SCOPE die Registry steht bei 108 (R5F.1: invoices.cancel) (${rustOps})`);
  const stand = [R4C_MATRIX.filter((z) => z.verdrahtet).length, R4C_MATRIX.filter((z) => z.paritaet === 'exakt' && !z.verdrahtet).length,
    R4C_MATRIX.filter((z) => z.luecke === 'B').length, R4C_MATRIX.filter((z) => z.paritaet === 'keine-ui').length];
  ok(stand[0] >= 33 && stand[1] === 0 && stand[3] >= 2 && stand[0] + stand[2] + stand[3] === 40,
    `SCOPE die Matrix faellt nicht hinter 33/0/5/2 zurueck (${stand.join('/')})`);
  for (const op of ['orders.add_payment', 'orders.convert_to_invoice', 'products.create', 'orders.update_status']) {
    ok(!!R4C_MATRIX.find((x) => x.op === op)?.verdrahtet, `SCOPE Nachbar ${op} bleibt verdrahtet`);
  }
}

// ── §2 Auftrag anlegen: dieselbe Wirkung auf beiden Wegen ─────────────────
type OI = import('../../src/core/orders/order-create.ts').OrderCreateInput;
const LEER: OI = {
  customerId: 'cust-1', orderType: 'normal', lines: [], quotedPrice: 0, customTaxScheme: 'MARGIN', finalProductDescription: '',
  customProductSpec: undefined, customerGoldGrams: 0, customerGoldKarat: '22K', customerStones: '', goldsmithSupplierId: '',
  laborCost: 0, extraGoldGrams: 0, extraGoldKarat: '22K', extraGoldCost: 0, extraGoldSupplierId: '', materials: [],
  depositAmount: 0, paymentMethod: 'cash', cardBrand: 'normal', fullyPaid: false, expectedDelivery: '', status: 'pending', notes: '',
};
const SPEC = (seed: number) => ({
  categoryId: 'cat-w', brand: 'Omega', name: 'Speedmaster ' + seed, sku: '', condition: 'New', taxScheme: 'VAT_10',
  scopeOfDelivery: ['Box'], purchaseCurrency: 'BHD', attributes: {}, images: [foto(seed)],
});
const FAELLE: Array<[string, OI]> = [
  ['normal, bestehend + neu, Karte Amex, „arrived"', {
    ...LEER,
    lines: [
      { mode: 'existing', productId: 'p1', description: 'Rolex M p1', scheme: 'auto', quantity: 2, unitPrice: 200 },
      { mode: 'existing', productId: 'p2', description: 'Rolex M p2', scheme: 'ZERO', quantity: 1, unitPrice: 300 },
      { mode: 'new', newProduct: SPEC(1), description: 'Omega Speedmaster 1', scheme: 'auto', quantity: 1, unitPrice: 500 },
    ],
    depositAmount: 250, paymentMethod: 'card', cardBrand: 'amex', status: 'arrived', expectedDelivery: '2026-10-01', notes: 'normal',
  }],
  ['Sonderanfertigung mit Gold, Goldschmied, Diamant, Spec mit Foto', {
    ...LEER, orderType: 'custom',
    lines: [{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }],
    quotedPrice: 1100, customTaxScheme: 'VAT_10', finalProductDescription: '', customProductSpec: SPEC(2),
    customerGoldGrams: 12.5, customerGoldKarat: '21K', customerStones: '2x 0.5ct',
    goldsmithSupplierId: 'sup-1', laborCost: 80,
    extraGoldGrams: 5, extraGoldKarat: '22K', extraGoldCost: 120, extraGoldSupplierId: 'sup-gold',
    materials: [{ materialKind: 'diamond', description: 'Round Brilliant', quantity: 2, caratPerPiece: 0.5, totalCost: 400, supplierId: 'sup-1' }],
    depositAmount: 300, paymentMethod: 'bank', notes: 'custom',
  }],
  ['gemischt, Produkt + Angebot (Margin), voll bezahlt', {
    ...LEER, orderType: 'mixed',
    lines: [{ mode: 'existing', productId: 'p3', description: 'Rolex M p3', scheme: 'auto', quantity: 1, unitPrice: 250 }],
    quotedPrice: 600, customTaxScheme: 'MARGIN', finalProductDescription: 'Ring', customProductSpec: { ...SPEC(3), images: [] },
    fullyPaid: true, paymentMethod: 'cash', status: 'pending',
  }],
];
let nth = 100;
for (const [was, input] of FAELLE) {
  let db = freshDb();
  const p = await primary(() => orderHouse.createOrderOnPrimary(input));
  const oidP = String((p.value as { order?: { id: string } })?.order?.id ?? '');
  const bildP = oidP ? bildDesAuftrags(db, oidP) : null;
  db = freshDb();
  const body = await orderRules.orderCreateBody(input, stage);
  ok(!S(body).includes('base64'), `CREATE ${was}: der Rumpf traegt keine Bildbytes`);
  const ident = identity(String(nth++), 'orders.create');
  const r = await fern(() => cmd.runOrderCreate(deps(db), ident, body));
  const oidR = String(r.value?.orderId ?? '');
  const bildR = oidR ? bildDesAuftrags(db, oidR) : null;
  ok(p.ok && r.ok, `CREATE ${was}: beide Wege legen an (${p.code || 'ok'} / ${r.code || 'ok'})`);
  if (!bildP || !bildR) continue;
  const diff = [
    ...unterschiede(bildP.kopf, bildR.kopf, 'Kopf'), ...unterschiede(bildP.zeilen, bildR.zeilen, 'Zeilen'),
    ...unterschiede(bildP.neueArtikel, bildR.neueArtikel, 'Artikel'), ...unterschiede(bildP.zahlungen, bildR.zahlungen, 'Zahlung'),
    ...unterschiede(bildP.gold, bildR.gold, 'Gold'), ...unterschiede(bildP.ausgaben, bildR.ausgaben, 'Ausgaben'),
    ...unterschiede(bildP.buchungen, bildR.buchungen, 'Buchungen'),
  ];
  ok(diff.length === 0, `CREATE ${was}: lokal == fern (${diff.join(' · ') || 'gleich'})`);
  // Die Wiederholung derselben Kennung: dieselbe Antwort, kein zweiter Auftrag, keine zweite Wirkung.
  const vor = S([n(db, 'SELECT COUNT(*) FROM orders'), n(db, 'SELECT COUNT(*) FROM products'), n(db, 'SELECT COUNT(*) FROM gold_payables'), buchungen(db)]);
  const again = await fern(() => cmd.runOrderCreate(deps(db), ident, body));
  ok(again.ok && again.replayed === true && String(again.value?.orderId) === oidR, `CREATE ${was}: die Wiederholung ist eine Wiederholung`);
  ok(S([n(db, 'SELECT COUNT(*) FROM orders'), n(db, 'SELECT COUNT(*) FROM products'), n(db, 'SELECT COUNT(*) FROM gold_payables'), buchungen(db)]) === vor,
    `CREATE ${was}: …ohne zweiten Auftrag, Artikel, Verbindlichkeit oder Buchung`);
  const k = bildR.kopf;
  if (input.orderType === 'normal') {
    ok(k.type === 'normal' && Number(k.agreed_price) === 1200 && Math.abs(Number(k.tax_amount) - 90) < 0.005,
      `CREATE normal: Summe 2×200+300+500 und sichtbare Steuer 10 % auf die VAT-Zeilen (${S([k.agreed_price, k.tax_amount])})`);
    ok(bildR.zeilen.map((z) => z.tax_scheme).join(',') === 'VAT_10,ZERO,VAT_10', `CREATE normal: Schema je Zeile, Auto = das des Artikels (${bildR.zeilen.map((z) => z.tax_scheme).join(',')})`);
    ok(k.status === 'arrived' && bildR.zeilen.every((z) => z.status === 'ARRIVED'), 'CREATE normal: Anfangsstatus wie gewaehlt, Zeilen folgen');
    ok(bildR.neueArtikel.length === 1 && bildR.neueArtikel[0].quantity === 0 && S(JSON.parse(String(bildR.neueArtikel[0].images))) === S([foto(1)]),
      'CREATE normal: der neue Artikel entsteht mit Foto, ohne Bestand (Menge 0 bis zum Wareneingang)');
    ok(bildR.zahlungen.length === 1 && bildR.zahlungen[0].card_brand === 'amex' && Number(bildR.zahlungen[0].amount) === 250,
      'CREATE normal: die Anzahlung mit Kartenart');
    ok(/CardFee|card/i.test(bildR.ausgaben), `CREATE normal: die Kartengebuehr ist gebucht (${bildR.ausgaben})`);
  } else if (input.orderType === 'custom') {
    ok(k.type === 'custom' && Number(k.agreed_price) === 1100 && Math.abs(Number(k.tax_amount) - 100) < 0.005,
      `CREATE custom: Summe = Angebot brutto, Steuer = Anteil 10 % darin (${S([k.agreed_price, k.tax_amount])})`);
    ok(bildR.zeilen.map((z) => z.material_kind).join(',') === 'custom,labor,gold,diamond',
      `CREATE custom: Angebots-, Arbeits-, Gold- und Diamantzeile (${bildR.zeilen.map((z) => z.material_kind).join(',')})`);
    const gold = bildR.zeilen[2];
    ok(gold.supplier_id === null && Number(gold.cost_amount) === 120 && String(gold.description).startsWith('Extra Gold 5.000g 22K — Lieferant sup-gold'),
      'CREATE custom: die Extra-Gold-Zeile traegt KEINEN Lieferanten (die Schuld lebt in Gramm)');
    ok(bildR.gold.length === 1 && Number(bildR.gold[0].weight_grams) === 5 && bildR.gold[0].karat === '22K'
      && bildR.gold[0].supplier_id === 'sup-gold' && bildR.gold[0].zeile === 2 && bildR.gold[0].status === 'OPEN',
    `CREATE custom: die Gold-Verbindlichkeit beim Goldschmied, verknuepft mit der Extra-Gold-Zeile (${S(bildR.gold)})`);
    const meta = JSON.parse(String(k.custom_meta)) as Record<string, unknown>;
    ok(meta.customerGoldWeight === 12.5 && meta.customerGoldKarat === '21K' && meta.customerStones === '2x 0.5ct'
      && Array.isArray(meta.diamondDetails) && (meta.diamondDetails as unknown[]).length === 1, 'CREATE custom: das Kundenmaterial und die Diamanten stehen im Auftrag');
    const spec = JSON.parse(String(k.custom_product_spec)) as Record<string, unknown>;
    ok(S(spec.images) === S([foto(2)]) && spec.categoryId === 'cat-w', 'CREATE custom: die Spec des fertigen Stuecks mit Foto');
    ok(k.goldsmith_supplier_id === 'sup-1' && Number(k.labor_cost) === 80 && Number(k.extra_gold_value) === 120, 'CREATE custom: Goldschmied und Kosten am Kopf');
  } else {
    ok(k.type === 'mixed' && Number(k.agreed_price) === 850 && Number(k.fully_paid) === 1 && Number(k.deposit_amount) === 850,
      `CREATE mixed: Produkt + Angebot, voll bezahlt (${S([k.agreed_price, k.deposit_amount])})`);
  }
}

// ── §3 Auftrag ändern: Marge und Rest rechnet das Haus ─────────────────────
async function aenderWelt(weg: 'primary' | 'fern', custom: boolean, form: Record<string, unknown>) {
  const db = freshDb();
  const made = await orderHouse.createOrderOnPrimary(custom ? FAELLE[1][1] : {
    ...LEER, lines: [{ mode: 'existing', productId: 'p1', description: 'x', scheme: 'auto', quantity: 1, unitPrice: 600 }],
    depositAmount: 100, paymentMethod: 'cash',
  });
  const oid = made.order.id;
  useOrderStore.getState().loadOrders();
  const order = useOrderStore.getState().orders.find((o) => o.id === oid)!;
  const f = { ...order, ...form };
  const aus = weg === 'primary'
    ? await primary(() => orderHouse.updateOrderOnPrimary(oid, f))
    : await fern(() => cmd.runOrderUpdate(deps(db), identity('300', 'orders.update'), orderEdit.orderEditBody(oid, orev(db, oid), f)));
  return {
    db, oid, aus,
    kopf: ohne(row(db, 'SELECT * FROM orders WHERE id = ?', [oid])),
    zeilen: rows(db, 'SELECT position, unit_price, line_total, material_kind FROM order_lines WHERE order_id = ? ORDER BY position', [oid]),
  };
}
{
  const form = { agreedPrice: 700, depositAmount: 150, supplierName: 'Dealer', supplierPrice: 420, expectedDelivery: '2026-11-11', notes: 'geaendert' };
  const a = await aenderWelt('primary', false, form);
  const b = await aenderWelt('fern', false, form);
  ok(a.aus.ok && b.aus.ok, `EDIT normal: beide Wege speichern (${a.aus.code || 'ok'} / ${b.aus.code || 'ok'})`);
  ok(S(a.kopf) === S(b.kopf), `EDIT normal: lokal == fern (${unterschiede(a.kopf, b.kopf, 'Kopf').join(' ') || 'gleich'})`);
  ok(Number(b.kopf.expected_margin) === 280 && Number(b.kopf.remaining_amount) === 550 && Number(b.kopf.agreed_price) === 700,
    `EDIT normal: Marge 700 − 420 und Rest 700 − 150 vom Haus (${S([b.kopf.expected_margin, b.kopf.remaining_amount])})`);
  // Ein geleertes Einkaufsfeld heisst „keins" — die Marge verschwindet, auf beiden Wegen.
  const c = await aenderWelt('primary', false, { ...form, supplierPrice: undefined });
  const d = await aenderWelt('fern', false, { ...form, supplierPrice: undefined });
  ok(c.kopf.supplier_price === null && d.kopf.supplier_price === null && c.kopf.expected_margin === null && d.kopf.expected_margin === null,
    'EDIT ein geleertes Feld ist „keins" — auf beiden Wegen, ohne Marge');
  // Der Sonderauftrag: der Preis zieht die ANGEBOTSZEILE, der Kopf folgt aus den Zeilen.
  const e = await aenderWelt('primary', true, { agreedPrice: 1300 });
  const g = await aenderWelt('fern', true, { agreedPrice: 1300 });
  ok(e.aus.ok && g.aus.ok, `EDIT custom: beide Wege speichern (${e.aus.code || 'ok'} / ${g.aus.code || 'ok'})`);
  ok(S(e.kopf) === S(g.kopf) && S(e.zeilen) === S(g.zeilen), 'EDIT custom: lokal == fern (Kopf und Zeilen)');
  ok(Number(g.zeilen[0].unit_price) === 1300 && Number(g.kopf.agreed_price) === 1300,
    `EDIT custom: die Angebotszeile traegt den neuen Preis, der Kopf folgt (${S([g.zeilen[0].unit_price, g.kopf.agreed_price])})`);
  // Die Regeln.
  const neg = await aenderWelt('primary', false, { ...form, depositAmount: -5 });
  let negFern = '';
  try { cmd.parseOrderUpdate({ id: 'o', expectedRevision: 1, depositAmount: -5 }); } catch (err) { negFern = String(err); }
  ok(neg.aus.code === 'INVALID_AMOUNT' && negFern !== '', `EDIT ein negativer Betrag wird auf beiden Wegen abgewiesen (${neg.aus.code})`);
  for (const f of ['expectedMargin', 'remainingAmount', 'type', 'status', 'orderNumber', 'lines', 'goldsmithSupplierId']) {
    let threw = false;
    try { cmd.parseOrderUpdate({ id: 'o1', expectedRevision: 1, [f]: 1 }); } catch { threw = true; }
    ok(threw, `EDIT der Rumpf setzt ${f} nicht`);
  }
  {
    const w = await aenderWelt('fern', false, form);
    w.db.run("UPDATE orders SET status = 'completed' WHERE id = ?", [w.oid]);
    const done = await fern(() => cmd.runOrderUpdate(deps(w.db), identity('310', 'orders.update'), orderEdit.orderEditBody(w.oid, orev(w.db, w.oid), { notes: 'x' })));
    const doneP = await primary(() => orderHouse.updateOrderOnPrimary(w.oid, { notes: 'x' }));
    ok(done.code === 'ORDER_NOT_EDITABLE' && doneP.code === 'ORDER_NOT_EDITABLE', `EDIT ein abgeschlossener Auftrag wird nicht mehr geaendert (${done.code} / ${doneP.code})`);
    const stale = await fern(() => cmd.runOrderUpdate(deps(w.db), identity('311', 'orders.update'), orderEdit.orderEditBody(w.oid, 1, { notes: 'x' })));
    ok(stale.code === 'RECORD_CHANGED', `EDIT eine alte Fassung traegt nicht (${stale.code})`);
  }
}

// ── §4 Einkauf anlegen ──────────────────────────────────────────────────────
type PI = import('../../src/core/purchases/purchase-create.ts').PurchaseCreateInput;
const EINKAUF: PI = {
  supplierId: 'sup-1', purchaseDate: '2026-09-12', taxScheme: 'VAT_10',
  lines: [
    { mode: 'existing', productId: 'p1', brand: 'Rolex', name: 'M p1', sku: 'SKU-p1', categoryId: 'cat-w', quantity: 2, unitPrice: 110 },
    { mode: 'new', newProduct: SPEC(7), brand: 'Omega', name: 'Speedmaster 7', sku: '', categoryId: 'cat-w', quantity: 3, unitPrice: 220 },
  ],
  paymentAmount: 300, paymentMethod: 'bank', notes: 'Lieferschein 7', staffId: 'emp-1',
};
function bildDesEinkaufs(db: Db, purId: string) {
  const zeilen = rows(db, 'SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [purId]);
  const neu = zeilen.map((z) => String(z.product_id)).filter((x) => !SEED_PRODUCTS.includes(x));
  return {
    kopf: ohne(row(db, 'SELECT * FROM purchases WHERE id = ?', [purId]), ['supplier_snapshot', 'source_order_id']),
    zeilen: zeilen.map((z) => ({ ...ohne(z, ['purchase_id', 'source_order_line_id']), product_id: pid(z.product_id) })),
    lose: rows(db, 'SELECT product_id, unit_cost, qty_total, qty_remaining, status FROM stock_lots WHERE purchase_id = ? ORDER BY unit_cost', [purId])
      .map((l) => ({ ...l, product_id: pid(l.product_id) })),
    neueArtikel: neu.map((id) => ohne(row(db, 'SELECT * FROM products WHERE id = ?', [id]))),
    p1: row(db, "SELECT quantity, stock_status FROM products WHERE id = 'p1'"),
    zahlungen: rows(db, 'SELECT amount, method FROM purchase_payments WHERE purchase_id = ?', [purId]),
    buchungen: buchungen(db),
  };
}
{
  let db = freshDb();
  const p = await primary(() => purchaseHouse.createPurchaseOnPrimary(EINKAUF));
  const bildP = bildDesEinkaufs(db, String(p.value?.id ?? ''));
  db = freshDb();
  const body = await purchaseRules.purchaseCreateBody(EINKAUF, stage);
  ok(!S(body).includes('base64'), 'PURCHASE der Rumpf traegt keine Bildbytes');
  const ident = identity('400', 'purchases.create');
  const r = await fern(() => cmd.runPurchaseCreate(deps(db), ident, body));
  const purId = String(r.value?.purchaseId ?? '');
  const bildR = bildDesEinkaufs(db, purId);
  ok(p.ok && r.ok, `PURCHASE beide Wege legen an (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const diff = [
    ...unterschiede(bildP.kopf, bildR.kopf, 'Kopf'), ...unterschiede(bildP.zeilen, bildR.zeilen, 'Zeilen'),
    ...unterschiede(bildP.lose, bildR.lose, 'Lose'), ...unterschiede(bildP.neueArtikel, bildR.neueArtikel, 'Artikel'),
    ...unterschiede(bildP.p1, bildR.p1, 'Bestand'), ...unterschiede(bildP.zahlungen, bildR.zahlungen, 'Zahlung'),
    ...unterschiede(bildP.buchungen, bildR.buchungen, 'Buchungen'),
  ];
  ok(diff.length === 0, `PURCHASE lokal == fern (${diff.join(' · ') || 'gleich'})`);
  ok(Number(bildR.kopf.total_amount) === 880 && bildR.kopf.staff_id === 'emp-1' && bildR.kopf.status === 'PARTIALLY_PAID',
    `PURCHASE Summe, Mitarbeiter und Status vom Haus (${S([bildR.kopf.total_amount, bildR.kopf.staff_id, bildR.kopf.status])})`);
  ok(Math.abs(bildR.zeilen.reduce((sum, z) => sum + Number(z.vat_amount), 0) - 80) < 0.005, 'PURCHASE die Vorsteuer aus dem Brutto (10/110)');
  ok(bildR.lose.length === 2 && bildR.lose.every((l) => l.qty_total === l.qty_remaining), 'PURCHASE ein Los je Zeile mit dem tatsaechlichen Einstand');
  ok(Number(bildR.p1.quantity) === 3, `PURCHASE der Bestand steigt genau einmal (1 + 2 = ${bildR.p1.quantity})`);
  ok(bildR.neueArtikel.length === 1 && Number(bildR.neueArtikel[0].quantity) === 3 && Number(bildR.neueArtikel[0].purchase_price) === 220
    && S(JSON.parse(String(bildR.neueArtikel[0].images))) === S([foto(7)]), 'PURCHASE der neue Artikel mit Foto, Menge und Einstand aus der Zeile');
  const vor = S([n(db, 'SELECT COUNT(*) FROM purchases'), n(db, 'SELECT COUNT(*) FROM products'), n(db, 'SELECT COUNT(*) FROM stock_lots'), bildR.p1]);
  const again = await fern(() => cmd.runPurchaseCreate(deps(db), ident, body));
  ok(again.ok && again.replayed === true && String(again.value?.purchaseId) === purId, 'PURCHASE die Wiederholung ist eine Wiederholung');
  ok(S([n(db, 'SELECT COUNT(*) FROM purchases'), n(db, 'SELECT COUNT(*) FROM products'), n(db, 'SELECT COUNT(*) FROM stock_lots'),
    row(db, "SELECT quantity, stock_status FROM products WHERE id = 'p1'")]) === vor, 'PURCHASE …ohne zweiten Beleg, Artikel, Los oder Bestand');
}
{
  // Wareneingang eines Auftrags + Inbox-Foto: dieselbe Wirkung auf beiden Wegen.
  const b2b = async (weg: 'primary' | 'fern') => {
    const db = freshDb();
    const made = await orderHouse.createOrderOnPrimary({
      ...LEER, lines: [{ mode: 'existing', productId: 'p2', description: 'x', scheme: 'auto', quantity: 1, unitPrice: 500 }],
    });
    const olid = s(db, 'SELECT id FROM order_lines WHERE order_id = ?', [made.order.id]);
    const input: PI = {
      ...EINKAUF, taxScheme: 'ZERO', paymentAmount: 0, staffId: '', sourceOrderId: made.order.id, inboxId: 'inbox-1',
      lines: [{ mode: 'existing', productId: 'p2', brand: '', name: '', sku: '', categoryId: 'cat-w', quantity: 1, unitPrice: 90, sourceOrderLineId: olid }],
    };
    const aus = weg === 'primary'
      ? await primary(() => purchaseHouse.createPurchaseOnPrimary(input))
      : await fern(async () => cmd.runPurchaseCreate(deps(db), identity('410', 'purchases.create'), await purchaseRules.purchaseCreateBody(input, stage)));
    return {
      aus,
      zeile: s(db, 'SELECT status FROM order_lines WHERE id = ?', [olid]),
      auftrag: s(db, 'SELECT status FROM orders WHERE id = ?', [made.order.id]),
      link: s(db, 'SELECT COUNT(*) FROM purchase_lines WHERE source_order_line_id = ?', [olid]),
      kopf: s(db, 'SELECT COUNT(*) FROM purchases WHERE source_order_id = ?', [made.order.id]),
      inbox: s(db, "SELECT status FROM purchase_inbox WHERE id = 'inbox-1'"),
    };
  };
  const a = await b2b('primary');
  const b = await b2b('fern');
  ok(a.aus.ok && b.aus.ok, `B2B beide Wege buchen den Wareneingang (${a.aus.code || 'ok'} / ${b.aus.code || 'ok'})`);
  ok(S({ ...a, aus: 0 }) === S({ ...b, aus: 0 }), `B2B lokal == fern (${S({ ...b, aus: 0 })})`);
  ok(b.zeile === 'ARRIVED' && b.link === '1' && b.kopf === '1' && b.inbox === 'done',
    'B2B die Auftragsposition ist angekommen, verknuepft, und das Inbox-Foto erledigt');
}

// ── §9 Autorität: das Haus entscheidet ───────────────────────────────────────
{
  const db = freshDb();
  const auftrag = async (x: string, input: OI) => {
    const r = await fern(async () => cmd.runOrderCreate(deps(db), identity(x, 'orders.create'), await orderRules.orderCreateBody(input, stage)));
    const p = await primary(() => orderHouse.createOrderOnPrimary(input));
    return [p.code, r.code];
  };
  const BASIS: OI = { ...LEER, lines: [{ mode: 'existing', productId: 'p1', description: 'x', scheme: 'auto', quantity: 1, unitPrice: 100 }] };
  const faelle: Array<[string, OI, string]> = [
    ['ein Kunde einer fremden Filiale', { ...BASIS, customerId: 'cust-x' }, 'CUSTOMER_NOT_FOUND'],
    ['ein Platzhalter-Kunde', { ...BASIS, customerId: 'sys-walkin' }, 'CUSTOMER_NOT_FOUND'],
    ['ein Artikel einer fremden Filiale', { ...BASIS, lines: [{ ...BASIS.lines[0], productId: 'p-foreign' }] }, 'PRODUCT_NOT_FOUND'],
    ['ein inaktiver Goldschmied', { ...BASIS, goldsmithSupplierId: 'sup-off' }, 'SUPPLIER_NOT_FOUND'],
    ['ein fremder Gold-Lieferant', { ...FAELLE[1][1], extraGoldSupplierId: 'sup-x' }, 'SUPPLIER_NOT_FOUND'],
    ['eine schon vergebene SKU am neuen Artikel', { ...BASIS, lines: [{ mode: 'new', newProduct: { ...SPEC(9), sku: 'SKU-p2' }, description: 'x', scheme: 'auto', quantity: 1, unitPrice: 1 }] }, 'SKU_TAKEN'],
    ['ein neuer Artikel ohne Pflichtfeld', { ...BASIS, lines: [{ mode: 'new', newProduct: { ...SPEC(9), brand: '' }, description: 'x', scheme: 'auto', quantity: 1, unitPrice: 1 }] }, 'PRODUCT_FIELDS_REQUIRED'],
    ['eine Sonderanfertigung ohne Angebot', { ...FAELLE[1][1], quotedPrice: 0 }, 'ORDER_INVALID'],
  ];
  let x = 500;
  for (const [was, input, erwartet] of faelle) {
    const [p, r] = await auftrag(String(x++), input);
    ok(p === erwartet && r === erwartet, `AUTH Auftrag, ${was}: ${erwartet} auf beiden Wegen (${p} / ${r})`);
  }
  ok(n(db, 'SELECT COUNT(*) FROM orders') === 0 && n(db, 'SELECT COUNT(*) FROM gold_payables') === 0, 'AUTH …und kein Auftrag, keine Verbindlichkeit');
  for (const [f, v] of [['agreedPrice', 1], ['taxAmount', 1], ['remainingAmount', 0], ['expectedMargin', 1], ['type', 'custom'],
    ['orderNumber', 'X'], ['goldPayable', {}], ['branchId', 'branch-other'], ['extraGoldValue', 1]] as Array<[string, unknown]>) {
    let threw = false;
    try { cmd.parseOrderCreate({ customerId: 'cust-1', lines: [], [f]: v }); } catch { threw = true; }
    ok(threw, `AUTH der Auftragsrumpf setzt ${f} nicht`);
  }
  for (const [was, patch] of [['Stornostatus', { status: 'cancelled' }], ['Zahlweg', { paymentMethod: 'crypto' }], ['Karat', { customerGoldKarat: '9K' }],
    ['negative Anzahlung', { depositAmount: -1 }], ['Einstand an der Spec', { customProductSpec: { brand: 'X', purchasePrice: 1 } }]] as Array<[string, Record<string, unknown>]>) {
    let threw = false;
    try { cmd.parseOrderCreate({ customerId: 'cust-1', lines: [], ...patch }); } catch { threw = true; }
    ok(threw, `AUTH der Auftragsrumpf nimmt ${was} nicht an`);
  }
  const br = await fern(async () => cmd.runOrderCreate(deps(db), fremd('590', 'orders.create'), await orderRules.orderCreateBody(BASIS, stage)));
  ok(br.code === 'BRANCH_MISMATCH', `AUTH Auftrag: ein Ausweis einer fremden Filiale (${br.code})`);

  // Einkauf.
  const einkauf = async (xx: string, input: PI) => {
    const r = await fern(async () => cmd.runPurchaseCreate(deps(db), identity(xx, 'purchases.create'), await purchaseRules.purchaseCreateBody(input, stage)));
    const p = await primary(() => purchaseHouse.createPurchaseOnPrimary(input));
    return [p.code, r.code];
  };
  const madeOther = await orderHouse.createOrderOnPrimary(BASIS);
  const otherLine = s(db, 'SELECT id FROM order_lines WHERE order_id = ?', [madeOther.order.id]);
  const madeMine = await orderHouse.createOrderOnPrimary(BASIS);
  const vorEinkauf = S([n(db, 'SELECT COUNT(*) FROM purchases'), n(db, 'SELECT COUNT(*) FROM stock_lots'), n(db, 'SELECT COUNT(*) FROM products')]);
  const pfaelle: Array<[string, PI, string]> = [
    ['ein fremder Lieferant', { ...EINKAUF, supplierId: 'sup-x' }, 'SUPPLIER_NOT_FOUND'],
    ['ein inaktiver Lieferant', { ...EINKAUF, supplierId: 'sup-off' }, 'SUPPLIER_NOT_FOUND'],
    ['ein fremder Mitarbeiter', { ...EINKAUF, staffId: 'emp-x' }, 'EMPLOYEE_NOT_FOUND'],
    ['ein ausgeschiedener Mitarbeiter', { ...EINKAUF, staffId: 'emp-gone' }, 'EMPLOYEE_NOT_FOUND'],
    ['ein fremder Auftrag', { ...EINKAUF, sourceOrderId: 'ord-gibt-es-nicht' }, 'ORDER_NOT_FOUND'],
    ['die Position eines ANDEREN Auftrags', { ...EINKAUF, sourceOrderId: madeMine.order.id, paymentAmount: 0,
      lines: [{ ...EINKAUF.lines[0], sourceOrderLineId: otherLine }] }, 'ORDER_LINE_NOT_ON_ORDER'],
    ['der Reparatur-Service', { ...EINKAUF, paymentAmount: 0, lines: [{ ...EINKAUF.lines[0], productId: 'p-svc' }] }, 'PRODUCT_NOT_FOUND'],
    ['ein Artikel einer fremden Filiale', { ...EINKAUF, paymentAmount: 0, lines: [{ ...EINKAUF.lines[0], productId: 'p-foreign' }] }, 'PRODUCT_NOT_FOUND'],
    ['ein fremdes Inbox-Foto', { ...EINKAUF, inboxId: 'inbox-x' }, 'INBOX_NOT_FOUND'],
    ['eine schon vergebene SKU', { ...EINKAUF, lines: [{ ...EINKAUF.lines[1], newProduct: { ...SPEC(8), sku: 'SKU-p1' } }] }, 'SKU_TAKEN'],
    ['eine Zahlung ueber der Summe', { ...EINKAUF, paymentAmount: 5000 }, 'PAYMENT_EXCEEDS_TOTAL'],
  ];
  let y = 600;
  for (const [was, input, erwartet] of pfaelle) {
    const [p, r] = await einkauf(String(y++), input);
    ok(p === erwartet && r === erwartet, `AUTH Einkauf, ${was}: ${erwartet} auf beiden Wegen (${p} / ${r})`);
  }
  ok(S([n(db, 'SELECT COUNT(*) FROM purchases'), n(db, 'SELECT COUNT(*) FROM stock_lots'), n(db, 'SELECT COUNT(*) FROM products')]) === vorEinkauf,
    'AUTH …kein Beleg, kein Los, kein Artikel');
  for (const [f, v] of [['purchaseNumber', 'P'], ['status', 'PAID'], ['totalAmount', 1], ['branchId', 'branch-other']] as Array<[string, unknown]>) {
    let threw = false;
    try { cmd.parsePurchaseCreate({ supplierId: 'sup-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 1 }], [f]: v }); } catch { threw = true; }
    ok(threw, `AUTH der Einkaufsrumpf setzt ${f} nicht`);
  }
  for (const [f, v] of [['lotId', 'l'], ['qtyRemaining', 1], ['stockStatus', 'in_stock'], ['vatAmount', 0]] as Array<[string, unknown]>) {
    let threw = false;
    try { cmd.parsePurchaseCreate({ supplierId: 'sup-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 1, [f]: v }] }); } catch { threw = true; }
    ok(threw, `AUTH eine Einkaufszeile setzt ${f} nicht`);
  }
  const pbr = await fern(async () => cmd.runPurchaseCreate(deps(db), fremd('690', 'purchases.create'), await purchaseRules.purchaseCreateBody(EINKAUF, stage)));
  ok(pbr.code === 'BRANCH_MISMATCH', `AUTH Einkauf: ein Ausweis einer fremden Filiale (${pbr.code})`);
}

// ── §6 Auftrag anlegen ist atomar ─────────────────────────────────────────────
async function bruch(
  weg: 'primary' | 'fern', x: string, brich: (db: Db) => () => void,
  lauf: (db: Db, id: ReturnType<typeof identity>) => Promise<Ausgang>, zaehle: (db: Db) => string,
) {
  const db = freshDb();
  const vor = zaehle(db);
  const heilen = brich(db);
  let aus: Ausgang;
  try { aus = await lauf(db, identity(x, 'x')); } finally { heilen(); }
  const nach = zaehle(db);
  const heil = await lauf(db, identity(x, 'x'));
  return { aus, gleich: vor === nach, heil, nach: zaehle(db), vor };
}
const auftragZaehler = (db: Db): string => S([n(db, 'SELECT COUNT(*) FROM orders'), n(db, 'SELECT COUNT(*) FROM order_lines'),
  n(db, 'SELECT COUNT(*) FROM order_payments'), n(db, 'SELECT COUNT(*) FROM products'), n(db, 'SELECT COUNT(*) FROM gold_payables'),
  n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM expenses')]);
const trigger = (sql: string) => (db: Db) => { db.run(sql); return () => { db.run('DROP TRIGGER IF EXISTS r5e_bruch'); }; };
const emitBruch = (name: string) => () => {
  const echt = eventBus.emit.bind(eventBus);
  (eventBus as { emit: unknown }).emit = (ev: string, ...rest: unknown[]) => {
    if (ev === name) throw new Error('R5E: failure after the insert');
    return (echt as (...a: unknown[]) => unknown)(ev, ...rest);
  };
  return () => { (eventBus as { emit: unknown }).emit = echt; };
};
{
  const CUSTOM = { ...FAELLE[1][1], lines: [...FAELLE[0][1].lines.slice(0, 1), { mode: 'new' as const, newProduct: SPEC(4), description: 'n', scheme: 'auto' as const, quantity: 1, unitPrice: 50 }], orderType: 'mixed' as const };
  const lauf = (weg: 'primary' | 'fern') => async (db: Db, id: ReturnType<typeof identity>) => (weg === 'primary'
    ? primary(() => orderHouse.createOrderOnPrimary(CUSTOM))
    : fern(async () => cmd.runOrderCreate(deps(db), { ...id, op: 'orders.create' }, await orderRules.orderCreateBody(CUSTOM, stage))));
  const punkte: Array<[string, (db: Db) => () => void]> = [
    ['nach dem Auftrag (Kopf, Zeilen, Anzahlung stehen)', emitBruch('order.created')],
    ['nach den Zeilen, vor der Anzahlung', trigger("CREATE TRIGGER r5e_bruch BEFORE INSERT ON order_payments BEGIN SELECT RAISE(ABORT, 'R5E: after lines'); END")],
    ['nach Buchung und Kartengebuehr, bei der Gold-Verbindlichkeit', trigger("CREATE TRIGGER r5e_bruch BEFORE INSERT ON gold_payables BEGIN SELECT RAISE(ABORT, 'R5E: at liability'); END")],
  ];
  let x = 700;
  for (const [was, brich] of punkte) {
    for (const weg of ['primary', 'fern'] as const) {
      const w = await bruch(weg, String(x++), brich, lauf(weg), auftragZaehler);
      ok(!w.aus.ok && w.gleich, `ATOMIC-ORDER ${weg} ${was}: nichts bleibt (${w.aus.code.slice(0, 50)})`);
      ok(w.heil.ok, `ATOMIC-ORDER ${weg} ${was}: danach gelingt es (${w.heil.code || 'ok'})`);
    }
  }
}

// ── §7 Einkauf anlegen ist atomar ────────────────────────────────────────────
{
  const mitAuftrag = async (db: Db): Promise<PI> => {
    const made = await orderHouse.createOrderOnPrimary({
      ...LEER, lines: [{ mode: 'existing', productId: 'p2', description: 'x', scheme: 'auto', quantity: 1, unitPrice: 500 }],
    });
    const olid = s(db, 'SELECT id FROM order_lines WHERE order_id = ?', [made.order.id]);
    return { ...EINKAUF, sourceOrderId: made.order.id, inboxId: 'inbox-1',
      lines: [{ ...EINKAUF.lines[0], sourceOrderLineId: olid }, EINKAUF.lines[1]] };
  };
  const zaehler = (db: Db): string => S([n(db, 'SELECT COUNT(*) FROM purchases'), n(db, 'SELECT COUNT(*) FROM purchase_lines'),
    n(db, 'SELECT COUNT(*) FROM stock_lots'), n(db, 'SELECT COUNT(*) FROM products'), s(db, "SELECT quantity FROM products WHERE id = 'p1'"),
    s(db, "SELECT GROUP_CONCAT(status) FROM order_lines"), s(db, "SELECT status FROM purchase_inbox WHERE id = 'inbox-1'"),
    n(db, 'SELECT COUNT(*) FROM ledger_entries')]);
  const punkte: Array<[string, string]> = [
    ['nach dem neuen Artikel, vor dem Beleg', 'BEFORE INSERT ON purchases'],
    ['nach dem Beleg, vor den Zeilen', 'BEFORE INSERT ON purchase_lines'],
    ['nach dem Los, vor der Menge', 'BEFORE UPDATE OF quantity ON products'],
    ['vor der Verknuepfung mit dem Auftrag', 'BEFORE UPDATE OF status ON order_lines'],
    ['beim Inbox-Foto', 'BEFORE UPDATE OF status ON purchase_inbox'],
  ];
  let x = 800;
  for (const [was, wann] of punkte) {
    for (const weg of ['primary', 'fern'] as const) {
      const db = freshDb();
      const input = await mitAuftrag(db);
      const vor = zaehler(db);
      db.run(`CREATE TRIGGER r5e_bruch ${wann} BEGIN SELECT RAISE(ABORT, 'R5E: purchase'); END`);
      const lauf = () => (weg === 'primary'
        ? primary(() => purchaseHouse.createPurchaseOnPrimary(input))
        : fern(async () => cmd.runPurchaseCreate(deps(db), identity(String(x), 'purchases.create'), await purchaseRules.purchaseCreateBody(input, stage))));
      const aus = await lauf();
      const nach = zaehler(db);
      db.run('DROP TRIGGER IF EXISTS r5e_bruch');
      const heil = await lauf();
      x++;
      ok(!aus.ok && vor === nach, `ATOMIC-PURCHASE ${weg} ${was}: kein verwaister Artikel, Beleg, Los, Bestand, Link (${aus.code.slice(0, 40)})`);
      ok(heil.ok && n(db, 'SELECT COUNT(*) FROM purchases') === 1, `ATOMIC-PURCHASE ${weg} ${was}: danach genau ein Einkauf (${heil.code || 'ok'})`);
    }
  }
}

// ── §5 Eine Domäne ─────────────────────────────────────────────────────────────
{
  const oc = codeOf(src('src/pages/orders/OrderCreate.tsx'));
  const od = codeOf(src('src/pages/orders/OrderDetail.tsx'));
  const pc = codeOf(src('src/pages/purchases/PurchaseCreate.tsx'));
  const cc = codeOf(src('src/core/bridge/commercial-commands.ts'));
  ok(!/\bcreateOrder\(|createGoldPayable\(|collectCustomLines|buildOrderPayload/.test(oc), 'DOMAIN die Anlegemaske baut keinen Auftrag und keine Verbindlichkeit mehr selbst');
  ok(/createOrderOnPrimary\(/.test(oc) && /orderCreateBody\(/.test(oc) && /validateOrderCreate\(/.test(oc), 'DOMAIN …sie ruft die geteilte Vorbereitung');
  ok(/w\.save\('orders\.create'/.test(oc) && (oc.match(/w\.(save|ok)\(/g) || []).length === 1, 'DOMAIN …GENAU eine Buchung, kein Nacheinander');
  ok(!/updateOrderLinePrice\(|expectedMargin:|remainingAmount:/.test(od) && /updateOrderOnPrimary\(/.test(od) && /orderEditBody\(/.test(od),
    'DOMAIN die Auftragsseite rechnet Marge und Rest nicht mehr selbst');
  ok(!/\bcreatePurchase\(|markPurchaseInboxDone\(/.test(pc) && /createPurchaseOnPrimary\(/.test(pc) && /purchaseCreateBody\(/.test(pc),
    'DOMAIN die Einkaufsmaske ruft die geteilte Vorbereitung');
  ok(/createOrderInHouse\(/.test(cc) && /updateOrderInHouse\(/.test(cc) && /createPurchaseInHouse\(/.test(cc), 'DOMAIN die Fernbefehle rufen dieselbe Folge');
  ok(!/vatEngine|getNextDocumentNumber|INSERT INTO|createGoldPayable\(|remainingAmount = |expectedMargin = /.test(cc),
    'DOMAIN …und rechnen weder Steuer noch Nummer noch Marge, schreiben nichts selbst');
  const oh = codeOf(src('src/core/orders/order-house.ts'));
  const ph = codeOf(src('src/core/purchases/purchase-house.ts'));
  ok(/createOrder\(/.test(oh) && /createGoldPayable\(/.test(oh) && /updateOrderLinePrice\(/.test(oh), 'DOMAIN die Folge ruft die Hausfunktionen');
  ok(/createPurchase\(/.test(ph) && /markPurchaseInboxDone\(/.test(ph), 'DOMAIN …auch beim Einkauf');
  ok(/runOnPrimary\(/.test(oh) && /runOnPrimary\(/.test(ph), 'DOMAIN am Primary in EINER Klammer');
  const oce = codeOf(src('src/core/orders/order-create.ts'));
  const pce = codeOf(src('src/core/purchases/purchase-create.ts'));
  ok(/EMBEDDED_PRODUCT_FIELDS/.test(oce) && /EMBEDDED_PRODUCT_FIELDS/.test(pce) && /checkEmbeddedProduct\(/.test(oce) && /checkEmbeddedProduct\(/.test(pce),
    'DOMAIN neue Artikel in Auftrag und Einkauf: EINE Feldliste, EINE Pruefung');
  ok(/ORDER_CREATE_STATUSES/.test(oc), 'DOMAIN die Statusauswahl der Maske ist die Liste des Hauses');
}

// ── §13 Nachbarn: Anzahlung und Umwandlung auf einem fern angelegten Auftrag ──
{
  const db = freshDb();
  const made = await fern(async () => cmd.runOrderCreate(deps(db), identity('900', 'orders.create'),
    await orderRules.orderCreateBody({ ...LEER, lines: [{ mode: 'existing', productId: 'p1', description: 'x', scheme: 'auto', quantity: 1, unitPrice: 400 }] }, stage)));
  const oid = String(made.value?.orderId ?? '');
  const pay = await fern(() => life.runAddOrderPayment(deps(db), identity('901', 'orders.add_payment'),
    { orderId: oid, amount: 100, method: 'cash', expectedRevision: orev(db, oid) }));
  ok(made.ok && pay.ok, `NACHBAR eine Anzahlung auf den fern angelegten Auftrag (${pay.code || 'ok'})`);
  await fern(() => life.runUpdateOrderStatus(deps(db), identity('902', 'orders.update_status'), { orderId: oid, status: 'arrived', expectedRevision: orev(db, oid) }));
  const conv = await fern(() => fin.runConvertOrder(deps(db), identity('903', 'orders.convert_to_invoice'), { orderId: oid, expectedRevision: orev(db, oid) }));
  ok(conv.ok, `NACHBAR …und seine Umwandlung in eine Rechnung (${conv.code || 'ok'})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r5e order/purchase parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5E_SCOPE_FROZEN');
console.log('CENTRAL_UI_R5E_ORDER_CREATE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5E_ORDER_UPDATE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5E_PURCHASE_CREATE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5E_SHARED_DOMAIN_PROVED');
console.log('CENTRAL_UI_R5E_ORDER_CREATE_ATOMICITY_PROVED');
console.log('CENTRAL_UI_R5E_PURCHASE_CREATE_ATOMICITY_PROVED');
console.log('CENTRAL_UI_R5E_INPUT_AUTHORITY_PROVED');
