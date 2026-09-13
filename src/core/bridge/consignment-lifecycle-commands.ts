// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — eine Kommission nach dem Verkauf vom zweiten Rechner: „Post-Sale Return"
// (`consignments.return_after_sale`) und „Cancel Sale" (`consignments.cancel_sale`).
//
// Derselbe Bau wie bei den Rücknahmen aus R6E (`sales-reversal-commands.ts`):
//
//  1. **Keine zweite Umkehrlogik.** Jeder Befehl ruft die Hausfolge, die auch die Maske des Primary ruft
//     (`core/consignment/consignment-reversal-house`) — darunter das Retourenhaus, der Retourenstorno,
//     die Rechnungsgrundlage und der Einkaufsstorno. Dieselbe Prüfung, dieselben Buchungen, in der
//     Transaktion des Auftrags. Scheitert eine Buchung, gibt es auch die Handlung nicht.
//  2. **Der Rumpf ist ein Wunsch.** Er nennt WELCHE Kommission, die gesehene Fassung und — beim
//     Post-Sale Return — die Wahl des Dialogs (Warenweg, Erstattungsweg, Grund). Rechnung, Zeile,
//     Beträge, Gutschrift, Einkauf, Ausgabe, Einstand, Bestand und Buchungen findet der Primary selbst:
//     sie stehen namentlich auf der Verbotsliste; ein unbekanntes Feld wird abgewiesen statt ignoriert.
//  3. **Ändern braucht die gesehene Fassung** (`consignments.revision`), verglichen INNERHALB der
//     Transaktion, vor jeder Regel.
//  4. **Der Urheber ist der geprüfte Absender** — im Protokoll und in jedem Beleg (zentral über
//     `runRemoteCommand`); seine Rolle entscheidet über den Retourenstorno im „Cancel Sale" (Owner).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import { ConsignmentActionRejected } from '@/core/consignment/consignment-finance';
import {
  POST_SALE_DISPOSITIONS, POST_SALE_REFUND_METHODS, type PostSaleDisposition,
} from '@/core/consignment/consignment-reversal';
import {
  cancelConsignmentSaleInHouse, returnConsignmentAfterSaleInHouse,
} from '@/core/consignment/consignment-reversal-house';
import { ReturnActionRejected, type ReturnRefundMethod } from '@/core/returns/return-create';
import { ReturnCancelRejected } from '@/core/returns/return-cancel-house';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { PurchaseLifecycleRejected } from '@/core/purchases/purchase-lifecycle-house';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useProductStore } from '@/stores/productStore';

export const OP_CONSIGNMENTS_RETURN_AFTER_SALE = 'consignments.return_after_sale';
export const OP_CONSIGNMENTS_CANCEL_SALE = 'consignments.cancel_sale';

export const CONSIGNMENT_LIFECYCLE_OPS = [OP_CONSIGNMENTS_RETURN_AFTER_SALE, OP_CONSIGNMENTS_CANCEL_SALE] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class ConsignmentLifecyclePayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'INVALID_PAYLOAD') {
    super(message);
    this.name = 'ConsignmentLifecyclePayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung, welcher Zustand. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'created_by', 'actor', 'changedBy', 'role',
  'createdAt', 'updatedAt', 'revision', 'status'];
/** Was nur das Hauptbuch schreibt — ein Rumpf bucht nie selbst. */
const LEDGER = ['ledger', 'entries', 'account', 'accounts', 'debit', 'credit', 'sourceModule', 'sourceId',
  'transactionId', 'entryNo', 'balance', 'amount'];
/** Was der Primary selbst findet oder rechnet — je Befehl. */
export const CONSIGNMENT_LIFECYCLE_COMPUTED = {
  returnAfterSale: ['invoiceId', 'invoiceLineId', 'invoiceStatus', 'lines', 'quantity', 'unitPrice', 'totalAmount',
    'vatAmount', 'vatCorrected', 'refundAmount', 'refundPaidAmount', 'cashRefundAmount', 'receivableCancelAmount',
    'creditNoteId', 'returnId', 'returnNumber', 'purchaseId', 'expenseId', 'costBasis', 'unitCost', 'purchasePrice',
    'salePrice', 'payoutAmount', 'payoutPaidAmount', 'payoutStatus', 'commissionAmount', 'productId', 'stockStatus',
    'consignmentNumber', 'notes', ...LEDGER],
  cancelSale: ['invoiceId', 'invoiceStatus', 'purchaseId', 'purchaseIds', 'expenseId', 'expenseIds', 'returnId',
    'returnIds', 'creditNoteId', 'creditNoteIds', 'salePrice', 'payoutAmount', 'payoutPaidAmount', 'payoutStatus',
    'commissionAmount', 'productId', 'stockStatus', 'quantity', 'consignmentNumber', 'reason', ...LEDGER],
} as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], computed: readonly string[]): Record<string, unknown> {
  if (!isPlain(raw)) throw new ConsignmentLifecyclePayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k) || computed.includes(k)) throw new ConsignmentLifecyclePayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new ConsignmentLifecyclePayloadError(`unknown field: ${k}`);
  }
  return raw;
}

function idOf(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new ConsignmentLifecyclePayloadError(`${name} is required`);
  return v.trim();
}

function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ConsignmentLifecyclePayloadError('expectedRevision is required — this action must say which revision it saw');
  }
  return v;
}

/** Ein Nein einer Hausfolge INNERHALB des Auftrags ist ein eingefrorenes Urteil; alles andere bleibt eine Störung. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof ConsignmentActionRejected || e instanceof ReturnActionRejected || e instanceof ReturnCancelRejected
      || e instanceof InvoiceActionRejected || e instanceof PurchaseLifecycleRejected) {
      throw new CommandRejected(e.code, e.message);
    }
    throw e;
  }
}

/** Die Rolle des Absenders — aus denselben geprüften Ansprüchen wie Filiale und Benutzer, nie aus dem Rumpf. */
const rolleVon = (identity: CommandIdentity): string | undefined => (identity as CommandIdentity & { role?: string }).role;

/** Der Stand einer Kommission danach, wie ihn auch der Lesebefehl zeigt — vom Primary gelesen. */
function stand(consignmentId: string): { status: string; payoutStatus: string; revision: number; productStockStatus: string } {
  const c = query('SELECT status, payout_status, revision, product_id FROM consignments WHERE id = ?', [consignmentId])[0];
  const p = query('SELECT stock_status FROM products WHERE id = ?', [String(c?.product_id ?? '')])[0];
  return {
    status: String(c?.status ?? ''),
    payoutStatus: String(c?.payout_status ?? ''),
    revision: Number(c?.revision ?? 0),
    productStockStatus: String(p?.stock_status ?? ''),
  };
}

/** Die Listen, die die Seiten des Primary danach zeigen. */
function frischLesen(): void {
  useConsignmentStore.getState().loadConsignments();
  useProductStore.getState().loadProducts();
}

// ── Die Rümpfe ──────────────────────────────────────────────────────────────

export interface ReturnAfterSaleRequest {
  consignmentId: string;
  expectedRevision: number;
  disposition: PostSaleDisposition;
  refundMethod?: ReturnRefundMethod;
  reason?: string;
}

export function parseReturnAfterSale(raw: unknown): ReturnAfterSaleRequest {
  const r = strict(raw, ['consignmentId', 'expectedRevision', 'disposition', 'refundMethod', 'reason'],
    CONSIGNMENT_LIFECYCLE_COMPUTED.returnAfterSale);
  if (typeof r.disposition !== 'string' || !(POST_SALE_DISPOSITIONS as readonly string[]).includes(r.disposition)) {
    throw new ConsignmentLifecyclePayloadError(`disposition is one of ${POST_SALE_DISPOSITIONS.join(', ')}`);
  }
  const out: ReturnAfterSaleRequest = {
    consignmentId: idOf(r.consignmentId, 'consignmentId'),
    expectedRevision: revisionOf(r.expectedRevision),
    disposition: r.disposition as PostSaleDisposition,
  };
  if (r.refundMethod !== undefined && r.refundMethod !== null) {
    if (typeof r.refundMethod !== 'string' || !(POST_SALE_REFUND_METHODS as readonly string[]).includes(r.refundMethod)) {
      throw new ConsignmentLifecyclePayloadError(`refundMethod is one of ${POST_SALE_REFUND_METHODS.join(', ')}`);
    }
    out.refundMethod = r.refundMethod as ReturnRefundMethod;
  }
  if (r.reason !== undefined && r.reason !== null) {
    if (typeof r.reason !== 'string') throw new ConsignmentLifecyclePayloadError('reason must be a string');
    if (r.reason.trim() !== '') out.reason = r.reason.trim();
  }
  return out;
}

export interface CancelSaleRequest { consignmentId: string; expectedRevision: number }

export function parseCancelSale(raw: unknown): CancelSaleRequest {
  const r = strict(raw, ['consignmentId', 'expectedRevision'], CONSIGNMENT_LIFECYCLE_COMPUTED.cancelSale);
  return { consignmentId: idOf(r.consignmentId, 'consignmentId'), expectedRevision: revisionOf(r.expectedRevision) };
}

// ── Die Läufe ───────────────────────────────────────────────────────────────

export function consignmentLifecycleDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runReturnAfterSale(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseReturnAfterSale(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const out = urteil(() => returnConsignmentAfterSaleInHouse(req.consignmentId, {
      disposition: req.disposition, refundMethod: req.refundMethod, reason: req.reason,
    }, identity.branchId, req.expectedRevision));
    const after = stand(req.consignmentId);
    if (after.status !== 'returned') throw new CommandNotEvaluated('RETURN_NOT_APPLIED', `status is ${after.status}`);
    const inv = out.invoiceId ? query('SELECT status FROM invoices WHERE id = ?', [out.invoiceId])[0] : undefined;
    frischLesen();
    return { ...out, ...after, invoiceStatus: String(inv?.status ?? '') };
  });
}

export function runCancelSale(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseCancelSale(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const out = urteil(() => cancelConsignmentSaleInHouse(
      req.consignmentId, { userId: identity.userId, role: rolleVon(identity) }, identity.branchId, req.expectedRevision,
    ));
    const after = stand(req.consignmentId);
    const still = query('SELECT invoice_id FROM consignments WHERE id = ?', [req.consignmentId])[0];
    if (after.status !== 'active' || String(still?.invoice_id ?? '') !== '') {
      throw new CommandNotEvaluated('CANCEL_NOT_APPLIED', `status is ${after.status}`);
    }
    const inv = out.invoiceId ? query('SELECT status FROM invoices WHERE id = ?', [out.invoiceId])[0] : undefined;
    frischLesen();
    return { ...out, ...after, invoiceStatus: String(inv?.status ?? '') };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(consignmentLifecycleDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof ConsignmentLifecyclePayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_CONSIGNMENTS_RETURN_AFTER_SALE, {
  kind: 'mutation', handler: (p, a) => execute(runReturnAfterSale, OP_CONSIGNMENTS_RETURN_AFTER_SALE, p, a),
});
registerCommand(OP_CONSIGNMENTS_CANCEL_SALE, {
  kind: 'mutation', handler: (p, a) => execute(runCancelSale, OP_CONSIGNMENTS_CANCEL_SALE, p, a),
});
