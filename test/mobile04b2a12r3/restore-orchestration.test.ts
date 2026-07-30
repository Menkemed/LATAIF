// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04B2A12-R3/U2 — restore lifecycle orchestration (pure, two-phase).
// Run: node test/mobile04b2a12r3/restore-orchestration.test.ts
//
// Proves the safe order (block writes → await idle → SCHEDULE (authorize + intent) → flush+close frontend
// DB → relaunch) and the two failure contracts:
//   • a PRE-schedule failure (wrong owner / idle timeout) RESUMES writers — nothing mutated, app usable,
//     and it never relaunches;
//   • a POST-schedule failure (flush/relaunch) is FAIL-CLOSED — no resume, no relaunch — the durable intent
//     reconciles at the next boot.
// ════════════════════════════════════════════════════════════════════════════

import { prepareAndScheduleRestore, type RestoreOrchestrationOps } from '../../src/core/lifecycle/restore-orchestration.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } };

function recorder(overrides: Partial<Record<keyof RestoreOrchestrationOps, () => void | Promise<void>>> = {}) {
  const order: string[] = [];
  const step = (name: string) => async () => { order.push(name); const o = overrides[name as keyof RestoreOrchestrationOps]; if (o) await o(); };
  const ops: RestoreOrchestrationOps = {
    setStatus: (s) => order.push('status:' + (s ? s.kind : 'null')),
    blockWrites: () => { order.push('blockWrites'); },
    awaitWritersIdle: step('awaitWritersIdle'),
    scheduleRestore: step('scheduleRestore'),
    flushAndCloseFrontendDb: step('flushAndCloseFrontendDb'),
    restartApplication: step('restartApplication'),
    resumeWrites: () => { order.push('resumeWrites'); },
  };
  return { ops, order };
}

// ── §1 happy path: exact safe order, schedule before flush, restart last ──
await (async () => {
  const { ops, order } = recorder();
  await prepareAndScheduleRestore(ops);
  ok(order.join(',') === 'status:scheduling,blockWrites,awaitWritersIdle,scheduleRestore,flushAndCloseFrontendDb,restartApplication', 'exact safe order: ' + order.join(','));
  ok(order.indexOf('scheduleRestore') < order.indexOf('flushAndCloseFrontendDb'), 'restore SCHEDULED before the frontend DB is closed');
  ok(order.indexOf('flushAndCloseFrontendDb') < order.indexOf('restartApplication'), 'DB closed before relaunch');
  ok(!order.includes('resumeWrites'), 'no resume on the happy path');
})();

// ── §2 PRE-schedule failure (wrong owner): resume writers, NO flush/close, NO relaunch ──
await (async () => {
  const { ops, order } = recorder({ scheduleRestore: () => { throw new Error('OWNER auth failed'); } });
  let threw = false; try { await prepareAndScheduleRestore(ops); } catch (e) { threw = true; ok(/OWNER/.test(String((e as Error).message)), 'the schedule error propagates'); }
  ok(threw, 'a schedule failure rejects');
  ok(order.includes('resumeWrites'), 'writers RESUMED (nothing scheduled → app stays usable)');
  ok(!order.includes('flushAndCloseFrontendDb') && !order.includes('restartApplication'), 'frontend DB NOT closed and app NOT relaunched on a pre-schedule failure');
  ok(order[order.length - 1] === 'status:error', 'error status surfaced');
})();

// ── §3 idle-await failure: never schedules, resumes, no relaunch ──
await (async () => {
  const { ops, order } = recorder({ awaitWritersIdle: () => { throw new Error('idle timeout'); } });
  let threw = false; try { await prepareAndScheduleRestore(ops); } catch { threw = true; }
  ok(threw && !order.includes('scheduleRestore') && !order.includes('restartApplication'), 'idle failure blocks schedule + relaunch');
  ok(order.includes('resumeWrites'), 'writers resumed on an idle-await failure');
})();

// ── §4 POST-schedule failure (flush/relaunch): FAIL-CLOSED — no resume, no relaunch ──
await (async () => {
  const { ops, order } = recorder({ flushAndCloseFrontendDb: () => { throw new Error('flush failed'); } });
  let threw = false; try { await prepareAndScheduleRestore(ops); } catch { threw = true; }
  ok(threw, 'a post-schedule failure rejects');
  ok(order.includes('scheduleRestore') && !order.includes('resumeWrites'), 'once scheduled, writers are NOT resumed (fail-closed) — the intent applies at next boot');
  ok(!order.includes('restartApplication'), 'no relaunch on a post-schedule failure');
  ok(order[order.length - 1] === 'status:error', 'error status surfaced (no auto-continue)');
})();

console.log(`\nMEDIA-04B2A12-R3/U2 restore-orchestration: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
