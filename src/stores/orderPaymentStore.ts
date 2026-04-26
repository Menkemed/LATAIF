import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackInsert, trackDelete, trackPayment, trackStatusChange } from '@/core/sync/track';
import { useOrderStore } from '@/stores/orderStore';

// Plan §Order §Payment-Sync: Order-Summary (depositAmount/remaining/fullyPaid/status) immer
// aus der Summe der order_payments ableiten, damit OrderList/OrderDetail synchron sind.
function reconcileOrderFromPayments(orderId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const sumRow = query(`SELECT COALESCE(SUM(amount), 0) AS t FROM order_payments WHERE order_id = ?`, [orderId]);
  const totalPaid = Number(sumRow[0]?.t || 0);

  const orderRow = query(`SELECT agreed_price, status FROM orders WHERE id = ?`, [orderId]);
  if (orderRow.length === 0) return;
  const agreedPrice = (orderRow[0].agreed_price as number) || 0;
  const currentStatus = orderRow[0].status as string;

  const remaining = Math.max(0, agreedPrice - totalPaid);
  const fullyPaid = agreedPrice > 0 && totalPaid >= agreedPrice - 0.001;
  const depositPaid = totalPaid > 0;

  // Auto-Status: fully_paid → completed; erste Zahlung → deposit_received (nur aus pending).
  // sourcing/sourced/arrived/notified/cancelled bleiben unberührt.
  let newStatus = currentStatus;
  if (currentStatus !== 'cancelled') {
    if (fullyPaid && currentStatus !== 'completed') {
      newStatus = 'completed';
    } else if (depositPaid && currentStatus === 'pending') {
      newStatus = 'deposit_received';
    }
  }

  db.run(
    `UPDATE orders SET
       deposit_amount = ?,
       deposit_paid = ?,
       remaining_amount = ?,
       fully_paid = ?,
       deposit_date = COALESCE(deposit_date, CASE WHEN ? > 0 THEN ? ELSE NULL END),
       status = ?,
       updated_at = ?
     WHERE id = ?`,
    [totalPaid, depositPaid ? 1 : 0, remaining, fullyPaid ? 1 : 0,
     totalPaid, now.split('T')[0], newStatus, now, orderId]
  );

  if (newStatus !== currentStatus) {
    trackStatusChange('orders', orderId, currentStatus, newStatus);
  }
}

export interface OrderPayment {
  id: string;
  orderId: string;
  amount: number;
  paidAt: string;
  method?: string;
  reference?: string;
  note?: string;
  createdAt: string;
}

interface OrderPaymentStore {
  paymentsByOrder: Record<string, OrderPayment[]>;
  loadPayments: (orderId: string) => void;
  addPayment: (p: Omit<OrderPayment, 'id' | 'createdAt'>) => OrderPayment;
  deletePayment: (id: string, orderId: string) => void;
  totalPaid: (orderId: string) => number;
}

function rowToPayment(r: Record<string, unknown>): OrderPayment {
  return {
    id: r.id as string,
    orderId: r.order_id as string,
    amount: (r.amount as number) || 0,
    paidAt: r.paid_at as string,
    method: r.method as string | undefined,
    reference: r.reference as string | undefined,
    note: r.note as string | undefined,
    createdAt: r.created_at as string,
  };
}

export const useOrderPaymentStore = create<OrderPaymentStore>((set, get) => ({
  paymentsByOrder: {},

  loadPayments: (orderId) => {
    try {
      const rows = query(
        'SELECT * FROM order_payments WHERE order_id = ? ORDER BY paid_at ASC, created_at ASC',
        [orderId]
      );
      set(s => ({ paymentsByOrder: { ...s.paymentsByOrder, [orderId]: rows.map(rowToPayment) } }));
    } catch {
      set(s => ({ paymentsByOrder: { ...s.paymentsByOrder, [orderId]: [] } }));
    }
  },

  addPayment: (p) => {
    const db = getDatabase();
    const id = uuid();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO order_payments (id, order_id, amount, paid_at, method, reference, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.orderId, p.amount, p.paidAt, p.method || null, p.reference || null, p.note || null, now]
    );
    reconcileOrderFromPayments(p.orderId);
    saveDatabase();
    trackInsert('order_payments', id, { orderId: p.orderId, amount: p.amount, method: p.method });
    trackPayment('orders', p.orderId, p.amount, p.method || 'cash');
    get().loadPayments(p.orderId);
    useOrderStore.getState().loadOrders(); // Order-Summary in UI refreshen
    return { id, createdAt: now, ...p };
  },

  deletePayment: (id, orderId) => {
    const db = getDatabase();
    db.run(`DELETE FROM order_payments WHERE id = ?`, [id]);
    reconcileOrderFromPayments(orderId);
    saveDatabase();
    trackDelete('order_payments', id);
    get().loadPayments(orderId);
    useOrderStore.getState().loadOrders();
  },

  totalPaid: (orderId) => {
    const list = get().paymentsByOrder[orderId] || [];
    return list.reduce((sum, p) => sum + p.amount, 0);
  },
}));
