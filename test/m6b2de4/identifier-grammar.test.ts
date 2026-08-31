// M6-B2DE4 §8 — the identifier grammar contract, TypeScript side.
//
//  1. SEMANTIC drift: run the REAL TS validator (apply-change.ts isValidSyncIdentifier) over the
//     SHARED fixture test/fixtures/sync-identifier-vectors.json — the SAME file the Rust test
//     `identifier_grammar_matches_shared_vectors` runs. If the two grammars ever disagree on one
//     vector, one of the two gates goes red.
//  2. Coverage: extract EVERY table and column name from the live frontend schema and prove each
//     passes the validator — so turning the gate on can never reject a real sync.
//
// Run: node test/m6b2de4/identifier-grammar.test.ts

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isValidSyncIdentifier } from '../../src/core/sync/apply-change.ts';

let pass = 0;
const fails: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fails.push(m); };

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');

// ── 1. Shared-vector semantic drift ─────────────────────────────────────────
const vectors = JSON.parse(readFileSync(join(repo, 'test/fixtures/sync-identifier-vectors.json'), 'utf8'));
for (const a of vectors.accept) {
  check(isValidSyncIdentifier(a) === true, `shared vector must ACCEPT ${JSON.stringify(a)}`);
}
for (const r of vectors.reject) {
  check(isValidSyncIdentifier(r) === false, `shared vector must REJECT ${JSON.stringify(r)}`);
}
check(vectors.accept.length >= 10 && vectors.reject.length >= 20, 'the shared vector set is substantial');

// ── 2. Live frontend schema coverage (49 tables / 193 columns) ──────────────
const schemaSrc =
  readFileSync(join(repo, 'src/core/db/database.ts'), 'utf8') +
  '\n' +
  readFileSync(join(repo, 'src/core/operations/migration.ts'), 'utf8');

const tables = new Set<string>();
for (const m of schemaSrc.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/g)) {
  tables.add(m[1]);
}
const columns = new Set<string>();
for (const m of schemaSrc.matchAll(
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC|BOOLEAN|DATETIME|TIMESTAMP)\b/gm,
)) {
  columns.add(m[1]);
}

for (const t of tables) check(isValidSyncIdentifier(t), `frontend table ${JSON.stringify(t)} must be canonical`);
for (const c of columns) check(isValidSyncIdentifier(c), `frontend column ${JSON.stringify(c)} must be canonical`);

// The measured counts (bash-verified): 49 frontend tables, 193 distinct columns. (The directive's
// "22 tables" is the EMBEDDED server schema, checked Rust-side by the exhaustive inventory test;
// the frontend the sql.js apply path writes to has 49 tables — all also canonical.)
// MOBILE-04B2A2: the +1 table is the local-only `mobile_upload_receipts`; its +5 previously-unseen
// distinct column identifiers are authenticated_user_id, upload_event_id, create_batch_id,
// canonical_product_metadata_hash, prepared_manifest_hash (the other 6 already existed elsewhere).
// SYNC-SAFETY-A1: the +1 column is `seq_year` on document_sequences — the year a document counter
// belongs to, so transfer numbers keep restarting per year while the counter can never be pulled
// back down inside a year.
check(tables.size === 49, `frontend table count is 49 (got ${tables.size})`);
check(columns.size === 193, `frontend distinct column count is 193 (got ${columns.size})`);

console.log(
  `M6-B2DE4 identifier-grammar: ${pass}/${pass + fails.length} checks passed ` +
  `(shared vectors: ${vectors.accept.length} accept / ${vectors.reject.length} reject; ` +
  `frontend schema: ${tables.size} tables / ${columns.size} columns, all canonical)`,
);
if (fails.length) {
  for (const f of fails) console.error('  ✗', f);
  process.exit(1);
}
console.log('OK — Rust and TS agree on every shared vector; every live table and column is a canonical identifier.');
