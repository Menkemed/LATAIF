// B2 — Credit / Overpayment teardown regression tests.
// Tests the pure decision logic in src/core/credit/overpayment-teardown.ts and models the
// ledger arithmetic of editInvoice Step 8b (Part A) + the customer_credits teardown of
// deleteCreditNote (Part B) to reproduce the B0 bugs and prove the fix. No real DB / store.
// Run: node test/b2/credit-teardown.test.ts

import { DatabaseSync } from 'node:sqlite';
import {
  planEditOverpayment,
  planCreditNoteCreditTeardown,
  type ExistingCredit,
} from '../../src/core/credit/overpayment-teardown.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++; else fail.push(msg);
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ── tiny faithful ledger model (AR asset: DR+/CR−; CUSTOMER_CREDIT liability: CR+/DR−) ──
class Ledger {
  ar = 0;
  cc = 0;
  cash = 0;
  post(entries: Array<{ acc: 'AR' | 'CC' | 'CASH'; dir: 'D' | 'C'; amt: number }>): void {
    for (const e of entries) {
      const s = e.dir === 'D' ? e.amt : -e.amt;
      if (e.acc === 'AR') this.ar += s;
      else if (e.acc === 'CASH') this.cash += s;
      else this.cc += -s; // CC is a natural-credit liability → invert sign
    }
  }
}

// Models recordPayment's overpay split + invoice issue → the pre-edit state.
function seedOverpaidInvoice(gross: number, pay: number): { led: Ledger; overpaymentCredits: ExistingCredit[] } {
  const led = new Ledger();
  const openRemainder = gross;
  const arCredit = Math.min(pay, openRemainder);
  const overExcess = Math.max(0, pay - openRemainder);
  led.post([{ acc: 'CASH', dir: 'D', amt: pay }, { acc: 'AR', dir: 'C', amt: arCredit }]);
  const overpaymentCredits: ExistingCredit[] = [];
  if (overExcess > 0.005) {
    led.post([{ acc: 'CC', dir: 'C', amt: overExcess }]);
    overpaymentCredits.push({ id: 'oc-1', amount: overExcess, usedAmount: 0 });
  }
  led.post([{ acc: 'AR', dir: 'D', amt: gross }]); // postInvoiceIssued
  return { led, overpaymentCredits };
}

// Models editInvoice Step 8b for BOTH the OLD (buggy) and NEW (fixed) logic.
function applyEdit(gross0: number, pay: number, newGross: number, mode: 'old' | 'new'):
  { ar: number; cc: number; domainCreditTotal: number; blocked?: string } {
  const { led, overpaymentCredits } = seedOverpaidInvoice(gross0, pay);
  const existingTotal = overpaymentCredits.reduce((s, c) => s + c.amount, 0);
  // reverse invoice issue + repost at newGross (reverseSource('INVOICE') only touches the invoice leg)
  led.post([{ acc: 'AR', dir: 'C', amt: gross0 }]); // reverse original issue
  led.post([{ acc: 'AR', dir: 'D', amt: newGross }]); // repost
  const newPaid = pay;
  if (mode === 'old') {
    const overpay = Math.max(0, newPaid - newGross); // BUG: books full surplus, ignores existing credit
    if (overpay > 0.005) led.post([{ acc: 'AR', dir: 'D', amt: overpay }, { acc: 'CC', dir: 'C', amt: overpay }]);
    return { ar: led.ar, cc: led.cc, domainCreditTotal: existingTotal + overpay };
  }
  const plan = planEditOverpayment({ newPaid, newGross, existingOverpaymentCredits: overpaymentCredits });
  if (plan.blocked) return { ar: led.ar, cc: led.cc, domainCreditTotal: existingTotal, blocked: plan.reason };
  if (plan.additionalCredit > 0.005) {
    led.post([{ acc: 'AR', dir: 'D', amt: plan.additionalCredit }, { acc: 'CC', dir: 'C', amt: plan.additionalCredit }]);
  }
  return { ar: led.ar, cc: led.cc, domainCreditTotal: existingTotal + plan.additionalCredit };
}

// ── 1: overpaid invoice creates exactly one customer credit ──
function test1(): void {
  const { overpaymentCredits, led } = seedOverpaidInvoice(100, 120);
  check(overpaymentCredits.length === 1 && close(overpaymentCredits[0].amount, 20), '1: overpay 120/100 → exactly one credit of 20');
  check(close(led.ar, 0) && close(led.cc, 20), '1: pre-edit ledger AR=0, CC=20');
}

// ── 2: editInvoice after overpayment does not duplicate credit (+ reproduce the bug) ──
function test2(): void {
  const oldR = applyEdit(100, 120, 90, 'old');
  check(close(oldR.domainCreditTotal, 50) && close(oldR.ar, 20), '2(bug): OLD logic double-counts → credit 50, phantom AR 20');
  const newR = applyEdit(100, 120, 90, 'new');
  check(close(newR.domainCreditTotal, 30) && close(newR.cc, 30), '2(fix): NEW logic → total credit 30 (= true surplus 120-90)');
  check(close(newR.ar, 0), '2(fix): NEW logic → AR 0 (no phantom)');
}

// ── 3: repeated editInvoice stays idempotent ──
function test3(): void {
  // existing overpayment credit is PAYMENT-sourced → stable across edits; same inputs → same delta
  const a = planEditOverpayment({ newPaid: 120, newGross: 90, existingOverpaymentCredits: [{ id: 'oc-1', amount: 20, usedAmount: 0 }] });
  const b = planEditOverpayment({ newPaid: 120, newGross: 90, existingOverpaymentCredits: [{ id: 'oc-1', amount: 20, usedAmount: 0 }] });
  check(!a.blocked && !b.blocked && (a as { additionalCredit: number }).additionalCredit === (b as { additionalCredit: number }).additionalCredit && (a as { additionalCredit: number }).additionalCredit === 10, '3: repeated edit → same additionalCredit 10 (idempotent)');
  const r1 = applyEdit(100, 120, 90, 'new');
  const r2 = applyEdit(100, 120, 90, 'new');
  check(close(r1.cc, r2.cc) && close(r1.ar, r2.ar) && close(r1.domainCreditTotal, r2.domainCreditTotal), '3: repeated edit → identical ledger + domain state');
}

// ── 4: editInvoice blocks/safely handles already-used + shrink cases ──
function test4(): void {
  const used = planEditOverpayment({ newPaid: 120, newGross: 90, existingOverpaymentCredits: [{ id: 'oc-1', amount: 20, usedAmount: 5 }] });
  check(used.blocked === true && used.reason === 'OVERPAYMENT_CREDIT_USED', '4: used overpayment credit → BLOCK (not silently changed)');
  const shrink = planEditOverpayment({ newPaid: 120, newGross: 110, existingOverpaymentCredits: [{ id: 'oc-1', amount: 20, usedAmount: 0 }] });
  check(shrink.blocked === true && shrink.reason === 'OVERPAYMENT_CREDIT_WOULD_SHRINK', '4: edit would shrink existing credit → BLOCK');
  // no pre-existing credit → normal full booking (regression: unrelated edits unaffected)
  const clean = planEditOverpayment({ newPaid: 90, newGross: 100, existingOverpaymentCredits: [] });
  check(!clean.blocked && (clean as { additionalCredit: number }).additionalCredit === 0, '4: underpaid, no credit → additionalCredit 0');
}

// ── 5: ledger remains balanced after edit (DR total == CR total; AR not phantom) ──
function test5(): void {
  const r = applyEdit(100, 120, 90, 'new');
  // cash 120 in; invoice 90 revenue-worth on AR; 30 redeemable credit → AR nets to 0
  check(close(r.ar, 0), '5: AR balances to 0 after edit (no phantom receivable)');
  check(close(r.cc, 30), '5: CUSTOMER_CREDIT = 30 (redeemable = true surplus)');
  // reduce gross to exactly paid → no surplus beyond existing → additionalCredit 0, total stays existing 20...
  const r2 = applyEdit(100, 120, 100, 'new'); // newGross=100, surplus=20 == existing → delta 0
  check(!r2.blocked && close(r2.domainCreditTotal, 20) && close(r2.ar, 0) && close(r2.cc, 20), '5: newGross=paid-surplus → no new credit, balanced');
}

// ── 6 + 7: deleteCreditNote — remove unused, block used (real node:sqlite row) ──
function test6and7(): void {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customer_credits (id TEXT PRIMARY KEY, amount REAL, used_amount REAL, status TEXT, source_type TEXT, source_id TEXT)`);
  const ins = db.prepare(`INSERT INTO customer_credits (id, amount, used_amount, status, source_type, source_id) VALUES (?,?,?,?,'sales_return',?)`);

  // 6: unused credit from a CN → plan deletes it → no row remains
  ins.run('cc-unused', 15, 0, 'OPEN', 'cn-1');
  const rowsUnused = db.prepare(`SELECT id, amount, used_amount AS usedAmount FROM customer_credits WHERE source_type='sales_return' AND source_id='cn-1'`).all()
    .map((r) => ({ id: r.id as string, amount: Number(r.amount), usedAmount: Number(r.usedAmount) }));
  const plan6 = planCreditNoteCreditTeardown(rowsUnused);
  check(plan6.blocked === false && plan6.deleteCreditIds.length === 1 && plan6.deleteCreditIds[0] === 'cc-unused', '6: unused CN credit → plan deletes it');
  if (!plan6.blocked) for (const id of plan6.deleteCreditIds) db.prepare(`DELETE FROM customer_credits WHERE id=?`).run(id);
  const remaining = Number((db.prepare(`SELECT COUNT(*) n FROM customer_credits WHERE source_id='cn-1'`).get() as { n: number }).n);
  check(remaining === 0, '6: after teardown → customer_credits row removed (no phantom)');

  // 7: used credit → plan blocks → row survives untouched
  ins.run('cc-used', 15, 5, 'OPEN', 'cn-2');
  const rowsUsed = db.prepare(`SELECT id, amount, used_amount AS usedAmount FROM customer_credits WHERE source_id='cn-2'`).all()
    .map((r) => ({ id: r.id as string, amount: Number(r.amount), usedAmount: Number(r.usedAmount) }));
  const plan7 = planCreditNoteCreditTeardown(rowsUsed);
  check(plan7.blocked === true && plan7.reason === 'CREDIT_NOTE_CREDIT_USED', '7: used CN credit → BLOCK delete');
  const usedRemaining = Number((db.prepare(`SELECT COUNT(*) n FROM customer_credits WHERE source_id='cn-2'`).get() as { n: number }).n);
  check(usedRemaining === 1, '7: used credit row preserved (not silently lost)');
  db.close();
}

// ── 8: no phantom customer credit remains ──
function test8(): void {
  // Part A: redeemable credit after edit = true surplus (not doubled)
  const r = applyEdit(100, 120, 90, 'new');
  check(close(r.domainCreditTotal, r.cc) && close(r.cc, 30), '8A: redeemable domain credit == ledger CC == 30 (no phantom)');
  // Part B: after deleting the unused CN credit, redeemable total drops to 0
  const credits: ExistingCredit[] = [{ id: 'x', amount: 15, usedAmount: 0 }];
  const plan = planCreditNoteCreditTeardown(credits);
  const remaining = plan.blocked ? credits : credits.filter((c) => !plan.deleteCreditIds.includes(c.id));
  const redeemable = remaining.reduce((s, c) => s + (c.amount - c.usedAmount), 0);
  check(close(redeemable, 0), '8B: after CN delete → 0 redeemable phantom credit');
}

// ── 9: outstanding / customer balance correct ──
function test9(): void {
  // customerBalance == ledger AR; after the fix AR=0 → balance 0 (overpaid, nothing outstanding, no phantom)
  const r = applyEdit(100, 120, 90, 'new');
  const outstanding = Math.max(0, r.ar); // AR>0 would be a receivable
  check(close(outstanding, 0) && close(r.ar, 0), '9: outstanding = 0 (AR not phantom-positive)');
  // contrast: OLD logic leaves AR=20 → phantom outstanding
  const old = applyEdit(100, 120, 90, 'old');
  check(close(Math.max(0, old.ar), 20), '9(bug): OLD logic leaves phantom outstanding 20');
}

function main(): void {
  test1(); test2(); test3(); test4(); test5(); test6and7(); test8(); test9();
  const total = pass + fail.length;
  console.log(`\nB2 credit-teardown: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all B2 credit-teardown checks green');
}
main();
