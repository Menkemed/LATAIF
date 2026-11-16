// Approval-Zeilen — reine Regeln, geteilt von Druck (agent-print-helpers) und Excel (approval-workbook):
// welcher Filter welche Transfers zeigt, wie der Status heißt, und was ein Transfer an Geld bedeutet.
// Ohne Store, ohne DB — unter node testbar.
import type { AgentTransfer, Invoice } from '@/core/models/types';
import type { ItemListFilter } from '@/core/pdf/itemListPdf';

export function filterApprovalTransfers(transfers: AgentTransfer[], filter: ItemListFilter): AgentTransfer[] {
  switch (filter) {
    case 'sold':     return transfers.filter(t => t.status === 'sold' || t.status === 'settled');
    case 'open':     return transfers.filter(t => t.status === 'transferred');
    case 'returned': return transfers.filter(t => t.status === 'returned');
    default:         return transfers.slice();
  }
}

export function approvalStatusLabel(t: AgentTransfer, invoice?: Invoice): string {
  if (t.status === 'returned') return 'Returned';
  if (t.status === 'transferred') return 'On Approval';
  if (t.invoiceId && invoice) {
    const paid = invoice.paidAmount || 0;
    const gross = invoice.grossAmount || 0;
    if (gross > 0 && paid >= gross - 0.005) return 'Settled';
    if (paid > 0.005) return 'Partially Paid';
    return 'Unpaid';
  }
  return t.status.charAt(0).toUpperCase() + t.status.slice(1);
}

export const isApprovalSold = (t: AgentTransfer): boolean => t.status === 'sold' || t.status === 'settled';
/** Zurück im Lager: zurückgegeben, oder ein Verkauf, der per „Remove" storniert wurde. */
export const isApprovalBack = (t: AgentTransfer): boolean => t.status === 'returned' || t.status === 'cancelled';

export interface ApprovalRowMoney {
  /** „Our Price" — was wir mindestens bekommen wollen. */
  ourPrice: number;
  /** Verkaufspreis beim Endkunden, falls erfasst. */
  salePrice: number | null;
  /** Unsere Forderung — nur bei verkauften Stücken (Rechnung brutto, sonst Abrechnungsbetrag). */
  amountDue: number | null;
  paid: number | null;
  outstanding: number | null;
}

/**
 * Geld eines Transfers. Forderung, Bezahlt und Offen gibt es NUR bei verkauften Stücken — ein Stück, das noch beim
 * Kunden liegt oder zurück ist, schuldet niemand (wie „Outstanding" auf der Approval-Seite).
 */
export function approvalRowMoney(t: AgentTransfer, invoice?: Invoice): ApprovalRowMoney {
  const base = { ourPrice: t.agentPrice || 0, salePrice: t.actualSalePrice ?? null };
  if (!isApprovalSold(t)) return { ...base, amountDue: null, paid: null, outstanding: null };
  const amountDue = invoice ? (invoice.grossAmount || 0) : ((t.settlementAmount ?? t.actualSalePrice ?? t.agentPrice) || 0);
  const paid = invoice
    ? (invoice.paidAmount || 0)
    : t.settlementStatus === 'paid' ? (t.settlementAmount ?? amountDue)
    : t.settlementStatus === 'partial' ? (t.settlementPaidAmount || 0) : 0;
  return { ...base, amountDue, paid, outstanding: Math.max(0, amountDue - paid) };
}
