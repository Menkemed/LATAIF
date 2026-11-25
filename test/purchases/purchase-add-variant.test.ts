// ═════════════════════════════════════════════════════════════════════
// PURCHASE ADD VARIANT (Owner 25.11.2026) — Purchase → „Variant of existing": Einkauf, Artikel, SKU, Los, Modellzuordnung und
// optionaler Bildverweis in EINER Transaktion (Primary) bzw. EINEM Auftrag purchases.create (PC2). Buchung identisch zu „New Item".
// Harness aus test/product-models/variant-create.test.ts.
// Run: node test/purchases/purchase-add-variant.test.ts
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

// ════════════════════════════════════════════════════════════════════════════
// PURCHASE ADD VARIANT — „Variant of existing" im Einkauf (Owner 25.11.2026).
// ════════════════════════════════════════════════════════════════════════════
const PH = await import('../../src/core/purchases/purchase-house.ts');
const PE = await import('../../src/core/purchases/purchase-edit-house.ts');
const PL = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const CC = await import('../../src/core/bridge/commercial-commands.ts');
const VIEW = await import('../../src/core/products/product-models-view.ts');
const VS = await import('../../src/core/products/variant-seed.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { matchesDeep } = await import('../../src/core/utils/deep-search.ts');
const S = (v: unknown): string => JSON.stringify(v);
const rows = (db: Db, sql: string, p: unknown[] = []): unknown[][] => db.exec(sql, p)[0]?.values ?? [];
const modelOf = (db: Db, id: string): string | null => (one(db, 'SELECT model_key FROM product_models WHERE product_id = ?', [id]) as string | null) ?? null;
const lineProducts = (db: Db, pid: string): string[] => rows(db, 'SELECT product_id FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid]).map((r) => String(r[0]));
const tabellen = (db: Db): string => S(['products', 'purchases', 'purchase_lines', 'stock_lots', 'ledger_entries', 'product_models', 'media_links', 'purchase_payments']
  .map((t) => n(db, `SELECT COUNT(*) FROM ${t}`)));
function setup() {
  const db = freshDb();
  useAuthStore.setState({ session: { role: 'ADMIN', branchId: 'branch-main', userId: 'user-test' } } as never);
  const sup = useSupplierStore.getState().createSupplier({ name: 'Gold Dealer' } as never).id;
  return { db, sup };
}
const VARIANT_SPEC = (karat: string, size: string, extra: Record<string, unknown> = {}) => ({
  categoryId: 'cat-bgj', brand: 'Cartier', name: 'Love Bracelet', taxScheme: 'MARGIN', plannedSalePrice: 3400,
  attributes: { item_type: 'Bracelet', karat, size, weight: 36.2 }, ...extra,
});
const line = (spec: Record<string, unknown>, unitPrice: number, variant?: Record<string, unknown>) => ({
  mode: 'new', newProduct: spec, brand: String(spec.brand ?? ''), name: String(spec.name ?? ''), sku: '', categoryId: String(spec.categoryId ?? ''),
  quantity: 1, unitPrice, ...(variant ? { variant } : {}),
});
const kauf = (sup: string, lines: unknown[], extra: Record<string, unknown> = {}) => ({
  supplierId: sup, purchaseDate: '2026-11-20', taxScheme: 'ZERO', lines, paymentAmount: 0, paymentMethod: 'bank', ...extra,
});
const codeOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return ''; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); } };

// ── 1 Ausgangsartikel OHNE Modell: das Modell entsteht; zwei Varianten in EINEM Einkauf; Bild ohne neue Datei ──
{
  const { db, sup } = setup();
  const anchor = await item('17', 21, { attributes: { item_type: 'Bracelet', size: '17', karat: '18K Yellow' } });
  const pick = M.activeGallery(anchor, 'branch-main')[0];
  const files0 = files(db);
  const purchase = await PH.createPurchaseOnPrimary(kauf(sup, [
    line(VARIANT_SPEC('18K White', '16'), 2600, { anchorProductId: anchor }),
    line(VARIANT_SPEC('18K Yellow', '18'), 2700, { anchorProductId: anchor, pickMediaId: pick }),
  ]) as never);
  const [v1, v2] = lineProducts(db, purchase.id);
  const key = modelOf(db, anchor);
  ok(!!key && modelOf(db, v1) === key && modelOf(db, v2) === key && n(db, 'SELECT COUNT(*) FROM product_models WHERE model_key = ?', [key]) === 3,
    'A1 Ausgangsartikel ohne Modell: beim Speichern entsteht EIN Modell — Original + beide Varianten desselben Einkaufs');
  ok(M.activeGallery(v2, 'branch-main').join() === pick && M.activeGallery(v1, 'branch-main').length === 0 && files(db) === files0,
    'A2 Bild nur auf Wunsch: Variante 2 verweist auf das bestehende Medium, keine neue Datei; Variante 1 ohne Bild');
  ok(S(rows(db, 'SELECT sku FROM products WHERE id IN (?, ?) ORDER BY sku', [v1, v2]).map((r) => !!r[0])) === S([true, true])
    && one(db, 'SELECT sku FROM products WHERE id = ?', [v1]) !== one(db, 'SELECT sku FROM products WHERE id = ?', [v2]),
    'A3 jede Variante hat eine eigene, automatisch vergebene SKU');
  const a1 = JSON.parse(String(one(db, 'SELECT attributes FROM products WHERE id = ?', [v1])));
  ok(a1.karat === '18K White' && a1.size === '16' && Number(one(db, 'SELECT planned_sale_price FROM products WHERE id = ?', [v1])) === 3400
    && one(db, 'SELECT tax_scheme FROM products WHERE id = ?', [v1]) === 'MARGIN',
    'A4 eigene Werte: Karat & Color (anderer als das Original), Größe, Verkaufspreis, gewählte Steuerart');
  ok(n(db, 'SELECT COUNT(*) FROM product_models') === 3 && one(db, 'SELECT COUNT(*) FROM audit_log WHERE entity_type = ?', ['product_models']) === 3,
    'A5 nur product_models (+ Audit) für die Zuordnung');
  // Anzeige: Modellkarte nach Größe UND Karat & Color, Tabelle, Suche nach Kurzform
  useProductStore.getState().loadProducts();
  const ps = useProductStore.getState().products;
  const s = VIEW.summarizeModel(key!, VIEW.modelMembers(ps, useProductStore.getState().productModels, key!));
  ok(S(s.sizes) === S([{ size: '16 · 18K WG', count: 1 }, { size: '17 · 18K YG', count: 1 }, { size: '18 · 18K YG', count: 1 }]),
    `A6 Modellkarte: „16 · 18K WG ×1", „17 · 18K YG ×1", „18 · 18K YG ×1" (${S(s.sizes)})`);
  const p1 = ps.find((p) => p.id === v1)!;
  db.run("UPDATE categories SET attributes = ? WHERE id = 'cat-bgj'", [JSON.stringify([
    { key: 'item_type', label: 'Item Type', type: 'select', options: ['Bracelet'] }, { key: 'size', label: 'Size', type: 'text' },
    { key: 'karat', label: 'Karat & Color', type: 'select', options: ['18K Yellow', '18K White', '18K Rose'] }, { key: 'weight', label: 'Weight', type: 'number' }])]);
  useProductStore.getState().loadCategories();
  // wie die Collection: die Kategorie entscheidet, welche Merkmale fachlich sind; dazu die Kurzform zur Laufzeit
  const cat = useProductStore.getState().categories.find((c) => c.id === p1.categoryId);
  const such = (q: string): boolean => matchesDeep(p1, q, [cat, ...VS.karatSearchTerms(p1)]);
  ok(VIEW.karatOf(p1) === '18K WG' && such('WG') && such('18k wg') && !such('YG') && such('18K White'),
    'A7 Tabelle „18K WG"; Suche findet WG, 18k wg, 18K White — nicht YG (nichts gespeichert)');
  ok(!/WG|YG/.test(String(one(db, 'SELECT attributes FROM products WHERE id = ?', [v1]))), 'A8 keine Kurzform gespeichert — nur „18K White" im Merkmal karat');
}

// ── 2 Bestehendes Modell + identische Buchung gegenüber „New Item" ──
{
  const { db, sup } = setup();
  const a = await item('16', 31, { attributes: { item_type: 'Bracelet', size: '16', karat: '18K Rose' } });
  const b = await item('17', 32, { attributes: { item_type: 'Bracelet', size: '17', karat: '18K Rose' } });
  const { modelKey } = M.groupProductsInHouse({ productIds: [a, b] }, CTX);
  const normal = await PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K Rose', '19'), 2500)], { taxScheme: 'VAT_10' }) as never);
  const variante = await PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K Rose', '19'), 2500, { anchorProductId: b })], { taxScheme: 'VAT_10' }) as never);
  const nv = lineProducts(db, variante.id)[0], nn = lineProducts(db, normal.id)[0];
  ok(modelOf(db, nv) === modelKey && modelOf(db, nn) === null, 'B1 Ausgangsartikel mit Modell: die Variante tritt DIESEM Modell bei');
  const buch = (pid: string) => S(rows(db, `SELECT account, direction, amount, counterparty_type FROM ledger_entries
    WHERE source_id = ? OR source_id IN (SELECT id FROM purchase_lines WHERE purchase_id = ?) ORDER BY account, direction`, [pid, pid]));
  const los = (prod: string) => S(rows(db, 'SELECT unit_cost, qty_total, qty_remaining, status FROM stock_lots WHERE product_id = ?', [prod]));
  const zeile = (pid: string) => S(rows(db, 'SELECT quantity, unit_price, line_total, tax_scheme, vat_rate, vat_amount, created_product FROM purchase_lines WHERE purchase_id = ?', [pid]));
  const kopf = (pid: string) => S(rows(db, 'SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [pid]));
  ok(buch(variante.id) === buch(normal.id) && buch(normal.id) !== '[]', `B2 Buchungen identisch zu „New Item" (${buch(variante.id)})`);
  ok(los(nv) === los(nn) && zeile(variante.id) === zeile(normal.id) && kopf(variante.id) === kopf(normal.id),
    'B3 Los (Einstand = Zeilenpreis), Zeile (Vorsteuer), Verbindlichkeit identisch — keine doppelte Kostenbuchung');
  ok(Number(one(db, 'SELECT purchase_price FROM products WHERE id = ?', [nv])) === Number(one(db, 'SELECT purchase_price FROM products WHERE id = ?', [nn])),
    'B4 Einkaufspreis des Artikels nur aus der Einkaufszeile');
}

// ── 3 Rollback: ein Nein der Modellregel/Bildregel lässt NICHTS zurück; Prüfungen ──
{
  const { db, sup } = setup();
  const anchor = await item('17', 41, { attributes: { item_type: 'Bracelet', size: '17', karat: '18K Yellow' } });
  const vorher = tabellen(db);
  const c1 = await codeOf(PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K White', '16'), 2600, { anchorProductId: anchor, pickMediaId: 'media-fremd' })]) as never));
  ok(c1 === 'MODEL_PHOTO_NOT_IN_MODEL' && tabellen(db) === vorher, `C1 Nein NACH der Anlage (fremdes Bild): kein Einkauf, kein Artikel, kein Los, keine Buchung, kein Modell (${c1})`);
  const c2 = await codeOf(PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K White', '16', { brand: 'Bulgari' }), 2600, { anchorProductId: anchor })]) as never));
  ok(c2 === 'PRODUCT_MODEL_INCOMPATIBLE' && tabellen(db) === vorher, `C2 passt nicht (andere Marke): nichts geschrieben (${c2})`);
  const c3 = await codeOf(PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K White', '16', { taxScheme: undefined }), 2600, { anchorProductId: anchor })]) as never));
  ok(c3 === 'PURCHASE_VARIANT_TAX_SCHEME_REQUIRED' && tabellen(db) === vorher, `C3 Steuerart nicht gewählt: abgewiesen (${c3})`);
  const kom = await item('18', 42, { attributes: { item_type: 'Bracelet', size: '18', karat: '18K Yellow' } });
  db.run("UPDATE products SET source_type = 'CONSIGNMENT' WHERE id = ?", [kom]);
  const vorher4 = tabellen(db);
  const c4 = await codeOf(PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K White', '16'), 2600, { anchorProductId: kom })]) as never));
  ok(c4 === 'PRODUCT_MODEL_VARIANT_CONSIGNMENT' && tabellen(db) === vorher4, `C4 Kommissionsware als Ausgangsartikel: abgewiesen, Kommission unberührt (${c4})`);
  const fremd = await item('19', 43);
  db.run("UPDATE products SET branch_id = 'branch-other' WHERE id = ?", [fremd]);
  const vorher5 = tabellen(db);
  const c5 = await codeOf(PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K White', '16'), 2600, { anchorProductId: fremd })]) as never));
  ok(c5 === 'PRODUCT_MODEL_OTHER_BRANCH' && tabellen(db) === vorher5, `C5 andere Filiale: abgewiesen (${c5})`);
  const c6 = await codeOf(PH.createPurchaseOnPrimary(kauf(sup, [{ mode: 'existing', productId: anchor, brand: '', name: '', sku: '', categoryId: '', quantity: 1, unitPrice: 5, variant: { anchorProductId: anchor } }]) as never));
  ok(c6 === 'PURCHASE_VARIANT_NEW_ITEM_ONLY', `C6 Variante nur an einer Zeile mit neuem Artikel (${c6})`);
}

// ── 4 PC2: ein Auftrag purchases.create; Wiederholung ohne Duplikat; strenger Rumpf; alter PC2 ──
{
  const { db, sup } = setup();
  const anchor = await item('17', 51, { attributes: { item_type: 'Bracelet', size: '17', karat: '18K Yellow' } });
  const pick = M.activeGallery(anchor, 'branch-main')[0];
  const idp = (x: string) => ({ ...ident(x), op: 'purchases.create', payloadHash: 'hp' + x, role: 'ADMIN' });
  const body = kauf(sup, [line(VARIANT_SPEC('18K White', '16'), 2600, { anchorProductId: anchor, pickMediaId: pick })]);
  const p0 = products(db);
  const r1 = await CC.runPurchaseCreate(deps(db) as never, idp('1') as never, body);
  const pid = r1.kind === 'ok' ? String((r1.value as { purchaseId?: string }).purchaseId) : '';
  const nv = pid ? lineProducts(db, pid)[0] : '';
  ok(r1.kind === 'ok' && products(db) === p0 + 1 && !!modelOf(db, nv) && modelOf(db, nv) === modelOf(db, anchor) && M.activeGallery(nv, 'branch-main').join() === pick,
    `D1 PC2: EIN Auftrag legt Einkauf, Artikel, Modell und Bildverweis an (${r1.kind} ${(r1 as { code?: string }).code ?? ''})`);
  const r2 = await CC.runPurchaseCreate(deps(db) as never, idp('1') as never, body);
  ok(r2.kind === 'ok' && (r2 as { replayed?: boolean }).replayed === true && products(db) === p0 + 1 && n(db, 'SELECT COUNT(*) FROM purchases') === 1
    && n(db, 'SELECT COUNT(*) FROM product_models') === 2, 'D2 verlorene Antwort → dieselbe Kennung: kein zweiter Einkauf, kein zweiter Artikel, keine doppelte Zuordnung');
  const vorher = tabellen(db);
  const r3 = await CC.runPurchaseCreate(deps(db) as never, idp('2') as never, kauf(sup, [line(VARIANT_SPEC('18K White', '15'), 2600, { anchorProductId: anchor, pickMediaId: 'media-fremd' })]));
  ok(r3.kind === 'rejected' && (r3 as { frozen?: boolean }).frozen === true && tabellen(db) === vorher, `D3 PC2: Nein nach der Anlage rollt alles zurück, eingefroren (${(r3 as { code?: string }).code})`);
  let bad = ''; try { CC.parsePurchaseCreate(kauf(sup, [line(VARIANT_SPEC('18K White', '15'), 1, { anchorProductId: anchor, sneaky: 1 })])); } catch (e) { bad = String((e as { code?: string }).code ?? e); }
  let both = ''; try { CC.parsePurchaseCreate(kauf(sup, [line(VARIANT_SPEC('18K White', '15'), 1, { anchorProductId: anchor, modelKey: 'mdl-x' })])); } catch (e) { both = String((e as { code?: string }).code ?? e); }
  ok(bad !== '' && both !== '', `D4 strenger Rumpf: unbekanntes Feld / beide Ziele abgewiesen (${bad} | ${both})`);
  const alt = await CC.runPurchaseCreate(deps(db) as never, idp('3') as never, kauf(sup, [line({ ...VARIANT_SPEC('18K White', '14'), plannedSalePrice: undefined }, 900)]));
  const altP = alt.kind === 'ok' ? lineProducts(db, String((alt.value as { purchaseId?: string }).purchaseId))[0] : '';
  ok(alt.kind === 'ok' && !!altP && modelOf(db, altP) === null, 'D5 Rumpf eines alten PC2 (ohne variant): Einkauf wie bisher, ohne Modell');
}

// ── 5 Einkauf bearbeiten (Zeile entfernen) und stornieren ──
{
  const { db, sup } = setup();
  const anchor = await item('17', 61, { attributes: { item_type: 'Bracelet', size: '17', karat: '18K Yellow' } });
  const p = await PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K Yellow', '18'), 2700), line(VARIANT_SPEC('18K White', '16'), 2600, { anchorProductId: anchor })]) as never);
  const [normal, v] = lineProducts(db, p.id);
  ok(!!modelOf(db, anchor) && modelOf(db, v) === modelOf(db, anchor), 'E0 Modell aus Original + Variante');
  const lid = String(one(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ? AND product_id = ?', [p.id, v]));
  posting.beginLedgerTransaction();
  try { PE.editPurchaseInHouse({ purchaseId: p.id, reason: 'wrong line', removeLineIds: [lid] } as never, { branchId: 'branch-main', userId: 'user-test', now: NOW }); posting.commitLedgerTransaction(); }
  catch (e) { posting.rollbackLedgerTransaction(); console.log('    (edit) ' + String((e as { code?: string }).code ?? e)); }
  ok(n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [v]) === 0 && modelOf(db, anchor) === null && n(db, 'SELECT COUNT(*) FROM product_models') === 0,
    'E1 Zeile entfernen: der angelegte Artikel geht über den sicheren Aufräumweg; das Ein-Stück-Modell löst sich auf (Zustand wie vorher)');
  ok(n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [normal]) === 1, 'E2 die andere Zeile bleibt');
  // Storno: Modellzuordnung + Historie bleiben, der stornierte Bestand ist nicht verfügbar
  const p2 = await PH.createPurchaseOnPrimary(kauf(sup, [line(VARIANT_SPEC('18K White', '16'), 2600, { anchorProductId: anchor })]) as never);
  const v2 = lineProducts(db, p2.id)[0];
  const key = modelOf(db, v2)!;
  posting.beginLedgerTransaction();
  try { PL.cancelPurchaseInHouse(p2.id, 'branch-main'); posting.commitLedgerTransaction(); }
  catch (e) { posting.rollbackLedgerTransaction(); console.log('    (cancel) ' + String((e as { code?: string }).code ?? e)); }
  useProductStore.getState().loadProducts();
  const ps = useProductStore.getState().products;
  const s = VIEW.summarizeModel(key, VIEW.modelMembers(ps, useProductStore.getState().productModels, key));
  ok(String(one(db, 'SELECT status FROM purchases WHERE id = ?', [p2.id])) === 'CANCELLED' && modelOf(db, v2) === key,
    'E3 Storno: Einkauf CANCELLED, die Variante bleibt im Modell (Historie)');
  ok(!s.available.some((m) => m.id === v2) && !s.sizes.some((z) => z.size === '16 · 18K WG') && String(one(db, 'SELECT stock_status FROM products WHERE id = ?', [v2])) !== 'in_stock',
    `E4 …aber der stornierte Bestand ist NICHT verfügbar (Status ${String(one(db, 'SELECT stock_status FROM products WHERE id = ?', [v2]))}, Karte ${S(s.sizes)})`);
}

// ── 6 Vorbelegung, Etikett, Collections, New Stock ──
{
  const t = { id: 'x', categoryId: 'cat-bgj', brand: 'Cartier', name: 'Love', condition: 'New', scopeOfDelivery: ['Box'], taxScheme: 'MARGIN',
    attributes: { item_type: 'Bracelet', karat: '18K Rose', size: '17', weight: 30, serial_number: 'S1', model_number: 'B6067', year: '2020', description: 'Classic' } } as never;
  const seed = VS.variantSeed(t);
  const sa = seed.attributes as Record<string, unknown>;
  ok(seed.taxScheme === undefined && sa.karat === '18K Rose' && sa.model_number === 'B6067' && sa.description === 'Classic' && sa.item_type === 'Bracelet'
    && !('size' in sa) && !('weight' in sa) && !('serial_number' in sa) && !('year' in sa) && S(seed.images) === '[]',
    'F1 Vorbelegung: gemeinsame Angaben + Karat & Color als Vorschlag; Größe, Gewicht, Seriennummer, Jahr, Fotos leer; Steuerart nie übernommen');
  ok(VS.karatShort('18K Yellow') === '18K YG' && VS.karatShort('18K Mix') === '18K MIX' && VS.karatShort('Silver') === 'SILVER'
    && /return karatShort\(karat\)/.test(src('src/core/print/zpl-tag.ts')), 'F2 EINE Kurzform-Regel: Etikett und Modellkarte nutzen dieselbe Funktion');
  const wl = src('src/pages/watches/WatchList.tsx');
  ok(/openVariant\(template, key \?\? null\)/.test(wl) && /anchorProductId: variantCtx\.templateId/.test(wl), 'F3 Collections: Add variant auch ohne Modell (Ausgangsartikel)');
  ok(/if \(variantIntent\) return createVariantOnPrimary\(plan\.data, variantIntent\);\n\s*return createProductWithMedia\(plan\.data, retryProductId \?\? undefined\);/.test(wl),
    'F4 New Stock (New Item ohne Variante) unverändert: createProductWithMedia');
  ok(/data-merge-karat-warning/.test(src('src/components/products/models/MergePhotosModal.tsx')) && /data-line-variant-photo-warning/.test(src('src/pages/purchases/PurchaseCreate.tsx'))
    && /data-variant-photo-karat-warning/.test(wl), 'F5 Warnung bei anderem Karat & Color: Einkauf, Collections, Merge photos');
}

console.log(`\npurchase-add-variant: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
console.log('PURCHASE_ADD_VARIANT_PROVED');
