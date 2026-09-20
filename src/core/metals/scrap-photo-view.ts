// ════════════════════════════════════════════════════════════════════════════
// MEDIA-SCRAP — die Belegfotos eines Altgold-Geschäfts ANZEIGEN, auf beiden Rechnern.
//
// Gespeichert sind Referenzen. Zum Zeigen holt die Maske die Bytes über einen geprüften Weg und
// macht daraus Objekt-URLs, die nur solange leben wie die Maske:
//
//   Primary  → `media_read_verified` (Rust prüft Pfad, Größe und Inhalt-Hash)
//   PC2      → `/api/media` mit Ausweis — das Tor entscheidet (Mandant, Filiale, Besitzer, Rolle,
//              Klasse, aktive Verknüpfung); der Schlüssel allein berechtigt zu nichts.
//
// Die Maske rechnet mit MEDIENKENNUNGEN (das ist ihr Modell) und zeigt Objekt-URLs. Die beiden
// Abbildungen hier sind genau diese Übersetzung — in keiner Richtung entsteht eine Daten-URL, die
// irgendwo liegen bliebe.
// ════════════════════════════════════════════════════════════════════════════
import { readsFromPrimary } from '@/core/data/primary-source';
import { clientConfig } from '@/core/bridge/client-mode';
import { TauriMediaGateway } from '@/core/media/gateway';
import type { ScrapLinePhotoRef, ScrapTrade } from '@/core/models/types';

export interface ScrapPhotoUrls {
  /** Medienkennung → Objekt-URL (was ein `<img src>` zeigen kann). */
  byMediaId: Map<string, string>;
  /** Objekt-URL → Medienkennung (was die Maske beim Speichern zurückgibt). */
  byUrl: Map<string, string>;
}

export function emptyScrapPhotoUrls(): ScrapPhotoUrls {
  return { byMediaId: new Map(), byUrl: new Map() };
}

/** Objekt-URLs freigeben — genau einmal, beim Verlassen der Maske. */
export function revokeScrapPhotos(urls: ScrapPhotoUrls | null): void {
  if (!urls) return;
  for (const u of urls.byMediaId.values()) { try { URL.revokeObjectURL(u); } catch { /* schon weg */ } }
}

async function bytesOf(ref: ScrapLinePhotoRef, fetchFn: typeof fetch): Promise<Blob> {
  if (readsFromPrimary()) {
    const c = clientConfig();
    if (!c?.token) throw new Error('NOT_AUTHENTICATED');
    const res = await fetchFn(`${c.serverUrl}/api/media?key=${encodeURIComponent(ref.key)}`, {
      headers: { Authorization: `Bearer ${c.token}` },
    });
    // Ein abgewiesener Zugriff ist ein Fehler, nie ein leeres Bild: „nicht da" und „darfst du
    // nicht" sähen sonst gleich aus.
    if (!res.ok) throw new Error(`SCRAP_MEDIA_UNAVAILABLE_${res.status}`);
    return res.blob();
  }
  const gateway = new TauriMediaGateway();
  const scope = ref.key.split('/')[0];
  const m = await gateway.readVerifiedMedia({ tenantScope: scope, hash: ref.hash, extension: ref.extension });
  return new Blob([m.bytes as unknown as BlobPart], { type: m.mime_type || 'image/jpeg' });
}

/**
 * Alle Fotos eines Geschäfts anzeigefertig machen — jedes Medium genau einmal, auch wenn zwei
 * Positionen dasselbe Bild zeigen (derselbe Inhalt ist dasselbe Objekt).
 */
export async function loadScrapPhotos(trade: ScrapTrade | undefined, fetchFn: typeof fetch = fetch): Promise<ScrapPhotoUrls> {
  const out = emptyScrapPhotoUrls();
  if (!trade) return out;
  const refs = new Map<string, ScrapLinePhotoRef>();
  for (const line of trade.lines ?? []) {
    for (const r of [...(line.photos?.purchase ?? []), ...(line.photos?.sale ?? [])]) {
      if (!refs.has(r.mediaId)) refs.set(r.mediaId, r);
    }
  }
  for (const [mediaId, ref] of refs) {
    const url = URL.createObjectURL(await bytesOf(ref, fetchFn));
    out.byMediaId.set(mediaId, url);
    out.byUrl.set(url, mediaId);
  }
  return out;
}

/** Was die Maske ZEIGT: eine neue Aufnahme bleibt, wie sie ist; ein Medium wird zur Objekt-URL. */
export function toView(values: readonly string[] | undefined, urls: ScrapPhotoUrls): string[] {
  return (values ?? []).map((v) => urls.byMediaId.get(v) ?? v);
}

/** Was die Maske SPEICHERT: aus der Objekt-URL wird wieder die Medienkennung. */
export function toModel(views: readonly string[], urls: ScrapPhotoUrls): string[] {
  return views.map((v) => urls.byUrl.get(v) ?? v);
}
