// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2B-R3 — startup media recovery runner.
//
// After the DB is initialised and after every DB reload, any create-batch that
// was left half-published (durable intents, some slots not yet finalized) must
// be driven to completion so the resolver flips from `pending` to a full media
// gallery. That is exactly what `recoverPendingStockMedia` does — it already
// runs under the operations-lock + DB-lease and is idempotent.
//
// This module adds the ONCE-PER-EPOCH gate + the non-blocking, fail-safe
// wrapper, plus a hook to feed the just-completed products to the embedding
// guard. Framework-agnostic + injected, so it is node-testable; the DB layer
// fires it (fire-and-forget) from init/reload.
// ════════════════════════════════════════════════════════════════════════════

export interface CompletedProductScope {
  tenantId: string;
  branchId: string | null;
  productId: string;
  role: string;
}

export interface StartupRecoveryOutcome {
  completedProductIds: CompletedProductScope[];
}

export interface StartupRecoveryDeps {
  /** Current DB epoch — bumped on every real reload/reset. Recovery runs at
   *  most once per epoch. */
  currentEpoch: () => number;
  /** Run the actual recovery (orchestrator.recoverPendingStockMedia). */
  recover: () => Promise<StartupRecoveryOutcome>;
  /** Feed the products whose batch just completed to the embedding guard. Runs
   *  only when recovery succeeded and produced completions. */
  onCompletedProducts?: (scopes: CompletedProductScope[]) => void;
  /** Non-fatal error sink (never throws out of the runner). */
  log?: (message: string, err?: unknown) => void;
}

export type StartupRecoveryResult = 'ran' | 'skipped' | 'error';

// One-per-epoch guard (3B2B-R4). Two module-scoped maps split "done" from
// "in flight":
//   • completedEpochs — epochs whose recovery SUCCEEDED. A repeat is a
//     `skipped` no-op. A reload bumps the epoch and re-arms recovery.
//   • inFlight — the single live run per epoch. Concurrent triggers of the same
//     epoch share THIS promise instead of starting a second, overlapping pass.
// A FAILED epoch is left in neither map, so the next explicit trigger retries
// it. There is no automatic loop — one run per call — so a persistent fault
// cannot spin or block the app; the gallery just stays `pending`.
let completedEpochs = new Set<number>();
let inFlight = new Map<number, Promise<StartupRecoveryResult>>();

/** Test-only — clears the once-per-epoch memory. */
export function __resetStartupRecoveryForTests(): void {
  completedEpochs = new Set<number>();
  inFlight = new Map<number, Promise<StartupRecoveryResult>>();
}

/**
 * Run startup media recovery at most once per DB epoch, retryable on failure.
 *
 *   • success is memoised: a later call in the same epoch is a `skipped` no-op;
 *   • concurrency-safe: two triggers of the same epoch await ONE shared run,
 *     never two overlapping recovery passes on the same DB;
 *   • retryable: a failed pass memoises nothing, so the NEXT explicit trigger
 *     runs recovery again — but nothing here schedules that retry, so a
 *     persistent fault neither loops nor blocks the app;
 *   • non-blocking + fail-safe: any error is swallowed (logged) and reported as
 *     `error` — it never throws, and never shows a partial gallery (the
 *     resolver keeps returning `pending` until a pass finally succeeds).
 */
export async function runStartupMediaRecovery(deps: StartupRecoveryDeps): Promise<StartupRecoveryResult> {
  const epoch = deps.currentEpoch();
  if (completedEpochs.has(epoch)) return 'skipped';
  const running = inFlight.get(epoch);
  if (running) return running; // shared in-flight promise for concurrent triggers
  const run = (async (): Promise<StartupRecoveryResult> => {
    try {
      const outcome = await deps.recover();
      // Only a SUCCESSFUL pass is memoised — a failure below stays retryable.
      completedEpochs.add(epoch);
      if (outcome.completedProductIds.length > 0) {
        try {
          deps.onCompletedProducts?.(outcome.completedProductIds);
        } catch (e) {
          // A side-effect failure (e.g. embedding) must not fail recovery.
          deps.log?.('startup recovery: completed-products hook failed', e);
        }
      }
      return 'ran';
    } catch (e) {
      // Do NOT memoise: the epoch remains retryable on the next explicit
      // trigger. No auto-retry is scheduled here — no loop, no block.
      deps.log?.('startup media recovery failed', e);
      return 'error';
    } finally {
      inFlight.delete(epoch);
    }
  })();
  inFlight.set(epoch, run);
  return run;
}
