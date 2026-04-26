// ═══════════════════════════════════════════════════════════
// LATAIF — Change Tracking Hook
// Call after every DB write to:
//   1) queue for LAN sync (existing)
//   2) write an Audit-Log entry (Plan §History/Audit §16)
// ═══════════════════════════════════════════════════════════

import { trackChange } from './sync-service';
import { logAudit } from '@/core/audit/audit-log';

// Map table names → logical module for the audit log (Plan §3 lists modules).
function moduleForTable(table: string): string {
  const map: Record<string, string> = {
    products: 'Product',
    categories: 'Product',
    offers: 'Sales',
    offer_lines: 'Sales',
    invoices: 'Sales',
    invoice_lines: 'Sales',
    payments: 'Payments',
    order_payments: 'Payments',
    orders: 'Orders',
    repairs: 'Repair',
    consignments: 'Commission',
    agents: 'Agent',
    agent_transfers: 'Agent',
    debts: 'Loan',
    debt_payments: 'Loan',
    tax_payments: 'Tax',
    customers: 'Customer',
    customer_messages: 'Customer',
    settings: 'Settings',
    tenants: 'Settings',
    branches: 'Settings',
    users: 'Users',
    user_branches: 'Users',
    precious_metals: 'Metals',
    tasks: 'Tasks',
    documents: 'Documents',
    purchases: 'Purchase',
    purchase_lines: 'Purchase',
    purchase_returns: 'Purchase',
    suppliers: 'Supplier',
    expenses: 'Expense',
    production_records: 'Production',
    partner_transactions: 'Partner',
    sales_returns: 'Sales',
  };
  return map[table] || table;
}

export function trackInsert(table: string, id: string, data: Record<string, unknown>) {
  trackChange(table, id, 'insert', data);
  logAudit({
    module: moduleForTable(table),
    entityType: table,
    entityId: id,
    action: 'CREATE',
    newValue: data,
  });
}

export function trackUpdate(table: string, id: string, data: Record<string, unknown>) {
  trackChange(table, id, 'update', data);
  // Plan §6: jedes geänderte Feld als eigener Eintrag.
  // Hier haben wir nur `data` (neue Werte), ohne "before" — daher eine UPDATE-Zeile
  // mit dem gesamten Diff-Objekt. Stores können logUpdateDiff nutzen für Feld-Granularität.
  for (const [key, val] of Object.entries(data)) {
    logAudit({
      module: moduleForTable(table),
      entityType: table,
      entityId: id,
      action: 'UPDATE',
      field: key,
      newValue: val,
    });
  }
}

export function trackDelete(table: string, id: string) {
  trackChange(table, id, 'delete', {});
  logAudit({
    module: moduleForTable(table),
    entityType: table,
    entityId: id,
    action: 'DELETE',
  });
}

// Explicit status-change log (Plan §5 — STATUS_CHANGE)
export function trackStatusChange(table: string, id: string, oldStatus: string, newStatus: string) {
  logAudit({
    module: moduleForTable(table),
    entityType: table,
    entityId: id,
    action: 'STATUS_CHANGE',
    field: 'status',
    oldValue: oldStatus,
    newValue: newStatus,
  });
}

// Explicit payment log (Plan §5 — PAYMENT)
export function trackPayment(entityTable: string, entityId: string, amount: number, method: string, currency = 'BHD') {
  logAudit({
    module: moduleForTable(entityTable),
    entityType: entityTable,
    entityId,
    action: 'PAYMENT',
    newValue: { amount, method, currency },
  });
}

// Explicit refund log (Plan §5 — REFUND)
export function trackRefund(entityTable: string, entityId: string, amount: number, method: string, currency = 'BHD') {
  logAudit({
    module: moduleForTable(entityTable),
    entityType: entityTable,
    entityId,
    action: 'REFUND',
    newValue: { amount, method, currency },
  });
}
