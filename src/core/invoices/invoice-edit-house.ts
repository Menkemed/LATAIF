// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1a — eine Rechnung am Primary ändern: exklusiv, in EINER Transaktion, gegen die
// Fassung, die der Mensch gesehen hat.
//
// Vorher rief die Maske des Primary `editInvoice` direkt: ohne die eine Schreibreihenfolge
// (`runExclusive`) und ohne Fassung — ein Speichern auf veraltetem Stand überschrieb still, was PC2
// inzwischen geändert hatte. PC2 prüfte die Fassung schon (`invoices.update`). Jetzt derselbe Weg
// wie jede Hausfolge der Maske (`runOnPrimary`), und `editInvoice` vergleicht die genannte Fassung
// mit der Datenbank, innerhalb der Transaktion (`INVOICE_CHANGED`).
// ════════════════════════════════════════════════════════════════════════════
import { runOnPrimary } from '@/core/data/primary-action';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { useCustomerStore } from '@/stores/customerStore';

export type InvoiceEditInput = Omit<Parameters<ReturnType<typeof useInvoiceStore.getState>['editInvoice']>[1], 'expectedRevision'>;

/** Die Listen, die die Maske danach zeigt — auch nach einem Rollback. */
function frischLesen(): void {
  useInvoiceStore.getState().loadInvoices();
  try { useProductStore.getState().loadProducts(); } catch { /* noop */ }
  try { useCustomerStore.getState().loadCustomers(); } catch { /* noop */ }
}

/** „Save" der Rechnungsmaske am Primary. */
export function editInvoiceOnPrimary(id: string, input: InvoiceEditInput, expectedRevision: number): Promise<void> {
  return runOnPrimary(() => {
    useInvoiceStore.getState().editInvoice(id, { ...input, expectedRevision });
  }, frischLesen);
}
