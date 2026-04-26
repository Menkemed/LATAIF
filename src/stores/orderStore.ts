import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Order, OrderStatus, OrderLine } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface OrderStore {
  orders: Order[];
  loading: boolean;
  loadOrders: () => void;
  getOrder: (id: string) => Order | undefined;
  createOrder: (data: Partial<Omit<Order, 'lines'>> & { lines?: Array<Omit<OrderLine, 'id' | 'orderId' | 'lineTotal' | 'position'>> }) => Order;
  updateOrder: (id: string, data: Partial<Order>) => void;
  updateStatus: (id: string, status: OrderStatus) => void;
  deleteOrder: (id: string) => void;
  // Lines per Order
  rewriteOrderLines: (orderId: string, lines: Array<{ productId?: string; description: string; quantity: number; unitPrice: number }>) => void;
  getOrderLines: (orderId: string) => OrderLine[];
}

function rowToOrder(row: Record<string, unknown>): Order {
  let attrs: Record<string, string | number | boolean | string[]> = {};
  try { attrs = JSON.parse((row.attributes as string) || '{}'); } catch { /* */ }
  return {
    id: row.id as string,
    orderNumber: row.order_number as string,
    customerId: row.customer_id as string,
    categoryId: (row.category_id as string | null) || undefined,
    attributes: attrs,
    condition: (row.condition as string | null) || undefined,
    serialNumber: (row.serial_number as string | null) || undefined,
    existingProductId: (row.existing_product_id as string | null) || undefined,
    requestedBrand: row.requested_brand as string,
    requestedModel: row.requested_model as string,
    requestedReference: row.requested_reference as string | undefined,
    requestedDetails: row.requested_details as string | undefined,
    taxAmount: (row.tax_amount as number) || 0,
    paymentMethod: (row.payment_method as 'cash' | 'bank' | 'card' | undefined) || undefined,
    fullyPaid: Number(row.fully_paid) === 1,
    agreedPrice: row.agreed_price as number | undefined,
    depositAmount: (row.deposit_amount as number) || 0,
    depositPaid: row.deposit_paid === 1,
    depositDate: row.deposit_date as string | undefined,
    remainingAmount: row.remaining_amount as number | undefined,
    supplierName: row.supplier_name as string | undefined,
    supplierPrice: row.supplier_price as number | undefined,
    expectedMargin: row.expected_margin as number | undefined,
    expectedDelivery: row.expected_delivery as string | undefined,
    actualDelivery: row.actual_delivery as string | undefined,
    status: (row.status as OrderStatus) || 'pending',
    productId: row.product_id as string | undefined,
    invoiceId: row.invoice_id as string | undefined,
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useOrderStore = create<OrderStore>((set, get) => ({
  orders: [],
  loading: false,

  loadOrders: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM orders WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      set({ orders: rows.map(rowToOrder), loading: false });
    } catch { set({ orders: [], loading: false }); }
  },

  getOrder: (id) => get().orders.find(o => o.id === id),

  createOrder: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const orderNumber = getNextNumber('orders', 'order.number_prefix', 'ORD');

    const remaining = (data.agreedPrice || 0) - (data.depositAmount || 0);

    const initialStatus: OrderStatus = data.fullyPaid ? 'completed'
      : (data.depositPaid || (data.depositAmount && data.depositAmount > 0)) ? 'deposit_received'
      : 'pending';
    db.run(
      `INSERT INTO orders (id, branch_id, order_number, customer_id,
        category_id, attributes, condition, serial_number, existing_product_id,
        requested_brand, requested_model, requested_reference, requested_details,
        agreed_price, tax_amount, deposit_amount, deposit_paid, deposit_date, remaining_amount,
        payment_method, fully_paid,
        supplier_name, supplier_price, expected_margin, expected_delivery,
        status, notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, orderNumber, data.customerId,
       data.categoryId || null, JSON.stringify(data.attributes || {}),
       data.condition || null, data.serialNumber || null, data.existingProductId || null,
       data.requestedBrand || '', data.requestedModel || '',
       data.requestedReference || null, data.requestedDetails || null,
       data.agreedPrice || null, data.taxAmount || 0, data.depositAmount || 0,
       data.depositPaid || data.fullyPaid ? 1 : 0, data.depositDate || null, remaining,
       data.paymentMethod || null, data.fullyPaid ? 1 : 0,
       data.supplierName || null, data.supplierPrice || null,
       data.agreedPrice && data.supplierPrice ? data.agreedPrice - data.supplierPrice : null,
       data.expectedDelivery || null, initialStatus, data.notes || null, now, now, userId]
    );

    // Order Lines persistieren falls übergeben
    if (data.lines && data.lines.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      data.lines.forEach((l, i) => {
        const qty = Math.max(1, l.quantity || 1);
        const total = qty * (l.unitPrice || 0);
        stmt.run([uuid(), id, l.productId || null, l.description || '', qty, l.unitPrice || 0, total, i + 1, now]);
      });
      stmt.free();
    }

    saveDatabase();
    trackInsert('orders', id, { orderNumber, customerId: data.customerId });
    eventBus.emit('order.created', 'order', id, { customerId: data.customerId });
    get().loadOrders();
    return get().getOrder(id)!;
  },

  updateOrder: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      customerId: 'customer_id', categoryId: 'category_id',
      condition: 'condition', serialNumber: 'serial_number', existingProductId: 'existing_product_id',
      requestedBrand: 'requested_brand',
      requestedModel: 'requested_model', requestedReference: 'requested_reference',
      requestedDetails: 'requested_details', agreedPrice: 'agreed_price',
      taxAmount: 'tax_amount', paymentMethod: 'payment_method',
      depositAmount: 'deposit_amount', depositDate: 'deposit_date',
      remainingAmount: 'remaining_amount', supplierName: 'supplier_name',
      supplierPrice: 'supplier_price', expectedMargin: 'expected_margin',
      expectedDelivery: 'expected_delivery', actualDelivery: 'actual_delivery',
      status: 'status', productId: 'product_id', invoiceId: 'invoice_id', notes: 'notes',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (data.attributes !== undefined) {
      fields.push('attributes = ?'); values.push(JSON.stringify(data.attributes));
    }
    if (data.depositPaid !== undefined) { fields.push('deposit_paid = ?'); values.push(data.depositPaid ? 1 : 0); }
    if (data.fullyPaid !== undefined) { fields.push('fully_paid = ?'); values.push(data.fullyPaid ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('orders', id, data);
    get().loadOrders();

    // Auto-Status (Plan §Order §Auto): Zahlungsstatus impliziert Workflow-Stufe.
    // Nur anwenden wenn User nicht explizit 'status' gesetzt hat — sonst respektieren.
    if (data.status === undefined) {
      const fresh = get().getOrder(id);
      if (fresh && fresh.status !== 'cancelled') {
        const paidEnough = !!fresh.agreedPrice && (fresh.depositAmount || 0) >= fresh.agreedPrice;
        const hasDeposit = !!fresh.depositPaid || (fresh.depositAmount || 0) > 0;
        let nextStatus: OrderStatus | null = null;
        if (fresh.fullyPaid || paidEnough) {
          if (fresh.status !== 'completed') nextStatus = 'completed';
        } else if (hasDeposit && fresh.status === 'pending') {
          nextStatus = 'deposit_received';
        }
        if (nextStatus) {
          const nowTs = new Date().toISOString();
          db.run(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`, [nextStatus, nowTs, id]);
          saveDatabase();
          trackUpdate('orders', id, { status: nextStatus, autoDerived: true });
          get().loadOrders();
        }
      }
    }
  },

  updateStatus: (id, status) => {
    const now = new Date().toISOString();
    const updates: Partial<Order> = { status };

    switch (status) {
      case 'deposit_received':
        updates.depositPaid = true;
        updates.depositDate = now.split('T')[0];
        break;
      case 'arrived':
        updates.actualDelivery = now.split('T')[0];
        break;
    }

    get().updateOrder(id, updates);

    const eventMap: Record<string, string> = {
      deposit_received: 'order.deposit_received',
      sourced: 'order.sourced',
      arrived: 'order.arrived',
      notified: 'order.notified',
      completed: 'order.completed',
      cancelled: 'order.cancelled',
    };
    if (eventMap[status]) {
      eventBus.emit(eventMap[status] as any, 'order', id, { status });
    }
  },

  rewriteOrderLines: (orderId, lines) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(`DELETE FROM order_lines WHERE order_id = ?`, [orderId]);
    if (lines.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      lines.forEach((l, i) => {
        const qty = Math.max(1, l.quantity || 1);
        const total = qty * (l.unitPrice || 0);
        stmt.run([uuid(), orderId, l.productId || null, l.description || '', qty, l.unitPrice || 0, total, i + 1, now]);
      });
      stmt.free();
    }
    // Recompute agreedPrice from lines
    const sumRow = query(`SELECT COALESCE(SUM(line_total), 0) AS t FROM order_lines WHERE order_id = ?`, [orderId]);
    const total = Number(sumRow[0]?.t || 0);
    if (total > 0) {
      db.run(`UPDATE orders SET agreed_price = ?, updated_at = ? WHERE id = ?`, [total, now, orderId]);
    }
    saveDatabase();
    trackUpdate('orders', orderId, { linesReplaced: true, total });
    get().loadOrders();
  },

  getOrderLines: (orderId) => {
    try {
      const rows = query(
        `SELECT * FROM order_lines WHERE order_id = ? ORDER BY position`,
        [orderId]
      );
      return rows.map(r => ({
        id: r.id as string,
        orderId: r.order_id as string,
        productId: (r.product_id as string | null) || undefined,
        description: (r.description as string) || '',
        quantity: (r.quantity as number) || 1,
        unitPrice: (r.unit_price as number) || 0,
        lineTotal: (r.line_total as number) || 0,
        position: (r.position as number) || 0,
      }));
    } catch { return []; }
  },

  deleteOrder: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM order_lines WHERE order_id = ?`, [id]);
    db.run(`DELETE FROM orders WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('orders', id);
    get().loadOrders();
  },
}));
