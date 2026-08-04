// ════════════════════════════════════════════════════════════════════════════
// BACKUP-RETENTION — renderer API for owner-configurable "keep last N snapshots".
//
// Retention is OFF until the owner enables it; enabling never deletes existing snapshots — the prune runs
// on the Rust side AFTER the next fully-successful backup (never the newest, never an incomplete folder).
// ════════════════════════════════════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core';

export interface RetentionInfo {
  /** Whether retention (auto-prune) is enabled. */
  enabled: boolean;
  /** How many newest complete snapshots to keep (>= 1). */
  keepCount: number;
  /** The built-in default keep count (e.g. 10). */
  defaultKeep: number;
}

/** Read-only: current retention config for display (not owner-gated). */
export function getBackupRetention(): Promise<RetentionInfo> {
  return invoke<RetentionInfo>('get_backup_retention');
}

/** OWNER-gated: enable/disable + set keep count (Rust clamps to [1,1000]); does not prune existing snapshots. */
export function setBackupRetention(p: {
  email: string;
  password: string;
  enabled: boolean;
  keepCount: number;
}): Promise<RetentionInfo> {
  return invoke<RetentionInfo>('set_backup_retention', {
    email: p.email.trim(),
    password: p.password,
    enabled: p.enabled,
    keepCount: p.keepCount,
  });
}
