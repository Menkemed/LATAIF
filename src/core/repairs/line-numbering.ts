// ═══════════════════════════════════════════════════════════
// LATAIF — Repair-Line Sub-Numbering (v0.1.48)
//
// Format: REP-000023-L1, REP-000023-L2, ...
//
// Plan repair-multi-supplier §Audit-Print:
// Jede repair_line bekommt ein deterministisches Sub-Label fuer Audit, Print
// und Expense-Descriptions. Position ist 1-basiert (Position 1 = erste Line).
// Cancelled Lines behalten ihr Sub-Label damit Cancel+Replace nicht zu
// "L1 wurde geloescht aber ich kann's nicht mehr nachvollziehen" fuehrt.
// ═══════════════════════════════════════════════════════════

/**
 * Formatiert ein Repair-Line-Sub-Label.
 *
 * Beispiele:
 *   formatRepairLineNumber('REP-000023', 1) === 'REP-000023-L1'
 *   formatRepairLineNumber('REP-000023', 7) === 'REP-000023-L7'
 *
 * Wenn keine Position vorhanden (Legacy single-supplier Repair vor v0.1.44),
 * gibt die Funktion die Repair-Nummer ohne Suffix zurueck.
 */
export function formatRepairLineNumber(repairNumber: string, position?: number | null): string {
  if (position == null || position <= 0) return repairNumber;
  return `${repairNumber}-L${position}`;
}

/**
 * Parsed das Sub-Label zurueck in Repair-Number + Position. Toleriert
 * Repair-Numbers OHNE Sub-Label (gibt position=null zurueck).
 */
export function parseRepairLineNumber(label: string): { repairNumber: string; position: number | null } {
  const match = label.match(/^(.+)-L(\d+)$/);
  if (!match) return { repairNumber: label, position: null };
  return { repairNumber: match[1], position: parseInt(match[2], 10) };
}
