// ════════════════════════════════════════════════════════════════════════════
// MEDIA-EDIT-PRESERVE — product-text-only durable edit MUST NOT touch the gallery
// Run: node test/media-edit-preserve/text-only-edit.test.ts
//
// The confirmed production bug: a desktop ProductDetail edit that changed only
// text (year/condition/price/…) soft-deleted a mobile product's photo, because
// the old save path always reconciled the gallery from the UI's (empty) srcs
// list. This proves the fix: StockMediaOrchestrator.applyProductTextEditDurably
// / MediaDbCoordinator.applyProductTextEditDurably apply the product columns +
// sync + audit in ONE tx and NEVER read/retire/reshuffle a `media_links` row —
// so the active gallery (link + primary + blob) is provably preserved.
//
// REAL sql.js + REAL orchestrator/coordinator/resolver. Fake gateway. No
// productive DB, no Tauri, no base64/product-id logged.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { createHash } from 'node:crypto';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import {
  StockMediaOrchestrator, type OrchestratorLease, type OrchestratorRawDb,
  type IngestAndFinalizeInput,
} from '../../src/core/media/orchestrator.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';
import type { ProductEditIntent } from '../../src/core/media/coordinator.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } }

function dataBytes(s: string): Uint8Array { const b = new Uint8Array(24); for (let i = 0; i < 24; i++) b[i] = (s.charCodeAt(i % s.length) + i) & 0xff; return b; }
function sha256Hex(b: Uint8Array): string { return createHash('sha256').update(Buffer.from(b)).digest('hex'); }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainB: Uint8Array; thumbB: Uint8Array }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  private reqBytes = new Map<string, Uint8Array>();
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
const ROLE = 'stock_image';

function seed(db: any): void {
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  // Product columns the text edit writes + the durable-edit side tables.
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`ALTER TABLE products ADD COLUMN name TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN condition TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN planned_sale_price REAL`);
  db.run(`ALTER TABLE products ADD COLUMN image_hash TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN image_description TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN image_embedding TEXT`);
  db.run(`ALTER TABLE products ADD COLUMN updated_at TEXT`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, branch_id TEXT, action TEXT, data TEXT, synced INTEGER, created_at TEXT)`);
  db.run(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, branch_id TEXT, module TEXT, entity_type TEXT, entity_id TEXT, action_type TEXT, field_name TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, changed_at TEXT)`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1')`);
  db.run(`INSERT INTO products (id, branch_id, images, name, condition, planned_sale_price, image_hash) VALUES ('p1','b1','[]','OldName','Pre-Owned',100,'HASH0')`);
}
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
/** Active gallery signature: slot:mediaId:primary:deleted, sorted by slot. Includes
 *  soft-deleted rows so a retire is visible. */
function galAll(db: any, pid: string): string {
  const r = db.exec(`SELECT sort_order, media_id, is_primary, deleted_at FROM media_links WHERE tenant_id='t1' AND branch_id='b1' AND entity_id=? ORDER BY link_id`, [pid]);
  if (!r.length) return '';
  return r[0].values.map((v: any[]) => `${v[0]}:${v[1]}:${Number(v[2]) === 1 ? 1 : 0}:${v[3] == null ? 'live' : 'DEL'}`).join('|');
}
function count(db: any, sql: string, params: any[] = []): number { const r = db.exec(sql, params); return r.length ? Number(r[0].values[0][0]) : 0; }
function scalar(db: any, sql: string, params: any[] = []): any { const r = db.exec(sql, params); return r.length ? r[0].values[0][0] : undefined; }

function editName(target: string, baseline: string): ProductEditIntent {
  return { set: [['name', target]], baseline: [baseline], invalidateImageDerived: false, withSync: true,
    audit: { module: 'Product', changedBy: 'u1', newValueJson: JSON.stringify({ name: target }) } };
}

// ══════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 the core fix: a text-only edit preserves the whole gallery ─────────
  {
    const db = new SQL.Database(); applyMediaSchema(db); seed(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await seedGallery(db, gw, disk, 'p1', 1);
    const before = galAll(db, 'p1');
    ok(/:1:live$/.test(before) && before.split('|').length === 1, 'setup: 1 live gallery link, is_primary=1');
    const resBefore = await resolverFor(db, gw).resolveProductMedia('p1');
    ok(resBefore.kind === 'media' && resBefore.items.length === 1, 'setup: resolver shows the photo (media)');

    const orch = orchFor(db, gw, disk);
    const r = await orch.applyProductTextEditDurably({ tenantId: 't1', branchId: 'b1', entityId: 'p1', batchId: 'txt-1', productEdit: editName('NewName', 'OldName') });
    ok(r.status === 'edited', 'text edit applied');
    ok(scalar(db, `SELECT name FROM products WHERE id='p1'`) === 'NewName', 'product name changed');
    ok(galAll(db, 'p1') === before, 'GALLERY UNCHANGED — no soft-delete, same primary/slot/media (THE FIX)');
    ok(count(db, `SELECT COUNT(*) FROM media_links WHERE entity_id='p1' AND deleted_at IS NOT NULL`) === 0, 'no media_link was retired by a text edit');
    ok(scalar(db, `SELECT image_hash FROM products WHERE id='p1'`) === 'HASH0', 'derived image fields NOT invalidated by a text-only edit');
    const after = await resolverFor(db, gw).resolveProductMedia('p1');
    ok(after.kind === 'media' && after.items.length === 1, 'resolver STILL shows the photo after the text edit');
    ok(count(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'exactly one sync changelog row');
    ok(count(db, `SELECT COUNT(*) FROM audit_log WHERE id='audit-edit-txt-1'`) === 1, 'exactly one audit row (deterministic id)');
  }

  // ── §2 idempotent replay (same batchId) — no double audit, gallery intact ──
  {
    const db = new SQL.Database(); applyMediaSchema(db); seed(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await seedGallery(db, gw, disk, 'p1', 1);
    const orch = orchFor(db, gw, disk);
    await orch.applyProductTextEditDurably({ tenantId: 't1', branchId: 'b1', entityId: 'p1', batchId: 'txt-2', productEdit: editName('NewName', 'OldName') });
    const galAfter1 = galAll(db, 'p1');
    const r2 = await orch.applyProductTextEditDurably({ tenantId: 't1', branchId: 'b1', entityId: 'p1', batchId: 'txt-2', productEdit: editName('NewName', 'OldName') });
    ok(r2.status === 'noop_already_applied', 'same batchId replay → noop_already_applied');
    ok(count(db, `SELECT COUNT(*) FROM audit_log WHERE id='audit-edit-txt-2'`) === 1, 'replay did NOT double the audit row');
    ok(count(db, `SELECT COUNT(*) FROM sync_changelog WHERE record_id='p1'`) === 1, 'replay did NOT emit a second sync row');
    ok(galAll(db, 'p1') === galAfter1, 'replay left the gallery untouched');
  }

  // ── §3 baseline conflict — product moved under us → refuse, touch nothing ──
  {
    const db = new SQL.Database(); applyMediaSchema(db); seed(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await seedGallery(db, gw, disk, 'p1', 1);
    const before = galAll(db, 'p1');
    db.run(`UPDATE products SET name='ChangedElsewhere' WHERE id='p1'`); // concurrent write
    const orch = orchFor(db, gw, disk);
    let threw = '';
    try {
      // plan baseline 'OldName', target 'NewName' — current is neither → conflict
      await orch.applyProductTextEditDurably({ tenantId: 't1', branchId: 'b1', entityId: 'p1', batchId: 'txt-3', productEdit: editName('NewName', 'OldName') });
    } catch (e) { threw = (e as { message?: string })?.message ?? String(e); }
    ok(/BASELINE_CHANGED/.test(threw), 'baseline conflict throws MEDIA_EDIT_BASELINE_CHANGED');
    ok(scalar(db, `SELECT name FROM products WHERE id='p1'`) === 'ChangedElsewhere', 'conflict left the product untouched');
    ok(galAll(db, 'p1') === before, 'conflict left the gallery untouched');
    ok(count(db, `SELECT COUNT(*) FROM audit_log WHERE id='audit-edit-txt-3'`) === 0, 'no audit row on a refused edit');
  }

  // ── §4 converged replay (already at target) is a clean no-op, not a conflict ─
  {
    const db = new SQL.Database(); applyMediaSchema(db); seed(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await seedGallery(db, gw, disk, 'p1', 1);
    db.run(`UPDATE products SET name='NewName' WHERE id='p1'`); // already at target
    const orch = orchFor(db, gw, disk);
    const r = await orch.applyProductTextEditDurably({ tenantId: 't1', branchId: 'b1', entityId: 'p1', batchId: 'txt-4', productEdit: editName('NewName', 'OldName') });
    ok(r.status === 'edited', 'edit whose current==target still applies cleanly (atTarget path)');
    ok(galAll(db, 'p1').includes(':1:live'), 'gallery still live after a converged text edit');
  }

  // ── §5 durability: the change + the gallery both survive a reopen ─────────
  {
    const db = new SQL.Database(); applyMediaSchema(db); seed(db);
    const gw = new FakeGateway(); const disk = new Disk();
    await seedGallery(db, gw, disk, 'p1', 1);
    const orch = orchFor(db, gw, disk);
    await orch.applyProductTextEditDurably({ tenantId: 't1', branchId: 'b1', entityId: 'p1', batchId: 'txt-5', productEdit: editName('Durable', 'OldName') });
    ok(disk.image != null, 'a durable checkpoint was written');
    const re = new SQL.Database(disk.image!);
    ok(scalar(re, `SELECT name FROM products WHERE id='p1'`) === 'Durable', 'name persisted to disk');
    const reRes = await resolverFor(re, gw).resolveProductMedia('p1');
    ok(reRes.kind === 'media' && reRes.items.length === 1, 'gallery persisted to disk — photo survives reopen');
  }

  console.log(`\nMEDIA-EDIT-PRESERVE text-only: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error('TEST ERROR:', e?.stack || e); process.exit(1); });
