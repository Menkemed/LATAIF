// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — ein Fertigungsvorgang vom zweiten Rechner (`production.create`).
//
// Derselbe Bau wie bei Kommission und Einkauf mit neuem Artikel (`commercial-commands.ts`):
//
//  1. **Keine zweite Fertigungslogik.** Der Befehl ruft die Hausfolge, die auch die Maske des
//     Primary ruft (`production-house.ts`): dieselbe Prüfung der Eingänge und Ausgänge, dieselbe
//     Wertgleichheit, dieselben Lose, und für jeden Ausgang derselbe Anlageweg wie jeder Artikel
//     (`createProductWithMedia`) — in der Transaktion des Auftrags.
//  2. **Der Rumpf ist ein Wunsch.** Welche Artikel verbraucht werden, was je Ausgang in der Maske
//     steht, sein Wert, Arbeit, Gemeinkosten, Notiz. Belegnummer, Datum, Summen, Einstand je Eingang,
//     Lose, Bestandsstatus, Herkunft, Menge, Kennungen und der Mensch stehen namentlich auf der
//     Verbotsliste; ein unbekanntes Feld wird abgewiesen statt ignoriert.
//  3. **Fotos nur als Kennung.** Der Client legt sie vorher in `/api/staging/media` ab; der Primary
//     liest die Bytes INNERHALB des Auftrags als der geprüfte Absender und räumt die Ablage erst nach
//     dem Erfolg. Ein Medienausfall ist kein Urteil: nichts bleibt, dieselbe Kennung darf erneut.
//
// Anlegen braucht keine Fassung — die Eingänge werden in der Transaktion gegen ihren WIRKLICHEN
// Stand geprüft („in_stock" in dieser Filiale); ein inzwischen verbrauchter Artikel ist ein Nein.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';
import {
  assertHouseBranch, invokeReadStaged, invokeDiscardStaged, parseStagingIds, readStagedAsDataUrls,
  discardStagedAfterSuccess, stagingOwnerOf, type StagedMediaDiscard, type StagedMediaReader,
} from './remote-create-support';
import {
  createProductionInHouse, completeProductionInHouse, PRODUCTION_OUTPUT_FIELDS, ProductionMediaIncomplete, ProductionRejected,
  type ProductionCreateInput, type ProductionCompleteInput, type ProductionCtx,
} from '@/core/production/production-house';
import { TAX_SCHEMES } from '@/core/models/types';

export const OP_PRODUCTION_CREATE = 'production.create';
/** POST-PARITY R7A (PP-2) — der Fertigungsabschluss: der Rumpf nennt den Beleg und die endgültigen Kosten. */
export const OP_PRODUCTION_COMPLETE = 'production.complete';

/** Eine technische Obergrenze des Rumpfs (dieselbe wie bei Angebot und Auftragsumwandlung) — keine Geschäftsregel. */
const MAX_ITEMS = 500;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class ProductionPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PRODUCTION_PAYLOAD_INVALID') {
    super(message);
    this.name = 'ProductionPayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung, welche Fassung, welcher Zustand. */
const FORBIDDEN = [
  'id', 'branchId', 'tenantId', 'userId', 'createdBy', 'created_by', 'actor', 'createdAt', 'updatedAt',
  'revision', 'status',
];
/** Was das Haus rechnet oder vergibt — Beleg, Datum, Summen, Buchung. */
const COMPUTED = [
  'recordId', 'recordNumber', 'productionDate', 'totalValue', 'totalCost', 'inputValue', 'inputValues',
  'outputValue', 'inputs', 'completedAt', 'ledger', 'entries', 'account', 'debit', 'credit', 'expenseId',
];
/** Was je Ausgang der Vorgang festlegt — die Maske bietet es nicht an. */
const SPEC_DECIDED = [
  'id', 'branchId', 'tenantId', 'userId', 'createdBy', 'created_by', 'actor', 'createdAt', 'updatedAt',
  'stockStatus', 'sourceType', 'purchasePrice', 'purchaseDate', 'purchaseCurrency', 'quantity', 'lotId',
  'images', 'imageHash', 'imageDescription', 'imageEmbedding', 'expectedMargin', 'daysInStock',
  'supplierName', 'paidFrom', 'purchaseSource',
];
const SPEC_TEXT = ['categoryId', 'brand', 'name', 'sku', 'condition', 'taxScheme', 'notes'];
const SPEC_FIELDS = [...PRODUCTION_OUTPUT_FIELDS.filter((f) => f !== 'images'), 'stagingIds'];

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: Record<string, unknown>, allowed: readonly string[], decided: readonly string[], what: string): void {
  for (const k of Object.keys(raw)) {
    if (decided.includes(k)) throw new ProductionPayloadError(`${what}the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new ProductionPayloadError(`${what}unknown field: ${k}`);
  }
}

function amount(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ProductionPayloadError(`${name} must be a number ≥ 0`);
  return v;
}

export interface ProductionCreateRequest {
  input: ProductionCreateInput;
  /** Je Ausgang die Kennungen seiner Fotos in der Zwischenablage (leer = keine Fotos). */
  staging: string[][];
}

export function parseProductionCreate(raw: unknown): ProductionCreateRequest {
  if (!isPlain(raw)) throw new ProductionPayloadError('payload must be an object');
  strict(raw, ['inputProductIds', 'outputs', 'laborCost', 'overheadCost', 'notes'], [...FORBIDDEN, ...COMPUTED], '');

  const ids = raw.inputProductIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new ProductionPayloadError('inputProductIds: select at least one input product');
  if (ids.length > MAX_ITEMS) throw new ProductionPayloadError(`at most ${MAX_ITEMS} input products`);
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) throw new ProductionPayloadError('inputProductIds must be product ids');
  }
  if (new Set(ids as string[]).size !== ids.length) throw new ProductionPayloadError('the same input product twice is not a production');

  const outs = raw.outputs;
  if (!Array.isArray(outs) || outs.length === 0) throw new ProductionPayloadError('outputs: add at least one output product');
  if (outs.length > MAX_ITEMS) throw new ProductionPayloadError(`at most ${MAX_ITEMS} outputs`);
  const staging: string[][] = [];
  const outputs = outs.map((o, i) => {
    const what = `output ${i + 1}: `;
    if (!isPlain(o)) throw new ProductionPayloadError(`${what}must be an object`);
    strict(o, ['spec', 'value'], ['productId', 'outputValue', 'lotId', 'stockStatus', ...FORBIDDEN], what);
    // Der Wert ist eine Eingabe des Menschen (Karte „Value (BHD)") — positiv, wie die Maske verlangt.
    if (typeof o.value !== 'number' || !Number.isFinite(o.value) || !(o.value > 0)) {
      throw new ProductionPayloadError(`${what}value must be a number > 0`);
    }
    const spec = o.spec;
    if (!isPlain(spec)) throw new ProductionPayloadError(`${what}spec must be an object`);
    strict(spec, SPEC_FIELDS, SPEC_DECIDED, what);
    for (const k of SPEC_TEXT) {
      if (spec[k] !== undefined && spec[k] !== null && typeof spec[k] !== 'string') {
        throw new ProductionPayloadError(`${what}${k} must be text`);
      }
    }
    if (spec.attributes !== undefined && spec.attributes !== null && !isPlain(spec.attributes)) {
      throw new ProductionPayloadError(`${what}attributes must be an object`);
    }
    if (spec.scopeOfDelivery !== undefined && spec.scopeOfDelivery !== null
      && (!Array.isArray(spec.scopeOfDelivery) || spec.scopeOfDelivery.some((x) => typeof x !== 'string'))) {
      throw new ProductionPayloadError(`${what}scopeOfDelivery must be a list of words`);
    }
    if (typeof spec.taxScheme === 'string' && !(TAX_SCHEMES as readonly string[]).includes(spec.taxScheme)) {
      throw new ProductionPayloadError(`${what}unknown tax scheme: ${spec.taxScheme}`);
    }
    const { stagingIds, ...fields } = spec;
    // Kein Pfad, kein Dateiname, keine URL — nur ein Inhaltshash; abgewiesen, bevor daraus ein Dateizugriff wird.
    staging.push(parseStagingIds(stagingIds, (m) => new ProductionPayloadError(`${what}${m}`)));
    return { spec: fields, value: o.value };
  });

  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') {
    throw new ProductionPayloadError('notes must be text');
  }
  return {
    input: {
      inputProductIds: ids as string[],
      outputs,
      laborCost: amount(raw.laborCost, 'laborCost'),
      overheadCost: amount(raw.overheadCost, 'overheadCost'),
      notes: (raw.notes as string | undefined) || undefined,
    },
    staging,
  };
}

// ── Der Lauf ────────────────────────────────────────────────────────────────

export interface ProductionEngineExtras {
  readStaged?: StagedMediaReader;
  discardStaged?: StagedMediaDiscard;
}

export function productionDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

/** Im Namen des geprüften Absenders — nie der Anmeldung des Primary. */
const ctxOf = (identity: CommandIdentity): ProductionCtx => ({ branchId: identity.branchId, userId: identity.userId });

export async function runProductionCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: ProductionEngineExtras = {},
): Promise<CommandOutcome> {
  const req = parseProductionCreate(raw);
  const owner = stagingOwnerOf(identity);
  const read = extras.readStaged ?? invokeReadStaged;
  const staged = req.staging.flat();
  const outcome = await runRemoteCommand(deps, identity, async () => {
    // In die Bücher DIESER Filiale, oder gar nicht.
    assertHouseBranch(identity);
    // Die Bytes werden INNERHALB des Auftrags geholt: eine Wiederholung mit derselben Kennung führt
    // den Handler gar nicht mehr aus — und braucht die (dann geräumte) Ablage nicht.
    const outputs = [];
    for (let i = 0; i < req.input.outputs.length; i++) {
      const images = await readStagedAsDataUrls(req.staging[i], owner, read, (m) => new ProductionPayloadError(m));
      outputs.push({ ...req.input.outputs[i], spec: { ...req.input.outputs[i].spec, images } });
    }
    let r;
    try {
      r = await createProductionInHouse({ ...req.input, outputs }, ctxOf(identity));
    } catch (e) {
      // Das Nein des Hauses ist ein Urteil über DIESE Anfrage — eingefroren.
      if (e instanceof ProductionRejected) throw new CommandRejected(e.code, e.message);
      // Ein unvollständiger Medienweg ist KEIN Urteil: nichts wurde durabel, dieselbe Kennung darf erneut.
      if (e instanceof ProductionMediaIncomplete) throw new CommandNotEvaluated(e.code, e.message);
      throw e;
    }
    return {
      recordId: r.recordId,
      recordNumber: r.recordNumber,
      totalValue: r.totalValue,
      outputProductIds: r.outputProductIds,
      imageCount: r.imageCount,
    };
  });
  // Erst wenn der Auftrag wirklich durch ist, verliert die Ablage ihren Zweck.
  if (outcome.kind === 'ok') await discardStagedAfterSuccess(staged, owner, extras.discardStaged ?? invokeDiscardStaged);
  return outcome;
}

// ── R7A (PP-2) — „Complete Production" ────────────────────────────────────

/**
 * Der Rumpf ist ein Wunsch: WELCHER Beleg, und optional die endgültigen Beträge für Arbeit und
 * Gemeinkosten. Status, Summe, Ausgabe, Buchung, Zeitpunkt und der Mensch bestimmt der Primary.
 * Keine Fassung nötig: der Abschluss prüft in der Transaktion den WIRKLICHEN Status (nur CONFIRMED) —
 * ein zweiter Abschluss ist ein Nein, eine Wiederholung derselben Kennung das eingefrorene Ergebnis.
 */
export function parseProductionComplete(raw: unknown): ProductionCompleteInput {
  if (!isPlain(raw)) throw new ProductionPayloadError('payload must be an object');
  strict(raw, ['recordId', 'laborCost', 'overheadCost'], [...FORBIDDEN, ...COMPUTED.filter((k) => k !== 'recordId')], '');
  if (typeof raw.recordId !== 'string' || !raw.recordId.trim()) throw new ProductionPayloadError('recordId is required');
  return {
    recordId: raw.recordId,
    laborCost: amount(raw.laborCost, 'laborCost'),
    overheadCost: amount(raw.overheadCost, 'overheadCost'),
  };
}

export async function runProductionComplete(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseProductionComplete(raw);
  return runRemoteCommand(deps, identity, async () => {
    // In die Bücher DIESER Filiale, oder gar nicht.
    assertHouseBranch(identity);
    try {
      return { ...completeProductionInHouse(req, ctxOf(identity)) };
    } catch (e) {
      if (e instanceof ProductionRejected) throw new CommandRejected(e.code, e.message);
      throw e;
    }
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Runner = (deps: EngineDeps, identity: CommandIdentity, body: unknown) => Promise<CommandOutcome>;

async function execute(op: string, run: Runner, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(productionDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf (auch eine verschwundene Ablage) ist eine Antwort: neu schicken.
    if (err instanceof ProductionPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_PRODUCTION_CREATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(OP_PRODUCTION_CREATE, (d, i, b) => runProductionCreate(d, i, b), payload, actor),
});

registerCommand(OP_PRODUCTION_COMPLETE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(OP_PRODUCTION_COMPLETE, runProductionComplete, payload, actor),
});
