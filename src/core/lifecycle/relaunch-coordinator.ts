// ════════════════════════════════════════════════════════════════════════════
// POST-RELEASE-SHUTDOWN — coordinated relaunch state machine + CloseRequested re-entry guard.
//
// Root cause of the live duplicate instance (tauri 2.10.3 + plugin-process 2.3.1, source-proven):
//   plugin-process `relaunch()` → `app.request_restart()` → `request_exit(RESTART_EXIT_CODE)`.
//   The window's `CloseRequested` fires; App.tsx's `onCloseRequested` `preventDefault()`s and runs the
//   FULL controlled close (`prepareAndCloseApplication` → `waitForSyncIdle` which has no timeout).
//   If that re-entrant close hangs, the old process never reaches `RuntimeRunEvent::Exit`, so the
//   single-instance mutex is never released and `process::restart` never spawns the replacement — the
//   old process lingers (holding the LAN port), and any replacement that IS spawned races it.
//
// The single-instance mutex handoff itself is SOUND: tauri's run loop releases the plugin's mutex in
// the `RunEvent::Exit` callback BEFORE calling `process::restart` (spawn), so the replacement's
// `CreateMutexW` succeeds. The ONLY thing needed is to let `relaunch()` actually REACH `RunEvent::Exit`
// — i.e. the `CloseRequested` triggered by an APPROVED relaunch must pass straight through instead of
// re-running the controlled close.
//
// This module owns a small state machine driving the coordinated relaunch and a one-way "approved"
// flag that `onCloseRequested` consults to distinguish an approved programmatic relaunch (pass the
// close through) from a user window-X close (run the controlled shutdown).
// ════════════════════════════════════════════════════════════════════════════

export type RelaunchPhase =
  | 'idle'
  | 'preparing'
  | 'flushing'
  | 'stopping-server'
  | 'intent-persisted'
  | 'restart-approved'
  | 'failed';

let phase: RelaunchPhase = 'idle';
let inFlight = false;

export function relaunchPhase(): RelaunchPhase { return phase; }

/**
 * Once a relaunch is APPROVED the CloseRequested handler must let the window close proceed (no
 * preventDefault, no second controlled shutdown). One-way: an approved relaunch is committed — the
 * process is on its way out via `process::restart`.
 */
export function isRelaunchApproved(): boolean { return phase === 'restart-approved'; }

/** Named, bounded wait so no unbounded promise sits on the relaunch path. */
export const SYNC_IDLE_TIMEOUT_MS = 8000;
export const FLUSH_TIMEOUT_MS = 15000;
export const SERVER_STOP_CONFIRM_TIMEOUT_MS = 6000;

export class RelaunchTimeoutError extends Error {
  readonly stage: RelaunchPhase;
  constructor(stage: RelaunchPhase, ms: number) {
    super(`Relaunch aborted: '${stage}' did not complete within ${ms} ms.`);
    this.name = 'RelaunchTimeoutError';
    this.stage = stage;
  }
}

/**
 * Await `p`, but reject with RelaunchTimeoutError after `ms`. IMPORTANT: this does NOT cancel `p` — the
 * caller MUST treat a timeout as "the underlying operation may still be running" and therefore ABORT the
 * relaunch WITHOUT unblocking writes or spawning a process. It never lets a still-running writer be
 * followed by a relaunch (that is the multi-writer hazard the whole slice exists to prevent).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, stage: RelaunchPhase): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; reject(new RelaunchTimeoutError(stage, ms)); } }, ms);
    p.then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(t); reject(e); } },
    );
  });
}

export interface CoordinatedRelaunchOps {
  /** Block NEW writes (pause auto-sync + stop mobile drain). Reversible until intent is persisted. */
  blockWrites: () => void;
  /** Await every in-flight writer to reach a terminal state. Bounded by SYNC_IDLE_TIMEOUT_MS. */
  awaitWritersIdle: () => Promise<void>;
  /** Durable frontend-DB flush; MUST resolve only after the on-disk copy is committed. */
  flushDurably: () => Promise<void>;
  /** Stop the LAN server and CONFIRM the listener is released (Rust). Bounded. */
  stopServerConfirmFree: () => Promise<void>;
  /** Best-effort restart of the LAN server on a PRE-approval abort AFTER it was stopped, so an
   *  aborted relaunch never leaves a primary with its server down (I1 §6). Errors are swallowed. */
  restartServer?: () => Promise<void>;
  /** Persist the boot intent (backup) exactly-once, or a no-op for a plain relaunch. Returns whether an
   *  intent was written (so a later abort can clear it). */
  persistIntent: () => Promise<boolean>;
  /** Remove a previously-persisted boot intent (abort rollback). */
  clearIntent: () => Promise<void>;
  /** Re-enable writes after a PRE-approval abort (only when nothing is durably scheduled). */
  resumeWrites: () => void;
  /** The actual Tauri process relaunch. Called ONLY in 'restart-approved'. */
  relaunch: () => Promise<void>;
  /** Optional UI status. */
  setPhase?: (p: RelaunchPhase) => void;
}

function set(p: RelaunchPhase, ops: CoordinatedRelaunchOps) { phase = p; ops.setPhase?.(p); }

/**
 * Drive the coordinated relaunch. Ordering (single cycle at a time):
 *   preparing → block writes → flushing → durable flush → stopping-server → confirm listener free →
 *   intent-persisted (exactly-once) → restart-approved → relaunch().
 *
 * A failure BEFORE 'restart-approved' aborts cleanly: no relaunch, no second process, any written
 * intent removed, writes resumed only after a terminal writer state, visible error, app stays usable.
 * A timeout is treated as "operation may still be running" → abort (never unblock-and-continue).
 */
export async function coordinatedRelaunch(ops: CoordinatedRelaunchOps): Promise<void> {
  if (inFlight) return;                 // exactly one shutdown/relaunch cycle at a time
  inFlight = true;
  let intentWritten = false;
  let writersTerminal = false;
  let serverStopped = false;
  try {
    set('preparing', ops);
    ops.blockWrites();
    set('flushing', ops);
    // Bounded wait for writers. On timeout we do NOT know they finished → abort without resuming.
    await withTimeout(ops.awaitWritersIdle(), SYNC_IDLE_TIMEOUT_MS, 'flushing');
    writersTerminal = true;             // idle resolved → writers are terminal, safe to resume on abort
    await withTimeout(ops.flushDurably(), FLUSH_TIMEOUT_MS, 'flushing');
    set('stopping-server', ops);
    await withTimeout(ops.stopServerConfirmFree(), SERVER_STOP_CONFIRM_TIMEOUT_MS, 'stopping-server');
    serverStopped = true;              // the LAN server is now stopped + the port confirmed free
    intentWritten = await ops.persistIntent();
    set('intent-persisted', ops);
    // COMMIT POINT: from here the relaunch is approved and the process is on its way out.
    set('restart-approved', ops);
    await ops.relaunch();               // request_restart → CloseRequested passes through (approved)
    // relaunch() normally never resolves (process exits). If it does, keep the approved state.
  } catch (err) {
    // Failure BEFORE approval → clean abort: no relaunch happened, no second process.
    set('failed', ops);
    if (intentWritten) { try { await ops.clearIntent(); } catch { /* leave for boot reconcile */ } }
    // I1 §6 — if we already stopped the server, bring it back so an aborted relaunch never leaves a
    // primary with its LAN server down. Best-effort; a failure here does not mask the original error.
    if (serverStopped) { try { await ops.restartServer?.(); } catch { /* user can Start as Server */ } }
    // Resume writes ONLY when writers are provably terminal (idle resolved). If we timed out waiting
    // for idle, a writer may still run → do NOT resume (keep the barrier); the app stays blocked but
    // consistent, and the user retries.
    if (writersTerminal) ops.resumeWrites();
    throw err;
  } finally {
    inFlight = false;
  }
}

/**
 * Approve a relaunch driven by a caller that owns its own durable shutdown (e.g. the UPDATER, which
 * already flushed durably in `prepareAndInstallUpdate` before download/install). Sets the one-way
 * approved flag so the request_restart-triggered CloseRequested passes through App.tsx's handler
 * (no re-entrant controlled close → no hang → the process reaches Exit → mutex released → replacement
 * starts). Call IMMEDIATELY before `relaunch()`.
 */
export function approveRelaunch(): void { phase = 'restart-approved'; }

export interface ServerStopRelaunchOps {
  /** Stop the LAN server and CONFIRM the listener is released (Rust). Bounded. */
  stopServerConfirmFree: () => Promise<void>;
  /** Bring the LAN server back if the stop/confirm fails, so a primary is never left server-down. */
  restartServer: () => Promise<void>;
  /** The actual Tauri process relaunch. Called ONLY after the server is confirmed free + approved. */
  relaunch: () => Promise<void>;
  /** Injection seam for tests; defaults to `approveRelaunch`. */
  approve?: () => void;
}

/**
 * Coordinated terminal relaunch for a caller that has ALREADY durably scheduled its boot work (the RESTORE
 * path: the owner is authorized and the restore intent is written before this runs). Steps:
 *   1. stop the LAN server and CONFIRM the port is free (bounded) — a relaunch while the old listener still
 *      lingers is exactly what left port 3001 in CloseWait and made the replacement fail to bind,
 *   2. mark the relaunch APPROVED so the request_restart-triggered CloseRequested passes straight through
 *      App.tsx (no re-entrant controlled close → no hang → the process reaches RuntimeRunEvent::Exit → the
 *      single-instance mutex is released → the replacement binds the freed port),
 *   3. relaunch.
 * If the port cannot be confirmed free, DO NOT relaunch (a lingering socket would race the replacement):
 * restart the server so the primary is never left server-down, then rethrow so the caller stays fail-closed
 * (its durable intent applies on the next manual boot). NO second process is ever spawned on this path.
 */
export async function stopServerThenApproveRelaunch(ops: ServerStopRelaunchOps): Promise<void> {
  try {
    await withTimeout(ops.stopServerConfirmFree(), SERVER_STOP_CONFIRM_TIMEOUT_MS, 'stopping-server');
  } catch (err) {
    try { await ops.restartServer(); } catch { /* best-effort; user can Start as Server */ }
    throw err; // fail-closed: no approve, no relaunch, no second process
  }
  (ops.approve ?? approveRelaunch)();
  await ops.relaunch();
}

/** Test-only: reset the module state between headless cases. */
export function __resetRelaunchCoordinatorForTest(): void { phase = 'idle'; inFlight = false; }
