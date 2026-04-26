// ═══════════════════════════════════════════════════════════
// LATAIF — Automation Handlers
// Event-driven task generation (closed-loop automation)
// ═══════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { eventBus } from '../events/event-bus';
import { getDatabase, saveDatabase } from '../db/database';
import { query, currentBranchId, currentUserId } from '../db/helpers';
import type { DomainEvent, TaskType, TaskPriority } from '../models/types';

function getBranchId(): string {
  try { return currentBranchId(); } catch { return 'branch-main'; }
}

function getUserId(): string | null {
  try { return currentUserId(); } catch { return null; }
}

function insertTask(opts: {
  title: string;
  description?: string;
  type: TaskType;
  priority: TaskPriority;
  dueAt?: string;
  linkedEntityType: string;
  linkedEntityId: string;
}): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = uuid();

  db.run(
    `INSERT INTO tasks (id, branch_id, title, description, type, priority, due_at, linked_entity_type, linked_entity_id, assigned_to, status, auto_generated, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`,
    [id, getBranchId(), opts.title, opts.description || null, opts.type, opts.priority,
     opts.dueAt || null, opts.linkedEntityType, opts.linkedEntityId,
     getUserId(), now, getUserId()]
  );

  saveDatabase();
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ── product.created ──
// If no planned sale price, create a "Review pricing" task
// Also suggest matching customers (see closed-loop section below)
eventBus.on('product.created', (event: DomainEvent) => {
  const { plannedSalePrice, brand } = event.payload as { plannedSalePrice?: number; brand?: string; name?: string };
  if (!plannedSalePrice) {
    insertTask({
      title: 'Review pricing for new product',
      description: `Product "${event.payload.brand || ''} ${event.payload.name || ''}" was added without a planned sale price. Set pricing to enable margin tracking.`,
      type: 'price_check',
      priority: 'high',
      dueAt: addDays(1),
      linkedEntityType: 'product',
      linkedEntityId: event.entityId,
    });
  }

  // Suggest matching customers
  if (brand) {
    const branchId = getBranchId();
    const matchingCustomers = query(
      `SELECT id, first_name, last_name FROM customers WHERE branch_id = ? AND sales_stage IN ('active', 'qualified') AND preferences LIKE ?`,
      [branchId, `%${brand}%`]
    );
    if (matchingCustomers.length > 0) {
      const names = matchingCustomers.slice(0, 3).map(c => `${c.first_name} ${c.last_name}`).join(', ');
      insertTask({
        title: `Matching clients for new ${brand}`,
        description: `${matchingCustomers.length} client(s) prefer ${brand}: ${names}${matchingCustomers.length > 3 ? '...' : ''}. Consider preparing offers.`,
        type: 'follow_up',
        priority: 'medium',
        dueAt: addDays(1),
        linkedEntityType: 'product',
        linkedEntityId: event.entityId,
      });
    }
  }
});

// ── offer.sent ──
// Create a follow-up task in 3 days
eventBus.on('offer.sent', (event: DomainEvent) => {
  insertTask({
    title: 'Follow up on sent offer',
    description: `Offer ${event.payload.offerNumber || event.entityId} was sent. Follow up with the customer to check interest.`,
    type: 'follow_up',
    priority: 'medium',
    dueAt: addDays(3),
    linkedEntityType: 'offer',
    linkedEntityId: event.entityId,
  });
});

// ── offer.accepted ──
// Create task "Create invoice"
eventBus.on('offer.accepted', (event: DomainEvent) => {
  insertTask({
    title: 'Create invoice for accepted offer',
    description: `Offer ${event.payload.offerNumber || event.entityId} has been accepted. Create an invoice to proceed with the sale.`,
    type: 'general',
    priority: 'high',
    dueAt: addDays(1),
    linkedEntityType: 'offer',
    linkedEntityId: event.entityId,
  });
});

// ── invoice.issued ──
// Create payment reminder (due in 14 days)
eventBus.on('invoice.issued', (event: DomainEvent) => {
  insertTask({
    title: 'Payment reminder',
    description: `Invoice ${event.payload.invoiceNumber || event.entityId} was issued. Follow up on payment if not received by due date.`,
    type: 'payment_reminder',
    priority: 'medium',
    dueAt: addDays(14),
    linkedEntityType: 'invoice',
    linkedEntityId: event.entityId,
  });
});

// (invoice.paid handler is in the closed-loop section below — handles products, customer KPIs, and task completion)

// ── repair.ready ──
// Create task "Notify customer for pickup"
eventBus.on('repair.ready', (event: DomainEvent) => {
  insertTask({
    title: 'Notify customer for pickup',
    description: `Repair ${event.payload.repairNumber || event.entityId} is ready. Contact the customer to arrange pickup.`,
    type: 'repair_ready',
    priority: 'high',
    dueAt: addDays(1),
    linkedEntityType: 'repair',
    linkedEntityId: event.entityId,
  });
});

// ── repair.picked_up ──
// Auto-close alle offenen Tasks für den Repair (Plan §Automation §3b).
eventBus.on('repair.picked_up', (event: DomainEvent) => {
  const db = getDatabase();
  const now = new Date().toISOString();
  const branchId = getBranchId();
  const open = query(
    `SELECT id FROM tasks
       WHERE branch_id = ? AND linked_entity_type = 'repair' AND linked_entity_id = ?
         AND status NOT IN ('completed', 'cancelled')`,
    [branchId, event.entityId]
  );
  for (const row of open) {
    db.run(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`, [now, row.id]);
  }
  if (open.length > 0) saveDatabase();
});

// ── repair.created ──
// Create task "Diagnose repair"
eventBus.on('repair.created', (event: DomainEvent) => {
  insertTask({
    title: 'Diagnose repair',
    description: `New repair ${event.payload.repairNumber || event.entityId} received. Perform initial diagnosis and provide estimate.`,
    type: 'review',
    priority: 'medium',
    dueAt: addDays(2),
    linkedEntityType: 'repair',
    linkedEntityId: event.entityId,
  });
});

// ── consignment.created ──
// If expiry date set, create reminder task
eventBus.on('consignment.created', (event: DomainEvent) => {
  const { expiryDate } = event.payload as { expiryDate?: string };
  if (expiryDate) {
    // Create reminder 7 days before expiry, or now if expiry is less than 7 days out
    const expiry = new Date(expiryDate);
    const reminder = new Date(expiry);
    reminder.setDate(reminder.getDate() - 7);
    const dueAt = reminder > new Date() ? reminder.toISOString() : addDays(1);

    insertTask({
      title: 'Consignment expiry reminder',
      description: `Consignment ${event.payload.consignmentNumber || event.entityId} expires on ${expiryDate.split('T')[0]}. Review status and decide on renewal or return.`,
      type: 'consignment_expiry',
      priority: 'high',
      dueAt,
      linkedEntityType: 'consignment',
      linkedEntityId: event.entityId,
    });
  }
});

// ── order.arrived ──
// Create task "Notify customer"
eventBus.on('order.arrived', (event: DomainEvent) => {
  insertTask({
    title: 'Notify customer of order arrival',
    description: `Order ${event.payload.orderNumber || event.entityId} has arrived. Contact the customer to arrange collection and final payment.`,
    type: 'general',
    priority: 'high',
    dueAt: addDays(1),
    linkedEntityType: 'order',
    linkedEntityId: event.entityId,
  });
});

// ── customer.dormant ──
// Create reactivation task
eventBus.on('customer.dormant', (event: DomainEvent) => {
  insertTask({
    title: 'Reactivate dormant customer',
    description: `Customer ${event.payload.firstName || ''} ${event.payload.lastName || ''} has been marked dormant. Reach out with new arrivals or special offers.`,
    type: 'reactivation',
    priority: 'low',
    dueAt: addDays(3),
    linkedEntityType: 'customer',
    linkedEntityId: event.entityId,
  });
});

// ═══════════════════════════════════════════════════════════
// CLOSED-LOOP: Product status + stock updates
// ═══════════════════════════════════════════════════════════

// ── offer.created ──
// Mark all products in the offer as "offered"
eventBus.on('offer.created', (event: DomainEvent) => {
  const db = getDatabase();
  const now = new Date().toISOString();
  const offerLines = query(
    `SELECT product_id FROM offer_lines WHERE offer_id = ?`,
    [event.entityId]
  );
  for (const line of offerLines) {
    db.run(
      `UPDATE products SET stock_status = 'offered', last_offer_price = (SELECT unit_price FROM offer_lines WHERE offer_id = ? AND product_id = ?), updated_at = ? WHERE id = ? AND stock_status = 'in_stock'`,
      [event.entityId, line.product_id, now, line.product_id]
    );
  }
  if (offerLines.length > 0) saveDatabase();
});

// ── offer.rejected / offer.expired ──
// Revert products back to "in_stock" if still "offered"
eventBus.on('offer.rejected', (event: DomainEvent) => {
  revertOfferedProducts(event.entityId);
});

function revertOfferedProducts(offerId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const lines = query(`SELECT product_id FROM offer_lines WHERE offer_id = ?`, [offerId]);
  for (const line of lines) {
    db.run(
      `UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ? AND stock_status = 'offered'`,
      [now, line.product_id]
    );
  }
  if (lines.length > 0) saveDatabase();
}

// ── invoice.paid ──
// Mark products as "sold", update customer KPIs, update last_sale_price
eventBus.on('invoice.paid', (event: DomainEvent) => {
  const db = getDatabase();
  const now = new Date().toISOString();
  const branchId = getBranchId();

  // Get invoice data
  const invoiceRows = query(`SELECT * FROM invoices WHERE id = ?`, [event.entityId]);
  if (invoiceRows.length === 0) return;
  const invoice = invoiceRows[0];

  // Mark all invoice line products as "sold" — quantity-aware.
  // Bei Produkten mit quantity > 1 wird pro Line 1 Stück abgezogen; erst bei Bestand = 0 status='sold'.
  const invoiceLines = query(`SELECT product_id, unit_price FROM invoice_lines WHERE invoice_id = ?`, [event.entityId]);
  for (const line of invoiceLines) {
    db.run(
      `UPDATE products SET
         quantity = CASE WHEN COALESCE(quantity,1) > 1 THEN COALESCE(quantity,1) - 1 ELSE 0 END,
         stock_status = CASE WHEN COALESCE(quantity,1) > 1 THEN stock_status ELSE 'sold' END,
         last_sale_price = ?, updated_at = ? WHERE id = ?`,
      [line.unit_price, now, line.product_id]
    );
  }

  // Update customer KPIs
  const customerId = invoice.customer_id as string;
  const grossAmount = (invoice.gross_amount as number) || 0;
  const margin = (invoice.margin_snapshot as number) || 0;

  db.run(
    `UPDATE customers SET
      total_revenue = total_revenue + ?,
      total_profit = total_profit + ?,
      purchase_count = purchase_count + 1,
      last_purchase_at = ?,
      last_contact_at = ?,
      updated_at = ?
    WHERE id = ?`,
    [grossAmount, margin, now, now, now, customerId]
  );

  // Auto-upgrade sales stage if needed
  const custRows = query(`SELECT sales_stage, purchase_count FROM customers WHERE id = ?`, [customerId]);
  if (custRows.length > 0 && custRows[0].sales_stage !== 'active') {
    db.run(`UPDATE customers SET sales_stage = 'active', updated_at = ? WHERE id = ?`, [now, customerId]);
  }

  saveDatabase();

  // Complete all open payment reminder tasks
  const openReminders = query(
    `SELECT id FROM tasks WHERE branch_id = ? AND linked_entity_type = 'invoice' AND linked_entity_id = ? AND type = 'payment_reminder' AND status != 'completed' AND status != 'cancelled'`,
    [branchId, event.entityId]
  );
  for (const row of openReminders) {
    db.run(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`, [now, row.id]);
  }
  if (openReminders.length > 0) saveDatabase();

  // Auto-complete linked Orders (Plan §Order §Auto): Voll bezahlte Rechnung für eine Order → Order completed.
  const linkedOrders = query(
    `SELECT id, status FROM orders WHERE invoice_id = ? AND status != 'cancelled' AND status != 'completed'`,
    [event.entityId]
  );
  for (const row of linkedOrders) {
    db.run(
      `UPDATE orders SET status = 'completed', fully_paid = 1,
         actual_delivery = COALESCE(actual_delivery, ?), updated_at = ? WHERE id = ?`,
      [now.split('T')[0], now, row.id]
    );
  }
  if (linkedOrders.length > 0) saveDatabase();

  // Plan §8 #1 — Linked Repairs als PAID markieren wenn die Rechnung voll bezahlt ist.
  const linkedRepairs = query(
    `SELECT id, charge_to_customer FROM repairs WHERE invoice_id = ? AND customer_payment_status != 'PAID'`,
    [event.entityId]
  );
  for (const row of linkedRepairs) {
    const charge = (row.charge_to_customer as number) || 0;
    db.run(
      `UPDATE repairs SET customer_paid_amount = ?, customer_payment_status = 'PAID',
         customer_payment_date = ?, updated_at = ? WHERE id = ?`,
      [charge, now.split('T')[0], now, row.id]
    );
  }
  if (linkedRepairs.length > 0) saveDatabase();
});

// ── agent_transfer.sold ──
// Update agent stats
eventBus.on('agent_transfer.sold', (event: DomainEvent) => {
  const db = getDatabase();
  const now = new Date().toISOString();
  const { actualPrice, commission } = event.payload as { actualPrice?: number; commission?: number };

  // Get agent ID from transfer
  const transferRows = query(`SELECT agent_id FROM agent_transfers WHERE id = ?`, [event.entityId]);
  if (transferRows.length === 0) return;
  const agentId = transferRows[0].agent_id as string;

  db.run(
    `UPDATE agents SET total_sales = total_sales + ?, total_commission = total_commission + ?, updated_at = ? WHERE id = ?`,
    [actualPrice || 0, commission || 0, now, agentId]
  );
  saveDatabase();
});

// (product.created customer matching is handled in the combined handler above)

// ═══════════════════════════════════════════════════════════
// STOCK VALUE: Lagerdauer berechnen (called periodically or on load)
// ═══════════════════════════════════════════════════════════

export function updateDaysInStock(): void {
  const db = getDatabase();
  const branchId = getBranchId();
  const now = new Date();

  const inStock = query(
    `SELECT id, purchase_date FROM products WHERE branch_id = ? AND stock_status = 'in_stock' AND purchase_date IS NOT NULL`,
    [branchId]
  );

  for (const p of inStock) {
    const purchaseDate = new Date(p.purchase_date as string);
    const days = Math.floor((now.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24));
    db.run(`UPDATE products SET days_in_stock = ? WHERE id = ?`, [days, p.id]);
  }

  if (inStock.length > 0) saveDatabase();
}

// Export init function
export function initAutomation(): void {
  // Update days in stock on startup
  try { updateDaysInStock(); } catch { /* not authenticated yet */ }
  // Daily-Sweep (Plan §Automation §2): beim Start + alle 6h — Offers/Consignments expired, Reminder-Tasks.
  import('./daily-sweep').then(({ runDailySweep }) => {
    try { runDailySweep(); } catch { /* not authenticated yet */ }
    setInterval(() => {
      try { runDailySweep(); } catch { /* ignore */ }
    }, 6 * 60 * 60 * 1000);
  });
  console.log('[Automation] Handlers registered');
}
