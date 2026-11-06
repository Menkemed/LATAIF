// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER K3a — die Goldschuld einer Order in BHD begleichen, ganz oder in Teilen, zum manuellen Kurs.
//
// Die Schuld (gold_payables, we_owe) trägt seit K1 ihren Wert: die Goldkosten der Order-Zeile, gebucht Soll
// INVENTORY / Haben GOLD_LIABILITY. Eine Begleichung in BHD
//   • löst ihren Anteil am Buchwert auf (Buchwert × beglichene g ÷ Schuld-g, kaufmännisch auf Fils; die letzte nimmt
//     den exakten Rest),
//   • wird Lieferantenschuld in Höhe g × Kurs (eine Ausgabe, bezahlt wie jede andere — auch in Teilen),
//   • und ihre Differenz (Mehr- oder Minderpreis) ist der TATSÄCHLICHE Goldpreis der Order: sie ändert deren Einstand.
// Buchung (Quelle EXPENSE = die Ausgabe der Begleichung, damit ein Storno genau alles zurückdreht):
//     Soll GOLD_LIABILITY (Anteil) · Haben ACCOUNTS_PAYABLE (Betrag) · Soll/Haben INVENTORY (Differenz).
// Ist das Stück noch nicht verkauft, trägt der Artikel bzw. die Gold-Zeile der Order den neuen Einstand. Ist es
// verkauft, wird die Rechnungszeile ausdrücklich berichtigt: Einstand neu und — bei Margin — die Margin-VAT aus der
// neuen Marge (Owner-Entscheidung O2), gebucht wie eine Rechnungskorrektur (Gegenbuchung an den Originaltagen,
// Neubuchung am Rechnungstag; Wareneinsatz und Margin-VAT folgen) — `core/invoices/sold-line-cost-correction`.
// CUSTOM-ORDER Review — liegt die Rechnung in einem gemeldeten Quartal (oder vor dem Stichtag), darf die Goldschuld
// trotzdem beglichen werden: die Rechnung bleibt unverändert, die Differenz geht in der offenen Periode (Tag der
// Begleichung) in den Wareneinsatz (cost_mode SEPARATE, zugeordnet der Rechnungszeile); eine mögliche Margin-VAT-Wirkung
// steht geschätzt als REVIEW an der Begleichung — der gesonderte VAT-Korrekturvorgang ist eine Owner-/Buchhalter-
// Entscheidung und wird hier NICHT gebucht.
// Storno einer Begleichung: nur solange ihre Lieferantenschuld unbezahlt ist; dreht genau die gespeicherten Werte zurück.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { postEntries, reverseSource, hasLedgerEntries, type LedgerEntryInput } from '@/core/ledger/posting';
import { assertCorrectionDates } from '@/core/ledger/correction-dates';
import { planSoldLineCostCorrection, applySoldLineCostCorrection, type SoldLinePlan } from '@/core/invoices/sold-line-cost-correction';
import { businessDateIssue } from '@/core/utils/business-date';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { useOrderStore } from '@/stores/orderStore';

export class OrderGoldSettleRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${message} Nothing was changed.`); this.code = code; this.name = 'OrderGoldSettleRejected'; }
}
const nein = (code: string, msg: string): OrderGoldSettleRejected => new OrderGoldSettleRejected(code, msg);

const F = (v: unknown): number => Math.round((Number(v) || 0) * 1000);           // BHD → Fils / g → mg
const B = (fils: number): number => Math.round(fils) / 1000;                       // Fils → BHD
/** round_half_up(a·b / c) für nicht-negative ganze Zahlen (exakt). */
const mulDiv = (a: number, b: number, c: number): number => Number((2n * BigInt(a) * BigInt(b) + BigInt(c)) / (2n * BigInt(c)));

export interface OrderGoldSettleRequest {
  payableId: string;
  /** Beglichene Gramm im Karat der Schuld (höchstens der offene Rest). */
  grams: number;
  /** Manueller Kurs: BHD je Gramm. */
  ratePerGram: number;
  /** Tag der Begleichung (JJJJ-MM-TT); leer = heute. */
  settledOn?: string;
  notes?: string;
}

export interface OrderGoldSettled {
  settlementId: string; payableId: string; expenseId: string;
  grams: number; amount: number; bookShare: number; difference: number;
  openGrams: number; status: string; invoiceLineCorrected: boolean;
  /** CUSTOM-ORDER Review — wohin die Differenz ging (UNSOLD | INVOICE | SEPARATE). */
  costMode: 'UNSOLD' | 'INVOICE' | 'SEPARATE';
}

interface Actor { branchId: string; userId: string }

function livePayable(id: string, branchId: string): Record<string, unknown> {
  const p = query('SELECT * FROM gold_payables WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!p) throw nein('GOLD_PAYABLE_NOT_FOUND', 'No such gold debt in this branch.');
  return p;
}

/** Die verkaufte Rechnungszeile des Sonderstücks dieser Order (oder null, solange es nicht verkauft ist). */
function soldLineOf(orderId: string): { invoiceId: string; lineId: string } | null {
  const r = query(
    `SELECT il.invoice_id, il.id AS line_id FROM order_lines ol
       JOIN invoices i ON i.id = ol.invoice_id AND i.status != 'CANCELLED'
       JOIN invoice_lines il ON il.invoice_id = i.id AND il.product_id = ol.product_id
      WHERE ol.order_id = ? AND ol.material_kind = 'custom' AND ol.invoice_id IS NOT NULL
      LIMIT 1`, [orderId])[0];
  return r ? { invoiceId: String(r.invoice_id), lineId: String(r.line_id) } : null;
}

/** Plan einer Berichtigung des verkauften Stücks; ein Sperrgrund (Retoure, Korrektur-Guthaben, negativ) ist ein Nein. */
function planSold(sold: { invoiceId: string; lineId: string }, deltaFils: number, branchId: string): SoldLinePlan {
  const plan = planSoldLineCostCorrection(sold, deltaFils, branchId);
  if (plan.blocker) throw nein(plan.blocker.code, plan.blocker.message);
  return plan;
}

/** Wirkung einer Differenz auf das noch nicht verkaufte Stück: Gold-Zeile der Order und (falls schon da) Artikel. */
function shiftUnsoldCost(orderId: string, orderLineId: string, deltaFils: number, nowIso: string): void {
  const db = getDatabase();
  if (orderLineId) {
    const l = query('SELECT cost_amount FROM order_lines WHERE id = ?', [orderLineId])[0];
    if (l) {
      const next = B(F(l.cost_amount) + deltaFils);
      db.run('UPDATE order_lines SET cost_amount = ? WHERE id = ?', [next, orderLineId]);
      trackUpdate('order_lines', orderLineId, { costAmount: next });
    }
  }
  const pid = query(`SELECT COALESCE(o.product_id, (SELECT ol.product_id FROM order_lines ol WHERE ol.order_id = o.id AND ol.material_kind = 'custom' LIMIT 1)) AS pid FROM orders o WHERE o.id = ?`, [orderId])[0]?.pid;
  if (pid) {
    const p = query('SELECT purchase_price FROM products WHERE id = ?', [String(pid)])[0];
    if (p) {
      const next = B(F(p.purchase_price) + deltaFils);
      db.run('UPDATE products SET purchase_price = ?, updated_at = ? WHERE id = ?', [next, nowIso, String(pid)]);
      trackUpdate('products', String(pid), { purchasePrice: next });
    }
  }
}

/** Ist eine Goldschuld eine bewertete Order-Schuld (K1)? Dann gelten nur noch die Wege dieses Moduls. */
export function isValuedOrderGoldDebt(p: Record<string, unknown>): boolean {
  return !!p.source_order_id;
}

/** Begleicht eine Order-Goldschuld (teilweise) in BHD. In der Klammer des Aufrufers. */
export function settleOrderGoldInBhd(actor: Actor, req: OrderGoldSettleRequest): OrderGoldSettled {
  const p = livePayable(req.payableId, actor.branchId);
  if (String(p.status) !== 'OPEN') throw nein('GOLD_PAYABLE_NOT_OPEN', `This gold debt is already ${String(p.status)}.`);
  if (String(p.direction ?? 'we_owe') !== 'we_owe' || !p.source_order_id) throw nein('GOLD_PAYABLE_NOT_ORDER', 'This is not a gold debt of a custom order.');
  if (p.book_value === null || p.book_value === undefined) {
    throw nein('GOLD_DEBT_NOT_VALUED', 'This gold debt has no booked value yet (created before the value booking) — correct the order data first.');
  }
  const gramsMg = F(req.grams), rateF = F(req.ratePerGram);
  if (!(gramsMg > 0)) throw nein('GOLD_GRAMS_INVALID', 'Enter the grams to settle.');
  if (!(rateF > 0)) throw nein('GOLD_RATE_INVALID', 'Enter the gold price per gram (BHD).');
  const weightMg = F(p.weight_grams), doneMg = F(p.fulfilled_grams);
  const openMg = Math.max(0, weightMg - doneMg);
  if (gramsMg > openMg) throw nein('GOLD_OVER_SETTLEMENT', `Only ${B(openMg).toFixed(3)} g ${String(p.karat)} are still open.`);
  const day = req.settledOn ? String(req.settledOn).slice(0, 10) : undefined;
  const dIssue = businessDateIssue(day, 'The settlement date');
  if (dIssue) throw nein('SETTLEMENT_DATE_INVALID', `${dIssue}.`);
  const nowIso = new Date().toISOString();
  const settledOn = day || nowIso.slice(0, 10);
  const occurredAt = settledOn === nowIso.slice(0, 10) ? nowIso : `${settledOn}T12:00:00.000Z`;
  // Ein zurückdatierter Tag der Begleichung muss offen sein (wie bei jeder anderen Buchung von heute gilt „heute" als offen).
  if (settledOn !== nowIso.slice(0, 10)) assertCorrectionDates(actor.branchId, [{ iso: occurredAt, what: 'this settlement' }]);

  const amountF = mulDiv(gramsMg, rateF, 1000);
  const activeShares = Number(query(`SELECT COALESCE(SUM(book_share), 0) AS s FROM gold_payable_settlements WHERE payable_id = ? AND status = 'ACTIVE'`, [req.payableId])[0]?.s ?? 0);
  const bookF = F(p.book_value);
  const shareF = gramsMg === openMg ? Math.max(0, bookF - F(activeShares)) : mulDiv(bookF, gramsMg, weightMg);
  const diffF = amountF - shareF;
  const orderId = String(p.source_order_id);
  const sold = soldLineOf(orderId);
  // Prüfen, bevor geschrieben wird (Sperren der Rechnung, Retouren) — und wohin die Differenz geht.
  const plan = sold && diffF !== 0 ? planSold(sold, diffF, actor.branchId) : null;
  const costMode: OrderGoldSettled['costMode'] = !plan ? 'UNSOLD' : plan.mode === 'INVOICE' ? 'INVOICE' : 'SEPARATE';
  // Owner-Regel: die getrennte Differenz wird in einer ZULÄSSIGEN OFFENEN Periode gebucht — auch „heute" muss dann offen sein
  // (ist das laufende Quartal schon gemeldet/bezahlt, gibt es keinen offenen Tag: Nein, nichts geändert).
  if (costMode === 'SEPARATE') assertCorrectionDates(actor.branchId, [{ iso: occurredAt, what: 'the cost difference of this settlement' }]);

  const db = getDatabase();
  const order = query('SELECT order_number FROM orders WHERE id = ?', [orderId])[0];
  const expenseId = uuid();
  const expenseNumber = getNextDocumentNumber('EXP');
  const description = `${String(order?.order_number ?? '')} · gold ${B(gramsMg).toFixed(3)} g ${String(p.karat)} × ${B(rateF).toFixed(3)} BHD/g`;
  db.run(
    `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method, expense_date,
       description, related_module, related_entity_id, supplier_id, status, created_at, created_by)
     VALUES (?, ?, ?, 'Inventory', ?, 0, 'bank', ?, ?, 'gold_payable', ?, ?, 'PENDING', ?, ?)`,
    [expenseId, actor.branchId, expenseNumber, B(amountF), settledOn, description, req.payableId, String(p.supplier_id), nowIso, actor.userId],
  );
  trackInsert('expenses', expenseId, { category: 'Inventory', amount: B(amountF), relatedModule: 'gold_payable', payableId: req.payableId });
  const meta = { kind: 'order_gold_settlement', payableId: req.payableId, orderId, grams: B(gramsMg), ratePerGram: B(rateF), expenseNumber };
  const entries: LedgerEntryInput[] = [];
  if (shareF > 0) entries.push({ account: 'GOLD_LIABILITY', direction: 'DEBIT', amount: B(shareF), counterpartyType: 'SUPPLIER', counterpartyId: String(p.supplier_id), metadata: meta });
  entries.push({ account: 'ACCOUNTS_PAYABLE', direction: 'CREDIT', amount: B(amountF), counterpartyType: 'SUPPLIER', counterpartyId: String(p.supplier_id), metadata: meta });
  // SEPARATE: die Rechnung (geschlossenes Quartal) bleibt — die Differenz ist Wareneinsatz der offenen Periode, der
  // Rechnungszeile zugeordnet (Zuordnung je Artikel wie jede COGS-Zeile). Sonst: Einstand des Stücks (INVENTORY).
  const diffAccount = costMode === 'SEPARATE' ? 'COGS' : 'INVENTORY';
  const diffLine = costMode === 'SEPARATE' && sold ? { sourceLineId: sold.lineId } : {};
  if (diffF > 0) entries.push({ account: diffAccount, direction: 'DEBIT', amount: B(diffF), ...diffLine, metadata: { ...meta, part: 'cost_difference', costMode } });
  if (diffF < 0) entries.push({ account: diffAccount, direction: 'CREDIT', amount: B(-diffF), ...diffLine, metadata: { ...meta, part: 'cost_difference', costMode } });
  postEntries(entries, { occurredAt, sourceModule: 'EXPENSE', sourceId: expenseId });

  const nextDoneMg = doneMg + gramsMg;
  const fertig = nextDoneMg >= weightMg;
  db.run('UPDATE gold_payables SET fulfilled_grams = ?, status = ?, settlement_expense_id = ?, updated_at = ? WHERE id = ?',
    [B(nextDoneMg), fertig ? 'FULFILLED' : 'OPEN', expenseId, nowIso, req.payableId]);
  trackUpdate('gold_payables', req.payableId, { fulfilledGrams: B(nextDoneMg), status: fertig ? 'FULFILLED' : 'OPEN' });

  let corr: { oldUnit: number; newUnit: number; oldVat: number; newVat: number } | null = null;
  if (diffF !== 0) {
    shiftUnsoldCost(orderId, String(p.source_order_line_id ?? ''), diffF, nowIso);
    if (sold && costMode === 'INVOICE') {
      // Das Produkt bekam oben schon den Einstand (+Diff); die Rechnungszeile folgt hier ausdrücklich.
      corr = applySoldLineCostCorrection(sold, diffF, actor.branchId, nowIso, {
        setProductCost: true, auditField: 'cost_correction_order_gold', auditContext: { payableId: req.payableId, orderId } });
    } else if (sold && plan && costMode === 'SEPARATE') {
      // Nur festhalten (Schätzung), nicht buchen: alter/neuer Einstand und Margin-VAT der unveränderten Rechnungszeile.
      corr = { oldUnit: plan.oldUnit, newUnit: plan.newUnit, oldVat: plan.oldVat, newVat: plan.newVat };
    }
  }
  const vatStatus = costMode === 'SEPARATE' && plan && plan.taxScheme === 'MARGIN' && Math.abs(plan.newVat - plan.oldVat) > 0.0005 ? 'REVIEW' : 'NONE';
  const settlementId = uuid();
  db.run(
    `INSERT INTO gold_payable_settlements (id, branch_id, payable_id, order_id, kind, grams, rate_per_gram, amount, book_share, difference,
       settled_on, expense_id, invoice_id, invoice_line_id, old_unit_cost, new_unit_cost, old_vat_amount, new_vat_amount, cost_mode, vat_status,
       status, notes, created_at, created_by)
     VALUES (?, ?, ?, ?, 'MONEY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [settlementId, actor.branchId, req.payableId, orderId, B(gramsMg), B(rateF), B(amountF), B(shareF), B(diffF), settledOn, expenseId,
     corr ? sold!.invoiceId : null, corr ? sold!.lineId : null, corr?.oldUnit ?? null, corr?.newUnit ?? null, corr?.oldVat ?? null, corr?.newVat ?? null,
     costMode, vatStatus, req.notes ?? null, nowIso, actor.userId],
  );
  trackInsert('gold_payable_settlements', settlementId, { payableId: req.payableId, grams: B(gramsMg), amount: B(amountF), difference: B(diffF), costMode, vatStatus });
  logAuditOrThrow({
    module: 'Gold', entityType: 'gold_payable_settlements', entityId: settlementId, action: 'CREATE', field: 'settlement',
    newValue: { payableId: req.payableId, grams: B(gramsMg), ratePerGram: B(rateF), amount: B(amountF), bookShare: B(shareF), difference: B(diffF), settledOn, expenseId,
      costMode, vatStatus, ...(plan?.periodReason ? { periodReason: plan.periodReason } : {}) },
    actor,
  });
  reloadStores();
  return {
    settlementId, payableId: req.payableId, expenseId, grams: B(gramsMg), amount: B(amountF), bookShare: B(shareF), difference: B(diffF),
    openGrams: B(weightMg - nextDoneMg), status: fertig ? 'FULFILLED' : 'OPEN', invoiceLineCorrected: costMode === 'INVOICE', costMode,
  };
}

/** Nimmt eine Begleichung zurück, solange ihre Lieferantenschuld unbezahlt ist. In der Klammer des Aufrufers. */
export function reverseOrderGoldSettlement(actor: Actor, settlementId: string): { settlementId: string; payableId: string } {
  const st = query('SELECT * FROM gold_payable_settlements WHERE id = ? AND branch_id = ?', [settlementId, actor.branchId])[0];
  if (!st) throw nein('SETTLEMENT_NOT_FOUND', 'No such settlement in this branch.');
  if (String(st.status) !== 'ACTIVE') throw nein('SETTLEMENT_NOT_ACTIVE', 'This settlement is already reversed.');
  const exp = query('SELECT id, paid_amount, status FROM expenses WHERE id = ?', [String(st.expense_id)])[0];
  const bezahlt = Number(exp?.paid_amount ?? 0) > 0.0005
    || query('SELECT 1 FROM expense_payments WHERE expense_id = ? LIMIT 1', [String(st.expense_id)]).length > 0;
  if (bezahlt) throw nein('SETTLEMENT_PAID', 'The supplier debt of this settlement is already (partly) paid — reverse that payment first.');
  const diffF = F(st.difference);
  const orderId = String(st.order_id ?? '');
  const separate = String(st.cost_mode ?? 'UNSOLD') === 'SEPARATE';
  // SEPARATE: die Differenz steht als eigener Wareneinsatz in der Ausgabe — ihre Gegenbuchung nimmt sie mit; die Rechnung
  // war und bleibt unverändert. Sonst steckt die Differenz im Einstand des Stücks: ist es verkauft, folgt die Rechnung.
  const sold = !separate && orderId ? soldLineOf(orderId) : null;
  const nowIso = new Date().toISOString();
  if (sold && diffF !== 0) {
    const back = planSold(sold, -diffF, actor.branchId);
    if (back.mode !== 'INVOICE') {
      throw nein('SETTLEMENT_INVOICE_PERIOD_CLOSED', `The invoice that carries this cost is in a closed VAT period or before the opening cut-off (${back.periodReason ?? ''}). Record a new settlement instead of reversing this one.`);
    }
  }

  const db = getDatabase();
  if (hasLedgerEntries('EXPENSE', String(st.expense_id))) reverseSource('EXPENSE', String(st.expense_id), nowIso);
  db.run(`UPDATE expenses SET status = 'CANCELLED' WHERE id = ?`, [String(st.expense_id)]);
  trackUpdate('expenses', String(st.expense_id), { status: 'CANCELLED' });
  const p = query('SELECT fulfilled_grams FROM gold_payables WHERE id = ?', [String(st.payable_id)])[0];
  const doneMg = Math.max(0, F(p?.fulfilled_grams) - F(st.grams));
  db.run(`UPDATE gold_payables SET fulfilled_grams = ?, status = 'OPEN', updated_at = ? WHERE id = ?`, [B(doneMg), nowIso, String(st.payable_id)]);
  trackUpdate('gold_payables', String(st.payable_id), { fulfilledGrams: B(doneMg), status: 'OPEN' });
  if (diffF !== 0) {
    const gp = query('SELECT source_order_line_id FROM gold_payables WHERE id = ?', [String(st.payable_id)])[0];
    shiftUnsoldCost(orderId, String(gp?.source_order_line_id ?? ''), -diffF, nowIso);
    if (sold) applySoldLineCostCorrection(sold, -diffF, actor.branchId, nowIso, {
      setProductCost: true, auditField: 'cost_correction_order_gold', auditContext: { settlementId, reversal: true } });
  }
  db.run(`UPDATE gold_payable_settlements SET status = 'REVERSED', reversed_at = ? WHERE id = ?`, [nowIso, settlementId]);
  trackUpdate('gold_payable_settlements', settlementId, { status: 'REVERSED' });
  logAuditOrThrow({
    module: 'Gold', entityType: 'gold_payable_settlements', entityId: settlementId, action: 'UPDATE', field: 'status',
    oldValue: 'ACTIVE', newValue: 'REVERSED', actor,
  });
  reloadStores();
  return { settlementId, payableId: String(st.payable_id) };
}

function reloadStores(): void {
  try { useOrderStore.getState().loadOrders(); } catch { /* Anzeige */ }
  try { useProductStore.getState().loadProducts(); } catch { /* Anzeige */ }
  try { useInvoiceStore.getState().loadInvoices(); } catch { /* Anzeige */ }
}
