import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Repair, RepairStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber, getNextDocumentNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { useInvoiceStore } from '@/stores/invoiceStore';

// Plan §Repair §Service-Invoice: Lazy-seeded "Repair Service"-Kategorie + ein
// virtuelles Service-Produkt pro Branch. Wird beim Convert-to-Invoice als Line-Item
// genutzt — Repairs sollen nicht wie Lager-Produkte gebucht werden.
// Idempotent: erster Aufruf erzeugt, alle weiteren liefern die ID.
export function getOrCreateRepairServiceProductId(branchId: string): string {
  const db = getDatabase();
  const now = new Date().toISOString();
  // 1. Spezial-Kategorie sicherstellen (eine pro Branch).
  const catId = `cat-repair-service-${branchId}`;
  const catExists = query('SELECT id FROM categories WHERE id = ?', [catId]);
  if (catExists.length === 0) {
    db.run(
      `INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at)
       VALUES (?, ?, 'Repair Service', 'Wrench', '#0EA5C5', '[]', '[]', '[]', 1, 99, ?, ?)`,
      [catId, branchId, now, now]
    );
  }
  // 2. Service-Produkt sicherstellen.
  const prodId = `svc-repair-${branchId}`;
  const prodExists = query('SELECT id FROM products WHERE id = ?', [prodId]);
  if (prodExists.length === 0) {
    db.run(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
        purchase_date, purchase_price, purchase_currency, stock_status, tax_scheme, expected_margin, days_in_stock,
        supplier_name, notes, images, attributes, source_type, created_at, updated_at, created_by)
       VALUES (?, ?, ?, '', 'Repair Service', NULL, '', '[]', NULL, 0, 'BHD', 'in_stock', 'VAT_10', NULL, 0,
               NULL, 'Internal service item — used for Repair invoices.', '[]', '{}', 'OWN', ?, ?, NULL)`,
      [prodId, branchId, catId, now, now]
    );
  }
  saveDatabase();
  return prodId;
}

interface RepairStore {
  repairs: Repair[];
  loading: boolean;
  loadRepairs: () => void;
  getRepair: (id: string) => Repair | undefined;
  createRepair: (data: Partial<Repair>) => Repair;
  updateRepair: (id: string, data: Partial<Repair>) => void;
  updateStatus: (id: string, status: RepairStatus) => void;
  deleteRepair: (id: string) => void;
  getNextRepairNumber: () => string;
  generateVoucherCode: () => string;
  // Plan §8 #1 — Customer-Charge Payment-Tracking
  recordCustomerPayment: (id: string, amount: number, method: 'cash' | 'bank' | 'card', date?: string) => void;
}

function rowToRepair(row: Record<string, unknown>): Repair {
  let itemAttrs: Record<string, string | number | boolean> = {};
  try { itemAttrs = JSON.parse((row.item_attributes as string) || '{}'); } catch { /* */ }
  return {
    id: row.id as string,
    repairNumber: row.repair_number as string,
    customerId: row.customer_id as string,
    productId: row.product_id as string | undefined,
    itemCategoryId: (row.item_category_id as string | null) || undefined,
    itemAttributes: itemAttrs,
    taxScheme: ((row.tax_scheme as string | null) === 'ZERO' ? 'ZERO' : 'VAT_10') as 'ZERO' | 'VAT_10',
    itemBrand: row.item_brand as string | undefined,
    itemModel: row.item_model as string | undefined,
    itemReference: row.item_reference as string | undefined,
    itemSerial: row.item_serial as string | undefined,
    itemDescription: row.item_description as string | undefined,
    issueDescription: row.issue_description as string,
    diagnosis: row.diagnosis as string | undefined,
    repairType: (row.repair_type as Repair['repairType']) || 'internal',
    externalVendor: row.external_vendor as string | undefined,
    estimatedCost: row.estimated_cost as number | undefined,
    actualCost: row.actual_cost as number | undefined,
    internalCost: (row.internal_cost as number) || 0,
    chargeToCustomer: row.charge_to_customer as number | undefined,
    customerPaidFrom: (row.customer_paid_from as 'cash' | 'bank' | null) ?? null,
    internalPaidFrom: (row.internal_paid_from as 'cash' | 'bank' | null) ?? null,
    customerPaidAmount: (row.customer_paid_amount as number) || 0,
    customerPaymentStatus: (row.customer_payment_status as 'UNPAID' | 'PARTIALLY_PAID' | 'PAID') || 'UNPAID',
    customerPaymentMethod: (row.customer_payment_method as 'cash' | 'bank' | 'card' | null) ?? null,
    customerPaymentDate: row.customer_payment_date as string | undefined,
    margin: row.margin as number | undefined,
    status: (row.status as RepairStatus) || 'received',
    receivedAt: row.received_at as string,
    diagnosedAt: row.diagnosed_at as string | undefined,
    startedAt: row.started_at as string | undefined,
    completedAt: row.completed_at as string | undefined,
    pickedUpAt: row.picked_up_at as string | undefined,
    estimatedReady: row.estimated_ready as string | undefined,
    voucherCode: row.voucher_code as string,
    invoiceId: row.invoice_id as string | undefined,
    notes: row.notes as string | undefined,
    images: JSON.parse((row.images as string) || '[]'),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useRepairStore = create<RepairStore>((set, get) => ({
  repairs: [],
  loading: false,

  loadRepairs: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM repairs WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      set({ repairs: rows.map(rowToRepair), loading: false });
    } catch { set({ repairs: [], loading: false }); }
  },

  getRepair: (id) => get().repairs.find(r => r.id === id),

  getNextRepairNumber: () => getNextNumber('repairs', 'repair.number_prefix', 'REP'),

  generateVoucherCode: () => {
    // 8-char alphanumeric
    return uuid().replace(/-/g, '').substring(0, 8).toUpperCase();
  },

  createRepair: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const repairNumber = get().getNextRepairNumber();
    const voucherCode = get().generateVoucherCode();

    db.run(
      `INSERT INTO repairs (id, branch_id, repair_number, customer_id, product_id,
        item_category_id, item_attributes, tax_scheme,
        item_brand, item_model, item_reference, item_serial, item_description,
        issue_description, diagnosis, repair_type, external_vendor,
        estimated_cost, internal_cost, charge_to_customer,
        status, received_at, estimated_ready, voucher_code,
        notes, images, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, '[]', ?, ?, ?)`,
      [id, branchId, repairNumber, data.customerId, data.productId || null,
       data.itemCategoryId || null, JSON.stringify(data.itemAttributes || {}), data.taxScheme || 'VAT_10',
       data.itemBrand || null, data.itemModel || null, data.itemReference || null,
       data.itemSerial || null, data.itemDescription || null,
       data.issueDescription || '', data.diagnosis || null,
       data.repairType || 'internal', data.externalVendor || null,
       data.estimatedCost || null, data.internalCost || 0, data.chargeToCustomer || null,
       now, data.estimatedReady || null, voucherCode,
       data.notes || null, now, now, userId]
    );

    // If linked to a product, update its status
    if (data.productId) {
      db.run(`UPDATE products SET stock_status = 'in_repair', updated_at = ? WHERE id = ?`, [now, data.productId]);
    }

    saveDatabase();
    trackInsert('repairs', id, { repairNumber, customerId: data.customerId });
    eventBus.emit('repair.created', 'repair', id, { customerId: data.customerId, voucherCode });
    get().loadRepairs();

    return get().getRepair(id)!;
  },

  updateRepair: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const map: Record<string, string> = {
      customerId: 'customer_id', productId: 'product_id',
      itemCategoryId: 'item_category_id', taxScheme: 'tax_scheme',
      itemBrand: 'item_brand', itemModel: 'item_model', itemReference: 'item_reference',
      itemSerial: 'item_serial', itemDescription: 'item_description',
      issueDescription: 'issue_description', diagnosis: 'diagnosis',
      repairType: 'repair_type', externalVendor: 'external_vendor',
      estimatedCost: 'estimated_cost', actualCost: 'actual_cost',
      internalCost: 'internal_cost', chargeToCustomer: 'charge_to_customer',
      customerPaidFrom: 'customer_paid_from', internalPaidFrom: 'internal_paid_from',
      margin: 'margin', status: 'status',
      receivedAt: 'received_at', diagnosedAt: 'diagnosed_at',
      startedAt: 'started_at', completedAt: 'completed_at',
      pickedUpAt: 'picked_up_at', estimatedReady: 'estimated_ready',
      invoiceId: 'invoice_id', notes: 'notes',
    };

    for (const [k, v] of Object.entries(data)) {
      const col = map[k];
      if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (data.itemAttributes !== undefined) {
      fields.push('item_attributes = ?'); values.push(JSON.stringify(data.itemAttributes));
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE repairs SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('repairs', id, data);
    get().loadRepairs();
  },

  updateStatus: (id, status) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const repair = get().getRepair(id);
    if (!repair) return;

    const updates: Record<string, unknown> = { status, updated_at: now };

    switch (status) {
      case 'diagnosed': updates.diagnosed_at = now; break;
      case 'in_progress':
      case 'IN_PROGRESS':
        updates.started_at = now; break;
      case 'sent_to_workshop':
      case 'SENT_TO_WORKSHOP':
        if (!repair.startedAt) updates.started_at = now;
        break;
      case 'READY':
      case 'ready':
        updates.completed_at = now;
        if (repair.chargeToCustomer && repair.internalCost) {
          updates.margin = repair.chargeToCustomer - repair.internalCost;
        }
        // Plan §Repair §9 + §Expenses §8: externe Workshop-Kosten automatisch als Expense buchen.
        // Gilt für External UND Hybrid (Hybrid hat einen externen Anteil).
        if ((repair.repairType === 'external' || repair.repairType === 'hybrid') && (repair.internalCost || 0) > 0) {
          const existing = query(
            `SELECT id FROM expenses WHERE related_module = 'repair' AND related_entity_id = ?`,
            [id]
          );
          if (existing.length === 0) {
            let branchId: string, userId: string;
            try { branchId = currentBranchId(); userId = currentUserId(); }
            catch { branchId = 'branch-main'; userId = 'user-owner'; }
            const expenseId = uuid();
            const expenseNumber = getNextDocumentNumber('EXP');
            const method = repair.internalPaidFrom || 'bank';
            // Default-Status PENDING — Workshop-Rechnung wurde erfasst aber noch nicht bezahlt.
            // User muss explizit „Mark as Paid" wählen → erscheint sonst in /payables-Liste.
            // Wenn `internalPaidFrom` explizit gesetzt ist (cash/bank), gilt das als Sofort-Zahlung.
            const status = repair.internalPaidFrom ? 'PAID' : 'PENDING';
            db.run(
              `INSERT INTO expenses (id, branch_id, expense_number, category, amount, payment_method,
                expense_date, description, related_module, related_entity_id, status, created_at, created_by)
               VALUES (?, ?, ?, 'RepairCosts', ?, ?, ?, ?, 'repair', ?, ?, ?, ?)`,
              [expenseId, branchId, expenseNumber, repair.internalCost, method,
               now.split('T')[0],
               `External repair ${repair.repairNumber}${repair.externalVendor ? ' · ' + repair.externalVendor : ''}`,
               id, status, now, userId]
            );
            trackInsert('expenses', expenseId, { category: 'RepairCosts', amount: repair.internalCost, repairId: id, status });
          }
        }
        break;
      case 'picked_up':
      case 'DELIVERED': {
        // Plan §Repair §Picked-Up-Gate (User-Spec):
        // Wenn der Repair kostenpflichtig ist (chargeToCustomer > 0), darf erst
        // nach voller Bezahlung auf Picked Up. Gratis-Repairs (charge=0) dürfen
        // ohne Invoice direkt abgeschlossen werden.
        const charge = repair.chargeToCustomer || 0;
        if (charge > 0.005) {
          const directlyPaid = repair.customerPaymentStatus === 'PAID';
          let invoicePaid = false;
          if (repair.invoiceId) {
            const inv = useInvoiceStore.getState().invoices.find(i => i.id === repair.invoiceId);
            if (inv) {
              invoicePaid = (inv.paidAmount || 0) >= (inv.grossAmount || 0) - 0.005;
            }
          }
          if (!directlyPaid && !invoicePaid) {
            throw new Error(
              repair.invoiceId
                ? 'Repair-Invoice ist noch nicht voll bezahlt — bitte erst Payment buchen, dann Picked Up.'
                : 'Repair hat einen Charge — bitte erst Invoice erstellen + bezahlen, dann Picked Up.'
            );
          }
        }
        updates.picked_up_at = now;
        // Restore product status if linked
        if (repair.productId) {
          db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`, [now, repair.productId]);
        }
        break;
      }
    }

    const fields = Object.entries(updates).map(([k]) => `${k} = ?`);
    const values = Object.values(updates);
    values.push(id);
    db.run(`UPDATE repairs SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('repairs', id, { status });

    // Emit events
    const eventMap: Record<string, string> = {
      diagnosed: 'repair.diagnosed',
      in_progress: 'repair.started', IN_PROGRESS: 'repair.started',
      sent_to_workshop: 'repair.started', SENT_TO_WORKSHOP: 'repair.started',
      ready: 'repair.ready', READY: 'repair.ready',
      picked_up: 'repair.picked_up', DELIVERED: 'repair.picked_up',
    };
    if (eventMap[status]) {
      eventBus.emit(eventMap[status] as any, 'repair', id, { status, customerId: repair.customerId });
    }

    get().loadRepairs();
  },

  deleteRepair: (id) => {
    const db = getDatabase();
    const repair = get().getRepair(id);
    // Restore product status if needed
    if (repair?.productId && repair.status !== 'picked_up') {
      db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), repair.productId]);
    }
    // Auto-erzeugte Repair-Cost-Expenses cancellen (Cashflow-Bereinigung).
    db.run(
      `UPDATE expenses SET status = 'CANCELLED'
       WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'`,
      [id]
    );
    db.run(`DELETE FROM repairs WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('repairs', id);
    get().loadRepairs();
  },

  // Plan §8 #1 — Customer-Charge Payment-Tracking. Akkumuliert Zahlungen, leitet Status ab.
  recordCustomerPayment: (id, amount, method, date) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Repair payment amount must be a positive number.');
    }
    const db = getDatabase();
    const r = get().getRepair(id);
    if (!r) return;
    const charge = r.chargeToCustomer || 0;
    const newPaid = Math.min(charge > 0 ? charge : Number.MAX_SAFE_INTEGER, (r.customerPaidAmount || 0) + amount);
    const newStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' =
      charge > 0 && newPaid >= charge - 0.005 ? 'PAID'
      : newPaid > 0 ? 'PARTIALLY_PAID'
      : 'UNPAID';
    const now = new Date().toISOString();
    const payDate = date || now.split('T')[0];
    db.run(
      `UPDATE repairs SET customer_paid_amount = ?, customer_payment_status = ?,
         customer_payment_method = ?, customer_payment_date = ?, updated_at = ?
       WHERE id = ?`,
      [newPaid, newStatus, method, payDate, now, id]
    );
    saveDatabase();
    trackUpdate('repairs', id, { customerPayment: amount, method, date: payDate, status: newStatus });
    eventBus.emit('repair.payment_received' as any, 'repair', id, { amount, method, totalPaid: newPaid, status: newStatus });
    get().loadRepairs();
  },
}));
