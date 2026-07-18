// M6-B3A §12 (Q17–Q26) — the CLIENT quarantine + atomic-cursor contract, proven BEHAVIORALLY
// against a real sql.js database using the SAME production functions the pull loop calls:
// `applySyncChange` (apply-change.ts) + `applyChangesAtomic` with the `onPoison` hook + the durable
// `commitPulledBatch` order (durable-cursor.ts) + `recordClientQuarantine` (quarantine.ts). No
// mirrored second implementation.
//
// The contract: a pulled batch [valid A, POISON, valid B] must apply A and B, quarantine POISON
// (never apply it, never count it applied), and advance the cursor over the whole batch — all in
// ONE durable transaction. A genuine transient DB error is NOT quarantined: it rolls the whole
// batch back and leaves the cursor put (idempotent re-pull). This is the head-of-line DoS, closed.
//
// Run: node test/m6b3a/quarantine-cursor.test.ts

import initSqlJs from 'sql.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applySyncChange,
  SYNC_FIELD_NOT_ALLOWED,
  SYNC_TABLE_NOT_ALLOWED,
  SYNC_CONTROL_PLANE_TABLE_FORBIDDEN,
  type SqlDb,
} from '../../src/core/sync/apply-change.ts';
import { applyChangesAtomic, commitPulledBatch, SyncApplyError } from '../../src/core/sync/durable-cursor.ts';
import { recordClientQuarantine, quarantineStatus } from '../../src/core/sync/quarantine.ts';

let pass = 0;
const fails: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fails.push(m); };

const here = dirname(fileURLToPath(import.meta.url));
const SQL = await initSqlJs({ locateFile: () => join(here, '../../node_modules/sql.js/dist/sql-wasm.wasm') });

const QUARANTINE_DDL =
  `CREATE TABLE sync_change_quarantine (
     quarantine_id TEXT PRIMARY KEY, change_id INTEGER, source TEXT NOT NULL,
     table_name_redacted TEXT NOT NULL, record_id_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
     reason_code TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
     occurrence_count INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'open',
     resolution_note TEXT, resolved_at TEXT);
   CREATE UNIQUE INDEX idx_q_change ON sync_change_quarantine(change_id) WHERE change_id IS NOT NULL;`;

function freshDb(productsCols = 'id TEXT PRIMARY KEY, brand TEXT, name TEXT'): any {
  const db = new SQL.Database();
  db.run(`CREATE TABLE products (${productsCols})`);
  db.run('CREATE TABLE invoices (id TEXT PRIMARY KEY, gross_amount TEXT)');
  db.run(QUARANTINE_DDL);
  return db;
}

type Chg = { id: number; table_name: string; record_id: string; action: string; data: string };
const chg = (id: number, table: string, record: string, action: string, data: Record<string, unknown>): Chg =>
  ({ id, table_name: table, record_id: record, action, data: JSON.stringify(data) });

// The production pull orchestration, verbatim: apply batch atomically with the poison→quarantine
// hook, then durable-save, then advance the cursor.
function runPull(
  db: any,
  changes: Chg[],
  cursor: { v: number },
  opts: { commitThrows?: boolean; durableThrows?: boolean } = {},
): Promise<void> {
  return commitPulledBatch({
    applyBatch: () =>
      applyChangesAtomic(changes as any, {
        begin: () => db.run('BEGIN'),
        applyChange: (c: any) => applySyncChange(db as SqlDb, c),
        onPoison: (c: any, code: string) =>
          recordClientQuarantine(db as SqlDb, {
            changeId: c.id, tableName: c.table_name, recordId: c.record_id, rawData: c.data, reasonCode: code, now: 'T',
          }),
        commit: () => { if (opts.commitThrows) throw new Error('CRASH before commit'); db.run('COMMIT'); },
        rollback: () => db.run('ROLLBACK'),
      }),
    durableSave: async () => { if (opts.durableThrows) throw new Error('durable save failed'); },
    setCursor: () => { cursor.v = changes.length ? Number(changes[changes.length - 1].id) : cursor.v; },
  });
}
const count = (db: any, sql: string): number => {
  const r = db.exec(sql);
  return r.length ? Number(r[0].values[0][0]) : 0;
};

// ── Q17–Q21: valid A, POISON (bad field), valid B — one durable transaction ──
{
  const db = freshDb();
  const cursor = { v: 0 };
  const batch = [
    chg(1, 'products', 'pA', 'insert', { id: 'pA', brand: 'Rolex' }),        // valid A
    chg(2, 'products', 'pB', 'insert', { id: 'pB', bad_field: 1 }),          // POISON (unknown field)
    chg(3, 'invoices', 'iB', 'insert', { id: 'iB', gross_amount: '100' }),   // valid B
  ];
  let threw: unknown = null;
  try { await runPull(db, batch, cursor); } catch (e) { threw = e; }
  check(threw === null, 'Q17: the batch does NOT throw — the poison is quarantined, not fatal');
  check(count(db, "SELECT COUNT(*) FROM products WHERE id='pA'") === 1, 'Q17: valid A applied');
  check(count(db, "SELECT COUNT(*) FROM invoices WHERE id='iB'") === 1, 'Q17: valid B (after the poison) applied');
  check(count(db, "SELECT COUNT(*) FROM products WHERE id='pB'") === 0, 'Q18: the poison was NOT applied');
  const q = db.exec("SELECT reason_code, change_id FROM sync_change_quarantine");
  check(q.length === 1 && q[0].values.length === 1, 'Q19: exactly one quarantine row');
  check(!!q.length && String(q[0].values[0][0]) === SYNC_FIELD_NOT_ALLOWED, 'Q19: quarantined with the field-not-allowed code');
  check(!!q.length && Number(q[0].values[0][1]) === 2, 'Q19: quarantine keyed to the poisoned change id (2)');
  check(cursor.v === 3, 'Q20: the cursor advanced over the WHOLE batch (to 3)');
  // Q21 — atomicity: applied rows AND the quarantine row are both present → committed together.
  check(count(db, 'SELECT COUNT(*) FROM products') === 1 && count(db, 'SELECT COUNT(*) FROM sync_change_quarantine') === 1,
    'Q21: apply + quarantine committed atomically in one transaction');
  db.close();
}

// ── Q22: a crash BEFORE commit → neither apply, nor quarantine, nor cursor ──
{
  const db = freshDb();
  const cursor = { v: 7 };
  const batch = [
    chg(8, 'products', 'pA', 'insert', { id: 'pA', brand: 'X' }),
    chg(9, 'products', 'pB', 'insert', { id: 'pB', bad_field: 1 }), // poison → would quarantine
  ];
  let threw = false;
  try { await runPull(db, batch, cursor, { commitThrows: true }); } catch { threw = true; }
  check(threw, 'Q22: a crash before commit surfaces as a throw');
  check(count(db, 'SELECT COUNT(*) FROM products') === 0, 'Q22: nothing applied (rolled back)');
  check(count(db, 'SELECT COUNT(*) FROM sync_change_quarantine') === 0, 'Q22: no quarantine row survived (rolled back)');
  check(cursor.v === 7, 'Q22: the cursor did NOT advance');
  db.close();
}

// ── Q23: re-pull is idempotent — same window, no duplicate apply or quarantine ──
{
  const db = freshDb();
  const cursor = { v: 0 };
  const batch = [
    chg(1, 'products', 'pA', 'insert', { id: 'pA', brand: 'X' }),
    chg(2, 'products', 'pB', 'insert', { id: 'pB', bad_field: 1 }),
  ];
  await runPull(db, batch, cursor);
  await runPull(db, batch, cursor); // identical re-pull
  check(count(db, 'SELECT COUNT(*) FROM products') === 1, 'Q23: valid row applied once (upsert idempotent)');
  check(count(db, 'SELECT COUNT(*) FROM sync_change_quarantine') === 1, 'Q23: one quarantine row, not duplicated');
  const occ = count(db, 'SELECT MAX(occurrence_count) FROM sync_change_quarantine');
  check(occ === 2, 'Q23: re-pull bumped occurrence_count, not a duplicate');
  db.close();
}

// ── Q24: a control-plane row is quarantined (never applied) ──
// ── Q25: an unknown table is quarantined ──
{
  const db = freshDb();
  const cursor = { v: 0 };
  const batch = [
    chg(1, 'enrolled_devices', 'd1', 'update', { secret: 'STEAL' }), // control-plane
    chg(2, 'some_unknown_table', 'x', 'update', { anything: 1 }),    // unknown table
    chg(3, 'products', 'pOk', 'insert', { id: 'pOk', brand: 'Z' }),  // valid, still flows
  ];
  await runPull(db, batch, cursor);
  const rows = db.exec('SELECT change_id, reason_code FROM sync_change_quarantine ORDER BY change_id');
  const map = new Map((rows[0]?.values ?? []).map((v: any[]) => [Number(v[0]), String(v[1])]));
  check(map.get(1) === SYNC_CONTROL_PLANE_TABLE_FORBIDDEN, 'Q24: the control-plane row is quarantined, not applied');
  check(map.get(2) === SYNC_TABLE_NOT_ALLOWED, 'Q25: the unknown table is quarantined');
  check(count(db, "SELECT COUNT(*) FROM products WHERE id='pOk'") === 1, 'Q24/Q25: the surrounding valid row still applies');
  check(cursor.v === 3, 'Q24/Q25: cursor advances past both quarantined rows — no HoL stall');
  check(quarantineStatus(db as SqlDb).openCount === 2, 'Q24/Q25: status reports 2 open quarantine entries');
  db.close();
}

// ── Q26: a genuine transient SQL error stays a HARD rollback (never quarantined) ──
// The manifest allows `brand`, but THIS db's products table lacks it → applyUpsert hits a real
// "no such column" error, which is NOT a SyncPoisonError → the whole batch rolls back, cursor put.
{
  const db = freshDb('id TEXT PRIMARY KEY, name TEXT'); // no `brand` column
  const cursor = { v: 5 };
  const batch = [
    chg(6, 'products', 'pA', 'insert', { id: 'pA', name: 'ok' }),   // would apply
    chg(7, 'products', 'pB', 'update', { id: 'pB', brand: 'X' }),   // real SQL error (no such column)
  ];
  let err: unknown = null;
  try { await runPull(db, batch, cursor); } catch (e) { err = e; }
  check(err instanceof SyncApplyError, 'Q26: a transient DB error surfaces as SyncApplyError (not swallowed)');
  check(count(db, 'SELECT COUNT(*) FROM products') === 0, 'Q26: hard rollback — the earlier valid row did NOT survive');
  check(count(db, 'SELECT COUNT(*) FROM sync_change_quarantine') === 0, 'Q26: a transient error is NOT quarantined');
  check(cursor.v === 5, 'Q26: the cursor did NOT advance → idempotent re-pull');
  db.close();
}

console.log(`M6-B3A quarantine-cursor: ${pass}/${pass + fails.length} checks passed`);
if (fails.length) { for (const f of fails) console.error('  x', f); process.exit(1); }
console.log('OK — client quarantine + atomic cursor: poison quarantined (not applied, not fatal), valid rows flow, ' +
  'cursor advances, re-pull idempotent, control-plane/unknown quarantined, transient errors hard-rollback.');
