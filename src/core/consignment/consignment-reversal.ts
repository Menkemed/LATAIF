// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — eine Kommission NACH dem Verkauf: „Post-Sale Return" und „Cancel Sale".
// EINE Vorbereitung für beide Seiten (Maske am Primary, Fernbefehl von PC2): die Regeln, die der Knopf
// und die Hausfolge teilen, die EINGABEN der Dialoge und die Rümpfe. Die Folgen selbst stehen in
// `consignment-reversal-house` — diese Datei kennt keine Datenbank.
// ════════════════════════════════════════════════════════════════════════════
import { RETURN_REFUND_METHODS, type ReturnRefundMethod } from '@/core/returns/return-create';

/** Die zwei Wege des Dialogs „Buyer Returns the Item" — dieselben zwei, die der Store schon kannte. */
export const POST_SALE_DISPOSITIONS = ['RETURN_TO_OWNER', 'KEEP_AS_OWN'] as const;
export type PostSaleDisposition = typeof POST_SALE_DISPOSITIONS[number];

/**
 * Wie der Käufer sein Geld zurückbekommt — die Wege der Retourenmaske (`RETURN_REFUND_METHODS`), keine
 * eigene Liste. Ohne Wahl gilt, was der Store bisher fest einsetzte: bar.
 */
export const POST_SALE_REFUND_METHODS: readonly ReturnRefundMethod[] = RETURN_REFUND_METHODS;
export const DEFAULT_POST_SALE_REFUND_METHOD: ReturnRefundMethod = 'cash';

/** Die EINGABEN von „Buyer Returns the Item" — kein Betrag, keine Zeile, keine Steuer (die rechnet das Haus). */
export interface ConsignmentReturnAfterSaleInput {
  disposition: PostSaleDisposition;
  refundMethod?: ReturnRefundMethod;
  reason?: string;
}

/**
 * Der Vermerk, an dem die Rückgabe NACH dem Verkauf ihre Retoure wiedererkennt (Doppelsperre, Storno).
 * Wortgleich mit dem, was `markReturnedAfterSale` schon immer in `sales_returns.notes` schrieb — damit
 * auch die Retouren aus der Zeit vor R6F gefunden werden.
 */
export function postSaleReturnMarker(consignmentNumber: string): string {
  return `Consignment post-sale return (${consignmentNumber})`;
}

/** Ein Nein mit Code und Worten — Knopf und Hausfolge nennen dasselbe. */
export interface ConsignmentVerdict { code: string; message: string }

export const CONSIGNMENT_PRIMARY_ONLY = 'CONSIGNMENT_PRIMARY_ONLY';

/**
 * Wann „Post-Sale Return" geht: die Maske bietet ihn bei „sold" und „paid_out" an. Eine schon
 * zurückgegebene Kommission ist kein zweites Mal zurückzugeben (vorher ein stilles Nichts im Store).
 */
export function postSaleReturnBlocker(status: unknown): ConsignmentVerdict | null {
  const s = String(status ?? '');
  if (s === 'sold' || s === 'paid_out') return null;
  if (s === 'returned') {
    return { code: 'CONSIGNMENT_ALREADY_RETURNED', message: 'this consignment has already been returned after its sale' };
  }
  return { code: 'CONSIGNMENT_NOT_SOLD', message: `this consignment is "${s}" — only a sold one comes back after its sale` };
}

/**
 * Wann „Cancel Sale" geht — genau die drei Knöpfe der Maske: verkauft MIT Rechnung, zurückgegeben MIT
 * Rechnung („Cancel Sale (cleanup)") und ausbezahlt (auch der Altweg ohne Rechnung). Ein Verkauf ohne
 * Rechnung, der noch nicht ausbezahlt ist, bot den Knopf nie an.
 */
export function cancelSaleBlocker(status: unknown, invoiceId: unknown): ConsignmentVerdict | null {
  const s = String(status ?? '');
  const mitRechnung = String(invoiceId ?? '') !== '';
  if ((s === 'sold' && mitRechnung) || (s === 'returned' && mitRechnung) || s === 'paid_out') return null;
  return {
    code: 'CONSIGNMENT_SALE_NOT_CANCELLABLE',
    message: `this consignment is "${s}"${mitRechnung ? '' : ' without an invoice'} — there is no sale to cancel`,
  };
}

/**
 * Welche Rechnung der Verkaufsstorno umkehrt: jede, die noch nicht storniert ist — auch eine voll
 * bezahlte (FINAL). Das tat `cancelSale` schon immer (direkt über `updateInvoice`); die Regel der Maske
 * „Cancel Invoice" (FINAL/RETURNED nur per Retoure) gilt hier nicht, denn der ganze Verkauf fällt weg.
 * Offene Retouren an der Rechnung sperrt die Grundlage selbst (`requireNoReturns`).
 */
export function consignmentSaleInvoiceRule(): ConsignmentVerdict | null {
  return null;
}

/** Der Rumpf von `consignments.return_after_sale`, wie ihn die Maske am zweiten Rechner baut. */
export function consignmentReturnAfterSaleBody(
  id: string, revision: number, i: ConsignmentReturnAfterSaleInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = { consignmentId: id, expectedRevision: revision, disposition: i.disposition };
  if (i.refundMethod !== undefined) body.refundMethod = i.refundMethod;
  if (i.reason !== undefined && i.reason.trim() !== '') body.reason = i.reason;
  return body;
}

/** Der Rumpf von `consignments.cancel_sale` — WELCHE Kommission, in welcher Fassung. Sonst nichts. */
export function consignmentCancelSaleBody(id: string, revision: number): Record<string, unknown> {
  return { consignmentId: id, expectedRevision: revision };
}
