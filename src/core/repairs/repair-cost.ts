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
export function internalCostOnEdit(input: RepairCostInput, openLineTotal = 0): number {
  const own = num(input.internalCost) ?? 0;
  if (input.repairType === 'hybrid') return own;
  if (own > 0) return own;
  // PRE-G5 — sobald Kostenzeilen offen sind, TRAGEN SIE den Aufwand: `actual_cost` ist dann ihre
  // Summe (`recomputeRepairAggregates` schreibt sie bei jeder Zeile), und ein Voranschlag ist
  // keine eigene Arbeit. Wer daraus eigene Kosten ableitet, zaehlt die Zeilen zweimal — genau der
  // Feldbefund: Zeilen 125, „Save" → `internal_cost` 125, Einstand 250, Marge −100. Eigene Arbeit
  // gibt es dann nur, wenn jemand sie ausdruecklich eintraegt (oben: `own`).
  if (Number.isFinite(openLineTotal) && openLineTotal > 0) return 0;
  // Ohne Zeilen bleibt es beim alten Vertrag: dort ist `actualCost` der tatsaechliche Aufwand.
  return num(input.actualCost) ?? num(input.estimatedCost) ?? 0;
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

// ── POST-PARITY PP-13/PP-14 — die Kosten EINER Reparatur, EINE Ableitung ─────────────────
//
// Vorher drei Rechnungen derselben Frage: `computeRepairTotalCost` (Marge, Einstand eigener Ware),
// `repairInvoiceLineCost` (Rechnungseinstand = internalCost + Zeilen) und der Einzelweg bei „ready".
// Bei „external" ist `internalCost` der gespiegelte Voranschlag (`internalCostOnCreate`) — die
// Rechnung zählte ihn NEBEN der Werkstattzeile, dazu die Ausgabe: dreimal. Jetzt drei Teile, jeder
// genau EINE Ausgabe (`repair-cost-booking`):
//   • own   — die eigenen Kosten (`internalCost`), außer bei „external" (dort ist es der Spiegel);
//   • lines — jede offene Kostenzeile (Werkstatt oder im Haus) mit ihrem Betrag;
//   • fee   — nur ohne Zeilen und mit verknüpfter Werkstatt (Altbestand vor den Zeilen): die Gebühr.
// Ohne Zeile und ohne Werkstatt ist ein Voranschlag nur ein Voranschlag, keine Kosten.
export interface RepairCostParts { own: number; lines: number; fee: number; total: number }
export function repairCostParts(
  r: { repairType?: string | null; internalCost?: number | null; estimatedCost?: number | null; workshopSupplierId?: string | null },
  openLineTotal = 0,
): RepairCostParts {
  const internal = num(r.internalCost) ?? 0;
  const own = r.repairType === 'external' ? 0 : internal;
  const lines = Number.isFinite(openLineTotal) && openLineTotal > 0 ? openLineTotal : 0;
  const ext = r.repairType === 'external' || r.repairType === 'hybrid';
  const fee = lines === 0 && ext && !!r.workshopSupplierId
    ? (r.repairType === 'hybrid' ? (num(r.estimatedCost) ?? 0) : ((num(r.estimatedCost) || 0) || internal))
    : 0;
  return { own, lines, fee, total: own + lines + fee };
}

// ── CENTRAL-C3H — die Kosten, die auf die RECHNUNGSZEILE einer Reparatur gehoeren ────────
//
// Gemessen, nicht vermutet: das Haus hatte hier ZWEI Ableitungen.
//
//   • `createCombinedRepairInvoice` schreibt `internalCost + Summe der offenen Arbeitszeilen`
//     als Einstand — mit einem ausdruecklichen Kommentar, dass genau das der Fix gegen eine
//     stille Margendrift war.
//   • Der Einzelweg auf der Detailseite schreibt `repair.internalCost` und sonst nichts.
//
// Dieselbe Reparatur, zwei Wege, zwei Einstaende: sobald Arbeitszeilen im Spiel sind, weist der
// Einzelweg einen zu kleinen Einstand aus und die Rechnung einen zu hohen Rohertrag. Das ist
// kein Fernauftrags-Problem — es war schon vorher falsch. Der Fernauftrag faehrt den
// gebuendelten Weg; damit lokal und fern nicht wieder auseinanderlaufen, benutzen jetzt BEIDE
// diese eine Ableitung.
export function repairInvoiceLineCost(
  input: { internalCost?: number | null },
  openLineTotal = 0,
): number {
  return (num(input.internalCost) ?? 0) + (Number.isFinite(openLineTotal) ? openLineTotal : 0);
}
