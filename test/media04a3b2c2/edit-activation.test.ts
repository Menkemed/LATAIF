// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C2 — atomic product text+media edit activation
// Run: node test/media04a3b2c2/edit-activation.test.ts
//
// REAL sql.js + REAL orchestrator/coordinator + REAL edit planner + pure draft
// decisions. A fake gateway records prepare/commit. sync_changelog + audit_log
// are real tables so we can prove exactly-one changelog/audit. No productive DB,
// no Tauri, no base64/product-id logged.
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
import { buildEditPlanEnvelope, type EditDesiredSlot } from '../../src/core/media/product-media-edit.ts';
import type { ProductEditIntent } from '../../src/core/media/coordinator.ts';
import {
  canEditImages, draftFromSrcs, buildImageEditInputs, diffProductText, decideEditUi, isObjectUrl,
  type ImageDraftItem,
} from '../../src/core/media/product-edit-draft.ts';
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
  async abortStockImage(i: AbortInput): Promise<AbortResult> { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
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
  db.run(`ALTER TABLE products ADD COLUMN name TEXT`); db.run(`ALTER TABLE products ADD COLUMN notes TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN image_hash TEXT`); db.run(`ALTER TABLE products ADD COLUMN image_description TEXT`); db.run(`ALTER TABLE products ADD COLUMN image_embedding TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN updated_at TEXT`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, branch_id TEXT, action TEXT, data TEXT, synced INTEGER, created_at TEXT)`);
  db.run(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, branch_id TEXT, module TEXT, entity_type TEXT, entity_id TEXT, action_type TEXT, field_name TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, changed_at TEXT)`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t2')`);
  db.run(`INSERT INTO products (id, branch_id, images, name, notes, image_embedding) VALUES ('p1','b1','[]','Old Name','n1','[0.1]'),('p2','b2','[]','P2',NULL,NULL)`);
}
function reopen(SQL: any, disk: Disk) { if (!disk.image) throw new Error('nothing persisted'); return new SQL.Database(disk.image); }
const ROLE = 'stock_image';
function scopeFor(pid: string, t = 't1', b = 'b1'): EditScope { return { tenantId: t, scopeKind: 'branch', branchId: b, entityType: 'product', entityId: pid, role: ROLE }; }
function orchFor(db: any, gw: FakeGateway, disk: Disk) { return new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) }); }
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
function gal(db: any, pid: string, t = 't1', b = 'b1') { const r = db.exec(`SELECT media_id, sort_order, is_primary FROM media_links WHERE tenant_id=? AND branch_id=? AND entity_id=? AND deleted_at IS NULL ORDER BY sort_order ASC`, [t, b, pid]); return r.length ? r[0].values.map((v: any[]) => ({ mediaId: String(v[0]), slot: Number(v[1]), primary: Number(v[2]) === 1 })) : []; }
function col(db: any, pid: string, c: string): any { const r = db.exec(`SELECT ${c} FROM products WHERE id=?`, [pid]); return r.length ? r[0].values[0][0] : undefined; }
function cnt(db: any, sql: string, p: any[] = []): number { const r = db.exec(sql, p); return r.length ? Number(r[0].values[0][0]) : 0; }
interface NewImg { rid: string; bytes: Uint8Array; }
function newImg(pid: string, tag: string): NewImg { return { rid: `edit-new:${pid}:${tag}`, bytes: dataBytes(`${pid}-new-${tag}`) }; }
const keep = (mediaId: string): EditDesiredSlot => ({ source: 'keep', mediaId });
const add = (n: NewImg): EditDesiredSlot => ({ source: 'new', requestId: n.rid, requestHash: sha256Hex(n.bytes) });
function prodEdit(set: Array<[string, string | number | null]>, baseline: Array<string | number | null>, invalidate: boolean): ProductEditIntent {
  return { set, baseline, invalidateImageDerived: invalidate, withSync: true, audit: { module: 'Product', changedBy: 'u1', newValueJson: JSON.stringify(Object.fromEntries(set)) } };
}
async function planEdit(orch: StockMediaOrchestrator, scope: EditScope, batchId: string, news: NewImg[], buildDesired: (b: any[]) => EditDesiredSlot[], productEdit?: ProductEditIntent) {
  const newItems: EditNewImageInput[] = news.map(n => ({ tenantId: scope.tenantId, ingestRequestId: n.rid, requestHash: sha256Hex(n.bytes), imageBytes: n.bytes }));
  return orch.prepareAndRegisterEdit(scope, newItems, async (baseline, prepared) =>
    buildEditPlanEnvelope({ batchId, tenantId: scope.tenantId, branchId: scope.branchId, scopeKind: scope.scopeKind, entityType: scope.entityType, entityId: scope.entityId, role: scope.role, baseline, desired: buildDesired(baseline), prepared, productEdit }, digestHex));
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 text-only edit → durable UPDATE + exactly one changelog + audit ──
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const env = await planEdit(orch, scopeFor('p1'), 'te1', [], (b) => b.map((x: any) => keep(x.mediaId)), prodEdit([['name', 'New Name']], ['Old Name'], false));
    await orch.applyEditDurably(env);
    ok(col(db, 'p1', 'name') === 'New Name', 'text-only: product field updated');
    ok(cnt(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'exactly ONE sync changelog');
    ok(cnt(db, `SELECT COUNT(*) FROM audit_log WHERE entity_id='p1'`) === 1, 'exactly ONE audit row');
    ok(gal(db, 'p1').length === 2, 'gallery unchanged by a text-only edit');
  }

  // ── §2 append only → gallery+1, derived invalidated, one changelog/audit ─
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 1);
    const A = newImg('p1', 'A');
    const env = await planEdit(orch, scopeFor('p1'), 'ap1', [A], (b) => [keep(b[0].mediaId), add(A)], prodEdit([], [], true));
    await orch.applyEditDurably(env);
    ok(gal(db, 'p1').length === 2, 'append: gallery has 2');
    ok(col(db, 'p1', 'image_embedding') === null, 'append: derived image_embedding invalidated to NULL');
    ok(cnt(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1 && cnt(db, `SELECT COUNT(*) FROM audit_log WHERE entity_id='p1'`) === 1, 'append: one changelog + one audit');
  }

  // ── §3 delete only ─────────────────────────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 3);
    const env = await planEdit(orch, scopeFor('p1'), 'de1', [], (b) => [keep(b[0].mediaId), keep(b[1].mediaId)], prodEdit([], [], true));
    await orch.applyEditDurably(env);
    ok(gal(db, 'p1').length === 2, 'delete: gallery reduced to 2');
    ok(cnt(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'delete: one changelog');
  }

  // ── §4 text + append + delete in ONE atomic edit ───────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 2);
    const A = newImg('p1', 'A');
    const env = await planEdit(orch, scopeFor('p1'), 'mix1', [A], (b) => [keep(b[1].mediaId), add(A)], prodEdit([['name', 'Mixed'], ['notes', 'n2']], ['Old Name', 'n1'], true));
    await orch.applyEditDurably(env);
    ok(col(db, 'p1', 'name') === 'Mixed' && col(db, 'p1', 'notes') === 'n2', 'mixed: text applied');
    const g = gal(db, 'p1');
    ok(g.length === 2 && g[1].mediaId === `media-${A.rid}`, 'mixed: old primary removed, kept@0, new@1');
    ok(cnt(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1 && cnt(db, `SELECT COUNT(*) FROM audit_log WHERE entity_id='p1'`) === 1, 'mixed: exactly one changelog + one audit');
  }

  // ── §5 crash before tx → old text + old gallery, no changelog ──────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 1);
    const A = newImg('p1', 'A');
    const env = await planEdit(orch, scopeFor('p1'), 'cr1', [A], (b) => [keep(b[0].mediaId), add(A)], prodEdit([['name', 'Never']], ['Old Name'], true));
    gw.commitShouldThrowFor = 'ALL';
    let threw = false; try { await orch.applyEditDurably(env); } catch { threw = true; }
    ok(threw, 'crash before tx surfaces');
    ok(col(db, 'p1', 'name') === 'Old Name', 'crash: product text unchanged');
    ok(gal(db, 'p1').length === 1 && cnt(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 0, 'crash: old gallery, no changelog');
  }

  // ── §6/§7 save-fail after tx → recovery applies once; retry no dup ─────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 1);
    const A = newImg('p1', 'A');
    const env = await planEdit(orch, scopeFor('p1'), 'sv1', [A], (b) => [keep(b[0].mediaId), add(A)], prodEdit([['name', 'Saved']], ['Old Name'], true));
    disk.failOnWrite = disk.writes + 1; // fail cp2 (the applyEditDurably save)
    let threw = false; try { await orch.applyEditDurably(env); } catch { threw = true; }
    ok(threw, 'save-fail after tx surfaces');
    const db2 = reopen(SQL, disk); const disk2 = new Disk(); disk2.image = db2.export();
    ok(col(db2, 'p1', 'name') === 'Old Name', 'save-fail: ON-DISK old text');
    const orch2 = orchFor(db2, gw, disk2);
    await orch2.recoverPendingStockMedia();
    ok(col(db2, 'p1', 'name') === 'Saved' && gal(db2, 'p1').length === 2, 'recovery applied the exact target (text+media)');
    ok(cnt(db2, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'recovery wrote exactly one changelog (not the lost one twice)');
    ok(cnt(db2, `SELECT COUNT(*) FROM audit_log WHERE entity_id='p1'`) === 1, 'recovery wrote exactly one audit');
    await orch2.recoverPendingStockMedia(); // retry
    ok(cnt(db2, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1 && gal(db2, 'p1').length === 2, 'retry: no duplicate changelog/link');
  }

  // ── §8 product baseline changed under us → conflict ────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 1);
    const env = await planEdit(orch, scopeFor('p1'), 'cf1', [], (b) => [keep(b[0].mediaId)], prodEdit([['name', 'Target']], ['Old Name'], false));
    db.run(`UPDATE products SET name='Someone Else' WHERE id='p1'`); // baseline moved
    let code = ''; try { await orch.applyEditDurably(env); } catch (e) { code = (e as any).message || (e as any).code || ''; }
    ok(/PRODUCT_BASELINE_CHANGED/.test(code), `product baseline changed → conflict (got ${code})`);
    ok(col(db, 'p1', 'name') === 'Someone Else' && cnt(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 0, 'conflict: no mutation, no changelog');
  }

  // ── §9 tenant/branch isolation ─────────────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 1);
    await seedGallery(db, gw, disk, 't2', 'b2', 'p2', 1);
    const env = await planEdit(orch, scopeFor('p1'), 'is1', [], (b) => [keep(b[0].mediaId)], prodEdit([['name', 'X']], ['Old Name'], false));
    await orch.applyEditDurably(env);
    ok(gal(db, 'p2', 't2', 'b2').length === 1 && col(db, 'p2', 'name') === 'P2', 'editing t1/b1 leaves t2/b2 untouched');
    ok(cnt(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p2'`) === 0, 'no cross-scope changelog');
  }

  // ── §10 no base64 ever in products.images ──────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 't1', 'b1', 'p1', 1);
    const A = newImg('p1', 'A');
    const env = await planEdit(orch, scopeFor('p1'), 'nb1', [A], (b) => [keep(b[0].mediaId), add(A)], prodEdit([['name', 'Y']], ['Old Name'], true));
    await orch.applyEditDurably(env);
    ok(col(db, 'p1', 'images') === '[]', 'products.images stays [] after a media edit');
  }

  // ── §11 draft decisions (pure) ─────────────────────────────────────────
  {
    ok(canEditImages('media') && canEditImages('legacy') && canEditImages('none'), 'canEditImages: resolved states allowed');
    ok(!canEditImages('pending') && !canEditImages('conflict') && !canEditImages('integrity_error'), 'canEditImages: unresolved/broken states fail closed');
    ok(isObjectUrl('blob:abc') && !isObjectUrl('data:image/png;base64,x'), 'isObjectUrl');
    // draftFromSrcs: object-URL → existing(mediaId), data: → new, unknown blob → error.
    const resolved = [{ url: 'blob:u0', mediaId: 'm0' }, { url: 'blob:u1', mediaId: 'm1' }];
    const d1 = draftFromSrcs(['blob:u0', 'data:image/png;base64,AAA', 'blob:u1'], resolved);
    ok(d1.ok && d1.value.length === 3 && d1.value[0].kind === 'existing' && (d1.value[0] as any).mediaId === 'm0' && d1.value[1].kind === 'new', 'draftFromSrcs maps object-URL→existing, data→new, order preserved');
    const d2 = draftFromSrcs(['blob:unknown'], resolved);
    ok(!d2.ok && d2.error === 'MEDIA_EDIT_UNKNOWN_OBJECT_URL', 'draftFromSrcs: unknown object URL fails closed');
  }

  // ── §12 buildImageEditInputs: object-URL never an upload; diffs ────────
  {
    // A 'new' item whose dataUrl is an object URL → hard error (never uploaded).
    const bad: ImageDraftItem[] = [{ kind: 'new', clientId: 'c0', dataUrl: 'blob:x' }];
    const rb = buildImageEditInputs(bad, []);
    ok(!rb.ok && rb.error === 'MEDIA_EDIT_OBJECT_URL_AS_UPLOAD', 'object-URL as upload → error');
    const legacy: ImageDraftItem[] = [{ kind: 'legacy', dataUrl: 'data:image/png;base64,AAA' }];
    ok(!buildImageEditInputs(legacy, []).ok, 'legacy draft → refuse (cutover first)');
    const good: ImageDraftItem[] = [{ kind: 'existing', mediaId: 'm0', displaySrc: 'blob:u0' }, { kind: 'new', clientId: 'c1', dataUrl: 'data:image/png;base64,BBB' }];
    const rg = buildImageEditInputs(good, ['m0']);
    ok(rg.ok && rg.value.desired.length === 2 && rg.value.newImages.length === 1 && rg.value.galleryChanged, 'keep+new → desired + one new + changed');
    const noop = buildImageEditInputs([{ kind: 'existing', mediaId: 'm0', displaySrc: 'blob:u0' }], ['m0']);
    ok(noop.ok && !noop.value.galleryChanged && noop.value.removedMediaIds.length === 0, 'unchanged gallery → galleryChanged=false');
    const del = buildImageEditInputs([{ kind: 'existing', mediaId: 'm0', displaySrc: 'blob:u0' }], ['m0', 'm1']);
    ok(del.ok && del.value.galleryChanged && del.value.removedMediaIds.join() === 'm1', 'removed media reported');
    // diffProductText: only changed columns.
    const diff = diffProductText([{ col: 'name', baseline: 'A', target: 'B' }, { col: 'notes', baseline: 'x', target: 'x' }]);
    ok(diff.set.length === 1 && diff.set[0][0] === 'name' && diff.baseline[0] === 'A', 'diffProductText: only changed columns');
    ok(decideEditUi({ status: 'edited' }).closeEditor && !decideEditUi({ status: 'edit_incomplete', errorCode: 'x' }).closeEditor, 'decideEditUi: only success closes');
    ok(decideEditUi({ status: 'edit_conflict', errorCode: 'x' }).retainDraft, 'decideEditUi: conflict retains draft');
  }

  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2C2 edit-activation: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   • ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2C2 edit-activation: ${PASS}/${PASS} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
