// ═══════════════════════════════════════════════════════════
// Deep-Search Helper
// Matches a query against every string/number value in an object
// (including nested objects and arrays). Used for "find XXL
// anywhere in a product" style searches.
// ═══════════════════════════════════════════════════════════

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
