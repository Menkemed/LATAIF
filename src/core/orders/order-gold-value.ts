// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER K1 — der Wert einer Goldschuld aus einer Order.
//
// Liefert der Goldschmied (oder ein Goldhändler) das Gold für ein Sonderstück, schulden wir ihm Gramm
// (gold_payables, we_owe). Die Goldkosten der Order-Zeile sind Einstand des Stücks — sie standen bisher
// nur in der Kostensumme, im Hauptbuch nirgends: der Wareneinsatz der Rechnung buchte sie gegen ein
// Lager, das nie belastet war (INVENTORY lief ins Minus), und die spätere Begleichung buchte sie noch
// einmal als Aufwand.
//
// Jetzt, sobald das Gold da ist (Zeile ARRIVED/DELIVERED): Soll INVENTORY / Haben GOLD_LIABILITY in
// Höhe der Goldkosten der Zeile, gekeyt auf die Goldschuld; der Betrag steht als book_value an der
// Schuld. Genau einmal (book_value gesetzt = erledigt). Die Begleichung löst ihren Anteil auf (K3a).
// Fällt die Zeile oder die Schuld weg, bevor etwas beglichen ist, wird genau diese Buchung
// zurückgedreht. Kein stilles Schlucken: jede Buchung ist strikt, der Aufrufer läuft in einer Klammer.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate } from '@/core/sync/track';
import { postGoldPayableValue, hasLedgerEntries, reverseSource } from '@/core/ledger/posting';

const r3 = (n: unknown): number => Math.round((Number(n) || 0) * 1000) / 1000;

/** Buchungszeitpunkt eines Kalendertags: der Tag zur Mittagszeit (kein Verrutschen über Zeitzonen); heute = jetzt. */
export function bookingTimestamp(day: string | undefined, nowIso: string): string {
  if (!day || day === nowIso.slice(0, 10)) return nowIso;
  return `${day}T12:00:00.000Z`;
}

/**
 * Bewertet jede noch unbewertete, offene Goldschuld dieser Order, deren Gold-Zeile angekommen ist.
 * Gibt die Ids der bewerteten Schulden zurück. Idempotent.
 */
export function bookOrderGoldValues(orderId: string, bookingDay: string | undefined, nowIso: string): string[] {
  const rows = query(
    `SELECT gp.id AS payable_id, gp.supplier_id, gp.weight_grams, gp.karat, ol.id AS line_id, ol.cost_amount,
            o.order_number
       FROM gold_payables gp
       JOIN order_lines ol ON ol.id = gp.source_order_line_id
       JOIN orders o ON o.id = gp.source_order_id
      WHERE gp.source_order_id = ? AND gp.direction = 'we_owe' AND gp.status = 'OPEN' AND gp.book_value IS NULL
        AND ol.status IN ('ARRIVED', 'DELIVERED')`,
    [orderId],
  );
  const db = getDatabase();
  const done: string[] = [];
  const day = bookingDay || nowIso.slice(0, 10);
  for (const r of rows) {
    const payableId = String(r.payable_id);
    const value = r3(r.cost_amount);
    if (value > 0 && !hasLedgerEntries('GOLD_PAYABLE', payableId)) {
      postGoldPayableValue({
        payableId, supplierId: String(r.supplier_id), amount: value, occurredAt: bookingTimestamp(day, nowIso),
        orderId, orderNumber: String(r.order_number ?? ''), orderLineId: String(r.line_id),
        weightGrams: Number(r.weight_grams) || 0, karat: String(r.karat ?? ''),
      });
    }
    db.run('UPDATE gold_payables SET book_value = ?, book_value_date = ?, updated_at = ? WHERE id = ?', [value, day, nowIso, payableId]);
    trackUpdate('gold_payables', payableId, { bookValue: value, bookValueDate: day });
    done.push(payableId);
  }
  return done;
}

/** Hat diese Goldschuld eine noch wirksame Begleichung (K3a)? */
export function hasActiveGoldSettlement(payableId: string): boolean {
  return query(`SELECT 1 FROM gold_payable_settlements WHERE payable_id = ? AND status = 'ACTIVE' LIMIT 1`, [payableId]).length > 0;
}

/**
 * Nimmt den Wert einer Goldschuld zurück (die Zeile fällt weg, die Schuld wird storniert/gelöscht).
 * Nur solange nichts davon beglichen ist — sonst ein Nein, bevor etwas geschrieben wird.
 */
export function unbookGoldPayableValue(payableId: string, nowIso: string): void {
  if (hasActiveGoldSettlement(payableId)) {
    throw new Error('This gold debt is already (partly) settled in BHD — reverse that settlement first. Nothing was changed.');
  }
  // hasLedgerEntries = es gibt eine noch nicht zurückgedrehte Originalbuchung (auch nach einem früheren Zyklus).
  if (hasLedgerEntries('GOLD_PAYABLE', payableId)) reverseSource('GOLD_PAYABLE', payableId, nowIso);
  const live = query('SELECT book_value FROM gold_payables WHERE id = ?', [payableId])[0];
  if (live && live.book_value !== null && live.book_value !== undefined) {
    getDatabase().run('UPDATE gold_payables SET book_value = NULL, book_value_date = NULL, updated_at = ? WHERE id = ?', [nowIso, payableId]);
    trackUpdate('gold_payables', payableId, { bookValue: null, bookValueDate: null });
  }
}
