// ════════════════════════════════════════════════════════════════════════════
// MEDIA-REPAIR — die Fotos einer Reparatur im generischen Medienkern.
//
// Die Reparatur ist ein Medienbesitzer wie jeder andere: `entityType = 'repair'`, Rolle `gallery`,
// Klasse `internal`, mehrere Bilder in stabiler Reihenfolge. Alles Weitere macht der gemeinsame
// Kern (MEDIA-S2): `ingestObject` legt das geprüfte Objekt an, `MediaOwnerLinks.setGallery` hängt es
// in DERSELBEN Geschäftstransaktion an die Reparatur und erhöht deren Fassung genau einmal.
//
// `repairs.images` wird nicht mehr geschrieben. Die Spalte bleibt als Altbestand lesbar (alte
// Datenbanken), damit eine Reparatur von früher ihre Bilder behält.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { MediaOwnerLinks } from '@/core/media/media-links';
import { resolveOwnerMedia, type OwnerMediaRef } from '@/core/media/owner-media-resolver';
import { ingestRecordPhotos, resolvePhotoSlots, type PhotoSlotRequest, type RecordPhotoScope } from '@/core/media/record-photo-media';
import type { MediaOwner } from '@/core/media/media-owner';
import { RepairActionRejected } from '@/core/repairs/repair-rules';
import type { StockMediaOrchestrator } from '@/core/media/orchestrator';

export const REPAIR_MEDIA_ENTITY = 'repair';
export const REPAIR_MEDIA_ROLE = 'gallery';

/** Mandant und Filiale dieser Reparatur — die Filiale entscheidet, wer sie sehen darf. */
export function repairMediaScope(repairId?: string): { tenantId: string; branchId: string } {
  let branchId = '';
  const row = repairId ? query('SELECT branch_id FROM repairs WHERE id = ?', [repairId])[0] : undefined;
  if (row?.branch_id) branchId = String(row.branch_id);
  if (!branchId) branchId = currentBranchId();
  const t = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId])[0];
  return { tenantId: String(t?.tenant_id ?? 'tenant-1'), branchId };
}

export function repairMediaOwner(repairId: string, scope = repairMediaScope(repairId)): MediaOwner {
  return {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: REPAIR_MEDIA_ENTITY, entityId: repairId, role: REPAIR_MEDIA_ROLE, securityClass: 'internal',
  };
}

export function repairPhotoScope(scope = repairMediaScope(), orchestrator?: StockMediaOrchestrator): RecordPhotoScope {
  return { tenantId: scope.tenantId, branchId: scope.branchId, ownerType: REPAIR_MEDIA_ENTITY, role: REPAIR_MEDIA_ROLE, orchestrator };
}

/** Aufnehmen VOR der Klammer: aus Daten-URLs werden geprüfte, noch unverknüpfte Objekte. */
export function ingestRepairPhotos(urls: readonly string[], orchestrator?: StockMediaOrchestrator, repairId?: string): Promise<string[]> {
  return ingestRecordPhotos(urls, repairPhotoScope(repairMediaScope(repairId), orchestrator));
}

/** Dasselbe für eine Maske, die behaltene Medien und neue Aufnahmen mischt. */
export function resolveRepairPhotoSlots(slots: readonly PhotoSlotRequest[], orchestrator?: StockMediaOrchestrator, repairId?: string): Promise<string[]> {
  return resolvePhotoSlots(slots, repairPhotoScope(repairMediaScope(repairId), orchestrator));
}

/**
 * Die Galerie der Reparatur INNERHALB der laufenden Geschäftstransaktion setzen (eine Fassung).
 *
 * Ein Nein des Medienkerns wird hier zum Nein der REPARATUR übersetzt — mit denselben Codes am
 * Primary wie im Fernbefehl. Ein Foto, das es nicht (mehr) gibt, heißt weiterhin `PHOTO_NOT_FOUND`.
 */
export function applyRepairGallery(
  repairId: string,
  mediaIds: readonly string[],
  opts: { bumpOwner?: boolean } = {},
): { changed: boolean } {
  const links = new MediaOwnerLinks(getDatabase() as never);
  try {
    // Die Reparaturzeile wird in derselben Klammer geschrieben (`updateRepair`); ihr eigener Trigger
    // ist die EINE Fassung dieser Speicherung. Ein zweiter Zähler hier hiesse: eine Aenderung, zwei
    // Fassungen — und ein Austausch (raus + rein) waere plötzlich zwei.
    const r = links.setGallery(repairMediaOwner(repairId), mediaIds, { bumpOwner: opts.bumpOwner ?? false });
    // ALTBESTAND — sobald eine Reparatur ihre Galerie über den Medienkern setzt, ist die alte Spalte
    // erledigt: sie wird in DERSELBEN Klammer geleert. Sonst käme ein bewusst entferntes Foto beim
    // nächsten Lesen aus der Spalte zurück („keine Verknüpfung → alte Liste"), und ein Speichern
    // hätte still rückgängig gemacht, was der Mensch gelöscht hat.
    getDatabase().run("UPDATE repairs SET images = '[]' WHERE id = ? AND COALESCE(images, '') NOT IN ('', '[]')", [repairId]);
    return { changed: r.changed };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'MEDIA_LINK_OBJECT_NOT_READY') {
      throw new RepairActionRejected('PHOTO_NOT_FOUND', 'this photo is not on the repair (any more)');
    }
    if (typeof code === 'string' && code.startsWith('MEDIA_')) {
      throw new RepairActionRejected(code, (e as Error).message);
    }
    throw e;
  }
}

/** Die aktuellen Medien einer Reparatur (geordnet) — Referenzen, keine Bytes. */
export function repairPhotoRefs(repairId: string): OwnerMediaRef[] {
  const scope = repairMediaScope(repairId);
  return resolveOwnerMedia(getDatabase() as never, {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: REPAIR_MEDIA_ENTITY, role: REPAIR_MEDIA_ROLE, entityIds: [repairId],
  }).get(repairId) ?? [];
}

/** Dieselbe Auskunft für viele Reparaturen — EINE Abfrage (Listen bleiben Listen). */
export function repairPhotoRefsFor(repairIds: readonly string[], branchId?: string): Map<string, OwnerMediaRef[]> {
  const scope = repairMediaScope();
  return resolveOwnerMedia(getDatabase() as never, {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: branchId ?? scope.branchId,
    entityType: REPAIR_MEDIA_ENTITY, role: REPAIR_MEDIA_ROLE, entityIds: [...repairIds],
  });
}

/** Die Medienkennungen der aktuellen Galerie — die Grundlage jedes „behalten". */
export function repairGalleryMediaIds(repairId: string): string[] {
  return repairPhotoRefs(repairId).map((r) => r.mediaId);
}

export type { PhotoSlotRequest };
