// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2B — durable new-product-with-media create flow
// Run: node test/media04a3b2b/create.test.ts
//
// End-to-end through the REAL create flow + ProductMediaCutoverService +
// StockMediaOrchestrator + MediaDbCoordinator against REAL sql.js. A
// deterministic fake gateway stands in for the Rust bridge; an explicit "disk"
// (exported image) models a crash — only checkpoint-persisted state survives a
// reopen. The pure UI decision is unit-tested separately.
//
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
} from '../../src/core/media/orchestrator.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import {
  createProductWithDurableMedia,
  decideProductCreateUi,
  sameImageIntent,
  shouldStartEmbedding,
  type ProductCreateResult,
} from '../../src/core/media/product-media-create.ts';
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

// ── image fixtures ──────────────────────────────────────────────────────────
function dataUrl(seed: string): string {
  const bytes = new Uint8Array(24);
  for (let i = 0; i < 24; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
}
function sha256Hex(b: Uint8Array): string { return createHash('sha256').update(Buffer.from(b)).digest('hex'); }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainB: Uint8Array; thumbB: Uint8Array }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  private reqBytes = new Map<string, Uint8Array>();
  commitShouldThrowFor: string | null = null;
  readonly commits: string[] = [];
  private rend(scope: string, input: Uint8Array) {
    const h = sha256Hex(input);
    let r = this.byHash.get(h);
    if (!r) {
      r = { main: sha256Hex(concat(input, new Uint8Array([1]))), thumb: sha256Hex(concat(input, new Uint8Array([2]))), mainB: concat(input, new Uint8Array([0xaa])), thumbB: concat(input, new Uint8Array([0xbb])) };
      this.byHash.set(h, r);
    }
    this.files.set(`${scope}::${r.main}`, { bytes: r.mainB, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${r.thumb}`, { bytes: r.thumbB, mime: 'image/jpeg', ext: 'jpg' });
    return r;
  }
  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    this.reqBytes.set(`${i.tenantScope}::${i.ingestRequestId}`, i.imageBytes);
    const r = this.rend(i.tenantScope, i.imageBytes);
    return { ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared', main_descriptor: desc(r.main, r.mainB.length, 800, 600), thumbnail_descriptor: desc(r.thumb, r.thumbB.length, 200, 150) };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    this.commits.push(i.ingestRequestId);
    if (this.commitShouldThrowFor === i.ingestRequestId) throw new Error('MEDIA_INGEST_NOT_FOUND');
    const bytes = this.reqBytes.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!bytes) throw new Error('MEDIA_INGEST_NOT_FOUND');
    const r = this.rend(i.tenantScope, bytes);
    return { state: 'published', main_descriptor: desc(r.main, r.mainB.length, 800, 600), thumbnail_descriptor: desc(r.thumb, r.thumbB.length, 200, 150), main_storage_key: `${i.tenantScope}/${r.main.slice(0, 2)}/${r.main}.jpg`, thumbnail_storage_key: `${i.tenantScope}/${r.thumb.slice(0, 2)}/${r.thumb}.jpg` };
  }
  async abortStockImage(i: AbortInput): Promise<AbortResult> { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> {
    const f = this.files.get(`${i.tenantScope}::${i.hash}`);
    if (!f) throw new Error('MEDIA_FILE_MISSING');
    return { bytes: f.bytes, hash: i.hash, byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext };
  }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}
function desc(hash: string, size: number, w: number, h: number) { return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: w, height: h }; }

class Disk { image: Uint8Array | null = null; writes = 0; failOnWrite: number | null = null; }
function leaseFor(db: OrchestratorRawDb, disk: Disk): OrchestratorLease {
  return { db, epoch: 0, async saveDurably() { disk.writes++; if (disk.failOnWrite !== null && disk.writes === disk.failOnWrite) throw new Error('DISK_FULL'); disk.image = (db as unknown as { export(): Uint8Array }).export(); }, release() {} };
}

function seed(db: any): void {
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('bx','t2')`);
}
function reopen(SQL: any, disk: Disk) { if (!disk.image) throw new Error('nothing persisted'); return new SQL.Database(disk.image); }
async function testHash(bytes: Uint8Array): Promise<string> { return sha256Hex(bytes); }

function productImages(db: any, id: string): string | null {
  const r = db.exec(`SELECT images FROM products WHERE id=?`, [id]);
  return r.length ? String(r[0].values[0][0]) : null;
}
function activeLinks(db: any, id: string): number {
  const r = db.exec(`SELECT COUNT(*) FROM media_links WHERE entity_id=? AND deleted_at IS NULL`, [id]);
  return r.length ? Number(r[0].values[0][0]) : 0;
}
function totalLinks(db: any, id: string): number {
  const r = db.exec(`SELECT COUNT(*) FROM media_links WHERE entity_id=?`, [id]);
  return r.length ? Number(r[0].values[0][0]) : 0;
}
function productCount(db: any, id: string): number {
  const r = db.exec(`SELECT COUNT(*) FROM products WHERE id=?`, [id]);
  return r.length ? Number(r[0].values[0][0]) : 0;
}

const ROLE = 'stock_image';
function batchIdOf(tenantId: string, branchId: string, pid: string) { return `create:${tenantId}:${branchId}:${pid}:${ROLE}`; }

/** Build the durable-batch create deps against a db + orchestrator, mirroring
 *  the store wiring (buildBatchItems + prepareAndRegisterBatch + finalizeBatch). */
function makeDeps(db: any, gw: FakeGateway, disk: Disk, opts: { tenantId?: string; branchId?: string; embedCalls?: { n: number }; expectedImages?: string[]; failProductSave?: boolean } = {}) {
  const tenantId = opts.tenantId ?? 't1';
  const branchId = opts.branchId ?? 'b1';
  const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
  const inserted: string[] = [];
  const succeeded: string[] = [];
  const embedded = new Set<string>();
  const inFlight = new Set<string>();
  return {
    orch,
    deps: {
      expectedImages: opts.expectedImages,
      productExists: (pid: string) => productCount(db, pid) > 0,
      insertProductRow: (pid: string) => {
        db.run(`INSERT INTO products (id, branch_id, images) VALUES (?, ?, '[]')`, [pid, branchId]);
      },
      rollbackProductRow: (pid: string) => {
        db.run(`DELETE FROM products WHERE id=?`, [pid]);
        db.run(`DELETE FROM media_ingest_jobs WHERE requested_entity_id=? AND requested_role=? AND tenant_id=? AND branch_id=?`, [pid, ROLE, tenantId, branchId]);
      },
      saveDurably: async () => { if (opts.failProductSave) throw new Error('DISK_FULL'); disk.writes++; disk.image = db.export(); },
      buildBatchItems: async (pid: string, images: any[]) => {
        const items: any[] = [];
        for (let i = 0; i < images.length; i++) {
          const bytes = images[i].bytes;
          items.push({
            tenantId, branchId, entityType: 'product', entityId: pid, scopeKind: 'branch', role: ROLE,
            ingestRequestId: `create:${tenantId}:${branchId}:${pid}:${ROLE}:${i}`,
            requestHash: await testHash(bytes),
            isPrimary: i === 0, sortOrder: i, imageBytes: bytes,
            batch: { batchId: batchIdOf(tenantId, branchId, pid), expectedCount: images.length },
          });
        }
        return items;
      },
      prepareAndRegisterBatch: (items: any[]) => orch.prepareAndRegisterBatch(items),
      finalizeBatch: (items: any[]) => orch.finalizeBatch(items),
      onProductInserted: (pid: string) => { inserted.push(pid); },
      onFullSuccess: (pid: string, first?: string) => {
        succeeded.push(pid);
        if (shouldStartEmbedding({ configured: true, hasImage: !!first, alreadyComputed: embedded.has(pid), inFlight: inFlight.has(pid) })) {
          if (opts.embedCalls) opts.embedCalls.n++;
          embedded.add(pid);
        }
      },
    },
    inserted, succeeded, embedded,
  };
}

// ══════════════════════════════════════════════════════════════════════════

// ── recovery + inspection helpers ────────────────────────────────────────────
async function recover(orch: StockMediaOrchestrator) { return orch.recoverPendingStockMedia(); }
function acceptedJobs(db: any, pid: string): number {
  const r = db.exec(`SELECT COUNT(*) FROM media_ingest_jobs WHERE requested_entity_id=? AND state='accepted'`, [pid]);
  return r.length ? Number(r[0].values[0][0]) : 0;
}
function jobRows(db: any, pid: string): number {
  const r = db.exec(`SELECT COUNT(*) FROM media_ingest_jobs WHERE requested_entity_id=?`, [pid]);
  return r.length ? Number(r[0].values[0][0]) : 0;
}
function orderOf(db: any, pid: string): string {
  const r = db.exec(`SELECT sort_order FROM media_links WHERE entity_id=? AND deleted_at IS NULL ORDER BY sort_order`, [pid]);
  return r.length ? (r[0].values as any[]).map((v) => Number(v[0])).join(',') : '';
}
function batchOf(db: any, reqId: string): any {
  const r = db.exec(`SELECT result_json FROM media_ingest_jobs WHERE ingest_request_id=?`, [reqId]);
  if (!r.length || r[0].values[0][0] == null) return null;
  return JSON.parse(String(r[0].values[0][0])).batch ?? null;
}
async function freshEnv(SQL: any, opts: any = {}) {
  const db = new SQL.Database(); seed(db); applyMediaSchema(db);
  const gw = new FakeGateway(); const disk = new Disk();
  const w = makeDeps(db, gw, disk, opts);
  return { db, gw, disk, ...w };
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 product with 3 images → images='[]', media 0/1/2, durable batch ─
  {
    const { db, gw, deps, inserted, succeeded } = await freshEnv(SQL);
    const res = await createProductWithDurableMedia('p1', [0, 1, 2].map((i) => dataUrl(`p1-${i}`)), deps);
    ok(res.status === 'created', `created (got ${res.status})`);
    ok(productImages(db, 'p1') === '[]', 'products.images empty — no base64');
    ok(activeLinks(db, 'p1') === 3 && orderOf(db, 'p1') === '0,1,2', 'media 0,1,2');
    ok(inserted.length === 1 && succeeded.length === 1, 'insert + full-success once');
    const r = await new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }).resolveProductMedia('p1');
    ok(r.kind === 'media' && r.items.length === 3, 'resolver shows the gallery');
  }

  // ── §2 no images → normal create, no media ────────────────────────────
  {
    const { db, gw, deps, inserted } = await freshEnv(SQL);
    const res = await createProductWithDurableMedia('p1', [], deps);
    ok(res.status === 'created', 'no-image create ok');
    ok(productImages(db, 'p1') === '[]' && activeLinks(db, 'p1') === 0, 'no media');
    ok(gw.commits.length === 0 && inserted.length === 1, 'no publish, inserted once');
  }

  // ── §3 batch checkpoint failure (fresh) → product_save_failed, no ghost ─
  {
    const { db, gw, disk, deps, inserted, succeeded } = await freshEnv(SQL);
    disk.failOnWrite = 1; // cp1 (first durable save) fails
    const res = await createProductWithDurableMedia('p1', [dataUrl('x0'), dataUrl('x1')], deps);
    ok(res.status === 'product_save_failed', `product_save_failed (got ${res.status})`);
    ok(productCount(db, 'p1') === 0, 'NO ghost product row');
    ok(jobRows(db, 'p1') === 0, 'NO orphan ingest jobs');
    ok(gw.commits.length === 0, 'no publish');
    ok(inserted.length === 0 && succeeded.length === 0, 'no insert/success side effects');
  }

  // ── §4 finalize failure after durable batch → media_incomplete ────────
  {
    const { db, gw, deps, inserted, succeeded } = await freshEnv(SQL);
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:0`;
    const res = await createProductWithDurableMedia('p1', [dataUrl('m0'), dataUrl('m1')], deps);
    ok(res.status === 'media_incomplete', `media_incomplete (got ${res.status})`);
    ok(productCount(db, 'p1') === 1 && productImages(db, 'p1') === '[]', 'product durable, no base64');
    ok(inserted.length === 1 && succeeded.length === 0, 'inserted once, no full success');
    ok(acceptedJobs(db, 'p1') >= 1, 'accepted job(s) remain for recovery');
  }

  // ══════════════════════════════════════════════════════════════════════
  // R2 — durable batch recovery after restart (no JS map)
  // ══════════════════════════════════════════════════════════════════════

  // ── §R2a reopen BEFORE any publish → recovery finishes all 3 ──────────
  {
    const { db, gw, disk, deps } = await freshEnv(SQL);
    const origCommit = gw.commitStockImage.bind(gw);
    (gw as any).commitStockImage = async (i: any) => { gw.commits.push(i.ingestRequestId); throw new Error('MEDIA_INGEST_NOT_FOUND'); };
    const res = await createProductWithDurableMedia('p1', [0, 1, 2].map((i) => dataUrl(`ra-${i}`)), deps);
    ok(res.status === 'media_incomplete', 'batch durable but publish failed');
    ok(acceptedJobs(db, 'p1') === 3, '3 accepted jobs durable');
    ok(activeLinks(db, 'p1') === 0, 'nothing published yet');
    // Every accepted slot carries the durable batch grouping (batchId + count).
    const b0 = batchOf(db, `create:t1:b1:p1:${ROLE}:0`);
    const b2 = batchOf(db, `create:t1:b1:p1:${ROLE}:2`);
    ok(b0 && b0.batchId === batchIdOf('t1', 'b1', 'p1') && b0.expectedCount === 3, 'slot 0 bound to batch (id + expectedCount=3)');
    ok(b2 && b2.expectedCount === 3, 'slot 2 bound to the same batch count');
    const db2 = reopen(SQL, disk);
    ok(acceptedJobs(db2, 'p1') === 3 && productCount(db2, 'p1') === 1, 'reopen: product + 3 intents durable');
    (gw as any).commitStockImage = origCommit; // heal the gateway (bytes still staged)
    const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db2, disk2) });
    const rep = await recover(orch2);
    ok(rep.dbChanged, 'recovery changed the DB');
    ok(activeLinks(db2, 'p1') === 3 && orderOf(db2, 'p1') === '0,1,2', 'recovery finished ALL 3 in order');
    ok(jobRows(db2, 'p1') === 3, 'no duplicate jobs after recovery');
  }

  // ── §R2b reopen after image 1 → recovery finishes 0,1,2 ───────────────
  {
    const { db, gw, disk, deps } = await freshEnv(SQL);
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:1`; // slot 0 publishes, slot 1 fails
    const res = await createProductWithDurableMedia('p1', [0, 1, 2].map((i) => dataUrl(`rb-${i}`)), deps);
    ok(res.status === 'media_incomplete', 'partial at slot 1');
    ok(activeLinks(db, 'p1') === 1, 'image 0 durable');
    const db2 = reopen(SQL, disk);
    ok(activeLinks(db2, 'p1') === 1 && acceptedJobs(db2, 'p1') === 2, 'reopen: 1 link + 2 accepted');
    gw.commitShouldThrowFor = null;
    const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db2, disk2) });
    await recover(orch2);
    ok(activeLinks(db2, 'p1') === 3 && orderOf(db2, 'p1') === '0,1,2', 'recovery completed 0,1,2');
    ok(jobRows(db2, 'p1') === 3, 'no duplicate jobs/links');
  }

  // ── §R2c reopen after image 2 (of 3) → recovery finishes slot 2 ───────
  {
    const { db, gw, disk, deps } = await freshEnv(SQL);
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:2`;
    await createProductWithDurableMedia('p1', [0, 1, 2].map((i) => dataUrl(`rc-${i}`)), deps);
    ok(activeLinks(db, 'p1') === 2, 'images 0,1 durable');
    const db2 = reopen(SQL, disk);
    gw.commitShouldThrowFor = null;
    const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db2, disk2) });
    await recover(orch2);
    ok(activeLinks(db2, 'p1') === 3 && orderOf(db2, 'p1') === '0,1,2', 'recovery completed the last slot');
    ok(totalLinks(db2, 'p1') === 3, 'no duplicate links');
  }

  // ── §R2d JS retry-map fully lost → recovery still works from DB alone ──
  {
    const { db, gw, disk, deps } = await freshEnv(SQL);
    const origCommit = gw.commitStockImage.bind(gw);
    (gw as any).commitStockImage = async (i: any) => { gw.commits.push(i.ingestRequestId); throw new Error('boom'); };
    await createProductWithDurableMedia('p1', [0, 1].map((i) => dataUrl(`rd-${i}`)), deps);
    const db2 = reopen(SQL, disk);
    ok(acceptedJobs(db2, 'p1') === 2, '2 intents durable, recoverable from DB alone');
    (gw as any).commitStockImage = origCommit;
    const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db2, disk2) });
    await recover(orch2); // NO retryProductId, NO expectedImages, NO JS map consulted
    ok(activeLinks(db2, 'p1') === 2 && orderOf(db2, 'p1') === '0,1', 'recovery completed with no JS state');
  }

  // ── §R2e same-batch retry (same session) → no 2nd product / dup links ─
  {
    const { db, gw, deps } = await freshEnv(SQL);
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:1`;
    const first = await createProductWithDurableMedia('p1', [0, 1, 2].map((i) => dataUrl(`re-${i}`)), deps);
    ok(first.status === 'media_incomplete', 'first partial');
    gw.commitShouldThrowFor = null;
    const second = await createProductWithDurableMedia('p1', [0, 1, 2].map((i) => dataUrl(`re-${i}`)), deps);
    ok(second.status === 'created', 'retry created');
    ok(productCount(db, 'p1') === 1, 'exactly one product');
    ok(activeLinks(db, 'p1') === 3 && totalLinks(db, 'p1') === 3, '3 links, no duplicates');
  }

  // ── §R2f different image/hash in the same batch → conflict ────────────
  {
    const { db, gw, deps } = await freshEnv(SQL);
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:1`;
    await createProductWithDurableMedia('p1', [0, 1, 2].map((i) => dataUrl(`rf-${i}`)), deps);
    ok(activeLinks(db, 'p1') === 1, 'slot 0 durable');
    gw.commitShouldThrowFor = null;
    const rr = await createProductWithDurableMedia('p1', [dataUrl('rf-DIFFERENT'), dataUrl('rf-1'), dataUrl('rf-2')], { ...deps, expectedImages: undefined })
      .catch((e: any) => ({ status: 'threw', errorCode: e.code ?? e.message } as any));
    const code = String((rr as any).errorCode ?? '');
    ok(rr.status !== 'created' && code.includes('CONFLICT'), `different hash in same batch → conflict (got ${rr.status}/${code})`);
    ok(activeLinks(db, 'p1') === 1, 'no overwrite of slot 0');
  }

  // ── §5 retry embedding exactly-once + no duplicate (session) ──────────
  {
    const embedCalls = { n: 0 };
    const { db, gw, deps, inserted } = await freshEnv(SQL, { embedCalls });
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:0`;
    const first = await createProductWithDurableMedia('p1', [dataUrl('s0'), dataUrl('s1')], deps);
    ok(first.status === 'media_incomplete', 'first partial');
    ok(embedCalls.n === 0, 'no embedding on the partial');
    gw.commitShouldThrowFor = null;
    const second = await createProductWithDurableMedia('p1', [dataUrl('s0'), dataUrl('s1')], deps);
    ok(second.status === 'created', 'retry created');
    ok(embedCalls.n === 1, 'embedding fired exactly once on the completing retry');
    ok(inserted.length === 1, 'inserted once across create+retry');
    const third = await createProductWithDurableMedia('p1', [dataUrl('s0'), dataUrl('s1')], deps);
    ok(third.status === 'created' && embedCalls.n === 1, 'further retry: no 2nd embedding');
    ok(totalLinks(db, 'p1') === 2, 'still 2 links');
  }

  // ── §6 retry-intent mismatch → conflict, original converges ───────────
  {
    const original = [dataUrl('i0'), dataUrl('i1')];
    const { db, gw, deps } = await freshEnv(SQL);
    gw.commitShouldThrowFor = `create:t1:b1:p1:${ROLE}:1`;
    const first = await createProductWithDurableMedia('p1', original, deps);
    ok(first.status === 'media_incomplete', 'first partial');
    gw.commitShouldThrowFor = null;
    const changed = await createProductWithDurableMedia('p1', [dataUrl('i0'), dataUrl('CHANGED')], { ...deps, expectedImages: original });
    ok(changed.status === 'media_incomplete' && (changed as any).errorCode === 'MEDIA_CREATE_RETRY_INTENT_MISMATCH', `changed list → conflict (got ${(changed as any).errorCode})`);
    ok(activeLinks(db, 'p1') === 1, 'no new slot from the rejected retry');
    const okr = await createProductWithDurableMedia('p1', original, { ...deps, expectedImages: original });
    ok(okr.status === 'created' && activeLinks(db, 'p1') === 2, 'original retry converges');
  }

  // ── §7 decode failure → product created durably, media_incomplete ─────
  {
    const { db, gw, deps } = await freshEnv(SQL);
    const res = await createProductWithDurableMedia('p1', ['/not/a/data/url.jpg'], deps);
    ok(res.status === 'media_incomplete', `undecodable → media_incomplete (got ${res.status})`);
    ok(productCount(db, 'p1') === 1 && activeLinks(db, 'p1') === 0, 'product created, no links');
    ok(gw.commits.length === 0, 'no publish');
  }

  // ── §8 pure UI decision + helpers ─────────────────────────────────────
  {
    const created = decideProductCreateUi({ status: 'created', productId: 'p1' });
    ok(created.closeModal && created.retainProductId === null, 'created → close');
    const inc = decideProductCreateUi({ status: 'media_incomplete', productId: 'p1', errorCode: 'X' } as ProductCreateResult);
    ok(!inc.closeModal && inc.retainProductId === 'p1' && inc.offerRetry, 'media_incomplete → keep open + retain + retry');
    const failed = decideProductCreateUi({ status: 'product_save_failed', productId: 'p1', errorCode: 'X' } as ProductCreateResult);
    ok(!failed.closeModal && failed.message === 'product_save_failed', 'product_save_failed → honest keep-open');
    ok(sameImageIntent(['a', 'b'], ['a', 'b']) && !sameImageIntent(['a'], ['a', 'b']), 'sameImageIntent');
    ok(shouldStartEmbedding({ configured: true, hasImage: true, alreadyComputed: false, inFlight: false }), 'embedding starts clean');
    ok(!shouldStartEmbedding({ configured: true, hasImage: true, alreadyComputed: true, inFlight: false }), 'no embedding once computed');
    ok(!shouldStartEmbedding({ configured: true, hasImage: true, alreadyComputed: false, inFlight: true }), 'no embedding while in flight');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('');
  if (FAIL > 0) {
    console.log(`MEDIA-04A-3B2B create: ${PASS} passed, ${FAIL} FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`MEDIA-04A-3B2B create: ${PASS}/${PASS} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
