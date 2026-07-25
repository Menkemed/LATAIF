// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2B-R4 — durable embedding reconciliation.
//
// The completed-products hook of a single recovery pass is TRANSIENT: it only
// fires for batches finalized in THAT pass, and only if the store was already
// registered to receive it. Two gaps stay open:
//   • recovery ran before the store registered its hook → the completion is
//     never delivered;
//   • the process crashed after the media became `ready` but before the
//     embedding was computed → no pass will ever "complete" that batch again.
//
// This module closes both by asking the DB directly, on every startup, which
// products have a COMPLETE media gallery but NO embedding yet. It is a pure,
// read-only query — the caller feeds each scope to the existing embedding guard
// (durable `image_embedding` marker + in-flight set), so running it repeatedly
// is safe and at-most-once per product. No stronger exactly-once claim.
//
// STRICTLY READ-ONLY. No INSERT/UPDATE/DELETE, no image bytes, no logging of
// product ids or names.
// ════════════════════════════════════════════════════════════════════════════

import type { CompletedProductScope } from './startup-recovery.ts';

interface RawDb {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

const DEFAULT_ROLE = 'stock_image';

/**
 * Every product whose stock-image gallery is COMPLETE (a live primary link, no
 * pending ingest) and cutover-visible (`products.images` cleared) yet still
 * carries no `image_embedding`. Bound to the stock-image role — that is the
 * only role a product embedding is derived from.
 *
 *   • `products.images` cleared      → the media gallery is the visible one
 *   • is_primary link, deleted_at IS NULL → a real, complete gallery exists
 *   • NOT EXISTS a non-terminal ingest → the batch is fully settled
 *   • image_embedding NULL/empty     → the embedding still has to be computed
 *
 * `products` has no tenant column — tenancy comes via `branches.tenant_id`, so
 * the join to `branches` is the tenant binding (never the product id alone).
 */
export function findProductsNeedingEmbedding(
  db: RawDb,
  role: string = DEFAULT_ROLE,
): CompletedProductScope[] {
  const res = db.exec(
    `SELECT b.tenant_id AS t, p.branch_id AS br, p.id AS pid, l.media_role AS role
       FROM products p
       JOIN branches b ON b.id = p.branch_id
       JOIN media_links l
         ON l.tenant_id = b.tenant_id AND l.branch_id = p.branch_id
        AND l.entity_type = 'product' AND l.entity_id = p.id
        AND l.media_role = ? AND l.is_primary = 1 AND l.deleted_at IS NULL
      WHERE (p.images IS NULL OR TRIM(p.images) = '' OR p.images = '[]')
        AND (p.image_embedding IS NULL OR p.image_embedding = '')
        AND NOT EXISTS (
          SELECT 1 FROM media_ingest_jobs j
           WHERE j.tenant_id = b.tenant_id AND j.branch_id = p.branch_id
             AND j.requested_entity_type = 'product' AND j.requested_entity_id = p.id
             AND j.requested_role = l.media_role
             AND j.state NOT IN ('ready','failed','quarantined','expired')
        )`,
    [role],
  );
  if (res.length === 0) return [];
  const { columns, values } = res[0];
  const ti = columns.indexOf('t');
  const bi = columns.indexOf('br');
  const pi = columns.indexOf('pid');
  const ri = columns.indexOf('role');
  return values.map((v) => ({
    tenantId: String(v[ti]),
    branchId: v[bi] == null ? null : String(v[bi]),
    productId: String(v[pi]),
    role: String(v[ri]),
  }));
}
