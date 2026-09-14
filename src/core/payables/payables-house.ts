// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Verbindlichkeiten: Ausgaben, Dauerauftraege, Einkaufszahlungen und
// Lieferanten-Guthaben als EINE Hausfolge — fuer die Maske des Primary und fuer den Fernbefehl.
//
// Was vorher schief lag (auditiert, nicht angenommen):
//
//   • „Create Expense" schrieb Beleg, Erstzahlung und Buchungen in drei getrennten Schritten; ein
//     gescheiterter Post wurde verschluckt. Die Gehaltsregel pruefte erst NACH der Nummernvergabe.
//   • „Record Payment" kappte eine Ueberzahlung still auf den Rest (`min(amount, remaining)`).
//   • „Edit Expense" schrieb den ganzen Stand beim Oeffnen zurueck und korrigierte die Buchung nie,
//     wenn Betrag oder Datum sich aenderten; Betrag 0 und Betrag unter dem Bezahlten gingen durch.
//   • „Resume" eines pausierten Dauerauftrags holte JEDEN Pausenmonat nach — samt Barzahlungen —,
//     obwohl die Maske verspricht, Pause „keeps the schedule and lets you resume later".
//   • Eine Einkaufszahlung ueberschrieb den guthabenbewussten Rest mit total − cash.
//   • „Pay Supplier" rechnete den Rest einer Ausgabe ohne eingeloestes Guthaben, zahlte in einer
//     Schleife ohne Klammer und verlor bei einem Wiederholen die Zuordnung; der Guthaben-Modus hing
//     am Alt-Sync-Server und kam am Primary nie an.
//
// Die Regeln dieser Datei:
//
//   1. Alles laeuft INNERHALB einer bereits offenen Transaktion (`runOnPrimary` oder der Fernauftrag).
//      Hier gibt es kein BEGIN/COMMIT und kein durables Speichern. Die Store-Aktionen, die andere
//      Module weiter rufen, klammern sich selbst (`atomar`) — und verschachteln sich nur, wenn schon
//      eine Klammer offen ist.
//   2. Gelesen wird aus der DATENBANK, nie aus einem Store-Zwischenstand.
//   3. Erst pruefen, dann schreiben. Ein Nein ist ein `PayablesRejected` mit festem Code.
//   4. Gebucht wird ueber die VORHANDENEN Buchungsfunktionen; ein gescheiterter Post wirft.
//   5. Jeder genannte Datensatz muss in DER Filiale liegen, deren Buecher dieser Rechner fuehrt.
//
// Keine erfundenen Grenzen: jede Regel hier stammt aus einer vorhandenen Invariante (positiver
// Betrag, Gehalt braucht Mitarbeiter, nie mehr als offen, Guthaben ≤ offen), einer Maske (Tag 1..31,
// „Nothing open for this supplier") oder aus der Buchungslogik (s. PURCHASE_OVERPAYMENT_WITH_CREDIT).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import type { Expense, ExpenseCategory, PurchasePayment, PurchaseStatus } from '@/core/models/types';
import { isBookedRepairCost } from '@/core/models/types';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackDelete, trackPayment, trackStatusChange } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';
import {
  postExpense, postExpensePayment, postExpenseSupplierCreditPayment, postPurchasePayment,
  postStandaloneSupplierCredit, reverseSource, hasLedgerEntries, hasReversalFor,
  inLedgerTransaction, beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import {
  computeExpenseSettlement, creditPaidForExpense, expenseHasActiveCreditSettlement,
  SUPPLIER_CREDIT_AMOUNT_LOCK_MESSAGE,
} from '@/core/finance/expenseSettlement';
import { planSupplierCreditExpenseAllocations } from '@/core/finance/expenseCreditAllocation';
import { isClientMode } from '@/core/bridge/client-mode';
import { assertSupplierOverpayMutable, reconcilePurchaseOverpayCredit, OverpayCreditRedeemed } from './purchase-overpay';

// ── Grundlagen ─────────────────────────────────────────────────────────────

/** Die zehn Buchungen dieses Bereichs — Maske (useSharedWrite) und Fernbefehl benutzen DIESE Namen. */
export const PAYABLES_OP = {
  EXPENSES_CREATE: 'expenses.create',
  EXPENSES_UPDATE: 'expenses.update',
  EXPENSES_RECORD_PAYMENT: 'expenses.record_payment',
  EXPENSES_TEMPLATE_CREATE: 'expenses.template_create',
  EXPENSES_TEMPLATE_UPDATE: 'expenses.template_update',
  PURCHASES_RECORD_PAYMENT: 'purchases.record_payment',
  PURCHASES_APPLY_CREDIT: 'purchases.apply_credit',
  SUPPLIERS_REFUND_CREDIT: 'suppliers.refund_credit',
  SUPPLIERS_PAY: 'suppliers.pay',
  SUPPLIERS_APPLY_CREDIT: 'suppliers.apply_credit',
} as const;

/** Ein fachliches Nein der Verbindlichkeiten — am Primary eine Meldung, fern ein eingefrorenes Urteil. */
export class PayablesRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PayablesRejected';
    this.code = code;
  }
}
const nein = (code: string, message: string): PayablesRejected => new PayablesRejected(code, message);

/** Wer, wo, wann — am Primary aus der Sitzung, fern aus der geprueften Identitaet. */
export interface HouseCtx {
  readonly branchId: string;
  readonly userId: string;
  readonly now: string;
}

/** Der Rahmen einer Handlung am Primary. KEIN stilles 'branch-main': ohne Sitzung gibt es keine Buecher. */
export function localHouseCtx(): HouseCtx {
  let branchId = '';
  let userId = '';
  try { branchId = currentBranchId(); userId = currentUserId(); } catch { /* unten abgewiesen */ }
  if (!branchId) throw nein('NO_SESSION', 'no signed-in branch — nothing can be booked');
  return { branchId, userId, now: new Date().toISOString() };
}

/** Ein Rechner ohne Buecher (PC2) schreibt NIE in eine lokale Datenbank — die Handlung geht zum Primary. */
export function assertHouseBooks(): void {
  if (isClientMode()) {
    throw nein('CLIENT_HAS_NO_BOOKS', 'this computer keeps no books — the action is sent to the main computer');
  }
}

/**
 * Die Klammer fuer die Store-Aktionen, die andere Module weiter aufrufen: allein atomar, innerhalb
 * einer schon offenen Handlung ein Teil von ihr (dann entscheidet die aeussere Klammer).
 */
export function atomar<T>(fn: () => T): T {
  assertHouseBooks();
  if (inLedgerTransaction()) return fn();
  beginLedgerTransaction();
  try {
    const out = fn();
    commitLedgerTransaction();
    return out;
  } catch (e) {
    rollbackLedgerTransaction();
    throw e;
  }
}

// BHD = 3 Dezimalstellen (Fils). Vergleiche in Minor Units, keine 0.005-Toleranz.
const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;
const dayOf = (iso: string): string => iso.split('T')[0];
const fmt = (f: number): string => B(f).toFixed(3);
const txt = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'Rent', 'Salary', 'Utilities', 'CardFees', 'RepairCosts', 'Transport', 'ConsignorLoss', 'Inventory', 'Miscellaneous',
  // POST-PARITY PP-14 — legt nur die Reparatur an (Kundenware); die Maske bietet sie nicht an.
  'RepairServiceCost',
];
export const PAY_METHODS = ['cash', 'bank', 'benefit'] as const;
export type PayMethod = typeof PAY_METHODS[number];
export const PAY_TIMINGS = ['now', 'partial', 'later'] as const;
export type PayTiming = typeof PAY_TIMINGS[number];

function positiveF(v: unknown, code: string, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || F(v) <= 0) throw nein(code, `${what} must be a positive amount`);
  return F(v);
}
function methodOf(v: unknown): PayMethod {
  if (!(PAY_METHODS as readonly unknown[]).includes(v)) throw nein('PAYMENT_METHOD_INVALID', `unknown payment method: ${String(v)}`);
  return v as PayMethod;
}
function categoryOf(v: unknown): ExpenseCategory {
  if (!(EXPENSE_CATEGORIES as readonly unknown[]).includes(v)) throw nein('EXPENSE_CATEGORY_INVALID', `unknown expense category: ${String(v)}`);
  return v as ExpenseCategory;
}
function isoDateOf(v: unknown, code: string, what: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw nein(code, `${what} must be a date (YYYY-MM-DD)`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw nein(code, `${what} is not a real date`);
  return v;
}
function textOf(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw nein('FIELD_INVALID', `${what} must be text`);
  return v === '' ? undefined : v;
}

/** Die gesehene Fassung, INNERHALB der Transaktion gegen die Zeile selbst. */
function assertSeen(table: 'expenses' | 'recurring_expense_templates' | 'purchases', id: string, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = Number(query(`SELECT revision FROM ${table} WHERE id = ?`, [id])[0]?.revision ?? 0);
  if (now !== expected) {
    throw nein('RECORD_CHANGED', `this record changed since you opened it (you saw ${expected}, it is now ${now}) — reload and try again`);
  }
}
const revisionOf = (table: 'expenses' | 'recurring_expense_templates' | 'purchases', id: string): number =>
  Number(query(`SELECT revision FROM ${table} WHERE id = ?`, [id])[0]?.revision ?? 0);

function supplierInBranch(id: string, branchId: string): void {
  if (!query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ?', [id, branchId])[0]) {
    throw nein('SUPPLIER_NOT_FOUND', 'no such supplier in this branch');
  }
}
function employeeInBranch(id: string, branchId: string): void {
  if (!query('SELECT id FROM employees WHERE id = ? AND branch_id = ?', [id, branchId])[0]) {
    throw nein('EMPLOYEE_NOT_FOUND', 'no such employee in this branch');
  }
}

// ── Ausgabe anlegen ─────────────────────────────────────────────────────────

/** Was die Maske „New Expense" meint — die Absicht, nicht das Ergebnis. */
export interface ExpenseCreateIntent {
  category: ExpenseCategory;
  amount: number;
  paymentMethod: PayMethod;
  expenseDate: string;
  description?: string;
  timing: PayTiming;
  /** Nur bei `timing: 'partial'`: jetzt bezahlt, 0 < x ≤ Betrag. */
  partialAmount?: number;
  employeeId?: string;
  supplierId?: string;
}

/** Die Regel der Maske als Pruefung — dieselbe am Primary, vor dem Schicken und im Fernbefehl. */
export function expenseCreateIntent(raw: Record<string, unknown>): ExpenseCreateIntent {
  const category = categoryOf(raw.category);
  const amountF = positiveF(raw.amount, 'EXPENSE_AMOUNT_INVALID', 'the expense amount');
  const paymentMethod = methodOf(raw.paymentMethod);
  const expenseDate = isoDateOf(raw.expenseDate, 'EXPENSE_DATE_INVALID', 'the expense date');
  if (!(PAY_TIMINGS as readonly unknown[]).includes(raw.timing)) throw nein('EXPENSE_TIMING_INVALID', 'timing is now, partial or later');
  const timing = raw.timing as PayTiming;
  const out: ExpenseCreateIntent = { category, amount: B(amountF), paymentMethod, expenseDate, timing };
  if (timing === 'partial') {
    const partF = typeof raw.partialAmount === 'number' && Number.isFinite(raw.partialAmount) ? F(raw.partialAmount) : 0;
    if (partF <= 0 || partF > amountF) {
      throw nein('EXPENSE_PARTIAL_INVALID', `the amount paid now must be more than 0 and at most ${fmt(amountF)}`);
    }
    out.partialAmount = B(partF);
  } else if (raw.partialAmount !== undefined && raw.partialAmount !== null) {
    throw nein('EXPENSE_PARTIAL_INVALID', 'an amount paid now belongs to a partial payment');
  }
  const description = textOf(raw.description, 'description');
  if (description !== undefined) out.description = description;
  const employeeId = textOf(raw.employeeId, 'employeeId');
  const supplierId = textOf(raw.supplierId, 'supplierId');
  if (employeeId) out.employeeId = employeeId;
  if (supplierId) out.supplierId = supplierId;
  // Dieselbe Regel wie `createExpense` — nur jetzt VOR jeder Nummernvergabe.
  if (category === 'Salary' && !employeeId) {
    throw nein('EXPENSE_SALARY_NEEDS_EMPLOYEE', 'Salary expenses require an employee. Pick an employee or change the category.');
  }
  return out;
}

/** Was aus der Absicht folgt: der Primary leitet die Erstzahlung ab, nicht der Client. */
export function initialPaidOf(i: ExpenseCreateIntent): number {
  if (i.timing === 'now') return i.amount;
  if (i.timing === 'partial') return i.partialAmount ?? 0;
  return 0;
}

/** Die volle Anlage — auch fuer die Module, die eine Ausgabe miterzeugen (Metall, Kommission, Dauerauftrag). */
export interface ExpenseCreateCore {
  category: ExpenseCategory;
  amount: number;
  paymentMethod: PayMethod;
  expenseDate: string;
  description?: string;
  initialPaid: number;
  employeeId?: string;
  supplierId?: string;
  relatedModule?: string;
  relatedEntityId?: string;
  recurringTemplateId?: string;
}

export interface ExpenseCreated {
  expenseId: string;
  expenseNumber: string;
  paymentId: string | null;
  amount: number;
  paidAmount: number;
  status: 'PENDING' | 'PAID';
}

/**
 * EINE Folge: Beleg, Erstzahlung, beide Buchungen. Vorher drei Commits und ein verschluckter Post.
 * Alle Pruefungen stehen VOR `getNextDocumentNumber` — ein Nein verbrennt keine Nummer.
 */
export function createExpenseInHouse(core: ExpenseCreateCore, ctx: HouseCtx): ExpenseCreated {
  assertHouseBooks();
  const amountF = positiveF(core.amount, 'EXPENSE_AMOUNT_INVALID', 'the expense amount');
  const category = categoryOf(core.category);
  const method = methodOf(core.paymentMethod);
  const expenseDate = isoDateOf(core.expenseDate, 'EXPENSE_DATE_INVALID', 'the expense date');
  const paidF = F(core.initialPaid);
  if (paidF < 0 || paidF > amountF) {
    throw nein('EXPENSE_PARTIAL_INVALID', `the amount paid now must be between 0 and ${fmt(amountF)}`);
  }
  if (category === 'Salary' && !core.employeeId) {
    throw nein('EXPENSE_SALARY_NEEDS_EMPLOYEE', 'Salary expenses require an employee. Pick an employee or change the category.');
  }
  if (core.employeeId) employeeInBranch(core.employeeId, ctx.branchId);
  if (core.supplierId) supplierInBranch(core.supplierId, ctx.branchId);

  const db = getDatabase();
  const id = uuid();
  const expenseNumber = getNextDocumentNumber('EXP');
  // Der Betrag bleibt, wie der Aufrufer ihn nennt (Altverhalten); gerechnet wird in Fils.
  const amount = Number(core.amount);
  const initialPaid = paidF === amountF ? amount : B(paidF);
  const status: 'PENDING' | 'PAID' = paidF >= amountF ? 'PAID' : 'PENDING';
  db.run(
    `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
      expense_date, description, related_module, related_entity_id, supplier_id, status, recurring_template_id,
      employee_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, expenseNumber, category, amount, initialPaid, method, expenseDate,
     core.description || null, core.relatedModule || null, core.relatedEntityId || null,
     core.supplierId || null, status, core.recurringTemplateId || null,
     core.employeeId || null, ctx.now, ctx.userId || null]
  );
  trackInsert('expenses', id, { expenseNumber, category, amount, paidAmount: initialPaid, status });

  let paymentId: string | null = null;
  if (paidF > 0) {
    paymentId = uuid();
    db.run(
      `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [paymentId, id, initialPaid, method, expenseDate, 'Initial payment on creation', ctx.now]
    );
    trackInsert('expense_payments', paymentId, { expenseId: id, amount: initialPaid, method });
  }

  // ZIEL.md §3a — DR EXPENSES_OPERATING / CR AP; die Erstzahlung DR AP / CR Kasse. Beide STRIKT:
  // scheitert eine, gibt es auch die Ausgabe nicht.
  postExpense({
    id, expenseNumber, branchId: ctx.branchId, category, amount, paidAmount: initialPaid, paymentMethod: method,
    expenseDate, description: core.description, relatedModule: core.relatedModule,
    relatedEntityId: core.relatedEntityId, supplierId: core.supplierId, status, createdAt: ctx.now,
  } as Expense);
  if (paymentId) {
    postExpensePayment(
      { id: paymentId, expenseId: id, amount: initialPaid, method, paidAt: expenseDate, createdAt: ctx.now, note: 'Initial payment on creation' },
      core.supplierId,
    );
  }
  return { expenseId: id, expenseNumber, paymentId, amount, paidAmount: initialPaid, status };
}

/** „New Expense" aus der Maske: die Absicht wird zur Anlage. */
export function createExpenseFromIntent(intent: ExpenseCreateIntent, ctx: HouseCtx): ExpenseCreated {
  // POST-PARITY PP-14 — der Dienstleistungs-Einstand der Kundenreparatur entsteht nur an der Reparatur.
  if (intent.category === 'RepairServiceCost') {
    throw nein('EXPENSE_CATEGORY_RESERVED', 'repair service costs are booked by the repair itself');
  }
  return createExpenseInHouse({ ...intent, initialPaid: initialPaidOf(intent) }, ctx);
}

// ── Ausgabe aendern ─────────────────────────────────────────────────────────

/** Nur diese Felder aendert „Edit Expense". Zuordnung, Mitarbeiter, Status und Bezahltes nie. */
export const EXPENSE_EDIT_FIELDS = ['category', 'amount', 'expenseDate', 'description', 'paymentMethod'] as const;
export interface ExpenseEditFields {
  category?: ExpenseCategory;
  amount?: number;
  expenseDate?: string;
  /** `null` = Beschreibung entfernen. */
  description?: string | null;
  paymentMethod?: PayMethod;
}

export function expenseEditFields(raw: Record<string, unknown>): ExpenseEditFields {
  const out: ExpenseEditFields = {};
  if (raw.category !== undefined) out.category = categoryOf(raw.category);
  if (raw.amount !== undefined) out.amount = B(positiveF(raw.amount, 'EXPENSE_AMOUNT_INVALID', 'the expense amount'));
  if (raw.expenseDate !== undefined) out.expenseDate = isoDateOf(raw.expenseDate, 'EXPENSE_DATE_INVALID', 'the expense date');
  if (raw.description !== undefined) out.description = raw.description === null ? null : (textOf(raw.description, 'description') ?? null);
  if (raw.paymentMethod !== undefined) out.paymentMethod = methodOf(raw.paymentMethod);
  return out;
}

function liveExpense(id: string, branchId: string): Record<string, unknown> {
  const r = query('SELECT * FROM expenses WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!r) throw nein('EXPENSE_NOT_FOUND', 'no such expense in this branch');
  return r;
}

function expenseOf(r: Record<string, unknown>): Expense {
  return {
    id: String(r.id), expenseNumber: String(r.expense_number ?? ''), branchId: String(r.branch_id ?? ''),
    category: (r.category as ExpenseCategory) || 'Miscellaneous', amount: Number(r.amount) || 0,
    paidAmount: Number(r.paid_amount) || 0, paymentMethod: (r.payment_method as PayMethod) || 'cash',
    expenseDate: String(r.expense_date ?? ''), description: txt(r.description),
    relatedModule: txt(r.related_module), relatedEntityId: txt(r.related_entity_id), supplierId: txt(r.supplier_id),
    status: (r.status as Expense['status']) || 'PENDING', createdAt: String(r.created_at ?? ''),
  };
}

export interface ExpenseUpdated { expenseId: string; status: string; amount: number; revision: number; changed: string[] }

/**
 * „Edit Expense": nur das Genannte, gegen die gesehene Fassung. Aendern sich Betrag oder Datum,
 * wird die Aufwandsbuchung storniert und neu gebucht (vorher blieb sie auf dem alten Stand).
 */
export function updateExpenseInHouse(expenseId: string, raw: ExpenseEditFields, ctx: HouseCtx, expectedRevision?: number): ExpenseUpdated {
  assertHouseBooks();
  const row = liveExpense(expenseId, ctx.branchId);
  assertSeen('expenses', expenseId, expectedRevision);
  if (String(row.status) === 'CANCELLED') throw nein('EXPENSE_CANCELLED', 'a cancelled expense is not edited');
  const f = expenseEditFields(raw as Record<string, unknown>);
  // POST-PARITY PP-13 — die kapitalisierte Werkstattschuld einer eigenen Reparatur hängt am Einstand des
  // Artikels: ihren Betrag ändert nur die Reparaturzeile, und keine Reparaturausgabe wechselt über die
  // Kategorie zwischen Aufwand und Bestand (sonst zählte der Betrag doppelt oder gar nicht).
  if (txt(row.related_module) === 'repair') {
    const catChange = f.category !== undefined && f.category !== row.category;
    const amountChange = f.amount !== undefined && F(f.amount) !== F(row.amount);
    const booked = isBookedRepairCost({ category: String(row.category), relatedModule: 'repair' });
    const toBooked = f.category !== undefined && isBookedRepairCost({ category: f.category, relatedModule: 'repair' });
    if ((catChange && (toBooked || booked)) || (booked && amountChange)) {
      throw nein('EXPENSE_REPAIR_COST_LOCKED',
        'this is a booked repair cost — change or cancel its repair line (or change the repair) instead');
    }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const changed: Record<string, unknown> = {};
  const put = (col: string, key: string, v: unknown): void => { sets.push(`${col} = ?`); vals.push(v); changed[key] = v; };
  if (f.category !== undefined && f.category !== row.category) put('category', 'category', f.category);
  const amountChanged = f.amount !== undefined && F(f.amount) !== F(row.amount);
  if (amountChanged) put('amount', 'amount', f.amount);
  const dateChanged = f.expenseDate !== undefined && f.expenseDate !== row.expense_date;
  if (dateChanged) put('expense_date', 'expenseDate', f.expenseDate);
  if (f.description !== undefined && (f.description ?? null) !== (txt(row.description) ?? null)) put('description', 'description', f.description ?? null);
  if (f.paymentMethod !== undefined && f.paymentMethod !== row.payment_method) put('payment_method', 'paymentMethod', f.paymentMethod);
  if (sets.length === 0) {
    return { expenseId, status: String(row.status), amount: Number(row.amount), revision: revisionOf('expenses', expenseId), changed: [] };
  }

  const nextCategory = f.category ?? String(row.category);
  if (nextCategory === 'Salary' && !row.employee_id) {
    throw nein('EXPENSE_SALARY_NEEDS_EMPLOYEE', 'a Salary expense needs an employee — this one has none');
  }
  const creditPaid = creditPaidForExpense(expenseId);
  const nextAmount = amountChanged ? Number(f.amount) : Number(row.amount);
  if (amountChanged) {
    // D1 erweitert: nie unter das schon Beglichene (cash + credit). Vorher nur bei aktiver
    // Guthaben-Einloesung — bei Barzahlung ging der Betrag unter das Bezahlte.
    const settledF = F(row.paid_amount) + F(creditPaid);
    if (F(nextAmount) < settledF) {
      throw nein('EXPENSE_AMOUNT_BELOW_SETTLED', expenseHasActiveCreditSettlement(expenseId)
        ? SUPPLIER_CREDIT_AMOUNT_LOCK_MESSAGE
        : `the amount cannot go below what is already paid (${fmt(settledF)})`);
    }
  }

  const db = getDatabase();
  db.run(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`, [...vals, expenseId]);
  const status = computeExpenseSettlement(nextAmount, Number(row.paid_amount) || 0, creditPaid, String(row.status)).status;
  if (status !== row.status) db.run('UPDATE expenses SET status = ? WHERE id = ?', [status, expenseId]);

  if ((amountChanged || dateChanged) && hasLedgerEntries('EXPENSE', expenseId)) {
    reverseSource('EXPENSE', expenseId, ctx.now);
    postExpense(expenseOf(query('SELECT * FROM expenses WHERE id = ?', [expenseId])[0]));
  }
  trackUpdate('expenses', expenseId, { ...changed, status });
  return { expenseId, status, amount: nextAmount, revision: revisionOf('expenses', expenseId), changed: Object.keys(changed) };
}

// ── Ausgabe bezahlen ────────────────────────────────────────────────────────

export interface ExpensePaid {
  expenseId: string;
  paymentId: string;
  amount: number;
  paidAmount: number;
  remainingAmount: number;
  status: string;
  revision: number;
}

/**
 * „Record Payment": der Rest ist guthabenbewusst (cash + credit), und mehr als offen wird
 * ABGEWIESEN — vorher wurde still auf den Rest gekappt, und die Maske meldete den vollen Betrag.
 */
export function recordExpensePaymentInHouse(
  expenseId: string, amount: number, method: string, ctx: HouseCtx,
  opts: { expectedRevision?: number; paidAt?: string; note?: string } = {},
): ExpensePaid {
  assertHouseBooks();
  if (typeof amount !== 'number' || !Number.isFinite(amount) || F(amount) <= 0) {
    throw nein('PAYMENT_AMOUNT_INVALID', 'Payment amount must be positive.');
  }
  const m = methodOf(method);
  const row = liveExpense(expenseId, ctx.branchId);
  assertSeen('expenses', expenseId, opts.expectedRevision);
  if (String(row.status) === 'CANCELLED') throw nein('EXPENSE_CANCELLED', 'Cannot record payment on cancelled expense');
  const creditPaid = creditPaidForExpense(expenseId);
  const remainingF = Math.max(0, F(row.amount) - F(row.paid_amount) - F(creditPaid));
  if (remainingF <= 0) throw nein('EXPENSE_ALREADY_PAID', 'Expense is already fully paid');
  const payF = F(amount);
  if (payF > remainingF) {
    throw nein('EXPENSE_OVERPAYMENT', `the payment (${fmt(payF)}) is more than what is open on this expense (${fmt(remainingF)})`);
  }
  const paidAt = opts.paidAt ? isoDateOf(opts.paidAt, 'PAYMENT_DATE_INVALID', 'the payment date') : dayOf(ctx.now);
  const paid = B(payF);
  const newPaid = B(F(row.paid_amount) + payF);
  const status = computeExpenseSettlement(Number(row.amount), newPaid, creditPaid, String(row.status)).status;

  const db = getDatabase();
  const paymentId = uuid();
  db.run(
    `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [paymentId, expenseId, paid, m, paidAt, opts.note || null, ctx.now]
  );
  db.run('UPDATE expenses SET paid_amount = ?, payment_method = ?, status = ? WHERE id = ?', [newPaid, m, status, expenseId]);
  trackInsert('expense_payments', paymentId, { expenseId, amount: paid, method: m });
  trackUpdate('expenses', expenseId, { paidAmount: newPaid, status });
  postExpensePayment(
    { id: paymentId, expenseId, amount: paid, method: m, paidAt, createdAt: ctx.now, note: opts.note },
    txt(row.supplier_id),
  );
  return {
    expenseId, paymentId, amount: paid, paidAmount: newPaid, remainingAmount: B(remainingF - payF),
    status, revision: revisionOf('expenses', expenseId),
  };
}

// ── Dauerauftraege ──────────────────────────────────────────────────────────

function periodKey(year: number, monthZeroBased: number): string {
  return `${year}-${String(monthZeroBased + 1).padStart(2, '0')}`;
}
/** Der Monat „jetzt" — ortszeitlich, wie der bisherige Generator (`new Date()`). */
export function monthKeyOf(nowIso: string): string {
  const d = new Date(nowIso);
  return periodKey(d.getFullYear(), d.getMonth());
}
export function previousMonthKey(nowIso: string): string {
  const d = new Date(nowIso);
  return d.getMonth() === 0 ? periodKey(d.getFullYear() - 1, 11) : periodKey(d.getFullYear(), d.getMonth() - 1);
}
function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return m >= 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function* monthsBetween(startKey: string, endKey: string): Generator<{ year: number; month: number; key: string }> {
  const [sy, sm] = startKey.split('-').map(Number);
  const [ey, em] = endKey.split('-').map(Number);
  let y = sy, m = sm - 1;
  while (y < ey || (y === ey && m <= em - 1)) {
    yield { year: y, month: m, key: periodKey(y, m) };
    m++;
    if (m > 11) { m = 0; y++; }
  }
}

export interface TemplateCreateIntent {
  category: ExpenseCategory;
  amount: number;
  paymentMethod: PayMethod;
  payNowDefault: boolean;
  description?: string;
  dayOfMonth: number;
  startDate: string;
  endDate?: string;
  employeeId?: string;
}

function dayOfMonthOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 31) throw nein('TEMPLATE_DAY_INVALID', 'the day of month is 1..31');
  return v;
}

export function templateCreateIntent(raw: Record<string, unknown>): TemplateCreateIntent {
  const category = categoryOf(raw.category);
  const amount = B(positiveF(raw.amount, 'TEMPLATE_AMOUNT_INVALID', 'the recurring amount'));
  const paymentMethod = methodOf(raw.paymentMethod);
  if (typeof raw.payNowDefault !== 'boolean') throw nein('FIELD_INVALID', 'payNowDefault must be true or false');
  const out: TemplateCreateIntent = {
    category, amount, paymentMethod, payNowDefault: raw.payNowDefault,
    dayOfMonth: dayOfMonthOf(raw.dayOfMonth),
    startDate: isoDateOf(raw.startDate, 'TEMPLATE_DATE_INVALID', 'the start date'),
  };
  if (raw.endDate !== undefined && raw.endDate !== null && raw.endDate !== '') out.endDate = isoDateOf(raw.endDate, 'TEMPLATE_DATE_INVALID', 'the end date');
  const description = textOf(raw.description, 'description');
  if (description !== undefined) out.description = description;
  const employeeId = textOf(raw.employeeId, 'employeeId');
  if (employeeId) out.employeeId = employeeId;
  if (category === 'Salary' && !employeeId) throw nein('EXPENSE_SALARY_NEEDS_EMPLOYEE', 'Recurring Salary templates require an employee.');
  return out;
}

export interface TemplateCreated { templateId: string; created: number; skipped: number }

/**
 * „Create Recurring": die Vorlage UND die schon faelligen Monate in DERSELBEN Transaktion.
 * Vorher lief der Generator danach, eigenstaendig, mit verschlucktem Fehler.
 */
export function createTemplateInHouse(
  intent: TemplateCreateIntent, ctx: HouseCtx, legacy: { supplierId?: string; active?: boolean } = {},
): TemplateCreated {
  assertHouseBooks();
  const i = templateCreateIntent(intent as unknown as Record<string, unknown>);
  if (i.employeeId) employeeInBranch(i.employeeId, ctx.branchId);
  if (legacy.supplierId) supplierInBranch(legacy.supplierId, ctx.branchId);
  const id = uuid();
  getDatabase().run(
    `INSERT INTO recurring_expense_templates
       (id, branch_id, category, amount, payment_method, pay_now_default, description,
        day_of_month, start_date, end_date, active, last_generated_period,
        supplier_id, employee_id, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, i.category, i.amount, i.paymentMethod, i.payNowDefault ? 1 : 0, i.description || null,
     i.dayOfMonth, i.startDate, i.endDate || null, legacy.active === false ? 0 : 1,
     legacy.supplierId || null, i.employeeId || null, ctx.now, ctx.now, ctx.userId || null]
  );
  trackInsert('recurring_expense_templates', id, { category: i.category, amount: i.amount });
  const g = generateDueForTemplate(id, ctx);
  return { templateId: id, created: g.created, skipped: g.skipped };
}

/** Nur diese Felder aendert „Edit Recurring Template" — `lastGeneratedPeriod` NIE (fuehrt das Haus). */
export const TEMPLATE_EDIT_FIELDS = [
  'category', 'amount', 'paymentMethod', 'payNowDefault', 'description', 'dayOfMonth', 'startDate', 'endDate', 'employeeId', 'active',
] as const;
export interface TemplateEditFields {
  category?: ExpenseCategory;
  amount?: number;
  paymentMethod?: PayMethod;
  payNowDefault?: boolean;
  description?: string | null;
  dayOfMonth?: number;
  startDate?: string;
  endDate?: string | null;
  employeeId?: string | null;
  active?: boolean;
}

export function templateEditFields(raw: Record<string, unknown>): TemplateEditFields {
  const out: TemplateEditFields = {};
  if (raw.category !== undefined) out.category = categoryOf(raw.category);
  if (raw.amount !== undefined) out.amount = B(positiveF(raw.amount, 'TEMPLATE_AMOUNT_INVALID', 'the recurring amount'));
  if (raw.paymentMethod !== undefined) out.paymentMethod = methodOf(raw.paymentMethod);
  for (const k of ['payNowDefault', 'active'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'boolean') throw nein('FIELD_INVALID', `${k} must be true or false`);
    out[k] = raw[k] as boolean;
  }
  if (raw.description !== undefined) out.description = raw.description === null ? null : (textOf(raw.description, 'description') ?? null);
  if (raw.dayOfMonth !== undefined) out.dayOfMonth = dayOfMonthOf(raw.dayOfMonth);
  if (raw.startDate !== undefined) out.startDate = isoDateOf(raw.startDate, 'TEMPLATE_DATE_INVALID', 'the start date');
  if (raw.endDate !== undefined) out.endDate = raw.endDate === null || raw.endDate === '' ? null : isoDateOf(raw.endDate, 'TEMPLATE_DATE_INVALID', 'the end date');
  if (raw.employeeId !== undefined) out.employeeId = raw.employeeId === null || raw.employeeId === '' ? null : (textOf(raw.employeeId, 'employeeId') ?? null);
  return out;
}

function liveTemplate(id: string, branchId: string): Record<string, unknown> {
  const r = query('SELECT * FROM recurring_expense_templates WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!r) throw nein('TEMPLATE_NOT_FOUND', 'no such recurring expense in this branch');
  return r;
}

export interface TemplateUpdated { templateId: string; active: boolean; revision: number; created: number; resumed: boolean; changed: string[] }

/**
 * „Edit" / „Pause" / „Resume" — eine Handlung mit dem ZIELWERT, kein Umschalter.
 *
 * Resume (aus → an) holt die Pausenmonate NICHT nach: die Maske verspricht, Pause „keeps the
 * schedule and lets you resume later". Also rueckt der Stand auf den Vormonat vor, und erzeugt wird
 * nur, was JETZT faellig ist (vorher: jeder Pausenmonat samt Barzahlung).
 */
export function updateTemplateInHouse(templateId: string, raw: TemplateEditFields, ctx: HouseCtx, expectedRevision?: number): TemplateUpdated {
  assertHouseBooks();
  const row = liveTemplate(templateId, ctx.branchId);
  assertSeen('recurring_expense_templates', templateId, expectedRevision);
  const f = templateEditFields(raw as Record<string, unknown>);
  const wasActive = Number(row.active) === 1;

  const sets: string[] = [];
  const vals: unknown[] = [];
  const changed: Record<string, unknown> = {};
  const put = (col: string, key: string, v: unknown): void => { sets.push(`${col} = ?`); vals.push(v); changed[key] = v; };
  if (f.category !== undefined && f.category !== row.category) put('category', 'category', f.category);
  if (f.amount !== undefined && F(f.amount) !== F(row.amount)) put('amount', 'amount', f.amount);
  if (f.paymentMethod !== undefined && f.paymentMethod !== row.payment_method) put('payment_method', 'paymentMethod', f.paymentMethod);
  if (f.payNowDefault !== undefined && f.payNowDefault !== (Number(row.pay_now_default) === 1)) put('pay_now_default', 'payNowDefault', f.payNowDefault ? 1 : 0);
  if (f.description !== undefined && (f.description ?? null) !== (txt(row.description) ?? null)) put('description', 'description', f.description ?? null);
  if (f.dayOfMonth !== undefined && f.dayOfMonth !== Number(row.day_of_month)) put('day_of_month', 'dayOfMonth', f.dayOfMonth);
  if (f.startDate !== undefined && f.startDate !== row.start_date) put('start_date', 'startDate', f.startDate);
  if (f.endDate !== undefined && (f.endDate ?? null) !== (txt(row.end_date) ?? null)) put('end_date', 'endDate', f.endDate ?? null);
  if (f.employeeId !== undefined && (f.employeeId ?? null) !== (txt(row.employee_id) ?? null)) put('employee_id', 'employeeId', f.employeeId ?? null);
  const resumed = f.active === true && !wasActive;
  if (f.active !== undefined && f.active !== wasActive) put('active', 'active', f.active ? 1 : 0);

  const nextCategory = f.category ?? String(row.category);
  const nextEmployee = f.employeeId !== undefined ? f.employeeId : txt(row.employee_id);
  if (nextCategory === 'Salary' && !nextEmployee) throw nein('EXPENSE_SALARY_NEEDS_EMPLOYEE', 'Salary templates require an employee.');
  if (f.employeeId) employeeInBranch(f.employeeId, ctx.branchId);

  if (resumed) {
    const prev = previousMonthKey(ctx.now);
    const last = txt(row.last_generated_period);
    if (!last || last < prev) put('last_generated_period', 'lastGeneratedPeriod', prev);
  }
  if (sets.length === 0) {
    return { templateId, active: wasActive, revision: revisionOf('recurring_expense_templates', templateId), created: 0, resumed: false, changed: [] };
  }
  sets.push('updated_at = ?');
  vals.push(ctx.now);
  getDatabase().run(`UPDATE recurring_expense_templates SET ${sets.join(', ')} WHERE id = ?`, [...vals, templateId]);
  trackUpdate('recurring_expense_templates', templateId, changed);
  const created = resumed ? generateDueForTemplate(templateId, ctx).created : 0;
  const active = f.active ?? wasActive;
  return { templateId, active, revision: revisionOf('recurring_expense_templates', templateId), created, resumed, changed: Object.keys(changed) };
}

/**
 * Der Generator fuer EINE Vorlage — dieselbe Monatsregel wie bisher, aber strikt: ein Monat, der
 * nicht angelegt werden kann, nimmt die ganze Folge zurueck. `last_generated_period` wird jetzt
 * auch synchronisiert (vorher ohne Spur).
 */
export function generateDueForTemplate(templateId: string, ctx: HouseCtx): { created: number; skipped: number } {
  const out = { created: 0, skipped: 0 };
  const t = liveTemplate(templateId, ctx.branchId);
  if (Number(t.active) !== 1) return out;
  const todayKey = monthKeyOf(ctx.now);
  const startDate = String(t.start_date ?? '');
  const startDateMonthKey = startDate.slice(0, 7);
  const last = txt(t.last_generated_period);
  const startKey = last ? nextMonthKey(last) : startDateMonthKey;
  if (startKey > todayKey) { out.skipped++; return out; }
  const endKey = txt(t.end_date)?.slice(0, 7) ?? null;
  const effectiveEnd = endKey && endKey < todayKey ? endKey : todayKey;
  if (startKey > effectiveEnd) { out.skipped++; return out; }
  const finalStart = startKey < startDateMonthKey ? startDateMonthKey : startKey;
  const category = (t.category as ExpenseCategory) || 'Miscellaneous';
  const amount = Number(t.amount) || 0;
  const payNow = Number(t.pay_now_default) === 1;
  const dayOfMonth = Number(t.day_of_month) || 1;

  let lastDone: string | null = null;
  for (const m of monthsBetween(finalStart, effectiveEnd)) {
    const dup = query(
      `SELECT 1 FROM expenses WHERE recurring_template_id = ? AND substr(expense_date, 1, 7) = ? AND status != 'CANCELLED' LIMIT 1`,
      [templateId, m.key],
    );
    if (dup.length > 0) { out.skipped++; lastDone = m.key; continue; }
    const expenseDate = m.key === startDateMonthKey
      ? startDate
      : `${m.key}-${String(Math.min(dayOfMonth, new Date(m.year, m.month + 1, 0).getDate())).padStart(2, '0')}`;
    createExpenseInHouse({
      category, amount,
      paymentMethod: (PAY_METHODS as readonly string[]).includes(String(t.payment_method)) ? t.payment_method as PayMethod : 'bank',
      expenseDate,
      description: txt(t.description) || `Recurring · ${category}`,
      initialPaid: payNow ? amount : 0,
      supplierId: txt(t.supplier_id),
      employeeId: txt(t.employee_id),
      recurringTemplateId: templateId,
    }, ctx);
    out.created++;
    lastDone = m.key;
  }
  if (lastDone) {
    getDatabase().run('UPDATE recurring_expense_templates SET last_generated_period = ?, updated_at = ? WHERE id = ?', [lastDone, ctx.now, templateId]);
    trackUpdate('recurring_expense_templates', templateId, { lastGeneratedPeriod: lastDone });
  }
  return out;
}

/** Die aktiven Vorlagen der Filiale — fuer den Tageslauf (je Vorlage eine eigene Klammer). */
export function activeTemplateIds(branchId: string): string[] {
  return query('SELECT id FROM recurring_expense_templates WHERE branch_id = ? AND active = 1 ORDER BY created_at ASC, id ASC', [branchId])
    .map((r) => String(r.id));
}

// ── Einkauf bezahlen ────────────────────────────────────────────────────────

function livePurchase(id: string, branchId: string): Record<string, unknown> {
  const r = query('SELECT id, branch_id, supplier_id, status, total_amount, paid_amount FROM purchases WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!r) throw nein('PURCHASE_NOT_FOUND', 'no such purchase in this branch');
  return r;
}
function purchaseCreditPaidF(purchaseId: string): number {
  return F(query(`SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method = 'credit'`, [purchaseId])[0]?.t);
}
/** Dieselbe Statusregel wie `computeStatus` — nur auf dem Beglichenen (cash + credit), in Fils. */
function purchaseStatusOf(totalF: number, settledF: number): PurchaseStatus {
  if (totalF <= 0) return 'DRAFT';
  if (settledF <= 0) return 'UNPAID';
  if (settledF >= totalF) return 'PAID';
  return 'PARTIALLY_PAID';
}
function liveOrRedeemed<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof OverpayCreditRedeemed) throw nein(e.code, e.message);
    throw e;
  }
}

export interface PurchasePaid {
  purchaseId: string;
  paymentId: string;
  amount: number;
  paidAmount: number;
  remainingAmount: number;
  status: PurchaseStatus;
  overpayCredit: number;
  revision: number;
}

/**
 * „Add Payment" (bar/Bank/Benefit) auf einen Einkauf. Rest und Status sind guthabenbewusst — vorher
 * schrieb die Zahlung `total − cash` zurueck und ueberschrieb, was eine Guthaben-Einloesung gesetzt
 * hatte. Eine Ueberzahlung wird wie bisher zum Lieferanten-Guthaben (PURCHASE_OVERPAY), jetzt in
 * DERSELBEN Transaktion.
 *
 * PURCHASE_OVERPAYMENT_WITH_CREDIT: die Overpay-Gutschrift rechnet auf `paid_amount − total`
 * (cash-only, Entscheidung 5). Auf einem Einkauf, der schon teils mit Guthaben beglichen ist,
 * koennte der Teil ueber dem offenen Rest deshalb NICHT zu Guthaben werden — er stuende als
 * Phantom-Soll auf AP. Das wird abgewiesen statt verloren.
 */
export function recordPurchasePaymentInHouse(
  purchaseId: string, amount: number, method: string, ctx: HouseCtx,
  opts: { expectedRevision?: number; reference?: string; note?: string } = {},
): PurchasePaid {
  assertHouseBooks();
  if (typeof amount !== 'number' || !Number.isFinite(amount) || F(amount) <= 0) {
    throw nein('PAYMENT_AMOUNT_INVALID', 'Payment amount must be positive.');
  }
  if (method === 'credit') throw nein('PAYMENT_METHOD_INVALID', 'supplier credit is applied through "apply credit", not recorded as a payment');
  const m = methodOf(method);
  const p = livePurchase(purchaseId, ctx.branchId);
  assertSeen('purchases', purchaseId, opts.expectedRevision);
  if (String(p.status) === 'CANCELLED') throw nein('PURCHASE_CANCELLED', 'a cancelled purchase takes no payment');
  const totalF = F(p.total_amount);
  const cashF = F(p.paid_amount);
  const creditF = purchaseCreditPaidF(purchaseId);
  const payF = F(amount);
  const openF = Math.max(0, totalF - cashF - creditF);
  if (creditF > 0 && payF > openF) {
    throw nein('PURCHASE_OVERPAYMENT_WITH_CREDIT',
      `this purchase is partly settled with supplier credit — pay at most the open ${fmt(openF)}; more could not become supplier credit`);
  }
  const newPaid = B(cashF + payF);
  liveOrRedeemed(() => assertSupplierOverpayMutable(purchaseId, newPaid));

  const settledF = cashF + payF + creditF;
  const remaining = B(Math.max(0, totalF - settledF));
  const status = purchaseStatusOf(totalF, settledF);
  const paidAt = dayOf(ctx.now);
  const paymentId = uuid();
  const db = getDatabase();
  db.run(
    `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [paymentId, purchaseId, B(payF), m, paidAt, opts.reference || null, opts.note || null, ctx.now]
  );
  db.run('UPDATE purchases SET paid_amount = ?, remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?',
    [newPaid, remaining, status, ctx.now, purchaseId]);
  trackPayment('purchases', purchaseId, B(payF), m);
  if (status !== p.status) trackStatusChange('purchases', purchaseId, String(p.status), status);
  // LAN-Sync (Gruppe 3): EIN Header-Snapshot nach dem Recompute + die Payment-Row mit stabiler id.
  trackChange('purchases', purchaseId, 'update', {});
  trackChange('purchase_payments', paymentId, 'insert', {});

  const payment: PurchasePayment = {
    id: paymentId, purchaseId, amount: B(payF), method: m, paidAt, reference: opts.reference, note: opts.note, createdAt: ctx.now,
  };
  postPurchasePayment(payment, String(p.supplier_id ?? ''));
  // Slice 4b — der Ueberschuss ueber total_amount wird SUPPLIER_CREDIT (clawback-then-rebook).
  liveOrRedeemed(() => reconcilePurchaseOverpayCredit(purchaseId));
  const over = Number(query('SELECT COALESCE(SUM(amount), 0) AS a FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL', [purchaseId])[0]?.a ?? 0);
  return {
    purchaseId, paymentId, amount: B(payF), paidAmount: newPaid, remainingAmount: remaining, status,
    overpayCredit: over, revision: revisionOf('purchases', purchaseId),
  };
}

// ── Guthaben auf einen Einkauf ──────────────────────────────────────────────

function openCreditsOf(supplierId: string, branchId: string): Array<{ id: string; totalF: number; usedF: number; availF: number; createdAt: string }> {
  return query(
    `SELECT id, amount, used_amount, created_at FROM supplier_credits
      WHERE supplier_id = ? AND branch_id = ? AND status = 'OPEN'
      ORDER BY created_at ASC, id ASC`,
    [supplierId, branchId],
  ).map((r) => {
    const totalF = F(r.amount);
    const usedF = F(r.used_amount);
    if (totalF - usedF < 0) throw nein('SUPPLIER_CREDIT_INCONSISTENT', 'a supplier credit has a negative available balance — data inconsistency');
    return { id: String(r.id), totalF, usedF, availF: totalF - usedF, createdAt: String(r.created_at ?? '') };
  }).filter((c) => c.availF > 0);
}

/** Eine Guthabenzeile, ein Teilbetrag: used_amount, Zahlungszeile (method 'credit'), Buchung DR AP / CR SUPPLIER_CREDIT. */
function writeCreditPayment(
  credit: { id: string; totalF: number; usedF: number }, purchaseId: string, supplierId: string, takeF: number, ctx: HouseCtx,
): string {
  const db = getDatabase();
  const newUsedF = credit.usedF + takeF;
  if (newUsedF > credit.totalF) throw nein('SUPPLIER_CREDIT_INSUFFICIENT', 'not enough supplier credit');
  const creditStatus = newUsedF >= credit.totalF ? 'USED' : 'OPEN';
  db.run('UPDATE supplier_credits SET used_amount = ?, status = ? WHERE id = ?', [B(newUsedF), creditStatus, credit.id]);
  const paymentId = uuid();
  const paidAt = dayOf(ctx.now);
  db.run(
    `INSERT INTO purchase_payments (id, purchase_id, amount, method, paid_at, reference, note, created_at)
     VALUES (?, ?, ?, 'credit', ?, ?, 'Applied from supplier credit', ?)`,
    [paymentId, purchaseId, B(takeF), paidAt, credit.id, ctx.now]
  );
  trackUpdate('supplier_credits', credit.id, { usedAmount: B(newUsedF), status: creditStatus });
  trackInsert('purchase_payments', paymentId, { purchaseId, amount: B(takeF), method: 'credit' });
  postPurchasePayment({
    id: paymentId, purchaseId, amount: B(takeF), method: 'credit', paidAt, reference: credit.id,
    note: 'Applied from supplier credit', createdAt: ctx.now,
  }, supplierId);
  credit.usedF = newUsedF;
  return paymentId;
}

/** Rest und Status des Einkaufs aus cash + credit — paid_amount (Overpay-Basis) bleibt unberuehrt. */
function refreshPurchaseSettlement(purchaseId: string, ctx: HouseCtx): { remainingAmount: number; status: PurchaseStatus } {
  const r = query('SELECT total_amount, paid_amount FROM purchases WHERE id = ?', [purchaseId])[0];
  const totalF = F(r?.total_amount);
  const settledF = F(r?.paid_amount) + purchaseCreditPaidF(purchaseId);
  const remainingAmount = B(Math.max(0, totalF - settledF));
  const status = purchaseStatusOf(totalF, settledF);
  getDatabase().run('UPDATE purchases SET remaining_amount = ?, status = ?, updated_at = ? WHERE id = ?', [remainingAmount, status, ctx.now, purchaseId]);
  trackChange('purchases', purchaseId, 'update', {});
  return { remainingAmount, status };
}

export interface PurchaseCreditApplied {
  purchaseId: string;
  appliedAmount: number;
  applications: Array<{ creditId: string; paymentId: string; amount: number }>;
  remainingAmount: number;
  status: PurchaseStatus;
  revision: number;
}

/**
 * „Add Payment → Credit": das Haus waehlt die Guthabenzeilen (FIFO, NUR dieser Lieferant in DIESER
 * Filiale) — vorher lief die Schleife in der Maske, ohne Klammer, ueber Guthaben aller Filialen,
 * und ein Fehlbetrag blieb still. Der Betrag muss ganz passen: ≤ offen UND ≤ verfuegbar.
 */
export function applyCreditToPurchaseInHouse(purchaseId: string, amount: number, ctx: HouseCtx, expectedRevision?: number): PurchaseCreditApplied {
  assertHouseBooks();
  if (typeof amount !== 'number' || !Number.isFinite(amount) || F(amount) <= 0) {
    throw nein('PAYMENT_AMOUNT_INVALID', 'the credit amount must be positive');
  }
  const p = livePurchase(purchaseId, ctx.branchId);
  assertSeen('purchases', purchaseId, expectedRevision);
  if (String(p.status) === 'CANCELLED') throw nein('PURCHASE_CANCELLED', 'a cancelled purchase takes no credit');
  const needF = F(amount);
  const openF = F(p.total_amount) - F(p.paid_amount) - purchaseCreditPaidF(purchaseId);
  if (needF > openF) {
    throw nein('PURCHASE_CREDIT_EXCEEDS_OPEN',
      `Credit amount (${fmt(needF)}) exceeds the purchase's open balance (${fmt(Math.max(0, openF))}).`);
  }
  const supplierId = String(p.supplier_id ?? '');
  const credits = openCreditsOf(supplierId, ctx.branchId);
  const availF = credits.reduce((s, c) => s + c.availF, 0);
  if (needF > availF) throw nein('SUPPLIER_CREDIT_INSUFFICIENT', `Not enough supplier credit. Available: ${fmt(availF)} BHD.`);

  const applications: PurchaseCreditApplied['applications'] = [];
  let rest = needF;
  for (const c of credits) {
    if (rest <= 0) break;
    const takeF = Math.min(rest, c.availF);
    applications.push({ creditId: c.id, paymentId: writeCreditPayment(c, purchaseId, supplierId, takeF, ctx), amount: B(takeF) });
    rest -= takeF;
  }
  const s = refreshPurchaseSettlement(purchaseId, ctx);
  return { purchaseId, appliedAmount: B(needF), applications, ...s, revision: revisionOf('purchases', purchaseId) };
}

/** Der Altweg `applyCreditToPurchase(creditId, …)`: EINE genannte Zeile — strikt, ohne stilles Kappen. */
export function applyOneCreditToPurchaseInHouse(creditId: string, purchaseId: string, amount: number, ctx: HouseCtx): { paymentId: string } {
  assertHouseBooks();
  if (typeof amount !== 'number' || !Number.isFinite(amount) || F(amount) <= 0) throw nein('PAYMENT_AMOUNT_INVALID', 'the credit amount must be positive');
  const p = livePurchase(purchaseId, ctx.branchId);
  if (String(p.status) === 'CANCELLED') throw nein('PURCHASE_CANCELLED', 'a cancelled purchase takes no credit');
  const supplierId = String(p.supplier_id ?? '');
  const c = openCreditsOf(supplierId, ctx.branchId).find((x) => x.id === creditId);
  if (!c) throw nein('SUPPLIER_CREDIT_NOT_FOUND', 'no open credit of this supplier in this branch');
  const needF = F(amount);
  const openF = F(p.total_amount) - F(p.paid_amount) - purchaseCreditPaidF(purchaseId);
  if (needF > openF) throw nein('PURCHASE_CREDIT_EXCEEDS_OPEN', `Credit amount (${fmt(needF)}) exceeds the purchase's open balance (${fmt(Math.max(0, openF))}).`);
  if (needF > c.availF) throw nein('SUPPLIER_CREDIT_INSUFFICIENT', `Not enough supplier credit. Available: ${fmt(c.availF)} BHD.`);
  const paymentId = writeCreditPayment(c, purchaseId, supplierId, needF, ctx);
  refreshPurchaseSettlement(purchaseId, ctx);
  return { paymentId };
}

// ── Lieferanten-Guthaben ────────────────────────────────────────────────────

/**
 * Option B (read-only) — VOLLSTAENDIGE Validierung der Original-Source-Gruppe eines STANDALONE
 * Credits (aus `supplierStore` hierher gezogen, damit Anzeige und Rueckbuchung EINE Pruefung haben):
 * genau zwei Original-Legs, genau ein DR SUPPLIER_CREDIT und genau ein CR CASH|BANK|BENEFIT, beide
 * == Betrag (Fils), eine Transaktion, kein Leg (auch teil-) reversiert. Sonst null = „Unavailable".
 */
export function validateStandaloneCreditRefundSource(creditId: string, expectedAmount: number): 'Cash' | 'Bank' | 'Benefit' | null {
  try {
    if (hasReversalFor('SUPPLIER_PREPAYMENT', creditId)) return null;
    const legs = query(
      `SELECT e1.account AS account, e1.direction AS direction, e1.amount AS amount, e1.transaction_id AS txn,
              (SELECT COUNT(*) FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) AS rev_count
         FROM ledger_entries e1
        WHERE e1.source_module = 'SUPPLIER_PREPAYMENT' AND e1.source_id = ?
          AND e1.reverses_entry_id IS NULL`,
      [creditId]
    );
    if (legs.length !== 2) return null;
    if (legs.some(l => Number(l.rev_count) > 0)) return null;
    const want = F(expectedAmount);
    if (legs.some(l => F(l.amount) !== want)) return null;
    if (new Set(legs.map(l => String(l.txn))).size !== 1) return null;
    const drLeg = legs.find(l => l.account === 'SUPPLIER_CREDIT' && l.direction === 'DEBIT');
    const crLegs = legs.filter(l => l.direction === 'CREDIT' && (l.account === 'CASH' || l.account === 'BANK' || l.account === 'BENEFIT'));
    if (!drLeg || crLegs.length !== 1) return null;
    switch (String(crLegs[0].account)) {
      case 'CASH': return 'Cash';
      case 'BANK': return 'Bank';
      case 'BENEFIT': return 'Benefit';
      default: return null;
    }
  } catch { return null; }
}

export interface CreditRefunded { creditId: string; supplierId: string; amount: number; method: 'Cash' | 'Bank' | 'Benefit' }

/**
 * „Refund Credit": dieselbe gehaertete Folge wie bisher (frisch lesen, standalone, OPEN, unbenutzt,
 * lebende Zwei-Leg-Quelle → reverseSource SUPPLIER_PREPAYMENT + Zeile weg) — jetzt mit Filiale.
 */
export function refundStandaloneCreditInHouse(creditId: string, ctx: HouseCtx): CreditRefunded {
  assertHouseBooks();
  const c = query(
    `SELECT supplier_id, amount, used_amount, status FROM supplier_credits
      WHERE id = ? AND branch_id = ? AND source_return_id IS NULL AND source_purchase_id IS NULL`,
    [creditId, ctx.branchId],
  )[0];
  if (!c) {
    throw nein('SUPPLIER_CREDIT_NOT_FOUND', 'Supplier credit not found or not a standalone credit — it may have already been refunded or redeemed.');
  }
  if (String(c.status) !== 'OPEN') throw nein('SUPPLIER_CREDIT_NOT_OPEN', 'This supplier credit is no longer open and cannot be refunded.');
  if (F(c.used_amount) !== 0) {
    throw nein('SUPPLIER_CREDIT_REDEEMED', 'Cannot refund this supplier credit because it has already been (partially) redeemed. Reverse the redemption first.');
  }
  const method = validateStandaloneCreditRefundSource(creditId, Number(c.amount) || 0);
  if (!method) {
    throw nein('SUPPLIER_CREDIT_SOURCE_INVALID', 'Cannot refund: the original Cash/Bank/Benefit ledger entry for this credit is unavailable or invalid (missing, incomplete, amount-mismatched, or already reversed). A refund must book the money back to the original account.');
  }
  reverseSource('SUPPLIER_PREPAYMENT', creditId, ctx.now);
  getDatabase().run('DELETE FROM supplier_credits WHERE id = ?', [creditId]);
  trackDelete('supplier_credits', creditId);
  return { creditId, supplierId: String(c.supplier_id ?? ''), amount: Number(c.amount) || 0, method };
}

/** Standalone-Guthaben (Vorauszahlung): Zeile + DR SUPPLIER_CREDIT / CR Kasse, strikt. */
export function grantStandaloneCreditInHouse(supplierId: string, amount: number, method: string, note: string | undefined, ctx: HouseCtx): string {
  assertHouseBooks();
  supplierInBranch(supplierId, ctx.branchId);
  const amtF = positiveF(amount, 'PAYMENT_AMOUNT_INVALID', 'the credit amount');
  const m = methodOf(method);
  const creditId = uuid();
  getDatabase().run(
    `INSERT INTO supplier_credits (id, branch_id, supplier_id, source_return_id, source_purchase_id,
       amount, used_amount, status, note, created_at, created_by)
     VALUES (?, ?, ?, NULL, NULL, ?, 0, 'OPEN', ?, ?, ?)`,
    [creditId, ctx.branchId, supplierId, B(amtF), note || 'Supplier prepayment', ctx.now, ctx.userId || null]
  );
  trackInsert('supplier_credits', creditId, { supplierId, amount: B(amtF) });
  postStandaloneSupplierCredit(creditId, supplierId, B(amtF), m, ctx.now);
  return creditId;
}

export interface SupplierCreditOnExpenses {
  applied: number;
  allocations: Array<{ expenseId: string; creditId: string; paymentId: string; amount: number }>;
}

/**
 * „Pay Supplier → Credit": Guthaben gegen offene lieferantengebundene Ausgaben — der atomare lokale
 * Schreiber (Slice A), jetzt mit Filiale aus dem Rahmen und festen Codes. Vorher lief die Maske
 * ueber den Alt-Sync-Server, der am Primary keinen Endpunkt hat (kam dort NIE an), und dieser
 * Schreiber hatte keinen Aufrufer.
 */
export function applySupplierCreditToExpensesInHouse(supplierId: string, amount: number, ctx: HouseCtx, occurredAt?: string): SupplierCreditOnExpenses {
  assertHouseBooks();
  if (!supplierId) throw nein('SUPPLIER_NOT_FOUND', 'no supplier named');
  supplierInBranch(supplierId, ctx.branchId);
  if (typeof amount !== 'number' || !Number.isFinite(amount) || F(amount) <= 0) {
    throw nein('PAYMENT_AMOUNT_INVALID', 'Requested amount must be greater than zero.');
  }
  const occurred = occurredAt || ctx.now;
  const paidAt = occurred.includes('T') ? occurred.split('T')[0] : occurred;
  const expenseRows = query(
    `SELECT e.id AS id, e.amount AS amount, e.paid_amount AS paid, e.created_at AS created_at,
            COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep
                      WHERE ep.expense_id = e.id AND ep.method = 'credit'), 0) AS credit_paid
       FROM expenses e
      WHERE e.supplier_id = ? AND e.branch_id = ? AND e.status != 'CANCELLED'
      ORDER BY e.created_at ASC, e.id ASC`,
    [supplierId, ctx.branchId],
  );
  const openExpenses = expenseRows.map((r) => {
    const amountF = F(r.amount);
    const settledF = F(r.paid) + F(r.credit_paid);
    return { id: String(r.id), createdAt: String(r.created_at ?? ''), amountF, settledF, remF: amountF - settledF };
  }).filter((e) => e.remF > 0);
  const openCredits = openCreditsOf(supplierId, ctx.branchId);
  const reqF = F(amount);
  const openF = openExpenses.reduce((s, e) => s + e.remF, 0);
  const creditF = openCredits.reduce((s, c) => s + c.availF, 0);
  if (reqF > openF) throw nein('SUPPLIER_CREDIT_EXCEEDS_OPEN', `Requested amount (${fmt(reqF)}) exceeds the supplier's open expenses (${fmt(openF)}).`);
  if (reqF > creditF) throw nein('SUPPLIER_CREDIT_INSUFFICIENT', `Requested amount (${fmt(reqF)}) exceeds available supplier credit (${fmt(creditF)}).`);

  const { allocations } = planSupplierCreditExpenseAllocations(openExpenses, openCredits, reqF);
  const db = getDatabase();
  const result: SupplierCreditOnExpenses = { applied: 0, allocations: [] };
  const creditAppliedF = new Map<string, number>();
  const expenseAppliedF = new Map<string, number>();
  for (const a of allocations) {
    const payId = uuid();
    const amt = B(a.amountF);
    db.run(
      `INSERT INTO expense_payments (id, expense_id, amount, method, paid_at, reference, note, created_at)
       VALUES (?, ?, ?, 'credit', ?, ?, 'Applied from supplier credit', ?)`,
      [payId, a.expenseId, amt, paidAt, a.creditId, ctx.now]
    );
    trackInsert('expense_payments', payId, { expenseId: a.expenseId, amount: amt, method: 'credit', reference: a.creditId });
    postExpenseSupplierCreditPayment(payId, a.expenseId, supplierId, amt, occurred);
    creditAppliedF.set(a.creditId, (creditAppliedF.get(a.creditId) || 0) + a.amountF);
    expenseAppliedF.set(a.expenseId, (expenseAppliedF.get(a.expenseId) || 0) + a.amountF);
    result.allocations.push({ expenseId: a.expenseId, creditId: a.creditId, paymentId: payId, amount: amt });
  }
  for (const [creditId, appliedF] of creditAppliedF) {
    const cr = openCredits.find((c) => c.id === creditId)!;
    const newUsedF = cr.usedF + appliedF;
    if (newUsedF > cr.totalF) throw new Error('Internal error: credit over-application detected.');
    const st = newUsedF >= cr.totalF ? 'USED' : 'OPEN';
    db.run('UPDATE supplier_credits SET used_amount = ?, status = ? WHERE id = ?', [B(newUsedF), st, creditId]);
    trackUpdate('supplier_credits', creditId, { usedAmount: B(newUsedF), status: st });
  }
  for (const [expenseId, appliedF] of expenseAppliedF) {
    const exp = openExpenses.find((e) => e.id === expenseId)!;
    const st = exp.settledF + appliedF >= exp.amountF ? 'PAID' : 'PENDING';
    db.run(`UPDATE expenses SET status = ? WHERE id = ? AND status != 'CANCELLED'`, [st, expenseId]);
    trackUpdate('expenses', expenseId, { status: st });
  }
  result.applied = B(reqF);
  return result;
}

// ── Lieferant bezahlen (Sammelzahlung) ──────────────────────────────────────

export interface SupplierOpenItem {
  kind: 'expense' | 'purchase';
  id: string;
  number: string;
  date: string;
  remainingF: number;
  /** Nur ein Einkauf OHNE Guthaben-Einloesung kann einen Ueberschuss als Overpay-Guthaben tragen. */
  takesOverpay: boolean;
}
export interface SupplierPayAllocation { kind: 'expense' | 'purchase'; id: string; amountF: number }
export interface SupplierPayPlan { allocations: SupplierPayAllocation[]; excessF: number; overflowPurchaseId: string | null }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** FIFO: aelteste zuerst, bei gleichem Datum die Belegnummer, zuletzt die Kennung — Maske und Haus gleich. */
export function sortOpenItems<T extends { date: string; number: string; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => cmp(a.date, b.date) || cmp(a.number, b.number) || cmp(a.id, b.id));
}

/**
 * Der EINE Planer der Sammelzahlung (rein): dieselbe Funktion rechnet die Vorschau der Maske und die
 * Zahlung am Primary. FIFO verteilt aelteste zuerst und fuehrt den Ueberschuss (wie bisher) auf den
 * ersten Einkauf, der ihn tragen kann, sonst als Standalone-Guthaben; manuell muss jede Zeile
 * ≤ offen sein und die Summe genau den Betrag treffen (die Maske verlangt „Sum must match").
 */
export function planSupplierPayment(
  items: readonly SupplierOpenItem[], amountF: number, mode: 'fifo' | 'manual',
  manual: ReadonlyArray<{ kind: string; id: string; amountF: number }> = [],
): SupplierPayPlan {
  if (!(amountF > 0)) throw nein('PAYMENT_AMOUNT_INVALID', 'the payment amount must be positive');
  const sorted = sortOpenItems(items);
  if (mode === 'manual') {
    const seen = new Set<string>();
    const allocations: SupplierPayAllocation[] = [];
    let sumF = 0;
    for (const a of manual) {
      const key = `${a.kind}:${a.id}`;
      if (seen.has(key)) throw nein('ALLOCATION_DUPLICATE', 'one allocation per open item');
      seen.add(key);
      const item = sorted.find((i) => i.kind === a.kind && i.id === a.id);
      if (!item) throw nein('ALLOCATION_UNKNOWN_ITEM', `${a.kind} ${a.id} is not open for this supplier`);
      if (!(a.amountF > 0)) throw nein('ALLOCATION_INVALID', 'an allocation must be positive');
      if (a.amountF > item.remainingF) {
        throw nein('ALLOCATION_EXCEEDS_REMAINING', `${item.number}: ${fmt(a.amountF)} is more than its open ${fmt(item.remainingF)}`);
      }
      allocations.push({ kind: item.kind, id: item.id, amountF: a.amountF });
      sumF += a.amountF;
    }
    if (sumF !== amountF) {
      throw nein('ALLOCATION_SUM_MISMATCH', `Allocation sum (${fmt(sumF)}) does not match total payment (${fmt(amountF)}).`);
    }
    return { allocations, excessF: 0, overflowPurchaseId: null };
  }
  const allocations: SupplierPayAllocation[] = [];
  let pool = amountF;
  for (const item of sorted) {
    if (pool <= 0) break;
    const take = Math.min(pool, item.remainingF);
    if (take > 0) { allocations.push({ kind: item.kind, id: item.id, amountF: take }); pool -= take; }
  }
  const overflow = pool > 0 ? sorted.find((i) => i.kind === 'purchase' && i.takesOverpay) : undefined;
  return { allocations, excessF: pool, overflowPurchaseId: overflow ? overflow.id : null };
}

/** Die offenen Posten eines Lieferanten, frisch und guthabenbewusst (cash + credit), in DIESER Filiale. */
export function openSupplierItems(supplierId: string, branchId: string): SupplierOpenItem[] {
  const items: SupplierOpenItem[] = [];
  for (const r of query(
    `SELECT e.id, e.expense_number, e.expense_date, e.created_at, e.amount, e.paid_amount,
            COALESCE((SELECT SUM(ep.amount) FROM expense_payments ep WHERE ep.expense_id = e.id AND ep.method = 'credit'), 0) AS credit_paid
       FROM expenses e WHERE e.supplier_id = ? AND e.branch_id = ? AND e.status NOT IN ('PAID', 'CANCELLED')`,
    [supplierId, branchId],
  )) {
    const remainingF = F(r.amount) - F(r.paid_amount) - F(r.credit_paid);
    if (remainingF <= 0) continue;
    items.push({
      kind: 'expense', id: String(r.id), number: String(r.expense_number ?? ''),
      date: txt(r.expense_date) ?? String(r.created_at ?? '').slice(0, 10), remainingF, takesOverpay: false,
    });
  }
  for (const r of query(
    `SELECT p.id, p.purchase_number, p.purchase_date, p.total_amount, p.paid_amount,
            COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.purchase_id = p.id AND pp.method = 'credit'), 0) AS credit_paid
       FROM purchases p WHERE p.supplier_id = ? AND p.branch_id = ? AND p.status NOT IN ('PAID', 'CANCELLED')`,
    [supplierId, branchId],
  )) {
    const creditF = F(r.credit_paid);
    const remainingF = F(r.total_amount) - F(r.paid_amount) - creditF;
    if (remainingF <= 0) continue;
    items.push({
      kind: 'purchase', id: String(r.id), number: String(r.purchase_number ?? ''),
      date: String(r.purchase_date ?? ''), remainingF, takesOverpay: creditF === 0,
    });
  }
  return sortOpenItems(items);
}

export interface SupplierPayRequest {
  supplierId: string;
  amount: number;
  method: string;
  mode: 'fifo' | 'manual';
  allocations?: ReadonlyArray<{ kind: 'expense' | 'purchase'; id: string; amount: number }>;
}
export interface SupplierPaid {
  supplierId: string;
  amount: number;
  allocations: Array<{ kind: 'expense' | 'purchase'; id: string; amount: number; paymentId: string }>;
  excessAmount: number;
  excessTo: 'purchase_overpay' | 'standalone_credit' | null;
  excessRef: string | null;
}

/**
 * „Pay Supplier — Bulk": EINE Transaktion ueber alle Posten. Vorher zahlte die Maske in einer
 * Schleife ohne Klammer — ein Fehler in der Mitte liess die ersten Zahlungen stehen, und ein
 * Wiederholen zahlte sie ein zweites Mal.
 */
export function paySupplierInHouse(req: SupplierPayRequest, ctx: HouseCtx): SupplierPaid {
  assertHouseBooks();
  supplierInBranch(req.supplierId, ctx.branchId);
  const amountF = positiveF(req.amount, 'PAYMENT_AMOUNT_INVALID', 'the payment amount');
  const method = methodOf(req.method);
  if (req.mode !== 'fifo' && req.mode !== 'manual') throw nein('PAY_MODE_INVALID', 'mode is fifo or manual');
  const items = openSupplierItems(req.supplierId, ctx.branchId);
  // Die Maske bietet ohne offenen Posten gar keine Zahlung an („Nothing open for this supplier").
  if (items.length === 0) throw nein('SUPPLIER_NOTHING_OPEN', 'nothing is open for this supplier right now');
  const manual = (req.allocations ?? []).map((a) => ({ kind: a.kind, id: a.id, amountF: F(a.amount) }));
  if (req.mode === 'fifo' && manual.length > 0) throw nein('ALLOCATION_INVALID', 'FIFO decides the allocation — send none');
  const plan = planSupplierPayment(items, amountF, req.mode, manual);

  const out: SupplierPaid = { supplierId: req.supplierId, amount: B(amountF), allocations: [], excessAmount: B(plan.excessF), excessTo: null, excessRef: null };
  for (const a of plan.allocations) {
    const paymentId = a.kind === 'expense'
      ? recordExpensePaymentInHouse(a.id, B(a.amountF), method, ctx).paymentId
      : recordPurchasePaymentInHouse(a.id, B(a.amountF), method, ctx).paymentId;
    out.allocations.push({ kind: a.kind, id: a.id, amount: B(a.amountF), paymentId });
  }
  if (plan.excessF > 0) {
    if (plan.overflowPurchaseId) {
      recordPurchasePaymentInHouse(plan.overflowPurchaseId, B(plan.excessF), method, ctx);
      out.excessTo = 'purchase_overpay';
      out.excessRef = plan.overflowPurchaseId;
    } else {
      out.excessRef = grantStandaloneCreditInHouse(req.supplierId, B(plan.excessF), method, 'Supplier prepayment (PaySupplier overpayment)', ctx);
      out.excessTo = 'standalone_credit';
    }
  }
  return out;
}
