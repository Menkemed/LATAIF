// MEDIA-CONSUMERS-DASH-I1 — bounded pending-retry contract for the shared thumbnail path.
// Drives the REAL pure helpers from src/core/media/collection-thumb.ts:
//   • planPendingRetry — bounded, capped-backoff retry plan consulted only while `pending`
//   • decideCollectionThumb — legacy fast-path, media→image, pending→skeleton,
//     pending-EXHAUSTED→placeholder, none/error/no-scope→placeholder (never endless skeleton)
// No React, no DB, no timers — the component owns those; here we prove the decision contract.
// Run: node test/media-thumb/pending-retry.test.ts
import {
  planPendingRetry,
  decideCollectionThumb,
  THUMB_PENDING_MAX_ATTEMPTS,
  THUMB_PENDING_BACKOFF_BASE_MS,
  THUMB_PENDING_BACKOFF_CAP_MS,
} from '../../src/core/media/collection-thumb.ts';
import type { PresentationState } from '../../src/core/media/presentation.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

// ── planPendingRetry ────────────────────────────────────────────────────────
const p0 = planPendingRetry(0);
check(p0.retry && !p0.exhausted, 'attempt 0 retries');
check(p0.delayMs === THUMB_PENDING_BACKOFF_BASE_MS, 'attempt 0 delay = base');
check(planPendingRetry(1).delayMs === THUMB_PENDING_BACKOFF_BASE_MS * 2, 'attempt 1 delay = base*2');
check(planPendingRetry(2).delayMs === THUMB_PENDING_BACKOFF_BASE_MS * 4, 'attempt 2 delay = base*4');
// monotonic non-decreasing, always capped
let prev = 0;
for (let a = 0; a < THUMB_PENDING_MAX_ATTEMPTS; a++) {
  const pl = planPendingRetry(a);
  check(pl.retry && !pl.exhausted, `attempt ${a} < MAX retries`);
  check(pl.delayMs >= prev, `attempt ${a} backoff non-decreasing`);
  check(pl.delayMs <= THUMB_PENDING_BACKOFF_CAP_MS, `attempt ${a} delay <= cap`);
  prev = pl.delayMs;
}
check(planPendingRetry(THUMB_PENDING_MAX_ATTEMPTS - 1).delayMs === THUMB_PENDING_BACKOFF_CAP_MS, 'last retry hits the cap');
// budget exhaustion is terminal
const pMax = planPendingRetry(THUMB_PENDING_MAX_ATTEMPTS);
check(!pMax.retry && pMax.exhausted, 'attempt == MAX → exhausted, no retry');
check(planPendingRetry(THUMB_PENDING_MAX_ATTEMPTS + 5).exhausted, 'attempt > MAX → still exhausted');

// ── decideCollectionThumb ─────────────────────────────────────────────────────
const idle: PresentationState = { status: 'idle', srcs: [] };
const loading: PresentationState = { status: 'loading', srcs: [] };
const pending: PresentationState = { status: 'pending', srcs: [] };
const media: PresentationState = { status: 'media', srcs: ['blob:x'], items: [] as never };
const empty: PresentationState = { status: 'empty', srcs: [] };
const error: PresentationState = { status: 'error', code: 'integrity_error', srcs: [] };

// legacy fast-path wins regardless of state
check(decideCollectionThumb({ legacyFirst: 'data:img', state: idle, hasAuthKey: true }).kind === 'image', 'legacy fast-path → image');
const legImg = decideCollectionThumb({ legacyFirst: 'data:LEG', state: pending, hasAuthKey: true });
check(legImg.kind === 'image' && legImg.src === 'data:LEG', 'legacy fast-path uses legacy src even over pending');
// media → image with resolved blob
const medImg = decideCollectionThumb({ legacyFirst: undefined, state: media, hasAuthKey: true });
check(medImg.kind === 'image' && medImg.src === 'blob:x', 'media → resolved blob image');
// pending, budget NOT spent → skeleton (retry still in flight)
check(decideCollectionThumb({ legacyFirst: undefined, state: pending, hasAuthKey: true }).kind === 'skeleton', 'pending (not exhausted) → skeleton');
check(decideCollectionThumb({ legacyFirst: undefined, state: loading, hasAuthKey: true }).kind === 'skeleton', 'loading → skeleton');
check(decideCollectionThumb({ legacyFirst: undefined, state: idle, hasAuthKey: true }).kind === 'skeleton', 'idle+auth → skeleton');
// pending, budget SPENT → placeholder (never endless skeleton)
check(decideCollectionThumb({ legacyFirst: undefined, state: pending, hasAuthKey: true, pendingExhausted: true }).kind === 'placeholder', 'pending EXHAUSTED → placeholder');
// terminal non-media states → placeholder, and they must NOT be skeleton
check(decideCollectionThumb({ legacyFirst: undefined, state: empty, hasAuthKey: true }).kind === 'placeholder', 'none/empty → placeholder');
check(decideCollectionThumb({ legacyFirst: undefined, state: error, hasAuthKey: true }).kind === 'placeholder', 'error → placeholder (no retry, no skeleton)');
// no authorised scope → placeholder, never skeleton (no cross-scope resolve)
check(decideCollectionThumb({ legacyFirst: undefined, state: pending, hasAuthKey: false }).kind === 'placeholder', 'pending + no scope → placeholder');
check(decideCollectionThumb({ legacyFirst: undefined, state: idle, hasAuthKey: false }).kind === 'placeholder', 'idle + no scope → placeholder');

if (fail.length) { console.error('DASH-I1 pending-retry: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`DASH-I1 pending-retry: ${pass}/${pass} checks passed`);
