// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT D13 / D7 — was die Artikelbearbeitung an einem Artikel NICHT mehr frei tut.
//
// D13: Einkaufspreis und -datum eines Artikels, den ein Einkauf ANGELEGT hat (`purchase_lines.created_product
//      = 1`, der Einkauf nicht storniert), gehören diesem Einkauf. Sie werden über „Purchase → Edit" korrigiert —
//      dort folgen Los, Lager, Hauptbuch und Collection zusammen. In der Collection bleiben sie gesperrt.
//      Ein Artikel unklarer oder unabhängiger Herkunft (Altbestand, Collection, Handy, Zeile von vor diesem
//      Vertrag) wird NICHT gesperrt und nicht umgedeutet.
// D7:  Merkmale eines schon verkauften Artikels (auf einer nicht stornierten Rechnung) ändern sich nur mit
//      Pflicht-Begründung. Die Rechnung selbst bleibt, was sie war: ihre Druckangaben friert der Koordinator
//      vorher in der Zeile ein (`invoice_lines.product_snapshot`).
//
// Nur lesend, aus der Datenbank. Geprüft im Haus (`editProductTextDurably` / `editProductWithMedia`), also
// für Primary, PC2 und Handy gleich.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';

export const PRODUCT_PURCHASE_BOUND = 'PRODUCT_PURCHASE_BOUND';
export const PRODUCT_EDIT_REASON_REQUIRED = 'PRODUCT_EDIT_REASON_REQUIRED';

/** Die Spalten, die eine Rechnung über den Artikel druckt — dieselben, die der Koordinator einfriert. */
export const PRODUCT_PRINT_COLUMNS: readonly string[] = ['brand', 'name', 'sku', 'category_id', 'condition', 'attributes'];
const PURCHASE_COLUMNS: readonly string[] = ['purchase_price', 'purchase_date'];

const hasColumn = (table: string, col: string): boolean => {
  try { return query(`PRAGMA table_info(${table})`).some((r) => r.name === col); } catch { return false; }
};

/** Der Einkauf, der diesen Artikel angelegt hat (und dem deshalb Einkaufspreis und -datum gehören) — oder null. */
export function purchaseBoundOf(productId: string): { purchaseId: string; purchaseNumber: string } | null {
  if (!productId || !hasColumn('purchase_lines', 'created_product')) return null;
  const r = query(
    `SELECT p.id, p.purchase_number FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
      WHERE pl.product_id = ? AND pl.created_product = 1 AND p.status != 'CANCELLED'
      ORDER BY p.created_at ASC, p.id ASC LIMIT 1`,
    [productId],
  )[0];
  return r ? { purchaseId: String(r.id), purchaseNumber: String(r.purchase_number ?? '') } : null;
}

/** D13 — ändert diese Bearbeitung Einkaufspreis oder -datum eines einkaufsgebundenen Artikels? Dann das Nein. */
export function purchaseBoundRefusal(productId: string, set: ReadonlyArray<readonly [string, unknown]>): { code: string; message: string } | null {
  if (!set.some(([c]) => PURCHASE_COLUMNS.includes(c))) return null;
  const bound = purchaseBoundOf(productId);
  if (!bound) return null;
  return {
    code: PRODUCT_PURCHASE_BOUND,
    message: `The purchase price and date of this item belong to purchase ${bound.purchaseNumber}. Correct them there (Purchase → Edit) so stock and accounting follow. Nothing was changed.`,
  };
}

/** Steht der Artikel auf einer nicht stornierten Rechnung? */
export function productOnInvoice(productId: string): boolean {
  if (!productId) return false;
  return query(
    `SELECT 1 FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.product_id = ? AND i.status != 'CANCELLED' LIMIT 1`,
    [productId],
  ).length > 0;
}

/** D7 — braucht diese Bearbeitung eine Begründung (Druckangaben eines verkauften Artikels)? */
export function soldItemEditNeedsReason(productId: string, set: ReadonlyArray<readonly [string, unknown]>): boolean {
  return set.some(([c]) => PRODUCT_PRINT_COLUMNS.includes(c)) && productOnInvoice(productId);
}
