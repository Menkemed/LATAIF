// ════════════════════════════════════════════════════════════════════════════
// Wie eine Kostenzeile einer Reparatur GELESEN wird — nur Darstellung.
//
// Die Karte „COSTS / MATERIALS" zeigt zwei sehr verschiedene Dinge untereinander: die Pauschale
// aus dem Kopf der Reparatur („Internal Cost") und jede einzeln erfasste Zeile. Eine Zeile, die
// im Haus gearbeitet wurde, trug bis hierher ihre Arbeitsart als „Kind" und in der Quellenspalte
// nur ein blasses „— own cost" — die Notiz stand daneben, die Pauschale sah fast gleich aus.
//
// Hier steht deshalb an EINER Stelle, wie so eine Zeile heißt. Es wird nichts gerechnet und
// nichts gebucht: derselbe Datensatz, dieselbe Summe, nur eine Beschriftung.
// ════════════════════════════════════════════════════════════════════════════

/** So viel von einer Zeile, wie die Beschriftung braucht. */
export interface RepairLineView {
  supplierId?: string | null;
  materialKind?: string | null;
  workType?: string | null;
  description?: string | null;
}

/**
 * Eine Arbeitszeile des eigenen Hauses: keine Materialzeile (die hat ihre eigene Art) und kein
 * Lieferant — genau das, was die Maske als „🏠 In-house / Own work" anbietet.
 */
export function isOwnWorkLine(line: RepairLineView): boolean {
  return !line.materialKind && !line.supplierId;
}

/** Aus `spare_part` wird „Spare Part" — dieselbe Schreibweise wie in der Auswahl der Maske. */
export function workTypeLabel(workType?: string | null): string {
  const t = String(workType || '').trim();
  if (!t) return 'Other';
  return t.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Was in der Quellenspalte einer Hauszeile steht. */
export const OWN_WORK_SOURCE = 'Internal labor / own work';

/** Was in der Kind-Spalte einer Hauszeile steht. */
export const OWN_WORK_KIND = '🏠 In-house';

/**
 * Die Beschreibung einer Hauszeile: erst die Arbeitsart, dann — wenn es eine gibt — die Notiz.
 * Ohne Notiz bleibt es bei der Arbeitsart; ein einsamer Gedankenstrich sagt nichts.
 */
export function ownWorkDescription(line: RepairLineView): string {
  const art = workTypeLabel(line.workType);
  const notiz = String(line.description || '').trim();
  return notiz ? `${art} — ${notiz}` : art;
}

/**
 * Zeigt die Karte die Pauschale des Kopfes? Nur wenn es sie WIRKLICH gibt. Eine Zeile über
 * 0,000 für „eigene Arbeit" beschreibt keine Arbeit — sie steht nur im Weg, wenn jede Arbeit
 * ohnehin als eigene Zeile erfasst wird.
 */
export function showsInternalCostRow(repairType: string | undefined, internalCost: number): boolean {
  if (repairType !== 'internal' && repairType !== 'hybrid') return false;
  return Number(internalCost) > 0;
}
