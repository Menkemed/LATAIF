// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3A-R1 — ordered multi-image gallery contract + dual-read resolver
// Run: node test/media04a3a/gallery-and-resolver.test.ts
//
// REAL sql.js in-memory. No productive DB, no Tauri, no filesystem writes
// outside the standard node temp dir. A deterministic fake gateway stands in
// for the Rust command bridge.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { MediaDbCoordinator, type FinalizeInput } from '../../src/core/media/coordinator.ts';
import {
  ProductMediaResolver,
  parseLegacyImages,
} from '../../src/core/media/product-media-resolver.ts';
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
async function throws(msg: string, expected: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); ok(false, `${msg} — expected ${expected}, got none`); }
  catch (e) {
    const code = (e as { code?: string; message?: string }).code ?? (e as Error).message;
    ok(code === expected, `${msg} — expected ${expected}, got ${code}`);
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

function pad64(seed: string): string {
  return (seed.toLowerCase().replace(/[^0-9a-f]/g, '0') + '0'.repeat(64)).slice(0, 64);
}
function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i + seed) & 0xff;
  return out;
}
/** One distinct image payload per index. */
function img(i: number) {
  return {
    reqHash: pad64(`cafe${i}`),
    main: { hash: pad64(`aa${i}`), bytes: bytesOf(50_000 + i, 1 + i), byte_size: 50_000 + i },
    thumb: { hash: pad64(`bb${i}`), bytes: bytesOf(15_000 + i, 2 + i), byte_size: 15_000 + i },
  };
}

function seedEntityStubs(db: any): void {
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  }
  // products gets the legacy images column so the dual-read has something to read.
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`INSERT INTO tenants  (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1'),('bx','t2')`);
  db.run(`INSERT INTO products (id, branch_id, images) VALUES ('p1','b1','[]'),('p2','b1','[]'),('px','bx','[]')`);
}

class FakeGateway implements MediaCommandGateway {
  private jobs = new Map<string, { hash: string; main: any; thumb: any; state: string }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  readVerifiedShouldThrow: string | null = null;

  preset(scope: string, reqId: string, spec: ReturnType<typeof img>): void {
    this.jobs.set(`${scope}::${reqId}`, { hash: spec.reqHash, main: spec.main, thumb: spec.thumb, state: 'prepared' });
    this.files.set(`${scope}::${spec.main.hash}`, { bytes: spec.main.bytes, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${spec.thumb.hash}`, { bytes: spec.thumb.bytes, mime: 'image/jpeg', ext: 'jpg' });
  }
  deleteFile(scope: string, hash: string): void { this.files.delete(`${scope}::${hash}`); }

  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    return {
      ingest_request_id: i.ingestRequestId,
      request_hash: i.requestHash,
      state: 'prepared',
      main_descriptor: desc(j.main.hash, j.main.byte_size, 800, 600),
      thumbnail_descriptor: desc(j.thumb.hash, j.thumb.byte_size, 200, 150),
    };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    if (j.hash !== i.requestHash) throw new Error('MEDIA_INGEST_REQUEST_CONFLICT');
    j.state = 'published';
    return {
      state: 'published',
      main_descriptor: desc(j.main.hash, j.main.byte_size, 800, 600),
      thumbnail_descriptor: desc(j.thumb.hash, j.thumb.byte_size, 200, 150),
      main_storage_key: `${i.tenantScope}/${j.main.hash.slice(0, 2)}/${j.main.hash}.jpg`,
      thumbnail_storage_key: `${i.tenantScope}/${j.thumb.hash.slice(0, 2)}/${j.thumb.hash}.jpg`,
    };
  }
  async abortStockImage(i: AbortInput): Promise<AbortResult> {
    return { ingest_request_id: i.ingestRequestId, state: 'aborted' };
  }
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> {
    if (this.readVerifiedShouldThrow) throw new Error(this.readVerifiedShouldThrow);
    const f = this.files.get(`${i.tenantScope}::${i.hash}`);
    if (!f) throw new Error('MEDIA_FILE_MISSING');
    return { bytes: f.bytes, hash: i.hash, byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext };
  }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}
function desc(hash: string, size: number, w: number, h: number) {
  return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: w, height: h };
}

async function fresh(SQL: any) {
  const db = new SQL.Database();
  seedEntityStubs(db);
  applyMediaSchema(db);
  const gw = new FakeGateway();
  const coord = new MediaDbCoordinator(db, gw);
  const resolver = new ProductMediaResolver({
    dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b1',
  });
  return { db, gw, coord, resolver };
}

function input(o: Partial<FinalizeInput> & { ingestRequestId: string; requestHash: string }): FinalizeInput {
  return {
    tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p1',
    scopeKind: 'branch', role: 'stock_image', ...o,
  };
}

/** Append image #i to p1's gallery at the next free slot. */
async function append(coord: MediaDbCoordinator, gw: FakeGateway, i: number, entityId = 'p1') {
  const spec = img(i);
  const reqId = `req-${entityId}-${i}`;
  gw.preset('t1', reqId, spec);
  return coord.finalize(input({
    ingestRequestId: reqId, requestHash: spec.reqHash, entityId,
    isPrimary: i === 0, sortOrder: i,
  }));
}

function gallery(db: any, entityId = 'p1'): Array<[string, number, number]> {
  const r = db.exec(
    `SELECT media_id, sort_order, is_primary FROM media_links
      WHERE entity_id = ? AND deleted_at IS NULL ORDER BY sort_order`, [entityId]);
  return r.length ? (r[0].values as any[]).map((v) => [String(v[0]), Number(v[1]), Number(v[2])] as [string, number, number]) : [];
}

// ══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 append 0..7, order + exactly one primary ───────────────────────
  {
    const { db, gw, coord } = await fresh(SQL);
    for (let i = 0; i < 8; i++) await append(coord, gw, i);
    const g = gallery(db);
    ok(g.length === 8, `8 active links (got ${g.length})`);
    ok(g.every(([, so], idx) => so === idx), `sort_order contiguous 0..7 (${g.map((x) => x[1]).join(',')})`);
    ok(g.filter(([, , p]) => p === 1).length === 1, 'exactly one primary');
    ok(g[0][2] === 1, 'primary sits at sort_order 0');
  }

  // ── §2 first image must be primary/0 ──────────────────────────────────
  {
    const { gw, coord } = await fresh(SQL);
    const spec = img(0); gw.preset('t1', 'r0', spec);
    await throws('first image non-primary → conflict', 'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.finalize(input({ ingestRequestId: 'r0', requestHash: spec.reqHash, isPrimary: false, sortOrder: 0 })));
    await throws('first image at sort 1 → conflict', 'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.finalize(input({ ingestRequestId: 'r0', requestHash: spec.reqHash, isPrimary: true, sortOrder: 1 })));
  }

  // ── §3 appended image may not be primary, nor skip/collide a slot ─────
  {
    const { gw, coord } = await fresh(SQL);
    await append(coord, gw, 0);
    const spec = img(1); gw.preset('t1', 'r1', spec);
    await throws('second image as primary → conflict', 'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.finalize(input({ ingestRequestId: 'r1', requestHash: spec.reqHash, isPrimary: true, sortOrder: 1 })));
    await throws('sort gap (0 then 2) → conflict', 'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.finalize(input({ ingestRequestId: 'r1', requestHash: spec.reqHash, isPrimary: false, sortOrder: 2 })));
    await throws('duplicate sort_order 0 → conflict', 'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.finalize(input({ ingestRequestId: 'r1', requestHash: spec.reqHash, isPrimary: false, sortOrder: 0 })));
  }

  // ── §4 structurally invalid positions ─────────────────────────────────
  {
    const { gw, coord } = await fresh(SQL);
    const spec = img(0); gw.preset('t1', 'r0', spec);
    await throws('negative sortOrder → invalid input', 'MEDIA_INVALID_INPUT',
      () => coord.finalize(input({ ingestRequestId: 'r0', requestHash: spec.reqHash, sortOrder: -1 })));
    await throws('fractional sortOrder → invalid input', 'MEDIA_INVALID_INPUT',
      () => coord.finalize(input({ ingestRequestId: 'r0', requestHash: spec.reqHash, sortOrder: 0.5 })));
  }

  // ── §5 retry idempotent; same request + different slot = conflict ─────
  {
    const { db, gw, coord } = await fresh(SQL);
    await append(coord, gw, 0);
    const a = await append(coord, gw, 1);
    const spec = img(1);
    const again = await coord.finalize(input({
      ingestRequestId: 'req-p1-1', requestHash: spec.reqHash, isPrimary: false, sortOrder: 1,
    }));
    ok(JSON.stringify(a) === JSON.stringify(again), 'retry returns the frozen result');
    ok(gallery(db).length === 2, `no duplicate link on retry (got ${gallery(db).length})`);
    await throws('same request, different slot → request conflict', 'MEDIA_INGEST_REQUEST_CONFLICT',
      () => coord.finalize(input({ ingestRequestId: 'req-p1-1', requestHash: spec.reqHash, isPrimary: false, sortOrder: 5 })));
  }

  // ── §6 export/reopen preserves order ──────────────────────────────────
  {
    const { db, gw, coord } = await fresh(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    const re = new (SQL as any).Database(db.export());
    const g = gallery(re);
    ok(g.length === 3 && g.every(([, so], i) => so === i), 'order survives export/reopen');
    ok(g[0][2] === 1 && g[1][2] === 0 && g[2][2] === 0, 'primary flag survives export/reopen');
  }

  // ── §7 replace preserves the exact slot ───────────────────────────────
  {
    const { db, gw, coord } = await fresh(SQL);
    const first = await append(coord, gw, 0);
    const second = await append(coord, gw, 1);
    // replace the PRIMARY → new link must be primary at sort 0
    const rp = img(5); gw.preset('t1', 'rep-primary', rp);
    const r1 = await coord.replace({
      ...input({ ingestRequestId: 'rep-primary', requestHash: rp.reqHash }),
      previousLinkId: first.linkId,
    });
    let g = gallery(db);
    const newPrimary = g.find(([m]) => m === r1.mediaId);
    ok(newPrimary != null && newPrimary[1] === 0 && newPrimary[2] === 1, `replaced primary keeps true/0 (${JSON.stringify(newPrimary)})`);
    ok(g.length === 2, `still 2 active links (got ${g.length})`);
    // replace the SECONDARY → new link must be non-primary at the same sort
    const rs = img(6); gw.preset('t1', 'rep-sec', rs);
    const r2 = await coord.replace({
      ...input({ ingestRequestId: 'rep-sec', requestHash: rs.reqHash }),
      previousLinkId: second.linkId,
    });
    g = gallery(db);
    const newSec = g.find(([m]) => m === r2.mediaId);
    ok(newSec != null && newSec[1] === 1 && newSec[2] === 0, `replaced secondary keeps false/1 (${JSON.stringify(newSec)})`);
    // retry is idempotent
    const r2again = await coord.replace({
      ...input({ ingestRequestId: 'rep-sec', requestHash: rs.reqHash }),
      previousLinkId: second.linkId,
    });
    ok(JSON.stringify(r2) === JSON.stringify(r2again), 'replace retry is idempotent');
    ok(gallery(db).length === 2, 'no duplicates after replace retry');
  }

  // ── §8 replace rejects reorder attempts / bad targets ─────────────────
  {
    const { gw, coord } = await fresh(SQL);
    const first = await append(coord, gw, 0);
    await append(coord, gw, 1);
    const rp = img(7); gw.preset('t1', 'rep-x', rp);
    await throws('replace may not change the slot', 'MEDIA_DB_MEDIA_CONFLICT',
      () => coord.replace({
        ...input({ ingestRequestId: 'rep-x', requestHash: rp.reqHash, isPrimary: false, sortOrder: 3 }),
        previousLinkId: first.linkId,
      }));
    await throws('unknown target link → not found', 'MEDIA_DB_LINK_NOT_FOUND',
      () => coord.replace({
        ...input({ ingestRequestId: 'rep-x', requestHash: rp.reqHash }),
        previousLinkId: 'no-such-link',
      }));
  }

  // ── §9 remove secondary compacts the tail ─────────────────────────────
  {
    const { db, gw, coord } = await fresh(SQL);
    const links = [];
    for (let i = 0; i < 4; i++) links.push(await append(coord, gw, i));
    coord.remove({ tenantId: 't1', linkId: links[1].linkId });
    const g = gallery(db);
    ok(g.length === 3, `3 links remain (got ${g.length})`);
    ok(g.every(([, so], i) => so === i), `compacted to 0..2 (${g.map((x) => x[1]).join(',')})`);
    ok(g[0][2] === 1 && g.filter(([, , p]) => p === 1).length === 1, 'primary still exactly one, at 0');
    ok(g.map(([m]) => m).join(',') === [links[0], links[2], links[3]].map((l) => l.mediaId).join(','),
      'relative order of survivors preserved');
  }

  // ── §10 remove primary promotes the next link ─────────────────────────
  {
    const { db, gw, coord } = await fresh(SQL);
    const links = [];
    for (let i = 0; i < 3; i++) links.push(await append(coord, gw, i));
    coord.remove({ tenantId: 't1', linkId: links[0].linkId });
    const g = gallery(db);
    ok(g.length === 2, `2 links remain (got ${g.length})`);
    ok(g[0][0] === links[1].mediaId && g[0][1] === 0 && g[0][2] === 1,
      `former #1 promoted to primary at 0 (${JSON.stringify(g[0])})`);
    ok(g[1][1] === 1 && g[1][2] === 0, 'former #2 compacted to 1, non-primary');
  }

  // ── §11 remove last image → empty gallery, history retained ───────────
  {
    const { db, gw, coord } = await fresh(SQL);
    const only = await append(coord, gw, 0);
    coord.remove({ tenantId: 't1', linkId: only.linkId });
    ok(gallery(db).length === 0, 'no active links left');
    const hist = Number(db.exec(`SELECT COUNT(*) FROM media_links`)[0].values[0][0]);
    ok(hist === 1, `retired link row retained as suppression evidence (got ${hist})`);
    coord.remove({ tenantId: 't1', linkId: only.linkId });
    ok(true, 'second remove is an idempotent no-op');
  }

  // ── §12 recovery reproduces the EXACT frozen slot ─────────────────────
  {
    const { db, gw, coord } = await fresh(SQL);
    await append(coord, gw, 0); // gallery has one image
    // Crash simulation: image #1's intent was frozen at false/1 but the DB tx
    // never landed. Recovery must land it at exactly false/1.
    const spec = img(1);
    gw.preset('t1', 'req-crash', spec);
    const sk = (h: string) => `t1/${h.slice(0, 2)}/${h}.jpg`;
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash, scope_kind, branch_id,
         requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, result_json, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-crash','req-crash', ?, 'branch','b1','product','p1','stock_image',
               'internal','standard', ?, 'accepted', 1, 'n','n')`,
      [spec.reqHash, JSON.stringify({
        kind: 'intent', intentVersion: 2,
        main: { ...desc(spec.main.hash, spec.main.byte_size, 800, 600), storage_key: sk(spec.main.hash) },
        thumbnail: { ...desc(spec.thumb.hash, spec.thumb.byte_size, 200, 150), storage_key: sk(spec.thumb.hash) },
        linkIntent: { isPrimary: false, sortOrder: 1 },
      })] as unknown[],
    );
    const rep = await coord.recover();
    ok(rep.some((r) => r.action === 'finalized_from_ready_rust'), 'crashed job recovered');
    const g = gallery(db);
    ok(g.length === 2, `2 links after recovery (got ${g.length})`);
    ok(g[1][1] === 1 && g[1][2] === 0, `recovered link at exactly false/1 (${JSON.stringify(g[1])})`);
    // second recovery is a no-op — no duplicates
    await coord.recover();
    ok(gallery(db).length === 2, 'second recovery creates no duplicate');
  }

  // ── §13 recovery refuses to guess when no intent is frozen ────────────
  {
    const { db, coord } = await fresh(SQL);
    db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash, scope_kind, branch_id,
         requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, state, attempt_count, created_at, updated_at)
       VALUES ('t1','job-noint','req-noint', ?, 'branch','b1','product','p1','stock_image',
               'internal','standard','accepted', 1, 'n','n')`,
      [pad64('dead')] as unknown[],
    );
    const rep = await coord.recover();
    ok(rep[0].action === 'left_pending_no_manifest', `no-intent job left pending (got ${rep[0].action})`);
    ok(gallery(db).length === 0, 'no link guessed into existence');
  }

  // ══ resolver ═════════════════════════════════════════════════════════

  // ── §14 three active media → ordered, one primary ─────────────────────
  {
    const { gw, coord, resolver } = await fresh(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'media', `kind=media (got ${r.kind})`);
    if (r.kind === 'media') {
      ok(r.items.length === 3, `3 items (got ${r.items.length})`);
      ok(r.items.map((i) => i.sortOrder).join(',') === '0,1,2', 'items ordered 0,1,2');
      ok(r.items.filter((i) => i.isPrimary).length === 1 && r.items[0].isPrimary, 'exactly one primary, first');
      ok(r.items.every((i) => i.bytes.length > 0 && i.mimeType === 'image/jpeg'), 'bytes + mime present');
      ok(r.items[0].bytes.length === img(0).main.byte_size, 'primary bytes are the main rendition');
    }
  }

  // ── §15 media wins over legacy ────────────────────────────────────────
  {
    const { db, gw, coord, resolver } = await fresh(SQL);
    db.run(`UPDATE products SET images = '["data:image/jpeg;base64,AAAA"]' WHERE id='p1'`);
    await append(coord, gw, 0);
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'media', `new media wins over legacy (got ${r.kind})`);
    if (r.kind === 'media') ok(r.items.length === 1, 'legacy is not appended to the gallery');
  }

  // ── §16 no link history + legacy → legacy in array order ──────────────
  {
    const { db, resolver } = await fresh(SQL);
    db.run(`UPDATE products SET images = '["data:a","data:b","data:c"]' WHERE id='p1'`);
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'legacy', `kind=legacy (got ${r.kind})`);
    if (r.kind === 'legacy') ok(r.items.join(',') === 'data:a,data:b,data:c', 'legacy order preserved');
  }

  // ── §17 retired history suppresses legacy ─────────────────────────────
  {
    const { db, gw, coord, resolver } = await fresh(SQL);
    db.run(`UPDATE products SET images = '["data:legacy"]' WHERE id='p1'`);
    const only = await append(coord, gw, 0);
    coord.remove({ tenantId: 't1', linkId: only.linkId });
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'none', `retired gallery → none, legacy NOT revived (got ${r.kind})`);
  }

  // ── §18 no media, no legacy → none ────────────────────────────────────
  {
    const { resolver } = await fresh(SQL);
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'none', `empty everything → none (got ${r.kind})`);
  }

  // ── §19 one corrupt medium fails the WHOLE result ─────────────────────
  {
    const { gw, coord, resolver } = await fresh(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    gw.deleteFile('t1', img(1).main.hash); // middle image's file vanishes
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'integrity_error', `kind=integrity_error (got ${r.kind})`);
    if (r.kind === 'integrity_error') {
      ok(r.code === 'MEDIA_FILE_MISSING', `code surfaced (got ${r.code})`);
      ok(r.mediaId != null, 'offending mediaId reported');
    }
  }

  // ── §20 integrity failure never falls back to legacy ──────────────────
  {
    const { db, gw, coord, resolver } = await fresh(SQL);
    db.run(`UPDATE products SET images = '["data:legacy"]' WHERE id='p1'`);
    await append(coord, gw, 0);
    gw.deleteFile('t1', img(0).main.hash);
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'integrity_error', `broken media + legacy → integrity_error, no fallback (got ${r.kind})`);
  }

  // ── §21 conflict states are reported, never resolved arbitrarily ──────
  {
    // Two primaries can't be inserted through the coordinator (the partial
    // index forbids it), so we simulate a corrupted DB by dropping the
    // entity-scope trigger and planting rows directly.
    const { db, gw, coord, resolver } = await fresh(SQL);
    await append(coord, gw, 0);
    // (a) no primary
    db.run(`UPDATE media_links SET is_primary = 0 WHERE deleted_at IS NULL`);
    let r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'conflict' && r.code === 'MEDIA_GALLERY_NO_PRIMARY', `no primary → conflict (got ${r.kind}/${(r as any).code})`);
    // (b) primary not at 0
    db.run(`UPDATE media_links SET is_primary = 1, sort_order = 3 WHERE deleted_at IS NULL`);
    r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'conflict', `primary at wrong slot → conflict (got ${r.kind})`);
    if (r.kind === 'conflict') ok(r.code === 'MEDIA_GALLERY_SORT_GAP' || r.code === 'MEDIA_GALLERY_PRIMARY_NOT_FIRST', `gap/primary code (got ${r.code})`);
  }

  // ── §22 sort gap between two active links → conflict ──────────────────
  {
    const { db, gw, coord, resolver } = await fresh(SQL);
    await append(coord, gw, 0);
    await append(coord, gw, 1);
    db.run(`UPDATE media_links SET sort_order = 5 WHERE sort_order = 1 AND deleted_at IS NULL`);
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'conflict' && r.code === 'MEDIA_GALLERY_SORT_GAP', `gap → conflict (got ${r.kind}/${(r as any).code})`);
  }

  // ── §23 wrong tenant / wrong branch leaks nothing ─────────────────────
  {
    const { db, gw, coord } = await fresh(SQL);
    await append(coord, gw, 0);
    const otherTenant = new ProductMediaResolver({
      dbProvider: () => db, gateway: gw, tenantId: 't2', branchId: 'bx',
    });
    const r1 = await otherTenant.resolveProductMedia('p1');
    ok(r1.kind === 'none', `foreign tenant sees nothing (got ${r1.kind})`);
    const otherBranch = new ProductMediaResolver({
      dbProvider: () => db, gateway: gw, tenantId: 't1', branchId: 'b2',
    });
    const r2 = await otherBranch.resolveProductMedia('p1');
    ok(r2.kind === 'none', `foreign branch sees nothing (got ${r2.kind})`);
  }

  // ── §24 legacy format matrix ──────────────────────────────────────────
  {
    ok(parseLegacyImages(null).ok && (parseLegacyImages(null) as any).items.length === 0, 'NULL → empty');
    ok(parseLegacyImages('').ok, 'empty string → empty');
    ok(parseLegacyImages('   ').ok, 'whitespace → empty');
    ok(parseLegacyImages('[]').ok && (parseLegacyImages('[]') as any).items.length === 0, '[] → empty');
    const one = parseLegacyImages('["data:x"]');
    ok(one.ok && (one as any).items.length === 1, 'single-element array (the observed productive shape)');
    const many = parseLegacyImages('["a","b"]');
    ok(many.ok && (many as any).items.length === 2, 'multi-element array');
    ok(!parseLegacyImages('{oops').ok, 'malformed JSON → format error');
    ok((parseLegacyImages('{oops') as any).code === 'MEDIA_LEGACY_MALFORMED_JSON', 'stable malformed code');
    ok(!parseLegacyImages('{"a":1}').ok, 'JSON object → format error');
    ok(!parseLegacyImages('[1,2]').ok, 'non-string elements → format error');
    ok((parseLegacyImages('[1,2]') as any).code === 'MEDIA_LEGACY_NON_STRING_ELEMENT', 'stable element code');
  }

  // ── §25 legacy format error surfaces through the resolver ─────────────
  {
    const { db, resolver } = await fresh(SQL);
    db.run(`UPDATE products SET images = '{not json' WHERE id='p1'`);
    const r = await resolver.resolveProductMedia('p1');
    ok(r.kind === 'legacy_format_error', `malformed legacy → legacy_format_error (got ${r.kind})`);
  }

  // ── §26 resolver is strictly read-only ────────────────────────────────
  {
    const { db, gw, coord, resolver } = await fresh(SQL);
    db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY, table_name TEXT, payload TEXT)`);
    db.run(`UPDATE products SET images = '["data:untouched"]' WHERE id='p2'`);
    for (let i = 0; i < 2; i++) await append(coord, gw, i);
    const before = db.export();
    await resolver.resolveProductMedia('p1');
    await resolver.resolveProductMedia('p2');
    await resolver.resolvePrimaryProductMedia('p1');
    const after = db.export();
    ok(before.length === after.length, 'DB image size unchanged by resolving');
    const scl = Number(db.exec(`SELECT COUNT(*) FROM sync_changelog`)[0].values[0][0]);
    ok(scl === 0, `resolver writes no sync_changelog (got ${scl})`);
    const legacy = String(db.exec(`SELECT images FROM products WHERE id='p2'`)[0].values[0][0]);
    ok(legacy === '["data:untouched"]', 'products.images untouched');
    // and no base64 was copied into any media table
    const tables = ['media_links', 'media_objects', 'media_blobs', 'media_blob_generations', 'media_variants', 'media_ingest_jobs'];
    let leaks = 0;
    for (const t of tables) {
      const rows = db.exec(`SELECT * FROM ${t}`);
      if (!rows.length) continue;
      for (const row of rows[0].values) for (const v of row) {
        if (typeof v === 'string' && /^data:|;base64,/.test(v)) leaks++;
      }
    }
    ok(leaks === 0, `no base64 copied into media tables (${leaks})`);
  }

  // ── §27 resolver results survive export/reopen ────────────────────────
  {
    const { db, gw, coord } = await fresh(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    const re = new (SQL as any).Database(db.export());
    const resolver2 = new ProductMediaResolver({
      dbProvider: () => re, gateway: gw, tenantId: 't1', branchId: 'b1',
    });
    const r = await resolver2.resolveProductMedia('p1');
    ok(r.kind === 'media', `reopened DB resolves media (got ${r.kind})`);
    if (r.kind === 'media') {
      ok(r.items.map((i) => i.sortOrder).join(',') === '0,1,2', 'order identical after reopen');
      ok(r.items[0].isPrimary, 'primary identical after reopen');
    }
  }

  // ── §28 primary convenience accessor ──────────────────────────────────
  {
    const { db, gw, coord, resolver } = await fresh(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    const r = await resolver.resolvePrimaryProductMedia('p1');
    ok(r.kind === 'media' && r.items.length === 1 && r.items[0].isPrimary && r.items[0].sortOrder === 0,
      'primary accessor returns exactly the primary');
    // legacy variant returns only the first entry
    db.run(`UPDATE products SET images = '["data:a","data:b"]' WHERE id='p2'`);
    const rl = await resolver.resolvePrimaryProductMedia('p2');
    ok(rl.kind === 'legacy' && rl.items.length === 1 && rl.items[0] === 'data:a', 'legacy primary = images[0]');
  }

  console.log(`\nMEDIA-04A-3A-R1 gallery+resolver: ${PASS}/${PASS + FAIL} checks passed`);
  if (FAIL > 0) {
    console.log('\nFAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
