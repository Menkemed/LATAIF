// ════════════════════════════════════════════════════════════════════════════
// STOCK CORRECTION — die Fernbefehle: der Owner korrigiert Bestand auch vom zweiten Rechner (C5).
//
// PC2 schickt nur Absicht (Artikel, Menge, gesehene Menge, Grund, action_id). Plan, Herkunft des Lagerwerts, Buchung,
// Protokoll, Sync und das Replay einer schon ausgeführten action_id macht am Primary DIESELBE Hausfolge wie an der
// Maske des Primary (`core/stock/stock-adjustment.ts`), in der Transaktion des Auftrags. Die Rolle kommt aus dem
// geprüften Absender: `command-permissions` verlangt den Owner, die Hausfolge prüft es noch einmal (assertOwner).
// Ein fachliches Nein (`StockAdjustmentRejected`) wird zum eingefrorenen Urteil.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { remoteReadContext } from '@/core/data/read-context';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor, type CommandResult } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import { OP_OLD_STOCK_PAGE_GET, OP_STOCK_PRODUCT_GET } from './store-read-ops';
import {
  StockAdjustmentRejected, addOldStockInHouse, cancelStockAdjustmentInHouse, issueStockInHouse, stockCorrectionsFor,
  type AdjustmentCtx, type StockAdjustmentResult,
} from '@/core/stock/stock-adjustment';
import { oldStockReconciliationFor } from '@/core/stock/old-stock-reconciliation';

export const OP_STOCK_ISSUE = 'stock_adjustments.issue';
export const OP_STOCK_CANCEL = 'stock_adjustments.cancel';
export const OP_OLD_STOCK_ADD = 'stock_adjustments.add_old_stock';
export { OP_OLD_STOCK_PAGE_GET, OP_STOCK_PRODUCT_GET };

export class StockPayloadError extends Error {
  readonly code = 'STOCK_PAYLOAD_INVALID';
  constructor(message: string) { super(message); this.name = 'StockPayloadError'; }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Streng: nur die Felder der Maske. Wert, Lose und Buchung rechnet der Primary. */
function only(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlain(raw)) throw new StockPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (!keys.includes(k)) throw new StockPayloadError(`unknown field: ${k} — the primary decides values and stock`);
  }
  return raw;
}

export const ISSUE_KEYS = ['actionId', 'productId', 'quantity', 'expectedQuantity', 'reasonCategory', 'reason', 'businessDate'] as const;
export const CANCEL_KEYS = ['adjustmentId', 'reason'] as const;
export const OLD_STOCK_KEYS = ['actionId', 'productId', 'quantity', 'expectedQuantity', 'unitCost', 'reason', 'businessDate', 'confirmNotRemovedPiece'] as const;

type House = (input: never, ctx: AdjustmentCtx) => StockAdjustmentResult;

export function stockDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runStockAction(
  house: House, keys: readonly string[], deps: EngineDeps, identity: CommandIdentity, role: string | undefined, raw: unknown,
): Promise<CommandOutcome> {
  const input = only(raw, keys);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    try {
      const result = house(input as never, { branchId: identity.branchId, userId: identity.userId, now: deps.now(), role });
      return result as unknown as Record<string, unknown>;
    } catch (err) {
      if (err instanceof StockAdjustmentRejected) throw new CommandRejected(err.code, err.message);
      throw err;
    }
  });
}

async function execute(house: House, keys: readonly string[], op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await runStockAction(house, keys, stockDeps(), { ...actor, op }, (actor as { role?: string }).role, body);
  } catch (err) {
    if (err instanceof StockPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_STOCK_ISSUE, { kind: 'mutation', handler: (p, a) => execute(issueStockInHouse as House, ISSUE_KEYS, OP_STOCK_ISSUE, p, a) });
registerCommand(OP_STOCK_CANCEL, { kind: 'mutation', handler: (p, a) => execute(cancelStockAdjustmentInHouse as House, CANCEL_KEYS, OP_STOCK_CANCEL, p, a) });
// OLD STOCK — weitere Stücke Altbestand eines schon erfassten Artikels: nur Menge, Beleg, Protokoll, Sync; keine Buchung.
registerCommand(OP_OLD_STOCK_ADD, { kind: 'mutation', handler: (p, a) => execute(addOldStockInHouse as House, OLD_STOCK_KEYS, OP_OLD_STOCK_ADD, p, a) });

// ── Lesebefehl der Karte „Stock corrections" ───────────────────────────────
interface Envelope { readonly actor?: { tenantId?: string; branchId?: string; userId?: string; role?: string }; readonly input?: Record<string, unknown> }

registerCommand(OP_STOCK_PRODUCT_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
    const input = (payload as Envelope | null)?.input ?? {};
    const productId = input.productId;
    if (typeof productId !== 'string' || productId.trim() === '') throw new BusinessError('INPUT_REQUIRED', 'productId is required');
    return { data: { ...stockCorrectionsFor(ctx, { productId, issueQuantity: input.issueQuantity, receiptQuantity: input.receiptQuantity, receiptUnitCost: input.receiptUnitCost }) } };
  },
});

// ── Lesebefehl der Seite „Old stock" (Eröffnungsvorschau, nur lesen) ────────
registerCommand(OP_OLD_STOCK_PAGE_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
    return { data: { ...oldStockReconciliationFor(ctx) } };
  },
});
