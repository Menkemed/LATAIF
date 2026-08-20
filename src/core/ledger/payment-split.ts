// ═══════════════════════════════════════════════════════════
// LATAIF — Überzahlungs-Split (SSOT, rein)
// ═══════════════════════════════════════════════════════════
//
// Reiner Kern ohne DB-, Store- oder Tauri-Imports, damit ihn sowohl der Live-Pfad
// (`posting.postInvoicePayment` / `invoiceStore.recordPayment`) als auch der Replay-Pfad
// (`backfill-payment-plan`) benutzen können — und damit ihn ein Node-Gate direkt importieren
// kann. `posting.ts` re-exportiert `computePaymentSplit` unverändert weiter; für Aufrufer
// ändert sich nichts.

/** BHD hat 3 Dezimalen (Fils) — jede Geldgröße wird auf diese Auflösung gerundet. */
export const ROUND = (n: number): number => Math.round(n * 1000) / 1000;

/** Unter einem halben Fil ist ein Betrag effektiv null. */
export const FIL_EPSILON = 0.005;

/**
 * Slice 3 — Ueberzahlungs-Split: der Teil einer Zahlung UEBER dem offenen Invoice-Rest
 * (openRemainder = gross - bereits-bezahlt) gehoert NICHT auf ACCOUNTS_RECEIVABLE (das
 * triebe AR negativ = Phantom-Forderung), sondern auf CUSTOMER_CREDIT (redeembare
 * Verbindlichkeit). Rounding-SICHER: creditCredit per Subtraktion, sodass
 * arCredit + creditCredit === ROUND(amount) (sonst postEntries-Imbalance). EINE Quelle —
 * recordPayment leitet die customer_credits-Row-Hoehe aus demselben Helper ab, damit
 * Domain-Row und Ledger-Bein nie um einen Fil divergieren. openRemainder === undefined
 * (Alt-Aufrufer / kein Split gewuenscht) ODER method 'credit' (Guthaben-Einloesung cappt
 * in applyCreditToInvoice bereits, ein Split waere self-referential DR/CR CUSTOMER_CREDIT)
 * → arCredit = voller Betrag, creditCredit 0 (unveraendertes 2-Bein-Verhalten).
 */
export function computePaymentSplit(
  amount: number,
  openRemainder: number | undefined,
  method: string
): { arCredit: number; creditCredit: number } {
  const amt = ROUND(amount);
  if (openRemainder === undefined || method === 'credit') return { arCredit: amt, creditCredit: 0 };
  const arCredit = Math.min(amt, Math.max(0, ROUND(openRemainder)));
  return { arCredit, creditCredit: ROUND(amt - arCredit) };
}
