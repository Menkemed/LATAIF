// ════════════════════════════════════════════════════════════════════════════
// SYNC-SLIM (Weg A) — neue Changelog- und Audit-Einträge tragen keinen KI-Vektor mehr; der
// Einstellungs-Backfill speichert Embeddings wirklich. Echte sql.js-Datenbank (schema.sql + echte
// Migrationen), echte Schreibwege (trackChange, updateProduct, persistProductEmbedding, applySyncChange).
// Run: node test/sync-slim/sync-slim.test.ts
//
//   S1 Artikeländerung → Changelog ohne Vektor (Bytes vorher/nachher)
//   S2 Sync-Verbraucher: Echo, Gegenstelle, neue Zeile, Reihenfolge nach Bildwechsel, Vertrag
//   S3 fehlendes Feld löscht kein Embedding            S4 Bestand + Bildsuche-Daten unverändert
//   S5 Audit: Kurznachweis statt Vektor, alte Einträge unverändert
//   S6 Backfill speichert                              S7 wiederholter Backfill: nichts Neues
//   S8 Geschäfts-, Rechnungs-, Zahlungsdaten unverändert   Q Quelltext (Koordinator, Knopf, Vertrag)
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
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const productStore = await import('../../src/stores/productStore.ts');
const { useProductStore, productEmbeddingMissing, claimEmbeddingCompute, releaseEmbeddingCompute, persistProductEmbedding } = productStore;
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { trackChange } = await import('../../src/core/sync/sync-service.ts');
const { trackUpdate } = await import('../../src/core/sync/track.ts');
const { logAudit } = await import('../../src/core/audit/audit-log.ts');
const { applySyncChange } = await import('../../src/core/sync/apply-change.ts');
const { identityDigest64, AUDIT_EMBEDDING_MARKER } = await import('../../src/core/audit/audit-value.ts');
const { runEmbeddingBackfill } = await import('../../src/core/ai/embedding-backfill.ts');
const SCHEMA = JSON.parse(readFileSync(resolvePath(repo, 'src/core/sync/sync-business-schema.json'), 'utf8'));

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-11-10T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Ein deterministischer 1536er-Vektor wie text-embedding-3-small (gleiche Zahlenform). */
function vektor(seed: number): number[] {
  let x = seed >>> 0; const v: number[] = [];
  for (let i = 0; i < 1536; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; v.push(Math.round(((x % 20000) / 10000 - 1) * 1e8) / 1e9 * 3.3); }
  return v;
}
const KLEINES_FOTO = 'data:image/jpeg;base64,' + 'A'.repeat(400);

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
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  tauriState.reset();
  return db;
}
function artikel(db: Db, id: string, emb: number[] | null, images = '[]'): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, image_hash, image_description, image_embedding, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,?,'{"reference_number":"126334"}','OWN',
            'h-' || ?, 'A steel watch on a bracelet', ?, ?, ?)`,
  [id, 'Datejust ' + id, 'SKU-' + id, images, id, emb ? JSON.stringify(emb) : null, NOW, NOW]);
}
const reload = (): void => { useProductStore.getState().loadProducts(); useCustomerStore.getState().loadCustomers(); useInvoiceStore.getState().loadInvoices(); };
const letzter = (db: Db, id: string) => {
  const r = db.exec("SELECT id, action, data FROM sync_changelog WHERE table_name = 'products' AND record_id = ? ORDER BY id DESC LIMIT 1", [id])[0]?.values?.[0];
  return r ? { id: Number(r[0]), action: String(r[1]), data: String(r[2]), obj: JSON.parse(String(r[2])) as Record<string, unknown> } : null;
};
const embOf = (db: Db, id: string): string => s(db, 'SELECT image_embedding FROM products WHERE id = ?', [id]);
const zaehle = (db: Db) => ({ cl: n(db, 'SELECT COUNT(*) FROM sync_changelog'), au: n(db, 'SELECT COUNT(*) FROM audit_log') });
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const db = freshDb();
const V1 = vektor(1), V2 = vektor(2), V3 = vektor(3);
artikel(db, 'pA', V1);
artikel(db, 'pB', V2);
reload();

// Geschäftsdaten anlegen (Rechnung + Zahlung), um später ihre Unverändertheit zu prüfen.
const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{
  productId: 'pB', quantity: 1, unitPrice: 1000, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 100, lineTotal: 1100,
}] as never, 'SLIM', '2026-11-05').id);
reload();
imHaus(() => useInvoiceStore.getState().recordPayment(inv, 500, 'cash', undefined, undefined, undefined, undefined, undefined, { receivedAt: '2026-11-06T10:00:00.000Z' }));
reload();
const geschaeft = (): string => [
  all(db, 'SELECT * FROM invoices ORDER BY id'), all(db, 'SELECT * FROM invoice_lines ORDER BY id'),
  all(db, 'SELECT * FROM payments ORDER BY id'), all(db, 'SELECT * FROM ledger_entries ORDER BY id'),
].join('|');
const geschaeftVorher = geschaeft();
// Ein „alter" Audit-Eintrag mit vollem Vektor (wie im Bestand) — er muss unverändert bleiben.
db.run(`INSERT INTO audit_log (id, branch_id, module, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by, changed_at)
        VALUES ('audit-alt', 'branch-main', 'Product', 'products', 'pA', 'UPDATE', 'imageEmbedding', NULL, ?, 'user-test', '2026-10-01T00:00:00.000Z')`, [JSON.stringify(V1)]);
const altAudit = all(db, "SELECT * FROM audit_log WHERE id = 'audit-alt'");
const embAVorher = embOf(db, 'pA'), embBVorher = embOf(db, 'pB');

// ── S1 — eine Artikeländerung schreibt keinen Vektor mehr ───────────────────────────────────
{
  useProductStore.getState().updateProduct('pA', { plannedSalePrice: 175 } as never);
  reload();
  const e = letzter(db, 'pA')!;
  const vorher = JSON.stringify(db.exec('SELECT * FROM products WHERE id = ?', ['pA'])[0].columns
    .reduce((o, c, i) => ({ ...o, [c]: db.exec('SELECT * FROM products WHERE id = ?', ['pA'])[0].values[0][i] }), {} as Record<string, unknown>));
  ok(e.action === 'update' && !('image_embedding' in e.obj), 'S1 Preisänderung: neuer Eintrag ohne image_embedding');
  ok(Number(e.obj.planned_sale_price) === 175 && e.obj.sku === 'SKU-pA' && e.obj.image_hash === 'h-pA' && e.obj.image_description === 'A steel watch on a bracelet'
    && e.obj.images === '[]' && 'attributes' in e.obj,
  'S1 …alle übrigen Spalten weiter als ganze Zeile (Preis, SKU, Bildkennung, Beschreibung, images, Attribute)');
  console.log(`  · Changelog je Preisänderung: vorher ${vorher.length} B (ganze Zeile mit Vektor) → nachher ${e.data.length} B`);
  ok(vorher.length > 20_000 && e.data.length < 2_000, `S1 …Eintrag schrumpft von ${vorher.length} auf ${e.data.length} Bytes`);
  ok(embOf(db, 'pA') === embAVorher, 'S1 …das Embedding im Artikel bleibt unverändert');
}

// ── S2/S3 — Sync-Verbraucher ────────────────────────────────────────────────────────────────
{
  const e = letzter(db, 'pA')!;
  const change = { table_name: 'products', record_id: 'pA', action: e.action, data: e.data };
  // Echo am Primary (er spielt seine eigenen Einträge beim Pull wieder ein).
  applySyncChange(db as never, change);
  ok(embOf(db, 'pA') === embAVorher, 'S2 Echo am Primary: Vertrag geprüft, angewandt, Embedding unverändert');
  // Eine Gegenstelle, die den Artikel samt anderem Embedding hat.
  const peer = freshDb();
  artikel(peer, 'pA', V3);
  setTestDatabase(db as never);
  applySyncChange(peer as never, change);
  ok(s(peer, 'SELECT image_embedding FROM products WHERE id = ?', ['pA']) === JSON.stringify(V3)
    && n(peer, 'SELECT planned_sale_price FROM products WHERE id = ?', ['pA']) === 175,
  'S3 Gegenstelle: Preis übernommen, ihr Embedding NICHT auf NULL gesetzt und nicht gelöscht');
  // Eine Gegenstelle ohne den Artikel: neue Zeile, Embedding bleibt leer (Standard), kein Fehler.
  applySyncChange(peer as never, { ...change, record_id: 'pNeu', action: 'insert', data: JSON.stringify({ ...JSON.parse(e.data), id: 'pNeu', sku: 'SKU-pNeu' }) });
  ok(one(peer, 'SELECT image_embedding FROM products WHERE id = ?', ['pNeu']) === null && s(peer, 'SELECT sku FROM products WHERE id = ?', ['pNeu']) === 'SKU-pNeu',
    'S2 neue Zeile ohne das Feld: angelegt, Embedding leer (wird bei Bedarf lokal gerechnet)');
  setTestDatabase(db as never);
  // Reihenfolge: Bildwechsel (Embedding ungültig) → neues Embedding → beide Einträge als Echo wieder einspielen.
  db.run("UPDATE products SET images = ?, image_hash = NULL, image_description = NULL, image_embedding = NULL WHERE id = 'pB'", [JSON.stringify([KLEINES_FOTO])]);
  trackChange('products', 'pB', 'update', {});
  const e1 = letzter(db, 'pB')!;
  ok(persistProductEmbedding('pB', 'A gold watch', V3), 'S2 neues Embedding nach Bildwechsel gespeichert');
  const e2 = letzter(db, 'pB')!;
  ok(!('image_embedding' in e1.obj) && !('image_embedding' in e2.obj), 'S2 …beide Einträge ohne Vektor (auch der mit leerem Embedding)');
  for (const x of [e1, e2]) applySyncChange(db as never, { table_name: 'products', record_id: 'pB', action: x.action, data: x.data });
  ok(embOf(db, 'pB') === JSON.stringify(V3), 'S2 Echo in Reihenfolge: das neue Embedding bleibt (kein Zurücksetzen auf NULL)');
  // Der Vertrag selbst bleibt: das Feld ist weiter ERLAUBT (alte Einträge tragen es), nichts ist Pflicht.
  const pc = SCHEMA.tables?.products ?? SCHEMA.products;
  ok(pc.allowed_fields.includes('image_embedding') && pc.required_fields.length === 0, 'S2 Sync-Vertrag unverändert (image_embedding erlaubt, nichts Pflicht)');
  const altEintrag = { table_name: 'products', record_id: 'pA', action: 'update', data: JSON.stringify({ id: 'pA', image_embedding: JSON.stringify(V1) }) };
  applySyncChange(db as never, altEintrag);
  ok(embOf(db, 'pA') === embAVorher, 'S2 ein ALTER Eintrag mit Vektor wird weiter angenommen');
  // Leser alter Einträge (SKU-Hochwasser, Nummern) finden ihre Felder weiter.
  ok(JSON.parse(letzter(db, 'pA')!.data).sku === 'SKU-pA', 'S2 SKU steht weiter im Eintrag (SKU-Hochwasser-Leser)');
}

// ── S4 — Bestand und Bildsuche ──────────────────────────────────────────────────────────────
{
  reload();
  const a = useProductStore.getState().products.find((p) => p.id === 'pA');
  ok(embOf(db, 'pA') === embAVorher && a?.imageEmbedding?.length === 1536 && JSON.stringify(a.imageEmbedding) === JSON.stringify(V1),
    'S4 Embedding im Artikel byte-gleich, im Store als 1536er-Vektor geladen (Bildsuche liest ihn lokal)');
}

// ── S5 — Audit: Kurznachweis statt Vektor ───────────────────────────────────────────────────
{
  const vor = n(db, 'SELECT COUNT(*) FROM audit_log');
  trackUpdate('products', 'pA', { imageDescription: 'neu', imageEmbedding: V2 });
  const r = db.exec("SELECT new_value, changed_by, changed_at FROM audit_log WHERE entity_id = 'pA' AND field_name = 'imageEmbedding' AND id != 'audit-alt' ORDER BY rowid DESC LIMIT 1")[0].values[0];
  const d = JSON.parse(String(r[0]));
  ok(d[AUDIT_EMBEDDING_MARKER] === 'vector' && d.dims === 1536 && d.digest === identityDigest64(JSON.stringify(V2)) && r[1] === 'user-test' && !!r[2],
    `S5 Audit: Änderungsart, Benutzer, Zeit, Dimension 1536, Prüfsumme ${d.digest}`);
  console.log(`  · Audit je Embedding-Änderung: vorher ${JSON.stringify(V2).length} B → nachher ${String(r[0]).length} B`);
  ok(String(r[0]).length < 120, 'S5 …Eintrag ist klein');
  ok(n(db, 'SELECT COUNT(*) FROM audit_log') === vor + 2, 'S5 …je Feld ein Eintrag wie bisher (Beschreibung + Embedding)');
  // Vektor in einem strukturierten Wert (ganze Zeile) und als Spaltentext.
  logAudit({ module: 'Product', entityType: 'products', entityId: 'pA', action: 'UPDATE', newValue: { brand: 'Rolex', image_embedding: JSON.stringify(V2) } });
  const z = JSON.parse(s(db, "SELECT new_value FROM audit_log WHERE entity_id = 'pA' AND field_name IS NULL ORDER BY rowid DESC LIMIT 1"));
  ok(z.brand === 'Rolex' && z.image_embedding?.[AUDIT_EMBEDDING_MARKER] === 'vector' && z.image_embedding.digest === identityDigest64(JSON.stringify(V2)),
    'S5 Vektor in einer ganzen Zeile (Spaltentext) → derselbe Kurznachweis, übrige Werte unverändert');
  ok(all(db, "SELECT * FROM audit_log WHERE id = 'audit-alt'") === altAudit, 'S5 alter Audit-Eintrag mit Vektor unverändert (nichts rückwirkend)');
}

// ── S6/S7 — Backfill ────────────────────────────────────────────────────────────────────────
{
  artikel(db, 'pL1', null, JSON.stringify([KLEINES_FOTO]));   // Altartikel mit Foto, ohne Embedding
  artikel(db, 'pL2', null, JSON.stringify([KLEINES_FOTO]));
  artikel(db, 'pL3', null, JSON.stringify([KLEINES_FOTO]));
  reload();
  const aufrufe: string[] = [];
  const deps = (opts: { failFor?: string; quotaFor?: string } = {}) => ({
    stillMissing: productEmbeddingMissing, claim: claimEmbeddingCompute, release: releaseEmbeddingCompute, persist: persistProductEmbedding,
    compute: async (img: string) => {
      aufrufe.push(img);
      const nr = aufrufe.length;
      if (opts.failFor && nr === 1) throw new Error('network down');
      if (opts.quotaFor && nr === 1) throw new Error('429 quota exceeded');
      return { description: 'desc ' + nr, embedding: vektor(100 + nr) };
    },
  });
  // Die veraltete Liste des Knopfs (wie `products.filter(...)`): pA hat längst ein Embedding.
  const liste = ['pL1', 'pL2', 'pA'].map((id) => ({ id, image: KLEINES_FOTO }));
  claimEmbeddingCompute('pL2');                                  // pL2 rechnet gerade ein anderer Weg
  const z0 = zaehle(db);
  const r1 = await runEmbeddingBackfill(liste, deps());
  releaseEmbeddingCompute('pL2');
  ok(r1.saved === 1 && r1.computed === 1 && aufrufe.length === 1 && r1.skipped === 2 && r1.outcome === 'done',
    `S6 Backfill: nur pL1 gerechnet und gespeichert; pA (vorhanden) und pL2 (belegt) ohne KI-Aufruf übersprungen (${JSON.stringify(r1)})`);
  const gespeichert = embOf(db, 'pL1');
  ok(gespeichert === JSON.stringify(vektor(101)) && s(db, "SELECT image_description FROM products WHERE id = 'pL1'") === 'desc 1',
    'S6 …Embedding und Beschreibung dauerhaft im Artikel');
  reload();
  ok(useProductStore.getState().products.find((p) => p.id === 'pL1')?.imageEmbedding?.length === 1536, 'S6 …nach dem Neuladen im Store (Bildsuche)');
  const e = letzter(db, 'pL1')!;
  ok(!('image_embedding' in e.obj) && e.obj.image_description === 'desc 1', 'S6 …Changelog-Eintrag ohne Vektor');
  const au = s(db, "SELECT new_value FROM audit_log WHERE entity_id = 'pL1' AND field_name = 'imageEmbedding'");
  ok(JSON.parse(au)[AUDIT_EMBEDDING_MARKER] === 'vector' && au.length < 120, 'S6 …Audit mit Kurznachweis');
  const z1 = zaehle(db);
  ok(z1.cl === z0.cl + 1 && z1.au === z0.au + 2, `S6 …genau 1 Changelog- und 2 Audit-Einträge (${z1.cl - z0.cl}/${z1.au - z0.au})`);

  // S7 — derselbe Knopf noch einmal mit derselben (veralteten) Liste: nichts Neues.
  const r2 = await runEmbeddingBackfill(liste.filter((x) => x.id !== 'pL2'), deps());
  const z2 = zaehle(db);
  ok(r2.computed === 0 && aufrufe.length === 1 && z2.cl === z1.cl && z2.au === z1.au && embOf(db, 'pL1') === gespeichert,
    `S7 wiederholter Backfill: 0 KI-Aufrufe, 0 neue Einträge, Embedding unverändert (${JSON.stringify(r2)})`);

  // Fehler: einer scheitert, der Rest läuft; Kontingent-Fehler bricht ab; Abbruch auf Wunsch.
  aufrufe.length = 0;
  const r3 = await runEmbeddingBackfill(['pL2', 'pL3'].map((id) => ({ id, image: KLEINES_FOTO })), deps({ failFor: 'x' }));
  ok(r3.errors === 1 && r3.saved === 1 && productEmbeddingMissing('pL2') && !productEmbeddingMissing('pL3') && claimEmbeddingCompute('pL2'),
    `S6 Fehler bei einem Artikel: gezählt, nichts gespeichert, Belegung freigegeben, nächster läuft (${JSON.stringify(r3)})`);
  releaseEmbeddingCompute('pL2');
  aufrufe.length = 0;
  artikel(db, 'pL4', null, JSON.stringify([KLEINES_FOTO]));
  const r4 = await runEmbeddingBackfill(['pL2', 'pL4'].map((id) => ({ id, image: KLEINES_FOTO })), deps({ quotaFor: 'x' }));
  ok(r4.outcome === 'blocked' && aufrufe.length === 1 && productEmbeddingMissing('pL4') && claimEmbeddingCompute('pL2'),
    `S6 Kontingent-Fehler: Abbruch nach dem ersten Aufruf, keine weiteren KI-Kosten (${JSON.stringify(r4)})`);
  releaseEmbeddingCompute('pL2');
  const r5 = await runEmbeddingBackfill(['pL2', 'pL4'].map((id) => ({ id, image: KLEINES_FOTO })), { ...deps(), shouldStop: () => true });
  ok(r5.outcome === 'stopped' && r5.computed === 0, 'S6 Abbruch auf Wunsch: vor dem nächsten Artikel angehalten');
  ok(!persistProductEmbedding('pL1', 'x', vektor(9)) && embOf(db, 'pL1') === gespeichert, 'S6 vorhandenes Embedding wird nie überschrieben');
}

// ── S8 — Geschäftsdaten unverändert ─────────────────────────────────────────────────────────
ok(geschaeft() === geschaeftVorher, 'S8 Rechnungen, Zeilen, Zahlungen und Buchungen unverändert');
ok(embOf(db, 'pA') === embAVorher, 'S8 Embedding von pA nach allem unverändert');
void embBVorher;

// ── Q — Quelltext ───────────────────────────────────────────────────────────────────────────
{
  const coord = src('src/core/media/coordinator.ts');
  const svc = src('src/core/sync/sync-service.ts');
  const settings = src('src/pages/settings/SettingsPage.tsx');
  ok(/JSON\.stringify\(changelogPayload\('products', full\)\)/.test(coord) && /JSON\.stringify\(changelogPayload\(tableName, syncData\)\)/.test(svc),
    'Q beide Changelog-Schreiber (trackChange, Medien-Koordinator) laufen durch changelogPayload');
  ok((src('src/core/sync/sync-service.ts') + coord).split('INSERT INTO sync_changelog').length - 1 === 3, 'Q keine weiteren Changelog-Schreiber');
  ok(/runEmbeddingBackfill\(/.test(settings) && /persist: persistProductEmbedding/.test(settings) && !/imageEmbedding: embedding \}\)/.test(settings),
    'Q Einstellungs-Knopf: speichert über persistProductEmbedding, nicht mehr über updateProduct');
}

console.log(fails.length ? `\nFAIL — sync-slim: ${PASS} passed, ${fails.length} failed` : `\nPASS — sync-slim: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);
