// v0.7.7 — Bulk-Pay an einen Supplier mit FIFO-Allokation und Manual-Override.
//
// Use Case: Supplier hat viele kleine offene Workshop-Expenses (z.B. 10
// Reparaturzeilen). User will eine Summe zahlen (z.B. 50 BHD von 200 offen)
// statt 10x Pay zu klicken.
//
// Default: FIFO — aelteste Rechnung zuerst voll, dann naechste, bis Geld
// aufgebraucht ist. User kann auf "Override" klicken und pro Zeile selber
// verteilen. Hinter den Kulissen werden N `recordExpensePayment()`-Calls
// ausgefuehrt (jede betroffene Expense), damit das Ledger sauber bleibt und
// jede Expense ihren eigenen Audit-Eintrag bekommt.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { useExpenseStore } from '@/stores/expenseStore';
import { query } from '@/core/db/helpers';

interface PaySupplierModalProps {
  supplierId: string | null;
  supplierName?: string;
  onClose: () => void;
}

type PayMethod = 'cash' | 'bank' | 'benefit';

interface OpenExpense {
  id: string;
  expenseNumber: string;
  description: string;
  amount: number;
  paidAmount: number;
  remaining: number;
  expenseDate: string;
  sourceNumber?: string;
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

export function PaySupplierModal({ supplierId, supplierName, onClose }: PaySupplierModalProps) {
  const expenses = useExpenseStore(s => s.expenses);
  const recordExpensePayment = useExpenseStore(s => s.recordExpensePayment);

  const [totalAmount, setTotalAmount] = useState<number>(0);
  const [method, setMethod] = useState<PayMethod>('bank');
  const [overrideMode, setOverrideMode] = useState(false);
  // Map<expenseId, allocation> — nur befuellt im Override-Mode.
  const [manualAlloc, setManualAlloc] = useState<Record<string, number>>({});

  // Offene Expenses dieses Suppliers — workshop/service-Bereich. Sortiert
  // nach Datum aufsteigend (FIFO). Inventory-Purchases laufen separat ueber
  // PurchaseDetail und sind absichtlich NICHT hier — Pay-Supplier-Bulk-Flow
  // ist fuer die "viele kleine Reparaturzeilen"-UX.
  const openExpenses = useMemo<OpenExpense[]>(() => {
    if (!supplierId) return [];
    // Aus dem Store-State filtern statt DB-Query damit Reactivity klappt:
    // nach recordExpensePayment hat sich `expenses` veraendert und das useMemo
    // re-runned, die Tabelle re-rendert.
    const supplierExpenses = expenses
      .filter(e => e.supplierId === supplierId
        && e.status !== 'PAID'
        && e.status !== 'CANCELLED'
        && (e.relatedModule === 'repair' || e.relatedModule === 'order'))
      .map(e => ({
        id: e.id,
        expenseNumber: e.expenseNumber,
        description: e.description,
        amount: e.amount,
        paidAmount: e.paidAmount || 0,
        remaining: Math.max(0, e.amount - (e.paidAmount || 0)),
        expenseDate: e.expenseDate,
        sourceModule: e.relatedModule,
        sourceEntityId: e.relatedEntityId,
      }))
      .filter(e => e.remaining > 0.005)
      .sort((a, b) => a.expenseDate.localeCompare(b.expenseDate));

    // Beleg-Nummer-Lookup (ORD-… / REP-…) in einem Roundtrip — nur fuer Anzeige.
    const out: OpenExpense[] = [];
    for (const e of supplierExpenses) {
      let sourceNumber: string | undefined;
      try {
        if (e.sourceModule === 'order' && e.sourceEntityId) {
          const r = query(`SELECT order_number FROM orders WHERE id = ?`, [e.sourceEntityId]);
          if (r.length > 0) sourceNumber = r[0].order_number as string;
        } else if (e.sourceModule === 'repair' && e.sourceEntityId) {
          const r = query(`SELECT repair_number FROM repairs WHERE id = ?`, [e.sourceEntityId]);
          if (r.length > 0) sourceNumber = r[0].repair_number as string;
        }
      } catch { /* */ }
      out.push({
        id: e.id,
        expenseNumber: e.expenseNumber,
        description: e.description || '',
        amount: e.amount,
        paidAmount: e.paidAmount,
        remaining: e.remaining,
        expenseDate: e.expenseDate,
        sourceNumber,
      });
    }
    return out;
  }, [supplierId, expenses]);

  const totalOutstanding = useMemo(() => openExpenses.reduce((s, e) => s + e.remaining, 0), [openExpenses]);

  // Reset bei jedem Oeffnen.
  useEffect(() => {
    if (supplierId) {
      setTotalAmount(0);
      setMethod('bank');
      setOverrideMode(false);
      setManualAlloc({});
    }
  }, [supplierId]);

  // FIFO-Allokation berechnen — live preview, aelteste zuerst voll, Rest in
  // die naechste. Returns Map<expenseId, allocatedAmount>.
  const fifoAllocation = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    let pool = totalAmount;
    for (const e of openExpenses) {
      if (pool <= 0.005) break;
      const take = Math.min(pool, e.remaining);
      if (take > 0.005) {
        out[e.id] = take;
        pool -= take;
      }
    }
    return out;
  }, [totalAmount, openExpenses]);

  // Effektive Allokation = manual wenn Override an, sonst FIFO.
  const effectiveAllocation = overrideMode ? manualAlloc : fifoAllocation;
  const allocatedSum = useMemo(
    () => Object.values(effectiveAllocation).reduce((s, v) => s + (v || 0), 0),
    [effectiveAllocation],
  );

  // Override-Mode-Toggle: beim Aktivieren mit FIFO-Defaults vorbelegen, damit
  // der User einen sinnvollen Startpunkt zum Tunen hat.
  function handleToggleOverride() {
    if (!overrideMode) {
      setManualAlloc({ ...fifoAllocation });
    }
    setOverrideMode(!overrideMode);
  }

  function handleManualChange(expenseId: string, value: number) {
    const exp = openExpenses.find(e => e.id === expenseId);
    if (!exp) return;
    const capped = Math.max(0, Math.min(value, exp.remaining));
    setManualAlloc(prev => ({ ...prev, [expenseId]: capped }));
  }

  function handleSubmit() {
    if (!supplierId || totalAmount <= 0) return;
    // Validierung im Override-Mode: Summe muss zur Gesamtsumme passen.
    if (overrideMode && Math.abs(allocatedSum - totalAmount) > 0.005) {
      alert(`Allocation sum (${fmt(allocatedSum)}) does not match total payment (${fmt(totalAmount)}).`);
      return;
    }
    // Im FIFO-Mode kann allocatedSum kleiner als totalAmount sein wenn
    // totalAmount > totalOutstanding — dann ueberzahlt der User. Erstmal
    // hard cappen mit Warnung (Credit-Balance kommt in einem spaeteren Slice).
    if (allocatedSum < totalAmount - 0.005) {
      const overpay = totalAmount - allocatedSum;
      if (!window.confirm(
        `You're paying ${fmt(totalAmount)} but only ${fmt(allocatedSum)} can be allocated to open invoices ` +
        `(${fmt(overpay)} excess). The excess will be IGNORED for now (supplier credit balance not yet implemented). ` +
        `Continue?`
      )) {
        return;
      }
    }

    // Sequenzielle recordExpensePayment-Calls — jede Expense kriegt ihre
    // eigene Ledger-Buchung + ihren eigenen Cross-Store-Reload. Bei
    // groesseren Zahlen (>5 Expenses) waere ein Batch schoener, aber das
    // wuerde die SSOT-Action umgehen und wir wollen die Audit-Spur sauber.
    try {
      for (const [expenseId, alloc] of Object.entries(effectiveAllocation)) {
        if (alloc > 0.005) {
          recordExpensePayment(expenseId, alloc, method);
        }
      }
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  const canSubmit = totalAmount > 0 && (overrideMode
    ? Math.abs(allocatedSum - totalAmount) <= 0.005
    : allocatedSum > 0);

  return (
    <Modal open={!!supplierId} onClose={onClose} title={`Pay Supplier${supplierName ? ' · ' + supplierName : ''}`} width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Summary */}
        <div style={{ padding: '10px 12px', background: '#F2F7FA', borderRadius: 8, fontSize: 12, color: '#4B5563' }}>
          <div className="flex justify-between">
            <span>Total outstanding (workshop / service):</span>
            <span className="font-mono" style={{ color: '#DC2626' }}><Bhd v={totalOutstanding}/> BHD</span>
          </div>
          <div className="flex justify-between" style={{ marginTop: 4 }}>
            <span>Open invoices:</span>
            <span className="font-mono" style={{ color: '#0F0F10' }}>{openExpenses.length}</span>
          </div>
        </div>

        {openExpenses.length === 0 ? (
          <p style={{ fontSize: 13, color: '#6B7280', padding: '20px 0', textAlign: 'center' }}>
            No open workshop or service invoices for this supplier.
          </p>
        ) : (
          <>
            {/* Amount + Method */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>
              <Input
                required
                label="PAYMENT AMOUNT (BHD)"
                type="number"
                step="0.01"
                value={totalAmount || ''}
                onChange={e => setTotalAmount(parseFloat(e.target.value) || 0)}
              />
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
                <div className="flex gap-2" style={{ marginTop: 6 }}>
                  {(['cash', 'bank', 'benefit'] as const).map(m => {
                    const active = method === m;
                    return (
                      <button
                        key={m}
                        onClick={() => setMethod(m)}
                        className="cursor-pointer rounded"
                        style={{
                          padding: '8px 16px',
                          fontSize: 13,
                          border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                          color: active ? '#0F0F10' : '#6B7280',
                          background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                        }}
                      >
                        {m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Benefit'}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Allocation Preview / Override Editor */}
            <div>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span className="text-overline">
                  {overrideMode ? 'MANUAL ALLOCATION' : 'FIFO ALLOCATION PREVIEW'}
                </span>
                <button
                  onClick={handleToggleOverride}
                  className="cursor-pointer"
                  style={{
                    background: 'transparent',
                    border: '1px solid #D5D9DE',
                    color: '#0F0F10',
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 4,
                  }}
                >
                  {overrideMode ? '← FIFO auto' : '✏ Override allocation'}
                </button>
              </div>
              <p style={{ fontSize: 11, color: '#6B7280', marginBottom: 10, lineHeight: 1.5 }}>
                {overrideMode
                  ? 'Edit per-row allocations. Sum must match total payment amount.'
                  : 'Oldest invoices are paid first, full before moving to the next.'}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.8fr 0.9fr 0.9fr 1fr', gap: 10, fontSize: 12 }}>
                <span className="text-overline">EXPENSE #</span>
                <span className="text-overline">DESCRIPTION</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>REMAINING</span>
                <span className="text-overline" style={{ textAlign: 'right' }}>ALLOCATE</span>
                <span className="text-overline">SOURCE</span>
                {openExpenses.map(e => {
                  const alloc = effectiveAllocation[e.id] || 0;
                  const fullyPaid = alloc >= e.remaining - 0.005 && alloc > 0;
                  return (
                    <div key={e.id} style={{ display: 'contents' }}>
                      <span className="font-mono" style={{ fontSize: 11, color: '#0F0F10', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>{e.expenseNumber}</span>
                      <span style={{ fontSize: 12, color: '#4B5563', padding: '8px 0', borderTop: '1px solid #E5E9EE', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.description}
                      </span>
                      <span className="font-mono" style={{ fontSize: 12, color: '#DC2626', textAlign: 'right', padding: '8px 0', borderTop: '1px solid #E5E9EE' }}>
                        <Bhd v={e.remaining}/>
                      </span>
                      <span style={{ padding: '4px 0', borderTop: '1px solid #E5E9EE', textAlign: 'right' }}>
                        {overrideMode ? (
                          <input
                            type="number"
                            step="0.01"
                            value={manualAlloc[e.id] ?? ''}
                            onChange={ev => handleManualChange(e.id, parseFloat(ev.target.value) || 0)}
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
                        {e.sourceNumber || '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Allocation summary */}
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
          </>
        )}

        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            Pay {totalAmount > 0 ? fmt(totalAmount) + ' BHD' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
