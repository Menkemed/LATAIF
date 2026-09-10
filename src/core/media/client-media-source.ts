// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5B — die Galerie eines Artikels auf einem Rechner OHNE Datenbank.
//
// Die gemeinsame Oberfläche liest Bilder über den Medien-Resolver — der fragt die LOKALE
// Geschäftsdatenbank nach den Verknüpfungen und den LOKALEN Medienspeicher nach den Bytes. Ein
// zweiter Rechner hat beides nicht: bis hierher zeigte er deshalb zu keinem Artikel ein Bild, auch
// zu einem, den er gerade selbst mit Foto angelegt hatte.
//
// Beides gibt es beim Primary schon, und beides ist dort geprüft:
//   • `products.get` (eine der bestehenden Auskünfte) nennt die Speicherschlüssel der Galerie, in
//     ihrer Ordnung (Hauptbild zuerst) — und die Medienkennungen daneben;
//   • `/api/media?key=` liefert die Bytes, nur mit gültigem Ausweis.
//
// Kein neuer Weg, keine neue Buchung, kein Zwischenspeicher auf dem Client. Fehlt ein Bild, ist die
// Galerie ein Fehler — nie eine halbe.
// ════════════════════════════════════════════════════════════════════════════
import { remoteRead } from '@/core/bridge/remote-read';
import { clientConfig } from '@/core/bridge/client-mode';
import { MAX_REMOTE_IMAGES } from '@/core/bridge/remote-create-support';

export interface RemoteGalleryItem {
  blob: Blob;
  mimeType: string;
  mediaId: string;
  sortOrder: number;
  isPrimary: boolean;
}

export async function loadRemoteGallery(productId: string, fetchFn: typeof fetch = fetch): Promise<RemoteGalleryItem[]> {
  const detail = await remoteRead<{ mediaKeys?: string[]; mediaIds?: string[] }>('products.get', { id: productId }, fetchFn);
  const keys = detail.mediaKeys ?? [];
  const ids = detail.mediaIds ?? [];
  if (keys.length === 0) return [];
  const c = clientConfig();
  if (!c?.token) throw new Error('NOT_AUTHENTICATED');
  const out: RemoteGalleryItem[] = [];
  for (let i = 0; i < keys.length && i < MAX_REMOTE_IMAGES; i++) {
    const res = await fetchFn(`${c.serverUrl}/api/media?key=${encodeURIComponent(keys[i])}`, {
      headers: { Authorization: `Bearer ${c.token}` },
    });
    // Fehlt ein Bild, zeigt die Galerie einen Fehler — nie eine halbe Galerie.
    if (!res.ok) throw new Error(`MEDIA_UNAVAILABLE_${res.status}`);
    const blob = await res.blob();
    out.push({ blob, mimeType: blob.type || 'image/jpeg', mediaId: ids[i] ?? '', sortOrder: i, isPrimary: i === 0 });
  }
  return out;
}
