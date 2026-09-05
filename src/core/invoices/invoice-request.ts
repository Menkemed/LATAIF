// CENTRAL-C3B — was der Client beim Speichern tatsächlich schickt.
//
// Diese Funktion ist absichtlich winzig und liegt absichtlich NICHT in der Komponente: sie ist die
// Stelle, an der sich beweisen lässt, dass die Oberfläche nichts Abgeleitetes mitschickt. Ein Test
// kann sie neben `parseInvoicePayload` legen — den Prüfer des Primary — und zeigen, dass genau das
// herauskommt, was dort erlaubt ist: die Auswahl eines Menschen, sonst nichts.
//
// Wäre sie im Formular verstreut, hinge diese Zusage an einem Blick in JSX. So hängt sie an einer
// Funktion, die man ausführen kann.

export interface InvoiceDraftLine {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoiceDraft {
  customerId: string;
  issuedDate: string;
  notes?: string;
  lines: InvoiceDraftLine[];
}

/**
 * Baut den Auftragsrumpf. Kein Netto, keine MwSt, keine Zeilensumme, keine Einstandskosten, keine
 * Nummer — all das rechnet der Primary. Das Steuerschema bleibt `auto`: welches gilt, entscheidet
 * das Produkt, und das Produkt kennt nur der Primary.
 */
export function buildInvoiceRequest(draft: InvoiceDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    customerId: draft.customerId,
    issuedDate: draft.issuedDate,
    lines: draft.lines.map((l) => ({
      productId: l.productId,
      quantity: Math.max(1, Math.trunc(l.quantity)),
      unitPrice: l.unitPrice,
      scheme: 'auto',
    })),
  };
  const notes = (draft.notes ?? '').trim();
  if (notes) payload.notes = notes;
  return payload;
}
