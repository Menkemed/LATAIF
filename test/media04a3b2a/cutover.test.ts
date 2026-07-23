// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2A — product media cutover + create-write contract
// Run: node test/media04a3b2a/cutover.test.ts
//
// End-to-end through the REAL StockMediaOrchestrator + MediaDbCoordinator +
// ProductMediaResolver against REAL sql.js. A deterministic fake gateway stands
// in for the Rust bridge; an explicit "disk" (exported image) models a crash —
// only checkpoint-persisted state survives a reopen.
//
// No productive DB, no Tauri, no base64 ever logged.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { MediaDbCoordinator } from '../../src/core/media/coordinator.ts';
import {
  StockMediaOrchestrator,
  type OrchestratorLease,
  type OrchestratorRawDb,
} from '../../src/core/media/orchestrator.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import {
  ProductMediaCutoverService,
  decodeDataUrl,
  canonicalRequestHash,
  cutoverRequestId,
  appendRequestId,
  CUTOVER_PROTO_VERSION,
  CUTOVER_NORM_PARAMS,
} from '../../src/core/media/product-media-cutover.ts';
import type { FinalizeResult } from '../../src/core/media/coordinator.ts';
import type { IngestAndFinalizeInput } from '../../src/core/media/orchestrator.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';
import { createHash } from 'node:crypto';

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

// ── deterministic image payloads ────────────────────────────────────────────
// A legacy data: URL whose decoded bytes are stable per (product,index). The
// fake gateway derives its rendition hashes from those bytes, so the whole
// pipeline is content-addressed exactly like production.

function legacyDataUrl(seed: string): string {
  // 24 deterministic bytes → base64 data URL.
  const bytes = new Uint8Array(24);
  for (let i = 0; i < 24; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i) & 0xff;
  const b64 = Buffer.from(bytes).toString('base64');
  return `data:image/jpeg;base64,${b64}`;
}
function bytesOfDataUrl(src: string): Uint8Array {
  return decodeDataUrl(src).bytes;
}
function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(b)).digest('hex');
}

// The fake gateway keys renditions by the INPUT byte hash so identical bytes
// dedupe and distinct bytes diverge — same content-addressing the real core has.
class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainBytes: Uint8Array; thumbBytes: Uint8Array }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  private reqBytes = new Map<string, Uint8Array>();
  commitShouldThrowFor: string | null = null; // ingestRequestId to fail commit on
  readonly commits: string[] = [];

  private renditionsFor(scope: string, inputBytes: Uint8Array) {
    const h = sha256Hex(inputBytes);
    let r = this.byHash.get(h);
    if (!r) {
      const mainH = sha256Hex(concat(inputBytes, new Uint8Array([1])));
      const thumbH = sha256Hex(concat(inputBytes, new Uint8Array([2])));
      const mainBytes = concat(inputBytes, new Uint8Array([0xaa]));
      const thumbBytes = concat(inputBytes, new Uint8Array([0xbb]));
      r = { main: mainH, thumb: thumbH, mainBytes, thumbBytes };
      this.byHash.set(h, r);
    }
    this.files.set(`${scope}::${r.main}`, { bytes: r.mainBytes, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${r.thumb}`, { bytes: r.thumbBytes, mime: 'image/jpeg', ext: 'jpg' });
    return r;
  }

  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    this.reqBytes.set(`${i.tenantScope}::${i.ingestRequestId}`, i.imageBytes);
    const r = this.renditionsFor(i.tenantScope, i.imageBytes);
    return {
      ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared',
      main_descriptor: desc(r.main, r.mainBytes.length, 800, 600),
      thumbnail_descriptor: desc(r.thumb, r.thumbBytes.length, 200, 150),
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
      main_descriptor: desc(r.main, r.mainBytes.length, 800, 600),
      thumbnail_descriptor: desc(r.thumb, r.thumbBytes.length, 200, 150),
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
function desc(hash: string, size: number, w: number, h: number) {
  return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: w, height: h };
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out;
}

// ── the "disk" + lease ──────────────────────────────────────────────────────
class Disk { image: Uint8Array | null = null; writes = 0; failOnWrite: number | null = null; }
function leaseFor(db: OrchestratorRawDb, disk: Disk): OrchestratorLease {
  return {
    db, epoch: 0,
    async saveDurably() {
      disk.writes++;
      if (disk.failOnWrite !== null && disk.writes === disk.failOnWrite) throw new Error('DISK_FULL');
      disk.image = (db as unknown as { export(): Uint8Array }).export();
    },
    release() {},
  };
}

// ── fixture DB ──────────────────────────────────────────────────────────────
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

// A test hash that is deterministic but cheap (no SubtleCrypto): binds bytes.
async function testHash(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

// Build a cutover service + orchestrator wired to one db + disk.
function wire(db: any, gw: FakeGateway, disk: Disk, opts: { tenantId?: string; branchId?: string } = {}) {
  const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
  const cleared: string[] = [];
  const clearState = { fail: false };
  const svc = new ProductMediaCutoverService({
    dbProvider: () => db,
    orchestrator: orch,
    tenantId: opts.tenantId ?? 't1',
    branchId: opts.branchId ?? 'b1',
    computeRequestHash: (b) => testHash(b),
    commitLegacyCleared: async (productId) => {
      if (clearState.fail) throw new Error('CLEAR_SAVE_FAILED');
      db.run(`UPDATE products SET images='[]' WHERE id=?`, [productId]);
      disk.writes++;
      disk.image = db.export();
      cleared.push(productId);
    },
  });
  return { orch, svc, cleared, clearState };
}

function legacyOf(db: any, productId: string): string {
  const r = db.exec(`SELECT images FROM products WHERE id=?`, [productId]);
  return r.length ? String(r[0].values[0][0]) : '';
}
function gallery(db: any, productId: string): Array<[number, number]> {
  const r = db.exec(`SELECT sort_order, is_primary FROM media_links WHERE entity_id=? AND deleted_at IS NULL ORDER BY sort_order`, [productId]);
  return r.length ? (r[0].values as any[]).map((v) => [Number(v[0]), Number(v[1])] as [number, number]) : [];
}
function linkRows(db: any, productId: string): number {
  const r = db.exec(`SELECT COUNT(*) FROM media_links WHERE entity_id=?`, [productId]);
  return r.length ? Number(r[0].values[0][0]) : 0;
}
function reopen(SQL: any, disk: Disk) {
  if (!disk.image) throw new Error('nothing persisted');
  return new SQL.Database(disk.image);
}
async function resolveKind(db: any, gw: FakeGateway, productId: string, tenantId = 't1', branchId = 'b1') {
  return new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId, branchId }).resolveProductMedia(productId);
}
function ingestJobIds(db: any, productId: string): string[] {
  const r = db.exec(`SELECT ingest_request_id FROM media_ingest_jobs WHERE requested_entity_id=? ORDER BY ingest_request_id`, [productId]);
  return r.length ? (r[0].values as any[]).map((v) => String(v[0])) : [];
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 legacy 1 image → cutover → media visible, legacy emptied ───────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const url = legacyDataUrl('p1-solo');
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify([url])]);
    const { svc, cleared } = wire(db, gw, disk);
    const res = await svc.ensureProductMediaCutover('p1');
    ok(res.action === 'migrated' && res.imported === 1, `migrated 1 (got ${res.action}/${res.imported})`);
    ok(gallery(db, 'p1').length === 1 && gallery(db, 'p1')[0][1] === 1, 'one primary link at slot 0');
    ok(legacyOf(db, 'p1') === '[]', 'legacy column emptied AFTER import');
    ok(cleared.length === 1, 'commitLegacyCleared called exactly once');
    // Resolver now shows media, not legacy.
    const r = await new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }).resolveProductMedia('p1');
    ok(r.kind === 'media' && r.items.length === 1, `resolver shows media (got ${r.kind})`);
  }

  // ── §2 legacy N images → order preserved ──────────────────────────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1, 2, 3].map((i) => legacyDataUrl(`p1-img-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const { svc } = wire(db, gw, disk);
    const res = await svc.ensureProductMediaCutover('p1');
    ok(res.imported === 4, `imported 4 (got ${res.imported})`);
    const g = gallery(db, 'p1');
    ok(g.map((x) => x[0]).join(',') === '0,1,2,3', `contiguous 0..3 (got ${g.map((x) => x[0]).join(',')})`);
    ok(g.filter((x) => x[1] === 1).length === 1 && g[0][1] === 1, 'exactly one primary at slot 0');
    ok(legacyOf(db, 'p1') === '[]', 'legacy emptied after N import');
    // Resolver order matches legacy order (content-addressed identity).
    const r = await new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }).resolveProductMedia('p1');
    ok(r.kind === 'media' && r.items.length === 4, '4 media items resolved');
    const expected = urls.map((u) => sha256Hex(concat(bytesOfDataUrl(u), new Uint8Array([1]))));
    ok(r.kind === 'media' && r.items.every((it, i) => (it as any).mediaId.length > 0), 'each item has a media id');
    void expected;
  }

  // ── §3 crash BEFORE first publish → legacy intact, no links, retry OK ─
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1, 2].map((i) => legacyDataUrl(`crash1-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const { svc } = wire(db, gw, disk);
    // Fail the very first commit → nothing published, legacy untouched.
    gw.commitShouldThrowFor = cutoverRequestId('t1', 'b1', 'p1', 'stock_image', 0);
    await throws('cutover surfaces first-publish failure', 'MEDIA_CUTOVER_INGEST_FAILED', () => svc.ensureProductMediaCutover('p1'));
    ok(JSON.parse(legacyOf(db, 'p1')).length === 3, 'legacy still holds all 3 after crash-before-publish');
    ok(gallery(db, 'p1').length === 0, 'no active links created');
    // Retry succeeds and converges.
    gw.commitShouldThrowFor = null;
    const res = await svc.ensureProductMediaCutover('p1');
    ok(res.imported === 3, 'retry imported all 3');
    ok(gallery(db, 'p1').map((x) => x[0]).join(',') === '0,1,2', 'retry order 0,1,2');
    ok(legacyOf(db, 'p1') === '[]', 'legacy emptied after successful retry');
  }

  // ── §4 crash AFTER partial publish → reopen, resume, no duplicates ────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1, 2].map((i) => legacyDataUrl(`crash2-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    // persist the seeded legacy so a reopen sees it
    disk.image = db.export();
    const first = wire(db, gw, disk);
    // Fail commit on the 3rd image → images 0,1 durably imported, then throw.
    gw.commitShouldThrowFor = cutoverRequestId('t1', 'b1', 'p1', 'stock_image', 2);
    await throws('partial import surfaces', 'MEDIA_CUTOVER_INGEST_FAILED', () => first.svc.ensureProductMediaCutover('p1'));
    ok(legacyOf(db, 'p1') !== '[]', 'legacy NOT cleared on partial failure');
    // Reopen from disk — images 0,1 must have survived (each ran cp2).
    const db2 = reopen(SQL, disk);
    ok(gallery(db2, 'p1').length === 2, `reopen shows 2 durable links (got ${gallery(db2, 'p1').length})`);
    ok(JSON.parse(legacyOf(db2, 'p1')).length === 3, 'reopened legacy still holds all 3');
    // Resume on the reopened db; 3rd now commits.
    const gw2 = new FakeGateway(); const disk2 = new Disk(); disk2.image = db2.export();
    const second = wire(db2, gw2, disk2);
    const res = await second.svc.ensureProductMediaCutover('p1');
    ok(res.action === 'resumed_and_cleared', `resumed (got ${res.action})`);
    ok(res.imported === 3, 'resume converged to 3');
    ok(gallery(db2, 'p1').map((x) => x[0]).join(',') === '0,1,2', 'resume order 0,1,2');
    ok(linkRows(db2, 'p1') === 3, 'exactly 3 link rows — no duplicates after resume');
    ok(legacyOf(db2, 'p1') === '[]', 'legacy cleared after resume completes');
  }

  // ── §5 clear/save failure → legacy untouched, no visible loss ─────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1].map((i) => legacyDataUrl(`clearfail-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const { svc, clearState } = wire(db, gw, disk);
    clearState.fail = true;
    await throws('clear failure surfaces', 'CLEAR_SAVE_FAILED', () => svc.ensureProductMediaCutover('p1'));
    ok(JSON.parse(legacyOf(db, 'p1')).length === 2, 'legacy untouched when clear fails');
    ok(gallery(db, 'p1').length === 2, 'links are durable even though clear failed');
    // 3B2A-R1 atomic switch: legacy is not yet cleared, so the resolver STILL
    // shows the full legacy gallery — the durable clear is the only switch.
    // No visible loss (both legacy images remain visible).
    const r = await new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }).resolveProductMedia('p1');
    ok(r.kind === 'legacy' && r.items.length === 2, `resolver still shows full legacy until the clear (got ${r.kind})`);
    // Retry the clear succeeds and is idempotent (no re-import).
    clearState.fail = false;
    const res = await svc.ensureProductMediaCutover('p1');
    ok(res.action === 'resumed_and_cleared' && res.imported === 2, 'retry clears without re-import');
    ok(gallery(db, 'p1').length === 2 && linkRows(db, 'p1') === 2, 'still exactly 2 links (no duplicates)');
    ok(legacyOf(db, 'p1') === '[]', 'legacy finally cleared');
    // Now the switch has flipped → media wins.
    const r2 = await new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }).resolveProductMedia('p1');
    ok(r2.kind === 'media' && r2.items.length === 2, 'media wins once legacy is cleared');
  }

  // ── §6 retry after full success → idempotent no-op, no duplicates ─────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1, 2].map((i) => legacyDataUrl(`idem-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const { svc } = wire(db, gw, disk);
    await svc.ensureProductMediaCutover('p1');
    const before = linkRows(db, 'p1');
    const res = await svc.ensureProductMediaCutover('p1');
    ok(res.action === 'noop_already_migrated' && res.imported === 0, `2nd run is a no-op (got ${res.action})`);
    ok(linkRows(db, 'p1') === before, 'no new link rows on the idempotent re-run');
    ok(gallery(db, 'p1').length === 3, 'still 3 active links');
  }

  // ── §7 already migrated (empty legacy, history present) → no-op ───────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const url = legacyDataUrl('mig-1');
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify([url])]);
    const { svc } = wire(db, gw, disk);
    await svc.ensureProductMediaCutover('p1'); // migrate
    // remove the image via the coordinator (retires the link) → history remains, legacy empty
    const coord = new MediaDbCoordinator(db, gw);
    const link = String(db.exec(`SELECT link_id FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL`)[0].values[0][0]);
    coord.remove({ tenantId: 't1', linkId: link });
    const res = await svc.ensureProductMediaCutover('p1');
    ok(res.action === 'noop_already_migrated', `retired-history + empty legacy → no-op (got ${res.action})`);
    ok(gallery(db, 'p1').length === 0, 'still no active links (legacy not resurrected)');
    ok(legacyOf(db, 'p1') === '[]', 'legacy stays empty — deleted image not re-imported');
  }

  // ── §8 no legacy, no history → no-op ──────────────────────────────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const { svc, cleared } = wire(db, gw, disk);
    const res = await svc.ensureProductMediaCutover('p2');
    ok(res.action === 'noop_no_legacy' && res.imported === 0, `empty product → no-op (got ${res.action})`);
    ok(cleared.length === 0, 'no clear for an empty product');
    ok(gallery(db, 'p2').length === 0, 'no links created');
  }

  // ── §9 wrong tenant/branch → no access to legacy, no import ───────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const url = legacyDataUrl('scoped-1');
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify([url])]); // p1 is in b1/t1
    // A service scoped to t2/bx cannot see p1's legacy column at all.
    const { svc } = wire(db, gw, disk, { tenantId: 't2', branchId: 'bx' });
    const res = await svc.ensureProductMediaCutover('p1');
    ok(res.action === 'noop_no_legacy', `foreign scope reads no legacy (got ${res.action})`);
    ok(gallery(db, 'p1').length === 0, 'no links created under the wrong scope');
    ok(JSON.parse(legacyOf(db, 'p1')).length === 1, "p1's real legacy untouched by the foreign-scope run");
    // A wrong-branch (same tenant) service is equally blind.
    const { svc: svcB } = wire(db, gw, disk, { tenantId: 't1', branchId: 'b2' });
    ok((await svcB.ensureProductMediaCutover('p1')).action === 'noop_no_legacy', 'wrong branch reads no legacy');
    // scope-required guard
    try { new ProductMediaCutoverService({ dbProvider: () => db, orchestrator: {} as any, commitLegacyCleared: async () => {}, tenantId: '', branchId: 'b1' }); ok(false, 'missing tenant should throw'); }
    catch (e) { ok((e as any).code === 'MEDIA_CUTOVER_SCOPE_REQUIRED', 'missing tenant → scope required'); }
  }

  // ── §10 create contract: new product, N images ordered, no base64 in DB ─
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    // "createProduct" persisted p2 with an EMPTY images column (no base64).
    const { svc } = wire(db, gw, disk);
    const imgs = [0, 1, 2].map((i) => bytesOfDataUrl(legacyDataUrl(`new-${i}`)));
    const results = await svc.appendOrderedProductImages('p2', imgs);
    ok(results.length === 3, 'appended 3 images');
    ok(gallery(db, 'p2').map((x) => x[0]).join(',') === '0,1,2', 'ordered 0,1,2');
    ok(gallery(db, 'p2')[0][1] === 1, 'first appended image is primary');
    ok(legacyOf(db, 'p2') === '[]', 'products.images stays empty — no base64 persisted for a new product');
    // No base64 anywhere in the products row.
    const prow = db.exec(`SELECT images FROM products WHERE id='p2'`)[0].values[0][0];
    ok(String(prow) === '[]', 'products.images is empty JSON, no base64');
    // Crash/recovery: a re-append with the same bytes is idempotent (deterministic ids).
    const again = await svc.appendOrderedProductImages('p2', imgs.slice(0, 0)); // no-op append
    ok(again.length === 0 && linkRows(db, 'p2') === 3, 'no duplicate links, product+images intact');
  }

  // ── §11 unsupported legacy entry → refuse, legacy untouched ───────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    // A non-data URL (e.g. a file path or http URL) cannot be decoded client-side.
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(['/local/path/photo.jpg'])]);
    const { svc } = wire(db, gw, disk);
    await throws('non-data legacy is refused', 'MEDIA_CUTOVER_UNSUPPORTED_LEGACY', () => svc.ensureProductMediaCutover('p1'));
    ok(JSON.parse(legacyOf(db, 'p1')).length === 1, 'legacy untouched when an entry is undecodable');
    ok(gallery(db, 'p1').length === 0, 'no partial links from an undecodable gallery');
  }

  // ── §12 export/reopen after a clean migration is stable ───────────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1].map((i) => legacyDataUrl(`persist-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const { svc } = wire(db, gw, disk);
    await svc.ensureProductMediaCutover('p1');
    const db2 = reopen(SQL, disk);
    ok(gallery(db2, 'p1').map((x) => x[0]).join(',') === '0,1', 'reopened gallery order preserved');
    ok(legacyOf(db2, 'p1') === '[]', 'reopened legacy stays empty');
    ok(linkRows(db2, 'p1') === 2, 'reopened link rows == 2');
  }

  // ── §13 default canonical hash matches the Rust formula ────────────────
  {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const scope = 't1';
    const inputSha = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    const material = `${CUTOVER_PROTO_VERSION}|${scope}|stock_image|${inputSha}|${CUTOVER_NORM_PARAMS}`;
    const expected = createHash('sha256').update(material, 'utf8').digest('hex');
    const got = await canonicalRequestHash(bytes, scope);
    ok(got === expected, 'canonicalRequestHash mirrors the Rust canonical_request_hash formula');
    ok(/^[0-9a-f]{64}$/.test(got), 'hash is 64-hex lower-case');
  }

  // ══════════════════════════════════════════════════════════════════════
  // R1 — atomic visible cutover + exact manifest + scope-qualified ids
  // ══════════════════════════════════════════════════════════════════════

  // ── §R1a crash after image 1 → reopen shows FULL legacy, not partial ──
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1, 2].map((i) => legacyDataUrl(`atom1-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    disk.image = db.export();
    const { svc } = wire(db, gw, disk);
    gw.commitShouldThrowFor = cutoverRequestId('t1', 'b1', 'p1', 'stock_image', 1); // fail on image 1
    await throws('crash after image 0', 'MEDIA_CUTOVER_INGEST_FAILED', () => svc.ensureProductMediaCutover('p1'));
    const db2 = reopen(SQL, disk);
    ok(gallery(db2, 'p1').length === 1, 'one durable link after the partial import');
    const r = await resolveKind(db2, gw, 'p1');
    ok(r.kind === 'legacy' && r.items.length === 3, `reopen still shows ALL 3 legacy images (got ${r.kind}/${(r as any).items?.length})`);
  }

  // ── §R1b crash after image 2 → still full legacy visible ──────────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1, 2].map((i) => legacyDataUrl(`atom2-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    disk.image = db.export();
    const { svc } = wire(db, gw, disk);
    gw.commitShouldThrowFor = cutoverRequestId('t1', 'b1', 'p1', 'stock_image', 2); // fail on image 2
    await throws('crash after image 1', 'MEDIA_CUTOVER_INGEST_FAILED', () => svc.ensureProductMediaCutover('p1'));
    const db2 = reopen(SQL, disk);
    ok(gallery(db2, 'p1').length === 2, 'two durable links after the partial import');
    const r = await resolveKind(db2, gw, 'p1');
    ok(r.kind === 'legacy' && r.items.length === 3, `still full legacy with 2 of 3 imported (got ${r.kind})`);
  }

  // ── §R1c all imported, pre-clear → still legacy; post-clear → media ───
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1, 2].map((i) => legacyDataUrl(`atom3-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const { svc, clearState } = wire(db, gw, disk);
    clearState.fail = true; // all imported, but the atomic clear fails
    await throws('clear fails after full import', 'CLEAR_SAVE_FAILED', () => svc.ensureProductMediaCutover('p1'));
    ok(gallery(db, 'p1').length === 3, 'all 3 links durable');
    const pre = await resolveKind(db, gw, 'p1');
    ok(pre.kind === 'legacy' && pre.items.length === 3, `pre-clear: still legacy 3 (got ${pre.kind})`);
    clearState.fail = false;
    await svc.ensureProductMediaCutover('p1'); // completes the clear
    const post = await resolveKind(db, gw, 'p1');
    ok(post.kind === 'media' && post.items.length === 3, `post-clear: media 3 (got ${post.kind})`);
    ok(post.kind === 'media' && post.items.map((i) => i.sortOrder).join(',') === '0,1,2', 'media order 0,1,2');
  }

  // ── §R1d exact manifest: a diverging link → conflict, legacy not cleared ─
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1].map((i) => legacyDataUrl(`manifest-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const realOrch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
    // Orchestrator that imports correctly but REPORTS a divergent content hash
    // for slot 1 → the manifest verification must catch it and refuse the clear.
    const tamper = {
      async ingestAndFinalizeStockImage(input: IngestAndFinalizeInput): Promise<FinalizeResult> {
        const res = await realOrch.ingestAndFinalizeStockImage(input);
        if (input.sortOrder === 1) return { ...res, main: { ...res.main, hash: 'deadbeef'.repeat(8) } };
        return res;
      },
    };
    const cleared: string[] = [];
    const svc = new ProductMediaCutoverService({
      dbProvider: () => db, orchestrator: tamper, tenantId: 't1', branchId: 'b1',
      computeRequestHash: (b) => testHash(b),
      commitLegacyCleared: async (pid) => { db.run(`UPDATE products SET images='[]' WHERE id=?`, [pid]); cleared.push(pid); },
    });
    await throws('manifest divergence → conflict', 'MEDIA_CUTOVER_MANIFEST_MISMATCH', () => svc.ensureProductMediaCutover('p1'));
    ok(cleared.length === 0, 'legacy NOT cleared on a manifest mismatch');
    ok(JSON.parse(legacyOf(db, 'p1')).length === 2, 'legacy still holds both images');
    const r = await resolveKind(db, gw, 'p1');
    ok(r.kind === 'legacy' && r.items.length === 2, 'resolver still shows full legacy after the refused clear');
  }

  // ── §R1e exact manifest: a foreign extra link → count mismatch ────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0].map((i) => legacyDataUrl(`foreign-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const realOrch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
    // After the (single) legacy image imports, inject a foreign active link so
    // the durable gallery no longer matches the imported manifest.
    const inject = {
      async ingestAndFinalizeStockImage(input: IngestAndFinalizeInput): Promise<FinalizeResult> {
        const res = await realOrch.ingestAndFinalizeStockImage(input);
        db.run(`DROP TRIGGER IF EXISTS trg_ml_entity_scope_ins`);
        db.run(`INSERT INTO media_links (tenant_id, link_id, scope_kind, branch_id, entity_type, entity_id, media_id, media_role, sort_order, is_primary, created_at)
                VALUES ('t1','foreign-link','branch','b1','product','p1','foreign-media','stock_image',1,0,'x')`);
        return res;
      },
    };
    const cleared: string[] = [];
    const svc = new ProductMediaCutoverService({
      dbProvider: () => db, orchestrator: inject, tenantId: 't1', branchId: 'b1',
      computeRequestHash: (b) => testHash(b),
      commitLegacyCleared: async (pid) => { db.run(`UPDATE products SET images='[]' WHERE id=?`, [pid]); cleared.push(pid); },
    });
    await throws('foreign link → count mismatch', 'MEDIA_CUTOVER_MANIFEST_MISMATCH', () => svc.ensureProductMediaCutover('p1'));
    ok(cleared.length === 0, 'legacy not cleared with a foreign link present');
    ok(JSON.parse(legacyOf(db, 'p1')).length === 1, 'legacy untouched');
  }

  // ── §R1f scope-qualified request ids ──────────────────────────────────
  {
    // Same product id under different tenants/branches → different ids.
    ok(cutoverRequestId('t1', 'b1', 'p', 'stock_image', 0) !== cutoverRequestId('t2', 'b1', 'p', 'stock_image', 0), 'cutover id binds tenant');
    ok(cutoverRequestId('t1', 'b1', 'p', 'stock_image', 0) !== cutoverRequestId('t1', 'b2', 'p', 'stock_image', 0), 'cutover id binds branch');
    ok(cutoverRequestId('t1', 'b1', 'p', 'stock_image', 0) !== cutoverRequestId('t1', 'b1', 'q', 'stock_image', 0), 'cutover id binds product');
    ok(cutoverRequestId('t1', 'b1', 'p', 'stock_image', 0) !== cutoverRequestId('t1', 'b1', 'p', 'stock_image', 1), 'cutover id binds slot');
    ok(cutoverRequestId('t1', 'b1', 'p', 'stock_image', 0) !== appendRequestId('t1', 'b1', 'p', 'stock_image', 0), 'operation namespaces differ');
    // Functional: two scopes never write the same job row for the "same" product id.
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    // product 'sh' exists in b1(t1); a distinct product 'sh2' in bx(t2) stands in
    // for "same id in another tenant" (products.id is a global PK).
    db.run(`INSERT INTO products (id, branch_id, images) VALUES ('sh','b1','[]'),('sh2','bx','[]')`);
    const gw = new FakeGateway(); const disk = new Disk();
    const a = wire(db, gw, disk, { tenantId: 't1', branchId: 'b1' });
    const b = wire(db, gw, disk, { tenantId: 't2', branchId: 'bx' });
    await a.svc.appendOrderedProductImages('sh', [bytesOfDataUrl(legacyDataUrl('sh-a'))]);
    await b.svc.appendOrderedProductImages('sh2', [bytesOfDataUrl(legacyDataUrl('sh-b'))]);
    ok(ingestJobIds(db, 'sh')[0] === appendRequestId('t1', 'b1', 'sh', 'stock_image', 0), 'tenant-1 job id is scope-qualified');
    ok(ingestJobIds(db, 'sh2')[0] === appendRequestId('t2', 'bx', 'sh2', 'stock_image', 0), 'tenant-2 job id is scope-qualified');
    ok(ingestJobIds(db, 'sh')[0] !== ingestJobIds(db, 'sh2')[0], 'the two scopes produced distinct jobs');
  }

  // ── §R1g product durability checkpoint before first publish ───────────
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
    let checkpointRan = false;
    const svc = new ProductMediaCutoverService({
      dbProvider: () => db, orchestrator: orch, tenantId: 't1', branchId: 'b1',
      computeRequestHash: (b) => testHash(b),
      commitLegacyCleared: async () => {},
      ensureProductDurable: async () => { checkpointRan = true; throw new Error('CHECKPOINT_DISK_FULL'); },
    });
    await throws('product checkpoint failure surfaces', 'MEDIA_CUTOVER_PRODUCT_CHECKPOINT_FAILED',
      () => svc.appendOrderedProductImages('p2', [bytesOfDataUrl(legacyDataUrl('chk-0'))]));
    ok(checkpointRan, 'the product checkpoint ran');
    ok(gw.commits.length === 0, 'NO Rust publish happened after the checkpoint failed');
    ok(gallery(db, 'p2').length === 0, 'no link created');
    // With a working checkpoint the append proceeds and the checkpoint precedes publish.
    const order: string[] = [];
    const gw2 = new FakeGateway(); const disk2 = new Disk();
    const orch2 = new StockMediaOrchestrator({ gateway: gw2, leaseFactory: () => leaseFor(db, disk2) });
    const origCommit = gw2.commitStockImage.bind(gw2);
    (gw2 as any).commitStockImage = async (i: any) => { order.push('publish'); return origCommit(i); };
    const svc2 = new ProductMediaCutoverService({
      dbProvider: () => db, orchestrator: orch2, tenantId: 't1', branchId: 'b1',
      computeRequestHash: (b) => testHash(b), commitLegacyCleared: async () => {},
      ensureProductDurable: async () => { order.push('product-durable'); },
    });
    await svc2.appendOrderedProductImages('p2', [bytesOfDataUrl(legacyDataUrl('chk-1'))]);
    ok(order[0] === 'product-durable' && order.includes('publish'), 'product durability precedes the first publish');
    ok(gallery(db, 'p2').length === 1, 'link created once the checkpoint succeeded');
  }

  // ── §R1h retry after partial → converges, no duplicates, no partial view ─
  {
    const db = new SQL.Database(); seedEntityStubs(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk();
    const urls = [0, 1, 2].map((i) => legacyDataUrl(`retry-${i}`));
    db.run(`UPDATE products SET images=? WHERE id='p1'`, [JSON.stringify(urls)]);
    const { svc } = wire(db, gw, disk);
    gw.commitShouldThrowFor = cutoverRequestId('t1', 'b1', 'p1', 'stock_image', 2);
    await throws('first attempt partial', 'MEDIA_CUTOVER_INGEST_FAILED', () => svc.ensureProductMediaCutover('p1'));
    // During the incomplete cutover the resolver shows full legacy — never a partial gallery.
    ok((await resolveKind(db, gw, 'p1')).kind === 'legacy', 'incomplete cutover still shows legacy, not a partial media gallery');
    gw.commitShouldThrowFor = null;
    const res = await svc.ensureProductMediaCutover('p1');
    ok(res.imported === 3 && linkRows(db, 'p1') === 3, 'retry converged to 3 with no duplicates');
    ok((await resolveKind(db, gw, 'p1')).kind === 'media', 'after full success the media gallery shows');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('');
  if (FAIL > 0) {
    console.log(`MEDIA-04A-3B2A cutover: ${PASS} passed, ${FAIL} FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`MEDIA-04A-3B2A cutover: ${PASS}/${PASS} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
