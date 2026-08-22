// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT-S3 — der Galerie-Fingerabdruck, den Handy und Desktop teilen.
//
// Das Handy bekommt beim Lesen eines Artikels einen `gallery_baseline` (Rust, `product_query.rs`)
// und schickt ihn beim Speichern zurueck. Der Drain berechnet ihn hier aus dem AKTUELLEN Stand der
// sql.js-Datenbank neu und vergleicht. Nur wenn beide gleich sind, beschreibt der mitgeschickte
// Plan noch die Galerie, die der Benutzer gesehen hat.
//
// Die Formel steht damit zweimal im Repo — einmal in Rust, einmal hier. Das ist Absicht: die beiden
// lesen unterschiedliche Datenquellen (Datei read-only vs. laufende sql.js-Instanz) und duerfen sich
// nicht gegenseitig aufrufen. Damit sie nicht auseinanderlaufen, pinnen BEIDE Seiten denselben
// Testvektor: `product_query_tests.rs::the_shared_baseline_vector_is_stable` und
// `test/mobile-gallery-edit/gallery-baseline.test.ts`.
//
// Formel: je Zeile `linkId:mediaId:sortOrder:isPrimary(0|1)`, in Anzeigereihenfolge mit `|`
// verbunden, davon sha-256 als Kleinbuchstaben-Hex. Eine leere Galerie ergibt den Hash des leeren
// Strings — das ist ein GUELTIGER Wert und bedeutet "gelesen, nichts drin". "Nicht gelesen" hat
// keinen Fingerabdruck, siehe `gallery_ok` in `product_query.rs`.
// ════════════════════════════════════════════════════════════════════════════

/** Eine Galerie-Zeile, so wie beide Seiten sie sehen. */
export interface GalleryBaselineRow {
  linkId: string;
  mediaId: string;
  sortOrder: number;
  isPrimary: boolean;
}

/** Die Anzeigereihenfolge: Titelbild zuerst, dann `sort_order`, dann `link_id` — identisch zum
 *  `ORDER BY l.is_primary DESC, l.sort_order ASC, l.link_id ASC` der Rust-Abfrage. */
export function sortGalleryRows<T extends GalleryBaselineRow>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0;
  });
}

/** Der kanonische Eingabestring des Fingerabdrucks — getrennt exportiert, damit der Testvektor die
 *  Formel selbst festnagelt und nicht nur ihren Hash. */
export function galleryBaselineInput(rows: readonly GalleryBaselineRow[]): string {
  return sortGalleryRows(rows)
    .map((r) => `${r.linkId}:${r.mediaId}:${r.sortOrder}:${r.isPrimary ? 1 : 0}`)
    .join('|');
}

/** sha-256 hex ueber den kanonischen String. */
export async function galleryBaselineFingerprint(rows: readonly GalleryBaselineRow[]): Promise<string> {
  const bytes = new TextEncoder().encode(galleryBaselineInput(rows));
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
