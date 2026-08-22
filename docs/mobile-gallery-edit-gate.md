# S3-Gate: `gallery read failure != valid empty gallery`

**Status:** offen — dieses Gate MUSS geschlossen sein, bevor irgendein Speichervorgang vom Handy
aus die Galerie eines Artikels schreibt (Bild hinzufügen, entfernen, umsortieren, Titelbild ändern).

## Der Zustand heute

`enrich()` in `src-tauri/src/sync/product_query.rs` liest die geordnete Galerie und schließt den
Lesefehler mit `unwrap_or_default()` ab. Ein Fehler beim Lesen wird damit zu einer **leeren Liste**,
und `gallery_baseline` zum Fingerabdruck des Nichts. Für S1/S2 ist das nachweislich harmlos:

- S1 ist rein lesend,
- S2 wendet ausschließlich `applyProductTextEditDurably` an, und der fasst `media_links` per Vertrag
  nicht an — belegt in `test/e2e/mobile-item-edit.e2e.mjs` (jede `media_links`-Zeile byte-identisch,
  inklusive dreier Negativkontrollen des Vergleichers).

Eine leere Anzeige kann also nichts löschen.

## Warum es ab S3 gefährlich wird

Sobald ein Save die Galerie schreibt, sind zwei völlig verschiedene Sachverhalte nicht mehr
unterscheidbar:

| Wirklichkeit | Was das Handy sieht | Was ein Gallery-Save daraus macht |
|---|---|---|
| Der Artikel hat keine Bilder | `gallery: []` | „nichts zu behalten" — korrekt |
| Die Galerie war nicht lesbar | `gallery: []` | „der Benutzer hat alle Bilder entfernt" — **Datenverlust** |

Das ist exakt die Fehlerklasse, gegen die S1 überhaupt gebaut wurde („Save löscht die vier Bilder,
die das Handy nie gesehen hat"), nur an einer anderen Stelle. Der Baseline-Guard hilft hier nicht:
er würde den Fingerabdruck des leeren Zustands mit dem leeren Zustand vergleichen und zustimmen.

## Was S3 erfüllen muss

1. **Lesefehler ist ein Fehler.** `enrich()` unterscheidet „keine Zeilen" von „konnte nicht lesen"
   und meldet den zweiten Fall ausdrücklich, statt ihn in eine leere Liste zu falten.
2. **Fail closed.** Ohne verlässlich gelesene Galerie darf die Seite keinen Gallery-Save anbieten;
   ein trotzdem eintreffender Save wird abgelehnt, nicht angewandt.
3. **Der Baseline gilt nur für einen gelesenen Zustand.** Ein Fingerabdruck, der aus einem
   fehlgeschlagenen Read stammt, darf nie als Vergleichsgrundlage eines Saves dienen.
4. **Bewiesen, nicht behauptet.** Der Beweis gehört auf dieselbe Ebene wie der Preserve-Beweis aus
   S2: ein erzwungener Lesefehler darf keine `media_links`-Zeile verändern.
