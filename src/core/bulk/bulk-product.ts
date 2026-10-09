// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — der Systemartikel je Metall + Feinheit + Filiale (Spec Kapitel 3).
//
// Er trägt keinen SKU, keine Stückmenge, ist nie direkt verkäuflich und über die normalen Produkt-
// und Kategoriepfade nicht bearbeitbar. Kennung wie beim Reparatur-Service: Id-Präfix `bulk-` für die
// Bestands- und Buchungsschicht, Kategorie-Präfix `cat-bulk-metal` für Listen und Auswahlen.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackChange } from '@/core/sync/sync-service';
import { metalPurity, METAL_GRADES } from '@/core/gold/purity';
import { BulkRejected } from './bulk-math';

export const BULK_PRODUCT_PREFIX = 'bulk-';
export const BULK_CATEGORY_PREFIX = 'cat-bulk-metal';
export const BULK_METALS = ['gold', 'silver', 'platinum'] as const;
export type BulkMetal = typeof BULK_METALS[number];

export const isBulkMetalProduct = (id: string | null | undefined): boolean => String(id ?? '').startsWith(BULK_PRODUCT_PREFIX);
export const isBulkCategory = (id: string | null | undefined): boolean => String(id ?? '').startsWith(BULK_CATEGORY_PREFIX);

/** SQL-Bedingung „kein Bulk-Systemartikel" für eine Produkt-Id-Spalte. */
export const sqlNotBulkProduct = (col = 'id'): string => `${col} NOT LIKE 'bulk-%'`;
/** SQL-Bedingung „keine Bulk-Kategorie" für eine Kategorie-Spalte. */
export const sqlNotBulkCategory = (col = 'category_id'): string => `COALESCE(${col}, '') NOT LIKE 'cat-bulk-metal%'`;

export const METAL_LABEL: Record<BulkMetal, string> = { gold: 'Gold', silver: 'Silver', platinum: 'Platinum' };

export function assertBulkMetal(metal: unknown, fineness: unknown): { metal: BulkMetal; fineness: string } {
  if (typeof metal !== 'string' || !(BULK_METALS as readonly string[]).includes(metal)
    || typeof fineness !== 'string' || metalPurity(metal, fineness) === null
    || !(METAL_GRADES[metal as BulkMetal] as readonly string[]).includes(fineness)) {
    throw new BulkRejected('BULK_METAL_INVALID', `${String(metal)} ${String(fineness)} is not a known metal and fineness`);
  }
  return { metal: metal as BulkMetal, fineness };
}

export const bulkCategoryId = (branchId: string): string => `${BULK_CATEGORY_PREFIX}-${branchId}`;
export const bulkProductId = (metal: BulkMetal, fineness: string, branchId: string): string =>
  `${BULK_PRODUCT_PREFIX}${metal}-${fineness.toLowerCase()}-${branchId}`;
export const bulkProductName = (metal: BulkMetal, fineness: string): string => `${METAL_LABEL[metal]} ${fineness} – Bulk`;

/** Systemartikel und Kategorie anlegen, falls noch nicht da — in der Transaktion des Aufrufers. */
export function ensureBulkProduct(branchId: string, metal: BulkMetal, fineness: string, userId: string, now: string): string {
  const db = getDatabase();
  const catId = bulkCategoryId(branchId);
  if (!query('SELECT id FROM categories WHERE id = ?', [catId])[0]) {
    db.run(
      `INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at)
       VALUES (?, ?, 'Bulk Metal (system)', 'Package', '#8C8C8C', '[]', '[]', '[]', 0, 999, ?, ?)`,
      [catId, branchId, now, now],
    );
  }
  const id = bulkProductId(metal, fineness, branchId);
  if (!query('SELECT id FROM products WHERE id = ?', [id])[0]) {
    db.run(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery,
        purchase_date, purchase_price, purchase_currency, stock_status, tax_scheme, expected_margin, days_in_stock,
        supplier_name, notes, images, attributes, source_type, created_at, updated_at, created_by)
       VALUES (?, ?, ?, '', ?, NULL, 0, '', '[]', NULL, 0, 'BHD', 'in_stock', 'MARGIN', NULL, 0,
               NULL, 'System item for bulk metal by weight — managed in Bulk Metals.', '[]', ?, 'OWN', ?, ?, ?)`,
      [id, branchId, catId, bulkProductName(metal, fineness), JSON.stringify({ metal, fineness }), now, now, userId || null],
    );
    trackChange('products', id, 'insert', {});
  }
  return id;
}

/** Harte Sperre der normalen Bearbeitungs- und Löschpfade (3.2). */
export function assertNotBulkSystemProduct(productId: string | null | undefined): void {
  if (isBulkMetalProduct(productId)) {
    throw new BulkRejected('BULK_SYSTEM_PRODUCT_LOCKED', 'this is a bulk metal system item — it is managed in Bulk Metals only');
  }
}
export function assertNotBulkCategory(categoryId: string | null | undefined): void {
  if (isBulkCategory(categoryId)) {
    throw new BulkRejected('BULK_SYSTEM_PRODUCT_LOCKED', 'the bulk metal system category cannot be changed');
  }
}
