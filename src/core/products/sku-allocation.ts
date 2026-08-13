// ════════════════════════════════════════════════════════════════════════════
// SKU-ALLOC — the ONE rule for "which SKU does a new product get?".
//
// Three callers need this and must never drift apart: the desktop create/edit dialogs
// (via `productStore.nextAvailableSku`), the post-upload auto-identify, and the mobile
// upload drain. The rule lives here as pure functions; each caller supplies its own view
// of the SKUs already in use — the store its in-memory list, the drain a fresh DB read.
//
// Deliberately NOT gap-filling. With RLX-DJ36-002/003/005 in use the next SKU is 006, not
// the free 004: 004 belonged to a product that was deleted, and a new item inheriting a
// retired number is exactly what the operator asked us to avoid.
//
// Pure: no database, no store, no clock.
// ════════════════════════════════════════════════════════════════════════════

/** Trailing digits are the sequence; everything before them is the stem. */
const SEQUENCE = /^(.*?)(\d+)$/;
const DEFAULT_WIDTH = 3;
/** A stem with no sequence yet starts here, so the first item of a stem is `-001`. */
const FIRST_SEQUENCE = 0;
/** Bound on the collision walk — a pathological data set must not spin forever. */
const MAX_PROBE = 10_000;

/** A SKU split into the part that stays and the sequence that counts up. */
export interface SkuParts { stem: string; number: number; width: number }

/**
 * Split a SKU into stem + sequence, or null when there is nothing to split.
 *
 * The trailing digits are the sequence and everything before them is the stem, so
 * `ROL-WCH-001` → stem `ROL-WCH-`, number 1, width 3. A value whose digits are part of the NAME
 * (`RLX-DJ41`) splits at `RLX-DJ` + 41 — which is why every GENERATED seed carries an explicit
 * `-001` suffix: with it, `RLX-DJ41-001` keeps `RLX-DJ41-` as the stem and counts to `-002`,
 * and `RLX-DJ42` can never appear.
 */
export function splitSku(sku: string): SkuParts | null {
  const clean = (sku || '').trim().toUpperCase();
  if (!clean) return null;
  const m = SEQUENCE.exec(clean);
  if (!m) return { stem: `${clean}-`, number: 0, width: DEFAULT_WIDTH };
  const n = parseInt(m[2], 10);
  if (isNaN(n)) return null;
  return { stem: m[1], number: n, width: m[2].length };
}

/** Render a sequence number at least `width` digits wide; a longer number simply gets longer. */
export function padSequence(n: number, width: number): string {
  return String(n).padStart(Math.max(1, width), '0');
}

/** Category → the 3-letter code used in a generated seed. */
export function skuCategoryCode(categoryId?: string): string {
  switch (categoryId) {
    case 'cat-watch': return 'WCH';
    case 'cat-gold-jewelry': return 'GLD';
    case 'cat-branded-gold-jewelry': return 'BGJ';
    case 'cat-original-gold-jewelry': return 'OGJ';
    case 'cat-accessory': return 'ACC';
    case 'cat-spare-part': return 'PRT';
    default: return 'GEN';
  }
}

/**
 * Build the seed for a product that has no SKU of its own: brand-3 + category-3.
 *
 * Never returns an empty string — a product with no brand still gets `ITM-GEN-…`, because a
 * blank seed would produce a blank SKU and the whole point is that the field stops being empty.
 */
export function buildSkuSeed(brand?: string, categoryId?: string): string {
  const letters = (brand || '').replace(/[^A-Za-z]/g, '');
  const brandCode = (letters || 'ITM').slice(0, 3).toUpperCase().padEnd(3, 'X');
  return `${brandCode}-${skuCategoryCode(categoryId)}-001`;
}

/**
 * Does this value mean "no SKU"? Empty and whitespace obviously do — and so do the strings
 * `null` / `undefined`, which is what a serialised missing value looks like by the time it
 * has been through a form and a JSON round trip.
 */
export function skuIsEmpty(value: unknown): boolean {
  if (typeof value !== 'string') return value === null || value === undefined;
  const v = value.trim().toLowerCase();
  return v === '' || v === 'null' || v === 'undefined';
}

/**
 * The next free SKU for `seed`, given every SKU already in use.
 *
 * The seed may or may not carry a sequence: `RLX-DJ41` becomes `RLX-DJ41-001`, while
 * `RLX-DJ41-001` keeps its stem and width and continues from there. The result is the highest
 * sequence seen for that stem plus one — then, only as a safety net against a data set that
 * already contains the computed candidate, the first free number above it.
 *
 * `existing` is compared case-insensitively, so a lowercase SKU in the data still blocks its
 * uppercase twin.
 */
export function nextSkuFrom(seed: string, existing: Iterable<string>): string {
  const clean = (seed || '').trim().toUpperCase();
  if (!clean) return '';

  const m = SEQUENCE.exec(clean);
  const stem = m ? m[1] : `${clean}-`;
  const width = m ? m[2].length : DEFAULT_WIDTH;
  const seedNumber = m ? parseInt(m[2], 10) : FIRST_SEQUENCE + 1;
  let highest = FIRST_SEQUENCE;
  let stemSeen = false;

  const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  const taken = new Set<string>();
  for (const raw of existing) {
    const s = (raw || '').trim().toUpperCase();
    if (!s) continue;
    taken.add(s);
    const hit = pattern.exec(s);
    if (!hit) continue;
    const n = parseInt(hit[1], 10);
    if (isNaN(n)) continue;
    stemSeen = true;
    if (n > highest) highest = n;
  }

  // A stem nobody has used yet starts at the seed's own number, so the first Rolex watch is
  // ROL-WCH-001 and not -002. Once the stem exists we only ever go above its highest number:
  // refilling the gap left by a deleted product would hand a new item a retired number.
  let next = stemSeen ? highest + 1 : seedNumber;
  let candidate = stem + String(next).padStart(width, '0');
  for (let probe = 0; probe < MAX_PROBE && taken.has(candidate); probe++) {
    next++;
    candidate = stem + String(next).padStart(width, '0');
  }
  return candidate;
}

/**
 * Allocate a SKU for a product that does not have one, or return the existing SKU untouched.
 *
 * This is the whole decision in one place: a SKU the operator typed is never replaced, and
 * a product without one gets the next free number for its brand+category seed.
 */
export function resolveSku(
  current: unknown,
  brand: string | undefined,
  categoryId: string | undefined,
  existing: Iterable<string>,
): string {
  if (!skuIsEmpty(current)) return String(current).trim();
  return nextSkuFrom(buildSkuSeed(brand, categoryId), existing);
}
