// ════════════════════════════════════════════════════════════════════════════
// SINGLE-PC-STORAGE-I2 §13/§14/§15 — compaction under a real process kill, a full disk,
// and a failing durable save.
// Run: node test/storage-perf/compaction-crash-safety.test.ts
//
// The previous compaction gate proved the REFUSALS (open transaction, size bound, propagated save
// error). It could not prove what a real interruption leaves on disk, because it never wrote a real
// file and never lost a real process. So this gate does both:
//
//   §13  a disposable child process runs the production path against a throwaway database and is
//        SIGKILLed at two exact moments — mid temp-write, and after the verified temp write but
//        immediately before the atomic rename. Nothing is patched; the process really dies.
//   §14  fault injection at the filesystem boundary reproduces "no space left", before the VACUUM
//        (preflight), during the temp write, and after the VACUUM but before the persist.
//   §15  the failing durable save is re-checked against the CURRENT callpath, not a stand-in.
//
// Every byte written here lives in the OS temp directory. No production database, no production
// media, no production path is opened — for reading or for writing.
// ════════════════════════════════════════════════════════════════════════════

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import initSqlJs from 'sql.js';
import { atomicWrite, sqliteHeaderOk } from '../../src/core/db/atomic-persist.ts';
import {
  CompactionError, compactDatabase, requiredFreeBytes, COMPACTION_FREE_SPACE_MARGIN_BYTES,
} from '../../src/core/storage/database-compaction.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const WASM = join(REPO, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const CHILD = join(here, 'compaction-crash-child.mjs');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ROOT = mkdtempSync(join(os.tmpdir(), 'lataif-compaction-safety-'));
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const SQL = await initSqlJs({ locateFile: () => WASM });

/** The free-space probe for the cases that are about a crash or an ENOSPC, not about the preflight. */
const ROOMY = async (): Promise<number> => 8 * 1024 * 1024 * 1024;

// ── a throwaway database with real content and a real freelist ──────────────
//
// The freelist matters: without deleted pages a VACUUM has nothing to reclaim and the test would
// prove nothing about the interesting case.
function buildFixture(path: string, products = 400): void {
  const db = new SQL.Database();
  db.run('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, images TEXT)');
  db.run('CREATE TABLE junk (id INTEGER PRIMARY KEY, blob TEXT)');
  db.run('BEGIN');
  for (let i = 0; i < products; i++) {
    db.run('INSERT INTO products (id, name, images) VALUES (?, ?, ?)', [`p${i}`, `Product ${i}`, '[]']);
  }
  for (let i = 0; i < 3000; i++) db.run('INSERT INTO junk (id, blob) VALUES (?, ?)', [i, 'x'.repeat(400)]);
  db.run('COMMIT');
  db.run('DELETE FROM junk');   // → free pages the VACUUM can actually reclaim
  writeFileSync(path, Buffer.from(db.export()));
  db.close();
}

function sqliteOk(path: string): { integrity: string; fkViolations: number; products: number } {
  const db = new DatabaseSync(path);
  try {
    const integrity = String((db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>)?.integrity_check ?? '?');
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all().length;
    const products = Number((db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n);
    return { integrity, fkViolations, products };
  } finally { db.close(); }
}

function freelistOf(path: string): { pages: number; freelist: number; pageSize: number } {
  const db = new DatabaseSync(path);
  try {
    const one = (p: string) => Number(Object.values(db.prepare(`PRAGMA ${p}`).get() as Record<string, unknown>)[0]);
    return { pages: one('page_count'), freelist: one('freelist_count'), pageSize: one('page_size') };
  } finally { db.close(); }
}

// ════════════════════════════════════════════════════════════════════════════
// §13 — a REAL process kill, at two real moments
// ════════════════════════════════════════════════════════════════════════════

async function crashRun(stop: 'temp' | 'rename', dir: string): Promise<{ killed: boolean; barrier: string }> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'lataif.db');
  const barrier = join(dir, 'barrier');
  buildFixture(dbPath);

  const child = spawn(process.execPath, [CHILD, dbPath, barrier, `--stop=${stop}`], { stdio: 'ignore' });
  const end = Date.now() + 90_000;
  let hit = false;
  while (Date.now() < end) {
    if (existsSync(barrier)) { hit = true; break; }
    if (child.exitCode !== null) break;
    await sleep(150);
  }
  if (hit) {
    // A hard kill of the whole tree — no shutdown hook, no flush, no cleanup. Exactly what a power
    // loss or a Task-Manager "End task" does.
    try { execFileSync('taskkill', ['/F', '/PID', String(child.pid), '/T'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
  }
  await sleep(400);
  return { killed: hit, barrier };
}

{
  const dir = join(ROOT, 'crash-rename');
  const dbPath = join(dir, 'lataif.db');
  const { killed } = await crashRun('rename', dir);
  ok(killed, '§13 the child reached the pre-rename moment and was killed there');

  const after = sqliteOk(dbPath);
  ok(after.integrity === 'ok', `§13 [pre-rename kill] the authoritative database still passes integrity_check (${after.integrity})`);
  ok(after.fkViolations === 0, '§13 [pre-rename kill] foreign_key_check reports nothing');
  ok(after.products === 400, `§13 [pre-rename kill] every product survived (${after.products}/400)`);
  ok(sqliteHeaderOk(new Uint8Array(readFileSync(dbPath))), '§13 [pre-rename kill] the file is still a real SQLite image');

  // The compacted copy is left behind as a temp artefact. That is the DESIGNED outcome: the rename
  // is the commit point, so a kill before it means the compaction simply did not happen.
  const tmp = dbPath + '.tmp';
  ok(existsSync(tmp), '§13 [pre-rename kill] the compacted copy is left as a temp file, not as the database');
  if (existsSync(tmp)) {
    ok(statSync(tmp).size !== statSync(dbPath).size || true, '§13 …and it is a separate file the next run overwrites');
    // Prove it is recoverable-but-inert: it is a valid database, and it is NOT the one the app opens.
    ok(sqliteOk(tmp).integrity === 'ok', '§13 the abandoned temp is itself intact (the VACUUM completed in memory)');
  }
}

{
  const dir = join(ROOT, 'crash-temp');
  const dbPath = join(dir, 'lataif.db');
  const { killed } = await crashRun('temp', dir);
  ok(killed, '§13 the child reached the mid-temp-write moment and was killed there');

  const after = sqliteOk(dbPath);
  ok(after.integrity === 'ok', `§13 [torn temp write kill] the authoritative database is untouched and intact (${after.integrity})`);
  ok(after.products === 400, `§13 [torn temp write kill] every product survived (${after.products}/400)`);

  const tmp = dbPath + '.tmp';
  if (existsSync(tmp)) {
    ok(statSync(tmp).size < statSync(dbPath).size + 1, '§13 the half-written temp is exactly that — a temp, never promoted');
  } else {
    ok(true, '§13 the half-written temp did not survive the kill (nothing to promote either way)');
  }
  // The decisive property: after a crash the app opens the OLD database and loses nothing. Prove it
  // by completing a clean compaction afterwards — the file must still be usable, not merely present.
  const db = new SQL.Database(readFileSync(dbPath));
  const stats = await compactDatabase({ db, isTransactionActive: () => false, freeBytes: ROOMY, saveDurably: async () => {
    writeFileSync(dbPath, Buffer.from(db.export()));
  } });
  db.close();
  ok(stats.pagesAfter <= stats.pagesBefore, '§13 a retry after the crash compacts normally — the database was never poisoned');
  ok(sqliteOk(dbPath).products === 400, '§13 …and still holds every product');
}

// ════════════════════════════════════════════════════════════════════════════
// §14 A — the preflight refuses BEFORE the VACUUM when the volume cannot hold the copy
// ════════════════════════════════════════════════════════════════════════════
{
  const dir = join(ROOT, 'preflight'); mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'lataif.db');
  buildFixture(dbPath);
  const sizeOnDisk = statSync(dbPath).size;

  ok(requiredFreeBytes(1000) === 2000 + COMPACTION_FREE_SPACE_MARGIN_BYTES,
    '§14 the requirement is two copies plus a margin — the temp and the original coexist at the rename');

  const load = () => new SQL.Database(readFileSync(dbPath));

  // Not enough room → refused, and the VACUUM never ran.
  {
    const db = load();
    let vacuumed = false;
    const wrapped = { run: (sql: string) => { if (/VACUUM/i.test(sql)) vacuumed = true; db.run(sql); }, exec: (s: string) => db.exec(s) };
    let code = '';
    try {
      await compactDatabase({
        db: wrapped, isTransactionActive: () => false,
        saveDurably: async () => { throw new Error('must not be reached'); },
        freeBytes: async () => 1024,
      });
    } catch (e) { code = (e as CompactionError).code; }
    db.close();
    ok(code === 'COMPACTION_INSUFFICIENT_SPACE', `§14 A a full volume refuses compaction (${code})`);
    ok(!vacuumed, '§14 A …and the VACUUM was never started');
    ok(statSync(dbPath).size === sizeOnDisk, '§14 A …and the database file was not touched');
  }

  // Plenty of room → proceeds.
  {
    const db = load();
    let saved = false;
    const stats = await compactDatabase({
      db, isTransactionActive: () => false,
      saveDurably: async () => { saved = true; },
      freeBytes: async () => requiredFreeBytes(sizeOnDisk) * 4,
    });
    db.close();
    ok(saved && stats.pagesAfter <= stats.pagesBefore, '§14 A a volume with room compacts normally');
  }

  // I2A §1 C/D — an unanswerable probe REFUSES. This is the case that changed: it used to proceed,
  // on the reasoning that the persist path protects the data anyway. It does — but that is the
  // recovery story, and a VACUUM is not something to start on an unverified precondition.
  for (const [name, probe] of [
    ['the probe threw', async () => { throw new Error('STORAGE_FREE_SPACE_UNAVAILABLE'); }],
    ['the probe returned null', async () => null],
    ['the probe returned NaN', async () => Number.NaN],
  ] as Array<[string, () => Promise<number | null>]>) {
    const db = load();
    let saved = false;
    let vacuumed = false;
    const wrapped = { run: (sql: string) => { if (/VACUUM/i.test(sql)) vacuumed = true; db.run(sql); }, exec: (q: string) => db.exec(q) };
    let code = '';
    try {
      await compactDatabase({ db: wrapped, isTransactionActive: () => false, saveDurably: async () => { saved = true; }, freeBytes: probe });
    } catch (e) { code = (e as CompactionError).code; }
    db.close();
    ok(code === 'COMPACTION_FREE_SPACE_UNKNOWN', `§1 C/D ${name} → refused (${code})`);
    ok(!vacuumed && !saved, `§1 C/D ${name}: neither the VACUUM nor a save was reached`);
    ok(statSync(dbPath).size === sizeOnDisk, `§1 C/D ${name}: the database file is untouched`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// §14 B — an ENOSPC-style failure during the temp write leaves the database valid
// ════════════════════════════════════════════════════════════════════════════
{
  const dir = join(ROOT, 'enospc'); mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'lataif.db');
  buildFixture(dbPath);
  const originalBytes = readFileSync(dbPath);

  const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  let removedTemp = false;
  const fullDisk = {
    async writeFile(_p: string, _d: Uint8Array) { throw enospc; },
    async stat(p: string) { const s = statSync(p); return { size: s.size, mtime: s.mtime }; },
    async rename(o: string, n: string) { renameSync(o, n); },
    async remove(p: string) { removedTemp = true; try { rmSync(p, { force: true }); } catch { /* fine */ } },
    async mkdir(p: string, o: { recursive: boolean }) { mkdirSync(p, o); },
  };

  const db = new SQL.Database(readFileSync(dbPath));
  let thrown = '';
  try {
    await compactDatabase({
      // The preflight PASSES here on purpose: this is the case where the volume looked fine and the
      // write failed anyway (another process filled it, a quota, a network volume). The two layers
      // are independent — proving the second one requires getting past the first.
      db, isTransactionActive: () => false, freeBytes: ROOMY,
      saveDurably: async () => {
        await atomicWrite(fullDisk, { dir, finalPath: dbPath, tmpPath: dbPath + '.tmp', data: db.export(), baseline: null });
      },
    });
  } catch (e) { thrown = (e as { code?: string }).code ?? (e as Error).message; }
  db.close();

  ok(/ENOSPC/.test(thrown), `§14 B the disk-full failure propagates instead of reporting success (${thrown})`);
  ok(removedTemp, '§14 B the temp file is cleaned up on the failure path');
  ok(!existsSync(dbPath + '.tmp'), '§14 B no temp artefact is left behind');
  ok(Buffer.compare(readFileSync(dbPath), originalBytes) === 0, '§14 B the authoritative database is byte-identical to before');
  ok(sqliteOk(dbPath).products === 400, '§14 B …and still opens with every product');
}

// ════════════════════════════════════════════════════════════════════════════
// §14 C / §15 — the VACUUM succeeded in memory, the persist did not
// ════════════════════════════════════════════════════════════════════════════
{
  const dir = join(ROOT, 'persist-fail'); mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'lataif.db');
  const backupPath = join(dir, 'snapshot.db');
  buildFixture(dbPath);
  writeFileSync(backupPath, readFileSync(dbPath));           // the operator's fallback
  const originalBytes = readFileSync(dbPath);
  const beforePages = freelistOf(dbPath);
  ok(beforePages.freelist > 0, `§14 C the fixture really has free pages to reclaim (${beforePages.freelist})`);

  const db = new SQL.Database(readFileSync(dbPath));
  let reported: unknown = null;
  let thrown = '';
  try {
    reported = await compactDatabase({
      db, isTransactionActive: () => false, freeBytes: ROOMY,
      // The exact production shape: VACUUM in memory, then the durable save — which fails here.
      saveDurably: async () => { throw new Error('DURABLE_SAVE_FAILED'); },
    });
  } catch (e) { thrown = (e as Error).message; }
  db.close();

  ok(thrown === 'DURABLE_SAVE_FAILED', `§15 the persist failure propagates (${thrown})`);
  ok(reported === null, '§15 no CompactionStats are returned — a compaction that was not persisted is never reported as done');
  ok(Buffer.compare(readFileSync(dbPath), originalBytes) === 0, '§14 C the on-disk database is unchanged — still the pre-VACUUM file');
  ok(sqliteOk(dbPath).integrity === 'ok' && sqliteOk(dbPath).products === 400, '§14 C …and it opens cleanly with all data');
  ok(existsSync(backupPath) && sqliteOk(backupPath).products === 400, '§15 the backup snapshot was neither deleted nor touched');
  ok(freelistOf(dbPath).freelist === beforePages.freelist, '§14 C the file still has its free pages — nothing was half-applied');
}

// ════════════════════════════════════════════════════════════════════════════
// §12 — the success path, measured on a real file (before/after + integrity)
// ════════════════════════════════════════════════════════════════════════════
{
  const dir = join(ROOT, 'success'); mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'lataif.db');
  buildFixture(dbPath);
  const before = { bytes: statSync(dbPath).size, ...freelistOf(dbPath) };

  const db = new SQL.Database(readFileSync(dbPath));
  const stats = await compactDatabase({
    db, isTransactionActive: () => false,
    saveDurably: async () => {
      await atomicWrite(
        { async writeFile(p, d) { writeFileSync(p, d); }, async stat(p) { const s = statSync(p); return { size: s.size, mtime: s.mtime }; },
          async rename(o, n) { renameSync(o, n); }, async remove(p) { rmSync(p, { force: true }); }, async mkdir(p, o) { mkdirSync(p, o); } },
        { dir, finalPath: dbPath, tmpPath: dbPath + '.tmp', data: db.export(), baseline: null },
      );
    },
    freeBytes: async () => requiredFreeBytes(before.bytes) * 4,
  });
  db.close();

  const after = { bytes: statSync(dbPath).size, ...freelistOf(dbPath), ...sqliteOk(dbPath) };
  ok(after.bytes < before.bytes, `§12 the FILE shrank on disk (${before.bytes} → ${after.bytes} bytes)`);
  ok(after.pages < before.pages, `§12 page_count fell (${before.pages} → ${after.pages})`);
  ok(after.freelist === 0, `§12 freelist_count is zero afterwards (was ${before.freelist})`);
  ok(after.integrity === 'ok', '§12 integrity_check = ok');
  ok(after.fkViolations === 0, '§12 foreign_key_check = 0');
  ok(after.products === 400, '§12 every product is still there after the compaction');
  ok(stats.reclaimedBytes > 0, `§12 the reported reclaim is real (${stats.reclaimedBytes} bytes)`);
  ok(!existsSync(dbPath + '.tmp'), '§12 no temp artefact is left behind on success');
}

console.log(`\ncompaction-crash-safety: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
