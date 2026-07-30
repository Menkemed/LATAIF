// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04B2A12-R3 — restore lifecycle orchestration (pure, injectable).
//
// The safety ORDER for a live atomic restore, framework-free so it is headless-testable:
//
//   block new writes → await writers idle → flush+close frontend DB → checkpoint+close server DB
//   → run the atomic restore (host) → controlled app restart
//
// Unlike the close/reload flows, a restore NEVER resumes background writers on failure: an aborted or
// failed restore leaves the app in a blocked, surfaced-error state (no auto-continue with a possibly
// mixed state) until the user restarts — boot recovery then reconciles any journal. The atomic swap +
// crash-safe journal + boot recovery live in Rust; this only sequences the runtime quiescence.
// ════════════════════════════════════════════════════════════════════════════

export type RestoreStatus =
  | { kind: 'restoring' }
  | { kind: 'error'; message: string };

export interface RestoreOrchestrationOps {
  /** UI status (null = reset). */
  setStatus: (status: RestoreStatus | null) => void;
  /** Optional: a render/event-loop turn so the "restoring…" overlay paints before the blocking work. */
  yieldToRender?: () => Promise<void>;
  /** Block NEW writes immediately: pause auto-sync AND stop the mobile drain poller/worker triggers. */
  blockWrites: () => void;
  /** Await every in-flight writer (sync run + drain pass) to go idle. */
  awaitWritersIdle: () => Promise<void>;
  /** Durably flush the frontend DB and close its handle (no writer may hold it during the swap). */
  flushAndCloseFrontendDb: () => Promise<void>;
  /** WAL-checkpoint the server DB and close its handles. */
  checkpointAndCloseServerDb: () => Promise<void>;
  /** Run the atomic DB+media restore (the Rust host); throws with a clean code on any failure. */
  runRestore: () => Promise<void>;
  /** Controlled application restart — ONLY reached after a successful restore. */
  restartApplication: () => Promise<void>;
}

/**
 * Drive a live restore in the safe order. On ANY failure the writers/worker STAY blocked (never
 * resumed), a clean error is surfaced, and the app is NOT restarted — so it can never continue on a
 * half-swapped state. The error propagates to the caller.
 */
export async function prepareAndRestore(ops: RestoreOrchestrationOps): Promise<void> {
  ops.setStatus({ kind: 'restoring' });
  if (ops.yieldToRender) await ops.yieldToRender();
  ops.blockWrites(); // FIRST — no new writes from here on
  try {
    await ops.awaitWritersIdle();          // in-flight writers drain to idle
    await ops.flushAndCloseFrontendDb();    // frontend DB durable + closed
    await ops.checkpointAndCloseServerDb(); // server DB checkpointed + closed
    await ops.runRestore();                 // atomic swap (host) — crash-safe + rollback
    await ops.restartApplication();         // controlled restart ONLY on success
  } catch (err) {
    // Writers/worker remain blocked (no resume): never auto-continue on a possibly mixed state.
    ops.setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
