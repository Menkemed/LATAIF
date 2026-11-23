// ═════════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN (Lösung E) — Modellgruppen am echten Schema: Migration, Regeln, Gruppieren, Entfernen, Auflösen,
// Aufräumen beim Löschen, Sicherung/Verdichtung und „kein Eingriff in Artikel oder Buchungen".
// Run: node test/product-models/product-models.test.ts
// ═════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
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
  ['lataif_sync_url', 'https://primary.local'],
  ['lataif_sync_token', 'tok'],
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
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const M = await import('../../src/core/products/product-models.ts');
const L = await import('../../src/core/products/product-leftovers.ts');
const { classifySyncTable } = await import('../../src/core/sync/apply-change.ts');
const { verifyCompactedCopy } = await import('../../src/core/storage/database-compaction.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8').replace(/\r\n/g, '\n');
const NOW = '2026-11-23T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
  prepare(sql: string): never;
}
const all = (db: Db, sql: string, p: unknown[] = []): unknown[][] => db.exec(sql, p)[0]?.values ?? [];
const one = (db: Db, sql: string, p: unknown[] = []): unknown => all(db, sql, p)[0]?.[0];

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zweit',?,?)", [NOW, NOW]);
  setTestDatabase(db as never);
  return db;
}

interface P { id: string; branch?: string; cat?: string; brand?: string; name?: string; type?: string; size?: string; status?: string; source?: string }
function addProduct(db: Db, p: P): void {
  const attrs = JSON.stringify({ item_type: p.type ?? 'Bracelet', size: p.size ?? '16', karat: '18K', weight: 30.1 });
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, purchase_price, stock_status, source_type, attributes, images, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'[]',?,?)`,
    [p.id, p.branch ?? 'branch-main', p.cat ?? 'cat-branded-gold-jewelry', p.brand ?? 'Cartier', p.name ?? 'Love Bracelet', 'SKU-' + p.id, 2500,
      p.status ?? 'in_stock', p.source ?? 'OWN', attrs, NOW, NOW]);
}
const ADMIN = { branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', now: NOW };
const SALES = { ...ADMIN, role: 'SALES' };
const ACCOUNTANT = { ...ADMIN, role: 'ACCOUNTANT' };
const productsSnapshot = (db: Db): string => JSON.stringify(all(db, 'SELECT * FROM products ORDER BY id'));
const rejectCode = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? 'THROW:' + String(e); }
};
const modelRows = (db: Db): number => Number(one(db, 'SELECT COUNT(*) FROM product_models'));

// ── 1 Schema: kleine Tabelle, ohne Zusatzindex, nicht im Abgleich ───────────────────────────────────
{
  const db = freshDb();
  const sql = String(one(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='product_models'") ?? '');
  ok(/WITHOUT ROWID/i.test(sql), 'S1 product_models ist WITHOUT ROWID');
  ok(all(db, 'PRAGMA table_info(product_models)').map((r) => r[1]).join(',') === 'product_id,model_key', 'S2 genau zwei Spalten (product_id, model_key)');
  ok(all(db, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='product_models' AND sql IS NOT NULL").length === 0, 'S3 kein Zusatzindex');
  ok(classifySyncTable('product_models') === 'unknown', 'S4 nicht im Abgleichsvertrag (classifySyncTable = unknown)');
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, unknown> };
  ok(!('product_models' in manifest.tables), 'S5 nicht in sync-business-schema.json');
  ok(!/product_models/.test(src('src/core/db/schema.sql')), 'S6 nur als Migration (database.ts), nicht in schema.sql');
}

// ── 2 Regeln (rein): Filiale, Eigentum, Kategorie, Marke, Warenart, System-/erledigte Artikel ─────────
{
  const base = { id: 'a', branchId: 'b1', categoryId: 'cat-x', brand: 'Cartier', attributes: { item_type: 'Bracelet' }, ownership: 'OWN', stockStatus: 'in_stock' };
  ok(M.modelCompatibilityReason(base, { ...base, id: 'b', attributes: { item_type: 'bracelet ' }, brand: ' cartier' }) === null, 'R1 gleiche Art/Marke (Groß/Klein, Leerzeichen egal) passt');
  ok(M.modelCompatibilityReason(base, { ...base, id: 'b', stockStatus: 'sold' }) === null, 'R2 verkaufte Artikel dürfen ins Modell (bleiben sichtbar)');
  ok(/Consignment/.test(M.modelCompatibilityReason(base, { ...base, id: 'b', ownership: 'CONSIGNMENT' }) ?? ''), 'R3 Kommission nie mit eigener Ware');
  ok(/Own stock/.test(M.modelCompatibilityReason({ ...base, ownership: 'CONSIGNMENT' }, { ...base, id: 'b' }) ?? ''), 'R4 eigene Ware nie mit Kommission');
  ok(M.modelCompatibilityReason(base, { ...base, id: 'b', branchId: 'b2' }) === 'Different branch', 'R5 andere Filiale');
  ok(M.modelCompatibilityReason(base, { ...base, id: 'b', categoryId: 'cat-y' }) === 'Different category', 'R6 andere Kategorie');
  ok(M.modelCompatibilityReason(base, { ...base, id: 'b', brand: 'Bulgari' }) === 'Different brand', 'R7 andere Marke');
  ok(M.modelCompatibilityReason(base, { ...base, id: 'b', attributes: { item_type: 'Ring' } }) === 'Different item type', 'R8 andere Warenart');
  ok(M.modelCompatibilityReason(base, { ...base, id: 'bulk-gold-999-b1' }) !== null, 'R9 Bulk-Systemartikel nie');
  ok(M.modelCompatibilityReason(base, { ...base, id: 'b', stockStatus: 'consumed' }) !== null, 'R10 verbrauchte nicht');
  ok(M.modelDisplayName(['Love Bracelet', 'LOVE bracelet', 'Love Bracelet']) === 'Love Bracelet', 'R11 Modellname = häufigster Artikelname');
  ok(M.isAvailableVariant('in_stock') && !M.isAvailableVariant('sold') && !M.isAvailableVariant('reserved'), 'R12 verfügbar: nur in_stock/consignment/offered');
  ok(!M.mayChangeVariantPhoto('sold') && M.mayChangeVariantPhoto('reserved'), 'R13 Bild verkaufter Artikel nie ändern');
}

// ── 3 Gruppieren: nur Zuordnung + Audit, nichts an Artikeln, Losen, Buchungen, Abgleich ───────────────
{
  const db = freshDb();
  addProduct(db, { id: 'p1', size: '16' });
  addProduct(db, { id: 'p2', size: '17' });
  addProduct(db, { id: 'p3', size: '17', name: 'LOVE bracelet' });
  addProduct(db, { id: 'p4', size: '18', status: 'sold' });
  addProduct(db, { id: 'p5', size: '16', source: 'CONSIGNMENT' });
  addProduct(db, { id: 'p6', type: 'Ring', name: 'Love Ring' });
  addProduct(db, { id: 'p7', branch: 'branch-2' });
  addProduct(db, { id: 'p8', status: 'consumed' });
  addProduct(db, { id: 'p9', brand: 'Bulgari' });
  const before = productsSnapshot(db);
  const changelogBefore = Number(one(db, 'SELECT COUNT(*) FROM sync_changelog'));
  const lotsBefore = JSON.stringify(all(db, 'SELECT * FROM stock_lots'));

  const r = M.groupProductsInHouse({ productIds: ['p1', 'p2', 'p3', 'p4'] }, SALES);
  ok(/^mdl-[0-9a-f]{12}$/.test(r.modelKey), 'G1 neue Modellkennung mdl-<12 hex>');
  ok(r.added.length === 4 && modelRows(db) === 4, 'G2 vier Zuordnungen (auch verkauft, auch zwei Stück Größe 17)');
  ok(productsSnapshot(db) === before, 'G3 products byte-gleich (keine Artikelzeile geändert)');
  ok(Number(one(db, 'SELECT COUNT(*) FROM sync_changelog')) === changelogBefore, 'G4 kein Changelog-Eintrag');
  ok(JSON.stringify(all(db, 'SELECT * FROM stock_lots')) === lotsBefore, 'G5 Lose unverändert');
  ok(Number(one(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type='product_models' AND action_type='CREATE'")) === 4, 'G6 je Artikel ein Audit-Eintrag');
  ok(String(one(db, "SELECT changed_by FROM audit_log WHERE entity_type='product_models' LIMIT 1")) === 'user-test', 'G7 Audit nennt den Handelnden');
  ok(JSON.stringify(M.loadProductModelsFor('branch-main')) === JSON.stringify({ p1: r.modelKey, p2: r.modelKey, p3: r.modelKey, p4: r.modelKey }), 'G8 loadProductModelsFor liefert die Zuordnungen der Filiale');
  ok(Object.keys(M.loadProductModelsFor('branch-2')).length === 0, 'G9 andere Filiale sieht keine fremden Zuordnungen');

  // Ablehnungen — jede ohne Schreiben
  const rows0 = modelRows(db); const audit0 = Number(one(db, 'SELECT COUNT(*) FROM audit_log'));
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p5'], modelKey: r.modelKey }, ADMIN)) === 'PRODUCT_MODEL_INCOMPATIBLE', 'G10 Kommission in eigenes Modell abgelehnt');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p6'], modelKey: r.modelKey }, ADMIN)) === 'PRODUCT_MODEL_INCOMPATIBLE', 'G11 andere Warenart abgelehnt');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p9'], modelKey: r.modelKey }, ADMIN)) === 'PRODUCT_MODEL_INCOMPATIBLE', 'G12 andere Marke abgelehnt');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p7'], modelKey: r.modelKey }, ADMIN)) === 'PRODUCT_MODEL_INCOMPATIBLE', 'G13 andere Filiale abgelehnt');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p8'], modelKey: r.modelKey }, ADMIN)) === 'PRODUCT_MODEL_INCOMPATIBLE', 'G14 verbrauchter Artikel abgelehnt');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p5', 'p1'] }, ADMIN)) !== null, 'G15 Artikel aus anderem Modell / gemischt abgelehnt');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p2'] }, ADMIN)) === 'PRODUCT_MODEL_TOO_FEW', 'G16 neues Modell braucht zwei Artikel');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p1', 'p2'] }, ACCOUNTANT)) === 'PERMISSION_DENIED', 'G17 ohne products.edit kein Gruppieren');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p1', 'p2'] }, { ...ADMIN, branchId: 'branch-2' })) === 'PRODUCT_MODEL_OTHER_BRANCH', 'G18 nur in der eigenen Filiale');
  ok(rejectCode(() => M.groupProductsInHouse({ productIds: ['p1'], modelKey: 'mdl-000000000000' }, ADMIN)) === 'PRODUCT_MODEL_NOT_FOUND', 'G19 unbekanntes Modell');
  ok(modelRows(db) === rows0 && Number(one(db, 'SELECT COUNT(*) FROM audit_log')) === audit0, 'G20 Ablehnungen schreiben nichts');
  ok(M.checkGroup({ productIds: ['p5'], modelKey: r.modelKey }, ADMIN)?.code === 'PRODUCT_MODEL_INCOMPATIBLE', 'G21 checkGroup prüft ohne zu schreiben');

  // Kommissionsware: eigenes Modell möglich
  addProduct(db, { id: 'p10', size: '17', source: 'CONSIGNMENT' });
  const c = M.groupProductsInHouse({ productIds: ['p5', 'p10'] }, ADMIN);
  ok(c.modelKey !== r.modelKey && modelRows(db) === 6, 'G22 Kommissionsware in eigenem Modell');

  // Hinzufügen zu bestehendem Modell; Doppelte ignoriert
  addProduct(db, { id: 'p11', size: '19' });
  const add = M.groupProductsInHouse({ productIds: ['p11', 'p1'], modelKey: r.modelKey }, ADMIN);
  ok(add.added.join() === 'p11' && modelRows(db) === 7, 'G23 Hinzufügen nimmt nur neue Artikel');

  // ── 4 Entfernen / Auflösen ─────────────────────────────────────────────
  const before2 = productsSnapshot(db);
  const rem = M.removeFromModelInHouse({ productIds: ['p11'] }, ADMIN);
  ok(rem.removed.join() === 'p11' && rem.dissolved.length === 0 && modelRows(db) === 6, 'E1 ein Artikel entfernt, Modell bleibt');
  const dis = M.removeFromModelInHouse({ productIds: ['p10'] }, ADMIN);
  ok(dis.dissolved.join() === 'p5' && modelRows(db) === 4, 'E2 bleibt nur einer übrig, löst sich das Modell auf');
  ok(Number(one(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type='product_models' AND action_type='DELETE'")) === 3, 'E3 Entfernen und Auflösen im Audit');
  M.removeFromModelInHouse({ productIds: ['p1', 'p2', 'p3', 'p4'] }, ADMIN);
  ok(modelRows(db) === 0, 'E4 Gruppierung aufheben: alle Zuordnungen weg');
  ok(productsSnapshot(db) === before2, 'E5 Artikel unverändert nach Entfernen/Auflösen');
  ok(rejectCode(() => M.removeFromModelInHouse({ productIds: ['p1'] }, ADMIN)) === 'PRODUCT_MODEL_NOT_IN_MODEL', 'E6 Entfernen ohne Modell abgelehnt');
  ok(rejectCode(() => M.removeFromModelInHouse({ productIds: ['p1'] }, ACCOUNTANT)) === 'PERMISSION_DENIED', 'E7 Entfernen nur mit products.edit');
}

// ── 5 Löschen / Aufräumen (purge, sweep, Merge der Quelle) ─────────────────────────────────────────────
{
  const db = freshDb();
  for (const id of ['d1', 'd2', 'd3']) addProduct(db, { id });
  const { modelKey } = M.groupProductsInHouse({ productIds: ['d1', 'd2', 'd3'] }, ADMIN);
  db.run("DELETE FROM products WHERE id = 'd1'");
  const r1 = L.purgeProductLeftovers(db as never, ['d1'], NOW);
  ok(r1.models === 1 && modelRows(db) === 2, 'L1 Löschen eines Artikels entfernt seine Zuordnung, Modell (2) bleibt');
  db.run("DELETE FROM products WHERE id = 'd2'");
  const r2 = L.purgeProductLeftovers(db as never, ['d2'], NOW);
  ok(r2.models === 2 && modelRows(db) === 0, 'L2 bleibt nur einer, löst sich das Modell beim Löschen auf');
  ok(Number(one(db, "SELECT COUNT(*) FROM products WHERE id = 'd3'")) === 1, 'L3 der verbleibende Artikel bleibt bestehen');
  // Waise (Löschweg ohne purge, z. B. Abgleich/Safe Purge): der Start-Sweep räumt
  for (const id of ['o1', 'o2', 'o3']) addProduct(db, { id });
  M.groupProductsInHouse({ productIds: ['o1', 'o2', 'o3'] }, ADMIN);
  db.run("DELETE FROM products WHERE id IN ('o1','o2')");
  const s = L.sweepDeletedProductLeftovers(db as never, NOW);
  ok(s.models === 3 && modelRows(db) === 0, 'L4 Start-Sweep entfernt verwaiste Zuordnungen und löst das einzelne Modell auf');
  ok(L.sweepDeletedProductLeftovers(db as never, NOW).models === 0, 'L5 zweiter Sweep findet nichts');
  ok(modelKey.length > 0, 'L6 Modell war angelegt');
  ok(/purgeModelRows\(db as unknown as LeftoverDb, \[sourceId\]\)/.test(src('src/stores/productStore.ts')), 'L7 Zusammenführen (Duplikate) entfernt die Zuordnung der Quelle');
  ok(/KEINE_BINDUNG = new Set\(\['mobile_upload_receipts', 'product_models'\]\)/.test(src('src/core/purchases/purchase-edit-house.ts')), 'L8 Einkaufszeile entfernen: Modell bindet den Artikel nicht');
  ok(!/product_models/.test(src('src/stores/productStore.ts').split('PRODUCT_LINK_TABLES')[1].split('];')[0]), 'L9 nicht in PRODUCT_LINK_TABLES (gruppierte Artikel bleiben löschbar)');
  ok(/r\.models > 0/.test(src('src/core/db/database.ts')), 'L10 Start-Sweep speichert, wenn er Zuordnungen entfernt hat');
}

// ── 6 Sicherung/Wiederherstellung und Verdichtung ──────────────────────────────────────────────────────
{
  const db = freshDb();
  for (const id of ['b1', 'b2']) addProduct(db, { id });
  const { modelKey } = M.groupProductsInHouse({ productIds: ['b1', 'b2'] }, ADMIN);
  const restored = new SQL.Database(db.export()) as unknown as Db;
  ok(JSON.stringify(all(restored, 'SELECT * FROM product_models ORDER BY product_id')) === JSON.stringify([['b1', modelKey], ['b2', modelKey]]),
    'B1 die Datei-Sicherung (ganze DB) trägt die Modellgruppen mit');
  const copy = new SQL.Database(db.export()) as unknown as Db;
  copy.run('VACUUM');
  ok(verifyCompactedCopy(db as never, copy as never).length === 0, 'B2 Verdichtung (VACUUM + Vergleich aller Tabellen) behält product_models');
  restored.close(); copy.close();
}

console.log(`\nproduct-models: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
