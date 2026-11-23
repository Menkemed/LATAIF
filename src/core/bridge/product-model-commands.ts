// ═════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN (Owner 23.11.2026, Lösung E) — die Modellgruppen vom zweiten Rechner.
//
// DIESELBE Hausfolge wie am Primary (`product-models.ts`): Prüfung (Recht `products.edit`, Filiale, Eigentum, Kategorie,
// Marke, Warenart, Fassung) und Speicherung am Primary, in der Transaktion des Auftrags, mit durablem Nachweis je
// Kennung (Wiederholung = eingefrorenes Ergebnis). Der Rumpf trägt nur Kennungen; WAS geschrieben wird, entscheidet das Haus.
//
//   product_models.group         {productIds, modelKey?}
//   product_models.ungroup        {productIds}
//   product_models.merge_photos  {modelKey, pickMediaId, targets[{productId, expectedUpdatedAt}], detachOld}
//                                 oder {modelKey, restore[{productId, mediaIds, expectedUpdatedAt}]} (Rückgängig)
//
// Gelesen werden die Zuordnungen mit `store.products.get` (Schlüssel `productModels`) — kein eigener Lesebefehl.
// ═════════════════════════════════════════════════════════════════

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import {
  PRODUCT_MODELS_GROUP_OP, PRODUCT_MODELS_MERGE_PHOTOS_OP, PRODUCT_MODELS_UNGROUP_OP, ProductModelRejected,
  groupProductsInHouse, mergeModelPhotosInHouse, removeFromModelInHouse,
  type GroupInput, type MergePhotosInput, type ProductModelCtx, type RemoveInput,
} from '@/core/products/product-models';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';

export const OP_PRODUCT_MODELS_GROUP = PRODUCT_MODELS_GROUP_OP;
export const OP_PRODUCT_MODELS_UNGROUP = PRODUCT_MODELS_UNGROUP_OP;
export const OP_PRODUCT_MODELS_MERGE_PHOTOS = PRODUCT_MODELS_MERGE_PHOTOS_OP;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung (vor dem Nachweis geworfen, also nicht eingefroren). */
export class ProductModelPayloadError extends Error {
  readonly code = 'PRODUCT_MODEL_PAYLOAD_INVALID';
  constructor(message: string) { super(message); this.name = 'ProductModelPayloadError'; }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 200;
function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new ProductModelPayloadError(`unknown field: ${k}`);
}
function idList(v: unknown, what: string, max = 200): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max || !v.every(isId)) throw new ProductModelPayloadError(`${what} must be a non-empty list of ids`);
  return v.map((x) => String(x).trim());
}

export function parseGroup(raw: unknown): GroupInput {
  if (!isPlain(raw)) throw new ProductModelPayloadError('payload must be an object');
  onlyKeys(raw, ['productIds', 'modelKey']);
  const productIds = idList(raw.productIds, 'productIds');
  if (raw.modelKey !== undefined && raw.modelKey !== null && !isId(raw.modelKey)) throw new ProductModelPayloadError('modelKey must be an id');
  return { productIds, modelKey: raw.modelKey ? String(raw.modelKey) : null };
}

export function parseRemove(raw: unknown): RemoveInput {
  if (!isPlain(raw)) throw new ProductModelPayloadError('payload must be an object');
  onlyKeys(raw, ['productIds']);
  return { productIds: idList(raw.productIds, 'productIds') };
}

export function parseMergePhotos(raw: unknown): MergePhotosInput {
  if (!isPlain(raw)) throw new ProductModelPayloadError('payload must be an object');
  onlyKeys(raw, ['modelKey', 'pickMediaId', 'targets', 'detachOld', 'restore']);
  if (!isId(raw.modelKey)) throw new ProductModelPayloadError('modelKey is required');
  const modelKey = String(raw.modelKey);
  if (raw.restore !== undefined) {
    if (raw.pickMediaId !== undefined || raw.targets !== undefined || raw.detachOld !== undefined) {
      throw new ProductModelPayloadError('restore cannot be combined with pickMediaId/targets/detachOld');
    }
    if (!Array.isArray(raw.restore) || raw.restore.length === 0 || raw.restore.length > 200) throw new ProductModelPayloadError('restore must be a non-empty list');
    const restore = raw.restore.map((x) => {
      if (!isPlain(x)) throw new ProductModelPayloadError('restore entries must be objects');
      onlyKeys(x, ['productId', 'mediaIds', 'expectedUpdatedAt']);
      if (!isId(x.productId) || typeof x.expectedUpdatedAt !== 'string' || !x.expectedUpdatedAt) throw new ProductModelPayloadError('restore entries need productId and expectedUpdatedAt');
      if (!Array.isArray(x.mediaIds) || x.mediaIds.length > 50 || !x.mediaIds.every(isId)) throw new ProductModelPayloadError('restore mediaIds must be a list of ids');
      return { productId: String(x.productId), mediaIds: x.mediaIds.map(String), expectedUpdatedAt: x.expectedUpdatedAt };
    });
    return { modelKey, restore };
  }
  if (!isId(raw.pickMediaId)) throw new ProductModelPayloadError('pickMediaId is required');
  if (typeof raw.detachOld !== 'boolean') throw new ProductModelPayloadError('detachOld must be true or false');
  if (!Array.isArray(raw.targets) || raw.targets.length === 0 || raw.targets.length > 200) throw new ProductModelPayloadError('targets must be a non-empty list');
  const targets = raw.targets.map((x) => {
    if (!isPlain(x)) throw new ProductModelPayloadError('targets must be objects');
    onlyKeys(x, ['productId', 'expectedUpdatedAt']);
    if (!isId(x.productId) || typeof x.expectedUpdatedAt !== 'string' || !x.expectedUpdatedAt) throw new ProductModelPayloadError('targets need productId and expectedUpdatedAt');
    return { productId: String(x.productId), expectedUpdatedAt: x.expectedUpdatedAt };
  });
  return { modelKey, pickMediaId: String(raw.pickMediaId), targets, detachOld: raw.detachOld };
}

export function productModelDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

const ctxOf = (identity: CommandIdentity, now: string): ProductModelCtx => ({
  branchId: identity.branchId, userId: identity.userId, now, role: (identity as CommandIdentity & { role?: string }).role ?? null,
});

function inHouse<T>(fn: () => T): T {
  try { return fn(); } catch (err) {
    if (err instanceof ProductModelRejected) throw new CommandRejected(err.code, err.message);
    throw err;
  }
}

export function runModelGroup(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseGroup(raw);
  return runRemoteCommand(deps, identity, () => inHouse(() => groupProductsInHouse(req, ctxOf(identity, deps.now()))) as unknown as Record<string, unknown>);
}
export function runModelRemove(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRemove(raw);
  return runRemoteCommand(deps, identity, () => inHouse(() => removeFromModelInHouse(req, ctxOf(identity, deps.now()))) as unknown as Record<string, unknown>);
}
export function runModelMergePhotos(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseMergePhotos(raw);
  return runRemoteCommand(deps, identity, () => inHouse(() => mergeModelPhotosInHouse(req, ctxOf(identity, deps.now()))) as unknown as Record<string, unknown>);
}

async function execute(
  run: (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>,
  op: string,
  payload: unknown,
  actor?: CommandActor,
): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(productModelDeps(), { ...actor, op }, body);
  } catch (err) {
    if (err instanceof ProductModelPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_PRODUCT_MODELS_GROUP, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runModelGroup, OP_PRODUCT_MODELS_GROUP, payload, actor),
});
registerCommand(OP_PRODUCT_MODELS_UNGROUP, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runModelRemove, OP_PRODUCT_MODELS_UNGROUP, payload, actor),
});
registerCommand(OP_PRODUCT_MODELS_MERGE_PHOTOS, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runModelMergePhotos, OP_PRODUCT_MODELS_MERGE_PHOTOS, payload, actor),
});
