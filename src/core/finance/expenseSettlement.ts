// ═══════════════════════════════════════════════════════════
// LATAIF — Expense Settlement (SSOT, Slice A)
// ═══════════════════════════════════════════════════════════
//
// EINE Fils-basierte Quelle fuer "wie weit ist eine Expense beglichen":
//   cashPaid   = expenses.paid_amount                       (cash/bank/benefit — bleibt cash-only)
//   creditPaid = Σ expense_payments.amount WHERE method='credit'
//   settled    = cashPaid + creditPaid
//   remaining  = max(0, amount - settled)
//   status     = settled >= amount (Fils) ? 'PAID' : 'PENDING'   (CANCELLED bleibt CANCELLED)
//
// expenses.paid_amount wird durch Credit-Einloesung bewusst NICHT veraendert (analog Purchase-
// Overpay-Basis). Deshalb muss JEDER Status-/Remaining-Konsument ueber diesen Helfer rechnen,
// sonst unter-meldet er das beglichene credit-Teilstueck. KEIN neuer Status 'PARTIAL' — die
// Expense-Status-Union ist projektweit nur PENDING/PAID/CANCELLED; Teilzahlung = settled<amount.
//
// Fuer Listen/mehrere Expenses: creditPaidByExpense() ist EINE gebuendelte GROUP-BY-Query
// (kein N+1). Fuer einen einzelnen Writer/Konsumenten: creditPaidForExpense(id).

import { query } from '@/core/db/helpers';
import { hasLedgerEntries, hasReversalFor } from '@/core/ledger/posting';

const toFils = (n: number) => Math.round(n * 1000);
const round3 = (n: number) => toFils(n) / 1000;

// Supplier-Credits sind suppliergebunden: solange eine Expense eine AKTIVE (gebuchte,
// nicht reversierte) Credit-Einloesung traegt, darf ihr Supplier nicht still auf einen
// anderen Supplier wechseln (sonst driften Credit-Domain (used_amount/reference auf A)
// und Ledger-Counterparty (B) auseinander). Statt Re-Home: harter Block, voller Rollback.
export const SUPPLIER_CREDIT_LOCK_MESSAGE =
  'Cannot change supplier while supplier credit is applied. Reverse or cancel the credit settlement first.';

// True, wenn die Expense mind. eine method='credit'-Row mit lebenden Ledger-Eintraegen
// und ohne Reversal besitzt (eine bereits reversierte/restored Credit-Row gilt als inaktiv).
export function expenseHasActiveCreditSettlement(expenseId: string): boolean {
  const rows = query(
    `SELECT id FROM expense_payments WHERE expense_id = ? AND method = 'credit'`,
    [expenseId],
  );
  return rows.some(
    (r) =>
      hasLedgerEntries('EXPENSE_PAYMENT', r.id as string) &&
      !hasReversalFor('EXPENSE_PAYMENT', r.id as string),
  );
}

export type ExpenseStatus = 'PENDING' | 'PAID' | 'CANCELLED';

export interface ExpenseSettlement {
  amount: number;
  cashPaid: number;
  creditPaid: number;
  settled: number;
  remaining: number;
  status: ExpenseStatus;
}

// Reine Berechnung (keine DB). currentStatus nur fuer den CANCELLED-Durchgriff.
export function computeExpenseSettlement(
  amount: number,
  cashPaid: number,
  creditPaid: number,
  currentStatus?: string,
): ExpenseSettlement {
  const amountF = toFils(amount || 0);
  const cashF = toFils(cashPaid || 0);
  const creditF = toFils(creditPaid || 0);
  const settledF = cashF + creditF;
  const remainingF = Math.max(0, amountF - settledF);
  const status: ExpenseStatus =
    currentStatus === 'CANCELLED' ? 'CANCELLED' : (settledF >= amountF ? 'PAID' : 'PENDING');
  return {
    amount: round3(amount || 0),
    cashPaid: round3(cashPaid || 0),
    creditPaid: round3(creditPaid || 0),
    settled: settledF / 1000,
    remaining: remainingF / 1000,
    status,
  };
}

// Gebuendelt: Σ credit-Einloesung je Expense (eine Query). Optional auf eine Branch begrenzt.
export function creditPaidByExpense(branchId?: string): Map<string, number> {
  const rows = branchId
    ? query(
        `SELECT ep.expense_id AS eid, COALESCE(SUM(ep.amount), 0) AS credit_paid
           FROM expense_payments ep JOIN expenses e ON e.id = ep.expense_id
          WHERE ep.method = 'credit' AND e.branch_id = ?
          GROUP BY ep.expense_id`,
        [branchId],
      )
    : query(
        `SELECT expense_id AS eid, COALESCE(SUM(amount), 0) AS credit_paid
           FROM expense_payments WHERE method = 'credit' GROUP BY expense_id`,
        [],
      );
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.eid as string, Number(r.credit_paid) || 0);
  return m;
}

// Einzelwert: Σ credit-Einloesung einer Expense (fuer Writer/Single-Konsument).
export function creditPaidForExpense(expenseId: string): number {
  const r = query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM expense_payments WHERE expense_id = ? AND method = 'credit'`,
    [expenseId],
  )[0];
  return Number(r?.t) || 0;
}
