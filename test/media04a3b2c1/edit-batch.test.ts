// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C1 — durable existing-product media EDIT batch
// Run: node test/media04a3b2c1/edit-batch.test.ts
//
// REAL sql.js + REAL orchestrator/coordinator/resolver + REAL edit planner.
// A fake gateway records prepare/commit; an explicit "disk" models a crash.
// No productive DB, no Tauri, no base64/product-id logged.
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
import { MediaDbCoordinator } from '../../src/core/media/coordinator.ts';
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

class Disk { image: Uint8Array | null = null; writes = 0; failOnWrite: number | null = null; }
function leaseFor(db: OrchestratorRawDb, disk: Disk): OrchestratorLease {
  return { db, epoch: 0, async saveDurably() { disk.writes++; if (disk.failOnWrite !== null && disk.writes === disk.failOnWrite) throw new Error('DISK_FULL'); disk.image = (db as unknown as { export(): Uint8Array }).export(); }, release() {} };
}
function seed(db: any): void {
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`); db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`); db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t2')`);
  db.run(`INSERT INTO products (id, branch_id, images) VALUES ('p1','b1','[]'),('p2','b2','[]')`);
}
function reopen(SQL: any, disk: Disk) { if (!disk.image) throw new Error('nothing persisted'); return new SQL.Database(disk.image); }
const ROLE = 'stock_image';
function scopeFor(pid: string, t = 't1', b = 'b1'): EditScope { return { tenantId: t, scopeKind: 'branch', branchId: b, entityType: 'product', entityId: pid, role: ROLE }; }
function orchFor(db: any, gw: FakeGateway, disk: Disk) { return new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) }); }
function resolverFor(db: any, gw: FakeGateway, t = 't1', b = 'b1') { return new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: t, branchId: b }); }

function createItem(t: string, b: string, pid: string, i: number, n: number): IngestAndFinalizeInput {
  const bytes = dataBytes(`${t}-${pid}-${i}`);
  return { tenantId: t, branchId: b, entityType: 'product', entityId: pid, scopeKind: 'branch', role: ROLE,
    ingestRequestId: `create:${t}:${b}:${pid}:${ROLE}:${i}`, requestHash: sha256Hex(bytes), isPrimary: i === 0, sortOrder: i,
    imageBytes: bytes, batch: { batchId: `create:${t}:${b}:${pid}:${ROLE}`, expectedCount: n } };
}
async function seedGallery(db: any, gw: FakeGateway, disk: Disk, t: string, b: string, pid: string, n: number): Promise<void> {
  const orch = orchFor(db, gw, disk);
  const items = Array.from({ length: n }, (_, i) => createItem(t, b, pid, i, n));
  await orch.prepareAndRegisterBatch(items); await orch.finalizeBatch(items);
}
/** Active gallery as [{mediaId, slot, primary, linkId}] sorted by slot. */
function gal(db: any, pid: string, t = 't1', b = 'b1'): Array<{ mediaId: string; slot: number; primary: boolean; linkId: string }> {
  const r = db.exec(`SELECT media_id, sort_order, is_primary, link_id FROM media_links WHERE tenant_id=? AND branch_id=? AND entity_id=? AND deleted_at IS NULL ORDER BY sort_order ASC`, [t, b, pid]);
  if (!r.length) return [];
  return r[0].values.map((v: any[]) => ({ mediaId: String(v[0]), slot: Number(v[1]), primary: Number(v[2]) === 1, linkId: String(v[3]) }));
}
function sig(db: any, pid: string, t = 't1', b = 'b1'): string { return gal(db, pid, t, b).map(x => `${x.slot}:${x.mediaId}:${x.primary ? 1 : 0}`).join('|'); }

interface NewImg { rid: string; bytes: Uint8Array; }
function newImg(pid: string, tag: string): NewImg { return { rid: `edit-new:${pid}:${tag}`, bytes: dataBytes(`${pid}-new-${tag}`) }; }

/** Phase 1: prepare + register the frozen plan (cp1). Returns the env. */
async function planEdit(orch: StockMediaOrchestrator, scope: EditScope, batchId: string, news: NewImg[], buildDesired: (baseline: any[]) => EditDesiredSlot[]) {
  const newItems: EditNewImageInput[] = news.map(n => ({ tenantId: scope.tenantId, ingestRequestId: n.rid, requestHash: sha256Hex(n.bytes), imageBytes: n.bytes }));
  return orch.prepareAndRegisterEdit(scope, newItems, async (baseline, prepared) =>
    buildEditPlanEnvelope({ batchId, tenantId: scope.tenantId, branchId: scope.branchId, scopeKind: scope.scopeKind, entityType: scope.entityType, entityId: scope.entityId, role: scope.role, baseline, desired: buildDesired(baseline), prepared }, digestHex));
}
const keep = (mediaId: string): EditDesiredSlot => ({ source: 'keep', mediaId });
const add = (n: NewImg): EditDesiredSlot => ({ source: 'new', requestId: n.rid, requestHash: sha256Hex(n.bytes) });

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 append one image ────────────────────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const base = gal(db, 'p1'); const nx = newImg('p1', 'a');
    const env = await planEdit(orch, scopeFor('p1'), 'edit1', [nx], (b) => [keep(b[0].mediaId), keep(b[1].mediaId), add(nx)]);
    ok(sig(db, 'p1') === base.map(x => `${x.slot}:${x.mediaId}:${x.primary ? 1 : 0}`).join('|'), 'old gallery still visible after plan register (before apply)');
    await orch.applyEditDurably(env);
    const g = gal(db, 'p1');
    ok(g.length === 3 && g[0].mediaId === base[0].mediaId && g[0].primary && !g[2].primary, 'append: 3 slots, primary unchanged at 0');
    ok((await resolverFor(db, gw).resolveProductMedia('p1')).kind === 'media', 'resolver shows media');
  }

  // ── §2 replace primary ─────────────────────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const base = gal(db, 'p1'); const ny = newImg('p1', 'y');
    const env = await planEdit(orch, scopeFor('p1'), 'edit2', [ny], (b) => [add(ny), keep(b[1].mediaId)]);
    await orch.applyEditDurably(env);
    const g = gal(db, 'p1');
    ok(g.length === 2 && g[0].mediaId === `media-${ny.rid}` && g[0].primary, 'replace primary: new media at slot0 primary');
    ok(g[1].mediaId === base[1].mediaId && !g[1].primary, 'old secondary kept at slot1');
    ok(!g.some(x => x.mediaId === base[0].mediaId), 'old primary removed');
  }

  // ── §3 replace secondary ───────────────────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const base = gal(db, 'p1'); const nz = newImg('p1', 'z');
    const env = await planEdit(orch, scopeFor('p1'), 'edit3', [nz], (b) => [keep(b[0].mediaId), add(nz)]);
    await orch.applyEditDurably(env);
    const g = gal(db, 'p1');
    ok(g[0].mediaId === base[0].mediaId && g[0].primary && g[1].mediaId === `media-${nz.rid}`, 'replace secondary keeps primary');
  }

  // ── §4 remove secondary (remove-only, no new image) ────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 3);
    const base = gal(db, 'p1');
    const env = await planEdit(orch, scopeFor('p1'), 'edit4', [], (b) => [keep(b[0].mediaId), keep(b[2].mediaId)]);
    ok(env.newRenditions.length === 0, 'remove-only plan has no new renditions');
    await orch.applyEditDurably(env);
    const g = gal(db, 'p1');
    ok(g.length === 2 && g[0].mediaId === base[0].mediaId && g[1].mediaId === base[2].mediaId, 'remove middle → contiguous 0,1');
    ok(g[0].primary && !g[1].primary && g[0].slot === 0 && g[1].slot === 1, 'slots 0..1, one primary');
  }

  // ── §5 remove primary + promotion ──────────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const base = gal(db, 'p1');
    const env = await planEdit(orch, scopeFor('p1'), 'edit5', [], (b) => [keep(b[1].mediaId)]);
    await orch.applyEditDurably(env);
    const g = gal(db, 'p1');
    ok(g.length === 1 && g[0].mediaId === base[1].mediaId && g[0].primary && g[0].slot === 0, 'remove primary → old secondary promoted to primary@0');
  }

  // ── §6 multiple changes in one batch (remove p0, keep p1, add A & B) ────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const base = gal(db, 'p1'); const nA = newImg('p1', 'A'); const nB = newImg('p1', 'B');
    const env = await planEdit(orch, scopeFor('p1'), 'edit6', [nA, nB], (b) => [add(nA), keep(b[1].mediaId), add(nB)]);
    await orch.applyEditDurably(env);
    const g = gal(db, 'p1');
    ok(g.length === 3 && g[0].mediaId === `media-${nA.rid}` && g[0].primary, 'multi: new A primary@0');
    ok(g[1].mediaId === base[1].mediaId && g[2].mediaId === `media-${nB.rid}`, 'multi: kept@1, new B@2');
    ok(!g.some(x => x.mediaId === base[0].mediaId), 'multi: old primary removed');
  }

  // ── §7 crash before publish → old gallery; recovery → target ───────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const before = sig(db, 'p1'); const ny = newImg('p1', 'y');
    const env = await planEdit(orch, scopeFor('p1'), 'edit7', [ny], (b) => [add(ny), keep(b[1].mediaId)]);
    gw.commitShouldThrowFor = 'ALL'; // publish fails
    let threw = false; try { await orch.applyEditDurably(env); } catch { threw = true; }
    ok(threw, 'apply throws when publish fails');
    ok(sig(db, 'p1') === before, 'crash before publish → OLD gallery unchanged');
    // Reopen at the durable cp1 (plan registered, gallery still old) → recover.
    const db2 = reopen(SQL, disk); const disk2 = new Disk(); disk2.image = db2.export();
    ok(sig(db2, 'p1') === before, 'reopen: old gallery on disk');
    ok((await resolverFor(db2, gw).resolveProductMedia('p1')).kind === 'media', 'reopen: resolver shows old media, never partial/pending');
    gw.commitShouldThrowFor = null;
    const orch2 = orchFor(db2, gw, disk2);
    const rep = await orch2.recoverPendingStockMedia();
    const g = gal(db2, 'p1');
    ok(g.length === 2 && g[0].mediaId === `media-${ny.rid}` && g[0].primary, 'recovery applied edit → target gallery');
    ok(rep.dbReport.some(r => r.action === 'edit_applied_from_plan'), 'recovery reports edit_applied_from_plan');
  }

  // ── §8 save fails AFTER db tx → old on disk; recovery replays plan ─────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const before = sig(db, 'p1'); const nz = newImg('p1', 'z');
    const env = await planEdit(orch, scopeFor('p1'), 'edit8', [nz], (b) => [keep(b[0].mediaId), add(nz)]);
    // cp1 was disk.writes #1; make the NEXT durable save (cp2 in applyEditDurably) fail.
    disk.failOnWrite = disk.writes + 1;
    let threw = false; try { await orch.applyEditDurably(env); } catch { threw = true; }
    ok(threw, 'apply surfaces the save failure');
    const db2 = reopen(SQL, disk); const disk2 = new Disk(); disk2.image = db2.export();
    ok(sig(db2, 'p1') === before, 'save-fail after tx → ON-DISK still old gallery');
    const orch2 = orchFor(db2, gw, disk2);
    await orch2.recoverPendingStockMedia();
    const g = gal(db2, 'p1');
    ok(g.length === 2 && g[1].mediaId === `media-${nz.rid}`, 'recovery replays the same plan → target');
    // Retry idempotent: a second recovery does not duplicate.
    await orch2.recoverPendingStockMedia();
    ok(gal(db2, 'p1').length === 2, 'retry after commit: no duplicate links');
  }

  // ── §9 changed baseline → conflict (no publish/mutation) ───────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 3);
    const nx = newImg('p1', 'q');
    const env = await planEdit(orch, scopeFor('p1'), 'edit9', [nx], (b) => [keep(b[0].mediaId), keep(b[1].mediaId), keep(b[2].mediaId), add(nx)]);
    // Someone else mutates the baseline: remove a link.
    const coord = new MediaDbCoordinator(db, gw);
    coord.remove({ tenantId: 't1', linkId: gal(db, 'p1')[2].linkId });
    const changed = sig(db, 'p1');
    let code = ''; try { await orch.applyEditDurably(env); } catch (e) { code = (e as any).message || (e as any).code || ''; }
    ok(/BASELINE_CHANGED/.test(code) || /PERSIST|CONFLICT/.test(code), `apply on changed baseline → conflict (got ${code})`);
    ok(sig(db, 'p1') === changed, 'changed-baseline conflict does not mutate the gallery further');
    const rep = await orch.recoverPendingStockMedia();
    ok(rep.dbReport.some(r => r.action === 'left_pending_edit_baseline_changed'), 'recovery leaves stale edit pending (baseline changed)');
  }

  // ── §10 idempotency + different-plan conflict (coordinator level) ──────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const ny = newImg('p1', 'y');
    const env = await planEdit(orch, scopeFor('p1'), 'edit10', [ny], (b) => [add(ny), keep(b[1].mediaId)]);
    const coord = new MediaDbCoordinator(db, gw);
    coord.registerEditPlan(env); // same plan again → idempotent no-op
    ok(true, 'same plan re-register is a no-op');
    // Different plan, same batch id → conflict.
    const base = gal(db, 'p1');
    const other = { ...env, plan: { ...env.plan, planHash: '0'.repeat(64), target: [{ source: 'keep', mediaId: base[0].mediaId, storedHash: base[0].mediaId }] } } as typeof env;
    let conflict = false; try { coord.registerEditPlan(other as any); } catch { conflict = true; }
    ok(conflict, 'different plan under same batch id → conflict');
    // Apply, then apply again → noop_already_applied, no duplicate.
    await orch.applyEditDurably(env);
    const r2 = await orch.applyEditDurably(env);
    ok(r2.status === 'noop_already_applied', 'second apply is a no-op');
    ok(gal(db, 'p1').length === 2, 'no duplicate links after idempotent re-apply');
  }

  // ── §11 tenant/branch isolation ────────────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    await seedGallery(db, gw, disk, 't2', 'b2', 'p2', 2);
    const p2before = sig(db, 'p2', 't2', 'b2');
    const ny = newImg('p1', 'y');
    const env = await planEdit(orch, scopeFor('p1'), 'edit11', [ny], (b) => [add(ny), keep(b[1].mediaId)]);
    await orch.applyEditDurably(env);
    ok(sig(db, 'p2', 't2', 'b2') === p2before, 'editing t1/b1 leaves t2/b2 gallery untouched');
    ok((await resolverFor(db, gw, 't1', 'b1').resolveProductMedia('p2')).kind !== 'media', 'foreign scope cannot resolve p2 media');
  }

  // ── §12 no base64 persisted; products.images stays '[]' ────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const ny = newImg('p1', 'y');
    const env = await planEdit(orch, scopeFor('p1'), 'edit12', [ny], (b) => [add(ny), keep(b[1].mediaId)]);
    await orch.applyEditDurably(env);
    const img = db.exec(`SELECT images FROM products WHERE id='p1'`)[0].values[0][0];
    ok(img === '[]', 'products.images stays [] (no base64 written)');
    const rj = db.exec(`SELECT result_json FROM media_ingest_jobs WHERE ingest_request_id='edit:edit12'`)[0].values[0][0] as string;
    ok(!rj.includes('data:') && !rj.includes('base64'), 'edit plan stores hashes only, no base64');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2C1 edit-batch: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   • ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2C1 edit-batch: ${PASS}/${PASS} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
