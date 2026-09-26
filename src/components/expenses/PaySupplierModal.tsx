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
// CENTRAL-UI-PARITY R6D — die Zahlung ist EINE Buchung (`suppliers.pay`), der Guthaben-Modus eine
// zweite (`suppliers.apply_credit`); beide am Primary in der Schreibreihenfolge, auf PC2 ueber die
// Bruecke. Was vorher schief lag (bestaetigt):
//   • Der Rest einer Ausgabe ignorierte eingeloestes Guthaben → FIFO verteilte zu viel, die Zahlung
//     wurde still gekappt, und der Unterschied wurde nirgends Guthaben.
//   • Die Zahlschleife lief ohne Klammer — ein Fehler mittendrin liess die ersten Zahlungen stehen,
//     ein Wiederholen zahlte sie ein zweites Mal.
//   • Der Guthaben-Modus lief ueber den Alt-Sync-Server; am Primary gibt es dort keinen Endpunkt —
//     er kam NIE an.
// Die Verteilung rechnet jetzt DERSELBE Planer wie das Haus (`planSupplierPayment`); am Ende rechnet
// der Primary sie frisch nach. Die Maske schliesst NUR bei Erfolg.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { useExpenseStore } from '@/stores/expenseStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { supplierCreditsFor } from '@/stores/supplierStore';
import { planSupplierCreditExpenseAllocations } from '@/core/finance/expenseCreditAllocation';
// CENTRAL-UI-PARITY R2D — Belegnummern ueber die gemeinsame Ladefunktion.
import { useSharedRead } from '@/core/data/shared-read';
import { refNumbersFor } from '@/core/data/page-reads';
import { creditPaidFor } from '@/core/data/domain-reads';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import { WriteError } from '@/components/shared/WriteError';
import { PAYABLES_OP, planSupplierPayment, sortOpenItems, type SupplierOpenItem } from '@/core/payables/payables-house';
import { saveSupplierCredit, saveSupplierPay, viaWrites } from '@/core/payables/payables-save';

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

interface OpenItem extends SupplierOpenItem {
  /** Anzeige-Typ (Werkstatt, Einlieferer, Einkauf …). */
  display: ItemKind;
  description: string;
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

const itemKey = (item: { kind: string; id: string }): string => `${item.kind}:${item.id}`;

export function PaySupplierModal({ supplierId, supplierName, onClose }: PaySupplierModalProps) {
  const expenses = useExpenseStore(s => s.expenses);
  const purchases = usePurchaseStore(s => s.purchases);
  const w = useSharedWrites();

  const [totalAmount, setTotalAmount] = useState<number>(0);
  const [method, setMethod] = useState<PayMethod>('bank');
  const [overrideMode, setOverrideMode] = useState(false);
  // Map<itemKey, allocation> — itemKey = `${kind}:${id}`
  const [manualAlloc, setManualAlloc] = useState<Record<string, number>>({});
  // refreshTick erzwingt nach einer Buchung (auch einer abgewiesenen) frische Guthaben und Vorschau.
  const [refreshTick, setRefreshTick] = useState(0);
  const [fehler, setFehler] = useState('');
  const busy = w.busy;

  // CENTRAL-UI-PARITY R2D — die Nummern der verknuepften Vorgaenge, gebuendelt und
  // filialgebunden. Vorher stellte diese Maske je offener Zeile eine eigene Abfrage.
  const refIds = useMemo(() => {
    const mine = expenses.filter((e) => e.supplierId === supplierId && e.relatedEntityId);
    return {
      orders: mine.filter((e) => e.relatedModule === 'order').map((e) => e.relatedEntityId as string),
      repairs: mine.filter((e) => e.relatedModule === 'repair').map((e) => e.relatedEntityId as string),
      consignments: mine.filter((e) => e.relatedModule === 'consignment').map((e) => e.relatedEntityId as string),
    };
  }, [expenses, supplierId]);
  const refNumbers = useSharedRead('refs.numbers.get', refIds, (ctx) => refNumbersFor(ctx, refIds),
    { orders: {}, repairs: {}, consignments: {} }, [refIds]);

  // Credit-Einloesungen je Expense gebuendelt (eine GROUP-BY-Query, kein N+1) → settled = cash+credit.
  const guthaben = useSharedRead('expenses.credit_paid.get', {}, creditPaidFor, { byExpense: {} }, [expenses, refreshTick]);
  const creditPaidMap = useMemo(() => new Map(Object.entries(guthaben.byExpense)), [guthaben]);

  const openItems = useMemo<OpenItem[]>(() => {
    if (!supplierId) return [];
    const items: OpenItem[] = [];

    // 1. Open Expenses — R6D: Rest guthabenbewusst (cash + credit), wie im Haus.
    for (const e of expenses) {
      if (e.supplierId !== supplierId) continue;
      if (e.status === 'PAID' || e.status === 'CANCELLED') continue;
      const remainingF = toFils(e.amount || 0) - toFils(e.paidAmount || 0) - toFils(creditPaidMap.get(e.id) || 0);
      if (remainingF <= 0) continue;
      // CENTRAL-UI-PARITY R2D — die Belegnummer kommt aus der gemeinsamen Auskunft oben.
      const sourceNumber = e.relatedEntityId
        ? (e.relatedModule === 'order' ? refNumbers.orders[e.relatedEntityId]
          : e.relatedModule === 'repair' ? refNumbers.repairs[e.relatedEntityId]
          : e.relatedModule === 'consignment' ? refNumbers.consignments[e.relatedEntityId]
          : undefined)
        : undefined;
      items.push({
        kind: 'expense', id: e.id, number: e.expenseNumber,
        date: e.expenseDate || e.createdAt?.split('T')[0] || '',
        remainingF, takesOverpay: false,
        display: classifyExpense(e.relatedModule, e.category),
        description: e.description || '', remaining: fromFils(remainingF), sourceNumber,
      });
    }

    // 2. Open Purchases — Consignor-Payouts + Inventory-Einkaeufe. Rest aus den Zahlungszeilen
    // (cash + credit), nicht aus `remaining_amount` (das eine Altzahlung falsch ueberschrieben haben kann).
    for (const p of purchases) {
      if (p.supplierId !== supplierId) continue;
      if (p.status === 'PAID' || p.status === 'CANCELLED') continue;
      const creditF = (p.payments || []).filter((x) => x.method === 'credit').reduce((s, x) => s + toFils(x.amount), 0);
      const remainingF = toFils(p.totalAmount || 0) - toFils(p.paidAmount || 0) - creditF;
      if (remainingF <= 0) continue;
      const notes = p.notes || '';
      const m = notes.match(/CON-\d+-\d+/);
      items.push({
        kind: 'purchase', id: p.id, number: p.purchaseNumber, date: p.purchaseDate || '',
        remainingF, takesOverpay: creditF === 0,
        display: classifyPurchase(notes), description: notes, remaining: fromFils(remainingF),
        sourceNumber: m ? m[0] : undefined,
      });
    }

    // FIFO: aelteste zuerst, dann Belegnummer — DIESELBE Reihenfolge wie im Haus.
    return sortOpenItems(items);
  }, [supplierId, expenses, purchases, refNumbers, creditPaidMap]);

  const totalOutstanding = useMemo(() => fromFils(openItems.reduce((s, e) => s + e.remainingF, 0)), [openItems]);

  useEffect(() => {
    if (supplierId) {
      setTotalAmount(0);
      setMethod('bank');
      setOverrideMode(false);
      setManualAlloc({});
      setFehler('');
    }
  }, [supplierId]);

  // Die FIFO-Vorschau rechnet DERSELBE Planer wie der Primary.
  const fifoPlan = useMemo(() => {
    const amountF = toFils(totalAmount);
    if (amountF <= 0) return { allocations: [], excessF: 0, overflowPurchaseId: null as string | null };
    try { return planSupplierPayment(openItems, amountF, 'fifo'); }
    catch { return { allocations: [], excessF: 0, overflowPurchaseId: null as string | null }; }
  }, [totalAmount, openItems]);
  const fifoAllocation = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const a of fifoPlan.allocations) out[itemKey(a)] = fromFils(a.amountF);
    return out;
  }, [fifoPlan]);

  const effectiveAllocation = overrideMode ? manualAlloc : fifoAllocation;
  const allocatedSum = useMemo(
    () => fromFils(Object.values(effectiveAllocation).reduce((s, v) => s + toFils(v || 0), 0)),
    [effectiveAllocation],
  );

  // ─────────────────────────────────────────────────────────────
  // Slice B — Credit-Methode: Snapshot, Maximum (Fils), reine Vorschau.
  // ─────────────────────────────────────────────────────────────
  const isCredit = method === 'credit';

  // R6D — die Guthaben DIESES Lieferanten in DIESER Filiale, aus der gemeinsamen Auskunft (PC2 auch).
  const lieferGuthaben = useSharedRead(
    'suppliers.credits.get', { supplierId: supplierId ?? '', v: refreshTick },
    (ctx) => supplierCreditsFor(ctx, supplierId ?? ''),
    { credits: [], availableAmount: 0 }, [supplierId, refreshTick, expenses, purchases],
  );

  // Offene supplier-verknuepfte Expenses (settled-aware, > 0 offen) + offene Credits — NUR Expenses,
  // Purchases fliessen bewusst NICHT ein. Reines Lesen; speist Max + Vorschau.
  const creditSnapshot = useMemo(() => {
    const emptyExp: Array<{ id: string; createdAt: string; amountF: number; settledF: number; number: string; date: string; description: string }> = [];
    if (!supplierId) return { expenses: emptyExp, credits: [] as Array<{ id: string; createdAt: string; totalF: number; usedF: number }> };
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
    const credits = lieferGuthaben.credits.map(c => ({
      id: c.id, createdAt: c.createdAt || '', totalF: toFils(c.amount), usedF: toFils(c.usedAmount),
    }));
    return { expenses: exps, credits };
  }, [supplierId, expenses, creditPaidMap, lieferGuthaben]);

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
  // method (nicht maxApplicableFils) → KEIN stilles Kappen, wenn sich das Maximum spaeter aendert.
  useEffect(() => {
    if (method !== 'credit' || maxApplicableFils <= 0) return;
    const reqF = toFils(totalAmount);
    if (reqF <= 0 || reqF > maxApplicableFils) setTotalAmount(fromFils(maxApplicableFils));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method]);

  // Reine, NICHT autoritative Vorschau auf dem aktuellen Snapshot (gleicher Planer wie das Haus).
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

  async function handleSubmit() {
    if (busy || !supplierId || totalAmount <= 0) return;
    setFehler('');

    // ── Guthaben-Modus: EINE Buchung, der atomare Schreiber des Hauses (FIFO dort, frisch). ──
    if (method === 'credit') {
      const r = await saveSupplierCredit(viaWrites(w, PAYABLES_OP.SUPPLIERS_APPLY_CREDIT), supplierId, fromFils(requestedFils));
      setRefreshTick(t => t + 1);
      if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
      onClose();
      return;
    }

    // ── cash/bank/benefit ──
    if (overrideMode && toFils(allocatedSum) !== toFils(totalAmount)) {
      setFehler(`Allocation sum (${fmt(allocatedSum)}) does not match total payment (${fmt(totalAmount)}).`);
      return;
    }
    // Ueberschuss (nur FIFO): liegt ein Einkauf vor, der ihn tragen kann, wird er darauf gebucht
    // (→ PURCHASE_OVERPAY-Guthaben); sonst entsteht ein Standalone-Guthaben. Letzteres bestaetigt
    // der Mensch hier — der Primary entscheidet dieselbe Frage mit demselben Planer.
    if (!overrideMode && fifoPlan.excessF > 0 && !fifoPlan.overflowPurchaseId) {
      if (!(await window.confirm(
        `You're paying ${fmt(totalAmount)} but only ${fmt(allocatedSum)} can be allocated ` +
        `(${fmt(fromFils(fifoPlan.excessF))} excess). The excess will be credited to ${supplierName || 'this supplier'} ` +
        `as redeemable supplier credit. Continue?`
      ))) return;
    }
    const allocations = overrideMode
      ? openItems
          .map((i) => ({ kind: i.kind, id: i.id, amount: manualAlloc[itemKey(i)] || 0 }))
          .filter((a) => toFils(a.amount) > 0)
      : undefined;
    const r = await saveSupplierPay(viaWrites(w, PAYABLES_OP.SUPPLIERS_PAY), {
      supplierId, amount: totalAmount, method, mode: overrideMode ? 'manual' : 'fifo', allocations,
    });
    setRefreshTick(t => t + 1);
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    onClose();
  }

  // Credit-Modus: Betrag > 0 und <= maxApplicable (Fils, kein stilles Cappen). Sonst: bestehende Mathe.
  const canSubmit = isCredit
    ? (requestedFils > 0 && requestedFils <= maxApplicableFils)
    : (totalAmount > 0 && (overrideMode
        ? toFils(allocatedSum) === toFils(totalAmount)
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
                  data-supplier-pay-amount
                />
                {isCredit && (
                  <div className="flex items-center justify-between" style={{ marginTop: 6, fontSize: 11, color: '#6B7280' }}>
                    <span>Max applicable: <span className="font-mono">{fmt(fromFils(maxApplicableFils))}</span></span>
                    <button
                      onClick={() => !busy && setTotalAmount(fromFils(maxApplicableFils))}
                      disabled={busy || maxApplicableFils <= 0}
                      data-supplier-credit-max
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
                        data-supplier-pay-method={m}
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
                        data-supplier-pay-method="credit"
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
                  data-supplier-pay-mode={overrideMode ? 'manual' : 'fifo'}
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
                  const km = KIND_META[item.display];
                  const fullyPaid = toFils(alloc) >= item.remainingF && alloc > 0;
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
                            data-supplier-pay-alloc={k}
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
              {overrideMode && toFils(allocatedSum) !== toFils(totalAmount) && (
                <div className="flex justify-between" style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #E5E9EE' }}>
                  <span style={{ color: '#DC2626', fontWeight: 500 }}>Difference:</span>
                  <span className="font-mono" style={{ color: '#DC2626', fontWeight: 500 }}>
                    <Bhd v={allocatedSum - totalAmount}/> BHD
                  </span>
                </div>
              )}
            </div>
            </>)}

            {/* Slice B — Credit-Vorschau (NUR Expenses, rein informativ, gleicher Planer wie das Haus). */}
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

        <WriteError text={fehler} />
        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={!canSubmit || busy}
            {...(isCredit ? { 'data-supplier-credit-save': '' } : { 'data-supplier-pay-save': '' })}>
            {busy ? 'Working…' : isCredit
              ? `Apply Credit${totalAmount > 0 ? ' ' + fmt(totalAmount) + ' BHD' : ''}`
              : `Pay ${totalAmount > 0 ? fmt(totalAmount) + ' BHD' : ''}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
