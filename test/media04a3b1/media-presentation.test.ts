// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B1 — product media presentation controller behaviour
// Run: node test/media04a3b1/media-presentation.test.ts
//
// Drives the framework-agnostic ProductMediaPresentationController directly
// (the React hook is a thin adapter over it, exactly like the M4/M5 lifecycle
// controllers). The Object-URL lifecycle is observed through an instrumented
// URL factory that counts every create + revoke and asserts exactly-once
// revocation — browser-observable behaviour, not a source-string check.
//
// REAL sql.js in-memory for the resolver's own reads; a deterministic fake
// gateway stands in for the Rust bridge; a controllable lease models the DB
// pin. No productive DB, no Tauri, no DOM.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { MediaDbCoordinator, type FinalizeInput } from '../../src/core/media/coordinator.ts';
import {
  ProductMediaPresentationController,
  presentationSrcs,
  isResolvingMedia,
  IDLE_STATE,
  type PresentationState,
  type PresentationLease,
} from '../../src/core/media/presentation.ts';
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
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ── a minimal Blob shim (node has global Blob ≥18, but keep it explicit) ────
const BlobCtor: typeof Blob = (globalThis as any).Blob;

// ── instrumented Object-URL registry ───────────────────────────────────────
class UrlRegistry {
  private seq = 0;
  readonly created: string[] = [];
  readonly revoked: string[] = [];
  create = (_blob: Blob): string => {
    const u = `blob:mock/${++this.seq}`;
    this.created.push(u);
    return u;
  };
  revoke = (url: string): void => {
    this.revoked.push(url);
  };
  /** URLs created but not yet revoked. */
  live(): string[] {
    const counts = new Map<string, number>();
    for (const u of this.created) counts.set(u, (counts.get(u) ?? 0) + 1);
    for (const u of this.revoked) counts.set(u, (counts.get(u) ?? 0) - 1);
    return [...counts.entries()].filter(([, n]) => n > 0).map(([u]) => u);
  }
  /** true iff every revoked URL was revoked exactly once and was real. */
  eachRevokedOnce(): boolean {
    const seen = new Map<string, number>();
    for (const u of this.revoked) seen.set(u, (seen.get(u) ?? 0) + 1);
    for (const [u, n] of seen) {
      if (n !== 1) return false;
      if (!this.created.includes(u)) return false;
    }
    return true;
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
  db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  db.run(`INSERT INTO tenants  (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1'),('bx','t2')`);
  db.run(`INSERT INTO products (id, branch_id, images) VALUES
            ('p1','b1','[]'),('p2','b1','[]'),('q1','b2','[]'),('px','bx','[]')`);
}

class FakeGateway implements MediaCommandGateway {
  private jobs = new Map<string, { hash: string; main: any; thumb: any }>();
  private files = new Map<string, { bytes: Uint8Array; mime: string; ext: string }>();
  /** artificial async delay (ms) for readVerifiedMedia, to widen race windows */
  readDelayMs = 0;
  readShouldThrow: string | null = null;

  preset(scope: string, reqId: string, spec: ReturnType<typeof img>): void {
    this.jobs.set(`${scope}::${reqId}`, { hash: spec.reqHash, main: spec.main, thumb: spec.thumb });
    this.files.set(`${scope}::${spec.main.hash}`, { bytes: spec.main.bytes, mime: 'image/jpeg', ext: 'jpg' });
    this.files.set(`${scope}::${spec.thumb.hash}`, { bytes: spec.thumb.bytes, mime: 'image/jpeg', ext: 'jpg' });
  }
  deleteFile(scope: string, hash: string): void { this.files.delete(`${scope}::${hash}`); }

  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    return {
      ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared',
      main_descriptor: desc(j.main.hash, j.main.byte_size, 800, 600),
      thumbnail_descriptor: desc(j.thumb.hash, j.thumb.byte_size, 200, 150),
    };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
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
    if (this.readDelayMs > 0) await new Promise((r) => setTimeout(r, this.readDelayMs));
    if (this.readShouldThrow) throw new Error(this.readShouldThrow);
    const f = this.files.get(`${i.tenantScope}::${i.hash}`);
    if (!f) throw new Error('MEDIA_FILE_MISSING');
    return { bytes: f.bytes, hash: i.hash, byte_size: f.bytes.length, mime_type: f.mime, extension: f.ext };
  }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}
function desc(hash: string, size: number, w: number, h: number) {
  return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: w, height: h };
}

function input(o: Partial<FinalizeInput> & { ingestRequestId: string; requestHash: string }): FinalizeInput {
  return { tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: 'p1', scopeKind: 'branch', role: 'stock_image', ...o };
}

async function append(coord: MediaDbCoordinator, gw: FakeGateway, i: number, o: { entityId?: string; branchId?: string; tenantId?: string; slot?: number } = {}) {
  const entityId = o.entityId ?? 'p1';
  const tenantId = o.tenantId ?? 't1';
  const slot = o.slot ?? i;
  const spec = img(i);
  const reqId = `req-${tenantId}-${entityId}-${i}`;
  gw.preset(tenantId, reqId, spec);
  return coord.finalize(input({ ingestRequestId: reqId, requestHash: spec.reqHash, entityId, tenantId, branchId: o.branchId ?? 'b1', isPrimary: slot === 0, sortOrder: slot }));
}

/** A lease over a fixed db. Counts acquire/release so we can prove pinning. */
function leaseFactory(db: any, counters: { acquired: number; released: number }) {
  return (): PresentationLease => {
    counters.acquired++;
    return { db: db as PresentationLease['db'], release() { counters.released++; } };
  };
}

async function harness(SQL: any) {
  const db = new SQL.Database();
  seedEntityStubs(db);
  applyMediaSchema(db);
  const gw = new FakeGateway();
  const coord = new MediaDbCoordinator(db, gw);
  const urls = new UrlRegistry();
  const states: PresentationState[] = [];
  const counters = { acquired: 0, released: 0 };
  const make = (extra: Record<string, unknown> = {}) => new ProductMediaPresentationController({
    gateway: gw,
    acquireLease: leaseFactory(db, counters),
    createObjectURL: urls.create,
    revokeObjectURL: urls.revoke,
    onChange: (s) => states.push(s),
    ...extra,
  });
  return { db, gw, coord, urls, states, counters, make };
}

// ══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §1 three media items → ordered srcs, Hero=slot0 ───────────────────
  {
    const { gw, coord, urls, states, counters, make } = await harness(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    const s = c.state;
    ok(s.status === 'media', `status media (got ${s.status})`);
    ok(s.srcs.length === 3, `3 srcs (got ${s.srcs.length})`);
    ok(s.status === 'media' && s.items[0].sortOrder === 0 && s.items[0].isPrimary, 'Hero = slot 0 primary');
    ok(s.status === 'media' && s.items.every((it, idx) => it.sortOrder === idx), 'items ordered 0..2');
    ok(urls.created.length === 3, `3 object URLs created (got ${urls.created.length})`);
    ok(s.srcs.every((u) => u.startsWith('blob:mock/')), 'srcs are object URLs');
    ok(states.some((x) => x.status === 'loading'), 'a loading state was emitted first');
    ok(counters.acquired === 1 && counters.released === 1, 'lease acquired + released exactly once');
  }

  // ── §2 legacy → strings shown unchanged, no object URLs ───────────────
  {
    const { db, urls, make } = await harness(SQL);
    db.run(`UPDATE products SET images = '["data:image/png;base64,AAA","data:image/png;base64,BBB"]' WHERE id='p1'`);
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(c.state.status === 'legacy', `legacy (got ${c.state.status})`);
    ok(c.state.srcs.length === 2 && c.state.srcs[0] === 'data:image/png;base64,AAA', 'legacy strings verbatim');
    ok(urls.created.length === 0, 'no object URLs for legacy');
  }

  // ── §3 none → empty placeholder ───────────────────────────────────────
  {
    const { make } = await harness(SQL);
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(c.state.status === 'empty', `empty (got ${c.state.status})`);
    ok(c.state.srcs.length === 0, 'no srcs for empty');
  }

  // ── §4 integrity_error → error, NO legacy fallback ────────────────────
  {
    const { db, gw, coord, urls, make } = await harness(SQL);
    await append(coord, gw, 0);
    // A legacy value is present, but a broken gallery must NOT fall back to it.
    db.run(`UPDATE products SET images = '["data:image/png;base64,LEAK"]' WHERE id='p1'`);
    gw.readShouldThrow = 'MEDIA_FILE_MISSING';
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(c.state.status === 'error', `error (got ${c.state.status})`);
    ok(c.state.srcs.length === 0, 'no srcs on integrity error');
    ok(!(c.state as any).srcs.includes('data:image/png;base64,LEAK'), 'no legacy leak on integrity error');
    ok(urls.eachRevokedOnce(), 'any URLs made before the failure were revoked once');
    ok(urls.live().length === 0, 'no live URLs after integrity error');
  }

  // ── §4b conflict → error, no legacy fallback ──────────────────────────
  {
    const { db, gw, coord, urls, make } = await harness(SQL);
    for (let i = 0; i < 2; i++) await append(coord, gw, i);
    // Break the gallery invariant: collide sort_order (two rows at 0) →
    // inspectGallery reports MEDIA_GALLERY_SORT_DUPLICATE (no index on
    // sort_order, so this is insertable, unlike a second is_primary).
    db.run(`UPDATE media_links SET sort_order = 0 WHERE entity_id='p1' AND sort_order=1`);
    db.run(`UPDATE products SET images = '["data:image/png;base64,LEAK"]' WHERE id='p1'`);
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(c.state.status === 'error', `conflict → error (got ${c.state.status})`);
    ok(urls.live().length === 0, 'conflict created/left no live URL');
  }

  // ── §5 key switch mid-flight → old result never shown ─────────────────
  {
    const { gw, coord, urls, make } = await harness(SQL);
    await append(coord, gw, 0, { entityId: 'p1', branchId: 'b1' });                 // p1: 1 img
    await append(coord, gw, 1, { entityId: 'q1', branchId: 'b2', slot: 0 });        // q1: 1 img
    gw.readDelayMs = 30;
    const c = make();
    const first = c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    await tick(); // let the first resolve get past lease acquisition
    const second = c.load({ productId: 'q1', tenantId: 't1', branchId: 'b2' });
    await Promise.all([first, second]);
    ok(c.state.status === 'media', 'final state is media');
    ok(c.state.status === 'media' && c.state.items[0].mediaId.length > 0, 'final state has an item');
    // The visible gallery must belong to q1, not p1. q1's only media id differs
    // from p1's; assert the final state is the SECOND resolve by media id.
    const qMedia = String((coord as any).db.exec(
      `SELECT media_id FROM media_links WHERE entity_id='q1' AND deleted_at IS NULL`)[0].values[0][0]);
    ok(c.state.status === 'media' && c.state.items[0].mediaId === qMedia, 'shows q1 gallery, not stale p1');
    ok(urls.live().length === 1, `exactly one live URL after the switch (got ${urls.live().length})`);
    ok(urls.eachRevokedOnce(), 'the superseded p1 URL was revoked exactly once');
    gw.readDelayMs = 0;
  }

  // ── §6 late result after dispose → freshly-made URLs revoked at once ───
  {
    const { gw, coord, urls, make } = await harness(SQL);
    for (let i = 0; i < 2; i++) await append(coord, gw, i);
    gw.readDelayMs = 30;
    const c = make();
    const p = c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    await tick();
    c.dispose(); // unmount before the resolve returns
    await p;
    ok(urls.live().length === 0, `no live URL after dispose+late result (got ${urls.live().length})`);
    ok(urls.eachRevokedOnce(), 'late-created URLs each revoked exactly once');
    ok(c.state.status === 'idle', 'disposed controller is idle');
    gw.readDelayMs = 0;
  }

  // ── §7 reload (second load) revokes the previous generation's URLs ────
  {
    const { gw, coord, urls, make } = await harness(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    const firstGen = [...urls.created];
    ok(urls.live().length === 3, 'first load has 3 live URLs');
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' }); // refresh
    ok(firstGen.every((u) => urls.revoked.includes(u)), 'all first-gen URLs revoked on reload');
    ok(urls.live().length === 3, 'exactly the second-gen URLs are live');
    ok(urls.eachRevokedOnce(), 'no URL revoked twice across the reload');
    c.dispose();
    ok(urls.live().length === 0, 'dispose revokes the remaining live URLs');
    ok(urls.eachRevokedOnce(), 'every URL revoked exactly once overall');
  }

  // ── §8 resolver/read throw → error state, no crash, no leak ────────────
  {
    const { gw, coord, urls, make } = await harness(SQL);
    await append(coord, gw, 0);
    gw.readShouldThrow = 'MEDIA_FILE_HASH_MISMATCH';
    const c = make();
    let threw = false;
    try { await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' }); }
    catch { threw = true; }
    ok(!threw, 'load never throws to the caller');
    ok(c.state.status === 'error', 'read throw → error state');
    ok(urls.live().length === 0, 'no leaked URL after a read throw');
  }

  // ── §9 acquireLease throw → error, lease not double-released ──────────
  {
    const { db, urls, states } = await harness(SQL);
    const counters = { acquired: 0, released: 0 };
    let boom = true;
    const c = new ProductMediaPresentationController({
      gateway: new FakeGateway(),
      acquireLease: () => { if (boom) throw new Error('DB_BUSY'); return { db, release() { counters.released++; } }; },
      createObjectURL: urls.create, revokeObjectURL: urls.revoke,
      onChange: (s) => states.push(s),
    });
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(c.state.status === 'error' && c.state.code === 'DB_BUSY', 'lease failure surfaces as error');
    ok(counters.released === 0, 'no release when acquire threw');
    boom = false;
  }

  // ── §10 no DB write happened anywhere (read-only proof) ───────────────
  {
    const { db, gw, coord, make } = await harness(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    const before = db.export();
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    c.dispose();
    const after = db.export();
    ok(before.length === after.length, 'DB byte length unchanged by presentation');
    let identical = before.length === after.length;
    for (let i = 0; identical && i < before.length; i++) if (before[i] !== after[i]) identical = false;
    ok(identical, 'DB bytes byte-for-byte unchanged (no write)');
  }

  // ── §11 disabled/empty key → idle, and disposal still clean ───────────
  {
    const { make, urls } = await harness(SQL);
    const c = make();
    // never load; just dispose → still idle, nothing revoked/leaked
    c.dispose();
    ok(c.state.status === 'idle', 'never-loaded controller is idle');
    ok(urls.created.length === 0 && urls.revoked.length === 0, 'no URL churn without a load');
  }

  // ── §12 rapid triple switch → only the last wins, all others revoked ──
  {
    const { gw, coord, urls, make } = await harness(SQL);
    await append(coord, gw, 0, { entityId: 'p1', branchId: 'b1' });
    await append(coord, gw, 1, { entityId: 'p2', branchId: 'b1', slot: 0 });
    await append(coord, gw, 2, { entityId: 'q1', branchId: 'b2', slot: 0 });
    gw.readDelayMs = 15;
    const c = make();
    const a = c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    const b = c.load({ productId: 'p2', tenantId: 't1', branchId: 'b1' });
    const d = c.load({ productId: 'q1', tenantId: 't1', branchId: 'b2' });
    await Promise.all([a, b, d]);
    const qMedia = String((coord as any).db.exec(
      `SELECT media_id FROM media_links WHERE entity_id='q1' AND deleted_at IS NULL`)[0].values[0][0]);
    ok(c.state.status === 'media' && c.state.items[0].mediaId === qMedia, 'last (q1) wins the triple switch');
    ok(urls.live().length === 1, `only one live URL after triple switch (got ${urls.live().length})`);
    ok(urls.eachRevokedOnce(), 'all superseded URLs revoked exactly once');
    gw.readDelayMs = 0;
  }

  // ══════════════════════════════════════════════════════════════════════
  // R1 — fail-closed loading + partial-URL cleanup + edit-disable teardown
  // ══════════════════════════════════════════════════════════════════════

  // helper: a lease whose readVerifiedMedia is delayed, so we can inspect the
  // states emitted WHILE the resolve is still pending.
  const legacyLeakInAnyState = (states: PresentationState[]): boolean =>
    states.some((s) => s.status === 'legacy');

  // ── §R1a retired link + legacy present, slow resolve → never legacy ───
  {
    const { db, gw, coord, urls, states, make } = await harness(SQL);
    await append(coord, gw, 0);                         // one link…
    const only = String(db.exec(`SELECT link_id FROM media_links WHERE entity_id='p1'`)[0].values[0][0]);
    db.run(`UPDATE media_links SET deleted_at='x', is_primary=0 WHERE link_id=?`, [only]); // …retired
    db.run(`UPDATE products SET images='["data:image/png;base64,GHOST"]' WHERE id='p1'`);
    gw.readDelayMs = 20;
    const c = make();
    const p = c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    await tick();
    // While pending, the only emitted states so far must be loading — never legacy.
    ok(states.every((s) => s.status !== 'legacy'), 'no legacy state while retired-link resolve pending');
    await p;
    ok(c.state.status === 'empty', `retired gallery → empty, not legacy (got ${c.state.status})`);
    ok(!legacyLeakInAnyState(states), 'legacy never appeared at any point (retired + legacy)');
    ok(urls.created.length === 0, 'no object URLs for a retired/empty gallery');
    gw.readDelayMs = 0;
  }

  // ── §R1b wrong tenant/branch during pending → no legacy flash ─────────
  {
    const { db, gw, coord, states, make } = await harness(SQL);
    await append(coord, gw, 0, { entityId: 'p1', branchId: 'b1' });
    db.run(`UPDATE products SET images='["data:image/png;base64,SECRET"]' WHERE id='p1'`);
    gw.readDelayMs = 20;
    const c = make();
    // Resolve p1 under the WRONG tenant t2 → scope isolation yields none.
    const p = c.load({ productId: 'p1', tenantId: 't2', branchId: 'b1' });
    await tick();
    ok(states.every((s) => s.status !== 'legacy'), 'no legacy flash while wrong-tenant resolve pending');
    await p;
    ok(c.state.status === 'empty', `wrong tenant → empty, no legacy (got ${c.state.status})`);
    ok(!legacyLeakInAnyState(states), 'legacy never shown for a foreign scope');
    gw.readDelayMs = 0;
  }

  // ── §R1c integrity/conflict → never legacy at ANY emitted state ───────
  {
    const { db, gw, coord, states, make } = await harness(SQL);
    await append(coord, gw, 0);
    db.run(`UPDATE products SET images='["data:image/png;base64,LEAK"]' WHERE id='p1'`);
    gw.readShouldThrow = 'MEDIA_FILE_MISSING';
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(c.state.status === 'error', 'integrity → error');
    ok(!legacyLeakInAnyState(states), 'no legacy state anywhere on integrity error');
    ok(states.every((s) => presentationSrcs(s).every((x) => !x.includes('LEAK'))), 'no legacy src ever selected');
  }

  // ── §R1d partial createObjectURL failure → all made URLs revoked ──────
  {
    const { gw, coord, urls, make } = await harness(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    // createObjectURL succeeds twice, then throws on the third item.
    let n = 0;
    const failingCreate = (_blob: Blob): string => {
      n++;
      if (n === 3) throw new Error('OBJECT_URL_LIMIT');
      return urls.create(_blob);
    };
    const c = make({ createObjectURL: failingCreate });
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(c.state.status === 'error', `partial URL failure → error (got ${c.state.status})`);
    ok(c.state.status === 'error' && c.state.code === 'OBJECT_URL_LIMIT', 'error carries the create failure');
    ok(urls.created.length === 2, `exactly 2 URLs were created before the failure (got ${urls.created.length})`);
    ok(urls.live().length === 0, `no leaked URL after partial failure (live=${urls.live().length})`);
    ok(urls.eachRevokedOnce(), 'the 2 partial URLs were each revoked exactly once');
  }

  // ── §R1e enter edit mode (disable) → clear() revokes active URLs ──────
  {
    const { gw, coord, urls, make } = await harness(SQL);
    for (let i = 0; i < 3; i++) await append(coord, gw, i);
    const c = make();
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(urls.live().length === 3, 'gallery shown with 3 live URLs');
    c.clear(); // simulates the hook's disabled branch (editing = true)
    ok(c.state.status === 'idle', 'clear() returns to idle');
    ok(urls.live().length === 0, 'clear() revoked all active URLs');
    ok(urls.eachRevokedOnce(), 'each URL revoked exactly once by clear()');
    // …and the controller is still usable afterwards (edit → back to view).
    await c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    ok(c.state.status === 'media' && c.state.srcs.length === 3, 'controller reloads after clear()');
    ok(urls.live().length === 3, 'reload has 3 fresh live URLs');
    c.dispose();
    ok(urls.live().length === 0 && urls.eachRevokedOnce(), 'final dispose leaves nothing live');
  }

  // ── §R1f clear() during a pending resolve → late result discarded ─────
  {
    const { gw, coord, urls, make } = await harness(SQL);
    for (let i = 0; i < 2; i++) await append(coord, gw, i);
    gw.readDelayMs = 25;
    const c = make();
    const p = c.load({ productId: 'p1', tenantId: 't1', branchId: 'b1' });
    await tick();
    c.clear(); // disabled mid-flight
    await p;
    ok(c.state.status === 'idle', 'state stays idle after clear() cancels the pending resolve');
    ok(urls.live().length === 0, 'late resolve after clear() created no lasting URL');
    ok(urls.eachRevokedOnce(), 'any late-created URLs revoked exactly once');
    gw.readDelayMs = 0;
  }

  // ── §R1g selectors: fail-closed src selection ─────────────────────────
  {
    ok(presentationSrcs(IDLE_STATE).length === 0, 'presentationSrcs(idle) = []');
    ok(presentationSrcs({ status: 'loading', srcs: [] }).length === 0, 'presentationSrcs(loading) = []');
    ok(presentationSrcs({ status: 'empty', srcs: [] }).length === 0, 'presentationSrcs(empty) = []');
    ok(presentationSrcs({ status: 'error', code: 'X', srcs: [] }).length === 0, 'presentationSrcs(error) = []');
    ok(presentationSrcs({ status: 'legacy', srcs: ['a', 'b'] }).length === 2, 'presentationSrcs(legacy) = the strings');
    ok(presentationSrcs({ status: 'media', srcs: ['u'], items: [] as any }).length === 1, 'presentationSrcs(media) = the urls');
    // isResolvingMedia only true for a live resolve with an authorised key.
    ok(isResolvingMedia({ status: 'loading', srcs: [] }, true) === true, 'loading+key → resolving');
    ok(isResolvingMedia(IDLE_STATE, true) === true, 'idle+key → resolving (pre-first-load)');
    ok(isResolvingMedia({ status: 'loading', srcs: [] }, false) === false, 'no key → never resolving');
    ok(isResolvingMedia({ status: 'media', srcs: [], items: [] as any }, true) === false, 'media → not resolving');
    ok(isResolvingMedia({ status: 'empty', srcs: [] }, true) === false, 'empty → not resolving');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('');
  if (FAIL > 0) {
    console.log(`MEDIA-04A-3B1 media-presentation: ${PASS} passed, ${FAIL} FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`MEDIA-04A-3B1 media-presentation: ${PASS}/${PASS} checks passed`);
  void BlobCtor;
}

main().catch((e) => { console.error(e); process.exit(1); });
