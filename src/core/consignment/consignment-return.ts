// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6B — „Return" einer Kommission (unverkauft zurück an den Einlieferer).
//
// Drei Einstiege (Detail, Liste, Einlieferer) — EINE Regel: nur eine AKTIVE, unverkaufte Kommission
// geht so zurück. Die Fernbuchung prüfte das schon; der lokale Weg der Liste und des Einlieferers
// rief `markReturned` ohne jede Prüfung (die Regel stand nur in der Knopfbedingung). Jetzt fragen
// beide Wege dieselbe Funktion. Eine Rückgabe NACH dem Verkauf ist ein anderer Vorgang
// (`markReturnedAfterSale`) und bleibt davon unberührt.
// ════════════════════════════════════════════════════════════════════════════

export const CONSIGNMENT_NOT_ACTIVE = 'CONSIGNMENT_NOT_ACTIVE';

export function consignmentReturnBlocker(status: unknown): typeof CONSIGNMENT_NOT_ACTIVE | null {
  return String(status ?? '') === 'active' ? null : CONSIGNMENT_NOT_ACTIVE;
}

export function consignmentReturnMessage(status: unknown): string {
  return `this consignment is "${String(status ?? '')}" — only an unsold one is handed back this way`;
}

/** Der lokale Riegel: wirft mit `code`, wenn die Rückgabe so nicht geht. */
export function assertConsignmentReturnable(status: unknown): void {
  const b = consignmentReturnBlocker(status);
  if (b) throw Object.assign(new Error(consignmentReturnMessage(status)), { code: b });
}

/** Der Rumpf der Fernbuchung `consignments.mark_returned` — für jeden Einstieg derselbe. */
export function consignmentReturnBody(consignmentId: string, expectedRevision: number): Record<string, unknown> {
  return { consignmentId, expectedRevision };
}
