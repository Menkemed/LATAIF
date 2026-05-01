// ═══════════════════════════════════════════════════════════
// LATAIF — Sales Returns (Plan §Returns)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { SalesReturn, SalesReturnLine, SalesReturnStatus, RefundStatus, ProductDisposition } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackStatusChange, trackRefund, trackDelete } from '@/core/sync/track';
import { useCreditNoteStore } from '@/stores/creditNoteStore';

// Plan §Returns §History (Round 4):
//  - Bei Refund wird invoice.paid_amount NICHT mehr reduziert — bleibt historisch („Kunde hat gezahlt").
//  - Auto-Cancel ist entfernt: Status bleibt FINAL/PARTIAL, returnState='RETURNED' wird über
//    getInvoiceReturnSummary geliefert und in der UI als „Returned"-Badge angezeigt.
//  - CANCELLED ist nur noch für explizite User-Stornos.

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
  // invoicePaid wird benötigt damit Outstanding Refund die tatsächliche Cash-Rückzahlbarkeit kennt.
  getInvoiceReturnSummary: (invoiceId: string, invoiceGross: number, invoicePaid?: number) => {
    returns: SalesReturn[];
    totalReturned: number;        // Geschuldete Rückzahlung gesamt
    totalRefundPaid: number;      // Schon zurückgezahlt gesamt
    outstandingRefund: number;    // Noch offen ans Customer (CASH only)
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
    if (!input.lines || input.lines.length === 0) {
      throw new Error('Return must include at least one line.');
    }
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    // Look up invoice for customer_id and invoice details
    const invRows = query('SELECT customer_id FROM invoices WHERE id = ?', [input.invoiceId]);
    const customerId = invRows[0]?.customer_id as string;

    // Cap pro Linie: keine Return-Quantity > Original-Invoice-Line-Quantity − bereits zurückgegeben.
    // Plus: Beträge müssen positiv sein.
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

    // Industry-Standard (SAP/Xero/QuickBooks): Cash-Refund nur soweit der Kunde
    // mehr gezahlt hat als er nach dem Return noch schuldet.
    //   cashRefund = max(0, customerPaid − (invoiceGross − sumOfAllReturns))
    // Bereits andere Returns auf derselben Invoice werden mitgezählt — sonst doppelte Refunds.
    const invRow = query('SELECT paid_amount, gross_amount FROM invoices WHERE id = ?', [r.invoiceId])[0];
    const customerPaid = (invRow?.paid_amount as number) || 0;
    const invoiceGross = (invRow?.gross_amount as number) || 0;

    const otherReturnsRow = query(
      `SELECT COALESCE(SUM(total_amount), 0) AS s
       FROM sales_returns
       WHERE invoice_id = ? AND id != ? AND status != 'REJECTED'`,
      [r.invoiceId, id]
    )[0];
    const otherReturnsTotal = (otherReturnsRow?.s as number) || 0;
    const otherRefundsRow = query(
      `SELECT COALESCE(SUM(refund_paid_amount), 0) AS s
       FROM sales_returns
       WHERE invoice_id = ? AND id != ? AND status != 'REJECTED'`,
      [r.invoiceId, id]
    )[0];
    const otherRefundsAlreadyPaid = (otherRefundsRow?.s as number) || 0;

    // Industriestandard: nach allen Returns verbleibender Schuldbetrag.
    const owedAfterAllReturns = Math.max(0, invoiceGross - otherReturnsTotal - r.totalAmount);
    // Surplus = was Customer mehr gezahlt hat als er noch schuldet, abzüglich bereits zurückgezahlter Refunds anderer Returns.
    const surplus = Math.max(0, customerPaid - owedAfterAllReturns - otherRefundsAlreadyPaid);
    const cap = Math.min(r.totalAmount, surplus);

    // partialAmount erlaubt manuelle Über-Steuerung, aber NIE über Cap.
    const requestedAmount = typeof partialAmount === 'number' && partialAmount >= 0 && partialAmount <= r.totalAmount
      ? partialAmount
      : r.totalAmount;
    const refundAmount = Math.min(requestedAmount, cap);
    if (refundAmount < requestedAmount) {
      console.info(`[Return] cash refund capped at ${refundAmount} (paid=${customerPaid}, gross=${invoiceGross}, other returns=${otherReturnsTotal}, this return=${r.totalAmount})`);
    }
    // Refund-Status berechnen: vollständig vs. teilweise.
    const newRefundStatus: RefundStatus = refundAmount >= r.totalAmount - 0.005 ? 'REFUNDED'
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

    // Plan §Returns §11: VAT-Korrektur auf Invoice-Ebene.
    // VAT-Delta proportional zum tatsächlich refundeten Anteil. Bei Vollrefund: Delta = vatCorrected;
    // bei 50% Refund: 50% von vatCorrected.
    // Plan §Returns §History: paid_amount BLEIBT historisch — wir reduzieren ihn NICHT mehr.
    // Begründung: „Kunde hat gezahlt" bleibt sichtbar; der Refund ist eine eigene Cash-Out-Bewegung
    // (refund_paid_amount auf sales_return / Credit Note). Banking-Saldo nutzt
    // payments + sales_returns.refund_paid_amount → bleibt korrekt.
    const refundRatio = r.totalAmount > 0 ? Math.min(1, refundAmount / r.totalAmount) : 0;
    const invoiceVatDelta = (r.vatCorrected || 0) * refundRatio;
    db.run(
      `UPDATE invoices SET
         vat_amount = MAX(0, vat_amount - ?),
         updated_at = ?
       WHERE id = ?`,
      [invoiceVatDelta, now, r.invoiceId]
    );

    saveDatabase();
    trackStatusChange('sales_returns', id, r.status, 'REFUNDED');

    // Industry Standard: jeder bestätigte Sales Return erzeugt eine Credit Note (Storno-Rechnung).
    // CN ist eigenständige Steuerurkunde — verlinkt zur Invoice + zum Return.
    // Splitting: Cash-Refund (was zurückfließt) vs Forderungsstornierung (was nur als offen wegfällt).
    try {
      const receivableCancel = Math.max(0, r.totalAmount - refundAmount);
      useCreditNoteStore.getState().createCreditNote({
        invoiceId: r.invoiceId,
        customerId: r.customerId,
        salesReturnId: r.id,
        totalAmount: r.totalAmount,
        vatAmount: r.vatCorrected || 0,
        cashRefundAmount: refundAmount,
        receivableCancelAmount: receivableCancel,
        refundMethod: r.refundMethod,
        reason: r.reason,
        notes: r.notes,
      });
    } catch (e) {
      console.warn('[Return] credit note auto-creation failed:', e);
    }

    get().loadReturns();
    // Plan §Returns §History: kein Auto-Cancel mehr — Invoice-Status bleibt FINAL/PARTIAL,
    // returnState='RETURNED' wird über getInvoiceReturnSummary an die UI gegeben und dort
    // als „Returned"-Badge angezeigt. CANCELLED ist nur für explizite User-Stornos.
  },

  deleteReturn: (id) => {
    const db = getDatabase();
    const r = get().getReturn(id);
    if (!r) return;
    const now = new Date().toISOString();
    // Plan §Returns §History: paid_amount wird in refundReturn nicht mehr reduziert (historisch).
    // → kein Paid-Revert nötig. NUR vat_amount wurde reduziert → den müssen wir bei delete restorieren.
    const refundedCash = Number(r.refundPaidAmount || 0);
    const vatReverted  = Math.min(Number(r.vatCorrected || 0), refundedCash);
    if (r.status === 'REFUNDED' && vatReverted > 0) {
      db.run(
        `UPDATE invoices SET
           vat_amount  = vat_amount  + ?,
           updated_at  = ?
         WHERE id = ?`,
        [vatReverted, now, r.invoiceId]
      );
    }
    // Verknüpfte Credit-Note löschen (cascade) — Industriestandard: CN gehört zum Return.
    // Ergänzung Issue I: Cascade-Delete im Audit-Log spurbar machen.
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
    // CN-Store ebenfalls neu laden, damit UI keine Phantom-CN zeigt.
    try { useCreditNoteStore.getState().loadCreditNotes(); } catch { /* */ }
  },

  // Partielle Refund-Zahlung dokumentieren — kann mehrfach aufgerufen werden,
  // bis refund_paid_amount = total_amount.
  recordRefundPayment: (returnId, amount, method, date) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Refund payment amount must be a positive number.');
    }
    const db = getDatabase();
    const r = get().getReturn(returnId);
    if (!r) return;
    // Plan §Returns Fix E — kein Doppel-Refund wenn bereits voll erstattet.
    if (r.refundStatus === 'REFUNDED') { console.warn('[Return] already fully refunded'); return; }
    const remaining = Math.max(0, r.totalAmount - (r.refundPaidAmount || 0));
    // Float-Tolerance 0.005 BHD (3-Dezimal-Präzision).
    if (remaining <= 0.005) { console.warn('[Return] nothing left to refund'); return; }
    const newPaid = Math.min(r.totalAmount, (r.refundPaidAmount || 0) + amount);
    const newStatus: RefundStatus = newPaid >= r.totalAmount - 0.005 ? 'REFUNDED'
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

    // Auto-Sync der zugehörigen Credit Note: cashRefundAmount + receivableCancelAmount
    // werden nachträglich aktualisiert wenn ein Refund-Payment dazukommt.
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

    get().loadReturns();
    // Plan §Returns §History: kein Auto-Cancel — Invoice-Status bleibt FINAL/PARTIAL.
  },

  // Aggregiert alle Returns einer Invoice + Status-Berechnung (live).
  getInvoiceReturnSummary: (invoiceId, invoiceGross, invoicePaid) => {
    const returns = get().returns.filter(r => r.invoiceId === invoiceId && r.status !== 'REJECTED');
    const totalReturned = returns.reduce((s, r) => s + (r.totalAmount || 0), 0);
    const totalRefundPaid = returns.reduce((s, r) => s + (r.refundPaidAmount || 0), 0);

    // Industriestandard: Cash-Outstanding-Refund = nur was Customer überzahlt hat,
    // abzüglich was wir bereits zurückgezahlt haben. Wenn Customer nichts gezahlt hat
    // (oder weniger als der nach-Returns-verbleibende Schuldbetrag) → kein Cash zurück nötig.
    // Falls invoicePaid nicht übergeben wurde, fallback auf alte Formel (Backwards-Compat).
    let outstandingRefund: number;
    if (typeof invoicePaid === 'number') {
      const owedAfterReturns = Math.max(0, invoiceGross - totalReturned);
      const cashRefundable = Math.max(0, invoicePaid - owedAfterReturns);
      outstandingRefund = Math.max(0, cashRefundable - totalRefundPaid);
    } else {
      outstandingRefund = Math.max(0, totalReturned - totalRefundPaid);
    }

    // returnState per-line statt SUM(total) — sonst kassiert ein Doppel-Return
    // dieselbe Line zweimal und meldet die ganze Invoice als 'RETURNED' während andere
    // Lines noch nicht zurück sind. Vergleich: ALLE invoice_lines müssen vollständig
    // zurückgegeben sein (returned_qty >= original_qty).
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
        // Fallback wenn SQL fehlschlägt: Sum-basierte Heuristik (alt).
        returnState = totalReturned >= invoiceGross - 0.005 ? 'RETURNED' : 'PARTIAL_RETURN';
      }
    }
    // Refund-State berücksichtigt Cash-Refundability: wenn nichts zurückzuzahlen ist, gilt als REFUNDED.
    let refundState: RefundStatus;
    if (totalReturned === 0) {
      refundState = 'NOT_REFUNDED';
    } else if (typeof invoicePaid === 'number') {
      const owedAfterReturns = Math.max(0, invoiceGross - totalReturned);
      const cashRefundable = Math.max(0, invoicePaid - owedAfterReturns);
      if (cashRefundable < 0.01) refundState = 'REFUNDED';                 // nichts zurückzuzahlen → settled
      else if (totalRefundPaid >= cashRefundable - 0.01) refundState = 'REFUNDED';
      else if (totalRefundPaid > 0) refundState = 'PARTIALLY_REFUNDED';
      else refundState = 'NOT_REFUNDED';
    } else {
      refundState = totalRefundPaid >= totalReturned - 0.005 ? 'REFUNDED'
        : totalRefundPaid > 0 ? 'PARTIALLY_REFUNDED'
        : 'NOT_REFUNDED';
    }
    return { returns, totalReturned, totalRefundPaid, outstandingRefund, returnState, refundState };
  },

  // Pro Customer offene Refund-Schuld (Refund Payable an Kunden) live.
  // Nutzt refundAmount (gecappter Cash-Anteil) — NICHT totalAmount, sonst würde via
  // Credit Note neutralisierte Forderung als „Cash-Schuld" gezählt.
  getCustomerRefundPayable: (customerId) => {
    return get().returns
      .filter(r => r.customerId === customerId && r.status !== 'REJECTED')
      .reduce((sum, r) => sum + Math.max(0, (r.refundAmount || 0) - (r.refundPaidAmount || 0)), 0);
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
