// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-U1 — production wiring for the safe restore path.
//
// Binds the pure restore orchestrator (`restore-orchestration.ts`) to the real runtime primitives and the
// two production Tauri commands (`list_restore_snapshots`, `schedule_restore_snapshot`). The renderer only
// ever holds an OPAQUE `snapshotId` (from the listing) and hands it back to the schedule command — never a
// path. There is NO command that restores in-process: the restore is applied at BOOT (DBs closed) after a
// controlled relaunch, so the orchestrator's `checkpointAndCloseServerDb` step is intentionally a no-op.
// `buildRestoreOrchestrationOps` is dependency-injected so the sequence + fail-closed contract are unit
// testable headlessly.
// ════════════════════════════════════════════════════════════════════════════

import {
  prepareAndScheduleRestore,
  prepareAndScheduleBackup,
  type RestoreOrchestrationOps,
  type BackupOrchestrationOps,
  type RestoreStatus,
} from './restore-orchestration.ts';

/** Sanitised snapshot summary returned by `list_restore_snapshots` (no filesystem paths). */
export interface SnapshotSummary {
  snapshotId: string;
  createdAt: string;
  appVersion: string;
  dbSizeBytes: number;
  mediaSizeBytes: number;
  mediaFileCount: number;
}

export interface RestoreParams {
  snapshotId: string;
  email: string;
  password: string;
}

/** The concrete runtime primitives the ops are wired to (injected so the wiring is testable). */
export interface RestoreRuntimeDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Pause auto-sync (stop the main writer). */
  pauseAutoSync: () => void;
  /** Resume auto-sync + re-arm the drain poller — used to UNDO the block on a pre-schedule failure. */
  resumeAutoSync: () => void;
  /** Stop the scoped mobile inbox drain poller/worker triggers. */
  stopMobileDrainPoller: () => void;
  /** Re-arm the scoped mobile inbox drain poller (part of resuming writers). */
  armMobileDrainPoller: () => void;
  /** Await any in-flight sync run to go idle. */
  waitForSyncIdle: () => Promise<void>;
  /** Durably flush + close the frontend DB so no later save clobbers the restored file. */
  flushAndCloseFrontendDb: () => Promise<void>;
  /** Controlled application restart (Tauri plugin-process). */
  relaunch: () => Promise<void>;
  setStatus?: (status: RestoreStatus | null) => void;
}

/**
 * Map the restore orchestration steps onto concrete runtime primitives. `scheduleRestore` invokes the
 * owner-gated schedule command (authorize + durable intent, NO mutation); the boot path applies the swap.
 * `resumeWrites` undoes the block if a pre-schedule step fails (graceful; the app stays usable).
 */
export function buildRestoreOrchestrationOps(
  params: RestoreParams,
  deps: RestoreRuntimeDeps,
): RestoreOrchestrationOps {
  return {
    setStatus: (s) => deps.setStatus?.(s),
    blockWrites: () => {
      deps.pauseAutoSync();
      deps.stopMobileDrainPoller();
    },
    awaitWritersIdle: () => deps.waitForSyncIdle(),
    scheduleRestore: async () => {
      // SCHEDULE only — never a live in-process mutation. Pass ONLY the opaque id + owner credentials
      // (never a path). The command authorizes the owner, re-resolves + re-validates, and writes a durable
      // intent; the boot path applies the swap after the relaunch and clears the intent exactly once.
      await deps.invoke('schedule_restore_snapshot', {
        email: params.email,
        password: params.password,
        snapshotId: params.snapshotId,
      });
    },
    flushAndCloseFrontendDb: () => deps.flushAndCloseFrontendDb(),
    restartApplication: () => deps.relaunch(),
    resumeWrites: () => {
      deps.resumeAutoSync();
      deps.armMobileDrainPoller();
    },
  };
}

/** Build the real runtime deps from the shipping modules (Tauri only). */
export async function buildDefaultRestoreDeps(
  setStatus?: (status: RestoreStatus | null) => void,
): Promise<RestoreRuntimeDeps> {
  const [core, sync, db, wiring, proc] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@/core/sync/sync-service'),
    import('@/core/db/database'),
    import('@/core/media/mobile-upload-wiring'),
    import('@tauri-apps/plugin-process'),
  ]);
  return {
    invoke: (cmd, args) => core.invoke(cmd, args ?? {}),
    pauseAutoSync: () => sync.pauseAutoSync(),
    resumeAutoSync: () => sync.resumeAutoSync(),
    stopMobileDrainPoller: () => wiring.stopMobileDrainPoller(),
    armMobileDrainPoller: () => wiring.armMobileDrainPoller(),
    waitForSyncIdle: () => sync.waitForSyncIdle(),
    flushAndCloseFrontendDb: () => db.flushAndCloseForRestore(),
    relaunch: () => proc.relaunch(),
    setStatus,
  };
}

/** Owner-gated listing of the safe, complete, pre-checked snapshots (opaque ids only). */
export async function listRestoreSnapshots(
  owner: { email: string; password: string },
): Promise<SnapshotSummary[]> {
  const core = await import('@tauri-apps/api/core');
  return (await core.invoke('list_restore_snapshots', {
    email: owner.email,
    password: owner.password,
  })) as SnapshotSummary[];
}

export interface BackupRuntimeDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  pauseAutoSync: () => void;
  resumeAutoSync: () => void;
  stopMobileDrainPoller: () => void;
  armMobileDrainPoller: () => void;
  waitForSyncIdle: () => Promise<void>;
  saveDatabaseDurably: () => Promise<void>;
  relaunch: () => Promise<void>;
  setStatus?: (status: RestoreStatus | null) => void;
}

/**
 * Map the backup orchestration steps. `scheduleBackup` invokes the owner-gated schedule command (authorize
 * + durable intent, NO snapshot here); the snapshot itself runs at BOOT with the DBs closed. `flushFrontendDb`
 * durably persists the frontend DB so the on-disk copy the boot snapshot reads is current (no close).
 * `resumeWrites` undoes the block on a pre-schedule failure (graceful).
 */
export function buildBackupOrchestrationOps(
  owner: { email: string; password: string },
  deps: BackupRuntimeDeps,
): BackupOrchestrationOps {
  return {
    setStatus: (s) => deps.setStatus?.(s),
    blockWrites: () => { deps.pauseAutoSync(); deps.stopMobileDrainPoller(); },
    awaitWritersIdle: () => deps.waitForSyncIdle(),
    scheduleBackup: async () => {
      await deps.invoke('schedule_backup_snapshot', { email: owner.email, password: owner.password });
    },
    flushFrontendDb: () => deps.saveDatabaseDurably(),
    restartApplication: () => deps.relaunch(),
    resumeWrites: () => { deps.resumeAutoSync(); deps.armMobileDrainPoller(); },
  };
}

/**
 * Schedule a boot-time backup (owner-gated) and relaunch. Quiesce → authorize + durable intent → durable
 * frontend-DB flush → controlled restart; the boot path then produces the `complete` snapshot with the DBs
 * closed. A pre-schedule failure (wrong owner) resumes writers and keeps the app usable; a post-schedule
 * failure is fail-closed. Injectable via deps for headless testing.
 */
export async function scheduleBackupSnapshotWith(
  owner: { email: string; password: string },
  deps: BackupRuntimeDeps,
): Promise<void> {
  await prepareAndScheduleBackup(buildBackupOrchestrationOps(owner, deps));
}

/** Schedule a boot-time backup using the shipping modules (Tauri only). */
export async function scheduleBackupSnapshot(
  owner: { email: string; password: string },
  setStatus?: (status: RestoreStatus | null) => void,
): Promise<void> {
  const [core, sync, db, wiring, proc] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@/core/sync/sync-service'),
    import('@/core/db/database'),
    import('@/core/media/mobile-upload-wiring'),
    import('@tauri-apps/plugin-process'),
  ]);
  await scheduleBackupSnapshotWith(owner, {
    invoke: (cmd, args) => core.invoke(cmd, args ?? {}),
    pauseAutoSync: () => sync.pauseAutoSync(),
    resumeAutoSync: () => sync.resumeAutoSync(),
    stopMobileDrainPoller: () => wiring.stopMobileDrainPoller(),
    armMobileDrainPoller: () => wiring.armMobileDrainPoller(),
    waitForSyncIdle: () => sync.waitForSyncIdle(),
    saveDatabaseDurably: () => db.saveDatabaseDurably(),
    relaunch: () => proc.relaunch(),
    setStatus,
  });
}

/**
 * Drive an owner-authenticated restore in the safe order: quiesce the runtime, durably schedule the
 * restore (no live mutation), then relaunch — the BOOT path applies the swap while the DBs are closed. On
 * ANY failure the writers/worker stay blocked, no relaunch happens, and the error propagates (fail-closed).
 */
export async function startRestore(
  params: RestoreParams,
  setStatus?: (status: RestoreStatus | null) => void,
): Promise<void> {
  const deps = await buildDefaultRestoreDeps(setStatus);
  const ops = buildRestoreOrchestrationOps(params, deps);
  await prepareAndScheduleRestore(ops);
}

/**
 * Expose the restore surface on `window` (Tauri only) so it is reachable at runtime before a Settings UI
 * exists. Purely additive — no auto-run. A real Danger-Zone UI (U2) will call these directly.
 */
export function installRestoreBridge(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  w.__lataifRestore = { listRestoreSnapshots, startRestore, scheduleBackupSnapshot };
}
