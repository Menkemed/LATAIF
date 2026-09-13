// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — zwei Rücknahmen vom zweiten Rechner: „Cancel Return" (`returns.cancel`)
// und „Undo convert" eines Agenten-Transfers (`transfers.undo_convert`).
//
// Derselbe Bau wie bei Geld und Stammdaten (`money-commands.ts`, `masterdata-commands.ts`):
//
//  1. **Keine zweite Umkehrlogik.** Jeder Befehl ruft die Hausfolge, die auch die Maske des Primary
//     ruft — `cancelReturnInHouse` (core/returns/return-cancel-house) und
//     `undoTransferConversionInHouse` (core/agents/transfer-house, darunter die geteilte Grundlage
//     `reverseInvoiceInHouse`). Dieselbe Prüfung, dieselben Stornobuchungen, in der Transaktion des
//     Auftrags. Scheitert eine Buchung, gibt es auch den Storno nicht.
//  2. **Der Rumpf ist ein Wunsch.** Er nennt WELCHE Retoure / WELCHEN Transfer und die gesehene
//     Fassung (und beim Storno den Grund). Status, Beträge, Gutschriften, Guthaben, Buchungen und
//     die Rechnung des Transfers findet der Primary selbst — sie stehen namentlich auf der
//     Verbotsliste; ein unbekanntes Feld wird abgewiesen statt ignoriert.
//  3. **Ändern braucht die gesehene Fassung** (`sales_returns.revision` / `agent_transfers.revision`),
//     verglichen INNERHALB der Transaktion.
//  4. **Das Owner-Recht gilt dem Absender.** `returns.cancel` verlangt zentral `isOwner` (kanonisch
//     ADMIN); die Hausfolge prüft die Rolle des Auftraggebers noch einmal und schreibt SEINEN Namen
//     ins Protokoll — nicht den der Sitzung am Primary.
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
import { ReturnCancelRejected, RETURN_REASON_REQUIRED, cancelReturnInHouse } from '@/core/returns/return-cancel-house';
import { undoTransferConversionInHouse } from '@/core/agents/transfer-house';
import { TransferActionRejected } from '@/core/agents/transfer-rules';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';

export const OP_RETURNS_CANCEL = 'returns.cancel';
export const OP_TRANSFERS_UNDO_CONVERT = 'transfers.undo_convert';

export const SALES_REVERSAL_OPS = [OP_RETURNS_CANCEL, OP_TRANSFERS_UNDO_CONVERT] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class SalesReversalPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'INVALID_PAYLOAD') {
    super(message);
    this.name = 'SalesReversalPayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung, welcher Zustand. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status',
  'role', 'actor', 'changedBy'];
/** Was nur das Hauptbuch schreibt — ein Rumpf bucht nie selbst. */
const LEDGER = ['ledger', 'entries', 'account', 'accounts', 'debit', 'credit', 'sourceModule', 'sourceId',
  'transactionId', 'entryNo', 'balance', 'amount'];
/** Was der Primary selbst findet oder rechnet — je Befehl. */
export const REVERSAL_COMPUTED = {
  returnCancel: ['invoiceId', 'invoiceStatus', 'returnNumber', 'refundStatus', 'refundAmount', 'refundPaidAmount',
    'totalAmount', 'vatCorrected', 'vatAmount', 'productDisposition', 'creditNoteId', 'creditNoteIds',
    'customerCreditId', 'customerCreditIds', 'creditIds', 'reversedCreditNotes', 'removedCustomerCredits',
    'cardFeeRestored', 'lines', ...LEDGER],
  transferUndo: ['invoiceId', 'invoiceStatus', 'invoiceNumber', 'transferIds', 'transfers', 'agentId', 'customerId',
    'productId', 'stockStatus', 'quantity', 'settlementAmount', 'settlementPaidAmount', 'settlementStatus',
    'actualSalePrice', 'grossAmount', 'paidAmount', 'invoiceReversed', 'receivablesRestored', ...LEDGER],
} as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], computed: readonly string[]): Record<string, unknown> {
  if (!isPlain(raw)) throw new SalesReversalPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k) || computed.includes(k)) throw new SalesReversalPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new SalesReversalPayloadError(`unknown field: ${k}`);
  }
  return raw;
}

function idOf(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new SalesReversalPayloadError(`${name} is required`);
  return v.trim();
}

function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new SalesReversalPayloadError('expectedRevision is required — a reversal must say which revision it saw');
  }
  return v;
}

/** Ein Nein der Hausfolge INNERHALB des Auftrags ist ein eingefrorenes Urteil; alles andere bleibt eine Störung. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof ReturnCancelRejected || e instanceof TransferActionRejected || e instanceof InvoiceActionRejected) {
      throw new CommandRejected(e.code, e.message);
    }
    throw e;
  }
}

/** Die Rolle des Absenders — aus denselben geprüften Ansprüchen wie Filiale und Benutzer, nie aus dem Rumpf. */
const rolleVon = (identity: CommandIdentity): string | undefined => (identity as CommandIdentity & { role?: string }).role;

// ── Die Rümpfe ──────────────────────────────────────────────────────────────

export interface ReturnCancelRequest { returnId: string; expectedRevision: number; reason: string }

export function parseReturnCancel(raw: unknown): ReturnCancelRequest {
  const r = strict(raw, ['returnId', 'expectedRevision', 'reason'], REVERSAL_COMPUTED.returnCancel);
  const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
  // Die Maske verlangt den Grund („REASON", Knopf gesperrt ohne ihn) — dieselbe Regel, derselbe Code.
  if (!reason) throw new SalesReversalPayloadError('A reason is required to cancel a return.', RETURN_REASON_REQUIRED);
  return { returnId: idOf(r.returnId, 'returnId'), expectedRevision: revisionOf(r.expectedRevision), reason };
}

export interface TransferUndoRequest { transferId: string; expectedRevision: number }

export function parseTransferUndo(raw: unknown): TransferUndoRequest {
  const r = strict(raw, ['transferId', 'expectedRevision'], REVERSAL_COMPUTED.transferUndo);
  return { transferId: idOf(r.transferId, 'transferId'), expectedRevision: revisionOf(r.expectedRevision) };
}

// ── Die Läufe ───────────────────────────────────────────────────────────────

export function reversalDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runReturnCancel(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseReturnCancel(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => cancelReturnInHouse(
      req.returnId, req.reason, { userId: identity.userId, role: rolleVon(identity) }, identity.branchId, req.expectedRevision,
    ));
    return { ...r };
  });
}

/** Der Stand eines Transfers nach der Rücknahme, wie ihn auch der Lesebefehl zeigt. */
function transferStand(id: string): Record<string, unknown> {
  const t = query('SELECT id, status, invoice_id, revision FROM agent_transfers WHERE id = ?', [id])[0];
  return {
    transferId: id,
    status: String(t?.status ?? ''),
    invoiceId: String(t?.invoice_id ?? ''),
    revision: Number(t?.revision ?? 0),
  };
}

export function runTransferUndo(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseTransferUndo(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const out = urteil(() => undoTransferConversionInHouse(req.transferId, identity.branchId, req.expectedRevision));
    const transfers = out.transferIds.map(transferStand);
    if (transfers.some((t) => t.invoiceId !== '')) {
      throw new CommandNotEvaluated('TRANSFER_STILL_LINKED', 'a transfer still carries the invoice');
    }
    const inv = query('SELECT status FROM invoices WHERE id = ?', [out.invoiceId])[0];
    return {
      transferId: req.transferId,
      invoiceId: out.invoiceId,
      invoiceStatus: String(inv?.status ?? ''),
      invoiceReversed: out.invoiceReversed,
      receivablesRestored: out.receivablesRestored,
      transfers,
      revision: Number(transfers.find((t) => t.transferId === req.transferId)?.revision ?? 0),
    };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(reversalDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof SalesReversalPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_RETURNS_CANCEL, { kind: 'mutation', handler: (p, a) => execute(runReturnCancel, OP_RETURNS_CANCEL, p, a) });
registerCommand(OP_TRANSFERS_UNDO_CONVERT, { kind: 'mutation', handler: (p, a) => execute(runTransferUndo, OP_TRANSFERS_UNDO_CONVERT, p, a) });
