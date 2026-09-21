// ════════════════════════════════════════════════════════════════════════════
// MEDIA-LEGACY-SYNC — ein veralteter Rechner darf alte Bildfelder nicht zurueckschreiben.
// Run: node test/media-business/legacy-peer-sync.test.ts
//
//   §1 Reparatur: alle entfernt  §1b nur Altbestand, alle entfernt  §2 Posteingang umgewandelt
//   §3 Auftrag umgewandelt  §4 nicht-mediale Felder derselben Aenderung kommen durch
//   §5 neuer Datensatz behaelt sein Foto  §6 eigenes Echo  §7 Dokument  §8 Altgold  §9 Lieferant
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })]]);
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema, MEDIA_ENTITY_SCOPE } = await import('../../src/core/db/media-schema.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useScrapTradeStore } = await import('../../src/stores/scrapTradeStore.ts');
const orderHouse = await import('../../src/core/orders/order-house.ts');
const orderMedia = await import('../../src/core/orders/order-media.ts');
const scrapMedia = await import('../../src/core/metals/scrap-media.ts');
const metalActions = await import('../../src/core/metals/metal-actions.ts');
const metalCmd = await import('../../src/core/bridge/metal-commands.ts');
const commercial = await import('../../src/core/bridge/commercial-commands.ts');
const inboxMedia = await import('../../src/core/purchases/inbox-media.ts');
const lifecycleHouse = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const lifecycleCmd = await import('../../src/core/bridge/purchase-lifecycle-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const pageReads = await import('../../src/core/data/page-reads.ts');
const pulled = await import('../../src/core/sync/pulled-record-images.ts');
const applyChange = await import('../../src/core/sync/apply-change.ts');
const repairHouse = await import('../../src/core/repairs/repair-house.ts');
const repairMedia = await import('../../src/core/repairs/repair-media.ts');
const docMedia = await import('../../src/core/office/document-media.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const NOW = '2026-09-20T10:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
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

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL); db.run(COMMAND_LEDGER_INDEX); db.run(SKU_SEQUENCES_DDL);
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Uhren','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','H','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','L',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useCustomerStore.getState().loadCustomers();
  useProductStore.getState().loadProducts();
  useSupplierStore.getState().loadSuppliers();
  tauriState.reset();
  return db;
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const OWNER = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
const identity = (x: string, op: string) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW,
});
const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 53 + i * 3) & 0xff);
const url = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const ablegen = (b: Uint8Array): string => stageForTest(b, OWNER);

const linksOf = (db: Db, type: string, id: string, role?: string): string[] =>
  (db.exec(
    `SELECT media_id FROM media_links WHERE entity_type = ? AND entity_id = ?${role ? ' AND media_role = ?' : ''} AND deleted_at IS NULL ORDER BY sort_order`,
    role ? [type, id, role] : [type, id],
  )[0]?.values ?? []).map((v) => String(v[0]));
const objekte = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_objects');
const dateien = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_blob_generations');
/** Ein geworfenes Nein ist auch ein Ausgang — hier wird es einer, statt den Lauf zu beenden. */
async function fern(fn: () => Promise<{ kind: string; code?: string }>): Promise<{ kind: string; code: string }> {
  try { const o = await fn(); return { kind: o.kind, code: String(o.code ?? '') }; }
  catch (e) { return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? (e as Error).message) }; }
}

type Change = { table_name: string; record_id: string; action: string; data: string };
const chg = (table: string, id: string, action: string, data: Record<string, unknown>): Change =>
  ({ table_name: table, record_id: id, action, data: JSON.stringify(data) });
/** Genau der Weg des Abholens: vorbereiten (mit dem Media-Vertrag), dann die ECHTE Übernahme. */
async function abholen(db: Db, changes: Change[]): Promise<{ ignored: number; rejected: number }> {
  const stored = (table: string, id: string, column: string): unknown =>
    db.exec(`SELECT ${column} FROM ${table} WHERE id = ?`, [id])[0]?.values?.[0]?.[0];
  const p = await pulled.prepareRecordImages(changes, stored, pulled.syncMediaGovernance(db as never));
  for (const c of p.changes) applyChange.applySyncChange(db as never, c as never);
  return { ignored: p.ignoredLegacy, rejected: p.rejected.size };
}
const altbild = (seed: number): string => url(bild(seed));
const links = (db: Db, type: string, id: string): number =>
  n(db, 'SELECT COUNT(*) FROM media_links WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL', [type, id]);

// ── §1 Reparatur: alle Fotos entfernt — ein alter Rechner spielt sie zurück ─────────────────
{
  const db = freshDb();
  const r = await repairHouse.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Glas', repairType: 'internal',
    estimatedCost: 10, chargeToCustomer: 40, images: [altbild(1), altbild(2)],
  } as never);
  ok(links(db, 'repair', r.id) === 2, '§1 die Reparatur führt ihre Fotos im Medienkern');
  repairMedia.applyRepairGallery(r.id, []);
  ok(links(db, 'repair', r.id) === 0 && s(db, 'SELECT images FROM repairs WHERE id = ?', [r.id]) === '[]',
    '§1 „alle entfernt": keine Verknüpfung, leere Altspalte');

  const aus = await abholen(db, [chg('repairs', r.id, 'update', { id: r.id, images: JSON.stringify([altbild(1), altbild(2)]), notes: 'vom alten Rechner' })]);
  ok(s(db, 'SELECT images FROM repairs WHERE id = ?', [r.id]) === '[]',
    '§1 die alten Bilder des veralteten Rechners werden NICHT wieder der aktuelle Stand');
  ok(links(db, 'repair', r.id) === 0, '§1 …und es entsteht auch kein neues Medium daraus');
  ok(s(db, 'SELECT notes FROM repairs WHERE id = ?', [r.id]) === 'vom alten Rechner',
    '§4 das nicht-mediale Feld derselben Änderung wird übernommen wie bisher');
  ok(aus.ignored === 1 && aus.rejected === 0, `§1 die Absage ist gezählt, nichts in Quarantäne (${aus.ignored}/${aus.rejected})`);
}

// ── §1b Reparatur nur mit Altbestand: der Mensch hat alles entfernt, ohne dass es je ein Medium gab
{
  const db = freshDb();
  // Eine Reparatur, wie sie vor dem Umbau entstand: das Foto in der Spalte.
  const r = await repairHouse.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Band', repairType: 'internal',
    estimatedCost: 5, chargeToCustomer: 20, images: [],
  } as never);
  db.run('UPDATE repairs SET images = ? WHERE id = ?', [JSON.stringify([altbild(3)]), r.id]);
  // Die neue Anwendung übernimmt den Altbestand — hier: der Mensch entfernt ALLES.
  repairMedia.applyRepairGallery(r.id, []);
  ok(s(db, 'SELECT images FROM repairs WHERE id = ?', [r.id]) === '[]' && n(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ?', [r.id]) === 0,
    '§1b danach: leere Spalte und KEINE einzige Verknüpfung — nichts, woran ein Datensatz-Merkmal hinge');
  await abholen(db, [chg('repairs', r.id, 'update', { id: r.id, images: JSON.stringify([altbild(3)]) })]);
  ok(s(db, 'SELECT images FROM repairs WHERE id = ?', [r.id]) === '[]',
    '§1b auch dann kommt das Altbild nicht zurück: für einen BESTEHENDEN Datensatz ist die Spalte nicht abgleichbar');
}

// ── §2 Posteingang: umgewandelt — ein alter Rechner schickt das Foto noch einmal ────────────
{
  const db = freshDb();
  const st = ablegen(bild(10));
  await lifecycleCmd.runInboxCreate(deps(db), identity('301', 'purchase_inbox.create'), { photos: [{ stagingId: st }] });
  const inboxId = s(db, 'SELECT id FROM purchase_inbox');
  const medium = s(db, "SELECT media_id FROM media_links WHERE entity_type = 'purchase_inbox' AND deleted_at IS NULL");
  const p = useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'X', name: 'Y', images: [] } as never);
  inboxMedia.adoptInboxPhotosToProduct(inboxId, p.id);
  ok(links(db, 'purchase_inbox', inboxId) === 0 && links(db, 'product', p.id) === 1, '§2 das Foto ist zum Artikelbild geworden');

  const aus = await abholen(db, [chg('purchase_inbox', inboxId, 'update', { id: inboxId, images: JSON.stringify([altbild(10)]), note: 'Notiz vom alten Rechner' })]);
  ok(s(db, 'SELECT images FROM purchase_inbox WHERE id = ?', [inboxId]) === '[]',
    '§2 der Posteingang bekommt sein Altfoto NICHT zurück');
  ok(links(db, 'purchase_inbox', inboxId) === 0 && s(db, "SELECT media_id FROM media_links WHERE entity_type = 'product' AND deleted_at IS NULL") === medium,
    '§2 …der Medien-Stand bleibt die Wahrheit: dasselbe Objekt am Artikel, keins am Eintrag');
  ok(s(db, 'SELECT note FROM purchase_inbox WHERE id = ?', [inboxId]) === 'Notiz vom alten Rechner',
    '§4 …die Notiz derselben Änderung kommt durch');
  ok(aus.ignored === 1, '§2 gezählt');
}

// ── §3 Auftrag: umgewandelt — ein alter Rechner schickt den Entwurf mit Vorlagenbild ────────
{
  const db = freshDb();
  const made = await orderHouse.createOrderOnPrimary({
    customerId: 'cust-1', orderType: 'custom', quotedPrice: 500, finalProductDescription: 'Ring',
    lines: [{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }],
    customProductSpec: { categoryId: 'cat-w', brand: 'Eigen', name: 'Ring', sku: '', condition: 'New', taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {}, images: [altbild(20)] },
    customTaxScheme: 'MARGIN', customerGoldGrams: 0, customerGoldKarat: '22K', customerStones: '', goldsmithSupplierId: '',
    laborCost: 0, extraGoldGrams: 0, extraGoldKarat: '22K', extraGoldCost: 0, extraGoldSupplierId: '', materials: [],
    depositAmount: 0, paymentMethod: 'cash', cardBrand: 'normal', fullyPaid: false, expectedDelivery: '', status: 'pending', notes: '',
  } as never);
  const orderId = made.order.id;
  const p = useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Eigen', name: 'Ring', images: [] } as never);
  orderMedia.adoptOrderPhotosToProduct(orderId, p.id);
  const vorher = JSON.parse(s(db, 'SELECT custom_product_spec FROM orders WHERE id = ?', [orderId]));
  ok(Array.isArray(vorher.images) ? vorher.images.length === 0 : vorher.images === undefined,
    '§3 der Entwurf trägt nach der Umwandlung keine Bilder');

  const altEntwurf = { ...vorher, brand: 'NEU', images: [altbild(20)] };
  const aus = await abholen(db, [chg('orders', orderId, 'update', { id: orderId, custom_product_spec: JSON.stringify(altEntwurf) })]);
  const danach = JSON.parse(s(db, 'SELECT custom_product_spec FROM orders WHERE id = ?', [orderId]));
  ok(!Array.isArray(danach.images) || danach.images.length === 0,
    `§3 das Vorlagenbild kommt NICHT in den Entwurf zurück (${JSON.stringify(danach.images ?? null)})`);
  ok(danach.brand === 'NEU' && danach.categoryId === 'cat-w',
    '§4 …aber der übrige Entwurf derselben Änderung wird übernommen');
  // Der Auftrag BEHÄLT seine Vorlage als Verknüpfung (so ist die Übernahme gebaut: er hat sein Stück so
  // beschrieben). Entscheidend ist, dass der Abgleich an diesem Medien-Stand nichts ändert.
  ok(links(db, 'product', p.id) === 1 && links(db, 'order', orderId) === 1
    && n(db, 'SELECT COUNT(*) FROM media_objects') === 1,
  '§3 der Medien-Stand bleibt die Wahrheit: dieselben Verknüpfungen, kein zusätzliches Objekt');
  ok(aus.ignored === 1, '§3 gezählt');
}

// ── §5 Ein NEUER Datensatz eines alten Rechners: sein Foto geht nicht verloren ──────────────
{
  const db = freshDb();
  const aus = await abholen(db, [chg('purchase_inbox', 'inbox-vom-alten', 'insert', {
    id: 'inbox-vom-alten', branch_id: 'branch-main', images: JSON.stringify([altbild(30)]), note: 'neu', status: 'pending', created_at: NOW,
  })]);
  const bilder = JSON.parse(s(db, "SELECT images FROM purchase_inbox WHERE id = 'inbox-vom-alten'") || '[]');
  ok(bilder.length === 1, '§5 ein Eintrag, den es am Primary noch nicht gab, bringt sein Foto als Altbestand mit');
  ok(aus.ignored === 0, '§5 …das ist keine Wiederbelebung und wird nicht als solche gezählt');
}

// ── §6 Das eigene Echo des Primary zählt nicht, ändert nichts ──────────────────────────────
{
  const db = freshDb();
  const r = await repairHouse.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Krone', repairType: 'internal',
    estimatedCost: 5, chargeToCustomer: 20, images: [],
  } as never);
  const aus = await abholen(db, [chg('repairs', r.id, 'update', { id: r.id, images: '[]' })]);
  ok(aus.ignored === 0 && s(db, 'SELECT images FROM repairs WHERE id = ?', [r.id]) === '[]',
    '§6 das zurückgespielte eigene `[]` ist kein Fall — nichts gezählt, nichts verändert');
}

// ── §7 Dokument: eine Medien-PDF bleibt, ein Bilddokument bleibt abgleichbar ────────────────
{
  const db = freshDb();
  db.run("INSERT INTO documents (id, branch_id, file_name, file_path, file_type, file_size, doc_class, created_at) VALUES ('d-pdf','branch-main','a.pdf','','application/pdf',9,'invoice',?)", [NOW]);
  db.run("INSERT INTO documents (id, branch_id, file_name, file_path, file_type, file_size, doc_class, created_at) VALUES ('d-img','branch-main','a.png','data:image/png;base64,AAAA','image/png',3,'photo',?)", [NOW]);
  // Die PDF wird vom Medienkern geführt — hier genügt die Verknüpfung, wie der Beleg-Befehl sie anlegt.
  db.run(`INSERT INTO media_blob_generations (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash, byte_size, content_kind, mime_type, extension, is_encrypted, gen_status, created_at)
          VALUES ('tenant-1','blob-d',1,'tenant-1/aa/x.pdf','${'a'.repeat(64)}',9,'pdf','application/pdf','pdf',0,'available',?)`, [NOW]);
  db.run("INSERT INTO media_blobs (tenant_id, blob_id, dedup_token, current_generation_no, blob_status, created_at, updated_at) VALUES ('tenant-1','blob-d','t-d',1,'present',?,?)", [NOW, NOW]);
  db.run("INSERT INTO media_objects (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind, source_type, security_class, retention_class, ingest_status, created_at, updated_at) VALUES ('tenant-1','m-d','branch-main','blob-d','original','upload_desktop','internal','standard','ready',?,?)", [NOW, NOW]);
  docMedia.applyDocumentFile('d-pdf', ['m-d']);
  const aus = await abholen(db, [
    chg('documents', 'd-pdf', 'update', { id: 'd-pdf', file_path: 'data:application/pdf;base64,JVBERi0=', doc_class: 'receipt' }),
    chg('documents', 'd-img', 'update', { id: 'd-img', file_path: 'data:image/png;base64,BBBB' }),
  ]);
  ok(s(db, "SELECT file_path FROM documents WHERE id = 'd-pdf'") === '' && s(db, "SELECT doc_class FROM documents WHERE id = 'd-pdf'") === 'receipt',
    '§7 eine vom Medienkern geführte PDF bekommt keine Daten-URL zurück — ihre Klasse schon');
  ok(s(db, "SELECT file_path FROM documents WHERE id = 'd-img'") === 'data:image/png;base64,BBBB',
    '§7 ein Bilddokument bleibt auf seinem Vertrag: sein Inhalt ist weiterhin abgleichbar (Texterkennung)');
  ok(aus.ignored === 1, '§7 genau die PDF ist gezählt');
}

// ── §8 Altgold: der alte Abgleich kennt die Tabellen gar nicht ──────────────────────────────
{
  const db = freshDb();
  let code = '';
  try { applyChange.applySyncChange(db as never, chg('scrap_trade_lines', 'x', 'update', { id: 'x', images_purchase: JSON.stringify([altbild(40)]) }) as never); }
  catch (e) { code = String((e as { code?: string }).code ?? ''); }
  ok(code === 'SYNC_TABLE_NOT_ALLOWED', `§8 Altgold-Positionen stehen nicht im Abgleich — ein alter Rechner erreicht sie dort nicht (${code})`);
}

// ── §9 Lieferant: sein Altfoto kommt über den Abgleich nicht zurück ─────────────────────────
{
  const db = freshDb();
  db.run("UPDATE suppliers SET cpr_image = '' WHERE id = 'sup-1'");
  const aus = await abholen(db, [chg('suppliers', 'sup-1', 'update', { id: 'sup-1', cpr_image: altbild(50), name: 'Neu' })]);
  ok(s(db, "SELECT COALESCE(cpr_image, '') FROM suppliers WHERE id = 'sup-1'") === '' && s(db, "SELECT name FROM suppliers WHERE id = 'sup-1'") === 'Neu',
    '§9 der Ausweis eines bestehenden Lieferanten kommt nicht über den Abgleich zurück — sein Name schon');
  ok(aus.ignored === 1, '§9 gezählt');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — media legacy peer sync: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('MEDIA_LEGACY_PEER_SYNC_PROVED');
