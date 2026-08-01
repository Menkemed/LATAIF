// ════════════════════════════════════════════════════════════════════════════
// MEDIA-CONSUMERS-EXPORT — thin imperative primary-image resolver for exports.
//
// The Excel export historically embedded `products.images[0]` directly, so
// media-pipeline products (images='[]', photo in the content-addressed gallery)
// exported with a blank Image cell. This helper closes that gap the SAME way the
// collection thumbnail does — legacy column first (authoritative, zero gateway
// cost), else the canonical `ProductMediaResolver` primary — but returns raw
// bytes (never an Object-URL, so there is nothing to leak or revoke) suitable for
// ExcelJS `addImage({ buffer })`.
//
// READ-ONLY: it never writes the store/DB, never mutates products.images, never
// caches. Missing / pending / corrupt → returns null (caller keeps the row,
// omits the image). It changes NO resolver / lease / DB core behaviour.
// ════════════════════════════════════════════════════════════════════════════

import { getDatabase } from '@/core/db/database';
import { ProductMediaResolver } from '@/core/media/product-media-resolver';
import { TauriMediaGateway } from '@/core/media/gateway';
import {
  decodeImageDataUrl,
  atobToBytes,
  extFromMime,
  type ExportImage,
  type ExportMediaScope,
} from '@/core/media/product-image-export-core';

export type { ExportImage, ExportImageExt, ExportMediaScope } from '@/core/media/product-image-export-core';

const decodeDataUrl = (src: string | undefined): ExportImage | null => decodeImageDataUrl(src, atobToBytes);

/**
 * Resolve ONE product's primary image as embeddable bytes for an export.
 *
 * Order (mirrors the collection thumbnail's fail-closed decision):
 *   1. non-empty legacy column → decoded directly (no scope / gateway needed)
 *   2. empty column + authorised scope → canonical resolver primary:
 *        • media  → verified primary bytes
 *        • legacy → decoded data-URL (column already emptied but resolver still
 *                   reports legacy — decode its single item)
 *        • none / pending / conflict / integrity_error → null (skip image)
 *   3. no scope, empty column → null
 *
 * NEVER throws: a corrupt/unreadable image yields null so the caller keeps the
 * product row and continues the workbook.
 */
export async function resolvePrimaryImageForExport(
  product: { id: string; images?: string[] },
  scope: ExportMediaScope,
): Promise<ExportImage | null> {
  // 1. Legacy column is authoritative (resolver step 1) and needs no gateway.
  const legacy = decodeDataUrl(product.images?.[0]);
  if (legacy) return legacy;

  // 2. Empty column → media-pipeline product; resolve via the canonical path.
  if (!product.id || !scope.tenantId || !scope.branchId) return null;
  try {
    const resolver = new ProductMediaResolver({
      dbProvider: () => getDatabase() as never,
      gateway: new TauriMediaGateway(),
      tenantId: scope.tenantId,
      branchId: scope.branchId,
    });
    const r = await resolver.resolvePrimaryProductMedia(product.id);
    if (r.kind === 'media') {
      const prim = r.items.find((i) => i.isPrimary) ?? r.items[0];
      const extension = prim ? extFromMime(prim.mimeType) : null;
      if (!prim || !prim.bytes || !extension) return null;
      // Copy into a fresh plain-buffer view (SharedArrayBuffer-safe).
      return { bytes: new Uint8Array(prim.bytes), extension };
    }
    if (r.kind === 'legacy') return decodeDataUrl(r.items[0]);
    return null; // none / pending / conflict / integrity_error → skip cleanly
  } catch {
    // A single unreadable product must never abort the whole workbook.
    return null;
  }
}
