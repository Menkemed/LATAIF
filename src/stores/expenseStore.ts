// ═══════════════════════════════════════════════════════════
// LATAIF — Expense Store (Plan §Expenses + §Pay-Later)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Expense, ExpenseCategory, ExpensePayment } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import {
  postExpense,
  postExpensePayment,
  postExpenseCancelled,
  reverseSource,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
// Buchungsfehler blockieren den operativen Domain-Insert NICHT; Reconciliation-View
// surfaces Diskrepanzen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

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
  recordExpensePayment: (id: string, amount: number, method: 'cash' | 'bank' | 'benefit', date?: string, note?: string) => void;
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
    paymentMethod: (row.payment_method as 'cash' | 'bank' | 'benefit') || 'cash',
    expenseDate: row.expense_date as string,
    description: row.description as string | undefined,
    relatedModule: row.related_module as string | undefined,
    relatedEntityId: row.related_entity_id as string | undefined,
    supplierId: row.supplier_id as string | undefined,
    status: (row.status as 'PENDING' | 'PAID' | 'CANCELLED') || 'PAID',
    recurringTemplateId: (row.recurring_template_id as string) || undefined,
    employeeId: (row.employee_id as string) || undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToExpensePayment(row: Record<string, unknown>): ExpensePayment {
  return {
    id: row.id as string,
    expenseId: row.expense_id as string,
    amount: (row.amount as number) || 0,
    method: (row.method as 'cash' | 'bank' | 'benefit') || 'cash',
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

    // Salary-Validierung: category='Salary' verlangt employeeId. Andere
    // Kategorien duerfen keine employeeId tragen (UI sollte sie nicht senden).
    if (data.category === 'Salary' && !data.employeeId) {
      throw new Error('Salary expenses require an employee. Pick an employee or change the category.');
    }

    db.run(
      `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
        expense_date, description, related_module, related_entity_id, supplier_id, status, recurring_template_id,
        employee_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, expenseNumber, data.category || 'Miscellaneous', amount, initialPaid,
       method, expenseDate,
       data.description || null, data.relatedModule || null, data.relatedEntityId || null,
       data.supplierId || null, status, data.recurringTemplateId || null,
       data.employeeId || null, now, userId]
    );

    // Audit-Trail: Initial-Zahlung als expense_payments-Eintrag (falls > 0).
    let initialPayId: string | null = null;
    if (initialPaid > 0) {
      initialPayId = uuid();
      db.run(
        `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [initialPayId, id, initialPaid, method, expenseDate, 'Initial payment on creation', now]
      );
      trackInsert('expense_payments', initialPayId, { expenseId: id, amount: initialPaid, method });
    }

    saveDatabase();
    trackInsert('expenses', id, { expenseNumber, category: data.category, amount, paidAmount: initialPaid, status });
    get().loadExpenses();

    // ZIEL.md §3a — Ledger-Posting nach Domain-Insert.
    safePost(`postExpense(${id})`, () => {
      if (hasLedgerEntries('EXPENSE', id)) return;
      const fresh = get().getExpense(id);
      if (fresh) postExpense(fresh);
    });
    if (initialPayId && initialPaid > 0) {
      const payId = initialPayId;
      const supplierId = data.supplierId;
      safePost(`postExpensePayment(${payId}) [initial]`, () => {
        if (hasLedgerEntries('EXPENSE_PAYMENT', payId)) return;
        postExpensePayment(
          {
            id: payId, expenseId: id, amount: initialPaid,
            method, paidAt: expenseDate, createdAt: now,
            note: 'Initial payment on creation',
          },
          supplierId
        );
      });
    }

    return get().getExpense(id)!;
  },

  updateExpense: (id, data) => {
    const db = getDatabase();
    const before = get().getExpense(id);
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      category: 'category', amount: 'amount', paymentMethod: 'payment_method',
      expenseDate: 'expense_date', description: 'description',
      relatedModule: 'related_module', relatedEntityId: 'related_entity_id',
      supplierId: 'supplier_id',
      employeeId: 'employee_id',
      status: 'status',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v ?? null); }
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

    // ZIEL.md §3a + B1 — Ledger-Storno bei Expense-Cancel. Erst JEDE geleistete
    // Zahlung reversen (DR Cash/Bank/Benefit zurueck / CR AP), dann die Expense
    // selbst (DR AP / CR EXPENSES). Ohne den Payment-Reverse bliebe bei einer
    // (teil)bezahlten Expense das EXPENSE_PAYMENT-Bein stehen → AP negativ +
    // Cash/Bank/Benefit phantom-reduziert. deleteExpense macht es bereits so; der
    // Cancel-Pfad zog vorher nur das EXPENSE-Bein. Die expense_payments-Rows bleiben
    // am CANCELLED-Record (Zahlungshistorie) — backfillExpensePayments ist via
    // hasLedgerEntries idempotent und reposted nichts. Guards = kein Doppel-Reverse.
    if (data.status === 'CANCELLED' && before && before.status !== 'CANCELLED') {
      const now = new Date().toISOString();
      const pays = query('SELECT id FROM expense_payments WHERE expense_id = ?', [id]);
      for (const p of pays) {
        const payId = p.id as string;
        safePost(`reverseExpensePayment(${payId}) [cancel]`, () => {
          if (!hasLedgerEntries('EXPENSE_PAYMENT', payId)) return;
          if (hasReversalFor('EXPENSE_PAYMENT', payId)) return;
          reverseSource('EXPENSE_PAYMENT', payId, now);
        });
      }
      safePost(`postExpenseCancelled(${id})`, () => {
        if (!hasLedgerEntries('EXPENSE', id)) return;
        if (hasReversalFor('EXPENSE', id)) return;
        postExpenseCancelled(before);
      });
    }
  },

  deleteExpense: (id) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    // M-03 — Ledger-Storno VOR dem Löschen. Erst jede Zahlung (DR AP / CR Cash),
    // dann die Expense selbst (DR EXPENSES / CR AP). Sonst bleiben EXPENSES/AP/
    // Cash dauerhaft verfälscht (Cancel-Pfad reverst korrekt — nur Delete fehlte).
    const pays = query('SELECT id FROM expense_payments WHERE expense_id = ?', [id]);
    for (const p of pays) {
      const payId = p.id as string;
      safePost(`reverseExpensePayment(${payId})`, () => {
        if (!hasLedgerEntries('EXPENSE_PAYMENT', payId)) return;
        if (hasReversalFor('EXPENSE_PAYMENT', payId)) return;
        reverseSource('EXPENSE_PAYMENT', payId, now);
      });
    }
    safePost(`reverseExpense(${id})`, () => {
      if (!hasLedgerEntries('EXPENSE', id)) return;
      if (hasReversalFor('EXPENSE', id)) return;
      reverseSource('EXPENSE', id, now);
    });
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

    // ZIEL.md §3a — Ledger-Posting für Expense-Zahlung.
    safePost(`postExpensePayment(${payId})`, () => {
      if (hasLedgerEntries('EXPENSE_PAYMENT', payId)) return;
      postExpensePayment(
        {
          id: payId, expenseId: id, amount: applied,
          method, paidAt: payDate, createdAt: now, note: note ?? undefined,
        },
        exp.supplierId
      );
    });

    // v0.7.7 — Cross-Store-Propagation: wenn diese Expense an einer
    // repair_line / order_line haengt, deren paymentStatus mit-aktualisieren
    // damit die Source-Detail-Pages (RepairDetail / OrderDetail) sofort
    // "Paid" statt "A/P booked" zeigen — ohne dass der User refreshen muss.
    // Per feedback_linked_records_lifecycle.md: cross-store mutations refresh
    // dependent UIs.
    try {
      const linkedRepairLine = query('SELECT id FROM repair_lines WHERE expense_id = ? LIMIT 1', [id])[0];
      if (linkedRepairLine) {
        import('@/stores/repairStore').then(m => m.useRepairStore.getState().loadRepairLines());
      }
      const linkedOrderLine = query('SELECT id FROM order_lines WHERE expense_id = ? LIMIT 1', [id])[0];
      if (linkedOrderLine) {
        import('@/stores/orderStore').then(m => m.useOrderStore.getState().loadOrders());
      }
    } catch (err) {
      console.warn('[expense] cross-store reload failed:', err);
    }
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
      // v0.7.26 — stornierte (reversierte) Expenses zaehlen NICHT in die Kategorie-
      // Summen (z.B. reversierte CardFees). Konsistent mit totalPaid/totalUnpaid.
      if (e.status === 'CANCELLED') continue;
      out[e.category] = (out[e.category] || 0) + e.amount;
    }
    return out as Record<ExpenseCategory, number>;
  },

  getMonthlyTotal: (year, month) => {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    return get().expenses
      // v0.7.26 — stornierte Expenses raus aus dem Monats-Total.
      .filter(e => e.status !== 'CANCELLED' && (e.expenseDate || '').startsWith(prefix))
      .reduce((s, e) => s + e.amount, 0);
  },
}));
