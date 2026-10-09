// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Auskünfte (Spec 12): Seite „Bulk Metals", Lot-Detail mit Verlauf und „Sold as",
// Lot-Auswahl der Rechnung, COGS-Vorschau, Lagerwert und Abstimmung mit dem Hauptbuch. Alles liest
// nur und rechnet in mg/Fils; PC2 bekommt dieselben Zahlen über Lesebefehle vom Primary.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import type { BusinessReadContext } from '@/core/data/read-context';
import { allocateFils, assertWeightMg, BulkRejected } from './bulk-math';
import { bulkProductName, type BulkMetal } from './bulk-product';
import { getBulkLot, lotFromRow, movementFromRow, type BulkLot, type BulkMovementKind } from './bulk-lot-house';

export interface BulkLotRow {
  id: string;
  lotNo: string;
  productId: string;
  metal: BulkMetal;
  fineness: string;
  purchaseId: string | null;
  purchaseNumber: string | null;
  supplierName: string | null;
  acquiredAt: string;
  originalWeightMg: number;
  remainingWeightMg: number;
  originalValueFils: number;
  remainingValueFils: number;
  saleTaxScheme: string;
  status: string;
  revision: number;
  closedAt: string | null;
  /** Nur PURCHASE/WEIGHT_CORRECTION → Korrektur und Einkaufsstorno möglich. */
  unused: boolean;
  /** Die letzte Bewegung — nur sie ist (als WRITE_OFF/CLOSE) stornierbar. */
  lastMovement: { id: string; seq: number; kind: BulkMovementKind; reversed: boolean } | null;
}

export interface BulkArticle {
  productId: string;
  metal: BulkMetal;
  fineness: string;
  name: string;
  remainingWeightMg: number;
  remainingValueFils: number;
  lots: BulkLotRow[];
}

export interface BulkPageData {
  articles: BulkArticle[];
  totalValueFils: number;
  reconciliation: BulkReconciliation;
}

export interface BulkReconciliation { lotsValueFils: number; ledgerValueFils: number; ok: boolean }

const int = (v: unknown): number => Number(v ?? 0) || 0;
const fils = (v: unknown): number => Math.round((Number(v) || 0) * 1000);

function lotRows(branchId: string, where = '', params: unknown[] = []): BulkLotRow[] {
  const rows = query(
    `SELECT sl.*, p.purchase_number, s.name AS supplier_name,
            (SELECT COUNT(*) FROM bulk_lot_movements m WHERE m.lot_id = sl.id AND m.kind NOT IN ('PURCHASE','WEIGHT_CORRECTION')) AS used_moves
       FROM stock_lots sl
       LEFT JOIN purchases p ON p.id = sl.purchase_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE sl.unit = 'mg' AND sl.branch_id = ?${where}
      ORDER BY sl.metal_type, sl.fineness, sl.acquired_at, sl.lot_no`,
    [branchId, ...params],
  );
  return rows.map((r) => {
    const lot = lotFromRow(r);
    const last = query('SELECT * FROM bulk_lot_movements WHERE lot_id = ? ORDER BY seq DESC LIMIT 1', [lot.id])[0];
    const lm = last ? movementFromRow(last) : null;
    return {
      id: lot.id, lotNo: lot.lotNo, productId: lot.productId, metal: lot.metal, fineness: lot.fineness,
      purchaseId: lot.purchaseId, purchaseNumber: (r.purchase_number as string) || null, supplierName: (r.supplier_name as string) || null,
      acquiredAt: lot.acquiredAt, originalWeightMg: lot.originalWeightMg, remainingWeightMg: lot.remainingWeightMg,
      originalValueFils: lot.originalValueFils, remainingValueFils: lot.remainingValueFils, saleTaxScheme: lot.saleTaxScheme,
      status: lot.status, revision: lot.revision, closedAt: lot.closedAt, unused: int(r.used_moves) === 0,
      lastMovement: lm ? {
        id: lm.id, seq: lm.seq, kind: lm.kind,
        reversed: !!query('SELECT 1 FROM bulk_lot_movements WHERE reverses_movement_id = ?', [lm.id])[0],
      } : null,
    };
  });
}

/** Seite „Bulk Metals": je Artikel die Lots mit Rest, Wert, Status; dazu Gesamtwert und Abstimmung. */
export function bulkMetalsPageFor(ctx: BusinessReadContext): BulkPageData {
  const lots = lotRows(ctx.branchId);
  const byProduct = new Map<string, BulkArticle>();
  for (const l of lots) {
    let a = byProduct.get(l.productId);
    if (!a) {
      a = { productId: l.productId, metal: l.metal, fineness: l.fineness, name: bulkProductName(l.metal, l.fineness), remainingWeightMg: 0, remainingValueFils: 0, lots: [] };
      byProduct.set(l.productId, a);
    }
    a.lots.push(l);
    if (l.status !== 'CANCELLED') { a.remainingWeightMg += l.remainingWeightMg; a.remainingValueFils += l.remainingValueFils; }
  }
  const articles = [...byProduct.values()];
  return {
    articles,
    totalValueFils: articles.reduce((s, a) => s + a.remainingValueFils, 0),
    reconciliation: bulkLedgerReconciliation(ctx.branchId),
  };
}

export interface BulkSale {
  invoiceId: string; invoiceNumber: string; lineId: string; date: string; bulkType: string | null; description: string;
  weightMg: number; cogsFils: number; netRevenueFils: number; marginFils: number; returned: boolean; cancelled: boolean;
}
export interface BulkMovementView {
  id: string; seq: number; kind: BulkMovementKind; weightMg: number; valueFils: number; weightAfterMg: number; valueAfterFils: number;
  businessDate: string; createdAt: string; createdBy: string; reason: string | null; document: string; reversesMovementId: string | null; reversed: boolean;
}
export interface BulkLotDetail {
  lot: BulkLotRow & { composition: BulkLot['composition'] };
  movements: BulkMovementView[];
  soldAs: Array<{ bulkType: string; soldMg: number }>;
  sales: BulkSale[];
}

/** „Sold as" — Nettoaggregation aus dem AKTUELLEN Verkaufs-/Retourenzustand (Spec 12.1). */
export function soldAsFor(lotId: string): Array<{ bulkType: string; soldMg: number }> {
  return query(
    `SELECT il.bulk_type, SUM(il.bulk_weight_mg) AS sold_mg
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
      WHERE il.lot_id = ? AND il.bulk_weight_mg IS NOT NULL AND i.status <> 'CANCELLED'
        AND NOT EXISTS (SELECT 1 FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id
                         WHERE srl.invoice_line_id = il.id AND sr.status <> 'REJECTED')
      GROUP BY il.bulk_type ORDER BY il.bulk_type`,
    [lotId],
  ).map((r) => ({ bulkType: String(r.bulk_type ?? 'OTHER'), soldMg: int(r.sold_mg) }));
}

function documentOf(m: { kind: string; sourceModule: string; sourceId: string; reason: string | null }): string {
  if (m.sourceModule === 'INVOICE') {
    const r = query('SELECT invoice_number FROM invoices WHERE id = ?', [m.sourceId])[0];
    return r ? String(r.invoice_number) : 'deleted invoice';
  }
  if (m.sourceModule === 'SALES_RETURN') return String(query('SELECT return_number FROM sales_returns WHERE id = ?', [m.sourceId])[0]?.return_number ?? 'return');
  if (m.sourceModule === 'PURCHASE') return String(query('SELECT purchase_number FROM purchases WHERE id = ?', [m.sourceId])[0]?.purchase_number ?? 'purchase');
  return m.reason ?? '';
}

export function bulkLotDetailFor(ctx: BusinessReadContext, lotId: string): BulkLotDetail | null {
  const row = lotRows(ctx.branchId, ' AND sl.id = ?', [lotId])[0];
  if (!row) return null;
  const lot = getBulkLot(lotId)!;
  const users = new Map(query('SELECT id, name FROM users').map((u) => [String(u.id), String(u.name ?? '')]));
  const reversed = new Set(query('SELECT reverses_movement_id FROM bulk_lot_movements WHERE lot_id = ? AND reverses_movement_id IS NOT NULL', [lotId])
    .map((r) => String(r.reverses_movement_id)));
  const movements = query('SELECT * FROM bulk_lot_movements WHERE lot_id = ? ORDER BY seq', [lotId]).map((r) => {
    const m = movementFromRow(r);
    return {
      id: m.id, seq: m.seq, kind: m.kind, weightMg: m.weightMg, valueFils: m.valueFils, weightAfterMg: m.weightAfterMg, valueAfterFils: m.valueAfterFils,
      businessDate: m.businessDate, createdAt: m.createdAt, createdBy: users.get(m.createdBy) || m.createdBy, reason: m.reason,
      document: documentOf(m), reversesMovementId: m.reversesMovementId, reversed: reversed.has(m.id),
    };
  });
  const sales = query(
    `SELECT il.id, il.invoice_id, il.bulk_type, il.description, il.bulk_weight_mg, il.bulk_cogs_fils, il.line_total, il.vat_amount,
            i.invoice_number, i.issued_at, i.status,
            EXISTS (SELECT 1 FROM sales_return_lines srl JOIN sales_returns sr ON sr.id = srl.return_id
                     WHERE srl.invoice_line_id = il.id AND sr.status <> 'REJECTED') AS returned
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE il.lot_id = ? AND il.bulk_weight_mg IS NOT NULL
      ORDER BY i.issued_at, i.invoice_number`, [lotId],
  ).map((r) => {
    const net = fils(r.line_total) - fils(r.vat_amount);
    const cogs = int(r.bulk_cogs_fils);
    return {
      invoiceId: String(r.invoice_id), invoiceNumber: String(r.invoice_number ?? ''), lineId: String(r.id), date: String(r.issued_at ?? '').slice(0, 10),
      bulkType: (r.bulk_type as string) || null, description: String(r.description ?? ''), weightMg: int(r.bulk_weight_mg), cogsFils: cogs,
      netRevenueFils: net, marginFils: net - cogs, returned: int(r.returned) === 1, cancelled: String(r.status) === 'CANCELLED',
    };
  });
  return { lot: { ...row, composition: lot.composition }, movements, soldAs: soldAsFor(lotId), sales };
}

export interface BulkLotForSale {
  lotId: string; lotNo: string; productId: string; metal: BulkMetal; fineness: string; acquiredAt: string;
  remainingWeightMg: number; remainingValueFils: number; saleTaxScheme: string; revision: number;
}

/** Lot-Auswahl der Rechnung: aktive Bulk-Lots mit Restgewicht (manuelle Wahl, kein FIFO). */
export function bulkLotsForSaleFor(ctx: BusinessReadContext): BulkLotForSale[] {
  return query(
    `SELECT * FROM stock_lots WHERE unit = 'mg' AND branch_id = ? AND status = 'ACTIVE' AND remaining_weight_mg > 0
      ORDER BY metal_type, fineness, acquired_at, lot_no`, [ctx.branchId],
  ).map((r) => {
    const l = lotFromRow(r);
    return { lotId: l.id, lotNo: l.lotNo, productId: l.productId, metal: l.metal, fineness: l.fineness, acquiredAt: l.acquiredAt,
      remainingWeightMg: l.remainingWeightMg, remainingValueFils: l.remainingValueFils, saleTaxScheme: l.saleTaxScheme, revision: l.revision };
  });
}

/** COGS-Vorschau (nur Anzeige — gespeichert wird die Zuteilung der Transaktion). */
export function bulkAllocationPreviewFor(ctx: BusinessReadContext, lotId: string, weightMg: unknown):
  { cogsFils: number; remainingAfterWeightMg: number; remainingAfterValueFils: number } {
  const lot = getBulkLot(lotId);
  if (!lot || lot.branchId !== ctx.branchId) throw new BulkRejected('BULK_LOT_NOT_FOUND', 'no such bulk lot in this branch');
  const w = assertWeightMg(weightMg);
  const cogs = allocateFils(lot.remainingValueFils, lot.remainingWeightMg, w);
  return { cogsFils: cogs, remainingAfterWeightMg: lot.remainingWeightMg - w, remainingAfterValueFils: lot.remainingValueFils - cogs };
}

/** Lagerwert Bulk (Spec 12.4): Σ Restwert der aktiven Bulk-Lots, dazu Gewicht je Metall/Feinheit. */
export function bulkInventoryValuation(branchId: string): { valueFils: number; byGrade: Array<{ metal: string; fineness: string; weightMg: number; valueFils: number }> } {
  const rows = query(
    `SELECT metal_type, fineness, SUM(remaining_weight_mg) AS w, SUM(remaining_value_fils) AS v
       FROM stock_lots WHERE unit = 'mg' AND branch_id = ? AND status = 'ACTIVE'
      GROUP BY metal_type, fineness ORDER BY metal_type, fineness`, [branchId],
  );
  const byGrade = rows.map((r) => ({ metal: String(r.metal_type), fineness: String(r.fineness), weightMg: int(r.w), valueFils: int(r.v) }));
  return { valueFils: byGrade.reduce((s, g) => s + g.valueFils, 0), byGrade };
}

/** Bestandsverlust (Write-off, Close, abzüglich Stornierungen) im Zeitraum — für Gewinn-Auswertungen. */
export function bulkInventoryLossFils(branchId: string, from?: string, to?: string): number {
  const conds = [`branch_id = ?`, `kind IN ('WRITE_OFF','CLOSE','ADJUSTMENT_REVERSAL')`];
  const params: unknown[] = [branchId];
  if (from) { conds.push('business_date >= ?'); params.push(from.slice(0, 10)); }
  if (to) { conds.push('business_date <= ?'); params.push(to.slice(0, 10)); }
  return -int(query(`SELECT COALESCE(SUM(value_fils), 0) AS v FROM bulk_lot_movements WHERE ${conds.join(' AND ')}`, params)[0]?.v);
}

/** Derselbe Bestandsverlust je Geschäftstag (Fils) — reist mit den Lot-Zahlen zu PC2. */
export function bulkLossByDay(branchId: string): Array<[string, number]> {
  return query(
    `SELECT business_date, -SUM(value_fils) AS v FROM bulk_lot_movements
      WHERE branch_id = ? AND kind IN ('WRITE_OFF','CLOSE','ADJUSTMENT_REVERSAL') GROUP BY business_date`, [branchId],
  ).map((r) => [String(r.business_date), int(r.v)] as [string, number]);
}

/**
 * Abstimmung (Invariante 11): Σ Restwert aller Bulk-Lots = Summe der INVENTORY-Buchungen, die an
 * Bulk-Quellen hängen (Einkaufszeile, Rechnungszeile, Retouren-COGS der Zeile, manuelle Aktion).
 */
export function bulkLedgerReconciliation(branchId: string): BulkReconciliation {
  const lotsValueFils = int(query(`SELECT COALESCE(SUM(remaining_value_fils), 0) AS v FROM stock_lots WHERE unit = 'mg' AND branch_id = ?`, [branchId])[0]?.v);
  const ledger = query(
    `SELECT COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE -e.amount END), 0) AS v
       FROM ledger_entries e
      WHERE e.account = 'INVENTORY' AND e.branch_id = ? AND (
            (e.source_module = 'PURCHASE' AND e.source_line_id IN (SELECT purchase_line_id FROM stock_lots WHERE unit = 'mg' AND purchase_line_id IS NOT NULL))
         OR (e.source_module IN ('INVOICE','SALES_RETURN_COGS') AND e.source_line_id IN (SELECT id FROM invoice_lines WHERE bulk_weight_mg IS NOT NULL))
         OR (e.source_module = 'STOCK_ADJUST' AND e.source_id IN (SELECT action_id FROM bulk_lot_movements WHERE action_id IS NOT NULL)))`,
    [branchId],
  )[0];
  const ledgerValueFils = fils(ledger?.v);
  return { lotsValueFils, ledgerValueFils, ok: lotsValueFils === ledgerValueFils };
}
