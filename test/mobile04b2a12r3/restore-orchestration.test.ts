// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04B2A12-R3 — restore lifecycle orchestration (pure)
// Run: node test/mobile04b2a12r3/restore-orchestration.test.ts
//
// Proves the safe order (block writes → await idle → flush+close frontend DB → checkpoint+close server
// DB → restore → restart) and the failure contract (on any failure the writers stay blocked, the app is
// NOT restarted, and a clean error surfaces — never an auto-continue on a possibly mixed state).
// ════════════════════════════════════════════════════════════════════════════

import { prepareAndRestore, type RestoreOrchestrationOps } from '../../src/core/lifecycle/restore-orchestration.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } };

function recorder(overrides: Partial<Record<keyof RestoreOrchestrationOps, () => void | Promise<void>>> = {}) {
  const order: string[] = [];
  const step = (name: string) => async () => { order.push(name); const o = overrides[name as keyof RestoreOrchestrationOps]; if (o) await o(); };
  const ops: RestoreOrchestrationOps = {
    setStatus: (s) => order.push('status:' + (s ? s.kind : 'null')),
    blockWrites: () => { order.push('blockWrites'); },
    awaitWritersIdle: step('awaitWritersIdle'),
    flushAndCloseFrontendDb: step('flushAndCloseFrontendDb'),
    checkpointAndCloseServerDb: step('checkpointAndCloseServerDb'),
    runRestore: step('runRestore'),
    restartApplication: step('restartApplication'),
  };
  return { ops, order };
}

// ── §1 happy path: exact safe order, restart last ──
await (async () => {
  const { ops, order } = recorder();
  await prepareAndRestore(ops);
  ok(order.join(',') === 'status:restoring,blockWrites,awaitWritersIdle,flushAndCloseFrontendDb,checkpointAndCloseServerDb,runRestore,restartApplication', 'exact safe order with restart last: ' + order.join(','));
  ok(order.indexOf('blockWrites') < order.indexOf('awaitWritersIdle'), 'writes blocked BEFORE awaiting idle');
  ok(order.indexOf('flushAndCloseFrontendDb') < order.indexOf('runRestore') && order.indexOf('checkpointAndCloseServerDb') < order.indexOf('runRestore'), 'both DBs flushed/closed BEFORE the restore');
})();

// ── §2 failure during restore: writers stay blocked, NO restart, error surfaced ──
await (async () => {
  const { ops, order } = recorder({ runRestore: () => { throw new Error('MEDIA_FILE_HASH_MISMATCH'); } });
  let threw = false; try { await prepareAndRestore(ops); } catch (e) { threw = true; ok(/HASH_MISMATCH/.test(String((e as Error).message)), 'the clean restore error propagates'); }
  ok(threw, 'a restore failure rejects');
  ok(order.includes('blockWrites') && !order.includes('restartApplication'), 'writes stayed blocked and the app was NOT restarted on failure');
  ok(order[order.length - 1] === 'status:error', 'a surfaced error status is set (no resume, no auto-continue)');
})();

// ── §3 failure while awaiting idle: restore never runs, no restart ──
await (async () => {
  const { ops, order } = recorder({ awaitWritersIdle: () => { throw new Error('idle timeout'); } });
  let threw = false; try { await prepareAndRestore(ops); } catch { threw = true; }
  ok(threw && !order.includes('runRestore') && !order.includes('restartApplication'), 'idle failure blocks the restore + restart entirely');
  ok(order.includes('blockWrites'), 'writes were blocked first even when idle-await fails');
})();

console.log(`\nMEDIA-04B2A12-R3 restore-orchestration: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
