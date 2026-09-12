// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F.1 — der Rechnungsstorno am Haus: EINE Folge, EINE Klammer.
//
// „Cancel Invoice" lief am Primary in der Komponente: Retoure anlegen, freigeben, erstatten — mit
// VERSCHLUCKTEM Fehler („continuing with status change") — und danach der Status. Jetzt:
//
//   • `cancelInvoiceInHouse` — die EINE Folge, die `invoices.cancel` in seiner Transaktion ruft;
//   • `cancelInvoiceOnPrimary` — dieselbe Folge für den Dialog des Primary, exklusiv, EINE Transaktion.
//
// Nichts wird nachgebaut: `createReturn`, `approveReturn`, `refundReturn`, `updateProduct` und
// `updateInvoice(…CANCELLED)` des Hauses tragen Deckel, Gutschrift, Buchungsstorno, Lose, Zahlungen,
// Guthaben-Sperren und Auto-Ausgaben. Zwei Dinge sind berichtigt, beide am eigenen Versprechen des
// Dialogs gemessen („Refund of <bezahlt> will be recorded", „Products will be released"):
// die Retoure nimmt jede Zeile in ihrer RESTMENGE zum Rechnungspreis (brutto) zurück — vorher je
// Zeile 1 Stück zum Nettopreis, womit weniger zurückfloss als angekündigt —, und ein Fehler
// darin storniert nicht mehr trotzdem.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { returnLineAmounts } from '@/core/returns/return-lines';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { useCreditNoteStore } from '@/stores/creditNoteStore';
import { useCustomerStore } from '@/stores/customerStore';
import {
  INVOICE_CANCEL_REFUND_METHODS, InvoiceActionRejected, invoiceCancelBlocker, type InvoiceCancelInput,
} from './invoice-cancel';

/** Die Urteile, die die Hausfunktionen wirklich fällen. Alles andere ist eine Störung, kein Urteil. */
const VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/store credit[\s\S]*used/i, 'INVOICE_CREDIT_USED'],
  [/exceeds remaining/i, 'RETURN_QUANTITY_EXCEEDED'],
];

function alsUrteil(e: unknown): never {
  if (e instanceof InvoiceActionRejected) throw e;
  const msg = e instanceof Error ? e.message : String(e);
  for (const [pattern, code] of VERDICTS) if (pattern.test(msg)) throw new InvoiceActionRejected(code, msg);
  throw e;
}

export interface InvoiceCancelled { invoiceId: string; returnId?: string }

/**
 * „Cancel Invoice": mit erhaltenem Geld Retoure (Restmengen, Rechnungspreis) + Freigabe + Erstattung
 * im gewählten Weg; ohne Geld je Zeile ein Stück zurück in den Bestand (wie der Bildschirm) — dann
 * der Status CANCELLED. `beforeWrite` ist der letzte Wächter vor dem ersten Schreiben (fern: Fassung).
 */
export function cancelInvoiceInHouse(input: InvoiceCancelInput, branchId: string, beforeWrite?: () => void): InvoiceCancelled {
  if (!(INVOICE_CANCEL_REFUND_METHODS as readonly string[]).includes(input.refundMethod)) {
    throw new InvoiceActionRejected('INVALID_INPUT', `unknown refund method: ${input.refundMethod}`);
  }
  const inv = query('SELECT id, status, invoice_number, paid_amount FROM invoices WHERE id = ? AND branch_id = ?',
    [input.invoiceId, branchId])[0];
  if (!inv) throw new InvoiceActionRejected('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  const blocker = invoiceCancelBlocker(String(inv.status));
  if (blocker) throw new InvoiceActionRejected(blocker.code, blocker.message);
  beforeWrite?.();

  const buchung = watchLedgerPosts('invoice cancel');
  let returnId: string | undefined;
  try {
    if (Number(inv.paid_amount ?? 0) > 0) {
      // Was noch nicht zurück ist, zum Preis der Rechnung — dieselbe Ableitung wie jede Retoure.
      const lines = query(
        `SELECT il.id, il.product_id, il.quantity, il.line_total, il.vat_amount,
                COALESCE((SELECT SUM(srl.quantity) FROM sales_return_lines srl JOIN sales_returns r ON r.id = srl.return_id
                           WHERE srl.invoice_line_id = il.id AND r.status != 'REJECTED'), 0) AS zurueck
           FROM invoice_lines il WHERE il.invoice_id = ? ORDER BY il.rowid`,
        [input.invoiceId],
      ).map((l) => ({ l, rest: Number(l.quantity ?? 1) - Number(l.zurueck ?? 0) }))
        .filter((x) => x.rest > 0.005)
        .map(({ l, rest }) => {
          const a = returnLineAmounts(
            { quantity: Number(l.quantity ?? 1), lineTotal: Number(l.line_total ?? 0), vatAmount: Number(l.vat_amount ?? 0) }, rest,
          );
          return {
            invoiceLineId: String(l.id), productId: String(l.product_id ?? '') || undefined,
            quantity: a.quantity, unitPrice: a.unitPrice, vatAmount: a.vatAmount,
          };
        });
      if (lines.length > 0) {
        useSalesReturnStore.getState().loadReturns();
        returnId = useSalesReturnStore.getState().createReturn({
          invoiceId: input.invoiceId,
          refundMethod: input.refundMethod,
          productDisposition: 'IN_STOCK',
          notes: `Auto-refund on invoice cancellation (${String(inv.invoice_number ?? '')})`,
          lines,
        }).id;
        // Der Store schlägt die Retoure in SEINER Liste nach — frisch, sonst täte er still nichts.
        useSalesReturnStore.getState().loadReturns();
        useSalesReturnStore.getState().approveReturn(returnId);
        useSalesReturnStore.getState().refundReturn(returnId);
      }
    } else {
      // Kein Geld erhalten → nur die Ware freigeben, je Zeile ein Stück (wie der Bildschirm).
      useProductStore.getState().loadProducts();
      for (const l of query('SELECT product_id FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [input.invoiceId])) {
        const p = useProductStore.getState().getProduct(String(l.product_id ?? ''));
        if (p) useProductStore.getState().updateProduct(p.id, { quantity: (p.quantity || 0) + 1, stockStatus: 'in_stock' });
      }
    }
    useInvoiceStore.getState().loadInvoices();
    useInvoiceStore.getState().updateInvoice(input.invoiceId, { status: 'CANCELLED' });
  } catch (e) {
    alsUrteil(e);
  }
  buchung();
  return { invoiceId: input.invoiceId, returnId };
}

/** Die Listen, die die Seite danach zeigt — auch nach einem Rollback. */
function frischLesen(): void {
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
}

/** „Cancel Invoice" am Primary. */
export function cancelInvoiceOnPrimary(input: InvoiceCancelInput): Promise<InvoiceCancelled> {
  return runOnPrimary(() => cancelInvoiceInHouse(input, currentBranchId()), frischLesen);
}
