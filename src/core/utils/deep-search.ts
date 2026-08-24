// ═══════════════════════════════════════════════════════════
// Deep-Search Helper
// Matches a query against every string/number value in an object
// (including nested objects and arrays). Used for "find XXL
// anywhere in a product" style searches.
// ═══════════════════════════════════════════════════════════

import {
  isProductLike, productBusinessSearchText, isCategoryLike, categorySearchText,
} from './product-format.ts';

// Produkte und Kategorien werden NICHT Feld fuer Feld durchsucht, sondern ueber ihre
// fachliche Projektion (`product-format.ts`). Grund: an einem Produkt haengen KI- und
// Maschinendaten (Bildbeschreibung, Embedding, Hashes), die als Text verglichen fachlich
// falsche Treffer erzeugen — "126" traf so den gesamten Bestand. Die Ausschlussliste
// unten bleibt fuer alle UEBRIGEN Objekte (Rechnung, Angebot, Auftrag, Reparatur,
// Kommission, Kunde …): deren eigene fachliche Felder bleiben unveraendert durchsuchbar.
const SKIP_KEYS = new Set([
  'id', 'createdAt', 'updatedAt', 'createdBy', 'branchId', 'tenantId',
  'images', 'customerId', 'productId', 'offerId', 'invoiceId',
  'agentId', 'consignorId', 'buyerId', 'categoryId', 'repairId',
  'orderId', 'supplierPrice', // keep free-text supplier_name, not price
  'password_hash',
]);

function valueContains(value: unknown, q: string): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.toLowerCase().includes(q);
  if (typeof value === 'number') return String(value).includes(q);
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.some(v => valueContains(v, q));
  if (typeof value === 'object') {
    // Ein Produkt — ob als durchsuchtes Objekt selbst oder eingebettet in einen Beleg —
    // wird ausschliesslich ueber seine fachlichen Felder gesucht.
    if (isProductLike(value)) return productBusinessSearchText(value).includes(q);
    if (isCategoryLike(value)) return categorySearchText(value).includes(q);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SKIP_KEYS.has(k)) continue;
      if (valueContains(v, q)) return true;
    }
  }
  return false;
}

export function matchesDeep(obj: unknown, rawQuery: string, extras?: unknown[]): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  if (valueContains(obj, q)) return true;
  if (extras) {
    for (const e of extras) if (valueContains(e, q)) return true;
  }
  return false;
}
