// ═══════════════════════════════════════════════════════════
// LATAIF — Sales Returns (Plan §Returns)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { SalesReturn, SalesReturnLine, SalesReturnStatus, RefundStatus, ProductDisposition } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackStatusChange, trackRefund, trackDelete } from '@/core/sync/track';

// Plan §Returns §Auto: wenn eine Invoice voll zurückgegeben UND voll erstattet ist → Status CANCELLED.
// Teilrückgaben oder offene Refund-Zahlungen lassen den Status (FINAL/PARTIAL) unberührt —
// UI zeigt dort die PARTIAL_RETURN / RETURNED Badges getrennt vom Zahlungsstatus.
function reconcileInvoiceAfterReturn(invoiceId: string): void {
  try {
    const db = getDatabase();
    const invRows = query(`SELECT gross_amount, status FROM invoices WHERE id = ?`, [invoiceId]);
    if (invRows.length === 0) return;
    const gross = (invRows[0].gross_amount as number) || 0;
    const currentStatus = invRows[0].status as string;
    if (currentStatus === 'CANCELLED' || gross <= 0) return;

    const sumRows = query(
      `SELECT COALESCE(SUM(total_amount), 0) AS t,
              COALESCE(SUM(refund_paid_amount), 0) AS p
         FROM sales_returns
         WHERE invoice_id = ? AND status != 'REJECTED'`,
      [invoiceId]
    );
    const totalReturned = (sumRows[0]?.t as number) || 0;
    const totalRefundPaid = (sumRows[0]?.p as number) || 0;
    const fullyReturned = totalReturned >= gross - 0.001;
    const fullyRefunded = totalRefundPaid >= totalReturned - 0.001;
    if (fullyReturned && fullyRefunded) {
      const now = new Date().toISOString();
      db.run(`UPDATE invoices SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, [now, invoiceId]);
      saveDatabase();
      trackStatusChange('invoices', invoiceId, currentStatus, 'CANCELLED');
    }
  } catch { /* ignore */ }
}

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
  // Tracking partieller Refund-Zahlungen — separate Aktion vom Return selbst.
  recordRefundPayment: (returnId: string, amount: number, method: 'cash' | 'bank' | 'card' | 'credit' | 'other', date?: string) => void;
  deleteReturn: (id: string) => void;
  // Live-Aggregation aller Returns einer Invoice + Status-Berechnung.
  getInvoiceReturnSummary: (invoiceId: string, invoiceGross: number) => {
    returns: SalesReturn[];
    totalReturned: number;        // Geschuldete Rückzahlung gesamt
    totalRefundPaid: number;      // Schon zurückgezahlt gesamt
    outstandingRefund: number;    // Noch offen ans Customer
    returnState: 'NONE' | 'PARTIAL_RETURN' | 'RETURNED';
    refundState: RefundStatus;
  };
  // Pro Customer offene Refund-Schuld (Refund Payable).
  getCustomerRefundPayable: (customerId: string) => number;
  getReturnedQtyForLine: (invoiceLineId: string) => number;
}

function rowToReturn(row: Record<string, unknown>): SalesReturn {
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
    refundMethod: row.refund_method as 'cash' | 'bank' | 'card' | 'credit' | 'other' | 'other' | undefined,
    refundAmount: (row.refund_amount as number) || 0,
    refundPaidAmount: (row.refund_paid_amount as number) || 0,
    refundPaidDate: (row.refund_paid_date as string | null) || undefined,
    refundStatus: (row.refund_status as RefundStatus) || 'NOT_REFUNDED',
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

  createReturn: (input) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    // Look up invoice for customer_id and invoice details
    const invRows = query('SELECT customer_id FROM invoices WHERE id = ?', [input.invoiceId]);
    const customerId = invRows[0]?.customer_id as string;

    const returnNumber = getNextDocumentNumber('RET');
    const returnDate = input.returnDate || now.split('T')[0];
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const vatCorrected = input.lines.reduce((s, l) => s + l.vatAmount, 0);

    db.run(
      `INSERT INTO sales_returns (id, branch_id, return_number, invoice_id, customer_id, status, total_amount,
        vat_corrected, return_date, refund_method, refund_amount, refund_paid_amount, refund_status,
        product_disposition, reason, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, 0, 0, 'NOT_REFUNDED', ?, ?, ?, ?, ?)`,
      [id, branchId, returnNumber, input.invoiceId, customerId, total, vatCorrected, returnDate,
       input.refundMethod || null, input.productDisposition || null,
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

    saveDatabase();
    trackInsert('sales_returns', id, { returnNumber, invoiceId: input.invoiceId, total });
    get().loadReturns();
    return get().getReturn(id)!;
  },

  approveReturn: (id) => {
    const db = getDatabase();
    const r = get().getReturn(id);
    if (!r) return;
    db.run(`UPDATE sales_returns SET status = 'APPROVED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('sales_returns', id, r.status, 'APPROVED');
    get().loadReturns();
  },

  rejectReturn: (id) => {
    const db = getDatabase();
    const r = get().getReturn(id);
    if (!r) return;
    db.run(`UPDATE sales_returns SET status = 'REJECTED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('sales_returns', id, r.status, 'REJECTED');
    get().loadReturns();
  },

  refundReturn: (id, partialAmount) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const r = get().getReturn(id);
    if (!r || r.status !== 'APPROVED' && r.status !== 'REQUESTED') return;
    // Plan §Returns Fix E — kein Doppel-Refund.
    if (r.refundStatus === 'REFUNDED') { console.warn('[Return] already fully refunded'); return; }

    // Plan §Returns §9: Teilrückerstattung erlaubt (refund < totalAmount).
    // Wird partialAmount übergeben → verwenden; sonst voller Betrag.
    const refundAmount = typeof partialAmount === 'number' && partialAmount >= 0 && partialAmount <= r.totalAmount
      ? partialAmount
      : r.totalAmount;
    // Refund-Status berechnen: vollständig vs. teilweise.
    const newRefundStatus: RefundStatus = refundAmount >= r.totalAmount - 0.001 ? 'REFUNDED'
      : refundAmount > 0 ? 'PARTIALLY_REFUNDED'
      : 'NOT_REFUNDED';
    db.run(
      `UPDATE sales_returns SET status = 'REFUNDED', refund_amount = ?,
        refund_paid_amount = ?, refund_paid_date = ?, refund_status = ? WHERE id = ?`,
      [refundAmount, refundAmount, now.split('T')[0], newRefundStatus, id]
    );

    // Plan §Returns §6 + §Commission §13: Product disposition.
    const disposition = r.productDisposition || 'IN_STOCK';
    for (const line of r.lines) {
      if (!line.productId) continue;

      if (disposition === 'RETURN_TO_OWNER') {
        // Plan §Commission §13 A: Ware verlässt dein System → Consignment auf RETURNED_TO_OWNER,
        // Produkt auf RETURNED (aus Inventar entfernt).
        db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`, [now, line.productId]);
        db.run(
          `UPDATE consignments SET status = 'RETURNED_TO_OWNER', updated_at = ?
           WHERE product_id = ? AND status IN ('sold','SOLD','paid_out','active','IN_STOCK')`,
          [now, line.productId]
        );
      } else if (disposition === 'KEEP_AS_OWN') {
        // Plan §Commission §13 B: bleibt bei dir → source_type → OWN, Status in_stock.
        // Neuer purchase_price = letzter Verkaufspreis (wie in der returned line).
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
        // Quantity-aware Restock: gibt die zurückgegebene Menge ans Lager zurück.
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
          : disposition === 'WRITE_OFF' ? 'sold' /* keep sold but flagged in notes */
          : 'in_stock';
        db.run(`UPDATE products SET stock_status = ?, updated_at = ? WHERE id = ?`, [newStatus, now, line.productId]);
      }
    }

    if (refundAmount > 0 && r.refundMethod) {
      trackRefund('sales_returns', id, refundAmount, r.refundMethod);
    }

    // Plan §Returns §10 + §11: Steuerkorrektur auf Invoice-Ebene.
    // Die sichtbare VAT auf der Invoice wird um vat_corrected reduziert; paid_amount ebenfalls reduziert
    // um den tatsächlichen Refund. Invoice-Status wird NICHT zurückgesetzt (Return bleibt eigenes Dokument).
    const invoiceVatDelta = Math.min(r.vatCorrected || 0, refundAmount); // defensiv
    db.run(
      `UPDATE invoices SET
         paid_amount = MAX(0, paid_amount - ?),
         vat_amount = MAX(0, vat_amount - ?),
         updated_at = ?
       WHERE id = ?`,
      [refundAmount, invoiceVatDelta, now, r.invoiceId]
    );

    saveDatabase();
    trackStatusChange('sales_returns', id, r.status, 'REFUNDED');
    get().loadReturns();
    // Plan §Returns §Auto: voll zurückgegeben + voll erstattet → Invoice auf CANCELLED.
    reconcileInvoiceAfterReturn(r.invoiceId);
  },

  deleteReturn: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM sales_returns WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('sales_returns', id);
    get().loadReturns();
  },

  // Partielle Refund-Zahlung dokumentieren — kann mehrfach aufgerufen werden,
  // bis refund_paid_amount = total_amount.
  recordRefundPayment: (returnId, amount, method, date) => {
    const db = getDatabase();
    const r = get().getReturn(returnId);
    if (!r || amount <= 0) return;
    // Plan §Returns Fix E — kein Doppel-Refund wenn bereits voll erstattet.
    if (r.refundStatus === 'REFUNDED') { console.warn('[Return] already fully refunded'); return; }
    const remaining = Math.max(0, r.totalAmount - (r.refundPaidAmount || 0));
    if (remaining <= 0.001) { console.warn('[Return] nothing left to refund'); return; }
    const newPaid = Math.min(r.totalAmount, (r.refundPaidAmount || 0) + amount);
    const newStatus: RefundStatus = newPaid >= r.totalAmount - 0.001 ? 'REFUNDED'
      : newPaid > 0 ? 'PARTIALLY_REFUNDED'
      : 'NOT_REFUNDED';
    const refundDate = date || new Date().toISOString().split('T')[0];
    db.run(
      `UPDATE sales_returns SET refund_paid_amount = ?, refund_paid_date = ?,
        refund_method = ?, refund_status = ? WHERE id = ?`,
      [newPaid, refundDate, method, newStatus, returnId]
    );
    if (amount > 0 && method !== 'credit') {
      trackRefund('sales_returns', returnId, amount, method);
    }
    saveDatabase();
    trackUpdate('sales_returns', returnId, { refundPayment: amount, method, date: refundDate, status: newStatus });
    get().loadReturns();
    // Plan §Returns §Auto: nach Zahlung prüfen ob Invoice voll zurück+erstattet → CANCELLED.
    reconcileInvoiceAfterReturn(r.invoiceId);
  },

  // Aggregiert alle Returns einer Invoice + Status-Berechnung (live).
  getInvoiceReturnSummary: (invoiceId, invoiceGross) => {
    const returns = get().returns.filter(r => r.invoiceId === invoiceId && r.status !== 'REJECTED');
    const totalReturned = returns.reduce((s, r) => s + (r.totalAmount || 0), 0);
    const totalRefundPaid = returns.reduce((s, r) => s + (r.refundPaidAmount || 0), 0);
    const outstandingRefund = Math.max(0, totalReturned - totalRefundPaid);
    const returnState: 'NONE' | 'PARTIAL_RETURN' | 'RETURNED' =
      returns.length === 0 ? 'NONE'
      : totalReturned >= invoiceGross - 0.001 ? 'RETURNED'
      : 'PARTIAL_RETURN';
    const refundState: RefundStatus =
      totalReturned === 0 ? 'NOT_REFUNDED'
      : totalRefundPaid >= totalReturned - 0.001 ? 'REFUNDED'
      : totalRefundPaid > 0 ? 'PARTIALLY_REFUNDED'
      : 'NOT_REFUNDED';
    return { returns, totalReturned, totalRefundPaid, outstandingRefund, returnState, refundState };
  },

  // Pro Customer offene Refund-Schuld (Refund Payable an Kunden) live.
  getCustomerRefundPayable: (customerId) => {
    return get().returns
      .filter(r => r.customerId === customerId && r.status !== 'REJECTED')
      .reduce((sum, r) => sum + Math.max(0, (r.totalAmount || 0) - (r.refundPaidAmount || 0)), 0);
  },

  // Aggregiert die retournierte Menge pro invoice_line (über alle Returns).
  // Wird für Line-Item-Markierung in InvoiceDetail genutzt.
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
