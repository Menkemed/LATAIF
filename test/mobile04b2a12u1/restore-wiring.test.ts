// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-U1/U2 — restore wiring (buildRestoreOrchestrationOps) + two-phase contract.
// Run: node test/mobile04b2a12u1/restore-wiring.test.ts
//
// Proves the ops map to the right runtime primitives and the safe order holds end-to-end (block writes →
// stop poller → await idle → SCHEDULE (schedule_restore_snapshot, OPAQUE id only) → flush+close frontend DB
// → relaunch LAST). And the two-phase contract: a PRE-schedule failure resumes writers + re-arms the poller
// (graceful, no relaunch); a POST-schedule failure is fail-closed (no resume, no relaunch).
// ════════════════════════════════════════════════════════════════════════════

import {
  buildRestoreOrchestrationOps,
  type RestoreRuntimeDeps,
} from '../../src/core/lifecycle/restore-wiring.ts';
import { prepareAndScheduleRestore } from '../../src/core/lifecycle/restore-orchestration.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } };

function fakeDeps(overrides: Partial<RestoreRuntimeDeps> = {}) {
  const order: string[] = [];
  const invokes: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const deps: RestoreRuntimeDeps = {
    invoke: async (cmd, args) => { order.push('invoke:' + cmd); invokes.push({ cmd, args }); return {}; },
    pauseAutoSync: () => { order.push('pauseAutoSync'); },
    resumeAutoSync: () => { order.push('resumeAutoSync'); },
    stopMobileDrainPoller: () => { order.push('stopMobileDrainPoller'); },
    armMobileDrainPoller: () => { order.push('armMobileDrainPoller'); },
    waitForSyncIdle: async () => { order.push('waitForSyncIdle'); },
    flushAndCloseFrontendDb: async () => { order.push('flushAndCloseFrontendDb'); },
    relaunch: async () => { order.push('relaunch'); },
    setStatus: (s) => order.push('status:' + (s ? s.kind : 'null')),
    ...overrides,
  };
  return { deps, order, invokes };
}
const PARAMS = { snapshotId: 'snap-abc', email: 'owner@x', password: 'pw' };

// ── §1 happy path: exact safe order, opaque id passed, schedule before flush, relaunch last ──
await (async () => {
  const { deps, order, invokes } = fakeDeps();
  await prepareAndScheduleRestore(buildRestoreOrchestrationOps(PARAMS, deps));
  ok(order.join(',') ===
    'status:scheduling,pauseAutoSync,stopMobileDrainPoller,waitForSyncIdle,invoke:schedule_restore_snapshot,flushAndCloseFrontendDb,relaunch',
    'exact safe order (block→stop poller→idle→schedule→flush→relaunch): ' + order.join(','));
  ok(invokes.length === 1 && invokes[0].cmd === 'schedule_restore_snapshot', 'exactly one schedule_restore_snapshot invoke');
  ok(invokes[0].args?.snapshotId === 'snap-abc' && !('backupDir' in (invokes[0].args ?? {})) && !('path' in (invokes[0].args ?? {})),
    'only the opaque snapshotId is passed — never a path');
  ok(order.indexOf('invoke:schedule_restore_snapshot') < order.indexOf('flushAndCloseFrontendDb'), 'restore SCHEDULED before the frontend DB is closed');
  ok(order.indexOf('flushAndCloseFrontendDb') < order.indexOf('relaunch'), 'relaunch only AFTER close');
  ok(!order.includes('resumeAutoSync'), 'no resume on the happy path');
})();

// ── §2 PRE-schedule failure (wrong owner): resume writers + re-arm poller, NO close, NO relaunch ──
await (async () => {
  const { deps, order } = fakeDeps({ invoke: async () => { throw new Error('OWNER auth failed'); } });
  let threw = false;
  try { await prepareAndScheduleRestore(buildRestoreOrchestrationOps(PARAMS, deps)); }
  catch (e) { threw = true; ok(/OWNER/.test(String((e as Error).message)), 'the schedule error propagates'); }
  ok(threw, 'a schedule failure rejects');
  ok(order.includes('resumeAutoSync') && order.includes('armMobileDrainPoller'), 'writers resumed + poller re-armed (graceful)');
  ok(!order.includes('flushAndCloseFrontendDb') && !order.includes('relaunch'), 'frontend DB NOT closed and NO relaunch on a wrong-owner attempt');
  ok(order[order.length - 1] === 'status:error', 'error status surfaced');
})();

// ── §3 idle-await fails before schedule: no invoke, resume, no relaunch ──
await (async () => {
  const { deps, order, invokes } = fakeDeps({ waitForSyncIdle: async () => { throw new Error('idle timeout'); } });
  let threw = false;
  try { await prepareAndScheduleRestore(buildRestoreOrchestrationOps(PARAMS, deps)); } catch { threw = true; }
  ok(threw && invokes.length === 0 && !order.includes('relaunch'), 'idle failure blocks the schedule + relaunch entirely');
  ok(order.includes('resumeAutoSync'), 'writers resumed on an idle-await failure');
})();

// ── §4 POST-schedule failure (flush): fail-closed — scheduled, NO resume, NO relaunch ──
await (async () => {
  const { deps, order, invokes } = fakeDeps({ flushAndCloseFrontendDb: async () => { throw new Error('flush failed'); } });
  let threw = false;
  try { await prepareAndScheduleRestore(buildRestoreOrchestrationOps(PARAMS, deps)); } catch { threw = true; }
  ok(threw && invokes.length === 1, 'the restore was scheduled before the flush failure');
  ok(!order.includes('resumeAutoSync') && !order.includes('relaunch'), 'fail-closed once scheduled: no resume, no relaunch');
})();

console.log(`\nMOBILE-04B2A12-U1 restore-wiring: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
