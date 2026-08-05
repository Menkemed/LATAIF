// ════════════════════════════════════════════════════════════════════════════
// MEDIA-ROOT-GC — renderer API for owner-triggered cleanup of unreferenced media-root files.
//
// A pure dry-run SCAN (no change), a SCHEDULE that relaunches so the move runs at boot while all writers are
// idle (the write barrier), and a FINALIZE that is the ONLY permanent deletion. Between schedule and finalize
// the orphans sit in a retained quarantine; a boot reconcile moves back anything that became referenced.
// ════════════════════════════════════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core';
import { scheduleMediaGc } from '@/core/lifecycle/restore-wiring';

export interface GcOrphan {
  /** Path relative to the media root (never an absolute local path). */
  relPath: string;
  byteSize: number;
}

export interface GcReport {
  mediaRootPresent: boolean;
  referencedCount: number;
  orphanCount: number;
  orphanBytes: number;
  /** Referenced-but-absent files — a finding to investigate, never removed by GC. */
  missingReferencedCount: number;
  missingReferenced: string[];
  orphans: GcOrphan[];
  /** Files already quarantined by a prior scheduled run, awaiting owner finalize. */
  quarantinedCount: number;
  quarantinedBytes: number;
}

export interface GcApplyReport {
  runId: string;
  quarantined: number;
  purged: number;
  movedBack: number;
  retained: number;
  skipped: number;
  failed: number;
  bytes: number;
}

/** OWNER-gated dry-run: detect orphaned media-root files + any retained quarantine. Mutates nothing. */
export function scanUnusedMedia(p: { email: string; password: string }): Promise<GcReport> {
  return invoke<GcReport>('scan_unused_media', { email: p.email.trim(), password: p.password });
}

/**
 * OWNER-gated SCHEDULE: durably request the cleanup and relaunch. The move to the retained quarantine runs
 * at boot with all writers idle. Nothing is deleted now; the owner finalizes after the restart. On success
 * the process relaunches (this promise never resolves); a wrong owner / missing backup throws first.
 */
export function scheduleUnusedMediaGc(p: { email: string; password: string }): Promise<void> {
  return scheduleMediaGc({ email: p.email.trim(), password: p.password });
}

/** OWNER-gated FINALIZE: the only permanent deletion — re-checks references, moves back any now-referenced
 *  file, then purges the retained quarantine. */
export function finalizeUnusedMediaGc(p: { email: string; password: string }): Promise<GcApplyReport> {
  return invoke<GcApplyReport>('finalize_media_gc', { email: p.email.trim(), password: p.password });
}
