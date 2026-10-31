// ════════════════════════════════════════════════════════════════════════════
// REPAIR-INVOICE-INDICATOR — hat diese Reparatur eine Rechnung? Getrennt vom Reparaturstatus und NUR aus der
// echten Verknüpfung gelesen: `repairs.invoice_id` → die Rechnung in `invoices`.
//
// Was im Haus vorkommt (geprüft, nicht vermutet):
//   • Eine Sammelrechnung trägt mehrere Reparaturen: JEDE Reparatur zeigt auf dieselbe Rechnung (mehrere
//     Verknüpfungen auf eine Rechnung, nie eine Reparatur auf mehrere).
//   • Eine stornierte Rechnung löst die Verknüpfung NICHT (anders als bei Auftrag und Angebot): die Reparatur zeigt
//     weiter auf eine Rechnung im Status CANCELLED. Das ist keine erstellte Rechnung mehr.
//   • Eine Rechnung, die es (nicht mehr) gibt — gelöscht oder nicht geladen: keine erstellte Rechnung, und ein
//     Datenproblem (die Verknüpfung zeigt ins Leere) — `dataProblem`.
//   • Entwurf (DRAFT): eigener, neutraler Zustand „Invoice Draft"; für den Filter zählt er als erstellt.
//   • Teilweise oder voll zurückgegeben (RETURNED): die Rechnung besteht — „erstellt".
// Diese Datei schreibt nichts und ändert keine Regel an Rechnung, VAT, Zahlung oder Buchung.
// ════════════════════════════════════════════════════════════════════════════

export type RepairInvoiceState = 'created' | 'draft' | 'cancelled' | 'missing' | 'none';

export interface RepairInvoiceView {
  state: RepairInvoiceState;
  /** Gibt es eine geltende Rechnung? (Filter „Invoice Created" — auch ein Entwurf) */
  created: boolean;
  /** Die Verknüpfung zeigt auf eine Rechnung, die es nicht gibt. */
  dataProblem: boolean;
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
  if (!id) {
    return { state: 'none', created: false, dataProblem: false, invoiceId: null, invoiceNumber: null, invoiceStatus: null, label: 'Not created' };
  }
  const inv = invoices.find((i) => i.id === id);
  if (!inv) {
    return { state: 'missing', created: false, dataProblem: true, invoiceId: id, invoiceNumber: null, invoiceStatus: null, label: 'Invoice not found' };
  }
  const status = inv.status ?? null;
  const nr = inv.invoiceNumber || null;
  const sicht = { dataProblem: false, invoiceId: id, invoiceNumber: nr, invoiceStatus: status };
  if (status === 'CANCELLED') return { ...sicht, state: 'cancelled', created: false, label: 'Invoice cancelled' };
  if (status === 'DRAFT') return { ...sicht, state: 'draft', created: true, label: 'Invoice Draft' };
  return { ...sicht, state: 'created', created: true, label: status === 'RETURNED' ? 'Invoice created (returned)' : 'Invoice created' };
}

export type RepairInvoiceFilter = '' | 'created' | 'not_created';

export function matchRepairInvoice(v: RepairInvoiceView, f: RepairInvoiceFilter): boolean {
  if (f === 'created') return v.created;
  if (f === 'not_created') return !v.created;
  return true;
}
