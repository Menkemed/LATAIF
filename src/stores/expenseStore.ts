// ═══════════════════════════════════════════════════════════
// LATAIF — Expense Store (Plan §Expenses)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Expense, ExpenseCategory } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface ExpenseStore {
  expenses: Expense[];
  loading: boolean;
  loadExpenses: () => void;
  getExpense: (id: string) => Expense | undefined;
  createExpense: (data: Partial<Expense>) => Expense;
  updateExpense: (id: string, data: Partial<Expense>) => void;
  deleteExpense: (id: string) => void;
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
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const expenseNumber = getNextDocumentNumber('EXP');

    db.run(
      `INSERT INTO expenses (id, branch_id, expense_number, category, amount, payment_method,
        expense_date, description, related_module, related_entity_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, expenseNumber, data.category || 'Miscellaneous', data.amount || 0,
       data.paymentMethod || 'cash', data.expenseDate || now.split('T')[0],
       data.description || null, data.relatedModule || null, data.relatedEntityId || null,
       now, userId]
    );
    saveDatabase();
    trackInsert('expenses', id, { expenseNumber, category: data.category, amount: data.amount });
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
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (fields.length === 0) return;
    values.push(id);
    db.run(`UPDATE expenses SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('expenses', id, data);
    get().loadExpenses();
  },

  deleteExpense: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM expenses WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('expenses', id);
    get().loadExpenses();
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
