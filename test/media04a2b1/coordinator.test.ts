// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-2B1 — MediaDbCoordinator invariant tests
// Run: node test/media04a2b1/coordinator.test.ts
//
// Uses REAL sql.js in-memory (no productive DB touched, no filesystem write
// outside the standard node temp dir). A deterministic FakeMediaGateway
// stands in for the Rust command bridge — the real cross-language proof
// belongs to MEDIA-04A-2B2.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import {
  CoordinatorError,
  MediaDbCoordinator,
  type FinalizeInput,
} from '../../src/core/media/coordinator.ts';
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

// ── entity stubs (schema-classification test does the same) ────────────────
function seedEntityStubs(db: any): void {
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    // idempotent: some entities share tables — CREATE only once each
    db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  }
  db.run(`INSERT INTO tenants  (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1'),('bx','t2')`);
  db.run(`INSERT INTO users    (id, tenant_id) VALUES ('u1','t1')`);
  db.run(`INSERT INTO products (id, branch_id) VALUES ('p1','b1'),('p2','b1'),('px','bx')`);
}

// ── fake gateway ────────────────────────────────────────────────────────────

interface FakeState {
  main: { hash: string; bytes: Uint8Array; byte_size: number };
  thumb: { hash: string; bytes: Uint8Array; byte_size: number };
  storageKeyPrefix?: string;
}

function pad64(seed: string): string {
  const c = seed.toLowerCase();
  const trimmed = c.replace(/[^0-9a-f]/g, '0');
  return (trimmed + '0'.repeat(64)).slice(0, 64);
}

class FakeMediaGateway implements MediaCommandGateway {
  // Per-(scope, requestId) simulated ingest state.
  private jobs = new Map<string, {
    hash: string;
    state: 'prepared' | 'published' | 'aborted';
    main: FakeState['main'];
    thumb: FakeState['thumb'];
  }>();
  // Per-(scope, hash) simulated stored bytes.
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  // Test hooks
  public readVerifiedShouldThrow: string | null = null;
  public commitShouldThrow: string | null = null;

  presetIngest(scope: string, requestId: string, hash: string, s: FakeState): void {
    const k = `${scope}::${requestId}`;
    this.jobs.set(k, { hash, state: 'prepared', main: s.main, thumb: s.thumb });
    this.files.set(`${scope}::${s.main.hash}`, { bytes: s.main.bytes, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${s.thumb.hash}`, { bytes: s.thumb.bytes, mime: 'image/jpeg', ext: 'jpg' });
  }

  // Simulate a missing file (used to prove verification refusal).
  deleteFile(scope: string, hash: string): void {
    this.files.delete(`${scope}::${hash}`);
  }

  // Simulate a tampered file (bytes change, hash claimed unchanged).
  tamperFile(scope: string, hash: string, bytes: Uint8Array): void {
    const cur = this.files.get(`${scope}::${hash}`);
    if (!cur) throw new Error(`no file to tamper: ${hash}`);
    this.files.set(`${scope}::${hash}`, { ...cur, bytes });
  }

  async prepareStockImage(input: PrepareInput): Promise<PrepareResult> {
    void input; // preset covers what tests need
    throw new Error('FakeGateway.prepare not driven in these tests — use presetIngest');
  }

  async commitStockImage(input: CommitInput): Promise<CommitResult> {
    if (this.commitShouldThrow) throw new Error(this.commitShouldThrow);
    const k = `${input.tenantScope}::${input.ingestRequestId}`;
    const j = this.jobs.get(k);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    if (j.hash !== input.requestHash) throw new Error('MEDIA_INGEST_REQUEST_CONFLICT');
    if (j.state === 'aborted') throw new Error('MEDIA_INGEST_INVALID_STATE');
    j.state = 'published';
    return {
      state: 'published',
      main_descriptor: {
        hash: j.main.hash,
        extension: 'jpg',
        content_kind: 'raster_image',
        mime_type: 'image/jpeg',
        byte_size: j.main.byte_size,
        width: 800,
        height: 600,
      },
      thumbnail_descriptor: {
        hash: j.thumb.hash,
        extension: 'jpg',
        content_kind: 'raster_image',
        mime_type: 'image/jpeg',
        byte_size: j.thumb.byte_size,
        width: 200,
        height: 150,
      },
      main_storage_key: `${input.tenantScope}/${j.main.hash.slice(0, 2)}/${j.main.hash}.jpg`,
      thumbnail_storage_key: `${input.tenantScope}/${j.thumb.hash.slice(0, 2)}/${j.thumb.hash}.jpg`,
    };
  }

  async abortStockImage(input: AbortInput): Promise<AbortResult> {
    const k = `${input.tenantScope}::${input.ingestRequestId}`;
    const j = this.jobs.get(k);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    j.state = 'aborted';
    return { ingest_request_id: input.ingestRequestId, state: 'aborted' };
  }

  async readVerifiedMedia(input: ReadVerifiedInput): Promise<MediaBytes> {
    if (this.readVerifiedShouldThrow) throw new Error(this.readVerifiedShouldThrow);
    const f = this.files.get(`${input.tenantScope}::${input.hash}`);
    if (!f) throw new Error('MEDIA_FILE_MISSING');
    // Simulate hash verification exactly like the Rust core would.
    const declaredHash = input.hash;
    // Tests can tamper: check bytes-vs-declared hash by comparing sizes only
    // (we do not have a real hasher here, so mismatch is signalled by a
    // deliberate size divergence in tamperFile via the caller).
    return {
      bytes: f.bytes,
      hash: declaredHash,
      byte_size: f.bytes.length,
      mime_type: f.mime,
      extension: f.ext,
    };
  }

  async recoverMediaIngests(): Promise<RecoveryOutcome[]> {
    return [];
  }
}

// ── boilerplate ────────────────────────────────────────────────────────────

async function freshDb(SQL: any): Promise<{ db: any; coord: MediaDbCoordinator; fake: FakeMediaGateway }> {
  const db = new SQL.Database();
  seedEntityStubs(db);
  applyMediaSchema(db);
  const fake = new FakeMediaGateway();
  const coord = new MediaDbCoordinator(db, fake);
  return { db, coord, fake };
}

// A canonical input for the default happy-path.
const HASH_REQ = pad64('cafe');
const HASH_MAIN = pad64('aa11');
const HASH_THUMB = pad64('bb22');
const bytesOf = (n: number, seed: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i + seed) & 0xff;
  return out;
};
const MAIN = { hash: HASH_MAIN, bytes: bytesOf(50_000, 1), byte_size: 50_000 };
const THUMB = { hash: HASH_THUMB, bytes: bytesOf(15_000, 2), byte_size: 15_000 };

function baseInput(overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    tenantId: 't1',
    branchId: 'b1',
    ingestRequestId: 'req-happy-1',
    requestHash: HASH_REQ,
    entityType: 'product',
    entityId: 'p1',
    scopeKind: 'branch',
    role: 'stock_image',
    isPrimary: true,
    ...overrides,
  };
}

/**
 * 3A-R1: recovery reads the gallery slot from the DURABLE intent, never from a
 * default. A hand-planted "crashed mid-finalize" job row must therefore carry
 * a v2 intent payload, exactly as `registerPendingIntent` would have written
 * it — descriptors matching what the fake gateway's commit returns.
 */
function intentJson(
  scope = 't1',
  linkIntent: { isPrimary: boolean; sortOrder: number } = { isPrimary: true, sortOrder: 0 },
  main = MAIN,
  thumb = THUMB,
): string {
  const desc = (h: string, size: number, w: number, ht: number) => ({
    hash: h,
    extension: 'jpg',
    content_kind: 'raster_image',
    mime_type: 'image/jpeg',
    byte_size: size,
    width: w,
    height: ht,
    storage_key: `${scope}/${h.slice(0, 2)}/${h}.jpg`,
  });
  return JSON.stringify({
    kind: 'intent',
    intentVersion: 2,
    main: desc(main.hash, main.byte_size, 800, 600),
    thumbnail: desc(thumb.hash, thumb.byte_size, 200, 150),
    linkIntent,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 first finalize ────────────────────────────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-happy-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const r = await coord.finalize(baseInput());
    ok(r.state === 'ready', 'first finalize returns state=ready');
    ok(r.mainBlobId === `blob-${HASH_MAIN}`, 'main blob id derived from hash');
    ok(r.linkId.includes('t1') && r.linkId.includes('p1'), 'link id binds tenant + entity');
    // Row-level checks
    const link = db.exec(`SELECT scope_kind,branch_id,entity_type,entity_id,media_role,is_primary FROM media_links`)[0];
    ok(link.values[0].join('|') === 'branch|b1|product|p1|stock_image|1', 'link inserted with correct scope + primary flag');
    const job = db.exec(`SELECT state, target_media_id FROM media_ingest_jobs`)[0].values[0];
    ok(String(job[0]) === 'ready', 'job state=ready');
    ok(String(job[1]) === r.mediaId, 'job.target_media_id matches result');
  }

  // ── §2 retry same request → frozen result ────────────────────────────────
  {
    const { coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-happy-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const a = await coord.finalize(baseInput());
    const b = await coord.finalize(baseInput());
    ok(JSON.stringify(a) === JSON.stringify(b), 'retry with same hash returns byte-identical result');
  }

  // ── §3 request-hash conflict ────────────────────────────────────────────
  {
    const { coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-happy-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await coord.finalize(baseInput());
    await throws(
      'same request id + different hash → REQUEST_CONFLICT',
      'MEDIA_INGEST_REQUEST_CONFLICT',
      () => coord.finalize(baseInput({ requestHash: pad64('deadbeef') })),
    );
  }

  // ── §4 tx rollback on failure ──────────────────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-happy-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    // Force an entity-not-found failure inside the media_link trigger.
    await throws(
      'unknown entity id → link trigger aborts, tx rolls back',
      'MEDIA_ENTITY_NOT_FOUND',
      () => coord.finalize(baseInput({ entityId: 'ghost' })),
    );
    // After rollback: no rows anywhere in media_*.
    const counts = ['media_ingest_jobs','media_blobs','media_blob_generations','media_objects','media_variants','media_links'].map((t) => {
      const r = db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0];
      return `${t}=${r}`;
    });
    ok(counts.every((c) => c.endsWith('=0')), `rollback leaves media_* empty: ${counts.join(' ')}`);
  }

  // ── §5 existing identical blob reused ───────────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    fake.presetIngest('t1', 'req-2', pad64('feed'), { main: MAIN, thumb: THUMB });
    await coord.finalize(baseInput({ ingestRequestId: 'req-2', entityId: 'p2', requestHash: pad64('feed') }));
    // Exactly ONE blob per hash — the second finalize reused the existing rows.
    const blobs = db.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0];
    ok(Number(blobs) === 2, `two distinct hashes → 2 blobs, got ${blobs}`);
  }

  // ── §6 existing conflicting blob rejected ───────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    // Manually plant a blob at HASH_MAIN with a DIFFERENT byte_size than the
    // Rust core would report — the coordinator must refuse to reuse it.
    db.run(
      `INSERT INTO media_blob_generations
        (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash,
         byte_size, content_kind, mime_type, extension, is_encrypted, gen_status, created_at)
       VALUES ('t1', $b, 1, 't1/aa/${HASH_MAIN}.jpg', $h, 12345, 'raster_image', 'image/jpeg', 'jpg', 0, 'available', 'n')`,
      [`blob-${HASH_MAIN}`, HASH_MAIN] as unknown[],
    );
    db.run(
      `INSERT INTO media_blobs (tenant_id, blob_id, dedup_token, current_generation_no, blob_status, created_at, updated_at)
       VALUES ('t1', $b, 'sha256:t1:${HASH_MAIN}', 1, 'present', 'n', 'n')`,
      [`blob-${HASH_MAIN}`] as unknown[],
    );
    fake.presetIngest('t1', 'req-conflict', HASH_REQ, { main: MAIN, thumb: THUMB });
    await throws(
      'conflicting existing blob → MEDIA_DB_MEDIA_CONFLICT',
      'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-conflict' })),
    );
  }

  // ── §7 main + thumbnail correctly linked ────────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const r = await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    const obj = db.exec(`SELECT master_blob_id FROM media_objects WHERE media_id = $m`, [r.mediaId])[0].values[0];
    ok(String(obj[0]) === r.mainBlobId, 'media_object.master_blob_id = main blob');
    const variant = db.exec(`SELECT blob_id, variant_type FROM media_variants WHERE variant_id = $v`, [r.variantId])[0].values[0];
    ok(String(variant[0]) === r.thumbnailBlobId, 'thumbnail variant → thumb blob');
    ok(String(variant[1]) === 'thumbnail', 'variant_type = thumbnail');
  }

  // ── §8 export / reopen preserves all rows ───────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const before = await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    const image = db.export();
    const reopened = new (SQL as any).Database(image);
    const rehydratedFake = new FakeMediaGateway();
    rehydratedFake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const reopenedCoord = new MediaDbCoordinator(reopened, rehydratedFake);
    // Retry the same request → still frozen.
    const after = await reopenedCoord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    ok(JSON.stringify(before) === JSON.stringify(after), 'export/reopen preserves frozen result');
    const links = reopened.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0];
    ok(Number(links) === 1, `exactly one active link after reopen (got ${links})`);
    const job = reopened.exec(`SELECT state FROM media_ingest_jobs WHERE ingest_request_id='req-1'`)[0].values[0][0];
    ok(String(job) === 'ready', 'reopened job still ready');
  }

  // ── §9 recover — Rust published + DB empty → job goes fully ready ───────
  {
    const { db, coord, fake } = await freshDb(SQL);
    // Simulate a prior crash mid-finalize: the coordinator persisted the
    // ingest manifest (accepted job row) but the DB tx never landed.
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-req-9','req-9', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard',$intent,'accepted', 1, 'n','n')`,
      [HASH_REQ, intentJson()] as unknown[],
    );
    fake.presetIngest('t1', 'req-9', HASH_REQ, { main: MAIN, thumb: THUMB });

    const report = await coord.recover();
    ok(report.length === 1, `recover returned exactly one report entry (got ${report.length})`);
    ok(report[0].action === 'finalized_from_ready_rust', `action=finalized_from_ready_rust (got ${report[0].action})`);

    // Job is durably ready, all six media_* tables populated, link is active + primary.
    const jobState = String(db.exec(`SELECT state FROM media_ingest_jobs WHERE ingest_request_id='req-9'`)[0].values[0][0]);
    ok(jobState === 'ready', `job state=ready after recover (got ${jobState})`);
    const blobs = Number(db.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0]);
    const gens = Number(db.exec(`SELECT COUNT(*) FROM media_blob_generations`)[0].values[0][0]);
    const objs = Number(db.exec(`SELECT COUNT(*) FROM media_objects`)[0].values[0][0]);
    const vars = Number(db.exec(`SELECT COUNT(*) FROM media_variants`)[0].values[0][0]);
    const activeLinks = Number(db.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL AND is_primary=1`)[0].values[0][0]);
    ok(blobs === 2 && gens === 2 && objs === 1 && vars === 1 && activeLinks === 1,
      `full media_* population after recover (blobs=${blobs} gens=${gens} objs=${objs} vars=${vars} activeLinks=${activeLinks})`);
  }

  // ── §9b recover — job in 'finalizing' with no rows → converges ─────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    // Different-shaped half-finalize: state='finalizing' (post-upsertJob but
    // rows never landed). Recovery must still converge idempotently.
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-req-9b','req-9b', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard',$intent,'finalizing', 1, 'n','n')`,
      [HASH_REQ, intentJson()] as unknown[],
    );
    fake.presetIngest('t1', 'req-9b', HASH_REQ, { main: MAIN, thumb: THUMB });
    const report = await coord.recover();
    ok(report[0].action === 'finalized_from_ready_rust', 'finalizing → ready');
    const link = db.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0];
    ok(Number(link) === 1, `single active link after finalizing-recover (got ${link})`);
  }

  // ── §9c recover — no manifest → left_pending ───────────────────────────
  {
    const { db, coord } = await freshDb(SQL);
    // A job row with the required scope/entity/role columns NULL — no way
    // to rebuild a FinalizeInput; recovery must not crash and must not
    // silently guess.
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-nomanifest','req-nomanifest', $h,
               'accepted', 1, 'n','n')`,
      [HASH_REQ] as unknown[],
    );
    const report = await coord.recover();
    ok(report[0].action === 'left_pending_no_manifest', `action=left_pending_no_manifest (got ${report[0].action})`);
    const state = String(db.exec(`SELECT state FROM media_ingest_jobs WHERE ingest_request_id='req-nomanifest'`)[0].values[0][0]);
    ok(state === 'accepted', 'no-manifest job left in accepted state (no silent guess)');
  }

  // ── §9d recover twice — identical report shape, no duplicates ──────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-req-9d','req-9d', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard',$intent,'accepted', 1, 'n','n')`,
      [HASH_REQ, intentJson()] as unknown[],
    );
    fake.presetIngest('t1', 'req-9d', HASH_REQ, { main: MAIN, thumb: THUMB });
    const r1 = await coord.recover();
    const r2 = await coord.recover();
    ok(r1[0].action === 'finalized_from_ready_rust', 'first recover finalizes');
    ok(r2[0].action === 'noop_already_ready', 'second recover is no-op');
    // Idempotent: still exactly two blob rows, one link.
    const blobs = Number(db.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0]);
    const link = Number(db.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    ok(blobs === 2 && link === 1, `no duplicates after 2× recover (blobs=${blobs} link=${link})`);
  }

  // ── §9e recover — missing file → job quarantined ───────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-req-9e','req-9e', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard',$intent,'accepted', 1, 'n','n')`,
      [HASH_REQ, intentJson()] as unknown[],
    );
    fake.presetIngest('t1', 'req-9e', HASH_REQ, { main: MAIN, thumb: THUMB });
    fake.deleteFile('t1', HASH_MAIN);
    const report = await coord.recover();
    ok(report[0].action === 'quarantined_verification_failed', `action=quarantined (got ${report[0].action})`);
    const row = db.exec(`SELECT state, error_code FROM media_ingest_jobs WHERE ingest_request_id='req-9e'`)[0].values[0];
    ok(String(row[0]) === 'quarantined', `job state=quarantined (got ${row[0]})`);
    ok(String(row[1]) === 'MEDIA_INGEST_FILE_MISSING', `error_code stamped (got ${row[1]})`);
    // Terminal — a follow-up recover leaves it alone.
    const r2 = await coord.recover();
    ok(r2[0].action === 'noop_terminal_state', 'follow-up recover on quarantined = noop_terminal_state');
    // No links, no half-created rows.
    const links = Number(db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0]);
    ok(links === 0, `quarantined recovery created no link (got ${links})`);
  }

  // ── §9f recover — hash mismatch → quarantined ──────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-req-9f','req-9f', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard',$intent,'accepted', 1, 'n','n')`,
      [HASH_REQ, intentJson()] as unknown[],
    );
    fake.presetIngest('t1', 'req-9f', HASH_REQ, { main: MAIN, thumb: THUMB });
    fake.tamperFile('t1', HASH_MAIN, new Uint8Array(999));
    const report = await coord.recover();
    ok(report[0].action === 'quarantined_verification_failed', 'byte-size mismatch → quarantined');
  }

  // ── §9g recover — no Rust journal → left_pending ───────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-req-9g','req-9g', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard',$intent,'accepted', 1, 'n','n')`,
      [HASH_REQ, intentJson()] as unknown[],
    );
    // No presetIngest → gateway.commitStockImage rejects.
    const report = await coord.recover();
    ok(report[0].action === 'left_pending_no_rust_result', `action=left_pending_no_rust_result (got ${report[0].action})`);
    const state = String(db.exec(`SELECT state FROM media_ingest_jobs WHERE ingest_request_id='req-9g'`)[0].values[0][0]);
    ok(state === 'accepted', 'no-journal job stays accepted (still recoverable next time)');
  }

  // ── §9h export/reopen between recovery attempts ─────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-req-9h','req-9h', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard',$intent,'accepted', 1, 'n','n')`,
      [HASH_REQ, intentJson()] as unknown[],
    );
    fake.presetIngest('t1', 'req-9h', HASH_REQ, { main: MAIN, thumb: THUMB });
    const first = await coord.recover();
    ok(first[0].action === 'finalized_from_ready_rust', 'first recover finalizes');
    // Export + reopen: still ready, still one active link, second recover no-op.
    const image = db.export();
    const reopened = new (SQL as any).Database(image);
    const fake2 = new FakeMediaGateway();
    fake2.presetIngest('t1', 'req-9h', HASH_REQ, { main: MAIN, thumb: THUMB });
    const coord2 = new MediaDbCoordinator(reopened, fake2);
    const second = await coord2.recover();
    ok(second[0].action === 'noop_already_ready', 'reopened DB: recover is no-op');
    const link = Number(reopened.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)[0].values[0][0]);
    ok(link === 1, `reopened DB still has one active link (got ${link})`);
  }

  // ── §10 recover — already finalized DB ─────────────────────────────────
  {
    const { coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    const report = await coord.recover();
    const noop = report.find((r) => r.action === 'noop_already_ready');
    ok(noop != null, 'ready job reported as noop_already_ready');
  }

  // ── §11 missing file → no link, verification failure ────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-missing', HASH_REQ, { main: MAIN, thumb: THUMB });
    fake.deleteFile('t1', HASH_MAIN);
    await throws(
      'missing main file → FILE_MISSING, no link',
      'MEDIA_INGEST_FILE_MISSING',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-missing' })),
    );
    const links = db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0];
    ok(Number(links) === 0, `verification failure leaves no link (got ${links})`);
  }

  // ── §12 hash mismatch → refuse ─────────────────────────────────────────
  {
    const { coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-mismatch', HASH_REQ, { main: MAIN, thumb: THUMB });
    // Tamper: put a different-length payload under the same declared hash.
    fake.tamperFile('t1', HASH_MAIN, new Uint8Array(999));
    await throws(
      'byte_size mismatch → VERIFICATION_FAILED',
      'MEDIA_INGEST_VERIFICATION_FAILED',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-mismatch' })),
    );
  }

  // ── §13 replace: new image, old link deactivated ────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const first = await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    // New request with different content on the same product slot.
    const HASH2 = pad64('c0de');
    const MAIN2 = { hash: pad64('a222'), bytes: bytesOf(60_000, 3), byte_size: 60_000 };
    const THUMB2 = { hash: pad64('b333'), bytes: bytesOf(18_000, 4), byte_size: 18_000 };
    fake.presetIngest('t1', 'req-2', HASH2, { main: MAIN2, thumb: THUMB2 });
    const second = await coord.replace({
      ...baseInput({ ingestRequestId: 'req-2', requestHash: HASH2 }),
      previousLinkId: first.linkId,
    });
    ok(second.state === 'ready', 'replace returns ready');
    // Old link retired, new link active + primary.
    const rows = db.exec(`SELECT link_id, deleted_at, is_primary FROM media_links ORDER BY link_id`)[0].values;
    const active = rows.filter((r: any[]) => r[1] === null);
    ok(active.length === 1, `exactly one active link after replace (got ${active.length})`);
    ok(Number((active[0] as any[])[2]) === 1, 'active link is primary');
  }

  // ── §14 replace fails → old link stays active ───────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const first = await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    fake.presetIngest('t1', 'req-2', pad64('c0de'), { main: MAIN, thumb: THUMB });
    // Point the replace's new link at a branch where p1 does not live. 3A-R1
    // hardened `replace` to require an EXACT slot match (entity/role/scope/
    // branch) against the previous link, so this is now refused up front as a
    // link-not-found instead of only later by the entity-scope trigger — and
    // still without touching the old link.
    await throws(
      'replace to wrong branch → LINK_NOT_FOUND',
      'MEDIA_DB_LINK_NOT_FOUND',
      () =>
        coord.replace({
          ...baseInput({ ingestRequestId: 'req-2', requestHash: pad64('c0de'), branchId: 'b2' }),
          previousLinkId: first.linkId,
        }),
    );
    const linksActive = db.exec(`SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL AND is_primary=1`)[0].values[0][0];
    ok(Number(linksActive) === 1, `old primary link survives replace failure (got ${linksActive})`);
    const oldRow = db.exec(`SELECT deleted_at, is_primary FROM media_links WHERE link_id = $l`, [first.linkId])[0].values[0];
    ok(oldRow[0] === null && Number(oldRow[1]) === 1, 'old link untouched after replace rollback');
  }

  // ── §15 remove only logical ────────────────────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const r = await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    coord.remove({ tenantId: 't1', linkId: r.linkId });
    const link = db.exec(`SELECT deleted_at, is_primary FROM media_links WHERE link_id = $l`, [r.linkId])[0].values[0];
    ok(link[0] !== null && Number(link[1]) === 0, 'remove soft-deletes link and drops primary');
    // Blob + generation + object + variant untouched.
    const blobs = db.exec(`SELECT COUNT(*) FROM media_blobs WHERE deleted_at IS NULL`)[0].values[0][0];
    ok(Number(blobs) === 2, `remove leaves both blobs intact (got ${blobs})`);
    // Second remove is a no-op (idempotent).
    coord.remove({ tenantId: 't1', linkId: r.linkId });
    ok(true, 'idempotent second remove does not throw');
  }

  // ── §16 foreign tenant rejected ────────────────────────────────────────
  {
    const { coord, fake } = await freshDb(SQL);
    fake.presetIngest('t2', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await throws(
      'entity not in tenant → ENTITY_NOT_FOUND',
      'MEDIA_ENTITY_NOT_FOUND',
      () => coord.finalize({ ...baseInput({ ingestRequestId: 'req-1' }), tenantId: 't2', branchId: 'bx', entityId: 'p1' }),
    );
  }

  // ── §17 wrong branch/scope rejected ────────────────────────────────────
  {
    const { coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    // p1 belongs to b1; attempt to link under branch b2 → entity scope trigger fires.
    await throws(
      'wrong branch → ENTITY_NOT_FOUND',
      'MEDIA_ENTITY_NOT_FOUND',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-1', branchId: 'b2' })),
    );
  }

  // ── §18 no base64 / no data: in DB values ──────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    // Snapshot the DB and inspect every user-table column value.
    const image = db.export();
    const reopened = new (SQL as any).Database(image);
    const tables = reopened.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)[0].values.map((v: any[]) => String(v[0]));
    const forbidden = /^data:|;base64,|^iVBORw0KGgo|^\/9j\//;
    let leaks = 0;
    for (const t of tables) {
      const r = reopened.exec(`SELECT * FROM ${t}`);
      if (r.length === 0) continue;
      for (const row of r[0].values) {
        for (const v of row) {
          if (typeof v === 'string' && forbidden.test(v)) leaks++;
        }
      }
    }
    ok(leaks === 0, `no base64/data: payload written anywhere (${leaks} leaks)`);
  }

  // ── §19 no sync_changelog leak (no such row created) ──────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    // Create the sync_changelog table so the test can observe writes.
    db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY, table_name TEXT, payload TEXT)`);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    const scl = db.exec(`SELECT COUNT(*) FROM sync_changelog`)[0].values[0][0];
    ok(Number(scl) === 0, `coordinator never writes sync_changelog (got ${scl})`);
  }

  // ── §20 primary-per-slot uniqueness ────────────────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    // Try to plant a SECOND primary link on the same (branch, entity, role).
    let threw = false;
    try {
      db.run(
        `INSERT INTO media_links
          (tenant_id, link_id, scope_kind, branch_id, entity_type, entity_id, media_id, media_role, sort_order, is_primary, created_at)
         VALUES ('t1','manual','branch','b1','product','p1','media-req-1','stock_image', 0, 1, 'n')`,
      );
    } catch { threw = true; }
    ok(threw, 'two primary links on the same slot rejected by unique index');
  }

  // ── §21 gateway commit failure does not touch DB ───────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    fake.commitShouldThrow = 'MEDIA_INGEST_INVALID_STATE';
    await throws(
      'gateway commit throws → error surfaces, no DB write',
      'MEDIA_INGEST_INVALID_STATE',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-1' })),
    );
    const jobs = db.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0];
    ok(Number(jobs) === 0, `gateway commit error creates no job row (got ${jobs})`);
    fake.commitShouldThrow = null;
  }

  // ── §22 gallery contract: first image may not be non-primary ──────────
  // (3A-R1: isPrimary/sortOrder are real inputs now; what makes this illegal
  // is the POSITION — an empty gallery only accepts true/0.)
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await throws(
      'first image as non-primary → MEDIA_DB_MEDIA_CONFLICT',
      'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-1', isPrimary: false })),
    );
    const jobs = db.exec(`SELECT COUNT(*) FROM media_ingest_jobs`)[0].values[0][0];
    const links = db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0];
    const blobs = db.exec(`SELECT COUNT(*) FROM media_blobs`)[0].values[0][0];
    ok(Number(jobs) === 0 && Number(links) === 0 && Number(blobs) === 0,
      `no DB rows after position conflict (jobs=${jobs} links=${links} blobs=${blobs})`);
  }

  // ── §23 gallery contract: a sort_order gap is rejected ────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await throws(
      'sortOrder=7 on an empty gallery → MEDIA_DB_MEDIA_CONFLICT',
      'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-1', sortOrder: 7 })),
    );
    const rows = ['media_ingest_jobs','media_links','media_blobs','media_blob_generations','media_objects','media_variants']
      .map((t) => Number(db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0]));
    ok(rows.every((n) => n === 0), `no DB rows anywhere after position conflict (${rows.join(',')})`);
    // Structurally invalid values still fail earlier, as plain input errors.
    await throws(
      'negative sortOrder → MEDIA_INVALID_INPUT',
      'MEDIA_INVALID_INPUT',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-1', sortOrder: -1 })),
    );
    await throws(
      'non-integer sortOrder → MEDIA_INVALID_INPUT',
      'MEDIA_INVALID_INPUT',
      () => coord.finalize(baseInput({ ingestRequestId: 'req-1', sortOrder: 1.5 })),
    );
  }

  // ── §24 explicit canonical values are accepted ─────────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const r = await coord.finalize(baseInput({ ingestRequestId: 'req-1', isPrimary: true, sortOrder: 0 }));
    ok(r.state === 'ready', 'explicit isPrimary=true, sortOrder=0 finalize succeeds');
    const link = db.exec(`SELECT is_primary, sort_order FROM media_links WHERE link_id = $l`, [r.linkId])[0].values[0];
    ok(Number(link[0]) === 1 && Number(link[1]) === 0, `canonical link options persisted (is_primary=${link[0]}, sort_order=${link[1]})`);
  }

  // ── §25 undefined defaults to canonical constants ─────────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const inp = baseInput({ ingestRequestId: 'req-1' });
    delete (inp as any).isPrimary;
    // sortOrder is not set in baseInput by default already
    const r = await coord.finalize(inp);
    const link = db.exec(`SELECT is_primary, sort_order FROM media_links WHERE link_id = $l`, [r.linkId])[0].values[0];
    ok(Number(link[0]) === 1 && Number(link[1]) === 0, `undefined → canonical defaults (is_primary=${link[0]}, sort_order=${link[1]})`);
  }

  // ── §26 recover reproduces canonical link options exactly ─────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    // Half-finalize (job manifest only, no rows yet).
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id, requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-req-26','req-26', $h, 'branch','b1','product','p1','stock_image',
               'internal','standard',$intent,'accepted', 1, 'n','n')`,
      [HASH_REQ, intentJson()] as unknown[],
    );
    fake.presetIngest('t1', 'req-26', HASH_REQ, { main: MAIN, thumb: THUMB });
    const report = await coord.recover();
    ok(report[0].action === 'finalized_from_ready_rust', 'recover finalizes');
    const link = db.exec(`SELECT is_primary, sort_order FROM media_links WHERE deleted_at IS NULL`)[0].values[0];
    ok(Number(link[0]) === 1, `recovered link is_primary=1 (got ${link[0]})`);
    ok(Number(link[1]) === 0, `recovered link sort_order=0 (got ${link[1]})`);
  }

  // ── §27 export/reopen preserves canonical link options ────────────────
  {
    const { db, coord, fake } = await freshDb(SQL);
    fake.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    await coord.finalize(baseInput({ ingestRequestId: 'req-1' }));
    const image = db.export();
    const reopened = new (SQL as any).Database(image);
    const fake2 = new FakeMediaGateway();
    fake2.presetIngest('t1', 'req-1', HASH_REQ, { main: MAIN, thumb: THUMB });
    const coord2 = new MediaDbCoordinator(reopened, fake2);
    const r = await coord2.recover();
    ok(r[0].action === 'noop_already_ready', 'reopened DB: recover is no-op');
    const link = reopened.exec(`SELECT is_primary, sort_order FROM media_links WHERE deleted_at IS NULL`)[0].values[0];
    ok(Number(link[0]) === 1 && Number(link[1]) === 0, `reopened link stays canonical (${link[0]},${link[1]})`);
  }

  // ══ report ═══════════════════════════════════════════════════════════════
  console.log(`\nMEDIA-04A-2B1 coordinator: ${PASS}/${PASS + FAIL} checks passed`);
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
