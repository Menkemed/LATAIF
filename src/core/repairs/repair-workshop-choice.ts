// ════════════════════════════════════════════════════════════════════════════
// REPAIR-WORKSHOP-FILTER — wer in einer Reparatur als Werkstatt wählbar ist. EINE Regel für den Primary, PC2 und das
// Telefon (dort über `suppliers.list` mit `workshop: true`, dieselbe Bedingung in SQL).
//
// „Is Workshop" ist eine reine Einordnung am Lieferanten: sie ändert keinen Einkauf, keine Zahlung, keine Buchung.
// Als Werkstatt wählbar (neue Reparatur, Werkstatt ändern, Arbeitszeile, Gold vom Workshop) ist nur, wer AKTIV und als
// Werkstatt MARKIERT ist. Material / Ersatzteile bleiben bei ALLEN aktiven Lieferanten — ein Armband oder ein Glas kommt
// oft vom normalen Händler.
//
// Was eine Reparatur schon trägt, bleibt sichtbar und gewählt, auch wenn die Markierung später fällt oder der
// Lieferant stillgelegt wird: eine Auswahl ohne den gespeicherten Wert zeigte ein leeres Feld, und ein Speichern
// könnte die Zuordnung verlieren. Vorschläge („schon als Werkstatt benutzt") werden nur gezeigt — markiert wird nie
// automatisch, das entscheidet der Owner.
//
// Diese Datei ist rein: keine Datenbank, kein Zustand.
// ════════════════════════════════════════════════════════════════════════════

export interface WorkshopCandidate {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  active: boolean;
  isWorkshop?: boolean;
  /** Populated: in wie vielen Reparaturen schon als Werkstatt gearbeitet (Werkstatt der Reparatur oder Arbeitszeile). */
  repairWorkshopUses?: number;
}

/** Eine Zeile einer Auswahl — dieselbe Form wie `SearchSelect` sie nimmt. */
export interface WorkshopOption {
  id: string;
  label: string;
  subtitle: string;
  meta: string;
}

/** Die Bedingung als SQL — für Leser, die nur die Datenbank haben (`suppliers.list` für das Telefon). */
export const SELECTABLE_WORKSHOP_SQL = 'active = 1 AND is_workshop = 1';

/** Der Hinweis, wenn noch kein Lieferant als Werkstatt markiert ist. */
export const NO_WORKSHOP_HINT = 'No workshops marked yet — mark them under Suppliers → Edit → “Is Workshop”.';

/** Wählbar als Werkstatt: aktiv UND markiert. */
export function isSelectableWorkshop(s: Pick<WorkshopCandidate, 'active' | 'isWorkshop'>): boolean {
  return s.active === true && s.isWorkshop === true;
}

/** Gibt es überhaupt eine wählbare Werkstatt? Sonst zeigt die Maske den Hinweis. */
export function hasSelectableWorkshop(suppliers: readonly WorkshopCandidate[]): boolean {
  return suppliers.some(isSelectableWorkshop);
}

function option(s: WorkshopCandidate, label = s.name): WorkshopOption {
  return { id: s.id, label, subtitle: s.phone || '', meta: s.email || '' };
}

/**
 * Die Werkstätten einer Auswahl: alle wählbaren, dazu (VORNE) jeder gespeicherte Wert, der es nicht mehr ist — benannt,
 * damit niemand ihn für eine aktuelle Werkstatt hält. Ein unbekannter Wert (keine Zeile) bleibt weg, wie bisher.
 */
export function workshopOptions(
  suppliers: readonly WorkshopCandidate[],
  keep: ReadonlyArray<string | null | undefined> = [],
): WorkshopOption[] {
  const out = suppliers.filter(isSelectableWorkshop).map((s) => option(s));
  const gezeigt = new Set(out.map((o) => o.id));
  const behalten: WorkshopOption[] = [];
  for (const id of keep) {
    if (!id || gezeigt.has(id)) continue;
    const s = suppliers.find((x) => x.id === id);
    if (!s) continue;
    gezeigt.add(id);
    behalten.push(option(s, `${s.name} ${s.active ? '(not marked as workshop)' : '(inactive)'}`));
  }
  return [...behalten, ...out];
}

/** Material / Ersatzteile: ALLE aktiven Lieferanten — unverändert die bisherige Regel. */
export function materialSupplierOptions(suppliers: readonly WorkshopCandidate[]): WorkshopOption[] {
  return suppliers.filter((s) => s.active).map((s) => option(s));
}

export interface WorkshopSuggestion {
  id: string;
  name: string;
  uses: number;
}

/**
 * Vorschläge: aktive Lieferanten, die schon als Werkstatt gearbeitet haben, aber nicht markiert sind — häufigste zuerst.
 * Nur zum Anzeigen; markiert wird erst auf einen ausdrücklichen Klick.
 */
export function workshopSuggestions(suppliers: readonly WorkshopCandidate[]): WorkshopSuggestion[] {
  return suppliers
    .filter((s) => s.active && s.isWorkshop !== true && (s.repairWorkshopUses ?? 0) > 0)
    .map((s) => ({ id: s.id, name: s.name, uses: s.repairWorkshopUses ?? 0 }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
}
