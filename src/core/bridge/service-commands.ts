// CENTRAL-C3F — eine Reparatur und ein Agenten-Transfer von einem zweiten Rechner.
//
// Der erste Befund dieses Schnitts steht vor jedem Code, weil er den halben Auftrag umgeschrieben
// hat: **„Transfer" heißt hier NICHT Filialtransfer.** `agent_transfers` trägt EIN Produkt
// (`product_id`, keine Zeilen, keine Menge) und keine Quell- oder Zielfiliale — im ganzen Baum
// gibt es kein `source_branch`/`destination_branch`. Ein Stück Ware geht auf Kommission zu einem
// Agenten; der Bestandseffekt ist ein Statuswechsel am Artikel (`in_stock`/`OWN` →
// `with_agent`/`AGENT` und zurück), keine Mengenbuchung, kein Zwischenzustand. „Quelle
// reduzieren, Ziel erhöhen" gibt es hier nicht, und es wurde auch nicht erfunden: was
// beschrieben werden muss, ist der Vertrag, den das Haus wirklich hat.
//
// Fünf Operationen, jede aus einem echten Bildschirm:
//
//  • **`repairs.create`** — der „Create"-Knopf der Reparaturliste (`createRepair`).
//  • **`repairs.update`** — der „Save"-Knopf der Reparaturseite (`updateRepair`).
//  • **`transfers.create`** — „New transfer" der Agentenseite. Sie ruft
//    `createTransferForCustomer`, und das ist wichtig: der Mensch wählt einen KUNDEN, das Haus
//    findet oder legt den Agenten dazu an. Ein `agentId` im Rumpf gäbe es hier nicht.
//  • **`transfers.update`** — der „Save"-Knopf der Transferseite, aber mit einem ENGEN Feldsatz:
//    `updateTransfer` ist im Haus ein generischer Setzer über zwanzig Spalten, darunter
//    Verkaufspreis, Provisionsbetrag, Abrechnungsstand und Rechnungsverknüpfung. Nichts davon ist
//    eine Eingabe; alles davon entsteht aus einem Vorgang.
//  • **`transfers.mark_returned`** — die Ware kommt zurück. Das ist der Gegenpol zum Anlegen und
//    schließt den normalen Kreislauf: hinaus auf Kommission, zurück ins Lager.
//
// Was ausdrücklich NICHT dabei ist, und warum: `markTransferSold`, `markTransferSettled`,
// `convertTransferToInvoice`, `undoTransferInvoiceConvert`, `deleteTransfer` (Forderung, Geld,
// Rechnung, destruktiv), sowie bei der Reparatur `updateStatus` (bucht Lieferantenverbindlich-
// keiten über `commitRepairLineExpenses`), `deleteRepair` und die Rechnungserzeugung. Jede davon
// ist ein eigener Vertrag mit eigenen Beweisen — keine davon ist Teil des normalen Anlegens oder
// Änderns.

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { useRepairStore } from '@/stores/repairStore';
import { useAgentStore } from '@/stores/agentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { CARD_BRANDS } from '@/core/finance/card-fees';
import { SUPPLIER_CREDIT_LOCK_MESSAGE } from '@/core/finance/expenseSettlement';
import {
  REPAIR_CUSTOMER_PAID_FROM, REPAIR_INTERNAL_PAID_FROM, REPAIR_TAX_SCHEMES, REPAIR_TYPES, type Repair,
} from '@/core/models/types';
import {
  REPAIR_EDIT_INPUTS, REPAIR_MAX_PHOTOS, RepairActionRejected, assertRepairEditRefs, buildRepairEditPatch,
  normalizeRepairCreate, planRepairCreate, type RepairCreateInput, type RepairEditInput, type RepairPhotoSlot,
} from '@/core/repairs/repair-rules';
import { houseRepairPort } from '@/core/repairs/repair-house';
import {
  assertHouseBranch, discardStagedAfterSuccess, invokeDiscardStaged, invokeReadStaged, isStagingId,
  readStagedAsDataUrls, stagingOwnerOf, type StagedMediaDiscard, type StagedMediaReader, type StagingOwner,
} from './remote-create-support';
import {
  CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps,
} from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';

export const OP_REPAIRS_CREATE = 'repairs.create';
export const OP_REPAIRS_UPDATE = 'repairs.update';
export const OP_TRANSFERS_CREATE = 'transfers.create';
export const OP_TRANSFERS_UPDATE = 'transfers.update';
export const OP_TRANSFERS_MARK_RETURNED = 'transfers.mark_returned';

/** Die fünf Namen dieses Schnitts — dieselbe Liste kennt auch Rust. */
export const C3F_MUTATIONS = [
  OP_REPAIRS_CREATE, OP_REPAIRS_UPDATE,
  OP_TRANSFERS_CREATE, OP_TRANSFERS_UPDATE, OP_TRANSFERS_MARK_RETURNED,
] as const;

/** Ein unbrauchbarer Rumpf. Kein Urteil der Domäne — es wurde nie etwas bewertet. */
export class ServicePayloadError extends Error {
  readonly code = 'INVALID_PAYLOAD';
  constructor(message: string) {
    super(message);
    this.name = 'ServicePayloadError';
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKnownFields(raw: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) throw new ServicePayloadError(`unknown field: ${k}`);
  }
}
function reqString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new ServicePayloadError(`${name} is required`);
  return v.trim();
}
function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ServicePayloadError(`${name} must be a string`);
  const t = v.trim();
  return t === '' ? undefined : t;
}
function money(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new ServicePayloadError(`${name} must be a number of at least 0`);
  }
  return v;
}
/** Die zuvor GELESENE Fassung. Der Client darf sie nicht wählen, nur zurückreichen. */
function expectedRevisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ServicePayloadError('expectedRevision is required — an edit must say which revision it saw');
  }
  return v;
}

/**
 * Der Vergleich der Fassung, INNERHALB der Transaktion und gegen die Zeile selbst.
 *
 * Das Urteil ist eingefroren: diese Anfrage beschreibt einen Stand, den es nicht mehr gibt, und
 * sie wird nie wieder gültig. Wer trotzdem ändern will, liest neu — mit einer neuen Kennung.
 */
function assertRevision(table: 'repairs' | 'agent_transfers', id: string, expected: number, notFound: string): void {
  const live = query(`SELECT revision FROM ${table} WHERE id = ?`, [id])[0];
  if (!live) throw new CommandRejected(notFound, 'no such record');
  const now = Number(live.revision ?? 0);
  if (now !== expected) {
    throw new CommandRejected(
      'RECORD_CHANGED',
      `this record changed since you opened it (you saw ${expected}, it is now ${now})`,
    );
  }
}

export function serviceDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export type ServiceResult = { readonly [k: string]: unknown };

// ── Reparatur: anlegen ────────────────────────────────────────────────────

/**
 * R5C — die Eingabe der Anlegemaske in DER Form, die auch der Primary an seiner eigenen Maske baut
 * (`normalizeRepairCreate`), dazu die Fotos als Kennungen der Zwischenablage.
 */
export interface RepairCreateRequest {
  input: RepairCreateInput;
  photos: Array<{ stagingId: string }>;
}

/** Was es bei einer Reparatur an EIGENER Ware nicht gibt: die Maske zeigt es dort nicht. */
const OWN_HAS_NO = [
  'customerId', 'chargeToCustomer', 'taxScheme', 'itemCategoryId', 'itemAttributes',
  'itemBrand', 'itemModel', 'itemReference', 'itemSerial', 'itemDescription',
] as const;

/** Eine flache Merkmalsliste: Text, Zahl oder Ja/Nein — geprüft, BEVOR etwas bewertet wird. */
function plainAttributes(v: unknown, name: string): void {
  if (!isPlain(v)) throw new ServicePayloadError(`${name} must be an object`);
  for (const [k, x] of Object.entries(v)) {
    const flach = typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
    if (!flach) throw new ServicePayloadError(`${name}.${k} must be text, a number or yes/no`);
  }
}

/** R5C — Fotos im Auftrag: vorhandene nach ihrer Stelle, neue nach ihrer Ablagekennung. Nie Bytes. */
function parsePhotos(raw: unknown, allowKeep: boolean): RepairPhotoSlot[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ServicePayloadError('photos must be a list');
  if (raw.length > REPAIR_MAX_PHOTOS) throw new ServicePayloadError(`at most ${REPAIR_MAX_PHOTOS} photos`);
  return raw.map((slot): RepairPhotoSlot => {
    if (isPlain(slot)) {
      const keys = Object.keys(slot);
      if (keys.length === 1 && keys[0] === 'stagingId' && isStagingId(slot.stagingId)) return { stagingId: slot.stagingId };
      if (allowKeep && keys.length === 1 && keys[0] === 'keep'
        && typeof slot.keep === 'number' && Number.isInteger(slot.keep) && slot.keep >= 0) return { keep: slot.keep };
    }
    throw new ServicePayloadError(allowKeep
      ? 'a photo is { keep: <position> } or { stagingId: <content hash> }'
      : 'a new repair has only new photos: { stagingId: <content hash> }');
  });
}

/**
 * Die Fotos auflösen — INNERHALB des Auftrags: neue Bytes aus der Zwischenablage (Eigentümer ist
 * die geprüfte Identität), vorhandene aus der Liste, die die Fassung gerade bestätigt hat.
 */
async function resolvePhotos(
  slots: readonly RepairPhotoSlot[], current: readonly string[], owner: StagingOwner, read: StagedMediaReader,
): Promise<string[]> {
  const ids = [...new Set(slots.flatMap((x) => ('stagingId' in x ? [x.stagingId] : [])))];
  const data = await readStagedAsDataUrls(ids, owner, read, (m) => new ServicePayloadError(m));
  const byId = new Map(ids.map((id, i) => [id, data[i]]));
  return slots.map((x) => {
    if ('stagingId' in x) return String(byId.get(x.stagingId));
    if (x.keep >= current.length) {
      throw new CommandRejected('PHOTO_NOT_FOUND', 'this photo is not on the repair (any more)');
    }
    return current[x.keep];
  });
}

const stagedIdsOf = (slots: readonly RepairPhotoSlot[] | undefined): string[] =>
  [...new Set((slots ?? []).flatMap((x) => ('stagingId' in x ? [x.stagingId] : [])))];

/** Ein Nein der geteilten Regeln ist ein eingefrorenes Nein des Auftrags — mit demselben Code. */
function house<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RepairActionRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

/** Nur für Tests: die Zwischenablage ohne Tauri. Voreingestellt sind die echten Aufrufe. */
export interface RepairEngineExtras {
  readStaged?: StagedMediaReader;
  discardStaged?: StagedMediaDiscard;
}

/**
 * Was ein Mensch am Aufnahmebildschirm eingibt — und nichts sonst.
 *
 * Ausdrücklich NICHT dabei: `repairNumber` und `voucherCode` (beide vergibt der Primary),
 * `status` (jede neue Reparatur beginnt bei `received`, das ist kein Feld), `margin` (rechnet der
 * Primary aus Preis minus Kosten), `invoiceId`, die Zahlwege.
 *
 * R5C — die Reparatur an EIGENER Ware ist jetzt dabei, mit genau dem Vertrag der Maske: der
 * Artikel (`productId`) und optional sein Los (`lotId`). Kunde, Preis, Steuerwahl und
 * Artikelangaben gibt es dort nicht — den Platzhalter-Kunden, `in_repair` am Artikel und dessen
 * Angaben setzt der Primary. Bei der Kundenreparatur umgekehrt: kein Artikel, kein Los. Dazu die
 * übrigen Felder der Maske (Kategorie, Merkmale, Referenz, Beschreibung, Mitarbeiter, Fotos).
 * `externalVendor` und die Steuer `MARGIN` sind nicht mehr dabei: keine Maske bietet sie an.
 */
export function parseRepairCreate(raw: unknown): RepairCreateRequest {
  if (!isPlain(raw)) throw new ServicePayloadError('payload must be an object');
  onlyKnownFields(raw, [
    'repairScope', 'customerId', 'productId', 'lotId', 'itemCategoryId', 'itemAttributes',
    'itemBrand', 'itemModel', 'itemReference', 'itemSerial', 'itemDescription', 'issueDescription',
    'repairType', 'workshopSupplierId', 'estimatedCost', 'internalCost', 'chargeToCustomer',
    'estimatedReady', 'taxScheme', 'staffId', 'notes', 'photos',
  ]);
  const scope = raw.repairScope === undefined ? 'CUSTOMER' : String(raw.repairScope);
  if (scope !== 'CUSTOMER' && scope !== 'OWN') throw new ServicePayloadError(`unknown repair scope: ${scope || '(none)'}`);
  if (scope === 'OWN') {
    for (const k of OWN_HAS_NO) {
      if (raw[k] !== undefined) {
        throw new ServicePayloadError(`${k} does not belong to a repair of our own stock — the item is the product`);
      }
    }
    reqString(raw.productId, 'productId');
  } else {
    for (const k of ['productId', 'lotId']) {
      if (raw[k] !== undefined) throw new ServicePayloadError(`${k} belongs to a repair of our own stock`);
    }
    reqString(raw.customerId, 'customerId');
  }
  const repairType = raw.repairType === undefined ? 'internal' : String(raw.repairType);
  if (!(REPAIR_TYPES as readonly string[]).includes(repairType)) {
    throw new ServicePayloadError(`unknown repair type: ${repairType || '(none)'}`);
  }
  if (raw.taxScheme !== undefined && !(REPAIR_TAX_SCHEMES as readonly unknown[]).includes(raw.taxScheme)) {
    throw new ServicePayloadError(`unknown tax scheme: ${String(raw.taxScheme) || '(none)'}`);
  }
  for (const k of ['estimatedCost', 'internalCost', 'chargeToCustomer'] as const) {
    if (raw[k] !== undefined && raw[k] !== null) money(raw[k], k);
  }
  for (const k of ['customerId', 'productId', 'lotId', 'itemCategoryId', 'itemBrand', 'itemModel',
    'itemReference', 'itemSerial', 'itemDescription', 'workshopSupplierId', 'estimatedReady', 'staffId', 'notes'] as const) {
    optString(raw[k], k);
  }
  if (raw.itemAttributes !== undefined) plainAttributes(raw.itemAttributes, 'itemAttributes');
  const issueDescription = reqString(raw.issueDescription, 'issueDescription');
  const photos = (parsePhotos(raw.photos, false) ?? []) as Array<{ stagingId: string }>;
  let input: RepairCreateInput;
  try {
    // DIESELBE Aufbereitung wie an der Maske des Primary — nicht eine zweite.
    input = normalizeRepairCreate({
      ...(raw as unknown as Partial<Repair>), repairScope: scope, repairType: repairType as Repair['repairType'], issueDescription,
    });
  } catch (e) {
    if (e instanceof RepairActionRejected) throw new ServicePayloadError(e.message);
    throw e;
  }
  return { input, photos };
}

function repairState(id: string): ServiceResult {
  const r = query(
    'SELECT id, repair_number, customer_id, status, repair_type, repair_scope, product_id, lot_id, '
    + 'tax_scheme, invoice_id, estimated_cost, actual_cost, '
    + 'internal_cost, charge_to_customer, margin, voucher_code, revision, updated_at '
    + 'FROM repairs WHERE id = ?', [id],
  )[0];
  return {
    repairId: id,
    repairNumber: String(r?.repair_number ?? ''),
    customerId: String(r?.customer_id ?? ''),
    status: String(r?.status ?? ''),
    repairType: String(r?.repair_type ?? ''),
    repairScope: String(r?.repair_scope ?? ''),
    productId: String(r?.product_id ?? ''),
    lotId: String(r?.lot_id ?? ''),
    taxScheme: String(r?.tax_scheme ?? ''),
    invoiceId: String(r?.invoice_id ?? ''),
    estimatedCost: r?.estimated_cost === null || r?.estimated_cost === undefined ? null : Number(r.estimated_cost),
    actualCost: r?.actual_cost === null || r?.actual_cost === undefined ? null : Number(r.actual_cost),
    internalCost: Number(r?.internal_cost ?? 0),
    chargeToCustomer: r?.charge_to_customer === null || r?.charge_to_customer === undefined ? null : Number(r.charge_to_customer),
    // Die Marge ist ein ERGEBNIS des Hauses, keine Eingabe.
    margin: r?.margin === null || r?.margin === undefined ? null : Number(r.margin),
    voucherCode: String(r?.voucher_code ?? ''),
    revision: Number(r?.revision ?? 0),
    updatedAt: String(r?.updated_at ?? ''),
  };
}

export async function runRepairCreate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: RepairEngineExtras = {},
): Promise<CommandOutcome> {
  const req = parseRepairCreate(raw);
  const read = extras.readStaged ?? invokeReadStaged;
  const discard = extras.discardStaged ?? invokeDiscardStaged;
  const owner = stagingOwnerOf(identity);
  const outcome = await runRemoteCommand(deps, identity, async () => {
    // R5C — in die Bücher DIESER Filiale, oder gar nicht: Belegnummer und der Platzhalter-Kunde
    // der eigenen Ware entstehen in der Filiale der Sitzung.
    assertHouseBranch(identity);
    // Dieselbe Vorbereitung wie an der Maske des Primary (`createRepairOnPrimary`): Kunde — oder
    // eigener Artikel samt Los —, Pflichtfelder der Kategorie, Werkstatt, Mitarbeiter, die eigenen
    // Kosten aus der geteilten Ableitung (C3F FINAL), und bei eigener Ware die Angaben DES ARTIKELS.
    const data = house(() => planRepairCreate(req.input, houseRepairPort(identity.branchId)));
    // Die Fotos INNERHALB des Auftrags: eine Wiederholung derselben Kennung kommt gar nicht bis hierher.
    const images = await resolvePhotos(req.photos, [], owner, read);
    // Ab hier rechnet das Haus: Belegnummer und Gutscheincode aus seinen eigenen Quellen, der
    // Anfangsstatus, bei eigener Ware `in_repair` am Artikel und der Platzhalter-Kunde, und — wenn
    // Werkstatt und Kosten zusammenkommen — die erste Arbeitszeile.
    const repair = useRepairStore.getState().createRepair({ ...data, images });
    return repairState(repair.id) as unknown as Record<string, unknown>;
  });
  // Erst wenn der Auftrag wirklich durch ist, verliert die Ablage ihren Zweck.
  if (outcome.kind === 'ok') await discardStagedAfterSuccess(stagedIdsOf(req.photos), owner, discard);
  return outcome;
}

// ── Reparatur: ändern ─────────────────────────────────────────────────────

/**
 * R5C — genau die Eingaben der „Save"-Maske (`REPAIR_EDIT_INPUTS`), jede nur, wenn sie sich
 * geändert hat; `null` heißt „geleert". Die Fotos reisen als Plan.
 */
export interface RepairUpdateRequest {
  id: string;
  expectedRevision: number;
  changes: Partial<Record<RepairEditInput, unknown>>;
  photos?: RepairPhotoSlot[];
}

const EDIT_FIELDS = REPAIR_EDIT_INPUTS.filter((k) => k !== 'images');

/**
 * Genau die Felder, die der „Save"-Knopf der Reparaturseite schreibt — seit R5C ALLE davon: dazu
 * die Zahlwege (Kunde, Kartenart, eigene Kosten), Kategorie und Merkmale, Referenz,
 * Beschreibung, Problem und Fotos. Was er AUSRECHNET, reist nie mit: `internalCost` in seiner
 * abgeleiteten Form, `margin` und die Kartenart außerhalb einer Kartenzahlung. Das leitet der
 * Primary aus dem Stand ab, der NACH dieser Änderung gilt — mit DERSELBEN Funktion wie die Maske
 * (`buildRepairEditPatch`); zwei Rechner, die je ein Feld ändern, kommen so zur selben Marge.
 *
 * Nicht dabei: `status` (eigener Vertrag mit Buchungen), `repairNumber`, `voucherCode`,
 * `invoiceId`, `repairScope`, `productId`, `customerId`, `taxScheme` (wählt der Rechnungsdialog)
 * und `externalVendor` (kein Feld der Maske).
 */
export function parseRepairUpdate(raw: unknown): RepairUpdateRequest {
  if (!isPlain(raw)) throw new ServicePayloadError('payload must be an object');
  onlyKnownFields(raw, ['id', 'expectedRevision', ...EDIT_FIELDS, 'photos']);
  const out: RepairUpdateRequest = {
    id: reqString(raw.id, 'id'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
    changes: {},
  };
  const c = out.changes as Record<string, unknown>;
  const nullableText = (k: string): void => {
    if (raw[k] === undefined) return;
    c[k] = raw[k] === null ? null : reqString(raw[k], k);
  };
  const nullableMoney = (k: string): void => {
    if (raw[k] === undefined) return;
    c[k] = raw[k] === null ? null : money(raw[k], k);
  };
  const nullableOneOf = (k: string, list: readonly string[]): void => {
    if (raw[k] === undefined) return;
    if (raw[k] !== null && !list.includes(raw[k] as string)) throw new ServicePayloadError(`unknown ${k}: ${String(raw[k])}`);
    c[k] = raw[k];
  };
  for (const k of ['diagnosis', 'workshopSupplierId', 'estimatedReady', 'itemCategoryId', 'itemBrand',
    'itemModel', 'itemReference', 'itemSerial', 'itemDescription']) nullableText(k);
  for (const k of ['estimatedCost', 'actualCost', 'chargeToCustomer']) nullableMoney(k);
  if (raw.internalCost !== undefined && raw.internalCost !== null) c.internalCost = money(raw.internalCost, 'internalCost');
  if (raw.notes !== undefined) c.notes = raw.notes === null ? null : String(raw.notes);
  if (raw.issueDescription !== undefined) {
    // Die Maske lässt das Feld leeren; die Spalte trägt dann '' — kein NULL, kein Nein.
    if (typeof raw.issueDescription !== 'string') throw new ServicePayloadError('issueDescription must be text');
    c.issueDescription = raw.issueDescription;
  }
  if (raw.repairType !== undefined) {
    const rt = String(raw.repairType);
    if (!(REPAIR_TYPES as readonly string[]).includes(rt)) throw new ServicePayloadError(`unknown repair type: ${rt}`);
    c.repairType = rt;
  }
  nullableOneOf('customerPaidFrom', REPAIR_CUSTOMER_PAID_FROM);
  nullableOneOf('internalPaidFrom', REPAIR_INTERNAL_PAID_FROM);
  nullableOneOf('customerCardBrand', CARD_BRANDS);
  if (raw.itemAttributes !== undefined) {
    plainAttributes(raw.itemAttributes, 'itemAttributes');
    c.itemAttributes = raw.itemAttributes;
  }
  out.photos = parsePhotos(raw.photos, true);
  if (Object.keys(c).length === 0 && !out.photos) throw new ServicePayloadError('an edit must change something');
  return out;
}

export async function runRepairUpdate(
  deps: EngineDeps, identity: CommandIdentity, raw: unknown, extras: RepairEngineExtras = {},
): Promise<CommandOutcome> {
  const req = parseRepairUpdate(raw);
  const read = extras.readStaged ?? invokeReadStaged;
  const discard = extras.discardStaged ?? invokeDiscardStaged;
  const owner = stagingOwnerOf(identity);
  const outcome = await runRemoteCommand(deps, identity, async () => {
    assertHouseBranch(identity);
    const live = query('SELECT id FROM repairs WHERE id = ? AND branch_id = ?', [req.id, identity.branchId])[0];
    if (!live) throw new CommandRejected('REPAIR_NOT_FOUND', 'no such repair in this branch');
    assertRevision('repairs', req.id, req.expectedRevision, 'REPAIR_NOT_FOUND');
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    const seen = rs.getRepair(req.id);
    if (!seen) throw new CommandNotEvaluated('REPAIR_NOT_LOADED', 'the repair could not be read');

    // Der Stand, der NACH dieser Änderung gilt — Feld für Feld: was der Auftrag mitbringt, sonst
    // das, was in der Zeile steht. Die Fassung hat eben bestätigt, dass die Zeile genau das ist,
    // was der Client gesehen hat — also ist das hier derselbe Stand wie seine Maske.
    const effective: Partial<Repair> = { ...seen };
    for (const [k, v] of Object.entries(req.changes)) (effective as Record<string, unknown>)[k] = v === null ? undefined : v;
    if (req.photos) effective.images = await resolvePhotos(req.photos, seen.images ?? [], owner, read);

    // DIESELBE Funktion wie „Save" am Primary: jedes Feld der Maske, dazu die eigenen Kosten, die
    // Marge und die Kartenart — nie aus dem Rumpf.
    const patch = house(() => buildRepairEditPatch(effective));
    house(() => assertRepairEditRefs(patch, seen, houseRepairPort(identity.branchId)));
    try {
      // Der Weg des Hauses: die Zeile, dazu die Umbuchung der Kundenzahlung samt Kartengebühr
      // (`syncRepairCustomerPayment`) und das Nachziehen einer spät gesetzten Werkstatt.
      rs.updateRepair(req.id, patch);
    } catch (e) {
      if (e instanceof Error && e.message === SUPPLIER_CREDIT_LOCK_MESSAGE) {
        throw new CommandRejected('SUPPLIER_CREDIT_LOCKED', e.message);
      }
      throw e;
    }
    return repairState(req.id) as unknown as Record<string, unknown>;
  });
  if (outcome.kind === 'ok') await discardStagedAfterSuccess(stagedIdsOf(req.photos), owner, discard);
  return outcome;
}

// ── Agenten-Transfer: anlegen ─────────────────────────────────────────────

const SETTLEMENT_MODELS = ['full', 'split'] as const;

export interface TransferCreateRequest {
  customerId: string;
  productId: string;
  agentPrice: number;
  settlementModel: typeof SETTLEMENT_MODELS[number];
  excessSplitPct?: number;
  returnBy?: string;
  notes?: string;
}

/**
 * Der Mensch wählt einen KUNDEN und ein Stück Ware — genau wie am Primary. Den Agenten dazu
 * findet oder legt das Haus an (`findOrCreateAgentForCustomer`); ein `agentId` im Rumpf gäbe es
 * hier nicht, und die Transfernummer schon gar nicht.
 */
export function parseTransferCreate(raw: unknown): TransferCreateRequest {
  if (!isPlain(raw)) throw new ServicePayloadError('payload must be an object');
  onlyKnownFields(raw, ['customerId', 'productId', 'agentPrice', 'settlementModel', 'excessSplitPct', 'returnBy', 'notes']);
  const model = raw.settlementModel === undefined ? 'full' : String(raw.settlementModel);
  if (!(SETTLEMENT_MODELS as readonly string[]).includes(model)) {
    throw new ServicePayloadError(`unknown settlement model: ${model || '(none)'}`);
  }
  const price = raw.agentPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new ServicePayloadError('agentPrice must be a positive number');
  }
  const out: TransferCreateRequest = {
    customerId: reqString(raw.customerId, 'customerId'),
    productId: reqString(raw.productId, 'productId'),
    agentPrice: price,
    settlementModel: model as TransferCreateRequest['settlementModel'],
    returnBy: optString(raw.returnBy, 'returnBy'),
    notes: optString(raw.notes, 'notes'),
  };
  if (model === 'split') {
    const pct = raw.excessSplitPct === undefined ? 50 : Number(raw.excessSplitPct);
    // Dieselbe Bedeutung wie beim Kommissionsmodell: 0 gäbe uns nichts, 100 wäre ein anderes
    // Modell unter falschem Namen.
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      throw new ServicePayloadError("the shop's share must be between 1 and 99 percent");
    }
    out.excessSplitPct = pct;
  } else if (raw.excessSplitPct !== undefined && raw.excessSplitPct !== null) {
    // Ein Anteil ohne sein Modell wäre ein Parameter, den niemand liest.
    throw new ServicePayloadError('excessSplitPct belongs to the split settlement model');
  }
  return out;
}

function transferState(id: string): ServiceResult {
  const r = query(
    'SELECT id, transfer_number, agent_id, product_id, agent_price, settlement_model, '
    + 'excess_split_pct, status, transferred_at, return_by, returned_at, revision, updated_at '
    + 'FROM agent_transfers WHERE id = ?', [id],
  )[0];
  return {
    transferId: id,
    transferNumber: String(r?.transfer_number ?? ''),
    agentId: String(r?.agent_id ?? ''),
    productId: String(r?.product_id ?? ''),
    agentPrice: Number(r?.agent_price ?? 0),
    settlementModel: String(r?.settlement_model ?? ''),
    excessSplitPct: r?.excess_split_pct === null || r?.excess_split_pct === undefined ? null : Number(r.excess_split_pct),
    status: String(r?.status ?? ''),
    transferredAt: String(r?.transferred_at ?? ''),
    returnBy: String(r?.return_by ?? ''),
    returnedAt: String(r?.returned_at ?? ''),
    revision: Number(r?.revision ?? 0),
    updatedAt: String(r?.updated_at ?? ''),
  };
}

export function runTransferCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseTransferCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    const branch = identity.branchId;
    const customer = query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'",
      [req.customerId, branch],
    )[0];
    if (!customer) throw new CommandRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
    const product = query('SELECT id, stock_status FROM products WHERE id = ? AND branch_id = ?',
      [req.productId, branch])[0];
    if (!product) throw new CommandRejected('PRODUCT_NOT_FOUND', 'no such product in this branch');
    // Ein Stück, das schon unterwegs ist, geht nicht ein zweites Mal hinaus. Das ist der eigentliche
    // Wettlaufschutz dieses Vorgangs: die Ware ist EINE, und ihr Zustand entscheidet.
    const status = String(product.stock_status ?? '');
    if (status !== 'in_stock') {
      throw new CommandRejected('PRODUCT_NOT_AVAILABLE',
        `this item is not in stock (it is "${status}") — it cannot go out on approval`);
    }
    const already = query(
      "SELECT id FROM agent_transfers WHERE product_id = ? AND status = 'transferred'",
      [req.productId],
    )[0];
    if (already) {
      throw new CommandRejected('PRODUCT_ALREADY_OUT', 'this item is already out on approval');
    }
    // Gemessen und behoben: `findOrCreateAgentForCustomer` sucht den Kunden in der GELADENEN
    // Liste des Kundenstores, nicht in der Datenbank. Am Primary lädt ein Bildschirm sie; ein
    // Fernauftrag hat keinen — der Kunde existiert, und die Domäne sagt trotzdem „Customer not
    // found". Also erst laden, dann rufen: dieselbe Funktion, auf dem Stand, der wirklich gilt.
    useCustomerStore.getState().loadCustomers();
    const transfer = useAgentStore.getState().createTransferForCustomer({
      customerId: req.customerId,
      productId: req.productId,
      ourPrice: req.agentPrice,
      returnBy: req.returnBy,
      notes: req.notes,
      settlementModel: req.settlementModel,
      excessSplitPct: req.excessSplitPct,
    });
    return transferState(transfer.id) as unknown as Record<string, unknown>;
  });
}

// ── Agenten-Transfer: ändern ──────────────────────────────────────────────

export interface TransferUpdateRequest {
  id: string;
  expectedRevision: number;
  agentPrice?: number;
  returnBy?: string | null;
  notes?: string | null;
}

/**
 * Der ENGE Feldsatz — und er ist der eigentliche Riegel, nicht die Domänenfunktion.
 *
 * `updateTransfer` ist im Haus ein generischer Setzer über zwanzig Spalten: darüber ließen sich
 * Status, Verkaufspreis, Provisionsbetrag, Abrechnungsbetrag, Abrechnungsstand und die Zeitpunkte
 * `sold_at`/`returned_at`/`settled_at` setzen. Nichts davon ist eine Eingabe; alles davon entsteht
 * aus einem Vorgang (`markTransferSold`, `markTransferSettled`, `markTransferReturned`).
 *
 * **Artikel und Agent sind nach dem Anlegen unveränderlich.** Kein Transferbildschirm des Hauses
 * schreibt `product_id` oder `agent_id` — geprüft in beiden (TransferDetail, TransferTable), und
 * beide bearbeiten ausschließlich Preis, Rückgabedatum und Notiz. Ein Fernauftrag, der den Artikel
 * wechseln könnte, müsste das alte Stück freigeben, das neue übernehmen und beide Artikelzustände
 * mit dem Transfer in EINER Transaktion halten — eine Wirkung, die es im Haus nicht gibt. Statt
 * sie zu erfinden, wird sie abgewiesen: `productId` und `agentId` sind hier keine Felder.
 */
export function parseTransferUpdate(raw: unknown): TransferUpdateRequest {
  if (!isPlain(raw)) throw new ServicePayloadError('payload must be an object');
  // GENAU die drei Felder, die beide echten Bildschirme (TransferDetail und TransferTable)
  // schreiben — nicht eines mehr. `minimumPrice` stand hier und ist an KEINEM von beiden
  // editierbar; ein Feld, das nur der Fernweg kann, wäre ein Vertrag, den das Haus nicht hat.
  onlyKnownFields(raw, ['id', 'expectedRevision', 'agentPrice', 'returnBy', 'notes']);
  const out: TransferUpdateRequest = {
    id: reqString(raw.id, 'id'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  if (raw.agentPrice !== undefined) {
    const p = raw.agentPrice;
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) {
      throw new ServicePayloadError('agentPrice must be a positive number');
    }
    out.agentPrice = p;
  }
  if (raw.returnBy !== undefined) out.returnBy = raw.returnBy === null ? null : reqString(raw.returnBy, 'returnBy');
  if (raw.notes !== undefined) out.notes = raw.notes === null ? null : String(raw.notes);
  if (out.agentPrice === undefined && out.returnBy === undefined && out.notes === undefined) {
    throw new ServicePayloadError('an edit must change something');
  }
  return out;
}

/** Nur ein Transfer, der noch draußen ist, wird geändert oder zurückgenommen. */
function liveTransfer(id: string, branchId: string): Record<string, unknown> {
  const live = query('SELECT id, status, product_id FROM agent_transfers WHERE id = ? AND branch_id = ?',
    [id, branchId])[0];
  if (!live) throw new CommandRejected('TRANSFER_NOT_FOUND', 'no such transfer in this branch');
  return live;
}

export function runTransferUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseTransferUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    const live = liveTransfer(req.id, identity.branchId);
    if (String(live.status) !== 'transferred') {
      // Verkauft, zurück oder abgerechnet: dann hängen Zahlen daran, die aus diesen Feldern
      // gerechnet wurden. Sie nachträglich zu verschieben hieße, eine Buchung zu verändern.
      throw new CommandRejected('TRANSFER_NOT_OPEN',
        `this transfer is "${String(live.status)}" — only one that is still out can be changed`);
    }
    assertRevision('agent_transfers', req.id, req.expectedRevision, 'TRANSFER_NOT_FOUND');
    const patch: Record<string, unknown> = {};
    if (req.agentPrice !== undefined) patch.agentPrice = req.agentPrice;
    if (req.returnBy !== undefined) patch.returnBy = req.returnBy;
    if (req.notes !== undefined) patch.notes = req.notes;
    useAgentStore.getState().updateTransfer(req.id, patch as never);
    return transferState(req.id) as unknown as Record<string, unknown>;
  });
}

// ── Agenten-Transfer: die Ware kommt zurück ───────────────────────────────

export interface TransferReturnRequest {
  id: string;
  expectedRevision: number;
}

export function parseTransferReturn(raw: unknown): TransferReturnRequest {
  if (!isPlain(raw)) throw new ServicePayloadError('payload must be an object');
  onlyKnownFields(raw, ['id', 'expectedRevision']);
  return {
    id: reqString(raw.id, 'id'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
}

export function runTransferReturn(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseTransferReturn(raw);
  return runRemoteCommand(deps, identity, () => {
    const live = liveTransfer(req.id, identity.branchId);
    if (String(live.status) === 'returned') {
      // KEIN „schon erledigt, also ok": eine zweite Rücknahme ist eine Aussage über einen Stand,
      // den es nicht mehr gibt. Die Wiederholung DESSELBEN Auftrags kommt gar nicht bis hierher —
      // sie bekommt das eingefrorene Ergebnis.
      throw new CommandRejected('TRANSFER_ALREADY_RETURNED', 'this transfer is already back');
    }
    if (String(live.status) !== 'transferred') {
      throw new CommandRejected('TRANSFER_NOT_OPEN',
        `this transfer is "${String(live.status)}" — only one that is still out can come back`);
    }
    assertRevision('agent_transfers', req.id, req.expectedRevision, 'TRANSFER_NOT_FOUND');
    // Der Weg des Hauses: Status auf `returned`, Zeitpunkt gesetzt, der Artikel zurück auf
    // `in_stock`/`OWN`, und eine etwaige Forderung aus einem früheren Verkauf zurückgenommen.
    useAgentStore.getState().markTransferReturned(req.id);
    const after = transferState(req.id);
    if (after.status !== 'returned') {
      // Nie beobachtet — aber ein Ergebnis, das die Domäne nicht erreicht hat, wird nicht als
      // Erfolg eingefroren.
      throw new CommandNotEvaluated('TRANSFER_RETURN_INCOMPLETE', `status is ${String(after.status)}`);
    }
    return after as unknown as Record<string, unknown>;
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

async function execute(
  run: (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>,
  op: string,
  payload: unknown,
  actor?: CommandActor,
): Promise<ServiceResult & { replayed: boolean }> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(serviceDeps(), { ...actor, op }, body);
  } catch (err) {
    if (err instanceof ServicePayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as ServiceResult), replayed: outcome.replayed };
}

registerCommand(OP_REPAIRS_CREATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runRepairCreate, OP_REPAIRS_CREATE, payload, actor),
});
registerCommand(OP_REPAIRS_UPDATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runRepairUpdate, OP_REPAIRS_UPDATE, payload, actor),
});
registerCommand(OP_TRANSFERS_CREATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runTransferCreate, OP_TRANSFERS_CREATE, payload, actor),
});
registerCommand(OP_TRANSFERS_UPDATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runTransferUpdate, OP_TRANSFERS_UPDATE, payload, actor),
});
registerCommand(OP_TRANSFERS_MARK_RETURNED, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runTransferReturn, OP_TRANSFERS_MARK_RETURNED, payload, actor),
});
