// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Kostenkorrektur — die Art einer Lieferanten-Überzahlung aus einer gesenkten/gelöschten Order-Kostenzeile.
//
// Beide Arten sind EINE supplier_credits-Zeile ohne source_purchase_id/source_return_id mit EINER Buchung
// (ORDER_COST_OVERPAY: DR SUPPLIER_CREDIT / CR ACCOUNTS_PAYABLE, gekeyt auf die Zeile):
//   • Guthaben       — status 'OPEN': verrechenbar wie jedes Lieferantenguthaben (Einkauf / Ausgabe „Credit").
//   • Rückforderung  — status 'REFUND_DUE': NICHT verrechenbar, offen bis der Lieferant zahlt („Record Repayment",
//                      DR Kasse/Bank/Benefit / CR SUPPLIER_CREDIT); voll zurückgezahlt → 'REFUNDED'.
// Spiegel der Kunden-Seite (MIXED-INVOICE P1c, customer_credits REFUND_DUE/REFUNDED). Ohne Schemaänderung.
// ════════════════════════════════════════════════════════════════════════════

/** Die Wahl bei einer echten Überzahlung. */
export type CostOverpayChoice = 'credit' | 'refund';
export const COST_OVERPAY_CHOICES: readonly CostOverpayChoice[] = ['credit', 'refund'];

/** supplier_credits.status einer offenen bzw. vollständig zurückgezahlten Rückforderung. */
export const ORDER_COST_CLAIM_OPEN = 'REFUND_DUE';
export const ORDER_COST_CLAIM_DONE = 'REFUNDED';

/** Ist diese supplier_credits-Zeile eine Rückforderung aus einer Order-Kostenkorrektur? */
export function isOrderCostClaim(r: Record<string, unknown>): boolean {
  const st = String(r.status ?? '');
  return (st === ORDER_COST_CLAIM_OPEN || st === ORDER_COST_CLAIM_DONE) && !r.source_return_id && !r.source_purchase_id;
}
