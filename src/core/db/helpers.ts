// ═══════════════════════════════════════════════════════════
// LATAIF — Database Query Helpers
// Branch-aware, type-safe
// ═══════════════════════════════════════════════════════════

import { getDatabase } from './database';
import { authService } from '../auth/auth';

/**
 * Execute a SELECT and return rows as objects.
 * Automatically scopes by branch_id if the table has one.
 */
export function query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const db = getDatabase();
  const results = db.exec(sql, params);
  if (results.length === 0) return [];
  const cols = results[0].columns;
  return results[0].values.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
    return obj;
  });
}

/**
 * Get current branch ID (from auth session).
 */
export function currentBranchId(): string {
  return authService.getCurrentBranchId();
}

/**
 * Get current user ID.
 */
export function currentUserId(): string {
  return authService.getCurrentUserId();
}

/**
 * Get a setting value for the current branch.
 */
export function getSetting(key: string, fallback: string = ''): string {
  try {
    const branchId = currentBranchId();
    const db = getDatabase();
    const r = db.exec(`SELECT value FROM settings WHERE branch_id = ? AND key = ?`, [branchId, key]);
    if (r.length > 0 && r[0].values.length > 0) return r[0].values[0][0] as string;
  } catch { /* */ }
  return fallback;
}

/**
 * Generate a next sequential number for a table, using prefix from settings.
 * Uses MAX of existing numeric suffixes (not COUNT) so deleting rows doesn't cause collisions.
 *
 * @deprecated Prefer getNextDocumentNumber(docType) per Plan §Settings §B.
 */
export function getNextNumber(table: string, settingsKey: string, defaultPrefix: string): string {
  const db = getDatabase();
  let branchId: string;
  try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }
  const prefix = getSetting(settingsKey, defaultPrefix);
  const year = new Date().getFullYear();
  const numberColumnMap: Record<string, string> = {
    offers: 'offer_number',
    invoices: 'invoice_number',
    repairs: 'repair_number',
    consignments: 'consignment_number',
    orders: 'order_number',
    agent_transfers: 'transfer_number',
  };
  const col = numberColumnMap[table];
  let nextSeq = 1;
  if (col) {
    const likePattern = `${prefix}-${year}-%`;
    try {
      const r = db.exec(
        `SELECT ${col} FROM ${table} WHERE branch_id = ? AND ${col} LIKE ?`,
        [branchId, likePattern]
      );
      if (r.length > 0) {
        let max = 0;
        for (const row of r[0].values) {
          const num = row[0] as string;
          const parts = num?.split('-');
          const seq = parts && parts.length >= 3 ? parseInt(parts[parts.length - 1], 10) : NaN;
          if (!isNaN(seq) && seq > max) max = seq;
        }
        nextSeq = max + 1;
      }
    } catch { /* fallthrough to 1 */ }
  }
  return `${prefix}-${year}-${String(nextSeq).padStart(5, '0')}`;
}

/**
 * Generate the next document number using the central document_sequences table
 * (Plan §Settings §B). Format: PREFIX-YYYY-NNNNNN (padding configurable).
 * Guarantees no duplicates and no reuse by atomically incrementing next_number.
 */
export function getNextDocumentNumber(docType: string): string {
  const db = getDatabase();
  const year = new Date().getFullYear();

  // Read current sequence config
  const r = db.exec(
    `SELECT prefix, next_number, include_year, padding FROM document_sequences WHERE doc_type = ?`,
    [docType]
  );
  if (r.length === 0 || r[0].values.length === 0) {
    // Fallback — treat docType itself as prefix, start at 1
    db.run(
      `INSERT OR IGNORE INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at)
       VALUES (?, ?, 1, 1, 6, datetime('now'))`,
      [docType, docType]
    );
    return `${docType}-${year}-${'1'.padStart(6, '0')}`;
  }

  const [prefix, nextNumber, includeYear, padding] = r[0].values[0] as [string, number, number, number];

  // Increment atomically
  db.run(
    `UPDATE document_sequences SET next_number = next_number + 1, updated_at = datetime('now') WHERE doc_type = ?`,
    [docType]
  );

  const seq = String(nextNumber).padStart(padding || 6, '0');
  return includeYear ? `${prefix}-${year}-${seq}` : `${prefix}-${seq}`;
}
