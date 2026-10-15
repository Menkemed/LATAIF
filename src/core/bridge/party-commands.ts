// ════════════════════════════════════════════════════════════════════════════
// OPENING BALANCES & SETTLEMENT — die Fernbefehle des PC2 für Kunden- und Lieferantensalden.
//
//   • `parties.balances.get`        (Auskunft)  Salden von Kunden/Lieferanten — S0: am PC2 nicht mehr still 0,000.
//   • `parties.account.get`         (Auskunft)  Eröffnungsposten, Vorschau, offene LATAIF-Belege, bezahlbare Rechnungen.
//   • `page.opening_balances.get`   (Auskunft)  die gemeinsame Abstimmungsliste aller Eröffnungsposten.
//   • `opening_balances.create`     (Owner)     einen Eröffnungsposten erfassen — Beleg, keine Buchung.
//   • `opening_balances.cancel`     (Owner)     einen noch nicht gebuchten Eröffnungsposten stornieren.
//   • `customers.settle`            (Zahlungen) „Receive Payment" über offene Rechnungen — der vorhandene Zahlungsweg.
//
// PC2 schickt nur Absicht. Prüfung, Verteilung, Beleg, Buchung, Protokoll, Sync und das Replay einer schon ausgeführten
// Kennung macht am Primary DIESELBE Hausfolge wie an der Maske des Primary, in der Transaktion des Auftrags. Die Rolle
// kommt aus dem geprüften Absender (`command-permissions`); die Eröffnungs-Hausfolge prüft den Owner noch einmal.
// Ein Erlass hat KEINEN Befehl: er ist gesperrt, bis der Buchhalter Buchung und VAT bestätigt (W1–W3).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { remoteReadContext } from '@/core/data/read-context';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor, type CommandResult } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { OP_PARTIES_BALANCES_GET, PartyBalancesInputError, partyBalancesFor } from '@/core/parties/party-balances';
import { OP_PAGE_OPENING_BALANCES_GET, OP_PARTIES_ACCOUNT_GET, partyAccountReadFor } from '@/core/parties/party-account';
import {
  OpeningBalanceRejected, cancelOpeningItemInHouse, openingOverviewFor, recordOpeningItemInHouse,
  type OpeningCtx, type OpeningItem,
} from '@/core/parties/opening-balances';
import { settleCustomerInHouse, type CustomerSettleRequest } from '@/core/parties/customer-settlement';

export const OP_OPENING_CREATE = 'opening_balances.create';
export const OP_OPENING_CANCEL = 'opening_balances.cancel';
export const OP_CUSTOMERS_SETTLE = 'customers.settle';
export { OP_PARTIES_BALANCES_GET, OP_PARTIES_ACCOUNT_GET, OP_PAGE_OPENING_BALANCES_GET };

export class PartyPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PARTY_PAYLOAD_INVALID') { super(message); this.code = code; this.name = 'PartyPayloadError'; }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Ein Erlass ist kein Feld einer Zahlung — und hier ausdrücklich gesperrt (W1–W3). */
const WAIVER_KEYS = ['waiver', 'waiverAmount', 'writeOff', 'writeOffAmount', 'discount', 'discountAmount'];

/** Streng: nur die Felder der Maske. Beleg, Verteilung und Buchung rechnet der Primary. */
function only(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlain(raw)) throw new PartyPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (WAIVER_KEYS.includes(k)) {
      throw new PartyPayloadError('a debt waiver / write-off is not available yet — the booking and VAT rules wait for the accountant', 'WAIVER_BOOKING_BLOCKED');
    }
    if (!keys.includes(k)) throw new PartyPayloadError(`unknown field: ${k} — the primary decides documents, allocation and booking`);
  }
  return raw;
}

export const OPENING_CREATE_KEYS = [
  'actionId', 'partyType', 'partyId', 'kind', 'scope', 'reference', 'documentDate', 'dueDate', 'amount', 'priorVat', 'note',
  'confirmNotInLataif', 'confirmNoOverlap',
] as const;
export const OPENING_CANCEL_KEYS = ['itemId', 'reason'] as const;
export const CUSTOMER_SETTLE_KEYS = ['customerId', 'amount', 'method', 'cardBrand', 'notes', 'mode', 'allocations', 'confirmExcessAsCredit', 'expectedOpenStamp'] as const;

export function parseCustomerSettle(raw: unknown): CustomerSettleRequest {
  const r = only(raw, CUSTOMER_SETTLE_KEYS);
  if (typeof r.customerId !== 'string' || !r.customerId.trim()) throw new PartyPayloadError('customerId is required');
  if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) throw new PartyPayloadError('amount must be a number');
  if (typeof r.method !== 'string' || !r.method) throw new PartyPayloadError('method is required');
  if (r.mode !== 'fifo' && r.mode !== 'manual') throw new PartyPayloadError('mode is fifo or manual');
  if (r.notes !== undefined && typeof r.notes !== 'string') throw new PartyPayloadError('notes must be text');
  if (r.cardBrand !== undefined && typeof r.cardBrand !== 'string') throw new PartyPayloadError('cardBrand must be text');
  if (r.confirmExcessAsCredit !== undefined && typeof r.confirmExcessAsCredit !== 'boolean') throw new PartyPayloadError('confirmExcessAsCredit is true or false');
  if (r.expectedOpenStamp !== undefined && (typeof r.expectedOpenStamp !== 'string' || r.expectedOpenStamp.length > 64)) throw new PartyPayloadError('expectedOpenStamp must be text');
  let allocations: Array<{ invoiceId: string; amount: number }> | undefined;
  if (r.allocations !== undefined) {
    if (!Array.isArray(r.allocations) || r.allocations.length > 500) throw new PartyPayloadError('allocations must be a list');
    allocations = r.allocations.map((a) => {
      const x = only(a, ['invoiceId', 'amount']);
      if (typeof x.invoiceId !== 'string' || !x.invoiceId) throw new PartyPayloadError('an allocation names its invoice');
      if (typeof x.amount !== 'number' || !Number.isFinite(x.amount)) throw new PartyPayloadError('an allocation amount must be a number');
      return { invoiceId: x.invoiceId, amount: x.amount };
    });
  }
  if (r.mode === 'fifo' && allocations) throw new PartyPayloadError('FIFO: the primary decides the allocation');
  if (r.mode === 'manual' && !allocations?.length) throw new PartyPayloadError('a manual payment names its allocations');
  return {
    customerId: r.customerId, amount: r.amount, method: r.method, mode: r.mode,
    ...(r.notes ? { notes: r.notes as string } : {}), ...(r.cardBrand ? { cardBrand: r.cardBrand as CustomerSettleRequest['cardBrand'] } : {}),
    ...(allocations ? { allocations } : {}), ...(r.confirmExcessAsCredit === true ? { confirmExcessAsCredit: true } : {}),
    ...(typeof r.expectedOpenStamp === 'string' ? { expectedOpenStamp: r.expectedOpenStamp } : {}),
  };
}

export function partyDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

type OpeningHouse = (input: never, ctx: OpeningCtx) => OpeningItem;

export function runOpeningAction(
  house: OpeningHouse, keys: readonly string[], deps: EngineDeps, identity: CommandIdentity, role: string | undefined, raw: unknown,
): Promise<CommandOutcome> {
  const input = only(raw, keys);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    try {
      return house(input as never, { branchId: identity.branchId, userId: identity.userId, now: deps.now(), role }) as unknown as Record<string, unknown>;
    } catch (err) {
      if (err instanceof OpeningBalanceRejected) throw new CommandRejected(err.code, err.message);
      throw err;
    }
  });
}

export function runCustomerSettle(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseCustomerSettle(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    try {
      // DIESELBE Hausfolge wie „Receive Payment" am Primary: je Rechnung der vorhandene Zahlungsweg (Status, Endnummer,
      // Kartengebühr, Überzahlung → Guthaben, VAT-Periodenschutz, Buchung) — alles in der Transaktion dieses Auftrags.
      return settleCustomerInHouse(req, identity.branchId) as unknown as Record<string, unknown>;
    } catch (err) {
      if (err instanceof InvoiceActionRejected) throw new CommandRejected(err.code, err.message);
      throw err;
    }
  });
}

async function execute(run: () => Promise<CommandOutcome>): Promise<Record<string, unknown>> {
  let outcome: CommandOutcome;
  try {
    outcome = await run();
  } catch (err) {
    if (err instanceof PartyPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

function bodyOf(payload: unknown): unknown {
  return (payload as { input?: unknown } | null)?.input ?? payload;
}
function needActor(op: string, actor?: CommandActor): CommandActor {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  return actor;
}

registerCommand(OP_OPENING_CREATE, {
  kind: 'mutation',
  handler: (p, a) => {
    const actor = needActor(OP_OPENING_CREATE, a);
    return execute(() => runOpeningAction(recordOpeningItemInHouse as OpeningHouse, OPENING_CREATE_KEYS, partyDeps(), { ...actor, op: OP_OPENING_CREATE }, (actor as { role?: string }).role, bodyOf(p)));
  },
});
registerCommand(OP_OPENING_CANCEL, {
  kind: 'mutation',
  handler: (p, a) => {
    const actor = needActor(OP_OPENING_CANCEL, a);
    return execute(() => runOpeningAction(cancelOpeningItemInHouse as OpeningHouse, OPENING_CANCEL_KEYS, partyDeps(), { ...actor, op: OP_OPENING_CANCEL }, (actor as { role?: string }).role, bodyOf(p)));
  },
});
registerCommand(OP_CUSTOMERS_SETTLE, {
  kind: 'mutation',
  handler: (p, a) => {
    const actor = needActor(OP_CUSTOMERS_SETTLE, a);
    return execute(() => runCustomerSettle(partyDeps(), { ...actor, op: OP_CUSTOMERS_SETTLE }, bodyOf(p)));
  },
});

// ── Auskünfte ───────────────────────────────────────────────────────────────
interface Envelope { readonly actor?: { tenantId?: string; branchId?: string; userId?: string; role?: string }; readonly input?: Record<string, unknown> }

registerCommand(OP_PARTIES_BALANCES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
    const input = (payload as Envelope | null)?.input ?? {};
    try {
      return { data: { ...partyBalancesFor(ctx, { customerIds: input.customerIds, supplierIds: input.supplierIds }) } };
    } catch (err) {
      if (err instanceof PartyBalancesInputError) throw new BusinessError(err.code, err.message);
      throw err;
    }
  },
});

registerCommand(OP_PARTIES_ACCOUNT_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
    const input = (payload as Envelope | null)?.input ?? {};
    try {
      return { data: { ...partyAccountReadFor(ctx, { partyType: input.partyType, partyId: input.partyId, preview: input.preview }) } };
    } catch (err) {
      if (err instanceof OpeningBalanceRejected) throw new BusinessError(err.code, err.message);
      throw err;
    }
  },
});

registerCommand(OP_PAGE_OPENING_BALANCES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
    return { data: { ...openingOverviewFor(ctx) } };
  },
});
