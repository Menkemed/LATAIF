/**
 * Wann eine Maske ihre Arbeitskopie vom gelesenen Datensatz neu übernimmt.
 *
 * Der Laden liest ständig neu: nach jeder eigenen Handlung auf der Seite (`loadRepairs()` nach
 * Arbeitszeile, Storno, Material, Gold, Status) und wenn der Abgleich eine fremde Änderung
 * einspielt. Jedes Neuladen liefert FRISCHE Objekte — die Referenz ändert sich also auch dann,
 * wenn sich inhaltlich nichts geändert hat.
 *
 * Solange jemand tippt, darf das die Eingabe NICHT ersetzen: sonst verschwindet ungespeicherte
 * Arbeit lautlos, und ein anschließendes „Save" schreibt den alten Stand zurück, ohne dass es
 * jemand merkt. Dass der Datensatz sich inzwischen geändert haben könnte, fängt die Fassung ab
 * (`expectedRevision` → `RECORD_CHANGED`) — das ist der Ort dafür, nicht ein heimliches
 * Zurücksetzen der Maske. Endet das Bearbeiten (Save oder Cancel), greift die Übernahme sofort
 * wieder: der nächste Renderdurchlauf sieht eine Referenz, die noch nicht übernommen wurde.
 *
 * Dieselbe Regel gilt am Telefon (`rpOpen(..., { keepForm: true })` in `mobile_repair_ui.js`).
 */
/**
 * Die Fassung, gegen die „Save" schreibt: die des Datensatzes, den die Maske beim Eintritt ins
 * Bearbeiten übernommen hat — NICHT die des gerade geladenen. Der Laden liest im Hintergrund neu;
 * wer dessen Fassung nähme, bestätigte eine fremde Änderung, die er nie gesehen hat.
 * Keine gültige Fassung → `null` (die Maske speichert dann nicht).
 */
export function editBaselineRevision(adopted: { revision?: number } | null | undefined): number | null {
  const r = adopted?.revision;
  return typeof r === 'number' && Number.isInteger(r) && r >= 1 ? r : null;
}

export function shouldAdoptRecord<T>(record: T | null | undefined, adopted: T | undefined, editing: boolean): boolean {
  return !!record && record !== adopted && !editing;
}
