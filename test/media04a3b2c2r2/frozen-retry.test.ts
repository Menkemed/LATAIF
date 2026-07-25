// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C2-R2 — frozen UI-retry contract for the product edit
// Run: node test/media04a3b2c2r2/frozen-retry.test.ts
//
// After an incomplete edit the UI retries with the SAME frozen batch: same
// batchId + same plan → idempotent (no duplicate link/changelog/audit). A draft
// change under the same batch id is a typed conflict — never silently reused. A
// deliberately NEW batch id applies the changed draft. REAL orchestrator +
// coordinator + planner; no productive DB, no base64 logged.
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
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  x ${m}`); } }
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
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`); db.run(`ALTER TABLE products ADD COLUMN name TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN image_hash TEXT`); db.run(`ALTER TABLE products ADD COLUMN image_description TEXT`); db.run(`ALTER TABLE products ADD COLUMN image_embedding TEXT`); db.run(`ALTER TABLE products ADD COLUMN updated_at TEXT`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, branch_id TEXT, action TEXT, data TEXT, synced INTEGER, created_at TEXT)`);
  db.run(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, branch_id TEXT, module TEXT, entity_type TEXT, entity_id TEXT, action_type TEXT, field_name TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, changed_at TEXT)`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1')`); db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1')`);
  db.run(`INSERT INTO products (id, branch_id, images, name) VALUES ('p1','b1','[]','Old')`);
}
function reopen(SQL: any, disk: Disk) { if (!disk.image) throw new Error('nothing persisted'); return new SQL.Database(disk.image); }
const ROLE = 'stock_image';
const scope: EditScope = { tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: 'product', entityId: 'p1', role: ROLE };
function orchFor(db: any, gw: FakeGateway, disk: Disk) { return new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db, disk) }); }
function createItem(i: number, n: number): IngestAndFinalizeInput {
  const bytes = dataBytes(`t1-p1-${i}`);
  return { tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p1', scopeKind: 'branch', role: ROLE, ingestRequestId: `create:t1:b1:p1:${ROLE}:${i}`, requestHash: sha256Hex(bytes), isPrimary: i === 0, sortOrder: i, imageBytes: bytes, batch: { batchId: `create:t1:b1:p1:${ROLE}`, expectedCount: n } };
}
async function seedGallery(db: any, gw: FakeGateway, disk: Disk, n: number): Promise<void> {
  const orch = orchFor(db, gw, disk);
  const items = Array.from({ length: n }, (_, i) => createItem(i, n));
  await orch.prepareAndRegisterBatch(items); await orch.finalizeBatch(items);
}
function gal(db: any) { const r = db.exec(`SELECT media_id, sort_order FROM media_links WHERE entity_id='p1' AND deleted_at IS NULL ORDER BY sort_order ASC`); return r.length ? r[0].values.map((v: any[]) => String(v[0])) : []; }
function cnt(db: any, sql: string): number { const r = db.exec(sql); return r.length ? Number(r[0].values[0][0]) : 0; }
interface NewImg { rid: string; bytes: Uint8Array; }
function newImg(tag: string): NewImg { return { rid: `edit-new:p1:${tag}`, bytes: dataBytes(`p1-new-${tag}`) }; }
const keep = (mediaId: string): EditDesiredSlot => ({ source: 'keep', mediaId });
const add = (n: NewImg): EditDesiredSlot => ({ source: 'new', requestId: n.rid, requestHash: sha256Hex(n.bytes) });
function prodEdit(name: string, base: string): ProductEditIntent {
  return { set: [['name', name]], baseline: [base], invalidateImageDerived: true, withSync: true, audit: { module: 'Product', changedBy: 'u1', newValueJson: `{"name":"${name}"}` } };
}
async function planEdit(orch: StockMediaOrchestrator, batchId: string, news: NewImg[], desired: (b: any[]) => EditDesiredSlot[], pe: ProductEditIntent) {
  const newItems: EditNewImageInput[] = news.map(n => ({ tenantId: 't1', ingestRequestId: n.rid, requestHash: sha256Hex(n.bytes), imageBytes: n.bytes }));
  return orch.prepareAndRegisterEdit(scope, newItems, async (baseline, prepared) =>
    buildEditPlanEnvelope({ batchId, tenantId: 't1', branchId: 'b1', scopeKind: 'branch', entityType: 'product', entityId: 'p1', role: ROLE, baseline, desired: desired(baseline), prepared, productEdit: pe }, digestHex));
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 incomplete edit → UI retry with the SAME frozen batch → no dup ──
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 1);
    const A = newImg('A');
    const env = await planEdit(orch, 'edit-B', [A], (b) => [keep(b[0].mediaId), add(A)], prodEdit('New', 'Old'));
    disk.failOnWrite = disk.writes + 1; // cp2 save fails → incomplete edit
    let threw = false; try { await orch.applyEditDurably(env); } catch { threw = true; }
    ok(threw, 'first save incomplete');
    // UI retry reuses the SAME env (same batchId + plan). Recover from disk then
    // re-apply the identical frozen plan.
    const db2 = reopen(SQL, disk); const disk2 = new Disk(); disk2.image = db2.export();
    const orch2 = orchFor(db2, gw, disk2);
    await orch2.recoverPendingStockMedia();
    // A second explicit apply of the same frozen env (the UI "retry") is a no-op.
    const r2 = await orch2.applyEditDurably(env);
    ok(r2.status === 'noop_already_applied', 'retry with the same frozen batch → noop, not a re-run');
    ok(gal(db2).length === 2, 'no duplicate links after retry');
    ok(cnt(db2, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'exactly one changelog after retry');
    ok(cnt(db2, `SELECT COUNT(*) FROM audit_log WHERE entity_id='p1'`) === 1, 'exactly one audit after retry');
  }

  // ── §2 changed draft under the SAME batch id → typed conflict ──────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 2);
    const A = newImg('A'); const B = newImg('B');
    await planEdit(orch, 'edit-X', [A], (b) => [keep(b[0].mediaId), add(A)], prodEdit('N1', 'Old'));
    // Same batch id, DIFFERENT target (extra image) → different plan hash.
    let code = ''; try { await planEdit(orch, 'edit-X', [A, B], (b) => [keep(b[0].mediaId), add(A), add(B)], prodEdit('N1', 'Old')); } catch (e) { code = (e as any).message || (e as any).code || ''; }
    ok(/PLAN_CONFLICT|REQUEST_CONFLICT/.test(code), `changed draft, same batch id → typed conflict (got ${code})`);
  }

  // ── §3 a deliberately NEW batch id applies the changed draft ───────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway(); const disk = new Disk(); const orch = orchFor(db, gw, disk);
    await seedGallery(db, gw, disk, 2);
    const A = newImg('A');
    const env = await planEdit(orch, 'edit-NEW', [A], (b) => [keep(b[0].mediaId), keep(b[1].mediaId), add(A)], prodEdit('N2', 'Old'));
    const r = await orch.applyEditDurably(env);
    ok(r.status === 'edit_applied' && gal(db).length === 3, 'a new explicit batch applies the changed draft');
  }

  console.log('');
  if (FAIL > 0) { console.log(`MEDIA-04A-3B2C2-R2 frozen-retry: ${PASS} passed, ${FAIL} FAILED`); for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
  console.log(`MEDIA-04A-3B2C2-R2 frozen-retry: ${PASS}/${PASS} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
