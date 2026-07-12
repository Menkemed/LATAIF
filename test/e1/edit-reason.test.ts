// E1 — Invoice edit-reason validation regression tests.
// Tests the pure logic in src/core/invoices/edit-reason.ts (extracted from InvoiceCreate's
// save handler) + models the component's edit-payload assembly to prove NOTES and REASON stay
// separate. No React render, no real DB/store. Run: node test/e1/edit-reason.test.ts

import {
  checkEditReason,
  EDIT_REASON_REQUIRED_MESSAGE,
} from '../../src/core/invoices/edit-reason.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++; else fail.push(msg);
}

// Faithful mirror of InvoiceCreate's edit-branch payload assembly: reason comes from the
// edit-reason check, notes is a SEPARATE field — reason must never be sourced from notes.
function buildEditPayload(editReason: string, notes: string):
  | { ok: false; message: string }
  | { ok: true; reason: string; notes: string | undefined } {
  const c = checkEditReason(true, editReason);
  if (!c.ok) return { ok: false, message: c.message };
  return { ok: true, reason: c.reason, notes: notes || undefined };
}

// ── 1: edit mode requires a reason (empty ⇒ blocked with the exact UI message) ──
// (Render is verified in the browser preview; the logic side: without a reason the save is blocked,
//  which is why a visible, filled reason field is mandatory in edit mode.)
function test1(): void {
  const r = checkEditReason(true, '');
  check(r.ok === false, '1: edit mode blocks when reason empty');
  check(r.ok === false && r.message === EDIT_REASON_REQUIRED_MESSAGE, '1: blocked message is the exact UI string');
  check(EDIT_REASON_REQUIRED_MESSAGE === 'Please enter a reason for this edit.', '1: message equals the reported validation text');
}

// ── 2: create mode never requires an edit reason ──
function test2(): void {
  const empty = checkEditReason(false, '');
  check(empty.ok === true, '2: create mode ok with empty reason');
  check(empty.ok === true && empty.reason === '', '2: create mode yields no reason payload');
  // Even a stray value in create mode is not treated as a required edit reason.
  const stray = checkEditReason(false, 'whatever');
  check(stray.ok === true && stray.reason === '', '2: create mode ignores any reason value');
}

// ── 3: empty reason blocks saving (edit mode) ──
function test3(): void {
  const r = checkEditReason(true, '');
  check(r.ok === false && r.message === EDIT_REASON_REQUIRED_MESSAGE, '3: empty reason blocks save');
}

// ── 4: whitespace-only reason blocks saving (edit mode) ──
function test4(): void {
  for (const ws of ['   ', '\t', '\n', ' \t \n ']) {
    const r = checkEditReason(true, ws);
    check(r.ok === false && r.message === EDIT_REASON_REQUIRED_MESSAGE, `4: whitespace-only "${JSON.stringify(ws)}" blocks save`);
  }
}

// ── 5: a valid reason passes and is handed to the edit payload (trimmed) ──
function test5(): void {
  const r = checkEditReason(true, '  price correction ');
  check(r.ok === true, '5: valid reason passes');
  check(r.ok === true && r.reason === 'price correction', '5: reason is trimmed for the payload');
  const payload = buildEditPayload('  price correction ', '');
  check(payload.ok === true && payload.reason === 'price correction', '5: edit payload carries the trimmed reason');
  // inner whitespace preserved
  const inner = checkEditReason(true, '  wrong  tax   scheme ');
  check(inner.ok === true && inner.reason === 'wrong  tax   scheme', '5: inner whitespace preserved, only ends trimmed');
}

// ── 6: notes are NOT used as the edit reason (separate fields) ──
function test6(): void {
  const payload = buildEditPayload('price correction', 'gift wrap, deliver Monday');
  check(payload.ok === true && payload.reason === 'price correction', '6: reason comes from the reason field');
  check(payload.ok === true && payload.notes === 'gift wrap, deliver Monday', '6: notes preserved separately');
  check(payload.ok === true && payload.reason !== payload.notes, '6: reason and notes are distinct');
  // notes filled but reason empty ⇒ still blocked (notes cannot satisfy the reason requirement)
  const blocked = buildEditPayload('   ', 'a perfectly good note');
  check(blocked.ok === false, '6: a filled notes field does not satisfy the edit-reason requirement');
}

// ── 7: determinism — same input yields the same result (no hidden state) ──
function test7(): void {
  const a = checkEditReason(true, 'reason x');
  const b = checkEditReason(true, 'reason x');
  check(a.ok === true && b.ok === true && a.reason === b.reason, '7: deterministic for equal input');
}

function main(): void {
  test1(); test2(); test3(); test4(); test5(); test6(); test7();
  const total = pass + fail.length;
  console.log(`\nE1 edit-reason: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all E1 edit-reason checks green');
}
main();
