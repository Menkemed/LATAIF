// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — die zwei Riegel vor jeder Rechnungs-Hausfolge dieses Schnitts
// (anlegen mit Zahlung, Zahlung mit Nummernwahl, Butterfly).
//
//   • Ein Rechner ohne Geschäftsdatenbank bucht hier nie — auch nicht über einen vergessenen
//     direkten Aufruf. Die Maske auf PC2 geht über die Brücke; dieser Riegel steht davor, bevor
//     irgendeine Datenbank angefasst wird (dieselbe Regel wie `assertBooksHere` bei den Geldaktionen).
//   • Die Store-Funktionen des Hauses (`createDirectInvoice`, `recordPayment`) schreiben in die
//     Filiale der SITZUNG. Die Filiale des Auftrags muss deshalb genau diese sein — sonst prüfte die
//     Hausfolge Kunde und Artikel in Filiale X und schriebe die Rechnung in Filiale Y.
// ════════════════════════════════════════════════════════════════════════════
import { currentBranchId } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import { InvoiceActionRejected } from './invoice-cancel';

export const INVOICE_PRIMARY_ONLY = 'INVOICE_PRIMARY_ONLY';
export const INVOICE_NO_SESSION = 'INVOICE_NO_SESSION';

function sessionBranch(): string {
  try { return currentBranchId() || ''; } catch { return ''; }
}

/** Vor jeder Hausfolge: nur am Primary, nur in der Filiale, deren Bücher dieser Rechner führt. */
export function assertInvoiceHouse(branchId: string): void {
  if (isClientMode()) {
    throw new InvoiceActionRejected(INVOICE_PRIMARY_ONLY,
      'invoices are booked on the main computer — this window has no business database');
  }
  const house = sessionBranch();
  if (!branchId || !house || branchId !== house) {
    throw new InvoiceActionRejected('BRANCH_MISMATCH', 'this computer does not keep the books of that branch');
  }
}

/**
 * Die Filiale der Maske am Primary. Kein stilles 'branch-main': ohne Sitzung wird nichts gebucht.
 * Wird VOR `runOnPrimary` gefragt — auf einem Client wirft sie, bevor eine Klammer aufgeht.
 */
export function localInvoiceBranch(): string {
  if (isClientMode()) {
    throw new InvoiceActionRejected(INVOICE_PRIMARY_ONLY,
      'invoices are booked on the main computer — this window has no business database');
  }
  const branchId = sessionBranch();
  if (!branchId) throw new InvoiceActionRejected(INVOICE_NO_SESSION, 'no branch in this session — sign in again');
  return branchId;
}
