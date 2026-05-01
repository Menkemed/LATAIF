// ═══════════════════════════════════════════════════════════
// LATAIF — Expense Store (Plan §Expenses + §Pay-Later)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Expense, ExpenseCategory, ExpensePayment } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface ExpenseStore {
  expenses: Expense[];
  loading: boolean;
  loadExpenses: () => void;
  getExpense: (id: string) => Expense | undefined;
  // payNow=true → status=PAID, paid_amount=amount, expense_payments-Eintrag.
  // payNow=false → status=PENDING, paid_amount=0 (User zahlt später).
  // initialPaid > 0 → Teilzahlung beim Anlegen (status=PENDING bis voll).
  createExpense: (data: Partial<Expense> & { payNow?: boolean; initialPaid?: number }) => Expense;
  updateExpense: (id: string, data: Partial<Expense>) => void;
  deleteExpense: (id: string) => void;
  // Plan §Expenses §Pay-Later — Teilzahlung nachträglich.
  recordExpensePayment: (id: string, amount: number, method: 'cash' | 'bank', date?: string, note?: string) => void;
  getExpensePayments: (id: string) => ExpensePayment[];
  getTotalsByCategory: () => Record<ExpenseCategory, number>;
  getMonthlyTotal: (year: number, month: number) => number;
}

function rowToExpense(row: Record<string, unknown>): Expense {
  return {
    id: row.id as string,
    expenseNumber: row.expense_number as string,
    branchId: row.branch_id as string,
    category: (row.category as ExpenseCategory) || 'Miscellaneous',
    amount: (row.amount as number) || 0,
    paidAmount: (row.paid_amount as number) || 0,
    paymentMethod: (row.payment_method as 'cash' | 'bank') || 'cash',
    expenseDate: row.expense_date as string,
    description: row.description as string | undefined,
    relatedModule: row.related_module as string | undefined,
    relatedEntityId: row.related_entity_id as string | undefined,
    status: (row.status as 'PENDING' | 'PAID' | 'CANCELLED') || 'PAID',
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToExpensePayment(row: Record<string, unknown>): ExpensePayment {
  return {
    id: row.id as string,
    expenseId: row.expense_id as string,
    amount: (row.amount as number) || 0,
    method: (row.method as 'cash' | 'bank') || 'cash',
    paidAt: row.paid_at as string,
    note: (row.note as string | null) || undefined,
    createdAt: row.created_at as string,
  };
}

function deriveStatus(amount: number, paid: number): 'PENDING' | 'PAID' {
  return paid >= amount - 0.005 ? 'PAID' : 'PENDING';
}

export const useExpenseStore = create<ExpenseStore>((set, get) => ({
  expenses: [],
  loading: false,

  loadExpenses: () => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        'SELECT * FROM expenses WHERE branch_id = ? ORDER BY expense_date DESC, created_at DESC',
        [branchId]
      );
      set({ expenses: rows.map(rowToExpense), loading: false });
    } catch { set({ expenses: [], loading: false }); }
  },

  getExpense: (id) => get().expenses.find(e => e.id === id),

  createExpense: (data) => {
    const amount = Number(data.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Expense amount must be positive.');
    }
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const expenseNumber = getNextDocumentNumber('EXP');

    // Default: payNow=true für Backwards-Compat (sofortiger Cash/Bank-Abgang).
    // Nur wenn explizit payNow=false oder initialPaid<amount → PENDING.
    const explicitInitial = typeof data.initialPaid === 'number' ? data.initialPaid : null;
    const payNow = data.payNow !== false; // default true
    let initialPaid: number;
    if (explicitInitial !== null) {
      initialPaid = Math.max(0, Math.min(amount, explicitInitial));
    } else if (payNow) {
      initialPaid = amount;
    } else {
      initialPaid = 0;
    }

    const status = deriveStatus(amount, initialPaid);
    const method = data.paymentMethod || 'cash';
    const expenseDate = data.expenseDate || now.split('T')[0];

    db.run(
      `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
        expense_date, description, related_module, related_entity_id, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, expenseNumber, data.category || 'Miscellaneous', amount, initialPaid,
       method, expenseDate,
       data.description || null, data.relatedModule || null, data.relatedEntityId || null,
       status, now, userId]
    );

    // Audit-Trail: Initial-Zahlung als expense_payments-Eintrag (falls > 0).
    if (initialPaid > 0) {
      const payId = uuid();
      db.run(
        `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [payId, id, initialPaid, method, expenseDate, 'Initial payment on creation', now]
      );
      trackInsert('expense_payments', payId, { expenseId: id, amount: initialPaid, method });
    }

    saveDatabase();
    trackInsert('expenses', id, { expenseNumber, category: data.category, amount, paidAmount: initialPaid, status });
    get().loadExpenses();
    return get().getExpense(id)!;
  },

  updateExpense: (id, data) => {
    const db = getDatabase();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      category: 'category', amount: 'amount', paymentMethod: 'payment_method',
      expenseDate: 'expense_date', description: 'description',
      relatedModule: 'related_module', relatedEntityId: 'related_entity_id',
      status: 'status',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (fields.length === 0) return;
    values.push(id);
    db.run(`UPDATE expenses SET ${fields.join(', ')} WHERE id = ?`, values);

    // Wenn amount geändert wurde, Status anhand neuer paid_amount neu ableiten.
    if (data.amount !== undefined) {
      const row = query('SELECT amount, paid_amount FROM expenses WHERE id = ?', [id])[0];
      if (row) {
        const newStatus = deriveStatus(Number(row.amount || 0), Number(row.paid_amount || 0));
        db.run('UPDATE expenses SET status = ? WHERE id = ? AND status != ?', [newStatus, id, 'CANCELLED']);
      }
    }

    saveDatabase();
    trackUpdate('expenses', id, data);
    get().loadExpenses();
  },

  deleteExpense: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM expense_payments WHERE expense_id = ?', [id]);
    db.run('DELETE FROM expenses WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('expenses', id);
    get().loadExpenses();
  },

  recordExpensePayment: (id, amount, method, date, note) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Payment amount must be positive.');
    }
    const exp = get().getExpense(id);
    if (!exp) throw new Error('Expense not found');
    if (exp.status === 'CANCELLED') throw new Error('Cannot record payment on cancelled expense');
    const remaining = Math.max(0, exp.amount - exp.paidAmount);
    if (remaining <= 0.005) {
      throw new Error('Expense is already fully paid');
    }
    const applied = Math.min(amount, remaining);
    const newPaid = exp.paidAmount + applied;
    const newStatus = deriveStatus(exp.amount, newPaid);
    const now = new Date().toISOString();
    const payDate = date || now.split('T')[0];

    const db = getDatabase();
    const payId = uuid();
    db.run(
      `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [payId, id, applied, method, payDate, note || null, now]
    );
    db.run(
      `UPDATE expenses SET paid_amount = ?, payment_method = ?, status = ? WHERE id = ?`,
      [newPaid, method, newStatus, id]
    );
    saveDatabase();
    trackInsert('expense_payments', payId, { expenseId: id, amount: applied, method });
    trackUpdate('expenses', id, { paidAmount: newPaid, status: newStatus });
    get().loadExpenses();
  },

  getExpensePayments: (id) => {
    try {
      const rows = query(
        'SELECT * FROM expense_payments WHERE expense_id = ? ORDER BY paid_at ASC, created_at ASC',
        [id]
      );
      return rows.map(rowToExpensePayment);
    } catch { return []; }
  },

  getTotalsByCategory: () => {
    const out: Partial<Record<ExpenseCategory, number>> = {};
    for (const e of get().expenses) {
      out[e.category] = (out[e.category] || 0) + e.amount;
    }
    return out as Record<ExpenseCategory, number>;
  },

  getMonthlyTotal: (year, month) => {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    return get().expenses
      .filter(e => (e.expenseDate || '').startsWith(prefix))
      .reduce((s, e) => s + e.amount, 0);
  },
}));
