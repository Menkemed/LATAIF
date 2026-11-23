// ═════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN — die Anschlüsse der Oberfläche. Am Primary läuft die Hausfolge exklusiv in EINER Transaktion und wird
// danach durabel gespeichert (`runOnPrimary`); am PC2 schickt dieselbe Maske den Fernauftrag (`useSharedWrites`), der am
// Primary DIESELBE Hausfolge fährt. Lesen der Bildfolge: lokal aus der Datenbank, am PC2 über `products.get`.
// ═════════════════════════════════════════════════════════════════

import { currentBranchId, currentUserId, query } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { fetchFromPrimary, readsFromPrimary } from '@/core/data/primary-source';
import { useAuthStore } from '@/stores/authStore';
import { useProductStore } from '@/stores/productStore';
import {
  activeGallery, groupProductsInHouse, mergeModelPhotosInHouse, removeFromModelInHouse,
  type GroupInput, type GroupResult, type MergePhotosInput, type MergePhotosResult, type ProductModelCtx,
  type RemoveInput, type RemoveResult,
} from './product-models';

function localCtx(): ProductModelCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role ?? null };
}
const reload = (): void => { useProductStore.getState().loadProducts(); };

export function groupProductsOnPrimary(input: GroupInput): Promise<GroupResult> {
  return runOnPrimary(() => groupProductsInHouse(input, localCtx()), reload);
}
export function removeFromModelOnPrimary(input: RemoveInput): Promise<RemoveResult> {
  return runOnPrimary(() => removeFromModelInHouse(input, localCtx()), reload);
}
export function mergeModelPhotosOnPrimary(input: MergePhotosInput): Promise<MergePhotosResult> {
  return runOnPrimary(() => mergeModelPhotosInHouse(input, localCtx()), reload);
}

/** Die aktive Bildfolge (Medienkennungen, Hauptbild zuerst) und die Fassung eines Artikels — Primary lokal, PC2 über den Primary. */
export async function loadVariantGallery(productId: string): Promise<{ mediaIds: string[]; updatedAt: string; legacy: boolean } | null> {
  if (readsFromPrimary()) {
    const d = await fetchFromPrimary('products.get', { id: productId });
    if (!d) return null;
    return {
      mediaIds: Array.isArray(d.mediaIds) ? (d.mediaIds as unknown[]).map(String) : [],
      updatedAt: String(d.updatedAt ?? ''),
      // Der Primary prüft das Altformat ohnehin; hier nur ein Hinweis, falls bekannt.
      legacy: false,
    };
  }
  const r = query('SELECT updated_at, images FROM products WHERE id = ?', [productId])[0];
  if (!r) return null;
  let legacy = false;
  try { const a = JSON.parse(String(r.images ?? '[]')); legacy = Array.isArray(a) && a.length > 0; } catch { legacy = true; }
  return { mediaIds: activeGallery(productId, currentBranchId()), updatedAt: String(r.updated_at ?? ''), legacy };
}
