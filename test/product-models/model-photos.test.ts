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

console.log(`\nmodel-photos: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
