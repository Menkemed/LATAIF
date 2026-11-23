// ═════════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN — „Add variant" ist EIN Vorgang: Anlage (derselbe Weg wie „New Item"), Zuordnung zum Modell und auf Wunsch
// der Verweis auf das Modellbild — am PC2 als EIN Auftrag `products.create` mit `variant`, am Primary in EINER Transaktion.
// Bewiesen: Wiederholung derselben Kennung (verlorene Antwort) legt keinen zweiten Artikel an; ein Nein VOR oder NACH der
// Anlage lässt nichts zurück (kein Artikel ohne Zuordnung, keine verwaiste Zuordnung, kein verlorener Bildverweis);
// strenger Rumpf; der Rumpf eines alten PC2 (ohne `variant`) läuft unverändert.
// Run: node test/product-models/variant-create.test.ts
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
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const M = await import('../../src/core/products/product-models.ts');
const MP = await import('../../src/core/products/product-models-primary.ts');
const productCmd = await import('../../src/core/bridge/product-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8').replace(/\r\n/g, '\n');
const NOW = '2026-11-23T10:00:00.000Z';
interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);

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
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-bgj','branch-main','Branded','b','#000',?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  useProductStore.getState().loadCategories();
  tauriState.reset();
  return db;
}
const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 53 + i * 3) & 0xff);
const url = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const CTX = { branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', now: NOW };
async function item(size: string, seed: number, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await useProductStore.getState().createProductWithMedia(
    { categoryId: 'cat-bgj', brand: 'Cartier', name: 'Love Bracelet', sku: '', taxScheme: 'MARGIN', attributes: { item_type: 'Bracelet', size }, purchasePrice: 2500, ...extra } as never,
    undefined, undefined, { kind: 'data_urls', images: [url(bild(seed))] });
  if (r.status !== 'created') throw new Error('create failed');
  return r.productId;
}
const deps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ident = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES', op: 'products.create', payloadHash: 'hc' + x });
const WISH = { categoryId: 'cat-bgj', brand: 'Cartier', name: 'Love Bracelet', taxScheme: 'MARGIN', purchasePrice: 2700, plannedSalePrice: 3300, attributes: { item_type: 'Bracelet', size: '18' } };
const files = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_blob_generations');
const products = (db: Db): number => n(db, "SELECT COUNT(*) FROM products WHERE id NOT LIKE 'bulk-%'");

// ── PC2: ein Auftrag ───────────────────────────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const a = await item('16', 1); const b = await item('17', 2);
  const { modelKey } = M.groupProductsInHouse({ productIds: [a, b] }, CTX);
  const pick = M.activeGallery(a, 'branch-main')[0];
  const files0 = files(db); const p0 = products(db);

  const r1 = await productCmd.runProductCreate(deps(db) as never, ident('1'), { ...WISH, variant: { modelKey, pickMediaId: pick } });
  const newId = r1.kind === 'ok' ? String((r1.value as { productId?: string }).productId) : '';
  ok(r1.kind === 'ok' && products(db) === p0 + 1, 'V1 PC2: ein Auftrag legt die Variante an');
  ok(String(one(db, 'SELECT model_key FROM product_models WHERE product_id = ?', [newId])) === modelKey
    && String((r1 as { value?: { modelKey?: string } }).value?.modelKey) === modelKey, 'V2 …und ordnet sie im SELBEN Auftrag dem Modell zu');
  ok(M.activeGallery(newId, 'branch-main').join() === pick && files(db) === files0, 'V3 …mit Verweis auf das Modellbild, ohne neue Datei');
  ok(one(db, 'SELECT tax_scheme FROM products WHERE id = ?', [newId]) === 'MARGIN' && n(db, 'SELECT COUNT(*) FROM stock_lots') === 0,
    'V4 …über denselben Anlegeweg wie New Item (gewählte Steuerart, keine erfundene Buchung)');

  // verlorene Antwort: der Client wiederholt DIESELBE Kennung
  const r2 = await productCmd.runProductCreate(deps(db) as never, ident('1'), { ...WISH, variant: { modelKey, pickMediaId: pick } });
  ok(r2.kind === 'ok' && (r2 as { replayed?: boolean }).replayed === true && products(db) === p0 + 1
    && n(db, 'SELECT COUNT(*) FROM product_models WHERE model_key = ?', [modelKey]) === 3,
    'V5 verlorene Antwort → Wiederholung derselben Kennung: eingefrorenes Ergebnis, KEIN zweiter Artikel, keine doppelte Zuordnung');
  ok(commandCount(db as never) === 1, 'V6 ein durabler Nachweis');

  // Nein NACH der Anlage (Bild gehört nicht zum Modell): alles zurück
  const fremd = M.activeGallery(newId, 'branch-main').length ? 'media-fremd' : 'media-fremd';
  const pBefore = products(db); const mBefore = n(db, 'SELECT COUNT(*) FROM product_models'); const lBefore = n(db, 'SELECT COUNT(*) FROM media_links');
  const r3 = await productCmd.runProductCreate(deps(db) as never, ident('2'), { ...WISH, attributes: { item_type: 'Bracelet', size: '19' }, variant: { modelKey, pickMediaId: fremd } });
  ok(r3.kind === 'rejected' && (r3 as { code?: string }).code === 'MODEL_PHOTO_NOT_IN_MODEL' && (r3 as { frozen?: boolean }).frozen === true,
    `V7 Nein NACH der Anlage (Bildverweis): eingefroren (${(r3 as { code?: string }).code})`);
  ok(products(db) === pBefore && n(db, 'SELECT COUNT(*) FROM product_models') === mBefore && n(db, 'SELECT COUNT(*) FROM media_links') === lBefore,
    'V8 …und NICHTS bleibt: kein Artikel ohne Zuordnung, keine Zuordnung, kein Bildverweis');

  // Nein VOR der Anlage: passt nicht (andere Warenart) bzw. Kommissionsmodell
  const r4 = await productCmd.runProductCreate(deps(db) as never, ident('3'), { ...WISH, attributes: { item_type: 'Ring', size: '52' }, variant: { modelKey } });
  ok(r4.kind === 'rejected' && (r4 as { code?: string }).code === 'PRODUCT_MODEL_INCOMPATIBLE' && products(db) === pBefore, 'V9 passt nicht zum Modell: nichts angelegt');
  const c1 = await item('16', 7, { sourceType: 'CONSIGNMENT' }); const c2 = await item('17', 8, { sourceType: 'CONSIGNMENT' });
  db.run("UPDATE products SET source_type = 'CONSIGNMENT' WHERE id IN (?, ?)", [c1, c2]);
  const ck = M.groupProductsInHouse({ productIds: [c1, c2] }, CTX).modelKey;
  const pC = products(db);
  const r5 = await productCmd.runProductCreate(deps(db) as never, ident('4'), { ...WISH, variant: { modelKey: ck } });
  ok(r5.kind === 'rejected' && (r5 as { code?: string }).code === 'PRODUCT_MODEL_VARIANT_CONSIGNMENT' && products(db) === pC,
    'V10 Kommissionsmodell: keine eigene Ware als Variante (nur über die Kommissionsaufnahme)');

  // strenger Rumpf und alter PC2
  let bad = ''; try { productCmd.parseProductCreate({ ...WISH, variant: { modelKey, sneaky: 1 } }); } catch (e) { bad = (e as { code?: string }).code ?? String(e); }
  ok(/PRODUCT_PAYLOAD|INVALID/.test(bad), `V11 strenger Rumpf: unbekanntes Feld in variant abgewiesen (${bad})`);
  const old = await productCmd.runProductCreate(deps(db) as never, ident('5'), { ...WISH, attributes: { item_type: 'Bracelet', size: '20' } });
  ok(old.kind === 'ok' && !(old as { value?: { modelKey?: string } }).value?.modelKey
    && n(db, 'SELECT COUNT(*) FROM product_models WHERE product_id = ?', [String((old as { value?: { productId?: string } }).value?.productId)]) === 0,
    'V12 Rumpf eines alten PC2 (ohne variant): legt wie bisher an, ohne Zuordnung');
}

// ── Primary: eine Transaktion ──────────────────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  useAuthStore.setState({ session: { role: 'ADMIN', branchId: 'branch-main', userId: 'user-test' } } as never);
  const a = await item('16', 11); const b = await item('17', 12);
  const { modelKey } = M.groupProductsInHouse({ productIds: [a, b] }, CTX);
  const pick = M.activeGallery(a, 'branch-main')[0];
  const files0 = files(db); const p0 = products(db);
  const r = await MP.createVariantOnPrimary({ ...WISH, sku: 'CAR-V-018' } as never, { modelKey, pickMediaId: pick });
  ok(r.status === 'created' && products(db) === p0 + 1 && String(one(db, 'SELECT model_key FROM product_models WHERE product_id = ?', [r.productId])) === modelKey
    && M.activeGallery(r.productId, 'branch-main').join() === pick && files(db) === files0,
    'P1 Primary: Anlage + Zuordnung + Modellbild in einer Transaktion, ohne neue Datei');
  let code = '';
  try { await MP.createVariantOnPrimary({ ...WISH, sku: 'CAR-V-019', attributes: { item_type: 'Bracelet', size: '19' } } as never, { modelKey, pickMediaId: 'media-fremd' }); } catch (e) { code = (e as { code?: string }).code ?? String(e); }
  ok(code === 'MODEL_PHOTO_NOT_IN_MODEL' && products(db) === p0 + 1 && n(db, "SELECT COUNT(*) FROM products WHERE sku = 'CAR-V-019'") === 0,
    `P2 Primary: Nein nach der Anlage rollt die Anlage zurück — kein Artikel ohne Zuordnung (${code})`);
  let code2 = '';
  try { await MP.createVariantOnPrimary({ ...WISH, sku: 'CAR-V-020', brand: 'Bulgari' } as never, { modelKey }); } catch (e) { code2 = (e as { code?: string }).code ?? String(e); }
  ok(code2 === 'PRODUCT_MODEL_INCOMPATIBLE' && n(db, "SELECT COUNT(*) FROM products WHERE sku = 'CAR-V-020'") === 0, 'P3 Primary: passt nicht → nichts angelegt');
  ok(/if \(variantIntent\) return createVariantOnPrimary\(plan\.data, variantIntent\);/.test(src('src/pages/watches/WatchList.tsx'))
    && /remote: \(\) => \(variantIntent \? \{ \.\.\.productCreateRequest\(form, stagingIds\), variant: variantIntent \}/.test(src('src/pages/watches/WatchList.tsx')),
    'P4 die Maske nutzt am Primary die eine Transaktion und am PC2 den einen Auftrag (kein Nachschritt mehr)');
}

console.log(`\nvariant-create: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
