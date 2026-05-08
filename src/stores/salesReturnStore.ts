// ═══════════════════════════════════════════════════════════
// LATAIF — Sales Returns (Plan §Returns)
// ═══════════════════════════════════════════════════════════
// Refactor 2026-05 — clean refund/CN wiring:
//  - createReturn: status=REQUESTED, refund_status=PENDING_REFUND, applies product
//    disposition NOW (User-Spec: Disposition beim Anlegen). KEINE CN, KEIN Cash.
//  - approveReturn: status=APPROVED, erstellt Credit Note (Industry Standard) und
//    revertiert VAT auf Invoice. KEIN Cash bewegt sich.
//  - recordRefundPayment: tatsächlicher Cash-Out → Banking ↓, refund_paid_amount ↑,
//    CN cashRefund/receivableCancel-Split wird live nachgezogen, refund_status
//    transitioned. Auto-approve, falls noch REQUESTED, damit CN garantiert existiert.
//  - refundReturn: Convenience-Wrapper (approve + recordRefundPayment in einem).
//  - rejectReturn: revertiert Disposition (best-effort), nur erlaubt vor Approval.
//  - deleteReturn: revertiert Disposition + VAT + löscht CN.

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { SalesReturn, SalesReturnLine, SalesReturnStatus, RefundStatus, ProductDisposition } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackStatusChange, trackRefund, trackDelete } from '@/core/sync/track';
import { useCreditNoteStore } from '@/stores/creditNoteStore';

// ── Helpers ────────────────────────────────────────────────

// Disposition auf Produkt anwenden (Plan §Returns §6 + §Commission §13).
// Wird in createReturn aufgerufen — Ware ist physisch zurück, Status muss reflektieren.
function applyDisposition(
  db: ReturnType<typeof getDatabase>,
  lines: Array<{ productId?: string; quantity: number; unitPrice: number }>,
  disposition: ProductDisposition,
  now: string,
): void {
  for (const line of lines) {
    if (!line.productId) continue;
    if (disposition === 'RETURN_TO_OWNER') {
      // Plan §Commission §13 A — Ware verlässt System, Consignment auf RETURNED_TO_OWNER.
      db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`, [now, line.productId]);
      db.run(
        `UPDATE consignments SET status = 'RETURNED_TO_OWNER', updated_at = ?
         WHERE product_id = ? AND status IN ('sold','SOLD','paid_out','active','IN_STOCK')`,
        [now, line.productId]
      );
    } else if (disposition === 'KEEP_AS_OWN') {
      // Plan §Commission §13 B — bleibt im System als OWN, purchase_price = letzter Verkaufspreis.
      db.run(
        `UPDATE products SET stock_status = 'in_stock', source_type = 'OWN',
         purchase_price = COALESCE(?, purchase_price), updated_at = ? WHERE id = ?`,
        [line.unitPrice ?? null, now, line.productId]
      );
      db.run(
        `UPDATE consignments SET status = 'RETURNED', updated_at = ?
         WHERE product_id = ? AND status IN ('sold','SOLD','paid_out','active','IN_STOCK')`,
        [now, line.productId]
      );
    } else if (disposition === 'IN_STOCK') {
      // Quantity-aware Restock.
      const qty = Math.max(1, line.quantity || 1);
      db.run(
        `UPDATE products SET
           quantity = COALESCE(quantity, 0) + ?,
           stock_status = 'in_stock',
           updated_at = ? WHERE id = ?`,
        [qty, now, line.productId]
      );
    } else {
      const newStatus = disposition === 'UNDER_REPAIR' ? 'in_repair'
        : disposition === 'WRITE_OFF' ? 'sold'
        : 'in_stock';
      db.run(`UPDATE products SET stock_status = ?, updated_at = ? WHERE id = ?`, [newStatus, now, line.productId]);
    }
  }
}

// Best-effort Revert (für reject/delete). KEEP_AS_OWN/RETURN_TO_OWNER nicht voll
// reversibel — Logwarnung statt stillschweigend zerstören.
function revertDisposition(
  db: ReturnType<typeof getDatabase>,
  lines: SalesReturnLine[],
  disposition: ProductDisposition,
  now: string,
): void {
  for (const line of lines) {
    if (!line.productId) continue;
    if (disposition === 'IN_STOCK') {
      const qty = Math.max(1, line.quantity || 1);
      db.run(
        `UPDATE products SET
           quantity = MAX(0, COALESCE(quantity, 0) - ?),
           stock_status = 'sold',
           updated_at = ? WHERE id = ?`,
        [qty, now, line.productId]
      );
    } else if (disposition === 'UNDER_REPAIR' || disposition === 'WRITE_OFF') {
      db.run(`UPDATE products SET stock_status = 'sold', updated_at = ? WHERE id = ?`, [now, line.productId]);
    } else if (disposition === 'KEEP_AS_OWN' || disposition === 'RETURN_TO_OWNER') {
      // Nicht voll reversibel (purchase_price/source_type Snapshot fehlt). Manueller Cleanup nötig.
      console.warn(`[Return] cannot fully revert ${disposition} disposition for product ${line.productId} — manual cleanup may be needed`);
      db.run(`UPDATE products SET stock_status = 'sold', updated_at = ? WHERE id = ?`, [now, line.productId]);
    }
  }
}

// Berechnet Cash-Refundability nach Industriestandard (SAP/Xero/QuickBooks):
//   cashRefund = max(0, customerPaid − (invoiceGross − allReturns) − otherRefundsAlreadyPaid)
// d. h. nur was Customer NACH Returns überzahlt hat ist cash-pflichtig zurückzugeben.
function computeRefundSplit(
  returnId: string,
  invoiceId: string,
  totalAmount: number,
): { cashRefundCap: number; receivableCancel: number; customerPaid: number; invoiceGross: number } {
  const invRow = query('SELECT paid_amount, gross_amount FROM invoices WHERE id = ?', [invoiceId])[0];
  const customerPaid = (invRow?.paid_amount as number) || 0;
  const invoiceGross = (invRow?.gross_amount as number) || 0;

  const otherReturnsRow = query(
    `SELECT COALESCE(SUM(total_amount), 0) AS s
     FROM sales_returns
     WHERE invoice_id = ? AND id != ? AND status != 'REJECTED'`,
    [invoiceId, returnId]
  )[0];
  const otherReturnsTotal = (otherReturnsRow?.s as number) || 0;

  const otherRefundsRow = query(
    `SELECT COALESCE(SUM(refund_paid_amount), 0) AS s
     FROM sales_returns
     WHERE invoice_id = ? AND id != ? AND status != 'REJECTED'`,
    [invoiceId, returnId]
  )[0];
  const otherRefundsAlreadyPaid = (otherRefundsRow?.s as number) || 0;

  const owedAfterAllReturns = Math.max(0, invoiceGross - otherReturnsTotal - totalAmount);
  const surplus = Math.max(0, customerPaid - owedAfterAllReturns - otherRefundsAlreadyPaid);
  const cashRefundCap = Math.min(totalAmount, surplus);
  const receivableCancel = Math.max(0, totalAmount - cashRefundCap);

  return { cashRefundCap, receivableCancel, customerPaid, invoiceGross };
}

// ── Store ──────────────────────────────────────────────────

interface SalesReturnStore {
  returns: SalesReturn[];
  loadReturns: () => void;
  getReturn: (id: string) => SalesReturn | undefined;
  createReturn: (input: {
    invoiceId: string;
    returnDate?: string;
    refundMethod?: 'cash' | 'bank' | 'card' | 'credit' | 'other';
    productDisposition?: ProductDisposition;
    reason?: string;
    notes?: string;
    lines: Array<{
      invoiceLineId: string;
      productId?: string;
      quantity: number;
      unitPrice: number;
      vatAmount: number;
    }>;
  }) => SalesReturn;
  approveReturn: (id: string) => void;
  rejectReturn: (id: string) => void;
  refundReturn: (id: string, partialAmount?: number) => void;
  recordRefundPayment: (returnId: string, amount: number, method: 'cash' | 'bank' | 'card' | 'credit' | 'other', date?: string) => void;
  deleteReturn: (id: string) => void;
  getInvoiceReturnSummary: (invoiceId: string, invoiceGross: number, invoicePaid?: number) => {
    returns: SalesReturn[];
    totalReturned: number;
    totalRefundPaid: number;
    outstandingRefund: number;
    returnState: 'NONE' | 'PARTIAL_RETURN' | 'RETURNED';
    refundState: RefundStatus;
  };
  getCustomerRefundPayable: (customerId: string) => number;
  getReturnedQtyForLine: (invoiceLineId: string) => number;
}

function rowToReturn(row: Record<string, unknown>): SalesReturn {
  const rawStatus = row.refund_status as RefundStatus | undefined;
  return {
    id: row.id as string,
    returnNumber: row.return_number as string,
    branchId: row.branch_id as string,
    invoiceId: row.invoice_id as string,
    customerId: row.customer_id as string,
    status: (row.status as SalesReturnStatus) || 'REQUESTED',
    totalAmount: (row.total_amount as number) || 0,
    vatCorrected: (row.vat_corrected as number) || 0,
    returnDate: row.return_date as string,
    refundMethod: row.refund_method as 'cash' | 'bank' | 'card' | 'credit' | 'other' | undefined,
    refundAmount: (row.refund_amount as number) || 0,
    refundPaidAmount: (row.refund_paid_amount as number) || 0,
    refundPaidDate: (row.refund_paid_date as string | null) || undefined,
    // Legacy 'NOT_REFUNDED' wird auf 'PENDING_REFUND' normalisiert (semantisch identisch).
    refundStatus: rawStatus === 'NOT_REFUNDED' ? 'PENDING_REFUND' : (rawStatus || 'PENDING_REFUND'),
    productDisposition: row.product_disposition as ProductDisposition | undefined,
    reason: (row.reason as string | null) || undefined,
    notes: row.notes as string | undefined,
    lines: [],
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToLine(row: Record<string, unknown>): SalesReturnLine {
  return {
    id: row.id as string,
    returnId: row.return_id as string,
    invoiceLineId: row.invoice_line_id as string | undefined,
    productId: row.product_id as string | undefined,
    quantity: (row.quantity as number) || 1,
    unitPrice: (row.unit_price as number) || 0,
    vatAmount: (row.vat_amount as number) || 0,
    lineTotal: (row.line_total as number) || 0,
  };
}

export const useSalesReturnStore = create<SalesReturnStore>((set, get) => ({
  returns: [],

  loadReturns: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM sales_returns WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      const list: SalesReturn[] = rows.map(r => {
        const ret = rowToReturn(r);
        const lineRows = query('SELECT * FROM sales_return_lines WHERE return_id = ?', [ret.id]);
        ret.lines = lineRows.map(rowToLine);
        return ret;
      });
      set({ returns: list });
    } catch { set({ returns: [] }); }
  },

  getReturn: (id) => get().returns.find(r => r.id === id),

  // ── Create ───────────────────────────────────────────────
  // Plan 2026-05: Disposition wird sofort angewandt. KEINE CN, KEIN Cash.
  // Refund-Status startet als PENDING_REFUND.
  createReturn: (input) => {
    if (!input.lines || input.lines.length === 0) {
      throw new Error('Return must include at least one line.');
    }
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const invRows = query('SELECT customer_id FROM invoices WHERE id = ?', [input.invoiceId]);
    const customerId = invRows[0]?.customer_id as string;

    // Per-Line Cap & Validierung.
    for (const l of input.lines) {
      if (!Number.isFinite(l.quantity) || l.quantity < 0) {
        throw new Error('Return quantity must be a non-negative number.');
      }
      if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
        throw new Error('Return unit price must be non-negative.');
      }
      const lineRows = query(
        `SELECT
           (SELECT quantity FROM invoice_lines WHERE id = ?) AS orig_qty,
           COALESCE((
             SELECT SUM(srl.quantity) FROM sales_return_lines srl
             JOIN sales_returns r ON r.id = srl.return_id
             WHERE srl.invoice_line_id = ? AND r.status != 'REJECTED'
           ), 0) AS already_returned`,
        [l.invoiceLineId, l.invoiceLineId]
      );
      const origQty = Number(lineRows[0]?.orig_qty || 0);
      const alreadyReturned = Number(lineRows[0]?.already_returned || 0);
      const remaining = Math.max(0, origQty - alreadyReturned);
      if (l.quantity > remaining + 0.005) {
        throw new Error(
          `Return quantity ${l.quantity} exceeds remaining ${remaining.toFixed(2)} (original ${origQty}, already returned ${alreadyReturned}).`
        );
      }
    }

    const returnNumber = getNextDocumentNumber('RET');
    const returnDate = input.returnDate || now.split('T')[0];
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const vatCorrected = input.lines.reduce((s, l) => s + l.vatAmount, 0);
    const disposition: ProductDisposition = input.productDisposition || 'IN_STOCK';

    db.run(
      `INSERT INTO sales_returns (id, branch_id, return_number, invoice_id, customer_id, status, total_amount,
        vat_corrected, return_date, refund_method, refund_amount, refund_paid_amount, refund_status,
        product_disposition, reason, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, 0, 0, 'PENDING_REFUND', ?, ?, ?, ?, ?)`,
      [id, branchId, returnNumber, input.invoiceId, customerId, total, vatCorrected, returnDate,
       input.refundMethod || null, disposition,
       input.reason || null, input.notes || null, now, userId]
    );

    const stmt = db.prepare(
      `INSERT INTO sales_return_lines (id, return_id, invoice_line_id, product_id, quantity, unit_price, vat_amount, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of input.lines) {
      stmt.run([uuid(), id, l.invoiceLineId, l.productId || null, l.quantity, l.unitPrice, l.vatAmount, l.quantity * l.unitPrice]);
    }
    stmt.free();

    // Plan 2026-05 §C: Disposition beim Anlegen anwenden — Ware ist physisch retour.
    applyDisposition(db, input.lines, disposition, now);

    saveDatabase();
    trackInsert('sales_returns', id, { returnNumber, invoiceId: input.invoiceId, total });
    get().loadReturns();
    return get().getReturn(id)!;
  },

  // ── Approve ──────────────────────────────────────────────
  // Plan 2026-05 §B: Approve = formaler Buchungsschritt. Erstellt Credit Note
  // (Industry Standard, auch bei unbezahlter Invoice → cashRefund=0, receivableCancel=total).
  // VAT auf Invoice wird hier reduziert. Cash bewegt sich NICHT.
  approveReturn: (id) => {
    const r = get().getReturn(id);
    if (!r) return;
    // Idempotent: schon approved oder weiter im Lifecycle → no-op.
    if (r.status === 'APPROVED' || r.status === 'REFUNDED' || r.status === 'CLOSED' || r.status === 'REJECTED') {
      return;
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    // Cash/Receivable-Split berechnen (Industriestandard).
    const { cashRefundCap, receivableCancel } = computeRefundSplit(id, r.invoiceId, r.totalAmount);

    // Credit Note erstellen — eigenständige Steuerurkunde, 1:1 zum Return.
    try {
      useCreditNoteStore.getState().createCreditNote({
        invoiceId: r.invoiceId,
        customerId: r.customerId,
        salesReturnId: r.id,
        totalAmount: r.totalAmount,
        vatAmount: r.vatCorrected || 0,
        cashRefundAmount: cashRefundCap,
        receivableCancelAmount: receivableCancel,
        refundMethod: r.refundMethod,
        reason: r.reason,
        notes: r.notes,
      });
    } catch (e) {
      console.warn('[Return] credit note auto-creation failed:', e);
      throw new Error(`Approve failed: credit note could not be created — ${e instanceof Error ? e.message : String(e)}`);
    }

    // VAT-Korrektur auf Invoice — CN ist die Steuerurkunde, die VAT-Pflicht reversiert.
    // Voll, nicht proportional zu Cash (Receivable-Cancel reversiert ebenfalls VAT).
    if ((r.vatCorrected || 0) > 0) {
      db.run(
        `UPDATE invoices SET vat_amount = MAX(0, vat_amount - ?), updated_at = ? WHERE id = ?`,
        [r.vatCorrected || 0, now, r.invoiceId]
      );
    }

    // Plan 2026-05: Umsatz/Profit korrigieren — Customer-LTV reduzieren.
    // Profit-Anteil proportional zur retournierten Quote der Original-Invoice.
    const invRow = query('SELECT margin_snapshot, gross_amount FROM invoices WHERE id = ?', [r.invoiceId])[0];
    const invGross = (invRow?.gross_amount as number) || 0;
    const invMargin = (invRow?.margin_snapshot as number) || 0;
    const profitDelta = invGross > 0 ? invMargin * (r.totalAmount / invGross) : 0;
    db.run(
      `UPDATE customers SET
         total_revenue = MAX(0, total_revenue - ?),
         total_profit = total_profit - ?,
         updated_at = ?
       WHERE id = ?`,
      [r.totalAmount, profitDelta, now, r.customerId]
    );

    // Nach CN-Erstellung: wenn effektives Invoice-Outstanding (gross - paid - Σ CN.cancel) = 0,
    // Invoice auf RETURNED setzen (Forderung vollständig durch Return abgedeckt).
    try {
      const invCheck = query(
        `SELECT i.gross_amount, i.paid_amount,
                COALESCE((SELECT SUM(cn.receivable_cancel_amount) FROM credit_notes cn WHERE cn.invoice_id = i.id), 0) AS cn_cancel
         FROM invoices i WHERE i.id = ?`,
        [r.invoiceId]
      )[0];
      if (invCheck) {
        const gross = (invCheck.gross_amount as number) || 0;
        const paid  = (invCheck.paid_amount as number)  || 0;
        const cancel= (invCheck.cn_cancel as number)    || 0;
        if (gross > 0 && (gross - paid - cancel) <= 0.005) {
          db.run(
            `UPDATE invoices SET status = 'RETURNED', updated_at = ? WHERE id = ? AND status IN ('PARTIAL', 'DRAFT')`,
            [now, r.invoiceId]
          );
        }
      }
    } catch (e) {
      console.warn('[Return] invoice status update check failed:', e);
    }

    db.run(`UPDATE sales_returns SET status = 'APPROVED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('sales_returns', id, r.status, 'APPROVED');
    get().loadReturns();
  },

  // ── Reject ───────────────────────────────────────────────
  // Nur erlaubt vor Approval (keine CN ausgestellt). Disposition wird best-effort revertiert.
  rejectReturn: (id) => {
    const r = get().getReturn(id);
    if (!r) return;
    if (r.status === 'APPROVED' || r.status === 'REFUNDED' || r.status === 'CLOSED') {
      console.warn('[Return] cannot reject after approval — use deleteReturn instead');
      throw new Error('Cannot reject a return that has been approved. Use delete instead.');
    }
    const db = getDatabase();
    const now = new Date().toISOString();
    // Disposition revertieren (Ware war beim Anlegen schon umgebucht).
    revertDisposition(db, r.lines, r.productDisposition || 'IN_STOCK', now);
    db.run(`UPDATE sales_returns SET status = 'REJECTED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('sales_returns', id, r.status, 'REJECTED');
    get().loadReturns();
  },

  // ── Refund (convenience wrapper) ─────────────────────────
  // Plan 2026-05: Ruft approveReturn (idempotent) + recordRefundPayment(cap) auf.
  // KEIN eigener CN-Code mehr.
  refundReturn: (id, partialAmount) => {
    const r = get().getReturn(id);
    if (!r) return;
    if (r.refundStatus === 'REFUNDED') { console.warn('[Return] already fully refunded'); return; }

    // 1) Approve (idempotent — erstellt CN + reduziert VAT, falls noch nicht passiert).
    if (r.status === 'REQUESTED') {
      get().approveReturn(id);
    }
    const r2 = get().getReturn(id);
    if (!r2) return;

    // 2) Cap berechnen — wieviel Cash kann tatsächlich zurückfließen.
    const { cashRefundCap } = computeRefundSplit(id, r2.invoiceId, r2.totalAmount);
    const remainingCashRefundable = Math.max(0, cashRefundCap - (r2.refundPaidAmount || 0));
    const requestedAmount = typeof partialAmount === 'number' && partialAmount >= 0 && partialAmount <= r2.totalAmount
      ? partialAmount
      : r2.totalAmount;
    const refundAmount = Math.min(requestedAmount, remainingCashRefundable);

    // 3a) Cash fließt → recordRefundPayment.
    if (refundAmount > 0) {
      get().recordRefundPayment(id, refundAmount, r2.refundMethod || 'cash');
      return;
    }

    // 3b) Kein Cash refundbar (Customer hat noch nichts gezahlt) → CN ist ausreichend,
    // Return-Status auf REFUNDED (nichts mehr zu tun aus Buchhaltungssicht).
    const db = getDatabase();
    db.run(`UPDATE sales_returns SET status = 'REFUNDED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('sales_returns', id, r2.status, 'REFUNDED');
    get().loadReturns();
  },

  // ── Record Refund Payment ────────────────────────────────
  // Cash fließt tatsächlich → Banking ↓, refund_paid_amount ↑, CN-Split-Update.
  // Auto-approve, falls noch REQUESTED, damit CN garantiert existiert wenn Geld bewegt wird.
  recordRefundPayment: (returnId, amount, method, date) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Refund payment amount must be a positive number.');
    }
    const db = getDatabase();
    let r = get().getReturn(returnId);
    if (!r) return;
    if (r.refundStatus === 'REFUNDED') { console.warn('[Return] already fully refunded'); return; }

    // Auto-approve falls noch REQUESTED — CN muss existieren bevor Cash fließt.
    if (r.status === 'REQUESTED') {
      get().approveReturn(returnId);
      r = get().getReturn(returnId);
      if (!r) return;
    }

    const remaining = Math.max(0, r.totalAmount - (r.refundPaidAmount || 0));
    if (remaining <= 0.005) { console.warn('[Return] nothing left to refund'); return; }

    // Cap: Cash-Refundability laut Industriestandard (Customer-Surplus nach allen Returns).
    const { cashRefundCap } = computeRefundSplit(returnId, r.invoiceId, r.totalAmount);
    const refundableNow = Math.max(0, cashRefundCap - (r.refundPaidAmount || 0));
    const cappedAmount = Math.min(amount, refundableNow, remaining);

    if (cappedAmount <= 0) {
      console.warn('[Return] no cash refundable now — customer surplus exhausted');
      return;
    }

    const newPaid = (r.refundPaidAmount || 0) + cappedAmount;
    const newRefundStatus: RefundStatus = newPaid >= r.totalAmount - 0.005 ? 'REFUNDED'
      : newPaid > 0 ? 'PARTIALLY_REFUNDED'
      : 'PENDING_REFUND';
    // Voll erstattet → Return-Status auch auf REFUNDED.
    const newReturnStatus = newRefundStatus === 'REFUNDED' ? 'REFUNDED' : r.status;

    const now = new Date().toISOString();
    const refundDate = date || now.split('T')[0];

    db.run(
      `UPDATE sales_returns SET refund_paid_amount = ?, refund_paid_date = ?,
        refund_method = ?, refund_status = ?, status = ?,
        refund_amount = MAX(refund_amount, ?) WHERE id = ?`,
      [newPaid, refundDate, method, newRefundStatus, newReturnStatus, newPaid, returnId]
    );

    if (cappedAmount > 0 && method !== 'credit') {
      trackRefund('sales_returns', returnId, cappedAmount, method);
    }
    saveDatabase();
    trackUpdate('sales_returns', returnId, { refundPayment: cappedAmount, method, date: refundDate, status: newRefundStatus });

    // CN-Sync: cashRefund/receivableCancel-Split nachziehen.
    try {
      const cnRows = query(
        `SELECT id, total_amount FROM credit_notes WHERE sales_return_id = ? LIMIT 1`,
        [returnId]
      );
      if (cnRows.length > 0) {
        const cnId = cnRows[0].id as string;
        const cnTotal = (cnRows[0].total_amount as number) || 0;
        const newCancel = Math.max(0, cnTotal - newPaid);
        db.run(
          `UPDATE credit_notes SET cash_refund_amount = ?, receivable_cancel_amount = ?, refund_method = COALESCE(?, refund_method) WHERE id = ?`,
          [newPaid, newCancel, method, cnId]
        );
        saveDatabase();
        trackUpdate('credit_notes', cnId, { cashRefundAmount: newPaid, receivableCancelAmount: newCancel });
        useCreditNoteStore.getState().loadCreditNotes();
      }
    } catch (e) {
      console.warn('[Return] credit note update failed:', e);
    }

    // Invoice RETURNED setzen, wenn Forderung durch Cash + CN-Cancel vollständig gedeckt.
    try {
      const invCheck = query(
        `SELECT i.gross_amount, i.paid_amount, i.status AS inv_status,
                COALESCE((SELECT SUM(cn.receivable_cancel_amount) FROM credit_notes cn WHERE cn.invoice_id = i.id), 0) AS cn_cancel
         FROM invoices i WHERE i.id = ?`,
        [r.invoiceId]
      )[0];
      if (invCheck && (invCheck.inv_status === 'PARTIAL' || invCheck.inv_status === 'DRAFT')) {
        const gross = (invCheck.gross_amount as number) || 0;
        const paid  = (invCheck.paid_amount as number)  || 0;
        const cancel= (invCheck.cn_cancel as number)    || 0;
        if (gross > 0 && (gross - paid - cancel) <= 0.005) {
          db.run(
            `UPDATE invoices SET status = 'RETURNED', updated_at = ? WHERE id = ?`,
            [now, r.invoiceId]
          );
        }
      }
    } catch (e) {
      console.warn('[Return] invoice status update check (recordRefundPayment) failed:', e);
    }

    if (newReturnStatus !== r.status) {
      trackStatusChange('sales_returns', returnId, r.status, newReturnStatus);
    }
    get().loadReturns();
  },

  // ── Delete ───────────────────────────────────────────────
  // Vollständiges Rollback: Disposition revert, VAT zurück, CN löschen.
  deleteReturn: (id) => {
    const db = getDatabase();
    const r = get().getReturn(id);
    if (!r) return;
    const now = new Date().toISOString();

    // Disposition revertieren (außer wenn schon rejected — dann war's bereits revertiert).
    if (r.status !== 'REJECTED') {
      revertDisposition(db, r.lines, r.productDisposition || 'IN_STOCK', now);
    }

    // VAT restoren (wenn Approve passierte — vat_corrected wurde abgezogen).
    const wasApproved = r.status === 'APPROVED' || r.status === 'REFUNDED' || r.status === 'CLOSED';
    const vatToRestore = wasApproved ? Number(r.vatCorrected || 0) : 0;
    if (vatToRestore > 0) {
      db.run(
        `UPDATE invoices SET vat_amount = vat_amount + ?, updated_at = ? WHERE id = ?`,
        [vatToRestore, now, r.invoiceId]
      );
    }
    // Customer-LTV restaurieren — analog zur Reduktion in approveReturn.
    if (wasApproved) {
      const invRow = query('SELECT margin_snapshot, gross_amount FROM invoices WHERE id = ?', [r.invoiceId])[0];
      const invGross = (invRow?.gross_amount as number) || 0;
      const invMargin = (invRow?.margin_snapshot as number) || 0;
      const profitDelta = invGross > 0 ? invMargin * (r.totalAmount / invGross) : 0;
      db.run(
        `UPDATE customers SET
           total_revenue = total_revenue + ?,
           total_profit = total_profit + ?,
           updated_at = ?
         WHERE id = ?`,
        [r.totalAmount, profitDelta, now, r.customerId]
      );
    }

    // Verknüpfte Credit-Note(s) löschen — Cascade.
    const cnRows = query(`SELECT id FROM credit_notes WHERE sales_return_id = ?`, [id]);
    for (const cn of cnRows) {
      trackDelete('credit_notes', cn.id as string);
    }
    db.run(`DELETE FROM credit_notes WHERE sales_return_id = ?`, [id]);
    db.run(`DELETE FROM sales_return_lines WHERE return_id = ?`, [id]);
    db.run(`DELETE FROM sales_returns WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('sales_returns', id);
    get().loadReturns();
    try { useCreditNoteStore.getState().loadCreditNotes(); } catch { /* */ }
  },

  // ── Aggregations (unverändert — Reports lesen hier) ─────
  getInvoiceReturnSummary: (invoiceId, invoiceGross, invoicePaid) => {
    const returns = get().returns.filter(r => r.invoiceId === invoiceId && r.status !== 'REJECTED');
    const totalReturned = returns.reduce((s, r) => s + (r.totalAmount || 0), 0);
    const totalRefundPaid = returns.reduce((s, r) => s + (r.refundPaidAmount || 0), 0);

    let outstandingRefund: number;
    if (typeof invoicePaid === 'number') {
      const owedAfterReturns = Math.max(0, invoiceGross - totalReturned);
      const cashRefundable = Math.max(0, invoicePaid - owedAfterReturns);
      outstandingRefund = Math.max(0, cashRefundable - totalRefundPaid);
    } else {
      outstandingRefund = Math.max(0, totalReturned - totalRefundPaid);
    }

    let returnState: 'NONE' | 'PARTIAL_RETURN' | 'RETURNED';
    if (returns.length === 0) {
      returnState = 'NONE';
    } else {
      try {
        const lineRows = query(
          `SELECT il.id, il.quantity AS orig_qty,
                  COALESCE((
                    SELECT SUM(srl.quantity)
                    FROM sales_return_lines srl
                    JOIN sales_returns sr ON sr.id = srl.return_id
                    WHERE srl.invoice_line_id = il.id AND sr.status != 'REJECTED'
                  ), 0) AS returned_qty
           FROM invoice_lines il
           WHERE il.invoice_id = ?`,
          [invoiceId]
        );
        const totalLines = lineRows.length;
        const fullyReturnedLines = lineRows.filter(r =>
          Number(r.returned_qty || 0) >= Number(r.orig_qty || 0) - 0.005
        ).length;
        if (totalLines === 0) {
          returnState = 'NONE';
        } else if (fullyReturnedLines === totalLines) {
          returnState = 'RETURNED';
        } else {
          returnState = 'PARTIAL_RETURN';
        }
      } catch {
        returnState = totalReturned >= invoiceGross - 0.005 ? 'RETURNED' : 'PARTIAL_RETURN';
      }
    }

    let refundState: RefundStatus;
    if (totalReturned === 0) {
      refundState = 'PENDING_REFUND';
    } else if (typeof invoicePaid === 'number') {
      const owedAfterReturns = Math.max(0, invoiceGross - totalReturned);
      const cashRefundable = Math.max(0, invoicePaid - owedAfterReturns);
      if (cashRefundable < 0.01) refundState = 'REFUNDED';
      else if (totalRefundPaid >= cashRefundable - 0.01) refundState = 'REFUNDED';
      else if (totalRefundPaid > 0) refundState = 'PARTIALLY_REFUNDED';
      else refundState = 'PENDING_REFUND';
    } else {
      refundState = totalRefundPaid >= totalReturned - 0.005 ? 'REFUNDED'
        : totalRefundPaid > 0 ? 'PARTIALLY_REFUNDED'
        : 'PENDING_REFUND';
    }
    return { returns, totalReturned, totalRefundPaid, outstandingRefund, returnState, refundState };
  },

  getCustomerRefundPayable: (customerId) => {
    return get().returns
      .filter(r => r.customerId === customerId && r.status !== 'REJECTED')
      .reduce((sum, r) => sum + Math.max(0, (r.refundAmount || 0) - (r.refundPaidAmount || 0)), 0);
  },

  getReturnedQtyForLine: (invoiceLineId) => {
    let qty = 0;
    for (const r of get().returns) {
      if (r.status === 'REJECTED') continue;
      for (const l of r.lines) {
        if (l.invoiceLineId === invoiceLineId) qty += l.quantity || 1;
      }
    }
    return qty;
  },
}));
