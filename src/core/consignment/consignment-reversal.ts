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

// ── D3 — die schon geleistete Auszahlung an den Einlieferer, wenn die Ware zu ihm zurückgeht ──────────────
//
// War der Einkauf beim Einlieferer schon (teilweise) bezahlt, stornierte die Rücknahme ihn bisher samt Zahlungen:
// das Hauptbuch zeigte die Auszahlung HEUTE als zurückgekommen, ohne dass Geld kam. Jetzt entscheidet der Owner,
// und gebucht wird über die VORHANDENE Lieferanten-Retoure (PRET) dieses Einkaufs — keine neue Buchungsregel:
//   • „received": der Einlieferer hat das Geld zurückgegeben — Eingang auf Kasse/Bank/Benefit (Weg wählbar), heute;
//   • „pending":  das Geld kommt später — der bezahlte Betrag wird Lieferanten-Guthaben beim Einlieferer (eine offene
//                 Rückforderung, verrechenbar wie jedes Guthaben). Die ursprüngliche Auszahlung bleibt stehen.

export const CONSIGNOR_REFUND_MODES = ['received', 'pending'] as const;
export type ConsignorRefundMode = typeof CONSIGNOR_REFUND_MODES[number];
/** Wie das Geld des Einlieferers zurückkam — die Wege der Lieferanten-Retoure ohne „credit". */
export const CONSIGNOR_REFUND_METHODS = ['cash', 'bank', 'benefit'] as const;
export type ConsignorRefundMethod = typeof CONSIGNOR_REFUND_METHODS[number];

export type ConsignorRefundChoice =
  | { mode: 'received'; method: ConsignorRefundMethod }
  | { mode: 'pending' };

export const CONSIGNOR_REFUND_REQUIRED = 'CONSIGNOR_REFUND_REQUIRED';
export const CONSIGNOR_REFUND_INVALID = 'CONSIGNOR_REFUND_INVALID';
export const CONSIGNOR_PAID_BY_CREDIT = 'CONSIGNOR_PAID_BY_CREDIT';
export const CONSIGNOR_LOSS_PAID = 'CONSIGNOR_LOSS_PAID';
export const CONSIGNOR_PAYOUT_PAID_LEGACY = 'CONSIGNOR_PAYOUT_PAID_LEGACY';
export const CONSIGNMENT_CONSIGNOR_SETTLED = 'CONSIGNMENT_CONSIGNOR_SETTLED';

/** Die Wahl prüfen — rein, ohne Datenbank (Maske, Fernrumpf und Haus nennen dasselbe Nein). */
export function consignorRefundOf(raw: unknown): ConsignorRefundChoice | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'mode' && k !== 'method')) return null;
  if (r.mode === 'pending' && r.method === undefined) return { mode: 'pending' };
  if (r.mode === 'received' && (CONSIGNOR_REFUND_METHODS as readonly unknown[]).includes(r.method)) {
    return { mode: 'received', method: r.method as ConsignorRefundMethod };
  }
  return null;
}

/** Die EINGABEN von „Buyer Returns the Item" — kein Betrag, keine Zeile, keine Steuer (die rechnet das Haus). */
export interface ConsignmentReturnAfterSaleInput {
  disposition: PostSaleDisposition;
  refundMethod?: ReturnRefundMethod;
  /** D3 — nur bei „Return to Owner", wenn der Einlieferer schon (teilweise) bezahlt ist: Pflicht. */
  consignorRefund?: ConsignorRefundChoice;
  reason?: string;
  /** CONSIGNMENT-INTEGRITY F6 — nur wenn die Rückgabe von der Rechnung aus kommt: Notiz und Mitarbeiter der
   *  Retourenmaske gehen nicht verloren. Kein Teil des Fernrumpfs `consignments.return_after_sale`. */
  notes?: string;
  staffId?: string;
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
  if (i.consignorRefund !== undefined) body.consignorRefund = { ...i.consignorRefund };
  if (i.reason !== undefined && i.reason.trim() !== '') body.reason = i.reason;
  return body;
}

/**
 * Der Rumpf von `consignments.cancel_sale` — WELCHE Kommission, in welcher Fassung; bei einem bezahlten Einlieferer
 * (D3) je Kommission die Wahl, was mit seiner Auszahlung geschieht. Sonst nichts.
 */
export function consignmentCancelSaleBody(
  id: string, revision: number, consignorRefunds?: Readonly<Record<string, ConsignorRefundChoice>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { consignmentId: id, expectedRevision: revision };
  if (consignorRefunds && Object.keys(consignorRefunds).length > 0) {
    body.consignorRefunds = Object.fromEntries(Object.entries(consignorRefunds).map(([k, v]) => [k, { ...v }]));
  }
  return body;
}
