// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER OF3 — Kosten eines Sonderstücks, die NICHT im Lager gebucht sind.
//
// Der Einstand eines Sonderstücks ist die Summe seiner angekommenen Kostenzeilen. Beim Verkauf bucht die Rechnung
// Soll COGS / Haben INVENTORY zu diesem Einstand. Das stimmt nur, wenn jede dieser Kosten vorher im Lager gebucht wurde:
//   • eine Lieferantenzeile (Lohn, Material): ihre Ausgabe steht mit Soll INVENTORY im Hauptbuch (K1);
//   • eine Goldzeile mit Goldschuld: ihr Buchwert steht mit Soll INVENTORY / Haben GOLD_LIABILITY (K1).
// Eigene Arbeit, eigenes Gold oder Material ohne Lieferant („In-house", „Own Gold / Shop Stock") bucht nichts — ihr
// Betrag stünde im Wareneinsatz, ohne dass das Lager ihn je bekommen hat (INVENTORY unter dem Lagerwert, kann negativ
// werden). Das Aktivieren solcher Kosten ist noch nicht unterstützt (G1): Rechnung und „Storno ins Lager" lehnen ab,
// bevor etwas geschrieben wird. Die Zeile kann vorher entfernt werden.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { OrderActionRejected } from './order-create';

const EPS = 0.0005;

export interface UnbookedOrderCost {
  lineId: string;
  position: number;
  description: string;
  kind: string;
  amount: number;
}

/** Netto-Soll auf INVENTORY einer Buchungsquelle (Gegenbuchungen abgezogen). */
function netInventory(sourceModule: string, sourceId: string): number {
  const r = query(
    `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) AS n
       FROM ledger_entries WHERE source_module = ? AND source_id = ? AND account = 'INVENTORY'`,
    [sourceModule, sourceId],
  )[0];
  return Number(r?.n ?? 0) || 0;
}

/** Die angekommenen Kostenzeilen dieses Auftrags, deren Betrag nicht im Lager gebucht ist (nur lesend). */
export function unbookedOrderCosts(orderId: string): UnbookedOrderCost[] {
  const rows = query(
    `SELECT ol.id, ol.position, ol.description, ol.material_kind, ol.cost_amount, ol.expense_id,
            (SELECT COUNT(*) FROM gold_payables gp
              WHERE gp.source_order_line_id = ol.id AND gp.status <> 'CANCELLED' AND gp.book_value IS NOT NULL) AS bewertet
       FROM order_lines ol
      WHERE ol.order_id = ? AND COALESCE(ol.is_customer_facing, 1) = 0
        AND ol.status IN ('ARRIVED', 'DELIVERED') AND COALESCE(ol.cost_amount, 0) > ?
      ORDER BY ol.position`,
    [orderId, EPS],
  );
  const out: UnbookedOrderCost[] = [];
  for (const r of rows) {
    const amount = Math.round((Number(r.cost_amount) || 0) * 1000) / 1000;
    // Goldzeile mit bewerteter Goldschuld: ihr Wert (und jede spätere Differenz aus K3a) steht im Lager.
    if (Number(r.bewertet) > 0) continue;
    // Lieferantenzeile: ihre Ausgabe muss den Betrag als Lager gebucht haben (vor K1 ging sie in den Betriebsaufwand).
    if (r.expense_id && netInventory('EXPENSE', String(r.expense_id)) >= amount - EPS) continue;
    out.push({
      lineId: String(r.id), position: Number(r.position) || 0, description: String(r.description ?? ''),
      kind: String(r.material_kind ?? 'cost'), amount,
    });
  }
  return out;
}

/**
 * Würde „Cancel Order" das angefangene Stück als Lagerartikel anlegen? Dieselbe Bedingung wie der Storno im Store
 * (`cancelOrderWithMoney` Schritt 6): gebuchte Kosten oder eine bewertete, offene Goldschuld — und kein reservierter,
 * schon verknüpfter Artikel, der stattdessen freigegeben wird. Nur lesend.
 */
export function cancelWouldStockPiece(orderId: string): boolean {
  const o = query('SELECT product_id FROM orders WHERE id = ?', [orderId])[0];
  if (o?.product_id) {
    const p = query('SELECT stock_status FROM products WHERE id = ?', [String(o.product_id)])[0];
    if (p && String(p.stock_status) === 'reserved') return false;
  }
  const gebucht = query(
    `SELECT 1 FROM order_lines WHERE order_id = ? AND COALESCE(is_customer_facing, 1) = 0 AND expense_id IS NOT NULL LIMIT 1`, [orderId],
  ).length > 0;
  const gold = query(
    `SELECT 1 FROM gold_payables WHERE source_order_id = ? AND status = 'OPEN' AND COALESCE(book_value, 0) > ? LIMIT 1`, [orderId, EPS],
  ).length > 0;
  return gebucht || gold;
}

/** Nein, wenn der Einstand des Sonderstücks Kosten enthält, die nicht im Lager gebucht sind. */
export function assertOrderCostsBooked(orderId: string, what: string): void {
  const offen = unbookedOrderCosts(orderId);
  if (offen.length === 0) return;
  const summe = Math.round(offen.reduce((s, c) => s + c.amount, 0) * 1000) / 1000;
  const liste = offen.map((c) => `${c.description || c.kind} ${c.amount.toFixed(3)} BHD`).join('; ');
  throw new OrderActionRejected('CUSTOM_COSTS_NOT_BOOKED',
    `${offen.length} cost line(s) of this order are not booked to stock (${liste}; total ${summe.toFixed(3)} BHD). `
    + `Own labour / own gold without a workshop is not supported yet — ${what} would book them as cost of goods without `
    + 'ever having stocked them. Remove the line, or record the cost with the workshop. Nothing was changed.');
}
