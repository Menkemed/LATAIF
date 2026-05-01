// Plan §Purchases + §Purchase Returns — Detail page
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, CreditCard, XCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { useProductStore } from '@/stores/productStore';
import { HistoryDrawer } from '@/components/shared/HistoryPanel';
import type { PurchaseStatus } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_COLORS: Record<PurchaseStatus, string> = {
  DRAFT: '#9CA3AF', UNPAID: '#DC2626', PARTIALLY_PAID: '#D97706',
  PAID: '#16A34A', CANCELLED: '#6B7280',
};

export function PurchaseDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { purchases, loadPurchases, addPayment, cancelPurchase, createReturn, confirmReturn, returns, loadReturns } = usePurchaseStore();
  const { suppliers, loadSuppliers, getLedger } = useSupplierStore();
  const { products, loadProducts } = useProductStore();

  const [showPayment, setShowPayment] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'bank' | 'credit'>('bank');
  const [payRef, setPayRef] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Return state
  const [showReturn, setShowReturn] = useState(false);
  const [returnLines, setReturnLines] = useState<Record<string, { include: boolean; quantity: number; unitPrice: number }>>({});
  const [returnMethod, setReturnMethod] = useState<'cash' | 'bank' | 'credit'>('bank');
  const [returnNotes, setReturnNotes] = useState('');

  useEffect(() => { loadPurchases(); loadSuppliers(); loadReturns(); loadProducts(); }, [loadPurchases, loadSuppliers, loadReturns, loadProducts]);

  const purchase = useMemo(() => purchases.find(p => p.id === id), [purchases, id]);
  const supplier = useMemo(() => purchase ? suppliers.find(s => s.id === purchase.supplierId) : undefined, [purchase, suppliers]);
  const supplierLedger = useMemo(() => purchase ? getLedger(purchase.supplierId) : { creditBalance: 0, totalPurchases: 0, totalPaid: 0, outstandingBalance: 0 }, [purchase, getLedger, returns, purchases]);
  const linkedReturns = useMemo(() => returns.filter(r => r.purchaseId === id), [returns, id]);

  if (!purchase) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Purchase not found</p>
      </div>
    );
  }

  const canPay = purchase.status !== 'CANCELLED' && purchase.status !== 'PAID' && purchase.remainingAmount > 0;
  const canCancel = purchase.status !== 'CANCELLED' && purchase.status !== 'PAID';
  const canReturn = purchase.status !== 'CANCELLED' && linkedReturns.filter(r => r.status !== 'CANCELLED').length === 0;

  function handleAddPayment() {
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0 || !id) return;
    // Plan §Purchase Returns §8: Credit darf max creditBalance verwenden.
    if (payMethod === 'credit' && amt > supplierLedger.creditBalance + 0.001) return;
    addPayment(id, amt, payMethod, payRef || undefined);
    setShowPayment(false);
    setPayAmount('');
    setPayRef('');
  }

  function openReturnModal() {
    const init: Record<string, { include: boolean; quantity: number; unitPrice: number }> = {};
    purchase!.lines.forEach(l => {
      init[l.id] = { include: false, quantity: l.quantity, unitPrice: l.unitPrice };
    });
    setReturnLines(init);
    setShowReturn(true);
  }

  const returnTotal = useMemo(() => {
    return (purchase?.lines || []).reduce((s, l) => {
      const r = returnLines[l.id];
      if (r?.include) return s + r.quantity * r.unitPrice;
      return s;
    }, 0);
  }, [returnLines, purchase]);

  function handleCreateReturn() {
    if (!id || !purchase) return;
    const included = purchase.lines
      .filter(l => returnLines[l.id]?.include)
      .map(l => ({
        purchaseLineId: l.id,
        productId: l.productId,
        quantity: returnLines[l.id].quantity,
        unitPrice: returnLines[l.id].unitPrice,
      }));
    if (included.length === 0) return;
    const ret = createReturn({
      purchaseId: id,
      refundMethod: returnMethod,
      notes: returnNotes || undefined,
      lines: included,
    });
    confirmReturn(ret.id);
    setShowReturn(false);
    setReturnNotes('');
  }

  const getProductName = (pid?: string) => {
    if (!pid) return '—';
    const p = products.find(pr => pr.id === pid);
    return p ? `${p.brand} ${p.name}` : pid.slice(0, 8);
  };

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1200 }}>

        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/purchases')}
            className="flex items-center gap-2 cursor-pointer"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}
          >
            <ArrowLeft size={16} /> Purchases
          </button>
          <div className="flex gap-2">
            {canPay && <Button variant="primary" onClick={() => setShowPayment(true)}><CreditCard size={14} /> Add Payment</Button>}
            {canReturn && <Button variant="secondary" onClick={openReturnModal}><RotateCcw size={14} /> Return to Supplier</Button>}
            <Button variant="ghost" onClick={() => setShowHistory(true)}>History</Button>
            {canCancel && <Button variant="danger" onClick={() => setConfirmCancel(true)}><XCircle size={14} /> Cancel</Button>}
          </div>
        </div>

        {/* Hero */}
        <div className="animate-fade-in" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 32, marginBottom: 32 }}>
          <div>
            <span className="text-overline">PURCHASE</span>
            <h1 className="text-display-m" style={{ color: '#0F0F10', marginTop: 4 }}>{purchase.purchaseNumber}</h1>
            <p style={{ fontSize: 13, color: '#6B7280', marginTop: 6 }}>{purchase.purchaseDate}</p>
            <div style={{ marginTop: 14 }}>
              <span style={{
                fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
                color: STATUS_COLORS[purchase.status],
                textTransform: 'uppercase',
              }}>{purchase.status}</span>
            </div>
          </div>
          <Card>
            <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 8 }}>
              <span style={{ color: '#6B7280' }}>Total</span>
              <span className="font-mono" style={{ color: '#0F0F10' }}>{fmt(purchase.totalAmount)} BHD</span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 13, marginBottom: 8 }}>
              <span style={{ color: '#6B7280' }}>Paid</span>
              <span className="font-mono" style={{ color: '#16A34A' }}>{fmt(purchase.paidAmount)} BHD</span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 15, paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>
              <span style={{ color: '#0F0F10' }}>Outstanding (Payable)</span>
              <span className="font-mono" style={{ color: purchase.remainingAmount > 0 ? '#DC2626' : '#6B7280', fontWeight: 500 }}>
                {fmt(purchase.remainingAmount)} BHD
              </span>
            </div>
          </Card>
        </div>

        {/* Supplier */}
        <Card>
          <span className="text-overline">SUPPLIER</span>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 15, color: '#0F0F10' }}>{supplier?.name || '—'}</div>
            {supplier?.phone && <div style={{ fontSize: 12, color: '#6B7280' }}>{supplier.phone}</div>}
          </div>
        </Card>

        {/* Lines */}
        <div style={{ marginTop: 20 }}><Card>
          <span className="text-overline">LINE ITEMS</span>
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 0.6fr 1fr 1fr', gap: 12, padding: '8px 0', borderBottom: '1px solid #E5E9EE' }}>
              {['PRODUCT', 'DESCRIPTION', 'QTY', 'UNIT PRICE', 'LINE TOTAL'].map(h => (
                <span key={h} className="text-overline" style={{ fontSize: 10 }}>{h}</span>
              ))}
            </div>
            {purchase.lines.map(l => (
              <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 0.6fr 1fr 1fr', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(229,225,214,0.5)', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#0F0F10' }}>{getProductName(l.productId)}</span>
                <span style={{ fontSize: 12, color: '#6B7280' }}>{l.description || '—'}</span>
                <span className="font-mono" style={{ fontSize: 12, color: '#4B5563' }}>{l.quantity}</span>
                <span className="font-mono" style={{ fontSize: 13, color: '#4B5563' }}>{fmt(l.unitPrice)}</span>
                <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(l.lineTotal)}</span>
              </div>
            ))}
          </div>
        </Card></div>

        {/* Payments */}
        <div style={{ marginTop: 20 }}><Card>
          <span className="text-overline">PAYMENTS</span>
          {purchase.payments.length === 0 ? (
            <p style={{ fontSize: 13, color: '#6B7280', textAlign: 'center', padding: '24px 0' }}>No payments recorded.</p>
          ) : (
            <div style={{ marginTop: 10 }}>
              {purchase.payments.map(p => (
                <div key={p.id} className="flex justify-between" style={{ padding: '8px 0', borderBottom: '1px solid rgba(229,225,214,0.5)' }}>
                  <div>
                    <span style={{ fontSize: 13, color: '#0F0F10' }}>{p.paidAt}</span>
                    <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 10 }}>{p.method.toUpperCase()}</span>
                    {p.reference && <span style={{ fontSize: 11, color: '#9CA3AF', marginLeft: 10 }}>Ref: {p.reference}</span>}
                  </div>
                  <span className="font-mono" style={{ fontSize: 13, color: '#16A34A' }}>{fmt(p.amount)} BHD</span>
                </div>
              ))}
            </div>
          )}
        </Card></div>

        {/* Linked Returns */}
        {linkedReturns.length > 0 && (
          <div style={{ marginTop: 20 }}><Card>
            <span className="text-overline">RETURNS</span>
            <div style={{ marginTop: 10 }}>
              {linkedReturns.map(r => (
                <div key={r.id} className="flex justify-between" style={{ padding: '10px 0', borderBottom: '1px solid rgba(229,225,214,0.5)' }}>
                  <div>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{r.returnNumber}</span>
                    <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 10 }}>{r.status}</span>
                    <span style={{ fontSize: 11, color: '#9CA3AF', marginLeft: 10 }}>{r.returnDate}</span>
                  </div>
                  <div className="flex gap-4">
                    <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>−{fmt(r.totalAmount)}</span>
                    {r.refundAmount > 0 && (
                      <span className="font-mono" style={{ fontSize: 12, color: '#16A34A' }}>refund {fmt(r.refundAmount)} {r.refundMethod}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card></div>
        )}

        {purchase.notes && (
          <div style={{ marginTop: 20 }}><Card>
            <span className="text-overline">NOTES</span>
            <p style={{ fontSize: 13, color: '#4B5563', marginTop: 8, lineHeight: 1.6 }}>{purchase.notes}</p>
          </Card></div>
        )}
      </div>

      {/* Payment Modal */}
      <Modal open={showPayment} onClose={() => setShowPayment(false)} title="Add Payment" width={420}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input required label={`AMOUNT (max ${fmt(purchase.remainingAmount)} BHD outstanding)`} type="number" step="0.01"
            value={payAmount} onChange={e => setPayAmount(e.target.value)} autoFocus />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['cash', 'bank', 'credit'] as const).map(m => {
                const active = payMethod === m;
                const disabled = m === 'credit' && supplierLedger.creditBalance <= 0;
                return (
                  <button key={m} onClick={() => !disabled && setPayMethod(m)} className="cursor-pointer rounded"
                    disabled={disabled}
                    style={{ padding: '8px 16px', fontSize: 13,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: disabled ? '#D5D9DE' : (active ? '#0F0F10' : '#6B7280'),
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      opacity: disabled ? 0.5 : 1,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                    }}>{m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : `Credit (${fmt(supplierLedger.creditBalance)})`}</button>
                );
              })}
            </div>
            {payMethod === 'credit' && (
              <p style={{ fontSize: 11, color: '#AA956E', marginTop: 6 }}>
                Available supplier credit: <span className="font-mono">{fmt(supplierLedger.creditBalance)} BHD</span>
              </p>
            )}
          </div>
          <Input label="REFERENCE (optional)" placeholder="Transaction ID / check no" value={payRef} onChange={e => setPayRef(e.target.value)} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowPayment(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleAddPayment} disabled={!payAmount || parseFloat(payAmount) <= 0}>Record Payment</Button>
          </div>
        </div>
      </Modal>

      {/* Return Modal */}
      <Modal open={showReturn} onClose={() => setShowReturn(false)} title="Return to Supplier (PRET)" width={680}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 12, color: '#6B7280' }}>
            Plan §Purchase Returns: select items to return. Payable is reduced first; any surplus becomes a refund.
          </p>
          <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '0.3fr 2fr 0.8fr 1fr 1fr', gap: 10, padding: '10px 12px', background: '#F2F7FA', borderBottom: '1px solid #E5E9EE' }}>
              {['', 'PRODUCT', 'QTY', 'UNIT PRICE', 'LINE TOTAL'].map(h => (
                <span key={h} className="text-overline" style={{ fontSize: 10 }}>{h}</span>
              ))}
            </div>
            {purchase.lines.map(l => {
              const r = returnLines[l.id] || { include: false, quantity: l.quantity, unitPrice: l.unitPrice };
              return (
                <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '0.3fr 2fr 0.8fr 1fr 1fr', gap: 10, padding: '10px 12px', borderBottom: '1px solid #E5E9EE', alignItems: 'center' }}>
                  <input type="checkbox" checked={r.include} onChange={e => setReturnLines({ ...returnLines, [l.id]: { ...r, include: e.target.checked } })} />
                  <span style={{ fontSize: 12, color: '#0F0F10' }}>{getProductName(l.productId)}</span>
                  <input type="number" value={r.quantity} min={0} max={l.quantity} onChange={e => setReturnLines({ ...returnLines, [l.id]: { ...r, quantity: parseFloat(e.target.value) || 0 } })}
                    className="font-mono" style={{ padding: '4px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, color: '#0F0F10' }} />
                  <input type="number" step="0.01" value={r.unitPrice} onChange={e => setReturnLines({ ...returnLines, [l.id]: { ...r, unitPrice: parseFloat(e.target.value) || 0 } })}
                    className="font-mono" style={{ padding: '4px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 4, color: '#0F0F10' }} />
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{fmt(r.quantity * r.unitPrice)}</span>
                </div>
              );
            })}
          </div>

          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>REFUND METHOD (if paid)</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['cash', 'bank', 'credit'] as const).map(m => {
                const active = returnMethod === m;
                return (
                  <button key={m} onClick={() => setReturnMethod(m)} className="cursor-pointer rounded"
                    style={{ padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Supplier Credit'}</button>
                );
              })}
            </div>
          </div>

          <Input label="NOTES" placeholder="e.g. damaged goods" value={returnNotes} onChange={e => setReturnNotes(e.target.value)} />

          <div className="flex justify-between" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <span style={{ fontSize: 14, color: '#6B7280' }}>Return Total</span>
            <span className="font-mono" style={{ fontSize: 16, color: '#DC2626' }}>{fmt(returnTotal)} BHD</span>
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowReturn(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreateReturn} disabled={returnTotal <= 0}>Confirm Return</Button>
          </div>
        </div>
      </Modal>

      {/* Cancel Confirm */}
      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel Purchase" width={400}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Cancel purchase <strong style={{ color: '#0F0F10' }}>{purchase.purchaseNumber}</strong>?
          Payable will be cleared. This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => { if (id) cancelPurchase(id); setConfirmCancel(false); }}>Confirm Cancel</Button>
        </div>
      </Modal>

      <HistoryDrawer
        open={showHistory}
        onClose={() => setShowHistory(false)}
        entityType="purchases"
        entityId={purchase.id}
        title={`History · ${purchase.purchaseNumber}`}
      />
    </div>
  );
}
