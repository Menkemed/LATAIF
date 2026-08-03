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

/** A create/list action is allowed only with owner credentials and while nothing else is running. */
export function canRunOwnerAction(email: string, password: string, busy: boolean): boolean {
  return !busy && email.trim().length > 0 && password.length > 0;
}

/** A restore may be confirmed only for a chosen snapshot, with the owner password re-entered, not busy. */
export function canConfirmRestore(snapshotId: string | null, password: string, busy: boolean): boolean {
  return !busy && !!snapshotId && password.length > 0;
}
