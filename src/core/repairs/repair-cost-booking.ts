// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY PP-13 + PP-14 — die Kosten einer Reparatur: EINE Domain, zwei Buchungsverträge.
//
// Vorher wirkte derselbe Werkstattbetrag über mehrere Wege: als Betriebsausgabe (Soll
// EXPENSES_OPERATING), im Einstand eigener Ware, im gespiegelten `internalCost` und im Wareneinsatz
// der Reparaturrechnung (Haben INVENTORY auch für Kundenware). Eigene Ware 300/100 ergab 100,
// Kundenware 300/100 ergab 0. Jetzt:
//
//   • Die Kosten zerfallen in drei Teile (`repairCostParts`, repair-cost.ts): eigene Arbeit, jede
//     offene Kostenzeile, und — nur ohne Zeilen mit verknüpfter Werkstatt (Altbestand) — die Gebühr.
//     JEDER Teil ist genau EINE Ausgabe: die Zeile bei „in Arbeit"/„an Werkstatt" bzw. beim Hinzufügen
//     danach (`commitRepairLineExpenses`), eigene Arbeit und Altgebühr bei „ready" (`syncRepairHeaderCosts`,
//     danach folgen sie jeder Änderung). Werkstatt → A/P an die Werkstatt; ohne Werkstatt → bezahlt über
//     `internal_paid_from`, sonst offen — dasselbe Muster wie die Werkstattgebühr des Hauses seit jeher.
//   • Das Konto folgt dem EIGENTUM (`repairCostAccount`, types.ts):
//       eigene Ware  → „Inventory"         → Soll INVENTORY; bei „ready" steigt der Einstand (Artikel + Los)
//                                            um genau diese Summe, der Verkauf bucht sie einmal als COGS aus;
//       Kundenware   → „RepairServiceCost" → Soll COGS (Dienstleistungs-Einstand), nie Bestand; die
//                                            Reparaturrechnung bucht dafür keinen zweiten Wareneinsatz.
//   • Die Zahlung ist nur Soll A/P / Haben Kasse/Bank. Rücknahmen werden VOR dem Schreiben geprüft:
//     beglichen → `REPAIR_COST_PAID`, abgerechnet → `REPAIR_ALREADY_INVOICED`, verkauft →
//     `REPAIR_COST_ALREADY_SOLD`, nie ein negativer Einstand.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query, currentUserId } from '@/core/db/helpers';
import { trackUpdate } from '@/core/sync/track';
import { trackLotRow } from '@/core/lots/lot-queries';
import { computeExpenseSettlement, creditPaidForExpense, expenseHasActiveCreditSettlement } from '@/core/finance/expenseSettlement';
import { hasLedgerEntries, postExpense, reverseSource } from '@/core/ledger/posting';
import { createExpenseInHouse } from '@/core/payables/payables-house';
import { canonicalRepairStatus, type Expense, type ExpenseCategory, type Repair } from '@/core/models/types';
import { repairCostParts } from './repair-cost';
import { RepairActionRejected } from './repair-rules';

const EPS = 0.0005;
const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));

/** Die Kategorie der Reparaturkosten nach Eigentum: eigene Ware → „Inventory", Kundenware → „RepairServiceCost". */
export function repairCostCategory(scope: string | null | undefined): ExpenseCategory {
  return scope === 'OWN' ? 'Inventory' : 'RepairServiceCost';
}

/** Steht der Einstand dieser Reparatur schon im Artikel? Bei eigener Ware geschieht das einmal, bei „ready". */
export function ownRepairCapitalized(r: Pick<Repair, 'repairScope' | 'completedAt' | 'status'>): boolean {
  return r.repairScope === 'OWN' && !!r.completedAt && canonicalRepairStatus(r.status) === 'READY';
}

/** Sind die Kopfkosten (eigene Arbeit, Altgebühr) gebucht? Einmal bei „ready" — danach folgen sie jeder Änderung. */
export function repairHeaderCostsBooked(r: Pick<Repair, 'status'>): boolean {
  const c = canonicalRepairStatus(r.status);
  return c === 'READY' || c === 'DELIVERED';
}

function openLineTotal(repairId: string): number {
  return Number(query(`SELECT COALESCE(SUM(cost_amount), 0) AS t FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'`,
    [repairId])[0]?.t) || 0;
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
 * `delta`. Geprüft VOR dem Schreiben: ist das Stück verkauft (kein aktives Los mehr), steckt der Einstand
 * im Wareneinsatz — weder Zu- noch Abgang ist dann noch richtig (Nein); ein negativer Einstand ebenso.
 */
export function shiftOwnRepairCost(r: Pick<Repair, 'id' | 'productId' | 'lotId'>, delta: number, now: string, why: string): void {
  if (!r.productId || !Number.isFinite(delta) || Math.abs(delta) < EPS) return;
  const p = query('SELECT purchase_price, stock_status FROM products WHERE id = ?', [r.productId])[0];
  if (!p) throw new RepairActionRejected('PRODUCT_NOT_FOUND', 'the repaired item is no longer in stock records');
  const lot = costLot(r.productId, r.lotId);
  const hasLots = Number(query('SELECT COUNT(*) AS c FROM stock_lots WHERE product_id = ?', [r.productId])[0]?.c) > 0;
  if (String(p.stock_status) === 'sold' || (hasLots && !lot)) {
    throw new RepairActionRejected('REPAIR_COST_ALREADY_SOLD',
      'the item is already sold — its cost is part of the cost of sales and is not changed any more');
  }
  if ((Number(p.purchase_price) || 0) + delta < -EPS || (lot && lot.unitCost + delta / lot.qty < -EPS)) {
    throw new RepairActionRejected('REPAIR_COST_NEGATIVE', 'taking this cost back would make the item cost negative');
  }
  const db = getDatabase();
  db.run(`UPDATE products SET purchase_price = COALESCE(purchase_price, 0) + ?, updated_at = ? WHERE id = ?`, [delta, now, r.productId]);
  trackUpdate('products', r.productId, { purchasePriceDelta: delta, fromRepair: r.id, reason: why });
  if (lot) {
    db.run(`UPDATE stock_lots SET unit_cost = unit_cost + ? WHERE id = ?`, [delta / lot.qty, lot.id]);
    trackLotRow(lot.id, 'update');
  }
}

/** Eine schon (bar oder per Guthaben) beglichene Reparaturkosten-Ausgabe bleibt — ihre Zeile ist nicht mehr stornierbar. */
export function assertRepairCostUnsettled(expenseId: string | null | undefined): void {
  if (!expenseId) return;
  const e = query('SELECT COALESCE(paid_amount, 0) AS paid FROM expenses WHERE id = ?', [expenseId])[0];
  if ((Number(e?.paid) || 0) > 0 || expenseHasActiveCreditSettlement(expenseId)) {
    throw new RepairActionRejected('REPAIR_COST_PAID',
      'this repair cost is already paid — it stays; settle it with the workshop instead');
  }
}

function expenseOfRow(r: Record<string, unknown>): Expense {
  return {
    id: String(r.id), expenseNumber: String(r.expense_number ?? ''), branchId: String(r.branch_id ?? ''),
    category: r.category as ExpenseCategory, amount: Number(r.amount) || 0, paidAmount: Number(r.paid_amount) || 0,
    paymentMethod: (r.payment_method as Expense['paymentMethod']) || 'bank', expenseDate: String(r.expense_date ?? ''),
    description: str(r.description), relatedModule: str(r.related_module), relatedEntityId: str(r.related_entity_id),
    supplierId: str(r.supplier_id), status: (r.status as Expense['status']) || 'PENDING', createdAt: String(r.created_at ?? ''),
  };
}

/** Die Kopfkosten-Ausgaben der Reparatur: an keiner Zeile, in der Kategorie der Reparaturkosten. Ohne Werkstatt = eigene Arbeit, mit = Altgebühr. */
function headerExpenses(repairId: string): { own?: Record<string, unknown>; fee?: Record<string, unknown> } {
  const rows = query(
    `SELECT e.* FROM expenses e
      WHERE e.related_module = 'repair' AND e.related_entity_id = ? AND e.status != 'CANCELLED'
        AND e.category IN ('Inventory', 'RepairServiceCost')
        AND NOT EXISTS (SELECT 1 FROM repair_lines l WHERE l.expense_id = e.id)
      ORDER BY e.created_at, e.id`, [repairId]);
  return { own: rows.find((e) => !e.supplier_id), fee: rows.find((e) => !!e.supplier_id) };
}

interface HeaderSpec { repairId: string; branchId: string; category: ExpenseCategory; now: string; paidFrom?: string; supplierId?: string; label: string }

/** Bringt EINE Kopfkosten-Ausgabe auf ihren Sollbetrag: anlegen, Betrag nachziehen (Storno + Neubuchung) oder stornieren. */
function adjustHeaderExpense(existing: Record<string, unknown> | undefined, target: number, s: HeaderSpec): void {
  if (!existing) {
    if (F(target) <= 0) return;
    const method = s.paidFrom === 'cash' || s.paidFrom === 'bank' || s.paidFrom === 'benefit' ? s.paidFrom : 'bank';
    let userId = '';
    try { userId = currentUserId(); } catch { /* ohne Sitzung schreibt der Haushaltsweg ohne Urheber */ }
    createExpenseInHouse({
      category: s.category, amount: target, paymentMethod: method, expenseDate: s.now.split('T')[0],
      description: s.label, initialPaid: s.paidFrom && !s.supplierId ? target : 0, supplierId: s.supplierId,
      relatedModule: 'repair', relatedEntityId: s.repairId,
    }, { branchId: s.branchId, userId, now: s.now });
    return;
  }
  const id = String(existing.id);
  const amount = Number(existing.amount) || 0;
  if (F(target) === F(amount)) return;
  const paid = Number(existing.paid_amount) || 0;
  const credit = creditPaidForExpense(id);
  if (F(target) < F(paid) + F(credit)) {
    throw new RepairActionRejected('REPAIR_COST_PAID', 'this repair cost is already paid — it cannot go below what is paid');
  }
  const db = getDatabase();
  if (F(target) <= 0) {
    db.run(`UPDATE expenses SET status = 'CANCELLED' WHERE id = ?`, [id]);
    if (hasLedgerEntries('EXPENSE', id)) reverseSource('EXPENSE', id, s.now);
    trackUpdate('expenses', id, { status: 'CANCELLED', fromRepair: s.repairId });
    return;
  }
  const status = computeExpenseSettlement(target, paid, credit, String(existing.status)).status;
  db.run(`UPDATE expenses SET amount = ?, status = ? WHERE id = ?`, [target, status, id]);
  if (hasLedgerEntries('EXPENSE', id)) reverseSource('EXPENSE', id, s.now);
  postExpense(expenseOfRow(query('SELECT * FROM expenses WHERE id = ?', [id])[0]));
  trackUpdate('expenses', id, { amount: target, status, fromRepair: s.repairId });
}

/**
 * Die Kopfkosten (eigene Arbeit, Altgebühr) auf den Stand der Reparatur bringen — bei „ready" zum
 * ersten Mal, danach nach jeder Änderung. Eigene Ware: der Einstand folgt um genau die Differenz
 * (`capitalize`, nur wenn schon kapitalisiert). Eine abgerechnete Reparatur ändert ihre Kosten nicht mehr.
 */
export function syncRepairHeaderCosts(repairId: string, now: string, opts: { capitalize: boolean }): void {
  const r = query(`SELECT id, branch_id, repair_number, repair_scope, repair_type, internal_cost, estimated_cost,
      workshop_supplier_id, internal_paid_from, invoice_id, product_id, lot_id FROM repairs WHERE id = ?`, [repairId])[0];
  if (!r) return;
  const parts = repairCostParts({
    repairType: str(r.repair_type), internalCost: Number(r.internal_cost) || 0,
    estimatedCost: r.estimated_cost === null || r.estimated_cost === undefined ? null : Number(r.estimated_cost),
    workshopSupplierId: str(r.workshop_supplier_id),
  }, openLineTotal(repairId));
  const { own, fee } = headerExpenses(repairId);
  const dOwn = parts.own - (own ? Number(own.amount) || 0 : 0);
  const dFee = parts.fee - (fee ? Number(fee.amount) || 0 : 0);
  const feeMoved = !!fee && parts.fee > 0 && str(fee.supplier_id) !== str(r.workshop_supplier_id);
  if (Math.abs(dOwn) < EPS && Math.abs(dFee) < EPS && !feeMoved) return;
  if (str(r.invoice_id)) {
    throw new RepairActionRejected('REPAIR_ALREADY_INVOICED',
      'this repair is already invoiced — its costs are part of the invoice and are not changed any more');
  }
  const scope = str(r.repair_scope) ?? 'CUSTOMER';
  const nr = str(r.repair_number) ?? '';
  const base = { repairId, branchId: str(r.branch_id) ?? '', category: repairCostCategory(scope), now, paidFrom: str(r.internal_paid_from) };
  adjustHeaderExpense(own, parts.own, { ...base, label: `${nr} · own work` });
  const workshop = { ...base, supplierId: str(r.workshop_supplier_id), label: `External repair ${nr}` };
  if (feeMoved) {
    adjustHeaderExpense(fee, 0, workshop);
    adjustHeaderExpense(undefined, parts.fee, workshop);
  } else {
    adjustHeaderExpense(fee, parts.fee, workshop);
  }
  if (opts.capitalize && scope === 'OWN') {
    shiftOwnRepairCost({ id: repairId, productId: str(r.product_id), lotId: str(r.lot_id) }, dOwn + dFee, now, 'header-cost');
  }
}
