// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C1-R1 — partial-publish recovery proof for edit batches
// Run: node test/media04a3b2c1r1/partial-publish.test.ts
//
// REAL sql.js + REAL orchestrator/coordinator/resolver + REAL edit planner.
// A fake gateway records prepare/commit and (like the Rust journal) keeps
// staged/published renditions across a "reopen". No productive DB, no Tauri,
// no base64/product-id logged.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { createHash } from 'node:crypto';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import {
  StockMediaOrchestrator, type OrchestratorLease, type OrchestratorRawDb,
  type IngestAndFinalizeInput, type EditScope, type EditNewImageInput,
} from '../../src/core/media/orchestrator.ts';
import { classifyPendingIngest } from '../../src/core/media/coordinator.ts';
import { buildEditPlanEnvelope, type EditDesiredSlot } from '../../src/core/media/product-media-edit.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } }

function dataBytes(s: string): Uint8Array { const b = new Uint8Array(24); for (let i = 0; i < 24; i++) b[i] = (s.charCodeAt(i % s.length) + i) & 0xff; return b; }
function sha256Hex(b: Uint8Array): string { return createHash('sha256').update(Buffer.from(b)).digest('hex'); }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
const digestHex = async (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainB: Uint8Array; thumbB: Uint8Array }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  private reqBytes = new Map<string, Uint8Array>();
  commitShouldThrowFor: string | null = null;
  corruptHash: string | null = null;      // readVerifiedMedia throws for this hash
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
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> {
    if (this.corruptHash === i.hash) throw new Error('MEDIA_FILE_HASH_MISMATCH');
    const f = this.files.get(`${i.tenantScope}::${i.hash}`); if (!f) throw new Error('MEDIA_FILE_MISSING');
    return { bytes: f.bytes, hash: i.hash, byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext };
  }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}
function desc(hash: string, size: number) { return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 800, height: 600 }; }

class Disk { image: Uint8Array | null = null; }
function leaseFor(db: OrchestratorRawDb, disk: Disk): OrchestratorLease {
  return { db, epoch: 0, async saveDurably() { disk.image = (db as unknown as { export(): Uint8Array }).export(); }, release() {} };
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
function scopeFor(pid: string): EditScope { return { tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: 'product', entityId: pid, role: ROLE }; }
function orchFor(db: any, gw: FakeGateway, disk: Disk) { return new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) }); }
function resolverFor(db: any, gw: FakeGateway) { return new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }); }
function createItem(pid: string, i: number, n: number): IngestAndFinalizeInput {
  const bytes = dataBytes(`t1-${pid}-${i}`);
  return { tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: pid, scopeKind: 'branch', role: ROLE,
    ingestRequestId: `create:t1:b1:${pid}:${ROLE}:${i}`, requestHash: sha256Hex(bytes), isPrimary: i === 0, sortOrder: i,
    imageBytes: bytes, batch: { batchId: `create:t1:b1:${pid}:${ROLE}`, expectedCount: n } };
}
async function seedGallery(db: any, gw: FakeGateway, disk: Disk, pid: string, n: number): Promise<void> {
  const orch = orchFor(db, gw, disk);
  const items = Array.from({ length: n }, (_, i) => createItem(pid, i, n));
  await orch.prepareAndRegisterBatch(items); await orch.finalizeBatch(items);
}
function gal(db: any, pid: string): Array<{ mediaId: string; slot: number; primary: boolean }> {
  const r = db.exec(`SELECT media_id, sort_order, is_primary FROM media_links WHERE tenant_id='t1' AND branch_id='b1' AND entity_id=? AND deleted_at IS NULL ORDER BY sort_order ASC`, [pid]);
  if (!r.length) return [];
  return r[0].values.map((v: any[]) => ({ mediaId: String(v[0]), slot: Number(v[1]), primary: Number(v[2]) === 1 }));
}
function sig(db: any, pid: string): string { return gal(db, pid).map(x => `${x.slot}:${x.mediaId}:${x.primary ? 1 : 0}`).join('|'); }
interface NewImg { rid: string; bytes: Uint8Array; }
function newImg(pid: string, tag: string): NewImg { return { rid: `edit-new:${pid}:${tag}`, bytes: dataBytes(`${pid}-new-${tag}`) }; }
async function planEdit(orch: StockMediaOrchestrator, scope: EditScope, batchId: string, news: NewImg[], buildDesired: (b: any[]) => EditDesiredSlot[]) {
  const newItems: EditNewImageInput[] = news.map(n => ({ tenantId: scope.tenantId, ingestRequestId: n.rid, requestHash: sha256Hex(n.bytes), imageBytes: n.bytes }));
  return orch.prepareAndRegisterEdit(scope, newItems, async (baseline, prepared) =>
    buildEditPlanEnvelope({ batchId, tenantId: scope.tenantId, branchId: scope.branchId, scopeKind: scope.scopeKind, entityType: scope.entityType, entityId: scope.entityId, role: scope.role, baseline, desired: buildDesired(baseline), prepared }, digestHex));
}
const keep = (mediaId: string): EditDesiredSlot => ({ source: 'keep', mediaId });
const add = (n: NewImg): EditDesiredSlot => ({ source: 'new', requestId: n.rid, requestHash: sha256Hex(n.bytes) });
function editIntentJson(batchId: string, baselineMediaId: string): string {
  // A well-formed edit_plan envelope (append one new image to a 1-image gallery).
  return JSON.stringify({ kind: 'edit_plan', version: 1, plan: {
    batchId, tenantId: 't1', branchId: 'b1', scopeKind: 'branch', entityType: 'product', entityId: 'p1', role: ROLE,
    baseline: [{ linkId: 'L', mediaId: baselineMediaId, storedHash: 'h', sortOrder: 0, isPrimary: true }],
    target: [{ source: 'keep', mediaId: baselineMediaId, storedHash: 'h' }, { source: 'new', requestId: 'R', requestHash: '0'.repeat(64), storedHash: 'a'.repeat(64) }],
    planHash: 'b'.repeat(64),
  }, newRenditions: [{ requestId: 'R', main: desc('a'.repeat(64), 10), thumbnail: desc('c'.repeat(64), 5) }] });
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 partial publish: A published, crash before B + before tx ────────
  //     reopen → recovery publishes B, applies the SAME plan once, no dups ─
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 'p1', 1);
    const before = sig(db, 'p1');
    const A = newImg('p1', 'A'); const B = newImg('p1', 'B');
    const env = await planEdit(orch, scopeFor('p1'), 'e1', [A, B], (b) => [keep(b[0].mediaId), add(A), add(B)]);
    ok(env.newRenditions.length === 2, 'plan binds two new renditions');
    // apply: A commits (published), B commit lost → throw before the tx.
    gw.commitShouldThrowFor = B.rid;
    let threw = false; try { await orch.applyEditDurably(env); } catch { threw = true; }
    ok(threw, 'apply throws when B is lost mid-publish');
    ok(gw.commits.includes(A.rid), 'image A was published before the loss');
    ok(sig(db, 'p1') === before, 'no partial link mutation — old gallery unchanged in memory');
    // Reopen with NO JS state; only the durable cp1 + the Rust-journal (gw).
    const db2 = reopen(SQL, disk); const disk2 = new Disk(); disk2.image = db2.export();
    ok(sig(db2, 'p1') === before, 'reopen: old gallery on disk (link tx never ran)');
    ok((await resolverFor(db2, gw).resolveProductMedia('p1')).kind === 'media', 'reopen: resolver shows old media, never partial/pending');
    gw.commitShouldThrowFor = null;
    const orch2 = orchFor(db2, gw, disk2);
    const rep = await orch2.recoverPendingStockMedia();
    ok(gw.commits.filter(c => c === B.rid).length >= 1, 'recovery published the remaining image B');
    const g = gal(db2, 'p1');
    ok(g.length === 3 && g[0].mediaId === b0(db2) && g[0].primary, 'recovery applied the exact frozen target');
    ok(g[1].mediaId === `media-${A.rid}` && g[2].mediaId === `media-${B.rid}`, 'target order A@1, B@2');
    ok(new Set(g.map(x => x.mediaId)).size === 3, 'no duplicate links');
    ok(rep.dbReport.filter(r => r.action === 'edit_applied_from_plan').length === 1, 'plan applied exactly once');
    // A second recovery is a pure no-op (job ready).
    const rep2 = await orch2.recoverPendingStockMedia();
    ok(gal(db2, 'p1').length === 3 && rep2.dbReport.some(r => r.action === 'noop_already_ready'), 'second recovery: no re-apply, no duplicates');
  }

  // ── §2 A published, B permanently missing → old gallery, retryable ─────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 'p1', 1);
    const before = sig(db, 'p1');
    const A = newImg('p1', 'A'); const B = newImg('p1', 'B');
    const env = await planEdit(orch, scopeFor('p1'), 'e2', [A, B], (b) => [keep(b[0].mediaId), add(A), add(B)]);
    gw.commitShouldThrowFor = B.rid;
    try { await orch.applyEditDurably(env); } catch { /* expected */ }
    // Reopen; B still unpublishable (commit keeps failing).
    const db2 = reopen(SQL, disk); const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = orchFor(db2, gw, disk2);
    const rep = await orch2.recoverPendingStockMedia();
    ok(sig(db2, 'p1') === before, 'B missing → OLD gallery unchanged, no partial mutation');
    ok(rep.dbReport.some(r => r.action === 'left_pending_no_rust_result'), 'plan left safely retryable (no Rust result)');
    ok(gal(db2, 'p1').length === 1, 'no links added while a new image is unpublishable');
    // Once B becomes publishable, the same plan converges.
    gw.commitShouldThrowFor = null;
    await orch2.recoverPendingStockMedia();
    ok(gal(db2, 'p1').length === 3, 'retry after B recovers → exact target, no duplicates');
  }

  // ── §3 A published, B corrupt (verify fails) → quarantined, old gallery ─
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 'p1', 1);
    const before = sig(db, 'p1');
    const A = newImg('p1', 'A'); const B = newImg('p1', 'B');
    const env = await planEdit(orch, scopeFor('p1'), 'e3', [A, B], (b) => [keep(b[0].mediaId), add(A), add(B)]);
    // B's main stored hash — corrupt it so verify fails on apply/recovery.
    const bMainHash = env.newRenditions.find(r => r.requestId === B.rid)!.main.hash;
    gw.corruptHash = bMainHash;
    try { await orch.applyEditDurably(env); } catch { /* expected */ }
    const db2 = reopen(SQL, disk); const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = orchFor(db2, gw, disk2);
    const rep = await orch2.recoverPendingStockMedia();
    ok(sig(db2, 'p1') === before, 'B corrupt → OLD gallery unchanged, no partial mutation');
    ok(rep.dbReport.some(r => r.action === 'quarantined_verification_failed'), 'corrupt new image → plan typed-blocked (quarantined)');
    ok(gal(db2, 'p1').length === 1, 'no links added for a corrupt edit');
  }

  // ── §4 edit_plan classification: valid → not create-pending/corrupt ────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 'p1', 1);
    const A = newImg('p1', 'A');
    // Register (cp1) but do NOT apply → a valid, in-flight edit_plan job exists.
    await planEdit(orch, scopeFor('p1'), 'e4', [A], (b) => [keep(b[0].mediaId), add(A)]);
    const rj = db.exec(`SELECT result_json FROM media_ingest_jobs WHERE ingest_request_id='edit:e4'`)[0].values[0][0] as string;
    const cls = classifyPendingIngest([rj]);
    ok(cls.kind === 'none', 'valid edit_plan is NOT create-pending and NOT corrupt (classify=none)');
    ok((await resolverFor(db, gw).resolveProductMedia('p1')).kind === 'media', 'in-flight valid edit keeps the OLD gallery visible (media)');
  }

  // ── §5 malformed edit_plan → fail closed (classify conflict) ───────────
  {
    const malformed = JSON.stringify({ kind: 'edit_plan', version: 1, plan: { batchId: 'x' } }); // missing required fields
    const cls = classifyPendingIngest([malformed]);
    ok(cls.kind === 'conflict', 'malformed edit_plan → fail closed (classify=conflict)');
    // A well-formed one parses fine (guards the fixture itself).
    const okCls = classifyPendingIngest([editIntentJson('e5', 'media-x')]);
    ok(okCls.kind === 'none', 'well-formed edit_plan fixture classifies as none');
  }

  // ── §6 remove-only recovery still green (regression) ───────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 'p1', 3);
    const base = gal(db, 'p1');
    // Remove-only plan (no new image); simulate save-loss after tx via reopen
    // at cp1, then recovery must still converge to the target.
    const env = await planEdit(orch, scopeFor('p1'), 'e6', [], (b) => [keep(b[0].mediaId), keep(b[2].mediaId)]);
    // Reopen at cp1 (plan durable, gallery still 3) BEFORE applying.
    const db2 = reopen(SQL, disk); const disk2 = new Disk(); disk2.image = db2.export();
    ok(gal(db2, 'p1').length === 3, 'reopen before apply: old 3-image gallery');
    const orch2 = orchFor(db2, gw, disk2);
    void env;
    await orch2.recoverPendingStockMedia();
    const g = gal(db2, 'p1');
    ok(g.length === 2 && g[0].mediaId === base[0].mediaId && g[1].mediaId === base[2].mediaId, 'remove-only recovery → exact target');
    ok(g[0].primary && !g[1].primary, 'remove-only: one primary at slot 0');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2C1-R1 partial-publish: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   • ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2C1-R1 partial-publish: ${PASS}/${PASS} checks passed`);
}

/** media id of the baseline (single-image gallery) kept at slot 0. */
function b0(db: any): string {
  const g = db.exec(`SELECT media_id FROM media_links WHERE entity_id='p1' AND sort_order=0 AND deleted_at IS NULL`);
  return String(g[0].values[0][0]);
}

main().catch((e) => { console.error(e); process.exit(1); });
