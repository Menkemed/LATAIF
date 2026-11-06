// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER K2 — was von einer Order-Anzahlung noch OFFEN ist (eine Regel für alle Leser).
//
// Seit K2 wird eine Anzahlung auf die Rechnung ANGERECHNET (order_deposit_applications, Rechnungszahlung
// der Art 'order_deposit', Soll CUSTOMER_DEPOSITS / Haben AR); ihr Geldeingang bleibt unverändert stehen.
// Offen ist eine Order-Zahlung um ihren Betrag minus die aktiven Anrechnungen — auch teilweise.
//
// Altbestand (vor K2 umgewandelt): `converted_to_invoice = 1` OHNE jede Anrechnungszeile — dort wurde die
// Anzahlung beim Umwandeln zurückgedreht und auf der Rechnung neu gebucht; sie ist ganz verbraucht (0).
// ════════════════════════════════════════════════════════════════════════════

export const ORDER_DEPOSIT_METHOD = 'order_deposit';

/** Summe der aktiven Anrechnungen einer Order-Zahlung (SQL-Ausdruck; `alias` = Tabellenalias von order_payments). */
export function appliedDepositSql(alias: string): string {
  return `COALESCE((SELECT SUM(oda.amount) FROM order_deposit_applications oda WHERE oda.order_payment_id = ${alias}.id AND oda.status = 'ACTIVE'), 0)`;
}

/** Der noch offene Betrag einer Order-Zahlung (SQL-Ausdruck). */
export function openDepositSql(alias: string): string {
  return `(CASE WHEN COALESCE(${alias}.converted_to_invoice, 0) = 1
                 AND NOT EXISTS (SELECT 1 FROM order_deposit_applications odx WHERE odx.order_payment_id = ${alias}.id)
            THEN 0 ELSE ${alias}.amount - ${appliedDepositSql(alias)} END)`;
}

/** Summe der offenen Anzahlungen einer Order (SQL; Parameter: order_id). */
export const OPEN_DEPOSIT_TOTAL_SQL =
  `SELECT COALESCE(SUM(${openDepositSql('op')}), 0) AS t FROM order_payments op WHERE op.order_id = ?`;
