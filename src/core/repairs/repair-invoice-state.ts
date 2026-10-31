// ════════════════════════════════════════════════════════════════════════════
// REPAIR-INVOICE-INDICATOR — hat diese Reparatur eine Rechnung? Getrennt vom Reparaturstatus und NUR aus der
// echten Verknüpfung gelesen: `repairs.invoice_id` → die Rechnung in `invoices`.
//
// Was im Haus vorkommt (geprüft, nicht vermutet):
//   • Eine Sammelrechnung trägt mehrere Reparaturen: JEDE Reparatur zeigt auf dieselbe Rechnung (mehrere
//     Verknüpfungen auf eine Rechnung, nie eine Reparatur auf mehrere).
//   • Eine stornierte Rechnung löst die Verknüpfung NICHT (anders als bei Auftrag und Angebot): die Reparatur zeigt
//     weiter auf eine Rechnung im Status CANCELLED. Das ist keine erstellte Rechnung mehr.
//   • Eine Rechnung, die es (nicht mehr) gibt — gelöscht oder nicht geladen: keine erstellte Rechnung.
//   • Entwurf (DRAFT), teilweise oder voll zurückgegeben (RETURNED): die Rechnung besteht — „erstellt".
// Diese Datei schreibt nichts und ändert keine Regel an Rechnung, VAT, Zahlung oder Buchung.
// ════════════════════════════════════════════════════════════════════════════

export type RepairInvoiceState = 'created' | 'cancelled' | 'missing' | 'none';

export interface RepairInvoiceView {
  state: RepairInvoiceState;
  /** Gibt es eine geltende Rechnung? (Filter „Invoice Created") */
  created: boolean;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  label: string;
}

export interface RepairInvoiceCandidate {
  id: string;
  invoiceNumber?: string | null;
  status?: string | null;
}

export function repairInvoiceView(
  r: { invoiceId?: string | null }, invoices: ReadonlyArray<RepairInvoiceCandidate>,
): RepairInvoiceView {
  const id = typeof r.invoiceId === 'string' && r.invoiceId.trim() !== '' ? r.invoiceId : null;
  if (!id) return { state: 'none', created: false, invoiceId: null, invoiceNumber: null, invoiceStatus: null, label: 'Not created' };
  const inv = invoices.find((i) => i.id === id);
  if (!inv) {
    return { state: 'missing', created: false, invoiceId: id, invoiceNumber: null, invoiceStatus: null, label: 'Invoice not found' };
  }
  const status = inv.status ?? null;
  const nr = inv.invoiceNumber || null;
  if (status === 'CANCELLED') {
    return { state: 'cancelled', created: false, invoiceId: id, invoiceNumber: nr, invoiceStatus: status, label: 'Invoice cancelled' };
  }
  const zusatz = status === 'DRAFT' ? ' (draft)' : status === 'RETURNED' ? ' (returned)' : '';
  return { state: 'created', created: true, invoiceId: id, invoiceNumber: nr, invoiceStatus: status, label: `Invoice created${zusatz}` };
}

export type RepairInvoiceFilter = '' | 'created' | 'not_created';

export function matchRepairInvoice(v: RepairInvoiceView, f: RepairInvoiceFilter): boolean {
  if (f === 'created') return v.created;
  if (f === 'not_created') return !v.created;
  return true;
}
