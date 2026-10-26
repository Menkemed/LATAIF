// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT — die Einkaufsbearbeitung vom zweiten Rechner: `purchases.update` (Notiz,
// Mitarbeiter, Ausweisfoto), `purchases.correct` (dazu Datum, Lieferant, Preise, Mengen — nur
// Owner/Admin, D11; v0.8.91 auch Positionen nachtragen und entfernen), `purchases.void_payment` (D14) und die Auskünfte `purchase.edit_check.get`
// (was darf sich ändern, und warum nicht) und `page.cost_corrections.get` (die Überleitungsansicht).
//
// Derselbe Bau wie beim Lebenszyklus (`purchase-lifecycle-commands.ts`):
//  1. Keine zweite Logik: jeder Befehl ruft `editPurchaseInHouse` / `voidPurchasePaymentInHouse`,
//     dieselben Hausfolgen wie die Maske am Primary, in der Transaktion des Auftrags.
//  2. Der Rumpf ist ein Wunsch: welcher Einkauf, welche Fassung, welcher Grund, welche neuen Werte.
//     Summen, Lose, Buchungen, Korrekturen rechnet der Primary; ein unbekanntes Feld wird abgewiesen.
//  3. Ändern braucht die gesehene Fassung (`purchases.revision`), INNERHALB der Transaktion verglichen.
//  4. Das neue Ausweisfoto reist als Ablagekennung (`identityPhotoStagingId`), nie als Bytes; es wird
//     VOR der Klammer aufgenommen (der Ingest hat eigene durable Haltepunkte).
//  5. Teil 2 — ein nachgetragener NEUER Artikel reist wie bei `purchases.create`: sein Entwurf (`parseSpec`) und
//     statt der Fotos ihre Ablagekennungen, gelesen INNERHALB des Auftrags (`mitFotos`), geräumt erst nach Erfolg.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { remoteReadContext } from '@/core/data/read-context';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor, type CommandResult } from './command-registry';
import {
  assertHouseBranch, discardStagedAfterSuccess, invokeDiscardStaged, invokeReadStagedRecord, isStagingId,
  readStagedAsRecordImages, stagingOwnerOf, type StagedMediaDiscard, type StagedMediaReader,
} from './remote-create-support';
import { ingestIdentityPhoto, identitySourceOf } from '@/core/identity/identity-media';
import {
  MAX_ADD_LINES, PURCHASE_EDIT_OP, PURCHASE_EDIT_CHECK_OP, PurchaseEditRejected, editPurchaseInHouse, isCorrectionKind,
  purchaseEditCheck, voidPurchasePaymentInHouse, type PurchaseEditAddLine, type PurchaseEditRequest,
} from '@/core/purchases/purchase-edit-house';
import { costCorrectionBridge, costCorrectionRows } from '@/core/purchases/cost-correction-read';
import { PURCHASE_LINE_OPS } from '@/core/purchases/purchase-lines';
import { EMBEDDED_PRODUCT_FIELDS } from '@/core/products/embedded-product';
import type { Product } from '@/core/models/types';
import { CommercialPayloadError, mitFotos, parseSpec } from './commercial-commands';
import { OP_PAGE_COST_CORRECTIONS_GET, OP_PURCHASE_EDIT_CHECK_GET } from './store-read-ops';

export const OP_PURCHASES_UPDATE = PURCHASE_EDIT_OP.UPDATE;
export const OP_PURCHASES_CORRECT = PURCHASE_EDIT_OP.CORRECT;
export const OP_PURCHASES_VOID_PAYMENT = PURCHASE_EDIT_OP.VOID_PAYMENT;
export { OP_PURCHASE_EDIT_CHECK_GET, OP_PAGE_COST_CORRECTIONS_GET };
// Die Auskunft heißt im Haus und in der Zulassungsliste gleich — sonst fände die Maske ihren Namen nicht.
if (PURCHASE_EDIT_CHECK_OP !== OP_PURCHASE_EDIT_CHECK_GET) throw new Error('purchase edit check op drifted');

export const PURCHASE_EDIT_OPS = [OP_PURCHASES_UPDATE, OP_PURCHASES_CORRECT, OP_PURCHASES_VOID_PAYMENT] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. */
export class PurchaseEditPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PURCHASE_PAYLOAD_INVALID') {
    super(message);
    this.name = 'PurchaseEditPayloadError';
    this.code = code;
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Was der Client nie setzt — und was nur der Primary rechnet. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'actor', 'role', 'createdAt', 'updatedAt', 'revision',
  'status', 'totalAmount', 'paidAmount', 'remainingAmount', 'purchaseNumber', 'supplierSnapshot', 'identity', 'identityRetired',
  'lots', 'ledger', 'entries', 'corrections', 'costCorrections', 'lineTotal', 'vatAmount', 'taxScheme', 'productId'];

const A_FIELDS = ['purchaseId', 'expectedRevision', 'reason', 'notes', 'staffId', 'identityPhotoStagingId', 'alsoUpdatePerson'];
const C_FIELDS = [...A_FIELDS, 'purchaseDate', 'supplierId', 'confirmPaymentsToNewSupplier', 'lines', 'correctionKind', 'addLines', 'removeLineIds'];
/** Teil 2 — eine nachgetragene Position: genau die Eingaben der Maske; Summe, Vorsteuer, Los und SKU rechnet der Primary. */
const ADD_LINE_FIELDS = ['mode', 'productId', 'newProduct', 'quantity', 'unitPrice'];

function strict(raw: unknown, allowed: readonly string[], what = 'payload'): Record<string, unknown> {
  if (!isPlain(raw)) throw new PurchaseEditPayloadError(`${what} must be an object`);
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k)) throw new PurchaseEditPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new PurchaseEditPayloadError(`unknown field: ${k}`);
  }
  return raw;
}

function idOf(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new PurchaseEditPayloadError(`${name} is required`);
  return v.trim();
}

function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new PurchaseEditPayloadError('expectedRevision is required — a change to a purchase must say which revision it saw');
  }
  return v;
}

function reasonOf(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new PurchaseEditPayloadError('Please enter a reason for this edit.', 'PURCHASE_EDIT_REASON_REQUIRED');
  return v.trim();
}

const textOrNull = (v: unknown, name: string): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new PurchaseEditPayloadError(`${name} must be text`);
  return v;
};

export interface PurchaseEditCommand {
  request: Omit<PurchaseEditRequest, 'identityPhoto'>;
  expectedRevision: number;
  identityPhotoStagingId?: string;
  alsoUpdatePerson?: boolean;
  /** Teil 2 — je nachgetragener Position der Artikel-Entwurf mit den Kennungen seiner Fotos (oder nichts). */
  addSpecs?: Array<{ spec: Partial<Product>; stagingIds?: string[] } | undefined>;
}

/** Teil 2 — die nachgetragenen Positionen aus dem Rumpf. */
function parseAddLines(v: unknown): { lines: PurchaseEditAddLine[]; specs: Array<{ spec: Partial<Product>; stagingIds?: string[] } | undefined> } {
  if (!Array.isArray(v)) throw new PurchaseEditPayloadError('addLines must be a list');
  if (v.length > MAX_ADD_LINES) throw new PurchaseEditPayloadError('too many new lines');
  const specs: Array<{ spec: Partial<Product>; stagingIds?: string[] } | undefined> = [];
  const lines = v.map((raw, i): PurchaseEditAddLine => {
    if (!isPlain(raw)) throw new PurchaseEditPayloadError(`new line ${i + 1} must be an object`);
    for (const k of Object.keys(raw)) {
      if (!ADD_LINE_FIELDS.includes(k)) throw new PurchaseEditPayloadError(`new line ${i + 1}: unknown field: ${k}`);
    }
    if (raw.mode !== 'existing' && raw.mode !== 'new') throw new PurchaseEditPayloadError(`new line ${i + 1}: mode is existing or new`);
    if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity)) throw new PurchaseEditPayloadError(`new line ${i + 1}: quantity must be a number`);
    if (typeof raw.unitPrice !== 'number' || !Number.isFinite(raw.unitPrice)) throw new PurchaseEditPayloadError(`new line ${i + 1}: unitPrice must be a number`);
    let spec: { spec: Partial<Product>; stagingIds?: string[] } | undefined;
    try { spec = parseSpec(raw.newProduct, EMBEDDED_PRODUCT_FIELDS, `new line ${i + 1}: newProduct`); } catch (e) {
      if (e instanceof CommercialPayloadError) throw new PurchaseEditPayloadError(e.message);
      throw e;
    }
    specs.push(spec);
    return {
      mode: raw.mode,
      ...(raw.productId !== undefined ? { productId: idOf(raw.productId, `new line ${i + 1}: productId`) } : {}),
      ...(spec ? { newProduct: spec.spec } : {}),
      quantity: raw.quantity, unitPrice: raw.unitPrice,
    };
  });
  return { lines, specs };
}

/** `purchases.update` (A/B) oder `purchases.correct` (alles) — `financial` entscheidet, was erlaubt ist. */
export function parsePurchaseEdit(raw: unknown, financial: boolean): PurchaseEditCommand {
  const r = strict(raw, financial ? C_FIELDS : A_FIELDS);
  const out: PurchaseEditCommand = {
    request: { purchaseId: idOf(r.purchaseId, 'purchaseId'), reason: reasonOf(r.reason) },
    expectedRevision: revisionOf(r.expectedRevision),
  };
  const notes = textOrNull(r.notes, 'notes');
  if (notes !== undefined) out.request.notes = notes;
  const staffId = textOrNull(r.staffId, 'staffId');
  if (staffId !== undefined) out.request.staffId = staffId;
  if (r.identityPhotoStagingId !== undefined) {
    if (!isStagingId(r.identityPhotoStagingId)) throw new PurchaseEditPayloadError('a staged ID photo is named by its content hash');
    out.identityPhotoStagingId = String(r.identityPhotoStagingId);
    out.alsoUpdatePerson = r.alsoUpdatePerson === true;
  } else if (r.alsoUpdatePerson !== undefined) {
    throw new PurchaseEditPayloadError('alsoUpdatePerson belongs to a new ID photo');
  }
  if (financial) {
    if (r.purchaseDate !== undefined) {
      if (typeof r.purchaseDate !== 'string') throw new PurchaseEditPayloadError('purchaseDate must be a date (YYYY-MM-DD)');
      out.request.purchaseDate = r.purchaseDate;
    }
    if (r.supplierId !== undefined) out.request.supplierId = idOf(r.supplierId, 'supplierId');
    if (r.confirmPaymentsToNewSupplier !== undefined) out.request.confirmPaymentsToNewSupplier = r.confirmPaymentsToNewSupplier === true;
    if (r.correctionKind !== undefined) {
      if (!isCorrectionKind(r.correctionKind)) throw new PurchaseEditPayloadError('correctionKind is ENTRY_ERROR or SUPPLIER_DISCOUNT');
      out.request.correctionKind = r.correctionKind;
    }
    if (r.lines !== undefined) {
      if (!Array.isArray(r.lines)) throw new PurchaseEditPayloadError('lines must be a list');
      if (r.lines.length > 200) throw new PurchaseEditPayloadError('too many lines');
      out.request.lines = r.lines.map((raw) => {
        const l = strict(raw, ['lineId', 'unitPrice', 'quantity'], 'a line');
        const line: { lineId: string; unitPrice?: number; quantity?: number } = { lineId: idOf(l.lineId, 'lineId') };
        if (l.unitPrice !== undefined) {
          if (typeof l.unitPrice !== 'number' || !Number.isFinite(l.unitPrice)) throw new PurchaseEditPayloadError('unitPrice must be a number');
          line.unitPrice = l.unitPrice;
        }
        if (l.quantity !== undefined) {
          if (typeof l.quantity !== 'number' || !Number.isFinite(l.quantity)) throw new PurchaseEditPayloadError('quantity must be a number');
          line.quantity = l.quantity;
        }
        return line;
      });
    }
    if (r.removeLineIds !== undefined) {
      if (!Array.isArray(r.removeLineIds)) throw new PurchaseEditPayloadError('removeLineIds must be a list');
      if (r.removeLineIds.length > 200) throw new PurchaseEditPayloadError('too many lines');
      out.request.removeLineIds = r.removeLineIds.map((x) => idOf(x, 'removeLineIds'));
    }
    if (r.addLines !== undefined) {
      const add = parseAddLines(r.addLines);
      out.request.addLines = add.lines;
      out.addSpecs = add.specs;
    }
  }
  return out;
}

export interface PurchaseVoidPaymentCommand { purchaseId: string; paymentId: string; expectedRevision: number; reason: string }

export function parsePurchaseVoidPayment(raw: unknown): PurchaseVoidPaymentCommand {
  const r = strict(raw, ['purchaseId', 'paymentId', 'expectedRevision', 'reason']);
  return {
    purchaseId: idOf(r.purchaseId, 'purchaseId'), paymentId: idOf(r.paymentId, 'paymentId'),
    expectedRevision: revisionOf(r.expectedRevision), reason: reasonOf(r.reason),
  };
}

/** Ein Nein der Hausfolge INNERHALB des Auftrags ist ein eingefrorenes Urteil; alles andere eine Störung. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PurchaseEditRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

export function purchaseEditDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

/** Nur für Tests: die Zwischenablage ohne Tauri. Voreingestellt sind die echten Aufrufe. */
export interface PurchaseEditMedia { readStaged?: StagedMediaReader; discardStaged?: StagedMediaDiscard }

export async function runPurchaseEdit(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, financial: boolean, media: PurchaseEditMedia = {},
): Promise<CommandOutcome> {
  const req = parsePurchaseEdit(raw, financial);
  const staged = req.identityPhotoStagingId ? [req.identityPhotoStagingId] : [];
  // Teil 2 — die Fotos nachgetragener neuer Artikel: gelesen IN der Klammer, geräumt erst nach Erfolg (wie `purchases.create`).
  const addStaged = (req.addSpecs ?? []).flatMap((x) => x?.stagingIds ?? []);
  const read = media.readStaged ?? invokeReadStagedRecord;
  // Das neue Foto VOR der Klammer aufnehmen — im Bereich der Person, der das Dokument gehört (beim
  // neuen Lieferanten der neue). Ein Nein wird mitgenommen: die Wiederholung desselben Auftrags (die
  // Ablage ist dann geräumt) muss die eingefrorene Antwort bekommen, nicht einen neuen Fehler.
  let mediaId: string | null = null;
  let fotoFehler: unknown = null;
  if (staged.length) {
    try {
      const sid = req.request.supplierId
        ?? String(query('SELECT supplier_id FROM purchases WHERE id = ? AND branch_id = ?', [req.request.purchaseId, identity.branchId])[0]?.supplier_id ?? '');
      const owner = identitySourceOf('supplier', sid);
      const [img] = await readStagedAsRecordImages(staged, stagingOwnerOf(identity), media.readStaged ?? invokeReadStagedRecord,
        (m) => new PurchaseEditPayloadError(m, 'STAGED_IMAGE_GONE'));
      mediaId = img ? await ingestIdentityPhoto(img, owner.ownerType, { ownerId: owner.ownerId }) : null;
    } catch (e) { fotoFehler = e; }
  }
  const outcome = await runRemoteCommand(deps, identity, async () => {
    if (fotoFehler) throw fotoFehler;
    assertHouseBranch(identity);
    const ctx = { branchId: identity.branchId, userId: identity.userId, now: deps.now() };
    const request: PurchaseEditRequest = { ...req.request };
    if (mediaId) request.identityPhoto = { mediaId, alsoUpdatePerson: req.alsoUpdatePerson === true };
    if (request.addLines && req.addSpecs) {
      const owner = stagingOwnerOf(identity);
      const lines: PurchaseEditAddLine[] = [];
      for (let i = 0; i < request.addLines.length; i++) {
        const spec = req.addSpecs[i];
        lines.push(spec ? { ...request.addLines[i], newProduct: await mitFotos(spec, owner, read) } : request.addLines[i]);
      }
      request.addLines = lines;
    }
    return { ...urteil(() => editPurchaseInHouse(request, ctx, req.expectedRevision, PURCHASE_LINE_OPS)) };
  });
  if (outcome.kind === 'ok' && (staged.length || addStaged.length)) {
    await discardStagedAfterSuccess([...staged, ...addStaged], stagingOwnerOf(identity), media.discardStaged ?? invokeDiscardStaged);
  }
  return outcome;
}

export function runPurchaseVoidPayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parsePurchaseVoidPayment(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const ctx = { branchId: identity.branchId, userId: identity.userId, now: deps.now() };
    return { ...urteil(() => voidPurchasePaymentInHouse(req.purchaseId, req.paymentId, req.reason, ctx, req.expectedRevision)) };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(purchaseEditDeps(), { ...actor, op }, body);
  } catch (err) {
    if (err instanceof PurchaseEditPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_PURCHASES_UPDATE, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runPurchaseEdit(d, i, r, false), OP_PURCHASES_UPDATE, p, a) });
registerCommand(OP_PURCHASES_CORRECT, { kind: 'mutation', handler: (p, a) => execute((d, i, r) => runPurchaseEdit(d, i, r, true), OP_PURCHASES_CORRECT, p, a) });
registerCommand(OP_PURCHASES_VOID_PAYMENT, { kind: 'mutation', handler: (p, a) => execute(runPurchaseVoidPayment, OP_PURCHASES_VOID_PAYMENT, p, a) });

interface Envelope { readonly actor?: { tenantId?: string; branchId?: string; userId?: string; role?: string }; readonly input?: Record<string, unknown> }

// Die Auskunft der Bearbeitungsmaske: dieselben Sperren, die die Hausfolge prüft.
registerCommand(OP_PURCHASE_EDIT_CHECK_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
    const purchaseId = (payload as Envelope | null)?.input?.purchaseId;
    if (typeof purchaseId !== 'string' || purchaseId.trim() === '') throw new BusinessError('INPUT_REQUIRED', 'purchaseId is required');
    try {
      return { data: { ...purchaseEditCheck(purchaseId, ctx.branchId, new Date().toISOString()) } };
    } catch (e) {
      if (e instanceof PurchaseEditRejected) throw new BusinessError(e.code, e.message);
      throw e;
    }
  },
});

// Die Überleitungsansicht der Einstandskorrekturen (D1): jede Korrektur einmal, mit beiden Daten.
registerCommand(OP_PAGE_COST_CORRECTIONS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = remoteReadContext(actor ?? (payload as Envelope | null)?.actor);
    return { data: { rows: costCorrectionRows(ctx.branchId), bridge: costCorrectionBridge(ctx.branchId) } };
  },
});
