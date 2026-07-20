// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-2B2-R4 — DbLifecycleController behavioural tests
// Run: node test/dblifecycle/db-lifecycle.test.ts
//
// Pure, dependency-free — exercises the real reader/writer swap gate that
// database.ts wires reload/reset/lease through. Uses deterministic barriers
// (resolvable promises), never wall-clock timing.
// ════════════════════════════════════════════════════════════════════════════

import { DbLifecycleController, DbLeaseInvalidatedError } from '../../src/core/db/db-lifecycle.ts';

let PASS = 0;
let FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) {
    PASS++;
  } else {
    FAIL++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

/** A manually-resolvable barrier for deterministic interleaving. */
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, open: resolve };
}

/** Yield to the microtask queue so parked promises make progress. */
async function tick(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

async function main(): Promise<void> {
  // ── §1 basic lease acquire/release + epoch stability ──────────────────
  {
    const c = new DbLifecycleController();
    ok(c.activeLeaseCount() === 0, 'starts with no leases');
    ok(c.currentEpoch() === 0, 'starts at epoch 0');
    const l = await c.acquireLease();
    ok(c.activeLeaseCount() === 1, 'lease increments count');
    ok(l.epoch === 0, 'lease carries epoch 0');
    l.release();
    ok(c.activeLeaseCount() === 0, 'release decrements count');
    l.release(); // idempotent
    ok(c.activeLeaseCount() === 0, 'double release is a no-op');
  }

  // ── §2 active lease → swap waits until release ────────────────────────
  {
    const c = new DbLifecycleController();
    const l = await c.acquireLease();
    let swapRan = false;
    const swap = c.runExclusiveSwap(async () => { swapRan = true; c.bumpEpoch(); });
    await tick();
    ok(!swapRan, 'swap waits while a lease is held');
    ok(c.isSwapInProgress(), 'swap is marked in-progress while waiting for drain');
    l.release();
    await swap;
    ok(swapRan, 'swap runs after the lease releases');
    ok(c.currentEpoch() === 1, 'epoch bumped by the swap');
    ok(!c.isSwapInProgress(), 'swap no longer in progress after completion');
  }

  // ── §3 new lease cannot overtake an in-flight swap ───────────────────
  {
    const c = new DbLifecycleController();
    const l0 = await c.acquireLease(); // hold a lease so the swap parks on drain
    const swapBody = barrier();
    let swapDone = false;
    const swap = c.runExclusiveSwap(async () => {
      await swapBody.promise;
      c.bumpEpoch();
      swapDone = true;
    });
    await tick();
    // Now release l0 so the swap enters its body (but it's blocked on swapBody).
    l0.release();
    await tick();
    ok(c.isSwapInProgress() && !swapDone, 'swap is in its body, not yet done');
    // A lease requested now must NOT resolve until the swap completes.
    let leaseGranted = false;
    const leaseP = c.acquireLease().then((l) => { leaseGranted = true; return l; });
    await tick();
    ok(!leaseGranted, 'new lease cannot overtake the running swap');
    // Finish the swap → the parked lease is granted, at the new epoch.
    swapBody.open();
    await swap;
    const lease = await leaseP;
    ok(leaseGranted, 'parked lease granted after swap completes');
    ok(lease.epoch === c.currentEpoch(), `parked lease sees the new epoch (${lease.epoch})`);
    ok(lease.epoch === 1, 'new epoch is 1');
    lease.release();
  }

  // ── §4 anti-starvation: a stream of lease requests cannot starve a swap
  {
    const c = new DbLifecycleController();
    const l0 = await c.acquireLease();
    let swapRan = false;
    const swap = c.runExclusiveSwap(async () => { swapRan = true; c.bumpEpoch(); });
    await tick();
    // While the swap waits for l0 to drain, keep asking for new leases.
    const parked: Array<Promise<{ release(): void }>> = [];
    for (let i = 0; i < 10; i++) parked.push(c.acquireLease());
    await tick();
    ok(!swapRan, 'swap still waiting; new leases are parked, not granted');
    // Drain the single active lease → swap runs to completion first.
    l0.release();
    await swap;
    ok(swapRan, 'swap completed despite a stream of pending lease requests');
    // Now the parked leases resolve — all at the post-swap epoch.
    const leases = await Promise.all(parked);
    ok(leases.every((l) => c.activeLeaseCount() > 0), 'parked leases granted after swap');
    for (const l of leases) l.release();
    ok(c.activeLeaseCount() === 0, 'all parked leases released');
  }

  // ── §5 two swaps are strictly serialised ─────────────────────────────
  {
    const c = new DbLifecycleController();
    const order: string[] = [];
    const b1 = barrier();
    const b2 = barrier();
    const s1 = c.runExclusiveSwap(async () => { order.push('s1-start'); await b1.promise; c.bumpEpoch(); order.push('s1-end'); });
    const s2 = c.runExclusiveSwap(async () => { order.push('s2-start'); await b2.promise; c.bumpEpoch(); order.push('s2-end'); });
    await tick();
    ok(order.join(',') === 's1-start', 's2 does not start until s1 finishes');
    b1.open();
    await tick();
    ok(order.includes('s1-end') && order.includes('s2-start'), 's2 starts only after s1 ends');
    ok(!order.includes('s2-end'), 's2 still running');
    b2.open();
    await Promise.all([s1, s2]);
    ok(order.join(',') === 's1-start,s1-end,s2-start,s2-end', 'strict swap serialisation');
    ok(c.currentEpoch() === 2, 'both swaps bumped epoch → 2');
  }

  // ── §6 swap failure cleans up lifecycle state ────────────────────────
  {
    const c = new DbLifecycleController();
    let threw = false;
    try {
      await c.runExclusiveSwap(async () => { throw new Error('SWAP_BOOM'); });
    } catch (e) {
      threw = (e as Error).message === 'SWAP_BOOM';
    }
    ok(threw, 'swap error propagates');
    ok(!c.isSwapInProgress(), 'swap-in-progress cleared after a failed swap');
    ok(c.currentEpoch() === 0, 'failed swap did not bump epoch');
    // Subsequent lease + swap still work.
    const l = await c.acquireLease();
    ok(c.activeLeaseCount() === 1, 'lease works after a failed swap');
    l.release();
    await c.runExclusiveSwap(async () => { c.bumpEpoch(); });
    ok(c.currentEpoch() === 1, 'later swap works after a failed swap');
  }

  // ── §7 no-op swap (mutate does not bump) leaves epoch unchanged ──────
  {
    const c = new DbLifecycleController();
    await c.runExclusiveSwap(async () => { /* e.g. reload found no file */ });
    ok(c.currentEpoch() === 0, 'a swap whose mutate does not bumpEpoch leaves epoch unchanged');
  }

  // ── §8 concurrent leases + swap ordering end-to-end ──────────────────
  {
    const c = new DbLifecycleController();
    const la = await c.acquireLease();
    const lb = await c.acquireLease();
    ok(c.activeLeaseCount() === 2, 'two concurrent leases');
    let swapRan = false;
    const swap = c.runExclusiveSwap(async () => { swapRan = true; c.bumpEpoch(); });
    await tick();
    ok(!swapRan, 'swap waits for BOTH leases');
    la.release();
    await tick();
    ok(!swapRan, 'swap still waits while one lease remains');
    lb.release();
    await swap;
    ok(swapRan, 'swap runs only after every lease drained');
    ok(c.currentEpoch() === 1, 'epoch bumped once');
  }

  // ── §9 DbLeaseInvalidatedError contract ──────────────────────────────
  {
    const e = new DbLeaseInvalidatedError();
    ok(e.name === 'DbLeaseInvalidatedError', 'error carries the expected name');
    ok(e.message === 'DB_LEASE_INVALIDATED', 'error carries the default code message');
    const e2 = new DbLeaseInvalidatedError('custom');
    ok(e2.message === 'custom', 'custom message respected');
  }

  // ── §10 save-race — save on DB A held at a barrier, reload to DB B waits
  //
  // Models the exact §4 scenario: a media op holds a lease and is mid-durable-
  // save on DB A (barriered); a reload to DB B is requested and must wait; the
  // save persists DB A; the lease releases; the reload swaps to DB B; the next
  // op's lease sees DB B.
  {
    const c = new DbLifecycleController();
    // The module-level "db pointer" the swap replaces.
    const dbPointer = { current: 'A' };
    const persisted: string[] = [];

    // Operation 1: takes a lease, then durably-saves DB A (held at a barrier).
    const saveBarrier = barrier();
    const op1Lease = await c.acquireLease();
    const op1DbAtLease = dbPointer.current; // pinned "A"
    const op1 = (async () => {
      await saveBarrier.promise;            // save is in flight, blocking
      // Guard: the pinned db must not have drifted while the lease is live.
      ok(dbPointer.current === op1DbAtLease, 'save snapshots the leased DB (A)');
      persisted.push(dbPointer.current);    // persist "A"
      op1Lease.release();
    })();

    // Reload to DB B is requested WHILE op1 holds its lease.
    const reload = c.runExclusiveSwap(async () => {
      dbPointer.current = 'B';              // the actual swap
      c.bumpEpoch();
    });
    await tick();
    ok(dbPointer.current === 'A', 'reload waits — DB still A while the save lease is held');

    // Let the save complete → lease releases → reload proceeds.
    saveBarrier.open();
    await op1;
    await reload;
    ok(dbPointer.current === 'B', 'reload swapped to DB B after the save+lease finished');
    ok(persisted.length === 1 && persisted[0] === 'A', 'exactly DB A was persisted, never B');

    // The next op's lease sees DB B at the new epoch.
    const op2Lease = await c.acquireLease();
    ok(dbPointer.current === 'B' && op2Lease.epoch === c.currentEpoch(),
      `next op leases DB B at epoch ${op2Lease.epoch}`);
    op2Lease.release();
  }

  // ── §11 R5 — two queued swaps + lease stream: strict order, no overtake
  //
  // An active lease holds the controller. Swap A and Swap B are queued. Then
  // a stream of lease requests arrives. When the active lease releases, the
  // swaps must run A→B, and only AFTER both swaps do the parked leases get
  // admitted. No lease may slip between A and B; epoch must bump exactly twice.
  {
    const c = new DbLifecycleController();
    const order: string[] = [];
    const held = await c.acquireLease(); // holds the controller
    const bA = barrier();
    const bB = barrier();
    const swapA = c.runExclusiveSwap(async () => { order.push('A-start'); await bA.promise; c.bumpEpoch(); order.push('A-end'); });
    const swapB = c.runExclusiveSwap(async () => { order.push('B-start'); await bB.promise; c.bumpEpoch(); order.push('B-end'); });
    await tick();
    ok(c.pendingSwapCount() === 2, `both swaps pending (got ${c.pendingSwapCount()})`);
    // A stream of lease requests arrives while swaps are queued.
    const parkedLeases: Array<Promise<{ epoch: number; release(): void }>> = [];
    let anyLeaseGranted = false;
    for (let i = 0; i < 8; i++) {
      parkedLeases.push(c.acquireLease().then((l) => { order.push(`lease-${i}`); anyLeaseGranted = true; return l; }));
    }
    await tick();
    ok(!anyLeaseGranted, 'no lease granted while swaps are pending');
    ok(order.length === 0, 'nothing ran yet — swaps still blocked on the active lease');

    // Release the active lease → Swap A enters its body.
    held.release();
    await tick();
    ok(order.join(',') === 'A-start', 'only Swap A started after lease release');
    ok(!anyLeaseGranted, 'still no lease between release and Swap A');

    // Finish A → B enters (A→B, no lease between).
    bA.open();
    await tick();
    ok(order.includes('A-end') && order.includes('B-start'), 'Swap B starts right after Swap A');
    ok(!order.some((o) => o.startsWith('lease-')), 'NO lease admitted between Swap A and Swap B');
    ok(!anyLeaseGranted, 'still no lease before Swap B finishes');

    // Finish B → now the parked leases are admitted, at epoch 2.
    bB.open();
    await Promise.all([swapA, swapB]);
    const leases = await Promise.all(parkedLeases);
    ok(anyLeaseGranted, 'parked leases admitted after both swaps');
    ok(c.currentEpoch() === 2, `epoch bumped exactly twice (got ${c.currentEpoch()})`);
    ok(leases.every((l) => l.epoch === 2), 'every parked lease sees the post-swaps epoch (2)');
    // Strict order: everything swap-related precedes every lease.
    const firstLeaseIdx = order.findIndex((o) => o.startsWith('lease-'));
    const lastSwapIdx = Math.max(order.indexOf('A-end'), order.indexOf('B-end'));
    ok(firstLeaseIdx > lastSwapIdx, `all swaps precede all leases (firstLease=${firstLeaseIdx}, lastSwap=${lastSwapIdx})`);
    for (const l of leases) l.release();
    ok(c.pendingSwapCount() === 0 && c.activeLeaseCount() === 0, 'clean final state');
  }

  // ── §12 R5 — Swap A fails, Swap B still runs; no pending-counter leak ──
  {
    const c = new DbLifecycleController();
    const order: string[] = [];
    const bB = barrier();
    const swapA = c.runExclusiveSwap(async () => { order.push('A'); throw new Error('A_BOOM'); });
    const swapB = c.runExclusiveSwap(async () => { order.push('B-start'); await bB.promise; c.bumpEpoch(); order.push('B-end'); });
    await tick();
    // A already threw; B is queued. pendingSwaps must be 1 now (A gone, B alive).
    let aThrew = false;
    await swapA.catch((e) => { aThrew = (e as Error).message === 'A_BOOM'; });
    ok(aThrew, 'Swap A error propagates');
    await tick();
    ok(order.includes('B-start'), 'Swap B runs after Swap A failed');
    ok(c.pendingSwapCount() === 1, `pending counter accounts for exactly Swap B (got ${c.pendingSwapCount()})`);
    // Lease requested while B runs must wait.
    let leaseGranted = false;
    const leaseP = c.acquireLease().then((l) => { leaseGranted = true; return l; });
    await tick();
    ok(!leaseGranted, 'lease waits while Swap B (post-A-failure) is active');
    bB.open();
    await swapB;
    const lease = await leaseP;
    ok(leaseGranted, 'lease admitted after Swap B completes');
    ok(c.pendingSwapCount() === 0, 'no pending-swap counter leak after a failed + a good swap');
    ok(c.currentEpoch() === 1, 'only the successful swap bumped epoch');
    lease.release();
  }

  // ── §13 R5 — three queued swaps drain fully before any lease ──────────
  {
    const c = new DbLifecycleController();
    const held = await c.acquireLease();
    const order: string[] = [];
    const swaps = [0, 1, 2].map((i) =>
      c.runExclusiveSwap(async () => { order.push(`s${i}`); c.bumpEpoch(); }),
    );
    let leaseGranted = false;
    const leaseP = c.acquireLease().then((l) => { order.push('lease'); leaseGranted = true; return l; });
    await tick();
    ok(!leaseGranted && c.pendingSwapCount() === 3, 'three swaps pending, lease parked');
    held.release();
    await Promise.all(swaps);
    const lease = await leaseP;
    ok(order.join(',') === 's0,s1,s2,lease', `strict drain order (got ${order.join(',')})`);
    ok(c.currentEpoch() === 3, 'epoch bumped three times');
    ok(leaseGranted, 'lease admitted only after all three swaps');
    lease.release();
  }

  console.log(`\nMEDIA-04A-2B2 db-lifecycle: ${PASS}/${PASS + FAIL} checks passed`);
  if (FAIL > 0) {
    console.log('\nFAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
