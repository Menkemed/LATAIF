// ═══════════════════════════════════════════════════════════
// LATAIF — History / Audit Module
// Implementiert Plan §History/Audit
// ═══════════════════════════════════════════════════════════
//
// Regeln aus dem Plan (§16):
//  - jede Änderung muss geloggt werden
//  - nichts darf verloren gehen
//  - keine stille Änderung
//  - Audit ist unveränderbar (keine Update/Delete-API)
//  - vollständige Nachvollziehbarkeit
//
// Die Helper schreiben direkt in die audit_log-Tabelle. Lese-API
// ist readonly. Schreibfehler werden geschluckt, damit der aufrufende
// Code (Store/Form) nicht scheitert, wenn Audit mal klemmt —
// aber die Warnung geht in die Konsole.

import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';

export type AuditActionType =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'STATUS_CHANGE'
  | 'PAYMENT'
  | 'REFUND';

export interface AuditEntry {
  id: string;
  branchId?: string;
  module: string;
  entityType: string;
  entityId: string;
  actionType: AuditActionType;
  fieldName?: string;
  oldValue?: string;
  newValue?: string;
  changedBy?: string;
  changedAt: string;
}

export interface LogAuditInput {
  module: string;
  entityType: string;
  entityId: string;
  action: AuditActionType;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

function toStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Write a single audit record. Safe against missing branch/user session.
export function logAudit(input: LogAuditInput): void {
  try {
    const db = getDatabase();
    let branchId: string | null = null;
    let userId: string | null = null;
    try { branchId = currentBranchId(); } catch { /* not logged in yet */ }
    try { userId = currentUserId(); } catch { /* not logged in yet */ }

    db.run(
      `INSERT INTO audit_log (id, branch_id, module, entity_type, entity_id, action_type,
        field_name, old_value, new_value, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        branchId,
        input.module,
        input.entityType,
        input.entityId,
        input.action,
        input.field || null,
        toStr(input.oldValue),
        toStr(input.newValue),
        userId,
        new Date().toISOString(),
      ]
    );
  } catch (err) {
    console.warn('[audit] failed to log:', err);
  }
}

// For UPDATE: write one row per changed field (Plan §6).
export function logUpdateDiff(
  module: string, entityType: string, entityId: string,
  before: Record<string, unknown>, after: Record<string, unknown>,
  ignoreFields: string[] = ['updatedAt', 'updated_at'],
): void {
  for (const key of Object.keys(after)) {
    if (ignoreFields.includes(key)) continue;
    const oldV = before[key];
    const newV = after[key];
    if (JSON.stringify(oldV) === JSON.stringify(newV)) continue;
    logAudit({
      module,
      entityType,
      entityId,
      action: 'UPDATE',
      field: key,
      oldValue: oldV,
      newValue: newV,
    });
  }
}

// ── Read-only API ──

export function getAuditForEntity(entityType: string, entityId: string): AuditEntry[] {
  try {
    const rows = query(
      `SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY changed_at DESC`,
      [entityType, entityId]
    );
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
}

export function getAuditByModule(module: string, limit = 500): AuditEntry[] {
  try {
    const rows = query(
      `SELECT * FROM audit_log WHERE module = ? ORDER BY changed_at DESC LIMIT ?`,
      [module, limit]
    );
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
}

export function getRecentAudit(limit = 200): AuditEntry[] {
  try {
    const rows = query(
      `SELECT * FROM audit_log ORDER BY changed_at DESC LIMIT ?`,
      [limit]
    );
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
}

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row.id as string,
    branchId: row.branch_id as string | undefined,
    module: row.module as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    actionType: row.action_type as AuditActionType,
    fieldName: row.field_name as string | undefined,
    oldValue: row.old_value as string | undefined,
    newValue: row.new_value as string | undefined,
    changedBy: row.changed_by as string | undefined,
    changedAt: row.changed_at as string,
  };
}
