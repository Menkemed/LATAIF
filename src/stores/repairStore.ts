import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Repair, RepairStatus, RepairLine, RepairLineStatus, RepairWorkType } from '@/core/models/types';
import { canonicalRepairStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber, getNextDocumentNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { formatRepairLineNumber } from '@/core/repairs/line-numbering';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { useInvoiceStore } from '@/stores/invoiceStore';
import {
  postRepairPayment,
  postExpense,
  postExpensePayment,
  postExpenseCancelled,
  reverseSource,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';
import type { Expense } from '@/core/models/types';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

// Hybrid-Margin-Bug: Bei Hybrid fließen BEIDE Kostenarten ein — der interne Anteil
// (internalCost) und der externe Workshop-Anteil (estimatedCost). Bei pure
// internal/external wird der relevante Cost-Wert vom Form bereits in internalCost
// gespiegelt, deshalb reicht dort internalCost allein.
//
// Plan repair-multi-supplier: optionaler `lineTotal`-Param erfasst die SUM aller
// OPEN repair_lines.cost_amount fuer Multi-Line-Repairs. Wenn >0, ersetzt er
// die Legacy-estimatedCost-Logik. Call-Sites die noch ohne Lines arbeiten
// (Default=0) verhalten sich rueckwaerts-kompatibel.
export function computeRepairTotalCost(
  r: Pick<Repair, 'repairType' | 'internalCost' | 'estimatedCost'>,
  lineTotal = 0,
): number {
  const internal = r.internalCost || 0;
  if (lineTotal > 0) {
    if (r.repairType === 'hybrid') return internal + lineTotal;
    if (r.repairType === 'external') return lineTotal;
    return internal; // internal-only sollte keine Lines haben
  }
  // Legacy single-supplier path
  if (r.repairType === 'hybrid') {
    return internal + (r.estimatedCost || 0);
  }
  return internal;
}

// Helper fuer das Multi-Line-Total — wird sowohl in Store-internen Aufrufen
// als auch von externen Konsumenten (ProductDetail, RepairDetail) genutzt.
export function sumOpenRepairLineCosts(repairId: string): number {
  try {
    const rows = query(
      `SELECT COALESCE(SUM(cost_amount), 0) AS total
         FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'`,
      [repairId]
    );
    return (rows[0]?.total as number) || 0;
  } catch { return 0; }
}

// Plan §Repair §Workshop-as-Supplier — Late-Bind Reconciliation:
// Wenn der Workshop-Supplier auf einem External/Hybrid-Repair erst NACH dem READY-
// Uebergang per Edit gesetzt wird, hat die existierende RepairCosts-Expense
// supplier_id=NULL und (sofern bereits Ledger-Eintraege vorhanden) eine A/P-Buchung
// ohne Counterparty. Damit erscheint das Payable nicht im Supplier-Dashboard und
// supplierBalance() liefert 0.
//
// Diese Funktion zieht alles nach:
//   1. expenses.supplier_id wird gesetzt (+ optional Description angereichert).
//   2. Falls noch keine Ledger-Eintraege existieren -> postExpense laeuft frisch
//      mit Supplier-Counterparty.
//   3. Falls bereits Eintraege existieren (z.B. via Backfill) und noch nicht
//      reversed -> reverseSource + postExpense erneut mit korrektem Counterparty.
//   4. Existierende expense_payments (Teil/Vollzahlungen) werden analog re-posted,
//      damit auch die A/P-DEBIT-Seite den richtigen Supplier traegt.
//
// Limitation: reverseSource laesst nur EINEN Reversal pro Source zu. Mehrfache
// Supplier-Wechsel nach diesem Reconcile sind nicht abgedeckt — fuer den vom User
// gemeldeten Fall (NULL -> Supplier) reicht das. Multi-Step waere ein eigener Slice.
function reconcileRepairSupplier(repairId: string, supplierId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  const expRows = query(
    `SELECT * FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'`,
    [repairId]
  );
  if (expRows.length === 0) return;

  const expRow = expRows[0];
  const expenseId = expRow.id as string;
  const previousSupplierId = (expRow.supplier_id as string | null) || null;
  if (previousSupplierId === supplierId) return;

  // Description optional anreichern (nur wenn noch keine " · ..."-Sektion drin).
  let description = (expRow.description as string | null) || '';
  const sNameRow = query('SELECT name FROM suppliers WHERE id = ?', [supplierId]);
  const supplierName = sNameRow.length > 0 ? (sNameRow[0].name as string) : '';
  if (supplierName && !description.includes(supplierName)) {
    description = description.replace(/\s+·\s+.*$/, '') + ' · ' + supplierName;
  }

  db.run(
    `UPDATE expenses SET supplier_id = ?, description = ? WHERE id = ?`,
    [supplierId, description, expenseId]
  );
  saveDatabase();
  trackUpdate('expenses', expenseId, { supplierId, description });

  // Ledger neu ausrichten.
  const expense: Expense = {
    id: expenseId,
    expenseNumber: expRow.expense_number as string,
    branchId: expRow.branch_id as string,
    category: (expRow.category as Expense['category']) || 'RepairCosts',
    amount: Number(expRow.amount || 0),
    paidAmount: Number(expRow.paid_amount || 0),
    paymentMethod: (expRow.payment_method as 'cash' | 'bank') || 'bank',
    expenseDate: expRow.expense_date as string,
    description,
    relatedModule: 'repair',
    relatedEntityId: repairId,
    supplierId,
    status: (expRow.status as Expense['status']) || 'PENDING',
    createdAt: expRow.created_at as string,
  };

  safePost(`reconcileRepairSupplier:expense(${expenseId})`, () => {
    if (hasLedgerEntries('EXPENSE', expenseId) && !hasReversalFor('EXPENSE', expenseId)) {
      reverseSource('EXPENSE', expenseId, now);
    }
    postExpense(expense);
  });

  // Bestehende expense_payments mit umhaengen.
  const paymentRows = query(
    `SELECT * FROM expense_payments WHERE expense_id = ? ORDER BY created_at ASC`,
    [expenseId]
  );
  for (const pRow of paymentRows) {
    const payId = pRow.id as string;
    const payAmt = Number(pRow.amount || 0);
    if (payAmt <= 0) continue;
    safePost(`reconcileRepairSupplier:payment(${payId})`, () => {
      if (hasLedgerEntries('EXPENSE_PAYMENT', payId) && !hasReversalFor('EXPENSE_PAYMENT', payId)) {
        reverseSource('EXPENSE_PAYMENT', payId, now);
      }
      postExpensePayment(
        {
          id: payId,
          expenseId,
          amount: payAmt,
          method: ((pRow.method as 'cash' | 'bank') || 'bank'),
          paidAt: pRow.paid_at as string,
          createdAt: (pRow.created_at as string) || now,
          note: (pRow.note as string | null) || undefined,
        },
        supplierId
      );
    });
  }

  eventBus.emit('repair.supplier_linked' as any, 'repair', repairId, {
    supplierId, expenseId,
  });
}

// Plan §Repair §Own-Item: Sentinel-Customer pro Branch, der intern alle Own-Item-
// Repairs als customer_id-FK trägt. Wird in keinem UI-Customer-View gelistet
// (customerStore filtert sys-* heraus). Damit bleiben FK-Constraints sauber, ohne
// dass der User je einen "Own Shop"-Fake-Client sieht.
export function getOrCreateOwnShopCustomerId(branchId: string): string {
  const db = getDatabase();
  const id = `sys-own-shop-${branchId}`;
  const existing = query('SELECT id FROM customers WHERE id = ?', [id]);
  if (existing.length === 0) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO customers (id, branch_id, first_name, last_name, country, language,
        vip_level, preferences, customer_type, sales_stage,
        total_revenue, total_profit, purchase_count, notes, created_at, updated_at)
       VALUES (?, ?, 'Own', 'Shop', 'BH', 'en', 0, '[]', 'SYSTEM', 'lead', 0, 0, 0,
               'Internal sentinel — never shown in UI.', ?, ?)`,
      [id, branchId, now, now]
    );
    saveDatabase();
  }
  return id;
}

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

// Plan repair-multi-supplier — Stage-based Commit:
// Postet fuer jede OPEN Line ohne Expense_id eine neue Expense + Ledger-Eintrag.
// Wird beim IN_PROGRESS/SENT_TO_WORKSHOP-Uebergang ausgefuehrt sowie wenn nach
// diesen Stages weitere Lines hinzugefuegt werden. Idempotent: ueberspringt
// Lines die bereits einen expense_id haben.
function commitRepairLineExpenses(repairId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  // Repair-Header laden fuer Description + Repair-Number
  const repairRows = query(
    `SELECT id, branch_id, repair_number, internal_paid_from FROM repairs WHERE id = ?`,
    [repairId]
  );
  if (repairRows.length === 0) return;
  const repair = repairRows[0];
  const repairNumber = repair.repair_number as string;
  const internalPaidFrom = repair.internal_paid_from as string | null;
  let branchId: string, userId: string;
  try { branchId = currentBranchId(); userId = currentUserId(); }
  catch { branchId = (repair.branch_id as string) || 'branch-main'; userId = 'user-owner'; }

  // OPEN-Lines mit Supplier ohne Expense
  const lineRows = query(
    `SELECT id, position, supplier_id, work_type, description, cost_amount
       FROM repair_lines
       WHERE repair_id = ? AND status = 'OPEN' AND supplier_id IS NOT NULL AND expense_id IS NULL
         AND cost_amount > 0
       ORDER BY position`,
    [repairId]
  );
  if (lineRows.length === 0) return;

  for (const lr of lineRows) {
    const lineId = lr.id as string;
    const position = (lr.position as number) || 0;
    const supplierId = lr.supplier_id as string;
    const workType = (lr.work_type as string) || 'service';
    const description = (lr.description as string) || '';
    const cost = (lr.cost_amount as number) || 0;
    if (cost <= 0) continue;

    const expenseId = uuid();
    const expenseNumber = getNextDocumentNumber('EXP');
    const method = (internalPaidFrom as 'cash' | 'bank' | 'benefit' | null) || 'bank';
    const expStatus = 'PENDING' as const;

    // Supplier-Label fuer Description
    let supplierLabel = '';
    try {
      const sRow = query(`SELECT name FROM suppliers WHERE id = ?`, [supplierId]);
      if (sRow.length > 0) supplierLabel = ' · ' + (sRow[0].name as string);
    } catch { /* */ }

    // v0.1.48 — Sub-Number REP-000023-L1 statt nur REP-000023 fuer Audit-Klarheit
    const lineLabel = formatRepairLineNumber(repairNumber, position);
    const desc = `${lineLabel} · ${workType}${description ? ' · ' + description : ''}${supplierLabel}`;
    db.run(
      `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
         expense_date, description, related_module, related_entity_id, supplier_id, status, created_at, created_by)
       VALUES (?, ?, ?, 'RepairCosts', ?, 0, ?, ?, ?, 'repair', ?, ?, ?, ?, ?)`,
      [expenseId, branchId, expenseNumber, cost, method,
       now.split('T')[0], desc, repairId, supplierId, expStatus, now, userId]
    );
    trackInsert('expenses', expenseId, {
      category: 'RepairCosts', amount: cost, repairId, repairLineId: lineId,
      supplierId, status: expStatus,
    });

    // Line ↔ Expense linken
    db.run(
      `UPDATE repair_lines SET expense_id = ?, updated_at = ? WHERE id = ?`,
      [expenseId, now, lineId]
    );
    trackUpdate('repair_lines', lineId, { expenseId });

    // Ledger-Post (idempotent via hasLedgerEntries-Guard)
    const expenseRecord: Expense = {
      id: expenseId, expenseNumber, branchId, category: 'RepairCosts',
      amount: cost, paidAmount: 0, paymentMethod: method,
      expenseDate: now.split('T')[0], description: desc,
      relatedModule: 'repair', relatedEntityId: repairId,
      supplierId, status: expStatus, createdAt: now,
    };
    safePost(`postExpense(${expenseId}) [repair-line-commit]`, () => {
      if (hasLedgerEntries('EXPENSE', expenseId)) return;
      postExpense(expenseRecord);
    });
  }
  saveDatabase();
}

interface RepairStore {
  repairs: Repair[];
  repairLines: RepairLine[];      // Plan repair-multi-supplier — alle Lines aller Repairs (geladen via loadRepairLines)
  loading: boolean;
  loadRepairs: () => void;
  loadRepairLines: () => void;
  getRepair: (id: string) => Repair | undefined;
  getRepairLines: (repairId: string) => RepairLine[];
  createRepair: (data: Partial<Repair>) => Repair;
  updateRepair: (id: string, data: Partial<Repair>) => void;
  updateStatus: (id: string, status: RepairStatus) => void;
  deleteRepair: (id: string) => void;
  getNextRepairNumber: () => string;
  generateVoucherCode: () => string;
  // Plan repair-multi-supplier — Line-CRUD
  addRepairLine: (repairId: string, data: Partial<RepairLine>) => RepairLine;
  updateRepairLine: (lineId: string, data: Partial<RepairLine>) => void;
  cancelRepairLine: (lineId: string, notes?: string) => void;
  recomputeRepairAggregates: (repairId: string) => void;
  // Plan §8 #1 — Customer-Charge Payment-Tracking
  recordCustomerPayment: (id: string, amount: number, method: 'cash' | 'bank' | 'card', date?: string) => void;
  // User-Spec §Repair Bulk-Invoice: mehrere READY-Repairs eines Customers in
  // EINE gemeinsame Multi-Line-Invoice. Validiert atomisch: alle ready, kein
  // invoiceId, alle gleicher Customer, charge>0. Linkt invoiceId auf jedem Repair.
  createCombinedRepairInvoice: (repairIds: string[]) => { invoiceId: string };
}

function rowToRepairLine(row: Record<string, unknown>): RepairLine {
  let matDetails: import('@/core/models/types').MaterialDetails | undefined;
  try {
    const raw = row.material_details as string | null;
    if (raw) matDetails = JSON.parse(raw);
  } catch { /* */ }
  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    repairId: row.repair_id as string,
    position: (row.position as number) || 1,
    supplierId: (row.supplier_id as string) || undefined,
    workType: (row.work_type as RepairWorkType) || undefined,
    description: (row.description as string) || undefined,
    costAmount: (row.cost_amount as number) || 0,
    expenseId: (row.expense_id as string) || undefined,
    status: ((row.status as string) || 'OPEN') as RepairLineStatus,
    dueDate: (row.due_date as string) || undefined,
    notes: (row.notes as string) || undefined,
    materialKind: (row.material_kind as RepairLine['materialKind']) || undefined,
    materialDetails: matDetails,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// Reichert Lines mit Live-Payment-Daten aus der verlinkten expense an.
function enrichLineWithExpense(line: RepairLine): RepairLine {
  if (!line.expenseId) return line;
  try {
    const rows = query(
      `SELECT amount, paid_amount, status FROM expenses WHERE id = ?`,
      [line.expenseId]
    );
    if (rows.length === 0) return line;
    const paidAmount = (rows[0].paid_amount as number) || 0;
    const amount = (rows[0].amount as number) || 0;
    const status = rows[0].status as string;
    let paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' = 'UNPAID';
    if (status === 'PAID' || paidAmount >= amount - 0.0001) paymentStatus = 'PAID';
    else if (paidAmount > 0) paymentStatus = 'PARTIALLY_PAID';
    return { ...line, paidAmount, paymentStatus };
  } catch { return line; }
}

function rowToRepair(row: Record<string, unknown>): Repair {
  let itemAttrs: Record<string, string | number | boolean> = {};
  try { itemAttrs = JSON.parse((row.item_attributes as string) || '{}'); } catch { /* */ }
  return {
    id: row.id as string,
    repairNumber: row.repair_number as string,
    repairScope: ((row.repair_scope as string) === 'OWN' ? 'OWN' : 'CUSTOMER') as 'CUSTOMER' | 'OWN',
    customerId: row.customer_id as string,
    productId: row.product_id as string | undefined,
    lotId: (row.lot_id as string | null) || undefined,
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
    workshopSupplierId: (row.workshop_supplier_id as string) || undefined,
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
    staffId: (row.staff_id as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useRepairStore = create<RepairStore>((set, get) => ({
  repairs: [],
  repairLines: [],
  loading: false,

  loadRepairs: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM repairs WHERE branch_id = ? ORDER BY created_at DESC', [branchId]);
      set({ repairs: rows.map(rowToRepair), loading: false });
    } catch { set({ repairs: [], loading: false }); }
  },

  loadRepairLines: () => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT * FROM repair_lines WHERE branch_id = ? ORDER BY repair_id, position`,
        [branchId]
      );
      const lines = rows.map(rowToRepairLine).map(enrichLineWithExpense);
      set({ repairLines: lines });
    } catch { set({ repairLines: [] }); }
  },

  getRepair: (id) => get().repairs.find(r => r.id === id),
  getRepairLines: (repairId) =>
    get().repairLines.filter(l => l.repairId === repairId).sort((a, b) => a.position - b.position),

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

    // Plan §Repair §Own-Item: bei OWN-scope keinen Client erzwingen, stattdessen
    // den per-branch Sentinel verwenden. Charge/Invoice gibt es nicht.
    const scope: 'CUSTOMER' | 'OWN' = data.repairScope === 'OWN' ? 'OWN' : 'CUSTOMER';
    if (scope === 'OWN' && !data.productId) {
      throw new Error('Own-item repair requires a linked product (productId).');
    }
    const effectiveCustomerId = scope === 'OWN'
      ? getOrCreateOwnShopCustomerId(branchId)
      : data.customerId;
    if (!effectiveCustomerId) {
      throw new Error('Customer repair requires a customerId.');
    }
    // OWN-scope: explizit NULL — kein Charge-Feld in der UI rendern lassen.
    const effectiveCharge = scope === 'OWN' ? null : (data.chargeToCustomer || null);

    db.run(
      `INSERT INTO repairs (id, branch_id, repair_number, customer_id, product_id, lot_id,
        item_category_id, item_attributes, tax_scheme,
        item_brand, item_model, item_reference, item_serial, item_description,
        issue_description, diagnosis, repair_type, external_vendor, workshop_supplier_id,
        estimated_cost, internal_cost, charge_to_customer,
        status, received_at, estimated_ready, voucher_code,
        notes, images, repair_scope, staff_id, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
      [id, branchId, repairNumber, effectiveCustomerId, data.productId || null, data.lotId || null,
       data.itemCategoryId || null, JSON.stringify(data.itemAttributes || {}), data.taxScheme || 'VAT_10',
       data.itemBrand || null, data.itemModel || null, data.itemReference || null,
       data.itemSerial || null, data.itemDescription || null,
       data.issueDescription || '', data.diagnosis || null,
       data.repairType || 'internal', data.externalVendor || null, data.workshopSupplierId || null,
       data.estimatedCost || null, data.internalCost || 0, effectiveCharge,
       now, data.estimatedReady || null, voucherCode,
       data.notes || null, scope, data.staffId || null, now, now, userId]
    );

    // If linked to a product, update its status
    if (data.productId) {
      db.run(`UPDATE products SET stock_status = 'in_repair', updated_at = ? WHERE id = ?`, [now, data.productId]);
    }

    // Plan repair-multi-supplier: wenn das Form einen workshop_supplier_id +
    // estimatedCost mitgibt (Legacy-Form-Pfad), legen wir gleich eine
    // repair_lines-Zeile an damit der Datensatz konsistent ist (gleicher Effekt
    // wie die Backfill-Migration, nur fuer NEW-repairs).
    if (data.workshopSupplierId && (data.repairType === 'external' || data.repairType === 'hybrid')) {
      const lineId = uuid();
      const cost = data.repairType === 'hybrid'
        ? (data.estimatedCost || 0)
        : (data.estimatedCost || data.internalCost || 0);
      if (cost > 0) {
        db.run(
          `INSERT INTO repair_lines (id, branch_id, repair_id, position, supplier_id, work_type, cost_amount, status, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, 'service', ?, 'OPEN', ?, ?)`,
          [lineId, branchId, id, data.workshopSupplierId, cost, now, now]
        );
        trackInsert('repair_lines', lineId, {
          repairId: id, supplierId: data.workshopSupplierId, costAmount: cost, fromCreateRepair: true,
        });
      }
    }

    saveDatabase();
    trackInsert('repairs', id, { repairNumber, customerId: data.customerId });
    eventBus.emit('repair.created', 'repair', id, { customerId: data.customerId, voucherCode });
    get().loadRepairs();
    get().loadRepairLines();

    return get().getRepair(id)!;
  },

  updateRepair: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    // Snapshot fuer Late-Bind-Detection (Workshop-Supplier nachtraeglich gesetzt).
    const before = get().getRepair(id);
    const fields: string[] = [];
    const values: unknown[] = [];

    const map: Record<string, string> = {
      customerId: 'customer_id', productId: 'product_id', lotId: 'lot_id',
      itemCategoryId: 'item_category_id', taxScheme: 'tax_scheme',
      itemBrand: 'item_brand', itemModel: 'item_model', itemReference: 'item_reference',
      itemSerial: 'item_serial', itemDescription: 'item_description',
      issueDescription: 'issue_description', diagnosis: 'diagnosis',
      repairType: 'repair_type', externalVendor: 'external_vendor',
      workshopSupplierId: 'workshop_supplier_id',
      estimatedCost: 'estimated_cost', actualCost: 'actual_cost',
      internalCost: 'internal_cost', chargeToCustomer: 'charge_to_customer',
      customerPaidFrom: 'customer_paid_from', internalPaidFrom: 'internal_paid_from',
      margin: 'margin', status: 'status',
      receivedAt: 'received_at', diagnosedAt: 'diagnosed_at',
      startedAt: 'started_at', completedAt: 'completed_at',
      pickedUpAt: 'picked_up_at', estimatedReady: 'estimated_ready',
      invoiceId: 'invoice_id', notes: 'notes',
      repairScope: 'repair_scope',
      staffId: 'staff_id',
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

    // Plan §Repair §Workshop-as-Supplier: Wenn der Supplier auf einem External/
    // Hybrid-Repair erst NACH dem READY-Uebergang per Edit gesetzt wird, muss die
    // bereits angelegte RepairCosts-Expense + ihre Ledger-Buchungen auf den neuen
    // Supplier umgehaengt werden — sonst fehlt der A/P-Eintrag im Supplier-Saldo
    // und keine offene Forderung erscheint im Supplier-Dashboard.
    const supplierWasMissing = !before?.workshopSupplierId;
    const supplierNowSet = !!data.workshopSupplierId;
    const effectiveType = (data.repairType ?? before?.repairType) || 'internal';
    const isExternalOrHybrid = effectiveType === 'external' || effectiveType === 'hybrid';
    if (supplierWasMissing && supplierNowSet && isExternalOrHybrid) {
      reconcileRepairSupplier(id, data.workshopSupplierId as string);
    }

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
      case 'IN_PROGRESS': {
        updates.started_at = now;
        // Plan repair-multi-supplier — Stage-based Commit:
        // Sobald die Arbeit beginnt, werden die Supplier-Payables fuer alle
        // externen Lines gebucht. Per-Line-Expense + Ledger-Post.
        commitRepairLineExpenses(id);
        break;
      }
      case 'sent_to_workshop':
      case 'SENT_TO_WORKSHOP':
        if (!repair.startedAt) updates.started_at = now;
        // Identisch zu IN_PROGRESS — Supplier-Workshop-Forderungen jetzt sichtbar.
        commitRepairLineExpenses(id);
        break;
      case 'READY':
      case 'ready': {
        updates.completed_at = now;

        // Workshop-Fee für Supplier-A/P:
        // – Hybrid: der externe Anteil liegt explizit in estimatedCost.
        // – External: Workshop-Fee liegt in estimatedCost (oder gespiegelt in
        //   internalCost via handleCreate-Fallback). Prefer estimatedCost.
        const workshopFee =
          repair.repairType === 'hybrid'
            ? (repair.estimatedCost || 0)
            : repair.repairType === 'external'
            ? (repair.estimatedCost || repair.internalCost || 0)
            : 0;

        // Multi-Line-Total: SUM aller OPEN repair_lines. Wird sowohl fuer
        // OWN-Capitalisation als auch fuer Customer-Margin verwendet.
        const lineTotal = sumOpenRepairLineCosts(id);

        if (repair.repairScope === 'OWN') {
          // OWN-Item: gesamter Repair-Cost auf verlinkte Produkt kapitalisieren.
          // Idempotent: nur beim ersten Übergang nach READY (completedAt guard).
          if (repair.productId && !repair.completedAt) {
            const totalCost = computeRepairTotalCost(repair, lineTotal);
            if (totalCost > 0) {
              db.run(
                `UPDATE products SET purchase_price = COALESCE(purchase_price, 0) + ?, updated_at = ? WHERE id = ?`,
                [totalCost, now, repair.productId]
              );
              trackUpdate('products', repair.productId, { purchasePriceDelta: totalCost, fromRepair: id });

              // Phase 5 — Stock-Lot fuer dieses Produkt mit dem kapitalisierten
              // Repair-Cost anreichern. Strategie:
              //   1. Explizit gewaehlter Lot (repair.lotId) — User wusste welches
              //      physische Stueck er zur Repair gegeben hat.
              //   2. Fallback: aeltester ACTIVE Lot (FIFO-konsistent zum Sale-Pfad,
              //      damit die naechste Sale direkt den korrigierten Cost-Snapshot zieht).
              // Beide Pfade schreiben perPiece = totalCost / qty_remaining auf unit_cost.
              const lotRows = repair.lotId
                ? query(
                    `SELECT id, qty_remaining FROM stock_lots WHERE id = ? AND status != 'CANCELLED' AND qty_remaining > 0`,
                    [repair.lotId]
                  )
                : query(
                    `SELECT id, qty_remaining FROM stock_lots
                      WHERE product_id = ? AND status = 'ACTIVE' AND qty_remaining > 0
                      ORDER BY acquired_at ASC, id ASC LIMIT 1`,
                    [repair.productId]
                  );
              if (lotRows.length > 0) {
                const lotId = lotRows[0].id as string;
                const qtyRem = Number(lotRows[0].qty_remaining) || 1;
                const perPiece = totalCost / qtyRem;
                db.run(
                  `UPDATE stock_lots SET unit_cost = unit_cost + ? WHERE id = ?`,
                  [perPiece, lotId]
                );
              }
            }
            // Own-Item: kein Pickup-Schritt — Produkt geht direkt zurück in Bestand.
            db.run(
              `UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
              [now, repair.productId]
            );
          }
          // KEIN break hier — Expense-Block unten gilt auch für OWN wenn Supplier verlinkt.
        } else {
          // CUSTOMER-scope: Margin berechnen — beruecksichtigt Multi-Line-Kosten.
          if (repair.chargeToCustomer) {
            const totalCost = computeRepairTotalCost(repair, lineTotal);
            if (totalCost > 0) {
              updates.margin = repair.chargeToCustomer - totalCost;
            }
          }
        }

        // Plan §Repair §9 + §Expenses §8 + §Workshop-as-Supplier:
        // Expense für Workshop-Fee (Supplier-A/P) automatisch buchen.
        // – CUSTOMER-scope: immer wenn externe/hybride Kosten vorhanden (P&L + Supplier-Bilanz).
        // – OWN-scope: nur wenn Supplier verlinkt (reine A/P-Erfassung für Supplier-Bilanz;
        //   Kosten sind bereits in product.purchase_price kapitalisiert).
        //
        // Plan repair-multi-supplier: Bei Multi-Line-Repair (lineTotal > 0) sind
        // die Expenses bereits per-Line beim IN_PROGRESS-Stage erzeugt worden.
        // Wir ueberspringen den Legacy-Single-Expense-Pfad damit kein Duplikat
        // entsteht.
        const isExternalOrHybrid = repair.repairType === 'external' || repair.repairType === 'hybrid';
        const expenseNeeded = isExternalOrHybrid
          && workshopFee > 0
          && lineTotal === 0
          && (repair.repairScope !== 'OWN' || !!repair.workshopSupplierId);

        if (expenseNeeded) {
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
            const expStatus = repair.internalPaidFrom ? 'PAID' : 'PENDING';
            let workshopLabel = '';
            if (repair.workshopSupplierId) {
              const sRow = query(`SELECT name FROM suppliers WHERE id = ?`, [repair.workshopSupplierId]);
              if (sRow.length > 0) workshopLabel = ' · ' + (sRow[0].name as string);
            }
            if (!workshopLabel && repair.externalVendor) workshopLabel = ' · ' + repair.externalVendor;
            const paidAmount = expStatus === 'PAID' ? workshopFee : 0;
            db.run(
              `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
                expense_date, description, related_module, related_entity_id, supplier_id, status, created_at, created_by)
               VALUES (?, ?, ?, 'RepairCosts', ?, ?, ?, ?, ?, 'repair', ?, ?, ?, ?, ?)`,
              [expenseId, branchId, expenseNumber, workshopFee, paidAmount, method,
               now.split('T')[0],
               `External repair ${repair.repairNumber}${workshopLabel}`,
               id, repair.workshopSupplierId || null, expStatus, now, userId]
            );
            trackInsert('expenses', expenseId, {
              category: 'RepairCosts', amount: workshopFee, repairId: id,
              supplierId: repair.workshopSupplierId, status: expStatus,
            });

            // Ohne diesen Post wuerde A/P im Ledger fehlen → Supplier-Outstanding
            // zeigt zu wenig (Bug v0.1.25, sichtbar an „ali gold" Detail-Page).
            const expenseDescription = `External repair ${repair.repairNumber}${workshopLabel}`;
            const expenseRecord: Expense = {
              id: expenseId,
              expenseNumber,
              branchId,
              category: 'RepairCosts',
              amount: workshopFee,
              paidAmount,
              paymentMethod: method,
              expenseDate: now.split('T')[0],
              description: expenseDescription,
              relatedModule: 'repair',
              relatedEntityId: id,
              supplierId: repair.workshopSupplierId,
              status: expStatus as Expense['status'],
              createdAt: now,
            };
            safePost(`postExpense(${expenseId}) [repair-ready]`, () => {
              if (hasLedgerEntries('EXPENSE', expenseId)) return;
              postExpense(expenseRecord);
            });
            if (expStatus === 'PAID' && paidAmount > 0) {
              const payId = uuid();
              db.run(
                `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, note, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [payId, expenseId, paidAmount, method, now.split('T')[0], 'Auto-paid on repair ready', now]
              );
              trackInsert('expense_payments', payId, { expenseId, amount: paidAmount, method });
              safePost(`postExpensePayment(${payId}) [repair-ready]`, () => {
                if (hasLedgerEntries('EXPENSE_PAYMENT', payId)) return;
                postExpensePayment(
                  {
                    id: payId, expenseId, amount: paidAmount,
                    method, paidAt: now.split('T')[0], createdAt: now,
                    note: 'Auto-paid on repair ready',
                  },
                  repair.workshopSupplierId
                );
              });
            }
          }
        }
        break;
      }
      case 'picked_up':
      case 'DELIVERED': {
        // Plan §Repair §Pickup ↔ Payment (User-Spec): Pickup und Bezahlung sind
        // ORTHOGONAL — beide unabhängig setzbar. Kein Gate mehr; ein Klient kann
        // die Ware abholen, bevor die Invoice voll bezahlt ist (offene Forderung
        // bleibt sichtbar in der Invoice + Payables).
        updates.picked_up_at = now;
        if (repair.productId) {
          db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`, [now, repair.productId]);
        }
        break;
      }
      case 'returned':
      case 'cancelled':
      case 'CANCELLED': {
        // User-Spec §Repair Return: Ware ohne Reparatur an Kunden zurück. Terminal
        // wie picked_up — wenn ein Produkt verlinkt war, geht es zurück in den Bestand.
        updates.completed_at = now;
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
      returned: 'repair.returned',
    };
    if (eventMap[status]) {
      eventBus.emit(eventMap[status] as any, 'repair', id, { status, customerId: repair.customerId });
    }

    get().loadRepairs();
    // Plan repair-multi-supplier: nach Stage-Commits (IN_PROGRESS/SENT_TO_WORKSHOP)
    // wurden Lines mit expense_id verlinkt — Store muss neu lesen damit subsequent
    // updateRepairLine / Detail-Page Anzeige die frischen expense_id-Werte sehen.
    get().loadRepairLines();
  },

  deleteRepair: (id) => {
    const db = getDatabase();
    const repair = get().getRepair(id);
    // Restore product status if needed
    if (repair?.productId && repair.status !== 'picked_up') {
      db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), repair.productId]);
    }
    // Auto-erzeugte Repair-Cost-Expenses VOR dem Cancel einsammeln, damit wir sie
    // anschliessend gezielt im Ledger reverten koennen.
    const linkedExpenses = query(
      `SELECT id, expense_number, branch_id, category, amount, paid_amount, payment_method,
              expense_date, description, related_module, related_entity_id, supplier_id, status, created_at
         FROM expenses WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'`,
      [id]
    );
    db.run(
      `UPDATE expenses SET status = 'CANCELLED'
       WHERE related_module = 'repair' AND related_entity_id = ? AND status != 'CANCELLED'`,
      [id]
    );
    db.run(`DELETE FROM repairs WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('repairs', id);

    // Reverse fuer jeden zugehoerigen Workshop-Expense — sonst bleibt A/P-Buchung
    // im Ledger trotz geloeschtem Repair stehen (Supplier-Saldo zu hoch).
    for (const er of linkedExpenses) {
      const expId = er.id as string;
      const expForReverse: Expense = {
        id: expId,
        expenseNumber: er.expense_number as string,
        branchId: er.branch_id as string,
        category: (er.category as Expense['category']) || 'RepairCosts',
        amount: Number(er.amount || 0),
        paidAmount: Number(er.paid_amount || 0),
        paymentMethod: (er.payment_method as 'cash' | 'bank') || 'bank',
        expenseDate: er.expense_date as string,
        description: er.description as string,
        relatedModule: 'repair',
        relatedEntityId: id,
        supplierId: (er.supplier_id as string) || undefined,
        status: er.status as Expense['status'],
        createdAt: er.created_at as string,
      };
      safePost(`postExpenseCancelled(${expId}) [repair-delete]`, () => {
        if (!hasLedgerEntries('EXPENSE', expId)) return;
        if (hasReversalFor('EXPENSE', expId)) return;
        postExpenseCancelled(expForReverse);
      });
    }

    // Plan repair-multi-supplier — Cascade auf Gold-Buckets:
    // OPEN gold_payables + customer_gold_credits, die diesem Repair entstammen,
    // werden gecancelled (kein Ledger-Effekt — Gold ist nicht im BHD-Ledger).
    // FULFILLED Eintraege bleiben unangetastet (sind bereits abgeschlossen).
    const nowDel = new Date().toISOString();
    db.run(
      `UPDATE gold_payables SET status = 'CANCELLED', notes = COALESCE(notes, '') || ' · Repair deleted',
         updated_at = ? WHERE source_repair_id = ? AND status = 'OPEN'`,
      [nowDel, id]
    );
    db.run(
      `UPDATE customer_gold_credits SET status = 'CANCELLED', notes = COALESCE(notes, '') || ' · Repair deleted',
         updated_at = ? WHERE source_repair_id = ? AND status = 'OPEN'`,
      [nowDel, id]
    );
    saveDatabase();

    get().loadRepairs();
    get().loadRepairLines();
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

    // ZIEL.md §3a — Repair-Customer-Payment ans Ledger.
    // Nur wenn KEINE Invoice gekoppelt ist — sonst läuft die Bezahlung über
    // invoice_payments (matcht bankingStore-Filter `if (r.invoice_id) continue`).
    if (!r.invoiceId) {
      const paymentId = uuid();
      safePost(`postRepairPayment(${paymentId})`, () => {
        if (hasLedgerEntries('REPAIR_PAYMENT', paymentId)) return;
        postRepairPayment({
          id: paymentId, repairId: id, amount, method,
          paidAt: payDate, customerId: r.customerId,
        });
      });
    }
  },

  createCombinedRepairInvoice: (repairIds) => {
    if (!repairIds || repairIds.length === 0) {
      throw new Error('No repairs selected.');
    }

    // Atomische Validation VOR jeder Mutation — sonst halb-erzeugte Invoice.
    const reps = repairIds.map(rid => {
      const r = get().getRepair(rid);
      if (!r) throw new Error(`Repair ${rid} not found.`);
      if (r.status !== 'ready' && r.status !== 'READY') {
        throw new Error(`Repair ${r.repairNumber} is not READY — only ready repairs can be combined.`);
      }
      if (r.invoiceId) {
        throw new Error(`Repair ${r.repairNumber} is already linked to an invoice.`);
      }
      if (!r.chargeToCustomer || r.chargeToCustomer <= 0) {
        throw new Error(`Repair ${r.repairNumber} has no charge — nothing to invoice.`);
      }
      return r;
    });

    const customerId = reps[0].customerId;
    if (reps.some(r => r.customerId !== customerId)) {
      throw new Error('All selected repairs must belong to the same client.');
    }

    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }
    const productId = getOrCreateRepairServiceProductId(branchId);

    // Pro Repair eine Invoice-Line — chargeToCustomer ist gross-incl-VAT je nach
    // taxScheme dekomponiert. So bleibt Mixed-Scheme (eine Repair VAT_10, andere
    // ZERO) korrekt aggregiert.
    //
    // Plan repair-multi-supplier: purchase_price der Invoice-Line MUSS alle
    // Cost-Bestandteile enthalten (internalCost + SUM externe Lines), sonst
    // ergibt die Gross-Margin auf dem Invoice ein zu hohes Profit (Bug-Fix
    // gegen das Stille-Drift-Risiko aus dem Plan-Review).
    const lines = reps.map(r => {
      const scheme = r.taxScheme === 'ZERO' ? 'ZERO' : 'VAT_10';
      const rate = scheme === 'VAT_10' ? 10 : 0;
      const gross = r.chargeToCustomer || 0;
      const net = scheme === 'VAT_10' ? gross / (1 + rate / 100) : gross;
      const vat = gross - net;
      const externalLineTotal = sumOpenRepairLineCosts(r.id);
      const fullCost = (r.internalCost || 0) + externalLineTotal;
      return {
        productId,
        unitPrice: net,
        purchasePrice: fullCost,
        taxScheme: scheme,
        vatRate: rate,
        vatAmount: vat,
        lineTotal: gross,
      };
    });

    const refs = reps.map(r => r.repairNumber).join(', ');
    const invoice = useInvoiceStore.getState().createDirectInvoice(
      customerId,
      lines,
      `Combined Repair Service · ${refs}`,
      undefined,
      'repair',
    );

    // Pro Repair invoiceId koppeln. updateRepair lädt bereits neu am Ende.
    for (const r of reps) {
      get().updateRepair(r.id, { invoiceId: invoice.id });
    }

    eventBus.emit('repair.combined_invoice_created' as any, 'repair', reps[0].id, {
      invoiceId: invoice.id, repairIds: reps.map(r => r.id),
    });

    return { invoiceId: invoice.id };
  },

  // ─── Repair-Lines CRUD (Plan repair-multi-supplier) ───

  addRepairLine: (repairId, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    // Next position = max existing + 1
    const existingRows = query(
      `SELECT COALESCE(MAX(position), 0) AS max_pos FROM repair_lines WHERE repair_id = ?`,
      [repairId]
    );
    const nextPos = (existingRows[0]?.max_pos as number || 0) + 1;
    const id = uuid();
    // v0.2.1 — Material-Lines (Diamond/Stone/Gold) bekommen material_kind +
    // material_details JSON. work_type wird 'material' wenn Material gesetzt ist.
    const matJson = data.materialDetails ? JSON.stringify(data.materialDetails) : null;
    db.run(
      `INSERT INTO repair_lines (id, branch_id, repair_id, position, supplier_id, work_type, description,
         cost_amount, expense_id, status, due_date, notes, material_kind, material_details, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'OPEN', ?, ?, ?, ?, ?, ?)`,
      [
        id, branchId, repairId, nextPos,
        data.supplierId || null, data.workType || null, data.description || null,
        data.costAmount || 0, data.dueDate || null, data.notes || null,
        data.materialKind || null, matJson, now, now,
      ]
    );
    trackInsert('repair_lines', id, {
      repairId, supplierId: data.supplierId, costAmount: data.costAmount, workType: data.workType,
      materialKind: data.materialKind,
    });
    saveDatabase();
    get().loadRepairLines();
    get().recomputeRepairAggregates(repairId);

    // Plan repair-multi-supplier — Stage-based Commit: wenn der Repair schon
    // ueber DRAFT/RECEIVED hinaus ist, wird die neue Line sofort als
    // Supplier-Forderung gebucht (analog zur READY-Auto-Expense).
    const repair = get().getRepair(repairId);
    if (repair) {
      const canon = canonicalRepairStatus(repair.status);
      const committingStages: string[] = ['IN_PROGRESS', 'SENT_TO_WORKSHOP', 'READY', 'DELIVERED'];
      if (committingStages.includes(canon)) {
        commitRepairLineExpenses(repairId);
        get().loadRepairLines();
      }
    }
    return get().repairLines.find(l => l.id === id)!;
  },

  updateRepairLine: (lineId, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const line = get().repairLines.find(l => l.id === lineId);
    if (!line) throw new Error(`Repair-Line ${lineId} nicht gefunden`);

    // Salesforce-Stil: Wenn die linkierte Expense bereits eine Zahlung hat,
    // duerfen Cost/Supplier NICHT direkt geaendert werden — User muss Cancel+Replace.
    if (line.expenseId) {
      const expRows = query(
        `SELECT COALESCE(paid_amount, 0) AS paid FROM expenses WHERE id = ?`,
        [line.expenseId]
      );
      const paid = (expRows[0]?.paid as number) || 0;
      const wantsCriticalChange = data.costAmount !== undefined && data.costAmount !== line.costAmount
        || (data.supplierId !== undefined && data.supplierId !== line.supplierId);
      if (paid > 0 && wantsCriticalChange) {
        throw new Error(
          'Cost/Supplier dieser Zeile kann nicht editiert werden — Zahlung bereits gebucht. ' +
          'Nutze "Cancel + Replace" stattdessen.'
        );
      }
    }

    const fields: string[] = [];
    const params: unknown[] = [];
    const map: Record<string, string> = {
      supplierId: 'supplier_id', workType: 'work_type', description: 'description',
      costAmount: 'cost_amount', dueDate: 'due_date', notes: 'notes', status: 'status',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k];
      if (col) { fields.push(`${col} = ?`); params.push(v === undefined ? null : v); }
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); params.push(now);
    params.push(lineId);
    db.run(`UPDATE repair_lines SET ${fields.join(', ')} WHERE id = ?`, params);
    trackUpdate('repair_lines', lineId, data);

    // Wenn Cost veraendert + Line hat schon Expense aber NOCH KEINE Payment:
    // Expense.amount mit-aktualisieren + reverseSource+postExpense neu fuer
    // Ledger-Konsistenz (multi-cycle safe nach Patch).
    if (data.costAmount !== undefined && line.expenseId) {
      db.run(
        `UPDATE expenses SET amount = ? WHERE id = ?`,
        [data.costAmount, line.expenseId]
      );
      trackUpdate('expenses', line.expenseId, { amount: data.costAmount, fromRepairLineEdit: lineId });
      // Reverse alten Post (falls noch unreversed) + neu posten
      if (hasLedgerEntries('EXPENSE', line.expenseId)) {
        safePost(`reverseSource(EXPENSE,${line.expenseId}) [line-edit]`, () => {
          reverseSource('EXPENSE', line.expenseId!, now);
        });
      }
      // Re-Post mit neuem Betrag
      const expRow = query(`SELECT * FROM expenses WHERE id = ?`, [line.expenseId]);
      if (expRow.length > 0) {
        const r = expRow[0];
        const expenseRecord: Expense = {
          id: line.expenseId, expenseNumber: r.expense_number as string,
          branchId: r.branch_id as string, category: r.category as Expense['category'],
          amount: data.costAmount, paidAmount: (r.paid_amount as number) || 0,
          paymentMethod: r.payment_method as Expense['paymentMethod'],
          expenseDate: r.expense_date as string,
          description: r.description as string,
          relatedModule: r.related_module as string,
          relatedEntityId: r.related_entity_id as string,
          supplierId: (r.supplier_id as string) || undefined,
          status: r.status as Expense['status'],
          createdAt: r.created_at as string,
        };
        safePost(`postExpense(${line.expenseId}) [line-edit-repost]`, () => {
          if (hasLedgerEntries('EXPENSE', line.expenseId!)) return;
          postExpense(expenseRecord);
        });
      }
    }

    saveDatabase();
    get().loadRepairLines();
    get().recomputeRepairAggregates(line.repairId);
  },

  cancelRepairLine: (lineId, notes) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const line = get().repairLines.find(l => l.id === lineId);
    if (!line) return;
    if (line.status === 'CANCELLED') return;

    db.run(
      `UPDATE repair_lines SET status = 'CANCELLED', notes = COALESCE(notes, '') || ?, updated_at = ? WHERE id = ?`,
      [' · ' + (notes || 'Cancelled'), now, lineId]
    );
    trackUpdate('repair_lines', lineId, { status: 'CANCELLED' });

    // Linkierte Expense canceln falls vorhanden — reverseSource reversed den
    // A/P-Post via hasReversalFor-Guard idempotent (multi-cycle safe nach Patch).
    if (line.expenseId) {
      db.run(
        `UPDATE expenses SET status = 'CANCELLED' WHERE id = ?`,
        [line.expenseId]
      );
      trackUpdate('expenses', line.expenseId, { status: 'CANCELLED', fromRepairLineCancel: lineId });
      safePost(`reverseSource(EXPENSE,${line.expenseId}) [line-cancel]`, () => {
        if (hasReversalFor('EXPENSE', line.expenseId!)) return;
        reverseSource('EXPENSE', line.expenseId!, now);
      });
    }

    saveDatabase();
    get().loadRepairLines();
    get().recomputeRepairAggregates(line.repairId);
  },

  // Salesforce-Pattern: legacy repairs.workshop_supplier_id + actual_cost werden
  // aus den OPEN Lines abgeleitet, damit alle bestehenden Read-Pfade
  // (supplierStore.getLedger, Reports, etc.) ohne Code-Aenderung weiter
  // funktionieren. Bei N Lines (>1) gilt: workshop_supplier_id=NULL, actual_cost=SUM.
  recomputeRepairAggregates: (repairId) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const lines = get().repairLines.filter(l => l.repairId === repairId && l.status === 'OPEN');
    const supplierIds = Array.from(new Set(lines.map(l => l.supplierId).filter(Boolean) as string[]));
    const totalCost = lines.reduce((s, l) => s + (l.costAmount || 0), 0);
    const newSupplierId = supplierIds.length === 1 ? supplierIds[0] : null;
    db.run(
      `UPDATE repairs SET workshop_supplier_id = ?, actual_cost = ?, updated_at = ? WHERE id = ?`,
      [newSupplierId, totalCost, now, repairId]
    );
    trackUpdate('repairs', repairId, { workshopSupplierId: newSupplierId, actualCost: totalCost, recomputedFromLines: true });
    saveDatabase();
    get().loadRepairs();
  },
}));
