// ════════════════════════════════════════════════════════════════════════════
// MEDIA-03A/03B — Additive, INACTIVE media schema (content-addressed store).
// ════════════════════════════════════════════════════════════════════════════
// This module is the single source of the media DDL. It is applied by
// runMigrations() (database.ts) on both fresh and existing frontend sql.js DBs,
// idempotently (every statement is CREATE … IF NOT EXISTS).
//
// INACTIVE by design: no writer, no FS files, no sync/changelog activation. The
// tables stay empty; the triggers only ever fire on media_* writes, of which
// there are none until a later slice wires a guarded writer.
//
// Why a separate module (not database.ts / schema.sql): the sql.js DB does NOT
// reliably enforce foreign keys (no `PRAGMA foreign_keys=ON`; see the
// ON-DELETE-SET-NULL note in database.ts), so the invariants below are carried
// by TRIGGERS, which DO fire in sql.js; a dedicated module keeps that trigger-
// heavy DDL cohesive. These tables are NOT hidden from the schema tests:
// test/media03a/schema-classification.test.ts scans THIS file too, asserts the
// tables defined here equal MEDIA_TABLES, classifies them as
// `local_inactive_media`, and proves they are absent from the sync
// business-schema allowlist. The legacy 48-table / 187-column sync-apply-path
// identifier contract in test/m6b2de4/identifier-grammar.test.ts stays a
// separate, unchanged check.
//
// Design contracts realised here: MEDIA-02B (blob SSOT + scope), 02C (entity
// scope manifest + idempotency fields), 02D (generation SSOT), 02E (available
// generation + bootstrap), 02F (hard 100 KB / 20 KB, available-only pointer),
// 02G (reverse pointer guards, linkable-blob, content_kind, NOT EXISTS gating).
// MEDIA-03B adds the rotation + backup foundation: tenant/blob key-rotation
// lifecycles and immutable backup generation pins with a GC guard — still fully
// inactive (no key rotation runs, no backups are produced, no media files move).
// ════════════════════════════════════════════════════════════════════════════

/** All ten inactive media tables: six core (MEDIA-03A) + four rotation/backup
 *  (MEDIA-03B). The classification test derives the `local_inactive_media`
 *  category from this list — a new media table MUST be added here. */
export const MEDIA_TABLES = [
  // ── MEDIA-03A core (6) ──
  'media_blobs',
  'media_blob_generations',
  'media_objects',
  'media_variants',
  'media_links',
  'media_ingest_jobs',
  // ── MEDIA-03B rotation + backup (4) ──
  'tenant_key_rotation_jobs',
  'media_rotation_jobs',
  'media_backup_sets',
  'media_backup_generation_pins',
] as const;

/** Entity-scope SSOT (schema-verified in MEDIA-02C §1). Drives the media_links
 *  existence/scope triggers below. `production_input` is deliberately excluded —
 *  it is a snapshot child (production_inputs.record_id → production_records),
 *  not a first-class media owner. */
export interface EntityScopeEntry {
  /** Backing table the entity_id must exist in. */
  table: string;
  /** Primary-key column of the backing table. */
  idCol: string;
  /** Whether the entity is scoped to a branch or the whole tenant. */
  scope: 'branch' | 'tenant';
  /** Column on the backing table that carries the scope key. For branch-scoped
   *  this is compared to the link's branch_id; for tenant-scoped, to tenant_id
   *  (tenant_logo binds via the tenant's own id). */
  scopeCol: string;
}

export const MEDIA_ENTITY_SCOPE: Readonly<Record<string, EntityScopeEntry>> = {
  // ── branch-scoped (10) ──
  product:        { table: 'products',        idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  repair:         { table: 'repairs',         idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  purchase_inbox: { table: 'purchase_inbox',  idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  purchase:       { table: 'purchases',       idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  supplier:       { table: 'suppliers',       idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  document:       { table: 'documents',       idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  order:          { table: 'orders',          idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  offer:          { table: 'offers',          idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  precious_metal: { table: 'precious_metals', idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  scrap_trade:    { table: 'scrap_trades',    idCol: 'id', scope: 'branch', scopeCol: 'branch_id' },
  // ── tenant-scoped (3) ──
  branch_logo:    { table: 'branches',        idCol: 'id', scope: 'tenant', scopeCol: 'tenant_id' },
  user_avatar:    { table: 'users',           idCol: 'id', scope: 'tenant', scopeCol: 'tenant_id' },
  tenant_logo:    { table: 'tenants',         idCol: 'id', scope: 'tenant', scopeCol: 'id' },
};

/** Comma-quoted allowlist literal for a CHECK / trigger, e.g. `'a','b'`. */
function quotedList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(',');
}

const ENTITY_TYPES = Object.keys(MEDIA_ENTITY_SCOPE);

// The join to the CURRENT generation of a blob, reused by several guards.
const CURRENT_GEN_JOIN =
  'media_blobs b JOIN media_blob_generations g ' +
  'ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no';

// ── entity-scope trigger body, generated from the SSOT ──────────────────────
function entityScopeChecks(): string {
  const parts: string[] = [];
  for (const [et, e] of Object.entries(MEDIA_ENTITY_SCOPE)) {
    // (a) scope_kind must match the manifest for this entity_type
    parts.push(
      `SELECT CASE WHEN NEW.entity_type='${et}' AND NEW.scope_kind<>'${e.scope}' ` +
        `THEN RAISE(ABORT,'MEDIA_ENTITY_SCOPE_KIND') END;`,
    );
    // (b) entity must exist within the declared scope. NOT EXISTS gates safely
    //     even when the sub-select yields no row.
    const scopeMatch =
      e.scope === 'branch'
        ? `x.${e.scopeCol}=NEW.branch_id`
        : `x.${e.scopeCol}=NEW.tenant_id`;
    parts.push(
      `SELECT CASE WHEN NEW.entity_type='${et}' AND NOT EXISTS(` +
        `SELECT 1 FROM ${e.table} x WHERE x.${e.idCol}=NEW.entity_id AND ${scopeMatch}` +
        `) THEN RAISE(ABORT,'MEDIA_ENTITY_NOT_FOUND') END;`,
    );
  }
  // (c) for any branch-scoped link the branch must belong to the tenant
  parts.push(
    `SELECT CASE WHEN NEW.scope_kind='branch' AND NOT EXISTS(` +
      `SELECT 1 FROM branches b WHERE b.id=NEW.branch_id AND b.tenant_id=NEW.tenant_id` +
      `) THEN RAISE(ABORT,'MEDIA_BRANCH_TENANT') END;`,
  );
  return parts.join('\n  ');
}

// ── reverse-pointer guard body (fires when current_generation_no changes) ────
// Rejects a generation switch that would leave an existing usage over-limit or
// (class D) unencrypted. NEW points at the incoming generation.
function reversePointerGuardBody(): string {
  return [
    // raster master usage over 100 000
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_objects o JOIN media_blob_generations g ` +
      `ON g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.current_generation_no ` +
      `WHERE o.tenant_id=NEW.tenant_id AND o.master_blob_id=NEW.blob_id AND o.deleted_at IS NULL ` +
      `AND g.content_kind='raster_image' AND g.byte_size>100000` +
      `) THEN RAISE(ABORT,'MEDIA_GENERATION_USAGE_CONSTRAINT') END;`,
    // variant usage over its role limit
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_variants v JOIN media_blob_generations g ` +
      `ON g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.current_generation_no ` +
      `WHERE v.tenant_id=NEW.tenant_id AND v.blob_id=NEW.blob_id AND v.deleted_at IS NULL AND (` +
      `(v.variant_type='thumbnail' AND g.byte_size>20000) OR ` +
      `(v.variant_type IN ('display','ai_input','document_preview') AND g.content_kind='raster_image' AND g.byte_size>100000))` +
      `) THEN RAISE(ABORT,'MEDIA_GENERATION_USAGE_CONSTRAINT') END;`,
    // class-D master usage → target generation must be encrypted
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_objects o JOIN media_blob_generations g ` +
      `ON g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.current_generation_no ` +
      `WHERE o.tenant_id=NEW.tenant_id AND o.deleted_at IS NULL AND o.security_class='highly_sensitive' ` +
      `AND o.master_blob_id=NEW.blob_id AND (g.is_encrypted<>1 OR g.dek_version IS NULL)` +
      `) THEN RAISE(ABORT,'MEDIA_GENERATION_USAGE_CONSTRAINT') END;`,
    // class-D variant usage → target generation must be encrypted
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_variants v ` +
      `JOIN media_objects o ON o.tenant_id=v.tenant_id AND o.media_id=v.media_id ` +
      `JOIN media_blob_generations g ` +
      `ON g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.current_generation_no ` +
      `WHERE v.tenant_id=NEW.tenant_id AND v.blob_id=NEW.blob_id AND v.deleted_at IS NULL ` +
      `AND o.deleted_at IS NULL AND o.security_class='highly_sensitive' ` +
      `AND (g.is_encrypted<>1 OR g.dek_version IS NULL)` +
      `) THEN RAISE(ABORT,'MEDIA_GENERATION_USAGE_CONSTRAINT') END;`,
  ].join('\n  ');
}

// ── media_variants guard body, shared by the INSERT and UPDATE triggers ─────
// Guards an ACTIVE (deleted_at IS NULL) variant: its media_id exists, its blob
// is linkable, its size fits the role, and (class D) its blob is encrypted.
function variantGuardBody(): string {
  return [
    `SELECT CASE WHEN NOT EXISTS(` +
      `SELECT 1 FROM media_objects o WHERE o.tenant_id=NEW.tenant_id AND o.media_id=NEW.media_id` +
      `) THEN RAISE(ABORT,'MEDIA_OBJECT_NOT_FOUND') END;`,
    `SELECT CASE WHEN NOT EXISTS(` +
      `SELECT 1 FROM ${CURRENT_GEN_JOIN} ` +
      `WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id ` +
      `AND b.blob_status='present' AND b.current_generation_no IS NOT NULL AND g.gen_status='available'` +
      `) THEN RAISE(ABORT,'MEDIA_BLOB_NOT_LINKABLE') END;`,
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM ${CURRENT_GEN_JOIN} WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id AND (` +
      `(NEW.variant_type='thumbnail' AND g.byte_size>20000) OR ` +
      `(NEW.variant_type IN ('display','ai_input','document_preview') AND g.content_kind='raster_image' AND g.byte_size>100000))` +
      `) THEN RAISE(ABORT,'MEDIA_VARIANT_SIZE_CONSTRAINT') END;`,
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_objects o WHERE o.tenant_id=NEW.tenant_id AND o.media_id=NEW.media_id AND o.security_class='highly_sensitive'` +
      `) AND EXISTS(` +
      `SELECT 1 FROM ${CURRENT_GEN_JOIN} WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id AND (g.is_encrypted<>1 OR g.dek_version IS NULL)` +
      `) THEN RAISE(ABORT,'MEDIA_CLASS_D_UNENCRYPTED') END;`,
  ].join('\n     ');
}

// The physical/security columns of an 'available' generation are immutable
// in-place; a change requires a new generation_no. IFNULL sentinels catch
// NULL↔value transitions (which `<>` alone would miss).
const AVAILABLE_IMMUTABLE_CHANGED =
  `NEW.storage_key<>OLD.storage_key OR NEW.stored_blob_hash<>OLD.stored_blob_hash OR ` +
  `NEW.byte_size<>OLD.byte_size OR NEW.content_kind<>OLD.content_kind OR ` +
  `NEW.mime_type<>OLD.mime_type OR NEW.extension<>OLD.extension OR NEW.is_encrypted<>OLD.is_encrypted OR ` +
  `IFNULL(NEW.width,-1)<>IFNULL(OLD.width,-1) OR IFNULL(NEW.height,-1)<>IFNULL(OLD.height,-1) OR ` +
  `IFNULL(NEW.page_count,-1)<>IFNULL(OLD.page_count,-1) OR IFNULL(NEW.duration_ms,-1)<>IFNULL(OLD.duration_ms,-1) OR ` +
  `IFNULL(NEW.dek_version,-1)<>IFNULL(OLD.dek_version,-1)`;

// Comprehensive media_object guard, run on INSERT and on any UPDATE that could
// affect validity OR reactivate the row (deleted_at → NULL). Re-checks the FULL
// contract regardless of which column changed (MEDIA-03A-R2 §6): master blob
// linkable, raster master ≤100 KB, origin_branch ⊂ tenant, and (class D) master
// AND every active variant encrypted. Only guards ACTIVE rows (deleted_at NULL).
function mediaObjectGuardBody(): string {
  return [
    `SELECT CASE WHEN NOT EXISTS(` +
      `SELECT 1 FROM ${CURRENT_GEN_JOIN} WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.master_blob_id ` +
      `AND b.blob_status='present' AND b.current_generation_no IS NOT NULL AND g.gen_status='available'` +
      `) THEN RAISE(ABORT,'MEDIA_BLOB_NOT_LINKABLE') END;`,
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM ${CURRENT_GEN_JOIN} WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.master_blob_id ` +
      `AND g.content_kind='raster_image' AND g.byte_size>100000` +
      `) THEN RAISE(ABORT,'MEDIA_MASTER_SIZE_CONSTRAINT') END;`,
    `SELECT CASE WHEN NEW.origin_branch_id IS NOT NULL AND NOT EXISTS(` +
      `SELECT 1 FROM branches b WHERE b.id=NEW.origin_branch_id AND b.tenant_id=NEW.tenant_id` +
      `) THEN RAISE(ABORT,'MEDIA_BRANCH_TENANT') END;`,
    `SELECT CASE WHEN NEW.security_class='highly_sensitive' AND EXISTS(` +
      `SELECT 1 FROM ${CURRENT_GEN_JOIN} WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.master_blob_id ` +
      `AND (g.is_encrypted<>1 OR g.dek_version IS NULL)` +
      `) THEN RAISE(ABORT,'MEDIA_CLASS_D_UNENCRYPTED') END;`,
    `SELECT CASE WHEN NEW.security_class='highly_sensitive' AND EXISTS(` +
      `SELECT 1 FROM media_variants v ` +
      `JOIN media_blobs b ON b.tenant_id=v.tenant_id AND b.blob_id=v.blob_id ` +
      `JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id AND g.generation_no=b.current_generation_no ` +
      `WHERE v.tenant_id=NEW.tenant_id AND v.media_id=NEW.media_id AND v.deleted_at IS NULL ` +
      `AND (g.is_encrypted<>1 OR g.dek_version IS NULL)` +
      `) THEN RAISE(ABORT,'MEDIA_CLASS_D_UNENCRYPTED') END;`,
  ].join('\n     ');
}

// The generation state machine (MEDIA-03A-R2 §4). Only these gen_status
// transitions are permitted; `deleted` and `quarantined` are terminal (no
// automatic exit — quarantined recovery is a later explicit path).
const GEN_VALID_TRANSITION =
  `(OLD.gen_status='writing' AND NEW.gen_status IN ('staged','quarantined')) OR ` +
  `(OLD.gen_status='staged' AND NEW.gen_status IN ('available','quarantined')) OR ` +
  `(OLD.gen_status='available' AND NEW.gen_status IN ('superseded','quarantined')) OR ` +
  `(OLD.gen_status='superseded' AND NEW.gen_status IN ('gc_pending','quarantined')) OR ` +
  `(OLD.gen_status='gc_pending' AND NEW.gen_status IN ('deleted','quarantined'))`;

// ── MEDIA-03B rotation/backup lifecycles (same trigger-carried pattern) ─────
// Tenant key-rotation lifecycle (§4): no backward transitions; done/failed/
// quarantined are terminal. INSERT is pinned to 'accepted' by a separate trigger.
const TENANT_ROTATION_TRANSITION =
  `(OLD.state='accepted' AND NEW.state IN ('bundle_written','failed','quarantined')) OR ` +
  `(OLD.state='bundle_written' AND NEW.state IN ('rotating_blobs','failed','quarantined')) OR ` +
  `(OLD.state='rotating_blobs' AND NEW.state IN ('finalizing','failed','quarantined')) OR ` +
  `(OLD.state='finalizing' AND NEW.state IN ('done','failed','quarantined'))`;

// Per-blob rotation lifecycle (§7): done/failed/quarantined terminal.
const BLOB_ROTATION_TRANSITION =
  `(OLD.state='accepted' AND NEW.state IN ('file_written','failed','quarantined')) OR ` +
  `(OLD.state='file_written' AND NEW.state IN ('staged','failed','quarantined')) OR ` +
  `(OLD.state='staged' AND NEW.state IN ('switched','failed','quarantined')) OR ` +
  `(OLD.state='switched' AND NEW.state IN ('gc_pending','done','failed','quarantined')) OR ` +
  `(OLD.state='gc_pending' AND NEW.state IN ('done','failed','quarantined'))`;

// Backup-set lifecycle (§10): deleted is terminal.
const BACKUP_TRANSITION =
  `(OLD.status='in_progress' AND NEW.status IN ('complete','failed')) OR ` +
  `(OLD.status='complete' AND NEW.status='deleted') OR ` +
  `(OLD.status='failed' AND NEW.status='deleted')`;

// media_rotation_jobs binding (§6/§8): a rotation job must reference (a) a tenant
// key-rotation epoch with matching from/to DEK versions, (b) a blob in the same
// tenant, and (c) real from/to generations of THAT blob whose encryption +
// dek_version match the declared rotation. Cross-tenant / cross-blob generations
// and unencrypted-blob "key rotation" are rejected. The real availability of the
// DEKs in the external key bundle stays the Rust service's responsibility — it is
// NOT faked in SQLite.
function rotationBindingBody(): string {
  return [
    `SELECT CASE WHEN NOT EXISTS(` +
      `SELECT 1 FROM tenant_key_rotation_jobs t WHERE t.tenant_id=NEW.tenant_id ` +
      `AND t.rotation_epoch=NEW.rotation_epoch AND t.from_dek_version=NEW.from_dek_version AND t.to_dek_version=NEW.to_dek_version` +
      `) THEN RAISE(ABORT,'MEDIA_ROTATION_TENANT_JOB') END;`,
    `SELECT CASE WHEN NOT EXISTS(` +
      `SELECT 1 FROM media_blobs b WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id` +
      `) THEN RAISE(ABORT,'MEDIA_ROTATION_BLOB_SCOPE') END;`,
    `SELECT CASE WHEN NOT EXISTS(` +
      `SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.from_generation_no` +
      `) THEN RAISE(ABORT,'MEDIA_ROTATION_GENERATION_SCOPE') END;`,
    `SELECT CASE WHEN NOT EXISTS(` +
      `SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.to_generation_no` +
      `) THEN RAISE(ABORT,'MEDIA_ROTATION_GENERATION_SCOPE') END;`,
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.from_generation_no ` +
      `AND (g.is_encrypted<>1 OR g.dek_version IS NULL)) THEN RAISE(ABORT,'MEDIA_ROTATION_UNENCRYPTED') END;`,
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.to_generation_no ` +
      `AND (g.is_encrypted<>1 OR g.dek_version IS NULL)) THEN RAISE(ABORT,'MEDIA_ROTATION_UNENCRYPTED') END;`,
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.from_generation_no ` +
      `AND g.dek_version<>NEW.from_dek_version) THEN RAISE(ABORT,'MEDIA_ROTATION_DEK_MISMATCH') END;`,
    `SELECT CASE WHEN EXISTS(` +
      `SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.to_generation_no ` +
      `AND g.dek_version<>NEW.to_dek_version) THEN RAISE(ABORT,'MEDIA_ROTATION_DEK_MISMATCH') END;`,
  ].join('\n     ');
}

// MEDIA-03B-R1 §6 — rotation bootstrap (accepted INSERT). The parent tenant epoch
// must be mid-rotation (bundle_written/rotating_blobs); the from-generation must be
// the blob's CURRENT 'available' generation; the to-generation must be a freshly
// prepared 'writing' generation of the same blob. (Existence/DEK/encryption are
// already enforced by rotationBindingBody, which runs first.)
function rotationBootstrapBody(): string {
  return [
    `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tenant_key_rotation_jobs t WHERE t.tenant_id=NEW.tenant_id AND t.rotation_epoch=NEW.rotation_epoch AND t.state IN ('bundle_written','rotating_blobs')) THEN RAISE(ABORT,'MEDIA_ROTATION_PARENT_STATE') END;`,
    `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM media_blobs b WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id AND b.current_generation_no=NEW.from_generation_no) THEN RAISE(ABORT,'MEDIA_ROTATION_BOOTSTRAP') END;`,
    `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.from_generation_no AND g.gen_status='available') THEN RAISE(ABORT,'MEDIA_ROTATION_BOOTSTRAP') END;`,
    `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.to_generation_no AND g.gen_status='writing') THEN RAISE(ABORT,'MEDIA_ROTATION_BOOTSTRAP') END;`,
  ].join('\n     ');
}

// MEDIA-03B-R1 §7/§8 — per-transition rotation progress guards. Each forward child
// state has generation/pointer preconditions, and no forward progress is allowed
// while the parent tenant job is terminal (§8 defence-in-depth; the state itself is
// unreachable because §9 forbids terminalising a parent with active children and
// the bootstrap forbids creating a child under a terminal parent).
function rotationProgressBody(): string {
  const parentRotating = `EXISTS(SELECT 1 FROM tenant_key_rotation_jobs t WHERE t.tenant_id=NEW.tenant_id AND t.rotation_epoch=NEW.rotation_epoch AND t.state='rotating_blobs')`;
  const parentActive = `EXISTS(SELECT 1 FROM tenant_key_rotation_jobs t WHERE t.tenant_id=NEW.tenant_id AND t.rotation_epoch=NEW.rotation_epoch AND t.state NOT IN ('done','failed','quarantined'))`;
  const genIs = (no: string, s: string) => `EXISTS(SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=${no} AND g.gen_status='${s}')`;
  const pointerOnTo = `EXISTS(SELECT 1 FROM media_blobs b WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id AND b.current_generation_no=NEW.to_generation_no)`;
  return [
    `SELECT CASE WHEN NEW.state IN ('file_written','staged','switched','gc_pending') AND NOT (${parentActive}) THEN RAISE(ABORT,'MEDIA_ROTATION_PARENT_STATE') END;`,
    `SELECT CASE WHEN NEW.state='file_written' AND NOT (${parentRotating}) THEN RAISE(ABORT,'MEDIA_ROTATION_PARENT_STATE') END;`,
    `SELECT CASE WHEN NEW.state='file_written' AND NOT (${genIs('NEW.to_generation_no', 'writing')}) THEN RAISE(ABORT,'MEDIA_ROTATION_GEN_STATE') END;`,
    `SELECT CASE WHEN NEW.state='staged' AND NOT (${genIs('NEW.to_generation_no', 'staged')}) THEN RAISE(ABORT,'MEDIA_ROTATION_GEN_STATE') END;`,
    `SELECT CASE WHEN NEW.state='switched' AND NOT (${parentRotating}) THEN RAISE(ABORT,'MEDIA_ROTATION_PARENT_STATE') END;`,
    `SELECT CASE WHEN NEW.state='switched' AND NOT (${pointerOnTo}) THEN RAISE(ABORT,'MEDIA_ROTATION_POINTER') END;`,
    `SELECT CASE WHEN NEW.state='switched' AND NOT (${genIs('NEW.to_generation_no', 'available')}) THEN RAISE(ABORT,'MEDIA_ROTATION_GEN_STATE') END;`,
    `SELECT CASE WHEN NEW.state='switched' AND NOT (${genIs('NEW.from_generation_no', 'superseded')}) THEN RAISE(ABORT,'MEDIA_ROTATION_GEN_STATE') END;`,
    `SELECT CASE WHEN NEW.state='done' AND OLD.state='switched' AND NOT (${pointerOnTo}) THEN RAISE(ABORT,'MEDIA_ROTATION_POINTER') END;`,
  ].join('\n     ');
}

// MEDIA-03B-R1 §9 — tenant completion guard: no orphaned/active children. A parent
// may not go finalizing while a child is still accepted/file_written/staged, and may
// not go done unless EVERY child is done (⇒ none failed/quarantined/active), and may
// not go failed/quarantined while any child is still active.
function tenantCompletionBody(): string {
  const childIn = (states: string) => `EXISTS(SELECT 1 FROM media_rotation_jobs m WHERE m.tenant_id=NEW.tenant_id AND m.rotation_epoch=NEW.rotation_epoch AND m.state IN (${states}))`;
  return [
    `SELECT CASE WHEN NEW.state='finalizing' AND ${childIn(`'accepted','file_written','staged'`)} THEN RAISE(ABORT,'MEDIA_ROTATION_CHILD_ACTIVE') END;`,
    `SELECT CASE WHEN NEW.state='done' AND EXISTS(SELECT 1 FROM media_rotation_jobs m WHERE m.tenant_id=NEW.tenant_id AND m.rotation_epoch=NEW.rotation_epoch AND m.state<>'done') THEN RAISE(ABORT,'MEDIA_ROTATION_CHILD_ACTIVE') END;`,
    `SELECT CASE WHEN NEW.state IN ('failed','quarantined') AND ${childIn(`'accepted','file_written','staged','switched','gc_pending'`)} THEN RAISE(ABORT,'MEDIA_ROTATION_CHILD_ACTIVE') END;`,
  ].join('\n     ');
}

/** Ordered DDL: tables → indexes → triggers. Every statement is idempotent. */
const MEDIA_03A_STATEMENTS: string[] = [
  // ── media_blobs — logical blob identity + current-generation pointer ──
  `CREATE TABLE IF NOT EXISTS media_blobs (
    tenant_id             TEXT NOT NULL,
    blob_id               TEXT NOT NULL,
    dedup_token           TEXT NOT NULL,
    current_generation_no INTEGER,
    blob_status           TEXT NOT NULL DEFAULT 'pending',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    deleted_at            TEXT,
    PRIMARY KEY (tenant_id, blob_id),
    UNIQUE (tenant_id, dedup_token),
    CHECK (blob_status IN ('pending','present','missing','quarantined','gc_pending')),
    CHECK (blob_status <> 'present' OR current_generation_no IS NOT NULL)
  )`,

  // ── media_blob_generations — the ONLY physical-storage SSOT ──
  `CREATE TABLE IF NOT EXISTS media_blob_generations (
    tenant_id        TEXT NOT NULL,
    blob_id          TEXT NOT NULL,
    generation_no    INTEGER NOT NULL,
    storage_key      TEXT NOT NULL,
    stored_blob_hash TEXT NOT NULL,
    byte_size        INTEGER NOT NULL,
    content_kind     TEXT NOT NULL,
    mime_type        TEXT NOT NULL,
    extension        TEXT NOT NULL,
    width            INTEGER,
    height           INTEGER,
    page_count       INTEGER,
    duration_ms      INTEGER,
    is_encrypted     INTEGER NOT NULL DEFAULT 0,
    dek_version      INTEGER,
    gen_status       TEXT NOT NULL DEFAULT 'writing',
    created_at       TEXT NOT NULL,
    superseded_at    TEXT,
    gc_eligible_at   TEXT,
    deleted_at       TEXT,
    PRIMARY KEY (tenant_id, blob_id, generation_no),
    UNIQUE (tenant_id, storage_key),
    CHECK (content_kind IN ('raster_image','pdf','other')),
    CHECK (gen_status IN ('writing','staged','available','superseded','gc_pending','deleted','quarantined')),
    CHECK (is_encrypted IN (0,1)),
    CHECK (is_encrypted = 0 OR dek_version IS NOT NULL),
    CHECK (content_kind <> 'raster_image' OR byte_size <= 100000)
  )`,

  // ── media_objects — logical master medium ──
  `CREATE TABLE IF NOT EXISTS media_objects (
    tenant_id         TEXT NOT NULL,
    media_id          TEXT NOT NULL,
    origin_branch_id  TEXT,
    master_blob_id    TEXT NOT NULL,
    master_kind       TEXT NOT NULL,
    source_type       TEXT NOT NULL,
    security_class    TEXT NOT NULL DEFAULT 'internal',
    retention_class   TEXT NOT NULL DEFAULT 'standard',
    original_filename TEXT,
    ingest_status     TEXT NOT NULL DEFAULT 'pending',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT,
    PRIMARY KEY (tenant_id, media_id),
    CHECK (master_kind IN ('original','normalized')),
    CHECK (security_class IN ('public','internal','sensitive','highly_sensitive')),
    CHECK (retention_class IN ('transient','standard','legal_hold')),
    CHECK (ingest_status IN ('pending','ready','failed','quarantined'))
  )`,

  // ── media_variants — derived renditions ──
  `CREATE TABLE IF NOT EXISTS media_variants (
    tenant_id         TEXT NOT NULL,
    variant_id        TEXT NOT NULL,
    media_id          TEXT NOT NULL,
    variant_type      TEXT NOT NULL,
    transform_version INTEGER NOT NULL,
    blob_id           TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    deleted_at        TEXT,
    PRIMARY KEY (tenant_id, variant_id),
    UNIQUE (tenant_id, media_id, variant_type, transform_version),
    CHECK (variant_type IN ('display','thumbnail','ai_input','document_preview'))
  )`,

  // ── media_links — scope-aware entity ↔ media association ──
  `CREATE TABLE IF NOT EXISTS media_links (
    tenant_id    TEXT NOT NULL,
    link_id      TEXT NOT NULL,
    scope_kind   TEXT NOT NULL,
    branch_id    TEXT,
    entity_type  TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    media_id     TEXT NOT NULL,
    media_role   TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    is_primary   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    deleted_at   TEXT,
    PRIMARY KEY (tenant_id, link_id),
    CHECK (scope_kind IN ('branch','tenant')),
    CHECK ((scope_kind='branch' AND branch_id IS NOT NULL) OR (scope_kind='tenant' AND branch_id IS NULL)),
    CHECK (is_primary IN (0,1)),
    CHECK (entity_type IN (${quotedList(ENTITY_TYPES)}))
  )`,

  // ── media_ingest_jobs — idempotent ingest state machine (no writer yet) ──
  `CREATE TABLE IF NOT EXISTS media_ingest_jobs (
    tenant_id               TEXT NOT NULL,
    job_id                  TEXT NOT NULL,
    ingest_request_id       TEXT NOT NULL,
    request_hash            TEXT,
    scope_kind              TEXT,
    branch_id               TEXT,
    requested_entity_type   TEXT,
    requested_entity_id     TEXT,
    requested_role          TEXT,
    security_class          TEXT,
    retention_class         TEXT,
    transform_profile       TEXT,
    source_temp_key         TEXT,
    source_fingerprint      TEXT,
    hq_temp_key             TEXT,
    hq_temp_encrypted       INTEGER NOT NULL DEFAULT 0,
    target_media_id         TEXT,
    target_blob_id          TEXT,
    state                   TEXT NOT NULL DEFAULT 'accepted',
    attempt_count           INTEGER NOT NULL DEFAULT 0,
    error_code              TEXT,
    error_detail_safe       TEXT,
    result_json             TEXT,
    expires_at              TEXT,
    ai_confirmation_deadline TEXT,
    created_at              TEXT NOT NULL,
    started_at              TEXT,
    completed_at            TEXT,
    updated_at              TEXT NOT NULL,
    PRIMARY KEY (tenant_id, job_id),
    UNIQUE (tenant_id, ingest_request_id),
    CHECK (state IN ('accepted','awaiting_ai','ai_completed','finalizing','cleanup_pending','ready','failed','quarantined','expired'))
  )`,

  // ── indexes ──
  `CREATE INDEX IF NOT EXISTS ix_mo_master ON media_objects(tenant_id, master_blob_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_mv_master ON media_variants(tenant_id, media_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_mv_blob   ON media_variants(tenant_id, blob_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_ml_entity ON media_links(tenant_id, entity_type, entity_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_ml_media  ON media_links(tenant_id, media_id) WHERE deleted_at IS NULL`,
  // scope-aware partial-unique indexes (§8)
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_primary_branch ON media_links(tenant_id, branch_id, entity_type, entity_id, media_role)
     WHERE scope_kind='branch' AND is_primary=1 AND deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_primary_tenant ON media_links(tenant_id, entity_type, entity_id, media_role)
     WHERE scope_kind='tenant' AND is_primary=1 AND deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_nat_branch ON media_links(tenant_id, branch_id, entity_type, entity_id, media_id, media_role)
     WHERE scope_kind='branch' AND deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_ml_nat_tenant ON media_links(tenant_id, entity_type, entity_id, media_id, media_role)
     WHERE scope_kind='tenant' AND deleted_at IS NULL`,

  // ── current-generation guards: pointer may only target an 'available' gen ──
  `CREATE TRIGGER IF NOT EXISTS trg_mb_pointer_available_ins
   BEFORE INSERT ON media_blobs
   WHEN NEW.current_generation_no IS NOT NULL
   BEGIN
     SELECT CASE WHEN NOT EXISTS(
       SELECT 1 FROM media_blob_generations g
       WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id
         AND g.generation_no=NEW.current_generation_no AND g.gen_status='available'
     ) THEN RAISE(ABORT,'MEDIA_POINTER_NOT_AVAILABLE') END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mb_pointer_available_upd
   BEFORE UPDATE OF current_generation_no ON media_blobs
   WHEN NEW.current_generation_no IS NOT NULL
   BEGIN
     SELECT CASE WHEN NOT EXISTS(
       SELECT 1 FROM media_blob_generations g
       WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id
         AND g.generation_no=NEW.current_generation_no AND g.gen_status='available'
     ) THEN RAISE(ABORT,'MEDIA_POINTER_NOT_AVAILABLE') END;
   END`,
  // a generation the pointer targets may not be moved off 'available'
  `CREATE TRIGGER IF NOT EXISTS trg_mbg_current_status_lock
   BEFORE UPDATE OF gen_status ON media_blob_generations
   WHEN NEW.gen_status<>'available' AND EXISTS(
     SELECT 1 FROM media_blobs b
     WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id AND b.current_generation_no=NEW.generation_no
   )
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_CURRENT_GENERATION_STATUS_LOCKED');
   END`,
  // reverse-pointer guard: a switch must not invalidate existing usages
  `CREATE TRIGGER IF NOT EXISTS trg_mb_reverse_guard_upd
   BEFORE UPDATE OF current_generation_no ON media_blobs
   WHEN NEW.current_generation_no IS NOT NULL
     AND (OLD.current_generation_no IS NULL OR NEW.current_generation_no<>OLD.current_generation_no)
   BEGIN
     ${reversePointerGuardBody()}
   END`,

  // ── comprehensive media_objects guard (INSERT + reactivation-aware UPDATE) ──
  // Fires on any change to deleted_at/security_class/master_blob_id/tenant_id/
  // origin_branch_id and re-runs the FULL contract when the row is active — so a
  // reactivation (deleted_at → NULL) cannot smuggle in an invalid state.
  `CREATE TRIGGER IF NOT EXISTS trg_mo_guard_ins
   BEFORE INSERT ON media_objects
   WHEN NEW.deleted_at IS NULL
   BEGIN
     ${mediaObjectGuardBody()}
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mo_guard_upd
   BEFORE UPDATE OF deleted_at, security_class, master_blob_id, tenant_id, origin_branch_id ON media_objects
   WHEN NEW.deleted_at IS NULL
   BEGIN
     ${mediaObjectGuardBody()}
   END`,

  // ── generation state machine (MEDIA-03A-R2 §4): entry states + transitions ──
  `CREATE TRIGGER IF NOT EXISTS trg_mbg_insert_state
   BEFORE INSERT ON media_blob_generations
   WHEN NEW.gen_status NOT IN ('writing','staged','available','quarantined')
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_GENERATION_STATE_TRANSITION');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mbg_status_transition
   BEFORE UPDATE OF gen_status ON media_blob_generations
   WHEN NEW.gen_status<>OLD.gen_status AND NOT (${GEN_VALID_TRANSITION})
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_GENERATION_STATE_TRANSITION');
   END`,

  // ── linkable-blob + role-size + class-D guards on media_variants (ins+upd) ──
  // The UPDATE trigger re-runs the full contract on any change to the linked
  // blob/object/role OR on reactivation (deleted_at → NULL), per MEDIA-03A-R1.
  `CREATE TRIGGER IF NOT EXISTS trg_mv_linkable_ins
   BEFORE INSERT ON media_variants
   WHEN NEW.deleted_at IS NULL
   BEGIN
     ${variantGuardBody()}
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mv_linkable_upd
   BEFORE UPDATE OF blob_id, media_id, variant_type, deleted_at ON media_variants
   WHEN NEW.deleted_at IS NULL
   BEGIN
     ${variantGuardBody()}
   END`,

  // ── available generations are immutable in-place (MEDIA-03A-R1 §4) ──
  `CREATE TRIGGER IF NOT EXISTS trg_mbg_available_immutable
   BEFORE UPDATE ON media_blob_generations
   WHEN OLD.gen_status='available' AND (${AVAILABLE_IMMUTABLE_CHANGED})
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_AVAILABLE_GENERATION_IMMUTABLE');
   END`,

  // (security-class-upgrade + origin_branch guards are folded into trg_mo_guard_* above.)

  // ── ingest-job scope + branch⊂tenant (MEDIA-03A-R1 §7) ──
  `CREATE TRIGGER IF NOT EXISTS trg_mij_scope_ins
   BEFORE INSERT ON media_ingest_jobs
   BEGIN
     SELECT CASE WHEN NEW.scope_kind='branch' AND NEW.branch_id IS NULL THEN RAISE(ABORT,'MEDIA_INGEST_SCOPE') END;
     SELECT CASE WHEN NEW.scope_kind='tenant' AND NEW.branch_id IS NOT NULL THEN RAISE(ABORT,'MEDIA_INGEST_SCOPE') END;
     SELECT CASE WHEN NEW.scope_kind='branch' AND NEW.branch_id IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM branches b WHERE b.id=NEW.branch_id AND b.tenant_id=NEW.tenant_id
     ) THEN RAISE(ABORT,'MEDIA_BRANCH_TENANT') END;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mij_scope_upd
   BEFORE UPDATE OF scope_kind, branch_id ON media_ingest_jobs
   BEGIN
     SELECT CASE WHEN NEW.scope_kind='branch' AND NEW.branch_id IS NULL THEN RAISE(ABORT,'MEDIA_INGEST_SCOPE') END;
     SELECT CASE WHEN NEW.scope_kind='tenant' AND NEW.branch_id IS NOT NULL THEN RAISE(ABORT,'MEDIA_INGEST_SCOPE') END;
     SELECT CASE WHEN NEW.scope_kind='branch' AND NEW.branch_id IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM branches b WHERE b.id=NEW.branch_id AND b.tenant_id=NEW.tenant_id
     ) THEN RAISE(ABORT,'MEDIA_BRANCH_TENANT') END;
   END`,

  // ── entity-scope guards on media_links (generated from the SSOT) ──
  `CREATE TRIGGER IF NOT EXISTS trg_ml_entity_scope_ins
   BEFORE INSERT ON media_links
   BEGIN
     ${entityScopeChecks()}
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_ml_entity_scope_upd
   BEFORE UPDATE OF entity_type, entity_id, branch_id, scope_kind ON media_links
   BEGIN
     ${entityScopeChecks()}
   END`,
];

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-03B — additive INACTIVE rotation + backup schema (4 tables). Still no
// writer, no key rotation, no backup run: the triggers only fire on media_* writes.
// ════════════════════════════════════════════════════════════════════════════
const MEDIA_03B_STATEMENTS: string[] = [
  // ── tenant_key_rotation_jobs — one epoch = one tenant DEK-bundle rotation ──
  `CREATE TABLE IF NOT EXISTS tenant_key_rotation_jobs (
    tenant_id            TEXT NOT NULL,
    rotation_epoch       INTEGER NOT NULL,
    from_bundle_revision INTEGER NOT NULL,
    to_bundle_revision   INTEGER NOT NULL,
    from_dek_version     INTEGER NOT NULL,
    to_dek_version       INTEGER NOT NULL,
    state                TEXT NOT NULL DEFAULT 'accepted',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    completed_at         TEXT,
    PRIMARY KEY (tenant_id, rotation_epoch),
    CHECK (from_bundle_revision >= 0),
    CHECK (to_bundle_revision = from_bundle_revision + 1),
    CHECK (from_dek_version <> to_dek_version),
    CHECK (state IN ('accepted','bundle_written','rotating_blobs','finalizing','done','failed','quarantined'))
  )`,

  // ── media_rotation_jobs — one per (tenant, blob) rotation within an epoch ──
  `CREATE TABLE IF NOT EXISTS media_rotation_jobs (
    tenant_id          TEXT NOT NULL,
    rotation_job_id    TEXT NOT NULL,
    rotation_epoch     INTEGER NOT NULL,
    blob_id            TEXT NOT NULL,
    from_generation_no INTEGER NOT NULL,
    to_generation_no   INTEGER NOT NULL,
    from_dek_version   INTEGER NOT NULL,
    to_dek_version     INTEGER NOT NULL,
    state              TEXT NOT NULL DEFAULT 'accepted',
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    error_code         TEXT,
    error_detail_safe  TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    completed_at       TEXT,
    PRIMARY KEY (tenant_id, rotation_job_id),
    CHECK (from_generation_no <> to_generation_no),
    CHECK (from_dek_version <> to_dek_version),
    CHECK (attempt_count >= 0),
    CHECK (state IN ('accepted','file_written','staged','switched','gc_pending','done','failed','quarantined'))
  )`,

  // ── media_backup_sets — a durable backup snapshot of pinned generations ──
  // manifest_hash: lowercase hex SHA-256 (64 chars) over the canonically
  // serialized backup manifest (sorted keys, UTF-8, no insignificant whitespace).
  // Required once the set is 'complete'.
  `CREATE TABLE IF NOT EXISTS media_backup_sets (
    tenant_id     TEXT NOT NULL,
    backup_id     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'in_progress',
    manifest_hash TEXT,
    created_at    TEXT NOT NULL,
    completed_at  TEXT,
    deleted_at    TEXT,
    PRIMARY KEY (tenant_id, backup_id),
    CHECK (status IN ('in_progress','complete','failed','deleted')),
    CHECK (status <> 'complete' OR manifest_hash IS NOT NULL),
    CHECK (manifest_hash IS NULL OR length(manifest_hash) = 64),
    CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
  )`,

  // ── media_backup_generation_pins — immutable pin: backup ⇒ exact generation ──
  `CREATE TABLE IF NOT EXISTS media_backup_generation_pins (
    tenant_id     TEXT NOT NULL,
    backup_id     TEXT NOT NULL,
    blob_id       TEXT NOT NULL,
    generation_no INTEGER NOT NULL,
    pinned_at     TEXT NOT NULL,
    released_at   TEXT,
    PRIMARY KEY (tenant_id, backup_id, blob_id, generation_no)
  )`,

  // ── one active job per tenant / per blob (§3/§5). Enforced STRUCTURALLY by a
  //    partial UNIQUE index; the trg_*_one_active triggers below fire first only to
  //    surface a stable DOMAIN error code (MEDIA_*_ROTATION_ACTIVE) instead of the
  //    raw "UNIQUE constraint failed" — they do not replace the index. (R1 briefly
  //    swapped the UNIQUE index for triggers to dodge a suspected sql.js phantom;
  //    MEDIA-03B-R2 could not reproduce that on a single connection with direct
  //    db.run in any minimal or full scenario, so the stronger UNIQUE DDL is back.) ──
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_tkrj_active ON tenant_key_rotation_jobs(tenant_id) WHERE state NOT IN ('done','failed','quarantined')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_mrj_active ON media_rotation_jobs(tenant_id, blob_id) WHERE state NOT IN ('done','failed','quarantined')`,
  `CREATE INDEX IF NOT EXISTS ix_mrj_epoch ON media_rotation_jobs(tenant_id, rotation_epoch)`,
  `CREATE INDEX IF NOT EXISTS ix_mbgp_gen ON media_backup_generation_pins(tenant_id, blob_id, generation_no) WHERE released_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_mbgp_backup ON media_backup_generation_pins(tenant_id, backup_id) WHERE released_at IS NULL`,

  // ── tenant rotation state machine (§4) ──
  `CREATE TRIGGER IF NOT EXISTS trg_tkrj_insert_state
   BEFORE INSERT ON tenant_key_rotation_jobs
   WHEN NEW.state <> 'accepted'
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_TENANT_ROTATION_STATE');
   END`,
  // at most one non-terminal (active) rotation job per tenant (§3)
  `CREATE TRIGGER IF NOT EXISTS trg_tkrj_one_active
   BEFORE INSERT ON tenant_key_rotation_jobs
   WHEN NEW.state NOT IN ('done','failed','quarantined') AND EXISTS(
     SELECT 1 FROM tenant_key_rotation_jobs t WHERE t.tenant_id=NEW.tenant_id AND t.state NOT IN ('done','failed','quarantined')
   )
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_TENANT_ROTATION_ACTIVE');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_tkrj_transition
   BEFORE UPDATE OF state ON tenant_key_rotation_jobs
   WHEN NEW.state<>OLD.state AND NOT (${TENANT_ROTATION_TRANSITION})
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_TENANT_ROTATION_STATE');
   END`,

  // ── per-blob rotation state machine (§7) ──
  `CREATE TRIGGER IF NOT EXISTS trg_mrj_insert_state
   BEFORE INSERT ON media_rotation_jobs
   WHEN NEW.state <> 'accepted'
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_ROTATION_STATE');
   END`,
  // at most one non-terminal (active) rotation job per (tenant, blob) (§5)
  `CREATE TRIGGER IF NOT EXISTS trg_mrj_one_active
   BEFORE INSERT ON media_rotation_jobs
   WHEN NEW.state NOT IN ('done','failed','quarantined') AND EXISTS(
     SELECT 1 FROM media_rotation_jobs m WHERE m.tenant_id=NEW.tenant_id AND m.blob_id=NEW.blob_id AND m.state NOT IN ('done','failed','quarantined')
   )
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_ROTATION_ACTIVE');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mrj_transition
   BEFORE UPDATE OF state ON media_rotation_jobs
   WHEN NEW.state<>OLD.state AND NOT (${BLOB_ROTATION_TRANSITION})
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_ROTATION_STATE');
   END`,

  // ── rotation admission (§6/§8): INSERT runs binding THEN bootstrap in one
  //    trigger so the surfaced error code is deterministic (SQLite does not
  //    guarantee ordering between separate triggers on the same event) ──
  `CREATE TRIGGER IF NOT EXISTS trg_mrj_binding_ins
   BEFORE INSERT ON media_rotation_jobs
   BEGIN
     ${rotationBindingBody()}
     ${rotationBootstrapBody()}
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mrj_binding_upd
   BEFORE UPDATE OF rotation_epoch, blob_id, from_generation_no, to_generation_no, from_dek_version, to_dek_version ON media_rotation_jobs
   BEGIN
     ${rotationBindingBody()}
   END`,

  // ── backup-set state machine (§10) ──
  `CREATE TRIGGER IF NOT EXISTS trg_mbs_insert_state
   BEFORE INSERT ON media_backup_sets
   WHEN NEW.status <> 'in_progress'
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_BACKUP_STATE');
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mbs_transition
   BEFORE UPDATE OF status ON media_backup_sets
   WHEN NEW.status<>OLD.status AND NOT (${BACKUP_TRANSITION})
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_BACKUP_STATE');
   END`,
  // on deletion, release ONLY this backup's still-active pins (§14)
  `CREATE TRIGGER IF NOT EXISTS trg_mbs_delete_release
   AFTER UPDATE OF status ON media_backup_sets
   WHEN NEW.status='deleted' AND OLD.status<>'deleted'
   BEGIN
     UPDATE media_backup_generation_pins SET released_at = NEW.deleted_at
      WHERE tenant_id=NEW.tenant_id AND backup_id=NEW.backup_id AND released_at IS NULL;
   END`,

  // ── backup pin creation contract (§11/§12): active pin ⇒ in-progress backup,
  //    the blob's CURRENT generation, and that generation is 'available' ──
  `CREATE TRIGGER IF NOT EXISTS trg_mbgp_insert
   BEFORE INSERT ON media_backup_generation_pins
   BEGIN
     SELECT CASE WHEN NEW.released_at IS NOT NULL THEN RAISE(ABORT,'MEDIA_BACKUP_PIN_CONTRACT') END;
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM media_backup_sets s WHERE s.tenant_id=NEW.tenant_id AND s.backup_id=NEW.backup_id AND s.status='in_progress') THEN RAISE(ABORT,'MEDIA_BACKUP_PIN_BACKUP') END;
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM media_blobs b WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id) THEN RAISE(ABORT,'MEDIA_BACKUP_PIN_BLOB') END;
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM media_blobs b WHERE b.tenant_id=NEW.tenant_id AND b.blob_id=NEW.blob_id AND b.current_generation_no=NEW.generation_no) THEN RAISE(ABORT,'MEDIA_BACKUP_PIN_NOT_CURRENT') END;
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM media_blob_generations g WHERE g.tenant_id=NEW.tenant_id AND g.blob_id=NEW.blob_id AND g.generation_no=NEW.generation_no AND g.gen_status='available') THEN RAISE(ABORT,'MEDIA_BACKUP_PIN_GENERATION') END;
   END`,
  // pin immutability (§13): identity frozen; released_at only NULL → value, once
  `CREATE TRIGGER IF NOT EXISTS trg_mbgp_immutable
   BEFORE UPDATE ON media_backup_generation_pins
   BEGIN
     SELECT CASE WHEN NEW.tenant_id<>OLD.tenant_id OR NEW.backup_id<>OLD.backup_id OR NEW.blob_id<>OLD.blob_id OR NEW.generation_no<>OLD.generation_no OR NEW.pinned_at<>OLD.pinned_at THEN RAISE(ABORT,'MEDIA_BACKUP_PIN_IMMUTABLE') END;
     SELECT CASE WHEN OLD.released_at IS NOT NULL AND (NEW.released_at IS NULL OR NEW.released_at<>OLD.released_at) THEN RAISE(ABORT,'MEDIA_BACKUP_PIN_IMMUTABLE') END;
   END`,

  // ── GC guard (§15): a generation with ≥1 active pin cannot enter gc_pending/
  //    deleted. Composes WITH the generation state machine (both must pass). ──
  `CREATE TRIGGER IF NOT EXISTS trg_mbg_gc_pin_guard
   BEFORE UPDATE OF gen_status ON media_blob_generations
   WHEN NEW.gen_status IN ('gc_pending','deleted') AND NEW.gen_status<>OLD.gen_status AND EXISTS(
     SELECT 1 FROM media_backup_generation_pins p
     WHERE p.tenant_id=NEW.tenant_id AND p.blob_id=NEW.blob_id AND p.generation_no=NEW.generation_no AND p.released_at IS NULL
   )
   BEGIN
     SELECT RAISE(ABORT,'MEDIA_GENERATION_BACKUP_PINNED');
   END`,

  // ══════════════════════════════════════════════════════════════════════════
  // MEDIA-03B-R1 — lifecycle immutability, hard-delete guards, pin-release
  // authorization, backup-metadata freeze, rotation bootstrap + coupling. All
  // additive; still fully inactive (triggers only fire on media_* writes).
  // ══════════════════════════════════════════════════════════════════════════

  // ── §1 lifecycle identity immutable (these rows are tombstone/history) ──
  `CREATE TRIGGER IF NOT EXISTS trg_tkrj_identity
   BEFORE UPDATE OF tenant_id, rotation_epoch, from_bundle_revision, to_bundle_revision, from_dek_version, to_dek_version, created_at ON tenant_key_rotation_jobs
   BEGIN SELECT RAISE(ABORT,'MEDIA_LIFECYCLE_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mrj_identity
   BEFORE UPDATE OF tenant_id, rotation_job_id, rotation_epoch, blob_id, from_generation_no, to_generation_no, from_dek_version, to_dek_version, created_at ON media_rotation_jobs
   BEGIN SELECT RAISE(ABORT,'MEDIA_LIFECYCLE_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mbs_identity
   BEFORE UPDATE OF tenant_id, backup_id, created_at ON media_backup_sets
   BEGIN SELECT RAISE(ABORT,'MEDIA_LIFECYCLE_IMMUTABLE'); END`,
  // (media_backup_generation_pins identity is already frozen by trg_mbgp_immutable.)

  // ── §2 hard-delete forbidden (tombstone/history rows — no epoch/id reuse) ──
  `CREATE TRIGGER IF NOT EXISTS trg_tkrj_no_delete BEFORE DELETE ON tenant_key_rotation_jobs BEGIN SELECT RAISE(ABORT,'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mrj_no_delete BEFORE DELETE ON media_rotation_jobs BEGIN SELECT RAISE(ABORT,'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mbs_no_delete BEFORE DELETE ON media_backup_sets BEGIN SELECT RAISE(ABORT,'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_mbgp_no_delete BEFORE DELETE ON media_backup_generation_pins BEGIN SELECT RAISE(ABORT,'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN'); END`,

  // ── §3 generation hard-delete forbidden (gen_status='deleted' is the tombstone);
  //    an active backup pin surfaces the specific pinned error first ──
  `CREATE TRIGGER IF NOT EXISTS trg_mbg_no_delete
   BEFORE DELETE ON media_blob_generations
   BEGIN
     SELECT CASE WHEN EXISTS(SELECT 1 FROM media_backup_generation_pins p WHERE p.tenant_id=OLD.tenant_id AND p.blob_id=OLD.blob_id AND p.generation_no=OLD.generation_no AND p.released_at IS NULL) THEN RAISE(ABORT,'MEDIA_GENERATION_BACKUP_PINNED') END;
     SELECT RAISE(ABORT,'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN');
   END`,

  // ── §4 pin release authorization: a manual NULL→value release is only permitted
  //    once the parent backup is 'deleted'. The automatic path (trg_mbs_delete_release)
  //    already set the backup to 'deleted' before touching pins, so it passes. ──
  `CREATE TRIGGER IF NOT EXISTS trg_mbgp_release_auth
   BEFORE UPDATE OF released_at ON media_backup_generation_pins
   WHEN OLD.released_at IS NULL AND NEW.released_at IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM media_backup_sets s WHERE s.tenant_id=NEW.tenant_id AND s.backup_id=NEW.backup_id AND s.status='deleted'
   )
   BEGIN SELECT RAISE(ABORT,'MEDIA_BACKUP_PIN_RELEASE_NOT_ALLOWED'); END`,

  // ── §5 backup metadata freeze ──
  //   completion requires a 64-lowercase-hex manifest_hash + completed_at
  `CREATE TRIGGER IF NOT EXISTS trg_mbs_complete_meta
   BEFORE UPDATE OF status ON media_backup_sets
   WHEN NEW.status='complete' AND OLD.status<>'complete'
   BEGIN
     SELECT CASE WHEN NEW.manifest_hash IS NULL OR length(NEW.manifest_hash)<>64 OR NEW.manifest_hash GLOB '*[^0-9a-f]*' THEN RAISE(ABORT,'MEDIA_BACKUP_METADATA_REQUIRED') END;
     SELECT CASE WHEN NEW.completed_at IS NULL THEN RAISE(ABORT,'MEDIA_BACKUP_METADATA_REQUIRED') END;
   END`,
  //   after completion manifest_hash + completed_at are immutable; deleted_at, once set, is immutable
  `CREATE TRIGGER IF NOT EXISTS trg_mbs_meta_immutable
   BEFORE UPDATE ON media_backup_sets
   BEGIN
     SELECT CASE WHEN OLD.status IN ('complete','deleted') AND IFNULL(NEW.manifest_hash,'')<>IFNULL(OLD.manifest_hash,'') THEN RAISE(ABORT,'MEDIA_BACKUP_METADATA_IMMUTABLE') END;
     SELECT CASE WHEN OLD.status IN ('complete','deleted') AND IFNULL(NEW.completed_at,'')<>IFNULL(OLD.completed_at,'') THEN RAISE(ABORT,'MEDIA_BACKUP_METADATA_IMMUTABLE') END;
     SELECT CASE WHEN OLD.deleted_at IS NOT NULL AND IFNULL(NEW.deleted_at,'')<>IFNULL(OLD.deleted_at,'') THEN RAISE(ABORT,'MEDIA_BACKUP_METADATA_IMMUTABLE') END;
   END`,

  // (§6 rotation bootstrap is folded into trg_mrj_binding_ins above for a
  //  deterministic error-code order: binding checks first, then bootstrap.)

  // ── §7/§8 per-transition rotation progress guards ──
  `CREATE TRIGGER IF NOT EXISTS trg_mrj_progress_guard
   BEFORE UPDATE OF state ON media_rotation_jobs
   WHEN NEW.state<>OLD.state
   BEGIN
     ${rotationProgressBody()}
   END`,

  // ── §9 tenant completion guard ──
  `CREATE TRIGGER IF NOT EXISTS trg_tkrj_completion_guard
   BEFORE UPDATE OF state ON tenant_key_rotation_jobs
   WHEN NEW.state<>OLD.state
   BEGIN
     ${tenantCompletionBody()}
   END`,
];

/** The full media DDL: MEDIA-03A core followed by MEDIA-03B rotation/backup.
 *  Ordered tables → indexes → triggers; every statement is idempotent. */
export const MEDIA_SCHEMA_STATEMENTS: string[] = [...MEDIA_03A_STATEMENTS, ...MEDIA_03B_STATEMENTS];

/** The MEDIA-03A subset alone (six core tables) — exported so the upgrade test
 *  can reconstruct a pre-03B database and prove 03B adds exactly the four new
 *  tables without disturbing the six. */
export { MEDIA_03A_STATEMENTS };

/**
 * Apply the media schema idempotently to a sql.js Database. Safe to call on
 * every startup (all statements are IF NOT EXISTS). No data is written and no
 * runtime workflow is activated by this call.
 */
export function applyMediaSchema(database: { run: (sql: string) => void }): void {
  for (const sql of MEDIA_SCHEMA_STATEMENTS) {
    database.run(sql);
  }
}
