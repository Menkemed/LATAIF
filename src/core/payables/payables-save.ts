// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — die gemeinsame Speicherfolge der Verbindlichkeits-Masken.
//
// Jede Maske (New Expense, Edit Expense, Record Payment, Recurring anlegen/aendern/Pause/Resume,
// Add Payment am Einkauf, Credit am Einkauf, Refund Credit, Pay Supplier, Credit einloesen) ruft
// EINE Funktion dieser Datei. Sie kennt zwei Anschluesse und keine eigene Geschaeftsregel:
//
//   • am Primary die Hausfolge (`payables-house.ts`) in `runOnPrimary` — exklusiv, EINE
//     Transaktion, erst danach durabel, danach die Listen frisch;
//   • auf dem Rechner ohne Datenbank die geprueften Buchungen (`expenses.create`, …) ueber die Bruecke.
//
// Geprueft wird VOR dem Schicken mit derselben Regel, die der Primary anwendet — ein unbrauchbarer
// Rumpf verlaesst den Rechner nicht, und die Maske sagt auf beiden Rechnern dasselbe. Beim Aendern
// reist nur, was sich gegen den geladenen Stand geaendert hat, und die gesehene FASSUNG dazu.
// ════════════════════════════════════════════════════════════════════════════
import type { Expense, Purchase, RecurringExpenseTemplate } from '@/core/models/types';
import { runOnPrimary } from '@/core/data/primary-action';
import { runExclusive } from '@/core/bridge/command-scheduler';
import { saveDatabaseDurably } from '@/core/db/database';
import type { SharedWrites, WriteAdapters, WriteOutcome } from '@/core/data/shared-write';
import { useExpenseStore, reloadLinkedExpenseViews } from '@/stores/expenseStore';
import { useRecurringExpenseStore } from '@/stores/recurringExpenseStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import {
  EXPENSE_EDIT_FIELDS, TEMPLATE_EDIT_FIELDS, localHouseCtx,
  expenseCreateIntent, expenseEditFields, templateCreateIntent, templateEditFields,
  createExpenseFromIntent, updateExpenseInHouse, recordExpensePaymentInHouse,
  createTemplateInHouse, updateTemplateInHouse,
  recordPurchasePaymentInHouse, applyCreditToPurchaseInHouse,
  refundStandaloneCreditInHouse, paySupplierInHouse, applySupplierCreditToExpensesInHouse,
  type ExpenseCreateIntent, type PayTiming, type TemplateCreateIntent,
} from './payables-house';

/** Was eine Maske von ihrer Schreibweiche braucht — `useSharedWrite` passt direkt, `useSharedWrites` ueber `viaWrites`. */
export interface PayablesWrite<T> {
  readonly remote: boolean;
  save: (adapters: WriteAdapters<T>) => Promise<WriteOutcome<T>>;
}

/** Eine Seite mit mehreren Buchungen (`useSharedWrites`): ein Waechter je Buchung, eine Anzeige. */
export function viaWrites<T>(w: SharedWrites, op: string): PayablesWrite<T> {
  return { remote: w.remote, save: (a) => w.save<T>(op, a) };
}

type Result = Record<string, unknown>;

function absage<T>(e: unknown): WriteOutcome<T> {
  const code = (e as { code?: unknown })?.code;
  return {
    kind: 'business_error',
    code: typeof code === 'string' && code ? code : 'LOCAL_WRITE_REJECTED',
    message: e instanceof Error ? e.message : String(e),
  };
}

const unveraendert = <T>(value: T): WriteOutcome<T> => ({ kind: 'ok', value, replayed: false });

/** Die Fassung, die die Maske gesehen hat — sie kommt mit dem geladenen Datensatz (beide Rechner). */
export function seenRevision(x: unknown): number | undefined {
  const r = Number((x as { revision?: unknown } | null | undefined)?.revision);
  return Number.isInteger(r) && r >= 1 ? r : undefined;
}

function ohneFassung<T>(): WriteOutcome<T> {
  return { kind: 'business_error', code: 'REVISION_UNKNOWN', message: 'this record is not loaded yet — reload the page and try again' };
}

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);

// ── Frisch lesen ───────────────────────────────────────────────────────────
// Am Primary ruft `runOnPrimary` diese Funktionen nach der Handlung (auch nach einem Rollback); auf
// PC2 holen dieselben Ladefunktionen den Stand vom Primary (`hydrateFromPrimary`).

function expensesHier(): void {
  useExpenseStore.getState().loadExpenses();
  useSupplierStore.getState().loadSuppliers();
}
function templatesHier(): void {
  useRecurringExpenseStore.getState().loadTemplates();
  useExpenseStore.getState().loadExpenses();
}
function purchasesHier(): void {
  usePurchaseStore.getState().loadPurchases();
  useSupplierStore.getState().loadSuppliers();
}
function supplierHier(): void {
  useExpenseStore.getState().loadExpenses();
  usePurchaseStore.getState().loadPurchases();
  useSupplierStore.getState().loadSuppliers();
}
/** Auf PC2 kennt nur der geladene Datensatz seine Quelle — Reparatur/Auftrag zeigen danach „Paid". */
function linkedViewsFern(expense: Expense): void {
  if (expense.relatedModule === 'repair') void import('@/stores/repairStore').then((m) => m.useRepairStore.getState().loadRepairLines());
  if (expense.relatedModule === 'order') void import('@/stores/orderStore').then((m) => m.useOrderStore.getState().loadOrders());
}

async function speichern<T>(write: PayablesWrite<T>, adapters: WriteAdapters<T>, fern: () => void): Promise<WriteOutcome<T>> {
  const r = await write.save(adapters);
  if (r.kind === 'ok' && write.remote) fern();
  return r;
}

// ── Ausgaben ───────────────────────────────────────────────────────────────

export interface ExpenseCreateForm {
  category?: string;
  amount?: number;
  paymentMethod?: string;
  expenseDate?: string;
  description?: string;
  timing: PayTiming;
  partialAmount?: number;
  employeeId?: string;
}

/** „Create Expense": die Absicht (Zahlweise statt Bezahltem) — der Primary leitet die Erstzahlung ab. */
export async function saveExpenseCreate(write: PayablesWrite<Result>, form: ExpenseCreateForm): Promise<WriteOutcome<Result>> {
  let intent: ExpenseCreateIntent;
  try {
    intent = expenseCreateIntent({
      category: form.category, amount: form.amount, paymentMethod: form.paymentMethod,
      expenseDate: form.expenseDate, description: form.description, timing: form.timing,
      partialAmount: form.timing === 'partial' ? form.partialAmount : undefined,
      employeeId: form.employeeId,
    });
  } catch (e) { return absage(e); }
  return speichern(write, {
    local: () => runOnPrimary(() => createExpenseFromIntent(intent, localHouseCtx()) as unknown as Result, expensesHier),
    remote: () => ({ ...intent }),
  }, expensesHier);
}

/** „Edit Expense → Save": nur die geaenderten Formularfelder, gegen die gesehene Fassung. */
export async function saveExpenseUpdate(write: PayablesWrite<Result>, base: Expense, form: Partial<Expense>): Promise<WriteOutcome<Result>> {
  const diff: Record<string, unknown> = {};
  for (const k of EXPENSE_EDIT_FIELDS) {
    const next = form[k];
    if (next === undefined) continue;
    const prev = base[k];
    const same = k === 'amount' ? F(prev) === F(next) : (prev ?? '') === (next ?? '');
    if (!same) diff[k] = k === 'description' && next === '' ? null : next;
  }
  if (Object.keys(diff).length === 0) return unveraendert({ expenseId: base.id, changed: [] });
  let fields: ReturnType<typeof expenseEditFields>;
  try { fields = expenseEditFields(diff); } catch (e) { return absage(e); }
  const rev = seenRevision(base);
  if (write.remote && rev === undefined) return ohneFassung();
  return speichern(write, {
    local: () => runOnPrimary(() => updateExpenseInHouse(base.id, fields, localHouseCtx(), rev) as unknown as Result, expensesHier),
    remote: () => ({ expenseId: base.id, expectedRevision: rev, ...diff }),
  }, expensesHier);
}

/** „Record Payment" (ExpenseList, Lieferant, Reparatur, Auftrag — ein Modal). */
export async function saveExpensePayment(
  write: PayablesWrite<Result>, expense: Expense, amount: number, method: string,
): Promise<WriteOutcome<Result>> {
  if (!(F(amount) > 0)) return absage({ code: 'PAYMENT_AMOUNT_INVALID', message: 'Payment amount must be positive.' });
  const rev = seenRevision(expense);
  if (write.remote && rev === undefined) return ohneFassung();
  return speichern(write, {
    local: () => runOnPrimary(
      () => recordExpensePaymentInHouse(expense.id, amount, method, localHouseCtx(), { expectedRevision: rev }) as unknown as Result,
      () => { expensesHier(); reloadLinkedExpenseViews(expense.id); },
    ),
    remote: () => ({ expenseId: expense.id, expectedRevision: rev, amount, method }),
  }, () => { expensesHier(); linkedViewsFern(expense); });
}

// ── Dauerauftraege ─────────────────────────────────────────────────────────

/** „Create Recurring": Vorlage und faellige Monate in EINER Buchung. */
export async function saveTemplateCreate(write: PayablesWrite<Result>, form: Record<string, unknown>): Promise<WriteOutcome<Result>> {
  let intent: TemplateCreateIntent;
  try { intent = templateCreateIntent(form); } catch (e) { return absage(e); }
  return speichern(write, {
    local: () => runOnPrimary(() => createTemplateInHouse(intent, localHouseCtx()) as unknown as Result, templatesHier),
    remote: () => ({ ...intent }),
  }, templatesHier);
}

/** „Edit Template → Save" und „Pause/Resume" (Zielwert): nur das Geaenderte, nie `lastGeneratedPeriod`. */
export async function saveTemplateUpdate(
  write: PayablesWrite<Result>, base: RecurringExpenseTemplate, form: Partial<RecurringExpenseTemplate>,
): Promise<WriteOutcome<Result>> {
  const diff: Record<string, unknown> = {};
  for (const k of TEMPLATE_EDIT_FIELDS) {
    const next = form[k];
    if (next === undefined) continue;
    const prev = base[k];
    const same = k === 'amount' ? F(prev) === F(next) : (prev ?? '') === (next ?? '');
    if (same) continue;
    diff[k] = (k === 'description' || k === 'endDate' || k === 'employeeId') && next === '' ? null : next;
  }
  if (Object.keys(diff).length === 0) return unveraendert({ templateId: base.id, changed: [] });
  let fields: ReturnType<typeof templateEditFields>;
  try { fields = templateEditFields(diff); } catch (e) { return absage(e); }
  const rev = seenRevision(base);
  if (write.remote && rev === undefined) return ohneFassung();
  return speichern(write, {
    local: () => runOnPrimary(() => updateTemplateInHouse(base.id, fields, localHouseCtx(), rev) as unknown as Result, templatesHier),
    remote: () => ({ templateId: base.id, expectedRevision: rev, ...diff }),
  }, templatesHier);
}

/**
 * Der Tageslauf des Generators (Ausgabenliste) — am Primary in der Schreibreihenfolge, damit er nie
 * in die offene Klammer eines Fernauftrags schreibt. Auf PC2 gibt es ihn nicht: dort fuehrt der
 * Primary seine Monate selbst.
 */
export function runDueGeneratorOnPrimary(now?: string): Promise<{ created: number; skipped: number; errors: string[] }> {
  return runExclusive(async () => {
    const r = useRecurringExpenseStore.getState().runDueGenerator(now);
    if (r.created > 0) await saveDatabaseDurably();
    return r;
  });
}

// ── Einkauf ────────────────────────────────────────────────────────────────

/** „Add Payment" (bar/Bank/Benefit) am Einkauf. */
export async function savePurchasePayment(
  write: PayablesWrite<Result>, purchase: Purchase, amount: number, method: string, reference?: string,
): Promise<WriteOutcome<Result>> {
  if (!(F(amount) > 0)) return absage({ code: 'PAYMENT_AMOUNT_INVALID', message: 'Payment amount must be positive.' });
  const rev = seenRevision(purchase);
  if (write.remote && rev === undefined) return ohneFassung();
  const ref = reference && reference.trim() ? reference : undefined;
  return speichern(write, {
    local: () => runOnPrimary(
      () => recordPurchasePaymentInHouse(purchase.id, amount, method, localHouseCtx(), { expectedRevision: rev, reference: ref }) as unknown as Result,
      purchasesHier,
    ),
    remote: () => ({ purchaseId: purchase.id, expectedRevision: rev, amount, method, ...(ref ? { reference: ref } : {}) }),
  }, purchasesHier);
}

/** „Add Payment → Credit": das Haus waehlt die Guthabenzeilen (FIFO, dieser Lieferant, diese Filiale). */
export async function savePurchaseCredit(write: PayablesWrite<Result>, purchase: Purchase, amount: number): Promise<WriteOutcome<Result>> {
  if (!(F(amount) > 0)) return absage({ code: 'PAYMENT_AMOUNT_INVALID', message: 'the credit amount must be positive' });
  const rev = seenRevision(purchase);
  if (write.remote && rev === undefined) return ohneFassung();
  return speichern(write, {
    local: () => runOnPrimary(() => applyCreditToPurchaseInHouse(purchase.id, amount, localHouseCtx(), rev) as unknown as Result, purchasesHier),
    remote: () => ({ purchaseId: purchase.id, expectedRevision: rev, amount }),
  }, purchasesHier);
}

// ── Lieferant ──────────────────────────────────────────────────────────────

/** „Refund Credit": ein unbenutztes Standalone-Guthaben zurueck auf das Ursprungskonto. */
export function saveSupplierRefund(write: PayablesWrite<Result>, creditId: string): Promise<WriteOutcome<Result>> {
  return speichern(write, {
    local: () => runOnPrimary(() => refundStandaloneCreditInHouse(creditId, localHouseCtx()) as unknown as Result, supplierHier),
    remote: () => ({ creditId }),
  }, supplierHier);
}

export interface SupplierPayForm {
  supplierId: string;
  amount: number;
  method: string;
  mode: 'fifo' | 'manual';
  allocations?: Array<{ kind: 'expense' | 'purchase'; id: string; amount: number }>;
}

/** „Pay Supplier — Bulk": EINE Buchung ueber alle Posten; FIFO rechnet der Primary. */
export function saveSupplierPay(write: PayablesWrite<Result>, form: SupplierPayForm): Promise<WriteOutcome<Result>> {
  if (!(F(form.amount) > 0)) return Promise.resolve(absage({ code: 'PAYMENT_AMOUNT_INVALID', message: 'the payment amount must be positive' }));
  const allocations = form.mode === 'manual' ? (form.allocations ?? []).filter((a) => F(a.amount) > 0) : undefined;
  const req = { supplierId: form.supplierId, amount: form.amount, method: form.method, mode: form.mode, ...(allocations ? { allocations } : {}) };
  return speichern(write, {
    local: () => runOnPrimary(() => paySupplierInHouse(req, localHouseCtx()) as unknown as Result, supplierHier),
    remote: () => ({ ...req }),
  }, supplierHier);
}

/** „Pay Supplier → Credit": Guthaben gegen offene Ausgaben, der atomare Schreiber des Hauses. */
export function saveSupplierCredit(write: PayablesWrite<Result>, supplierId: string, amount: number): Promise<WriteOutcome<Result>> {
  if (!(F(amount) > 0)) return Promise.resolve(absage({ code: 'PAYMENT_AMOUNT_INVALID', message: 'Requested amount must be greater than zero.' }));
  return speichern(write, {
    local: () => runOnPrimary(() => applySupplierCreditToExpensesInHouse(supplierId, amount, localHouseCtx()) as unknown as Result, supplierHier),
    remote: () => ({ supplierId, amount }),
  }, supplierHier);
}
