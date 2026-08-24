// ════════════════════════════════════════════════════════════════════════════
// Die kanonische Kategorie zu einer Kategorie-Id — fuer Code, der kein React ist.
//
// Die Suche muss wissen, welche Attribute eine Kategorie wirklich definiert: nur deren
// Werte sind fachliche Produktdaten, alles andere im `attributes`-Sack ist Rest aus einem
// Import oder einer KI-Antwort. In der Collection reicht die Liste die Kategorie mit; in
// den fuenf Beleglisten steckt das Produkt in einem Beleg und traegt nur seine
// `categoryId`.
//
// Statt dort eine zweite Kategorie-Quelle aufzumachen (oder pro Artikel nachzuschlagen),
// meldet die vorhandene kanonische Auflösung sich hier einmal an: `useProductStore` haelt
// die Kategorien ohnehin im Speicher und hat mit `getCategory(id)` bereits den Zugriff
// dafuer. Diese Datei ist nur der Briefkasten dazwischen — sie kennt weder Store noch
// Datenbank und zieht deshalb keine Abhaengigkeit in die Hilfsfunktionen.
//
// FAIL CLOSED: ist nichts angemeldet oder die Id unbekannt, gibt es KEINE Kategorie. Der
// Aufrufer laesst die Attribute dann weg, statt sie ungeprueft freizugeben.
// ════════════════════════════════════════════════════════════════════════════
import type { Category } from '@/core/models/types';

/**
 * Die Trennung in einem Ausdruck — der einzige Ort, an dem sie definiert ist.
 *
 *   `schema` — ALLE bekannten Definitionen, auch deaktivierte. Damit wird ein BESTEHENDER
 *              Artikel ausgelegt: seine Attribute bleiben fachliche Daten, auch wenn die
 *              Kategorie fuer Neuanlagen abgeschaltet wurde.
 *   `active` — die Auswahl fuer Anlegen und Bearbeiten. Eine deaktivierte Kategorie darf
 *              hier NICHT auftauchen.
 */
export function categorySelection(all: Category[]): { schema: Category[]; active: Category[] } {
  return { schema: all, active: all.filter(c => c.active) };
}

let resolver: ((id: string) => Category | undefined) | null = null;

/** Einmal beim Laden des Stores aufgerufen — die eine kanonische Auflösung. */
export function registerCategoryLookup(fn: (id: string) => Category | undefined): void {
  resolver = fn;
}

/** Nur fuer Tests: den Briefkasten wieder leeren. */
export function clearCategoryLookup(): void {
  resolver = null;
}

/** Die Kategorie zu dieser Id — oder `undefined`, wenn sie nicht sicher bekannt ist. */
export function lookupCategory(categoryId?: string): Category | undefined {
  if (!resolver || !categoryId) return undefined;
  try {
    return resolver(categoryId) ?? undefined;
  } catch {
    return undefined;
  }
}
