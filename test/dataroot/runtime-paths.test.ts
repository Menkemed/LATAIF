// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B1 — the renderer holds NO second answer to "where is the data?".
// Run: npx tsx test/dataroot/runtime-paths.test.ts
//
// Two things are checked, and the second is the one that matters.
//
// 1. `getRuntimePaths()` behaves: one round trip for concurrent callers, cached afterwards, and a
//    hard throw outside the desktop app rather than a plausible-looking guess.
//
// 2. No file under `src/` resolves a DATA path for itself any more. This is a source sweep, for the
//    same reason the AI-price gate is one: the three call sites that used to compute
//    `appDataDir() + 'lataif.db'` were in three different modules, and nothing but reading every
//    file can prove a fourth has not appeared. A renderer that resolves its own path is not a style
//    problem — it is a second implementation that will disagree with the native one exactly once,
//    on the machine where the data root was moved, by opening or creating the wrong database.
// ════════════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { getRuntimePaths, __resetRuntimePathsCache } from '../../src/core/runtime/runtime-paths.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  x ${msg}`); }
}

// ── 1. the module itself ────────────────────────────────────────────────────

const FAKE = {
  dataRoot: 'E:\\LATAIF\\Data',
  rootId: 'abc',
  businessDb: 'E:\\LATAIF\\Data\\lataif.db',
  syncServerDb: 'E:\\LATAIF\\Data\\lataif_sync_server.db',
  mediaRoot: 'E:\\LATAIF\\Data\\media',
  mobileStagingRoot: 'E:\\LATAIF\\Data\\mobile-upload-staging',
  openaiKey: 'E:\\LATAIF\\Data\\openai.key',
  backupsRoot: 'E:\\LATAIF\\Backups',
};

const g = globalThis as unknown as Record<string, unknown>;

await (async () => {
  __resetRuntimePathsCache();
  delete (g as { window?: unknown }).window;
  let threw = false;
  try { await getRuntimePaths(); } catch { threw = true; }
  ok(threw, 'outside the desktop app it throws instead of inventing a path');
})();

await (async () => {
  // Stand in for the Tauri bridge: the module must ask the native side exactly once.
  let calls = 0;
  (g as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        ok(cmd === 'get_runtime_paths', 'it asks the native resolver, by name');
        calls++;
        return FAKE;
      },
    },
  };
  __resetRuntimePathsCache();

  const [a, b, c] = await Promise.all([getRuntimePaths(), getRuntimePaths(), getRuntimePaths()]);
  ok(calls === 1, `three concurrent callers share one round trip (was ${calls})`);
  ok(a === b && b === c, 'and all get the same object');
  const d = await getRuntimePaths();
  ok(calls === 1, 'a later call is served from the cache — the root cannot change while we run');
  ok(d.businessDb === FAKE.businessDb, 'the business DB path comes through untouched');
  ok(d.backupsRoot === FAKE.backupsRoot, 'the backups root is carried separately from the data root');
  ok(!d.backupsRoot.startsWith(d.dataRoot), 'backups are NOT under the data root in this contract');
})();

// ── 2. nobody in src/ resolves a data path for themselves ───────────────────

const SRC = 'src';
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
ok(files.length > 100, `the sweep really walked the source tree (${files.length} files)`);

const offenders: string[] = [];
for (const file of files) {
  const rel = file.split(sep).join('/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // A comment explaining the rule is not a violation of it.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (/\bappDataDir\s*\(/.test(code) || /\bappLocalDataDir\s*\(/.test(code)) {
      offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 90)}`);
    }
  });
}
ok(
  offenders.length === 0,
  `no renderer file resolves the data directory itself\n     ${offenders.join('\n     ')}`,
);

// The one module that may talk to the native resolver.
const importers = files.filter((f) => /runtime-paths/.test(readFileSync(f, 'utf8')));
const importerNames = importers.map((f) => f.split(sep).join('/')).sort();
ok(
  importerNames.includes('src/core/db/database.ts') &&
    importerNames.includes('src/core/ai/ai-service.ts') &&
    importerNames.includes('src/core/settings/pre-destructive-backup.ts'),
  `the three former self-resolvers now go through the resolver (${importerNames.length} files reference it)`,
);

console.log(`\nruntime-paths: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
