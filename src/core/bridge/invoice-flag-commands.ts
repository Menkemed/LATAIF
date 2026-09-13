// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — der Butterfly-Schalter vom zweiten Rechner: `invoices.set_butterfly`.
//
// Derselbe Bau wie bei den Geldaktionen (`money-commands.ts`):
//
//  1. **Keine zweite Logik.** Der Befehl ruft die Hausfolge, die auch der Knopf am Primary ruft
//     (`invoice-flag-house.ts`): genau EINE Spalte, in der Transaktion des Auftrags.
//  2. **Der Rumpf ist ein Wunsch.** Rechnung, gesehene Fassung, gewünschter Wert — mehr nicht. Das
//     allgemeine `updateInvoice` (Status, Beträge, Nummer) ist von hier aus unerreichbar; jedes Feld
//     davon steht namentlich auf der Verbotsliste, ein unbekanntes Feld wird abgewiesen.
//  3. **Ändern braucht die gesehene Fassung** (`expectedRevision`), verglichen INNERHALB der
//     Transaktion.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { setInvoiceButterflyInHouse } from '@/core/invoices/invoice-flag-house';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';

export const OP_INVOICES_SET_BUTTERFLY = 'invoices.set_butterfly';

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class InvoiceFlagPayloadError extends Error {
  readonly code = 'INVOICE_FLAG_PAYLOAD_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceFlagPayloadError';
  }
}

/** Was der Client nie setzt — insbesondere nichts, was `updateInvoice` sonst schreiben könnte. */
const FORBIDDEN = [
  'id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status',
  'invoiceNumber', 'specialMark', 'netAmount', 'vatAmount', 'grossAmount', 'paidAmount', 'vatRateSnapshot',
  'taxSchemeSnapshot', 'purchasePriceSnapshot', 'salePriceSnapshot', 'marginSnapshot', 'customerId',
  'issuedAt', 'dueAt', 'notes', 'staffId', 'ledger', 'account', 'debit', 'credit',
];
const ALLOWED = ['invoiceId', 'expectedRevision', 'butterfly'];

export interface SetButterflyRequest { invoiceId: string; expectedRevision: number; butterfly: boolean }

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseSetButterfly(raw: unknown): SetButterflyRequest {
  if (!isPlain(raw)) throw new InvoiceFlagPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k)) throw new InvoiceFlagPayloadError(`the primary decides ${k}, not the client`);
    if (!ALLOWED.includes(k)) throw new InvoiceFlagPayloadError(`unknown field: ${k}`);
  }
  if (typeof raw.invoiceId !== 'string' || !raw.invoiceId.trim()) throw new InvoiceFlagPayloadError('invoiceId is required');
  const rev = raw.expectedRevision;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
    throw new InvoiceFlagPayloadError('expectedRevision is required — a change must say which revision it saw');
  }
  if (typeof raw.butterfly !== 'boolean') throw new InvoiceFlagPayloadError('butterfly must be true or false');
  return { invoiceId: raw.invoiceId.trim(), expectedRevision: rev, butterfly: raw.butterfly };
}

export function invoiceFlagDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runSetButterfly(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseSetButterfly(raw);
  return runRemoteCommand(deps, identity, () => {
    try {
      const r = setInvoiceButterflyInHouse(req.invoiceId, req.butterfly, identity.branchId, req.expectedRevision);
      return { ...r };
    } catch (err) {
      if (err instanceof InvoiceActionRejected) throw new CommandRejected(err.code, err.message);
      throw err;
    }
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

async function execute(
  run: (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>,
  op: string, payload: unknown, actor?: CommandActor,
): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(invoiceFlagDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof InvoiceFlagPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_INVOICES_SET_BUTTERFLY, {
  kind: 'mutation',
  handler: (p, a?: CommandActor) => execute(runSetButterfly, OP_INVOICES_SET_BUTTERFLY, p, a),
});
