// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT B1 — die ZENTRALE Verrechnung: eine offene Forderung an den Kunden (Verkaufsrechnung) wird mit einer
// offenen Verbindlichkeit gegenüber DEMSELBEN Kunden (zuerst: Darlehen „We Borrowed") ausgeglichen — ohne Geld.
// Jede Oberfläche (Rechnung „Settle Balance", später Kundenkonto C, Einkauf B3 nach Freigabe) ruft DIESE Hausfolge; es
// gibt keine zweite Buchungslogik je Oberfläche.
//
// Buchung — über den VORHANDENEN Zahlungsweg der Rechnung (`invoiceStore.recordPayment`) mit der Zahlart 'debt_offset':
//   Soll LOAN_PAYABLE (die Schuld gegenüber dem Kunden sinkt) / Haben ACCOUNTS_RECEIVABLE (seine Rechnung ist bezahlt).
//   Kein Kassen-, Bank-, Karten- oder Benefit-Konto, keine Kartengebühr. Status, Endnummer (Normal/Special), VAT-Sperre,
//   Exportmonat (Tag der Vollzahlung) folgen unverändert der Regel jeder Zahlung.
// Das Darlehen bekommt eine Rückzahlungszeile (Quelle 'offset') OHNE eigene Buchung — die Buchung steht an der
// Rechnungszahlung; Status und Rest des Darlehens folgen der Summe seiner Zeilen (eine Regel: `debt-status.ts`).
// `party_offsets` verbindet beide Zeilen dauerhaft (Nummer STL-…, Betrag, Tag, ACTIVE/REVERSED).
//
// Geprüft wird IN der Transaktion des Aufrufers (`runOnPrimary` an der Maske, `runRemoteCommand` für PC2), gegen den
// frischen Stand: dieselbe Filiale, derselbe Kunde (Darlehen ausdrücklich zugeordnet), offene Beträge beider Seiten,
// gesehene Fassungen, Datum (nicht Zukunft, nicht vor einem der Belege, nicht vor dem Eröffnungsstichtag).
// Aufheben: `reverseDebtOffsetInHouse` (oder jede Entfernung der Zahlung) → `party-offset-restore.ts`.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { hasLedgerEntries } from '@/core/ledger/posting';
import { runOnPrimary } from '@/core/data/primary-action';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useDebtStore } from '@/stores/debtStore';
import { useCustomerStore } from '@/stores/customerStore';
import { businessDateIssue, businessTimestamp } from '@/core/utils/business-date';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { assertInvoiceHouse, localInvoiceBranch } from '@/core/invoices/invoice-house-guards';
import { OPENING_CUTOFF_DATE } from '@/core/parties/opening-balances';
import { paidFilsOfDebt, reconcileDebtStatus } from '@/core/finance/debt-status';
import { DEBT_OFFSET_METHOD, DEBT_OFFSET_SOURCE, OffsetRestoreError } from './party-offset-restore';
import { invoiceOpenFils, isBorrowedDirection as borrowed, isDebtClosed as debtClosed, OFFSET_CLOSED_INVOICE } from './party-offset-reads';

export { DEBT_OFFSET_METHOD, DEBT_OFFSET_SOURCE } from './party-offset-restore';
export { debtOffsetCandidatesFor, invoiceOpenFils, offsetForPayment, offsetsOfDebt, offsetsOfInvoice, type DebtOffsetCandidate, type DebtOffsetChoice, type OffsetRef } from './party-offset-reads';

export const OFFSET_AMOUNT_INVALID = 'OFFSET_AMOUNT_INVALID';
export const OFFSET_INVOICE_NOT_OPEN = 'OFFSET_INVOICE_NOT_OPEN';
export const OFFSET_DEBT_NOT_FOUND = 'OFFSET_DEBT_NOT_FOUND';
export const OFFSET_DEBT_NOT_OPEN = 'OFFSET_DEBT_NOT_OPEN';
export const OFFSET_NOT_WE_BORROWED = 'OFFSET_NOT_WE_BORROWED';
export const OFFSET_CUSTOMER_MISMATCH = 'OFFSET_CUSTOMER_MISMATCH';
export const OFFSET_EXCEEDS_INVOICE = 'OFFSET_EXCEEDS_INVOICE';
export const OFFSET_EXCEEDS_DEBT = 'OFFSET_EXCEEDS_DEBT';
export const OFFSET_DATE_INVALID = 'OFFSET_DATE_INVALID';
export const OFFSET_DATE_TOO_EARLY = 'OFFSET_DATE_TOO_EARLY';
export const OFFSET_NOT_FOUND = 'OFFSET_NOT_FOUND';
export const OFFSET_ALREADY_REVERSED = 'OFFSET_ALREADY_REVERSED';
export const OFFSET_RECORD_CHANGED = 'RECORD_CHANGED';

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const nein = (code: string, msg: string): InvoiceActionRejected => new InvoiceActionRejected(code, `${msg} — nothing was offset`);
const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface DebtOffsetInput {
  invoiceId: string;
  debtId: string;
  amount: number;
  /** Geschäftstag der Verrechnung (JJJJ-MM-TT); fehlt er: heute. */
  offsetDate?: string;
  /** „Final Number Type" — wirkt nur, wenn DIESE Verrechnung die Rechnung schließt (wie bei jeder Zahlung). */
  specialMarkOnFinal?: boolean;
  /** Die Fassungen, die die Maske gesehen hat — geändert = Nein (zwei Rechner gewinnen nicht beide). */
  expectedInvoiceRevision?: number;
  expectedDebtRevision?: number;
}

export interface OffsetCtx { branchId: string; userId?: string }

export interface DebtOffsetCreated {
  offsetId: string;
  offsetNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  invoiceOpen: number;
  paymentId: string;
  debtId: string;
  loanNumber: string;
  debtPaymentId: string;
  debtOpen: number;
  debtStatus: string;
  amount: number;
  offsetDate: string;
}

/** „Settle Balance" — eine Rechnung mit EINEM Darlehen verrechnen. In der Transaktion des Aufrufers. */
export function createDebtOffsetInHouse(input: DebtOffsetInput, ctx: OffsetCtx): DebtOffsetCreated {
  assertInvoiceHouse(ctx.branchId);
  const amountF = F(input.amount);
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || amountF <= 0 || Math.abs(input.amount * 1000 - amountF) > 1e-6) {
    throw nein(OFFSET_AMOUNT_INVALID, 'the amount must be above 0 with at most 3 decimals');
  }
  // ── Rechnung: in dieser Filiale, offen, gesehene Fassung.
  const inv = query('SELECT id, customer_id, status, invoice_number, issued_at, created_at, revision FROM invoices WHERE id = ? AND branch_id = ?',
    [input.invoiceId, ctx.branchId])[0];
  if (!inv) throw nein('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  if (OFFSET_CLOSED_INVOICE.includes(String(inv.status))) throw nein(OFFSET_INVOICE_NOT_OPEN, `this invoice is ${String(inv.status).toLowerCase()}`);
  if (input.expectedInvoiceRevision !== undefined && Number(inv.revision ?? 0) !== input.expectedInvoiceRevision) {
    throw nein(OFFSET_RECORD_CHANGED, `this invoice changed since you opened it (you saw ${input.expectedInvoiceRevision}, it is now ${Number(inv.revision ?? 0)}) — reload`);
  }
  // ── Darlehen: in dieser Filiale, „We Borrowed", offen, AUSDRÜCKLICH demselben Kunden zugeordnet, gesehene Fassung.
  const d = query('SELECT * FROM debts WHERE id = ? AND branch_id = ?', [input.debtId, ctx.branchId])[0];
  if (!d) throw nein(OFFSET_DEBT_NOT_FOUND, 'no such loan in this branch');
  if (!borrowed(d.direction)) throw nein(OFFSET_NOT_WE_BORROWED, 'only a loan where LATAIF owes the client (We Borrowed) can settle an invoice');
  if (debtClosed(d.status)) throw nein(OFFSET_DEBT_NOT_OPEN, `this loan is ${String(d.status).toLowerCase()}`);
  if (!d.customer_id || String(d.customer_id) !== String(inv.customer_id)) {
    throw nein(OFFSET_CUSTOMER_MISMATCH, 'the loan belongs to another client (or to no client) — assign it to this client first');
  }
  if (input.expectedDebtRevision !== undefined && Number(d.revision ?? 0) !== input.expectedDebtRevision) {
    throw nein(OFFSET_RECORD_CHANGED, `this loan changed since you opened it (you saw ${input.expectedDebtRevision}, it is now ${Number(d.revision ?? 0)}) — reload`);
  }
  // ── Beträge beider Seiten, frisch, in Fils.
  const invOpenF = invoiceOpenFils(input.invoiceId);
  const debtOpenF = F(d.amount) - paidFilsOfDebt(input.debtId);
  if (invOpenF <= 5) throw nein(OFFSET_INVOICE_NOT_OPEN, 'nothing is open on this invoice');
  if (debtOpenF <= 5) throw nein(OFFSET_DEBT_NOT_OPEN, 'nothing is open on this loan');
  if (amountF > invOpenF) throw nein(OFFSET_EXCEEDS_INVOICE, `at most ${B(invOpenF).toFixed(3)} is open on the invoice`);
  if (amountF > debtOpenF) throw nein(OFFSET_EXCEEDS_DEBT, `at most ${B(debtOpenF).toFixed(3)} is open on the loan`);
  // ── Tag: gültig, nicht in der Zukunft, nicht vor Rechnung, Darlehen oder Eröffnungsstichtag.
  const heute = todayLocal();
  const tag = input.offsetDate ?? heute;
  const issue = businessDateIssue(tag, 'Offset date');
  if (issue || typeof tag !== 'string') throw nein(OFFSET_DATE_INVALID, issue || 'the offset date is not valid');
  const rechnungstag = String(inv.issued_at || inv.created_at || '').slice(0, 10);
  const darlehenstag = String(d.created_at || '').slice(0, 10);
  const frueheste = [rechnungstag, darlehenstag, OPENING_CUTOFF_DATE].filter(Boolean).sort().pop() as string;
  if (tag < frueheste) throw nein(OFFSET_DATE_TOO_EARLY, `the offset date must be on or after ${frueheste} (invoice, loan and opening cutoff)`);

  let userId = ctx.userId ?? '';
  if (!userId) { try { userId = currentUserId(); } catch { userId = ''; } }
  const loanNumber = String(d.loan_number ?? '') || String(d.id).slice(0, 8);
  const createdAt = new Date().toISOString();
  const receivedAt = businessTimestamp(tag, createdAt);

  // ── 1. Die Rechnungszahlung über den vorhandenen Weg: Status, Endnummer, VAT-Sperre, Buchung (Soll LOAN_PAYABLE).
  useInvoiceStore.getState().loadInvoices();
  const paymentId = uuid();
  // Die Nummer der Verrechnung zuerst: beide Zeilen nennen sie (Gegenbeleg auf Rechnung UND Darlehen).
  const offsetNumber = getNextDocumentNumber('STL');
  useInvoiceStore.getState().recordPayment(
    input.invoiceId, B(amountF), DEBT_OFFSET_METHOD, `Offset ${offsetNumber} · loan ${loanNumber} · no cash`, input.specialMarkOnFinal, undefined,
    paymentId, false, { receivedAt, createdAt },
  );
  if (!hasLedgerEntries('PAYMENT', paymentId)) {
    throw new OffsetRestoreError('OFFSET_NOT_BOOKED', 'the offset could not be booked — nothing was offset');
  }
  const after = query('SELECT invoice_number, status, special_mark, number_finalized_at FROM invoices WHERE id = ?', [input.invoiceId])[0];
  const invoiceLabel = formatInvoiceDisplayShort({
    invoiceNumber: String(after?.invoice_number ?? ''), status: String(after?.status ?? ''), specialMark: Number(after?.special_mark) === 1,
    numberFinalizedAt: (after?.number_finalized_at as string | null) || null,
  }) || String(after?.invoice_number ?? '');

  // ── 2. Die Rückzahlungszeile am Darlehen — OHNE eigene Buchung (sie steht an der Rechnungszahlung).
  const db = getDatabase();
  const debtPaymentId = uuid();
  db.run(
    `INSERT INTO debt_payments (id, debt_id, amount, source, paid_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [debtPaymentId, input.debtId, B(amountF), DEBT_OFFSET_SOURCE, receivedAt, `Offset ${offsetNumber} · invoice ${invoiceLabel} · no cash`, createdAt],
  );
  trackInsert('debt_payments', debtPaymentId, { debtId: input.debtId, amount: B(amountF), source: DEBT_OFFSET_SOURCE, paidAt: receivedAt });
  const st = reconcileDebtStatus(input.debtId, F(d.amount), paidFilsOfDebt(input.debtId));

  // ── 3. Die Verbindung beider Zeilen — dauerhaft, nummeriert.
  const offsetId = uuid();
  db.run(
    `INSERT INTO party_offsets (id, branch_id, offset_number, customer_id, receivable_type, receivable_id, receivable_payment_id,
       payable_type, payable_id, payable_payment_id, amount, offset_date, status, note, created_at, created_by)
     VALUES (?, ?, ?, ?, 'INVOICE', ?, ?, 'DEBT', ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?)`,
    [offsetId, ctx.branchId, offsetNumber, String(inv.customer_id), input.invoiceId, paymentId, input.debtId, debtPaymentId, B(amountF), tag, createdAt, userId || null],
  );
  trackInsert('party_offsets', offsetId, { offsetNumber, invoiceId: input.invoiceId, debtId: input.debtId, amount: B(amountF) });
  logAuditOrThrow({
    module: 'Finance', entityType: 'party_offsets', entityId: offsetId, action: 'CREATE',
    newValue: {
      offsetNumber, customerId: inv.customer_id, invoiceId: input.invoiceId, invoiceNumber: invoiceLabel, paymentId,
      debtId: input.debtId, loanNumber, debtPaymentId, amount: B(amountF), offsetDate: tag, booking: 'DR LOAN_PAYABLE / CR ACCOUNTS_RECEIVABLE',
    },
    actor: { userId: userId || undefined, branchId: ctx.branchId },
  });

  return {
    offsetId, offsetNumber, invoiceId: input.invoiceId, invoiceNumber: invoiceLabel, invoiceStatus: String(after?.status ?? ''),
    invoiceOpen: B(Math.max(0, invoiceOpenFils(input.invoiceId))), paymentId,
    debtId: input.debtId, loanNumber, debtPaymentId, debtOpen: B(F(d.amount) - paidFilsOfDebt(input.debtId)), debtStatus: st.status,
    amount: B(amountF), offsetDate: tag,
  };
}

export interface DebtOffsetReversed { offsetId: string; offsetNumber: string; invoiceId: string; debtId: string; amount: number }

/**
 * Eine Verrechnung aufheben: ihre Rechnungszahlung entfernen (Gegenbuchung, Status und Rest der Rechnung neu) — das
 * Darlehen ist über `restoreDebtOffsetForPayment` wieder offen. Nur eine WIRKSAME Verrechnung; nie zweimal.
 */
export function reverseDebtOffsetInHouse(input: { offsetId: string; reason?: string }, ctx: OffsetCtx): DebtOffsetReversed {
  assertInvoiceHouse(ctx.branchId);
  const o = query('SELECT * FROM party_offsets WHERE id = ? AND branch_id = ?', [String(input.offsetId ?? ''), ctx.branchId])[0];
  if (!o) throw new InvoiceActionRejected(OFFSET_NOT_FOUND, 'no such offset in this branch');
  if (String(o.status) !== 'ACTIVE') throw new InvoiceActionRejected(OFFSET_ALREADY_REVERSED, `${String(o.offset_number)} is already reversed`);
  const paymentId = String(o.receivable_payment_id);
  if (!query('SELECT 1 FROM payments WHERE id = ?', [paymentId])[0]) throw new InvoiceActionRejected(OFFSET_NOT_FOUND, 'the invoice payment of this offset is gone');
  useInvoiceStore.getState().loadInvoices();
  const reason = (input.reason ?? '').trim().slice(0, 500) || 'offset removed';
  useInvoiceStore.getState().deletePayment(paymentId, String(o.receivable_id), { offsetReason: reason });
  const nachher = query('SELECT status FROM party_offsets WHERE id = ?', [String(o.id)])[0];
  if (String(nachher?.status) !== 'REVERSED') throw new OffsetRestoreError('OFFSET_NOT_REVERSED', 'the offset could not be reversed — nothing was changed');
  return { offsetId: String(o.id), offsetNumber: String(o.offset_number), invoiceId: String(o.receivable_id), debtId: String(o.payable_id), amount: B(F(o.amount)) };
}

// ── Anschlüsse am Primary: exklusiv, EINE Transaktion, danach durabel ─────────
function frischLesen(): void {
  useInvoiceStore.getState().loadInvoices();
  try { useDebtStore.getState().loadDebts(); } catch { /* noop */ }
  try { useCustomerStore.getState().loadCustomers(); } catch { /* noop */ }
}

export function createDebtOffsetOnPrimary(input: DebtOffsetInput): Promise<DebtOffsetCreated> {
  const branchId = localInvoiceBranch();
  return runOnPrimary(() => createDebtOffsetInHouse(input, { branchId }), frischLesen);
}

export function reverseDebtOffsetOnPrimary(offsetId: string, reason?: string): Promise<DebtOffsetReversed> {
  const branchId = localInvoiceBranch();
  return runOnPrimary(() => reverseDebtOffsetInHouse({ offsetId, reason }, { branchId }), frischLesen);
}

/** Der Rumpf für PC2: `invoices.record_payment` mit der Zahlart 'debt_offset' (Prüfung, Buchung und Verbindung am Primary). */
export function debtOffsetBody(input: DebtOffsetInput): Record<string, unknown> {
  return {
    invoiceId: input.invoiceId, amount: input.amount, method: DEBT_OFFSET_METHOD, debtId: input.debtId,
    ...(input.offsetDate ? { paidDate: input.offsetDate } : {}),
    ...(typeof input.specialMarkOnFinal === 'boolean' ? { specialMarkOnFinal: input.specialMarkOnFinal } : {}),
    ...(input.expectedInvoiceRevision !== undefined ? { expectedInvoiceRevision: input.expectedInvoiceRevision } : {}),
    ...(input.expectedDebtRevision !== undefined ? { expectedDebtRevision: input.expectedDebtRevision } : {}),
  };
}
