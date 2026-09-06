// CENTRAL-C3H — was die Lebenszyklus-Knöpfe des Clients entscheiden, ohne JSX.
//
// Dieselbe Regel wie bei den Geldknöpfen aus C3G, nur an mehr Stellen: der Rumpf trägt eine
// Kennung, die gelesene FASSUNG und ausdrücklich das, was ein Mensch eingetippt hat. Nichts, was
// der Client selbst ausgerechnet hat — und vor allem keinen Preis.
//
// Der schärfste Fall ist die Rückgabe: sie nennt WELCHE Rechnungszeile und WIE VIELE Stück, und
// nicht, was das kostet. Der Preis steht auf der Rechnung; ihn im Rumpf mitzuschicken hieße, dass
// ein zweiter Rechner eine Rückgabe zu einem Betrag buchen könnte, den es dort nie gab.
//
// Und jede dieser Handlungen ist ein EIGENER Vorsatz. Ein hängengebliebener Statuswechsel darf
// niemals als Zahlung weiterlaufen; deshalb bekommt jede ihren eigenen Wächter — das steht in den
// Formularen, aber der Grund gehört hierher.

import { amountOf } from './client-financial-request';

const t = (v: string | undefined): string => (v ?? '').trim();

// ── Rückgabe ──────────────────────────────────────────────────────────────

export interface ReturnDraftLine {
  invoiceLineId: string;
  /** Was ein Mensch eingetippt hat — als Text, damit „leer" von „null" unterscheidbar bleibt. */
  quantity: string;
}

/**
 * Nur Zeilen mit einer Menge > 0 reisen mit. Eine Zeile mit „0" ist keine Rückgabe, und der
 * Primary würde sie abweisen — der Mensch bekäme eine Fehlermeldung statt einer Eingabehilfe.
 */
export function createReturnRequest(
  invoiceId: string, revision: number, lines: ReturnDraftLine[],
  opts: { refundMethod?: string; productDisposition?: string; reason?: string; notes?: string } = {},
): Record<string, unknown> {
  const picked = lines
    .map((l) => ({ invoiceLineId: l.invoiceLineId, quantity: amountOf(l.quantity) ?? 0 }))
    .filter((l) => l.quantity > 0);
  const body: Record<string, unknown> = { invoiceId, expectedRevision: revision, lines: picked };
  if (t(opts.refundMethod)) body.refundMethod = t(opts.refundMethod);
  if (t(opts.productDisposition)) body.productDisposition = t(opts.productDisposition);
  if (t(opts.reason)) body.reason = t(opts.reason);
  if (t(opts.notes)) body.notes = t(opts.notes);
  return body;
}

export function returnLineCount(body: Record<string, unknown>): number {
  return Array.isArray(body.lines) ? body.lines.length : 0;
}

export function approveReturnRequest(returnId: string, revision: number): Record<string, unknown> {
  return { returnId, expectedRevision: revision };
}

export function refundReturnRequest(returnId: string, revision: number, amount: string): Record<string, unknown> {
  return { returnId, amount: amountOf(amount) ?? 0, expectedRevision: revision };
}

export function recordRefundPaymentRequest(
  returnId: string, revision: number, amount: string, method: string,
  opts: { date?: string; deductCardFee?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    returnId, amount: amountOf(amount) ?? 0, method, expectedRevision: revision,
  };
  if (t(opts.date)) body.date = t(opts.date);
  // Nur wenn ein Mensch sie wirklich gesetzt hat — sie entscheidet, wer die Kartengebühr trägt,
  // und gilt für GENAU diese Auszahlung.
  if (opts.deductCardFee) body.deductCardFee = true;
  return body;
}

// ── Auftrag ───────────────────────────────────────────────────────────────

/** Der Zielzustand kommt aus `nextStatus` des Lesebefehls — nicht aus einer Liste im Client. */
export function orderStatusRequest(orderId: string, revision: number, status: string): Record<string, unknown> {
  return { orderId, status, expectedRevision: revision };
}

export function addOrderPaymentRequest(
  orderId: string, revision: number, amount: string, method: string,
  opts: { paidAt?: string; reference?: string; note?: string } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    orderId, amount: amountOf(amount) ?? 0, method, expectedRevision: revision,
  };
  if (t(opts.paidAt)) body.paidAt = t(opts.paidAt);
  if (t(opts.reference)) body.reference = t(opts.reference);
  if (t(opts.note)) body.note = t(opts.note);
  return body;
}

export function deleteOrderPaymentRequest(orderId: string, paymentId: string, revision: number): Record<string, unknown> {
  return { orderId, paymentId, expectedRevision: revision };
}

// ── Kommission ────────────────────────────────────────────────────────────

export function recordSaleRequest(
  consignmentId: string, revision: number, buyerId: string, salePrice: string,
  opts: { saleDate?: string; notes?: string; acknowledgeShortfall?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    consignmentId, buyerId, salePrice: amountOf(salePrice) ?? 0, expectedRevision: revision,
  };
  if (t(opts.saleDate)) body.saleDate = t(opts.saleDate);
  if (t(opts.notes)) body.notes = t(opts.notes);
  // Wie am Bildschirm: ein Verkauf unter dem Boden des Einlieferers braucht eine ausdrückliche
  // Bestätigung. Sie bestätigt genau das und schaltet nichts anderes ab.
  if (opts.acknowledgeShortfall) body.acknowledgeShortfall = true;
  return body;
}

export function consignmentReturnRequest(consignmentId: string, revision: number): Record<string, unknown> {
  return { consignmentId, expectedRevision: revision };
}

// ── Reparatur ─────────────────────────────────────────────────────────────

/** Auch hier: der Zielzustand kommt aus `allowedStatusTargets` des Lesebefehls. */
export function repairStatusRequest(repairId: string, revision: number, status: string): Record<string, unknown> {
  return { repairId, status, expectedRevision: revision };
}

export function repairInvoiceRequest(repairId: string, revision: number): Record<string, unknown> {
  return { repairId, expectedRevision: revision };
}

export const REPAIR_LINE_FIELDS = ['costAmount', 'supplierId', 'workType', 'description', 'dueDate', 'notes'] as const;

export function addRepairLineRequest(
  repairId: string, revision: number, draft: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    repairId, costAmount: amountOf(draft.costAmount ?? '') ?? 0, expectedRevision: revision,
  };
  for (const f of REPAIR_LINE_FIELDS) {
    if (f === 'costAmount') continue;
    if (t(draft[f])) body[f] = t(draft[f]);
  }
  return body;
}

/**
 * Nur der Unterschied. Ein Formular, das alle Felder zurückschickt, schriebe eine Kostenzeile
 * neu, die niemand angefasst hat — und jede Neubuchung ist ein Storno plus eine Buchung.
 */
export function updateRepairLineRequest(
  repairId: string, lineId: string, revision: number,
  base: Record<string, string>, now: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { repairId, lineId, expectedRevision: revision };
  for (const f of REPAIR_LINE_FIELDS) {
    if ((base[f] ?? '') === (now[f] ?? '')) continue;
    if (f === 'costAmount') {
      const v = amountOf(now[f] ?? '');
      if (v === null) continue;
      body[f] = v;
      continue;
    }
    body[f] = t(now[f]);
  }
  return body;
}

export function cancelRepairLineRequest(
  repairId: string, lineId: string, revision: number, notes = '',
): Record<string, unknown> {
  const body: Record<string, unknown> = { repairId, lineId, expectedRevision: revision };
  if (t(notes)) body.notes = t(notes);
  return body;
}

// ── Agenten-Transfer → Rechnung ───────────────────────────────────────────

export function convertTransferRequest(
  transferId: string, revision: number, customerId: string,
): Record<string, unknown> {
  return { transferId, customerId, expectedRevision: revision };
}

/**
 * Die Sammelrechnung nennt JEDEN Vorgang mit SEINER gelesenen Fassung. Eine Rechnung über fünf
 * Transfers, von denen sich einer bewegt hat, ist eine andere Rechnung — und muss abgewiesen
 * werden, nicht stillschweigend eine andere Summe bekommen.
 */
export function convertTransfersRequest(
  transfers: Array<{ id: string; revision: number }>, customerId: string,
): Record<string, unknown> {
  return {
    transfers: transfers.map((x) => ({ id: x.id, expectedRevision: x.revision })),
    customerId,
  };
}

/** Was ein Rumpf außer Kennungen und Fassung noch trägt. Nichts = nichts zu tun. */
export function lifecycleChangeCount(body: Record<string, unknown>): number {
  const keys = ['invoiceId', 'orderId', 'consignmentId', 'repairId', 'transferId', 'returnId',
    'lineId', 'paymentId', 'expectedRevision'];
  return Object.keys(body).filter((k) => !keys.includes(k)).length;
}
