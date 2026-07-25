// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2B-R4 — restart reconciliation hardening
// Run: node test/media04a3b2br4/reconciliation.test.ts
//
// REAL sql.js + REAL orchestrator/coordinator/resolver; a fake gateway records
// prepare/commit. No productive DB, no Tauri, no base64/product-id logged.
//
// Covers the R4 deltas:
//   • recovery error → same-epoch retry succeeds
//   • concurrent triggers → a single recovery run (shared in-flight)
//   • recovery before store hook → later reconciliation finds the scope
//   • crash before embedding → next start finds the scope
//   • scope A cannot embed scope B's product (reconcile returns owning scope)
//   • pending create → skeleton; pending replace + valid gallery → gallery
//   • corrupt / contradictory batch intent → conflict
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
import { MediaDbCoordinator, classifyPendingIngest, type ReplaceInput } from '../../src/core/media/coordinator.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import { findProductsNeedingEmbedding } from '../../src/core/media/embedding-reconcile.ts';
import {
  runStartupMediaRecovery,
  __resetStartupRecoveryForTests,
  type CompletedProductScope,
} from '../../src/core/media/startup-recovery.ts';
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

class Disk { image: Uint8Array | null = null; writes = 0; }
function leaseFor(db: OrchestratorRawDb, disk: Disk): OrchestratorLease {
  return { db, epoch: 0, async saveDurably() { disk.writes++; disk.image = (db as unknown as { export(): Uint8Array }).export(); }, release() {} };
}
function seed(db: any): void {
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`); db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`); db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`ALTER TABLE products ADD COLUMN image_embedding TEXT`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t2')`);
  db.run(`INSERT INTO products (id, branch_id, images) VALUES ('p1','b1','[]')`);
  db.run(`INSERT INTO products (id, branch_id, images) VALUES ('p2','b2','[]')`);
}
const ROLE = 'stock_image';
function itemFor(tenant: string, branch: string, pid: string, i: number, n: number): IngestAndFinalizeInput {
  const bytes = dataBytes(`${tenant}-${pid}-${i}`);
  return { tenantId: tenant, branchId: branch, entityType: 'product', entityId: pid, scopeKind: 'branch', role: ROLE,
    ingestRequestId: `create:${tenant}:${branch}:${pid}:${ROLE}:${i}`, requestHash: sha256Hex(bytes), isPrimary: i === 0, sortOrder: i,
    imageBytes: bytes, batch: { batchId: `create:${tenant}:${branch}:${pid}:${ROLE}`, expectedCount: n } };
}
function resolverFor(db: any, gw: FakeGateway, tenant = 't1', branch = 'b1') { return new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: tenant, branchId: branch }); }
async function createBatch(db: any, gw: FakeGateway, disk: Disk, tenant: string, branch: string, pid: string, n: number): Promise<void> {
  const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
  const items = Array.from({ length: n }, (_, i) => itemFor(tenant, branch, pid, i, n));
  await orch.prepareAndRegisterBatch(items);
  await orch.finalizeBatch(items);
}
function primaryLinkId(db: any, pid: string): string {
  const r = db.exec(`SELECT link_id FROM media_links WHERE entity_id=? AND is_primary=1 AND deleted_at IS NULL`, [pid]);
  return String(r[0].values[0][0]);
}
function insertRawJob(db: any, pid: string, irid: string, resultJson: string): void {
  db.run(
    `INSERT INTO media_ingest_jobs
       (tenant_id, job_id, ingest_request_id, request_hash, scope_kind, branch_id,
        requested_entity_type, requested_entity_id, requested_role,
        security_class, retention_class, transform_profile,
        result_json, state, attempt_count, created_at, started_at, updated_at)
     VALUES ('t1',?,?, ?, 'branch','b1','product',?, ?, 'internal','standard','stock_image', ?, 'accepted', 0, 'now','now','now')`,
    [`job-${irid}`, irid, '0'.repeat(64), pid, ROLE, resultJson],
  );
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 recovery error → same-epoch retry succeeds ──────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    // A create-batch left half-published (slot 1 fails), so recovery has work.
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:1`;
    await createBatch(db, gw, disk, 't1', 'b1', 'p1', 3).catch(() => {});
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
    __resetStartupRecoveryForTests();
    let epoch = 3, fail = true;
    const recover = async () => { if (fail) throw new Error('boom'); return orch.recoverPendingStockMedia(); };
    const first = await runStartupMediaRecovery({ currentEpoch: () => epoch, recover, log: () => {} });
    ok(first === 'error', 'first pass fails → error');
    ok((await resolverFor(db, gw).resolveProductMedia('p1')).kind === 'pending', 'still pending after failed pass');
    // Same epoch, fault cleared → the retry actually runs and succeeds.
    fail = false; gw.commitShouldThrowFor = null;
    const second = await runStartupMediaRecovery({ currentEpoch: () => epoch, recover, log: () => {} });
    ok(second === 'ran', 'same-epoch retry runs and succeeds (not skipped)');
    const after = await resolverFor(db, gw).resolveProductMedia('p1');
    ok(after.kind === 'media' && after.items.length === 3, 'retry converged the gallery to full media');
    // A THIRD call in the same epoch is now a memoised no-op.
    ok((await runStartupMediaRecovery({ currentEpoch: () => epoch, recover })) === 'skipped', 'success memoised → later call skipped');
  }

  // ── §2 concurrent triggers → one recovery run (shared in-flight) ───────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
    __resetStartupRecoveryForTests();
    let runs = 0; const epoch = 9;
    const recover = async () => { runs++; await Promise.resolve(); return orch.recoverPendingStockMedia(); };
    const [a, b] = await Promise.all([
      runStartupMediaRecovery({ currentEpoch: () => epoch, recover }),
      runStartupMediaRecovery({ currentEpoch: () => epoch, recover }),
    ]);
    ok(a === 'ran' && b === 'ran', 'both concurrent triggers resolve ran');
    ok(runs === 1, 'concurrent triggers share ONE recovery run');
  }

  // ── §3/§4 complete gallery + NULL embedding → reconciliation candidate ──
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await createBatch(db, gw, disk, 't1', 'b1', 'p1', 2); // fully created, all ready
    // §3: recovery may have run before any store hook — the DB scan still finds
    // the product whose embedding was never computed.
    let cand = findProductsNeedingEmbedding(db);
    ok(cand.length === 1 && cand[0].productId === 'p1' && cand[0].tenantId === 't1' && cand[0].branchId === 'b1' && cand[0].role === ROLE, 'complete gallery + NULL embedding → candidate with owning scope');
    // §4: once the embedding exists, it is no longer a candidate (at-most-once).
    db.run(`UPDATE products SET image_embedding = '[0.1,0.2]' WHERE id='p1'`);
    cand = findProductsNeedingEmbedding(db);
    ok(cand.length === 0, 'embedding present → not a candidate again');
    // A pending ingest (incomplete batch) is NOT a candidate — wait for settle.
    db.run(`UPDATE products SET image_embedding = NULL WHERE id='p1'`);
    insertRawJob(db, 'p1', `pending:x`, JSON.stringify({ kind: 'intent', intentVersion: 3, operation: 'append', main: {}, thumbnail: {}, linkIntent: { isPrimary: false, sortOrder: 2 }, batch: { batchId: 'x', expectedCount: 3 } }));
    ok(findProductsNeedingEmbedding(db).length === 0, 'pending ingest → not yet a candidate');
  }

  // ── §5 scope isolation: each product returned with its OWN scope ───────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await createBatch(db, gw, disk, 't1', 'b1', 'p1', 1);
    await createBatch(db, gw, disk, 't2', 'b2', 'p2', 1);
    const cand = findProductsNeedingEmbedding(db);
    const s1 = cand.find((c) => c.productId === 'p1');
    const s2 = cand.find((c) => c.productId === 'p2');
    ok(!!s1 && s1.tenantId === 't1' && s1.branchId === 'b1', 'p1 returned under t1/b1');
    ok(!!s2 && s2.tenantId === 't2' && s2.branchId === 'b2', 'p2 returned under t2/b2 (never t1/b1)');
    // A resolver bound to scope A cannot see scope B's gallery at all.
    const wrongScope = await resolverFor(db, gw, 't1', 'b1').resolveProductMedia('p2');
    ok(wrongScope.kind !== 'media', `scope A cannot resolve scope B's media (got ${wrongScope.kind})`);
    const rightScope = await resolverFor(db, gw, 't2', 'b2').resolveProductMedia('p2');
    ok(rightScope.kind === 'media', 'scope B resolves its own media');
  }

  // ── §6 pending create → skeleton (pending) ─────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:1`; // slot 0 ok, 1 fails
    await createBatch(db, gw, disk, 't1', 'b1', 'p1', 3).catch(() => {});
    ok((await resolverFor(db, gw).resolveProductMedia('p1')).kind === 'pending', 'in-flight create batch → pending skeleton');
  }

  // ── §7 pending REPLACE + valid gallery → gallery stays visible ─────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await createBatch(db, gw, disk, 't1', 'b1', 'p1', 2); // complete gallery
    const prevLink = primaryLinkId(db, 'p1');
    // Register (but do NOT finalize) a durable replace intent → a non-terminal
    // job with operation:'replace' exists.
    const coord = new MediaDbCoordinator(db, gw);
    const rbytes = dataBytes('replace-p1-0');
    const rInput: ReplaceInput = { tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p1', scopeKind: 'branch', role: ROLE, ingestRequestId: 'replace:t1:b1:p1:0', requestHash: sha256Hex(rbytes), previousLinkId: prevLink };
    const prep = await gw.prepareStockImage({ tenantScope: 't1', ingestRequestId: rInput.ingestRequestId, requestHash: rInput.requestHash, imageBytes: rbytes });
    coord.registerPendingReplaceIntent(rInput, prep);
    const res = await resolverFor(db, gw).resolveProductMedia('p1');
    ok(res.kind === 'media' && res.items.length === 2, `pending replace does NOT hide the gallery (got ${res.kind})`);
  }

  // ── §8 corrupt / contradictory create-batch intent → conflict ──────────
  {
    // Unit: two different batchIds on one scope → contradiction.
    const contradiction = classifyPendingIngest([
      JSON.stringify({ kind: 'intent', intentVersion: 3, operation: 'append', main: {}, thumbnail: {}, linkIntent: { isPrimary: true, sortOrder: 0 }, batch: { batchId: 'A', expectedCount: 2 } }),
      JSON.stringify({ kind: 'intent', intentVersion: 3, operation: 'append', main: {}, thumbnail: {}, linkIntent: { isPrimary: false, sortOrder: 1 }, batch: { batchId: 'B', expectedCount: 2 } }),
    ]);
    ok(contradiction.kind === 'conflict', 'two contradictory batches → conflict');
    const corrupt = classifyPendingIngest(['{ this is not json']);
    ok(corrupt.kind === 'conflict', 'corrupt intent → conflict');
    const replaceOnly = classifyPendingIngest([JSON.stringify({ kind: 'intent', intentVersion: 3, operation: 'replace', previousLinkId: 'L1', main: {}, thumbnail: {}, linkIntent: { isPrimary: true, sortOrder: 0 } })]);
    ok(replaceOnly.kind === 'none', 'pending replace alone → none (never pends the gallery)');

    // Resolver-level: contradictory create batches surface as conflict.
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway();
    insertRawJob(db, 'p1', 'jA', JSON.stringify({ kind: 'intent', intentVersion: 3, operation: 'append', main: {}, thumbnail: {}, linkIntent: { isPrimary: true, sortOrder: 0 }, batch: { batchId: 'A', expectedCount: 2 } }));
    insertRawJob(db, 'p1', 'jB', JSON.stringify({ kind: 'intent', intentVersion: 3, operation: 'append', main: {}, thumbnail: {}, linkIntent: { isPrimary: false, sortOrder: 1 }, batch: { batchId: 'B', expectedCount: 2 } }));
    const res = await resolverFor(db, gw).resolveProductMedia('p1');
    ok(res.kind === 'conflict', `contradictory create batches → resolver conflict (got ${res.kind})`);
  }

  // ══════════════════════════════════════════════════════════════════════
  void ({} as CompletedProductScope); // type kept in scope
  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2B-R4 reconciliation: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   • ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2B-R4 reconciliation: ${PASS}/${PASS} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
