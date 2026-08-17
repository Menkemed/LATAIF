// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B2 — renderer API for moving the data root.
//
// The renderer does not move anything, and deliberately cannot: it runs a PREFLIGHT (which copies
// nothing), then — behind the owner's password and an explicit confirmation — durably SCHEDULES the
// move and hands off to the same coordinated relaunch the backup, restore and media-GC paths use.
// The copy, the verification and the locator switch all happen at the next boot, with every
// database closed and no server bound.
//
// Two consequences worth being explicit about, because both are safety properties and not
// implementation details:
//
//   • There is no hot switch. The path cache in `runtime-paths.ts` is never poked to "point at the
//     new root" — the process that comes up after the relaunch has only ever known one root.
//   • A failure before the locator write leaves the source active. There is nothing to undo in the
//     renderer, which is why this module has no rollback of its own; the only rollback that exists
//     lives in the boot path, bound to an explicit move intent.
//
// The old data location is never deleted. B2 ships no code that could.
// ════════════════════════════════════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export interface MovePlan {
  moveId: string;
  rootId: string;
  sourceRoot: string;
  targetRoot: string;
  stagingRoot: string;
  requiredBytes: number;
  freeBytes: number;
  fileCount: number;
}

export interface PendingMove {
  moveId: string;
  phase: string;
  targetRoot: string;
}

/** Is a move already scheduled? Used to keep a second one — or a second click — out. */
export function pendingDataRootMove(): Promise<PendingMove | null> {
  return invoke<PendingMove | null>('pending_data_root_move');
}

/**
 * Pick the new location. As with the backup location, a path only ever enters the flow through the
 * OS folder dialog — there is no free-text path input anywhere in this feature.
 */
export async function pickDataFolder(defaultPath?: string): Promise<string | null> {
  const sel = await open({
    directory: true,
    multiple: false,
    title: 'Neuen Datenordner wählen',
    defaultPath,
  });
  return typeof sel === 'string' ? sel : null;
}

/** OWNER-gated dry run: validates the target completely and returns the numbers the UI shows. */
export function preflightDataRootMove(p: {
  email: string;
  password: string;
  target: string;
}): Promise<MovePlan> {
  return invoke<MovePlan>('preflight_data_root_move', {
    email: p.email.trim(),
    password: p.password,
    target: p.target,
  });
}

/**
 * Schedule the move and relaunch into it.
 *
 * The order is the same one every other boot-scheduled operation uses, and each step is there for a
 * reason found the hard way: pause the writers, wait for them to settle, flush the business database
 * DURABLY (the boot copy reads a file, not a memory image), stop the LAN server and confirm the port
 * is actually free (a socket in CloseWait once stopped the replacement process from binding), only
 * then persist the intent, and only then relaunch. A failure before the intent is written resumes
 * the app unharmed; a failure after it is undone by `clear_pending_data_root_move`.
 */
export async function startDataRootMove(
  owner: { email: string; password: string },
  target: string,
  setPhase?: (phase: string) => void,
): Promise<void> {
  const [core, sync, db, wiring, proc, coord] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@/core/sync/sync-service'),
    import('@/core/db/database'),
    import('@/core/media/mobile-upload-wiring'),
    import('@tauri-apps/plugin-process'),
    import('@/core/lifecycle/relaunch-coordinator'),
  ]);
  await coord.coordinatedRelaunch({
    blockWrites: () => { sync.pauseAutoSync(); wiring.stopMobileDrainPoller(); },
    awaitWritersIdle: () => sync.waitForSyncIdle(),
    flushDurably: () => db.saveDatabaseDurably(),
    stopServerConfirmFree: () => core.invoke('stop_server_and_confirm_free'),
    restartServer: async () => { await core.invoke('sync_server_start'); },
    persistIntent: async () => {
      await core.invoke('schedule_data_root_move', {
        email: owner.email.trim(),
        password: owner.password,
        target,
      });
      return true;
    },
    clearIntent: () => core.invoke('clear_pending_data_root_move'),
    resumeWrites: () => { sync.resumeAutoSync(); wiring.armMobileDrainPoller(); },
    relaunch: () => proc.relaunch(),
    setPhase: setPhase ? (p) => setPhase(p) : undefined,
  });
}
