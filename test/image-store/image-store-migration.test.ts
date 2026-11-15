// BILDSPEICHER — Größenklassen + Migration bestehender Bilder gegen das ECHTE Medienschema (sql.js, alle
// Trigger aktiv) und den ECHTEN Coordinator. Rust wird durch einen deterministischen Ersatz vertreten
// (die Rust-Seite hat eigene Tests: recompress_tests.rs).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { MediaDbCoordinator, type FinalizeInput } from '../../src/core/media/coordinator.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import { canonicalRequestHash, CUTOVER_NORM_PARAMS } from '../../src/core/media/product-media-cutover.ts';
import { sizeProfileFor, SIZE_PROFILE_NORM_PARAMS, SIZE_PROFILE_LIMITS } from '../../src/core/media/size-profile.ts';
import {
  runImageStoreMigration, planImageStoreMigration, migrationInvariantDigest, assertMigrationPreconditions,
  type MigrationDb, type RecompressArgs, type RecompressOutcome, type MigrationJournalEntry,
} from '../../src/core/media/image-store-migration.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes, MediaCommandGateway, PrepareInput, PrepareResult,
  ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
const pad64 = (s: string) => (s.toLowerCase().replace(/[^0-9a-f]/g, '0') + '0'.repeat(64)).slice(0, 64);
const key = (t: string, h: string) => `${t}/${h.slice(0, 2)}/${h}.jpg`;
const desc = (hash: string, size: number) => ({ hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 1200, height: 900 });

class FakeGateway implements MediaCommandGateway {
  jobs = new Map<string, { hash: string; main: { hash: string; size: number }; thumb: { hash: string; size: number } }>();
  files = new Set<string>();
  sizes = new Map<string, number>();
  preset(t: string, req: string, reqHash: string, main: { hash: string; size: number }, thumb: { hash: string; size: number }) {
    this.jobs.set(`${t}::${req}`, { hash: reqHash, main, thumb });
    this.files.add(`${t}::${main.hash}`); this.files.add(`${t}::${thumb.hash}`); this.sizes.set(main.hash, main.size); this.sizes.set(thumb.hash, thumb.size);
  }
  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`)!;
    return { ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared', main_descriptor: desc(j.main.hash, j.main.size), thumbnail_descriptor: desc(j.thumb.hash, j.thumb.size) };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`)!;
    return { state: 'published', main_descriptor: desc(j.main.hash, j.main.size), thumbnail_descriptor: desc(j.thumb.hash, j.thumb.size),
      main_storage_key: key(i.tenantScope, j.main.hash), thumbnail_storage_key: key(i.tenantScope, j.thumb.hash) };
  }
  async abortStockImage(i: AbortInput): Promise<AbortResult> { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> {
    if (!this.files.has(`${i.tenantScope}::${i.hash}`)) throw new Error('MEDIA_FILE_MISSING');
    const n = this.sizes.get(i.hash) ?? 3;
    return { bytes: new Uint8Array(n), hash: i.hash, byte_size: n, mime_type: 'image/jpeg', extension: 'jpg' };
  }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}

/** Ersatz für `media_recompress_stored`: deterministisch (wie der echte Encoder), Größe = 70 % der Grenze. */
function fakeRust(gw: FakeGateway, opts: { failOnce?: Set<string>; missing?: Set<string> } = {}) {
  const calls: RecompressArgs[] = [];
  const fn = async (a: RecompressArgs): Promise<RecompressOutcome> => {
    calls.push(a);
    if (opts.missing?.has(a.sourceHash)) throw Object.assign(new Error('MEDIA_FILE_MISSING'), { code: 'MEDIA_FILE_MISSING' });
    const hash = pad64(`e${a.rendition === 'main' ? 'a' : 'b'}${a.sourceHash.slice(0, 20)}${a.maxBytes}`);
    const size = Math.floor(a.maxBytes * 0.7);
    const published = a.publish && (a.publishOnlyBelow == null || size < a.publishOnlyBelow);
    if (published) { gw.files.add(`${a.tenantScope}::${hash}`); gw.sizes.set(hash, size); }
    return { rendition: a.rendition, source_hash: a.sourceHash, source_byte_size: 0, hash, byte_size: size, width: 900, height: 600,
      extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: key(a.tenantScope, hash), published };
  };
  return { fn, calls };
}

function q(db: any, sql: string, p: unknown[] = []): any[] {
  const r = db.exec(sql, p);
  if (!r.length) return [];
  return r[0].values.map((v: unknown[]) => Object.fromEntries(r[0].columns.map((c: string, i: number) => [c, v[i]])));
}

async function world(SQL: any) {
  const db = new SQL.Database();
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT${t.idCol === 'id' ? '' : `, ${t.idCol} TEXT`})`);
  }
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`ALTER TABLE products ADD COLUMN category_id TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN image_hash TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN image_embedding TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN updated_at TEXT`);
  db.run(`ALTER TABLE repairs ADD COLUMN item_category_id TEXT`);
  db.run(`ALTER TABLE orders ADD COLUMN category_id TEXT`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, data TEXT)`);
  db.run(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY, entity_type TEXT, entity_id TEXT)`);
  db.run(`INSERT INTO tenants VALUES ('t1')`);
  db.run(`INSERT INTO branches VALUES ('b1','t1')`);
  for (const [id, cat] of [['p-watch', 'cat-watch'], ['p-gold', 'cat-gold-jewelry'], ['p-acc', 'cat-accessory'], ['p-small', 'cat-watch'],
    ['p-share-w', 'cat-watch'], ['p-share-j', 'cat-branded-gold-jewelry'], ['p-old', 'cat-watch'], ['p-spare', 'cat-spare-part']]) {
    db.run(`INSERT INTO products (id, branch_id, images, category_id, image_hash, image_embedding, updated_at) VALUES (?, 'b1', '[]', ?, ?, ?, '2026-11-10')`, [id, cat, `ph-${id}`, `[0.1,0.2,${id.length}]`]);
  }
  db.run(`INSERT INTO repairs (id, branch_id, item_category_id) VALUES ('r-nocat','b1',NULL),('r-gold','b1','cat-gold-jewelry')`);
  db.run(`INSERT INTO customers (id, branch_id) VALUES ('c1','b1')`);
  db.run(`INSERT INTO sync_changelog (table_name, record_id, data) VALUES ('products','p-watch','{}')`);
  db.run(`INSERT INTO audit_log (entity_type, entity_id) VALUES ('products','p-watch')`);
  applyMediaSchema(db);
  const gw = new FakeGateway();
  const coord = new MediaDbCoordinator(db, gw);
  let n = 0;
  const add = async (entityType: string, entityId: string, mainSize: number, thumbSize: number, extra: Partial<FinalizeInput> = {}, mainHash?: string) => {
    n++;
    const req = `req-${entityId}-${n}`;
    const main = { hash: mainHash ?? pad64(`a${n}a${entityId.length}`), size: mainSize };
    const thumb = { hash: pad64(`b${n}b${entityId.length}`), size: thumbSize };
    gw.preset('t1', req, pad64(`c${n}`), main, thumb);
    const r = await coord.finalize({ tenantId: 't1', branchId: 'b1', entityType, entityId, scopeKind: 'branch', role: 'stock_image',
      ingestRequestId: req, requestHash: pad64(`c${n}`), isPrimary: true, sortOrder: 0, ...extra } as FinalizeInput);
    return { ...r, main, thumb };
  };
  return { db, gw, coord, add };
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 Klassenregel + Draht-Vertrag ─────────────────────────────────────────
  ok(sizeProfileFor({ categoryId: 'cat-watch' }) === 'main60', 'Uhr → 60 KB');
  for (const c of ['cat-gold-jewelry', 'cat-branded-gold-jewelry', 'cat-original-gold-jewelry', 'cat-accessory']) ok(sizeProfileFor({ categoryId: c }) === 'main30', `${c} → 30 KB`);
  ok(sizeProfileFor({ categoryId: null }) === 'main60', 'ohne Kategorie (Reparatur, Altgold, Inbox) → 60 KB');
  ok(sizeProfileFor({ categoryId: 'cat-spare-part' }) === 'main60' && sizeProfileFor({ categoryId: 'custom-x' }) === 'main60', 'andere/unbekannte Kategorie → 60 KB');
  ok(sizeProfileFor({ categoryId: 'cat-gold-jewelry', role: 'identity_document' }) === 'standard', 'Ausweis bleibt beim bisherigen Limit, egal welche Kategorie');
  ok(sizeProfileFor({ categoryId: 'cat-watch', securityClass: 'sensitive' }) === 'standard', 'höhere Sicherheitsklasse → unverändert');
  ok(SIZE_PROFILE_NORM_PARAMS.standard === CUTOVER_NORM_PARAMS, 'standard-Parameter wortgleich mit dem bisherigen');
  ok(SIZE_PROFILE_LIMITS.main60.thumbnail === 10_000 && SIZE_PROFILE_LIMITS.main30.thumbnail === 10_000 && SIZE_PROFILE_LIMITS.main30.main === 30_000, 'Grenzen 60/30/10 KB');
  {
    const b = new Uint8Array([1, 2, 3, 4]);
    const std = await canonicalRequestHash(b, 'tenant-1');
    ok(std === await canonicalRequestHash(b, 'tenant-1', 'standard'), 'Hash ohne Klasse = standard (alte Aufnahmen bleiben gültig)');
    ok(std !== await canonicalRequestHash(b, 'tenant-1', 'main60') && (await canonicalRequestHash(b, 'tenant-1', 'main60')) !== (await canonicalRequestHash(b, 'tenant-1', 'main30')), 'Klasse ist Teil der Anfrage-Identität');
  }

  // ── §2 Welt: Uhr, Schmuck, Accessory, Reparatur, Ausweis, klein, geteilt, entfernt ──
  const W = await world(SQL);
  const { db, gw, coord } = W;
  const watch = await W.add('product', 'p-watch', 95_000, 18_000);
  const gold = await W.add('product', 'p-gold', 88_000, 16_000);
  const acc = await W.add('product', 'p-acc', 70_000, 9_000);           // Vorschau schon ≤ 10 KB
  const small = await W.add('product', 'p-small', 41_000, 8_000);       // Uhr unter 60 KB → nichts
  const repNo = await W.add('repair', 'r-nocat', 80_000, 15_000, { role: 'gallery' });
  const repGold = await W.add('repair', 'r-gold', 64_000, 12_000, { role: 'gallery' });
  const idDoc = await W.add('customer', 'c1', 95_000, 19_000, { role: 'identity_document', securityClass: 'sensitive' });
  const shared = await W.add('product', 'p-share-w', 90_000, 17_000);
  // derselbe Inhalt bei einem Schmuckstück (Dedup → derselbe Blob): Grenze = die größere (60 KB)
  const shared2 = await W.add('product', 'p-share-j', 90_000, 17_500, {}, shared.main.hash);
  const removed = await W.add('product', 'p-old', 92_000, 18_500);
  db.run(`UPDATE media_links SET deleted_at = '2026-11-01' WHERE entity_id = 'p-old'`);      // historisch entfernt
  ok(shared2.mainBlobId === shared.mainBlobId, 'Testwelt: geteiltes Hauptbild ist ein Blob');

  const before = migrationInvariantDigest(db as MigrationDb);
  const gensBefore = q(db, `SELECT * FROM media_blob_generations ORDER BY blob_id, generation_no`);
  const resolver = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' });
  const fpBefore = resolver.galleryFingerprint('p-watch');

  // ── §3 Plan + Probelauf: nichts wird geschrieben ───────────────────────────
  const plan = planImageStoreMigration(db as MigrationDb);
  const pb = (blob: string) => plan.plans.find((p) => p.blobId === blob);
  const sk = (blob: string) => plan.skipped.find((p) => p.blobId === blob)?.reason;
  ok(pb(watch.mainBlobId)?.targetBytes === 60_000 && pb(watch.mainBlobId)?.usageClass === 'watch', 'Uhr: Ziel 60 KB');
  ok(pb(gold.mainBlobId)?.targetBytes === 30_000 && pb(gold.mainBlobId)?.usageClass === 'jewelry', 'Schmuck: Ziel 30 KB');
  ok(pb(acc.mainBlobId)?.targetBytes === 30_000 && pb(acc.mainBlobId)?.usageClass === 'accessory', 'Accessory: Ziel 30 KB');
  ok(pb(repNo.mainBlobId)?.targetBytes === 60_000 && pb(repNo.mainBlobId)?.usageClass === 'repair', 'Reparatur ohne Kategorie: 60 KB');
  ok(pb(repGold.mainBlobId)?.targetBytes === 30_000, 'Reparatur mit Schmuck-Kategorie: 30 KB');
  ok(pb(shared.mainBlobId)?.targetBytes === 60_000, 'geteilter Blob (Uhr + Schmuck): die größere Grenze, 60 KB');
  ok(pb(watch.thumbnailBlobId)?.targetBytes === 10_000 && pb(watch.thumbnailBlobId)?.sourceHash === watch.main.hash, 'Vorschau: 10 KB, gerechnet aus dem ORIGINAL-Hauptbild');
  ok(sk(acc.thumbnailBlobId) === 'already_small' && sk(small.mainBlobId) === 'already_small' && sk(small.thumbnailBlobId) === 'already_small', 'schon kleine Bilder bleiben unverändert');
  ok(sk(idDoc.mainBlobId) === 'excluded_security' && sk(idDoc.thumbnailBlobId) === 'excluded_security', 'Ausweis: nie angefasst');
  ok(!pb(removed.mainBlobId) && !sk(removed.mainBlobId), 'historisch entfernte Bilder: gar nicht im Plan');

  const r0 = fakeRust(gw);
  const journal0: MigrationJournalEntry[] = [];
  const dry = await runImageStoreMigration({ db: db as MigrationDb, recompress: r0.fn, saveDurably: async () => { throw new Error('dry-run must not save'); }, journal: (e) => { journal0.push(e); } }, { mode: 'dry-run' });
  ok(r0.calls.every((c) => !c.publish), 'Probelauf: keine Veröffentlichung angefordert');
  ok(JSON.stringify(q(db, `SELECT * FROM media_blob_generations ORDER BY blob_id, generation_no`)) === JSON.stringify(gensBefore), 'Probelauf: keine Zeile geändert');
  ok(dry.eligible === plan.plans.length - 1 && dry.skipped.duplicate_content === 1 && dry.bytesAfter < dry.bytesBefore && dry.switched === 0, `Probelauf: Vorhersage für ${dry.eligible} Blobs (${dry.bytesBefore} → ${dry.bytesAfter} B)`);
  ok(journal0.every((e) => !JSON.stringify(e).match(/p-watch|c1|customer/)), 'Protokoll enthält nur Kennungen von Blobs, keine Besitzer/Namen');

  // ── §4 Vorbedingung: offene Aufnahme → kein Schreiben ─────────────────────
  db.run(`INSERT INTO media_ingest_jobs (tenant_id, job_id, ingest_request_id, request_hash, state, scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role, security_class, retention_class, created_at, updated_at)
          SELECT tenant_id, 'job-open', 'req-open', request_hash, 'accepted', scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role, security_class, retention_class, created_at, updated_at FROM media_ingest_jobs LIMIT 1`);
  let blocked = '';
  try { assertMigrationPreconditions(db as MigrationDb); } catch (e) { blocked = (e as { code?: string }).code ?? ''; }
  ok(blocked === 'MIGRATION_OPEN_INGEST_JOBS', 'offene Aufnahme blockiert den Lauf (fail-closed)');
  db.run(`DELETE FROM media_ingest_jobs WHERE job_id = 'job-open'`);

  // ── §5 Lauf mit Abbruch nach 3 Umstellungen, dann Wiederaufnahme ───────────
  let saves = 0;
  const r1 = fakeRust(gw);
  let sw = 0;
  const run1 = await runImageStoreMigration({ db: db as MigrationDb, recompress: r1.fn, saveDurably: async () => { saves++; }, journal: (e) => { if (e.event === 'switched') sw++; } },
    { mode: 'apply', saveEvery: 2, shouldStop: () => sw >= 3 });
  ok(run1.stoppedEarly && run1.switched === 3 && saves >= 2, `Abbruch nach 3 Umstellungen, zwischendurch gespeichert (${saves}×)`);
  // „Absturz vor dem Speichern": Stand der DB verwerfen, als wäre der letzte Teil nie gespeichert worden.
  const snapshot = db.export();
  const r2 = fakeRust(gw);
  const run2 = await runImageStoreMigration({ db: db as MigrationDb, recompress: r2.fn, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
  ok(!run2.stoppedEarly && run2.failed === 0 && run1.switched + run2.switched === plan.plans.length - 1 && run2.skipped.duplicate_content === 1,
    `Wiederaufnahme: Rest umgestellt (${run1.switched} + ${run2.switched} = ${plan.plans.length} − 1 bitgleiche Vorschau des geteilten Hauptbilds)`);
  // Absturz-Variante: alter Stand + Dateien schon veröffentlicht → dieselben Dateien, kein Konflikt.
  const crashed = new SQL.Database(snapshot);
  const r3 = fakeRust(gw);
  const run3 = await runImageStoreMigration({ db: crashed as MigrationDb, recompress: r3.fn, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
  ok(run3.failed === 0 && run3.switched === run2.switched, 'nach „Absturz vor dem Speichern": dieselben Blobs bitgleich erneut umgestellt');
  crashed.close();

  // ── §6 Ergebnis: Generationen, Zuordnungen, Nebenwirkungen ───────────────
  const gen = (blob: string) => q(db, `SELECT b.current_generation_no AS cur, (SELECT COUNT(*) FROM media_blob_generations g WHERE g.blob_id = b.blob_id) AS n,
      (SELECT gen_status FROM media_blob_generations g WHERE g.blob_id = b.blob_id AND g.generation_no = 1) AS g1,
      (SELECT byte_size FROM media_blob_generations g WHERE g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no) AS bytes
      FROM media_blobs b WHERE b.blob_id = ?`, [blob])[0];
  ok(gen(watch.mainBlobId).cur === 2 && gen(watch.mainBlobId).g1 === 'superseded' && gen(watch.mainBlobId).bytes <= 60_000, 'Uhr: Generation 2 aktiv (≤ 60 KB), Generation 1 superseded (Datei bleibt)');
  ok(gen(gold.mainBlobId).bytes <= 30_000 && gen(acc.mainBlobId).bytes <= 30_000 && gen(watch.thumbnailBlobId).bytes <= 10_000, 'Schmuck/Accessory ≤ 30 KB, Vorschau ≤ 10 KB');
  ok(gen(small.mainBlobId).cur === 1 && gen(idDoc.mainBlobId).cur === 1 && gen(removed.mainBlobId).cur === 1 && gen(acc.thumbnailBlobId).cur === 1, 'klein / Ausweis / entfernt / kleine Vorschau: unverändert Generation 1');
  ok(q(db, `SELECT MAX(generation_no) AS m FROM media_blob_generations`)[0].m === 2, 'kein Blob doppelt umgestellt');
  const after = migrationInvariantDigest(db as MigrationDb);
  ok(JSON.stringify(after) === JSON.stringify(before), 'Medien-IDs, Objekte, Varianten, Verknüpfungen, Artikelzeilen (pHash, Embedding), sync_changelog und audit_log unverändert');
  const fpAfter = resolver.galleryFingerprint('p-watch');
  ok(fpAfter !== fpBefore, 'S1-Fingerabdruck ändert sich → die Karte lädt einmal neu');
  const res = await resolver.resolveProductMedia('p-watch');
  ok(res.kind === 'media' && res.items[0].bytes.length === Number(gen(watch.mainBlobId).bytes) && Number(gen(watch.mainBlobId).bytes) < watch.main.size, 'Resolver liefert die neue Generation (Bytegröße der Generation 2)');
  const again = await runImageStoreMigration({ db: db as MigrationDb, recompress: fakeRust(gw).fn, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
  ok(again.switched === 0 && again.eligible === 0 && again.failed === 0, 'zweiter Lauf: nichts mehr zu tun (idempotent)');

  // ── §7 Neue Uploads nach der Migration (Dedup-Fälle) ──────────────────────
  {
    const g2 = q(db, `SELECT g.stored_blob_hash AS h, g.byte_size AS s FROM media_blobs b JOIN media_blob_generations g ON g.blob_id=b.blob_id AND g.generation_no=b.current_generation_no WHERE b.blob_id=?`, [gold.mainBlobId])[0];
    // B: jemand lädt genau die verkleinerte Fassung neu hoch → derselbe Inhalt liegt als Generation 2 vor.
    gw.preset('t1', 'req-reup-b', pad64('d1'), { hash: String(g2.h), size: Number(g2.s) }, { hash: pad64('d1thumb'), size: 6_000 });
    let errB = '';
    let rB: any = null;
    try { rB = await coord.finalize({ tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p-spare', scopeKind: 'branch', role: 'stock_image', ingestRequestId: 'req-reup-b', requestHash: pad64('d1'), isPrimary: true, sortOrder: 0 }); }
    catch (e) { errB = String((e as Error).message); }
    ok(!errB && rB?.mainBlobId === gold.mainBlobId, `Upload = verkleinerte Fassung: vorhandener Blob wiederverwendet, kein UNIQUE-Fehler (${errB || 'ok'})`);
    // A: jemand lädt das ORIGINAL (Generation 1, superseded) neu hoch.
    gw.preset('t1', 'req-reup-a', pad64('d2'), { hash: watch.main.hash, size: watch.main.size }, { hash: pad64('d2thumb'), size: 6_000 });
    let errA = '';
    try { await coord.finalize({ tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p-spare', scopeKind: 'branch', role: 'stock_image', ingestRequestId: 'req-reup-a', requestHash: pad64('d2'), isPrimary: false, sortOrder: 1 }); }
    catch (e) { errA = String((e as Error).message); }
    ok(!errA, `Upload = Original eines migrierten Blobs: kein Konflikt (${errA || 'ok'})`);
  }

  // ── §8 Teilfehler: fehlende Datei → protokolliert, Rest läuft weiter ──────
  {
    const V = await world(SQL);
    const a = await V.add('product', 'p-watch', 95_000, 18_000);
    const b = await V.add('product', 'p-gold', 88_000, 16_000);
    const rr = fakeRust(V.gw, { missing: new Set([a.main.hash]) });
    const rep = await runImageStoreMigration({ db: V.db as MigrationDb, recompress: rr.fn, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
    ok(rep.failed >= 1 && rep.errors.some((e) => e.code === 'MEDIA_FILE_MISSING' && e.blobId === a.mainBlobId), 'fehlende Originaldatei: als Fehler protokolliert, nicht „repariert"');
    const cur = (blob: string) => Number(q(V.db, `SELECT current_generation_no AS c FROM media_blobs WHERE blob_id=?`, [blob])[0].c);
    ok(cur(a.mainBlobId) === 1 && cur(b.mainBlobId) === 2, 'betroffener Blob bleibt auf Generation 1, die anderen laufen weiter');
    ok(cur(a.thumbnailBlobId) === 2, 'Vorschau rechnet aus ihrer eigenen Original-Fassung, wenn das Hauptbild-Original fehlt');
    // Ein Speicherschlüssel, den schon jemand hat, wird nicht doppelt vergeben (Rollback, Blob unverändert).
    const W2 = await world(SQL);
    const x = await W2.add('product', 'p-watch', 95_000, 18_000);
    const collide = async (arg: RecompressArgs): Promise<RecompressOutcome> => ({ rendition: arg.rendition, source_hash: arg.sourceHash, source_byte_size: 0,
      hash: x.thumb.hash, byte_size: 9_000, width: 10, height: 10, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: key('t1', x.thumb.hash), published: true });
    const rc = await runImageStoreMigration({ db: W2.db as MigrationDb, recompress: collide, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply', onlyBlobIds: new Set([x.mainBlobId]) });
    ok(rc.skipped.duplicate_content === 1 && rc.switched === 0 && Number(q(W2.db, `SELECT current_generation_no AS c FROM media_blobs WHERE blob_id=?`, [x.mainBlobId])[0].c) === 1, 'belegter Speicherschlüssel: übersprungen, Blob unverändert');
    const { switchBlobGeneration: sw2 } = await import('../../src/core/media/image-store-migration.ts');
    const px = planImageStoreMigration(W2.db as MigrationDb).plans.find((y) => y.blobId === x.mainBlobId)!;
    let c2 = '';
    try { sw2(W2.db as MigrationDb, px, await collide({ rendition: 'main', sourceHash: px.sourceHash } as RecompressArgs), 'now'); } catch (e) { c2 = (e as { code?: string }).code ?? ''; }
    ok(c2 === 'MIGRATION_STORAGE_KEY_TAKEN' && Number(q(W2.db, `SELECT current_generation_no AS c FROM media_blobs WHERE blob_id=?`, [x.mainBlobId])[0].c) === 1, 'Transaktion selbst weist einen belegten Schlüssel ab (Rollback)');
  }

  // ── §9 Die Trigger schützen auch gegen einen fehlerhaften Lauf ────────────
  {
    const V = await world(SQL);
    const a = await V.add('product', 'p-watch', 95_000, 18_000);
    const big = async (arg: RecompressArgs): Promise<RecompressOutcome> => ({ rendition: arg.rendition, source_hash: arg.sourceHash, source_byte_size: 0,
      hash: pad64('ff1'), byte_size: 25_000, width: 10, height: 10, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: key('t1', pad64('ff1')), published: true });
    // Eine „Vorschau" über 20 000 B darf nie aktiv werden (Schema-Trigger), auch wenn ein Aufrufer sie liefert.
    const { switchBlobGeneration } = await import('../../src/core/media/image-store-migration.ts');
    const p = planImageStoreMigration(V.db as MigrationDb).plans.find((x) => x.blobId === a.thumbnailBlobId)!;
    let code = '';
    try { switchBlobGeneration(V.db as MigrationDb, p, await big({ ...({} as RecompressArgs), rendition: 'thumbnail', sourceHash: p.sourceHash } as RecompressArgs), 'now'); } catch (e) { code = String((e as Error).message); }
    ok(/MEDIA_GENERATION_USAGE_CONSTRAINT|CHECK/.test(code) && Number(q(V.db, `SELECT current_generation_no AS c FROM media_blobs WHERE blob_id=?`, [a.thumbnailBlobId])[0].c) === 1, `Trigger: zu große Vorschau wird abgewiesen, Rollback (${code.slice(0, 60)})`);
  }

  console.log(`\n${FAIL === 0 ? 'OK' : 'FAIL'} — image-store-migration: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
