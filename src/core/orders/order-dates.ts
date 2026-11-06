// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER K4 — Auftragsdatum und Fertigstellung auch nach „Completed" korrigieren (Preview V4 §1).
//
// „Edit" bleibt für einen abgeschlossenen Auftrag ausgeblendet; korrigierbar sind nur diese zwei Felder:
//   • Order date   (`orders.order_date`)
//   • Completed on (`orders.actual_delivery`) — nur für einen abgeschlossenen Auftrag.
// Beide wirken auf Anzeige, Sortierung, Suche und Beleg-PDF. Sie verschieben NIE eine Buchung (Lohn-A/P, Goldwert,
// Anzahlung, Kartengebühr behalten ihr Datum). Jede Änderung wird protokolliert und läuft — auch vom PC2 aus
// (`orders.update`, nur Datumsfelder) — durch diese eine Hausfolge.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { useOrderStore } from '@/stores/orderStore';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { businessDateIssue } from '@/core/utils/business-date';
import { OrderActionRejected } from './order-create';

export interface OrderDatesInput {
  /** JJJJ-MM-TT; fehlt = bleibt. */
  orderDate?: string;
  /** JJJJ-MM-TT; fehlt = bleibt. Nur für einen abgeschlossenen Auftrag. */
  completedOn?: string;
}

export interface OrderDatesLive {
  status: string;
  order_date?: string | null;
  actual_delivery?: string | null;
  created_at?: string | null;
}

export interface OrderDatesPlan {
  patch: { orderDate?: string; actualDelivery?: string };
  changes: Array<{ field: 'order_date' | 'actual_delivery'; oldValue: string | null; newValue: string }>;
}

/** Nur lesend: prüft und bestimmt, was sich ändert — dieselbe Regel am Primary und für den PC2. */
export function planOrderDates(live: OrderDatesLive, input: OrderDatesInput, nowMs: number = Date.now()): OrderDatesPlan {
  if (input.orderDate === undefined && input.completedOn === undefined) {
    throw new OrderActionRejected('INVALID_INPUT', 'Nothing to change — give the order date or the completion date.');
  }
  const status = String(live.status);
  if (status === 'cancelled') throw new OrderActionRejected('ORDER_NOT_EDITABLE', 'This order is cancelled — its dates are no longer changed.');
  const d1 = businessDateIssue(input.orderDate, 'Order date', nowMs);
  if (d1) throw new OrderActionRejected('INVALID_INPUT', d1);
  const d2 = businessDateIssue(input.completedOn, 'Completion date', nowMs);
  if (d2) throw new OrderActionRejected('INVALID_INPUT', d2);
  if (input.completedOn !== undefined && status !== 'completed') {
    throw new OrderActionRejected('ORDER_NOT_COMPLETED', 'The completion date belongs to a completed order — complete the order first.');
  }
  const oldOrder = live.order_date ? String(live.order_date).slice(0, 10) : null;
  const oldDone = live.actual_delivery ? String(live.actual_delivery).slice(0, 10) : null;
  const neuOrder = input.orderDate ?? oldOrder ?? (live.created_at ? String(live.created_at).slice(0, 10) : null);
  const neuDone = input.completedOn ?? oldDone;
  if (neuOrder && neuDone && neuDone < neuOrder) {
    throw new OrderActionRejected('ORDER_DATES_OUT_OF_ORDER', `The order cannot be completed (${neuDone}) before it was placed (${neuOrder}).`);
  }
  const plan: OrderDatesPlan = { patch: {}, changes: [] };
  if (input.orderDate !== undefined && input.orderDate !== oldOrder) {
    plan.patch.orderDate = input.orderDate;
    plan.changes.push({ field: 'order_date', oldValue: oldOrder, newValue: input.orderDate });
  }
  if (input.completedOn !== undefined && input.completedOn !== oldDone) {
    plan.patch.actualDelivery = input.completedOn;
    plan.changes.push({ field: 'actual_delivery', oldValue: oldDone, newValue: input.completedOn });
  }
  return plan;
}

/**
 * Schreibt die Daten (in der Klammer des Aufrufers). Unverändertes schreibt nichts (idempotent).
 * `actor` = wer es tut (fern: der Absender, nicht die Sitzung des Primary).
 */
export function updateOrderDatesInHouse(
  id: string, input: OrderDatesInput, branchId: string, actor?: { userId?: string; branchId?: string },
): { changed: string[] } {
  const live = query('SELECT id, status, order_date, actual_delivery, created_at FROM orders WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!live) throw new OrderActionRejected('ORDER_NOT_FOUND', 'No such order in this branch.');
  const plan = planOrderDates(live as unknown as OrderDatesLive, input);
  if (plan.changes.length === 0) return { changed: [] };
  useOrderStore.getState().updateOrder(id, plan.patch as never);
  for (const c of plan.changes) {
    logAuditOrThrow({
      module: 'Order', entityType: 'orders', entityId: id, action: 'UPDATE', field: c.field,
      oldValue: c.oldValue, newValue: c.newValue, ...(actor ? { actor } : {}),
    });
  }
  return { changed: plan.changes.map((c) => c.field) };
}
