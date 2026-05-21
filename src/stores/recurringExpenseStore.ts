// ═══════════════════════════════════════════════════════════
// LATAIF — Recurring Expense Templates
// Monatlich wiederkehrende Fixkosten (Miete, Gehalt, Strom, etc.).
// Pro Template eine Zeile in `recurring_expense_templates`. Generator laeuft
// lazy bei App-Start + ExpenseList-Load und holt fehlende Monatsinstanzen
// catch-up nach. Idempotenz via `last_generated_period` (YYYY-MM).
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { RecurringExpenseTemplate, ExpenseCategory } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { useExpenseStore } from '@/stores/expenseStore';

interface RecurringExpenseStore {
  templates: RecurringExpenseTemplate[];
  loading: boolean;
  loadTemplates: () => void;
  getTemplate: (id: string) => RecurringExpenseTemplate | undefined;
  createTemplate: (data: Omit<RecurringExpenseTemplate, 'id' | 'createdAt' | 'updatedAt' | 'lastGeneratedPeriod' | 'branchId'>) => RecurringExpenseTemplate;
  updateTemplate: (id: string, data: Partial<RecurringExpenseTemplate>) => void;
  setActive: (id: string, active: boolean) => void;
  deleteTemplate: (id: string) => void;
  // Erzeugt fehlende Monatsinstanzen aller aktiven Templates seit
  // start_date bzw. last_generated_period bis heute. Idempotent.
  runDueGenerator: () => { created: number; skipped: number; errors: string[] };
}

function rowToTemplate(row: Record<string, unknown>): RecurringExpenseTemplate {
  return {
    id:                  row.id as string,
    branchId:            row.branch_id as string,
    category:            (row.category as ExpenseCategory) || 'Miscellaneous',
    amount:              Number(row.amount || 0),
    paymentMethod:       (row.payment_method as 'cash' | 'bank') || 'bank',
    payNowDefault:       Number(row.pay_now_default || 0) === 1,
    description:         (row.description as string) || undefined,
    dayOfMonth:          Number(row.day_of_month || 1),
    startDate:           row.start_date as string,
    endDate:             (row.end_date as string) || undefined,
    active:              Number(row.active || 0) === 1,
    lastGeneratedPeriod: (row.last_generated_period as string) || undefined,
    supplierId:          (row.supplier_id as string) || undefined,
    employeeId:          (row.employee_id as string) || undefined,
    createdAt:           row.created_at as string,
    updatedAt:           row.updated_at as string,
    createdBy:           (row.created_by as string) || undefined,
  };
}

// ── Date-Helpers ──────────────────────────────────────────────

function lastDayOfMonth(year: number, monthZeroBased: number): number {
  return new Date(year, monthZeroBased + 1, 0).getDate();
}

function clampDay(year: number, monthZeroBased: number, day: number): number {
  return Math.min(day, lastDayOfMonth(year, monthZeroBased));
}

function periodKey(year: number, monthZeroBased: number): string {
  return `${year}-${String(monthZeroBased + 1).padStart(2, '0')}`;
}

function periodFromIso(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

// Iteriert Monate von startKey (inkl) bis endKey (inkl) als 'YYYY-MM'.
function* monthsBetween(startKey: string, endKey: string): Generator<{ year: number; month: number; key: string }> {
  const [sy, sm] = startKey.split('-').map(Number);
  const [ey, em] = endKey.split('-').map(Number);
  let y = sy, m = sm - 1; // m ist 0-based
  while (y < ey || (y === ey && m <= em - 1)) {
    yield { year: y, month: m, key: periodKey(y, m) };
    m++;
    if (m > 11) { m = 0; y++; }
  }
}

// ── Store ─────────────────────────────────────────────────────

export const useRecurringExpenseStore = create<RecurringExpenseStore>((set, get) => ({
  templates: [],
  loading: false,

  loadTemplates: () => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT * FROM recurring_expense_templates WHERE branch_id = ? ORDER BY active DESC, created_at DESC`,
        [branchId]
      );
      set({ templates: rows.map(rowToTemplate), loading: false });
    } catch { set({ templates: [], loading: false }); }
  },

  getTemplate: (id) => get().templates.find(t => t.id === id),

  createTemplate: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const day = Math.max(1, Math.min(31, Math.round(data.dayOfMonth || 1)));
    if (data.category === 'Salary' && !data.employeeId) {
      throw new Error('Recurring Salary templates require an employee.');
    }
    db.run(
      `INSERT INTO recurring_expense_templates
         (id, branch_id, category, amount, payment_method, pay_now_default, description,
          day_of_month, start_date, end_date, active, last_generated_period,
          supplier_id, employee_id, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, data.category, data.amount, data.paymentMethod || 'bank',
       data.payNowDefault ? 1 : 0, data.description || null,
       day, data.startDate, data.endDate || null,
       data.active === false ? 0 : 1, null,
       data.supplierId || null, data.employeeId || null, now, now, userId]
    );
    saveDatabase();
    trackInsert('recurring_expense_templates', id, { category: data.category, amount: data.amount });
    get().loadTemplates();

    // Direkt nach Anlage Generator laufen lassen — wenn Start in der Vergangenheit
    // liegt, werden sofort fehlende Instanzen nachgeholt.
    try { get().runDueGenerator(); } catch (e) { console.warn('[recurring] initial generator run failed:', e); }

    return get().getTemplate(id)!;
  },

  updateTemplate: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      category: 'category', amount: 'amount', paymentMethod: 'payment_method',
      payNowDefault: 'pay_now_default', description: 'description',
      dayOfMonth: 'day_of_month', startDate: 'start_date', endDate: 'end_date',
      active: 'active', supplierId: 'supplier_id', lastGeneratedPeriod: 'last_generated_period',
      employeeId: 'employee_id',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k];
      if (!col) continue;
      let val: unknown = v;
      if (k === 'payNowDefault' || k === 'active') val = v ? 1 : 0;
      if (k === 'dayOfMonth') val = Math.max(1, Math.min(31, Math.round(Number(v) || 1)));
      fields.push(`${col} = ?`); values.push(val ?? null);
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE recurring_expense_templates SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('recurring_expense_templates', id, data);
    get().loadTemplates();
  },

  setActive: (id, active) => {
    get().updateTemplate(id, { active });
    if (active) {
      try { get().runDueGenerator(); } catch (e) { console.warn('[recurring] generator after activate failed:', e); }
    }
  },

  deleteTemplate: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM recurring_expense_templates WHERE id = ?`, [id]);
    // Generierte Expenses bleiben bestehen (Buchhaltung) — recurring_template_id auf NULL setzen.
    db.run(`UPDATE expenses SET recurring_template_id = NULL WHERE recurring_template_id = ?`, [id]);
    saveDatabase();
    trackDelete('recurring_expense_templates', id);
    get().loadTemplates();
  },

  runDueGenerator: () => {
    const out = { created: 0, skipped: 0, errors: [] as string[] };
    let branchId: string;
    try { branchId = currentBranchId(); } catch { return out; }

    // Direkt aus DB lesen — Generator laeuft auch ohne dass loadTemplates() schon
    // gelaufen ist (App-Startup-Hook). HMR-Modul-Duplikate werden so umgangen.
    let templates: RecurringExpenseTemplate[];
    try {
      templates = query(
        `SELECT * FROM recurring_expense_templates WHERE branch_id = ? AND active = 1`,
        [branchId]
      ).map(rowToTemplate);
    } catch (e) {
      out.errors.push(`load-templates: ${(e as Error).message}`);
      return out;
    }

    const today = new Date();
    const todayKey = periodKey(today.getFullYear(), today.getMonth());

    for (const t of templates) {
      try {
        // Welcher Monat soll als naechster erzeugt werden?
        // Wenn lastGeneratedPeriod existiert → nachfolgender Monat. Sonst Start-Monat.
        let startKey: string;
        if (t.lastGeneratedPeriod) {
          const [y, m] = t.lastGeneratedPeriod.split('-').map(Number);
          let ny = y, nm = m; // 1-based input → noch m+1 Logik draufsetzen
          if (nm >= 12) { nm = 1; ny++; } else { nm++; }
          startKey = `${ny}-${String(nm).padStart(2, '0')}`;
        } else {
          startKey = periodFromIso(t.startDate);
        }

        // Nicht ueber heute hinaus generieren.
        const endKeyForLoop = todayKey;
        if (startKey > endKeyForLoop) { out.skipped++; continue; }

        // End-Date des Templates respektieren.
        const templateEndKey = t.endDate ? periodFromIso(t.endDate) : null;
        const effectiveEnd = templateEndKey && templateEndKey < endKeyForLoop ? templateEndKey : endKeyForLoop;
        if (startKey > effectiveEnd) { out.skipped++; continue; }

        // Pre-Start-Date Schutz: nicht vor t.startDate generieren.
        const tStartKey = periodFromIso(t.startDate);
        const finalStart = startKey < tStartKey ? tStartKey : startKey;

        let lastDoneKey: string | null = null;
        const startDateMonthKey = periodFromIso(t.startDate);
        for (const m of monthsBetween(finalStart, effectiveEnd)) {
          // Defensiv: Doppelung verhindern via Existenz-Check (falls last_generated_period
          // noch nicht gesetzt war, z.B. bei Migration aus altem Stand).
          const dup = query(
            `SELECT 1 FROM expenses WHERE recurring_template_id = ?
              AND substr(expense_date, 1, 7) = ?
              AND status != 'CANCELLED' LIMIT 1`,
            [t.id, m.key]
          );
          if (dup.length > 0) { out.skipped++; lastDoneKey = m.key; continue; }

          // Erste Instanz (Start-Monat): exakt das vom User gewaehlte Datum nehmen.
          // Sonst: day_of_month-Regel mit Clamp aufs Monatsende.
          let expenseDate: string;
          if (m.key === startDateMonthKey) {
            expenseDate = t.startDate;
          } else {
            const day = clampDay(m.year, m.month, t.dayOfMonth);
            expenseDate = `${m.key}-${String(day).padStart(2, '0')}`;
          }

          useExpenseStore.getState().createExpense({
            category: t.category,
            amount: t.amount,
            paymentMethod: t.paymentMethod,
            expenseDate,
            description: t.description || `Recurring · ${t.category}`,
            payNow: t.payNowDefault,
            supplierId: t.supplierId,
            employeeId: t.employeeId,
            recurringTemplateId: t.id,
          });
          out.created++;
          lastDoneKey = m.key;
        }

        if (lastDoneKey) {
          // last_generated_period nachziehen.
          const db = getDatabase();
          db.run(
            `UPDATE recurring_expense_templates SET last_generated_period = ?, updated_at = ? WHERE id = ?`,
            [lastDoneKey, new Date().toISOString(), t.id]
          );
          saveDatabase();
        }
      } catch (e) {
        out.errors.push(`${t.id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }

    if (out.created > 0) {
      try { useExpenseStore.getState().loadExpenses(); } catch { /* ignore */ }
      try { get().loadTemplates(); } catch { /* ignore */ }
    }
    return out;
  },
}));
