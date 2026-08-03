// ════════════════════════════════════════════════════════════════════════════
// BACKUP-LOCATION — renderer API for the owner-configurable backup root.
//
// Thin wrappers over the owner-gated Tauri commands. The renderer NEVER types a filesystem path: the user
// picks a directory via the native folder dialog (`pickBackupFolder`), and that directory string is handed
// to `setBackupLocation`, where Rust validates + write-tests it before persisting. Snapshot creation and
// restore both resolve through the stored path on the Rust side; there is no path handling here beyond the
// opaque directory the OS dialog returns.
// ════════════════════════════════════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export interface BackupLocationInfo {
  /** The effective backups root (configured path, or the default). */
  path: string;
  /** True when no custom path is configured (using the built-in default). */
  isDefault: boolean;
  /** The built-in default path, for the "reset to default" affordance. */
  defaultPath: string;
}

/** Read-only: the current backup location for display. Not owner-gated (a folder path is not a secret). */
export function getBackupLocation(): Promise<BackupLocationInfo> {
  return invoke<BackupLocationInfo>('get_backup_location');
}

/**
 * Open the native folder-selection dialog. Returns the chosen absolute directory, or null if the user
 * cancelled. This is the ONLY way a path enters the flow — there is no free-text path input.
 */
export async function pickBackupFolder(defaultPath?: string): Promise<string | null> {
  const sel = await open({
    directory: true,
    multiple: false,
    title: 'Backup-Ordner wählen',
    defaultPath,
  });
  return typeof sel === 'string' ? sel : null;
}

/** OWNER-gated: persist a new backup root (Rust validates + write-tests before storing). */
export function setBackupLocation(p: { email: string; password: string; path: string }): Promise<BackupLocationInfo> {
  return invoke<BackupLocationInfo>('set_backup_location', {
    email: p.email.trim(),
    password: p.password,
    path: p.path,
  });
}

/** OWNER-gated: reset to the built-in default (existing snapshots are left untouched). */
export function resetBackupLocation(p: { email: string; password: string }): Promise<BackupLocationInfo> {
  return invoke<BackupLocationInfo>('reset_backup_location', {
    email: p.email.trim(),
    password: p.password,
  });
}

/** Open the effective backup root in the OS file manager (best-effort). */
export function openBackupLocation(): Promise<void> {
  return invoke('open_backup_location');
}
