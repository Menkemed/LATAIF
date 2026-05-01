// ═══════════════════════════════════════════════════════════
// LATAIF — Credit Notes (Storno-Rechnungen)
// Industry Standard: jeder Sales Return → 1 Credit Note (CN-YYYY-NNNNN).
// Eigenständige Steuerurkunde mit eigener Page + PDF + History-Verlinkung.
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { CreditNote } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackDelete } from '@/core/sync/track';

interface CreditNoteStore {
  creditNotes: CreditNote[];
  loading: boolean;
  loadCreditNotes: () => void;
  getCreditNote: (id: string) => CreditNote | undefined;
  getCreditNotesForInvoice: (invoiceId: string) => CreditNote[];
  getCreditNotesForCustomer: (customerId: string) => CreditNote[];
  /**
   * Auto-creation by salesReturnStore. Splits the return total into:
   *  - cashRefundAmount = min(totalAmount, customerPaidOnInvoice)
   *  - receivableCancelAmount = totalAmount - cashRefund
   */
  createCreditNote: (input: {
    invoiceId: string;
    customerId: string;
    salesReturnId?: string;
    totalAmount: number;
    vatAmount: number;
    cashRefundAmount: number;
    receivableCancelAmount: number;
    refundMethod?: 'cash' | 'bank' | 'card' | 'credit' | 'other';
    reason?: string;
    notes?: string;
    issuedAt?: string;
  }) => CreditNote;
  deleteCreditNote: (id: string) => void;
}

function rowToCN(row: Record<string, unknown>): CreditNote {
  return {
    id: row.id as string,
    creditNoteNumber: row.credit_note_number as string,
    branchId: row.branch_id as string,
    invoiceId: row.invoice_id as string,
    salesReturnId: (row.sales_return_id as string | undefined) || undefined,
    customerId: row.customer_id as string,
    issuedAt: row.issued_at as string,
    totalAmount: (row.total_amount as number) || 0,
    vatAmount: (row.vat_amount as number) || 0,
    cashRefundAmount: (row.cash_refund_amount as number) || 0,
    receivableCancelAmount: (row.receivable_cancel_amount as number) || 0,
    refundMethod: (row.refund_method as CreditNote['refundMethod']) || undefined,
    reason: (row.reason as string | undefined) || undefined,
    notes: (row.notes as string | undefined) || undefined,
    createdAt: row.created_at as string,
    createdBy: (row.created_by as string | undefined) || undefined,
  };
}

export const useCreditNoteStore = create<CreditNoteStore>((set, get) => ({
  creditNotes: [],
  loading: false,

  loadCreditNotes: () => {
    try {
      set({ loading: true });
      const branchId = currentBranchId();
      const rows = query(
        'SELECT * FROM credit_notes WHERE branch_id = ? ORDER BY issued_at DESC, created_at DESC',
        [branchId]
      );
      set({ creditNotes: rows.map(rowToCN), loading: false });
    } catch {
      set({ creditNotes: [], loading: false });
    }
  },

  getCreditNote: (id) => get().creditNotes.find(cn => cn.id === id),
  getCreditNotesForInvoice: (invoiceId) => get().creditNotes.filter(cn => cn.invoiceId === invoiceId),
  getCreditNotesForCustomer: (customerId) => get().creditNotes.filter(cn => cn.customerId === customerId),

  createCreditNote: (input) => {
    // Plausibilität: Beträge nicht-negativ, Summe = Total (Invariant für Buchhaltung).
    if (!Number.isFinite(input.totalAmount) || input.totalAmount < 0) {
      throw new Error('Credit note total must be non-negative.');
    }
    if (input.cashRefundAmount < 0 || input.receivableCancelAmount < 0) {
      throw new Error('Credit note components must be non-negative.');
    }
    const sumComponents = (input.cashRefundAmount || 0) + (input.receivableCancelAmount || 0);
    if (Math.abs(sumComponents - input.totalAmount) > 0.005) {
      throw new Error(`Credit note components (${sumComponents.toFixed(3)}) must equal total (${input.totalAmount.toFixed(3)}).`);
    }
    // CN-Summe (kumulativ inkl. existierender CNs für diese Invoice) darf Invoice-Brutto nicht überschreiten.
    // Sonst entsteht Phantom-Refund wenn mehrere Returns auf einer Invoice CNs erzeugen.
    const invRow = query('SELECT gross_amount FROM invoices WHERE id = ?', [input.invoiceId])[0];
    const invGross = (invRow?.gross_amount as number) || 0;
    if (invGross > 0) {
      const existingRow = query(
        'SELECT COALESCE(SUM(total_amount), 0) AS s FROM credit_notes WHERE invoice_id = ?',
        [input.invoiceId]
      )[0];
      const existingTotal = Number(existingRow?.s || 0);
      const wouldBe = existingTotal + input.totalAmount;
      if (wouldBe > invGross + 0.005) {
        throw new Error(
          `Credit notes for this invoice (${wouldBe.toFixed(3)}) would exceed invoice gross (${invGross.toFixed(3)}). Existing CNs: ${existingTotal.toFixed(3)}.`
        );
      }
    }

    const db = getDatabase();
    const branchId = currentBranchId();
    let userId: string | null = null;
    try { userId = currentUserId(); } catch { /* user might not be loaded */ }
    const id = uuid();
    const number = getNextDocumentNumber('CN');
    const now = new Date().toISOString();
    const issuedAt = input.issuedAt || now.split('T')[0];

    db.run(
      `INSERT INTO credit_notes (
         id, branch_id, credit_note_number, invoice_id, sales_return_id, customer_id,
         issued_at, total_amount, vat_amount, cash_refund_amount, receivable_cancel_amount,
         refund_method, reason, notes, created_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, branchId, number, input.invoiceId, input.salesReturnId || null, input.customerId,
        issuedAt, input.totalAmount, input.vatAmount, input.cashRefundAmount, input.receivableCancelAmount,
        input.refundMethod || null, input.reason || null, input.notes || null, now, userId,
      ]
    );
    saveDatabase();

    trackInsert('credit_notes', id, {
      creditNoteNumber: number, invoiceId: input.invoiceId, totalAmount: input.totalAmount,
    });

    const cn: CreditNote = {
      id, creditNoteNumber: number, branchId,
      invoiceId: input.invoiceId, salesReturnId: input.salesReturnId,
      customerId: input.customerId, issuedAt,
      totalAmount: input.totalAmount, vatAmount: input.vatAmount,
      cashRefundAmount: input.cashRefundAmount, receivableCancelAmount: input.receivableCancelAmount,
      refundMethod: input.refundMethod, reason: input.reason, notes: input.notes,
      createdAt: now, createdBy: userId || undefined,
    };
    set(state => ({ creditNotes: [cn, ...state.creditNotes] }));
    return cn;
  },

  deleteCreditNote: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM credit_notes WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('credit_notes', id);
    set(state => ({ creditNotes: state.creditNotes.filter(cn => cn.id !== id) }));
  },
}));
