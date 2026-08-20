// ═══════════════════════════════════════════════════════════
// LATAIF — D1: Ausführung EINER geplanten Replay-Zahlung (injizierbar)
// ═══════════════════════════════════════════════════════════
//
// Der Live-Pfad (`recordPayment`) legt Zahlung und `customer_credits` in EINE Transaktion, sobald
// eine Überzahlung Guthaben erzeugt. Der Replay muss das genauso tun: bricht der Guthaben-INSERT
// ab, nachdem `postInvoicePayment` das CR-CUSTOMER_CREDIT-Bein geschrieben hat, bliebe ein
// Ledger-Bein ohne Domain-Row zurück — genau die Divergenz, die der geteilte Split-Helper
// verhindern soll.
//
// Warum als eigenes Modul mit injizierten Abhängigkeiten: `backfill.ts` hängt an DB, Stores und
// Sync und ist headless nicht importierbar. Hier ist die Klammer isoliert und lässt sich gegen
// eine echte sql.js-Datenbank mit echten BEGIN/COMMIT/ROLLBACK testen — samt erzwungenem Fehler
// mitten im Vorgang.

import type { BackfillPaymentDecision } from './backfill-payment-plan.ts';

export interface PaymentApplyDeps {
  /** Bucht die Zahlung ins Ledger (AR-Bein + ggf. CR-CUSTOMER_CREDIT-Bein). */
  postPayment: (d: BackfillPaymentDecision) => void;
  /** Gibt es für diese Zahlung schon eine Überzahlungs-Guthaben-Row? */
  creditRowExists: (paymentId: string) => boolean;
  /** Schreibt die `customer_credits`-Row zur Überzahlung. */
  insertCreditRow: (d: BackfillPaymentDecision) => void;
  inTransaction: () => boolean;
  begin: () => void;
  commit: () => void;
  rollback: () => void;
}

/**
 * Führt eine geplante Zahlung aus. Wirft weiter, was die Abhängigkeiten werfen — der Aufrufer
 * (`safeStep`) zählt den Fehlschlag. Vorher ist der Zustand zurückgerollt.
 */
export function applyPaymentDecision(d: BackfillPaymentDecision, deps: PaymentApplyDeps): void {
  // Kein zweites BEGIN, wenn schon eine Transaktion läuft (gleiche Regel wie recordPayment).
  const ownTx = d.needsCreditRow && !deps.inTransaction();
  if (ownTx) deps.begin();
  try {
    deps.postPayment(d);
    // Nur wenn die Row für genau diese Zahlung noch fehlt — darauf ruht die Idempotenz.
    if (d.needsCreditRow && !deps.creditRowExists(d.id)) deps.insertCreditRow(d);
    if (ownTx) deps.commit();
  } catch (err) {
    if (ownTx) deps.rollback();
    throw err;
  }
}
