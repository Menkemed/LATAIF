// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-2B2 — Production ingest orchestrator.
//
// Glues the three pieces the previous slices already delivered:
//   1. TauriMediaGateway  → the 5 Rust `#[tauri::command]` media handlers
//   2. MediaDbCoordinator → the atomic 6-table sql.js write path
//   3. saveDatabaseDurably → the canonical, throw-on-failure disk persistence
//
// The orchestrator is INACTIVE outside its own test suite (no React caller
// wires `getStockMediaOrchestrator()` yet). Every dependency is injectable,
// so tests bring their own gateway / lease / save behaviour while production
// gets the singleton wired through `acquireDbLease` from database.ts.
//
// Persistence contract enforced here:
//   • The caller only sees success AFTER the underlying sql.js state has been
//     durably written to disk. If the save step throws, the orchestrator
//     surfaces `MEDIA_ORCH_DB_PERSIST_FAILED` — the in-memory sql.js COMMIT
//     is NOT sold as durability.
//   • A save-time failure is safely retryable: `coordinator.finalize` is
//     already idempotent (frozen `result_json`), so calling
//     `ingestAndFinalizeStockImage` again with the same request converges
//     without duplicates.
//
// R3 — DB-lease + operation serialisation:
//   Every operation acquires a `DbLease` from `database.ts` and holds it
//   until the operation completes (success or failure). While a lease is
//   held, `reloadDbFromDisk`/`resetDatabase` block on release — the module-
//   level `db` cannot swap under the coordinator's feet, so the coalescer
//   inside `saveDatabaseDurably` always exports the same instance the
//   coordinator wrote to. If a swap ever bypasses the wait (defence in
//   depth), the lease's save throws `DbLeaseInvalidatedError`, which the
//   orchestrator translates to `MEDIA_ORCH_DB_INSTANCE_CHANGED`.
//
//   A process-scoped operation-mutex serialises `ingestAndFinalizeStockImage`
//   and `recoverPendingStockMedia` calls against each other on the same
//   orchestrator instance — no overlapping `BEGIN IMMEDIATE` transactions,
//   no lost checkpoints, no cross-op interference on the shared DB.
// ════════════════════════════════════════════════════════════════════════════

import type {
  MediaCommandGateway,
  PrepareResult,
  AbortResult,
  RecoveryOutcome,
} from './gateway.ts';
import type {
  FinalizeInput,
  FinalizeResult,
  RecoveryReport,
  ReplaceInput,
} from './coordinator.ts';
import { MediaDbCoordinator } from './coordinator.ts';

// ── error contract ──────────────────────────────────────────────────────────

export type OrchestratorErrorCode =
  | 'MEDIA_ORCH_PREPARE_FAILED'
  | 'MEDIA_ORCH_DB_PERSIST_FAILED'
  | 'MEDIA_ORCH_DB_INSTANCE_CHANGED';

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  readonly cause?: unknown;
  constructor(code: OrchestratorErrorCode, message?: string, cause?: unknown) {
    super(message ?? code);
    this.code = code;
    this.cause = cause;
    this.name = 'OrchestratorError';
  }
}

// ── input DTOs ──────────────────────────────────────────────────────────────

export interface IngestAndFinalizeInput extends FinalizeInput {
  imageBytes: Uint8Array;
  originalName?: string;
}

export interface ReplaceStockImageInput extends ReplaceInput {
  imageBytes: Uint8Array;
  originalName?: string;
}

export interface RemoveStockMediaLinkInput {
  tenantId: string;
  linkId: string;
}

export interface AbortStockImageInput {
  tenantId: string;
  ingestRequestId: string;
}

export interface RecoveryOrchestrationResult {
  /** Raw report from `gateway.recoverMediaIngests` (Rust journal side). */
  rustReport: RecoveryOutcome[];
  /** Raw report from `coordinator.recover` (DB side). */
  dbReport: RecoveryReport[];
  /** Whether the DB changed materially and therefore a durable save was
   *  requested. */
  dbChanged: boolean;
}

// ── dependencies ────────────────────────────────────────────────────────────

/**
 * Minimal shape the DB coordinator consumes and the lease exposes.
 */
export type OrchestratorRawDb = ConstructorParameters<typeof MediaDbCoordinator>[0];

/**
 * The DB lifecycle lease. Same shape as `database.ts::DbLease` (kept a
 * separate declaration here so the orchestrator can be tested against a
 * fake lease without importing `database.ts`).
 */
export interface OrchestratorLease {
  readonly db: OrchestratorRawDb;
  readonly epoch: number;
  saveDurably(): Promise<void>;
  release(): void;
}

export interface OrchestratorDeps {
  gateway: MediaCommandGateway;
  /**
   * Acquire a lease binding the current DB instance. Called once per
   * operation; released in a `finally` block. May be async: the production
   * `acquireDbLease` awaits any in-flight reload/reset swap before returning,
   * so a new operation can never overtake a DB swap. Tests hand in a fake
   * (sync or async).
   */
  leaseFactory: () => OrchestratorLease | Promise<OrchestratorLease>;
  /**
   * How to build a coordinator against the leased DB instance. Defaults to
   * `new MediaDbCoordinator(db, gateway)` and only needs an override for
   * tests that intercept coordinator calls.
   */
  coordinatorFactory?: (
    db: OrchestratorRawDb,
    gateway: MediaCommandGateway,
  ) => MediaDbCoordinator;
}

// ── service ─────────────────────────────────────────────────────────────────

export class StockMediaOrchestrator {
  private readonly gateway: MediaCommandGateway;
  private readonly leaseFactory: () => OrchestratorLease | Promise<OrchestratorLease>;
  private readonly coordinatorFactory: (
    db: OrchestratorRawDb,
    gateway: MediaCommandGateway,
  ) => MediaDbCoordinator;
  /**
   * Chain-based mutex — every op links onto the previous op's completion.
   * `ingestAndFinalizeStockImage` and `recoverPendingStockMedia` share the
   * same chain, so the two never overlap on the leased DB.
   */
  private opsChain: Promise<void> = Promise.resolve();

  constructor(deps: OrchestratorDeps) {
    this.gateway = deps.gateway;
    this.leaseFactory = deps.leaseFactory;
    this.coordinatorFactory =
      deps.coordinatorFactory ?? ((db, gw) => new MediaDbCoordinator(db, gw));
  }

  /**
   * Run `fn` inside the process-scoped media-operations mutex.
   *
   * Failure-safe queue: the chain link is a promise that only ever *resolves*
   * (via `release`, called in `finally`), so a failing operation frees the
   * lock and the next operation proceeds normally — a rejected `fn()` can
   * never poison `opsChain` nor leave it permanently blocked. The `.catch`
   * on the predecessor await is belt-and-braces against any future code that
   * might reject the chain link directly.
   */
  private async withOpsLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.opsChain;
    let release!: () => void;
    this.opsChain = new Promise<void>((r) => {
      release = r;
    });
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Translate the DB-side lease-invalidation into the orchestrator's
   *  wire-facing code. */
  private wrapLeaseError(e: unknown, code: 'MEDIA_ORCH_DB_INSTANCE_CHANGED' | 'MEDIA_ORCH_DB_PERSIST_FAILED'): never {
    const name = (e as { name?: string })?.name ?? '';
    const message = (e as { message?: string })?.message ?? String(e);
    if (name === 'DbLeaseInvalidatedError' || message.startsWith('DB_LEASE_INVALIDATED') || /lease released|db instance drifted/.test(message)) {
      throw new OrchestratorError('MEDIA_ORCH_DB_INSTANCE_CHANGED', message, e);
    }
    throw new OrchestratorError(code, message, e);
  }

  /**
   * Drive a single upload to a durably persisted `ready` link.
   *
   * Sequence — each step blocks on the previous, none are fire-and-forget:
   *   1. Acquire DB lease (pins the sql.js instance)
   *   2. prepareStockImage       — Rust normalises bytes + STAGES a temp
   *                                copy of the content-addressed rendition.
   *   3. registerPendingIntent   — persist the full recovery manifest.
   *   4. lease.saveDurably       — checkpoint 1: flush intent to disk.
   *   5. coordinator.finalize    — Rust commit + verify + one atomic DB tx.
   *   6. lease.saveDurably       — checkpoint 2: flush final state.
   *   7. Release lease + return the coordinator's frozen result.
   *
   * Failure behaviour (§4 of the R1 slice, preserved verbatim):
   *   • prepare fails                       → no DB touch, no Rust publish
   *   • register fails                      → no Rust publish
   *   • checkpoint 1 fails                  → no Rust publish; no success
   *   • Rust/finalize fails after cp1       → intent stays on disk,
   *                                           recoverable via recover()
   *   • checkpoint 2 fails                  → intent + finalized-in-memory;
   *                                           on-disk state is still at
   *                                           cp1 intent — recovery converges
   *   • lease invalidated at any point      → MEDIA_ORCH_DB_INSTANCE_CHANGED;
   *                                           no cross-instance write, no
   *                                           persist-into-a-foreign-DB.
   *   • DB reload/reset during the op       → BLOCKED at reload/reset side
   *                                           (awaitNoActiveLeases); the swap
   *                                           only runs after this op ends.
   */
  async ingestAndFinalizeStockImage(input: IngestAndFinalizeInput): Promise<FinalizeResult> {
    return this.withOpsLock(async () => {
      const lease = await this.leaseFactory();
      try {
        const coordinator = this.coordinatorFactory(lease.db, this.gateway);

        // 1) Rust prepare — normalise + hash + stage. Nothing is published.
        let prepareResult: PrepareResult;
        try {
          prepareResult = await this.gateway.prepareStockImage({
            tenantScope: input.tenantId,
            ingestRequestId: input.ingestRequestId,
            requestHash: input.requestHash,
            imageBytes: input.imageBytes,
            originalName: input.originalName,
          });
        } catch (e) {
          throw new OrchestratorError('MEDIA_ORCH_PREPARE_FAILED', asMessage(e), e);
        }

        // 2) DB intent — full recovery manifest for a would-be publish.
        coordinator.registerPendingIntent(input, prepareResult);

        // 3) Checkpoint 1 — the intent MUST land on disk before we let the
        //    Rust core promote the staged rendition to a published storage key.
        try {
          await lease.saveDurably();
        } catch (e) {
          this.wrapLeaseError(e, 'MEDIA_ORCH_DB_PERSIST_FAILED');
        }

        // 4) DB finalize — Rust commit + verify + atomic 6-table tx.
        const dbResult: FinalizeResult = await coordinator.finalize(input);

        // 5) Checkpoint 2 — the finalized state MUST land on disk.
        try {
          await lease.saveDurably();
        } catch (e) {
          this.wrapLeaseError(e, 'MEDIA_ORCH_DB_PERSIST_FAILED');
        }

        return dbResult;
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Replace one existing link's image, durably (3A-R2).
   *
   * Identical two-checkpoint shape as the ingest path, with ONE decisive
   * difference at step 2: the registered intent is a *replace* intent — it
   * freezes `operation:'replace'` plus the exact `previousLinkId`. That is
   * what makes a crash between publish and commit recoverable: without it,
   * `recover()` could only see "some ingest for product X, slot N" and would
   * re-run it as an append, leaving two links fighting over one slot.
   *
   *   1. Acquire DB lease            (pins the sql.js instance)
   *   2. prepareStockImage           (Rust normalises + stages; no publish)
   *   3. registerPendingReplaceIntent(durable operation + target + slot)
   *   4. lease.saveDurably           — checkpoint 1
   *   5. coordinator.replace         (Rust commit + verify + one atomic tx:
   *                                   retire old link, insert new at the very
   *                                   same slot)
   *   6. lease.saveDurably           — checkpoint 2
   *
   * Failure behaviour mirrors the ingest path exactly. In particular a cp2
   * failure leaves the DB finalized in memory but on-disk at the cp1 intent —
   * `recoverPendingStockMedia` then converges it as a REPLACE, never as an
   * append. No physical file is ever deleted here; the old rendition stays on
   * disk and the retired link row is kept as audit + legacy-suppression proof.
   */
  async replaceStockImage(input: ReplaceStockImageInput): Promise<FinalizeResult> {
    return this.withOpsLock(async () => {
      const lease = await this.leaseFactory();
      try {
        const coordinator = this.coordinatorFactory(lease.db, this.gateway);

        let prepareResult: PrepareResult;
        try {
          prepareResult = await this.gateway.prepareStockImage({
            tenantScope: input.tenantId,
            ingestRequestId: input.ingestRequestId,
            requestHash: input.requestHash,
            imageBytes: input.imageBytes,
            originalName: input.originalName,
          });
        } catch (e) {
          throw new OrchestratorError('MEDIA_ORCH_PREPARE_FAILED', asMessage(e), e);
        }

        coordinator.registerPendingReplaceIntent(input, prepareResult);

        try {
          await lease.saveDurably();
        } catch (e) {
          this.wrapLeaseError(e, 'MEDIA_ORCH_DB_PERSIST_FAILED');
        }

        const dbResult = await coordinator.replace(input);

        try {
          await lease.saveDurably();
        } catch (e) {
          this.wrapLeaseError(e, 'MEDIA_ORCH_DB_PERSIST_FAILED');
        }

        return dbResult;
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Remove one link from a gallery, durably (3A-R2).
   *
   * `coordinator.remove` already does the whole array surgery — retire,
   * compact the survivors down, promote the new head — inside ONE atomic tx.
   * The only thing missing for production was that the result never reached
   * the disk; this path adds exactly that, under the same lease + ops-lock as
   * every other media mutation.
   *
   * No pre-publication checkpoint is needed: there is no Rust publication to
   * order against, and the tx is all-or-nothing. A save failure leaves the
   * on-disk gallery at its pre-remove state and is safely retryable, because
   * removing an already-retired link is a no-op.
   *
   * NOTHING is physically deleted — not the link row, not the blob, not the
   * file on disk.
   */
  async removeStockMediaLink(input: RemoveStockMediaLinkInput): Promise<void> {
    return this.withOpsLock(async () => {
      const lease = await this.leaseFactory();
      try {
        const coordinator = this.coordinatorFactory(lease.db, this.gateway);
        coordinator.remove(input);
        try {
          await lease.saveDurably();
        } catch (e) {
          this.wrapLeaseError(e, 'MEDIA_ORCH_DB_PERSIST_FAILED');
        }
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Reconcile every open ingest against the Rust core and the DB, then save
   * once if anything moved. Idempotent — a follow-up call is a no-op.
   *
   * Runs inside the same operation mutex as ingest, so it never overlaps
   * with an in-flight `ingestAndFinalizeStockImage` on the same orchestrator.
   */
  async recoverPendingStockMedia(): Promise<RecoveryOrchestrationResult> {
    return this.withOpsLock(async () => {
      const lease = await this.leaseFactory();
      try {
        const coordinator = this.coordinatorFactory(lease.db, this.gateway);
        const rustReport = await this.gateway.recoverMediaIngests();

        const dbReport = await coordinator.recover();
        const dbChanged = dbReport.some(
          (r) =>
            r.action === 'finalized_from_ready_rust' ||
            r.action === 'replaced_from_ready_rust' ||
            r.action === 'quarantined_verification_failed',
        );
        if (dbChanged) {
          try {
            await lease.saveDurably();
          } catch (e) {
            this.wrapLeaseError(e, 'MEDIA_ORCH_DB_PERSIST_FAILED');
          }
        }
        return { rustReport, dbReport, dbChanged };
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Abort a *prepared, not yet published* Rust ingest. After a successful
   * commit the Rust core refuses the abort (already-published), and no file
   * is physically deleted from this path. No DB write — no lease required.
   */
  async abortStockImage(input: AbortStockImageInput): Promise<AbortResult> {
    return this.gateway.abortStockImage({
      tenantScope: input.tenantId,
      ingestRequestId: input.ingestRequestId,
    });
  }
}

// ── production factory (lazy singleton) ─────────────────────────────────────
//
// The singleton lives forever, but holds no `RawDb` — every operation takes
// a fresh lease. When the process reloads/resets the DB, the next operation
// picks up the new instance transparently, and any in-flight operation
// completes on its own leased instance before the swap can happen.

let productionSingleton: StockMediaOrchestrator | null = null;

/**
 * Build (once) and return the app-wide production orchestrator. Wired to
 * `TauriMediaGateway` and the DB-lease API in `../db/database.ts`.
 */
export async function getStockMediaOrchestrator(): Promise<StockMediaOrchestrator> {
  if (productionSingleton) return productionSingleton;
  const [{ acquireDbLease }, { TauriMediaGateway }] = await Promise.all([
    import('../db/database.ts'),
    import('./gateway.ts'),
  ]);
  const gateway = new TauriMediaGateway();
  productionSingleton = new StockMediaOrchestrator({
    gateway,
    // `acquireDbLease` is async: it awaits any in-flight reload/reset swap,
    // so an operation started during a swap waits rather than racing it.
    leaseFactory: () => acquireDbLease() as unknown as Promise<OrchestratorLease>,
  });
  return productionSingleton;
}

/** Test-only reset — never called from production code. */
export function __resetStockMediaOrchestratorForTests(): void {
  productionSingleton = null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function asMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
