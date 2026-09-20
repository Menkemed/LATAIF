// ════════════════════════════════════════════════════════════════════════════
// MEDIA-ORDER — die Referenzfotos eines Sonderauftrags im generischen Medienkern.
//
// Was ein Auftrag an Bildern hat, ist genau eines: die Vorlage des Sonderstücks, die beim Anlegen
// mitgegeben wird (`customProductSpec.images`). Es gibt heute KEIN Ändern dieser Bilder danach —
// die Maske bietet es nicht an, und die Hausfunktion `updateOrderInHouse` fasst das Schema gar
// nicht an. Hier wird deshalb nichts erfunden: aufnehmen beim Anlegen, ansehen, und beim Umwandeln
// in einen Artikel weiterverwenden.
//
// Der Auftrag ist ein Medienbesitzer wie jeder andere (MEDIA-S2): `entityType = 'order'`, Rolle
// `reference_image`, Klasse `internal`. Die Bilder sind eine Vorlage, kein Warenbild — deshalb eine
// eigene Rolle und nicht `stock_image`: solange sie am Auftrag hängen, sind sie kein Artikelbild
// und bekommen auch keine Artikel-Nebenwirkungen (kein Embedding).
//
// `orders.custom_product_spec.images` wird nicht mehr geschrieben. Die Liste bleibt als Altbestand
// lesbar (Aufträge von früher) — und sobald ein Auftrag seine Vorlage über den Medienkern setzt,
// wird sie in DERSELBEN Klammer geleert: sonst käme ein bewusst entferntes Bild beim nächsten
// Lesen aus dem Schema zurück.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { MediaOwnerLinks } from '@/core/media/media-links';
import { resolveOwnerMedia, type OwnerMediaRef } from '@/core/media/owner-media-resolver';
import { ingestRecordPhotos, resolvePhotoSlots, type PhotoSlotRequest, type RecordPhotoScope } from '@/core/media/record-photo-media';
import type { MediaOwner } from '@/core/media/media-owner';
import type { StockMediaOrchestrator } from '@/core/media/orchestrator';
import { OrderActionRejected } from '@/core/orders/order-create';

export const ORDER_MEDIA_ENTITY = 'order';
export const ORDER_MEDIA_ROLE = 'reference_image';
/** Die Rolle, unter der dasselbe Medium später am ARTIKEL hängt (Produktvertrag, unverändert). */
export const PRODUCT_MEDIA_ROLE = 'stock_image';

/** Mandant und Filiale dieses Auftrags — die Filiale entscheidet, wer ihn sehen darf. */
export function orderMediaScope(orderId?: string): { tenantId: string; branchId: string } {
  let branchId = '';
  const row = orderId ? query('SELECT branch_id FROM orders WHERE id = ?', [orderId])[0] : undefined;
  if (row?.branch_id) branchId = String(row.branch_id);
  if (!branchId) branchId = currentBranchId();
  const t = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId])[0];
  return { tenantId: String(t?.tenant_id ?? 'tenant-1'), branchId };
}

export function orderMediaOwner(orderId: string, scope = orderMediaScope(orderId)): MediaOwner {
  return {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: ORDER_MEDIA_ENTITY, entityId: orderId, role: ORDER_MEDIA_ROLE, securityClass: 'internal',
  };
}

export function orderPhotoScope(scope = orderMediaScope(), orchestrator?: StockMediaOrchestrator): RecordPhotoScope {
  return { tenantId: scope.tenantId, branchId: scope.branchId, ownerType: ORDER_MEDIA_ENTITY, role: ORDER_MEDIA_ROLE, orchestrator };
}

/** Aufnehmen VOR der Klammer: aus Daten-URLs werden geprüfte, noch unverknüpfte Objekte. */
export function ingestOrderPhotos(
  urls: readonly string[], orchestrator?: StockMediaOrchestrator, orderId?: string,
): Promise<string[]> {
  return ingestRecordPhotos(urls, orderPhotoScope(orderMediaScope(orderId), orchestrator));
}

/** Dasselbe für einen Plan aus behaltenen Medien und neuen Aufnahmen. */
export function resolveOrderPhotoSlots(
  slots: readonly PhotoSlotRequest[], orchestrator?: StockMediaOrchestrator, orderId?: string,
): Promise<string[]> {
  return resolvePhotoSlots(slots, orderPhotoScope(orderMediaScope(orderId), orchestrator));
}

/**
 * Die Vorlage des Auftrags INNERHALB der laufenden Geschäftstransaktion setzen.
 *
 * Wie bei der Reparatur: eine fachliche Änderung, eine Fassung. Beim Anlegen schreibt die
 * Auftragszeile sich selbst, also zählt sie — der Helfer nicht (`bumpOwner: false`).
 */
export function applyOrderGallery(
  orderId: string, mediaIds: readonly string[], opts: { bumpOwner?: boolean } = {},
): { changed: boolean } {
  const links = new MediaOwnerLinks(getDatabase() as never);
  try {
    const r = links.setGallery(orderMediaOwner(orderId), mediaIds, { bumpOwner: opts.bumpOwner ?? false });
    clearLegacySpecImages(orderId);
    return { changed: r.changed };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'MEDIA_LINK_OBJECT_NOT_READY') {
      throw new OrderActionRejected('PHOTO_NOT_FOUND', 'this reference photo is not available (any more)');
    }
    if (typeof code === 'string' && code.startsWith('MEDIA_')) {
      throw new OrderActionRejected(code, (e as Error).message);
    }
    throw e;
  }
}

/**
 * ALTBESTAND — die Bilderliste im gespeicherten Schema leeren, sobald der Auftrag seine Vorlage im
 * Medienkern hat. Alles andere am Schema (Kategorie, Merkmale, Steuerart …) bleibt unberührt: es
 * ist der eingefrorene Entwurf des Sonderstücks und wird hier nicht neu gedacht.
 */
function clearLegacySpecImages(orderId: string): void {
  const row = query('SELECT custom_product_spec FROM orders WHERE id = ?', [orderId])[0];
  const raw = row?.custom_product_spec;
  if (typeof raw !== 'string' || !raw.includes('"images"')) return;
  let spec: Record<string, unknown>;
  try { spec = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
  if (!Array.isArray(spec.images) || spec.images.length === 0) return;
  spec.images = [];
  getDatabase().run('UPDATE orders SET custom_product_spec = ? WHERE id = ?', [JSON.stringify(spec), orderId]);
}

/** Die Vorlagenbilder eines Auftrags (geordnet) — Referenzen, keine Bytes. */
export function orderPhotoRefs(orderId: string): OwnerMediaRef[] {
  const scope = orderMediaScope(orderId);
  return resolveOwnerMedia(getDatabase() as never, {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: ORDER_MEDIA_ENTITY, role: ORDER_MEDIA_ROLE, entityIds: [orderId],
  }).get(orderId) ?? [];
}

/** Dieselbe Auskunft für viele Aufträge — EINE Abfrage (Listen bleiben Listen). */
export function orderPhotoRefsFor(orderIds: readonly string[], branchId?: string): Map<string, OwnerMediaRef[]> {
  const scope = orderMediaScope();
  return resolveOwnerMedia(getDatabase() as never, {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: branchId ?? scope.branchId,
    entityType: ORDER_MEDIA_ENTITY, role: ORDER_MEDIA_ROLE, entityIds: [...orderIds],
  });
}

export function orderGalleryMediaIds(orderId: string): string[] {
  return orderPhotoRefs(orderId).map((r) => r.mediaId);
}

/** Der Altbestand eines Auftrags von früher — gelesen, nie neu geschrieben. */
export function legacyOrderSpecImages(orderId: string): string[] {
  const row = query('SELECT custom_product_spec FROM orders WHERE id = ?', [orderId])[0];
  const raw = row?.custom_product_spec;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const spec = JSON.parse(raw) as { images?: unknown };
    return Array.isArray(spec.images) ? spec.images.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/**
 * MEDIA-ORDER §7 — aus der Vorlage wird ein Artikelbild.
 *
 * Wenn der Auftrag zu einem Artikel wird, bekommt der Artikel GENAU DIESELBEN Medien — über eine
 * neue, legitime Verknüpfung, nicht über eine zweite Datei: dieselben Bytes, dasselbe Objekt, eine
 * andere Rolle. Die Klasse ist auf beiden Seiten `internal`, also gibt es keinen stillen
 * Klassenwechsel; der Verknüpfungsvertrag würde ihn ohnehin abweisen.
 *
 * Die Verknüpfung am Auftrag bleibt bestehen: der Auftrag hat sein Sonderstück nun einmal so
 * beschrieben, und das ist nach der Umwandlung nicht weniger wahr.
 *
 * Ab diesem Moment ist es Artikelmedium — und damit gilt für Embedding und alles Weitere der
 * bestehende Produktvertrag, nicht dieser hier.
 */
export function adoptOrderPhotosToProduct(orderId: string, productId: string): { linked: number } {
  const mediaIds = orderGalleryMediaIds(orderId);
  if (mediaIds.length === 0) return { linked: 0 };
  const scope = orderMediaScope(orderId);
  const links = new MediaOwnerLinks(getDatabase() as never);
  const owner: MediaOwner = {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: 'product', entityId: productId, role: PRODUCT_MEDIA_ROLE, securityClass: 'internal',
  };
  // Der Artikel ist gerade entstanden; seine Zeile IST die Änderung, also keine zusätzliche Fassung.
  links.setGallery(owner, mediaIds, { bumpOwner: false });
  return { linked: mediaIds.length };
}

export type { PhotoSlotRequest };
