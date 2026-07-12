// ═══════════════════════════════════════════════════════════
// LATAIF — Credit / Overpayment teardown logic (B2)
// ═══════════════════════════════════════════════════════════
//
// Reine, DB-freie Entscheidungslogik für zwei Credit-Teardown-Pfade, damit sie headless
// testbar ist (Muster wie core/import, core/sync). Die Stores (invoiceStore.editInvoice,
// creditNoteStore.deleteCreditNote) liefern die vorhandenen customer_credits-Zeilen und
// führen die zurückgegebene Entscheidung aus.
//
// Hintergrund (B0-Audit):
//   A) editInvoice buchte den Gesamt-Überschuss `SUM(payments) − newGross` erneut als
//      Store-Guthaben, OHNE ein bereits bestehendes 'overpayment'-Guthaben (aus dem
//      recordPayment-Split) zu berücksichtigen → doppeltes einlösbares Guthaben + Phantom-AR.
//      Fix: nur das DELTA über das bestehende (unbenutzte) Overpayment-Guthaben nachbuchen.
//   B) deleteCreditNote reversierte den Ledger, ließ aber die unbenutzte
//      customer_credits-Zeile (source_type='sales_return') stehen → einlösbares Phantom-Guthaben.
//      Fix: die unbenutzte Domain-Zeile mitlöschen (benutztes bleibt geblockt).

const EPS = 0.005; // BHD 3-Dezimalen → ein halbes Fil = effektiv null

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export interface ExistingCredit {
  id: string;
  amount: number;
  usedAmount: number;
}

// ─────────────────────────────────────────────────────────────
// A) editInvoice — Überzahlungs-Guthaben neu berechnen (nur Delta)
// ─────────────────────────────────────────────────────────────
export type OverpaymentPlan =
  | { blocked: true; reason: 'OVERPAYMENT_CREDIT_USED' | 'OVERPAYMENT_CREDIT_WOULD_SHRINK' }
  | { blocked: false; additionalCredit: number };

/**
 * Bestimmt, wie viel ZUSÄTZLICHES Store-Guthaben editInvoice nach reverse+repost buchen darf,
 * ohne ein bereits bestehendes (unbenutztes) 'overpayment'-Guthaben doppelt zu zählen.
 *
 * - Ist ein bestehendes Overpayment-Guthaben bereits (teil-)eingelöst → BLOCK (nicht still
 *   reduzieren/löschen).
 * - additionalCredit = max(0, (newPaid − newGross) − Σ bestehender Overpayment-Guthaben).
 * - Würde der Edit ein bestehendes (unbenutztes) Guthaben unter seinen Betrag schrumpfen
 *   (Delta < 0) → BLOCK (die saubere Reduktion müsste das PAYMENT-gebuchte Ledger-Bein
 *   anfassen; bewusst außerhalb dieses Slices).
 *
 * Idempotent: das bestehende 'overpayment'-Guthaben bleibt über mehrere Edits stabil
 * (PAYMENT-Quelle, von reverseSource('INVOICE') nicht angefasst), daher liefert derselbe
 * Edit-Zustand denselben additionalCredit.
 */
export function planEditOverpayment(args: {
  newPaid: number;
  newGross: number;
  existingOverpaymentCredits: ExistingCredit[];
}): OverpaymentPlan {
  const { newPaid, newGross, existingOverpaymentCredits } = args;

  if (existingOverpaymentCredits.some((c) => c.usedAmount > EPS)) {
    return { blocked: true, reason: 'OVERPAYMENT_CREDIT_USED' };
  }

  const existingTotal = existingOverpaymentCredits.reduce((s, c) => s + Math.max(0, c.amount), 0);
  const overpay = Math.max(0, newPaid - newGross);
  const delta = overpay - existingTotal;

  if (delta < -EPS) {
    return { blocked: true, reason: 'OVERPAYMENT_CREDIT_WOULD_SHRINK' };
  }
  return { blocked: false, additionalCredit: delta > EPS ? round3(delta) : 0 };
}

// ─────────────────────────────────────────────────────────────
// B) deleteCreditNote — Store-Guthaben der Credit Note abbauen
// ─────────────────────────────────────────────────────────────
export type CreditTeardownPlan =
  | { blocked: true; reason: 'CREDIT_NOTE_CREDIT_USED' }
  | { blocked: false; deleteCreditIds: string[] };

/**
 * Entscheidet den Abbau der aus einer Credit Note entstandenen customer_credits-Zeilen.
 * - Ist irgendeine (teil-)eingelöst → BLOCK (kein stiller Verlust bereits genutzten Guthabens).
 * - Sonst: alle (unbenutzten) Zeilen löschen → kein Phantom-Guthaben nach dem Ledger-Reverse.
 */
export function planCreditNoteCreditTeardown(credits: ExistingCredit[]): CreditTeardownPlan {
  if (credits.some((c) => c.usedAmount > EPS)) {
    return { blocked: true, reason: 'CREDIT_NOTE_CREDIT_USED' };
  }
  return { blocked: false, deleteCreditIds: credits.map((c) => c.id) };
}
