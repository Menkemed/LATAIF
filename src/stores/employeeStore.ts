// ═══════════════════════════════════════════════════════════
// LATAIF — Employee Store
// Mitarbeiter-Stammdaten (separat von users — nicht jeder Mitarbeiter
// braucht Login). Salary-Expenses koppeln per employee_id.
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Employee, EmploymentStatus } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

export interface SalaryHistoryRow {
  expenseId: string;
  expenseNumber: string;
  expenseDate: string;
  amount: number;
  paidAmount: number;
  status: 'PENDING' | 'PAID' | 'CANCELLED';
  paymentMethod: 'cash' | 'bank';
  description?: string;
  recurringTemplateId?: string;
}

export interface SalesHistoryRow {
  invoiceId: string;
  invoiceNumber: string;
  specialMark: boolean;
  issuedAt: string;
  customerId: string;
  customerName: string;
  grossAmount: number;
  paidAmount: number;
  status: string;
  margin: number;
}

export interface RepairsHandledRow {
  repairId: string;
  repairNumber: string;
  receivedAt: string;
  customerId: string;
  customerName: string;
  itemDescription: string;
  chargeToCustomer: number;
  customerPaidAmount: number;
  status: string;
}

export interface PurchasesHandledRow {
  purchaseId: string;
  purchaseNumber: string;
  purchaseDate: string;
  supplierId: string;
  supplierName: string;
  totalAmount: number;
  paidAmount: number;
  status: string;
}

export interface TransfersHandledRow {
  transferId: string;
  transferNumber: string;
  transferredAt: string;
  agentId: string;
  agentName: string;
  productLabel: string;
  agentPrice: number;
  status: string;
}

export interface ConsignmentsHandledRow {
  consignmentId: string;
  consignmentNumber: string;
  agreementDate: string;
  consignorId: string;
  consignorName: string;
  productLabel: string;
  agreedPrice: number;
  status: string;
}

export interface ReturnsHandledRow {
  returnId: string;
  returnNumber: string;
  returnDate: string;
  customerId: string;
  customerName: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  invoiceSpecialMark: boolean;
  totalAmount: number;
  refundAmount: number;
  status: string;
}

export interface DebtsHandledRow {
  debtId: string;
  direction: 'we_lend' | 'we_borrow' | string;
  counterparty: string;
  amount: number;
  source: string;
  dueDate?: string;
  status: string;
  createdAt: string;
}

interface EmployeeStore {
  employees: Employee[];
  loading: boolean;
  loadEmployees: () => void;
  getEmployee: (id: string) => Employee | undefined;
  createEmployee: (data: Omit<Employee, 'id' | 'branchId' | 'createdAt' | 'updatedAt'>) => Employee;
  updateEmployee: (id: string, data: Partial<Employee>) => void;
  deleteEmployee: (id: string) => void;
  setStatus: (id: string, status: EmploymentStatus) => void;
  // Salary-Historie eines Mitarbeiters: alle Expenses category='Salary' mit employee_id.
  getSalaryHistory: (employeeId: string) => SalaryHistoryRow[];
  // Aggregate fuer EmployeeDetail-Panel.
  getSalaryStats: (employeeId: string) => {
    totalGross: number;
    totalPaid: number;
    totalOpen: number;
    monthsPaid: number;
  };
  // Sales History (Invoices wo dieser Mitarbeiter staff_id ist).
  getSalesHistory: (employeeId: string) => SalesHistoryRow[];
  getSalesStats: (employeeId: string) => {
    totalRevenue: number;
    totalProfit: number;
    invoiceCount: number;
  };
  // Repairs handled (Repairs wo dieser Mitarbeiter staff_id ist).
  getRepairsHandled: (employeeId: string) => RepairsHandledRow[];
  // Purchases handled (Purchases wo dieser Mitarbeiter staff_id ist).
  getPurchasesHandled: (employeeId: string) => PurchasesHandledRow[];
  getPurchasesStats: (employeeId: string) => {
    totalSpend: number;
    totalPaid: number;
    purchaseCount: number;
  };
  // Transfers handled (agent_transfers wo dieser Mitarbeiter staff_id ist).
  getTransfersHandled: (employeeId: string) => TransfersHandledRow[];
  // Consignments handled.
  getConsignmentsHandled: (employeeId: string) => ConsignmentsHandledRow[];
  // Sales returns handled.
  getReturnsHandled: (employeeId: string) => ReturnsHandledRow[];
  // Debts/loans handled.
  getDebtsHandled: (employeeId: string) => DebtsHandledRow[];
}

function rowToEmployee(row: Record<string, unknown>): Employee {
  return {
    id:               row.id as string,
    branchId:         row.branch_id as string,
    name:             row.name as string,
    role:             (row.role as string) || undefined,
    employmentStatus: (row.employment_status as EmploymentStatus) || 'active',
    baseSalary:       row.base_salary != null ? Number(row.base_salary) : undefined,
    phone:            (row.phone as string) || undefined,
    email:            (row.email as string) || undefined,
    notes:            (row.notes as string) || undefined,
    userId:           (row.user_id as string) || undefined,
    createdAt:        row.created_at as string,
    updatedAt:        row.updated_at as string,
    createdBy:        (row.created_by as string) || undefined,
  };
}

export const useEmployeeStore = create<EmployeeStore>((set, get) => ({
  employees: [],
  loading: false,

  loadEmployees: () => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT * FROM employees WHERE branch_id = ?
          ORDER BY CASE employment_status WHEN 'active' THEN 0 WHEN 'on_leave' THEN 1 ELSE 2 END,
                   name ASC`,
        [branchId]
      );
      set({ employees: rows.map(rowToEmployee), loading: false });
    } catch { set({ employees: [], loading: false }); }
  },

  getEmployee: (id) => get().employees.find(e => e.id === id),

  createEmployee: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    if (!data.name || !data.name.trim()) {
      throw new Error('Employee name is required.');
    }

    db.run(
      `INSERT INTO employees (id, branch_id, name, role, employment_status, base_salary,
        phone, email, notes, user_id, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, data.name.trim(), data.role || null,
       data.employmentStatus || 'active', data.baseSalary ?? null,
       data.phone || null, data.email || null, data.notes || null,
       data.userId || null, now, now, userId]
    );
    saveDatabase();
    trackInsert('employees', id, { name: data.name, role: data.role });
    get().loadEmployees();
    return get().getEmployee(id)!;
  },

  updateEmployee: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', role: 'role', employmentStatus: 'employment_status',
      baseSalary: 'base_salary', phone: 'phone', email: 'email', notes: 'notes',
      userId: 'user_id',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k];
      if (!col) continue;
      fields.push(`${col} = ?`);
      values.push(v ?? null);
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('employees', id, data);
    get().loadEmployees();
  },

  setStatus: (id, status) => get().updateEmployee(id, { employmentStatus: status }),

  deleteEmployee: (id) => {
    const db = getDatabase();
    // Schutz: Wenn Salary-Expenses verknuepft sind, nicht hard-deleten.
    const refs = query(
      `SELECT COUNT(*) AS cnt FROM expenses WHERE employee_id = ? AND status != 'CANCELLED'`,
      [id]
    );
    const cnt = Number(refs[0]?.cnt || 0);
    if (cnt > 0) {
      throw new Error(
        `Cannot delete employee — ${cnt} salary expense${cnt === 1 ? '' : 's'} reference this employee. Mark as 'inactive' instead.`
      );
    }
    db.run(`DELETE FROM employees WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('employees', id);
    get().loadEmployees();
  },

  getSalaryHistory: (employeeId) => {
    try {
      const rows = query(
        `SELECT id, expense_number, expense_date, amount, paid_amount, status,
                payment_method, description, recurring_template_id
           FROM expenses
          WHERE employee_id = ? AND category = 'Salary'
          ORDER BY expense_date DESC, created_at DESC`,
        [employeeId]
      );
      return rows.map(r => ({
        expenseId:           r.id as string,
        expenseNumber:       r.expense_number as string,
        expenseDate:         r.expense_date as string,
        amount:              Number(r.amount || 0),
        paidAmount:          Number(r.paid_amount || 0),
        status:              (r.status as 'PENDING' | 'PAID' | 'CANCELLED') || 'PAID',
        paymentMethod:       (r.payment_method as 'cash' | 'bank') || 'bank',
        description:         (r.description as string) || undefined,
        recurringTemplateId: (r.recurring_template_id as string) || undefined,
      }));
    } catch { return []; }
  },

  getSalaryStats: (employeeId) => {
    try {
      const rows = query(
        `SELECT COALESCE(SUM(amount), 0) AS gross,
                COALESCE(SUM(paid_amount), 0) AS paid,
                COUNT(*) AS cnt
           FROM expenses
          WHERE employee_id = ? AND category = 'Salary' AND status != 'CANCELLED'`,
        [employeeId]
      );
      const gross = Number(rows[0]?.gross || 0);
      const paid  = Number(rows[0]?.paid || 0);
      const cnt   = Number(rows[0]?.cnt || 0);
      return {
        totalGross: gross,
        totalPaid: paid,
        totalOpen: Math.max(0, gross - paid),
        monthsPaid: cnt,
      };
    } catch { return { totalGross: 0, totalPaid: 0, totalOpen: 0, monthsPaid: 0 }; }
  },

  getSalesHistory: (employeeId) => {
    try {
      const rows = query(
        `SELECT i.id, i.invoice_number, i.issued_at, i.customer_id, i.special_mark,
                c.first_name, c.last_name, c.company,
                i.gross_amount, i.paid_amount, i.status, i.margin_snapshot
           FROM invoices i
           JOIN customers c ON c.id = i.customer_id
          WHERE i.staff_id = ? AND i.status != 'CANCELLED'
          ORDER BY i.issued_at DESC, i.created_at DESC`,
        [employeeId]
      );
      return rows.map(r => ({
        invoiceId:     r.id as string,
        invoiceNumber: r.invoice_number as string,
        specialMark:   Number(r.special_mark) === 1,
        issuedAt:      (r.issued_at as string) || '',
        customerId:    r.customer_id as string,
        customerName:  `${(r.first_name as string) || ''} ${(r.last_name as string) || ''}`.trim()
                       || (r.company as string) || '—',
        grossAmount:   Number(r.gross_amount || 0),
        paidAmount:    Number(r.paid_amount || 0),
        status:        (r.status as string) || 'DRAFT',
        margin:        Number(r.margin_snapshot || 0),
      }));
    } catch { return []; }
  },

  getSalesStats: (employeeId) => {
    try {
      const rows = query(
        `SELECT COALESCE(SUM(gross_amount), 0) AS revenue,
                COALESCE(SUM(margin_snapshot), 0) AS profit,
                COUNT(*) AS cnt
           FROM invoices
          WHERE staff_id = ? AND status != 'CANCELLED'`,
        [employeeId]
      );
      return {
        totalRevenue: Number(rows[0]?.revenue || 0),
        totalProfit:  Number(rows[0]?.profit  || 0),
        invoiceCount: Number(rows[0]?.cnt     || 0),
      };
    } catch { return { totalRevenue: 0, totalProfit: 0, invoiceCount: 0 }; }
  },

  getRepairsHandled: (employeeId) => {
    try {
      const rows = query(
        `SELECT r.id, r.repair_number, r.received_at, r.customer_id,
                c.first_name, c.last_name, c.company,
                r.item_brand, r.item_model, r.item_description,
                COALESCE(r.charge_to_customer, 0) AS charge,
                COALESCE(r.customer_paid_amount, 0) AS paid,
                r.status
           FROM repairs r
           JOIN customers c ON c.id = r.customer_id
          WHERE r.staff_id = ?
          ORDER BY r.received_at DESC, r.created_at DESC`,
        [employeeId]
      );
      return rows.map(r => {
        const brand = (r.item_brand as string) || '';
        const model = (r.item_model as string) || '';
        const desc  = (r.item_description as string) || '';
        const item  = [brand, model].filter(Boolean).join(' ').trim() || desc || '—';
        return {
          repairId:           r.id as string,
          repairNumber:       r.repair_number as string,
          receivedAt:         r.received_at as string,
          customerId:         r.customer_id as string,
          customerName:       `${(r.first_name as string) || ''} ${(r.last_name as string) || ''}`.trim()
                              || (r.company as string) || '—',
          itemDescription:    item,
          chargeToCustomer:   Number(r.charge || 0),
          customerPaidAmount: Number(r.paid || 0),
          status:             (r.status as string) || 'received',
        };
      });
    } catch { return []; }
  },

  getPurchasesHandled: (employeeId) => {
    try {
      const rows = query(
        `SELECT p.id, p.purchase_number, p.purchase_date, p.supplier_id,
                s.name AS supplier_name,
                COALESCE(p.total_amount, 0) AS total_amount,
                COALESCE(p.paid_amount, 0)  AS paid_amount,
                p.status
           FROM purchases p
           JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.staff_id = ?
          ORDER BY p.purchase_date DESC, p.created_at DESC`,
        [employeeId]
      );
      return rows.map(r => ({
        purchaseId:     r.id as string,
        purchaseNumber: r.purchase_number as string,
        purchaseDate:   (r.purchase_date as string) || '',
        supplierId:     r.supplier_id as string,
        supplierName:   (r.supplier_name as string) || '—',
        totalAmount:    Number(r.total_amount || 0),
        paidAmount:     Number(r.paid_amount || 0),
        status:         (r.status as string) || 'DRAFT',
      }));
    } catch { return []; }
  },

  getPurchasesStats: (employeeId) => {
    try {
      const rows = query(
        `SELECT COALESCE(SUM(total_amount), 0) AS spend,
                COALESCE(SUM(paid_amount),  0) AS paid,
                COUNT(*) AS cnt
           FROM purchases
          WHERE staff_id = ? AND status != 'CANCELLED'`,
        [employeeId]
      );
      return {
        totalSpend:    Number(rows[0]?.spend || 0),
        totalPaid:     Number(rows[0]?.paid  || 0),
        purchaseCount: Number(rows[0]?.cnt   || 0),
      };
    } catch { return { totalSpend: 0, totalPaid: 0, purchaseCount: 0 }; }
  },

  getTransfersHandled: (employeeId) => {
    try {
      const rows = query(
        `SELECT t.id, t.transfer_number, t.transferred_at, t.agent_id,
                a.name AS agent_name,
                p.brand AS p_brand, p.name AS p_name,
                COALESCE(t.agent_price, 0) AS agent_price,
                t.status
           FROM agent_transfers t
           JOIN agents   a ON a.id = t.agent_id
           JOIN products p ON p.id = t.product_id
          WHERE t.staff_id = ?
          ORDER BY t.transferred_at DESC, t.created_at DESC`,
        [employeeId]
      );
      return rows.map(r => {
        const brand = (r.p_brand as string) || '';
        const name  = (r.p_name as string)  || '';
        return {
          transferId:     r.id as string,
          transferNumber: r.transfer_number as string,
          transferredAt:  (r.transferred_at as string) || '',
          agentId:        r.agent_id as string,
          agentName:      (r.agent_name as string) || '—',
          productLabel:   `${brand} ${name}`.trim() || '—',
          agentPrice:     Number(r.agent_price || 0),
          status:         (r.status as string) || 'transferred',
        };
      });
    } catch { return []; }
  },

  getConsignmentsHandled: (employeeId) => {
    try {
      const rows = query(
        `SELECT cn.id, cn.consignment_number, cn.agreement_date, cn.consignor_id,
                c.first_name, c.last_name, c.company,
                p.brand AS p_brand, p.name AS p_name,
                COALESCE(cn.agreed_price, 0) AS agreed_price,
                cn.status
           FROM consignments cn
           JOIN customers c ON c.id = cn.consignor_id
           JOIN products  p ON p.id = cn.product_id
          WHERE cn.staff_id = ?
          ORDER BY cn.agreement_date DESC, cn.created_at DESC`,
        [employeeId]
      );
      return rows.map(r => {
        const brand = (r.p_brand as string) || '';
        const name  = (r.p_name as string)  || '';
        return {
          consignmentId:     r.id as string,
          consignmentNumber: r.consignment_number as string,
          agreementDate:     (r.agreement_date as string) || '',
          consignorId:       r.consignor_id as string,
          consignorName:     `${(r.first_name as string) || ''} ${(r.last_name as string) || ''}`.trim()
                             || (r.company as string) || '—',
          productLabel:      `${brand} ${name}`.trim() || '—',
          agreedPrice:       Number(r.agreed_price || 0),
          status:            (r.status as string) || 'active',
        };
      });
    } catch { return []; }
  },

  getReturnsHandled: (employeeId) => {
    try {
      const rows = query(
        `SELECT sr.id, sr.return_number, sr.return_date, sr.customer_id,
                c.first_name, c.last_name, c.company,
                sr.invoice_id, i.invoice_number, i.status AS invoice_status, i.special_mark,
                COALESCE(sr.total_amount,  0) AS total_amount,
                COALESCE(sr.refund_amount, 0) AS refund_amount,
                sr.status
           FROM sales_returns sr
           JOIN customers c ON c.id = sr.customer_id
           LEFT JOIN invoices i ON i.id = sr.invoice_id
          WHERE sr.staff_id = ?
          ORDER BY sr.return_date DESC, sr.created_at DESC`,
        [employeeId]
      );
      return rows.map(r => ({
        returnId:      r.id as string,
        returnNumber:  r.return_number as string,
        returnDate:    (r.return_date as string) || '',
        customerId:    r.customer_id as string,
        customerName:  `${(r.first_name as string) || ''} ${(r.last_name as string) || ''}`.trim()
                       || (r.company as string) || '—',
        invoiceId:     (r.invoice_id as string) || '',
        invoiceNumber: (r.invoice_number as string) || '',
        invoiceStatus: (r.invoice_status as string) || '',
        invoiceSpecialMark: Number(r.special_mark) === 1,
        totalAmount:   Number(r.total_amount  || 0),
        refundAmount:  Number(r.refund_amount || 0),
        status:        (r.status as string) || 'REQUESTED',
      }));
    } catch { return []; }
  },

  getDebtsHandled: (employeeId) => {
    try {
      const rows = query(
        `SELECT id, direction, counterparty, amount, source, due_date, status, created_at
           FROM debts
          WHERE staff_id = ?
          ORDER BY created_at DESC`,
        [employeeId]
      );
      return rows.map(r => ({
        debtId:       r.id as string,
        direction:    (r.direction as string) || 'we_lend',
        counterparty: (r.counterparty as string) || '—',
        amount:       Number(r.amount || 0),
        source:       (r.source as string) || '',
        dueDate:      (r.due_date as string) || undefined,
        status:       (r.status as string) || 'open',
        createdAt:    (r.created_at as string) || '',
      }));
    } catch { return []; }
  },
}));
