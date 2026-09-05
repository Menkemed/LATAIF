// CENTRAL-C3D — der Rumpf eines Änderungsauftrags, ohne JSX drumherum.
//
// Er steht in einem eigenen Modul, weil er der eigentliche Vertrag der Rechnungsansicht ist: was
// ein zweiter Rechner über eine bestehende Rechnung sagen darf. Ein Vertrag, den man nur im
// Browser laden kann, ist nicht prüfbar.
//
// Drei Entscheidungen stecken darin:
//   • Die GESEHENE Fassung fährt mit (`expectedRevision`). Ohne sie wäre jede Änderung ein
//     blindes Überschreiben dessen, was der Primary inzwischen getan hat. Eine Ganzzahl, kein
//     Zeitstempel: zwei Änderungen in derselben Millisekunde trügen denselben Zeitstempel.
//   • Eine Menge ist eine ganze Zahl ≥ 1, ein Preis ist nicht negativ — dieselbe Regel wie beim
//     Anlegen, und der Primary weist beides ohnehin ab.
//   • Eine leere Notiz wird gar nicht erst mitgeschickt: sie wäre eine Änderung, die niemand
//     gewollt hat.

export interface InvoiceDraftLine {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export function buildUpdateRequest(args: {
  id: string;
  expectedRevision: number;
  reason: string;
  customerId: string;
  lines: InvoiceDraftLine[];
  notes?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: args.id,
    // Genau die Zahl, die `invoices.get` genannt hat — der Client wählt sie nicht.
    expectedRevision: args.expectedRevision,
    reason: args.reason.trim(),
    customerId: args.customerId,
    lines: args.lines.map((l) => ({
      productId: l.productId,
      quantity: Math.max(1, Math.trunc(l.quantity)),
      unitPrice: Math.max(0, l.unitPrice),
    })),
  };
  if (args.notes !== undefined && args.notes.trim() !== '') body.notes = args.notes;
  return body;
}
