// ════════════════════════════════════════════════════════════════════════════
// AI IDENTIFY — the merge contract for EDITING an existing product.
//
// This is a data-integrity module, not a convenience. Identify on an existing item is a FIELD
// RECOGNITION step: it reads a photo and tells us what the object is. It is not an import, not a
// valuation, and not a media operation — so what it may write is an explicit allow-list, and
// everything outside that list is dropped rather than trusted.
//
// ## What went wrong before
//
// The edit dialog merged the AI answer with a chain of inline `if`s, and two of them were wrong in
// a way that only shows up on real stock:
//
//   • `if (result.purchasePriceEstimate && !f.purchasePrice)` — `purchasePrice` is `0` for a large
//     part of real inventory (the mobile drain writes 0 for an unknown cost, and 0 is a valid
//     price). `!0` is true, so identifying a product silently overwrote its purchase price with a
//     model's guess. Same shape for sale, min and max price.
//   • the merge ran field-by-field on the live form, but nothing stopped a future key from being
//     added to the chain — the list of what AI may touch existed only as code shape.
//
// So prices are now excluded STRUCTURALLY (they are not in the allow-list at all, and a separate
// assertion in the tests names every price column), and the allow-list is data.
//
// ## Create vs edit
//
// Creating a product from a photo legitimately wants the model's price estimate — there is nothing
// to protect yet. Editing does not. `mode` makes that difference explicit instead of leaving two
// similar-looking call sites to drift apart.

import type { AiProductIdentification } from './ai-service.ts';

export type AiMergeMode = 'create' | 'edit';

/** The product form fields this module may write. Deliberately data, not control flow. */
export type MergeableFormField =
  | 'brand' | 'name' | 'sku' | 'condition' | 'notes' | 'storageLocation' | 'scopeOfDelivery' | 'taxScheme';

/**
 * Fields AI may NEVER write in EDIT mode, with the reason. Present so the intent is greppable and
 * so a test can assert the list rather than infer it from the absence of code.
 *
 * Prices are the headline, but the rest matter just as much: `quantity` is inventory truth, ids and
 * timestamps are system state, and `images` is the gallery — a recognition step has no business
 * touching any of them.
 */
export const AI_EDIT_FORBIDDEN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  purchasePrice: 'a real cost the operator entered — 0 is a legitimate value, so "empty" cannot be detected',
  plannedSalePrice: 'the price the business decided to sell at, not a model estimate',
  minSalePrice: 'a negotiation floor; a wrong one loses money silently',
  maxSalePrice: 'a business ceiling, not a recognition result',
  lastOfferPrice: 'the last price actually offered to a customer — a recorded event, not an estimate',
  lastSalePrice: 'the price this item last sold for — history, and never something to guess',
  purchaseCurrency: 'the accounting scope of every figure on the item; not a recognition result',
  expectedMargin: 'derived from the prices, so writing it would contradict them',
  quantity: 'inventory truth; recognition cannot count stock',
  images: 'the gallery is owned by the media pipeline, never by a text merge',
  id: 'the identity of the row being edited; nothing may repoint it',
  branchId: 'the branch that owns the item; moving stock is not an identify step',
  categoryId: 'changing it silently migrates every attribute',
  createdAt: 'audit history, written once when the row was created',
  updatedAt: 'audit history, owned by the save path',
  createdBy: 'audit history, owned by the save path',
  version: 'sync bookkeeping used to order changes between installs',
  syncStatus: 'sync bookkeeping; a text merge cannot know what has been pushed',
  stockStatus: 'lifecycle state driven by invoices and lots',
  daysInStock: 'derived from the purchase date, recomputed rather than stated',
  aiIdentifiedSnapshot: 'written by the identify bookkeeping, not by its own result',
});

/** Is a value something the model actually recognised? Empty/blank/NaN means "did not know". */
export function isRecognised(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export interface FormLike {
  brand?: string;
  name?: string;
  sku?: string;
  condition?: string;
  notes?: string;
  storageLocation?: string;
  scopeOfDelivery?: string[];
  /** Kept as the AI contract's own union so the patch stays assignable to the product form. */
  taxScheme?: AiProductIdentification['taxScheme'];
  [k: string]: unknown;
}

export interface AiEditMergeOptions {
  mode: AiMergeMode;
}

/**
 * The PATCH the AI answer may apply to the form. Never the whole form — the caller spreads this
 * onto the CURRENT state, so a user edit made while the request was in flight survives (§22).
 *
 * Rules, all of them "do no harm" by default:
 *   • a field the model did not recognise is absent from the patch → the existing value stays,
 *   • identity fields (brand/name) are replaced when recognised — that is what identifying is for,
 *   • `sku`, `condition`, `storageLocation`, `taxScheme`, `scopeOfDelivery` only FILL a gap; they are
 *     operator decisions once made,
 *   • `description` is appended to notes, never replacing what is there,
 *   • no price, no quantity, no media, no system field — in either mode for media/system, and in
 *     edit mode for prices.
 */
export function buildAiFormPatch(
  result: AiProductIdentification | null | undefined,
  form: FormLike,
  // Deliberately unused: prices were the last thing this merge did differently per dialog, and they
  // are gone from both. The parameter stays so every caller still has to say which dialog it is —
  // the day something IS mode-dependent again, the call sites already carry the answer.
  _opts: AiEditMergeOptions,
): Partial<FormLike> {
  const patch: Partial<FormLike> = {};
  if (!result) return patch;

  // ── recognised identity: what the model is FOR ──
  if (isRecognised(result.brand)) patch.brand = result.brand;
  if (isRecognised(result.name)) patch.name = result.name;

  // ── gap-fillers: only when the operator has not decided yet ──
  // SKU is deliberately NOT here. What the model returns for it is a reference or a model code —
  // `RLX-DJ36`, `116610LN` — and letting that reach the field means the AI is naming the product.
  // On an existing item that would rewrite a number the business already uses; on a new one it
  // would bypass the durable counter that both surfaces share. An item without a SKU gets one from
  // that counter when it is created, and one the operator typed is never touched.
  if (isRecognised(result.condition) && !isRecognised(form.condition)) patch.condition = result.condition;
  if (isRecognised(result.storageLocation) && !isRecognised(form.storageLocation)) patch.storageLocation = result.storageLocation;
  if (isRecognised(result.taxScheme) && !isRecognised(form.taxScheme)) patch.taxScheme = result.taxScheme;
  if (isRecognised(result.scopeOfDelivery) && !isRecognised(form.scopeOfDelivery)) {
    patch.scopeOfDelivery = result.scopeOfDelivery;
  }

  // ── description: ADDITIVE. An existing description is never replaced or emptied, which also means
  //    the newly-optional Accessories description cannot be blanked by an unsure answer (§24).
  if (isRecognised(result.description)) {
    const existing = typeof form.notes === 'string' ? form.notes : '';
    patch.notes = existing ? `${existing}\n\n${result.description}` : (result.description as string);
  }

  // ── prices are NOT here, in either mode ──
  // What a watch cost and what it will sell for is a commercial decision, and a model that has seen
  // a photograph is not the one to make it. Filling an empty field looks harmless until the figure
  // is saved, reported on and paid against — at which point nobody can say whether a person or a
  // guess put it there. The model may describe the piece; the price stays with the operator.

  return patch;
}

/**
 * The attributes patch: only keys the CURRENT category actually declares, and only values the model
 * recognised. A blank answer never deletes a stored attribute, and a key the category does not know
 * is dropped rather than written (it would be a stale field the mobile v2 gate then rejects).
 */
export function buildAiAttributePatch(
  result: AiProductIdentification | null | undefined,
  knownKeys: readonly string[],
): Record<string, string | number | boolean | string[]> {
  const patch: Record<string, string | number | boolean | string[]> = {};
  const known = new Set(knownKeys);
  for (const [k, v] of Object.entries(result?.attributes ?? {})) {
    if (!known.has(k)) continue;
    if (!isRecognised(v)) continue;
    patch[k] = v;
  }
  return patch;
}

/** Guard used by the tests and by anyone extending the merge: is this field one AI may never set? */
export function isAiForbiddenEditField(field: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_EDIT_FORBIDDEN_FIELDS, field);
}
