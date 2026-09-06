// CENTRAL-C3H — welchen Schritt ein Auftrag als naechstes gehen darf. EINE Quelle.
//
// Die Ableitung stand als Ausdruck in `OrderDetail.tsx`: eine Liste, ein Index, „das naechste".
// Solange nur ein Mensch vor einem Bildschirm sass, war das genug. Ein zweiter Rechner muesste
// sie nachtippen — und genau daran ist in C3F FINAL schon einmal etwas auseinandergelaufen
// (`internalCost` einer Reparatur, lokal anders gerechnet als fern). Deshalb steht sie hier,
// wird von der Seite importiert und vom Fernauftrag, und es gibt keine zweite Fassung.
//
// Was hier ABSICHTLICH nicht steht: `cancelled`. Ein Auftrag wird nicht „weitergeschaltet",
// sondern storniert — mit Geld, das zurueckgeht oder verfaellt (`cancelOrderWithMoney`). Das ist
// eine eigene Entscheidung mit eigener Oberflaeche, und sie bleibt am Primary.

import type { OrderStatus } from '@/core/models/types';

/** Der Weg, den der Knopf „Advance to …" am Primary geht — in dieser Reihenfolge. */
export const ORDER_STATUS_FLOW: readonly OrderStatus[] = ['pending', 'arrived', 'notified', 'completed'];

/** Der EINE erlaubte naechste Schritt, oder nichts (Ende des Weges, storniert, unbekannt). */
export function nextOrderStatus(current: OrderStatus | string | null | undefined): OrderStatus | null {
  const idx = ORDER_STATUS_FLOW.indexOf(String(current ?? '') as OrderStatus);
  if (idx === -1 || idx >= ORDER_STATUS_FLOW.length - 1) return null;
  return ORDER_STATUS_FLOW[idx + 1];
}

/**
 * Ob ein Uebergang der ist, den der Primary auch anbietet. Ein Fernauftrag darf keinen freien
 * Zielzustand setzen: `status = 'completed'` aus dem Stand heraus uebersprnge das Ankommen der
 * Ware — und mit ihm die Lieferanten-Verbindlichkeiten, die genau dort gebucht werden.
 */
export function isAllowedOrderAdvance(
  current: OrderStatus | string | null | undefined,
  target: OrderStatus | string | null | undefined,
): boolean {
  const next = nextOrderStatus(current);
  return next !== null && next === String(target ?? '');
}
