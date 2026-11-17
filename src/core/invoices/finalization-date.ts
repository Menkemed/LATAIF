// ════════════════════════════════════════════════════════════════════════════
// FINAL-INVOICE-DATE — die EINE Regel für das Datum einer Endrechnung (ohne Abhängigkeiten).
//
// Eine Rechnung bekommt ihre Endnummer, sobald sie erstmals voll bezahlt ist. Im selben Schritt wird
// ihr Datum festgehalten (`invoices.final_issued_at`): der Tag der Vollzahlung = das späteste
// tatsächliche Zahlungsdatum (`received_at`, nicht der Eingabetag) der Zahlungen, die sie in diesem
// Augenblick voll machen — genau die Regel, nach der der NBR-Export schon immer datiert. Danach bleibt
// es fest: spätere Zahlungen, Korrekturen, Löschungen oder ein Rückfall auf „teilbezahlt" ändern es nicht.
//
// Endrechnungen von vor diesem Vertrag haben kein festgehaltenes Datum; für sie gilt — unverändert —
// die Berechnung aus den Zahlungen. So zeigen NBR-Export, VAT-Sperre, Liste, Detailseite und PDF
// immer denselben Tag.
// ════════════════════════════════════════════════════════════════════════════

export interface DatedPayment { receivedAt: string }

export interface FinalDateInvoice {
  finalIssuedAt?: string | null;
  issuedAt?: string | null;
  createdAt?: string | null;
}

/** Tag der Vollzahlung aus den Zahlungen: spätestes Zahlungsdatum; ohne Zahlungszeilen der Rechnungstag. */
export function fullPaymentDate(inv: FinalDateInvoice, payments?: readonly DatedPayment[]): string {
  let max = '';
  for (const p of payments ?? []) if (p.receivedAt && p.receivedAt > max) max = p.receivedAt;
  return max || inv.issuedAt || inv.createdAt || '';
}

/** Datum der Endrechnung: das festgehaltene — sonst (Altbestand) wie bisher aus den Zahlungen. */
export function finalizationDate(inv: FinalDateInvoice, payments?: readonly DatedPayment[]): string {
  return inv.finalIssuedAt || fullPaymentDate(inv, payments);
}
