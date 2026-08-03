// POST-RELEASE-SHUTDOWN — coordinated relaunch state machine + timeout/rollback contracts (headless).
// Drives the REAL coordinatedRelaunch / withTimeout / approve flag with injected ops. Proves: happy
// path reaches restart-approved + relaunch + exactly-once intent; a failure/timeout BEFORE approval
// never relaunches, never spawns, clears a written intent, and resumes writes ONLY when writers are
// provably terminal; one cycle at a time; the approved flag gates the CloseRequested bypass.
// Run: node test/post-release-shutdown/relaunch-coordinator.test.ts
import {
  coordinatedRelaunch, withTimeout, isRelaunchApproved, approveRelaunch, relaunchPhase,
  RelaunchTimeoutError, stopServerThenApproveRelaunch, __resetRelaunchCoordinatorForTest as reset,
  type CoordinatedRelaunchOps,
} from '../../src/core/lifecycle/relaunch-coordinator.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };
const noop = async () => {};
function ops(over: Partial<CoordinatedRelaunchOps> = {}) {
  const s = { blocked: 0, idle: 0, flushed: 0, stopped: 0, persisted: 0, cleared: 0, resumed: 0, relaunched: 0, serverRestarted: 0 };
  const o: CoordinatedRelaunchOps = {
    blockWrites: () => { s.blocked++; },
    awaitWritersIdle: async () => { s.idle++; },
    flushDurably: async () => { s.flushed++; },
    stopServerConfirmFree: async () => { s.stopped++; },
    restartServer: async () => { s.serverRestarted++; },
    persistIntent: async () => { s.persisted++; return true; },
    clearIntent: async () => { s.cleared++; },
    resumeWrites: () => { s.resumed++; },
    relaunch: async () => { s.relaunched++; },
    ...over,
  };
  return { o, s };
}

(async () => {
  // 1) happy path → full sequence, approved, relaunch, intent once
  { reset(); const { o, s } = ops();
    await coordinatedRelaunch(o);
    check(s.blocked===1 && s.idle===1 && s.flushed===1 && s.stopped===1 && s.persisted===1 && s.relaunched===1, '1: happy path runs the full ordered sequence once');
    check(s.cleared===0 && s.resumed===0, '2: happy path does not clear intent or resume writes');
    check(relaunchPhase()==='restart-approved' && isRelaunchApproved(), '3: ends in restart-approved (CloseRequested bypass on)');
  }

  // 2) failure BEFORE idle resolves (awaitWritersIdle rejects) → abort, no relaunch, NO resume (writers not terminal), no intent
  { reset(); const { o, s } = ops({ awaitWritersIdle: async () => { throw new Error('sync stuck'); } });
    let threw = false; try { await coordinatedRelaunch(o); } catch { threw = true; }
    check(threw && s.relaunched===0, '4: writers-not-idle → aborts, NEVER relaunches');
    check(s.resumed===0, '5: writers not terminal → does NOT resume writes (keeps barrier — no multi-writer)');
    check(s.persisted===0 && s.cleared===0, '6: no intent written on pre-idle failure');
    check(relaunchPhase()==='failed' && !isRelaunchApproved(), '7: failed phase, not approved');
  }

  // 3) failure AFTER idle but before approval (stopServer fails) → abort, no relaunch, RESUME (writers terminal), no intent
  { reset(); const { o, s } = ops({ stopServerConfirmFree: async () => { throw new Error('listener still bound'); } });
    let threw = false; try { await coordinatedRelaunch(o); } catch { threw = true; }
    check(threw && s.relaunched===0, '8: server-stop failure → aborts, no relaunch');
    check(s.resumed===1, '9: writers terminal (idle resolved) → resumes writes on abort (app usable)');
    check(s.persisted===0, '10: intent NOT written when aborting before persist');
    check(s.serverRestarted===0, '10b: server was never (confirmed) stopped → not restarted');
  }

  // 3b) failure AFTER server stopped (persistIntent fails) → abort restarts the server (I1 §6)
  { reset(); const { o, s } = ops({ persistIntent: async () => { throw new Error('owner auth failed'); } });
    let threw = false; try { await coordinatedRelaunch(o); } catch { threw = true; }
    check(threw && s.relaunched===0, '10c: post-server-stop failure → aborts, no relaunch');
    check(s.stopped===1 && s.serverRestarted===1, '10d: an aborted relaunch that already stopped the server RESTARTS it (never leaves primary server down)');
    check(s.resumed===1, '10e: writes resumed on this terminal-writer abort');
  }

  // 4) failure AFTER intent persisted (relaunch throws) → clears the intent (no stray pending backup)
  { reset(); const { o, s } = ops({ relaunch: async () => { throw new Error('relaunch failed'); } });
    let threw = false; try { await coordinatedRelaunch(o); } catch { threw = true; }
    check(threw && s.persisted===1 && s.cleared===1, '11: post-intent failure clears the written intent (no double/stray backup)');
  }

  // 5) exactly one cycle at a time (re-entrant call is a no-op)
  { reset(); let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
    const { o, s } = ops({ awaitWritersIdle: () => gate });
    const first = coordinatedRelaunch(o);
    await coordinatedRelaunch(o);                 // second call while first in flight → immediate no-op
    check(s.blocked===1, '12: second concurrent relaunch is a no-op (one cycle at a time)');
    release(); await first;
    check(s.relaunched===1, '13: the single in-flight cycle completes normally');
  }

  // 6) withTimeout: rejects with RelaunchTimeoutError, resolves fast when quick
  { const fast = await withTimeout(Promise.resolve('ok'), 1000, 'flushing'); check(fast==='ok', '14: withTimeout passes a fast result through');
    let e: unknown = null; try { await withTimeout(new Promise(() => {}), 30, 'flushing'); } catch (x) { e = x; }
    check(e instanceof RelaunchTimeoutError, '15: withTimeout rejects with RelaunchTimeoutError on timeout');
  }

  // 7) approve flag gate
  { reset(); check(!isRelaunchApproved(), '16: not approved by default'); approveRelaunch(); check(isRelaunchApproved(), '17: approveRelaunch() sets the one-way bypass flag'); }

  // 8) source guard — App.tsx consults isRelaunchApproved synchronously before preventDefault
  {
    const { readFileSync } = await import('node:fs'); const { fileURLToPath } = await import('node:url');
    const app = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8');
    check(/if\s*\(isRelaunchApproved\(\)\)\s*return;/.test(app), '18: onCloseRequested returns early when a relaunch is approved');
    check(app.indexOf('isRelaunchApproved()') < app.indexOf('event.preventDefault()'), '19: the approved-check precedes preventDefault (checked synchronously)');
  }

  // 9) SHUTDOWN-FINAL — stopServerThenApproveRelaunch (the RESTORE/coordinated terminal tail)
  function stops(over: Partial<{ stop: () => Promise<void>; restart: () => Promise<void>; relaunch: () => Promise<void> }> = {}) {
    const s = { stopped: 0, restarted: 0, relaunched: 0, approved: 0 };
    const o = {
      stopServerConfirmFree: over.stop ?? (async () => { s.stopped++; }),
      restartServer: over.restart ?? (async () => { s.restarted++; }),
      relaunch: over.relaunch ?? (async () => { s.relaunched++; }),
      approve: () => { s.approved++; },
    };
    return { o, s };
  }
  // 9a) happy path → stop, approve, relaunch (no restart)
  { const { o, s } = stops();
    await stopServerThenApproveRelaunch(o);
    check(s.stopped===1 && s.approved===1 && s.relaunched===1 && s.restarted===0, '20: stop→approve→relaunch on the happy path');
  }
  // 9b) server-stop FAILS → restart server, NO approve, NO relaunch, rethrow (fail-closed, no 2nd process)
  { const { o, s } = stops({ stop: async () => { throw new Error('listener still bound'); } });
    let threw = false; try { await stopServerThenApproveRelaunch(o); } catch { threw = true; }
    check(threw && s.relaunched===0 && s.approved===0, '21: server-stop failure → NO approve, NO relaunch (no second process)');
    check(s.restarted===1, '22: server-stop failure restarts the server (never left server-down)');
  }
  // 9c) server-stop TIMES OUT (withTimeout) → same fail-closed shape
  { const { o, s } = stops({ stop: () => new Promise<void>(() => {}) });  // never resolves
    let e: unknown = null; try { await stopServerThenApproveRelaunch(o); } catch (x) { e = x; }
    check(e instanceof RelaunchTimeoutError && s.relaunched===0 && s.restarted===1, '23: a hanging server-stop times out → restart + fail-closed, never relaunches');
  }
  // 9d) uses approveRelaunch by default (real bypass flag) when no approve injected
  { reset(); const s = { relaunched: 0 };
    await stopServerThenApproveRelaunch({ stopServerConfirmFree: async () => {}, restartServer: async () => {}, relaunch: async () => { s.relaunched++; } });
    check(isRelaunchApproved() && s.relaunched===1, '24: default approve sets the real one-way bypass flag before relaunch');
  }

  if (fail.length) { console.error('POST-RELEASE-SHUTDOWN: FAILURES:'); for (const f of fail) console.error('  x ' + f); process.exit(1); }
  console.log(`POST-RELEASE-SHUTDOWN relaunch-coordinator: ${pass}/${pass} checks passed`);
})();
