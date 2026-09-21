// ════════════════════════════════════════════════════════════════════════════
// STOCK-LOT-INTEGRITY — der EINE Bestandsvertrag eines Verkaufs.
//
// Ein Lagerartikel wird beim fachlichen Verkauf (Rechnung anlegen/ändern, Agentenverkauf)
// verbraucht — nicht pauschal beim Bezahlen. Zwei Formen, ein Vertrag:
//   • mit Los:  das Los trägt den Bestand (consumeLot/restoreLot, Menge folgt den Losen);
//   • ohne Los: `products.quantity` IST der Bestand (manuell/mobil angelegte Artikel,
//               Auftrags-Einzelstück). Verbraucht wird genau die Zeilenmenge.
// Ausnahmen, ausdrücklich: das Reparatur-Serviceprodukt (`svc-repair-*`) ist kein Lagerartikel;
// eine Zeile, deren Stück der Agentenverkauf schon hält, verbraucht nichts ein zweites Mal.
//
// Was eine Zeile genommen hat, steht in `invoice_lines.stock_taken` — Storno, Löschen und Ändern
// geben GENAU das zurück. NULL heißt: Zeile von vor diesem Vertrag; für sie bleiben die alten
// Wege unverändert (kein Raten über früher Abgezogenes).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { restoreLot, trackProductRow } from './lot-queries';
import { STOCK_UNAVAILABLE_MESSAGE } from './lot-availability';

/** Das Reparatur-Serviceprodukt ist eine Leistung, kein Lagerartikel. */
export function isServiceProduct(productId: string | null | undefined): boolean {
  return String(productId ?? '').startsWith('svc-repair-');
}

/** Wird der Artikel über Lose geführt (gibt es irgendeine Los-Zeile)? */
export function hasLotHistory(productId: string): boolean {
  return query('SELECT 1 FROM stock_lots WHERE product_id = ? LIMIT 1', [productId]).length > 0;
}

/** Artikel ohne Los, dessen Bestand `products.quantity` ist. */
function isLotLessStock(productId: string | null | undefined): productId is string {
  return !!productId && !isServiceProduct(productId) && !hasLotHistory(productId);
}

function rawQuantity(productId: string): number {
  return Number(query('SELECT COALESCE(quantity, 0) AS q FROM products WHERE id = ?', [productId])[0]?.q ?? 0);
}

export interface StockPick {
  productId?: string | null;
  lotId: string | null;
  qty: number;
  /** Das Stück hält schon ein anderer Vorgang (Agentenverkauf) — nichts ein zweites Mal nehmen. */
  preTaken?: boolean;
}

/**
 * Vor jedem Schreiben: reicht der Bestand der Artikel ohne Los für ALLE Zeilen zusammen?
 * (Mit Los prüfen `assertLotsConsumable` / `assertLotTrackedLinesResolved`.)
 */
export function assertLotLessStockAvailable(picks: readonly StockPick[]): void {
  const need = new Map<string, number>();
  for (const p of picks) {
    if (p.preTaken || p.lotId || !isLotLessStock(p.productId)) continue;
    need.set(p.productId, (need.get(p.productId) ?? 0) + Math.max(1, p.qty || 1));
  }
  for (const [pid, qty] of need) {
    if (rawQuantity(pid) < qty - 0.0005) throw new Error(STOCK_UNAVAILABLE_MESSAGE);
  }
}

/**
 * Nimmt den Bestand einer frisch geschriebenen Zeile und sagt, wie viel sie genommen hat.
 * Das Los selbst verbraucht der Aufrufer wie bisher (`consumeLot`); hier nur die Zahl dazu.
 */
export function takeStock(p: StockPick, now: string): number {
  const qty = Math.max(1, p.qty || 1);
  if (p.preTaken || !p.productId || isServiceProduct(p.productId)) return 0;
  if (p.lotId) return qty;
  if (!isLotLessStock(p.productId)) return 0;   // Los-Artikel ohne Los: vorher abgewiesen
  const db = getDatabase();
  const rest = rawQuantity(p.productId) - qty;
  if (rest < -0.0005) throw new Error(STOCK_UNAVAILABLE_MESSAGE);
  db.run(
    `UPDATE products SET quantity = ?,
       stock_status = CASE
         WHEN ? > 0 THEN stock_status
         WHEN stock_status IN ('in_stock', 'offered') THEN 'reserved'
         WHEN stock_status = 'consignment' THEN 'consignment_reserved'
         ELSE stock_status END,
       updated_at = ? WHERE id = ?`,
    [Math.max(0, rest), rest, now, p.productId],
  );
  trackProductRow(p.productId);
  return qty;
}

/** Gibt GENAU zurück, was eine Zeile/ein Vorgang genommen hat (`taken` > 0). */
export function giveBackStock(productId: string | null | undefined, lotId: string | null, taken: number, now: string): void {
  if (!(taken > 0) || !productId) return;
  if (lotId) { restoreLot(lotId, taken); return; }
  if (isServiceProduct(productId)) return;
  const db = getDatabase();
  db.run(
    `UPDATE products SET quantity = COALESCE(quantity, 0) + ?,
       stock_status = CASE
         WHEN stock_status IN ('reserved', 'sold') THEN 'in_stock'
         WHEN stock_status = 'consignment_reserved' THEN 'consignment'
         ELSE stock_status END,
       updated_at = ? WHERE id = ?`,
    [taken, now, productId],
  );
  trackProductRow(productId);
}

/**
 * Nimmt ein zurückgegebenes Stück ERNEUT (Storno einer Retoure). Fehlt es inzwischen (wieder
 * verkauft), wird abgewiesen statt still bei 0 zu kappen.
 */
export function retakeLotLessStock(productId: string, qty: number, now: string): void {
  const rest = rawQuantity(productId) - qty;
  if (rest < -0.0005) throw new Error(STOCK_UNAVAILABLE_MESSAGE);
  getDatabase().run(
    `UPDATE products SET quantity = ?, stock_status = CASE WHEN ? > 0 THEN stock_status ELSE 'sold' END,
       updated_at = ? WHERE id = ?`,
    [Math.max(0, rest), rest, now, productId],
  );
  trackProductRow(productId);
}

/** Die Zeilen einer Rechnung mit ihrem Nachweis — für Storno/Löschen/Ändern. */
export function invoiceStockLines(invoiceId: string): Array<{ id: string; productId: string | null; lotId: string | null; qty: number; stockTaken: number | null }> {
  return query('SELECT id, product_id, lot_id, quantity, stock_taken FROM invoice_lines WHERE invoice_id = ?', [invoiceId])
    .map((r) => ({
      id: String(r.id),
      productId: (r.product_id as string | null) ?? null,
      lotId: (r.lot_id as string | null) ?? null,
      qty: Math.max(1, Number(r.quantity ?? 1) || 1),
      stockTaken: r.stock_taken === null || r.stock_taken === undefined ? null : Number(r.stock_taken),
    }));
}
