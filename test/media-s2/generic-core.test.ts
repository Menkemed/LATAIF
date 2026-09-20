// ════════════════════════════════════════════════════════════════════════════
// MEDIA-S2 — generic media core: owner contract, ingest without link, link/unlink/replace with the
// owner's revision in ONE transaction, generic resolver, recovery by owner.
// Run: node test/media-s2/generic-core.test.ts
//
// REAL sql.js + REAL media schema + REAL coordinator/orchestrator; a fake gateway stands in for Rust.
// ════════════════════════════════════════════════════════════════════════════
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { createHash } from 'node:crypto';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { StockMediaOrchestrator, type OrchestratorLease, type OrchestratorRawDb, type IngestAndFinalizeInput } from '../../src/core/media/orchestrator.ts';
import { MediaDbCoordinator } from '../../src/core/media/coordinator.ts';
import { ProductMediaResolver } from '../../src/core/media/product-media-resolver.ts';
import { MediaOwnerLinks, MediaLinkError } from '../../src/core/media/media-links.ts';
import { resolveOwnerMedia } from '../../src/core/media/owner-media-resolver.ts';
import { MediaOwnerError, type MediaOwner } from '../../src/core/media/media-owner.ts';
import { enterTransaction, leaveNestedTransaction, resetTransactionContext, isTransactionActive } from '../../src/core/db/transaction-context.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { failures.push(m); console.log(`  ✗ ${m}`); } }

function dataBytes(s: string): Uint8Array { const b = new Uint8Array(24); for (let i = 0; i < 24; i++) b[i] = (s.charCodeAt(i % s.length) + i) & 0xff; return b; }
function sha256Hex(b: Uint8Array): string { return createHash('sha256').update(Buffer.from(b)).digest('hex'); }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

class FakeGateway implements MediaCommandGateway {
  private byHash = new Map<string, { main: string; thumb: string; mainB: Uint8Array; thumbB: Uint8Array }>();
  private files = new Map<string, Uint8Array>();
  private reqBytes = new Map<string, Uint8Array>();
  commits = 0;
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
    this.commits++;
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
  db.run(`CREATE TABLE repairs (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT, notes TEXT, revision INTEGER NOT NULL DEFAULT 1)`);
  db.run(`CREATE TRIGGER trg_repairs_revision AFTER UPDATE ON repairs FOR EACH ROW WHEN NEW.revision = OLD.revision
          BEGIN UPDATE repairs SET revision = OLD.revision + 1 WHERE id = NEW.id; END`);
  // Jeder Besitzertyp mit SEINER Kennspalte: die Altgold-Position wird ueber `line_key`
  // gefunden, nicht ueber `id` (MEDIA-SCRAP).
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    const extra = t.idCol === 'id' ? '' : `, ${t.idCol} TEXT`;
    db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT${extra})`);
  }
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`INSERT INTO tenants (id) VALUES ('t1')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1')`);
  db.run(`INSERT INTO products (id, branch_id) VALUES ('p1','b1')`);
  db.run(`INSERT INTO repairs (id, branch_id) VALUES ('r1','b1'),('r2','b1')`);
  db.run(`INSERT INTO suppliers (id, branch_id) VALUES ('s1','b1')`);
}
const rev = (db: any, id: string) => Number(db.exec(`SELECT revision FROM repairs WHERE id=?`, [id])[0].values[0][0]);
const activeLinks = (db: any, id: string) => { const r = db.exec(`SELECT media_id FROM media_links WHERE entity_id=? AND deleted_at IS NULL ORDER BY sort_order`, [id]); return r.length ? r[0].values.map((v: unknown[]) => String(v[0])) : []; };
const owner = (entityId: string, extra: Partial<MediaOwner> = {}): MediaOwner => ({ tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: 'repair', entityId, role: 'repair_photo', securityClass: 'internal', ...extra });
const code = (f: () => unknown) => { try { f(); return ''; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const acode = async (f: () => Promise<unknown>) => { try { await f(); return ''; } catch (e) { return `${(e as { code?: string }).code ?? ''}|${(e as Error).message}`; } };

/** A business transaction exactly as the house brackets one (outermost level owns BEGIN/COMMIT). */
function businessTx(db: any, fn: () => void): 'committed' | 'rolled_back' {
  const outer = enterTransaction(); if (outer) db.run('BEGIN IMMEDIATE');
  try { fn(); if (leaveNestedTransaction() && outer) db.run('COMMIT'); return 'committed'; }
  catch { if (outer) { resetTransactionContext(); try { db.run('ROLLBACK'); } catch { /* already */ } } return 'rolled_back'; }
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });
  const fresh = () => { const db = new SQL.Database(); seed(db); applyMediaSchema(db); const gw = new FakeGateway(); return { db, gw, orch: new StockMediaOrchestrator({ gateway: gw, leaseFactory: () => leaseFor(db) }) }; };
  const obj = (orch: StockMediaOrchestrator, tag: string, extra: Record<string, unknown> = {}) => {
    const bytes = dataBytes(tag);
    return orch.ingestObject({ tenantId: 't1', branchId: 'b1', scopeKind: 'branch', ingestRequestId: `obj:${tag}`, requestHash: sha256Hex(bytes), ownerType: 'repair', role: 'repair_photo', imageBytes: bytes, ...extra } as never);
  };

  // ── §1 product backward compatibility ─────────────────────────────────────────────────────
  {
    const { db, gw, orch } = fresh();
    const items: IngestAndFinalizeInput[] = [0, 1].map((i) => { const b = dataBytes(`p1-${i}`); return { tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p1', scopeKind: 'branch', role: 'stock_image', ingestRequestId: `create:p1:${i}`, requestHash: sha256Hex(b), isPrimary: i === 0, sortOrder: i, imageBytes: b, batch: { batchId: 'create:p1', expectedCount: 2 } }; });
    await orch.prepareAndRegisterBatch(items); await orch.finalizeBatch(items);
    const pr = await new ProductMediaResolver({ dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1' }).resolveProductMedia('p1');
    const gen = resolveOwnerMedia(db, { tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: 'product', role: 'stock_image', entityIds: ['p1'] }).get('p1')!;
    ok(pr.kind === 'media' && pr.items.length === 2, `§1 the product path is unchanged (${pr.kind})`);
    ok(pr.kind === 'media' && JSON.stringify(pr.items.map((x) => x.mediaId)) === JSON.stringify(gen.map((x) => x.mediaId))
      && gen[0].isPrimary && !gen[1].isPrimary, '§1 the generic resolver sees the same gallery, same order, same primary');
    ok(gen.every((x) => x.thumbnail && x.main.storageKey.endsWith('.jpg')), '§1 …as references (keys), not bytes');
  }

  // ── §2 ingest without a link ──────────────────────────────────────────────────────────────
  {
    const { db, gw, orch } = fresh();
    const r = await obj(orch, 'a');
    const o = db.exec(`SELECT ingest_status, security_class, origin_branch_id FROM media_objects WHERE media_id=?`, [r.mediaId])[0].values[0];
    ok(JSON.stringify(o) === JSON.stringify(['ready', 'internal', 'b1']), `§2 a verified, ready media object exists (${JSON.stringify(o)})`);
    ok(Number(db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0]) === 0, '§2 …and NO link was written');
    const job = db.exec(`SELECT state, requested_entity_type, requested_entity_id FROM media_ingest_jobs WHERE ingest_request_id='obj:a'`)[0].values[0];
    ok(job[0] === 'ready' && job[1] === 'repair' && job[2] === null, `§2 the job records the owner TYPE, not an owner that may not exist yet (${JSON.stringify(job)})`);
    const commits = gw.commits;
    const again = await obj(orch, 'a');
    ok(again.mediaId === r.mediaId && gw.commits === commits, '§2 a retry returns the frozen object — no second publish (idempotent)');
    ok(Number(db.exec(`SELECT COUNT(*) FROM media_objects`)[0].values[0][0]) === 1, '§2 …no second object');
    ok((await acode(() => obj(orch, 'hs', { securityClass: 'highly_sensitive' }))).includes('MEDIA_CLASS_REQUIRES_ENCRYPTION'), '§2 highly_sensitive cannot be ingested (no encryption, no silent downgrade)');
    // MEDIA-IDENTITY — `customer` IST seit dem Ausweisdokument ein Besitzertyp; abgewiesen wird,
    // was die Karte `MEDIA_ENTITY_SCOPE` nicht kennt. Der Test fragt jetzt danach.
    ok((await acode(() => obj(orch, 'cu', { ownerType: 'stammtisch' }))).includes('MEDIA_OWNER_TYPE_UNKNOWN'), '§2 an owner type the schema cannot hold is refused');
    ok((await acode(() => obj(orch, 'sc', { ownerType: 'tenant_logo' }))).includes('MEDIA_OWNER_SCOPE_MISMATCH'), '§2 a tenant-scoped owner with a branch context is refused');
  }

  // ── §3–§6 link / unlink / replace with the owner revision, in ONE transaction ──────────────
  {
    const { db, orch } = fresh();
    const a = await obj(orch, 'a'); const b = await obj(orch, 'b'); const c = await obj(orch, 'c');
    const links = new MediaOwnerLinks(db as never);
    const r0 = rev(db, 'r1');
    // §3 link inside a business transaction (the owner row changes in the same bracket)
    let ch1: ReturnType<MediaOwnerLinks['link']> | null = null;
    const st = businessTx(db, () => {
      db.run(`UPDATE repairs SET notes='mit Foto' WHERE id='r1'`);
      ch1 = links.link(owner('r1'), a.mediaId);
    });
    ok(st === 'committed' && !isTransactionActive(), '§3 business transaction committed');
    ok(JSON.stringify(activeLinks(db, 'r1')) === JSON.stringify([a.mediaId]) && ch1!.isPrimary && ch1!.sortOrder === 0, '§3 the link is active, first = primary at 0');
    ok(rev(db, 'r1') === r0 + 2, `§3 owner revision: +1 for the field, +1 for the link — both in the same commit (${r0} → ${rev(db, 'r1')})`);
    // §5 stale detection: a form opened before a media change sees a different revision
    const seenByForm = rev(db, 'r1');
    const ch2 = links.link(owner('r1'), b.mediaId);
    ok(ch2.revision.kind === 'revisioned' && ch2.revision.revision === seenByForm + 1 && rev(db, 'r1') !== seenByForm,
      '§5 after a media change the revision the form holds is stale → its save would be RECORD_CHANGED');
    // §4a replace: same slot, same primary flag, exactly ONE revision step
    const beforeReplace = rev(db, 'r1');
    const oldLink = db.exec(`SELECT link_id FROM media_links WHERE media_id=? AND deleted_at IS NULL`, [a.mediaId])[0].values[0][0];
    const rep = links.replace(owner('r1'), String(oldLink), c.mediaId);
    ok(JSON.stringify(activeLinks(db, 'r1')) === JSON.stringify([c.mediaId, b.mediaId]) && rep.isPrimary && rep.sortOrder === 0, '§4 replace keeps the slot and the primary flag');
    ok(rev(db, 'r1') === beforeReplace + 1, '§4 replace advances the owner revision exactly once');
    // §4b unlink: the rest close ranks, slot 0 primary again
    const beforeUnlink = rev(db, 'r1');
    const cLink = db.exec(`SELECT link_id FROM media_links WHERE media_id=? AND deleted_at IS NULL`, [c.mediaId])[0].values[0][0];
    links.unlink(owner('r1'), String(cLink));
    const g = db.exec(`SELECT media_id, sort_order, is_primary FROM media_links WHERE entity_id='r1' AND deleted_at IS NULL`)[0].values;
    ok(JSON.stringify(g) === JSON.stringify([[b.mediaId, 0, 1]]), `§4 unlink: the rest close ranks, primary at 0 (${JSON.stringify(g)})`);
    ok(rev(db, 'r1') === beforeUnlink + 1, '§4 unlink advances the owner revision');
    // §6 rollback restores both
    const r2Before = rev(db, 'r2');
    const d = await obj(orch, 'd');
    const rb = businessTx(db, () => {
      links.link(owner('r2'), d.mediaId);
      throw new Error('business rule refused the repair');
    });
    ok(rb === 'rolled_back' && activeLinks(db, 'r2').length === 0 && rev(db, 'r2') === r2Before, '§6 business rollback: no half link, revision back');
    ok(Number(db.exec(`SELECT COUNT(*) FROM media_objects WHERE media_id=?`, [d.mediaId])[0].values[0][0]) === 1, '§6 …the unlinked object stays (GC contract), unreachable');
    // refusals change nothing
    const rNow = rev(db, 'r1');
    ok(code(() => links.link(owner('r1'), b.mediaId)) === 'MEDIA_LINK_ALREADY_ACTIVE', '§3 an active link is not doubled');
    ok(code(() => links.link(owner('r1', { branchId: 'b2' }), d.mediaId)) === 'MEDIA_LINK_SCOPE_MISMATCH' || code(() => links.link(owner('r1', { branchId: 'b2' }), d.mediaId)) === 'MEDIA_OWNER_NOT_FOUND', '§3 wrong branch is refused');
    ok(code(() => links.link(owner('r1', { securityClass: 'sensitive' }), d.mediaId)) === 'MEDIA_LINK_CLASS_MISMATCH', '§3 no silent class change on link');
    ok(code(() => links.link(owner('r1', { securityClass: 'highly_sensitive' }), d.mediaId)) === 'MEDIA_CLASS_REQUIRES_ENCRYPTION', '§3 highly_sensitive owner refused');
    ok(code(() => links.link(owner('nope'), d.mediaId)) === 'MEDIA_OWNER_NOT_FOUND', '§3 a missing owner is refused (and the link rolled back)');
    ok(code(() => links.unlink(owner('r2'), String(cLink))) === 'MEDIA_LINK_NOT_FOUND', '§4 a foreign link cannot be unlinked through another owner');
    ok(rev(db, 'r1') === rNow && activeLinks(db, 'nope').length === 0 && !isTransactionActive(), '§3 refusals changed nothing and left no transaction open');
  }

  // ── §7 resolver: active links, branch, class, many owners in one call ───────────────────────
  {
    const { db, orch } = fresh();
    const links = new MediaOwnerLinks(db as never);
    const a = await obj(orch, 'a'); const b = await obj(orch, 'b');
    const s = await obj(orch, 's', { ownerType: 'supplier', role: 'document_photo', securityClass: 'sensitive' });
    const x = await obj(orch, 'x', { branchId: 'b2' });
    links.link(owner('r1'), a.mediaId); links.link(owner('r2'), b.mediaId);
    links.link({ ...owner('s1'), entityType: 'supplier', role: 'document_photo', securityClass: 'sensitive' }, s.mediaId);
    db.run(`INSERT INTO repairs (id, branch_id) VALUES ('r9','b2')`);
    links.link({ ...owner('r9'), branchId: 'b2' }, x.mediaId);
    let calls = 0;
    const counting = { exec: (sql: string, p?: unknown[]) => { calls++; return db.exec(sql, p as never); } };
    const res = resolveOwnerMedia(counting, { tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: 'repair', role: 'repair_photo', entityIds: ['r1', 'r2', 'r9'] });
    ok(calls === 1, `§7 many owners, ONE query (${calls})`);
    ok(res.get('r1')![0].mediaId === a.mediaId && res.get('r2')![0].mediaId === b.mediaId, '§7 each owner gets its own media');
    ok(res.get('r9')!.length === 0, '§7 an owner of another branch yields nothing through this branch');
    const sup = (cls?: ('public' | 'internal' | 'sensitive' | 'highly_sensitive')[]) => resolveOwnerMedia(db, { tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: 'supplier', role: 'document_photo', entityIds: ['s1'], classes: cls }).get('s1')!.length;
    ok(sup() === 0 && sup(['sensitive']) === 1, '§7 sensitive media only when the caller names the class');
    ok(sup(['highly_sensitive']) === 0, '§7 highly_sensitive is never returned');
    links.unlink(owner('r1'), res.get('r1')![0].linkId);
    ok(resolveOwnerMedia(db, { tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: 'repair', role: 'repair_photo', entityIds: ['r1'] }).get('r1')!.length === 0, '§7 a removed link is gone from the read');
    ok(resolveOwnerMedia(db, { tenantId: 't2', scopeKind: 'branch', branchId: 'b1', entityType: 'repair', role: 'repair_photo', entityIds: ['r2'] }).get('r2')!.length === 0, '§7 wrong tenant yields nothing');
  }

  // ── §8 recovery by owner: product embeds, nothing else ever does ────────────────────────────
  {
    const { db, gw, orch } = fresh();
    const coord = new MediaDbCoordinator(db as never, gw);
    // crash between intent and finalize — for an object-only repair ingest and a product-TYPE object
    for (const [tag, type] of [['rp', 'repair'], ['po', 'product']] as const) {
      const bytes = dataBytes(tag);
      const input = { tenantId: 't1', branchId: 'b1', scopeKind: 'branch' as const, ingestRequestId: `obj:${tag}`, requestHash: sha256Hex(bytes), ownerType: type, role: type === 'product' ? 'stock_image' : 'repair_photo' };
      const prepared = await gw.prepareStockImage({ tenantScope: 't1', ingestRequestId: input.ingestRequestId, requestHash: input.requestHash, imageBytes: bytes });
      coord.registerPendingObjectIntent(input, prepared);
    }
    // …and a real linked product ingest, also interrupted
    const pb = dataBytes('p1-x');
    await orch.prepareAndRegisterBatch([{ tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p1', scopeKind: 'branch', role: 'stock_image', ingestRequestId: 'create:p1:x', requestHash: sha256Hex(pb), isPrimary: true, sortOrder: 0, imageBytes: pb, batch: { batchId: 'create:p1:x', expectedCount: 1 } }]);
    const out = await orch.recoverPendingStockMedia();
    const act = (irid: string) => out.dbReport.find((r) => r.ingestRequestId === irid);
    ok(act('obj:rp')?.action === 'object_finalized_from_ready_rust' && act('obj:po')?.action === 'object_finalized_from_ready_rust',
      `§8 object-only jobs recover through the SAME pipeline (${act('obj:rp')?.action})`);
    ok(act('obj:rp')?.productId === undefined && act('obj:po')?.productId === undefined, '§8 no object-only job carries a productId (no link, no product side effect)');
    ok(act('create:p1:x')?.action === 'finalized_from_ready_rust' && act('create:p1:x')?.productId === 'p1', '§8 the linked product job recovers as before');
    ok(JSON.stringify(out.completedProductIds.map((x) => x.productId)) === JSON.stringify(['p1']), `§8 only the linked product reaches the embedding (${JSON.stringify(out.completedProductIds.map((x) => x.productId))})`);
    ok(Number(db.exec(`SELECT COUNT(*) FROM media_links WHERE entity_type='repair'`)[0].values[0][0]) === 0, '§8 recovery wrote no link for object-only jobs');
    const again = await orch.recoverPendingStockMedia();
    ok(again.dbReport.every((r) => r.action === 'noop_already_ready'), '§8 a second pass is a no-op');
  }

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — media s2 generic core: ${PASS} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('MEDIA_S2_GENERIC_CORE_TS_PROVED');
}
await main();
