// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — der Lebenszyklus eines Einkaufs vom zweiten Rechner: „Return to
// Supplier" (`purchases.return_to_supplier`), „Cancel" (`purchases.cancel`) und „Inbox-Foto
// verwerfen" (`purchases.dismiss_inbox`).
//
// Derselbe Bau wie bei Geld und Rücknahmen (`payables-commands.ts`, `sales-reversal-commands.ts`):
//
//  1. **Keine zweite Logik.** Jeder Befehl ruft die Hausfolge, die auch die Maske des Primary ruft
//     (`core/purchases/purchase-lifecycle-house.ts`) — dieselbe Prüfung, dieselben Buchungen, in der
//     Transaktion des Auftrags. Scheitert eine Buchung, gibt es auch die Handlung nicht.
//  2. **Der Rumpf ist ein Wunsch.** Er nennt WELCHEN Einkauf / WELCHES Foto, die gesehene Fassung
//     und bei der Rückgabe genau das, was die Maske den Menschen wählen lässt (Zeilen, Menge,
//     Stückpreis, Erstattungsweg, Notiz). Artikel, Summen, Erstattung, Rest, Guthaben, Bestand,
//     Belegnummer, Datum und Buchungen findet der Primary selbst — sie stehen namentlich auf der
//     Verbotsliste; ein unbekanntes Feld wird abgewiesen statt ignoriert.
//  3. **Ändern braucht die gesehene Fassung** (`purchases.revision`), verglichen INNERHALB der
//     Transaktion. Das Inbox-Foto hat keine Fassung: sein einseitiger Übergang aus `pending` ist
//     sein Wächter.
//  4. **Der Absender ist der Urheber.** Filiale und Benutzer kommen aus der geprüften Identität,
//     nie aus dem Rumpf.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import { assertHouseBranch } from './remote-create-support';
import {
  PURCHASE_LIFECYCLE_OP, PurchaseLifecycleRejected, isRefundMethod, type RefundMethod,
  returnToSupplierInHouse, cancelPurchaseInHouse, dismissPurchaseInboxInHouse, createPurchaseInboxInHouse,
} from '@/core/purchases/purchase-lifecycle-house';
import {
  discardStagedAfterSuccess, invokeDiscardStaged, invokeReadStagedRecord,
  isStagingId, readStagedAsRecordImages, stagingOwnerOf, type StagedMediaDiscard, type StagedMediaReader,
} from './remote-create-support';
import { ingestInboxPhotos } from '@/core/purchases/inbox-media';

export const OP_PURCHASES_RETURN_TO_SUPPLIER = PURCHASE_LIFECYCLE_OP.RETURN_TO_SUPPLIER;
export const OP_PURCHASES_CANCEL = PURCHASE_LIFECYCLE_OP.CANCEL;
export const OP_PURCHASES_DISMISS_INBOX = PURCHASE_LIFECYCLE_OP.DISMISS_INBOX;
export const OP_PURCHASE_INBOX_CREATE = PURCHASE_LIFECYCLE_OP.CREATE_INBOX;

export const PURCHASE_LIFECYCLE_OPS = [
  OP_PURCHASES_RETURN_TO_SUPPLIER, OP_PURCHASES_CANCEL, OP_PURCHASES_DISMISS_INBOX, OP_PURCHASE_INBOX_CREATE,
] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class PurchaseLifecyclePayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PURCHASE_PAYLOAD_INVALID') {
    super(message);
    this.name = 'PurchaseLifecyclePayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung, welcher Zustand. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'created_by', 'actor', 'role', 'changedBy',
  'createdAt', 'updatedAt', 'revision', 'status'];
/** Was nur das Hauptbuch schreibt — ein Rumpf bucht nie selbst. */
const LEDGER = ['ledger', 'entries', 'postings', 'account', 'accounts', 'debit', 'credit', 'direction', 'sourceModule',
  'sourceId', 'transactionId', 'entryNo', 'balance', 'amount'];
/** Was der Primary selbst findet oder rechnet — je Befehl (auch auf Zeilenebene der Rückgabe). */
export const PURCHASE_LIFECYCLE_COMPUTED = {
  returnToSupplier: ['returnId', 'returnNumber', 'returnDate', 'supplierId', 'productId', 'description',
    'totalAmount', 'total', 'lineTotal', 'refundAmount', 'refundTotal', 'creditAmount', 'supplierCreditId', 'creditId',
    'paidAmount', 'remainingAmount', 'payable', 'purchaseStatus', 'purchaseTotal', 'vatAmount', 'vat',
    'stockStatus', 'quantityOnHand', 'qtyRemaining', 'lotId', 'lots', ...LEDGER],
  cancel: ['purchaseNumber', 'supplierId', 'totalAmount', 'paidAmount', 'remainingAmount', 'payments', 'paymentIds',
    'reversedPayments', 'returnIds', 'cancelledReturns', 'orderId', 'orderLineIds', 'sourceOrderId', 'revertedOrderLines',
    'lots', 'lotIds', 'cancelledLots', 'stockStatus', 'quantity', 'supplierCreditIds', 'restoredSupplierCredits', ...LEDGER],
  dismissInbox: ['images', 'image', 'note', 'mediaId', 'mediaIds', 'stagingId', 'stagingIds', 'purchaseId', ...LEDGER],
} as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], computed: readonly string[], what = 'payload'): Record<string, unknown> {
  if (!isPlain(raw)) throw new PurchaseLifecyclePayloadError(`${what} must be an object`);
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k) || computed.includes(k)) throw new PurchaseLifecyclePayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new PurchaseLifecyclePayloadError(`unknown field: ${k}`);
  }
  return raw;
}

function idOf(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new PurchaseLifecyclePayloadError(`${name} is required`);
  return v.trim();
}

function numberOf(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new PurchaseLifecyclePayloadError(`${name} must be a number`);
  return v;
}

function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new PurchaseLifecyclePayloadError('expectedRevision is required — a change to a purchase must say which revision it saw');
  }
  return v;
}

/** Ein Nein der Hausfolge INNERHALB des Auftrags ist ein eingefrorenes Urteil; alles andere bleibt eine Störung. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PurchaseLifecycleRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

// ── Die Rümpfe ──────────────────────────────────────────────────────────────

export interface PurchaseReturnCommand {
  purchaseId: string;
  expectedRevision: number;
  refundMethod: RefundMethod;
  notes?: string;
  lines: Array<{ purchaseLineId: string; quantity: number; unitPrice: number }>;
}

export function parsePurchaseReturn(raw: unknown): PurchaseReturnCommand {
  const r = strict(raw, ['purchaseId', 'expectedRevision', 'refundMethod', 'notes', 'lines'], PURCHASE_LIFECYCLE_COMPUTED.returnToSupplier);
  if (!isRefundMethod(r.refundMethod)) {
    throw new PurchaseLifecyclePayloadError('refundMethod is cash, bank, benefit or credit', 'PURCHASE_RETURN_METHOD_INVALID');
  }
  if (r.notes !== undefined && r.notes !== null && typeof r.notes !== 'string') throw new PurchaseLifecyclePayloadError('notes must be text');
  // Die Maske gibt ohne ausgewählte Zeile gar keinen Knopf frei — dieselbe Regel, derselbe Code wie im Haus.
  if (!Array.isArray(r.lines) || r.lines.length === 0) {
    throw new PurchaseLifecyclePayloadError('Select at least one item to return.', 'PURCHASE_RETURN_NO_LINES');
  }
  const lines = r.lines.map((raw) => {
    const l = strict(raw, ['purchaseLineId', 'quantity', 'unitPrice'], PURCHASE_LIFECYCLE_COMPUTED.returnToSupplier, 'a return line');
    return { purchaseLineId: idOf(l.purchaseLineId, 'purchaseLineId'), quantity: numberOf(l.quantity, 'quantity'), unitPrice: numberOf(l.unitPrice, 'unitPrice') };
  });
  const notes = typeof r.notes === 'string' && r.notes.trim() ? r.notes : undefined;
  return {
    purchaseId: idOf(r.purchaseId, 'purchaseId'), expectedRevision: revisionOf(r.expectedRevision),
    refundMethod: r.refundMethod, ...(notes !== undefined ? { notes } : {}), lines,
  };
}

export interface PurchaseCancelCommand { purchaseId: string; expectedRevision: number }

export function parsePurchaseCancel(raw: unknown): PurchaseCancelCommand {
  const r = strict(raw, ['purchaseId', 'expectedRevision'], PURCHASE_LIFECYCLE_COMPUTED.cancel);
  return { purchaseId: idOf(r.purchaseId, 'purchaseId'), expectedRevision: revisionOf(r.expectedRevision) };
}

export interface InboxDismissCommand { inboxId: string }

export function parseInboxDismiss(raw: unknown): InboxDismissCommand {
  const r = strict(raw, ['inboxId'], PURCHASE_LIFECYCLE_COMPUTED.dismissInbox);
  return { inboxId: idOf(r.inboxId, 'inboxId') };
}

// ── Die Läufe ───────────────────────────────────────────────────────────────

export function purchaseLifecycleDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runPurchaseReturn(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parsePurchaseReturn(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const ctx = { branchId: identity.branchId, userId: identity.userId, now: deps.now() };
    const out = urteil(() => returnToSupplierInHouse({
      purchaseId: req.purchaseId, refundMethod: req.refundMethod, notes: req.notes, lines: req.lines,
    }, ctx, req.expectedRevision));
    return { ...out };
  });
}

export function runPurchaseCancel(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parsePurchaseCancel(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    // Die Regel der Maske gilt auch fern: ein voll bezahlter Einkauf hat keinen „Cancel"-Knopf.
    const out = urteil(() => cancelPurchaseInHouse(req.purchaseId, identity.branchId, {
      expectedRevision: req.expectedRevision, blockPaid: true, now: deps.now(),
    }));
    return { ...out };
  });
}

/**
 * MEDIA-INBOX §2 — der Rumpf des neuen Befehls: eine Notiz und die Kennungen der abgelegten Fotos.
 * NIE Bytes; eine Kennung ist der Inhaltshash der Ablage, sonst nichts.
 */
export interface InboxCreateRequest { note?: string; stagingIds: string[] }

export const INBOX_MAX_PHOTOS = 3;

export function parseInboxCreate(raw: unknown): InboxCreateRequest {
  if (!isPlain(raw)) throw new PurchaseLifecyclePayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k)) throw new PurchaseLifecyclePayloadError(`the primary decides ${k}, not the client`);
    if (k === 'images' || k === 'image') {
      throw new PurchaseLifecyclePayloadError('an intake photo travels as staged bytes (photos: [{ stagingId }]), never inside the order');
    }
    if (!['note', 'photos'].includes(k)) throw new PurchaseLifecyclePayloadError(`unknown field: ${k}`);
  }
  const photos = raw.photos;
  if (!Array.isArray(photos) || photos.length === 0) {
    throw new PurchaseLifecyclePayloadError('an inbox entry is a photo — name at least one staged photo');
  }
  if (photos.length > INBOX_MAX_PHOTOS) throw new PurchaseLifecyclePayloadError(`at most ${INBOX_MAX_PHOTOS} photos`);
  const stagingIds = photos.map((slot) => {
    if (isPlain(slot) && Object.keys(slot).length === 1 && isStagingId(slot.stagingId)) return String(slot.stagingId);
    throw new PurchaseLifecyclePayloadError('a photo is { stagingId: <content hash> }');
  });
  const note = raw.note;
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw new PurchaseLifecyclePayloadError('note must be text');
  }
  return { note: typeof note === 'string' && note.trim() ? note.trim() : undefined, stagingIds };
}

/**
 * MEDIA-INBOX §3 — die Bytes holen und AUFNEHMEN, bevor die Klammer aufgeht.
 *
 * Der Ingest hat eigene durable Haltepunkte; in einer offenen Geschäftstransaktion hätte er keine.
 * Ein Nein wird mitgenommen statt geworfen: eine Wiederholung desselben Auftrags — die Ablage ist
 * dann längst geräumt — muss die eingefrorene Antwort bekommen und keinen neuen Fehler.
 */
export async function runInboxCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, media: InboxMedia = {},
): Promise<CommandOutcome> {
  const req = parseInboxCreate(raw);
  const read = media.readStaged ?? invokeReadStagedRecord;
  const owner = stagingOwnerOf(identity);
  let mediaIds: string[] = [];
  let fotoFehler: unknown = null;
  try {
    const urls = await readStagedAsRecordImages(req.stagingIds, owner, read,
      (m) => new PurchaseLifecyclePayloadError(m, 'STAGED_IMAGE_GONE'));
    mediaIds = await ingestInboxPhotos(urls);
  } catch (e) { fotoFehler = e; }
  const outcome = await runRemoteCommand(deps, identity, () => {
    if (fotoFehler) throw fotoFehler;
    assertHouseBranch(identity);
    return { ...urteil(() => createPurchaseInboxInHouse({ note: req.note, mediaIds }, identity.branchId, deps.now())) };
  });
  if (outcome.kind === 'ok') {
    await discardStagedAfterSuccess(req.stagingIds, owner, media.discardStaged ?? invokeDiscardStaged);
  }
  return outcome;
}

/** Nur für Tests: die Zwischenablage ohne Tauri. Voreingestellt sind die echten Aufrufe. */
export interface InboxMedia { readStaged?: StagedMediaReader; discardStaged?: StagedMediaDiscard }

export function runInboxDismiss(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseInboxDismiss(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    return { ...urteil(() => dismissPurchaseInboxInHouse(req.inboxId, identity.branchId)) };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(purchaseLifecycleDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof PurchaseLifecyclePayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

// Jede Buchung einzeln angemeldet — dieselbe Form wie in allen anderen Befehlsmodulen (das Gate zählt sie).
registerCommand(OP_PURCHASES_RETURN_TO_SUPPLIER, { kind: 'mutation', handler: (p, a) => execute(runPurchaseReturn, OP_PURCHASES_RETURN_TO_SUPPLIER, p, a) });
registerCommand(OP_PURCHASES_CANCEL, { kind: 'mutation', handler: (p, a) => execute(runPurchaseCancel, OP_PURCHASES_CANCEL, p, a) });
registerCommand(OP_PURCHASES_DISMISS_INBOX, { kind: 'mutation', handler: (p, a) => execute(runInboxDismiss, OP_PURCHASES_DISMISS_INBOX, p, a) });
registerCommand(OP_PURCHASE_INBOX_CREATE, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runInboxCreate(d, i, r), OP_PURCHASE_INBOX_CREATE, p, a) });
