// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — die Inventur vom zweiten Rechner, ausschließlich über den Primary.
//
// Vorher lief die Inventur auf PC2 gegen den Kern des EIGENEN Rechners (dessen Konfig-DB, dessen
// alte Geschäftsdatei) — eine zweite Wahrheit. R6B hat das verriegelt; hier ist der echte Weg: die
// Maske auf PC2 schickt Absichten, und der Primary führt DIESELBE Hausfolge aus wie seine eigene
// Maske (`inventory-house.ts`), in seiner Schreibreihenfolge, in einer Transaktion, durabel.
//
// Aus dem Lebenszyklus abgeleitet, nicht aus den Knöpfen — vier getrennte Absichten:
//
//   inventory.start         — die Maske öffnen = einen Lauf beginnen oder den offenen aufnehmen
//   inventory.save          — das Arbeitsblatt speichern (Beobachtungen + Spalten), Lauf bleibt offen
//   inventory.finish        — den Lauf abschließen (legt das Arbeitsblatt weg; Verlauf bleibt)
//   inventory.record_check  — der Einzel-Check auf der Artikelseite (kein Lauf, kein Arbeitsblatt)
//
// Speichern und Abschließen sind ZWEI Absichten: Abschließen speichert nichts, und Speichern
// schließt nichts. Keine der vier ändert Bestand, Status oder Hauptbuch — das tut eine Inventur in
// diesem Haus nicht (Audit, siehe inventory-house.ts).
//
// Was der Client NIE vorgibt: Filiale, Benutzer, Beginn, Fassung der Wirkung, Zeitstempel,
// Beobachtungskennungen, einen Soll-/Ist-Bestand oder eine Differenz. Er nennt Artikel, Urteile,
// Notizen — und die Fassung, die er GESEHEN hat.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import {
  INSIDE_COMMAND, InventoryRejected, MAX_INVENTORY_PRODUCTS,
  finishInventory, recordSingleCheck, saveInventory, startInventory,
  type InventoryCore, type VerdictInput,
} from '@/core/stock/inventory-house';
import { tauriInventoryCore } from '@/core/stock/inventory-core';
import type { InventorySessionDb } from '@/core/stock/inventory-session';
import type { StockCheckStatus } from '@/core/stock/stock-check';

export const OP_INVENTORY_START = 'inventory.start';
export const OP_INVENTORY_SAVE = 'inventory.save';
export const OP_INVENTORY_FINISH = 'inventory.finish';
export const OP_INVENTORY_RECORD_CHECK = 'inventory.record_check';

export const INVENTORY_OPS = [OP_INVENTORY_START, OP_INVENTORY_SAVE, OP_INVENTORY_FINISH, OP_INVENTORY_RECORD_CHECK] as const;

export class InventoryPayloadError extends Error {
  readonly code = 'INVENTORY_PAYLOAD_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InventoryPayloadError';
  }
}

/**
 * Was ein Client nie nennt. Die Liste ist bewusst lang: jede dieser Angaben wäre ein Weg, dem
 * Primary eine Wirkung vorzuschreiben, die er selbst bestimmt — oder die es gar nicht gibt.
 */
export const INVENTORY_FORBIDDEN = [
  'branchId', 'tenantId', 'userId', 'checkedBy', 'checkedByName', 'checkedAt', 'source', 'requestId', 'checkId',
  'startedAt', 'closedAt', 'updatedAt', 'appliedCheckId', 'revision', 'status_at',
  'expectedQuantity', 'expectedQty', 'countedQuantity', 'quantity', 'variance', 'difference',
  'resultingStock', 'stockStatus', 'adjustment', 'ledger',
];

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!isPlain(raw)) throw new InventoryPayloadError(`${what} must be an object`);
  for (const k of Object.keys(raw)) {
    if (INVENTORY_FORBIDDEN.includes(k)) throw new InventoryPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new InventoryPayloadError(`unknown field: ${k}`);
  }
  return raw;
}

function idOf(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new InventoryPayloadError(`${what} is required`);
  return v;
}

function idList(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new InventoryPayloadError(`${what} must be a list`);
  if (v.length > MAX_INVENTORY_PRODUCTS) throw new InventoryPayloadError(`at most ${MAX_INVENTORY_PRODUCTS} items`);
  return v.map((x) => idOf(x, what));
}

function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new InventoryPayloadError('expectedRevision is required — say which state of the inventory you saw');
  }
  return v;
}

function verdict(raw: unknown): VerdictInput {
  const r = strict(raw, ['productId', 'status', 'notes'], 'an item');
  if (r.notes !== undefined && r.notes !== null && typeof r.notes !== 'string') throw new InventoryPayloadError('notes must be text');
  return { productId: idOf(r.productId, 'productId'), status: r.status as StockCheckStatus, notes: typeof r.notes === 'string' ? r.notes : '' };
}

export function parseInventoryStart(raw: unknown): { productIds: string[] } {
  const r = strict(raw, ['productIds'], 'payload');
  return { productIds: idList(r.productIds, 'productIds') };
}

export function parseInventorySave(raw: unknown): { sessionId: string; expectedRevision: number; items: VerdictInput[]; visibleProductIds: string[] } {
  const r = strict(raw, ['sessionId', 'expectedRevision', 'items', 'visibleProductIds'], 'payload');
  if (!Array.isArray(r.items)) throw new InventoryPayloadError('items must be a list');
  if (r.items.length > MAX_INVENTORY_PRODUCTS) throw new InventoryPayloadError(`at most ${MAX_INVENTORY_PRODUCTS} items`);
  return {
    sessionId: idOf(r.sessionId, 'sessionId'),
    expectedRevision: revisionOf(r.expectedRevision),
    items: r.items.map(verdict),
    visibleProductIds: idList(r.visibleProductIds, 'visibleProductIds'),
  };
}

export function parseInventoryFinish(raw: unknown): { sessionId: string; expectedRevision: number } {
  const r = strict(raw, ['sessionId', 'expectedRevision'], 'payload');
  return { sessionId: idOf(r.sessionId, 'sessionId'), expectedRevision: revisionOf(r.expectedRevision) };
}

export function parseInventoryRecordCheck(raw: unknown): VerdictInput {
  return verdict(raw);
}

export function inventoryDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

/** Das Urteil der Hausfolge wird eingefroren; eine nicht geschriebene Beobachtung ist KEIN Urteil. */
async function urteil<T>(fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof InventoryRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

const sheetDb = (db: unknown) => db as InventorySessionDb;

export function runInventoryStart(deps: EngineDeps, identity: CommandIdentity, raw: unknown, core: InventoryCore = tauriInventoryCore()): Promise<CommandOutcome> {
  const req = parseInventoryStart(raw);
  return runRemoteCommand(deps, identity, async (db) => {
    assertHouseBranch(identity);
    const r = await urteil(() => startInventory(sheetDb(db), core, INSIDE_COMMAND, {
      branchId: identity.branchId, productIds: req.productIds, now: deps.now(), newId: () => uuid(),
    }));
    // Klein halten: das Ergebnis wird für die Wiederholung eingefroren. Das Arbeitsblatt selbst liest
    // die Maske danach über `inventory.session.get`.
    return { sessionId: r.sheet.sessionId, startedAt: r.sheet.startedAt, revision: r.sheet.revision, foldedIn: r.foldedIn, created: r.created };
  });
}

export function runInventorySave(deps: EngineDeps, identity: CommandIdentity, raw: unknown, core: InventoryCore = tauriInventoryCore()): Promise<CommandOutcome> {
  const req = parseInventorySave(raw);
  return runRemoteCommand(deps, identity, async (db) => {
    assertHouseBranch(identity);
    const r = await urteil(() => saveInventory(sheetDb(db), core, INSIDE_COMMAND, {
      branchId: identity.branchId,
      sessionId: req.sessionId,
      expectedRevision: req.expectedRevision,
      items: req.items,
      visibleProductIds: req.visibleProductIds,
      userId: identity.userId,
      // Dieselbe Kennung bei jeder Wiederholung DIESES Auftrags: der Kern findet die Beobachtung
      // wieder, statt eine zweite zu schreiben.
      requestIdFor: (productId) => `${identity.commandId}:${productId}`,
      now: deps.now(),
    }));
    return { sessionId: req.sessionId, revision: r.sheet.revision, recorded: Object.keys(r.recorded).length, unchanged: r.unchanged };
  });
}

export function runInventoryFinish(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseInventoryFinish(raw);
  return runRemoteCommand(deps, identity, async (db) => {
    assertHouseBranch(identity);
    await urteil(() => finishInventory(sheetDb(db), INSIDE_COMMAND, {
      branchId: identity.branchId, sessionId: req.sessionId, expectedRevision: req.expectedRevision, now: deps.now(),
    }));
    return { sessionId: req.sessionId, finished: true };
  });
}

export function runInventoryRecordCheck(deps: EngineDeps, identity: CommandIdentity, raw: unknown, core: InventoryCore = tauriInventoryCore()): Promise<CommandOutcome> {
  const v = parseInventoryRecordCheck(raw);
  return runRemoteCommand(deps, identity, async (db) => {
    assertHouseBranch(identity);
    const c = await urteil(() => recordSingleCheck(sheetDb(db), core, {
      branchId: identity.branchId, productId: v.productId, status: v.status, notes: v.notes,
      userId: identity.userId, requestId: identity.commandId,
    }));
    return { checkId: c.check_id, productId: c.product_id, status: c.status, checkedAt: c.checked_at };
  });
}

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(inventoryDeps(), { ...actor, op }, body);
  } catch (err) {
    if (err instanceof InventoryPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_INVENTORY_START, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runInventoryStart(d, i, r), OP_INVENTORY_START, p, a) });
registerCommand(OP_INVENTORY_SAVE, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runInventorySave(d, i, r), OP_INVENTORY_SAVE, p, a) });
registerCommand(OP_INVENTORY_FINISH, { kind: 'mutation', handler: (p, a) => execute(runInventoryFinish, OP_INVENTORY_FINISH, p, a) });
registerCommand(OP_INVENTORY_RECORD_CHECK, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runInventoryRecordCheck(d, i, r), OP_INVENTORY_RECORD_CHECK, p, a) });
