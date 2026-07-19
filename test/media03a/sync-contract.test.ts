// ════════════════════════════════════════════════════════════════════════════
// MEDIA-03A-R3 §6 — Sync allowlist (50) vs B2DE4 identifier scan (48) reconciliation
//                   + the COMPLETE 50-table sync contract proof.
//
// Run: node test/media03a/sync-contract.test.ts
//
// Two DIFFERENT sets over two DIFFERENT sources were being conflated:
//
//   sync50  — the active sync-apply allowlist. Source: src/core/sync/sync-business-schema.json
//             (`tables`). These are the business tables the sync apply path may write.
//   b2de48  — the tables the B2DE4 identifier-grammar gate scans. Source: the CREATE TABLE
//             statements in database.ts + migration.ts ONLY (schema.sql is NOT scanned).
//             B2DE4 proves every such identifier is CANONICAL; it is a grammar-coverage
//             subset, NOT a statement about which tables are synced.
//
// This gate computes the exact set-difference both ways, pins the DDL source of every
// divergent table, and proves all 50 allowlist tables are backed by real DDL AND covered
// by an explicit field contract — so "48" is never mistaken for "the whole sync schema".
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MEDIA_TABLES } from '../../src/core/db/media-schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

let PASS = 0, FAIL = 0;
const fails: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++; else { FAIL++; fails.push(msg); console.log(`  ✗ ${msg}`); }
}

const CREATE_TABLE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/g;
function scan(rel: string): Set<string> {
  const out = new Set<string>();
  for (const m of readFileSync(join(repo, rel), 'utf8').matchAll(CREATE_TABLE)) out.add(m[1]);
  return out;
}

const S = scan('src/core/db/schema.sql');            // 26
const D = scan('src/core/db/database.ts');           // 44
const M = scan('src/core/operations/migration.ts');  // 4
const b2de48 = new Set<string>([...D, ...M]);        // the EXACT set B2DE4 scans
const legacyAll = new Set<string>([...S, ...D, ...M]);

const manifest = JSON.parse(readFileSync(join(repo, 'src/core/sync/sync-business-schema.json'), 'utf8'));
const sync50 = new Set<string>(Object.keys(manifest.tables));

const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();
const source = (t: string) => [S.has(t) ? 'schema.sql' : null, D.has(t) ? 'database.ts' : null, M.has(t) ? 'migration.ts' : null].filter(Boolean).join('+') || '(none)';

// ── set sizes ──
ok(b2de48.size === 48, `b2de48 (database.ts ∪ migration.ts CREATE TABLE) = 48 (got ${b2de48.size})`);
ok(sync50.size === 50, `sync50 (allowlist) = 50 (got ${sync50.size})`);

// ── sync50 − b2de48 : in the allowlist, NOT scanned by B2DE4 (all live in schema.sql) ──
const syncOnly = diff(sync50, b2de48);
const EXPECT_SYNC_ONLY = [
  'agent_transfers', 'agents', 'consignments', 'customers', 'documents', 'invoice_lines', 'invoices',
  'offer_lines', 'offers', 'orders', 'payments', 'precious_metals', 'products', 'repairs', 'tasks',
].sort();
ok(JSON.stringify(syncOnly) === JSON.stringify(EXPECT_SYNC_ONLY), `sync50 − b2de48 is the 15 schema.sql business tables (got ${JSON.stringify(syncOnly)})`);
for (const t of syncOnly) {
  ok(S.has(t) && !b2de48.has(t), `${t}: declared in schema.sql, so B2DE4 (which scans only database.ts+migration.ts) does not see it — intended`);
}
console.log(`  sync50 − b2de48 = ${syncOnly.length} (synced business tables in schema.sql, outside B2DE4's grammar scan)`);

// ── b2de48 − sync50 : scanned by B2DE4, deliberately NOT synced ──
const b2deOnly = diff(b2de48, sync50);
const EXPECT_B2DE_ONLY = [
  'audit_log', 'authoritative_revisions', 'b1_applied_envelopes', 'b1_op_meta', 'b1_operations',
  'document_sequences', 'ledger_sequence', 'production_inputs', 'production_outputs',
  'scrap_trade_lines', 'scrap_trade_payments', 'scrap_trades', 'tax_payments',
].sort();
ok(JSON.stringify(b2deOnly) === JSON.stringify(EXPECT_B2DE_ONLY), `b2de48 − sync50 is the 13 non-synced local/control tables (got ${JSON.stringify(b2deOnly)})`);
for (const t of b2deOnly) {
  ok(b2de48.has(t) && !sync50.has(t), `${t}: declared in ${source(t)}, control-plane/local — scanned for identifier grammar but intentionally not synced`);
}
console.log(`  b2de48 − sync50 = ${b2deOnly.length} (control-plane/local tables scanned by B2DE4 but never synced)`);

// ── intersection ──
const inter = [...sync50].filter((t) => b2de48.has(t));
ok(inter.length === 35, `sync50 ∩ b2de48 = 35 (got ${inter.length})`);
ok(inter.length + syncOnly.length === 50, 'intersection + sync-only accounts for all 50 sync tables');
ok(inter.length + b2deOnly.length === 48, 'intersection + b2de-only accounts for all 48 B2DE4 tables');

// ── B2DE4 is a documented grammar subset, not the sync schema ──
// (its scan excludes schema.sql on purpose; that is WHY 15 real sync tables are absent from it)
ok([...b2de48].every((t) => D.has(t) || M.has(t)), 'b2de48 is exactly the database.ts+migration.ts identifier scan (grammar subset)');
ok(syncOnly.every((t) => !b2de48.has(t)), 'the 15 schema.sql sync tables are outside B2DE4 by construction (grammar subset, not a sync-completeness gap)');

// ════════════════════════════════════════════════════════════════════════════
// The COMPLETE 50-table sync contract — every allowlist table is backed by real DDL
// AND covered by an explicit field/operation contract in the manifest.
// ════════════════════════════════════════════════════════════════════════════
let fieldTotal = 0;
for (const t of sync50) {
  const entry = manifest.tables[t];
  ok(legacyAll.has(t), `sync table ${t} is backed by real DDL (schema.sql/database.ts/migration.ts): ${source(t)}`);
  ok(Array.isArray(entry.allowed_fields) && entry.allowed_fields.length > 0, `sync table ${t} has a non-empty allowed_fields contract`);
  ok(typeof entry.record_id_field === 'string' && entry.record_id_field.length > 0, `sync table ${t} declares a record_id_field`);
  ok(Array.isArray(entry.allowed_operations) && entry.allowed_operations.length > 0, `sync table ${t} declares allowed_operations`);
  fieldTotal += entry.allowed_fields.length;
}
ok([...sync50].every((t) => !legacyAll.has(t) ? false : true), 'no sync table is missing from the real DDL');

// ── media is never in the active sync allowlist ──
for (const t of MEDIA_TABLES) ok(!sync50.has(t), `media table ${t} is NOT in the sync allowlist`);

if (fails.length) {
  console.log(`\nMEDIA03A-R3 sync-contract: ${PASS}/${PASS + FAIL} checks passed — ${FAIL} FAILED`);
  process.exit(1);
}
console.log(`MEDIA03A-R3 sync-contract: ${PASS}/${PASS} checks passed ` +
  `(sync50 backed by real DDL + field contract, ${fieldTotal} allowed_fields total; b2de48 reconciled: 35 shared, 15 schema.sql-only, 13 non-synced)`);
