// ═════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN — die Anschlüsse der Oberfläche. Am Primary läuft die Hausfolge exklusiv in EINER Transaktion und wird
// danach durabel gespeichert (`runOnPrimary`); am PC2 schickt dieselbe Maske den Fernauftrag (`useSharedWrites`), der am
// Primary DIESELBE Hausfolge fährt. Lesen der Bildfolge: lokal aus der Datenbank, am PC2 über `products.get`.
// ═════════════════════════════════════════════════════════════════

import { currentBranchId, currentUserId, query } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { readsFromPrimary } from '@/core/data/primary-source';
import { remoteRead } from '@/core/bridge/remote-read';
import { useAuthStore } from '@/stores/authStore';
import { cutoverLegacyGallery, useProductStore } from '@/stores/productStore';
import { runExclusiveUnless } from '@/core/bridge/command-scheduler';
import {
  activeGallery, attachNewVariantInHouse, checkVariantFits, groupProductsInHouse, legacyMergeTargets, mergeModelPhotosInHouse, ProductModelRejected,
  removeFromModelInHouse,
  type GroupInput, type GroupResult, type MergePhotosInput, type MergePhotosResult, type ProductModelCtx,
  type RemoveInput, type RemoveResult, type VariantIntent,
} from './product-models';
import type { Product } from '@/core/models/types';
import type { ProductCreateResult } from '@/core/media/product-media-create';
import { SKU_TAKEN, skuTakenMessage } from './sku-unique';

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
/**
 * „Merge Photos" mit Altbild-Zielen: deren eingebettete Bilder ziehen VORHER mit dem bestehenden Umzug in den Bildspeicher
 * (dieselben Bilder, dieselbe Reihenfolge, je Bild einmal normalisiert wie jedes Hochladen). Jeder Umzug sichert sich
 * selbst durabel und läuft deshalb AUSSERHALB der Merge-Transaktion — am PC2 als Vorschritt im schon exklusiven Platz des
 * Auftrags (`alreadySerialised`). Scheitert ein Umzug, bleibt dieser Artikel samt Altbild unverändert und der Merge wird
 * mit Grund abgelehnt; schon umgezogene Artikel bleiben umgezogen (gleiche Bilder, nichts verloren).
 */
export async function convertLegacyMergeTargets(input: MergePhotosInput, ctx: ProductModelCtx, alreadySerialised: boolean): Promise<string[]> {
  const ids = legacyMergeTargets(input, ctx);
  if (ids.length === 0) return [];
  const tenantId = String(query('SELECT tenant_id FROM branches WHERE id = ?', [ctx.branchId])[0]?.tenant_id ?? '');
  for (const id of ids) {
    try {
      if (!tenantId) throw new Error('MEDIA_CUTOVER_SCOPE_REQUIRED');
      await runExclusiveUnless(alreadySerialised, () => cutoverLegacyGallery(id, { tenantId, branchId: ctx.branchId }));
    } catch (e) {
      const name = String(query('SELECT name FROM products WHERE id = ?', [id])[0]?.name ?? id);
      const code = (e as { code?: string; message?: string })?.code ?? (e as { message?: string })?.message ?? 'MEDIA_CUTOVER_FAILED';
      throw new ProductModelRejected('MODEL_PHOTO_LEGACY_CONVERT_FAILED',
        `${name}: its photos in the old format could not be moved to the photo storage (${code}). Nothing was changed for this item — please try again.`);
    }
  }
  return ids;
}

export async function mergeModelPhotosOnPrimary(input: MergePhotosInput): Promise<MergePhotosResult> {
  await convertLegacyMergeTargets(input, localCtx(), false);
  return runOnPrimary(() => mergeModelPhotosInHouse(input, localCtx()), reload);
}

/**
 * „Add variant" am Primary: Anlage (derselbe Weg wie „New Item"), Zuordnung zum Modell und — auf Wunsch — Verweis auf das
 * Modellbild in EINER Transaktion. Gelingt ein Teil nicht, wird nichts angelegt (der PC2 fährt dieselbe Folge über
 * `products.create` mit `variant`). So bleibt nie ein Artikel still ohne seine Zuordnung.
 */
export function createVariantOnPrimary(data: Partial<Product>, intent: VariantIntent): Promise<ProductCreateResult> {
  return runOnPrimary(async () => {
    const ctx = localCtx();
    checkVariantFits(intent, { categoryId: String(data.categoryId ?? ''), brand: data.brand ?? '', attributes: (data.attributes ?? {}) as Record<string, unknown> }, ctx);
    const r = await useProductStore.getState().createProductWithMedia(data, undefined, undefined, undefined, { alreadySerialised: true });
    if (r.status !== 'created') {
      throw new ProductModelRejected(r.status === 'product_save_failed' && r.errorCode === SKU_TAKEN ? SKU_TAKEN : 'VARIANT_NOT_CREATED',
        r.status === 'product_save_failed' && r.errorCode === SKU_TAKEN
          ? skuTakenMessage(data.sku)
          : 'The item and its photos could not be saved completely — nothing was created. Please try again.');
    }
    attachNewVariantInHouse(r.productId, intent, ctx);
    return r;
  }, reload);
}

/** Die aktive Bildfolge (Medienkennungen, Hauptbild zuerst) und die Fassung eines Artikels — Primary lokal, PC2 über den Primary. */
export async function loadVariantGallery(productId: string): Promise<{ mediaIds: string[]; updatedAt: string; legacy: boolean } | null> {
  if (readsFromPrimary()) {
    // `products.get` antwortet mit den Feldern SELBST (wie in client-media-source), nicht in `{ data }` wie die
    // Store-Auskünfte — `fetchFromPrimary` hätte hier immer `null` geliefert (Merge photos am PC2 ohne Bilder).
    let d: Record<string, unknown>;
    try { d = await remoteRead<Record<string, unknown>>('products.get', { id: productId }); } catch { return null; }
    if (!d || typeof d !== 'object') return null;
    return {
      mediaIds: Array.isArray(d.mediaIds) ? (d.mediaIds as unknown[]).map(String) : [],
      updatedAt: String(d.updatedAt ?? ''),
      // Nur ein Hinweis für die Vorschau (ein Primary vor v0.8.110 nennt die Zahl nicht) — den Umzug entscheidet der Primary.
      legacy: Number(d.legacyPhotos ?? 0) > 0,
    };
  }
  const r = query('SELECT updated_at, images FROM products WHERE id = ?', [productId])[0];
  if (!r) return null;
  let legacy = false;
  try { const a = JSON.parse(String(r.images ?? '[]')); legacy = Array.isArray(a) && a.length > 0; } catch { legacy = true; }
  return { mediaIds: activeGallery(productId, currentBranchId()), updatedAt: String(r.updated_at ?? ''), legacy };
}
