// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — einen Auftrag ändern („Save" der Auftragsseite): EINE Ableitung.
//
// Die Maske schreibt sechs Eingaben — Lieferant, Einkaufspreis, vereinbarter Preis, Anzahlung,
// Liefertermin, Notiz — und leitet zwei Zahlen daraus ab: die erwartete Marge (Preis − Einkauf) und
// den Rest (Preis − Anzahlung). Beim Sonderauftrag trägt die ANGEBOTSZEILE den Preis: dann wird ihr
// Preis gezogen (der Kopfpreis folgt aus den Zeilen) und der Kopfpreis selbst nicht geschrieben.
// Der Client schickt nur die Eingaben; die beiden Zahlen rechnet das Haus.
// ════════════════════════════════════════════════════════════════════════════
import type { Order } from '@/core/models/types';
import { OrderActionRejected } from './order-create';

/** Die Eingaben der Maske — genau die, die „Save" schreibt. */
export const ORDER_EDIT_FIELDS = [
  'agreedPrice', 'depositAmount', 'supplierName', 'supplierPrice', 'expectedDelivery', 'notes',
] as const;
export type OrderEditField = typeof ORDER_EDIT_FIELDS[number];

export interface OrderEditInput {
  agreedPrice: number | null;
  depositAmount: number | null;
  supplierName: string | null;
  supplierPrice: number | null;
  expectedDelivery: string | null;
  notes: string | null;
}

/** Die sechs Werte des Formulars — ein geleertes Feld heißt „keins" (die Maske schrieb `null`). */
export function orderEditInput(form: Partial<Order>): OrderEditInput {
  return {
    agreedPrice: form.agreedPrice ?? null,
    depositAmount: form.depositAmount ?? null,
    supplierName: form.supplierName ?? null,
    supplierPrice: form.supplierPrice ?? null,
    expectedDelivery: form.expectedDelivery ?? null,
    notes: form.notes ?? null,
  };
}

/** Beträge sind nicht negativ — auf beiden Seiten dieselbe Regel. */
export function assertOrderEditValues(input: OrderEditInput): void {
  for (const k of ['agreedPrice', 'depositAmount', 'supplierPrice'] as const) {
    const v = input[k];
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      throw new OrderActionRejected('INVALID_AMOUNT', `${k} must be a number of at least 0`);
    }
  }
}

export interface OrderEditPlan {
  /** Die Angebotszeile bekommt den neuen Preis (der Kopfpreis folgt aus den Zeilen). */
  linePrice?: { lineId: string; unitPrice: number };
  /** Was `updateOrder` schreibt — Eingaben und die beiden abgeleiteten Zahlen. */
  patch: Record<string, unknown>;
}

/**
 * Die Ableitung von „Save" — wortgleich zur Maske: Marge nur, wenn Preis UND Einkauf da sind; Rest
 * = Preis − Anzahlung; bei einer Angebotszeile ihr Preis statt des Kopfpreises.
 */
export function planOrderEdit(input: OrderEditInput, quoteLine?: { id: string; unitPrice: number }): OrderEditPlan {
  assertOrderEditValues(input);
  const agreed = input.agreedPrice;
  const plan: OrderEditPlan = { patch: {} };
  if (quoteLine && agreed != null && Math.abs(agreed - (quoteLine.unitPrice || 0)) > 0.0005) {
    plan.linePrice = { lineId: quoteLine.id, unitPrice: agreed };
  }
  const margin = agreed && input.supplierPrice ? agreed - input.supplierPrice : null;
  plan.patch = {
    ...(quoteLine ? {} : { agreedPrice: agreed }),
    depositAmount: input.depositAmount,
    supplierName: input.supplierName,
    supplierPrice: input.supplierPrice,
    expectedMargin: margin,
    expectedDelivery: input.expectedDelivery,
    remainingAmount: (agreed || 0) - (input.depositAmount || 0),
    notes: input.notes,
  };
  return plan;
}

/** Der Rumpf von `orders.update`: die gesehene Fassung und die sechs Eingaben (geleert = `null`). */
export function orderEditBody(id: string, revision: number | undefined, form: Partial<Order>): Record<string, unknown> {
  return { id, expectedRevision: revision, ...orderEditInput(form) };
}
