// ════════════════════════════════════════════════════════════════════════════
// MOBILE-FIELDS — shared product-field SSOT for the mobile uploader.
//
// The DESKTOP product-field model lives in `src/core/models/default-categories.ts` (categories →
// `CategoryAttribute[]`). Mobile MUST NOT invent a separate field model, so this module derives a compact,
// serialisable field schema from that exact SSOT. The same schema drives:
//   • the Rust-served /mobile page (rendered from a generated JSON — see test/mobile-fields/gen-schema.mjs),
//   • the Rust server-side validation (mobile_field_schema.rs parses the same JSON),
//   • the desktop drain (attribute allow-listing here).
// A drift test (test/mobile-fields/field-schema.test.ts) asserts the committed JSON equals this builder's
// output, so the three consumers can never diverge from the desktop SSOT.
//
// NOTE: relative imports (not the `@/` alias) so this module is importable by plain `node --strip-types`
// in the generator + tests without a bundler.
// ════════════════════════════════════════════════════════════════════════════
import { DEFAULT_CATEGORIES } from '../models/default-categories.ts';
import type { Category, CategoryAttribute, AttributeType } from '../models/types.ts';

export const SCHEMA_VERSION = 1;

// String length caps (server + client). Universal identity fields + free text.
export const MAX = { brand: 120, name: 160, sku: 80, text: 2000, condition: 60, scopeItem: 60 } as const;

// The ONLY metadata keys a mobile client may send. Everything else (tenant/branch/id/storage/state/audit/
// timestamps/stockStatus/taxScheme/margin/VAT/…) is rejected server-side — an allow-list is inherently
// mass-assignment safe (no field outside this set can reach the product).
export const ALLOWED_TOP_KEYS = ['categoryId', 'brand', 'name', 'sku', 'condition', 'scopeOfDelivery', 'attributes'] as const;

// MOBILE-PRICING — the three canonical PRODUCT prices (top-level, all categories). Added to the transport
// surface ONLY under protocol_version 2; v1's key surface is unchanged. These are the exact desktop
// properties (Product.purchasePrice / .plannedSalePrice / .minSalePrice) — labels ("Sale Price", "Minimum
// Sale Price") are UI only. Cost-accounting/margin/VAT/derived fields are deliberately NOT here.
export const ALLOWED_PRICING_KEYS = ['purchasePrice', 'plannedSalePrice', 'minSalePrice'] as const;
// NO business ceiling on a price. The desktop SSOT (products.purchase_price/planned_sale_price/
// min_sale_price are plain REAL columns) and the create/edit UIs enforce no upper bound, so mobile must
// not invent one — a mobile-only limit would be a second, diverging business rule. Only the technically
// necessary validity gate applies: a finite, non-negative JSON number (a non-finite value cannot be
// stored, and a negative price is not a price).

// MOBILE-QUANTITY — `quantity` is the EXISTING canonical product column (`products.quantity INTEGER
// DEFAULT 1`), not a mobile invention. Like pricing it joins the transport surface only under
// protocol v2, so the v1 key surface is unchanged and an older payload without it still validates.
export const ALLOWED_QUANTITY_KEYS = ['quantity'] as const;
// The desktop create dialog clamps with `Math.max(1, …)` and declares no upper bound, so mobile
// enforces exactly that and no more: a whole number of at least one. The only ceiling is technical —
// a value SQLite/JS cannot represent exactly is not a count. Inventing a small business limit here
// would be a second rule the desktop does not have.
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;

/** Is this a usable piece count? Whole, ≥1, exactly representable. Shared by every layer. */
export function isValidQuantity(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
    && v >= MIN_QUANTITY && v <= MAX_QUANTITY;
}

export interface MobileFieldAttr {
  key: string;
  label: string;
  type: AttributeType; // 'text' | 'number' | 'select' | 'multiselect' | 'boolean'
  options?: string[];
  required: boolean;
  unit?: string;
  dependsOn?: { key: string; valueIncludes: string[] };
}
export interface MobileFieldCategory {
  id: string;
  name: string;
  brandRequired: boolean;
  conditionOptions: string[];
  scopeOptions: string[];
  attributes: MobileFieldAttr[];
}
export interface MobileFieldSchema {
  version: number;
  categories: MobileFieldCategory[];
}

// Desktop rule (NewProductModal `brandedRequired`): brand+name required except Gold-Diamond + Accessory.
export function isBrandRequired(categoryId: string): boolean {
  return !(categoryId === 'cat-gold-jewelry' || categoryId === 'cat-accessory');
}

/** Derive the mobile field schema from the desktop category SSOT. Deterministic; no runtime state. */
export function buildMobileFieldSchema(categories: readonly Omit<Category, 'createdAt'>[] = DEFAULT_CATEGORIES): MobileFieldSchema {
  return {
    version: SCHEMA_VERSION,
    categories: categories
      .filter((c) => c.active !== false)
      .map((c) => ({
        id: c.id,
        name: c.name,
        brandRequired: isBrandRequired(c.id),
        conditionOptions: [...(c.conditionOptions || [])],
        scopeOptions: [...(c.scopeOptions || [])],
        attributes: (c.attributes || []).map((a: CategoryAttribute) => ({
          key: a.key,
          label: a.label,
          type: a.type,
          ...(a.options ? { options: [...a.options] } : {}),
          required: !!a.required,
          ...(a.unit ? { unit: a.unit } : {}),
          ...(a.dependsOn ? { dependsOn: { key: a.dependsOn.key, valueIncludes: [...a.dependsOn.valueIncludes] } } : {}),
        })),
      })),
  };
}

export type MobileAttrValue = string | number | boolean | string[];
export interface MobileMetadata {
  categoryId: string;
  brand?: string;
  name?: string;
  sku?: string | null;
  condition?: string;
  scopeOfDelivery?: string[];
  attributes?: Record<string, MobileAttrValue>;
}

export interface FieldValidationError { code: string; field?: string; message: string; }

/**
 * Validate a mobile metadata object against the schema. VALIDITY (types/enums/ranges/caps/allow-list) is
 * enforced always — this is the security gate shape mirrored server-side. REQUIRED-ness is enforced only when
 * `enforceRequired` is true (the mobile client does this for UX); the transport/drain stays lenient so old
 * minimal payloads (brand/name/sku only) remain valid. Returns [] when acceptable.
 */
export function validateMobileMetadata(
  meta: unknown,
  schema: MobileFieldSchema,
  opts: { enforceRequired?: boolean; protocolVersion?: number } = {},
): FieldValidationError[] {
  const errs: FieldValidationError[] = [];
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) {
    return [{ code: 'META_NOT_OBJECT', message: 'metadata must be an object' }];
  }
  const m = meta as Record<string, unknown>;
  // MOBILE-PRICING — pricing keys are part of the transport surface ONLY for v2. Under v1 they are
  // rejected like any other unknown field, so the legacy contract is unchanged.
  const pricingAllowed = (opts.protocolVersion ?? 1) >= 2;
  const allowedTop = pricingAllowed
    ? [...ALLOWED_TOP_KEYS, ...ALLOWED_PRICING_KEYS, ...ALLOWED_QUANTITY_KEYS]
    : ALLOWED_TOP_KEYS;
  for (const k of Object.keys(m)) {
    if (!(allowedTop as readonly string[]).includes(k)) {
      errs.push({ code: 'UNKNOWN_FIELD', field: k, message: `field "${k}" is not allowed` });
    }
  }
  if (pricingAllowed) {
    for (const key of ALLOWED_PRICING_KEYS) {
      const v = m[key];
      if (v === undefined || v === null) continue; // optional
      if (typeof v !== 'number' || !Number.isFinite(v)) { errs.push({ code: 'BAD_NUMBER', field: key, message: `${key} must be a finite number` }); continue; }
      if (v < 0) errs.push({ code: 'BAD_NUMBER', field: key, message: `${key} must not be negative` });
    }
    // MOBILE-QUANTITY — optional; absent means the desktop default of 1 (a payload written before
    // this field existed must keep working). Present means a whole count of at least one: 0, a
    // negative, a fraction and any non-number are all refused, and nothing is silently rounded.
    const q = m.quantity;
    if (q !== undefined && q !== null && !isValidQuantity(q)) {
      errs.push({ code: 'BAD_NUMBER', field: 'quantity', message: 'quantity must be a whole number of at least 1' });
    }
  }
  const cat = schema.categories.find((c) => c.id === m.categoryId);
  if (typeof m.categoryId !== 'string' || !cat) {
    errs.push({ code: 'UNKNOWN_CATEGORY', field: 'categoryId', message: `unknown category "${String(m.categoryId)}"` });
    return errs; // cannot validate fields without a known category
  }
  const cap = (v: unknown, n: number, field: string) => {
    if (typeof v === 'string' && v.length > n) errs.push({ code: 'TOO_LONG', field, message: `${field} exceeds ${n} chars` });
  };
  if (m.brand !== undefined && typeof m.brand !== 'string') errs.push({ code: 'BAD_TYPE', field: 'brand', message: 'brand must be a string' });
  if (m.name !== undefined && typeof m.name !== 'string') errs.push({ code: 'BAD_TYPE', field: 'name', message: 'name must be a string' });
  if (m.sku !== undefined && m.sku !== null && typeof m.sku !== 'string') errs.push({ code: 'BAD_TYPE', field: 'sku', message: 'sku must be a string' });
  cap(m.brand, MAX.brand, 'brand'); cap(m.name, MAX.name, 'name'); cap(m.sku, MAX.sku, 'sku');

  if (m.condition !== undefined && m.condition !== '' && m.condition !== null) {
    if (typeof m.condition !== 'string' || !cat.conditionOptions.includes(m.condition)) {
      errs.push({ code: 'BAD_ENUM', field: 'condition', message: `invalid condition "${String(m.condition)}"` });
    }
  }
  if (m.scopeOfDelivery !== undefined && m.scopeOfDelivery !== null) {
    if (!Array.isArray(m.scopeOfDelivery)) errs.push({ code: 'BAD_TYPE', field: 'scopeOfDelivery', message: 'scopeOfDelivery must be an array' });
    else for (const s of m.scopeOfDelivery) {
      if (typeof s !== 'string' || !cat.scopeOptions.includes(s)) errs.push({ code: 'BAD_ENUM', field: 'scopeOfDelivery', message: `invalid scope "${String(s)}"` });
    }
  }

  const attrs = m.attributes;
  if (attrs !== undefined && attrs !== null) {
    if (typeof attrs !== 'object' || Array.isArray(attrs)) {
      errs.push({ code: 'BAD_TYPE', field: 'attributes', message: 'attributes must be an object' });
    } else {
      const a = attrs as Record<string, unknown>;
      const byKey = new Map(cat.attributes.map((x) => [x.key, x]));
      for (const key of Object.keys(a)) {
        const def = byKey.get(key);
        if (!def) { errs.push({ code: 'UNKNOWN_FIELD', field: key, message: `attribute "${key}" not valid for ${cat.id}` }); continue; }
        const v = a[key];
        if (v === undefined || v === null || v === '') continue; // empty optional
        validateAttrValue(def, v, errs);
      }
      if (opts.enforceRequired) {
        // v2: required + dependsOn, computed independently of the client. A stale/hidden dependsOn field
        // (present when its condition is unmet) is rejected fail-closed. Mirrors mobile_field_schema.rs.
        for (const def of cat.attributes) {
          const v = a[def.key];
          const present = !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));
          if (def.dependsOn) {
            const dep = a[def.dependsOn.key];
            const satisfied = typeof dep === 'string' && def.dependsOn.valueIncludes.includes(dep);
            if (!satisfied) { if (present) errs.push({ code: 'STALE_FIELD', field: def.key, message: `${def.label} is not valid unless ${def.dependsOn.key} matches` }); continue; }
            if (def.required && !present) errs.push({ code: 'REQUIRED', field: def.key, message: `${def.label} is required` });
          } else if (def.required && !present) {
            errs.push({ code: 'REQUIRED', field: def.key, message: `${def.label} is required` });
          }
        }
      }
    }
  } else if (opts.enforceRequired) {
    for (const def of cat.attributes) {
      if (def.required && !def.dependsOn) errs.push({ code: 'REQUIRED', field: def.key, message: `${def.label} is required` });
    }
  }
  if (opts.enforceRequired && cat.brandRequired) {
    if (!(typeof m.brand === 'string' && m.brand.trim())) errs.push({ code: 'REQUIRED', field: 'brand', message: 'Brand is required' });
    if (!(typeof m.name === 'string' && m.name.trim())) errs.push({ code: 'REQUIRED', field: 'name', message: 'Name is required' });
  }
  return errs;
}

function validateAttrValue(def: MobileFieldAttr, v: unknown, errs: FieldValidationError[]) {
  switch (def.type) {
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) { errs.push({ code: 'BAD_NUMBER', field: def.key, message: `${def.label} must be a finite number` }); return; }
      if (v < 0) errs.push({ code: 'BAD_NUMBER', field: def.key, message: `${def.label} must not be negative` });
      break;
    }
    case 'select': {
      if (typeof v !== 'string' || !(def.options || []).includes(v)) errs.push({ code: 'BAD_ENUM', field: def.key, message: `invalid ${def.label} "${String(v)}"` });
      break;
    }
    case 'multiselect': {
      if (!Array.isArray(v)) { errs.push({ code: 'BAD_TYPE', field: def.key, message: `${def.label} must be an array` }); return; }
      for (const s of v) if (typeof s !== 'string' || !(def.options || []).includes(s)) errs.push({ code: 'BAD_ENUM', field: def.key, message: `invalid ${def.label} "${String(s)}"` });
      break;
    }
    case 'boolean': {
      if (typeof v !== 'boolean') errs.push({ code: 'BAD_TYPE', field: def.key, message: `${def.label} must be true/false` });
      break;
    }
    default: { // text
      if (typeof v !== 'string') { errs.push({ code: 'BAD_TYPE', field: def.key, message: `${def.label} must be text` }); return; }
      if (v.length > MAX.text) errs.push({ code: 'TOO_LONG', field: def.key, message: `${def.label} exceeds ${MAX.text} chars` });
    }
  }
}

/**
 * Drop any attribute key not defined for the category (defense-in-depth on the drain, in case the server gate
 * is ever bypassed). Returns a new object with only schema-valid keys retained.
 */
export function filterAttributesToSchema(categoryId: string, attributes: Record<string, MobileAttrValue> | undefined, schema: MobileFieldSchema): Record<string, MobileAttrValue> {
  if (!attributes || typeof attributes !== 'object') return {};
  const cat = schema.categories.find((c) => c.id === categoryId);
  if (!cat) return {};
  const allowed = new Set(cat.attributes.map((a) => a.key));
  const out: Record<string, MobileAttrValue> = {};
  for (const [k, v] of Object.entries(attributes)) if (allowed.has(k)) out[k] = v;
  return out;
}
