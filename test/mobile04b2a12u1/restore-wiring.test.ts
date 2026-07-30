// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-U1 — restore wiring (buildRestoreOrchestrationOps) + fail-closed contract.
// Run: node test/mobile04b2a12u1/restore-wiring.test.ts
//
// Proves the ops map to the right runtime primitives and the safe order holds end-to-end (block writes →
// stop poller → await idle → flush+close frontend DB → invoke schedule_restore_snapshot with the OPAQUE id only →
// relaunch LAST). And the fail-closed contract: a restore-command failure never relaunches and never
// resumes writers. The server-DB checkpoint step is a JS no-op (done inside the Rust command).
// ════════════════════════════════════════════════════════════════════════════

import {
  buildRestoreOrchestrationOps,
  type RestoreRuntimeDeps,
} from '../../src/core/lifecycle/restore-wiring.ts';
import { prepareAndRestore } from '../../src/core/lifecycle/restore-orchestration.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } };

function fakeDeps(overrides: Partial<RestoreRuntimeDeps> = {}) {
  const order: string[] = [];
  const invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const deps: RestoreRuntimeDeps = {
    invoke: async (cmd, args) => { order.push('invoke:' + cmd); invokes.push({ cmd, args }); return {}; },
    pauseAutoSync: () => { order.push('pauseAutoSync'); },
    stopMobileDrainPoller: () => { order.push('stopMobileDrainPoller'); },
    waitForSyncIdle: async () => { order.push('waitForSyncIdle'); },
    flushAndCloseFrontendDb: async () => { order.push('flushAndCloseFrontendDb'); },
    relaunch: async () => { order.push('relaunch'); },
    setStatus: (s) => order.push('status:' + (s ? s.kind : 'null')),
    ...overrides,
  };
  return { deps, order, invokes };
}
const PARAMS = { snapshotId: 'snap-abc', email: 'owner@x', password: 'pw' };

// ── §1 happy path: exact safe order, opaque id passed, relaunch last ──
await (async () => {
  const { deps, order, invokes } = fakeDeps();
  await prepareAndRestore(buildRestoreOrchestrationOps(PARAMS, deps));
  ok(order.join(',') ===
    'status:restoring,pauseAutoSync,stopMobileDrainPoller,waitForSyncIdle,flushAndCloseFrontendDb,invoke:schedule_restore_snapshot,relaunch',
    'exact safe order (block→stop poller→idle→flush→restore→relaunch): ' + order.join(','));
  ok(invokes.length === 1 && invokes[0].cmd === 'schedule_restore_snapshot', 'exactly one schedule_restore_snapshot invoke');
  ok(invokes[0].args?.snapshotId === 'snap-abc' && !('backupDir' in (invokes[0].args ?? {})) && !('path' in (invokes[0].args ?? {})),
    'only the opaque snapshotId is passed — never a path');
  ok(order.indexOf('flushAndCloseFrontendDb') < order.indexOf('invoke:schedule_restore_snapshot'), 'frontend DB closed BEFORE the restore');
  ok(order.indexOf('invoke:schedule_restore_snapshot') < order.indexOf('relaunch'), 'relaunch only AFTER a successful restore');
})();

// ── §2 restore fails: NO relaunch, writers stay blocked, error surfaced ──
await (async () => {
  const { deps, order } = fakeDeps({ invoke: async () => { throw new Error('MEDIA_FILE_HASH_MISMATCH'); } });
  let threw = false;
  try { await prepareAndRestore(buildRestoreOrchestrationOps(PARAMS, deps)); }
  catch (e) { threw = true; ok(/HASH_MISMATCH/.test(String((e as Error).message)), 'the restore error propagates'); }
  ok(threw, 'a restore failure rejects');
  ok(order.includes('pauseAutoSync') && order.includes('stopMobileDrainPoller'), 'writers + poller were blocked');
  ok(!order.includes('relaunch'), 'NO relaunch on a restore failure');
  ok(order[order.length - 1] === 'status:error', 'error status surfaced (fail-closed, no auto-continue)');
})();

// ── §3 idle-await fails before restore: no invoke, no relaunch ──
await (async () => {
  const { deps, order, invokes } = fakeDeps({ waitForSyncIdle: async () => { throw new Error('idle timeout'); } });
  let threw = false;
  try { await prepareAndRestore(buildRestoreOrchestrationOps(PARAMS, deps)); } catch { threw = true; }
  ok(threw && invokes.length === 0 && !order.includes('relaunch'), 'idle failure blocks the restore + relaunch entirely');
  ok(order.includes('pauseAutoSync'), 'writes were blocked first even when idle-await fails');
})();

console.log(`\nMOBILE-04B2A12-U1 restore-wiring: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
