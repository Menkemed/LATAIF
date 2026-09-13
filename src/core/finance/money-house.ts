// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Geld, das ohne Beleg bewegt wird: Steuerzahlung, Umbuchung zwischen den
// Konten, Gesellschafterbewegung, Darlehen (anlegen, zurückzahlen, berichtigen). EINE Hausfolge für
// die Maske am Primary und für den Fernbefehl von PC2 — keine zweite Geldlogik.
//
// Was vorher geschah (auditiert, nicht angenommen):
//
//   • „Mark paid" (Steuer) schrieb die Zeile direkt aus der Seite, ohne Hauptbuch, mit der Filiale
//     aus dem Bildschirmzustand (Ersatz 'branch-main'); ein Fehler landete in der Konsole, und die
//     Maske schloss sich wie nach einem Erfolg. Ein leeres Datum wurde zu 'T00:00:00Z'.
//   • Umbuchung, Gesellschafterbewegung und Darlehen schrieben ihre Zeile, speicherten, und buchten
//     DANACH mit verschlucktem Fehler (`safePost`) — ein gescheiterter Post hinterließ eine Zeile
//     ohne Buchung.
//   • Eine Darlehensrückzahlung nahm jeden Betrag (auch über den Rest hinaus: Status REPAID, das
//     Darlehenskonto lief über null), auch auf ein storniertes oder schon getilgtes Darlehen, und
//     las Richtung und Betrag aus der GELADENEN Liste statt aus der Datenbank.
//   • Das Berichtigen eines Darlehens änderte Betrag oder Konto, aber nie die Buchung dazu (das
//     Hauptbuch lief auseinander), und ein storniertes Darlehen wurde dabei still wieder „offen".
//
// Jetzt gilt für jede Aktion dieselbe Reihenfolge: prüfen (aus der DATENBANK, in der Filiale des
// Auftrags), dann schreiben, dann buchen — alles INNERHALB der Transaktion des Aufrufers
// (`runOnPrimary` am Primary, `runRemoteCommand` für PC2). Eine gescheiterte Buchung wirft; nichts
// bleibt halb stehen. Diese Datei öffnet und schließt selbst keine Transaktion und speichert nicht
// durabel — mit einer Ausnahme für die alten, synchronen Store-Aufrufe (`moneyAction`).
//
// Jede Regel hier stammt aus einem vorhandenen Vertrag: der Maske (Pflichtfelder, gezeigte Auswahl),
// der Buchungsfunktion (Betrag > 0), der vorhandenen Store-Regel (Darlehen nie unter das Gezahlte)
// oder der Rechnung der Auswertung (welches Quartal noch offen ist). Erfunden ist keine.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { isClientMode } from '@/core/bridge/client-mode';
import { financeFor } from '@/core/reports/analytics-snapshot';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction, hasLedgerEntries,
  postBankTransfer, postLoanCancelled, postLoanCreated, postLoanPayment, postPartnerTransaction, postTaxPayment,
} from '@/core/ledger/posting';
import {
  canonicalLoanDirection, canonicalLoanStatus,
  type BankTransfer, type CashSource, type Debt, type DebtDirection, type DebtPayment, type DebtStatus,
  type PartnerTransaction, type PartnerTransactionType,
} from '@/core/models/types';

/** Ein fachliches Nein der Geldfolge — eingefroren, wenn es aus einem Fernauftrag kommt. */
export class MoneyRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MoneyRejected';
    this.code = code;
  }
}

export const MONEY_PRIMARY_ONLY = 'MONEY_PRIMARY_ONLY';
export const MONEY_NO_SESSION = 'MONEY_NO_SESSION';
export const MONEY_AMOUNT_INVALID = 'MONEY_AMOUNT_INVALID';
export const MONEY_DATE_INVALID = 'MONEY_DATE_INVALID';
export const MONEY_SOURCE_INVALID = 'MONEY_SOURCE_INVALID';
export const MONEY_TEXT_INVALID = 'MONEY_TEXT_INVALID';
export const MONEY_ID_REQUIRED = 'MONEY_ID_REQUIRED';
export const TAX_PERIOD_INVALID = 'TAX_PERIOD_INVALID';
export const TAX_QUARTER_SETTLED = 'TAX_QUARTER_SETTLED';
export const TAX_QUARTER_REFUND_DUE = 'TAX_QUARTER_REFUND_DUE';
export const BANK_TRANSFER_DIRECTION_INVALID = 'BANK_TRANSFER_DIRECTION_INVALID';
export const PARTNER_TX_KIND_INVALID = 'PARTNER_TX_KIND_INVALID';
export const PARTNER_NOT_FOUND = 'PARTNER_NOT_FOUND';
export const DEBT_DIRECTION_INVALID = 'DEBT_DIRECTION_INVALID';
export const CUSTOMER_REQUIRED = 'CUSTOMER_REQUIRED';
export const CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND';
export const EMPLOYEE_NOT_FOUND = 'EMPLOYEE_NOT_FOUND';
export const DEBT_NOT_FOUND = 'DEBT_NOT_FOUND';
export const DEBT_CANCELLED = 'DEBT_CANCELLED';
export const DEBT_REPAID = 'DEBT_REPAID';
export const DEBT_OVERPAYMENT = 'DEBT_OVERPAYMENT';
export const DEBT_AMOUNT_BELOW_PAID = 'DEBT_AMOUNT_BELOW_PAID';
export const DEBT_COUNTERPARTY_REQUIRED = 'DEBT_COUNTERPARTY_REQUIRED';
export const RECORD_CHANGED = 'RECORD_CHANGED';

// ── Wo gebucht wird ─────────────────────────────────────────────────────────

/** Die Filiale und der Mensch, in deren Namen gebucht wird: fern aus dem geprüften Ausweis, am Primary aus der Sitzung. */
export interface MoneyCtx {
  branchId: string;
  userId: string;
  tenantId?: string;
}

/**
 * Ein Rechner ohne Geschäftsdatenbank bucht hier nie — auch nicht über einen vergessenen direkten
 * Store-Aufruf. Die Maske auf PC2 geht über die Brücke; dieser Riegel steht davor, bevor irgendeine
 * Datenbank angefasst wird (dieselbe Regel wie beim Stock-Check, R6B).
 */
export function assertBooksHere(): void {
  if (isClientMode()) {
    throw new MoneyRejected(MONEY_PRIMARY_ONLY, 'money is booked on the main computer — this window has no business database');
  }
}

/** Die Sitzung des Primary. Kein stilles 'branch-main' mehr: ohne Filiale wird nichts gebucht. */
export function localMoneyCtx(): MoneyCtx {
  let branchId = '';
  let userId = '';
  try { branchId = currentBranchId(); } catch { branchId = ''; }
  try { userId = currentUserId(); } catch { userId = ''; }
  if (!branchId) throw new MoneyRejected(MONEY_NO_SESSION, 'no branch in this session — sign in again');
  return { branchId, userId };
}

/**
 * Für die alten, synchronen Store-Aktionen (`createTransfer`, `recordDebtPayment`, …): dieselbe
 * Hausfolge in einer eigenen Klammer. Läuft schon eine (Maske über `runOnPrimary`), fügt sie sich
 * ein — die äußerste Klammer entscheidet über COMMIT und Speichern.
 */
export function moneyAction<T>(fn: (ctx: MoneyCtx) => T): T {
  assertBooksHere();
  const ctx = localMoneyCtx();
  beginLedgerTransaction();
  try {
    const out = fn(ctx);
    commitLedgerTransaction();
    return out;
  } catch (e) {
    rollbackLedgerTransaction();
    throw e;
  }
}

// ── Die Eingaben: dieselbe Prüfung für Maske, Rumpf und Hausfolge ───────────
//
// Rein (keine Datenbank): die Maske fragt damit VOR dem Schicken, der Fernbefehl prüft damit den
// Rumpf, und die Hausfolge noch einmal — damit ein alter Store-Aufruf nicht an ihr vorbeikommt.

/** Geld wird in Fils verglichen (×1000, gerundet) — wie überall im Haus. */
export const toFils = (v: number): number => Math.round(v * 1000);

function amountOf(v: unknown, what = 'amount'): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || toFils(v) <= 0) {
    throw new MoneyRejected(MONEY_AMOUNT_INVALID, `${what} must be a positive amount (at least 0.001 BHD)`);
  }
  return toFils(v) / 1000;
}

/** Ein Kalendertag, wie ihn das Datumsfeld der Maske liefert — und nur ein echter. */
function dateOf(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new MoneyRejected(MONEY_DATE_INVALID, `${what} must be a date (YYYY-MM-DD)`);
  }
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    throw new MoneyRejected(MONEY_DATE_INVALID, `${what} is not a calendar date: ${v}`);
  }
  return v;
}

/** Freitext: getrimmt; leer heißt „keiner". */
function textOf(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new MoneyRejected(MONEY_TEXT_INVALID, `${what} must be text`);
  const t = v.trim();
  return t === '' ? undefined : t;
}

function idOf(v: unknown, what: string, code = MONEY_ID_REQUIRED): string {
  if (typeof v !== 'string' || !v.trim()) throw new MoneyRejected(code, `${what} is required`);
  return v.trim();
}

function oneOf<T extends string>(v: unknown, allowed: Record<T, true>, code: string, what: string): T {
  if (typeof v !== 'string' || !Object.prototype.hasOwnProperty.call(allowed, v)) {
    throw new MoneyRejected(code, `${what} must be one of ${Object.keys(allowed).join(', ')}`);
  }
  return v as T;
}

/** Die drei Kassen des Hauses — dieselben drei Knöpfe in jeder Maske. */
const CASH_SOURCES: Record<CashSource, true> = { cash: true, bank: true, benefit: true };
/** Die Steuer wird aus Kasse oder Bank bezahlt (die Maske bietet genau diese zwei, `postTaxPayment` bucht genau diese zwei). */
const TAX_SOURCES: Record<'cash' | 'bank', true> = { cash: true, bank: true };
/** Die sechs Richtungen — als Verzeichnis über den Modelltyp, damit der Übersetzer jede fehlende oder zusätzliche meldet. */
const TRANSFER_DIRECTIONS: Record<BankTransfer['direction'], true> = {
  CASH_TO_BANK: true, BANK_TO_CASH: true, CASH_TO_BENEFIT: true,
  BENEFIT_TO_CASH: true, BANK_TO_BENEFIT: true, BENEFIT_TO_BANK: true,
};
const PARTNER_TX_KINDS: Record<PartnerTransactionType, true> = { INVESTMENT: true, WITHDRAWAL: true, PROFIT_DISTRIBUTION: true };
/** Die Richtungen, die ein Darlehen tragen kann (Maske: we_lend/we_borrow; kanonisch MONEY_GIVEN/MONEY_RECEIVED). */
const DEBT_DIRECTIONS: Record<DebtDirection, true> = { we_lend: true, we_borrow: true, MONEY_GIVEN: true, MONEY_RECEIVED: true };

function expectedRevisionOpt(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new MoneyRejected(RECORD_CHANGED, 'expectedRevision must be the revision you saw');
  }
  return v;
}

// ── Steuerzahlung ───────────────────────────────────────────────────────────

export interface TaxPaymentInput {
  year: number;
  quarter: number;
  amount: number;
  source: 'cash' | 'bank';
  /** YYYY-MM-DD */
  paidAt: string;
  note?: string;
}

export function taxPaymentInput(raw: Record<string, unknown>): TaxPaymentInput {
  const year = raw.year;
  const quarter = raw.quarter;
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new MoneyRejected(TAX_PERIOD_INVALID, 'year must be a calendar year');
  }
  if (typeof quarter !== 'number' || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw new MoneyRejected(TAX_PERIOD_INVALID, 'quarter must be 1, 2, 3 or 4');
  }
  const out: TaxPaymentInput = {
    year, quarter,
    amount: amountOf(raw.amount),
    source: oneOf(raw.source, TAX_SOURCES, MONEY_SOURCE_INVALID, 'source'),
    paidAt: dateOf(raw.paidAt, 'paid on'),
  };
  const note = textOf(raw.note, 'note');
  if (note !== undefined) out.note = note;
  return out;
}

/** Was die Auswertung je Quartal zeigt — die drei Zahlen, an denen „Mark paid" hängt. */
export interface VatQuarterFigures { netVat: number; refund: number; paid: number }

/**
 * Ist dieses Quartal noch zu bezahlen? EINE Definition für die Anzeige der Auswertung und für die
 * Hausfolge: ein Erstattungsquartal wird nicht bezahlt, ein beglichenes (Rest ≤ 0,01) auch nicht.
 */
export function vatQuarterState(q: VatQuarterFigures): { isRefund: boolean; remaining: number; isSettled: boolean; payable: boolean } {
  const isRefund = q.refund > 0.005;
  const remaining = q.netVat - q.paid;
  const isSettled = !isRefund && remaining <= 0.01;
  return { isRefund, remaining, isSettled, payable: !isRefund && !isSettled };
}

export interface TaxPaymentResult {
  taxPaymentId: string; year: number; quarter: number; amount: number; source: 'cash' | 'bank'; paidAt: string;
}

/**
 * „Record VAT Payment": die Zahlung und ihre Buchung (TAX_PAID an Kasse/Bank) — zusammen oder gar
 * nicht. Teilzahlungen sind erlaubt (die Maske lässt den Betrag frei); eine Obergrenze je Zahlung
 * kennt der vorhandene Vertrag nicht, also gibt es hier auch keine. Welches Quartal offen ist,
 * rechnet DIESELBE Funktion, die die Auswertung zeigt (`financeFor`) — nachgebaut wird nichts.
 */
export function recordTaxPaymentInHouse(raw: TaxPaymentInput, ctx: MoneyCtx): TaxPaymentResult {
  assertBooksHere();
  const v = taxPaymentInput(raw as unknown as Record<string, unknown>);
  const quarters = financeFor({ tenantId: ctx.tenantId ?? '', branchId: ctx.branchId, userId: ctx.userId, role: '' })?.quarterly ?? [];
  const row = quarters.find((q) => q.year === v.year && q.quarter === v.quarter);
  // Ein Quartal ohne Zeile hat nichts geschuldet — derselbe Schluss, den die Anzeige zieht (kein Knopf).
  const state = vatQuarterState(row ?? { netVat: 0, refund: 0, paid: 0 });
  if (state.isRefund) {
    throw new MoneyRejected(TAX_QUARTER_REFUND_DUE, `${v.year} Q${v.quarter} is a refund quarter — the tax office owes this business, nothing is paid`);
  }
  if (state.isSettled) {
    throw new MoneyRejected(TAX_QUARTER_SETTLED, `${v.year} Q${v.quarter} is already settled`);
  }

  const id = uuid();
  const now = new Date().toISOString();
  const paidAt = `${v.paidAt}T00:00:00Z`;
  getDatabase().run(
    `INSERT INTO tax_payments (id, branch_id, year, quarter, amount, source, paid_at, note, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, v.year, v.quarter, v.amount, v.source, paidAt, v.note ?? null, now, ctx.userId || null],
  );
  // Kein Abgleich-Eintrag: `tax_payments` steht nicht im Abgleichsvertrag (Befund, gemeldet).
  postTaxPayment({ id, amount: v.amount, source: v.source, paidAt, year: v.year, quarter: v.quarter, note: v.note });
  return { taxPaymentId: id, year: v.year, quarter: v.quarter, amount: v.amount, source: v.source, paidAt };
}

// ── Umbuchung zwischen Kasse, Bank und Benefit ─────────────────────────────

export interface BankTransferInput {
  direction: BankTransfer['direction'];
  amount: number;
  /** YYYY-MM-DD */
  transferDate: string;
  notes?: string;
}

export function bankTransferInput(raw: Record<string, unknown>): BankTransferInput {
  const out: BankTransferInput = {
    direction: oneOf(raw.direction, TRANSFER_DIRECTIONS, BANK_TRANSFER_DIRECTION_INVALID, 'direction'),
    amount: amountOf(raw.amount),
    transferDate: dateOf(raw.transferDate, 'transfer date'),
  };
  const notes = textOf(raw.notes, 'notes');
  if (notes !== undefined) out.notes = notes;
  return out;
}

/** „Create Transfer": die Umbuchung und ihre zwei Beine im Hauptbuch — zusammen oder gar nicht. */
export function createBankTransferInHouse(raw: BankTransferInput, ctx: MoneyCtx): BankTransfer {
  assertBooksHere();
  const v = bankTransferInput(raw as unknown as Record<string, unknown>);
  const id = uuid();
  const now = new Date().toISOString();
  getDatabase().run(
    `INSERT INTO bank_transfers (id, branch_id, amount, direction, transfer_date, notes, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, v.amount, v.direction, v.transferDate, v.notes ?? null, now, ctx.userId || null],
  );
  trackInsert('bank_transfers', id, { amount: v.amount, direction: v.direction });
  const transfer: BankTransfer = {
    id, branchId: ctx.branchId, amount: v.amount, direction: v.direction, transferDate: v.transferDate,
    notes: v.notes, createdAt: now, createdBy: ctx.userId || undefined,
  };
  postBankTransfer(transfer);
  return transfer;
}

// ── Gesellschafterbewegung ─────────────────────────────────────────────────

export interface PartnerTxInput {
  partnerId: string;
  kind: PartnerTransactionType;
  amount: number;
  method: CashSource;
  /** YYYY-MM-DD */
  date: string;
  notes?: string;
}

export function partnerTxInput(raw: Record<string, unknown>): PartnerTxInput {
  const out: PartnerTxInput = {
    partnerId: idOf(raw.partnerId, 'partnerId'),
    kind: oneOf(raw.kind, PARTNER_TX_KINDS, PARTNER_TX_KIND_INVALID, 'kind'),
    amount: amountOf(raw.amount),
    method: oneOf(raw.method, CASH_SOURCES, MONEY_SOURCE_INVALID, 'method'),
    date: dateOf(raw.date, 'date'),
  };
  const notes = textOf(raw.notes, 'notes');
  if (notes !== undefined) out.notes = notes;
  return out;
}

/**
 * „Invest / Withdraw / Profit Share": Beleg, Zeile, Buchung. Nummer, Zahlstatus und Zeitpunkt
 * bestimmt das Haus — bar ist sofort PAID, alles andere wartet auf die Bestätigung (Plan §8 #8).
 * Eine Obergrenze (etwa „nicht mehr entnehmen als eingelegt") kennt der Vertrag nicht.
 */
export function recordPartnerTxInHouse(raw: PartnerTxInput, ctx: MoneyCtx): PartnerTransaction {
  assertBooksHere();
  const v = partnerTxInput(raw as unknown as Record<string, unknown>);
  const partner = query('SELECT id FROM partners WHERE id = ? AND branch_id = ?', [v.partnerId, ctx.branchId])[0];
  if (!partner) throw new MoneyRejected(PARTNER_NOT_FOUND, 'no such partner in this branch');

  const id = uuid();
  const now = new Date().toISOString();
  // Plan §Settings §B: PST (Einlage), PWD (Entnahme). Die Gewinnausschüttung zieht bisher aus
  // demselben Kreis wie die Entnahme — so belassen (Befund, gemeldet), kein neuer Nummernkreis.
  const transactionNumber = getNextDocumentNumber(v.kind === 'INVESTMENT' ? 'PST' : 'PWD');
  const paymentStatus: 'PENDING' | 'PAID' = v.method === 'cash' ? 'PAID' : 'PENDING';
  const paidAtActual = paymentStatus === 'PAID' ? now : undefined;
  getDatabase().run(
    `INSERT INTO partner_transactions (id, branch_id, partner_id, transaction_number, type, amount, method,
      transaction_date, notes, payment_status, paid_at_actual, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, v.partnerId, transactionNumber, v.kind, v.amount, v.method, v.date,
      v.notes ?? null, paymentStatus, paidAtActual ?? null, now, ctx.userId || null],
  );
  trackInsert('partner_transactions', id, { partnerId: v.partnerId, type: v.kind, amount: v.amount, method: v.method, paymentStatus });
  // Gebucht wird unabhängig vom Zahlstatus — wie bisher (die Kassenliste zählt PENDING ebenfalls).
  postPartnerTransaction({
    id, partnerId: v.partnerId, type: v.kind, amount: v.amount, method: v.method,
    transactionDate: v.date, transactionNumber,
  });
  return {
    id, branchId: ctx.branchId, partnerId: v.partnerId, transactionNumber, type: v.kind, amount: v.amount,
    method: v.method, transactionDate: v.date, notes: v.notes, paymentStatus, paidAtActual,
    createdAt: now, createdBy: ctx.userId || undefined,
  };
}

// ── Darlehen ────────────────────────────────────────────────────────────────

export interface DebtCreateInput {
  direction: DebtDirection;
  customerId: string;
  amount: number;
  source: CashSource;
  /** YYYY-MM-DD */
  dueDate?: string;
  notes?: string;
  staffId?: string;
}

/** Die Maske verlangt einen Kunden („Every loan must be linked to a client") — also auch das Haus. */
export function debtCreateInput(raw: Record<string, unknown>): DebtCreateInput {
  const customerId = raw.customerId;
  if (typeof customerId !== 'string' || !customerId.trim()) {
    throw new MoneyRejected(CUSTOMER_REQUIRED, 'Please select a client. Every loan must be linked to a customer.');
  }
  const out: DebtCreateInput = {
    direction: oneOf(raw.direction, DEBT_DIRECTIONS, DEBT_DIRECTION_INVALID, 'direction'),
    customerId: customerId.trim(),
    amount: amountOf(raw.amount),
    source: oneOf(raw.source, CASH_SOURCES, MONEY_SOURCE_INVALID, 'source'),
  };
  if (raw.dueDate !== undefined && raw.dueDate !== null && raw.dueDate !== '') out.dueDate = dateOf(raw.dueDate, 'due date');
  const notes = textOf(raw.notes, 'notes');
  if (notes !== undefined) out.notes = notes;
  if (raw.staffId !== undefined && raw.staffId !== null && raw.staffId !== '') out.staffId = idOf(raw.staffId, 'staffId');
  return out;
}

function debtFromRow(r: Record<string, unknown>, paidAmount: number): Debt {
  return {
    id: String(r.id),
    loanNumber: (r.loan_number as string | null) || undefined,
    direction: r.direction as DebtDirection,
    counterparty: String(r.counterparty ?? ''),
    customerId: (r.customer_id as string | null) || undefined,
    amount: Number(r.amount ?? 0),
    source: r.source as CashSource,
    dueDate: (r.due_date as string | null) || undefined,
    notes: (r.notes as string | null) || undefined,
    status: (r.status as DebtStatus) || 'OPEN',
    staffId: (r.staff_id as string | null) || undefined,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
    settledAt: (r.settled_at as string | null) || undefined,
    paidAmount,
  };
}

/** Das Darlehen, wie es in der DATENBANK steht — in DIESER Filiale, sonst gibt es es nicht. */
function liveDebt(debtId: string, branchId: string): Record<string, unknown> {
  const d = query('SELECT * FROM debts WHERE id = ? AND branch_id = ?', [debtId, branchId])[0];
  if (!d) throw new MoneyRejected(DEBT_NOT_FOUND, 'no such loan in this branch');
  return d;
}

/** Die gesehene Fassung, verglichen INNERHALB der Transaktion: zwei Rechner gewinnen nicht beide. */
function assertDebtRevision(d: Record<string, unknown>, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = Number(d.revision ?? 0);
  if (now !== expected) {
    throw new MoneyRejected(RECORD_CHANGED, `this loan changed since you opened it (you saw ${expected}, it is now ${now}) — reopen it`);
  }
}

function paidFilsOf(debtId: string): number {
  const rows = query('SELECT amount FROM debt_payments WHERE debt_id = ?', [debtId]);
  return rows.reduce((s, r) => s + toFils(Number(r.amount ?? 0)), 0);
}

function revisionOfDebt(debtId: string): number {
  return Number(query('SELECT revision FROM debts WHERE id = ?', [debtId])[0]?.revision ?? 0);
}

/**
 * Plan §Loan §10: OPEN / PARTIALLY_REPAID / REPAID. Dieselbe Ableitung wie bisher im Store — in Fils
 * gerechnet, und jetzt auch dem Abgleich gemeldet (vorher änderte sich der Status still).
 */
function reconcileDebtStatus(debtId: string, amountFils: number, paidFils: number): { status: DebtStatus; settledAt: string | null } {
  const now = new Date().toISOString();
  const db = getDatabase();
  let status: DebtStatus;
  if (paidFils >= amountFils) {
    db.run(`UPDATE debts SET status = 'REPAID', settled_at = COALESCE(settled_at, ?), updated_at = ? WHERE id = ?`, [now, now, debtId]);
    status = 'REPAID';
  } else if (paidFils > 0) {
    db.run(`UPDATE debts SET status = 'PARTIALLY_REPAID', settled_at = NULL, updated_at = ? WHERE id = ?`, [now, debtId]);
    status = 'PARTIALLY_REPAID';
  } else {
    db.run(`UPDATE debts SET status = 'OPEN', settled_at = NULL, updated_at = ? WHERE id = ?`, [now, debtId]);
    status = 'OPEN';
  }
  const settledAt = (query('SELECT settled_at FROM debts WHERE id = ?', [debtId])[0]?.settled_at as string | null) ?? null;
  trackUpdate('debts', debtId, { status, settledAt });
  return { status, settledAt };
}

export interface DebtCreated { debt: Debt; revision: number }

/**
 * „Create Debt": Nummer, Gegenpartei (aus dem Kunden — nicht aus dem Rumpf), Zeile, Buchung.
 * Der Kunde und ein genannter Mitarbeiter müssen in DIESER Filiale existieren.
 */
export function createDebtInHouse(raw: DebtCreateInput, ctx: MoneyCtx): DebtCreated {
  assertBooksHere();
  const v = debtCreateInput(raw as unknown as Record<string, unknown>);
  // Die Kundenauswahl der Maske zeigt keine System-Kunden (`sys-%`) — dieselbe Menge wie beim Auftrag.
  const c = query(
    "SELECT first_name, last_name FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'",
    [v.customerId, ctx.branchId],
  )[0];
  if (!c) throw new MoneyRejected(CUSTOMER_NOT_FOUND, 'no such client in this branch');
  if (v.staffId && !query('SELECT id FROM employees WHERE id = ? AND branch_id = ?', [v.staffId, ctx.branchId])[0]) {
    throw new MoneyRejected(EMPLOYEE_NOT_FOUND, 'no such employee in this branch');
  }
  const counterparty = `${String(c.first_name ?? '')} ${String(c.last_name ?? '')}`.trim();

  const id = uuid();
  const now = new Date().toISOString();
  const loanNumber = getNextDocumentNumber('LOA');
  getDatabase().run(
    `INSERT INTO debts (id, branch_id, loan_number, direction, counterparty, customer_id, amount, source,
      due_date, notes, status, staff_id, created_at, updated_at, settled_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, NULL, ?)`,
    [id, ctx.branchId, loanNumber, v.direction, counterparty, v.customerId, v.amount, v.source,
      v.dueDate ?? null, v.notes ?? null, v.staffId ?? null, now, now, ctx.userId || null],
  );
  trackInsert('debts', id, { direction: v.direction, counterparty, amount: v.amount, source: v.source });
  const debt: Debt = {
    id, loanNumber, direction: v.direction, counterparty, customerId: v.customerId, amount: v.amount,
    source: v.source, dueDate: v.dueDate, notes: v.notes, status: 'OPEN', staffId: v.staffId,
    createdAt: now, updatedAt: now, paidAmount: 0,
  };
  postLoanCreated(debt);
  return { debt, revision: revisionOfDebt(id) };
}

export interface DebtPaymentInput {
  debtId: string;
  amount: number;
  source: CashSource;
  /** YYYY-MM-DD */
  paidAt: string;
  notes?: string;
  /** Die Fassung, die die Maske gesehen hat. Fern Pflicht; am Primary schickt die Maske sie mit. */
  expectedRevision?: number;
}

export function debtPaymentInput(raw: Record<string, unknown>): DebtPaymentInput {
  const out: DebtPaymentInput = {
    debtId: idOf(raw.debtId, 'debtId'),
    amount: amountOf(raw.amount),
    source: oneOf(raw.source, CASH_SOURCES, MONEY_SOURCE_INVALID, 'source'),
    paidAt: dateOf(raw.paidAt, 'payment date'),
  };
  const notes = textOf(raw.notes, 'notes');
  if (notes !== undefined) out.notes = notes;
  const rev = expectedRevisionOpt(raw.expectedRevision);
  if (rev !== undefined) out.expectedRevision = rev;
  return out;
}

export interface DebtPaymentResult {
  payment: DebtPayment; debtId: string; status: DebtStatus; paidAmount: number; remaining: number; revision: number;
}

/**
 * „Record Repayment": nie mehr als der offene Rest (die Umkehrung der vorhandenen Regel „der Betrag
 * darf nie unter das Gezahlte"), nie auf ein storniertes oder getilgtes Darlehen. Richtung und
 * Betrag kommen aus der Datenbank — nicht aus einer geladenen Liste.
 */
export function recordDebtPaymentInHouse(raw: DebtPaymentInput, ctx: MoneyCtx): DebtPaymentResult {
  assertBooksHere();
  const v = debtPaymentInput(raw as unknown as Record<string, unknown>);
  const d = liveDebt(v.debtId, ctx.branchId);
  assertDebtRevision(d, v.expectedRevision);
  const status = canonicalLoanStatus(d.status as DebtStatus);
  if (status === 'CANCELLED') throw new MoneyRejected(DEBT_CANCELLED, 'this loan is cancelled — it takes no repayment');
  if (status === 'REPAID') throw new MoneyRejected(DEBT_REPAID, 'this loan is already repaid');
  const amountF = toFils(Number(d.amount ?? 0));
  const paidF = paidFilsOf(v.debtId);
  const openF = amountF - paidF;
  if (toFils(v.amount) > openF) {
    throw new MoneyRejected(DEBT_OVERPAYMENT, `the repayment is more than what is still open (${(Math.max(0, openF) / 1000).toFixed(3)} BHD)`);
  }

  const id = uuid();
  const now = new Date().toISOString();
  const paidAt = `${v.paidAt}T00:00:00Z`;
  getDatabase().run(
    `INSERT INTO debt_payments (id, debt_id, amount, source, paid_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, v.debtId, v.amount, v.source, paidAt, v.notes ?? null, now],
  );
  trackInsert('debt_payments', id, { debtId: v.debtId, amount: v.amount, source: v.source, paidAt });
  const newPaidF = paidF + toFils(v.amount);
  const st = reconcileDebtStatus(v.debtId, amountF, newPaidF);
  const payment: DebtPayment = { id, debtId: v.debtId, amount: v.amount, source: v.source, paidAt, notes: v.notes, createdAt: now };
  postLoanPayment(payment, canonicalLoanDirection(d.direction as DebtDirection));
  return {
    payment, debtId: v.debtId, status: st.status,
    paidAmount: newPaidF / 1000, remaining: Math.max(0, amountF - newPaidF) / 1000,
    revision: revisionOfDebt(v.debtId),
  };
}

export interface DebtUpdateInput {
  debtId: string;
  expectedRevision?: number;
  counterparty?: string;
  amount?: number;
  /** YYYY-MM-DD; `null` löscht */
  dueDate?: string | null;
  /** `null` löscht */
  notes?: string | null;
  source?: CashSource;
}

export function debtUpdateInput(raw: Record<string, unknown>): DebtUpdateInput {
  const out: DebtUpdateInput = { debtId: idOf(raw.debtId, 'debtId') };
  const rev = expectedRevisionOpt(raw.expectedRevision);
  if (rev !== undefined) out.expectedRevision = rev;
  if (raw.counterparty !== undefined) {
    const c = textOf(raw.counterparty, 'counterparty');
    // Das Feld ist in der Maske Pflicht — ein Darlehen ohne Gegenpartei gibt es nicht.
    if (!c) throw new MoneyRejected(DEBT_COUNTERPARTY_REQUIRED, 'counterparty is required');
    out.counterparty = c;
  }
  if (raw.amount !== undefined) out.amount = amountOf(raw.amount, 'loan amount');
  if (raw.dueDate !== undefined) out.dueDate = raw.dueDate === null ? null : dateOf(raw.dueDate, 'due date');
  if (raw.notes !== undefined) out.notes = raw.notes === null ? null : (textOf(raw.notes, 'notes') ?? null);
  if (raw.source !== undefined) out.source = oneOf(raw.source, CASH_SOURCES, MONEY_SOURCE_INVALID, 'source');
  return out;
}

export interface DebtUpdateResult { debtId: string; status: DebtStatus; amount: number; source: CashSource; revision: number; changed: boolean; reposted: boolean }

/**
 * „Edit Debt": nur was sich gegen die Datenbank wirklich ändert. Ändert sich Betrag oder Konto,
 * wird die Darlehensbuchung in DERSELBEN Transaktion gespiegelt und neu gebucht — vorher lief das
 * Hauptbuch hier still auseinander. Ein storniertes Darlehen wird nicht mehr berichtigt (vorher
 * setzte die Statusableitung es dabei wieder auf „offen").
 */
export function updateDebtInHouse(raw: DebtUpdateInput, ctx: MoneyCtx): DebtUpdateResult {
  assertBooksHere();
  const v = debtUpdateInput(raw as unknown as Record<string, unknown>);
  const d = liveDebt(v.debtId, ctx.branchId);
  assertDebtRevision(d, v.expectedRevision);
  if (canonicalLoanStatus(d.status as DebtStatus) === 'CANCELLED') {
    throw new MoneyRejected(DEBT_CANCELLED, 'this loan is cancelled — it is no longer edited');
  }

  const paidF = paidFilsOf(v.debtId);
  const sets: string[] = [];
  const values: unknown[] = [];
  const changed: Record<string, unknown> = {};
  const put = (col: string, key: string, val: unknown) => { sets.push(`${col} = ?`); values.push(val); changed[key] = val; };

  if (v.counterparty !== undefined && v.counterparty !== String(d.counterparty ?? '')) put('counterparty', 'counterparty', v.counterparty);
  const amountChanged = v.amount !== undefined && toFils(v.amount) !== toFils(Number(d.amount ?? 0));
  if (amountChanged) {
    // Die vorhandene Regel: nie unter das schon Gezahlte.
    if (toFils(v.amount!) < paidF) {
      throw new MoneyRejected(DEBT_AMOUNT_BELOW_PAID,
        `Cannot reduce loan amount below already paid (${(paidF / 1000).toFixed(3)}). Reverse payments first.`);
    }
    put('amount', 'amount', v.amount);
  }
  if (v.dueDate !== undefined && v.dueDate !== ((d.due_date as string | null) ?? null)) put('due_date', 'dueDate', v.dueDate);
  if (v.notes !== undefined && v.notes !== ((d.notes as string | null) ?? null)) put('notes', 'notes', v.notes);
  const sourceChanged = v.source !== undefined && v.source !== String(d.source ?? '');
  if (sourceChanged) put('source', 'source', v.source);

  if (sets.length === 0) {
    return {
      debtId: v.debtId, status: d.status as DebtStatus, amount: Number(d.amount ?? 0), source: d.source as CashSource,
      revision: Number(d.revision ?? 0), changed: false, reposted: false,
    };
  }

  const now = new Date().toISOString();
  getDatabase().run(`UPDATE debts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...values, now, v.debtId]);
  trackUpdate('debts', v.debtId, changed);
  const newAmount = amountChanged ? v.amount! : Number(d.amount ?? 0);
  if (amountChanged) reconcileDebtStatus(v.debtId, toFils(newAmount), paidF);

  // Die Darlehensbuchung folgt Betrag und Konto. Nur wo es eine lebende gibt: ein Altdarlehen aus der
  // Zeit vor dem Hauptbuch bekommt beim Berichtigen keine nachträglich (das ist Sache des Nachtrags).
  let reposted = false;
  if ((amountChanged || sourceChanged) && hasLedgerEntries('LOAN', v.debtId)) {
    const after = query('SELECT * FROM debts WHERE id = ?', [v.debtId])[0];
    const before = debtFromRow(d, paidF / 1000);
    postLoanCancelled(before);
    postLoanCreated(debtFromRow(after, paidF / 1000));
    reposted = true;
  }
  const row = query('SELECT status, amount, source, revision FROM debts WHERE id = ?', [v.debtId])[0];
  return {
    debtId: v.debtId, status: row.status as DebtStatus, amount: Number(row.amount ?? 0), source: row.source as CashSource,
    revision: Number(row.revision ?? 0), changed: true, reposted,
  };
}
