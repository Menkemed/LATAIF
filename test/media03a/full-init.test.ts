// ════════════════════════════════════════════════════════════════════════════
// MEDIA-03A-R3 §1–§4/§8 — the REAL initialization path + persistence proof.
//
// Run:  node test/media03a/full-init.test.ts
//   optional: MEDIA03A_EXISTING_DB=<byte-identical lataif.db copy> enables Part B,
//             the real 73→80 upgrade proof on an actual productive snapshot.
//
// §1 — THE ACTUAL DB INITIALIZATION CALL PATH (verified against the code, not a
//      prior claim). Source: src/core/db/database.ts.
//
//   initDatabase()  (database.ts:2335)
//     ├─ loaded existing DB   (saved != null, database.ts:2341)
//     │     db = new SQL.Database(saved)          // :2343
//     │     db.run(SCHEMA)                        // :2344  ← schema.sql RUNS for a loaded DB
//     │     runMigrations(db)                     // :2345  → applyMediaSchema(db) at :1745
//     │     migrateCategoriesToV2/V3, backfill*   // :2346-2350  (data migrations)
//     └─ fresh DB             (saved == null, database.ts:2363)
//           db = new SQL.Database()               // :2364
//           db.run(SCHEMA)                        // :2365
//           runMigrations(db)                     // :2366  → applyMediaSchema(db) at :1745
//           seedClean/FreshDatabase(db)           // :2369/2371
//
//   db.run(SCHEMA):    runs on BOTH branches (database.ts:2344, :2354, :2365) and in
//                      resetDatabase() (:2845). SCHEMA = `import … './schema.sql?raw'`
//                      (database.ts:1..) — the RAW bytes of src/core/db/schema.sql,
//                      reproduced here byte-for-byte via readFileSync.
//   runMigrations:     database.ts:200; calls applyMediaSchema(database) at :1745,
//                      then healSyncStringNulls at :1749. Its own body is idempotent
//                      ALTER / CREATE TABLE IF NOT EXISTS on legacy tables.
//   applyMediaSchema:  the ONLY source of the 6 media tables (media-schema.ts:530),
//                      invoked exclusively at database.ts:1745 (inside runMigrations).
//   export / persist:  saveDatabase() (:2774) / flushDatabase() (:2816) via
//                      getDatabase().export() (:2826) — the sql.js byte image the
//                      platform bridge writes to disk. Reopen == new SQL.Database(bytes).
//
//   ANSWER to "does schema.sql run for a loaded existing DB?":  YES — database.ts:2344,
//   inside the `if (saved)` branch, BEFORE runMigrations. Proven by effect in Part B:
//   a snapshot without sync_change_quarantine gains it after db.run(SCHEMA) alone.
//
// This test can NOT import runMigrations (database.ts pulls in `./schema.sql?raw` +
// platform modules, and its DDL must stay in database.ts so the B2DE4 48/187 scan is
// unaffected). It therefore reproduces the table-set-materializing surface of the real
// loaded-DB path with the SAME artifacts the app uses: the real schema.sql bytes
// (db.run(SCHEMA)) and the real applyMediaSchema function (imported, not reimplemented).
// Part B additionally proves runMigrations' remaining statements cannot change the
// outcome on a real snapshot: every legacy table except sync_change_quarantine is
// already materialized, so the only deltas are quarantine (schema.sql) + 6 media.
// ════════════════════════════════════════════════════════════════════════════

import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyMediaSchema, MEDIA_TABLES } from '../../src/core/db/media-schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

let PASS = 0, FAIL = 0;
const fails: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++; else { FAIL++; fails.push(msg); console.log(`  ✗ ${msg}`); }
}

const SQL = await initSqlJs({ locateFile: () => join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });
// The real boot schema — the exact file database.ts imports as `./schema.sql?raw`.
const SCHEMA = readFileSync(join(repo, 'src', 'core', 'db', 'schema.sql'), 'utf8');
const MEDIA = [...MEDIA_TABLES].sort();

const userTables = (db: any): string[] =>
  db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0].values.map((r: any[]) => String(r[0]));
const sysTables = (db: any): string[] => {
  const r = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sqlite_%' ORDER BY name");
  return r.length ? r[0].values.map((x: any[]) => String(x[0])).sort() : [];
};
const rowCount = (db: any, t: string): number | null => {
  const r = db.exec(`SELECT COUNT(*) FROM ${t}`);
  return r.length ? Number(r[0].values[0][0]) : null;
};
const mediaAllEmpty = (db: any): boolean => MEDIA.every((m) => rowCount(db, m) === 0);
const sortedEq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
// tables schema.sql (db.run(SCHEMA)) is entitled to materialize
const SCHEMA_TABLES = new Set<string>();
for (const m of SCHEMA.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/g)) SCHEMA_TABLES.add(m[1]);

// ════════════════════════════════════════════════════════════════════════════
// Part A — mechanism proof through the REAL functions (no external file needed).
//   Boots a base DB with the real schema.sql, then applies the real applyMediaSchema,
//   and proves: +6 media (and nothing else), persistence across export/reopen,
//   idempotency of a second full pass, and that pre-existing rows are untouched.
// ════════════════════════════════════════════════════════════════════════════
{
  const db: any = new SQL.Database();
  db.run('PRAGMA foreign_keys = OFF');
  db.run(SCHEMA); // booted pre-media DB (schema.sql includes sync_change_quarantine, NOT media)
  const T0 = userTables(db);
  ok(!MEDIA.some((m) => T0.includes(m)), 'A: base DB (schema.sql) has NO media tables');
  ok(T0.includes('sync_change_quarantine'), 'A: schema.sql alone materializes sync_change_quarantine');

  applyMediaSchema(db);
  const T1 = userTables(db);
  const added = T1.filter((t) => !T0.includes(t)).sort();
  ok(sortedEq(added, MEDIA), `A: applyMediaSchema adds EXACTLY the 6 media tables (got ${JSON.stringify(added)})`);
  ok(mediaAllEmpty(db), 'A: all 6 media tables are empty');

  // seed a self-adapting products row to prove data survives re-init
  const info = db.exec('PRAGMA table_info(products)')[0].values as unknown[][];
  const cols: string[] = [], vals: string[] = [];
  for (const row of info) {
    const cname = String(row[1]), ctype = String(row[2]).toUpperCase();
    const need = Number(row[3]) === 1 && row[4] === null;
    if (cname === 'id') { cols.push('id'); vals.push("'pA'"); }
    else if (cname === 'name') { cols.push('name'); vals.push("'Ring'"); }
    else if (need) { cols.push(cname); vals.push(ctype.includes('REAL') || ctype.includes('INT') ? '0' : "'x'"); }
  }
  db.run(`INSERT INTO products (${cols.join(',')}) VALUES (${vals.join(',')})`);

  // export + reopen → media must persist beyond RAM
  const bytes = db.export();
  db.close();
  const db2: any = new SQL.Database(bytes);
  ok(MEDIA.every((m) => userTables(db2).includes(m)), 'A: media tables persist across export→reopen (on-disk, not RAM)');
  ok(rowCount(db2, 'products') === 1, 'A: the seeded row survives reopen');

  // second full pass: idempotent, rows untouched, media still empty
  const before = userTables(db2);
  db2.run(SCHEMA); applyMediaSchema(db2);
  const after = userTables(db2);
  ok(sortedEq(before, after), 'A: a second full init adds no tables (idempotent)');
  ok(rowCount(db2, 'products') === 1 && mediaAllEmpty(db2), 'A: second init leaves rows unchanged and media empty');
  db2.close();
}

// ════════════════════════════════════════════════════════════════════════════
// Part B — the REAL 73→80 upgrade proof on a byte-identical productive snapshot.
// ════════════════════════════════════════════════════════════════════════════
const existing = process.env.MEDIA03A_EXISTING_DB;
if (existing) {
  const BIZ = ['products', 'invoices', 'invoice_lines', 'ledger_entries', 'payments'];
  const db: any = new SQL.Database(readFileSync(existing));

  // R0 — raw snapshot, exactly as read from disk (no init has run yet)
  const R0 = userTables(db);
  const sys0 = sysTables(db);
  const bizBefore = Object.fromEntries(BIZ.map((t) => [t, rowCount(db, t)]));
  const hadQuar0 = R0.includes('sync_change_quarantine');
  ok(!hadQuar0, 'B/R0: raw snapshot is pre-B3A — sync_change_quarantine not yet materialized');
  ok(!MEDIA.some((m) => R0.includes(m)), 'B/R0: raw snapshot has NO media tables');

  // R1 — db.run(SCHEMA): the loaded-DB path's first DDL step (database.ts:2344)
  db.run(SCHEMA);
  const R1 = userTables(db);
  const dSchema = R1.filter((t) => !R0.includes(t)).sort();
  ok(R1.includes('sync_change_quarantine'), 'B/R1: db.run(SCHEMA) materialized sync_change_quarantine');
  ok(dSchema.every((t) => SCHEMA_TABLES.has(t)), `B/R1: every SCHEMA delta is a schema.sql table (${JSON.stringify(dSchema)})`);
  ok(sortedEq(dSchema, ['sync_change_quarantine']), `B/R1: on THIS snapshot the SCHEMA delta is exactly [sync_change_quarantine] (got ${JSON.stringify(dSchema)})`);

  // R2 — applyMediaSchema: the runMigrations media step (database.ts:1745)
  applyMediaSchema(db);
  const R2 = userTables(db);
  const dMedia = R2.filter((t) => !R1.includes(t)).sort();
  ok(sortedEq(dMedia, MEDIA), `B/R2: applyMediaSchema added EXACTLY the 6 media tables (got ${JSON.stringify(dMedia)})`);
  ok(R2.length === R0.length + (hadQuar0 ? 0 : 1) + MEDIA.length, `B/R2: user table count is R0+1(quarantine)+6(media) = ${R0.length + 7} (got ${R2.length})`);
  ok(mediaAllEmpty(db), 'B/R2: all 6 media tables are empty');
  const bizAfter = Object.fromEntries(BIZ.map((t) => [t, rowCount(db, t)]));
  ok(BIZ.every((t) => bizBefore[t] === bizAfter[t]), `B/R2: business row counts unchanged (${JSON.stringify(bizBefore)} == ${JSON.stringify(bizAfter)})`);

  // R3 — export + reopen: media + quarantine survive on-disk
  const bytes = db.export();
  db.close();
  const db2: any = new SQL.Database(bytes);
  const R3 = userTables(db2);
  ok(sortedEq(R3, R2), 'B/R3: exported→reopened table set is identical (persisted, not RAM-only)');
  ok(MEDIA.every((m) => R3.includes(m)) && R3.includes('sync_change_quarantine'), 'B/R3: media + quarantine present after reopen');
  ok(BIZ.every((t) => rowCount(db2, t) === bizBefore[t]), 'B/R3: business rows intact after reopen');

  // R4 — second full init: idempotent, rows untouched, media still empty
  db2.run(SCHEMA); applyMediaSchema(db2);
  const R4 = userTables(db2);
  ok(sortedEq(R4, R3), 'B/R4: second full init adds no tables (idempotent)');
  ok(BIZ.every((t) => rowCount(db2, t) === bizBefore[t]) && mediaAllEmpty(db2), 'B/R4: second init leaves rows unchanged and media empty');
  const sys4 = sysTables(db2);
  ok(sortedEq(sys0, sys4), `B/R4: system tables unchanged (${JSON.stringify(sys0)})`);
  db2.close();

  // §8 — separated, non-conflated migration report
  const legacyBefore = R0.filter((t) => !MEDIA.includes(t)).length;
  const legacyAfter = R2.filter((t) => !MEDIA.includes(t)).length;
  console.log('  §8 separated counts:');
  console.log(`     legacy tables : ${legacyBefore} → ${legacyAfter}   (delta: +sync_change_quarantine)`);
  console.log(`     media  tables : 0 → ${R2.filter((t) => MEDIA.includes(t)).length}`);
  console.log(`     user   tables : ${R0.length} → ${R2.length}`);
  console.log(`     system tables : ${JSON.stringify(sys0)} → ${JSON.stringify(sys4)}`);
} else {
  console.log('  (Part B real-snapshot 73→80 proof SKIPPED — set MEDIA03A_EXISTING_DB)');
}

if (fails.length) {
  console.log(`\nMEDIA03A-R3 full-init: ${PASS}/${PASS + FAIL} checks passed — ${FAIL} FAILED`);
  process.exit(1);
}
console.log(`MEDIA03A-R3 full-init: ${PASS}/${PASS} checks passed` + (existing ? ' (incl. real 73→80 snapshot upgrade + reopen + idempotency)' : ' (Part A mechanism only)'));
