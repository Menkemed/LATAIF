// ════════════════════════════════════════════════════════════════════════════
// MOBILE-I1 — the desktop-side stock-check contract.
// Run: node test/stock/stock-check.test.ts
//
// These are the rules the UI depends on before any round trip happens: what counts as a verdict,
// what a note may be, and which check is "the current one". The Rust core enforces the same rules
// against the database; asserting them here keeps the two from drifting silently apart.
// ════════════════════════════════════════════════════════════════════════════

import {
  isStockCheckStatus,
  prepareNotes,
  sortNewestFirst,
  latestOf,
  stockCheckLabel,
  MAX_STOCK_CHECK_NOTES,
  STOCK_CHECK_STATUSES,
  type StockCheck,
} from '../../src/core/stock/stock-check.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

const check = (over: Partial<StockCheck> = {}): StockCheck => ({
  check_id: 'c-1',
  product_id: 'p-1',
  status: 'available',
  notes: null,
  checked_at: '2026-08-11T10:00:00Z',
  checked_by: 'user-owner',
  checked_by_name: 'Owner',
  source: 'desktop',
  ...over,
});

// ── §29 — only the two verdicts exist ───────────────────────────────────────
{
  eq(STOCK_CHECK_STATUSES, ['available', 'not_available'], '§29 exactly two verdicts are defined');
  ok(isStockCheckStatus('available'), '§29 available is a verdict');
  ok(isStockCheckStatus('not_available'), '§29 not_available is a verdict');
  for (const bad of ['', 'Available', 'AVAILABLE', 'not-available', 'missing', 'gone', '0', null, undefined, 1, {}]) {
    ok(!isStockCheckStatus(bad), `§29 ${JSON.stringify(bad)} is refused as a verdict`);
  }
  eq(stockCheckLabel('available'), 'Available', '§17 available has a label');
  eq(stockCheckLabel('not_available'), 'Not available', '§17 not_available has a label');
}

// ── §21 — notes ─────────────────────────────────────────────────────────────
{
  eq(prepareNotes(''), { ok: true, value: null }, '§21 an empty note is absent, not an empty string');
  eq(prepareNotes('   '), { ok: true, value: null }, '§21 a blank note is absent');
  eq(prepareNotes('  In safe  '), { ok: true, value: 'In safe' }, '§21 notes are trimmed');
  ok(prepareNotes('x'.repeat(MAX_STOCK_CHECK_NOTES)).ok, '§21 a note at the cap is accepted');
  eq(prepareNotes('x'.repeat(MAX_STOCK_CHECK_NOTES + 1)), { ok: false, reason: 'too_long' },
    '§21 a note beyond the cap is refused before the round trip');
  ok(prepareNotes('ä'.repeat(MAX_STOCK_CHECK_NOTES)).ok,
    '§21 the cap counts characters, so a non-ASCII note of legal length is accepted');
  // Escaping belongs to the renderer; mangling here would corrupt a legitimate "a < b".
  const raw = '<script>alert(1)</script> & shelf < 3';
  eq(prepareNotes(raw), { ok: true, value: raw }, '§21 notes are stored verbatim, never pre-escaped');
}

// ── §20/§22 — history, not overwrite ────────────────────────────────────────
{
  const older = check({ check_id: 'c-old', checked_at: '2026-08-11T10:00:00Z', status: 'not_available', notes: 'Could not find' });
  const newer = check({ check_id: 'c-new', checked_at: '2026-08-11T15:00:00Z', status: 'available', notes: 'Found in safe' });

  eq(sortNewestFirst([older, newer]).map(c => c.check_id), ['c-new', 'c-old'], '§22 newest check first');
  eq(latestOf([older, newer])?.status, 'available', '§22 the latest verdict is the newest one');
  eq(sortNewestFirst([older, newer])[1].notes, 'Could not find',
    '§20 the earlier observation survives — a later verdict never erases it');
  ok(latestOf([]) === null, '§26 an item nobody has looked for has no latest check');

  // A same-second tie must be stable, or the "current" verdict would flicker between renders.
  const a = check({ check_id: 'c-a' }), b = check({ check_id: 'c-b' });
  eq(sortNewestFirst([a, b]).map(c => c.check_id), ['c-b', 'c-a'], '§22 a same-timestamp tie is broken stably');
  eq(sortNewestFirst([b, a]).map(c => c.check_id), ['c-b', 'c-a'], '§22 …and independently of input order');

  const list = [check({ check_id: 'c-1', checked_at: '2026-08-11T10:00:00Z' }),
                check({ check_id: 'c-2', checked_at: '2026-08-11T15:00:00Z' })];
  const before = list.map(c => c.check_id);
  sortNewestFirst(list);
  eq(list.map(c => c.check_id), before, '§22 sorting does not mutate the caller list');
}

// ── §24 — one history across both surfaces ──────────────────────────────────
{
  const fromPhone = check({ check_id: 'c-m', source: 'mobile', checked_at: '2026-08-11T10:00:00Z', status: 'not_available' });
  const fromDesk = check({ check_id: 'c-d', source: 'desktop', checked_at: '2026-08-11T13:00:00Z', status: 'available' });
  const sorted = sortNewestFirst([fromPhone, fromDesk]);
  eq(sorted.map(c => c.source), ['desktop', 'mobile'], '§24 mobile and desktop checks share one history');
  eq(latestOf(sorted)?.check_id, 'c-d', '§24 the newest wins regardless of which surface recorded it');
}

console.log(`\nstock-check: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
