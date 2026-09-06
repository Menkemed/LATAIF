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

const REPAIR_TYPES = ['internal', 'external', 'hybrid'] as const;
const TAX_SCHEMES = ['VAT_10', 'ZERO', 'MARGIN'] as const;

export interface RepairCreateRequest {
  customerId: string;
  itemBrand?: string;
  itemModel?: string;
  itemSerial?: string;
  issueDescription: string;
  repairType: typeof REPAIR_TYPES[number];
  externalVendor?: string;
  workshopSupplierId?: string;
  estimatedCost?: number;
  internalCost?: number;
  chargeToCustomer?: number;
  estimatedReady?: string;
  taxScheme: typeof TAX_SCHEMES[number];
  notes?: string;
}

/**
 * Was ein Mensch am Aufnahmebildschirm eingibt — und nichts sonst.
 *
 * Ausdrücklich NICHT dabei: `repairNumber` und `voucherCode` (beide vergibt der Primary),
 * `status` (jede neue Reparatur beginnt bei `received`, das ist kein Feld), `margin` (rechnet der
 * Primary aus Preis minus Kosten), `invoiceId`, `productId` und `lotId`.
 *
 * `productId` fehlt mit Grund: eine Reparatur an EIGENER Ware (`repairScope: 'OWN'`) setzt den
 * Artikel auf `in_repair` und braucht einen Los-Bezug. Das ist ein zweiter Vertrag mit
 * Bestandswirkung; aus der Ferne wird deshalb nur die Kundenreparatur angelegt, und `repairScope`
 * ist entsprechend auch kein Feld.
 */
export function parseRepairCreate(raw: unknown): RepairCreateRequest {
  if (!isPlain(raw)) throw new ServicePayloadError('payload must be an object');
  onlyKnownFields(raw, [
    'customerId', 'itemBrand', 'itemModel', 'itemSerial', 'issueDescription', 'repairType',
    'externalVendor', 'workshopSupplierId', 'estimatedCost', 'internalCost', 'chargeToCustomer',
    'estimatedReady', 'taxScheme', 'notes',
  ]);
  const repairType = raw.repairType === undefined ? 'internal' : String(raw.repairType);
  if (!(REPAIR_TYPES as readonly string[]).includes(repairType)) {
    throw new ServicePayloadError(`unknown repair type: ${repairType || '(none)'}`);
  }
  const taxScheme = raw.taxScheme === undefined ? 'VAT_10' : String(raw.taxScheme);
  if (!(TAX_SCHEMES as readonly string[]).includes(taxScheme)) {
    throw new ServicePayloadError(`unknown tax scheme: ${taxScheme || '(none)'}`);
  }
  const out: RepairCreateRequest = {
    customerId: reqString(raw.customerId, 'customerId'),
    issueDescription: reqString(raw.issueDescription, 'issueDescription'),
    repairType: repairType as RepairCreateRequest['repairType'],
    taxScheme: taxScheme as RepairCreateRequest['taxScheme'],
    itemBrand: optString(raw.itemBrand, 'itemBrand'),
    itemModel: optString(raw.itemModel, 'itemModel'),
    itemSerial: optString(raw.itemSerial, 'itemSerial'),
    externalVendor: optString(raw.externalVendor, 'externalVendor'),
    workshopSupplierId: optString(raw.workshopSupplierId, 'workshopSupplierId'),
    estimatedReady: optString(raw.estimatedReady, 'estimatedReady'),
    notes: optString(raw.notes, 'notes'),
  };
  if (raw.estimatedCost !== undefined && raw.estimatedCost !== null) out.estimatedCost = money(raw.estimatedCost, 'estimatedCost');
  if (raw.internalCost !== undefined && raw.internalCost !== null) out.internalCost = money(raw.internalCost, 'internalCost');
  if (raw.chargeToCustomer !== undefined && raw.chargeToCustomer !== null) {
    out.chargeToCustomer = money(raw.chargeToCustomer, 'chargeToCustomer');
  }
  return out;
}

function repairState(id: string): ServiceResult {
  const r = query(
    'SELECT id, repair_number, customer_id, status, repair_type, estimated_cost, actual_cost, '
    + 'internal_cost, charge_to_customer, margin, voucher_code, revision, updated_at '
    + 'FROM repairs WHERE id = ?', [id],
  )[0];
  return {
    repairId: id,
    repairNumber: String(r?.repair_number ?? ''),
    customerId: String(r?.customer_id ?? ''),
    status: String(r?.status ?? ''),
    repairType: String(r?.repair_type ?? ''),
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

export function runRepairCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRepairCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    const branch = identity.branchId;
    const customer = query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'",
      [req.customerId, branch],
    )[0];
    if (!customer) throw new CommandRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
    if (req.workshopSupplierId) {
      const sup = query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ?', [req.workshopSupplierId, branch])[0];
      if (!sup) throw new CommandRejected('SUPPLIER_NOT_FOUND', 'no such workshop supplier in this branch');
    }
    // Ab hier rechnet das Haus: Belegnummer und Gutscheincode aus seinen eigenen Quellen, der
    // Anfangsstatus, und — wenn Werkstatt und Kosten zusammenkommen — die erste Arbeitszeile.
    const repair = useRepairStore.getState().createRepair({
      customerId: req.customerId,
      repairScope: 'CUSTOMER',
      issueDescription: req.issueDescription,
      repairType: req.repairType,
      taxScheme: req.taxScheme,
      itemBrand: req.itemBrand,
      itemModel: req.itemModel,
      itemSerial: req.itemSerial,
      externalVendor: req.externalVendor,
      workshopSupplierId: req.workshopSupplierId,
      estimatedCost: req.estimatedCost,
      internalCost: req.internalCost ?? 0,
      chargeToCustomer: req.chargeToCustomer,
      estimatedReady: req.estimatedReady,
      notes: req.notes,
    } as never);
    return repairState(repair.id) as unknown as Record<string, unknown>;
  });
}

// ── Reparatur: ändern ─────────────────────────────────────────────────────

export interface RepairUpdateRequest {
  id: string;
  expectedRevision: number;
  diagnosis?: string | null;
  estimatedCost?: number | null;
  actualCost?: number | null;
  internalCost?: number;
  chargeToCustomer?: number | null;
  repairType?: typeof REPAIR_TYPES[number];
  externalVendor?: string | null;
  workshopSupplierId?: string | null;
  estimatedReady?: string | null;
  itemBrand?: string | null;
  itemModel?: string | null;
  itemSerial?: string | null;
  notes?: string | null;
}

/**
 * Genau die Felder, die der „Save"-Knopf der Reparaturseite schreibt — abzüglich der beiden, die
 * er AUSRECHNET: `internalCost` in seiner abgeleiteten Form und `margin`. Beides leitet hier der
 * Primary ab, aus dem Stand, der NACH dieser Änderung gilt; zwei Rechner, die je ein Feld ändern,
 * kämen sonst zu zwei verschiedenen Margen.
 *
 * Nicht dabei: `status` (eigener Vertrag mit Buchungen), `repairNumber`, `voucherCode`,
 * `invoiceId`, `customerPaidFrom`/`internalPaidFrom` (Geldwege), `repairScope`, `productId`.
 */
export function parseRepairUpdate(raw: unknown): RepairUpdateRequest {
  if (!isPlain(raw)) throw new ServicePayloadError('payload must be an object');
  onlyKnownFields(raw, [
    'id', 'expectedRevision', 'diagnosis', 'estimatedCost', 'actualCost', 'internalCost',
    'chargeToCustomer', 'repairType', 'externalVendor', 'workshopSupplierId', 'estimatedReady',
    'itemBrand', 'itemModel', 'itemSerial', 'notes',
  ]);
  const out: RepairUpdateRequest = {
    id: reqString(raw.id, 'id'),
    expectedRevision: expectedRevisionOf(raw.expectedRevision),
  };
  // Der Umweg über `unknown` ist kein Kunstgriff, sondern die ehrliche Aussage: hier wird ein
  // benannter Vertrag als Feldablage benutzt, und TypeScript soll das nicht stillschweigend
  // durchwinken.
  const slot = out as unknown as Record<string, unknown>;
  const nullableText = (k: keyof RepairUpdateRequest, name: string): void => {
    if (raw[name] === undefined) return;
    slot[k] = raw[name] === null ? null : reqString(raw[name], name);
  };
  const nullableMoney = (k: keyof RepairUpdateRequest, name: string): void => {
    if (raw[name] === undefined) return;
    slot[k] = raw[name] === null ? null : money(raw[name], name);
  };
  nullableText('diagnosis', 'diagnosis');
  nullableText('externalVendor', 'externalVendor');
  nullableText('workshopSupplierId', 'workshopSupplierId');
  nullableText('estimatedReady', 'estimatedReady');
  nullableText('itemBrand', 'itemBrand');
  nullableText('itemModel', 'itemModel');
  nullableText('itemSerial', 'itemSerial');
  nullableMoney('estimatedCost', 'estimatedCost');
  nullableMoney('actualCost', 'actualCost');
  nullableMoney('chargeToCustomer', 'chargeToCustomer');
  if (raw.internalCost !== undefined && raw.internalCost !== null) out.internalCost = money(raw.internalCost, 'internalCost');
  if (raw.notes !== undefined) out.notes = raw.notes === null ? null : String(raw.notes);
  if (raw.repairType !== undefined) {
    const rt = String(raw.repairType);
    if (!(REPAIR_TYPES as readonly string[]).includes(rt)) throw new ServicePayloadError(`unknown repair type: ${rt}`);
    out.repairType = rt as RepairUpdateRequest['repairType'];
  }
  const touched = Object.keys(out).filter((k) => k !== 'id' && k !== 'expectedRevision');
  if (touched.length === 0) throw new ServicePayloadError('an edit must change something');
  return out;
}

export function runRepairUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRepairUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    const live = query(
      'SELECT id, repair_type, estimated_cost, actual_cost, internal_cost, charge_to_customer '
      + 'FROM repairs WHERE id = ? AND branch_id = ?', [req.id, identity.branchId],
    )[0];
    if (!live) throw new CommandRejected('REPAIR_NOT_FOUND', 'no such repair in this branch');
    assertRevision('repairs', req.id, req.expectedRevision, 'REPAIR_NOT_FOUND');
    if (req.workshopSupplierId) {
      const sup = query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ?',
        [req.workshopSupplierId, identity.branchId])[0];
      if (!sup) throw new CommandRejected('SUPPLIER_NOT_FOUND', 'no such workshop supplier in this branch');
    }

    // Der Stand, der NACH dieser Änderung gilt — Feld für Feld: was der Auftrag mitbringt, sonst
    // das, was in der Zeile steht. Die Ableitung ist wortgleich die des Bildschirms.
    const numOr = (v: unknown, fallback: number | null): number | null => {
      if (v === undefined) return fallback;
      return v === null ? null : Number(v);
    };
    const type = req.repairType ?? String(live.repair_type ?? 'internal');
    const estimated = numOr(req.estimatedCost, live.estimated_cost === null ? null : Number(live.estimated_cost));
    const actual = numOr(req.actualCost, live.actual_cost === null ? null : Number(live.actual_cost));
    const givenInternal = req.internalCost ?? Number(live.internal_cost ?? 0);
    const charge = numOr(req.chargeToCustomer, live.charge_to_customer === null ? null : Number(live.charge_to_customer));

    const derivedInternal = actual ?? estimated ?? 0;
    const effectiveInternal = type === 'hybrid'
      ? givenInternal
      : (givenInternal > 0 ? givenInternal : derivedInternal);
    const totalCost = type === 'hybrid' ? effectiveInternal + (estimated ?? 0) : effectiveInternal;

    const patch: Record<string, unknown> = {};
    for (const k of ['diagnosis', 'estimatedCost', 'actualCost', 'chargeToCustomer', 'repairType',
      'externalVendor', 'workshopSupplierId', 'estimatedReady', 'itemBrand', 'itemModel',
      'itemSerial', 'notes'] as const) {
      if (req[k] !== undefined) patch[k] = req[k];
    }
    // Die beiden abgeleiteten Werte kommen IMMER vom Primary, nie aus dem Rumpf.
    patch.internalCost = effectiveInternal;
    patch.margin = charge === null ? null : charge - totalCost;

    useRepairStore.getState().updateRepair(req.id, patch as never);
    return repairState(req.id) as unknown as Record<string, unknown>;
  });
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
  minimumPrice?: number | null;
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
 */
export function parseTransferUpdate(raw: unknown): TransferUpdateRequest {
  if (!isPlain(raw)) throw new ServicePayloadError('payload must be an object');
  onlyKnownFields(raw, ['id', 'expectedRevision', 'agentPrice', 'minimumPrice', 'returnBy', 'notes']);
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
  if (raw.minimumPrice !== undefined) {
    out.minimumPrice = raw.minimumPrice === null ? null : money(raw.minimumPrice, 'minimumPrice');
  }
  if (raw.returnBy !== undefined) out.returnBy = raw.returnBy === null ? null : reqString(raw.returnBy, 'returnBy');
  if (raw.notes !== undefined) out.notes = raw.notes === null ? null : String(raw.notes);
  if (out.agentPrice === undefined && out.minimumPrice === undefined
    && out.returnBy === undefined && out.notes === undefined) {
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
    if (req.minimumPrice !== undefined) patch.minimumPrice = req.minimumPrice;
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
