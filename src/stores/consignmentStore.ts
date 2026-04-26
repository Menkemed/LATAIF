import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Consignment, ConsignmentStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface ConsignmentStore {
  consignments: Consignment[];
  loading: boolean;
  loadConsignments: () => void;
  getConsignment: (id: string) => Consignment | undefined;
  createConsignment: (data: Partial<Consignment> & { productData?: Record<string, unknown> }) => Consignment;
  updateConsignment: (id: string, data: Partial<Consignment>) => void;
  markSold: (id: string, salePrice: number, buyerId?: string, saleMethod?: 'cash' | 'bank') => void;
  markPaidOut: (id: string, method: string, reference?: string) => void;
  // Plan §8 #2 — Partial Payouts. Akkumuliert bis payoutAmount erreicht ist.
  recordPartialPayout: (id: string, amount: number, method: string, reference?: string) => void;
  markReturned: (id: string) => void;
  // Plan §Commission §13: Return nach Verkauf (Endkunde bringt zurück).
  // Option A: RETURN_TO_OWNER (Ware verlässt System), Option B: KEEP_AS_OWN (wird eigene Ware).
  markReturnedAfterSale: (id: string, disposition: 'RETURN_TO_OWNER' | 'KEEP_AS_OWN') => void;
  deleteConsignment: (id: string) => void;
}

function rowToConsignment(row: Record<string, unknown>): Consignment {
  return {
    id: row.id as string,
    consignmentNumber: row.consignment_number as string,
    consignorId: row.consignor_id as string,
    productId: row.product_id as string,
    agreedPrice: (row.agreed_price as number) || 0,
    minimumPrice: row.minimum_price as number | undefined,
    commissionType: (row.commission_type as 'percent' | 'fixed' | 'consignor_fixed' | undefined) || 'percent',
    commissionValue: row.commission_value as number | undefined,
    commissionRate: (row.commission_rate as number) || 15,
    commissionAmount: row.commission_amount as number | undefined,
    payoutAmount: row.payout_amount as number | undefined,
    payoutPaidAmount: (row.payout_paid_amount as number) || 0,
    payoutStatus: (row.payout_status as Consignment['payoutStatus']) || 'pending',
    payoutMethod: row.payout_method as string | undefined,
    saleMethod: (row.sale_method as 'cash' | 'bank' | null) ?? null,
    payoutDate: row.payout_date as string | undefined,
    payoutReference: row.payout_reference as string | undefined,
    status: (row.status as ConsignmentStatus) || 'active',
    agreementDate: row.agreement_date as string,
    expiryDate: row.expiry_date as string | undefined,
    salePrice: row.sale_price as number | undefined,
    buyerId: row.buyer_id as string | undefined,
    invoiceId: row.invoice_id as string | undefined,
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useConsignmentStore = create<ConsignmentStore>((set, get) => ({
  consignments: [],
  loading: false,

  loadConsignments: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM consignments WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      set({ consignments: rows.map(rowToConsignment), loading: false });
    } catch { set({ consignments: [], loading: false }); }
  },

  getConsignment: (id) => get().consignments.find(c => c.id === id),

  createConsignment: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const consignmentNumber = getNextNumber('consignments', 'consignment.number_prefix', 'CON');

    // Update product status to consignment
    if (data.productId) {
      // Plan §Commission §4: source_type = CONSIGNMENT beim Intake
      db.run(`UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT', updated_at = ? WHERE id = ?`, [now, data.productId]);
    }

    db.run(
      `INSERT INTO consignments (id, branch_id, consignment_number, consignor_id, product_id,
        agreed_price, minimum_price, commission_rate, commission_type, commission_value,
        status, agreement_date, expiry_date,
        notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      [id, branchId, consignmentNumber, data.consignorId, data.productId,
       data.agreedPrice || 0, data.minimumPrice || null,
       data.commissionRate || 15,
       data.commissionType || 'percent',
       data.commissionValue ?? null,
       data.agreementDate || now.split('T')[0], data.expiryDate || null,
       data.notes || null, now, now, userId]
    );

    saveDatabase();
    trackInsert('consignments', id, { consignmentNumber, consignorId: data.consignorId });
    eventBus.emit('consignment.created', 'consignment', id, { consignorId: data.consignorId });
    get().loadConsignments();
    return get().getConsignment(id)!;
  },

  updateConsignment: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      consignorId: 'consignor_id', agreedPrice: 'agreed_price', minimumPrice: 'minimum_price',
      commissionRate: 'commission_rate', commissionType: 'commission_type', commissionValue: 'commission_value',
      expiryDate: 'expiry_date', notes: 'notes',
      status: 'status', salePrice: 'sale_price', commissionAmount: 'commission_amount',
      payoutAmount: 'payout_amount', payoutStatus: 'payout_status',
      payoutPaidAmount: 'payout_paid_amount',
      payoutMethod: 'payout_method', payoutDate: 'payout_date', payoutReference: 'payout_reference',
      saleMethod: 'sale_method',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE consignments SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('consignments', id, data);
    get().loadConsignments();
  },

  markSold: (id, salePrice, buyerId, saleMethod) => {
    const con = get().getConsignment(id);
    if (!con) return;
    let payout: number;
    let commission: number;
    if (con.commissionType === 'consignor_fixed') {
      payout = con.commissionValue || 0;
      commission = salePrice - payout;
    } else if (con.commissionType === 'fixed') {
      commission = con.commissionValue || 0;
      payout = salePrice - commission;
    } else {
      commission = salePrice * (con.commissionRate / 100);
      payout = salePrice - commission;
    }
    get().updateConsignment(id, {
      status: 'sold', salePrice, buyerId,
      commissionAmount: commission, payoutAmount: payout,
      saleMethod: saleMethod ?? null,
    });
    // Update product — quantity-aware.
    const db = getDatabase();
    db.run(
      `UPDATE products SET
         quantity = CASE WHEN COALESCE(quantity,1) > 1 THEN COALESCE(quantity,1) - 1 ELSE 0 END,
         stock_status = CASE WHEN COALESCE(quantity,1) > 1 THEN stock_status ELSE 'sold' END,
         updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), con.productId]);
    saveDatabase();
    eventBus.emit('consignment.sold', 'consignment', id, { salePrice, commission, payout });
  },

  markPaidOut: (id, method, reference) => {
    const con = get().getConsignment(id);
    const full = con?.payoutAmount || 0;
    get().updateConsignment(id, {
      status: 'paid_out', payoutStatus: 'paid',
      payoutPaidAmount: full,
      payoutMethod: method, payoutDate: new Date().toISOString().split('T')[0],
      payoutReference: reference,
    });
    eventBus.emit('consignment.paid_out', 'consignment', id, {});
  },

  // Plan §8 #2 — Teilausgleich. Mehrfach aufrufbar bis payoutAmount erreicht.
  recordPartialPayout: (id, amount, method, reference) => {
    const con = get().getConsignment(id);
    if (!con || amount <= 0) return;
    const target = con.payoutAmount || 0;
    const newPaid = target > 0 ? Math.min(target, (con.payoutPaidAmount || 0) + amount) : (con.payoutPaidAmount || 0) + amount;
    const fully = target > 0 && newPaid >= target - 0.001;
    const newPayoutStatus: Consignment['payoutStatus'] = fully ? 'paid' : (newPaid > 0 ? 'partial' : 'pending');
    const newStatus = fully ? 'paid_out' : con.status;
    get().updateConsignment(id, {
      status: newStatus,
      payoutStatus: newPayoutStatus,
      payoutPaidAmount: newPaid,
      payoutMethod: method,
      payoutDate: new Date().toISOString().split('T')[0],
      payoutReference: reference,
    });
    if (fully) eventBus.emit('consignment.paid_out', 'consignment', id, {});
  },

  markReturned: (id) => {
    const con = get().getConsignment(id);
    if (!con) return;
    const db = getDatabase();
    // Plan §Commission §12: Ware NICHT verkauft → zurück an Besitzer.
    // Produkt verlässt System (stock_status = returned).
    db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), con.productId]);
    // Status-String bleibt lowercase 'returned' für Backward-Compat zu UI-Filtern.
    get().updateConsignment(id, { status: 'returned', payoutStatus: 'returned' });
    saveDatabase();
    eventBus.emit('consignment.returned', 'consignment', id, {});
  },

  // Plan §Commission §13: Endkunde bringt Ware zurück (nach Verkauf).
  // Erstellt automatisch einen Sales Return (RET) für die ursprüngliche Rechnung mit der gewählten Disposition.
  markReturnedAfterSale: (id, disposition) => {
    const con = get().getConsignment(id);
    if (!con) return;
    const db = getDatabase();
    const now = new Date().toISOString();

    if (!con.invoiceId || !con.salePrice) {
      // Kein Invoice verknüpft oder noch nicht verkauft — Fallback auf normale Rückgabe
      get().markReturned(id);
      return;
    }

    // Finde die Invoice-Line für dieses Produkt
    const lineRows = query(
      `SELECT id, unit_price, vat_amount FROM invoice_lines WHERE invoice_id = ? AND product_id = ?`,
      [con.invoiceId, con.productId]
    );
    if (lineRows.length === 0) {
      get().markReturned(id);
      return;
    }

    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const invRows = query('SELECT customer_id FROM invoices WHERE id = ?', [con.invoiceId]);
    const customerId = invRows[0]?.customer_id as string;

    // Return-Nummer
    const returnNumber = `RET-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const returnId = uuid();
    const totalAmount = lineRows.reduce((s, l) => s + ((l.unit_price as number) || 0), 0);
    const vatCorrected = lineRows.reduce((s, l) => s + ((l.vat_amount as number) || 0), 0);

    db.run(
      `INSERT INTO sales_returns (id, branch_id, return_number, invoice_id, customer_id, status, total_amount,
        vat_corrected, return_date, refund_method, refund_amount, product_disposition, notes, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'REFUNDED', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [returnId, branchId, returnNumber, con.invoiceId, customerId, totalAmount, vatCorrected,
       now.split('T')[0], null, disposition,
       `Consignment post-sale return (${con.consignmentNumber})`, now, userId]
    );

    for (const l of lineRows) {
      db.run(
        `INSERT INTO sales_return_lines (id, return_id, invoice_line_id, product_id, quantity, unit_price, vat_amount, line_total)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        [uuid(), returnId, l.id as string, con.productId, (l.unit_price as number) || 0,
         (l.vat_amount as number) || 0, (l.unit_price as number) || 0]
      );
    }

    // Produkt-Disposition
    if (disposition === 'RETURN_TO_OWNER') {
      db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`, [now, con.productId]);
      get().updateConsignment(id, { status: 'returned' });
    } else {
      // KEEP_AS_OWN: purchase_price = sale_price (Plan §13B)
      db.run(
        `UPDATE products SET stock_status = 'in_stock', source_type = 'OWN',
         purchase_price = COALESCE(?, purchase_price), updated_at = ? WHERE id = ?`,
        [con.salePrice ?? null, now, con.productId]
      );
      get().updateConsignment(id, { status: 'returned' });
    }

    // Invoice-Korrektur (paid_amount, vat_amount reduzieren)
    db.run(
      `UPDATE invoices SET
         paid_amount = MAX(0, paid_amount - ?),
         vat_amount = MAX(0, vat_amount - ?),
         updated_at = ?
       WHERE id = ?`,
      [totalAmount, vatCorrected, now, con.invoiceId]
    );

    saveDatabase();
    trackInsert('sales_returns', returnId, { returnNumber, invoiceId: con.invoiceId, consignmentId: id, disposition });
    eventBus.emit('consignment.returned', 'consignment', id, { disposition, returnId });
  },

  deleteConsignment: (id) => {
    const db = getDatabase();
    const con = get().getConsignment(id);
    if (con && con.status === 'active') {
      db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), con.productId]);
    }
    db.run(`DELETE FROM consignments WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('consignments', id);
    get().loadConsignments();
  },
}));
