// ═════════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN — „Merge Photos" und gemeinsam genutzte Medien am echten Medienschema.
// Beweist: dieselbe Datei für mehrere Varianten (keine neue Datei, keine Neukodierung), Behalten/Lösen, Rückgängig,
// verkaufte und Altbild-Artikel bleiben unberührt, Schutz gegen veraltete Stände, Galerie bearbeiten/Löschen an EINER
// Variante lässt die anderen heil, die Medien-Freigabe gibt ein noch genutztes Bild nie frei, und der Fernauftrag (PC2)
// läuft durch dieselbe Hausfolge (Wiederholung, Rechte, strenger Rumpf).
// Run: node test/product-models/model-photos.test.ts
// ═════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
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
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, commandCount } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const M = await import('../../src/core/products/product-models.ts');
const { planDeadMediaRelease } = await import('../../src/core/media/old-version-release.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const cmd = await import('../../src/core/bridge/product-model-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-11-23T10:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts').replace(/\r\n/g, '\n');
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
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-bgj','branch-main','Branded','b','#000',?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  tauriState.reset();
  return db;
}

const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 53 + i * 3) & 0xff);
const url = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const gallery = (pid: string): string[] => M.activeGallery(pid, 'branch-main');
const files = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_blob_generations');
const objects = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_objects');
const upd = (db: Db, pid: string): string => String(one(db, 'SELECT updated_at FROM products WHERE id = ?', [pid]) ?? '');
const CTX = { branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', now: NOW };
const rejectCode = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? 'THROW:' + String(e); } };

async function variant(db: Db, size: string, seed: number): Promise<string> {
  const r = await useProductStore.getState().createProductWithMedia(
    { categoryId: 'cat-bgj', brand: 'Cartier', name: 'Love Bracelet', sku: '', taxScheme: 'MARGIN', attributes: { item_type: 'Bracelet', size }, purchasePrice: 2500 } as never,
    undefined, undefined, { kind: 'data_urls', images: [url(bild(seed))] });
  if (r.status !== 'created') throw new Error('create failed: ' + JSON.stringify(r));
  void db;
  return r.productId;
}

// ── 1 Gemeinsames Bild: dieselbe Datei, nichts Neues, Behalten ─────────────────────────────────────────
const db = freshDb();
const p1 = await variant(db, '16', 1);
const p2 = await variant(db, '17', 2);
const p3 = await variant(db, '17', 3);
const p4 = await variant(db, '18', 4);
db.run("UPDATE products SET stock_status = 'sold' WHERE id = ?", [p4]);
const { modelKey } = M.groupProductsInHouse({ productIds: [p1, p2, p3, p4] }, CTX);
const pick = gallery(p1)[0];
const own2 = gallery(p2)[0]; const own3 = gallery(p3)[0]; const own4 = gallery(p4)[0];
ok(pick && own2 && own3 && own4 && new Set([pick, own2, own3, own4]).size === 4, 'V0 vier Varianten mit je eigenem Bild');
const files0 = files(db); const objects0 = objects(db);
const before4 = JSON.stringify(db.exec('SELECT * FROM products WHERE id = ?', [p4])[0].values);

ok(rejectCode(() => M.mergeModelPhotosInHouse({ modelKey, pickMediaId: pick, detachOld: false,
  targets: [{ productId: p4, expectedUpdatedAt: upd(db, p4) }] }, CTX)) === 'MODEL_PHOTO_SOLD', 'P1 verkaufte Variante: Bild wird nie geändert');
ok(rejectCode(() => M.mergeModelPhotosInHouse({ modelKey, pickMediaId: pick, detachOld: false,
  targets: [{ productId: p2, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }] }, CTX)) === 'PRODUCT_RECORD_CHANGED', 'P2 veralteter Stand wird abgewiesen');
ok(rejectCode(() => M.mergeModelPhotosInHouse({ modelKey, pickMediaId: 'media-fremd', detachOld: false,
  targets: [{ productId: p2, expectedUpdatedAt: upd(db, p2) }] }, CTX)) === 'MODEL_PHOTO_NOT_IN_MODEL', 'P3 nur ein Bild dieses Modells');
ok(rejectCode(() => M.mergeModelPhotosInHouse({ modelKey, pickMediaId: pick, detachOld: false,
  targets: [{ productId: p2, expectedUpdatedAt: upd(db, p2) }] }, { ...CTX, role: 'ACCOUNTANT' })) === 'PERMISSION_DENIED', 'P4 ohne products.edit kein Merge');
ok(gallery(p2).join() === own2, 'P5 Ablehnungen ändern nichts');

const u2 = upd(db, p2); const u3 = upd(db, p3);
const res = M.mergeModelPhotosInHouse({ modelKey, pickMediaId: pick, detachOld: false,
  targets: [{ productId: p2, expectedUpdatedAt: u2 }, { productId: p3, expectedUpdatedAt: u3 }] }, { ...CTX, now: '2026-11-23T11:00:00.000Z' });
ok(gallery(p2).join() === [pick, own2].join() && gallery(p3).join() === [pick, own3].join(), 'P6 Behalten: gemeinsames Bild vorn, eigenes als weiteres Bild');
ok(files(db) === files0 && objects(db) === objects0, `P7 keine neue Datei, kein neues Medienobjekt, keine Neukodierung (${files(db)}/${files0})`);
ok(gallery(p1).join() === pick, 'P8 die Quelle des Bildes bleibt unverändert');
ok(JSON.stringify(db.exec('SELECT * FROM products WHERE id = ?', [p4])[0].values) === before4 && gallery(p4).join() === own4, 'P9 verkaufte Variante unberührt');
ok(upd(db, p2) === '2026-11-23T11:00:00.000Z' && one(db, 'SELECT image_embedding FROM products WHERE id = ?', [p2]) === null,
  'P10 Ziel als geändert markiert (Schutz gegen alte Stände) und Bild-Ableitungen zurückgesetzt');
ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type='products' AND field_name='gallery'") === 2, 'P11 je Ziel ein Audit-Eintrag mit alter und neuer Bildfolge');
ok(n(db, `SELECT COUNT(DISTINCT entity_id) FROM media_links WHERE media_id = ? AND deleted_at IS NULL`, [pick]) === 3, 'P12 ein Medienobjekt, drei aktive Verweise');

// ── 2 Rückgängig ───────────────────────────────────────────────────────────────────────────────────
const undo = M.mergeModelPhotosInHouse({ modelKey, restore: res.products.map((x) => ({ productId: x.productId, mediaIds: x.previousMediaIds, expectedUpdatedAt: x.updatedAt })) },
  { ...CTX, now: '2026-11-23T11:05:00.000Z' });
ok(gallery(p2).join() === own2 && gallery(p3).join() === own3 && undo.products.length === 2, 'U1 Rückgängig stellt die alten Bildfolgen her');
ok(files(db) === files0 && objects(db) === objects0, 'U2 auch Rückgängig legt nichts Neues an');
ok(rejectCode(() => M.mergeModelPhotosInHouse({ modelKey, restore: [{ productId: p2, mediaIds: [own3], expectedUpdatedAt: upd(db, p2) }] }, CTX)) === 'MODEL_PHOTO_RESTORE_FOREIGN',
  'U3 Rückgängig verlinkt nichts Fremdes');

// ── 3 Lösen: alte Bilder nur gelöst, Datei bleibt; Freigabe erst über die Wartung ─────────────────────
M.mergeModelPhotosInHouse({ modelKey, pickMediaId: pick, detachOld: true,
  targets: [{ productId: p2, expectedUpdatedAt: upd(db, p2) }, { productId: p3, expectedUpdatedAt: upd(db, p3) }] }, { ...CTX, now: '2026-11-23T11:10:00.000Z' });
ok(gallery(p2).join() === pick && gallery(p3).join() === pick, 'D1 Lösen: nur noch das gemeinsame Bild aktiv');
ok(n(db, 'SELECT COUNT(*) FROM media_objects WHERE media_id IN (?,?) AND deleted_at IS NULL', [own2, own3]) === 2, 'D2 die gelösten Medien selbst bleiben bestehen');
ok(n(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = ? AND media_id = ? AND deleted_at IS NOT NULL`, [p2, own2]) === 1, 'D3 die Verknüpfung ist nur weich entfernt');
ok(files(db) === files0, 'D4 keine Datei gelöscht');
const plan = planDeadMediaRelease(db as never);
const cand = new Set(plan.candidates.map((c) => c.mediaId));
ok(!cand.has(pick), 'D5 das gemeinsame Bild ist nie ein Freigabe-Kandidat (aktive Verweise)');
ok(cand.has(own2) && cand.has(own3) && plan.candidates.find((c) => c.mediaId === own2)?.kind === 'removed_from_gallery',
  'D6 gelöste Altbilder erst über die bestehende Medien-Freigabe (Wartung) — nie hier gelöscht');
ok(!cand.has(own4), 'D7 das Bild der verkauften Variante bleibt in Gebrauch');

// ── 4 Eine Variante löschen / ihre Galerie bearbeiten: die anderen bleiben heil ─────────────────────────
await useProductStore.getState().deleteProduct(p1);
ok(n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [p1]) === 0, 'X1 die Bild-Quelle (Variante 16) gelöscht');
ok(gallery(p2).join() === pick && gallery(p3).join() === pick, 'X2 die anderen Varianten zeigen das gemeinsame Bild weiter');
ok(n(db, 'SELECT COUNT(*) FROM media_objects WHERE media_id = ? AND deleted_at IS NULL', [pick]) === 1, 'X3 das gemeinsame Medium bleibt bestehen');
ok(!new Set(planDeadMediaRelease(db as never).candidates.map((c) => c.mediaId)).has(pick), 'X4 …und ist weiter kein Freigabe-Kandidat');
ok(n(db, 'SELECT COUNT(*) FROM product_models WHERE product_id = ?', [p1]) === 0 && n(db, 'SELECT COUNT(*) FROM product_models WHERE model_key = ?', [modelKey]) === 3,
  'X5 Löschen entfernt nur die Zuordnung der gelöschten Variante');
// Galerie einer Variante über den normalen Bearbeitungsweg: nur deren eigene Verknüpfung ändert sich
const e = await useProductStore.getState().editProductWithMedia(p3, {} as never, {
  srcs: [url(bild(9))], resolved: [{ url: 'blob:shared', mediaId: pick }], status: 'media',
} as never);
ok((e as { status?: string }).status !== 'failed', 'X6 Galerie einer Variante bearbeitet (gemeinsames Bild dort ersetzt)');
ok(gallery(p3).length === 1 && gallery(p3)[0] !== pick, 'X7 an dieser Variante hängt nun ihr neues Bild');
ok(gallery(p2).join() === pick, 'X8 die andere Variante behält das gemeinsame Bild');

// ── 5 Altbild-Artikel und fremde Filiale ───────────────────────────────────────────────────────────────
{
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, purchase_price, stock_status, source_type, attributes, images, created_at, updated_at)
          VALUES ('legacy-1','branch-main','cat-bgj','Cartier','Love Bracelet',2500,'in_stock','OWN','{"item_type":"Bracelet","size":"19"}','["data:image/jpeg;base64,QUJD"]',?,?)`, [NOW, NOW]);
  M.groupProductsInHouse({ productIds: ['legacy-1'], modelKey }, CTX);
  ok(rejectCode(() => M.mergeModelPhotosInHouse({ modelKey, pickMediaId: pick, detachOld: false,
    targets: [{ productId: 'legacy-1', expectedUpdatedAt: NOW }] }, CTX)) === 'MODEL_PHOTO_LEGACY', 'L1 Artikel mit Bildern im alten Format werden nicht angefasst');
  ok(gallery('legacy-1').length === 0 && String(one(db, "SELECT images FROM products WHERE id='legacy-1'")).includes('data:'), 'L2 sein altes Bild bleibt, kein Verweis entsteht');
  ok(rejectCode(() => M.mergeModelPhotosInHouse({ modelKey, pickMediaId: pick, detachOld: false,
    targets: [{ productId: p2, expectedUpdatedAt: upd(db, p2) }] }, { ...CTX, branchId: 'branch-other' })) === 'PRODUCT_MODEL_OTHER_BRANCH', 'L3 nur in der eigenen Filiale');
}

// ── 6 Fernauftrag (PC2): dieselbe Hausfolge, Wiederholung, Rechte, strenger Rumpf ───────────────────────
{
  const db2 = freshDb();
  const a = await variant(db2, '16', 21); const b = await variant(db2, '17', 22);
  const deps = { db: db2 as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string, op: string, role = 'SALES') => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role, op, payloadHash: 'h' + x });
  const g1 = await cmd.runModelGroup(deps, ident('1', cmd.OP_PRODUCT_MODELS_GROUP), { productIds: [a, b] });
  ok(g1.kind === 'ok' && n(db2, 'SELECT COUNT(*) FROM product_models') === 2, 'C1 PC2: Gruppieren über den Fernauftrag');
  const again = await cmd.runModelGroup(deps, ident('1', cmd.OP_PRODUCT_MODELS_GROUP), { productIds: [a, b] });
  ok(again.kind === 'ok' && (again as { replayed?: boolean }).replayed === true && n(db2, 'SELECT COUNT(*) FROM product_models') === 2,
    'C2 PC2: Wiederholung derselben Kennung = eingefrorenes Ergebnis, nichts doppelt');
  ok(commandCount(db2 as never) === 1, 'C3 durabler Nachweis je Kennung');
  const key = String(one(db2, 'SELECT model_key FROM product_models LIMIT 1'));
  const pickA = M.activeGallery(a, 'branch-main')[0];
  const mp = await cmd.runModelMergePhotos(deps, ident('2', cmd.OP_PRODUCT_MODELS_MERGE_PHOTOS),
    { modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: b, expectedUpdatedAt: upd(db2, b) }] });
  ok(mp.kind === 'ok' && M.activeGallery(b, 'branch-main')[0] === pickA, 'C4 PC2: Merge Photos über den Fernauftrag');
  const rm = await cmd.runModelRemove(deps, ident('3', cmd.OP_PRODUCT_MODELS_UNGROUP), { productIds: [a] });
  ok(rm.kind === 'ok' && n(db2, 'SELECT COUNT(*) FROM product_models') === 0, 'C5 PC2: Entfernen löst das Zwei-Artikel-Modell auf');
  let bad = ''; try { cmd.parseGroup({ productIds: [a, b], sneaky: 1 }); } catch (err) { bad = (err as { code?: string }).code ?? ''; }
  ok(bad === 'PRODUCT_MODEL_PAYLOAD_INVALID', 'C6 strenger Rumpf: unbekanntes Feld abgewiesen');
  let bad2 = ''; try { cmd.parseMergePhotos({ modelKey: key, restore: [], pickMediaId: 'x' }); } catch (err) { bad2 = (err as { code?: string }).code ?? ''; }
  ok(bad2 === 'PRODUCT_MODEL_PAYLOAD_INVALID', 'C7 Rückgängig und Merge nicht gemischt');
  const denied = await registry.executeCommand(cmd.OP_PRODUCT_MODELS_GROUP, { productIds: [a, b] },
    { commandId: ID('9'), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u-acc', payloadHash: 'h9', role: 'ACCOUNTANT' } as never);
  ok(denied.kind === 'business_error' && (denied as { code?: string }).code === 'PERMISSION_DENIED' && n(db2, 'SELECT COUNT(*) FROM product_models') === 0,
    'C8 PC2 ohne products.edit: PERMISSION_DENIED, nichts geschrieben');
  const rej = await cmd.runModelGroup(deps, ident('4', cmd.OP_PRODUCT_MODELS_GROUP), { productIds: [a] });
  ok(rej.kind === 'rejected' && (rej as { code?: string }).code === 'PRODUCT_MODEL_TOO_FEW' && (rej as { frozen?: boolean }).frozen === true, 'C9 fachliches Nein wird eingefroren');
}

// ── 7 Alter PC2 (v0.8.101): `products.update` mit genau dem Rumpf, den der alte Client schickt ───────────────
{
  const productCmd = await import('../../src/core/bridge/product-commands.ts');
  const db3 = freshDb();
  const a = await variant(db3, '16', 31); const b = await variant(db3, '17', 32);
  const { modelKey: key } = M.groupProductsInHouse({ productIds: [a, b] }, CTX);
  const pickA = M.activeGallery(a, 'branch-main')[0]; const ownB = M.activeGallery(b, 'branch-main')[0];
  const altStand = upd(db3, b);   // so hat ein alter PC2 den Artikel VOR dem Merge geladen
  M.mergeModelPhotosInHouse({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: b, expectedUpdatedAt: altStand }] }, { ...CTX, now: '2026-11-23T12:00:00.000Z' });
  const deps3 = { db: db3 as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => '2026-11-23T12:30:00.000Z' };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-00000000000${x.length}`;
  const ident = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES', op: 'products.update', payloadHash: 'hu' + x });
  const modelsVor = n(db3, 'SELECT COUNT(*) FROM product_models');

  const stale = await productCmd.runProductUpdate(deps3 as never, ident('71'), { id: b, expectedUpdatedAt: altStand, plannedSalePrice: 999 });
  ok(stale.kind === 'rejected' && (stale as { code?: string }).code === 'PRODUCT_RECORD_CHANGED' && M.activeGallery(b, 'branch-main').join() === [pickA, ownB].join(),
    `O1 alter PC2 mit Stand von VOR dem Merge: abgewiesen, das gemeinsame Bild bleibt (${(stale as { code?: string }).code})`);
  const price = await productCmd.runProductUpdate(deps3 as never, ident('72'), { id: b, expectedUpdatedAt: upd(db3, b), plannedSalePrice: 3333 });
  ok(price.kind === 'ok' && Number(one(db3, 'SELECT planned_sale_price FROM products WHERE id = ?', [b])) === 3333
    && n(db3, 'SELECT COUNT(*) FROM product_models') === modelsVor && M.activeGallery(b, 'branch-main').join() === [pickA, ownB].join(),
    'O2 alter PC2 ändert den Preis: Modell-Zuordnung und Bilder bleiben unverändert');
  const gal = await productCmd.runProductUpdate(deps3 as never, ident('73'), { id: b, expectedUpdatedAt: upd(db3, b), gallery: [{ keep: ownB }] });
  ok(gal.kind === 'ok' && M.activeGallery(b, 'branch-main').join() === ownB && M.activeGallery(a, 'branch-main').join() === pickA
    && n(db3, 'SELECT COUNT(*) FROM media_objects WHERE media_id = ? AND deleted_at IS NULL', [pickA]) === 1,
    'O3 alter PC2 nimmt das gemeinsame Bild an EINER Variante heraus: nur deren Verweis, die andere Variante und das Medium bleiben');
  ok(n(db3, 'SELECT COUNT(*) FROM product_models') === modelsVor, 'O4 die Gruppierung übersteht jede Bearbeitung des alten PC2');
}

// ── 8 Medien-Freigabe (Wartung) nach „Lösen": nur das gelöste Altbild wird frei; Rückgängig lehnt danach sauber ab ──────
{
  const { releaseDeadMedium } = await import('../../src/core/media/old-version-release.ts');
  const db4 = freshDb();
  const a = await variant(db4, '16', 41); const b = await variant(db4, '17', 42);
  const { modelKey: key } = M.groupProductsInHouse({ productIds: [a, b] }, CTX);
  const pickA = M.activeGallery(a, 'branch-main')[0]; const ownB = M.activeGallery(b, 'branch-main')[0];
  const res = M.mergeModelPhotosInHouse({ modelKey: key, pickMediaId: pickA, detachOld: true, targets: [{ productId: b, expectedUpdatedAt: upd(db4, b) }] },
    { ...CTX, now: '2026-11-23T13:00:00.000Z' });
  const plan = planDeadMediaRelease(db4 as never);
  const cand = plan.candidates.find((c) => c.mediaId === ownB);
  ok(!!cand && !plan.candidates.some((c) => c.mediaId === pickA), 'R1 Freigabe-Plan: nur das gelöste Altbild ist frei, das gemeinsame nie');
  releaseDeadMedium(db4 as never, cand!, '2026-11-23T13:10:00.000Z');
  ok(n(db4, 'SELECT COUNT(*) FROM media_objects WHERE media_id = ? AND deleted_at IS NOT NULL', [ownB]) === 1
    && n(db4, 'SELECT COUNT(*) FROM media_objects WHERE media_id = ? AND deleted_at IS NULL', [pickA]) === 1,
    'R2 Freigabe (Wartung) markiert NUR das gelöste Altbild; das gemeinsame Bild bleibt in Gebrauch');
  const vorher = [M.activeGallery(a, 'branch-main').join(), M.activeGallery(b, 'branch-main').join(), upd(db4, b)].join('|');
  let code = '';
  try {
    M.mergeModelPhotosInHouse({ modelKey: key, restore: res.products.map((x) => ({ productId: x.productId, mediaIds: x.previousMediaIds, expectedUpdatedAt: x.updatedAt })) }, CTX);
  } catch (e) { code = (e as { code?: string }).code ?? String(e); }
  ok(code === 'MODEL_PHOTO_RESTORE_UNAVAILABLE' && [M.activeGallery(a, 'branch-main').join(), M.activeGallery(b, 'branch-main').join(), upd(db4, b)].join('|') === vorher,
    `R3 Rückgängig nach der Freigabe: sauberes Nein, nichts halb geändert (${code})`);
}

// ── 9 Offene Bearbeitungsmaske am PRIMARY mit Galerie von VOR dem Merge (letzter Sicherheitsfix) ────────────────
// Die Maske übergibt, welche Galerie sie gesehen hat (`resolved`). Weicht die gespeicherte Galerie davon ab, wird nichts
// gespeichert — kein Bild gelöst, keine neue Datei, kein Text. Der reine Textweg berührt Bilder ohnehin nie.
{
  const { MEDIA_EDIT_GALLERY_BASELINE_CHANGED } = await import('../../src/stores/productStore.ts');
  const st = useProductStore.getState();
  const db5 = freshDb();
  const a = await variant(db5, '16', 51); const b = await variant(db5, '17', 52);
  const { modelKey: key } = M.groupProductsInHouse({ productIds: [a, b] }, CTX);
  const pickA = gallery(a)[0]; const ownB = gallery(b)[0];
  const gesehen = [{ url: 'blob:alt-ownB', mediaId: ownB }];   // so hat die Maske B geöffnet
  M.mergeModelPhotosInHouse({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: b, expectedUpdatedAt: upd(db5, b) }] },
    { ...CTX, now: '2026-11-23T14:00:00.000Z' });
  ok(gallery(b).join() === [pickA, ownB].join(), 'S0 Merge am PC2: B hat jetzt das gemeinsame Bild vorn, das eigene dahinter');
  const f1 = files(db5), o1 = objects(db5);
  const preis = (): number => Number(one(db5, 'SELECT planned_sale_price FROM products WHERE id = ?', [b]) ?? 0);
  const preis0 = preis();
  const istKonflikt = (r: unknown): boolean => (r as { status?: string }).status === 'edit_conflict' && (r as { errorCode?: string }).errorCode === MEDIA_EDIT_GALLERY_BASELINE_CHANGED;

  const s1 = await st.editProductWithMedia(b, {} as never, { srcs: ['blob:alt-ownB', url(bild(53))], resolved: gesehen, status: 'media' });
  ok(istKonflikt(s1), `S1 Foto hinzufügen auf altem Stand: Konflikt statt Speichern (${JSON.stringify(s1)})`);
  ok(gallery(b).join() === [pickA, ownB].join() && gallery(a).join() === pickA, 'S2 das gemeinsame Bild bleibt an beiden Varianten');
  ok(files(db5) === f1 && objects(db5) === o1, `S3 keine neue Datei, kein neues Medienobjekt (${files(db5)}/${f1}, ${objects(db5)}/${o1})`);
  const s2 = await st.editProductWithMedia(b, {} as never, { srcs: [], resolved: gesehen, status: 'media' });
  ok(istKonflikt(s2) && gallery(b).join() === [pickA, ownB].join(), 'S4 Foto entfernen auf altem Stand: abgewiesen, nichts gelöst');
  const s3 = await st.editProductWithMedia(b, { plannedSalePrice: 7777 } as never, { srcs: ['blob:alt-ownB', url(bild(53))], resolved: gesehen, status: 'media' });
  ok(istKonflikt(s3) && preis() === preis0, 'S5 Text und Foto gehen zusammen: auch der Preis wird nicht gespeichert');
  const t = await st.editProductTextDurably(b, { plannedSalePrice: 4444 } as never);
  ok(t.status === 'edited' && preis() === 4444 && gallery(b).join() === [pickA, ownB].join() && gallery(a).join() === pickA,
    'S6 reiner Textweg aus derselben Maske: Preis gespeichert, Bilder unberührt (wie bisher)');

  // Neu geladen: der Entwurf stammt aus der ECHTEN Galerie → Speichern klappt, das gemeinsame Bild bleibt verknüpft.
  const frisch = gallery(b).map((m, i) => ({ url: `blob:neu-${i}`, mediaId: m }));
  const s4 = await st.editProductWithMedia(b, {} as never, { srcs: [...frisch.map((x) => x.url), url(bild(53))], resolved: frisch, status: 'media' });
  ok(s4.status === 'edited' && gallery(b).length === 3 && gallery(b)[0] === pickA && gallery(b)[1] === ownB,
    `S7 nach dem Neuladen: Foto hinzugefügt, gemeinsames und eigenes Bild bleiben (${JSON.stringify(s4)})`);
  ok(gallery(a).join() === pickA && n(db5, 'SELECT COUNT(*) FROM media_links WHERE media_id = ? AND deleted_at IS NULL', [pickA]) === 2,
    'S8 die andere Variante unverändert; ein Medium, zwei aktive Verweise');

  // Nur die Reihenfolge geändert (gleiche Bilder): auch das ist eine andere Galerie.
  const g3 = gallery(b);
  const r1 = await st.editProductWithMedia(b, {} as never, {
    srcs: ['blob:r-1', 'blob:r-0', 'blob:r-2'], resolved: g3.map((m, i) => ({ url: `blob:r-${i}`, mediaId: m })), status: 'media' });
  ok(r1.status === 'edited' && gallery(b).join() === [g3[1], g3[0], g3[2]].join(), 'S9 Umsortieren auf aktuellem Stand klappt');
  const r2 = await st.editProductWithMedia(b, {} as never, { srcs: g3.map((_, i) => `blob:o-${i}`).slice(1), resolved: g3.map((m, i) => ({ url: `blob:o-${i}`, mediaId: m })), status: 'media' });
  ok(istKonflikt(r2) && gallery(b).join() === [g3[1], g3[0], g3[2]].join(), 'S10 Entwurf mit der alten Reihenfolge: Konflikt, nichts geändert');

  // Artikel OHNE Foto bekommt per Merge das gemeinsame Bild — die Maske war mit leerer Galerie offen.
  const c = await st.createProductWithMedia(
    { categoryId: 'cat-bgj', brand: 'Cartier', name: 'Love Bracelet', sku: '', taxScheme: 'MARGIN', attributes: { item_type: 'Bracelet', size: '18' }, purchasePrice: 2500 } as never);
  const cId = (c as { productId?: string }).productId ?? '';
  M.groupProductsInHouse({ productIds: [cId], modelKey: key }, CTX);
  ok(gallery(cId).length === 0, 'S11 Variante ohne Foto');
  M.mergeModelPhotosInHouse({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: cId, expectedUpdatedAt: upd(db5, cId) }] },
    { ...CTX, now: '2026-11-23T14:30:00.000Z' });
  const s5 = await st.editProductWithMedia(cId, {} as never, { srcs: [url(bild(54))], resolved: [], status: 'none' });
  ok(istKonflikt(s5) && gallery(cId).join() === pickA, 'S12 Maske mit leerer Galerie von vorher: Konflikt, das gemeinsame Bild bleibt');

  // Gegenprobe: der PC2-Weg (`products.update` mit Galerie, gerechnet gegen die echte Galerie) läuft unverändert.
  const productCmd = await import('../../src/core/bridge/product-commands.ts');
  const deps5 = { db: db5 as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => '2026-11-23T15:00:00.000Z' };
  const pc2 = await productCmd.runProductUpdate(deps5 as never,
    { commandId: '00000091-0000-4000-8000-000000000002', tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES', op: 'products.update', payloadHash: 'h91' } as never,
    { id: cId, expectedUpdatedAt: upd(db5, cId), gallery: [{ keep: pickA }], plannedSalePrice: 5555 });
  ok(pc2.kind === 'ok' && gallery(cId).join() === pickA && Number(one(db5, 'SELECT planned_sale_price FROM products WHERE id = ?', [cId])) === 5555,
    `S13 PC2-Galeriespeichern auf aktuellem Stand unverändert erfolgreich (${pc2.kind})`);
}

// ── 10 PC2 liest die Bildfolge über `products.get` — mit der ECHTEN Antwort des Primary ─────────────────────────────
// (Befund im Oberflächentest: die Auskunft antwortet mit den Feldern selbst, nicht in `{ data }`; vorher kam am PC2
// immer `null` zurück — Merge photos ohne Bilder, „Add variant" ohne Modellfoto.)
{
  await import('../../src/core/bridge/read-commands.ts');
  const cm = await import('../../src/core/bridge/client-mode.ts');
  const { loadVariantGallery } = await import('../../src/core/products/product-models-primary.ts');
  const db6 = freshDb();
  const a = await variant(db6, '16', 61); const b = await variant(db6, '17', 62);
  const { modelKey: key } = M.groupProductsInHouse({ productIds: [a, b] }, CTX);
  M.mergeModelPhotosInHouse({ modelKey: key, pickMediaId: gallery(a)[0], detachOld: false, targets: [{ productId: b, expectedUpdatedAt: upd(db6, b) }] },
    { ...CTX, now: '2026-11-23T16:00:00.000Z' });
  const lokal = await loadVariantGallery(b);
  // So reicht der Bridge-Listener eine Auskunft weiter: Absender (aus dem geprüften Token) und Eingabe getrennt.
  const antwort = await registry.executeCommand('products.get',
    { actor: { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES' }, input: { id: b } }, undefined);
  ok(antwort.kind === 'ok', `G0 echte Auskunft products.get am Primary (${JSON.stringify(antwort).slice(0, 200)})`);
  const gefragt: string[] = [];
  const echtFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const op = JSON.parse(String(init?.body ?? '{}')).op as string;
    gefragt.push(op);
    return new Response(JSON.stringify({ ok: true, value: (antwort as { value?: unknown }).value }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  cm.enterClientMode('http://127.0.0.1:65500'); cm.setClientToken('t-pc2');
  try {
    const pc2 = await loadVariantGallery(b);
    ok(!!pc2 && pc2.mediaIds.join() === gallery(b).join() && pc2.mediaIds.length === 2 && pc2.updatedAt === upd(db6, b),
      `G1 PC2 erhält dieselbe Bildfolge und Fassung wie der Primary lokal (${JSON.stringify(pc2)} / ${JSON.stringify(lokal)})`);
    ok(gefragt.join() === 'products.get', 'G2 genau eine Auskunft products.get');
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    ok(await loadVariantGallery(b) === null, 'G3 Primary nicht erreichbar: null (Merge zeigt „Photos could not be read", Add variant legt nichts an)');
  } finally {
    globalThis.fetch = echtFetch; cm.leaveClientMode();
  }
  ok(src('src/pages/watches/WatchList.tsx').includes("The model photo could not be read from the main computer. Nothing was created"),
    'G4 „Add variant" mit gewünschtem Modellfoto legt bei unlesbarer Bildfolge nichts an (statt still ohne Foto)');
}

// ── 11 Altbild-Artikel: beim Merge zuerst mit dem BESTEHENDEN Umzug in den Bildspeicher (Primary und PC2) ────────────
{
  const { convertLegacyMergeTargets, mergeModelPhotosOnPrimary } = await import('../../src/core/products/product-models-primary.ts');
  const { useAuthStore } = await import('../../src/stores/authStore.ts');
  const db7 = freshDb();
  const a = await variant(db7, '16', 71);
  const pickA = gallery(a)[0];
  const alt = (id: string, size: string, bilder: string[], status = 'in_stock'): void => {
    db7.run(`INSERT INTO products (id, branch_id, category_id, brand, name, purchase_price, stock_status, source_type, attributes, images, created_at, updated_at)
             VALUES (?,'branch-main','cat-bgj','Cartier','Love Bracelet',2500,?,'OWN',?,?,?,?)`, [id, status, JSON.stringify({ item_type: 'Bracelet', size }), JSON.stringify(bilder), NOW, NOW]);
  };
  const altBilder = [url(bild(72)), url(bild(73))];
  alt('alt-1', '17', altBilder);
  alt('alt-kaputt', '18', ['https://example.invalid/foto.jpg']);   // kein data:-Bild → der Umzug lehnt VOR jeder Verknüpfung ab
  alt('alt-verkauft', '19', [url(bild(74))], 'sold');
  const { modelKey: key } = M.groupProductsInHouse({ productIds: [a, 'alt-1', 'alt-kaputt', 'alt-verkauft'] }, CTX);
  const imagesOf = (id: string): string => String(one(db7, 'SELECT images FROM products WHERE id = ?', [id]));
  const o0 = objects(db7), f0 = files(db7);
  ok(rejectCode(() => M.checkMergePhotos({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'alt-1', expectedUpdatedAt: NOW }] }, CTX)
    ? (() => { throw Object.assign(new Error('x'), { code: M.checkMergePhotos({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'alt-1', expectedUpdatedAt: NOW }] }, CTX)!.code }); })() : null) === 'MODEL_PHOTO_LEGACY',
    'A0 die Hausregel selbst nimmt weiter kein Altbild an (der Umzug läuft davor)');
  ok(JSON.stringify(M.legacyMergeTargets({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [
    { productId: 'alt-1', expectedUpdatedAt: NOW }, { productId: 'alt-verkauft', expectedUpdatedAt: NOW }, { productId: a, expectedUpdatedAt: upd(db7, a) },
    { productId: 'alt-kaputt', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }] }, CTX)) === '[]'
    && JSON.stringify(M.legacyMergeTargets({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [
      { productId: 'alt-1', expectedUpdatedAt: NOW }, { productId: 'alt-kaputt', expectedUpdatedAt: NOW }] }, CTX)) === JSON.stringify(['alt-1', 'alt-kaputt']),
    'A1 umgezogen wird nur, wenn der Merge abgesehen vom Altformat gelingt (mit verkauftem/veraltetem Ziel: nichts), und nur Altbild-Ziele');
  ok(M.legacyMergeTargets({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'alt-1', expectedUpdatedAt: NOW }] }, { ...CTX, role: 'ACCOUNTANT' }).length === 0
    && M.legacyMergeTargets({ modelKey: key, restore: [{ productId: 'alt-1', mediaIds: [], expectedUpdatedAt: NOW }] }, CTX).length === 0,
    'A2 ohne products.edit und bei Rückgängig wird nichts umgezogen');

  // Scheitert der Umzug: nicht bewertet (derselbe Auftrag darf erneut), Artikel und Altbild unverändert, nichts angelegt.
  const deps7 = { db: db7 as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => '2026-11-23T17:00:00.000Z' };
  const ident7 = (x: string) => ({ commandId: `${x.padStart(8, '0')}-0000-4000-8000-000000000071`, tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES', op: cmd.OP_PRODUCT_MODELS_MERGE_PHOTOS, payloadHash: 'hm' + x });
  const kaputtVor = [imagesOf('alt-kaputt'), upd(db7, 'alt-kaputt')].join('|');
  const bad = await cmd.runModelMergePhotos(deps7 as never, ident7('701'), { modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'alt-kaputt', expectedUpdatedAt: NOW }] });
  ok(bad.kind === 'rejected' && (bad as { code?: string }).code === 'MODEL_PHOTO_LEGACY_CONVERT_FAILED' && (bad as { frozen?: boolean }).frozen === false,
    `A3 PC2: Umzug gescheitert → klare Ablehnung, nicht eingefroren (${JSON.stringify(bad).slice(0, 160)})`);
  ok([imagesOf('alt-kaputt'), upd(db7, 'alt-kaputt')].join('|') === kaputtVor && gallery('alt-kaputt').length === 0 && objects(db7) === o0 && commandCount(db7 as never) === 0,
    'A4 …Altbild, Artikel und Medien unverändert, kein Auftragsnachweis');

  // PC2 merge mit Altbild-Ziel: Umzug (2 Bilder, Reihenfolge), dann Merge (Behalten) in EINEM Auftrag.
  const ok7 = await cmd.runModelMergePhotos(deps7 as never, ident7('702'), { modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'alt-1', expectedUpdatedAt: NOW }] });
  const g1 = gallery('alt-1');
  ok(ok7.kind === 'ok' && imagesOf('alt-1') === '[]' && g1.length === 3 && g1[0] === pickA,
    `A5 PC2: Altbilder umgezogen, dann gemerged — gemeinsames Bild vorn, die zwei eigenen dahinter (${JSON.stringify(ok7).slice(0, 120)}; ${g1.length})`);
  ok(objects(db7) === o0 + 2 && files(db7) >= f0 + 2, `A6 je Altbild genau ein neues Medium (${objects(db7) - o0}), keine weitere Kopie`);
  const conv = g1.slice(1);
  const restore = (ok7 as { value?: { products?: Array<{ productId: string; previousMediaIds: string[]; updatedAt: string }> } }).value?.products ?? [];
  ok(restore.length === 1 && restore[0].previousMediaIds.join() === conv.join(), 'A7 die Vorher-Galerie des Merge sind genau die umgezogenen Bilder (in Reihenfolge) — Rückgängig stellt sie her');
  ok(imagesOf('alt-verkauft') !== '[]' && gallery('alt-verkauft').length === 0, 'A8 der verkaufte Altbild-Artikel bleibt unberührt (kein Umzug, kein Merge)');
  const again = await cmd.runModelMergePhotos(deps7 as never, ident7('702'), { modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'alt-1', expectedUpdatedAt: NOW }] });
  ok(again.kind === 'ok' && (again as { replayed?: boolean }).replayed === true && objects(db7) === o0 + 2, 'A9 Wiederholung derselben Kennung: eingefrorenes Ergebnis, kein zweiter Umzug');

  // Primary (lokal): derselbe Weg, mit Lösen — die umgezogenen Altbilder werden erst über die bestehende Medien-Freigabe frei.
  alt('alt-2', '20', [url(bild(75))]);
  M.groupProductsInHouse({ productIds: ['alt-2'], modelKey: key }, CTX);
  useAuthStore.setState({ session: { ...(useAuthStore.getState().session ?? {}), role: 'ADMIN', branchId: 'branch-main', userId: 'user-test' } } as never);
  const res2 = await mergeModelPhotosOnPrimary({ modelKey: key, pickMediaId: pickA, detachOld: true, targets: [{ productId: 'alt-2', expectedUpdatedAt: NOW }] });
  const umgezogen = res2.products[0]?.previousMediaIds ?? [];
  ok(imagesOf('alt-2') === '[]' && gallery('alt-2').join() === pickA && umgezogen.length === 1, 'A10 Primary: umgezogen und gemerged (Lösen) — nur noch das gemeinsame Bild aktiv');
  const plan7 = planDeadMediaRelease(db7 as never);
  const c7 = new Set(plan7.candidates.map((c) => c.mediaId));
  ok(c7.has(umgezogen[0]) && !c7.has(pickA) && !conv.some((m) => c7.has(m)),
    'A11 Freigabe: nur das gelöste (umgezogene) Altbild ist Kandidat — nie das gemeinsame, nie noch verknüpfte');
  ok(await convertLegacyMergeTargets({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'alt-1', expectedUpdatedAt: upd(db7, 'alt-1') }] }, CTX, false).then((x) => x.length) === 0,
    'A12 ein schon umgezogener Artikel wird nicht erneut umgezogen');
}

// ── 12 Grenzfall: Umzug gelungen, Merge scheitert danach oder wird wiederholt (Primary und PC2) ──────────────────────
{
  const { convertLegacyMergeTargets, mergeModelPhotosOnPrimary } = await import('../../src/core/products/product-models-primary.ts');
  const { useAuthStore } = await import('../../src/stores/authStore.ts');
  useAuthStore.setState({ session: { ...(useAuthStore.getState().session ?? {}), role: 'ADMIN', branchId: 'branch-main', userId: 'user-test' } } as never);
  const db8 = freshDb();
  const a = await variant(db8, '16', 81); const b = await variant(db8, '17', 82);
  const pickA = gallery(a)[0]; const ownB = gallery(b)[0];
  const alt = (id: string, size: string, n: number, status = 'in_stock'): void => {
    db8.run(`INSERT INTO products (id, branch_id, category_id, brand, name, purchase_price, stock_status, source_type, attributes, images, created_at, updated_at)
             VALUES (?,'branch-main','cat-bgj','Cartier','Love Bracelet',2500,?,'OWN',?,?,?,?)`,
      [id, status, JSON.stringify({ item_type: 'Bracelet', size }), JSON.stringify(Array.from({ length: n }, (_, i) => url(bild(90 + i + size.length * 7)))), NOW, NOW]);
  };
  alt('g-1', '18', 2); alt('g-2', '19', 1); alt('g-verkauft', '20', 1, 'sold');
  const { modelKey: key } = M.groupProductsInHouse({ productIds: [a, b, 'g-1', 'g-2', 'g-verkauft'] }, CTX);
  const imagesOf = (id: string): string => String(one(db8, 'SELECT images FROM products WHERE id = ?', [id]));
  const audits = (): number => n(db8, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'gallery'");
  const deps8 = { db: db8 as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => '2026-11-23T22:00:00.000Z' };
  const id8 = (x: string) => ({ commandId: `${x.padStart(8, '0')}-0000-4000-8000-000000000081`, tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES', op: cmd.OP_PRODUCT_MODELS_MERGE_PHOTOS, payloadHash: 'hg' + x });
  const g1Vor = imagesOf('g-1'), o0 = objects(db8), f0 = files(db8), au0 = audits(), bVor = gallery(b).join();

  // (a) Merge wird ABGELEHNT (zweites Ziel veraltet / verkauft) → der Umzug läuft gar nicht erst
  const r1 = await cmd.runModelMergePhotos(deps8 as never, id8('801'), { modelKey: key, pickMediaId: pickA, detachOld: false,
    targets: [{ productId: 'g-1', expectedUpdatedAt: NOW }, { productId: b, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }] });
  ok(r1.kind === 'rejected' && (r1 as { code?: string }).code === 'PRODUCT_RECORD_CHANGED' && (r1 as { frozen?: boolean }).frozen === true,
    `K1 PC2: Merge mit veraltetem zweitem Ziel abgelehnt — der echte Grund, eingefroren (${(r1 as { code?: string }).code})`);
  ok(imagesOf('g-1') === g1Vor && gallery('g-1').length === 0 && objects(db8) === o0 && files(db8) === f0 && audits() === au0,
    'K2 …und das Altbild wurde NICHT umgezogen: Artikel, Medien, Dateien, Audit unverändert');
  let code = '';
  try { await mergeModelPhotosOnPrimary({ modelKey: key, pickMediaId: pickA, detachOld: false,
    targets: [{ productId: 'g-1', expectedUpdatedAt: NOW }, { productId: 'g-verkauft', expectedUpdatedAt: NOW }] }); } catch (e) { code = (e as { code?: string }).code ?? String(e); }
  ok(code === 'MODEL_PHOTO_SOLD' && imagesOf('g-1') === g1Vor && imagesOf('g-verkauft') !== '[]' && objects(db8) === o0,
    `K3 Primary: Merge mit verkauftem Ziel abgelehnt (${code}) — nichts umgezogen, verkaufter Artikel unberührt`);

  // (b) Umzug GELINGT, der Merge scheitert DANACH (hier: das gewählte Bild wird zwischen beiden Schritten unbrauchbar)
  const req = { modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'g-1', expectedUpdatedAt: NOW }] };
  const ohneBilder = (id: string): string => {
    const r = db8.exec('SELECT * FROM products WHERE id = ?', [id])[0];
    return JSON.stringify(r.columns.map((c, i) => [c, r.values[0][i]]).filter(([c]) => c !== 'images'));
  };
  const g1Zeile = ohneBilder('g-1');
  ok(JSON.stringify(await convertLegacyMergeTargets(req, CTX, false)) === '["g-1"]', 'K4 Schritt 1: Umzug gelungen');
  const umgezogen = gallery('g-1');
  const o1 = objects(db8), f1 = files(db8);
  ok(imagesOf('g-1') === '[]' && umgezogen.length === 2 && o1 === o0 + 2 && upd(db8, 'g-1') === NOW,
    'K5 …beide Altbilder in Reihenfolge im Bildspeicher, je eines neu, der Stand des Artikels (updated_at) unverändert');
  db8.run('UPDATE media_objects SET deleted_at = ? WHERE media_id = ?', ['2026-11-23T22:01:00.000Z', pickA]);   // Bild inzwischen freigegeben
  const r2 = await cmd.runModelMergePhotos(deps8 as never, id8('802'), req);
  ok(r2.kind === 'rejected' && (r2 as { code?: string }).code === 'MODEL_PHOTO_NOT_READY',
    `K6 Schritt 2 (PC2): Merge scheitert danach (${(r2 as { code?: string }).code})`);
  ok(gallery('g-1').join() === umgezogen.join() && imagesOf('g-1') === '[]' && objects(db8) === o1 && files(db8) === f1,
    'K7 kein Bildverlust: der Artikel zeigt seine umgezogenen Bilder, nichts Neues angelegt');
  ok(ohneBilder('g-1') === g1Zeile,
    'K8 an der Artikelzeile änderte sich nur das Ablageformat der Bilder (images → Bildspeicher): jede andere Spalte byte-gleich');
  ok(audits() === au0 && gallery(a).join() === pickA && gallery(b).join() === bVor && n(db8, 'SELECT COUNT(*) FROM product_models WHERE model_key = ?', [key]) === 5,
    'K9 keine fremde Referenz berührt: Audit, Galerien von A und B, Gruppierung unverändert');
  let codeP = '';
  try { await mergeModelPhotosOnPrimary(req); } catch (e) { codeP = (e as { code?: string }).code ?? String(e); }
  ok(codeP === 'MODEL_PHOTO_NOT_READY' && objects(db8) === o1 && gallery('g-1').join() === umgezogen.join(), `K10 Primary: derselbe Fall ebenso (${codeP}), kein zweiter Umzug`);

  // (c) Wiederholung: dieselbe Kennung = eingefrorenes Ergebnis; nach Behebung ein neuer Auftrag — ohne zweiten Umzug
  const r3 = await cmd.runModelMergePhotos(deps8 as never, id8('802'), req);
  ok(r3.kind === 'rejected' && (r3 as { replayed?: boolean }).replayed === true && objects(db8) === o1 && files(db8) === f1,
    'K11 PC2-Wiederholung derselben Kennung: dieselbe Antwort, kein neues Medium, keine neue Datei');
  db8.run('UPDATE media_objects SET deleted_at = NULL WHERE media_id = ?', [pickA]);
  const r4 = await cmd.runModelMergePhotos(deps8 as never, id8('803'), req);
  ok(r4.kind === 'ok' && gallery('g-1').join() === [pickA, ...umgezogen].join() && objects(db8) === o1 && files(db8) === f1,
    'K12 PC2: neuer Auftrag gelingt — gemeinsames Bild vorn, die umgezogenen dahinter; KEIN zweiter Umzug, keine Doppel-Datei');
  const pr = await mergeModelPhotosOnPrimary({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'g-2', expectedUpdatedAt: NOW }] });
  const again = await convertLegacyMergeTargets({ modelKey: key, pickMediaId: pickA, detachOld: false, targets: [{ productId: 'g-2', expectedUpdatedAt: upd(db8, 'g-2') }] }, CTX, false);
  ok(pr.products.length === 1 && gallery('g-2').length === 2 && objects(db8) === o1 + 1 && again.length === 0,
    'K13 Primary: Umzug + Merge in einem Zug; ein erneuter Aufruf zieht nicht noch einmal um (+1 Medium für 1 Altbild)');
  ok(n(db8, `SELECT COUNT(*) FROM media_links WHERE media_id = ? AND deleted_at IS NULL`, [pickA]) === 3
    && umgezogen.every((m) => n(db8, `SELECT COUNT(*) FROM media_links WHERE media_id = ? AND deleted_at IS NULL`, [m]) === 1),
    'K14 Referenzen konsistent: gemeinsames Bild an A, g-1, g-2; jedes umgezogene Bild genau einmal verknüpft');
}

console.log(`\nmodel-photos: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
