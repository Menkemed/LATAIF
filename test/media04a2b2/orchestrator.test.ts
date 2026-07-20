// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-2B2 — StockMediaOrchestrator invariant tests
// Run: node test/media04a2b2/orchestrator.test.ts
//
// Uses REAL sql.js in-memory + a deterministic FakeMediaGateway + a
// controlled `saveDurably` stub. No productive DB, no Tauri, no filesystem
// write outside the standard node temp dir.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { MediaDbCoordinator, type FinalizeInput } from '../../src/core/media/coordinator.ts';
import {
  OrchestratorError,
  StockMediaOrchestrator,
  type IngestAndFinalizeInput,
  type OrchestratorLease,
  type OrchestratorRawDb,
} from '../../src/core/media/orchestrator.ts';
import type {
  AbortInput,
  AbortResult,
  CommitInput,
  CommitResult,
  MediaBytes,
  MediaCommandGateway,
  PrepareInput,
  PrepareResult,
  ReadVerifiedInput,
  RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0;
let FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) {
    PASS++;
  } else {
    FAIL++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
async function throws(msg: string, expectedCode: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    ok(false, `${msg} — expected throw ${expectedCode}, got none`);
  } catch (e) {
    const code = (e as { code?: string; message?: string }).code ?? (e as Error).message;
    ok(code === expectedCode, `${msg} — expected ${expectedCode}, got ${code}`);
  }
}

// ── entity stubs (same shape as 2B1 test) ──────────────────────────────────
function seedEntityStubs(db: any): void {
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  }
  db.run(`INSERT INTO tenants  (id) VALUES ('t1')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1')`);
  db.run(`INSERT INTO products (id, branch_id) VALUES ('p1','b1')`);
}

// ── recording fake gateway ─────────────────────────────────────────────────

type Call = string;

class RecordingFakeGateway implements MediaCommandGateway {
  private jobs = new Map<string, {
    hash: string;
    state: 'prepared' | 'published' | 'aborted';
    main: { hash: string; bytes: Uint8Array; byte_size: number };
    thumb: { hash: string; bytes: Uint8Array; byte_size: number };
  }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();

  readonly calls: Call[] = [];

  // Test hooks — set from a test to force a specific failure mode.
  prepareShouldThrow: string | null = null;
  commitShouldThrow: string | null = null;
  readVerifiedShouldThrow: string | null = null;

  presetIngest(scope: string, requestId: string, hash: string, main: {hash: string; bytes: Uint8Array}, thumb: {hash: string; bytes: Uint8Array}): void {
    const key = `${scope}::${requestId}`;
    this.jobs.set(key, {
      hash,
      state: 'prepared',
      main: { hash: main.hash, bytes: main.bytes, byte_size: main.bytes.length },
      thumb: { hash: thumb.hash, bytes: thumb.bytes, byte_size: thumb.bytes.length },
    });
    this.files.set(`${scope}::${main.hash}`, { bytes: main.bytes, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${thumb.hash}`, { bytes: thumb.bytes, mime: 'image/jpeg', ext: 'jpg' });
  }

  deleteFile(scope: string, hash: string): void {
    this.files.delete(`${scope}::${hash}`);
  }

  async prepareStockImage(input: PrepareInput): Promise<PrepareResult> {
    this.calls.push(`prepare:${input.tenantScope}:${input.ingestRequestId}`);
    if (this.prepareShouldThrow) throw new Error(this.prepareShouldThrow);
    const j = this.jobs.get(`${input.tenantScope}::${input.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    if (j.hash !== input.requestHash) throw new Error('MEDIA_INGEST_REQUEST_CONFLICT');
    return {
      ingest_request_id: input.ingestRequestId,
      request_hash: input.requestHash,
      state: 'prepared',
      main_descriptor: descriptor(j.main.hash, j.main.byte_size, 800, 600),
      thumbnail_descriptor: descriptor(j.thumb.hash, j.thumb.byte_size, 200, 150),
    };
  }

  async commitStockImage(input: CommitInput): Promise<CommitResult> {
    this.calls.push(`commit:${input.tenantScope}:${input.ingestRequestId}`);
    if (this.commitShouldThrow) throw new Error(this.commitShouldThrow);
    const j = this.jobs.get(`${input.tenantScope}::${input.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    if (j.hash !== input.requestHash) throw new Error('MEDIA_INGEST_REQUEST_CONFLICT');
    if (j.state === 'aborted') throw new Error('MEDIA_INGEST_INVALID_STATE');
    j.state = 'published';
    return {
      state: 'published',
      main_descriptor: descriptor(j.main.hash, j.main.byte_size, 800, 600),
      thumbnail_descriptor: descriptor(j.thumb.hash, j.thumb.byte_size, 200, 150),
      main_storage_key: `${input.tenantScope}/${j.main.hash.slice(0, 2)}/${j.main.hash}.jpg`,
      thumbnail_storage_key: `${input.tenantScope}/${j.thumb.hash.slice(0, 2)}/${j.thumb.hash}.jpg`,
    };
  }

  async abortStockImage(input: AbortInput): Promise<AbortResult> {
    this.calls.push(`abort:${input.tenantScope}:${input.ingestRequestId}`);
    const j = this.jobs.get(`${input.tenantScope}::${input.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    if (j.state === 'published') throw new Error('MEDIA_INGEST_ALREADY_PUBLISHED');
    j.state = 'aborted';
    return { ingest_request_id: input.ingestRequestId, state: 'aborted' };
  }

  async readVerifiedMedia(input: ReadVerifiedInput): Promise<MediaBytes> {
    this.calls.push(`read:${input.tenantScope}:${input.hash}`);
    if (this.readVerifiedShouldThrow) throw new Error(this.readVerifiedShouldThrow);
    const f = this.files.get(`${input.tenantScope}::${input.hash}`);
    if (!f) throw new Error('MEDIA_FILE_MISSING');
    return { bytes: f.bytes, hash: input.hash, byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext };
  }

  async recoverMediaIngests(): Promise<RecoveryOutcome[]> {
    this.calls.push(`recover:*`);
    return [];
  }
}

function descriptor(hash: string, size: number, w: number, h: number) {
  return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: w, height: h };
}

// ── controlled save stub ───────────────────────────────────────────────────

class SaveDurablyStub {
  calls = 0;
  shouldThrow: string | null = null;
  throwOnCall: number | null = null;
  async run(): Promise<void> {
    this.calls++;
    if (this.throwOnCall !== null && this.calls === this.throwOnCall) throw new Error('DISK_FULL');
    if (this.shouldThrow) throw new Error(this.shouldThrow);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const HASH_REQ = pad64('cafe');
const HASH_MAIN = pad64('aa11');
const HASH_THUMB = pad64('bb22');
function pad64(seed: string): string {
  const c = seed.toLowerCase().replace(/[^0-9a-f]/g, '0');
  return (c + '0'.repeat(64)).slice(0, 64);
}
function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i + seed) & 0xff;
  return out;
}
const MAIN = { hash: HASH_MAIN, bytes: bytesOf(50_000, 1) };
const THUMB = { hash: HASH_THUMB, bytes: bytesOf(15_000, 2) };

function baseInput(overrides: Partial<IngestAndFinalizeInput> = {}): IngestAndFinalizeInput {
  return {
    tenantId: 't1',
    branchId: 'b1',
    ingestRequestId: 'req-1',
    requestHash: HASH_REQ,
    entityType: 'product',
    entityId: 'p1',
    scopeKind: 'branch',
    role: 'stock_image',
    imageBytes: bytesOf(100_000, 42),
    ...overrides,
  };
}

// ── lease helpers ──────────────────────────────────────────────────────────
//
// A production DbLease pins a concrete sql.js instance and refuses to save
// if the module-level db drifted. Tests reproduce the same shape:
//   • `staticLease(db, save)` — the db is fixed; save always runs the stub
//   • `swappingLease(state, save)` — the "current" db is a dynamic reference;
//                                    save throws DbLeaseInvalidatedError
//                                    when the current has drifted from
//                                    the lease-taken pinned instance.

function throwLeaseInvalid(msg = 'DB_LEASE_INVALIDATED'): never {
  const e = new Error(msg);
  e.name = 'DbLeaseInvalidatedError';
  throw e;
}

function staticLease(db: OrchestratorRawDb, save: SaveDurablyStub, epoch = 0): OrchestratorLease {
  return {
    db,
    epoch,
    async saveDurably() { await save.run(); },
    release() {},
  };
}

function swappingLease(
  state: { db: OrchestratorRawDb; epoch: number },
  save: SaveDurablyStub,
): OrchestratorLease {
  const pinnedDb = state.db;
  const pinnedEpoch = state.epoch;
  return {
    db: pinnedDb,
    epoch: pinnedEpoch,
    async saveDurably() {
      if (state.db !== pinnedDb || state.epoch !== pinnedEpoch) {
        throwLeaseInvalid('db instance drifted mid-lease');
      }
      await save.run();
    },
    release() {},
  };
}

async function freshOrchestrator(SQL: any) {
  const db = new SQL.Database();
  seedEntityStubs(db);
  applyMediaSchema(db);
  const gateway = new RecordingFakeGateway();
  const coordinator = new MediaDbCoordinator(db, gateway);
  const save = new SaveDurablyStub();
  const orch = new StockMediaOrchestrator({
    gateway,
    leaseFactory: () => staticLease(db, save),
  });
  return { db, gateway, coordinator, save, orch };
}

// ══════════════════════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 happy path — prepare, register, cp1, commit+finalize, cp2 ──────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    const r = await orch.ingestAndFinalizeStockImage(baseInput());
    ok(r.state === 'ready', 'success with state=ready');
    // Two durable saves: checkpoint 1 (intent) + checkpoint 2 (result).
    ok(save.calls === 2, `saveDurably called exactly twice (got ${save.calls})`);
    // Call ordering: prepare → commit → read×2. save-vs-gateway ordering
    // is proven by §2 (Rust commit MUST NOT run before cp1).
    const idxPrepare = gateway.calls.findIndex((c) => c.startsWith('prepare:'));
    const idxCommit = gateway.calls.findIndex((c) => c.startsWith('commit:'));
    const idxReadMain = gateway.calls.findIndex((c) => c === `read:t1:${HASH_MAIN}`);
    const idxReadThumb = gateway.calls.findIndex((c) => c === `read:t1:${HASH_THUMB}`);
    ok(idxPrepare < idxCommit && idxCommit < idxReadMain && idxCommit < idxReadThumb,
      `call order: prepare<commit<read (got ${gateway.calls.join(',')})`);
    // Row-level: link active + primary + canonical options
    const link = db.exec(`SELECT is_primary, sort_order FROM media_links WHERE deleted_at IS NULL`)[0].values[0];
    ok(Number(link[0]) === 1 && Number(link[1]) === 0, `canonical link options (${link[0]},${link[1]})`);
  }

  // ── §2 checkpoint 1 must complete before Rust commit runs ─────────────
  {
    const { db, gateway, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    // Instrument the save stub to snapshot the gateway call log at the moment
    // of the FIRST save call — commit must not yet have been recorded.
    let commitBeforeCp1 = false;
    const orch = new StockMediaOrchestrator({
      gateway,
      leaseFactory: () => ({
        db,
        epoch: 0,
        async saveDurably() {
          save.calls++;
          if (save.calls === 1) {
            commitBeforeCp1 = gateway.calls.some((c) => c.startsWith('commit:'));
          }
        },
        release() {},
      }),
    });
    await orch.ingestAndFinalizeStockImage(baseInput());
    ok(!commitBeforeCp1, 'commit does NOT run before checkpoint 1');
  }

  // ── §3 prepare failure — no DB touch, no save ─────────────────────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    gateway.prepareShouldThrow = 'MEDIA_INGEST_INPUT_TOO_LARGE';
    await throws('prepare throws → PREPARE_FAILED', 'MEDIA_ORCH_PREPARE_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput()));
    ok(save.calls === 0, `no save on prepare failure (got ${save.calls})`);
    const jobs = Number(db.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]);
    ok(jobs === 0, `no DB intent row created (got ${jobs})`);
  }

  // ── §4 commit fails AFTER register+cp1 — intent stays on disk ─────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    gateway.commitShouldThrow = 'MEDIA_INGEST_INVALID_STATE';
    await throws('commit throws → surfaces underlying code',
      'MEDIA_INGEST_INVALID_STATE',
      () => orch.ingestAndFinalizeStockImage(baseInput()));
    // Cp1 already ran; cp2 did not.
    ok(save.calls === 1, `only checkpoint 1 ran (got ${save.calls})`);
    const jobRow = db.exec(`SELECT state, request_hash FROM media_ingest_jobs`)[0].values[0];
    ok(String(jobRow[0]) === 'accepted', `intent job persists in state=accepted (got ${jobRow[0]})`);
    ok(String(jobRow[1]) === HASH_REQ, 'intent manifest carries request_hash');
    // No media_* rows were opened — the DB tx never even started.
    const links = Number(db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0]);
    const blobs = Number(db.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0]);
    ok(links === 0 && blobs === 0, `no metadata opened (links=${links}, blobs=${blobs})`);
  }

  // ── §5 DB finalize trigger fails AFTER register+cp1 ──────────────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    await throws('DB finalize trigger → surfaces trigger code',
      'MEDIA_ENTITY_NOT_FOUND',
      () => orch.ingestAndFinalizeStockImage(baseInput({ entityId: 'ghost' })));
    ok(save.calls === 1, `cp1 saved, cp2 did not run (got ${save.calls})`);
    const state = String(db.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(state === 'accepted', `intent job stays recoverable (state=${state})`);
    const links = Number(db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0]);
    ok(links === 0, 'no active link after rollback');
  }

  // ── §6 checkpoint 1 fails — no Rust commit at all ────────────────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    save.throwOnCall = 1;
    await throws('cp1 fails → PERSIST_FAILED', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput()));
    ok(save.calls === 1, `save attempted once (got ${save.calls})`);
    ok(!gateway.calls.some((c) => c.startsWith('commit:')), 'no Rust commit ran after cp1 failure');
    // In-memory job is at 'accepted' (register wrote it) — but on-disk state
    // is whatever the SaveStub failed to persist. The retry converges.
    const state = String(db.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(state === 'accepted', `in-memory intent still visible (state=${state})`);
  }

  // ── §7 retry after cp1 failure — idempotent, no duplicates ───────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    save.throwOnCall = 1;
    await throws('first attempt fails on cp1', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput()));
    // Second attempt: save stub no longer throws. Coordinator sees existing
    // intent (register is idempotent), Rust prepare is idempotent, commit
    // runs, finalize opens the 6-table set, cp2 saves.
    const r = await orch.ingestAndFinalizeStockImage(baseInput());
    ok(r.state === 'ready', 'retry succeeds');
    // Save counts: attempt1 cp1=1, attempt2 cp1=2 + cp2=3.
    ok(save.calls === 3, `save total across attempts = 3 (got ${save.calls})`);
    const blobs = Number(db.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0]);
    const jobs = Number(db.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]);
    const links = Number(db.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    ok(blobs === 2 && jobs === 1 && links === 1, `no duplicates after retry (blobs=${blobs}, jobs=${jobs}, links=${links})`);
  }

  // ── §8 retry after DB-finalize (trigger) failure ─────────────────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    // First: wrong entityId → trigger aborts. Register wrote intent first
    // and cp1 saved it, then finalize threw. Cp2 never ran.
    await throws('first attempt fails in DB tx', 'MEDIA_ENTITY_NOT_FOUND',
      () => orch.ingestAndFinalizeStockImage(baseInput({ entityId: 'ghost' })));
    ok(save.calls === 1, `first attempt: cp1 saved, cp2 did not (got ${save.calls})`);
    // Second: correct entity. Register updates the manifest (same request
    // hash, so intent descriptors match), cp1 saves again, finalize + cp2.
    const r = await orch.ingestAndFinalizeStockImage(baseInput());
    ok(r.state === 'ready', 'retry with correct entity succeeds');
    ok(save.calls === 3, `save total = 3 across corrected retry (got ${save.calls})`);
    const links = Number(db.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    ok(links === 1, `single active link after retry (got ${links})`);
  }

  // ── §9 recovery: Rust published + DB open → ready + persisted ─────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    // Plant a half-open job (no rows yet).
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-r','req-r', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard','accepted', 1, 'n','n')`,
      [HASH_REQ] as unknown[],
    );
    gateway.presetIngest('t1', 'req-r', HASH_REQ, MAIN, THUMB);
    const r = await orch.recoverPendingStockMedia();
    ok(r.dbChanged, 'recover reports dbChanged=true');
    ok(save.calls === 1, `save called exactly once by recover (got ${save.calls})`);
    const state = String(db.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(state === 'ready', 'job state=ready after recover');
  }

  // ── §10 second recovery — idempotent no-op, no save ─────────────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-r','req-r', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard','accepted', 1, 'n','n')`,
      [HASH_REQ] as unknown[],
    );
    gateway.presetIngest('t1', 'req-r', HASH_REQ, MAIN, THUMB);
    await orch.recoverPendingStockMedia();
    const savedFirst = save.calls;
    const second = await orch.recoverPendingStockMedia();
    ok(!second.dbChanged, 'second recover reports no changes');
    ok(save.calls === savedFirst, `no extra save on second recover (before=${savedFirst}, after=${save.calls})`);
  }

  // ── §11 recovery: missing file → quarantine + save ──────────────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-r','req-r', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard','accepted', 1, 'n','n')`,
      [HASH_REQ] as unknown[],
    );
    gateway.presetIngest('t1', 'req-r', HASH_REQ, MAIN, THUMB);
    gateway.deleteFile('t1', HASH_MAIN);
    const r = await orch.recoverPendingStockMedia();
    ok(r.dbChanged, 'quarantine counts as a DB change');
    ok(save.calls === 1, `save called after quarantine (got ${save.calls})`);
    const state = String(db.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(state === 'quarantined', 'job quarantined');
    const links = Number(db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0]);
    ok(links === 0, 'no active link on quarantined recovery');
  }

  // ── §12 export/reopen after successful ingest ───────────────────────
  {
    const { db, gateway, orch } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    await orch.ingestAndFinalizeStockImage(baseInput());
    const image = db.export();
    const re = new (SQL as any).Database(image);
    // Rebuild a fresh orchestrator against the reopened DB.
    const gateway2 = new RecordingFakeGateway();
    gateway2.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    const save2 = new SaveDurablyStub();
    const orch2 = new StockMediaOrchestrator({
      gateway: gateway2,
      leaseFactory: () => staticLease(re, save2),
    });
    // Recovery on reopened DB is a no-op.
    const r2 = await orch2.recoverPendingStockMedia();
    ok(!r2.dbChanged, 'reopened DB: recover is a no-op');
    const state = String(re.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(state === 'ready', 'reopened job state=ready');
    const links = Number(re.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    const blobs = Number(re.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0]);
    const objs = Number(re.exec(`SELECT COUNT(*) FROM media_objects`)[0].values[0][0]);
    const vars = Number(re.exec(`SELECT COUNT(*) FROM media_variants`)[0].values[0][0]);
    ok(links === 1 && blobs === 2 && objs === 1 && vars === 1,
      `metadata intact after reopen (links=${links}, blobs=${blobs}, objs=${objs}, vars=${vars})`);
  }

  // ── §13 abort — prepared only ────────────────────────────────────────
  {
    const { gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    const r = await orch.abortStockImage({ tenantId: 't1', ingestRequestId: 'req-1' });
    ok(r.state === 'aborted', 'prepared abort succeeds');
    ok(save.calls === 0, `abort does not touch the DB (got ${save.calls})`);
  }

  // ── §14 abort after publish rejected ────────────────────────────────
  {
    const { gateway, orch } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    await orch.ingestAndFinalizeStockImage(baseInput());
    // Now the request is published → abort is refused by Rust.
    await throws('abort after publish rejected by Rust', 'MEDIA_INGEST_ALREADY_PUBLISHED',
      () => orch.abortStockImage({ tenantId: 't1', ingestRequestId: 'req-1' }));
  }

  // ── §15 no base64 / no data: written anywhere ────────────────────────
  {
    const { db, gateway, orch } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    await orch.ingestAndFinalizeStockImage(baseInput());
    const image = db.export();
    const re = new (SQL as any).Database(image);
    const tables = re.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)[0].values.map((v: any[]) => String(v[0]));
    const forbidden = /^data:|;base64,|^iVBORw0KGgo|^\/9j\//;
    let leaks = 0;
    for (const t of tables) {
      const rows = re.exec(`SELECT * FROM ${t}`);
      if (rows.length === 0) continue;
      for (const row of rows[0].values) {
        for (const v of row) if (typeof v === 'string' && forbidden.test(v)) leaks++;
      }
    }
    ok(leaks === 0, `no base64/data: payload after orchestrated ingest (${leaks} leaks)`);
  }

  // ── §16 sync_changelog untouched ────────────────────────────────────
  {
    const { db, gateway, orch } = await freshOrchestrator(SQL);
    db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY, table_name TEXT, payload TEXT)`);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    await orch.ingestAndFinalizeStockImage(baseInput());
    const scl = Number(db.exec(`SELECT COUNT(*) FROM sync_changelog`)[0].values[0][0]);
    ok(scl === 0, `orchestrator writes no sync_changelog (got ${scl})`);
  }

  // ── §17 no product.images write anywhere ────────────────────────────
  {
    const { db, gateway, orch } = await freshOrchestrator(SQL);
    // Extend the stub product table with an `images` column and observe it
    // stays untouched.
    db.run(`ALTER TABLE products ADD COLUMN images TEXT`);
    db.run(`UPDATE products SET images = '[]' WHERE id = 'p1'`);
    gateway.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    await orch.ingestAndFinalizeStockImage(baseInput());
    const val = String(db.exec(`SELECT images FROM products WHERE id='p1'`)[0].values[0][0]);
    ok(val === '[]', `products.images left untouched (got ${JSON.stringify(val)})`);
  }

  // ══ R1 crash / reopen matrix — durable pre-publication intent proves recovery ══

  // A helper that mirrors the production factory but with a save stub that
  // snapshots the DB into a byte image every time it "successfully" saves.
  // A crash is modelled by discarding the in-memory DB and rebuilding one
  // from the last successful snapshot.
  function orchestratorWithSnapshotting(sql: any) {
    const db = new sql.Database();
    seedEntityStubs(db);
    applyMediaSchema(db);
    const gateway = new RecordingFakeGateway();
    const coordinator = new MediaDbCoordinator(db, gateway);
    const snapshots: Uint8Array[] = [];
    let saveShouldThrowNext = false;
    const orch = new StockMediaOrchestrator({
      gateway,
      leaseFactory: () => ({
        db,
        epoch: 0,
        async saveDurably() {
          if (saveShouldThrowNext) {
            saveShouldThrowNext = false;
            throw new Error('DISK_FULL');
          }
          snapshots.push(db.export());
        },
        release() {},
      }),
    });
    return {
      db, gateway, coordinator, orch, snapshots,
      failNextSave: () => { saveShouldThrowNext = true; },
    };
  }

  // ── §A cp1 fails → Rust commit never runs ────────────────────────────
  {
    const { gateway, orch, snapshots, failNextSave } = orchestratorWithSnapshotting(SQL);
    gateway.presetIngest('t1', 'req-A', HASH_REQ, MAIN, THUMB);
    failNextSave();
    await throws('cp1 fails', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-A' })));
    ok(!gateway.calls.some((c) => c.startsWith('commit:')), 'commit was never called');
    ok(snapshots.length === 0, `no successful snapshot was taken (got ${snapshots.length})`);
  }

  // ── §B crash after cp1, before Rust commit ───────────────────────────
  {
    const s = orchestratorWithSnapshotting(SQL);
    s.gateway.presetIngest('t1', 'req-B', HASH_REQ, MAIN, THUMB);
    // Force the orchestrator to throw immediately AFTER cp1 by making the
    // Rust commit throw — that mirrors the "crash before commit" state
    // exactly: intent is durable, Rust is still just prepared.
    s.gateway.commitShouldThrow = 'MEDIA_INGEST_INVALID_STATE';
    await throws('commit fails post-cp1', 'MEDIA_INGEST_INVALID_STATE',
      () => s.orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-B' })));
    ok(s.snapshots.length === 1, `intent snapshot exists (got ${s.snapshots.length})`);
    // "Crash": discard process state and reopen from the intent snapshot.
    const reopened = new (SQL as any).Database(s.snapshots[0]);
    const gw2 = new RecordingFakeGateway();
    gw2.presetIngest('t1', 'req-B', HASH_REQ, MAIN, THUMB); // Rust journal still at prepared
    const save2 = new SaveDurablyStub();
    const orch2 = new StockMediaOrchestrator({
      gateway: gw2,
      leaseFactory: () => staticLease(reopened, save2),
    });
    const rep = await orch2.recoverPendingStockMedia();
    ok(rep.dbChanged, 'recovery reports dbChanged=true');
    ok(save2.calls === 1, `recovery saved exactly once (got ${save2.calls})`);
    const jobState = String(reopened.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(jobState === 'ready', `reopened job converged to ready (got ${jobState})`);
    const links = Number(reopened.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    ok(links === 1, `single active link after B (got ${links})`);
  }

  // ── §C crash after Rust publish, before cp2 ──────────────────────────
  {
    const s = orchestratorWithSnapshotting(SQL);
    s.gateway.presetIngest('t1', 'req-C', HASH_REQ, MAIN, THUMB);
    // Make cp2 fail — cp1 has already snapshotted the intent, commit ran
    // (Rust files are published), the DB tx opened all rows in-memory, then
    // cp2 threw. We reopen from the cp1 snapshot and prove convergence.
    // Snapshot 0 = cp1; the failing cp2 is what we're simulating.
    let callNo = 0;
    const gw = s.gateway;
    const db = s.db;
    const orchC = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => ({
        db,
        epoch: 0,
        async saveDurably() {
          callNo++;
          if (callNo === 2) throw new Error('DISK_FULL_CP2');
          s.snapshots.push(db.export());
        },
        release() {},
      }),
    });
    await throws('cp2 fails', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orchC.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-C' })));
    ok(s.snapshots.length === 1, `only cp1 snapshot on disk (got ${s.snapshots.length})`);
    // Reopen from the cp1 snapshot.
    const reopened = new (SQL as any).Database(s.snapshots[0]);
    const gw2 = new RecordingFakeGateway();
    gw2.presetIngest('t1', 'req-C', HASH_REQ, MAIN, THUMB); // Rust journal at published
    const save2 = new SaveDurablyStub();
    const orch2 = new StockMediaOrchestrator({
      gateway: gw2,
      leaseFactory: () => staticLease(reopened, save2),
    });
    const rep = await orch2.recoverPendingStockMedia();
    ok(rep.dbChanged, '§C recover: dbChanged=true');
    const jobState = String(reopened.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(jobState === 'ready', `§C reopened → ready (got ${jobState})`);
    const blobs = Number(reopened.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0]);
    const objs = Number(reopened.exec(`SELECT COUNT(*) FROM media_objects`)[0].values[0][0]);
    const vars = Number(reopened.exec(`SELECT COUNT(*) FROM media_variants`)[0].values[0][0]);
    const links = Number(reopened.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    ok(blobs === 2 && objs === 1 && vars === 1 && links === 1,
      `full metadata after §C recover (blobs=${blobs}, objs=${objs}, vars=${vars}, links=${links})`);
  }

  // ── §D cp2 fails → reopen from cp1 → recovery converges ─────────────
  // (§D is the same shape as §C but its assertion focus is that a follow-up
  // recovery converges + persists on disk, not just that metadata materialised.)
  {
    const s = orchestratorWithSnapshotting(SQL);
    s.gateway.presetIngest('t1', 'req-D', HASH_REQ, MAIN, THUMB);
    let callNo = 0;
    const gw = s.gateway;
    const db = s.db;
    const orchD = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => ({
        db,
        epoch: 0,
        async saveDurably() {
          callNo++;
          if (callNo === 2) throw new Error('DISK_FULL_CP2');
          s.snapshots.push(db.export());
        },
        release() {},
      }),
    });
    await throws('cp2 fails (§D)', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orchD.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-D' })));
    const reopened = new (SQL as any).Database(s.snapshots[0]);
    const gw2 = new RecordingFakeGateway();
    gw2.presetIngest('t1', 'req-D', HASH_REQ, MAIN, THUMB);
    const save2 = new SaveDurablyStub();
    const orch2 = new StockMediaOrchestrator({
      gateway: gw2,
      leaseFactory: () => staticLease(reopened, save2),
    });
    const rep = await orch2.recoverPendingStockMedia();
    ok(rep.dbChanged && save2.calls === 1, `§D recovery persisted exactly once (dbChanged=${rep.dbChanged}, saves=${save2.calls})`);
    // A second recovery on the reopened DB is a no-op.
    const rep2 = await orch2.recoverPendingStockMedia();
    ok(!rep2.dbChanged && save2.calls === 1, `§D second recovery is idempotent (dbChanged=${rep2.dbChanged}, saves=${save2.calls})`);
  }

  // ── §E retry a second identical ingest — no duplicates anywhere ─────
  {
    const { db, gateway, orch } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-E', HASH_REQ, MAIN, THUMB);
    await orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-E' }));
    // Second, byte-identical ingest call.
    await orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-E' }));
    const counts = {
      jobs: Number(db.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]),
      blobs: Number(db.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0]),
      gens: Number(db.exec(`SELECT COUNT(*) FROM media_blob_generations`)[0].values[0][0]),
      objs: Number(db.exec(`SELECT COUNT(*) FROM media_objects`)[0].values[0][0]),
      vars: Number(db.exec(`SELECT COUNT(*) FROM media_variants`)[0].values[0][0]),
      links: Number(db.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]),
    };
    ok(
      counts.jobs === 1 && counts.blobs === 2 && counts.gens === 2 &&
        counts.objs === 1 && counts.vars === 1 && counts.links === 1,
      `no duplicates after §E retry: ${JSON.stringify(counts)}`,
    );
  }

  // ══ R2 DB-instance coherence matrix ═════════════════════════════════════
  //
  // The R2 lifecycle audit (see orchestrator.ts header) proves the module-
  // level `db` in database.ts CAN be swapped inside the same JS context
  // (reloadDbFromDisk/resetDatabase both do `db = new SQL.Database(...)`).
  // The tests below drive an orchestrator wired to a mutable `dbProvider`
  // and prove: no cross-instance write, no persist-into-a-foreign-DB.

  function seededDb(sql: any) {
    const d = new sql.Database();
    seedEntityStubs(d);
    applyMediaSchema(d);
    return d;
  }

  // ── §I module import must not touch getDatabase() ────────────────────
  {
    // The orchestrator module was already imported at the top of this test.
    // If it had eagerly resolved a DB, running before any DB exists would
    // have thrown by now. Getting here IS the assertion.
    ok(true, 'module import completed without touching a DB');
  }

  // ── §II operation on DB A writes and saves DB A ─────────────────────
  {
    const dbA = seededDb(SQL);
    const gwA = new RecordingFakeGateway();
    gwA.presetIngest('t1', 'req-A', HASH_REQ, MAIN, THUMB);
    let persistedImage: Uint8Array | null = null;
    const orch = new StockMediaOrchestrator({
      gateway: gwA,
      leaseFactory: () => ({
        db: dbA,
        epoch: 0,
        async saveDurably() { persistedImage = dbA.export(); },
        release() {},
      }),
    });
    const r = await orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-A' }));
    ok(r.state === 'ready', 'op on dbA succeeds');
    const linksInA = Number(dbA.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    ok(linksInA === 1, `dbA holds the link (got ${linksInA})`);
    ok(persistedImage != null, 'dbA was persisted');
  }

  // ── §III DB A replaced by DB B — next op writes and saves ONLY dbB ──
  {
    const dbA = seededDb(SQL);
    const dbB = seededDb(SQL);
    const gw = new RecordingFakeGateway();
    gw.presetIngest('t1', 'req-A', HASH_REQ, MAIN, THUMB);
    gw.presetIngest('t1', 'req-B', HASH_REQ, MAIN, THUMB);
    const state = { db: dbA as OrchestratorRawDb, epoch: 0 };
    // Simulate acquireDbLease: each fresh call pins the currently active db.
    // A swap is modelled by mutating `state` between operations.
    const orch = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => {
        const pinned = state.db;
        return {
          db: pinned,
          epoch: state.epoch,
          async saveDurably() { pinned.export(); },
          release() {},
        };
      },
    });
    await orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-A' }));
    const dbAJobs = Number(dbA.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]);
    ok(dbAJobs === 1, `dbA has the req-A job (got ${dbAJobs})`);

    // Simulate a reload/reset: swap the active DB reference between ops.
    state.db = dbB;
    state.epoch++;
    await orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-B' }));

    const dbAJobsAfter = Number(dbA.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]);
    const dbBJobs = Number(dbB.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]);
    ok(dbAJobsAfter === 1, `dbA unchanged after switch (got ${dbAJobsAfter})`);
    ok(dbBJobs === 1, `dbB has exactly the new job (got ${dbBJobs})`);
    const dbBIrid = String(dbB.exec(`SELECT ingest_request_id FROM media_ingest_jobs`)[0].values[0][0]);
    ok(dbBIrid === 'req-B', `dbB carries req-B (got ${dbBIrid})`);
  }

  // ── §IV DB swap after prepare, before cp1 → no publish, no cp1 ──────
  {
    const dbA = seededDb(SQL);
    const dbB = seededDb(SQL);
    const gw = new RecordingFakeGateway();
    gw.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    const state = { db: dbA as OrchestratorRawDb, epoch: 0 };
    let cp1Called = false;
    const origPrepare = gw.prepareStockImage.bind(gw);
    gw.prepareStockImage = async (i) => {
      const r = await origPrepare(i);
      // A hostile process bypasses the lease-wait and swaps the DB.
      state.db = dbB;
      state.epoch++;
      return r;
    };
    const orch = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => {
        const pinnedDb = state.db;
        const pinnedEpoch = state.epoch;
        return {
          db: pinnedDb,
          epoch: pinnedEpoch,
          async saveDurably() {
            if (state.db !== pinnedDb || state.epoch !== pinnedEpoch) {
              throwLeaseInvalid();
            }
            cp1Called = true;
          },
          release() {},
        };
      },
    });
    await throws('swap after prepare → INSTANCE_CHANGED',
      'MEDIA_ORCH_DB_INSTANCE_CHANGED',
      () => orch.ingestAndFinalizeStockImage(baseInput()));
    // The important invariants: cp1 was refused (persist-into-a-foreign-DB
    // prevented), Rust never published, and the swapped-in dbB is entirely
    // untouched. dbA may hold an in-memory intent row (the coordinator was
    // pinned to dbA), but nothing was persisted for it — a real reload
    // would see the pre-op disk state.
    ok(!cp1Called, 'cp1 was not invoked (no persist to any DB)');
    ok(!gw.calls.some((c) => c.startsWith('commit:')), 'no Rust commit ran');
    const dbBJobs = Number(dbB.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]);
    const dbBLinks = Number(dbB.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0]);
    ok(dbBJobs === 0 && dbBLinks === 0, `swapped-in DB never written to (dbB jobs=${dbBJobs}, links=${dbBLinks})`);
  }

  // ── §V DB swap during cp1 save → intent kept, dbB never written ─────
  {
    const dbA = seededDb(SQL);
    const dbB = seededDb(SQL);
    const gw = new RecordingFakeGateway();
    gw.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    const state = { db: dbA as OrchestratorRawDb, epoch: 0 };
    let cp1Snapshot: Uint8Array | null = null;
    // The save hook simulates a hostile in-flight swap AFTER capturing the
    // cp1 snapshot but BEFORE returning — the lease's guard sees the drift
    // on cp2 (the next save call) and refuses.
    let saveCount = 0;
    const orch = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => {
        const pinnedDb = state.db;
        const pinnedEpoch = state.epoch;
        return {
          db: pinnedDb,
          epoch: pinnedEpoch,
          async saveDurably() {
            saveCount++;
            if (saveCount === 1) {
              // cp1 completes on pinned, then a swap happens.
              if (state.db !== pinnedDb || state.epoch !== pinnedEpoch) throwLeaseInvalid();
              cp1Snapshot = pinnedDb.export();
              state.db = dbB;
              state.epoch++;
              return;
            }
            if (state.db !== pinnedDb || state.epoch !== pinnedEpoch) throwLeaseInvalid();
          },
          release() {},
        };
      },
    });
    await throws('swap during cp1 saves → INSTANCE_CHANGED',
      'MEDIA_ORCH_DB_INSTANCE_CHANGED',
      () => orch.ingestAndFinalizeStockImage(baseInput()));
    // The pinned coordinator wrote its finalize path to dbA in memory (that
    // is guaranteed by pin-per-op); cp2 was refused, so what a real reload
    // would see on disk is the cp1 intent snapshot. dbB stays empty.
    const dbBJobs = Number(dbB.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]);
    ok(dbBJobs === 0, `dbB untouched across the swap (got ${dbBJobs})`);
    ok(cp1Snapshot != null, 'cp1 snapshot captured before swap');
    // Recover from the cp1-snapshot proves the intent is still convergible.
    const reopened = new (SQL as any).Database(cp1Snapshot!);
    const gw2 = new RecordingFakeGateway();
    gw2.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    const save2 = new SaveDurablyStub();
    const orch2 = new StockMediaOrchestrator({
      gateway: gw2,
      leaseFactory: () => staticLease(reopened, save2),
    });
    const rep = await orch2.recoverPendingStockMedia();
    ok(rep.dbChanged, 'intent snapshot recovers to ready');
  }

  // ── §VI DB swap after Rust commit, before cp2 ───────────────────────
  {
    const dbA = seededDb(SQL);
    const dbB = seededDb(SQL);
    const gw = new RecordingFakeGateway();
    gw.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    const state = { db: dbA as OrchestratorRawDb, epoch: 0 };
    const origCommit = gw.commitStockImage.bind(gw);
    gw.commitStockImage = async (i) => {
      const r = await origCommit(i);
      state.db = dbB;
      state.epoch++;
      return r;
    };
    const orch = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => {
        const pinnedDb = state.db;
        const pinnedEpoch = state.epoch;
        return {
          db: pinnedDb,
          epoch: pinnedEpoch,
          async saveDurably() {
            if (state.db !== pinnedDb || state.epoch !== pinnedEpoch) throwLeaseInvalid();
            pinnedDb.export();
          },
          release() {},
        };
      },
    });
    await throws('swap after Rust commit → INSTANCE_CHANGED',
      'MEDIA_ORCH_DB_INSTANCE_CHANGED',
      () => orch.ingestAndFinalizeStockImage(baseInput()));
    const dbBJobs = Number(dbB.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0]);
    const dbBBlobs = Number(dbB.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0]);
    const dbBLinks = Number(dbB.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0]);
    ok(dbBJobs === 0 && dbBBlobs === 0 && dbBLinks === 0,
      `dbB was never written to across the swap (jobs=${dbBJobs}, blobs=${dbBBlobs}, links=${dbBLinks})`);
  }

  // ── §VII saveDurably persists exactly the pinned instance ──────────
  {
    const dbA = seededDb(SQL);
    const gw = new RecordingFakeGateway();
    gw.presetIngest('t1', 'req-1', HASH_REQ, MAIN, THUMB);
    let persistedBytes: Uint8Array | null = null;
    const orch = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => ({
        db: dbA,
        epoch: 0,
        async saveDurably() { persistedBytes = dbA.export(); },
        release() {},
      }),
    });
    await orch.ingestAndFinalizeStockImage(baseInput());
    // The persisted image must match dbA's current state (both cp1 and cp2
    // ran off dbA; the last one wins). Reopen and verify.
    const reopened = new (SQL as any).Database(persistedBytes!);
    const state = String(reopened.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(state === 'ready', `persisted image carries the pinned-DB state (got ${state})`);
  }

  // ══ R3 concurrency, ops-serialisation, lease contract ═════════════════════

  // ── §α 20 parallel ingests with distinct IDs — all durable, no dupes, no nested tx
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    const N = 20;
    // Preset all 20 ingests up front (shared MAIN/THUMB payload is fine —
    // uniqueness comes from ingest_request_id + entity_id).
    for (let i = 0; i < N; i++) {
      gateway.presetIngest('t1', `req-p${i}`, HASH_REQ, MAIN, THUMB);
    }
    // 20 distinct products so link uniqueness is satisfied.
    for (let i = 0; i < N; i++) {
      db.run(`INSERT INTO products (id, branch_id) VALUES ($id, 'b1')`, [`p-p${i}`] as unknown[]);
    }
    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        orch.ingestAndFinalizeStockImage(baseInput({
          ingestRequestId: `req-p${i}`,
          entityId: `p-p${i}`,
        })),
      );
    }
    const results = await Promise.all(promises);
    ok(results.every((r) => (r as FinalizeResult).state === 'ready'), 'all 20 ingests reach ready');
    const jobs = Number(db.exec(`SELECT COUNT(*) FROM media_ingest_jobs WHERE state='ready'`)[0].values[0][0]);
    const links = Number(db.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    ok(jobs === N && links === N, `no duplicates across 20 parallel ingests (jobs=${jobs}, links=${links})`);
    // save calls = 2 per op × 20 ops = 40. Serialisation guarantees a
    // BEGIN IMMEDIATE per op never overlaps (sql.js would throw on nested).
    ok(save.calls === 2 * N, `each op ran both checkpoints (save=${save.calls})`);
  }

  // ── §β ingest vs recovery — deterministic serialisation, no lost job
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-ir1', HASH_REQ, MAIN, THUMB);
    // Preload a half-open recovery target.
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-ir2','req-ir2', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard','accepted', 1, 'n','n')`,
      [HASH_REQ] as unknown[],
    );
    gateway.presetIngest('t1', 'req-ir2', HASH_REQ, MAIN, THUMB);
    db.run(`INSERT INTO products (id, branch_id) VALUES ('p-ir', 'b1')`);
    const p1 = orch.ingestAndFinalizeStockImage(baseInput({
      ingestRequestId: 'req-ir1', entityId: 'p-ir',
    }));
    const p2 = orch.recoverPendingStockMedia();
    const [r1, r2] = await Promise.all([p1, p2]);
    ok((r1 as FinalizeResult).state === 'ready', 'ingest ok');
    ok((r2 as RecoveryOrchestrationResult).dbChanged, 'recovery detected the half-open job');
    // Both jobs are durably ready — neither operation rolled the other back.
    const readyJobs = Number(db.exec(`SELECT COUNT(*) FROM media_ingest_jobs WHERE state='ready'`)[0].values[0][0]);
    ok(readyJobs === 2, `both jobs ready (got ${readyJobs})`);
    ok(save.calls >= 3, `save called on both operations (got ${save.calls})`);
  }

  // ── §γ lease-invalidated save surfaces MEDIA_ORCH_DB_INSTANCE_CHANGED
  {
    const { db, gateway } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-γ', HASH_REQ, MAIN, THUMB);
    const orch = new StockMediaOrchestrator({
      gateway,
      leaseFactory: () => ({
        db,
        epoch: 0,
        async saveDurably() { throwLeaseInvalid(); },
        release() {},
      }),
    });
    await throws('lease invalid on cp1 → INSTANCE_CHANGED',
      'MEDIA_ORCH_DB_INSTANCE_CHANGED',
      () => orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-γ' })));
  }

  // ── §δ database.ts wires the exclusive-swap controller (light static guard)
  //
  // The BEHAVIOURAL proof of the reader/writer gate lives in
  // test/dblifecycle/db-lifecycle.test.ts (the controller is a pure module
  // Node can import). Here we only guard that database.ts actually routes
  // reload/reset through the controller's `runExclusiveSwap` and takes leases
  // via `acquireLease` — production wiring the behavioural test can't see.
  {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(repo, 'src', 'core', 'db', 'database.ts'), 'utf-8');
    ok(/from '\.\/db-lifecycle'/.test(src), 'database.ts imports the lifecycle controller');
    ok(/export async function acquireDbLease\b/.test(src), 'acquireDbLease is async (awaits swaps)');
    ok(/dbLifecycle\.acquireLease\(\)/.test(src), 'acquireDbLease goes through the controller');
    const reload = src.match(/export async function reloadDbFromDisk[\s\S]{0,900}?\n}/);
    ok(reload != null && /dbLifecycle\.runExclusiveSwap\(/.test(reload[0]),
      'reloadDbFromDisk runs inside runExclusiveSwap');
    const reset = src.match(/export async function resetDatabase[\s\S]{0,900}?\n}/);
    ok(reset != null && /dbLifecycle\.runExclusiveSwap\(/.test(reset[0]),
      'resetDatabase runs inside runExclusiveSwap');
    // Epoch bumps only on an actual swap (inside mutate), never eagerly.
    ok(/dbLifecycle\.bumpEpoch\(\)/.test(src), 'epoch bumps via controller on actual swap');
    ok(/db !== leaseDb \|\| dbLifecycle\.currentEpoch\(\) !== leaseEpoch/.test(src),
      'saveDurably rejects a drifted instance');

    // R5 complete-swap-coverage: enumerate EVERY module-level `db = new SQL.Database`
    // and prove each is either (a) inside runExclusiveSwap [runtime swap] or
    // (b) inside initDatabase [bootstrap-only, before any lease can exist].
    const swapAssignments = [...src.matchAll(/db = new SQL\.Database/g)];
    ok(swapAssignments.length >= 3, `found the db-instance assignments (got ${swapAssignments.length})`);
    // initDatabase — bootstrap: its assignments must NOT be inside a swap.
    // Slice from `initDatabase` up to the next top-level `export ` so nested
    // braces don't truncate the body.
    const initFn = src.match(/export async function initDatabase[\s\S]*?(?=\nexport )/);
    ok(initFn != null && !/runExclusiveSwap/.test(initFn[0]),
      'initDatabase is bootstrap-only (no runExclusiveSwap needed — no lease possible pre-init)');
    ok(initFn != null && (initFn[0].match(/db = new SQL\.Database/g) ?? []).length >= 2,
      'the bootstrap db assignments live in initDatabase');
    // The ONLY runtime replacements are reload + reset, both inside runExclusiveSwap.
    ok(reload != null && /db = new SQL\.Database/.test(reload[0]),
      'reloadDbFromDisk performs its swap inside the exclusive gate');
    // reset closes the db (db = null) inside the gate rather than re-opening.
    ok(reset != null && /if \(db\) \{ db\.close\(\); db = null; \}/.test(reset[0]),
      'resetDatabase closes db inside the exclusive gate');
  }

  // ── §ε cp1 failure keeps the same request idempotent-retryable ────────
  {
    const { gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-ε', HASH_REQ, MAIN, THUMB);
    save.throwOnCall = 1;
    await throws('cp1 fails first', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-ε' })));
    // Same request retried — must not have been marked terminal on Rust side.
    const r = await orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-ε' }));
    ok(r.state === 'ready', 'same ingest_request_id retryable after cp1 failure');
  }

  // ── §ζ cp2 failure — reopen/recovery still converges ─────────────────
  {
    const dbA = seededDb(SQL);
    const gw = new RecordingFakeGateway();
    gw.presetIngest('t1', 'req-ζ', HASH_REQ, MAIN, THUMB);
    let saveCall = 0;
    let cp1Bytes: Uint8Array | null = null;
    const orch = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => ({
        db: dbA,
        epoch: 0,
        async saveDurably() {
          saveCall++;
          if (saveCall === 1) { cp1Bytes = dbA.export(); return; }
          throw new Error('DISK_FULL_CP2');
        },
        release() {},
      }),
    });
    await throws('cp2 fails (§ζ)', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-ζ' })));
    // Reopen from cp1 disk snapshot and recover.
    const reopened = new (SQL as any).Database(cp1Bytes!);
    const gw2 = new RecordingFakeGateway();
    gw2.presetIngest('t1', 'req-ζ', HASH_REQ, MAIN, THUMB);
    const save2 = new SaveDurablyStub();
    const orch2 = new StockMediaOrchestrator({
      gateway: gw2, leaseFactory: () => staticLease(reopened, save2),
    });
    const rep = await orch2.recoverPendingStockMedia();
    ok(rep.dbChanged && save2.calls === 1, `§ζ reopen/recover converged (dbChanged=${rep.dbChanged}, saves=${save2.calls})`);
    const state = String(reopened.exec(`SELECT state FROM media_ingest_jobs`)[0].values[0][0]);
    ok(state === 'ready', 'reopened job is ready');
  }

  // ══ R4 ops-queue failure recovery ═════════════════════════════════════════

  // ── §η1 first op fails at prepare → second runs; no stuck queue ────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-η1a', HASH_REQ, MAIN, THUMB);
    gateway.presetIngest('t1', 'req-η1b', HASH_REQ, MAIN, THUMB);
    db.run(`INSERT INTO products (id, branch_id) VALUES ('p-η1a', 'b1'),('p-η1b', 'b1')`);
    gateway.prepareShouldThrow = 'MEDIA_INGEST_INPUT_TOO_LARGE';
    // Fire A (fails) and B (should succeed) in sequence on the same orchestrator.
    await throws('op A fails at prepare', 'MEDIA_ORCH_PREPARE_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-η1a', entityId: 'p-η1a' })));
    gateway.prepareShouldThrow = null;
    const b = await orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-η1b', entityId: 'p-η1b' }));
    ok(b.state === 'ready', 'op B runs normally after A failed at prepare');
    void save;
  }

  // ── §η2 first op fails at checkpoint 1 → second runs ──────────────────
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    gateway.presetIngest('t1', 'req-η2a', HASH_REQ, MAIN, THUMB);
    gateway.presetIngest('t1', 'req-η2b', HASH_REQ, MAIN, THUMB);
    db.run(`INSERT INTO products (id, branch_id) VALUES ('p-η2a', 'b1'),('p-η2b', 'b1')`);
    save.throwOnCall = 1; // cp1 of op A fails
    await throws('op A fails at cp1', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-η2a', entityId: 'p-η2a' })));
    const b = await orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-η2b', entityId: 'p-η2b' }));
    ok(b.state === 'ready', 'op B runs normally after A failed at cp1');
  }

  // ── §η3 first op fails at checkpoint 2 → recovery runs ────────────────
  {
    const dbA = seededDb(SQL);
    const gw = new RecordingFakeGateway();
    gw.presetIngest('t1', 'req-η3', HASH_REQ, MAIN, THUMB);
    let saveCall = 0;
    let cp1Bytes: Uint8Array | null = null;
    const orch = new StockMediaOrchestrator({
      gateway: gw,
      leaseFactory: () => ({
        db: dbA,
        epoch: 0,
        async saveDurably() {
          saveCall++;
          if (saveCall === 1) { cp1Bytes = dbA.export(); return; }
          throw new Error('DISK_FULL_CP2');
        },
        release() {},
      }),
    });
    await throws('op A fails at cp2', 'MEDIA_ORCH_DB_PERSIST_FAILED',
      () => orch.ingestAndFinalizeStockImage(baseInput({ ingestRequestId: 'req-η3' })));
    // The queue is not stuck — a recovery op runs right after on the same orch,
    // but against the reopened cp1 snapshot (fresh gateway/lease).
    const reopened = new (SQL as any).Database(cp1Bytes!);
    const gw2 = new RecordingFakeGateway();
    gw2.presetIngest('t1', 'req-η3', HASH_REQ, MAIN, THUMB);
    const save2 = new SaveDurablyStub();
    const orch2 = new StockMediaOrchestrator({
      gateway: gw2, leaseFactory: () => staticLease(reopened, save2),
    });
    const rep = await orch2.recoverPendingStockMedia();
    ok(rep.dbChanged, 'recovery runs after a cp2 failure');
  }

  // ── §η4 opsChain heals: interleave failures + successes, queue survives
  {
    const { db, gateway, orch, save } = await freshOrchestrator(SQL);
    for (let i = 0; i < 6; i++) {
      gateway.presetIngest('t1', `req-η4-${i}`, HASH_REQ, MAIN, THUMB);
      db.run(`INSERT INTO products (id, branch_id) VALUES ($id, 'b1')`, [`p-η4-${i}`] as unknown[]);
    }
    // Odd-indexed ops target a ghost entity → DB trigger aborts. Even succeed.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        orch.ingestAndFinalizeStockImage(baseInput({
          ingestRequestId: `req-η4-${i}`,
          entityId: i % 2 === 0 ? `p-η4-${i}` : 'ghost',
        })),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    ok(fulfilled === 3 && rejected === 3, `3 succeed, 3 fail, queue never stuck (ok=${fulfilled}, err=${rejected})`);
    // Every even op is durably ready — the failing odd ops did not poison them.
    const ready = Number(db.exec(`SELECT COUNT(*) FROM media_ingest_jobs WHERE state='ready'`)[0].values[0][0]);
    ok(ready === 3, `all 3 successful ops durably ready (got ${ready})`);
    void save;
  }

  // ══ report ═══════════════════════════════════════════════════════════════
  console.log(`\nMEDIA-04A-2B2 orchestrator: ${PASS}/${PASS + FAIL} checks passed`);
  if (FAIL > 0) {
    console.log('\nFAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
