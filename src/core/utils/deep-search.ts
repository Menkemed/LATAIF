// ═══════════════════════════════════════════════════════════
// Deep-Search Helper
// Matches a query against every string/number value in an object
// (including nested objects and arrays). Used for "find XXL
// anywhere in a product" style searches.
// ═══════════════════════════════════════════════════════════

import type { Category } from '@/core/models/types';
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

function valueContains(value: unknown, q: string, category?: Category): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.toLowerCase().includes(q);
  if (typeof value === 'number') return String(value).includes(q);
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.some(v => valueContains(v, q, category));
  if (typeof value === 'object') {
    // Ein Produkt — ob als durchsuchtes Objekt selbst oder eingebettet in einen Beleg —
    // wird ausschliesslich ueber seine fachlichen Felder gesucht. Die Kategorie wird nur
    // durchgereicht, wenn sie WIRKLICH die dieses Artikels ist; sie entscheidet dann, welche
    // Attributschluessel fachlich sind.
    if (isProductLike(value)) {
      const own = category && category.id === value.categoryId ? category : undefined;
      return productBusinessSearchText(value, own).includes(q);
    }
    if (isCategoryLike(value)) return categorySearchText(value).includes(q);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SKIP_KEYS.has(k)) continue;
      if (valueContains(v, q, category)) return true;
    }
  }
  return false;
}

export function matchesDeep(obj: unknown, rawQuery: string, extras?: unknown[]): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  // Gibt der Aufrufer die Kategorie mit (die Collection tut das), entscheidet sie, welche
  // Attributschluessel des Artikels fachlich sind. Ohne sie bleibt es bei der Formgrenze.
  const category = extras?.find(isCategoryLike);
  if (valueContains(obj, q, category)) return true;
  if (extras) {
    for (const e of extras) if (valueContains(e, q, category)) return true;
  }
  return false;
}
