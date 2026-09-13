// CENTRAL-UI-PARITY R6C — der Kern DES PRIMARY als Beobachtungsspeicher der Inventur.
//
// Die Beobachtungen (`stock_checks`) liegen im Kern des Rechners, der die Bücher führt — dieselbe
// Tabelle, in die das Telefon schreibt. Auf dem Primary rufen die Maske UND der Fernbefehl diesen
// Anschluss. Auf einem Rechner ohne Datenbank verweigert `stock-check.ts` jeden Aufruf seines
// eigenen Kerns (R6B); dort gibt es diesen Anschluss nicht, nur die Fernbefehle.
import { latestStockChecks, recordStockCheck } from './stock-check';
import type { InventoryCore } from './inventory-house';

export function tauriInventoryCore(): InventoryCore {
  return {
    latest: (productIds) => latestStockChecks([...productIds]),
    record: (p) => recordStockCheck({ productId: p.productId, status: p.status, notes: p.notes, userId: p.userId, requestId: p.requestId }),
  };
}
