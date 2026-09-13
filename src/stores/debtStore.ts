import { create } from 'zustand';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { trackUpdate, trackDelete } from '@/core/sync/track';
import type { Debt, DebtPayment, DebtDirection, CashSource, DebtStatus } from '@/core/models/types';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary, hydrateOneFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
// CENTRAL-UI-PARITY R6D — anlegen, zurückzahlen, berichtigen: EINE Hausfolge (Zeile + Buchung).
import {
  createDebtInHouse, moneyAction, recordDebtPaymentInHouse, updateDebtInHouse, type DebtUpdateInput,
} from '@/core/finance/money-house';
import {
  postLoanCancelled,
  postLoanPaymentReversed,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';

// ZIEL.md §3a — Posting-Service ist der einzige Schreibpfad für Finanzbuchungen.
function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) {
    console.error(`[ledger] ${label} failed:`, err);
  }
}

/**
 * R6D — ein Darlehen, wie die Maske es sieht: samt der FASSUNG, die sie beim Bezahlen oder
 * Berichtigen mitschickt (der Primary vergleicht sie in seiner Transaktion).
 */
export type DebtView = Debt & { revision: number };

interface DebtStore {
  debts: DebtView[];
  paymentsByDebt: Record<string, DebtPayment[]>;
  loading: boolean;
  loadDebts: () => void;
  getDebt: (id: string) => DebtView | undefined;
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

function rowToDebt(row: Record<string, unknown>, paidAmount: number): DebtView {
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
    staffId: (row.staff_id as string | null) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    settledAt: (row.settled_at as string | null) || undefined,
    paidAmount,
    revision: Number(row.revision ?? 1),
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

/** Die Maske schickt „YYYY-MM-DD" oder „YYYY-MM-DDT00:00:00Z" — die Hausfolge nimmt den Tag. */
function dayOf(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(T00:00:00(?:\.000)?Z)?$/.exec(String(v ?? ''));
  return m ? m[1] : String(v ?? '');
}

export const useDebtStore = create<DebtStore>((set, get) => ({
  debts: [],
  paymentsByDebt: {},
  loading: false,

  loadDebts: () => {
    if (hydrateFromPrimary('store.debts.get', (d) => set(d as never))) return;
    try {
      set({ ...loadDebtsFor(localReadContext()), loading: false });
    } catch {
      set({ debts: [], loading: false });
    }
  },

  getDebt: (id) => get().debts.find(d => d.id === id),

  createDebt: (data) => {
    // R6D — vorher: Zeile, Speichern, und DANACH die Buchung mit verschlucktem Fehler; die
    // Gegenpartei kam als freier Text aus der Maske. Jetzt dieselbe Hausfolge wie `debts.create`.
    const { debt } = moneyAction((ctx) => createDebtInHouse({
      direction: data.direction || 'we_lend',
      customerId: data.customerId ?? '',
      amount: Number(data.amount),
      source: data.source || 'cash',
      dueDate: data.dueDate,
      notes: data.notes,
      staffId: data.staffId,
    }, ctx));
    get().loadDebts();
    return debt;
  },

  updateDebt: (id, data) => {
    // R6D — die Felder der Maske „Edit Debt" gehen durch die Hausfolge (nur Geändertes; Betrag und
    // Konto buchen die Darlehenszeile neu; ein storniertes Darlehen wird nicht berichtigt). Ein
    // übergebener, aber leerer Wert (`dueDate: undefined`) heißt wie bisher „löschen".
    const edit: DebtUpdateInput = { debtId: id };
    if ('counterparty' in data) edit.counterparty = data.counterparty;
    if ('amount' in data) edit.amount = Number(data.amount);
    if ('dueDate' in data) edit.dueDate = data.dueDate || null;
    if ('notes' in data) edit.notes = data.notes || null;
    if ('source' in data) edit.source = data.source;
    if (Object.keys(edit).length > 1) moneyAction((ctx) => updateDebtInHouse(edit, ctx));

    // Stornieren (Status CANCELLED) bleibt der alte Primary-Weg — kein Fernbefehl, keine Maske.
    const legacy: Record<string, string> = { direction: 'direction', customerId: 'customer_id', status: 'status', settledAt: 'settled_at' };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, col] of Object.entries(legacy)) {
      if (!(key in data)) continue;
      const val = (data as Record<string, unknown>)[key];
      fields.push(`${col} = ?`);
      values.push(val === undefined ? null : val);
    }
    if (fields.length === 0) { get().loadDebts(); return; }
    const before = get().debts.find(d => d.id === id);
    const db = getDatabase();
    db.run(`UPDATE debts SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`, [...values, new Date().toISOString(), id]);
    saveDatabase();
    trackUpdate('debts', id, Object.fromEntries(Object.keys(legacy).filter((k) => k in data).map((k) => [k, (data as Record<string, unknown>)[k]])));
    get().loadDebts();

    // ZIEL.md §3a — Loan-Storno bei Status='CANCELLED' (oder Legacy 'cancelled').
    // M-24: Cancel = "Eintrag war ein Irrtum" → auch die Repayments werden
    // reversiert (symmetrisch zu deleteDebt). Der fruehere Entscheid "Repayments
    // bleiben gebucht (echtes Geld)" stammt aus der Zeit VOR M-12: seit die
    // Cash-Anzeigen balanceOf lesen, wuerde ein halber Storno ein negatives
    // LOAN_RECEIVABLE-Artefakt UND falsche Kassen-Salden hinterlassen.
    // Forderungsverzicht ("Rest erlassen") ist KEIN Cancel — Loan offen lassen
    // oder als REPAID abschliessen.
    if (data.status !== undefined) {
      const newStatus = String(data.status).toUpperCase();
      const oldStatus = String(before?.status || '').toUpperCase();
      if (newStatus === 'CANCELLED' && oldStatus !== 'CANCELLED' && before) {
        const payRows = query('SELECT id FROM debt_payments WHERE debt_id = ?', [id]);
        for (const r of payRows) {
          const dpId = r.id as string;
          safePost(`postLoanPaymentReversed(${dpId}) [cancel-debt]`, () => {
            if (!hasLedgerEntries('LOAN_PAYMENT', dpId)) return;
            if (hasReversalFor('LOAN_PAYMENT', dpId)) return;
            postLoanPaymentReversed(dpId);
          });
        }
        safePost(`postLoanCancelled(${id})`, () => {
          if (!hasLedgerEntries('LOAN', id)) return;
          if (hasReversalFor('LOAN', id)) return;
          postLoanCancelled(before);
        });
      }
    }
  },

  deleteDebt: (id) => {
    const db = getDatabase();
    // ZIEL.md §3a — Vor dem CASCADE-Delete der debt_payments deren Ledger-Buchungen reversen.
    const payRows = query('SELECT id FROM debt_payments WHERE debt_id = ?', [id]);
    for (const r of payRows) {
      const dpId = r.id as string;
      safePost(`postLoanPaymentReversed(${dpId}) [delete-debt]`, () => {
        if (!hasLedgerEntries('LOAN_PAYMENT', dpId)) return;
        if (hasReversalFor('LOAN_PAYMENT', dpId)) return;
        postLoanPaymentReversed(dpId);
      });
    }
    // LOAN-Eintrag selbst spiegeln, falls noch nicht storniert.
    safePost(`postLoanCancelled(${id}) [delete-debt]`, () => {
      if (!hasLedgerEntries('LOAN', id)) return;
      if (hasReversalFor('LOAN', id)) return;
      const debt = get().debts.find(d => d.id === id);
      if (debt) postLoanCancelled(debt);
    });

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
    const put = (payments: DebtPayment[]) => set(s => ({ paymentsByDebt: { ...s.paymentsByDebt, [debtId]: payments } }));
    // R6D — auf PC2 fragte diese Stelle die EIGENE (nicht vorhandene) Datenbank und zeigte still
    // „keine Rückzahlungen". Jetzt dieselbe Auskunft vom Primary (`debts.payments.get`).
    if (hydrateOneFromPrimary('debts.payments.get', { debtId }, (d) => put((d.payments as DebtPayment[] | undefined) ?? []))) return;
    try {
      put(loadDebtPaymentsFor(localReadContext(), debtId).payments);
    } catch {
      put([]);
    }
  },

  recordDebtPayment: (debtId, amount, source, paidAt, notes) => {
    // R6D — vorher: jeder Betrag (auch über den Rest), auch auf ein storniertes Darlehen, Richtung
    // und Betrag aus der GELADENEN Liste, Status ohne Abgleich, Buchung mit verschlucktem Fehler.
    // Jetzt dieselbe Hausfolge wie `debts.record_payment`.
    const r = moneyAction((ctx) => recordDebtPaymentInHouse({ debtId, amount, source, paidAt: dayOf(paidAt), notes }, ctx));
    get().loadPaymentsForDebt(debtId);
    get().loadDebts();
    return r.payment;
  },
}));

/** CENTRAL-UI-PARITY R2B — die Darlehen einer Filiale samt gezahlter Summen, zustandsfrei. */
export function loadDebtsFor(ctx: BusinessReadContext): { debts: DebtView[] } {
  const rows = query('SELECT * FROM debts WHERE branch_id = ? ORDER BY created_at DESC', [ctx.branchId]);
  return { debts: rows.map((r) => rowToDebt(r, sumPaymentsFor(r.id as string))) };
}

/**
 * CENTRAL-UI-PARITY R6D — die Rückzahlungen EINES Darlehens, zustandsfrei. `debt_payments` kennt
 * keine Filiale; sie steckt im Darlehen. Eine fremde Kennung liefert deshalb nichts.
 */
export function loadDebtPaymentsFor(ctx: BusinessReadContext, debtId: string): { payments: DebtPayment[] } {
  const rows = query(
    `SELECT dp.* FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id
      WHERE dp.debt_id = ? AND d.branch_id = ? ORDER BY dp.paid_at ASC, dp.created_at ASC`,
    [debtId, ctx.branchId],
  );
  return { payments: rows.map(rowToPayment) };
}
