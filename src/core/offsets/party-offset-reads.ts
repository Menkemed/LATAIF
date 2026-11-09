// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT B1 — was die Masken über Verrechnungen LESEN (Rechnung, Darlehen, Kundenkonto, PC2-Lesebefehl).
// Nur Datenbank und Darlehens-Regel — keine Speicher, kein Primary-Anschluss, damit Lesebefehle es ohne Kreis laden.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { paidFilsOfDebt } from '@/core/finance/debt-status';

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;

/** Offen auf der Rechnung — dieselbe Regel wie Receivables / „Receive Payment": Brutto − bezahlt − Forderungsstorno. */
export function invoiceOpenFils(invoiceId: string): number {
  const r = query(
    `SELECT i.gross_amount, i.paid_amount,
            COALESCE((SELECT SUM(receivable_cancel_amount) FROM credit_notes WHERE invoice_id = i.id AND status != 'CANCELLED'), 0) AS cn
       FROM invoices i WHERE i.id = ?`, [invoiceId],
  )[0];
  return r ? F(r.gross_amount) - F(r.paid_amount) - F(r.cn) : 0;
}

export const isBorrowedDirection = (dir: unknown): boolean => dir === 'we_borrow' || dir === 'MONEY_RECEIVED';
export const isDebtClosed = (status: unknown): boolean => ['CANCELLED', 'REPAID', 'SETTLED'].includes(String(status ?? '').toUpperCase());
/** Rechnungen in diesen Zuständen werden nie verrechnet. */
export const OFFSET_CLOSED_INVOICE = ['CANCELLED', 'DRAFT', 'RETURNED'];

export interface DebtOffsetCandidate { debtId: string; loanNumber: string; date: string; amount: number; open: number; revision: number; counterparty: string }
export interface DebtOffsetChoice { invoiceOpen: number; candidates: DebtOffsetCandidate[]; suggested: number }
export const NO_DEBT_OFFSET: DebtOffsetChoice = { invoiceOpen: 0, candidates: [], suggested: 0 };

/**
 * Die Darlehen „We Borrowed", mit denen DIESE Rechnung verrechnet werden kann: offen, ausdrücklich demselben Kunden
 * zugeordnet, dieselbe Filiale — älteste zuerst. Dazu der Vorschlag (kleinerer Wert aus Rechnungs- und Darlehensrest).
 */
export function debtOffsetCandidatesFor(ctx: { branchId: string }, invoiceId: string): DebtOffsetChoice {
  const inv = query('SELECT id, customer_id, status FROM invoices WHERE id = ? AND branch_id = ?', [invoiceId, ctx.branchId])[0];
  if (!inv || !inv.customer_id || OFFSET_CLOSED_INVOICE.includes(String(inv.status))) return { invoiceOpen: 0, candidates: [], suggested: 0 };
  const openF = Math.max(0, invoiceOpenFils(invoiceId));
  if (openF <= 5) return { invoiceOpen: B(openF), candidates: [], suggested: 0 };
  const candidates = query(
    `SELECT id, loan_number, amount, status, direction, created_at, revision, counterparty FROM debts
      WHERE branch_id = ? AND customer_id = ? AND direction IN ('we_borrow', 'MONEY_RECEIVED')
      ORDER BY created_at, loan_number`,
    [ctx.branchId, String(inv.customer_id)],
  ).filter((d) => !isDebtClosed(d.status))
    .map((d) => ({ d, openF: F(d.amount) - paidFilsOfDebt(String(d.id)) }))
    .filter((x) => x.openF > 5)
    .map(({ d, openF: o }) => ({
      debtId: String(d.id), loanNumber: String(d.loan_number ?? '') || String(d.id).slice(0, 8), date: String(d.created_at ?? '').slice(0, 10),
      amount: B(F(d.amount)), open: B(o), revision: Number(d.revision ?? 1), counterparty: String(d.counterparty ?? ''),
    }));
  const first = candidates[0];
  return { invoiceOpen: B(openF), candidates, suggested: first ? B(Math.min(openF, F(first.open))) : 0 };
}

export interface OffsetRef {
  offsetId: string; offsetNumber: string; status: string; amount: number; offsetDate: string;
  invoiceId: string; invoicePaymentId: string; invoiceNumber: string;
  debtId: string; debtPaymentId: string; loanNumber: string;
  reversedAt: string | null; reverseReason: string | null; reversalPaymentId: string | null;
}

const REF_SQL = `SELECT o.*, i.invoice_number AS inv_number, d.loan_number AS loan_number
                   FROM party_offsets o
                   LEFT JOIN invoices i ON i.id = o.receivable_id
                   LEFT JOIN debts d ON d.id = o.payable_id`;

function ref(o: Record<string, unknown>): OffsetRef {
  return {
    offsetId: String(o.id), offsetNumber: String(o.offset_number), status: String(o.status), amount: B(F(o.amount)),
    offsetDate: String(o.offset_date ?? ''), invoiceId: String(o.receivable_id), invoicePaymentId: String(o.receivable_payment_id),
    invoiceNumber: String(o.inv_number ?? ''), debtId: String(o.payable_id), debtPaymentId: String(o.payable_payment_id),
    loanNumber: String(o.loan_number ?? '') || String(o.payable_id).slice(0, 8),
    reversedAt: (o.reversed_at as string | null) ?? null, reverseReason: (o.reverse_reason as string | null) ?? null,
    reversalPaymentId: (o.reversal_payment_id as string | null) ?? null,
  };
}

/** Alle Verrechnungen einer Rechnung dieser Filiale (wirksam und aufgehoben) — für die Gegenbeleg-Anzeige. */
export function offsetsOfInvoice(invoiceId: string, branchId: string): OffsetRef[] {
  return query(`${REF_SQL} WHERE o.receivable_type = 'INVOICE' AND o.receivable_id = ? AND o.branch_id = ? ORDER BY o.created_at`, [invoiceId, branchId]).map(ref);
}

/** Alle Verrechnungen eines Darlehens dieser Filiale (wirksam und aufgehoben). */
export function offsetsOfDebt(debtId: string, branchId: string): OffsetRef[] {
  return query(`${REF_SQL} WHERE o.payable_type = 'DEBT' AND o.payable_id = ? AND o.branch_id = ? ORDER BY o.created_at`, [debtId, branchId]).map(ref);
}

/** Die Verrechnung, die an einer Rechnungszahlung hängt (für „Remove offset"). */
export function offsetForPayment(paymentId: string): OffsetRef | null {
  const o = query(`${REF_SQL} WHERE o.receivable_payment_id = ?`, [paymentId])[0];
  return o ? ref(o) : null;
}
