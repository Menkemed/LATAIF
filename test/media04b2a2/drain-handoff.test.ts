// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A2 (+R1/R2/R3) — internal Rust↔JS upload drain → product/media handoff
// Run: node test/media04b2a2/drain-handoff.test.ts
//
// REAL create core (discriminated MediaSource) + orchestrator + coordinator + resolver against REAL
// sql.js. Images are PREPARED out-of-band (a FakeBridge models the Rust prepare with a server-derived
// prepareRequestId, staging into the media gateway) → the drain holds only opaque descriptors, NO
// bytes/data-URLs/sentinels. The receipt binds the full identity (origin user + metadata hash +
// prepared-manifest hash) atomically with the product + create batch. No productive DB, no Tauri.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { StockMediaOrchestrator, type OrchestratorLease, type OrchestratorRawDb } from '../../src/core/media/orchestrator.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import { createProductWithDurableMedia } from '../../src/core/media/product-media-create.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';
import {
  processMobileUploadClaim, drainMobileUploads, verifyGrantManifest, getMobileUploadDrainWorker,
  triggerMobileUploadDrainSafe,
  canonicalProductMetadataHash, projectionFieldsFromMetadata, preparedManifestHash, identitiesFromPrepared,
  MaterializeError,
  type ClaimGrant, type ClaimedImage, type MobileUploadBridge, type ReadyResult, type MobileDrainDeps, type ReadyVerdict, type PreparedMediaItem, type BoundBatchJob, type GallerySlot,
} from '../../src/core/media/mobile-upload-drain.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }
function sha256Hex(b: Uint8Array): string { return createHash('sha256').update(Buffer.from(b)).digest('hex'); }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
function d(hash: string, size: number, w: number, h: number) { return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: w, height: h }; }

class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainB: Uint8Array; thumbB: Uint8Array }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  private reqBytes = new Map<string, Uint8Array>();
  private rend(scope: string, input: Uint8Array) {
    const h = sha256Hex(input);
    let r = this.byHash.get(h);
    if (!r) { r = { main: sha256Hex(concat(input, new Uint8Array([1]))), thumb: sha256Hex(concat(input, new Uint8Array([2]))), mainB: concat(input, new Uint8Array([0xaa])), thumbB: concat(input, new Uint8Array([0xbb])) }; this.byHash.set(h, r); }
    this.files.set(`${scope}::${r.main}`, { bytes: r.mainB, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${r.thumb}`, { bytes: r.thumbB, mime: 'image/jpeg', ext: 'jpg' });
    return r;
  }
  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    this.reqBytes.set(`${i.tenantScope}::${i.ingestRequestId}`, i.imageBytes);
    const r = this.rend(i.tenantScope, i.imageBytes);
    return { ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared', main_descriptor: d(r.main, r.mainB.length, 800, 600), thumbnail_descriptor: d(r.thumb, r.thumbB.length, 200, 150) };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    const bytes = this.reqBytes.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!bytes) throw new Error('MEDIA_INGEST_NOT_FOUND');
    const r = this.rend(i.tenantScope, bytes);
    return { state: 'published', main_descriptor: d(r.main, r.mainB.length, 800, 600), thumbnail_descriptor: d(r.thumb, r.thumbB.length, 200, 150), main_storage_key: `${i.tenantScope}/${r.main.slice(0, 2)}/${r.main}.jpg`, thumbnail_storage_key: `${i.tenantScope}/${r.thumb.slice(0, 2)}/${r.thumb}.jpg` };
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
  return { db, epoch: 0, async saveDurably() { disk.writes++; disk.image = (db as unknown as { export(): Uint8Array }).export(); }, release() {} };
}
function seed(db: any): void {
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  for (const c of ['brand', 'name', 'category_id', 'sku', 'attributes']) db.run(`ALTER TABLE products ADD COLUMN ${c} TEXT`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, action TEXT)`);
  db.run(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, entity_id TEXT)`);
  db.run(`CREATE TABLE mobile_upload_receipts (tenant_id TEXT, branch_id TEXT, authenticated_user_id TEXT, upload_event_id TEXT, payload_hash TEXT, entity_id TEXT, create_batch_id TEXT, product_id TEXT, canonical_product_metadata_hash TEXT, prepared_manifest_hash TEXT, created_at TEXT, PRIMARY KEY (tenant_id, branch_id, authenticated_user_id, upload_event_id))`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1')`);
}
const ROLE = 'stock_image';
const META = JSON.stringify({ brand: 'Rolex', categoryId: 'cat-watch', name: 'Sub' });
function productImages(db: any, id: string): string | null { const r = db.exec(`SELECT images FROM products WHERE id=?`, [id]); return r.length ? String(r[0].values[0][0]) : null; }
function count(db: any, sql: string, p: any[] = []): number { const r = db.exec(sql, p); return r.length ? Number(r[0].values[0][0]) : 0; }
function orderOf(db: any, id: string): string { const r = db.exec(`SELECT sort_order FROM media_links WHERE entity_id=? AND deleted_at IS NULL ORDER BY sort_order`, [id]); return r.length ? (r[0].values as any[]).map((v) => Number(v[0])).join(',') : ''; }
function dumpText(db: any, sql: string): string { const r = db.exec(sql); return r.length ? JSON.stringify(r[0].values) : ''; }

// ── fixtures ─────────────────────────────────────────────────────────────────
function imageBytes(seed: string): Uint8Array { const b = new Uint8Array(24); for (let i = 0; i < 24; i++) b[i] = (seed.charCodeAt(i % seed.length) + i * 7) & 0xff; return b; }
function descriptor(seed: string, slot: number): ClaimedImage {
  const b = imageBytes(seed);
  return { slot, primary: slot === 0, mime: 'image/jpeg', width: 800, height: 600, byteSize: b.length, contentHash: sha256Hex(b), storageKey: `t1/xx/${sha256Hex(b)}.jpg` };
}
function mkGrant(uploadEventId: string, entityId: string, seeds: string[], over: Partial<ClaimGrant> = {}): ClaimGrant {
  return {
    tenantId: 't1', branchId: 'b1', authenticatedUserId: 'user-origin',
    uploadEventId, entityId, payloadHash: `ph-${uploadEventId}`, mode: 'collection', metadataJson: META,
    claimToken: '', claimantInstanceId: '', leaseUntil: '', images: seeds.map((s, i) => descriptor(s, i)), ...over,
  };
}
async function metaHashFor(m: string): Promise<string> { return canonicalProductMetadataHash(projectionFieldsFromMetadata(m)); }

// ── in-memory durable Rust inbox model (state machine proven in Rust) ─────────
interface Job extends ClaimGrant { state: string; productId: string | null; leaseUntilN: number; claimant: string; bytesBySlot: Uint8Array[] }
class FakeBridge implements MobileUploadBridge {
  jobs: Job[] = [];
  clock = 1000;
  prepareCount = 0;
  claimCount = 0;
  private tok = 0;
  private readonly gw: FakeGateway;
  constructor(gw: FakeGateway) { this.gw = gw; }
  seedAccepted(uploadEventId: string, entityId: string, seeds: string[], over: Partial<ClaimGrant> = {}): Job {
    const g = mkGrant(uploadEventId, entityId, seeds, over);
    const j: Job = { ...g, state: 'accepted', productId: null, leaseUntilN: 0, claimant: '', claimToken: '', bytesBySlot: seeds.map((s) => imageBytes(s)) };
    this.jobs.push(j); return j;
  }
  private find(ev: string, u: string) { return this.jobs.find((j) => j.uploadEventId === ev && j.authenticatedUserId === u); }
  async claim(claimantInstanceId: string, leaseSeconds: number): Promise<ClaimGrant | null> {
    this.claimCount++;
    const j = this.jobs.find((x) => x.state === 'accepted' || (x.state === 'processing' && x.leaseUntilN < this.clock));
    if (!j) return null;
    j.state = 'processing'; j.claimToken = `tok-${++this.tok}`; j.claimant = claimantInstanceId; j.leaseUntilN = this.clock + leaseSeconds;
    const { bytesBySlot: _b, state: _s, productId: _p, leaseUntilN: _l, claimant: _c, ...grant } = j;
    return { ...grant, images: grant.images.map((im) => ({ ...im })) };
  }
  // Server-derived, provenance-bound prepareRequestId (scope+originUser+uploadEventId+slot+contentHash).
  private prepareRequestId(u: string, ev: string, slot: number, contentHash: string) { return sha256Hex(new TextEncoder().encode(`prep|t1|b1|${u}|${ev}|${slot}|${contentHash}`)); }
  async prepareImage(u: string, ev: string, tok: string, slot: number, tenantScope: string): Promise<PrepareResult> {
    const j = this.find(ev, u);
    if (!j || j.state !== 'processing' || j.claimToken !== tok) throw new Error('MOBILE_UPLOAD_CLAIM_INVALID');
    const bytes = j.bytesBySlot[slot];
    if (!bytes) throw new Error('MOBILE_UPLOAD_INTEGRITY_FAILURE');
    if (sha256Hex(bytes) !== j.images[slot].contentHash) throw new Error('MOBILE_UPLOAD_INTEGRITY_FAILURE');
    this.prepareCount++;
    const rid = this.prepareRequestId(u, ev, slot, j.images[slot].contentHash);
    return this.gw.prepareStockImage({ tenantScope, ingestRequestId: rid, requestHash: sha256Hex(bytes), imageBytes: bytes });
  }
  async renew(u: string, ev: string, tok: string, claimant: string, leaseSeconds: number): Promise<boolean> {
    const j = this.find(ev, u); if (j && j.state === 'processing' && j.claimToken === tok && j.claimant === claimant) { j.leaseUntilN = this.clock + leaseSeconds; return true; } return false;
  }
  async release(u: string, ev: string, tok: string): Promise<boolean> {
    const j = this.find(ev, u); if (j && j.state === 'processing' && j.claimToken === tok) { j.state = 'accepted'; j.claimToken = ''; return true; } return false;
  }
  async markQuarantined(u: string, ev: string, tok: string, _code: string): Promise<boolean> {
    const j = this.find(ev, u); if (j && j.state === 'processing' && j.claimToken === tok) { j.state = 'quarantined'; j.claimToken = ''; return true; } return false;
  }
  async markReady(u: string, ev: string, tok: string, entityId: string, ph: string, productId: string): Promise<ReadyResult> {
    const j = this.find(ev, u);
    if (j && j.state === 'ready' && j.entityId === entityId && j.payloadHash === ph && j.productId === productId) return 'already_ready';
    if (!j || j.state !== 'processing' || j.claimToken !== tok || j.entityId !== entityId || j.payloadHash !== ph) return 'rejected';
    j.state = 'ready'; j.productId = productId; j.claimToken = ''; return 'marked_ready';
  }
  stateOf(ev: string, u = 'user-origin') { return this.find(ev, u)?.state; }
}

function makeDeps(db: any, gw: FakeGateway, disk: Disk, bridge: FakeBridge, opts: { scope?: { tenantId: string; branchId: string } | null; badBrand?: boolean; scopeBlocked?: boolean; bindingRevision?: () => number } = {}): MobileDrainDeps {
  const scope = opts.scope === undefined ? { tenantId: 't1', branchId: 'b1' } : opts.scope;
  return {
    bridge, claimantInstanceId: 'worker-1',
    // MOBILE-04B2A3-R1: FRESH evidence read each call. Tests exercise the real saga with a configured
    // binding matching the active scope; opts.scopeBlocked models production (no binding → blocked);
    // opts.bindingRevision drives the fence revision (default stable = 1).
    readScopeEvidence: async () => {
      if (opts.scopeBlocked || !scope) return null;
      return { tenantId: scope.tenantId, branchId: scope.branchId, serverInstanceId: 'inst-test', bindingRevision: (opts.bindingRevision ?? (() => 1))(), configured: true };
    },
    currentScope: () => scope,
    readReceipt: (t, b, u, ev) => {
      const r = db.exec(`SELECT payload_hash, entity_id, product_id, create_batch_id, canonical_product_metadata_hash, prepared_manifest_hash FROM mobile_upload_receipts WHERE tenant_id=? AND branch_id=? AND authenticated_user_id=? AND upload_event_id=?`, [t, b, u, ev]);
      if (!r.length) return null;
      const v = r[0].values[0];
      return { payloadHash: String(v[0]), entityId: String(v[1]), productId: String(v[2]), createBatchId: String(v[3]), canonicalProductMetadataHash: String(v[4]), preparedManifestHash: String(v[5]) };
    },
    productExists: (id) => count(db, `SELECT COUNT(*) FROM products WHERE id=?`, [id]) > 0,
    readProductMetadataHash: async (id) => {
      const r = db.exec(`SELECT brand, name, category_id, sku, attributes FROM products WHERE id=?`, [id]);
      if (!r.length) return null;
      const v = r[0].values[0];
      let attrs: unknown = {}; try { attrs = v[4] ? JSON.parse(String(v[4])) : {}; } catch { attrs = {}; }
      return canonicalProductMetadataHash({ brand: v[0], name: v[1], categoryId: v[2], sku: v[3], attributes: attrs });
    },
    readBoundBatch: async (entityId): Promise<BoundBatchJob[]> => {
      const r = db.exec(`SELECT ingest_request_id, request_hash FROM media_ingest_jobs WHERE requested_entity_id=? AND requested_role=?`, [entityId, ROLE]);
      if (!r.length) return [];
      return (r[0].values as any[]).map((row) => ({ ingestRequestId: String(row[0]), requestHash: String(row[1]) }));
    },
    readGalleryManifest: async (entityId): Promise<GallerySlot[]> => {
      const r = db.exec(`SELECT sort_order, is_primary FROM media_links WHERE entity_id=? AND deleted_at IS NULL ORDER BY sort_order`, [entityId]);
      if (!r.length) return [];
      return (r[0].values as any[]).map((row) => ({ sortOrder: Number(row[0]), isPrimary: !!Number(row[1]) }));
    },
    readSideEffectCounts: async (entityId) => ({ changelog: count(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id=?`, [entityId]), audit: count(db, `SELECT COUNT(*) FROM audit_log WHERE entity_id=?`, [entityId]) }),
    deriveCreateBatchId: (entityId) => `create:t1:b1:${entityId}:${ROLE}`,
    preparePreparedMedia: async (g) => {
      const sorted = [...g.images].sort((a, b) => a.slot - b.slot);
      const out: PreparedMediaItem[] = [];
      for (const im of sorted) {
        let prepared;
        try { prepared = await bridge.prepareImage(g.authenticatedUserId, g.uploadEventId, g.claimToken, im.slot, 't1'); }
        catch (e) { throw new MaterializeError(/INTEGRITY|MANIFEST/i.test(String((e as Error).message)) ? 'broken' : 'unavailable'); }
        out.push({ slot: im.slot, isPrimary: im.slot === 0, ingestRequestId: prepared.ingest_request_id, prepared });
      }
      return out;
    },
    createProduct: async (g, prepared, receiptIntent) => {
      const meta = JSON.parse(g.metadataJson) as Record<string, string>;
      const brand = opts.badBrand ? 'WRONG-BRAND' : (meta.brand ?? '');
      const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) });
      return createProductWithDurableMedia(g.entityId, { kind: 'prepared_media', items: prepared }, {
        productExists: (pid: string) => count(db, `SELECT COUNT(*) FROM products WHERE id=?`, [pid]) > 0,
        insertProductRow: (pid: string) => { db.run(`INSERT INTO products (id, branch_id, images, brand, name, category_id, sku, attributes) VALUES (?, 'b1', '[]', ?, ?, ?, ?, ?)`, [pid, brand, meta.name ?? '', meta.categoryId ?? '', meta.sku ?? null, JSON.stringify((meta as any).attributes ?? {})]); },
        recordDurableInsert: (pid: string) => {
          db.run(`INSERT INTO sync_changelog (table_name, record_id, action) VALUES ('products', ?, 'insert')`, [pid]);
          db.run(`INSERT INTO audit_log (entity_type, entity_id) VALUES ('products', ?)`, [pid]);
          db.run(
            `INSERT OR IGNORE INTO mobile_upload_receipts (tenant_id,branch_id,authenticated_user_id,upload_event_id,payload_hash,entity_id,create_batch_id,product_id,canonical_product_metadata_hash,prepared_manifest_hash,created_at)
             VALUES ('t1','b1',?,?,?,?,?,?,?,?,'2026')`,
            [receiptIntent.authenticatedUserId, receiptIntent.uploadEventId, receiptIntent.payloadHash, pid, `create:t1:b1:${pid}:${ROLE}`, pid, receiptIntent.canonicalProductMetadataHash, receiptIntent.preparedManifestHash],
          );
        },
        rollbackProductRow: (pid: string) => {
          for (const s of [`DELETE FROM products WHERE id='${pid}'`, `DELETE FROM media_ingest_jobs WHERE requested_entity_id='${pid}'`, `DELETE FROM sync_changelog WHERE record_id='${pid}'`, `DELETE FROM audit_log WHERE entity_id='${pid}'`]) db.run(s);
          db.run(`DELETE FROM mobile_upload_receipts WHERE authenticated_user_id=? AND upload_event_id=?`, [receiptIntent.authenticatedUserId, receiptIntent.uploadEventId]);
        },
        saveDurably: async () => { disk.writes++; disk.image = db.export(); },
        buildBatchItems: async () => [],
        buildPreparedBatchItems: async (pid: string, items: PreparedMediaItem[]) => items.map((p) => ({
          tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: pid, scopeKind: 'branch', role: ROLE,
          ingestRequestId: p.ingestRequestId, requestHash: p.prepared.request_hash, isPrimary: p.isPrimary, sortOrder: p.slot,
          prepared: p.prepared, batch: { batchId: `create:t1:b1:${pid}:${ROLE}`, expectedCount: items.length },
        })),
        prepareAndRegisterBatch: (items: any[]) => orch.prepareAndRegisterBatch(items),
        finalizeBatch: (items: any[]) => orch.finalizeBatch(items),
      });
    },
    verifyReady: async (g): Promise<ReadyVerdict> => {
      const r = await new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }).resolveProductMedia(g.entityId);
      if (r.kind === 'pending') return 'pending';
      if (r.kind !== 'media') return 'broken';
      if (productImages(db, g.entityId) !== '[]') return 'broken';
      if ((r as any).items.length !== g.images.length) return 'broken';
      return 'ready';
    },
  };
}
function freshEnv(SQL: any) { const db = new SQL.Database(); seed(db); applyMediaSchema(db); const gw = new FakeGateway(); return { db, gw, disk: new Disk(), bridge: new FakeBridge(gw) }; }
async function manualCreate(deps: MobileDrainDeps, g: ClaimGrant, ev: string): Promise<PreparedMediaItem[]> {
  const prepared = await deps.preparePreparedMedia(g);
  await deps.createProduct(g, prepared, { uploadEventId: ev, payloadHash: `ph-${ev}`, authenticatedUserId: g.authenticatedUserId, canonicalProductMetadataHash: await metaHashFor(META), preparedManifestHash: await preparedManifestHash(g.images, identitiesFromPrepared(prepared)) });
  return prepared;
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 prepared create → ready; SENTINEL-FREE across every durable sink ─────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    bridge.seedAccepted('ev-1', 'prod-1', ['a', 'b', 'c']);
    const outs = await drainMobileUploads(makeDeps(db, gw, disk, bridge));
    ok(outs[0].code === 'ready', `ready (got ${outs[0].code} ${outs[0].detail ?? ''})`);
    ok(count(db, `SELECT COUNT(*) FROM products WHERE id='prod-1'`) === 1, 'one product');
    ok(productImages(db, 'prod-1') === '[]', 'products.images empty');
    ok(orderOf(db, 'prod-1') === '0,1,2', 'gallery 0,1,2');
    ok(count(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='prod-1'`) === 1, 'one changelog');
    ok(count(db, `SELECT COUNT(*) FROM audit_log WHERE entity_id='prod-1'`) === 1, 'one audit');
    ok(bridge.prepareCount === 3, `3 prepared (got ${bridge.prepareCount})`);
    // NO sentinel/fake value anywhere durable.
    const blob = [dumpText(db, `SELECT id, brand, name, category_id, sku, attributes, images FROM products`), dumpText(db, `SELECT ingest_request_id, result_json FROM media_ingest_jobs`), dumpText(db, `SELECT * FROM sync_changelog`), dumpText(db, `SELECT * FROM audit_log`), dumpText(db, `SELECT * FROM mobile_upload_receipts`)].join('|');
    ok(!/mobile-prepared|data:|blob:|file:/i.test(blob), 'no sentinel/fake URL in products/jobs/changelog/audit/receipt');
    ok(bridge.stateOf('ev-1') === 'ready', 'job ready');
  }

  // ── §2 crash after product durable, before ready → resume, exactly one ─────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    const deps = makeDeps(db, gw, disk, bridge);
    bridge.seedAccepted('ev-2', 'prod-2', ['a', 'b']);
    const g = await bridge.claim('pre', 100);
    await manualCreate(deps, g!, 'ev-2');
    await bridge.release('user-origin', 'ev-2', g!.claimToken);
    const outs = await drainMobileUploads(deps);
    ok(outs[0].code === 'resumed', `resumed (got ${outs[0].code})`);
    ok(count(db, `SELECT COUNT(*) FROM products WHERE id='prod-2'`) === 1, 'one product after resume');
    ok(bridge.stateOf('ev-2') === 'ready', 'ready on resume');
  }

  // ── §3 existing product WITHOUT receipt → TargetConflict ───────────────────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    db.run(`INSERT INTO products (id, branch_id, images) VALUES ('prod-3','b1','[]')`);
    bridge.seedAccepted('ev-3', 'prod-3', ['a']);
    const outs = await drainMobileUploads(makeDeps(db, gw, disk, bridge));
    ok(outs[0].code === 'target_conflict', `target conflict (got ${outs[0].code})`);
    ok(bridge.stateOf('ev-3') === 'quarantined', 'quarantined');
  }

  // ── §4 R1: two mobile users, same eventId, distinct entities → both separate ─
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    bridge.seedAccepted('ev-4', 'prod-4A', ['a'], { authenticatedUserId: 'user-A' });
    bridge.seedAccepted('ev-4', 'prod-4B', ['b'], { authenticatedUserId: 'user-B' });
    const outs = await drainMobileUploads(makeDeps(db, gw, disk, bridge));
    ok(outs.filter((o) => o.code === 'ready').length === 2, 'both origin users processed');
    ok(count(db, `SELECT COUNT(*) FROM mobile_upload_receipts WHERE upload_event_id='ev-4'`) === 2, 'two receipts, keyed by user');
  }

  // ── §5 identical prepare retry → SAME prepared identity (deterministic) ─────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    bridge.seedAccepted('ev-5', 'prod-5', ['a']);
    const g = await bridge.claim('x', 100);
    const p1 = await bridge.prepareImage('user-origin', 'ev-5', g!.claimToken, 0, 't1');
    const p2 = await bridge.prepareImage('user-origin', 'ev-5', g!.claimToken, 0, 't1');
    ok(p1.ingest_request_id === p2.ingest_request_id && p1.request_hash === p2.request_hash, 'same slot → identical prepared identity');
    // a different slot yields a different prepared request id (bound to slot+contentHash).
    bridge.seedAccepted('ev-5b', 'prod-5b', ['a', 'b']);
    const g2 = await bridge.claim('x', 100);
    const s0 = await bridge.prepareImage('user-origin', 'ev-5b', g2!.claimToken, 0, 't1');
    const s1 = await bridge.prepareImage('user-origin', 'ev-5b', g2!.claimToken, 1, 't1');
    ok(s0.ingest_request_id !== s1.ingest_request_id, 'different slot → different prepareRequestId');
  }

  // ── §6 tampered staging → prepare refused → quarantine ─────────────────────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    const j = bridge.seedAccepted('ev-6', 'prod-6', ['a']);
    j.images[0].contentHash = 'f'.repeat(64);
    const outs = await drainMobileUploads(makeDeps(db, gw, disk, bridge));
    ok(outs[0].code === 'manifest_invalid', `tampered → quarantine (got ${outs[0].code})`);
    ok(count(db, `SELECT COUNT(*) FROM products WHERE id='prod-6'`) === 0, 'no product');
  }

  // ── §7 stale token cannot prepare ──────────────────────────────────────────
  {
    const { bridge } = freshEnv(SQL);
    bridge.seedAccepted('ev-7', 'prod-7', ['a']);
    await bridge.claim('A', 100);
    let threw = false; try { await bridge.prepareImage('user-origin', 'ev-7', 'stale', 0, 't1'); } catch { threw = true; }
    ok(threw, 'stale token → no prepared descriptor');
  }

  // ── §8 R3: a swapped/foreign create batch cannot be marked ready ───────────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    const deps = makeDeps(db, gw, disk, bridge);
    bridge.seedAccepted('ev-8', 'prod-8', ['a']);
    const g = await bridge.claim('pre', 100);
    await manualCreate(deps, g!, 'ev-8');
    await bridge.release('user-origin', 'ev-8', g!.claimToken);
    // tamper the durable batch identity (a foreign/swapped prepared request).
    db.run(`UPDATE media_ingest_jobs SET ingest_request_id='FOREIGN' WHERE requested_entity_id='prod-8'`);
    const outs = await drainMobileUploads(deps);
    ok(outs[0].code === 'operation_conflict' && outs[0].detail === 'MOBILE_UPLOAD_BATCH_MISMATCH', `batch mismatch blocks ready (got ${outs[0].code}/${outs[0].detail})`);
    ok(bridge.stateOf('ev-8') === 'quarantined', 'swapped batch quarantined, not ready');
  }

  // ── §9 R2: two-worker lease race fenced under the prepared path ─────────────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    const deps = makeDeps(db, gw, disk, bridge);
    bridge.seedAccepted('ev-9', 'prod-9', ['a']);
    const gA = await bridge.claim('A', 5);
    await manualCreate(deps, gA!, 'ev-9');
    bridge.clock += 100;
    const gB = await bridge.claim('B', 100);
    ok((await bridge.markReady('user-origin', 'ev-9', gA!.claimToken, 'prod-9', 'ph-ev-9', 'prod-9')) === 'rejected', 'stale token cannot mark ready');
    const outB = await processMobileUploadClaim(gB!, deps);
    ok(outB.code === 'resumed', `B resumes (got ${outB.code})`);
    ok(count(db, `SELECT COUNT(*) FROM products WHERE id='prod-9'`) === 1, 'exactly one product');
    ok(count(db, `SELECT COUNT(*) FROM mobile_upload_receipts WHERE upload_event_id='ev-9'`) === 1, 'one receipt');
    ok(count(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='prod-9'`) === 1, 'one changelog');
    ok(bridge.stateOf('ev-9') === 'ready', 'ready via current token only');
  }

  // ── §10 R2: any drifted bound field → metadata mismatch → quarantine ───────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    bridge.seedAccepted('ev-10', 'prod-10', ['a']);
    const outs = await drainMobileUploads(makeDeps(db, gw, disk, bridge, { badBrand: true }));
    ok(outs[0].code === 'operation_conflict', `metadata mismatch (got ${outs[0].code})`);
    ok(bridge.stateOf('ev-10') === 'quarantined', 'quarantined');
  }

  // ── §11 R3/R4: scope mismatch writes nothing; worker per-scope ─────────────
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    bridge.seedAccepted('ev-11', 'prod-11', ['a']);
    const outs = await drainMobileUploads(makeDeps(db, gw, disk, bridge, { scope: { tenantId: 'OTHER', branchId: 'b1' } }));
    ok(outs[0].code === 'foreign_scope', `foreign scope (got ${outs[0].code})`);
    ok(count(db, `SELECT COUNT(*) FROM products`) === 0 && count(db, `SELECT COUNT(*) FROM mobile_upload_receipts`) === 0, 'scope mismatch writes nothing');
    ok(bridge.stateOf('ev-11') === 'accepted', 'foreign job untouched');
    // per-epoch/scope worker identity + single-flight + pause + no-scope.
    bridge.seedAccepted('ev-w', 'prod-w', ['a']);
    const deps = makeDeps(db, gw, disk, bridge);
    const w = (await getMobileUploadDrainWorker(deps, 1))!;
    await Promise.all([w.tick(), w.tick()]);
    ok(count(db, `SELECT COUNT(*) FROM products WHERE id='prod-w'`) === 1, 'single-flight one product');
    ok((await getMobileUploadDrainWorker(deps, 1)) === w && (await getMobileUploadDrainWorker(deps, 2)) !== w, 'per-epoch worker');
    ok((await getMobileUploadDrainWorker(makeDeps(db, gw, disk, bridge, { scope: null }), 3)) === null, 'no worker without scope');
  }

  // ── §12 manifest structure unit ────────────────────────────────────────────
  {
    ok(verifyGrantManifest(mkGrant('e', 'p', ['a', 'b'])).ok, 'valid manifest');
    const gap = mkGrant('e', 'p', ['a', 'b']); gap.images[1].slot = 2;
    ok(!verifyGrantManifest(gap).ok, 'slot gap rejected');
  }

  // ── §13 R4: three-way — a tampered active gallery (primary drift) blocks ready ─
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    const deps = makeDeps(db, gw, disk, bridge);
    bridge.seedAccepted('ev-13', 'prod-13', ['a', 'b']);
    const g = await bridge.claim('pre', 100);
    await manualCreate(deps, g!, 'ev-13');
    await bridge.release('user-origin', 'ev-13', g!.claimToken);
    db.run(`UPDATE media_links SET is_primary=0 WHERE entity_id='prod-13' AND sort_order=0`); // primary drift
    const outs = await drainMobileUploads(deps);
    ok(outs[0].code === 'operation_conflict', `gallery drift blocks ready (got ${outs[0].code})`);
    ok(bridge.stateOf('ev-13') === 'quarantined', 'gallery-drifted product not ready');
  }

  // ── §14 R4: a duplicated changelog blocks ready (exactly-one side effects) ──
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    const deps = makeDeps(db, gw, disk, bridge);
    bridge.seedAccepted('ev-14', 'prod-14', ['a']);
    const g = await bridge.claim('pre', 100);
    await manualCreate(deps, g!, 'ev-14');
    await bridge.release('user-origin', 'ev-14', g!.claimToken);
    db.run(`INSERT INTO sync_changelog (table_name, record_id, action) VALUES ('products','prod-14','insert')`); // a second changelog
    const outs = await drainMobileUploads(deps);
    ok(outs[0].code === 'operation_conflict', `duplicate changelog blocks ready (got ${outs[0].code})`);
    ok(bridge.stateOf('ev-14') === 'quarantined', 'not ready with a duplicated side effect');
  }

  // ── §15 structural: sentinel-free drain + STRICT MediaSource contract + blocked activation ─
  {
    const src = readFileSync(join(repo, 'src/core/media/mobile-upload-drain.ts'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    ok(!/INSERT\s+INTO\s+products/i.test(src) && !/UPDATE\s+products/i.test(src), 'no direct products write');
    ok(!src.includes('fetchImage') && src.includes('prepareImage'), 'prepares descriptors, no byte fetch');
    ok(!src.includes('btoa(') && !/data:\$\{/.test(src) && !src.includes('mobile-prepared'), 'no base64 / data URL / sentinel in the drain');
    // STRICT MediaSource: the core rejects the bare-string[] alias, no implicit normalization.
    const core = readFileSync(join(repo, 'src/core/media/product-media-create.ts'), 'utf8');
    ok(/source:\s*MediaSource,/.test(core) && !/MediaSource\s*\|\s*string\[\]/.test(core) && !core.includes('Array.isArray(input)'), 'create core takes only a discriminated MediaSource');
    // no bare-array create calls anywhere (all migrated to { kind: 'data_urls', ... }).
    for (const f of ['test/media04a3b2b/create.test.ts', 'test/media04a3b2br5/insert-durability.test.ts', 'src/stores/productStore.ts']) {
      const t = readFileSync(join(repo, f), 'utf8');
      ok(!/createProductWithDurableMedia\([^,]+,\s*\[/.test(t) && !/createProductWithDurableMedia\([^,]+,\s*(urls|original|images)\b/.test(t), `no bare-array createProductWithDurableMedia in ${f}`);
    }
    // mobile wiring only ever creates via prepared_media, and auto-activation is blocked.
    const wiring = readFileSync(join(repo, 'src/core/media/mobile-upload-wiring.ts'), 'utf8');
    ok(wiring.includes("kind: 'prepared_media'") && !wiring.includes("kind: 'data_urls'"), 'mobile wiring uses only prepared_media');
    // MOBILE-04B2A3 — the gate is the Rust canonical binding compared EXACTLY to the active scope,
    // no hardcoded flag. The post-auth trigger refreshes Rust evidence first; the deps predicate is
    // runtimeScopeAvailable(cachedEvidence, currentScope()). Production stays blocked because the
    // owner-configure command is unregistered, so the binding is never configured.
    // R1: the gate reads Rust evidence FRESH each call (no persistent cache), via the read command.
    ok(wiring.includes('readScopeEvidence') && wiring.includes("invoke<RuntimeScopeEvidence>('mobile_runtime_scope_evidence')"), 'gate reads the Rust canonical binding fresh');
    ok(!/RUNTIME_SCOPE_SOURCE_AVAILABLE/.test(wiring), 'the hardcoded R4/R5 availability flag is gone');
    ok(!/cachedRuntimeScopeEvidence/.test(wiring), 'no persistent cached-evidence trust (R1 §2)');
    const store = readFileSync(join(repo, 'src/stores/productStore.ts'), 'utf8');
    ok(!store.includes('mobile-prepared:'), 'no sentinel in the store create path');
  }

  // ── §16 R5: hard runtime deactivation — no hidden activity while scope is blocked ───────────
  {
    // (a) JS worker hard-block: direct drain, worker start, and post-auth trigger all abort BEFORE
    // any claim — even with a valid current scope present (hardcoded scope cannot bypass the gate).
    const gw = new FakeGateway(); const disk = new Disk();
    const SQL = await initSqlJs({ locateFile: () => WASM }); const db = new SQL.Database();
    seed(db); applyMediaSchema(db as any);
    const bridge = new FakeBridge(gw);
    bridge.seedAccepted('ev-blocked', 'p-blocked', ['imgA', 'imgB']);
    const blocked = makeDeps(db, gw, disk, bridge, { scopeBlocked: true, scope: { tenantId: 't1', branchId: 'b1' } });

    const dOut = await drainMobileUploads(blocked);
    ok(dOut.length === 1 && dOut[0].code === 'scope_blocked', 'direct drain → scope_blocked');
    ok((await getMobileUploadDrainWorker(blocked, 1)) === null, 'no worker while scope blocked');
    triggerMobileUploadDrainSafe(blocked, 1); // must be a no-op, never throw
    await new Promise((r) => setTimeout(r, 0));

    // (b) prove zero hidden activity: 0 claims, 0 prepares, 0 receipts/products/batch/changelog/audit.
    ok(bridge.claimCount === 0, 'blocked: 0 claims issued');
    ok(bridge.prepareCount === 0, 'blocked: 0 prepared-media requests');
    ok(count(db, `SELECT COUNT(*) FROM mobile_upload_receipts`) === 0, 'blocked: 0 receipts');
    ok(count(db, `SELECT COUNT(*) FROM products`) === 0, 'blocked: 0 products');
    ok(count(db, `SELECT COUNT(*) FROM media_ingest_jobs`) === 0, 'blocked: 0 media_ingest_jobs');
    ok(count(db, `SELECT COUNT(*) FROM sync_changelog`) === 0, 'blocked: 0 sync_changelog');
    ok(count(db, `SELECT COUNT(*) FROM audit_log`) === 0, 'blocked: 0 audit_log');
    ok(disk.writes === 0, 'blocked: 0 durable saves');
    // (c) the existing Rust inbox job stays untouched: still `accepted`, still claimable later.
    ok(bridge.stateOf('ev-blocked') === 'accepted', 'blocked: existing accepted job unchanged');
    db.close();
  }

  // ── §17 A6-I1: Rust runtime commands REGISTERED but scope-gated + evidence-driven (structural) ─
  {
    const lib = readFileSync(join(repo, 'src-tauri/src/lib.rs'), 'utf8');
    const hStart = lib.indexOf('generate_handler![');
    const handler = lib.slice(hStart, lib.indexOf('finalize_application_shutdown', hStart) + 'finalize_application_shutdown'.length);
    // MOBILE-04B2A6-I1: the six mutation commands are now registered (activation is scope-gated, not
    // registration-blocked). Inertness comes from the evidence-driven gate + the in-tx fence, not from
    // being absent from the handler.
    for (const cmd of ['mobile_upload_claim', 'mobile_upload_prepare_image', 'mobile_upload_renew', 'mobile_upload_release', 'mobile_upload_mark_quarantined', 'mobile_upload_mark_ready']) {
      ok(new RegExp(`^\\s*${cmd},`, 'm').test(handler), `command registered: ${cmd}`);
    }
    // every wrapper opens the config DB, builds the server-derived scope, then runs the evidence-driven
    // gate BEFORE any claim/prepare/status mutation (the fenced core call).
    for (const cmd of ['mobile_upload_claim', 'mobile_upload_prepare_image', 'mobile_upload_renew', 'mobile_upload_release', 'mobile_upload_mark_quarantined', 'mobile_upload_mark_ready']) {
      const body = lib.slice(lib.indexOf(`fn ${cmd}(`), lib.indexOf(`fn ${cmd}(`) + 1400);
      const dbAt = body.indexOf('open_config_db(');
      const scopeAt = body.indexOf('mobile_scope_expectation(install_id,');
      const gateAt = body.indexOf('mobile_runtime_gate(&conn, &scope)?');
      const fencedAt = body.search(/_fenced\(/);
      ok(dbAt > 0 && scopeAt > dbAt && gateAt > scopeAt && fencedAt > gateAt, `${cmd} gates on evidence before the fenced mutation`);
      ok(!/mobile_runtime_gate\(\)\?/.test(body), `${cmd} has no legacy arg-less gate`);
    }
    // the hard compile-time block is gone; the gate is evidence-driven (delegates to the SSOT fence).
    ok(!/MOBILE_RUNTIME_SCOPE_SOURCE_AVAILABLE/.test(lib), 'hard block constant removed');
    ok(!/MOBILE_RUNTIME_SCOPE_SOURCE_BLOCKED/.test(lib), 'unconditional block error string removed');
    const gate = lib.slice(lib.indexOf('fn mobile_runtime_gate('), lib.indexOf('fn mobile_runtime_gate(') + 500);
    ok(/fence_runtime_scope\(/.test(gate), 'gate is evidence-driven (fresh-read exact-match fence)');
  }

  // ── §18 A3: binding-revision change FENCES a running worker (no processing under stale rev) ──
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    bridge.seedAccepted('ev-fence', 'p-fence', ['a', 'b']);
    let rev = 1;
    const deps = makeDeps(db, gw, disk, bridge, { bindingRevision: () => rev });
    const w1 = (await getMobileUploadDrainWorker(deps, 1))!;
    ok(w1.bindingRevision === 1, 'worker captured revision 1 (from a fresh read)');
    // Rust rebinds → revision changes. The already-created worker re-reads FRESH and is fenced.
    rev = 2;
    const out = await w1.tick();
    ok(out.length === 1 && out[0].code === 'scope_blocked', 'stale-revision worker tick → scope_blocked');
    ok(bridge.claimCount === 0, 'fenced worker issues 0 claims');
    ok((await getMobileUploadDrainWorker(deps, 1)) !== w1, 'a new worker is minted for the new revision');
    ok(count(db, `SELECT COUNT(*) FROM products`) === 0 && bridge.stateOf('ev-fence') === 'accepted', 'no processing; job stays accepted');
    db.close();
  }

  // ── §19 A3: a rebind DURING an in-flight claim never marks ready — releases, job stays claimable ─
  {
    const { db, gw, disk, bridge } = freshEnv(SQL);
    bridge.seedAccepted('ev-inflight', 'p-inflight', ['a', 'b']);
    let rev = 1;
    const deps = makeDeps(db, gw, disk, bridge, { bindingRevision: () => rev });
    // Real create + verification run fully; the binding rebinds right AFTER verify, before markReady.
    const origVerify = deps.verifyReady;
    deps.verifyReady = async (g) => { const v = await origVerify(g); rev = 2; return v; };
    const out = await processMobileUploadClaim((await bridge.claim('w', 120))!, deps);
    ok(out.code === 'deferred' && out.detail === 'scope_fenced', `in-flight rebind → deferred/scope_fenced (got ${out.code}/${out.detail})`);
    ok(bridge.stateOf('ev-inflight') === 'accepted', 'job released (not ready, not quarantined) → still claimable');
    // the product may be durable (create is a real checkpoint) but the Rust job was NOT marked ready.
    db.close();
  }

  console.log(`\nMOBILE-04B2A2 drain-handoff: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
