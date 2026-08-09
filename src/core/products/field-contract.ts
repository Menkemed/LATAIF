// ════════════════════════════════════════════════════════════════════════════
// PRODUCT FIELD CONTRACT — the ONE place that answers, for every surface:
//
//   • which category attributes are VISIBLE for the current values (dependsOn)
//   • which of them are REQUIRED
//   • which universal fields (brand/name) are required for a category
//   • what a save must STRIP because a dependency is no longer satisfied
//   • which findings BLOCK a save and which are merely informational
//
// Why this module exists: the three surfaces had drifted. Desktop *create*
// (NewProductModal) honoured `dependsOn`; desktop *edit* (ProductDetail) did
// not — so editing a Steel watch demanded a "Karat & Color" that the contract
// says must not even be visible, and the value was then persisted. The mobile
// v2 server contract rejects exactly that combination as STALE_FIELD, so the
// two halves of the product disagreed about the same product. On top of that,
// ProductDetail demanded `purchasePrice > 0` — a rule that exists nowhere else
// (the column is a plain REAL, the create dialog never checks it, the mobile
// drain writes 0 for an unknown cost, and real stock legitimately carries 0).
//
// Everything here is DERIVED from the category SSOT (`default-categories.ts`).
// No second required-list, no second dependsOn table, no invented rule.
// ════════════════════════════════════════════════════════════════════════════

import type { Category, CategoryAttribute } from '../models/types.ts';
// The brand/name rule already has exactly one implementation (mirrored into the
// mobile schema); it is re-exported here so every surface reads it from one place.
import { isBrandRequired } from '../mobile/mobile-field-schema.ts';

export { isBrandRequired };

export type AttrValues = Record<string, unknown>;

/** A single validation finding. `blocking` decides whether a save may proceed. */
export interface FieldIssue {
  /** `brand` | `name` | `categoryId` | an attribute key. */
  field: string;
  /** Human label for the UI. */
  label: string;
  code: 'REQUIRED' | 'UNKNOWN_CATEGORY';
  blocking: boolean;
}

/** True when the attribute's `dependsOn` condition is satisfied by `attrs`
 *  (or when it has no dependency at all). */
export function isAttributeVisible(attr: CategoryAttribute, attrs: AttrValues | undefined): boolean {
  if (!attr.dependsOn) return true;
  const dep = (attrs || {})[attr.dependsOn.key];
  return dep !== undefined && dep !== null && attr.dependsOn.valueIncludes.includes(String(dep));
}

/** The attributes a surface must render for the CURRENT values — in SSOT order. */
export function visibleAttributes(category: Pick<Category, 'attributes'> | null | undefined, attrs: AttrValues | undefined): CategoryAttribute[] {
  return (category?.attributes ?? []).filter((a) => isAttributeVisible(a, attrs));
}

/** The attribute keys that are required RIGHT NOW: required in the SSOT *and*
 *  currently visible. A hidden attribute is never required. */
export function requiredAttributeKeys(category: Pick<Category, 'attributes'> | null | undefined, attrs: AttrValues | undefined): string[] {
  return visibleAttributes(category, attrs).filter((a) => a.required).map((a) => a.key);
}

/** Is a value present for validation purposes? (`0` and `false` are present.) */
export function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return !Number.isNaN(v);
  return true;
}

/**
 * Remove ONLY the values that the contract itself contradicts — nothing else.
 *
 * A key is dropped if and only if ALL of these hold:
 *   A. the key is a KNOWN attribute of the current category,
 *   B. that attribute declares a `dependsOn` rule, and
 *   C. the rule is NOT satisfied by the current parent values.
 *
 * That is exactly the live defect this addresses: switching a watch from
 * "Solid Gold" back to "Steel" must not leave a `karat_color` behind (the
 * `material=Steel` + `karat_color=9K Rose` row the mobile v2 gate rejects).
 *
 * Everything else is preserved verbatim — active, optional and required
 * attributes, and above all keys this build does not know: real stock still
 * carries attributes that were removed from the model long ago (e.g. a watch's
 * `movement`, an accessory's `box`/`papers`). A save is not a migration, so an
 * ordinary price edit must never silently destroy them. An allow-list rewrite
 * of the whole attributes object would do exactly that, which is why this
 * function subtracts instead of rebuilding, and why no historical key is named
 * anywhere in product code (they live only in regression fixtures).
 *
 * Pure: the input object is never mutated.
 */
export function stripStaleAttributes(category: Pick<Category, 'attributes'> | null | undefined, attrs: AttrValues | undefined): AttrValues {
  const out: AttrValues = { ...(attrs || {}) };
  for (const attr of category?.attributes ?? []) {
    if (!attr.dependsOn) continue;              // (B) only dependent attributes can go stale
    if (!(attr.key in out)) continue;           // (A) nothing stored for it
    if (isAttributeVisible(attr, out)) continue; // (C) dependency satisfied → keep
    delete out[attr.key];
  }
  return out;
}

export interface ProductFormLike {
  categoryId?: string;
  brand?: string;
  name?: string;
  attributes?: AttrValues;
}

/**
 * The single validation used by desktop create AND desktop edit.
 *
 * Blocking findings are exactly the SSOT's requiredness: a known category,
 * brand+name where the category demands them, and every VISIBLE required
 * attribute. Nothing else blocks — in particular there is no price rule: the
 * schema stores `purchase_price` as a plain REAL, the create dialog has never
 * validated it, the mobile drain writes 0 for an unknown cost, and real stock
 * carries 0. Inventing `> 0` here is what made the edit dialog show an error
 * for a save that then succeeded anyway.
 */
export function validateProductFields(category: Category | null | undefined, form: ProductFormLike): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (!form.categoryId || !category) {
    return [{ field: 'categoryId', label: 'Category', code: 'UNKNOWN_CATEGORY', blocking: true }];
  }
  if (isBrandRequired(category.id)) {
    if (!hasValue(form.brand)) issues.push({ field: 'brand', label: 'Brand', code: 'REQUIRED', blocking: true });
    if (!hasValue(form.name)) issues.push({ field: 'name', label: 'Name', code: 'REQUIRED', blocking: true });
  }
  const attrs = form.attributes || {};
  for (const attr of visibleAttributes(category, attrs)) {
    if (!attr.required) continue;
    if (!hasValue(attrs[attr.key])) {
      issues.push({ field: attr.key, label: attr.label, code: 'REQUIRED', blocking: true });
    }
  }
  return issues;
}

/** Only the findings that must stop a save. */
export function blockingIssues(issues: FieldIssue[]): FieldIssue[] {
  return issues.filter((i) => i.blocking);
}

/** Convenience for the UIs: `{ [field]: message }`, blocking findings only. */
export function issueMap(issues: FieldIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of blockingIssues(issues)) out[i.field] = 'Required';
  return out;
}
