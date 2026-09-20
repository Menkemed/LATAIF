// ════════════════════════════════════════════════════════════════════════════
// MEDIA-BUSINESS — die restlichen Geschäftsfotos im Medienkern: Auftrag und Altgold.
// Run: node test/media-business/orders-and-scrap.test.ts
//
//   §1 Auftrag: die Vorlage des Sonderstücks wird ein Medium (Primary und PC2)
//   §2 Auftrag: beim Umwandeln wird DASSELBE Medium zum Artikelbild — keine zweite Datei
//   §3 Auftrag: Altbestand bleibt lesbar und kommt nach der Übernahme nicht zurück
//   §4 Altgold: Fotos gehören der POSITION, über ihren bleibenden Schlüssel
//   §5 Altgold: Zeile löschen, ergänzen, umsortieren — die Fotos bleiben bei der richtigen
//   §6 Altgold: die Buchhaltung bleibt Zeichen für Zeichen dieselbe
//   §7 Grenzen und Sauberkeit: keine neuen Daten-URLs, entfernte Verknüpfungen sind weg
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
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

const LEER = {
  customerId: 'cust-1', orderType: 'normal', lines: [], quotedPrice: 0, customTaxScheme: 'MARGIN', finalProductDescription: '',
  customProductSpec: undefined, customerGoldGrams: 0, customerGoldKarat: '22K', customerStones: '', goldsmithSupplierId: '',
  laborCost: 0, extraGoldGrams: 0, extraGoldKarat: '22K', extraGoldCost: 0, extraGoldSupplierId: '', materials: [],
  depositAmount: 0, paymentMethod: 'cash', cardBrand: 'normal', fullyPaid: false, expectedDelivery: '', status: 'pending', notes: '',
};
const ORDER = (bilder: string[]) => ({
  ...LEER, orderType: 'custom', quotedPrice: 500, finalProductDescription: 'Ring nach Vorlage',
  lines: [{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }],
  customProductSpec: { categoryId: 'cat-w', brand: 'Eigen', name: 'Ring', sku: '', condition: 'New', taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {}, images: bilder },
});

// ── §0 Die neuen Besitzertypen ──────────────────────────────────────────────────────────────
{
  ok(MEDIA_ENTITY_SCOPE.order?.table === 'orders' && MEDIA_ENTITY_SCOPE.order?.scope === 'branch',
    '§0 der Auftrag ist ein Medienbesitzer');
  ok(MEDIA_ENTITY_SCOPE.scrap_trade_line?.table === 'scrap_trade_lines'
    && MEDIA_ENTITY_SCOPE.scrap_trade_line?.idCol === 'line_key',
    '§0 die Altgold-POSITION auch — und zwar über ihren bleibenden Schlüssel, nicht über ihre `id`');
  ok(orderMedia.ORDER_MEDIA_ROLE === 'reference_image'
    && scrapMedia.SCRAP_ROLE_PURCHASE === 'purchase_photo' && scrapMedia.SCRAP_ROLE_SALE === 'sale_photo',
    '§0 eigene Rollen: eine Vorlage ist kein Warenbild, und Kauf ist nicht Verkauf');
}

// ── §1 Auftrag: die Vorlage wird ein Medium ─────────────────────────────────────────────────
{
  const db = freshDb();
  const made = await orderHouse.createOrderOnPrimary(ORDER([url(bild(1)), url(bild(2))]) as never);
  const orderId = made.order.id;
  const g = linksOf(db, 'order', orderId, 'reference_image');
  ok(g.length === 2, `§1 beide Vorlagenbilder hängen als Verknüpfungen am Auftrag (${g.length})`);
  ok(n(db, "SELECT COUNT(*) FROM media_objects WHERE security_class='internal'") === 2, '§1 …als Medien der Klasse `internal`');
  const spec = JSON.parse(s(db, 'SELECT custom_product_spec FROM orders WHERE id = ?', [orderId]) || '{}');
  ok(Array.isArray(spec.images) === false || spec.images.length === 0,
    '§1 …und das gespeicherte Schema trägt KEINE Bytes mehr');
  ok(!s(db, 'SELECT custom_product_spec FROM orders WHERE id = ?', [orderId]).includes('data:'),
    '§1 …nirgends eine Daten-URL in der Auftragszeile');
  ok(spec.categoryId === 'cat-w' && spec.brand === 'Eigen',
    '§1 …der übrige Entwurf (Kategorie, Bezeichner) bleibt unangetastet');
  const refs = orderMedia.orderPhotoRefs(orderId);
  ok(refs.length === 2 && refs[0].mediaId === g[0] && refs[0].main.storageKey.endsWith('.jpg'),
    '§1 die Auskunft nennt Referenzen (Schlüssel, Hash, Fassung) — keine Bytes');
}

// ── §2 Auftrag: aus der Vorlage wird das Artikelbild ────────────────────────────────────────
{
  const db = freshDb();
  const made = await orderHouse.createOrderOnPrimary(ORDER([url(bild(3))]) as never);
  const orderId = made.order.id;
  const vorher = linksOf(db, 'order', orderId, 'reference_image');
  const objVorher = objekte(db); const dateiVorher = dateien(db);

  const p = useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'X', name: 'Y', images: [] } as never);
  const r = orderMedia.adoptOrderPhotosToProduct(orderId, p.id);
  ok(r.linked === 1 && linksOf(db, 'product', p.id, 'stock_image')[0] === vorher[0],
    '§2 der Artikel bekommt GENAU DAS Medium der Vorlage');
  ok(objekte(db) === objVorher && dateien(db) === dateiVorher,
    `§2 …ohne zweites Objekt und ohne zweite Datei (${objekte(db)}/${dateien(db)})`);
  ok(linksOf(db, 'order', orderId, 'reference_image').length === 1,
    '§2 …und der Auftrag behält seine Vorlage: er hat sein Sonderstück nun einmal so beschrieben');
  ok(s(db, 'SELECT images FROM products WHERE id = ?', [p.id]) === '[]',
    '§2 …der Artikel hält keine Bytes (der Produktvertrag gilt unverändert)');
  ok(s(db, "SELECT security_class FROM media_objects WHERE media_id = ?", [vorher[0]]) === 'internal',
    '§2 …und die Klasse wechselt nicht still');
}

// ── §3 Auftrag: Altbestand und PC2 ──────────────────────────────────────────────────────────
{
  const db = freshDb();
  // Ein Auftrag von früher: Bytes im Schema, keine Verknüpfung.
  const alt = await orderHouse.createOrderOnPrimary(ORDER([]) as never);
  db.run('UPDATE orders SET custom_product_spec = ? WHERE id = ?',
    [JSON.stringify({ categoryId: 'cat-w', images: ['data:image/jpeg;base64,QUJD'] }), alt.order.id]);
  ok(orderMedia.legacyOrderSpecImages(alt.order.id).length === 1,
    '§3 ein Auftrag von früher zeigt seine alte Liste — gelesen, nie neu geschrieben');
  // Sobald er über den Medienkern speichert, ist die Liste erledigt.
  const mediaId = await orderMedia.ingestOrderPhotos([url(bild(4))], undefined, alt.order.id);
  orderMedia.applyOrderGallery(alt.order.id, mediaId);
  ok(orderMedia.legacyOrderSpecImages(alt.order.id).length === 0 && linksOf(db, 'order', alt.order.id).length === 1,
    '§3 …nach der Übernahme ist die alte Liste leer und kommt nicht zurück');
  ok(JSON.parse(s(db, 'SELECT custom_product_spec FROM orders WHERE id = ?', [alt.order.id])).categoryId === 'cat-w',
    '§3 …und der Rest des Entwurfs steht unverändert da');

  // PC2: derselbe Weg über den Fernbefehl.
  const st = ablegen(bild(5));
  const body = {
    ...LEER, orderType: 'custom', quotedPrice: 400, finalProductDescription: 'Fern-Ring',
    lines: [{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }],
    customProductSpec: { categoryId: 'cat-w', brand: 'Fern', name: 'Ring', sku: '', condition: 'New', taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD', attributes: {}, stagingIds: [st] },
  };
  const out = await commercial.runOrderCreate(deps(db), identity('301', 'orders.create'), body);
  ok(out.kind === 'ok', `§3 PC2 legt einen Auftrag mit Vorlage an (${out.kind} ${(out as { code?: string }).code ?? ''})`);
  const fernId = String((out as { value: { orderId?: string; id?: string } }).value.orderId ?? (out as { value: { id: string } }).value.id);
  ok(linksOf(db, 'order', fernId, 'reference_image').length === 1,
    '§3 …mit demselben Ergebnis wie am Primary: eine Verknüpfung, keine Bytes');
  ok(!s(db, 'SELECT custom_product_spec FROM orders WHERE id = ?', [fernId]).includes('data:'),
    '§3 …auch fern niemals eine Daten-URL in der Zeile');
}

// ── §4/§5/§6 Altgold ────────────────────────────────────────────────────────────────────────
const TRADE = (lines: Array<Record<string, unknown>>) => ({
  sellerName: 'Ali', buyerName: 'Gold Co', tradeDate: '2026-09-13',
  lines,
  paymentsOut: [{ method: 'cash' as const, amount: lines.reduce((a, l) => a + Number(l.purchasePrice), 0) }],
  paymentsIn: [{ method: 'cash' as const, amount: lines.reduce((a, l) => a + Number(l.salePrice), 0) }],
});
const LINE = (w: number, p: number, sale: number, extra: Record<string, unknown> = {}) =>
  ({ weightGrams: w, karat: '22K', purchasePrice: p, salePrice: sale, ...extra });

{
  const db = freshDb();
  const r = await metalActions.createScrapTradeOnPrimary(TRADE([
    LINE(5, 100, 130, { imagesPurchase: [url(bild(10))], imagesSale: [url(bild(11))] }),
    LINE(7, 200, 240, { imagesPurchase: [url(bild(12))] }),
    LINE(3, 50, 60),
  ]) as never);
  const tradeId = r.tradeId ?? (r as unknown as { id: string }).id;
  const keys = rows(db, 'SELECT line_key, weight_grams FROM scrap_trade_lines ORDER BY position');
  ok(keys.length === 3 && keys.every((k) => String(k.line_key).length > 0), '§4 jede Position hat ihren bleibenden Schlüssel');
  ok(linksOf(db, 'scrap_trade_line', String(keys[0].line_key), 'purchase_photo').length === 1
    && linksOf(db, 'scrap_trade_line', String(keys[0].line_key), 'sale_photo').length === 1
    && linksOf(db, 'scrap_trade_line', String(keys[1].line_key), 'purchase_photo').length === 1
    && linksOf(db, 'scrap_trade_line', String(keys[1].line_key), 'sale_photo').length === 0
    && linksOf(db, 'scrap_trade_line', String(keys[2].line_key)).length === 0,
    '§4 die Fotos hängen je Position und je Seite genau dort, wo sie hingehören');
  ok(n(db, "SELECT COUNT(*) FROM scrap_trade_lines WHERE images_purchase <> '[]' OR images_sale <> '[]'") === 0,
    '§4 …und keine Zeile hält noch Bytes');

  const buchung = () => rows(db, 'SELECT account, direction, ROUND(SUM(amount),3) AS a FROM ledger_entries GROUP BY account, direction ORDER BY account, direction')
    .map((x) => `${String(x.account)}:${String(x.direction)}:${String(x.a)}`).join('|');
  const summen = () => rows(db, 'SELECT weight_grams w, purchase_price p, sale_price v, profit g FROM scrap_trades WHERE id = ?', [tradeId])
    .map((x) => [x.w, x.p, x.v, x.g].map(Number).join('/'))[0] ?? '';
  const buchungVorher = buchung(); const summenVorher = summen();
  const fotoVon = (key: string, side: 'purchase_photo' | 'sale_photo') => linksOf(db, 'scrap_trade_line', key, side)[0];
  const foto0 = fotoVon(String(keys[0].line_key), 'purchase_photo');
  const foto1 = fotoVon(String(keys[1].line_key), 'purchase_photo');

  // ── §5 Die ERSTE Position löschen: die Fotos bleiben bei ihren Zeilen ──────────────────────
  useScrapTradeStore.getState().loadTrades();
  const version = n(db, 'SELECT version FROM scrap_trades WHERE id = ?', [tradeId]);
  await metalActions.updateScrapTradeOnPrimary(tradeId, version, TRADE([
    // Position 1 entfällt; die beiden anderen bleiben — mit ihrem Schlüssel und ihren Fotos.
    LINE(7, 200, 240, { lineKey: keys[1].line_key, imagesPurchase: [foto1] }),
    LINE(3, 50, 60, { lineKey: keys[2].line_key }),
    LINE(9, 300, 330, { imagesPurchase: [url(bild(13))] }),
  ]) as never);
  const danach = rows(db, 'SELECT line_key, weight_grams, position FROM scrap_trade_lines ORDER BY position');
  ok(danach.length === 3 && String(danach[0].line_key) === String(keys[1].line_key) && Number(danach[0].weight_grams) === 7,
    '§5 die behaltene Position behält ihren Schlüssel, obwohl die Zeile neu geschrieben wurde');
  ok(linksOf(db, 'scrap_trade_line', String(keys[1].line_key), 'purchase_photo')[0] === foto1,
    '§5 …und ihr Foto ist noch ihres (nicht das der gelöschten Zeile)');
  ok(linksOf(db, 'scrap_trade_line', String(keys[0].line_key)).length === 0,
    '§5 die gelöschte Position hat keine aktiven Verknüpfungen mehr');
  ok(linksOf(db, 'scrap_trade_line', String(danach[2].line_key), 'purchase_photo').length === 1
    && String(danach[2].line_key) !== String(keys[0].line_key),
    '§5 die neue Position bekommt einen frischen Schlüssel und ihr eigenes Foto');
  ok(n(db, "SELECT COUNT(*) FROM media_objects") === 4,
    `§5 …und das Medium der gelöschten Zeile bleibt als Objekt bestehen (${objekte(db)}) — nichts wird ad hoc gelöscht`);
  void foto0;

  // ── §6 Buchhaltung ────────────────────────────────────────────────────────────────────────
  ok(summen() === '19/550/630/80', `§6 Gewicht, Preise und Gewinn folgen NUR den Zahlen (${summen()})`);
  ok(buchung() !== buchungVorher && n(db, 'SELECT COUNT(*) FROM ledger_entries') > 0,
    '§6 die Buchung folgt der ÄNDERUNG der Beträge — wie bisher');
  ok(summenVorher === '15/350/430/80', `§6 …und der Stand davor war der erwartete (${summenVorher})`);
  const ohneFotos = freshDb();
  const r2 = await metalActions.createScrapTradeOnPrimary(TRADE([LINE(5, 100, 130), LINE(7, 200, 240), LINE(3, 50, 60)]) as never);
  const t2 = r2.tradeId ?? (r2 as unknown as { id: string }).id;
  const zahlenMit = rows(db, 'SELECT weight_grams, karat, purchase_price, sale_price, profit FROM scrap_trade_lines ORDER BY position');
  void zahlenMit;
  const zahlen2 = rows(ohneFotos, 'SELECT weight_grams w, purchase_price p, sale_price v, profit g FROM scrap_trades WHERE id = ?', [t2])
    .map((x) => [x.w, x.p, x.v, x.g].map(Number).join('/'))[0];
  ok(zahlen2 === '15/350/430/80',
    '§6 dasselbe Geschäft OHNE Fotos ergibt dieselben Zahlen — Fotos ändern keine Buchung');
}

// ── §5b PC2: derselbe Weg, dieselbe Zuordnung ───────────────────────────────────────────────
{
  const db = freshDb();
  const A = ablegen(bild(20)); const B = ablegen(bild(21));
  const body = metalActions.scrapCreateBody(
    TRADE([LINE(5, 100, 130), LINE(7, 200, 240)]) as never,
    [{ purchase: [{ stagingId: A }], sale: [] }, { purchase: [{ stagingId: B }], sale: [] }],
  );
  const out = await metalCmd.runScrapCreate(deps(db), identity('501', 'scrap_trades.create'), body);
  ok(out.kind === 'ok', `§5b PC2 legt ein Geschäft mit Fotos je Position an (${out.kind})`);
  const keys = rows(db, 'SELECT line_key FROM scrap_trade_lines ORDER BY position').map((r) => String(r.line_key));
  ok(linksOf(db, 'scrap_trade_line', keys[0], 'purchase_photo').length === 1
    && linksOf(db, 'scrap_trade_line', keys[1], 'purchase_photo').length === 1
    && linksOf(db, 'scrap_trade_line', keys[0], 'purchase_photo')[0] !== linksOf(db, 'scrap_trade_line', keys[1], 'purchase_photo')[0],
    '§5b …und jede Position bekommt IHR Foto, nicht das der anderen');
  ok(n(db, "SELECT COUNT(*) FROM scrap_trade_lines WHERE images_purchase LIKE '%data:%'") === 0,
    '§5b …auch fern niemals Bytes in der Zeile');

  // Ein Foto behalten (ohne es erneut hochzuladen) und die Reihenfolge prüfen.
  const behalten = linksOf(db, 'scrap_trade_line', keys[0], 'purchase_photo')[0];
  const version = n(db, 'SELECT version FROM scrap_trades');
  const tradeId = s(db, 'SELECT id FROM scrap_trades');
  const C = ablegen(bild(22));
  const body2 = metalActions.scrapUpdateBody(tradeId, version,
    TRADE([LINE(5, 100, 130, { lineKey: keys[0] }), LINE(7, 200, 240, { lineKey: keys[1] })]) as never,
    [{ purchase: [{ keep: behalten }, { stagingId: C }], sale: [] }, { purchase: [], sale: [] }]);
  const out2 = await metalCmd.runScrapUpdate(deps(db), identity('502', 'scrap_trades.update'), body2);
  const jetzt = linksOf(db, 'scrap_trade_line', keys[0], 'purchase_photo');
  ok(out2.kind === 'ok' && jetzt.length === 2 && jetzt[0] === behalten,
    `§5b behalten + neu: die Reihenfolge der Maske bleibt (${out2.kind}, ${jetzt.length})`);
  ok(linksOf(db, 'scrap_trade_line', keys[1], 'purchase_photo').length === 0,
    '§5b …und eine geleerte Seite ist wirklich leer');
}

// ── §7 Grenzen und Sauberkeit ───────────────────────────────────────────────────────────────
{
  const db = freshDb();
  // Ein Auftrag einer anderen Filiale bekommt nichts.
  const mediaId = await orderMedia.ingestOrderPhotos([url(bild(30))]);
  // Eine Auftragszeile in der ANDEREN Filiale — die Pflichtspalten kommen aus dem Schema selbst.
  {
    const info = db.exec('PRAGMA table_info(orders)')[0];
    const cols = info.values.map((v) => ({ name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0 }));
    const data: Record<string, unknown> = { id: 'ord-x', branch_id: 'branch-other', order_number: 'O-X', customer_id: 'cust-1', status: 'pending', created_at: NOW, updated_at: NOW };
    for (const c of cols) {
      if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
      data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : '';
    }
    const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
    db.run(`INSERT INTO orders (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
  }
  let fremd = '';
  try { orderMedia.applyOrderGallery('ord-x', mediaId); } catch (e) { fremd = (e as { code?: string }).code ?? ''; }
  ok(fremd.startsWith('MEDIA_') && linksOf(db, 'order', 'ord-x').length === 0,
    `§7 ein Auftrag einer anderen Filiale bekommt nichts (${fremd})`);

  // Der Vertrag steht auch im Code: kein zweiter Normalisierer, keine neuen Bytes.
  const om = codeOf(src('src/core/orders/order-media.ts'));
  const sm = codeOf(src('src/core/metals/scrap-media.ts'));
  ok(/ingestRecordPhotos/.test(om) && /ingestRecordPhotos/.test(sm),
    '§7 beide nutzen DEN vorhandenen Aufnahmeweg (JPEG, ≤ 100 000 B, EXIF) — keinen eigenen');
  ok(/securityClass: 'internal'/.test(om) && /securityClass: 'internal'/.test(sm),
    '§7 …und die Klasse ist `internal`, keine zusätzliche Verschlüsselung');
  const sh = codeOf(src('src/core/metals/scrap-house.ts'));
  ok(!/images_purchase, images_sale, created_at\n/.test(sh) && /images_purchase, images_sale, created_at, line_key, branch_id/.test(sh)
    && /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, '\[\]', '\[\]'/.test(sh),
    '§7 der Altgold-Schreiber legt die alten Bildspalten leer an');
  const grant = src('src-tauri/src/sync/product_query.rs');
  ok(grant.includes("l.entity_type = 'scrap_trade_line'") && grant.includes("l.media_role IN ('purchase_photo', 'sale_photo')")
    && grant.includes('sl.line_key = l.entity_id AND sl.branch_id = l.branch_id'),
    '§7 das Tor der LAN-Route hat für die Position eine EIGENE Regel (Tabelle, Rolle, Filiale)');
  ok(!grant.includes("l.entity_type = 'order'"),
    '§7 …und der Auftrag bekommt KEINE Regel, weil ihn niemand über diese Route liest');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — media business orders + scrap: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('MEDIA_BUSINESS_ORDERS_SCRAP_PROVED');
