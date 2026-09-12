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
