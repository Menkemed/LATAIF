// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1B §1 — the SHARED AI-identify contract, TypeScript side.
//
// The prompt, the per-category field rules and the allow/deny lists live in ONE file:
// `identify-contract.json`. This module assembles a prompt from it; `src-tauri/src/sync/ai_identify.rs`
// assembles the same prompt from the same file for the mobile route. Neither side owns a copy.
//
// The contract was generated from the shipped v0.8.37 prompt character for character, so extracting
// it changed no desktop behaviour — and a golden-hash gate on both sides fails the build if the two
// assemblies ever diverge. That gate is the whole point: two AI code paths are acceptable only for
// as long as they are provably one contract.
//
// Nothing here calls a model or reads a key. It is pure text assembly, which is what makes it
// testable on both sides without a network.
// ════════════════════════════════════════════════════════════════════════════

import contract from './identify-contract.json' with { type: 'json' };

export type AiIdentifyCategoryId = keyof typeof contract.categories;

export interface CategorySpec {
  name: string;
  required: string[];
  optional: string[];
  conditionOptions: string[];
  scopeOptions: string[];
  notes: string;
}

export const AI_CONTRACT_VERSION: number = contract.contractVersion;
export const AI_MODEL_PARAMS = contract.model;

/** The fields the MOBILE surface may adopt from an identification. Everything else is dropped. */
export const MOBILE_ALLOWED_FIELDS: readonly string[] = contract.mobileAllowedFields;
/** Named explicitly so the refusal is greppable and testable, not merely implied by absence. */
export const MOBILE_FORBIDDEN_FIELDS: readonly string[] = contract.mobileForbiddenFields;

export function categorySpec(categoryId: string): CategorySpec | null {
  const specs = contract.categories as Record<string, CategorySpec>;
  return specs[categoryId] ?? null;
}

export function knownCategoryIds(): string[] {
  return Object.keys(contract.categories);
}

/**
 * Render the `attributes` skeleton the model is asked to fill: every required key, then every
 * optional key, each mapped to null. Order matters — it is part of the prompt text the golden hash
 * covers, so a reordering would surface as drift rather than silently changing model behaviour.
 */
function attributeNulls(spec: CategorySpec): string {
  return [...spec.required, ...spec.optional].map(k => `"${k}": null`).join(', ');
}

function fill(template: string, spec: CategorySpec): string {
  return template
    .replace(/\{\{CATEGORY_NAME\}\}/g, spec.name)
    .replace(/\{\{REQUIRED\}\}/g, spec.required.join(', '))
    .replace(/\{\{OPTIONAL\}\}/g, spec.optional.join(', '))
    .replace(/\{\{CONDITION_OPTIONS\}\}/g, spec.conditionOptions.join(' | '))
    .replace(/\{\{SCOPE_OPTIONS\}\}/g, spec.scopeOptions.join(' | '))
    .replace(/\{\{NOTES\}\}/g, spec.notes)
    .replace(/\{\{ATTRIBUTE_NULLS\}\}/g, attributeNulls(spec));
}

/** The system prompt for one category — identical to what v0.8.37 built inline. */
export function buildSystemPrompt(categoryId: string): string {
  const spec = categorySpec(categoryId);
  if (!spec) throw new Error(`Unknown category: ${categoryId}`);
  return fill(contract.systemPromptTemplate, spec);
}

/**
 * The user message. `watchExtra` is appended only for watches, where reference, collector name and
 * case diameter are the three fields that decide whether an identification is worth anything.
 */
export function buildUserPrompt(categoryId: string, hintsText: string): string {
  const spec = categorySpec(categoryId);
  if (!spec) throw new Error(`Unknown category: ${categoryId}`);
  const watchExtra = categoryId === 'cat-watch' ? contract.watchExtra : '';
  const template = hintsText ? contract.userPromptWithHints : contract.userPromptWithoutHints;
  return fill(template, spec)
    .replace(/\{\{HINTS\}\}/g, hintsText)
    .replace(/\{\{WATCH_EXTRA\}\}/g, watchExtra);
}

/**
 * FNV-1a over the assembled prompts of every category, as lowercase hex.
 *
 * Deliberately not SHA-256: this has to run identically in the browser, in Node and in Rust with no
 * crypto dependency on any of the three. It is a drift detector, not a security primitive — the
 * question it answers is "did these two implementations produce the same bytes", and for that a
 * 64-bit FNV over ~100 KB of prompt is more than enough.
 */
export function contractFingerprint(): string {
  // Hash the per-prompt hashes rather than one concatenated blob: each prompt's digest is
  // unambiguous, so the result cannot depend on a separator convention or on how either language
  // joins a list. Each line reads `<id>:<kind>:<hash>`, which also makes a mismatch legible - the
  // differing line names the category and the prompt that drifted.
  const lines: string[] = [];
  for (const id of knownCategoryIds().sort()) {
    lines.push(id + ':system:' + fnv1a64(buildSystemPrompt(id)));
    lines.push(id + ':user:' + fnv1a64(buildUserPrompt(id, '')));
    lines.push(id + ':user-hints:' + fnv1a64(buildUserPrompt(id, 'brand: Rolex')));
  }
  return fnv1a64(lines.join('|'));
}

export function fnv1a64(input: string): string {
  // 64-bit FNV-1a with BigInt so the result is exact and matches Rust's u64 wrapping arithmetic.
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(input);
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}
