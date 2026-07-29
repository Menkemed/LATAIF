// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A13 — scope-bound, bounded-interval, single-flight poller over the EXISTING drain trigger.
//
// The mobile drain worker processes the inbox ONLY on an explicit trigger (post-auth / lifecycle
// resume). A job that ARRIVES AFTER the desktop already logged in therefore waits for the next trigger.
// This poller shortens that wait: on a fixed bounded interval it re-fires the SAME scope-gated trigger.
//
// It builds NO new worker and NO new write path. Every tick delegates to `triggerMobileUploadDrainSafe`
// (via the injected `triggerDrain`), which reads FRESH Rust evidence, fences on the binding revision,
// mints/reuses the revision-keyed worker, single-flights its own pass, and claims → null on an empty
// inbox — so exactly-once / fence / idempotency are entirely unchanged. The poller only changes WHEN the
// existing trigger runs, never WHAT it does.
//
// I2 CORRECTION — the timer is BOUND to an authorized scope key `tenant:branch:revision` and armed ONLY
// when the desktop is authenticated AND fresh evidence reports `configured=true` AND the binding matches
// the active scope (`computeScopeKey` → non-null). Consequences:
//   • without a binding/auth there is NO timer at all (not merely a no-op tick) — `armDrainPoller` refuses
//     to arm and stops any running timer,
//   • a configure (owner binds a scope) arms EXACTLY ONE timer; a repeated arm for the SAME key is a
//     no-op (no duplicate timer),
//   • a rebind (revision/scope change) arms a NEW key and stops the old timer — never two timers,
//   • each tick re-reads the key and SELF-DISARMS on any change (rebind / scope loss / logout) so the old
//     scope never ticks again; the underlying worker is independently fenced by its revision key,
//   • logout calls `stopDrainPoller`; shutdown/reload clear the timer via JS-context teardown (process
//     exit / context reload) — a drain interrupted by shutdown is re-processed safely on the next start
//     via the existing exactly-once receipts, so no explicit close hook is needed,
//   • a thrown read is swallowed (the timer stays armed for the next bounded tick) — never an aggressive
//     retry loop; only a resolved not-armable state (null key) disarms.
//
// Pure and framework-free: all environment access (timers, the scope-key computation, the trigger) is
// injected, so the whole lifecycle is unit-testable under node.
// ════════════════════════════════════════════════════════════════════════════

export interface DrainPollerDeps {
  /** Fixed bounded interval between ticks (ms). Not adaptive, never backed off tighter on error. */
  intervalMs: number;
  /** Register a repeating timer; returns an opaque handle. Injected so tests use a fake clock. */
  setIntervalFn: (fn: () => void, ms: number) => unknown;
  /** Clear a handle from `setIntervalFn`. */
  clearIntervalFn: (handle: unknown) => void;
  /**
   * ONE FRESH computation of the authorized scope key: `${tenant}:${branch}:${revision}` when the
   * desktop is authenticated AND evidence reports `configured=true` AND it matches the active scope;
   * otherwise `null` (not armable). The read is fresh — never a cached revision.
   */
  computeScopeKey: () => Promise<string | null>;
  /** Delegate: fire the EXISTING scope-gated drain trigger (fire-and-forget). */
  triggerDrain: () => void;
}

export type ArmResult = 'armed' | 'rearmed' | 'stopped' | 'unchanged';
export type PollTickResult = 'skipped' | 'disarmed' | 'triggered' | 'blocked';

// Module-scoped single live poller, BOUND to one authorized scope key. `ticking` guards tick overlap.
let current: { scopeKey: string; handle: unknown } | null = null;
let ticking = false;

/** Whether a timer is currently registered. */
export function isDrainPollerRunning(): boolean {
  return current !== null;
}

/** The scope key the live timer is bound to (or null when not running). */
export function currentPollerScopeKey(): string | null {
  return current ? current.scopeKey : null;
}

function stopInternal(deps: Pick<DrainPollerDeps, 'clearIntervalFn'>): void {
  if (current === null) return;
  deps.clearIntervalFn(current.handle);
  current = null;
  ticking = false;
}

/**
 * Arm (or re-arm) the poller for the CURRENT authorized scope. Reads the scope key FRESH:
 *   • null (no auth / not configured / mismatch)      → ensure stopped, NO timer,
 *   • same key as the running timer                    → no-op (no duplicate timer),
 *   • a different key (rebind) or no timer yet         → stop any old timer, arm exactly one new timer.
 * Safe under concurrent calls: there is a single `await`, and everything after it is synchronous, so
 * the first call wins and a second call for the same key sees it and no-ops.
 */
export async function armDrainPoller(deps: DrainPollerDeps): Promise<ArmResult> {
  const key = await deps.computeScopeKey();
  if (key === null) {
    if (current !== null) { stopInternal(deps); return 'stopped'; }
    return 'unchanged';                                   // never armable, nothing running → no timer
  }
  if (current !== null && current.scopeKey === key) return 'unchanged'; // exactly-once for this scope
  const hadTimer = current !== null;
  if (current !== null) stopInternal(deps);               // rebind → replace, never two timers
  current = { scopeKey: key, handle: deps.setIntervalFn(() => { void pollTick(deps, key); }, deps.intervalMs) };
  return hadTimer ? 'rearmed' : 'armed';
}

/** Stop the poller (logout / shutdown). Idempotent. */
export function stopDrainPoller(deps: Pick<DrainPollerDeps, 'clearIntervalFn'>): void {
  stopInternal(deps);
}

/**
 * One bounded tick bound to `boundKey`. Single-flight (a tick still gating skips the next). Re-reads the
 * scope key: if it changed (rebind / scope loss / logout) the timer SELF-DISARMS and does NOT trigger —
 * the old scope never ticks again. Otherwise it delegates to the existing trigger. A thrown read keeps
 * the timer armed (→ 'blocked'); never throws.
 */
export async function pollTick(deps: DrainPollerDeps, boundKey: string): Promise<PollTickResult> {
  if (ticking) return 'skipped';           // no overlapping ticks
  ticking = true;
  try {
    const key = await deps.computeScopeKey();
    if (key !== boundKey) { stopInternal(deps); return 'disarmed'; } // scope changed → stop the old timer
    deps.triggerDrain();                                             // delegate; revision/scope fence lives there
    return 'triggered';
  } catch {
    return 'blocked';                                                // transient read error → stay armed
  } finally {
    ticking = false;
  }
}
