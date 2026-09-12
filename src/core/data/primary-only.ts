// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6B — was auf einem Rechner OHNE eigene Datenbank (noch) nicht geht.
//
// R6A hat es gezählt: Knöpfe, die auf dem zweiten Rechner sichtbar waren und beim Klick in
// `getDatabase()` liefen — ein Fehler mitten im Klick, oder schlimmer, ein Erfolg, der keiner war.
// Hier stehen die Worte und die Weiche dafür, an EINER Stelle:
//
//   • am Primary ändert sich nichts — dieselben Knöpfe, dieselbe Wirkung;
//   • auf einem Client ist die Handlung sichtbar gesperrt und sagt, wo sie geht;
//   • und falls sie doch erreicht wird (Tastatur, ein offener Bestätigungsdialog), hält der Riegel
//     im Handler — ohne lokalen Griff, ohne Erfolgsmeldung.
//
// Keine Geschäftsregel. Nur `readsFromPrimary()` und ein Satz.
// ════════════════════════════════════════════════════════════════════════════
import { readsFromPrimary } from '@/core/data/primary-source';

export const PRIMARY_ONLY_DELETE = 'Deleting is only available on the main computer.';

/** Läuft dieses Fenster ohne eigene Datenbank? Dann ist eine Primary-only-Handlung gesperrt. */
export function primaryOnlyLocked(): boolean {
  return readsFromPrimary();
}

/** Der Satz, den der Mensch liest. */
export function primaryOnlyText(what: string): string {
  return `${what} is only available on the main computer.`;
}

/**
 * Die Eigenschaften eines Löschknopfs. Am Primary nur das bisherige `disabled`; am Client gesperrt,
 * mit Begründung und einer Markierung, an der die Prüfung ihn erkennt.
 */
export function primaryOnlyDeleteProps(disabled = false): { disabled: boolean; title?: string; 'data-primary-only'?: string } {
  if (!readsFromPrimary()) return { disabled };
  return { disabled: true, title: PRIMARY_ONLY_DELETE, 'data-primary-only': 'delete' };
}

/** Der Riegel im Handler: `true` heißt gesperrt (und gesagt) — der Handler kehrt sofort um. */
export function blockDeleteOnClient(): boolean {
  if (!readsFromPrimary()) return false;
  try { window.alert(PRIMARY_ONLY_DELETE); } catch { /* kein Fenster, z. B. im Test */ }
  return true;
}
