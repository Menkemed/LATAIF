// CENTRAL-UI-PARITY R5F.1 — `invoices.cancel`: der Rechnungsstorno vom zweiten Rechner.
//
// Die EINE neue Buchung seit C3H, ausdrücklich freigegeben. Sie wurde nötig, weil „Cancel" auf
// der Rechnungsseite eine eigene Handlung ist, die keine der 40 Buchungen trägt: `invoices.update`
// ändert Zeilen mit Begründung, und `returns.approve`/`returns.refund` wären nur Bruchteile des
// Vorgangs (sie haben keinen eigenen Knopf). Hier wird NICHTS nachgebaut — der Handler prüft
// den Rumpf und die gesehene Fassung und ruft dieselbe Folge wie der Dialog des Primary
// (`cancelInvoiceInHouse`), innerhalb der Transaktion der Maschine.
import { query } from '@/core/db/helpers';
import { useProductStore } from '@/stores/productStore';
import {
  INVOICE_CANCEL_REFUND_METHODS, InvoiceActionRejected, type InvoiceCancelRefundMethod,
} from '@/core/invoices/invoice-cancel';
import { cancelInvoiceInHouse } from '@/core/invoices/invoice-cancel-house';
import {
  CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps,
} from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { registerCommand, type CommandActor } from './command-registry';
import {
  FinancialPayloadError, assertRevision, execFinancial, expectedRevisionOf, invoiceState, isPlain,
  onlyKnownFields, reqString,
} from './financial-commands';

export const OP_INVOICES_CANCEL = 'invoices.cancel';

export interface CancelInvoiceRequest {
  invoiceId: string;
  expectedRevision: number;
  refundMethod: InvoiceCancelRefundMethod;
}

/**
 * Genau die Eingaben des Dialogs: welche Rechnung, welche Fassung, welcher Erstattungsweg. Kein
 * Betrag, keine Menge, keine Zeile, kein Status — was zurückfließt und was storniert wird, rechnet
 * das Haus aus der Rechnung.
 */
export function parseCancelInvoice(raw: unknown): CancelInvoiceRequest {
  if (!isPlain(raw)) throw new FinancialPayloadError('payload must be an object');
  onlyKnownFields(raw, ['invoiceId', 'expectedRevision', 'refundMethod']);
  const m = raw.refundMethod === undefined ? 'bank' : String(raw.refundMethod);
  if (!(INVOICE_CANCEL_REFUND_METHODS as readonly string[]).includes(m)) {
    throw new FinancialPayloadError(`unknown refund method: ${m}`);
  }
  return {
    invoiceId: reqString(raw.invoiceId, 'invoiceId'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
    refundMethod: m as InvoiceCancelRefundMethod,
  };
}

export function runCancelInvoice(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseCancelInvoice(raw);
  return runRemoteCommand(deps, identity, () => {
    let returnId: string | undefined;
    try {
      returnId = cancelInvoiceInHouse({ invoiceId: req.invoiceId, refundMethod: req.refundMethod }, identity.branchId,
        () => assertRevision('invoices', req.invoiceId, req.expectedRevision, 'INVOICE_NOT_FOUND')).returnId;
    } catch (e) {
      if (e instanceof InvoiceActionRejected) throw new CommandRejected(e.code, e.message);
      throw e;
    }
    if (String(query('SELECT status FROM invoices WHERE id = ?', [req.invoiceId])[0]?.status) !== 'CANCELLED') {
      throw new CommandNotEvaluated('CANCEL_NOT_APPLIED', 'the invoice is not cancelled');
    }
    useProductStore.getState().loadProducts();
    const r = returnId
      ? query('SELECT status, refund_paid_amount FROM sales_returns WHERE id = ?', [returnId])[0]
      : undefined;
    return {
      ...invoiceState(req.invoiceId),
      returnId: returnId ?? null,
      returnStatus: r ? String(r.status ?? '') : null,
      refundPaidAmount: r ? Number(r.refund_paid_amount ?? 0) : 0,
    } as unknown as Record<string, unknown>;
  });
}

registerCommand(OP_INVOICES_CANCEL, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execFinancial(runCancelInvoice, OP_INVOICES_CANCEL, p, a),
});
