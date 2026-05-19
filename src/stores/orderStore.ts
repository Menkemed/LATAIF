import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Order, OrderStatus, OrderLine, OrderType, CustomOrderMeta, MaterialDetails, Expense } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber, getNextDocumentNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import {
  postOrderPayment,
  postOrderPaymentReversed,
  postExpense,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

interface OrderStore {
  orders: Order[];
  loading: boolean;
  loadOrders: () => void;
  getOrder: (id: string) => Order | undefined;
  createOrder: (data: Partial<Omit<Order, 'lines'>> & { lines?: Array<Omit<OrderLine, 'id' | 'orderId' | 'lineTotal' | 'position'>> }) => Order;
  updateOrder: (id: string, data: Partial<Order>) => void;
  updateStatus: (id: string, status: OrderStatus) => void;
  deleteOrder: (id: string) => void;
  // Lines per Order — v0.2.1 erweitert um supplier-cost + material + customer-facing flag
  rewriteOrderLines: (orderId: string, lines: Array<{
    productId?: string;
    description: string;
    quantity: number;
    unitPrice: number;
    taxScheme?: OrderLine['taxScheme'];
    vatRate?: number;
    supplierId?: string;
    costAmount?: number;
    isCustomerFacing?: boolean;
    materialKind?: 'labor' | 'diamond' | 'stone' | 'gold' | null;
    materialDetails?: MaterialDetails;
  }>) => void;
  getOrderLines: (orderId: string) => OrderLine[];
  // v0.2.1 — Trigger A/P-Expense fuer jede order_line mit supplier_id + cost_amount > 0
  // (analog zu repairStore.commitRepairLineExpenses). Idempotent: ueberspringt lines
  // die bereits expense_id haben.
  commitOrderLineExpenses: (orderId: string) => void;
}

function rowToOrder(row: Record<string, unknown>): Order {
  let attrs: Record<string, string | number | boolean | string[]> = {};
  try { attrs = JSON.parse((row.attributes as string) || '{}'); } catch { /* */ }
  let customMeta: CustomOrderMeta | undefined;
  try {
    const raw = row.custom_meta as string | null;
    if (raw) customMeta = JSON.parse(raw) as CustomOrderMeta;
  } catch { /* */ }
  return {
    id: row.id as string,
    orderNumber: row.order_number as string,
    customerId: row.customer_id as string,
    // v0.2.1 — Order-Type Discriminator + Custom-Meta
    type: ((row.type as string) || 'normal') as OrderType,
    customMeta,
    goldsmithSupplierId: (row.goldsmith_supplier_id as string | null) || undefined,
    laborCost: (row.labor_cost as number) || 0,
    extraGoldValue: (row.extra_gold_value as number) || 0,
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

    // Plan §Order: Order-Status ist orthogonal zum Zahlungsstand.
    // Default ist immer 'pending', auch bei direkt-bezahlten Auftraegen — der Payment-Status
    // (UNPAID/PARTIALLY_PAID/PAID) wird live aus den order_payments abgeleitet.
    // Ausnahme: fullyPaid + bereits arrived/notified ist hier nicht der Fall — neue Auftraege
    // koennen nur 'pending' starten oder per Caller explizit gesetzt sein.
    const initialStatus: OrderStatus = (data.status as OrderStatus) || 'pending';
    // v0.2.1 — Order-Type + Custom-Meta + promoted Custom-Fields
    const orderType: OrderType = (data.type as OrderType) || 'normal';
    const customMetaJson = data.customMeta ? JSON.stringify(data.customMeta) : null;
    db.run(
      `INSERT INTO orders (id, branch_id, order_number, customer_id,
        category_id, attributes, condition, serial_number, existing_product_id,
        requested_brand, requested_model, requested_reference, requested_details,
        agreed_price, tax_amount, deposit_amount, deposit_paid, deposit_date, remaining_amount,
        payment_method, fully_paid,
        supplier_name, supplier_price, expected_margin, expected_delivery,
        status, notes, created_at, updated_at, created_by,
        type, custom_meta, goldsmith_supplier_id, labor_cost, extra_gold_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
       data.expectedDelivery || null, initialStatus, data.notes || null, now, now, userId,
       orderType, customMetaJson, data.goldsmithSupplierId || null,
       data.laborCost || 0, data.extraGoldValue || 0]
    );

    // Order Lines persistieren falls übergeben — inkl. Tax-Scheme-Snapshot,
    // damit Convert-to-Invoice ohne erneutes Nachfragen funktioniert.
    // v0.2.1 — auch supplier_id / cost_amount / is_customer_facing / material_*
    // werden persistiert (analog zu repair_lines).
    if (data.lines && data.lines.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position, tax_scheme, vat_rate,
          supplier_id, cost_amount, is_customer_facing, material_kind, material_details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      data.lines.forEach((l, i) => {
        const qty = Math.max(1, l.quantity || 1);
        const total = qty * (l.unitPrice || 0);
        const matJson = l.materialDetails ? JSON.stringify(l.materialDetails) : null;
        stmt.run([
          uuid(), id, l.productId || null, l.description || '', qty, l.unitPrice || 0, total, i + 1,
          l.taxScheme || null, l.vatRate ?? null,
          l.supplierId || null, l.costAmount ?? 0,
          l.isCustomerFacing === false ? 0 : 1,
          l.materialKind || null, matJson,
          now,
        ]);
      });
      stmt.free();
    }

    // Plan §Order: Wenn beim Anlegen ein Deposit eingegeben wurde, gleich als order_payments-Eintrag
    // persistieren — sonst zeigt OrderDetail Total Paid = 0 (summiert aus order_payments), waehrend
    // OrderList den deposit_amount aus der orders-Tabelle nimmt → Inkonsistenz.
    const initialPaid = data.fullyPaid ? (data.agreedPrice || 0) : (data.depositAmount || 0);
    let initialPaymentId: string | null = null;
    const paidAt = data.depositDate || now.split('T')[0];
    const method = data.paymentMethod || 'cash';
    if (initialPaid > 0) {
      initialPaymentId = uuid();
      db.run(
        `INSERT INTO order_payments (id, order_id, amount, paid_at, method, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          initialPaymentId,
          id,
          initialPaid,
          paidAt,
          method,
          data.fullyPaid ? 'Initial full payment' : 'Initial deposit',
          now,
        ]
      );
    }

    saveDatabase();
    trackInsert('orders', id, { orderNumber, customerId: data.customerId });
    eventBus.emit('order.created', 'order', id, { customerId: data.customerId });
    get().loadOrders();

    // ZIEL.md §3a — Initial-Deposit ans Ledger.
    if (initialPaymentId && initialPaid > 0 && data.customerId) {
      const payId = initialPaymentId;
      const customerId = data.customerId;
      safePost(`postOrderPayment(${payId}) [initial]`, () => {
        if (hasLedgerEntries('ORDER_PAYMENT', payId)) return;
        postOrderPayment(
          { id: payId, orderId: id, amount: initialPaid, method, paidAt },
          customerId
        );
      });
    }

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
      // v0.2.1
      type: 'type', goldsmithSupplierId: 'goldsmith_supplier_id',
      laborCost: 'labor_cost', extraGoldValue: 'extra_gold_value',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (data.attributes !== undefined) {
      fields.push('attributes = ?'); values.push(JSON.stringify(data.attributes));
    }
    if (data.customMeta !== undefined) {
      fields.push('custom_meta = ?'); values.push(data.customMeta ? JSON.stringify(data.customMeta) : null);
    }
    if (data.depositPaid !== undefined) { fields.push('deposit_paid = ?'); values.push(data.depositPaid ? 1 : 0); }
    if (data.fullyPaid !== undefined) { fields.push('fully_paid = ?'); values.push(data.fullyPaid ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('orders', id, data);
    get().loadOrders();

    // Plan §Order: KEINE Auto-Status-Promotion. Order-Status (PENDING/ARRIVED/NOTIFIED/COMPLETED)
    // ist explizit vom User gesetzt — Zahlung != Prozessfortschritt.
    // Beispiel: Kunde zahlt voll, Ware noch nicht da → Payment=PAID, Order=PENDING.
  },

  updateStatus: (id, status) => {
    const now = new Date().toISOString();
    const updates: Partial<Order> = { status };

    if (status === 'arrived') {
      updates.actualDelivery = now.split('T')[0];
    }

    get().updateOrder(id, updates);

    // v0.2.1 — Bei status='arrived' (Goldsmith hat geliefert) werden alle
    // OPEN order_lines mit supplier_id + cost_amount > 0 als A/P-Expense
    // gebucht (analog Repair commitRepairLineExpenses bei IN_PROGRESS).
    if (status === 'arrived') {
      try { get().commitOrderLineExpenses(id); }
      catch (err) { console.error('[order] commitOrderLineExpenses failed:', err); }
    }

    const eventMap: Record<OrderStatus, string> = {
      pending: 'order.created',
      arrived: 'order.arrived',
      notified: 'order.notified',
      completed: 'order.completed',
      cancelled: 'order.cancelled',
    };
    if (eventMap[status]) {
      eventBus.emit(eventMap[status] as any, 'order', id, { status });
    }
  },

  // v0.2.1 — Port von repairStore.commitRepairLineExpenses. Postet pro
  // order_line mit supplier_id + cost_amount > 0 einen Expense + Ledger A/P.
  // Idempotent: ueberspringt lines die bereits expense_id haben.
  commitOrderLineExpenses: (orderId) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const orderRows = query(
      `SELECT id, branch_id, order_number, payment_method FROM orders WHERE id = ?`,
      [orderId]
    );
    if (orderRows.length === 0) return;
    const order = orderRows[0];
    const orderNumber = order.order_number as string;
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = (order.branch_id as string) || 'branch-main'; userId = 'user-owner'; }

    const lineRows = query(
      `SELECT id, position, supplier_id, description, cost_amount, material_kind, material_details
         FROM order_lines
         WHERE order_id = ? AND supplier_id IS NOT NULL AND expense_id IS NULL
           AND cost_amount > 0
         ORDER BY position`,
      [orderId]
    );
    if (lineRows.length === 0) return;

    for (const lr of lineRows) {
      const lineId = lr.id as string;
      const position = (lr.position as number) || 0;
      const supplierId = lr.supplier_id as string;
      const description = (lr.description as string) || '';
      const cost = (lr.cost_amount as number) || 0;
      const matKind = (lr.material_kind as string) || 'labor';
      if (cost <= 0) continue;

      const expenseId = uuid();
      const expenseNumber = getNextDocumentNumber('EXP');
      const method = ((order.payment_method as 'cash' | 'bank' | 'benefit' | null) || 'bank');
      const expStatus = 'PENDING' as const;

      // Supplier-Label
      let supplierLabel = '';
      try {
        const sRow = query(`SELECT name FROM suppliers WHERE id = ?`, [supplierId]);
        if (sRow.length > 0) supplierLabel = ' · ' + (sRow[0].name as string);
      } catch { /* */ }

      // Sub-Number Format: ORD-000023-L1 (analog v0.1.48 Repair-Lines)
      const lineLabel = position > 0 ? `${orderNumber}-L${position}` : orderNumber;
      const desc = `${lineLabel} · ${matKind}${description ? ' · ' + description : ''}${supplierLabel}`;
      db.run(
        `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
           expense_date, description, related_module, related_entity_id, supplier_id, status, created_at, created_by)
         VALUES (?, ?, ?, 'Inventory', ?, 0, ?, ?, ?, 'order', ?, ?, ?, ?, ?)`,
        [expenseId, branchId, expenseNumber, cost, method,
         now.split('T')[0], desc, orderId, supplierId, expStatus, now, userId]
      );
      trackInsert('expenses', expenseId, {
        category: 'Inventory', amount: cost, orderId, orderLineId: lineId,
        supplierId, status: expStatus,
      });

      // Link expense back to order_line
      db.run(`UPDATE order_lines SET expense_id = ? WHERE id = ?`, [expenseId, lineId]);
      trackUpdate('order_lines', lineId, { expenseId });

      // ZIEL.md §3a — Ledger-Posting nach Insert.
      const expFresh: Expense = {
        id: expenseId,
        branchId,
        expenseNumber,
        category: 'Inventory',
        amount: cost,
        paidAmount: 0,
        paymentMethod: method,
        expenseDate: now.split('T')[0],
        description: desc,
        relatedModule: 'order',
        relatedEntityId: orderId,
        supplierId,
        status: expStatus,
        createdAt: now,
        createdBy: userId,
      };
      safePost(`postExpense(${expenseId}) [order-line]`, () => {
        if (hasLedgerEntries('EXPENSE', expenseId)) return;
        postExpense(expFresh);
      });
    }

    saveDatabase();
    get().loadOrders();
  },

  rewriteOrderLines: (orderId, lines) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(`DELETE FROM order_lines WHERE order_id = ?`, [orderId]);
    if (lines.length > 0) {
      const stmt = db.prepare(
        `INSERT INTO order_lines (id, order_id, product_id, description, quantity, unit_price, line_total, position, tax_scheme, vat_rate,
          supplier_id, cost_amount, is_customer_facing, material_kind, material_details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      lines.forEach((l, i) => {
        const qty = Math.max(1, l.quantity || 1);
        const total = qty * (l.unitPrice || 0);
        const matJson = l.materialDetails ? JSON.stringify(l.materialDetails) : null;
        stmt.run([
          uuid(), orderId, l.productId || null, l.description || '', qty, l.unitPrice || 0, total, i + 1,
          l.taxScheme || null, l.vatRate ?? null,
          l.supplierId || null, l.costAmount ?? 0,
          l.isCustomerFacing === false ? 0 : 1,
          l.materialKind || null, matJson,
          now,
        ]);
      });
      stmt.free();
    }
    // Recompute agreedPrice from lines — nur customer-facing zaehlt!
    const sumRow = query(`SELECT COALESCE(SUM(line_total), 0) AS t FROM order_lines WHERE order_id = ? AND COALESCE(is_customer_facing, 1) = 1`, [orderId]);
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
      return rows.map(r => {
        let matDetails: MaterialDetails | undefined;
        try {
          const raw = r.material_details as string | null;
          if (raw) matDetails = JSON.parse(raw) as MaterialDetails;
        } catch { /* */ }
        return {
          id: r.id as string,
          orderId: r.order_id as string,
          productId: (r.product_id as string | null) || undefined,
          description: (r.description as string) || '',
          quantity: (r.quantity as number) || 1,
          unitPrice: (r.unit_price as number) || 0,
          lineTotal: (r.line_total as number) || 0,
          position: (r.position as number) || 0,
          taxScheme: (r.tax_scheme as OrderLine['taxScheme'] | null) || undefined,
          vatRate: r.vat_rate != null ? (r.vat_rate as number) : undefined,
          // v0.2.1 — neue Felder
          supplierId: (r.supplier_id as string | null) || undefined,
          costAmount: r.cost_amount != null ? (r.cost_amount as number) : undefined,
          expenseId: (r.expense_id as string | null) || undefined,
          isCustomerFacing: r.is_customer_facing == null ? true : Number(r.is_customer_facing) === 1,
          materialKind: (r.material_kind as OrderLine['materialKind']) || undefined,
          materialDetails: matDetails,
        };
      });
    } catch { return []; }
  },

  deleteOrder: (id) => {
    const db = getDatabase();
    // ZIEL.md §3a — Vor dem CASCADE-Delete der order_payments deren Ledger-Buchungen reversen,
    // sonst hängt Customer-Deposits-Liability ohne Quelle in der Luft.
    const payRows = query('SELECT id FROM order_payments WHERE order_id = ?', [id]);
    for (const r of payRows) {
      const opId = r.id as string;
      safePost(`postOrderPaymentReversed(${opId}) [delete-order]`, () => {
        if (!hasLedgerEntries('ORDER_PAYMENT', opId)) return;
        if (hasReversalFor('ORDER_PAYMENT', opId)) return;
        postOrderPaymentReversed(opId);
      });
    }
    db.run(`DELETE FROM order_lines WHERE order_id = ?`, [id]);
    db.run(`DELETE FROM orders WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('orders', id);
    get().loadOrders();
  },
}));
