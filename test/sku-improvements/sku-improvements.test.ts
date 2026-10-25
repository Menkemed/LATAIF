// ════════════════════════════════════════════════════════════════════════════
// v0.8.91 — SKU-VERBESSERUNGEN. Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema),
// echte Stores, echte Hausfolgen, echte Brücke — wie purchase-edit / product-remote-write.
// Run: node --experimental-strip-types test/sku-improvements/sku-improvements.test.ts
//
//   A  Vorschau `products.sku_preview.get`: dieselbe Nummer wie der Zähler, verbraucht nichts, enger Rumpf
//   B  „Find Next SKU" am Primary: Vergabe beim Speichern, vorhandene SKU nie ersetzt, eingetippte gewinnt,
//      verkaufter Artikel ohne Grund → Nein OHNE verbrauchte Nummer, belegte Nummer wird übersprungen
//   C  „Find Next SKU" von PC2 (`products.update` mit `assignSku: true`): Primary vergibt, Wiederholung vergibt
//      nicht doppelt, `sku` bleibt als Eingabe verboten
//   D  Back-to-Back: der Auftragsartikel bekommt die SKU erst beim Wareneingang; andere Altartikel nicht
//   E  Produktion: ein Ausgang ohne SKU bekommt eine aus dem Zähler, eine eingetippte bleibt
//   F  Pins: Import, Auftrag-Storno, Auftragszeilen ohne Vergabe, Masken (Vorschau überall, auch PC2), Rust
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
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { buildSkuSeed } = await import('../../src/core/products/sku-allocation.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
await import('../../src/core/automation/automation-handlers.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore, SKU_ALREADY_SET } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { runProductUpdate, parseProductUpdate } = await import('../../src/core/bridge/product-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
const { READ_PERMISSIONS } = await import('../../src/core/bridge/command-permissions.ts');
const { createPurchaseInHouse } = await import('../../src/core/purchases/purchase-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = new Date().toISOString();
// Relativ zu heute (kein fester Tag, der später in die Zukunft oder hinter einen Stichtag rutscht).
const TODAY = NOW.slice(0, 10);

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const skuOf = (db: Db, id: string): string => s(db, 'SELECT sku FROM products WHERE id = ?', [id]);
/** Der ganze Zähler — eine Vorschau oder ein Nein darf ihn nicht bewegen. */
const counter = (db: Db): string => S(db.exec('SELECT stem, next_number FROM sku_sequences ORDER BY stem')[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  usePurchaseStore.getState().loadPurchases();
  useInvoiceStore.getState().loadInvoices();
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
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Test','Kunde','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant A',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  useProductStore.getState().loadCategories();
  tauriState.reset();
  return db;
}

/** Ein Artikel, wie ihn ein alter Bestand oder ein Auftrag hinterlässt — ohne SKU (oder mit), mit Los. */
function artikel(db: Db, id: string, o: { sku?: string | null; brand?: string; status?: string; lot?: boolean } = {}): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w',?,?,?,1,'Pre-Owned','[]',100,'BHD',150,?,'MARGIN',0,'[]','{}','OWN',?,?)`,
  [id, o.brand ?? 'Rolex', 'M ' + id, o.sku ?? null, o.status ?? 'in_stock', NOW, NOW]);
  if (o.lot !== false) {
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,'branch-main',?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, id, NOW, NOW]);
  }
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
async function imHausAsync<T>(fn: () => Promise<T>): Promise<T> {
  posting.beginLedgerTransaction();
  try { const out = await fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
const ID = (n: string): string => `${n.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACT = { commandId: ID('90'), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', payloadHash: 'h90' };
const identity = (n: string, hash = 'h' + n) => ({
  commandId: ID(n), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op: 'products.update', payloadHash: hash,
});
function deps(db: Db) {
  return {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* der Test speichert nicht auf Platte */ },
    now: () => NOW,
  };
}
const SEED = buildSkuSeed('Rolex', 'cat-w');
const STEM = SEED.replace(/\d+$/, '');
const peek = (): string => useProductStore.getState().peekSku(SEED);
const vorschau = (input: Record<string, unknown>, actor: Record<string, unknown> | undefined = ACT) =>
  executeCommand('products.sku_preview.get', { ...(actor ? { actor } : {}), input }, undefined);

// ══ A — die Vorschau ════════════════════════════════════════════════════════════
{
  const db = freshDb();
  artikel(db, 'pA1', { sku: `${STEM}001` });
  reload();
  const vor = counter(db);
  const r = await vorschau({ seed: SEED });
  const nr = (r as { value?: { sku?: string } }).value?.sku ?? '';
  ok(r.kind === 'ok' && nr === peek() && nr.startsWith(STEM) && nr !== `${STEM}001`,
    `A die Vorschau nennt die nächste freie Nummer aus dem Zähler, die belegte 001 nicht (${S(r)})`);
  await vorschau({ seed: SEED });
  ok(counter(db) === vor, `A …und verbraucht nichts, auch zweimal gefragt (${vor} → ${counter(db)})`);
  const fremd = await vorschau({ seed: SEED, branchId: 'branch-two' });
  ok(fremd.kind === 'business_error' && (fremd as { code: string }).code === 'UNKNOWN_FIELD', `A ein fremdes Feld wird abgewiesen (${S(fremd)})`);
  const leer = await vorschau({ seed: '   ' });
  ok(leer.kind === 'business_error' && (leer as { code: string }).code === 'INVALID_INPUT', `A ein leerer Stamm wird abgewiesen (${S(leer)})`);
  const lang = await vorschau({ seed: 'X'.repeat(65) });
  ok(lang.kind === 'business_error' && (lang as { code: string }).code === 'INVALID_INPUT', 'A …ein zu langer auch');
  const ohne = await vorschau({ seed: SEED }, { ...ACT, branchId: '' });
  ok(ohne.kind !== 'ok' && counter(db) === vor, `A ohne geprüfte Filiale keine Antwort (${S(ohne)})`);
  ok('products.sku_preview.get' in READ_PERMISSIONS && (READ_PERMISSIONS as Record<string, unknown>)['products.sku_preview.get'] === null,
    'A jede Rolle darf fragen (wie die Duplikatsauskunft)');
}

// ══ B — „Find Next SKU" am Primary ═════════════════════════════════════════════════
{
  const db = freshDb();
  artikel(db, 'pB1');
  artikel(db, 'pB2');
  artikel(db, 'pB3', { sku: 'OWN-777' });
  artikel(db, 'pB4');
  reload();
  const ps = () => useProductStore.getState();

  const erwartet = peek();
  const r1 = await ps().editProductTextDurably('pB1', {}, { assignSku: true });
  ok(r1.status === 'edited' && skuOf(db, 'pB1') === erwartet, `B die Vorschau ist die vergebene Nummer (${erwartet} / ${skuOf(db, 'pB1')} / ${S(r1)})`);
  ok(peek() !== erwartet && peek().startsWith(STEM), `B …und erst das Speichern verbraucht sie (nächste ${peek()})`);
  ok(s(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = 'pB1' AND new_value LIKE ?", [`%${erwartet}%`]) !== '0',
    'B …mit Protokoll am Artikel');

  const r2 = await ps().editProductTextDurably('pB2', { notes: 'geprüft' }, { assignSku: true });
  ok(r2.status === 'edited' && skuOf(db, 'pB2').startsWith(STEM) && skuOf(db, 'pB2') !== skuOf(db, 'pB1')
    && s(db, "SELECT notes FROM products WHERE id = 'pB2'") === 'geprüft',
  `B zwei Artikel: zwei verschiedene Nummern, die Textänderung reist mit (${skuOf(db, 'pB1')} / ${skuOf(db, 'pB2')})`);

  const vorB3 = counter(db);
  const r3 = await ps().editProductTextDurably('pB3', {}, { assignSku: true });
  ok(r3.status === 'blocked' && (r3 as { errorCode?: string }).errorCode === SKU_ALREADY_SET && skuOf(db, 'pB3') === 'OWN-777'
    && counter(db) === vorB3,
  `B eine vorhandene SKU wird nie ersetzt — Nein, keine Nummer verbraucht (${S(r3)})`);

  const vorB4 = counter(db);
  const r4 = await ps().editProductTextDurably('pB4', { sku: 'HAND-42' }, { assignSku: true });
  ok(r4.status === 'edited' && skuOf(db, 'pB4') === 'HAND-42' && counter(db) === vorB4,
    `B eine eingetippte SKU gewinnt, der Zähler bleibt (${skuOf(db, 'pB4')})`);

  // Eine Nummer, die jemand von Hand belegt hat, wird übersprungen — keine doppelte SKU.
  const naechste = peek();
  artikel(db, 'pB5', { sku: naechste });
  artikel(db, 'pB6');
  reload();
  const r6 = await ps().editProductTextDurably('pB6', {}, { assignSku: true });
  ok(r6.status === 'edited' && skuOf(db, 'pB6') !== naechste && skuOf(db, 'pB6').startsWith(STEM)
    && s(db, 'SELECT COUNT(*) FROM products WHERE UPPER(sku) = UPPER(?)', [skuOf(db, 'pB6')]) === '1',
  `B eine schon belegte Nummer wird übersprungen (${naechste} belegt → ${skuOf(db, 'pB6')})`);

  // Ein verkaufter Artikel ohne SKU: die SKU ist eine Druckangabe → ohne Grund ein Nein, und das Nein kostet keine Nummer.
  artikel(db, 'pB7');
  reload();
  imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{
    productId: 'pB7', quantity: 1, unitPrice: 300, purchasePrice: 100, taxScheme: 'MARGIN', vatRate: 0, vatAmount: 0, lineTotal: 300,
  }] as never, 'SKU', `${TODAY}T08:00:00.000Z`));
  reload();
  const vorB7 = counter(db);
  const r7 = await ps().editProductTextDurably('pB7', {}, { assignSku: true });
  ok(r7.status === 'blocked' && (r7 as { errorCode?: string }).errorCode === 'PRODUCT_EDIT_REASON_REQUIRED'
    && skuOf(db, 'pB7') === '' && counter(db) === vorB7,
  `B verkaufter Artikel ohne Grund: Nein, keine SKU, keine Nummer verbraucht (${S(r7)} / ${vorB7} → ${counter(db)})`);
  const mitGrund = peek();
  const r7b = await ps().editProductTextDurably('pB7', {}, { assignSku: true, editReason: 'Etikett nachträglich nummeriert' });
  ok(r7b.status === 'edited' && skuOf(db, 'pB7') === mitGrund, `B …mit Grund bekommt er genau die angezeigte Nummer (${skuOf(db, 'pB7')})`);

  // Ohne Absicht bleibt ein Altartikel ohne SKU ohne SKU — keine Massennummerierung beim Bearbeiten.
  artikel(db, 'pB8');
  reload();
  const vorB8 = counter(db);
  const r8 = await ps().editProductTextDurably('pB8', { notes: 'nur Notiz' });
  ok(r8.status === 'edited' && skuOf(db, 'pB8') === '' && counter(db) === vorB8, 'B normales Bearbeiten nummeriert nichts');
}

// ══ C — „Find Next SKU" von PC2 ════════════════════════════════════════════════════
{
  const db = freshDb();
  artikel(db, 'pC1');
  artikel(db, 'pC2', { sku: 'OWN-1' });
  reload();
  const d = deps(db);
  const erwartet = peek();
  const r = await runProductUpdate(d, identity('1'), { id: 'pC1', assignSku: true });
  ok(r.kind === 'ok' && skuOf(db, 'pC1') === erwartet, `C PC2 schickt nur die Absicht, der Primary vergibt seine Nummer (${S(r)} / ${skuOf(db, 'pC1')})`);
  const nachher = counter(db);
  const wdh = await runProductUpdate(d, identity('1'), { id: 'pC1', assignSku: true });
  ok(wdh.kind === 'ok' && (wdh as { replayed?: boolean }).replayed === true && counter(db) === nachher && skuOf(db, 'pC1') === erwartet,
    'C die Wiederholung desselben Auftrags vergibt nicht noch einmal');
  const schon = await runProductUpdate(d, identity('2'), { id: 'pC2', assignSku: true });
  ok(schon.kind === 'rejected' && (schon as { code?: string }).code === SKU_ALREADY_SET && skuOf(db, 'pC2') === 'OWN-1' && counter(db) === nachher,
    `C eine vorhandene SKU bleibt, auch von PC2 (${S(schon)})`);
  const meldung = (raw: unknown): string => { try { parseProductUpdate(raw); return ''; } catch (e) { return String((e as Error).message); } };
  ok(/assignSku/.test(meldung({ id: 'pC1', assignSku: false })) && /assignSku/.test(meldung({ id: 'pC1', assignSku: 'ROL-WCH-009' })),
    'C assignSku ist nur eine Absicht (true) — keine Nummer, kein false');
  ok(/primary decides sku/.test(meldung({ id: 'pC1', sku: 'ROL-WCH-009' })), 'C die Nummer selbst bleibt eine verbotene Eingabe');
  ok(meldung({ id: 'pC1', aiConfirmedAt: true, assignSku: true }) !== '', 'C …und reist nicht mit der KI-Bestätigung');
  ok(meldung({ id: 'pC1', assignSku: true }) === '' && meldung({ id: 'pC1' }) !== '', 'C allein ist sie eine Änderung; ohne sie bleibt „nothing to change"');
}

// ══ D — Back-to-Back: SKU erst beim Wareneingang ════════════════════════════════════
{
  const db = freshDb();
  artikel(db, 'pOrd', { status: 'reserved', lot: false });
  artikel(db, 'pOrdSku', { sku: 'ORD-OWN-1', status: 'reserved', lot: false });
  artikel(db, 'pAlt', { lot: false });
  db.run(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model, status, created_at, updated_at)
    VALUES ('ord-1','branch-main','ORD-1','cust-1','Rolex','Datejust','pending',?,?)`, [NOW, NOW]);
  for (const [lid, pid, pos] of [['ol-1', 'pOrd', 1], ['ol-2', 'pOrdSku', 2]] as const) {
    db.run(`INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position, created_at)
      VALUES (?,?,?,?,1,500,500,?,?)`, [lid, 'ord-1', pid, 'Rolex ' + pid, pos, NOW]);
  }
  reload();
  ok(skuOf(db, 'pOrd') === '', 'D vorher: der Auftragsartikel hat keine SKU (Auftrag vergibt keine)');
  const erwartet = peek();
  const line = (productId: string, sourceOrderLineId?: string) => ({
    mode: 'existing' as const, productId, brand: 'Rolex', name: 'M', sku: '', categoryId: 'cat-w', quantity: 1, unitPrice: 400,
    ...(sourceOrderLineId ? { sourceOrderLineId } : {}),
  });
  imHaus(() => createPurchaseInHouse({
    supplierId: 'sup-1', purchaseDate: TODAY, taxScheme: 'ZERO', paymentAmount: 0, paymentMethod: 'cash', notes: '', staffId: '',
    sourceOrderId: 'ord-1', lines: [line('pOrd', 'ol-1'), line('pOrdSku', 'ol-2')],
  }, 'branch-main', 'user-test'));
  reload();
  ok(skuOf(db, 'pOrd') === erwartet, `D mit dem Wareneingang bekommt er die nächste SKU aus dem Zähler (${skuOf(db, 'pOrd')} / erwartet ${erwartet})`);
  ok(skuOf(db, 'pOrdSku') === 'ORD-OWN-1', 'D …eine vorhandene SKU am Auftragsartikel bleibt');
  const vor = counter(db);
  imHaus(() => createPurchaseInHouse({
    supplierId: 'sup-1', purchaseDate: TODAY, taxScheme: 'ZERO', paymentAmount: 0, paymentMethod: 'cash', notes: '', staffId: '',
    lines: [line('pAlt')],
  }, 'branch-main', 'user-test'));
  reload();
  ok(skuOf(db, 'pAlt') === '' && counter(db) === vor, 'D ein anderer Altartikel ohne SKU wird beim Nachkauf NICHT nummeriert');
}

// ══ E — Produktion ═════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  artikel(db, 'pIn1', { sku: 'IN-1' });
  artikel(db, 'pIn2', { sku: 'IN-2' });
  reload();
  const seed = buildSkuSeed('Custom', 'cat-w');
  const erwartet = useProductStore.getState().peekSku(seed);
  const OUT = (sku?: string) => ({ spec: { categoryId: 'cat-w', brand: 'Custom', name: 'Ring X', condition: 'New', taxScheme: 'MARGIN', attributes: {}, images: [], ...(sku ? { sku } : {}) }, value: 100 });
  const made = await imHausAsync(() => createProductionInHouse(
    { inputProductIds: ['pIn1'], outputs: [OUT()] as never, productionDate: TODAY }, { branchId: 'branch-main', userId: 'user-test' }));
  const out1 = made.outputProductIds[0];
  ok(skuOf(db, out1) === erwartet && erwartet !== '', `E ein Ausgang ohne SKU bekommt die nächste aus dem Zähler (${skuOf(db, out1)} / ${erwartet})`);
  const made2 = await imHausAsync(() => createProductionInHouse(
    { inputProductIds: ['pIn2'], outputs: [OUT('RING-OWN-1')] as never, productionDate: TODAY }, { branchId: 'branch-main', userId: 'user-test' }));
  ok(skuOf(db, made2.outputProductIds[0]) === 'RING-OWN-1', 'E eine eingetippte SKU bleibt');
  ok(skuOf(db, 'pIn1') === 'IN-1', 'E die Eingänge behalten ihre SKU');
}

// ══ F — Pins ═══════════════════════════════════════════════════════════════════════
{
  const imp = src('src/pages/settings/ImportPage.tsx');
  ok(/sku: item\.sku \|\| \(item\.isSold \? undefined : \(allocateSkuOnCreate\(undefined, item\.brand, item\.categoryId\) \|\| undefined\)\)/.test(imp),
    'F Import: Lagerzeilen ohne SKU über den zentralen Zähler, verkaufte Zeilen und eingetippte SKUs nicht');
  const ord = src('src/stores/orderStore.ts');
  ok(/sku: skuIsEmpty\(spec\.sku\) \? \(useProductStore\.getState\(\)\.allocateSkuOnCreate\(undefined, stockBrand, stockCategory\) \|\| undefined\) : spec\.sku/.test(ord)
    && /stockStatus: 'in_stock',  \/\/ frei verkaeuflich/.test(ord),
    'F Auftrag-Storno mit angefangener Arbeit: das Lagerstück bekommt die SKU (Übernahme in den Bestand)');
  const conv = src('src/core/orders/order-invoice-lines.ts');
  const psSrc = src('src/stores/productStore.ts');
  const createImpl = psSrc.slice(psSrc.indexOf('  createProduct: (data) => {'), psSrc.indexOf('  createProduct: (data) => {') + 3000);
  ok(/sku: spec\.sku,/.test(conv) && /stockStatus: 'reserved',/.test(conv) && !/allocateSku/.test(conv)
    && createImpl.length > 0 && !/allocateSku/.test(createImpl),
  "F Umwandeln in eine Rechnung ('reserved', kein Lagerdurchlauf) vergibt keine SKU — createProduct selbst auch nicht");
  for (const p of ['src/pages/orders/OrderCreate.tsx', 'src/components/work-orders/OrderLineEditModal.tsx']) {
    ok(!/skuAutoAssign/.test(src(p)), `F reine Auftragszeilen bekommen keine Vorschau/Vergabe (${p})`);
  }
  for (const p of ['src/pages/purchases/PurchaseCreate.tsx', 'src/pages/production/ProductionPage.tsx']) {
    ok(/<NewProductModal[\s\S]*?skuAutoAssign[\s\S]*?\/>/.test(src(p)), `F ${p}: die Maske zeigt die Nummer, die vergeben wird`);
  }
  for (const p of ['src/pages/watches/WatchList.tsx', 'src/pages/consignments/ConsignmentList.tsx']) {
    ok(/previewSeed=\{buildSkuSeed\(/.test(src(p)), `F ${p}: dieselbe Vorschau`);
  }
  const nm = src('src/components/products/NewProductModal.tsx');
  ok(/previewSeed=\{skuAutoAssign \? buildSkuSeed\(form\.brand, form\.categoryId\) : undefined\}/.test(nm), 'F NewProductModal: Vorschau nur, wo vergeben wird');
  const si = src('src/components/ui/SkuInput.tsx');
  ok(/remoteRead<\{ sku\?: unknown \}>\('products\.sku_preview\.get', \{ seed: s \}\)/.test(si) && /\.catch\(\(\) => \{ if \(alive\) setAnswer\(''\); \}\)/.test(si)
    && /if \(!readsFromPrimary\(\)\) \{ if \(alive\) setAnswer\(peekSku\(s\)\); return; \}/.test(si) && !/fetchFromPrimary/.test(si),
  'F SkuInput: am Primary der eigene Zähler, auf PC2 der des Primary (C2-Antwort `{ sku }`, nicht `{ data }`) — dieselbe Vorschau');
  // Die Antwortform, die PC2 liest: genau `{ sku }` (remoteRead liefert `value` unverändert).
  {
    const db = freshDb();
    artikel(db, 'pF1');
    reload();
    const r = await vorschau({ seed: SEED });
    ok(r.kind === 'ok' && S(Object.keys((r as { value: Record<string, unknown> }).value)) === S(['sku']),
      `F die Auskunft antwortet mit genau { sku } (${S(r)})`);
  }
  const pd = src('src/pages/watches/ProductDetail.tsx');
  ok(/data-find-next-sku/.test(pd) && /Find Next SKU/.test(pd) && /skuIsEmpty\(product\.sku\) && skuIsEmpty\(form\.sku\) && \(/.test(pd),
    'F ProductDetail: der Knopf nur für einen Artikel ohne SKU und bei leerem Feld');
  ok(/const skuVergeben = skuAuto && skuIsEmpty\(product\?\.sku\) && skuIsEmpty\(form\.sku\);/.test(pd)
    && /remote: \(\) => \(\{ id, \.\.\.diff, \.\.\.zusatz \}\)/.test(pd) && /remote: \(\) => \(\{ id, \.\.\.textDiff, gallery, \.\.\.zusatz \}\)/.test(pd)
    && /Object\.keys\(diff\)\.length === 0 && !skuVergeben/.test(pd),
  'F ProductDetail: beide Speicherwege (Text/Bild, lokal/PC2) tragen nur die Absicht; der Knopf allein ist eine Änderung');
  ok(!/setForm\(\{ \.\.\.form, sku: (preview|suggestion|peek)/.test(pd), 'F ProductDetail: die Vorschau wird nie als getippte SKU in die Maske geschrieben');
  const pc = src('src/core/bridge/product-commands.ts');
  ok(/const FORBIDDEN = \[[\s\S]*?'sku'/.test(pc), 'F products.update: sku bleibt verboten');
  const rs = src('src-tauri/src/bridge.rs');
  ok(/pub const OP_PRODUCTS_SKU_PREVIEW_GET: &str = "products\.sku_preview\.get";/.test(rs)
    && /OP_PAGE_COST_CORRECTIONS_GET,\s*\/\/ v0\.8\.91[^\n]*\n\s*OP_PRODUCTS_SKU_PREVIEW_GET,\s*\];/.test(rs),
  'F Rust lässt die Vorschau namentlich durch (am Ende der Liste)');
}

console.log(`\nsku-improvements: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
