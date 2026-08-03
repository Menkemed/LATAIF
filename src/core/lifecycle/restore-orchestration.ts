// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04B2A12-R3/U2 — restore lifecycle orchestration (pure, injectable).
//
// The restore is applied at BOOT, not in-process. This sequences the runtime so a live restore is safe:
//
//   block new writes → await writers idle → SCHEDULE the restore (authorize + durable intent)
//   → flush + close the frontend DB → controlled relaunch  (the boot path applies the swap, DBs closed)
//
// Two phases with different failure contracts:
//   • Phase 1 (quiesce + authorize + schedule) is REVERSIBLE — nothing is mutated. A failure here (wrong
//     owner, invalid/foreign snapshot, idle timeout) RESUMES writers and leaves the app fully usable.
//   • Phase 2 (flush+close → relaunch) runs only AFTER the intent is durably scheduled. A failure here is
//     FAIL-CLOSED: no resume, no auto-continue — the pending restore reconciles at the next (manual) boot.
// The atomic swap + crash-safe journal + boot recovery live in Rust; this only sequences quiescence.
// ════════════════════════════════════════════════════════════════════════════

export type RestoreStatus =
  | { kind: 'scheduling' }
  | { kind: 'error'; message: string };

export interface RestoreOrchestrationOps {
  /** UI status (null = reset). */
  setStatus: (status: RestoreStatus | null) => void;
  /** Optional: a render/event-loop turn so the overlay paints before the blocking work. */
  yieldToRender?: () => Promise<void>;
  /** Block NEW writes immediately: pause auto-sync AND stop the mobile drain poller/worker triggers. */
  blockWrites: () => void;
  /** Await every in-flight writer (sync run + drain pass) to go idle. */
  awaitWritersIdle: () => Promise<void>;
  /** Authorize the owner + durably SCHEDULE the boot restore (write the intent). Reversible: no mutation. */
  scheduleRestore: () => Promise<void>;
  /** Durably flush the frontend DB and close its handle (after the intent is committed). */
  flushAndCloseFrontendDb: () => Promise<void>;
  /** Controlled application restart — reached ONLY after the intent is scheduled + the frontend DB closed. */
  restartApplication: () => Promise<void>;
  /** Undo `blockWrites` when a PRE-schedule step fails (nothing was scheduled → safe to resume). */
  resumeWrites: () => void;
  /** SHUTDOWN-FINAL — ROLLBACK a durably-scheduled restore when a phase-2 step fails BEFORE the relaunch is
   *  committed: remove the pending restore intent so the next boot does NOT silently restore, and (if the
   *  LAN server was stopped) bring it back. Reached only on a post-schedule, pre-relaunch failure. */
  rollbackScheduledRestore?: () => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drive a live scheduled restore in the safe order. A pre-schedule failure resumes writers (graceful, the
 * app stays usable); once the restore is durably scheduled, any later failure is fail-closed (no resume, no
 * relaunch) and the pending restore applies at the next boot. The error always propagates to the caller.
 */
export async function prepareAndScheduleRestore(ops: RestoreOrchestrationOps): Promise<void> {
  ops.setStatus({ kind: 'scheduling' });
  if (ops.yieldToRender) await ops.yieldToRender();
  ops.blockWrites(); // FIRST — no new writes from here on

  // ── Phase 1: reversible (quiesce + authorize + durably schedule) ──
  try {
    await ops.awaitWritersIdle();
    await ops.scheduleRestore(); // authorize owner + write durable intent; wrong owner / invalid id throws HERE
  } catch (err) {
    ops.resumeWrites(); // nothing was scheduled → fully recover, app stays usable
    ops.setStatus({ kind: 'error', message: messageOf(err) });
    throw err;
  }

  // ── Phase 2: flush+close → coordinated relaunch. A failure here is BEFORE the relaunch commits (the
  //    relaunch approves ONLY after the server is stopped + the port confirmed free), so it ROLLS BACK the
  //    scheduled restore: clear the pending intent (no silent restore at the next boot) and restart the LAN
  //    server if it was stopped. Writes are NOT resumed (the frontend DB is closed) — the app shows the
  //    error and the user restarts into the CURRENT (un-restored) data. Once approved, the relaunch commits
  //    and the boot path applies the restore. ──
  try {
    await ops.flushAndCloseFrontendDb();
    await ops.restartApplication();
  } catch (err) {
    if (ops.rollbackScheduledRestore) {
      try { await ops.rollbackScheduledRestore(); } catch { /* leave for boot reconcile */ }
    }
    ops.setStatus({ kind: 'error', message: messageOf(err) });
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-U2-R1 — the same two-phase safety, for a boot-scheduled BACKUP. The backup does not swap
// the DB, so phase 2 durably FLUSHES the frontend DB (so the on-disk copy the boot snapshot reads is
// current) — it does not close it. Contracts are identical: a pre-schedule failure resumes writers, a
// post-schedule failure is fail-closed and the boot path produces the snapshot.
// ════════════════════════════════════════════════════════════════════════════

export interface BackupOrchestrationOps {
  setStatus: (status: RestoreStatus | null) => void;
  yieldToRender?: () => Promise<void>;
  blockWrites: () => void;
  awaitWritersIdle: () => Promise<void>;
  /** Authorize the owner + durably SCHEDULE the boot backup (write the intent). Reversible: no mutation. */
  scheduleBackup: () => Promise<void>;
  /** Durably flush the frontend DB so the on-disk copy the boot snapshot reads is current (no close). */
  flushFrontendDb: () => Promise<void>;
  restartApplication: () => Promise<void>;
  resumeWrites: () => void;
}

export async function prepareAndScheduleBackup(ops: BackupOrchestrationOps): Promise<void> {
  ops.setStatus({ kind: 'scheduling' });
  if (ops.yieldToRender) await ops.yieldToRender();
  ops.blockWrites();

  // Phase 1 — reversible: quiesce → durably FLUSH the frontend DB FIRST → only THEN write the intent. The
  // intent is the commit point, so it must never exist before a successful flush: a flush failure (or a
  // schedule failure after the flush) leaves NO intent and resumes writers — the app stays fully usable and
  // the on-disk DB the boot snapshot will read is guaranteed to be exactly the flushed state.
  try {
    await ops.awaitWritersIdle();
    await ops.flushFrontendDb();  // durable on-disk copy FIRST
    await ops.scheduleBackup();   // write the intent ONLY after a successful flush
  } catch (err) {
    ops.resumeWrites(); // no durable intent → fully recover
    ops.setStatus({ kind: 'error', message: messageOf(err) });
    throw err;
  }

  // Phase 2 — fail-closed: the intent is durable and the backup WILL run at next boot.
  try {
    await ops.restartApplication();
  } catch (err) {
    ops.setStatus({ kind: 'error', message: messageOf(err) });
    throw err;
  }
}
