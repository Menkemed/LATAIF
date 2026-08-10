// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §18 — VACUUM / compaction contract.
// Run: node test/storage-perf/database-compaction.test.ts
//
// Proves that compaction actually reclaims space through REAL sql.js, that it is
// refused (never attempted) when it would be unsafe, and that it is always
// followed by a durable save.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import {
  COMPACTION_MAX_BYTES, CompactionError, compactDatabase, isPlausibleFreeBytes, measureCompaction,
} from '../../src/core/storage/database-compaction.ts';

// SINGLE-PC-STORAGE-I2A §1 — the free-space probe is now REQUIRED and fail-closed, so every call
// site has to state what the disk looks like. `roomy()` is the boring answer for the cases that are
// about something else; the preflight itself is exercised in section 5.
const roomy = async () => 8 * 1024 * 1024 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

type AnyDb = { run(s: string): void; exec(s: string): Array<{ columns: string[]; values: unknown[][] }> };

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  function seeded(rows: number): AnyDb {
    const db = new SQL.Database() as unknown as AnyDb;
    db.run(`CREATE TABLE blobs (id INTEGER PRIMARY KEY, data TEXT)`);
    db.run('BEGIN');
    for (let i = 0; i < rows; i++) db.run(`INSERT INTO blobs (data) VALUES ('${'x'.repeat(4000)}')`);
    db.run('COMMIT');
    return db;
  }

  // ── 1. a real reclaim ───────────────────────────────────────────────────
  {
    const db = seeded(2000);
    db.run(`DELETE FROM blobs WHERE id % 2 = 0`);
    let saved = 0;
    const stats = await compactDatabase({ db, isTransactionActive: () => false, saveDurably: async () => { saved++; }, freeBytes: roomy });
    ok(stats.freelistBefore > 0, `deleting rows leaves free pages behind (${stats.freelistBefore})`);
    ok(stats.pagesAfter < stats.pagesBefore, `VACUUM shrinks the database (${stats.pagesBefore} → ${stats.pagesAfter} pages)`);
    ok(stats.freelistAfter === 0, 'the freelist is empty afterwards');
    ok(stats.reclaimedBytes > 0, `reclaimed bytes are reported (${stats.reclaimedBytes})`);
    ok(saved === 1, 'the compacted image is persisted durably, exactly once');
    const still = db.exec(`SELECT COUNT(*) FROM blobs`);
    ok(Number(still[0].values[0][0]) === 1000, 'the surviving rows are all still there');
  }

  // ── 2. refusals never touch the database ────────────────────────────────
  {
    const db = seeded(200);
    const before = measureCompaction({ db, isTransactionActive: () => false, saveDurably: async () => {} });
    let saved = 0;
    let code = '';
    try {
      await compactDatabase({ db, isTransactionActive: () => true, saveDurably: async () => { saved++; }, freeBytes: roomy });
    } catch (e) { code = (e as CompactionError).code; }
    ok(code === 'COMPACTION_TRANSACTION_ACTIVE', 'an open transaction refuses compaction');
    ok(saved === 0, 'a refusal never saves');
    const after = measureCompaction({ db, isTransactionActive: () => false, saveDurably: async () => {} });
    ok(after.pagesBefore === before.pagesBefore, 'a refusal leaves the page count untouched');
  }
  {
    const db = seeded(200);
    let code = '';
    try {
      await compactDatabase({ db, isTransactionActive: () => false, saveDurably: async () => {}, maxBytes: 1024, freeBytes: roomy });
    } catch (e) { code = (e as CompactionError).code; }
    ok(code === 'COMPACTION_DB_TOO_LARGE', 'an oversized database is refused, not attempted');
  }

  // ── 3. a persist failure surfaces (never a silent "compacted") ──────────
  {
    const db = seeded(400);
    db.run(`DELETE FROM blobs WHERE id % 2 = 0`);
    let threw = '';
    try {
      await compactDatabase({ db, isTransactionActive: () => false, saveDurably: async () => { throw new Error('DISK_FULL'); }, freeBytes: roomy });
    } catch (e) { threw = (e as Error).message; }
    ok(threw === 'DISK_FULL', 'a failed durable save propagates instead of reporting success');
  }

  // ── 4. compaction is inert on an already-tight database ────────────────
  {
    const db = seeded(50);
    const stats = await compactDatabase({ db, isTransactionActive: () => false, saveDurably: async () => {}, freeBytes: roomy });
    ok(stats.pagesAfter <= stats.pagesBefore, 'a tight database does not grow');
    ok(stats.freelistAfter === 0, 'freelist stays empty');
  }

  // ── 5. SINGLE-PC-STORAGE-I2A §1 — the free-space preflight is FAIL-CLOSED ───────────────
  //
  // The four cases, and the one that used to be wrong: an unanswerable probe was previously treated
  // as permission to continue. A VACUUM rewrites the entire file; starting it on "we could not tell"
  // is a guess, and the write path being hardened is a recovery story, not a reason to guess.
  {
    const cases: Array<[string, () => Promise<number | null>, string]> = [
      ['A enough room', async () => 8 * 1024 * 1024 * 1024, ''],
      ['B provably too little', async () => 1024, 'COMPACTION_INSUFFICIENT_SPACE'],
      ['C the probe threw', async () => { throw new Error('STORAGE_FREE_SPACE_UNAVAILABLE'); }, 'COMPACTION_FREE_SPACE_UNKNOWN'],
      ['C the probe returned null', async () => null, 'COMPACTION_FREE_SPACE_UNKNOWN'],
      ['D NaN', async () => Number.NaN, 'COMPACTION_FREE_SPACE_UNKNOWN'],
      ['D Infinity', async () => Number.POSITIVE_INFINITY, 'COMPACTION_FREE_SPACE_UNKNOWN'],
      ['D negative', async () => -1, 'COMPACTION_FREE_SPACE_UNKNOWN'],
      ['D beyond any real filesystem', async () => Number.MAX_SAFE_INTEGER * 2, 'COMPACTION_FREE_SPACE_UNKNOWN'],
    ];
    for (const [name, probe, expected] of cases) {
      const db = seeded(200);
      db.run(`DELETE FROM blobs WHERE id % 2 = 0`);
      const pagesBefore = measureCompaction({ db, isTransactionActive: () => false, saveDurably: async () => {}, freeBytes: roomy }).pagesBefore;
      let saved = 0;
      let code = '';
      try {
        await compactDatabase({ db, isTransactionActive: () => false, saveDurably: async () => { saved++; }, freeBytes: probe });
      } catch (e) { code = (e as CompactionError).code; }
      ok(code === expected, `§1 ${name} → ${expected || 'allowed'} (got ${code || 'allowed'})`);
      if (expected) {
        ok(saved === 0, `§1 ${name}: nothing was persisted`);
        const after = measureCompaction({ db, isTransactionActive: () => false, saveDurably: async () => {}, freeBytes: roomy });
        ok(after.pagesBefore === pagesBefore, `§1 ${name}: the database was not touched — the VACUUM never ran`);
      }
    }
    ok(isPlausibleFreeBytes(0) && isPlausibleFreeBytes(1234), '§1 a real byte count is plausible');
    for (const bad of [null, undefined, '5', Number.NaN, Number.POSITIVE_INFINITY, -1, {}]) {
      ok(!isPlausibleFreeBytes(bad), `§1 ${String(bad)} is not a number to bet a database rewrite on`);
    }
  }

  ok(COMPACTION_MAX_BYTES === 400 * 1024 * 1024, 'the size bound is an explicit, reviewable constant');

  console.log(`\ndatabase-compaction: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
