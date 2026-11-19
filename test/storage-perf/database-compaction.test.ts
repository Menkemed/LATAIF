// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §18 — VACUUM / compaction contract.
// Run: node test/storage-perf/database-compaction.test.ts
//
// Proves that compaction actually reclaims space through REAL sql.js, that it is
// refused (never attempted) when it would be unsafe, and that it is always
// followed by a durable save.
//
// VERIFY-BEFORE-SWAP (19.11.2026): the VACUUM runs on a COPY; only a copy that matches the live
// database row for row (with rowid), in schema and integrity replaces it (section 6).
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import {
  COMPACTION_MAX_BYTES, CompactionError, compactDatabase, isPlausibleFreeBytes, measureCompaction, verifyCompactedCopy,
  type CompactionDb,
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

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });
  const open = (bytes?: Uint8Array): CompactionDb => new SQL.Database(bytes) as unknown as CompactionDb;

  function seeded(rows: number): CompactionDb {
    const db = open();
    db.run(`CREATE TABLE blobs (id INTEGER PRIMARY KEY, data TEXT)`);
    db.run('BEGIN');
    for (let i = 0; i < rows; i++) db.run(`INSERT INTO blobs (data) VALUES ('${'x'.repeat(4000)}')`);
    db.run('COMMIT');
    return db;
  }

  /** The live database as `database.ts` holds it: `replaceLive` swaps the holder's handle and closes the old one. */
  function lebend(db: CompactionDb, openCopy: (b: Uint8Array) => CompactionDb = open) {
    const h = { db, swaps: 0 };
    return {
      h,
      teile: {
        get db() { return h.db; },
        openCopy,
        replaceLive: async (build: (live: CompactionDb) => CompactionDb) => {
          const next = build(h.db);
          if (next !== h.db) { const old = h.db; h.db = next; h.swaps++; old.close(); }
        },
      },
    };
  }
  const n = (db: CompactionDb, sql: string): number => Number(db.exec(sql)[0]?.values[0]?.[0] ?? 0);

  // ── 1. a real reclaim ───────────────────────────────────────────────────
  {
    const { h, teile } = lebend(seeded(2000));
    h.db.run(`DELETE FROM blobs WHERE id % 2 = 0`);
    let saved = 0;
    let savedArg: CompactionDb | null = null;
    const stats = await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => false, saveDurably: async (live) => { saved++; savedArg = live; }, freeBytes: roomy });
    ok(stats.freelistBefore > 0, `deleting rows leaves free pages behind (${stats.freelistBefore})`);
    ok(stats.pagesAfter < stats.pagesBefore, `VACUUM shrinks the database (${stats.pagesBefore} → ${stats.pagesAfter} pages)`);
    ok(stats.freelistAfter === 0, 'the freelist is empty afterwards');
    ok(stats.reclaimedBytes > 0, `reclaimed bytes are reported (${stats.reclaimedBytes})`);
    ok(saved === 1, 'the compacted image is persisted durably, exactly once');
    ok(h.swaps === 1 && savedArg === h.db, 'the verified copy replaced the live database, and THAT one was persisted');
    ok(n(h.db, 'PRAGMA freelist_count') === 0 && n(h.db, 'SELECT COUNT(*) FROM blobs') === 1000, 'the surviving rows are all still there, in the compacted live database');
  }

  // ── 2. refusals never touch the database ────────────────────────────────
  {
    const { h, teile } = lebend(seeded(200));
    const before = measureCompaction({ db: h.db, isTransactionActive: () => false });
    let saved = 0;
    let code = '';
    try {
      await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => true, saveDurably: async () => { saved++; }, freeBytes: roomy });
    } catch (e) { code = (e as CompactionError).code; }
    ok(code === 'COMPACTION_TRANSACTION_ACTIVE', 'an open transaction refuses compaction');
    ok(saved === 0 && h.swaps === 0, 'a refusal never saves and never swaps');
    const after = measureCompaction({ db: h.db });
    ok(after.pagesBefore === before.pagesBefore, 'a refusal leaves the page count untouched');
  }
  {
    const { h, teile } = lebend(seeded(200));
    let code = '';
    try {
      await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => false, saveDurably: async () => {}, maxBytes: 1024, freeBytes: roomy });
    } catch (e) { code = (e as CompactionError).code; }
    ok(code === 'COMPACTION_DB_TOO_LARGE', 'an oversized database is refused, not attempted');
  }

  // ── 3. a persist failure surfaces (never a silent "compacted") ──────────
  {
    const { h, teile } = lebend(seeded(400));
    h.db.run(`DELETE FROM blobs WHERE id % 2 = 0`);
    let threw = '';
    try {
      await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => false, saveDurably: async () => { throw new Error('DISK_FULL'); }, freeBytes: roomy });
    } catch (e) { threw = (e as Error).message; }
    ok(threw === 'DISK_FULL', 'a failed durable save propagates instead of reporting success');
  }

  // ── 4. compaction is inert on an already-tight database ────────────────
  {
    const { h, teile } = lebend(seeded(50));
    const stats = await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => false, saveDurably: async () => {}, freeBytes: roomy });
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
      const { h, teile } = lebend(seeded(200));
      h.db.run(`DELETE FROM blobs WHERE id % 2 = 0`);
      const pagesBefore = measureCompaction({ db: h.db }).pagesBefore;
      let saved = 0;
      let code = '';
      try {
        await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => false, saveDurably: async () => { saved++; }, freeBytes: probe });
      } catch (e) { code = (e as CompactionError).code; }
      ok(code === expected, `§1 ${name} → ${expected || 'allowed'} (got ${code || 'allowed'})`);
      if (expected) {
        ok(saved === 0 && h.swaps === 0, `§1 ${name}: nothing was persisted or swapped`);
        const after = measureCompaction({ db: h.db });
        ok(after.pagesBefore === pagesBefore, `§1 ${name}: the database was not touched — the VACUUM never ran`);
      }
    }
    ok(isPlausibleFreeBytes(0) && isPlausibleFreeBytes(1234), '§1 a real byte count is plausible');
    for (const bad of [null, undefined, '5', Number.NaN, Number.POSITIVE_INFINITY, -1, {}]) {
      ok(!isPlausibleFreeBytes(bad), `§1 ${String(bad)} is not a number to bet a database rewrite on`);
    }
  }

  // ── 6. VERIFY-BEFORE-SWAP — only a copy identical in rows, rowids, schema and integrity replaces the live database ──
  {
    /** A database shaped like the real one: an INTEGER PRIMARY KEY table, a TEXT-key rowid table with gaps
     *  (VACUUM may renumber those), a WITHOUT ROWID table, an AUTOINCREMENT table and an index. */
    function wieEcht(): CompactionDb {
      const db = open();
      db.run('PRAGMA user_version = 7');
      db.run('CREATE TABLE audit_log (id TEXT PRIMARY KEY, field_name TEXT, new_value TEXT)');
      db.run('CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT)');
      db.run('CREATE TABLE kv (k TEXT PRIMARY KEY, v BLOB) WITHOUT ROWID');
      db.run('CREATE INDEX idx_audit_field ON audit_log(field_name)');
      db.run('BEGIN');
      for (let i = 0; i < 600; i++) {
        db.run('INSERT INTO audit_log (id, field_name, new_value) VALUES (?, ?, ?)', [`a${i}`, `f${i % 7}`, 'x'.repeat(300)]);
        db.run('INSERT INTO sync_changelog (data) VALUES (?)', ['y'.repeat(300)]);
      }
      db.run("INSERT INTO kv (k, v) VALUES ('b', x'00ff10'), ('a', x'01')");
      db.run('COMMIT');
      db.run("DELETE FROM audit_log WHERE CAST(substr(id, 2) AS INTEGER) % 3 = 0");   // gaps in the implicit rowid
      db.run('DELETE FROM sync_changelog WHERE id % 2 = 0');
      return db;
    }

    // 6a the real path on a realistic shape: verified, swapped, rowids unchanged
    {
      const { h, teile } = lebend(wieEcht());
      const rowidsVorher = JSON.stringify(h.db.exec('SELECT rowid, id FROM audit_log ORDER BY rowid')[0].values);
      const stats = await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => false, saveDurably: async () => {}, freeBytes: roomy });
      ok(h.swaps === 1 && stats.pagesAfter < stats.pagesBefore, `6a realistic shape: verified copy swapped in (${stats.pagesBefore} → ${stats.pagesAfter} pages)`);
      ok(JSON.stringify(h.db.exec('SELECT rowid, id FROM audit_log ORDER BY rowid')[0].values) === rowidsVorher
        && n(h.db, 'PRAGMA user_version') === 7 && n(h.db, 'SELECT COUNT(*) FROM kv') === 2,
      '6a …rowids of the TEXT-key table, user_version and the WITHOUT ROWID table are unchanged');
    }

    // 6b–6e a copy that differs is DISCARDED: nothing swapped, nothing saved, live database untouched
    const verfaelscht: Array<[string, (copy: CompactionDb) => void, RegExp]> = [
      ['a renumbered rowid', (c) => c.run("UPDATE audit_log SET rowid = rowid + 100000 WHERE id = 'a1'"), /audit_log: row \d+ \(rowid \d+\) differs in column 0|audit_log: row count/],
      ['a changed value', (c) => c.run("UPDATE sync_changelog SET data = 'z' WHERE id = 1"), /sync_changelog: row 1 \(rowid 1\) differs in column 2/],
      ['a missing row', (c) => c.run("DELETE FROM kv WHERE k = 'a'"), /kv: (row count differs|row 1 \(rowid a\) differs)/],
      ['a missing last row', (c) => c.run("DELETE FROM sync_changelog WHERE id = (SELECT MAX(id) FROM sync_changelog)"), /sync_changelog: row count differs/],
      ['a changed schema', (c) => c.run('DROP INDEX idx_audit_field'), /schema differs/],
      ['a changed user_version', (c) => c.run('PRAGMA user_version = 8'), /user_version differs/],
    ];
    for (const [name, faelschen, erwartet] of verfaelscht) {
      const original = wieEcht();
      const vorher = original.export();
      let kopie: CompactionDb | null = null;
      const { h, teile } = lebend(original, (b) => { const c = open(b); faelschen(c); kopie = c; return c; });
      let saved = 0;
      let err: CompactionError | null = null;
      try {
        await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => false, saveDurably: async () => { saved++; }, freeBytes: roomy });
      } catch (e) { err = e as CompactionError; }
      ok(err?.code === 'COMPACTION_VERIFY_FAILED' && erwartet.test(err.details.join(' | ')),
        `6 ${name}: refused with COMPACTION_VERIFY_FAILED (${err?.code}: ${err?.details.join(' | ')})`);
      ok(saved === 0 && h.swaps === 0 && h.db === original, `6 ${name}: nothing saved, nothing swapped — the live database stays`);
      const nachher = h.db.export();
      ok(nachher.length === vorher.length && nachher.every((v, i) => v === vorher[i]), `6 ${name}: the live database is byte-identical (never vacuumed)`);
      let zu = false;
      try { (kopie as CompactionDb | null)?.exec('SELECT 1'); } catch { zu = true; }
      ok(zu, `6 ${name}: the discarded copy was closed`);
    }

    // 6f a transaction that opened while waiting for the exclusive section refuses inside it
    {
      const { h, teile } = lebend(wieEcht());
      let aufrufe = 0;
      let code = '';
      try {
        await compactDatabase({ ...teile, db: h.db, isTransactionActive: () => ++aufrufe > 1, saveDurably: async () => {}, freeBytes: roomy });
      } catch (e) { code = (e as CompactionError).code; }
      ok(code === 'COMPACTION_TRANSACTION_ACTIVE' && h.swaps === 0, `6f a transaction opened before the swap section: refused there, nothing swapped (${code})`);
    }

    // 6g the comparison itself: identical copy → no findings
    {
      const a = wieEcht();
      const b = open(a.export());
      ok(verifyCompactedCopy(a, b).length === 0, '6g verifyCompactedCopy: an identical copy has no findings');
    }
  }

  ok(COMPACTION_MAX_BYTES === 400 * 1024 * 1024, 'the size bound is an explicit, reviewable constant');

  console.log(`\ndatabase-compaction: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
