// CENTRAL-C3F FINAL — die Kostenableitungen einer Reparatur, an EINER Stelle.
//
// Sie standen bisher in den Bildschirmen: die Aufnahme leitet `internalCost` ab, bevor sie
// `createRepair` ruft, und die Detailseite leitet beim Speichern `internalCost`, die Gesamtkosten
// und daraus die Marge ab. `createRepair` und `updateRepair` selbst rechnen nichts davon — sie
// schreiben, was sie bekommen.
//
// Solange es genau einen Bildschirm gab, war das unauffällig. Mit einem zweiten Rechner ist es
// ein Vertrag ohne Heimat: derselbe Vorgang, zweimal getippt, zweimal leicht anders. Gemessen an
// genau dieser Stelle: bei `repairType: 'external'` mit einem Voranschlag und ohne eigene
// Kostenangabe speichert die Aufnahme am Primary `internalCost = estimatedCost`, der Fernweg
// speicherte `0`. Dieselbe Eingabe, zwei verschiedene Zeilen.
//
// Deshalb liegt die Ableitung jetzt hier — und wird von BEIDEN Bildschirmen, dem Fernauftrag und
// der Vorschau des Clients benutzt. Das Modul ist bewusst rein: keine Datenbank, kein Store,
// keine Anmeldung. Es darf deshalb auch der DB-lose Client laden.
//
// Die beiden Ableitungen sind ABSICHTLICH verschieden, und das ist kein Versehen des Hauses:
//
//  • **Bei der Aufnahme** weiß man den tatsächlichen Aufwand noch nicht. Ein Voranschlag für eine
//    Fremdarbeit IST hier die interne Kostenerwartung — deshalb der Rückfall auf `estimatedCost`,
//    aber nur bei `external`/`hybrid`. Bei einer Arbeit im eigenen Haus gibt es keinen Grund, den
//    Voranschlag als eigene Kosten zu verbuchen.
//  • **Beim Ändern** ist der tatsächliche Aufwand oft bekannt. Dann gewinnt `actualCost`, sonst
//    der Voranschlag — und `hybrid` zählt beide Teile getrennt, weil `estimatedCost` dort die
//    Werkstattgebühr ist und NICHT die eigene Arbeit.

/** Was für eine Reparatur es ist. Andere Werte verhalten sich wie `internal`. */
export type RepairType = 'internal' | 'external' | 'hybrid' | string | undefined | null;

export interface RepairCostInput {
  repairType?: RepairType;
  /** Voranschlag. Bei `hybrid` ist das die Werkstattgebühr, nicht die eigene Arbeit. */
  estimatedCost?: number | null;
  /** Der tatsächliche Aufwand, sobald er bekannt ist. */
  actualCost?: number | null;
  /** Was jemand ausdrücklich als eigene Kosten eingetragen hat. */
  internalCost?: number | null;
}

const num = (v: number | null | undefined): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Die eigenen Kosten BEI DER AUFNAHME — wortgleich zu `RepairList.handleCreate`.
 *
 * Bei einer Fremd- oder Mischarbeit gilt der Voranschlag als Erwartung, wenn niemand etwas
 * anderes eingetragen hat. Bei einer Arbeit im eigenen Haus zählt nur, was eingetragen wurde.
 */
export function internalCostOnCreate(input: RepairCostInput): number {
  const own = num(input.internalCost) ?? 0;
  const estimated = num(input.estimatedCost) ?? 0;
  const t = input.repairType;
  if (t === 'external' || t === 'hybrid') return own || estimated || 0;
  return own || 0;
}

/**
 * Die eigenen Kosten BEIM ÄNDERN — wortgleich zu `RepairDetail.handleSave`.
 *
 * Hier gewinnt der tatsächliche Aufwand, sobald er dasteht. Bei `hybrid` gibt es diesen Rückfall
 * ausdrücklich NICHT: dort ist `estimatedCost` die Werkstattgebühr, und sie in die eigenen Kosten
 * zu spiegeln zählte sie in der Marge zweimal.
 */
export function internalCostOnEdit(input: RepairCostInput): number {
  const own = num(input.internalCost) ?? 0;
  if (input.repairType === 'hybrid') return own;
  const derived = num(input.actualCost) ?? num(input.estimatedCost) ?? 0;
  return own > 0 ? own : derived;
}

/** Die Gesamtkosten, gegen die die Marge gerechnet wird. Bei `hybrid` beide Teile. */
export function totalRepairCost(input: RepairCostInput): number {
  const effective = internalCostOnEdit(input);
  if (input.repairType === 'hybrid') return effective + (num(input.estimatedCost) ?? 0);
  return effective;
}

/**
 * Die Marge. `null`, solange kein Kundenpreis feststeht — das ist eine andere Aussage als „0",
 * und die Aufnahme trifft sie ausdrücklich nicht: sie speichert gar keine Marge.
 */
export function repairMargin(input: RepairCostInput & { chargeToCustomer?: number | null }): number | null {
  const charge = num(input.chargeToCustomer);
  if (charge === null) return null;
  return charge - totalRepairCost(input);
}
