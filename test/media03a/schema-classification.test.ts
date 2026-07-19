// ════════════════════════════════════════════════════════════════════════════
// MEDIA-03A-R3 §5/§7 — schema table classification integrity
// Run: node test/media03a/schema-classification.test.ts
//   optional: MEDIA03A_EXISTING_DB=<byte-identical lataif.db copy> enables the
//             §5 static-vs-runtime state reconciliation over the REAL init path.
//
// An INDEPENDENT classification manifest assigns every static CREATE-TABLE name
// to exactly one semantic category. The scanner extracts the ACTUAL DDL names;
// the test proves actual == classified (both directions), no table in two
// categories, and that each category's contract holds against an INDEPENDENT
// source (the sync business-schema allowlist for legacy_sync_apply; the scanned
// media DDL for local_inactive_media). The classification is NOT derived from
// "everything else" and NOT from a file path.
//
//   legacy_sync_apply            — frontend table IN the active sync allowlist
//   legacy_local_non_sync        — runtime table deliberately NOT synced
//   local_inactive_media         — the 6 MEDIA-03A tables (empty, never synced)
//   deprecated_or_unreachable_ddl — declared but unreachable (must be justified)
//
// §5 (needs MEDIA03A_EXISTING_DB) additionally separates the MATERIALIZATION state
// of every declared table across phases, so a table is never both "materialized on
// every init" and "missing":
//   declared_and_materialized        — declared AND present in the runtime snapshot
//   declared_pending_materialization — declared, not yet in THIS snapshot, but
//                                      materialized after the real full init path
//   deprecated_or_unreachable        — declared but never materialized (must be none)
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { MEDIA_TABLES, applyMediaSchema } from '../../src/core/db/media-schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

let PASS = 0, FAIL = 0;
const fails: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++; else { FAIL++; fails.push(msg); console.log(`  ✗ ${msg}`); }
}

const CREATE_TABLE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/g;
function scanTables(...relPaths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of relPaths) for (const m of readFileSync(join(repo, p), 'utf8').matchAll(CREATE_TABLE)) out.add(m[1]);
  return out;
}
const eqSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

const LEGACY_SOURCES = ['src/core/db/database.ts', 'src/core/db/schema.sql', 'src/core/operations/migration.ts'];
const MEDIA_SOURCE = 'src/core/db/media-schema.ts';

// ── the four categories, each from an INDEPENDENT source ──
// legacy_sync_apply: the active sync business-schema allowlist (external file).
const syncManifestJson = JSON.parse(readFileSync(join(repo, 'src/core/sync/sync-business-schema.json'), 'utf8'));
const LEGACY_SYNC_APPLY = new Set<string>(Object.keys(syncManifestJson.tables));
// legacy_local_non_sync: hand-declared runtime tables that are deliberately not
// synced (control-plane, sync bookkeeping, local caches, ledgers, snapshots).
const LEGACY_LOCAL_NON_SYNC = new Set<string>([
  'audit_log', 'authoritative_revisions', 'b1_applied_envelopes', 'b1_op_meta', 'b1_operations',
  'branches', 'categories', 'document_sequences', 'events', 'kpi_cache', 'ledger_sequence',
  'production_inputs', 'production_outputs', 'scrap_trade_lines', 'scrap_trade_payments', 'scrap_trades',
  'sessions', 'settings', 'sync_change_quarantine', 'sync_changelog', 'tax_payments', 'tenants',
  'user_branches', 'users',
]);
const LOCAL_INACTIVE_MEDIA = new Set<string>(MEDIA_TABLES);
const DEPRECATED_OR_UNREACHABLE_DDL = new Set<string>(); // none; see §2 note below.

const CATEGORIES: Record<string, Set<string>> = {
  legacy_sync_apply: LEGACY_SYNC_APPLY,
  legacy_local_non_sync: LEGACY_LOCAL_NON_SYNC,
  local_inactive_media: LOCAL_INACTIVE_MEDIA,
  deprecated_or_unreachable_ddl: DEPRECATED_OR_UNREACHABLE_DDL,
};
const classifiedUnion = new Set<string>([...LEGACY_SYNC_APPLY, ...LEGACY_LOCAL_NON_SYNC, ...LOCAL_INACTIVE_MEDIA, ...DEPRECATED_OR_UNREACHABLE_DDL]);

// ── the actual DDL, scanned across ALL sources (legacy + media) ──
const actualLegacy = scanTables(...LEGACY_SOURCES);
const mediaFileTables = scanTables(MEDIA_SOURCE);
const actualAll = new Set<string>([...actualLegacy, ...mediaFileTables]);

// §3 — actual == classified, both directions
for (const t of actualAll) ok(classifiedUnion.has(t), `DDL table ${t} is classified (actual − classified must be empty)`);
for (const t of classifiedUnion) ok(actualAll.has(t), `classified table ${t} exists in the DDL (classified − actual must be empty)`);
ok(actualAll.size === classifiedUnion.size, `actual (${actualAll.size}) equals classified (${classifiedUnion.size})`);

// §3 — each table in exactly one category (categories pairwise disjoint)
const names = Object.keys(CATEGORIES);
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  const overlap = [...CATEGORIES[names[i]]].filter((t) => CATEGORIES[names[j]].has(t));
  ok(overlap.length === 0, `categories ${names[i]} ∩ ${names[j]} is empty (got ${JSON.stringify(overlap)})`);
}

// §1 — semantic contracts, from independent sources
ok(LEGACY_SYNC_APPLY.size === 50, `legacy_sync_apply = 50 sync allowlist tables (got ${LEGACY_SYNC_APPLY.size})`);
for (const t of LEGACY_SYNC_APPLY) ok(actualLegacy.has(t), `sync_apply table ${t} is present in the legacy DDL`);
ok(LEGACY_LOCAL_NON_SYNC.size === 24, `legacy_local_non_sync = 24 (got ${LEGACY_LOCAL_NON_SYNC.size})`);
ok(DEPRECATED_OR_UNREACHABLE_DDL.size === 0, 'deprecated_or_unreachable_ddl is empty (nothing unreachable)');

// media: scanner sees them (anti-hiding), they equal MEDIA_TABLES, none is synced
ok(eqSet(mediaFileTables, LOCAL_INACTIVE_MEDIA), `media-schema.ts DDL equals MEDIA_TABLES (${mediaFileTables.size})`);
for (const t of MEDIA_TABLES) {
  ok(mediaFileTables.has(t), `media table ${t} is found by the scanner (not hidden)`);
  ok(!LEGACY_SYNC_APPLY.has(t), `media table ${t} is NOT in the sync allowlist`);
  ok(!actualLegacy.has(t), `media table ${t} is NOT declared in a legacy source`);
}

// §5 — static-vs-runtime MATERIALIZATION state over the REAL init path (needs a copy).
// Resolves the earlier contradiction: a declared table is either already materialized
// in the snapshot, or PENDING and then materialized by the real init — never "missing".
const existing = process.env.MEDIA03A_EXISTING_DB;
if (existing) {
  const SCHEMA = readFileSync(join(repo, 'src/core/db/schema.sql'), 'utf8');
  const SQL = await initSqlJs({ locateFile: () => join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });
  const staticAll = actualAll; // 80 declared user tables (legacy ∪ media)
  const usr = (db: any): string[] => db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0].values.map((r: any[]) => String(r[0]));
  const sysOf = (db: any): string[] => { const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sqlite_%'"); return r.length ? r[0].values.map((x: any[]) => String(x[0])).sort() : []; };

  // phase 1 — the raw snapshot, before any init has run
  const db = new (SQL as any).Database(readFileSync(existing));
  const rtBefore = usr(db);
  const sysBefore = sysOf(db);
  for (const t of rtBefore) ok(classifiedUnion.has(t), `runtime(before) table ${t} is classified`);

  // phase 2 — the REAL init path materializes the rest: db.run(SCHEMA) + applyMediaSchema
  db.run(SCHEMA);
  applyMediaSchema(db);
  const rtAfter = usr(db);
  const sysAfter = sysOf(db);

  // per-table materialization state
  const matBefore = [...staticAll].filter((t) => rtBefore.includes(t));            // declared_and_materialized
  const pendingBefore = [...staticAll].filter((t) => !rtBefore.includes(t)).sort(); // declared_pending_materialization
  const deprecated = [...staticAll].filter((t) => !rtAfter.includes(t)).sort();     // must be empty

  const EXPECT_PENDING = [...MEDIA_TABLES, 'sync_change_quarantine'].sort();
  ok(JSON.stringify(pendingBefore) === JSON.stringify(EXPECT_PENDING), `pending(before) is exactly the 6 media + sync_change_quarantine (got ${JSON.stringify(pendingBefore)})`);
  ok(matBefore.length === staticAll.size - EXPECT_PENDING.length, `declared_and_materialized(before) = ${staticAll.size - EXPECT_PENDING.length} (got ${matBefore.length})`);
  ok(deprecated.length === 0, `deprecated_or_unreachable is empty — every declared table materializes under the real init (got ${JSON.stringify(deprecated)})`);
  ok(rtAfter.length === staticAll.size, `runtime(after full init) user tables = static declared = ${staticAll.size} (got ${rtAfter.length})`);
  ok([...staticAll].every((t) => rtAfter.includes(t)), 'every declared user table is materialized after the real init');

  // §5 explicit contradiction resolution: sync_change_quarantine is PENDING before, MATERIALIZED after — never both
  ok(pendingBefore.includes('sync_change_quarantine'), 'sync_change_quarantine state(before) = declared_pending_materialization');
  ok(rtAfter.includes('sync_change_quarantine'), 'sync_change_quarantine state(after) = declared_and_materialized');
  ok(LEGACY_LOCAL_NON_SYNC.has('sync_change_quarantine'), 'sync_change_quarantine is classified legacy_local_non_sync');

  // media: pending before, materialized after
  for (const m of MEDIA_TABLES) {
    ok(pendingBefore.includes(m), `media ${m} state(before) = declared_pending_materialization`);
    ok(rtAfter.includes(m), `media ${m} state(after) = declared_and_materialized`);
  }

  // system tables handled explicitly + unchanged across init
  ok(JSON.stringify(sysBefore) === JSON.stringify(['sqlite_sequence']), `system tables(before) = [sqlite_sequence] (got ${JSON.stringify(sysBefore)})`);
  ok(JSON.stringify(sysAfter) === JSON.stringify(['sqlite_sequence']), `system tables(after) = [sqlite_sequence] (got ${JSON.stringify(sysAfter)})`);
  db.close();
  console.log(`  §5 state: ${matBefore.length} declared_and_materialized + ${pendingBefore.length} declared_pending_materialization (→0 after real init) + ${deprecated.length} deprecated; runtime ${rtBefore.length}→${rtAfter.length} user, system ${JSON.stringify(sysBefore)}`);
} else {
  console.log('  (§5 static/runtime state reconciliation SKIPPED — set MEDIA03A_EXISTING_DB)');
}

if (fails.length) {
  console.log(`\nMEDIA03A-R3 schema-classification: ${PASS}/${PASS + FAIL} checks passed — ${FAIL} FAILED`);
  process.exit(1);
}
console.log(`MEDIA03A-R3 schema-classification: ${PASS}/${PASS} checks passed ` +
  `(sync_apply: ${LEGACY_SYNC_APPLY.size}, local_non_sync: ${LEGACY_LOCAL_NON_SYNC.size}, media: ${LOCAL_INACTIVE_MEDIA.size}, deprecated: ${DEPRECATED_OR_UNREACHABLE_DDL.size})`);
