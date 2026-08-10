// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §18 — VACUUM (database compaction), owner-triggered only.
//
// Why this is needed at all: SQLite does not shrink a file when rows are deleted,
// it keeps the pages on a freelist. Measured on an isolated copy of a real
// production database, the legacy-media migration removed 9.1 MB of inline image
// text and the FILE stayed at 47.9 MB — the whole reduction only materialised
// after VACUUM (47.9 → 34.4 MB, F5 path 114 → 69 ms). So compaction is not a
// cosmetic extra; without it the migration buys nothing on disk.
//
// Why it is nevertheless gated: sql.js runs SQLite inside a 32-bit WASM heap and
// VACUUM builds the compacted database alongside the original before swapping it.
// On the very databases this slice targets that is a large transient allocation
// on the main thread. So compaction:
//   • NEVER runs at startup, on a timer, or as a side effect of the migration,
//   • refuses when a transaction is open (VACUUM cannot run inside one anyway),
//   • refuses above a conservative size bound instead of risking an OOM,
//   • is followed by a DURABLE save — an in-memory compaction that is not
//     persisted would be silently undone by the next reload.
// ════════════════════════════════════════════════════════════════════════════

/** Above this the in-WASM VACUUM allocation is refused rather than attempted. */
export const COMPACTION_MAX_BYTES = 400 * 1024 * 1024;

/**
 * SINGLE-PC-STORAGE-I2 §14 A — how much free disk the persist really needs.
 *
 * The compacted image is written to a TEMP file next to the database and only then renamed over it,
 * so at the moment of the rename both files exist. Requiring twice the current size plus a margin is
 * therefore the honest figure, not a safety-factor guess.
 */
export const COMPACTION_FREE_SPACE_MARGIN_BYTES = 32 * 1024 * 1024;

export function requiredFreeBytes(dbBytes: number): number {
  return dbBytes * 2 + COMPACTION_FREE_SPACE_MARGIN_BYTES;
}

export type CompactionRefusal =
  | 'COMPACTION_TRANSACTION_ACTIVE'
  | 'COMPACTION_DB_TOO_LARGE'
  | 'COMPACTION_INSUFFICIENT_SPACE'
  /** SINGLE-PC-STORAGE-I2A §1 — the free-space probe could not produce a trustworthy number. */
  | 'COMPACTION_FREE_SPACE_UNKNOWN'
  | 'COMPACTION_UNSUPPORTED';

/**
 * §1 D — is this a number we are willing to bet a database rewrite on?
 *
 * A probe can fail in more ways than "it threw": it can return null, NaN, a negative number, or a
 * value outside anything a filesystem could report. All of those mean the same thing — we do not
 * know how much room there is — and all of them must refuse rather than be coerced to zero (which
 * would refuse for the wrong reason) or to Infinity (which would allow for the wrong reason).
 */
export function isPlausibleFreeBytes(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

export interface CompactionStats {
  pagesBefore: number;
  pagesAfter: number;
  pageSize: number;
  freelistBefore: number;
  freelistAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  reclaimedBytes: number;
}

export interface CompactionDeps {
  /** Raw sql.js handle. */
  db: {
    run(sql: string): void;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  };
  /** True while an ambient SQL transaction is open. */
  isTransactionActive: () => boolean;
  /** Durable persist of the compacted image. Must throw on failure. */
  saveDurably: () => Promise<void>;
  maxBytes?: number;
  /**
   * §14 A / SINGLE-PC-STORAGE-I2A §1 — free bytes on the volume holding the database.
   *
   * REQUIRED, and FAIL-CLOSED. If it throws, returns null, or returns something implausible, the
   * compaction is refused with `COMPACTION_FREE_SPACE_UNKNOWN`. The earlier version treated an
   * unanswerable probe as permission to continue, on the reasoning that `atomicWrite` protects the
   * database anyway. It does — but that is the recovery path, not a licence to start an operation
   * whose precondition is unknown. Both lines stay: this one refuses early, and the write path still
   * survives an ENOSPC that appears later.
   */
  freeBytes: () => Promise<number | null>;
}

export class CompactionError extends Error {
  readonly code: CompactionRefusal;
  constructor(code: CompactionRefusal) { super(code); this.code = code; this.name = 'CompactionError'; }
}

/** Reading page counters needs the handle and nothing else — no probe, no save, no gate. */
type PageAccountingDeps = Pick<CompactionDeps, 'db'> & Partial<CompactionDeps>;

function scalar(deps: PageAccountingDeps, pragma: string): number {
  const r = deps.db.exec(`PRAGMA ${pragma}`);
  return r.length && r[0].values.length ? Number(r[0].values[0][0]) : 0;
}

/** Read the current page accounting without changing anything. */
export function measureCompaction(deps: PageAccountingDeps): Omit<CompactionStats, 'pagesAfter' | 'freelistAfter' | 'bytesAfter' | 'reclaimedBytes'> {
  const pageSize = scalar(deps, 'page_size');
  const pagesBefore = scalar(deps, 'page_count');
  const freelistBefore = scalar(deps, 'freelist_count');
  return { pageSize, pagesBefore, freelistBefore, bytesBefore: pagesBefore * pageSize };
}

/**
 * Compact the database and persist it durably. Refuses (throws `CompactionError`)
 * instead of risking an allocation it cannot complete. On any refusal the database
 * is untouched — VACUUM has not started.
 */
export async function compactDatabase(deps: CompactionDeps): Promise<CompactionStats> {
  if (deps.isTransactionActive()) throw new CompactionError('COMPACTION_TRANSACTION_ACTIVE');
  const before = measureCompaction(deps);
  const limit = deps.maxBytes ?? COMPACTION_MAX_BYTES;
  if (before.bytesBefore > limit) throw new CompactionError('COMPACTION_DB_TOO_LARGE');

  // §14 A / I2A §1 — refuse BEFORE the VACUUM unless the volume is PROVEN to have room. Four cases,
  // one of which used to be handled the wrong way:
  //   A enough room                       → proceed
  //   B provably too little               → COMPACTION_INSUFFICIENT_SPACE
  //   C the probe failed                  → COMPACTION_FREE_SPACE_UNKNOWN   (was: proceed anyway)
  //   D the probe answered implausibly    → COMPACTION_FREE_SPACE_UNKNOWN   (was: proceed anyway)
  // Nothing below this point may run on a guess: the next statement rewrites the whole database.
  let free: number | null;
  try {
    free = await deps.freeBytes();
  } catch {
    throw new CompactionError('COMPACTION_FREE_SPACE_UNKNOWN');
  }
  if (!isPlausibleFreeBytes(free)) throw new CompactionError('COMPACTION_FREE_SPACE_UNKNOWN');
  if (free < requiredFreeBytes(before.bytesBefore)) throw new CompactionError('COMPACTION_INSUFFICIENT_SPACE');

  deps.db.run('VACUUM');

  const pagesAfter = scalar(deps, 'page_count');
  const freelistAfter = scalar(deps, 'freelist_count');
  const bytesAfter = pagesAfter * before.pageSize;

  // Persist FIRST, then report: an unpersisted compaction is a lie.
  await deps.saveDurably();

  return {
    ...before,
    pagesAfter,
    freelistAfter,
    bytesAfter,
    reclaimedBytes: Math.max(0, before.bytesBefore - bytesAfter),
  };
}
