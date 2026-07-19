// ════════════════════════════════════════════════════════════════════════════
// MEDIA-03A — Additive, INACTIVE core media schema (content-addressed store).
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
// ════════════════════════════════════════════════════════════════════════════

/** The six core tables added in MEDIA-03A. (Rotation/backup tables follow in 03B.) */
export const MEDIA_TABLES = [
  'media_blobs',
  'media_blob_generations',
  'media_objects',
  'media_variants',
  'media_links',
  'media_ingest_jobs',
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

/** Ordered DDL: tables → indexes → triggers. Every statement is idempotent. */
export const MEDIA_SCHEMA_STATEMENTS: string[] = [
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
