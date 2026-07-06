// B1 (C1) local-migration test: the REAL shared migration SQL is additive,
// idempotent, and preserves existing data. Run: node test/b1/migration.test.ts

import initSqlJs from 'sql.js';
import { B1_MIGRATION_SQL } from '../../src/core/operations/migration.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++;
  else fail.push(msg);
}

function tables(db: { exec: (s: string) => { values: unknown[][] }[] }): Set<string> {
  const r = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  return new Set((r[0]?.values ?? []).map((v) => String(v[0])));
}
function columns(db: { exec: (s: string) => { values: unknown[][] }[] }, table: string): Set<string> {
  const r = db.exec(`PRAGMA table_info(${table})`);
  return new Set((r[0]?.values ?? []).map((v) => String(v[1])));
}

async function main(): Promise<void> {
  const SQL = await initSqlJs();

  // ── fresh DB ──
  const fresh = new SQL.Database();
  for (const sql of B1_MIGRATION_SQL) fresh.run(sql);
  const t = tables(fresh);
  for (const name of ['authoritative_revisions', 'b1_operations', 'b1_applied_envelopes', 'b1_op_meta']) {
    check(t.has(name), `fresh: table ${name} created`);
  }
  check(columns(fresh, 'b1_operations').has('payload_json'), 'b1_operations has payload_json');
  check(columns(fresh, 'authoritative_revisions').has('revision'), 'authoritative_revisions has revision');

  // ── idempotent re-run (no error, no data loss) ──
  fresh.run("INSERT INTO authoritative_revisions (aggregate_type, aggregate_id, revision, updated_at) VALUES ('EXPENSE_SETTLEMENT','exp-1',3,'t')");
  let threw = false;
  try {
    for (const sql of B1_MIGRATION_SQL) fresh.run(sql); // second apply
  } catch {
    threw = true;
  }
  check(!threw, 'idempotent re-run does not throw');
  const rev = fresh.exec("SELECT revision FROM authoritative_revisions WHERE aggregate_id='exp-1'");
  check(Number(rev[0].values[0][0]) === 3, 'idempotent re-run preserves existing data');

  // ── upgrade from a populated pre-existing schema ──
  const upg = new SQL.Database();
  upg.run('CREATE TABLE expenses (id TEXT PRIMARY KEY, amount REAL); INSERT INTO expenses VALUES (\'exp-9\', 5)');
  for (const sql of B1_MIGRATION_SQL) upg.run(sql);
  check(tables(upg).has('b1_op_meta'), 'upgrade: new table added alongside existing');
  const keep = upg.exec("SELECT amount FROM expenses WHERE id='exp-9'");
  check(Number(keep[0].values[0][0]) === 5, 'upgrade: existing data preserved');

  console.log(`B1 migration test: ${pass} checks passed, ${fail.length} failed`);
  if (fail.length > 0) {
    for (const f of fail) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
