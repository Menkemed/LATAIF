// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Geld ohne Beleg vom zweiten Rechner: Steuerzahlung, Umbuchung,
// Gesellschafterbewegung, Darlehen anlegen / zurückzahlen / berichtigen.
//
// Derselbe Bau wie bei den Stammdaten (`masterdata-commands.ts`) und der Inventur:
//
//  1. **Keine zweite Geldlogik.** Jeder Befehl ruft die Hausfolge, die auch die Maske des Primary
//     ruft (`money-house.ts`): dieselbe Prüfung, dieselbe Zeile, dieselbe Buchung, in der
//     Transaktion des Auftrags. Scheitert die Buchung, gibt es auch die Zeile nicht.
//  2. **Der Rumpf ist ein Wunsch.** Kennung, Filiale, Benutzer, Zeitstempel, Status und alles, was
//     das Haus rechnet oder vergibt (Belegnummer, Zahlstatus, Gegenpartei aus dem Kunden, Gezahltes,
//     Rest, Konten, Soll/Haben), stehen namentlich auf der Verbotsliste; ein unbekanntes Feld wird
//     abgewiesen statt ignoriert.
//  3. **Ändern braucht die gesehene Fassung.** Ein bestehendes Darlehen zurückzahlen oder berichtigen
//     nennt `expectedRevision`; verglichen wird INNERHALB der Transaktion. Anlegen braucht keine.
//
// Bewusst NICHT dabei: Löschen einer Umbuchung oder Gesellschafterbewegung, Stornieren oder Löschen
// eines Darlehens, „als bezahlt markieren" einer Gesellschafterbewegung — das bleibt am Primary.
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
  MoneyRejected,
  bankTransferInput, createBankTransferInHouse, createDebtInHouse, debtCreateInput, debtPaymentInput,
  debtUpdateInput, partnerTxInput, recordDebtPaymentInHouse, recordPartnerTxInHouse, recordTaxPaymentInHouse,
  taxPaymentInput, updateDebtInHouse,
  type BankTransferInput, type DebtCreateInput, type DebtPaymentInput, type DebtUpdateInput, type MoneyCtx,
  type PartnerTxInput, type TaxPaymentInput,
} from '@/core/finance/money-house';

export const OP_TAX_RECORD_PAYMENT = 'tax.record_payment';
export const OP_BANKING_TRANSFER = 'banking.transfer';
export const OP_PARTNERS_RECORD_TX = 'partners.record_tx';
export const OP_DEBTS_CREATE = 'debts.create';
export const OP_DEBTS_UPDATE = 'debts.update';
export const OP_DEBTS_RECORD_PAYMENT = 'debts.record_payment';

export const MONEY_OPS = [
  OP_TAX_RECORD_PAYMENT, OP_BANKING_TRANSFER, OP_PARTNERS_RECORD_TX,
  OP_DEBTS_CREATE, OP_DEBTS_UPDATE, OP_DEBTS_RECORD_PAYMENT,
] as const;

/** Ein unbrauchbarer Rumpf — eine Antwort, keine Störung. Der Client korrigiert und schickt neu. */
export class MoneyPayloadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'MONEY_PAYLOAD_INVALID') {
    super(message);
    this.name = 'MoneyPayloadError';
    this.code = code;
  }
}

/** Was der Client nie setzt: wer, wo, wann, welche Kennung, welcher Zustand. */
const FORBIDDEN = ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status'];
/** Was nur das Hauptbuch schreibt — ein Rumpf bucht nie selbst. */
const LEDGER = ['ledger', 'entries', 'account', 'accounts', 'debit', 'credit', 'direction_dr', 'direction_cr',
  'sourceModule', 'sourceId', 'transactionId', 'entryNo', 'balance'];
/** Was das Haus selbst rechnet oder vergibt — je Befehl. */
export const MONEY_COMPUTED = {
  tax: ['paid', 'remaining', 'vat', 'inputVat', 'netVat', 'refund', 'taxPaymentId', ...LEDGER],
  transfer: ['transferId', 'from', 'to', ...LEDGER],
  partner: ['transactionNumber', 'paymentStatus', 'paidAtActual', 'transactionId', 'totalInvested', 'totalWithdrawn',
    'totalProfitShare', ...LEDGER],
  debtCreate: ['counterparty', 'loanNumber', 'paidAmount', 'remaining', 'settledAt', 'debtId', ...LEDGER],
  debtPayment: ['direction', 'paidAmount', 'remaining', 'settledAt', 'paymentId', 'loanNumber', 'counterparty', ...LEDGER],
  debtUpdate: ['loanNumber', 'paidAmount', 'remaining', 'settledAt', ...LEDGER],
} as const;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function strict(raw: unknown, allowed: readonly string[], computed: readonly string[]): Record<string, unknown> {
  if (!isPlain(raw)) throw new MoneyPayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k) || computed.includes(k)) throw new MoneyPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.includes(k)) throw new MoneyPayloadError(`unknown field: ${k}`);
  }
  return raw;
}

/** Die Eingaberegel als Prüfung des Rumpfs: ihr Nein kommt mit IHREM Code zurück — derselbe wie am Primary. */
function rule<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof MoneyRejected) throw new MoneyPayloadError(e.message, e.code);
    throw e;
  }
}

/** Dieselbe Folge INNERHALB des Auftrags: dort ist ihr Nein ein eingefrorenes Urteil. */
function urteil<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof MoneyRejected) throw new CommandRejected(e.code, e.message);
    throw e;
  }
}

function revisionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new MoneyPayloadError('expectedRevision is required — a money action on a loan must say which revision it saw');
  }
  return v;
}

const ctxOf = (identity: CommandIdentity): MoneyCtx => ({
  branchId: identity.branchId, userId: identity.userId, tenantId: identity.tenantId,
});

// ── Die Rümpfe ──────────────────────────────────────────────────────────────

export function parseTaxPayment(raw: unknown): TaxPaymentInput {
  const r = strict(raw, ['year', 'quarter', 'amount', 'source', 'paidAt', 'note'], MONEY_COMPUTED.tax);
  return rule(() => taxPaymentInput(r));
}

export function parseBankTransfer(raw: unknown): BankTransferInput {
  const r = strict(raw, ['direction', 'amount', 'transferDate', 'notes'], MONEY_COMPUTED.transfer);
  return rule(() => bankTransferInput(r));
}

export function parsePartnerTx(raw: unknown): PartnerTxInput {
  const r = strict(raw, ['partnerId', 'kind', 'amount', 'method', 'date', 'notes'], MONEY_COMPUTED.partner);
  return rule(() => partnerTxInput(r));
}

export function parseDebtCreate(raw: unknown): DebtCreateInput {
  const r = strict(raw, ['direction', 'customerId', 'amount', 'source', 'dueDate', 'notes', 'staffId'], MONEY_COMPUTED.debtCreate);
  return rule(() => debtCreateInput(r));
}

export function parseDebtPayment(raw: unknown): DebtPaymentInput & { expectedRevision: number } {
  const r = strict(raw, ['debtId', 'expectedRevision', 'amount', 'source', 'paidAt', 'notes'], MONEY_COMPUTED.debtPayment);
  const expectedRevision = revisionOf(r.expectedRevision);
  return { ...rule(() => debtPaymentInput(r)), expectedRevision };
}

export function parseDebtUpdate(raw: unknown): DebtUpdateInput & { expectedRevision: number } {
  const r = strict(raw, ['debtId', 'expectedRevision', 'counterparty', 'amount', 'dueDate', 'notes', 'source'], MONEY_COMPUTED.debtUpdate);
  const expectedRevision = revisionOf(r.expectedRevision);
  const input = rule(() => debtUpdateInput(r));
  if (Object.keys(input).filter((k) => k !== 'debtId' && k !== 'expectedRevision').length === 0) {
    throw new MoneyPayloadError('an edit must change something');
  }
  return { ...input, expectedRevision };
}

// ── Die Läufe ───────────────────────────────────────────────────────────────

export function moneyDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export function runTaxPayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseTaxPayment(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => recordTaxPaymentInHouse(input, ctxOf(identity)));
    return { ...r };
  });
}

export function runBankTransfer(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseBankTransfer(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const t = urteil(() => createBankTransferInHouse(input, ctxOf(identity)));
    return { transferId: t.id, direction: t.direction, amount: t.amount, transferDate: t.transferDate };
  });
}

export function runPartnerTx(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parsePartnerTx(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const tx = urteil(() => recordPartnerTxInHouse(input, ctxOf(identity)));
    return {
      transactionId: tx.id, transactionNumber: tx.transactionNumber, kind: tx.type, amount: tx.amount,
      method: tx.method, paymentStatus: tx.paymentStatus,
    };
  });
}

export function runDebtCreate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseDebtCreate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const { debt, revision } = urteil(() => createDebtInHouse(input, ctxOf(identity)));
    return { debtId: debt.id, loanNumber: debt.loanNumber ?? '', counterparty: debt.counterparty, status: debt.status, revision };
  });
}

export function runDebtPayment(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseDebtPayment(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => recordDebtPaymentInHouse(input, ctxOf(identity)));
    return {
      debtId: r.debtId, paymentId: r.payment.id, status: r.status,
      paidAmount: r.paidAmount, remaining: r.remaining, revision: r.revision,
    };
  });
}

export function runDebtUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const input = parseDebtUpdate(raw);
  return runRemoteCommand(deps, identity, () => {
    assertHouseBranch(identity);
    const r = urteil(() => updateDebtInHouse(input, ctxOf(identity)));
    return { debtId: r.debtId, status: r.status, amount: r.amount, source: r.source, revision: r.revision, reposted: r.reposted };
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

type Run = (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>;

async function execute(run: Run, op: string, payload: unknown, actor?: CommandActor): Promise<Record<string, unknown>> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(moneyDeps(), { ...actor, op }, body);
  } catch (err) {
    // Ein unbrauchbarer Rumpf ist eine Antwort: neu schicken mit einer NEUEN Kennung.
    if (err instanceof MoneyPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // Nur ein EINGEFRORENES Urteil ist ein fachliches Nein; alles andere ist ein offener Ausgang.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as Record<string, unknown>), replayed: outcome.replayed };
}

registerCommand(OP_TAX_RECORD_PAYMENT, { kind: 'mutation', handler: (p, a) => execute(runTaxPayment, OP_TAX_RECORD_PAYMENT, p, a) });
registerCommand(OP_BANKING_TRANSFER, { kind: 'mutation', handler: (p, a) => execute(runBankTransfer, OP_BANKING_TRANSFER, p, a) });
registerCommand(OP_PARTNERS_RECORD_TX, { kind: 'mutation', handler: (p, a) => execute(runPartnerTx, OP_PARTNERS_RECORD_TX, p, a) });
registerCommand(OP_DEBTS_CREATE, { kind: 'mutation', handler: (p, a) => execute(runDebtCreate, OP_DEBTS_CREATE, p, a) });
registerCommand(OP_DEBTS_UPDATE, { kind: 'mutation', handler: (p, a) => execute(runDebtUpdate, OP_DEBTS_UPDATE, p, a) });
registerCommand(OP_DEBTS_RECORD_PAYMENT, { kind: 'mutation', handler: (p, a) => execute(runDebtPayment, OP_DEBTS_RECORD_PAYMENT, p, a) });
