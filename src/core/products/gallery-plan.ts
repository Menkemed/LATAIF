// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — die Bildbearbeitung von ProductDetail auf einem Rechner OHNE Datenbank.
//
// Am Primary gibt das Formular seine Bildliste (Quellen) plus die Auflösung „welche Quelle ist
// welches bestehende Medium" an `editProductWithMedia`. Ein zweiter Rechner hat weder die
// Verknüpfungen noch den Medienspeicher — aber er hat beides schon GESEHEN: `products.get` nennt die
// Medienkennungen der Galerie in ihrer Ordnung, und `useProductMediaPresentation` zeigt jede mit
// ihrer Objekt-URL an (`media.items`). Mehr braucht es nicht; eine neue Auskunft gibt es nicht.
//
// Aus dem Entwurf wird deshalb GENAU die Liste, die `products.update` schon kennt: Platz für Platz
// ein behaltenes Bild (`{ keep: mediaId }`) oder ein neues aus der Zwischenablage (`{ stagingId }`).
// Hinzufügen, Entfernen und Umsortieren sind dieselbe Aussage — die Reihenfolge der Liste. Was
// entfernt wird, rechnet der Primary gegen seine WIRKLICHE Galerie aus, nicht dieser Rechner.
// ════════════════════════════════════════════════════════════════════════════
import type { GallerySlot } from '@/core/bridge/product-commands';

/** Ein Bild der angezeigten Galerie: seine Anzeige-URL und die Medienkennung dahinter. */
export interface PresentedImage {
  url: string;
  mediaId: string;
}

export class GalleryPlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GalleryPlanError';
    this.code = code;
  }
}

/**
 * Den Entwurf des Formulars in Plätze übersetzen. Ein Bild, das weder ein angezeigtes gespeichertes
 * noch ein frisch gewähltes (Daten-URL) ist, wird NICHT geraten: fail-closed, die Maske bleibt offen.
 * Neue Bilder gehen vorher in die Ablage (`stage`); dieselben Bytes ergeben dieselbe Kennung.
 */
export async function planRemoteGallery(
  srcs: readonly string[],
  items: readonly PresentedImage[],
  stage: (urls: readonly string[]) => Promise<string[]>,
): Promise<GallerySlot[]> {
  const byUrl = new Map(items.filter((i) => !!i.mediaId).map((i) => [i.url, i.mediaId] as const));
  const slots: GallerySlot[] = [];
  const seen = new Set<string>();
  for (const src of srcs) {
    const mediaId = byUrl.get(src);
    let slot: GallerySlot;
    if (mediaId) {
      slot = { keep: mediaId };
    } else if (typeof src === 'string' && src.startsWith('data:')) {
      const [stagingId] = await stage([src]);
      slot = { stagingId };
    } else {
      throw new GalleryPlanError('MEDIA_EDIT_UNKNOWN_IMAGE',
        'An image in the editor is neither a saved photo nor a new picture — reload the product and try again.');
    }
    // Dasselbe Bild zweimal ist keine Reihenfolge — der Primary wiese den Plan ohnehin ab.
    const key = 'keep' in slot ? `k:${slot.keep}` : `s:${slot.stagingId}`;
    if (seen.has(key)) throw new GalleryPlanError('MEDIA_EDIT_DUPLICATE_IMAGE', 'The same photo is in the gallery twice.');
    seen.add(key);
    slots.push(slot);
  }
  return slots;
}
