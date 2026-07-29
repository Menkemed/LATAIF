// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A13-I1/I2 — scope-bound drain poller lifecycle (pure)
// Run: node test/mobile04b2a13/drain-poller.test.ts
//
// Proves the START CONTRACT (a timer exists ONLY for an authorized, matching, configured scope — no
// binding → no timer), exactly-once arming, rebind-replaces-without-duplicate, self-disarm on scope
// change (rebind / loss / logout), single-flight ticks, a swallowed read (stay armed, never aggressive),
// and delegation to the existing trigger when the scope is unchanged.
// ════════════════════════════════════════════════════════════════════════════

import {
  armDrainPoller, stopDrainPoller, pollTick, isDrainPollerRunning, currentPollerScopeKey,
  type DrainPollerDeps,
} from '../../src/core/media/mobile-drain-poller.ts';

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

function makeClock() {
  let nextId = 1; const timers = new Map<number, () => void>();
  const setCalls: Array<{ id: number; ms: number }> = []; const clearCalls: number[] = [];
  return {
    setIntervalFn: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, fn); setCalls.push({ id, ms }); return id; },
    clearIntervalFn: (h: unknown) => { clearCalls.push(h as number); timers.delete(h as number); },
    fire: (id: number) => { const f = timers.get(id); if (f) f(); },
    setCalls, clearCalls, liveCount: () => timers.size,
  };
}
function deps(clock: ReturnType<typeof makeClock>, over: Partial<DrainPollerDeps> = {}): DrainPollerDeps {
  return {
    intervalMs: 15_000,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    computeScopeKey: async () => 't1:b1:1',   // default: authorized, configured, matching
    triggerDrain: () => {},
    ...over,
  };
}
const reset = (clock: ReturnType<typeof makeClock>) => stopDrainPoller(deps(clock));

// ── §1 START CONTRACT: no binding/auth (key=null) → NO timer at all ──────────
await (async () => {
  const clock = makeClock();
  const r = await armDrainPoller(deps(clock, { computeScopeKey: async () => null }));
  ok(r === 'unchanged', 'arm without a matching configured binding → unchanged');
  ok(clock.setCalls.length === 0 && isDrainPollerRunning() === false, 'no binding → NO timer registered');
  reset(clock);
})();

// ── §2 configure → EXACTLY ONE timer; re-arm same scope → no duplicate ───────
await (async () => {
  const clock = makeClock();
  ok(await armDrainPoller(deps(clock)) === 'armed', 'configured+matching scope → armed');
  ok(clock.setCalls.length === 1 && clock.setCalls[0].ms === 15_000, 'configure registers exactly one bounded timer');
  ok(currentPollerScopeKey() === 't1:b1:1', 'timer bound to tenant:branch:revision');
  ok(await armDrainPoller(deps(clock)) === 'unchanged', 're-arm for the SAME scope → unchanged');
  ok(await armDrainPoller(deps(clock)) === 'unchanged', 'repeated arm still unchanged');
  ok(clock.setCalls.length === 1 && clock.liveCount() === 1, 'no duplicate timer for the same scope');
  reset(clock);
})();

// ── §3 rebind (key changes) → replaces WITHOUT a double timer ────────────────
await (async () => {
  const clock = makeClock();
  await armDrainPoller(deps(clock, { computeScopeKey: async () => 't1:b1:1' }));
  const r = await armDrainPoller(deps(clock, { computeScopeKey: async () => 't1:b1:2' })); // revision bump
  ok(r === 'rearmed', 'rebind (new revision) → rearmed');
  ok(clock.setCalls.length === 2 && clock.clearCalls.length === 1 && clock.liveCount() === 1, 'rebind stops the old timer and arms one new — never two');
  ok(currentPollerScopeKey() === 't1:b1:2', 'timer now bound to the new revision');
  reset(clock);
})();

// ── §4 scope loss on arm (key→null) while running → stopped ──────────────────
await (async () => {
  const clock = makeClock();
  await armDrainPoller(deps(clock));
  const r = await armDrainPoller(deps(clock, { computeScopeKey: async () => null }));
  ok(r === 'stopped' && !isDrainPollerRunning() && clock.liveCount() === 0, 'scope loss → timer stopped');
  reset(clock);
})();

// ── §5 logout / shutdown: stopDrainPoller clears the timer ───────────────────
await (async () => {
  const clock = makeClock();
  await armDrainPoller(deps(clock));
  stopDrainPoller(deps(clock));
  ok(!isDrainPollerRunning() && clock.clearCalls.length === 1, 'stop (logout/shutdown) clears the timer');
})();

// ── §6 tick with UNCHANGED scope → delegates to the trigger (single-flight) ──
await (async () => {
  let fired = 0; const clock = makeClock();
  const d = deps(clock, { triggerDrain: () => { fired++; } });
  await armDrainPoller(d);
  ok(await pollTick(d, 't1:b1:1') === 'triggered', 'tick with the bound scope → triggered');
  ok(fired === 1, 'delegates to the existing trigger exactly once (empty inbox stays cheap in the trigger)');
  reset(clock);
})();

// ── §7 single-flight: an overlapping tick is skipped ─────────────────────────
await (async () => {
  let release!: () => void; let fired = 0;
  const gate = new Promise<void>((r) => { release = r; });
  const clock = makeClock();
  const d = deps(clock, { computeScopeKey: async () => { await gate; return 't1:b1:1'; }, triggerDrain: () => { fired++; } });
  await armDrainPoller(deps(clock));               // arm with a fast key first
  const first = pollTick(d, 't1:b1:1');            // enters, awaits the gate
  const second = await pollTick(d, 't1:b1:1');     // overlapping → skipped
  ok(second === 'skipped', 'an overlapping tick is skipped (no overlap)');
  release();
  ok(await first === 'triggered' && fired === 1, 'the in-flight tick completes with exactly one trigger');
  reset(clock);
})();

// ── §8 tick with CHANGED scope (rebind/loss/logout) → self-disarm, no trigger ─
await (async () => {
  let fired = 0; const clock = makeClock();
  const d = deps(clock, { computeScopeKey: async () => 't1:b1:2', triggerDrain: () => { fired++; } });
  await armDrainPoller(deps(clock, { computeScopeKey: async () => 't1:b1:1' })); // armed for rev 1
  const r = await pollTick(d, 't1:b1:1');          // fresh key is now rev 2 (rebind)
  ok(r === 'disarmed', 'a tick whose scope changed → disarmed');
  ok(fired === 0 && !isDrainPollerRunning() && clock.clearCalls.length === 1, 'old scope stops ticking and never triggers');
  reset(clock);
})();

// ── §9 a thrown read is swallowed → blocked, STAYS armed (no aggressive retry) ─
await (async () => {
  let fired = 0; const clock = makeClock();
  const d = deps(clock, { computeScopeKey: async () => { throw new Error('boom'); }, triggerDrain: () => { fired++; } });
  await armDrainPoller(deps(clock));               // armed (fast key)
  const r = await pollTick(d, 't1:b1:1');
  ok(r === 'blocked' && fired === 0, 'a thrown read → blocked, no trigger');
  ok(isDrainPollerRunning() === true, 'a transient read error keeps the timer armed (not torn down)');
  reset(clock);
})();

// ── §10 a fired timer tick delegates when the scope is unchanged ─────────────
await (async () => {
  let fired = 0; const clock = makeClock();
  await armDrainPoller(deps(clock, { triggerDrain: () => { fired++; } }));
  clock.fire(clock.setCalls[clock.setCalls.length - 1].id);
  await new Promise((r) => setTimeout(r, 0));
  ok(fired === 1, 'a fired timer tick delegates to the trigger when gated open');
  reset(clock);
})();

console.log(`\nMOBILE-04B2A13 drain-poller: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
