// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3A-R1 — read-only dual-read product media resolver.
//
// Answers exactly one question: "what images does this product have?" —
// preferring the new content-addressed media gallery and falling back to the
// legacy `products.images` column ONLY when the product was never migrated.
//
// STRICTLY READ-ONLY. This module issues no INSERT/UPDATE/DELETE, starts no
// transaction, never touches `products.images`, never writes `sync_changelog`,
// and never persists a byte of image data. It also does NOT create object
// URLs — it hands back raw bytes + MIME type, and the UI layer owns
// `URL.createObjectURL` / `URL.revokeObjectURL` at its own lifecycle boundary.
//
// Fallback semantics (the part that is easy to get wrong):
//   • ANY link-history row for the slot — active or retired — means the
//     product HAS been migrated. A retired-to-empty gallery therefore
//     resolves to `none`, never back to the legacy column: otherwise a
//     deliberately deleted image would silently reappear.
//   • Only a slot with ZERO link rows at all is treated as "never migrated"
//     and reads the legacy column.
//   • A gallery that exists but fails verification is an `integrity_error` —
//     never a silent downgrade to legacy.
// ════════════════════════════════════════════════════════════════════════════

import type { MediaCommandGateway } from './gateway.ts';
import { inspectGallery, classifyPendingIngest } from './coordinator.ts';

// ── DB shape (same minimal surface the coordinator consumes) ────────────────

interface RawDb {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

// ── result DTOs ─────────────────────────────────────────────────────────────

export interface ResolvedMediaItem {
  bytes: Uint8Array;
  mimeType: string;
  mediaId: string;
  sortOrder: number;
  isPrimary: boolean;
}

export type ProductMediaResolution =
  | { kind: 'media'; items: ResolvedMediaItem[] }
  | { kind: 'legacy'; items: string[] }
  | { kind: 'none' }
  /** A create-batch (or any ingest) is still in flight — some ingest jobs for
   *  this product are not yet settled. The view must show a loading/pending
   *  state, NEVER a partial media gallery. Startup-recovery flips this to
   *  `media` once every slot is finalized. (3B2B-R3) */
  | { kind: 'pending'; code: string }
  | { kind: 'integrity_error'; code: string; mediaId?: string }
  | { kind: 'conflict'; code: string }
  | { kind: 'legacy_format_error'; code: string };

// ── legacy parser ───────────────────────────────────────────────────────────
//
// Format census taken against a byte-identical copy of the productive DB
// (MEDIA-04A-3A-R1 §8): 19/19 rows were a valid JSON array holding exactly one
// `data:` URL string. No NULL, no empty string, no malformed JSON, no
// non-string element, no multi-element array was observed.
//
// Supported (observed, or structurally guaranteed by the column default):
//   NULL / '' / whitespace  → absent (the column is nullable and DEFAULTs to '[]')
//   valid JSON string[]     → items in array order (any length, including 0)
// Everything else is NOT invented into a meaning — it is a stable format error.

export type LegacyParse =
  | { ok: true; items: string[] }
  | { ok: false; code: string };

export function parseLegacyImages(raw: unknown): LegacyParse {
  if (raw === null || raw === undefined) return { ok: true, items: [] };
  const s = String(raw);
  if (s.trim() === '') return { ok: true, items: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { ok: false, code: 'MEDIA_LEGACY_MALFORMED_JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, code: 'MEDIA_LEGACY_NOT_AN_ARRAY' };
  for (const e of parsed) {
    if (typeof e !== 'string') return { ok: false, code: 'MEDIA_LEGACY_NON_STRING_ELEMENT' };
  }
  return { ok: true, items: parsed as string[] };
}

// ── dependencies ────────────────────────────────────────────────────────────

export interface ProductMediaResolverDeps {
  /** Resolves the sql.js DB to read from. A provider (not a pinned handle) so
   *  a reload/reset between calls is picked up transparently. */
  dbProvider: () => RawDb;
  /** Only `readVerifiedMedia` is used — the resolver never writes. */
  gateway: Pick<MediaCommandGateway, 'readVerifiedMedia'>;
  tenantId: string;
  /** Branch the product lives in. Product links are branch-scoped per the
   *  media entity-scope manifest. */
  branchId: string;
  /** Defaults to the stock-image role. */
  role?: string;
}

const DEFAULT_ROLE = 'stock_image';

/**
 * Product media is EXCLUSIVELY branch-scoped (3A-R2 §4 decision).
 *
 * The schema is the authority, not a convention: `MEDIA_ENTITY_SCOPE.product`
 * declares `scope: 'branch'`, and the generated `media_links` entity-scope
 * trigger hard-ABORTs a product link with `scope_kind <> 'branch'`
 * (`MEDIA_ENTITY_SCOPE_KIND`), plus a second guard requiring the link's
 * `branch_id` to actually own the product row. There is therefore no such
 * thing as a tenant-global product image, and every query in this module is
 * bound to (tenant_id, scope_kind='branch', branch_id) — never to the
 * entity id alone.
 */
export const PRODUCT_MEDIA_SCOPE_KIND = 'branch' as const;

// ── service ─────────────────────────────────────────────────────────────────

export class ProductMediaResolver {
  private readonly dbProvider: () => RawDb;
  private readonly gateway: Pick<MediaCommandGateway, 'readVerifiedMedia'>;
  private readonly tenantId: string;
  private readonly branchId: string;
  private readonly role: string;

  constructor(deps: ProductMediaResolverDeps) {
    // Product media is branch-scoped only — a resolver without a concrete
    // tenant AND branch could not bind its queries to a single scope, so it
    // is refused at construction rather than silently reading across scopes.
    if (!deps.tenantId || !deps.branchId) {
      throw new Error('MEDIA_RESOLVER_SCOPE_REQUIRED');
    }
    this.dbProvider = deps.dbProvider;
    this.gateway = deps.gateway;
    this.tenantId = deps.tenantId;
    this.branchId = deps.branchId;
    this.role = deps.role ?? DEFAULT_ROLE;
  }

  /**
   * Resolve the full ordered gallery for one product.
   *
   * Decision order (3B2A-R1 — atomic visible cutover):
   *   `products.images` being empty is the SINGLE durable switch between the
   *   legacy gallery and the new media gallery. A cutover imports every legacy
   *   image, verifies the exact manifest, and only THEN clears the column, so:
   *
   *   1. Legacy column is non-empty  → the cutover has NOT finished (or the
   *      product was never migrated). Show the FULL legacy gallery, even if
   *      some new links already exist — never a partial media gallery.
   *      (A malformed legacy value fails closed to `legacy_format_error`.)
   *   2. Legacy column empty + ACTIVE links → migration complete: validate the
   *      gallery, verified-read every item (one bad item fails the whole result).
   *   3. Legacy empty + NO active links but link history → `none` (a
   *      deliberately emptied gallery; deleted images never resurrect).
   *   4. Nothing at all → `none`.
   */
  async resolveProductMedia(productId: string): Promise<ProductMediaResolution> {
    const db = this.dbProvider();

    // Parse legacy up front — it is the authority on "cutover finished?".
    const legacyRaw = this.legacyImagesValue(db, productId);
    const legacy = parseLegacyImages(legacyRaw);
    if (!legacy.ok) return { kind: 'legacy_format_error', code: legacy.code };

    const active = this.activeGallery(db, productId);

    // ── Batch/ingest still in flight (3B2B-R3, refined in R4) ──────────────
    // A create-batch registers all N job intents durably, then publishes them.
    // Until every slot of that batch is published the media gallery is
    // incomplete — show `pending`, never a partial gallery. But ONLY a create
    // batch pends the view: a pending REPLACE (or a single non-batch append)
    // must leave an already-complete gallery visible, and two contradictory
    // create-batches (or a corrupt intent) are a `conflict`, never a silent
    // partial. Legacy-mid-cutover keeps its full legacy column (handled below).
    if (legacy.items.length === 0) {
      const pend = classifyPendingIngest(this.nonTerminalIntents(db, productId));
      if (pend.kind === 'conflict') return { kind: 'conflict', code: pend.code };
      if (pend.kind === 'create_pending') return { kind: 'pending', code: 'MEDIA_BATCH_IN_PROGRESS' };
    }

    // ── No active links ────────────────────────────────────────────────────
    if (active.length === 0) {
      // A retired link is proof the gallery was deliberately emptied → `none`,
      // even if a legacy value lingers: a deleted image never resurrects.
      if (this.hasLinkHistory(db, productId)) return { kind: 'none' };
      // Never migrated → the legacy column is authoritative.
      if (legacy.items.length > 0) return { kind: 'legacy', items: legacy.items };
      return { kind: 'none' };
    }

    // ── Active links present ───────────────────────────────────────────────
    // 3B2A-R1 atomic switch: while `products.images` is still populated the
    // cutover has NOT finished, so the FULL legacy gallery stays visible — a
    // partial media gallery must never show. Only the durable clear of the
    // column flips visibility to the new gallery.
    if (legacy.items.length > 0) {
      return { kind: 'legacy', items: legacy.items };
    }

    {
      // Migrated (legacy cleared) with active links → the media gallery.
      // Gallery invariants — shared with the coordinator so both sides judge
      // identically. Never pick one arbitrarily via LIMIT 1.
      const issue = inspectGallery(active);
      if (issue) return { kind: 'conflict', code: issue };

      const items: ResolvedMediaItem[] = [];
      for (const row of active) {
        const mediaId = String(row.media_id);
        const hash = row.stored_blob_hash == null ? null : String(row.stored_blob_hash);
        const ext = row.extension == null ? null : String(row.extension);
        const mime = row.mime_type == null ? null : String(row.mime_type);
        if (!hash || !ext || !mime) {
          // The join found a link whose current generation is missing/not
          // available — a broken relation, not a verification failure.
          return { kind: 'integrity_error', code: 'MEDIA_GENERATION_UNAVAILABLE', mediaId };
        }
        let bytes: Uint8Array;
        try {
          const read = await this.gateway.readVerifiedMedia({
            tenantScope: this.tenantId,
            hash,
            extension: ext,
          });
          if (
            read.hash !== hash ||
            read.byte_size !== Number(row.byte_size) ||
            read.mime_type !== mime ||
            read.extension !== ext
          ) {
            return { kind: 'integrity_error', code: 'MEDIA_VERIFICATION_MISMATCH', mediaId };
          }
          bytes = read.bytes;
        } catch (e) {
          const code = (e as { message?: string })?.message ?? 'MEDIA_READ_FAILED';
          return { kind: 'integrity_error', code, mediaId };
        }
        items.push({
          bytes,
          mimeType: mime,
          mediaId,
          sortOrder: Number(row.sort_order),
          isPrimary: Number(row.is_primary) === 1,
        });
      }
      return { kind: 'media', items };
    }
  }

  /** Convenience: just the primary entry of a resolved gallery. */
  async resolvePrimaryProductMedia(
    productId: string,
  ): Promise<ProductMediaResolution> {
    const r = await this.resolveProductMedia(productId);
    if (r.kind === 'media') {
      const primary = r.items.find((i) => i.isPrimary);
      // inspectGallery already guaranteed exactly one primary at sort 0.
      return primary ? { kind: 'media', items: [primary] } : { kind: 'conflict', code: 'MEDIA_GALLERY_NO_PRIMARY' };
    }
    if (r.kind === 'legacy') {
      return { kind: 'legacy', items: r.items.slice(0, 1) };
    }
    return r;
  }

  // ── queries ──────────────────────────────────────────────────────────────

  /**
   * Active links joined down to the CURRENT, AVAILABLE blob generation.
   *
   * Every relation is filtered on its own liveness flag:
   *   media_links.deleted_at IS NULL
   *   media_objects.deleted_at IS NULL
   *   media_blobs.blob_status = 'present' AND deleted_at IS NULL
   *   generation = media_blobs.current_generation_no AND gen_status='available'
   *
   * A LEFT JOIN is deliberate: a link whose generation is gone must surface as
   * an integrity error, not silently vanish from the result set.
   */
  private activeGallery(db: RawDb, productId: string): Array<Record<string, unknown>> {
    return allRows(
      db,
      `SELECT l.link_id, l.media_id, l.sort_order, l.is_primary,
              g.stored_blob_hash, g.extension, g.mime_type, g.byte_size
         FROM media_links l
         JOIN media_objects o
           ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
          AND o.deleted_at IS NULL
         LEFT JOIN media_blobs b
           ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
          AND b.deleted_at IS NULL AND b.blob_status = 'present'
         LEFT JOIN media_blob_generations g
           ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id
          AND g.generation_no = b.current_generation_no
          AND g.gen_status = 'available' AND g.deleted_at IS NULL
        WHERE l.tenant_id = $t
          AND l.scope_kind = 'branch' AND l.branch_id = $br
          AND l.entity_type = 'product' AND l.entity_id = $p
          AND l.media_role = $role
          AND l.deleted_at IS NULL
        ORDER BY l.sort_order ASC`,
      { $t: this.tenantId, $br: this.branchId, $p: productId, $role: this.role },
    );
  }

  /**
   * The raw `result_json` of every NON-TERMINAL ingest job for this
   * product/scope — the create-batch leaves N `accepted` jobs between the
   * durable checkpoint and full publication. Handed to `classifyPendingIngest`
   * so the resolver can tell an in-flight create-batch (→ pending) apart from a
   * pending replace / single append (→ existing gallery stays visible) and from
   * contradictory batches (→ conflict). Once every job is `ready` (or terminally
   * failed) this is empty and the active gallery is authoritative.
   */
  private nonTerminalIntents(db: RawDb, productId: string): unknown[] {
    const rows = allRows(
      db,
      `SELECT result_json FROM media_ingest_jobs
        WHERE tenant_id = $t AND branch_id = $br
          AND requested_entity_type = 'product' AND requested_entity_id = $p
          AND requested_role = $role
          AND state NOT IN ('ready','failed','quarantined','expired')`,
      { $t: this.tenantId, $br: this.branchId, $p: productId, $role: this.role },
    );
    return rows.map((r) => r.result_json);
  }

  /**
   * Any link row at all for THIS scope — active OR retired. Scope-bound so a
   * foreign branch's link can never suppress this branch's legacy column
   * (migration state is per tenant+branch+product+role).
   */
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

  /**
   * Raw `products.images`. `undefined` when no product row matches the FULL
   * scope of this resolver.
   *
   * `products` carries no `tenant_id` column — tenancy is reachable only via
   * `branches.tenant_id`. Filtering on `branch_id` alone would therefore hand
   * a resolver configured for tenant B the legacy images of tenant A's
   * product whenever a branch id was mismatched, so the join to `branches` is
   * the tenant binding and is not optional.
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

// ── local query helpers (mirrors the coordinator's, kept private) ───────────

function paramsToPositional(
  sql: string,
  bound: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  const order: string[] = [];
  const compiled = sql.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
    order.push(m);
    return '?';
  });
  return { sql: compiled, values: order.map((k) => bound[k]) };
}

function firstRow(
  db: RawDb,
  sql: string,
  bound: Record<string, unknown>,
): Record<string, unknown> | null {
  const { sql: compiled, values } = paramsToPositional(sql, bound);
  const rows = db.exec(compiled, values);
  if (rows.length === 0 || rows[0].values.length === 0) return null;
  return zip(rows[0].columns, rows[0].values[0]);
}

function allRows(
  db: RawDb,
  sql: string,
  bound: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const { sql: compiled, values } = paramsToPositional(sql, bound);
  const rows = db.exec(compiled, values);
  if (rows.length === 0) return [];
  return rows[0].values.map((v) => zip(rows[0].columns, v));
}

function zip(columns: string[], values: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
  return out;
}
