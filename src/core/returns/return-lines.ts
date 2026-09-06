// CENTRAL-C3H — was eine Rueckgabezeile aus einer Rechnungszeile macht. EINE Quelle.
//
// Diese Ableitung stand in `InvoiceDetail.handleCreateSalesReturn` und nirgends sonst:
//
//   • Der Stueckpreis der Rueckgabe ist der BRUTTO-Stueckpreis der Rechnungszeile
//     (`lineTotal / quantity`) — das, was der Kunde wirklich pro Stueck gezahlt hat, nicht der
//     Nettopreis. Wer den Nettopreis nimmt, erstattet zu wenig.
//   • Die Steuer wird ANTEILIG zum zurueckgegebenen Wert genommen. Das funktioniert bei VAT_10
//     und bei MARGIN gleich, ohne das Steuerschema zweimal zu kennen.
//
// Ein zweiter Rechner darf das nicht nachtippen — er darf sogar den Preis gar nicht schicken:
// waere er ein Feld des Rumpfes, koennte ein Client eine Rueckgabe zu einem Preis buchen, den es
// auf der Rechnung nie gab. Der Client sagt WELCHE Zeile und WIE VIELE Stueck; alles andere
// rechnet das Haus aus der Rechnung, mit dieser Funktion.

export interface InvoiceLineForReturn {
  quantity?: number | null;
  lineTotal?: number | null;
  vatAmount?: number | null;
}

export interface ReturnLineAmounts {
  quantity: number;
  /** Brutto je Stueck — inklusive Steuer. */
  unitPrice: number;
  /** Der Steueranteil DIESER Rueckgabe, anteilig am Wert. */
  vatAmount: number;
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Der Brutto-Stueckpreis, wie ihn die Rueckgabe-Maske vorschlaegt. */
export function grossUnitPrice(line: InvoiceLineForReturn): number {
  const qty = Math.max(1, n(line.quantity) || 1);
  return n(line.lineTotal) / qty;
}

/** Preis und Steuer einer Rueckgabe von `quantity` Stueck dieser Rechnungszeile. */
export function returnLineAmounts(line: InvoiceLineForReturn, quantity: number): ReturnLineAmounts {
  const qty = Number.isFinite(quantity) ? quantity : 0;
  const unitPrice = grossUnitPrice(line);
  const returnedTotal = qty * unitPrice;
  const origTotal = n(line.lineTotal);
  const vatAmount = origTotal > 0 ? (n(line.vatAmount) * returnedTotal) / origTotal : 0;
  return { quantity: qty, unitPrice, vatAmount };
}
