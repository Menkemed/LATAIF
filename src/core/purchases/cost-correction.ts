// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT D1 — die Einstandskorrektur verkaufter Stücke: lesen und mitdrehen.
//
// Die Korrektur entsteht in `editPurchaseInHouse` (eigener Beleg `cost_corrections`, eigene Buchung
// COST_CORRECTION). Die Rechnung bleibt unverändert — darum muss jeder, der den Einstand oder Gewinn
// EINER RECHNUNG liest, die Korrektur dazunehmen, und jeder, der eine Rechnung zurückdreht, sie mit
// zurückdrehen. Diese Datei ist die eine Stelle dafür.
//
// Gewinnleser (Collection, Analytics, Berichte, Rechnung) nehmen den WIRKSAMEN Einstand: Wert vom
// Verkaufstag + Korrekturen, wirtschaftlich dem Verkauf zugeordnet (Rechnungsdatum, D1-B). Steuerleser
// (NBR-Export, VAT-Quartal, Steuerbericht) nehmen ausdrücklich NICHT die Korrektur — ihre Zahlen sind
// die gemeldeten; eine mögliche VAT-Wirkung steht als REVIEW an der Korrektur und wartet auf den
// Buchhalter.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { hasCostCorrectionTable } from './cost-correction-read';
import { hasLedgerEntries, reverseSource } from '@/core/ledger/posting';
import { logAuditOrThrow } from '@/core/audit/audit-log';

export * from './cost-correction-read';

/**
 * Eine Rechnung wird storniert oder gelöscht: ihre Einstandskorrekturen gehen mit — Gegenbuchung
 * (heute) und Status REVERSED. Sonst bliebe nach dem Storno die Differenz in Lager und Wareneinsatz
 * stehen, während das Stück zum berichtigten Einstand ins Los zurückkehrt. Im Rahmen des Aufrufers.
 */
export function reverseCostCorrectionsOfInvoice(invoiceId: string, now: string, reason: string): number {
  if (!hasCostCorrectionTable()) return 0;
  const rows = query(`SELECT id, correction_number FROM cost_corrections WHERE invoice_id = ? AND status = 'ACTIVE'`, [invoiceId]);
  const db = getDatabase();
  for (const r of rows) {
    const id = String(r.id);
    if (hasLedgerEntries('COST_CORRECTION', id)) reverseSource('COST_CORRECTION', id, now);
    db.run(`UPDATE cost_corrections SET status = 'REVERSED', reversed_at = ?, reversed_reason = ? WHERE id = ?`, [now, reason, id]);
    logAuditOrThrow({
      module: 'Purchase', entityType: 'cost_corrections', entityId: id, action: 'STATUS_CHANGE', field: 'status',
      oldValue: 'ACTIVE', newValue: { status: 'REVERSED', reason, invoiceId, correctionNumber: String(r.correction_number) },
    });
  }
  return rows.length;
}
