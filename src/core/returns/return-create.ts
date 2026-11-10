// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F — eine Retoure anlegen: EINE Vorbereitung für beide Seiten.
//
// Die Maske „Return from Customer" legte die Retoure an und erstattete danach — getrennt, ohne
// Klammer — sofort („Refund jetzt zahlen", bei Store-Guthaben IMMER). Sie nannte dazu den
// Mitarbeiter und eine von fünf Warenfolgen. Der Fernbefehl kannte weder Mitarbeiter noch
// „Under Repair" noch das sofortige Erstatten.
//
// Jetzt schickt die Maske ihre EINGABEN (Zeile + Menge, Weg, Warenfolge, Grund, Notiz, Mitarbeiter,
// sofort oder später). Preis, Steuer, Gutschrift, Deckel und Buchung rechnet das Haus
// (`return-house`) — am Primary wie fern.
// ════════════════════════════════════════════════════════════════════════════
import type { ProductDisposition } from '@/core/models/types';

/** Ein Nein der geteilten Regeln — am Primary eine Absage der Maske, fern ein eingefrorenes Urteil. */
export class ReturnActionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ReturnActionRejected';
  }
}

/** Die Erstattungswege der Maske — `credit` ist Store-Guthaben. */
export const RETURN_REFUND_METHODS = ['cash', 'bank', 'card', 'benefit', 'credit', 'other'] as const;
export type ReturnRefundMethod = typeof RETURN_REFUND_METHODS[number];

/** Die bisherige Voreinstellung der Maske — unverändert, wenn kein Store-Guthaben die Rechnung bezahlt hat. */
export const RETURN_DEFAULT_REFUND_METHOD: ReturnRefundMethod = 'bank';

export interface ReturnRefundSuggestion {
  /** Die vorgeschlagene Erstattungsart (nur Vorbelegung — der Benutzer darf jede zulässige Art wählen). */
  method: ReturnRefundMethod;
  /** all_store_credit: ganz mit Store-Guthaben bezahlt; mixed_store_credit: auch mit anderem Geld/Verrechnung; none. */
  basis: 'all_store_credit' | 'mixed_store_credit' | 'none';
  /** Bezahlt mit Store-Guthaben (Zahlart 'credit') bzw. mit allem anderen (Geld, Darlehen, Anzahlung), BHD. */
  storeCredit: number;
  other: number;
}

/**
 * Owner 10.11.2026 (Variante C) — welche Erstattungsart die Rückgabemaske VORSCHLÄGT. Eine reine Vorbelegung: Buchung,
 * Erstattungsbetrag (`computeRefundSplit`) und die wählbaren Arten bleiben, wie sie sind.
 *   • ganz mit Store-Guthaben bezahlt (nur Zahlart 'credit') → „Store Credit";
 *   • gemischt (Store-Guthaben UND Geld oder Verrechnung) → keine Vorbelegung: eine Rückgabe hat EINE Erstattungsart, und
 *     welcher Teil der Zahlung erstattet wird, ist nicht eindeutig — die Maske nennt die Anteile, der Benutzer wählt;
 *   • sonst die bisherige Voreinstellung.
 * Dieselbe Funktion am Primary und auf PC2 (die Zahlungen kommen aus derselben Auskunft `page.invoice_print.get`).
 */
export function suggestReturnRefund(payments: ReadonlyArray<{ method: string; amount: number }>): ReturnRefundSuggestion {
  const f = (v: number): number => Math.round((Number(v) || 0) * 1000);
  const creditF = payments.filter((p) => p.method === 'credit').reduce((s, p) => s + f(p.amount), 0);
  const otherF = payments.filter((p) => p.method !== 'credit').reduce((s, p) => s + f(p.amount), 0);
  const basis = creditF > 5 ? (otherF > 5 ? 'mixed_store_credit' : 'all_store_credit') : 'none';
  return {
    method: basis === 'all_store_credit' ? 'credit' : RETURN_DEFAULT_REFUND_METHOD,
    basis, storeCredit: creditF / 1000, other: otherF / 1000,
  };
}

/** Die Warenfolgen der Maske; die letzten beiden bietet sie nur an, wenn Kommissionsware zurückkommt. */
export const RETURN_DISPOSITIONS: readonly ProductDisposition[] = ['IN_STOCK', 'UNDER_REPAIR', 'WRITE_OFF', 'RETURN_TO_OWNER', 'KEEP_AS_OWN'];
export const CONSIGNMENT_DISPOSITIONS: readonly ProductDisposition[] = ['RETURN_TO_OWNER', 'KEEP_AS_OWN'];

/** Die EINGABEN der Maske — nichts, was das Haus ableitet (kein Preis, keine Steuer, kein Betrag). */
export interface ReturnCreateInput {
  invoiceId: string;
  lines: Array<{ invoiceLineId: string; quantity: number }>;
  refundMethod?: ReturnRefundMethod;
  productDisposition: ProductDisposition;
  reason?: string;
  notes?: string;
  staffId?: string;
  /** „Refund jetzt zahlen" — sonst bleibt die Erstattung offen („Pending"). */
  refundNow: boolean;
}

/** Sofort erstatten: wenn gewählt — und bei Store-Guthaben IMMER (sonst bliebe ein offener Guthaben-Return). */
export function refundsImmediately(i: Pick<ReturnCreateInput, 'refundNow' | 'refundMethod'>): boolean {
  return i.refundNow || i.refundMethod === 'credit';
}

export interface ReturnDraftState {
  refundMethod: ReturnRefundMethod;
  productDisposition: ProductDisposition;
  reason: string;
  notes: string;
  staffId: string;
  refundNow: boolean;
}

/** Aus der Maske: die angehakten Zeilen mit einer Menge über null, in der Reihenfolge der Rechnung. */
export function returnCreateInput(
  invoiceId: string,
  invoiceLines: ReadonlyArray<{ id: string }>,
  picked: Record<string, { include: boolean; quantity: number } | undefined>,
  f: ReturnDraftState,
): ReturnCreateInput {
  return {
    invoiceId,
    lines: invoiceLines
      .filter((l) => !!picked[l.id]?.include && (picked[l.id]?.quantity ?? 0) > 0)
      .map((l) => ({ invoiceLineId: l.id, quantity: picked[l.id]!.quantity })),
    refundMethod: f.refundMethod,
    productDisposition: f.productDisposition,
    reason: f.reason || undefined,
    notes: f.notes || undefined,
    staffId: f.staffId || undefined,
    refundNow: f.refundNow,
  };
}

/** Die Wertebereiche — dieselben, die die Maske anbietet. */
export function assertReturnCreateValues(i: ReturnCreateInput): void {
  const bad = (m: string): never => { throw new ReturnActionRejected('INVALID_INPUT', m); };
  if (i.refundMethod !== undefined && !(RETURN_REFUND_METHODS as readonly string[]).includes(i.refundMethod)) {
    bad(`unknown refund method: ${i.refundMethod}`);
  }
  if (!RETURN_DISPOSITIONS.includes(i.productDisposition)) bad(`unknown product disposition: ${i.productDisposition}`);
  if (i.lines.length === 0) throw new ReturnActionRejected('RETURN_NO_LINES', 'a return needs at least one line');
  const seen = new Set<string>();
  for (const l of i.lines) {
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) bad('a return quantity is a positive number');
    // Zweimal dieselbe Zeile umginge den Mengendeckel: jede einzelne läge unter dem Rest.
    if (seen.has(l.invoiceLineId)) bad('the same invoice line twice is not a return');
    seen.add(l.invoiceLineId);
  }
}

/** Der Rumpf von `returns.create`, wie ihn die Maske am zweiten Rechner baut. */
export function returnCreateBody(i: ReturnCreateInput, invoiceRevision: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    invoiceId: i.invoiceId,
    expectedRevision: invoiceRevision,
    lines: i.lines.map((l) => ({ invoiceLineId: l.invoiceLineId, quantity: l.quantity })),
    productDisposition: i.productDisposition,
    refundNow: i.refundNow,
  };
  if (i.refundMethod !== undefined) body.refundMethod = i.refundMethod;
  if (i.reason !== undefined) body.reason = i.reason;
  if (i.notes !== undefined) body.notes = i.notes;
  if (i.staffId !== undefined) body.staffId = i.staffId;
  return body;
}
