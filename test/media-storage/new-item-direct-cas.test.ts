// ════════════════════════════════════════════════════════════════════════════
// v0.8.111 MEDIA STORAGE — Fotos neuer Artikel (Einkauf am Primary und vom PC2) direkt in den Medienspeicher:
// Aufnahme VOR der Klammer, Verknüpfung IN der Klammer, Größenklasse aus size-profile.ts, keine Base64-Kopien.
// Run: node test/media-storage/new-item-direct-cas.test.ts
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


const { setNewItemPhotoTestHook, prepareNewItemSpec } = await import('../../src/core/media/new-item-photos.ts');
const { pendingNewItemMedia } = await import('../../src/core/media/new-item-media.ts');
const JEWEL = 'cat-gold-jewelry';
const seedJewel = (db: Db): void => {
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?, 'branch-main', 'Gold Jewelry', 'j', '#000', ?, ?)", [JEWEL, NOW, NOW]);
  reload();
};
const links = (db: Db, pid: string): string[] =>
  rows(db, "SELECT media_id FROM media_links WHERE entity_type = 'product' AND entity_id = ? AND media_role = 'stock_image' AND deleted_at IS NULL ORDER BY sort_order", [pid]).map((r) => String(r.media_id));
const objekte = (db: Db): number => zahl(db, 'SELECT COUNT(*) FROM media_objects');
const ohneLink = (db: Db): number => zahl(db, `SELECT COUNT(*) FROM media_objects o WHERE NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = o.media_id AND l.deleted_at IS NULL)`);
const base64Kopien = (db: Db): number => zahl(db, "SELECT COUNT(*) FROM sync_changelog WHERE data LIKE '%data:image%'")
  + zahl(db, "SELECT COUNT(*) FROM audit_log WHERE COALESCE(new_value, '') LIKE '%data:image%' OR COALESCE(old_value, '') LIKE '%data:image%'")
  + zahl(db, "SELECT COUNT(*) FROM products WHERE images LIKE '%data:%'");

setNewItemPhotoTestHook({ enabled: true });

// ── A PC2 `purchases.create`: Uhr (60 KB) + Schmuck (30 KB), Fotos aus der Ablage ──
{
  const db = freshDb(); seedJewel(db);
  const [f1, f2, f3] = await stage([foto(11), foto(12), foto(13)]);
  const body = {
    supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO',
    lines: [
      ZEILE('Rolex Sub', 1, 900, { newProduct: { ...NEU('Rolex Sub'), stagingIds: [f1, f2] } }),
      ZEILE('Gold Ring', 1, 300, { categoryId: JEWEL, brand: '', newProduct: { ...NEU('Gold Ring', { categoryId: JEWEL, brand: '' }), stagingIds: [f3] } }),
    ],
  };
  const r = await run(db, 1, body);
  const pid = String(r.value?.purchaseId ?? '');
  const lines = rows(db, 'SELECT product_id FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid]).map((x) => String(x.product_id));
  ok(r.ok && lines.length === 2, `A der PC2-Einkauf mit Fotos wird gebucht (${r.code || 'ok'})`);
  ok(S(tauriState.prepareProfiles) === S(['main60', 'main60', 'main30']),
    `A jede Aufnahme mit der Größenklasse aus size-profile.ts: Uhr 60 KB, Schmuck 30 KB (${S(tauriState.prepareProfiles)})`);
  ok(lines.length === 2 && links(db, lines[0]).length === 2 && links(db, lines[1]).length === 1,
    'A die Fotos hängen als Verknüpfungen am neuen Artikel — 2 an der Uhr, 1 am Ring');
  ok(lines.length === 2 && lines.every((p) => s(db, 'SELECT images FROM products WHERE id = ?', [p]) === '[]'), 'A products.images bleibt leer — keine eingebetteten Fotos');
  ok(base64Kopien(db) === 0, `A keine Base64-Kopie in sync_changelog, audit_log oder products (${base64Kopien(db)})`);
  ok(zahl(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'products'") >= 2, 'A …die Artikel reisen trotzdem normal über den Abgleich');
  ok(objekte(db) === 3 && ohneLink(db) === 0, `A genau 3 Medienobjekte, keines unverknüpft (${objekte(db)}/${ohneLink(db)})`);
  ok(pendingNewItemMedia().length === 0, 'A kein nachträglicher Umzug vorgemerkt (der PP-12-Nachlauf entfällt)');
  ok(unbalanced(db) === 0 && ap(db) === 1200, `A Buchung unverändert: Verbindlichkeit 1200, alles ausgeglichen (${ap(db)})`);
  ok(S(rows(db, 'SELECT unit_cost FROM stock_lots WHERE purchase_id = ? ORDER BY unit_cost', [pid]).map((x) => x.unit_cost)) === S([300, 900]),
    'A ein Los je Zeile mit dem Einstandspreis der Zeile');
  const vorher = [counts(db), objekte(db)].join('|');
  const again = await run(db, 1, body);
  ok(again.ok && again.replayed === true && [counts(db), objekte(db)].join('|') === vorher,
    'A WIEDERHOLUNG gleiche Kennung → eingefrorene Antwort, kein zweites Medium, keine zweite Verknüpfung');
  ok(tauriState.discarded.length >= 3, `A die Ablage wird erst nach dem Erfolg geräumt (${tauriState.discarded.length})`);
}

// ── B dasselbe Foto in zwei neuen Artikeln: EINE Datei, zwei Verknüpfungen ──
{
  const db = freshDb();
  const [f1] = await stage([foto(21)]);
  const body = {
    supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO',
    lines: [ZEILE('A', 1, 100, { newProduct: { ...NEU('A'), stagingIds: [f1] } }), ZEILE('B', 1, 100, { newProduct: { ...NEU('B'), stagingIds: [f1] } })],
  };
  const r = await run(db, 2, body);
  ok(r.ok && objekte(db) === 1, `B dasselbe Foto zweimal → EIN Medienobjekt (Inhaltskennung), keine doppelte Datei (${r.code || 'ok'}, ${objekte(db)})`);
  ok(zahl(db, "SELECT COUNT(*) FROM media_links WHERE entity_type = 'product' AND deleted_at IS NULL") === 2, 'B …mit je einer Verknüpfung an beiden Artikeln');
}

// ── C Nein IN der Klammer (Variante passt nicht): kein Artikel, keine Verknüpfung, das Objekt bleibt unverknüpft ──
{
  const db = freshDb();
  const [f1] = await stage([foto(31)]);
  const body = {
    supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO',
    lines: [ZEILE('Variante', 1, 100, { newProduct: { ...NEU('Variante'), taxScheme: 'ZERO', stagingIds: [f1] }, variant: { anchorProductId: 'gibt-es-nicht' } })],
  };
  const vorher = counts(db);
  const r = await run(db, 3, body);
  ok(!r.ok && counts(db) === vorher, `C abgewiesen (${r.code}) — kein Einkauf, kein Artikel, keine Verknüpfung, keine Buchung`);
  ok(objekte(db) === 1 && ohneLink(db) === 1,
    `C das vorab aufgenommene Objekt bleibt unverknüpft liegen (GC-Vertrag wie beim Posteingang) — kein halber Artikel (${objekte(db)}/${ohneLink(db)})`);
  ok(tauriState.discarded.length === 0, 'C die Ablage bleibt bei einem Nein erhalten (neu versuchen möglich)');
  ok(s(db, 'SELECT status FROM remote_command_ledger WHERE command_id = ?', [t(3)]) === 'rejected','C …und das Nein ist eingefroren (eine Wiederholung bekommt dieselbe Antwort)');
}

// ── D Medienausfall VOR der Klammer: nichts wird gebucht, nichts verknüpft ──
{
  const db = freshDb();
  const [f1] = await stage([foto(41)]);
  tauriState.prepareShouldThrow = true;
  const vorher = counts(db);
  const r = await run(db, 4, { supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', lines: [ZEILE('X', 1, 100, { newProduct: { ...NEU('X'), stagingIds: [f1] } })] });
  tauriState.prepareShouldThrow = false;
  ok(!r.ok && counts(db) === vorher && objekte(db) === 0, `D Aufnahme scheitert → kein Einkauf, kein Artikel, kein Objekt (${r.code})`);
}

// ── E Primary „Save Purchase": dieselbe Regel ──
{
  const db = freshDb();
  const spec = await prepareNewItemSpec(NEU('Probe', { images: [foto(51), foto(52)] }) as never, 'branch-main') as { images?: string[]; photoMediaIds?: string[] } | undefined;
  ok(Array.isArray(spec?.images) && spec!.images!.length === 0 && spec?.photoMediaIds?.length === 2,
    'E am Primary: VOR der Klammer aufgenommen — der Entwurf trägt Kennungen statt Bytes');
  ok(S(tauriState.prepareProfiles) === S(['main60', 'main60']), `E …mit der Größenklasse der Kategorie (${S(tauriState.prepareProfiles)})`);
  const { useAuthStore } = await import('../../src/stores/authStore.ts');
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
  const desk = await primary(() => purchaseHouse.createPurchaseOnPrimary({
    supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', notes: '', staffId: '', paymentAmount: 0, paymentMethod: 'cash',
    lines: [ZEILE('Desk Watch', 1, 700, { newProduct: NEU('Desk Watch', { images: [foto(51), foto(52)] }) })],
  } as never));
  const pr = rows(db, "SELECT id, images FROM products WHERE name = 'Desk Watch'");
  ok(desk.ok && pr.length === 1 && String(pr[0].images) === '[]' && links(db, String(pr[0].id)).length === 2,
    `E „Save Purchase" am Primary: Artikel mit 2 verknüpften Fotos, Spalte leer (${desk.code || 'ok'})`);
  ok(objekte(db) === 2 && base64Kopien(db) === 0 && pendingNewItemMedia().length === 0,
    `E dieselben 2 Objekte (gleiche Bytes = gleiche Aufnahme), keine Base64-Kopie, kein Nachlauf (${objekte(db)})`);
}

// ── F ohne Medienspeicher: der bisherige Weg bleibt unverändert ──
{
  const db = freshDb();
  setNewItemPhotoTestHook({ enabled: false });
  const [f1] = await stage([foto(61)]);
  const r = await run(db, 6, { supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', lines: [ZEILE('Alt', 1, 100, { newProduct: { ...NEU('Alt'), stagingIds: [f1] } })] });
  const p = row(db, "SELECT id, images FROM products WHERE name = 'Alt'");
  ok(r.ok && JSON.parse(String(p.images ?? '[]')).length === 1 && objekte(db) === 0,
    `F ohne Medienspeicher: das Foto steht wie bisher in der Spalte (Rückfallweg unverändert) (${r.code || 'ok'})`);
  setNewItemPhotoTestHook({ enabled: true });
}

// ── H Einschleusen: ein PC2-Rumpf darf die internen Medienfelder NICHT tragen (alle vier Aufträge) ──
{
  const db = freshDb();
  const { parseOrderLineEdit } = await import('../../src/core/bridge/order-lifecycle-commands.ts');
  const { parsePurchaseEdit } = await import('../../src/core/bridge/purchase-edit-commands.ts');
  const nein = (fn: () => unknown): string => { try { fn(); return 'ANGENOMMEN'; } catch (e) { return String((e as Error).message ?? e); } };
  const fremd = { photoMediaIds: ['m-fremd-1'] };
  const roh = (extra: Record<string, unknown>) => ({ ...NEU('Fremd'), ...extra });
  const faelle: Array<[string, () => unknown]> = [
    ['purchases.create', () => cmd.parsePurchaseCreate({ supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', lines: [ZEILE('Fremd', 1, 100, { newProduct: roh(fremd) })] })],
    ['purchases.create (photoEmbedFrom)', () => cmd.parsePurchaseCreate({ supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', lines: [ZEILE('Fremd', 1, 100, { newProduct: roh({ photoEmbedFrom: 'data:image/jpeg;base64,AAAA' }) })] })],
    ['orders.create', () => cmd.parseOrderCreate({ customerId: 'cust-1', lines: [{ mode: 'new', quantity: 1, unitPrice: 100, newProduct: roh(fremd) }] })],
    ['orders.update_line', () => parseOrderLineEdit({ orderId: 'o1', lineId: 'l1', expectedRevision: 1, newProduct: roh(fremd) })],
    ['purchases.correct', () => parsePurchaseEdit({ purchaseId: 'p1', reason: 'x', expectedRevision: 1, addLines: [{ mode: 'new', quantity: 1, unitPrice: 100, newProduct: roh(fremd) }] }, true)],
  ];
  for (const [op, fn] of faelle) {
    const m = nein(fn);
    ok(m !== 'ANGENOMMEN' && /photoMediaIds|photoEmbedFrom|unknown field/i.test(m), `H ${op}: interne Medienfelder im Rumpf abgewiesen („${m.slice(0, 70)}")`);
  }
  // …und auch der ganze Auftrag schreibt dann nichts und verknüpft kein fremdes Medium.
  const vorher = counts(db);
  const r = await run(db, 8, { supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', lines: [ZEILE('Fremd', 1, 100, { newProduct: roh(fremd) })] });
  ok(!r.ok && counts(db) === vorher, `H der Auftrag mit eingeschleuster Medienkennung bucht nichts (${r.code})`);
}

// ── I Medienausfall am Primary: kein Rückfall auf den Base64-Weg ──
{
  const db = freshDb();
  const { useAuthStore } = await import('../../src/stores/authStore.ts');
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
  tauriState.prepareShouldThrow = true;
  const vorher = counts(db);
  const desk = await primary(() => purchaseHouse.createPurchaseOnPrimary({
    supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', notes: '', staffId: '', paymentAmount: 0, paymentMethod: 'cash',
    lines: [ZEILE('Ausfall', 1, 100, { newProduct: NEU('Ausfall', { images: [foto(71)] }) })],
  } as never));
  tauriState.prepareShouldThrow = false;
  ok(!desk.ok && counts(db) === vorher && zahl(db, "SELECT COUNT(*) FROM products WHERE images LIKE '%data:%'") === 0,
    `I Medienausfall am Primary: „Save Purchase" scheitert sichtbar (${desk.code.slice(0, 40)}) — kein Einkauf, und KEIN Rückfall in products.images`);
  ok(base64Kopien(db) === 0, 'I …und keine Base64-Kopie in einem Changelog');
}

// ── J Rollback, dann derselbe Einkauf richtig: das liegengebliebene Objekt wird wiederverwendet, keine zweite Datei ──
{
  const db = freshDb();
  const [f1] = await stage([foto(81)]);
  const schlecht = await run(db, 91, { supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', lines: [ZEILE('Retry', 1, 100, { newProduct: { ...NEU('Retry'), taxScheme: 'ZERO', stagingIds: [f1] }, variant: { anchorProductId: 'gibt-es-nicht' } })] });
  const nachNein = [objekte(db), ohneLink(db), zahl(db, 'SELECT COUNT(*) FROM media_blob_generations')];
  const gut = await run(db, 92, { supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', lines: [ZEILE('Retry', 1, 100, { newProduct: { ...NEU('Retry'), stagingIds: [f1] } })] });
  const pid = s(db, "SELECT id FROM products WHERE name = 'Retry'");
  ok(!schlecht.ok && nachNein[0] === 1 && nachNein[1] === 1, `J nach dem Nein: 1 unverknüpftes Objekt liegt (nicht gelöscht) (${S(nachNein)})`);
  ok(gut.ok && objekte(db) === 1 && ohneLink(db) === 0 && links(db, pid).length === 1 && zahl(db, 'SELECT COUNT(*) FROM media_blob_generations') === nachNein[2],
    `J der neue Versuch nimmt DASSELBE Objekt (Inhaltskennung): keine zweite Datei, danach verknüpft (${objekte(db)}/${ohneLink(db)})`);
}

// ── K parallele Vorgänge: zwei PC2-Einkäufe mit demselben Foto gleichzeitig ──
{
  const db = freshDb();
  const [f1] = await stage([foto(101)]);
  const body = (name: string) => ({ supplierId: 'sup-1', purchaseDate: '2026-11-26', taxScheme: 'ZERO', lines: [ZEILE(name, 1, 100, { newProduct: { ...NEU(name), stagingIds: [f1] } })] });
  const [a, b] = await Promise.all([run(db, 111, body('Par A')), run(db, 112, body('Par B'))]);
  const pa = s(db, "SELECT id FROM products WHERE name = 'Par A'");
  const pb = s(db, "SELECT id FROM products WHERE name = 'Par B'");
  ok(a.ok && b.ok && objekte(db) === 1 && links(db, pa).length === 1 && links(db, pb).length === 1 && links(db, pa)[0] === links(db, pb)[0] && ohneLink(db) === 0,
    `K beide gebucht, EIN Medienobjekt, je eine Verknüpfung, nichts unverknüpft (${a.code || 'ok'}/${b.code || 'ok'}, ${objekte(db)})`);
  ok(unbalanced(db) === 0 && ap(db) === 200, `K beide Verbindlichkeiten richtig (${ap(db)})`);
}

// ── G Verdrahtung: VOR der Klammer, überall derselbe Baustein ──
{
  const code = (x: string): string => x.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const vorKlammer = (file: string, fn: string): boolean => {
    const c = code(src(file));
    const i = c.indexOf(fn);
    const body = c.slice(i, c.indexOf('return outcome;', i));
    return i >= 0 && body.indexOf('mitFotosVorab(') > 0 && body.indexOf('mitFotosVorab(') < body.indexOf('runRemoteCommand(');
  };
  ok(vorKlammer('src/core/bridge/commercial-commands.ts', 'export async function runPurchaseCreate'), 'G PC2 Einkauf: Aufnahme VOR runRemoteCommand');
  ok(vorKlammer('src/core/bridge/commercial-commands.ts', 'export async function runOrderCreate'), 'G PC2 Auftrag: Aufnahme VOR runRemoteCommand');
  ok(vorKlammer('src/core/bridge/order-lifecycle-commands.ts', 'export async function runOrderLineEdit'), 'G PC2 Auftragszeile: Aufnahme VOR runRemoteCommand');
  ok(vorKlammer('src/core/bridge/purchase-edit-commands.ts', 'export async function runPurchaseEdit'), 'G PC2 Edit Purchase: Aufnahme VOR runRemoteCommand');
  for (const f of ['src/core/purchases/purchase-house.ts', 'src/core/orders/order-house.ts', 'src/core/orders/order-lifecycle-house.ts']) {
    ok(/prepareNewItemSpec\(/.test(code(src(f))) && !/normalizeSpecImages\(/.test(code(src(f))), `G ${f}: Primary über prepareNewItemSpec`);
  }
  const cut = code(src('src/core/media/product-media-cutover.ts'));
  ok((cut.match(/imageBytes: bytes,\n\s*sizeProfile,\n/g) ?? []).length === 3 && (cut.match(/this\.hashOf\(bytes, this\.tenantId, sizeProfile\)/g) ?? []).length === 3,
    'G Cutover-Dienst: alle drei Aufnahmen mit Größenklasse (Altartikel bearbeiten, Speicherpflege, Nachlauf)');
}

console.log(`\nnew-item-direct-cas: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const x of fails) console.log('  - ' + x); process.exit(1); }
console.log('NEW_ITEM_DIRECT_CAS_PROVED');
process.exit(0);
