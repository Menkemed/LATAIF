// ═══════════════════════════════════════════════════════════
// LATAIF — D1: Replay-Plan für historische Rechnungszahlungen (rein)
// ═══════════════════════════════════════════════════════════
//
// Warum das ein eigener, reiner Kern ist: `backfill.ts` haengt an DB, Stores und Sync und ist
// damit headless nicht importierbar. Die EINE Frage, auf die es hier ankommt — wie viel einer
// historischen Zahlung gegen ACCOUNTS_RECEIVABLE gehoert und wie viel in Kundenguthaben —
// ist aber reine Arithmetik und gehoert deshalb in ein Modul, das ein Node-Gate direkt
// importieren kann.
//
// Der Fehler, den dieser Plan schliesst (D1): der Replay rief `postInvoicePayment` ohne
// `openRemainder` auf. `computePaymentSplit` legt dann den GESAMTEN Betrag auf AR — eine
// historische Ueberzahlung (Rechnung 100, Zahlung 120) landete als AR = -20 BD statt als
// 20 BD redeembares Guthaben.
//
// Die Rekonstruktion: `invoices.paid_amount` ist der Stand NACH allen Zahlungen und damit
// unbrauchbar. Also je Rechnung chronologisch durchlaufen und den verbrauchten Rest
// mitzaehlen. Bereits ledgerisierte Zahlungen werden nicht neu gepostet, zaehlen aber in die
// laufende Summe: wirtschaftlich haben sie den offenen Rest genauso verbraucht — wer sie
// ueberspringt, haelt den Rest kuenstlich hoch und verschenkt den Split der naechsten Zahlung.

import { computePaymentSplit, FIL_EPSILON } from './payment-split.ts';

/** Eine Zahlungszeile, wie sie der Backfill aus payments ⋈ invoices liest. */
export interface BackfillPaymentRow {
  id: string;
  invoiceId: string;
  amount: number;
  method: string;
  /** Bruttobetrag DER RECHNUNG (nicht der Zahlung). */
  grossAmount: number;
}

export interface BackfillPaymentDecision {
  id: string;
  invoiceId: string;
  /** true → bereits ledgerisiert, es wird nichts gepostet (zaehlt aber in den Rest). */
  skipped: boolean;
  /** Offener Rechnungsrest VOR dieser Zahlung. */
  openRemainder: number;
  /** Teil, der gegen ACCOUNTS_RECEIVABLE gebucht wird. */
  arCredit: number;
  /** Teil, der als CUSTOMER_CREDIT gebucht wird (0, wenn keine Ueberzahlung). */
  overpayExcess: number;
  /** true → fuer diese Zahlung muss eine customer_credits-Row existieren. */
  needsCreditRow: boolean;
}

/**
 * @param rows            Zahlungen, JE RECHNUNG chronologisch sortiert (der Aufrufer sortiert
 *                        im SQL; die Reihenfolge innerhalb einer Rechnung ist bedeutungstragend).
 * @param alreadyPosted   Ist diese Zahlung schon (auch reversiert) ledgerisiert?
 */
export function planInvoicePaymentBackfill(
  rows: BackfillPaymentRow[],
  alreadyPosted: (paymentId: string) => boolean
): BackfillPaymentDecision[] {
  const paidBefore = new Map<string, number>();
  const out: BackfillPaymentDecision[] = [];

  for (const r of rows) {
    const already = paidBefore.get(r.invoiceId) || 0;
    paidBefore.set(r.invoiceId, already + r.amount);

    const openRemainder = Math.max(0, r.grossAmount - already);
    const { arCredit, creditCredit } = computePaymentSplit(r.amount, openRemainder, r.method);
    const skipped = alreadyPosted(r.id);

    out.push({
      id: r.id,
      invoiceId: r.invoiceId,
      skipped,
      openRemainder,
      arCredit,
      overpayExcess: creditCredit,
      needsCreditRow: !skipped && creditCredit > FIL_EPSILON,
    });
  }
  return out;
}
