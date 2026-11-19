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
//
// VERIFY-BEFORE-SWAP (19.11.2026) — the same discipline as the offline maintenance tool
// (scripts/maint/changelog-schlankung.mjs, `--stufe verdichten`): the VACUUM no longer runs on the
// live database. It runs on an independent COPY; the copy is compared with the live database —
// integrity_check, schema, user_version and EVERY table row by row INCLUDING its rowid (SQLite
// documents that VACUUM may renumber rowids of tables without an INTEGER PRIMARY KEY, and code here
// orders and resumes by rowid) — and only a copy that matches exactly replaces the live database and
// is persisted. Any difference: the copy is discarded, the live database and the file stay untouched.
// The copy, the check and the swap run synchronously inside the exclusive swap section of
// `database.ts` (no lease holder, no other swap, no `await` between copy and swap), so no write can
// slip in between and be lost by the swap.
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
  /** VERIFY-BEFORE-SWAP — the compacted copy did not match the live database; it was discarded. */
  | 'COMPACTION_VERIFY_FAILED'
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

/** A prepared statement as sql.js provides it — stepped row by row, so a table is never held in memory twice. */
export interface CompactionStatement {
  step(): boolean;
  get(): unknown[];
  free(): unknown;
}

/** The slice of a sql.js `Database` that compaction needs. */
export interface CompactionDb {
  run(sql: string): unknown;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): CompactionStatement;
  export(): Uint8Array;
  close(): void;
}

export interface CompactionDeps<D extends CompactionDb = CompactionDb> {
  /** Raw sql.js handle — the live database at the time of the call (gates and page accounting). */
  db: D;
  /** True while an ambient SQL transaction is open. */
  isTransactionActive: () => boolean;
  /** Durable persist of the compacted image, which is the LIVE database by now (passed in). Must throw on failure. */
  saveDurably: (live: D) => Promise<void>;
  /** An independent in-memory database from these bytes (sql.js: `new SQL.Database(bytes)`). */
  openCopy: (bytes: Uint8Array) => D;
  /**
   * Replace the live database, exclusively. `build` receives the live database and returns the database that takes
   * its place; it runs SYNCHRONOUSLY inside the exclusive section (no lease holder, no other swap). If `build` throws,
   * nothing is replaced. The replaced database is closed by the implementation.
   */
  replaceLive: (build: (live: D) => D) => Promise<void>;
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
  /** For COMPACTION_VERIFY_FAILED: what differed (table, row id, value) — for the log, never shown as data. */
  readonly details: string[];
  constructor(code: CompactionRefusal, details: string[] = []) {
    super(details.length ? `${code}: ${details.join('; ')}` : code);
    this.code = code; this.details = details; this.name = 'CompactionError';
  }
}

/** Reading page counters needs the handle and nothing else — no probe, no save, no gate. */
type PageAccountingDeps = { db: { exec(sql: string): Array<{ columns: string[]; values: unknown[][] }> } };

function scalar(deps: PageAccountingDeps, pragma: string): number {
  const r = deps.db.exec(`PRAGMA ${pragma}`);
  return r.length && r[0].values.length ? Number(r[0].values[0][0]) : 0;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const rows = (db: CompactionDb, sql: string): unknown[][] => db.exec(sql)[0]?.values ?? [];

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return a === b;
}

/** Step two statements in lockstep; the first difference (or a different row count) is reported. */
function compareRows(live: CompactionDb, copy: CompactionDb, sql: string): string | null {
  const a = live.prepare(sql);
  const b = copy.prepare(sql);
  try {
    let n = 0;
    for (;;) {
      const ha = a.step();
      const hb = b.step();
      if (!ha || !hb) return ha === hb ? null : `row count differs after ${n} rows`;
      const ra = a.get();
      const rb = b.get();
      if (ra.length !== rb.length) return `column count differs at row ${n + 1}`;
      for (let i = 0; i < ra.length; i++) {
        if (!sameValue(ra[i], rb[i])) return `row ${n + 1} (rowid ${String(ra[0])}) differs in column ${i}`;
      }
      n++;
    }
  } finally {
    a.free();
    b.free();
  }
}

/**
 * VERIFY-BEFORE-SWAP — is `copy` the same database as `live`, row for row, rowid for rowid? Returns the differences
 * (empty = identical). The offline tool's `inhalt()` in node terms: every table, WITH rowid, plus schema and integrity.
 */
export function verifyCompactedCopy(live: CompactionDb, copy: CompactionDb): string[] {
  const problems: string[] = [];
  const integrity = rows(copy, 'PRAGMA integrity_check').map((r) => String(r[0]));
  if (integrity.length !== 1 || integrity[0] !== 'ok') problems.push(`integrity_check: ${integrity.slice(0, 3).join(', ')}`);
  if (scalar({ db: live }, 'user_version') !== scalar({ db: copy }, 'user_version')) problems.push('user_version differs');
  // Schema without rootpage (VACUUM legitimately renumbers pages, never names or definitions).
  const schemaSql = "SELECT type, name, tbl_name, COALESCE(sql, '') FROM sqlite_master ORDER BY type, name";
  if (JSON.stringify(rows(live, schemaSql)) !== JSON.stringify(rows(copy, schemaSql))) problems.push('schema differs');
  const tablesSql = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_stat%' ORDER BY name";
  for (const [name] of rows(live, tablesSql)) {
    const t = String(name);
    let diff: string | null;
    try {
      diff = compareRows(live, copy, `SELECT rowid AS "__rowid__", * FROM ${quoteIdent(t)} ORDER BY rowid`);
    } catch {
      // WITHOUT ROWID table: compare in the order of all columns.
      const cols = rows(live, `PRAGMA table_info(${quoteIdent(t)})`).length;
      const order = Array.from({ length: Math.max(1, cols) }, (_, i) => String(i + 1)).join(', ');
      diff = compareRows(live, copy, `SELECT * FROM ${quoteIdent(t)} ORDER BY ${order}`);
    }
    if (diff) problems.push(`${t}: ${diff}`);
    if (problems.length >= 10) break;
  }
  return problems;
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
 * is untouched — the live database is never vacuumed; only a verified copy replaces it.
 */
export async function compactDatabase<D extends CompactionDb>(deps: CompactionDeps<D>): Promise<CompactionStats> {
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

  // VERIFY-BEFORE-SWAP — copy, VACUUM the copy, compare, swap: one synchronous block inside the exclusive section.
  const out: { stats?: CompactionStats; adopted?: D } = {};
  await deps.replaceLive((live) => {
    if (deps.isTransactionActive()) throw new CompactionError('COMPACTION_TRANSACTION_ACTIVE');
    const vorher = measureCompaction({ db: live });
    const copy = deps.openCopy(live.export());
    try {
      copy.run('VACUUM');
      const problems = verifyCompactedCopy(live, copy);
      if (problems.length) throw new CompactionError('COMPACTION_VERIFY_FAILED', problems);
      const pagesAfter = scalar({ db: copy }, 'page_count');
      const freelistAfter = scalar({ db: copy }, 'freelist_count');
      const bytesAfter = pagesAfter * vorher.pageSize;
      out.stats = { ...vorher, pagesAfter, freelistAfter, bytesAfter, reclaimedBytes: Math.max(0, vorher.bytesBefore - bytesAfter) };
      out.adopted = copy;
      return copy;
    } catch (e) {
      try { copy.close(); } catch { /* already closed */ }
      throw e;
    }
  });
  if (!out.stats || !out.adopted) throw new CompactionError('COMPACTION_VERIFY_FAILED', ['the verified copy was not adopted']);

  // Persist FIRST, then report: an unpersisted compaction is a lie.
  await deps.saveDurably(out.adopted);

  return out.stats;
}
