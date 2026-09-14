// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — der Lebenszyklus eines Auftrags vom zweiten Rechner: stornieren (mit Geld),
// eine Position weiterschalten, „beim Lieferanten bestellt" markieren, eine Position ändern.
//
// Derselbe Bau wie bei den Angeboten und dem Geld (`offer-commands.ts`, `money-commands.ts`):
//
//  1. **Keine zweite Auftragslogik.** Jeder Befehl ruft die Hausfolge, die auch die Maske des Primary
//     ruft (`order-lifecycle-house.ts`): dieselbe Prüfung, dieselben Store-Schreibwege, dieselben
//     Buchungen, in der Transaktion des Auftrags. Scheitert eine Buchung, gibt es auch den Rest nicht.
//  2. **Der Rumpf ist ein Wunsch.** Kennung, Filiale, Benutzer, Zeitstempel, Fassung und alles, was das
//     Haus rechnet (Anzahlungssumme, Rückzahlungs-/Guthabenbetrag, Kostenbasis, Zeilensumme, vereinbarter
//     Preis, Rest, Marge, Ausgaben, Buchungen, Auftragsstatus) stehen namentlich auf der Verbotsliste;
//     ein unbekanntes Feld wird abgewiesen statt ignoriert. Der Status ist nur beim Weiterschalten einer
//     Position ein Wunsch — und dort nur eines der drei Ziele der Knöpfe.
//  3. **Ändern braucht die gesehene Fassung.** Jede der vier Handlungen nennt `expectedRevision` des
//     Auftrags (jede Positionsänderung bewegt sie per Trigger); verglichen wird INNERHALB der Transaktion.
//
// Bewusst NICHT dabei: „Delete Order" — Löschen bleibt am Primary (R6B).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import {
  assertHouseBranch, discardStagedAfterSuccess, invokeDiscardStaged, invokeReadStaged, stagingOwnerOf,
} from './remote-create-support';
import { CommercialPayloadError, mitFotos, parseSpec, type StagingExtras } from './commercial-commands';
import { EMBEDDED_PRODUCT_FIELDS, EmbeddedProductRejected } from '@/core/products/embedded-product';
import type { Product } from '@/core/models/types';
import { OrderActionRejected } from '@/core/orders/order-create';
import {
  ORDER_CANCEL_CHOICES, ORDER_LINE_STATUS_TARGETS, ORDER_REFUND_METHODS, assertOrderCancelChoice,
  cancelOrderInHouse, markOrderLineOrderedInHouse, setOrderLineStatusInHouse, updateOrderLineInHouse,
  type OrderCancelRequest, type OrderLineEditRequest, type OrderLineOrderedRequest, type OrderLineStatusRequest,
} from '@/core/orders/order-lifecycle-house';

export const OP_ORDERS_CANCEL = 'orders.cancel';
export const OP_ORDERS_UPDATE_LINE_STATUS = 'orders.update_line_status';
export const OP_ORDERS_MARK_LINE_ORDERED = 'orders.mark_line_ordered';
export const OP_ORDERS_UPDATE_LINE = 'orders.update_line';

export const ORDER_LIFECYCLE_OPS = [
  OP_ORDERS_CANCEL, OP_ORDERS_UPDATE_LINE_STATUS, OP_ORDERS_MARK_LINE_ORDERED, OP_ORDERS_UPDATE_LINE,
] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class OrderLifecyclePayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ORDER_PAYLOAD_INVALID') {
    super(message);
    this.name = 'OrderLifecyclePayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung, welche Fassung, welcher Zustand. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'created_by', 'actor', 'createdAt', 'updatedAt',
  'revision', 'status'];
/** Was nur das Hauptbuch schreibt — ein Rumpf bucht nie selbst. */
const LEDGER = ['ledger', 'entries', 'account', 'accounts', 'debit', 'credit', 'sourceModule', 'sourceId', 'transactionId'];
/** Was das Haus selbst rechnet oder vergibt — je Befehl. */
export const ORDER_LIFECYCLE_COMPUTED = {
  cancel: ['totalPaid', 'paidAmount', 'amount', 'settledAmount', 'refundAmount', 'creditAmount', 'customerId',
    'customerCreditId', 'productId', 'stockProductId', 'freedProductId', 'purchasePrice', 'costBasis', 'customCostBasis',
    'goldPayableIds', 'cancelledGoldPayableIds', 'openGoldPayableIds', 'expenseIds', 'openExpenseIds', 'lines', 'invoiceId', ...LEDGER],
  lineStatus: ['orderStatus', 'previousStatus', 'expenseId', 'expenseIds', 'bookedExpenseIds', 'costAmount', 'supplierId',
    'orderedSupplierId', 'invoiceId', 'lineTotal', ...LEDGER],
  markOrdered: ['orderedSupplierId', 'orderStatus', 'invoiceId', 'lineTotal', ...LEDGER],
  lineEdit: ['lineTotal', 'agreedPrice', 'remainingAmount', 'expectedMargin', 'margin', 'costAmount', 'purchasePrice',
    'vatAmount', 'vatRate', 'taxScheme', 'position', 'invoiceId', 'expenseId', 'supplierId', 'orderedSupplierId',
    'materialKind', 'isCustomerFacing', 'createdProductId', ...LEDGER],
} as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], computed: readonly string[], forbidden: readonly string[] = FORBIDDEN): Record<string, unknown> {
  if (!isPlain(raw)) throw new OrderLifecyclePayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (forbidden.includes(k) || computed.includes(k)) throw new OrderLifecyclePayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new OrderLifecyclePayloadError(`unknown field: ${k}`);
  }
  return raw;
}

function reqText(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new OrderLifecyclePayloadError(`${name} is required`);
  return v.trim();
}

/** Ein Freitext der Maske, WIE getippt; leer heißt „keiner". */
function optText(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new OrderLifecyclePayloadError(`${name} must be text`);
  return v === '' ? undefined : v;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], name: string, code?: string): T {
  const s = typeof v === 'string' ? v : '';
  if (!(list as readonly string[]).includes(s)) throw new OrderLifecyclePayloadError(`unknown ${name}: ${s || '(none)'}`, code);
  return s as T;
}

function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new OrderLifecyclePayloadError('expectedRevision is required — a change to an order must say which revision it saw');
  }
  return v;
}

/** Die Eingaberegel als Prüfung des Rumpfs: ihr Nein kommt mit IHREM Code zurück — derselbe wie am Primary. */
function rule<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof OrderActionRejected) throw new OrderLifecyclePayloadError(e.message, e.code);
    throw e;
  }
}

/** Dieselbe Folge INNERHALB des Auftrags: dort ist ihr Nein ein eingefrorenes Urteil. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof OrderActionRejected || e instanceof EmbeddedProductRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

// ── Die Rümpfe ──────────────────────────────────────────────────────────────

export type OrderCancelParsed = OrderCancelRequest & { expectedRevision: number };

/** „Cancel Order": nur die Wahl der Maske. Was zurückgeht, gutgeschrieben wird oder verfällt, rechnet das Haus. */
export function parseOrderCancel(raw: unknown): OrderCancelParsed {
  const r = strict(raw, ['orderId', 'expectedRevision', 'choice', 'refundMethod', 'note'], ORDER_LIFECYCLE_COMPUTED.cancel);
  const req: OrderCancelParsed = {
    orderId: reqText(r.orderId, 'orderId'),
    expectedRevision: revisionOf(r.expectedRevision),
    choice: oneOf(r.choice, ORDER_CANCEL_CHOICES, 'cancel choice', 'CANCEL_CHOICE_INVALID'),
  };
  if (r.refundMethod !== undefined && r.refundMethod !== null) {
    req.refundMethod = oneOf(r.refundMethod, ORDER_REFUND_METHODS, 'refund method', 'REFUND_METHOD_INVALID');
  }
  const note = optText(r.note, 'note');
  if (note !== undefined) req.note = note;
  rule(() => assertOrderCancelChoice(req));
  return req;
}

export type OrderLineStatusParsed = OrderLineStatusRequest & { expectedRevision: number };

export function parseOrderLineStatus(raw: unknown): OrderLineStatusParsed {
  // Hier ist der Status der Wunsch selbst — geprüft gegen die drei Ziele der Knöpfe.
  const r = strict(raw, ['orderId', 'lineId', 'expectedRevision', 'status'], ORDER_LIFECYCLE_COMPUTED.lineStatus,
    FORBIDDEN.filter((k) => k !== 'status'));
  if (r.status === 'CANCELLED') {
    throw new OrderLifecyclePayloadError('a line is cancelled with its order (orders.cancel), not from here', 'LINE_STATUS_INVALID');
  }
  if (r.status === 'ORDERED') {
    throw new OrderLifecyclePayloadError('a line is marked as ordered with orders.mark_line_ordered', 'LINE_STATUS_INVALID');
  }
  return {
    orderId: reqText(r.orderId, 'orderId'),
    lineId: reqText(r.lineId, 'lineId'),
    status: oneOf(r.status, ORDER_LINE_STATUS_TARGETS, 'line status', 'LINE_STATUS_INVALID'),
    expectedRevision: revisionOf(r.expectedRevision),
  };
}

export type OrderLineOrderedParsed = OrderLineOrderedRequest & { expectedRevision: number };

export function parseOrderLineOrdered(raw: unknown): OrderLineOrderedParsed {
  const r = strict(raw, ['orderId', 'lineId', 'expectedRevision', 'supplierId'], ORDER_LIFECYCLE_COMPUTED.markOrdered);
  const out: OrderLineOrderedParsed = {
    orderId: reqText(r.orderId, 'orderId'),
    lineId: reqText(r.lineId, 'lineId'),
    expectedRevision: revisionOf(r.expectedRevision),
  };
  if (r.supplierId !== undefined && r.supplierId !== null) out.supplierId = reqText(r.supplierId, 'supplierId');
  return out;
}

export interface OrderLineEditParsed extends Omit<OrderLineEditRequest, 'newProduct'> {
  expectedRevision: number;
  /** Der Entwurf „New Product" — mit den Kennungen seiner Fotos statt der Bilder. */
  newProduct?: { spec: Partial<Product>; stagingIds?: string[] };
}

/** „Speichern" im Positionsdialog: nur die Eingaben — Zeilensumme, Preis, Rest und Marge rechnet das Haus. */
export function parseOrderLineEdit(raw: unknown): OrderLineEditParsed {
  const r = strict(raw, ['orderId', 'lineId', 'expectedRevision', 'description', 'quantity', 'unitPrice', 'productId', 'newProduct'],
    ORDER_LIFECYCLE_COMPUTED.lineEdit);
  const out: OrderLineEditParsed = {
    orderId: reqText(r.orderId, 'orderId'),
    lineId: reqText(r.lineId, 'lineId'),
    expectedRevision: revisionOf(r.expectedRevision),
  };
  if (r.description !== undefined) {
    if (typeof r.description !== 'string') throw new OrderLifecyclePayloadError('description must be text');
    out.description = r.description;
  }
  if (r.quantity !== undefined) {
    if (typeof r.quantity !== 'number' || !Number.isInteger(r.quantity) || r.quantity < 1) {
      throw new OrderLifecyclePayloadError('quantity must be a whole number of at least 1', 'LINE_QUANTITY_INVALID');
    }
    out.quantity = r.quantity;
  }
  if (r.unitPrice !== undefined) {
    if (typeof r.unitPrice !== 'number' || !Number.isFinite(r.unitPrice) || r.unitPrice < 0) {
      throw new OrderLifecyclePayloadError('unitPrice must be a number of at least 0', 'LINE_PRICE_INVALID');
    }
    out.unitPrice = r.unitPrice;
  }
  if (r.productId !== undefined) out.productId = reqText(r.productId, 'productId');
  // Derselbe Entwurf wie „New Product" beim Anlegen des Auftrags — dieselbe Prüfung des Rumpfs.
  const spec = parseSpec(r.newProduct, EMBEDDED_PRODUCT_FIELDS, 'newProduct');
  if (spec) out.newProduct = spec;
  if (out.productId !== undefined && out.newProduct !== undefined) {
    throw new OrderLifecyclePayloadError('an existing article OR a new one — not both', 'LINE_PRODUCT_AMBIGUOUS');
  }
  if ([out.description, out.quantity, out.unitPrice, out.productId, out.newProduct].every((v) => v === undefined)) {
    throw new OrderLifecyclePayloadError('an edit must change something', 'LINE_EDIT_EMPTY');
  }
  return out;
}

// ── Die Läufe ───────────────────────────────────────────────────────────────

export function orderLifecycleDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runOrderCancel(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseOrderCancel(raw);
  return runRemoteCommand(deps, identity, () => {
    // Guthaben und Lagerstück entstehen in den Büchern dieses Rechners — also nur für DIESE Filiale.
    assertHouseBranch(identity);
    const r = urteil(() => cancelOrderInHouse(req, identity.branchId));
    return {
      orderId: r.orderId, status: r.status, choice: r.choice, settledAmount: r.settledAmount,
      customerCreditId: r.customerCreditId ?? null, stockProductId: r.stockProductId ?? null,
      freedProductId: r.freedProductId ?? null,
      cancelledGoldPayables: r.cancelledGoldPayableIds.length, openGoldPayables: r.openGoldPayableIds.length,
      openExpenses: r.openExpenseIds.length,
      // R7A (PP-8) — was mit der Überzahlungs-Gutschrift geschah: bleibt beim Kunden / storniert (nie gelöscht).
      keptOverpayCredits: (r.keptOverpayCreditIds ?? []).length,
      voidedOverpayCredits: (r.voidedOverpayCreditIds ?? []).length,
      revision: r.revision,
    };
  });
}

export function runOrderLineStatus(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseOrderLineStatus(raw);
  return runRemoteCommand(deps, identity, () => {
    // Die Lieferanten-A/P entsteht in den Büchern dieses Rechners.
    assertHouseBranch(identity);
    const r = urteil(() => setOrderLineStatusInHouse(req, identity.branchId));
    return {
      orderId: r.orderId, lineId: r.lineId, status: r.status, previousStatus: r.previousStatus,
      orderStatus: r.orderStatus, bookedExpenses: r.bookedExpenseIds.length, revision: r.revision,
    };
  });
}

export function runOrderLineOrdered(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseOrderLineOrdered(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => markOrderLineOrderedInHouse(req, identity.branchId));
    return { orderId: r.orderId, lineId: r.lineId, status: r.status, supplierId: r.supplierId, orderStatus: r.orderStatus, revision: r.revision };
  });
}

export async function runOrderLineEdit(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: StagingExtras = {},
): Promise<CommandOutcome> {
  const req = parseOrderLineEdit(raw);
  const owner = stagingOwnerOf(identity);
  const read = extras.readStaged ?? invokeReadStaged;
  const staged = req.newProduct?.stagingIds ?? [];
  const outcome = await runRemoteCommand(deps, identity, async () => {
    // Ein neuer Artikel entsteht in den Büchern dieses Rechners.
    assertHouseBranch(identity);
    // Die Fotos des Entwurfs werden INNERHALB des Auftrags gelesen (eine Wiederholung liest sie nie wieder).
    const newProduct = await mitFotos(req.newProduct, owner, read);
    const r = urteil(() => updateOrderLineInHouse({ ...req, newProduct }, identity.branchId));
    return {
      orderId: r.orderId, lineId: r.lineId, productId: r.productId, createdProductId: r.createdProductId ?? null,
      quantity: r.quantity, unitPrice: r.unitPrice, lineTotal: r.lineTotal, agreedPrice: r.agreedPrice,
      remainingAmount: r.remainingAmount, expectedMargin: r.expectedMargin, revision: r.revision,
    };
  });
  if (outcome.kind === 'ok') await discardStagedAfterSuccess(staged, owner, extras.discardStaged ?? invokeDiscardStaged);
  return outcome;
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(orderLifecycleDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof OrderLifecyclePayloadError || err instanceof CommercialPayloadError) {
      throw new BusinessError(err.code, err.message);
    }
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_ORDERS_CANCEL, { kind: 'mutation', handler: (p, a) => execute(runOrderCancel, OP_ORDERS_CANCEL, p, a) });
registerCommand(OP_ORDERS_UPDATE_LINE_STATUS, { kind: 'mutation', handler: (p, a) => execute(runOrderLineStatus, OP_ORDERS_UPDATE_LINE_STATUS, p, a) });
registerCommand(OP_ORDERS_MARK_LINE_ORDERED, { kind: 'mutation', handler: (p, a) => execute(runOrderLineOrdered, OP_ORDERS_MARK_LINE_ORDERED, p, a) });
registerCommand(OP_ORDERS_UPDATE_LINE, { kind: 'mutation', handler: (p, a) => execute(runOrderLineEdit, OP_ORDERS_UPDATE_LINE, p, a) });
