// ════════════════════════════════════════════════════════════════════════════
// CROSS-SURFACE INVENTORY — folding phone checks into the run the desktop has open.
// Run: node test/stock/inventory-merge.test.ts
//
// The merge has to satisfy four things that pull against each other:
//
//   • a check made on the phone DURING this run must move the card,
//   • a check from before the run began must not — otherwise every new inventory would open
//     pre-filled with the whole history and the operator would never walk the shelf,
//   • the same observation must not be folded in twice, or a card the operator deliberately took
//     back would keep coming home,
//   • and between two genuinely different observations, the newer one wins.
//
// The awkward cases are the ones with identical timestamps, so those are here explicitly: identity
// decides what has already been applied, never the clock.
// ════════════════════════════════════════════════════════════════════════════

import {
  mergeExternalChecks,
  isDecided,
  itemsNeedingHistory,
  type SessionItem,
  type ExternalCheck,
} from '../../src/core/stock/inventory-session.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  x ${msg}`); }
}
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

const START = '2026-08-15T10:00:00.000Z';
const at = (s: string) => `2026-08-15T${s}.000Z`;

const check = (p: string, status: 'available' | 'not_available', when: string, id = 'chk-' + p + '-' + when, notes: string | null = null): ExternalCheck =>
  ({ check_id: id, product_id: p, status, notes, checked_at: when });
const item = (p: string, status: SessionItem['status'], when: string, notes = '', applied: string | null = null): SessionItem =>
  ({ productId: p, status, notes, updatedAt: when, appliedCheckId: applied });
const statusOf = (r: { items: SessionItem[] }, p: string) => r.items.find(i => i.productId === p)?.status ?? null;
const notesOf = (r: { items: SessionItem[] }, p: string) => r.items.find(i => i.productId === p)?.notes ?? null;

// ── the plain case: the phone walked the shelf, the desktop opens ───────────
{
  const r = mergeExternalChecks([], [
    check('a', 'available', at('11:00')),
    check('b', 'not_available', at('11:05')),
    check('c', 'available', at('11:06'), 'chk-c', 'shelf'),
  ], START);
  eq(statusOf(r, 'a'), 'available', 'an available check lands in Available');
  eq(statusOf(r, 'b'), 'not_available', 'a not-available check lands in Not available');
  eq(notesOf(r, 'c'), 'shelf', 'and the note comes with it');
  eq(r.changed.length, 3, 'all three count as changes to write');
  eq(r.items.filter(i => !isDecided(i.status)).length, 0, 'nothing was parked');
}

// ── an untouched product stays untouched ───────────────────────────────────
{
  const r = mergeExternalChecks([], [check('a', 'available', at('11:00'))], START);
  eq(r.items.length, 1, 'only the product that was actually checked appears');
  eq(statusOf(r, 'unchecked'), null, 'a product nobody checked is not invented into the worksheet');
}

// ── the run boundary: history is not a starting position ───────────────────
{
  const r = mergeExternalChecks([], [
    check('old', 'available', at('09:00')),      // before this run began
    check('new', 'available', at('10:30')),
  ], START);
  eq(statusOf(r, 'old'), null, 'a check from before the run does NOT fill a column');
  eq(statusOf(r, 'new'), 'available', 'a check from inside the run does');
  eq(r.changed, ['new'], 'and only the second one is a change');

  // A check made at the very moment the run started counts as inside it.
  const edge = mergeExternalChecks([], [check('e', 'available', START)], START);
  eq(statusOf(edge, 'e'), 'available', 'a check exactly at the start belongs to the run');
}

// ── an observation is folded in exactly once ───────────────────────────────
{
  const first = mergeExternalChecks([], [check('a', 'available', at('11:00'), 'chk-1')], START);
  eq(first.changed, ['a'], 'the first open folds it in');
  const again = mergeExternalChecks(first.items, [check('a', 'available', at('11:00'), 'chk-1')], START);
  eq(again.changed, [], 'a second open with the same observation changes nothing');
}

// ── the operator takes a card back, and it stays back ──────────────────────
// The parked row is the whole reason `to_check` is stored rather than the row being deleted.
{
  const folded = mergeExternalChecks([], [check('a', 'available', at('11:00'), 'chk-1')], START);
  const parked = folded.items.map(i => i.productId === 'a' ? item('a', 'to_check', at('11:30')) : i);
  const after = mergeExternalChecks(parked, [check('a', 'available', at('11:00'), 'chk-1')], START);
  eq(statusOf(after, 'a'), 'to_check', 'the same old check does not undo the operator taking it back');
  eq(after.changed, [], 'and nothing is written');

  // …but a NEW phone check afterwards does move it again — that is a fresh observation.
  const later = mergeExternalChecks(parked, [check('a', 'not_available', at('12:00'), 'chk-2')], START);
  eq(statusOf(later, 'a'), 'not_available', 'a newer observation moves the card again');
  eq(later.changed, ['a'], 'and counts as a change');
}

// ── latest valid observation wins ──────────────────────────────────────────
{
  const desk = [item('a', 'available', at('11:00'), '', 'chk-desk')];
  const r = mergeExternalChecks(desk, [check('a', 'not_available', at('11:30'), 'chk-phone')], START);
  eq(statusOf(r, 'a'), 'not_available', 'the later phone verdict replaces the desktop one');

  const stale = mergeExternalChecks(
    [item('a', 'available', at('12:00'), '', 'chk-desk2')],
    [check('a', 'not_available', at('11:30'), 'chk-phone')],
    START,
  );
  eq(statusOf(stale, 'a'), 'available', 'an older observation never drags a newer working state back');
  eq(stale.changed, [], 'and writes nothing');
}

// ── identical timestamps are decided by identity, not by luck ──────────────
{
  const same = at('11:00');
  const already = [item('a', 'available', same, '', 'chk-1')];
  const repeat = mergeExternalChecks(already, [check('a', 'available', same, 'chk-1')], START);
  eq(repeat.changed, [], 'the observation already accounted for is skipped even at the same instant');

  const different = mergeExternalChecks(already, [check('a', 'not_available', same, 'chk-2')], START);
  eq(statusOf(different, 'a'), 'not_available', 'a DIFFERENT observation at the same instant is not dropped');
  eq(different.changed, ['a'], 'it counts as a change');
}

// ── notes ──────────────────────────────────────────────────────────────────
{
  const r = mergeExternalChecks(
    [item('a', 'available', at('11:00'), 'desk note', 'chk-1')],
    [check('a', 'available', at('11:30'), 'chk-2', 'phone note')],
    START,
  );
  eq(notesOf(r, 'a'), 'phone note', 'a newer check brings its note across');

  const cleared = mergeExternalChecks(
    [item('a', 'available', at('11:00'), 'desk note', 'chk-1')],
    [check('a', 'available', at('11:30'), 'chk-2', null)],
    START,
  );
  eq(notesOf(cleared, 'a'), '', 'and an observation without a note carries no note, rather than a stale one');
}

// ── a merged-in check is not re-reported as a desktop observation ──────────
// The history is append-only, so writing it again would invent a second sighting that nobody made.
{
  const merged = mergeExternalChecks([], [check('a', 'available', at('11:00'), 'chk-1', 'shelf')], START);
  const draft = merged.items.map(i => ({ productId: i.productId, status: i.status, notes: i.notes }));
  const need = itemsNeedingHistory(draft as SessionItem[], merged.items);
  eq(need, [], 'a Save straight after a fold-in writes no history at all');

  const edited = draft.map(d => ({ ...d, notes: 'corrected' }));
  const need2 = itemsNeedingHistory(edited as SessionItem[], merged.items);
  eq(need2.map(n => n.productId), ['a'], 'but correcting it does write a new observation');
}

// ── a new run starts empty ─────────────────────────────────────────────────
// Everything above happened in the run that started at START. A run started afterwards sees none
// of it, which is what makes "Finish inventory" a real boundary.
{
  const history = [
    check('a', 'available', at('11:00')),
    check('b', 'not_available', at('11:05')),
    check('c', 'available', at('12:00')),
  ];
  const fresh = mergeExternalChecks([], history, at('13:00'));
  eq(fresh.items, [], 'a run started after all of it opens with every card in To check');
  eq(fresh.changed, [], 'and has nothing to write');
}

console.log(`\ninventory-merge: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
