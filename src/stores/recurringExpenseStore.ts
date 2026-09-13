// ═══════════════════════════════════════════════════════════
// LATAIF — Recurring Expense Templates
// Monatlich wiederkehrende Fixkosten (Miete, Gehalt, Strom, etc.).
// Pro Template eine Zeile in `recurring_expense_templates`. Generator laeuft
// lazy bei App-Start + ExpenseList-Load und holt fehlende Monatsinstanzen
// catch-up nach. Idempotenz via `last_generated_period` (YYYY-MM).
//
// CENTRAL-UI-PARITY R6D — Anlegen, Aendern, Pause/Resume und der Generator sind die Hausfolge
// (`core/payables/payables-house.ts`), dieselbe wie im Fernbefehl:
//   • Anlegen legt die Vorlage UND die faelligen Monate in EINER Klammer an (vorher lief der
//     Generator danach, mit verschlucktem Fehler; Betrag 0 ging durch und scheiterte spaeter still).
//   • Aendern schreibt nur die Formularfelder — `lastGeneratedPeriod` nie (vorher schrieb die Maske
//     den ganzen Stand beim Oeffnen zurueck, samt `active`).
//   • Resume holt die Pausenmonate NICHT nach (die Maske verspricht „keeps the schedule").
//   • Der Generator klammert JE VORLAGE: ein faelliger Monat, der nicht angelegt werden kann, nimmt
//     nur die Monate dieser Vorlage zurueck — und `last_generated_period` wird jetzt synchronisiert.
// ═══════════════════════════════════════════════════════════

import { create } from 'zustand';
import type { RecurringExpenseTemplate, ExpenseCategory } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackDelete } from '@/core/sync/track';
import { inLedgerTransaction } from '@/core/ledger/posting';
import { useExpenseStore } from '@/stores/expenseStore';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary, readsFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
import {
  TEMPLATE_EDIT_FIELDS, atomar, localHouseCtx, activeTemplateIds,
  createTemplateInHouse, updateTemplateInHouse, generateDueForTemplate,
  type HouseCtx, type PayMethod, type TemplateEditFields,
} from '@/core/payables/payables-house';

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

// R6D — die Fassung reist mit: „Edit"/„Pause"/„Resume" nennen sie, damit ein veralteter Stand
// abgewiesen wird statt ihn zurueckzuschreiben.
function rowToTemplate(row: Record<string, unknown>): RecurringExpenseTemplate & { revision?: number } {
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
    revision:            Number(row.revision ?? 0) || undefined,
  };
}

function reloadAfterWrite(get: () => RecurringExpenseStore): void {
  get().loadTemplates();
  try { useExpenseStore.getState().loadExpenses(); } catch { /* ignore */ }
}

// ── Store ─────────────────────────────────────────────────────

export const useRecurringExpenseStore = create<RecurringExpenseStore>((set, get) => ({
  templates: [],
  loading: false,

  loadTemplates: () => {
    if (hydrateFromPrimary('store.recurring_expenses.get', (d) => set(d as never))) return;
    try {
      set({ ...loadRecurringTemplatesFor(localReadContext()), loading: false });
    } catch { set({ templates: [], loading: false }); }
  },

  getTemplate: (id) => get().templates.find(t => t.id === id),

  createTemplate: (data) => {
    const r = atomar(() => createTemplateInHouse({
      category: data.category,
      amount: data.amount,
      paymentMethod: (data.paymentMethod || 'bank') as PayMethod,
      payNowDefault: !!data.payNowDefault,
      description: data.description,
      dayOfMonth: data.dayOfMonth,
      startDate: data.startDate,
      endDate: data.endDate,
      employeeId: data.employeeId,
    }, localHouseCtx(), { supplierId: data.supplierId, active: data.active }));
    reloadAfterWrite(get);
    return get().getTemplate(r.templateId)!;
  },

  // Nur die Formularfelder reisen in die Hausfolge; was das Haus fuehrt (`lastGeneratedPeriod`,
  // Filiale, Zeitstempel) wird hier gar nicht erst weitergegeben.
  updateTemplate: (id, data) => {
    const src = data as Record<string, unknown>;
    const edit: Record<string, unknown> = {};
    for (const k of TEMPLATE_EDIT_FIELDS) if (src[k] !== undefined) edit[k] = src[k];
    atomar(() => updateTemplateInHouse(id, edit as TemplateEditFields, localHouseCtx()));
    reloadAfterWrite(get);
  },

  // Pause/Resume ist ein Aendern mit dem ZIELWERT — Resume erzeugt im Haus nur, was jetzt faellig ist.
  setActive: (id, active) => {
    get().updateTemplate(id, { active });
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
    // PC2 fuehrt keine Buecher — der Primary erzeugt seine Monate selbst.
    if (readsFromPrimary()) return out;
    // Ist gerade eine fremde Klammer offen (ein laufender Auftrag), wird NICHT hineingeschrieben;
    // der naechste Lauf (App-Start, Ausgabenliste) holt es nach.
    if (inLedgerTransaction()) { out.errors.push('busy: another action is open'); return out; }
    let ctx: HouseCtx;
    try { ctx = localHouseCtx(); } catch { return out; }
    let ids: string[];
    try {
      // Direkt aus DB lesen — Generator laeuft auch ohne dass loadTemplates() schon gelaufen ist.
      ids = activeTemplateIds(ctx.branchId);
    } catch (e) {
      out.errors.push(`load-templates: ${(e as Error).message}`);
      return out;
    }
    for (const id of ids) {
      try {
        const r = atomar(() => generateDueForTemplate(id, ctx));
        out.created += r.created;
        out.skipped += r.skipped;
      } catch (e) {
        out.errors.push(`${id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    if (out.created > 0) reloadAfterWrite(get);
    return out;
  },
}));

/** CENTRAL-UI-PARITY R2B — die Dauerauftraege einer Filiale, zustandsfrei. */
export function loadRecurringTemplatesFor(ctx: BusinessReadContext): { templates: RecurringExpenseTemplate[] } {
  const rows = query(
    `SELECT * FROM recurring_expense_templates WHERE branch_id = ? ORDER BY active DESC, created_at DESC`,
    [ctx.branchId]
  );
  return { templates: rows.map(rowToTemplate) };
}
