// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-2B1 — SQL.js media metadata coordinator.
//
// Bridges a *finalized* Rust ingest (published main + thumbnail files, verified
// by hash) into the six media_* tables in a single atomic sql.js transaction.
// Never writes image bytes into the DB, never registers a media_* table into
// the sync allowlist, never mutates products.images or any other legacy column.
//
// The service is INACTIVE outside its own test suite: no React caller wires
// it into a productive DB yet. The caller injects both the sql.js `Database`
// handle and the `MediaCommandGateway`, so tests use a temp DB + a fake
// gateway while production will bind to `getDatabase()` + `TauriMediaGateway`
// in a later slice.
// ════════════════════════════════════════════════════════════════════════════

import {
  blobIdFor,
  dedupTokenFor,
  linkIdFor,
  mediaIdFor,
  variantIdFor,
} from './ids.ts';
import type {
  CommitResult,
  MediaBytes,
  MediaCommandGateway,
  PrepareResult,
  RustStoredDescriptor,
} from './gateway.ts';

// ── error contract ──────────────────────────────────────────────────────────
//
// Stable string codes. Every failure surfaced by the coordinator maps to one
// of these; `CoordinatorError.code` is what the caller compares against.

export type CoordinatorErrorCode =
  | 'MEDIA_INGEST_REQUEST_CONFLICT'
  | 'MEDIA_INGEST_JOB_INVALID_STATE'
  | 'MEDIA_INGEST_VERIFICATION_FAILED'
  | 'MEDIA_INGEST_FILE_MISSING'
  | 'MEDIA_INGEST_HASH_MISMATCH'
  | 'MEDIA_DB_MEDIA_CONFLICT'
  | 'MEDIA_DB_LINK_NOT_FOUND'
  | 'MEDIA_DB_ENTITY_NOT_FOUND'
  | 'MEDIA_INVALID_INPUT';

export class CoordinatorError extends Error {
  readonly code: CoordinatorErrorCode;
  constructor(code: CoordinatorErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'CoordinatorError';
  }
}

// ── input DTOs ──────────────────────────────────────────────────────────────

export interface FinalizeInput {
  tenantId: string;
  branchId: string | null; // required when scopeKind='branch'; null for tenant scope
  ingestRequestId: string;
  requestHash: string; // canonical hash from prepareStockImage
  entityType: string;
  entityId: string;
  scopeKind: 'branch' | 'tenant';
  role: string;
  /**
   * Link options — see LINK_INTENT_CANONICAL below. In this slice these
   * are canonical constants (true / 0). Passing anything else is rejected
   * before any DB or Rust-gateway work. If a later slice needs to freeze
   * per-request link options for recovery, it will do so in a purpose-built
   * schema slot; the current media_ingest_jobs manifest has no field
   * suitable for storing them, so silently guessing them at recover time is
   * not an option we take.
   */
  isPrimary?: boolean;
  sortOrder?: number;
  securityClass?: 'public' | 'internal' | 'sensitive' | 'highly_sensitive';
  retentionClass?: 'transient' | 'standard' | 'legal_hold';
}

/**
 * The 2B1 link-intent contract. Both values are constants; a caller passing
 * anything else fails input validation with MEDIA_INVALID_INPUT before we
 * touch the DB or the Rust core. Recovery uses these same constants, so its
 * output byte-matches a first-time finalize with identical intent.
 */
export const LINK_INTENT_CANONICAL = {
  isPrimary: true,
  sortOrder: 0,
} as const;

/**
 * A "same-request" replace: finalize the new ingest exactly like a fresh
 * finalize, then deactivate the identified prior link within the same tx.
 * The old link only ever drops after the new link is durably in place.
 */
export interface ReplaceInput extends FinalizeInput {
  previousLinkId: string;
}

export interface RemoveLinkInput {
  tenantId: string;
  linkId: string;
}

// ── result DTOs ─────────────────────────────────────────────────────────────

export interface FinalizeResult {
  jobId: string;
  ingestRequestId: string;
  requestHash: string;
  state: 'ready';
  mediaId: string;
  mainBlobId: string;
  thumbnailBlobId: string;
  variantId: string;
  linkId: string;
  main: RustStoredDescriptor & { storage_key: string };
  thumbnail: RustStoredDescriptor & { storage_key: string };
}

/**
 * The pre-publication intent snapshot stored in `media_ingest_jobs.result_json`
 * between `registerPendingIntent` and `finalize`. Carrying the descriptors +
 * derived storage keys here lets recovery converge from Disk alone — the DB
 * side does not depend on the Rust journal to know WHAT to reconstruct.
 */
export interface PendingIntentPayload {
  kind: 'intent';
  main: RustStoredDescriptor & { storage_key: string };
  thumbnail: RustStoredDescriptor & { storage_key: string };
}

export interface RecoveryReport {
  tenantId: string;
  ingestRequestId: string;
  jobState: string;
  action:
    | 'noop_already_ready'
    | 'noop_terminal_state'
    | 'finalized_from_ready_rust'
    | 'left_pending_no_rust_result'
    | 'left_pending_no_manifest'
    | 'quarantined_verification_failed';
}

// ── the ambient sql.js `Database` handle ───────────────────────────────────
//
// We type only the two calls we actually use so the coordinator stays free
// of a hard dependency on the `sql.js` types (which are not exposed at the
// project's TS layer).

interface RawDb {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

// ── the service ─────────────────────────────────────────────────────────────

export class MediaDbCoordinator {
  private readonly db: RawDb;
  private readonly gateway: MediaCommandGateway;

  constructor(db: RawDb, gateway: MediaCommandGateway) {
    this.db = db;
    this.gateway = gateway;
  }

  // ── read-only helpers ────────────────────────────────────────────────────

  private jobRow(
    tenantId: string,
    ingestRequestId: string,
  ): Record<string, unknown> | null {
    return firstRow(
      this.db,
      `SELECT * FROM media_ingest_jobs
        WHERE tenant_id = $t AND ingest_request_id = $r`,
      { $t: tenantId, $r: ingestRequestId },
    );
  }

  private blobGenerationRow(
    tenantId: string,
    blobId: string,
    generationNo: number,
  ): Record<string, unknown> | null {
    return firstRow(
      this.db,
      `SELECT * FROM media_blob_generations
        WHERE tenant_id = $t AND blob_id = $b AND generation_no = $g`,
      { $t: tenantId, $b: blobId, $g: generationNo },
    );
  }

  private linkRow(
    tenantId: string,
    linkId: string,
  ): Record<string, unknown> | null {
    return firstRow(
      this.db,
      `SELECT * FROM media_links
        WHERE tenant_id = $t AND link_id = $l`,
      { $t: tenantId, $l: linkId },
    );
  }

  // ── public API ───────────────────────────────────────────────────────────

  /**
   * Register the pre-publication intent for an ingest. Creates (or updates)
   * `media_ingest_jobs` with the full recovery manifest — scope, entity, role,
   * class + the expected main/thumbnail descriptors and derived storage keys —
   * so that a crash between checkpoint 1 (this call's save) and finalize
   * still leaves enough on-disk state to converge.
   *
   * Idempotent: repeated calls with the same request identity and prepared
   * descriptors are no-ops. Conflicting hash → MEDIA_INGEST_REQUEST_CONFLICT;
   * conflicting descriptors → MEDIA_DB_MEDIA_CONFLICT. If the job is already
   * `ready`, this is a no-op (finalize has already frozen the result).
   *
   * Writes only the job row — NO blobs, generations, objects, variants or
   * links are opened here. The Rust files are not published yet.
   */
  registerPendingIntent(input: FinalizeInput, prepared: PrepareResult): void {
    validateFinalizeInput(input);
    if (prepared.request_hash !== input.requestHash) {
      // The caller must pass through the identical hash on both fronts —
      // anything else is a programmer error, not a recoverable conflict.
      throw new CoordinatorError('MEDIA_INVALID_INPUT');
    }
    const intent = intentPayloadFor(input.tenantId, prepared);
    const now = timestamp();
    const existing = this.jobRow(input.tenantId, input.ingestRequestId);
    if (existing) {
      if (existing.request_hash !== input.requestHash) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
      }
      if (existing.state === 'ready') {
        // Already finalized — register is a no-op.
        return;
      }
      // Verify prior intent (if any) matches. A prepared with different
      // descriptors under the same request_hash is a hard content conflict.
      const prior = parseCachedIntent(existing.result_json);
      if (prior && !intentsEqual(prior, intent)) {
        throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
      }
      this.db.run(
        `UPDATE media_ingest_jobs
            SET state = 'accepted',
                request_hash = $h,
                scope_kind = $sk,
                branch_id = $br,
                requested_entity_type = $et,
                requested_entity_id = $ei,
                requested_role = $role,
                security_class = $sc,
                retention_class = $rc,
                result_json = $j,
                updated_at = $now
          WHERE tenant_id = $t AND ingest_request_id = $r`,
        [
          input.requestHash,
          input.scopeKind,
          input.branchId,
          input.entityType,
          input.entityId,
          input.role,
          input.securityClass ?? 'internal',
          input.retentionClass ?? 'standard',
          JSON.stringify(intent),
          now,
          input.tenantId,
          input.ingestRequestId,
        ] as unknown[],
      );
      return;
    }
    const jobId = `job-${input.ingestRequestId}`;
    this.db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id,
         requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, transform_profile,
         result_json,
         state, attempt_count, created_at, started_at, updated_at)
       VALUES
        ($t, $j, $r, $h,
         $sk, $br,
         $et, $ei, $role,
         $sc, $rc, 'stock_image',
         $intent,
         'accepted', 0, $now, $now, $now)`,
      [
        input.tenantId,
        jobId,
        input.ingestRequestId,
        input.requestHash,
        input.scopeKind,
        input.branchId,
        input.entityType,
        input.entityId,
        input.role,
        input.securityClass ?? 'internal',
        input.retentionClass ?? 'standard',
        JSON.stringify(intent),
        now,
      ] as unknown[],
    );
  }

  /**
   * Drive one full ingest to a `ready` job and an active link. Idempotent
   * under retry with the same `(tenant, ingest_request_id, request_hash)`;
   * hard-fails a request-id collision with a different hash.
   */
  async finalize(input: FinalizeInput): Promise<FinalizeResult> {
    validateFinalizeInput(input);
    const now = timestamp();

    // Idempotency check BEFORE calling into the Rust core: a frozen `ready`
    // job is returned as-is; a request-id collision with a different hash
    // aborts before we touch anything.
    const existing = this.jobRow(input.tenantId, input.ingestRequestId);
    if (existing) {
      if (existing.request_hash !== input.requestHash) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
      }
      const cached = parseCachedResult(existing.result_json);
      if (existing.state === 'ready' && cached) {
        return cached;
      }
      // Any other state falls through and re-enters the finalize path.
    }

    // Drive the Rust core to a published state, then verify both finals via
    // the same gateway. Verification is the pre-link contract: if the file
    // is missing or its bytes do not hash to the expected content, we do
    // NOT open a link and instead leave the job in a recoverable state.
    const commitResult: CommitResult = await this.gateway.commitStockImage({
      tenantScope: input.tenantId,
      ingestRequestId: input.ingestRequestId,
      requestHash: input.requestHash,
    });

    // If a previous checkpoint registered an intent, the Rust commit must
    // return exactly those descriptors — a divergence means the request
    // was re-prepared with different content and we refuse the finalize.
    const priorIntent = parseCachedIntent(existing?.result_json);
    if (priorIntent) {
      const nowIntent = intentPayloadFrom(input.tenantId, commitResult);
      if (!intentsEqual(priorIntent, nowIntent)) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
      }
    }

    const mainBytes = await this.readVerified(
      input.tenantId,
      commitResult.main_descriptor,
    );
    const thumbBytes = await this.readVerified(
      input.tenantId,
      commitResult.thumbnail_descriptor,
    );

    // The DB half is one atomic sql.js transaction. Any throw inside rolls
    // back the whole picture (no half-finished generation, no active link).
    return this.withTx(() => {
      // 1) Ensure/refresh the job intent row *inside* the tx so retries
      //    that raced with each other converge deterministically.
      this.upsertJob(input, commitResult, now);

      // 2) Blobs + generations (idempotent, existing rows validated).
      const mainBlobId = blobIdFor(commitResult.main_descriptor.hash);
      const thumbBlobId = blobIdFor(commitResult.thumbnail_descriptor.hash);
      this.ensureBlobGeneration(
        input.tenantId,
        mainBlobId,
        commitResult.main_descriptor,
        commitResult.main_storage_key,
        now,
      );
      this.ensureBlobGeneration(
        input.tenantId,
        thumbBlobId,
        commitResult.thumbnail_descriptor,
        commitResult.thumbnail_storage_key,
        now,
      );

      // 3) Master media object + thumbnail variant.
      const mediaId = mediaIdFor(input.ingestRequestId);
      this.ensureObject(input, mainBlobId, mediaId, now);
      const variantId = variantIdFor(mediaId, 'thumbnail');
      this.ensureVariant(input.tenantId, variantId, mediaId, thumbBlobId, now);

      // 4) Active link at the target entity.
      const linkId = linkIdFor({ ...input, mediaId });
      this.ensureLink(input, linkId, mediaId, now);

      // 5) Freeze the successful result on the job.
      const result: FinalizeResult = {
        jobId: this.readJobId(input.tenantId, input.ingestRequestId),
        ingestRequestId: input.ingestRequestId,
        requestHash: input.requestHash,
        state: 'ready',
        mediaId,
        mainBlobId,
        thumbnailBlobId: thumbBlobId,
        variantId,
        linkId,
        main: { ...commitResult.main_descriptor, storage_key: commitResult.main_storage_key },
        thumbnail: {
          ...commitResult.thumbnail_descriptor,
          storage_key: commitResult.thumbnail_storage_key,
        },
      };
      this.db.run(
        `UPDATE media_ingest_jobs
            SET state = 'ready',
                target_media_id = $m,
                target_blob_id  = $b,
                result_json     = $j,
                completed_at    = $now,
                updated_at      = $now
          WHERE tenant_id = $t AND ingest_request_id = $r`,
        [mediaId, mainBlobId, encodeCachedResult(result), now, input.tenantId, input.ingestRequestId] as unknown[],
      );

      // Bytes are held only for the caller's post-tx verification; nothing
      // in the DB stores them.
      void mainBytes;
      void thumbBytes;
      return result;
    });
  }

  /**
   * Replace an existing link atomically: finalize the new image first, then
   * deactivate the identified prior link within the same tx. A rollback
   * leaves the old link untouched and its bytes on disk (no GC in this slice).
   */
  async replace(input: ReplaceInput): Promise<FinalizeResult> {
    validateFinalizeInput(input);
    const oldLink = this.linkRow(input.tenantId, input.previousLinkId);
    if (!oldLink) {
      throw new CoordinatorError('MEDIA_DB_LINK_NOT_FOUND');
    }
    if (oldLink.entity_type !== input.entityType || oldLink.entity_id !== input.entityId) {
      throw new CoordinatorError('MEDIA_DB_LINK_NOT_FOUND');
    }
    // The finalize call itself is the atomic tx around the DB half. If the
    // previous link is primary and the new one wants to be primary too we
    // first drop the old primary flag *inside the same tx*, then insert the
    // new active link. The exact ordering happens through the ambient tx:
    // ensureLink() will see the freshly-updated old row and be free to set
    // is_primary=1.
    const previousWasPrimary = Number(oldLink.is_primary) === 1;
    const finalize = await this.finalizeWithPreamble(input, () => {
      if (previousWasPrimary) {
        this.db.run(
          `UPDATE media_links
              SET is_primary = 0
            WHERE tenant_id = $t AND link_id = $l`,
          [input.tenantId, input.previousLinkId] as unknown[],
        );
      }
      // AFTER the new link is durably placed (finalize path completes) we
      // logically retire the old link. Physical bytes stay put.
      // The retirement itself is a plain UPDATE also inside the same tx.
      const now = timestamp();
      this.db.run(
        `UPDATE media_links
            SET deleted_at = $now, is_primary = 0
          WHERE tenant_id = $t AND link_id = $l`,
        [now, input.tenantId, input.previousLinkId] as unknown[],
      );
    });
    return finalize;
  }

  /** Logical remove: the link is closed out; no blob, generation or file
   *  is dropped. Idempotent — deleting an already-deleted link is a no-op. */
  remove(input: RemoveLinkInput): void {
    const row = this.linkRow(input.tenantId, input.linkId);
    if (!row) throw new CoordinatorError('MEDIA_DB_LINK_NOT_FOUND');
    if (row.deleted_at != null) return;
    const now = timestamp();
    this.db.run(
      `UPDATE media_links
          SET deleted_at = $now, is_primary = 0
        WHERE tenant_id = $t AND link_id = $l`,
      [now, input.tenantId, input.linkId] as unknown[],
    );
  }

  /**
   * Reconcile every job on the local DB against the Rust core, driving each
   * non-terminal one to a durably consistent DB state. Not a probe — a real
   * writer that shares the same atomic sql.js tx path finalize() uses.
   *
   * The recovery manifest lives in `media_ingest_jobs` itself: `tenant_id`,
   * `ingest_request_id`, `request_hash`, `scope_kind`, `branch_id`,
   * `requested_entity_type/_id/_role`, `security_class`, `retention_class`
   * are frozen at finalize-time by `upsertJob`, so recover can rebuild the
   * exact `FinalizeInput` after a restart. `isPrimary`/`sortOrder` are not
   * persisted (no schema slot for them) and recover defaults them to the
   * common case (primary=1, sort_order=0); the frozen `result_json` of a
   * ready job preserves the resolved link identity so a re-finalize is a
   * pure no-op.
   *
   * - job.state='ready'                      → noop_already_ready
   * - job in a terminal error state          → noop_terminal_state
   * - job manifest incomplete                → left_pending_no_manifest
   * - Rust commit + verification succeed     → finalized_from_ready_rust
   * - Rust commit fails (no journal on disk) → left_pending_no_rust_result
   * - Verification fails (missing/mismatch)  → quarantined_verification_failed
   */
  async recover(): Promise<RecoveryReport[]> {
    const rows = allRows(this.db, `SELECT * FROM media_ingest_jobs`);
    const out: RecoveryReport[] = [];
    for (const r of rows) {
      const tenantId = String(r.tenant_id);
      const irid = String(r.ingest_request_id);
      const state = String(r.state);
      if (state === 'ready') {
        out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'noop_already_ready' });
        continue;
      }
      if (state === 'failed' || state === 'quarantined' || state === 'expired') {
        out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'noop_terminal_state' });
        continue;
      }
      const input = this.resolveInputFromJobRow(r);
      if (!input) {
        out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'left_pending_no_manifest' });
        continue;
      }
      try {
        await this.finalize(input);
        out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'finalized_from_ready_rust' });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        const code = err.code ?? err.message ?? '';
        if (
          code === 'MEDIA_INGEST_FILE_MISSING' ||
          code === 'MEDIA_INGEST_HASH_MISMATCH' ||
          code === 'MEDIA_INGEST_VERIFICATION_FAILED'
        ) {
          this.markJobQuarantined(tenantId, irid, code);
          out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'quarantined_verification_failed' });
          continue;
        }
        if (
          code === 'MEDIA_INGEST_NOT_FOUND' ||
          code === 'MEDIA_INGEST_INVALID_STATE' ||
          code === 'MEDIA_INGEST_REQUEST_CONFLICT'
        ) {
          out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'left_pending_no_rust_result' });
          continue;
        }
        throw e; // anything else is a bug, not a recovery outcome
      }
    }
    return out;
  }

  /**
   * Rebuild the `FinalizeInput` we'd need to converge this job. Returns null
   * when the row cannot support recovery — a manifest inserted by an older
   * writer without the required scope fields.
   */
  private resolveInputFromJobRow(row: Record<string, unknown>): FinalizeInput | null {
    const scopeKind = row.scope_kind as 'branch' | 'tenant' | null | undefined;
    const entityType = row.requested_entity_type as string | null | undefined;
    const entityId = row.requested_entity_id as string | null | undefined;
    const role = row.requested_role as string | null | undefined;
    const hash = row.request_hash as string | null | undefined;
    if (!scopeKind || !entityType || !entityId || !role || !hash) return null;
    if (scopeKind !== 'branch' && scopeKind !== 'tenant') return null;
    return {
      tenantId: String(row.tenant_id),
      branchId: scopeKind === 'branch' ? (row.branch_id ? String(row.branch_id) : null) : null,
      ingestRequestId: String(row.ingest_request_id),
      requestHash: hash,
      entityType,
      entityId,
      scopeKind,
      role,
      // Link options are constants under the 2B1 contract — recovery
      // reproduces them exactly, not guesses them.
      isPrimary: LINK_INTENT_CANONICAL.isPrimary,
      sortOrder: LINK_INTENT_CANONICAL.sortOrder,
      securityClass: (row.security_class as FinalizeInput['securityClass']) ?? 'internal',
      retentionClass: (row.retention_class as FinalizeInput['retentionClass']) ?? 'standard',
    };
  }

  private markJobQuarantined(tenantId: string, ingestRequestId: string, code: string): void {
    const now = timestamp();
    this.db.run(
      `UPDATE media_ingest_jobs
          SET state = 'quarantined', error_code = $c, updated_at = $now
        WHERE tenant_id = $t AND ingest_request_id = $r`,
      [code, now, tenantId, ingestRequestId] as unknown[],
    );
  }

  // ── internal writers ─────────────────────────────────────────────────────

  private async readVerified(
    tenantId: string,
    desc: RustStoredDescriptor,
  ): Promise<MediaBytes> {
    let bytes: MediaBytes;
    try {
      bytes = await this.gateway.readVerifiedMedia({
        tenantScope: tenantId,
        hash: desc.hash,
        extension: desc.extension,
      });
    } catch (e) {
      const code = (e as { message?: string })?.message ?? '';
      if (code === 'MEDIA_FILE_MISSING') {
        throw new CoordinatorError('MEDIA_INGEST_FILE_MISSING');
      }
      if (code === 'MEDIA_FILE_HASH_MISMATCH') {
        throw new CoordinatorError('MEDIA_INGEST_HASH_MISMATCH');
      }
      throw new CoordinatorError('MEDIA_INGEST_VERIFICATION_FAILED', String(code));
    }
    if (
      bytes.hash !== desc.hash ||
      bytes.byte_size !== desc.byte_size ||
      bytes.mime_type !== desc.mime_type ||
      bytes.extension !== desc.extension
    ) {
      throw new CoordinatorError('MEDIA_INGEST_VERIFICATION_FAILED');
    }
    return bytes;
  }

  private upsertJob(input: FinalizeInput, commit: CommitResult, now: string): void {
    const existing = this.jobRow(input.tenantId, input.ingestRequestId);
    if (existing) {
      this.db.run(
        `UPDATE media_ingest_jobs
            SET state = 'finalizing', updated_at = $now,
                scope_kind = $sk, branch_id = $br,
                requested_entity_type = $et, requested_entity_id = $ei,
                requested_role = $role, security_class = $sc, retention_class = $rc
          WHERE tenant_id = $t AND ingest_request_id = $r`,
        [
          now,
          input.scopeKind,
          input.branchId,
          input.entityType,
          input.entityId,
          input.role,
          input.securityClass ?? 'internal',
          input.retentionClass ?? 'standard',
          input.tenantId,
          input.ingestRequestId,
        ] as unknown[],
      );
      return;
    }
    const jobId = `job-${input.ingestRequestId}`;
    this.db.run(
      `INSERT INTO media_ingest_jobs
        (tenant_id, job_id, ingest_request_id, request_hash,
         scope_kind, branch_id,
         requested_entity_type, requested_entity_id, requested_role,
         security_class, retention_class, transform_profile,
         state, attempt_count, created_at, started_at, updated_at)
       VALUES
        ($t, $j, $r, $h,
         $sk, $br,
         $et, $ei, $role,
         $sc, $rc, 'stock_image',
         'finalizing', 1, $now, $now, $now)`,
      [
        input.tenantId,
        jobId,
        input.ingestRequestId,
        input.requestHash,
        input.scopeKind,
        input.branchId,
        input.entityType,
        input.entityId,
        input.role,
        input.securityClass ?? 'internal',
        input.retentionClass ?? 'standard',
        now,
      ] as unknown[],
    );
    void commit;
  }

  private readJobId(tenantId: string, ingestRequestId: string): string {
    const r = firstRow(
      this.db,
      `SELECT job_id FROM media_ingest_jobs WHERE tenant_id = $t AND ingest_request_id = $r`,
      { $t: tenantId, $r: ingestRequestId },
    );
    if (!r) throw new CoordinatorError('MEDIA_INGEST_JOB_INVALID_STATE');
    return String(r.job_id);
  }

  /**
   * Insert-or-reuse a `(tenant, blob_id)` at generation_no=1. If the row
   * already exists, every physical field on it must match — otherwise we
   * refuse with `MEDIA_DB_MEDIA_CONFLICT` and do NOT overwrite.
   */
  private ensureBlobGeneration(
    tenantId: string,
    blobId: string,
    desc: RustStoredDescriptor,
    storageKey: string,
    now: string,
  ): void {
    const existing = this.blobGenerationRow(tenantId, blobId, 1);
    if (existing) {
      if (
        existing.storage_key !== storageKey ||
        existing.stored_blob_hash !== desc.hash ||
        Number(existing.byte_size) !== desc.byte_size ||
        existing.content_kind !== desc.content_kind ||
        existing.mime_type !== desc.mime_type ||
        existing.extension !== desc.extension
      ) {
        throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
      }
      // Blob row must also exist and point at generation 1 in 'present' state.
      const blob = firstRow(
        this.db,
        `SELECT * FROM media_blobs WHERE tenant_id = $t AND blob_id = $b`,
        { $t: tenantId, $b: blobId },
      );
      if (!blob || blob.blob_status !== 'present' || Number(blob.current_generation_no) !== 1) {
        throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
      }
      return;
    }
    // Fresh insert: generation first in 'available' state, then the pointer
    // in 'present' — the pointer trigger requires an existing 'available' gen.
    this.db.run(
      `INSERT INTO media_blob_generations
        (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash,
         byte_size, content_kind, mime_type, extension,
         is_encrypted, dek_version, gen_status, created_at)
       VALUES
        ($t, $b, 1, $sk, $h, $sz, $ck, $mt, $ext, 0, NULL, 'available', $now)`,
      [
        tenantId,
        blobId,
        storageKey,
        desc.hash,
        desc.byte_size,
        desc.content_kind,
        desc.mime_type,
        desc.extension,
        now,
      ] as unknown[],
    );
    this.db.run(
      `INSERT INTO media_blobs
        (tenant_id, blob_id, dedup_token, current_generation_no, blob_status, created_at, updated_at)
       VALUES ($t, $b, $tok, 1, 'present', $now, $now)`,
      [tenantId, blobId, dedupTokenFor(tenantId, desc.hash), now] as unknown[],
    );
  }

  private ensureObject(
    input: FinalizeInput,
    masterBlobId: string,
    mediaId: string,
    now: string,
  ): void {
    const existing = firstRow(
      this.db,
      `SELECT * FROM media_objects WHERE tenant_id = $t AND media_id = $m`,
      { $t: input.tenantId, $m: mediaId },
    );
    if (existing) {
      if (
        existing.master_blob_id !== masterBlobId ||
        existing.security_class !== (input.securityClass ?? 'internal') ||
        existing.retention_class !== (input.retentionClass ?? 'standard')
      ) {
        throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
      }
      return;
    }
    this.db.run(
      `INSERT INTO media_objects
        (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind,
         source_type, security_class, retention_class,
         ingest_status, created_at, updated_at)
       VALUES
        ($t, $m, $ob, $mb, 'normalized',
         'upload_desktop', $sc, $rc,
         'ready', $now, $now)`,
      [
        input.tenantId,
        mediaId,
        input.scopeKind === 'branch' ? input.branchId : null,
        masterBlobId,
        input.securityClass ?? 'internal',
        input.retentionClass ?? 'standard',
        now,
      ] as unknown[],
    );
  }

  private ensureVariant(
    tenantId: string,
    variantId: string,
    mediaId: string,
    blobId: string,
    now: string,
  ): void {
    const existing = firstRow(
      this.db,
      `SELECT * FROM media_variants WHERE tenant_id = $t AND variant_id = $v`,
      { $t: tenantId, $v: variantId },
    );
    if (existing) {
      if (
        existing.media_id !== mediaId ||
        existing.blob_id !== blobId ||
        existing.variant_type !== 'thumbnail' ||
        Number(existing.transform_version) !== 1
      ) {
        throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
      }
      return;
    }
    this.db.run(
      `INSERT INTO media_variants
        (tenant_id, variant_id, media_id, variant_type, transform_version, blob_id, created_at)
       VALUES ($t, $v, $m, 'thumbnail', 1, $b, $now)`,
      [tenantId, variantId, mediaId, blobId, now] as unknown[],
    );
  }

  private ensureLink(input: FinalizeInput, linkId: string, mediaId: string, now: string): void {
    const existing = this.linkRow(input.tenantId, linkId);
    if (existing) {
      if (
        existing.media_id !== mediaId ||
        existing.entity_type !== input.entityType ||
        existing.entity_id !== input.entityId ||
        existing.scope_kind !== input.scopeKind ||
        (input.scopeKind === 'branch' ? existing.branch_id !== input.branchId : existing.branch_id != null)
      ) {
        throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
      }
      // Re-activate a previously soft-deleted link (idempotent re-finalize).
      // The link-intent contract makes primary/sort_order constants — passing
      // them positionally here just reads as `1`/`0`.
      if (existing.deleted_at != null) {
        this.db.run(
          `UPDATE media_links
              SET deleted_at = NULL,
                  is_primary = $p,
                  sort_order = $so
            WHERE tenant_id = $t AND link_id = $l`,
          [
            LINK_INTENT_CANONICAL.isPrimary ? 1 : 0,
            LINK_INTENT_CANONICAL.sortOrder,
            input.tenantId,
            linkId,
          ] as unknown[],
        );
      }
      return;
    }
    this.db.run(
      `INSERT INTO media_links
        (tenant_id, link_id, scope_kind, branch_id,
         entity_type, entity_id, media_id, media_role,
         sort_order, is_primary, created_at)
       VALUES ($t, $l, $sk, $br, $et, $ei, $m, $role, $so, $p, $now)`,
      [
        input.tenantId,
        linkId,
        input.scopeKind,
        input.scopeKind === 'branch' ? input.branchId : null,
        input.entityType,
        input.entityId,
        mediaId,
        input.role,
        LINK_INTENT_CANONICAL.sortOrder,
        LINK_INTENT_CANONICAL.isPrimary ? 1 : 0,
        now,
      ] as unknown[],
    );
  }

  // ── tx wrapper (autonomous BEGIN IMMEDIATE / COMMIT / ROLLBACK) ─────────

  private withTx<T>(fn: () => T): T {
    this.db.run('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.run('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // If sql.js already rolled back on a trigger abort, a manual
        // ROLLBACK throws; swallow and re-raise the original error.
      }
      throw e;
    }
  }

  private async finalizeWithPreamble(
    input: FinalizeInput,
    preambleInsideTx: () => void,
  ): Promise<FinalizeResult> {
    // Perform the same steps as `finalize()` but with a pre-hook inside the
    // atomic tx. Duplicating the flow keeps `finalize()` a single well-formed
    // read path; the preamble handles replace-semantics without smearing
    // logic across two methods.
    const existing = this.jobRow(input.tenantId, input.ingestRequestId);
    if (existing && existing.request_hash !== input.requestHash) {
      throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
    }
    if (existing?.state === 'ready') {
      const cached = parseCachedResult(existing.result_json);
      if (cached) return cached;
    }
    const commitResult = await this.gateway.commitStockImage({
      tenantScope: input.tenantId,
      ingestRequestId: input.ingestRequestId,
      requestHash: input.requestHash,
    });
    await this.readVerified(input.tenantId, commitResult.main_descriptor);
    await this.readVerified(input.tenantId, commitResult.thumbnail_descriptor);
    const now = timestamp();
    return this.withTx(() => {
      preambleInsideTx();
      this.upsertJob(input, commitResult, now);
      const mainBlobId = blobIdFor(commitResult.main_descriptor.hash);
      const thumbBlobId = blobIdFor(commitResult.thumbnail_descriptor.hash);
      this.ensureBlobGeneration(input.tenantId, mainBlobId, commitResult.main_descriptor, commitResult.main_storage_key, now);
      this.ensureBlobGeneration(input.tenantId, thumbBlobId, commitResult.thumbnail_descriptor, commitResult.thumbnail_storage_key, now);
      const mediaId = mediaIdFor(input.ingestRequestId);
      this.ensureObject(input, mainBlobId, mediaId, now);
      const variantId = variantIdFor(mediaId, 'thumbnail');
      this.ensureVariant(input.tenantId, variantId, mediaId, thumbBlobId, now);
      const linkId = linkIdFor({ ...input, mediaId });
      this.ensureLink(input, linkId, mediaId, now);
      const result: FinalizeResult = {
        jobId: this.readJobId(input.tenantId, input.ingestRequestId),
        ingestRequestId: input.ingestRequestId,
        requestHash: input.requestHash,
        state: 'ready',
        mediaId,
        mainBlobId,
        thumbnailBlobId: thumbBlobId,
        variantId,
        linkId,
        main: { ...commitResult.main_descriptor, storage_key: commitResult.main_storage_key },
        thumbnail: { ...commitResult.thumbnail_descriptor, storage_key: commitResult.thumbnail_storage_key },
      };
      this.db.run(
        `UPDATE media_ingest_jobs
            SET state = 'ready', target_media_id = $m, target_blob_id = $b,
                result_json = $j, completed_at = $now, updated_at = $now
          WHERE tenant_id = $t AND ingest_request_id = $r`,
        [mediaId, mainBlobId, encodeCachedResult(result), now, input.tenantId, input.ingestRequestId] as unknown[],
      );
      return result;
    });
  }
}

// ── module-level helpers ───────────────────────────────────────────────────

function validateFinalizeInput(input: FinalizeInput): void {
  if (!input.tenantId || !input.ingestRequestId || !input.requestHash) {
    throw new CoordinatorError('MEDIA_INVALID_INPUT');
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestHash)) {
    throw new CoordinatorError('MEDIA_INVALID_INPUT');
  }
  if (input.scopeKind === 'branch' && !input.branchId) {
    throw new CoordinatorError('MEDIA_INVALID_INPUT');
  }
  if (input.scopeKind === 'tenant' && input.branchId != null) {
    throw new CoordinatorError('MEDIA_INVALID_INPUT');
  }
  // Link-intent contract (R2): no schema slot exists to freeze per-request
  // link options, so we forbid non-canonical values up front rather than
  // silently guessing them at recover time. Undefined is fine — it maps
  // to the canonical constant.
  if (input.isPrimary !== undefined && input.isPrimary !== LINK_INTENT_CANONICAL.isPrimary) {
    throw new CoordinatorError('MEDIA_INVALID_INPUT');
  }
  if (input.sortOrder !== undefined && input.sortOrder !== LINK_INTENT_CANONICAL.sortOrder) {
    throw new CoordinatorError('MEDIA_INVALID_INPUT');
  }
}

function timestamp(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

// ── result_json discriminator helpers ───────────────────────────────────────
//
// After R1 the `result_json` slot carries either the pre-publication
// intent (state=accepted/finalizing) or the frozen finalize result
// (state=ready). A discriminator field disambiguates the two shapes so
// no reader confuses one for the other.

function encodeCachedResult(result: FinalizeResult): string {
  return JSON.stringify({ kind: 'result', value: result });
}

function parseCachedResult(raw: unknown): FinalizeResult | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && parsed.kind === 'result' && parsed.value) {
      return parsed.value as FinalizeResult;
    }
  } catch {
    // fall through
  }
  return null;
}

function parseCachedIntent(raw: unknown): PendingIntentPayload | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && parsed.kind === 'intent' && parsed.main && parsed.thumbnail) {
      return parsed as PendingIntentPayload;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Storage-key format contract shared with the Rust core (`{scope}/{aa}/{hash}.{ext}`). */
function storageKeyFor(scope: string, hash: string, extension: string): string {
  return `${scope}/${hash.slice(0, 2)}/${hash}.${extension}`;
}

function intentPayloadFor(scope: string, prepared: PrepareResult): PendingIntentPayload {
  return {
    kind: 'intent',
    main: {
      ...prepared.main_descriptor,
      storage_key: storageKeyFor(scope, prepared.main_descriptor.hash, prepared.main_descriptor.extension),
    },
    thumbnail: {
      ...prepared.thumbnail_descriptor,
      storage_key: storageKeyFor(scope, prepared.thumbnail_descriptor.hash, prepared.thumbnail_descriptor.extension),
    },
  };
}

/** Build an intent-shaped snapshot from a CommitResult — same shape as the
 *  intent we would have written pre-publication, so recovery can compare
 *  them for equality without leaking any commit-only fields. */
function intentPayloadFrom(scope: string, commit: CommitResult): PendingIntentPayload {
  return {
    kind: 'intent',
    main: {
      ...commit.main_descriptor,
      storage_key: commit.main_storage_key,
    },
    thumbnail: {
      ...commit.thumbnail_descriptor,
      storage_key: commit.thumbnail_storage_key,
    },
  };
  void scope; // scope is implicit in the storage_key format; kept for symmetry
}

function intentsEqual(a: PendingIntentPayload, b: PendingIntentPayload): boolean {
  return (
    a.main.hash === b.main.hash &&
    a.main.byte_size === b.main.byte_size &&
    a.main.content_kind === b.main.content_kind &&
    a.main.mime_type === b.main.mime_type &&
    a.main.extension === b.main.extension &&
    a.main.storage_key === b.main.storage_key &&
    a.thumbnail.hash === b.thumbnail.hash &&
    a.thumbnail.byte_size === b.thumbnail.byte_size &&
    a.thumbnail.content_kind === b.thumbnail.content_kind &&
    a.thumbnail.mime_type === b.thumbnail.mime_type &&
    a.thumbnail.extension === b.thumbnail.extension &&
    a.thumbnail.storage_key === b.thumbnail.storage_key
  );
}

function paramsToPositional(
  sql: string,
  bound: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  // sql.js does not accept named parameters via `.exec(sql, params)` on all
  // versions; we compile down to positional `?`. Keeps the wire layer stable.
  const order: string[] = [];
  const compiled = sql.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
    order.push(m);
    return '?';
  });
  return { sql: compiled, values: order.map((k) => bound[k]) };
}

function firstRow(
  db: RawDb,
  sql: string,
  bound: Record<string, unknown>,
): Record<string, unknown> | null {
  const { sql: compiled, values } = paramsToPositional(sql, bound);
  const rows = db.exec(compiled, values);
  if (rows.length === 0 || rows[0].values.length === 0) return null;
  return zip(rows[0].columns, rows[0].values[0]);
}

function allRows(
  db: RawDb,
  sql: string,
  bound?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (bound) {
    const { sql: compiled, values } = paramsToPositional(sql, bound);
    const rows = db.exec(compiled, values);
    if (rows.length === 0) return [];
    return rows[0].values.map((v) => zip(rows[0].columns, v));
  }
  const rows = db.exec(sql);
  if (rows.length === 0) return [];
  return rows[0].values.map((v) => zip(rows[0].columns, v));
}

function zip(columns: string[], values: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
  return out;
}
