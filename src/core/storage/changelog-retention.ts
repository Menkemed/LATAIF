// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §15/§16 — sync_changelog retention SAFETY CONTRACT + dry-run.
//
// `DELETE FROM sync_changelog WHERE synced = 1` is NOT a safe rule on its own, so
// this module encodes what actually is provable and refuses everything else.
//
// CLIENT changelog (`lataif.db`) — retention IS provable:
//   • the ONLY consumer is pushChanges(), which selects `WHERE synced = 0`
//     (sync-service.ts) and flips a row to `synced = 1` only after the server
//     answered 2xx. `synced = 1` therefore means "the authoritative server copy
//     exists"; the local row is a spent outbox entry.
//   • the table is on the apply denylist, so a remote change can never write it
//     back and no pull path reads it.
//   • nothing else reads a synced row's `data` (verified across the whole
//     frontend: the remaining references count rows for a product or delete a
//     product's rows — neither reads a synced payload for replay).
//   Even so this module keeps a deliberate safety margin: rows must be older than
//   `minAgeDays` AND below the newest synced id minus `keepRecent`, so a run can
//   never race a push that is still in flight or destroy the immediate history an
//   operator might want to inspect.
//
// SERVER changelog (`lataif_sync_server.db`) — retention is NOT provable and this
// module refuses to plan it. Clients pull with `?since=<id>` where the cursor
// lives in each client's own localStorage; the server records no per-peer
// acknowledgement anywhere. A row that every currently-online peer has consumed
// may still be the only copy an offline or re-installed peer needs. Without a
// peer-cursor registry there is no safe watermark, and inventing one would mean
// silently deciding that absent peers do not matter.
//
// Read-only: this module NEVER deletes. It returns a plan; the owner-gated caller
// performs the delete inside its own transaction after a backup.
// ════════════════════════════════════════════════════════════════════════════

export interface RetentionRawDb {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export interface RetentionPolicy {
  /** never delete a row younger than this (default 7 days) */
  minAgeDays: number;
  /** never delete the newest N synced rows regardless of age (default 200) */
  keepRecent: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { minAgeDays: 7, keepRecent: 200 };

export interface RetentionDryRun {
  scope: 'client';
  totalRows: number;
  unsyncedRows: number;
  syncedRows: number;
  /** rows that satisfy the FULL safety contract (synced + old enough + outside the keep window) */
  safeToDelete: number;
  /** synced rows held back by the margin (age or keep-window) */
  heldBackByMargin: number;
  /** bytes of `data` in the safe-to-delete set */
  reclaimableBytes: number;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
  /** highest id that may be deleted; null when nothing is safe */
  safeMaxId: number | null;
  /** per-table breakdown of the safe set */
  byTable: Array<{ table: string; rows: number; bytes: number }>;
  policy: RetentionPolicy;
}

/** Why the server-side changelog cannot be pruned — a value, so the UI and the
 *  tests state the same reason and it cannot drift. */
export const SERVER_RETENTION_BLOCKED = 'SYNC_SERVER_RETENTION_NO_PEER_WATERMARK';

function rows(db: RetentionRawDb, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const res = db.exec(sql, params);
  if (res.length === 0) return [];
  return res[0].values.map((v) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < res[0].columns.length; i++) out[res[0].columns[i]] = v[i];
    return out;
  });
}

function one(db: RetentionRawDb, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  const r = rows(db, sql, params);
  return r.length > 0 ? r[0] : null;
}

/**
 * Plan client-side retention. `nowIso` is injected so the calculation is
 * deterministic in tests and never depends on wall-clock drift inside SQL.
 */
export function planClientChangelogRetention(
  db: RetentionRawDb,
  nowIso: string,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): RetentionDryRun {
  const cutoffIso = new Date(new Date(nowIso).getTime() - policy.minAgeDays * 86400000).toISOString();

  const totals = one(db, `SELECT COUNT(*) AS total,
                                 SUM(CASE WHEN synced = 1 THEN 1 ELSE 0 END) AS synced,
                                 MIN(created_at) AS oldest, MAX(created_at) AS newest
                            FROM sync_changelog`);
  const totalRows = Number(totals?.total ?? 0);
  const syncedRows = Number(totals?.synced ?? 0);

  // The keep-window boundary: the id of the Nth-newest SYNCED row. Everything at
  // or above it is retained no matter how old it is.
  const boundary = one(
    db,
    `SELECT MIN(id) AS keep_from FROM (
        SELECT id FROM sync_changelog WHERE synced = 1 ORDER BY id DESC LIMIT ?
     )`,
    [Math.max(0, policy.keepRecent)],
  );
  const keepFrom = boundary?.keep_from == null ? null : Number(boundary.keep_from);

  // A row is safe only if it is synced AND older than the cutoff AND below the
  // keep window. `keepFrom === null` means fewer synced rows than keepRecent →
  // the window covers everything → nothing is safe.
  const idClause = keepFrom == null ? 'AND 0' : 'AND id < ?';
  const params: unknown[] = keepFrom == null ? [cutoffIso] : [cutoffIso, keepFrom];

  const safe = one(
    db,
    `SELECT COUNT(*) AS rows_n, COALESCE(SUM(LENGTH(data)), 0) AS bytes, MAX(id) AS max_id
       FROM sync_changelog
      WHERE synced = 1 AND created_at < ? ${idClause}`,
    params,
  );
  const safeToDelete = Number(safe?.rows_n ?? 0);

  const byTable = rows(
    db,
    `SELECT table_name AS t, COUNT(*) AS rows_n, COALESCE(SUM(LENGTH(data)), 0) AS bytes
       FROM sync_changelog
      WHERE synced = 1 AND created_at < ? ${idClause}
      GROUP BY table_name
      ORDER BY bytes DESC`,
    params,
  ).map((r) => ({ table: String(r.t), rows: Number(r.rows_n), bytes: Number(r.bytes) }));

  return {
    scope: 'client',
    totalRows,
    unsyncedRows: totalRows - syncedRows,
    syncedRows,
    safeToDelete,
    heldBackByMargin: syncedRows - safeToDelete,
    reclaimableBytes: Number(safe?.bytes ?? 0),
    oldestCreatedAt: (totals?.oldest as string | null) ?? null,
    newestCreatedAt: (totals?.newest as string | null) ?? null,
    safeMaxId: safeToDelete > 0 && safe?.max_id != null ? Number(safe.max_id) : null,
    byTable,
    policy,
  };
}

/**
 * The exact, bounded DELETE the plan authorises — id-bounded so it can only ever
 * remove rows the dry-run already counted, and re-checked against the same three
 * predicates so a row that became unsynced between plan and apply is untouched.
 * Returned as SQL + params instead of executed here: the caller owns the
 * transaction, the backup pre-condition and the owner gate.
 */
export function clientRetentionDeleteStatement(
  plan: RetentionDryRun,
  cutoffIso: string,
): { sql: string; params: unknown[] } | null {
  if (plan.safeMaxId == null || plan.safeToDelete === 0) return null;
  return {
    sql: `DELETE FROM sync_changelog WHERE synced = 1 AND created_at < ? AND id <= ?`,
    params: [cutoffIso, plan.safeMaxId],
  };
}

/** The cutoff the plan was computed with — kept next to the planner so the apply
 *  path cannot drift to a different one. */
export function retentionCutoffIso(nowIso: string, policy: RetentionPolicy = DEFAULT_RETENTION_POLICY): string {
  return new Date(new Date(nowIso).getTime() - policy.minAgeDays * 86400000).toISOString();
}
