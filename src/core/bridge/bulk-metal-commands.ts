// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Fernbefehle (Spec 13): vier manuelle Aktionen und vier Lesebefehle.
//
// PC2 schickt nur Absicht (Lot, Gewicht, Grund, action_id, gesehene Revision). Zuteilung, Restwerte,
// Buchung und das Replay einer schon ausgeführten action_id macht die Hausfolge am Primary
// (`core/bulk/bulk-lot-house.ts`) — dieselbe Funktion wie an der Maske des Primary. Ein fachliches Nein
// (`BulkRejected`) wird in `runRemoteCommand` zum eingefrorenen Urteil.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { remoteReadContext } from '@/core/data/read-context';
import { CommandNotEvaluated, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor, type CommandResult } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import {
  closeLotInHouse, correctLotInHouse, reverseAdjustmentInHouse, writeOffInHouse, type BulkActionResult, type BulkCtx,
} from '@/core/bulk/bulk-lot-house';
import {
  bulkAllocationPreviewFor, bulkLotDetailFor, bulkLotsForSaleFor, bulkMetalsPageFor,
} from '@/core/bulk/bulk-reads';

export const OP_BULK_WRITE_OFF = 'bulk_metals.write_off';
export const OP_BULK_CLOSE_LOT = 'bulk_metals.close_lot';
export const OP_BULK_CORRECT_WEIGHT = 'bulk_metals.correct_weight';
export const OP_BULK_REVERSE_ADJUSTMENT = 'bulk_metals.reverse_adjustment';

export class BulkPayloadError extends Error {
  readonly code = 'BULK_PAYLOAD_INVALID';
  constructor(message: string) { super(message); this.name = 'BulkPayloadError'; }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Streng: nur die Felder der Maske. Werte, Restbestände und Buchungen rechnet der Primary. */
function only(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlain(raw)) throw new BulkPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (!keys.includes(k)) throw new BulkPayloadError(`unknown field: ${k} — the primary decides values and stock`);
  }
  return raw;
}

const WRITE_OFF_KEYS = ['actionId', 'lotId', 'expectedRevision', 'weightMg', 'reason', 'businessDate'] as const;
const CLOSE_KEYS = ['actionId', 'lotId', 'expectedRevision', 'confirmWeightMg', 'confirmValueFils', 'reason', 'businessDate'] as const;
const CORRECT_KEYS = ['actionId', 'lotId', 'expectedRevision', 'newWeightMg', 'composition', 'reason'] as const;
const REVERSE_KEYS = ['actionId', 'lotId', 'expectedRevision', 'movementId', 'reason'] as const;

type House = (input: never, ctx: BulkCtx) => BulkActionResult;

export function bulkDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runBulkAction(
  house: House, keys: readonly string[], deps: EngineDeps, identity: CommandIdentity, role: string | undefined, raw: unknown,
): Promise<CommandOutcome> {
  const input = only(raw, keys);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const result = house(input as never, { branchId: identity.branchId, userId: identity.userId, now: deps.now(), role });
    return result as unknown as Record<string, unknown>;
  });
}

async function execute(house: House, keys: readonly string[], op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await runBulkAction(house, keys, bulkDeps(), { ...actor, op }, (actor as { role?: string }).role, body);
  } catch (err) {
    if (err instanceof BulkPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_BULK_WRITE_OFF, { kind: 'mutation', handler: (p, a) => execute(writeOffInHouse as House, WRITE_OFF_KEYS, OP_BULK_WRITE_OFF, p, a) });
registerCommand(OP_BULK_CLOSE_LOT, { kind: 'mutation', handler: (p, a) => execute(closeLotInHouse as House, CLOSE_KEYS, OP_BULK_CLOSE_LOT, p, a) });
registerCommand(OP_BULK_CORRECT_WEIGHT, { kind: 'mutation', handler: (p, a) => execute(correctLotInHouse as House, CORRECT_KEYS, OP_BULK_CORRECT_WEIGHT, p, a) });
registerCommand(OP_BULK_REVERSE_ADJUSTMENT, { kind: 'mutation', handler: (p, a) => execute(reverseAdjustmentInHouse as House, REVERSE_KEYS, OP_BULK_REVERSE_ADJUSTMENT, p, a) });

// ── Lesebefehle ─────────────────────────────────────────────────────────────
// Die Filiale kommt aus dem geprüften Absender, nie aus dem Rumpf; Kennungen im Rumpf sind Auswahl.

interface Envelope { readonly actor?: { tenantId?: string; branchId?: string; userId?: string; role?: string }; readonly input?: Record<string, unknown> }
const ctxOf = (payload: unknown, actor?: CommandActor) => remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
const inputOf = (payload: unknown): Record<string, unknown> => {
  const i = (payload as Envelope | null)?.input;
  return i && typeof i === 'object' ? i : {};
};
function requiredId(payload: unknown, field: string): string {
  const v = inputOf(payload)[field];
  if (typeof v !== 'string' || v.trim() === '') throw new BusinessError('INPUT_REQUIRED', `${field} is required`);
  return v;
}

registerCommand('page.bulk_metals.get', {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => ({ data: { ...bulkMetalsPageFor(ctxOf(payload, actor)) } }),
});
registerCommand('bulk_metals.lots_for_sale.get', {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => ({ data: { lots: bulkLotsForSaleFor(ctxOf(payload, actor)) } }),
});
registerCommand('bulk_metals.lot_detail.get', {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => ({ data: { detail: bulkLotDetailFor(ctxOf(payload, actor), requiredId(payload, 'lotId')) } }),
});
registerCommand('bulk_metals.allocation_preview.get', {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    try {
      return { data: { ...bulkAllocationPreviewFor(ctxOf(payload, actor), requiredId(payload, 'lotId'), inputOf(payload).weightMg) } };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code) throw new BusinessError(code, (e as Error).message);
      throw e;
    }
  },
});
