// ═══════════════════════════════════════════════════════════
// LATAIF — Supplier-Credit Restore (neutraler Core-SSOT)
// ═══════════════════════════════════════════════════════════
//
// Gemeinsamer Restore-Helfer fuer ALLE Pfade, die eine verbrauchte Supplier-Gutschrift
// zurueckgeben (cancelPurchase-F6 UND Expense-Cancel/Delete). Frueher lag die Logik lokal
// in purchaseStore; jetzt EINMAL hier, von beiden Stores importiert (keine Duplikation).
//
// Gibt used_amount Fils-genau zurueck (KEINE 0.005-BHD-Toleranz) und leitet
// status OPEN/USED aus dem neuen used_amount ab. IDEMPOTENZ liegt beim CALLER: nur fuer
// JETZT frisch reversierte Credit-Zahlungen aufrufen (Capture-vor-Reverse, gefiltert auf
// hasLedgerEntries && !hasReversalFor). No-Op nur bei amount<=0.
//
// MIXED-INVOICE P1a — fail-closed statt still: fehlt die Gutschrift (oder ihre Kennung an der Zahlung)
// oder zeigt sie weniger verbraucht als zurückgegeben werden soll, wird NICHT geklemmt und NICHT
// übersprungen, sondern abgewiesen (`SUPPLIER_CREDIT_RESTORE_MISMATCH`). Alle Aufrufer laufen in einer
// Transaktion — der Vorgang rollt dann ganz zurück, statt eine Rückgabe zu verlieren.
//
// saveDatabase() bleibt drin: ausserhalb einer Ledger-Transaktion persistiert es sofort
// (cancelPurchase = best-effort), innerhalb einer offenen Transaktion (Expense-Teardown)
// deferiert es bis zum aeusseren COMMIT — beide Caller korrekt bedient.

import { getDatabase, saveDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackChange } from '@/core/sync/sync-service';

const toFils = (n: number) => Math.round(n * 1000);

export const SUPPLIER_CREDIT_RESTORE_MISMATCH = 'SUPPLIER_CREDIT_RESTORE_MISMATCH';

export class SupplierCreditRestoreError extends Error {
  readonly code = SUPPLIER_CREDIT_RESTORE_MISMATCH;
  constructor(message: string) {
    super(message);
    this.name = 'SupplierCreditRestoreError';
  }
}

/** Warum diese Rückgabe nicht sauber ginge — oder null. Rein, ohne Schreiben (für eine Prüfung vorab). */
export function supplierCreditRestoreIssue(creditId: string | null | undefined, amount: number): string | null {
  if (!(toFils(amount) > 0)) return null;
  if (!creditId) return 'This payment was made with supplier credit, but the credit it used is not recorded — it cannot be given back automatically. Nothing was changed.';
  const cr = query(`SELECT used_amount FROM supplier_credits WHERE id = ?`, [creditId])[0];
  if (!cr) return 'The supplier credit this payment used no longer exists — it cannot be given back automatically. Nothing was changed.';
  if (toFils(Number(cr.used_amount) || 0) < toFils(amount)) {
    return 'The supplier credit shows less used than this payment would give back — please check it with the accountant. Nothing was changed.';
  }
  return null;
}

export function restoreSupplierCreditUsage(creditId: string, amount: number): void {
  if (!(toFils(amount) > 0)) return;
  const issue = supplierCreditRestoreIssue(creditId, amount);
  if (issue) throw new SupplierCreditRestoreError(issue);
  const db = getDatabase();
  const cr = query(`SELECT amount, used_amount FROM supplier_credits WHERE id = ?`, [creditId])[0];
  const totalF = toFils(Number(cr.amount) || 0);
  const newUsedF = toFils(Number(cr.used_amount) || 0) - toFils(amount);
  const newStatus = newUsedF >= totalF ? 'USED' : 'OPEN';
  db.run(`UPDATE supplier_credits SET used_amount = ?, status = ? WHERE id = ?`, [newUsedF / 1000, newStatus, creditId]);
  trackChange('supplier_credits', creditId, 'update', {});
  saveDatabase();
}
