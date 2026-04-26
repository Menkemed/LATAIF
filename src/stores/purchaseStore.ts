// ═══════════════════════════════════════════════════════════
// LATAIF — Purchase Store (Plan §Purchases + §Purchase Returns)
// ═══════════════════════════════════════════════════════════
//
// Regeln (Plan §5, §14, §17):
//  - Ware kommt IMMER ins Inventar (egal ob bezahlt oder nicht)
//  - Payable = total_amount − paid_amount
//  - Status: DRAFT | UNPAID | PARTIALLY_PAID | PAID | CANCELLED
//  - Teilzahlungen erlaubt, Status wird automatisch aktualisiert

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Purchase, PurchaseLine, PurchasePayment, PurchaseStatus, PurchaseReturn, PurchaseReturnLine, PurchaseReturnStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackDelete, trackStatusChange, trackPayment, trackRefund } from '@/core/sync/track';

interface PurchaseInput {
  supplierId: string;
  purchaseDate?: string;
  notes?: string;
  lines: Array<{
    productId?: string;       // if omitted → new product is created
    newProductBrand?: string; // required if productId not set
    newProductName?: string;  // required if productId not set
    newProductCategoryId?: string;
    newProductSku?: string;
    description?: string;
    quantity: number;
    unitPrice: number;
  }>;
  initialPayment?: { amount: number; method: 'cash' | 'bank'; reference?: string };
}

interface PurchaseStore {
  purchases: Purchase[];
  returns: PurchaseReturn[];
  loading: boolean;
  loadPurchases: () => void;
  loadReturns: () => void;
  getPurchase: (id: string) => Purchase | undefined;
  getReturn: (id: string) => PurchaseReturn | undefined;
  createPurchase: (input: PurchaseInput) => Purchase;
  addPayment: (purchaseId: string, amount: number, method: 'cash' | 'bank' | 'credit', reference?: string, note?: string) => void;
  cancelPurchase: (id: string) => void;
  deletePurchase: (id: string) => void;
  // Returns
  createReturn: (input: {
    purchaseId: string;
    returnDate?: string;
    refundMethod?: 'cash' | 'bank' | 'credit';
    notes?: string;
    lines: Array<{ purchaseLineId: string; productId?: string; quantity: number; unitPrice: number }>;
  }) => PurchaseReturn;
  confirmReturn: (id: string) => void;
  completeReturn: (id: string) => void;
  cancelReturn: (id: string) => void;
  deleteReturn: (id: string) => void;
}

function rowToPurchase(row: Record<string, unknown>): Purchase {
  return {
    id: row.id as string,
    purchaseNumber: row.purchase_number as string,
    branchId: row.branch_id as string,
    supplierId: row.supplier_id as string,
    status: (row.status as PurchaseStatus) || 'DRAFT',
    totalAmount: (row.total_amount as number) || 0,
    paidAmount: (row.paid_amount as number) || 0,
    remainingAmount: (row.remaining_amount as number) || 0,
    purchaseDate: row.purchase_date as string,
    notes: row.notes as string | undefined,
    lines: [],
    payments: [],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToLine(row: Record<string, unknown>): PurchaseLine {
  return {
    id: row.id as string,
    purchaseId: row.purchase_id as string,
    productId: row.product_id as string | undefined,
    description: row.description as string | undefined,
    quantity: (row.quantity as number) || 1,
    unitPrice: (row.unit_price as number) || 0,
    lineTotal: (row.line_total as number) || 0,
    position: (row.position as number) || 0,
  };
}

function rowToPayment(row: Record<string, unknown>): PurchasePayment {
  return {
    id: row.id as string,
    purchaseId: row.purchase_id as string,
    amount: (row.amount as number) || 0,
    method: (row.method as 'cash' | 'bank') || 'cash',
    paidAt: row.paid_at as string,
    reference: row.reference as string | undefined,
    note: row.note as string | undefined,
    createdAt: row.created_at as string,
  };
}

function rowToReturn(row: Record<string, unknown>): PurchaseReturn {
  return {
    id: row.id as string,
    returnNumber: row.return_number as string,
    branchId: row.branch_id as string,
    purchaseId: row.purchase_id as string,
    supplierId: row.supplier_id as string,
    status: (row.status as PurchaseReturnStatus) || 'DRAFT',
    totalAmount: (row.total_amount as number) || 0,
    returnDate: row.return_date as string,
    refundMethod: row.refund_method as 'cash' | 'bank' | 'credit' | undefined,
    refundAmount: (row.refund_amount as number) || 0,
    notes: row.notes as string | undefined,
    lines: [],
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToReturnLine(row: Record<string, unknown>): PurchaseReturnLine {
  return {
    id: row.id as string,
    returnId: row.return_id as string,
    purchaseLineId: row.purchase_line_id as string | undefined,
    productId: row.product_id as string | undefined,
    quantity: (row.quantity as number) || 1,
    unitPrice: (row.unit_price as number) || 0,
    lineTotal: (row.line_total as number) || 0,
  };
}

function computeStatus(total: number, paid: number, cancelled = false): PurchaseStatus {
  if (cancelled) return 'CANCELLED';
  if (total <= 0) return 'DRAFT';
  if (paid <= 0) return 'UNPAID';
  if (paid >= total) return 'PAID';
  return 'PARTIALLY_PAID';
}

export const usePurchaseStore = create<PurchaseStore>((set, get) => ({
  purchases: [],
  returns: [],
  loading: false,

  loadPurchases: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM purchases WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      const list: Purchase[] = rows.map(r => {
        const p = rowToPurchase(r);
        const lineRows = query('SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [p.id]);
        p.lines = lineRows.map(rowToLine);
        const payRows = query('SELECT * FROM purchase_payments WHERE purchase_id = ? ORDER BY paid_at ASC, created_at ASC', [p.id]);
        p.payments = payRows.map(rowToPayment);
        return p;
      });
      set({ purchases: list, loading: false });
    } catch { set({ purchases: [], loading: false }); }
  },

  loadReturns: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM purchase_returns WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      const list: PurchaseReturn[] = rows.map(r => {
        const pr = rowToReturn(r);
        const lineRows = query('SELECT * FROM purchase_return_lines WHERE return_id = ?', [pr.id]);
        pr.lines = lineRows.map(rowToReturnLine);
        return pr;
      });
      set({ returns: list });
    } catch { set({ returns: [] }); }
  },

  getPurchase: (id) => get().purchases.find(p => p.id === id),
  getReturn: (id) => get().returns.find(r => r.id === id),

  createPurchase: (input) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const purchaseNumber = getNextDocumentNumber('PUR');
    const purchaseDate = input.purchaseDate || now.split('T')[0];

    // Create or link products for each line and build line records.
    // Plan §5: Ware kommt IMMER ins Inventar, product_status = IN_STOCK, source_type = OWN
    const lineRecords: Array<{ id: string; productId: string; description: string | null; qty: number; unitPrice: number; lineTotal: number; position: number }> = [];
    let total = 0;
    input.lines.forEach((ln, idx) => {
      let productId = ln.productId;
      if (!productId) {
        // Create a new product
        productId = uuid();
        const pNow = new Date().toISOString();
        db.run(
          `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
            purchase_date, purchase_price, purchase_currency, stock_status, tax_scheme, expected_margin, days_in_stock,
            supplier_name, notes, images, attributes, created_at, updated_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'BHD', 'in_stock', 'MARGIN', NULL, 0, NULL, ?, '[]', '{}', ?, ?, ?)`,
          [productId, branchId, ln.newProductCategoryId || 'cat-watches', ln.newProductBrand || '', ln.newProductName || '',
           ln.newProductSku || null, '', purchaseDate, ln.unitPrice, ln.description || null, pNow, pNow, userId]
        );
      }
      const lineTotal = ln.quantity * ln.unitPrice;
      total += lineTotal;
      const lineId = uuid();
      lineRecords.push({
        id: lineId, productId, description: ln.description || null,
        qty: ln.quantity, unitPrice: ln.unitPrice, lineTotal, position: idx + 1,
      });
    });

    // Insert purchase header (status UNPAID unless initial payment covers)
    const status: PurchaseStatus = computeStatus(total, input.initialPayment?.amount || 0);
    const paid = input.initialPayment?.amount || 0;
    db.run(
      `INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status, total_amount, paid_amount, remaining_amount,
        purchase_date, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, purchaseNumber, input.supplierId, status, total, paid, total - paid,
       purchaseDate, input.notes || null, now, now, userId]
    );

    // Insert lines
    const lineStmt = db.prepare(
      `INSERT INTO purchase_lines (id, purchase_id, product_id, description, quantity, unit_price, line_total, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lineRecords) {
      lineStmt.run([l.id, id, l.productId, l.description, l.qty, l.unitPrice, l.lineTotal, l.position]);
    }
    lineStmt.free();

    // Initial payment (if any)
    if (input.initialPayment && input.initialPayment.amount > 0) {
      db.run(
        `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), id, input.initialPayment.amount, input.initialPayment.method, purchaseDate, input.initialPayment.reference || null, null, now]
      );
      trackPayment('purchases', id, input.initialPayment.amount, input.initialPayment.method);
    }

    saveDatabase();
    trackInsert('purchases', id, { purchaseNumber, supplierId: input.supplierId, total });
    get().loadPurchases();
    return get().getPurchase(id)!;
  },

  addPayment: (purchaseId, amount, method, reference, note) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const p = get().getPurchase(purchaseId);
    if (!p) return;
    if (p.status === 'CANCELLED') return;

    db.run(
      `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), purchaseId, amount, method, now.split('T')[0], reference || null, note || null, now]
    );
    const newPaid = p.paidAmount + amount;
    const newStatus = computeStatus(p.totalAmount, newPaid);
    db.run(
      `UPDATE purchases SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newPaid, Math.max(0, p.totalAmount - newPaid), newStatus, now, purchaseId]
    );
    saveDatabase();
    trackPayment('purchases', purchaseId, amount, method);
    if (newStatus !== p.status) trackStatusChange('purchases', purchaseId, p.status, newStatus);
    get().loadPurchases();
  },

  cancelPurchase: (id) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const p = get().getPurchase(id);
    if (!p) return;
    db.run(`UPDATE purchases SET status = 'CANCELLED', updated_at = ? WHERE id = ?`, [now, id]);
    saveDatabase();
    trackStatusChange('purchases', id, p.status, 'CANCELLED');
    get().loadPurchases();
  },

  deletePurchase: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM purchases WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('purchases', id);
    get().loadPurchases();
  },

  // ── Purchase Returns (Plan §Purchase Returns) ──

  createReturn: (input) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    const purchase = get().getPurchase(input.purchaseId);
    if (!purchase) throw new Error('Purchase not found');
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const returnNumber = getNextDocumentNumber('PRET');
    const returnDate = input.returnDate || now.split('T')[0];
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);

    db.run(
      `INSERT INTO purchase_returns (id, branch_id, return_number, purchase_id, supplier_id, status, total_amount,
        return_date, refund_method, refund_amount, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, 0, ?, ?, ?)`,
      [id, branchId, returnNumber, input.purchaseId, purchase.supplierId, total, returnDate,
       input.refundMethod || null, input.notes || null, now, userId]
    );

    const stmt = db.prepare(
      `INSERT INTO purchase_return_lines (id, return_id, purchase_line_id, product_id, quantity, unit_price, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of input.lines) {
      stmt.run([uuid(), id, l.purchaseLineId, l.productId || null, l.quantity, l.unitPrice, l.quantity * l.unitPrice]);
    }
    stmt.free();

    saveDatabase();
    trackInsert('purchase_returns', id, { returnNumber, purchaseId: input.purchaseId, total });
    get().loadReturns();
    return get().getReturn(id)!;
  },

  // Confirm = perform the effects: reduce inventory + payable
  confirmReturn: (id) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const ret = get().getReturn(id);
    if (!ret || ret.status !== 'DRAFT') return;
    const purchase = get().getPurchase(ret.purchaseId);
    if (!purchase) return;

    // Plan §7 + §8: Payable reduzieren ODER Refund
    //  - wenn noch offen (remaining > 0): erst aus remaining runterziehen
    //  - wenn mehr als remaining: Rest als Refund (Cash/Bank ↑)
    let remainingPayable = purchase.remainingAmount;
    let refundAmount = 0;
    if (remainingPayable >= ret.totalAmount) {
      remainingPayable -= ret.totalAmount;
    } else {
      refundAmount = ret.totalAmount - remainingPayable;
      remainingPayable = 0;
    }
    const newTotal = Math.max(0, purchase.totalAmount - ret.totalAmount);
    const newPaid = Math.max(0, purchase.paidAmount - refundAmount);
    const newStatus = computeStatus(newTotal, newPaid, purchase.status === 'CANCELLED');

    db.run(
      `UPDATE purchases SET total_amount = ?, paid_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?`,
      [newTotal, newPaid, remainingPayable, newStatus, now, purchase.id]
    );

    // Remove returned products from inventory (Plan §6 Inventarlogik — Ware wird entfernt oder angepasst)
    for (const line of ret.lines) {
      if (line.productId) {
        db.run(`UPDATE products SET stock_status = 'sold', updated_at = ? WHERE id = ?`, [now, line.productId]);
      }
    }

    // Plan §Purchase Returns §9: DRAFT → CONFIRMED → COMPLETED.
    // COMPLETED wenn: kein Refund nötig (alles aus Payable) ODER Refund direkt via Cash/Bank abgewickelt.
    // Bleibt CONFIRMED wenn refundMethod='credit' (Credit muss extern/später abgewickelt werden).
    const finalStatus: 'CONFIRMED' | 'COMPLETED' =
      (refundAmount === 0 || (ret.refundMethod && ret.refundMethod !== 'credit')) ? 'COMPLETED' : 'CONFIRMED';

    db.run(
      `UPDATE purchase_returns SET status = ?, refund_amount = ? WHERE id = ?`,
      [finalStatus, refundAmount, id]
    );
    if (refundAmount > 0 && ret.refundMethod && ret.refundMethod !== 'credit') {
      trackRefund('purchase_returns', id, refundAmount, ret.refundMethod);
    }

    // Plan §8 #3 — Supplier-Credit Ledger. Bei refundMethod='credit' + refundAmount > 0
    // wird ein offenes Guthaben beim Lieferanten gebucht (gegen zukünftige Käufe verrechenbar).
    if (refundAmount > 0 && ret.refundMethod === 'credit' && purchase.supplierId) {
      let branchId: string, userId: string;
      try { branchId = currentBranchId(); userId = currentUserId(); }
      catch { branchId = 'branch-main'; userId = 'user-owner'; }
      const creditId = uuid();
      db.run(
        `INSERT INTO supplier_credits (id, branch_id, supplier_id, source_return_id, source_purchase_id,
           amount, used_amount, status, note, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
        [creditId, branchId, purchase.supplierId, id, purchase.id, refundAmount,
         `Credit aus Return ${ret.returnNumber || id.slice(0, 8)}`, now, userId]
      );
      trackInsert('supplier_credits', creditId, { supplierId: purchase.supplierId, amount: refundAmount });
    }

    saveDatabase();
    trackStatusChange('purchase_returns', id, 'DRAFT', finalStatus);
    get().loadPurchases();
    get().loadReturns();
  },

  // Plan §Purchase Returns §9: manuelle Transition CONFIRMED → COMPLETED (z.B. nach Credit-Abwicklung).
  completeReturn: (id) => {
    const db = getDatabase();
    const ret = get().getReturn(id);
    if (!ret || ret.status !== 'CONFIRMED') return;
    db.run(`UPDATE purchase_returns SET status = 'COMPLETED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('purchase_returns', id, 'CONFIRMED', 'COMPLETED');
    get().loadReturns();
  },

  cancelReturn: (id) => {
    const db = getDatabase();
    const ret = get().getReturn(id);
    if (!ret) return;
    db.run(`UPDATE purchase_returns SET status = 'CANCELLED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('purchase_returns', id, ret.status, 'CANCELLED');
    get().loadReturns();
  },

  deleteReturn: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM purchase_returns WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('purchase_returns', id);
    get().loadReturns();
  },
}));
