// POST-RELEASE-SERVER — bounded primary auto-start retry + visible failure surfacing.
// Drives the REAL runLanStartup with injected ops (headless, no Tauri). Proves: success ends the
// cycle immediately; a transient AddrInUse is retried up to the cap; a permanent error is NOT
// retried; on ultimate failure the role stays 'primary' and the failure is surfaced exactly once.
// Run: node test/post-release-server/autostart-retry.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runLanStartup,
  AUTOSTART_MAX_ATTEMPTS,
  AUTOSTART_BACKOFF_MS,
  SERVER_ADDR_IN_USE_CODE,
  type LanStartupOps,
} from '../../src/core/sync/lan-startup.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

interface Spy extends LanStartupOps {
  started: number; sleeps: number[]; failures: string[]; inFlight: number; maxInFlight: number;
  setSyncCalls: number; syncStarted: number;
}
function ops(startServer: () => Promise<unknown>): Spy {
  const s: Spy = {
    started: 0, sleeps: [], failures: [], inFlight: 0, maxInFlight: 0, setSyncCalls: 0, syncStarted: 0,
    startServer: async () => { s.inFlight++; s.maxInFlight = Math.max(s.maxInFlight, s.inFlight); s.started++; try { return await startServer(); } finally { s.inFlight--; } },
    serverStatus: async () => ({ url: 'http://192.168.1.5:3001', selfToken: 'tok' }),
    discover: async () => [],
    currentSyncUrl: () => '',
    setSync: () => { s.setSyncCalls++; },
    startSync: () => { s.syncStarted++; },
    reportAutostartFailure: (code: string) => { s.failures.push(code); },
    sleep: async (ms: number) => { s.sleeps.push(ms); },   // no real delay in tests
  };
  return s;
}
const inUse = () => Object.assign(new Error(`invoke error: ${SERVER_ADDR_IN_USE_CODE}`), {});

(async () => {
  // 1) success first try → exactly one attempt, no retry, no failure, sync wired
  {
    const o = ops(async () => {});
    const r = await runLanStartup('primary', o);
    check(r === 'primary' && o.started === 1, '1: success → single attempt');
    check(o.sleeps.length === 0 && o.failures.length === 0, '2: success → no backoff, no failure surfaced');
    check(o.setSyncCalls === 1 && o.syncStarted === 1, '3: success → self-token sync wired');
  }

  // 2) transient AddrInUse once, then success → retried, recovered, no failure
  {
    let n = 0;
    const o = ops(async () => { if (n++ === 0) throw inUse(); });
    const r = await runLanStartup('primary', o);
    check(r === 'primary' && o.started === 2, '4: transient then success → exactly one retry');
    check(o.sleeps.length === 1 && o.sleeps[0] === AUTOSTART_BACKOFF_MS[0], '5: one named backoff before the retry');
    check(o.failures.length === 0 && o.setSyncCalls === 1, '6: recovered → no failure surfaced, sync wired');
  }

  // 3) transient AddrInUse always → capped attempts, failure surfaced once, role kept, no sync
  {
    const o = ops(async () => { throw inUse(); });
    const r = await runLanStartup('primary', o);
    check(r === 'primary', '7: exhausted retries → role stays primary (no silent demote)');
    check(o.started === AUTOSTART_MAX_ATTEMPTS, '8: attempts capped at AUTOSTART_MAX_ATTEMPTS');
    check(o.sleeps.length === AUTOSTART_MAX_ATTEMPTS - 1, '9: exactly one backoff per retry gap');
    check(o.failures.length === 1 && o.failures[0] === SERVER_ADDR_IN_USE_CODE, '10: failure surfaced exactly once with the transient code');
    check(o.setSyncCalls === 0 && o.syncStarted === 0, '11: failed start → nothing synced');
    check(o.maxInFlight === 1, '12: never a parallel startServer (sequential cycle)');
  }

  // 4) permanent (non-transient) error → NOT retried, surfaced with generic code
  {
    const o = ops(async () => { throw new Error('OWNER_PROVISIONING_REQUIRED'); });
    const r = await runLanStartup('primary', o);
    check(r === 'primary' && o.started === 1, '13: permanent error → single attempt, not blindly retried');
    check(o.sleeps.length === 0, '14: permanent error → no backoff');
    check(o.failures.length === 1 && o.failures[0] === 'SYNC_SERVER_START_FAILED', '15: permanent error surfaced with generic code');
  }

  // 5) source guards
  {
    const src = readFileSync(fileURLToPath(new URL('../../src/core/sync/lan-startup.ts', import.meta.url)), 'utf8');
    check(AUTOSTART_MAX_ATTEMPTS === 3, '16: max attempts capped at 3');
    check(/AUTOSTART_MAX_ATTEMPTS\s*=\s*3/.test(src), '17: cap is a named constant');
    check(/isTransientBindConflict/.test(src) && src.includes(SERVER_ADDR_IN_USE_CODE), '18: retry gated on the structured transient code, not an OS string');
  }

  if (fail.length) { console.error('POST-RELEASE-SERVER: FAILURES:'); for (const f of fail) console.error('  x ' + f); process.exit(1); }
  console.log(`POST-RELEASE-SERVER autostart-retry: ${pass}/${pass} checks passed`);
})();
