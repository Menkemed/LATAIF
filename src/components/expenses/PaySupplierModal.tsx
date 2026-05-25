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
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { useExpenseStore } from '@/stores/expenseStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { query } from '@/core/db/helpers';

interface PaySupplierModalProps {
  supplierId: string | null;
  supplierName?: string;
  onClose: () => void;
}

type PayMethod = 'cash' | 'bank' | 'benefit';

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
  const purchases = usePurchaseStore(s => s.purchases);
  const addPurchasePayment = usePurchaseStore(s => s.addPayment);

  const [totalAmount, setTotalAmount] = useState<number>(0);
  const [method, setMethod] = useState<PayMethod>('bank');
  const [overrideMode, setOverrideMode] = useState(false);
  // Map<itemKey, allocation> — itemKey = `${sourceTable}:${id}`
  const [manualAlloc, setManualAlloc] = useState<Record<string, number>>({});

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
    if (!supplierId || totalAmount <= 0) return;
    if (overrideMode && Math.abs(allocatedSum - totalAmount) > 0.005) {
      alert(`Allocation sum (${fmt(allocatedSum)}) does not match total payment (${fmt(totalAmount)}).`);
      return;
    }
    if (allocatedSum < totalAmount - 0.005) {
      const overpay = totalAmount - allocatedSum;
      if (!window.confirm(
        `You're paying ${fmt(totalAmount)} but only ${fmt(allocatedSum)} can be allocated ` +
        `(${fmt(overpay)} excess). The excess will be IGNORED (supplier credit balance not yet implemented). Continue?`
      )) {
        return;
      }
    }

    try {
      for (const item of openItems) {
        const alloc = effectiveAllocation[itemKey(item)] || 0;
        if (alloc <= 0.005) continue;
        if (item.sourceTable === 'expense') {
          recordExpensePayment(item.id, alloc, method);
        } else {
          addPurchasePayment(item.id, alloc, method);
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
