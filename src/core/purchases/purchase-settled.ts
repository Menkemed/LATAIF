// ════════════════════════════════════════════════════════════════════════════
// B2/B3 — EINE Regel „beglichen" am Einkauf (vorher an ≈ 14 Stellen kopiert, nur Geld + Lieferantenguthaben):
//
//   beglichen = paid_amount (NUR Geld: cash/bank/benefit)
//             + Σ purchase_payments 'credit' (Lieferantenguthaben)        — nicht storniert
//             + Σ purchase_payments 'offset' (Verrechnung mit einer Kundenrechnung derselben Person) — nicht storniert
//   offen     = max(0, Summe − beglichen)
//
// `paid_amount` bleibt bewusst NUR Geld: Überzahlung (Lieferantenguthaben), Void, Retoure und Ankaufbeleg rechnen mit
// echtem Geld. Eine Verrechnungszeile ('offset') bucht nie selbst — ihre Buchung (Soll AP Lieferant / Haben AR Kunde)
// steht an der Rechnungszahlung 'purchase_offset'; aufgehoben wird sie nur über die Rechnungszahlung (voided_at).
//
// Nur Datenbank — keine Speicher, kein Hauptbuch (sonst Kreis über `invoiceStore`).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate } from '@/core/sync/track';

/** Die Zahlart der Verrechnungszeile am Einkauf (ohne eigene Buchung). */
export const PURCHASE_OFFSET_METHOD = 'offset';
/** Die Zahlart der Rechnungszahlung, die die Verrechnung bucht (Soll ACCOUNTS_PAYABLE Lieferant / Haben AR Kunde). */
export const INVOICE_PURCHASE_OFFSET_METHOD = 'purchase_offset';
/** Begleichung ohne Geld am Einkauf: Lieferantenguthaben und Verrechnung. */
export const PURCHASE_NON_CASH_METHODS = ['credit', PURCHASE_OFFSET_METHOD] as const;
/** Dieselbe Liste für SQL (`method IN …`). */
export const PURCHASE_NON_CASH_SQL = `('credit', '${PURCHASE_OFFSET_METHOD}')`;

export type PurchaseSettleStatus = 'DRAFT' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);

/** Σ der nicht stornierten Begleichungen ohne Geld (Guthaben + Verrechnung), in Fils. */
export function purchaseNonCashFils(purchaseId: string): number {
  return F(query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method IN ${PURCHASE_NON_CASH_SQL} AND voided_at IS NULL`,
    [purchaseId],
  )[0]?.t);
}

/** Σ der wirksamen Verrechnungen (nicht storniert), in Fils. */
export function purchaseOffsetFils(purchaseId: string): number {
  return F(query(
    'SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method = ? AND voided_at IS NULL',
    [purchaseId, PURCHASE_OFFSET_METHOD],
  )[0]?.t);
}

export interface PurchaseSettlement {
  totalF: number;
  /** Nur Geld (paid_amount). */
  cashF: number;
  creditF: number;
  offsetF: number;
  settledF: number;
  openF: number;
}

/** Der Stand eines Einkaufs nach der EINEN Regel — jede Anzeige und jede Hausfolge liest ihn hier. */
export function purchaseSettlementOf(purchaseId: string): PurchaseSettlement {
  const p = query('SELECT total_amount, paid_amount FROM purchases WHERE id = ?', [purchaseId])[0];
  const totalF = F(p?.total_amount);
  const cashF = F(p?.paid_amount);
  const offsetF = purchaseOffsetFils(purchaseId);
  const creditF = purchaseNonCashFils(purchaseId) - offsetF;
  const settledF = cashF + creditF + offsetF;
  return { totalF, cashF, creditF, offsetF, settledF, openF: Math.max(0, totalF - settledF) };
}

/** Dieselbe Statusregel wie `computeStatus` — auf dem Beglichenen, in Fils. */
export function purchaseStatusOf(totalF: number, settledF: number): PurchaseSettleStatus {
  if (totalF <= 0) return 'DRAFT';
  if (settledF <= 0) return 'UNPAID';
  if (settledF >= totalF) return 'PAID';
  return 'PARTIALLY_PAID';
}

/**
 * Rest und Status des Einkaufs nach der EINEN Regel in die Zeile schreiben (paid_amount bleibt unberührt). In der
 * Transaktion des Aufrufers — Verrechnung anlegen bzw. aufheben.
 */
export function refreshPurchaseSettlementRow(purchaseId: string, now: string): { remainingAmount: number; status: PurchaseSettleStatus } {
  const s = purchaseSettlementOf(purchaseId);
  const remainingAmount = s.openF / 1000;
  const status = purchaseStatusOf(s.totalF, s.settledF);
  getDatabase().run('UPDATE purchases SET remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?', [remainingAmount, status, now, purchaseId]);
  trackUpdate('purchases', purchaseId, { remainingAmount, status });
  return { remainingAmount, status };
}

/** Hängt an diesem Einkauf eine wirksame Verrechnung? (Sperre für Storno, Lieferantenwechsel, Retoure, Minderung …) */
export function purchaseHasActiveOffsets(purchaseId: string): boolean {
  return query(
    `SELECT 1 FROM party_offsets WHERE payable_type = 'PURCHASE' AND payable_id = ? AND status = 'ACTIVE' LIMIT 1`,
    [purchaseId],
  ).length > 0;
}

/** Nein-Code einer Änderung, die eine wirksame Verrechnung zerrisse. */
export const PURCHASE_HAS_OFFSET = 'PURCHASE_HAS_OFFSET';
export const purchaseHasOffsetMessage = (what: string): string =>
  `${what} is not possible while an offset with a client invoice (STL-…) is active on this purchase — remove the offset first (the invoice opens again). Nothing was changed`;
