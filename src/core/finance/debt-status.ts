// ════════════════════════════════════════════════════════════════════════════
// Der Stand eines Darlehens aus seinen Rückzahlungen — EINE Regel für Rückzahlung, Bearbeitung und Verrechnung.
//
// Herausgelöst aus `money-house.ts` (CUSTOMER ACCOUNT B1), damit auch die Verrechnung Rechnung ↔ Darlehen
// (`core/offsets`) sie benutzt, ohne die Geldfolge samt ihrer Abhängigkeiten zu laden. Inhalt unverändert:
// Summe der Rückzahlungen in Fils; Status OPEN / PARTIALLY_REPAID / REPAID; der Abgleich bekommt die Änderung gemeldet.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate } from '@/core/sync/track';
import type { DebtStatus } from '@/core/models/types';

const toFils = (n: number): number => Math.round(n * 1000);

/** Summe aller Rückzahlungszeilen eines Darlehens in Fils (eine Verrechnung zählt mit, ihre Aufhebung zieht ab). */
export function paidFilsOfDebt(debtId: string): number {
  const rows = query('SELECT amount FROM debt_payments WHERE debt_id = ?', [debtId]);
  return rows.reduce((s, r) => s + toFils(Number(r.amount ?? 0)), 0);
}

/**
 * Plan §Loan §10: OPEN / PARTIALLY_REPAID / REPAID. Dieselbe Ableitung wie bisher im Store — in Fils
 * gerechnet, und dem Abgleich gemeldet.
 */
export function reconcileDebtStatus(debtId: string, amountFils: number, paidFils: number): { status: DebtStatus; settledAt: string | null } {
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
