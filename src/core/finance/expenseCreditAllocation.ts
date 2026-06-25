// ═══════════════════════════════════════════════════════════
// LATAIF — Supplier-Credit → Expense FIFO-Planer (Slice B, rein)
// ═══════════════════════════════════════════════════════════
//
// EINE seiteneffektfreie FIFO-Planung fuer "welche Credits begleichen welche Expenses".
// Genutzt von ZWEI Stellen, damit es nur EINEN Algorithmus gibt:
//   1. supplierStore.applySupplierCreditsToExpenses (AUTORITATIV) — laedt frisch IN der
//      Transaktion, ruft diesen Planer, validiert, schreibt allein die Mutationen.
//   2. PaySupplierModal-Vorschau (NICHT autoritativ) — ruft denselben Planer auf dem
//      aktuellen UI-Snapshot, rein informativ.
//
// Regeln (deckungsgleich mit dem Store-Writer):
//   - alles in Fils (Minor Units), keine BHD-Toleranz (kein 0.005), kein DB-Zugriff, keine Mutation
//   - Expenses deterministisch nach createdAt ASC, dann id ASC
//   - Credits  deterministisch nach createdAt ASC, dann id ASC
//   - greedy: aelteste Expense zuerst voll, je Expense aus aeltestem verfuegbarem Credit
//   - Validierung wirft klar bei: Betrag <= 0, Betrag > offene Expense-Summe, Betrag > Credit-Summe
//   - liefert Allokationsplan UND eine Expense-Vorschau (settled vorher/nachher, Status nachher)

export interface PlannerExpenseInput {
  id: string;
  createdAt: string;
  amountF: number;   // urspruenglicher Betrag in Fils
  settledF: number;  // bereits beglichen (cash + credit) in Fils
}

export interface PlannerCreditInput {
  id: string;
  createdAt: string;
  totalF: number;    // Credit-Gesamtbetrag in Fils
  usedF: number;     // bereits verbraucht in Fils
}

export interface CreditExpenseAllocation {
  expenseId: string;
  creditId: string;
  amountF: number;   // Fils
}

export interface CreditExpensePreviewRow {
  expenseId: string;
  amountF: number;          // Original, Fils
  settledBeforeF: number;   // cash + credit vor dieser Einloesung, Fils
  appliedF: number;         // jetzt aus Credit angewendet, Fils
  remainingAfterF: number;  // Rest danach, Fils
  statusAfter: 'PENDING' | 'PAID';
}

export interface SupplierCreditExpensePlan {
  requestedF: number;
  appliedF: number;
  allocations: CreditExpenseAllocation[];
  preview: CreditExpensePreviewRow[];
  openExpenseTotalF: number;
  creditTotalF: number;
}

// Fils → "x.xxx" nur fuer Fehlermeldungen (deckungsgleich mit dem frueheren Store-Wortlaut).
const fmtBhd = (f: number) => (f / 1000).toFixed(3);

function byCreatedThenId(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  const c = (a.createdAt || '').localeCompare(b.createdAt || '');
  if (c !== 0) return c;
  return (a.id || '').localeCompare(b.id || '');
}

/**
 * Reiner FIFO-Planer (keine DB, keine Mutation, keine Ledger-Buchung).
 * Sortiert/filtert die Eingaben selbst und wirft bei ungueltigem/zu hohem Betrag.
 */
export function planSupplierCreditExpenseAllocations(
  expenses: PlannerExpenseInput[],
  credits: PlannerCreditInput[],
  requestedFils: number,
): SupplierCreditExpensePlan {
  const reqF = Math.round(requestedFils);
  if (!(reqF > 0)) throw new Error('Requested amount must be greater than zero.');

  // Offene Expenses: remF = amount − settled (Fils), nur > 0, deterministisch sortiert.
  const sortedExpenses = expenses
    .map(e => ({ id: e.id, createdAt: e.createdAt, amountF: Math.round(e.amountF), settledF: Math.round(e.settledF) }))
    .map(e => ({ ...e, remF: e.amountF - e.settledF }))
    .filter(e => e.remF > 0)
    .sort(byCreatedThenId);

  // Offene Credits: availF = total − used (Fils), nur > 0, deterministisch sortiert.
  const sortedCredits = credits
    .map(c => ({ id: c.id, createdAt: c.createdAt, totalF: Math.round(c.totalF), usedF: Math.round(c.usedF) }))
    .map(c => ({ ...c, availF: c.totalF - c.usedF }))
    .filter(c => c.availF > 0)
    .sort(byCreatedThenId);

  const openExpenseTotalF = sortedExpenses.reduce((s, e) => s + e.remF, 0);
  const creditTotalF = sortedCredits.reduce((s, c) => s + c.availF, 0);

  if (reqF > openExpenseTotalF) {
    throw new Error(`Requested amount (${fmtBhd(reqF)}) exceeds the supplier's open expenses (${fmtBhd(openExpenseTotalF)}).`);
  }
  if (reqF > creditTotalF) {
    throw new Error(`Requested amount (${fmtBhd(reqF)}) exceeds available supplier credit (${fmtBhd(creditTotalF)}).`);
  }

  const allocations: CreditExpenseAllocation[] = [];
  const appliedByExpense = new Map<string, number>();
  let need = reqF;
  let ci = 0;
  for (const exp of sortedExpenses) {
    if (need <= 0) break;
    let expRem = exp.remF;
    while (expRem > 0 && need > 0) {
      while (ci < sortedCredits.length && sortedCredits[ci].availF <= 0) ci++;
      if (ci >= sortedCredits.length) break;   // defensiv — durch Validierung ausgeschlossen
      const cr = sortedCredits[ci];
      const takeF = Math.min(expRem, cr.availF, need);
      if (takeF <= 0) break;
      allocations.push({ expenseId: exp.id, creditId: cr.id, amountF: takeF });
      appliedByExpense.set(exp.id, (appliedByExpense.get(exp.id) || 0) + takeF);
      expRem -= takeF; cr.availF -= takeF; need -= takeF;
    }
  }
  if (need > 0) throw new Error('Internal allocation error: could not fully distribute the requested amount.');

  const preview: CreditExpensePreviewRow[] = [];
  for (const exp of sortedExpenses) {
    const appliedF = appliedByExpense.get(exp.id) || 0;
    if (appliedF <= 0) continue;
    const remainingAfterF = Math.max(0, exp.amountF - exp.settledF - appliedF);
    preview.push({
      expenseId: exp.id,
      amountF: exp.amountF,
      settledBeforeF: exp.settledF,
      appliedF,
      remainingAfterF,
      statusAfter: remainingAfterF <= 0 ? 'PAID' : 'PENDING',
    });
  }

  return { requestedF: reqF, appliedF: reqF, allocations, preview, openExpenseTotalF, creditTotalF };
}
