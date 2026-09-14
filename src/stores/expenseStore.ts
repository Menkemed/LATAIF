// ═══════════════════════════════════════════════════════════
// LATAIF — Expense Store (Plan §Expenses + §Pay-Later)
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import type { Expense, ExpenseCategory, ExpensePayment } from '@/core/models/types';
import { isBookedRepairCost } from '@/core/models/types';
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate, trackDelete } from '@/core/sync/track';
import {
  postExpenseCancelled,
  reverseSource,
  hasLedgerEntries,
  hasReversalFor,
  beginLedgerTransaction,
  commitLedgerTransaction,
  rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { restoreSupplierCreditUsage } from '@/core/finance/supplierCreditRestore';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
// CENTRAL-UI-PARITY R6D — Anlegen, Aendern und Bezahlen laufen durch DIE Hausfolge, die auch der
// Fernbefehl ruft. Die Store-Aktionen bleiben (Metall, Kommission, Dauerauftrag rufen sie), klammern
// sich aber selbst atomar — und buchen strikt statt `safePost` (ein gescheiterter Post nimmt alles zurueck).
import {
  PayablesRejected, EXPENSE_EDIT_FIELDS, atomar, localHouseCtx,
  createExpenseInHouse, updateExpenseInHouse, recordExpensePaymentInHouse,
  type ExpenseEditFields, type PayMethod,
} from '@/core/payables/payables-house';

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

// R6D — die Fassung reist mit: „Edit"/„Pay" nennen sie, damit ein veralteter Stand abgewiesen wird.
function rowToExpense(row: Record<string, unknown>): Expense & { revision?: number } {
  return {
    revision: Number(row.revision ?? 0) || undefined,
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
    method: (row.method as 'cash' | 'bank' | 'benefit' | 'credit') || 'cash',
    reference: (row.reference as string | null) || undefined,
    paidAt: row.paid_at as string,
    note: (row.note as string | null) || undefined,
    createdAt: row.created_at as string,
  };
}

/**
 * v0.7.7 — Cross-Store-Propagation: haengt die Ausgabe an einer repair_line / order_line, deren
 * Anzeige mit-aktualisieren, damit RepairDetail / OrderDetail sofort „Paid" statt „A/P booked"
 * zeigen (feedback_linked_records_lifecycle.md). R6D: auch nach der Handlung am Primary gerufen.
 */
export function reloadLinkedExpenseViews(id: string): void {
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
}

export const useExpenseStore = create<ExpenseStore>((set, get) => ({
  expenses: [],
  loading: false,

  loadExpenses: () => {
    if (hydrateFromPrimary('store.expenses.get', (d) => set(d as never))) return;
    try {
      set({ ...loadExpensesFor(localReadContext()), loading: false });
    } catch { set({ expenses: [], loading: false }); }
  },

  getExpense: (id) => get().expenses.find(e => e.id === id),

  // R6D — die Signatur bleibt (Metall, Kommission, Dauerauftrag rufen sie); die Wirkung ist die
  // Hausfolge: Beleg + Erstzahlung + beide Buchungen in EINER Klammer, Gehaltsregel VOR der Nummer.
  createExpense: (data) => {
    const amount = Number(data.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new PayablesRejected('EXPENSE_AMOUNT_INVALID', 'Expense amount must be positive.');
    }
    // Default: payNow=true für Backwards-Compat (sofortiger Cash/Bank-Abgang).
    // Nur wenn explizit payNow=false oder initialPaid<amount → PENDING.
    const explicitInitial = typeof data.initialPaid === 'number' ? data.initialPaid : null;
    const payNow = data.payNow !== false; // default true
    const initialPaid = explicitInitial !== null
      ? Math.max(0, Math.min(amount, explicitInitial))
      : (payNow ? amount : 0);
    const r = atomar(() => createExpenseInHouse({
      category: data.category || 'Miscellaneous',
      amount,
      paymentMethod: (data.paymentMethod || 'cash') as PayMethod,
      expenseDate: data.expenseDate || new Date().toISOString().split('T')[0],
      description: data.description || undefined,
      initialPaid,
      employeeId: data.employeeId,
      supplierId: data.supplierId,
      relatedModule: data.relatedModule,
      relatedEntityId: data.relatedEntityId,
      recurringTemplateId: data.recurringTemplateId,
    }, localHouseCtx()));
    get().loadExpenses();
    return get().getExpense(r.expenseId)!;
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

    // Slice A — Cancel-Pfad VOLLSTAENDIG ATOMAR: Statuswechsel + Ledger-Reverse jeder Zahlung
    // (DR Cash/Bank/Benefit zurueck / CR AP; bei credit: DR SUPPLIER_CREDIT zurueck / CR AP) +
    // Expense-Reverse (postExpenseCancelled) + Credit-Restore laufen in EINER beginLedgerTransaction.
    // Bei JEDEM Fehler rollt ALLES zurueck — inkl. des status='CANCELLED'-Writes — und der Vorgang
    // bleibt erneut ausfuehrbar (Domain und Ledger konsistent; keine gestrandete Credit-Nutzung).
    // Capture der Credit-Einloesungen VOR den Reverses (Ledger vorhanden + noch nicht reversed);
    // 2. Cancel: before.status ist bereits CANCELLED → Block nicht betreten / Capture leer → kein
    // Doppel-Restore. expense_payments-Rows bleiben am CANCELLED-Record (Zahlungshistorie).
    if (data.status === 'CANCELLED' && before && before.status !== 'CANCELLED') {
      const now = new Date().toISOString();
      const creditPaysToRestore = query(
        `SELECT id, reference, amount FROM expense_payments WHERE expense_id = ? AND method = 'credit' AND reference IS NOT NULL`,
        [id]
      ).filter(p => hasLedgerEntries('EXPENSE_PAYMENT', p.id as string) && !hasReversalFor('EXPENSE_PAYMENT', p.id as string));
      const pays = query('SELECT id FROM expense_payments WHERE expense_id = ?', [id]);
      beginLedgerTransaction();
      try {
        db.run(`UPDATE expenses SET ${fields.join(', ')} WHERE id = ?`, values);
        for (const p of pays) {
          const payId = p.id as string;
          if (!hasLedgerEntries('EXPENSE_PAYMENT', payId)) continue;
          if (hasReversalFor('EXPENSE_PAYMENT', payId)) continue;
          reverseSource('EXPENSE_PAYMENT', payId, now);
        }
        if (hasLedgerEntries('EXPENSE', id) && !hasReversalFor('EXPENSE', id)) {
          postExpenseCancelled(before);
        }
        for (const cp of creditPaysToRestore) {
          restoreSupplierCreditUsage(cp.reference as string, Number(cp.amount) || 0);
        }
        trackUpdate('expenses', id, data);
        commitLedgerTransaction();
      } catch (e) {
        rollbackLedgerTransaction();
        throw e;
      }
      get().loadExpenses();
      return;
    }

    // Ein zweites Storno ist kein neuer Vorgang.
    if (data.status === 'CANCELLED') return;

    // R6D — der generische Weg ist „Edit Expense" und laeuft durch die Hausfolge (nur die fuenf
    // Formularfelder; Betrag nie unter das Beglichene; Betrag/Datum → Aufwandsbuchung neu).
    // Zuordnung, Lieferant, Mitarbeiter und Status aendert ein Bearbeiten NICHT: vorher schrieb die
    // Maske den ganzen Stand beim Oeffnen zurueck. Ein abweichender Wert wird abgewiesen statt still
    // uebernommen — das deckt auch die Slice-A-Sperre (Lieferantenwechsel bei Guthaben) ab.
    const fixedRow = query('SELECT related_module, related_entity_id, supplier_id, employee_id, status FROM expenses WHERE id = ?', [id])[0];
    if (!fixedRow) throw new PayablesRejected('EXPENSE_NOT_FOUND', 'no such expense');
    const fixed: Array<[keyof Expense, string]> = [
      ['relatedModule', 'related_module'], ['relatedEntityId', 'related_entity_id'],
      ['supplierId', 'supplier_id'], ['employeeId', 'employee_id'], ['status', 'status'],
    ];
    for (const [k, col] of fixed) {
      if (data[k] === undefined) continue;
      if (((data[k] as unknown) || null) !== (fixedRow[col] || null)) {
        throw new PayablesRejected('EXPENSE_FIELD_NOT_EDITABLE', `${String(k)} is not changed by editing an expense`);
      }
    }
    const edit: Record<string, unknown> = {};
    for (const k of EXPENSE_EDIT_FIELDS) if (data[k] !== undefined) edit[k] = data[k];
    atomar(() => updateExpenseInHouse(id, edit as ExpenseEditFields, localHouseCtx()));
    get().loadExpenses();
  },

  deleteExpense: (id) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    // POST-PARITY PP-13/PP-14 — gebuchte Reparaturkosten (Einstand eigener Ware bzw. Dienstleistungs-
    // Einstand der Kundenreparatur) gehen nur mit ihrer Reparaturzeile — nie allein aus der Ausgabenliste.
    const own = query('SELECT category, related_module FROM expenses WHERE id = ?', [id])[0];
    if (own && isBookedRepairCost({ category: String(own.category), relatedModule: (own.related_module as string | null) ?? null })) {
      throw new Error('This is a booked repair cost — cancel its repair line (or change the repair) instead.');
    }
    // M-03 — Ledger-Storno VOR dem Löschen. Slice A: jetzt ATOMAR in EINER Ledger-Transaktion
    // + Credit-Restore. Der Capture der einzuloesenden Credit-Zahlungen MUSS VOR dem (Cascade-)
    // Delete passieren, sonst ist der reference-Link weg. Reverse → Restore → Delete → trackDelete
    // im selben Commit; jeder Fehler → kompletter Rollback. 2. Delete (idempotent): Record weg →
    // query leer → No-Op.
    const creditPaysToRestore = query(
      `SELECT id, reference, amount FROM expense_payments WHERE expense_id = ? AND method = 'credit' AND reference IS NOT NULL`,
      [id]
    ).filter(p => hasLedgerEntries('EXPENSE_PAYMENT', p.id as string) && !hasReversalFor('EXPENSE_PAYMENT', p.id as string));
    const pays = query('SELECT id FROM expense_payments WHERE expense_id = ?', [id]);
    beginLedgerTransaction();
    try {
      for (const p of pays) {
        const payId = p.id as string;
        if (!hasLedgerEntries('EXPENSE_PAYMENT', payId)) continue;
        if (hasReversalFor('EXPENSE_PAYMENT', payId)) continue;
        reverseSource('EXPENSE_PAYMENT', payId, now);
      }
      if (hasLedgerEntries('EXPENSE', id) && !hasReversalFor('EXPENSE', id)) {
        reverseSource('EXPENSE', id, now);
      }
      for (const cp of creditPaysToRestore) {
        restoreSupplierCreditUsage(cp.reference as string, Number(cp.amount) || 0);
      }
      db.run('DELETE FROM expense_payments WHERE expense_id = ?', [id]);
      db.run('DELETE FROM expenses WHERE id = ?', [id]);
      trackDelete('expenses', id);
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      throw e;
    }
    get().loadExpenses();
  },

  // R6D — Settlement-SSOT (cash + credit) im Haus; eine Ueberzahlung wird ABGEWIESEN
  // (EXPENSE_OVERPAYMENT) statt still auf den Rest gekappt. Signatur unveraendert.
  recordExpensePayment: (id, amount, method, date, note) => {
    atomar(() => recordExpensePaymentInHouse(id, amount, method, localHouseCtx(), { paidAt: date, note }));
    get().loadExpenses();
    reloadLinkedExpenseViews(id);
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

/**
 * CENTRAL-UI-PARITY R2B — die Ausgaben einer Filiale, zustandsfrei.
 *
 * Dieselbe Abfrage wie zuvor, nur nimmt sie die Filiale aus dem Ausweis der Anfrage statt aus der
 * Sitzung des Menschen am Primary. Sie fasst keinen Zustandsspeicher an.
 */
export function loadExpensesFor(ctx: BusinessReadContext): { expenses: Expense[] } {
  const rows = query(
    'SELECT * FROM expenses WHERE branch_id = ? ORDER BY expense_date DESC, created_at DESC',
    [ctx.branchId]
  );
  return { expenses: rows.map(rowToExpense) };
}
