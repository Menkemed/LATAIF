// Duplikat-Zusammenführung (`productStore.mergeIntoExisting`): die Galerie des gelöschten Artikels
// lebt seit dem Medienkern in `media_links`, nicht mehr in `products.images`. Ohne diesen Schritt
// verschwänden die Fotos des Quell-Artikels mit seiner Zeile. Dieselbe Regel wie früher für die
// Bildspalte: hat das Ziel noch keine Fotos, übernimmt es die der Quelle — dieselben Medienobjekte,
// neue Verknüpfung, keine zweite Datei. Die Verknüpfungen der Quelle werden danach zurückgezogen.
import { query } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { MediaOwnerLinks } from '@/core/media/media-links';
import { resolveOwnerMedia } from '@/core/media/owner-media-resolver';
import type { MediaOwner } from '@/core/media/media-owner';

const PRODUCT_MEDIA_ROLE = 'stock_image';

function productOwner(productId: string): MediaOwner | null {
  const row = query('SELECT p.branch_id, b.tenant_id FROM products p JOIN branches b ON b.id = p.branch_id WHERE p.id = ?', [productId])[0];
  if (!row?.branch_id) return null;
  return {
    tenantId: String(row.tenant_id ?? 'tenant-1'), scopeKind: 'branch', branchId: String(row.branch_id),
    entityType: 'product', entityId: productId, role: PRODUCT_MEDIA_ROLE, securityClass: 'internal',
  };
}

function galleryIds(owner: MediaOwner): string[] {
  return (resolveOwnerMedia(getDatabase() as never, {
    tenantId: owner.tenantId, scopeKind: 'branch', branchId: owner.branchId,
    entityType: 'product', role: PRODUCT_MEDIA_ROLE, entityIds: [owner.entityId],
  }).get(owner.entityId) ?? []).map((r) => r.mediaId);
}

/** VOR dem Löschen der Quelle aufrufen. Gibt die Zahl der übernommenen Fotos zurück. */
export function mergeProductGallery(sourceId: string, targetId: string): number {
  const source = productOwner(sourceId);
  const target = productOwner(targetId);
  if (!source || !target || source.tenantId !== target.tenantId || source.branchId !== target.branchId) return 0;
  const fromSource = galleryIds(source);
  if (fromSource.length === 0) return 0;
  const links = new MediaOwnerLinks(getDatabase() as never);
  let moved = 0;
  if (galleryIds(target).length === 0) {
    links.setGallery(target, fromSource, { bumpOwner: false });
    moved = fromSource.length;
  }
  links.setGallery(source, [], { bumpOwner: false });
  return moved;
}
