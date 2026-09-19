// ════════════════════════════════════════════════════════════════════════════
// MEDIA-S1 — generic media core foundation (TS side)
// Run: node test/media-s1/foundation.test.ts
//
// REAL sql.js + REAL coordinator/orchestrator + REAL edit planner; a fake gateway stands in for Rust.
//   §1 the accepted edit job from the field (25.08.2026): gallery at target, product neither at
//      baseline nor target → recovery leaves it pending and does NOT abort the pass
//   §2 recovery distinguishes the owner: only product jobs reach the product embedding
//   §3 binary transport contract (raw bytes + headers, raw response, hard limits)
//   §4 owner-revision hook in the same transaction as a link change
//   §5 the TS mirrors match the Rust storage contract
// ════════════════════════════════════════════════════════════════════════════
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { createHash } from 'node:crypto';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import {
  StockMediaOrchestrator, type OrchestratorLease, type OrchestratorRawDb,
  type IngestAndFinalizeInput, type EditScope,
} from '../../src/core/media/orchestrator.ts';
import { MediaDbCoordinator } from '../../src/core/media/coordinator.ts';
import { buildEditPlanEnvelope, type EditDesiredSlot } from '../../src/core/media/product-media-edit.ts';
import {
  OriginalMediaTransport, OriginalTransportError, ORIGINAL_MAX_BYTES, ORIGINAL_EXTENSIONS,
  type AbortInput, type AbortResult, type CommitInput, type CommitResult, type MediaBytes,
  type MediaCommandGateway, type PrepareInput, type PrepareResult, type ReadVerifiedInput, type RecoveryOutcome,
} from '../../src/core/media/gateway.ts';
import { bumpMediaOwnerRevision, OwnerRevisionError } from '../../src/core/media/owner-revision.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { failures.push(m); console.log(`  ✗ ${m}`); } }

function dataBytes(s: string): Uint8Array { const b = new Uint8Array(24); for (let i = 0; i < 24; i++) b[i] = (s.charCodeAt(i % s.length) + i) & 0xff; return b; }
function sha256Hex(b: Uint8Array): string { return createHash('sha256').update(Buffer.from(b)).digest('hex'); }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
const digestHex = async (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainB: Uint8Array; thumbB: Uint8Array }>();
  private files = new Map<string, Uint8Array>();
  private reqBytes = new Map<string, Uint8Array>();
  private rend(scope: string, input: Uint8Array) {
    const h = sha256Hex(input); let r = this.byHash.get(h);
    if (!r) { r = { main: sha256Hex(concat(input, new Uint8Array([1]))), thumb: sha256Hex(concat(input, new Uint8Array([2]))), mainB: concat(input, new Uint8Array([0xaa])), thumbB: concat(input, new Uint8Array([0xbb])) }; this.byHash.set(h, r); }
    this.files.set(`${scope}::${r.main}`, r.mainB); this.files.set(`${scope}::${r.thumb}`, r.thumbB);
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
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> { const f = this.files.get(`${i.tenantScope}::${i.hash}`); if (!f) throw new Error('MEDIA_FILE_MISSING'); return { bytes: f, hash: i.hash, byte_size: f.length, mime_type: 'image/jpeg', extension: 'jpg' }; }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}
function desc(hash: string, size: number) { return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 800, height: 600 }; }
function leaseFor(db: OrchestratorRawDb): OrchestratorLease { return { db, epoch: 0, async saveDurably() {}, release() {} }; }
function seed(db: any): void {
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`); db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`); db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  for (const c of ['images TEXT DEFAULT \'[]\'', 'purchase_price REAL', 'planned_sale_price REAL', 'min_sale_price REAL', 'notes TEXT']) db.run(`ALTER TABLE products ADD COLUMN ${c}`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1')`);
  db.run(`INSERT INTO products (id, branch_id) VALUES ('p1','b1'),('p3','b1')`);
  db.run(`INSERT INTO repairs (id, branch_id) VALUES ('r1','b1')`);
}
const ROLE = 'stock_image';
const scopeFor = (et: string, id: string): EditScope => ({ tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: et, entityId: id, role: ROLE });
function item(et: string, id: string, i: number, n: number): IngestAndFinalizeInput {
  const bytes = dataBytes(`${et}-${id}-${i}`);
  return { tenantId: 't1', branchId: 'b1', entityType: et, entityId: id, scopeKind: 'branch', role: ROLE,
    ingestRequestId: `create:t1:b1:${id}:${ROLE}:${i}`, requestHash: sha256Hex(bytes), isPrimary: i === 0, sortOrder: i,
    imageBytes: bytes, batch: { batchId: `create:t1:b1:${id}:${ROLE}`, expectedCount: n } };
}
function gal(db: any, id: string): string[] {
  const r = db.exec(`SELECT media_id FROM media_links WHERE entity_id=? AND deleted_at IS NULL ORDER BY sort_order`, [id]);
  return r.length ? r[0].values.map((v: unknown[]) => String(v[0])) : [];
}
const keep = (mediaId: string): EditDesiredSlot => ({ source: 'keep', mediaId });

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 the stale edit job from the field ────────────────────────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway();
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db) });
    for (const pid of ['p1', 'p3']) { const it = [item('product', pid, 0, 2), item('product', pid, 1, 2)]; await orch.prepareAndRegisterBatch(it); await orch.finalizeBatch(it); }
    db.run(`UPDATE products SET purchase_price=100, planned_sale_price=200, min_sale_price=150, notes='Test' WHERE id='p1'`);
    const [m0, m1] = gal(db, 'p1');
    // Plan A (the field job): keep only the first image AND null the prices — frozen, never applied.
    await orch.prepareAndRegisterEdit(scopeFor('product', 'p1'), [], async (baseline, prepared) => buildEditPlanEnvelope({
      batchId: 'gallery-edit:stale', tenantId: 't1', branchId: 'b1', scopeKind: 'branch', entityType: 'product', entityId: 'p1', role: ROLE,
      baseline, desired: [keep(m0)], prepared,
      productEdit: { set: [['purchase_price', null], ['planned_sale_price', null], ['min_sale_price', null], ['notes', null]], baseline: [100, 200, 150, 'Test'], invalidateImageDerived: false, withSync: false, priceEligibilityRequired: false, audit: { module: 'Product', changedBy: null, newValueJson: '{}' } } as never,
    }, digestHex));
    // Plan C (a healthy, still pending gallery edit of another product), registered AFTER A.
    const [c0] = gal(db, 'p3');
    await orch.prepareAndRegisterEdit(scopeFor('product', 'p3'), [], async (baseline, prepared) => buildEditPlanEnvelope({
      batchId: 'gallery-edit:healthy', tenantId: 't1', branchId: 'b1', scopeKind: 'branch', entityType: 'product', entityId: 'p3', role: ROLE,
      baseline, desired: [keep(c0)], prepared,
    }, digestHex));
    // …then, like the later field job, the gallery reached the SAME target and the prices became 0.
    db.run(`UPDATE media_links SET deleted_at='2026-08-25T19:28:49Z', is_primary=0 WHERE media_id=?`, [m1]);
    db.run(`UPDATE products SET purchase_price=0, planned_sale_price=0, min_sale_price=0, notes=NULL WHERE id='p1'`);

    const coord = new MediaDbCoordinator(db as never, gw);
    let threw = ''; let report: Awaited<ReturnType<MediaDbCoordinator['recover']>> = [];
    try { report = await coord.recover(); } catch (e) { threw = String((e as Error).message); }
    ok(threw === '', `§1 recovery does NOT abort on the stale product half (${threw || 'kein Abbruch'})`);
    const a = report.find((r) => r.ingestRequestId === 'edit:gallery-edit:stale');
    const c = report.find((r) => r.ingestRequestId === 'edit:gallery-edit:healthy');
    ok(a?.action === 'left_pending_edit_product_changed', `§1 the stale job is left pending (${a?.action})`);
    ok(c?.action === 'edit_applied_from_plan', `§1 …and the pending job after it is still recovered (${c?.action})`);
    const p = db.exec(`SELECT purchase_price, planned_sale_price, min_sale_price, notes FROM products WHERE id='p1'`)[0].values[0];
    ok(JSON.stringify(p) === JSON.stringify([0, 0, 0, null]), `§1 the product was NOT touched — prices not nulled (${JSON.stringify(p)})`);
    ok(JSON.stringify(gal(db, 'p1')) === JSON.stringify([m0]), '§1 …and the gallery stays as it is');
    const st = db.exec(`SELECT state FROM media_ingest_jobs WHERE ingest_request_id='edit:gallery-edit:stale'`)[0].values[0][0];
    ok(st === 'accepted', `§1 the job row itself is unchanged (${st}) — nothing rewritten by recovery`);
    const again = await coord.recover();
    ok(again.find((r) => r.ingestRequestId === 'edit:gallery-edit:stale')?.action === 'left_pending_edit_product_changed',
      '§1 a second pass decides the same (idempotent)');
    // A product edit riding on a non-product owner is refused, never applied.
    ok(/plan\.productEdit && plan\.entityType !== 'product'/.test(readFileSync(join(repo, 'src/core/media/coordinator.ts'), 'utf8')),
      '§1 a product edit on any other entity type is refused (guard in applyEditBatch)');
  }

  // ── §2 recovery distinguishes product and non-product media ────────────────────────────────
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway();
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db) });
    // Both registered (prepared in Rust) but never finalized in the DB — a crash in between.
    await orch.prepareAndRegisterBatch([item('repair', 'r1', 0, 1)]);
    await orch.prepareAndRegisterBatch([item('product', 'p1', 0, 1)]);
    const out = await orch.recoverPendingStockMedia();
    const rep = out.dbReport.find((r) => r.entityType === 'repair');
    const prod = out.dbReport.find((r) => r.entityType === 'product');
    ok(rep?.action === 'finalized_from_ready_rust' && prod?.action === 'finalized_from_ready_rust',
      `§2 both jobs are recovered by the ONE pipeline (${rep?.action} / ${prod?.action})`);
    ok(rep?.productId === undefined && rep?.entityId === 'r1', '§2 the repair job carries NO productId');
    ok(prod?.productId === 'p1', '§2 the product job carries its productId');
    ok(out.completedProductIds.length === 1 && out.completedProductIds[0].productId === 'p1',
      `§2 only the product reaches the embedding hook (${JSON.stringify(out.completedProductIds.map((x) => x.productId))})`);
    ok(gal(db, 'r1').length === 1, '§2 …and the repair image is linked to the repair, as asked');
  }

  // ── §3 binary transport ─────────────────────────────────────────────────────────────────────
  {
    const calls: Array<{ cmd: string; args: unknown; options?: { headers?: Record<string, string> } }> = [];
    const t = new OriginalMediaTransport(async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (cmd === 'media_read_verified_raw') return new Uint8Array([1, 2, 3]).buffer as never;
      return { storage_key: 'k', hash: 'h', byte_size: 5, mime_type: 'application/pdf', extension: 'pdf', content_kind: 'pdf', reused: false } as never;
    });
    const pdf = new TextEncoder().encode('%PDF-1.7 hello');
    const d = await t.publishOriginal({ tenantScope: 'tenant-1', extension: 'pdf', bytes: pdf, sha256: 'a'.repeat(64) });
    const c0 = calls[0];
    ok(c0.cmd === 'media_publish_original' && c0.args === pdf, '§3 the bytes ARE the argument — the same Uint8Array, raw');
    ok(!Array.isArray(c0.args) && typeof c0.args !== 'string', '§3 …never a JSON number[] and never a Base64 string');
    ok(c0.options?.headers?.['x-lataif-tenant-scope'] === 'tenant-1' && c0.options?.headers?.['x-lataif-extension'] === 'pdf'
      && c0.options?.headers?.['x-lataif-sha256'] === 'a'.repeat(64), '§3 metadata travels in headers');
    ok(d.content_kind === 'pdf', '§3 the descriptor comes back');
    const raw = await t.readVerifiedRaw({ tenantScope: 'tenant-1', hash: 'h', extension: 'pdf' });
    ok(raw instanceof Uint8Array && raw.length === 3, '§3 the read path returns raw bytes (ArrayBuffer → Uint8Array)');
    const refuse = async (f: () => Promise<unknown>) => { try { await f(); return ''; } catch (e) { return e instanceof OriginalTransportError ? e.code : String(e); } };
    const n = calls.length;
    ok(await refuse(() => t.publishOriginal({ tenantScope: 't', extension: 'docx' as never, bytes: pdf })) === 'MEDIA_ORIGINAL_KIND_NOT_ALLOWED', '§3 unlisted kind refused before sending');
    ok(await refuse(() => t.publishOriginal({ tenantScope: 't', extension: 'pdf', bytes: new Uint8Array(0) })) === 'MEDIA_ORIGINAL_EMPTY', '§3 empty refused');
    ok(await refuse(() => t.publishOriginal({ tenantScope: 't', extension: 'pdf', bytes: new Uint8Array(ORIGINAL_MAX_BYTES + 1) })) === 'MEDIA_ORIGINAL_TOO_LARGE', '§3 above the limit refused before sending');
    ok(calls.length === n, '§3 …none of the refused uploads reached the bridge');
    const bad = new OriginalMediaTransport(async () => [1, 2, 3] as never);
    ok(await refuse(() => bad.readVerifiedRaw({ tenantScope: 't', hash: 'h', extension: 'pdf' })) === 'MEDIA_RAW_RESPONSE_EXPECTED', '§3 a JSON array answer is refused, not accepted');
    const gw = readFileSync(join(repo, 'src/core/media/gateway.ts'), 'utf8');
    ok(/imageBytes: Array\.from\(input\.imageBytes\)/.test(gw), '§3 the small product upload path is unchanged');
    const lib = readFileSync(join(repo, 'src-tauri/src/lib.rs'), 'utf8');
    const handler = lib.slice(lib.indexOf('tauri::generate_handler!['));
    ok(/^\s*media_read_verified_raw,/m.test(handler) && /^\s*media_publish_original,/m.test(handler), '§3 both raw commands are registered');
    ok(/tauri::ipc::InvokeBody::Raw\(b\) => Some\(b\.as_slice\(\)\)/.test(lib) && /tauri::ipc::Response::new\(m\.bytes\)/.test(lib),
      '§3 Rust takes the raw body and answers with a raw Response (Tauri 2 ipc)');
  }

  // ── §4 owner revision in the same transaction ───────────────────────────────────────────────
  {
    const db = new SQL.Database();
    db.run(`CREATE TABLE repairs (id TEXT PRIMARY KEY, branch_id TEXT, updated_at TEXT, revision INTEGER NOT NULL DEFAULT 1)`);
    db.run(`CREATE TRIGGER trg_repairs_revision AFTER UPDATE ON repairs FOR EACH ROW WHEN NEW.revision = OLD.revision
            BEGIN UPDATE repairs SET revision = OLD.revision + 1 WHERE id = NEW.id; END`);
    db.run(`CREATE TABLE products (id TEXT PRIMARY KEY, branch_id TEXT)`);
    db.run(`CREATE TABLE media_links (link_id TEXT, entity_id TEXT, deleted_at TEXT)`);
    db.run(`INSERT INTO repairs (id, branch_id) VALUES ('r1','b1')`);
    db.run(`INSERT INTO products VALUES ('p1','b1')`);
    const rev = () => Number(db.exec(`SELECT revision FROM repairs WHERE id='r1'`)[0].values[0][0]);
    db.run('BEGIN');
    db.run(`INSERT INTO media_links VALUES ('l1','r1',NULL)`);
    const r = bumpMediaOwnerRevision(db as never, { entityType: 'repair', entityId: 'r1', scopeId: 'b1' });
    db.run('COMMIT');
    ok(r.kind === 'revisioned' && r.revision === 2 && rev() === 2, `§4 a link change advances the owner by exactly one (${JSON.stringify(r)})`);
    db.run('BEGIN');
    db.run(`INSERT INTO media_links VALUES ('l2','r1',NULL)`);
    bumpMediaOwnerRevision(db as never, { entityType: 'repair', entityId: 'r1', scopeId: 'b1' });
    db.run('ROLLBACK');
    ok(rev() === 2 && db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0] === 1, '§4 rolled back together: link and revision');
    const code = (f: () => unknown) => { try { f(); return ''; } catch (e) { return e instanceof OwnerRevisionError ? e.code : String(e); } };
    ok(code(() => bumpMediaOwnerRevision(db as never, { entityType: 'repair', entityId: 'r1', scopeId: 'b-other' })) === 'MEDIA_OWNER_NOT_FOUND', '§4 wrong branch → refused');
    ok(code(() => bumpMediaOwnerRevision(db as never, { entityType: 'repair', entityId: 'nope', scopeId: 'b1' })) === 'MEDIA_OWNER_NOT_FOUND', '§4 missing owner → refused');
    ok(code(() => bumpMediaOwnerRevision(db as never, { entityType: 'customer; DROP TABLE x', entityId: 'r1', scopeId: 'b1' })) === 'MEDIA_OWNER_ENTITY_UNKNOWN', '§4 unknown owner type → refused (no free table name)');
    ok(bumpMediaOwnerRevision(db as never, { entityType: 'product', entityId: 'p1', scopeId: 'b1' }).kind === 'not_revisioned', '§4 an owner without revision contract is reported, not faked');
    ok(rev() === 2, '§4 refusals changed nothing');
  }

  // ── §5 TS mirrors = Rust contract ──────────────────────────────────────────────────────────
  {
    const st = readFileSync(join(repo, 'src-tauri/src/media/storage.rs'), 'utf8');
    ok(/pub const DOCUMENT_MAX_BYTES: u64 = 25 \* 1024 \* 1024;/.test(st) && ORIGINAL_MAX_BYTES === 25 * 1024 * 1024, '§5 document limit identical on both sides');
    const originals = [...st.matchAll(/StoredKind \{ ext: "([a-z]+)",[^}]*original: true/g)].map((m) => m[1]);
    ok(JSON.stringify(originals) === JSON.stringify([...ORIGINAL_EXTENSIONS]), `§5 original kinds identical (${originals})`);
    ok(/StoredKind \{ ext: "jpg", mime: "image\/jpeg", content_kind: "raster_image", original: false, max_bytes: RENDITION_MAX_BYTES \}/.test(st)
      && /pub const RENDITION_MAX_BYTES: u64 = 100_000;/.test(st), '§5 the product JPEG contract is unchanged (≤ 100 000 B)');
    ok(!/ext != "jpg"/.test(st), '§5 no generic jpg-only assumption left in the store');
  }

  // ── §6 the security-class boundary as it really is ──────────────────────────────────────────
  // No encryption-at-rest exists: every generation is written with is_encrypted = 0. The schema
  // therefore makes `highly_sensitive` UNWRITABLE (class-D trigger) — no false security. `sensitive`
  // is storable but never served over /api/media (Rust grant: public/internal only).
  {
    const db = new SQL.Database(); seed(db); applyMediaSchema(db);
    const gw = new FakeGateway();
    const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db) });
    const it = [item('product', 'p1', 0, 1)]; await orch.prepareAndRegisterBatch(it); await orch.finalizeBatch(it);
    const blob = String(db.exec(`SELECT master_blob_id FROM media_objects LIMIT 1`)[0].values[0][0]);
    const insert = (cls: string) => {
      try {
        db.run(`INSERT INTO media_objects (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind, source_type, security_class, retention_class, ingest_status, created_at, updated_at)
                VALUES ('t1', ?, 'b1', ?, 'normalized', 'upload_desktop', ?, 'standard', 'ready', 'x', 'x')`, [`m-${cls}`, blob, cls]);
        return 'ok';
      } catch (e) { return String((e as Error).message); }
    };
    ok(/MEDIA_CLASS_D_UNENCRYPTED/.test(insert('highly_sensitive')), '§6 highly_sensitive cannot be written without encryption (schema refuses)');
    ok(insert('sensitive') === 'ok', '§6 sensitive is storable (a later, explicit transition contract) …');
    const grant = readFileSync(join(repo, 'src-tauri/src/sync/product_query.rs'), 'utf8');
    ok(/o\.security_class IN \('public', 'internal'\)/.test(grant), '§6 …but /api/media serves public/internal only');
    const coord = readFileSync(join(repo, 'src/core/media/coordinator.ts'), 'utf8');
    ok(!/is_encrypted[^\n]*\n[^\n]*VALUES[^\n]*, 1, /.test(coord) && /\$ext, 0, NULL, 'available'/.test(coord),
      '§6 no writer claims encryption: generations are written is_encrypted = 0');
  }

  // ── §7 recovery isolation: job-local vs systemic ────────────────────────────────────────────
  {
    class DivergingGateway extends FakeGateway {
      divergeFor = ''; bridgeDownFor = '';
      override async commitStockImage(i: CommitInput): Promise<CommitResult> {
        if (i.ingestRequestId === this.bridgeDownFor) throw new Error('BRIDGE_DISCONNECTED');
        const r = await super.commitStockImage(i);
        return i.ingestRequestId === this.divergeFor ? { ...r, main_descriptor: { ...r.main_descriptor, hash: 'f'.repeat(64) } } : r;
      }
    }
    const setup = async () => {
      const db = new SQL.Database(); seed(db); applyMediaSchema(db);
      const gw = new DivergingGateway();
      const orch = new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db) });
      for (const pid of ['p1', 'p3']) { const it = [item('product', pid, 0, 1)]; await orch.prepareAndRegisterBatch(it); await orch.finalizeBatch(it); }
      // X: an edit of p1 that adds a new image — its rendition will diverge (job-local, permanent)
      const nb = dataBytes('p1-new');
      const [x0] = gal(db, 'p1');
      await orch.prepareAndRegisterEdit(scopeFor('product', 'p1'),
        [{ tenantId: 't1', ingestRequestId: 'edit-new:p1:x', requestHash: sha256Hex(nb), imageBytes: nb }],
        async (baseline, prepared) => buildEditPlanEnvelope({ batchId: 'edit:x', tenantId: 't1', branchId: 'b1', scopeKind: 'branch', entityType: 'product', entityId: 'p1', role: ROLE,
          baseline, desired: [keep(x0), { source: 'new', requestId: 'edit-new:p1:x', requestHash: sha256Hex(nb) }], prepared }, digestHex));
      // Y: an independent, healthy edit of p3, registered AFTER X
      const [y0] = gal(db, 'p3');
      await orch.prepareAndRegisterEdit(scopeFor('product', 'p3'), [], async (baseline, prepared) => buildEditPlanEnvelope({
        batchId: 'edit:y', tenantId: 't1', branchId: 'b1', scopeKind: 'branch', entityType: 'product', entityId: 'p3', role: ROLE,
        baseline, desired: [keep(y0)], prepared }, digestHex));
      return { db, gw, x0 };
    };
    {
      const { db, gw, x0 } = await setup();
      gw.divergeFor = 'edit-new:p1:x';
      let threw = ''; let rep: Awaited<ReturnType<MediaDbCoordinator['recover']>> = [];
      try { rep = await new MediaDbCoordinator(db as never, gw).recover(); } catch (e) { threw = String((e as Error).message); }
      const x = rep.find((r) => r.ingestRequestId === 'edit:edit:x');
      const y = rep.find((r) => r.ingestRequestId === 'edit:edit:y');
      ok(threw === '' && x?.action === 'left_pending_job_blocked' && x.errorCode === 'MEDIA_EDIT_RENDITION_DIVERGED',
        `§7 a job-local, permanent failure is reported with its code (${threw || x?.action}/${x?.errorCode})`);
      ok(y?.action === 'edit_applied_from_plan', `§7 …and the later independent job is still recovered (${y?.action})`);
      ok(JSON.stringify(gal(db, 'p1')) === JSON.stringify([x0]), '§7 the blocked job changed nothing (gallery as before)');
      ok(db.exec(`SELECT state FROM media_ingest_jobs WHERE ingest_request_id='edit:edit:x'`)[0].values[0][0] === 'accepted', '§7 …and stays pending, not rewritten');
    }
    {
      const { db, gw } = await setup();
      gw.bridgeDownFor = 'edit-new:p1:x';
      let threw = '';
      try { await new MediaDbCoordinator(db as never, gw).recover(); } catch (e) { threw = String((e as Error).message); }
      ok(threw === 'BRIDGE_DISCONNECTED', `§7 a systemic fault (the bridge) still stops the pass — fail-closed (${threw || 'kein Abbruch'})`);
    }
    const coordSrc = readFileSync(join(repo, 'src/core/media/coordinator.ts'), 'utf8');
    ok(/return e instanceof CoordinatorError && !isTransactionActive\(\) && !isTransactionUnhealthy\(\);/.test(coordSrc),
      '§7 job-local = a coordinator validation with no transaction left open — not a blanket catch');
  }

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — media s1 foundation: ${PASS} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('MEDIA_S1_FOUNDATION_TS_PROVED');
}
await main();
