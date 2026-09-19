// ════════════════════════════════════════════════════════════════════════════
// MEDIA-S1 — the generic hook that lets a media-link mutation advance its OWNER's revision.
//
// Record revisions guard every edit (`expectedRevision` → `RECORD_CHANGED`). A photo added to or
// removed from a repair changes the repair — but `media_links` lives in its own table, so without
// this hook the repair's revision would not move and a concurrent edit would not notice. The hook
// is deliberately generic: the owner table, id and scope column come from the ONE entity map
// (`MEDIA_ENTITY_SCOPE`), and the bump is the same integer contract the revision triggers keep
// (`revision = revision + 1`; an explicit bump does not re-fire `WHEN NEW.revision = OLD.revision`).
//
// It MUST run inside the caller's transaction, together with the link change — then both commit or
// both roll back. S1 only provides and proves it; no writer is switched over yet.
// ════════════════════════════════════════════════════════════════════════════
import { MEDIA_ENTITY_SCOPE } from '../db/media-schema.ts';

/** The slice of a sql.js `Database` the hook needs. */
export interface OwnerRevisionDb {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  run(sql: string, params?: unknown[]): unknown;
  getRowsModified(): number;
}

export class OwnerRevisionError extends Error {
  readonly code: 'MEDIA_OWNER_ENTITY_UNKNOWN' | 'MEDIA_OWNER_NOT_FOUND';
  constructor(code: OwnerRevisionError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'OwnerRevisionError';
  }
}

export type OwnerRevisionResult =
  | { kind: 'revisioned'; revision: number }
  /** The owner table has no revision contract (yet) — nothing to advance, and that is reported, not hidden. */
  | { kind: 'not_revisioned' };

/**
 * Advance the owner's revision by exactly one, scoped to the owner's branch (or tenant). The owner
 * must exist in that scope — otherwise the link change is refused (a link to a record the caller
 * cannot see is never written).
 */
export function bumpMediaOwnerRevision(
  db: OwnerRevisionDb,
  owner: { entityType: string; entityId: string; scopeId: string },
): OwnerRevisionResult {
  const e = MEDIA_ENTITY_SCOPE[owner.entityType];
  if (!e) throw new OwnerRevisionError('MEDIA_OWNER_ENTITY_UNKNOWN', `unknown media owner type: ${owner.entityType}`);
  // Table and column names come from the fixed map, never from the caller.
  const cols = db.exec(`PRAGMA table_info(${e.table})`)[0]?.values.map((v) => String(v[1])) ?? [];
  const exists = db.exec(
    `SELECT 1 FROM ${e.table} WHERE ${e.idCol} = ? AND ${e.scopeCol} = ? LIMIT 1`, [owner.entityId, owner.scopeId],
  )[0]?.values.length;
  if (!exists) throw new OwnerRevisionError('MEDIA_OWNER_NOT_FOUND', `no ${owner.entityType} ${owner.entityId} in this scope`);
  if (!cols.includes('revision')) return { kind: 'not_revisioned' };
  db.run(
    `UPDATE ${e.table} SET revision = revision + 1 WHERE ${e.idCol} = ? AND ${e.scopeCol} = ?`,
    [owner.entityId, owner.scopeId],
  );
  if (db.getRowsModified() !== 1) throw new OwnerRevisionError('MEDIA_OWNER_NOT_FOUND', 'owner vanished');
  const rev = db.exec(`SELECT revision FROM ${e.table} WHERE ${e.idCol} = ?`, [owner.entityId])[0]?.values[0]?.[0];
  return { kind: 'revisioned', revision: Number(rev) };
}
