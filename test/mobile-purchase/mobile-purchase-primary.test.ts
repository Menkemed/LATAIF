// ════════════════════════════════════════════════════════════════════════════
// MOBILE-PURCHASE — der Einkauf vom Telefon am Primary: `purchases.create` mit Lieferant aus Kunde oder
// neuer Person, mehreren Zahlungen, Partnern, Fotos; Wiederholung, Konflikt, Atomarität.
// Run: node test/mobile-purchase/mobile-purchase-primary.test.ts
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

// ════════════════════════════════════════════════════════════════════════════
// MOBILE-PURCHASE — was das Telefon schickt, bucht der Primary über `purchases.create`.
// ════════════════════════════════════════════════════════════════════════════
const t = (x: number): string => ID(String(700 + x));
const ident = (x: number, hash = 'h' + x) => ({ commandId: t(x), ...ACTOR, op: 'purchases.create', payloadHash: hash });
const run = (db: Db, x: number, body: unknown, hash?: string) => fern(() => cmd.runPurchaseCreate(deps(db), ident(x, hash), body));
const zahl = (db: Db, sql: string, p: unknown[] = []): number => n(db, sql, p);
const ap = (db: Db): number => Math.round(zahl(db, "SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE'") * 1000) / 1000;
const unbalanced = (db: Db): number => zahl(db, `SELECT COUNT(*) FROM (SELECT transaction_id, SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) d
  FROM ledger_entries GROUP BY transaction_id HAVING ABS(d) > 0.0005)`);
const counts = (db: Db): string => S(['purchases', 'purchase_lines', 'products', 'stock_lots', 'purchase_payments', 'item_participations', 'customers', 'suppliers', 'media_links']
  .map((tb) => zahl(db, `SELECT COUNT(*) FROM ${tb}`)).concat([zahl(db, 'SELECT COUNT(*) FROM ledger_entries')]));

function seedMobile(db: Db): void {
  for (const [id, name, active] of [['pa-1', 'Bashir', 1], ['pa-2', 'Chalid', 1], ['pa-off', 'Alt', 0]] as Array<[string, string, number]>) {
    db.run(`INSERT INTO partners (id, branch_id, name, share_percentage, active, created_at, updated_at) VALUES (?, 'branch-main', ?, 0, ?, ?, ?)`, [id, name, active, NOW, NOW]);
  }
  db.run("UPDATE customers SET phone = '+973 3600 0101' WHERE id = 'cust-1'");
  // Ein unverknüpfter Lieferant, der dieselbe Person sein könnte wie eine neue „Karim Saleh".
  db.run("INSERT INTO suppliers (id, branch_id, name, phone, active, created_at, updated_at) VALUES ('sup-cand', 'branch-main', 'Karim Saleh', '+973 3600 0999', 1, ?, ?)", [NOW, NOW]);
  reload();
}

const NEU = (name: string, extra: Record<string, unknown> = {}) => ({ categoryId: 'cat-w', brand: 'Rolex', name, ...extra });
const ZEILE = (name: string, qty: number, price: number, extra: Record<string, unknown> = {}) => ({
  mode: 'new', brand: 'Rolex', name, sku: '', categoryId: 'cat-w', quantity: qty, unitPrice: price, newProduct: NEU(name), ...extra,
});

// ── 1 ein Lieferant, ein Einzelartikel, ohne Zahlung → offene Lieferantenschuld ──
{
  const db = freshDb(); seedMobile(db);
  const r = await run(db, 1, { supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines: [ZEILE('Sub A', 1, 1000)] });
  const pid = String(r.value?.purchaseId ?? '');
  ok(r.ok && s(db, 'SELECT status FROM purchases WHERE id = ?', [pid]) === 'UNPAID' && ap(db) === 1000,
    `EINZEL ein Artikel, keine Zahlung → UNPAID, Lieferantenschuld 1000 (${r.code || 'ok'}, ${ap(db)})`);
  ok(zahl(db, 'SELECT COUNT(*) FROM stock_lots WHERE purchase_id = ?', [pid]) === 1 && r.value?.supplierId === 'sup-1', 'EINZEL ein Los, bestehender Lieferant');
}

// ── 2 mehrere Artikel, Menge > 1, Mischung, mehrere Fotos, bestehender Artikel ──
{
  const db = freshDb(); seedMobile(db);
  const [f1, f2, f3] = await stage([foto(1), foto(2), foto(3)]);
  const body = {
    supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO',
    lines: [
      ZEILE('Rolex Day-Date', 1, 900, { newProduct: { ...NEU('Rolex Day-Date'), stagingIds: [f1, f2] } }),
      ZEILE('Gold Chain', 3, 120.5, { newProduct: { ...NEU('Gold Chain'), stagingIds: [f3] } }),
      { mode: 'existing', productId: 'p1', brand: '', name: '', sku: '', categoryId: '', quantity: 2, unitPrice: 50.25 },
    ],
  };
  const r = await run(db, 2, body);
  const pid = String(r.value?.purchaseId ?? '');
  const lines = rows(db, 'SELECT product_id, quantity, unit_price, line_total FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid]);
  ok(r.ok && lines.length === 3 && S(lines.map((l) => [l.quantity, l.unit_price, l.line_total])) === S([[1, 900, 900], [3, 120.5, 361.5], [2, 50.25, 100.5]]),
    `MEHRERE drei Positionen, Menge und Summen filsgenau (${S(lines)})`);
  ok(Number(r.value?.totalAmount) === 1362 && ap(db) === 1362, `MEHRERE Summe 900 + 361,5 + 100,5 = 1362 (${r.value?.totalAmount})`);
  const neu = lines.slice(0, 2).map((l) => row(db, 'SELECT quantity, images FROM products WHERE id = ?', [l.product_id]));
  ok(Number(neu[1].quantity) === 3 && JSON.parse(String(neu[0].images)).length === 2 && JSON.parse(String(neu[1].images)).length === 1,
    `FOTOS zwei Fotos am ersten Artikel, eins am zweiten; Kette mit Menge 3 als EIN Artikel (${S(neu.map((x) => x.quantity))})`);
  ok(zahl(db, 'SELECT quantity FROM products WHERE id = ?', ['p1']) === 3 && zahl(db, 'SELECT COUNT(*) FROM stock_lots WHERE purchase_id = ?', [pid]) === 3,
    'BESTAND bestehender Artikel +2, ein Los je Position');
  // Wiederholung derselben Kennung, desselben Inhalts: das bekannte Ergebnis, keine zweite Wirkung.
  const vorher = counts(db);
  const again = await run(db, 2, body);
  ok(again.ok && again.replayed === true && again.value?.purchaseId === pid && counts(db) === vorher,
    'WIEDERHOLUNG gleiche Kennung + Inhalt → dasselbe Ergebnis, kein zweiter Einkauf/Bestand/Foto');
  const anders = await run(db, 2, { ...body, notes: 'anders' }, 'anders');
  ok(!anders.ok && /CONFLICT/.test(anders.code) && counts(db) === vorher, `KONFLIKT gleiche Kennung + anderer Inhalt → Nein, keine Buchung (${anders.code})`);
}

// ── 3 mehrere Zahlungsarten + Teilzahlung → Lieferantenschuld bleibt offen ──
{
  const db = freshDb(); seedMobile(db);
  const body = {
    supplierId: 'sup-1', purchaseDate: '2026-09-18', taxScheme: 'ZERO', lines: [ZEILE('Sub B', 1, 1500)],
    payments: [{ amount: 500, method: 'cash' }, { amount: 400, method: 'benefit', reference: 'BEN-77' }, { amount: 200, method: 'bank' }],
  };
  const r = await run(db, 3, body);
  const pid = String(r.value?.purchaseId ?? '');
  const pays = rows(db, 'SELECT amount, method, paid_at, reference FROM purchase_payments WHERE purchase_id = ? ORDER BY created_at, rowid', [pid]);
  ok(r.ok && S(pays.map((p) => [p.amount, p.method, p.paid_at])) === S([[500, 'cash', '2026-09-18'], [400, 'benefit', '2026-09-18'], [200, 'bank', '2026-09-18']])
    && pays[1].reference === 'BEN-77', `ZAHLUNGEN drei eigene Zahlungen mit Datum des Einkaufs und Referenz (${S(pays)})`);
  const kopf = row(db, 'SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [pid]);
  ok(S([kopf.total_amount, kopf.paid_amount, kopf.remaining_amount, kopf.status]) === S([1500, 1100, 400, 'PARTIALLY_PAID']) && ap(db) === 400,
    `TEILZAHLUNG 1100 bezahlt, 400 offen beim Lieferanten (${S(kopf)}, AP ${ap(db)})`);
  const kassen = S(['CASH', 'BENEFIT', 'BANK'].map((a) => Math.round(zahl(db, "SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [a]) * 1000) / 1000));
  ok(kassen === S([500, 400, 200]) && zahl(db, "SELECT COUNT(DISTINCT source_id) FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT'") === 3 && unbalanced(db) === 0,
    `BUCHUNG je Zahlung eine eigene Buchung aus Kasse/Benefit/Bank, keine Sammelbuchung (${kassen})`);
  const vorher = counts(db);
  const again = await run(db, 3, body);
  ok(again.ok && again.replayed === true && counts(db) === vorher, 'WIEDERHOLUNG keine doppelte Zahlung');
  const zuviel = await run(db, 4, { ...body, payments: [{ amount: 1000, method: 'cash' }, { amount: 500.001, method: 'bank' }] });
  ok(!zuviel.ok && zuviel.code === 'PAYMENT_EXCEEDS_TOTAL' && counts(db) === vorher, `ZAHLUNGEN über der Summe → Nein, nichts gebucht (${zuviel.code})`);
  const beides = await run(db, 5, { ...body, paymentAmount: 100 });
  ok(!beides.ok && counts(db) === vorher, `ZAHLUNGEN Anzahlung UND Liste → Nein (${beides.code})`);
  const ohneWeg = await run(db, 6, { ...body, payments: [{ amount: 10 }] });
  ok(!ohneWeg.ok && counts(db) === vorher, `ZAHLUNGEN ohne Zahlungsart → Nein (${ohneWeg.code})`);
  const karte = await run(db, 7, { ...body, payments: [{ amount: 10, method: 'card' }] });
  ok(!karte.ok && counts(db) === vorher, `ZAHLUNGEN Karte ist kein Einkaufsweg → Nein (${karte.code})`);
}

// ── 4 Partner: keiner, einer, mehrere; Prozent aus BHD gerechnet ──
{
  const db = freshDb(); seedMobile(db);
  const body = {
    supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO',
    lines: [
      ZEILE('Allein', 1, 300),
      ZEILE('Mit B', 1, 1000, { partnerShares: [{ partnerId: 'pa-1', sharePct: 40 }] }),
      // BHD-Eingabe am Telefon: 333,333 von 500 → 66,67 % (auf 0,01 % gerundet), Kostenanteil 333,35.
      ZEILE('Mit B und C', 2, 250, { partnerShares: [{ partnerId: 'pa-1', sharePct: 36.67 }, { partnerId: 'pa-2', sharePct: 30 }] }),
    ],
  };
  const r = await run(db, 8, body);
  const pid = String(r.value?.purchaseId ?? '');
  const zeilen = rows(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid]).map((x) => String(x.id));
  const teile = (l: string) => rows(db, 'SELECT party, partner_id, share_bp, cost_share FROM item_participations WHERE purchase_line_id = ? ORDER BY party, partner_id', [l]);
  ok(r.ok && teile(zeilen[0]).length === 0, 'PARTNER ohne Partner keine Beteiligung');
  ok(S(teile(zeilen[1])) === S([{ party: 'HOUSE', partner_id: null, share_bp: 6000, cost_share: 600 }, { party: 'PARTNER', partner_id: 'pa-1', share_bp: 4000, cost_share: 400 }]),
    `PARTNER ein Partner 40 % (${S(teile(zeilen[1]))})`);
  const drei = teile(zeilen[2]);
  ok(drei.length === 3 && drei.reduce((a, x) => a + Number(x.share_bp), 0) === 10000 && Math.round(drei.reduce((a, x) => a + Number(x.cost_share), 0) * 1000) === 500000
    && drei.find((x) => x.partner_id === 'pa-1')?.share_bp === 3667, `PARTNER zwei Partner auf Menge 2: Summe 100 %, Kostenanteile = Zeilensumme (${S(drei)})`);
  const vorher = counts(db);
  const again = await run(db, 8, body);
  ok(again.ok && again.replayed === true && counts(db) === vorher, 'WIEDERHOLUNG keine doppelte Partnerbeteiligung');
  const ueber = await run(db, 9, { ...body, lines: [ZEILE('Zu viel', 1, 100, { partnerShares: [{ partnerId: 'pa-1', sharePct: 60 }, { partnerId: 'pa-2', sharePct: 50 }] })] });
  const inaktiv = await run(db, 10, { ...body, lines: [ZEILE('Inaktiv', 1, 100, { partnerShares: [{ partnerId: 'pa-off', sharePct: 10 }] })] });
  ok(!ueber.ok && !inaktiv.ok && counts(db) === vorher, `PARTNER über 100 % und inaktiver Partner → Nein, nichts gebucht (${ueber.code}, ${inaktiv.code})`);
}

// ── 5 Lieferant aus bestehendem Kunden: dieselbe Person, kein zweiter Lieferant ──
{
  const db = freshDb(); seedMobile(db);
  const seen = s(db, "SELECT updated_at FROM customers WHERE id = 'cust-1'");
  const body = { supplierFromCustomer: { customerId: 'cust-1', seenCustomerUpdatedAt: seen }, purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines: [ZEILE('Vom Kunden', 1, 200)] };
  const r = await run(db, 11, body);
  const sup = String(r.value?.supplierId ?? '');
  ok(r.ok && s(db, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [sup]) === 'cust-1' && s(db, 'SELECT supplier_id FROM purchases WHERE id = ?', [String(r.value?.purchaseId)]) === sup,
    `KUNDE → LIEFERANT verknüpfte Lieferantenrolle angelegt und verwendet (${r.code || sup})`);
  const r2 = await run(db, 12, { ...body, lines: [ZEILE('Zweiter Kauf', 1, 100)] });
  ok(r2.ok && r2.value?.supplierId === sup && zahl(db, "SELECT COUNT(*) FROM suppliers WHERE linked_customer_id = 'cust-1'") === 1,
    'KUNDE → LIEFERANT zweiter Einkauf derselben Person: derselbe Lieferant, keine Doppelung');
  const alt = await run(db, 13, { ...body, supplierFromCustomer: { customerId: 'cust-2', seenCustomerUpdatedAt: '2000-01-01T00:00:00.000Z' } });
  ok(!alt.ok && alt.code === 'CUSTOMER_CHANGED', `KUNDE veralteter Stand → Nein (${alt.code})`);
  // Kein Netting: die Kundenseite (Forderungen) bleibt unberührt.
  ok(zahl(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE'") === 0, 'TRENNUNG keine Buchung auf Kundenforderungen');
}

// ── 6 neue Person → Kunde + verknüpfter Lieferant, atomar; möglicher Doppelgänger fragt ──
{
  const db = freshDb(); seedMobile(db);
  const body = { newSupplierPerson: { firstName: 'Mona', lastName: 'Haddad', phone: '+973 3600 0500' }, purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines: [ZEILE('Von Mona', 1, 700)] };
  const r = await run(db, 14, body);
  const cust = String(r.value?.customerId ?? '');
  ok(r.ok && s(db, 'SELECT first_name FROM customers WHERE id = ?', [cust]) === 'Mona' && s(db, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [String(r.value?.supplierId)]) === cust,
    `NEUE PERSON Kunde „Mona Haddad" + verknüpfter Lieferant (${r.code || cust})`);
  const vorher = counts(db);
  const again = await run(db, 14, body);
  ok(again.ok && again.replayed === true && counts(db) === vorher, 'WIEDERHOLUNG keine zweite Person, kein zweiter Lieferant');
  const karim = { ...body, newSupplierPerson: { firstName: 'Karim', lastName: 'Saleh', phone: '+973 3600 0999' }, lines: [ZEILE('Von Karim', 1, 100)] };
  const frage = await run(db, 15, karim);
  ok(!frage.ok && frage.code === 'SUPPLIER_CANDIDATES_EXIST' && counts(db) === vorher,
    `DOPPELGÄNGER möglicher bestehender Lieferant → Nachfrage, KEIN Kunde und kein Einkauf angelegt (${frage.code})`);
  const trotzdem = await run(db, 16, { ...karim, newSupplierPerson: { ...karim.newSupplierPerson, createDespiteExistingSuppliers: true } });
  ok(trotzdem.ok && zahl(db, "SELECT COUNT(*) FROM customers WHERE first_name = 'Karim'") === 1, `DOPPELGÄNGER bewusst neu angelegt (${trotzdem.code || 'ok'})`);
  const atomar = await run(db, 17, { ...body, newSupplierPerson: { firstName: 'Rana', lastName: 'Atomar' }, lines: [ZEILE('X', 1, 100, { partnerShares: [{ partnerId: 'pa-off', sharePct: 10 }] })] });
  ok(!atomar.ok && zahl(db, "SELECT COUNT(*) FROM customers WHERE first_name = 'Rana'") === 0, `ATOMAR scheitert die Zeile, entsteht auch die Person nicht (${atomar.code})`);
  const vorher2 = counts(db);
  const zwei = await run(db, 18, { ...body, supplierId: 'sup-1' });
  ok(!zwei.ok && counts(db) === vorher2, `LIEFERANT zwei Wege zugleich → Nein (${zwei.code})`);
  const ohne = await run(db, 19, { purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines: [ZEILE('Ohne', 1, 1)] });
  ok(!ohne.ok, `LIEFERANT fehlt → Nein (${ohne.code})`);
}

// ── 7 Hauptbuch am Ende eines gemischten Laufs ausgeglichen; Rechner-Weg unverändert ──
{
  const db = freshDb(); seedMobile(db);
  await run(db, 20, { supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'VAT_10', lines: [ZEILE('Mit VAT', 1, 1100)], payments: [{ amount: 1100, method: 'bank' }] });
  const vat = Math.round(zahl(db, "SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account LIKE '%VAT%'") * 1000) / 1000;
  ok(s(db, "SELECT status FROM purchases LIMIT 1") === 'PAID' && vat === 100 && unbalanced(db) === 0, `VAT bestehende Vorsteuer 100 unverändert, voll bezahlt, ausgeglichen (${vat})`);
  const desk = await primary(() => purchaseHouse.createPurchaseOnPrimary({
    supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines: [{ mode: 'existing', productId: 'p2', brand: '', name: '', sku: '', categoryId: '', quantity: 1, unitPrice: 10 }],
    paymentAmount: 4, paymentMethod: 'cash', notes: '', staffId: '',
  }));
  ok(desk.ok && zahl(db, 'SELECT COUNT(*) FROM purchase_payments') === 2, `RECHNER „Save Purchase" mit Anzahlung wie bisher (${desk.code || 'ok'})`);
}

// ── 8 der Rumpf, den das Telefon baut, bucht der Primary genau so ──
{
  const db = freshDb(); seedMobile(db);
  const sandbox: Record<string, unknown> = {};
  new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js'))(sandbox);
  new Function('self', src('src-tauri/src/sync/mobile_business_date.js'))(sandbox);
  new Function('self', src('src-tauri/src/sync/mobile_purchase_commands.js'))(sandbox);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MPX = sandbox.MobilePurchase as any;
  const d = MPX.newDraft('draft-1', '2026-09-21');
  d.supplier = { mode: 'person', person: { firstName: 'Samir', lastName: 'Telefon', phone: '+973 3600 0777', email: '' }, createDespite: false };
  const a = Object.assign(MPX.newItem('a', 'cat-w'), { brand: 'Rolex', name: 'Datejust', quantity: '1', unitPrice: '1000',
    photos: [{ id: 'f1', dataUrl: foto(11) }, { id: 'f2', dataUrl: foto(12) }], partners: [{ partnerId: 'pa-1', sharePct: '40' }] });
  const b = Object.assign(MPX.newItem('b', 'cat-w'), { brand: 'Gold', name: 'Chain', quantity: '3', unitPrice: '166.667' });
  d.items.push(a, b);
  d.payments.push({ method: 'cash', amount: '500', reference: '' }, { method: 'benefit', amount: '400', reference: '' }, { method: 'bank', amount: '200', reference: '' });
  const staged = new Map<string, string>();
  for (const it of [a]) for (const p of it.photos) staged.set(p.id, (await stage([p.dataUrl]))[0]);
  const built = MPX.buildBody(d, (it: { photos: Array<{ id: string }> }) => it.photos.map((p) => staged.get(p.id)));
  const r = await run(db, 30, built.body);
  const pid = String(r.value?.purchaseId ?? '');
  const kopf = row(db, 'SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [pid]);
  ok(built.ok && r.ok && S([kopf.total_amount, kopf.paid_amount, kopf.remaining_amount, kopf.status]) === S([1500.001, 1100, 400.001, 'PARTIALLY_PAID'])
    && Number(r.value?.openAmount) === 400.001, `TELEFON-RUMPF gebucht: 1000 + 3 × 166,667 = 1500,001; 1100 bezahlt, 400,001 offen (${r.code || S(kopf)})`);
  ok(MPX.totals(d).totalF === MPX.F(Number(kopf.total_amount)) && MPX.totals(d).openF === MPX.F(Number(kopf.remaining_amount)),
    'TELEFON-SUMMEN die Anzeige des Telefons entspricht dem, was der Primary gebucht hat (filsgenau)');
  ok(zahl(db, 'SELECT COUNT(*) FROM item_participations WHERE purchase_id = ?', [pid]) === 2 && zahl(db, 'SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ?', [pid]) === 3
    && s(db, 'SELECT first_name FROM customers WHERE id = ?', [String(r.value?.customerId)]) === 'Samir' && unbalanced(db) === 0,
    'TELEFON-RUMPF neue Person, Partner, drei Zahlungen, Hauptbuch ausgeglichen');
}

// ── 9 SKU-ALLOC — ein neuer Artikel ohne SKU bekommt eine aus dem durablen Zähler, am Telefon wie am Rechner ──
{
  const db = freshDb(); seedMobile(db);
  const seq = (): string => S(rows(db, 'SELECT stem, next_number FROM sku_sequences ORDER BY stem'));
  const skuVon = (pid: string): unknown[] => rows(db,
    'SELECT pr.sku FROM purchase_lines l JOIN products pr ON pr.id = l.product_id WHERE l.purchase_id = ? ORDER BY l.position', [pid]).map((x) => x.sku);
  const body = {
    supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines: [
      ZEILE('Sku A', 1, 100), ZEILE('Sku B', 2, 50),
      ZEILE('Sku C', 1, 70, { newProduct: NEU('Sku C', { sku: 'MY-SKU-1' }) }),
      { mode: 'existing', productId: 'p1', brand: '', name: '', sku: '', categoryId: '', quantity: 1, unitPrice: 10 },
    ],
  };
  const r = await run(db, 40, body);
  const skus = skuVon(String(r.value?.purchaseId ?? ''));
  ok(r.ok && typeof skus[0] === 'string' && typeof skus[1] === 'string' && String(skus[0]).length > 0 && skus[0] !== skus[1]
    && skus[2] === 'MY-SKU-1' && skus[3] === 'SKU-p1',
    `SKU zwei neue Artikel ohne Eingabe bekommen je eine eigene, eingetippte bleibt, bestehender Artikel unverändert (${S(skus)})`);
  const stand = seq();
  const again = await run(db, 40, body);
  ok(again.ok && again.replayed === true && seq() === stand, 'SKU Wiederholung vergibt keine zweite Nummer');
  const nein = await run(db, 41, { ...body, lines: [ZEILE('Sku D', 1, 100)], payments: [{ amount: 999, method: 'cash' }] });
  ok(!nein.ok && seq() === stand, `SKU ein abgewiesener Einkauf verbraucht keine Nummer (${nein.code})`);
  const vergeben = await run(db, 42, { ...body, lines: [ZEILE('Sku E', 1, 100, { newProduct: NEU('Sku E', { sku: String(skus[0]) }) })] });
  ok(!vergeben.ok && vergeben.code === 'SKU_TAKEN' && seq() === stand, `SKU eine schon vergebene wird weiter abgewiesen (${vergeben.code})`);
  const desk = await primary(() => purchaseHouse.createPurchaseOnPrimary({
    supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO', paymentAmount: 0, paymentMethod: 'cash', notes: '', staffId: '',
    lines: [{ mode: 'new', brand: 'Rolex', name: 'Desk', sku: '', categoryId: 'cat-w', quantity: 1, unitPrice: 20, newProduct: NEU('Desk') }],
  }));
  const deskSku = skuVon(String(desk.value?.id ?? ''))[0];
  ok(desk.ok && typeof deskSku === 'string' && String(deskSku).length > 0 && !skus.includes(deskSku),
    `SKU auch der Einkauf am Rechner vergibt sie, aus demselben Zähler (${desk.code || S(deskSku)})`);
}

// ── 10 das Ausweisfoto der neuen Person — im selben Auftrag, wie bei `customers.create` ──
{
  const db = freshDb(); seedMobile(db);
  const ausweise = (id: string): number => zahl(db,
    "SELECT COUNT(*) FROM media_links WHERE entity_type = 'customer' AND entity_id = ? AND media_role = 'identity_document' AND deleted_at IS NULL", [id]);
  const sensibel = (): number => zahl(db, "SELECT COUNT(*) FROM media_objects WHERE security_class = 'sensitive'");
  const [st] = await stage([foto(21)]);
  const body = {
    newSupplierPerson: { firstName: 'Ida', lastName: 'Ausweis', phone: '+973 3600 0333', idPhotoStagingId: st },
    purchaseDate: '2026-09-22', taxScheme: 'ZERO', lines: [ZEILE('Mit Ausweis', 1, 100)],
  };
  const r = await run(db, 50, body);
  const cust = String(r.value?.customerId ?? '');
  ok(r.ok && ausweise(cust) === 1 && sensibel() === 1 && s(db, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [String(r.value?.supplierId)]) === cust,
    `AUSWEIS die neue Person bekommt ihr Ausweisfoto als geschütztes Medium, Lieferant verknüpft (${r.code || 'ok'})`);
  const vorher = counts(db);
  const again = await run(db, 50, body);
  ok(again.ok && again.replayed === true && counts(db) === vorher && ausweise(cust) === 1 && sensibel() === 1,
    'AUSWEIS Wiederholung: kein zweites Foto, keine zweite Person');
  const [st2] = await stage([foto(22)]);
  const nein = await run(db, 51, {
    ...body, newSupplierPerson: { ...body.newSupplierPerson, firstName: 'Nein', idPhotoStagingId: st2 }, payments: [{ amount: 999, method: 'cash' }],
  });
  ok(!nein.ok && zahl(db, "SELECT COUNT(*) FROM customers WHERE first_name = 'Nein'") === 0 && sensibel() === 1,
    `AUSWEIS ein abgewiesener Einkauf legt weder Person noch Foto an (${nein.code})`);
  const ohne = await run(db, 52, { ...body, newSupplierPerson: { firstName: 'Ohne', lastName: 'Foto' } });
  ok(ohne.ok && ausweise(String(ohne.value?.customerId ?? '')) === 0, 'AUSWEIS ohne Foto bleibt es optional');
}

// ── 11 STONES — die EINE Steinliste am Primary: Einkauf vom Telefon, Kommission, Ändern, Reparatur ──
{
  const db = freshDb(); seedMobile(db);
  const { DEFAULT_CATEGORIES } = await import('../../src/core/models/default-categories.ts');
  const gold = DEFAULT_CATEGORIES.find((c) => c.id === 'cat-gold-jewelry')!;
  db.run(`INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, created_at, updated_at)
    VALUES (?, 'branch-main', ?, 'g', '#000', ?, ?, ?, ?, ?)`,
    [gold.id, gold.name, JSON.stringify(gold.attributes), JSON.stringify(gold.scopeOptions), JSON.stringify(gold.conditionOptions), NOW, NOW]);
  reload();
  const attrsOf = (pid: string) => JSON.parse(s(db, 'SELECT attributes FROM products WHERE id = ?', [pid]) || '{}') as Record<string, unknown>;
  // Wie das Telefon ihn baut: Menge/Karat noch als Text, eine leere Zeile — der Primary prüft und normalisiert.
  const steine = [
    { type: 'diamond', qty: '1', carat: '0.50', color: 'G', clarity: 'VS1', shape: 'oval' },
    { type: 'diamond', qty: '20', carat: '0.30', color: 'G', clarity: 'VS', shape: 'round' },
    { type: 'emerald', qty: '3', carat: '0.45' },
    { type: '', qty: '' },
  ];
  const zeile = (stones: unknown) => ({
    mode: 'new', brand: '', name: '', sku: '', categoryId: 'cat-gold-jewelry', quantity: 1, unitPrice: 800,
    newProduct: { categoryId: 'cat-gold-jewelry', brand: null, name: null, attributes: { weight: 5.2, item_type: 'Necklace', karat: '18K White', description: 'EMERALD CLUSTER', stones } },
  });
  const r = await run(db, 60, { supplierId: 'sup-1', purchaseDate: '2026-09-29', taxScheme: 'ZERO', lines: [zeile(steine)] });
  const pid = s(db, 'SELECT product_id FROM purchase_lines WHERE purchase_id = ?', [String(r.value?.purchaseId ?? '')]);
  const a = attrsOf(pid);
  ok(r.ok && S(a.stones) === S([
    { type: 'diamond', qty: 1, carat: 0.5, color: 'G', clarity: 'VS1', shape: 'oval' },
    { type: 'diamond', qty: 20, carat: 0.3, color: 'G', clarity: 'VS', shape: 'round' },
    { type: 'emerald', qty: 3, carat: 0.45 },
  ]) && a.diamond_weight === 0.8, `STONES Einkauf vom Telefon: Zeilen normalisiert, leere weg, Diamond Weight 0.80 (${r.code || S(a).slice(0, 160)})`);
  const vorher = counts(db);
  const nein = await run(db, 61, { supplierId: 'sup-1', purchaseDate: '2026-09-29', taxScheme: 'ZERO', lines: [zeile([{ type: 'other', qty: 1 }])] });
  ok(!nein.ok && /STONES_INVALID/.test(nein.code) && counts(db) === vorher, `STONES eine falsche Liste → Nein, nichts gebucht (${nein.code})`);
  const falsch = await run(db, 62, { supplierId: 'sup-1', purchaseDate: '2026-09-29', taxScheme: 'ZERO',
    lines: [zeile([{ type: 'emerald', qty: 1, color: 'G' }])] });
  ok(!falsch.ok && counts(db) === vorher, `STONES keine versteckten Diamant-Felder an anderen Steinen (${falsch.code})`);

  // Kommission mit Steinen (derselbe Artikel-Weg des Hauses).
  const k = await fern(() => cmd.runConsignmentCreate(deps(db), { commandId: t(63), ...ACTOR, op: 'consignments.create', payloadHash: 'h63' }, {
    consignorId: 'cust-1', agreedPrice: 500, payout: { model: 'percent', commissionRate: 20 },
    product: { categoryId: 'cat-gold-jewelry', attributes: { weight: 3, item_type: 'Ring', karat: '18K Yellow', stones: [{ type: 'other', qty: 2, name: 'Spinel' }, { type: 'diamond', qty: 1, carat: 0.25 }] } },
  }));
  const kp = s(db, 'SELECT product_id FROM consignments ORDER BY created_at DESC LIMIT 1');
  ok(k.ok && attrsOf(kp).diamond_weight === 0.25 && S((attrsOf(kp).stones as unknown[]).map((x) => (x as { type: string }).type)) === S(['other', 'diamond']),
    `STONES Kommission: dieselbe Liste, Summe abgeleitet (${k.code || 'ok'})`);

  // Ändern: die abgeleitete Summe fällt mit ihren Diamant-Zeilen; ein Altwert ohne Liste bleibt.
  const { useProductStore } = await import('../../src/stores/productStore.ts');
  useProductStore.getState().updateProduct(pid, { attributes: { ...a, stones: [{ type: 'emerald', qty: 3, carat: 0.45 }] } as never });
  ok(!('diamond_weight' in attrsOf(pid)) && (attrsOf(pid).stones as unknown[]).length === 1, 'STONES Ändern: ohne Diamant-Zeilen keine abgeleitete Summe mehr');
  db.run("INSERT INTO products (id, branch_id, category_id, brand, name, purchase_price, attributes, created_at, updated_at) VALUES ('alt-1', 'branch-main', 'cat-gold-jewelry', '', '', 0, ?, ?, ?)",
    [JSON.stringify({ weight: 2, item_type: 'Ring', karat: '18K White', diamond_weight: 0.6 }), NOW, NOW]);
  useProductStore.getState().updateProduct('alt-1', { attributes: { weight: 2.1, item_type: 'Ring', karat: '18K White', diamond_weight: 0.6 } as never });
  ok(attrsOf('alt-1').diamond_weight === 0.6 && !('stones' in attrsOf('alt-1')), 'STONES Altbestand: ein Diamond Weight ohne Liste bleibt beim Ändern');
  let wurf = '';
  try { useProductStore.getState().updateProduct('alt-1', { attributes: { stones: [{ type: 'other', qty: 1 }] } as never }); } catch (e) { wurf = (e as { code?: string }).code ?? ''; }
  ok(wurf === 'STONES_INVALID' && attrsOf('alt-1').diamond_weight === 0.6, 'STONES eine falsche Liste wird an der Schreibstelle nie geschrieben');

  // Reparatur: dieselbe Liste im Kundenstück.
  const { useRepairStore } = await import('../../src/stores/repairStore.ts');
  const rep = useRepairStore.getState().createRepair({ customerId: 'cust-1', repairScope: 'CUSTOMER', itemCategoryId: 'cat-gold-jewelry', issueDescription: 'clasp',
    itemAttributes: { item_type: 'Necklace', stones: [{ type: 'diamond', qty: '2', carat: '0.10' }] } } as never);
  const ra = JSON.parse(s(db, 'SELECT item_attributes FROM repairs WHERE id = ?', [rep.id]) || '{}');
  ok(S(ra.stones) === S([{ type: 'diamond', qty: 2, carat: 0.1 }]) && ra.diamond_weight === 0.1, `STONES Reparatur: dieselbe Liste, Summe abgeleitet (${S(ra)})`);
  ok(unbalanced(db) === 0, 'STONES keine Buchung berührt (Hauptbuch ausgeglichen)');
}

// ── 9 BUSINESS-DATE — das Einkaufsdatum vom Telefon steht am Primary genau so; Zukunft wird abgewiesen ──
{
  const db = freshDb(); seedMobile(db);
  const sandbox: Record<string, unknown> = {};
  for (const f of ['mobile_business_date.js', 'mobile_repair_commands.js', 'mobile_purchase_commands.js']) new Function('self', src('src-tauri/src/sync/' + f))(sandbox);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MPX = sandbox.MobilePurchase as any;
  const heute = new Date().toISOString().split('T')[0];
  const entwurf = (id: string, datum: string, name: string) => {
    const d = MPX.newDraft(id, datum);
    d.supplier.mode = 'existing'; d.supplier.supplierId = 'sup-1';
    d.items.push(Object.assign(MPX.newItem('a', 'cat-w'), { brand: 'Rolex', name, quantity: '1', unitPrice: '1000' }));
    d.payments.push({ method: 'cash', amount: '300', reference: '' });
    return d;
  };
  const tage = (pid: string): string => S([
    s(db, 'SELECT purchase_date FROM purchases WHERE id = ?', [pid]),
    rows(db, 'SELECT paid_at FROM purchase_payments WHERE purchase_id = ?', [pid]).map((p) => String(p.paid_at).slice(0, 10)),
    rows(db, 'SELECT acquired_at FROM stock_lots WHERE purchase_id = ?', [pid]).map((l) => String(l.acquired_at).slice(0, 10)),
  ]);
  // Rückdatiert.
  const alt = MPX.buildBody(entwurf('draft-alt', '2026-08-15', 'Date A'), () => []);
  const r = await run(db, 40, alt.body);
  const pid = String(r.value?.purchaseId ?? '');
  ok(alt.ok && alt.body.purchaseDate === '2026-08-15' && r.ok && tage(pid) === S(['2026-08-15', ['2026-08-15'], ['2026-08-15']]),
    `DATUM rückdatiert: Einkauf, Zahlung beim Anlegen und Los am gewählten Tag (${r.code || tage(pid)})`);
  ok(s(db, "SELECT purchase_date FROM products WHERE name = 'Date A'") === '2026-08-15' && unbalanced(db) === 0,
    'DATUM …auch der neue Artikel trägt ihn als Einkaufsdatum; Hauptbuch ausgeglichen');
  // Dieselbe Kennung noch einmal (Wiederholung nach verlorener Antwort): dasselbe Ergebnis, dasselbe Datum.
  const vorher = counts(db);
  const again = await run(db, 40, alt.body);
  ok(again.ok && again.replayed === true && again.value?.purchaseId === pid && counts(db) === vorher && tage(pid) === S(['2026-08-15', ['2026-08-15'], ['2026-08-15']]),
    'DATUM Wiederholung unter derselben Kennung: kein zweiter Einkauf, das Datum bleibt');
  // Heute (die Vorgabe der Maske — das Telefon schreibt den Tag aus).
  const jetzt = MPX.buildBody(entwurf('draft-heute', heute, 'Date B'), () => []);
  const h = await run(db, 41, jetzt.body);
  ok(jetzt.body.purchaseDate === heute && h.ok && tage(String(h.value?.purchaseId)) === S([heute, [heute], [heute]]), `DATUM Vorgabe heute: gebucht am heutigen Tag (${h.code || 'ok'})`);
  // Zukunft und Unsinn: der Primary weist ab — auch wenn ein Telefon es trotzdem schickt. Nichts entsteht.
  const stand = counts(db);
  const zukunft = await run(db, 42, { supplierId: 'sup-1', purchaseDate: '2099-01-01', taxScheme: 'ZERO', lines: [ZEILE('Date C', 1, 10)] });
  const unsinn = await run(db, 43, { supplierId: 'sup-1', purchaseDate: '2026-02-31', taxScheme: 'ZERO', lines: [ZEILE('Date D', 1, 10)] });
  ok(!zukunft.ok && zukunft.code === 'INVALID_DATE' && !unsinn.ok && unsinn.code === 'INVALID_DATE' && counts(db) === stand,
    `DATUM Zukunft / kein Kalendertag → abgewiesen, nichts angelegt (${zukunft.code} / ${unsinn.code})`);
  // Ein älteres Telefon ohne Datum im Rumpf bleibt gültig: heute.
  const ohne = await run(db, 44, { supplierId: 'sup-1', taxScheme: 'ZERO', lines: [ZEILE('Date E', 1, 10)] });
  ok(ohne.ok && s(db, 'SELECT purchase_date FROM purchases WHERE id = ?', [String(ohne.value?.purchaseId)]) === heute, `DATUM ohne Angabe: heute, wie bisher (${ohne.code || 'ok'})`);
  // Der Rechner („Save Purchase") folgt derselben Regel.
  const maske = {
    supplierId: 'sup-1', purchaseDate: '2099-01-01', taxScheme: 'ZERO', lines: [{ mode: 'existing', productId: 'p2', brand: '', name: '', sku: '', categoryId: '', quantity: 1, unitPrice: 10 }],
    paymentAmount: 0, paymentMethod: 'cash', notes: '', staffId: '',
  };
  const vorRechner = counts(db);
  const desk = await primary(() => purchaseHouse.createPurchaseOnPrimary(maske as never));
  ok(!desk.ok && desk.code === 'INVALID_DATE' && counts(db) === vorRechner
    && purchaseRules.validatePurchaseCreate(maske as never) === 'Purchase date cannot be in the future'
    && purchaseRules.validatePurchaseCreate({ ...maske, purchaseDate: '2026-08-15' } as never) === null,
    `DATUM Rechner: dieselbe Regel in Maske und Haus, rückdatiert bleibt erlaubt (${desk.code})`);
}

console.log(`\nmobile-purchase primary: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('MOBILE_PURCHASE_PRIMARY_PROVED');
