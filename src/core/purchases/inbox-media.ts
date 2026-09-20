// ════════════════════════════════════════════════════════════════════════════
// MEDIA-INBOX — das Foto im Einkaufs-Posteingang, im generischen Medienkern.
//
// Der Posteingang ist ein eigener Geschäftsdatensatz, kein Zwischenzustand einer Ablage: er hat
// eine Zeile, eine Filiale, einen Status, er wird auf dem Bildschirm angezeigt, verworfen oder zu
// einem Einkauf gemacht — und zwischen dem Aufnehmen am Telefon und dem Verarbeiten am Rechner
// können Tage liegen. Eine Zwischenablage darf so lange nichts halten; sie wird geräumt. Also
// bekommt er einen richtigen Besitzervertrag: `entityType = 'purchase_inbox'`, Rolle
// `intake_photo`, Klasse `internal`.
//
// `purchase_inbox.images` wird nicht mehr geschrieben. Die Liste bleibt als Altbestand lesbar
// (Einträge eines älteren Telefons) — und sobald ein Eintrag sein Foto über den Medienkern hat,
// wird sie in DERSELBEN Klammer geleert: sonst käme ein bewusst entferntes Bild zurück.
//
// Ein Posteingangsfoto ist AUSDRÜCKLICH kein Artikelbild. Es bekommt keine Artikel-Nebenwirkungen
// (kein Embedding), solange es hier hängt. Erst wenn daraus wirklich ein `stock_image` am Artikel
// wird (`adoptInboxPhotosToProduct`), gilt der bestehende Produktvertrag — und zwar er allein.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { MediaOwnerLinks } from '@/core/media/media-links';
import { resolveOwnerMedia, type OwnerMediaRef } from '@/core/media/owner-media-resolver';
import { ingestRecordPhotos, resolvePhotoSlots, type PhotoSlotRequest, type RecordPhotoScope } from '@/core/media/record-photo-media';
import type { MediaOwner } from '@/core/media/media-owner';
import type { StockMediaOrchestrator } from '@/core/media/orchestrator';

export const INBOX_MEDIA_ENTITY = 'purchase_inbox';
export const INBOX_MEDIA_ROLE = 'intake_photo';
/** Die Rolle, unter der dasselbe Medium später am ARTIKEL hängt (Produktvertrag, unverändert). */
export const PRODUCT_MEDIA_ROLE = 'stock_image';

export class InboxMediaError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'InboxMediaError';
  }
}

/** Gibt es den Medienkern in DIESER Datenbank? Eine fehlende Tabelle ist eine Antwort, kein Absturz. */
function mediaCoreAvailable(): boolean {
  return query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_links' LIMIT 1").length > 0;
}

export function inboxMediaScope(inboxId?: string): { tenantId: string; branchId: string } {
  let branchId = '';
  const row = inboxId ? query('SELECT branch_id FROM purchase_inbox WHERE id = ?', [inboxId])[0] : undefined;
  if (row?.branch_id) branchId = String(row.branch_id);
  if (!branchId) branchId = currentBranchId();
  const t = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId])[0];
  return { tenantId: String(t?.tenant_id ?? 'tenant-1'), branchId };
}

export function inboxMediaOwner(inboxId: string, scope = inboxMediaScope(inboxId)): MediaOwner {
  return {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: INBOX_MEDIA_ENTITY, entityId: inboxId, role: INBOX_MEDIA_ROLE, securityClass: 'internal',
  };
}

export function inboxPhotoScope(scope = inboxMediaScope(), orchestrator?: StockMediaOrchestrator): RecordPhotoScope {
  return { tenantId: scope.tenantId, branchId: scope.branchId, ownerType: INBOX_MEDIA_ENTITY, role: INBOX_MEDIA_ROLE, orchestrator };
}

/** Aufnehmen VOR der Klammer: aus Daten-URLs werden geprüfte, noch unverknüpfte Objekte. */
export function ingestInboxPhotos(
  urls: readonly string[], orchestrator?: StockMediaOrchestrator, inboxId?: string,
): Promise<string[]> {
  return ingestRecordPhotos(urls, inboxPhotoScope(inboxMediaScope(inboxId), orchestrator));
}

/** Dasselbe für einen Plan aus behaltenen Medien und neuen Aufnahmen. */
export function resolveInboxPhotoSlots(
  slots: readonly PhotoSlotRequest[], orchestrator?: StockMediaOrchestrator, inboxId?: string,
): Promise<string[]> {
  return resolvePhotoSlots(slots, inboxPhotoScope(inboxMediaScope(inboxId), orchestrator));
}

/**
 * Das Foto INNERHALB der laufenden Geschäftstransaktion an den Eintrag hängen.
 *
 * Der Eintrag ist gerade entstanden; seine Zeile IST die Änderung, also keine zweite Fassung
 * (der Posteingang führt ohnehin keine). Scheitert etwas, nimmt die Klammer beides zurück: es gibt
 * keinen halben Eintrag und keine halbe Verknüpfung. Das schon aufgenommene, unverknüpfte Objekt
 * bleibt liegen — genau so, wie der bestehende GC-Vertrag es vorsieht.
 */
export function applyInboxGallery(
  inboxId: string, mediaIds: readonly string[], opts: { bumpOwner?: boolean } = {},
): { changed: boolean } {
  if (!mediaCoreAvailable()) {
    if (mediaIds.length === 0) return { changed: false };
    throw new InboxMediaError('MEDIA_CORE_MISSING', 'this database has no media store — photos cannot be saved');
  }
  const links = new MediaOwnerLinks(getDatabase() as never);
  try {
    const r = links.setGallery(inboxMediaOwner(inboxId), mediaIds, { bumpOwner: opts.bumpOwner ?? false });
    clearLegacyInboxImages(inboxId);
    return { changed: r.changed };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'MEDIA_LINK_OBJECT_NOT_READY') {
      throw new InboxMediaError('PHOTO_NOT_FOUND', 'this intake photo is not available (any more)');
    }
    if (typeof code === 'string' && code.startsWith('MEDIA_')) throw new InboxMediaError(code, (e as Error).message);
    throw e;
  }
}

/** ALTBESTAND — die alte Bilderliste leeren, sobald der Eintrag sein Foto im Medienkern hat. */
function clearLegacyInboxImages(inboxId: string): void {
  getDatabase().run(
    "UPDATE purchase_inbox SET images = '[]' WHERE id = ? AND COALESCE(images, '') NOT IN ('', '[]')",
    [inboxId],
  );
}

/** Die Fotos eines Eintrags (geordnet) — Referenzen, keine Bytes. */
export function inboxPhotoRefs(inboxId: string): OwnerMediaRef[] {
  return inboxPhotoRefsFor([inboxId]).get(inboxId) ?? [];
}

/** Dieselbe Auskunft für viele Einträge — EINE Abfrage (die Liste bleibt eine Liste). */
export function inboxPhotoRefsFor(inboxIds: readonly string[], branchId?: string): Map<string, OwnerMediaRef[]> {
  if (!mediaCoreAvailable()) return new Map(inboxIds.map((id) => [id, []]));
  const scope = inboxMediaScope();
  return resolveOwnerMedia(getDatabase() as never, {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: branchId ?? scope.branchId,
    entityType: INBOX_MEDIA_ENTITY, role: INBOX_MEDIA_ROLE, entityIds: [...inboxIds],
  });
}

export function inboxGalleryMediaIds(inboxId: string): string[] {
  return inboxPhotoRefs(inboxId).map((r) => r.mediaId);
}

/** Der Altbestand eines Eintrags von früher — gelesen, nie neu geschrieben. */
export function legacyInboxImages(inboxId: string): string[] {
  const row = query('SELECT images FROM purchase_inbox WHERE id = ?', [inboxId])[0];
  try {
    const list = JSON.parse(String(row?.images ?? '[]'));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/**
 * MEDIA-INBOX §6 — aus dem Posteingangsfoto wird ein Artikelbild.
 *
 * DASSELBE Medienobjekt bekommt eine neue, fachlich richtige Verknüpfung am Artikel: Rolle
 * `stock_image`, Klasse auf beiden Seiten `internal` — kein stiller Klassenwechsel, und der
 * Verknüpfungsvertrag würde ihn ohnehin abweisen. Kein erneutes Codieren, keine zweite Datei.
 *
 * Die Verknüpfung am Posteingang wird danach still gelegt: der Eintrag ist verarbeitet, sein Zweck
 * erfüllt, und ein Foto, das an zwei Orten „aktuell" ist, wäre zwei Wahrheiten. Die Zeile bleibt
 * als Nachweis stehen (bestehender Lebenszyklus), das Objekt sowieso.
 *
 * Ab hier ist es Artikelmedium — und ab hier, und keinen Moment früher, gilt für Embedding und
 * alles Weitere der bestehende Produktvertrag.
 */
export function adoptInboxPhotosToProduct(inboxId: string, productId: string): { linked: number } {
  const mediaIds = inboxGalleryMediaIds(inboxId);
  if (mediaIds.length === 0) return { linked: 0 };
  const scope = inboxMediaScope(inboxId);
  const links = new MediaOwnerLinks(getDatabase() as never);
  const product: MediaOwner = {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: 'product', entityId: productId, role: PRODUCT_MEDIA_ROLE, securityClass: 'internal',
  };
  const vorhanden = resolveOwnerMedia(getDatabase() as never, {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: 'product', role: PRODUCT_MEDIA_ROLE, entityIds: [productId],
  }).get(productId) ?? [];
  const ziel = [...vorhanden.map((r) => r.mediaId)];
  for (const m of mediaIds) if (!ziel.includes(m)) ziel.push(m);
  // Der Artikel ist gerade entstanden oder wird ohnehin geschrieben — keine zusätzliche Fassung.
  links.setGallery(product, ziel, { bumpOwner: false });
  links.setGallery(inboxMediaOwner(inboxId, scope), [], { bumpOwner: false });
  return { linked: mediaIds.length };
}

export type { PhotoSlotRequest };
