// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2B-R3 — atomic batch visibility + startup recovery
// Run: node test/media04a3b2br3/recovery-visibility.test.ts
//
// REAL sql.js + REAL orchestrator/coordinator/resolver; a fake gateway records
// prepare/commit/abort. An explicit "disk" (exported image) models a crash.
// No productive DB, no Tauri, no base64 logged.
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
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import { presentationSrcs, isResolvingMedia } from '../../src/core/media/presentation.ts';
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
  commitShouldThrowFor: string | null = null; // ingestRequestId, or 'ALL'
  prepareShouldThrowFor: string | null = null;
  readonly aborts: string[] = [];
  readonly commits: string[] = [];
  private rend(scope: string, input: Uint8Array) {
    const h = sha256Hex(input); let r = this.byHash.get(h);
    if (!r) { r = { main: sha256Hex(concat(input, new Uint8Array([1]))), thumb: sha256Hex(concat(input, new Uint8Array([2]))), mainB: concat(input, new Uint8Array([0xaa])), thumbB: concat(input, new Uint8Array([0xbb])) }; this.byHash.set(h, r); }
    this.files.set(`${scope}::${r.main}`, { bytes: r.mainB, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${r.thumb}`, { bytes: r.thumbB, mime: 'image/jpeg', ext: 'jpg' });
    return r;
  }
  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    if (this.prepareShouldThrowFor === i.ingestRequestId || this.prepareShouldThrowFor === 'ALL') throw new Error('PREPARE_FAIL');
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
  db.run(`INSERT INTO tenants (id) VALUES ('t1')`); db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1')`);
  db.run(`INSERT INTO products (id, branch_id, images) VALUES ('p1','b1','[]')`);
}
function reopen(SQL: any, disk: Disk) { if (!disk.image) throw new Error('nothing persisted'); return new SQL.Database(disk.image); }
const ROLE = 'stock_image';
function itemFor(pid: string, i: number, n: number): IngestAndFinalizeInput {
  const bytes = dataBytes(`${pid}-${i}`);
  return { tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: pid, scopeKind: 'branch', role: ROLE,
    ingestRequestId: `create:t1:b1:${pid}:${ROLE}:${i}`, requestHash: sha256Hex(bytes), isPrimary: i === 0, sortOrder: i,
    imageBytes: bytes, batch: { batchId: `create:t1:b1:${pid}:${ROLE}`, expectedCount: n } };
}
function resolverFor(db: any, gw: FakeGateway) { return new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }); }
function activeLinks(db: any, pid: string): number { const r = db.exec(`SELECT COUNT(*) FROM media_links WHERE entity_id=? AND deleted_at IS NULL`, [pid]); return r.length ? Number(r[0].values[0][0]) : 0; }

/** Run a create batch (register+cp1, then finalize per slot). Returns after
 *  finalize throws or completes. */
async function createBatch(db: any, gw: FakeGateway, disk: Disk, pid: string, n: number): Promise<'created' | 'partial'> {
  const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
  const items = Array.from({ length: n }, (_, i) => itemFor(pid, i, n));
  await orch.prepareAndRegisterBatch(items);
  try { await orch.finalizeBatch(items); return 'created'; } catch { return 'partial'; }
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 crash after slot 0/3 → resolver pending, NOT a 1-image gallery ──
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:1`; // slot 0 ok, slot 1 fails
    const r = await createBatch(db, gw, disk, 'p1', 3);
    ok(r === 'partial', 'batch partial at slot 1');
    ok(activeLinks(db, 'p1') === 1, '1 link durable (slot 0)');
    const res = await resolverFor(db, gw).resolveProductMedia('p1');
    ok(res.kind === 'pending', `partial batch → pending, not partial media (got ${res.kind})`);
  }

  // ── §2 crash BEFORE any publish → pending (0 links, 3 accepted) ────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    gw.commitShouldThrowFor = 'ALL';
    await createBatch(db, gw, disk, 'p1', 3);
    ok(activeLinks(db, 'p1') === 0, 'no links yet');
    const res = await resolverFor(db, gw).resolveProductMedia('p1');
    ok(res.kind === 'pending', `pre-publish batch → pending (got ${res.kind})`);
  }

  // ── §3 crash after slot 1/3 → pending; startup-recovery → media 0,1,2 ─
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:2`; // slots 0,1 ok, slot 2 fails
    await createBatch(db, gw, disk, 'p1', 3);
    ok(activeLinks(db, 'p1') === 2, '2 links durable');
    const db2 = reopen(SQL, disk);
    ok((await resolverFor(db2, gw).resolveProductMedia('p1')).kind === 'pending', 'reopen: pending, not partial');
    // Startup recovery via the runner (once per epoch).
    gw.commitShouldThrowFor = null;
    const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db2, disk2) });
    __resetStartupRecoveryForTests();
    let epoch = 7;
    const completed: CompletedProductScope[][] = [];
    const rr = await runStartupMediaRecovery({ currentEpoch: () => epoch, recover: () => orch2.recoverPendingStockMedia(), onCompletedProducts: (s) => completed.push(s) });
    ok(rr === 'ran', 'startup recovery ran');
    const after = await resolverFor(db2, gw).resolveProductMedia('p1');
    ok(after.kind === 'media' && after.items.length === 3, `recovery flips pending → full media (got ${after.kind})`);
    ok(after.kind === 'media' && after.items.map((i) => i.sortOrder).join(',') === '0,1,2', 'order 0,1,2');
    // Completed product reported exactly once for the embedding guard.
    ok(completed.length === 1 && completed[0].some((c) => c.productId === 'p1'), 'completed product reported to embedding hook once');
  }

  // ── §4 once per DB epoch; repeat is an idempotent no-op ────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
    __resetStartupRecoveryForTests();
    let runs = 0; let epoch = 1;
    const recover = async () => { runs++; return orch.recoverPendingStockMedia(); };
    const a = await runStartupMediaRecovery({ currentEpoch: () => epoch, recover });
    const b = await runStartupMediaRecovery({ currentEpoch: () => epoch, recover });
    ok(a === 'ran' && b === 'skipped', 'second call same epoch → skipped');
    ok(runs === 1, 'recover invoked exactly once per epoch');
    epoch = 2; // a reload bumps the epoch → re-arms
    const c = await runStartupMediaRecovery({ currentEpoch: () => epoch, recover });
    ok(c === 'ran' && runs === 2, 'new epoch re-runs recovery');
  }

  // ── §5 recovery error → non-blocking 'error', no partial gallery ──────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:1`;
    await createBatch(db, gw, disk, 'p1', 3);
    __resetStartupRecoveryForTests();
    let epoch = 5; let threw = false;
    const rr = await runStartupMediaRecovery({ currentEpoch: () => epoch, recover: async () => { throw new Error('boom'); }, log: () => {} }).catch(() => { threw = true; return 'error' as const; });
    ok(!threw && rr === 'error', 'recovery error is swallowed, returns error');
    // Resolver still pending — never a partial gallery on a failed recovery.
    ok((await resolverFor(db, gw).resolveProductMedia('p1')).kind === 'pending', 'still pending after failed recovery');
    // R4: a failed epoch is NOT permanently skipped — the next explicit trigger
    // retries it (still 'error' while the fault persists), and each trigger runs
    // recovery exactly once (no tight auto-loop, no permanent block).
    let retryCalls = 0;
    const again = await runStartupMediaRecovery({ currentEpoch: () => epoch, recover: async () => { retryCalls++; throw new Error('boom'); }, log: () => {} });
    ok(again === 'error' && retryCalls === 1, 'failed epoch retries on next trigger (not skipped), one run per call');
  }

  // ── §6 missing/duplicate batch slot → conflict, not partial ───────────
  {
    // All 3 jobs ready but a link's sort_order duplicated → inspectGallery conflict.
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await createBatch(db, gw, disk, 'p1', 3); // fully created (all ready)
    ok(activeLinks(db, 'p1') === 3, 'all 3 published');
    db.run(`UPDATE media_links SET sort_order = 0 WHERE entity_id='p1' AND sort_order=2`); // duplicate slot 0
    const res = await resolverFor(db, gw).resolveProductMedia('p1');
    ok(res.kind === 'conflict', `duplicate slot → conflict (got ${res.kind})`);
  }

  // ── §7 prepare fails before cp1 → full cleanup, prepared aborted ──────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
    const items = Array.from({ length: 3 }, (_, i) => itemFor('p1', i, 3));
    gw.prepareShouldThrowFor = `create:t1:b1:p1:${ROLE}:2`; // slots 0,1 prepared, slot 2 fails
    let threw = false;
    try { await orch.prepareAndRegisterBatch(items); } catch { threw = true; }
    ok(threw, 'prepareAndRegisterBatch throws on prepare failure');
    // The two already-prepared Rust requests were aborted (no orphan journals).
    ok(gw.aborts.includes(`create:t1:b1:p1:${ROLE}:0`) && gw.aborts.includes(`create:t1:b1:p1:${ROLE}:1`), 'prepared requests aborted');
    ok(disk.image === null, 'nothing durable (no checkpoint)');
    // Jobs were registered in-memory but never durable — a reopen sees none.
    ok(gw.commits.length === 0, 'no publish');
  }

  // ── §8 cp1 save fails → prepared aborted, no durable batch ────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    disk.failOnWrite = 1; // the cp1 durable save fails
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
    const items = Array.from({ length: 2 }, (_, i) => itemFor('p1', i, 2));
    let threw = false;
    try { await orch.prepareAndRegisterBatch(items); } catch { threw = true; }
    ok(threw, 'cp1 failure surfaces');
    ok(gw.aborts.length === 2, 'both prepared requests aborted after cp1 failure');
    ok(disk.image === null, 'no durable batch');
  }

  // ── §9 successful batch → NO abort (intents committed) ────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await createBatch(db, gw, disk, 'p1', 2);
    ok(gw.aborts.length === 0, 'a durable batch never aborts its prepared requests');
    ok(activeLinks(db, 'p1') === 2, 'both slots published');
    ok((await resolverFor(db, gw).resolveProductMedia('p1')).kind === 'media', 'complete → media');
  }

  // ── §10 presentation selectors: pending → skeleton, no srcs ───────────
  {
    const pending = { status: 'pending' as const, srcs: [] as [] };
    ok(presentationSrcs(pending).length === 0, 'presentationSrcs(pending) = [] (never a partial gallery)');
    ok(isResolvingMedia(pending, true) === true, 'pending shows a skeleton (isResolvingMedia)');
    ok(isResolvingMedia(pending, false) === false, 'no skeleton without an authorised key');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2B-R3 recovery-visibility: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   • ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2B-R3 recovery-visibility: ${PASS}/${PASS} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
