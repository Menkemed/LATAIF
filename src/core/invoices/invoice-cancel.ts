// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F.1 — eine Rechnung stornieren: EINE Regel für beide Seiten.
//
// „Cancel" auf der Rechnungsseite ist EINE Handlung: bei erhaltenem Geld Retoure, Freigabe und
// Erstattung, ohne Geld nur die Ware zurück — und dann der Status CANCELLED mit allem, was
// `updateInvoice` daran hängt (Buchungsstorno, Lose, Zahlungen, Guthaben, Auto-Ausgaben, Angebot,
// Auftrag). Keine der 40 Buchungen setzte diesen Status; `invoices.cancel` ist die eine neue.
// Die Folge steht in `invoice-cancel-house`, die Regeln hier.
// ════════════════════════════════════════════════════════════════════════════

/** Ein Nein der geteilten Regeln — am Primary eine Absage der Maske, fern ein eingefrorenes Urteil. */
export class InvoiceActionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'InvoiceActionRejected';
  }
}

/** Die Erstattungswege des Storno-Dialogs („REFUND METHOD"). */
export const INVOICE_CANCEL_REFUND_METHODS = ['cash', 'bank', 'benefit'] as const;
export type InvoiceCancelRefundMethod = typeof INVOICE_CANCEL_REFUND_METHODS[number];

/** Die EINGABEN des Storno-Dialogs — alles andere entscheidet das Haus. */
export interface InvoiceCancelInput {
  invoiceId: string;
  refundMethod: InvoiceCancelRefundMethod;
}

/**
 * Welche Rechnung „Cancel" anbietet: nicht schon storniert, nicht endgültig bezahlt und nicht
 * zurückgegeben (dort ist es eine Retoure). Die Seite fragt dieselbe Regel.
 */
export function invoiceCancelBlocker(status: string): { code: string; message: string } | null {
  if (status === 'CANCELLED') return { code: 'INVOICE_CANCELLED', message: 'this invoice is already cancelled' };
  if (status === 'FINAL' || status === 'RETURNED') {
    return { code: 'INVOICE_NOT_CANCELLABLE', message: `a ${status.toLowerCase()} invoice is not cancelled — it takes a return` };
  }
  return null;
}

/** Der Rumpf von `invoices.cancel`, wie ihn der Dialog am zweiten Rechner baut. */
export function invoiceCancelBody(i: InvoiceCancelInput, invoiceRevision: number): Record<string, unknown> {
  return { invoiceId: i.invoiceId, expectedRevision: invoiceRevision, refundMethod: i.refundMethod };
}
