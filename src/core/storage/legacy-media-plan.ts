// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §9 — legacy media migration PLANNER (pure, read-only dry-run).
//
// Answers "what would a bulk cutover do?" without touching a single row: which
// products still carry their photos inline in `products.images`, how many images
// that is, how many bytes the column holds, and which entries are NOT safely
// migratable (so they are reported instead of silently dropped).
//
// Deliberately does NOT decode the base64 payloads. A dry-run over a legacy
// install would otherwise materialise every image in memory (the exact heap
// pressure this slice exists to remove); the decoded size of a base64 payload is
// arithmetic, and shape validation is a cheap charset check. The real decode
// happens once, per product, inside the cutover service — which refuses the
// whole product before creating any link if an entry is bad.
//
// Read-only and side-effect free: no writes, no orchestrator, no persistence.
// NEVER returns or logs image bytes — counts, byte totals and ids only.
// ════════════════════════════════════════════════════════════════════════════

import { parseLegacyImages } from '../media/product-media-resolver.ts';

export interface PlanRawDb {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export interface LegacyMediaScope {
  tenantId: string;
  branchId: string;
  role?: string;
}

export type LegacyItemState =
  /** legacy column populated and every entry is a decodable data: URL → migrate */
  | 'migratable'
  /** legacy already cleared and link history exists → nothing to do */
  | 'already_migrated'
  /** no legacy payload and no link history → product simply has no photo */
  | 'no_images'
  /** legacy payload present but not safely migratable → reported, never touched */
  | 'unsupported';

export interface LegacyMediaPlanItem {
  productId: string;
  state: LegacyItemState;
  /** decodable legacy entries (0 unless state is 'migratable') */
  legacyCount: number;
  /** raw byte length of the `products.images` column for this product */
  legacyColumnBytes: number;
  /** decoded image bytes the migration will write as blobs (arithmetic, not decoded) */
  decodedBytes: number;
  /** active gallery links that already exist for this product */
  activeLinks: number;
  /** stable reason code for 'unsupported' — never contains image data */
  reason?: string;
}

export interface LegacyMediaPlan {
  scannedProducts: number;
  migratable: number;
  alreadyMigrated: number;
  noImages: number;
  unsupported: number;
  /** images that would be imported across all migratable products */
  legacyImageCount: number;
  /** bytes currently held by `products.images` on migratable products — this is
   *  the amount the products table demonstrably loses; changelog/audit history is
   *  NOT included because migration never rewrites history. */
  reclaimableColumnBytes: number;
  /** decoded bytes the blob store will gain (base64 carries ~33% overhead) */
  decodedBytes: number;
  items: LegacyMediaPlanItem[];
}

const DEFAULT_ROLE = 'stock_image';
const DATA_URL_HEAD = /^data:([^;,]*)(;base64)?,/;
const BASE64_BODY = /^[A-Za-z0-9+/\r\n\s]*={0,2}$/;

/** Decoded length of a base64 payload without allocating it. */
export function base64DecodedLength(payload: string): number {
  let len = 0, pad = 0;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue; // skip whitespace
    len++;
    if (payload[i] === '=') pad++;
  }
  return Math.max(0, Math.floor(len * 3 / 4) - pad);
}

/**
 * Shape-check ONE legacy entry the same way the cutover decoder would, without
 * decoding it. Returns the decoded byte size, or a stable reason code.
 */
export function classifyLegacyEntry(src: unknown): { ok: true; bytes: number } | { ok: false; reason: string } {
  if (typeof src !== 'string') return { ok: false, reason: 'LEGACY_ENTRY_NOT_A_STRING' };
  if (src.length === 0) return { ok: false, reason: 'LEGACY_ENTRY_EMPTY' };
  const head = DATA_URL_HEAD.exec(src);
  if (!head) return { ok: false, reason: 'LEGACY_ENTRY_NOT_A_DATA_URL' };
  const body = src.slice(head[0].length);
  if (body.length === 0) return { ok: false, reason: 'LEGACY_ENTRY_EMPTY' };
  if (!head[2]) {
    // A non-base64 data: URL is decodable (percent-encoded text) but is never an
    // image in this data set. Refuse rather than guess.
    return { ok: false, reason: 'LEGACY_ENTRY_NOT_BASE64' };
  }
  if (!BASE64_BODY.test(body)) return { ok: false, reason: 'LEGACY_ENTRY_BASE64_INVALID' };
  const bytes = base64DecodedLength(body);
  if (bytes === 0) return { ok: false, reason: 'LEGACY_ENTRY_EMPTY' };
  return { ok: true, bytes };
}

function rows(db: PlanRawDb, sql: string, params: unknown[]): Array<Record<string, unknown>> {
  const res = db.exec(sql, params);
  if (res.length === 0) return [];
  return res[0].values.map((v) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < res[0].columns.length; i++) out[res[0].columns[i]] = v[i];
    return out;
  });
}

/**
 * Scan every product in scope and classify its image representation.
 *
 * Tenancy: `products` has no tenant_id, so the tenant binding is the join onto
 * `branches` — identical to the cutover service's own legacy read, so the plan
 * can never list a product the migration would then refuse to see.
 */
export function planLegacyMediaCutover(db: PlanRawDb, scope: LegacyMediaScope): LegacyMediaPlan {
  const role = scope.role ?? DEFAULT_ROLE;
  const products = rows(
    db,
    `SELECT p.id AS id, p.images AS images
       FROM products p
       JOIN branches b ON b.id = p.branch_id AND b.tenant_id = ?
      WHERE p.branch_id = ?
      ORDER BY p.id ASC`,
    [scope.tenantId, scope.branchId],
  );

  // One grouped pass for the link facts instead of two queries per product.
  const linkRows = rows(
    db,
    `SELECT entity_id AS id,
            SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
            COUNT(*) AS any_link
       FROM media_links
      WHERE tenant_id = ? AND scope_kind = 'branch' AND branch_id = ?
        AND entity_type = 'product' AND media_role = ?
      GROUP BY entity_id`,
    [scope.tenantId, scope.branchId, role],
  );
  const links = new Map<string, { active: number; any: number }>();
  for (const r of linkRows) {
    links.set(String(r.id), { active: Number(r.active) || 0, any: Number(r.any_link) || 0 });
  }

  const items: LegacyMediaPlanItem[] = [];
  let migratable = 0, alreadyMigrated = 0, noImages = 0, unsupported = 0;
  let legacyImageCount = 0, reclaimableColumnBytes = 0, decodedBytes = 0;

  for (const p of products) {
    const productId = String(p.id);
    const raw = p.images;
    const columnBytes = typeof raw === 'string' ? raw.length : 0;
    const link = links.get(productId) ?? { active: 0, any: 0 };

    const parsed = parseLegacyImages(raw);
    if (!parsed.ok) {
      unsupported++;
      items.push({
        productId, state: 'unsupported', legacyCount: 0, legacyColumnBytes: columnBytes,
        decodedBytes: 0, activeLinks: link.active, reason: parsed.code,
      });
      continue;
    }

    if (parsed.items.length === 0) {
      if (link.any > 0) {
        alreadyMigrated++;
        items.push({ productId, state: 'already_migrated', legacyCount: 0, legacyColumnBytes: columnBytes, decodedBytes: 0, activeLinks: link.active });
      } else {
        noImages++;
        items.push({ productId, state: 'no_images', legacyCount: 0, legacyColumnBytes: columnBytes, decodedBytes: 0, activeLinks: link.active });
      }
      continue;
    }

    // Legacy is populated → the cutover is unfinished for this product. Every
    // entry must be safely decodable; ONE bad entry makes the whole product
    // unsupported, exactly like the service (which aborts before any link).
    let bad: string | null = null;
    let bytes = 0;
    for (const src of parsed.items) {
      const c = classifyLegacyEntry(src);
      if (!c.ok) { bad = c.reason; break; }
      bytes += c.bytes;
    }
    if (bad) {
      unsupported++;
      items.push({ productId, state: 'unsupported', legacyCount: parsed.items.length, legacyColumnBytes: columnBytes, decodedBytes: 0, activeLinks: link.active, reason: bad });
      continue;
    }

    migratable++;
    legacyImageCount += parsed.items.length;
    reclaimableColumnBytes += columnBytes;
    decodedBytes += bytes;
    items.push({ productId, state: 'migratable', legacyCount: parsed.items.length, legacyColumnBytes: columnBytes, decodedBytes: bytes, activeLinks: link.active });
  }

  return {
    scannedProducts: products.length,
    migratable, alreadyMigrated, noImages, unsupported,
    legacyImageCount, reclaimableColumnBytes, decodedBytes,
    items,
  };
}
