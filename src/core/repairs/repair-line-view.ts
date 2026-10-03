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

/** Was an einer Materialzeile erfasst wurde — genau die Schlüssel, die das Haus speichert. */
export interface RepairMaterialDetails {
  qty?: number | null;
  ct?: number | null;
  weightGrams?: number | null;
  karat?: string | null;
}

/** So viel von einer Zeile, wie die Beschriftung braucht. */
export interface RepairLineView {
  supplierId?: string | null;
  materialKind?: string | null;
  workType?: string | null;
  description?: string | null;
  materialDetails?: RepairMaterialDetails | null;
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

const zahl = (v: unknown, stellen: number): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(stellen) : '';
};

/**
 * Was an einer Materialzeile ERFASST wurde, in einem Satz: `3 × 0.25 ct` für Diamant und Stein,
 * `5.200 g · 21K` für ein Goldstück. Bis hierher stand davon nichts an der Karte — nur die
 * abgeleitete Spalte „COST/CT", und bei Gold nicht einmal die. Gespeichert war es immer
 * (`materialDetails`), gelesen hat es niemand.
 */
export function materialDetailText(line: RepairLineView): string {
  const d = line.materialDetails || {};
  const art = String(line.materialKind || '');
  if (art === 'diamond' || art === 'stone') {
    const ct = zahl(d.ct, 2);
    if (!ct || Number(d.ct) <= 0) return '';
    const menge = Number(d.qty);
    const stueck = Number.isFinite(menge) && menge > 0 ? menge : 1;
    return `${stueck} × ${ct} ct`;
  }
  if (art === 'gold') {
    const g = zahl(d.weightGrams, 3);
    const karat = String(d.karat || '').trim();
    if (!g || Number(d.weightGrams) <= 0) return karat;
    return karat ? `${g} g · ${karat}` : `${g} g`;
  }
  return '';
}

/**
 * Die Beschreibung einer Materialzeile: erst das Erfasste, dann die Notiz. Fehlt eines von
 * beiden, steht nur das andere da.
 */
export function materialDescription(line: RepairLineView): string {
  const detail = materialDetailText(line);
  const notiz = String(line.description || '').trim();
  if (detail && notiz) return `${detail} — ${notiz}`;
  return detail || notiz || '—';
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

// ── Eigene Kosten: nur, was NICHT schon über Payroll oder Expenses läuft ─────────────────
// Die eigenen Kosten (Kopf „Internal Cost", Zeile „🏠 In-house", Material ohne Lieferant) werden aus
// den Betriebskosten in die Reparatur umgebucht — der Gesamtgewinn bleibt, aber die Repair-Marge sinkt,
// während Gehalt und schon als Ausgabe gekauftes Material in den Ausgaben voll stehen bleiben. Wer dort
// das normale Gehalt oder Verbrauchsmaterial einträgt, liest dieselben Kosten an zwei Stellen. Darum
// heißt das Feld „Additional In-house Cost" und die Maske sagt es ausdrücklich.

/** Die Beschriftung der eigenen Kosten im Kopf der Reparatur. */
export const IN_HOUSE_COST_LABEL = 'ADDITIONAL IN-HOUSE COST';

/** Der Hinweis unter den eigenen Kosten. */
export const IN_HOUSE_COST_HINT =
  'Only enter extra costs for this job that are not already recorded in Payroll or Expenses. Leave blank for regular salaried staff.';

/** Bei einer Arbeit im eigenen Haus zählt Actual Cost als eigene Kosten, Estimated nie (`internalCostOnEdit`). */
export const IN_HOUSE_ESTIMATE_HINT = 'On an internal repair, Actual Cost counts as in-house cost too; Estimated is for information only.';

/** Beim Anlegen einer Arbeit im eigenen Haus ist der Betrag nur eine Schätzung. */
export const IN_HOUSE_CREATE_ESTIMATE_NOTE = 'The estimate is for information only — enter the actual extra cost on the repair later.';

/** Was unter „🏠 In-house / Own work" in der Auswahl steht. */
export const IN_HOUSE_LINE_SUBTITLE = 'No supplier — only costs not already in Payroll or Expenses';

/** Was unter einer Zeile ohne Lieferant (eigene Arbeit, Material aus eigenem Bestand) steht. */
export const IN_HOUSE_LINE_NOTE = 'Only enter costs not already recorded in Payroll or Expenses.';

/**
 * Die Beschriftung der drei Kostenfelder einer Reparatur, nach Art. Nur bei der Arbeit im eigenen Haus
 * wirken Estimated/Actual Cost als eigene Kosten (`internalCostOnEdit`); bei `hybrid` ist Estimated die
 * Werkstattgebühr, bei `external` ist `internalCost` der gespiegelte Voranschlag (nie eigene Arbeit) —
 * dort bleiben die alten Namen.
 */
export function repairCostLabels(repairType: string | null | undefined): { estimated: string; actual: string; own: string } {
  if (repairType === 'external') return { estimated: 'ESTIMATED COST', actual: 'ACTUAL COST', own: 'INTERNAL COST' };
  if (repairType === 'hybrid') return { estimated: 'WORKSHOP FEE', actual: 'ACTUAL COST', own: IN_HOUSE_COST_LABEL };
  return { estimated: 'ESTIMATED ' + IN_HOUSE_COST_LABEL, actual: 'ACTUAL ' + IN_HOUSE_COST_LABEL, own: IN_HOUSE_COST_LABEL };
}

/** Platzhalter der eigenen Kostenfelder: leer heißt keine Zusatzkosten. */
export const IN_HOUSE_COST_PLACEHOLDER = 'blank = no extra cost';
