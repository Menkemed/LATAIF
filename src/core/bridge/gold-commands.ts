// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Gold vom zweiten Rechner: begleichen, Gold-Verbrauch, Material, Kosten.
//
// Sechs Absichten, jede ruft DIESELBE Hausfolge wie die Maske des Primary:
//
//   gold.payables.settle          — Gramm-Schuld beim Lieferanten: Gold zurück / aus dem Bestand / in BHD
//   gold.customer_credits.settle  — Gold-Guthaben eines Kunden: abholen / in BHD-Guthaben
//   repairs.record_gold_usage     — „Add Gold Usage" (Workshop-Gold oder Kundengold samt Rest)
//   repairs.add_material          — „Add Material": alle Positionen in EINER Transaktion
//   orders.add_cost               — „Add Cost": Kostenzeilen (+ A/P, + Gramm-Schuld) in EINER Transaktion
//   orders.remove_cost            — eine Kostenzeile löschen, samt Ausgabe und offener Gramm-Schuld
//
// Der Rumpf ist ein Wunsch: Kennungen, Filiale, Benutzer, Fassungen, Zustände und alles, was das
// Haus selbst rechnet (erfüllte/offene Gramm, Äquivalente, Feingold, Spot, Schmelzwert, Ausgabe,
// Guthaben, Buchung, Zahlungsart, Kategorie, Lieferantenname), stehen auf der Verbotsliste; ein
// unbekanntes Feld wird abgewiesen statt ignoriert. Wer einen bestehenden Gold- oder Belegstand
// ändert, nennt die Fassung, die er gesehen hat — verglichen wird IN der Transaktion.
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
  FinancialPayloadError, expectedRevisionOf, isPlain, optText, positive, reqString,
} from './financial-commands';
import {
  CREDIT_SETTLE_MODES, GoldRejected, PAYABLE_SETTLE_MODES, settleCustomerGoldCredit, settleGoldPayable,
  type CreditSettleMode, type CreditSettleRequest, type GoldActor, type PayableSettleMode, type PayableSettleRequest,
} from '@/core/gold/gold-settle';
import {
  GOLD_LEFTOVER_DESTINATIONS, addOrderCostInHouse, addRepairMaterialInHouse, recordRepairGoldUsageInHouse,
  removeOrderCostInHouse,
  type GoldLeftover, type MaterialRowInput, type OrderCostRemoveRequest, type OrderCostRequest,
  type RepairGoldUsageRequest, type RepairMaterialRequest,
} from '@/core/gold/gold-house';

export const OP_GOLD_PAYABLES_SETTLE = 'gold.payables.settle';
export const OP_GOLD_CUSTOMER_CREDITS_SETTLE = 'gold.customer_credits.settle';
export const OP_REPAIRS_RECORD_GOLD_USAGE = 'repairs.record_gold_usage';
export const OP_REPAIRS_ADD_MATERIAL = 'repairs.add_material';
export const OP_ORDERS_ADD_COST = 'orders.add_cost';
export const OP_ORDERS_REMOVE_COST = 'orders.remove_cost';

export const GOLD_OPS = [
  OP_GOLD_PAYABLES_SETTLE, OP_GOLD_CUSTOMER_CREDITS_SETTLE, OP_REPAIRS_RECORD_GOLD_USAGE,
  OP_REPAIRS_ADD_MATERIAL, OP_ORDERS_ADD_COST, OP_ORDERS_REMOVE_COST,
] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class GoldPayloadError extends Error {
  readonly code = 'GOLD_PAYLOAD_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'GoldPayloadError';
  }
}

/** Was der Client nie nennt: wer, wo, wann, welche Fassung, welcher Zustand. */
const IDENTITY_FIELDS = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status'];
/** Was das Haus rechnet oder festlegt — Gramm-Stände, Umrechnung, Geld, Buchung. */
const DERIVED_FIELDS = [
  'fulfilledGrams', 'openGrams', 'remainingGrams', 'targetGrams', 'targetEquivalent', 'appliedGrams',
  'pureGrams', 'pureGoldGrams', 'fineGrams', 'fineWeight', 'purity', 'meltValue', 'spot', 'spotPrice', 'bhdPerGram', 'goldRate',
  'expenseId', 'expenseNumber', 'settlementExpenseId', 'settlementCreditId', 'customerCreditId', 'goldPayableId', 'goldCreditId',
  'direction', 'paymentMethod', 'method', 'category', 'paymentStatus',
  'ledger', 'ledgerEntries', 'account', 'debit', 'credit', 'amount', 'balance',
];
/** Auf Ebene einer Begleichung: das Gewicht der Schuld selbst gehört dem Haus. */
const SETTLE_FORBIDDEN = [...IDENTITY_FIELDS, ...DERIVED_FIELDS, 'weightGrams', 'karat', 'supplierId', 'customerId', 'settlementType'];
/** Auf Ebene einer Position: Name, Zeilenbetrag und Buchungsdaten legt das Haus fest. */
const ROW_FORBIDDEN = [
  ...IDENTITY_FIELDS, ...DERIVED_FIELDS, 'supplierName', 'costAmount', 'unitPrice', 'lineTotal', 'customerPrice',
  'position', 'lineId', 'isCustomerFacing', 'materialDetails', 'workType', 'taxScheme', 'vatRate', 'productId',
];
const COMMAND_FORBIDDEN = [...IDENTITY_FIELDS, ...DERIVED_FIELDS, 'lineIds', 'goldPayableIds', 'expenseIds'];

function strict(raw: unknown, allowed: readonly string[], forbidden: readonly string[], what = 'payload'): Record<string, unknown> {
  if (!isPlain(raw)) throw new GoldPayloadError(`${what} must be an object`);
  for (const k of Object.keys(raw)) {
    if (forbidden.includes(k) && !allowed.includes(k)) throw new GoldPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new GoldPayloadError(`unknown field: ${what === 'payload' ? '' : what + '.'}${k}`);
  }
  return raw;
}

/** Die geteilten Rumpf-Prüfer (financial-commands) melden sich hier mit dem Code dieser Datei. */
function feld<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof FinancialPayloadError) throw new GoldPayloadError(e.message);
    throw e;
  }
}

function optNumber(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new GoldPayloadError(`${name} must be a number`);
  return v;
}

function optStr(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new GoldPayloadError(`${name} must be text`);
  return v;
}

function absent(r: Record<string, unknown>, keys: readonly string[], why: string): void {
  for (const k of keys) if (r[k] !== undefined) throw new GoldPayloadError(`${k} does not belong here — ${why}`);
}

// ── gold.payables.settle ──────────────────────────────────────────────────

export function parsePayableSettle(raw: unknown): PayableSettleRequest {
  const r = strict(raw, ['payableId', 'expectedRevision', 'mode', 'grams', 'sourceKarat', 'agreedBhd', 'notes'], SETTLE_FORBIDDEN);
  const mode = r.mode as PayableSettleMode;
  if (!PAYABLE_SETTLE_MODES.includes(mode)) throw new GoldPayloadError(`mode is one of ${PAYABLE_SETTLE_MODES.join(', ')}`);
  const out: PayableSettleRequest = {
    payableId: feld(() => reqString(r.payableId, 'payableId')),
    expectedRevision: feld(() => expectedRevisionOf(r.expectedRevision)),
    mode,
    notes: feld(() => optText(r.notes, 'notes')),
  };
  if (mode === 'money') {
    absent(r, ['grams', 'sourceKarat'], 'converting to money names only the agreed BHD');
    out.agreedBhd = feld(() => positive(r.agreedBhd, 'agreedBhd'));
  } else {
    absent(r, ['agreedBhd'], 'settling in gold names grams');
    out.grams = feld(() => positive(r.grams, 'grams'));
    if (mode === 'return_gold') absent(r, ['sourceKarat'], 'returned gold is in the karat of the payable');
    else out.sourceKarat = optStr(r.sourceKarat, 'sourceKarat');
  }
  return out;
}

// ── gold.customer_credits.settle ─────────────────────────────────────────

export function parseCreditSettle(raw: unknown): CreditSettleRequest {
  const r = strict(raw, ['creditId', 'expectedRevision', 'mode', 'grams', 'agreedBhd', 'notes'], SETTLE_FORBIDDEN);
  const mode = r.mode as CreditSettleMode;
  if (!CREDIT_SETTLE_MODES.includes(mode)) throw new GoldPayloadError(`mode is one of ${CREDIT_SETTLE_MODES.join(', ')}`);
  const out: CreditSettleRequest = {
    creditId: feld(() => reqString(r.creditId, 'creditId')),
    expectedRevision: feld(() => expectedRevisionOf(r.expectedRevision)),
    mode,
    notes: feld(() => optText(r.notes, 'notes')),
  };
  if (mode === 'money') {
    absent(r, ['grams'], 'converting to money names only the agreed BHD');
    out.agreedBhd = feld(() => positive(r.agreedBhd, 'agreedBhd'));
  } else {
    absent(r, ['agreedBhd'], 'returning gold names grams');
    out.grams = feld(() => positive(r.grams, 'grams'));
  }
  return out;
}

// ── repairs.record_gold_usage ─────────────────────────────────────────────

export function parseRepairGoldUsage(raw: unknown): RepairGoldUsageRequest {
  const r = strict(raw, ['repairId', 'expectedRevision', 'source', 'supplierId', 'karat', 'receivedGrams', 'usedGrams', 'leftover', 'settlementType'],
    [...IDENTITY_FIELDS, ...DERIVED_FIELDS, 'leftoverGrams', 'shopKeptGrams', 'customerId', 'weightGrams']);
  const source = r.source;
  if (source !== 'workshop' && source !== 'customer') throw new GoldPayloadError('source is workshop or customer');
  const karat = optStr(r.karat, 'karat');
  if (!karat) throw new GoldPayloadError('karat is required');
  const out: RepairGoldUsageRequest = {
    repairId: feld(() => reqString(r.repairId, 'repairId')),
    expectedRevision: feld(() => expectedRevisionOf(r.expectedRevision)),
    source, karat,
    receivedGrams: feld(() => positive(r.receivedGrams, 'receivedGrams')),
  };
  if (source === 'workshop') {
    absent(r, ['usedGrams', 'leftover'], 'workshop gold becomes a gold payable in full');
    out.supplierId = feld(() => reqString(r.supplierId, 'supplierId'));
    const st = optStr(r.settlementType, 'settlementType');
    if (st !== undefined) out.settlementType = st as RepairGoldUsageRequest['settlementType'];
  } else {
    absent(r, ['supplierId', 'settlementType'], 'customer gold has no supplier');
    const used = optNumber(r.usedGrams, 'usedGrams');
    if (used !== undefined) {
      if (used < 0) throw new GoldPayloadError('usedGrams must not be negative');
      out.usedGrams = used;
    }
    const lo = optStr(r.leftover, 'leftover');
    if (lo === undefined || !GOLD_LEFTOVER_DESTINATIONS.includes(lo as GoldLeftover)) {
      throw new GoldPayloadError(`leftover is one of ${GOLD_LEFTOVER_DESTINATIONS.join(', ')}`);
    }
    out.leftover = lo as GoldLeftover;
  }
  return out;
}

// ── repairs.add_material / orders.add_cost ────────────────────────────────

const ROW_FIELDS = ['materialKind', 'description', 'quantity', 'caratPerPiece', 'weightGrams', 'karat', 'totalCost', 'supplierId'];

function parseRow(raw: unknown, i: number): MaterialRowInput {
  const at = `rows[${i}]`;
  const r = strict(raw, ROW_FIELDS, ROW_FORBIDDEN, at);
  const kind = optStr(r.materialKind, `${at}.materialKind`);
  if (!kind) throw new GoldPayloadError(`${at}.materialKind is required`);
  const description = optStr(r.description, `${at}.description`);
  if (description === undefined) throw new GoldPayloadError(`${at}.description is required`);
  const supplierId = optStr(r.supplierId, `${at}.supplierId`);
  if (!supplierId) throw new GoldPayloadError(`${at}.supplierId is required — a supplier id or "__INHOUSE__"`);
  const out: MaterialRowInput = {
    materialKind: kind, description, supplierId,
    totalCost: feld(() => positive(r.totalCost, `${at}.totalCost`)),
  };
  const q = optNumber(r.quantity, `${at}.quantity`); if (q !== undefined) out.quantity = q;
  const ct = optNumber(r.caratPerPiece, `${at}.caratPerPiece`); if (ct !== undefined) out.caratPerPiece = ct;
  const g = optNumber(r.weightGrams, `${at}.weightGrams`); if (g !== undefined) out.weightGrams = g;
  const k = optStr(r.karat, `${at}.karat`); if (k !== undefined) out.karat = k;
  return out;
}

function parseRows(v: unknown): MaterialRowInput[] {
  if (!Array.isArray(v) || v.length === 0) throw new GoldPayloadError('rows must name at least one position');
  return v.map(parseRow);
}

export function parseRepairMaterial(raw: unknown): RepairMaterialRequest {
  const r = strict(raw, ['repairId', 'expectedRevision', 'rows'], COMMAND_FORBIDDEN);
  return {
    repairId: feld(() => reqString(r.repairId, 'repairId')),
    expectedRevision: feld(() => expectedRevisionOf(r.expectedRevision)),
    rows: parseRows(r.rows),
  };
}

export function parseOrderCost(raw: unknown): OrderCostRequest {
  const r = strict(raw, ['orderId', 'expectedRevision', 'rows'], COMMAND_FORBIDDEN);
  return {
    orderId: feld(() => reqString(r.orderId, 'orderId')),
    expectedRevision: feld(() => expectedRevisionOf(r.expectedRevision)),
    rows: parseRows(r.rows),
  };
}

// ── orders.remove_cost ────────────────────────────────────────────────────

export function parseOrderCostRemove(raw: unknown): OrderCostRemoveRequest {
  const r = strict(raw, ['orderId', 'expectedRevision', 'lineId'], COMMAND_FORBIDDEN);
  return {
    orderId: feld(() => reqString(r.orderId, 'orderId')),
    expectedRevision: feld(() => expectedRevisionOf(r.expectedRevision)),
    lineId: feld(() => reqString(r.lineId, 'lineId')),
  };
}

// ── Die Läufe ──────────────────────────────────────────────────────────────

export function goldDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

/** Das Nein der Hausfolge wird ein eingefrorenes Urteil — dieselbe Antwort wie am Primary. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof GoldRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

/** In der Filiale, deren Bücher dieser Rechner führt — als der geprüfte Absender. */
function inHouse<T>(identity: CommandIdentity, fn: (actor: GoldActor) => T): T {
  assertHouseBranch(identity);
  return urteil(() => fn({ branchId: identity.branchId, userId: identity.userId }));
}

export function runGoldPayableSettle(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parsePayableSettle(raw);
  return runRemoteCommand(deps, identity, () => inHouse(identity, (a) => settleGoldPayable(a, req)));
}

export function runGoldCreditSettle(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseCreditSettle(raw);
  return runRemoteCommand(deps, identity, () => inHouse(identity, (a) => settleCustomerGoldCredit(a, req)));
}

export function runRepairGoldUsage(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRepairGoldUsage(raw);
  return runRemoteCommand(deps, identity, () => inHouse(identity, (a) => recordRepairGoldUsageInHouse(a, req)));
}

export function runRepairMaterial(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseRepairMaterial(raw);
  return runRemoteCommand(deps, identity, () => inHouse(identity, (a) => addRepairMaterialInHouse(a, req)));
}

export function runOrderCost(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseOrderCost(raw);
  return runRemoteCommand(deps, identity, () => inHouse(identity, (a) => addOrderCostInHouse(a, req)));
}

export function runOrderCostRemove(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const req = parseOrderCostRemove(raw);
  return runRemoteCommand(deps, identity, () => inHouse(identity, (a) => removeOrderCostInHouse(a, req)));
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(goldDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof GoldPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_GOLD_PAYABLES_SETTLE, { kind: 'mutation', handler: (p, a) => execute(runGoldPayableSettle, OP_GOLD_PAYABLES_SETTLE, p, a) });
registerCommand(OP_GOLD_CUSTOMER_CREDITS_SETTLE, { kind: 'mutation', handler: (p, a) => execute(runGoldCreditSettle, OP_GOLD_CUSTOMER_CREDITS_SETTLE, p, a) });
registerCommand(OP_REPAIRS_RECORD_GOLD_USAGE, { kind: 'mutation', handler: (p, a) => execute(runRepairGoldUsage, OP_REPAIRS_RECORD_GOLD_USAGE, p, a) });
registerCommand(OP_REPAIRS_ADD_MATERIAL, { kind: 'mutation', handler: (p, a) => execute(runRepairMaterial, OP_REPAIRS_ADD_MATERIAL, p, a) });
registerCommand(OP_ORDERS_ADD_COST, { kind: 'mutation', handler: (p, a) => execute(runOrderCost, OP_ORDERS_ADD_COST, p, a) });
registerCommand(OP_ORDERS_REMOVE_COST, { kind: 'mutation', handler: (p, a) => execute(runOrderCostRemove, OP_ORDERS_REMOVE_COST, p, a) });
