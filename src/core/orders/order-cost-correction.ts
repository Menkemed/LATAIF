// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER — Kostenzeile einer Order ändern oder löschen, auch wenn ihre Lieferantenschuld schon (teil-)bezahlt ist.
//
// Owner-Entscheidung (ersetzt die Sperre ORDER_COST_PAID):
//   1. nichts bezahlt     — Betrag ändern/löschen, die offene Lieferantenschuld folgt. Kein Dialog.
//   2. teilweise bezahlt  — die offene Schuld folgt; nur wenn eine echte Überzahlung entsteht, wählt der Mensch:
//   3. Guthaben           — Differenz als verrechenbares Lieferantenguthaben (supplier_credits OPEN);
//   4. Rückforderung      — Differenz als offene Forderung an den Lieferanten (supplier_credits REFUND_DUE).
//   Beispiel Lohn 25 → 20: 0 bezahlt → Schuld 20; 10 bezahlt → Rest 10; 25 bezahlt → 5 Guthaben oder 5 Rückforderung.
//   Dasselbe beim Löschen der Zeile (neuer Betrag 0).
//
// Wiederverwendet: „Edit Expense" (updateExpenseInHouse — Gegen-/Neubuchung der Schuld am Ausgabetag), die Überzahlungs-
// Reklassierung wie beim Einkauf (DR SUPPLIER_CREDIT / CR ACCOUNTS_PAYABLE), „Record Repayment" für die Rückforderung.
// Die Originalzahlungen (expense_payments + EXPENSE_PAYMENT) bleiben unverändert stehen. Die Überzahlung ist IMMER genau
// „Beglichen − neuer Betrag" je Ausgabe: ein zweiter Lauf ändert nichts, eine spätere Änderung gleicht die (unbenutzte)
// Überzahlung an — nie doppelt. Eine schon verrechnete/zurückgezahlte Überzahlung bleibt (Nein, nichts geändert).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackInsert, trackDelete, trackUpdate } from '@/core/sync/track';
import { postOrderCostOverpay, reverseSource, hasLedgerEntries } from '@/core/ledger/posting';
import { creditPaidForExpense } from '@/core/finance/expenseSettlement';
import { updateExpenseInHouse } from '@/core/payables/payables-house';
import { correctionDateIssue } from '@/core/ledger/correction-dates';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { GoldRejected } from '@/core/gold/gold-settle';
import {
  COST_OVERPAY_CHOICES, ORDER_COST_CLAIM_OPEN, type CostOverpayChoice,
} from '@/core/payables/order-cost-claim';

export { COST_OVERPAY_CHOICES, type CostOverpayChoice } from '@/core/payables/order-cost-claim';

const F = (v: unknown): number => Math.round((Number(v) || 0) * 1000);
const B = (f: number): number => f / 1000;
const fmt = (f: number): string => B(f).toFixed(3);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export const OVERPAY_CHOICE_REQUIRED = 'ORDER_COST_OVERPAY_CHOICE_REQUIRED';
export const OVERPAY_CREDIT_USED = 'ORDER_COST_OVERPAY_USED';

/** Eine lebende Überzahlung (Guthaben oder Rückforderung) aus dieser Ausgabe. */
export interface OrderCostOverpay { id: string; amountF: number; usedF: number; status: string; choice: CostOverpayChoice }

/** Alle lebenden Überzahlungen einer Order-Ausgabe — über ihre (nicht stornierte) Buchung gefunden. */
export function liveOrderCostOverpays(expenseId: string): OrderCostOverpay[] {
  return query(
    `SELECT sc.id, sc.amount, sc.used_amount, sc.status FROM supplier_credits sc
      WHERE sc.source_return_id IS NULL AND sc.source_purchase_id IS NULL
        AND sc.id IN (SELECT le.source_id FROM ledger_entries le
                       WHERE le.source_module = 'ORDER_COST_OVERPAY' AND le.reverses_entry_id IS NULL
                         AND json_extract(le.metadata_json, '$.expenseId') = ?)
      ORDER BY sc.created_at, sc.id`,
    [expenseId],
  ).map((r) => ({
    id: str(r.id), amountF: F(r.amount), usedF: F(r.used_amount), status: str(r.status),
    choice: str(r.status) === 'OPEN' || str(r.status) === 'USED' ? 'credit' : 'refund',
  }));
}

/** Was eine Kostenzeile schon an Lieferantenschuld hat — und was eine Änderung daraus macht. */
export interface OrderCostExpensePlan {
  expenseId: string;
  supplierId: string;
  expenseDate: string;
  oldAmountF: number;
  /** 0 = die Zeile wird gelöscht. */
  newAmountF: number;
  /** Beglichen (bar/Bank/Benefit + Guthaben). */
  settledF: number;
  /** Offen danach. */
  openAfterF: number;
  /** Überzahlung danach (Ziel; Guthaben oder Rückforderung). */
  overpayF: number;
  existing: OrderCostOverpay[];
  existingF: number;
  choice?: CostOverpayChoice;
}

/** Die Antwort für die Maske (vor dem Speichern): Beglichen, offen danach, Überzahlung danach. */
export interface OrderCostPreview { settled: number; openAfter: number; overpay: number; existingOverpay: number }
export const previewOf = (p: OrderCostExpensePlan | null): OrderCostPreview => (p
  ? { settled: B(p.settledF), openAfter: B(p.openAfterF), overpay: B(p.overpayF), existingOverpay: B(p.existingF) }
  : { settled: 0, openAfter: 0, overpay: 0, existingOverpay: 0 });

/**
 * Plant die Änderung der Lieferantenschuld einer Kostenzeile — VOR jedem Schreiben, mit allen Neins.
 * `null` = die Zeile hat (noch) keine gebuchte Lieferantenschuld (dann ändert sich nur der Betrag der Zeile).
 */
export function planOrderCostExpense(
  lineId: string, newAmountF: number, choice: CostOverpayChoice | undefined, branchId: string, nowIso: string,
): OrderCostExpensePlan | null {
  const line = query('SELECT expense_id FROM order_lines WHERE id = ?', [lineId])[0];
  const expenseId = str(line?.expense_id);
  if (!expenseId) return null;
  return planCostExpense(expenseId, newAmountF, choice, branchId, nowIso);
}

/**
 * Der Kern — für JEDE Ausgabe mit Lieferantenschuld (Order-Kostenzeile; MIXED-INVOICE P4: die Verlust-Ausgabe eines
 * Kommissionsverkaufs, Owner-Entscheidung „dieselbe Logik wie die Custom-Order-Kosten"): neuer Betrag (0 = weg), was beglichen
 * ist, was offen bleibt, die Überzahlung danach (Pflichtwahl Guthaben/Rückforderung) und alle Neins — VOR jedem Schreiben.
 */
export function planCostExpense(
  expenseId: string, newAmountF: number, choice: CostOverpayChoice | undefined, branchId: string, nowIso: string,
): OrderCostExpensePlan | null {
  const e = query('SELECT id, amount, paid_amount, status, supplier_id, expense_date FROM expenses WHERE id = ?', [expenseId])[0];
  if (!e || str(e.status) === 'CANCELLED') return null;
  if (choice !== undefined && !COST_OVERPAY_CHOICES.includes(choice)) {
    throw new GoldRejected('INVALID_INPUT', "the overpayment choice is 'credit' or 'refund'");
  }
  const settledF = F(e.paid_amount) + F(creditPaidForExpense(expenseId));
  const existing = liveOrderCostOverpays(expenseId);
  const existingF = existing.reduce((s, c) => s + c.amountF, 0);
  const overpayF = Math.max(0, settledF - newAmountF);
  const plan: OrderCostExpensePlan = {
    expenseId, supplierId: str(e.supplier_id), expenseDate: str(e.expense_date),
    oldAmountF: F(e.amount), newAmountF, settledF,
    openAfterF: Math.max(0, newAmountF - settledF), overpayF, existing, existingF,
    ...(choice ? { choice } : {}),
  };
  if (overpayF !== existingF) {
    // Eine schon verrechnete oder (teil-)zurückgezahlte Überzahlung wird nicht still zurückgeholt.
    const benutzt = existing.find((c) => c.usedF > 0);
    if (benutzt) {
      throw new GoldRejected(OVERPAY_CREDIT_USED,
        `the overpayment of this cost (${fmt(benutzt.amountF)} BHD) has already been applied or repaid (${fmt(benutzt.usedF)} BHD) — `
        + 'its amount is not changed afterwards. Nothing was changed.');
    }
    if (overpayF > 0 && !choice) {
      throw new GoldRejected(OVERPAY_CHOICE_REQUIRED,
        `${fmt(settledF)} BHD of this cost is already paid to the supplier — ${fmt(overpayF)} BHD would be overpaid. `
        + 'Choose: keep it as supplier credit, or claim it back from the supplier. Nothing was changed.');
    }
  }
  // Perioden: die Schuld wird am Ausgabetag neu gebucht (Betrag) bzw. heute reklassiert (Überzahlung). Das Löschen einer
  // UNBEZAHLTEN Zeile bleibt der bisherige Weg (Storno heute, ohne zusätzliche Sperre).
  const tage: Array<{ iso: string; what: string }> = [];
  if ((newAmountF > 0 && newAmountF !== plan.oldAmountF) || overpayF !== existingF) tage.push({ iso: nowIso, what: 'the cost correction' });
  if (newAmountF > 0 && newAmountF !== plan.oldAmountF && hasLedgerEntries('EXPENSE', expenseId) && plan.expenseDate) {
    tage.push({ iso: `${plan.expenseDate}T12:00:00.000Z`, what: 'the supplier cost' });
  }
  const issue = correctionDateIssue(branchId, tage);
  if (issue) throw new GoldRejected((issue as { code: string }).code, issue.message);
  return plan;
}

export interface OrderCostExpenseApplied { expenseId: string; overpayCreditId?: string; overpayKind?: CostOverpayChoice; overpay: number }

/**
 * Führt den Plan aus (in der Klammer der aufrufenden Hausfolge): Schuld ändern bzw. — beim Löschen einer schon
 * (teil-)bezahlten Zeile — die Ausgabe stornieren und die Zahlungen stehen lassen; danach die Überzahlung angleichen.
 */
export function applyOrderCostExpense(
  plan: OrderCostExpensePlan, ctx: { branchId: string; userId: string; now: string },
  meta: { orderId: string; orderLineId: string },
): OrderCostExpenseApplied {
  const ord = query('SELECT order_number FROM orders WHERE id = ?', [meta.orderId])[0];
  return applyCostExpense(plan, ctx, {
    link: { orderId: meta.orderId, orderLineId: meta.orderLineId },
    unlinkOrderLine: meta.orderLineId,
    noteFor: (choice, expenseNumber) => `${choice === 'credit' ? 'Order cost overpayment' : 'Repayment claim — order cost'} ${str(ord?.order_number)} (${expenseNumber})`,
    auditField: 'order_cost_overpay',
    reason: 'order-cost-removed',
  });
}

/** Wie der Kern eine Ausgabe verknüpft und protokolliert — je Aufrufer (Order-Kostenzeile, Kommission). */
export interface CostExpenseApplyMeta {
  /** Steht an der Überzahlungsbuchung und im Protokoll (z. B. orderId/orderLineId oder consignmentId). */
  link: { orderId?: string; orderLineId?: string; consignmentId?: string };
  /** Nur die Order: beim Löschen die Kostenzeile von ihrer Ausgabe lösen. */
  unlinkOrderLine?: string;
  noteFor: (choice: CostOverpayChoice, expenseNumber: string) => string;
  auditField: string;
  reason: string;
  /** MIXED-INVOICE P4 (E11) — die Gegenbuchung der Ausgabe auf dem Tag ihres Originals (die Order bucht heute, wie bisher). */
  mirrorOriginalDates?: boolean;
  /** Der Tag, an dem die Überzahlung entsteht (Vorgabe: der Vorgang selbst). */
  overpayAt?: string;
}

/** Der Kern der Ausführung — EINE Stelle für Order-Kosten und Verlust-Ausgaben einer Kommission. */
export function applyCostExpense(
  plan: OrderCostExpensePlan, ctx: { branchId: string; userId: string; now: string }, meta: CostExpenseApplyMeta,
): OrderCostExpenseApplied {
  const db = getDatabase();
  const gespiegelt = meta.mirrorOriginalDates ? { mirrorOriginalDates: true } : {};
  if (plan.newAmountF > 0) {
    if (plan.newAmountF !== plan.oldAmountF) {
      updateExpenseInHouse(plan.expenseId, { amount: B(plan.newAmountF) }, ctx, undefined, { orderCostCorrection: true, ...gespiegelt });
    }
  } else if (plan.settledF > 0) {
    // Löschen einer (teil-)bezahlten Zeile: die Schuld fällt weg (Storno), die Zahlungen bleiben als Beleg stehen.
    db.run(`UPDATE expenses SET status = 'CANCELLED' WHERE id = ?`, [plan.expenseId]);
    if (hasLedgerEntries('EXPENSE', plan.expenseId)) reverseSource('EXPENSE', plan.expenseId, ctx.now, gespiegelt);
    trackUpdate('expenses', plan.expenseId, { status: 'CANCELLED', reason: meta.reason });
    if (meta.unlinkOrderLine) {
      db.run('UPDATE order_lines SET expense_id = NULL WHERE id = ?', [meta.unlinkOrderLine]);
      trackUpdate('order_lines', meta.unlinkOrderLine, { expenseId: null });
    }
  }
  // (Löschen ohne Zahlung: das bisherige deleteOrderLine storniert und entfernt die Ausgabe.)

  if (plan.overpayF === plan.existingF) {
    const c = plan.existing[0];
    return { expenseId: plan.expenseId, overpay: B(plan.overpayF), ...(c ? { overpayCreditId: c.id, overpayKind: c.choice } : {}) };
  }
  for (const c of plan.existing) {
    reverseSource('ORDER_COST_OVERPAY', c.id, ctx.now);
    db.run('DELETE FROM supplier_credits WHERE id = ?', [c.id]);
    trackDelete('supplier_credits', c.id);
  }
  if (plan.overpayF <= 0) return { expenseId: plan.expenseId, overpay: 0 };
  const choice = plan.choice as CostOverpayChoice;
  const creditId = uuid();
  const status = choice === 'credit' ? 'OPEN' : ORDER_COST_CLAIM_OPEN;
  const exp = query('SELECT expense_number FROM expenses WHERE id = ?', [plan.expenseId])[0];
  const note = meta.noteFor(choice, str(exp?.expense_number));
  const at = meta.overpayAt ?? ctx.now;
  db.run(
    `INSERT INTO supplier_credits (id, branch_id, supplier_id, source_return_id, source_purchase_id,
       amount, used_amount, status, note, created_at, created_by)
     VALUES (?, ?, ?, NULL, NULL, ?, 0, ?, ?, ?, ?)`,
    [creditId, ctx.branchId, plan.supplierId, B(plan.overpayF), status, note, at, ctx.userId || null],
  );
  trackInsert('supplier_credits', creditId, { supplierId: plan.supplierId, amount: B(plan.overpayF), status });
  postOrderCostOverpay(creditId, plan.supplierId, B(plan.overpayF), at, { expenseId: plan.expenseId, ...meta.link, choice });
  logAuditOrThrow({
    module: 'Supplier', entityType: 'supplier_credits', entityId: creditId, action: 'CREATE', field: meta.auditField,
    newValue: {
      kind: choice, amount: B(plan.overpayF), expenseId: plan.expenseId, ...meta.link,
      settled: B(plan.settledF), newCost: B(plan.newAmountF), replaced: plan.existing.map((c) => c.id),
    },
    actor: { userId: ctx.userId || undefined, branchId: ctx.branchId },
  });
  return { expenseId: plan.expenseId, overpayCreditId: creditId, overpayKind: choice, overpay: B(plan.overpayF) };
}
