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
// Neubuchung am Rechnungstag; Wareneinsatz und Margin-VAT folgen). Eingereichte/bezahlte VAT-Quartale und der
// Eröffnungsstichtag sind geschützt: liegt die Rechnung dort, wird die Begleichung abgelehnt — still geändert wird
// nichts (eine Steuerkorrektur in einer späteren Periode gibt es im System nicht; offener Punkt im Bericht).
// Storno einer Begleichung: nur solange ihre Lieferantenschuld unbezahlt ist; dreht genau die gespeicherten Werte zurück.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import {
  postEntries, reverseSource, postInvoiceIssued, activeSourceDates, hasLedgerEntries, type LedgerEntryInput,
} from '@/core/ledger/posting';
import { assertCorrectionDates } from '@/core/ledger/correction-dates';
import { vatFingerprint, assertVatUnchanged } from '@/core/tax/vat-period-lock';
import { vatEngine } from '@/core/tax/vat-engine';
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

/**
 * Berichtigt die Rechnungszeile eines schon verkauften Stücks um `deltaFils` Einstand (Margin: Margin-VAT neu).
 * Prüft Retouren, Sperren und VAT-Quartale VOR dem ersten Schreiben; bucht wie eine Rechnungskorrektur.
 * Gibt alten/neuen Einstand je Stück und alte/neue VAT der Zeile zurück.
 */
function correctSoldLine(sold: { invoiceId: string; lineId: string }, deltaFils: number, branchId: string, nowIso: string, dryRun: boolean):
  { oldUnit: number; newUnit: number; oldVat: number; newVat: number } {
  const line = query('SELECT * FROM invoice_lines WHERE id = ?', [sold.lineId])[0];
  const inv = query('SELECT id, issued_at, status FROM invoices WHERE id = ?', [sold.invoiceId])[0];
  if (!line || !inv) throw nein('INVOICE_NOT_FOUND', 'The invoice of this order is missing.');
  const zurueck = Number(query(
    `SELECT (SELECT COUNT(*) FROM sales_returns WHERE invoice_id = ? AND status != 'REJECTED')
          + (SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED') AS c`,
    [sold.invoiceId, sold.invoiceId])[0]?.c ?? 0);
  if (zurueck > 0) throw nein('INVOICE_HAS_RETURNS', 'The invoice of this piece already has a return or credit note — its cost cannot be corrected automatically.');
  const fremd = query(
    `SELECT 1 FROM ledger_entries e1 WHERE e1.source_module = 'INVOICE' AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
        AND e1.account NOT IN ('ACCOUNTS_RECEIVABLE','REVENUE','VAT_OUTPUT','MARGIN_VAT','COGS','INVENTORY')
        AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) LIMIT 1`, [sold.invoiceId]);
  if (fremd.length > 0) throw nein('INVOICE_HAS_EDIT_CREDIT', 'The invoice carries a credit from an earlier correction — correct its cost by hand.');
  const qty = Math.max(1, Number(line.quantity) || 1);
  const oldUnit = Number(line.purchase_price_snapshot) || 0;
  const newTotalF = F(oldUnit * qty) + deltaFils;
  if (newTotalF < 0) throw nein('COST_NEGATIVE', 'The cost of the piece would become negative.');
  const newUnit = Math.round((newTotalF / 1000 / qty) * 1e6) / 1e6;
  const oldVat = Number(line.vat_amount) || 0;
  let newVat = oldVat;
  if (String(line.tax_scheme) === 'MARGIN') {
    // O2 — Margin-VAT aus der aktualisierten Marge (Kundenpreis − tatsächlicher Einstand), dieselbe Formel wie beim Anlegen.
    newVat = vatEngine.calcMarginFromNet(Number(line.line_total) || 0, B(newTotalF), Number(line.vat_rate) || 10).internalVatAmount ?? 0;
  }
  // Perioden: Gegenbuchung an den Originaltagen, Neubuchung am Rechnungstag — beide müssen offen sein.
  const dates = [...activeSourceDates('INVOICE', sold.invoiceId), String(inv.issued_at)].map((iso) => ({ iso, what: 'the correction of this invoice' }));
  assertCorrectionDates(branchId, dates);
  if (dryRun) return { oldUnit, newUnit, oldVat, newVat };

  const before = vatFingerprint(sold.invoiceId);
  const db = getDatabase();
  db.run('UPDATE invoice_lines SET purchase_price_snapshot = ?, vat_amount = ? WHERE id = ?', [newUnit, newVat, sold.lineId]);
  trackUpdate('invoice_lines', sold.lineId, { purchasePriceSnapshot: newUnit, vatAmount: newVat });
  const sums = query(
    `SELECT COALESCE(SUM(unit_price * MAX(1, quantity)), 0) AS net, COALESCE(SUM(vat_amount), 0) AS vat,
            COALESCE(SUM(purchase_price_snapshot * MAX(1, quantity)), 0) AS cost FROM invoice_lines WHERE invoice_id = ?`, [sold.invoiceId])[0];
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  const net = Number(sums?.net) || 0, cost = r3(Number(sums?.cost) || 0), vat = r3(Number(sums?.vat) || 0);
  db.run('UPDATE invoices SET vat_amount = ?, purchase_price_snapshot = ?, margin_snapshot = ?, updated_at = ? WHERE id = ?',
    [vat, cost, r3(net - cost), nowIso, sold.invoiceId]);
  trackUpdate('invoices', sold.invoiceId, { vatAmount: vat, purchasePriceSnapshot: cost, marginSnapshot: r3(net - cost) });
  if (line.product_id) {
    db.run('UPDATE products SET purchase_price = ?, updated_at = ? WHERE id = ?', [newUnit, nowIso, String(line.product_id)]);
    trackUpdate('products', String(line.product_id), { purchasePrice: newUnit });
  }
  // Buchung wie jede Rechnungskorrektur: alles der Rechnung an den Originaltagen zurück, neu zum Rechnungstag.
  if (hasLedgerEntries('INVOICE', sold.invoiceId)) reverseSource('INVOICE', sold.invoiceId, nowIso, { mirrorOriginalDates: true });
  useInvoiceStore.getState().loadInvoices();
  const fresh = useInvoiceStore.getState().getInvoice(sold.invoiceId);
  if (!fresh) throw new Error('order gold settle: the invoice could not be reloaded');
  postInvoiceIssued(fresh);
  // Ein gemeldetes Quartal (Export-Fingerabdruck) darf sich nicht still ändern.
  assertVatUnchanged(branchId, before, vatFingerprint(sold.invoiceId));
  logAuditOrThrow({
    module: 'Invoice', entityType: 'invoice_lines', entityId: sold.lineId, action: 'UPDATE', field: 'cost_correction_order_gold',
    oldValue: { purchasePriceSnapshot: oldUnit, vatAmount: oldVat }, newValue: { purchasePriceSnapshot: newUnit, vatAmount: newVat, deltaFils },
  });
  return { oldUnit, newUnit, oldVat, newVat };
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
  if (settledOn !== nowIso.slice(0, 10)) assertCorrectionDates(actor.branchId, [{ iso: occurredAt, what: 'this settlement' }]);

  const amountF = mulDiv(gramsMg, rateF, 1000);
  const activeShares = Number(query(`SELECT COALESCE(SUM(book_share), 0) AS s FROM gold_payable_settlements WHERE payable_id = ? AND status = 'ACTIVE'`, [req.payableId])[0]?.s ?? 0);
  const bookF = F(p.book_value);
  const shareF = gramsMg === openMg ? Math.max(0, bookF - F(activeShares)) : mulDiv(bookF, gramsMg, weightMg);
  const diffF = amountF - shareF;
  const orderId = String(p.source_order_id);
  const sold = soldLineOf(orderId);
  // Prüfen, bevor geschrieben wird (Sperren der Rechnung, Retouren).
  if (sold && diffF !== 0) correctSoldLine(sold, diffF, actor.branchId, nowIso, true);

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
  if (diffF > 0) entries.push({ account: 'INVENTORY', direction: 'DEBIT', amount: B(diffF), metadata: { ...meta, part: 'cost_difference' } });
  if (diffF < 0) entries.push({ account: 'INVENTORY', direction: 'CREDIT', amount: B(-diffF), metadata: { ...meta, part: 'cost_difference' } });
  postEntries(entries, { occurredAt, sourceModule: 'EXPENSE', sourceId: expenseId });

  const nextDoneMg = doneMg + gramsMg;
  const fertig = nextDoneMg >= weightMg;
  db.run('UPDATE gold_payables SET fulfilled_grams = ?, status = ?, settlement_expense_id = ?, updated_at = ? WHERE id = ?',
    [B(nextDoneMg), fertig ? 'FULFILLED' : 'OPEN', expenseId, nowIso, req.payableId]);
  trackUpdate('gold_payables', req.payableId, { fulfilledGrams: B(nextDoneMg), status: fertig ? 'FULFILLED' : 'OPEN' });

  let corr: { oldUnit: number; newUnit: number; oldVat: number; newVat: number } | null = null;
  if (diffF !== 0) {
    shiftUnsoldCost(orderId, String(p.source_order_line_id ?? ''), diffF, nowIso);
    if (sold) {
      // Das Produkt bekam oben schon den Einstand (+Diff); die Rechnungszeile folgt hier ausdrücklich.
      corr = correctSoldLine(sold, diffF, actor.branchId, nowIso, false);
    }
  }
  const settlementId = uuid();
  db.run(
    `INSERT INTO gold_payable_settlements (id, branch_id, payable_id, order_id, kind, grams, rate_per_gram, amount, book_share, difference,
       settled_on, expense_id, invoice_id, invoice_line_id, old_unit_cost, new_unit_cost, old_vat_amount, new_vat_amount, status, notes, created_at, created_by)
     VALUES (?, ?, ?, ?, 'MONEY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
    [settlementId, actor.branchId, req.payableId, orderId, B(gramsMg), B(rateF), B(amountF), B(shareF), B(diffF), settledOn, expenseId,
     corr ? sold!.invoiceId : null, corr ? sold!.lineId : null, corr?.oldUnit ?? null, corr?.newUnit ?? null, corr?.oldVat ?? null, corr?.newVat ?? null,
     req.notes ?? null, nowIso, actor.userId],
  );
  trackInsert('gold_payable_settlements', settlementId, { payableId: req.payableId, grams: B(gramsMg), amount: B(amountF), difference: B(diffF) });
  logAuditOrThrow({
    module: 'Gold', entityType: 'gold_payable_settlements', entityId: settlementId, action: 'CREATE', field: 'settlement',
    newValue: { payableId: req.payableId, grams: B(gramsMg), ratePerGram: B(rateF), amount: B(amountF), bookShare: B(shareF), difference: B(diffF), settledOn, expenseId },
    actor,
  });
  reloadStores();
  return {
    settlementId, payableId: req.payableId, expenseId, grams: B(gramsMg), amount: B(amountF), bookShare: B(shareF), difference: B(diffF),
    openGrams: B(weightMg - nextDoneMg), status: fertig ? 'FULFILLED' : 'OPEN', invoiceLineCorrected: !!corr,
  };
}

/** Nimmt eine Begleichung zurück, solange ihre Lieferantenschuld unbezahlt ist. In der Klammer des Aufrufers. */
/** Die wirksamen BHD-Begleichungen einer Goldschuld (für die Liste mit „Reverse" am Primary) — nur lesend. */
export interface ActiveOrderGoldSettlement { id: string; grams: number; rate: number; amount: number; difference: number; settledOn: string }
export function activeOrderGoldSettlements(payableId: string): ActiveOrderGoldSettlement[] {
  return query(
    `SELECT id, grams, rate_per_gram, amount, difference, settled_on FROM gold_payable_settlements
      WHERE payable_id = ? AND status = 'ACTIVE' ORDER BY created_at`, [payableId],
  ).map((r) => ({ id: String(r.id), grams: Number(r.grams), rate: Number(r.rate_per_gram), amount: Number(r.amount),
    difference: Number(r.difference), settledOn: String(r.settled_on) }));
}

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
  const sold = orderId ? soldLineOf(orderId) : null;
  const nowIso = new Date().toISOString();
  if (sold && diffF !== 0) correctSoldLine(sold, -diffF, actor.branchId, nowIso, true);

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
    if (sold) correctSoldLine(sold, -diffF, actor.branchId, nowIso, false);
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
