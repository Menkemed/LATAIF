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
   * Gallery position for this image (3A-R1). Both values are now real inputs,
   * frozen into the durable intent (`PendingIntentPayload.linkIntent`) before
   * the Rust core publishes anything, so recovery reproduces the EXACT slot
   * instead of guessing.
   *
   * Legal combinations are decided against the live active-link count for the
   * (tenant, scope, entity, role) slot — see `assertAppendPosition`:
   *   • first image  (activeCount = 0)  → isPrimary = true,  sortOrder = 0
   *   • append       (activeCount = N)  → isPrimary = false, sortOrder = N
   * Both default to the first-image shape when omitted.
   */
  isPrimary?: boolean;
  sortOrder?: number;
  securityClass?: 'public' | 'internal' | 'sensitive' | 'highly_sensitive';
  retentionClass?: 'transient' | 'standard' | 'legal_hold';
}

/**
 * The frozen link position for one ingest request. Persisted inside
 * `PendingIntentPayload` so a crash/restart replays the identical slot.
 */
export interface LinkIntent {
  isPrimary: boolean;
  sortOrder: number;
}

/**
 * The shape a brand-new gallery's first entry must take. Kept as a named
 * constant because both `finalize` and `recover` reason about it, and the
 * legacy (pre-3A-R1) intent payloads that carry no `linkIntent` are known to
 * mean exactly this.
 */
export const LINK_INTENT_FIRST_IMAGE: LinkIntent = {
  isPrimary: true,
  sortOrder: 0,
};

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
  /** The gallery slot this request actually occupies (3A-R1). Frozen with the
   *  result so a later retry can be told it asked for a different position. */
  linkIntent: LinkIntent;
}

/**
 * The pre-publication intent snapshot stored in `media_ingest_jobs.result_json`
 * between `registerPendingIntent` and `finalize`. Carrying the descriptors +
 * derived storage keys here lets recovery converge from Disk alone — the DB
 * side does not depend on the Rust journal to know WHAT to reconstruct.
 */
export interface PendingIntentPayload {
  kind: 'intent';
  /**
   * Intent-payload version. Every accepted value is enumerated here and
   * validated on read; anything else fails closed.
   *   v1 — pre-3A-R1: no `linkIntent`, no `operation`. Unambiguously meant an
   *        APPEND of the first image (true/0), because that era's writer
   *        hard-enforced exactly that shape.
   *   v2 — 3A-R1: explicit `linkIntent`, still append-only.
   *   v3 — 3A-R2: explicit `operation`; `replace` additionally carries the
   *        `previousLinkId` it must retire.
   */
  intentVersion?: 1 | 2 | 3;
  /** What recovery must REDO. Absent (v1/v2) ⇒ 'append'. */
  operation?: IntentOperation;
  /** Required iff `operation === 'replace'`; forbidden otherwise. */
  previousLinkId?: string;
  main: RustStoredDescriptor & { storage_key: string };
  thumbnail: RustStoredDescriptor & { storage_key: string };
  /** Present from v2 onward. Frozen BEFORE the Rust core publishes. */
  linkIntent?: LinkIntent;
}

/** The two gallery-mutating ingest operations a durable intent can describe. */
export type IntentOperation = 'append' | 'replace';

export interface RecoveryReport {
  tenantId: string;
  ingestRequestId: string;
  jobState: string;
  action:
    | 'noop_already_ready'
    | 'noop_terminal_state'
    | 'finalized_from_ready_rust'
    | 'replaced_from_ready_rust'
    | 'left_pending_no_rust_result'
    | 'left_pending_no_manifest'
    | 'left_pending_replace_target_gone'
    | 'quarantined_verification_failed';
}

/**
 * What a durable intent tells recovery to REDO. Derived exclusively from the
 * frozen `result_json` — never guessed from the job's column set, because an
 * append and a replace are indistinguishable at the column level yet produce
 * completely different galleries.
 */
type RecoveryPlan =
  | { op: 'append'; input: FinalizeInput }
  | { op: 'replace'; input: ReplaceInput };

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

  // ── gallery helpers (3A-R1) ──────────────────────────────────────────────
  //
  // A "gallery" is every ACTIVE link sharing (tenant, scope, branch, entity,
  // role). `sort_order` carries no DB-level unique index (only `is_primary`
  // and the natural media key do), so ordering is an APPLICATION invariant
  // that these helpers own — and that also means compaction can renumber
  // rows freely without transient index collisions.

  /** All active links of one gallery slot, ordered by position. */
  private activeGalleryLinks(slot: {
    tenantId: string;
    scopeKind: 'branch' | 'tenant';
    branchId: string | null;
    entityType: string;
    entityId: string;
    role: string;
  }): Array<Record<string, unknown>> {
    const branchPred =
      slot.scopeKind === 'branch' ? `branch_id = $br` : `branch_id IS NULL`;
    const bound: Record<string, unknown> = {
      $t: slot.tenantId,
      $sk: slot.scopeKind,
      $et: slot.entityType,
      $ei: slot.entityId,
      $role: slot.role,
    };
    if (slot.scopeKind === 'branch') bound.$br = slot.branchId;
    return allRows(
      this.db,
      `SELECT link_id, media_id, sort_order, is_primary
         FROM media_links
        WHERE tenant_id = $t AND scope_kind = $sk AND ${branchPred}
          AND entity_type = $et AND entity_id = $ei AND media_role = $role
          AND deleted_at IS NULL
        ORDER BY sort_order ASC`,
      bound,
    );
  }

  /**
   * Enforce the append-only gallery contract for a NEW link:
   *   activeCount = 0  → isPrimary = true,  sortOrder = 0
   *   activeCount = N  → isPrimary = false, sortOrder = N
   * Also re-validates that the existing gallery is itself well-formed, so a
   * corrupted gallery can never be silently appended to.
   */
  private assertAppendPosition(input: FinalizeInput, intent: LinkIntent): void {
    const existing = this.activeGalleryLinks({
      tenantId: input.tenantId,
      scopeKind: input.scopeKind,
      branchId: input.branchId,
      entityType: input.entityType,
      entityId: input.entityId,
      role: input.role,
    });
    assertGalleryWellFormed(existing);
    const n = existing.length;
    const expected: LinkIntent =
      n === 0 ? { ...LINK_INTENT_FIRST_IMAGE } : { isPrimary: false, sortOrder: n };
    if (!linkIntentsEqual(intent, expected)) {
      throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
    }
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
    const linkIntent = linkIntentOf(input);
    const intent = intentPayloadFor(input.tenantId, prepared, linkIntent, 'append');
    this.persistIntent(input, intent, (prior) => {
      // Position is validated exactly ONCE — when the slot is first frozen.
      // Re-validating on a resume would misread the request's own link (or a
      // concurrently appended one) as a changed gallery size.
      if (!prior) this.assertAppendPosition(input, linkIntent);
    });
  }

  /**
   * Register the pre-publication intent for a REPLACE (3A-R2).
   *
   * A replace and an append are indistinguishable at the job-column level —
   * both carry scope/entity/role/class — yet they produce entirely different
   * galleries. Without this the crash-recovery path would re-run a replace as
   * an append and duplicate the slot. So the durable payload additionally
   * freezes `operation:'replace'` and the exact `previousLinkId` to retire.
   *
   * The slot is NOT chosen here: a replace inherits the old link's exact
   * position, so it is read off the live link row and frozen. A caller that
   * explicitly asks for a different position gets MEDIA_DB_MEDIA_CONFLICT.
   */
  registerPendingReplaceIntent(input: ReplaceInput, prepared: PrepareResult): void {
    validateFinalizeInput(input);
    if (prepared.request_hash !== input.requestHash) {
      throw new CoordinatorError('MEDIA_INVALID_INPUT');
    }
    if (!input.previousLinkId) {
      throw new CoordinatorError('MEDIA_INVALID_INPUT');
    }
    const existingJob = this.jobRow(input.tenantId, input.ingestRequestId);
    if (existingJob?.state === 'ready') {
      // Already finalized — nothing left to intend.
      if (existingJob.request_hash !== input.requestHash) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
      }
      return;
    }
    // Read the slot from the live target so the frozen intent is exact.
    const inherited = this.inheritedSlotOf(input);
    const intent = intentPayloadFor(
      input.tenantId,
      prepared,
      inherited,
      'replace',
      input.previousLinkId,
    );
    this.persistIntent(input, intent, () => {
      // Nothing extra: a replace re-uses an occupied slot, so the append
      // position rule deliberately does not apply.
    });
  }

  /**
   * Shared job-row writer for both intent flavours. Enforces the identity
   * rules (hash, already-ready, prior-intent equality) and hands the caller a
   * hook that runs exactly once, before the row is written, with the prior
   * intent (if any) so it can decide whether extra validation is due.
   */
  private persistIntent(
    input: FinalizeInput,
    intent: PendingIntentPayload,
    beforeWrite: (prior: PendingIntentPayload | null) => void,
  ): void {
    const now = timestamp();
    const existing = this.jobRow(input.tenantId, input.ingestRequestId);
    if (existing) {
      if (existing.request_hash !== input.requestHash) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
      }
      if (existing.state === 'ready') {
        // Already finalized — register is a no-op. NOT a second write.
        return;
      }
      // Verify prior intent (if any) matches — descriptors, link intent,
      // operation AND replace target. Same request id + same hash but a
      // different slot/operation/target is a hard conflict, caught here
      // before any publication.
      const prior = parseCachedIntent(existing.result_json);
      if (prior && !intentsEqual(prior, intent)) {
        throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
      }
      beforeWrite(prior);
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
    // Fresh job: this call IS the freeze, so the same one-shot validation
    // applies here as on the resume path above.
    beforeWrite(null);
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
        // A retry of a finished request. If the caller EXPLICITLY asks for a
        // different slot than the one this request occupies, saying "fine,
        // here is your old result" would silently accept a changed intent —
        // so surface it instead. An omitted position is a plain retry.
        if (input.isPrimary !== undefined || input.sortOrder !== undefined) {
          const asked = linkIntentOf(input);
          const owned = cached.linkIntent ?? LINK_INTENT_FIRST_IMAGE;
          if (!linkIntentsEqual(asked, owned)) {
            throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
          }
        }
        return cached;
      }
      // Any other state falls through and re-enters the finalize path.
    }

    // The slot this call asks for. If a durable intent already froze one, THAT
    // is authoritative and the caller must match it exactly.
    const priorIntent = parseCachedIntent(existing?.result_json);
    if (priorIntent && operationOf(priorIntent) !== 'append') {
      // The durable intent says this request must RETIRE a link. Running it
      // through the plain append path would leave two links on one slot, so
      // it is refused — `replace()` is the only legal continuation.
      throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT', 'MEDIA_INTENT_OPERATION_MISMATCH');
    }
    const requestedIntent = linkIntentOf(input);
    const frozenIntent = priorIntent?.linkIntent ?? null;
    if (frozenIntent && !linkIntentsEqual(frozenIntent, requestedIntent)) {
      // Same request id + same hash, different gallery position → conflict,
      // BEFORE the Rust core is asked to publish.
      throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
    }
    const linkIntent = frozenIntent ?? requestedIntent;
    // Validate the position ONLY when nothing has frozen it yet — i.e. a
    // direct finalize() with no prior checkpoint. When an intent exists the
    // slot was already validated at freeze time and re-checking would
    // misjudge a resume (the request's own link inflates the count).
    // The post-write gallery assertion inside the tx is the backstop that
    // catches any slot collision regardless of which path we took.
    if (!frozenIntent) this.assertAppendPosition(input, linkIntent);

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
    if (priorIntent) {
      const nowIntent = intentPayloadFrom(input.tenantId, commitResult, linkIntent, 'append');
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

      // 4) Active link at the target entity, at the frozen gallery slot.
      const linkId = linkIdFor({ ...input, mediaId });
      this.ensureLink(input, linkId, mediaId, now, linkIntent);
      // Backstop: whatever the path in, the resulting gallery must satisfy
      // the full contract. A slot collision rolls the whole tx back.
      assertGalleryWellFormed(
        this.activeGalleryLinks({
          tenantId: input.tenantId,
          scopeKind: input.scopeKind,
          branchId: input.branchId,
          entityType: input.entityType,
          entityId: input.entityId,
          role: input.role,
        }),
      );

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
        linkIntent: { ...linkIntent },
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
    // Idempotency FIRST: a completed replace has already retired the previous
    // link, so re-validating it would wrongly report LINK_NOT_FOUND. The job
    // is the authority on "did this request already run".
    const existingJob = this.jobRow(input.tenantId, input.ingestRequestId);
    if (existingJob) {
      if (existingJob.request_hash !== input.requestHash) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
      }
      if (existingJob.state === 'ready') {
        const cached = parseCachedResult(existingJob.result_json);
        if (cached) return cached;
      }
    }
    // A durable replace intent, if one was frozen at checkpoint 1, is the
    // authority on WHAT this request replaces. A caller pointing the same
    // request id at a different target is a conflict — never a silent retarget.
    const frozen = parseCachedIntent(existingJob?.result_json);
    if (frozen) {
      if (operationOf(frozen) !== 'replace') {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT', 'MEDIA_INTENT_OPERATION_MISMATCH');
      }
      if (frozen.previousLinkId !== input.previousLinkId) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT', 'MEDIA_INTENT_TARGET_MISMATCH');
      }
    }

    // 3A-R1 slot preservation: a replace INHERITS the old link's exact
    // position. The caller may not reorder or re-flag as a side effect —
    // if it tried, that is a conflict, not a silent override.
    const inherited = this.inheritedSlotOf(input);
    const slotInput: ReplaceInput = {
      ...input,
      isPrimary: inherited.isPrimary,
      sortOrder: inherited.sortOrder,
    };

    // Ordering inside the single tx: retire the old link FIRST (its
    // deleted_at drops it out of the partial-unique primary index), then the
    // finalize path inserts the new link at the very same slot. Doing it in
    // this order is what makes "replace the primary" legal — otherwise the
    // two rows would collide on ux_ml_primary_*.
    return this.finalizeWithPreamble(
      slotInput,
      () => {
        const now = timestamp();
        this.db.run(
          `UPDATE media_links
              SET deleted_at = $now, is_primary = 0
            WHERE tenant_id = $t AND link_id = $l AND deleted_at IS NULL`,
          [now, input.tenantId, input.previousLinkId] as unknown[],
        );
      },
      inherited,
      'replace',
      input.previousLinkId,
    );
  }

  /**
   * The exact gallery slot a replace must inherit, read off the live target
   * link. Also enforces that the target really belongs to the addressed
   * (tenant, scope, branch, entity, role) — a link id alone is not enough to
   * authorise a mutation, otherwise a caller could retire another branch's or
   * another entity's link by guessing an id.
   *
   * A caller that additionally names a position must name the inherited one:
   * a replace may not reorder or re-flag as a side effect.
   */
  private inheritedSlotOf(input: ReplaceInput): LinkIntent {
    const oldLink = this.linkRow(input.tenantId, input.previousLinkId);
    if (!oldLink) {
      throw new CoordinatorError('MEDIA_DB_LINK_NOT_FOUND');
    }
    if (oldLink.deleted_at != null) {
      // Already retired — there is no slot left to inherit.
      throw new CoordinatorError('MEDIA_DB_LINK_NOT_FOUND');
    }
    if (
      oldLink.entity_type !== input.entityType ||
      oldLink.entity_id !== input.entityId ||
      oldLink.media_role !== input.role ||
      oldLink.scope_kind !== input.scopeKind ||
      (input.scopeKind === 'branch'
        ? oldLink.branch_id !== input.branchId
        : oldLink.branch_id != null)
    ) {
      throw new CoordinatorError('MEDIA_DB_LINK_NOT_FOUND');
    }
    const inherited: LinkIntent = {
      isPrimary: Number(oldLink.is_primary) === 1,
      sortOrder: Number(oldLink.sort_order),
    };
    if (input.isPrimary !== undefined || input.sortOrder !== undefined) {
      const asked = linkIntentOf(input);
      if (!linkIntentsEqual(asked, inherited)) {
        throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT');
      }
    }
    return inherited;
  }

  /**
   * Logical remove that PRESERVES the array semantics of the gallery.
   *
   * All inside one transaction:
   *   • retire the target link (row is kept — it is the legacy-suppression
   *     evidence and the audit trail; nothing is ever hard-deleted)
   *   • compact every higher sort_order down by one, so the remaining links
   *     stay contiguous 0..N-2
   *   • if the removed link was the primary and others remain, the link that
   *     lands at sort_order 0 becomes the new primary
   *
   * Ordering note: the target's `deleted_at` is set BEFORE any promotion, so
   * the retired row has already left the partial-unique primary index and no
   * transient collision is possible. `sort_order` carries no unique index at
   * all, so the renumbering UPDATE is collision-free by construction.
   *
   * Idempotent — removing an already-retired link is a no-op.
   */
  remove(input: RemoveLinkInput): void {
    const row = this.linkRow(input.tenantId, input.linkId);
    if (!row) throw new CoordinatorError('MEDIA_DB_LINK_NOT_FOUND');
    if (row.deleted_at != null) return;

    const slot = {
      tenantId: input.tenantId,
      scopeKind: row.scope_kind as 'branch' | 'tenant',
      branchId: row.branch_id == null ? null : String(row.branch_id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      role: String(row.media_role),
    };
    const removedSort = Number(row.sort_order);
    const removedWasPrimary = Number(row.is_primary) === 1;
    const now = timestamp();

    this.withTx(() => {
      // 1) Retire the target — leaves the primary index immediately.
      this.db.run(
        `UPDATE media_links
            SET deleted_at = $now, is_primary = 0
          WHERE tenant_id = $t AND link_id = $l`,
        [now, input.tenantId, input.linkId] as unknown[],
      );

      // 2) Compact the survivors: everything above the hole moves down one.
      const branchPred =
        slot.scopeKind === 'branch' ? `branch_id = $br` : `branch_id IS NULL`;
      const params: unknown[] = [];
      params.push(removedSort, slot.tenantId, slot.scopeKind);
      if (slot.scopeKind === 'branch') params.push(slot.branchId);
      params.push(slot.entityType, slot.entityId, slot.role);
      this.db.run(
        `UPDATE media_links
            SET sort_order = sort_order - 1
          WHERE sort_order > $removed
            AND tenant_id = $t AND scope_kind = $sk AND ${branchPred}
            AND entity_type = $et AND entity_id = $ei AND media_role = $role
            AND deleted_at IS NULL`,
        params,
      );

      // 3) Promote if the primary was the one removed and links remain.
      if (removedWasPrimary) {
        const survivors = this.activeGalleryLinks(slot);
        if (survivors.length > 0) {
          const head = survivors.find((s) => Number(s.sort_order) === 0);
          if (!head) {
            // Compaction should always leave a row at 0; if not, the gallery
            // was already malformed — fail closed rather than guess.
            throw new CoordinatorError(
              'MEDIA_DB_MEDIA_CONFLICT',
              'MEDIA_GALLERY_SORT_GAP',
            );
          }
          this.db.run(
            `UPDATE media_links
                SET is_primary = 1
              WHERE tenant_id = $t AND link_id = $l`,
            [slot.tenantId, String(head.link_id)] as unknown[],
          );
        }
      }

      // 4) Whatever remains must satisfy the full gallery contract.
      assertGalleryWellFormed(this.activeGalleryLinks(slot));
    });
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
      const plan = this.resolvePlanFromJobRow(r);
      if (!plan) {
        out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'left_pending_no_manifest' });
        continue;
      }
      try {
        if (plan.op === 'replace') {
          await this.replace(plan.input);
          out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'replaced_from_ready_rust' });
        } else {
          await this.finalize(plan.input);
          out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'finalized_from_ready_rust' });
        }
      } catch (e) {
        const err = e as { code?: string; message?: string };
        const code = err.code ?? err.message ?? '';
        if (code === 'MEDIA_DB_LINK_NOT_FOUND') {
          // A frozen replace whose target vanished (removed or replaced by
          // another op in the meantime). Re-running it as an append would
          // resurrect an image the user deleted — leave it pending instead.
          out.push({ tenantId, ingestRequestId: irid, jobState: state, action: 'left_pending_replace_target_gone' });
          continue;
        }
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
  private resolvePlanFromJobRow(row: Record<string, unknown>): RecoveryPlan | null {
    const scopeKind = row.scope_kind as 'branch' | 'tenant' | null | undefined;
    const entityType = row.requested_entity_type as string | null | undefined;
    const entityId = row.requested_entity_id as string | null | undefined;
    const role = row.requested_role as string | null | undefined;
    const hash = row.request_hash as string | null | undefined;
    if (!scopeKind || !entityType || !entityId || !role || !hash) return null;
    if (scopeKind !== 'branch' && scopeKind !== 'tenant') return null;
    // 3A-R1/R2: the gallery slot AND the operation come from the DURABLE
    // intent, never from a default. A corrupt intent, or a job with no intent
    // at all, cannot be recovered without guessing → refuse (the caller
    // reports left_pending_no_manifest).
    let intent: PendingIntentPayload | null;
    try {
      intent = parseCachedIntent(row.result_json);
    } catch {
      return null; // corrupt payload — fail closed
    }
    const linkIntent = intent?.linkIntent;
    if (!intent || !linkIntent) return null;
    const base: FinalizeInput = {
      tenantId: String(row.tenant_id),
      branchId: scopeKind === 'branch' ? (row.branch_id ? String(row.branch_id) : null) : null,
      ingestRequestId: String(row.ingest_request_id),
      requestHash: hash,
      entityType,
      entityId,
      scopeKind,
      role,
      isPrimary: linkIntent.isPrimary,
      sortOrder: linkIntent.sortOrder,
      securityClass: (row.security_class as FinalizeInput['securityClass']) ?? 'internal',
      retentionClass: (row.retention_class as FinalizeInput['retentionClass']) ?? 'standard',
    };
    if (operationOf(intent) === 'replace') {
      // parseCachedIntent already guaranteed a non-empty previousLinkId for a
      // replace; the guard keeps the type narrow without a cast.
      const previousLinkId = intent.previousLinkId;
      if (!previousLinkId) return null;
      return { op: 'replace', input: { ...base, previousLinkId } };
    }
    return { op: 'append', input: base };
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

  private ensureLink(
    input: FinalizeInput,
    linkId: string,
    mediaId: string,
    now: string,
    linkIntent: LinkIntent,
  ): void {
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
      // Re-activate a previously soft-deleted link (idempotent re-finalize)
      // at the frozen slot — never at a guessed one.
      if (existing.deleted_at != null) {
        this.db.run(
          `UPDATE media_links
              SET deleted_at = NULL,
                  is_primary = $p,
                  sort_order = $so
            WHERE tenant_id = $t AND link_id = $l`,
          [
            linkIntent.isPrimary ? 1 : 0,
            linkIntent.sortOrder,
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
        linkIntent.sortOrder,
        linkIntent.isPrimary ? 1 : 0,
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
    /** The exact slot the new link must take. For `replace` this is the old
     *  link's inherited position; the append-position check is deliberately
     *  NOT applied, because a replace re-uses an existing slot instead of
     *  appending a new one. */
    slot: LinkIntent,
    /** Which operation this preamble implements, and (for a replace) the link
     *  it retires. Both are compared against the durable intent so a frozen
     *  replace can never be finished as an append or against another target. */
    operation: IntentOperation,
    previousLinkId?: string,
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
    const priorIntent = parseCachedIntent(existing?.result_json);
    if (priorIntent) {
      if (operationOf(priorIntent) !== operation) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT', 'MEDIA_INTENT_OPERATION_MISMATCH');
      }
      if ((priorIntent.previousLinkId ?? undefined) !== previousLinkId) {
        throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT', 'MEDIA_INTENT_TARGET_MISMATCH');
      }
    }
    const frozen = priorIntent?.linkIntent;
    if (frozen && !linkIntentsEqual(frozen, slot)) {
      throw new CoordinatorError('MEDIA_INGEST_REQUEST_CONFLICT');
    }
    const linkIntent = frozen ?? slot;
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
      this.ensureLink(input, linkId, mediaId, now, linkIntent);
      // Same backstop as `finalize`: a replace must leave a valid gallery.
      assertGalleryWellFormed(
        this.activeGalleryLinks({
          tenantId: input.tenantId,
          scopeKind: input.scopeKind,
          branchId: input.branchId,
          entityType: input.entityType,
          entityId: input.entityId,
          role: input.role,
        }),
      );
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
        linkIntent: { ...linkIntent },
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
  // 3A-R1 link-intent: real values now, but structurally sane ones only.
  // (Whether the position is legal for THIS gallery is decided later against
  // the live active-link count — see `assertAppendPosition`.)
  if (input.isPrimary !== undefined && typeof input.isPrimary !== 'boolean') {
    throw new CoordinatorError('MEDIA_INVALID_INPUT');
  }
  if (input.sortOrder !== undefined) {
    const s = input.sortOrder;
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 0) {
      throw new CoordinatorError('MEDIA_INVALID_INPUT');
    }
  }
}

/** The caller's requested slot, defaulted to the first-image shape. */
function linkIntentOf(input: FinalizeInput): LinkIntent {
  return {
    isPrimary: input.isPrimary ?? LINK_INTENT_FIRST_IMAGE.isPrimary,
    sortOrder: input.sortOrder ?? LINK_INTENT_FIRST_IMAGE.sortOrder,
  };
}

function linkIntentsEqual(a: LinkIntent, b: LinkIntent): boolean {
  return a.isPrimary === b.isPrimary && a.sortOrder === b.sortOrder;
}

/**
 * The canonical gallery invariants, checked against a set of ACTIVE link rows
 * (already ordered by sort_order):
 *   • sort_order values are integers, unique, and contiguous 0..N-1
 *   • N = 0 → no primary
 *   • N > 0 → exactly one primary, and it sits at sort_order 0
 *
 * The DB's partial-unique index only guarantees "at most one primary"; the
 * "exactly one, at position 0, with no gaps" half is ours to enforce, both
 * here and in the resolver. Throws MEDIA_DB_MEDIA_CONFLICT on any violation.
 */
function assertGalleryWellFormed(rows: Array<Record<string, unknown>>): void {
  const issue = inspectGallery(rows);
  if (issue) throw new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT', issue);
}

/** Non-throwing variant — returns a stable reason string, or null if valid.
 *  Shared with the read-only resolver so both sides judge identically. */
export function inspectGallery(rows: Array<Record<string, unknown>>): string | null {
  const n = rows.length;
  const seen = new Set<number>();
  let primaries = 0;
  let primaryAtZero = false;
  for (const r of rows) {
    const so = Number(r.sort_order);
    if (!Number.isInteger(so) || so < 0) return 'MEDIA_GALLERY_SORT_INVALID';
    if (seen.has(so)) return 'MEDIA_GALLERY_SORT_DUPLICATE';
    seen.add(so);
    if (Number(r.is_primary) === 1) {
      primaries++;
      if (so === 0) primaryAtZero = true;
    }
  }
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) return 'MEDIA_GALLERY_SORT_GAP';
  }
  if (n === 0) return primaries > 0 ? 'MEDIA_GALLERY_PRIMARY_WITHOUT_ITEMS' : null;
  if (primaries === 0) return 'MEDIA_GALLERY_NO_PRIMARY';
  if (primaries > 1) return 'MEDIA_GALLERY_MULTIPLE_PRIMARY';
  if (!primaryAtZero) return 'MEDIA_GALLERY_PRIMARY_NOT_FIRST';
  return null;
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

/**
 * The single authority on what a `media_ingest_jobs.result_json` cell means.
 *
 * Exactly four outcomes, and nothing in between:
 *   absent  — the cell is NULL/undefined; the job simply has no payload yet
 *   intent  — a structurally valid, version-validated pre-publication intent
 *   result  — a structurally valid frozen finalize result
 *   corrupt — anything else: non-JSON, an unknown `kind`, an unknown
 *             `intentVersion`, a malformed `linkIntent`/`operation`, a
 *             `replace` without its `previousLinkId` (or vice versa), or a
 *             `result` missing an identity field
 *
 * `corrupt` is deliberately NOT collapsed into `absent`: treating a damaged
 * payload as "nothing stored" would let the writer re-derive a slot it never
 * chose. Every caller fails closed on `corrupt` instead.
 */
type ResultJsonView =
  | { kind: 'absent' }
  | { kind: 'intent'; intent: PendingIntentPayload }
  | { kind: 'result'; result: FinalizeResult }
  | { kind: 'corrupt' };

const CORRUPT: ResultJsonView = { kind: 'corrupt' };

function parseResultJson(raw: unknown): ResultJsonView {
  if (raw == null) return { kind: 'absent' };
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return CORRUPT; // the column is ours alone — non-JSON means damage
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return CORRUPT;
  if (parsed.kind === 'result') return parseResultEnvelope(parsed);
  if (parsed.kind === 'intent') return parseIntentEnvelope(parsed);
  return CORRUPT; // unknown discriminator → fail closed
}

function parseResultEnvelope(parsed: any): ResultJsonView {
  const v = parsed.value;
  if (!v || typeof v !== 'object') return CORRUPT;
  const identityOk =
    typeof v.jobId === 'string' &&
    typeof v.ingestRequestId === 'string' &&
    typeof v.requestHash === 'string' &&
    v.state === 'ready' &&
    typeof v.mediaId === 'string' &&
    typeof v.linkId === 'string';
  if (!identityOk) return CORRUPT;
  if (v.linkIntent !== undefined && !isValidLinkIntent(v.linkIntent)) return CORRUPT;
  return { kind: 'result', result: v as FinalizeResult };
}

function parseIntentEnvelope(parsed: any): ResultJsonView {
  if (!parsed.main || !parsed.thumbnail) return CORRUPT;
  const ver = parsed.intentVersion;
  if (ver !== undefined && ver !== 1 && ver !== 2 && ver !== 3) return CORRUPT;

  // ── operation (v3+) ──
  const hasOp = parsed.operation !== undefined;
  if (hasOp && parsed.operation !== 'append' && parsed.operation !== 'replace') {
    return CORRUPT;
  }
  const operation: IntentOperation = hasOp ? parsed.operation : 'append';
  // A previousLinkId only ever belongs to a replace, and a replace is useless
  // without one — either mismatch is ambiguous, so both fail closed.
  const prev = parsed.previousLinkId;
  if (operation === 'replace') {
    if (typeof prev !== 'string' || prev === '') return CORRUPT;
  } else if (prev !== undefined) {
    return CORRUPT;
  }

  // ── linkIntent ──
  if ('linkIntent' in parsed && parsed.linkIntent !== undefined) {
    if (!isValidLinkIntent(parsed.linkIntent)) return CORRUPT;
    return {
      kind: 'intent',
      intent: { ...(parsed as PendingIntentPayload), operation },
    };
  }
  // No linkIntent at all — only legal for a v1 payload, which meant an APPEND
  // of the first image and nothing else. A v3 replace without a slot would be
  // a guess, so it is rejected above by the operation check landing here.
  if (operation !== 'append') return CORRUPT;
  return {
    kind: 'intent',
    intent: {
      ...(parsed as PendingIntentPayload),
      intentVersion: 1,
      operation: 'append',
      linkIntent: { ...LINK_INTENT_FIRST_IMAGE },
    },
  };
}

function isValidLinkIntent(li: any): boolean {
  return (
    !!li &&
    typeof li.isPrimary === 'boolean' &&
    typeof li.sortOrder === 'number' &&
    Number.isInteger(li.sortOrder) &&
    li.sortOrder >= 0
  );
}

/** The frozen finalize result, or null when the cell holds an intent/nothing.
 *  Throws on a damaged cell — a corrupt payload must never read as "absent". */
function parseCachedResult(raw: unknown): FinalizeResult | null {
  const view = parseResultJson(raw);
  if (view.kind === 'corrupt') throw corruptIntent();
  return view.kind === 'result' ? view.result : null;
}

/** The frozen pre-publication intent, or null when the cell holds a result/
 *  nothing. Throws on a damaged cell. */
function parseCachedIntent(raw: unknown): PendingIntentPayload | null {
  const view = parseResultJson(raw);
  if (view.kind === 'corrupt') throw corruptIntent();
  return view.kind === 'intent' ? view.intent : null;
}

function corruptIntent(): CoordinatorError {
  return new CoordinatorError('MEDIA_DB_MEDIA_CONFLICT', 'MEDIA_INTENT_CORRUPT');
}

/** The operation a stored intent describes, defaulted for pre-v3 payloads. */
function operationOf(intent: PendingIntentPayload): IntentOperation {
  return intent.operation ?? 'append';
}

/** Storage-key format contract shared with the Rust core (`{scope}/{aa}/{hash}.{ext}`). */
function storageKeyFor(scope: string, hash: string, extension: string): string {
  return `${scope}/${hash.slice(0, 2)}/${hash}.${extension}`;
}

function intentPayloadFor(
  scope: string,
  prepared: PrepareResult,
  linkIntent: LinkIntent,
  operation: IntentOperation,
  previousLinkId?: string,
): PendingIntentPayload {
  return {
    kind: 'intent',
    intentVersion: 3,
    operation,
    ...(operation === 'replace' ? { previousLinkId } : {}),
    main: {
      ...prepared.main_descriptor,
      storage_key: storageKeyFor(scope, prepared.main_descriptor.hash, prepared.main_descriptor.extension),
    },
    thumbnail: {
      ...prepared.thumbnail_descriptor,
      storage_key: storageKeyFor(scope, prepared.thumbnail_descriptor.hash, prepared.thumbnail_descriptor.extension),
    },
    linkIntent: { ...linkIntent },
  };
}

/** Build an intent-shaped snapshot from a CommitResult — same shape as the
 *  intent we would have written pre-publication, so recovery can compare
 *  them for equality without leaking any commit-only fields. */
function intentPayloadFrom(
  scope: string,
  commit: CommitResult,
  linkIntent: LinkIntent,
  operation: IntentOperation,
  previousLinkId?: string,
): PendingIntentPayload {
  void scope; // scope is implicit in the storage_key format; kept for symmetry
  return {
    kind: 'intent',
    intentVersion: 3,
    operation,
    ...(operation === 'replace' ? { previousLinkId } : {}),
    main: {
      ...commit.main_descriptor,
      storage_key: commit.main_storage_key,
    },
    thumbnail: {
      ...commit.thumbnail_descriptor,
      storage_key: commit.thumbnail_storage_key,
    },
    linkIntent: { ...linkIntent },
  };
}

/**
 * Full manifest equality — content descriptors AND the frozen link intent.
 *
 * The Rust-computed `request_hash` binds only the *bytes* + normalisation
 * params; it does NOT cover the gallery position. So a retry that reuses the
 * same `ingest_request_id` and the same hash but asks for a DIFFERENT slot
 * must be caught here, by exact manifest comparison, before any Rust commit.
 */
function intentsEqual(a: PendingIntentPayload, b: PendingIntentPayload): boolean {
  const aLink = a.linkIntent ?? LINK_INTENT_FIRST_IMAGE;
  const bLink = b.linkIntent ?? LINK_INTENT_FIRST_IMAGE;
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
    a.thumbnail.storage_key === b.thumbnail.storage_key &&
    linkIntentsEqual(aLink, bLink) &&
    // 3A-R2: the operation and its target are part of the manifest identity.
    // Same request id + same bytes + same slot but "replace X" vs "append"
    // (or "replace Y") are different requests and must not be conflated.
    operationOf(a) === operationOf(b) &&
    (a.previousLinkId ?? null) === (b.previousLinkId ?? null)
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
