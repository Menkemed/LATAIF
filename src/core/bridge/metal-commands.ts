// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Edelmetall und Altgold vom zweiten Rechner, ausschließlich über den Primary.
//
// Sechs Absichten, jede ruft DIESELBE Hausfolge wie die Maske des Primary (`core/metals/…-house`):
//
//   metals.create           — „Add Item": Zeile + Goldbewegung + Lieferantenschuld + Buchung + Verknüpfung
//   metals.update_status    — „Mark Sold" / „Confirm Melt", nur von „am Lager", mit gesehener Fassung
//   metals.set_spot_price   — der Spotpreis je Gramm einer Metallart (Filialeinstellung)
//   scrap_trades.create     — „Save Trade"
//   scrap_trades.update     — „Save Changes", gegen die gesehene Fassung (`version`)
//   scrap_trades.cancel     — „Yes, Cancel Trade": Umkehrbuchungen und Status in EINER Transaktion
//
// Was ein Client NIE vorgibt: Kennung, Filiale, Benutzer, Zeitstempel, Status (außer als Ziel von
// update_status), Fassung (außer der gesehenen), Spotpreis, Schmelzwert, Belegnummer, Summen,
// Gewinn, Buchungskonten. Ein unbekanntes Feld wird abgewiesen statt ignoriert. Fotos reisen als
// Kennungen der vorhandenen Zwischenablage (R5B), nie als Bytes im Auftrag.
// ════════════════════════════════════════════════════════════════════════════
import { resolveScrapPhotoSlots, type PhotoSlotRequest } from '@/core/metals/scrap-media';
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import {
  assertHouseBranch, discardStagedAfterSuccess, invokeDiscardStaged, invokeReadStagedRecord, parseStagingIds,
  readStagedAsRecordImages, stagingOwnerOf, type StagedMediaDiscard, type StagedMediaReader,
} from './remote-create-support';
import {
  METAL_CREATE_FIELDS, METAL_PAYMENT_METHODS, MetalRejected, changeMetalStatusInHouse, createMetalInHouse, setSpotPriceInHouse,
  type MetalCreateInput, type MetalPaymentMethod,
} from '@/core/metals/metal-house';
import {
  SCRAP_MAX_PHOTOS, ScrapRejected, cancelScrapTradeInHouse, createScrapTradeInHouse, updateScrapTradeInHouse,
  type ScrapTradeInput, type ScrapTradeLineInput, type ScrapTradePaymentInput,
} from '@/core/metals/scrap-house';

export const OP_METALS_CREATE = 'metals.create';
export const OP_METALS_UPDATE_STATUS = 'metals.update_status';
export const OP_METALS_SET_SPOT_PRICE = 'metals.set_spot_price';
export const OP_SCRAP_TRADES_CREATE = 'scrap_trades.create';
export const OP_SCRAP_TRADES_UPDATE = 'scrap_trades.update';
export const OP_SCRAP_TRADES_CANCEL = 'scrap_trades.cancel';

export const METAL_SCRAP_OPS = [
  OP_METALS_CREATE, OP_METALS_UPDATE_STATUS, OP_METALS_SET_SPOT_PRICE,
  OP_SCRAP_TRADES_CREATE, OP_SCRAP_TRADES_UPDATE, OP_SCRAP_TRADES_CANCEL,
] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class MetalPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'METAL_PAYLOAD_INVALID') {
    super(message);
    this.name = 'MetalPayloadError';
    this.code = code;
  }
}

/** Wer, wo, wann, welche Kennung, welcher Zustand — nie vom Client. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'version', 'status'];
/** Was das Metallhaus selbst ableitet oder führt. */
export const METAL_DERIVED = [
  'spotPriceAtPurchase', 'currentSpotPrice', 'meltValue', 'spotPrice', 'spot', 'purity',
  'linkedExpenseId', 'expenseId', 'paidAmount', 'paymentStatus', 'salePrice', 'customerId', 'images',
  'ledger', 'entries', 'account', 'debit', 'credit', 'transactionId', 'goldMovementId',
];
/** Was der Altgoldhandel selbst ableitet oder führt. */
export const SCRAP_DERIVED = [
  'tradeNumber', 'weightGrams', 'karat', 'purchasePrice', 'salePrice', 'profit',
  'paymentMethodPurchase', 'paymentMethodSale', 'syncStatus', 'imagesPurchase', 'imagesSale',
  'ledger', 'entries', 'account', 'debit', 'credit', 'transactionId',
];

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], forbidden: readonly string[], what = 'payload'): Record<string, unknown> {
  if (!isPlain(raw)) throw new MetalPayloadError(`${what} must be an object`);
  for (const k of Object.keys(raw)) {
    if (allowed.includes(k)) continue;
    if (k === 'imagesPurchase' || k === 'imagesSale') {
      throw new MetalPayloadError('photos travel as a plan (purchasePhotos / salePhotos), never inside the order');
    }
    if (forbidden.includes(k)) throw new MetalPayloadError(`the primary decides ${k}, not the client`);
    throw new MetalPayloadError(`unknown field: ${k}`);
  }
  return raw;
}

function reqId(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new MetalPayloadError(`${name} is required`);
  return v;
}

function optStr(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new MetalPayloadError(`${name} must be text`);
  return v;
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new MetalPayloadError(`${name} must be a number`);
  return v;
}

function optNum(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  return num(v, name);
}

function seenRevision(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new MetalPayloadError(`${name} is required — say which state of the record you saw`);
  }
  return v;
}

const without = (list: readonly string[], ...drop: string[]): string[] => list.filter((k) => !drop.includes(k));

// ── Edelmetall ─────────────────────────────────────────────────────────────

/** Die Form prüfen; die Regeln (Feinheit zur Metallart, Gewicht > 0, Beträge ≥ 0) prüft das Haus. */
export function parseMetalCreate(raw: unknown): Partial<MetalCreateInput> {
  const r = strict(raw, METAL_CREATE_FIELDS, [...FORBIDDEN, ...METAL_DERIVED]);
  return {
    metalType: optStr(r.metalType, 'metalType') as MetalCreateInput['metalType'],
    karat: optStr(r.karat, 'karat') as MetalCreateInput['karat'],
    weightGrams: num(r.weightGrams, 'weightGrams'),
    purchaseTotal: optNum(r.purchaseTotal, 'purchaseTotal'),
    purchasePricePerGram: optNum(r.purchasePricePerGram, 'purchasePricePerGram'),
    supplierId: optStr(r.supplierId, 'supplierId'),
    supplierName: optStr(r.supplierName, 'supplierName'),
    description: optStr(r.description, 'description'),
    notes: optStr(r.notes, 'notes'),
  };
}

export interface MetalStatusRequest {
  metalId: string; expectedRevision: number; status: 'sold' | 'melted'; salePrice?: number; paymentMethod?: MetalPaymentMethod;
}

export function parseMetalStatus(raw: unknown): MetalStatusRequest {
  const r = strict(raw, ['metalId', 'expectedRevision', 'status', 'salePrice', 'paymentMethod'],
    [...without(FORBIDDEN, 'status'), ...without(METAL_DERIVED, 'salePrice')]);
  const status = r.status;
  if (status !== 'sold' && status !== 'melted') throw new MetalPayloadError('status is sold or melted');
  const salePrice = optNum(r.salePrice, 'salePrice');
  if (status === 'sold' && salePrice === undefined) throw new MetalPayloadError('a sale needs its sale price');
  if (status === 'melted' && salePrice !== undefined) throw new MetalPayloadError('melting takes no sale price');
  // Der Zahlweg ist eine Eingabe des Menschen; ob er nötig ist (Preis > 0), entscheidet das Haus.
  let paymentMethod: MetalPaymentMethod | undefined;
  if (r.paymentMethod !== undefined) {
    if (status !== 'sold') throw new MetalPayloadError('melting takes no payment method');
    if (typeof r.paymentMethod !== 'string' || !(METAL_PAYMENT_METHODS as readonly string[]).includes(r.paymentMethod)) {
      throw new MetalPayloadError(`paymentMethod is one of ${METAL_PAYMENT_METHODS.join(', ')}`);
    }
    paymentMethod = r.paymentMethod as MetalPaymentMethod;
  }
  return { metalId: reqId(r.metalId, 'metalId'), expectedRevision: seenRevision(r.expectedRevision, 'expectedRevision'), status, salePrice, paymentMethod };
}

export function parseSpotPrice(raw: unknown): { metalType: string; price: number } {
  const r = strict(raw, ['metalType', 'price'], [...FORBIDDEN, ...METAL_DERIVED]);
  return { metalType: reqId(r.metalType, 'metalType'), price: num(r.price, 'price') };
}

// ── Altgold ────────────────────────────────────────────────────────────────

const SCRAP_FIELDS = [
  'sellerName', 'sellerPhone', 'sellerCustomerId', 'buyerName', 'buyerPhone', 'buyerSupplierId',
  'tradeDate', 'notes', 'lines', 'paymentsOut', 'paymentsIn',
] as const;
// MEDIA-SCRAP — statt zweier Listen von Ablagekennungen reist je Seite ein PLAN: was bleibt
// (`{keep: <Medienkennung>}`) und was neu ist (`{stagingId: <Inhaltskennung>}`), in der Reihenfolge
// der Maske. Ein schon gespeichertes Foto noch einmal hochzuladen wäre Arbeit für nichts.
// `lineKey` ist die bleibende Kennung der Position — ohne sie fände der Primary nach dem Ersetzen
// der Zeilen nicht mehr, welches Foto zu welchem Goldstück gehört.
const LINE_FIELDS = ['lineKey', 'weightGrams', 'karat', 'purchasePrice', 'salePrice', 'notes', 'purchasePhotos', 'salePhotos'];
const LINE_FORBIDDEN = ['id', 'scrapTradeId', 'position', 'profit', 'createdAt'];
const PAYMENT_FIELDS = ['method', 'amount'];
const PAYMENT_FORBIDDEN = ['id', 'scrapTradeId', 'direction', 'position', 'account', 'createdAt'];

/** Ein Platz in der Galerie einer Seite: ein bestehendes Medium behalten ODER eine neue Aufnahme. */
export type ScrapPhotoPlanSlot = { keep: string } | { stagingId: string };

/** Die Eingabe ohne Fotos, dazu je Zeile der Plan beider Seiten. */
export interface ScrapRequest { input: ScrapTradeInput; staged: Array<{ purchase: ScrapPhotoPlanSlot[]; sale: ScrapPhotoPlanSlot[] }> }

function planList(v: unknown, what: string): ScrapPhotoPlanSlot[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new MetalPayloadError(`${what}: must be a list`);
  if (v.length > SCRAP_MAX_PHOTOS) throw new MetalPayloadError(`${what}: at most ${SCRAP_MAX_PHOTOS} photos`);
  return v.map((slot) => {
    if (slot && typeof slot === 'object' && !Array.isArray(slot)) {
      const keys = Object.keys(slot as Record<string, unknown>);
      const s = slot as Record<string, unknown>;
      if (keys.length === 1 && keys[0] === 'stagingId') {
        const [id] = parseStagingIds([s.stagingId], (m) => new MetalPayloadError(`${what}: ${m}`));
        return { stagingId: id };
      }
      if (keys.length === 1 && keys[0] === 'keep' && typeof s.keep === 'string' && s.keep.startsWith('media-')) {
        return { keep: s.keep };
      }
    }
    throw new MetalPayloadError(`${what}: a photo is { keep: <media id> } or { stagingId: <content hash> }`);
  });
}

function parseScrapFields(r: Record<string, unknown>): ScrapRequest {
  if (!Array.isArray(r.lines)) throw new MetalPayloadError('lines must be a list');
  if (!Array.isArray(r.paymentsOut) || !Array.isArray(r.paymentsIn)) throw new MetalPayloadError('paymentsOut and paymentsIn must be lists');
  const staged: ScrapRequest['staged'] = [];
  const lines: ScrapTradeLineInput[] = r.lines.map((raw, i) => {
    const l = strict(raw, LINE_FIELDS, LINE_FORBIDDEN, `item ${i + 1}`);
    staged.push({
      purchase: planList(l.purchasePhotos, `item ${i + 1} purchase photos`),
      sale: planList(l.salePhotos, `item ${i + 1} sale photos`),
    });
    return {
      lineKey: optStr(l.lineKey, `item ${i + 1} lineKey`),
      weightGrams: num(l.weightGrams, `item ${i + 1} weightGrams`),
      karat: optStr(l.karat, `item ${i + 1} karat`) ?? '',
      purchasePrice: num(l.purchasePrice, `item ${i + 1} purchasePrice`),
      salePrice: num(l.salePrice, `item ${i + 1} salePrice`),
      notes: optStr(l.notes, `item ${i + 1} notes`),
    };
  });
  const payments = (list: unknown[], what: string): ScrapTradePaymentInput[] => list.map((raw, i) => {
    const p = strict(raw, PAYMENT_FIELDS, PAYMENT_FORBIDDEN, `${what} ${i + 1}`);
    return { method: optStr(p.method, `${what} method`) as ScrapTradePaymentInput['method'], amount: num(p.amount, `${what} amount`) };
  });
  return {
    input: {
      sellerName: optStr(r.sellerName, 'sellerName') ?? '',
      sellerPhone: optStr(r.sellerPhone, 'sellerPhone'),
      sellerCustomerId: optStr(r.sellerCustomerId, 'sellerCustomerId'),
      buyerName: optStr(r.buyerName, 'buyerName') ?? '',
      buyerPhone: optStr(r.buyerPhone, 'buyerPhone'),
      buyerSupplierId: optStr(r.buyerSupplierId, 'buyerSupplierId'),
      tradeDate: optStr(r.tradeDate, 'tradeDate') ?? '',
      notes: optStr(r.notes, 'notes'),
      lines,
      paymentsOut: payments(r.paymentsOut, 'payment out'),
      paymentsIn: payments(r.paymentsIn, 'payment in'),
    },
    staged,
  };
}

export function parseScrapCreate(raw: unknown): ScrapRequest {
  return parseScrapFields(strict(raw, SCRAP_FIELDS, [...FORBIDDEN, ...SCRAP_DERIVED]));
}

export function parseScrapUpdate(raw: unknown): ScrapRequest & { tradeId: string; expectedVersion: number } {
  const r = strict(raw, ['tradeId', 'expectedVersion', ...SCRAP_FIELDS], [...FORBIDDEN, ...SCRAP_DERIVED]);
  return { ...parseScrapFields(r), tradeId: reqId(r.tradeId, 'tradeId'), expectedVersion: seenRevision(r.expectedVersion, 'expectedVersion') };
}

export function parseScrapCancel(raw: unknown): { tradeId: string; expectedVersion: number } {
  const r = strict(raw, ['tradeId', 'expectedVersion'], [...FORBIDDEN, ...SCRAP_DERIVED]);
  return { tradeId: reqId(r.tradeId, 'tradeId'), expectedVersion: seenRevision(r.expectedVersion, 'expectedVersion') };
}

// ── Die Läufe ──────────────────────────────────────────────────────────────

export function metalDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

/** Wie die Fotos einer Ablage geholt und danach geräumt werden — für Tests ersetzbar. */
export interface ScrapMedia {
  readStaged?: StagedMediaReader;
  discardStaged?: StagedMediaDiscard;
}

/** Das Nein der Hausfolge wird eingefroren — ein Urteil über GENAU diese Anfrage. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof MetalRejected || e instanceof ScrapRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

export function runMetalCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseMetalCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => createMetalInHouse(input, identity.branchId));
    return {
      metalId: r.metal.id,
      status: r.metal.status,
      revision: r.metal.revision,
      linkedExpenseId: r.linkedExpenseId ?? null,
      spotPriceAtPurchase: r.metal.spotPriceAtPurchase ?? null,
      meltValue: r.metal.meltValue ?? null,
    };
  });
}

export function runMetalStatus(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseMetalStatus(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    return urteil(() => changeMetalStatusInHouse(req, identity.branchId)) as unknown as Record<string, unknown>;
  });
}

export function runSpotPrice(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseSpotPrice(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    return urteil(() => setSpotPriceInHouse(req.metalType, req.price, identity.branchId));
  });
}

/**
 * Die Fotos aus der Ablage holen — INNERHALB des Auftrags, als Eigentümer die geprüfte Identität.
 * POST-PARITY R7B PP-12 — der Standardleser gibt ein Foto so heraus, wie es gespeichert wird
 * (≤ 100 000 B). Beim Ändern legt PC2 auch die schon gespeicherten Fotos neu ab; dieselben Bytes
 * tragen dieselbe Kennung (ihren SHA-256) — ein solches Foto bleibt die gespeicherte Fassung und
 * wird nicht ein zweites Mal gerechnet.
 */
async function withPhotos(req: ScrapRequest, identity: CommandIdentity, media: ScrapMedia, tradeId?: string): Promise<ScrapTradeInput> {
  const read = media.readStaged ?? invokeReadStagedRecord;
  const owner = stagingOwnerOf(identity);
  const fail = (m: string) => new MetalPayloadError(m, 'STAGED_IMAGE_GONE');
  // MEDIA-SCRAP — aus dem Plan werden MEDIENKENNUNGEN: neue Bytes aus der Ablage werden
  // aufgenommen (geprüft, normalisiert, veröffentlicht), behaltene Kennungen bleiben stehen.
  const seite = async (plan: readonly ScrapPhotoPlanSlot[], side: 'purchase' | 'sale'): Promise<string[]> => {
    const slots: PhotoSlotRequest[] = [];
    for (const s of plan) {
      if ('keep' in s) { slots.push({ keep: s.keep }); continue; }
      const [url] = await readStagedAsRecordImages([s.stagingId], owner, read, fail);
      slots.push({ dataUrl: url });
    }
    return resolveScrapPhotoSlots(slots, side, undefined, tradeId);
  };
  const lines: ScrapTradeLineInput[] = [];
  for (let i = 0; i < req.input.lines.length; i++) {
    const s = req.staged[i];
    lines.push({ ...req.input.lines[i], imagesPurchase: await seite(s.purchase, 'purchase'), imagesSale: await seite(s.sale, 'sale') });
  }
  return { ...req.input, lines };
}

const allStaged = (req: ScrapRequest): string[] => [...new Set(
  req.staged.flatMap((s) => [...s.purchase, ...s.sale]).flatMap((x) => ('stagingId' in x ? [x.stagingId] : [])),
)];

export async function runScrapCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown, media: ScrapMedia = {}): Promise<CommandOutcome> {
  const req = parseScrapCreate(raw);
  // MEDIA-SCRAP — aufnehmen VOR der Klammer (eigene durable Haltepunkte); ein Nein wird
  // mitgenommen, damit eine Wiederholung die eingefrorene Antwort bekommt und keinen neuen Fehler.
  let vorbereitet: ScrapTradeInput | null = null;
  let fotoFehler: unknown = null;
  try { vorbereitet = await withPhotos(req, identity, media); } catch (e) { fotoFehler = e; }
  const outcome = await runRemoteCommand(deps, identity, async () => {
    if (fotoFehler) throw fotoFehler;
    assertHouseBranch(identity);
    const input = vorbereitet as ScrapTradeInput;
    return urteil(() => createScrapTradeInHouse(input, identity.branchId));
  });
  const staged = allStaged(req);
  if (outcome.kind === 'ok' && staged.length) await discardStagedAfterSuccess(staged, stagingOwnerOf(identity), media.discardStaged ?? invokeDiscardStaged);
  return outcome;
}

export async function runScrapUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown, media: ScrapMedia = {}): Promise<CommandOutcome> {
  const req = parseScrapUpdate(raw);
  let vorbereitet: ScrapTradeInput | null = null;
  let fotoFehler: unknown = null;
  try { vorbereitet = await withPhotos(req, identity, media, req.tradeId); } catch (e) { fotoFehler = e; }
  const outcome = await runRemoteCommand(deps, identity, async () => {
    if (fotoFehler) throw fotoFehler;
    assertHouseBranch(identity);
    const input = vorbereitet as ScrapTradeInput;
    return urteil(() => updateScrapTradeInHouse(req.tradeId, req.expectedVersion, input, identity.branchId));
  });
  const staged = allStaged(req);
  if (outcome.kind === 'ok' && staged.length) await discardStagedAfterSuccess(staged, stagingOwnerOf(identity), media.discardStaged ?? invokeDiscardStaged);
  return outcome;
}

export function runScrapCancel(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseScrapCancel(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    return urteil(() => cancelScrapTradeInHouse(req.tradeId, req.expectedVersion, identity.branchId));
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(metalDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof MetalPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_METALS_CREATE, { kind: 'mutation', handler: (p, a) => execute(runMetalCreate, OP_METALS_CREATE, p, a) });
registerCommand(OP_METALS_UPDATE_STATUS, { kind: 'mutation', handler: (p, a) => execute(runMetalStatus, OP_METALS_UPDATE_STATUS, p, a) });
registerCommand(OP_METALS_SET_SPOT_PRICE, { kind: 'mutation', handler: (p, a) => execute(runSpotPrice, OP_METALS_SET_SPOT_PRICE, p, a) });
registerCommand(OP_SCRAP_TRADES_CREATE, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runScrapCreate(d, i, r), OP_SCRAP_TRADES_CREATE, p, a) });
registerCommand(OP_SCRAP_TRADES_UPDATE, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runScrapUpdate(d, i, r), OP_SCRAP_TRADES_UPDATE, p, a) });
registerCommand(OP_SCRAP_TRADES_CANCEL, { kind: 'mutation', handler: (p, a) => execute(runScrapCancel, OP_SCRAP_TRADES_CANCEL, p, a) });
