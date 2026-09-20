// ════════════════════════════════════════════════════════════════════════════
// MEDIA-REPAIR — die Fotos einer Reparatur ANZEIGEN, auf beiden Rechnern.
//
// Gespeichert sind Referenzen, keine Bytes. Zum Zeigen holt die Maske die Bytes über einen
// geprüften Weg und macht daraus eine Objekt-URL, die nur im Fenster lebt:
//
//   Primary  → lokale Verknüpfungen → `media_read_verified` (Rust prüft Pfad, Größe und Hash)
//   PC2      → `repairs.get` nennt die Schlüssel → `/api/media` mit Ausweis (Gate aus S1/REPAIR)
//
// Eine Reparatur aus der Zeit vor dem Medienkern hat keine Verknüpfungen; dann werden die alten
// Daten-URLs der Spalte gezeigt — gelesen, nie neu geschrieben.
// ════════════════════════════════════════════════════════════════════════════
import { readsFromPrimary } from '@/core/data/primary-source';
import { remoteRead } from '@/core/bridge/remote-read';
import { clientConfig } from '@/core/bridge/client-mode';
import { TauriMediaGateway } from '@/core/media/gateway';
import { repairPhotoRefs } from '@/core/repairs/repair-media';

export interface RepairPhotoView {
  /** Die stabile Kennung — genau sie nennt ein „behalten" beim Speichern. Leer bei Altbestand. */
  mediaId: string;
  /** Was ein `<img src>` anzeigen kann: Objekt-URL (neu) oder die alte Daten-URL (Altbestand). */
  url: string;
  /** true, wenn `url` eine Objekt-URL ist und wieder freigegeben werden muss. */
  revocable: boolean;
}

/** Objekt-URLs wieder freigeben — genau einmal, beim Verlassen der Maske. */
export function revokeRepairPhotos(views: readonly RepairPhotoView[]): void {
  for (const v of views) if (v.revocable) { try { URL.revokeObjectURL(v.url); } catch { /* schon weg */ } }
}

async function fromPrimary(repairId: string, legacy: readonly string[]): Promise<RepairPhotoView[]> {
  const refs = repairPhotoRefs(repairId);
  if (refs.length === 0) return legacy.map((url) => ({ mediaId: '', url, revocable: false }));
  const gateway = new TauriMediaGateway();
  const scope = refs[0].main.storageKey.split('/')[0];
  const out: RepairPhotoView[] = [];
  for (const r of refs) {
    const m = await gateway.readVerifiedMedia({ tenantScope: scope, hash: r.main.hash, extension: r.main.extension });
    const blob = new Blob([m.bytes as unknown as BlobPart], { type: m.mime_type || 'image/jpeg' });
    out.push({ mediaId: r.mediaId, url: URL.createObjectURL(blob), revocable: true });
  }
  return out;
}

async function fromClient(repairId: string, fetchFn: typeof fetch): Promise<RepairPhotoView[]> {
  const detail = await remoteRead<{ mediaKeys?: string[]; mediaIds?: string[]; images?: string[] }>('repairs.get', { id: repairId }, fetchFn);
  const keys = detail.mediaKeys ?? [];
  if (keys.length === 0) return (detail.images ?? []).map((url) => ({ mediaId: '', url, revocable: false }));
  const c = clientConfig();
  if (!c?.token) throw new Error('NOT_AUTHENTICATED');
  const ids = detail.mediaIds ?? [];
  const out: RepairPhotoView[] = [];
  for (let i = 0; i < keys.length; i++) {
    const res = await fetchFn(`${c.serverUrl}/api/media?key=${encodeURIComponent(keys[i])}`, {
      headers: { Authorization: `Bearer ${c.token}` },
    });
    // Fehlt ein Bild, ist die Galerie ein Fehler — nie eine halbe.
    if (!res.ok) throw new Error(`MEDIA_UNAVAILABLE_${res.status}`);
    const blob = await res.blob();
    out.push({ mediaId: ids[i] ?? '', url: URL.createObjectURL(blob), revocable: true });
  }
  return out;
}

/** Die Galerie einer Reparatur, anzeigefertig — auf dem Primary lokal, auf PC2 über den Primary. */
export function loadRepairPhotos(
  repairId: string, legacy: readonly string[] = [], fetchFn: typeof fetch = fetch,
): Promise<RepairPhotoView[]> {
  return readsFromPrimary() ? fromClient(repairId, fetchFn) : fromPrimary(repairId, legacy);
}
