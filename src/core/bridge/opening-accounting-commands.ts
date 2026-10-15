// ════════════════════════════════════════════════════════════════════════════
// B1 OPENING ACCOUNTING — die Fernbefehle des PC2 für „Settings → Opening Balances".
//
//   • `opening_accounts.create`      (Owner)     einen Eröffnungsbeleg erfassen oder kontrolliert ersetzen — keine Buchung.
//   • `opening_accounts.cancel`      (Owner)     einen noch nicht gebuchten Eröffnungsbeleg stornieren (Stand-Prüfung).
//   • `page.opening_accounting.get`  (Auskunft)  Übersicht, Saldenliste, Bilanzvorschau, Stichtagsliste, Vorschau.
//
// PC2 schickt nur Absicht. Prüfung, Beleg, Protokoll, Sync und das Replay einer schon ausgeführten Kennung macht am
// Primary DIESELBE Hausfolge wie an der Maske des Primary, in der Transaktion des Auftrags. Die Rolle kommt aus dem
// geprüften Absender (`command-permissions`); die Hausfolge prüft den Owner noch einmal. Gebucht wird nichts.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { remoteReadContext } from '@/core/data/read-context';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor, type CommandResult } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import { OP_PAGE_OPENING_ACCOUNTING_GET } from './store-read-ops';
import {
  OpeningAccountRejected, cancelOpeningAccountItemInHouse, mayReadOpeningAccounting, openingAccountingFor, recordOpeningAccountItemInHouse,
  type OpeningAccountCtx, type OpeningAccountItem,
} from '@/core/accounting/opening-accounting';
import { LedgerStatementInputError } from '@/core/accounting/ledger-statements';

export const OP_OPENING_ACCOUNTS_CREATE = 'opening_accounts.create';
export const OP_OPENING_ACCOUNTS_CANCEL = 'opening_accounts.cancel';
export { OP_PAGE_OPENING_ACCOUNTING_GET };

export const OPENING_ACCOUNT_CREATE_KEYS = [
  'actionId', 'kind', 'amount', 'reference', 'reason', 'counterpartyType', 'counterpartyId', 'counterpartyName',
  'correctsId', 'expectedCorrectsRevision', 'confirmNotInLataif',
] as const;
export const OPENING_ACCOUNT_CANCEL_KEYS = ['itemId', 'reason', 'expectedRevision'] as const;

export class OpeningAccountPayloadError extends Error {
  readonly code = 'OPENING_ACCOUNT_PAYLOAD_INVALID';
  constructor(message: string) { super(message); this.name = 'OpeningAccountPayloadError'; }
}

/** Streng: nur die Felder der Maske. Nummer, Stand, Buchungslage und Akteur bestimmt der Primary. */
function only(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new OpeningAccountPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (!keys.includes(k)) throw new OpeningAccountPayloadError(`unknown field: ${k} — the primary decides number, state and booking`);
  }
  return raw as Record<string, unknown>;
}

export function openingAccountDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

type OpeningAccountHouse = (input: never, ctx: OpeningAccountCtx) => OpeningAccountItem;

export function runOpeningAccountAction(
  house: OpeningAccountHouse, keys: readonly string[], deps: EngineDeps, identity: CommandIdentity, role: string | undefined, raw: unknown,
): Promise<CommandOutcome> {
  const input = only(raw, keys);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    try {
      return house(input as never, { branchId: identity.branchId, userId: identity.userId, now: deps.now(), role }) as unknown as Record<string, unknown>;
    } catch (err) {
      if (err instanceof OpeningAccountRejected) throw new CommandRejected(err.code, err.message);
      throw err;
    }
  });
}

async function execute(house: OpeningAccountHouse, keys: readonly string[], op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await runOpeningAccountAction(house, keys, openingAccountDeps(), { ...actor, op }, (actor as { role?: string }).role, body);
  } catch (err) {
    if (err instanceof OpeningAccountPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_OPENING_ACCOUNTS_CREATE, {
  kind: 'mutation',
  handler: (p, a) => execute(recordOpeningAccountItemInHouse as OpeningAccountHouse, OPENING_ACCOUNT_CREATE_KEYS, OP_OPENING_ACCOUNTS_CREATE, p, a),
});
registerCommand(OP_OPENING_ACCOUNTS_CANCEL, {
  kind: 'mutation',
  handler: (p, a) => execute(cancelOpeningAccountItemInHouse as OpeningAccountHouse, OPENING_ACCOUNT_CANCEL_KEYS, OP_OPENING_ACCOUNTS_CANCEL, p, a),
});

// ── Auskunft ────────────────────────────────────────────────────────────────
interface Envelope { readonly actor?: { tenantId?: string; branchId?: string; userId?: string; role?: string }; readonly input?: Record<string, unknown> }

registerCommand(OP_PAGE_OPENING_ACCOUNTING_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
    // B1 FINAL GATE — nur der Owner liest die Eröffnungsbilanz (Rolle aus dem geprüften Absender, nicht aus dem Rumpf).
    if (!mayReadOpeningAccounting(ctx.role)) throw new BusinessError('PERMISSION_DENIED', 'only the owner (admin) may see the opening balances');
    const input = (payload as Envelope | null)?.input ?? {};
    try {
      return { data: { ...openingAccountingFor(ctx, { asOfDate: input.asOfDate, view: input.view, txLimit: input.txLimit, preview: input.preview }) } };
    } catch (err) {
      if (err instanceof LedgerStatementInputError) throw new BusinessError(err.code, err.message);
      throw err;
    }
  },
});
