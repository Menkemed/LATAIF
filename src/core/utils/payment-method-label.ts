// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Review — die Anzeige einer Zahlart (Rechnungszahlung) an EINER Stelle.
// Vorher stand im NBR-Export der Rohwert („order_deposit", „bank_transfer"), in der Rechnungsansicht eine eigene Liste.
// 'order_deposit' ist die ANRECHNUNG einer Order-Anzahlung (kein neuer Geldeingang; das Geld kam am Zahltag der Anzahlung).
// ════════════════════════════════════════════════════════════════════════════
const LABELS: Readonly<Record<string, string>> = {
  cash: 'Cash', bank: 'Bank', bank_transfer: 'Bank Transfer', card: 'Card', benefit: 'Benefit', other: 'Other',
  credit: 'Store Credit', order_deposit: 'Order deposit',
  // CUSTOMER ACCOUNT B1 — Verrechnung mit einem Darlehen „We Borrowed" desselben Kunden (kein Geld).
  debt_offset: 'Debt offset',
  // B2/B3 — Verrechnung mit einem offenen Einkauf derselben Person (kein Geld); am Einkauf heißt die Zeile 'offset'.
  purchase_offset: 'Purchase offset', offset: 'Offset (no cash)',
  // v0.8.101 S4 — Verrechnung mit einem auszahlbaren Partnerguthaben derselben Person (kein Geld).
  partner_offset: 'Partner offset',
};

export function paymentMethodLabel(method: string | null | undefined): string {
  const m = String(method ?? '').trim();
  if (!m) return '—';
  return LABELS[m] ?? (m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, ' '));
}

/**
 * v0.8.100 — die Anzeige in der Rechnungsansicht: „Other" wird (unverändert) auf Bank gebucht und steht im Banking unter Bank.
 * Damit die Rechnung nicht etwas anderes sagt, nennt sie das Konto dazu. Der NBR-Export behält `paymentMethodLabel`.
 */
export function paymentMethodDisplay(method: string | null | undefined): string {
  const l = paymentMethodLabel(method);
  return String(method ?? '').trim() === 'other' ? `${l} · booked to Bank` : l;
}
