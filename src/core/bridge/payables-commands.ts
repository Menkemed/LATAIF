// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Verbindlichkeiten vom zweiten Rechner: Ausgaben, Dauerauftraege,
// Einkaufszahlungen, Lieferanten-Guthaben und Sammelzahlung.
//
// Derselbe Bau wie bei den Stammdaten (`masterdata-commands.ts`) und der Inventur:
//
//  1. **Keine zweite Logik.** Jeder Befehl ruft die Hausfolge (`payables-house.ts`), die auch die
//     Maske des Primary ruft — dieselbe Regel, derselbe Code, dieselbe Buchung.
//  2. **Der Rumpf ist ein Wunsch.** Kennung, Filiale, Benutzer, Zeitstempel, Fassung und alles, was
//     das Haus ableitet (Bezahltes, Rest, Status, Belegnummer, Erstzahlung, FIFO-Zuordnung,
//     Guthabenzeilen, Buchungskonten), stehen auf der Verbotsliste; ein unbekanntes Feld wird
//     abgewiesen statt ignoriert.
//  3. **Aendern und Bezahlen nennen die gesehene FASSUNG** (Ausgabe, Vorlage, Einkauf) — verglichen
//     INNERHALB der Transaktion. Anlegen nicht. Sammelzahlung und Guthaben-Einloesung haben keinen
//     einzelnen Datensatz: dort prueft das Haus frisch, dass der Betrag ganz passt (nie still kappen).
//  4. **Eine fachliche Aktion, ein Befehl.** „Pause"/„Resume" ist `expenses.template_update` mit dem
//     Zielwert `active`, kein Umschalter; der Guthaben-Modus von „Pay Supplier" ist `suppliers.apply_credit`.
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
  PAYABLES_OP, PayablesRejected, EXPENSE_EDIT_FIELDS, TEMPLATE_EDIT_FIELDS,
  expenseCreateIntent, expenseEditFields, templateCreateIntent, templateEditFields,
  createExpenseFromIntent, updateExpenseInHouse, recordExpensePaymentInHouse,
  createTemplateInHouse, updateTemplateInHouse,
  recordPurchasePaymentInHouse, applyCreditToPurchaseInHouse,
  refundStandaloneCreditInHouse, paySupplierInHouse, applySupplierCreditToExpensesInHouse,
  type HouseCtx,
} from '@/core/payables/payables-house';

export const OP_EXPENSES_CREATE = PAYABLES_OP.EXPENSES_CREATE;
export const OP_EXPENSES_UPDATE = PAYABLES_OP.EXPENSES_UPDATE;
export const OP_EXPENSES_RECORD_PAYMENT = PAYABLES_OP.EXPENSES_RECORD_PAYMENT;
export const OP_EXPENSES_TEMPLATE_CREATE = PAYABLES_OP.EXPENSES_TEMPLATE_CREATE;
export const OP_EXPENSES_TEMPLATE_UPDATE = PAYABLES_OP.EXPENSES_TEMPLATE_UPDATE;
export const OP_PURCHASES_RECORD_PAYMENT = PAYABLES_OP.PURCHASES_RECORD_PAYMENT;
export const OP_PURCHASES_APPLY_CREDIT = PAYABLES_OP.PURCHASES_APPLY_CREDIT;
export const OP_SUPPLIERS_REFUND_CREDIT = PAYABLES_OP.SUPPLIERS_REFUND_CREDIT;
export const OP_SUPPLIERS_PAY = PAYABLES_OP.SUPPLIERS_PAY;
export const OP_SUPPLIERS_APPLY_CREDIT = PAYABLES_OP.SUPPLIERS_APPLY_CREDIT;

export const PAYABLES_OPS = Object.values(PAYABLES_OP);

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Stoerung. Der Client korrigiert und schickt neu. */
export class PayablesPayloadError extends Error {
  readonly code = 'PAYABLES_PAYLOAD_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'PayablesPayloadError';
  }
}

/**
 * Was ein Client nie nennt — ausser dort, wo ein Feld ausdruecklich erlaubt ist (dann ist es Eingabe,
 * z. B. `creditId` beim Refund). Jede dieser Angaben waere ein Weg, dem Primary eine Wirkung
 * vorzuschreiben, die er selbst bestimmt.
 */
export const PAYABLES_FORBIDDEN = [
  'id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status',
  // Eine neue Vorlage ist im Haus IMMER aktiv; umschalten ist `template_update` mit dem Zielwert.
  'active',
  'expenseNumber', 'purchaseNumber', 'documentNumber', 'paidAmount', 'paid', 'initialPaid', 'payNow',
  'remaining', 'remainingAmount', 'openAmount', 'totalAmount', 'settled', 'settledAmount', 'creditPaid',
  'usedAmount', 'available', 'availableAmount', 'balance', 'creditBalance', 'outstandingBalance',
  'paymentStatus', 'payment_status', 'lastGeneratedPeriod', 'paidAt', 'excess', 'excessAmount', 'overpayCredit',
  'relatedModule', 'relatedEntityId', 'recurringTemplateId', 'supplierId', 'employeeId', 'creditId', 'paymentId',
  'ledger', 'entries', 'postings', 'account', 'debit', 'credit', 'direction', 'sourceModule', 'sourceId', 'transactionId',
];

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], what = 'payload'): Record<string, unknown> {
  if (!isPlain(raw)) throw new PayablesPayloadError(`${what} must be an object`);
  for (const k of Object.keys(raw)) {
    if (allowed.includes(k)) continue;
    if (PAYABLES_FORBIDDEN.includes(k)) throw new PayablesPayloadError(`the primary decides ${k}, not the client`);
    throw new PayablesPayloadError(`unknown field: ${k}`);
  }
  return raw;
}
function idOf(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new PayablesPayloadError(`${name} is required`);
  return v;
}
function numberOf(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new PayablesPayloadError(`${name} must be a number`);
  return v;
}
function textOrAbsent(v: unknown, name: string): void {
  if (v !== undefined && v !== null && typeof v !== 'string') throw new PayablesPayloadError(`${name} must be text`);
}
function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new PayablesPayloadError('expectedRevision is required — a money action must say which revision it saw');
  }
  return v;
}
function somethingOf(r: Record<string, unknown>, fields: readonly string[]): void {
  if (!fields.some((f) => r[f] !== undefined)) throw new PayablesPayloadError('an edit must change something');
}

/** Das Urteil des Hauses wird eingefroren — dasselbe Nein, mit demselben Code, wie am Primary. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PayablesRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

function ctxOf(identity: CommandIdentity, deps: EngineDeps): HouseCtx {
  return { branchId: identity.branchId, userId: identity.userId, now: deps.now() };
}

// ── Die Rumpfpruefungen (nur Form; die Regeln prueft das Haus) ────────────

const EXPENSE_CREATE_FIELDS = ['category', 'amount', 'paymentMethod', 'expenseDate', 'description', 'timing', 'partialAmount', 'employeeId', 'supplierId'];
export function parseExpenseCreate(raw: unknown): Record<string, unknown> {
  const r = strict(raw, EXPENSE_CREATE_FIELDS);
  numberOf(r.amount, 'amount');
  if (r.partialAmount !== undefined) numberOf(r.partialAmount, 'partialAmount');
  for (const k of ['category', 'paymentMethod', 'expenseDate', 'timing']) idOf(r[k], k);
  for (const k of ['description', 'employeeId', 'supplierId']) textOrAbsent(r[k], k);
  return r;
}

export function parseExpenseUpdate(raw: unknown): { expenseId: string; expectedRevision: number; fields: Record<string, unknown> } {
  const r = strict(raw, ['expenseId', 'expectedRevision', ...EXPENSE_EDIT_FIELDS]);
  const fields: Record<string, unknown> = {};
  for (const k of EXPENSE_EDIT_FIELDS) if (r[k] !== undefined) fields[k] = r[k];
  somethingOf(fields, EXPENSE_EDIT_FIELDS);
  if (fields.amount !== undefined) numberOf(fields.amount, 'amount');
  return { expenseId: idOf(r.expenseId, 'expenseId'), expectedRevision: revisionOf(r.expectedRevision), fields };
}

export function parseExpensePayment(raw: unknown): { expenseId: string; expectedRevision: number; amount: number; method: string } {
  const r = strict(raw, ['expenseId', 'expectedRevision', 'amount', 'method']);
  return {
    expenseId: idOf(r.expenseId, 'expenseId'), expectedRevision: revisionOf(r.expectedRevision),
    amount: numberOf(r.amount, 'amount'), method: idOf(r.method, 'method'),
  };
}

const TEMPLATE_CREATE_FIELDS = ['category', 'amount', 'paymentMethod', 'payNowDefault', 'description', 'dayOfMonth', 'startDate', 'endDate', 'employeeId'];
export function parseTemplateCreate(raw: unknown): Record<string, unknown> {
  const r = strict(raw, TEMPLATE_CREATE_FIELDS);
  numberOf(r.amount, 'amount');
  numberOf(r.dayOfMonth, 'dayOfMonth');
  for (const k of ['category', 'paymentMethod', 'startDate']) idOf(r[k], k);
  for (const k of ['description', 'endDate', 'employeeId']) textOrAbsent(r[k], k);
  return r;
}

export function parseTemplateUpdate(raw: unknown): { templateId: string; expectedRevision: number; fields: Record<string, unknown> } {
  const r = strict(raw, ['templateId', 'expectedRevision', ...TEMPLATE_EDIT_FIELDS]);
  const fields: Record<string, unknown> = {};
  for (const k of TEMPLATE_EDIT_FIELDS) if (r[k] !== undefined) fields[k] = r[k];
  somethingOf(fields, TEMPLATE_EDIT_FIELDS);
  return { templateId: idOf(r.templateId, 'templateId'), expectedRevision: revisionOf(r.expectedRevision), fields };
}

export function parsePurchasePayment(raw: unknown): { purchaseId: string; expectedRevision: number; amount: number; method: string; reference?: string; note?: string } {
  const r = strict(raw, ['purchaseId', 'expectedRevision', 'amount', 'method', 'reference', 'note']);
  textOrAbsent(r.reference, 'reference');
  textOrAbsent(r.note, 'note');
  return {
    purchaseId: idOf(r.purchaseId, 'purchaseId'), expectedRevision: revisionOf(r.expectedRevision),
    amount: numberOf(r.amount, 'amount'), method: idOf(r.method, 'method'),
    reference: typeof r.reference === 'string' && r.reference ? r.reference : undefined,
    note: typeof r.note === 'string' && r.note ? r.note : undefined,
  };
}

export function parsePurchaseCredit(raw: unknown): { purchaseId: string; expectedRevision: number; amount: number } {
  const r = strict(raw, ['purchaseId', 'expectedRevision', 'amount']);
  return { purchaseId: idOf(r.purchaseId, 'purchaseId'), expectedRevision: revisionOf(r.expectedRevision), amount: numberOf(r.amount, 'amount') };
}

export function parseSupplierRefund(raw: unknown): { creditId: string } {
  const r = strict(raw, ['creditId']);
  return { creditId: idOf(r.creditId, 'creditId') };
}

export function parseSupplierPay(raw: unknown): {
  supplierId: string; amount: number; method: string; mode: 'fifo' | 'manual';
  allocations?: Array<{ kind: 'expense' | 'purchase'; id: string; amount: number }>;
} {
  const r = strict(raw, ['supplierId', 'amount', 'method', 'mode', 'allocations']);
  const mode = r.mode;
  if (mode !== 'fifo' && mode !== 'manual') throw new PayablesPayloadError('mode is fifo or manual');
  let allocations: Array<{ kind: 'expense' | 'purchase'; id: string; amount: number }> | undefined;
  if (r.allocations !== undefined) {
    if (!Array.isArray(r.allocations) || r.allocations.length > 500) throw new PayablesPayloadError('allocations must be a list');
    allocations = r.allocations.map((a) => {
      const x = strict(a, ['kind', 'id', 'amount'], 'an allocation');
      if (x.kind !== 'expense' && x.kind !== 'purchase') throw new PayablesPayloadError('an allocation is for an expense or a purchase');
      return { kind: x.kind, id: idOf(x.id, 'id'), amount: numberOf(x.amount, 'amount') };
    });
  }
  if (mode === 'fifo' && allocations) throw new PayablesPayloadError('FIFO: the primary decides the allocation');
  if (mode === 'manual' && !allocations?.length) throw new PayablesPayloadError('a manual payment names its allocations');
  return { supplierId: idOf(r.supplierId, 'supplierId'), amount: numberOf(r.amount, 'amount'), method: idOf(r.method, 'method'), mode, allocations };
}

export function parseSupplierCredit(raw: unknown): { supplierId: string; amount: number } {
  const r = strict(raw, ['supplierId', 'amount']);
  return { supplierId: idOf(r.supplierId, 'supplierId'), amount: numberOf(r.amount, 'amount') };
}

// ── Die Laeufe ─────────────────────────────────────────────────────────────

export function payablesDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

/** Die gemeinsame Klammer: Filiale des Hauses, dann die Hausfolge — ihr Nein wird eingefroren. */
function lauf<T>(deps: EngineDeps, identity: CommandIdentity, fn: (ctx: HouseCtx) => T): Promise<CommandOutcome> {
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    return urteil(() => fn(ctxOf(identity, deps)));
  });
}

export const runExpenseCreate: Run = (deps, identity, raw) => {
  const body = parseExpenseCreate(raw);
  return lauf(deps, identity, (ctx) => createExpenseFromIntent(expenseCreateIntent(body), ctx));
};

export const runExpenseUpdate: Run = (deps, identity, raw) => {
  const req = parseExpenseUpdate(raw);
  return lauf(deps, identity, (ctx) => updateExpenseInHouse(req.expenseId, expenseEditFields(req.fields), ctx, req.expectedRevision));
};

export const runExpensePayment: Run = (deps, identity, raw) => {
  const req = parseExpensePayment(raw);
  return lauf(deps, identity, (ctx) => recordExpensePaymentInHouse(req.expenseId, req.amount, req.method, ctx, { expectedRevision: req.expectedRevision }));
};

export const runTemplateCreate: Run = (deps, identity, raw) => {
  const body = parseTemplateCreate(raw);
  return lauf(deps, identity, (ctx) => createTemplateInHouse(templateCreateIntent(body), ctx));
};

export const runTemplateUpdate: Run = (deps, identity, raw) => {
  const req = parseTemplateUpdate(raw);
  return lauf(deps, identity, (ctx) => updateTemplateInHouse(req.templateId, templateEditFields(req.fields), ctx, req.expectedRevision));
};

export const runPurchasePayment: Run = (deps, identity, raw) => {
  const req = parsePurchasePayment(raw);
  return lauf(deps, identity, (ctx) => recordPurchasePaymentInHouse(req.purchaseId, req.amount, req.method, ctx,
    { expectedRevision: req.expectedRevision, reference: req.reference, note: req.note }));
};

export const runPurchaseCredit: Run = (deps, identity, raw) => {
  const req = parsePurchaseCredit(raw);
  return lauf(deps, identity, (ctx) => applyCreditToPurchaseInHouse(req.purchaseId, req.amount, ctx, req.expectedRevision));
};

export const runSupplierRefund: Run = (deps, identity, raw) => {
  const req = parseSupplierRefund(raw);
  return lauf(deps, identity, (ctx) => refundStandaloneCreditInHouse(req.creditId, ctx));
};

export const runSupplierPay: Run = (deps, identity, raw) => {
  const req = parseSupplierPay(raw);
  return lauf(deps, identity, (ctx) => paySupplierInHouse(req, ctx));
};

export const runSupplierCredit: Run = (deps, identity, raw) => {
  const req = parseSupplierCredit(raw);
  return lauf(deps, identity, (ctx) => applySupplierCreditToExpensesInHouse(req.supplierId, req.amount, ctx));
};

// ── Die Anmeldung ─────────────────────────────────────────────────────────

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(payablesDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof PayablesPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

// Jede Buchung einzeln angemeldet — dieselbe Form wie in allen anderen Befehlsmodulen (das Gate zählt sie).
registerCommand(OP_EXPENSES_CREATE, { kind: 'mutation', handler: (p, a) => execute(runExpenseCreate, OP_EXPENSES_CREATE, p, a) });
registerCommand(OP_EXPENSES_UPDATE, { kind: 'mutation', handler: (p, a) => execute(runExpenseUpdate, OP_EXPENSES_UPDATE, p, a) });
registerCommand(OP_EXPENSES_RECORD_PAYMENT, { kind: 'mutation', handler: (p, a) => execute(runExpensePayment, OP_EXPENSES_RECORD_PAYMENT, p, a) });
registerCommand(OP_EXPENSES_TEMPLATE_CREATE, { kind: 'mutation', handler: (p, a) => execute(runTemplateCreate, OP_EXPENSES_TEMPLATE_CREATE, p, a) });
registerCommand(OP_EXPENSES_TEMPLATE_UPDATE, { kind: 'mutation', handler: (p, a) => execute(runTemplateUpdate, OP_EXPENSES_TEMPLATE_UPDATE, p, a) });
registerCommand(OP_PURCHASES_RECORD_PAYMENT, { kind: 'mutation', handler: (p, a) => execute(runPurchasePayment, OP_PURCHASES_RECORD_PAYMENT, p, a) });
registerCommand(OP_PURCHASES_APPLY_CREDIT, { kind: 'mutation', handler: (p, a) => execute(runPurchaseCredit, OP_PURCHASES_APPLY_CREDIT, p, a) });
registerCommand(OP_SUPPLIERS_PAY, { kind: 'mutation', handler: (p, a) => execute(runSupplierPay, OP_SUPPLIERS_PAY, p, a) });
registerCommand(OP_SUPPLIERS_APPLY_CREDIT, { kind: 'mutation', handler: (p, a) => execute(runSupplierCredit, OP_SUPPLIERS_APPLY_CREDIT, p, a) });
registerCommand(OP_SUPPLIERS_REFUND_CREDIT, { kind: 'mutation', handler: (p, a) => execute(runSupplierRefund, OP_SUPPLIERS_REFUND_CREDIT, p, a) });
