// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5A — die Anzahlung, die mit der Rechnung mitgeht (EIN Ort für Maske und Fernbefehl).
//
// CUSTOM-ORDER K2 — seit K2 wird die Anzahlung ANGERECHNET (`order-deposit-apply`):
//   • der Geldeingang bleibt, wie er war (Order-Zahlung, Buchung, Kartengebühr, Banking am Zahlungstag);
//   • die Rechnung bekommt je Order-Zahlung eine Zahlung der Art 'order_deposit' zum Rechnungstag
//     (Soll CUSTOMER_DEPOSITS / Haben AR), keine Gebühr, kein Geld;
//   • ein Überzahlungsanteil wird — wie bisher — EINE einlösbare Gutschrift (Split der Zahlung);
//   • ein Rest für eine spätere Teilrechnung bleibt offen an seiner Order-Zahlung;
//   • ohne Anzahlung bleibt die Rechnung offen; eine Barzahlung wird nie erfunden.
// Vorher wurde die Anzahlung zurückgedreht und als neue Zahlung von HEUTE gebucht (neue Kartengebühr, Banking
// am Umwandlungstag), und nach einem Storno erfand die erneute Umwandlung eine Barzahlung.
// Die Namen bleiben, damit Maske und Fernbefehl unverändert dieselbe Funktion rufen.
// `appliedAtIso` ist der Tag der Anrechnung = das Rechnungsdatum.
// ════════════════════════════════════════════════════════════════════════════
import { currentBranchId } from '@/core/db/helpers';
import { applyOrderDepositsToInvoice, assertDepositApplicationAllowed } from '@/core/orders/order-deposit-apply';

/**
 * VAT-PERIOD-LOCK — stellte die Anrechnung die Rechnung an diesem Tag in einem zugemachten Quartal voll bezahlt?
 * Und: ein Altauftrag mit Kopf-Anzahlung ohne jede Zahlungszeile wird abgelehnt. Rein lesend, vor dem ersten Schreiben.
 */
export function assertOrderCarryOverMayFinalize(orderId: string, invoiceTotal: number, _totalPaid?: number, appliedAtIso: string = new Date().toISOString()): void {
  assertDepositApplicationAllowed(orderId, invoiceTotal, appliedAtIso, currentBranchId());
}

/** Rechnet die offenen Anzahlungen der Order auf die Rechnung an. `_totalPaid` braucht es nicht mehr (Altsignatur). */
export function carryOverOrderPaymentsToInvoice(
  invoiceId: string, orderId: string, orderNumber: string, invoiceTotal: number, _totalPaid?: number,
  appliedAtIso: string = new Date().toISOString(),
): void {
  applyOrderDepositsToInvoice({ invoiceId, orderId, orderNumber, invoiceTotal, appliedAtIso });
}
