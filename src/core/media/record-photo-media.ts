// ════════════════════════════════════════════════════════════════════════════
// MEDIA-REPAIR — Belegfotos eines Datensatzes im generischen Medienkern.
//
// Der Weg ist der aus MEDIA-S2, ohne zweite Architektur:
//
//   Bytes → `ingestObject` (Rust normalisiert, prüft, veröffentlicht) → verifiziertes Medienobjekt
//   OHNE Verknüpfung  →  Geschäftstransaktion: Datensatz + Verknüpfungen + Revision  →  COMMIT
//
// Die Aufnahmekennung wird aus den BYTES gebildet: dieselbe Aufnahme zweimal (Wiederholung, zwei
// Reparaturen, zweiter Rechner) ergibt dasselbe Objekt — kein zweiter Upload, keine zweite Datei,
// keine doppelte Verknüpfung. Ein Datensatz hält nie wieder eine Daten-URL.
// ════════════════════════════════════════════════════════════════════════════
import { getStockMediaOrchestrator } from '@/core/media/orchestrator';
import { toIngestRequestId } from '@/core/media/ingest-request-id';
import { canonicalRequestHash } from '@/core/media/product-media-cutover';
import type { StockMediaOrchestrator } from '@/core/media/orchestrator';

/** Wem die Fotos gehören werden — der Datensatz muss dafür noch nicht existieren. */
export interface RecordPhotoScope {
  tenantId: string;
  branchId: string | null;
  /** `repair`, später weitere — immer ein Typ aus `MEDIA_ENTITY_SCOPE`. */
  ownerType: string;
  role: string;
  /** Test-Einsprung; in der Anwendung der Produktions-Orchestrator. */
  orchestrator?: StockMediaOrchestrator;
}

export class RecordPhotoError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'RecordPhotoError';
  }
}

/** Bytes einer Daten-URL (`data:image/…;base64,…`). */
export function bytesOfDataUrl(url: string): Uint8Array {
  const comma = typeof url === 'string' ? url.indexOf(',') : -1;
  if (comma < 0 || !url.startsWith('data:')) throw new RecordPhotoError('MEDIA_PHOTO_NOT_A_DATA_URL', 'a photo must arrive as a data URL');
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Die Aufnahmekennung dieser Bytes für diesen Besitzertyp — stabil, wiederholbar, ohne Zufall. */
export async function photoIngestRequestId(bytes: Uint8Array, scope: RecordPhotoScope): Promise<{ id: string; requestHash: string }> {
  const requestHash = await canonicalRequestHash(bytes, scope.tenantId);
  return { id: toIngestRequestId(`photo-${scope.ownerType}-${scope.role}-${requestHash}`), requestHash };
}

/**
 * Daten-URLs → verifizierte, noch UNVERKNÜPFTE Medienobjekte (in der Reihenfolge der Eingabe).
 * Läuft VOR der Geschäftstransaktion: jeder Ingest hat seine eigenen durablen Haltepunkte.
 */
export async function ingestRecordPhotos(urls: readonly string[], scope: RecordPhotoScope): Promise<string[]> {
  if (urls.length === 0) return [];
  const orch = scope.orchestrator ?? (await getStockMediaOrchestrator());
  const out: string[] = [];
  for (const url of urls) {
    const bytes = bytesOfDataUrl(url);
    const { id, requestHash } = await photoIngestRequestId(bytes, scope);
    const r = await orch.ingestObject({
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      scopeKind: scope.branchId == null ? 'tenant' : 'branch',
      ingestRequestId: id,
      requestHash,
      ownerType: scope.ownerType,
      role: scope.role,
      securityClass: 'internal',
      imageBytes: bytes,
    });
    out.push(r.mediaId);
  }
  return out;
}

/** Ein Wunsch der Maske: ein bestehendes Medium behalten ODER eine neue Aufnahme aufnehmen. */
export type PhotoSlotRequest = { keep: string } | { dataUrl: string };

/**
 * Die Galerie, die nach dem Speichern gelten soll — in Medienkennungen. Neue Aufnahmen werden
 * vorher aufgenommen (unverknüpft); behaltene Medien müssen schon dem Besitzer gehören, was der
 * Galerie-Plan beim Anwenden prüft.
 */
export async function resolvePhotoSlots(slots: readonly PhotoSlotRequest[], scope: RecordPhotoScope): Promise<string[]> {
  const fresh = slots.flatMap((s) => ('dataUrl' in s ? [s.dataUrl] : []));
  const ids = await ingestRecordPhotos(fresh, scope);
  let i = 0;
  return slots.map((s) => ('keep' in s ? s.keep : ids[i++]));
}
