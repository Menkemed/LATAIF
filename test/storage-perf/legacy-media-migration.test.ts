// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §7/§8/§10/§20 — bulk legacy → gallery migration.
// Run: node test/storage-perf/legacy-media-migration.test.ts
//
// Drives the REAL planner + runner + ProductMediaCutoverService + orchestrator +
// coordinator against REAL sql.js. A deterministic fake gateway stands in for the
// Rust bridge; an explicit "disk" models durability, so a crash only keeps what a
// checkpoint persisted.
//
// The contract under test: legacy bytes are NEVER cleared before the durable
// gallery is verified, a re-run is a pure no-op, a corrupt product is reported and
// left completely intact while its neighbours still migrate, and no product field
// other than `images` is ever touched.
//
// No production DB, no Tauri, no base64 ever printed.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { StockMediaOrchestrator, type OrchestratorLease, type OrchestratorRawDb } from '../../src/core/media/orchestrator.ts';
import { ProductMediaCutoverService, decodeDataUrl } from '../../src/core/media/product-media-cutover.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';
import { planLegacyMediaCutover, classifyLegacyEntry, base64DecodedLength } from '../../src/core/storage/legacy-media-plan.ts';
import { runLegacyMediaMigration, verifyMigratedProduct } from '../../src/core/storage/legacy-media-migration.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// ── deterministic image payloads ────────────────────────────────────────────
function legacyDataUrl(seed: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed.charCodeAt(i % seed.length) * (i + 3)) & 0xff;
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
}
function sha256Hex(b: Uint8Array): string { return createHash('sha256').update(Buffer.from(b)).digest('hex'); }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out;
}
function desc(hash: string, size: number) {
  return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 800, height: 600 };
}

class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainBytes: Uint8Array; thumbBytes: Uint8Array }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  private reqBytes = new Map<string, Uint8Array>();
  commitShouldThrowFor: string | null = null;
  prepareShouldThrowFor: string | null = null;
  readonly prepares: string[] = [];
  readonly commits: string[] = [];

  private renditionsFor(scope: string, inputBytes: Uint8Array) {
    const h = sha256Hex(inputBytes);
    let r = this.byHash.get(h);
    if (!r) {
      r = {
        main: sha256Hex(concat(inputBytes, new Uint8Array([1]))),
        thumb: sha256Hex(concat(inputBytes, new Uint8Array([2]))),
        mainBytes: concat(inputBytes, new Uint8Array([0xaa])),
        thumbBytes: concat(inputBytes, new Uint8Array([0xbb])),
      };
      this.byHash.set(h, r);
    }
    this.files.set(`${scope}::${r.main}`, { bytes: r.mainBytes, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${r.thumb}`, { bytes: r.thumbBytes, mime: 'image/jpeg', ext: 'jpg' });
    return r;
  }
  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    this.prepares.push(i.ingestRequestId);
    if (this.prepareShouldThrowFor === i.ingestRequestId) throw new Error('MEDIA_INGEST_IO_ERROR');
    this.reqBytes.set(`${i.tenantScope}::${i.ingestRequestId}`, i.imageBytes);
    const r = this.renditionsFor(i.tenantScope, i.imageBytes);
    return {
      ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared',
      main_descriptor: desc(r.main, r.mainBytes.length), thumbnail_descriptor: desc(r.thumb, r.thumbBytes.length),
    };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    this.commits.push(i.ingestRequestId);
    if (this.commitShouldThrowFor === i.ingestRequestId) throw new Error('MEDIA_INGEST_NOT_FOUND');
    const bytes = this.reqBytes.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!bytes) throw new Error('MEDIA_INGEST_NOT_FOUND');
    const r = this.renditionsFor(i.tenantScope, bytes);
    return {
      state: 'published',
      main_descriptor: desc(r.main, r.mainBytes.length), thumbnail_descriptor: desc(r.thumb, r.thumbBytes.length),
      main_storage_key: `${i.tenantScope}/${r.main.slice(0, 2)}/${r.main}.jpg`,
      thumbnail_storage_key: `${i.tenantScope}/${r.thumb.slice(0, 2)}/${r.thumb}.jpg`,
    };
  }
  async abortStockImage(i: AbortInput): Promise<AbortResult> { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> {
    const f = this.files.get(`${i.tenantScope}::${i.hash}`);
    if (!f) throw new Error('MEDIA_FILE_MISSING');
    return { bytes: f.bytes, hash: i.hash, byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext };
  }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}

class Disk { image: Uint8Array | null = null; writes = 0; }
function leaseFor(db: OrchestratorRawDb, disk: Disk): OrchestratorLease {
  return {
    db, epoch: 0,
    async saveDurably() { disk.writes++; disk.image = (db as unknown as { export(): Uint8Array }).export(); },
    release() {},
  };
}

type AnyDb = { run(sql: string, params?: unknown[]): void; exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; export(): Uint8Array };

function seed(db: AnyDb): void {
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  }
  // The product columns §20 protects, mirroring the real schema's shape.
  for (const col of ['images TEXT DEFAULT \'[]\'', 'sku TEXT', 'brand TEXT', 'name TEXT', 'category_id TEXT',
    'purchase_price REAL', 'planned_sale_price REAL', 'min_sale_price REAL', 'attributes TEXT',
    'notes TEXT', 'quantity INTEGER', 'tax_scheme TEXT', 'stock_status TEXT', 'updated_at TEXT']) {
    db.run(`ALTER TABLE products ADD COLUMN ${col}`);
  }
  db.run(`INSERT INTO tenants  (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('bx','t2')`);
}

interface Product { id: string; images: string[] | string; }
function insertProduct(db: AnyDb, p: Product & Record<string, unknown>, branch = 'b1'): void {
  db.run(
    `INSERT INTO products (id, branch_id, images, sku, brand, name, category_id, purchase_price,
       planned_sale_price, min_sale_price, attributes, notes, quantity, tax_scheme, stock_status, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      p.id, branch, typeof p.images === 'string' ? p.images : JSON.stringify(p.images),
      (p.sku as string) ?? `SKU-${p.id}`, (p.brand as string) ?? 'Rolex', (p.name as string) ?? 'Datejust 41',
      (p.category_id as string) ?? 'cat-watch', (p.purchase_price as number) ?? 0,
      (p.planned_sale_price as number) ?? 4545, (p.min_sale_price as number) ?? 451.645,
      (p.attributes as string) ?? '{"movement":"Cal. 3235","diamonds":true,"case_diameter_mm":41}',
      (p.notes as string) ?? 'keep me', (p.quantity as number) ?? 1, (p.tax_scheme as string) ?? 'MARGIN',
      (p.stock_status as string) ?? 'in_stock', '2026-05-18T18:41:00.000Z',
    ],
  );
}

const SCOPE = { tenantId: 't1', branchId: 'b1' };

function wire(db: AnyDb, gw: FakeGateway, disk: Disk, opts: { clearFails?: boolean } = {}) {
  const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db as unknown as OrchestratorRawDb, disk) });
  const svc = new ProductMediaCutoverService({
    dbProvider: () => db,
    orchestrator: orch,
    tenantId: SCOPE.tenantId, branchId: SCOPE.branchId,
    computeRequestHash: async (b) => sha256Hex(b),
    commitLegacyCleared: async (productId) => {
      if (opts.clearFails) throw new Error('CLEAR_SAVE_FAILED');
      db.run(`UPDATE products SET images='[]' WHERE id=?`, [productId]);
      disk.writes++; disk.image = db.export();
    },
  });
  return { orch, svc };
}

function row(db: AnyDb, sql: string, params: unknown[] = []): unknown[] | null {
  const r = db.exec(sql, params);
  return r.length && r[0].values.length ? r[0].values[0] : null;
}
function legacyOf(db: AnyDb, id: string): string { return String(row(db, `SELECT images FROM products WHERE id=?`, [id])?.[0] ?? ''); }
function activeLinks(db: AnyDb, id: string): number { return Number(row(db, `SELECT COUNT(*) FROM media_links WHERE entity_id=? AND deleted_at IS NULL`, [id])?.[0] ?? 0); }
function allLinks(db: AnyDb, id: string): number { return Number(row(db, `SELECT COUNT(*) FROM media_links WHERE entity_id=?`, [id])?.[0] ?? 0); }
function blobCount(db: AnyDb): number { return Number(row(db, `SELECT COUNT(*) FROM media_blobs`)?.[0] ?? 0); }
function masterBlobCount(db: AnyDb): number { return Number(row(db, `SELECT COUNT(DISTINCT master_blob_id) FROM media_objects WHERE deleted_at IS NULL`)?.[0] ?? 0); }
function productSnapshot(db: AnyDb, id: string): Record<string, unknown> {
  const r = db.exec(`SELECT * FROM products WHERE id=?`, [id]);
  const out: Record<string, unknown> = {};
  if (!r.length || !r[0].values.length) return out;
  r[0].columns.forEach((c, i) => { out[c] = r[0].values[0][i]; });
  return out;
}
function noBackup(): Promise<void> { return Promise.reject(new Error('BACKUP_REQUIRED')); }
function haveBackup(): Promise<void> { return Promise.resolve(); }

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });
  const fresh = (): AnyDb => { const db = new SQL.Database() as unknown as AnyDb; seed(db); applyMediaSchema(db); return db; };

  // ── §1 planner arithmetic ────────────────────────────────────────────────
  {
    ok(base64DecodedLength('AAAA') === 3, 'base64 length: 4 chars → 3 bytes');
    ok(base64DecodedLength('AAA=') === 2, 'base64 length: one pad → 2 bytes');
    ok(base64DecodedLength('AA==') === 1, 'base64 length: two pads → 1 byte');
    ok(base64DecodedLength('AAAA\nAAAA') === 6, 'base64 length ignores whitespace');
    ok(classifyLegacyEntry(legacyDataUrl('x')).ok, 'a real data URL classifies as migratable');
    ok(!classifyLegacyEntry('https://example.invalid/a.jpg').ok, 'a http url is not migratable');
    ok(!classifyLegacyEntry('data:image/jpeg;base64,').ok, 'an empty payload is not migratable');
    ok(!classifyLegacyEntry('data:text/plain,hello').ok, 'a non-base64 data URL is not migratable');
    ok(!classifyLegacyEntry('').ok, 'an empty string is not migratable');
    ok(!classifyLegacyEntry(null).ok, 'null is not migratable');
    const bad = classifyLegacyEntry('data:image/jpeg;base64,!!!!not-base64!!!!');
    ok(!bad.ok && bad.reason === 'LEGACY_ENTRY_BASE64_INVALID', 'invalid base64 gets its own reason code');
  }

  // ── §2 plan classification over a mixed fixture ──────────────────────────
  {
    const db = fresh();
    insertProduct(db, { id: 'none', images: [] });                                   // 0 images
    insertProduct(db, { id: 'one', images: [legacyDataUrl('one-0')] });              // 1 image
    insertProduct(db, { id: 'many', images: [legacyDataUrl('m0'), legacyDataUrl('m1'), legacyDataUrl('m2')] });
    insertProduct(db, { id: 'same', images: [legacyDataUrl('dup'), legacyDataUrl('dup')] });  // identical twice
    insertProduct(db, { id: 'corrupt', images: [legacyDataUrl('c0'), 'data:image/jpeg;base64,###'] });
    insertProduct(db, { id: 'notjson', images: 'this is not json' });
    insertProduct(db, { id: 'foreign', images: [legacyDataUrl('f0')] }, 'bx');       // other tenant

    const plan = planLegacyMediaCutover(db, SCOPE);
    ok(plan.scannedProducts === 6, `plan sees only in-scope products (${plan.scannedProducts})`);
    ok(plan.items.every((i) => i.productId !== 'foreign'), 'a foreign-tenant product is never in the plan');
    ok(plan.migratable === 3, `migratable=3 — one + many + same (${plan.migratable})`);
    ok(plan.unsupported === 2, `unsupported=2 — corrupt entry + non-JSON column (${plan.unsupported})`);
    ok(plan.noImages === 1, `no_images=1 (${plan.noImages})`);
    ok(plan.legacyImageCount === 6, `image count 1+3+2 = 6 (${plan.legacyImageCount})`);
    ok(plan.decodedBytes === 6 * 32, `decoded bytes are arithmetic, not guessed (${plan.decodedBytes})`);
    ok(plan.reclaimableColumnBytes > 0, 'reclaimable column bytes are measured');
    const corrupt = plan.items.find((i) => i.productId === 'corrupt')!;
    ok(corrupt.state === 'unsupported' && corrupt.reason === 'LEGACY_ENTRY_BASE64_INVALID', 'corrupt product carries its reason');
    const notjson = plan.items.find((i) => i.productId === 'notjson')!;
    ok(notjson.state === 'unsupported' && notjson.reason === 'MEDIA_LEGACY_MALFORMED_JSON', 'non-JSON column is reported, not crashed on');
    ok(plan.items.every((i) => !JSON.stringify(i).includes('base64')), 'the plan never carries image payloads');
  }

  // ── §3 backup pre-condition is fail-closed ──────────────────────────────
  {
    const db = fresh();
    insertProduct(db, { id: 'p1', images: [legacyDataUrl('p1-0')] });
    const gw = new FakeGateway(); const disk = new Disk();
    const { svc } = wire(db, gw, disk);
    let threw = '';
    try {
      await runLegacyMediaMigration({
        dbProvider: () => db, scope: SCOPE, requireBackup: noBackup,
        cutoverProduct: (id) => svc.ensureProductMediaCutover(id),
      });
    } catch (e) { threw = (e as Error).message; }
    ok(threw === 'BACKUP_REQUIRED', 'no backup → the run refuses to start');
    ok(gw.prepares.length === 0, 'no backup → not a single ingest was attempted');
    ok(legacyOf(db, 'p1') !== '[]', 'no backup → the legacy column is untouched');
  }

  // ── §4 the happy path + §20 product-data regression ─────────────────────
  {
    const db = fresh();
    insertProduct(db, { id: 'none', images: [] });
    insertProduct(db, { id: 'one', images: [legacyDataUrl('one-0')] });
    insertProduct(db, { id: 'many', images: [legacyDataUrl('m0'), legacyDataUrl('m1'), legacyDataUrl('m2')] });
    const before = { none: productSnapshot(db, 'none'), one: productSnapshot(db, 'one'), many: productSnapshot(db, 'many') };

    const gw = new FakeGateway(); const disk = new Disk();
    const { svc } = wire(db, gw, disk);
    const progress: Array<[number, number]> = [];
    const rep = await runLegacyMediaMigration({
      dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup,
      cutoverProduct: (id) => svc.ensureProductMediaCutover(id),
      onProgress: (done, total) => progress.push([done, total]),
    });

    ok(rep.attempted === 2, `only migratable products are attempted (${rep.attempted})`);
    ok(rep.migrated === 2 && rep.failed === 0 && rep.verifyFailed === 0, `2 migrated, 0 failed (${rep.migrated}/${rep.failed}/${rep.verifyFailed})`);
    ok(progress.length === 2 && progress[1][0] === 2 && progress[1][1] === 2, 'progress is reported per product');
    ok(legacyOf(db, 'one') === '[]' && legacyOf(db, 'many') === '[]', 'legacy columns are cleared after success');
    ok(activeLinks(db, 'one') === 1 && activeLinks(db, 'many') === 3, 'gallery holds exactly the legacy image count');
    ok(rep.clearedColumnBytes === (before.one.images as string).length + (before.many.images as string).length,
      'reported cleared bytes match what the columns actually held');

    // §20 — nothing but `images` may change.
    for (const id of ['none', 'one', 'many'] as const) {
      const after = productSnapshot(db, id);
      const b = before[id];
      const changed = Object.keys(b).filter((k) => String(b[k]) !== String(after[k]));
      ok(changed.length === 0 || (changed.length === 1 && changed[0] === 'images'),
        `${id}: only "images" changed (changed: ${changed.join(',') || 'none'})`);
      ok(String(after.attributes) === String(b.attributes), `${id}: legacy attributes (movement/diamonds) survive byte-identically`);
      ok(String(after.notes) === String(b.notes) && String(after.sku) === String(b.sku), `${id}: notes + sku survive`);
      ok(Number(after.purchase_price) === Number(b.purchase_price), `${id}: purchase_price survives (0 stays 0)`);
      ok(Number(after.min_sale_price) === Number(b.min_sale_price), `${id}: min_sale_price decimals survive`);
    }
    ok(legacyOf(db, 'none') === '[]', 'a product without images is left exactly as it was');
    ok(allLinks(db, 'none') === 0, 'a product without images gets no links');

    // §10 — independent verification agrees.
    ok(verifyMigratedProduct(db, SCOPE, 'many', 3).ok, 'verify: many resolves 3 links down to available generations');
    ok(!verifyMigratedProduct(db, SCOPE, 'many', 4).ok, 'verify: a wrong expected count fails');

    // Ordering + primary.
    const order = db.exec(`SELECT sort_order, is_primary FROM media_links WHERE entity_id='many' AND deleted_at IS NULL ORDER BY sort_order`);
    ok(JSON.stringify(order[0].values) === JSON.stringify([[0, 1], [1, 0], [2, 0]]), 'slots 0..2 with primary exactly at slot 0');
  }

  // ── §5 identical images dedupe to ONE blob but stay TWO slots ───────────
  {
    const db = fresh();
    insertProduct(db, { id: 'same', images: [legacyDataUrl('dup'), legacyDataUrl('dup')] });
    const gw = new FakeGateway(); const disk = new Disk();
    const { svc } = wire(db, gw, disk);
    const rep = await runLegacyMediaMigration({ dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup, cutoverProduct: (id) => svc.ensureProductMediaCutover(id) });
    ok(rep.migrated === 1, 'duplicate-image product migrates');
    ok(activeLinks(db, 'same') === 2, 'two identical legacy images stay two gallery slots');
    ok(masterBlobCount(db) === 1, `content-addressed dedup keeps ONE master blob for identical bytes (${masterBlobCount(db)})`);
  }

  // ── §6 idempotency: a second run changes nothing ────────────────────────
  {
    const db = fresh();
    insertProduct(db, { id: 'many', images: [legacyDataUrl('i0'), legacyDataUrl('i1')] });
    const gw = new FakeGateway(); const disk = new Disk();
    const { svc } = wire(db, gw, disk);
    const run = () => runLegacyMediaMigration({ dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup, cutoverProduct: (id) => svc.ensureProductMediaCutover(id) });
    const first = await run();
    const linksAfterFirst = allLinks(db, 'many');
    const blobsAfterFirst = blobCount(db);
    const preparesAfterFirst = gw.prepares.length;
    const second = await run();
    ok(first.migrated === 1, 'first run migrates');
    ok(second.attempted === 0 && second.migrated === 0, 'second run has nothing to attempt');
    ok(allLinks(db, 'many') === linksAfterFirst, 'second run creates no extra links');
    ok(blobCount(db) === blobsAfterFirst, 'second run creates no extra blobs');
    ok(gw.prepares.length === preparesAfterFirst, 'second run does not even reach the gateway');
    const third = await run();
    ok(third.attempted === 0 && allLinks(db, 'many') === linksAfterFirst, 'a third run is still a no-op');
  }

  // ── §7 crash points — legacy survives every one, retry converges ────────
  for (const crash of ['prepare-second', 'commit-second', 'clear'] as const) {
    const db = fresh();
    const urls = [legacyDataUrl(`${crash}-0`), legacyDataUrl(`${crash}-1`)];
    insertProduct(db, { id: 'p', images: urls });
    const gw = new FakeGateway(); const disk = new Disk();
    const secondId = (await import('../../src/core/media/product-media-cutover.ts')).cutoverRequestId('t1', 'b1', 'p', 'stock_image', 1);
    if (crash === 'prepare-second') gw.prepareShouldThrowFor = secondId;
    if (crash === 'commit-second') gw.commitShouldThrowFor = secondId;
    const { svc } = wire(db, gw, disk, { clearFails: crash === 'clear' });

    const rep = await runLegacyMediaMigration({ dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup, cutoverProduct: (id) => svc.ensureProductMediaCutover(id) });
    ok(rep.migrated === 0 && rep.failed === 1, `${crash}: the product is reported as failed`);
    ok(legacyOf(db, 'p') !== '[]', `${crash}: THE LEGACY COLUMN IS STILL INTACT — no image can be lost`);
    ok(JSON.parse(legacyOf(db, 'p')).length === 2, `${crash}: both legacy entries are still there`);

    // Fix the fault and retry — the already-imported prefix must not duplicate.
    gw.prepareShouldThrowFor = null; gw.commitShouldThrowFor = null;
    const { svc: svc2 } = wire(db, gw, disk);
    const rep2 = await runLegacyMediaMigration({ dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup, cutoverProduct: (id) => svc2.ensureProductMediaCutover(id) });
    ok(rep2.migrated === 1, `${crash}: the retry succeeds`);
    ok(activeLinks(db, 'p') === 2, `${crash}: exactly 2 links after retry — no duplicates from the partial run`);
    ok(legacyOf(db, 'p') === '[]', `${crash}: legacy cleared only after the retry verified the gallery`);
  }

  // ── §8 a corrupt product never blocks its neighbours ────────────────────
  {
    const db = fresh();
    insertProduct(db, { id: 'a_good', images: [legacyDataUrl('a0')] });
    insertProduct(db, { id: 'b_corrupt', images: [legacyDataUrl('b0'), 'data:image/jpeg;base64,###'] });
    insertProduct(db, { id: 'c_good', images: [legacyDataUrl('c0'), legacyDataUrl('c1')] });
    const gw = new FakeGateway(); const disk = new Disk();
    const { svc } = wire(db, gw, disk);
    const rep = await runLegacyMediaMigration({ dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup, cutoverProduct: (id) => svc.ensureProductMediaCutover(id) });
    ok(rep.migrated === 2, 'both healthy products migrate');
    ok(rep.skipped === 1, 'the corrupt product is skipped, not failed silently');
    ok(rep.items.find((i) => i.productId === 'b_corrupt')?.code === 'LEGACY_ENTRY_BASE64_INVALID', 'the skip carries a stable reason');
    ok(legacyOf(db, 'b_corrupt') !== '[]', 'the corrupt product keeps its ENTIRE legacy column');
    ok(allLinks(db, 'b_corrupt') === 0, 'the corrupt product gets no partial gallery');
    ok(legacyOf(db, 'a_good') === '[]' && legacyOf(db, 'c_good') === '[]', 'the healthy neighbours are done');
  }

  // ── §9 already-migrated + mixed (gallery AND legacy) ────────────────────
  {
    const db = fresh();
    insertProduct(db, { id: 'p', images: [legacyDataUrl('mix-0')] });
    const gw = new FakeGateway(); const disk = new Disk();
    const { svc } = wire(db, gw, disk);
    await runLegacyMediaMigration({ dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup, cutoverProduct: (id) => svc.ensureProductMediaCutover(id) });
    ok(planLegacyMediaCutover(db, SCOPE).alreadyMigrated === 1, 'a finished product is classified already_migrated');

    // Now re-populate legacy on a product that ALREADY has a gallery — the
    // dangerous "both" case. The cutover must import the legacy set and end with
    // exactly that set active, never a hidden mix.
    db.run(`UPDATE products SET images=? WHERE id='p'`, [JSON.stringify([legacyDataUrl('mix-0')])]);
    const plan = planLegacyMediaCutover(db, SCOPE);
    ok(plan.migratable === 1 && plan.items[0].activeLinks === 1, 'a product with gallery AND legacy is planned as migratable');
    const rep = await runLegacyMediaMigration({ dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup, cutoverProduct: (id) => svc.ensureProductMediaCutover(id) });
    ok(rep.migrated === 1 || rep.verifyFailed === 1 || rep.failed === 1, 'the mixed case reaches a definite verdict');
    if (rep.migrated === 1) {
      ok(activeLinks(db, 'p') === 1, 'mixed case converges on exactly the legacy manifest');
      ok(legacyOf(db, 'p') === '[]', 'mixed case clears legacy only after that');
    } else {
      ok(legacyOf(db, 'p') !== '[]', 'mixed case refused → legacy still intact');
    }
  }

  // ── §10 cancel between products ─────────────────────────────────────────
  {
    const db = fresh();
    insertProduct(db, { id: 'a', images: [legacyDataUrl('s0')] });
    insertProduct(db, { id: 'b', images: [legacyDataUrl('s1')] });
    const gw = new FakeGateway(); const disk = new Disk();
    const { svc } = wire(db, gw, disk);
    let n = 0;
    const rep = await runLegacyMediaMigration({
      dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup,
      cutoverProduct: (id) => svc.ensureProductMediaCutover(id),
      shouldStop: () => n++ >= 1,
    });
    ok(rep.migrated === 1, 'cancel stops after the product in flight');
    ok(legacyOf(db, 'b') !== '[]' || legacyOf(db, 'a') !== '[]', 'the un-run product keeps its legacy column');
  }

  // ── §11 the migrated gallery is readable through the real resolver ──────
  {
    const db = fresh();
    insertProduct(db, { id: 'p', images: [legacyDataUrl('r0'), legacyDataUrl('r1')] });
    const gw = new FakeGateway(); const disk = new Disk();
    const { svc } = wire(db, gw, disk);
    await runLegacyMediaMigration({ dbProvider: () => db, scope: SCOPE, requireBackup: haveBackup, cutoverProduct: (id) => svc.ensureProductMediaCutover(id) });
    const resolved = await new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }).resolveProductMedia('p');
    ok(resolved.kind === 'media', `the migrated product resolves as durable media, not legacy (${resolved.kind})`);
    ok(resolved.kind === 'media' && resolved.items.length === 2, 'both images are readable after migration');
    const bytes = decodeDataUrl(legacyDataUrl('r0')).bytes;
    ok(bytes.length === 32, 'the decoder still yields the original payload size');
  }

  console.log(`\nlegacy-media-migration: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
