// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — die Geldhandlungen gemeinsam gekaufter Artikel vom zweiten Rechner.
//
// Derselbe Bau wie `money-commands.ts`:
//  1. Keine zweite Logik: jeder Befehl ruft die Hausfolge, die auch die Maske des Primary ruft
//     (`item-participation-house.ts`), in der Transaktion des Auftrags — exklusiv, mit Nachweis der
//     Auftragskennung. Eine Wiederholung (Verbindungsabbruch, zweites Senden) bekommt das gespeicherte
//     Ergebnis zurück und bucht nichts ein zweites Mal; ein fachliches Nein wird eingefroren.
//  2. Der Rumpf ist ein Wunsch: Kennung, Filiale, Benutzer, Zeitpunkt, Beträge, die das Haus rechnet
//     (Gewinn, Anteil, offener Betrag), und alles aus dem Hauptbuch stehen auf der Verbotsliste; ein
//     unbekanntes Feld wird abgewiesen.
//  3. Was den offenen Betrag verbraucht (Auszahlung, Verrechnung, Abrechnung), prüft das Haus
//     INNERHALB der Transaktion — Primary und PC2 können denselben Betrag nicht zweimal verbrauchen.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import {
  PartnerItemRejected, itemMovementInput, itemOffsetInput, ownershipChangeInput, requiredId,
  type ItemMovementInput, type ItemOffsetInput, type OwnershipChangeInput,
} from '@/core/partners/item-participation';
import {
  cancelItemMovementInHouse, changePartnersInHouse, offsetItemsInHouse, recordItemMovementInHouse, settleSaleLineInHouse,
  takeOverInHouse, type PartnerItemCtx,
} from '@/core/partners/item-participation-house';

export const OP_PARTNER_ITEMS_RECORD_MOVEMENT = 'partner_items.record_movement';
export const OP_PARTNER_ITEMS_SETTLE_SALE = 'partner_items.settle_sale';
export const OP_PARTNER_ITEMS_OFFSET = 'partner_items.offset';
export const OP_PARTNER_ITEMS_CANCEL_MOVEMENT = 'partner_items.cancel_movement';
export const OP_PARTNER_ITEMS_TAKE_OVER = 'partner_items.take_over';
export const OP_PARTNER_ITEMS_CHANGE_PARTNERS = 'partner_items.change_partners';

export const PARTNER_ITEM_OPS = [
  OP_PARTNER_ITEMS_RECORD_MOVEMENT, OP_PARTNER_ITEMS_SETTLE_SALE, OP_PARTNER_ITEMS_OFFSET, OP_PARTNER_ITEMS_CANCEL_MOVEMENT,
  OP_PARTNER_ITEMS_TAKE_OVER, OP_PARTNER_ITEMS_CHANGE_PARTNERS,
] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class PartnerItemPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PARTNER_ITEM_PAYLOAD_INVALID') {
    super(message);
    this.name = 'PartnerItemPayloadError';
    this.code = code;
  }
}

const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status',
  'open', 'profit', 'share', 'shareBp', 'target', 'basis', 'groupId', 'cancelledAt',
  'ledger', 'entries', 'account', 'accounts', 'debit', 'credit', 'sourceModule', 'sourceId', 'balance'];

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlain(raw)) throw new PartnerItemPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k)) throw new PartnerItemPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new PartnerItemPayloadError(`unknown field: ${k}`);
  }
  return raw;
}

/** Die Eingaberegel als Prüfung des Rumpfs: ihr Nein kommt mit IHREM Code zurück. */
function rule<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PartnerItemRejected) throw new PartnerItemPayloadError(e.message, e.code);
    throw e;
  }
}
/** Dieselbe Folge INNERHALB des Auftrags: dort ist ihr Nein ein eingefrorenes Urteil. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PartnerItemRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

const ctxOf = (identity: CommandIdentity): PartnerItemCtx => ({
  branchId: identity.branchId, userId: identity.userId, now: new Date().toISOString(),
});

// ── Die Rümpfe ──────────────────────────────────────────────────────────────

export function parseItemMovement(raw: unknown): ItemMovementInput {
  const r = strict(raw, ['purchaseLineId', 'partnerId', 'kind', 'amount', 'method', 'date', 'note']);
  return rule(() => itemMovementInput(r));
}
export function parseSettleSale(raw: unknown): { invoiceLineId: string } {
  const r = strict(raw, ['invoiceLineId']);
  return { invoiceLineId: rule(() => requiredId(r.invoiceLineId, 'invoiceLineId')) };
}
export function parseItemOffset(raw: unknown): ItemOffsetInput {
  const r = strict(raw, ['partnerId', 'fromPurchaseLineId', 'toPurchaseLineId', 'amount', 'date', 'note']);
  return rule(() => itemOffsetInput(r));
}
export function parseCancelMovement(raw: unknown): { movementId: string } {
  const r = strict(raw, ['movementId']);
  return { movementId: rule(() => requiredId(r.movementId, 'movementId')) };
}

export function parseTakeOver(raw: unknown): OwnershipChangeInput {
  const r = strict(raw, ['purchaseLineId', 'expectedValue']);
  return rule(() => ownershipChangeInput(r, false));
}
export function parseChangePartners(raw: unknown): OwnershipChangeInput {
  const r = strict(raw, ['purchaseLineId', 'expectedValue', 'partnerShares']);
  return rule(() => ownershipChangeInput(r, true));
}

// ── Die Läufe ───────────────────────────────────────────────────────────────

export function partnerItemDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runItemMovement(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseItemMovement(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => recordItemMovementInHouse(input, ctxOf(identity)));
    return { movementId: r.movementId, kind: r.kind, amount: r.amount, open: r.open };
  });
}

export function runSettleSale(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseSettleSale(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => settleSaleLineInHouse(input.invoiceLineId, ctxOf(identity)));
    return { invoiceLineId: r.invoiceLineId, invoiceNumber: r.invoiceNumber, mode: r.mode, profit: r.profit, quantity: r.quantity, shares: r.shares };
  });
}

export function runItemOffset(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseItemOffset(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => offsetItemsInHouse(input, ctxOf(identity)));
    return { groupId: r.groupId, amount: r.amount, openFrom: r.openFrom, openTo: r.openTo };
  });
}

export function runCancelMovement(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseCancelMovement(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => cancelItemMovementInHouse(input.movementId, ctxOf(identity)));
    return { cancelled: r.cancelled };
  });
}

export function runTakeOver(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseTakeOver(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => takeOverInHouse(input, ctxOf(identity)));
    return { purchaseLineId: r.purchaseLineId, mode: r.mode, qty: r.qty, value: r.value, released: r.released };
  });
}

export function runChangePartners(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseChangePartners(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => changePartnersInHouse(input, ctxOf(identity)));
    return { purchaseLineId: r.purchaseLineId, mode: r.mode, qty: r.qty, value: r.value, epochId: r.epochId, released: r.released };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(partnerItemDeps(), { ...actor, op }, body);
  } catch (err) {
    if (err instanceof PartnerItemPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_PARTNER_ITEMS_RECORD_MOVEMENT, { kind: 'mutation', handler: (p, a) => execute(runItemMovement, OP_PARTNER_ITEMS_RECORD_MOVEMENT, p, a) });
registerCommand(OP_PARTNER_ITEMS_SETTLE_SALE, { kind: 'mutation', handler: (p, a) => execute(runSettleSale, OP_PARTNER_ITEMS_SETTLE_SALE, p, a) });
registerCommand(OP_PARTNER_ITEMS_OFFSET, { kind: 'mutation', handler: (p, a) => execute(runItemOffset, OP_PARTNER_ITEMS_OFFSET, p, a) });
registerCommand(OP_PARTNER_ITEMS_CANCEL_MOVEMENT, { kind: 'mutation', handler: (p, a) => execute(runCancelMovement, OP_PARTNER_ITEMS_CANCEL_MOVEMENT, p, a) });
registerCommand(OP_PARTNER_ITEMS_TAKE_OVER, { kind: 'mutation', handler: (p, a) => execute(runTakeOver, OP_PARTNER_ITEMS_TAKE_OVER, p, a) });
registerCommand(OP_PARTNER_ITEMS_CHANGE_PARTNERS, { kind: 'mutation', handler: (p, a) => execute(runChangePartners, OP_PARTNER_ITEMS_CHANGE_PARTNERS, p, a) });
