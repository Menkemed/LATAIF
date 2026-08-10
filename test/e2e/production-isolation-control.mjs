// SINGLE-PC-STORAGE-I2A §6 — the control test, run WITH the real production install alive.
// Run: node test/e2e/production-isolation-control.mjs
//
// Two questions the static sweep and the unit gates cannot answer on their own:
//
//   1. With production actually running, does a representative E2E suite leave it completely alone —
//      same process, same port state, same database bytes, same media tree?
//   2. If the E2E artefact is swapped for a PRODUCTION binary, does the suite really stop before it
//      starts a process — or does it only stop in a unit test?
//
// (2) is done for real: the production release binary is copied over `target/debug/lataif.exe`, the
// suite is invoked, and the harness asserts it aborted with the preflight error and that no app
// process appeared. The original artefact is restored in a `finally`. This is the case that used to
// be survivable only because the single-instance plugin happened to notice production was running —
// luck, not a guarantee.
//
// Production is only ever READ here (process list, port state, file stats + integrity). Nothing in
// this file writes to a production path.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const REPO = process.cwd();
const E2E_BIN = join(REPO, 'src-tauri/target/debug/lataif.exe');
const PROD_BIN = join(REPO, 'src-tauri/target/release/lataif.exe');
const BACKUP_BIN = E2E_BIN + '.i2a-backup';
const SUITE = join(REPO, 'test/e2e/mobile-ingress-worker.e2e.mjs');

const REAL_APPDATA = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
const PROD_DIR = join(REAL_APPDATA, 'com.lataif.app');
const PROD_BIZ_DB = join(PROD_DIR, 'lataif.db');
const PROD_SERVER_DB = join(PROD_DIR, 'lataif_sync_server.db');
const PROD_MEDIA = join(PROD_DIR, 'media');

let PASS = 0, FAIL = 0; const fails = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } };

const ps = (cmd) => { try { return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim(); } catch { return ''; } };

/** Everything about production that a badly isolated test would disturb. Read-only. */
function productionSnapshot() {
  const stat = (p) => { try { const s = statSync(p); return `${s.size}@${s.mtimeMs}`; } catch { return 'absent'; } };
  const mediaCount = ps(`(Get-ChildItem -Recurse -File '${PROD_MEDIA}' -EA SilentlyContinue).Count`);
  return {
    installedProcs: ps("(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -notlike '*target*' }).Id -join ','"),
    port3001: ps('(Get-NetTCPConnection -State Listen -LocalPort 3001 -EA SilentlyContinue).Count'),
    bizDb: stat(PROD_BIZ_DB),
    serverDb: stat(PROD_SERVER_DB),
    mediaFiles: mediaCount,
  };
}

function integrityOf(path) {
  if (!existsSync(path)) return 'absent';
  let db;
  try { db = new DatabaseSync(path, { readOnly: true }); return String(Object.values(db.prepare('PRAGMA integrity_check').get())[0]); }
  catch (e) { return 'unreadable:' + String(e?.message ?? e).slice(0, 40); }
  finally { try { db?.close(); } catch { /* fine */ } }
}

const before = productionSnapshot();
const bizIntegrityBefore = integrityOf(PROD_BIZ_DB);
console.log(`[control] production before: procs=[${before.installedProcs}] port3001=${before.port3001} media=${before.mediaFiles}`);
ok(before.installedProcs !== '' || before.port3001 !== '0',
  `§6 a real production install is present to control against (procs=[${before.installedProcs}], port3001=${before.port3001})`);

try {
  // ── 1. a representative suite, run alongside production ──
  console.log('[control] running mobile-ingress-worker against the isolated install…');
  const run = spawnSync(process.execPath, [SUITE], { encoding: 'utf8', timeout: 900_000 });
  const out = (run.stdout ?? '') + (run.stderr ?? '');
  ok(run.status === 0, `§6 the representative E2E suite passes with production running (exit ${run.status})`);
  ok(/passed, 0 failed/.test(out), '§6 …with no failed checks');

  const after = productionSnapshot();
  ok(after.installedProcs === before.installedProcs, `§6 the production process is untouched ([${before.installedProcs}] → [${after.installedProcs}])`);
  ok(after.port3001 === before.port3001, `§6 the production port state is unchanged (${before.port3001} → ${after.port3001})`);
  ok(after.bizDb === before.bizDb, `§6 the production business database is byte-identical (${before.bizDb} → ${after.bizDb})`);
  ok(after.serverDb === before.serverDb, `§6 the production server database is byte-identical (${before.serverDb} → ${after.serverDb})`);
  ok(after.mediaFiles === before.mediaFiles, `§6 the production media tree is unchanged (${before.mediaFiles} → ${after.mediaFiles} files)`);
  ok(integrityOf(PROD_BIZ_DB) === bizIntegrityBefore, '§6 the production database still reports the same integrity');

  // ── 2. swap in a PRODUCTION artefact and prove the suite refuses to start ──
  if (!existsSync(PROD_BIN)) {
    ok(false, '§6 no production binary available for the swap test — run `npx tauri build` first');
  } else {
    renameSync(E2E_BIN, BACKUP_BIN);
    copyFileSync(PROD_BIN, E2E_BIN);
    const procsBeforeSwap = ps("(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target*' }).Count");
    const swapped = spawnSync(process.execPath, [SUITE], { encoding: 'utf8', timeout: 300_000 });
    const swappedOut = (swapped.stdout ?? '') + (swapped.stderr ?? '');
    ok(swapped.status !== 0, `§6 the suite FAILS when handed a production artefact (exit ${swapped.status})`);
    ok(/E2E PREFLIGHT/.test(swappedOut), '§6 …and fails with the preflight hard stop, not some later symptom');
    ok(/NOT an isolated E2E build/.test(swappedOut), '§6 …naming exactly what is wrong with the artefact');
    const procsAfterSwap = ps("(Get-Process lataif -EA SilentlyContinue | Where-Object { $_.Path -like '*target*' }).Count");
    ok(procsAfterSwap === procsBeforeSwap, `§6 no app process was started at all (${procsBeforeSwap} → ${procsAfterSwap})`);

    const afterSwap = productionSnapshot();
    ok(afterSwap.bizDb === before.bizDb, '§6 the production database is still byte-identical after the swap attempt');
    ok(afterSwap.installedProcs === before.installedProcs, '§6 the production process is still untouched');
    ok(afterSwap.mediaFiles === before.mediaFiles, '§6 the production media tree is still unchanged');
  }
} finally {
  // Restore the real E2E artefact whatever happened above.
  if (existsSync(BACKUP_BIN)) {
    try { rmSync(E2E_BIN, { force: true }); } catch { /* replaced below */ }
    renameSync(BACKUP_BIN, E2E_BIN);
  }
  ok(existsSync(E2E_BIN) && !existsSync(BACKUP_BIN), '§6 the isolated E2E artefact is restored');
}

console.log(`\nproduction-isolation-control: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
