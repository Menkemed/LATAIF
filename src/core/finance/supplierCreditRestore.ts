// ═══════════════════════════════════════════════════════════
// LATAIF — Supplier-Credit Restore (neutraler Core-SSOT)
// ═══════════════════════════════════════════════════════════
//
// Gemeinsamer Restore-Helfer fuer ALLE Pfade, die eine verbrauchte Supplier-Gutschrift
// zurueckgeben (cancelPurchase-F6 UND Expense-Cancel/Delete). Frueher lag die Logik lokal
// in purchaseStore; jetzt EINMAL hier, von beiden Stores importiert (keine Duplikation).
//
// Gibt used_amount Fils-genau zurueck (KEINE 0.005-BHD-Toleranz), nie unter 0, und leitet
// status OPEN/USED aus dem neuen used_amount ab. IDEMPOTENZ liegt beim CALLER: nur fuer
// JETZT frisch reversierte Credit-Zahlungen aufrufen (Capture-vor-Reverse, gefiltert auf
// hasLedgerEntries && !hasReversalFor). No-Op, wenn die Credit-Row fehlt oder amount<=0.
//
// saveDatabase() bleibt drin: ausserhalb einer Ledger-Transaktion persistiert es sofort
// (cancelPurchase = best-effort), innerhalb einer offenen Transaktion (Expense-Teardown)
// deferiert es bis zum aeusseren COMMIT — beide Caller korrekt bedient.

import { getDatabase, saveDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackChange } from '@/core/sync/sync-service';

const toFils = (n: number) => Math.round(n * 1000);

export function restoreSupplierCreditUsage(creditId: string, amount: number): void {
  if (!creditId || !(toFils(amount) > 0)) return;
  const db = getDatabase();
  const cr = query(`SELECT amount, used_amount FROM supplier_credits WHERE id = ?`, [creditId])[0];
  if (!cr) return;
  const totalF = toFils(Number(cr.amount) || 0);
  const newUsedF = Math.max(0, toFils(Number(cr.used_amount) || 0) - toFils(amount));
  const newStatus = newUsedF >= totalF ? 'USED' : 'OPEN';
  db.run(`UPDATE supplier_credits SET used_amount = ?, status = ? WHERE id = ?`, [newUsedF / 1000, newStatus, creditId]);
  trackChange('supplier_credits', creditId, 'update', {});
  saveDatabase();
}
