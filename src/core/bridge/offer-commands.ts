// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — Angebote vom zweiten Rechner: anlegen, als Entwurf speichern, senden /
// annehmen / ablehnen, in eine Rechnung wandeln.
//
// Derselbe Bau wie bei den Geldaktionen (`money-commands.ts`):
//
//  1. **Keine zweite Angebotslogik.** Jeder Befehl ruft die Hausfolge, die auch die Maske des Primary
//     ruft (`offer-house.ts`): dieselbe Prüfung, dieselben Zeilen, dieselben Folgen am Artikel und in
//     den Aufgaben, und für die Rechnung derselbe Weg wie jede andere Rechnung — in der Transaktion
//     des Auftrags.
//  2. **Der Rumpf ist ein Wunsch.** Kennung, Filiale, Benutzer, Zeitstempel, Fassung und alles, was
//     das Haus rechnet oder vergibt (Angebots- und Rechnungsnummer, Summen, Steuersatz, Brutto je
//     Position, Einstand, Los, Zeitpunkt des Sendens, Artikelstatus, Buchung), stehen namentlich auf
//     der Verbotsliste; ein unbekanntes Feld wird abgewiesen statt ignoriert. Der Status ist nur beim
//     Statuswechsel ein Wunsch — und dort nur einer der drei, die die Knöpfe anbieten.
//  3. **Ändern braucht die gesehene Fassung.** Speichern, Status und Umwandeln nennen
//     `expectedRevision`; verglichen wird INNERHALB der Transaktion. Anlegen braucht keine.
//
// Bewusst NICHT dabei: Löschen eines Angebots — das bleibt am Primary (R6B).
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
  convertOfferToInvoiceInHouse, createOfferInHouse, setOfferStatusInHouse, updateOfferInHouse, type OfferCtx,
} from '@/core/offers/offer-house';
import {
  OfferRejected, offerConvertInput, offerCreateInput, offerStatusInput, offerUpdateInput,
  type OfferConvertInput, type OfferCreateInput, type OfferStatusInput, type OfferUpdateInput,
} from '@/core/offers/offer-rules';

export const OP_OFFERS_CREATE = 'offers.create';
export const OP_OFFERS_UPDATE = 'offers.update';
export const OP_OFFERS_SET_STATUS = 'offers.set_status';
export const OP_OFFERS_CONVERT_TO_INVOICE = 'offers.convert_to_invoice';

export const OFFER_OPS = [OP_OFFERS_CREATE, OP_OFFERS_UPDATE, OP_OFFERS_SET_STATUS, OP_OFFERS_CONVERT_TO_INVOICE] as const;

/** Eine technische Obergrenze des Rumpfs (dieselbe wie bei der Auftragsumwandlung) — keine Geschäftsregel. */
const MAX_LINES = 500;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class OfferPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'OFFER_PAYLOAD_INVALID') {
    super(message);
    this.name = 'OfferPayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung, welche Fassung, welcher Zustand. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status'];
/** Was nur das Hauptbuch schreibt — ein Rumpf bucht nie selbst. */
const LEDGER = ['ledger', 'entries', 'account', 'accounts', 'debit', 'credit', 'sourceModule', 'sourceId', 'transactionId'];
/** Was das Haus selbst rechnet oder vergibt — je Befehl. */
export const OFFER_COMPUTED = {
  offer: ['offerNumber', 'subtotal', 'vatAmount', 'vatRate', 'total', 'grossAmount', 'netAmount', 'currency', 'taxScheme',
    'sentAt', 'followUpAt', 'invoiceId', 'invoiceNumber', 'stockStatus', 'lastOfferPrice', ...LEDGER],
  line: ['offerId', 'vatRate', 'vatAmount', 'lineTotal', 'grossAmount', 'netAmount', 'purchasePrice', 'purchasePriceSnapshot',
    'costBasis', 'margin', 'position', 'lotId', 'stockStatus', 'quantity'],
  status: ['sentAt', 'offerNumber', 'invoiceId', 'total', ...LEDGER],
  convert: ['invoiceId', 'invoiceNumber', 'grossAmount', 'netAmount', 'vatAmount', 'vatRate', 'purchasePrice',
    'purchasePriceSnapshot', 'costBasis', 'margin', 'marginSnapshot', 'lotId', 'lines', 'quantity', 'numbering',
    'allowWithAgent', 'issuedAt', 'paidAmount', 'customerId', ...LEDGER],
} as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], computed: readonly string[], forbidden: readonly string[] = FORBIDDEN): Record<string, unknown> {
  if (!isPlain(raw)) throw new OfferPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (forbidden.includes(k) || computed.includes(k)) throw new OfferPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new OfferPayloadError(`unknown field: ${k}`);
  }
  return raw;
}

/** Jede Position einzeln so streng wie der Kopf. Beim Speichern darf sie ihre Kennung nennen. */
function strictLines(raw: unknown, withIds: boolean): void {
  if (!Array.isArray(raw)) return;   // die Eingaberegel sagt dazu mit IHREM Code nein
  if (raw.length > MAX_LINES) throw new OfferPayloadError(`at most ${MAX_LINES} lines`);
  const forbidden = FORBIDDEN.filter((k) => !(withIds && k === 'id'));
  const allowed = withIds ? ['id', 'productId', 'unitPrice', 'taxScheme'] : ['productId', 'unitPrice', 'taxScheme'];
  raw.forEach((l, i) => {
    try { strict(l, allowed, OFFER_COMPUTED.line, forbidden); } catch (e) {
      throw new OfferPayloadError(`line ${i + 1}: ${(e as Error).message}`);
    }
  });
}

/** Die Eingaberegel als Prüfung des Rumpfs: ihr Nein kommt mit IHREM Code zurück — derselbe wie am Primary. */
function rule<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof OfferRejected) throw new OfferPayloadError(e.message, e.code);
    throw e;
  }
}

/** Dieselbe Folge INNERHALB des Auftrags: dort ist ihr Nein ein eingefrorenes Urteil. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof OfferRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new OfferPayloadError('expectedRevision is required — a change to an offer must say which revision it saw');
  }
  return v;
}

/** Im Namen des geprüften Absenders — nie der Anmeldung des Primary. */
const ctxOf = (identity: CommandIdentity): OfferCtx => ({ branchId: identity.branchId, userId: identity.userId });

// ── Die Rümpfe ──────────────────────────────────────────────────────────────

export function parseOfferCreate(raw: unknown): OfferCreateInput {
  const r = strict(raw, ['customerId', 'lines', 'notes', 'validUntil'], OFFER_COMPUTED.offer);
  strictLines(r.lines, false);
  return rule(() => offerCreateInput(r));
}

export function parseOfferUpdate(raw: unknown): OfferUpdateInput & { expectedRevision: number } {
  const r = strict(raw, ['offerId', 'expectedRevision', 'notes', 'validUntil', 'customerId', 'lines'], OFFER_COMPUTED.offer);
  strictLines(r.lines, true);
  const expectedRevision = revisionOf(r.expectedRevision);
  return { ...rule(() => offerUpdateInput(r)), expectedRevision };
}

export function parseOfferStatus(raw: unknown): OfferStatusInput & { expectedRevision: number } {
  // Hier ist der Status der Wunsch selbst — geprüft gegen die drei Ziele der Knöpfe.
  const r = strict(raw, ['offerId', 'expectedRevision', 'status', 'sentVia'], OFFER_COMPUTED.status, FORBIDDEN.filter((k) => k !== 'status'));
  const expectedRevision = revisionOf(r.expectedRevision);
  return { ...rule(() => offerStatusInput(r)), expectedRevision };
}

export function parseOfferConvert(raw: unknown): OfferConvertInput & { expectedRevision: number } {
  const r = strict(raw, ['offerId', 'expectedRevision', 'perLineSchemes', 'staffId', 'specialMark'], OFFER_COMPUTED.convert);
  if (isPlain(r.perLineSchemes) && Object.keys(r.perLineSchemes).length > MAX_LINES) {
    throw new OfferPayloadError(`at most ${MAX_LINES} lines`);
  }
  const expectedRevision = revisionOf(r.expectedRevision);
  return { ...rule(() => offerConvertInput(r)), expectedRevision };
}

// ── Die Läufe ───────────────────────────────────────────────────────────────

export function offerDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runOfferCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseOfferCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => createOfferInHouse(input, ctxOf(identity)));
    return { offerId: r.offerId, offerNumber: r.offerNumber, revision: r.revision, total: r.total };
  });
}

export function runOfferUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseOfferUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => updateOfferInHouse(input, ctxOf(identity)));
    return { offerId: r.offerId, revision: r.revision, total: r.total, changed: r.changed };
  });
}

export function runOfferStatus(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseOfferStatus(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => setOfferStatusInHouse(input, ctxOf(identity)));
    return { offerId: r.offerId, status: r.status, revision: r.revision, ...(r.sentAt ? { sentAt: r.sentAt } : {}) };
  });
}

export function runOfferConvert(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseOfferConvert(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => convertOfferToInvoiceInHouse(input, ctxOf(identity)));
    return {
      invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, grossAmount: r.grossAmount,
      status: r.status, offerRevision: r.offerRevision,
    };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(offerDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof OfferPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_OFFERS_CREATE, { kind: 'mutation', handler: (p, a) => execute(runOfferCreate, OP_OFFERS_CREATE, p, a) });
registerCommand(OP_OFFERS_UPDATE, { kind: 'mutation', handler: (p, a) => execute(runOfferUpdate, OP_OFFERS_UPDATE, p, a) });
registerCommand(OP_OFFERS_SET_STATUS, { kind: 'mutation', handler: (p, a) => execute(runOfferStatus, OP_OFFERS_SET_STATUS, p, a) });
registerCommand(OP_OFFERS_CONVERT_TO_INVOICE, { kind: 'mutation', handler: (p, a) => execute(runOfferConvert, OP_OFFERS_CONVERT_TO_INVOICE, p, a) });
