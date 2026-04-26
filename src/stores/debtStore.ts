import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import type { Debt, DebtPayment, DebtDirection, CashSource, DebtStatus } from '@/core/models/types';

interface DebtStore {
  debts: Debt[];
  paymentsByDebt: Record<string, DebtPayment[]>;
  loading: boolean;
  loadDebts: () => void;
  getDebt: (id: string) => Debt | undefined;
  createDebt: (data: Partial<Debt>) => Debt;
  updateDebt: (id: string, data: Partial<Debt>) => void;
  deleteDebt: (id: string) => void;
  loadPaymentsForDebt: (debtId: string) => void;
  recordDebtPayment: (
    debtId: string,
    amount: number,
    source: CashSource,
    paidAt: string,
    notes?: string,
  ) => DebtPayment;
}

function rowToDebt(row: Record<string, unknown>, paidAmount: number): Debt {
  return {
    id: row.id as string,
    loanNumber: (row.loan_number as string | null) || undefined,
    direction: row.direction as DebtDirection,
    counterparty: row.counterparty as string,
    customerId: (row.customer_id as string | null) || undefined,
    amount: (row.amount as number) || 0,
    source: row.source as CashSource,
    dueDate: (row.due_date as string | null) || undefined,
    notes: (row.notes as string | null) || undefined,
    status: (row.status as DebtStatus) || 'OPEN',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    settledAt: (row.settled_at as string | null) || undefined,
    paidAmount,
  };
}

function rowToPayment(row: Record<string, unknown>): DebtPayment {
  return {
    id: row.id as string,
    debtId: row.debt_id as string,
    amount: (row.amount as number) || 0,
    source: row.source as CashSource,
    paidAt: row.paid_at as string,
    notes: (row.notes as string | null) || undefined,
    createdAt: row.created_at as string,
  };
}

function sumPaymentsFor(debtId: string): number {
  try {
    const rows = query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM debt_payments WHERE debt_id = ?',
      [debtId],
    );
    return (rows[0]?.total as number) || 0;
  } catch {
    return 0;
  }
}

// Plan §Loan §10: OPEN / PARTIALLY_REPAID / REPAID / CANCELLED
function reconcileStatus(db: ReturnType<typeof getDatabase>, debtId: string, amount: number, paidAmount: number): { status: DebtStatus; settledAt: string | null } {
  const now = new Date().toISOString();
  if (paidAmount >= amount) {
    db.run(
      `UPDATE debts SET status = 'REPAID', settled_at = COALESCE(settled_at, ?), updated_at = ? WHERE id = ?`,
      [now, now, debtId],
    );
    return { status: 'REPAID', settledAt: now };
  }
  if (paidAmount > 0) {
    db.run(
      `UPDATE debts SET status = 'PARTIALLY_REPAID', settled_at = NULL, updated_at = ? WHERE id = ?`,
      [now, debtId],
    );
    return { status: 'PARTIALLY_REPAID', settledAt: null };
  }
  db.run(
    `UPDATE debts SET status = 'OPEN', settled_at = NULL, updated_at = ? WHERE id = ?`,
    [now, debtId],
  );
  return { status: 'OPEN', settledAt: null };
}

export const useDebtStore = create<DebtStore>((set, get) => ({
  debts: [],
  paymentsByDebt: {},
  loading: false,

  loadDebts: () => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        'SELECT * FROM debts WHERE branch_id = ? ORDER BY created_at DESC',
        [branchId],
      );
      const debts: Debt[] = rows.map(r => rowToDebt(r, sumPaymentsFor(r.id as string)));
      set({ debts, loading: false });
    } catch {
      set({ debts: [], loading: false });
    }
  },

  getDebt: (id) => get().debts.find(d => d.id === id),

  createDebt: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();

    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }
    let createdBy: string | null;
    try { createdBy = currentUserId(); } catch { createdBy = null; }

    const loanNumber = getNextDocumentNumber('LOA');

    const debt: Debt = {
      id,
      loanNumber,
      direction: data.direction || 'we_lend',
      counterparty: data.counterparty || '',
      customerId: data.customerId,
      amount: data.amount || 0,
      source: data.source || 'cash',
      dueDate: data.dueDate,
      notes: data.notes,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
      paidAmount: 0,
    };

    db.run(
      `INSERT INTO debts (id, branch_id, loan_number, direction, counterparty, customer_id, amount, source,
        due_date, notes, status, created_at, updated_at, settled_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        id, branchId, loanNumber, debt.direction, debt.counterparty, debt.customerId || null,
        debt.amount, debt.source, debt.dueDate || null, debt.notes || null,
        debt.status, now, now, createdBy,
      ],
    );

    saveDatabase();
    trackInsert('debts', id, {
      direction: debt.direction, counterparty: debt.counterparty,
      amount: debt.amount, source: debt.source,
    });
    get().loadDebts();
    return debt;
  },

  updateDebt: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const fieldMap: Record<string, string> = {
      direction: 'direction',
      counterparty: 'counterparty',
      customerId: 'customer_id',
      amount: 'amount',
      source: 'source',
      dueDate: 'due_date',
      notes: 'notes',
      status: 'status',
      settledAt: 'settled_at',
    };

    for (const [key, val] of Object.entries(data)) {
      const col = fieldMap[key];
      if (col) {
        fields.push(`${col} = ?`);
        values.push(val === undefined ? null : val);
      }
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.run(`UPDATE debts SET ${fields.join(', ')} WHERE id = ?`, values);

    // If amount changed, re-evaluate status
    if (data.amount !== undefined) {
      const paid = sumPaymentsFor(id);
      reconcileStatus(db, id, data.amount, paid);
    }

    saveDatabase();
    trackUpdate('debts', id, data);
    get().loadDebts();
  },

  deleteDebt: (id) => {
    const db = getDatabase();
    db.run('DELETE FROM debt_payments WHERE debt_id = ?', [id]);
    db.run('DELETE FROM debts WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('debts', id);
    set(s => {
      const next = { ...s.paymentsByDebt };
      delete next[id];
      return { paymentsByDebt: next };
    });
    get().loadDebts();
  },

  loadPaymentsForDebt: (debtId) => {
    try {
      const rows = query(
        'SELECT * FROM debt_payments WHERE debt_id = ? ORDER BY paid_at ASC, created_at ASC',
        [debtId],
      );
      set(s => ({
        paymentsByDebt: { ...s.paymentsByDebt, [debtId]: rows.map(rowToPayment) },
      }));
    } catch {
      set(s => ({ paymentsByDebt: { ...s.paymentsByDebt, [debtId]: [] } }));
    }
  },

  recordDebtPayment: (debtId, amount, source, paidAt, notes) => {
    const db = getDatabase();
    const id = uuid();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO debt_payments (id, debt_id, amount, source, paid_at, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, debtId, amount, source, paidAt, notes || null, now],
    );

    // Reconcile debt status
    const debt = get().debts.find(d => d.id === debtId);
    const originalAmount = debt?.amount || 0;
    const newPaid = sumPaymentsFor(debtId);
    reconcileStatus(db, debtId, originalAmount, newPaid);

    saveDatabase();
    trackInsert('debt_payments', id, { debtId, amount, source, paidAt });

    get().loadPaymentsForDebt(debtId);
    get().loadDebts();

    return { id, debtId, amount, source, paidAt, notes, createdAt: now };
  },
}));
