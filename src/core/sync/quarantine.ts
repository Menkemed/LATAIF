// ═══════════════════════════════════════════════════════════
// LATAIF — Client-side sync quarantine (node-safe, no browser imports)
// ═══════════════════════════════════════════════════════════
//
// M6-B3A §9/§10/§11 — the CLIENT'S durable quarantine for a pulled change that violates the
// business-schema contract. A poisoned change must never be applied and must never be counted as
// applied, but it also must never permanently stall the cursor (the confirmed head-of-line DoS).
// The pull orchestration writes the offending change HERE — inside the SAME transaction as the
// batch's valid changes — so "every id up to next_cursor is APPLIED or QUARANTINED" commits
// atomically, and only then does the cursor advance.
//
// Only HASHES and a redacted table name are stored: no raw payload (which can be a ~1 MB photo or
// carry sensitive fields), no record id in the clear. Deduped by `change_id` so an identical
// re-pull increments `occurrence_count` rather than inserting a duplicate (idempotent re-pull).
//
// Node-safe on purpose: the b3a behavioral gate drives THIS function against a real sql.js
// database — the same code production runs, no mirrored second implementation.

import type { SqlDb } from './apply-change.ts';
import { redactIdentifier } from './apply-change.ts';

// FNV-1a 32-bit → 8-hex. Dependency-free and identical under Node and the browser. This is a
// DIAGNOSTIC/dedup digest, NOT a security primitive — a collision would merely merge two
// quarantine rows, which is harmless. Never used to gate anything.
export function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface QuarantineInput {
  /** Server changelog id of the pulled change, when known (the dedup key). */
  changeId: number | string | null | undefined;
  tableName: string;
  recordId: string;
  /** The raw payload — only HASHED here, never stored. */
  rawData: string | undefined;
  reasonCode: string;
  now: string;
  /** Defaults to 'pull'. */
  source?: string;
}

function num(id: number | string | null | undefined): number | null {
  if (id === null || id === undefined || id === '') return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

/**
 * M6-B3A §9/§10 — record ONE poisoned change into the local quarantine, idempotently. Intended to
 * run INSIDE the pull's apply transaction so it commits atomically with the batch's valid changes.
 * Dedupes on `change_id` when present, else on the (redacted table, record hash, payload hash,
 * reason) tuple; a repeat bumps `occurrence_count` + `last_seen_at` instead of duplicating.
 */
export function recordClientQuarantine(db: SqlDb, q: QuarantineInput): void {
  const source = q.source ?? 'pull';
  const tableRed = redactIdentifier(q.tableName);
  const recHash = stableHash(q.recordId ?? '');
  const payHash = stableHash(q.rawData ?? '');
  const changeId = num(q.changeId);

  // Locate an existing open/closed row for this poison.
  let existingId: string | null = null;
  if (changeId !== null) {
    const r = db.exec('SELECT quarantine_id FROM sync_change_quarantine WHERE change_id = ?', [changeId]);
    if (r.length > 0 && r[0].values.length > 0) existingId = String(r[0].values[0][0]);
  } else {
    const r = db.exec(
      'SELECT quarantine_id FROM sync_change_quarantine WHERE change_id IS NULL AND table_name_redacted = ? ' +
        'AND record_id_hash = ? AND payload_hash = ? AND reason_code = ?',
      [tableRed, recHash, payHash, q.reasonCode],
    );
    if (r.length > 0 && r[0].values.length > 0) existingId = String(r[0].values[0][0]);
  }

  if (existingId !== null) {
    db.run(
      'UPDATE sync_change_quarantine SET occurrence_count = occurrence_count + 1, last_seen_at = ?, ' +
        'reason_code = ? WHERE quarantine_id = ?',
      [q.now, q.reasonCode, existingId],
    );
    return;
  }

  const quarantineId = changeId !== null ? `q:${changeId}` : `qh:${stableHash(`${tableRed}|${recHash}|${payHash}|${q.reasonCode}`)}`;
  db.run(
    'INSERT INTO sync_change_quarantine ' +
      '(quarantine_id, change_id, source, table_name_redacted, record_id_hash, payload_hash, reason_code, ' +
      'first_seen_at, last_seen_at, occurrence_count, state) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open')",
    [quarantineId, changeId, source, tableRed, recHash, payHash, q.reasonCode, q.now, q.now],
  );
}

export interface QuarantineStatus {
  openCount: number;
  lastReason: string | null;
  oldestOpenAt: string | null;
  newestOpenAt: string | null;
}

/** M6-B3A §11 — a local diagnostic snapshot of the open quarantine, for a status command and the
 *  cutover-readiness gate. Returns zeros/nulls when the table is empty or absent. */
export function quarantineStatus(db: SqlDb): QuarantineStatus {
  try {
    const r = db.exec(
      "SELECT COUNT(*), MIN(first_seen_at), MAX(last_seen_at) FROM sync_change_quarantine WHERE state = 'open'",
    );
    const row = r.length > 0 && r[0].values.length > 0 ? r[0].values[0] : [0, null, null];
    const openCount = Number(row[0] ?? 0);
    const oldestOpenAt = (row[1] as string | null) ?? null;
    const newestOpenAt = (row[2] as string | null) ?? null;
    let lastReason: string | null = null;
    if (openCount > 0) {
      const lr = db.exec(
        "SELECT reason_code FROM sync_change_quarantine WHERE state = 'open' ORDER BY last_seen_at DESC, quarantine_id DESC LIMIT 1",
      );
      if (lr.length > 0 && lr[0].values.length > 0) lastReason = String(lr[0].values[0][0]);
    }
    return { openCount, lastReason, oldestOpenAt, newestOpenAt };
  } catch {
    return { openCount: 0, lastReason: null, oldestOpenAt: null, newestOpenAt: null };
  }
}
