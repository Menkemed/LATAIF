// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1a — wer eine Rechnung mit Kommissionsware anlegen oder korrigieren darf (Owner-
// Entscheidung: ADMIN und MANAGER, auch nach Auszahlungen an den Einlieferer). EINE Stelle für Maske,
// Fernauftrag und Hausfolge — geprüft wird im Haus gegen die Rolle des geprüften Absenders (am Primary
// die der Sitzung), nicht nur in der Oberfläche.
//
// Dieselbe Ableitung wie `usePermission().isAdmin` und die Regel `isAdmin` der Fernaufträge
// (`command-permissions.ts`): ADMIN oder MANAGER. Bestehende Rechte ändern sich dadurch nicht — diese
// Prüfung gilt nur für die neuen Mixed-Invoice-Wege (P3/P4). Unbekannt oder fehlend = kein Recht.
// ════════════════════════════════════════════════════════════════════════════
import { canonicalRole } from '@/core/models/types';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';

export const MIXED_INVOICE_NOT_PERMITTED = 'MIXED_INVOICE_NOT_PERMITTED';

/** Darf diese Rolle gemischte Rechnungen (eigene Ware + Kommission) anlegen und korrigieren? */
export function mayManageMixedInvoices(role: string | null | undefined): boolean {
  if (typeof role !== 'string' || role.trim() === '') return false;
  const c = canonicalRole(role);
  return c === 'ADMIN' || c === 'MANAGER';
}

/** Wirft, wenn der Handelnde keine gemischte Rechnung anlegen oder korrigieren darf. */
export function assertMixedInvoiceActor(actor: { role?: string | null } | null | undefined): void {
  if (!mayManageMixedInvoices(actor?.role)) {
    throw new InvoiceActionRejected(MIXED_INVOICE_NOT_PERMITTED,
      'Only an ADMIN or MANAGER can create or correct an invoice with consignment items. Nothing was changed.');
  }
}
