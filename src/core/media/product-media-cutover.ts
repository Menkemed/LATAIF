// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2A — product media cutover service (INACTIVE core layer).
//
// The one migration that must never lose an image. The resolver
// ([[product-media-resolver]]) suppresses the legacy `products.images` column
// the instant ANY media_link exists for a product (active OR retired). So a
// write path that appends a SINGLE new link to a legacy product would make the
// resolver show a one-image gallery and silently hide every other legacy photo.
//
// This service closes that trap: for a legacy product it imports the ENTIRE
// visible legacy gallery, in order, through the durable media orchestrator,
// verifies all N links are present, and only THEN clears `products.images`
// (durably). Until that final step the legacy column is the source of truth and
// is never touched — so a crash, a failure, or a retry can never lose an image.
//
// INACTIVE: no React / productStore / ImageUpload caller wires this yet (3B2+).
// Every dependency is injected; tests bring a real sql.js DB + the real
// orchestrator + a fake gateway.
//
// NEVER logs base64 or image bytes — aggregate counts only.
// ════════════════════════════════════════════════════════════════════════════

import type { FinalizeResult } from './coordinator.ts';
import type { IngestAndFinalizeInput } from './orchestrator.ts';
import { parseLegacyImages } from './product-media-resolver.ts';
import { toIngestRequestId } from './ingest-request-id.ts';

// ── error contract ──────────────────────────────────────────────────────────

export type CutoverErrorCode =
  | 'MEDIA_CUTOVER_SCOPE_REQUIRED'
  | 'MEDIA_CUTOVER_UNSUPPORTED_LEGACY'   // a legacy entry is not a decodable data: URL
  | 'MEDIA_CUTOVER_LEGACY_FORMAT_ERROR'  // products.images is not a JSON string[]
  | 'MEDIA_CUTOVER_INCOMPLETE'           // fewer active links than legacy after import
  | 'MEDIA_CUTOVER_MANIFEST_MISMATCH'    // active gallery ≠ the ordered legacy manifest
  | 'MEDIA_CUTOVER_PRODUCT_CHECKPOINT_FAILED' // product row not durable before publish
  | 'MEDIA_CUTOVER_INGEST_FAILED';       // an orchestrator ingest threw

export class CutoverError extends Error {
  readonly code: CutoverErrorCode;
  readonly cause?: unknown;
  constructor(code: CutoverErrorCode, message?: string, cause?: unknown) {
    super(message ?? code);
    this.code = code;
    this.cause = cause;
    this.name = 'CutoverError';
  }
}

// ── result DTO ──────────────────────────────────────────────────────────────

export interface CutoverResult {
  productId: string;
  action:
    | 'noop_no_legacy'        // no link history, no legacy → nothing to do
    | 'noop_already_migrated' // link history + legacy already cleared → done
    | 'migrated'              // imported the legacy gallery, then cleared legacy
    | 'resumed_and_cleared';  // an interrupted cutover: re-ran idempotently, cleared
  imported: number;           // active links after the run (0 for the noops)
}

// ── injected pieces ─────────────────────────────────────────────────────────

interface RawDb {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

/** A decoded legacy image ready for the orchestrator. */
export interface DecodedLegacyImage {
  bytes: Uint8Array;
  /** informational only — the Rust core re-derives everything from the bytes */
  mimeType: string;
}

export interface ProductMediaCutoverDeps {
  /** Read-only DB access (link history + the legacy column). A provider, not a
   *  pinned handle, so a reload between calls is picked up. */
  dbProvider: () => RawDb;
  /** The durable per-image ingest. Real production passes a
   *  `StockMediaOrchestrator`; tests pass the same, wired to a fake gateway. */
  orchestrator: {
    ingestAndFinalizeStockImage(input: IngestAndFinalizeInput): Promise<FinalizeResult>;
  };
  /** Clear `products.images` for one product AND persist durably. Injected so
   *  the "clear + durable save" step is observable and its failure testable.
   *  MUST only be called by this service after all N links are verified. */
  commitLegacyCleared: (productId: string) => Promise<void>;
  /**
   * Persist the product row durably BEFORE the first Rust publish (create
   * path). The media_link entity-existence trigger refuses a link whose
   * product/branch row is absent, and the row must be on disk so a crash
   * cannot leave a published rendition pointing at a non-existent product.
   * If omitted, the caller guarantees the product is already durable.
   */
  ensureProductDurable?: (productId: string) => Promise<void>;
  tenantId: string;
  branchId: string;
  role?: string;
  /** Decode one legacy entry to bytes. Defaults to a `data:` URL decoder. */
  decodeLegacyImage?: (src: string) => DecodedLegacyImage;
  /** The canonical request hash for the input bytes. Defaults to a client
   *  mirror of the Rust `canonical_request_hash`. */
  computeRequestHash?: (bytes: Uint8Array, scope: string) => Promise<string>;
}

const DEFAULT_ROLE = 'stock_image';

// ── service ─────────────────────────────────────────────────────────────────

export class ProductMediaCutoverService {
  private readonly deps: ProductMediaCutoverDeps;
  private readonly tenantId: string;
  private readonly branchId: string;
  private readonly role: string;
  private readonly decode: (src: string) => DecodedLegacyImage;
  private readonly hashOf: (bytes: Uint8Array, scope: string) => Promise<string>;

  constructor(deps: ProductMediaCutoverDeps) {
    if (!deps.tenantId || !deps.branchId) {
      throw new CutoverError('MEDIA_CUTOVER_SCOPE_REQUIRED');
    }
    this.deps = deps;
    this.tenantId = deps.tenantId;
    this.branchId = deps.branchId;
    this.role = deps.role ?? DEFAULT_ROLE;
    this.decode = deps.decodeLegacyImage ?? decodeDataUrl;
    this.hashOf = deps.computeRequestHash ?? canonicalRequestHash;
  }

  /**
   * Idempotently ensure a product's visible gallery lives in the media tables,
   * not in `products.images`.
   *
   * Decision — driven by whether the legacy column still holds anything, which
   * is the ONLY reliable "cutover not finished" signal (a completed cutover
   * always clears legacy as its last durable act):
   *
   *   legacy empty, history present  → already migrated  → no-op
   *   legacy empty, no history       → nothing to show    → no-op
   *   legacy non-empty               → import ALL legacy images in order (a
   *                                     resume is idempotent via deterministic
   *                                     request ids), verify N active links,
   *                                     THEN clear legacy durably
   *
   * The legacy column is untouched until the very last step, so any failure or
   * crash leaves the full legacy gallery intact and the operation converges on
   * retry with no duplicates.
   */
  async ensureProductMediaCutover(productId: string): Promise<CutoverResult> {
    const db = this.deps.dbProvider();
    const legacyRaw = this.legacyImagesValue(db, productId);
    const parsed = parseLegacyImages(legacyRaw);
    if (!parsed.ok) {
      throw new CutoverError('MEDIA_CUTOVER_LEGACY_FORMAT_ERROR', parsed.code);
    }
    const legacy = parsed.items;

    if (legacy.length === 0) {
      // Nothing left in the legacy column. If links exist it is already done;
      // either way there is nothing to import and nothing to clear.
      return {
        productId,
        action: this.hasLinkHistory(db, productId) ? 'noop_already_migrated' : 'noop_no_legacy',
        imported: 0,
      };
    }

    // Legacy is populated ⇒ the cutover is not finished. Decode everything up
    // front so a bad entry aborts BEFORE any link is created (legacy untouched).
    const decoded = legacy.map((src, i) => {
      try {
        return this.decode(src);
      } catch (e) {
        throw new CutoverError(
          'MEDIA_CUTOVER_UNSUPPORTED_LEGACY',
          `legacy[${i}] is not a decodable data: URL`,
          e,
        );
      }
    });

    const resuming = this.hasLinkHistory(db, productId);

    // Import every legacy image, in order, through the durable orchestrator.
    // Deterministic, scope-qualified request ids make a re-run a pure no-op for
    // images already finalized (the coordinator short-circuits a ready job), so
    // a crash or a partial previous run converges here with zero duplicates.
    // We collect each FinalizeResult — this is the EXPECTED manifest we verify
    // the durable gallery against before touching the legacy column.
    const expected: FinalizeResult[] = [];
    for (let i = 0; i < decoded.length; i++) {
      const bytes = decoded[i].bytes;
      const requestHash = await this.hashOf(bytes, this.tenantId);
      const input: IngestAndFinalizeInput = {
        tenantId: this.tenantId,
        branchId: this.branchId,
        entityType: 'product',
        entityId: productId,
        scopeKind: 'branch',
        role: this.role,
        ingestRequestId: cutoverRequestId(this.tenantId, this.branchId, productId, this.role, i),
        requestHash,
        isPrimary: i === 0,
        sortOrder: i,
        imageBytes: bytes,
      };
      try {
        expected.push(await this.deps.orchestrator.ingestAndFinalizeStockImage(input));
      } catch (e) {
        // Legacy is still intact (never touched yet). Surface and let the
        // caller retry — the already-imported prefix will be idempotent.
        throw new CutoverError('MEDIA_CUTOVER_INGEST_FAILED', asMessage(e), e);
      }
    }

    // Only clear legacy once the durable active gallery EXACTLY matches the
    // ordered legacy manifest — per slot: sort_order, is_primary, link/media
    // identity, content hash, mime + extension. A foreign, missing, duplicate
    // or diverging link → conflict, and the legacy column is left untouched.
    this.assertExactManifest(this.deps.dbProvider(), productId, expected);

    // Durable clear — the single atomic visibility switch. If it fails the
    // links are already durable (each ingest ran its own cp2), so no image is
    // lost; the resolver keeps showing the full legacy until a later retry
    // clears the column.
    await this.deps.commitLegacyCleared(productId);

    return {
      productId,
      action: resuming ? 'resumed_and_cleared' : 'migrated',
      imported: expected.length,
    };
  }

  /**
   * Assert the durable active gallery is EXACTLY the ordered manifest we just
   * imported — nothing foreign, nothing missing, nothing reordered, no content
   * drift. This is the gate in front of the irreversible legacy clear.
   */
  private assertExactManifest(db: RawDb, productId: string, expected: FinalizeResult[]): void {
    // First the RAW active-link count: a foreign active link whose blob
    // generation is missing would be silently dropped by the manifest join, so
    // comparing only the joined rows could miss it. The raw count catches any
    // extra/foreign active link before the per-slot checks.
    const rawActive = this.activeLinkCount(db, productId);
    if (rawActive !== expected.length) {
      throw new CutoverError(
        'MEDIA_CUTOVER_MANIFEST_MISMATCH',
        `expected ${expected.length} active links, found ${rawActive}`,
      );
    }
    const rows = this.activeGalleryManifest(db, productId);
    if (rows.length !== expected.length) {
      // A resolvable-manifest row is missing → some link's current generation
      // is unavailable. Refuse the clear rather than lose an image.
      throw new CutoverError(
        'MEDIA_CUTOVER_MANIFEST_MISMATCH',
        `expected ${expected.length} resolvable links, found ${rows.length}`,
      );
    }
    for (let i = 0; i < expected.length; i++) {
      const want = expected[i];
      const got = rows[i]; // ordered by sort_order ASC
      const wantMain = want.main;
      const okSlot =
        Number(got.sort_order) === i &&
        Number(got.is_primary) === (i === 0 ? 1 : 0) &&
        String(got.link_id) === want.linkId &&
        String(got.media_id) === want.mediaId &&
        got.stored_blob_hash != null && String(got.stored_blob_hash) === wantMain.hash &&
        String(got.mime_type) === wantMain.mime_type &&
        String(got.extension) === wantMain.extension &&
        Number(got.byte_size) === wantMain.byte_size;
      if (!okSlot) {
        throw new CutoverError(
          'MEDIA_CUTOVER_MANIFEST_MISMATCH',
          `slot ${i} does not match the expected manifest`,
        );
      }
    }
  }

  /**
   * The create/add-image contract (inactive core; no UI wiring yet).
   *
   * A NEW product is persisted durably WITHOUT any base64 in `products.images`
   * (the row must exist first — the media_link entity-existence trigger refuses
   * a link whose product/branch row is absent). Its photos are then appended
   * here, in order, each through the durable orchestrator.
   *
   * Appends at slots [currentActiveCount .. currentActiveCount + k), so it is
   * correct for a fresh product (starts at 0, first image becomes primary) AND
   * for adding images to an already-migrated gallery. Deterministic per-slot
   * request ids keep a crash/retry idempotent with no duplicates. This path
   * NEVER touches `products.images`.
   */
  async appendOrderedProductImages(
    productId: string,
    images: Array<Uint8Array | DecodedLegacyImage>,
  ): Promise<FinalizeResult[]> {
    if (images.length === 0) return [];

    // Product durability BEFORE the first publish. If the row is not on disk
    // yet, a crash after a Rust publish would leave a rendition pointing at a
    // non-existent product (and the link trigger would reject it anyway). This
    // checkpoint must succeed before ANY ingest runs; its failure means no
    // publish, no link, no success.
    if (this.deps.ensureProductDurable) {
      try {
        await this.deps.ensureProductDurable(productId);
      } catch (e) {
        throw new CutoverError('MEDIA_CUTOVER_PRODUCT_CHECKPOINT_FAILED', asMessage(e), e);
      }
    }

    const base = this.activeLinkCount(this.deps.dbProvider(), productId);
    const out: FinalizeResult[] = [];
    for (let k = 0; k < images.length; k++) {
      const raw = images[k];
      const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
      const slot = base + k;
      const requestHash = await this.hashOf(bytes, this.tenantId);
      const input: IngestAndFinalizeInput = {
        tenantId: this.tenantId,
        branchId: this.branchId,
        entityType: 'product',
        entityId: productId,
        scopeKind: 'branch',
        role: this.role,
        ingestRequestId: appendRequestId(this.tenantId, this.branchId, productId, this.role, slot),
        requestHash,
        isPrimary: slot === 0,
        sortOrder: slot,
        imageBytes: bytes,
      };
      try {
        out.push(await this.deps.orchestrator.ingestAndFinalizeStockImage(input));
      } catch (e) {
        throw new CutoverError('MEDIA_CUTOVER_INGEST_FAILED', asMessage(e), e);
      }
    }
    return out;
  }

  /**
   * The new-product create contract (inactive core; wired by 3B2B).
   *
   * Places image[i] at slot i by its FIXED list index — not at the current
   * active count. That distinction is what makes a create RETRY idempotent:
   * re-passing the same full list re-finalizes the SAME per-index request ids,
   * so already-imported images are no-ops (the coordinator short-circuits a
   * ready job) and only the missing tail is created — no duplicate links, order
   * preserved. `appendOrderedProductImages` (append-at-end) is the wrong tool
   * here precisely because its slot shifts by the already-imported count.
   *
   * NEVER touches `products.images`. The caller must have persisted the product
   * row durably first (the entity-existence trigger enforces its presence).
   */
  async placeOrderedProductImages(
    productId: string,
    images: Array<Uint8Array | DecodedLegacyImage>,
  ): Promise<FinalizeResult[]> {
    const out: FinalizeResult[] = [];
    for (let i = 0; i < images.length; i++) {
      const raw = images[i];
      const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
      const requestHash = await this.hashOf(bytes, this.tenantId);
      const input: IngestAndFinalizeInput = {
        tenantId: this.tenantId,
        branchId: this.branchId,
        entityType: 'product',
        entityId: productId,
        scopeKind: 'branch',
        role: this.role,
        ingestRequestId: createRequestId(this.tenantId, this.branchId, productId, this.role, i),
        requestHash,
        isPrimary: i === 0,
        sortOrder: i,
        imageBytes: bytes,
      };
      try {
        out.push(await this.deps.orchestrator.ingestAndFinalizeStockImage(input));
      } catch (e) {
        throw new CutoverError('MEDIA_CUTOVER_INGEST_FAILED', asMessage(e), e);
      }
    }
    return out;
  }

  // ── queries ────────────────────────────────────────────────────────────────

  /** Any link row at all for THIS scope — active OR retired. */
  private hasLinkHistory(db: RawDb, productId: string): boolean {
    const r = firstRow(
      db,
      `SELECT 1 AS hit FROM media_links
        WHERE tenant_id = $t AND scope_kind = 'branch' AND branch_id = $br
          AND entity_type = 'product' AND entity_id = $p AND media_role = $role
        LIMIT 1`,
      { $t: this.tenantId, $br: this.branchId, $p: productId, $role: this.role },
    );
    return r != null;
  }

  private activeLinkCount(db: RawDb, productId: string): number {
    const r = firstRow(
      db,
      `SELECT COUNT(*) AS n FROM media_links
        WHERE tenant_id = $t AND scope_kind = 'branch' AND branch_id = $br
          AND entity_type = 'product' AND entity_id = $p AND media_role = $role
          AND deleted_at IS NULL`,
      { $t: this.tenantId, $br: this.branchId, $p: productId, $role: this.role },
    );
    return r ? Number(r.n) : 0;
  }

  /**
   * The active gallery joined down to its CURRENT, AVAILABLE blob generation —
   * every relation filtered on its own liveness flag, ordered by sort_order.
   * Same join the resolver uses, so the manifest we verify is exactly what a
   * reader would later resolve.
   */
  private activeGalleryManifest(db: RawDb, productId: string): Array<Record<string, unknown>> {
    return allRows(
      db,
      `SELECT l.link_id, l.media_id, l.sort_order, l.is_primary,
              g.stored_blob_hash, g.extension, g.mime_type, g.byte_size
         FROM media_links l
         JOIN media_objects o
           ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id AND o.deleted_at IS NULL
         LEFT JOIN media_blobs b
           ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
          AND b.deleted_at IS NULL AND b.blob_status = 'present'
         LEFT JOIN media_blob_generations g
           ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
          AND g.generation_no = b.current_generation_no
          AND g.gen_status = 'available' AND g.deleted_at IS NULL
        WHERE l.tenant_id = $t AND l.scope_kind = 'branch' AND l.branch_id = $br
          AND l.entity_type = 'product' AND l.entity_id = $p AND l.media_role = $role
          AND l.deleted_at IS NULL
        ORDER BY l.sort_order ASC`,
      { $t: this.tenantId, $br: this.branchId, $p: productId, $role: this.role },
    );
  }

  /**
   * Raw `products.images`, tenant+branch scoped. `products` carries no
   * tenant_id, so tenancy is reachable only through `branches.tenant_id` — the
   * JOIN is the tenant binding and is not optional (a foreign scope reads
   * `undefined`, never another tenant's column).
   */
  private legacyImagesValue(db: RawDb, productId: string): unknown {
    const r = firstRow(
      db,
      `SELECT p.images AS images
         FROM products p
         JOIN branches b ON b.id = p.branch_id AND b.tenant_id = $t
        WHERE p.id = $p AND p.branch_id = $br`,
      { $t: this.tenantId, $p: productId, $br: this.branchId },
    );
    if (!r) return undefined;
    return r.images;
  }
}

// ── deterministic request id ────────────────────────────────────────────────
//
// One stable id per (product, role, slot) so a resumed cutover re-finalizes the
// SAME request (idempotent no-op) instead of creating a duplicate link.
//
// Every id here is emitted through `toIngestRequestId`, because this id is also
// the Rust ingest journal's filename component and the media core accepts ONLY
// 8..=80 chars of [A-Za-z0-9_-]. The previous `op:tenant:branch:...` form
// contained ':' and was rejected with MEDIA_INGEST_INVALID_REQUEST on every
// prepare — the readable operation/scope head is kept, the separators are
// normalised, and a signature over the full composed string keeps distinct
// scopes distinct even after the length bound.

function composedRequestId(
  op: string, tenantId: string, branchId: string, productId: string, role: string, slot: number,
): string {
  return toIngestRequestId(`${op}:${tenantId}:${branchId}:${productId}:${role}:${slot}`);
}

export function cutoverRequestId(
  tenantId: string, branchId: string, productId: string, role: string, slot: number,
): string {
  return composedRequestId('cutover', tenantId, branchId, productId, role, slot);
}

/** Stable id per (tenant, branch, product, role, slot) for the create/add-image
 *  path. Distinct operation namespace from the cutover ids so a legacy
 *  migration and a later append can never collide on the same request identity,
 *  and fully scope-qualified so the SAME productId in two tenants/branches can
 *  never produce the same job. */
export function appendRequestId(
  tenantId: string, branchId: string, productId: string, role: string, slot: number,
): string {
  return composedRequestId('append', tenantId, branchId, productId, role, slot);
}

/** Stable id per (tenant, branch, product, role, slot) for the new-product
 *  create path. Distinct namespace so a create, a later append and a legacy
 *  cutover never collide on the same request identity; keyed by the FIXED list
 *  index so a create retry re-uses the same ids and never duplicates. */
export function createRequestId(
  tenantId: string, branchId: string, productId: string, role: string, slot: number,
): string {
  return composedRequestId('create', tenantId, branchId, productId, role, slot);
}

// ── default legacy decoder: data: URL only ──────────────────────────────────
//
// The 3A census found every legacy entry to be a single `data:` URL. Anything
// that is not a decodable data: URL is refused (never guessed), so the caller
// keeps the legacy column and can migrate it by other means.

export function decodeDataUrl(src: string): DecodedLegacyImage {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
  if (!m) throw new Error('MEDIA_CUTOVER_NOT_A_DATA_URL');
  const mimeType = m[1] || 'application/octet-stream';
  const isBase64 = !!m[2];
  const payload = m[3];
  const bytes = isBase64 ? base64ToBytes(payload) : utf8ToBytes(decodeURIComponent(payload));
  if (bytes.length === 0) throw new Error('MEDIA_CUTOVER_EMPTY_DATA_URL');
  return { bytes, mimeType };
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, '');
  const g = globalThis as unknown as { atob?: (s: string) => string; Buffer?: { from(s: string, enc: string): Uint8Array } };
  if (typeof g.atob === 'function') {
    const bin = g.atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (g.Buffer) return new Uint8Array(g.Buffer.from(clean, 'base64'));
  throw new Error('MEDIA_CUTOVER_NO_BASE64_DECODER');
}

function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ── default canonical request hash (mirrors the Rust core) ──────────────────
//
// Rust `canonical_request_hash` binds these exact literals; they MUST match
// `src-tauri/src/media/ingest.rs` or prepare will reject the client value.

export const CUTOVER_PROTO_VERSION = 'media-ingest-v1';
export const CUTOVER_NORM_PARAMS = 'main<=100000;thumb<=20000;out=jpeg';

export async function canonicalRequestHash(bytes: Uint8Array, scope: string): Promise<string> {
  const inputSha = await sha256Hex(bytes);
  const material = `${CUTOVER_PROTO_VERSION}|${scope}|stock_image|${inputSha}|${CUTOVER_NORM_PARAMS}`;
  return sha256Hex(utf8ToBytes(material));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) throw new Error('MEDIA_CUTOVER_NO_SUBTLE_CRYPTO');
  const view = new Uint8Array(bytes); // fresh plain-ArrayBuffer copy for digest()
  const digest = await subtle.digest('SHA-256', view);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}

// ── local query helpers ──────────────────────────────────────────────────────

function paramsToPositional(sql: string, bound: Record<string, unknown>): { sql: string; values: unknown[] } {
  const order: string[] = [];
  const compiled = sql.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
    order.push(m);
    return '?';
  });
  return { sql: compiled, values: order.map((k) => bound[k]) };
}

function firstRow(db: RawDb, sql: string, bound: Record<string, unknown>): Record<string, unknown> | null {
  const { sql: compiled, values } = paramsToPositional(sql, bound);
  const rows = db.exec(compiled, values);
  if (rows.length === 0 || rows[0].values.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < rows[0].columns.length; i++) out[rows[0].columns[i]] = rows[0].values[0][i];
  return out;
}

function allRows(db: RawDb, sql: string, bound: Record<string, unknown>): Array<Record<string, unknown>> {
  const { sql: compiled, values } = paramsToPositional(sql, bound);
  const rows = db.exec(compiled, values);
  if (rows.length === 0) return [];
  return rows[0].values.map((v) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < rows[0].columns.length; i++) out[rows[0].columns[i]] = v[i];
    return out;
  });
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
