// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §9 — pure presentation logic for the storage maintenance panel.
//
// Split out of the .tsx for the same reason `backup-restore-panel-logic.ts` is:
// these rules decide what an operator is told about a destructive-sounding
// maintenance action, so they are unit-testable under plain node without a DOM.
// ════════════════════════════════════════════════════════════════════════════

/** Owner-verified backup must be at most this old for a bulk migration to start. */
export const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface BackupCandidate {
  createdAt: string;
  dbSizeBytes: number;
}

/**
 * Is at least one snapshot a usable fallback right now? Fail-closed: an
 * unparseable timestamp, an empty snapshot, or one dated in the future (clock
 * skew) never unlocks the run.
 */
export function hasFreshBackup(snapshots: BackupCandidate[], nowMs: number, maxAgeMs = BACKUP_MAX_AGE_MS): boolean {
  return (snapshots ?? []).some((s) => {
    const t = Date.parse(s?.createdAt);
    if (!Number.isFinite(t)) return false;
    const age = nowMs - t;
    return age >= 0 && age <= maxAgeMs && s.dbSizeBytes > 0;
  });
}

/**
 * Human text for the stable codes the storage cores return. Two rules the tests
 * pin: a failure message always says the originals survived (that is the whole
 * point of clearing the legacy column last), and an unmapped code is surfaced
 * verbatim rather than swallowed into a vague "something went wrong".
 */
export function explainStorageCode(code: string | undefined): string {
  switch (code) {
    case 'BACKUP_REQUIRED': return 'No recent complete backup found. Create a backup first — the migration will not start without one.';
    case 'BACKUP_PRECONDITION_UNVERIFIABLE': return 'Could not verify a backup with these owner credentials. Nothing was changed.';
    case 'MEDIA_SCOPE_REQUIRED': return 'No active branch selected — sign in again. Nothing was changed.';
    case 'LEGACY_ENTRY_BASE64_INVALID': return 'This product\'s image data is not valid image data — left untouched.';
    case 'LEGACY_ENTRY_NOT_A_DATA_URL': return 'This product\'s image entry is not an inline image — left untouched.';
    case 'LEGACY_ENTRY_NOT_BASE64': return 'This product\'s image entry is not encoded as an image — left untouched.';
    case 'LEGACY_ENTRY_EMPTY': return 'This product has an empty image entry — left untouched.';
    case 'LEGACY_ENTRY_NOT_A_STRING': return 'This product\'s image entry has an unexpected type — left untouched.';
    case 'MEDIA_LEGACY_MALFORMED_JSON': return 'This product\'s image field is not readable — left untouched.';
    case 'MEDIA_LEGACY_NOT_AN_ARRAY': return 'This product\'s image field is not a list — left untouched.';
    case 'MEDIA_LEGACY_NON_STRING_ELEMENT': return 'This product\'s image field holds an unexpected entry — left untouched.';
    case 'VERIFY_LEGACY_NOT_CLEARED': return 'Safety check failed — the original images are still in place, nothing was lost.';
    case 'VERIFY_LINK_COUNT_MISMATCH': return 'Safety check failed — the new gallery did not match the original image count, so the originals were kept.';
    case 'MEDIA_CUTOVER_INGEST_FAILED': return 'Importing an image failed — the originals were kept untouched, you can retry later.';
    case 'MEDIA_CUTOVER_MANIFEST_MISMATCH': return 'Safety check failed — the original images were kept untouched.';
    case 'MEDIA_CUTOVER_UNSUPPORTED_LEGACY': return 'One image could not be read — this product was left untouched.';
    case 'MEDIA_CUTOVER_LEGACY_FORMAT_ERROR': return 'The image field could not be read — this product was left untouched.';
    case 'MEDIA_CUTOVER_FAILED': return 'The migration step failed — the originals were kept untouched.';
    case 'COMPACTION_TRANSACTION_ACTIVE': return 'Something is still writing to the database — try again in a moment. Nothing was changed.';
    case 'COMPACTION_DB_TOO_LARGE': return 'The database is too large to reclaim space in one step. Migrate the photos first, then retry.';
    case 'COMPACTION_INSUFFICIENT_SPACE': return 'Not enough free disk space to reclaim safely — the compacted copy needs room alongside the current file. Nothing was changed.';
    case 'OWNER_VERIFICATION_FAILED': return 'These are not valid owner credentials. Nothing was changed.';
    case 'COMPACTION_FREE_SPACE_UNKNOWN': return 'The free disk space could not be determined, so reclaiming was not started. Nothing was changed.';
    default: return code ? `Left untouched (${code}).` : 'Left untouched.';
  }
}
