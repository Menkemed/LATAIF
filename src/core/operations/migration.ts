// ═══════════════════════════════════════════════════════════
// LATAIF — B1 (C1) additive local migration SQL (shared, testable)
// ═══════════════════════════════════════════════════════════
//
// The four small local tables for the authoritative supplier-credit operation:
// expected-revision tracking, operation rows (retry/restart-recovery), the
// applied-envelope idempotency guard, and the operations-pull cursor. Purely
// additive + idempotent (`IF NOT EXISTS`), no existing table is touched, no
// server-only data is stored locally. Self-contained (no imports) so the desktop
// migration runner AND the e2e harness exercise the exact same SQL.

export const B1_MIGRATION_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS authoritative_revisions (
     aggregate_type TEXT NOT NULL,
     aggregate_id   TEXT NOT NULL,
     revision       INTEGER NOT NULL DEFAULT 0,
     updated_at     TEXT,
     PRIMARY KEY (aggregate_type, aggregate_id)
   )`,
  `CREATE TABLE IF NOT EXISTS b1_operations (
     operation_id    TEXT PRIMARY KEY,
     operation_type  TEXT NOT NULL,
     branch_id       TEXT NOT NULL,
     payload_hash    TEXT,
     payload_json    TEXT,
     status          TEXT NOT NULL,
     server_sequence INTEGER,
     result_json     TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS b1_applied_envelopes (
     operation_id    TEXT PRIMARY KEY,
     server_sequence INTEGER,
     applied_at      TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS b1_op_meta (
     key        TEXT PRIMARY KEY,
     value      TEXT,
     updated_at TEXT
   )`,
];
