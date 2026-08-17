// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B2 — what the owner is told, and when the confirm button may fire.
// Run: npx tsx test/dataroot/move-panel-logic.test.ts
//
// Both are worth pinning. The refusal text because a move is the one action where "invalid path"
// leaves someone stuck — the live install keeps backups at a drive root, so the overlap refusal is
// not a corner case, it is the first thing that will happen to them, and the message has to name the
// way out. The gate because a double click on "Move data and restart" must not be able to start two
// moves; the button's disabled state and the handler's own re-check are the same predicate.
// ════════════════════════════════════════════════════════════════════════════

import { canConfirmMove, explainMoveCode, sanitizeMoveError } from '../../src/pages/settings/data-location-panel-logic.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  x ${msg}`); }
}

// ── the refusal that will actually happen ───────────────────────────────────
const overlap = explainMoveCode('MOVE_TARGET_OVERLAPS_BACKUP_ROOT');
ok(/backup/i.test(overlap), 'the backup-overlap refusal says which two things collide');
ok(/Backups/.test(overlap), 'and names a concrete way out (a separate backups folder)');
ok(!/E:\\\\$/.test(overlap.split('.')[0]), 'without pretending it already changed anything');

// ── every code says what to do, and nothing leaks ───────────────────────────
const CODES = [
  'MOVE_TARGET_IS_SOURCE',
  'MOVE_TARGET_OVERLAPS_SOURCE',
  'MOVE_TARGET_OVERLAPS_APP_FOLDER',
  'MOVE_TARGET_NOT_EMPTY',
  'MOVE_TARGET_HAS_LATAIF_DATA',
  'MOVE_INSUFFICIENT_SPACE',
  'MOVE_FREE_SPACE_UNKNOWN',
  'MOVE_TARGET_NOT_WRITABLE',
  'MOVE_TARGET_UNREACHABLE',
  'MOVE_TARGET_NOT_ABSOLUTE',
  'MOVE_TARGET_NOT_NORMALIZABLE',
  'MOVE_SOURCE_HAS_REPARSE_POINT',
  'MOVE_ALREADY_PENDING',
  'MOVE_OPERATION_PENDING',
  'MOVE_BLOCKED_BY_MAINTENANCE',
];
for (const c of CODES) {
  const msg = explainMoveCode(c);
  ok(msg.length > 20 && !msg.includes(c), `${c} is explained in words, not echoed as a code`);
}
ok(explainMoveCode('SOMETHING_NOBODY_MAPPED').length > 10, 'an unmapped code still produces a sentence');

// A raw error must never reach the DOM verbatim — only the mapped sentence.
ok(
  sanitizeMoveError(new Error('MOVE_TARGET_NOT_EMPTY')) === explainMoveCode('MOVE_TARGET_NOT_EMPTY'),
  'sanitize maps a thrown code to its sentence',
);
ok(
  !sanitizeMoveError(new Error('MOVE_IO: C:\\Users\\someone\\AppData\\lataif.db missing')).includes('C:\\'),
  'and never lets a path through',
);

// ── the confirm gate ────────────────────────────────────────────────────────
const base = { email: 'owner@x.com', password: 'pw', target: 'E:\\LATAIF\\Data', planned: true, busy: false, pending: false };
ok(canConfirmMove(base), 'owner + target + successful preflight → allowed');
ok(!canConfirmMove({ ...base, email: '   ' }), 'no owner email → refused');
ok(!canConfirmMove({ ...base, password: '' }), 'no password → refused');
ok(!canConfirmMove({ ...base, target: null }), 'no target chosen → refused');
ok(!canConfirmMove({ ...base, planned: false }), 'not preflighted → refused (never a blind move)');
ok(!canConfirmMove({ ...base, busy: true }), 'already working → refused (this is the double-click guard)');
ok(!canConfirmMove({ ...base, pending: true }), 'a move is already scheduled → refused');

console.log(`\nmove-panel-logic: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
