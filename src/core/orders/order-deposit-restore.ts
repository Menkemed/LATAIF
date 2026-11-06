// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER K2 — eine angerechnete Anzahlung wird wieder OFFEN.
//
// Wird die Rechnungszahlung der Art 'order_deposit' zurückgedreht (Storno oder Löschen der Rechnung, Löschen der
// Zahlung), bucht der Aufrufer die Zahlung zurück (Soll AR / Haben CUSTOMER_DEPOSITS — reverseSource PAYMENT).
// Hier folgt die Domäne: die Anrechnung wird REVERSED, die Order-Zahlung ist wieder offen, die Kopfzahlen der Order
// und ihre Überzahlungs-Gutschrift stimmen wieder. Kein Geld bewegt sich — die Anzahlung liegt wieder bei der Order
// und wird bei der nächsten Umwandlung erneut angerechnet. Idempotent (keine aktive Anrechnung → nichts).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate } from '@/core/sync/track';
import { refreshOrderPaymentSummary } from '@/stores/orderPaymentStore';

/** Gehört diese Rechnungszahlung zu einer Anrechnung? (aktiv oder nicht) */
export function isOrderDepositPayment(paymentId: string): boolean {
  return query('SELECT 1 FROM order_deposit_applications WHERE payment_id = ? LIMIT 1', [paymentId]).length > 0;
}

/** Macht die Anrechnungen dieser Rechnungszahlung rückgängig (Domäne; die Buchung dreht der Aufrufer). */
export function restoreOrderDepositForPayment(paymentId: string, nowIso: string = new Date().toISOString()): string[] {
  const apps = query(
    `SELECT id, order_id, order_payment_id FROM order_deposit_applications WHERE payment_id = ? AND status = 'ACTIVE'`,
    [paymentId],
  );
  if (apps.length === 0) return [];
  const db = getDatabase();
  const orders = new Set<string>();
  for (const a of apps) {
    db.run(`UPDATE order_deposit_applications SET status = 'REVERSED', reversed_at = ? WHERE id = ?`, [nowIso, String(a.id)]);
    trackUpdate('order_deposit_applications', String(a.id), { status: 'REVERSED', reversedAt: nowIso });
    db.run('UPDATE order_payments SET converted_to_invoice = 0 WHERE id = ? AND COALESCE(converted_to_invoice, 0) = 1', [String(a.order_payment_id)]);
    trackUpdate('order_payments', String(a.order_payment_id), { convertedToInvoice: false });
    orders.add(String(a.order_id));
  }
  for (const o of orders) refreshOrderPaymentSummary(o);
  return [...orders];
}
