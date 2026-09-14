// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY PP-13 — Reparaturkosten an EIGENER Ware: genau EINMAL, im Einstand des Artikels.
//
// Bis hier wirkten die Werkstattkosten einer eigenen Reparatur doppelt: als Betriebsausgabe
// „RepairCosts" (Soll EXPENSES_OPERATING) bei „in Arbeit" UND als Einstand (Artikel + Los) bei
// „ready", der beim Verkauf als Wareneinsatz ausgebucht wird. Verkauf 300, Werkstatt 100 ergab 100.
// Der Vertrag jetzt — für den Zeilenweg und den Einzelweg derselbe:
//   • die Werkstattschuld einer eigenen Reparatur ist eine Ausgabe der Kategorie „Inventory" mit
//     Bezug 'repair' (`isCapitalizedRepairCost`) → Soll INVENTORY / Haben A/P (Werkstatt); die
//     Berichte führen „Inventory" als kapitalisiert, nicht als Betriebsausgabe;
//   • bei „ready" geht der Betrag in den Einstand (Artikel + Los) und beim Verkauf als COGS genau
//     einmal hinaus; die Zahlung ist nur Soll A/P / Haben Kasse/Bank;
//   • eine Zeile, die nach „ready" hinzukommt, ihren Betrag ändert oder storniert wird, verschiebt
//     den Einstand um genau ihren Betrag; beglichene Werkstattkosten und ein verkaufter Artikel
//     sperren die Rücknahme (Nein vor jedem Schreiben, nie ein negativer Einstand).
// Eigene Arbeit ohne Werkstatt (`internalCost`) bleibt, wie sie war: nur im Einstand, keine Ausgabe.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate } from '@/core/sync/track';
import { trackLotRow } from '@/core/lots/lot-queries';
import { expenseHasActiveCreditSettlement } from '@/core/finance/expenseSettlement';
import { canonicalRepairStatus, type ExpenseCategory, type Repair } from '@/core/models/types';
import { RepairActionRejected } from './repair-rules';

const EPS = 0.0005;

/** Die Kategorie der Werkstattschuld: eigene Ware → kapitalisiert („Inventory"), Kundenware → „RepairCosts". */
export function repairCostCategory(scope: string | null | undefined): ExpenseCategory {
  return scope === 'OWN' ? 'Inventory' : 'RepairCosts';
}

/** Steht der Einstand dieser Reparatur schon im Artikel? Bei eigener Ware geschieht das einmal, bei „ready". */
export function ownRepairCapitalized(r: Pick<Repair, 'repairScope' | 'completedAt' | 'status'>): boolean {
  return r.repairScope === 'OWN' && !!r.completedAt && canonicalRepairStatus(r.status) === 'READY';
}

/**
 * Was bei „ready" in den Einstand geht. Dieselbe Regel wie `computeRepairTotalCost` — mit einer
 * Ausnahme: bei „external" ist `internalCost` der gespiegelte Werkstatt-Voranschlag (`internalCostOnCreate`).
 * Trägt keine offene Zeile mehr die Werkstatt und ist keine Werkstatt mehr verknüpft (nach dem Storno
 * aller Zeilen setzt `recomputeRepairAggregates` sie auf NULL), gibt es auch keine Werkstattkosten mehr —
 * sonst entstünde aus dem Spiegel ein Einstand ohne Kosten. Ebenso der Werkstattteil bei „hybrid".
 */
export function ownRepairCost(
  r: Pick<Repair, 'repairType' | 'internalCost' | 'estimatedCost' | 'workshopSupplierId' | 'externalVendor'>,
  openLineTotal = 0,
): number {
  const internal = r.internalCost || 0;
  const workshopLinked = !!r.workshopSupplierId || !!r.externalVendor;
  if (openLineTotal > 0) {
    if (r.repairType === 'hybrid') return internal + openLineTotal;
    if (r.repairType === 'external') return openLineTotal;
    return internal;
  }
  if (r.repairType === 'hybrid') return internal + (workshopLinked ? (r.estimatedCost || 0) : 0);
  if (r.repairType === 'external') return workshopLinked ? internal : 0;
  return internal;
}

/** Das Los, das die Reparaturkosten trägt: das gewählte, sonst das älteste aktive (FIFO wie der Verkauf). */
function costLot(productId: string, lotId: string | null | undefined): { id: string; qty: number; unitCost: number } | null {
  const rows = lotId
    ? query(`SELECT id, qty_remaining, unit_cost FROM stock_lots WHERE id = ? AND status != 'CANCELLED' AND qty_remaining > 0`, [lotId])
    : query(`SELECT id, qty_remaining, unit_cost FROM stock_lots
              WHERE product_id = ? AND status = 'ACTIVE' AND qty_remaining > 0
              ORDER BY acquired_at ASC, id ASC LIMIT 1`, [productId]);
  const r = rows[0];
  return r ? { id: String(r.id), qty: Number(r.qty_remaining) || 1, unitCost: Number(r.unit_cost) || 0 } : null;
}

/**
 * Verschiebt den Einstand des Artikels (`purchase_price`) und seines Loses (`unit_cost` je Stück) um
 * `delta` — positiv beim Kapitalisieren, negativ beim Zurücknehmen. Ein Zurücknehmen wird VOR dem
 * Schreiben geprüft: ist das Stück schon verkauft (kein aktives Los mehr), steckt der Betrag im
 * Wareneinsatz — das ist ein Nein; ein negativer Einstand ebenso.
 */
export function shiftOwnRepairCost(r: Pick<Repair, 'id' | 'productId' | 'lotId'>, delta: number, now: string, why: string): void {
  if (!r.productId || !Number.isFinite(delta) || Math.abs(delta) < EPS) return;
  const p = query('SELECT purchase_price, stock_status FROM products WHERE id = ?', [r.productId])[0];
  if (!p) throw new RepairActionRejected('PRODUCT_NOT_FOUND', 'the repaired item is no longer in stock records');
  const lot = costLot(r.productId, r.lotId);
  if (delta < 0) {
    const hasLots = Number(query('SELECT COUNT(*) AS c FROM stock_lots WHERE product_id = ?', [r.productId])[0]?.c) > 0;
    if (String(p.stock_status) === 'sold' || (hasLots && !lot)) {
      throw new RepairActionRejected('REPAIR_COST_ALREADY_SOLD',
        'the item is already sold — its repair cost is part of the cost of sales and is not taken back');
    }
    if ((Number(p.purchase_price) || 0) + delta < -EPS || (lot && lot.unitCost + delta / lot.qty < -EPS)) {
      throw new RepairActionRejected('REPAIR_COST_NEGATIVE', 'taking this cost back would make the item cost negative');
    }
  }
  const db = getDatabase();
  db.run(`UPDATE products SET purchase_price = COALESCE(purchase_price, 0) + ?, updated_at = ? WHERE id = ?`, [delta, now, r.productId]);
  trackUpdate('products', r.productId, { purchasePriceDelta: delta, fromRepair: r.id, reason: why });
  if (lot) {
    db.run(`UPDATE stock_lots SET unit_cost = unit_cost + ? WHERE id = ?`, [delta / lot.qty, lot.id]);
    trackLotRow(lot.id, 'update');
  }
}

/** Eine schon (bar oder per Guthaben) beglichene Werkstattschuld bleibt im Einstand — ihre Zeile ist nicht mehr stornierbar. */
export function assertOwnRepairCostUnsettled(expenseId: string | null | undefined): void {
  if (!expenseId) return;
  const e = query('SELECT COALESCE(paid_amount, 0) AS paid FROM expenses WHERE id = ?', [expenseId])[0];
  if ((Number(e?.paid) || 0) > 0 || expenseHasActiveCreditSettlement(expenseId)) {
    throw new RepairActionRejected('REPAIR_COST_PAID',
      'the workshop cost of this line is already paid — it stays in the item cost; settle it with the workshop instead');
  }
}
