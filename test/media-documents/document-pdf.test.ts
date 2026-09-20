// ════════════════════════════════════════════════════════════════════════════
// MEDIA-DOCUMENTS — die hochgeladene PDF eines Belegs im Medienkern.
// Run: node test/media-documents/document-pdf.test.ts
//
//   §1 Hochladen: EIN Beleg, EINE Datei, nirgends Bytes in einer Zeile
//   §2 Byte-genau: Hash und Groesse sind die der Datei
//   §3 Oeffnen: Referenzen statt Bytes, Objekt-URL statt Daten-URL
//   §4 Ersetzen  §5 Entfernen — stilllegen, nie ad hoc loeschen
//   §6 Wiederholung ohne zweiten Beleg  §7 Rollback ohne halbe Verknuepfung
//   §8 fremde Filiale  §9 Rolle/Klasse  §10 kein PDF  §11 25 MiB
//   §12 Sicherung  §13 Datenort  §14 Wiederherstellung ohne Produktweg  §15 Aufraeumung
//   §16 kein JSON/Base64  §17 PC2  §18 die Bildwege unberuehrt
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
const office = await import('../../src/core/bridge/office-commands.ts');
const docMedia = await import('../../src/core/office/document-media.ts');
const docStore = await import('../../src/stores/documentStore.ts');

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
const identity = (x: string, op: string, ueber: Record<string, unknown> = {}) =>
  ({ commandId: ID(x), ...ACTOR, op, payloadHash: 'h' + x, ...ueber });
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
async function fern(fn: () => Promise<{ kind: string; code?: string; value?: unknown }>): Promise<{ kind: string; code: string; value: Record<string, unknown> }> {
  try {
    const o = await fn();
    return { kind: o.kind, code: String(o.code ?? ''), value: (o.value ?? {}) as Record<string, unknown> };
  } catch (e) {
    return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? (e as Error).message), value: {} };
  }
}

const PDF = (fuellung: number, marke = 0x41): Uint8Array => {
  const b = new Uint8Array(5 + fuellung);
  b.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // %PDF-
  b.fill(marke, 5);
  return b;
};
const DOK = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  fileName: 'rechnung.pdf', docClass: 'invoice', linkedEntityType: null, linkedEntityId: null, ...extra,
});
const dokRows = (db: Db): Array<Record<string, unknown>> =>
  rows(db, 'SELECT id, branch_id, file_name, file_path, file_type, file_size, doc_class FROM documents ORDER BY created_at, id');
const linksOfDoc = (db: Db, id: string): string[] =>
  (db.exec("SELECT media_id FROM media_links WHERE entity_type = 'document' AND entity_id = ? AND media_role = 'file' AND deleted_at IS NULL", [id])[0]?.values ?? [])
    .map((v) => String(v[0]));
/** Die Datei ablegen, wie die Maske es tut — und danach den Auftrag stellen. */
async function hochladen(db: Db, nr: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  const abgelegt = await docMedia.sendDocumentFile(bytes, { remote: false, tenantScope: 'tenant-1' });
  void db;
  return { abgelegt, body: DOK({ ...extra, media: abgelegt }) };
}

// ── §1 Hochladen: EIN Beleg, EINE Datei, nirgends Bytes in einer Zeile ──────────────────────
{
  const db = freshDb();
  const bytes = PDF(2000, 0x31);
  const { abgelegt, body } = await hochladen(db, '101', bytes);
  const out = await fern(() => office.runDocumentUpload(deps(db), identity('101', 'documents.upload'), body));
  ok(out.kind === 'ok', `§1 der Beleg entsteht (${out.kind} ${out.code})`);
  const liste = dokRows(db);
  ok(liste.length === 1, `§1 GENAU ein Beleg (${liste.length})`);
  const id = String(liste[0]?.id ?? '');
  ok(String(liste[0]?.file_type) === 'application/pdf' && Number(liste[0]?.file_size) === bytes.length,
    `§1 Typ und Größe stehen am Beleg (${String(liste[0]?.file_type)}/${String(liste[0]?.file_size)})`);
  ok(String(liste[0]?.file_path) === '', `§1 …und die alte Inhaltsspalte ist LEER ("${String(liste[0]?.file_path)}")`);
  ok(linksOfDoc(db, id).length === 1, '§1 die Datei hängt als Verknüpfung am Beleg');
  ok(n(db, "SELECT COUNT(*) FROM media_objects WHERE master_kind = 'original' AND security_class = 'internal'") === 1,
    '§1 …als ORIGINAL der Klasse `internal` — nicht normalisiert, nicht `sensitive`');
  ok(n(db, "SELECT COUNT(*) FROM media_variants") === 0, '§1 kein Miniaturbild: ein Beleg ist kein Warenbild');

  // §16 — nirgends JSON/Base64.
  ok(n(db, "SELECT COUNT(*) FROM documents WHERE file_path LIKE 'data:%'") === 0, '§16 keine Daten-URL in der Belegzeile');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'documents' AND data LIKE '%data:%'") === 0,
    '§16 …und auch der Abgleich trägt keine Bytes');
  const gen = rows(db, 'SELECT storage_key, stored_blob_hash, byte_size, content_kind, mime_type, extension FROM media_blob_generations')[0];
  ok(String(gen?.stored_blob_hash) === abgelegt.hash && Number(gen?.byte_size) === bytes.length,
    `§2 die Fassung nennt GENAU den Inhalt-Hash und die Größe der Datei (${String(gen?.byte_size)})`);
  ok(String(gen?.extension) === 'pdf' && String(gen?.content_kind) === 'pdf' && String(gen?.mime_type) === 'application/pdf',
    '§2 …und ihren Typ, so wie der Speicher ihn führt');
  ok(String(gen?.storage_key) === `tenant-1/${abgelegt.hash.slice(0, 2)}/${abgelegt.hash}.pdf`,
    `§13 der Ablageschlüssel ist RELATIV zum Datenort — ein Umzug ändert ihn nicht (${String(gen?.storage_key)})`);

  // §3 Öffnen: die Mappe nennt Referenzen, nicht Bytes.
  const mappe = docStore.loadDocumentsFor({ tenantId: 'tenant-1', branchId: 'branch-main' } as never);
  const d0 = mappe.documents.find((d) => d.id === id);
  ok(d0?.file?.mediaId === linksOfDoc(db, id)[0] && d0?.file?.hash === abgelegt.hash && d0?.file?.extension === 'pdf',
    '§3 die Mappe nennt die Datei als Referenz (Schlüssel, Hash, Größe) — keine Bytes');
  ok(d0?.filePath === '', '§3 …und die alte Inhaltsspalte bleibt leer');
  const inhalt = docStore.documentContentFor({ tenantId: 'tenant-1', branchId: 'branch-main' } as never, id);
  ok(inhalt !== null && inhalt.content === '',
    '§3 der Geschäftslesevorgang gibt KEINE Bytes heraus — geöffnet wird über den geprüften Medienweg');
}

// ── §6 Wiederholung: derselbe Auftrag, kein zweiter Beleg ───────────────────────────────────
{
  const db = freshDb();
  const { body } = await hochladen(db, '201', PDF(300, 0x32));
  const a = await fern(() => office.runDocumentUpload(deps(db), identity('201', 'documents.upload'), body));
  const b = await fern(() => office.runDocumentUpload(deps(db), identity('201', 'documents.upload'), body));
  ok(a.kind === 'ok' && b.kind === 'ok', `§6 beide Versuche werden beantwortet (${a.kind}/${b.kind})`);
  ok(JSON.stringify(a.value) === JSON.stringify(b.value), '§6 …mit DERSELBEN Antwort: das eingefrorene Ergebnis');
  ok(dokRows(db).length === 1, `§6 und es gibt genau einen Beleg (${dokRows(db).length})`);
  ok(n(db, 'SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL') === 1, '§6 …und eine Verknüpfung');
  ok(n(db, 'SELECT COUNT(*) FROM media_blob_generations') === 1, '§6 …und eine Datei');

  // Dieselbe Datei ein zweites Mal ablegen legt nichts Neues an — der Speicher ist inhaltsadressiert.
  const nochmal = await docMedia.sendDocumentFile(PDF(300, 0x32), { remote: false, tenantScope: 'tenant-1' });
  ok(nochmal.hash === (await docMedia.sendDocumentFile(PDF(300, 0x32), { remote: false, tenantScope: 'tenant-1' })).hash,
    '§6 dieselben Bytes, derselbe Inhalt-Hash');
  const zweiter = await fern(() => office.runDocumentUpload(deps(db), identity('202', 'documents.upload'), DOK({ fileName: 'kopie.pdf', media: nochmal })));
  ok(zweiter.kind === 'ok' && dokRows(db).length === 2 && n(db, 'SELECT COUNT(*) FROM media_blob_generations') === 1,
    '§6 zwei Belege dürfen DIESELBE Datei nennen — eine Datei, zwei Verknüpfungen, kein zweites Objekt');
  ok(n(db, 'SELECT COUNT(*) FROM media_objects') === 1, '§6 …und genau ein Medienobjekt');
}

// ── §7 Rollback: scheitert die Geschäftsfolge, bleibt nichts halb stehen ────────────────────
{
  const db = freshDb();
  const { body } = await hochladen(db, '301', PDF(300, 0x33));
  // Eine Verknüpfung, die es nicht gibt, lässt die Klammer scheitern.
  const kaputt = await fern(() => office.runDocumentUpload(deps(db), identity('301', 'documents.upload'),
    { ...body, linkedEntityType: 'customer', linkedEntityId: 'gibt-es-nicht' }));
  ok(kaputt.kind !== 'ok', `§7 eine unbekannte Verknüpfung lässt den Beleg scheitern (${kaputt.kind} ${kaputt.code})`);
  ok(dokRows(db).length === 0, '§7 …es bleibt KEIN halber Beleg stehen');
  ok(n(db, 'SELECT COUNT(*) FROM media_links') === 0, '§7 …und KEINE halbe Verknüpfung');
  ok(n(db, 'SELECT COUNT(*) FROM media_objects') === 1 && n(db, 'SELECT COUNT(*) FROM media_blob_generations') === 1,
    '§14 die abgelegte, unverknüpfte Datei bleibt liegen — genau so sieht der Aufräum-Vertrag sie vor');
  ok(n(db, "SELECT COUNT(*) FROM media_links WHERE entity_type = 'product'") === 0,
    '§14 …und sie wird nirgends zu einem Artikelbild: kein Produkt-Embedding auf diesem Weg');
}

// ── §4/§5 Ersetzen und Entfernen ────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const { body } = await hochladen(db, '401', PDF(400, 0x34));
  await fern(() => office.runDocumentUpload(deps(db), identity('401', 'documents.upload'), body));
  const id = String(dokRows(db)[0]?.id ?? '');
  const erste = linksOfDoc(db, id)[0];

  // §4 Ersetzen: dieselbe Rolle, neue Datei — die alte Beziehung wird STILLGELEGT, nicht gelöscht.
  const neue = await docMedia.sendDocumentFile(PDF(400, 0x35), { remote: false, tenantScope: 'tenant-1' });
  const neuId = docMedia.registerDocumentOriginal(
    await docMedia.statDocumentOriginal('tenant-1', neue.hash), { tenantId: 'tenant-1', branchId: 'branch-main' });
  docMedia.applyDocumentFile(id, [neuId], { bumpOwner: false });
  ok(linksOfDoc(db, id).length === 1 && linksOfDoc(db, id)[0] === neuId,
    '§4 nach dem Ersetzen hängt GENAU die neue Datei am Beleg');
  ok(n(db, "SELECT COUNT(*) FROM media_links WHERE entity_type = 'document' AND media_id = ? AND deleted_at IS NOT NULL", [erste]) === 1,
    '§4 …die alte Beziehung ist stillgelegt, nicht gelöscht');
  ok(n(db, 'SELECT COUNT(*) FROM media_blob_generations') === 2 && n(db, 'SELECT COUNT(*) FROM media_objects') === 2,
    '§4 …und die alte Datei bleibt liegen: nichts wird ad hoc gelöscht');

  // §5 Entfernen: die Verknüpfung wird still, die Datei entscheidet später die Aufräumung.
  docMedia.applyDocumentFile(id, [], { bumpOwner: false });
  ok(linksOfDoc(db, id).length === 0, '§5 nach dem Entfernen hängt keine Datei mehr am Beleg');
  ok(n(db, 'SELECT COUNT(*) FROM media_blob_generations') === 2,
    '§5 …und es wurde weiterhin keine Datei gelöscht — das entscheidet die Aufräumung, später');
  ok(n(db, "SELECT COUNT(*) FROM media_links WHERE entity_type = 'document' AND deleted_at IS NOT NULL") === 2,
    '§5 beide Beziehungen stehen als stillgelegt in der Geschichte');
}

// ── §10/§11 Was abgewiesen wird ─────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const nichtPdf = new TextEncoder().encode('This is not a PDF at all, it only claims to be one.');
  const w = async (bytes: Uint8Array): Promise<string> => {
    try { await docMedia.sendDocumentFile(bytes, { remote: false, tenantScope: 'tenant-1' }); return ''; }
    catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); }
  };
  ok(await w(nichtPdf) === 'DOCUMENT_NOT_A_PDF', '§10 eine Datei ohne `%PDF-` wird abgewiesen — am Inhalt, nicht am Namen');
  ok(await w(new Uint8Array(0)) === 'DOCUMENT_EMPTY', '§10 …eine leere erst recht');
  const zuGross = PDF(docMedia.DOCUMENT_MAX_BYTES, 0x36);
  ok(zuGross.length > docMedia.DOCUMENT_MAX_BYTES && await w(zuGross) === 'DOCUMENT_TOO_LARGE',
    `§11 über ${docMedia.DOCUMENT_MAX_BYTES} Bytes: abgewiesen, BEVOR irgendetwas gesendet wird`);
  ok(docMedia.DOCUMENT_MAX_BYTES === 25 * 1024 * 1024, '§11 die Grenze ist und bleibt 25 MiB');
  const rust = src('src-tauri/src/media/storage.rs');
  ok(/pub const DOCUMENT_MAX_BYTES: u64 = 25 \* 1024 \* 1024;/.test(rust),
    '§11 …und Rust kennt dieselbe Zahl — der Client prüft sich nur selbst');

  // Eine PDF als Daten-URL geht nicht mehr durch die alte Tür.
  const alt = await fern(() => office.runDocumentUpload(deps(db), identity('501', 'documents.upload'),
    DOK({ content: `data:application/pdf;base64,${Buffer.from(PDF(100, 0x37)).toString('base64')}` })));
  ok(alt.kind !== 'ok' && alt.code === 'DOCUMENT_CONTENT_INVALID',
    `§11 eine PDF als Daten-URL wird abgewiesen: sie gehört in den Medienspeicher (${alt.code})`);
  ok(dokRows(db).length === 0, '§11 …und es entsteht nichts');
  // Beides zusammen wäre zwei Wahrheiten über denselben Beleg.
  const beides = await fern(() => office.runDocumentUpload(deps(db), identity('502', 'documents.upload'),
    DOK({ content: 'data:text/plain;base64,QUJD', media: { hash: 'a'.repeat(64), byteSize: 3 } })));
  ok(beides.kind !== 'ok', `§10 Bytes UND Kennung zugleich: abgewiesen (${beides.code})`);
  // Ein Hash, den es nicht gibt.
  const fehlt = await fern(() => office.runDocumentUpload(deps(db), identity('503', 'documents.upload'),
    DOK({ media: { hash: 'b'.repeat(64), byteSize: 10 } })));
  ok(fehlt.kind !== 'ok' && dokRows(db).length === 0,
    `§10 eine Datei, die nicht im Speicher liegt, legt nichts an (${fehlt.code})`);
}

// ── §8/§9 Wer nichts sehen darf, sieht nichts ──────────────────────────────────────────────
{
  const db = freshDb();
  const { body } = await hochladen(db, '601', PDF(500, 0x38));
  await fern(() => office.runDocumentUpload(deps(db), identity('601', 'documents.upload'), body));
  const id = String(dokRows(db)[0]?.id ?? '');
  ok((docMedia.documentFileRefsFor([id], 'branch-other').get(id) ?? []).length === 0,
    '§8 eine andere Filiale bekommt die Datei dieses Belegs nicht');
  ok((docMedia.documentFileRefsFor([id], 'branch-main').get(id) ?? []).length === 1, '§8 …seine eigene schon');
  const fremd = await fern(() => office.runDocumentUpload(deps(db), identity('602', 'documents.upload', { branchId: 'branch-other' }), body));
  ok(fremd.kind !== 'ok', `§8 ein Auftrag aus einer fremden Filiale legt hier nichts an (${fremd.code})`);

  const grant = src('src-tauri/src/sync/product_query.rs');
  ok(grant.includes("l.entity_type = 'document' AND l.media_role = 'file'")
    && grant.includes('dc.id = l.entity_id AND dc.branch_id = l.branch_id'),
  '§7/§9 das Tor der LAN-Route hat für den Beleg eine EIGENE Regel (Tabelle, Rolle, Filiale)');
  ok(/security_class IN \('public', 'internal'\)\s*\n\s*AND l\.entity_type = 'document'/.test(grant),
    '§9 …und zwar nur für `public`/`internal` — nie unter der Regel eines Ausweises');
  ok(grant.includes('WHERE g.tenant_id = ?1 AND g.storage_key = ?2') && grant.includes("l.scope_kind = 'branch' AND l.branch_id = ?3"),
    '§7 der Ablageschlüssel allein reicht nicht: Mandant und Filiale entscheiden mit');
  const route = src('src-tauri/src/sync/product_query.rs');
  ok(/md\.len\(\) != grant\.byte_size/.test(route) && /sha256_hex\(&bytes\) != grant\.hash/.test(route),
    '§7 …und herausgegeben wird nur, was in Größe UND Inhalt genau die genannte Fassung ist');
}

// ── §17 PC2: derselbe Weg, dasselbe Ergebnis ───────────────────────────────────────────────
{
  const db = freshDb();
  const bytes = PDF(700, 0x39);
  // PC2 legt die Bytes über den Rohweg ab; hier steht der Primary dahinter.
  const abgelegt = await docMedia.sendDocumentFile(bytes, {
    remote: true,
    tenantScope: 'egal',
    client: { serverUrl: 'http://primary:3001', token: 'tok' },
    fetchFn: (async (url: string, init: RequestInit) => {
      ok(String(url).endsWith('/api/documents/raw'), '§17 PC2 sendet an den Rohweg, nicht an die Zwischenablage');
      ok(init.body instanceof Uint8Array, '§17 …und die Bytes sind der RUMPF, kein JSON und kein Base64');
      const p = await docMedia.sendDocumentFile(init.body as Uint8Array, { remote: false, tenantScope: 'tenant-1' });
      return { ok: true, status: 201, json: async () => ({ hash: p.hash, byteSize: p.byteSize }) };
    }) as unknown as typeof fetch,
  });
  const out = await fern(() => office.runDocumentUpload(deps(db), identity('701', 'documents.upload'), DOK({ media: abgelegt })));
  ok(out.kind === 'ok' && dokRows(db).length === 1, `§17 der Fernauftrag legt denselben Beleg an (${out.kind} ${out.code})`);
  const id = String(dokRows(db)[0]?.id ?? '');
  ok(linksOfDoc(db, id).length === 1 && String(dokRows(db)[0]?.file_path) === '',
    '§17 …mit Verknüpfung und ohne Bytes in der Zeile — wie am Primary');
  ok(String(dokRows(db)[0]?.file_size) === String(bytes.length), '§17 …und mit derselben Größe');
}

// ── §12/§15 Sicherung, Wiederherstellung, Aufräumung ───────────────────────────────────────
{
  const db = freshDb();
  const { body, abgelegt } = await hochladen(db, '801', PDF(900, 0x3a));
  await fern(() => office.runDocumentUpload(deps(db), identity('801', 'documents.upload'), body));
  const erreich = src('src-tauri/src/media/reachability.rs');
  ok(/REQUIRED_MASTER_SQL[\s\S]*FROM media_links l/.test(erreich) && !/extension='jpg'|ext = 'jpg'/.test(erreich),
    '§12/§15 der Pflichtbestand fragt über die VERKNÜPFUNG — ohne Rücksicht auf die Dateiart');
  const notwendig = rows(db,
    `SELECT g.stored_blob_hash, g.byte_size, g.extension FROM media_links l
       JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id AND o.deleted_at IS NULL
       JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id AND b.blob_status = 'present'
       JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
                                    AND g.generation_no = b.current_generation_no AND g.gen_status = 'available'
      WHERE l.deleted_at IS NULL`);
  ok(notwendig.length === 1 && String(notwendig[0]?.stored_blob_hash) === abgelegt.hash && String(notwendig[0]?.extension) === 'pdf',
    '§15 die PDF des Belegs steht im Pflichtbestand — die Aufräumung darf sie nicht anfassen');
  ok(Number(notwendig[0]?.byte_size) === 905,
    `§12 …mit ihrer genauen Größe, die eine Sicherung byte-genau wiederherstellen kann (${String(notwendig[0]?.byte_size)})`);
}

// ── §18 Die Bildwege bleiben, wie sie waren ────────────────────────────────────────────────
{
  const rust = src('src-tauri/src/media/storage.rs');
  ok(/StoredKind \{ ext: "jpg", mime: "image\/jpeg", content_kind: "raster_image", original: false, max_bytes: RENDITION_MAX_BYTES \}/.test(rust)
    && /StoredKind \{ ext: "pdf", mime: "application\/pdf", content_kind: "pdf", original: true, max_bytes: DOCUMENT_MAX_BYTES \}/.test(rust),
  '§18 der Speichervertrag ist unverändert: JPEG ist Rendition, PDF ist Original');
  ok(/pub const RENDITION_MAX_BYTES: u64 = 100_000;/.test(rust), '§18 …und die 100 000 Bytes eines Warenbildes stehen unangetastet');
  const gw = codeOf(src('src/core/media/gateway.ts'));
  ok(/ORIGINAL_EXTENSIONS = \['pdf'\]/.test(gw), '§18 es gibt genau EINEN Originaltyp — keine neue Bildfunktion');
  const rp = codeOf(src('src/core/media/record-photo-media.ts'));
  ok(/ingestObject/.test(rp) && !/publishOriginal/.test(rp), '§18 der Fotoweg nutzt weiter den Bild-Ingest, nie den Originalweg');
  const dm = codeOf(src('src/core/office/document-media.ts'));
  ok(!/normalize|thumbnail|publish_atomically|stock_image/.test(dm),
    '§18 der Dokumentweg normalisiert nichts, macht keine Miniatur und wird nie ein Artikelbild');
  ok(/master_kind/.test(dm) && /'original'/.test(dm), '§18 …er schreibt ausdrücklich ein ORIGINAL');

  // §3 Anzeigen: ein Original kommt über den Rohweg zurück, nicht über den JSON-Weg.
  const vv = codeOf(src('src/core/media/verified-view.ts'));
  ok(/ORIGINAL_EXTENSIONS\.includes/.test(vv) && /readVerifiedRaw/.test(vv),
    '§3 zum Öffnen kommt ein Original über den Rohweg — der JSON-Weg weist es ab');
  const dl = codeOf(src('src/pages/documents/DocumentList.tsx'));
  ok(/loadVerifiedMedia/.test(dl) && /revokeVerifiedMedia/.test(dl) && /<iframe/.test(dl),
    '§3 die Maske zeigt die PDF aus einer Objekt-URL und gibt sie wieder frei');
  ok(!/filePath.*data:|createObjectURL\(new Blob\(\[.*base64/.test(dl), '§3 …und legt nirgends eine dauerhafte Daten-URL an');

  // §3 Der Registry-Umfang bleibt: kein neuer Fernbefehl, dieselbe Buchung.
  ok(registry.ALLOWED_MUTATIONS.length === 104 && registry.ALLOWED_MUTATIONS.includes('documents.upload')
    && !registry.ALLOWED_MUTATIONS.includes('documents.replace'),
  `§18 kein neuer Fernbefehl — der Beleg nutzt die vorhandene Buchung (${registry.ALLOWED_MUTATIONS.length})`);
  const rl = src('src-tauri/src/bridge.rs');
  ok((/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rl)?.[1].match(/OP_[A-Z_]+/g) ?? []).length === 177,
    '§18 …und die Registry steht unverändert bei 177');

  // §3 Der Rohweg von PC2 trägt seine EIGENE Grenze — vor dem Handler.
  const routes = src('src-tauri/src/sync/routes.rs');
  ok(/"\/documents\/raw",\s*post\(document_raw_put\)\.layer\(DefaultBodyLimit::max\(/.test(routes)
    && /crate::media::storage::DOCUMENT_MAX_BYTES as usize/.test(routes),
  '§3 der Rohweg weist einen zu großen Rumpf ab, BEVOR der Handler ihn sieht');
  ok(!/data_base64/.test(routes.slice(routes.indexOf('async fn document_raw_put'), routes.indexOf('async fn staging_media_put'))),
    '§3 …und nimmt niemals Base64 entgegen');
}

// ── §19 Der Rohweg: wer darf überhaupt ablegen, und wessen Mandant gilt ─────────────────────
{
  // Die Datei kann CRLF tragen; für eine Abschnittsgrenze zählt die Zeile, nicht ihr Ende.
  const routes = src('src-tauri/src/sync/routes.rs').replace(/\r\n/g, '\n');
  const start = routes.indexOf('async fn document_raw_put');
  const rumpf = routes.slice(start, routes.indexOf('\n}\n', start));
  ok(/\.route_layer\(middleware::from_fn_with_state\(state, auth::auth_middleware\)\)/.test(routes)
    && routes.indexOf('"/documents/raw"') < routes.indexOf('.route_layer(middleware::from_fn_with_state(state, auth::auth_middleware))'),
  '§19 der Rohweg liegt HINTER der Anmeldung — ein anonymer Rechner im Netz legt gar nichts ab');
  ok(/Extension\(claims\): Extension<Claims>/.test(rumpf) && /claims\.role\.trim\(\)\.is_empty\(\)/.test(rumpf),
    '§19 …und eine Anmeldung ohne Rolle ist keine');
  ok(/state\.primary_state\.may_write_sync\(\)/.test(rumpf), '§19 nur ein schreibfähiger Primary nimmt etwas an');
  ok(/&claims\.tenant_id/.test(rumpf) && !/req\.|body\.tenant|serde_json::from/.test(rumpf),
    '§19 der Mandant kommt AUSSCHLIESSLICH aus dem geprüften Ausweis — der Rumpf hat kein Feld dafür');
  ok(/is_pdf_content_type\(&headers\)/.test(rumpf) && /UNSUPPORTED_MEDIA_TYPE/.test(rumpf),
    '§19 ein anderer angekündigter Typ wird in der Tür abgewiesen');
  ok(/publish_original\(/.test(rumpf) && /"pdf",/.test(rumpf),
    '§19 …und über die BYTES entscheidet der Speichervertrag, nicht die Ankündigung');
  ok(!/INSERT INTO|media_links|media_objects/.test(rumpf),
    '§3 der Rohweg schreibt KEINE Geschäftszeile und KEINE Verknüpfung — er legt nur ab');

  // §2 Mandantenbindung: der Speicher ist nach Mandant getrennt, schon im Pfad.
  const storage = src('src-tauri/src/media/storage.rs');
  ok(/let rel = format!\("\{tenant_scope\}\/\{\}\/\{hash\}\.\{ext\}"/.test(storage),
    '§2 der Ablagepfad TRÄGT den Mandanten: ein fremder Hash liegt schlicht woanders');
  const dm = codeOf(src('src/core/office/document-media.ts'));
  ok(/statDocumentOriginal\(\s*\n?\s*tenantScope: string/.test(dm) || /export async function statDocumentOriginal\(\s*\n?\s*tenantScope: string/.test(dm),
    '§2 die Prüfung fragt IMMER mit einem Mandanten');
  ok(/stat\(scope\.tenantId, named\.hash\)/.test(dm),
    '§2 …und zwar mit dem des autorisierten Kontexts, nie mit einem aus dem Rumpf');
  const oc = codeOf(src('src/core/bridge/office-commands.ts'));
  ok(/\{ tenantId: identity\.tenantId, branchId: identity\.branchId \}/.test(oc),
    '§2 fern ist dieser Kontext der geprüfte Absender');
  const ds = codeOf(src('src/stores/documentStore.ts'));
  ok(/resolveDocumentMedia\(input, documentMediaScope\(\)\)/.test(ds),
    '§2 am Primary die eigene Sitzung — beide Male nicht der Rumpf');
  ok(!/media\.tenantId|body\.tenantId|raw\.tenantId/.test(dm + oc + ds),
    '§2 nirgends ein Mandant aus dem Rumpf');
}

// ── §20 Ohne Auftrag: kein Beleg, nichts lesbar ─────────────────────────────────────────────
{
  const db = freshDb();
  const abgelegt = await docMedia.sendDocumentFile(PDF(600, 0x3b), { remote: false, tenantScope: 'tenant-1' });
  ok(dokRows(db).length === 0, '§20 ein Rohweg-Upload allein legt KEINEN Beleg an');
  ok(n(db, 'SELECT COUNT(*) FROM media_links') === 0 && n(db, 'SELECT COUNT(*) FROM media_objects') === 0,
    '§20 …und auch keine Verknüpfung und kein Medienobjekt: die Zeilen entstehen erst im Auftrag');
  // Erst der Auftrag macht daraus ein Objekt; ohne ihn bleibt es beim reinen Dateibestand.
  const mediaId = docMedia.registerDocumentOriginal(
    await docMedia.statDocumentOriginal('tenant-1', abgelegt.hash), { tenantId: 'tenant-1', branchId: 'branch-main' });
  ok(n(db, 'SELECT COUNT(*) FROM media_links') === 0,
    '§20 auch ein angemeldetes Objekt ist ohne Auftrag UNVERKNÜPFT');
  ok((docMedia.documentFileRefsFor(['egal']).get('egal') ?? []).length === 0,
    '§20 …und über die Besitzerauskunft erreicht es niemand');
  const grant = src('src-tauri/src/sync/product_query.rs');
  ok(/JOIN media_links l ON l\.tenant_id = o\.tenant_id AND l\.media_id = o\.media_id AND l\.deleted_at IS NULL/.test(grant),
    '§20 das Tor der LAN-Route verlangt eine AKTIVE Verknüpfung — ohne sie gibt es nichts, auch mit Schlüssel');
  void mediaId;
}

// ── §21 Die Bilddokumente bleiben unberührt ────────────────────────────────────────────────
{
  const db = freshDb();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
  const url = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  const out = await fern(() => office.runDocumentUpload(deps(db), identity('901', 'documents.upload'), DOK({ fileName: 'scan.png', content: url })));
  ok(out.kind === 'ok', `§21 ein Bilddokument geht weiter seinen bisherigen Weg (${out.kind} ${out.code})`);
  const zeile = dokRows(db)[0];
  ok(String(zeile?.file_type) === 'image/png' && String(zeile?.file_path) === url,
    '§21 …seine Bytes stehen unverändert in der Zeile — Zeichen für Zeichen dieselbe Daten-URL');
  ok(n(db, 'SELECT COUNT(*) FROM media_links') === 0,
    '§21 …und es entsteht KEINE Medienverknüpfung: dieses Bündel ist PDF');
  const dh = codeOf(src('src/core/office/document-house.ts'));
  ok(/if \(!String\(d\.file_type \?\? ''\)\.startsWith\('image\/'\) \|\| !content\.startsWith\('data:image\/'\)\)/.test(dh),
    '§21 die Texterkennung prüft weiterhin denselben Inhalt in derselben Spalte');
  const dl = codeOf(src('src/pages/documents/DocumentList.tsx'));
  ok(/const istPdf = isPdfBytes\(rohbytes\);/.test(dl) && /istPdf \? '' : await readFileAsDataUrl\(uploadFile\)/.test(dl),
    '§21 die Maske entscheidet an den BYTES: eine PDF nimmt nie den Bildweg, ein Bild nie den Originalweg');
  const st = src('src-tauri/src/media/storage.rs');
  ok(/"jpg" => sniff_kind\(bytes\) == Kind::Jpeg/.test(st) && /"pdf" => sniff_kind\(bytes\) == Kind::Pdf/.test(st),
    '§21 und der Speicher selbst liesse eine PDF nie als Rendition durch');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — media documents (pdf): ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('MEDIA_DOCUMENTS_PDF_PROVED');
