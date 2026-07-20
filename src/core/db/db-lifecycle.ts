// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-2B2-R4 — DB lifecycle reader/writer controller.
//
// The pure, dependency-free core of the DB-lifecycle lease. Extracted from
// database.ts so it can be exercised by real behavioural tests in Node
// (database.ts eagerly pulls sql.js + browser glue that Node cannot load).
// database.ts owns a single instance of this controller and routes both the
// media-operation leases (readers) and the reload/reset DB swaps (writers)
// through it.
//
// Reader/writer contract:
//   • A media/DB operation acquires a *shared* lease. Many leases may be
//     held at once.
//   • A reload/reset performs an *exclusive* swap. A swap:
//       1. registers as pending the instant runExclusiveSwap is called
//          (`pendingSwaps++`, BEFORE any await) — from this moment no new
//          lease may start, even while the swap is still queued behind
//          another swap. This is what stops a steady stream of new leases
//          from starving a queued swap AND stops a lease from slipping in
//          between two serialised swaps.
//       2. serialises against every other swap (swapChain),
//       3. waits for all active leases to release,
//       4. runs the caller's `mutate` (the actual DB replacement), which
//          calls `bumpEpoch()` iff a real swap happened,
//       5. in a `finally`, decrements `pendingSwaps`; parked lease requests
//          are woken ONLY when `pendingSwaps` reaches 0 — i.e. after every
//          queued swap has finished. A throwing `mutate` still heals the
//          counter and lets later swaps run.
//   • `acquireLease` waits while `pendingSwaps > 0`, so a new lease can never
//     overtake a pending or active swap.
// ════════════════════════════════════════════════════════════════════════════

/** Error surfaced when a lease's bound DB drifts (defence in depth) or the
 *  lease was already released. database.ts re-exports this. */
export class DbLeaseInvalidatedError extends Error {
  constructor(msg?: string) {
    super(msg ?? 'DB_LEASE_INVALIDATED');
    this.name = 'DbLeaseInvalidatedError';
  }
}

/** A held shared lease. `epoch` is the lifecycle epoch at acquisition time. */
export interface LifecycleLease {
  readonly epoch: number;
  /** Idempotent — safe to call in a `finally`. */
  release(): void;
}

export class DbLifecycleController {
  private epoch = 0;
  private activeLeases = 0;
  /** Number of swaps that are pending OR active. Incremented at the very
   *  start of `runExclusiveSwap` (before any await) and decremented in its
   *  `finally`. While `> 0`, no new lease may start, and parked lease
   *  requests are held until it returns to 0 — so a queue of swaps drains
   *  fully before any reader is admitted. */
  private pendingSwaps = 0;
  /** Lease requests parked because a swap is pending/active. */
  private leaseWaiters: Array<() => void> = [];
  /** The single swap currently waiting for leases to drain (swaps are
   *  serialised, so at most one waits at a time). */
  private leaseDrainWaiter: (() => void) | null = null;
  /** Serialises swaps against each other. */
  private swapChain: Promise<void> = Promise.resolve();

  currentEpoch(): number {
    return this.epoch;
  }
  activeLeaseCount(): number {
    return this.activeLeases;
  }
  /** True while at least one swap is pending or active. */
  isSwapInProgress(): boolean {
    return this.pendingSwaps > 0;
  }
  /** Number of swaps currently pending or active. */
  pendingSwapCount(): number {
    return this.pendingSwaps;
  }

  /**
   * Acquire a shared lease. If a swap is pending or active, waits until every
   * queued swap has completed — a new lease can never overtake a pending or
   * active swap.
   */
  async acquireLease(): Promise<LifecycleLease> {
    while (this.pendingSwaps > 0) {
      await new Promise<void>((resolve) => this.leaseWaiters.push(resolve));
    }
    this.activeLeases++;
    const leaseEpoch = this.epoch;
    let released = false;
    return {
      get epoch() {
        return leaseEpoch;
      },
      release: () => {
        if (released) return;
        released = true;
        this.activeLeases--;
        if (this.activeLeases === 0 && this.leaseDrainWaiter) {
          const w = this.leaseDrainWaiter;
          this.leaseDrainWaiter = null;
          w();
        }
      },
    };
  }

  /**
   * Run an exclusive swap. `mutate` performs the actual DB replacement and
   * must call `bumpEpoch()` iff it truly swapped the instance. Swaps are
   * strictly serialised. New leases are blocked from the instant this is
   * called (even while queued) until the LAST pending swap finishes. A
   * throwing `mutate` still heals all lifecycle state via `finally` and lets
   * later swaps run.
   */
  async runExclusiveSwap(mutate: () => Promise<void> | void): Promise<void> {
    // Register as pending BEFORE any await — closes the fairness gap where a
    // woken lease could slip in between this swap and the one ahead of it.
    this.pendingSwaps++;
    const prev = this.swapChain;
    let releaseChain!: () => void;
    this.swapChain = new Promise<void>((resolve) => {
      releaseChain = resolve;
    });
    try {
      await prev; // serialise against any other swap
      await this.awaitLeaseDrain();
      await mutate();
    } finally {
      this.pendingSwaps--;
      releaseChain();
      // Only admit parked readers once EVERY queued swap has drained.
      if (this.pendingSwaps === 0) {
        const waiters = this.leaseWaiters.splice(0);
        for (const w of waiters) w();
      }
    }
  }

  /** Bump the lifecycle epoch. Called by a swap's `mutate` at the exact
   *  moment the module-level DB is replaced. */
  bumpEpoch(): void {
    this.epoch++;
  }

  private awaitLeaseDrain(): Promise<void> {
    if (this.activeLeases === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.leaseDrainWaiter = resolve;
    });
  }
}
