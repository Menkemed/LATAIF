// SINGLE-PC-STORAGE-I2 §13 — the disposable process that gets KILLED mid-compaction.
//
// Runs the REAL production path against a throwaway database: sql.js load → compactDatabase (VACUUM)
// → db.export() → atomicWrite (temp → verify → rename). A fault point is injected into the FS
// adapter so the process can be killed at an exact, meaningful moment instead of at random:
//
//   --stop=temp    halfway through writing the temp file
//   --stop=rename  after the temp is fully written and verified, immediately BEFORE the rename
//
// At the stop point it touches a barrier file and then blocks forever, so the parent can SIGKILL it
// deterministically. Nothing here patches SQL state — the process really dies with the write in
// flight, which is the only way to learn what the authoritative file looks like afterwards.
//
// Usage: node compaction-crash-child.mjs <dbPath> <barrierPath> --stop=temp|rename

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, statSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactDatabase } from '../../src/core/storage/database-compaction.ts';
import { atomicWrite } from '../../src/core/db/atomic-persist.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const WASM = join(REPO, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

const [dbPath, barrierPath] = process.argv.slice(2);
const stopAt = (process.argv.find((a) => a.startsWith('--stop=')) ?? '--stop=rename').slice(7);

function blockForever(marker) {
  writeFileSync(barrierPath, marker);
  // A busy-ish spin the parent can kill at any instant. Deliberately not an async wait: the process
  // must be genuinely alive and mid-operation when the kill lands.
  for (;;) {
    const t = Date.now();
    while (Date.now() - t < 50) { /* hold */ }
  }
}

const nodeFs = {
  async writeFile(path, data) {
    if (stopAt === 'temp') {
      // A torn write: half the bytes reach the temp file, then the process dies. This is what a
      // power loss during the persist actually looks like on disk.
      writeFileSync(path, data.subarray(0, Math.floor(data.length / 2)));
      blockForever('temp');
    }
    writeFileSync(path, data);
  },
  async stat(path) { const s = statSync(path); return { size: s.size, mtime: s.mtime }; },
  async rename(oldPath, newPath) {
    if (stopAt === 'rename') blockForever('rename');
    renameSync(oldPath, newPath);
  },
  async remove(path) { try { rmSync(path, { force: true }); } catch { /* best effort */ } },
  async mkdir(path, opts) { mkdirSync(path, opts); },
};

const SQL = await initSqlJs({ locateFile: () => WASM });
const db = new SQL.Database(readFileSync(dbPath));

await compactDatabase({
  db,
  isTransactionActive: () => false,
  // A throwaway volume with room: this child is about the KILL, not about the preflight.
  freeBytes: async () => 8 * 1024 * 1024 * 1024,
  saveDurably: async () => {
    const data = db.export();
    await atomicWrite(nodeFs, {
      dir: dirname(dbPath),
      finalPath: dbPath,
      tmpPath: dbPath + '.tmp',
      data,
      baseline: null,
    });
  },
});

// Only reached when no stop point was requested.
console.log('CHILD_COMPLETED');
