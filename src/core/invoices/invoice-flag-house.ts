// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — der Butterfly-Schalter einer Rechnung: EINE Folge für Maske und PC2.
//
// Butterfly ist eine Steuer-Meldemarke: eine so markierte Rechnung fällt aus dem NBR-Export
// (Vorauswahl der Liste) und aus der geschuldeten Quartals-Umsatzsteuer der Auswertung. Sie bewegt
// kein Geld, keinen Bestand, keine Buchung.
//
// Vorher schaltete die Seite sie über das allgemeine `updateInvoice` — dieselbe Funktion, die auch
// Status, Beträge und Nummer schreiben kann. Die darf nie aus der Ferne erreichbar sein. Deshalb eine
// eigene, enge Folge: genau EINE Spalte, die Fassung steigt über den Trigger, der Abgleich bekommt
// die Änderung wie bisher (`trackUpdate`). Die Regeln sind die der Seite: der Knopf steht nur an einer
// nicht stornierten Rechnung.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { trackUpdate } from '@/core/sync/track';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { InvoiceActionRejected } from './invoice-cancel';
import { assertInvoiceHouse, localInvoiceBranch } from './invoice-house-guards';

export interface InvoiceButterflySet {
  invoiceId: string;
  butterfly: boolean;
  revision: number;
  /** `false`: die Rechnung stand schon so — nichts geschrieben, die Fassung bleibt. */
  changed: boolean;
}

/**
 * Setzt die Marke. `expectedRevision` ist die Fassung, die die Maske gesehen hat — fern Pflicht,
 * am Primary schickt die Seite sie mit; verglichen wird INNERHALB der Transaktion.
 */
export function setInvoiceButterflyInHouse(
  invoiceId: string, butterfly: boolean, branchId: string, expectedRevision?: number,
): InvoiceButterflySet {
  assertInvoiceHouse(branchId);
  if (typeof butterfly !== 'boolean') throw new InvoiceActionRejected('INVALID_INPUT', 'butterfly must be true or false');
  const inv = query('SELECT id, status, butterfly, revision FROM invoices WHERE id = ? AND branch_id = ?', [invoiceId, branchId])[0];
  if (!inv) throw new InvoiceActionRejected('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  if (String(inv.status) === 'CANCELLED') {
    throw new InvoiceActionRejected('INVOICE_CANCELLED', 'a cancelled invoice is not flagged');
  }
  const seen = Number(inv.revision ?? 0);
  if (expectedRevision !== undefined && seen !== expectedRevision) {
    throw new InvoiceActionRejected('RECORD_CHANGED',
      `this invoice changed since you opened it (you saw ${expectedRevision}, it is now ${seen}) — reopen it`);
  }
  if ((Number(inv.butterfly ?? 0) === 1) === butterfly) {
    return { invoiceId, butterfly, revision: seen, changed: false };
  }
  getDatabase().run('UPDATE invoices SET butterfly = ?, updated_at = ? WHERE id = ?',
    [butterfly ? 1 : 0, new Date().toISOString(), invoiceId]);
  trackUpdate('invoices', invoiceId, { butterfly });
  const revision = Number(query('SELECT revision FROM invoices WHERE id = ?', [invoiceId])[0]?.revision ?? 0);
  return { invoiceId, butterfly, revision, changed: true };
}

/** Der Knopf am Primary: exklusiv, EINE Transaktion, danach durabel. */
export async function setInvoiceButterflyOnPrimary(
  invoiceId: string, butterfly: boolean, expectedRevision?: number,
): Promise<InvoiceButterflySet> {
  const branchId = localInvoiceBranch();
  return runOnPrimary(
    () => setInvoiceButterflyInHouse(invoiceId, butterfly, branchId, expectedRevision),
    () => useInvoiceStore.getState().loadInvoices(),
  );
}

/** Der Rumpf von `invoices.set_butterfly`, wie ihn die Seite am zweiten Rechner baut. */
export function invoiceButterflyBody(invoiceId: string, butterfly: boolean, expectedRevision: number): Record<string, unknown> {
  return { invoiceId, expectedRevision, butterfly };
}
