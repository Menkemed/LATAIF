// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2B-R5 — durable product-insert side effects
// Run: node test/media04a3b2br5/insert-durability.test.ts
//
// REAL sql.js + REAL orchestrator/coordinator/resolver + the REAL create core.
// A fake gateway records prepare/commit; an explicit "disk" (exported image)
// models a crash. The durable insert record (sync_changelog + audit_log) is
// modelled with real tables so we can prove it is part of checkpoint 1.
// No productive DB, no Tauri, no base64/product-id logged.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { createHash } from 'node:crypto';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import {
  StockMediaOrchestrator,
  type OrchestratorLease,
  type OrchestratorRawDb,
  type IngestAndFinalizeInput,
} from '../../src/core/media/orchestrator.ts';
import { createProductWithDurableMedia, type CreateProductMediaDeps } from '../../src/core/media/product-media-create.ts';
import type { DecodedLegacyImage } from '../../src/core/media/product-media-cutover.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import { runStartupMediaRecovery, __resetStartupRecoveryForTests } from '../../src/core/media/startup-recovery.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

function dataBytes(seed: string): Uint8Array { const b = new Uint8Array(24); for (let i = 0; i < 24; i++) b[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff; return b; }
function sha256Hex(b: Uint8Array): string { return createHash('sha256').update(Buffer.from(b)).digest('hex'); }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainB: Uint8Array; thumbB: Uint8Array }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  private reqBytes = new Map<string, Uint8Array>();
  commitShouldThrowFor: string | null = null;
  readonly commits: string[] = [];
  readonly aborts: string[] = [];
  private rend(scope: string, input: Uint8Array) {
    const h = sha256Hex(input); let r = this.byHash.get(h);
    if (!r) { r = { main: sha256Hex(concat(input, new Uint8Array([1]))), thumb: sha256Hex(concat(input, new Uint8Array([2]))), mainB: concat(input, new Uint8Array([0xaa])), thumbB: concat(input, new Uint8Array([0xbb])) }; this.byHash.set(h, r); }
    this.files.set(`${scope}::${r.main}`, { bytes: r.mainB, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${r.thumb}`, { bytes: r.thumbB, mime: 'image/jpeg', ext: 'jpg' });
    return r;
  }
  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    this.reqBytes.set(`${i.tenantScope}::${i.ingestRequestId}`, i.imageBytes);
    const r = this.rend(i.tenantScope, i.imageBytes);
    return { ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared', main_descriptor: desc(r.main, r.mainB.length), thumbnail_descriptor: desc(r.thumb, r.thumbB.length) };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    this.commits.push(i.ingestRequestId);
    if (this.commitShouldThrowFor === i.ingestRequestId || this.commitShouldThrowFor === 'ALL') throw new Error('MEDIA_INGEST_NOT_FOUND');
    const bytes = this.reqBytes.get(`${i.tenantScope}::${i.ingestRequestId}`); if (!bytes) throw new Error('MEDIA_INGEST_NOT_FOUND');
    const r = this.rend(i.tenantScope, bytes);
    return { state: 'published', main_descriptor: desc(r.main, r.mainB.length), thumbnail_descriptor: desc(r.thumb, r.thumbB.length), main_storage_key: `${i.tenantScope}/${r.main.slice(0, 2)}/${r.main}.jpg`, thumbnail_storage_key: `${i.tenantScope}/${r.thumb.slice(0, 2)}/${r.thumb}.jpg` };
  }
  async abortStockImage(i: AbortInput): Promise<AbortResult> { this.aborts.push(i.ingestRequestId); return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> { const f = this.files.get(`${i.tenantScope}::${i.hash}`); if (!f) throw new Error('MEDIA_FILE_MISSING'); return { bytes: f.bytes, hash: i.hash, byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext }; }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}
function desc(hash: string, size: number) { return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 800, height: 600 }; }

class Disk { image: Uint8Array | null = null; writes = 0; failOnWrite: number | null = null; }
function leaseFor(db: OrchestratorRawDb, disk: Disk): OrchestratorLease {
  return { db, epoch: 0, async saveDurably() { disk.writes++; if (disk.failOnWrite !== null && disk.writes === disk.failOnWrite) throw new Error('DISK_FULL'); disk.image = (db as unknown as { export(): Uint8Array }).export(); }, release() {} };
}
function seed(db: any): void {
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`); db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`); db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`ALTER TABLE products ADD COLUMN image_embedding TEXT`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, action TEXT, data TEXT, synced INTEGER, created_at TEXT)`);
  db.run(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, action_type TEXT)`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t2')`);
}
function reopen(SQL: any, disk: Disk) { if (!disk.image) throw new Error('nothing persisted'); return new SQL.Database(disk.image); }
const ROLE = 'stock_image';
function count(db: any, sql: string, params: unknown[] = []): number { const r = db.exec(sql, params); return r.length ? Number(r[0].values[0][0]) : 0; }

/** Build the store-equivalent deps around a real orchestrator, with a durable
 *  insert record written to real sync_changelog + audit_log tables. */
function makeDeps(db: any, gw: FakeGateway, disk: Disk, tenant: string, branch: string, images: Uint8Array[], calls: { inserted: number; fullSuccess: number }): CreateProductMediaDeps {
  const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
  const batchIdFor = (pid: string) => `create:${tenant}:${branch}:${pid}:${ROLE}`;
  return {
    productExists: (pid) => count(db, `SELECT COUNT(*) FROM products WHERE id=?`, [pid]) > 0,
    insertProductRow: (pid) => { db.run(`INSERT INTO products (id, branch_id, images) VALUES (?,?, '[]')`, [pid, branch]); },
    recordDurableInsert: (pid) => {
      db.run(`INSERT INTO sync_changelog (table_name, record_id, action, data, synced, created_at) VALUES ('products', ?, 'insert', '{}', 0, 'now')`, [pid]);
      db.run(`INSERT INTO audit_log (id, entity_type, entity_id, action_type) VALUES (?, 'products', ?, 'CREATE')`, [`aud-${pid}`, pid]);
    },
    rollbackProductRow: (pid) => {
      db.run(`DELETE FROM products WHERE id=?`, [pid]);
      db.run(`DELETE FROM media_ingest_jobs WHERE requested_entity_id=? AND requested_role=? AND tenant_id=? AND branch_id=?`, [pid, ROLE, tenant, branch]);
      db.run(`DELETE FROM sync_changelog WHERE table_name='products' AND record_id=?`, [pid]);
      db.run(`DELETE FROM audit_log WHERE entity_type='products' AND entity_id=?`, [pid]);
    },
    saveDurably: async () => { await leaseFor(db, disk).saveDurably(); },
    buildBatchItems: async (pid, decoded: DecodedLegacyImage[]) => {
      const items: IngestAndFinalizeInput[] = [];
      for (let i = 0; i < decoded.length; i++) {
        items.push({ tenantId: tenant, branchId: branch, entityType: 'product', entityId: pid, scopeKind: 'branch', role: ROLE,
          ingestRequestId: `${batchIdFor(pid)}:${i}`, requestHash: sha256Hex(decoded[i].bytes), isPrimary: i === 0, sortOrder: i,
          imageBytes: decoded[i].bytes, batch: { batchId: batchIdFor(pid), expectedCount: decoded.length } });
      }
      return items;
    },
    prepareAndRegisterBatch: (items) => orch.prepareAndRegisterBatch(items as IngestAndFinalizeInput[]),
    finalizeBatch: (items) => orch.finalizeBatch(items as IngestAndFinalizeInput[]),
    onProductInserted: () => { calls.inserted++; },
    onFullSuccess: () => { calls.fullSuccess++; },
    decode: (src: string) => ({ bytes: images[Number(src)], mimeType: 'image/jpeg' }),
  };
}
function urls(n: number): string[] { return Array.from({ length: n }, (_, i) => String(i)); }
function imgs(pid: string, n: number): Uint8Array[] { return Array.from({ length: n }, (_, i) => dataBytes(`${pid}-${i}`)); }
function resolverFor(db: any, gw: FakeGateway, tenant = 't1', branch = 'b1') { return new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: tenant, branchId: branch }); }

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 crash after cp1, before publish → reopen: product + exactly ONE ─
  //     changelog + audit, 0 links; recovery finishes images ─────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    gw.commitShouldThrowFor = 'ALL'; // every publish fails → crash right after cp1
    const calls = { inserted: 0, fullSuccess: 0 };
    const images = imgs('p1', 3);
    const res = await createProductWithDurableMedia('p1', { kind: 'data_urls', images: urls(3) }, makeDeps(db, gw, disk, 't1', 'b1', images, calls));
    ok(res.status === 'media_incomplete', `publish failure → media_incomplete (got ${res.status})`);
    ok(calls.fullSuccess === 0, 'no full-success side effect on an incomplete create');
    // The DURABLE snapshot (cp1) is on disk: reopen and inspect it alone.
    const db2 = reopen(SQL, disk);
    ok(count(db2, `SELECT COUNT(*) FROM products WHERE id='p1'`) === 1, 'reopen: product fully findable');
    ok(count(db2, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'reopen: exactly ONE sync changelog row (part of cp1)');
    ok(count(db2, `SELECT COUNT(*) FROM audit_log WHERE entity_id='p1'`) === 1, 'reopen: exactly ONE audit row (part of cp1)');
    ok(count(db2, `SELECT COUNT(*) FROM media_ingest_jobs WHERE requested_entity_id='p1'`) === 3, 'reopen: 3 batch intents durable');
    ok(count(db2, `SELECT COUNT(*) FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`) === 0, 'reopen: 0 links (nothing published)');
    ok((await resolverFor(db2, gw).resolveProductMedia('p1')).kind === 'pending', 'reopen: resolver shows pending, never partial');
    // Startup recovery (now publishes) completes the images.
    gw.commitShouldThrowFor = null;
    const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db2, disk2) });
    __resetStartupRecoveryForTests();
    const rr = await runStartupMediaRecovery({ currentEpoch: () => 1, recover: () => orch2.recoverPendingStockMedia() });
    ok(rr === 'ran', 'startup recovery ran');
    const after = await resolverFor(db2, gw).resolveProductMedia('p1');
    ok(after.kind === 'media' && after.items.length === 3, 'recovery completed the gallery');
    ok(count(db2, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'recovery did NOT add a second changelog');
  }

  // ── §2 retry after the crash → no duplicate product / changelog ────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    gw.commitShouldThrowFor = 'ALL';
    const images = imgs('p1', 2);
    await createProductWithDurableMedia('p1', { kind: 'data_urls', images: urls(2) }, makeDeps(db, gw, disk, 't1', 'b1', images, { inserted: 0, fullSuccess: 0 }));
    // Reopen at the cp1 snapshot and RETRY the same id (retryProductId path).
    const db2 = reopen(SQL, disk);
    const disk2 = new Disk(); disk2.image = db2.export();
    gw.commitShouldThrowFor = null;
    const calls = { inserted: 0, fullSuccess: 0 };
    const res = await createProductWithDurableMedia('p1', { kind: 'data_urls', images: urls(2) }, makeDeps(db2, gw, disk2, 't1', 'b1', images, calls));
    ok(res.status === 'created', `retry completes → created (got ${res.status})`);
    ok(count(db2, `SELECT COUNT(*) FROM products WHERE id='p1'`) === 1, 'retry: still exactly ONE product');
    ok(count(db2, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'retry: still exactly ONE changelog (recordDurableInsert not re-run)');
    ok(count(db2, `SELECT COUNT(*) FROM audit_log WHERE entity_id='p1'`) === 1, 'retry: still exactly ONE audit row');
    ok(calls.inserted === 0, 'retry: onProductInserted (transient) not re-fired for an existing row');
  }

  // ── §3 first save (cp1) fails → FULL rollback, no residue, no publish ──
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    disk.failOnWrite = 1; // the cp1 durable save throws
    const calls = { inserted: 0, fullSuccess: 0 };
    const images = imgs('p1', 2);
    const res = await createProductWithDurableMedia('p1', { kind: 'data_urls', images: urls(2) }, makeDeps(db, gw, disk, 't1', 'b1', images, calls));
    ok(res.status === 'product_save_failed', `cp1 failure → product_save_failed (got ${res.status})`);
    ok(count(db, `SELECT COUNT(*) FROM products WHERE id='p1'`) === 0, 'rollback: no product row');
    ok(count(db, `SELECT COUNT(*) FROM media_ingest_jobs WHERE requested_entity_id='p1'`) === 0, 'rollback: no ingest jobs');
    ok(count(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 0, 'rollback: no changelog residue');
    ok(count(db, `SELECT COUNT(*) FROM audit_log WHERE entity_id='p1'`) === 0, 'rollback: no audit residue');
    ok(disk.image === null, 'rollback: nothing durable on disk');
    ok(calls.inserted === 0 && calls.fullSuccess === 0, 'rollback: no transient event / embedding');
    ok(gw.commits.length === 0, 'rollback: nothing published');
  }

  // ── §4 startup recovery uses JOB-frozen scope, not any session ─────────
  //     (create in t2/b2, crash before publish, recover → completes t2/b2)─
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    gw.commitShouldThrowFor = 'ALL';
    const images = imgs('p2', 2);
    await createProductWithDurableMedia('p2', { kind: 'data_urls', images: urls(2) }, makeDeps(db, gw, disk, 't2', 'b2', images, { inserted: 0, fullSuccess: 0 }));
    const db2 = reopen(SQL, disk);
    gw.commitShouldThrowFor = null;
    const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db2, disk2) });
    const rec = await orch2.recoverPendingStockMedia();
    const scope = rec.completedProductIds.find((s) => s.productId === 'p2');
    ok(!!scope && scope.tenantId === 't2' && scope.branchId === 'b2' && scope.role === ROLE, 'recovery reports the JOB-frozen scope t2/b2 (independent of session)');
    // And it resolves as media ONLY under its own scope.
    ok((await resolverFor(db2, gw, 't2', 'b2').resolveProductMedia('p2')).kind === 'media', 't2/b2 gallery complete after recovery');
    ok((await resolverFor(db2, gw, 't1', 'b1').resolveProductMedia('p2')).kind !== 'media', 'foreign scope cannot see t2/b2 media');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2B-R5 insert-durability: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   • ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2B-R5 insert-durability: ${PASS}/${PASS} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
