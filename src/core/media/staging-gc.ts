// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C5A — safe staging garbage-collection CORE.  INACTIVE.
//
// Pure + node-testable. NOTHING here runs at startup or from a command — the real
// listing/stat/delete and the media-operations-lock live in the Rust/host layer
// (the reported ACTIVATION BOUNDARY). NO automatic GC runs until dry-run, locking
// and recovery order are proven and wired.
//
// GC removes ONLY files proven orphaned against EVERY SSOT. A file is RETAINED if
// it is: an active/current generation, referenced by media_links/media_variants,
// referenced by a non-terminal media_ingest_job (or its temp keys), referenced by
// a durable create/edit/cutover plan, referenced by the Rust ingest journal, ever
// referenced by the mobile-inbox core, under an in-flight operation lock, younger
// than the grace period, a symlink, or outside the controlled staging root.
// Dry-run returns ids/counts/sizes only — never sensitive paths. Delete is
// idempotent; a crash mid-GC is safely repeatable. NEVER logs image bytes.
//
// ── Proof scope (R1) ─────────────────────────────────────────────────────────
// This core PROVES only the GC DECISION / dry-run MODEL. `StagingFile.insideRoot`
// and `isSymlink` are UNVERIFIED host CLAIMS — real root-containment and symlink
// safety require a Rust adapter that canonicalizes + reads symlink_metadata. No
// deletion here is real; `assertStagingGcHostActivated()` throws and
// STAGING_GC_ACTIVATION reports the missing wiring. A stale dry-run plan may NEVER
// drive a later deletion on its own: `applyStagingGc` re-checks `stillSafe` (a
// fresh host canonicalize+stat+SSOT recheck) immediately before EACH delete.
// ════════════════════════════════════════════════════════════════════════════

/** The host wiring GC needs before any real deletion. Absent → INACTIVE. */
export const STAGING_GC_ACTIVATION = {
  activatable: false as const,
  missingHostContract: [
    'CANONICALIZE_AND_ROOT_CONTAINMENT',
    'SYMLINK_METADATA',
    'MEDIA_OPERATION_LOCK',
    'REAL_UNLINK',
  ],
} as const;

/** Typed guard a production caller would hit — no real GC deletion may run. */
export function assertStagingGcHostActivated(): never {
  throw new Error('MEDIA_STAGING_GC_HOST_NOT_WIRED');
}

/** A file discovered under the staging root. `relKey` is its staging-relative
 *  identity (e.g. a journal temp key); `path` is the absolute path the host will
 *  delete — kept out of dry-run output. */
export interface StagingFile {
  relKey: string;
  ageMs: number;         // now - mtime
  byteSize: number;
  insideRoot: boolean;   // host-resolved: path canonicalises within the staging root
  isSymlink: boolean;    // host-resolved
  /** The (scope, requestId) this staging file belongs to, if derivable from its
   *  name — used to check the ingest-job SSOT. */
  scope?: string;
  requestId?: string;
}

/** Every SSOT a staging file could be legitimately referenced by. The host builds
 *  these by querying the DB + reading the durable plans/journal + the live locks. */
export interface StagingSsots {
  /** storage_key / temp_key strings that are active or otherwise durably needed. */
  referencedKeys: ReadonlySet<string>;
  /** (scope::requestId) of every NON-terminal ingest job. */
  liveIngestRequests: ReadonlySet<string>;
  /** (scope::requestId) currently under a prepare/publish operation lock. */
  lockedRequests: ReadonlySet<string>;
  /** True if ANY media operation (prepare/publish/cutover/backup/restore) is
   *  currently running — GC must not run concurrently with one. */
  operationInProgress: boolean;
}

export interface GcOptions {
  gracePeriodMs: number;
}

export type GcRetainReason =
  | 'operation_in_progress'
  | 'outside_staging_root'
  | 'symlink'
  | 'referenced_by_ssot'
  | 'live_ingest_job'
  | 'locked'
  | 'within_grace_period';

export interface GcPlan {
  deletable: Array<{ relKey: string; byteSize: number }>;
  retained: Array<{ relKey: string; reason: GcRetainReason }>;
  deletableCount: number;
  retainedCount: number;
  deletableBytes: number;
}

const req = (f: StagingFile) => (f.scope != null && f.requestId != null ? `${f.scope}::${f.requestId}` : null);

/**
 * Analyse the staging root and decide which files are SAFELY deletable. This is
 * the dry-run: it never deletes. If ANY media operation is in progress, nothing is
 * deletable (whole-run guard). Otherwise each file is retained unless it clears
 * EVERY safety check.
 */
export function analyzeStagingGc(files: StagingFile[], ssots: StagingSsots, opts: GcOptions, now: number): GcPlan {
  void now; // ages are precomputed by the host; kept for signature stability
  const deletable: Array<{ relKey: string; byteSize: number }> = [];
  const retained: Array<{ relKey: string; reason: GcRetainReason }> = [];
  const keep = (f: StagingFile, reason: GcRetainReason) => retained.push({ relKey: f.relKey, reason });

  for (const f of files) {
    // whole-run guard: never GC while an operation could be creating these files.
    if (ssots.operationInProgress) { keep(f, 'operation_in_progress'); continue; }
    // never touch anything the host could not prove is inside the controlled root.
    if (!f.insideRoot) { keep(f, 'outside_staging_root'); continue; }
    if (f.isSymlink) { keep(f, 'symlink'); continue; }
    // referenced by any durable SSOT (active gen / link / variant / plan / journal / inbox).
    if (ssots.referencedKeys.has(f.relKey)) { keep(f, 'referenced_by_ssot'); continue; }
    const rk = req(f);
    if (rk && ssots.liveIngestRequests.has(rk)) { keep(f, 'live_ingest_job'); continue; }
    if (rk && ssots.lockedRequests.has(rk)) { keep(f, 'locked'); continue; }
    // young files are kept regardless (a prepare may still be publishing them).
    if (f.ageMs < opts.gracePeriodMs) { keep(f, 'within_grace_period'); continue; }
    // proven orphan: not referenced anywhere, old enough, inside root, no lock.
    deletable.push({ relKey: f.relKey, byteSize: f.byteSize });
  }

  return {
    deletable,
    retained,
    deletableCount: deletable.length,
    retainedCount: retained.length,
    deletableBytes: deletable.reduce((s, d) => s + d.byteSize, 0),
  };
}

/** True iff a specific prepared-journal file (no DB intent) may be deleted:
 *  no running operation, grace elapsed, not referenced by any SSOT, and inside
 *  the staging root. Mirrors the single-file rule the analyzer applies in bulk. */
export function preparedJournalDeletable(f: StagingFile, ssots: StagingSsots, opts: GcOptions): boolean {
  if (ssots.operationInProgress) return false;
  if (!f.insideRoot || f.isSymlink) return false;
  if (ssots.referencedKeys.has(f.relKey)) return false;
  const rk = req(f);
  if (rk && (ssots.liveIngestRequests.has(rk) || ssots.lockedRequests.has(rk))) return false;
  return f.ageMs >= opts.gracePeriodMs;
}

export interface GcDeletePort {
  /** Delete one staging file by relKey. Missing file → treated as already gone
   *  (idempotent). Returns true if a file was removed, false if it was absent. */
  delete: (relKey: string) => boolean;
  /** Re-check inside-root + symlink at delete time (TOCTOU defence). */
  stillSafe: (relKey: string) => boolean;
}

export interface GcApplyResult { deleted: number; skipped: number; }

/**
 * Apply a GC plan. Idempotent + crash-repeatable: a file already gone is counted
 * skipped, and re-running the same plan after a crash deletes only what remains.
 * Re-checks safety at delete time so a file that became referenced/locked between
 * dry-run and apply is skipped.
 */
export function applyStagingGc(plan: GcPlan, port: GcDeletePort): GcApplyResult {
  let deleted = 0, skipped = 0;
  for (const d of plan.deletable) {
    if (!port.stillSafe(d.relKey)) { skipped++; continue; }
    if (port.delete(d.relKey)) deleted++; else skipped++;
  }
  return { deleted, skipped };
}
