// ════════════════════════════════════════════════════════════════════════════
// Approval-Transfer — ein Stück lesbar für eine Meldung („item 2 (…): …").
//
// SKU, sonst der EINE Anzeigename des Hauses (`productDisplayName`: Marke + Modell, sonst die Merkmale,
// sonst der Kategoriename), sonst die Kennung. Nur Text für eine Meldung: kein Betrag, kein Status, keine
// Berechtigung hängt daran.
// ════════════════════════════════════════════════════════════════════════════
import { productDisplayName } from '../products/display-name.ts';

export interface TransferItemRow {
  sku?: unknown;
  brand?: unknown;
  name?: unknown;
  category_id?: unknown;
  attributes?: unknown;
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function transferItemLabel(row: TransferItemRow | null | undefined, productId: string): string {
  if (!row) return productId;
  const sku = (s(row.sku) ?? '').trim();
  if (sku) return sku;
  return productDisplayName({
    brand: s(row.brand), name: s(row.name), categoryId: s(row.category_id),
    attributes: typeof row.attributes === 'string' || (row.attributes && typeof row.attributes === 'object') ? row.attributes as string : null,
  }) || productId;
}
