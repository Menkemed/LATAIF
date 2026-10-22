// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-U2 — pure helpers for the Backup & Restore settings panel (headless-testable).
//
// Keeps the panel free of path/hash/internal-error leakage: `sanitizeBackupError` collapses every backend
// error into a generic user-facing message (never a code, path, or hash), and the formatters/guards drive
// the double-action lock and button-enable logic.
// ════════════════════════════════════════════════════════════════════════════

/** Never surface a backend code, path, or hash. Map everything to a short, safe message. */
export function sanitizeBackupError(raw: unknown): string {
  const msg = String((raw as Error)?.message ?? raw);
  if (/OWNER|CREDENTIAL|PASSWORD|AUTH/i.test(msg)) return 'Owner authorization failed.';
  // BACKUP-LOCATION — a chosen folder that cannot be written (disconnected/read-only drive) or is not a
  // valid absolute folder. Visible + actionable, never a path.
  if (/BACKUP_LOCATION_NOT_WRITABLE/i.test(msg))
    return 'The selected folder is not writable — check the drive is connected and not read-only.';
  if (/BACKUP_LOCATION_NOT_ABSOLUTE/i.test(msg)) return 'Please choose a valid folder.';
  if (/BACKUP_LOCATION_OVERLAPS_APPDATA/i.test(msg))
    return 'Choose a folder outside the app data — it cannot be the data/media folder or contain it.';
  // RESTORE-SAFETY — refusals that left everything untouched; each says what to do.
  if (/RESTORE_INSUFFICIENT_SPACE/i.test(msg))
    return 'Not enough free disk space for the restore — free some space and try again. Nothing was changed.';
  if (/RESTORE_FREE_SPACE_UNKNOWN/i.test(msg))
    return 'The free disk space could not be determined, so the restore was refused. Nothing was changed.';
  if (/RESTORE_ROLLBACK_PRESENT/i.test(msg))
    return 'An earlier restore has not been archived yet — restart the app once, then try again. Nothing was changed.';
  if (/OUTSIDE_ROOT|REPARSE|MISSING|HASH|VERSION|INCOMPLETE|UNEXPECTED/i.test(msg))
    return 'The selected backup could not be verified.';
  return 'Operation failed.';
}

/** Human-readable size with no internal precision leak. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Best-effort date formatting; falls back to the raw ISO string, never throws. */
export function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * The same instant, said unambiguously.
 *
 * Snapshots taken from v0.8.45 on are NAMED in local time with the offset spelled out
 * (`snap-2026-08-17T22-42-45_UTC+03-00_…`), so folder and row agree. Older folders keep their UTC
 * names — renaming a backup would be a pointless risk — which is the other reason the row says which
 * clock it is showing: on a mixed set, that word is the only thing that makes the two comparable.
 */
export function formatSnapshotTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString()} local time`;
}

/** A create/list action is allowed only with owner credentials and while nothing else is running. */
export function canRunOwnerAction(email: string, password: string, busy: boolean): boolean {
  return !busy && email.trim().length > 0 && password.length > 0;
}

/** A restore may be confirmed only for a chosen snapshot, with the owner password re-entered, not busy. */
export function canConfirmRestore(snapshotId: string | null, password: string, busy: boolean): boolean {
  return !busy && !!snapshotId && password.length > 0;
}

// ── RESTORE-SAFETY — the preview the owner sees before confirming ────────────────────────────────────

export type PreviewState = 'none' | 'loading' | 'loaded' | 'failed';

/**
 * Confirm only after the owner has SEEN what the restore changes — or seen that the preview could not be
 * made (a damaged live database is a reason to restore, so a failed preview must not lock the owner out).
 */
export function canConfirmRestoreAfterPreview(snapshotId: string | null, password: string, busy: boolean, preview: PreviewState): boolean {
  return canConfirmRestore(snapshotId, password, busy) && (preview === 'loaded' || preview === 'failed');
}

export interface PreviewLine {
  tone: 'loss' | 'return' | 'keep' | 'info' | 'unknown';
  text: string;
}

interface PreviewInput {
  snapshotCreatedAt: string;
  snapshotAppVersion: string;
  liveDbRead: boolean;
  records: Array<{ table: string; lost: number | null; returning: number | null }>;
  fieldChangesCompared: boolean;
  photosVisibleAgain: number | null;
  photosLeaving: number | null;
  mediaFilesNotInSnapshot: number;
  filesFilledIn: number | null;
  filesStillMissing: number | null;
  archiveFiles: number;
  archiveBytes: number;
  spaceNeededBytes: number;
  spaceFreeBytes: number | null;
  archivesExisting: number;
  archivesExistingBytes: number;
}

const TABLE_WORDS: Record<string, [string, string]> = {
  products: ['item', 'items'], customers: ['client', 'clients'], suppliers: ['supplier', 'suppliers'],
  purchases: ['purchase', 'purchases'], invoices: ['invoice', 'invoices'], repairs: ['repair', 'repairs'],
  consignments: ['consignment', 'consignments'], orders: ['order', 'orders'], offers: ['offer', 'offers'],
  expenses: ['expense', 'expenses'], payments: ['payment', 'payments'],
};
const word = (table: string, n: number) => {
  const w = TABLE_WORDS[table] ?? [table, table];
  return n === 1 ? w[0] : w[1];
};

/**
 * The preview in plain sentences. A number appears ONLY where the backend determined it exactly; whatever
 * was not compared is said in words ("not determined"), never as a guessed number.
 */
export function describeRestorePreview(p: PreviewInput, liveSaved: boolean): PreviewLine[] {
  const out: PreviewLine[] = [];
  out.push({ tone: 'info', text: `Backup from ${formatSnapshotTime(p.snapshotCreatedAt)} · v${p.snapshotAppVersion}.` });
  if (!liveSaved) out.push({ tone: 'unknown', text: 'Unsaved changes could not be written first — the comparison uses the last saved state.' });
  if (!p.liveDbRead) {
    out.push({ tone: 'unknown', text: 'The current data could not be read — what would be lost or come back is not determined.' });
  }
  const unknownTables: string[] = [];
  for (const r of p.records) {
    if (r.lost === null || r.returning === null) {
      if (p.liveDbRead) unknownTables.push(word(r.table, 2));
      continue;
    }
    if (r.lost > 0) out.push({ tone: 'loss', text: `${r.lost} ${word(r.table, r.lost)} added since the backup will be gone from the app (kept in the archive).` });
    if (r.returning > 0) out.push({ tone: 'return', text: `${r.returning} ${word(r.table, r.returning)} deleted since the backup come back.` });
  }
  if (unknownTables.length) out.push({ tone: 'unknown', text: `Not determined for: ${unknownTables.join(', ')}.` });
  if (!p.fieldChangesCompared) {
    out.push({ tone: 'unknown', text: 'Changes inside existing records are not compared — anything edited since the backup goes back to the backup’s version.' });
  }
  if (p.photosVisibleAgain === null || p.photosLeaving === null) {
    out.push({ tone: 'unknown', text: 'Gallery changes are not determined.' });
  } else {
    if (p.photosVisibleAgain > 0) out.push({ tone: 'return', text: `${p.photosVisibleAgain} gallery photo(s) removed since the backup become visible again.` });
    if (p.photosLeaving > 0) out.push({ tone: 'loss', text: `${p.photosLeaving} gallery photo(s) added since the backup leave their galleries (files kept in the archive).` });
  }
  if (p.filesFilledIn !== null && p.filesFilledIn > 0) {
    out.push({ tone: 'keep', text: `${p.filesFilledIn} photo file(s) the backup lacks are taken over from the current folder (checked by content).` });
  }
  if (p.filesStillMissing !== null && p.filesStillMissing > 0) {
    out.push({ tone: 'info', text: `${p.filesStillMissing} photo file(s) listed in the backup's data exist nowhere and stay missing.` });
  }
  out.push({ tone: 'keep', text: `Everything you have now — both databases and all media (${p.archiveFiles} files, ${formatBytes(p.archiveBytes)}) — is kept as a pre-restore archive in the data folder. Nothing is deleted.` });
  if (p.archivesExisting > 0) {
    out.push({ tone: 'info', text: `Earlier restore archives: ${p.archivesExisting} (${formatBytes(p.archivesExistingBytes)}). They are never deleted automatically.` });
  }
  if (p.spaceFreeBytes === null) {
    out.push({ tone: 'unknown', text: 'The free disk space could not be determined — the restore will refuse to start.' });
  } else if (p.spaceFreeBytes < p.spaceNeededBytes) {
    out.push({ tone: 'loss', text: `Not enough free disk space: needs ${formatBytes(p.spaceNeededBytes)}, ${formatBytes(p.spaceFreeBytes)} free — the restore will refuse to start.` });
  } else {
    out.push({ tone: 'info', text: `Disk space: needs about ${formatBytes(p.spaceNeededBytes)}, ${formatBytes(p.spaceFreeBytes)} free.` });
  }
  return out;
}
