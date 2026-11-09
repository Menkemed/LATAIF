// ════════════════════════════════════════════════════════════════════════════
// OPENING BALANCES & SETTLEMENT — die Fernbefehle des PC2 für Kunden- und Lieferantensalden.
//
//   • `parties.balances.get`        (Auskunft)  Salden von Kunden/Lieferanten — S0: am PC2 nicht mehr still 0,000.
//   • `parties.account.get`         (Auskunft)  Eröffnungsposten, Vorschau, offene LATAIF-Belege, bezahlbare Rechnungen.
//   • `page.opening_balances.get`   (Auskunft)  die gemeinsame Abstimmungsliste aller Eröffnungsposten.
//   • `opening_balances.create`     (Owner)     einen Eröffnungsposten erfassen — Beleg, keine Buchung.
//   • `opening_balances.cancel`     (Owner)     einen noch nicht gebuchten Eröffnungsposten stornieren.
//   • `customers.settle`            (Zahlungen) „Receive Payment" über offene Rechnungen — der vorhandene Zahlungsweg.
//   • `customers.settle_balance`    (Zahlungen) CUSTOMER ACCOUNT C — „Settle Balance": Rechnungen gegen Store Credit / We
//                                   Borrowed desselben Kunden, ohne Geld, eine STL-Nummer, eine Transaktion.
//   • `customers.settlement_reverse` (Zahlungen) eine ganze STL-Verrechnung aufheben (je Zuordnung `deletePayment`).
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
import { OP_CUSTOMERS_SETTLE_BALANCE, OP_CUSTOMERS_SETTLEMENT_REVERSE } from '@/core/offsets/party-settlement-reads';
import { reverseSettlementInHouse, settleBalanceInHouse, type SettleBalanceRequest, type SettlementReverseRequest } from '@/core/offsets/party-settlement';
import { OffsetRestoreError } from '@/core/offsets/party-offset-restore';
import { mayReadOpeningAccounting } from '@/core/accounting/opening-accounting';

export const OP_OPENING_CREATE = 'opening_balances.create';
export const OP_OPENING_CANCEL = 'opening_balances.cancel';
export const OP_CUSTOMERS_SETTLE = 'customers.settle';
export { OP_CUSTOMERS_SETTLE_BALANCE, OP_CUSTOMERS_SETTLEMENT_REVERSE };
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

// ── CUSTOMER ACCOUNT C — „Settle Balance" und ihre Aufhebung ─────────────────
export const SETTLE_BALANCE_KEYS = ['customerId', 'invoiceIds', 'sourceIds', 'settlementDate', 'expectedStamp', 'expectedTotal', 'finalNumbers'] as const;
export const SETTLEMENT_REVERSE_KEYS = ['settlementNumber', 'reason', 'expectedActiveLines'] as const;

const idList = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.length > 500 || !v.every((x) => typeof x === 'string' && x.trim() !== '')) throw new PartyPayloadError(`${name} must be a list of ids`);
  return v as string[];
};

/** Streng: nur Absicht (Auswahl, Tag, gesehener Stand, gesehene Summe, Endnummernwahl). Zuordnung und Buchung rechnet der Primary. */
export function parseSettleBalance(raw: unknown): SettleBalanceRequest {
  const r = only(raw, SETTLE_BALANCE_KEYS);
  if (typeof r.customerId !== 'string' || !r.customerId.trim()) throw new PartyPayloadError('customerId is required');
  if (r.settlementDate !== undefined && typeof r.settlementDate !== 'string') throw new PartyPayloadError('settlementDate must be a date (YYYY-MM-DD)');
  if (typeof r.expectedStamp !== 'string' || r.expectedStamp.length > 64) throw new PartyPayloadError('expectedStamp must be text');
  if (typeof r.expectedTotal !== 'number' || !Number.isFinite(r.expectedTotal)) throw new PartyPayloadError('expectedTotal must be a number');
  let finalNumbers: Record<string, 'normal' | 'special'> | undefined;
  if (r.finalNumbers !== undefined) {
    if (!isPlain(r.finalNumbers)) throw new PartyPayloadError('finalNumbers must be an object');
    finalNumbers = {};
    for (const [k, v] of Object.entries(r.finalNumbers)) {
      if (v !== 'normal' && v !== 'special') throw new PartyPayloadError('a final number type is normal or special');
      finalNumbers[k] = v;
    }
  }
  return {
    customerId: r.customerId, invoiceIds: idList(r.invoiceIds, 'invoiceIds'), sourceIds: idList(r.sourceIds, 'sourceIds'),
    ...(r.settlementDate ? { settlementDate: r.settlementDate as string } : {}),
    expectedStamp: r.expectedStamp, expectedTotal: r.expectedTotal, ...(finalNumbers ? { finalNumbers } : {}),
  };
}

export function parseSettlementReverse(raw: unknown): SettlementReverseRequest {
  const r = only(raw, SETTLEMENT_REVERSE_KEYS);
  if (typeof r.settlementNumber !== 'string' || !r.settlementNumber.trim() || r.settlementNumber.length > 64) throw new PartyPayloadError('settlementNumber is required');
  if (r.reason !== undefined && typeof r.reason !== 'string') throw new PartyPayloadError('reason must be text');
  if (r.expectedActiveLines !== undefined && (typeof r.expectedActiveLines !== 'number' || !Number.isInteger(r.expectedActiveLines) || r.expectedActiveLines < 1)) {
    throw new PartyPayloadError('expectedActiveLines must be a positive whole number');
  }
  return {
    settlementNumber: r.settlementNumber, ...(r.reason ? { reason: r.reason as string } : {}),
    ...(r.expectedActiveLines !== undefined ? { expectedActiveLines: r.expectedActiveLines as number } : {}),
  };
}

/** Ein fachliches Nein der Verrechnung — eingefroren (Wiederholung bekommt dasselbe). */
function verrechnungsUrteil(err: unknown): never {
  if (err instanceof InvoiceActionRejected || err instanceof OffsetRestoreError) throw new CommandRejected(err.code, err.message);
  throw err;
}

export function runSettleBalance(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseSettleBalance(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    // DIESELBE Hausfolge wie „Confirm settlement" am Primary — alle Zuordnungen in der Transaktion dieses Auftrags.
    try { return settleBalanceInHouse(req, { branchId: identity.branchId, userId: identity.userId }) as unknown as Record<string, unknown>; }
    catch (err) { return verrechnungsUrteil(err); }
  });
}

export function runSettlementReverse(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseSettlementReverse(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    try { return reverseSettlementInHouse(req, { branchId: identity.branchId }) as unknown as Record<string, unknown>; }
    catch (err) { return verrechnungsUrteil(err); }
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

registerCommand(OP_CUSTOMERS_SETTLE_BALANCE, {
  kind: 'mutation',
  handler: (p, a) => {
    const actor = needActor(OP_CUSTOMERS_SETTLE_BALANCE, a);
    return execute(() => runSettleBalance(partyDeps(), { ...actor, op: OP_CUSTOMERS_SETTLE_BALANCE }, bodyOf(p)));
  },
});
registerCommand(OP_CUSTOMERS_SETTLEMENT_REVERSE, {
  kind: 'mutation',
  handler: (p, a) => {
    const actor = needActor(OP_CUSTOMERS_SETTLEMENT_REVERSE, a);
    return execute(() => runSettlementReverse(partyDeps(), { ...actor, op: OP_CUSTOMERS_SETTLEMENT_REVERSE }, bodyOf(p)));
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
      return { data: { ...partyAccountReadFor(ctx, { partyType: input.partyType, partyId: input.partyId, preview: input.preview, view: input.view }) } };
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
    // B1 FINAL GATE — dieselbe vertrauliche Eröffnungsübersicht (alle Posten, Kassen-Anfangsbestand): nur der Owner.
    if (!mayReadOpeningAccounting(ctx.role)) throw new BusinessError('PERMISSION_DENIED', 'only the owner (admin) may see the opening balances');
    return { data: { ...openingOverviewFor(ctx) } };
  },
});
