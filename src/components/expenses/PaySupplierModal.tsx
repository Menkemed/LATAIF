// v0.7.7 → v0.7.12 — Bulk-Pay an einen Supplier mit FIFO-Allokation.
//
// Use Case: Supplier hat viele offene Posten (Workshop-Expenses,
// Consignment-Payouts, Inventory-Purchases). User will eine Summe zahlen
// (z.B. 50 BHD von 5,850 offen) statt einzeln durch alle Detail-Pages.
//
// Default: FIFO — aelteste Rechnung zuerst voll, dann naechste, bis Geld
// aufgebraucht ist. User kann "Override" klicken und pro Zeile selber
// verteilen.
//
// v0.7.12 erweitert: drei Quell-Töpfe in EINEM Modal:
//   - Expenses (Workshop/Service, Consignment-Loss)  → recordExpensePayment
//   - Purchases (Consignor-Payouts, Inventory)        → purchaseStore.addPayment
// Jede Zeile traegt einen `kind`-Discriminator; Submit dispatcht per Kind.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { useExpenseStore } from '@/stores/expenseStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { query } from '@/core/db/helpers';
import { creditPaidByExpense } from '@/core/finance/expenseSettlement';
import { planSupplierCreditExpenseAllocations } from '@/core/finance/expenseCreditAllocation';

interface PaySupplierModalProps {
  supplierId: string | null;
  supplierName?: string;
  onClose: () => void;
}

// Slice B — vierte Methode 'credit' loest Supplier-Credit gegen offene supplier-verknuepfte
// Expenses ein (nur Expenses, nie Purchases). cash/bank/benefit bleiben unveraendert.
type PayMethod = 'cash' | 'bank' | 'benefit' | 'credit';

// Fils-Helfer (Minor Units) — identische Konvention wie Store/Settlement-SSOT.
const toFils = (n: number) => Math.round((n || 0) * 1000);
const fromFils = (f: number) => f / 1000;

type ItemKind =
  | 'workshop'           // expense, related_module=repair OR order
  | 'consignment_loss'   // expense, related_module=consignment, category=ConsignorLoss
  | 'consignor_payout'   // purchase, notes contain 'Consignor payout'
  | 'inventory_purchase' // purchase, normal inventory buy
  | 'other_expense';

interface OpenItem {
  /** Unified open-payable item — covers both expenses and purchases. */
  kind: ItemKind;
  /** Discriminator: 'expense' uses expenseStore.recordExpensePayment, 'purchase' uses purchaseStore.addPayment. */
  sourceTable: 'expense' | 'purchase';
  id: string;
  number: string;           // EXP-2026-… or PUR-2026-…
  description: string;
  date: string;             // YYYY-MM-DD
  remaining: number;
  sourceNumber?: string;    // verlinkter Beleg (REP-…/ORD-…/CON-…)
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

const KIND_META: Record<ItemKind, { label: string; color: string; bg: string }> = {
  workshop:           { label: 'Workshop',          color: '#0F0F10', bg: 'rgba(15,15,16,0.06)' },
  consignment_loss:   { label: 'Consignor Loss',    color: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
  consignor_payout:   { label: 'Consignor Payout',  color: '#715DE3', bg: 'rgba(113,93,227,0.08)' },
  inventory_purchase: { label: 'Inventory',         color: '#3D7FFF', bg: 'rgba(61,127,255,0.08)' },
  other_expense:      { label: 'Other',             color: '#6B7280', bg: 'rgba(107,114,128,0.08)' },
};

function classifyExpense(relatedModule: string | undefined, category: string | undefined): ItemKind {
  if (relatedModule === 'repair' || relatedModule === 'order') return 'workshop';
  if (relatedModule === 'consignment' && category === 'ConsignorLoss') return 'consignment_loss';
  return 'other_expense';
}

function classifyPurchase(notes: string | undefined): ItemKind {
  if (notes && /consignor payout/i.test(notes)) return 'consignor_payout';
  return 'inventory_purchase';
}

export function PaySupplierModal({ supplierId, supplierName, onClose }: PaySupplierModalProps) {
  const expenses = useExpenseStore(s => s.expenses);
  const recordExpensePayment = useExpenseStore(s => s.recordExpensePayment);
  const loadExpenses = useExpenseStore(s => s.loadExpenses);
  const purchases = usePurchaseStore(s => s.purchases);
  const addPurchasePayment = usePurchaseStore(s => s.addPayment);
  const grantStandaloneCredit = useSupplierStore(s => s.grantStandaloneCredit);
  // Slice B — Credit-Methode: autoritativer Writer + frische Lesepfade fuer Snapshot/Vorschau.
  const applyCreditsToExpenses = useSupplierStore(s => s.applySupplierCreditsToExpenses);
  const getOpenCredits = useSupplierStore(s => s.getOpenCredits);
  const loadSuppliers = useSupplierStore(s => s.loadSuppliers);

  const [totalAmount, setTotalAmount] = useState<number>(0);
  const [method, setMethod] = useState<PayMethod>('bank');
  const [overrideMode, setOverrideMode] = useState(false);
  // Map<itemKey, allocation> — itemKey = `${sourceTable}:${id}`
  const [manualAlloc, setManualAlloc] = useState<Record<string, number>>({});
  // Busy-Lock (alle Methoden) — UI-Disabling. refreshTick erzwingt nach einem Store-Throw im
  // Credit-Modus die Neuberechnung von Snapshot/Max/Vorschau aus frisch geladenen Daten.
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // Synchroner Re-Entry-Riegel: schuetzt auch gegen Doppel-Submit im SELBEN Tick (busy-State ist
  // async). Bei Erfolg bleibt er gesetzt (Modal schliesst) — erst ein erneutes Oeffnen (supplierId-
  // Effect) gibt ihn frei; bei Fehler/Confirm-Abbruch wird er sofort freigegeben (Retry moeglich).
  const submittingRef = useRef(false);

  const openItems = useMemo<OpenItem[]>(() => {
    if (!supplierId) return [];

    const items: OpenItem[] = [];

    // 1. Open Expenses (all modules + categories — kind discriminates downstream)
    for (const e of expenses) {
      if (e.supplierId !== supplierId) continue;
      if (e.status === 'PAID' || e.status === 'CANCELLED') continue;
      const remaining = (e.amount || 0) - (e.paidAmount || 0);
      if (remaining <= 0.005) continue;

      // Beleg-Nummer aus dem related_entity (Repair, Order, Consignment).
      let sourceNumber: string | undefined;
      try {
        if (e.relatedModule === 'order' && e.relatedEntityId) {
          const r = query(`SELECT order_number FROM orders WHERE id = ?`, [e.relatedEntityId]);
          if (r.length > 0) sourceNumber = r[0].order_number as string;
        } else if (e.relatedModule === 'repair' && e.relatedEntityId) {
          const r = query(`SELECT repair_number FROM repairs WHERE id = ?`, [e.relatedEntityId]);
          if (r.length > 0) sourceNumber = r[0].repair_number as string;
        } else if (e.relatedModule === 'consignment' && e.relatedEntityId) {
          const r = query(`SELECT consignment_number FROM consignments WHERE id = ?`, [e.relatedEntityId]);
          if (r.length > 0) sourceNumber = r[0].consignment_number as string;
        }
      } catch { /* */ }

      items.push({
        kind: classifyExpense(e.relatedModule, e.category),
        sourceTable: 'expense',
        id: e.id,
        number: e.expenseNumber,
        description: e.description || '',
        date: e.expenseDate || e.createdAt?.split('T')[0] || '',
        remaining,
        sourceNumber,
      });
    }

    // 2. Open Purchases — Consignor-Payouts + Inventory-Einkaeufe
    for (const p of purchases) {
      if (p.supplierId !== supplierId) continue;
      if (p.status === 'PAID' || p.status === 'CANCELLED') continue;
      const remaining = p.remainingAmount ?? Math.max(0, (p.totalAmount || 0) - (p.paidAmount || 0));
      if (remaining <= 0.005) continue;

      // Quell-Beleg: bei Consignor-Payout aus Notes parsen (z.B. "Consignor payout · CON-2026-00002")
      let sourceNumber: string | undefined;
      const notes = p.notes || '';
      const m = notes.match(/CON-\d+-\d+/);
      if (m) sourceNumber = m[0];

      items.push({
        kind: classifyPurchase(notes),
        sourceTable: 'purchase',
        id: p.id,
        number: p.purchaseNumber,
        description: notes,
        date: p.purchaseDate || '',
        remaining,
        sourceNumber,
      });
    }

    // FIFO: aelteste zuerst. Wenn Datums identisch (alles am selben Tag erfasst),
    // Tiebreaker via Doc-Nummer — PUR-001 vor PUR-006 etc.
    items.sort((a, b) => {
      const dCmp = a.date.localeCompare(b.date);
      if (dCmp !== 0) return dCmp;
      return a.number.localeCompare(b.number);
    });
    return items;
  }, [supplierId, expenses, purchases]);

  const totalOutstanding = useMemo(() => openItems.reduce((s, e) => s + e.remaining, 0), [openItems]);

  useEffect(() => {
    if (supplierId) {
      setTotalAmount(0);
      setMethod('bank');
      setOverrideMode(false);
      setManualAlloc({});
      setBusy(false);
      submittingRef.current = false;
    }
  }, [supplierId]);

  function itemKey(item: OpenItem): string {
    return `${item.sourceTable}:${item.id}`;
  }

  const fifoAllocation = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    let pool = totalAmount;
    for (const item of openItems) {
      if (pool <= 0.005) break;
      const take = Math.min(pool, item.remaining);
      if (take > 0.005) {
        out[itemKey(item)] = take;
        pool -= take;
      }
    }
    return out;
  }, [totalAmount, openItems]);

  const effectiveAllocation = overrideMode ? manualAlloc : fifoAllocation;
  const allocatedSum = useMemo(
    () => Object.values(effectiveAllocation).reduce((s, v) => s + (v || 0), 0),
    [effectiveAllocation],
  );

  // ─────────────────────────────────────────────────────────────
  // Slice B — Credit-Methode: Snapshot, Maximum (Fils), reine Vorschau.
  // ─────────────────────────────────────────────────────────────
  const isCredit = method === 'credit';

  // Credit-Einloesungen je Expense gebuendelt (eine GROUP-BY-Query, kein N+1) → settled = cash+credit.
  const creditPaidMap = useMemo(() => creditPaidByExpense(), [expenses, refreshTick]);

  // Offene supplier-verknuepfte Expenses (settled-aware, > 0 offen) + offene Credits — NUR Expenses,
  // Purchases fliessen bewusst NICHT ein. Reines Lesen; speist Max + Vorschau.
  const creditSnapshot = useMemo(() => {
    const emptyExp: Array<{ id: string; createdAt: string; amountF: number; settledF: number; number: string; date: string; description: string }> = [];
    const emptyCr: Array<{ id: string; createdAt: string; totalF: number; usedF: number }> = [];
    if (!supplierId) return { expenses: emptyExp, credits: emptyCr };
    const exps = expenses
      .filter(e => e.supplierId === supplierId && e.status !== 'CANCELLED')
      .map(e => ({
        id: e.id,
        createdAt: e.createdAt || '',
        amountF: toFils(e.amount || 0),
        settledF: toFils(e.paidAmount || 0) + toFils(creditPaidMap.get(e.id) || 0),
        number: e.expenseNumber,
        date: e.expenseDate || e.createdAt?.split('T')[0] || '',
        description: e.description || '',
      }))
      .filter(e => e.amountF - e.settledF > 0);
    const credits = getOpenCredits(supplierId).map(c => ({
      id: c.id, createdAt: c.createdAt || '', totalF: toFils(c.amount), usedF: toFils(c.usedAmount),
    }));
    return { expenses: exps, credits };
  }, [supplierId, expenses, creditPaidMap, getOpenCredits, refreshTick]);

  const creditAvailableFils = useMemo(
    () => creditSnapshot.credits.reduce((s, c) => s + Math.max(0, c.totalF - c.usedF), 0),
    [creditSnapshot],
  );
  const openExpenseFils = useMemo(
    () => creditSnapshot.expenses.reduce((s, e) => s + (e.amountF - e.settledF), 0),
    [creditSnapshot],
  );
  // maxApplicable = min(verfuegbarer Credit, offene Expense-Summe) — verhindert Overflow-Credit.
  const maxApplicableFils = Math.min(creditAvailableFils, openExpenseFils);
  const requestedFils = toFils(totalAmount);

  // Default-Betrag beim Wechsel auf Credit: liegt der aktuelle Betrag <= 0 ODER ueber dem Maximum,
  // wird er auf maxApplicable gesetzt; ein gueltiger bestehender Betrag bleibt erhalten. Dep NUR
  // method (nicht maxApplicableFils) → KEIN stilles Kappen, wenn sich das Maximum spaeter (z.B.
  // nach einem Store-Fehler-Reload) aendert. "Use maximum" bleibt zusaetzlich.
  useEffect(() => {
    if (method !== 'credit' || maxApplicableFils <= 0) return;
    const reqF = toFils(totalAmount);
    if (reqF <= 0 || reqF > maxApplicableFils) setTotalAmount(fromFils(maxApplicableFils));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);

  // Reine, NICHT autoritative Vorschau auf dem aktuellen Snapshot (gleicher Planer wie der Store).
  // Nur wenn der Betrag im gueltigen Bereich liegt; beim Bestaetigen rechnet der Store frisch neu.
  const creditPreview = useMemo(() => {
    if (!isCredit) return null;
    if (requestedFils <= 0 || requestedFils > maxApplicableFils) return null;
    try {
      return planSupplierCreditExpenseAllocations(creditSnapshot.expenses, creditSnapshot.credits, requestedFils);
    } catch { return null; }
  }, [isCredit, requestedFils, maxApplicableFils, creditSnapshot]);

  // Expense-Stammdaten (Nummer/Datum/Beschreibung) je id fuer die Vorschau-Tabelle.
  const creditExpenseById = useMemo(() => {
    const m = new Map<string, { number: string; date: string; description: string }>();
    for (const e of creditSnapshot.expenses) m.set(e.id, { number: e.number, date: e.date, description: e.description });
    return m;
  }, [creditSnapshot]);

  function handleToggleOverride() {
    if (!overrideMode) {
      setManualAlloc({ ...fifoAllocation });
    }
    setOverrideMode(!overrideMode);
  }

  function handleManualChange(key: string, value: number, max: number) {
    const capped = Math.max(0, Math.min(value, max));
    setManualAlloc(prev => ({ ...prev, [key]: capped }));
  }

  function handleSubmit() {
    // Re-Entry-Riegel: busy (async UI-State) UND submittingRef (synchron, schuetzt denselben Tick).
    if (busy || submittingRef.current) return;
    if (!supplierId || totalAmount <= 0) return;

    // ── Slice B — Credit-Branch: VOR Override/Excess/Confirm/Cash-Schleife. Genau EIN Store-Aufruf
    // (autoritativ; FIFO im Store). Ruft NIE recordExpensePayment/addPurchasePayment/grantStandaloneCredit
    // und erzeugt nie Overflow-Credit. ──
    if (method === 'credit') {
      submittingRef.current = true;
      setBusy(true);
      try {
        // Skalar (Fils-aligniert) — KEIN Allokationsplan aus der UI. Store laedt frisch + rechnet selbst.
        applyCreditsToExpenses(supplierId, fromFils(requestedFils));
        loadExpenses();                          // globales expenses-Array → alle Settlement-Displays
        loadSuppliers();                         // Supplier-KPIs/Liste
        onClose();                               // Erfolg: Riegel bleibt gesetzt bis Re-Open; bumpt refreshKey
      } catch (e) {
        // Tx ist komplett zurueckgerollt. Modal bleibt offen, KEINE Erfolgsmeldung; aktuellen Stand
        // neu laden + Snapshot/Max/Vorschau neu rechnen (Submit bleibt gesperrt falls Betrag zu hoch).
        alert(e instanceof Error ? e.message : String(e));
        loadExpenses();
        loadSuppliers();
        setRefreshTick(t => t + 1);
        submittingRef.current = false;           // Fehler → Retry erlauben
      } finally {
        setBusy(false);
      }
      return;
    }

    // ── cash/bank/benefit (fachlich unveraendert) ──
    const cashMethod = method as 'cash' | 'bank' | 'benefit';
    if (overrideMode && Math.abs(allocatedSum - totalAmount) > 0.005) {
      alert(`Allocation sum (${fmt(allocatedSum)}) does not match total payment (${fmt(totalAmount)}).`);
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    // Ueberschuss (nicht allozierbar): liegt ein offenes Purchase-Item vor, wird er darauf gebucht
    // → reconcilePurchaseOverpayCredit reklassiert ihn zu SUPPLIER_CREDIT (PURCHASE_OVERPAY).
    // Liegen NUR Expenses vor (kein Purchase), wird der Ueberschuss als standalone Supplier-Credit
    // gutgeschrieben (DR SUPPLIER_CREDIT / CR cash) — kein Geld geht mehr verloren.
    const excess = totalAmount - allocatedSum;
    const overflowPurchase = openItems.find(i => i.sourceTable !== 'expense');
    if (excess > 0.005 && !overflowPurchase) {
      if (!window.confirm(
        `You're paying ${fmt(totalAmount)} but only ${fmt(allocatedSum)} can be allocated ` +
        `(${fmt(excess)} excess). The excess will be credited to ${supplierName || 'this supplier'} ` +
        `as redeemable supplier credit. Continue?`
      )) {
        submittingRef.current = false;           // Confirm abgebrochen → Riegel + Busy frei, keine Mutation
        setBusy(false);
        return;
      }
    }

    try {
      for (const item of openItems) {
        const alloc = effectiveAllocation[itemKey(item)] || 0;
        if (alloc <= 0.005) continue;
        if (item.sourceTable === 'expense') {
          recordExpensePayment(item.id, alloc, cashMethod);
        } else {
          addPurchasePayment(item.id, alloc, cashMethod);
        }
      }
      // Ueberschuss verbuchen: bevorzugt auf ein offenes Purchase (PURCHASE_OVERPAY),
      // sonst als standalone Supplier-Credit (DR SUPPLIER_CREDIT / CR cash).
      if (excess > 0.005) {
        if (overflowPurchase) {
          addPurchasePayment(overflowPurchase.id, excess, cashMethod);
        } else if (supplierId) {
          grantStandaloneCredit(supplierId, excess, cashMethod, 'Supplier prepayment (PaySupplier overpayment)');
        }
      }
      onClose();                                 // Erfolg: Riegel bleibt gesetzt bis Re-Open
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      submittingRef.current = false;             // Fehler → Retry erlauben
    } finally {
      setBusy(false);
    }
  }

  // Credit-Modus: Betrag > 0 und <= maxApplicable (Fils, kein stilles Cappen). Sonst: bestehende Mathe.
  const canSubmit = isCredit
    ? (requestedFils > 0 && requestedFils <= maxApplicableFils)
    : (totalAmount > 0 && (overrideMode
        ? Math.abs(allocatedSum - totalAmount) <= 0.005
        : allocatedSum > 0));

  return (
    <Modal open={!!supplierId} onClose={onClose} title={`Pay Supplier${supplierName ? ' · ' + supplierName : ''}`} width={760}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ padding: '10px 12px', background: '#F2F7FA', borderRadius: 8, fontSize: 12, color: '#4B5563' }}>
          <div className="flex justify-between">
            <span>Total outstanding:</span>
            <span className="font-mono" style={{ color: '#DC2626' }}><Bhd v={totalOutstanding}/> BHD</span>
          </div>
          <div className="flex justify-between" style={{ marginTop: 4 }}>
            <span>Open items (workshop, payouts, inventory, etc.):</span>
            <span className="font-mono" style={{ color: '#0F0F10' }}>{openItems.length}</span>
          </div>
        </div>

        {openItems.length === 0 ? (
          <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0', textAlign: 'center' }}>
            Nothing open for this supplier right now.
          </p>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
              <div>
                <Input
                  required
                  label={isCredit ? 'CREDIT TO APPLY (BHD)' : 'PAYMENT AMOUNT (BHD)'}
                  type="number"
                  step="0.01"
                  value={totalAmount || ''}
                  disabled={busy}
                  onChange={e => setTotalAmount(parseFloat(e.target.value) || 0)}
                />
                {isCredit && (
                  <div className="flex items-center justify-between" style={{ marginTop: 6, fontSize: 11, color: '#6B7280' }}>
                    <span>Max applicable: <span className="font-mono">{fmt(fromFils(maxApplicableFils))}</span></span>
                    <button
                      onClick={() => !busy && setTotalAmount(fromFils(maxApplicableFils))}
                      disabled={busy || maxApplicableFils <= 0}
                      className="cursor-pointer rounded"
                      style={{
                        padding: '3px 10px', fontSize: 11, border: '1px solid #D5D9DE',
                        color: '#0F0F10', background: 'transparent',
                        opacity: (busy || maxApplicableFils <= 0) ? 0.5 : 1,
                      }}
                    >Use maximum</button>
                  </div>
                )}
              </div>
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
                <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  {(['cash', 'bank', 'benefit'] as const).map(m => {
                    const active = method === m;
                    return (
                      <button
                        key={m}
                        onClick={() => !busy && setMethod(m)}
                        disabled={busy}
                        className="cursor-pointer rounded"
                        style={{
                          padding: '8px 16px',
                          fontSize: 13,
                          border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                          color: active ? '#0F0F10' : '#6B7280',
                          background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                          opacity: busy ? 0.6 : 1,
                        }}
                      >
                        {m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Benefit'}
                      </button>
                    );
                  })}
                  {/* Slice B — Credit nur sichtbar wenn ueberhaupt Credit vorhanden ist. Ohne offene
                      supplier-verknuepfte Expense sichtbar-aber-deaktiviert (Hinweis darunter). */}
                  {creditAvailableFils > 0 && (() => {
                    const active = method === 'credit';
                    const noExpense = openExpenseFils <= 0;
                    const disabled = busy || noExpense;
                    return (
                      <button
                        key="credit"
                        onClick={() => !disabled && setMethod('credit')}
                        disabled={disabled}
                        title={noExpense ? 'No open supplier-linked expenses to settle with credit' : undefined}
                        className="cursor-pointer rounded"
                        style={{
                          padding: '8px 16px',
                          fontSize: 13,
                          border: `1px solid ${active ? '#715DE3' : '#D5D9DE'}`,
                          color: active ? '#715DE3' : (disabled ? '#9CA3AF' : '#6B7280'),
                          background: active ? 'rgba(113,93,227,0.08)' : 'transparent',
                          opacity: disabled ? 0.6 : 1,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                        }}
                      >
                        Credit ({fmt(fromFils(creditAvailableFils))} BHD available)
                      </button>
                    );
                  })()}
                </div>
                {isCredit && openExpenseFils <= 0 && (
                  <span style={{ fontSize: 11, color: '#DC2626', marginTop: 6, display: 'block' }}>
                    No open supplier-linked expenses — nothing to settle with credit.
                  </span>
                )}
              </div>
            </div>

            {!isCredit && (<>
            <div>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span className="text-overline">
                  {overrideMode ? 'MANUAL ALLOCATION' : 'FIFO ALLOCATION PREVIEW'}
                </span>
                <button
                  onClick={() => !busy && handleToggleOverride()}
                  disabled={busy}
                  className="cursor-pointer"
                  style={{
                    background: 'transparent',
                    border: '1px solid #D5D9DE',
                    color: '#0F0F10',
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 4,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  {overrideMode ? '← FIFO auto' : '✏ Override allocation'}
                </button>
              </div>
              <p style={{ fontSize: 11, color: '#6B7280', marginBottom: 10, lineHeight: 1.5 }}>
                {overrideMode
                  ? 'Edit per-row allocations. Sum must match total payment amount.'
                  : 'Oldest items are paid first (FIFO), regardless of type.'}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '0.9fr 0.9fr 1.6fr 0.85fr 0.85fr 0.8fr', gap: 10, fontSize: 12 }}>
                <span className="text-overline">DOC #</span>
                <span className="text-overline">TYPE</span>
                <span className="text-overline">DESCRIPTION</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>REMAINING</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>ALLOCATE</span>
                <span className="text-overline">SOURCE</span>
                {openItems.map(item => {
                  const k = itemKey(item);
                  const alloc = effectiveAllocation[k] || 0;
                  const km = KIND_META[item.kind];
                  const fullyPaid = alloc >= item.remaining - 0.005 && alloc > 0;
                  return (
                    <div key={k} style={{ display: 'contents' }}>
                      <span className="font-mono" style={{ fontSize: 11, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{item.number}</span>
                      <span style={{ padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>
                        <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, color: km.color, background: km.bg, whiteSpace: 'nowrap' }}>
                          {km.label}
                        </span>
                      </span>
                      <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.description}
                      </span>
                      <span className="font-mono" style={{ fontSize: 12, color: '#DC2626', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>
                        <Bhd v={item.remaining}/>
                      </span>
                      <span style={{ padding: '4px 0', borderTop: '1px solid #E5E9EE', textAlign: 'right' }}>
                        {overrideMode ? (
                          <input
                            type="number"
                            step="0.01"
                            value={manualAlloc[k] ?? ''}
                            disabled={busy}
                            onChange={ev => handleManualChange(k, parseFloat(ev.target.value) || 0, item.remaining)}
                            style={{
                              width: '100%',
                              textAlign: 'right',
                              padding: '4px 6px',
                              fontSize: 12,
                              border: '1px solid #D5D9DE',
                              borderRadius: 4,
                              background: '#FFFFFF',
                              fontFamily: 'monospace',
                            }}
                          />
                        ) : (
                          <span className="font-mono" style={{
                            fontSize: 12,
                            color: alloc > 0 ? (fullyPaid ? '#16A34A' : '#D97706') : '#9CA3AF',
                            fontWeight: alloc > 0 ? 500 : 400,
                          }}>
                            {alloc > 0 ? fmt(alloc) : '—'}
                          </span>
                        )}
                      </span>
                      <span className="font-mono" style={{ fontSize: 10, color: '#6B7280', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>
                        {item.sourceNumber || '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ padding: '10px 12px', background: '#F2F7FA', borderRadius: 8, fontSize: 12 }}>
              <div className="flex justify-between">
                <span style={{ color: '#6B7280' }}>Allocated:</span>
                <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={allocatedSum}/> BHD</span>
              </div>
              <div className="flex justify-between" style={{ marginTop: 4 }}>
                <span style={{ color: '#6B7280' }}>Payment amount:</span>
                <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={totalAmount}/> BHD</span>
              </div>
              {overrideMode && Math.abs(allocatedSum - totalAmount) > 0.005 && (
                <div className="flex justify-between" style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #E5E9EE' }}>
                  <span style={{ color: '#DC2626', fontWeight: 500 }}>Difference:</span>
                  <span className="font-mono" style={{ color: '#DC2626', fontWeight: 500 }}>
                    <Bhd v={allocatedSum - totalAmount}/> BHD
                  </span>
                </div>
              )}
            </div>
            </>)}

            {/* Slice B — Credit-Vorschau (NUR Expenses, rein informativ, gleicher Planer wie der Store). */}
            {isCredit && (
              <div>
                <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                  <span className="text-overline">CREDIT ALLOCATION PREVIEW</span>
                  <span style={{ fontSize: 11, color: '#715DE3' }}>
                    Redeeming <span className="font-mono">{fmt(fromFils(requestedFils))}</span> BHD supplier credit
                  </span>
                </div>
                <p style={{ fontSize: 11, color: '#6B7280', marginBottom: 10, lineHeight: 1.5 }}>
                  Preview only — the final allocation is recalculated from the latest data when you confirm.
                  Oldest expenses are settled first (FIFO). No cash, bank or benefit is used.
                </p>
                {creditPreview && creditPreview.preview.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr 0.7fr', gap: 10, fontSize: 12 }}>
                    <span className="text-overline">EXPENSE #</span>
                    <span className="text-overline">DATE</span>
                    <span className="text-overline" style={{ textAlign: 'right' }}>AMOUNT</span>
                    <span className="text-overline" style={{ textAlign: 'right' }}>SETTLED</span>
                    <span className="text-overline" style={{ textAlign: 'right' }}>APPLY</span>
                    <span className="text-overline" style={{ textAlign: 'right' }}>REMAINING</span>
                    <span className="text-overline">STATUS</span>
                    {creditPreview.preview.map(row => {
                      const meta = creditExpenseById.get(row.expenseId);
                      const paid = row.statusAfter === 'PAID';
                      return (
                        <div key={row.expenseId} style={{ display: 'contents' }}>
                          <span className="font-mono" style={{ fontSize: 11, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={meta?.description || ''}>{meta?.number || row.expenseId.slice(0, 8)}</span>
                          <span style={{ fontSize: 11, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{meta?.date || '—'}</span>
                          <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={fromFils(row.amountF)}/></span>
                          <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={fromFils(row.settledBeforeF)}/></span>
                          <span className="font-mono" style={{ fontSize: 12, color: '#715DE3', fontWeight: 500, textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}><Bhd v={fromFils(row.appliedF)}/></span>
                          <span className="font-mono" style={{ fontSize: 12, color: row.remainingAfterF > 0 ? '#DC2626' : '#9CA3AF', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{row.remainingAfterF > 0 ? fmt(fromFils(row.remainingAfterF)) : '—'}</span>
                          <span style={{ fontSize: 11, color: paid ? '#16A34A' : '#D97706', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{paid ? 'Paid' : 'Pending'}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p style={{ fontSize: 12, color: '#9CA3AF', padding: '8px 0' }}>
                    {requestedFils <= 0
                      ? 'Enter an amount to preview the allocation.'
                      : 'Amount exceeds the maximum applicable — adjust to preview.'}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit || busy}>
            {busy ? 'Working…' : isCredit
              ? `Apply Credit${totalAmount > 0 ? ' ' + fmt(totalAmount) + ' BHD' : ''}`
              : `Pay ${totalAmount > 0 ? fmt(totalAmount) + ' BHD' : ''}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
