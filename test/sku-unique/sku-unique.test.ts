// ═════════════════════════════════════════════════════════════════
// SKU-UNIQUE — eine SKU steht an höchstens einem Artikel: geprüft gegen die DATENBANK, an der Schreibstelle.
// Run: node test/sku-unique/sku-unique.test.ts
//
//   1 die Gleichheit (getrimmt, Groß/Klein egal, eigene Zeile ausgenommen)
//   2 BEWEIS der Lücke: die alte Prüfung (Liste im Speicher) übersieht einen Artikel, der an ihr vorbei in die
//     Datenbank kam — jetzt entscheidet die Datenbank
//   3 das Rennen „prüfen … warten … schreiben": eine zwischendurch vergebene SKU wird beim Schreiben abgewiesen
//   4 Ändern: fremde SKU abgewiesen, eigene bleibt erlaubt   5 der Koordinator prüft IN der Transaktion
//   6 Verdrahtung (Fernauftrag, Anlegemaske, Einkauf, Handy)
// Echte sql.js-Datenbank (schema.sql + echte Migrationen), echter productStore. Keine Produktivdaten.
// ═════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    if (specifier.startsWith('@/')) { const p = resolvePath(repo, 'src', specifier.slice(2)); return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true }; }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);
const mem = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })]]);
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)); }, removeItem: (k: string) => { mem.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { planProductCreate } = await import('../../src/core/products/product-create.ts');
const su = await import('../../src/core/products/sku-unique.ts');
const { StockMediaOrchestrator } = await import('../../src/core/media/orchestrator.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8').replace(/\r\n/g, '\n');
const NOW = '2026-10-19T10:00:00.000Z';
interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; export(): Uint8Array }
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(db.exec(sql, p)[0]?.values?.[0]?.[0] ?? 0);
const rowsOf = (db: Db) => (sql: string, p: unknown[] = []) => { const r = db.exec(sql, p); return r.length ? r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]]))) : []; };

function migrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  return [...dbSrc.slice(start, dbSrc.indexOf('\n  ];', start)).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = migrations();
function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const s of MIGRATIONS) { try { db.run(s); } catch { /* schon da */ } }
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  return db;
}
/** Ein Artikel, der an der Liste im Speicher VORBEI in die Datenbank kommt (wie Handy, PC2, Einkauf, Import). */
function anDerListeVorbei(db: Db, id: string, sku: string): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price,
      purchase_currency, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Roberto Coin',?,?,1,'New','[]',100,'BHD','in_stock','MARGIN',0,'[]','{}','OWN',?,?)`, [id, 'Item ' + id, sku, NOW, NOW]);
}
const CAT = { id: 'cat-w', name: 'Watch', attributes: [], conditionOptions: [], scopeOptions: [] } as never;

// ── 1 die Gleichheit ──────────────────────────────────────────────────────────
{
  const db = freshDb();
  anDerListeVorbei(db, 'p-a', 'RC-1226v1');
  const rows = rowsOf(db);
  ok(su.skuTakenBy(rows, 'RC-1226v1') === 'p-a' && su.skuTakenBy(rows, '  rc-1226V1 ') === 'p-a', 'GLEICH getrimmt, Groß/Klein egal');
  ok(su.skuTakenBy(rows, 'RC-1226v1', 'p-a') === null, 'GLEICH die eigene Zeile zählt nicht');
  ok(su.skuTakenBy(rows, '') === null && su.skuTakenBy(rows, '   ') === null && su.skuTakenBy(rows, undefined) === null, 'GLEICH leere SKU ist immer frei');
  ok(su.skuTakenBy(rows, 'RC-1226v2') === null, 'GLEICH eine andere SKU ist frei');
  let e: unknown = null;
  try { su.assertSkuFree(rows, 'rc-1226v1'); } catch (x) { e = x; }
  ok(e instanceof su.SkuTakenError && (e as { code: string }).code === 'SKU_TAKEN' && (e as Error).message === 'The SKU / reference rc-1226v1 is already in use.' && su.isSkuTaken(e),
    'GLEICH die Ablehnung: fester Code und derselbe Satz wie an der Anlegemaske');
  ok(!/UNIQUE/i.test(src('src/core/db/schema.sql').split('CREATE TABLE IF NOT EXISTS products')[1].split(');')[0]), 'BEFUND die Datenbank selbst kennt keine eindeutige SKU (products.sku ohne UNIQUE)');
}

// ── 2 BEWEIS der Lücke: die Liste im Speicher übersieht, was an ihr vorbei kam ───────────────────────────
{
  const db = freshDb();
  useProductStore.setState({ products: [] } as never);       // die Liste, wie sie VOR dem fremden Anlegen geladen war
  anDerListeVorbei(db, 'p-a', 'RC-1226v1');
  const store = useProductStore.getState();
  const alteRegel = store.products.some((p) => (p.sku || '').trim().toUpperCase() === 'RC-1226V1');
  ok(!alteRegel, 'BEWEIS alte Prüfung (nur die Liste im Speicher) sieht die vergebene SKU NICHT');
  ok(store.isSkuTaken(' rc-1226v1'), 'JETZT isSkuTaken fragt die Datenbank und sieht sie');
  const plan = planProductCreate({ categoryId: 'cat-w', brand: 'Roberto Coin', name: 'Turquoise', sku: 'RC-1226v1' } as never,
    { category: CAT, isSkuTaken: (s) => useProductStore.getState().isSkuTaken(s), allocateSku: () => 'X' });
  ok(plan.kind === 'sku_taken', `JETZT die Anlegemaske (Plan) lehnt ab (${plan.kind})`);
  let e: unknown = null;
  try { store.createProduct({ categoryId: 'cat-w', brand: 'Roberto Coin', name: 'Turquoise', sku: 'rc-1226V1 ' } as never); } catch (x) { e = x; }
  ok(e instanceof su.SkuTakenError, 'JETZT auch ohne Vorprüfung: createProduct schreibt keine vergebene SKU');
  ok(n(db, "SELECT COUNT(*) FROM products WHERE UPPER(TRIM(sku)) = 'RC-1226V1'") === 1, 'JETZT genau ein Artikel mit dieser SKU');
  const frei = store.createProduct({ categoryId: 'cat-w', brand: 'Roberto Coin', name: 'Turquoise', sku: 'RC-1226v2' } as never);
  ok(n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [frei.id]) === 1, 'eine freie SKU wird angelegt');
  const ohne = store.createProduct({ categoryId: 'cat-w', brand: 'X', name: 'ohne SKU' } as never);
  const ohne2 = store.createProduct({ categoryId: 'cat-w', brand: 'X', name: 'ohne SKU 2', sku: '' } as never);
  ok(!!ohne.id && !!ohne2.id, 'Artikel ohne SKU bleiben erlaubt (mehrere)');
}

// ── 3 das Rennen: prüfen … warten … schreiben ────────────────────────────────────────────────────
{
  const db = freshDb();
  useProductStore.setState({ products: [] } as never);
  // A prüft (frei) — dann wartet A (Bilder bereitstellen, Auftrag einreihen) …
  const planA = planProductCreate({ categoryId: 'cat-w', brand: 'R', name: 'A', sku: 'RACE-1' } as never,
    { category: CAT, isSkuTaken: (s) => useProductStore.getState().isSkuTaken(s), allocateSku: () => 'X' });
  ok(planA.kind === 'ok', 'RENNEN A prüft: frei');
  // … währenddessen legt B (PC2 / Handy) denselben Artikel an …
  anDerListeVorbei(db, 'p-b', 'race-1');
  // … dann schreibt A.
  let e: unknown = null;
  try { useProductStore.getState().createProduct((planA as { data: object }).data as never); } catch (x) { e = x; }
  ok(e instanceof su.SkuTakenError, 'RENNEN A wird beim Schreiben abgewiesen (vorher: zweiter Artikel mit derselben SKU)');
  ok(n(db, "SELECT COUNT(*) FROM products WHERE UPPER(TRIM(sku)) = 'RACE-1'") === 1, 'RENNEN genau ein Artikel');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'products' AND data LIKE '%RACE-1%'") === 0, 'RENNEN kein Abgleich-Eintrag für den abgewiesenen Artikel');
}

// ── 4 Ändern ────────────────────────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  anDerListeVorbei(db, 'p-a', 'RC-1226v1');
  anDerListeVorbei(db, 'p-b', 'RC-1226v2');
  useProductStore.getState().loadProducts();
  let e: unknown = null;
  try { useProductStore.getState().updateProduct('p-b', { sku: 'rc-1226v1' }); } catch (x) { e = x; }
  ok(e instanceof su.SkuTakenError && n(db, "SELECT COUNT(*) FROM products WHERE sku = 'RC-1226v2' AND id = 'p-b'") === 1, 'ÄNDERN fremde SKU abgewiesen, Artikel unverändert');
  useProductStore.getState().updateProduct('p-a', { sku: 'RC-1226v1', name: 'Black' } as never);
  ok(n(db, "SELECT COUNT(*) FROM products WHERE id = 'p-a' AND name = 'Black'") === 1, 'ÄNDERN die eigene SKU bleibt erlaubt');
  useProductStore.getState().updateProduct('p-b', { sku: 'RC-1226v3' });
  ok(n(db, "SELECT COUNT(*) FROM products WHERE id = 'p-b' AND sku = 'RC-1226v3'") === 1, 'ÄNDERN eine freie SKU wird gesetzt');
  ok(useProductStore.getState().isSkuTaken('RC-1226V1', 'p-a') === false && useProductStore.getState().isSkuTaken('RC-1226V1', 'p-b') === true, 'ÄNDERN Vorprüfung der Artikelseite: eigene frei, fremde vergeben');
}

// ── 5 der Koordinator prüft IN der Transaktion (Artikelseite speichern, Text und Bilder) ──────────────────────
{
  const db = freshDb();
  anDerListeVorbei(db, 'p-a', 'RC-1226v1');
  anDerListeVorbei(db, 'p-b', 'RC-1226v2');
  const lease = { db, epoch: 0, async saveDurably() { /* in-memory */ }, release() { /* nichts */ } };
  const orch = new StockMediaOrchestrator({ gateway: {} as never, leaseFactory: () => lease as never });
  const edit = (target: string) => ({ set: [['sku', target]] as Array<[string, unknown]>, baseline: ['RC-1226v2'], invalidateImageDerived: false, withSync: true,
    audit: { module: 'Product', changedBy: 'u1', newValueJson: JSON.stringify({ sku: target }) } });
  const vorher = [n(db, 'SELECT COUNT(*) FROM audit_log'), n(db, 'SELECT COUNT(*) FROM sync_changelog')];
  let e: unknown = null;
  try { await orch.applyProductTextEditDurably({ tenantId: 'tenant-1', branchId: 'branch-main', entityId: 'p-b', batchId: 'sku-1', productEdit: edit('rc-1226V1') as never }); } catch (x) { e = x; }
  ok(su.isSkuTaken(e), `KOORDINATOR vergebene SKU abgewiesen (${String((e as Error)?.message ?? e)})`);
  ok(n(db, "SELECT COUNT(*) FROM products WHERE id = 'p-b' AND sku = 'RC-1226v2'") === 1
    && n(db, 'SELECT COUNT(*) FROM audit_log') === vorher[0] && n(db, 'SELECT COUNT(*) FROM sync_changelog') === vorher[1],
    'KOORDINATOR nichts geschrieben: Artikel, Protokoll und Abgleich unverändert (Transaktion zurückgerollt)');
  const r = await orch.applyProductTextEditDurably({ tenantId: 'tenant-1', branchId: 'branch-main', entityId: 'p-b', batchId: 'sku-2', productEdit: edit('RC-1226v3') as never });
  ok(r.status === 'edited' && n(db, "SELECT COUNT(*) FROM products WHERE id = 'p-b' AND sku = 'RC-1226v3'") === 1, 'KOORDINATOR freie SKU wird geschrieben');
}

// ── 6 Verdrahtung ────────────────────────────────────────────────────────────────────────────────
{
  const store = src('src/stores/productStore.ts');
  ok(/insertProductRow: \(pid\) => \{\n\s*assertSkuFree\(query, data\.sku, null, branchId\);/.test(store)
    && /if \(e instanceof SkuTakenError\) return \{ status: 'product_save_failed', productId: id, errorCode: SKU_TAKEN \};/.test(store),
    'VERDRAHTUNG Anlegen mit Bildern (Rechner, PC2, Handy): Prüfung im selben Schritt wie das INSERT, fester Code');
  ok((store.match(/const skuNein = skuEditRefusal\(id, textDiff\.set\);/g) || []).length === 2
    && (store.match(/if \(isSkuTakenRefusal\(e\)\)/g) || []).length === 2, 'VERDRAHTUNG beide Speicherwege der Artikelseite: Vorprüfung + Abweisung aus der Transaktion als fachliches Nein');
  ok(/if \(readsFromPrimary\(\)\) return false;\n\s*try \{ return skuTakenBy\(query, t, excludeProductId, currentBranchId\(\)\) !== null; \}/.test(store), 'VERDRAHTUNG isSkuTaken: auf dem Primary entscheidet die Datenbank, PC2 fragt im Auftrag den Primary');
  ok(/assertSkuChangeFree\(rows, skuNeu\[1\], ctx\.entityId\);\n\s*\}\n\s*const parts: string\[\] = pe\.set\.map/.test(src('src/core/media/coordinator.ts')), 'VERDRAHTUNG Koordinator prüft unmittelbar vor dem UPDATE, ohne Wartepunkt');
  ok(/result\.status === 'product_save_failed' && result\.errorCode === SKU_TAKEN\) throw new CommandRejected\(SKU_TAKEN, skuTakenMessage\(sku\)\)/.test(src('src/core/bridge/product-commands.ts')), 'VERDRAHTUNG Fernauftrag (PC2) meldet SKU_TAKEN als Urteil, nicht als „Bilder unvollständig"');
  ok(/createResult\.errorCode === SKU_TAKEN/.test(src('src/pages/watches/WatchList.tsx')), 'VERDRAHTUNG Anlegemaske nennt die vergebene SKU');
  ok(/assertSkuFree\(query, data\.sku, null, branchId\);\n\s*db\.run\(\n\s*\x60INSERT INTO products/.test(store), 'VERDRAHTUNG createProduct: Prüfung und INSERT im selben synchronen Schritt');
  ok(/if \(data\.sku !== undefined\) assertSkuChangeFree\(query, data\.sku, id\);/.test(store), 'VERDRAHTUNG updateProduct: nur eine echte SKU-Änderung wird geprüft');
  ok(/assertSkuFree\(query, ln\.newProductSku, null, branchId\);/.test(src('src/stores/purchaseStore.ts')), 'VERDRAHTUNG Einkauf (alter Inline-Weg) prüft auch');
  ok(/if \(result\.errorCode === SKU_TAKEN\) \{\n\s*await deps\.bridge\.markQuarantined\(u, grant\.uploadEventId, grant\.claimToken, ERR_SKU_TAKEN, sc\);/.test(src('src/core/media/mobile-upload-drain.ts')), 'VERDRAHTUNG Handy-Upload: vergebene SKU endgültig beiseite (test/media04b2a2 beweist den Ablauf)');
}

// ── 7 bestehende Doppelte bleiben unangetastet und normal bearbeitbar ──────────────────────────────────
{
  const db = freshDb();
  anDerListeVorbei(db, 'd-1', '1226v1');
  anDerListeVorbei(db, 'd-2', '1226v1');            // schon doppelt — so, wie es in einer Datenbank vorkommen kann
  useProductStore.getState().loadProducts();
  const st = useProductStore.getState();
  st.updateProduct('d-2', { name: 'Turquoise' } as never);
  st.updateProduct('d-2', { sku: '1226v1', name: 'Turquoise 2' } as never);        // unveränderte SKU mitgeschickt
  st.updateProduct('d-2', { sku: ' 1226V1 ' } as never);                              // nur Schreibweise — dieselbe Nummer
  ok(n(db, "SELECT COUNT(*) FROM products WHERE id = 'd-2' AND name = 'Turquoise 2'") === 1, 'DOPPELT ein betroffener Artikel bleibt normal bearbeitbar (auch mit unveränderter SKU)');
  ok(n(db, "SELECT COUNT(*) FROM products WHERE UPPER(TRIM(sku)) = '1226V1'") === 2 && n(db, "SELECT COUNT(*) FROM products WHERE id = 'd-1' AND sku = '1226v1'") === 1,
    'DOPPELT nichts wird automatisch geändert, gelöscht oder zusammengeführt');
  ok(su.skuChangeTakenBy(rowsOf(db), '1226v1', 'd-1') === null, 'DOPPELT die Artikelseite meldet bei unveränderter SKU nichts');
  let e: unknown = null;
  try { st.updateProduct('d-2', { sku: 'NEU-1' } as never); st.updateProduct('d-2', { sku: '1226v1' } as never); } catch (x) { e = x; }
  ok(n(db, "SELECT COUNT(*) FROM products WHERE id = 'd-2' AND sku = 'NEU-1'") === 1 && e instanceof su.SkuTakenError, 'DOPPELT wer die Nummer einmal frei macht, kann nicht zurück auf eine vergebene');
  const lease = { db, epoch: 0, async saveDurably() { /* in-memory */ }, release() { /* nichts */ } };
  const orch = new StockMediaOrchestrator({ gateway: {} as never, leaseFactory: () => lease as never });
  anDerListeVorbei(db, 'd-3', '1226v1');
  const r = await orch.applyProductTextEditDurably({ tenantId: 'tenant-1', branchId: 'branch-main', entityId: 'd-3', batchId: 'dup-1',
    productEdit: { set: [['sku', '1226V1']], baseline: ['1226v1'], invalidateImageDerived: false, withSync: true, audit: { module: 'Product', changedBy: 'u1', newValueJson: '{}' } } as never });
  ok(r.status === 'edited', 'DOPPELT der Koordinator lässt eine reine Schreibweise-Änderung derselben Nummer durch');
}

// ── 8 Filialbezug wie bisher (isSkuTaken prüfte die Liste der Filiale) ─────────────────────────────────
{
  const db = freshDb();
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zweite',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price,
      purchase_currency, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('z-1','branch-2','cat-w','B','N','FIL-1',1,'New','[]',1,'BHD','in_stock','MARGIN',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  const rows = rowsOf(db);
  ok(su.skuTakenBy(rows, 'fil-1', null, 'branch-main') === null && su.skuTakenBy(rows, 'fil-1', null, 'branch-2') === 'z-1', 'FILIALE vergeben ist eine SKU in ihrer Filiale (wie bisher die Liste je Filiale)');
  ok(su.skuTakenBy(rows, 'fil-1') === 'z-1', 'FILIALE ohne bekannte Filiale wird strenger über alle geprüft');
  const p = useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'B', name: 'N', sku: 'FIL-1' } as never);
  ok(n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [p.id]) === 1, 'FILIALE dieselbe Nummer in einer anderen Filiale bleibt erlaubt (unveränderter Vertrag)');
}

console.log(`\nsku-unique: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
