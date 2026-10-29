// REPAIR-REOPEN — die Schritte einer Reparatur aus ihrer gespeicherten Zeile und ihren Kostenzeilen, für die
// Befehle und Lesebefehle des Primary (PC2, Handy). Dieselbe reine Regel wie am Bildschirm (`repairStatusTargets`):
// vorwärts, oder von „Returned" zurück.
import { query } from '@/core/db/helpers';
import type { RepairStatus } from '@/core/models/types';
import { repairStatusTargets } from './repair-status-flow';

const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export function repairStatusTargetsOfRow(id: string): RepairStatus[] {
  const r = query(`SELECT status, repair_type, repair_scope, invoice_id, return_from_status, started_at, diagnosed_at
    FROM repairs WHERE id = ?`, [id])[0];
  if (!r) return [];
  const gebucht = Number(query(
    "SELECT COUNT(*) AS n FROM repair_lines WHERE repair_id = ? AND status = 'OPEN' AND expense_id IS NOT NULL", [id],
  )[0]?.n ?? 0);
  return repairStatusTargets({
    status: String(r.status ?? ''), repairType: str(r.repair_type), repairScope: str(r.repair_scope),
    invoiceId: str(r.invoice_id), returnFromStatus: str(r.return_from_status),
    startedAt: str(r.started_at), diagnosedAt: str(r.diagnosed_at), bookedLineCount: gebucht,
  });
}
