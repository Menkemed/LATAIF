// Stock-Lots Helpers — pure functions auf DB-Ebene.
// Single source of truth fuer "welche Lots gibt es fuer Produkt X" und
// fuer Consume/Restore beim Verkauf.
//
// Phase 3 (Sale-Picker): UI ruft getActiveLots auf.
// Phase 4 (Cost-Snapshot): InvoiceStore ruft consumeLot bei Sale-Insert auf.

import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';

export interface StockLot {
  id: string;
  branchId: string;
  productId: string;
  purchaseId: string | null;
  purchaseLineId: string | null;
  unitCost: number;
  qtyTotal: number;
  qtyRemaining: number;
  status: 'ACTIVE' | 'EXHAUSTED' | 'CANCELLED';
  acquiredAt: string;   // YYYY-MM-DD (Purchase-Datum) — fuer FIFO-Sort
  createdAt: string;
}

function rowToLot(row: Record<string, unknown>): StockLot {
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    productId: row.product_id as string,
    purchaseId: (row.purchase_id as string) || null,
    purchaseLineId: (row.purchase_line_id as string) || null,
    unitCost: Number(row.unit_cost) || 0,
    qtyTotal: Number(row.qty_total) || 0,
    qtyRemaining: Number(row.qty_remaining) || 0,
    status: (row.status as StockLot['status']) || 'ACTIVE',
    acquiredAt: row.acquired_at as string,
    createdAt: row.created_at as string,
  };
}

// Aktive Lots fuer ein Produkt, FIFO-sortiert (aelteste zuerst, dann id fuer Determinismus).
// "Aktiv" = status=ACTIVE UND qty_remaining > 0. Auch EXHAUSTED Lots koennen bei
// Returns wieder qty_remaining > 0 bekommen — die werden hier mit angezeigt
// damit Refunds nicht "stuck" sind.
export function getActiveLots(productId: string): StockLot[] {
  const rows = query(
    `SELECT * FROM stock_lots
      WHERE product_id = ?
        AND status != 'CANCELLED'
        AND qty_remaining > 0
      ORDER BY acquired_at ASC, id ASC`,
    [productId]
  );
  return rows.map(rowToLot);
}

// Fuer Anzeige im Lot-Picker: kompaktes Label mit Datum + Cost + Restbestand.
// z.B. "PUR-2026-000017 — 2026-05-09 @ 400 BHD (2 von 2)"
export function formatLotLabel(lot: StockLot, purchaseNumber?: string): string {
  const parts: string[] = [];
  if (purchaseNumber) parts.push(purchaseNumber);
  parts.push(lot.acquiredAt);
  parts.push(`${lot.unitCost.toLocaleString('en-US', { maximumFractionDigits: 0 })} BHD`);
  parts.push(`(${lot.qtyRemaining}/${lot.qtyTotal})`);
  return parts.join(' · ');
}

// Lookup Purchase-Number + Supplier-Name fuer Lot-Label. N+1 vermeiden:
// idealerweise vom Caller batched, aber fuer 2-3 Lots pro Produkt ist die
// einfache Variante ok. Supplier-Name kommt aus dem Purchase-Header (jeder Lot
// gehoert zu genau einem Purchase, jeder Purchase zu genau einem Supplier).
export function getLotsWithPurchaseNumbers(productId: string): Array<StockLot & {
  purchaseNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
}> {
  const rows = query(
    `SELECT sl.*, p.purchase_number, p.supplier_id, s.name AS supplier_name
       FROM stock_lots sl
       LEFT JOIN purchases p ON p.id = sl.purchase_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE sl.product_id = ?
        AND sl.status != 'CANCELLED'
        AND sl.qty_remaining > 0
      ORDER BY sl.acquired_at ASC, sl.id ASC`,
    [productId]
  );
  return rows.map(r => ({
    ...rowToLot(r),
    purchaseNumber: (r.purchase_number as string) || null,
    supplierId: (r.supplier_id as string) || null,
    supplierName: (r.supplier_name as string) || null,
  }));
}

export function getLot(lotId: string): StockLot | null {
  const rows = query(`SELECT * FROM stock_lots WHERE id = ?`, [lotId]);
  return rows.length > 0 ? rowToLot(rows[0]) : null;
}

// Reduziert qty_remaining um qty. Setzt status='EXHAUSTED' wenn 0 erreicht.
// Wird vom InvoiceStore aufgerufen wenn eine invoice_line gespeichert wird.
// Gibt true zurueck bei Erfolg, false wenn Lot nicht aktiv oder zu wenig Bestand.
export function consumeLot(lotId: string, qty: number): boolean {
  const db = getDatabase();
  const lot = getLot(lotId);
  if (!lot || lot.status === 'CANCELLED') return false;
  if (lot.qtyRemaining < qty) return false;
  const newRem = lot.qtyRemaining - qty;
  const newStatus = newRem <= 0 ? 'EXHAUSTED' : 'ACTIVE';
  db.run(
    `UPDATE stock_lots SET qty_remaining = ?, status = ? WHERE id = ?`,
    [newRem, newStatus, lotId]
  );
  return true;
}

// Inverse von consumeLot — fuer Sales-Returns / Invoice-Cancel.
// Setzt status zurueck auf ACTIVE wenn der Lot nicht CANCELLED ist.
export function restoreLot(lotId: string, qty: number): boolean {
  const db = getDatabase();
  const lot = getLot(lotId);
  if (!lot || lot.status === 'CANCELLED') return false;
  const newRem = Math.min(lot.qtyTotal, lot.qtyRemaining + qty);
  db.run(
    `UPDATE stock_lots SET qty_remaining = ?, status = 'ACTIVE' WHERE id = ?`,
    [newRem, lotId]
  );
  return true;
}

// Summe verfuegbarer Stueck-Anzahl fuer ein Produkt — Stock-Validation im Picker.
// Beruecksichtigt nur ACTIVE Lots mit qty_remaining > 0.
export function getAvailableStock(productId: string): number {
  const rows = query(
    `SELECT COALESCE(SUM(qty_remaining), 0) AS qty
       FROM stock_lots
      WHERE product_id = ?
        AND status != 'CANCELLED'
        AND qty_remaining > 0`,
    [productId]
  );
  return Number(rows[0]?.qty) || 0;
}

// Phase 7 Sync — products.quantity aus stock_lots ableiten und zurueckschreiben.
// Wird nach jeder qty_remaining-mutierenden Aktion aufgerufen (Purchase create/cancel/delete,
// Invoice consume/restore, etc.) damit der Legacy product.quantity Bestand-konsistent bleibt.
// Setzt KEINE Werte fuer Produkte ohne Lots (Legacy/Service-Produkte) — die behalten ihr
// urspruengliches quantity-Feld.
export function syncProductQuantity(productId: string): void {
  const db = getDatabase();
  const rows = query(
    `SELECT COALESCE(SUM(qty_remaining), 0) AS qty,
            COUNT(*) AS lots
       FROM stock_lots
      WHERE product_id = ?
        AND status != 'CANCELLED'
        AND qty_remaining > 0`,
    [productId]
  );
  const lotCount = Number(rows[0]?.lots) || 0;
  if (lotCount === 0) return;  // keine Lots → product.quantity unangetastet lassen
  const qty = Number(rows[0]?.qty) || 0;
  db.run(`UPDATE products SET quantity = ? WHERE id = ?`, [qty, productId]);
}

// 2026-05-16 — Partial-Payment Reservation:
// Wenn ein Produkt durch einen Sale verbraucht wurde, aber die Invoice
// noch nicht FINAL ist, setzen wir stock_status auf 'reserved' (statt 'sold').
// So sieht man auf einen Blick "Verkauft, aber noch nicht voll bezahlt", und
// das Produkt taucht nicht als verfuegbar in der Collection auf — kann aber
// nicht doppelt verkauft werden.
//
// Consignment-Items haben einen eigenen Lifecycle:
//   consignment → consignment_reserved → sold
// (statt in_stock → reserved → sold), damit man im UI weiter sieht dass
// das Produkt urspruenglich vom Konsignator kam.
//
// "Verbraucht" wird Lot-basiert geprueft (sum(qty_remaining) ueber ACTIVE-Lots),
// nicht ueber products.quantity — letzteres wird von syncProductQuantity nicht
// auf 0 gesetzt (Legacy-Schutz fuer Produkte ohne Lots).
//
// Idempotent + defensiv: greift nur ein wenn der bisherige Status 'in_stock',
// 'offered' oder 'consignment' war. Andere Zustaende (in_repair, with_agent,
// sold, returned) haben eigene Lebenszyklen und werden nicht angefasst.
// Legacy-Produkte ohne Lots werden ebenfalls uebersprungen.
export function reserveProductIfDepleted(productId: string): void {
  const db = getDatabase();
  const lotRows = query(
    `SELECT COUNT(*) AS total_lots,
            COALESCE(SUM(CASE WHEN status != 'CANCELLED' AND qty_remaining > 0 THEN qty_remaining ELSE 0 END), 0) AS active_qty
       FROM stock_lots WHERE product_id = ?`,
    [productId]
  );
  const totalLots = Number(lotRows[0]?.total_lots) || 0;
  const activeQty = Number(lotRows[0]?.active_qty) || 0;
  if (totalLots === 0) return;   // Legacy/Service-Produkt ohne Lots
  if (activeQty > 0) return;     // noch Bestand vorhanden

  const prodRows = query(`SELECT stock_status FROM products WHERE id = ?`, [productId]);
  if (prodRows.length === 0) return;
  const status = String(prodRows[0].stock_status || '');
  let nextStatus: string | null = null;
  if (status === 'in_stock' || status === 'offered') nextStatus = 'reserved';
  else if (status === 'consignment') nextStatus = 'consignment_reserved';
  if (!nextStatus) return;
  db.run(`UPDATE products SET stock_status = ?, updated_at = ? WHERE id = ?`,
    [nextStatus, new Date().toISOString(), productId]);
}

// Umkehrung: wird ein Sale storniert oder Lines neu geschrieben und gibt
// Bestand wieder frei, ruecksetzen wir
//   'reserved'              → 'in_stock'
//   'consignment_reserved'  → 'consignment'
// Andere Stati (sold, in_repair, ...) bleiben unangetastet.
export function unreserveProductIfRestored(productId: string): void {
  const db = getDatabase();
  const lotRows = query(
    `SELECT COALESCE(SUM(CASE WHEN status != 'CANCELLED' AND qty_remaining > 0 THEN qty_remaining ELSE 0 END), 0) AS active_qty
       FROM stock_lots WHERE product_id = ?`,
    [productId]
  );
  const activeQty = Number(lotRows[0]?.active_qty) || 0;
  if (activeQty <= 0) return;

  const prodRows = query(`SELECT stock_status FROM products WHERE id = ?`, [productId]);
  if (prodRows.length === 0) return;
  const status = String(prodRows[0].stock_status || '');
  let nextStatus: string | null = null;
  if (status === 'reserved') nextStatus = 'in_stock';
  else if (status === 'consignment_reserved') nextStatus = 'consignment';
  if (!nextStatus) return;
  db.run(`UPDATE products SET stock_status = ?, updated_at = ? WHERE id = ?`,
    [nextStatus, new Date().toISOString(), productId]);
}

// Bulk-Variante fuer Migration / Recompute-All.
export function syncAllProductQuantities(): number {
  const db = getDatabase();
  db.run(
    `UPDATE products
        SET quantity = (
          SELECT COALESCE(SUM(qty_remaining), 0)
            FROM stock_lots
           WHERE stock_lots.product_id = products.id
             AND stock_lots.status != 'CANCELLED'
             AND stock_lots.qty_remaining > 0
        )
      WHERE id IN (
        SELECT DISTINCT product_id FROM stock_lots
         WHERE status != 'CANCELLED' AND qty_remaining > 0
      )`
  );
  const changed = query(`SELECT changes() AS n`);
  return Number(changed[0]?.n) || 0;
}

// Phase 6 — Display-Cost fuer ein Produkt aus den Lots ableiten. Liefert
//   - die FIFO-Cost (= naechster Sale-Cost-Snapshot) fuer "Cost"-Anzeigen,
//   - oder einen weighted-avg fallback ueber alle aktiven Lots,
//   - oder null wenn keine Lots existieren (Caller faellt auf product.purchase_price zurueck).
//
// Nutzung in ProductDetail/InvoiceCreate/Reports: Anzeige "Cost: X BHD (lot)" statt
// direktem Zugriff auf product.purchase_price. So erkennt der User dass mehrere
// Kaeufe verschiedene Cost-Snapshots haben.
export function deriveProductCostFromLots(productId: string): { fifoCost: number; weightedAvg: number; lotCount: number } | null {
  const rows = query(
    `SELECT id, unit_cost, qty_remaining, acquired_at
       FROM stock_lots
      WHERE product_id = ?
        AND status != 'CANCELLED'
        AND qty_remaining > 0
      ORDER BY acquired_at ASC, id ASC`,
    [productId]
  );
  if (rows.length === 0) return null;
  const fifoCost = Number(rows[0].unit_cost) || 0;
  let totalQty = 0, totalValue = 0;
  for (const r of rows) {
    const qty = Number(r.qty_remaining) || 0;
    const cost = Number(r.unit_cost) || 0;
    totalQty += qty;
    totalValue += qty * cost;
  }
  const weightedAvg = totalQty > 0 ? totalValue / totalQty : fifoCost;
  return { fifoCost, weightedAvg, lotCount: rows.length };
}

export interface LotAggregate {
  totalQty: number;       // Summe qty_remaining ueber alle aktiven Lots
  totalValue: number;     // Summe qty_remaining * unit_cost (= echter Bestandswert)
  minCost: number;        // niedrigste unit_cost ueber aktive Lots
  maxCost: number;        // hoechste unit_cost
  weightedAvg: number;    // totalValue / totalQty
  lotCount: number;
}

// Phase 7 — Bulk-Aggregat fuer Dashboard/Reports/WatchList. Eine einzige Query
// pro Aufruf statt N+1: liefert pro productId die Lot-Summen. Caller faellt
// auf product.purchase_price * quantity zurueck wenn productId nicht in der Map ist.
export function getStockAggregates(productIds?: string[]): Map<string, LotAggregate> {
  const map = new Map<string, LotAggregate>();
  let sql = `SELECT product_id,
                    SUM(qty_remaining)              AS total_qty,
                    SUM(qty_remaining * unit_cost)  AS total_value,
                    MIN(unit_cost)                  AS min_cost,
                    MAX(unit_cost)                  AS max_cost,
                    COUNT(*)                        AS lot_count
               FROM stock_lots
              WHERE status != 'CANCELLED'
                AND qty_remaining > 0`;
  const params: unknown[] = [];
  if (productIds && productIds.length > 0) {
    // sql.js akzeptiert kein Array-Binding — Platzhalter inlinen, Werte gebunden.
    sql += ` AND product_id IN (${productIds.map(() => '?').join(',')})`;
    params.push(...productIds);
  }
  sql += ` GROUP BY product_id`;
  const rows = query(sql, params);
  for (const r of rows) {
    const totalQty = Number(r.total_qty) || 0;
    const totalValue = Number(r.total_value) || 0;
    map.set(r.product_id as string, {
      totalQty,
      totalValue,
      minCost: Number(r.min_cost) || 0,
      maxCost: Number(r.max_cost) || 0,
      weightedAvg: totalQty > 0 ? totalValue / totalQty : 0,
      lotCount: Number(r.lot_count) || 0,
    });
  }
  return map;
}
