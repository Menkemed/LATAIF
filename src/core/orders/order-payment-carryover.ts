// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5A — die Anzahlung, die mit der Rechnung mitgeht.
//
// Diese Rechnung stand bis hierher IN der Auftragsansicht — mitten in einer React-Komponente.
// Damit war sie fuer den Fernbefehl unerreichbar: `orders.convert_to_invoice` legte die Rechnung
// an und verknuepfte die Zeilen, und das Geld blieb beim Auftrag liegen. Genau deshalb stand die
// Umwandlung seit R3 als Klasse-B-Luecke da.
//
// Hier ist sie unveraendert — Wort fuer Wort dieselbe Rechnung —, nur an einem Ort, den beide
// Seiten erreichen. Kopiert wird nichts: die Auftragsansicht ruft diese Funktion, und der
// Fernbefehl ruft dieselbe, innerhalb seiner Transaktion.
//
// Was sie tut, in der Reihenfolge, in der es passieren MUSS:
//
//   1. den noch nicht umgewandelten Zahlungstopf des Auftrags lesen;
//   2. seine Hauptbuchwirkung samt Kartengebuehr zurueckdrehen und ihn als umgewandelt
//      kennzeichnen — BEVOR auf der Rechnung gebucht wird, sonst steht das Geld doppelt da;
//   3. den Topf auf die Rechnung anrechnen, gedeckelt auf ihre Summe, mit der Kartenart jeder
//      einzelnen Zahlung (die Gebuehr rechnet das Haus, nicht der Bildschirm);
//   4. den Ueberschuss trennen: der echte Ueberzahlungsanteil wird EINE Rechnungszahlung
//      (daraus entsteht genau eine einloesbare Gutschrift), der Rest bleibt Anzahlung fuer die
//      naechste Teilrechnung.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useOrderPaymentStore } from '@/stores/orderPaymentStore';

/**
 * `totalPaid` ist die Summe ALLER Zahlungen des Auftrags. Sie wird nur fuer den Altbestand
 * gebraucht: Auftraege ohne eigene Zahlungszeilen, deren Anzahlung nur auf der Auftragszeile
 * steht. Die Auftragsansicht kennt sie ohnehin; der Fernbefehl liest sie aus der Datenbank.
 */
export function carryOverOrderPaymentsToInvoice(
  invoiceId: string, orderId: string, orderNumber: string, invoiceTotal: number, totalPaid: number,
): void {
  const inv = useInvoiceStore.getState();
  const poolRows = query(
    `SELECT id, amount, method, card_brand FROM order_payments
       WHERE order_id = ? AND converted_to_invoice = 0
       ORDER BY paid_at ASC, created_at ASC`,
    [orderId],
  );
  const pool = poolRows.reduce((s, r) => s + Number(r.amount || 0), 0);

  // Leerer Pool: Folge-Invoice nach verbrauchtem Deposit → startet UNPAID.
  // Legacy-Fallback: alte Orders ohne order_payments-Zeilen (Deposit nur auf
  // der orders-Zeile) — einmalig, gedeckelt aufs Invoice-Total.
  if (pool <= 0.005) {
    if (poolRows.length === 0 && totalPaid > 0) {
      inv.recordPayment(invoiceId, Math.min(totalPaid, invoiceTotal), 'cash',
        `Carried over from order ${orderNumber}`);
    }
    return;
  }

  // ZIEL.md §3a — Order-Payment-Ledger reversen + converted-Flag setzen, BEVOR
  // die Invoice-Payments gepostet werden (sonst doppelt-Cash). Idempotent.
  useOrderPaymentStore.getState().markConvertedToInvoice(orderId);

  // Cap: hoechstens das Invoice-Total auf diese Invoice anrechnen.
  const cap = Math.min(pool, invoiceTotal);
  let budget = cap;
  let lastMethod = 'cash';
  let lastBrand: 'normal' | 'amex' | undefined;
  for (const r of poolRows) {
    if (budget <= 0.005) break;
    const take = Math.min(Number(r.amount || 0), budget);
    lastMethod = (r.method as string) || 'cash';
    // v0.7.26 — Karten-Brand der Order-Zahlung mitnehmen: die Order-CardFee wurde
    // beim Convert reversed (markConvertedToInvoice); die Invoice bucht hier eine
    // frische CardFee mit der richtigen Rate (Amex 2,5% / Normal 2,2%).
    lastBrand = lastMethod === 'card' ? ((r.card_brand as 'normal' | 'amex') || 'normal') : undefined;
    inv.recordPayment(invoiceId, take, lastMethod, `Carried over from order ${orderNumber}`, undefined, lastBrand);
    budget -= take;
  }

  // Slice 4a — Ueberschuss aufteilen: der echte Ueberzahlungs-Anteil (Pool ueber den
  // agreedPrice der Order) wandert als GENAU EINE Invoice-Zahlung auf die Invoice → der
  // 3a-Overpay-Split bucht daraus EINE einloesbare 'overpayment'-Kundengutschrift. Der Rest
  // (Deposit bis agreedPrice, noch nicht invoiced) bleibt als Order-Deposit fuer die naechste
  // Teil-Invoice. Der order_overpayment-Credit der Order wurde oben in markConvertedToInvoice
  // bereits reverse+clawback abgebaut → keine Doppel-Gutschrift, genau eine fuer den Ueberschuss.
  const remainder = pool - cap;
  const agreedRow = query(`SELECT agreed_price FROM orders WHERE id = ?`, [orderId]);
  const agreedPrice = agreedRow.length ? Number(agreedRow[0].agreed_price || 0) : 0;
  const overpayPortion = Math.max(0, pool - Math.max(agreedPrice, invoiceTotal));
  const depositPortion = Math.max(0, remainder - overpayPortion);
  if (overpayPortion > 0.005) {
    inv.recordPayment(invoiceId, overpayPortion, lastMethod,
      `Overpayment carried over from order ${orderNumber}`, undefined, lastBrand);
  }
  if (depositPortion > 0.005) {
    useOrderPaymentStore.getState().addPayment({
      orderId,
      amount: depositPortion,
      paidAt: new Date().toISOString().split('T')[0],
      method: lastMethod,
      cardBrand: lastBrand,
      note: `Deposit remainder after partial invoice for order ${orderNumber}`,
    });
  }
}
