// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §15/§16 — sync_changelog retention safety.
// Run: node test/storage-perf/changelog-retention.test.ts
//
// Pins the retention contract that the code review of the sync paths actually
// supports: a CLIENT row is deletable only when it is (a) acknowledged by the
// server (`synced = 1`), (b) older than the age margin, and (c) outside the
// keep-recent window. Anything else — and the entire SERVER changelog — is
// refused, because no peer-cursor watermark exists to prove it safe.
//
// No production DB, no Tauri.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import {
  DEFAULT_RETENTION_POLICY,
  SERVER_RETENTION_BLOCKED,
  clientRetentionDeleteStatement,
  planClientChangelogRetention,
  retentionCutoffIso,
} from '../../src/core/storage/changelog-retention.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

const NOW = '2026-08-10T12:00:00.000Z';
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86400000).toISOString();

type AnyDb = { run(s: string, p?: unknown[]): void; exec(s: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> };

function seed(db: AnyDb): void {
  db.run(`CREATE TABLE sync_changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, branch_id TEXT,
    action TEXT, data TEXT, synced INTEGER, created_at TEXT)`);
}
function add(db: AnyDb, table: string, synced: number, createdAt: string, dataBytes: number): void {
  db.run(`INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES (?,?,?,?,?,?,?)`,
    [table, 'r', 'b1', 'update', 'x'.repeat(dataBytes), synced, createdAt]);
}
function count(db: AnyDb, where = '1=1'): number {
  const r = db.exec(`SELECT COUNT(*) FROM sync_changelog WHERE ${where}`);
  return r.length && r[0].values.length ? Number(r[0].values[0][0]) : 0;
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── 1. nothing is safe while the keep window covers everything ───────────
  {
    const db = new SQL.Database() as unknown as AnyDb; seed(db);
    for (let i = 0; i < 10; i++) add(db, 'products', 1, daysAgo(400), 1000);
    const plan = planClientChangelogRetention(db, NOW);
    ok(plan.totalRows === 10, 'plan counts every row');
    ok(plan.syncedRows === 10, 'plan counts synced rows');
    ok(plan.safeToDelete === 0, 'fewer synced rows than keepRecent → NOTHING is safe, however old');
    ok(plan.heldBackByMargin === 10, 'all rows are reported as held back, not silently ignored');
    ok(clientRetentionDeleteStatement(plan, retentionCutoffIso(NOW)) === null, 'no statement is produced when nothing is safe');
  }

  // ── 2. unsynced rows are never deletable ────────────────────────────────
  {
    const db = new SQL.Database() as unknown as AnyDb; seed(db);
    for (let i = 0; i < 300; i++) add(db, 'products', 0, daysAgo(400), 1000);
    const plan = planClientChangelogRetention(db, NOW);
    ok(plan.unsyncedRows === 300, 'plan reports the unsynced backlog');
    ok(plan.safeToDelete === 0, 'an UNSYNCED row is never safe — it is the only copy that exists');
  }

  // ── 3. the age margin holds young rows back ─────────────────────────────
  {
    const db = new SQL.Database() as unknown as AnyDb; seed(db);
    for (let i = 0; i < 300; i++) add(db, 'products', 1, daysAgo(1), 1000); // pushed today
    const plan = planClientChangelogRetention(db, NOW);
    ok(plan.safeToDelete === 0, 'rows younger than the age margin are never deleted');
  }

  // ── 4. the happy path: old + synced + outside the keep window ───────────
  {
    const db = new SQL.Database() as unknown as AnyDb; seed(db);
    for (let i = 0; i < 500; i++) add(db, 'products', 1, daysAgo(60), 2000);   // old, deletable
    for (let i = 0; i < 250; i++) add(db, 'products', 1, daysAgo(1), 2000);    // young → held
    for (let i = 0; i < 5; i++) add(db, 'invoices', 0, daysAgo(90), 2000);     // unsynced → held

    const plan = planClientChangelogRetention(db, NOW);
    ok(plan.totalRows === 755, 'plan sees all rows');
    ok(plan.safeToDelete === 500, `only the old synced rows outside the window are safe (${plan.safeToDelete})`);
    ok(plan.reclaimableBytes === 500 * 2000, `reclaimable bytes are measured, not estimated (${plan.reclaimableBytes})`);
    ok(plan.safeMaxId === 500, `the delete is id-bounded at the plan's max (${plan.safeMaxId})`);
    ok(plan.byTable.length === 1 && plan.byTable[0].table === 'products', 'per-table breakdown is reported');

    const stmt = clientRetentionDeleteStatement(plan, retentionCutoffIso(NOW))!;
    db.run(stmt.sql, stmt.params);
    ok(count(db) === 255, `after apply exactly the safe rows are gone (${count(db)} left)`);
    ok(count(db, 'synced = 0') === 5, 'every unsynced row survived');
    ok(count(db, "created_at > '" + daysAgo(2) + "'") === 250, 'every young row survived');

    const after = planClientChangelogRetention(db, NOW);
    ok(after.safeToDelete === 0, 'a second run finds nothing left to do (idempotent)');
  }

  // ── 5. the delete can never exceed what the plan counted ────────────────
  {
    const db = new SQL.Database() as unknown as AnyDb; seed(db);
    for (let i = 0; i < 500; i++) add(db, 'products', 1, daysAgo(60), 100);
    const plan = planClientChangelogRetention(db, NOW);
    // A row arrives AFTER the plan was made — it must survive the apply.
    add(db, 'products', 1, daysAgo(60), 100);
    const stmt = clientRetentionDeleteStatement(plan, retentionCutoffIso(NOW))!;
    db.run(stmt.sql, stmt.params);
    ok(count(db) === 501 - plan.safeToDelete, 'a row inserted after planning is out of the id bound and survives');
  }

  // ── 6. a row that became unsynced between plan and apply is spared ──────
  {
    const db = new SQL.Database() as unknown as AnyDb; seed(db);
    for (let i = 0; i < 500; i++) add(db, 'products', 1, daysAgo(60), 100);
    const plan = planClientChangelogRetention(db, NOW);
    db.run(`UPDATE sync_changelog SET synced = 0 WHERE id = 1`);
    const stmt = clientRetentionDeleteStatement(plan, retentionCutoffIso(NOW))!;
    db.run(stmt.sql, stmt.params);
    ok(count(db, 'id = 1') === 1, 'the re-checked synced predicate spares a row that changed after planning');
  }

  // ── 7. policy is explicit and reported ─────────────────────────────────
  {
    const db = new SQL.Database() as unknown as AnyDb; seed(db);
    for (let i = 0; i < 400; i++) add(db, 'products', 1, daysAgo(30), 10);
    const strict = planClientChangelogRetention(db, NOW, { minAgeDays: 90, keepRecent: 10 });
    ok(strict.safeToDelete === 0, 'a stricter age margin protects everything');
    const loose = planClientChangelogRetention(db, NOW, { minAgeDays: 7, keepRecent: 10 });
    ok(loose.safeToDelete === 390, `a looser window frees more (${loose.safeToDelete})`);
    ok(loose.policy.keepRecent === 10 && loose.policy.minAgeDays === 7, 'the plan carries the policy it used');
    ok(DEFAULT_RETENTION_POLICY.minAgeDays === 7 && DEFAULT_RETENTION_POLICY.keepRecent === 200, 'defaults are conservative');
  }

  // ── 8. the server side is refused by contract, not by omission ─────────
  ok(SERVER_RETENTION_BLOCKED === 'SYNC_SERVER_RETENTION_NO_PEER_WATERMARK', 'the server refusal has a stable, explicit reason code');
  {
    const mod = await import('../../src/core/storage/changelog-retention.ts');
    const exported = Object.keys(mod);
    ok(!exported.some((k) => /server/i.test(k) && /plan|delete|apply/i.test(k)),
      'no server-side retention planner or delete exists — the gap is structural, not accidental');
  }

  console.log(`\nchangelog-retention: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
