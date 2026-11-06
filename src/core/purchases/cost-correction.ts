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
import { hasCostCorrectionTable, hasGoldSettlementTable } from './cost-correction-read';
import { hasLedgerEntries, reverseSource, postEntries } from '@/core/ledger/posting';
import { trackUpdate } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';

export * from './cost-correction-read';

/**
 * Eine Rechnung wird storniert oder gelöscht: ihre Einstandskorrekturen gehen mit — Gegenbuchung
 * (heute) und Status REVERSED. Sonst bliebe nach dem Storno die Differenz in Lager und Wareneinsatz
 * stehen, während das Stück zum berichtigten Einstand ins Los zurückkehrt. Im Rahmen des Aufrufers.
 */
export function reverseCostCorrectionsOfInvoice(invoiceId: string, now: string, reason: string): number {
  const gold = moveGoldSeparateBackToStock(invoiceId, now, reason);
  if (!hasCostCorrectionTable()) return gold;
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
  return rows.length + gold;
}

/**
 * CUSTOM-ORDER Review — eine Goldschuld-Differenz, die (Rechnung im geschlossenen Quartal) als eigener Wareneinsatz
 * gebucht ist, geht mit dem Stück ins Lager zurück, wenn dessen Rechnung storniert/gelöscht wird: Soll INVENTORY / Haben COGS
 * (heute, unter der Ausgabe der Begleichung — ein späterer Storno der Begleichung dreht alles zusammen zurück); die Differenz
 * ist danach wieder Einstand des Stücks (cost_mode UNSOLD). Im Rahmen des Aufrufers.
 */
function moveGoldSeparateBackToStock(invoiceId: string, now: string, reason: string): number {
  if (!hasGoldSettlementTable()) return 0;
  const rows = query(
    `SELECT id, expense_id, difference, invoice_line_id, payable_id FROM gold_payable_settlements
      WHERE invoice_id = ? AND status = 'ACTIVE' AND cost_mode = 'SEPARATE'`, [invoiceId]);
  const db = getDatabase();
  for (const r of rows) {
    const diff = Math.round((Number(r.difference) || 0) * 1000) / 1000;
    if (Math.abs(diff) > 0.0005) {
      const meta = { kind: 'order_gold_settlement_back_to_stock', settlementId: String(r.id), invoiceId, reason };
      const line = r.invoice_line_id ? { sourceLineId: String(r.invoice_line_id) } : {};
      postEntries([
        { account: diff > 0 ? 'INVENTORY' : 'COGS', direction: 'DEBIT', amount: Math.abs(diff), ...line, metadata: meta },
        { account: diff > 0 ? 'COGS' : 'INVENTORY', direction: 'CREDIT', amount: Math.abs(diff), ...line, metadata: meta },
      ], { occurredAt: now, sourceModule: 'EXPENSE', sourceId: String(r.expense_id) });
    }
    db.run(`UPDATE gold_payable_settlements SET cost_mode = 'UNSOLD', vat_status = 'NONE' WHERE id = ?`, [String(r.id)]);
    trackUpdate('gold_payable_settlements', String(r.id), { costMode: 'UNSOLD', vatStatus: 'NONE' });
    logAuditOrThrow({
      module: 'Gold', entityType: 'gold_payable_settlements', entityId: String(r.id), action: 'UPDATE', field: 'cost_mode',
      oldValue: 'SEPARATE', newValue: { costMode: 'UNSOLD', reason, invoiceId, difference: diff },
    });
  }
  return rows.length;
}
