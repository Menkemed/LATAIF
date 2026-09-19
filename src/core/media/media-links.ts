// ════════════════════════════════════════════════════════════════════════════
// MEDIA-S2 — linking a verified media object to its OWNER, inside the business transaction.
//
//   bytes ingest → verified, unlinked media object      (orchestrator.ingestObject)
//   → business transaction: owner row + link + owner revision → COMMIT   (this module)
//
// Every mutation here — link, unlink, replace — runs in ONE transaction together with the owner's
// revision bump (`bumpMediaOwnerRevision`). Nested inside a caller's transaction it joins that
// bracket (the house depth counter decides, exactly like the coordinator): a business rollback then
// takes the link AND the revision back, and the unlinked object simply stays unreachable (existing
// GC contract). Standing alone it brackets itself.
//
// The gallery contract is the product one, unchanged: contiguous 0..N-1, exactly one primary, at 0.
// The owner's business meaning is not read here; only its existence in scope (revision hook).
// ════════════════════════════════════════════════════════════════════════════
import { enterTransaction, leaveNestedTransaction, resetTransactionContext } from '../db/transaction-context.ts';
import { linkIdFor } from './ids.ts';
import { inspectGallery } from './coordinator.ts';
import { assertMediaOwner, ownerScopeId, type MediaOwner } from './media-owner.ts';
import { assertMediaOwnerExists, bumpMediaOwnerRevision, type OwnerRevisionDb, type OwnerRevisionResult } from './owner-revision.ts';

export type MediaLinkErrorCode =
  | 'MEDIA_LINK_OBJECT_NOT_READY'
  | 'MEDIA_LINK_CLASS_MISMATCH'
  | 'MEDIA_LINK_SCOPE_MISMATCH'
  | 'MEDIA_LINK_ALREADY_ACTIVE'
  | 'MEDIA_LINK_NOT_FOUND'
  | 'MEDIA_LINK_GALLERY_INVALID';

export class MediaLinkError extends Error {
  readonly code: MediaLinkErrorCode;
  constructor(code: MediaLinkErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'MediaLinkError';
  }
}

export interface LinkChange {
  linkId: string;
  sortOrder: number;
  isPrimary: boolean;
  revision: OwnerRevisionResult;
}

type Row = Record<string, unknown>;

export class MediaOwnerLinks {
  private readonly db: OwnerRevisionDb;
  constructor(db: OwnerRevisionDb) {
    this.db = db;
  }

  /** Append the object to the owner's gallery for `role` (first one becomes primary at 0). */
  link(owner: MediaOwner, mediaId: string): LinkChange {
    assertMediaOwner(owner);
    return this.inTx(() => {
      this.assertLinkableObject(owner, mediaId);
      const linkId = linkIdFor({ ...owner, mediaId });
      const existing = this.one(`SELECT deleted_at FROM media_links WHERE tenant_id = ? AND link_id = ?`, [owner.tenantId, linkId]);
      if (existing && existing.deleted_at == null) throw new MediaLinkError('MEDIA_LINK_ALREADY_ACTIVE');
      const n = this.gallery(owner).length;
      const now = new Date().toISOString();
      if (existing) {
        this.db.run(`UPDATE media_links SET deleted_at = NULL, sort_order = ?, is_primary = ? WHERE tenant_id = ? AND link_id = ?`,
          [n, n === 0 ? 1 : 0, owner.tenantId, linkId]);
      } else {
        this.db.run(
          `INSERT INTO media_links (tenant_id, link_id, scope_kind, branch_id, entity_type, entity_id, media_id, media_role, sort_order, is_primary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [owner.tenantId, linkId, owner.scopeKind, owner.scopeKind === 'branch' ? owner.branchId : null,
            owner.entityType, owner.entityId, mediaId, owner.role, n, n === 0 ? 1 : 0, now],
        );
      }
      this.assertGallery(owner);
      return { linkId, sortOrder: n, isPrimary: n === 0, revision: this.bump(owner) };
    });
  }

  /** Remove one link; the rest close ranks (0..N-2) and slot 0 is primary again. */
  unlink(owner: MediaOwner, linkId: string): LinkChange {
    assertMediaOwner(owner);
    return this.inTx(() => {
      const row = this.ownedActiveLink(owner, linkId);
      const now = new Date().toISOString();
      this.clearPrimary(owner);
      this.db.run(`UPDATE media_links SET deleted_at = ?, is_primary = 0 WHERE tenant_id = ? AND link_id = ?`, [now, owner.tenantId, linkId]);
      const rest = this.gallery(owner);
      rest.forEach((r, i) => {
        this.db.run(`UPDATE media_links SET sort_order = ? WHERE tenant_id = ? AND link_id = ?`, [i, owner.tenantId, String(r.link_id)]);
      });
      if (rest.length > 0) {
        this.db.run(`UPDATE media_links SET is_primary = 1 WHERE tenant_id = ? AND link_id = ?`, [owner.tenantId, String(rest[0].link_id)]);
      }
      this.assertGallery(owner);
      return { linkId, sortOrder: Number(row.sort_order), isPrimary: Number(row.is_primary) === 1, revision: this.bump(owner) };
    });
  }

  /** Put a new object into exactly the slot (and primary flag) of an existing link. ONE revision step. */
  replace(owner: MediaOwner, previousLinkId: string, newMediaId: string): LinkChange {
    assertMediaOwner(owner);
    return this.inTx(() => {
      const old = this.ownedActiveLink(owner, previousLinkId);
      this.assertLinkableObject(owner, newMediaId);
      const slot = Number(old.sort_order);
      const primary = Number(old.is_primary) === 1;
      const linkId = linkIdFor({ ...owner, mediaId: newMediaId });
      const existing = this.one(`SELECT deleted_at FROM media_links WHERE tenant_id = ? AND link_id = ?`, [owner.tenantId, linkId]);
      if (existing && existing.deleted_at == null) throw new MediaLinkError('MEDIA_LINK_ALREADY_ACTIVE');
      const now = new Date().toISOString();
      this.db.run(`UPDATE media_links SET deleted_at = ?, is_primary = 0 WHERE tenant_id = ? AND link_id = ?`, [now, owner.tenantId, previousLinkId]);
      if (existing) {
        this.db.run(`UPDATE media_links SET deleted_at = NULL, sort_order = ?, is_primary = ? WHERE tenant_id = ? AND link_id = ?`,
          [slot, primary ? 1 : 0, owner.tenantId, linkId]);
      } else {
        this.db.run(
          `INSERT INTO media_links (tenant_id, link_id, scope_kind, branch_id, entity_type, entity_id, media_id, media_role, sort_order, is_primary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [owner.tenantId, linkId, owner.scopeKind, owner.scopeKind === 'branch' ? owner.branchId : null,
            owner.entityType, owner.entityId, newMediaId, owner.role, slot, primary ? 1 : 0, now],
        );
      }
      this.assertGallery(owner);
      return { linkId, sortOrder: slot, isPrimary: primary, revision: this.bump(owner) };
    });
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  private bump(owner: MediaOwner): OwnerRevisionResult {
    return bumpMediaOwnerRevision(this.db, { entityType: owner.entityType, entityId: owner.entityId, scopeId: ownerScopeId(owner) });
  }

  /** The object must be ready, active, of the owner's class (no silent change) and scope. */
  private assertLinkableObject(owner: MediaOwner, mediaId: string): void {
    assertMediaOwnerExists(this.db, { entityType: owner.entityType, entityId: owner.entityId, scopeId: ownerScopeId(owner) });
    const o = this.one(
      `SELECT security_class, origin_branch_id, ingest_status, deleted_at FROM media_objects WHERE tenant_id = ? AND media_id = ?`,
      [owner.tenantId, mediaId],
    );
    if (!o || o.deleted_at != null || o.ingest_status !== 'ready') throw new MediaLinkError('MEDIA_LINK_OBJECT_NOT_READY');
    if (o.security_class !== owner.securityClass) throw new MediaLinkError('MEDIA_LINK_CLASS_MISMATCH');
    const origin = o.origin_branch_id == null ? null : String(o.origin_branch_id);
    if (origin !== (owner.scopeKind === 'branch' ? owner.branchId : null)) throw new MediaLinkError('MEDIA_LINK_SCOPE_MISMATCH');
  }

  private ownedActiveLink(owner: MediaOwner, linkId: string): Row {
    const r = this.one(
      `SELECT link_id, sort_order, is_primary FROM media_links
        WHERE tenant_id = ? AND link_id = ? AND deleted_at IS NULL AND scope_kind = ?
          AND ${owner.scopeKind === 'branch' ? 'branch_id = ?' : 'branch_id IS NULL'}
          AND entity_type = ? AND entity_id = ? AND media_role = ?`,
      owner.scopeKind === 'branch'
        ? [owner.tenantId, linkId, owner.scopeKind, owner.branchId, owner.entityType, owner.entityId, owner.role]
        : [owner.tenantId, linkId, owner.scopeKind, owner.entityType, owner.entityId, owner.role],
    );
    if (!r) throw new MediaLinkError('MEDIA_LINK_NOT_FOUND');
    return r;
  }

  private gallery(owner: MediaOwner): Row[] {
    return this.all(
      `SELECT link_id, sort_order, is_primary FROM media_links
        WHERE tenant_id = ? AND scope_kind = ? AND ${owner.scopeKind === 'branch' ? 'branch_id = ?' : 'branch_id IS NULL'}
          AND entity_type = ? AND entity_id = ? AND media_role = ? AND deleted_at IS NULL
        ORDER BY sort_order ASC`,
      owner.scopeKind === 'branch'
        ? [owner.tenantId, owner.scopeKind, owner.branchId, owner.entityType, owner.entityId, owner.role]
        : [owner.tenantId, owner.scopeKind, owner.entityType, owner.entityId, owner.role],
    );
  }

  private clearPrimary(owner: MediaOwner): void {
    for (const r of this.gallery(owner)) {
      this.db.run(`UPDATE media_links SET is_primary = 0 WHERE tenant_id = ? AND link_id = ?`, [owner.tenantId, String(r.link_id)]);
    }
  }

  private assertGallery(owner: MediaOwner): void {
    const issue = inspectGallery(this.gallery(owner));
    if (issue) throw new MediaLinkError('MEDIA_LINK_GALLERY_INVALID', issue);
  }

  private all(sql: string, params: unknown[]): Row[] {
    const r = this.db.exec(sql, params)[0];
    if (!r) return [];
    return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])));
  }

  private one(sql: string, params: unknown[]): Row | null {
    return this.all(sql, params)[0] ?? null;
  }

  /** The house bracket: only the OUTERMOST level begins/commits/rolls back (same as the coordinator). */
  private inTx<T>(fn: () => T): T {
    const outermost = enterTransaction();
    if (outermost) this.db.run('BEGIN IMMEDIATE');
    try {
      const out = fn();
      if (leaveNestedTransaction() && outermost) this.db.run('COMMIT');
      return out;
    } catch (e) {
      if (outermost) {
        resetTransactionContext();
        try { this.db.run('ROLLBACK'); } catch { /* sql.js may already have rolled back on a trigger abort */ }
      }
      throw e;
    }
  }
}
