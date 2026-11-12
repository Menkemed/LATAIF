// ════════════════════════════════════════════════════════════════════════════
// REPAIR COST DATE (Owner 12.11.2026) — das Kostendatum einer Reparatur-Kostenzeile (Arbeit, Material, In-house).
//
//   • Vorgabe: das Annahmedatum der Reparatur (`received_at`). Liegt es vor dem Eröffnungsstichtag (oder in einem
//     geschlossenen Quartal), gibt es KEINE Vorgabe — nie still „heute": die Maske bittet um einen zulässigen Tag, und
//     der Primary lehnt eine Kostenzeile mit Betrag ohne gewählten Tag verständlich ab (`REPAIR_COST_DATE_REQUIRED`).
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
export const REPAIR_COST_DATE_REQUIRED = 'REPAIR_COST_DATE_REQUIRED';

const TAG_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Der Annahmetag der Reparatur (JJJJ-MM-TT) aus `received_at`, sonst `created_at`. */
export function repairReceivedDay(r: { receivedAt?: string | null; createdAt?: string | null }): string {
  return String(r.receivedAt || r.createdAt || '').slice(0, 10);
}

/** Ein Tag lesbar („05 Nov 2026") — für Hinweise und Ablehnungen. */
function tagText(d: string): string {
  const t = Date.parse(`${d}T00:00:00.000Z`);
  if (!TAG_RE.test(d) || Number.isNaN(t)) return d;
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Die Vorgabe für die Maske (rein, ohne Datenbank): der Annahmetag — oder '' (KEINE Vorgabe), wenn er vor dem
 * Eröffnungsstichtag liegt, ungültig ist oder in der Zukunft. Dann wählt der Nutzer den Tag ausdrücklich
 * (`repairCostDatePrompt`). Ein eingereichtes Quartal kennt erst der Primary (er lehnt dann verständlich ab).
 */
export function defaultRepairCostDay(receivedDay: string, nowMs: number = Date.now(), cutoff: string = OPENING_CUTOFF_DATE): string {
  if (!TAG_RE.test(receivedDay) || receivedDay < cutoff || receivedDay > bahrainTodayIso(nowMs)) return '';
  return receivedDay;
}

/** Die Aufforderung der Maske, wenn es keine Vorgabe gibt — sonst null. */
export function repairCostDatePrompt(receivedDay: string, nowMs: number = Date.now(), cutoff: string = OPENING_CUTOFF_DATE): string | null {
  if (defaultRepairCostDay(receivedDay, nowMs, cutoff)) return null;
  if (TAG_RE.test(receivedDay) && receivedDay < cutoff) {
    return `This repair was received on ${tagText(receivedDay)}, before the opening (${tagText(cutoff)}). `
      + `Please choose the cost date — a day from ${tagText(cutoff)} up to today.`;
  }
  return 'Please choose the cost date — a day up to today.';
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
 * Das Kostendatum einer NEUEN Kostenzeile am Primary — nie still „heute":
 *   • gewählt → geprüft (offene Periode, nicht künftig);
 *   • sonst der Annahmetag, wenn er ein offener Kostentag ist;
 *   • sonst: mit Betrag ein verständliches Nein (`REPAIR_COST_DATE_REQUIRED`, die Aufforderung der Maske); ohne Betrag
 *     (bucht nichts, z. B. eigene Arbeit 0.000) bleibt die Zeile ohne Datum (`null`) — bekommt sie später einen Betrag,
 *     gilt dieselbe Regel (`updateRepairLine`).
 */
export function lineCostDayFor(receivedDay: string, branchId: string, chosen: unknown, nowMs: number, amount: number): string | null {
  if (chosen !== undefined && chosen !== null && chosen !== '') return assertRepairCostDay(chosen, branchId, nowMs);
  const cutoff = openingCutoffDay();
  const vorgabe = defaultRepairCostDay(receivedDay, nowMs, cutoff);
  const issue = vorgabe ? repairCostDayIssue(vorgabe, branchId, nowMs, 'The received day') : null;
  if (vorgabe && !issue) return vorgabe;
  if (!(Number(amount) > 0)) return null;
  throw new RepairActionRejected(REPAIR_COST_DATE_REQUIRED, issue
    ? `${issue.message} — please choose the cost date (a day in an open period, up to today)`
    : (repairCostDatePrompt(receivedDay, nowMs, cutoff) ?? 'Please choose the cost date'));
}

/** `lineCostDayFor` für eine bestehende Reparatur (Annahmetag aus der Datenbank). */
export function newLineCostDay(repairId: string, branchId: string, chosen: unknown, nowMs: number, amount: number): string | null {
  if (chosen !== undefined && chosen !== null && chosen !== '') return assertRepairCostDay(chosen, branchId, nowMs);
  const r = query('SELECT received_at, created_at FROM repairs WHERE id = ?', [repairId])[0];
  return lineCostDayFor(repairReceivedDay({ receivedAt: r?.received_at as string, createdAt: r?.created_at as string }), branchId, chosen, nowMs, amount);
}
