// ════════════════════════════════════════════════════════════════════════════
// SKU-ALLOC §A3/§A4 — the DURABLE, monotonic SKU allocator.
//
// `nextSkuFrom` (sku-allocation.ts) answers "what would the next SKU look like?" from a list —
// good enough to PREVIEW a number in a form, and wrong as the authority: the moment a product is
// deleted its number drops out of that list and the next create hands it out again. On this
// install that is not hypothetical — nine retired numbers (RLX-SUB-003…007 among them) are still
// visible in the sync changelog while no product carries them any more.
//
// So the authority is a counter per stem, the same shape as `document_sequences`, which the
// invoice numbering has used for exactly this reason:
//
//   • it is incremented BEFORE it is read (UPDATE then SELECT), so two callers in the same tick
//     cannot claim the same number — the TOCTOU that a SELECT-then-INSERT would have,
//   • it lives outside `products`, so deleting a product cannot lower it,
//   • on first use for a stem it is seeded from every number that stem has EVER been seen with —
//     living products, the sync changelog and the audit log — so it starts above the past rather
//     than on top of it.
//
// Honest limit, stated rather than papered over: numbers retired before this table existed are
// only recoverable while the changelog and audit rows that mention them still exist. Changelog
// retention can prune those. From the first allocation onward the counter itself is the proof;
// for anything older the guarantee is "as far back as the surviving history reaches".
// ════════════════════════════════════════════════════════════════════════════

import { splitSku, padSequence, type SkuParts } from './sku-allocation.ts';

/** Table DDL — applied idempotently by the normal schema pass, like every other table here. */
export const SKU_SEQUENCES_DDL = `CREATE TABLE IF NOT EXISTS sku_sequences (
  stem        TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL DEFAULT 1,
  padding     INTEGER NOT NULL DEFAULT 3,
  updated_at  TEXT NOT NULL
)`;

/** The narrow database surface this needs — the real sql.js handle satisfies it. */
export interface SkuSequenceDb {
  run(sql: string, params?: unknown[]): unknown;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

function rows(db: SkuSequenceDb, sql: string, params: unknown[] = []): unknown[][] {
  try {
    const r = db.exec(sql, params);
    return r.length === 0 ? [] : r[0].values;
  } catch {
    // A missing optional history table must not stop an allocation — it only makes the seed
    // narrower, and the caller is told nothing it could act on anyway.
    return [];
  }
}

/**
 * Every number this stem has ever been seen with, across the three places the past survives.
 *
 * `products` is the present. `sync_changelog.data` and `audit_log` carry the rows of products
 * that were deleted — that is the only reason a retired number is knowable at all.
 */
export function historicalHighWater(db: SkuSequenceDb, stem: string): number {
  const upperStem = stem.toUpperCase();
  let high = 0;
  const consider = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const parts = splitSku(raw);
    if (!parts || parts.stem.toUpperCase() !== upperStem) return;
    if (parts.number > high) high = parts.number;
  };

  for (const r of rows(db, `SELECT sku FROM products WHERE sku IS NOT NULL AND TRIM(sku) <> ''`)) {
    consider(r[0]);
  }
  // The changelog stores the whole row as JSON; a deleted product's SKU lives on in its payload.
  for (const r of rows(db, `SELECT data FROM sync_changelog WHERE table_name = 'products' AND data IS NOT NULL`)) {
    try {
      const o = JSON.parse(String(r[0])) as Record<string, unknown>;
      consider(o?.sku);
    } catch { /* a payload that will not parse simply contributes nothing */ }
  }
  // Field-level history: both sides of every SKU change ever recorded.
  for (const r of rows(db, `SELECT old_value, new_value FROM audit_log WHERE entity_type = 'products' AND field_name = 'sku'`)) {
    consider(r[0]);
    consider(r[1]);
  }
  return high;
}

/** True when this exact SKU is on a living product. */
function skuInUse(db: SkuSequenceDb, sku: string): boolean {
  return rows(db, `SELECT 1 FROM products WHERE UPPER(TRIM(sku)) = ? LIMIT 1`, [sku.toUpperCase()]).length > 0;
}

/** Bound on the walk past manually-typed collisions. */
const MAX_PROBE = 1000;

/**
 * Claim the next number for `seed` and return the full SKU. The claim is durable and monotonic:
 * the same seed never yields the same number twice, and deleting the product that held a number
 * does not release it.
 *
 * `seed` is a full example SKU (`ROL-WCH-001`), not a bare prefix — the stem and the zero padding
 * are read from it. A seed whose trailing digits are part of the NAME rather than a sequence (the
 * `RLX-DJ41` shape) would split in the wrong place, which is why the generated seed always carries
 * an explicit `-001` suffix.
 */
export function allocateSku(db: SkuSequenceDb, seed: string): string {
  const parts: SkuParts | null = splitSku(seed);
  if (!parts) return '';
  const { stem, width } = parts;

  // Seed the counter the first time this stem is used — above everything the stem has ever been.
  // `INSERT OR IGNORE` makes this a no-op forever after, so the history scan happens once per stem.
  db.run(
    `INSERT OR IGNORE INTO sku_sequences (stem, next_number, padding, updated_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [stem, Math.max(historicalHighWater(db, stem) + 1, parts.number), width],
  );

  for (let probe = 0; probe < MAX_PROBE; probe++) {
    // Increment FIRST, then read: the claimed number is the one before the new value, so two
    // callers in the same tick necessarily walk away with different numbers.
    db.run(`UPDATE sku_sequences SET next_number = next_number + 1, updated_at = datetime('now') WHERE stem = ?`, [stem]);
    const r = rows(db, `SELECT next_number, padding FROM sku_sequences WHERE stem = ?`, [stem]);
    if (r.length === 0) return '';
    const claimed = Number(r[0][0]) - 1;
    const padding = Number(r[0][1]) || width;
    const candidate = stem + padSequence(claimed, padding);
    // A number the operator typed by hand can sit anywhere, including ahead of the counter.
    if (!skuInUse(db, candidate)) return candidate;
  }
  return '';
}
