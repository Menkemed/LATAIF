// ════════════════════════════════════════════════════════════════════════════
// REPAIR COST DATE (Owner 12.11.2026) — das Kostendatum einer Reparatur-Kostenzeile (Arbeit, Material, In-house).
//
//   • Vorgabe: das Annahmedatum der Reparatur (`received_at`). Liegt es vor dem Eröffnungsstichtag, gilt heute.
//   • Wählbar: ein echter Kalendertag bis heute in Bahrain (dieselbe Regel wie ein Zahlungstag, `payment-date`),
//     in einer offenen Periode — nicht vor dem Eröffnungsstichtag, nicht in einem eingereichten/VAT-bezahlten Quartal.
//   • Die Ausgabe (Werkstatt/Material) und die Kostenbuchung (Ausgabe bzw. aktivierte Eigenleistung) stehen an diesem
//     Tag; der Zahlungstag bleibt davon unabhängig.
// Altbestand (Zeile ohne `cost_date`) bucht wie bisher am Tag der Buchung.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { bahrainTodayIso, paymentDateIssue } from '@/core/utils/payment-date';
import { openingCutoffDay } from '@/core/ledger/correction-dates';
import { OPENING_CUTOFF_DATE } from '@/core/parties/opening-balances';
import { closedVatQuarters, nbrQuarterOfDate } from '@/core/tax/vat-period-lock';
import { RepairActionRejected } from './repair-rules';

export const REPAIR_COST_DATE_INVALID = 'REPAIR_COST_DATE_INVALID';
export const REPAIR_COST_DATE_BEFORE_OPENING = 'REPAIR_COST_DATE_BEFORE_OPENING';
export const REPAIR_COST_DATE_PERIOD_FILED = 'VAT_PERIOD_FILED';

/** Der Annahmetag der Reparatur (JJJJ-MM-TT) aus `received_at`, sonst `created_at`. */
export function repairReceivedDay(r: { receivedAt?: string | null; createdAt?: string | null }): string {
  return String(r.receivedAt || r.createdAt || '').slice(0, 10);
}

/**
 * Die Vorgabe für die Maske (rein, ohne Datenbank): der Annahmetag — liegt er vor dem Eröffnungsstichtag, ungültig oder
 * in der Zukunft, dann heute in Bahrain. Ein eingereichtes Quartal kennt erst der Primary (er lehnt dann verständlich ab).
 */
export function defaultRepairCostDay(receivedDay: string, nowMs: number = Date.now()): string {
  const heute = bahrainTodayIso(nowMs);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDay) || receivedDay < OPENING_CUTOFF_DATE || receivedDay > heute) return heute;
  return receivedDay;
}

/** Warum dieser Tag als Kostendatum nicht geht — oder null. Rein lesend, vor jedem Schreiben. */
export function repairCostDayIssue(day: unknown, branchId: string, nowMs: number, label = 'The cost date'): { code: string; message: string } | null {
  if (day === undefined || day === null || day === '') return { code: REPAIR_COST_DATE_INVALID, message: `${label} is required` };
  const issue = paymentDateIssue(day, label, nowMs);
  if (issue) return { code: REPAIR_COST_DATE_INVALID, message: issue };
  const d = String(day);
  const cutoff = openingCutoffDay();
  if (d < cutoff) {
    return { code: REPAIR_COST_DATE_BEFORE_OPENING,
      message: `${label} (${d}) is before the opening cut-off (${cutoff}) — bookings before the opening are not changed afterwards` };
  }
  const q = nbrQuarterOfDate(d);
  const c = q ? closedVatQuarters(branchId).get(q.key) : undefined;
  if (q && c) {
    const [y, n] = q.key.split('-Q');
    return { code: REPAIR_COST_DATE_PERIOD_FILED,
      message: `the VAT return for Q${n}/${y} is already ${c.filedAt ? 'filed' : 'paid'} — ${label.toLowerCase()} ${d} lies in that closed quarter` };
  }
  return null;
}

export function assertRepairCostDay(day: unknown, branchId: string, nowMs: number, label = 'The cost date'): string {
  const issue = repairCostDayIssue(day, branchId, nowMs, label);
  if (issue) throw new RepairActionRejected(issue.code, issue.message);
  return String(day);
}

/**
 * Das Kostendatum einer NEUEN Zeile am Primary: das gewählte (geprüft) — sonst der Annahmetag, wenn er offen ist, sonst
 * heute in Bahrain.
 */
export function newLineCostDay(repairId: string, branchId: string, chosen: unknown, nowMs: number): string {
  if (chosen !== undefined && chosen !== null && chosen !== '') return assertRepairCostDay(chosen, branchId, nowMs);
  const r = query('SELECT received_at, created_at FROM repairs WHERE id = ?', [repairId])[0];
  const vorgabe = defaultRepairCostDay(repairReceivedDay({ receivedAt: r?.received_at as string, createdAt: r?.created_at as string }), nowMs);
  return repairCostDayIssue(vorgabe, branchId, nowMs) ? bahrainTodayIso(nowMs) : vorgabe;
}
