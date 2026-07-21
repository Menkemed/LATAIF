// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3A-R2 — durable replace/remove + scope isolation + result_json
// Run: node test/media04a3ar2/replace-remove-scope.test.ts
//
// REAL sql.js in-memory, with an explicit "disk" (an exported image) so a
// crash is modelled honestly: whatever never reached `disk.image` is simply
// gone when the DB is reopened. No productive DB, no Tauri, no filesystem
// write outside the standard node temp dir.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import {
  MediaDbCoordinator,
  type FinalizeInput,
  type ReplaceInput,
} from '../../src/core/media/coordinator.ts';
import {
  StockMediaOrchestrator,
  type OrchestratorLease,
  type OrchestratorRawDb,
} from '../../src/core/media/orchestrator.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
async function throws(msg: string, expected: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); ok(false, `${msg} — expected ${expected}, got none`); }
  catch (e) {
    const code = (e as { code?: string; message?: string }).code ?? (e as Error).message;
    ok(code === expected, `${msg} — expected ${expected}, got ${code}`);
  }
}
function throwsSync(msg: string, expected: string, fn: () => unknown): void {
  try { fn(); ok(false, `${msg} — expected ${expected}, got none`); }
  catch (e) {
    const code = (e as { code?: string; message?: string }).code ?? (e as Error).message;
    ok(code === expected, `${msg} — expected ${expected}, got ${code}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

function pad64(seed: string): string {
  return (seed.toLowerCase().replace(/[^0-9a-f]/g, '0') + '0'.repeat(64)).slice(0, 64);
}
function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i + seed) & 0xff;
  return out;
}
/** One distinct image payload per index. */
function img(i: number) {
  return {
    reqHash: pad64(`cafe${i}`),
    main: { hash: pad64(`aa${i}`), bytes: bytesOf(50_000 + i, 1 + i), byte_size: 50_000 + i },
    thumb: { hash: pad64(`bb${i}`), bytes: bytesOf(15_000 + i, 2 + i), byte_size: 15_000 + i },
  };
}

/**
 * Two tenants, three branches, four products — the minimum shape that can
 * distinguish tenant A/B, global/branch and branch A/B in one fixture.
 *   t1 → b1 (p1, p2), b2 (q1)
 *   t2 → bx (px)
 */
function seedEntityStubs(db: any): void {
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  }
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`INSERT INTO tenants  (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1'),('bx','t2')`);
  db.run(`INSERT INTO products (id, branch_id, images) VALUES
            ('p1','b1','[]'),('p2','b1','[]'),('q1','b2','[]'),('px','bx','[]')`);
}

class FakeGateway implements MediaCommandGateway {
  private jobs = new Map<string, { hash: string; main: any; thumb: any; state: string }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  readonly calls: string[] = [];
  commitShouldThrow: string | null = null;
  readVerifiedShouldThrow: string | null = null;

  preset(scope: string, reqId: string, spec: ReturnType<typeof img>): void {
    this.jobs.set(`${scope}::${reqId}`, { hash: spec.reqHash, main: spec.main, thumb: spec.thumb, state: 'prepared' });
    this.files.set(`${scope}::${spec.main.hash}`, { bytes: spec.main.bytes, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${spec.thumb.hash}`, { bytes: spec.thumb.bytes, mime: 'image/jpeg', ext: 'jpg' });
  }
  hasFile(scope: string, hash: string): boolean { return this.files.has(`${scope}::${hash}`); }
  countCalls(prefix: string): number { return this.calls.filter((c) => c.startsWith(prefix)).length; }

  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    this.calls.push(`prepare:${i.ingestRequestId}`);
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    return {
      ingest_request_id: i.ingestRequestId,
      request_hash: i.requestHash,
      state: 'prepared',
      main_descriptor: desc(j.main.hash, j.main.byte_size, 800, 600),
      thumbnail_descriptor: desc(j.thumb.hash, j.thumb.byte_size, 200, 150),
    };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    this.calls.push(`commit:${i.ingestRequestId}`);
    if (this.commitShouldThrow) throw new Error(this.commitShouldThrow);
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    if (j.hash !== i.requestHash) throw new Error('MEDIA_INGEST_REQUEST_CONFLICT');
    j.state = 'published';
    return {
      state: 'published',
      main_descriptor: desc(j.main.hash, j.main.byte_size, 800, 600),
      thumbnail_descriptor: desc(j.thumb.hash, j.thumb.byte_size, 200, 150),
      main_storage_key: `${i.tenantScope}/${j.main.hash.slice(0, 2)}/${j.main.hash}.jpg`,
      thumbnail_storage_key: `${i.tenantScope}/${j.thumb.hash.slice(0, 2)}/${j.thumb.hash}.jpg`,
    };
  }
  async abortStockImage(i: AbortInput): Promise<AbortResult> {
    return { ingest_request_id: i.ingestRequestId, state: 'aborted' };
  }
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> {
    this.calls.push(`read:${i.hash}`);
    if (this.readVerifiedShouldThrow) throw new Error(this.readVerifiedShouldThrow);
    const f = this.files.get(`${i.tenantScope}::${i.hash}`);
    if (!f) throw new Error('MEDIA_FILE_MISSING');
    return { bytes: f.bytes, hash: i.hash, byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext };
  }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}
function desc(hash: string, size: number, w: number, h: number) {
  return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: w, height: h };
}

// ── the "disk" ──────────────────────────────────────────────────────────────
//
// A crash is modelled as: throw away the in-memory DB and reopen from
// `disk.image`. Anything a checkpoint never wrote is genuinely lost, which is
// the whole point — no test may quietly inherit in-memory state.

class Disk {
  image: Uint8Array | null = null;
  writes = 0;
  failOnWrite: number | null = null;
}

function leaseFor(db: OrchestratorRawDb, disk: Disk): OrchestratorLease {
  return {
    db,
    epoch: 0,
    async saveDurably() {
      disk.writes++;
      if (disk.failOnWrite !== null && disk.writes === disk.failOnWrite) {
        throw new Error('DISK_FULL');
      }
      disk.image = (db as unknown as { export(): Uint8Array }).export();
    },
    release() {},
  };
}

async function freshEnv(SQL: any) {
  const db = new SQL.Database();
  seedEntityStubs(db);
  applyMediaSchema(db);
  const gw = new FakeGateway();
  const disk = new Disk();
  const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
  return { db, gw, disk, orch, coord: new MediaDbCoordinator(db, gw) };
}

/** Reopen the persisted image as a brand-new DB + orchestrator, same gateway. */
function reopen(SQL: any, disk: Disk, gw: FakeGateway) {
  if (!disk.image) throw new Error('nothing was ever persisted');
  const db = new SQL.Database(disk.image);
  const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
  return { db, orch, coord: new MediaDbCoordinator(db, gw) };
}

// ── input helpers ───────────────────────────────────────────────────────────

function input(o: Partial<FinalizeInput> & { ingestRequestId: string; requestHash: string }): FinalizeInput {
  return {
    tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p1',
    scopeKind: 'branch', role: 'stock_image', ...o,
  };
}

/** Append image #i to a product's gallery through the ORCHESTRATOR (durable). */
async function append(
  orch: StockMediaOrchestrator, gw: FakeGateway, i: number,
  o: { entityId?: string; branchId?: string; tenantId?: string; slot?: number } = {},
) {
  const entityId = o.entityId ?? 'p1';
  const tenantId = o.tenantId ?? 't1';
  const slot = o.slot ?? i;
  const spec = img(i);
  const reqId = `req-${tenantId}-${entityId}-${i}`;
  gw.preset(tenantId, reqId, spec);
  return orch.ingestAndFinalizeStockImage({
    ...input({
      ingestRequestId: reqId, requestHash: spec.reqHash, entityId,
      tenantId, branchId: o.branchId ?? 'b1',
      isPrimary: slot === 0, sortOrder: slot,
    }),
    imageBytes: bytesOf(1000, i),
  });
}

function gallery(db: any, entityId = 'p1', tenantId = 't1'): Array<[string, number, number]> {
  const r = db.exec(
    `SELECT media_id, sort_order, is_primary FROM media_links
      WHERE tenant_id = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
    [tenantId, entityId]);
  return r.length ? (r[0].values as any[]).map((v) => [String(v[0]), Number(v[1]), Number(v[2])] as [string, number, number]) : [];
}
function linkCount(db: any, entityId = 'p1'): number {
  const r = db.exec(`SELECT COUNT(*) FROM media_links WHERE entity_id = ?`, [entityId]);
  return r.length ? Number(r[0].values[0][0]) : 0;
}
function jobState(db: any, reqId: string): string | null {
  const r = db.exec(`SELECT state FROM media_ingest_jobs WHERE ingest_request_id = ?`, [reqId]);
  return r.length ? String(r[0].values[0][0]) : null;
}
function resultJson(db: any, reqId: string): string | null {
  const r = db.exec(`SELECT result_json FROM media_ingest_jobs WHERE ingest_request_id = ?`, [reqId]);
  return r.length && r[0].values[0][0] != null ? String(r[0].values[0][0]) : null;
}
function plantJob(db: any, reqId: string, payload: string | null, o: { entityId?: string; hash?: string } = {}): void {
  db.run(
    `INSERT INTO media_ingest_jobs
      (tenant_id, job_id, ingest_request_id, request_hash, scope_kind, branch_id,
       requested_entity_type, requested_entity_id, requested_role,
       security_class, retention_class, transform_profile, result_json,
       state, attempt_count, created_at, started_at, updated_at)
     VALUES ('t1', ?, ?, ?, 'branch', 'b1', 'product', ?, 'stock_image',
             'internal', 'standard', 'stock_image', ?, 'accepted', 0, 'x', 'x', 'x')`,
    [`job-${reqId}`, reqId, o.hash ?? img(9).reqHash, o.entityId ?? 'p1', payload] as any[],
  );
}

/** A durable intent payload, exactly as the coordinator would write it. */
function intentJson(spec: ReturnType<typeof img>, extra: Record<string, unknown>): string {
  const d = (h: string, size: number, w: number, ht: number) => ({
    hash: h, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg',
    byte_size: size, width: w, height: ht,
    storage_key: `t1/${h.slice(0, 2)}/${h}.jpg`,
  });
  return JSON.stringify({
    kind: 'intent',
    main: d(spec.main.hash, spec.main.byte_size, 800, 600),
    thumbnail: d(spec.thumb.hash, spec.thumb.byte_size, 200, 150),
    ...extra,
  });
}

// ══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ════════════════════════════════════════════════════════════════════════
  // §1 — durable replace intent + recovery
  // ════════════════════════════════════════════════════════════════════════

  // ── §1a primary replace, crash BEFORE the Rust publish ────────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    for (let i = 0; i < 3; i++) await append(orch, gw, i);
    const reopened0 = reopen(SQL, disk, gw);
    const target = reopened0.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND sort_order=0 AND deleted_at IS NULL`);
    const primaryLinkId = String(target[0].values[0][0]);

    // Replace the PRIMARY. Commit fails → nothing published, disk holds cp1.
    const spec = img(50);
    gw.preset('t1', 'rep-primary', spec);
    gw.commitShouldThrow = 'MEDIA_INGEST_NOT_FOUND';
    const env = reopen(SQL, disk, gw);
    await throws('replace: commit failure surfaces', 'MEDIA_INGEST_NOT_FOUND', () =>
      env.orch.replaceStockImage({
        ...input({ ingestRequestId: 'rep-primary', requestHash: spec.reqHash }),
        previousLinkId: primaryLinkId, imageBytes: bytesOf(500, 7),
      }));

    // Reopen from the cp1 image: the intent must be there, gallery untouched.
    gw.commitShouldThrow = null;
    const after = reopen(SQL, disk, gw);
    ok(jobState(after.db, 'rep-primary') === 'accepted', 'cp1 intent survived the crash');
    const stored = JSON.parse(String(resultJson(after.db, 'rep-primary')));
    ok(stored.operation === 'replace', 'stored intent is operation=replace');
    ok(stored.previousLinkId === primaryLinkId, 'stored intent names the exact target link');
    ok(stored.linkIntent.sortOrder === 0 && stored.linkIntent.isPrimary === true,
      'stored intent inherited the primary slot');
    ok(gallery(after.db).length === 3, 'gallery still 3 links before recovery');

    // Recovery must REPLACE, not append.
    const rep = await after.orch.recoverPendingStockMedia();
    const mine = rep.dbReport.find((r) => r.ingestRequestId === 'rep-primary');
    ok(mine?.action === 'replaced_from_ready_rust', `recovery replays a replace (got ${mine?.action})`);
    const g = gallery(after.db);
    ok(g.length === 3, `gallery still exactly 3 after recovery (got ${g.length})`);
    ok(g[0][1] === 0 && g[0][2] === 1, 'new link took the primary slot 0');
    ok(g.map((x) => x[1]).join(',') === '0,1,2', `contiguous 0,1,2 (got ${g.map((x) => x[1]).join(',')})`);
    ok(g.filter((x) => x[2] === 1).length === 1, 'exactly one primary after recovery');
    ok(linkCount(after.db) === 4, 'retired link row is preserved (4 rows total)');
  }

  // ── §1b secondary replace, crash AFTER publish (cp2 fails) ────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    for (let i = 0; i < 4; i++) await append(orch, gw, i);
    const base = reopen(SQL, disk, gw);
    const t = base.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND sort_order=2 AND deleted_at IS NULL`);
    const secondaryLinkId = String(t[0].values[0][0]);

    const spec = img(51);
    gw.preset('t1', 'rep-sec', spec);
    const env = reopen(SQL, disk, gw);
    disk.failOnWrite = disk.writes + 2; // cp1 lands, cp2 explodes
    await throws('replace: cp2 failure surfaces as persist error', 'MEDIA_ORCH_DB_PERSIST_FAILED', () =>
      env.orch.replaceStockImage({
        ...input({ ingestRequestId: 'rep-sec', requestHash: spec.reqHash }),
        previousLinkId: secondaryLinkId, imageBytes: bytesOf(500, 8),
      }));
    disk.failOnWrite = null;

    const after = reopen(SQL, disk, gw);
    ok(gallery(after.db).length === 4, 'on-disk gallery is still at cp1 (4 links)');
    const rep = await after.orch.recoverPendingStockMedia();
    ok(rep.dbReport.find((r) => r.ingestRequestId === 'rep-sec')?.action === 'replaced_from_ready_rust',
      'cp2 failure converges as a replace');
    const g = gallery(after.db);
    ok(g.length === 4, `still 4 links (got ${g.length})`);
    ok(g[2][1] === 2 && g[2][2] === 0, 'replacement sits at the EXACT slot 2, non-primary');
    ok(g[0][2] === 1, 'primary is untouched at slot 0');
    ok(g.map((x) => x[1]).join(',') === '0,1,2,3', 'order preserved');
  }

  // ── §1c retry after a completed replace produces no duplicates ────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    for (let i = 0; i < 2; i++) await append(orch, gw, i);
    const b = reopen(SQL, disk, gw);
    const tid = String(b.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND sort_order=1 AND deleted_at IS NULL`)[0].values[0][0]);
    const spec = img(52);
    gw.preset('t1', 'rep-retry', spec);
    const env = reopen(SQL, disk, gw);
    const req = {
      ...input({ ingestRequestId: 'rep-retry', requestHash: spec.reqHash }),
      previousLinkId: tid, imageBytes: bytesOf(500, 9),
    };
    const r1 = await env.orch.replaceStockImage(req);
    const r2 = await env.orch.replaceStockImage(req);
    ok(r1.linkId === r2.linkId && r1.mediaId === r2.mediaId, 'retry returns the identical link/media');
    ok(gallery(env.db).length === 2, `retry left exactly 2 active links (got ${gallery(env.db).length})`);
    ok(linkCount(env.db) === 3, 'exactly one retired row, no duplicate insert');
    const g = gallery(env.db);
    ok(g[1][1] === 1 && g[1][2] === 0, 'replacement kept slot 1');
  }

  // ── §1d same request id, DIFFERENT target → conflict before publish ───
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    for (let i = 0; i < 3; i++) await append(orch, gw, i);
    const b = reopen(SQL, disk, gw);
    const ids = b.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL ORDER BY sort_order`);
    const link1 = String(ids[0].values[1][0]);
    const link2 = String(ids[0].values[2][0]);

    const spec = img(53);
    gw.preset('t1', 'rep-target', spec);
    const env = reopen(SQL, disk, gw);
    // Freeze an intent for link1, but never publish (commit fails).
    gw.commitShouldThrow = 'MEDIA_INGEST_NOT_FOUND';
    await throws('first attempt fails at commit', 'MEDIA_INGEST_NOT_FOUND', () =>
      env.orch.replaceStockImage({
        ...input({ ingestRequestId: 'rep-target', requestHash: spec.reqHash }),
        previousLinkId: link1, imageBytes: bytesOf(500, 10),
      }));
    gw.commitShouldThrow = null;

    const after = reopen(SQL, disk, gw);
    const before = gw.countCalls('commit:');
    await throws('same request id retargeted → conflict', 'MEDIA_DB_MEDIA_CONFLICT', () =>
      after.orch.replaceStockImage({
        ...input({ ingestRequestId: 'rep-target', requestHash: spec.reqHash }),
        previousLinkId: link2, imageBytes: bytesOf(500, 10),
      }));
    ok(gw.countCalls('commit:') === before, 'no Rust publish happened on the retarget attempt');
    ok(gallery(after.db).length === 3, 'gallery untouched by the rejected retarget');

    // The same rejection must hold at the coordinator's own replace entry.
    await throws('coordinator.replace retargeted → conflict', 'MEDIA_INGEST_REQUEST_CONFLICT', () =>
      after.coord.replace({
        ...input({ ingestRequestId: 'rep-target', requestHash: spec.reqHash }),
        previousLinkId: link2,
      } as ReplaceInput));
  }

  // ── §1e a frozen replace intent may not be finished as an append ──────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    await append(orch, gw, 0);
    const b = reopen(SQL, disk, gw);
    const tid = String(b.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`)[0].values[0][0]);
    const spec = img(54);
    gw.preset('t1', 'rep-op', spec);
    gw.commitShouldThrow = 'MEDIA_INGEST_NOT_FOUND';
    const env = reopen(SQL, disk, gw);
    await throws('freeze the replace intent', 'MEDIA_INGEST_NOT_FOUND', () =>
      env.orch.replaceStockImage({
        ...input({ ingestRequestId: 'rep-op', requestHash: spec.reqHash }),
        previousLinkId: tid, imageBytes: bytesOf(500, 11),
      }));
    gw.commitShouldThrow = null;
    const after = reopen(SQL, disk, gw);
    await throws('finalize() refuses a replace intent', 'MEDIA_INGEST_REQUEST_CONFLICT', () =>
      after.coord.finalize(input({
        ingestRequestId: 'rep-op', requestHash: spec.reqHash, isPrimary: true, sortOrder: 0,
      })));
    ok(gallery(after.db).length === 1, 'gallery unchanged by the refused append');
  }

  // ── §1f replace target vanished → left pending, never appended ────────
  {
    const { db, gw, coord } = await freshEnv(SQL);
    const spec = img(55);
    gw.preset('t1', 'rep-gone', spec);
    plantJob(db, 'rep-gone', intentJson(spec, {
      intentVersion: 3, operation: 'replace', previousLinkId: 'link-that-never-existed',
      linkIntent: { isPrimary: true, sortOrder: 0 },
    }), { hash: spec.reqHash });
    const rep = await coord.recover();
    const mine = rep.find((r) => r.ingestRequestId === 'rep-gone');
    ok(mine?.action === 'left_pending_replace_target_gone', `target gone → left pending (got ${mine?.action})`);
    ok(gallery(db).length === 0, 'nothing was appended for a dangling replace');
    ok(jobState(db, 'rep-gone') === 'accepted', 'job stays recoverable, not silently finished');
  }

  // ── §1g malformed replace intent fails closed ─────────────────────────
  {
    const { db, gw, coord } = await freshEnv(SQL);
    const spec = img(56);
    gw.preset('t1', 'rep-bad', spec);
    // operation=replace but no previousLinkId → ambiguous → corrupt
    plantJob(db, 'rep-bad', intentJson(spec, {
      intentVersion: 3, operation: 'replace', linkIntent: { isPrimary: true, sortOrder: 0 },
    }), { hash: spec.reqHash });
    const rep = await coord.recover();
    ok(rep.find((r) => r.ingestRequestId === 'rep-bad')?.action === 'left_pending_no_manifest',
      'replace without a target is not recoverable');
    ok(gallery(db).length === 0, 'no link created from a malformed replace intent');
    await throws('finalize on a corrupt intent fails closed', 'MEDIA_DB_MEDIA_CONFLICT', () =>
      coord.finalize(input({ ingestRequestId: 'rep-bad', requestHash: spec.reqHash })));
  }

  // ── §1h replace crossing scope is refused, nothing mutated ────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    await append(orch, gw, 0);
    const b = reopen(SQL, disk, gw);
    const tid = String(b.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`)[0].values[0][0]);
    const spec = img(57);
    gw.preset('t1', 'rep-scope', spec);
    gw.preset('t1', 'rep-scope2', spec);
    const env = reopen(SQL, disk, gw);
    const before = gw.countCalls('commit:');
    await throws('replace with a foreign branch → link not found', 'MEDIA_DB_LINK_NOT_FOUND', () =>
      env.orch.replaceStockImage({
        ...input({ ingestRequestId: 'rep-scope', requestHash: spec.reqHash, branchId: 'b2', entityId: 'q1' }),
        previousLinkId: tid, imageBytes: bytesOf(500, 12),
      }));
    await throws('replace with a foreign entity → link not found', 'MEDIA_DB_LINK_NOT_FOUND', () =>
      env.orch.replaceStockImage({
        ...input({ ingestRequestId: 'rep-scope2', requestHash: spec.reqHash, entityId: 'p2' }),
        previousLinkId: tid, imageBytes: bytesOf(500, 12),
      }));
    ok(gw.countCalls('commit:') === before, 'no publish for an out-of-scope replace');
    ok(gallery(env.db).length === 1 && gallery(env.db)[0][2] === 1, 'target gallery untouched');
  }

  // ════════════════════════════════════════════════════════════════════════
  // §2 — remove durability
  // ════════════════════════════════════════════════════════════════════════

  // ── §2a secondary remove survives a reopen ────────────────────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    for (let i = 0; i < 4; i++) await append(orch, gw, i);
    const env = reopen(SQL, disk, gw);
    const mid = String(env.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND sort_order=1 AND deleted_at IS NULL`)[0].values[0][0]);
    await env.orch.removeStockMediaLink({ tenantId: 't1', linkId: mid });

    const after = reopen(SQL, disk, gw);
    const g = gallery(after.db);
    ok(g.length === 3, `3 links survive the reopen (got ${g.length})`);
    ok(g.map((x) => x[1]).join(',') === '0,1,2', `compacted 0,1,2 (got ${g.map((x) => x[1]).join(',')})`);
    ok(g[0][2] === 1 && g.filter((x) => x[2] === 1).length === 1, 'primary unchanged at slot 0');
    ok(linkCount(after.db) === 4, 'retired row kept on disk');
  }

  // ── §2b primary remove + promotion survives a reopen ──────────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    for (let i = 0; i < 3; i++) await append(orch, gw, i);
    const env = reopen(SQL, disk, gw);
    const head = env.db.exec(
      `SELECT link_id, media_id FROM media_links WHERE entity_id='p1' AND sort_order=0 AND deleted_at IS NULL`);
    const headId = String(head[0].values[0][0]);
    const secondMedia = String(env.db.exec(
      `SELECT media_id FROM media_links WHERE entity_id='p1' AND sort_order=1 AND deleted_at IS NULL`)[0].values[0][0]);
    await env.orch.removeStockMediaLink({ tenantId: 't1', linkId: headId });

    const after = reopen(SQL, disk, gw);
    const g = gallery(after.db);
    ok(g.length === 2, `2 links survive (got ${g.length})`);
    ok(g[0][0] === secondMedia, 'the former second image was promoted to head');
    ok(g[0][1] === 0 && g[0][2] === 1, 'promoted link is primary at slot 0');
    ok(g.filter((x) => x[2] === 1).length === 1, 'exactly one primary after promotion');
    ok(g.map((x) => x[1]).join(',') === '0,1', 'compacted to 0,1');
  }

  // ── §2c removing the LAST image survives a reopen ─────────────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    await append(orch, gw, 0);
    const env = reopen(SQL, disk, gw);
    const only = String(env.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`)[0].values[0][0]);
    await env.orch.removeStockMediaLink({ tenantId: 't1', linkId: only });
    const after = reopen(SQL, disk, gw);
    ok(gallery(after.db).length === 0, 'gallery is empty after the reopen');
    ok(linkCount(after.db) === 1, 'the retired row survives as suppression evidence');
    // …and the resolver must NOT fall back to the legacy column.
    after.db.run(`UPDATE products SET images = '["data:image/png;base64,AAAA"]' WHERE id = 'p1'`);
    const resolver = new ProductMediaResolver({
      dbProvider: () => after.db, gateway: gw, tenantId: 't1', branchId: 'b1',
    });
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'none', `emptied gallery resolves to none, not legacy (got ${r.kind})`);
  }

  // ── §2d save failure is surfaced and the retry converges ──────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    for (let i = 0; i < 3; i++) await append(orch, gw, i);
    const env = reopen(SQL, disk, gw);
    const mid = String(env.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND sort_order=1 AND deleted_at IS NULL`)[0].values[0][0]);
    disk.failOnWrite = disk.writes + 1;
    await throws('remove save failure surfaces', 'MEDIA_ORCH_DB_PERSIST_FAILED', () =>
      env.orch.removeStockMediaLink({ tenantId: 't1', linkId: mid }));
    disk.failOnWrite = null;
    const stale = reopen(SQL, disk, gw);
    ok(gallery(stale.db).length === 3, 'on-disk gallery still has 3 links after the failed save');
    // Retry on the reopened instance (the in-memory one is discarded).
    await stale.orch.removeStockMediaLink({ tenantId: 't1', linkId: mid });
    const after = reopen(SQL, disk, gw);
    ok(gallery(after.db).length === 2, 'retry converged to 2 links');
    ok(gallery(after.db).map((x) => x[1]).join(',') === '0,1', 'retry left a compacted gallery');
  }

  // ── §2e a second identical remove is a no-op ──────────────────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    for (let i = 0; i < 3; i++) await append(orch, gw, i);
    const env = reopen(SQL, disk, gw);
    const mid = String(env.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND sort_order=1 AND deleted_at IS NULL`)[0].values[0][0]);
    await env.orch.removeStockMediaLink({ tenantId: 't1', linkId: mid });
    const snapshot = gallery(env.db).map((x) => x.join(':')).join('|');
    await env.orch.removeStockMediaLink({ tenantId: 't1', linkId: mid });
    ok(gallery(env.db).map((x) => x.join(':')).join('|') === snapshot,
      'second remove changed nothing (no double compaction)');
    ok(gallery(env.db).map((x) => x[1]).join(',') === '0,1', 'no negative sort_order after a repeat');
  }

  // ── §2f remove deletes NO physical file ───────────────────────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    await append(orch, gw, 0);
    const spec = img(0);
    const env = reopen(SQL, disk, gw);
    const only = String(env.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`)[0].values[0][0]);
    await env.orch.removeStockMediaLink({ tenantId: 't1', linkId: only });
    ok(gw.hasFile('t1', spec.main.hash), 'main rendition still on disk after remove');
    ok(gw.hasFile('t1', spec.thumb.hash), 'thumbnail still on disk after remove');
    const blobs = env.db.exec(`SELECT COUNT(*) FROM media_blobs WHERE deleted_at IS NULL`);
    ok(Number(blobs[0].values[0][0]) === 2, 'blob rows untouched by remove');
  }

  // ── §2g remove of an unknown link id ──────────────────────────────────
  {
    const { orch } = await freshEnv(SQL);
    await throws('remove of an unknown link → not found', 'MEDIA_DB_LINK_NOT_FOUND', () =>
      orch.removeStockMediaLink({ tenantId: 't1', linkId: 'nope' }));
  }

  // ════════════════════════════════════════════════════════════════════════
  // §3 — scope isolation
  // ════════════════════════════════════════════════════════════════════════

  // ── §3a tenant A ≠ tenant B, branch A ≠ branch B ──────────────────────
  {
    const { db, gw, orch } = await freshEnv(SQL);
    await append(orch, gw, 0, { entityId: 'p1', branchId: 'b1', tenantId: 't1' });
    await append(orch, gw, 1, { entityId: 'q1', branchId: 'b2', tenantId: 't1', slot: 0 });
    await append(orch, gw, 2, { entityId: 'px', branchId: 'bx', tenantId: 't2', slot: 0 });
    ok(gallery(db, 'p1', 't1').length === 1, 'b1/p1 has its own single link');
    ok(gallery(db, 'q1', 't1').length === 1, 'b2/q1 has its own single link');
    ok(gallery(db, 'px', 't2').length === 1, 't2/px has its own single link');

    // Removing b2's link must not touch b1's or t2's.
    const q = String(db.exec(`SELECT link_id FROM media_links WHERE entity_id='q1' AND deleted_at IS NULL`)[0].values[0][0]);
    await orch.removeStockMediaLink({ tenantId: 't1', linkId: q });
    ok(gallery(db, 'q1', 't1').length === 0, 'b2 gallery emptied');
    ok(gallery(db, 'p1', 't1').length === 1, 'b1 gallery untouched by the b2 remove');
    ok(gallery(db, 'px', 't2').length === 1, 't2 gallery untouched by the t1 remove');

    // The same link id under the WRONG tenant resolves to nothing.
    const p = String(db.exec(`SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`)[0].values[0][0]);
    await throws('remove with the wrong tenant → not found', 'MEDIA_DB_LINK_NOT_FOUND', () =>
      orch.removeStockMediaLink({ tenantId: 't2', linkId: p }));
    ok(gallery(db, 'p1', 't1').length === 1, 'wrong-tenant remove mutated nothing');
  }

  // ── §3b product media is branch-scoped ONLY (schema-enforced) ─────────
  {
    const { gw, coord } = await freshEnv(SQL);
    const spec = img(60);
    gw.preset('t1', 'glob-1', spec);
    await throws('tenant-scoped product link is rejected', 'MEDIA_INVALID_INPUT', () =>
      coord.finalize(input({
        ingestRequestId: 'glob-1', requestHash: spec.reqHash,
        scopeKind: 'tenant', branchId: 'b1',
      })));
    // …and even with a structurally legal tenant-scope input the DB refuses.
    await throws('tenant-scoped product link aborts at the trigger', 'MEDIA_ENTITY_SCOPE_KIND', () =>
      coord.finalize(input({
        ingestRequestId: 'glob-1', requestHash: spec.reqHash,
        scopeKind: 'tenant', branchId: null,
      })));
    throwsSync('resolver without a branch is refused', 'MEDIA_RESOLVER_SCOPE_REQUIRED', () =>
      new ProductMediaResolver({
        dbProvider: () => null as any, gateway: gw, tenantId: 't1', branchId: '',
      }));
    throwsSync('resolver without a tenant is refused', 'MEDIA_RESOLVER_SCOPE_REQUIRED', () =>
      new ProductMediaResolver({
        dbProvider: () => null as any, gateway: gw, tenantId: '', branchId: 'b1',
      }));
  }

  // ── §3c the resolver reads exactly one scope ──────────────────────────
  {
    const { db, gw, orch } = await freshEnv(SQL);
    await append(orch, gw, 0, { entityId: 'p1', branchId: 'b1' });
    await append(orch, gw, 3, { entityId: 'q1', branchId: 'b2', slot: 0 });
    const r1 = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' });
    const r2 = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b2' });
    const a = await r1.resolveProductMedia('p1');
    const b = await r2.resolveProductMedia('q1');
    ok(a.kind === 'media' && a.items.length === 1, 'b1 resolver sees b1 gallery');
    ok(b.kind === 'media' && b.items.length === 1, 'b2 resolver sees b2 gallery');
    ok(a.kind === 'media' && b.kind === 'media' && a.items[0].mediaId !== b.items[0].mediaId,
      'the two branches resolve to different media');
    const cross = await r2.resolveProductMedia('p1');
    ok(cross.kind === 'none', `b2 resolver sees nothing of b1's product (got ${cross.kind})`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // §4 — legacy leak prevention
  // ════════════════════════════════════════════════════════════════════════

  // ── §4a wrong tenant must not read the legacy column ──────────────────
  {
    const { db, gw } = await freshEnv(SQL);
    db.run(`UPDATE products SET images = '["data:image/png;base64,SECRET"]' WHERE id = 'p1'`);
    const right = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' });
    const wrong = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't2', branchId: 'b1' });
    const a = await right.resolveProductMedia('p1');
    ok(a.kind === 'legacy' && a.items.length === 1, 'the owning tenant reads its legacy images');
    const b = await wrong.resolveProductMedia('p1');
    ok(b.kind === 'none', `a foreign tenant reads nothing (got ${b.kind})`);
  }

  // ── §4b wrong branch must not read the legacy column ──────────────────
  {
    const { db, gw } = await freshEnv(SQL);
    db.run(`UPDATE products SET images = '["data:image/png;base64,SECRET"]' WHERE id = 'p1'`);
    const wrong = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b2' });
    const b = await wrong.resolveProductMedia('p1');
    ok(b.kind === 'none', `a foreign branch reads no legacy images (got ${b.kind})`);
  }

  // ── §4c an out-of-scope link must not suppress this scope's legacy ────
  //
  // The media_links entity-scope triggers make a cross-scope row impossible
  // through the normal path — which is exactly why they are dropped in THIS
  // fixture only: the point is to prove the resolver's own scope binding,
  // not to re-prove the trigger.
  {
    const { db, gw, orch } = await freshEnv(SQL);
    await append(orch, gw, 0, { entityId: 'p1', branchId: 'b1' });
    db.run(`UPDATE products SET images = '["data:image/png;base64,LEGACY"]' WHERE id = 'q1'`);
    db.run(`DROP TRIGGER trg_ml_entity_scope_ins`);
    db.run(`INSERT INTO media_links
              (tenant_id, link_id, scope_kind, branch_id, entity_type, entity_id,
               media_id, media_role, sort_order, is_primary, created_at)
            VALUES ('t1','planted-b1','branch','b1','product','q1',
                    'media-x','stock_image',0,1,'x')`);
    const r2 = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b2' });
    const out = await r2.resolveProductMedia('q1');
    ok(out.kind === 'legacy', `a b1 link does not suppress q1's b2 legacy (got ${out.kind})`);
    // …while the branch that DOES own the row still sees it as migrated.
    const r1 = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' });
    const inside = await r1.resolveProductMedia('q1');
    ok(inside.kind !== 'legacy', `the owning branch does not fall back to legacy (got ${inside.kind})`);
  }

  // ── §4d a retired link in the SAME scope suppresses legacy ────────────
  {
    const { db, gw, disk, orch } = await freshEnv(SQL);
    await append(orch, gw, 0, { entityId: 'p1', branchId: 'b1' });
    const only = String(db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`)[0].values[0][0]);
    await orch.removeStockMediaLink({ tenantId: 't1', linkId: only });
    void disk;
    db.run(`UPDATE products SET images = '["data:image/png;base64,OLD"]' WHERE id = 'p1'`);
    const r = new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' });
    const out = await r.resolveProductMedia('p1');
    ok(out.kind === 'none', `a deliberately emptied gallery stays empty (got ${out.kind})`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // §5 — result_json compatibility + fail-closed matrix
  // ════════════════════════════════════════════════════════════════════════

  // ── §5a v1 payload (no linkIntent, no operation) → append true/0 ──────
  {
    const { db, gw, coord } = await freshEnv(SQL);
    const spec = img(70);
    gw.preset('t1', 'v1', spec);
    plantJob(db, 'v1', intentJson(spec, {}), { hash: spec.reqHash });
    const rep = await coord.recover();
    ok(rep.find((r) => r.ingestRequestId === 'v1')?.action === 'finalized_from_ready_rust',
      'a v1 payload recovers as an append');
    const g = gallery(db);
    ok(g.length === 1 && g[0][1] === 0 && g[0][2] === 1, 'v1 lands at the first-image slot true/0');
  }

  // ── §5b v2 payload (linkIntent, no operation) → append at that slot ───
  {
    const { db, gw, orch, coord } = await freshEnv(SQL);
    await append(orch, gw, 0);
    const spec = img(71);
    gw.preset('t1', 'v2', spec);
    plantJob(db, 'v2', intentJson(spec, {
      intentVersion: 2, linkIntent: { isPrimary: false, sortOrder: 1 },
    }), { hash: spec.reqHash });
    const rep = await coord.recover();
    ok(rep.find((r) => r.ingestRequestId === 'v2')?.action === 'finalized_from_ready_rust',
      'a v2 payload recovers as an append');
    const g = gallery(db);
    ok(g.length === 2 && g[1][1] === 1 && g[1][2] === 0, 'v2 lands at its frozen slot 1');
  }

  // ── §5c the fail-closed matrix ────────────────────────────────────────
  {
    const spec = img(72);
    const cases: Array<[string, string | null]> = [
      ['non-JSON', 'this is not json'],
      ['unknown kind', JSON.stringify({ kind: 'whatever', main: {}, thumbnail: {} })],
      ['no kind at all', JSON.stringify({ main: {}, thumbnail: {} })],
      ['JSON array', JSON.stringify([1, 2, 3])],
      ['unknown intentVersion', intentJson(spec, { intentVersion: 99, linkIntent: { isPrimary: true, sortOrder: 0 } })],
      ['unknown operation', intentJson(spec, { intentVersion: 3, operation: 'reorder', linkIntent: { isPrimary: true, sortOrder: 0 } })],
      ['replace without target', intentJson(spec, { intentVersion: 3, operation: 'replace', linkIntent: { isPrimary: true, sortOrder: 0 } })],
      ['append WITH a target', intentJson(spec, { intentVersion: 3, operation: 'append', previousLinkId: 'l1', linkIntent: { isPrimary: true, sortOrder: 0 } })],
      ['fractional sortOrder', intentJson(spec, { intentVersion: 2, linkIntent: { isPrimary: true, sortOrder: 1.5 } })],
      ['negative sortOrder', intentJson(spec, { intentVersion: 2, linkIntent: { isPrimary: true, sortOrder: -1 } })],
      ['isPrimary as a number', intentJson(spec, { intentVersion: 2, linkIntent: { isPrimary: 1, sortOrder: 0 } })],
      ['result without identity', JSON.stringify({ kind: 'result', value: { mediaId: 'm' } })],
      ['result with a bad linkIntent', JSON.stringify({ kind: 'result', value: { jobId: 'j', ingestRequestId: 'x', requestHash: 'h', state: 'ready', mediaId: 'm', linkId: 'l', linkIntent: { isPrimary: 'yes', sortOrder: 0 } } })],
    ];
    for (const [label, payload] of cases) {
      const { db, gw, coord } = await freshEnv(SQL);
      gw.preset('t1', 'bad', spec);
      plantJob(db, 'bad', payload, { hash: spec.reqHash });
      await throws(`finalize fails closed: ${label}`, 'MEDIA_DB_MEDIA_CONFLICT', () =>
        coord.finalize(input({ ingestRequestId: 'bad', requestHash: spec.reqHash })));
      const rep = await coord.recover();
      ok(rep.find((r) => r.ingestRequestId === 'bad')?.action === 'left_pending_no_manifest',
        `recover fails closed: ${label}`);
      ok(gallery(db).length === 0, `no link created from: ${label}`);
    }
  }

  // ── §5d a 'ready' job whose payload is an intent is not a result ──────
  {
    const { db, gw, coord } = await freshEnv(SQL);
    const spec = img(73);
    gw.preset('t1', 'mix', spec);
    plantJob(db, 'mix', intentJson(spec, {
      intentVersion: 3, operation: 'append', linkIntent: { isPrimary: true, sortOrder: 0 },
    }), { hash: spec.reqHash });
    db.run(`UPDATE media_ingest_jobs SET state='ready' WHERE ingest_request_id='mix'`);
    // state=ready but no frozen RESULT → the coordinator must not hand back a
    // fabricated one; it re-enters the finalize path instead.
    const out = await coord.finalize(input({ ingestRequestId: 'mix', requestHash: spec.reqHash }));
    ok(out.state === 'ready' && out.linkId.length > 0, 'an intent under state=ready is never read as a result');
    ok(gallery(db).length === 1, 'the re-entered finalize produced exactly one link');
  }

  // ── §5e round-trip: a real replace writes a v3 payload ────────────────
  {
    const { gw, disk, orch } = await freshEnv(SQL);
    await append(orch, gw, 0);
    const env = reopen(SQL, disk, gw);
    const tid = String(env.db.exec(
      `SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`)[0].values[0][0]);
    const spec = img(74);
    gw.preset('t1', 'v3', spec);
    gw.commitShouldThrow = 'MEDIA_INGEST_NOT_FOUND';
    await throws('freeze v3', 'MEDIA_INGEST_NOT_FOUND', () =>
      env.orch.replaceStockImage({
        ...input({ ingestRequestId: 'v3', requestHash: spec.reqHash }),
        previousLinkId: tid, imageBytes: bytesOf(200, 3),
      }));
    gw.commitShouldThrow = null;
    const after = reopen(SQL, disk, gw);
    const p = JSON.parse(String(resultJson(after.db, 'v3')));
    ok(p.kind === 'intent', 'payload is an intent envelope');
    ok(p.intentVersion === 3, `payload is v3 (got ${p.intentVersion})`);
    ok(p.operation === 'replace' && p.previousLinkId === tid, 'payload carries operation + target');
    ok(p.main && p.thumbnail && p.linkIntent, 'payload carries descriptors + slot');
    ok(!('bytes' in p.main) && !('bytes' in p.thumbnail), 'payload holds no image bytes');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('');
  if (FAIL > 0) {
    console.log(`MEDIA-04A-3A-R2 replace/remove/scope: ${PASS} passed, ${FAIL} FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`MEDIA-04A-3A-R2 replace/remove/scope: ${PASS}/${PASS} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
